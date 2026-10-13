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
parser's release/debug build, then on PATH. Use **Browse** beside Parser executable
to choose another build. Use **Browse** beside Score folder and **Scan folder**
to recursively index scores. **Import JSONL** opens a native file dialog for an
existing extraction. The last scan's parser and folder are saved across restarts.

Search metadata, select format/status filters, click column headers to sort, and
navigate pages of 200 records. Select a score to inspect its full extraction; use
**Open score** or double-click a row to launch the associated application. A score
application must be installed and associated with that extension.

**Cancel** terminates a running parser or rolls back an unfinished import. The
window waits for active jobs to finish or be cancelled before it closes. Individual
parse errors appear as library rows even if the parser process exits successfully.

## Data and configuration

The default library location is:

- Windows: `%LOCALAPPDATA%/guitarpro-file-manager`
- macOS: `~/Library/Application Support/guitarpro-file-manager`
- Linux: `${XDG_DATA_HOME:-~/.local/share}/guitarpro-file-manager`

The directory contains `library.sqlite3` and extraction/diagnostic files under
`scans/`. Opening a schema version 1 library migrates it transactionally
to version 2, preserving scores and adding saved settings. Rescans update matching
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
