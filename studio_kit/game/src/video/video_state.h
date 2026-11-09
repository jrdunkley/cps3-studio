/* Independently implemented CPS3 video bus/DMA extension. No changes to machine/. */
#ifndef NATIVE_VIDEO_STATE_H
#define NATIVE_VIDEO_STATE_H
#include "../machine/machine_core.h"
typedef struct {
    Machine machine; /* first: existing callbacks continue to receive Machine * */
    uint8_t list[0x80000];
    uint8_t colors[0x20000][3]; /* FBNeo conversion cache: DMA and word writes differ. */
    uint8_t *data; size_t data_size;
    uint32_t ss_bank, ss_palette, flash_bank, palette_source, palette_dest, fade, palette_length;
    uint64_t dma_modes[8], blended, sprites, tile_lines;
    int error;
} VideoMachine;
static void video_color(VideoMachine *v, unsigned index, unsigned c, int expand) {
    if (index >= 0x20000) { v->error = 7; return; }
    unsigned g = ((c >> 5) & 31) * 8;
    v->colors[index][0] = (c & 31) * 8;
    v->colors[index][1] = g | (expand ? (g >> 5) & 4 : 0);
    v->colors[index][2] = ((c >> 10) & 31) * 8;
}
static uint8_t video_source(VideoMachine *v, uint32_t a) {
    if (a >= v->data_size) { v->error = 1; return 0; }
    return v->data[a];
}
static void video_char_byte(VideoMachine *v, uint32_t a, uint8_t b) {
    v->machine.cram[(a & 0x7fffff) ^ 3] = b;
}
static unsigned video_rle6(VideoMachine *v, uint32_t dst, uint8_t b, uint8_t *last) {
    unsigned n = (b & 0x40) ? (b & 63) + 1 : 1;
    uint8_t pixel = (b & 0x40) ? *last & 63 : b;
    if (!(b & 0x40)) *last = b;
    for (unsigned i = 0; i < n && dst + i < 0x800000; ++i) video_char_byte(v, dst + i, pixel);
    return n;
}
static unsigned video_rle8(VideoMachine *v, uint32_t dst, uint8_t b, unsigned *last, unsigned *prior) {
    if (*last == *prior) {
        unsigned n = (b + 1) & 255;
        for (unsigned i = 0; i < n; ++i) video_char_byte(v, dst + i, (uint8_t)*last);
        *prior = 0xffff; return n;
    }
    *prior = *last; *last = b; video_char_byte(v, dst, b); return 1;
}
static void video_decompress(VideoMachine *v, unsigned mode, uint32_t src, uint32_t dst, uint32_t length) {
    uint32_t total = 0, budget = length * 4 + 4096;
    uint8_t last6 = 0; unsigned last8 = 0xfffe, prior8 = 0xffff;
    while (total < length && !v->error && budget--) {
        unsigned control = mode == 3 ? video_source(v, src++) : 0;
        unsigned tokens = mode == 3 ? 8 : 1;
        for (unsigned t = 0; t < tokens && total < length; ++t) {
            uint8_t token = video_source(v, src++);
            int lookup = mode == 3 ? !!(control & (128 >> t)) : !!(token & 128);
            unsigned count = lookup ? 2 : 1;
            for (unsigned j = 0; j < count; ++j) {
                uint8_t b = lookup ? video_source(v, v->machine.chardma_table + (token & 127) * 2 + j) : token;
                unsigned n = mode == 3 ? video_rle8(v, dst + total, b, &last8, &prior8)
                                      : video_rle6(v, dst + total, b, &last6);
                total += n;
                /* 8-bit table pairs always finish; 6-bit pairs stop at requested length. */
                if (mode != 3 && (total >= length || dst + total > 0x7fffff)) return;
            }
        }
    }
    if (!budget) v->error = 2;
}
static void video_char_dma(VideoMachine *v, uint32_t address) {
    Machine *m = &v->machine; m->char_dma++;
    for (unsigned i = 0; i < 0x1000; i += 3) {
        uint32_t a = 4 * (address + i);
        if (a + 12 > 0x800000) { v->error = 3; return; }
        uint32_t cmd = mc_le32(m->cram + a), dst = mc_le32(m->cram + a + 4) << 3;
        uint32_t src = (mc_le32(m->cram + a + 8) << 1) - 0x400000;
        if (cmd == 0x01000000) return;
        unsigned mode = (cmd >> 21) & 7; v->dma_modes[mode]++;
        uint32_t length = ((cmd & 0x1fffff) + 1) << 3;
        if (mode == 4) m->chardma_table = src;
        else if (mode == 2 || mode == 3) video_decompress(v, mode, src, dst, length);
        else if (mode == 0) {
            /* Uncompressed FBNeo path copies host-order destination bytes. */
            if (dst + length > 0x800000) { v->error = 4; return; }
            for (uint32_t j = 0; j < length; ++j) m->cram[dst + j] = video_source(v, (src + j) ^ 3);
        } else continue;
        set_irq(m, 10, 1);
    }
    v->error = 5;
}
static unsigned video_fade(unsigned c, unsigned f) {
    if (!(f & 64)) return c;
    return f & 32 ? 31 ^ (((31 ^ c) * ((~f) & 31)) >> 5) : (c * (f & 31)) >> 5;
}
static void video_write(Sh2 *s, uint32_t address, int size, uint32_t value) {
    VideoMachine *v = (VideoMachine *)s->user; Machine *m = &v->machine;
    uint32_t a = address & 0xc7ffffff;
    if (a - 0x04080000u < 0x40000u) {
        if (size == 2) { wr_be(m->pal, a - 0x04080000, size, value); video_color(v, (a - 0x04080000) / 2, value, 1); }
        return; /* FBNeo ignores palette byte/long writes */
    }
    if (a == 0x05050020 || a == 0x05050022 || (size == 1 && a >= 0x05050020 && a <= 0x05050023)) {
        unsigned shift = (4 - size - (a - 0x05050020)) * 8;
        if (size == 1 || size == 2) { uint32_t mask = (size == 1 ? 255u : 65535u) << shift; v->ss_bank = (v->ss_bank & ~mask) | (value << shift); }
        return;
    }
    if (a == 0x05050024 || (size == 1 && a == 0x05050025)) {
        if (size == 2) v->ss_palette = value;
        else if (size == 1) { unsigned shift = (1 - (a & 1)) * 8; v->ss_palette = (v->ss_palette & ~(255u << shift)) | (value << shift); }
        return;
    }
    if (size == 2) {
        if (a == 0x040c0082) {
            uint16_t old = m->spritelist_dma; m->spritelist_dma = (uint16_t)value;
            if ((value & 8) && !(old & 8)) {
                m->spr_dma++;
                for (unsigned i = 0; i < 0x2000; i += 16) {
                    memcpy(v->list + i, m->spr + i, 16);
                    uint32_t cmd = rd_be(m->spr, i, 4);
                    if (cmd & 0x80000000) break;
                    unsigned offset = (cmd & 0x7fff) * 16, n = ((cmd >> 16) & 511) * 16;
                    if (offset + n > sizeof v->list) { v->error = 6; return; }
                    memcpy(v->list + offset, m->spr + offset, n);
                }
            }
            return;
        }
        if (a == 0x040c0098) { if (value & 64) video_char_dma(v, m->chardma_source | ((value & 63) << 16)); return; }
        if (a == 0x040c0088) { v->flash_bank = value - 2; return; }
        if (a >= 0x040c00a0 && a <= 0x040c00ac) {
            uint32_t *reg = a < 0x040c00a4 ? &v->palette_source : a < 0x040c00a8 ? &v->palette_dest : a < 0x040c00ac ? &v->fade : &v->palette_length;
            if (a == 0x040c00ac) *reg = value;
            else { unsigned shift = (a & 2) ? 0 : 16; *reg = (*reg & ~(65535u << shift)) | (value << shift); }
            return;
        }
        if (a == 0x040c00ae) {
            if (value & 2) {
                m->pal_dma++;
                for (unsigned i = 0; i < v->palette_length; ++i) {
                    unsigned src = (v->palette_source - 0x200000 + i) * 2, dst = (v->palette_dest + i) * 2;
                    if (dst + 2 > sizeof m->pal) { v->error = 7; return; }
                    unsigned c = video_source(v, src) * 256 + video_source(v, src + 1);
                    unsigned r = video_fade(c & 31, v->fade >> 24), g = video_fade((c >> 5) & 31, v->fade >> 16), b = video_fade((c >> 10) & 31, v->fade);
                    unsigned faded = (c & 0x8000) | r | g * 32 | b * 1024;
                    wr_be(m->pal, dst, 2, faded); video_color(v, dst / 2, faded, 0);
                }
                set_irq(m, 10, 1);
            }
            return;
        }
    }
    io_wr(s, address, size, value);
}
static int video_load(VideoMachine *v, uint8_t *raw, size_t n, uint8_t *rom, uint8_t *bios, uint8_t *data, size_t data_size) {
    memset(v, 0, sizeof *v);
    if (machine_load(&v->machine, raw, n, rom, bios)) return -1;
    mc_dswap(v->list, raw + RAW_SPR + 0x80000, sizeof v->list);
    const uint8_t *tail = raw + n - 56;
    v->ss_bank = mc_le32(tail + 8); v->ss_palette = tail[12] | tail[13] << 8;
    v->flash_bank = mc_le32(tail + 22); v->palette_source = mc_le32(tail + 26);
    v->palette_dest = mc_le32(tail + 30); v->fade = mc_le32(tail + 34); v->palette_length = mc_le32(tail + 38);
    v->data = data; v->data_size = data_size; v->machine.cpu.io_wr = video_write;
    for (unsigned i = 0; i < 0x20000; ++i) video_color(v, i, rd_be(v->machine.pal, i * 2, 2), 1);
    return 0;
}
#endif
