"""Rebuild the bundled ROM-free emulator with Zig 0.16.0. No downloads are performed."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import inspection_codegen

HERE = Path(__file__).resolve().parent


def runtime_wasm(blob):
    """Remove only custom (including debug) sections; retain runtime sections exactly."""
    if blob[:8] != b'\0asm\x01\0\0\0':
        raise ValueError('Invalid WebAssembly header')
    result = bytearray(blob[:8])
    at = 8
    while at < len(blob):
        start, kind = at, blob[at]
        at += 1
        size, shift = 0, 0
        while True:
            n = blob[at]
            at += 1
            size |= (n & 127) << shift
            shift += 7
            if not n & 128:
                break
        end = at + size
        if end > len(blob):
            raise ValueError('Truncated WebAssembly section')
        if kind:
            result.extend(blob[start:end])
        at = end
    return bytes(result)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--zig', default='zig', help='path to the Zig executable')
    ap.add_argument('--check', action='store_true', help='compare with the bundled payload')
    a = ap.parse_args()
    flags = {'capture_output': True, 'text': True, 'check': True,
             'creationflags': getattr(subprocess, 'CREATE_NO_WINDOW', 0)}
    version = subprocess.run([a.zig, 'version'], **flags).stdout.strip()
    text = (HERE / 'engine_wasm.js').read_text(encoding='utf-8')
    meta = json.loads(re.search(r'g.Cps3GameWasm\s*=\s*(\{.*\});', text).group(1))
    if version != meta['zig']:
        raise RuntimeError(f"Expected Zig {meta['zig']}; found {version}")
    for name, digest in meta['sources'].items():
        path = HERE.parents[1] / name
        if hashlib.sha256(path.read_text(encoding='utf-8').encode('utf-8')).hexdigest() != digest:
            raise RuntimeError('Bundled source changed: ' + name)
    out = HERE / 'out'
    out.mkdir(exist_ok=True)
    inspection_codegen.generate(HERE / 'src/video/renderer.h', out / 'inspection_renderer.h')
    wasm = out / 'engine.wasm'
    env = dict(os.environ, ZIG_GLOBAL_CACHE_DIR=str(out / 'zig-cache'), ZIG_LOCAL_CACHE_DIR=str(out / 'zig-local'))
    subprocess.run([a.zig, 'cc', '-I', str(out), *meta['flags'], '-I', str(HERE / 'src/video'),
                    '-o', str(wasm), str(HERE / 'src/engine.c')], env=env, **flags)
    blob = runtime_wasm(wasm.read_bytes())
    wasm.write_bytes(blob)
    matches = blob == base64.b64decode(meta['base64'], validate=True)
    result = {'bytes': len(blob), 'sha256': hashlib.sha256(blob).hexdigest(), 'matchesBundled': matches,
              'zig': version, 'romInputs': 0}
    (out / 'build-report.json').write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(result))
    return int(a.check and not matches)


if __name__ == '__main__':
    sys.exit(main())
