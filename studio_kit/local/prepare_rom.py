"""Prepare this computer's own ROM so the Studio opens from disk without asking.

Writes rom.js beside this file from the two ROM zips. The file is private to this
computer: it is never packaged or published (the package allowlist and the public
scan both refuse studio_kit/local/rom.js). Delete it to get the welcome back.
Usage: python prepare_rom.py [folder holding sfiii3nr1.zip and sfiii3.zip]
"""
import base64
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
NAMES = ('sfiii3nr1.zip', 'sfiii3.zip')
CHUNK = 3 * 1024 * 1024  # a multiple of three bytes, so every piece decodes alone


def main():
    folder = Path(sys.argv[1]) if len(sys.argv) > 1 else Path.cwd()
    missing = [n for n in NAMES if not (folder / n).is_file()]
    if missing:
        sys.exit(f'Not found in {folder}: {", ".join(missing)}')
    out = HERE / 'rom.js'
    with out.open('w', encoding='ascii', newline='\n') as f:
        f.write('window.CPS3_LOCAL_ROM={};\n')
        for name in NAMES:
            data = (folder / name).read_bytes()
            f.write(f"CPS3_LOCAL_ROM['{name}']=[];\n")
            for p in range(0, len(data), CHUNK):
                f.write(f"CPS3_LOCAL_ROM['{name}'].push('{base64.b64encode(data[p:p + CHUNK]).decode()}');\n")
    print(f'Wrote {out} ({out.stat().st_size:,} bytes). The Studio will read it once, then use its own saved copy.')


if __name__ == '__main__':
    main()