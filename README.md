# guitarpro-file-manager — Tauri desktop app

Tauri is the selected desktop stack. The current working prototype uses a
Python/SQLite backend and the parser's schema version 1 JSONL output. The next
milestone moves storage and parser integration into Rust/Tauri commands so the
app can run without Python. This is a separate repository beside
`guitarpro-file-parser`. The parser integration does not require changing the parser.

## Run Tauri

From this directory:

```powershell
cargo run --manifest-path src-tauri/Cargo.toml
```

The Windows native build and startup have been verified on this machine. No
additional user setup is currently needed here. The development version still
requires Python and the source tree; installers and macOS/Linux verification
remain pending.

## Earlier comparison interfaces

From this directory, with Python 3.11+ and Tk installed:

```powershell
python desktop.py
python web_preview.py
```

The first command opens the Tkinter desktop app. The second opens the web design
in your browser and prints its local URL; stop it with Ctrl+C. Keep that URL private
because its fragment contains the session's API token. Both use the same database,
so scan/import in one and restart or filter the other to see the same library.

Build the parser from the sibling `../guitarpro-file-parser` directory with
`cargo build --release -p cli`. The prototypes automatically find
`../guitarpro-file-parser/target/release/score_tool[.exe]`, then debug, or use
`score_tool` on PATH. Set `GFM_PARSER_ROOT` if the parser repository is elsewhere.
You can specify a different executable in either UI.
Tkinter provides folder dialogs; the web comparison takes an absolute folder path.
Both provide JSONL import, metadata search, format/status filters, sortable columns,
full record inspection, and opening scores through the OS file association.

## Run the actual Tauri shell

Install the native prerequisites described in
[Tauri's documentation](https://v2.tauri.app/start/prerequisites/), then run:

```powershell
cargo run --manifest-path src-tauri/Cargo.toml
```

After building, open both windows together with `python compare.py`. Use
`python compare.py --data-dir .preview-data` to inspect the three test scores
prepared during development. These are parser fixtures, not your personal library.

This opens the same web interface in a native Tauri window. No npm build is needed.
The development shell starts the local Python backend and stops it on exit. Set
`GFM_PYTHON` to the Python executable if `python` is unavailable; `GFM_DATA_DIR`
selects a different library for the Tauri shell. This is a development
comparison, not an installer: it requires the Python source tree, Python runtime,
and a separately built parser. A production Tauri version should package its backend
or migrate the storage/integration code into Rust, add native folder dialogs,
remove development source paths, and validate native packaging on each platform.

## Storage and verification

Defaults: `%LOCALAPPDATA%/guitarpro-file-manager` on Windows,
`~/Library/Application Support/guitarpro-file-manager` on macOS, and
`${XDG_DATA_HOME:-~/.local/share}/guitarpro-file-manager` on Linux. Pass
`--data-dir <folder>` to either Python entry point to use a different library.
The directory contains `library.sqlite3` and scan artifacts under `scans/`.
Successful rescans update existing paths; failed scans retain diagnostic artifacts
and do not import partial output. Individual score errors are visible in the table.
JSONL imports are transactional. No scores are moved or edited.

```powershell
python -m unittest -v
python smoke_check.py
```

See [PLAN.md](PLAN.md) for the roadmap. Current limits: no scan cancellation,
no saved folder settings, no installers, and no paging for very large libraries.
The web upload limit is 32 MB; the desktop importer streams larger JSONL files.
Opening requires an installed score application and a working OS file association.
