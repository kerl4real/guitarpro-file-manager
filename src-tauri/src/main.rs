#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::Manager;

struct Backend(Mutex<Child>);

fn main() {
    let application = tauri::Builder::default()
        .setup(|app| {
            let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../web_preview.py");
            let python = std::env::var("GFM_PYTHON").unwrap_or_else(|_| "python".into());
            let mut command = Command::new(python);
            command
                .arg(script)
                .arg("--no-browser")
                .stdout(Stdio::piped());
            if let Ok(directory) = std::env::var("GFM_DATA_DIR") {
                command.arg("--data-dir").arg(directory);
            }
            #[cfg(target_os = "windows")]
            {
                use std::os::windows::process::CommandExt;
                command.creation_flags(0x08000000);
            }
            let mut child = command.spawn()?;
            let result = (|| -> Result<_, Box<dyn std::error::Error>> {
                let stdout = child.stdout.take().ok_or("Backend stdout unavailable")?;
                let mut url = String::new();
                BufReader::new(stdout).read_line(&mut url)?;
                if !url.starts_with("http://127.0.0.1:") {
                    return Err("Local backend did not start; check Python installation".into());
                }
                tauri::WebviewWindowBuilder::new(
                    app,
                    "library",
                    tauri::WebviewUrl::External(url.trim().parse()?),
                )
                .title("guitarpro-file-manager · Tauri prototype")
                .inner_size(1320.0, 850.0)
                .build()?;
                Ok(())
            })();
            if let Err(error) = result {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
            app.manage(Backend(Mutex::new(child)));
            Ok(())
        })
        .build(tauri::generate_context!());
    match application {
        Ok(app) => app.run(|handle, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(backend) = handle.try_state::<Backend>() {
                    if let Ok(mut child) = backend.0.lock() {
                        let _ = child.kill();
                        let _ = child.wait();
                    }
                }
            }
        }),
        Err(error) => eprintln!("Could not start guitarpro-file-manager: {error}"),
    }
}
