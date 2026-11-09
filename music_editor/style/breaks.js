/* Capcom's breakbeat programming as a library (node style/breaks.js prints it).
 * A break kit is a one-bar drum loop cut into slices, one per key, each about an 8th note long at
 * the kit's own tempo (style/sounds.js). Capcom plays the slices as notes, mostly 24 ticks apart.
 * This collects every bar of break programming in the game's music (intro and one loop pass),
 * per kit, and gives each key a role from where Capcom puts it in the bar (on the beat, on the
 * backbeat 2 and 4, or between) together with what the slice sounds like at its start.
 *
 * library(): { kits: { program: { tempo, keys: { key: { role, kick, snare, sound, uses } }, patterns: [...] } } }
 * A pattern: { song, bars: 1, notes: [{ t, n, len, v }] } with t in ticks from the bar start.
 */
'use strict';
const path = require('path');
const root = path.join(__dirname, '..');
if (!globalThis.SF3_PACK) require(path.join(root, 'data', 'pack.js'));
const { Engine } = require(path.join(root, 'js', 'engine.js'));
const Seq = require(path.join(root, 'js', 'seq.js'));
const Data = require(path.join(root, 'js', 'gamedata.js'));
const Sounds = require('./sounds.js');

const BREAK_KITS = [0, 1, 2, 3, 4, 10, 11, 12, 13];

function library() {
  const pack = globalThis.SF3_PACK;
  const data = Data.load(new Engine(pack), pack.names);
  const kits = {};
  for (const k of BREAK_KITS) kits[k] = { program: k, keys: {}, patterns: [], songs: new Set() };
  for (const song of data.songs) {
    const info = Data.describe(song);
    if (!info.loopLength) continue;
    const end = info.loopStart + info.loopLength;
    info.seq.tracks.forEach((events) => {
      if (!events) return;
      const f = Seq.follow(events, end - 1, true);
      const ctl = f.controls.slice().sort((a, b) => a.t - b.t);
      let ci = 0, prog = -1;
      const bars = new Map();
      for (const n of f.notes) {
        while (ci < ctl.length && ctl[ci].t <= n.t) { const c = ctl[ci++]; if (c.op === 0xC4) prog = c.a[0]; }
        if (!(prog in kits)) continue;
        const t = n.t - info.lead, bar = Math.floor(t / Seq.BAR);
        if (t < 0) continue;
        const key = `${prog}:${bar}`;
        if (!bars.has(key)) bars.set(key, { prog, notes: [] });
        bars.get(key).notes.push({ t: t - bar * Seq.BAR, n: n.n, len: n.len, v: n.v });
        const kk = kits[prog].keys[n.n] || (kits[prog].keys[n.n] = { uses: 0, steps: new Array(8).fill(0), off: 0 });
        kk.uses++;
        const pos = t % Seq.BAR;
        if (pos % 24 < 3 || pos % 24 > 21) kk.steps[Math.round(pos / 24) % 8]++; else kk.off++;
      }
      for (const b of bars.values()) {
        const kit = kits[b.prog];
        kit.songs.add(song.code);
        const sig = b.notes.map((x) => `${x.t}:${x.n}:${x.len}`).join(' ');
        if (!kit.patterns.some((p) => p.sig === sig)) kit.patterns.push({ song: song.code, bpm: +info.bpm.toFixed(1), sig, notes: b.notes });
      }
    });
  }
  /* what each key's slice sounds like, and the kit's own tempo from its slice lengths */
  for (const k of BREAK_KITS) {
    const kit = kits[k], p = data.banks[0][k];
    const lens = [];
    for (const r of p.live) {
      const s = data.samples[r.sample];
      for (let key = Math.max(r.keyLow, 36); key <= Math.min(r.keyHigh, 72); key++) {
        if (r.keyLow < 36 && key !== r.keyHigh) continue;                      // the catch-all low region: only its top key
        const note = key;                                                      // kits play each key at its own note
        const rate = Sounds.ROOT_RATE * Math.pow(2, (note - s.root) / 12);
        const m = Sounds.slice(s, rate);
        const kk = kit.keys[key] || (kit.keys[key] = { uses: 0, steps: new Array(8).fill(0), off: 0 });
        Object.assign(kk, { sample: r.sample, seconds: m.seconds, sound: m.label, low: m.low, mid: m.mid, high: m.high, level: m.level });
        if (key >= 41 && key <= 48) lens.push(m.seconds);
      }
    }
    lens.sort((a, b) => a - b);
    const slice = lens.length ? lens[Math.floor(lens.length / 2)] : 0;
    kit.sliceSeconds = slice;
    /* program 10 holds beat-long pieces; 13 has 8th slices on 41-48 and beat pieces from 49 */
    kit.tempo = k === 10 ? Math.round(60 / 0.47 * 10) / 10 : Math.round(60 / (2 * slice) * 10) / 10;
    /* roles: Capcom's placement first, the sound second */
    for (const [key, kk] of Object.entries(kit.keys)) {
      const on = kk.steps[0] + kk.steps[4], back = kk.steps[2] + kk.steps[6], between = kk.steps[1] + kk.steps[3] + kk.steps[5] + kk.steps[7] + kk.off;
      const total = on + back + between;
      kk.kick = +(((kk.low || 0) * 0.6 + (total ? on / total : 0) * 0.4)).toFixed(2);
      kk.snare = +(((kk.sound === 'S' ? 0.6 : (kk.mid || 0) + (kk.high || 0) * 0.5) * 0.6 + (total ? back / total : 0) * 0.4)).toFixed(2);
      kk.role = total >= 8 && back / total > 0.5 ? 'snare' : total >= 8 && on / total > 0.5 && (kk.low || 0) > 0.4 ? 'kick'
        : kk.sound === 'K' && (kk.low || 0) >= 0.55 ? 'kick' : kk.sound === 'S' ? 'snare' : 'ghost';
      kk.key = Number(key);
    }
    kit.songs = Array.from(kit.songs);
  }
  return { kits };
}

module.exports = { library, BREAK_KITS };

if (require.main === module) {
  const lib = library();
  for (const k of BREAK_KITS) {
    const kit = lib.kits[k];
    console.log(`\nkit ${k}: tempo ${kit.tempo} (slice ${kit.sliceSeconds}s), songs ${kit.songs.join(',')}, ${kit.patterns.length} distinct bars`);
    for (const kk of Object.values(kit.keys).sort((a, b) => a.key - b.key)) {
      if (!kk.uses && kk.key > 49) continue;
      console.log(`   key ${kk.key}: ${kk.role.padEnd(5)} sound ${kk.sound || '?'} low ${(kk.low || 0).toFixed(2)} used ${String(kk.uses).padStart(4)} steps ${kk.steps.join(',')} off ${kk.off}`);
    }
    for (const p of kit.patterns.slice(0, 4)) console.log(`   [${p.song} ${p.bpm}] ${p.notes.map((x) => `${(x.t / 24).toFixed(x.t % 24 ? 1 : 0)}:${x.n}`).join(' ')}`);
  }
}
