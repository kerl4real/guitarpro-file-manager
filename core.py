"""UI-independent parser integration and SQLite library."""
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
from contextlib import contextmanager
from datetime import datetime, timezone
from uuid import uuid4


class Library:
    COLUMNS = ('path', 'title', 'artist', 'album', 'format', 'tempo', 'tracks', 'status')

    def __init__(self, directory):
        self.directory = Path(directory).resolve()
        self.directory.mkdir(parents=True, exist_ok=True)
        self.database = self.directory / 'library.sqlite3'
        with self.connect() as db:
            version = db.execute('PRAGMA user_version').fetchone()[0]
            if version not in (0, 1):
                raise ValueError(f'Unsupported database schema: {version}')
            db.execute('''CREATE TABLE IF NOT EXISTS scores (
                path TEXT PRIMARY KEY, title TEXT, artist TEXT, album TEXT,
                format TEXT, tempo INTEGER, tracks INTEGER, status TEXT NOT NULL,
                record TEXT NOT NULL)''')
            db.execute('CREATE INDEX IF NOT EXISTS scores_artist ON scores(artist)')
            db.execute('CREATE INDEX IF NOT EXISTS scores_format ON scores(format)')
            db.execute('PRAGMA user_version = 1')

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.database, timeout=30)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    @staticmethod
    def validate(record):
        if not isinstance(record, dict) or record.get('schema_version') != 1:
            raise ValueError('Expected parser schema_version 1')
        if record.get('status') not in ('ok', 'error'):
            raise ValueError('Invalid scan status')
        path = record.get('path')
        if not isinstance(path, str) or not Path(path).is_absolute():
            raise ValueError('Scan record must have an absolute local path')
        if record['status'] == 'ok' and not isinstance(record.get('metadata'), dict):
            raise ValueError('Successful scan record is missing metadata')
        return record

    def import_jsonl(self, source):
        count = 0
        # One transaction: malformed imports leave existing library data intact.
        with self.connect() as db, open(source, encoding='utf-8-sig') as lines:
            for number, line in enumerate(lines, 1):
                if not line.strip():
                    continue
                try:
                    record = self.validate(json.loads(line))
                    metadata = record.get('metadata') or {}
                    path = os.path.normcase(os.path.normpath(record['path']))
                    values = (path, metadata.get('title') or Path(path).name,
                              metadata.get('artist', ''), metadata.get('album', ''),
                              metadata.get('format', Path(path).suffix[1:].upper()),
                              metadata.get('initial_tempo'), metadata.get('track_count'),
                              record['status'], json.dumps(record, ensure_ascii=False))
                    db.execute('''INSERT INTO scores VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                        ON CONFLICT(path) DO UPDATE SET title=excluded.title,
                        artist=excluded.artist, album=excluded.album, format=excluded.format,
                        tempo=excluded.tempo, tracks=excluded.tracks, status=excluded.status,
                        record=excluded.record''', values)
                except (ValueError, TypeError, sqlite3.Error) as error:
                    raise ValueError(f'Line {number}: {error}') from error
                count += 1
        return count

    def query(self, search='', format='', status='', sort='title', descending=False):
        if sort not in self.COLUMNS:
            raise ValueError('Unsupported sort column')
        pattern = '%' + search.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_') + '%'
        direction = 'DESC' if descending else 'ASC'
        with self.connect() as db:
            rows = db.execute(f'''SELECT * FROM scores
                WHERE (title LIKE ? ESCAPE '\\' OR artist LIKE ? ESCAPE '\\'
                    OR album LIKE ? ESCAPE '\\' OR path LIKE ? ESCAPE '\\'
                    OR record LIKE ? ESCAPE '\\')
                AND (? = '' OR format = ?) AND (? = '' OR status = ?)
                ORDER BY {sort} COLLATE NOCASE {direction}, path ASC''',
                (pattern,) * 5 + (format, format, status, status)).fetchall()
        return [dict(row) for row in rows]

    def scan(self, parser, folder, progress=lambda count: None):
        if not Path(folder).is_dir():
            raise ValueError('Select an existing score folder')
        scans = self.directory / 'scans'
        scans.mkdir(exist_ok=True)
        name = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + uuid4().hex[:8]
        artifact = scans / (name + '.jsonl')
        diagnostics = scans / (name + '.stderr.txt')
        command = [str(parser), 'scan', '--input', str(Path(folder).resolve()),
                   '--recursive', '--jobs', '4', '--format', 'jsonl']
        flags = subprocess.CREATE_NO_WINDOW if sys.platform == 'win32' else 0
        # stderr goes to disk so it cannot fill a pipe while stdout streams.
        with open(diagnostics, 'w', encoding='utf-8') as errors:
            with subprocess.Popen(command, stdout=subprocess.PIPE, stderr=errors,
                                  text=True, encoding='utf-8', creationflags=flags) as process:
                try:
                    with open(artifact, 'w', encoding='utf-8') as output:
                        for count, line in enumerate(process.stdout, 1):
                            output.write(line)
                            progress(count)
                    result = process.wait()
                except BaseException:
                    process.terminate()
                    process.wait()
                    raise
        if result:
            detail = diagnostics.read_text(encoding='utf-8')[-4000:]
            raise RuntimeError(f'Parser exited with {result}. {detail}\nSaved output: {artifact}')
        count = self.import_jsonl(artifact)
        return count, artifact


def default_directory():
    if sys.platform == 'win32':
        base = Path(os.environ.get('LOCALAPPDATA', Path.home() / 'AppData/Local'))
    elif sys.platform == 'darwin':
        base = Path.home() / 'Library/Application Support'
    else:
        base = Path(os.environ.get('XDG_DATA_HOME', Path.home() / '.local/share'))
    return base / 'guitarpro-file-manager'


def default_parser():
    root = Path(os.environ.get('GFM_PARSER_ROOT',
                Path(__file__).resolve().parent.parent / 'guitarpro-file-parser'))
    name = 'score_tool.exe' if sys.platform == 'win32' else 'score_tool'
    for profile in ('release', 'debug'):
        candidate = root / 'target' / profile / name
        if candidate.is_file():
            return str(candidate)
    return 'score_tool'


def open_score(path):
    path = Path(path).resolve(strict=True)
    if not path.is_file() or path.suffix.lower() not in ('.gp3', '.gp4', '.gp5', '.gp', '.gpx', '.mscz'):
        raise ValueError('Select an existing supported score file')
    if sys.platform == 'win32':
        os.startfile(str(path))
    else:
        subprocess.Popen(['open' if sys.platform == 'darwin' else 'xdg-open', str(path)])
