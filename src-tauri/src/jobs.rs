use crate::storage::{Library, Result, Settings};
use serde::Serialize;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use uuid::Uuid;

#[derive(Clone, Serialize)]
pub struct Job {
    pub busy: bool,
    pub cancelling: bool,
    pub message: String,
    pub revision: u64,
    pub processed: usize,
}

struct Active {
    job: Job,
    child: Option<Child>,
}

#[derive(Clone)]
pub struct Jobs(Arc<Mutex<Active>>);

impl Default for Jobs {
    fn default() -> Self {
        Self(Arc::new(Mutex::new(Active {
            job: Job {
                busy: false,
                cancelling: false,
                message: "Ready. Scan a folder or import JSONL.".into(),
                revision: 0,
                processed: 0,
            },
            child: None,
        })))
    }
}

impl Jobs {
    pub fn snapshot(&self) -> Result<Job> {
        self.0
            .lock()
            .map(|state| state.job.clone())
            .map_err(|e| e.to_string())
    }

    pub fn reserve(&self) -> Result<()> {
        let mut state = self.0.lock().map_err(|e| e.to_string())?;
        if state.job.busy {
            return Err("An import is already running".into());
        }
        state.job.busy = true;
        state.job.cancelling = false;
        state.job.processed = 0;
        state.job.message = "Working…".into();
        Ok(())
    }

    pub fn cancelled(&self) -> bool {
        self.0
            .lock()
            .map(|state| state.job.cancelling)
            .unwrap_or(true)
    }

    pub fn cancel(&self) -> Result<()> {
        let mut state = self.0.lock().map_err(|e| e.to_string())?;
        if !state.job.busy {
            return Ok(());
        }
        state.job.cancelling = true;
        state.job.message = "Cancelling…".into();
        if let Some(child) = state.child.as_mut() {
            // A process may have finished between the last UI poll and cancellation.
            if child.try_wait().map_err(|e| e.to_string())?.is_none() {
                child.kill().map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    }

    pub fn finish(&self, result: Result<(usize, PathBuf)>) {
        if let Ok(mut state) = self.0.lock() {
            if let Some(mut child) = state.child.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
            state.job.message = match result {
                Ok((count, artifact)) => {
                    format!("Imported {count} records · {}", artifact.display())
                }
                Err(error) => format!("Import stopped: {error}"),
            };
            state.job.busy = false;
            state.job.cancelling = false;
            state.job.revision += 1;
        }
    }

    pub fn notify_close(&self) {
        if let Ok(mut state) = self.0.lock() {
            state.job.message = "An import is running. Cancel it or wait before closing.".into();
        }
    }

    pub fn scan(&self, library: &Library, settings: Settings) -> Result<(usize, PathBuf)> {
        let folder = Path::new(&settings.folder)
            .canonicalize()
            .map_err(|e| format!("Select an existing score folder: {e}"))?;
        if !folder.is_dir() {
            return Err("Select an existing score folder".into());
        }
        if settings.parser.trim().is_empty() {
            return Err("Select the score_tool executable".into());
        }
        let scans = library.directory.join("scans");
        fs::create_dir_all(&scans).map_err(|e| e.to_string())?;
        let name = Uuid::new_v4().to_string();
        let artifact = scans.join(format!("{name}.jsonl"));
        let diagnostics = scans.join(format!("{name}.stderr.txt"));
        let output = File::create(&artifact).map_err(|e| e.to_string())?;
        let errors = File::create(&diagnostics).map_err(|e| e.to_string())?;
        library.save_settings(&settings)?;
        let mut command = Command::new(&settings.parser);
        command
            .args(["scan", "--input"])
            .arg(folder)
            .args(["--recursive", "--jobs", "4", "--format", "jsonl"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(errors);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        // Hold this lock across spawning so cancellation cannot miss the new child.
        let stdout = {
            let mut state = self.0.lock().map_err(|e| e.to_string())?;
            if state.job.cancelling {
                return Err("Scan cancelled; library was not changed".into());
            }
            let mut child = command.spawn().map_err(|e| {
                format!("Cannot start parser: {e}. Choose a built score_tool executable.")
            })?;
            let stdout = child.stdout.take().ok_or("Parser stdout unavailable")?;
            state.child = Some(child);
            stdout
        };
        let stream_result = (|| -> Result<()> {
            let mut output = output;
            let mut reader = BufReader::new(stdout);
            let mut line = Vec::new();
            let mut count = 0;
            loop {
                line.clear();
                let size = reader
                    .read_until(b'\n', &mut line)
                    .map_err(|e| e.to_string())?;
                if size == 0 {
                    break;
                }
                output.write_all(&line).map_err(|e| e.to_string())?;
                count += 1;
                if let Ok(mut state) = self.0.lock() {
                    state.job.processed = count;
                    if !state.job.cancelling {
                        state.job.message = format!("Extracted {count} records…");
                    }
                }
            }
            output.flush().map_err(|e| e.to_string())
        })();
        // Keep the child registered until it exits, including after stdout closes.
        // This lets cancellation still terminate a parser that is finishing up.
        let status = loop {
            let mut state = self.0.lock().map_err(|e| e.to_string())?;
            let child = state.child.as_mut().ok_or("Parser process unavailable")?;
            if stream_result.is_err() {
                let _ = child.kill();
            }
            if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
                state.child.take();
                break status;
            }
            drop(state);
            std::thread::sleep(std::time::Duration::from_millis(25));
        };
        stream_result?;
        if self.cancelled() {
            return Err(format!(
                "Scan cancelled; library was not changed. Output: {}",
                artifact.display()
            ));
        }
        if !status.success() {
            // Read only the end of the diagnostics, even for extremely verbose parsers.
            use std::io::{Seek, SeekFrom};
            let mut file = File::open(&diagnostics).map_err(|e| e.to_string())?;
            let length = file.metadata().map_err(|e| e.to_string())?.len();
            file.seek(SeekFrom::Start(length.saturating_sub(4000)))
                .map_err(|e| e.to_string())?;
            let mut tail = Vec::new();
            file.read_to_end(&mut tail).map_err(|e| e.to_string())?;
            return Err(format!(
                "Parser exited with {status}: {}\nSaved output: {}",
                String::from_utf8_lossy(&tail),
                artifact.display()
            ));
        }
        let count = library
            .import_jsonl_cancelable(&artifact, || self.cancelled())
            .map_err(|error| format!("{error}. Saved output: {}", artifact.display()))?;
        Ok((count, artifact))
    }

    pub fn import(&self, library: &Library, source: &Path) -> Result<(usize, PathBuf)> {
        let scans = library.directory.join("scans");
        fs::create_dir_all(&scans).map_err(|e| e.to_string())?;
        let artifact = scans.join(format!("import-{}.jsonl", Uuid::new_v4()));
        // A cancellable streaming copy retains the exact source bytes for diagnostics.
        let mut input = File::open(source).map_err(|e| e.to_string())?;
        let mut output = File::create(&artifact).map_err(|e| e.to_string())?;
        let mut buffer = [0; 64 * 1024];
        loop {
            if self.cancelled() {
                return Err("Import cancelled; library was not changed".into());
            }
            let size = input.read(&mut buffer).map_err(|e| e.to_string())?;
            if size == 0 {
                break;
            }
            output
                .write_all(&buffer[..size])
                .map_err(|e| e.to_string())?;
        }
        output.flush().map_err(|e| e.to_string())?;
        drop(output);
        let count = library
            .import_jsonl_cancelable(&artifact, || self.cancelled())
            .map_err(|error| format!("{error}. Saved output: {}", artifact.display()))?;
        Ok((count, artifact))
    }
}
