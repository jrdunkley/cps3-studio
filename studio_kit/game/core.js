/* Cps3GameCore: the engine glue (CPS3 Studio · Game). One wasm instance of the exact CPS3 machine
 * (engine_wasm.js, built by build.py) and typed views over its memory. The same source runs in Node
 * (gate runners), in a page and inside the engine worker (cps3game.js stringifies `factory`).
 *
 *   const core = await Cps3GameCore.create(wasmBytes)
 *   core.setImages(program, bios, data, { biosDip })   decrypted program (16 MiB), decrypted BIOS (512 KiB), interleaved SIMM 3-6 (64 MiB)
 *   core.coldBoot(eeprom | null)                        power on; eeprom = 0x400 bytes in FBNeo's order (.nv payload) or null = factory
 *   core.loadFbneo(rawPayload)                          resume an FBNeo savestate body
 *   core.frame(p01, p23, flags) -> fault (0 = ok)       flags: 1 render, 2 silent
 *   core.rgba() / core.audio() / core.meters() / core.ram() / core.soundRegs() ...   views (valid until the next call)
 *   core.save() -> Uint8Array, core.restore(bytes)      whole-machine snapshots
 *   core.saveView()                                     the same snapshot as a view of the engine's buffer (no copy)
 * The user's ROM never leaves the computer; nothing here contains ROM data.
 */
(function (g) {
  'use strict';
  function factory() {
    const METERS = ['version', 'frame', 'fault', 'faultPc', 'faultAddr', 'faultOp', 'busyCycles', 'overruns', 'charDma', 'palDma', 'sprDma', 'audioSamples',
      'renderError', 'zoom', 'sprites', 'blended', 'stepsLo', 'stepsHi', 'irq10', 'irq12', 'sliceCycles', 'onchipUnmodelled'];
    const SIZES = { program: 0x1000000, bios: 0x80000, data: 0x4000000 };
    const hex64 = (v) => BigInt.asUintN(64, v).toString(16).padStart(16, '0');

    /* The module imports only fd_write / fd_seek / fd_close (stderr text from the machine on a bad state). */
    function wasi(memory, log) {
      let text = '';
      return {
        fd_write(fd, iovs, n, written) {
          const m = new DataView(memory().buffer); let total = 0;
          for (let i = 0; i < n; i++) {
            const p = m.getUint32(iovs + 8 * i, true), len = m.getUint32(iovs + 8 * i + 4, true);
            text += new TextDecoder().decode(new Uint8Array(memory().buffer, p, len)); total += len;
          }
          m.setUint32(written, total, true);
          let nl; while ((nl = text.indexOf('\n')) >= 0) { log(text.slice(0, nl)); text = text.slice(nl + 1); }
          return 0;
        },
        fd_seek() { return 70; },          /* ESPIPE */
        fd_close() { return 0; },
      };
    }

    async function create(wasmBytes, opts = {}) {
      let instance = null;
      const memory = () => instance.exports.memory;
      const log = opts.log || ((line) => { if (typeof console !== 'undefined') console.warn('[cps3 engine] ' + line); });
      const result = await WebAssembly.instantiate(wasmBytes, { wasi_snapshot_preview1: wasi(memory, log) });
      instance = result.instance || result;
      const x = instance.exports;
      if (x._initialize) x._initialize();
      const u8 = (p, n) => new Uint8Array(memory().buffer, p, n);
      const ptr = {};
      function place(name, bytes, size) {
        if (!(bytes instanceof Uint8Array) || bytes.length !== size) throw new Error(`The ${name} image must be ${size} bytes.`);
        if (!ptr[name]) ptr[name] = x.eng_alloc(size);
        u8(ptr[name], size).set(bytes);
      }
      const core = {
        exports: x,
        setImages(program, bios, data, o = {}) {
          place('program', program, SIZES.program); place('bios', bios, SIZES.bios); place('data', data, SIZES.data);
          if (o.biosDip !== null) x.eng_patch_bios(ptr.bios, o.biosDip === undefined ? 1 : o.biosDip);   /* FBNeo's reset-time region / NO CD patch */
          if (x.eng_set_images(ptr.program, ptr.bios, ptr.data, SIZES.data)) throw new Error('The engine could not take the images.');
        },
        coldBoot(eeprom) {
          let p = 0;
          if (eeprom) { if (eeprom.length !== 0x400) throw new Error('The settings block must be 1024 bytes.'); p = x.eng_alloc(0x400); u8(p, 0x400).set(eeprom); }
          const rc = x.eng_cold_boot(p); if (p) x.eng_free(p);
          if (rc) throw new Error('Power-on failed (' + rc + ').');
        },
        loadFbneo(raw) {
          const p = x.eng_alloc(raw.length); u8(p, raw.length).set(raw);
          const rc = x.eng_load_fbneo(p, raw.length); x.eng_free(p);
          if (rc) throw new Error('This savestate is not an sfiii3nr1 machine state the engine can resume (' + rc + ').');
        },
        audioMode(mode, rate, fps100) { return x.eng_audio_mode(mode === 'fbneo' ? 1 : 0, rate || 0, fps100 || 0); },
        frame(p01, p23, flags) { return x.eng_frame(p01 >>> 0, p23 >>> 0, flags >>> 0) >>> 0; },
        render() { x.eng_render(); },
        inspectPixel(px,py) {
          if(!Number.isInteger(px)||!Number.isInteger(py)||px<0||px>=384||py<0||py>=224)throw new Error('Pixel is outside the game picture.');
          if(!x.eng_inspect_pixel)throw new Error('This engine has no pixel inspection.');
          const ptr=x.eng_inspect_pixel(px,py);if(!ptr)throw new Error('The game has not started.');
          const raw=new Uint32Array(memory().buffer,ptr,12+64*17),keys=['x','y','fieldX','fieldY','zoom','width','height','count','truncated','matches','rgb','index'];
          const out={};keys.forEach((k,i)=>out[k]=raw[i]);out.matches=!!out.matches;out.contributors=[];
          const fields=['kind','main','sub','map','cellAddress','cell','tile','palette','pen','bits','flip','blend','sourceX','sourceY','charAddress','index','buffered'];
          for(let i=0;i<out.count;i++){const p={};fields.forEach((k,j)=>p[k]=raw[12+i*17+j]);p.kind=['clear','retained','sprite','map','score'][p.kind];if(p.kind==='sprite'&&!p.buffered)p.owner=core.observationOwner(p.main);out.contributors.push(p);}
          return out;
        },
        observe(enabled=true) { return !!x.eng_observe?.(enabled?1:0); },
        observationOwner(main) {
          const p=x.eng_observation_owner?.(main);if(!p)return null;
          const raw=new Uint32Array(memory().buffer,p,20),keys=['valid','work','node','submitted','emitted','workId','objectId','type','charset','master','script','scriptIndex','cel','playerId','x','y','z'],out={};
          keys.forEach((k,i)=>out[k]=raw[i]);out.record=Array.from(raw.subarray(17));
          for(const k of ['workId','objectId','scriptIndex','playerId','x','y','z'])out[k]=(out[k]<<16)>>16;
          return out;
        },
        saveInspection() { return x.eng_observation_save?u8(x.eng_observation_save(),x.eng_observation_size()).slice():null; },
        restoreInspection(bytes) {
          if(!bytes||!x.eng_observation_restore)return false;
          const p=x.eng_alloc(bytes.length);u8(p,bytes.length).set(bytes);const rc=x.eng_observation_restore(p,bytes.length);x.eng_free(p);
          if(rc)throw new Error('This inspection cache is damaged or belongs to another source.');return true;
        },
        rgba() { return new Uint8ClampedArray(memory().buffer, x.eng_rgba(), 384 * 224 * 4); },
        rgb() { return u8(x.eng_rgb(), 384 * 224 * 3); },
        audio() { const n = core.meters().audioSamples; return new Int16Array(memory().buffer, x.eng_audio(), n * 2); },
        meters() { const v = new Uint32Array(memory().buffer, x.eng_meters(), METERS.length), o = {}; METERS.forEach((k, i) => { o[k] = v[i]; }); return o; },
        ram() { return u8(x.eng_ram(), 0x80000); },
        scoreRam() { return u8(x.eng_score_ram(), 0x10000); },
        spriteRam() { return u8(x.eng_sprite_ram(), 0x80000); },
        paletteRam() { return u8(x.eng_palette_ram(), 0x40000); },
        videoRegs() { return u8(x.eng_video_regs(), 0x100); },
        charRam() { return u8(x.eng_char_ram(), 0x800000); },
        eeprom() { return u8(x.eng_eeprom(), 0x400); },
        soundRegs() { return new Uint16Array(memory().buffer, x.eng_sound_regs(), 256); },   /* voice v register r at [v * 16 + r] */
        soundKey() { return x.eng_sound_key() >>> 0; },
        program() { return u8(x.eng_program(), SIZES.program); },
        frameNumber() { return x.eng_frame_number() >>> 0; },
        hashRam() { return hex64(x.eng_hash_ram()); },
        hashRgb() { return hex64(x.eng_hash_rgb()); },
        snapshotSize() { return x.eng_snapshot_size() >>> 0; },
        save() { const n = core.snapshotSize(); if (!ptr.snap) ptr.snap = x.eng_alloc(n); x.eng_save(ptr.snap); return u8(ptr.snap, n).slice(); },
        saveView() { const n = core.snapshotSize(); if (!ptr.snap) ptr.snap = x.eng_alloc(n); x.eng_save(ptr.snap); return u8(ptr.snap, n); },   /* no copy: valid until the next save/restore/hashState */
        restore(bytes) { const n = core.snapshotSize(); if (bytes.length !== n) throw new Error('This snapshot is from a different engine build.'); if (!ptr.snap) ptr.snap = x.eng_alloc(n); u8(ptr.snap, n).set(bytes); if (x.eng_restore(ptr.snap)) throw new Error('This snapshot is damaged or from a different engine build.'); },
        hashState() { const n = core.snapshotSize(); if (!ptr.snap) ptr.snap = x.eng_alloc(n); return hex64(x.eng_hash_state(ptr.snap)); },
      };
      return core;
    }

    /* Input words (FBNeo d_cps3.cpp / validate_episode.py): (word, bit) per control, "pressed" bits. */
    const P1 = { up: [0, 0], down: [0, 1], left: [0, 2], right: [0, 3], lp: [0, 4], mp: [0, 5], hp: [0, 6], lk: [3, 3], mk: [3, 2], hk: [3, 1], start: [1, 12], coin: [1, 8] };
    const P2 = { up: [0, 8], down: [0, 9], left: [0, 10], right: [0, 11], lp: [0, 12], mp: [0, 13], hp: [0, 14], lk: [3, 4], mk: [3, 5], hk: [1, 10], start: [1, 13], coin: [1, 9] };
    const SYSTEM = { service: [1, 0], test: [1, 1] };
    /* mask bit order of the recorded episodes: Up Down Left Right LP MP HP LK MK HK Start Coin */
    const MASK_ORDER = ['up', 'down', 'left', 'right', 'lp', 'mp', 'hp', 'lk', 'mk', 'hk', 'start', 'coin'];
    function words(p1, p2, sys) {
      const w = [0, 0, 0, 0];
      const add = (table, pressed) => { for (const k of pressed || []) { const e = table[k]; if (e) w[e[0]] |= 1 << e[1]; } };
      add(P1, p1); add(P2, p2); add(SYSTEM, sys);
      return { p01: (w[0] | (w[1] << 16)) >>> 0, p23: (w[2] | (w[3] << 16)) >>> 0, words: w };
    }
    function fromMasks(m1, m2) {
      const names = (m) => MASK_ORDER.filter((k, i) => (m >> i) & 1);
      return words(names(m1), names(m2));
    }
    /* A scripted run as per-frame input words: steps { wait: n } | { press: ['p1.lp', 'p2.start', 'test'], frames: n, then: m }
       (other step kinds, e.g. { shot }, take no frames). Returns [[p01, p23], ...]. */
    function framesOf(steps) {
      const out = [], none = [0, 0];
      for (const s of steps) {
        for (let i = 0; i < (s.wait || 0); i++) out.push(none);
        if (s.press) {
          const p1 = [], p2 = [], sys = [];
          for (const n of s.press) { const [who, k] = n.includes('.') ? n.split('.') : ['sys', n]; (who === 'p1' ? p1 : who === 'p2' ? p2 : sys).push(k); }
          const w = words(p1, p2, sys);
          for (let i = 0; i < (s.frames || 1); i++) out.push([w.p01, w.p23]);
          for (let i = 0; i < (s.then || 0); i++) out.push(none);
        }
      }
      return out;
    }
    return { create, words, fromMasks, framesOf, P1, P2, SYSTEM, MASK_ORDER, SIZES, hex64 };
  }
  const api = factory();
  api.factory = factory;
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else g.Cps3GameCore = api;
})(typeof self !== 'undefined' ? self : this);
