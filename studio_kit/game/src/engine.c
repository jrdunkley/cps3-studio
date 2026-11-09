/* CPS3 Studio · Game engine: the exact native CPS3 machine and video compositor
 * (src/machine + src/video)
 * wrapped for the browser (wasm32-wasi reactor) and for native gate runners.
 *
 * Adds, without editing the included sources:
 *   - a synthetic power-on state (byte-equal to FBNeo's power-on savestate with a blank chip): FBNeo's CPS3 reset takes its "fast boot" branch for every NO CD
 *     driver (cps3run.cpp Cps3Reset): Sh2Reset(PC, SP) from the program's first two big-endian
 *     dwords, SR = I bits (F0), VBR 06000000, internal IRQ level -1, everything else zero; the
 *     settings chip (EEPROM, 0x400 bytes) is whatever the caller gives (an FBNeo .nv payload,
 *     Fightcade's block, or zeros = factory settings);
 *   - FBNeo's reset-time BIOS patch Cps3PatchRegion for sfiii3 (region 0x1FEC8, NO CD 0x1FECF in
 *     FBNeo's dword-swapped BIOS = logical bytes 0x1FECB and 0x1FECC) with the Japan default dip 1;
 *   - the sound chip mixer, run once per frame after the CPU as FBNeo calls cps3SndUpdate. It reads
 *     the machine's register file and advances only the voice positions; it never changes the key
 *     mask (FBNeo cps3snd.cpp: "don't force key off"), so nothing the game can read depends on it.
 *     Two laws: ENG_MIX_CHIP mixes at the chip's own rate (42954500/3/384 Hz, the Music Studio's
 *     engine.js chip() with selfClear off); ENG_MIX_FBNEO reproduces FBNeo's output-rate loop
 *     (nBurnSoundLen samples, step = regs[6] * delta >> 12) for sample-exact checks against FBNeo;
 *   - snapshot / restore of the whole machine (pointers re-made after a copy);
 *   - per-frame meters: CPU cycles run before the speedhack idle, slice overruns, DMA requests;
 *   (FBNeo's ignored 040C0080/040C0084 word writes and its persistent intermediate bitmap for zoom below 64
 *   now live in the included machine_core.h / renderer.h: user-approved 2026-10-05, M1.5 B0);
 *   - rendering isolated from emulation: the compositor's sticky error flag is saved and restored
 *     around a render, so drawing or skipping frames never changes what the machine does next.
 * Everything here runs the user's own ROM; no ROM data is compiled in.
 */
#include "renderer.h"

#if defined(__wasm__)
#define API(name) __attribute__((export_name(#name)))
#else
#define API(name)
#endif

enum { ENG_MIX_CHIP = 0, ENG_MIX_FBNEO = 1, ENG_AUDIO_MAX = 4096, ENG_VERSION = 2 };
enum { SNAP_MAGIC = 0x50414E53u /* 'SNAP' */ };

typedef struct {
    uint32_t version, frame, fault, fault_pc, fault_addr, fault_op;
    uint32_t busy_cycles, overruns, char_dma, pal_dma, spr_dma, audio_samples;
    uint32_t render_error, zoom, sprites, blended, steps_lo, steps_hi, irq10, irq12, slice_cycles, onchip_unmodelled;
} Meters;

static VideoMachine vm;
static VideoFrame vf;
static uint8_t *raw;                     /* the machine state payload; character RAM lives inside it */
static uint8_t *rom, *bios, *data;
static size_t data_size;
static uint32_t rgba[VIDEO_WIDTH * VIDEO_HEIGHT];
static int16_t audio[ENG_AUDIO_MAX * 2];
static int32_t mixL[ENG_AUDIO_MAX], mixR[ENG_AUDIO_MAX];
static Meters meters;
static uint64_t acc;                     /* chip-rate accumulator (ENG_MIX_CHIP) */
static uint32_t mix_mode, mix_rate = 48000, mix_fps100 = 5959, fb_len, fb_delta;
static uint32_t frame_no, busy_now;
static int loaded;

#include "observation.h"

/* chip samples per frame = (42954500 / 3 / 384) / 59.59949 (the Music Studio's SPF_NUM / SPF_DEN) */
static const uint64_t SPF_NUM = 4295450000000ull, SPF_DEN = 6865861248ull;

API(eng_alloc) void *eng_alloc(uint32_t n) { return calloc(1, n ? n : 1); }
API(eng_free) void eng_free(void *p) { free(p); }

/* FBNeo cps3SndInit / BurnSetRefreshRate, integer arithmetic as in the C. */
static void fb_params(void) {
    uint32_t snd_rate = 42954500 / 3 / 384, int_rate = mix_fps100 / 100, buffer = snd_rate / int_rate;
    fb_len = mix_rate ? (mix_rate * 100 + (mix_fps100 >> 1)) / mix_fps100 : 0;
    fb_delta = fb_len ? (buffer << 12) / fb_len : 0;
}

API(eng_audio_mode) uint32_t eng_audio_mode(uint32_t mode, uint32_t rate, uint32_t fps100) {
    mix_mode = mode; if (rate) mix_rate = rate; if (fps100) mix_fps100 = fps100;
    fb_params();
    return mix_mode == ENG_MIX_FBNEO ? fb_len : 0;
}

/* One frame of sound: FBNeo's voice loop with either the chip's own rate or FBNeo's output rate. */
static uint32_t mix_frame(void) {
    Machine *m = &vm.machine;
    uint32_t n;
    if (mix_mode == ENG_MIX_FBNEO) n = fb_len;
    else { acc += SPF_NUM; n = (uint32_t)(acc / SPF_DEN); acc -= (uint64_t)n * SPF_DEN; }
    if (n > ENG_AUDIO_MAX) n = ENG_AUDIO_MAX;
    memset(mixL, 0, n * sizeof *mixL); memset(mixR, 0, n * sizeof *mixR);
    for (int i = 0; i < 16; ++i) {
        if (!(m->snd_key & (1u << i))) continue;
        const uint16_t *r = m->snd_regs[i];
        uint32_t start = (((uint32_t)r[3] << 16) | r[2]) - 0x400000u, end = (((uint32_t)r[11] << 16) | r[10]) - 0x400000u;
        uint32_t loop = (((uint32_t)r[9] << 16) | r[7]) - 0x400000u;
        uint32_t step = mix_mode == ENG_MIX_FBNEO ? (r[6] * fb_delta) >> 12 : r[6];
        int32_t vl = (int16_t)r[15], vr = (int16_t)r[14];
        uint32_t pos = m->snd_pos[i], frac = m->snd_frac[i];
        for (uint32_t j = 0; j < n; ++j) {
            pos += frac >> 12; frac &= 0xFFF;
            if (start + pos >= end) { if (r[5]) pos = loop - start; else break; }
            uint32_t a = (start + pos) ^ 1;
            int32_t s = a < data_size ? (int8_t)data[a] : 0;
            frac += step;
            mixL[j] += (s * vl) >> 8; mixR[j] += (s * vr) >> 8;
        }
        m->snd_pos[i] = pos; m->snd_frac[i] = (uint16_t)frac;
    }
    for (uint32_t j = 0; j < n; ++j) {
        int32_t l = mixL[j] < -32768 ? -32768 : mixL[j] > 32767 ? 32767 : mixL[j];
        int32_t rr = mixR[j] < -32768 ? -32768 : mixR[j] > 32767 ? 32767 : mixR[j];
        audio[2 * j] = (int16_t)l; audio[2 * j + 1] = (int16_t)rr;
    }
    return n;
}

/* Speedhack idle meter: the slice position at which the task-0 poll suspended the CPU. */
static void eng_on_access(Sh2 *s, uint32_t ea, int size, int write, uint32_t v) {
    Machine *m = (Machine *)s->user;
    int was = m->suspend;
    mc_on_access(s, ea, size, write, v);
    if (!was && m->suspend) busy_now += m->cycles_to_run - (uint32_t)m->icount;
    observation_access(s, ea, size, write, v);
}

static void wire(void) {
    Machine *m = &vm.machine; Sh2 *s = &m->cpu;
    m->rom = rom; m->bios = bios; m->cram = raw + RAW_CRAM;
    s->ram = m->ram; s->rom = m->rom; s->ss = m->ss; s->mirrors = 1; s->user = m;
    s->io_rd = io_rd; s->io_wr = video_write; s->on_access = eng_on_access; s->fbneo_slots = 1; s->allow_macw = 1;
    s->on_exec = NULL; s->on_branch = NULL; s->native_call = NULL; s->native_jump = NULL;
    vm.data = data; vm.data_size = data_size;
    observation_reset();
}

/* FBNeo Cps3PatchRegion for sfiii3 with dip = 0x01 (Japan, the driver default; NO CD bit clear). */
API(eng_patch_bios) void eng_patch_bios(uint8_t *b, uint32_t dip) {
    b[0x1FECB] = (uint8_t)((b[0x1FECB] & 0xF0) | (dip & 0x7F));
    if (dip & 0x10) b[0x1FECC] |= 0x01; else b[0x1FECC] &= 0xFE;
}

/* Images: program (16 MiB, decrypted, logical order), BIOS (512 KiB, decrypted, logical order,
 * already patched by the caller as wanted), data (64 MiB of interleaved SIMM 3-6). Ownership stays
 * with the caller (allocate with eng_alloc). */
API(eng_set_images) int eng_set_images(uint8_t *program, uint8_t *bios_image, uint8_t *data_image, uint32_t data_bytes) {
    rom = program; bios = bios_image; data = data_image; data_size = data_bytes;
    observation_images();
    if (!raw) raw = (uint8_t *)calloc(1, RAW_SIZE);
    return raw ? 0 : -1;
}

static int start_from_raw(void) {
    if (video_load(&vm, raw, RAW_SIZE, rom, bios, data, data_size)) return -1;
    memset(vf.pixel, 0, sizeof vf.pixel);
    wire();
    memset(&meters, 0, sizeof meters); acc = 0; frame_no = 0; loaded = 1;
    fb_params();
    return 0;
}

/* Power on. eeprom: 0x400 bytes in FBNeo's host order (an .nv payload / savestate block) or NULL. */
API(eng_cold_boot) int eng_cold_boot(const uint8_t *eeprom) {
    if (!rom || !bios || !raw) return -2;
    memset(raw, 0, RAW_SIZE);
    if (eeprom) memcpy(raw + RAW_EEPROM, eeprom, 0x400);
    uint8_t *d = raw + RAW_DRV;
    uint32_t pc = rd_be(rom, 0, 4), sp = rd_be(rom, 4, 4);
    for (int i = 0; i < 4; ++i) { d[4 + i] = (uint8_t)(pc >> 8 * i); d[32 + 60 + i] = (uint8_t)(sp >> 8 * i); }
    d[12] = 0xF0;                                       /* SR = I mask */
    d[20 + 3] = 0x06;                                   /* VBR = 06000000 (Sh2SetVBR) */
    memset(d + 2348, 0xFF, 4);                          /* internal_irq_level = -1 */
    d[2408] = 1;                                        /* sh2_eat_cycles (kept by Sh2Reset; not read by the machine) */
    raw[RAW_SPR + 0x80000 + 3] = 0x80;                  /* DMA sprite-list buffer starts with the end marker 80000000 */
    /* With a blank chip this payload equals FBNeo's own power-on savestate byte for byte (GM3, frame 0). */
    return start_from_raw();
}

/* Resume an FBNeo sfiii3nr1 savestate payload (zlib-decompressed .fs body, RAW_SIZE bytes). */
API(eng_load_fbneo) int eng_load_fbneo(const uint8_t *state, uint32_t n) {
    if (!rom || !bios || !raw || n != RAW_SIZE) return -2;
    memcpy(raw, state, RAW_SIZE);
    return start_from_raw();
}

/* vf.pixel is FBNeo's persistent intermediate bitmap (renderer.h video_render); it is part of a snapshot. */
static void render(void) {
    int keep = vm.error;
    uint32_t zoom = video_reg(&vm.machine, 27) & 255;
    if (zoom > 128) zoom = 128;
    meters.zoom = zoom;
    uint64_t s0 = vm.sprites, b0 = vm.blended;
    vm.error = 0;
    int rc = video_render(&vm, &vf, 0);                 /* zoom 0: -1 with FBNeo's picture drawn */
    meters.render_error = zoom && rc ? (uint32_t)vm.error : 0;
    meters.sprites = (uint32_t)(vm.sprites - s0); meters.blended = (uint32_t)(vm.blended - b0);
    vm.error = keep;
    for (int i = 0; i < VIDEO_WIDTH * VIDEO_HEIGHT; ++i)
        rgba[i] = 0xFF000000u | (uint32_t)vf.rgb[3 * i + 2] << 16 | (uint32_t)vf.rgb[3 * i + 1] << 8 | vf.rgb[3 * i];
}

/* One frame. p01 = input words 0 and 1 (word 1 in the high half), p23 = words 2 and 3; bits are
 * "pressed" (the machine inverts them, as FBNeo's Cps3Input). flags bit 0: render; bit 1: no sound.
 * Returns 0, or the CPU fault code. */
API(eng_frame) uint32_t eng_frame(uint32_t p01, uint32_t p23, uint32_t flags) {
    if (!loaded) return 0xFFFFFFFFu;
    Machine *m = &vm.machine;
    if (m->cpu.fault) return m->cpu.fault;
    uint16_t in[4] = {(uint16_t)p01, (uint16_t)(p01 >> 16), (uint16_t)p23, (uint16_t)(p23 >> 16)};
    uint64_t ov = m->slice_overruns, cd = m->char_dma, pd = m->pal_dma, sd = m->spr_dma, i10 = m->irq_taken[10], i12 = m->irq_taken[12];
    busy_now = 0;
    if (run_frame(m, in)) {
        meters.fault = m->cpu.fault; meters.fault_pc = m->cpu.fault_pc; meters.fault_addr = m->cpu.fault_addr; meters.fault_op = m->cpu.fault_op;
        return m->cpu.fault ? m->cpu.fault : 0xFFFFFFFEu;
    }
    frame_no++;
    meters.frame = frame_no; meters.version = ENG_VERSION;
    meters.overruns = (uint32_t)(m->slice_overruns - ov);
    meters.busy_cycles = busy_now + meters.overruns * SLICE;
    meters.slice_cycles = SLICE;
    meters.char_dma = (uint32_t)(m->char_dma - cd); meters.pal_dma = (uint32_t)(m->pal_dma - pd); meters.spr_dma = (uint32_t)(m->spr_dma - sd);
    meters.irq10 = (uint32_t)(m->irq_taken[10] - i10); meters.irq12 = (uint32_t)(m->irq_taken[12] - i12);
    meters.steps_lo = (uint32_t)m->steps; meters.steps_hi = (uint32_t)(m->steps >> 32);
    meters.onchip_unmodelled = (uint32_t)m->onchip_unmodelled;
    uint32_t n = mix_frame();                            /* silent frames still advance the voices */
    meters.audio_samples = (flags & 2) ? 0 : n;
    if (flags & 1) render();
    return 0;
}

API(eng_render) void eng_render(void) { if (loaded) render(); }

API(eng_rgba) uint32_t *eng_rgba(void) { return rgba; }
API(eng_rgb) uint8_t *eng_rgb(void) { return vf.rgb; }
API(eng_audio) int16_t *eng_audio(void) { return audio; }
API(eng_meters) Meters *eng_meters(void) { return &meters; }
API(eng_ram) uint8_t *eng_ram(void) { return vm.machine.ram; }          /* 02000000, big-endian bytes */
API(eng_score_ram) uint8_t *eng_score_ram(void) { return vm.machine.ss; }
API(eng_sprite_ram) uint8_t *eng_sprite_ram(void) { return vm.machine.spr; }
API(eng_palette_ram) uint8_t *eng_palette_ram(void) { return vm.machine.pal; }
API(eng_video_regs) uint8_t *eng_video_regs(void) { return vm.machine.vreg; }
API(eng_char_ram) uint8_t *eng_char_ram(void) { return raw ? raw + RAW_CRAM : NULL; }   /* host order (byte ^ 3) */
API(eng_eeprom) uint8_t *eng_eeprom(void) { return vm.machine.eeprom; }
API(eng_sound_regs) uint16_t *eng_sound_regs(void) { return &vm.machine.snd_regs[0][0]; }   /* 16 voices x 16 register words (040E0000) */
API(eng_sound_key) uint32_t eng_sound_key(void) { return vm.machine.snd_key; }            /* key mask (040E0200) */
API(eng_program) uint8_t *eng_program(void) { return rom; }
API(eng_frame_number) uint32_t eng_frame_number(void) { return frame_no; }
API(eng_pc) uint32_t eng_pc(void) { return vm.machine.cpu.pc; }

static uint64_t fnv64(const uint8_t *p, size_t n, uint64_t h) { while (n--) h = (h ^ *p++) * 1099511628211ull; return h; }
API(eng_hash_ram) uint64_t eng_hash_ram(void) { return fnv64(vm.machine.ram, sizeof vm.machine.ram, 1469598103934665603ull); }
API(eng_hash_rgb) uint64_t eng_hash_rgb(void) { return fnv64(vf.rgb, sizeof vf.rgb, 1469598103934665603ull); }

/* ---- snapshots ---- */
typedef struct {
    uint32_t magic, version, bytes, frame;
    uint64_t acc;
    uint32_t mix_mode, mix_rate, mix_fps100, loaded;
    VideoMachine vm;
} SnapHead;
enum { CRAM_BYTES = 0x800000, SCREEN_BYTES = (int)sizeof vf.pixel };

/* head + character RAM + the screen bitmap (render history: restored with the machine, left out of eng_hash_state) */
API(eng_snapshot_size) uint32_t eng_snapshot_size(void) { return (uint32_t)(sizeof(SnapHead) + CRAM_BYTES + SCREEN_BYTES); }

API(eng_save) uint32_t eng_save(uint8_t *out) {
    SnapHead *h = (SnapHead *)out;
    memset(h, 0, sizeof *h);
    h->magic = SNAP_MAGIC; h->version = ENG_VERSION; h->bytes = eng_snapshot_size(); h->frame = frame_no;
    h->acc = acc; h->mix_mode = mix_mode; h->mix_rate = mix_rate; h->mix_fps100 = mix_fps100; h->loaded = (uint32_t)loaded;
    memcpy(&h->vm, &vm, sizeof vm);
    /* pointers and callbacks are re-made on restore; clear them so equal states give equal bytes */
    Machine *m = &h->vm.machine; Sh2 *s = &m->cpu;
    m->rom = NULL; m->bios = NULL; m->cram = NULL; h->vm.data = NULL;
    s->ram = NULL; s->rom = NULL; s->ss = NULL; s->user = NULL; s->allow = NULL;
    s->on_exec = NULL; s->on_branch = NULL; s->on_access = NULL; s->native_call = NULL; s->native_jump = NULL; s->io_rd = NULL; s->io_wr = NULL;
    memcpy(out + sizeof *h, raw + RAW_CRAM, CRAM_BYTES);
    memcpy(out + sizeof *h + CRAM_BYTES, vf.pixel, SCREEN_BYTES);
    return h->bytes;
}

API(eng_restore) int eng_restore(const uint8_t *in) {
    const SnapHead *h = (const SnapHead *)in;
    if (h->magic != SNAP_MAGIC || h->version != ENG_VERSION || h->bytes != eng_snapshot_size() || !raw) return -1;
    memcpy(&vm, &h->vm, sizeof vm);
    memcpy(raw + RAW_CRAM, in + sizeof *h, CRAM_BYTES);
    memcpy(vf.pixel, in + sizeof *h + CRAM_BYTES, SCREEN_BYTES);
    frame_no = h->frame; acc = h->acc; mix_mode = h->mix_mode; mix_rate = h->mix_rate; mix_fps100 = h->mix_fps100; loaded = (int)h->loaded;
    fb_params();
    wire();
    return 0;
}

/* Hash of the whole emulated state as a snapshot holds it (pointers excluded). */
API(eng_hash_state) uint64_t eng_hash_state(uint8_t *scratch) {
    uint32_t n = eng_save(scratch);
    SnapHead *h = (SnapHead *)scratch;
    h->vm.sprites = h->vm.blended = h->vm.tile_lines = 0;   /* render statistics are not state */
    return fnv64(scratch, n - SCREEN_BYTES, 1469598103934665603ull);   /* nor is the screen bitmap (render history) */
}

#include "inspection.h"
