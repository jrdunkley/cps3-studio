/* Custom instruments (docs/plan/04_FORMATS.md §4, wp/A11_instruments.md): new programs made of
 * "views" (stretches of the sample data already in the ROM, with their own start, loop, end and root
 * key), in a bank the driver reads like its own. Headless; gate G7 (checks/gates/g_bank.js).
 *
 *   SF3Bank.buildBlob(bank, base)  -> { bytes, base, slot, programs, views: [{ id, index, address }],
 *                                       pointer: { address: 0x06788000 + 4 * slot, value: base } }
 *   SF3Bank.size(bank)             -> bytes in the ROM (= buildBlob(...).bytes.length, always)
 *   SF3Bank.pitch(samples, from, to)       -> { hz, note, cents, confidence } | null   (at the root-key rate)
 *   SF3Bank.rootFor(hz)                    -> { root, fine }  (fine: region units, 1/256 semitone)
 *   SF3Bank.findLoop(samples, from, to, { periods }) -> { loop, end, periods, hz, root, fine, error, cents } | null
 *   SF3Bank.slice(samples, from, to, { count } | { atHits: true }) -> views [{ start, loop: null, end, root }]
 *   SF3Bank.kitFrom(views, firstKey, naturalNote) -> { program, views }   (each key plays its slice at the
 *                                       speed Capcom plays the source: root = key - naturalNote)
 *   SF3Bank.envelope(Engine, pack, region, { note, velocity, ticks, frames, views }) -> level word per frame,
 *                                       measured in the driver (channel record +0x42), nothing modelled
 *   SF3Bank.used(project)          -> { programs, views, bank }: what the song's notes use (bank = only that)
 *
 * Blob layout (base 16-aligned, inside the music space 067D2000..067FFFE0):
 *   base + 0x000  128 x u16 program offsets from base (0 = none)
 *   base + 0x100  per program: 12 bytes per zone, then FF 00 (every list starts at an even offset, as Capcom's)
 *   align 16      views, 16 bytes each: start, loop (= end when it plays once), end, root key (u32 big-endian)
 * Region bytes (02_DRIVER.md §4): highest key, pan (FF = the track's), level trim (signed, x (64 + trim) / 64),
 * root key (not read by the driver; written as bank 0 does), sample number (15 bits; bit 15 = ring on after
 * FF), fine (signed units), attack, decay, sustain level, sustain rate, release.
 * A view's sample number is (its address - 0x0678C000) / 16: the slots 17920..29693 of the music space.
 *
 * Facts (measured, command_check.js): at a note's end the driver clears the chip's loop flag, so a looped
 * view runs on to its end and stops; a short loop has no audible release. A view's end is also its loop end.
 */
(function (g) {
  'use strict';
  const SAMPLE_TABLE = 0x0678C000, BANKS = 0x06788000, CAVE = 0x067D2000, CAVE_END = 0x067FFFE0;
  const SAMPLE_BYTES = 0x7F5B9E;                    /* the sample data, in playing order */
  const CHIP_RATE = 42954500 / 3 / 384, ROOT_RATE = CHIP_RATE * 0xFE1 / 4096;
  const align16 = (n) => (n + 15) & ~15;
  const isInt = Number.isInteger;

  /* ---- the blob ------------------------------------------------------------------------------ */
  function programNumbers(bank) {
    const keys = Object.keys((bank && bank.programs) || {});
    for (const k of keys) if (!/^\d+$/.test(k) || +k > 127) throw new Error(`instrument number "${k}" is not 0..127`);
    return keys.map(Number).sort((a, b) => a - b);
  }
  function size(bank) {
    const progs = programNumbers(bank);
    if (!progs.length) return 0;
    let zones = 0;
    for (const p of progs) zones += ((bank.programs[p].regions) || []).length;
    return align16(256 + 12 * zones + 2 * progs.length) + 16 * ((bank.views || []).length);
  }
  function fail(msg) { throw new Error(msg); }
  function buildBlob(bank, base, opts) {
    opts = opts || {};
    const sampleBytes = opts.sampleBytes || SAMPLE_BYTES;
    if (!bank || typeof bank !== 'object') fail('no instrument bank');
    const slot = bank.slot === undefined || bank.slot === null ? 8 : bank.slot;
    if (!(isInt(slot) && slot >= 0 && slot < 16)) fail(`bank ${slot} does not exist (0..15)`);
    if (!(isInt(base) && base % 16 === 0)) fail('the instrument data must start on a multiple of 16');
    const progs = programNumbers(bank);
    if (!progs.length) fail('the bank has no instruments');
    if (progs.length > 128) fail('a bank holds at most 128 instruments');
    const views = bank.views || [];
    const total = size(bank);
    if (!(base >= CAVE && base + total <= CAVE_END)) fail(`the instrument data (${total} bytes at ${base.toString(16)}) must lie in the music space 067D2000..067FFFE0`);
    const ids = new Map();
    const viewStart = base + align16(256 + 12 * progs.reduce((n, p) => n + (bank.programs[p].regions || []).length, 0) + 2 * progs.length);
    views.forEach((v, i) => {
      if (!v || typeof v.id !== 'string' || !v.id) fail(`view ${i + 1} has no id`);
      if (ids.has(v.id)) fail(`two views are called "${v.id}"`);
      const loop = v.loop === null || v.loop === undefined ? v.end : v.loop;
      if (![v.start, loop, v.end].every(isInt)) fail(`view "${v.id}": start, loop and end must be whole numbers`);
      if (!(v.start >= 0 && v.start < v.end && v.end <= sampleBytes)) fail(`view "${v.id}": ${v.start}..${v.end} is not inside the sample data (0..${sampleBytes})`);
      if (!(loop >= v.start && loop <= v.end)) fail(`view "${v.id}": the loop point must lie between start and end`);
      if (!(isInt(v.root) && v.root >= 0 && v.root <= 127)) fail(`view "${v.id}": root key ${v.root} is not 0..127`);
      const address = viewStart + 16 * i;
      ids.set(v.id, { id: v.id, index: (address - SAMPLE_TABLE) / 16, address, view: v, loop });
    });
    const bytes = new Uint8Array(total);
    const w16 = (o, v) => { bytes[o] = (v >> 8) & 255; bytes[o + 1] = v & 255; };
    const w32 = (o, v) => { w16(o, (v >>> 16) & 0xFFFF); w16(o + 2, v & 0xFFFF); };
    const range = (v, lo, hi, what) => { if (!(isInt(v) && v >= lo && v <= hi)) fail(`${what} must be ${lo}..${hi} (it is ${v})`); return v; };
    let at = 0x100;
    for (const p of progs) {
      const prog = bank.programs[p], regions = prog.regions || [];
      const name = `instrument ${p}${prog.name ? ` ("${prog.name}")` : ''}`;
      if (!regions.length) fail(`${name} has no zones`);
      w16(2 * p, at);
      let last = -1;
      regions.forEach((r, z) => {
        const where = `${name}, zone ${z + 1}`;
        const hi = range(r.keyHigh, 0, 127, `${where}: highest key`);
        if (hi <= last) fail(`${where}: zones must go up in key (${hi} after ${last})`);
        last = hi;
        let sample, root;
        if (r.sample && r.sample.view !== undefined) {
          const v = ids.get(r.sample.view);
          if (!v) fail(`${where}: no view "${r.sample.view}"`);
          sample = v.index; root = v.view.root;
        } else if (r.sample && r.sample.rom !== undefined) {
          sample = range(r.sample.rom, 0, 17919, `${where}: ROM sample`);
          root = isInt(r.root) ? r.root : 0;
        } else fail(`${where}: no sound (a view or a ROM sample)`);
        const o = at + 12 * z;
        bytes[o] = hi;
        bytes[o + 1] = r.pan === null || r.pan === undefined ? 0xFF : range(r.pan, 0, 127, `${where}: pan`);
        bytes[o + 2] = range(r.level || 0, -64, 63, `${where}: level`) & 255;
        bytes[o + 3] = root & 127;
        w16(o + 4, sample | (r.ringOut ? 0x8000 : 0));
        bytes[o + 6] = range(r.fine || 0, -128, 127, `${where}: fine tune`) & 255;
        bytes[o + 7] = range(r.attack, 0, 63, `${where}: attack rate`);
        bytes[o + 8] = range(r.decay, 0, 63, `${where}: decay rate`);
        bytes[o + 9] = range(r.sustain, 0, 127, `${where}: sustain level`);
        bytes[o + 10] = range(r.sustainRate, 0, 63, `${where}: sustain rate`);
        bytes[o + 11] = range(r.release, 0, 63, `${where}: release rate`);
      });
      at += 12 * regions.length;
      bytes[at] = 0xFF; bytes[at + 1] = 0;
      at += 2;
    }
    for (const v of ids.values()) {
      const o = v.address - base;
      w32(o, v.view.start); w32(o + 4, v.loop); w32(o + 8, v.view.end); w32(o + 12, v.view.root);
    }
    return { bytes, base, slot, programs: progs, views: Array.from(ids.values(), (v) => ({ id: v.id, index: v.index, address: v.address })),
             pointer: { address: BANKS + 4 * slot, value: base } };
  }

  /* ---- pitch, root key, loops ---------------------------------------------------------------- */
  /* autocorrelation followed out to many periods (the method of checks/tuning.js) */
  function measure(samples, from, to) {
    const n = Math.min(to - from, 6000);
    if (!(n >= 400)) return null;
    const x = new Float64Array(n);
    let mean = 0;
    for (let i = 0; i < n; i++) { x[i] = samples[from + i]; mean += x[i]; }
    mean /= n; for (let i = 0; i < n; i++) x[i] -= mean;
    const corr = (lag) => { let a = 0, b = 0, c = 0; for (let i = 0; i + lag < n; i++) { a += x[i] * x[i + lag]; b += x[i] * x[i]; c += x[i + lag] * x[i + lag]; } return a / Math.sqrt(b * c + 1e-9); };
    let best = 0, period = 0;
    const cs = [];
    for (let lag = 4; lag < Math.min(900, n / 3); lag++) cs[lag] = corr(lag);
    for (let lag = 5; lag < cs.length - 1; lag++) if (cs[lag] > cs[lag - 1] && cs[lag] >= cs[lag + 1] && cs[lag] > best + 0.03) { if (cs[lag] > 0.5 && !period) period = lag; best = Math.max(best, cs[lag]); }
    if (!period) return null;
    let p = period, conf = cs[period];
    for (let k = 2; k * p < n * 0.6 && k <= 40; k = Math.ceil(k * 1.5)) {
      const centre = Math.round(k * p);
      let bl = centre, bc = -2;
      for (let lag = centre - 3; lag <= centre + 3; lag++) { const c = corr(lag); if (c > bc) { bc = c; bl = lag; } }
      if (bc < 0.4) break;
      const l = corr(bl - 1), r = corr(bl + 1), shift = (l - r) / (2 * (l - 2 * bc + r) || 1);
      p = (bl + shift) / k; conf = bc;
    }
    return { period: p, confidence: conf };
  }
  const midiOf = (hz) => 69 + 12 * Math.log2(hz / 440);
  function pitch(samples, from, to) {
    const m = measure(samples, from, to);
    if (!m) return null;
    const hz = ROOT_RATE / m.period, exact = midiOf(hz), note = Math.round(exact);
    return { hz, note, cents: (exact - note) * 100, confidence: m.confidence, period: m.period };
  }
  /* the root key and fine tune that make a sound of `hz` (played at the root-key rate) play in tune */
  function rootFor(hz) {
    const exact = midiOf(hz), root = Math.max(0, Math.min(127, Math.round(exact)));
    return { root, fine: Math.max(-128, Math.min(127, Math.round((root - exact) * 256))) };
  }
  function risingZeros(samples, from, to) {
    const out = [];
    for (let i = Math.max(from, 1); i < to; i++) if (samples[i - 1] < 0 && samples[i] >= 0) out.push(i);
    return out;
  }
  /* The Wave Miner: a loop of a whole number of periods from one rising zero crossing to another, in tune
   * within 3 cents of the measured pitch, with the smallest seam error (the 16 samples either side of the
   * seam compared). opts.periods: a number, or [min, max] (default [1, as many as fit]). */
  function findLoop(samples, from, to, opts) {
    opts = opts || {};
    const m = pitch(samples, from, to);
    if (!m) return null;
    const p = m.period;
    const zeros = risingZeros(samples, from, to);
    if (zeros.length < 2) return null;
    let kmin = 1, kmax = Math.floor((to - from) / p) - 1;
    if (typeof opts.periods === 'number') kmin = kmax = Math.max(1, Math.round(opts.periods));
    else if (Array.isArray(opts.periods)) { kmin = Math.max(1, opts.periods[0]); kmax = Math.min(kmax, opts.periods[1]); }
    if (kmax < kmin) return null;
    const starts = zeros.filter((z) => z < from + Math.max(4 * p, (to - from) / 4) && z + kmin * p < to).slice(0, 24);
    /* the loop plays ...x[e-1], x[s], x[s+1]...: compare the 16 samples either side of each point */
    const seam = (s, e) => {
      let err = 0, en = 0;
      for (let i = -16; i < 16; i++) {
        const a = samples[s + i] || 0, b = samples[e + i] || 0;
        err += (a - b) * (a - b); en += a * a + b * b;
      }
      return err / (en + 1);
    };
    let best = null;
    for (const s of starts) {
      for (let k = kmin; k <= kmax; k++) {
        const target = s + k * p;
        if (target + p / 4 > to) break;
        /* the rising zero crossing nearest the target */
        let lo = 0, hi = zeros.length;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (zeros[mid] < target) lo = mid + 1; else hi = mid; }
        for (const j of [lo - 1, lo]) {
          const e = zeros[j];
          if (e === undefined || e <= s || e > to || Math.abs(e - target) > p / 4) continue;
          const cents = 1200 * Math.log2(k * p / (e - s));
          if (Math.abs(cents) > 3) continue;
          const error = seam(s, e);
          if (!best || error < best.error - 1e-12 || (Math.abs(error - best.error) <= 1e-12 && (Math.abs(cents) < Math.abs(best.cents)))) best = { loop: s, end: e, periods: k, error, cents };
        }
      }
    }
    if (!best) return null;
    const hz = ROOT_RATE * best.periods / (best.end - best.loop), rf = rootFor(hz);
    return { loop: best.loop, end: best.end, periods: best.periods, hz, root: rf.root, fine: rf.fine, error: best.error, cents: best.cents };
  }

  /* ---- slices and kits ------------------------------------------------------------------------- */
  /* the sign change nearest `at` within lo..hi; with none (a sound off its centre line), the quietest point */
  function nearestZero(samples, at, lo, hi) {
    for (let d = 0; d <= Math.max(at - lo, hi - at); d++) {
      for (const i of [at - d, at + d]) if (i > lo && i <= hi && i > 0 && (samples[i - 1] < 0) !== (samples[i] < 0)) return i;
    }
    let best = at;
    for (let i = Math.max(lo + 1, 1); i <= hi; i++) if (Math.abs(samples[i]) < Math.abs(samples[best])) best = i;
    return best;
  }
  function slice(samples, from, to, opts) {
    opts = opts || {};
    if (!(to > from)) throw new Error('a slice needs a stretch of sound');
    const root = isInt(opts.root) ? opts.root : 60;
    let cuts;
    if (opts.atHits) {
      const hop = 64, frames = Math.floor((to - from) / hop), energy = new Float64Array(frames);
      for (let f = 0; f < frames; f++) { let s = 0; for (let i = 0; i < hop; i++) { const v = samples[from + f * hop + i]; s += v * v; } energy[f] = s / hop; }
      const minGap = Math.max(4, Math.round((opts.minGap || 2400) / hop));
      cuts = [from];
      let last = -minGap, peak = 0;
      for (let f = 1; f < frames; f++) peak = Math.max(peak, energy[f]);
      for (let f = 2; f < frames; f++) {
        const before = (energy[f - 1] + energy[f - 2]) / 2 + peak * 1e-3;
        if (energy[f] > 4 * before && energy[f] > peak * 0.02 && f - last >= minGap) {
          const at = from + f * hop;
          if (at - from >= minGap * hop) cuts.push(nearestZero(samples, at - hop, from, to));
          last = f;
        }
      }
      cuts.push(to);
    } else {
      const count = Math.max(1, Math.round(opts.count || 8)), len = (to - from) / count, give = Math.max(1, Math.floor(len * 0.02));
      cuts = [from];
      for (let i = 1; i < count; i++) { const at = Math.round(from + i * len); cuts.push(nearestZero(samples, at, at - give, at + give)); }
      cuts.push(to);
    }
    const out = [];
    for (let i = 0; i + 1 < cuts.length; i++) if (cuts[i + 1] > cuts[i]) out.push({ start: cuts[i], loop: null, end: cuts[i + 1], root });
    return out;
  }
  /* a kit: key firstKey + i plays views[i] at the speed Capcom plays the source (its note relative to the
   * source's root key is naturalNote, -20 for the break kits), so root = key - naturalNote */
  function kitFrom(views, firstKey, naturalNote, opts) {
    opts = opts || {};
    const nn = isInt(naturalNote) ? naturalNote : 0;
    const out = views.map((v, i) => Object.assign({}, v, { id: v.id || `${opts.prefix || 's'}${i + 1}`, root: Math.max(0, Math.min(127, firstKey + i - nn)) }));
    const env = Object.assign({ attack: 63, decay: 63, sustain: 127, sustainRate: 1, release: 63 }, opts.envelope || {});
    const program = { name: opts.name || 'Kit', regions: out.map((v, i) => Object.assign({ keyHigh: Math.min(127, firstKey + i), sample: { view: v.id }, pan: null, level: 0, fine: 0, ringOut: false }, env)) };
    return { program, views: out };
  }

  /* ---- the envelope, measured in the driver ----------------------------------------------------- */
  function envelope(Engine, pack, region, opts) {
    opts = Object.assign({ note: 60, velocity: 100, ticks: 96, frames: 180, views: [] }, opts || {});
    const EngineClass = Engine.Engine || Engine;
    const e = new EngineClass(pack);
    const bank = { slot: 8, views: opts.views, programs: { 0: { regions: [Object.assign({ keyHigh: 127, pan: null, level: 0, fine: 0 }, region)] } } };
    e.installBank(buildBlob(bank, EngineClass.CAVE.bank));
    const v = Math.max(1, Math.min(63, Math.round(opts.velocity / 2)));
    const ev = [{ d: 0, k: 'cmd', op: 0xC1, a: [2, 0] }, { d: 0, k: 'cmd', op: 0xC2, a: [8] }, { d: 0, k: 'cmd', op: 0xC4, a: [0] },
                { d: 0, k: 'cmd', op: 0xC6, a: [127] }, { d: 0, k: 'cmd', op: 0xC8, a: [127] }, { d: 0, k: 'cmd', op: 0xC7, a: [64] },
                { d: 1, k: 'note', v, n: opts.note, tie: 0, len: opts.ticks }, { d: opts.ticks + 1, k: 'cmd', op: 0xFF, a: [] }];
    const Seq = g.SF3Seq || require('./seq.js');
    const t = new Array(16).fill(null); t[0] = ev;
    e.patchSequence(Seq.compile({ tracks: t }), 60, 0);
    e.request(60);
    const out = [];
    const rec = e.game.channels + 0x42;
    for (let f = 0; f < opts.frames; f++) { e.step(); out.push(e.r16(rec)); }
    return out;
  }

  /* ---- what a song uses ------------------------------------------------------------------------- */
  function used(project) {
    const B = project && project.bank;
    if (!B) return { programs: [], views: [], bank: null };
    const slot = B.slot === undefined || B.slot === null ? 8 : B.slot;
    const progs = new Set();
    for (const part of project.parts || []) {
      const lane = ((part.automation || {}).program || []).slice().sort((a, b) => a.t - b.t);
      const notes = part.notes || [];
      for (const n of notes) {
        let bank = part.bank & 15, program = part.program & 127;
        for (const pt of lane) if (pt.t <= n.t) { program = pt.v & 127; if (pt.bank !== undefined) bank = pt.bank & 15; }
        if (n.bank !== undefined && n.bank !== null) bank = n.bank & 15;
        if (n.program !== undefined && n.program !== null) program = n.program & 127;
        if (bank === slot) progs.add(program);
      }
    }
    const programs = Array.from(progs).filter((p) => B.programs && B.programs[p]).sort((a, b) => a - b);
    const viewIds = new Set();
    for (const p of programs) for (const r of B.programs[p].regions || []) if (r.sample && r.sample.view !== undefined) viewIds.add(r.sample.view);
    const views = (B.views || []).filter((v) => viewIds.has(v.id));
    const programsOut = {};
    for (const p of programs) programsOut[p] = B.programs[p];
    return { programs, views: views.map((v) => v.id), bank: programs.length ? Object.assign({}, B, { slot, views, programs: programsOut }) : null };
  }

  const api = { buildBlob, size, pitch, rootFor, findLoop, slice, kitFrom, envelope, used, SAMPLE_BYTES, ROOT_RATE, CAVE, CAVE_END };
  g.SF3Bank = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
