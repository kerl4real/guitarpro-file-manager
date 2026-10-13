"""Local web UI backend; also launched by the Tauri comparison shell."""
import argparse
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import secrets
import tempfile
import threading
from urllib.parse import parse_qs, urlparse
import webbrowser

from core import Library, default_directory, default_parser, open_score


def serve(library, port=0, launch=True):
    token = secrets.token_urlsafe(32)
    job = {'busy': False, 'message': 'Ready. Scan a folder or import JSONL.'}
    lock = threading.Lock()
    frontend = Path(__file__).parent / 'web'

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def send(self, value, status=200, content_type='application/json'):
            data = value if isinstance(value, bytes) else json.dumps(value).encode('utf-8')
            self.send_response(status)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(data)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.end_headers()
            self.wfile.write(data)

        def authorized(self):
            # Mutations require a per-session secret and same-origin requests.
            return self.headers.get('X-Library-Token') == token and self.headers.get('Origin', origin) == origin

        def do_GET(self):
            parsed = urlparse(self.path)
            if parsed.path in ('/', '/app.js', '/style.css'):
                name = {'/': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css'}[parsed.path]
                content_type = {'index.html': 'text/html; charset=utf-8', 'app.js': 'text/javascript; charset=utf-8', 'style.css': 'text/css; charset=utf-8'}[name]
                self.send((frontend / name).read_bytes(), content_type=content_type)
                return
            if not self.authorized():
                self.send({'error': 'Unauthorized'}, 403)
                return
            try:
                if parsed.path == '/api/library':
                    query = parse_qs(parsed.query)
                    get = lambda key, fallback='': query.get(key, [fallback])[0]
                    self.send({'rows': library.query(get('search'), get('format'), get('status'), get('sort', 'title'), get('descending') == 'true')})
                elif parsed.path == '/api/state':
                    with lock:
                        self.send({**job, 'parser': default_parser(), 'database': str(library.database)})
                else:
                    self.send({'error': 'Not found'}, 404)
            except (ValueError, OSError) as error:
                self.send({'error': str(error)}, 400)

        def do_POST(self):
            if not self.authorized():
                self.send({'error': 'Unauthorized'}, 403)
                return
            try:
                size = int(self.headers.get('Content-Length', '0'))
                if not 0 < size <= 32 * 1024 * 1024:
                    raise ValueError('Request must be between 1 byte and 32 MB')
                body = json.loads(self.rfile.read(size))
                if self.path == '/api/open':
                    path = body['path']
                    # Opening is restricted to records already in this library.
                    with library.connect() as db:
                        if not db.execute('SELECT 1 FROM scores WHERE path = ?', (path,)).fetchone():
                            raise ValueError('Score is not in this library')
                    open_score(path)
                    self.send({'message': 'Opened score'})
                    return
                if self.path not in ('/api/scan', '/api/import'):
                    self.send({'error': 'Not found'}, 404)
                    return
                with lock:
                    if job['busy']:
                        self.send({'error': 'An import is already running'}, 409)
                        return
                    job.update(busy=True, message='Working…')
                def operation():
                    try:
                        if self.path == '/api/scan':
                            def progress(count):
                                with lock:
                                    job['message'] = f'Extracted {count} records…'
                            count, artifact = library.scan(body['parser'], body['folder'], progress)
                        else:
                            scans = library.directory / 'scans'
                            scans.mkdir(exist_ok=True)
                            with tempfile.NamedTemporaryFile(mode='w', suffix='.jsonl', prefix='import-', dir=scans, encoding='utf-8', delete=False) as output:
                                output.write(body['jsonl'])
                                artifact = Path(output.name)
                            count = library.import_jsonl(artifact)
                        message = f'Imported {count} records · {artifact}'
                    except Exception as error:
                        message = f'Import failed: {error}'
                    with lock:
                        job.update(busy=False, message=message)
                threading.Thread(target=operation, daemon=True).start()
                self.send({'message': 'Started'})
            except (ValueError, KeyError, TypeError, OSError) as error:
                self.send({'error': str(error)}, 400)

    server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    origin = f'http://127.0.0.1:{server.server_port}'
    url = f'{origin}/#{token}'
    print(url, flush=True)
    if launch:
        webbrowser.open(url)
    try:
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--data-dir', default=str(default_directory()))
    parser.add_argument('--port', type=int, default=0)
    parser.add_argument('--no-browser', action='store_true')
    args = parser.parse_args()
    serve(Library(args.data_dir), args.port, not args.no_browser)
