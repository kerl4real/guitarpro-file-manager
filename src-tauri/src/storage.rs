use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

pub type Result<T> = std::result::Result<T, String>;

#[derive(Clone)]
pub struct Library {
    pub directory: PathBuf,
    pub database: PathBuf,
}

#[derive(Default, Deserialize)]
#[serde(default)]
pub struct Query {
    pub search: String,
    pub format: String,
    pub status: String,
    pub sort: String,
    pub descending: bool,
    pub page: usize,
}

#[derive(Serialize)]
pub struct Score {
    pub path: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub format: String,
    pub tempo: Option<i64>,
    pub tracks: Option<i64>,
    pub status: String,
    pub record: String,
}

#[derive(Serialize)]
pub struct Page {
    pub rows: Vec<Score>,
    pub total: usize,
    pub page: usize,
    pub page_size: usize,
}

#[derive(Default, Clone, Serialize)]
pub struct Settings {
    pub parser: String,
    pub folder: String,
}

pub fn normalized_path(path: &str) -> Result<String> {
    let input = Path::new(path);
    if !input.is_absolute() {
        return Err("Scan record must have an absolute local path".into());
    }
    let mut normalized = PathBuf::new();
    for part in input.components() {
        match part {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            other => normalized.push(other.as_os_str()),
        }
    }
    let text = normalized.to_string_lossy().into_owned();
    // Preserve verbatim Windows prefixes, matching the Python prototype's keys.
    Ok(if cfg!(windows) {
        text.replace('/', "\\").to_lowercase()
    } else {
        text
    })
}

fn text(metadata: &Value, key: &str) -> Result<String> {
    match metadata.get(key) {
        None => Ok(String::new()),
        Some(Value::String(value)) => Ok(value.clone()),
        _ => Err(format!("Metadata {key} must be a string")),
    }
}

fn number(metadata: &Value, key: &str) -> Result<Option<i64>> {
    match metadata.get(key) {
        None => Ok(None),
        Some(value) => value
            .as_i64()
            .filter(|value| *value >= 0)
            .map(Some)
            .ok_or_else(|| format!("Metadata {key} must be a nonnegative integer")),
    }
}

impl Library {
    pub fn new(directory: PathBuf) -> Result<Self> {
        fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
        let library = Self {
            database: directory.join("library.sqlite3"),
            directory,
        };
        let mut db = library.connect()?;
        let version: i64 = db
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .map_err(|e| e.to_string())?;
        if !(0..=2).contains(&version) {
            return Err(format!("Unsupported database schema: {version}"));
        }
        let tx = db.transaction().map_err(|e| e.to_string())?;
        tx.execute_batch(
            "CREATE TABLE IF NOT EXISTS scores (
            path TEXT PRIMARY KEY, title TEXT, artist TEXT, album TEXT,
            format TEXT, tempo INTEGER, tracks INTEGER, status TEXT NOT NULL, record TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS scores_artist ON scores(artist);
            CREATE INDEX IF NOT EXISTS scores_format ON scores(format);
            CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            PRAGMA user_version = 2;",
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(library)
    }

    pub fn connect(&self) -> Result<Connection> {
        let db = Connection::open(&self.database).map_err(|e| e.to_string())?;
        db.busy_timeout(Duration::from_secs(30))
            .map_err(|e| e.to_string())?;
        Ok(db)
    }

    pub fn settings(&self, default_parser: &str) -> Result<Settings> {
        let db = self.connect()?;
        let mut settings = Settings {
            parser: default_parser.into(),
            folder: String::new(),
        };
        let mut statement = db
            .prepare("SELECT key, value FROM settings")
            .map_err(|e| e.to_string())?;
        let values = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| e.to_string())?;
        for value in values {
            let (key, value) = value.map_err(|e| e.to_string())?;
            match key.as_str() {
                "parser" => settings.parser = value,
                "folder" => settings.folder = value,
                _ => {}
            }
        }
        Ok(settings)
    }

    pub fn save_settings(&self, settings: &Settings) -> Result<()> {
        let mut db = self.connect()?;
        let tx = db.transaction().map_err(|e| e.to_string())?;
        for (key, value) in [("parser", &settings.parser), ("folder", &settings.folder)] {
            tx.execute("INSERT INTO settings VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                params![key, value]).map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())
    }

    #[cfg(test)]
    pub fn import_jsonl(&self, source: &Path) -> Result<usize> {
        self.import_jsonl_cancelable(source, || false)
    }

    pub fn import_jsonl_cancelable(
        &self,
        source: &Path,
        cancelled: impl Fn() -> bool,
    ) -> Result<usize> {
        let input = fs::File::open(source).map_err(|e| e.to_string())?;
        let mut db = self.connect()?;
        let tx = db.transaction().map_err(|e| e.to_string())?;
        let mut count = 0;
        for (index, line) in BufReader::new(input).lines().enumerate() {
            if cancelled() {
                return Err("Import cancelled; library was not changed".into());
            }
            let line = line.map_err(|e| format!("Line {}: {e}", index + 1))?;
            let line = if index == 0 {
                line.trim_start_matches('\u{feff}')
            } else {
                &line
            };
            if line.trim().is_empty() {
                continue;
            }
            let result = (|| -> Result<()> {
                let record: Value = serde_json::from_str(line).map_err(|e| e.to_string())?;
                if record.get("schema_version").and_then(Value::as_u64) != Some(1) {
                    return Err("Expected parser schema_version 1".into());
                }
                let raw_path = record
                    .get("path")
                    .and_then(Value::as_str)
                    .ok_or("Scan record is missing its path")?;
                let path = normalized_path(raw_path)?;
                let status = record.get("status").and_then(Value::as_str).unwrap_or("");
                let metadata = match status {
                    "ok" => record
                        .get("metadata")
                        .filter(|v| v.is_object())
                        .ok_or("Successful scan record is missing metadata")?,
                    "error" => {
                        if record.get("error").and_then(Value::as_str).is_none() {
                            return Err("Failed scan record is missing its error".into());
                        }
                        &Value::Null
                    }
                    _ => return Err("Invalid scan status".into()),
                };
                let title = text(metadata, "title")?;
                let filename = Path::new(raw_path)
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy();
                let format = text(metadata, "format")?;
                let extension = Path::new(raw_path)
                    .extension()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_uppercase();
                tx.execute(
                    "INSERT INTO scores VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(path) DO UPDATE SET title=excluded.title, artist=excluded.artist,
                    album=excluded.album, format=excluded.format, tempo=excluded.tempo,
                    tracks=excluded.tracks, status=excluded.status, record=excluded.record",
                    params![
                        path,
                        if title.is_empty() {
                            filename.as_ref()
                        } else {
                            &title
                        },
                        text(metadata, "artist")?,
                        text(metadata, "album")?,
                        if format.is_empty() {
                            &extension
                        } else {
                            &format
                        },
                        number(metadata, "initial_tempo")?,
                        number(metadata, "track_count")?,
                        status,
                        record.to_string()
                    ],
                )
                .map_err(|e| e.to_string())?;
                Ok(())
            })();
            result.map_err(|error| format!("Line {}: {error}", index + 1))?;
            count += 1;
        }
        if cancelled() {
            return Err("Import cancelled; library was not changed".into());
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(count)
    }

    pub fn query(&self, query: Query) -> Result<Page> {
        let column = match query.sort.as_str() {
            "" => "title",
            "path" | "title" | "artist" | "album" | "format" | "tempo" | "tracks" | "status" => {
                &query.sort
            }
            _ => return Err("Unsupported sort column".into()),
        };
        let direction = if query.descending { "DESC" } else { "ASC" };
        let pattern = format!(
            "%{}%",
            query
                .search
                .replace('\\', "\\\\")
                .replace('%', "\\%")
                .replace('_', "\\_")
        );
        let filter = r"WHERE (title LIKE ?1 ESCAPE '\' OR artist LIKE ?1 ESCAPE '\'
            OR album LIKE ?1 ESCAPE '\' OR path LIKE ?1 ESCAPE '\' OR record LIKE ?1 ESCAPE '\')
            AND (?2 = '' OR format = ?2) AND (?3 = '' OR status = ?3)";
        let mut db = self.connect()?;
        let tx = db.transaction().map_err(|e| e.to_string())?;
        let total: usize = tx
            .query_row(
                &format!("SELECT COUNT(*) FROM scores {filter}"),
                params![pattern, query.format, query.status],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        let page_size = 200;
        let page = query.page.min(total.saturating_sub(1) / page_size);
        let mut statement = tx.prepare(&format!("SELECT path, title, artist, album, format, tempo,
            tracks, status, record FROM scores {filter} ORDER BY {column} COLLATE NOCASE {direction},
            path ASC LIMIT {page_size} OFFSET {}", page * page_size)).map_err(|e| e.to_string())?;
        let rows = statement
            .query_map(params![pattern, query.format, query.status], |row| {
                Ok(Score {
                    path: row.get(0)?,
                    title: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                    artist: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                    album: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                    format: row.get::<_, Option<String>>(4)?.unwrap_or_default(),
                    tempo: row.get(5)?,
                    tracks: row.get(6)?,
                    status: row.get(7)?,
                    record: row.get(8)?,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(Page {
            rows,
            total,
            page,
            page_size,
        })
    }

    pub fn score_to_open(&self, path: &str) -> Result<PathBuf> {
        let key = normalized_path(path)?;
        let db = self.connect()?;
        let exists: bool = db
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM scores WHERE path=?)",
                [&key],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        if !exists {
            return Err("Score is not in this library".into());
        }
        let path = Path::new(path)
            .canonicalize()
            .map_err(|e| format!("Cannot open score: {e}"))?;
        let extension = path
            .extension()
            .unwrap_or_default()
            .to_string_lossy()
            .to_lowercase();
        if !path.is_file()
            || !["gp3", "gp4", "gp5", "gpx", "gp", "mscz"].contains(&extension.as_str())
        {
            return Err("Select an existing supported score file".into());
        }
        Ok(path)
    }
}
