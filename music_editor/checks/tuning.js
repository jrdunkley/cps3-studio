/* How well in tune is each pitched music instrument? (node checks/tuning.js)
 * For every sample of the pitched programs in bank 0 the pitch is measured precisely: the
 * autocorrelation is followed out to about 40 periods, so the period is known to a fraction of a
 * sample. It is compared with the pitch the driver assumes (the sample's root key, played at the
 * root-key step 0x0FE1 of the 37,287 Hz chip clock). Prints cents sharp (+) or flat (-); the
 * nearest octave is ignored, since a root key can be labelled an octave away.
 */
'use strict';
const path = require('path');
const root = path.join(__dirname, '..');
require(path.join(root, 'data', 'pack.js'));
const { Engine, CHIP_RATE } = require(path.join(root, 'js', 'engine.js'));
const Data = require(path.join(root, 'js', 'gamedata.js'));
const e = new Engine(globalThis.SF3_PACK);
const d = Data.load(e, globalThis.SF3_PACK.names);
const RATE = CHIP_RATE * 0xFE1 / 0x1000;

function measure(s) {
  const from = s.looped ? s.loop : s.start + Math.floor((s.end - s.start) * 0.25);
  const n = Math.min(s.end - from, 6000);
  if (n < 400) return null;
  const x = new Float64Array(n);
  let mean = 0;
  for (let i = 0; i < n; i++) { x[i] = e.samples[from + i]; mean += x[i]; }
  mean /= n; for (let i = 0; i < n; i++) x[i] -= mean;
  const corr = (lag) => { let a = 0, b = 0, c = 0; for (let i = 0; i + lag < n; i++) { a += x[i] * x[i + lag]; b += x[i] * x[i]; c += x[i + lag] * x[i + lag]; } return a / Math.sqrt(b * c + 1e-9); };
  /* first strong peak = one period */
  let best = 0, period = 0;
  const cs = [];
  for (let lag = 4; lag < Math.min(900, n / 3); lag++) cs[lag] = corr(lag);
  for (let lag = 5; lag < cs.length - 1; lag++) if (cs[lag] > cs[lag - 1] && cs[lag] >= cs[lag + 1] && cs[lag] > best + 0.03) { if (cs[lag] > 0.5 && !period) period = lag; best = Math.max(best, cs[lag]); }
  if (!period) return null;
  /* refine at growing multiples */
  let p = period, conf = cs[period];
  for (let k = 2; k * p < n * 0.6 && k <= 40; k = Math.ceil(k * 1.5)) {
    const centre = Math.round(k * p);
    let bl = centre, bc = -2;
    for (let lag = centre - 3; lag <= centre + 3; lag++) { const c = corr(lag); if (c > bc) { bc = c; bl = lag; } }
    if (bc < 0.4) break;
    const l = corr(bl - 1), r = corr(bl + 1), shift = (l - r) / (2 * (l - 2 * bc + r) || 1);
    p = (bl + shift) / k; conf = bc;
  }
  const hz = RATE / p, want = 440 * Math.pow(2, (s.root - 69) / 12);
  let cents = 1200 * Math.log2(hz / want);
  cents -= 1200 * Math.round(cents / 1200);
  return { cents, conf, hz };
}

const rows = [];
for (const p of d.banks[0]) {
  if (!p || p.kit) continue;
  for (const r of p.live) {
    const s = d.samples[r.sample], m = s && measure(s);
    rows.push({ program: p.program, keys: `${r.keyLow}-${r.keyHigh}`, sample: r.sample, looped: s && s.looped, fine: r.fine, m });
  }
}
for (const r of rows) console.log(`program ${String(r.program).padStart(2)} keys ${r.keys.padEnd(7)} sample ${String(r.sample).padStart(3)} ${r.looped ? 'loop' : 'once'} ` +
  (r.m ? `${(r.m.cents >= 0 ? '+' : '') + r.m.cents.toFixed(0)} cents (confidence ${r.m.conf.toFixed(2)})` : 'no clear pitch'));
