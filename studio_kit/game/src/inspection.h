/* Read-only winner query. The build generates its compositor inclusion from renderer.h. */
enum { PROBE_MAX = 64 };
typedef struct {
    uint32_t kind, main, sub, map, cell_address, cell, tile, palette, pen, bits, flip, blend;
    uint32_t source_x, source_y, char_address, index, buffered;
} PixelContributor;
typedef struct {
    uint32_t x, y, field_x, field_y, zoom, width, height, count, truncated, matches, rgb, index;
    PixelContributor contributors[PROBE_MAX];
} PixelProbe;
static PixelProbe probe;
static unsigned probe_main, probe_sub, probe_buffered, probe_cell;
static void probe_put(PixelContributor p, int blend) {
    if (!blend) { probe.count = 0; probe.truncated = 0; }
    if (probe.count < PROBE_MAX) probe.contributors[probe.count++] = p;
    else probe.truncated = 1;
    probe.index = p.index;
}
static void probe_tile(int x, int y, unsigned tile, unsigned palette, unsigned pen, unsigned bits,
                       int blend, int fx, int fy, unsigned tx, unsigned ty, unsigned index) {
    if (x != (int)probe.field_x || y != (int)probe.field_y) return;
    PixelContributor p = {0}; p.kind = 2; p.main = probe_main; p.sub = probe_sub;
    p.cell_address = 0x04000000 + probe_sub * 4; p.cell = probe_cell; p.tile = tile; p.palette = palette; p.pen = pen;
    p.bits = bits; p.flip = (unsigned)fx | (unsigned)fy << 1; p.blend = (unsigned)blend;
    p.source_x = tx; p.source_y = ty; p.char_address = tile * 256 + ty * 16 + tx;
    p.index = index; p.buffered = probe_buffered; probe_put(p, blend);
}
static void probe_map(int x, int y, unsigned map, unsigned entry, unsigned cell, unsigned tile,
                      unsigned palette, unsigned pen, unsigned sx, unsigned sy) {
    if (x != (int)probe.field_x || y != (int)probe.field_y) return;
    PixelContributor p = {0}; p.kind = 3; p.map = map; p.cell_address = 0x04000000 + entry * 4;
    p.cell = cell; p.tile = tile; p.palette = cell & 511; p.pen = pen; p.bits = (cell & 512) ? 6 : 8;
    p.flip = (cell >> 12 & 1) | (cell >> 10 & 2); p.source_x = sx; p.source_y = sy;
    p.char_address = tile * 256 + sy * 16 + sx; p.index = palette | pen; probe_put(p, 0);
}
static void probe_score(int x, unsigned y, unsigned address, unsigned cell, unsigned tile,
                        unsigned palette, unsigned pen, unsigned sx, unsigned sy) {
    if (x != (int)probe.x || y != probe.y) return;
    PixelContributor p = {0}; p.kind = 4; p.cell_address = 0x05040000 + address; p.cell = cell;
    p.tile = tile; p.palette = palette / 16; p.pen = pen; p.bits = 4;
    p.flip = (cell >> 7 & 1) | (cell >> 5 & 2); p.source_x = sx; p.source_y = sy;
    p.char_address = (tile + 512) * 64 + sy * 8 + (sx / 2) * 2 + 1;
    p.index = palette + pen; probe_put(p, 0);
}
#include "inspection_renderer.h"
static InspectFrame inspect_frame;
API(eng_inspect_pixel) PixelProbe *eng_inspect_pixel(uint32_t x, uint32_t y) {
    if (!loaded || x >= VIDEO_WIDTH || y >= VIDEO_HEIGHT) return NULL;
    memset(&probe, 0, sizeof probe); probe.x = x; probe.y = y;
    probe.zoom = video_reg(&vm.machine, 27) & 255; if (probe.zoom > 128) probe.zoom = 128;
    probe.field_x = x * probe.zoom / 64; probe.field_y = y * probe.zoom / 64;
    probe.width = VIDEO_WIDTH * probe.zoom / 64; probe.height = VIDEO_HEIGHT * probe.zoom / 64;
    memcpy(inspect_frame.pixel, vf.pixel, sizeof vf.pixel);
    PixelContributor initial = {0};
    initial.kind = probe.field_x < probe.width && probe.field_y < probe.height ? 0 : 1;
    initial.index = initial.kind ? vf.pixel[probe.field_y * 1024 + probe.field_x] : 0;
    probe_put(initial, 0);
    int error = vm.error; uint64_t sprites = vm.sprites, blended = vm.blended, lines = vm.tile_lines;
    vm.error = 0; inspect_video_render(&vm, &inspect_frame, 0);
    vm.error = error; vm.sprites = sprites; vm.blended = blended; vm.tile_lines = lines;
    unsigned offset = (y * VIDEO_WIDTH + x) * 3;
    probe.matches = memcmp(inspect_frame.rgb + offset, vf.rgb + offset, 3) == 0;
    probe.rgb = (uint32_t)inspect_frame.rgb[offset] << 16 | (uint32_t)inspect_frame.rgb[offset + 1] << 8 | inspect_frame.rgb[offset + 2];
    return &probe;
}
