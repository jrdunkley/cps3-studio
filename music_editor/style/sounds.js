/* What the music instruments sound like, measured from the samples (node style/sounds.js).
 * Break kits: every slice is split into bands at its playing rate (the note Capcom plays it at,
 * normally 20 semitones under the root key) and labelled by what starts it: K kick (low band),
 * S snare (mid/high noise with body), H hat/cymbal (high band only), plus later hits inside it.
 * Pitched programs: attack, decay to -20 dB, spectral centroid and how periodic the sound is
 * at the pitch Capcom plays them, so the arranger can match a MIDI part to the right sound.
 * Writes out/style/sounds.json and sounds.txt.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
if (!globalThis.SF3_PACK) require(path.join(root, 'data', 'pack.js'));
const { Engine, CHIP_RATE } = require(path.join(root, 'js', 'engine.js'));
const Data = require(path.join(root, 'js', 'gamedata.js'));
const OUT = path.join(root, 'out', 'style');
const pack = globalThis.SF3_PACK;
const e = new Engine(pack);
const data = Data.load(e, pack.names);
const ROOT_RATE = CHIP_RATE * 0xFE1 / 4096;

/* RBJ biquad */
function biquad(type, f0, fs, q) {
  const w = 2 * Math.PI * f0 / fs, c = Math.cos(w), s = Math.sin(w), a = s / (2 * (q || 0.707));
  let b0, b1, b2;
  if (type === 'lp') { b0 = (1 - c) / 2; b1 = 1 - c; b2 = (1 - c) / 2; }
  else if (type === 'hp') { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = (1 + c) / 2; }
  else { b0 = a; b1 = 0; b2 = -a; }                                  // band-pass, 0 dB peak
  const a0 = 1 + a, a1 = -2 * c, a2 = 1 - a;
  return (x) => { const y = new Float64Array(x.length); let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < x.length; i++) { const v = (b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0; x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v; } return y; };
}
const rms = (x, from, to) => { let s = 0; to = Math.min(to, x.length); for (let i = from; i < to; i++) s += x[i] * x[i]; return to > from ? Math.sqrt(s / (to - from)) : 0; };
const db = (v) => 20 * Math.log10(Math.max(v, 1e-6));

function pcm(s) { const x = new Float64Array(s.end - s.start); for (let i = 0; i < x.length; i++) x[i] = e.samples[s.start + i] / 128; return x; }

/* a drum slice: band levels in 10 ms windows; hits = onsets in the low (kick) and mid (snare) bands */
function slice(s, rate) {
  const x = pcm(s), win = Math.round(rate * 0.010);
  const low = biquad('lp', 110, rate, 0.8)(x), mid = biquad('bp', 1200, rate, 0.7)(x), high = biquad('hp', 3500, rate, 0.7)(x);
  const frames = [];
  for (let i = 0; i < x.length; i += win) frames.push({ t: i / rate, all: rms(x, i, i + win), low: rms(low, i, i + win), mid: rms(mid, i, i + win), high: rms(high, i, i + win) });
  const peak = Math.max(...frames.map((f) => f.all)) || 1;
  /* onsets: a band jumping by 6 dB over the last 30 ms and loud enough */
  const onsets = [];
  for (const band of ['low', 'mid', 'high']) {
    const ref = Math.max(...frames.map((f) => f[band])) || 1;
    for (let k = 0; k < frames.length; k++) {
      const prev = Math.max(1e-6, ...frames.slice(Math.max(0, k - 3), k).map((f) => f[band]), k ? 0 : 1e-6);
      if (frames[k][band] > ref * 0.35 && (k === 0 || frames[k][band] > prev * 2)) { onsets.push({ band, t: frames[k].t, level: frames[k][band] / peak }); k += 4; }
    }
  }
  const head = frames.slice(0, 4);
  const sum = (b) => head.reduce((a, f) => a + f[b], 0);
  const lo = sum('low'), mi = sum('mid'), hi = sum('high'), tot = lo + mi + hi || 1;
  let label = '';
  if (lo / tot > 0.45) label += 'K';
  if (mi / tot > 0.35 && hi / tot > 0.12 && lo / tot < 0.5) label += 'S';
  if (!label) label = hi / tot > 0.35 ? 'H' : mi / tot > 0.5 ? 'M' : 'K';
  const later = onsets.filter((o) => o.t > 0.04).map((o) => `${o.band[0].toUpperCase()}@${Math.round(o.t * 1000)}`);
  return { seconds: +(x.length / rate).toFixed(3), label, low: +(lo / tot).toFixed(2), mid: +(mi / tot).toFixed(2), high: +(hi / tot).toFixed(2),
           level: +db(peak).toFixed(1), later };
}

/* a pitched sound at a given note: attack, decay, brightness, periodicity */
function tone(s, note) {
  const rate = ROOT_RATE * Math.pow(2, (note - s.root) / 12);
  const x = pcm(s), win = Math.round(rate * 0.010);
  const env = [];
  for (let i = 0; i < x.length; i += win) env.push(rms(x, i, i + win));
  const peak = Math.max(...env) || 1, at = env.indexOf(peak);
  let decay = env.length;
  for (let k = at; k < env.length; k++) if (env[k] < peak * 0.1) { decay = k; break; }
  /* centroid by a 512-point DFT around the peak */
  const N = 512, from = Math.min(at * win, Math.max(0, x.length - N));
  let num = 0, den = 0;
  for (let k = 1; k < N / 2; k++) {
    let re = 0, im = 0;
    for (let i = 0; i < N && from + i < x.length; i++) { const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N); re += x[from + i] * w * Math.cos(2 * Math.PI * k * i / N); im -= x[from + i] * w * Math.sin(2 * Math.PI * k * i / N); }
    const m = Math.hypot(re, im); num += m * k * rate / N; den += m;
  }
  const f0 = 440 * Math.pow(2, (note - 69) / 12);
  return { rateHz: Math.round(rate), attackMs: at * 10, decayMs: s.looped ? null : decay * 10, seconds: +(x.length / rate).toFixed(2), looped: s.looped,
           centroidHz: Math.round(num / (den || 1)), brightness: +((num / (den || 1)) / f0).toFixed(1) };
}

module.exports = { slice, tone, ROOT_RATE };
if (require.main !== module) return;
const survey = JSON.parse(fs.readFileSync(path.join(OUT, 'survey.json'), 'utf8'));
const usage = new Map(survey.usage.map((u) => [u.program, u]));
const lines = [], out = { kits: {}, tones: {} };
const BREAKS = [0, 1, 2, 3, 4, 10, 11, 12, 13, 5, 6, 61, 7, 8];
lines.push('Drum programs: each key at the note Capcom plays (20 under the root unless noted)');
for (const pn of BREAKS) {
  const p = data.banks[0][pn];
  if (!p) continue;
  const rows = [];
  for (const r of p.live) {
    const s = data.samples[r.sample];
    const note = Math.max(r.keyLow, Math.min(r.keyHigh, s.root - 20));
    const rate = ROOT_RATE * Math.pow(2, (note - s.root) / 12);
    const m = slice(s, rate);
    rows.push(Object.assign({ keys: [r.keyLow, r.keyHigh], sample: r.sample, note }, m));
  }
  out.kits[pn] = rows;
  const slices = rows.filter((r) => r.keys[0] >= 41 && r.keys[1] <= 48 && r.keys[0] === r.keys[1] || r.keys[1] === 41);
  const bar = slices.reduce((a, r) => a + r.seconds, 0);
  lines.push(`program ${pn}${usage.has(pn) ? ` (songs ${usage.get(pn).songs.join(',')})` : ''}${slices.length >= 6 ? `: keys 41-48 add up to ${bar.toFixed(2)} s = one bar at ${(240 / bar).toFixed(1)} BPM` : ''}`);
  for (const r of rows) lines.push(`   keys ${r.keys.join('-').padEnd(7)} s${String(r.sample).padStart(3)} ${r.seconds.toFixed(3)}s ${r.label.padEnd(2)} low ${r.low.toFixed(2)} mid ${r.mid.toFixed(2)} high ${r.high.toFixed(2)} ${r.level.toFixed(0).padStart(3)} dB ${r.later.join(' ')}`);
}
lines.push('', 'Pitched programs at Capcom\'s median note: attack, decay to -20 dB, length, centroid (and in harmonics of the note)');
for (const p of data.banks[0]) {
  if (!p || BREAKS.includes(p.program)) continue;
  const u = usage.get(p.program);
  const note = u ? Math.round(u.medianSemisFromRoot + data.samples[p.live[0].sample].root) : 60;
  const rows = p.live.map((r) => { const s = data.samples[r.sample]; return Object.assign({ keys: [r.keyLow, r.keyHigh], sample: r.sample }, tone(s, Math.max(r.keyLow, Math.min(r.keyHigh, note)))); });
  out.tones[p.program] = rows;
  const t = rows.find((r) => note >= r.keys[0] && note <= r.keys[1]) || rows[0];
  lines.push(`  ${String(p.program).padStart(2)} ${p.live.length} region(s) ${t.looped ? 'loop' : 'once'} @note ${note}: attack ${t.attackMs} ms, decay ${t.decayMs === null ? 'held' : t.decayMs + ' ms'}, ${t.seconds}s, centroid ${t.centroidHz} Hz (x${t.brightness})${u ? `, used ${u.hits}x in ${u.songs.length} songs` : ', unused'}`);
}
fs.writeFileSync(path.join(OUT, 'sounds.json'), JSON.stringify(out));
fs.writeFileSync(path.join(OUT, 'sounds.txt'), lines.join('\n'));
console.log(lines.join('\n'));
