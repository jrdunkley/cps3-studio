/* How a piece SOUNDS, in numbers, so an arrangement can be compared with Capcom's own music
 * (node style/metrics.js [song files...]). Renders through the game's driver (engine.js) and
 * measures over up to 40 s after the first second:
 *   width   side/mid energy ratio (0 = mono; Capcom's doubles and echoes make it wide)
 *   bands   share of energy below 150 Hz, 150-600, 600-2500, above 2500 Hz
 *   rms     loudness in dBFS, crest = peak/rms in dB (punch), motion = spread of 50 ms loudness in dB
 *   keys    key-ons per second, voices = mean voices sounding
 * With no arguments: every fighting theme (codes 10..43) and the approved songs in songs/.
 * Writes out/style/metrics.json and prints a table with Capcom's range.
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

function biquad(type, f0, fs) {
  const w = 2 * Math.PI * f0 / fs, c = Math.cos(w), s = Math.sin(w), a = s / (2 * 0.707);
  const b = type === 'lp' ? [(1 - c) / 2, 1 - c, (1 - c) / 2] : [(1 + c) / 2, -(1 + c), (1 + c) / 2];
  const a0 = 1 + a, a1 = -2 * c, a2 = 1 - a;
  return (x) => { const y = new Float64Array(x.length); let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < x.length; i++) { const v = (b[0] * x[i] + b[1] * x1 + b[2] * x2 - a1 * y1 - a2 * y2) / a0; x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v; } return y; };
}
const energy = (x) => { let s = 0; for (let i = 0; i < x.length; i++) s += x[i] * x[i]; return s; };

/* render: code = a request code already in the ROM, or bytes = a sequence to patch in */
function render(src, seconds) {
  const e = new Engine(pack);
  if (src.bytes) { e.patchSequence(src.bytes, 60); e.request(60); } else e.request(src.code);
  e.keyOns = [];
  const frames = Math.round((seconds + 1) * 59.6);
  const cap = Math.ceil(frames * 626) + 16, L = new Int32Array(cap), R = new Int32Array(cap);
  let at = 0, voiceSum = 0;
  for (let f = 0; f < frames; f++) { at += e.step(L, R, at); let v = 0; for (let i = 0; i < 16; i++) if (e.key & (1 << i)) v++; voiceSum += v; }
  return { L, R, n: at, keyOns: e.keyOns.filter(([f]) => f >= 60).length, voices: voiceSum / frames };
}

function measure(r, seconds) {
  const from = Math.round(CHIP_RATE), n = Math.min(r.n - from, Math.round(seconds * CHIP_RATE));
  const mid = new Float64Array(n), side = new Float64Array(n);
  for (let i = 0; i < n; i++) { const l = r.L[from + i] / 32768, rr = r.R[from + i] / 32768; mid[i] = (l + rr) / 2; side[i] = (l - rr) / 2; }
  const fs = CHIP_RATE;
  const low = biquad('lp', 150, fs)(mid), lowmid = biquad('lp', 600, fs)(mid), midband = biquad('lp', 2500, fs)(mid);
  const eAll = energy(mid) || 1e-9, eLow = energy(low), eLowMid = energy(lowmid), eMid = energy(midband);
  const bands = [eLow, Math.max(0, eLowMid - eLow), Math.max(0, eMid - eLowMid), Math.max(0, eAll - eMid)].map((v) => +(v / eAll).toFixed(3));
  let peak = 0; for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(r.L[from + i]), Math.abs(r.R[from + i]));
  const rms = Math.sqrt((energy(mid) + energy(side)) / n);
  const win = Math.round(fs * 0.05), levels = [];
  for (let i = 0; i + win <= n; i += win) { let s = 0; for (let j = i; j < i + win; j++) s += mid[j] * mid[j] + side[j] * side[j]; levels.push(10 * Math.log10(s / win + 1e-12)); }
  levels.sort((a, b) => a - b);
  return { width: +(energy(side) / eAll).toFixed(3), bands, rms: +(20 * Math.log10(rms + 1e-9)).toFixed(1), crest: +(20 * Math.log10(peak / 32768 / (rms + 1e-9))).toFixed(1),
           motion: +(levels[Math.floor(levels.length * 0.9)] - levels[Math.floor(levels.length * 0.1)]).toFixed(1),
           keys: +(r.keyOns / seconds).toFixed(1), voices: +r.voices.toFixed(1) };
}

function songBytes(file) { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return new Uint8Array(Buffer.from(j.sequence_b64, 'base64')); }

function run(items, seconds) {
  return items.map((it) => { const r = render(it, seconds); return Object.assign({ name: it.name }, measure(r, Math.min(seconds, r.n / CHIP_RATE - 1))); });
}

if (require.main === module) {
  const SECONDS = 40;
  const data = Data.load(new Engine(pack), pack.names);
  const files = process.argv.slice(2);
  const ours = (files.length ? files : fs.readdirSync(path.join(root, 'songs')).filter((f) => f.endsWith('.sf3song.json')).map((f) => path.join(root, 'songs', f)))
    .map((f) => ({ name: path.basename(f).replace('.sf3song.json', ''), bytes: songBytes(f) }));
  const capcom = files.length ? [] : data.songs.filter((s) => s.code >= 10 && s.code <= 43).map((s) => ({ name: `${s.code} ${s.name}`, code: s.code }));
  const cm = run(capcom, SECONDS), om = run(ours, SECONDS);
  const row = (m) => `${m.name.slice(0, 34).padEnd(34)} width ${m.width.toFixed(2)}  bands ${m.bands.map((b) => b.toFixed(2)).join(' ')}  rms ${m.rms.toFixed(1).padStart(5)}  crest ${m.crest.toFixed(1).padStart(4)}  motion ${m.motion.toFixed(1).padStart(4)}  keys/s ${m.keys.toFixed(1).padStart(4)}  voices ${m.voices.toFixed(1).padStart(4)}`;
  const lines = cm.map(row);
  if (cm.length) {
    const q = (k, p, f) => { const xs = cm.map(f || ((m) => m[k])).sort((a, b) => a - b); return xs[Math.floor(p * (xs.length - 1))]; };
    const range = (label, f) => `${label} ${q(0, 0.1, f).toFixed(2)}..${q(0, 0.9, f).toFixed(2)} (median ${q(0, 0.5, f).toFixed(2)})`;
    lines.push('', 'Capcom 10%..90%: ' + [range('width', (m) => m.width), range('low', (m) => m.bands[0]), range('lowmid', (m) => m.bands[1]), range('mid', (m) => m.bands[2]),
      range('high', (m) => m.bands[3]), range('crest', (m) => m.crest), range('motion', (m) => m.motion), range('keys/s', (m) => m.keys), range('voices', (m) => m.voices)].join('; '));
  }
  lines.push('', ...om.map(row));
  if (!files.length) fs.writeFileSync(path.join(OUT, 'metrics.json'), JSON.stringify({ capcom: cm, ours: om }));
  console.log(lines.join('\n'));
}
module.exports = { render, measure, songBytes };
