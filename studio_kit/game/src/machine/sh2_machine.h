/* Fork of ../sh2_interp.h for whole-machine runs (native/machine/machine.c). Changes, all opt-in
 * through new Sh2 fields so fixture semantics are unchanged when they are unset:
 *   - io_rd/io_wr callbacks for addresses outside RAM/ROM/mirrors (CPS3 I/O, BIOS, on-chip);
 *   - fbneo_slots: RTE implemented in FBNeo order (PC, SR, slot); PC-relative loads in a delay slot use
 *     FBNeo's base (branch target + 2) instead of faulting; PR access in a call slot allowed;
 *     a BT/S or BF/S that is not taken executes alone (FBNeo sets no delay; the following
 *     instruction is a separate step, so an interrupt can be taken between them);
 *   - slot_target recorded by every delayed branch.
 * Keep in sync with sh2_interp.h instruction semantics (validated there against 987,025 Ghidra cases).
 */
/* SH-2 (SH7604) integer-unit interpreter for bounded execution of original sfiii3nr1 routines.
 *
 * Instruction semantics follow FBNeo's src/cpu/sh2/sh2.cpp (the core Fightcade runs;
 * pinned copy the reference emulator tree: src/cpu/sh2/sh2.cpp), restructured for single-routine
 * execution. Step accounting follows Ghidra's EmulatorHelper on the SuperH SLEIGH model used
 * by ghidra/scripts/VerifyAi*.java: one step is one instruction, with a delayed branch and its
 * slot counted as one step (BT/S and BF/S always execute their slot inside the branch).
 *
 * Where the two models or the hardware manual disagree, execution stops with an explicit
 * ambiguity fault instead of choosing silently:
 *   - PC-relative loads (MOVA, MOV.W/L @(disp,PC)) in a delay slot: FBNeo and the manual use
 *     the branch target + 2, Ghidra uses the slot address + 4.
 *   - PR read or written by the slot of BSR/BSRF/JSR: FBNeo and the manual set PR before the
 *     slot, Ghidra after it.
 *   - MAC.W: Ghidra's SLEIGH inverts the product sign test (marked FIXME upstream).
 * Other faults: misaligned access (an address error on hardware), a write outside the
 * permitted RAM bytes, an undefined opcode, a branch in a delay slot (slot illegal
 * instruction), a fetch outside ROM, TRAPA/RTE/SLEEP, and the step limit.
 *
 * Memory: RAM 0x02000000..0x0207FFFF and ROM 0x06000000..0x06FFFFFF, big-endian logical byte
 * order. Other addresses read as zero (counted in unmapped_reads) like the Ghidra program, and
 * fault on write.
 */
#ifndef SH2_INTERP_H
#define SH2_INTERP_H
#include <stdint.h>
#include <string.h>

enum { SH2_T = 0x001, SH2_S = 0x002, SH2_Q = 0x100, SH2_M = 0x200, SH2_FLAGS = 0x3F3 };
enum { SH2_RAM = 0x02000000u, SH2_RAM_SIZE = 0x80000u, SH2_ROM = 0x06000000u, SH2_ROM_SIZE = 0x1000000u };

enum {
    SH2_OK = 0,
    SH2_FAULT_ILLEGAL = 1,      /* undefined opcode */
    SH2_FAULT_WRITE = 2,        /* write outside RAM */
    SH2_FAULT_SPAN = 3,         /* write to a RAM byte not permitted by the allow map */
    SH2_FAULT_ALIGN = 4,        /* misaligned word/long access or fetch */
    SH2_FAULT_SLOT = 5,         /* branch in a delay slot */
    SH2_FAULT_SLOT_PCREL = 6,   /* PC-relative load in a delay slot (models disagree) */
    SH2_FAULT_SLOT_PR = 7,      /* PR accessed in a BSR/BSRF/JSR slot (models disagree) */
    SH2_FAULT_MACW = 8,         /* MAC.W executed (Ghidra's model is wrong) */
    SH2_FAULT_FETCH = 9,        /* instruction fetch outside ROM */
    SH2_FAULT_SYSTEM = 10,      /* TRAPA, RTE, SLEEP */
    SH2_FAULT_LIMIT = 11,       /* step limit reached before returning */
    SH2_FAULT_NATIVE = 12,      /* native call handler reported an error */
    SH2_FAULT_UNMAPPED = 13     /* read outside RAM/ROM while strict_reads is set */
};

typedef struct Sh2 Sh2;
struct Sh2 {
    uint32_t r[16], pc, pr, sr, gbr, vbr, mach, macl;
    uint8_t *ram;              /* 512 KiB */
    const uint8_t *rom;        /* 16 MiB */
    uint8_t *ss;               /* optional 64 KiB score-screen RAM at 05040000 (cache-through 25040000) */
    int mirrors;               /* also map the cache-through RAM mirror 22000000 (and ss) */
    const uint8_t *allow;      /* optional: per RAM byte, nonzero = writable */
    uint32_t fault, fault_pc, fault_addr, fault_op;
    uint64_t steps;
    uint32_t unmapped_reads, first_unmapped;
    int strict_reads;
    int allow_macw;            /* follow FBNeo for MAC.W instead of faulting */
    uint32_t cur;              /* address of the executing instruction */
    int in_slot;
    uint32_t slot_kind;        /* 0 none, 1 call slot (PR ambiguity), 2 other */
    /* optional hooks */
    void *user;
    void (*on_exec)(Sh2 *s, uint32_t pc);
    void (*on_branch)(Sh2 *s, uint32_t pc, int taken);
    void (*on_access)(Sh2 *s, uint32_t ea, int size, int write, uint32_t value);
    /* optional native dispatch for calls: return 1 if handled (then r0.. set and execution
     * continues at PR as if the callee returned), 0 to execute the original. */
    int (*native_call)(Sh2 *s, uint32_t target);
    /* optional: the same for a tail jump (JMP @Rm, BRA) after its slot; if handled, execution
     * continues at PR, where the jumped-to routine returns. */
    int (*native_jump)(Sh2 *s, uint32_t target);
    /* machine mode (scratch spike): hardware callbacks and FBNeo delay-slot semantics */
    uint32_t (*io_rd)(Sh2 *s, uint32_t a, int size);
    void (*io_wr)(Sh2 *s, uint32_t a, int size, uint32_t v);
    int fbneo_slots;           /* PC-relative in a slot uses branch target + 2; no PR-slot fault */
    uint32_t slot_target;      /* target of the delayed branch whose slot is executing */
    uint64_t slot_pcrel;       /* count of PC-relative loads executed in delay slots */
    /* machine mode: FBNeo ends Sh2Run after a branch iteration with the slot still pending
     * (sh2->delay); defer_slot makes the next delayed branch stop there, sh2_resume_slot finishes it. */
    int defer_slot, pend, pend_post;
    uint32_t pend_a, pend_kind, pend_target;
};

static inline void sh2_fault(Sh2 *s, uint32_t code, uint32_t addr) {
    if (!s->fault) { s->fault = code; s->fault_pc = s->cur; s->fault_addr = addr; }
}

static inline uint32_t sh2_rd(Sh2 *s, uint32_t a, int size) {
    if (a & (uint32_t)(size - 1)) { sh2_fault(s, SH2_FAULT_ALIGN, a); return 0; }
    const uint8_t *p;
    if (a - SH2_RAM < SH2_RAM_SIZE) p = s->ram + (a - SH2_RAM);
    else if (a - SH2_ROM < SH2_ROM_SIZE) p = s->rom + (a - SH2_ROM);
    else if (s->mirrors && a - 0x22000000u < SH2_RAM_SIZE) p = s->ram + (a - 0x22000000u);
    else if (s->mirrors && s->ss && ((a & 0xDFFFFFFFu) - 0x05040000u) < 0x10000u) p = s->ss + ((a & 0xDFFFFFFFu) - 0x05040000u);
    else if (s->io_rd) {
        uint32_t v = s->io_rd(s, a, size);
        if (s->on_access) s->on_access(s, a, size, 0, v);
        return v;
    } else {
        if (!s->unmapped_reads++) s->first_unmapped = a;
        if (s->strict_reads) sh2_fault(s, SH2_FAULT_UNMAPPED, a);
        if (s->on_access) s->on_access(s, a, size, 0, 0);
        return 0;
    }
    uint32_t v = size == 1 ? p[0] : size == 2 ? (uint32_t)p[0] << 8 | p[1]
               : (uint32_t)p[0] << 24 | (uint32_t)p[1] << 16 | (uint32_t)p[2] << 8 | p[3];
    if (s->on_access) s->on_access(s, a, size, 0, v);
    return v;
}

static inline void sh2_wr(Sh2 *s, uint32_t a, int size, uint32_t v) {
    if (a & (uint32_t)(size - 1)) { sh2_fault(s, SH2_FAULT_ALIGN, a); return; }
    if (s->mirrors) {
        if (a - 0x22000000u < SH2_RAM_SIZE) a -= 0x20000000u;
        else if (s->ss && ((a & 0xDFFFFFFFu) - 0x05040000u) < 0x10000u) {
            uint8_t *q = s->ss + ((a & 0xDFFFFFFFu) - 0x05040000u);
            if (s->on_access) s->on_access(s, a, size, 1, v);
            if (size == 1) q[0] = (uint8_t)v;
            else if (size == 2) { q[0] = (uint8_t)(v >> 8); q[1] = (uint8_t)v; }
            else { q[0] = (uint8_t)(v >> 24); q[1] = (uint8_t)(v >> 16); q[2] = (uint8_t)(v >> 8); q[3] = (uint8_t)v; }
            return;
        }
    }
    if (a - SH2_RAM >= SH2_RAM_SIZE && s->io_wr) { if (s->on_access) s->on_access(s, a, size, 1, v); s->io_wr(s, a, size, v); return; }
    if (a - SH2_RAM >= SH2_RAM_SIZE || a - SH2_RAM + (uint32_t)size > SH2_RAM_SIZE) { sh2_fault(s, SH2_FAULT_WRITE, a); return; }
    uint32_t o = a - SH2_RAM;
    if (s->allow) for (int i = 0; i < size; ++i) if (!s->allow[o + (uint32_t)i]) { sh2_fault(s, SH2_FAULT_SPAN, a + (uint32_t)i); return; }
    if (s->on_access) s->on_access(s, a, size, 1, v);
    uint8_t *p = s->ram + o;
    if (size == 1) p[0] = (uint8_t)v;
    else if (size == 2) { p[0] = (uint8_t)(v >> 8); p[1] = (uint8_t)v; }
    else { p[0] = (uint8_t)(v >> 24); p[1] = (uint8_t)(v >> 16); p[2] = (uint8_t)(v >> 8); p[3] = (uint8_t)v; }
}

#define SH2_RB(a) sh2_rd(s, (a), 1)
#define SH2_RW(a) sh2_rd(s, (a), 2)
#define SH2_RL(a) sh2_rd(s, (a), 4)
#define SH2_WB(a, v) sh2_wr(s, (a), 1, (v))
#define SH2_WW(a, v) sh2_wr(s, (a), 2, (v))
#define SH2_WL(a, v) sh2_wr(s, (a), 4, (v))
#define SH2_SETT(c) (s->sr = (c) ? (s->sr | SH2_T) : (s->sr & ~(uint32_t)SH2_T))

static inline uint16_t sh2_fetch(Sh2 *s, uint32_t a) {
    if (a & 1) { sh2_fault(s, SH2_FAULT_ALIGN, a); return 0x0009; }
    if (a - SH2_ROM >= SH2_ROM_SIZE) { sh2_fault(s, SH2_FAULT_FETCH, a); return 0x0009; }
    const uint8_t *p = s->rom + (a - SH2_ROM);
    return (uint16_t)(p[0] << 8 | p[1]);
}

static void sh2_exec(Sh2 *s, uint16_t op, uint32_t a);

/* Execute the delay slot at `a` (kind 1 = BSR/BSRF/JSR slot). */
static void sh2_slot(Sh2 *s, uint32_t a, uint32_t kind) {
    uint16_t op = sh2_fetch(s, a);
    if (s->fault) return;
    uint32_t saved = s->cur;
    s->in_slot = 1; s->slot_kind = kind; s->cur = a;
    if (s->on_exec) s->on_exec(s, a);
    sh2_exec(s, op, a);
    s->in_slot = 0; s->slot_kind = 0; s->cur = saved;
}

static inline int sh2_branch_ok(Sh2 *s) {
    if (s->in_slot) { sh2_fault(s, SH2_FAULT_SLOT, s->cur); return 0; }
    return 1;
}

static inline int sh2_pcrel_ok(Sh2 *s) {
    if (s->in_slot) {
        if (s->fbneo_slots) { s->slot_pcrel++; return 1; }
        sh2_fault(s, SH2_FAULT_SLOT_PCREL, s->cur); return 0;
    }
    return 1;
}
/* PC+4 base of a PC-relative load at `a`; in a delay slot FBNeo's PC is the branch target. */
static inline uint32_t sh2_pcbase(Sh2 *s, uint32_t a) {
    return (s->in_slot && s->fbneo_slots) ? s->slot_target + 2 : a + 4;
}

static inline int sh2_pr_ok(Sh2 *s) {
    if (s->in_slot && s->slot_kind == 1 && !s->fbneo_slots) { sh2_fault(s, SH2_FAULT_SLOT_PR, s->cur); return 0; }
    return 1;
}

/* A call to `target` whose return address is PR (already set). */
static inline void sh2_call(Sh2 *s, uint32_t target) {
    if (s->native_call && s->native_call(s, target)) { if (!s->fault) s->pc = s->pr; return; }
    s->pc = target;
}

/* After a delay slot: continue at the target, as a call (native_call hook) or a jump (native_jump). */
enum { SH2_POST_PC, SH2_POST_CALL, SH2_POST_JUMP };
static void sh2_finish(Sh2 *s, uint32_t target, int post) {
    if (post == SH2_POST_PC) { s->pc = target; return; }
    if (s->fault) return;
    if (post == SH2_POST_CALL) { sh2_call(s, target); return; }
    if (s->native_jump && s->native_jump(s, target)) { if (!s->fault) s->pc = s->pr; return; }
    s->pc = target;
}

/* A delayed branch at `a` whose own effects (target, PR, SR) are done: its slot, then `post`. */
static void sh2_delayed(Sh2 *s, uint32_t a, uint32_t kind, uint32_t target, int post) {
    s->slot_target = target;
    if (s->defer_slot) {
        s->pend = 1; s->pend_a = a + 2; s->pend_kind = kind; s->pend_target = target; s->pend_post = post;
        s->pc = target;
        return;
    }
    sh2_slot(s, a + 2, kind);
    sh2_finish(s, target, post);
}

static void sh2_resume_slot(Sh2 *s) {
    s->pend = 0;
    s->slot_target = s->pend_target;
    sh2_slot(s, s->pend_a, s->pend_kind);
    sh2_finish(s, s->pend_target, s->pend_post);
}

static void sh2_div1(Sh2 *s, uint32_t m, uint32_t n) {
    uint32_t tmp0, old_q = s->sr & SH2_Q;
    if (0x80000000u & s->r[n]) s->sr |= SH2_Q; else s->sr &= ~(uint32_t)SH2_Q;
    s->r[n] = (s->r[n] << 1) | (s->sr & SH2_T);
    if (!old_q) {
        if (!(s->sr & SH2_M)) {
            tmp0 = s->r[n]; s->r[n] -= s->r[m];
            if (!(s->sr & SH2_Q)) { if (s->r[n] > tmp0) s->sr |= SH2_Q; else s->sr &= ~(uint32_t)SH2_Q; }
            else { if (s->r[n] > tmp0) s->sr &= ~(uint32_t)SH2_Q; else s->sr |= SH2_Q; }
        } else {
            tmp0 = s->r[n]; s->r[n] += s->r[m];
            if (!(s->sr & SH2_Q)) { if (s->r[n] < tmp0) s->sr &= ~(uint32_t)SH2_Q; else s->sr |= SH2_Q; }
            else { if (s->r[n] < tmp0) s->sr |= SH2_Q; else s->sr &= ~(uint32_t)SH2_Q; }
        }
    } else {
        if (!(s->sr & SH2_M)) {
            tmp0 = s->r[n]; s->r[n] += s->r[m];
            if (!(s->sr & SH2_Q)) { if (s->r[n] < tmp0) s->sr |= SH2_Q; else s->sr &= ~(uint32_t)SH2_Q; }
            else { if (s->r[n] < tmp0) s->sr &= ~(uint32_t)SH2_Q; else s->sr |= SH2_Q; }
        } else {
            tmp0 = s->r[n]; s->r[n] -= s->r[m];
            if (!(s->sr & SH2_Q)) { if (s->r[n] > tmp0) s->sr &= ~(uint32_t)SH2_Q; else s->sr |= SH2_Q; }
            else { if (s->r[n] > tmp0) s->sr |= SH2_Q; else s->sr &= ~(uint32_t)SH2_Q; }
        }
    }
    tmp0 = s->sr & (SH2_Q | SH2_M);
    SH2_SETT(!tmp0 || tmp0 == (SH2_Q | SH2_M));
}

static void sh2_mac_l(Sh2 *s, uint32_t m, uint32_t n) {
    int32_t tn = (int32_t)SH2_RL(s->r[n]); s->r[n] += 4;
    int32_t tm = (int32_t)SH2_RL(s->r[m]); s->r[m] += 4;
    int64_t product = (int64_t)tn * (int64_t)tm;
    uint32_t res0 = (uint32_t)(uint64_t)product, res2 = (uint32_t)((uint64_t)product >> 32);
    if (s->sr & SH2_S) {
        uint32_t lo = s->macl + res0;
        if (s->macl > lo) res2++;
        res2 += (s->mach & 0x0000FFFFu);
        res0 = lo;
        if ((int32_t)res2 < 0 && res2 < 0xFFFF8000u) { res2 = 0x00008000u; res0 = 0; }
        else if ((int32_t)res2 > 0 && res2 > 0x00007FFFu) { res2 = 0x00007FFFu; res0 = 0xFFFFFFFFu; }
        s->mach = res2; s->macl = res0;
    } else {
        uint32_t lo = s->macl + res0;
        if (s->macl > lo) res2++;
        s->mach += res2; s->macl = lo;
    }
}

static void sh2_mac_w(Sh2 *s, uint32_t m, uint32_t n) {
    if (!s->allow_macw) { sh2_fault(s, SH2_FAULT_MACW, s->cur); return; }
    int32_t tn = (int16_t)SH2_RW(s->r[n]); s->r[n] += 2;
    int32_t tm = (int16_t)SH2_RW(s->r[m]); s->r[m] += 2;
    uint32_t templ = s->macl;
    int32_t prod = tn * tm, dest = (int32_t)s->macl < 0, src, ans;
    uint32_t high;
    if (prod >= 0) { src = 0; high = 0; } else { src = 1; high = 0xFFFFFFFFu; }
    src += dest;
    s->macl += (uint32_t)prod;
    ans = ((int32_t)s->macl < 0) + dest;
    if (s->sr & SH2_S) {
        if (ans == 1) { if (src == 0) s->macl = 0x7FFFFFFFu; if (src == 2) s->macl = 0x80000000u; }
    } else {
        s->mach += high;
        if (templ > s->macl) s->mach += 1;
    }
}

static void sh2_exec(Sh2 *s, uint16_t op, uint32_t a) {
    uint32_t n = (op >> 8) & 15, m = (op >> 4) & 15, i8 = op & 0xFF;
    uint32_t *r = s->r;
    switch (op >> 12) {
    case 0x0:
        switch (op & 0xF) {
        case 0x2:
            switch (m) {
            case 0: r[n] = s->sr; return;           /* STC SR,Rn */
            case 1: r[n] = s->gbr; return;          /* STC GBR,Rn */
            case 2: r[n] = s->vbr; return;          /* STC VBR,Rn */
            }
            break;
        case 0x3:
            if (m == 0) {                           /* BSRF Rm */
                if (!sh2_branch_ok(s)) return;
                uint32_t target = a + 4 + r[n];
                s->pr = a + 4;
                sh2_delayed(s, a, 1, target, SH2_POST_CALL);
                return;
            }
            if (m == 2) {                           /* BRAF Rm */
                if (!sh2_branch_ok(s)) return;
                sh2_delayed(s, a, 2, a + 4 + r[n], SH2_POST_PC);
                return;
            }
            break;
        case 0x4: SH2_WB(r[n] + r[0], r[m] & 0xFF); return;
        case 0x5: SH2_WW(r[n] + r[0], r[m] & 0xFFFF); return;
        case 0x6: SH2_WL(r[n] + r[0], r[m]); return;
        case 0x7: s->macl = r[n] * r[m]; return;    /* MUL.L */
        case 0x8:
            if (op == 0x0008) { s->sr &= ~(uint32_t)SH2_T; return; }                 /* CLRT */
            if (op == 0x0018) { s->sr |= SH2_T; return; }                            /* SETT */
            if (op == 0x0028) { s->mach = 0; s->macl = 0; return; }                  /* CLRMAC */
            break;
        case 0x9:
            if (op == 0x0009) return;                                                 /* NOP */
            if (op == 0x0019) { s->sr &= ~(uint32_t)(SH2_M | SH2_Q | SH2_T); return; } /* DIV0U */
            if (m == 2) { r[n] = s->sr & SH2_T; return; }                             /* MOVT */
            break;
        case 0xA:
            switch (m) {
            case 0: r[n] = s->mach; return;
            case 1: r[n] = s->macl; return;
            case 2: if (!sh2_pr_ok(s)) return; r[n] = s->pr; return;
            }
            break;
        case 0xB:
            if (op == 0x000B) {                     /* RTS */
                if (!sh2_branch_ok(s)) return;
                sh2_delayed(s, a, 2, s->pr, SH2_POST_PC);
                return;
            }
            if (op == 0x002B && s->fbneo_slots) {  /* RTE (FBNeo order: PC, then SR, then the slot) */
                if (!sh2_branch_ok(s)) return;
                uint32_t target = SH2_RL(r[15]); r[15] += 4;
                s->sr = SH2_RL(r[15]) & SH2_FLAGS; r[15] += 4;
                sh2_delayed(s, a, 2, target, SH2_POST_PC);
                return;
            }
            if (op == 0x001B || op == 0x002B) { sh2_fault(s, SH2_FAULT_SYSTEM, a); return; } /* SLEEP, RTE */
            break;
        case 0xC: r[n] = (uint32_t)(int32_t)(int8_t)SH2_RB(r[m] + r[0]); return;
        case 0xD: r[n] = (uint32_t)(int32_t)(int16_t)SH2_RW(r[m] + r[0]); return;
        case 0xE: r[n] = SH2_RL(r[m] + r[0]); return;
        case 0xF: sh2_mac_l(s, m, n); return;
        }
        break;
    case 0x1: SH2_WL(r[n] + (op & 15) * 4, r[m]); return;
    case 0x2:
        switch (op & 0xF) {
        case 0x0: SH2_WB(r[n], r[m] & 0xFF); return;
        case 0x1: SH2_WW(r[n], r[m] & 0xFFFF); return;
        case 0x2: SH2_WL(r[n], r[m]); return;
        case 0x4: { uint32_t d = r[m] & 0xFF; r[n] -= 1; SH2_WB(r[n], d); return; }
        case 0x5: { uint32_t d = r[m] & 0xFFFF; r[n] -= 2; SH2_WW(r[n], d); return; }
        case 0x6: { uint32_t d = r[m]; r[n] -= 4; SH2_WL(r[n], d); return; }
        case 0x7:                                   /* DIV0S */
            if (r[n] & 0x80000000u) s->sr |= SH2_Q; else s->sr &= ~(uint32_t)SH2_Q;
            if (r[m] & 0x80000000u) s->sr |= SH2_M; else s->sr &= ~(uint32_t)SH2_M;
            SH2_SETT((r[m] ^ r[n]) & 0x80000000u);
            return;
        case 0x8: SH2_SETT((r[n] & r[m]) == 0); return;
        case 0x9: r[n] &= r[m]; return;
        case 0xA: r[n] ^= r[m]; return;
        case 0xB: r[n] |= r[m]; return;
        case 0xC: {                                 /* CMP/STR */
            uint32_t t = r[n] ^ r[m];
            SH2_SETT(!((t >> 24) & 0xFF && (t >> 16) & 0xFF && (t >> 8) & 0xFF && t & 0xFF));
            return;
        }
        case 0xD: r[n] = (r[n] >> 16) | (r[m] << 16); return;              /* XTRCT */
        case 0xE: s->macl = (r[n] & 0xFFFF) * (r[m] & 0xFFFF); return;     /* MULU.W */
        case 0xF: s->macl = (uint32_t)((int32_t)(int16_t)r[n] * (int32_t)(int16_t)r[m]); return; /* MULS.W */
        }
        break;
    case 0x3:
        switch (op & 0xF) {
        case 0x0: SH2_SETT(r[n] == r[m]); return;
        case 0x2: SH2_SETT(r[n] >= r[m]); return;
        case 0x3: SH2_SETT((int32_t)r[n] >= (int32_t)r[m]); return;
        case 0x4: sh2_div1(s, m, n); return;
        case 0x5: { uint64_t p = (uint64_t)r[n] * r[m]; s->mach = (uint32_t)(p >> 32); s->macl = (uint32_t)p; return; }
        case 0x6: SH2_SETT(r[n] > r[m]); return;
        case 0x7: SH2_SETT((int32_t)r[n] > (int32_t)r[m]); return;
        case 0x8: r[n] -= r[m]; return;
        case 0xA: {                                 /* SUBC */
            uint32_t t1 = r[n] - r[m], t0 = r[n];
            r[n] = t1 - (s->sr & SH2_T);
            SH2_SETT(t0 < t1 || t1 < r[n]);
            return;
        }
        case 0xB: {                                 /* SUBV */
            int32_t dest = (int32_t)r[n] < 0, src = ((int32_t)r[m] < 0) + dest;
            r[n] -= r[m];
            int32_t ans = ((int32_t)r[n] < 0) + dest;
            SH2_SETT(src == 1 && ans == 1);
            return;
        }
        case 0xC: r[n] += r[m]; return;
        case 0xD: { int64_t p = (int64_t)(int32_t)r[n] * (int32_t)r[m]; s->mach = (uint32_t)((uint64_t)p >> 32); s->macl = (uint32_t)(uint64_t)p; return; }
        case 0xE: {                                 /* ADDC */
            uint32_t t1 = r[n] + r[m], t0 = r[n];
            r[n] = t1 + (s->sr & SH2_T);
            SH2_SETT(t0 > t1 || t1 > r[n]);
            return;
        }
        case 0xF: {                                 /* ADDV */
            int32_t dest = (int32_t)r[n] < 0, src = ((int32_t)r[m] < 0) + dest;
            r[n] += r[m];
            int32_t ans = ((int32_t)r[n] < 0) + dest;
            SH2_SETT((src == 0 || src == 2) && ans == 1);
            return;
        }
        }
        break;
    case 0x4:
        if ((op & 0xF) == 0xF) { sh2_mac_w(s, m, n); return; }
        switch (op & 0xFF) {
        case 0x00: case 0x20: SH2_SETT(r[n] >> 31); r[n] <<= 1; return;    /* SHLL, SHAL */
        case 0x01: SH2_SETT(r[n] & 1); r[n] >>= 1; return;                 /* SHLR */
        case 0x21: SH2_SETT(r[n] & 1); r[n] = (uint32_t)((int32_t)r[n] >> 1); return; /* SHAR */
        case 0x02: r[n] -= 4; SH2_WL(r[n], s->mach); return;
        case 0x12: r[n] -= 4; SH2_WL(r[n], s->macl); return;
        case 0x22: if (!sh2_pr_ok(s)) return; r[n] -= 4; SH2_WL(r[n], s->pr); return;
        case 0x03: r[n] -= 4; SH2_WL(r[n], s->sr); return;
        case 0x13: r[n] -= 4; SH2_WL(r[n], s->gbr); return;
        case 0x23: r[n] -= 4; SH2_WL(r[n], s->vbr); return;
        case 0x04: SH2_SETT(r[n] >> 31); r[n] = (r[n] << 1) | (r[n] >> 31); return;   /* ROTL */
        case 0x05: SH2_SETT(r[n] & 1); r[n] = (r[n] >> 1) | (r[n] << 31); return;     /* ROTR */
        case 0x24: { uint32_t t = r[n] >> 31; r[n] = (r[n] << 1) | (s->sr & SH2_T); SH2_SETT(t); return; }          /* ROTCL */
        case 0x25: { uint32_t t = (s->sr & SH2_T) << 31; SH2_SETT(r[n] & 1); r[n] = (r[n] >> 1) | t; return; }     /* ROTCR */
        case 0x06: s->mach = SH2_RL(r[n]); r[n] += 4; return;
        case 0x16: s->macl = SH2_RL(r[n]); r[n] += 4; return;
        case 0x26: if (!sh2_pr_ok(s)) return; s->pr = SH2_RL(r[n]); r[n] += 4; return;
        case 0x07: s->sr = SH2_RL(r[n]) & SH2_FLAGS; r[n] += 4; return;
        case 0x17: s->gbr = SH2_RL(r[n]); r[n] += 4; return;
        case 0x27: s->vbr = SH2_RL(r[n]); r[n] += 4; return;
        case 0x08: r[n] <<= 2; return;
        case 0x09: r[n] >>= 2; return;
        case 0x18: r[n] <<= 8; return;
        case 0x19: r[n] >>= 8; return;
        case 0x28: r[n] <<= 16; return;
        case 0x29: r[n] >>= 16; return;
        case 0x0A: s->mach = r[n]; return;
        case 0x1A: s->macl = r[n]; return;
        case 0x2A: if (!sh2_pr_ok(s)) return; s->pr = r[n]; return;
        case 0x0B: {                                /* JSR @Rm */
            if (!sh2_branch_ok(s)) return;
            uint32_t target = r[n];
            s->pr = a + 4;
            sh2_delayed(s, a, 1, target, SH2_POST_CALL);
            return;
        }
        case 0x2B: {                                /* JMP @Rm */
            if (!sh2_branch_ok(s)) return;
            sh2_delayed(s, a, 2, r[n], SH2_POST_JUMP);
            return;
        }
        case 0x0E: s->sr = r[n] & SH2_FLAGS; return;
        case 0x1E: s->gbr = r[n]; return;
        case 0x2E: s->vbr = r[n]; return;
        case 0x10: r[n] -= 1; SH2_SETT(r[n] == 0); return;                 /* DT */
        case 0x11: SH2_SETT((int32_t)r[n] >= 0); return;                   /* CMP/PZ */
        case 0x15: SH2_SETT((int32_t)r[n] > 0); return;                    /* CMP/PL */
        case 0x1B: {                                                        /* TAS.B */
            uint32_t t = SH2_RB(r[n]);
            if (s->fault) return;
            SH2_SETT(t == 0);
            SH2_WB(r[n], t | 0x80);
            return;
        }
        }
        break;
    case 0x5: r[n] = SH2_RL(r[m] + (op & 15) * 4); return;
    case 0x6:
        switch (op & 0xF) {
        case 0x0: r[n] = (uint32_t)(int32_t)(int8_t)SH2_RB(r[m]); return;
        case 0x1: r[n] = (uint32_t)(int32_t)(int16_t)SH2_RW(r[m]); return;
        case 0x2: r[n] = SH2_RL(r[m]); return;
        case 0x3: r[n] = r[m]; return;
        case 0x4: { uint32_t v = (uint32_t)(int32_t)(int8_t)SH2_RB(r[m]); if (n != m) r[m] += 1; r[n] = v; return; }
        case 0x5: { uint32_t v = (uint32_t)(int32_t)(int16_t)SH2_RW(r[m]); if (n != m) r[m] += 2; r[n] = v; return; }
        case 0x6: { uint32_t v = SH2_RL(r[m]); if (n != m) r[m] += 4; r[n] = v; return; }
        case 0x7: r[n] = ~r[m]; return;
        case 0x8: r[n] = (r[m] & 0xFFFF0000u) | ((r[m] & 0xFF) << 8) | ((r[m] >> 8) & 0xFF); return;   /* SWAP.B */
        case 0x9: r[n] = (r[m] << 16) | (r[m] >> 16); return;                                           /* SWAP.W */
        case 0xA: { uint32_t t = r[m], c = s->sr & SH2_T; r[n] = 0u - t - c; SH2_SETT(t || c); return; } /* NEGC */
        case 0xB: r[n] = 0u - r[m]; return;
        case 0xC: r[n] = r[m] & 0xFF; return;
        case 0xD: r[n] = r[m] & 0xFFFF; return;
        case 0xE: r[n] = (uint32_t)(int32_t)(int8_t)r[m]; return;
        case 0xF: r[n] = (uint32_t)(int32_t)(int16_t)r[m]; return;
        }
        break;
    case 0x7: r[n] += (uint32_t)(int32_t)(int8_t)i8; return;
    case 0x8:
        switch (n) {
        case 0x0: SH2_WB(r[m] + (op & 15), r[0] & 0xFF); return;
        case 0x1: SH2_WW(r[m] + (op & 15) * 2, r[0] & 0xFFFF); return;
        case 0x4: r[0] = (uint32_t)(int32_t)(int8_t)SH2_RB(r[m] + (op & 15)); return;
        case 0x5: r[0] = (uint32_t)(int32_t)(int16_t)SH2_RW(r[m] + (op & 15) * 2); return;
        case 0x8: SH2_SETT(r[0] == (uint32_t)(int32_t)(int8_t)i8); return;
        case 0x9: case 0xB: {                       /* BT, BF */
            if (!sh2_branch_ok(s)) return;
            int taken = ((s->sr & SH2_T) != 0) == (n == 0x9);
            if (s->on_branch) s->on_branch(s, a, taken);
            if (taken) s->pc = a + 4 + (uint32_t)((int32_t)(int8_t)i8 * 2);
            return;
        }
        case 0xD: case 0xF: {                       /* BT/S, BF/S */
            if (!sh2_branch_ok(s)) return;
            int taken = ((s->sr & SH2_T) != 0) == (n == 0xD);
            uint32_t target = a + 4 + (uint32_t)((int32_t)(int8_t)i8 * 2);
            if (s->on_branch) s->on_branch(s, a, taken);
            if (!taken && s->fbneo_slots) {         /* sh2.cpp BFS/BTS set no delay when not taken: */
                s->pc = a + 2;                      /* the next instruction is an ordinary step */
                return;
            }
            sh2_delayed(s, a, 2, taken ? target : a + 4, SH2_POST_PC);
            return;
        }
        }
        break;
    case 0x9: if (!sh2_pcrel_ok(s)) return; r[n] = (uint32_t)(int32_t)(int16_t)SH2_RW(sh2_pcbase(s, a) + i8 * 2); return;
    case 0xA: case 0xB: {                           /* BRA, BSR */
        if (!sh2_branch_ok(s)) return;
        int32_t d = (int32_t)((uint32_t)(op & 0xFFF) << 20) >> 20;
        uint32_t target = a + 4 + (uint32_t)(d * 2);
        if (op >> 12 == 0xB) {
            s->pr = a + 4;
            sh2_delayed(s, a, 1, target, SH2_POST_CALL);
        } else {
            sh2_delayed(s, a, 2, target, SH2_POST_JUMP);
        }
        return;
    }
    case 0xC:
        switch (n) {
        case 0x0: SH2_WB(s->gbr + i8, r[0] & 0xFF); return;
        case 0x1: SH2_WW(s->gbr + i8 * 2, r[0] & 0xFFFF); return;
        case 0x2: SH2_WL(s->gbr + i8 * 4, r[0]); return;
        case 0x3: sh2_fault(s, SH2_FAULT_SYSTEM, a); return;               /* TRAPA */
        case 0x4: r[0] = (uint32_t)(int32_t)(int8_t)SH2_RB(s->gbr + i8); return;
        case 0x5: r[0] = (uint32_t)(int32_t)(int16_t)SH2_RW(s->gbr + i8 * 2); return;
        case 0x6: r[0] = SH2_RL(s->gbr + i8 * 4); return;
        case 0x7: if (!sh2_pcrel_ok(s)) return; r[0] = (sh2_pcbase(s, a) & ~3u) + i8 * 4; return;   /* MOVA */
        case 0x8: SH2_SETT((r[0] & i8) == 0); return;
        case 0x9: r[0] &= i8; return;
        case 0xA: r[0] ^= i8; return;
        case 0xB: r[0] |= i8; return;
        case 0xC: { uint32_t t = SH2_RB(s->gbr + r[0]); SH2_SETT((t & i8) == 0); return; }
        case 0xD: { uint32_t ea = s->gbr + r[0], t = SH2_RB(ea); if (!s->fault) SH2_WB(ea, t & i8); return; }
        case 0xE: { uint32_t ea = s->gbr + r[0], t = SH2_RB(ea); if (!s->fault) SH2_WB(ea, t ^ i8); return; }
        case 0xF: { uint32_t ea = s->gbr + r[0], t = SH2_RB(ea); if (!s->fault) SH2_WB(ea, t | i8); return; }
        }
        break;
    case 0xD: if (!sh2_pcrel_ok(s)) return; r[n] = SH2_RL((sh2_pcbase(s, a) & ~3u) + i8 * 4); return;
    case 0xE: r[n] = (uint32_t)(int32_t)(int8_t)i8; return;
    }
    sh2_fault(s, SH2_FAULT_ILLEGAL, a);
    s->fault_op = op;
}

/* One step: an instruction, with its delay slot if it is a delayed branch. */
static inline void sh2_step(Sh2 *s) {
    uint32_t a = s->pc;
    uint16_t op = sh2_fetch(s, a);
    if (s->fault) return;
    s->cur = a;
    s->pc = a + 2;
    if (s->on_exec) s->on_exec(s, a);
    sh2_exec(s, op, a);
    s->steps++;
}

/* Run until PC == ret at an instruction boundary; Ghidra VerifyAi loop semantics
 * (`while (pc != RET) { require(n++ < limit); step(); }`). Returns the fault code. */
static inline uint32_t sh2_run(Sh2 *s, uint32_t ret, uint64_t limit) {
    uint64_t n = 0;
    while (s->pc != ret) {
        if (n++ >= limit) { sh2_fault(s, SH2_FAULT_LIMIT, s->pc); break; }
        sh2_step(s);
        if (s->fault) break;
    }
    return s->fault;
}

#endif
