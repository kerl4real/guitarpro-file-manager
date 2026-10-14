use rusqlite::{functions::FunctionFlags, params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

pub type Result<T> = std::result::Result<T, String>;

pub const COLUMNS: [&str; 10] = [
    "title",
    "filename",
    "directory",
    "artist",
    "album",
    "format",
    "tempo",
    "tracks",
    "status",
    "updated_at",
];

fn validate_hidden_columns(columns: &[String]) -> Result<()> {
    if columns
        .iter()
        .any(|column| !COLUMNS.contains(&column.as_str()))
    {
        return Err("Unsupported library column".into());
    }
    if COLUMNS
        .iter()
        .all(|column| columns.iter().any(|hidden| hidden == column))
    {
        return Err("Keep at least one column visible".into());
    }
    Ok(())
}

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
    pub tuning: String,
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
    pub updated_at: Option<String>,
}

#[derive(Serialize)]
pub struct Page {
    pub rows: Vec<Score>,
    pub total: usize,
    pub page: usize,
    pub page_size: usize,
    pub tunings: Vec<String>,
}

#[derive(Default, Clone, Serialize)]
pub struct Settings {
    pub parser: String,
    pub folder: String,
}

fn path_sort_value(path: &str, directory: bool) -> &str {
    let windows = path.as_bytes().get(1) == Some(&b':') || path.starts_with("\\\\");
    let separator = |c| c == '/' || (windows && c == '\\');
    let Some(index) = path.rfind(separator) else {
        return if directory { "" } else { path };
    };
    if !directory {
        return &path[index + 1..];
    }
    let parent = &path[..index];
    parent
        .rsplit(separator)
        .find(|part| !part.is_empty())
        .unwrap_or("/")
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

fn updated_at(record: &Value) -> Option<&str> {
    record
        .pointer("/file_metadata/updated_at")
        .and_then(Value::as_str)
}

// MIDI pitches, ordered by string number, are the identity; labels are display only.
// Require contiguous, unique string numbers, but impose no instrument string count.
fn tuning_key(track: &Value) -> Option<String> {
    if track.get("kind").and_then(Value::as_str) == Some("percussion") {
        return None;
    }
    let strings = track.get("tuning")?.as_array()?;
    if strings.is_empty() {
        return None;
    }
    let mut pitches = strings
        .iter()
        .map(|string| {
            let number = string.get("number")?.as_u64()?;
            let midi = string.get("midi")?.as_u64()?;
            (number > 0 && midi <= 127).then_some((number, midi))
        })
        .collect::<Option<Vec<_>>>()?;
    pitches.sort_by_key(|(number, _)| *number);
    if pitches
        .iter()
        .enumerate()
        .any(|(i, (number, _))| *number != i as u64 + 1)
    {
        return None;
    }
    Some(
        pitches
            .iter()
            .map(|(_, midi)| midi.to_string())
            .collect::<Vec<_>>()
            .join(","),
    )
}

fn index_tracks(db: &Connection, path: &str, record: &Value) -> Result<()> {
    db.execute("DELETE FROM score_tracks WHERE score_path=?", [path])
        .map_err(|e| e.to_string())?;
    if record.get("status").and_then(Value::as_str) != Some("ok") {
        return Ok(());
    }
    if let Some(tracks) = record.pointer("/metadata/tracks").and_then(Value::as_array) {
        for (ordinal, track) in tracks.iter().enumerate() {
            db.execute(
                "INSERT INTO score_tracks (score_path, ordinal, tuning_key) VALUES (?, ?, ?)",
                params![path, ordinal as i64, tuning_key(track)],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
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
        if !(0..=4).contains(&version) {
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
            CREATE TABLE IF NOT EXISTS score_tracks (
                score_path TEXT NOT NULL REFERENCES scores(path) ON DELETE CASCADE,
                ordinal INTEGER NOT NULL, tuning_key TEXT,
                PRIMARY KEY (score_path, ordinal));
            CREATE INDEX IF NOT EXISTS score_tracks_tuning ON score_tracks(tuning_key, score_path);",
        )
        .map_err(|e| e.to_string())?;
        if version < 4 {
            let has_updated_at = tx
                .prepare("PRAGMA table_info(scores)")
                .map_err(|e| e.to_string())?
                .query_map([], |row| row.get::<_, String>(1))
                .map_err(|e| e.to_string())?
                .collect::<std::result::Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?
                .iter()
                .any(|column| column == "updated_at");
            if !has_updated_at {
                tx.execute_batch("ALTER TABLE scores ADD COLUMN updated_at TEXT;")
                    .map_err(|e| e.to_string())?;
            }
            let mut statement = tx
                .prepare("SELECT path, record FROM scores")
                .map_err(|e| e.to_string())?;
            let mut rows = statement.query([]).map_err(|e| e.to_string())?;
            while let Some(row) = rows.next().map_err(|e| e.to_string())? {
                let path: String = row.get(0).map_err(|e| e.to_string())?;
                let raw: String = row.get(1).map_err(|e| e.to_string())?;
                let record: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
                if version < 3 {
                    index_tracks(&tx, &path, &record)?;
                }
                tx.execute("UPDATE scores SET updated_at=CASE WHEN julianday(?1) IS NOT NULL THEN ?1 END WHERE path=?2",
                    params![updated_at(&record), path]).map_err(|e| e.to_string())?;
            }
        }
        tx.execute_batch("CREATE INDEX IF NOT EXISTS scores_updated_at ON scores(julianday(updated_at)); PRAGMA user_version=4;")
            .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(library)
    }

    pub fn connect(&self) -> Result<Connection> {
        let db = Connection::open(&self.database).map_err(|e| e.to_string())?;
        db.execute_batch("PRAGMA foreign_keys=ON;")
            .map_err(|e| e.to_string())?;
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

    pub fn hidden_columns(&self) -> Result<Vec<String>> {
        let raw: Option<String> = self
            .connect()?
            .query_row(
                "SELECT value FROM settings WHERE key='hidden_columns'",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        let columns = match raw {
            Some(raw) => serde_json::from_str(&raw).map_err(|e| e.to_string())?,
            None => Vec::new(),
        };
        validate_hidden_columns(&columns)?;
        Ok(columns)
    }

    pub fn save_hidden_columns(&self, columns: &[String]) -> Result<()> {
        validate_hidden_columns(columns)?;
        // Store known columns in table order, removing duplicates.
        let columns: Vec<_> = COLUMNS
            .iter()
            .filter(|column| columns.iter().any(|hidden| hidden == **column))
            .collect();
        let value = serde_json::to_string(&columns).map_err(|e| e.to_string())?;
        self.connect()?.execute(
            "INSERT INTO settings VALUES ('hidden_columns', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![value],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn favorite_tunings(&self) -> Result<Vec<String>> {
        let raw: Option<String> = self
            .connect()?
            .query_row(
                "SELECT value FROM settings WHERE key='favorite_tunings'",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        match raw {
            Some(raw) => serde_json::from_str(&raw).map_err(|e| e.to_string()),
            None => Ok(Vec::new()),
        }
    }

    pub fn save_favorite_tunings(&self, tunings: &[String]) -> Result<()> {
        for key in tunings {
            if key.is_empty()
                || key.split(',').any(|pitch| {
                    pitch
                        .parse::<u8>()
                        .ok()
                        .filter(|midi| *midi <= 127)
                        .is_none_or(|midi| midi.to_string() != pitch)
                })
            {
                return Err("Invalid tuning key".into());
            }
        }
        let mut tunings = tunings.to_vec();
        tunings.sort();
        tunings.dedup();
        self.connect()?.execute(
            "INSERT INTO settings VALUES ('favorite_tunings', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![serde_json::to_string(&tunings).map_err(|e| e.to_string())?],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn save_parser(&self, parser: &str) -> Result<()> {
        if parser.trim().is_empty() {
            return Err("Choose a parser executable".into());
        }
        self.connect()?
            .execute(
                "INSERT INTO settings VALUES ('parser', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                params![parser],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
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
                    "INSERT INTO scores (path, title, artist, album, format, tempo, tracks, status, record, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN julianday(?10) IS NOT NULL THEN ?10 END)
                    ON CONFLICT(path) DO UPDATE SET title=excluded.title, artist=excluded.artist,
                    album=excluded.album, format=excluded.format, tempo=excluded.tempo,
                    tracks=excluded.tracks, status=excluded.status, record=excluded.record, updated_at=excluded.updated_at",
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
                        record.to_string(),
                        updated_at(&record)
                    ],
                )
                .map_err(|e| e.to_string())?;
                index_tracks(&tx, &path, &record)?;
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
            "filename" => "score_filename(path)",
            "directory" => "score_directory(path)",
            "updated_at" => "julianday(updated_at)",
            "path" | "title" | "artist" | "album" | "format" | "tempo" | "tracks" | "status" => {
                &query.sort
            }
            _ => return Err("Unsupported sort column".into()),
        };
        let nulls = if query.sort == "updated_at" {
            "NULLS LAST"
        } else {
            ""
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
            AND (?2 = '' OR format = ?2) AND (?3 = '' OR status = ?3)
            AND (?4 = '' OR EXISTS (SELECT 1 FROM score_tracks t
                WHERE t.score_path=scores.path AND t.tuning_key=?4))";
        let mut db = self.connect()?;
        for (name, directory) in [("score_filename", false), ("score_directory", true)] {
            db.create_scalar_function(
                name,
                1,
                FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC,
                move |context| {
                    let path = context.get::<String>(0)?;
                    Ok(path_sort_value(&path, directory).to_owned())
                },
            )
            .map_err(|e| e.to_string())?;
        }
        let tx = db.transaction().map_err(|e| e.to_string())?;
        let total: usize = tx
            .query_row(
                &format!("SELECT COUNT(*) FROM scores {filter}"),
                params![pattern, query.format, query.status, query.tuning],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        let page_size = 200;
        let page = query.page.min(total.saturating_sub(1) / page_size);
        let mut statement = tx.prepare(&format!("SELECT path, title, artist, album, format, tempo,
            tracks, status, record, updated_at FROM scores {filter} ORDER BY {column} COLLATE NOCASE {direction} {nulls},
            path ASC LIMIT {page_size} OFFSET {}", page * page_size)).map_err(|e| e.to_string())?;
        let rows = statement
            .query_map(
                params![pattern, query.format, query.status, query.tuning],
                |row| {
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
                        updated_at: row.get(9)?,
                    })
                },
            )
            .map_err(|e| e.to_string())?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        let tunings = tx.prepare("SELECT DISTINCT tuning_key FROM score_tracks WHERE tuning_key IS NOT NULL ORDER BY tuning_key")
            .map_err(|e| e.to_string())?
            .query_map([], |row| row.get::<_, String>(0)).map_err(|e| e.to_string())?
            .collect::<std::result::Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
        Ok(Page {
            rows,
            total,
            page,
            page_size,
            tunings,
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
