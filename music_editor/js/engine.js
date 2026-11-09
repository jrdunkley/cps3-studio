/* The music editor's playback engine: the game's own sound driver, run on sh2.js, plus the CPS3
 * sample chip. Nothing here imitates the driver; it executes the driver code from the data pack
 * (made from your ROM by the page or by `node cli/studio.js rom import`), so sequences, envelopes and every command
 * behave as they do in the game. the research project compared its register writes with the
 * reference runner checks/sndref.c.
 *
 * Driver entry points and RAM (docs/plan/02_DRIVER.md):
 *   06139310 set sample bank, 06139316 init, 061394D0 request(code), 0613A2BC request with fade-in,
 *   0613A408 per-frame update, 0613A324 set music pitch and attenuation, 061392FC set tempo offset,
 *   0613A1E8 stop music. Music channels: 16 records of 0x74 bytes from 02078D0C.
 * Chip: 16 voices x 16 register words at 040E0000, key mask at +0x200; a voice plays signed 8-bit
 * samples from start to end (looping to loop when the flag word is set) at step/4096 per output
 * sample of 37,287 Hz, mixed as (sample * volume) >> 8 per side.
 *
 * Studio additions (docs/plan/wp/A1_engine.md, gate checks/gates/g_engine.js): packs decoded once and
 * shared (Engine.preparePack, version-2 packs with bytes and a `game` address table), the stereo switch
 * (the driver init's second stack argument; Fightcade boots it off), the whole music space ("cave",
 * zero in the stock ROM) writable through patchAt / setRequest / installBank, and saved states.
 */
(function engineModule(g) {
  'use strict';
  const Sh2 = g.SF3Sh2 || require('./sh2.js').Sh2;
  const RAM_BASE = 0x02000000, RAM_SIZE = 0x80000, ROM_BASE = 0x06000000, ROM_SIZE = 0x1000000;
  const RET = 0x06FFFFF0, STACK = 0x0200C000;
  /* Where things are in sfiii3nr1. A version-2 pack may carry its own table of the same shape
   * (docs/plan/04_FORMATS.md §5); whatever it leaves out keeps these values. */
  const SFIII3NR1 = {
    fn: { setBank: 0x06139310, init: 0x06139316, request: 0x061394D0, requestFade: 0x0613A2BC, update: 0x0613A408,
          pitchVolume: 0x0613A324, tempoOffset: 0x061392FC, stopMusic: 0x0613A1E8 },
    tables: { request: 0x0678F000, samples: 0x0678C000, banks: 0x06788000 },
    requests: 3251,                                         /* request codes in the table (its first word) */
    channels: 0x02078D0C, channelSize: 0x74,
    tempo: 0x02079C14, tempoOffset: 0x02007EE8, marker: 0x02079C5C, stereoFlag: 0x02079C5B,
    cave: [0x067D2000, 0x067FFFE0],                         /* zero in the stock ROM, no code literal points into it */
  };
  const REQ_TABLE = SFIII3NR1.tables.request, SAMPLE_TABLE = SFIII3NR1.tables.samples, BANKS = SFIII3NR1.tables.banks;
  const CHANNELS = SFIII3NR1.channels, CHANNEL_SIZE = SFIII3NR1.channelSize;
  /* the music space as the Studio uses it inside its private ROM copy: two 64 KB sequence slots (the old
   * editor's preview and audition areas, unchanged) and the custom instrument bank after them */
  const SLOT = 0x10000;
  const CAVE = Object.freeze({ preview: 0x067D2000, audition: 0x067E2000, bank: 0x067F2000, end: 0x067FFFE0 });
  const SPF_NUM = 4295450000000, SPF_DEN = 6865861248;     /* chip samples per frame = (42954500/3/384) / 59.59949 */
  const CHIP_RATE = 42954500 / 3 / 384, FRAME_RATE = 59.59949;
  const hex = (v) => (v >>> 0).toString(16).toUpperCase();
  const s16 = (v) => (v << 16) >> 16;

  function b64bytes(text) {
    if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(text, 'base64'));
    const bin = atob(text), out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /* The game table of a pack: sfiii3nr1's, with whatever the pack's own `game` says on top. */
  function gameOf(pack) {
    const own = pack.game || {}, t = Object.assign({}, SFIII3NR1, own);
    t.fn = Object.assign({}, SFIII3NR1.fn, own.fn || {});
    t.tables = Object.assign({}, SFIII3NR1.tables, own.tables || {});
    t.cave = (own.cave || SFIII3NR1.cave).slice();
    return t;
  }

  /* Decode a pack once (base64 in version 1, bytes in version 2) and keep the result on the pack, out
   * of sight of JSON and structured clone. Every engine made from the pack shares the sample array: it
   * is only ever read. */
  function preparePack(pack) {
    if (pack.__prepared) return pack.__prepared;
    const prg = pack.prg.map((r) => ({ addr: r.addr, bytes: r.bytes instanceof Uint8Array ? r.bytes : b64bytes(r.b64) }));
    const raw = pack.samples instanceof Uint8Array ? pack.samples : b64bytes(pack.samples_b64);
    const game = gameOf(pack), c = game.cave;
    const prepared = { prg, samples: new Int8Array(raw.buffer, raw.byteOffset, raw.length), game,
                       cave: { preview: c[0], audition: c[0] + SLOT, bank: c[0] + 2 * SLOT, end: c[1] } };
    Object.defineProperty(pack, '__prepared', { value: prepared, enumerable: false, configurable: true });
    return prepared;
  }

  class Engine {
    constructor(pack, options) {
      options = options || {};
      const P = preparePack(pack);
      this.game = P.game; this.cave = P.cave;
      this.selfClear = options.selfClear !== false;
      this.stereo = !!options.stereo;  /* the driver's stereo switch; off is what Fightcade plays */
      this.rom = new Uint8Array(ROM_SIZE);
      this.loaded = new Uint8Array(ROM_SIZE >> 12);
      for (const region of P.prg) {
        this.rom.set(region.bytes, region.addr - ROM_BASE);
        for (let p = (region.addr - ROM_BASE) >> 12; p < (region.addr - ROM_BASE + region.bytes.length + 0xFFF) >> 12; p++) this.loaded[p] = 1;
      }
      /* the whole music space up to the end of its last page: zero in the ROM, written only by this engine's owner */
      for (let p = (this.cave.preview - ROM_BASE) >> 12; p < (this.cave.end - ROM_BASE + 0xFFF) >> 12; p++) this.loaded[p] = 1;
      const T = this.game.tables;
      this.pristine = this.rom.slice(T.request - ROM_BASE, T.request - ROM_BASE + 4 + 4 * this.game.requests);
      this.pristineBanks = this.rom.slice(T.banks - ROM_BASE, T.banks - ROM_BASE + 64);
      this.samples = P.samples;
      this.ram = new Uint8Array(RAM_SIZE);
      this.regs = new Uint16Array(256);
      this.pos = new Uint32Array(16); this.frac = new Uint32Array(16);
      this.key = 0; this.cfg = 0; this.acc = 0; this.frame = 0; this.otherIo = 0;
      this.mute = 0;                 /* mixer-only mask of silenced voices */
      this.peaks = new Float32Array(16); /* loudest output of each voice since the page last read it (meters; 0..1) */
      this.log = options.log || null; /* array of lines in checks/sndref.c format when set */
      this.keyOns = null;            /* optional array of [frame, voice] */
      const self = this, ram = this.ram, rom = this.rom, loaded = this.loaded;
      const ramView = new DataView(ram.buffer), romView = new DataView(rom.buffer);
      const be = (m, o, size) => size === 1 ? m[o] : size === 2 ? (m[o] << 8) | m[o + 1] : ((m[o] << 24) | (m[o + 1] << 16) | (m[o + 2] << 8) | m[o + 3]) >>> 0;
      const put = (m, o, size, v) => {
        if (size === 1) m[o] = v;
        else if (size === 2) { m[o] = v >> 8; m[o + 1] = v; }
        else { m[o] = v >>> 24; m[o + 1] = v >>> 16; m[o + 2] = v >>> 8; m[o + 3] = v; }
      };
      this.mem = {
        rd(a, size) {
          a >>>= 0;
          let o = (a - RAM_BASE) >>> 0;
          if (o <= RAM_SIZE - 4) return size === 1 ? ram[o] : size === 2 ? ramView.getUint16(o) : ramView.getUint32(o);
          if (o < RAM_SIZE) return be(ram, o, size);
          o = (a - ROM_BASE) >>> 0;
          if (o < ROM_SIZE) { if (!loaded[o >> 12]) throw new Error(`ROM ${hex(a)} is not in the data pack`); return o + size > ROM_SIZE ? be(rom, o, size) : size === 1 ? rom[o] : size === 2 ? romView.getUint16(o) : romView.getUint32(o); }
          o = (a - 0x22000000) >>> 0;
          if (o <= RAM_SIZE - 4) return size === 1 ? ram[o] : size === 2 ? ramView.getUint16(o) : ramView.getUint32(o);
          if (o < RAM_SIZE) return be(ram, o, size);
          return self.ioRead(a, size);
        },
        wr(a, size, v) {
          a >>>= 0;
          let o = (a - RAM_BASE) >>> 0;
          if (o <= RAM_SIZE - 4) { if (size === 1) ram[o] = v; else if (size === 2) ramView.setUint16(o, v); else ramView.setUint32(o, v); return; }
          if (o < RAM_SIZE) { put(ram, o, size, v); return; }
          o = (a - 0x22000000) >>> 0;
          if (o <= RAM_SIZE - 4) { if (size === 1) ram[o] = v; else if (size === 2) ramView.setUint16(o, v); else ramView.setUint32(o, v); return; }
          if (o < RAM_SIZE) { put(ram, o, size, v); return; }
          self.ioWrite(a, size, v >>> 0);
        },
        fetch(a) {
          const o = (a - ROM_BASE) >>> 0;
          if (o >= ROM_SIZE || (a & 1)) throw new Error(`fetch outside ROM at ${hex(a)}`);
          if (!loaded[o >> 12]) throw new Error(`ROM ${hex(a)} is not in the data pack`);
          return romView.getUint16(o);
        },
      };
      this.cpu = new Sh2(this.mem);
      this.reset();
    }

    ioRead(a, size) {
      const x = a & 0x0FFFFFFF;
      let o = (x - 0x040E0000) >>> 0;
      if (o < 0x300) {
        if (size === 2) return o < 0x200 ? this.regs[o >> 1] : o === 0x200 ? this.key : 0;
        return 0;
      }
      o = (x - ROM_BASE) >>> 0;
      if (o < ROM_SIZE) {
        if (!this.loaded[o >> 12]) throw new Error(`ROM ${hex(a)} is not in the data pack`);
        const m = this.rom;
        return size === 1 ? m[o] : size === 2 ? (m[o] << 8) | m[o + 1] : ((m[o] << 24) | (m[o + 1] << 16) | (m[o + 2] << 8) | m[o + 3]) >>> 0;
      }
      this.otherIo++;
      if (this.log) this.log.push(`R ${hex(a).padStart(8, '0')} ${size}`);
      return 0;
    }

    ioWrite(a, size, v) {
      const x = a & 0x0FFFFFFF, o = (x - 0x040E0000) >>> 0;
      if (o < 0x300) {
        if (size === 2 && o < 0x200) { this.regs[o >> 1] = v; if (this.log) this.log.push(`${hex(o)} ${hex(v & 0xFFFF)}`); return; }
        if (size === 2 && o === 0x200) {
          for (let i = 0; i < 16; i++) {
            if (!(this.key & (1 << i)) && (v & (1 << i))) {
              this.pos[i] = 0; this.frac[i] = 0;
              if (this.keyOns) this.keyOns.push([this.frame, i]);
            }
          }
          this.key = v & 0xFFFF;
          if (this.log) this.log.push(`200 ${hex(v & 0xFFFF)}`);
          return;
        }
        if (size === 4 && o === 0x210) { this.cfg = v; if (this.log) this.log.push(`210 ${hex(v)}`); return; }
      }
      this.otherIo++;
      if (this.log) this.log.push(`X ${hex(a).padStart(8, '0')} ${size} ${hex(v)}`);
    }

    call(fn, r4, r5, r6, r7) {
      const cpu = this.cpu;
      cpu.r[4] = r4 || 0; cpu.r[5] = r5 || 0; cpu.r[6] = r6 || 0; cpu.r[7] = r7 || 0;
      cpu.pr = RET; cpu.pc = fn;
      cpu.run(RET, 20000000);
      return cpu.r[0];
    }

    /* Power-on state, then the driver's own init as the game calls it (bank word 0x40; the second of its
     * two stack arguments is the stereo switch, 0 on Fightcade: checks/command_check.js). */
    reset() {
      this.ram.fill(0); this.regs.fill(0); this.pos.fill(0); this.frac.fill(0);
      this.key = 0; this.cfg = 0; this.acc = 0; this.frame = 0;
      const cpu = this.cpu, G = this.game;
      cpu.r.fill(0); cpu.sr = 0; cpu.gbr = 0; cpu.vbr = 0; cpu.mach = 0; cpu.macl = 0;
      cpu.r[15] = STACK;
      if (this.log) this.log.push('F 0');
      this.call(G.fn.setBank, 0x40);
      cpu.r[15] -= 8;                          /* two stack arguments: 0, and the stereo switch */
      if (this.stereo) this.w32(cpu.r[15] + 4, 1);
      this.call(G.fn.init, G.tables.request, G.tables.samples, G.tables.banks, 1);
      cpu.r[15] += 8;
    }
    /* The stereo switch: kept for the next reset, and the driver's flag byte (02079C5B, which init sets
     * from the switch) written now, so a playing song changes from its next frame. */
    setStereo(on) { this.stereo = !!on; this.w8(this.game.stereoFlag, this.stereo ? 1 : 0); }

    request(code, fade) { if (fade) this.call(this.game.fn.requestFade, code, fade); else this.call(this.game.fn.request, code); }
    stopMusic() { this.call(this.game.fn.stopMusic); }
    /* pitch: 256 = one semitone up for all music channels; attenuation 0 = full. The driver's own call. */
    setPitchVolume(pitch, attenuation) { this.call(this.game.fn.pitchVolume, pitch & 0xFFFF, attenuation & 0xFF); }
    setTempoOffset(n) { this.call(this.game.fn.tempoOffset, n & 0xFF); }

    r8(a) { return this.ram[a - RAM_BASE]; }
    r16(a) { const o = a - RAM_BASE; return (this.ram[o] << 8) | this.ram[o + 1]; }
    r32(a) { const o = a - RAM_BASE; return ((this.ram[o] << 24) | (this.ram[o + 1] << 16) | (this.ram[o + 2] << 8) | this.ram[o + 3]) >>> 0; }
    w8(a, v) { this.ram[a - RAM_BASE] = v; }
    w16(a, v) { const o = a - RAM_BASE; this.ram[o] = v >> 8; this.ram[o + 1] = v; }
    w32(a, v) { const o = a - RAM_BASE; this.ram[o] = v >>> 24; this.ram[o + 1] = v >>> 16; this.ram[o + 2] = v >>> 8; this.ram[o + 3] = v; }
    /* a music channel's transpose in semitones (channel +86), used by its next notes */
    transpose(i, add) {
      const a = this.game.channels + i * this.game.channelSize + 86;
      if (add !== undefined) this.w16(a, (((this.r16(a) << 16) >> 16) + add) & 0xFFFF);
      return (this.r16(a) << 16) >> 16;
    }
    setTempo(v) { this.w32(this.game.tempo, v >>> 0); }
    tempoOffsetValue() { return this.r32(this.game.tempoOffset) | 0; }
    rom8(a) { return this.rom[a - ROM_BASE]; }
    rom16(a) { const o = a - ROM_BASE; return (this.rom[o] << 8) | this.rom[o + 1]; }
    rom32(a) { const o = a - ROM_BASE; return ((this.rom[o] << 24) | (this.rom[o + 1] << 16) | (this.rom[o + 2] << 8) | this.rom[o + 3]) >>> 0; }

    tempo() { return this.r32(this.game.tempo); }
    marker() { return this.r8(this.game.marker); }
    channel(i) {
      const b = this.game.channels + i * this.game.channelSize;
      return { flags: this.r8(b + 94), note: this.r8(b + 112), program: this.r16(b + 72), bank: this.r8(b + 97), volume: this.r8(b + 98) };
    }
    musicPlaying() { const G = this.game; for (let i = 0; i < 16; i++) if (!(this.r8(G.channels + i * G.channelSize + 94) & 0xC0)) return true; return false; }

    /* ---- writing into the private ROM copy (the music space only) ------------------------------- */
    /* Put a sequence into a slot of the music space and point a request code at it
     * (slot 0 = preview at Engine.CAVE.preview, 1 = audition at Engine.CAVE.audition; 64 KB each). */
    patchSequence(bytes, code, slot) {
      if (bytes.length > SLOT) throw new Error('sequence too large for the preview area');
      const at = slot ? this.cave.audition : this.cave.preview;
      this.rom.fill(0, at - ROM_BASE, at - ROM_BASE + SLOT);
      this.rom.set(bytes, at - ROM_BASE);
      this.setRequest(code, at);
      return at;
    }
    /* Write bytes anywhere in the music space (throws anywhere else). */
    patchAt(address, bytes) {
      const end = address + bytes.length;
      if (!(Number.isInteger(address) && address >= this.cave.preview && end <= this.cave.end))
        throw new Error(`patchAt ${hex(address)}..${hex(end)}: only the music space ${hex(this.cave.preview)}..${hex(this.cave.end)} can be written`);
      this.rom.set(bytes, address - ROM_BASE);
      for (let p = (address - ROM_BASE) >> 12; p < (end - ROM_BASE + 0xFFF) >> 12; p++) this.loaded[p] = 1;
      return address;
    }
    /* Point request code `code` at a sequence at `address` (the table stores offsets from itself). */
    setRequest(code, address) {
      const T = this.game.tables.request;
      if (!(Number.isInteger(code) && code >= 0 && code < this.game.requests)) throw new Error(`setRequest: no request code ${code}`);
      const off = (address - T) >>> 0, entry = T + 4 + 4 * code - ROM_BASE;
      this.rom[entry] = off >>> 24; this.rom[entry + 1] = off >>> 16; this.rom[entry + 2] = off >>> 8; this.rom[entry + 3] = off;
    }
    /* A custom instrument bank (SF3Bank.buildBlob(bank, Engine.CAVE.bank)): its bytes at Engine.CAVE.bank
     * (the rest of that area cleared) and bank `blob.slot` (8 unless said) pointed at it. */
    installBank(blob) {
      const at = this.cave.bank, base = blob.base === undefined ? at : blob.base, slot = blob.slot === undefined ? 8 : blob.slot;
      if (base !== at) throw new Error(`installBank: the blob was built for ${hex(base)}; build it for Engine.CAVE.bank (${hex(at)})`);
      if (blob.bytes.length > this.cave.end - at) throw new Error(`installBank: ${blob.bytes.length} bytes do not fit (${this.cave.end - at} available)`);
      if (!(Number.isInteger(slot) && slot >= 0 && slot < 16)) throw new Error(`installBank: no bank ${slot}`);
      this.rom.fill(0, at - ROM_BASE, this.cave.end - ROM_BASE);
      this.rom.set(blob.bytes, at - ROM_BASE);
      const entry = this.game.tables.banks + 4 * slot - ROM_BASE;
      this.rom[entry] = at >>> 24; this.rom[entry + 1] = at >>> 16; this.rom[entry + 2] = at >>> 8; this.rom[entry + 3] = at;
      return at;
    }
    /* Request table and bank pointers back as the ROM has them (what was written in the music space stays). */
    restoreRequestTable() {
      const T = this.game.tables;
      this.rom.set(this.pristine, T.request - ROM_BASE);
      this.rom.set(this.pristineBanks, T.banks - ROM_BASE);
    }

    /* ---- saved states: everything the driver and the chip carry from frame to frame ------------- */
    /* (the ROM copy is not saved: restore a state only while the same bytes are in the music space) */
    snapshot() {
      const c = this.cpu;
      return { ram: this.ram.slice(), regs: this.regs.slice(), pos: this.pos.slice(), frac: this.frac.slice(),
               key: this.key, cfg: this.cfg, acc: this.acc, frame: this.frame, mute: this.mute, stereo: this.stereo,
               cpu: { r: c.r.slice(), pc: c.pc, pr: c.pr, sr: c.sr, gbr: c.gbr, vbr: c.vbr, mach: c.mach, macl: c.macl } };
    }
    restore(snap) {
      this.ram.set(snap.ram); this.regs.set(snap.regs); this.pos.set(snap.pos); this.frac.set(snap.frac);
      this.key = snap.key; this.cfg = snap.cfg; this.acc = snap.acc; this.frame = snap.frame; this.mute = snap.mute;
      if (snap.stereo !== undefined) this.stereo = snap.stereo;
      const c = this.cpu, s = snap.cpu;
      if (s) { c.r.set(s.r); c.pc = s.pc; c.pr = s.pr; c.sr = s.sr; c.gbr = s.gbr; c.vbr = s.vbr; c.mach = s.mach; c.macl = s.macl; }
      c.inSlot = false;
    }

    /* One frame of the driver; returns how many chip samples this frame lasts. */
    tick() {
      this.frame++;
      if (this.log) this.log.push(`F ${this.frame}`);
      this.call(this.game.fn.update);
      this.acc += SPF_NUM;
      const n = Math.floor(this.acc / SPF_DEN);
      this.acc -= n * SPF_DEN;
      return n;
    }

    /* Advance the voices by n samples; with L/R (Int32Array) also mix into them from index `at`. */
    chip(n, L, R, at) {
      const regs = this.regs, samples = this.samples;
      for (let i = 0; i < 16; i++) {
        const bit = 1 << i;
        if (!(this.key & bit)) continue;
        const b = i * 16;
        const start = (((regs[b + 3] << 16) | regs[b + 2]) - 0x400000) >>> 0, end = (((regs[b + 11] << 16) | regs[b + 10]) - 0x400000) >>> 0;
        const loop = (((regs[b + 9] << 16) | regs[b + 7]) - 0x400000) >>> 0, step = regs[b + 6], looping = regs[b + 5];
        const volL = s16(regs[b + 15]), volR = s16(regs[b + 14]);
        const audible = L && !(this.mute & bit);
        let pos = this.pos[i], frac = this.frac[i], peak = 0;
        for (let j = 0; j < n; j++) {
          /* Silent catch-up can skip a run that cannot reach the sample end. Keep the
           * fractional carry at the LAST sample, exactly as the scalar mixer does.
           * Boundary iterations still take the ordinary path (including discarded
           * overshoot at a loop). Unusual/wrapping addresses keep the scalar path. */
          if (!audible && start < end && end <= samples.length && pos < end - start) {
            const room = (end - start - pos) * 4096 - frac;
            const count = Math.min(n - j, step ? Math.max(0, Math.ceil(room / step)) : room > 0 ? n - j : 0);
            if (count > 0) {
              const total = frac + (count - 1) * step;
              pos += Math.floor(total / 4096); frac = total % 4096 + step;
              j += count - 1; continue;
            }
          }
          pos = (pos + (frac >>> 12)) >>> 0; frac &= 0xFFF;
          if (((start + pos) >>> 0) >= end) {
            if (looping) pos = (loop - start) >>> 0;
            else { if (this.selfClear) this.key &= ~bit; break; }
          }
          if (audible) {
            const s = samples[start + pos] | 0, l = (s * volL) >> 8, r = (s * volR) >> 8;
            L[at + j] += l; R[at + j] += r;
            if (l > peak) peak = l; else if (-l > peak) peak = -l;
            if (r > peak) peak = r; else if (-r > peak) peak = -r;
          }
          frac += step;
        }
        this.pos[i] = pos; this.frac[i] = frac;
        if (peak / 32768 > this.peaks[i]) this.peaks[i] = peak / 32768;
      }
    }

    /* Driver frame plus chip advance, with the reference runner's per-frame hash line. */
    step(L, R, at) {
      const n = this.tick();
      this.chip(n, L, R, at || 0);
      if (this.log) this.log.push(`H ${hex(this.hash()).padStart(8, '0')} ${hex(this.key).padStart(4, '0')}`);
      return n;
    }

    hash() {
      let h = 2166136261;
      const m = this.ram;
      for (let i = 0x78C00; i < 0x78C00 + 0x1100; i++) { h ^= m[i]; h = Math.imul(h, 16777619); }
      return h >>> 0;
    }

    /* Render `frames` frames to interleaved Float32 stereo at the chip rate. */
    render(frames) {
      const cap = Math.ceil(frames * SPF_NUM / SPF_DEN) + 16;
      const L = new Int32Array(cap), R = new Int32Array(cap);
      let at = 0;
      for (let f = 0; f < frames; f++) at += this.step(L, R, at);
      const out = new Float32Array(at * 2);
      for (let i = 0; i < at; i++) {
        out[2 * i] = Math.max(-1, Math.min(1, L[i] / 32768));
        out[2 * i + 1] = Math.max(-1, Math.min(1, R[i] / 32768));
      }
      return out;
    }
  }
  Engine.CAVE = CAVE;
  Engine.preparePack = preparePack;
  Engine.GAME = SFIII3NR1;

  const api = { Engine, CHIP_RATE, FRAME_RATE, REQ_TABLE, SAMPLE_TABLE, BANKS, CHANNELS, CHANNEL_SIZE, ROM_BASE, CAVE, SLOT, b64bytes, preparePack };
  g.SF3Engine = api;
  g.SF3Modules = Object.assign(g.SF3Modules || {}, { engine: engineModule });   /* own source, for Workers */
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
