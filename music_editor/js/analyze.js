/* The Studio's analysis: how a song SOUNDS in numbers against Capcom's own music, what its notes say
 * harmonically, and the Game Check: a list of everything that can go wrong in the game, in plain words.
 * Headless (browser and Node); nothing here reads a file or a clock. Gate G11 (checks/gates/g_analyze.js).
 * Docs: docs/plan/wp/A6_analyze.md; words: docs/plan/05_UX.md section 8; numbers: style/metrics.js.
 *
 *   SF3Analyze.metrics(audio, rate, extra)      -> { width, bands[4], rms, crest, motion, keysPerSecond, voices, peak, seconds }
 *       the numbers of style/metrics.js, digit for digit, from audio { L, R, n } (Int32 or Float32, raw chip scale: 32768 = full
 *       scale; no R = mono). Measured over up to extra.seconds (40) after the first second (audio under a second: all of it).
 *       extra.keyOns: a count (taken as counted) or the engine's list [[frame, voice], ...] (frames from 60 on count);
 *       extra.voices: mean voices sounding (or voiceSum and frames). peak is a FRACTION of full scale (1 = 32768): above 1 the mix clips.
 *   SF3Analyze.measure(Engine, pack, setup, { seconds, stereo }) -> { metrics, audio, extra }   runs the driver (as style/metrics.js does) and measures
 *       setup: a request code, a sequence (Uint8Array), a build ({ bytes, bank }) or a function(engine). Mono unless stereo: what players hear.
 *   SF3Analyze.spectrum(audio, rate, bins, { from, to }) -> { freq[], db[] }   `bins` log-spaced bands from 30 Hz to 16 kHz; db is the
 *       band's power in dB against a full-scale square (band powers add up to the signal's mean square); -120 is the floor.
 *   SF3Analyze.sections(audio, rate, barTimes, { per: 4 }) -> [ { bar, from, to, rms, rel } ]   loudness per `per` bars (seconds from/to; rel = dB under the loudest)
 *   SF3Analyze.barTimes(project) -> seconds at which bar 1, 2, ... bars + 1 begin (a straight count of ticks at the tempo; lead-in included)
 *   SF3Analyze.targets(engine, data, { pack }) -> Capcom's 10..90 % range and median per metric over the 34 stage themes (codes 10..43,
 *       40 s each); cache it, it takes seconds. SF3Analyze.TARGETS is the published fallback (style/README.txt) for use before that.
 *   SF3Analyze.harmony(project, { catalog }) -> { key: { root, scale, confidence }, bars: [ { bar, chord, root, notes } ], clashes }
 *   SF3Analyze.driverLoad(Engine, pack, bytes, { game }) -> { peak, mean, game: { peak, mean, code }, ratio }   (checks/driver_load.js; the game's figure is cached per pack)
 *   SF3Analyze.lint(project, built, { catalog, targets, metrics, load, compressedBytes }) -> issues
 *       { code, level: 'error' | 'warn' | 'info', message, partId?, bar?, fix?: { label, apply(project) -> new project } }
 *   SF3Analyze.analyze(project, built, ctx) -> { harmony, issues, metrics, targets, load }
 *   SF3Analyze.brief(project, built, analysis) -> the agent brief: plain text, under 120 lines
 *   SF3Analyze.ISSUES = { code: level }
 *
 * Decisions (the plan left them open):
 *  - Key: Krumhansl-Schmuckler on pitch-class weights (note length, capped at two bars, bass parts x1.5); confidence is the correlation of
 *    the best key (0..1), 0 with no notes or every pitch class equal. Chords: one per bar by cosine similarity between the bar's pitch-class
 *    weights and chord templates, +0.12 when the lowest note is the chord's root, +0.04 when it is a chord tone, -0.004 a tone (simpler wins ties);
 *    pitch classes under a tenth of the strongest are passing notes. A clash is two different parts sounding notes exactly a semitone apart for
 *    at least 12 ticks together (kits, muted and silent parts take no part).
 *  - "Where Capcom plays an instrument" is its whole range in the ROM's 49 pieces (catalog range low..high), the notes counted with the part's transpose.
 *  - A kit key has no sound when no zone of the kit covers it (the driver then plays nothing): Capcom's own music does that once, on key 54 of kit D.
 *    The catalog's `keys` list only holds keys 36..72 that carry their own slice, so it alone would wrongly call the keys below a break's first slice silent.
 *  - tuning.off follows auto-tune's rule: only a measurement with tuningConfidence >= SF3Compile.AUTO_TUNE_SURE (0.8) counts, and what the part's own
 *    tune already corrects is not an error.
 *  - tracks.effects is not repeated when tracks.over is raised: with 17 tracks wanted, every track including 13..16 is in use and the over-error is the news.
 *  - A lead is "louder than Capcom's leads" when volume x (expression + 1) is more than 2 dB above Capcom's median lead (catalog roles.lead).
 *  - Sizes in KB are thousands of bytes (the music space is 188.4 KB); size.large is above 8000 bytes.
 *  - The compiler's own warnings track.pin, lane.unknown, bank.missing and autotune.nocatalog are passed on with their codes.
 */
(function (g) {
  'use strict';
  const Seq = g.SF3Seq || require('./seq.js');
  const compiler = () => g.SF3Compile || require('./compile.js');
  const BAR = Seq.BAR, CHIP_RATE = 42954500 / 3 / 384, FULL = 32768;
  const round1 = (v) => +v.toFixed(1);
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + 's')}`;
  const KB = (bytes) => `${(bytes / 1000).toFixed(1)} KB`;
  const pct = (x) => `${Math.round(x * 100)} %`;

  /* ================================================================================================================
   * Mix numbers (style/metrics.js)
   * ================================================================================================================ */
  function biquad(type, f0, fs) {
    const w = 2 * Math.PI * f0 / fs, c = Math.cos(w), s = Math.sin(w), a = s / (2 * 0.707);
    const b = type === 'lp' ? [(1 - c) / 2, 1 - c, (1 - c) / 2] : [(1 + c) / 2, -(1 + c), (1 + c) / 2];
    const a0 = 1 + a, a1 = -2 * c, a2 = 1 - a;
    return (x) => { const y = new Float64Array(x.length); let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
      for (let i = 0; i < x.length; i++) { const v = (b[0] * x[i] + b[1] * x1 + b[2] * x2 - a1 * y1 - a2 * y2) / a0; x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v; } return y; };
  }
  const energy = (x) => { let s = 0; for (let i = 0; i < x.length; i++) s += x[i] * x[i]; return s; };
  const lengthOf = (audio) => (audio.n !== undefined ? audio.n : audio.L.length);

  function metrics(audio, rate, extra) {
    extra = extra || {};
    rate = rate || audio.rate || CHIP_RATE;
    const total = lengthOf(audio), Lc = audio.L, Rc = audio.R || audio.L;
    const cap = extra.seconds || 40;
    let from = Math.round(rate), seconds = Math.min(cap, total / rate - 1), n = Math.min(total - from, Math.round(seconds * rate));
    if (n < 1) { from = 0; seconds = Math.min(cap, total / rate); n = Math.min(total, Math.round(seconds * rate)); }     /* under a second: all of it */
    const mid = new Float64Array(n), side = new Float64Array(n);
    let peak = 0;
    for (let i = 0; i < n; i++) {
      const lraw = Lc[from + i], rraw = Rc[from + i];
      mid[i] = (lraw / FULL + rraw / FULL) / 2; side[i] = (lraw / FULL - rraw / FULL) / 2;
      peak = Math.max(peak, Math.abs(lraw), Math.abs(rraw));
    }
    const low = biquad('lp', 150, rate)(mid), lowmid = biquad('lp', 600, rate)(mid), midband = biquad('lp', 2500, rate)(mid);
    const eMid = energy(mid), eSide = energy(side), eAll = eMid || 1e-9, eLow = energy(low), eLowMid = energy(lowmid), eMidBand = energy(midband);
    const bands = [eLow, Math.max(0, eLowMid - eLow), Math.max(0, eMidBand - eLowMid), Math.max(0, eAll - eMidBand)].map((v) => +(v / eAll).toFixed(3));
    const rms = Math.sqrt((eMid + eSide) / Math.max(1, n));
    const win = Math.max(1, Math.round(rate * 0.05)), levels = [];
    for (let i = 0; i + win <= n; i += win) { let s = 0; for (let j = i; j < i + win; j++) s += mid[j] * mid[j] + side[j] * side[j]; levels.push(10 * Math.log10(s / win + 1e-12)); }
    levels.sort((a, b) => a - b);
    const motion = levels.length > 1 ? levels[Math.floor(levels.length * 0.9)] - levels[Math.floor(levels.length * 0.1)] : 0;
    let counted = null;
    if (Array.isArray(extra.keyOns)) counted = extra.keyOns.filter((e) => e[0] >= 60).length;
    else if (typeof extra.keyOns === 'number') counted = extra.keyOns;
    let voices = null;
    if (typeof extra.voices === 'number') voices = extra.voices;
    else if (typeof extra.voiceSum === 'number' && extra.frames) voices = extra.voiceSum / extra.frames;
    return {
      width: +(eSide / eAll).toFixed(3), bands,
      rms: round1(20 * Math.log10(rms + 1e-9)),
      crest: peak === 0 ? 0 : round1(20 * Math.log10(peak / FULL / (rms + 1e-9))),
      motion: round1(motion),
      keysPerSecond: counted === null ? null : (seconds > 0 ? round1(counted / seconds) : 0),
      voices: voices === null ? null : round1(voices),
      peak: peak / FULL,
      seconds,
    };
  }

  function engineClass(E) {
    E = E || (g.SF3Engine && g.SF3Engine.Engine) || require('./engine.js').Engine;
    return E.Engine || E;
  }
  function toSetup(src) {
    if (typeof src === 'function') return src;
    if (typeof src === 'number') return (e) => e.request(src);
    const play = (bytes, bank) => (e) => { if (bank && bank.bytes) e.installBank(bank); e.patchSequence(bytes, 60, 0); e.request(60); };
    if (ArrayBuffer.isView(src) && src.BYTES_PER_ELEMENT === 1) return play(src);
    if (Array.isArray(src)) return play(Uint8Array.from(src));
    if (src && src.bytes) return play(src.bytes, src.bank);
    throw new Error('Say what to measure: a request code, the bytes of a song, a build, or a function that sets up the engine.');
  }

  /* run the driver as style/metrics.js does: seconds + 1 s of frames, key-ons counted from the request */
  function measure(E, pack, src, opts) {
    opts = opts || {};
    const seconds = opts.seconds || 40, Eng = engineClass(E);
    if (Eng.preparePack) Eng.preparePack(pack);
    const e = new Eng(pack, { stereo: !!opts.stereo });
    toSetup(src)(e);
    e.keyOns = [];
    const frames = Math.round((seconds + 1) * 59.6), cap = Math.ceil(frames * 626) + 16, L = new Int32Array(cap), R = new Int32Array(cap);
    let at = 0, voiceSum = 0;
    for (let f = 0; f < frames; f++) {
      at += e.step(L, R, at);
      let v = 0; for (let i = 0; i < 16; i++) if (e.key & (1 << i)) v++;
      voiceSum += v;
    }
    const audio = { L, R, n: at, rate: CHIP_RATE, frames, stereo: !!opts.stereo };
    const extra = { keyOns: e.keyOns, voices: voiceSum / frames, frames, seconds };
    return { metrics: metrics(audio, CHIP_RATE, extra), audio, extra };
  }

  /* ---- spectrum -------------------------------------------------------------------------------------------- */
  const FFT_N = 8192;
  let fftTables = null;
  function fftSetup() {
    if (fftTables) return fftTables;
    const n = FFT_N, cos = new Float64Array(n / 2), sin = new Float64Array(n / 2), rev = new Uint32Array(n), hann = new Float64Array(n);
    for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos(2 * Math.PI * i / n); sin[i] = -Math.sin(2 * Math.PI * i / n); }
    for (let i = 0, bits = Math.log2(n); i < n; i++) { let r = 0; for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b); rev[i] = r; }
    let u = 0;
    for (let i = 0; i < n; i++) { hann[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n); u += hann[i] * hann[i]; }
    return (fftTables = { cos, sin, rev, hann, u: u / n });
  }
  function fft(re, im) {
    const { cos, sin, rev } = fftSetup(), n = FFT_N;
    for (let i = 0; i < n; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let k = 0, w = 0; k < half; k++, w += step) {
          const a = start + k, b = a + half, tr = re[b] * cos[w] - im[b] * sin[w], ti = re[b] * sin[w] + im[b] * cos[w];
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        }
      }
    }
  }
  function spectrum(audio, rate, bins, opts) {
    opts = opts || {};
    rate = rate || audio.rate || CHIP_RATE; bins = Math.max(1, bins | 0 || 64);
    const total = lengthOf(audio), Lc = audio.L, Rc = audio.R || audio.L, n = FFT_N, T = fftSetup();
    const from = Math.max(0, Math.min(total, opts.from === undefined ? 0 : Math.round(opts.from))), to = Math.max(from, Math.min(total, opts.to === undefined ? total : Math.round(opts.to)));
    const span = to - from, count = span <= n ? 1 : Math.min(48, Math.floor((span - n) / (n / 2)) + 1);
    const power = new Float64Array(n / 2 + 1), re = new Float64Array(n), im = new Float64Array(n);
    for (let w = 0; w < count; w++) {
      const at = count === 1 ? from : from + Math.round(w * (span - n) / (count - 1));
      for (let i = 0; i < n; i++) { const k = at + i; re[i] = k < to ? (Lc[k] + Rc[k]) / 2 / FULL * T.hann[i] : 0; im[i] = 0; }
      fft(re, im);
      for (let k = 0; k <= n / 2; k++) power[k] += (re[k] * re[k] + im[k] * im[k]) / (n * n * T.u) * (k === 0 || k === n / 2 ? 1 : 2) / count;
    }
    /* each FFT bin's power spread evenly over its width; a band takes the share that overlaps it */
    const fLo = 30, fHi = Math.min(16000, rate / 2 * 0.98), df = rate / n, edges = [];
    for (let b = 0; b <= bins; b++) edges.push(fLo * Math.pow(fHi / fLo, b / bins));
    const freq = new Array(bins), db = new Array(bins);
    for (let b = 0; b < bins; b++) {
      const lo = edges[b], hi = edges[b + 1];
      let sum = 0;
      for (let k = Math.max(0, Math.floor(lo / df - 0.5)); k <= Math.min(n / 2, Math.ceil(hi / df + 0.5)); k++) {
        const a = Math.max(lo, (k - 0.5) * df), z = Math.min(hi, (k + 0.5) * df);
        if (z > a) sum += power[k] * (z - a) / df;
      }
      freq[b] = Math.sqrt(lo * hi); db[b] = round2(10 * Math.log10(sum + 1e-12));
    }
    return { freq, db };
  }
  const round2 = (v) => Math.round(v * 100) / 100;

  /* ---- loudness per phrase, bar times ----------------------------------------------------------------------- */
  function sections(audio, rate, barTimes, opts) {
    rate = rate || audio.rate || CHIP_RATE;
    const per = Math.max(1, (opts && opts.per) | 0 || 4), total = lengthOf(audio), Lc = audio.L, Rc = audio.R || audio.L, out = [];
    for (let i = 0; i + 1 < barTimes.length; i += per) {
      const t0 = barTimes[i], t1 = barTimes[i + per] !== undefined ? barTimes[i + per] : barTimes[barTimes.length - 1];
      const a = Math.max(0, Math.min(total, Math.round(t0 * rate))), z = Math.max(a, Math.min(total, Math.round(t1 * rate)));
      let s = 0;
      for (let k = a; k < z; k++) { const l = Lc[k] / FULL, r = Rc[k] / FULL, m = (l + r) / 2, d = (l - r) / 2; s += m * m + d * d; }
      out.push({ bar: i + 1, from: t0, to: t1, rms: round1(z > a ? 20 * Math.log10(Math.sqrt(s / (z - a)) + 1e-9) : -120) });
    }
    const loudest = out.length ? Math.max(...out.map((x) => x.rms)) : 0;
    for (const x of out) x.rel = round1(x.rms - loudest);
    return out;
  }
  function barTimes(project) {
    const bars = project.bars || Math.ceil((project.length || BAR) / BAR), lead = project.leadIn === undefined ? Seq.LEAD_IN : project.leadIn;
    const segs = [{ t: 0, bpm: project.bpm || 120 }].concat((project.tempoChanges || []).slice().sort((a, b) => a.t - b.t).map((c) => ({ t: c.t, bpm: c.bpm })));
    const perTick = (bpm) => 60 / (bpm * 48);
    const secondsAt = (tick) => { let s = 0; for (let i = 0; i < segs.length; i++) { const end = i + 1 < segs.length ? Math.min(tick, segs[i + 1].t) : tick; if (end > segs[i].t) s += (end - segs[i].t) * perTick(segs[i].bpm); } return s; };
    const out = [];
    for (let b = 0; b <= bars; b++) out.push(lead * perTick(segs[0].bpm) + secondsAt(b * BAR));
    return out;
  }

  /* ---- Capcom's targets ------------------------------------------------------------------------------------- */
  const range = (lo, hi, median) => ({ lo, hi, median: median === undefined ? null : median });
  /* style/README.txt: "Energy below 150 Hz 0.49-0.68 (median 0.57), 150-600 Hz 0.18-0.30, 600-2500 Hz 0.06-0.17, above 0.03-0.13; crest 15.0-16.9 dB;
   * loudness motion 6-12 dB; 23-42 key-ons a second" (fighting themes, as the game plays them) */
  const TARGETS = Object.freeze({ source: 'published', themes: 34, seconds: 40,
    bands: Object.freeze([range(0.49, 0.68, 0.57), range(0.18, 0.30), range(0.06, 0.17), range(0.03, 0.13)].map(Object.freeze)),
    crest: Object.freeze(range(15.0, 16.9)), motion: Object.freeze(range(6, 12)), keysPerSecond: Object.freeze(range(23, 42)),
    width: null, rms: null, voices: null });
  function targets(engine, data, opts) {
    opts = opts || {};
    const Eng = opts.Engine || (engine && engine.constructor), pack = opts.pack || g.SF3_PACK, seconds = opts.seconds || 40;
    if (!pack) throw new Error('targets needs the data pack: pass { pack }.');
    const themes = data.songs.filter((s) => s.code >= 10 && s.code <= 43 && (!opts.codes || opts.codes.includes(s.code)));
    const list = themes.map((s) => measure(Eng, pack, s.code, { seconds }).metrics);
    const q = (f, p) => { const xs = list.map(f).sort((a, b) => a - b); return xs[Math.floor(p * (xs.length - 1))]; };
    const of = (f) => ({ lo: q(f, 0.1), hi: q(f, 0.9), median: q(f, 0.5) });
    return { source: 'computed', themes: themes.length, seconds, codes: themes.map((s) => s.code),
      width: of((m) => m.width), bands: [0, 1, 2, 3].map((i) => of((m) => m.bands[i])), rms: of((m) => m.rms), crest: of((m) => m.crest),
      motion: of((m) => m.motion), keysPerSecond: of((m) => m.keysPerSecond), voices: of((m) => m.voices) };
  }

  /* ---- driver load ------------------------------------------------------------------------------------------ */
  const gameLoads = new WeakMap();
  function loadOf(Eng, pack, setup, frames) {
    const e = new Eng(pack);
    setup(e);
    let peak = 0, total = 0;
    for (let f = 0; f < frames; f++) { const before = e.cpu.steps; e.step(); const used = e.cpu.steps - before; peak = Math.max(peak, used); total += used; }
    return { peak, mean: Math.round(total / frames) };
  }
  function gameLoad(Eng, pack) {
    if (gameLoads.has(pack)) return gameLoads.get(pack);
    let game = { peak: 0, mean: 0, code: 0 };
    for (let code = 1; code < 50; code++) {
      const m = loadOf(Eng, pack, (e) => e.request(code), 1800);
      if (m.peak > game.peak) game = Object.assign(m, { code });
    }
    gameLoads.set(pack, game);
    return game;
  }
  function driverLoad(E, pack, bytes, opts) {
    opts = opts || {};
    const Eng = engineClass(E);
    if (Eng.preparePack) Eng.preparePack(pack);
    const game = opts.game || gameLoad(Eng, pack), song = loadOf(Eng, pack, toSetup(bytes), opts.frames || 3600);
    return { peak: song.peak, mean: song.mean, game, ratio: song.peak / game.peak };
  }

  /* ================================================================================================================
   * Harmony
   * ================================================================================================================ */
  const SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'], FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
  const pcName = (pc, flats) => (flats ? FLAT : SHARP)[((pc % 12) + 12) % 12];
  const noteName = (n, flats) => `${pcName(n, flats)}${Math.floor(n / 12) - 1}`;
  const FLAT_MAJOR = new Set([5, 10, 3, 8, 1, 6]), FLAT_MINOR = new Set([2, 7, 0, 5, 10, 3]);
  const useFlats = (key) => !!key && key.root !== null && (key.scale === 'major' ? FLAT_MAJOR : FLAT_MINOR).has(key.root);
  const KS_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88], KS_MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
  const TEMPLATES = [['', [0, 4, 7]], ['m', [0, 3, 7]], ['dim', [0, 3, 6]], ['aug', [0, 4, 8]], ['sus4', [0, 5, 7]], ['sus2', [0, 2, 7]], ['5', [0, 7]],
    ['7', [0, 4, 7, 10]], ['maj7', [0, 4, 7, 11]], ['m7', [0, 3, 7, 10]], ['6', [0, 4, 7, 9]], ['m7b5', [0, 3, 6, 10]], [' only', [0]]];
  const KIT_FALLBACK = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 11, 12, 13, 61]);

  const partName = (part, i) => part.name || part.id || `Part ${i + 1}`;
  const partId = (part, i) => part.id || `p${i + 1}`;
  const entryOf = (catalog, bank, program) => (catalog && catalog.programs && bank !== null && bank !== undefined && program !== null && program !== undefined ? catalog.programs[`${bank}:${program}`] || null : null);
  const isKitPart = (part, catalog) => {
    if (part.role === 'drums' || part.role === 'perc') return true;
    const c = entryOf(catalog, part.bank, part.program);
    if (c) return !!c.kit;
    return !catalog && part.bank === 0 && KIT_FALLBACK.has(part.program);
  };
  /* a lane that holds a part's volume or expression: silent only if every point is 0; no lane: the part's own value */
  const isSilent = (part) => ['volume', 'expression'].some((s) => {
    const lane = part.automation && part.automation[s];
    return lane && lane.length ? lane.every((p) => p.v === 0) : part[s] === 0;
  });
  const sortedNotes = (part) => (part.notes || []).slice().sort((a, b) => a.t - b.t);
  const pitchOf = (part, note) => note.n + (part.transpose || 0);

  /* the program each note of a part sounds on: the part's, a program lane's (and its bank), the note's own */
  function programsOf(part) {
    const tl = ((part.automation && part.automation.program) || []).slice().sort((a, b) => a.t - b.t);
    let i = 0, bank = part.bank, program = part.program;
    return sortedNotes(part).map((note) => {
      while (i < tl.length && tl[i].t <= note.t) { if (tl[i].bank !== undefined && tl[i].bank !== null) bank = tl[i].bank; if (tl[i].v !== undefined && tl[i].v !== null) program = tl[i].v; i++; }
      return { note, bank: note.bank !== undefined && note.bank !== null ? note.bank : bank, program: note.program !== undefined && note.program !== null ? note.program : program };
    });
  }

  function songBars(project) {
    let bars = project.bars || 0;
    if (project.length) bars = Math.max(bars, Math.ceil(project.length / BAR));
    return Math.max(1, bars);
  }
  function pitchedParts(project, catalog) {
    return (project.parts || []).map((part, i) => ({ part, i })).filter(({ part }) => !part.mute && !isKitPart(part, catalog) && !isSilent(part));
  }
  function correlation(a, b) {
    const n = a.length; let ma = 0, mb = 0;
    for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
    ma /= n; mb /= n;
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < n; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) * (a[i] - ma); db += (b[i] - mb) * (b[i] - mb); }
    return da > 1e-12 && db > 1e-12 ? num / Math.sqrt(da * db) : 0;
  }
  function findKey(weights) {
    let best = null;
    for (const [scale, prof] of [['major', KS_MAJOR], ['minor', KS_MINOR]]) {
      for (let root = 0; root < 12; root++) {
        const rotated = prof.map((_, k) => prof[(k - root + 12) % 12]);
        const r = correlation(weights, rotated);
        if (!best || r > best.r + 1e-12) best = { root, scale, r };
      }
    }
    return best && best.r > 0 ? { root: best.root, scale: best.scale, confidence: Math.min(1, +best.r.toFixed(3)) } : { root: null, scale: null, confidence: 0 };
  }

  function harmony(project, opts) {
    const catalog = (opts && opts.catalog) || null, parts = pitchedParts(project, catalog), bars = songBars(project);
    const all = [];                                              // { n, t, end, part, role }
    for (const { part, i } of parts) for (const note of sortedNotes(part)) {
      const n = pitchOf(part, note);
      if (n >= 0 && n <= 127 && note.len > 0) all.push({ n, t: note.t, end: note.t + note.len, i, id: partId(part, i), bass: part.role === 'bass' });
    }
    /* key: pitch-class weights over the whole song */
    const weights = new Array(12).fill(0);
    for (const x of all) weights[x.n % 12] += Math.min(x.end - x.t, 2 * BAR) * (x.bass ? 1.5 : 1);
    const key = findKey(weights), flats = useFlats(key);
    /* chords: one per bar */
    const barList = [];
    for (let b = 0; b < bars; b++) barList.push({ w: new Array(12).fill(0), notes: [] });
    for (const x of all) {
      for (let b = Math.max(0, Math.floor(x.t / BAR)); b < bars && b * BAR < x.end; b++) {
        const ticks = Math.min(x.end, (b + 1) * BAR) - Math.max(x.t, b * BAR);
        if (ticks > 0) { barList[b].w[x.n % 12] += ticks; barList[b].notes.push({ n: x.n, ticks, bass: x.bass }); }
      }
    }
    const out = barList.map((bar, b) => {
      const max = Math.max(...bar.w);
      if (max < 12) return { bar: b + 1, chord: null, root: null, notes: [] };
      const w = bar.w.map((v) => (v >= 0.1 * max ? v : 0)), norm = Math.sqrt(w.reduce((s, v) => s + v * v, 0));
      /* the bass: the lowest note that sounds in the bar (a bass part's, when there is one) */
      const real = bar.notes.filter((x) => x.ticks >= 12 && w[x.n % 12] > 0);
      const bassOnes = real.filter((x) => x.bass), pool = bassOnes.length ? bassOnes : real;
      const bassPc = pool.length ? Math.min(...pool.map((x) => x.n)) % 12 : -1;
      let best = null;
      for (const [suffix, tones] of TEMPLATES) for (let root = 0; root < 12; root++) {
        const set = tones.map((t) => (root + t) % 12);
        let dot = 0; for (const pc of set) dot += w[pc];
        let score = dot / (norm * Math.sqrt(set.length)) - 0.004 * set.length;
        if (bassPc === root) score += 0.12; else if (set.includes(bassPc)) score += 0.04;
        if (!best || score > best.score + 1e-9) best = { score, root, suffix };
      }
      return { bar: b + 1, chord: pcName(best.root, flats) + best.suffix, root: best.root, notes: w.map((v, pc) => (v > 0 ? pc : -1)).filter((pc) => pc >= 0) };
    });
    /* clashes: two parts, notes exactly a semitone apart, together for at least 12 ticks */
    const byPart = new Map();
    for (const x of all) { if (!byPart.has(x.i)) byPart.set(x.i, []); byPart.get(x.i).push(x); }
    const ids = [...byPart.keys()].sort((a, b) => a - b), clashes = [];
    for (let a = 0; a < ids.length; a++) for (let c = a + 1; c < ids.length; c++) {
      const A = byPart.get(ids[a]), B = byPart.get(ids[c]);                    // both in start order
      let longest = 0; for (const y of B) longest = Math.max(longest, y.end - y.t);
      let lo = 0;
      for (const x of A) {
        while (lo < B.length && B[lo].t < x.t - longest) lo++;
        for (let k = lo; k < B.length && B[k].t < x.end; k++) {
          const y = B[k];
          if (Math.abs(x.n - y.n) !== 1) continue;
          const start = Math.max(x.t, y.t), ticks = Math.min(x.end, y.end) - start;
          if (ticks >= 12) clashes.push({ bar: Math.floor(start / BAR) + 1, tick: start, parts: [x.id, y.id], notes: [x.n, y.n], ticks });
        }
      }
    }
    clashes.sort((p, q) => p.tick - q.tick || (p.parts[0] < q.parts[0] ? -1 : p.parts[0] > q.parts[0] ? 1 : 0) || p.notes[0] - q.notes[0]);
    return { key, bars: out, clashes };
  }

  /* ================================================================================================================
   * The Game Check
   * ================================================================================================================ */
  const ISSUES = Object.freeze({ 'tracks.over': 'error', 'notes.dropped': 'error', 'tracks.effects': 'info', 'range.outside': 'warn', 'kit.keys': 'warn', 'tuning.off': 'warn',
    'level.clip': 'warn', 'level.lead': 'info', 'mix.low': 'info', 'mix.punch': 'info', 'mix.busy': 'info', 'loop.phrase': 'warn', 'loop.seam': 'info', 'markers.off': 'info',
    'load.high': 'warn', 'size.large': 'info', 'chorus.none': 'info', 'part.silent': 'info', 'part.empty': 'info', 'harmony.clash': 'info', 'bank.custom': 'info',
    'track.pin': 'warn', 'lane.unknown': 'warn', 'bank.missing': 'warn', 'autotune.nocatalog': 'info' });
  const CODE_ORDER = Object.keys(ISSUES), LEVEL_ORDER = { error: 0, warn: 1, info: 2 };
  const SIZE_LARGE = 8000, LEAD_LOUD_DB = 2, OUTSIDE_SHARE = 0.15, TUNE_OFF_CENTS = 15, CLASH_LIMIT = 8, CLIP = 32767 / 32768;

  /* a fix works on a complete copy (normalize clones), so the project it is given is never touched */
  const fixer = (label, change) => ({ label, apply(project) { const p = compiler().normalize(project); change(p); return p; } });
  const joinNames = (names) => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);
  const instrumentName = (project, catalog, bank, program) => {
    const c = entryOf(catalog, bank, program);
    return (project.names && project.names[`${bank}:${program}`]) || (c && c.name) || `instrument ${program}`;
  };
  const barsText = (ticks) => { const b = ticks / BAR; return plural(Number.isInteger(b) ? b : +b.toFixed(2), 'bar'); };

  function lint(project, built, ctx) {
    ctx = ctx || {};
    const P = compiler().normalize(project), catalog = ctx.catalog || null, issues = [];
    const sure = compiler().AUTO_TUNE_SURE === undefined ? 0.8 : compiler().AUTO_TUNE_SURE;
    const add = (code, message, extra) => issues.push(Object.assign({ code, level: ISSUES[code], message }, extra || {}));
    const live = P.parts.map((part, i) => ({ part, i })).filter(({ part }) => !part.mute);
    const report = built && built.report;

    /* --- what the build reports -------------------------------------------------------------------------- */
    let tooMany = false;
    if (report) {
      for (const w of report.warnings || []) {
        if (w.code === 'tracks.over') { tooMany = true; add('tracks.over', w.message, { partId: w.partId || undefined }); }
        else if (['track.pin', 'lane.unknown', 'bank.missing', 'autotune.nocatalog'].includes(w.code)) add(w.code, w.message, { partId: w.partId || undefined });
      }
      if ((report.dropped | 0) > 0) {
        const lost = report.dropped | 0, out = [], voices = [];
        const end = (part) => (P.loop.on ? P.loop.end + (part.loopShift || 0) : (part.end !== null && part.end !== undefined ? part.end : (P.length || P.bars * BAR)));
        for (const { part, i } of live) {
          const outOfRange = (part.notes || []).filter((n) => { const k = pitchOf(part, n); return k < 0 || k > 127; });
          if (outOfRange.length) out.push({ part, i, count: outOfRange.length, notes: outOfRange.map((n) => pitchOf(part, n)) });
          const usable = compiler().processNotes(part).filter((n) => n.t < end(part) && n.len > 0 && n.t + P.leadIn >= 0 && pitchOf(part, n) >= 0 && pitchOf(part, n) <= 127);
          const dropped = Seq.lanes(usable, Math.max(1, Math.round(part.voices || 1))).dropped;
          if (dropped > 0) voices.push({ part, i, count: dropped });
        }
        const said = [];
        for (const o of out) said.push(`${plural(o.count, 'note')} on ${partName(o.part, o.i)} ${o.count === 1 ? 'is' : 'are'} outside the notes the game has (0 to 127)`);
        for (const v of voices) said.push(`${partName(v.part, v.i)} plays ${plural(v.count, 'note')} too many at once for its ${plural(Math.max(1, Math.round(v.part.voices || 1)), 'voice')}`);
        const first = out[0] || voices[0];
        const shifts = out.map((o) => { const hi = Math.max(...o.notes), lo = Math.min(...o.notes); return hi > 127 && lo >= 0 ? -12 * Math.ceil((hi - 127) / 12) : lo < 0 && hi <= 127 ? 12 * Math.ceil(-lo / 12) : 0; });
        const fixable = out.length && shifts.every((s) => s !== 0);
        add('notes.dropped', `${plural(lost, 'note was', 'notes were')} lost: ${said.length ? said.join('; ') : 'there were too few voices or the notes were outside the game\'s range'}. ${voices.length ? 'Give the part more voices. ' : ''}${out.length ? 'Move the notes by an octave.' : ''}`.trim(),
          Object.assign({ partId: first ? partId(first.part, first.i) : undefined },
            fixable ? { fix: fixer(out.length === 1 ? `Move ${partName(out[0].part, out[0].i)} into range` : 'Move those parts into range', (p) => out.forEach((o, k) => { p.parts[o.i].transpose = (p.parts[o.i].transpose || 0) + shifts[k]; })) } : {}));
      }
      if (!tooMany) {
        const on = (report.tracks || []).filter((t) => t.sharedWithEffects);
        if (on.length) {
          const names = [], seen = new Set();
          for (const t of on) {
            const part = P.parts.find((x, i) => partId(x, i) === t.partId) || {}, i = P.parts.indexOf(part);
            const name = `${partName(part, i)}${t.kind === 'voice' ? '' : ` (${t.kind})`}`;
            if (!seen.has(name)) { seen.add(name); names.push(name); }
          }
          add('tracks.effects', `${joinNames(names)} sit${names.length === 1 ? 's' : ''} on tracks 13 to 16. The game's sound effects borrow those in a fight, so hits and voices will cut ${names.length === 1 ? 'it' : 'them'}.`, { partId: on[0].partId });
        }
      }
    }

    /* --- notes against instruments ----------------------------------------------------------------------- */
    if (catalog) {
      const tuneOff = [];
      for (const { part, i } of live) {
        const seen = new Map();                                       // 'bank:program' -> notes
        for (const x of programsOf(part)) { const k = `${x.bank}:${x.program}`; if (!seen.has(k)) seen.set(k, []); seen.get(k).push(x); }
        let total = 0, outside = 0, lowest = null;
        const ns = [];
        let kitMiss = 0, kitName = null, kitKeys = new Set();
        for (const [k, list] of seen) {
          const [bank, program] = k.split(':').map(Number), c = entryOf(catalog, bank, program);
          if (!c) continue;
          if (c.kit) {
            const sounding = new Set((c.keys || []).map((x) => x.key));
            for (const x of list) {
              const key = pitchOf(part, x.note);
              if (sounding.has(key) || (c.zones || []).some((z) => key >= z.keyLow && key <= z.keyHigh)) continue;
              kitMiss++; kitKeys.add(key); kitName = kitName || instrumentName(P, catalog, bank, program);
            }
            continue;
          }
          if (c.range) for (const x of list) { const key = pitchOf(part, x.note); total++; ns.push({ key, c, bank, program }); if (key < c.range.low || key > c.range.high) outside++; }
          if (!P.autoTune && typeof c.tuningCents === 'number' && c.tuningConfidence >= sure) {
            const residual = c.tuningCents + (part.tune || 0);
            if (Math.abs(residual) > TUNE_OFF_CENTS) tuneOff.push({ part, i, cents: Math.round(Math.abs(residual)), dir: residual < 0 ? 'flat' : 'sharp', name: instrumentName(P, catalog, bank, program) });
          }
        }
        if (kitMiss) {
          const keys = [...kitKeys].sort((a, b) => a - b).slice(0, 6).map((k) => noteName(k)).join(', '), one = kitKeys.size === 1;
          add('kit.keys', `${partName(part, i)} has ${plural(kitMiss, 'note')} on ${keys}, ${one ? 'a key that makes' : 'keys that make'} no sound on ${kitName}. Move ${kitMiss === 1 ? 'it' : 'them'} to ${one ? 'a key' : 'keys'} the kit has.`, { partId: partId(part, i) });
        }
        if (total && outside / total > OUTSIDE_SHARE) {
          const dom = ns.reduce((m, x) => { const k = `${x.bank}:${x.program}`; m[k] = (m[k] || 0) + 1; return m; }, {}), domKey = Object.keys(dom).sort((a, b) => dom[b] - dom[a])[0], c = catalog.programs[domKey];
          const insideAfter = (k) => ns.filter((x) => x.key + 12 * k >= x.c.range.low && x.key + 12 * k <= x.c.range.high).length;
          let bestK = 0, bestIn = insideAfter(0);
          for (const k of [1, -1, 2, -2, 3, -3, 4, -4]) { const v = insideAfter(k); if (v > bestIn) { bestIn = v; bestK = k; } }
          const [bank, program] = domKey.split(':').map(Number);
          add('range.outside', `${partName(part, i)} plays ${outside === total ? `all ${total} notes` : `${outside} of ${plural(total, 'note')}`} outside where Capcom plays ${instrumentName(P, catalog, bank, program)} (${noteName(c.range.low)} to ${noteName(c.range.high)}). ${bestK ? `Moving it ${bestK > 0 ? 'up' : 'down'} ${Math.abs(bestK) === 1 ? 'an octave' : `${Math.abs(bestK)} octaves`} puts ${bestIn === total ? 'all of them' : `${bestIn} of them`} inside.` : 'Try another octave or another instrument.'}`,
            Object.assign({ partId: partId(part, i) }, bestK ? { fix: fixer(`Move ${partName(part, i)} ${Math.abs(bestK) === 1 ? 'an octave' : `${Math.abs(bestK)} octaves`} ${bestK > 0 ? 'up' : 'down'}`, (p) => { p.parts[i].transpose = (p.parts[i].transpose || 0) + 12 * bestK; }) } : {}));
        }
      }
      if (tuneOff.length) {
        const words = tuneOff.map((t) => `${partName(t.part, t.i)} is about ${t.cents} cents ${t.dir} on ${t.name}`);
        add('tuning.off', `${words.join('; ')}, and Keep instruments in tune is off. Turn it on to correct each instrument.`, { partId: partId(tuneOff[0].part, tuneOff[0].i), fix: fixer('Keep instruments in tune', (p) => { p.autoTune = true; }) });
      }
    }

    /* --- level ------------------------------------------------------------------------------------------- */
    const m = ctx.metrics || null;
    if (m && typeof m.peak === 'number' && m.peak > CLIP) {
      const over = 20 * Math.log10(m.peak / 0.891), down = Math.max(0.5, Math.ceil(over * 10) / 10), factor = 0.891 / m.peak;
      add('level.clip', `The mix is too loud: its loudest moment is ${pct(m.peak)} of full scale, so it clips. Turn the parts down about ${down.toFixed(1)} dB.`, {
        fix: fixer(`Turn every part down ${down.toFixed(1)} dB`, (p) => { for (const part of p.parts) {
          if (typeof part.volume === 'number') part.volume = Math.max(1, Math.floor(part.volume * factor));
          const lane = part.automation && part.automation.volume;
          if (lane) for (const pt of lane) if (typeof pt.v === 'number') pt.v = Math.max(1, Math.floor(pt.v * factor));
        } }) });
    }
    const lead = catalog && catalog.roles && catalog.roles.lead;
    if (lead && typeof lead.volume === 'number' && typeof lead.expression === 'number') {
      const cap = lead.volume * (lead.expression + 1);
      for (const { part, i } of live) {
        const lanes = part.automation || {};
        if (part.role !== 'lead' || (lanes.volume && lanes.volume.length) || (lanes.expression && lanes.expression.length) || typeof part.volume !== 'number' || typeof part.expression !== 'number' || !(part.notes || []).length) continue;
        const db = 20 * Math.log10(part.volume * (part.expression + 1) / cap);
        if (db > LEAD_LOUD_DB) add('level.lead', `${partName(part, i)} sits ${db.toFixed(1)} dB above Capcom's leads (volume ${part.volume}, expression ${part.expression}; Capcom keeps its leads near ${lead.volume} and ${lead.expression}). A lead that loud covers the rest of the mix.`,
          { partId: partId(part, i), fix: fixer('Set to Capcom\'s lead level', (p) => { p.parts[i].volume = lead.volume; p.parts[i].expression = lead.expression; }) });
      }
    }

    /* --- the mix against Capcom -------------------------------------------------------------------------- */
    if (m) {
      const T = ctx.targets || TARGETS;
      const band = T.bands && T.bands[0];
      if (band && Array.isArray(m.bands) && (m.bands[0] < band.lo || m.bands[0] > band.hi))
        add('mix.low', m.bands[0] < band.lo ? `The low end is thin: ${pct(m.bands[0])} of the energy is below 150 Hz, and Capcom's themes sit between ${pct(band.lo)} and ${pct(band.hi)}. A louder bass or a break with more kick fills it.`
          : `The low end is heavy: ${pct(m.bands[0])} of the energy is below 150 Hz, and Capcom's themes sit between ${pct(band.lo)} and ${pct(band.hi)}. Turn the bass down or take out a low part.`);
      const cr = T.crest;
      if (cr && typeof m.crest === 'number' && (m.crest < cr.lo || m.crest > cr.hi))
        add('mix.punch', m.crest < cr.lo ? `The song sounds squashed: its peaks are ${m.crest.toFixed(1)} dB above its average loudness, and Capcom's themes have ${cr.lo.toFixed(1)} to ${cr.hi.toFixed(1)} dB. Fewer sustained parts or sharper notes bring the punch back.`
          : `The song is very peaky: its peaks are ${m.crest.toFixed(1)} dB above its average loudness, and Capcom's themes have ${cr.lo.toFixed(1)} to ${cr.hi.toFixed(1)} dB. Add body with held parts.`);
      const ks = T.keysPerSecond;
      if (ks && typeof m.keysPerSecond === 'number' && (m.keysPerSecond < ks.lo || m.keysPerSecond > ks.hi))
        add('mix.busy', m.keysPerSecond > ks.hi ? `The song plays ${m.keysPerSecond.toFixed(0)} notes a second, and Capcom's themes play ${ks.lo.toFixed(0)} to ${ks.hi.toFixed(0)}. Thin out the busiest parts.`
          : `The song plays only ${m.keysPerSecond < 1 ? 'about one note every ' + Math.max(2, Math.round(1 / Math.max(m.keysPerSecond, 0.01))) + ' seconds' : m.keysPerSecond.toFixed(0) + ' note' + (m.keysPerSecond.toFixed(0) === '1' ? '' : 's') + ' a second'}, and Capcom's themes play ${ks.lo.toFixed(0)} to ${ks.hi.toFixed(0)}. It may feel empty next to them.`);
    }
    const load = ctx.load;
    if (load) {
      const ratio = typeof load.ratio === 'number' ? load.ratio : (load.game && load.game.peak ? load.peak / load.game.peak : 0);
      if (ratio > 1) add('load.high', `The sound code works ${Math.round(ratio * 100)} % as hard as in the game's busiest piece${load.game && load.game.code ? ` (music ${load.game.code})` : ''}. A fight with many sound effects on top could slow the game. Lower the voices, or turn off an echo or a double.`);
    }

    /* --- loop, markers, size ----------------------------------------------------------------------------- */
    const hasMarkers = !!(P.markers && P.markers.length), phrase = P.markerBars > 0 && !hasMarkers ? P.markerBars * BAR : (() => {
      const lines = (P.markers || []).filter((x) => x.i === 0 && x.v === 1).map((x) => x.t).sort((a, b) => a - b), gaps = lines.slice(1).map((t, k) => t - lines[k]).filter((d) => d > 0);
      return gaps.length ? Math.min(...gaps) : 0;
    })();
    if (P.loop.on) {
      const length = P.loop.end - P.loop.start;
      if (phrase > 0 && length % phrase !== 0) {
        const k = Math.max(1, Math.floor(length / phrase + 0.5)), end = P.loop.start + k * phrase;
        add('loop.phrase', `The loop is ${barsText(length)} long, but the game's phrase markers come every ${barsText(phrase)}. A loop that ends mid-phrase puts the musical timing off. Make it ${barsText(k * phrase)}.`, {
          fix: fixer(`Make the loop ${barsText(k * phrase)}`, (p) => { p.loop.end = end; p.loop.endBar = Math.ceil(end / BAR); if (!p.length && end > p.bars * BAR) p.bars = Math.ceil(end / BAR); }) });
      }
      const cut = [];
      for (const { part, i } of live) {
        const end = P.loop.end + (part.loopShift || 0), count = (part.notes || []).filter((n) => n.t < end && n.t + n.len > end).length;
        if (count) cut.push({ part, i, count });
      }
      if (cut.length) add('loop.seam', `${cut.map((c) => `${plural(c.count, 'note')} on ${partName(c.part, c.i)}`).join(' and ')} run${cut.length === 1 && cut[0].count === 1 ? 's' : ''} past the loop point and ${cut.length === 1 && cut[0].count === 1 ? 'is' : 'are'} cut off there. Shorten ${cut.length === 1 && cut[0].count === 1 ? 'it' : 'them'} or end the loop on a bar line.`,
        { partId: partId(cut[0].part, cut[0].i), bar: Math.ceil(P.loop.end / BAR) });
    }
    if (!(P.markerBars > 0) && !hasMarkers) add('markers.off', 'Phrase markers are off, so the game\'s musical timing features will not work with this song. Turn them on.', { fix: fixer('Turn phrase markers on', (p) => { p.markerBars = 2; }) });
    if (report) {
      const bytes = typeof ctx.compressedBytes === 'number' ? ctx.compressedBytes : report.bytes;
      if (bytes > SIZE_LARGE) add('size.large', `This song takes ${KB(bytes)} in the ROM (${KB(report.bytesPlain || bytes)} written out in full). The ROM's music space is 188.4 KB, shared by every song.`);
    }
    if (P.loop.on && !P.chorusBar) add('chorus.none', 'No bar is set for rounds 2 and later, so every round starts from the top. Set "Rounds 2+ start at bar" in Song to the bar where the chorus begins.');

    /* --- parts ------------------------------------------------------------------------------------------- */
    for (const { part, i } of live) {
      const label = partName(part, i);
      if (!(part.notes || []).length) { if (P.tempoPart !== part.id) add('part.empty', `${label} has no notes. Add some, or delete the part.`, { partId: partId(part, i) }); continue; }
      const which = ['volume', 'expression'].filter((s) => { const lane = part.automation && part.automation[s]; return lane && lane.length ? lane.every((p) => p.v === 0) : part[s] === 0; });
      if (which.length) add('part.silent', `${label} is silent: its ${which.join(' and ')} is 0. Raise it, or mute the part on purpose.`, { partId: partId(part, i) });
    }

    /* --- harmony and custom instruments ------------------------------------------------------------------ */
    const h = ctx.harmony || harmony(P, { catalog });
    const flats = useFlats(h.key), nameOf = (id) => { const k = P.parts.findIndex((x, j) => partId(x, j) === id); return k < 0 ? id : partName(P.parts[k], k); };
    if (h.clashes.length) {
      const chosen = h.clashes.map((c, k) => ({ c, k })).sort((a, b) => b.c.ticks - a.c.ticks || a.k - b.k).slice(0, CLASH_LIMIT).sort((a, b) => a.k - b.k).map((x) => x.c);
      const rest = h.clashes.length - chosen.length;
      chosen.forEach((c, k) => {
        const tail = rest > 0 && k === chosen.length - 1 ? ` (${rest} more ${rest === 1 ? 'clash is' : 'clashes are'} not listed.)` : '';
        add('harmony.clash', `${nameOf(c.parts[0])} holds ${noteName(c.notes[0], flats)} while ${nameOf(c.parts[1])} holds ${noteName(c.notes[1], flats)}, a semitone apart, in bar ${c.bar}. The two rub against each other; move one of them.${tail}`, { partId: c.parts[0], bar: c.bar });
      });
    }
    if (P.bank) {
      const count = Object.keys(P.bank.programs || {}).length, Bank = g.SF3Bank || null;
      let size = built && built.bank && built.bank.bytes ? built.bank.bytes.length : 0;
      if (!size && Bank && Bank.size) { try { size = Bank.size(P.bank); } catch (e) { size = 0; } }
      add('bank.custom', `This song uses ${plural(count, 'custom instrument')}${size ? ` (${KB(size)})` : ''}. Besides the song, a ROM needs one extra change to play them, which the Studio's installer makes (see the ROM guide). Songs that use only the game's own instruments need nothing extra.`);
    }

    return issues.map((x, k) => ({ x, k })).sort((a, b) => LEVEL_ORDER[a.x.level] - LEVEL_ORDER[b.x.level] || CODE_ORDER.indexOf(a.x.code) - CODE_ORDER.indexOf(b.x.code) || a.k - b.k).map((e) => e.x);
  }

  function analyze(project, built, ctx) {
    ctx = ctx || {};
    const harm = ctx.harmony || harmony(project, { catalog: ctx.catalog });
    return { harmony: harm, issues: lint(project, built, Object.assign({}, ctx, { harmony: harm })), metrics: ctx.metrics || null, targets: ctx.targets || TARGETS, load: ctx.load || null };
  }

  /* ================================================================================================================
   * The agent brief
   * ================================================================================================================ */
  const MAX_PARTS = 20, MAX_CHORD_LINES = 24, MAX_ISSUES = 30;
  function brief(project, built, analysis) {
    analysis = analysis || {};
    const P = compiler().normalize(project), catalog = analysis.catalog || null, rep = built && built.report;
    const h = analysis.harmony || harmony(P, { catalog }), T = analysis.targets || TARGETS, m = analysis.metrics || null;
    const issues = analysis.issues || lint(P, built, Object.assign({}, analysis, { harmony: h }));
    const flats = useFlats(h.key), lines = [];
    const seconds = barTimes(P), pass = seconds[seconds.length - 1] - seconds[0];
    lines.push(`Song brief: ${P.name}`);
    const key = P.key && P.key.root !== null && P.key.root !== undefined ? `${pcName(P.key.root, useFlats(P.key))} ${P.key.scale}` : (h.key.root !== null ? `${pcName(h.key.root, flats)} ${h.key.scale} (found from the notes, confidence ${h.key.confidence.toFixed(2)})` : 'none found');
    lines.push(`Form: ${plural(P.bars, 'bar')} at ${P.bpm} BPM${P.tempoChanges.length ? ` with ${plural(P.tempoChanges.length, 'tempo change')}` : ''}, about ${pass.toFixed(1)} s a pass. ${P.loop.on ? `Loops bars ${P.loop.startBar} to ${P.loop.endBar}.` : 'Plays once.'} Phrase markers: ${P.markerBars > 0 ? `every ${plural(P.markerBars, 'bar')}` : (P.markers && P.markers.length ? 'listed' : 'off')}. ${P.chorusBar ? `Rounds 2+ start at bar ${P.chorusBar}.` : 'No bar set for rounds 2+.'}`);
    lines.push(`Key: ${key}.${P.sections.length ? ` Sections: ${P.sections.map((s) => `bar ${s.bar} ${s.name}`).join(', ')}.` : ''}`);
    if (rep) lines.push(`Build: ${plural(rep.tracks.length, 'track')} of 16 used; ${KB(rep.bytesPlain)} written out in full${rep.bytes !== rep.bytesPlain ? `, ${KB(rep.bytes)} with loops compressed` : ''}.${P.autoTune ? ' Instruments are kept in tune.' : ''}`);
    lines.push('', `Parts (${P.parts.length}):`);
    P.parts.slice(0, MAX_PARTS).forEach((part, i) => {
      const c = entryOf(catalog, part.bank, part.program), sound = part.bank === null || part.program === null ? 'the driver\'s own setting' : instrumentName(P, catalog, part.bank, part.program);
      const pitches = (part.notes || []).map((n) => pitchOf(part, n)).filter((n) => n >= 0 && n <= 127);
      const span = pitches.length && !(c && c.kit) ? `, ${noteName(Math.min(...pitches), flats)} to ${noteName(Math.max(...pitches), flats)}` : '';
      const devices = (part.devices || []).filter((d) => d && d.on !== false).map((d) => d.type);
      const tracks = rep && rep.partTracks[part.id] ? `, track${rep.partTracks[part.id].length === 1 ? '' : 's'} ${rep.partTracks[part.id].map((t) => t + 1).join('/')}` : '';
      lines.push(`  ${i + 1}. ${partName(part, i)}${part.role ? ` [${part.role}]` : ''}${part.mute ? ' (muted)' : ''}: ${sound}${c && c.kit ? ' (kit)' : ''}, volume ${part.volume === null ? 'unset' : part.volume}, expression ${part.expression === null ? 'unset' : part.expression}, ${plural(part.voices || 1, 'voice')}, ${plural((part.notes || []).length, 'note')}${span}${devices.length ? `, ${devices.join(' + ')}` : ''}${tracks}`);
    });
    if (P.parts.length > MAX_PARTS) lines.push(`  ... and ${plural(P.parts.length - MAX_PARTS, 'more part')}.`);
    /* chords, one token per bar, repeats folded */
    lines.push('', 'Chords by bar (pitched parts; * N = the same chord for N bars):');
    const tokens = [];
    for (const b of h.bars) { const t = b.chord || '-'; const last = tokens[tokens.length - 1]; if (last && last.t === t) last.n++; else tokens.push({ t, n: 1, bar: b.bar }); }
    let row = [], rows = 0, shown = 0;
    const flush = () => { if (row.length) { lines.push(`  bar ${row[0].bar}: ${row.map((x) => (x.n > 1 ? `${x.t} * ${x.n}` : x.t)).join(' | ')}`); rows++; shown += row.reduce((s, x) => s + x.n, 0); row = []; } };
    for (const tok of tokens) { if (row.length === 8) { if (rows + 1 >= MAX_CHORD_LINES) break; flush(); } row.push(tok); }
    if (rows < MAX_CHORD_LINES) flush();
    if (shown < h.bars.length) lines.push(`  ... ${plural(h.bars.length - shown, 'more bar')} not listed.`);
    /* the mix */
    lines.push('');
    if (m) {
      const row3 = (label, v, t, unit, digits) => (t && typeof v === 'number' ? `  ${label}: ${v.toFixed(digits)}${unit}; Capcom ${t.lo.toFixed(digits)} to ${t.hi.toFixed(digits)}${unit}${t.median !== null && t.median !== undefined ? ` (median ${t.median.toFixed(digits)}${unit})` : ''}; ${v < t.lo ? 'below' : v > t.hi ? 'above' : 'inside'}` : null);
      lines.push('Mix against Capcom\'s themes (their middle 80 %):');
      for (const l of [row3('low end, below 150 Hz', m.bands[0], T.bands[0], '', 2), row3('150 to 600 Hz', m.bands[1], T.bands[1], '', 2), row3('600 to 2500 Hz', m.bands[2], T.bands[2], '', 2),
        row3('above 2500 Hz', m.bands[3], T.bands[3], '', 2), row3('punch (peak over average)', m.crest, T.crest, ' dB', 1), row3('loudness motion', m.motion, T.motion, ' dB', 1),
        row3('notes a second', m.keysPerSecond, T.keysPerSecond, '', 1)]) if (l) lines.push(l);
      lines.push(`  loudness ${m.rms.toFixed(1)} dBFS, loudest moment ${pct(m.peak)} of full scale${m.voices !== null && m.voices !== undefined ? `, ${m.voices.toFixed(1)} voices sounding on average` : ''}, width ${m.width.toFixed(2)}`);
    } else lines.push('Mix numbers: not measured.');
    if (analysis.load && analysis.load.game) lines.push(`Driver load: ${Math.round((typeof analysis.load.ratio === 'number' ? analysis.load.ratio : analysis.load.peak / analysis.load.game.peak) * 100)} % of the game's busiest piece.`);
    /* the check */
    lines.push('', issues.length ? `Game check: ${plural(issues.length, 'issue')}.` : 'Game check: ready for the game.');
    for (const i of issues.slice(0, MAX_ISSUES)) lines.push(`  [${i.level}] ${i.code}: ${i.message}`);
    if (issues.length > MAX_ISSUES) lines.push(`  ... and ${plural(issues.length - MAX_ISSUES, 'more issue')}.`);
    if (lines.length > 119) lines.length = 119;
    return lines.join('\n');
  }

  const api = { metrics, measure, spectrum, sections, barTimes, targets, TARGETS, harmony, driverLoad, lint, analyze, brief, ISSUES, noteName };
  g.SF3Analyze = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
