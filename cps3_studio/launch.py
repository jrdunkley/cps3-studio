"""Start or reuse the local Studio workspace without a console window, and open it in its own window.

A Studio already serving the port is reused when it is this same Studio (same folder and build). An older or other
copy of the Studio on the port is asked to stop and replaced, so a launcher always opens the Studio it belongs to.

--open shows the Studio as an app window: a Chromium browser (the default browser when it is one, else Edge, Chrome,
Brave or Chromium) started with --app, so there is no tab strip, address bar or browser menu, only the Studio. The
window uses the browser's normal profile, so work the Studio keeps in browser storage is the same as in a tab. With
no Chromium browser, or with --tab, the Studio opens as a tab of the default browser instead.
"""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
from urllib.parse import unquote
from urllib.request import Request, urlopen
import webbrowser

from local_server import APP, BUILD, ROOT

HIDDEN = getattr(subprocess, 'CREATE_NO_WINDOW', 0)


def health(url):
    with urlopen(url + 'api/health', timeout=2) as response:
        state = json.load(response)
    if state.get('app') != APP:
        raise RuntimeError('This port belongs to another application.')
    return state


def listener_pid(port):
    """The process listening on 127.0.0.1:port (Windows netstat), for a Studio too old to stop on request."""
    try:
        out = subprocess.run(['netstat', '-ano', '-p', 'TCP'], capture_output=True, text=True, timeout=10, creationflags=HIDDEN).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    for line in out.splitlines():
        parts = line.split()
        if len(parts) >= 5 and parts[1] == f'127.0.0.1:{port}' and parts[3].upper() == 'LISTENING':
            return int(parts[4])
    return None


def stop(url, port, state):
    try:
        urlopen(Request(url + 'api/shutdown', data=b'{}', method='POST',
                        headers={'X-Studio-Request': '1', 'Content-Type': 'application/json'}), timeout=3).read()
    except OSError:
        pid = state.get('pid') or listener_pid(port)
        if pid:
            subprocess.run(['taskkill', '/PID', str(pid), '/F'], capture_output=True, creationflags=HIDDEN)
    for _ in range(40):
        try:
            health(url)
        except OSError:
            return
        time.sleep(.25)
    raise RuntimeError('An older Studio on this port did not stop; close it and start again.')


def _registry_default_browser():
    """The executable of the default http handler on Windows, or None."""
    if os.name != 'nt':
        return None
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r'Software\Microsoft\Windows\Shell\Associations\UrlAssociations\http\UserChoice') as k:
            prog = winreg.QueryValueEx(k, 'ProgId')[0]
        with winreg.OpenKey(winreg.HKEY_CLASSES_ROOT, prog + r'\shell\open\command') as k:
            command = winreg.QueryValue(k, None)
    except OSError:
        return None
    m = re.match(r'\s*"([^"]+)"|\s*(\S+)', command)
    return Path(m.group(1) or m.group(2)) if m else None


def chromium_browsers():
    """Installed Chromium browsers that can open an app window, the default browser first when it is one."""
    names = ('msedge.exe', 'chrome.exe', 'brave.exe', 'chromium.exe', 'vivaldi.exe')
    found = []
    if os.name == 'nt':
        default = _registry_default_browser()
        if default and default.name.lower() in names and default.is_file():
            found.append(default)
        bases = [os.environ.get(v) for v in ('ProgramFiles(x86)', 'ProgramFiles', 'LOCALAPPDATA')]
        rel = [r'Microsoft\Edge\Application\msedge.exe', r'Google\Chrome\Application\chrome.exe',
               r'BraveSoftware\Brave-Browser\Application\brave.exe', r'Chromium\Application\chrome.exe']
        found += [Path(b) / r for b in bases if b for r in rel]
    elif sys.platform == 'darwin':
        found += [Path(p) for p in ('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
                                     '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
                                     '/Applications/Chromium.app/Contents/MacOS/Chromium')]
    else:
        for n in ('microsoft-edge', 'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'brave-browser'):
            p = shutil.which(n)
            if p:
                found.append(Path(p))
    out, seen = [], set()
    for p in found:
        key = str(p).lower()
        if key not in seen and p.is_file():
            seen.add(key)
            out.append(p)
    return out


def open_window(page, tab=False):
    """Open the page as an app window (no browser chrome); fall back to a tab. Returns how it was opened."""
    if not tab:
        for exe in chromium_browsers():
            try:
                flags = 0
                if os.name == 'nt':
                    flags = getattr(subprocess, 'DETACHED_PROCESS', 0) | getattr(subprocess, 'CREATE_NEW_PROCESS_GROUP', 0)
                subprocess.Popen([str(exe), '--app=' + page, '--no-first-run', '--no-default-browser-check'],
                                 stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                 creationflags=flags, close_fds=True)
                return {'window': 'app', 'browser': str(exe)}
            except OSError:
                continue
    webbrowser.open(page)
    return {'window': 'tab', 'browser': 'default'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--projects', type=Path)
    parser.add_argument('--settings', type=Path)
    parser.add_argument('--logs', type=Path, required=True)
    parser.add_argument('--port', type=int, default=8787)
    parser.add_argument('--open', action='store_true', help='Open the Studio in its own window.')
    parser.add_argument('--tab', action='store_true', help='With --open: a tab of the default browser instead of a window.')
    parser.add_argument('--path', default='', help='The page to open, relative to the Studio (e.g. a deep link).')
    parser.add_argument('--url', default='', help='A cps3studio:// link (the registered protocol): cps3studio://open/<page>.')
    parser.add_argument('--private-data', action='store_true', help='Serve the workspace’s own music_editor/data.')
    args = parser.parse_args()
    if args.url:
        m = re.match(r'(?i)cps3studio:/*open/?(.*)$', args.url.strip())
        args.path = unquote(m.group(1)) if m else ''
    args.logs.mkdir(parents=True, exist_ok=True)
    url = f'http://127.0.0.1:{args.port}/'

    pid, replaced = None, None
    try:
        state = health(url)
        if state.get('build') != BUILD or state.get('root') != str(ROOT.resolve()) or bool(state.get('privateData')) != args.private_data:
            replaced = {'root': state.get('root'), 'build': state.get('build')}
            stop(url, args.port, state)
            raise OSError('replaced')
    except OSError:
        command = [sys.executable, str(Path(__file__).with_name('local_server.py')), '--port', str(args.port)]
        if args.projects:
            command += ['--projects', str(args.projects.resolve())]
        if args.settings:
            command += ['--settings', str(args.settings.resolve())]
        if args.private_data:
            command += ['--private-data']
        with (args.logs / 'server.stdout.log').open('ab') as stdout, (args.logs / 'server.stderr.log').open('ab') as stderr:
            process = subprocess.Popen(command, stdout=stdout, stderr=stderr, creationflags=HIDDEN)
        pid = process.pid
        for _ in range(60):
            try:
                health(url)
                break
            except OSError:
                if process.poll() is not None:
                    raise RuntimeError('Studio could not start; see server.stderr.log.')
                time.sleep(.25)
        else:
            raise RuntimeError('Studio did not become ready; see server.stderr.log.')
    page = url + re.sub(r'^/+', '', args.path)
    opened = open_window(page, args.tab) if args.open else None
    record = {'url': page, 'startedPid': pid, 'replaced': replaced, 'build': BUILD, 'root': str(ROOT.resolve()),
              'projects': str(args.projects.resolve()) if args.projects else None, 'opened': opened}
    (args.logs / 'launch.json').write_text(json.dumps(record, indent=2) + '\n', encoding='utf-8')


if __name__ == '__main__':
    main()
