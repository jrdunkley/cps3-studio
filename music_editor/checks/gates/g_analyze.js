/* GATE G11 (docs/plan/06_GATES.md, wp/A6_analyze.md): the Studio's analysis, judged against the game's own music.
 *
 *   node checks/gates/g_analyze.js
 *
 * Passes when (every criterion of G11, then the brief's table of issue codes):
 *   1. mix numbers equal style/metrics.js (the reference) for five of Capcom's themes, +-0.01, from the engine
 *      (Analyze.measure) and from audio rendered elsewhere (Analyze.metrics); on synthetic signals (tones in
 *      each band, widths, silence, short audio, key-on arrays and counts) they equal the reference's `measure`;
 *   2. targets(): computed over the 34 stage themes (codes 10..43) it is exactly the reference's 10..90 % range
 *      and median per metric; the published fallback is shipped; unrounded ranges cover their inclusive order
 *      statistics and published endpoints and coverage match rounding (approved correction, 2026-10-02);
 *   3. spectrum(): a tone lands in the right bin, two tones give two peaks, band powers add up to the signal's
 *      power, silence is a floor; sections(): loudness per four bars from known steps; barTimes();
 *   4. harmony(): the key of 24 fixtures (12 roots x major/minor, as progressions and as scale runs), a known
 *      progression (triads, sevenths, a sixth against a seventh decided by the bass, a bar with no notes), a
 *      planted clash and the cases that are not clashes;
 *   5. lint(): a clean song raises nothing; every issue code of the brief's table is raised by exactly its own
 *      seeded fault (and by nothing else); each message is in the plain words of 05_UX section 8; each fix returns a
 *      new project, leaves its argument alone, and clears the issue without adding another; Capcom's 49 pieces
 *      lint without trouble, with no lost notes or tracks, and the mix issues match an independent count;
 *   6. driverLoad() equals checks/driver_load.js; the game's figure is cached;
 *   7. brief(): under 120 lines, in plain text, says what the issues say, deterministic, for all 49 pieces;
 *   8. the module is headless and deterministic (no files, no clock, no random).
 * Exit 0 only when all pass; 2 while js/analyze.js does not exist.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const G = require('./lib.js');
const Analyze = G.need('js/analyze.js');
const Compile = G.need('js/compile.js');
const Decomp = G.need('js/decomp.js');
const Catalog = G.need('js/catalog.js');
const Style = require(path.join(G.root, 'style', 'metrics.js'));
const { check, done } = G.gate('G11 analyze');
const T0 = Date.now(), lap = (what) => { if (process.argv.includes('--time')) console.log(`  [${((Date.now() - T0) / 1000).toFixed(1)} s] ${what}`); };
const RUN = path.join(G.root, 'out', 'tests', 'G11');
fs.mkdirSync(RUN, { recursive: true });
const BAR = 192, CHIP_RATE = 42954500 / 3 / 384;
const near = (a, b, tol) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= tol;
const clone = (x) => JSON.parse(JSON.stringify(x));
const has = (fn) => typeof Analyze[fn] === 'function';

/* ---- the API the plan names --------------------------------------------------------------------------------- */
const API = ['metrics', 'measure', 'spectrum', 'sections', 'barTimes', 'targets', 'harmony', 'driverLoad', 'lint', 'analyze', 'brief'];
for (const fn of API) check(has(fn), `SF3Analyze.${fn} is a function`);
if (API.some((fn) => !has(fn))) done('API missing');

/* the brief's table, copied: code, level */
const TABLE = [['tracks.over', 'error'], ['notes.dropped', 'error'], ['tracks.effects', 'info'], ['range.outside', 'warn'], ['kit.keys', 'warn'], ['tuning.off', 'warn'],
  ['level.clip', 'warn'], ['level.lead', 'info'], ['mix.low', 'info'], ['mix.punch', 'info'], ['mix.busy', 'info'], ['loop.phrase', 'warn'], ['loop.seam', 'info'],
  ['markers.off', 'info'], ['load.high', 'warn'], ['size.large', 'info'], ['chorus.none', 'info'], ['part.silent', 'info'], ['part.empty', 'info'], ['harmony.clash', 'info'],
  ['bank.custom', 'info']];
check(Analyze.ISSUES && TABLE.every(([c, l]) => Analyze.ISSUES[c] === l), 'SF3Analyze.ISSUES lists every issue code of the brief with its level');

const { engine, data } = G.loadData();
const catalog = Catalog.build(engine, data);

/* ==================================================================================================================
 * 1. mix numbers
 * ================================================================================================================== */
const FIELDS = ['width', 'rms', 'crest', 'motion'];
function sameMetrics(label, mine, ref, tol) {
  for (const f of FIELDS) check(near(mine[f], ref[f], tol), `${label}: ${f} ${mine[f]} against the reference ${ref[f]}`);
  for (let i = 0; i < 4; i++) check(near(mine.bands && mine.bands[i], ref.bands[i], tol), `${label}: band ${i} ${mine.bands && mine.bands[i]} against the reference ${ref.bands[i]}`);
  check(near(mine.keysPerSecond, ref.keys, tol), `${label}: key-ons per second ${mine.keysPerSecond} against the reference ${ref.keys}`);
  check(near(mine.voices, ref.voices, tol), `${label}: voices ${mine.voices} against the reference ${ref.voices}`);
}
const refMetrics = (src, seconds) => { const r = Style.render(src, seconds); return { r, m: Style.measure(r, Math.min(seconds, r.n / CHIP_RATE - 1)) }; };

for (const code of [10, 17, 25, 33, 40]) {
  const { r, m } = refMetrics({ code }, 40);
  const mine = Analyze.measure(G.Engine, G.pack, code, { seconds: 40 }).metrics;
  sameMetrics(`theme ${code} (Analyze.measure)`, mine, m, 0.01);
  const audio = { L: r.L, R: r.R, n: r.n, rate: CHIP_RATE };
  const pure = Analyze.metrics(audio, CHIP_RATE, { keyOns: r.keyOns, voices: r.voices, seconds: 40 });
  sameMetrics(`theme ${code} (Analyze.metrics on the reference's audio)`, pure, m, 0.01);
  check(typeof pure.peak === 'number' && pure.peak > 0 && pure.peak < 2, `theme ${code}: peak is a fraction of full scale (${pure.peak})`);
  let top = 0; for (let i = Math.round(CHIP_RATE); i < r.n; i++) top = Math.max(top, Math.abs(r.L[i]), Math.abs(r.R[i]));
  check(near(pure.peak, top / 32768, 0.0005), `theme ${code}: peak ${pure.peak} against the loudest sample ${top / 32768}`);
}
{ /* the same numbers from audio SF3Audio rendered (another path to the same samples) and key-ons as a list */
  const Audio = G.need('js/audio.js');
  const frames = Math.round(41 * 59.6);
  const a = Audio.render(G.Engine, G.pack, 20, { frames });
  const r = Style.render({ code: 20 }, 40);
  const e = new G.Engine(G.pack); e.request(20); e.keyOns = [];
  let vs = 0; for (let f = 0; f < frames; f++) { e.step(); for (let i = 0; i < 16; i++) if (e.key & (1 << i)) vs++; }
  const m = Style.measure(r, Math.min(40, r.n / CHIP_RATE - 1));
  const mine = Analyze.metrics(a, a.rate, { keyOns: e.keyOns, frames, voices: vs / frames, seconds: 40 });
  sameMetrics('theme 20 (SF3Audio.render audio, key-ons as a list)', mine, m, 0.01);
}
{ /* synthetic signals against the reference's own measure() */
  let seed = 12345;
  const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296 - 0.5; };
  const make = (secs, fn) => { const n = Math.round(secs * CHIP_RATE), L = new Int32Array(n), R = new Int32Array(n); for (let i = 0; i < n; i++) { const [l, r] = fn(i / CHIP_RATE, i); L[i] = Math.round(l); R[i] = Math.round(r); } return { L, R, n, rate: CHIP_RATE }; };
  const sine = (f, a) => (t) => a * Math.sin(2 * Math.PI * f * t);
  const cases = {
    'tone 100 Hz': make(4, (t) => { const v = sine(100, 8000)(t); return [v, v]; }),
    'tone 1 kHz': make(4, (t) => { const v = sine(1000, 8000)(t); return [v, v]; }),
    'tone 5 kHz': make(4, (t) => { const v = sine(5000, 8000)(t); return [v, v]; }),
    'noise': make(4, () => { const v = rnd() * 20000; return [v, v]; }),
    'half-width': make(4, (t) => { const v = sine(440, 9000)(t); return [v, v * 0.5]; }),
    'swelling tone': make(5, (t) => { const v = sine(220, 3000 + 4000 * Math.sin(t * 3))(t); return [v, v]; }),
    'pulsing tone with noise': make(3, (t, i) => { const v = (Math.floor(t * 8) % 2 ? 1 : 0.1) * sine(330, 12000)(t) + rnd() * 500; return [v, v * 0.9]; }),
  };
  for (const [name, audio] of Object.entries(cases)) {
    const extra = { keyOns: 57, voices: 3.7, seconds: 40 };
    const sec = Math.min(40, audio.n / CHIP_RATE - 1);
    const ref = Style.measure({ L: audio.L, R: audio.R, n: audio.n, keyOns: 57, voices: 3.7 }, sec);
    sameMetrics(`synthetic ${name}`, Analyze.metrics(audio, CHIP_RATE, extra), ref, 0.0005);
  }
  const t100 = Analyze.metrics(cases['tone 100 Hz'], CHIP_RATE, { keyOns: 0, voices: 1 }), t1k = Analyze.metrics(cases['tone 1 kHz'], CHIP_RATE, { keyOns: 0, voices: 1 }), t5k = Analyze.metrics(cases['tone 5 kHz'], CHIP_RATE, { keyOns: 0, voices: 1 });
  check(t100.bands[0] > 0.7 && t1k.bands[2] > 0.7 && t5k.bands[3] > 0.9, `a tone lands in its band (low ${t100.bands[0]}, 600-2500 ${t1k.bands[2]}, high ${t5k.bands[3]})`);
  check(t100.width === 0 && near(Analyze.metrics(cases['half-width'], CHIP_RATE, { keyOns: 0, voices: 1 }).width, 0.111, 0.002), 'width: 0 for equal sides, 0.111 for one side at half the other');
  check(near(t100.crest, 3.0, 0.1) && near(t100.rms, 20 * Math.log10(8000 / 32768 / Math.SQRT2), 0.1), `a sine: crest ${t100.crest} dB, rms ${t100.rms} dBFS`);
  check(near(t100.peak, 8000 / 32768, 0.001), `peak of an 8000 sine is ${t100.peak}`);
  check(near(t100.motion, 0, 1.5), `a steady tone has no loudness motion (${t100.motion})`);
  /* key-ons: a count and a list of [frame, voice]; the first second does not count (as the reference) */
  const list = [[10, 0], [59, 1], [60, 2], [100, 3], [200, 4]];
  const kl = Analyze.metrics(cases['tone 1 kHz'], CHIP_RATE, { keyOns: list, voices: 1 }).keysPerSecond, kn = Analyze.metrics(cases['tone 1 kHz'], CHIP_RATE, { keyOns: 3, voices: 1 }).keysPerSecond;
  check(near(kl, kn, 0.0001) && near(kl, +(3 / (4 - 1)).toFixed(1), 0.0001), `key-ons: a list [frame, voice] counts from frame 60 (${kl}); a number is taken as counted (${kn})`);
  /* mono input (no right side) and silence and audio shorter than a second must not throw or give NaN */
  const mono = Analyze.metrics({ L: cases['tone 1 kHz'].L, n: cases['tone 1 kHz'].n, rate: CHIP_RATE }, CHIP_RATE, { keyOns: 0, voices: 1 });
  check(near(mono.rms, t1k.rms, 0.0001) && mono.width === 0, 'audio with one side only is read as mono');
  const quiet = Analyze.metrics({ L: new Int32Array(CHIP_RATE * 3 | 0), R: new Int32Array(CHIP_RATE * 3 | 0), n: CHIP_RATE * 3 | 0, rate: CHIP_RATE }, CHIP_RATE, { keyOns: 0, voices: 0 });
  const finite = (m) => FIELDS.every((f) => Number.isFinite(m[f])) && m.bands.every(Number.isFinite) && Number.isFinite(m.keysPerSecond) && Number.isFinite(m.peak);
  check(finite(quiet) && quiet.peak === 0, 'silence gives finite numbers and a peak of 0');
  const brief0 = Analyze.metrics({ L: new Int32Array(1000), R: new Int32Array(1000), n: 1000, rate: CHIP_RATE }, CHIP_RATE, { keyOns: 0, voices: 0 });
  check(finite(brief0), 'audio shorter than a second gives finite numbers');
  /* a different sample rate: the filters follow the rate given */
  const half = make(4, (t) => { const v = sine(100, 8000)(t); return [v, v]; });
  const slow = { L: new Float32Array(half.n / 2 | 0), R: new Float32Array(half.n / 2 | 0), n: half.n / 2 | 0, rate: CHIP_RATE / 2 };
  for (let i = 0; i < slow.n; i++) { slow.L[i] = 8000 * Math.sin(2 * Math.PI * 100 * i / (CHIP_RATE / 2)); slow.R[i] = slow.L[i]; }
  const ms = Analyze.metrics(slow, CHIP_RATE / 2, { keyOns: 0, voices: 1 });
  check(near(ms.bands[0], t100.bands[0], 0.02) && near(ms.rms, t100.rms, 0.1), 'metrics follow the sample rate they are given');
}

/* ==================================================================================================================
 * 2. targets
 * ================================================================================================================== */
lap('mix numbers');
const themes = data.songs.filter((s) => s.code >= 10 && s.code <= 43);
const ref34 = themes.map((s) => refMetrics({ code: s.code }, 40).m);
const published = Analyze.TARGETS;
check(published && published.source === 'published', 'SF3Analyze.TARGETS is the published fallback');
const rg = (t) => t && [t.lo, t.hi];
check(published && JSON.stringify(rg(published.bands[0])) === '[0.49,0.68]' && JSON.stringify(rg(published.crest)) === '[15,16.9]' && JSON.stringify(rg(published.keysPerSecond)) === '[23,42]'
  && JSON.stringify(rg(published.bands[1])) === '[0.18,0.3]' && JSON.stringify(rg(published.bands[2])) === '[0.06,0.17]' && JSON.stringify(rg(published.bands[3])) === '[0.03,0.13]'
  && JSON.stringify(rg(published.motion)) === '[6,12]' && near(published.bands[0].median, 0.57, 1e-9), 'the published fallback is style/README.txt: low 0.49-0.68 (median 0.57), 150-600 0.18-0.30, 600-2500 0.06-0.17, high 0.03-0.13, crest 15.0-16.9, motion 6-12, 23-42 key-ons a second');
{
  const T = Analyze.targets(engine, data, { pack: G.pack });
  check(T.source === 'computed' && T.themes === 34 && T.seconds === 40, `targets() is computed over ${T.themes} themes, ${T.seconds} s each`);
  const q = (f, p) => { const xs = ref34.map(f).sort((a, b) => a - b); return xs[Math.floor(p * (xs.length - 1))]; };
  const rows = { width: (m) => m.width, rms: (m) => m.rms, crest: (m) => m.crest, motion: (m) => m.motion, keysPerSecond: (m) => m.keys, voices: (m) => m.voices };
  for (let i = 0; i < 4; i++) rows[`bands[${i}]`] = (m) => m.bands[i];
  for (const [name, f] of Object.entries(rows)) {
    const t = name.startsWith('bands') ? T.bands[+name[6]] : T[name];
    check(t && near(t.lo, q(f, 0.1), 1e-9) && near(t.hi, q(f, 0.9), 1e-9) && near(t.median, q(f, 0.5), 1e-9), `targets ${name}: ${t && t.lo}..${t && t.hi} (median ${t && t.median}) equals the reference's 10..90 % of the 34 themes ${q(f, 0.1)}..${q(f, 0.9)} (${q(f, 0.5)})`);
  }
  const some = { pack: G.pack, codes: [12, 20, 31] };
  check(JSON.stringify(Analyze.targets(engine, data, some)) === JSON.stringify(Analyze.targets(engine, data, some)) && Analyze.targets(engine, data, some).themes === 3, 'targets() twice gives the same numbers (and can be limited to some codes)');
  global.COMPUTED = T;
  /* the published fallback is the computed range printed to the digits the README shows, so it cannot drift from the themes */
  const printed = (r, d) => ({ lo: +r.lo.toFixed(d), hi: +r.hi.toFixed(d) }), same = (a, b) => a.lo === b.lo && a.hi === b.hi;
  check([0, 1, 2, 3].every((i) => same(printed(T.bands[i], 2), published.bands[i])) && same(printed(T.crest, 1), published.crest)
    && same({ lo: Math.round(T.motion.lo), hi: Math.round(T.motion.hi) }, published.motion) && same({ lo: Math.round(T.keysPerSecond.lo), hi: Math.round(T.keysPerSecond.hi) }, published.keysPerSecond)
    && near(+T.bands[0].median.toFixed(2), published.bands[0].median, 1e-9),
  `the published fallback is the computed ranges printed to the digits the README shows (low ${T.bands[0].lo}..${T.bands[0].hi}, crest ${T.crest.lo}..${T.crest.hi}, key-ons ${T.keysPerSecond.lo}..${T.keysPerSecond.hi})`);
}
{
  const insideCounts = [];
  const T = global.COMPUTED;
  const inside = { 'low end': [(m) => m.bands[0], published.bands[0], T.bands[0], 2], '150-600': [(m) => m.bands[1], published.bands[1], T.bands[1], 2], '600-2500': [(m) => m.bands[2], published.bands[2], T.bands[2], 2],
                   'high': [(m) => m.bands[3], published.bands[3], T.bands[3], 2], crest: [(m) => m.crest, published.crest, T.crest, 1], motion: [(m) => m.motion, published.motion, T.motion, 0], 'key-ons': [(m) => m.keys, published.keysPerSecond, T.keysPerSecond, 0] };
  for (const [name, [f, t, computed, digits]] of Object.entries(inside)) {
    const n = ref34.filter((m) => f(m) >= t.lo && f(m) <= t.hi).length;
    insideCounts.push(n);
    const values = ref34.map(f).sort((a, b) => a - b), loIndex = Math.floor(0.1 * (values.length - 1)), hiIndex = Math.floor(0.9 * (values.length - 1));
    const lo = values[loIndex], hi = values[hiIndex], roundedLo = +lo.toFixed(digits), roundedHi = +hi.toFixed(digits);
    const exactCount = values.filter(v => v >= computed.lo && v <= computed.hi).length;
    check(computed.lo === lo && computed.hi === hi && exactCount >= hiIndex - loIndex + 1,
      `${name}: exact percentile endpoints are reference observations ${loIndex} and ${hiIndex}, covering ${exactCount} of ${values.length} (at least ${hiIndex - loIndex + 1}, including endpoints)`);
    check(t.lo === roundedLo && t.hi === roundedHi && n === values.filter(v => v >= roundedLo && v <= roundedHi).length,
      `${name}: published ${t.lo}..${t.hi} and its ${n}/${values.length} coverage equal independent percentile rounding to ${digits} decimal places`);
  }
  console.log(`themes inside each published range: ${insideCounts.join(' ')} of ${ref34.length}`);
}

/* ==================================================================================================================
 * 3. spectrum, sections, bar times
 * ================================================================================================================== */
{
  const n = Math.round(CHIP_RATE * 3), L = new Int32Array(n), R = new Int32Array(n);
  for (let i = 0; i < n; i++) L[i] = R[i] = Math.round(8192 * Math.sin(2 * Math.PI * 1000 * i / CHIP_RATE));
  const sp = Analyze.spectrum({ L, R, n, rate: CHIP_RATE }, CHIP_RATE, 96);
  check(sp && sp.freq && sp.db && sp.freq.length === 96 && sp.db.length === 96, 'spectrum(audio, rate, 96) gives 96 frequencies and 96 levels');
  const top = sp.db.indexOf(Math.max(...sp.db));
  check(sp.freq[top] > 800 && sp.freq[top] < 1250, `a 1 kHz tone peaks at ${sp.freq[top] && sp.freq[top].toFixed(0)} Hz`);
  check(sp.freq.every((f, i) => i === 0 || f > sp.freq[i - 1]) && sp.freq[0] >= 15 && sp.freq[0] <= 60 && sp.freq[95] > 12000 && sp.freq[95] <= CHIP_RATE / 2, `frequencies rise from ${sp.freq[0] && sp.freq[0].toFixed(0)} Hz to ${sp.freq[95] && sp.freq[95].toFixed(0)} Hz`);
  const power = sp.db.reduce((s, d) => s + Math.pow(10, d / 10), 0);
  check(near(10 * Math.log10(power), 10 * Math.log10(0.25 * 0.25 / 2), 0.3), `band powers add up to the signal's power (${(10 * Math.log10(power)).toFixed(2)} dB; a sine of a quarter of full scale has ${(10 * Math.log10(0.25 * 0.25 / 2)).toFixed(2)} dB)`);
  const far = sp.db.filter((d, i) => Math.abs(Math.log2(sp.freq[i] / 1000)) > 1);
  check(Math.max(...far) < sp.db[top] - 50, `the tone stands at least 50 dB above bands an octave away (${(sp.db[top] - Math.max(...far)).toFixed(0)} dB)`);
  for (let i = 0; i < n; i++) L[i] = R[i] = Math.round(8192 * Math.sin(2 * Math.PI * 200 * i / CHIP_RATE) + 8192 * Math.sin(2 * Math.PI * 4000 * i / CHIP_RATE));
  const two = Analyze.spectrum({ L, R, n, rate: CHIP_RATE }, CHIP_RATE, 96);
  const peaks = two.db.map((d, i) => (i > 0 && i < 95 && d > two.db[i - 1] && d >= two.db[i + 1] && d > -40 ? two.freq[i] : 0)).filter(Boolean);
  check(peaks.length >= 2 && peaks.some((f) => f > 150 && f < 270) && peaks.some((f) => f > 3300 && f < 4800), `two tones give two peaks (${peaks.map((f) => f.toFixed(0)).join(', ')} Hz)`);
  const hush = Analyze.spectrum({ L: new Int32Array(n), R: new Int32Array(n), n, rate: CHIP_RATE }, CHIP_RATE, 32);
  check(hush.db.length === 32 && hush.db.every((d) => Number.isFinite(d) && d <= -90), 'silence is a finite floor (at most -90 dB)');
  const short = Analyze.spectrum({ L: new Int32Array(100), R: new Int32Array(100), n: 100, rate: CHIP_RATE }, CHIP_RATE, 16);
  check(short.db.length === 16 && short.db.every(Number.isFinite), 'audio shorter than one analysis window still gives levels');
  const at = Analyze.spectrum({ L, R, n, rate: CHIP_RATE }, CHIP_RATE, 96, { from: 1000, to: 40000 });
  check(at.db.length === 96, 'a stretch of the audio can be asked for (from, to in samples)');
}
{
  /* 16 bars of 2 s (120 BPM, bar = 4 beats): rms steps every four bars: 0.05, 0.1, 0.2, 0.4 of full scale */
  const secs = 32, n = Math.round(secs * CHIP_RATE), L = new Int32Array(n), R = new Int32Array(n);
  const amp = [0.05, 0.1, 0.2, 0.4];
  for (let i = 0; i < n; i++) { const g = amp[Math.min(3, Math.floor(i / CHIP_RATE / 8))]; L[i] = R[i] = Math.round(g * 32768 * Math.sin(2 * Math.PI * 440 * i / CHIP_RATE)); }
  const times = []; for (let b = 0; b <= 16; b++) times.push(b * 2);
  const s = Analyze.sections({ L, R, n, rate: CHIP_RATE }, CHIP_RATE, times);
  check(Array.isArray(s) && s.length === 4, `sections: 16 bars make 4 sections of four bars (${s && s.length})`);
  if (Array.isArray(s) && s.length === 4) {
    check(s.every((x, i) => x.bar === 1 + 4 * i && near(x.from, 8 * i, 1e-6) && near(x.to, 8 * i + 8, 1e-6)), 'each section says its first bar and its seconds');
    check(s.every((x, i) => near(x.rms, 20 * Math.log10(amp[i] / Math.SQRT2), 0.1)), `loudness per section is right (${s.map((x) => x.rms).join(', ')} dBFS)`);
    check(near(s[3].rel, 0, 0.001) && near(s[0].rel, 20 * Math.log10(0.05 / 0.4), 0.15), `rel is the distance to the loudest section (${s.map((x) => x.rel).join(', ')})`);
  }
  const part = Analyze.sections({ L, R, n, rate: CHIP_RATE }, CHIP_RATE, times.slice(0, 7));
  check(part.length === 2 && near(part[1].to, 12, 1e-6) && part[1].bar === 5, 'a last group of two bars runs to the last bar line given');
  const six = Analyze.sections({ L, R, n, rate: CHIP_RATE }, CHIP_RATE, times, { per: 2 });
  check(six.length === 8 && six[1].bar === 3, 'the group size can be changed');
  const proj = { bpm: 120, bars: 16, leadIn: 0, tempoChanges: [] };
  const bt = Analyze.barTimes(proj);
  check(bt.length === 17 && near(bt[0], 0, 1e-9) && near(bt[1], 2, 1e-9) && near(bt[16], 32, 1e-9), `barTimes at 120 BPM: a bar every 2 s (${bt.slice(0, 3).join(', ')} ... ${bt[16]})`);
  const bt2 = Analyze.barTimes({ bpm: 120, bars: 4, leadIn: 0, tempoChanges: [{ t: 2 * BAR, bpm: 60 }] });
  check(near(bt2[2], 4, 1e-9) && near(bt2[3], 8, 1e-9) && near(bt2[4], 12, 1e-9), `barTimes follows a tempo change (${bt2.join(', ')})`);
  const bt3 = Analyze.barTimes({ bpm: 120, bars: 2, leadIn: 2, tempoChanges: [] });
  check(near(bt3[0], 2 * 60 / (120 * 48), 1e-9), 'barTimes counts the lead-in ticks before bar 1');
}

/* ==================================================================================================================
 * 4. harmony
 * ================================================================================================================== */
lap('targets');
const note = (t, n, len, v) => ({ t, n, v: v || 90, len });
const part = (id, name, role, bank, program, notes, extra) => Object.assign({ id, name, role, bank, program, volume: 70, expression: 64, pan: 64, voices: 1, notes }, extra || {});
const song = (parts, extra) => Object.assign({ format: 'sf3project', version: 2, name: 'Fixture', bpm: 120, bars: 8, parts, loop: { on: true, startBar: 1, endBar: 8 }, markerBars: 2 }, extra || {});
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
{
  /* 24 keys, as a progression I-IV-V-I (i-iv-V-i) twice and as a scale run ending on a held tonic triad */
  const triad = (root, minor) => [root, root + (minor ? 3 : 4), root + 7];
  let wrong = 0, weak = 0, runWrong = 0;
  const bad = [];
  for (const minor of [false, true]) for (let r = 0; r < 12; r++) {
    const deg = [0, 5, 7, 0, 0, 5, 7, 0];
    const bass = [], pad = [], lead = [];
    deg.forEach((d, b) => {
      const root = (r + d) % 12, mnr = minor && d !== 7;
      bass.push(note(b * BAR, 36 + root, 90), note(b * BAR + 96, 36 + root, 90));
      for (const k of triad(60 + root, mnr)) pad.push(note(b * BAR, k, 188));
      triad(72 + root, mnr).forEach((k, i) => lead.push(note(b * BAR + i * 48, k, 44)));
    });
    const h = Analyze.harmony(song([part('b', 'Bass', 'bass', 0, 20, bass), part('p', 'Pad', 'pad', 0, 46, pad, { voices: 3 }), part('l', 'Lead', 'lead', 0, 43, lead)]), { catalog });
    if (!(h.key && h.key.root === r && h.key.scale === (minor ? 'minor' : 'major'))) { wrong++; bad.push(`${NAMES[r]} ${minor ? 'minor' : 'major'} read as ${h.key && NAMES[h.key.root]} ${h.key && h.key.scale}`); }
    if (!(h.key && h.key.confidence >= 0.6 && h.key.confidence <= 1)) weak++;
    /* a scale run: up and down the scale, the tonic and the fifth held longer, then the tonic triad held */
    const scale = minor ? [0, 2, 3, 5, 7, 8, 10] : [0, 2, 4, 5, 7, 9, 11];
    const run = []; let t = 0;
    const seq = [...scale, 12, ...scale.slice().reverse().map((x) => x), 0];
    seq.forEach((x, i) => { const len = x % 12 === 0 ? 96 : x % 12 === scale[4] ? 72 : 36; run.push(note(t, 60 + r + x, len)); t += len; });
    for (const k of triad(48 + r, minor)) run.push(note(t, k, 192));
    const hr = Analyze.harmony(song([part('l', 'Lead', 'lead', 0, 43, run)], { bars: Math.ceil((t + 192) / BAR) }), { catalog });
    if (!(hr.key && hr.key.root === r && hr.key.scale === (minor ? 'minor' : 'major'))) { runWrong++; bad.push(`scale run ${NAMES[r]} ${minor ? 'minor' : 'major'} read as ${hr.key && NAMES[hr.key.root]} ${hr.key && hr.key.scale}`); }
  }
  check(wrong === 0, `the key of 24 progressions (12 roots, major and minor) is found${bad.length ? ': ' + bad.join('; ') : ''}`);
  check(runWrong === 0, `the key of 24 scale runs is found`);
  check(weak === 0, 'a clear key has a confidence from 0.6 to 1');
  /* every pitch class at once: no key to speak of */
  const all = []; for (let k = 0; k < 12; k++) all.push(note(k * 48, 60 + k, 48));
  const hc = Analyze.harmony(song([part('l', 'Lead', 'lead', 0, 43, all)], { bars: 3 }), { catalog });
  check(hc.key && hc.key.confidence < 0.3, `a chromatic cluster has a low confidence (${hc.key && hc.key.confidence})`);
  const none = Analyze.harmony(song([part('l', 'Lead', 'lead', 0, 43, [])], { bars: 2 }), { catalog });
  check(none.key && none.key.confidence === 0 && none.bars.length === 2 && none.bars.every((b) => b.chord === null) && none.clashes.length === 0, 'a song with no notes: confidence 0, no chords, no clashes');
}
{
  /* a known progression, one chord a bar: Am F C G, then jazz: Cmaj7 Dm7 G7 C; the bass decides between a sixth and a seventh */
  const chords = (list, bassOf) => {
    const pad = [], bass = [];
    list.forEach((c, b) => { for (const k of c) pad.push(note(b * BAR, k, 188)); bass.push(note(b * BAR, bassOf[b], 188)); });
    return [part('b', 'Bass', 'bass', 0, 20, bass), part('p', 'Pad', 'pad', 0, 46, pad, { voices: 4 })];
  };
  const pop = [[57, 60, 64], [53, 57, 60], [60, 64, 67], [55, 59, 62]];
  const h = Analyze.harmony(song(chords(pop, [45, 41, 48, 43]), { bars: 4 }), { catalog });
  check(h.bars.map((b) => b.chord).join(' ') === 'Am F C G' && h.bars.map((b) => b.root).join() === '9,5,0,7' && h.bars.map((b) => b.bar).join() === '1,2,3,4', `Am F C G is read as ${h.bars.map((b) => b.chord).join(' ')}`);
  check(h.bars[0].notes.join() === '0,4,9', `a bar lists the pitch classes sounding (${h.bars[0].notes.join()})`);
  check(h.key.root === 0 && h.key.scale === 'major' || h.key.root === 9 && h.key.scale === 'minor', 'Am F C G is in C major or A minor');
  const jazz = [[60, 64, 67, 71], [62, 65, 69, 72], [55, 59, 62, 65], [60, 64, 67]];
  const hj = Analyze.harmony(song(chords(jazz, [36, 38, 43, 36]), { bars: 4 }), { catalog });
  check(hj.bars.map((b) => b.chord).join(' ') === 'Cmaj7 Dm7 G7 C', `Cmaj7 Dm7 G7 C is read as ${hj.bars.map((b) => b.chord).join(' ')}`);
  const sixth = [[53, 57, 60, 62]];
  const f6 = Analyze.harmony(song(chords(sixth, [41]), { bars: 1 }), { catalog }), dm7 = Analyze.harmony(song(chords(sixth, [38]), { bars: 1 }), { catalog });
  check(f6.bars[0].chord === 'F6' && dm7.bars[0].chord === 'Dm7', `the same four notes: bass F gives ${f6.bars[0].chord}, bass D gives ${dm7.bars[0].chord}`);
  const flat = Analyze.harmony(song(chords([[58, 62, 65], [55, 58, 62], [63, 67, 70], [58, 62, 65]], [34, 31, 39, 34]), { bars: 4 }), { catalog });
  check(flat.bars.map((b) => b.chord).join(' ') === 'Bb Gm Eb Bb', `in a flat key the chords are spelled with flats (${flat.bars.map((b) => b.chord).join(' ')})`);
  const sus = Analyze.harmony(song(chords([[62, 67, 69], [57, 61, 64], [59, 62, 65], [55, 60, 62]], [38, 33, 35, 31]), { bars: 4 }), { catalog });
  check(sus.bars.map((b) => b.chord).join(' ') === 'Dsus4 A Bdim Gsus4', `suspended and diminished chords have names (${sus.bars.map((b) => b.chord).join(' ')})`);
  /* a bar with only a bass note, a bare fifth, an empty bar, and a passing note that does not change the chord */
  const mixed = [part('b', 'Bass', 'bass', 0, 20, [note(0, 45, 188), note(BAR, 45, 188), note(2 * BAR + 0, 57, 188), note(4 * BAR, 45, 188), note(4 * BAR + 96, 47, 12)]),
    part('p', 'Pad', 'pad', 0, 46, [note(BAR, 52, 188), note(4 * BAR, 60, 188), note(4 * BAR, 64, 188), note(4 * BAR, 52, 188)], { voices: 3 })];
  const hm = Analyze.harmony(song(mixed, { bars: 6 }), { catalog });
  check(hm.bars.length === 6 && hm.bars[0].chord === 'A only' && hm.bars[1].chord === 'A5' && hm.bars[3].chord === null && hm.bars[3].root === null && hm.bars[3].notes.length === 0, `single notes, a bare fifth, an empty bar (${hm.bars.map((b) => b.chord).join(' | ')})`);
  check(hm.bars[4].chord === 'Am', `a short passing note does not change the chord (${hm.bars[4].chord})`);
  /* drums and percussion never count */
  const withDrums = chords(pop, [45, 41, 48, 43]).concat([part('d', 'Beat', 'drums', 0, 6, [note(0, 37, 12), note(48, 38, 12), note(96, 37, 12)])]);
  const hd = Analyze.harmony(song(withDrums, { bars: 4 }), { catalog });
  check(hd.bars.map((b) => b.chord).join(' ') === 'Am F C G' && hd.clashes.length === 0, 'kit parts take no part in chords, keys or clashes');
  const kitNoRole = Analyze.harmony(song(chords(pop, [45, 41, 48, 43]).concat([part('d', 'Beat', null, 0, 6, [note(0, 37, 96), note(0, 38, 96)])]), { bars: 4 }), { catalog });
  check(kitNoRole.bars.map((b) => b.chord).join(' ') === 'Am F C G' && kitNoRole.clashes.length === 0, 'the catalog says which parts are kits, whatever role they carry');
  /* muted and silent parts are left out */
  const withMute = chords(pop, [45, 41, 48, 43]).concat([part('m', 'Muted', 'lead', 0, 43, [note(0, 65, 96)], { mute: true }), part('s', 'Silent', 'lead', 0, 43, [note(0, 65, 96)], { volume: 0 })]);
  check(Analyze.harmony(song(withMute, { bars: 4 }), { catalog }).clashes.length === 0, 'muted and silent parts make no clash');
  /* determinism */
  check(JSON.stringify(Analyze.harmony(song(chords(pop, [45, 41, 48, 43]), { bars: 4 }), { catalog })) === JSON.stringify(h), 'harmony gives the same answer twice');
  const before = JSON.stringify(song(chords(pop, [45, 41, 48, 43]), { bars: 4 })), pj = song(chords(pop, [45, 41, 48, 43]), { bars: 4 });
  Analyze.harmony(pj, { catalog });
  check(JSON.stringify(pj) === before, 'harmony leaves the project alone');
}
{
  /* the planted clash, and everything near it that is not one */
  const pad = (n, t, len, id, vol) => part(id || 'p', id === 'q' ? 'Other' : 'Pad', 'pad', 0, 46, [note(t || 0, n, len || 188)], vol);
  const run = (aNotes, bNotes, opts) => Analyze.harmony(song([part('p', 'Pad', 'pad', 0, 46, aNotes), part('l', 'Lead', 'lead', 0, 43, bNotes, opts)], { bars: 4 }), { catalog });
  const c = run([note(0, 64, 188)], [note(144, 65, 24)]);
  check(c.clashes.length === 1 && c.clashes[0].bar === 1 && c.clashes[0].tick === 144 && JSON.stringify(c.clashes[0].parts) === '["p","l"]' && JSON.stringify(c.clashes[0].notes) === '[64,65]', `a planted clash: ${JSON.stringify(c.clashes)}`);
  check(run([note(0, 64, 188)], [note(144, 65, 12)]).clashes.length === 1, 'twelve ticks is a clash');
  check(run([note(0, 64, 188)], [note(144, 65, 11)]).clashes.length === 0, 'eleven ticks is not');
  check(run([note(0, 64, 188)], [note(144, 66, 24)]).clashes.length === 0, 'a whole tone is not a clash');
  check(run([note(0, 64, 100)], [note(100, 65, 40)]).clashes.length === 0, 'notes that only follow each other are not a clash');
  check(run([note(0, 64, 100)], [note(88, 65, 40)]).clashes.length === 1 && run([note(0, 64, 100)], [note(88, 65, 40)]).clashes[0].tick === 88, 'the overlap counts from where it starts');
  check(run([note(0, 64, 188), note(0, 65, 188)], [note(0, 69, 188)]).clashes.length === 0, 'a semitone inside one part (its own chord) is not a clash');
  const second = run([note(0, 64, 188)], [note(BAR + 144, 65, 24)]);
  check(second.clashes.length === 0, 'notes in different bars do not meet');
  const c2 = run([note(BAR * 2, 64, 188), note(BAR * 2, 67, 188)], [note(BAR * 2 + 10, 66, 30), note(BAR * 2 + 100, 63, 40)]);
  check(c2.clashes.length === 2 && c2.clashes.every((x) => x.bar === 3) && c2.clashes[0].tick < c2.clashes[1].tick, `several clashes are listed in time order (${c2.clashes.map((x) => x.tick).join(', ')})`);
  check(c2.clashes[0].notes.join() === '67,66' || c2.clashes[0].notes.join() === '66,67', 'a clash lists the two notes');
  check(run([note(0, 64, 188)], [note(144, 77, 24)]).clashes.length === 0, 'notes an octave and a semitone apart are not a clash (a semitone means a semitone)');
  check(run([note(0, 64, 188)], [note(144, 65, 24)], { transpose: -1 }).clashes.length === 0, 'transpose is counted: the lead sounds the same note');
  check(Analyze.harmony(song([part('p', 'Pad', 'pad', 0, 46, [note(0, 64, 188)]), part('d', 'Beat', 'drums', 0, 6, [note(0, 65, 188)]),
    part('q', 'Other', null, 0, 6, [note(0, 63, 188)])], { bars: 2 }), { catalog }).clashes.length === 0, 'a kit never clashes with a pitched part');
}

/* ==================================================================================================================
 * 5. lint: a clean song, and one seeded fault per issue code
 * ================================================================================================================== */
lap('spectrum, sections, harmony');
const CHORDS = [{ bass: 45, pad: [57, 60, 64], lead: [69, 72, 76] }, { bass: 41, pad: [53, 57, 60], lead: [65, 69, 72] },
                { bass: 48, pad: [60, 64, 67], lead: [72, 76, 79] }, { bass: 43, pad: [55, 59, 62], lead: [67, 71, 74] }];
function baseProject() {
  const beat = [], bass = [], pad = [], lead = [];
  for (let b = 0; b < 16; b++) {
    const c = CHORDS[b % 4], o = b * BAR;
    [[0, 36], [24, 42], [48, 38], [72, 42], [96, 36], [120, 42], [144, 38], [168, 42]].forEach(([t, k]) => beat.push(note(o + t, k, 12, 100)));
    bass.push(note(o, c.bass, 90, 100), note(o + 96, c.bass, 90, 100));
    for (const k of c.pad) pad.push(note(o, k, 188, 80));
    [0, 1, 2].forEach((i) => lead.push(note(o + i * 48, c.lead[(i + b) % 3], 44, 100)));
  }
  return { format: 'sf3project', version: 2, name: 'Night Drive', author: '', comment: '', bpm: 130, tempoChanges: [], bars: 16, length: null,
    loop: { on: true, startBar: 1, endBar: 16, start: 0, end: 16 * BAR }, markerBars: 2, markers: null, tempoPart: null, leadIn: 2, loopRestore: true, autoTune: true,
    key: { root: 9, scale: 'minor' }, sections: [{ bar: 1, name: 'Intro' }, { bar: 9, name: 'Verse' }], chorusBar: 9, bank: null, names: {}, ui: {},
    parts: [
      Object.assign(part('beat', 'Beat', 'drums', 0, 6, beat), { volume: 75, expression: 70 }),
      Object.assign(part('bass', 'Bass', 'bass', 0, 20, bass), { volume: 75, expression: 64 }),
      Object.assign(part('pad', 'Pad', 'pad', 0, 46, pad), { volume: 64, expression: 64, voices: 3, pan: 100 }),
      Object.assign(part('lead', 'Lead', 'lead', 0, 43, lead), { volume: 56, expression: 52, pan: 30, devices: [{ type: 'echo', delay: 24, level: 0.5, pan: 'opposite' }] }),
    ] };
}
/* what the page would hold when a song is built and measured: published targets, a measurement inside them, a light load */
function baseContext(built) {
  return { catalog, targets: Analyze.TARGETS, compressedBytes: built.report.bytes,
    metrics: { width: 0, bands: [0.57, 0.24, 0.11, 0.08], rms: -19, crest: 16, motion: 9, keysPerSecond: 32, voices: 7, peak: 0.7 },
    load: { peak: 9000, mean: 6000, game: { peak: 15366, mean: 8000, code: 20 }, ratio: 0.59 } };
}
const partOf = (p, id) => p.parts.find((x) => x.id === id);
const lintOf = (project, mutate) => {
  const p = clone(project), built0 = Compile.build(p, { catalog, compress: true });
  const ctx = baseContext(built0), before = ctx.compressedBytes;
  if (mutate) mutate(p, ctx);
  const built = Compile.build(p, { catalog, compress: true });
  if (ctx.compressedBytes === before) ctx.compressedBytes = built.report.bytes;
  return { project: p, built, ctx, issues: Analyze.lint(p, built, ctx) };
};
const codes = (issues) => issues.map((i) => i.code).join(',');
const base = baseProject();
const clean = lintOf(base);
check(clean.built.report.warnings.length === 0 && clean.built.report.dropped === 0, `the clean fixture builds without warnings (${JSON.stringify(clean.built.report.warnings)})`);
check(clean.issues.length === 0, `a clean song raises no issue (${clean.issues.map((i) => i.code + ': ' + i.message).join(' | ')})`);
{
  const h = Analyze.harmony(base, { catalog });
  check(((h.key.root === 9 && h.key.scale === 'minor') || (h.key.root === 0 && h.key.scale === 'major')) && h.clashes.length === 0 && h.bars.slice(0, 4).map((b) => b.chord).join(' ') === 'Am F C G', `the clean fixture is Am F C G (A minor, or C major: the same seven notes) with no clash (${h.bars.slice(0, 4).map((b) => b.chord).join(' ')})`);
}

const SEEDS = {
  'tracks.over': (p) => { partOf(p, 'pad').devices = [{ type: 'echo', delay: 24, level: 0.5, repeats: 4 }]; },
  'notes.dropped': (p) => { partOf(p, 'lead').notes.push(note(0, 72, 44, 100), note(0, 76, 44, 100)); },
  'tracks.effects': (p) => { partOf(p, 'pad').devices = [{ type: 'echo', delay: 24, level: 0.5, repeats: 2 }]; },
  'range.outside': (p) => { partOf(p, 'bass').transpose = 24; },
  'kit.keys': (p) => { partOf(p, 'beat').notes.push(note(10 * BAR + 60, 100, 12, 100)); },
  'tuning.off': (p) => { p.autoTune = false; partOf(p, 'lead').program = 21; },
  'level.clip': (p, c) => { c.metrics.peak = 1.12; },
  'level.lead': (p) => { partOf(p, 'lead').volume = 100; partOf(p, 'lead').expression = 100; },
  'mix.low': (p, c) => { c.metrics.bands = [0.3, 0.3, 0.2, 0.2]; },
  'mix.punch': (p, c) => { c.metrics.crest = 11; },
  'mix.busy': (p, c) => { c.metrics.keysPerSecond = 60; },
  'loop.phrase': (p) => { p.loop.endBar = 15; p.loop.end = 15 * BAR; },
  'loop.seam': (p) => { const n = partOf(p, 'bass').notes; n[n.length - 1].len = 120; },
  'markers.off': (p) => { p.markerBars = 0; },
  'load.high': (p, c) => { c.load = { peak: 20000, mean: 9000, game: { peak: 15366, mean: 8000, code: 20 }, ratio: 1.3 }; },
  'size.large': (p, c) => { c.compressedBytes = 9000; },
  'chorus.none': (p) => { p.chorusBar = null; },
  'part.silent': (p) => { partOf(p, 'lead').expression = 0; },
  'part.empty': (p) => { p.parts.push(part('none', 'Spare', 'chords', 0, 41, [])); },
  'harmony.clash': (p) => { partOf(p, 'lead').notes.push(note(144, 65, 24, 100)); },
  'bank.custom': (p) => { p.bank = { slot: 8, views: [{ id: 'v1', name: 'Slice', source: 590, start: 4321000, loop: null, end: 4327000, root: 60 }],
    programs: { 0: { name: 'Hit', regions: [{ keyHigh: 127, sample: { view: 'v1' }, pan: null, level: 0, fine: 0, attack: 63, decay: 63, sustain: 127, sustainRate: 1, release: 63, ringOut: false }] } } }; },
};
const fixable = new Set();
const allIssues = [];
for (const [code, level] of TABLE) {
  const seed = SEEDS[code];
  if (!check(!!seed, `a seeded fault exists for ${code}`)) continue;
  let r;
  try { r = lintOf(base, seed); } catch (e) { check(false, `${code}: the seeded song failed to build: ${e.message}`); continue; }
  check(codes(r.issues) === code, `${code}: its seeded fault raises exactly it (got "${codes(r.issues)}"${r.issues.length ? ': ' + r.issues.map((i) => i.message).join(' | ') : ''})`);
  const issue = r.issues.find((i) => i.code === code);
  if (!issue) continue;
  allIssues.push(issue);
  if (process.argv.includes('--show')) console.log(`[${issue.level}] ${code}: ${issue.message}${issue.fix ? '  {fix: ' + issue.fix.label + '}' : ''}`);
  check(issue.level === level, `${code}: level ${level}`);
  if (['tracks.over', 'notes.dropped', 'tracks.effects', 'range.outside', 'kit.keys', 'level.lead', 'part.silent', 'part.empty'].includes(code))
    check(typeof issue.partId === 'string' && !!partOf(r.project, issue.partId), `${code}: names the part it concerns (${issue.partId})`);
  if (code === 'harmony.clash') check(issue.bar === 1, `${code}: names the bar (${issue.bar})`);
  if (issue.fix) fixable.add(code);
  /* the words */
  const words = issue.message;
  check(typeof words === 'string' && words.length > 12 && words.length < 400, `${code}: a message of a sentence or two`);
  check(!/!/.test(words) && !/\bsimply\b/i.test(words) && !/0x[0-9a-f]+/i.test(words) && !/\b(op-?codes?|channels?|cave|banks?|hex)\b/i.test(words) && !/—/.test(words), `${code}: plain words, none of the vocabulary 05_UX section 8 forbids ("${words}")`);
  check(/[.?]$/.test(words), `${code}: ends as a sentence`);
}
{ /* named content of the messages */
  const g = (code) => allIssues.find((i) => i.code === code);
  check(g('tracks.over') && /19 tracks/.test(g('tracks.over').message) && /16/.test(g('tracks.over').message) && /Pad/.test(g('tracks.over').message), 'tracks.over says how many tracks were needed, that the game has 16, and what was left out');
  check(g('tracks.effects') && /tracks 13 to 16/.test(g('tracks.effects').message) && /Lead \(echo\)/.test(g('tracks.effects').message) && g('tracks.effects').partId === 'lead', 'tracks.effects says which parts sit on tracks 13 to 16 (the echo of Lead is the 13th track)');
  check(g('notes.dropped') && /2 notes/.test(g('notes.dropped').message) && /Lead/.test(g('notes.dropped').message), 'notes.dropped says how many notes and on which part');
  check(g('range.outside') && /Bass/.test(g('range.outside').message) && /Main bass/.test(g('range.outside').message) && /octave/.test(g('range.outside').message), 'range.outside names the part, the instrument and the octave fix');
  check(g('kit.keys') && /Beat/.test(g('kit.keys').message) && /1 note/.test(g('kit.keys').message), 'kit.keys names the part and the count');
  check(g('tuning.off') && /Lead/.test(g('tuning.off').message) && /cents/.test(g('tuning.off').message), 'tuning.off names the part and says cents');
  check(g('level.lead') && /Lead/.test(g('level.lead').message) && /dB/.test(g('level.lead').message), 'level.lead says how much louder in dB');
  check(g('loop.phrase') && /15 bars/.test(g('loop.phrase').message) && /2 bars/.test(g('loop.phrase').message), 'loop.phrase says the loop length and the phrase length');
  check(g('loop.seam') && /Bass/.test(g('loop.seam').message), 'loop.seam names the part');
  check(g('size.large') && /9\.0 KB/.test(g('size.large').message) && /in full/.test(g('size.large').message) && /\d+\.\d KB/.test(g('size.large').message.replace(/9\.0 KB/, '')), 'size.large gives the size and the plain size');
  check(g('load.high') && /130 %/.test(g('load.high').message), 'load.high says how much of the busiest piece');
  check(g('bank.custom') && /custom instrument/.test(g('bank.custom').message) && /ROM/.test(g('bank.custom').message), 'bank.custom says what a ROM needs');
  check(g('harmony.clash') && /Pad/.test(g('harmony.clash').message) && /Lead/.test(g('harmony.clash').message) && /bar 1/.test(g('harmony.clash').message), 'harmony.clash names both parts and the bar');
  check(g('mix.low') && /30 %/.test(g('mix.low').message) && /49/.test(g('mix.low').message) && /68/.test(g('mix.low').message), 'mix.low gives the song\'s number and Capcom\'s range');
  check(g('part.silent') && /Lead/.test(g('part.silent').message), 'part.silent names the part');
}
{ /* the other direction of the mix issues, and the edges of each rule */
  const only = (mut, code) => { const r = lintOf(base, mut); return codes(r.issues) === code; };
  check(only((p, c) => { c.metrics.bands = [0.8, 0.1, 0.06, 0.04]; }, 'mix.low'), 'mix.low also when the low end is too heavy');
  check(only((p, c) => { c.metrics.crest = 19; }, 'mix.punch'), 'mix.punch also when the crest is above the range');
  check(only((p, c) => { c.metrics.keysPerSecond = 10; }, 'mix.busy'), 'mix.busy also when the song is too sparse');
  check(only((p, c) => { c.metrics.bands = [0.49, 0.24, 0.11, 0.08]; c.metrics.crest = 15.0; c.metrics.keysPerSecond = 42; }, ''), 'the edges of Capcom\'s range are inside it');
  check(only((p, c) => { c.metrics.peak = 0.99; }, ''), 'a mix just under full scale does not clip');
  check(only((p, c) => { c.metrics.peak = 32767 / 32768; }, ''), 'a peak at 32767 does not clip');
  check(only((p, c) => { c.metrics = null; }, ''), 'no measurement yet: no mix or clip issue');
  check(only((p, c) => { c.load = null; }, ''), 'no load measured: no load issue');
  check(only((p, c) => { c.load.ratio = 1; }, ''), 'a load equal to the game\'s busiest piece is not above it');
  check(only((p, c) => { c.compressedBytes = 8000; }, ''), 'exactly 8 KB (8,000 bytes) is not above 8 KB');
  check(only((p, c) => { c.compressedBytes = 8001; }, 'size.large'), 'a byte more is');
  check(only((p, c) => { c.targets = null; }, ''), 'no targets given: the published ones are used');
  check(only((p, c) => { p.loop.on = false; p.chorusBar = null; }, ''), 'a song that plays once needs no chorus bar');
  check(only((p) => { p.loop.on = false; p.loop.endBar = 15; p.loop.end = 15 * BAR; }, ''), 'a loop that is off has no phrase rule');
  check(only((p) => { p.markerBars = 4; p.loop.endBar = 12; p.loop.end = 12 * BAR; }, ''), 'a loop of 12 bars fits four-bar phrases');
  check(only((p) => { p.markerBars = 4; p.loop.endBar = 14; p.loop.end = 14 * BAR; }, 'loop.phrase'), 'a loop of 14 bars does not fit four-bar phrases');
  check(only((p) => { p.markers = [{ t: 0, i: 0, v: 1 }, { t: 2 * BAR, i: 0, v: 1 }, { t: 4 * BAR, i: 0, v: 1 }]; p.markerBars = 0; }, ''), 'explicit phrase markers count as markers (no markers.off) and the loop fits their spacing');
  check(only((p) => { p.autoTune = false; }, ''), 'auto-tune off with instruments within 15 cents raises nothing');
  check(only((p) => { p.autoTune = false; partOf(p, 'lead').program = 21; partOf(p, 'lead').tune = 17; }, ''), 'a part tuned by hand to cancel the error is in tune');
  check(only((p) => { p.autoTune = true; partOf(p, 'lead').program = 21; }, ''), 'auto-tune on corrects it: nothing to say');
  check(only((p) => { p.autoTune = false; partOf(p, 'pad').program = 57; }, ''), 'an unsure tuning measurement (program 57, confidence below 0.8) is not "out of tune"');
  check(only((p) => { p.autoTune = false; partOf(p, 'bass').program = 10; }, 'range.outside'), 'an unsure and wild measurement (program 10: 562 cents) raises no tuning issue');
  check(only((p) => { partOf(p, 'lead').volume = 64; partOf(p, 'lead').expression = 64; }, ''), 'a lead at Capcom\'s own level is not too loud');
  check(only((p) => { partOf(p, 'pad').volume = 127; partOf(p, 'pad').expression = 127; }, ''), 'only leads are judged against Capcom\'s leads');
  check(only((p) => { partOf(p, 'lead').role = 'arp'; partOf(p, 'lead').volume = 100; partOf(p, 'lead').expression = 100; }, ''), 'a part that is not a lead is not a loud lead');
  check(only((p) => { partOf(p, 'lead').notes.push(note(10 * BAR + 150, 50, 12)); }, ''), 'one note outside Capcom\'s range among many is under 15 %');
  check(only((p) => { partOf(p, 'bass').mute = true; partOf(p, 'bass').transpose = 24; }, ''), 'a muted part is not judged');
  check(only((p) => { const n = partOf(p, 'bass').notes; for (let i = 0; i < 5; i++) n[i].n += 24; }, 'range.outside'), '5 of 32 bass notes outside (15.6 %) is more than 15 %');
  check(only((p) => { const n = partOf(p, 'bass').notes; for (let i = 0; i < 4; i++) n[i].n += 24; }, ''), '4 of 32 bass notes outside (12.5 %) is within 15 %');
  check(only((p) => { partOf(p, 'lead').notes.push(note(150, 130, 12, 100)); }, 'notes.dropped'), 'a note beyond 127 is lost and says so');
  check(only((p) => { partOf(p, 'lead').voices = 3; partOf(p, 'lead').notes.push(note(0, 72, 44, 100), note(0, 76, 44, 100)); }, ''), 'enough voices keep every note');
  check(only((p) => { partOf(p, 'beat').track = 1; partOf(p, 'bass').track = 1; }, 'track.pin'), 'two parts pinned to one track: the compiler\'s warning is passed on');
  check(only((p) => { partOf(p, 'bass').automation = { nonsense: [{ t: 0, v: 1 }] }; }, 'lane.unknown'), 'an unknown lane: the compiler\'s warning is passed on');
  check(only((p) => { const n = partOf(p, 'lead').notes; n.push(note(16 * BAR - 12, 70, 12, 100)); }, ''), 'a note ending exactly at the loop end is not cut');
  check(only((p) => { p.loop.on = false; const n = partOf(p, 'bass').notes; n[n.length - 1].len = 120; }, ''), 'with no loop there is no loop seam');
  check(only((p) => { partOf(p, 'beat').notes.push(note(10 * BAR + 60, 38, 12, 100)); }, ''), 'a kit key that has a sound raises nothing');
  check(only((p) => { partOf(p, 'beat').program = 1; }, ''), 'the same hits on break kit B: keys 36, 38 and 42 all have a sound (the first slice also plays every key below it)');
  check(only((p) => { partOf(p, 'beat').volume = 0; }, 'part.silent'), 'volume 0 is silent as well');
  check(only((p) => { partOf(p, 'lead').automation = { expression: [{ t: 0, v: 64 }] }; partOf(p, 'lead').expression = 0; }, ''), 'expression 0 with a lane that raises it is not a silent part');
  check(only((p) => { partOf(p, 'lead').automation = { expression: [{ t: 0, v: 0 }] }; }, 'part.silent'), 'a lane that holds the level at 0 is silent');
  check(only((p) => { partOf(p, 'lead').notes = []; }, 'part.empty'), 'a part whose notes were all deleted is empty');
  check(only((p) => { p.parts.push(part('tp', 'Tempo', null, 0, 41, [])); p.tempoPart = 'tp'; }, ''), 'the part that carries the tempo may have no notes');
  /* many clashes: never more than 8 listed */
  const r = lintOf(base, (p) => { const n = partOf(p, 'lead').notes, drone = []; for (let b = 0; b < 12; b++) { n.push(note(b * BAR + 144, 77, 24, 100)); drone.push(note(b * BAR, 76, 188, 60)); } p.parts.push(part('drone', 'Drone', 'pad', 0, 46, drone)); });
  const clashes = r.issues.filter((i) => i.code === 'harmony.clash');
  const h12 = Analyze.harmony(r.project, { catalog });
  check(h12.clashes.length > 8 && clashes.length === 8 && r.issues.length === 8, `clashes: ${h12.clashes.length} found, 8 listed, the rest said in words (${clashes.length}; "${clashes[clashes.length - 1] && clashes[clashes.length - 1].message}")`);
  check(clashes.length === 8 && /\b\d+ more\b/.test(clashes[7].message), 'the last listed clash says how many more there are');
  const bars = clashes.map((i) => i.bar);
  check(bars.every((b, i) => i === 0 || b >= bars[i - 1]), 'listed clashes are in bar order');
}
/* when 17 tracks are needed the leftovers are the news; the parts on 13-16 are then not listed separately (they cannot be anything else) */
{
  const r = lintOf(base, SEEDS['tracks.over']);
  check(!r.issues.some((i) => i.code === 'tracks.effects'), 'with too many tracks, tracks.over is said and tracks.effects is not repeated');
  const e = lintOf(base, SEEDS['tracks.effects']);
  check(e.issues.length === 1 && /Lead \(echo\)/.test(e.issues[0].message) && !/Pad/.test(e.issues[0].message), 'tracks.effects alone names only the part on track 13 (the pad echoes end on track 12)');
  const exact = lintOf(base, (p) => { partOf(p, 'pad').devices = [{ type: 'echo', delay: 24, level: 0.5, repeats: 3 }]; });
  check(exact.built.report.tracks.length === 16 && codes(exact.issues) === 'tracks.effects' && /Pad \(echo\)/.test(exact.issues[0].message) && /Lead \(echo\)/.test(exact.issues[0].message), `16 tracks exactly is fine: only tracks.effects, naming both (${codes(exact.issues)}: ${exact.issues[0] && exact.issues[0].message})`);
}

/* ---- fixes -------------------------------------------------------------------------------------------------- */
{
  const want = ['range.outside', 'tuning.off', 'level.clip', 'level.lead', 'loop.phrase', 'markers.off'];
  check(want.every((c) => fixable.has(c)), `fixes come with ${want.join(', ')} (found: ${[...fixable].join(', ')})`);
  for (const code of fixable) {
    const r = lintOf(base, SEEDS[code]), issue = r.issues.find((i) => i.code === code);
    const fix = issue.fix;
    check(fix && typeof fix.label === 'string' && fix.label.length > 3 && fix.label.length < 60 && typeof fix.apply === 'function', `${code}: the fix has a short label and an apply function ("${fix && fix.label}")`);
    const snapshot = JSON.stringify(r.project), frozen = clone(r.project);
    const deepFreeze = (o) => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; };
    deepFreeze(frozen);
    let np = null;
    try { np = fix.apply(frozen); } catch (e) { check(false, `${code}: fix.apply threw on a frozen project (it must copy before changing): ${e.message}`); continue; }
    check(np && np !== frozen && np.format === 'sf3project' && Array.isArray(np.parts), `${code}: fix.apply returns a new project`);
    check(JSON.stringify(r.project) === snapshot, `${code}: the argument is left as it was`);
    if (code === 'level.clip') continue;                 /* its measurement is checked below against real audio */
    const again = lintOf(np, (p, c) => { Object.assign(c, { metrics: r.ctx.metrics, load: r.ctx.load }); c.compressedBytes = r.ctx.compressedBytes; });
    const left = again.issues.map((i) => i.code).filter((c) => c === code);
    check(left.length === 0 && codes(again.issues) === '', `${code}: after the fix the issue is gone and nothing else appears (got "${codes(again.issues)}")`);
  }
  /* the octave fix picks the octave that puts most notes inside, and says how far */
  const r = lintOf(base, SEEDS['range.outside']);
  const np = r.issues[0].fix.apply(r.project);
  check(partOf(np, 'bass').transpose === 12 && partOf(np, 'bass').notes.every((n) => n.n + 12 >= 38 && n.n + 12 <= 61), `the octave fix takes the nearest octave that puts every bass note inside Capcom's range (24 becomes ${partOf(np, 'bass').transpose}, one octave down)`);
  /* the fix of a project that was never version 2 */
  const v1 = clone(base); delete v1.version; delete v1.autoTune; delete v1.leadIn; v1.parts.forEach((p) => { delete p.id; }); v1.parts[3].program = 21;
  const issues1 = Analyze.lint(v1, Compile.build(v1, { catalog, compress: true }), { catalog, targets: Analyze.TARGETS });
  const tune1 = issues1.find((i) => i.code === 'tuning.off');
  check(!!tune1, 'a version-1 project is read (its auto-tune is off, as version 1 sounded)');
  const fixed1 = tune1 && tune1.fix.apply(v1);
  check(fixed1 && fixed1.version === 2 && fixed1.autoTune === true && v1.version === undefined, 'its fix gives a version-2 project with auto-tune on and leaves the original');
}
{ /* the clipping fix, against real audio: a loud song clips, the fix turns every part down enough */
  const loud = clone(base); loud.parts.forEach((p) => { p.volume = 127; p.expression = 127; p.notes.forEach((n) => { n.v = 127; }); });
  loud.parts.push(Object.assign(part('l2', 'Lead 2', 'lead', 0, 42, base.parts[3].notes.map((n) => Object.assign({}, n, { n: n.n + 7 }))), { volume: 127, expression: 127 }));
  loud.parts.push(Object.assign(part('l3', 'Lead 3', 'lead', 0, 44, base.parts[3].notes.map((n) => Object.assign({}, n, { n: n.n - 12 }))), { volume: 127, expression: 127 }));
  const built = Compile.build(loud, { catalog, compress: true });
  const m1 = Analyze.measure(G.Engine, G.pack, built, { seconds: 12 }).metrics;
  check(m1.peak > 1, `the loud fixture clips for real (peak ${m1.peak})`);
  const issues = Analyze.lint(loud, built, { catalog, targets: Analyze.TARGETS, metrics: m1 });
  const clip = issues.find((i) => i.code === 'level.clip');
  check(!!clip && !!clip.fix, 'a clipping mix gets the level.clip issue with a fix');
  if (clip && clip.fix) {
    const quieter = clip.fix.apply(loud);
    check(quieter.parts.every((p, i) => p.volume <= loud.parts[i].volume && p.volume >= 1), 'the fix turns the parts down, not off');
    const b2 = Compile.build(quieter, { catalog, compress: true });
    const m2 = Analyze.measure(G.Engine, G.pack, b2, { seconds: 12 }).metrics;
    check(m2.peak < 1 && m2.peak > 0.5, `after the fix the mix peaks at ${m2.peak}, inside full scale and not far below`);
    check(!Analyze.lint(quieter, b2, { catalog, targets: Analyze.TARGETS, metrics: m2 }).some((i) => i.code === 'level.clip'), 'and level.clip is gone');
  }
}

lap('lint seeds and fixes');
/* ---- Capcom's own pieces ------------------------------------------------------------------------------------ */
{
  const metricsOf = new Map(themes.map((s, i) => [s.code, ref34[i]]));
  const published = Analyze.TARGETS, T = global.COMPUTED;
  const mixCount = { 'mix.low': 0, 'mix.punch': 0, 'mix.busy': 0 };
  let pieces = 0, trouble = [], issueTotal = 0, briefs = [];
  for (const s of data.songs) {
    let project, built, issues;
    try {
      project = Decomp.fromGame(s, G.Data.describe(s));
      built = Compile.build(project, { catalog, compress: true });
      const m = metricsOf.get(s.code);
      const ctx = { catalog, targets: T, metrics: m ? { width: m.width, bands: m.bands, rms: m.rms, crest: m.crest, motion: m.motion, keysPerSecond: m.keys, voices: m.voices, peak: 0.5 } : null };
      issues = Analyze.lint(project, built, ctx);
      pieces++; issueTotal += issues.length;
      for (const c of Object.keys(mixCount)) mixCount[c] += issues.filter((i) => i.code === c).length;
      const bad = issues.filter((i) => !TABLE.some(([c]) => c === i.code) && !['track.pin', 'lane.unknown', 'bank.missing', 'autotune.nocatalog'].includes(i.code) || !['error', 'warn', 'info'].includes(i.level) || typeof i.message !== 'string');
      if (bad.length) trouble.push(`music ${s.code}: malformed issue ${JSON.stringify(bad[0])}`);
      if (issues.some((i) => i.code === 'tracks.over' || i.code === 'notes.dropped')) trouble.push(`music ${s.code}: ${codes(issues.filter((i) => i.code === 'tracks.over' || i.code === 'notes.dropped'))} on Capcom's own piece`);
      const h = Analyze.harmony(project, { catalog });
      if (!(h.bars.length >= Math.ceil((project.length || project.bars * BAR) / BAR) - 0 && h.key && h.key.confidence >= 0 && h.key.confidence <= 1 && h.bars.every((b, i) => b.bar === i + 1 && (b.chord === null || typeof b.chord === 'string'))))
        trouble.push(`music ${s.code}: harmony is malformed (${h.bars.length} bars)`);
      const text = Analyze.brief(project, built, { catalog, targets: T, metrics: ctx.metrics, issues, harmony: h });
      const lines = text.split('\n');
      if (lines.length >= 120) trouble.push(`music ${s.code}: brief has ${lines.length} lines`);
      if (/<[a-z]+>|0x[0-9a-f]{2}/i.test(text)) trouble.push(`music ${s.code}: brief has markup or hex`);
      if (s.code === 20) briefs.push(text);
    } catch (e) { trouble.push(`music ${s.code}: ${e.stack.split('\n').slice(0, 3).join(' / ')}`); }
  }
  check(pieces === 49, `all 49 pieces lint and have a brief (${pieces})`);
  check(trouble.length === 0, `Capcom's pieces: no malformed issue, no lost notes or tracks, harmony shaped right, briefs under 120 lines${trouble.length ? ': ' + trouble.slice(0, 4).join(' | ') : ''}`);
  const out = (get, t) => ref34.filter((m) => get(m) < t.lo || get(m) > t.hi).length;
  check(mixCount['mix.low'] === out((m) => m.bands[0], T.bands[0]) && mixCount['mix.punch'] === out((m) => m.crest, T.crest) && mixCount['mix.busy'] === out((m) => m.keys, T.keysPerSecond),
    `the mix issues on the 34 themes equal an independent count of themes outside the computed ranges (low ${mixCount['mix.low']}, punch ${mixCount['mix.punch']}, busy ${mixCount['mix.busy']})`);
  check(briefs.length === 1 && briefs[0].split('\n').length > 10, 'music 20 has a brief of more than ten lines');
}

/* ==================================================================================================================
 * 6. driver load
 * ================================================================================================================== */
lap('Capcom lint');
{
  const song20 = data.songs.find((s) => s.code === 20);
  const t0 = Date.now();
  const mine = Analyze.driverLoad(G.Engine, G.pack, song20.bytes);
  const first = Date.now() - t0;
  const bin = path.join(RUN, 'music20.bin');
  fs.writeFileSync(bin, Buffer.from(song20.bytes));
  const ref = JSON.parse(cp.execFileSync('node', [path.join(G.root, 'checks', 'driver_load.js'), bin], { cwd: G.root, windowsHide: true }).toString());
  check(mine.peak === ref.song.peak && mine.mean === ref.song.mean, `driverLoad: the song's peak ${mine.peak} and mean ${mine.mean} equal checks/driver_load.js (${ref.song.peak}, ${ref.song.mean})`);
  check(mine.game && mine.game.peak === ref.game_busiest.peak && mine.game.code === ref.game_busiest.code && mine.game.mean === ref.game_busiest.mean, `the game's busiest piece: music ${mine.game && mine.game.code}, ${mine.game && mine.game.peak} instructions (reference ${ref.game_busiest.code}, ${ref.game_busiest.peak})`);
  check(near(mine.ratio, ref.song_peak_vs_game, 0.0051), `ratio ${mine.ratio.toFixed(3)} against the reference's ${ref.song_peak_vs_game}`);
  const t1 = Date.now();
  const again = Analyze.driverLoad(G.Engine, G.pack, song20.bytes);
  check(again.game === mine.game || JSON.stringify(again.game) === JSON.stringify(mine.game), 'the game\'s figure is the same the second time');
  check(Date.now() - t1 < first / 2 + 50, `the game's figure is cached (first call ${first} ms, second ${Date.now() - t1} ms)`);
  const built = Compile.build(Decomp.fromGame(song20, G.Data.describe(song20)), { catalog });
  const viaBuild = Analyze.driverLoad(G.Engine, G.pack, built);
  check(viaBuild.peak > 0 && viaBuild.peak < mine.game.peak * 1.2, `a build can be given instead of bytes (peak ${viaBuild.peak})`);
  const given = Analyze.driverLoad(G.Engine, G.pack, song20.bytes, { game: { peak: 1000, mean: 900, code: 1 } });
  check(near(given.ratio, mine.peak / 1000, 1e-9), 'the game\'s figure can be given (so a page can keep it)');
}

/* ==================================================================================================================
 * 7. the agent brief
 * ================================================================================================================== */
lap('driver load');
{
  const built = Compile.build(base, { catalog, compress: true });
  const ctx = baseContext(built);
  const issues = Analyze.lint(base, built, ctx);
  const text = Analyze.brief(base, built, { catalog, targets: ctx.targets, metrics: ctx.metrics, issues, harmony: Analyze.harmony(base, { catalog }) });
  const lines = text.split('\n');
  check(typeof text === 'string' && lines.length >= 8 && lines.length < 120, `the brief is plain text of ${lines.length} lines (under 120)`);
  check(/Night Drive/.test(text) && /130/.test(text) && /A minor/.test(text) && /16 bars/.test(text), 'the brief gives the name, tempo, key and length');
  check(['Beat', 'Bass', 'Pad', 'Lead'].every((n) => text.includes(n)) && /Main bass/.test(text) && /Strings/.test(text) && /Thin lead/.test(text) && /Drum hits/.test(text), 'the brief lists every part with its instrument by name');
  check(/Am/.test(text) && /\bF\b/.test(text) && /\bG\b/.test(text), 'the brief says the chord of each bar');
  check(/low end/i.test(text) && /0\.57/.test(text) && /49/.test(text) && /punch|crest/i.test(text) && /notes a second|notes per second/i.test(text), 'the brief gives the mix numbers against Capcom\'s');
  check(/Game check|no issues|ready/i.test(text), 'the brief says what the game check found (nothing, here)');
  check(/Intro/.test(text) && /Verse/.test(text) && /bar 9|from bar 9/i.test(text), 'the brief gives sections and the rounds 2+ bar');
  const bad = lintOf(base, (p) => { SEEDS['tracks.effects'](p); SEEDS['harmony.clash'](p); SEEDS['range.outside'](p); });
  const bt = Analyze.brief(bad.project, bad.built, { catalog, targets: bad.ctx.targets, metrics: bad.ctx.metrics, issues: bad.issues, harmony: Analyze.harmony(bad.project, { catalog }) });
  check(bad.issues.length >= 3 && bad.issues.every((i) => bt.includes(i.message)), 'every issue\'s message appears in the brief as it does on screen');
  check(Analyze.brief(base, built, { catalog, targets: ctx.targets, metrics: ctx.metrics, issues, harmony: Analyze.harmony(base, { catalog }) }) === text, 'the brief is the same twice');
  if (process.argv.includes('--show')) console.log('\n' + bt + '\n');
  const lean = Analyze.brief(base, built, { catalog });
  check(typeof lean === 'string' && lean.split('\n').length < 120 && /Night Drive/.test(lean), 'a brief can be made from the project and its build alone');
  const sixteen = clone(base);
  for (let i = 0; i < 24; i++) sixteen.parts.push(part(`x${i}`, `Extra ${i}`, 'fx', 0, 41, [note(i * 24, 60 + (i % 5), 12)]));
  sixteen.parts.forEach((p, i) => { if (i > 3) p.voices = 1; });
  const big = Analyze.brief(sixteen, Compile.build(sixteen, { catalog, compress: true }), { catalog });
  check(big.split('\n').length < 120, `a project of ${sixteen.parts.length} parts still gets a brief under 120 lines (${big.split('\n').length})`);
  const long = clone(base); long.bars = 160; long.loop.endBar = 160; long.loop.end = 160 * BAR;
  for (const p of long.parts) { const n = p.notes.slice(); for (let k = 1; k < 10; k++) for (const x of n) p.notes.push(Object.assign({}, x, { t: x.t + k * 16 * BAR })); }
  const lb = Analyze.brief(long, Compile.build(long, { catalog, compress: true }), { catalog });
  check(lb.split('\n').length < 120, `a 160-bar song gets a brief under 120 lines (${lb.split('\n').length})`);
}

/* ==================================================================================================================
 * 8. headless and deterministic
 * ================================================================================================================== */
{
  const src = fs.readFileSync(path.join(G.root, 'js', 'analyze.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  check(!/\brequire\(\s*['"](fs|path|child_process|os|http|https|net|zlib)['"]\s*\)/.test(code) && !/\bdocument\b/.test(code) && !/\bprocess\b/.test(code), 'js/analyze.js touches no files, no document, no process');
  check(!/Math\.random|Date\.now|new Date|performance\.now|\bsetTimeout\b/.test(code), 'js/analyze.js reads no clock and no random numbers');
  const reqs = [...code.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
  check(reqs.every((r) => /^\.\/[a-z0-9_]+\.js$/.test(r)), `js/analyze.js requires only the Studio's own modules (${reqs.join(', ')})`);
  const a = Analyze.lint(base, Compile.build(base, { catalog, compress: true }), baseContext(Compile.build(base, { catalog, compress: true })));
  const r1 = lintOf(base, SEEDS['range.outside']).issues, r2 = lintOf(base, SEEDS['range.outside']).issues;
  const plain = (xs) => JSON.stringify(xs.map((i) => Object.assign({}, i, { fix: i.fix && i.fix.label })));
  check(plain(r1) === plain(r2) && a.length === 0, 'lint gives the same issues, in the same order, twice');
  const many = lintOf(base, (p, c) => { SEEDS['tracks.effects'](p); SEEDS['harmony.clash'](p); SEEDS['range.outside'](p); SEEDS['markers.off'](p); SEEDS['chorus.none'](p); c.metrics.crest = 10; });
  const order = { error: 0, warn: 1, info: 2 };
  check(many.issues.every((i, k) => k === 0 || order[many.issues[k - 1].level] <= order[i.level]), `issues come errors first, then warnings, then information (${many.issues.map((i) => i.level[0] + ':' + i.code).join(' ')})`);
}

lap('end');
done('mix numbers, targets, harmony, Game Check');
