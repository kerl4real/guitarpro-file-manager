"""Open both comparison interfaces against the same library."""
import argparse
import os
from pathlib import Path
import subprocess
import sys
import time

from core import default_directory


def main():
    arguments = argparse.ArgumentParser()
    arguments.add_argument('--data-dir', default=str(default_directory()))
    args = arguments.parse_args()
    root = Path(__file__).resolve().parent
    executable = root / 'src-tauri/target/debug' / ('guitarpro-file-manager.exe' if sys.platform == 'win32' else 'guitarpro-file-manager')
    if not executable.is_file():
        raise SystemExit('Build Tauri first: cargo build --manifest-path src-tauri/Cargo.toml')
    environment = dict(os.environ, GFM_PYTHON=sys.executable, GFM_DATA_DIR=str(Path(args.data_dir).resolve()))
    flags = subprocess.CREATE_NO_WINDOW if sys.platform == 'win32' else 0
    desktop = subprocess.Popen([sys.executable, str(root / 'desktop.py'), '--data-dir', environment['GFM_DATA_DIR']], creationflags=flags)
    native = subprocess.Popen([str(executable)], env=environment, creationflags=flags)
    time.sleep(2)
    if desktop.poll() is not None or native.poll() is not None:
        raise SystemExit('A comparison window exited during startup; check the console diagnostics.')
    print('Started Tkinter and Tauri against:', environment['GFM_DATA_DIR'])


if __name__ == '__main__':
    main()
