/* CPS3 indexed compositor, implemented from decoded register behavior.
 * No FBNeo drawing code is compiled or included. Coordinates and sampling are integer-only. */
#ifndef NATIVE_CPS3_RENDERER_H
#define NATIVE_CPS3_RENDERER_H
#include "video_state.h"
enum { VIDEO_WIDTH = 384, VIDEO_HEIGHT = 224, VIDEO_RGB_SIZE = VIDEO_WIDTH * VIDEO_HEIGHT * 3 };
typedef struct { uint32_t pixel[1024 * 448]; uint8_t rgb[VIDEO_RGB_SIZE]; int width, height; } VideoFrame;
static int video_signed10(int n) { return ((n + 512) & 1023) - 512; }
static uint32_t video_reg(const Machine *m, unsigned index) { return rd_be(m->vreg, index * 4, 4); }
static uint32_t video_spr(const uint8_t *p, unsigned index) { return index < 0x20000 ? rd_be(p, index * 4, 4) : 0; }
static void video_tile(VideoMachine *v, VideoFrame *f, unsigned tile, unsigned palette, int fx, int fy, int x, int y, unsigned scale_x, unsigned scale_y, unsigned bits, int blend) {
    unsigned w = (scale_x * 16 + 32768) >> 16, h = (scale_y * 16 + 32768) >> 16;
    if (!w || !h) return;
    if (tile >= 32768) { v->error = 8; return; }
    unsigned dx = 1048576 / w, dy = 1048576 / h;
    int x0 = x < 0 ? 0 : x, y0 = y < 0 ? 0 : y;
    int x1 = x + (int)w, y1 = y + (int)h;
    if (x1 > f->width) x1 = f->width;
    if (y1 > f->height) y1 = f->height;
    for (int py = y0; py < y1; ++py) {
        unsigned ty = ((fy ? (int)h - 1 - (py - y) : py - y) * dy) >> 16;
        for (int px = x0; px < x1; ++px) {
            unsigned tx = ((fx ? (int)w - 1 - (px - x) : px - x) * dx) >> 16;
            uint8_t pen = v->machine.cram[(tile * 256 + ty * 16 + tx) ^ 3];
            if (!pen) continue;
            uint32_t *dst = &f->pixel[py * 1024 + px];
            if (!blend) *dst = (palette << bits) | pen;
            else if (bits == 6) *dst |= (pen & 15) << 13;
            else *dst |= ((pen & 1) << 15) | ((palette & 1) << 16);
        }
    }
}
static void video_map_line(VideoMachine *v, VideoFrame *f, int y, unsigned map) {
    Machine *m = &v->machine;
    uint32_t pos = video_reg(m, 8 + map * 4), flags = video_reg(m, 9 + map * 4), base = video_reg(m, 10 + map * 4);
    if (!(flags & 0x8000)) return;
    v->tile_lines++;
    unsigned line = (y + (pos & 65535) + 4) & 1023;
    unsigned scroll = pos >> 16;
    if (flags & 0x4000) scroll += (video_spr(m->spr, ((base >> 24) & 127) * 1024 + ((line + 16) & 1023)) >> 16) & 1023;
    unsigned row = ((line / 16 + 1) & 63) * 64, table = ((base >> 16) & 127) * 1024;
    for (unsigned column = 0; column < (unsigned)((f->width - 1) / 16 + 2); ++column) {
        uint32_t cell = video_spr(m->spr, table + row + ((column + scroll / 16) & 63));
        unsigned tile = cell >> 17, sy = line & 15;
        if (cell & 0x800) sy = 15 - sy;
        unsigned palette = (cell & 511) << ((cell & 512) ? 6 : 8);
        int left = (int)column * 16 - (int)(scroll % 16);
        for (int i = 0; i < 16; ++i) {
            int x = left + i;
            if (x < 0 || x >= f->width) continue;
            unsigned sx = (cell & 0x1000) ? 15 - i : i;
            uint8_t pen = m->cram[(tile * 256 + sy * 16 + sx) ^ 3];
            if (pen) f->pixel[y * 1024 + x] = palette | pen;
        }
    }
}
static void video_sprite_lists(VideoMachine *v, VideoFrame *f, int buffered) {
    Machine *m = &v->machine; const uint8_t *list = buffered ? v->list : m->spr;
    const unsigned tiles[4] = {8, 1, 2, 4};
    for (unsigned main = 0; main < 2048; main += 4) {
        uint32_t command = video_spr(list, main);
        if (command & 0x80000000) break;
        uint32_t origin = video_spr(list, main + 1), attr = video_spr(list, main + 2);
        uint32_t scroll = video_reg(m, (command >> 28) & 7);
        unsigned start = ((command & 0x7ff0) >> 4) * 64, count = ((command >> 16) & 511) * 4;
        for (unsigned sub = start; sub < start + count; sub += 4) {
            uint32_t cell = video_spr(list, sub), pos = video_spr(list, sub + 1), size = video_spr(list, sub + 2);
            unsigned yi = (size >> 2) & 3, xi = size & 3;
            if (!yi) continue;
            int ox = (origin >> 16) & 1023, oy = origin & 1023, gx = (scroll >> 16) & 1023, gy = scroll & 1023;
            int cx = (pos >> 16) & 1023, cy = pos & 1023;
            unsigned dw = ((size >> 16) & 127) + 1, dh = ((size >> 24) & 127) + 1;
            if (!xi) {
                for (unsigned row = 0; row < dh; ++row) {
                    int y = (~(cy + gy - (int)row) - 18) & 1023;
                    if (y < f->height) video_map_line(v, f, y, (size >> 4) & 3);
                }
                continue;
            }
            v->sprites++;
            unsigned nx = tiles[xi], ny = tiles[yi], sx = (dw << 16) / (nx * 16), sy = (dh << 16) / (ny * 16);
            int fx = !!(cell & 0x1000) ^ !!(attr & 0x10000000), fy = !!(cell & 0x800) ^ !!(attr & 0x08000000);
            cx += fx ? -(int)(dw / 2) : (int)(dw / 2);
            cx += fx ? (int)(((nx - 1) * 16 * sx) >> 16) : -(int)((nx * 16 * sx) >> 16);
            cy += dh / 2;
            if (fy) cy -= ((ny - 1) * 16 * sy) >> 16;
            unsigned pal = (attr & 0x20000000) ? (attr >> 16) & 511 : cell & 511;
            unsigned bits = ((attr & 0x40000000) ? attr & 0x02000000 : cell & 512) ? 6 : 8;
            int blend = !!((attr & 0x04000000) || (cell & 1024));
            if (blend) v->blended++;
            for (unsigned col = 0; col < nx; ++col) {
                int dx = (col * 16 * sx) >> 16;
                int x = video_signed10(ox + cx + (fx ? -dx : dx) + gx + 1);
                for (unsigned row = 0; row < ny; ++row) {
                    int dy = (row * 16 * sy) >> 16;
                    int y = video_signed10(1023 - (oy + cy + (fy ? dy : -dy) + gy) - 17);
                    video_tile(v, f, (cell >> 17) + col * ny + row, pal, fx, fy, x, y, sx, sy, bits, blend);
                }
            }
        }
    }
}
static void video_palette_rgb(const VideoMachine *v, unsigned index, uint8_t *dst) {
    if (index >= 0x20000) { dst[0] = dst[1] = dst[2] = 0; return; }
    memcpy(dst, v->colors[index], 3);
}
static void video_score(VideoMachine *v, VideoFrame *f) {
    Machine *m = &v->machine; unsigned bank = (v->ss_bank & 0x01000000) ? 0 : 2048;
    /* FBNeo redraws a whole 8x8 tile for each scanline's rowscroll; retain that ordering. */
    for (unsigned line = 0; line < 224; ++line) {
        unsigned row = line / 8, scroll = rd_be(m->ss, 0x4000 + ((line - 1) & 511) * 4, 4) >> 16;
        for (unsigned column = 0; column < 64; ++column) {
            uint32_t cell = rd_be(m->ss, (bank + row * 64 + column) * 4, 4);
            unsigned tile = (cell >> 16) & 511;
            if (!tile) continue;
            int left = (int)(column * 8) - (int)scroll;
            if (left < -7 || left > VIDEO_WIDTH - 8) continue;
            unsigned palette = (((cell & 63) >> 1) + (v->ss_palette << 5)) * 16;
            for (unsigned y = 0; y < 8; ++y) for (unsigned x = 0; x < 8; ++x) {
                unsigned px = (cell & 128) ? 7 - x : x, py = (cell & 64) ? 7 - y : y;
                /* Pixels are nibbles of zero/sign-extended 16-bit SS words. */
                unsigned b = m->ss[(tile + 512) * 64 + y * 8 + (x / 2) * 2 + 1];
                unsigned pen = (b >> ((x & 1) * 4)) & 15;
                int screen_x = left + (int)px;
                if (pen && screen_x >= 0 && screen_x < VIDEO_WIDTH)
                    video_palette_rgb(v, palette + pen, f->rgb + ((row * 8 + py) * VIDEO_WIDTH + screen_x) * 3);
            }
        }
    }
}
/* user-approved 2026-10-05 (Game Studio GM3): f->pixel is FBNeo's persistent intermediate bitmap.
 * DrvCps3Draw clears and draws only the zoomed field (rows 0..224*zoom/64-1, columns 0..384*zoom/64-1)
 * and samples row y*zoom/64, column x*zoom/64, so with zoom below 64 the last rows show earlier frames'
 * pixels and with zoom 0 every pixel comes from the bitmap's first one; the text layer is drawn whatever
 * the zoom. Keep one VideoFrame per machine for the whole run. Zoom 0 still returns -1 (no field drawn). */
static int video_render(VideoMachine *v, VideoFrame *f, int buffered) {
    unsigned zoom = video_reg(&v->machine, 27) & 255;
    if (zoom > 128) zoom = 128;
    f->width = VIDEO_WIDTH * zoom / 64; f->height = VIDEO_HEIGHT * zoom / 64;
    for (int y = 0; y < f->height; ++y) memset(f->pixel + y * 1024, 0, (size_t)f->width * sizeof *f->pixel);
    if (zoom) video_sprite_lists(v, f, buffered);
    for (unsigned y = 0; y < VIDEO_HEIGHT; ++y) for (unsigned x = 0; x < VIDEO_WIDTH; ++x)
        video_palette_rgb(v, f->pixel[(y * zoom / 64) * 1024 + x * zoom / 64], f->rgb + (y * VIDEO_WIDTH + x) * 3);
    video_score(v, f);
    return !zoom || v->error ? -1 : 0;
}
#endif
