/* Facts about Capcom's own music the arranger copies, measured from the ROM each run (no saved
 * tables): how each music instrument is used (note range and median, note length, level) and the
 * break library (style/breaks.js). See style/techniques.js for the production habits these follow.
 */
'use strict';
const path = require('path');
const root = path.join(__dirname, '..');
if (!globalThis.SF3_PACK) require(path.join(root, 'data', 'pack.js'));
const { Engine } = require(path.join(root, 'js', 'engine.js'));
const Seq = require(path.join(root, 'js', 'seq.js'));
const Data = require(path.join(root, 'js', 'gamedata.js'));
const Breaks = require('./breaks.js');

let cache = null;
function load() {
  if (cache) return cache;
  const pack = globalThis.SF3_PACK;
  const data = Data.load(new Engine(pack), pack.names);
  const use = new Map();
  for (const song of data.songs) {
    const info = Data.describe(song);
    if (!info.loopLength) continue;
    const end = info.loopStart + info.loopLength;
    info.seq.tracks.forEach((events) => {
      if (!events) return;
      const f = Seq.follow(events, end - 1, true);
      const ctl = f.controls.slice().sort((a, b) => a.t - b.t);
      let ci = 0, prog = -1, bank = 0;
      for (const n of f.notes) {
        while (ci < ctl.length && ctl[ci].t <= n.t) { const c = ctl[ci++]; if (c.op === 0xC4) prog = c.a[0]; if (c.op === 0xC2) bank = c.a[0] & 15; }
        if (bank !== 0 || prog < 0) continue;
        if (!use.has(prog)) use.set(prog, { keys: [], lens: [] });
        use.get(prog).keys.push(n.n); use.get(prog).lens.push(n.len);
      }
    });
  }
  const programs = {};
  for (const [p, u] of use) {
    const k = u.keys.slice().sort((a, b) => a - b), l = u.lens.slice().sort((a, b) => a - b);
    const q = (xs, f) => xs[Math.min(xs.length - 1, Math.floor(f * xs.length))];
    programs[p] = { program: p, notes: k.length, low: q(k, 0.02), high: q(k, 0.98), median: q(k, 0.5), len: q(l, 0.5) };
  }
  cache = { data, programs, breaks: Breaks.library() };
  return cache;
}

module.exports = { load };
