/* Native gate runner for the Game engine (engine.c compiled in, unchanged). The Node runner
 * checks/engine_run.mjs drives the browser's wasm build through the same calls and prints the same
 * lines, so the two outputs compare byte for byte.
 *
 * engine_cli <program> <bios_dec> <data> <start> <inputs|-> <frames> [options]
 *   start:   cold:<eeprom.bin>  | cold:blank  | state:<raw payload>
 *   inputs:  text, one frame per line "w0 w1 w2 w3" (pressed bits); missing lines = no input
 *   options: --render N        render every Nth frame (0 = never; default 1)
 *            --mix chip|fbneo:<rate>[:<fps100>]
 *            --ref-ram <file>  FBNeo main RAM, 512 KiB per frame: compare every frame byte for byte
 *            --dump-ram <file> write main RAM after every frame
 *            --wav <file>      write the mixed audio
 *            --rgb-at <frame> <file>  write that frame's RGB
 *            --snap <K>        snapshot after frame K, finish, restore, re-run K+1..end: hashes must match;
 *                              then a corrupted restore (one RAM byte flipped) must differ
 *            --no-bios-patch   use the BIOS as given (FBNeo patches region/NO CD at reset)
 *            --stream          lockstep for the video gate: read "advance w0 w1 w2 w3" lines, after each write
 *                              the video gate's packet (native/video/video.c layout); frames/inputs are ignored
 *            --dump-start <f>  write the start payload (RAW_SIZE bytes) before the first frame
 * stdout: one line per frame "F n ram rgb audio busy overruns chardma paldma sprdma samples", then a summary.
 */
#include "engine.c"
#include <stdarg.h>
#ifdef _WIN32
#include <io.h>
#include <fcntl.h>
#endif

static uint8_t *must_read(const char *p, size_t *n) {
    uint8_t *b = mc_read_file(p, n);
    if (!b) { fprintf(stderr, "cannot read %s\n", p); exit(2); }
    return b;
}

static int read_inputs(FILE *in, uint32_t *p01, uint32_t *p23) {
    unsigned a, b, c, d;
    *p01 = *p23 = 0;
    if (!in || fscanf(in, "%u %u %u %u", &a, &b, &c, &d) != 4) return 0;
    *p01 = (a & 0xFFFF) | (b & 0xFFFF) << 16; *p23 = (c & 0xFFFF) | (d & 0xFFFF) << 16;
    return 1;
}

static uint64_t fnv_audio(uint32_t n) { return fnv64((const uint8_t *)audio, n * 4, 1469598103934665603ull); }

int main(int argc, char **argv) {
    if (argc < 7) { fprintf(stderr, "usage: engine_cli program bios_dec data start inputs frames [options]\n"); return 2; }
    size_t nr, nb, nd;
    uint8_t *program = must_read(argv[1], &nr), *b = must_read(argv[2], &nb), *dat = must_read(argv[3], &nd);
    if (nr != 0x1000000 || nb != 0x80000 || nd != 0x4000000) { fprintf(stderr, "image sizes %zu %zu %zu\n", nr, nb, nd); return 2; }
    const char *start = argv[4], *inputs = argv[5];
    int frames = atoi(argv[6]), every = 1, snap_at = -1, bios_patch = 1, rgb_at = -1;
    const char *ref = NULL, *dump = NULL, *wav = NULL, *rgb_path = NULL, *dump_start = NULL; int stream = 0;
    uint32_t mode = ENG_MIX_CHIP, rate = 48000, fps = 5959;
    for (int i = 7; i < argc; ++i) {
        if (!strcmp(argv[i], "--render") && i + 1 < argc) every = atoi(argv[++i]);
        else if (!strcmp(argv[i], "--ref-ram") && i + 1 < argc) ref = argv[++i];
        else if (!strcmp(argv[i], "--dump-ram") && i + 1 < argc) dump = argv[++i];
        else if (!strcmp(argv[i], "--wav") && i + 1 < argc) wav = argv[++i];
        else if (!strcmp(argv[i], "--snap") && i + 1 < argc) snap_at = atoi(argv[++i]);
        else if (!strcmp(argv[i], "--rgb-at") && i + 2 < argc) { rgb_at = atoi(argv[++i]); rgb_path = argv[++i]; }
        else if (!strcmp(argv[i], "--no-bios-patch")) bios_patch = 0;
        else if (!strcmp(argv[i], "--stream")) stream = 1;
        else if (!strcmp(argv[i], "--dump-start") && i + 1 < argc) dump_start = argv[++i];
        else if (!strcmp(argv[i], "--mix") && i + 1 < argc) {
            const char *m = argv[++i];
            if (!strncmp(m, "fbneo", 5)) { mode = ENG_MIX_FBNEO; if (m[5] == ':') { rate = (uint32_t)atoi(m + 6); const char *f = strchr(m + 6, ':'); if (f) fps = (uint32_t)atoi(f + 1); } }
        } else { fprintf(stderr, "unknown option %s\n", argv[i]); return 2; }
    }
    if (bios_patch) eng_patch_bios(b, 0x01);
    if (eng_set_images(program, b, dat, (uint32_t)nd)) return 2;
    int rc;
    if (!strncmp(start, "cold:", 5)) {
        uint8_t ee[0x400] = {0};
        if (strcmp(start + 5, "blank")) { size_t ne; uint8_t *e = must_read(start + 5, &ne); if (ne != 0x400) { fprintf(stderr, "eeprom size %zu\n", ne); return 2; } memcpy(ee, e, 0x400); free(e); }
        rc = eng_cold_boot(ee);
    } else if (!strncmp(start, "state:", 6)) {
        size_t ns; uint8_t *s = must_read(start + 6, &ns);
        rc = eng_load_fbneo(s, (uint32_t)ns); free(s);
    } else { fprintf(stderr, "start must be cold:... or state:...\n"); return 2; }
    if (rc) { fprintf(stderr, "start failed %d\n", rc); return 3; }
    eng_audio_mode(mode, rate, fps);
    if (dump_start) { FILE *o = fopen(dump_start, "wb"); if (!o) return 2; fwrite(raw, 1, RAW_SIZE, o); fclose(o); }
    if (stream) {
#ifdef _WIN32
        _setmode(_fileno(stdout), _O_BINARY);
#endif
        unsigned adv, a, bb, c, dd;
        while (scanf("%u %u %u %u %u", &adv, &a, &bb, &c, &dd) == 5) {
            if (adv) { uint32_t f = eng_frame((a & 0xFFFF) | (bb & 0xFFFF) << 16, (c & 0xFFFF) | (dd & 0xFFFF) << 16, 1); if (f) { fprintf(stderr, "CPU fault %u at %08X\n", f, meters.fault_pc); return 4; } }
            else eng_render();
            Machine *m = &vm.machine;
            fwrite(m->ram, 1, sizeof m->ram, stdout); fwrite(m->spr, 1, sizeof m->spr, stdout); fwrite(vm.list, 1, sizeof vm.list, stdout);
            fwrite(m->ss, 1, sizeof m->ss, stdout); fwrite(m->vreg, 1, sizeof m->vreg, stdout); fwrite(m->pal, 1, sizeof m->pal, stdout);
            fwrite(m->cram, 1, 0x800000, stdout);
            uint32_t regs[] = {vm.ss_bank, vm.ss_palette, m->cram_bank, vm.flash_bank, vm.palette_source, vm.palette_dest, vm.fade, vm.palette_length, m->chardma_source, m->chardma_table, m->spritelist_dma};
            for (unsigned i = 0; i < sizeof regs / sizeof *regs; ++i) { uint8_t q[4]; wr_be(q, 0, 4, regs[i]); fwrite(q, 1, 4, stdout); }
            fwrite(vf.rgb, 1, sizeof vf.rgb, stdout); fflush(stdout);
        }
        fprintf(stderr, "stream end frame %u char_dma %u pal_dma %u spr_dma %u\n", eng_frame_number(), meters.char_dma, meters.pal_dma, meters.spr_dma);
        return 0;
    }

    FILE *in = strcmp(inputs, "-") ? fopen(inputs, "r") : NULL;
    if (strcmp(inputs, "-") && !in) { fprintf(stderr, "cannot read %s\n", inputs); return 2; }
    FILE *rf = ref ? fopen(ref, "rb") : NULL, *df = dump ? fopen(dump, "wb") : NULL, *wf = wav ? fopen(wav, "wb") : NULL;
    if ((ref && !rf) || (dump && !df) || (wav && !wf)) { fprintf(stderr, "cannot open an output/reference\n"); return 2; }
    uint8_t hdr[44] = {0}; if (wf) fwrite(hdr, 1, 44, wf);
    static uint8_t want[0x80000];
    uint32_t *p01s = calloc((size_t)frames + 1, 4), *p23s = calloc((size_t)frames + 1, 4);
    uint64_t *hr = calloc((size_t)frames + 1, 8), *hg = calloc((size_t)frames + 1, 8), *ha = calloc((size_t)frames + 1, 8);
    uint8_t *snap = NULL; uint64_t total_samples = 0; int ref_bad = 0, ref_first = 0, ref_frames = 0;
    for (int f = 1; f <= frames; ++f) {
        read_inputs(in, &p01s[f], &p23s[f]);
        int draw = every > 0 && (f % every == 0 || f == rgb_at);
        uint32_t fault = eng_frame(p01s[f], p23s[f], draw ? 1 : 0);
        if (fault) { printf("FAULT frame %d code %u pc %08X addr %08X op %04X\n", f, fault, meters.fault_pc, meters.fault_addr, meters.fault_op); return 4; }
        hr[f] = eng_hash_ram(); hg[f] = draw ? eng_hash_rgb() : 0; ha[f] = fnv_audio(meters.audio_samples);
        total_samples += meters.audio_samples;
        printf("F %d %016llx %016llx %016llx %u %u %u %u %u %u\n", f, (unsigned long long)hr[f], (unsigned long long)hg[f], (unsigned long long)ha[f],
               meters.busy_cycles, meters.overruns, meters.char_dma, meters.pal_dma, meters.spr_dma, meters.audio_samples);
        if (df) fwrite(vm.machine.ram, 1, 0x80000, df);
        if (wf) fwrite(audio, 4, meters.audio_samples, wf);
        if (f == rgb_at && rgb_path) { FILE *o = fopen(rgb_path, "wb"); if (o) { fwrite(vf.rgb, 1, sizeof vf.rgb, o); fclose(o); } }
        if (rf) {
            if (fread(want, 1, sizeof want, rf) != sizeof want) { printf("REF short at frame %d\n", f); ref_bad++; if (!ref_first) ref_first = f; fclose(rf); rf = NULL; }
            else {
                ref_frames++;
                if (memcmp(want, vm.machine.ram, sizeof want)) {
                    if (!ref_first) { ref_first = f; for (int i = 0; i < 0x80000; ++i) if (want[i] != vm.machine.ram[i]) { printf("REF first difference frame %d at %08X want %02X got %02X\n", f, 0x02000000 + i, want[i], vm.machine.ram[i]); break; } }
                    ref_bad++;
                }
            }
        }
        if (f == snap_at) { snap = malloc(eng_snapshot_size()); eng_save(snap); }
    }
    printf("SUMMARY frames %d ram_last %016llx samples %llu unmapped %u onchip_unmodelled %u render_errors_last %u\n", frames, (unsigned long long)hr[frames],
           (unsigned long long)total_samples, vm.machine.cpu.unmapped_reads, meters.onchip_unmodelled, meters.render_error);
    if (ref) printf("REF frames_compared %d differing %d first %d\n", ref_frames, ref_bad, ref_first);
    int snap_ok = 1;
    if (snap) {
        /* restore and re-run: every later frame must hash the same */
        uint8_t *copy = malloc(eng_snapshot_size());
        memcpy(copy, snap, eng_snapshot_size());
        if (eng_restore(snap)) { printf("SNAP restore refused\n"); return 5; }
        int diff = 0;
        for (int f = snap_at + 1; f <= frames; ++f) {
            int draw = every > 0 && f % every == 0;
            eng_frame(p01s[f], p23s[f], draw ? 1 : 0);
            if (eng_hash_ram() != hr[f] || (draw && eng_hash_rgb() != hg[f]) || fnv_audio(meters.audio_samples) != ha[f]) { if (!diff) printf("SNAP first difference at frame %d\n", f); diff++; }
        }
        printf("SNAP restore_rerun frames %d differing %d\n", frames - snap_at, diff);
        snap_ok = diff == 0;
        /* negative control: flip one main-RAM byte in the snapshot (the game's frame counter area) */
        SnapHead *h = (SnapHead *)copy;
        h->vm.machine.ram[0x15438 + 1] ^= 0x01;
        if (eng_restore(copy)) { printf("SNAP corrupt restore refused\n"); return 5; }
        int cdiff = 0;
        for (int f = snap_at + 1; f <= frames; ++f) { eng_frame(p01s[f], p23s[f], 0); if (eng_hash_ram() != hr[f]) cdiff++; }
        printf("SNAP corrupted_restore frames %d differing %d %s\n", frames - snap_at, cdiff, cdiff ? "caught" : "NOT CAUGHT");
        snap_ok = snap_ok && cdiff > 0;
        /* negative control 2: a snapshot with a wrong magic is refused */
        h->magic ^= 1;
        printf("SNAP bad_magic %s\n", eng_restore(copy) ? "refused" : "ACCEPTED");
        snap_ok = snap_ok && eng_restore(copy) != 0;
    }
    if (wf) {
        uint32_t r = mode == ENG_MIX_FBNEO ? rate : 37287, bytes = (uint32_t)(total_samples * 4), v; uint16_t s16;
        fseek(wf, 0, SEEK_SET);
        fwrite("RIFF", 1, 4, wf); v = 36 + bytes; fwrite(&v, 4, 1, wf); fwrite("WAVEfmt ", 1, 8, wf); v = 16; fwrite(&v, 4, 1, wf);
        s16 = 1; fwrite(&s16, 2, 1, wf); s16 = 2; fwrite(&s16, 2, 1, wf); fwrite(&r, 4, 1, wf); v = r * 4; fwrite(&v, 4, 1, wf);
        s16 = 4; fwrite(&s16, 2, 1, wf); s16 = 16; fwrite(&s16, 2, 1, wf); fwrite("data", 1, 4, wf); fwrite(&bytes, 4, 1, wf); fclose(wf);
    }
    if (df) fclose(df);
    return (ref_bad || !snap_ok) ? 1 : 0;
}
