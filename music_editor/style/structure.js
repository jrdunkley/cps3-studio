/* A song's sections, read from its MIDI (node style/structure.js <midi or plan.js> [phrase bars]).
 * After the arranger's own reading (beat shift, halving, piano split), every phrase (4 bars by
 * default) gets a fingerprint per part: which notes start where (pitch class and 16th). Phrases
 * whose tunes match are labelled alike (A, B, C...), and the parts playing are listed, so the
 * verse, chorus, hook and breaks can be read off for a drum script. Prints one line per phrase.
 */
'use strict';
const path = require('path');
const A = require('./arrange3s.js');

function sections(plan, phraseBars) {
  const ph = phraseBars || 4, BAR = 192;
  const { parts, roles, bars } = A.prepare(plan);
  const tunes = parts.filter((p) => roles.get(p) === 'lead' || roles.get(p) === 'counter');
  const sig = (p, b0) => p.notes.filter((n) => n.t >= b0 * BAR && n.t < (b0 + ph) * BAR).map((n) => `${Math.round((n.t - b0 * BAR) / 12)}:${n.n % 12}`).join(' ');
  const sim = (a, b) => { const x = new Set(a.split(' ')), y = new Set(b.split(' ')); if (!x.size && !y.size) return 1; let c = 0; for (const k of x) if (y.has(k)) c++; return (2 * c) / (x.size + y.size); };
  const rows = [], labels = [];
  for (let b = 0; b < bars; b += ph) {
    const tune = tunes.map((p) => sig(p, b)).join(' | ');
    let label = null;
    for (const r of rows) if (sim(r.tune, tune) >= 0.7 && r.tune.length) { label = r.label; break; }
    if (!label) { label = String.fromCharCode(65 + labels.length); labels.push(label); }
    const playing = parts.filter((p) => p.notes.some((n) => n.t < (b + ph) * BAR && n.t + n.len > b * BAR)).map((p) => `${p.drums ? 'drums' : roles.get(p) || 'off'}:${p.name.slice(0, 18)}(${p.notes.filter((n) => n.t >= b * BAR && n.t < (b + ph) * BAR).length})`);
    rows.push({ bar: b + 1, label: tune.replace(/[ |]/g, '').length ? label : '-', tune, playing });
  }
  return rows;
}

module.exports = { sections };
if (require.main === module) {
  const arg = process.argv[2];
  const plan = /\.midi?$/i.test(arg) ? { midi: arg, name: path.basename(arg) } : require(path.resolve(arg));
  for (const r of sections(plan, Number(process.argv[3] || 4))) console.log(`${String(r.bar).padStart(4)} ${r.label}  ${r.playing.join('  ')}`);
}
