use crate::jobs::Jobs;
use crate::storage::{normalized_path, Library, Query, Settings};
use serde_json::{json, Value};
use std::fs;
use std::path::Path;
use tempfile::TempDir;

fn library() -> (TempDir, Library) {
    let dir = TempDir::new().expect("temporary directory");
    let library = Library::new(dir.path().join("data")).expect("library");
    (dir, library)
}

fn record(path: &Path, tempo: i64) -> Value {
    json!({"schema_version": 1, "path": path.to_string_lossy(), "status": "ok",
        "metadata": {"title": "100% song", "artist": "Björk", "format": "GP5",
            "initial_tempo": tempo, "track_count": 3}})
}

fn write(dir: &Path, records: &[Value]) -> std::path::PathBuf {
    let path = dir.join("input.jsonl");
    fs::write(
        &path,
        records
            .iter()
            .map(Value::to_string)
            .collect::<Vec<_>>()
            .join("\n"),
    )
    .expect("write");
    path
}

#[test]
fn persistence_upserts_literal_filters_and_numeric_sorting() {
    let (dir, library) = library();
    let first = dir.path().join("Björk 100%.gp5");
    let second = dir.path().join("other.gp5");
    let source = write(dir.path(), &[record(&first, 120), record(&second, 80)]);
    assert_eq!(library.import_jsonl(&source).unwrap(), 2);
    assert_eq!(library.import_jsonl(&source).unwrap(), 2);
    let reopened = Library::new(library.directory.clone()).unwrap();
    let page = reopened
        .query(Query {
            sort: "tempo".into(),
            ..Query::default()
        })
        .unwrap();
    assert_eq!(page.total, 2);
    assert_eq!(
        page.rows.iter().map(|row| row.tempo).collect::<Vec<_>>(),
        [Some(80), Some(120)]
    );
    assert_eq!(
        reopened
            .query(Query {
                search: "100%".into(),
                ..Query::default()
            })
            .unwrap()
            .total,
        2
    );
    assert_eq!(
        reopened
            .query(Query {
                search: "100_".into(),
                ..Query::default()
            })
            .unwrap()
            .total,
        0
    );
    assert_eq!(
        reopened
            .query(Query {
                format: "GP".into(),
                ..Query::default()
            })
            .unwrap()
            .total,
        0
    );
    assert!(reopened
        .query(Query {
            sort: "title; DROP TABLE scores".into(),
            ..Query::default()
        })
        .is_err());
}

#[test]
fn malformed_import_and_cancellation_roll_back_existing_data() {
    let (dir, library) = library();
    let path = dir.path().join("song.gp5");
    library
        .import_jsonl(&write(dir.path(), &[record(&path, 120)]))
        .unwrap();
    let changed = record(&path, 90);
    let unsupported = json!({"schema_version": 2, "path": path.to_string_lossy(), "status": "ok"});
    let error = library
        .import_jsonl(&write(dir.path(), &[changed.clone(), unsupported]))
        .unwrap_err();
    assert!(error.starts_with("Line 2:"));
    assert_eq!(
        library.query(Query::default()).unwrap().rows[0].tempo,
        Some(120)
    );
    let source = write(dir.path(), &[changed]);
    assert!(library.import_jsonl_cancelable(&source, || true).is_err());
    assert_eq!(
        library.query(Query::default()).unwrap().rows[0].tempo,
        Some(120)
    );
}

#[test]
fn errors_replace_stale_metadata_and_opening_requires_library_membership() {
    let (dir, library) = library();
    let path = dir.path().join("song.gp5");
    library
        .import_jsonl(&write(dir.path(), &[record(&path, 120)]))
        .unwrap();
    assert!(library.score_to_open(&path.to_string_lossy()).is_err());
    fs::write(&path, b"fixture").unwrap();
    assert!(library.score_to_open(&path.to_string_lossy()).is_ok());
    let outside = dir.path().join("unindexed.gp5");
    fs::write(&outside, b"fixture").unwrap();
    assert!(library
        .score_to_open(&outside.to_string_lossy())
        .unwrap_err()
        .contains("not in this library"));
    let error = json!({"schema_version": 1, "path": path.to_string_lossy(), "status": "error", "error": "Broken score"});
    library.import_jsonl(&write(dir.path(), &[error])).unwrap();
    let row = library
        .query(Query {
            status: "error".into(),
            ..Query::default()
        })
        .unwrap()
        .rows
        .remove(0);
    assert_eq!(row.tempo, None);
    assert_eq!(row.artist, "");
    assert_eq!(
        serde_json::from_str::<Value>(&row.record).unwrap()["error"],
        "Broken score"
    );
}

#[test]
fn migration_preserves_python_schema_and_settings_survive_reopening() {
    let (dir, library) = library();
    let path = dir.path().join("song.gp5");
    library
        .import_jsonl(&write(dir.path(), &[record(&path, 120)]))
        .unwrap();
    library
        .connect()
        .unwrap()
        .execute_batch("DROP TABLE settings; PRAGMA user_version=1;")
        .unwrap();
    let reopened = Library::new(library.directory.clone()).unwrap();
    assert_eq!(reopened.query(Query::default()).unwrap().total, 1);
    let settings = Settings {
        parser: "score_tool".into(),
        folder: dir.path().to_string_lossy().into_owned(),
    };
    reopened.save_settings(&settings).unwrap();
    assert_eq!(
        Library::new(library.directory.clone())
            .unwrap()
            .settings("fallback")
            .unwrap()
            .folder,
        settings.folder
    );
    library
        .connect()
        .unwrap()
        .execute_batch("PRAGMA user_version=99;")
        .unwrap();
    assert!(Library::new(library.directory.clone()).is_err());
}

#[test]
fn bom_unicode_paths_and_invalid_metadata() {
    let (dir, library) = library();
    let path = dir.path().join("日本語.gp5");
    let source = write(dir.path(), &[record(&path, 90)]);
    fs::write(
        &source,
        format!("\u{feff}{}\n", fs::read_to_string(&source).unwrap()),
    )
    .unwrap();
    library.import_jsonl(&source).unwrap();
    assert!(library.query(Query::default()).unwrap().rows[0]
        .path
        .contains("日本語"));
    let mut invalid = record(&path, 90);
    invalid["metadata"]["initial_tempo"] = json!("fast");
    assert!(library
        .import_jsonl(&write(dir.path(), &[invalid]))
        .is_err());
    assert!(normalized_path("relative.gp5").is_err());
}

#[test]
fn pagination_is_bounded_and_clamps_stale_pages() {
    let (dir, library) = library();
    let records: Vec<_> = (0..205)
        .map(|i| record(&dir.path().join(format!("song-{i}.gp5")), i))
        .collect();
    library.import_jsonl(&write(dir.path(), &records)).unwrap();
    let first = library.query(Query::default()).unwrap();
    assert_eq!(first.rows.len(), 200);
    assert_eq!(first.total, 205);
    let second = library
        .query(Query {
            page: 99,
            ..Query::default()
        })
        .unwrap();
    assert_eq!(second.page, 1);
    assert_eq!(second.rows.len(), 5);
}

#[test]
fn jobs_prevent_concurrent_writers_and_cancel_before_spawning() {
    let (_dir, library) = library();
    let jobs = Jobs::default();
    jobs.reserve().unwrap();
    assert!(jobs.reserve().is_err());
    jobs.cancel().unwrap();
    let source = library.directory.join("file.jsonl");
    fs::write(&source, "").unwrap();
    assert!(jobs.import(&library, &source).is_err());
    jobs.finish(Err("Cancelled".into()));
    let state = jobs.snapshot().unwrap();
    assert!(!state.busy);
    assert_eq!(state.revision, 1);
    assert_eq!(library.query(Query::default()).unwrap().total, 0);
}

#[test]
fn parser_failure_keeps_artifacts_without_updating_library() {
    let (dir, library) = library();
    let jobs = Jobs::default();
    jobs.reserve().unwrap();
    // The test executable rejects score_tool's CLI arguments with a nonzero exit.
    let result = jobs.scan(
        &library,
        Settings {
            parser: std::env::current_exe()
                .unwrap()
                .to_string_lossy()
                .into_owned(),
            folder: dir.path().to_string_lossy().into_owned(),
        },
    );
    assert!(result.unwrap_err().contains("Parser exited"));
    assert_eq!(library.query(Query::default()).unwrap().total, 0);
    assert_eq!(
        fs::read_dir(library.directory.join("scans"))
            .unwrap()
            .count(),
        2
    );
}

#[test]
#[ignore = "requires the sibling score_tool build and test/Wah.gp5 fixture"]
fn real_parser_scan_rescan_and_failures() {
    let (dir, library) = library();
    let parser_root = std::env::var_os("GFM_PARSER_ROOT")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| {
            std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../guitarpro-file-parser")
        });
    let name = if cfg!(windows) {
        "score_tool.exe"
    } else {
        "score_tool"
    };
    let parser = parser_root.join("target/release").join(name);
    let folder = dir.path().join("Scores with spaces");
    fs::create_dir(&folder).unwrap();
    fs::copy(parser_root.join("test/Wah.gp5"), folder.join("日本語.gp5")).unwrap();
    fs::write(folder.join("broken.gp5"), b"not a score").unwrap();
    let jobs = Jobs::default();
    for _ in 0..2 {
        jobs.reserve().unwrap();
        let result = jobs.scan(
            &library,
            Settings {
                parser: parser.to_string_lossy().into_owned(),
                folder: folder.to_string_lossy().into_owned(),
            },
        );
        assert_eq!(result.as_ref().unwrap().0, 2);
        assert!(result.as_ref().unwrap().1.is_file());
        jobs.finish(result);
    }
    assert_eq!(library.query(Query::default()).unwrap().total, 2);
    assert_eq!(
        library
            .query(Query {
                status: "error".into(),
                ..Query::default()
            })
            .unwrap()
            .total,
        1
    );
    assert_eq!(
        library
            .query(Query {
                status: "ok".into(),
                ..Query::default()
            })
            .unwrap()
            .total,
        1
    );
}

#[test]
fn cancellation_terminates_a_streaming_parser_and_preserves_library() {
    let (dir, library) = library();
    let source = dir.path().join("slow-parser.rs");
    fs::write(
        &source,
        r#"fn main() {
        use std::io::Write;
        println!("{{}}");
        std::io::stdout().flush().unwrap();
        std::thread::sleep(std::time::Duration::from_secs(60));
    }"#,
    )
    .unwrap();
    let executable = dir.path().join(if cfg!(windows) {
        "slow-parser.exe"
    } else {
        "slow-parser"
    });
    let compile = std::process::Command::new("rustc")
        .arg(&source)
        .arg("-o")
        .arg(&executable)
        .output()
        .expect("rustc available");
    assert!(
        compile.status.success(),
        "{}",
        String::from_utf8_lossy(&compile.stderr)
    );
    let existing = dir.path().join("existing.gp5");
    library
        .import_jsonl(&write(dir.path(), &[record(&existing, 120)]))
        .unwrap();
    let jobs = Jobs::default();
    jobs.reserve().unwrap();
    let worker_jobs = jobs.clone();
    let worker_library = library.clone();
    let folder = dir.path().to_string_lossy().into_owned();
    let worker = std::thread::spawn(move || {
        let result = worker_jobs.scan(
            &worker_library,
            Settings {
                parser: executable.to_string_lossy().into_owned(),
                folder,
            },
        );
        worker_jobs.finish(result.clone());
        result
    });
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while jobs.snapshot().unwrap().processed == 0 && std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(25));
    }
    let saw_output = jobs.snapshot().unwrap().processed > 0;
    jobs.cancel().unwrap();
    let result = worker.join().unwrap();
    assert!(
        saw_output,
        "Parser must emit output before cancellation is tested"
    );
    assert!(result.unwrap_err().contains("cancelled"));
    assert!(!jobs.snapshot().unwrap().busy);
    assert_eq!(
        library.query(Query::default()).unwrap().rows[0].tempo,
        Some(120)
    );
}

#[test]
fn parser_setting_saves_without_a_scan_and_preserves_folder() {
    let dir = tempfile::tempdir().unwrap();
    let library = Library::new(dir.path().to_path_buf()).unwrap();
    library
        .save_settings(&Settings {
            parser: "old_parser".into(),
            folder: "saved_folder".into(),
        })
        .unwrap();
    library.save_parser("new_parser").unwrap();
    let reopened = Library::new(dir.path().to_path_buf()).unwrap();
    let settings = reopened.settings("fallback").unwrap();
    assert_eq!(settings.parser, "new_parser");
    assert_eq!(settings.folder, "saved_folder");
    assert!(reopened.save_parser("   ").is_err());
    assert_eq!(reopened.settings("fallback").unwrap().parser, "new_parser");
}

#[test]
fn filename_and_directory_sort_by_displayed_values_before_pagination() {
    let (dir, library) = library();
    let records = (0..205)
        .map(|i| {
            record(
                &dir.path()
                    .join(format!("group{:03}/song{:03}.gp5", 204 - i, i)),
                120,
            )
        })
        .collect::<Vec<_>>();
    library.import_jsonl(&write(dir.path(), &records)).unwrap();
    for (sort, descending, expected) in [
        ("filename", false, 0),
        ("filename", true, 204),
        ("directory", false, 204),
        ("directory", true, 0),
    ] {
        let page = library
            .query(Query {
                sort: sort.into(),
                descending,
                ..Query::default()
            })
            .unwrap();
        assert_eq!(page.total, 205);
        assert_eq!(page.rows.len(), 200);
        let expected_path = dir.path().join(format!(
            "group{:03}/song{:03}.gp5",
            204 - expected,
            expected
        ));
        assert_eq!(
            page.rows[0].path,
            normalized_path(&expected_path.to_string_lossy()).unwrap()
        );
    }
    let page = library
        .query(Query {
            sort: "filename".into(),
            page: 1,
            ..Query::default()
        })
        .unwrap();
    assert_eq!(page.rows.len(), 5);
    assert!(page.rows[0].path.ends_with("song200.gp5"));
}

#[test]
fn tuning_normalization_migration_filters_and_rescans() {
    let (dir, library) = library();
    let first = dir.path().join("bass.gp5");
    let second = dir.path().join("extended.gp5");
    let track = |pitches: &[u8]| {
        json!({"kind": "stringed", "tuning": pitches.iter().enumerate()
        .rev().map(|(i, midi)| json!({"number": i+1, "midi": midi, "note": "ignored label"})).collect::<Vec<_>>()})
    };
    let bass = track(&[43, 38, 33, 28]);
    let seven = track(&[64, 59, 55, 50, 45, 40, 35]);
    let mut a = record(&first, 120);
    a["metadata"]["tracks"] = json!([bass.clone(), bass.clone(), seven.clone()]);
    let mut b = record(&second, 90);
    b["metadata"]["tracks"] = json!([seven, track(&[60]), track(&[64,59,55,50,45,40,35,30,25,20,15,10]),
        {"kind":"percussion", "tuning":[{"number":1,"midi":43}]},
        {"tuning":[{"number":1,"midi":40},{"number":1,"midi":45}]},
        {"tuning":[{"number":2,"midi":40}]},
        {"tuning":[{"number":1,"midi":128}]}, {"tuning":[]},
        {"tuning":[{"number":1,"note":"E2"}]}]);
    library
        .import_jsonl(&write(dir.path(), &[a.clone(), b]))
        .unwrap();
    let matches = |library: &Library, key: &str| {
        library
            .query(Query {
                tuning: key.into(),
                ..Query::default()
            })
            .unwrap()
            .total
    };
    assert_eq!(matches(&library, "43,38,33,28"), 1);
    assert_eq!(matches(&library, "64,59,55,50,45,40,35"), 2);
    assert_eq!(matches(&library, "60"), 1);
    assert_eq!(matches(&library, "64,59,55,50,45,40,35,30,25,20,15,10"), 1);
    assert_eq!(matches(&library, "43"), 0);
    assert_eq!(matches(&library, "40"), 0);
    assert_eq!(library.query(Query::default()).unwrap().tunings.len(), 4);
    assert_eq!(
        library
            .query(Query {
                tuning: "43,38,33,28".into(),
                status: "error".into(),
                ..Query::default()
            })
            .unwrap()
            .total,
        0
    );
    // Recreate an actual v2 database; opening it must backfill without a scan.
    library
        .connect()
        .unwrap()
        .execute_batch("DROP TABLE score_tracks; PRAGMA user_version=2;")
        .unwrap();
    let reopened = Library::new(library.directory.clone()).unwrap();
    assert_eq!(matches(&reopened, "43,38,33,28"), 1);
    assert_eq!(reopened.query(Query::default()).unwrap().rows.len(), 2);
    assert_eq!(
        reopened
            .connect()
            .unwrap()
            .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        4
    );
    a["metadata"]["tracks"] = json!([track(&[64, 59, 55, 50, 45, 38])]);
    let bad = json!({"schema_version":99});
    assert!(reopened
        .import_jsonl(&write(dir.path(), &[a.clone(), bad]))
        .is_err());
    assert_eq!(matches(&reopened, "43,38,33,28"), 1);
    reopened.import_jsonl(&write(dir.path(), &[a])).unwrap();
    assert_eq!(matches(&reopened, "43,38,33,28"), 0);
    assert_eq!(matches(&reopened, "64,59,55,50,45,38"), 1);
    let error = json!({"schema_version":1,"path":first.to_string_lossy(),"status":"error","error":"broken"});
    reopened.import_jsonl(&write(dir.path(), &[error])).unwrap();
    assert_eq!(matches(&reopened, "64,59,55,50,45,38"), 0);
    assert!(!reopened
        .query(Query::default())
        .unwrap()
        .tunings
        .contains(&"64,59,55,50,45,38".into()));
}

#[test]
fn column_preferences_persist_validate_and_preserve_scan_settings() {
    let (_dir, library) = library();
    assert!(library.hidden_columns().unwrap().is_empty());
    library
        .save_hidden_columns(&["album".into(), "directory".into(), "album".into()])
        .unwrap();
    let reopened = Library::new(library.directory.clone()).unwrap();
    assert_eq!(reopened.hidden_columns().unwrap(), ["directory", "album"]);
    reopened.save_parser("score_tool").unwrap();
    reopened
        .save_settings(&Settings {
            parser: "new_parser".into(),
            folder: "scores".into(),
        })
        .unwrap();
    assert_eq!(reopened.hidden_columns().unwrap(), ["directory", "album"]);
    assert!(reopened.save_hidden_columns(&["unknown".into()]).is_err());
    let all = crate::storage::COLUMNS
        .iter()
        .map(|column| column.to_string())
        .collect::<Vec<_>>();
    assert!(reopened.save_hidden_columns(&all).is_err());
    assert_eq!(reopened.hidden_columns().unwrap(), ["directory", "album"]);
    reopened.save_hidden_columns(&[]).unwrap();
    assert!(Library::new(library.directory.clone())
        .unwrap()
        .hidden_columns()
        .unwrap()
        .is_empty());
    assert_eq!(reopened.settings("").unwrap().parser, "new_parser");
}

#[test]
fn modification_dates_backfill_sort_and_update_transactionally() {
    let (dir, library) = library();
    let paths =
        ["early", "late", "missing", "invalid"].map(|name| dir.path().join(format!("{name}.gp5")));
    let mut records = paths
        .iter()
        .map(|path| record(path, 120))
        .collect::<Vec<_>>();
    // Offsets must sort by instant rather than the original timestamp text.
    records[0]["file_metadata"] = json!({"updated_at":"2026-10-13T12:00:00+02:00"});
    records[1]["file_metadata"] = json!({"updated_at":"2026-10-13T09:00:00-04:00"});
    records[3]["file_metadata"] = json!({"updated_at":"invalid"});
    library.import_jsonl(&write(dir.path(), &records)).unwrap();
    library.save_hidden_columns(&["album".into()]).unwrap();
    // Restore the actual previous schema to exercise the ALTER and JSON backfill.
    library.connect().unwrap().execute_batch(
        "DROP INDEX scores_updated_at; ALTER TABLE scores DROP COLUMN updated_at; PRAGMA user_version=3;"
    ).unwrap();
    let reopened = Library::new(library.directory.clone()).unwrap();
    assert_eq!(reopened.hidden_columns().unwrap(), ["album"]);
    for descending in [false, true] {
        let page = reopened
            .query(Query {
                sort: "updated_at".into(),
                descending,
                ..Query::default()
            })
            .unwrap();
        let expected = if descending { &paths[1] } else { &paths[0] };
        assert_eq!(
            page.rows[0].path,
            normalized_path(&expected.to_string_lossy()).unwrap()
        );
        assert!(page.rows[0].updated_at.is_some());
        assert!(page.rows[1].updated_at.is_some());
        assert!(page.rows[2..].iter().all(|row| row.updated_at.is_none()));
    }
    records[0]["file_metadata"]["updated_at"] = json!("2026-10-14T00:00:00Z");
    assert!(reopened
        .import_jsonl(&write(
            dir.path(),
            &[records[0].clone(), json!({"schema_version":99})]
        ))
        .is_err());
    let query = || Query {
        sort: "updated_at".into(),
        descending: true,
        ..Query::default()
    };
    assert_eq!(
        reopened.query(query()).unwrap().rows[0].path,
        normalized_path(&paths[1].to_string_lossy()).unwrap()
    );
    reopened
        .import_jsonl(&write(dir.path(), &[records[0].clone()]))
        .unwrap();
    assert_eq!(
        reopened.query(query()).unwrap().rows[0]
            .updated_at
            .as_deref(),
        Some("2026-10-14T00:00:00Z")
    );
    // File metadata can still be available when parsing fails.
    let mut error = json!({"schema_version":1,"path":paths[0].to_string_lossy(),"status":"error","error":"broken",
        "file_metadata":{"updated_at":"2026-10-15T00:00:00Z"}});
    reopened
        .import_jsonl(&write(dir.path(), &[error.clone()]))
        .unwrap();
    assert_eq!(
        reopened.query(query()).unwrap().rows[0]
            .updated_at
            .as_deref(),
        Some("2026-10-15T00:00:00Z")
    );
    error["file_metadata"] = Value::Null;
    reopened.import_jsonl(&write(dir.path(), &[error])).unwrap();
    assert_eq!(
        reopened.query(query()).unwrap().rows[0].path,
        normalized_path(&paths[1].to_string_lossy()).unwrap()
    );
}

#[test]
fn modification_date_sorting_precedes_pagination() {
    let (dir, library) = library();
    let records = (0..205)
        .map(|i| {
            let mut value = record(&dir.path().join(format!("song-{i:03}.gp5")), 120);
            // Reverse filename order relative to modification time.
            value["file_metadata"] =
                json!({"updated_at":format!("2026-10-13T00:{:02}:{:02}Z", (204-i)/60, (204-i)%60)});
            value
        })
        .collect::<Vec<_>>();
    library.import_jsonl(&write(dir.path(), &records)).unwrap();
    let first = library
        .query(Query {
            sort: "updated_at".into(),
            ..Query::default()
        })
        .unwrap();
    assert_eq!(first.total, 205);
    assert!(first.rows[0].path.ends_with("song-204.gp5"));
    let second = library
        .query(Query {
            sort: "updated_at".into(),
            page: 1,
            ..Query::default()
        })
        .unwrap();
    assert_eq!(second.rows.len(), 5);
    assert!(second.rows[0].path.ends_with("song-004.gp5"));
}

#[test]
fn favorite_tunings_persist_validate_and_preserve_other_preferences() {
    let (_dir, library) = library();
    assert!(library.favorite_tunings().unwrap().is_empty());
    let bass = "43,38,33,28".to_string();
    let seven = "64,59,55,50,45,40,35".to_string();
    library
        .save_favorite_tunings(&[seven.clone(), bass.clone(), bass.clone()])
        .unwrap();
    let reopened = Library::new(library.directory.clone()).unwrap();
    assert_eq!(
        reopened.favorite_tunings().unwrap(),
        [bass.clone(), seven.clone()]
    );
    reopened.save_hidden_columns(&["album".into()]).unwrap();
    reopened.save_parser("score_tool").unwrap();
    for key in ["", "128", "-1", "64,,40", "E2,A2", "040", "40,"] {
        assert!(reopened.save_favorite_tunings(&[key.into()]).is_err());
    }
    assert_eq!(reopened.favorite_tunings().unwrap(), [bass, seven]);
    reopened.save_favorite_tunings(&[]).unwrap();
    assert!(reopened.favorite_tunings().unwrap().is_empty());
    assert_eq!(reopened.hidden_columns().unwrap(), ["album"]);
    assert_eq!(reopened.settings("").unwrap().parser, "score_tool");
}
