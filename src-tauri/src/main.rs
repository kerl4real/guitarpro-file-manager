#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod jobs;
mod storage;
#[cfg(test)]
mod tests;

use jobs::{Job, Jobs};
use serde::Serialize;
use std::path::PathBuf;
use storage::{Library, Page, Query, Result, Settings};
use tauri::{Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

struct Backend {
    library: Library,
    jobs: Jobs,
    default_parser: String,
}

#[derive(Serialize)]
struct AppState {
    #[serde(flatten)]
    job: Job,
    parser: String,
    folder: String,
    database: String,
    hidden_columns: Vec<String>,
    favorite_tunings: Vec<String>,
}

fn default_parser() -> String {
    if let Ok(path) = std::env::var("GFM_PARSER") {
        return path;
    }
    let root = std::env::var_os("GFM_PARSER_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../guitarpro-file-parser")
        });
    let name = if cfg!(windows) {
        "score_tool.exe"
    } else {
        "score_tool"
    };
    // A manually packaged parser beside the GUI takes precedence over development builds.
    if let Ok(executable) = std::env::current_exe() {
        if let Some(directory) = executable.parent() {
            let parser = directory.join(name);
            if parser.is_file() {
                return parser.to_string_lossy().into_owned();
            }
        }
    }
    for profile in ["release", "debug"] {
        let path = root.join("target").join(profile).join(name);
        if path.is_file() {
            return path
                .canonicalize()
                .unwrap_or(path)
                .to_string_lossy()
                .into_owned();
        }
    }
    "score_tool".into()
}

#[tauri::command]
async fn get_state(backend: State<'_, Backend>) -> Result<AppState> {
    let library = backend.library.clone();
    let jobs = backend.jobs.clone();
    let parser = backend.default_parser.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let settings = library.settings(&parser)?;
        Ok(AppState {
            job: jobs.snapshot()?,
            hidden_columns: library.hidden_columns()?,
            favorite_tunings: library.favorite_tunings()?,
            parser: settings.parser,
            folder: settings.folder,
            database: library.database.to_string_lossy().into_owned(),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn query_library(backend: State<'_, Backend>, query: Query) -> Result<Page> {
    let library = backend.library.clone();
    tauri::async_runtime::spawn_blocking(move || library.query(query))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn save_parser(backend: State<'_, Backend>, parser: String) -> Result<()> {
    let library = backend.library.clone();
    tauri::async_runtime::spawn_blocking(move || library.save_parser(&parser))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn save_hidden_columns(backend: State<'_, Backend>, columns: Vec<String>) -> Result<()> {
    let library = backend.library.clone();
    tauri::async_runtime::spawn_blocking(move || library.save_hidden_columns(&columns))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn save_favorite_tunings(backend: State<'_, Backend>, tunings: Vec<String>) -> Result<()> {
    let library = backend.library.clone();
    tauri::async_runtime::spawn_blocking(move || library.save_favorite_tunings(&tunings))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn start_scan(backend: State<'_, Backend>, parser: String, folder: String) -> Result<()> {
    let jobs = backend.jobs.clone();
    let library = backend.library.clone();
    jobs.reserve()?;
    tauri::async_runtime::spawn_blocking(move || {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            jobs.scan(&library, Settings { parser, folder })
        }))
        .unwrap_or_else(|_| Err("Scan worker failed unexpectedly".into()));
        jobs.finish(result);
    });
    Ok(())
}

#[tauri::command]
fn cancel_job(backend: State<'_, Backend>) -> Result<()> {
    backend.jobs.cancel()
}

#[tauri::command]
async fn pick_path(app: tauri::AppHandle, kind: String) -> Result<Option<String>> {
    tauri::async_runtime::spawn_blocking(move || {
        let dialog = app.dialog().file();
        let path = match kind.as_str() {
            "folder" => dialog
                .set_title("Choose score folder")
                .blocking_pick_folder(),
            "parser" => dialog
                .set_title("Choose score_tool executable")
                .blocking_pick_file(),
            "jsonl" => dialog
                .set_title("Import parser JSONL")
                .add_filter("JSON Lines", &["jsonl"])
                .blocking_pick_file(),
            _ => return Err("Unsupported picker type".into()),
        };
        path.map(|path| {
            path.into_path()
                .map(|path| path.to_string_lossy().into_owned())
                .map_err(|e| e.to_string())
        })
        .transpose()
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn start_import(backend: State<'_, Backend>, path: String) -> Result<()> {
    let jobs = backend.jobs.clone();
    let library = backend.library.clone();
    jobs.reserve()?;
    tauri::async_runtime::spawn_blocking(move || {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            jobs.import(&library, &PathBuf::from(path))
        }))
        .unwrap_or_else(|_| Err("Import worker failed unexpectedly".into()));
        jobs.finish(result);
    });
    Ok(())
}

#[tauri::command]
async fn open_score(
    app: tauri::AppHandle,
    backend: State<'_, Backend>,
    path: String,
) -> Result<()> {
    let library = backend.library.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let path = library.score_to_open(&path)?;
        app.opener()
            .open_path(path.to_string_lossy(), None::<&str>)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

fn main() {
    let result = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let directory = std::env::var_os("GFM_DATA_DIR")
                .map(PathBuf::from)
                .or_else(|| dirs::data_local_dir().map(|base| base.join("guitarpro-file-manager")))
                .ok_or("Cannot determine the library data directory")?;
            let library = Library::new(directory).map_err(std::io::Error::other)?;
            app.manage(Backend {
                library,
                jobs: Jobs::default(),
                default_parser: default_parser(),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_state,
            query_library,
            save_parser,
            save_hidden_columns,
            save_favorite_tunings,
            start_scan,
            cancel_job,
            pick_path,
            start_import,
            open_score
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if let Some(backend) = window.try_state::<Backend>() {
                    if backend.jobs.snapshot().map(|job| job.busy).unwrap_or(false) {
                        api.prevent_close();
                        backend.jobs.notify_close();
                    }
                }
            }
        })
        .run(tauri::generate_context!());
    if let Err(error) = result {
        eprintln!("Could not start guitarpro-file-manager: {error}");
    }
}
