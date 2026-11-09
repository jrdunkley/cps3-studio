/* Native CPS3 machine for sfiii3nr1: FBNeo savestates resumed in the native SH-2 interpreter
 * with FBNeo's CPS3 frame model (the reference emulator tree: src/burn/drv/cps3/cps3run.cpp and
 * src/cpu/sh2/sh2.cpp):
 *   - frame = 4 x Sh2Run(104166); after each slice cps_int10_cnt asserts IRQ10 every third slice;
 *     IRQ12 is asserted after the fourth slice. IRQ lines are level (ACK until acknowledged by
 *     writes to 05100000 / 05110000); asserting a line clears the speedhack suspend.
 *   - speedhack: a read of 0200D794 while FBNeo's PC is 06000884 (the task-0 poll of the task
 *     scheduler 06000860) suspends the CPU: the slice ends and following slices are skipped until
 *     an IRQ line is newly asserted.
 *   - cycles: one per loop iteration (the delay slot is its own iteration, eat_cycles 1) plus
 *     sh2.cpp's per-instruction extras and its two BUSY_LOOP_HACKS (DT/BF $-2 and BRA $/NOP).
 *     An overshoot at the end of a slice is discarded, as Sh2Run does; a delay slot whose branch
 *     ended the slice is charged to the next slice.
 *   - interrupts: FBNeo's CHECK_PENDING_IRQ points: at a newly asserted line (or, with a delay slot
 *     pending, after the slot) and after an iteration that set test_irq (LDC SR, LDC.L SR, RTE,
 *     sh2_recalc_irq). The highest of the external lines and the on-chip level is taken if above
 *     SR.I; external lines autovector 64 + level/2, the on-chip source uses its VCR vector.
 *   - on-chip free-running timer (sh2_timer_resync/activate/callback, sh2_recalc_irq,
 *     sh2_internal_r/w) on FBNeo's time base cycle_counts + cycles_to_run - icount. The timer is
 *     checked after every iteration (after the branch and after its slot), never during suspended
 *     slices; a late callback only sets a compare flag if FRC equals the compare value exactly.
 *   - I/O: the cps3Read and cps3Write handlers, sound register file (cps3snd), EEPROM, CRAM window,
 *     sprite/palette/SS RAM, IRQ acknowledges; DMA triggers assert IRQ10 (the copies themselves,
 *     outputs to CRAM/palette, are not modelled); decrypted BIOS at 0.
 * Validated by validate_episode.py against FBNeo-recorded traces.
 */
#ifndef MACHINE_CORE_H
#define MACHINE_CORE_H
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "sh2_machine.h"

enum {
    RAW_EEPROM = 0x0, RAW_MAIN = 0x400, RAW_SPR = 0x80400, RAW_SS = 0x180400, RAW_VREG = 0x190400,
    RAW_C000 = 0x190500, RAW_PAL = 0x190D00, RAW_CRAM = 0x1D0D00, RAW_DRV = 0x9D0D00, RAW_SIZE = RAW_DRV + 0xC2A,
    SLICE = 6250000 * 4 / 60 / 4,
};

typedef struct { uint32_t addr; uint8_t size, write; uint64_t count; uint32_t last; } IoStat;

typedef struct Machine {
    Sh2 cpu;
    uint8_t *bios; uint16_t snd_regs[16][16]; uint32_t snd_pos[16]; uint16_t snd_frac[16], snd_key; uint32_t bios_pc[8]; int nbios_pc;
    uint8_t *rom, ram[0x80000], ss[0x10000], spr[0x80000], pal[0x40000], vreg[0x100], c000[0x400];
    uint8_t *cram;                /* host order, 8 MiB (inside the loaded raw state) */
    uint8_t eeprom[0x400];        /* host order */
    uint32_t onchip[0x80];
    uint32_t pending; uint8_t line[17]; int suspend; int32_t int10_cnt;
    uint16_t input[4], eeprom_cur, spritelist_dma;
    uint32_t cram_bank, chardma_source, chardma_table;
    int carry;                    /* cycles of a delay slot owed to the next slice */
    /* FBNeo SH2 timer / interrupt state (struct SH2 fields of the same names) */
    uint16_t frc, ocra, ocrb, icr;
    uint32_t frc_base, timer_cycles, timer_base, cycle_counts, cycles_to_run;
    int32_t timer_active, internal_irq_level, internal_irq_vector, icount;
    int test_irq, check_now, in_step;
    uint64_t irq_taken[17], burns, steps, pal_dma, char_dma, spr_dma, slice_overruns, io_writes;
    uint64_t timer_callbacks, internal_irq_taken, onchip_unmodelled;
    int log_io_enabled;
    IoStat io[1024]; int nio;
} Machine;

static uint32_t mc_le32(const uint8_t *p) { return (uint32_t)p[0] | (uint32_t)p[1] << 8 | (uint32_t)p[2] << 16 | (uint32_t)p[3] << 24; }
static void mc_dswap(uint8_t *dst, const uint8_t *src, size_t n) { for (size_t i = 0; i < n; ++i) dst[i] = src[i ^ 3]; }
static uint32_t rd_be(const uint8_t *p, uint32_t o, int size) {
    return size == 1 ? p[o] : size == 2 ? (uint32_t)p[o] << 8 | p[o + 1]
         : (uint32_t)p[o] << 24 | (uint32_t)p[o + 1] << 16 | (uint32_t)p[o + 2] << 8 | p[o + 3];
}
static void wr_be(uint8_t *p, uint32_t o, int size, uint32_t v) {
    for (int i = 0; i < size; ++i) p[o + i] = (uint8_t)(v >> (8 * (size - 1 - i)));
}

static void log_io(Machine *m, uint32_t a, int size, int write, uint32_t v) {
    if (write) m->io_writes++;
    if (!m->log_io_enabled) return;
    for (int i = 0; i < m->nio; ++i)
        if (m->io[i].addr == a && m->io[i].size == size && m->io[i].write == write) { m->io[i].count++; m->io[i].last = v; return; }
    if (m->nio < 1024) { IoStat *e = &m->io[m->nio++]; e->addr = a; e->size = (uint8_t)size; e->write = (uint8_t)write; e->count = 1; e->last = v; }
}

/* Level of the interrupt the CPU would take now, or -1 (CHECK_PENDING_IRQ's choice, then sh2_exception's mask test). */
static int pending_level(const Machine *m, uint32_t sr) {
    int irq = -1;
    for (int i = 0; i < 16; ++i) if (m->pending & (1u << i)) irq = i;
    if (m->internal_irq_level != -1 && m->internal_irq_level > irq) irq = m->internal_irq_level;
    return irq < 0 || irq <= (int)((sr >> 4) & 15) ? -1 : irq;
}

/* CHECK_PENDING_IRQ + sh2_exception. */
static void check_irq(Machine *m) {
    Sh2 *s = &m->cpu;
    int irq = pending_level(m, s->sr);
    if (irq < 0) return;
    int internal = m->internal_irq_level == irq;
    uint32_t vector = internal ? (uint32_t)m->internal_irq_vector : (uint32_t)(64 + irq / 2);
    s->r[15] -= 4; sh2_wr(s, s->r[15], 4, s->sr);
    s->r[15] -= 4; sh2_wr(s, s->r[15], 4, s->pc);
    s->sr = (s->sr & ~0xF0u) | ((uint32_t)irq << 4);
    s->pc = sh2_rd(s, s->vbr + vector * 4, 4);
    if (internal) m->internal_irq_taken++; else m->irq_taken[irq]++;
}

/* Sh2SetIRQLine_Internal. Mid-instruction (an I/O write asserting a line) FBNeo checks at once; the
 * resulting state equals a check right after the step. With a delay slot pending it sets test_irq. */
static void set_irq(Machine *m, int line, int state) {
    if (m->line[line] == state) return;
    m->line[line] = (uint8_t)state;
    if (!state) { m->pending &= ~(1u << line); return; }
    m->pending |= 1u << line;
    if (m->carry) m->test_irq = 1;
    else if (m->in_step) m->check_now = 1;
    else check_irq(m);
    m->suspend = 0;
}

/* ---- SH7604 free-running timer (FBNeo sh2.cpp) ---- */
enum { FRT_ICF = 0x00800000, FRT_OCFA = 0x00080000, FRT_OCFB = 0x00040000, FRT_OVF = 0x00020000, FRT_CCLRA = 0x00010000 };
static const int frt_div[4] = {3, 5, 7, 0};

/* sh2_GetTotalCycles(). During a step icount is the value before the instruction; for a delayed
 * branch the branch's own cycles are already charged when its slot runs (the branch itself makes
 * no on-chip access). */
static uint32_t mc_now(const Machine *m) { return m->cycle_counts + m->cycles_to_run - (uint32_t)m->icount; }

static void frt_resync(Machine *m) {
    int divider = frt_div[(m->onchip[5] >> 8) & 3];
    uint64_t cur_time = mc_now(m);
    uint64_t add = (cur_time - (uint64_t)m->frc_base) >> divider;
    if (add > 0) {
        if (divider) m->frc = (uint16_t)(m->frc + add);
        m->frc_base = (uint32_t)cur_time;
    }
}

static void frt_activate(Machine *m) {
    int max_delta = 0xfffff;
    uint32_t m4 = m->onchip[4];
    m->timer_active = 0;
    uint16_t frc = m->frc;
    if (!(m4 & FRT_OCFA)) { uint16_t delta = (uint16_t)(m->ocra - frc); if (delta < max_delta) max_delta = delta; }
    if (!(m4 & FRT_OCFB) && (m->ocra <= m->ocrb || !(m4 & FRT_CCLRA))) { uint16_t delta = (uint16_t)(m->ocrb - frc); if (delta < max_delta) max_delta = delta; }
    if (!(m4 & FRT_OVF) && !(m4 & FRT_CCLRA)) { int delta = 0x10000 - frc; if (delta < max_delta) max_delta = delta; }
    if (max_delta != 0xfffff) {
        int divider = frt_div[(m->onchip[5] >> 8) & 3];
        if (divider) {
            max_delta <<= divider;
            m->frc_base = mc_now(m);
            m->timer_active = 1; m->timer_cycles = (uint32_t)max_delta; m->timer_base = m->frc_base;
        }
    }
}

static void mc_recalc_irq(Machine *m) {
    const uint32_t *r = m->onchip;
    int irq = 0, vector = -1, level;
    if ((r[4] >> 8) & r[4] & (FRT_ICF | FRT_OCFA | FRT_OCFB | FRT_OVF)) {
        level = (int)((r[0x18] >> 24) & 15);
        if (level > irq) {
            uint32_t mask = (r[4] >> 8) & r[4];
            irq = level;
            vector = (int)(mask & FRT_ICF ? (r[0x19] >> 8) & 0x7f : mask & (FRT_OCFA | FRT_OCFB) ? r[0x19] & 0x7f : (r[0x1a] >> 24) & 0x7f);
        }
    }
    if ((r[0x63] & 6) == 6) { level = (int)((r[0x38] >> 8) & 15); if (level > irq) { irq = level; vector = (int)((r[0x68] >> 24) & 0x7f); } }
    if ((r[0x67] & 6) == 6) { level = (int)((r[0x38] >> 8) & 15); if (level > irq) { irq = level; vector = (int)((r[0x6a] >> 24) & 0x7f); } }
    m->internal_irq_level = irq; m->internal_irq_vector = vector; m->test_irq = 1;
}

static void frt_callback(Machine *m) {
    m->timer_callbacks++;
    frt_resync(m);
    uint16_t frc = m->frc;
    if (frc == m->ocrb) m->onchip[4] |= FRT_OCFB;
    if (frc == 0x0000) m->onchip[4] |= FRT_OVF;
    if (frc == m->ocra) { m->onchip[4] |= FRT_OCFA; if (m->onchip[4] & FRT_CCLRA) m->frc = 0; }
    mc_recalc_irq(m);
    frt_activate(m);
}

/* Sh2Run's timer check after an iteration (DMA timers: none are active, machine_load refuses them). */
static void frt_check(Machine *m) {
    if (m->timer_active && mc_now(m) - m->timer_base >= m->timer_cycles) frt_callback(m);
}

/* sh2_internal_w(offset, data, mem_mask): mem_mask bits set are preserved. The DMA controller is not
 * modelled: writes that could start a transfer are counted in onchip_unmodelled. */
static void onchip_w(Machine *m, uint32_t off, uint32_t data, uint32_t mask) {
    uint32_t *r = m->onchip, old = r[off];
    const uint32_t flags = FRT_ICF | FRT_OCFA | FRT_OCFB | FRT_OVF;
    r[off] = (r[off] & mask) | (data & ~mask);
    switch (off) {
    case 0x04:
        if ((mask & 0x00ffffff) != 0xffffff) frt_resync(m);
        r[4] = (r[4] & ~flags) | (old & r[4] & flags);
        m->frc = (uint16_t)((m->frc & mask) | (data & ~mask));
        if ((mask & 0x00ffffff) != 0xffffff) frt_activate(m);
        mc_recalc_irq(m);
        break;
    case 0x05:
        frt_resync(m);
        if (r[5] & 0x10) m->ocrb = (uint16_t)((m->ocrb & (mask >> 16)) | ((data & ~mask) >> 16));
        else m->ocra = (uint16_t)((m->ocra & (mask >> 16)) | ((data & ~mask) >> 16));
        frt_activate(m);
        break;
    case 0x18: case 0x19: case 0x1a: case 0x43: case 0x68: case 0x6a:
        mc_recalc_irq(m);
        break;
    case 0x41: {
        int32_t a = (int32_t)r[0x41], b = (int32_t)r[0x40];
        if (b && !(a == INT32_MIN && b == -1)) { r[0x45] = (uint32_t)(a / b); r[0x44] = (uint32_t)(a % b); }
        else if (b) m->onchip_unmodelled++;      /* host trap in FBNeo */
        else { r[0x42] |= 0x00010000; r[0x45] = 0x7fffffff; r[0x44] = 0x7fffffff; mc_recalc_irq(m); }
        break;
    }
    case 0x42:
        r[0x42] = (r[0x42] & ~0x00001000u) | (old & r[0x42] & 0x00010000u);   /* sic (sh2.cpp) */
        mc_recalc_irq(m);
        break;
    case 0x45: {
        int64_t a = (int64_t)((uint64_t)r[0x45] | (uint64_t)r[0x44] << 32), b = (int32_t)r[0x40];
        if (b && !(a == INT64_MIN && b == -1)) {
            int64_t q = a / b;
            if (q != (int32_t)q) { r[0x42] |= 0x00010000; r[0x45] = 0x7fffffff; r[0x44] = 0x7fffffff; mc_recalc_irq(m); }
            else { r[0x45] = (uint32_t)q; r[0x44] = (uint32_t)(a % b); }
        } else if (b) m->onchip_unmodelled++;
        else { r[0x42] |= 0x00010000; r[0x45] = 0x7fffffff; r[0x44] = 0x7fffffff; mc_recalc_irq(m); }
        break;
    }
    case 0x62: case 0x66: r[off] &= 0xffffff; break;
    case 0x63: case 0x67: r[off] = (r[off] & ~2u) | (old & r[off] & 2u); m->onchip_unmodelled++; break;
    case 0x6c: r[0x6c] = (r[0x6c] & ~6u) | (old & r[0x6c] & 6u); m->onchip_unmodelled++; break;
    default: break;
    }
}

/* sh2_internal_r(offset). */
static uint32_t onchip_r(Machine *m, uint32_t off) {
    const uint32_t *r = m->onchip;
    switch (off) {
    case 0x04: frt_resync(m); return (r[4] & 0xffff0000u) | m->frc;
    case 0x05: return (uint32_t)(r[5] & 0x10 ? m->ocrb : m->ocra) << 16 | (r[5] & 0xffff);
    case 0x06: return (uint32_t)m->icr << 16;
    case 0x38: return (r[0x38] & 0x7fffffffu) | 0x80000000u;
    case 0x78: return r[0x78] & 0x7fff;
    case 0x41: case 0x47: return r[0x45];
    case 0x46: return r[0x44];
    }
    return r[off];
}

/* CRAM through the 0x04100000 window (bank-mapped MAP_RAM, host-order dwords). */
static uint8_t *cram_byte(Machine *m, uint32_t off) { return m->cram + (m->cram_bank << 20) + (off ^ 3); }

static void char_dma(Machine *m, uint32_t address) {
    m->char_dma++;
    for (uint32_t i = 0; i < 0x1000; i += 3) {
        uint32_t d1 = mc_le32(m->cram + 4 * ((i + address) & 0x1FFFFF));
        uint32_t d3 = mc_le32(m->cram + 4 * ((i + 2 + address) & 0x1FFFFF));
        if (d1 == 0x01000000) break;
        switch (d1 & 0x00E00000) {
        case 0x00800000: m->chardma_table = (d3 << 1) - 0x400000; set_irq(m, 10, 1); break;
        case 0x00400000: case 0x00600000: case 0x00000000: set_irq(m, 10, 1); break;   /* copies not modelled (outputs) */
        default: break;
        }
    }
}

static uint32_t io_rd(Sh2 *s, uint32_t a, int size) {
    Machine *m = (Machine *)s->user;
    uint32_t v = 0;
    if (a >= 0xE0000000u) {                             /* Sh2InnerRead{Byte,Word,Long} */
        uint32_t w = onchip_r(m, (a & 0x1FC) >> 2);
        v = size == 4 ? w : size == 2 ? (w >> (((~a) & 2) * 8)) & 0xFFFF : (w >> (((~a) & 3) * 8)) & 0xFF;
        log_io(m, a, size, 0, v); return v;
    }
    uint32_t x = a & 0xC7FFFFFFu;
    if (x - 0x02000000u < 0x80000u) return rd_be(m->ram, x - 0x02000000u, size);
    if (x - 0x06000000u < 0x1000000u) return rd_be(m->rom, x - 0x06000000u, size);
    if (x - 0x05040000u < 0x10000u) return rd_be(m->ss, x - 0x05040000u, size);
    if (x - 0x04000000u < 0x80000u) return rd_be(m->spr, x - 0x04000000u, size);
    if (x - 0x04080000u < 0x40000u) return rd_be(m->pal, x - 0x04080000u, size);
    if (x - 0x04100000u < 0x100000u) { uint32_t o = x - 0x04100000u; for (int i = 0; i < size; ++i) v = v << 8 | *cram_byte(m, o + i); log_io(m, a & ~0xFFFFu, size, 0, v); return v; }
    if (x - 0xC0000000u < 0x400u) return rd_be(m->c000, x - 0xC0000000u, size);
    if (x < 0x80000u) {
        int k; for (k = 0; k < m->nbios_pc && m->bios_pc[k] != s->cur; ++k) {}
        if (k == m->nbios_pc && k < 8) m->bios_pc[m->nbios_pc++] = s->cur;
        log_io(m, 0, size, 0, 0); return rd_be(m->bios, x, size);
    }
    if (x - 0x040E0000u < 0x300u) {                     /* cps3SndReadWord: register file + key */
        uint32_t o = x & 0x3FF;
        if (size == 2) v = o < 0x200 ? m->snd_regs[o >> 5][(o & 0x1F) >> 1] : o == 0x200 ? m->snd_key : 0;
        log_io(m, size == 2 ? 0x040E0000u : x, size, 0, v); return v;
    }
    if (size == 2) {                                    /* cps3ReadWord */
        switch (x) {
        case 0x05000000: v = (uint16_t)~m->input[1]; break;
        case 0x05000002: v = (uint16_t)~m->input[0]; break;
        case 0x05000004: v = (uint16_t)~m->input[3]; break;
        case 0x05000006: v = (uint16_t)~m->input[2]; break;
        default:
            if (x >= 0x05000A00u && x < 0x05000A20u) v = 0xFFFF;
            else if (x >= 0x05001000u && x < 0x05001204u) {
                uint32_t o = x - 0x05001000u;
                if (o >= 0x100 && o < 0x180) { uint32_t k = ((o - 0x100) >> 1) ^ 1; m->eeprom_cur = (uint16_t)(m->eeprom[2 * k] | m->eeprom[2 * k + 1] << 8); }
                else if (o == 0x202) v = m->eeprom_cur;
            }
        }
    } else if (size == 4 && x == 0x04200000u) v = 0x0404ADAD;   /* cps3ReadLong; cps3ReadByte returns 0 */
    log_io(m, (x >= 0x05001000u && x < 0x05001204u) ? 0x05001000u : x, size, 0, v);
    return v;
}

static void io_wr(Sh2 *s, uint32_t a, int size, uint32_t v) {
    Machine *m = (Machine *)s->user;
    if (a >= 0xE0000000u) {                             /* Sh2InnerWrite{Byte,Word,Long} */
        uint32_t off = (a & 0x1FC) >> 2;
        if (size == 4) onchip_w(m, off, v, 0);
        else if (size == 2) { uint32_t sh = ((~a) & 2) * 8; onchip_w(m, off, (v & 0xFFFF) << sh, ~(0xFFFFu << sh)); }
        else { uint32_t sh = ((~a) & 3) * 8; onchip_w(m, off, (v & 0xFF) << sh, ~(0xFFu << sh)); }
        log_io(m, a, size, 1, v); return;
    }
    uint32_t x = a & 0xC7FFFFFFu;
    if (x - 0x05040000u < 0x10000u) { wr_be(m->ss, x - 0x05040000u, size, v); return; }
    if (x - 0x04000000u < 0x80000u) { m->io_writes++; wr_be(m->spr, x - 0x04000000u, size, v); return; }
    if (x - 0x04080000u < 0x40000u) { m->io_writes++; wr_be(m->pal, x - 0x04080000u, size, v); return; }
    if (x - 0x04100000u < 0x100000u) { uint32_t o = x - 0x04100000u; for (int i = 0; i < size; ++i) *cram_byte(m, o + i) = (uint8_t)(v >> (8 * (size - 1 - i))); log_io(m, a & ~0xFFFFu, size, 1, v); return; }
    if (x - 0xC0000000u < 0x400u) { if (size == 4) wr_be(m->c000, x - 0xC0000000u, 4, v); log_io(m, 0xC0000000u, size, 1, v); return; }
    if (x - 0x040E0000u < 0x300u) {                     /* cps3SndWriteWord */
        uint32_t o = x & 0x3FF;
        log_io(m, size == 2 ? 0x040E0000u : x, size, 1, v);
        if (size != 2) return;
        if (o < 0x200) m->snd_regs[o >> 5][(o & 0x1F) >> 1] = (uint16_t)v;
        else if (o == 0x200) { for (int i = 0; i < 16; ++i) if (!(m->snd_key & (1 << i)) && (v & (1u << i))) { m->snd_pos[i] = 0; m->snd_frac[i] = 0; } m->snd_key = (uint16_t)v; }
        return;
    }
    log_io(m, (x >= 0x05001000u && x < 0x05001204u) ? 0x05001000u : x, size, 1, v);
    if (size != 2) return;                               /* cps3WriteByte: SS bank only; WriteLong: no-op */
    switch (x) {
    case 0x040C0080: case 0x040C0084: break;   /* user-approved 2026-10-05: FBNeo cps3WriteWord ignores these (Game Studio GM3) */
    case 0x040C0082: { uint16_t prev = m->spritelist_dma; m->spritelist_dma = (uint16_t)v; if ((v & 8) && !(prev & 8)) m->spr_dma++; break; }
    case 0x040C0086: m->cram_bank = v & 7; break;
    case 0x040C0096: m->chardma_source = v; break;
    case 0x040C0098: if (v & 0x40) char_dma(m, m->chardma_source | ((v & 0x3F) << 16)); break;
    case 0x040C00AE: if (v & 2) { m->pal_dma++; set_irq(m, 10, 1); } break;   /* palette copy (output) not modelled */
    case 0x05100000: set_irq(m, 12, 0); break;
    case 0x05110000: set_irq(m, 10, 0); break;
    default:
        if (x >= 0x040C0000u && x < 0x040C0100u) wr_be(m->vreg, x & 0xFF, 2, v);
        else if (x >= 0x05001000u && x < 0x05001204u) {
            uint32_t o = x - 0x05001000u;
            if (o >= 0x080 && o < 0x100) { uint32_t k = ((o - 0x080) >> 1) ^ 1; m->eeprom[2 * k] = (uint8_t)v; m->eeprom[2 * k + 1] = (uint8_t)(v >> 8); }
        }
    }
}

static void mc_on_access(Sh2 *s, uint32_t ea, int size, int write, uint32_t v) {
    (void)size; (void)v;
    Machine *m = (Machine *)s->user;
    if (!write && ea == 0x0200D794u && s->pc == 0x06000884u && !s->in_slot) { m->suspend = 1; m->burns++; }
}

static int is_delayed(uint16_t op) {
    if ((op & 0xF0FF) == 0x0003 || (op & 0xF0FF) == 0x0023 || op == 0x000B || op == 0x002B) return 1;   /* BSRF BRAF RTS RTE */
    if ((op & 0xF0FF) == 0x400B || (op & 0xF0FF) == 0x402B) return 1;                                   /* JSR JMP */
    if ((op & 0xFF00) == 0x8D00 || (op & 0xFF00) == 0x8F00) return 1;                                   /* BT/S BF/S */
    return (op >> 12) == 0xA || (op >> 12) == 0xB;                                                        /* BRA BSR */
}

/* sh2.cpp cycles beyond eat_cycles for one iteration executing `op` (taken: conditional branch taken). */
static int op_extra(uint16_t op, int taken) {
    switch (op >> 12) {
    case 0x0:
        if ((op & 0xF0FF) == 0x0003 || (op & 0xF0FF) == 0x0023) return 1;   /* BSRF BRAF */
        if (op == 0x000B) return 1;                                         /* RTS */
        if (op == 0x002B) return 3;                                         /* RTE */
        if (op == 0x001B) return 2;                                         /* SLEEP */
        if ((op & 0xF) == 0x7) return 1;                                    /* MUL.L */
        if ((op & 0xF) == 0xF) return 2;                                    /* MAC.L */
        return 0;
    case 0x3:
        if ((op & 0xF) == 0xD || (op & 0xF) == 0x5) return 1;               /* DMULS.L DMULU.L */
        return 0;
    case 0x4:
        if ((op & 0xF) == 0xF) return 2;                                    /* MAC.W */
        switch (op & 0xFF) {
        case 0x0B: return 1;                                                /* JSR */
        case 0x07: case 0x17: case 0x27: return 2;                          /* LDC.L @Rm+,SR/GBR/VBR */
        case 0x03: case 0x13: case 0x23: return 1;                          /* STC.L SR/GBR/VBR,@-Rn */
        case 0x1B: return 3;                                                /* TAS.B */
        }
        return 0;
    case 0x8:
        if ((op & 0xFF00) == 0x8900 || (op & 0xFF00) == 0x8B00) return taken ? 2 : 0;   /* BT BF */
        if ((op & 0xFF00) == 0x8D00 || (op & 0xFF00) == 0x8F00) return taken ? 1 : 0;   /* BT/S BF/S */
        return 0;
    case 0xA: case 0xB: return 1;                                           /* BRA BSR */
    case 0xC:
        switch (op & 0xFF00) {
        case 0xCC00: case 0xCD00: case 0xCE00: case 0xCF00: return 2;       /* TST/AND/XOR/OR.B #imm,@(R0,GBR) */
        case 0xC300: return 7;                                              /* TRAPA */
        }
        return 0;
    }
    return 0;
}

static int cond_taken(uint16_t op, uint32_t sr) {
    switch (op & 0xFF00) {
    case 0x8900: case 0x8D00: return (sr & SH2_T) != 0;
    case 0x8B00: case 0x8F00: return (sr & SH2_T) == 0;
    }
    return 0;
}

/* Hook for the shadow harness: cycles executed by nested original runs inside the last step. */
static int mc_nested_cycles;

/* LDC Rm,SR / LDC.L @Rm+,SR / RTE set test_irq. */
static int sets_test_irq(uint16_t op) { return (op & 0xF0FF) == 0x400E || (op & 0xF0FF) == 0x4007 || op == 0x002B; }

/* End of an FBNeo loop iteration that is not a pending branch: the test_irq check, then the
 * iteration's cycles, then the timer check. */
static void end_iteration(Machine *m, int cost) {
    if (m->test_irq || m->check_now) { check_irq(m); m->test_irq = 0; m->check_now = 0; }
    m->icount -= cost;
    frt_check(m);
}

/* One Sh2Run(cycles). A step executes a branch and its delay slot together; FBNeo's separate
 * iterations are reproduced around it (the branch's cycles and timer check before the step, the
 * slot's after). When the branch iteration ends the slice, the slot itself (and the call or jump
 * that follows it) runs at the start of the next Sh2Run, as in FBNeo: RAM at a frame boundary
 * does not yet contain the slot's store (replay rp_1790697929242_3177 frame 88, 020283A3). Returns
 * -1 on a fault. */
static int run_slice(Machine *m, int cycles) {
    Sh2 *s = &m->cpu;
    m->cycles_to_run = (uint32_t)cycles; m->icount = cycles;
    if (m->carry) {                                   /* the slot of the branch that ended the last slice */
        int cost = m->carry; m->carry = 0;
        if (s->pend) {                                /* it runs now, as FBNeo's next Sh2Run starts with it */
            mc_nested_cycles = 0;
            m->in_step = 1;
            sh2_resume_slot(s);
            m->in_step = 0;
            if (s->fault) return -1;
            cost += mc_nested_cycles;
        }
        end_iteration(m, cost);
    }
    while (m->icount > 0) {
        if (m->suspend) { m->icount = 0; break; }     /* speedhack: the rest of the slice is burnt */
        uint32_t pc = s->pc;
        uint16_t op = sh2_fetch(s, pc);
        int taken = cond_taken(op, s->sr), delayed = is_delayed(op);
        /* sh2.cpp BFS/BTS set a delay only when taken: a BT/S or BF/S that falls through is an
         * ordinary iteration (IRQ test and timer check after it), and so is the next instruction
         * (sh2_step runs it alone under fbneo_slots). Replay rp_1751070887559_8844 frame 191: FBNeo
         * entered the timer handler (06000740) between BF/S 060B9B7A (not taken) and 060B9B7C
         * (pushed PC 060B9B7C, R1 before the ADD); the atomic step pushed 060B9B7E. */
        if (((op & 0xFF00) == 0x8D00 || (op & 0xFF00) == 0x8F00) && !taken) delayed = 0;
        uint16_t slot = delayed ? sh2_fetch(s, pc + 2) : 0;
        int slot_deferred = 0;
        if (delayed) {
            /* BRA $ ; NOP: icount %= 3 before BRA's own costs. */
            if ((op & 0xF000) == 0xA000 && (op & 0xFFF) == 0xFFE && slot == 0x0009) m->icount %= 3;
            if (sets_test_irq(op)) m->test_irq = 1;
            m->icount -= 1 + op_extra(op, taken);    /* no CHECK after a branch iteration (delay set) */
            frt_check(m);
            slot_deferred = m->icount <= 0;
        }
        mc_nested_cycles = 0;
        m->in_step = 1;
        s->defer_slot = slot_deferred;                /* the slot (and a call/jump after it) waits for the next slice */
        sh2_step(s);
        s->defer_slot = 0;
        m->in_step = 0;
        if (s->fault) return -1;
        m->steps++;
        if (!delayed) {
            /* BUSY_LOOP_HACKS: DT Rn / BF $-2 counts the loop down while icount > 4 (before DT's own eat). */
            if ((op & 0xF0FF) == 0x4010 && sh2_fetch(s, pc + 2) == 0x8BFD) {
                uint32_t n = (op >> 8) & 15;
                while (s->r[n] > 1 && m->icount > 4) { s->r[n]--; m->icount -= 4; }
            }
            if (sets_test_irq(op)) m->test_irq = 1;
            end_iteration(m, 1 + op_extra(op, taken) + mc_nested_cycles);
        } else {
            int slot_cost = 1 + op_extra(slot, 0);
            m->icount -= mc_nested_cycles;            /* shadow harness only: a nested original call */
            if (sets_test_irq(slot)) m->test_irq = 1;
            if (slot_deferred) { m->carry = slot_cost; break; }   /* the slot's iteration is the next Sh2Run's first */
            end_iteration(m, slot_cost);
        }
    }
    if (!m->suspend) m->slice_overruns++;
    m->cycle_counts += (uint32_t)(cycles - m->icount);
    m->cycles_to_run = 0; m->icount = 0;
    return 0;
}

/* Frame: inputs, four slices with the IRQ10 counter, IRQ12. Returns -1 on a fault. */
static int run_frame(Machine *m, const uint16_t input[4]) {
    if (input) memcpy(m->input, input, sizeof m->input);
    for (int i = 0; i < 4; ++i) {
        if (run_slice(m, SLICE)) return -1;
        if (m->int10_cnt >= 2) { m->int10_cnt = 0; set_irq(m, 10, 1); } else m->int10_cnt++;
    }
    set_irq(m, 12, 1);
    return 0;
}

/* User-requested fix (2026-10-05, gates not rerun): `long` is 32-bit on Windows, so files of 2 GiB or
 * more (long replace references) failed to load; use a 64-bit size and read in 1 GiB chunks. */
static uint8_t *mc_read_file(const char *p, size_t *n) {
    FILE *f = fopen(p, "rb"); if (!f) return NULL;
#ifdef _WIN32
    _fseeki64(f, 0, SEEK_END); long long len = _ftelli64(f); _fseeki64(f, 0, SEEK_SET);
#else
    fseek(f, 0, SEEK_END); long long len = ftell(f); fseek(f, 0, SEEK_SET);
#endif
    if (len < 0 || (unsigned long long)len >= (unsigned long long)SIZE_MAX) { fclose(f); return NULL; }
    uint8_t *b = (uint8_t *)malloc((size_t)len + 1);
    for (size_t got = 0, want = (size_t)len; b && got < want;) {
        size_t k = want - got < 0x40000000u ? want - got : 0x40000000u;
        if (fread(b + got, 1, k, f) != k) { free(b); b = NULL; } else got += k;
    }
    fclose(f); if (n) *n = (size_t)len; return b;
}

/* Load a zlib-decompressed FBNeo sfiii3nr1 state payload. `raw` must stay alive (CRAM points
 * into it). Returns 0, or -1 with a message on stderr. */
static int machine_load(Machine *m, uint8_t *raw, size_t nraw, uint8_t *rom, uint8_t *bios) {
    if (nraw != RAW_SIZE) { fprintf(stderr, "state payload size %zu, expected %u\n", nraw, (unsigned)RAW_SIZE); return -1; }
    Sh2 hooks = m->cpu;           /* keep caller-installed hooks */
    memset(m, 0, sizeof *m);
    m->rom = rom; m->bios = bios;
    memcpy(m->eeprom, raw + RAW_EEPROM, 0x400);
    mc_dswap(m->ram, raw + RAW_MAIN, 0x80000);
    mc_dswap(m->spr, raw + RAW_SPR, 0x80000);
    mc_dswap(m->ss, raw + RAW_SS, 0x10000);
    mc_dswap(m->vreg, raw + RAW_VREG, 0x100);
    mc_dswap(m->c000, raw + RAW_C000, 0x400);
    mc_dswap(m->pal, raw + RAW_PAL, 0x40000);
    m->cram = raw + RAW_CRAM;
    const uint8_t *d = raw + RAW_DRV;
    Sh2 *s = &m->cpu;
    s->on_exec = hooks.on_exec; s->on_branch = hooks.on_branch; s->native_call = hooks.native_call; s->native_jump = hooks.native_jump;
    s->pc = mc_le32(d + 4); s->pr = mc_le32(d + 8); s->sr = mc_le32(d + 12); s->gbr = mc_le32(d + 16); s->vbr = mc_le32(d + 20);
    s->mach = mc_le32(d + 24); s->macl = mc_le32(d + 28);
    for (int i = 0; i < 16; ++i) s->r[i] = mc_le32(d + 32 + 4 * i);
    if (mc_le32(d + 100)) { fprintf(stderr, "state saved inside a delay slot\n"); return -1; }
    m->pending = mc_le32(d + 124);
    m->test_irq = mc_le32(d + 128) != 0;
    for (int i = 0; i < 17; ++i) m->line[i] = d[260 + i];
    for (int i = 0; i < 0x80; ++i) m->onchip[i] = mc_le32(d + 280 + 4 * i);   /* FBNeo m[(A & 0x1FC) >> 2] */
    /* struct SH2 after m[0x200] and nmi_line_state (natural alignment; suspend follows sh2_eat_cycles at 2412) */
    m->frc = (uint16_t)(d[2330] | d[2331] << 8); m->ocra = (uint16_t)(d[2332] | d[2333] << 8);
    m->ocrb = (uint16_t)(d[2334] | d[2335] << 8); m->icr = (uint16_t)(d[2336] | d[2337] << 8);
    m->frc_base = mc_le32(d + 2340);
    m->internal_irq_level = (int32_t)mc_le32(d + 2348); m->internal_irq_vector = (int32_t)mc_le32(d + 2352);
    m->timer_cycles = mc_le32(d + 2356); m->timer_base = mc_le32(d + 2360); m->timer_active = (int32_t)mc_le32(d + 2364);
    m->cycle_counts = mc_le32(d + 2392);
    if (mc_le32(d + 2384) || mc_le32(d + 2388)) { fprintf(stderr, "state has an active SH-2 DMA timer (not modelled)\n"); return -1; }
    if (mc_le32(d + 2396) || mc_le32(d + 2400)) { fprintf(stderr, "state saved inside Sh2Run (cycles_to_run/icount nonzero)\n"); return -1; }
    m->suspend = (int)mc_le32(d + 2412);
    for (int i = 0; i < 16; ++i) {
        const uint8_t *vp = d + 2416 + 40 * i;
        for (int k = 0; k < 16; ++k) m->snd_regs[i][k] = (uint16_t)(vp[2 * k] | vp[2 * k + 1] << 8);
        m->snd_pos[i] = mc_le32(vp + 32); m->snd_frac[i] = (uint16_t)(vp[36] | vp[37] << 8);
    }
    m->snd_key = (uint16_t)(d[2416 + 640] | d[2416 + 641] << 8);
    const uint8_t *t = raw + nraw - 56;
    for (int i = 0; i < 4; ++i) m->input[i] = (uint16_t)(t[2 * i] | t[2 * i + 1] << 8);
    m->cram_bank = mc_le32(t + 16);
    m->eeprom_cur = (uint16_t)(t[20] | t[21] << 8);
    m->chardma_source = mc_le32(t + 42); m->chardma_table = mc_le32(t + 46);
    m->spritelist_dma = (uint16_t)(t[50] | t[51] << 8);
    m->int10_cnt = (int32_t)mc_le32(t + 52);
    s->ram = m->ram; s->rom = m->rom; s->ss = m->ss; s->mirrors = 1; s->user = m;
    s->io_rd = io_rd; s->io_wr = io_wr; s->on_access = mc_on_access; s->fbneo_slots = 1; s->allow_macw = 1;
    return 0;
}
#endif
