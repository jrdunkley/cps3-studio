"""Find the game on this computer, so the Studio opens without asking for files the computer already holds.

Places, in order:
  1. folders the user chose before (remembered in the Studio's settings file);
  2. Fightcade: the folder its fcade:// link points at (Windows registry), else the usual install places, then
     the ROMs folder of its FBNeo emulator and every ROM folder FBNeo's settings name (szAppRomPaths);
  3. the Infinite client: a folder holding Infinite.exe with Infinite/roms (prepared ROMs) and Infinite/modes
     (one settings file per game mode), found in the user's usual folders and beside Fightcade or the Studio.

A set is two zips, sfiii3nr1.zip and sfiii3.zip, in one folder. The finder never opens a zip's contents: the page
recognises the game from the decrypted program it reads. Where a client leaves a marker beside its ROMs naming
the program it prepared (patched_program_sha256) and the archives it wrote, the hint is passed on only while the
archives still match it, so a half-finished update never names the wrong release.
Nothing here writes outside the settings file.
"""
import hashlib
import json
import os
from pathlib import Path
import sys
import threading
import time

ZIPS = ('sfiii3nr1.zip', 'sfiii3.zip')
CLIENT_MARKER = 'Infinite.exe'


def settings_path(override=None):
    """The Studio's own settings file (remembered folders)."""
    if override:
        return Path(override)
    if os.name == 'nt' and os.environ.get('APPDATA'):
        return Path(os.environ['APPDATA']) / 'CPS3 Studio' / 'settings.json'
    return Path(os.environ.get('XDG_CONFIG_HOME') or Path.home() / '.config') / 'cps3-studio' / 'settings.json'


def _read_json(path):
    try:
        return json.loads(Path(path).read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return None


def _file_sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def _children(folder):
    try:
        return [p for p in Path(folder).iterdir() if p.is_dir()]
    except OSError:
        return []


def _has_set(folder):
    folder = Path(folder)
    found = {}
    try:
        names = {p.name.lower(): p for p in folder.iterdir() if p.is_file()}
    except OSError:
        return None
    for name in ZIPS:
        if name not in names:
            return None
        found[name] = names[name]
    return found


def fightcade_roots():
    """Fightcade install folders: where its fcade:// link points, then the usual places."""
    roots = []
    if os.name == 'nt':
        try:
            import winreg
            for hive in (winreg.HKEY_CURRENT_USER, winreg.HKEY_CLASSES_ROOT):
                for key in (r'Software\Classes\fcade\shell\open\command', r'fcade\shell\open\command'):
                    try:
                        with winreg.OpenKey(hive, key) as k:
                            command = winreg.QueryValue(k, None)
                    except OSError:
                        continue
                    exe = command.split('"')[1] if command.startswith('"') else command.split(' ')[0]
                    exe = Path(exe)
                    roots.append((exe.parent.parent if exe.parent.name.lower() == 'emulator' else exe.parent, 'its fcade:// link'))
        except ImportError:
            pass
    home = Path.home()
    usual = [home / 'Documents' / 'Fightcade', home / 'Fightcade', home / 'Desktop' / 'Fightcade',
             home / 'Downloads' / 'Fightcade', Path(os.environ.get('LOCALAPPDATA', home)) / 'Programs' / 'Fightcade']
    if os.name == 'nt':
        for drive in 'CDEF':
            usual += [Path(drive + ':/Fightcade'), Path(drive + ':/Games/Fightcade')]
        usual += [Path(os.environ.get('ProgramFiles', 'C:/Program Files')) / 'Fightcade',
                  Path(os.environ.get('ProgramFiles(x86)', 'C:/Program Files (x86)')) / 'Fightcade']
    else:
        usual += [home / '.local' / 'share' / 'Fightcade', home / 'Games' / 'Fightcade']
    roots += [(p, 'the usual install place') for p in usual]
    # The Studio itself may sit inside a Fightcade folder.
    for parent in Path(__file__).resolve().parents:
        if (parent / 'emulator' / 'fbneo').is_dir():
            roots.append((parent, 'the folder around the Studio'))
            break
    seen, out = set(), []
    for root, why in roots:
        try:
            key = str(root.resolve()).lower()
        except OSError:
            continue
        if key not in seen and (root / 'emulator' / 'fbneo').is_dir():
            seen.add(key)
            out.append((root, why))
    return out


def fightcade_rom_folders(root):
    """FBNeo's own ROMs folder plus the ROM folders its settings list (relative to FBNeo's folder)."""
    fbneo = Path(root) / 'emulator' / 'fbneo'
    folders = [fbneo / 'ROMs']
    for ini in (fbneo / 'config' / 'fcadefbneo.ini',):
        try:
            text = ini.read_text(encoding='utf-8', errors='replace')
        except OSError:
            continue
        for line in text.splitlines():
            if line.startswith('szAppRomPaths['):
                value = line.split(']', 1)[1].strip()
                if value:
                    p = Path(value)
                    folders.append(p if p.is_absolute() else fbneo / p)
    return folders


def client_folders(extra=()):
    """Folders holding Infinite.exe with Infinite/roms, looked for two levels deep in the usual places."""
    home = Path.home()
    bases = [(home / 'Desktop', 2), (home / 'Downloads', 2), (home / 'Documents', 2), (home, 1), (home / 'Games', 2)]
    if os.name == 'nt':
        bases += [(Path(d + ':/Games'), 2) for d in 'CDE'] + [(Path(d + ':/'), 1) for d in 'CDE']
        one = os.environ.get('OneDrive')
        if one:
            bases += [(Path(one) / 'Desktop', 2), (Path(one) / 'Documents', 2)]
    bases += [(Path(p), 1) for p in extra]
    out, seen = [], set()

    def visit(folder, depth):
        try:
            key = str(folder.resolve()).lower()
        except OSError:
            return
        if key in seen:
            return
        seen.add(key)
        if (folder / CLIENT_MARKER).is_file() and (folder / 'Infinite' / 'roms').is_dir():
            out.append(folder)
            return
        if depth:
            for child in _children(folder):
                name = child.name.lower()
                if name.startswith(('.', '$')) or name in ('windows', 'program files', 'program files (x86)', 'programdata',
                                                        'appdata', 'node_modules', '__pycache__'):
                    continue
                visit(child, depth - 1)

    for base, depth in bases:
        if base.is_dir():
            visit(base, depth)
    return out


class Finder:
    """Thread-safe cache of the sets on this computer (refreshed on request, at most every few seconds)."""

    def __init__(self, settings=None):
        self.settings = settings_path(settings)
        self.lock = threading.Lock()
        self.cached = None
        self.when = 0
        self.hashes = {}

    # remembered folders
    def remembered(self):
        value = _read_json(self.settings) or {}
        return [f for f in value.get('romFolders', []) if isinstance(f, str)]

    def remember(self, folder):
        folder = str(Path(folder).resolve())
        value = _read_json(self.settings) or {}
        folders = [f for f in value.get('romFolders', []) if isinstance(f, str) and f.lower() != folder.lower()]
        value['romFolders'] = [folder] + folders[:7]
        self.settings.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.settings.with_suffix('.tmp')
        tmp.write_text(json.dumps(value, indent=2) + '\n', encoding='utf-8')
        os.replace(tmp, self.settings)
        self.cached = None

    # the game files the person confirmed on the first-run screen (the Studio asks once, then uses them)
    def confirmed(self):
        value = (_read_json(self.settings) or {}).get('gameFiles')
        return value if isinstance(value, dict) and isinstance(value.get('source'), str) else None

    def confirm(self, record):
        def text(key, limit=1024):
            v = record.get(key)
            return v[:limit] if isinstance(v, str) else None
        if not text('source', 64) or not re_id(text('source', 64)):
            raise ValueError('The confirmed game files need the game they hold.')
        kind = text('kind', 16)
        if kind not in ('fightcade', 'infinite', 'chosen', 'browser'):
            raise ValueError('Unknown kind of game files.')
        clean = {'source': text('source', 64), 'kind': kind, 'set': text('set', 64), 'folder': text('folder'),
                 'at': int(time.time())}
        value = _read_json(self.settings) or {}
        value['gameFiles'] = clean
        self.settings.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.settings.with_suffix('.tmp')
        tmp.write_text(json.dumps(value, indent=2) + '\n', encoding='utf-8')
        os.replace(tmp, self.settings)
        self.cached = None
        return clean

    def forget(self, folder):
        value = _read_json(self.settings) or {}
        value['romFolders'] = [f for f in value.get('romFolders', []) if f.lower() != str(folder).lower()]
        self.settings.parent.mkdir(parents=True, exist_ok=True)
        self.settings.write_text(json.dumps(value, indent=2) + '\n', encoding='utf-8')
        self.cached = None

    def _sha(self, path):
        st = path.stat()
        key = (str(path), st.st_size, st.st_mtime_ns)
        if key not in self.hashes:
            self.hashes[key] = _file_sha256(path)
        return self.hashes[key]

    def _hint(self, folder, files):
        """The program a client says it prepared here, while the archives still match its marker."""
        for marker in sorted(Path(folder).glob('*.json')):
            value = _read_json(marker)
            if not isinstance(value, dict) or not value.get('passed'):
                continue
            program, archives = value.get('patched_program_sha256') or value.get('program_sha256'), value.get('archives') or {}
            if not program or not all(isinstance(archives.get(n), str) for n in ZIPS):
                continue
            try:
                if all(self._sha(files[n]) == archives[n] for n in ZIPS):
                    return program
            except OSError:
                return None
        return None

    @staticmethod
    def _id(kind, folder):
        return kind + '-' + hashlib.sha1(str(folder).lower().encode('utf-8')).hexdigest()[:10]

    def _describe(self, kind, title, folder, files, why, settings=None, client=None):
        settings = settings or {}
        row = {'id': self._id(kind, folder), 'kind': kind, 'title': title, 'folder': str(folder), 'why': why,
               'files': {n: {'bytes': p.stat().st_size, 'modified': int(p.stat().st_mtime)} for n, p in files.items()},
               'settings': sorted(settings), 'program': self._hint(folder, files)}
        if client:
            row['client'] = str(client)
        return row, {**files, **settings}

    def scan(self, refresh=False):
        with self.lock:
            if self.cached and not refresh and time.time() - self.when < 5:
                return self.cached
            sets, paths, looked, seen = [], {}, [], set()

            def add(kind, title, folder, why, settings=None, client=None):
                files = _has_set(folder)
                key = str(Path(folder).resolve()).lower() if files else None
                if not files or key in seen:
                    return False
                seen.add(key)
                row, served = self._describe(kind, title, Path(folder).resolve(), files, why, settings, client)
                sets.append(row)
                paths[row['id']] = served
                return True

            for folder in self.remembered():
                found = add('chosen', 'Folder you chose', folder, 'you chose it')
                if not found and (Path(folder) / 'Infinite' / 'roms').is_dir():
                    found = self._client(add, Path(folder), 'you chose it')
                looked.append({'what': 'Folder you chose', 'where': folder, 'found': found})
            roots = fightcade_roots()
            for root, why in roots:
                hit = False
                for folder in fightcade_rom_folders(root):
                    hit = add('fightcade', 'Fightcade', folder, 'Fightcade at ' + str(root) + ' (' + why + ')') or hit
                looked.append({'what': 'Fightcade', 'where': str(Path(root) / 'emulator' / 'fbneo' / 'ROMs'), 'found': hit})
            if not roots:
                looked.append({'what': 'Fightcade', 'where': 'not installed (no fcade:// link, not in the usual places)', 'found': False})
            clients = client_folders([r for r, _ in roots] + [Path(__file__).resolve().parents[2]])
            for client in clients:
                hit = self._client(add, client, 'Infinite client at ' + str(client))
                looked.append({'what': 'Infinite', 'where': str(client / 'Infinite' / 'roms'), 'found': hit})
            if not clients:
                looked.append({'what': 'Infinite', 'where': 'no Infinite.exe in Desktop, Downloads, Documents or Games', 'found': False})
            self.cached = {'sets': sets, 'looked': looked, 'remembered': self.remembered(), 'settingsFile': str(self.settings),
                           'confirmed': self.confirmed()}
            self.paths = paths
            self.when = time.time()
            return self.cached

    def _client(self, add, client, why):
        modes = client / 'Infinite' / 'modes'
        settings = {}
        try:
            settings = {'modes/' + p.name: p for p in modes.iterdir() if p.is_file() and p.suffix.lower() == '.nv'}
        except OSError:
            pass
        return add('infinite', 'Infinite', client / 'Infinite' / 'roms', why, settings, client)

    def file(self, set_id, name):
        """The path of one served file of a found set (only the two zips and the client's mode settings)."""
        self.scan()
        files = getattr(self, 'paths', {}).get(set_id)
        if not files or name not in files:
            raise KeyError('Not found')
        return files[name]


def re_id(value):
    """A game source id as the Studio names them (original, infinite107, ...)."""
    return bool(value) and value.replace('_', '').isalnum() and value[0].isalpha()


def choose_folder(title='Where is your game? Choose the folder with sfiii3nr1.zip and sfiii3.zip'):
    """A native folder dialog on this computer (the person asked for it with a click). None if cancelled."""
    import tkinter
    from tkinter import filedialog
    root = tkinter.Tk()
    root.withdraw()
    root.attributes('-topmost', True)
    try:
        folder = filedialog.askdirectory(parent=root, title=title, mustexist=True)
    finally:
        root.destroy()
    return folder or None


def resolve_choice(folder):
    """A chosen folder may be the ROMs folder itself, a Fightcade folder or an Infinite client folder."""
    folder = Path(folder)
    for candidate in (folder, folder / 'roms', folder / 'ROMs', folder / 'emulator' / 'fbneo' / 'ROMs', folder / 'Infinite' / 'roms'):
        if _has_set(candidate):
            return candidate.parent.parent if candidate.parent.name == 'Infinite' and (candidate.parent.parent / CLIENT_MARKER).is_file() else candidate
    return None


if __name__ == '__main__':
    print(json.dumps(Finder(sys.argv[1] if len(sys.argv) > 1 else None).scan(), indent=2))
