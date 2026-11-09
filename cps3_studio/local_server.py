"""Serve Studio with explicitly configured local character-project providers, and the game this computer holds.

The game: rom_finder.py finds sfiii3nr1.zip + sfiii3.zip (Fightcade's ROMs, the Infinite client, folders the person
chose) and this server hands them to the Studio's pages on this computer only, so a module opens without asking.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse
from urllib.request import urlopen
import webbrowser

APP = 'cps3-studio-local-v1'
ROOT = Path(__file__).resolve().parent.parent
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import rom_finder  # noqa: E402
sys.path.pop(0)
# The server's own identity: a launcher that finds an older or different Studio on the port replaces it.
BUILD = hashlib.sha256(b''.join((HERE / n).read_bytes() for n in ('local_server.py', 'rom_finder.py', 'launch.py')
                                if (HERE / n).is_file())).hexdigest()[:16]


class StudioServer(ThreadingHTTPServer):
    request_queue_size = 64
    daemon_threads = True


def load_projects(config):
    value = json.loads(config.read_text(encoding='utf-8'))
    projects = {}
    for item in value['projects']:
        if not re.fullmatch(r'[a-z0-9][a-z0-9_-]*', item['id']) or item['id'] in projects:
            raise ValueError('Project identifiers must be unique lowercase names.')
        path = (config.parent / item['provider']).resolve()
        spec = importlib.util.spec_from_file_location('studio_provider_' + item['id'].replace('-', '_'), path)
        module = importlib.util.module_from_spec(spec)
        sys.path.insert(0, str(path.parent))
        try:
            spec.loader.exec_module(module)
        finally:
            sys.path.pop(0)
        projects[item['id']] = (item['title'], module.Provider())
    default = value.get('defaultProject')
    if default not in projects:
        raise ValueError('Default project must be registered.')
    return projects, default


def handler_for(projects, default, source_root=ROOT, finder=None, private_data=False):
    # Never application source: ROM-derived data, songs, the local ROM pickup and caches anywhere, and a character
    # project's own folder directly inside a module (named after its id, '-' read as '_'), whose files are reached
    # only through its provider's API.
    hidden = {'data', 'songs', 'local', '__pycache__'}
    project_folders = set(projects) | {key.replace('-', '_') for key in projects}
    source_root = source_root.resolve()
    finder = finder or rom_finder.Finder()
    choosing = threading.Lock()
    # Work handed over by a page opened from disk (file://), kept here once until the app window collects it.
    handoffs, handoff_lock = {}, threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        def send(self, status, payload, mime='application/json', public=False):
            body = json.dumps(payload).encode('utf-8') if mime == 'application/json' else payload
            self.send_response(status)
            if public:
                # Read by Studio pages opened from disk (origin "null"), to find this app; it says nothing private.
                self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Content-Type', mime)
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.end_headers()
            self.wfile.write(body)

        def send_file(self, path, mime):
            size = path.stat().st_size
            self.send_response(200)
            self.send_header('Content-Type', mime)
            self.send_header('Content-Length', str(size))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.end_headers()
            with path.open('rb') as f:
                while chunk := f.read(1 << 20):
                    self.wfile.write(chunk)

        def local(self):
            return self.headers.get('Host') in (f'127.0.0.1:{self.server.server_port}', f'localhost:{self.server.server_port}')

        def project_route(self):
            parts = unquote(urlparse(self.path).path).split('/')
            if len(parts) < 5 or parts[1:3] != ['api', 'character-projects'] or parts[3] not in projects:
                raise KeyError('Unknown character project')
            return projects[parts[3]][1], '/'.join(parts[4:]), parse_qs(urlparse(self.path).query)

        def do_GET(self):
            if not self.local():
                return self.send(403, {'error': 'Local connections only.'})
            try:
                route = unquote(urlparse(self.path).path)
                if route == '/api/health':
                    return self.send(200, {'app': APP, 'build': BUILD, 'root': str(source_root), 'pid': os.getpid(), 'privateData': private_data, 'projects': sorted(projects)}, public=True)
                if route.startswith('/api/handoff/'):
                    with handoff_lock:
                        item = handoffs.pop(route[len('/api/handoff/'):], None)
                    if item is None:
                        raise KeyError('This hand-over was already collected.')
                    return self.send(200, item, 'application/json; charset=utf-8')
                if route == '/api/roms':
                    return self.send(200, finder.scan(refresh='refresh' in parse_qs(urlparse(self.path).query)))
                if route.startswith('/api/roms/'):
                    set_id, _, name = route[len('/api/roms/'):].partition('/')
                    path = finder.file(set_id, name)
                    return self.send_file(path, 'application/zip' if name.endswith('.zip') else 'application/octet-stream')
                if route == '/favicon.ico':
                    # The window's icon (the Studio mark); app windows and tabs show it beside the page title.
                    icon = source_root / 'cps3_studio' / 'icon.svg'
                    return self.send(200, icon.read_bytes(), 'image/svg+xml') if icon.is_file() else self.send(204, b'', 'image/x-icon')
                if route in ('/music_editor/data/pack.js', '/music_editor/data/library.js'):
                    # The owner's own workspace keeps a prepared sound pack and his arrangements there; a package has none.
                    data = source_root / route.lstrip('/')
                    if private_data and data.is_file():
                        return self.send_file(data, 'text/javascript; charset=utf-8')
                    return self.send(200, b'/* Use the locally imported ROM. */\n', 'text/javascript')
                if route == '/api/character-projects':
                    rows = []
                    for key, (title, provider) in projects.items():
                        row = {'id': key, 'title': title, 'api': '/api/character-projects/' + key}
                        if provider.effects:
                            row['effects'] = row['api'] + '/effects.js'
                        rows.append(row)
                    return self.send(200, {'defaultProject': default, 'projects': rows})
                if route.startswith('/api/character-projects/'):
                    provider, operation, query = self.project_route()
                    result = provider.get(operation, query)
                    if isinstance(result, tuple):
                        body, mime = result
                        return self.send(200, body, mime)
                    return self.send(200, result)
                if route in ('/', '/index.html', '/Open CPS3 Studio.html'):
                    route = '/cps3_studio/index.html'
                path = (source_root / route.lstrip('/')).resolve()
                # Only application source is served. Private character data uses
                # the provider's explicit API; arbitrary files cannot be requested.
                relative = path.relative_to(source_root)
                if relative.parts[0] not in {'art_editor', 'music_editor', 'move_editor', 'game_editor', 'studio_kit', 'cps3_studio'}:
                    raise KeyError('Not found')
                if any(part in hidden for part in relative.parts) or len(relative.parts) > 2 and relative.parts[1] in project_folders:
                    raise KeyError('Not found')
                mime = {'.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.md': 'text/plain'}.get(path.suffix)
                if not mime or not path.is_file():
                    raise KeyError('Not found')
                body = path.read_bytes()
                if mime == 'text/html':
                    # Pages served here say so (shell.served()), so they ask this server for the game and never send
                    # a request another server would refuse.
                    body = body.replace(b'<head>', b'<head><meta name="cps3-studio-server" content="' + BUILD.encode('ascii') + b'">', 1)
                return self.send(200, body, mime + '; charset=utf-8')
            except (KeyError, ValueError) as error:
                return self.send(404, {'error': str(error)})
            except Exception as error:
                return self.send(500, {'error': str(error)})

        def do_POST(self):
            if self.local() and unquote(urlparse(self.path).path) == '/api/handoff' and self.headers.get('Origin') in (None, 'null'):
                # A Studio page opened from disk hands its saved browser work to the app window (plain text, so no
                # preflight is needed); the app page collects it once with the token and keeps what it lacks.
                size = int(self.headers.get('Content-Length', '0') or 0)
                if not 0 < size < 512 * 1024 * 1024:
                    return self.send(400, {'error': 'Invalid hand-over size.'}, public=True)
                body = self.rfile.read(size)
                token = os.urandom(16).hex()
                with handoff_lock:
                    handoffs.clear()
                    handoffs[token] = body
                return self.send(200, {'token': token}, public=True)
            if not self.local() or self.headers.get('Origin') not in (None, f'http://127.0.0.1:{self.server.server_port}', f'http://localhost:{self.server.server_port}'):
                return self.send(403, {'error': 'Open this local Studio to save.'})
            try:
                route = unquote(urlparse(self.path).path)
                if route.startswith('/api/roms/') or route == '/api/shutdown':
                    # A custom header: pages of another origin cannot send it without a preflight this server refuses.
                    if self.headers.get('X-Studio-Request') != '1':
                        return self.send(403, {'error': 'Open this local Studio to choose a folder.'})
                    return self.send(200, self.roms_post(route))
                provider, operation, query = self.project_route()
                if self.headers.get('X-Studio-Token') != provider.token:
                    return self.send(403, {'error': 'Reload this Studio page before saving.'})
                size = int(self.headers.get('Content-Length', '0'))
                if not 0 < size < 2_000_000:
                    raise ValueError('Invalid request size.')
                body = json.loads(self.rfile.read(size))
                return self.send(200, provider.post(operation, body))
            except FileExistsError as error:
                return self.send(409, {'error': str(error)})
            except (KeyError, ValueError) as error:
                return self.send(400, {'error': str(error)})
            except Exception as error:
                return self.send(500, {'error': str(error)})

        def roms_post(self, route):
            size = int(self.headers.get('Content-Length', '0') or 0)
            body = json.loads(self.rfile.read(size)) if 0 < size < 65536 else {}
            if route == '/api/shutdown':
                threading.Thread(target=self.server.shutdown, daemon=True).start()
                return {'stopping': True}
            if route == '/api/roms/choose':
                if not choosing.acquire(blocking=False):
                    raise ValueError('A folder window is already open on this computer.')
                try:
                    folder = body.get('folder') or rom_finder.choose_folder()
                finally:
                    choosing.release()
                if not folder:
                    return {'cancelled': True, **finder.scan()}
                resolved = rom_finder.resolve_choice(folder)
                if not resolved:
                    raise ValueError(f'{folder} holds no sfiii3nr1.zip and sfiii3.zip (looked in it, its roms folder, '
                                     'Fightcade\\emulator\\fbneo\\ROMs and an Infinite client\'s Infinite\\roms).')
                finder.remember(resolved)
                return {'chosen': str(resolved), **finder.scan(refresh=True)}
            if route == '/api/roms/confirm':
                # The first-run screen: the person chose these game files (or files they picked in the page).
                finder.confirm(body)
                return finder.scan(refresh=True)
            if route == '/api/roms/forget':
                finder.forget(str(body.get('folder', '')))
                return finder.scan(refresh=True)
            raise KeyError('Unknown request')

        def log_message(self, fmt, *args):
            if args and str(args[1]) not in ('200', '304'):
                print(fmt % args, flush=True)

    return Handler


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--projects', type=Path, help='Character projects (JSON); without it the Studio serves no project.')
    parser.add_argument('--settings', type=Path, help='The Studio settings file (remembered game folders).')
    parser.add_argument('--private-data', action='store_true', help='Serve the workspace\'s own music_editor/data (prepared pack, arrangements).')
    parser.add_argument('--port', type=int, default=8787)
    parser.add_argument('--open', action='store_true')
    args = parser.parse_args()
    url = f'http://127.0.0.1:{args.port}/'
    try:
        with urlopen(url + 'api/health', timeout=1) as response:
            if json.load(response).get('app') == APP:
                if args.open:
                    webbrowser.open(url)
                return
    except OSError:
        pass
    projects, default = load_projects(args.projects.resolve()) if args.projects else ({}, None)
    server = StudioServer(('127.0.0.1', args.port), handler_for(projects, default, finder=rom_finder.Finder(args.settings), private_data=args.private_data))
    if args.open:
        webbrowser.open(url)
    server.serve_forever()


if __name__ == '__main__':
    main()
