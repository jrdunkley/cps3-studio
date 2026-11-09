/* Capcom's production techniques, measured over every piece of music (node style/techniques.js).
 * Reads the sequences (not audio) for the introduction and one pass of each loop, and finds:
 *  - copies: a track that plays another track's notes again, shifted by a fixed number of ticks
 *    (a double when the shift is small, an echo when it is longer), with its level and pan;
 *  - glides: runs of detune (C3) commands within a note: units of 24/256 semitone, signed;
 *  - pan moves: pan (C7) changed between notes of one track;
 *  - holds: notes of 2 bars or more (pads, drones);
 *  - roles: what each track does (kit/slices, bass, pad, lead, chord) by program and range.
 * Writes out/style/techniques.json and techniques.txt; prints the summary.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
require(path.join(root, 'data', 'pack.js'));
const { Engine } = require(path.join(root, 'js', 'engine.js'));
const Seq = require(path.join(root, 'js', 'seq.js'));
const Data = require(path.join(root, 'js', 'gamedata.js'));
const OUT = path.join(root, 'out', 'style');
fs.mkdirSync(OUT, { recursive: true });
const pack = globalThis.SF3_PACK;
const data = Data.load(new Engine(pack), pack.names);
const s8 = (v) => (v << 24) >> 24;

/* a track followed with its running settings attached to every note */
function trackNotes(events, end) {
  const f = Seq.follow(events, end - 1, true);
  const controls = f.controls.slice().sort((a, b) => a.t - b.t);
  const st = { bank: 0, program: -1, volume: -1, expression: -1, pan: -1, detune: 0 };
  const notes = [], glides = [], pans = [];
  let ci = 0, last = null;
  const run = [];
  for (const n of f.notes) {
    const detunes = [];
    while (ci < controls.length && controls[ci].t <= n.t) {
      const c = controls[ci++];
      if (c.op === 0xC2) st.bank = c.a[0] & 15; else if (c.op === 0xC4) st.program = c.a[0];
      else if (c.op === 0xC6) st.volume = c.a[0]; else if (c.op === 0xC8) st.expression = c.a[0];
      else if (c.op === 0xC7) { if (last && st.pan !== c.a[0]) pans.push(c.a[0]); st.pan = c.a[0]; }
      else if (c.op === 0xC3) { st.detune = s8(c.a[0]); if (last && c.t > last.t) detunes.push({ t: c.t, v: s8(c.a[0]) }); }
    }
    /* detune commands that fell inside the previous note: a glide on that note */
    if (last && detunes.length) glides.push({ program: last.program, from: detunes[0].v, steps: detunes.length, ticks: detunes[detunes.length - 1].t - detunes[0].t, at: detunes[0].t - last.t, n: last.n });
    last = Object.assign({ t: n.t, n: n.n, len: n.len, v: n.v }, st);
    notes.push(last);
  }
  /* detune commands after the last note */
  const tail = controls.slice(ci).filter((c) => c.op === 0xC3);
  if (last && tail.length) glides.push({ program: last.program, from: s8(tail[0].a[0]), steps: tail.length, ticks: tail[tail.length - 1].t - tail[0].t, at: tail[0].t - last.t, n: last.n });
  void run;
  return { notes, glides, pans };
}

/* B copies A shifted by d ticks (0 < d <= 96): most of B's notes are A's notes moved by d, same key or
 * a fixed interval. A repeating pattern matches at several shifts; the shortest one wins, so a
 * 2-tick double is not mistaken for a 190-tick echo of the other track. */
function copyOf(a, b) {
  if (a.notes.length < 4 || b.notes.length < 4) return null;
  const votes = new Map();
  for (const nb of b.notes) {
    for (const na of a.notes) {
      const d = nb.t - na.t;
      if (d <= 0 || d > 96) continue;
      const k = d * 256 + (nb.n - na.n + 128);
      votes.set(k, (votes.get(k) || 0) + 1);
    }
  }
  let top = 0;
  for (const v of votes.values()) top = Math.max(top, v);
  const best = { d: 1e9, hits: 0, interval: 0 };
  for (const [k, v] of votes) if (v >= top * 0.95 && (k >> 8) < best.d) { best.hits = v; best.d = k >> 8; best.interval = (k & 255) - 128; }
  const share = best.hits / Math.max(a.notes.length, b.notes.length);
  if (share < 0.6) return null;
  return { delay: best.d, interval: best.interval, share: +share.toFixed(2) };
}

const median = (xs) => { if (!xs.length) return null; const s = xs.slice().sort((p, q) => p - q); return s[Math.floor(s.length / 2)]; };
const report = [];
const all = { copies: [], glides: [], pans: 0, panTracks: 0, holds: [], tracks: 0, roles: [] };
for (const song of data.songs) {
  const info = Data.describe(song);
  if (!info.loopLength || info.bars < 4) continue;                       // fighting and long pieces only
  const end = info.loopStart + info.loopLength;
  const tracks = [];
  info.seq.tracks.forEach((events, k) => { if (events) { const t = trackNotes(events, end); t.k = k; if (t.notes.length) tracks.push(t); } });
  /* pairs in order of how short the shift is; a copy's source must be an original track, so a
   * chain of echoes is read as copies of the first */
  const copies = [], isCopy = new Set(), cands = [];
  for (const b of tracks) for (const a of tracks) if (a !== b) { const c = copyOf(a, b); if (c) cands.push(Object.assign({ source: a.k, track: b.k }, c)); }
  cands.sort((p, q) => p.delay - q.delay || q.share - p.share);
  const vol = (t) => median(t.notes.map((n) => n.volume)), expr = (t) => median(t.notes.map((n) => n.expression));
  const pan = (t) => median(t.notes.map((n) => n.pan)), prog = (t) => median(t.notes.map((n) => n.program));
  for (const found of cands) {
    if (isCopy.has(found.track) || isCopy.has(found.source) || copies.some((c) => c.source === found.track)) continue;
    const a = tracks.find((t) => t.k === found.source), b = tracks.find((t) => t.k === found.track);
    found.levelRatio = +((vol(b) * expr(b)) / Math.max(1, vol(a) * expr(a))).toFixed(2);
    found.pans = [pan(a), pan(b)];
    found.sameProgram = prog(a) === prog(b);
    found.program = prog(a);
    found.kind = found.delay <= 4 ? 'double' : 'echo';
    found.ms = Math.round(found.delay / 48 * 60000 / info.bpm);
    copies.push(found); isCopy.add(b.k);
  }
  /* what each original track does */
  for (const t of tracks) {
    const p = prog(t), lens = t.notes.map((n) => n.len), keys = t.notes.map((n) => n.n);
    all.roles.push({ song: song.code, track: t.k, program: p, notes: t.notes.length, key: median(keys), low: Math.min(...keys), high: Math.max(...keys),
                     len: median(lens), volume: vol(t), expression: expr(t), pan: pan(t), copy: isCopy.has(t.k),
                     echoed: copies.some((c) => c.source === t.k && c.kind === 'echo'), glides: t.glides.length, panMoves: t.pans.length, bpm: info.bpm });
  }
  let pans = 0, panTracks = 0;
  for (const t of tracks) {
    all.glides.push(...t.glides.map((g) => Object.assign({ song: song.code }, g)));
    if (t.pans.length > t.notes.length * 0.2) { panTracks++; pans += t.pans.length; }
    for (const n of t.notes) if (n.len >= 384) all.holds.push({ song: song.code, program: n.program, len: n.len, expression: n.expression, volume: n.volume });
  }
  all.copies.push(...copies.map((c) => Object.assign({ song: song.code }, c)));
  all.pans += pans; all.panTracks += panTracks; all.tracks += tracks.length;
  report.push(`${String(song.code).padStart(2)} ${song.name.padEnd(36)} ${info.bpm.toFixed(0)} BPM ${String(tracks.length).padStart(2)} tracks: ` +
    `${copies.filter((c) => c.kind === 'double').length} doubles, ${copies.filter((c) => c.kind === 'echo').length} echoes ` +
    `[${copies.map((c) => `${c.source + 1}->${c.track + 1} d${c.delay}${c.interval ? ` i${c.interval}` : ''} x${c.levelRatio} p${c.pans.join('/')}`).join(', ')}], ` +
    `${tracks.reduce((s, t) => s + t.glides.length, 0)} glides, ${panTracks} auto-pan tracks`);
}

/* summary */
const sum = [];
const echoes = all.copies.filter((c) => c.kind === 'echo'), doubles = all.copies.filter((c) => c.kind === 'double');
const hist = (xs) => { const m = new Map(); for (const x of xs) m.set(x, (m.get(x) || 0) + 1); return Array.from(m.entries()).sort((a, b) => b[1] - a[1]); };
sum.push(`Pieces studied: ${report.length}, tracks ${all.tracks}; copies ${all.copies.length} (${doubles.length} doubles, ${echoes.length} echoes)`);
sum.push(`Echo delay in ticks (48 = beat), most common: ${hist(echoes.map((c) => c.delay)).slice(0, 14).map(([d, n]) => `${d}x${n}`).join(' ')}`);
sum.push(`Echo delay in ms (to 20): ${hist(echoes.map((c) => Math.round(c.ms / 20) * 20)).slice(0, 14).map(([d, n]) => `${d}x${n}`).join(' ')}`);
sum.push(`Double delay in ticks: ${hist(doubles.map((c) => c.delay)).map(([d, n]) => `${d}x${n}`).join(' ')}`);
sum.push(`Echo level ratio (vol*expr vs source): median ${median(echoes.map((c) => c.levelRatio))}, quartiles ${[0.25, 0.75].map((q) => { const s = echoes.map((c) => c.levelRatio).sort((a, b) => a - b); return s[Math.floor(q * s.length)]; }).join(' / ')}`);
sum.push(`Double level ratio: median ${median(doubles.map((c) => c.levelRatio))}`);
sum.push(`Echo transposed: ${echoes.filter((c) => c.interval).length}; different program: ${echoes.filter((c) => !c.sameProgram).length}`);
sum.push(`Echo pans (source/echo): ${hist(echoes.map((c) => c.pans.join('/'))).slice(0, 12).map(([d, n]) => `${d}x${n}`).join(' ')}`);
sum.push(`Double pans: ${hist(doubles.map((c) => c.pans.join('/'))).slice(0, 10).map(([d, n]) => `${d}x${n}`).join(' ')}`);
sum.push(`Echoed programs: ${hist(echoes.map((c) => c.program)).map(([d, n]) => `${d}x${n}`).join(' ')}`);
sum.push(`Doubled programs: ${hist(doubles.map((c) => c.program)).map(([d, n]) => `${d}x${n}`).join(' ')}`);
sum.push(`Glides: ${all.glides.length}; start offset (units of 24/256 st): ${hist(all.glides.map((g) => g.from)).slice(0, 16).map(([d, n]) => `${d}x${n}`).join(' ')}`);
sum.push(`Glide length in ticks: ${hist(all.glides.map((g) => g.ticks)).slice(0, 12).map(([d, n]) => `${d}x${n}`).join(' ')}; steps: ${hist(all.glides.map((g) => g.steps)).slice(0, 8).map(([d, n]) => `${d}x${n}`).join(' ')}`);
sum.push(`Glide starts after note-on (ticks): ${hist(all.glides.map((g) => g.at)).slice(0, 10).map(([d, n]) => `${d}x${n}`).join(' ')}`);
sum.push(`Glided programs: ${hist(all.glides.map((g) => g.program)).map(([d, n]) => `${d}x${n}`).join(' ')}`);
sum.push(`Auto-pan tracks: ${all.panTracks} of ${all.tracks}`);
sum.push(`Holds of 2+ bars: ${all.holds.length}; programs ${hist(all.holds.map((h) => h.program)).map(([d, n]) => `${d}x${n}`).join(' ')}; lengths ${hist(all.holds.map((h) => h.len)).slice(0, 6).map(([d, n]) => `${d}x${n}`).join(' ')}`);
/* per program: how Capcom's original (non-copy) tracks use it */
const roleLines = ['', 'Program use by original tracks: tracks songs | key median (low-high) | note length median | vol expr | echoed glided auto-panned'];
const byProg = new Map();
for (const r of all.roles) { if (r.copy) continue; if (!byProg.has(r.program)) byProg.set(r.program, []); byProg.get(r.program).push(r); }
for (const [p, rs] of Array.from(byProg.entries()).sort((a, b) => a[0] - b[0])) {
  roleLines.push(`  ${String(p).padStart(2)}: ${String(rs.length).padStart(3)} ${String(new Set(rs.map((r) => r.song)).size).padStart(3)} | ${String(median(rs.map((r) => r.key))).padStart(3)} (${Math.min(...rs.map((r) => r.low))}-${Math.max(...rs.map((r) => r.high))}) | ${String(median(rs.map((r) => r.len))).padStart(4)} | ${String(median(rs.map((r) => r.volume))).padStart(3)} ${String(median(rs.map((r) => r.expression))).padStart(3)} | ` +
    `${rs.filter((r) => r.echoed).length} ${rs.filter((r) => r.glides).length} ${rs.filter((r) => r.panMoves > r.notes * 0.2).length}`);
}
sum.push(...roleLines);
fs.writeFileSync(path.join(OUT, 'techniques.json'), JSON.stringify(all));
fs.writeFileSync(path.join(OUT, 'techniques.txt'), sum.concat([''], report).join('\n'));
console.log(sum.join('\n'));
console.log('');
console.log(report.join('\n'));
