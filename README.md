# guitarpro-file-manager

A Tauri desktop library for Guitar Pro scores. The app executes `score_tool`,
retains its JSONL output, indexes metadata in SQLite, and lets you search, sort,
inspect, and open scores. Rust handles storage and processes; frontend assets
are bundled into the executable. The native app does not need Python, npm, or
a local HTTP server.

## Repository layout

```text
guitarpro-file-manager/
|-- Cargo.toml       # Workspace; run Cargo commands here
|-- Cargo.lock       # Shared Rust dependency lockfile
|-- src-tauri/       # Rust backend, Tauri config, capabilities, and icons
|-- web/             # Bundled frontend assets
|-- tests/           # Frontend interaction tests
|-- README.md
|-- PLAN.md
```

Cargo writes build output to the root `target/` directory. Rust unit and integration
checks remain alongside the backend in `src-tauri/src/tests.rs`.

## Run

From this repository:

```powershell
cargo run
```

A prebuilt development executable is also available after `cargo build` at
`target/debug/guitarpro-file-manager.exe` on Windows.

Build the parser in the sibling `../guitarpro-file-parser` repository:

```powershell
cargo build --release -p cli
```

The manager looks for `score_tool[.exe]` beside its executable, in the sibling
parser's release/debug build, then on PATH. Open **Settings** in the top navigation, use **Browse** beside Executable location
to choose another build, and select **Save settings**. The parser location is saved
immediately and used for subsequent scans. Under **Settings → Scan folder**, use **Browse** beside Score folder and **Scan folder**
to recursively index scores. **Import JSONL** opens a native file dialog for an
existing extraction. The last scan's parser and folder are saved across restarts.

Open **Settings → Library columns** to show or hide table columns. Column preferences
save automatically and persist across restarts. **Settings → Favorite tunings** lets
you pin tunings to the top of their string-count group in the filter. Favorites
are marked with a star and saved across restarts; each group sorts favorites and
remaining tunings alphabetically.

Search metadata, select format/status/tuning filters, click column headers to sort, and
navigate pages of 200 records. Wider tables scroll horizontally. Drag the divider between the table and score
details to resize both panes together. The divider supports Left/Right arrows
and double-clicking to restore the default split. Select a score to inspect its full extraction; use
**Open score** or double-click a row to launch the associated application. A score
application must be installed and associated with that extension.

**Cancel** terminates a running parser or rolls back an unfinished import. The
window waits for active jobs to finish or be cancelled before it closes. Individual
parse errors appear as library rows even if the parser process exits successfully.

## Build and install a release on Windows

Close the running manager, then run this from PowerShell in the repository:

```powershell
.\build-release.ps1
```

The script builds the sibling `../guitarpro-file-parser` CLI and this manager in
release mode, then copies both executables to
`%LOCALAPPDATA%\Programs\GuitarProFileManager`. It stops on build failure before
copying. Run it again to update the installed executables at the same paths.
Rust/Cargo and the native build prerequisites must already be installed.

Launch `guitarpro-file-manager.exe` from that folder, then right-click its taskbar
icon and select **Pin to taskbar**. In **Settings**, select the installed
`score_tool.exe` if your saved parser path points elsewhere. Existing library data
and settings are retained.

Optional paths:

```powershell
.\build-release.ps1 -ParserDirectory C:\path\to\guitarpro-file-parser -InstallDirectory C:\Apps\GuitarProFileManager
```

## Data and configuration

The default library location is:

- Windows: `%LOCALAPPDATA%/guitarpro-file-manager`
- macOS: `~/Library/Application Support/guitarpro-file-manager`
- Linux: `${XDG_DATA_HOME:-~/.local/share}/guitarpro-file-manager`

The directory contains `library.sqlite3` and extraction/diagnostic files under
`scans/`. Opening a schema version 1 library migrates it transactionally
to version 4, preserving scores and adding saved settings and indexed track tunings.
Older libraries also migrate automatically, backfilling tunings and file modification
dates from stored JSON. **Date modified** displays the local date and time from
`file_metadata.updated_at` and sorts chronologically. Missing or invalid dates
appear as a dash and sort last in either direction.
Tuning filters match any track by its exact open-string MIDI pitches ordered by
string number, including octave and any string count. Note names are display
labels; missing, malformed, and percussion tunings are excluded from the filter. Rescans update matching
paths. Missing scores are retained. Original score files are never edited.

Environment overrides:

| Variable | Purpose |
| --- | --- |
| `GFM_DATA_DIR` | Use another library directory, including `.preview-data` for the existing demo. |
| `GFM_PARSER_ROOT` | Locate a parser repository outside the default sibling location. |
| `GFM_PARSER` | Set the initial parser executable when no saved parser is present. |

Failed and cancelled jobs keep their extraction artifacts. Failed parser processes
do not import partial output. Malformed or unsupported JSONL records roll back the
entire import. Paths must be absolute paths for the local OS.

## Verification

```powershell
cargo test
cargo test -- --include-ignored
cargo clippy --all-targets -- -D warnings
node tests/test_web.cjs
```

The ignored integration test requires a release parser and the sibling
`test/Wah.gp5` fixture. Tests cover migration, persistence, literal search, numeric
sorting, pagination, Unicode paths, transactional rollback, cancellation, parser
failures, actual parser output, and native frontend interactions.

Windows compilation and backend/IPC interaction tests have been run. Native dialog
interaction and layout still need a manual check; macOS/Linux builds and installer
packaging remain pending. New development machines need
[Tauri's native prerequisites](https://v2.tauri.app/start/prerequisites/).

See [PLAN.md](PLAN.md) for the next milestones: incremental scans, multiple saved
library folders, richer metadata filters, duplicate groups, and native installers.
