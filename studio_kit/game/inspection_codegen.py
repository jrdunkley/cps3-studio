"""Instrument a second inclusion of the existing compositor for read-only pixel queries.

The canonical renderer remains unchanged. Only attribution callbacks are inserted;
the generated copy uses the same loops, clipping and sampling expressions. A changed
insertion site fails the build. This is source generation, never a second renderer.
"""
import re
from pathlib import Path


def generate(renderer: Path, output: Path):
    text = renderer.read_text(encoding='utf-8')
    text = text.replace('NATIVE_CPS3_RENDERER_H', 'CPS3_INSPECTION_RENDERER_H')
    text = text.replace('enum { VIDEO_WIDTH = 384, VIDEO_HEIGHT = 224, VIDEO_RGB_SIZE = VIDEO_WIDTH * VIDEO_HEIGHT * 3 };', '')
    text = re.sub(r'\bVideoFrame\b', 'InspectFrame', text)
    text = re.sub(r'\bvideo_(\w+)', r'inspect_video_\1', text)
    # Keep the canonical include name; all functions in the generated inclusion are private.
    text = text.replace('"inspect_video_state.h"', '"video_state.h"')
    substitutions = [
        ('            else *dst |= ((pen & 1) << 15) | ((palette & 1) << 16);',
         '            else *dst |= ((pen & 1) << 15) | ((palette & 1) << 16);\n'
         '            probe_tile(px, py, tile, palette, pen, bits, blend, fx, fy, tx, ty, *dst);'),
        ('            if (pen) f->pixel[y * 1024 + x] = palette | pen;',
         '            if (pen) { f->pixel[y * 1024 + x] = palette | pen;\n'
         '                probe_map(x, y, map, table + row + ((column + scroll / 16) & 63), cell, tile, palette, pen, sx, sy); }'),
        ('                    inspect_video_tile(v, f, (cell >> 17) + col * ny + row, pal, fx, fy, x, y, sx, sy, bits, blend);',
         '                    probe_main = main; probe_sub = sub; probe_buffered = buffered; probe_cell = cell;\n'
         '                    inspect_video_tile(v, f, (cell >> 17) + col * ny + row, pal, fx, fy, x, y, sx, sy, bits, blend);'),
        ('                if (pen && screen_x >= 0 && screen_x < VIDEO_WIDTH)\n'
         '                    inspect_video_palette_rgb(v, palette + pen, f->rgb + ((row * 8 + py) * VIDEO_WIDTH + screen_x) * 3);',
         '                if (pen && screen_x >= 0 && screen_x < VIDEO_WIDTH) {\n'
         '                    inspect_video_palette_rgb(v, palette + pen, f->rgb + ((row * 8 + py) * VIDEO_WIDTH + screen_x) * 3);\n'
         '                    probe_score(screen_x, row * 8 + py, (bank + row * 64 + column) * 4, cell, tile, palette, pen, x, y); }'),
    ]
    for old, new in substitutions:
        if text.count(old) != 1:
            raise RuntimeError('Renderer attribution insertion changed: ' + old[:80])
        text = text.replace(old, new)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text('/* Generated from the canonical renderer; see inspection_codegen.py. */\n' + text, encoding='utf-8')
