# guitarpro-file-manager

## Product scope

A local desktop library for Windows, macOS, and Linux. Users select score folders,
extract metadata with the existing parser, browse and filter their library, and
open a score in the operating system's associated application.

## Integration contract

Run an installed, platform-specific `score_tool` executable with an argument list:

```
score_tool scan --input <folder> --recursive --jobs 4 --format jsonl
```

Consume schema version 1 JSONL on stdout. Capture stderr separately; it contains
progress and diagnostics, not metadata. Keep individual error records because a
successful process exit does not imply that every score parsed successfully.
Retain a JSONL artifact for every scan, including incomplete scans, and preserve
the full JSON record in the database for future metadata features.

## Storage

SQLite is the initial persistence layer. One row per normalized absolute path;
rescanning upserts that row. Different paths with the same checksum remain
separate files. Indexed columns support title, artist, album, format, tempo,
track count, status, and path; full JSON preserves tracks, tunings and credits.
Schema migrations use SQLite's user_version. A scan failure replaces the current
metadata with the error record rather than displaying stale metadata as current.

Original scores stay in their folders. Missing files are retained until an explicit
future cleanup operation. Metadata extraction never edits the score files.

## First working slice

- Select the parser executable and scan a folder recursively in a background job.
- Persist JSONL artifacts and upsert their records into SQLite.
- Import an existing JSONL scan without invoking the parser.
- Browse a file table; search metadata; filter format and parse status.
- Sort columns, including numeric tempo and track counts.
- Inspect all extracted metadata and errors for the selected file.
- Open a score with the system's associated application.

## Selected architecture

Tauri is the selected GUI stack (2026-10-12), following comparison with Tkinter.
Continue development of the web interface in the native Tauri window. SQLite
remains the persistence layer and `score_tool scan` remains the parser boundary.
Tkinter is retained as a comparison artifact rather than an active product target.

The current Tauri prototype launches a Python/SQLite HTTP backend. The next
implementation milestone replaces that development service with Rust Tauri
commands, embedded SQLite storage, and asynchronous parser process execution.
Serve the frontend as bundled Tauri assets and use Tauri IPC instead of localhost
HTTP. Add native folder/executable selection and system file opening. Preserve
the existing JSONL protocol, transactional imports, and library schema.

The Windows Tauri executable has built and launched successfully. Dependency
downloads succeeded outside the restricted sandbox; no user setup is currently
blocking Windows development. macOS/Linux packaging and runtime verification
remain pending native environments or CI runners.

## Follow-up milestones

1. Migrate the prototype backend into Rust/Tauri and add native file/folder dialogs.
   Continue in the separate `guitarpro-file-manager` repository, located beside
   `guitarpro-file-parser`. Discover the parser in that sibling repository or
   through an explicitly configured executable.
2. Add saved library folders, persisted settings, incremental scanning, cancellation,
   paginated queries, and database migrations as the schema evolves.
3. Add track/instrument/tuning filters, duplicate checksum groups, missing-file
   reconciliation, saved searches, and configurable application selection.
4. Package native installers and parser binaries for each target OS, then test
   imports, large libraries, launch behavior, accessibility, and upgrades on all
   three platforms. Shipping cross-platform support requires those native checks.

## Acceptance checks

Import real parser output; verify persisted records survive reopening. Rescan the
same path without duplicate rows. Verify error records, Unicode paths, literal
search characters, numeric sorting, unsupported schemas, and failed subprocesses.
Confirm opening a missing file produces a useful message. Validate the desktop UI
on Windows first and track macOS/Linux verification separately.
