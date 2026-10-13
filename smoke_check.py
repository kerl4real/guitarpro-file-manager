"""Integration check against a built score_tool and a real repository fixture."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import tkinter as tk
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from core import Library, default_parser
from desktop import Desktop


def main():
    root = Path(__file__).resolve().parent
    with tempfile.TemporaryDirectory() as directory:
        folder = Path(directory) / 'scores'
        folder.mkdir()
        parser_root = Path(os.environ.get('GFM_PARSER_ROOT', root.parent / 'guitarpro-file-parser'))
        shutil.copyfile(parser_root / 'test/Wah.gp5', folder / 'Wah.gp5')
        (folder / 'broken.gp5').write_bytes(b'not a score')
        library = Library(Path(directory) / 'data')
        count, artifact = library.scan(default_parser(), folder)
        assert count == 2 and artifact.is_file()
        assert len(library.query(status='ok')) == 1
        assert len(library.query(status='error')) == 1
        library.scan(default_parser(), folder)
        assert len(library.query()) == 2
        window = tk.Tk()
        window.withdraw()
        ui = Desktop(window, library)
        window.update()
        assert len(ui.table.get_children()) == 2
        ui.status.set('error')
        assert len(ui.table.get_children()) == 1
        ui.table.selection_set(ui.table.get_children()[0])
        ui.select()
        assert 'error' in ui.details.get('1.0', 'end')
        window.destroy()
        process = subprocess.Popen([sys.executable, str(root / 'web_preview.py'),
                                    '--no-browser', '--data-dir', str(library.directory)],
                                   stdout=subprocess.PIPE, text=True, encoding='utf-8')
        try:
            url = process.stdout.readline().strip()
            origin, token = url.split('/#')
            def request(path, body=None, authenticated=True):
                headers = {'X-Library-Token': token} if authenticated else {}
                if body is not None:
                    headers['Content-Type'] = 'application/json'
                data = json.dumps(body).encode() if body is not None else None
                with urlopen(Request(origin + path, data=data, headers=headers), timeout=5) as response:
                    return response.read()
            assert b'Score library' in request('/')
            assert len(json.loads(request('/api/library'))['rows']) == 2
            assert len(json.loads(request('/api/library?status=error'))['rows']) == 1
            try:
                request('/api/library', authenticated=False)
                raise AssertionError('Unauthenticated request accepted')
            except HTTPError as error:
                assert error.code == 403
            request('/api/import', {'jsonl': artifact.read_text(encoding='utf-8')})
            for _ in range(100):
                state = json.loads(request('/api/state'))
                if not state['busy']:
                    break
                time.sleep(0.05)
            assert not state['busy'] and state['message'].startswith('Imported 2 records')
            assert len(json.loads(request('/api/library'))['rows']) == 2
        finally:
            process.terminate()
            process.wait(timeout=10)
            process.stdout.close()
    print('PASS: real parser, rescan, JSONL artifacts, SQLite, Tk widgets, web API, authentication, web import')


if __name__ == '__main__':
    main()
