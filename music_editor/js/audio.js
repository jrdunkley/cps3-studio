/* The Studio's audio out: song rendering, WAV files, resampling and stems. Headless: the same code runs
 * in the page and under Node. Nothing here imitates the driver: every sample is what js/engine.js's
 * game driver and chip produce, mixed as integers; this file only runs engines, cuts the result, and
 * converts it once at the end. WAV only, no third-party code.
 * Docs: docs/plan/wp/A8_audio.md. Gate: checks/gates/g_audio.js (G9).
 *
 *   SF3Audio.render(Engine, pack, setup, opts)  -> { L, R, n, rate, frames, loop, stereo }  Int32 mix at the chip rate
 *   SF3Audio.renderJob(...)                      the same in slices: job.advance(ms), job.progress, job.done, job.result, job.cancel()
 *   SF3Audio.resample(audio, toRate)             windowed sinc; exact length round(n * to / from)
 *   SF3Audio.wav(audio, opts)                    -> Uint8Array (16-bit PCM, optional smpl loop chunk); .info says what happened
 *   SF3Audio.stems(Engine, pack, built, project, opts) -> [ { partId, part, name, bytes, tracks, mask } ]   one WAV per part
 *   SF3Audio.stemsJob(...)                       the same in slices (job.engine: the engine of the run in progress, or the last)
 *   SF3Audio.peak(audio), .seconds(audio), .lengthFor(built, project, opts), .safeName(text)
 *
 * setup: what to play. A request code (number), a sequence (Uint8Array, played from the preview slot), a
 * build result ({ bytes, bank? }: a custom bank is installed first), or a function(engine) that does
 * anything the Studio can do to an engine (patchSequence, installBank, request ...).
 *
 * opts (render and stems), how long. Ticks are the DRIVER's ticks, the ones Seq.follow reports (a project's
 * ticks plus its leadIn):
 *   frames                  driver frames (59.59949 per second);
 *   ticks                   until the driver's own clock reaches that tick: the audio ends on the last sample
 *                           before the events of that tick fire;
 *   intro, loopTicks, loops intro + `loops` passes (default 2), then a fade over the last fadeSeconds (default 8);
 *   exactLoop: true         intro and ONE pass, no fade, and loop = { start, end } in samples for the WAV
 *                           (half open: end is the first sample of the next pass);
 *   stereo (false)          the driver's stereo switch. Off is what Fightcade plays: both sides identical;
 *   mute                    mixer mask of voices to silence (bit k = track k = chip voice k);
 *   fadeSeconds, tail       a raised-cosine fade over the last seconds of the audio, then `tail` seconds of silence;
 *   maxSeconds (600)        stop a clock that never reaches its tick.
 * Only for stems: mono (write one-channel files when both sides are equal), rate (resample every stem to it),
 * normalise (one gain for all stems, from the peak of the finished mix, so they still add up), gain (that
 * gain given), includeMuted (parts with mute: true get stems too), keepAudio (stems keep their audio objects),
 * memoryMB (256: how many stems share one run of the driver; the rest wait for another run).
 * Fades, resampling and normalising round: the stems add up to the mix to the sample before them, and to
 * within a sample or two after.
 *
 * The clock (measured against the driver's key-on frames, gate G9): a step of the driver adds the tempo word
 * it had when the step began; the events of tick T fire in the first step whose running total reaches T * 256.
 * The driver works in whole frames, so a loop pass is a whole number of frames and differs by one frame between
 * passes when the loop is not a whole number of frames long (the game itself jitters like that): loop points
 * are exact on the frame grid the driver plays, to the sample.
 */
(function (g) {
  'use strict';
  const CHIP_RATE = 42954500 / 1152;         /* 42954500 / 3 / 384 Hz: 37286.89..., exactly */
  const FRAME_RATE = 59.59949, PREVIEW_CODE = 60, LEAD_IN = 2, BAR = 192;
  const FULL = 32768, NORMAL_PEAK = Math.pow(10, -1 / 20);     /* -1 dBFS */
  const FPC = 256, CAP = FPC * 627 + 64;     /* frames per buffer chunk; a frame is at most 626 samples */
  const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

  function engineClass(E) {
    E = E || (g.SF3Engine && g.SF3Engine.Engine) || require('./engine.js').Engine;
    return E.Engine || E;
  }

  /* ---- what to play ---------------------------------------------------------------------------- */
  function bytesSetup(bytes, bank) {
    return (e) => {
      if (bank && bank.bytes) e.installBank(bank);
      e.patchSequence(bytes, PREVIEW_CODE, 0);
      e.request(PREVIEW_CODE);
    };
  }
  function toSetup(src) {
    if (typeof src === 'function') return src;
    if (typeof src === 'number') return (e) => e.request(src);
    if (ArrayBuffer.isView(src) && src.BYTES_PER_ELEMENT === 1) return bytesSetup(src);
    if (Array.isArray(src)) return bytesSetup(Uint8Array.from(src));
    if (src && src.bytes) return bytesSetup(src.bytes, src.bank);
    throw new Error('Say what to play: a request code, the bytes of a song, a build, or a function that sets up the engine.');
  }

  /* ---- how long -------------------------------------------------------------------------------- */
  function resolvePlan(opts) {
    opts = opts || {};
    const p = { stereo: !!opts.stereo, mute: opts.mute === undefined || opts.mute === null ? null : opts.mute & 0xFFFF,
                tail: Math.max(0, Number(opts.tail) || 0), fade: 0, frames: null, target: null, marks: [], exactLoop: !!opts.exactLoop,
                maxFrames: Math.round((opts.maxSeconds || 600) * FRAME_RATE) };
    const loopy = opts.intro !== undefined || opts.loopTicks !== undefined;
    if (loopy && !(opts.intro >= 0 && opts.loopTicks > 0)) throw new Error('A loop needs its intro and its length in ticks (intro, loopTicks).');
    if (opts.frames !== undefined) {
      if (!(opts.frames >= 0)) throw new Error('frames must be zero or more.');
      p.frames = Math.round(opts.frames);
    } else if (opts.ticks !== undefined) {
      if (!(opts.ticks > 0)) throw new Error('ticks must be more than zero.');
      p.target = opts.ticks * 256;
    } else if (loopy) {
      const loops = p.exactLoop ? 1 : (opts.loops === undefined ? 2 : opts.loops);
      if (!(loops >= 1)) throw new Error('loops must be one or more.');
      p.target = (opts.intro + loops * opts.loopTicks) * 256;
    } else throw new Error('Say how long to render: frames, ticks, or intro and loopTicks.');
    if (loopy) p.marks = [opts.intro * 256, (opts.intro + opts.loopTicks) * 256];
    p.fade = p.exactLoop ? 0 : (opts.fadeSeconds !== undefined ? Math.max(0, Number(opts.fadeSeconds) || 0) : (loopy ? 8 : 0));
    return p;
  }

  /* The length a finished build wants when the caller does not say: the introduction and two passes of its
   * loop (a play-once song: its bars, the lead-in and 96 ticks to die away). */
  function lengthFor(built, project, opts) {
    opts = opts || {};
    if (opts.frames !== undefined || opts.ticks !== undefined || opts.intro !== undefined || opts.loopTicks !== undefined) return opts;
    const lead = project && project.leadIn !== undefined ? project.leadIn : LEAD_IN, loop = built && built.loop;
    if (loop && loop.end > loop.start) return Object.assign({ intro: loop.start + lead, loopTicks: loop.end - loop.start, loops: 2 }, opts);
    const length = project && (project.length || (project.bars ? project.bars * BAR : 0));
    if (length) return Object.assign({ ticks: length + lead + 96 }, opts);
    throw new Error('Say how long to render: frames, ticks, or intro and loopTicks.');
  }

  /* ---- running the driver ---------------------------------------------------------------------- */
  /* One engine, run frame by frame into chunked Int32 buffers. Plain: the whole mix (Engine.step, exactly as the
   * gates' lib.audio). With `cells` (a partition of the 16 voices, each with an output or -1): the driver runs
   * ONCE and each cell mixes only its own voices into its own buffers; the voices are advanced once each, so
   * the cells' sum is the whole mix to the sample and the driver's view of the chip is untouched. */
  class Run {
    constructor(E, pack, src, plan, cells, outCount) {
      const Eng = engineClass(E);
      if (Eng.preparePack) Eng.preparePack(pack);           /* decoded once, shared by every engine made here */
      const e = this.e = new Eng(pack, { stereo: plan.stereo });
      toSetup(src)(e);
      if (plan.mute !== null) e.mute = plan.mute;
      Object.assign(this, { plan, cells, mi: 0, markAt: [], frame: 0, clock: 0, n: 0, at: 0, inChunk: 0, done: false, outs: [] });
      for (let i = 0; i < outCount; i++) this.outs.push({ L: new Int32Array(CAP), R: new Int32Array(CAP), chunks: [] });
    }
    measure() {
      const p = this.plan;
      return p.frames !== null ? (p.frames ? this.frame / p.frames : 1) : Math.min(1, this.clock / p.target);
    }
    roll() {
      for (let i = 0; i < this.outs.length; i++) {
        const o = this.outs[i];
        if (!o) continue;
        o.chunks.push({ L: o.L, R: o.R, len: this.at });
        o.L = new Int32Array(CAP); o.R = new Int32Array(CAP);
      }
      this.at = 0; this.inChunk = 0;
    }
    /* One driver frame; false when the render is complete (nothing was run). */
    stepFrame() {
      const e = this.e, p = this.plan, next = this.clock + e.tempo();
      while (this.mi < p.marks.length && next >= p.marks[this.mi]) this.markAt[this.mi++] = this.n;
      if (p.frames !== null) { if (this.frame >= p.frames) return false; }
      else {
        if (next >= p.target) return false;
        if (this.frame >= p.maxFrames) throw new Error(`The song never reached tick ${p.target / 256} in ${Math.round(p.maxFrames / FRAME_RATE)} seconds (does it set a tempo?).`);
      }
      if (this.inChunk === FPC) this.roll();
      let n;
      if (!this.cells) { const o = this.outs[0]; n = e.step(o.L, o.R, this.at); }
      else {
        n = e.tick();
        const key0 = e.key; let key1 = 0;
        for (const c of this.cells) {
          const o = c.out >= 0 ? this.outs[c.out] : null;
          e.key = key0 & c.mask;                       /* only this cell's voices run; the chip clears their key bits itself when a sample ends */
          e.chip(n, o && o.L, o && o.R, this.at);
          key1 |= e.key;
        }
        e.key = key1;
      }
      this.at += n; this.n += n; this.inChunk++; this.frame++; this.clock = next;
      return true;
    }
    advance(ms) {
      if (this.done) return true;
      const t0 = ms > 0 ? now() : 0;
      for (;;) {
        for (let k = 0; k < 16; k++) if (!this.stepFrame()) { this.done = true; return true; }
        if (ms > 0 && now() - t0 >= ms) return false;
      }
    }
    loop() { return this.markAt.length === 2 ? { start: this.markAt[0], end: this.markAt[1] } : null; }
    /* output i as one Int32 pair (`extra` samples of silence after it), freeing its chunks */
    collect(i, extra) {
      const o = this.outs[i];
      o.chunks.push({ L: o.L, R: o.R, len: this.at });
      const total = this.n, L = new Int32Array(total + extra), R = new Int32Array(total + extra);
      let p = 0;
      for (const c of o.chunks) { L.set(c.L.subarray(0, c.len), p); R.set(c.R.subarray(0, c.len), p); p += c.len; }
      this.outs[i] = null;
      return { L, R, n: total + extra, base: total };
    }
    release() { this.outs = []; this.cells = null; }
  }

  /* the raised-cosine fade over the last `seconds` before `end`, in place on audio this module made */
  function fadeOut(audio, end, seconds) {
    const N = Math.min(end, Math.round(seconds * CHIP_RATE)), start = end - N, L = audio.L, R = audio.R;
    for (let i = 0; i < N; i++) {
      const gain = 0.5 * (1 + Math.cos(Math.PI * (i + 1) / N));
      L[start + i] = Math.round(L[start + i] * gain); R[start + i] = Math.round(R[start + i] * gain);
    }
  }
  function makeAudio(run, raw, plan) {
    const audio = { L: raw.L, R: raw.R, n: raw.n, rate: CHIP_RATE, frames: run.frame, loop: run.loop(), stereo: plan.stereo };
    if (plan.fade > 0) fadeOut(audio, raw.base, plan.fade);
    return audio;
  }
  const tailSamples = (plan) => Math.round(plan.tail * CHIP_RATE);

  /* ---- jobs: the same work in slices, so a page can show progress and cancel ------------------- */
  class Job {
    /* engine: the engine of the run in progress (or the last one), for meters and tests; nothing else is shared */
    constructor() { this.done = false; this.result = null; this.cancelled = false; this.stopAt = 0; this.engine = null; }
    get progress() { return this.done ? 1 : this.cancelled ? this.stopAt : Math.min(0.999, this.measure()); }
    /* Work for about `ms` milliseconds (0 or none: to the end). Returns the progress, 0..1. */
    advance(ms) {
      if (!this.done && !this.cancelled) {
        const t0 = now();
        do this.work(ms > 0 ? Math.max(0.5, ms - (now() - t0)) : 0);
        while (!this.done && !this.cancelled && !(ms > 0 && now() - t0 >= ms));
      }
      return this.progress;
    }
    cancel() { if (!this.done && !this.cancelled) { this.stopAt = this.progress; this.cancelled = true; this.release(); } }
  }

  class RenderJob extends Job {
    constructor(run, plan) { super(); this.run = run; this.plan = plan; this.engine = run.e; }
    measure() { return this.run.measure(); }
    work(budget) {
      if (!this.run.advance(budget)) return;
      this.result = makeAudio(this.run, this.run.collect(0, tailSamples(this.plan)), this.plan);
      this.done = true; this.release();
    }
    release() { if (this.run) this.run.release(); this.run = null; }
  }
  function renderJob(E, pack, setup, opts) {
    const plan = resolvePlan(opts);
    return new RenderJob(new Run(E, pack, setup, plan, null, 1), plan);
  }
  function render(E, pack, setup, opts) { const job = renderJob(E, pack, setup, opts); job.advance(0); return job.result; }

  /* ---- helpers on audio objects ---------------------------------------------------------------- */
  function sameSides(a) {
    if (a.L === a.R) return true;
    const L = a.L, R = a.R, n = a.n;
    for (let i = 0; i < n; i++) if (L[i] !== R[i]) return false;
    return true;
  }
  /* loudest sample as a fraction of full scale (1 = 32768; more than 1 means the mix would clip) */
  function peak(audio) {
    let m = 0;
    const scan = (a) => { for (let i = 0, n = audio.n; i < n; i++) { const v = a[i]; if (v > m) m = v; else if (-v > m) m = -v; } };
    scan(audio.L);
    if (audio.R !== audio.L) scan(audio.R);
    return m / FULL;
  }
  const seconds = (audio) => audio.n / (audio.rate || CHIP_RATE);
  const db = (x) => 20 * Math.log10(x);

  /* ---- resampling ------------------------------------------------------------------------------ */
  /* Windowed sinc (Kaiser, beta 9, about -90 dB), 32 zero crossings each side at the LOWER of the two rates,
   * cutoff at 94 % of that rate's Nyquist (so a 15 kHz tone sent to 22.05 kHz is rejected, not folded).
   * The kernel is tabulated at 1024 sub-sample phases and interpolated linearly (error about -120 dB), each
   * phase normalised to sum 1 (exact unity gain at DC). The output sample j is taken at input position
   * j * from / to: no delay. Beyond the ends the input counts as silence. Equal sides are filtered once. */
  const BETA = 9, HALF = 32, CUT = 0.94, PHASES = 1024;
  const tables = new Map();
  function besselI0(x) {
    let sum = 1, term = 1;
    const q = x * x / 4;
    for (let k = 1; term > sum * 1e-17; k++) { term *= q / (k * k); sum += term; }
    return sum;
  }
  function kernelTable(from, to) {
    const key = from + '|' + to;
    if (tables.has(key)) return tables.get(key);
    const s = Math.max(1, from / to), fc = CUT * 0.5 / s, W = HALF * s, M = Math.ceil(W), T = 2 * M, i0b = besselI0(BETA);
    const data = new Float64Array((PHASES + 1) * T);
    for (let r = 0; r <= PHASES; r++) {
      const frac = r / PHASES;
      let sum = 0;
      for (let k = 0; k < T; k++) {
        const t = k - (M - 1) - frac;                 /* input samples from the output instant to tap k (input index i0 - (M - 1) + k) */
        let v = 0;
        if (Math.abs(t) < W) {
          const x = 2 * fc * t, u = t / W;
          v = (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x)) * 2 * fc * besselI0(BETA * Math.sqrt(1 - u * u)) / i0b;
        }
        data[r * T + k] = v; sum += v;
      }
      for (let k = 0; k < T; k++) data[r * T + k] /= sum;
    }
    if (tables.size > 6) tables.clear();
    const table = { M, T, data };
    tables.set(key, table);
    return table;
  }
  function resample(audio, toRate) {
    const from = audio.rate || CHIP_RATE, to = Number(toRate);
    if (!(to > 0) || !isFinite(to)) throw new Error(`${toRate} is not a sample rate.`);
    if (to === from) return audio;
    const n = audio.n, nOut = Math.round(n * to / from), mono = sameSides(audio);
    const outL = new Float32Array(nOut), outR = mono ? outL : new Float32Array(nOut);
    if (nOut && n) {
      const { M, T, data } = kernelTable(from, to), step = from / to, Lin = audio.L, Rin = audio.R;
      for (let j = 0; j < nOut; j++) {
        const pos = j * step, i0 = Math.floor(pos), fr = (pos - i0) * PHASES, r = Math.floor(fr), w = fr - r;
        const b = r * T, b2 = b + T, lo = i0 - (M - 1);
        let aL = 0, aR = 0;
        if (lo >= 0 && lo + T <= n) {           /* the whole window is inside the audio (T is even); unrolled, about 30 % faster */
          if (mono) {
            let a1 = 0, a2 = 0, a3 = 0, k = 0;
            for (; k + 4 <= T; k += 4) {
              const c0 = data[b + k], c1 = data[b + k + 1], c2 = data[b + k + 2], c3 = data[b + k + 3];
              aL += (c0 + (data[b2 + k] - c0) * w) * Lin[lo + k]; a1 += (c1 + (data[b2 + k + 1] - c1) * w) * Lin[lo + k + 1];
              a2 += (c2 + (data[b2 + k + 2] - c2) * w) * Lin[lo + k + 2]; a3 += (c3 + (data[b2 + k + 3] - c3) * w) * Lin[lo + k + 3];
            }
            for (; k < T; k++) { const c = data[b + k]; aL += (c + (data[b2 + k] - c) * w) * Lin[lo + k]; }
            aL += a1 + a2 + a3;
          } else {
            let bL = 0, bR = 0;
            for (let k = 0; k < T; k += 2) {
              const c0 = data[b + k], c1 = data[b + k + 1], w0 = c0 + (data[b2 + k] - c0) * w, w1 = c1 + (data[b2 + k + 1] - c1) * w;
              aL += w0 * Lin[lo + k]; bL += w1 * Lin[lo + k + 1]; aR += w0 * Rin[lo + k]; bR += w1 * Rin[lo + k + 1];
            }
            aL += bL; aR += bR;
          }
        } else {
          for (let k = 0; k < T; k++) {
            const idx = lo + k;
            if (idx < 0 || idx >= n) continue;
            const c = data[b + k], wt = c + (data[b2 + k] - c) * w;
            aL += wt * Lin[idx]; if (!mono) aR += wt * Rin[idx];
          }
        }
        outL[j] = aL; if (!mono) outR[j] = aR;
      }
    }
    const loop = audio.loop ? { start: Math.min(nOut, Math.round(audio.loop.start * to / from)), end: Math.min(nOut, Math.round(audio.loop.end * to / from)) } : null;
    return { L: outL, R: outR, n: nOut, rate: to, frames: audio.frames, loop, stereo: audio.stereo };
  }

  /* ---- WAV ------------------------------------------------------------------------------------- */
  /* 16-bit PCM. Integer mixes are written as they are, clipped at full scale; resampled (float) audio is
   * rounded once. opts: mono (a one-channel file, only when both sides are equal), gain (a plain multiplier),
   * normalise (scale the peak to -1 dBFS), loop ({ start, end } in samples, end exclusive, or true for
   * audio.loop: a `smpl` chunk with one forward endless loop). The result carries .info: { channels, bits, rate,
   * frames, bytes, peak (before the gain, fraction of full scale), gain, gainDb, clipped }. The header rate is
   * rounded to a whole number (the chip's 37286.89 Hz becomes 37287: 0.0003 % fast). */
  function wav(audio, opts) {
    opts = opts || {};
    const bits = opts.bits === undefined ? 16 : opts.bits;
    if (bits !== 16) throw new Error('Only 16-bit WAV files are written.');
    const n = audio.n, L = audio.L, R = audio.R, rate = Math.round(audio.rate || CHIP_RATE);
    const mono = !!opts.mono && sameSides(audio), channels = mono ? 1 : 2;
    let loop = opts.loop === true ? audio.loop : opts.loop || null;
    if (loop && !(Number.isInteger(loop.start) && Number.isInteger(loop.end) && loop.start >= 0 && loop.end > loop.start && loop.end <= n)) throw new Error(`The loop (${loop.start}..${loop.end}) must lie inside the audio (${n} samples) and end after it starts.`);
    const pk = peak(audio);
    let gain = 1;
    if (opts.gain !== undefined) gain = Number(opts.gain);
    else if (opts.normalise && pk > 0) gain = NORMAL_PEAK / pk;
    const dataBytes = n * channels * 2, smplBytes = loop ? 68 : 0, total = 12 + 24 + 8 + dataBytes + (dataBytes & 1) + smplBytes;
    const out = new Uint8Array(total);
    const u32 = (p, v) => { out[p] = v & 255; out[p + 1] = (v >>> 8) & 255; out[p + 2] = (v >>> 16) & 255; out[p + 3] = (v >>> 24) & 255; };
    const u16 = (p, v) => { out[p] = v & 255; out[p + 1] = (v >>> 8) & 255; };
    const tag = (p, s) => { for (let i = 0; i < 4; i++) out[p + i] = s.charCodeAt(i); };
    tag(0, 'RIFF'); u32(4, total - 8); tag(8, 'WAVE');
    tag(12, 'fmt '); u32(16, 16); u16(20, 1); u16(22, channels); u32(24, rate); u32(28, rate * channels * 2); u16(32, channels * 2); u16(34, 16);
    tag(36, 'data'); u32(40, dataBytes);
    let p = 44, clipped = 0;
    const put = (x) => {
      let v = Math.round(x * gain);
      if (v > 32767) { v = 32767; clipped++; } else if (v < -32768) { v = -32768; clipped++; }
      out[p] = v & 255; out[p + 1] = (v >> 8) & 255; p += 2;
    };
    if (mono) for (let i = 0; i < n; i++) put(L[i]);
    else for (let i = 0; i < n; i++) { put(L[i]); put(R[i]); }
    if (loop) {
      let q = 44 + dataBytes + (dataBytes & 1);
      tag(q, 'smpl'); u32(q + 4, 60);
      u32(q + 8, 0); u32(q + 12, 0); u32(q + 16, Math.round(1e9 / rate)); u32(q + 20, 60); u32(q + 24, 0); u32(q + 28, 0); u32(q + 32, 0); u32(q + 36, 1); u32(q + 40, 0);
      u32(q + 44, 0); u32(q + 48, 0); u32(q + 52, loop.start); u32(q + 56, loop.end - 1); u32(q + 60, 0); u32(q + 64, 0);
    }
    out.info = { channels, bits: 16, rate, frames: n, bytes: total, peak: pk, gain, gainDb: gain > 0 ? db(gain) : -Infinity, clipped };
    return out;
  }

  /* ---- stems ----------------------------------------------------------------------------------- */
  const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;
  /* a file name part: letters, digits, _ and -, at most 40 long, never a reserved Windows name */
  function safeName(text, fallback) {
    let s = String(text === undefined || text === null ? '' : text).replace(/[^A-Za-z0-9 _-]+/g, ' ').trim().replace(/\s+/g, '_').replace(/^[_-]+|[_-]+$/g, '').slice(0, 40).replace(/[_-]+$/, '');
    if (!s) s = fallback || 'part';
    return RESERVED.test(s) ? s + '_' : s;
  }
  const tracksDefined = (bytes) => { let m = 0; if (bytes) for (let k = 0; k < 16; k++) if (bytes[1 + 2 * k] || bytes[2 + 2 * k]) m |= 1 << k; return m; };

  /* the parts that get a stem: { partId, part, tracks, mask } in the project's order, then an Other stem for
   * defined tracks no part claims; muted parts (project.parts[].mute) and opts.mute silence their voices in every stem */
  function stemSpec(built, project, opts) {
    const report = (built && built.report) || {}, projParts = (project && project.parts) || [];
    const idOf = (p, i) => (p && p.id !== undefined && p.id !== null ? String(p.id) : String(i));
    let map = report.partTracks;
    if (!map) {                                    /* the old builder's report, or any list of tracks that know their part */
      map = {};
      (report.tracks || []).forEach((t) => {
        let id = t.partId !== undefined && t.partId !== null ? t.partId : projParts.indexOf(t.part);
        if (id === -1 || id === undefined) id = (t.part && t.part.name) || 'part';
        (map[id] = map[id] || []).push(t.track);
      });
    }
    const keys = Object.keys(map), order = [], meta = {};
    projParts.forEach((p, i) => { const id = idOf(p, i); if (id in map) { order.push(id); meta[id] = p; } });
    keys.forEach((id) => { if (!order.includes(id)) order.push(id); });
    let claimed = 0, muted = (opts.mute || 0) & 0xFFFF;
    const parts = [], owner = {};
    for (const id of order) {
      const tracks = map[id].slice();
      let mask = 0;
      for (const t of tracks) {
        if (!(Number.isInteger(t) && t >= 0 && t < 16)) throw new Error(`Part "${id}" names track ${t}, but the game has tracks 0 to 15.`);
        if ((claimed | mask) & (1 << t) && owner[t] !== id) throw new Error(`Driver track ${t} belongs to two parts ("${owner[t]}" and "${id}").`);
        mask |= 1 << t; owner[t] = id;
      }
      claimed |= mask;
      const part = meta[id] || {};
      if (part.mute && !opts.includeMuted) muted |= mask;
      if (mask) parts.push({ partId: id, part: part.name || id, tracks, mask });
    }
    const stems = parts.filter((s) => s.mask & ~muted);
    const other = tracksDefined(built && built.bytes) & ~claimed & ~muted & 0xFFFF;
    if (other) stems.push({ partId: null, part: 'Other', tracks: Array.from({ length: 16 }, (_, k) => k).filter((k) => other & (1 << k)), mask: other });
    if (!stems.length) throw new Error('There is nothing to render: no part has a track that plays.');
    return { stems, muted };
  }

  /* frames the run is expected to take, to size the groups: a throwaway engine learns the tempo */
  function estimateFrames(E, pack, src, plan) {
    if (plan.frames !== null) return plan.frames;
    const Eng = engineClass(E), e = new Eng(pack);
    toSetup(src)(e);
    for (let i = 0; i < 4; i++) e.step();
    return Math.min(plan.maxFrames, Math.ceil(plan.target / (e.tempo() || 256))) + 16;
  }

  class StemsJob extends Job {
    constructor(E, pack, built, project, opts) {
      super();
      opts = lengthFor(built, project, opts || {});
      const spec = stemSpec(built, project, opts), plan = resolvePlan(opts);
      plan.mute = spec.muted ? spec.muted : null;
      Object.assign(this, { E, pack, src: { bytes: built.bytes, bank: built.bank }, opts, plan, spec, run: null, finishing: null, queue: [], completed: 0, next: 0, gain: opts.gain, results: [] });
      const digits = Math.max(2, String(spec.stems.length).length);
      spec.stems.forEach((s, i) => { s.index = i; s.name = String(i + 1).padStart(digits, '0') + '_' + safeName(s.part, 'part') + '.wav'; });
      const frames = estimateFrames(E, pack, this.src, plan), perStem = Math.max(1, frames) * 627 * 8;
      const group = Math.max(1, Math.min(spec.stems.length, Math.floor((opts.memoryMB === undefined ? 256 : opts.memoryMB) * 1048576 / perStem)));
      this.phases = opts.normalise && opts.gain === undefined ? [{ mix: true }] : [];
      for (let i = 0; i < spec.stems.length; i += group) this.phases.push({ stems: spec.stems.slice(i, i + group) });
    }
    /* a phase is 85 % running the driver, 15 % turning its stems into files */
    measure() {
      const inPhase = this.run ? 0.85 * this.run.measure() : this.finishing ? 0.85 + 0.15 * (1 - this.queue.length / this.queued) : 0;
      return (this.completed + inPhase) / this.phases.length;
    }
    work(budget) {
      if (this.queue.length) {
        this.queue.shift()();
        if (!this.queue.length) { this.completed++; this.finishing.release(); this.finishing = null; }
        return;
      }
      if (this.run) {
        if (!this.run.advance(budget)) return;
        this.finishing = this.run; this.run = null;
        this.queue = this.steps(); this.queued = this.queue.length;   /* one finishing step per stem, so a page can breathe between them */
        return;
      }
      if (this.next < this.phases.length) { this.start(this.phases[this.next++]); return; }
      this.result = this.results.slice();
      this.done = true;
    }
    start(phase) {
      const { E, pack, src, plan } = this;
      if (phase.mix) {                           /* the common gain: the peak of the finished mix (fade, resampling and all) */
        const run = this.run = new Run(E, pack, src, plan, null, 1);
        this.engine = run.e;
        this.steps = () => [() => {
          let audio = makeAudio(run, run.collect(0, tailSamples(plan)), plan);
          if (this.opts.rate) audio = resample(audio, this.opts.rate);
          const pk = peak(audio);
          this.gain = pk > 0 ? NORMAL_PEAK / pk : 1;
        }];
        return;
      }
      const cells = phase.stems.map((s, i) => ({ mask: s.mask, out: i }));
      const rest = 0xFFFF & ~phase.stems.reduce((m, s) => m | s.mask, 0);
      if (rest) cells.push({ mask: rest, out: -1 });
      const run = this.run = new Run(E, pack, src, plan, cells, phase.stems.length);
      this.engine = run.e;
      this.steps = () => phase.stems.map((s, i) => () => this.finishStem(s, run, i));
    }
    finishStem(stem, run, i) {
      const plan = this.plan, opts = this.opts;
      let audio = makeAudio(run, run.collect(i, tailSamples(plan)), plan);
      if (opts.rate) audio = resample(audio, opts.rate);
      const bytes = wav(audio, { mono: !!opts.mono, gain: this.gain, loop: plan.exactLoop && audio.loop ? audio.loop : undefined });
      const result = { partId: stem.partId, part: stem.part, name: stem.name, bytes, tracks: stem.tracks, mask: stem.mask };
      if (opts.keepAudio) result.audio = audio;
      this.results[stem.index] = result;
    }
    release() { if (this.run) this.run.release(); if (this.finishing) this.finishing.release(); this.run = this.finishing = null; this.queue = []; }
  }

  function stemsJob(E, pack, built, project, opts) { return new StemsJob(E, pack, built, project, opts); }
  function stems(E, pack, built, project, opts) { const job = stemsJob(E, pack, built, project, opts); job.advance(0); return job.result; }

  const api = { CHIP_RATE, FRAME_RATE, PREVIEW_CODE, LEAD_IN, render, renderJob, resample, wav, stems, stemsJob, peak, seconds, db, lengthFor, safeName };
  g.SF3Audio = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
