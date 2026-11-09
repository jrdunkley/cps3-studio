/* CONTROL for gate G4 (docs/plan/06_GATES.md): proves the yardstick, not the Studio. Not on the board.
 *
 *   node checks/gates/g4_control.js [code ...] [--quick]
 *
 * 1. Capcom's own bytes, put in the preview slot and played through lib.playBytes (request 60), are
 *    SOUND-IDENTICAL to lib.playCode(code) for every piece over G4's window (introduction and two passes
 *    of the loop, at most 240 s; --quick 40 s). So when G4 reports a difference, it is the rebuild's.
 *    (2026-10-02: 49 of 49 identical, 174 checks, about 70 s for the full run.) Negative control: one
 *    note of music 16 made softer is reported as a difference.
 * 2. The loop facts decomp.js must respect (wp/A4_decompile.md):
 *    - long-count main loops: these tracks end their loop with D4 126 (127 passes, then on) instead of
 *      D4 00; Seq.follow reports NO loop for them because the pass counter differs on every pass.
 *      Treated as looping forever (127 passes last a quarter of an hour or more);
 *    - the song loop (least common multiple of the track loop lengths, long-count tracks included) equals
 *      the longest track loop for every piece except music 12, which needs 9216 ticks (tracks loop every
 *      4608 and every 3072).
 * 3. Every piece written out to that loop stays far below the 64 KB preview slot (printed, not asserted:
 *    largest about 19.5 KB, music 37).
 */
'use strict';
const G = require('./lib.js');
const Seq = G.Seq;
const { check, done } = G.gate('G4 control');
const args = process.argv.slice(2), quick = args.includes('--quick');
const wanted = args.filter((a) => /^\d+$/.test(a)).map(Number);
const { data } = G.loadData();
const gcd = (a, b) => (b ? gcd(b, a % b) : a), lcm = (a, b) => a / gcd(a, b) * b;

/* 1-based track numbers whose main loop is D4 126 (measured 2026-10-02) */
const LONG_COUNT = { 12: [1, 2], 15: [9], 19: [10, 14], 45: [6, 9, 13, 14] };
const SONG_LOOP = { 12: 9216 };                   /* where the LCM is not the longest track loop */

let identical = 0, n = 0, largest = { bytes: 0 };
for (const song of data.songs) {
  if (wanted.length && !wanted.includes(song.code)) continue;
  n++;
  const info = G.Data.describe(song), frames = G.framesFor(info, 2, quick ? 2400 : 14400);
  const d = G.firstAudioDifference(G.audio(G.playCode(song.code), frames), G.audio(G.playBytes(song.bytes), frames));
  if (check(!d, `music ${song.code} (${song.name}): Capcom's own bytes from the preview slot differ from the original request at ${d && d.seconds} s (${d && d.side})`)) identical++;

  const longCount = [], lengths = [];
  let longest = 0;
  info.seq.tracks.forEach((ev, k) => {
    if (!ev) return;
    const f = Seq.follow(ev);
    const big = ev.filter((e) => e.k === 'cmd' && e.op >= 0xD4 && e.op <= 0xD7 && e.a[0] >= 100);
    if (big.length) {
      longCount.push(k + 1);
      check(big.every((e) => e.op === 0xD4 && e.a[0] === 126), `music ${song.code} track ${k + 1}: long counts are main-loop D4 126`);
      check(!f.loop, `music ${song.code} track ${k + 1}: Seq.follow reports no loop for a long-count track`);
      const g = Seq.follow(ev.map((e) => (big.includes(e) ? Object.assign({}, e, { a: [0] }) : e)));
      if (check(!!g.loop, `music ${song.code} track ${k + 1}: loops when its count is read as forever`)) lengths.push(g.loop.length);
    } else if (f.loop) { lengths.push(f.loop.length); longest = Math.max(longest, f.loop.length); }
  });
  check(JSON.stringify(longCount) === JSON.stringify(LONG_COUNT[song.code] || []), `music ${song.code}: long-count tracks [${longCount}] (expected [${LONG_COUNT[song.code] || []}])`);
  const songLoop = lengths.length ? lengths.reduce(lcm) : 0;
  longest = Math.max(longest, ...lengths);
  check(songLoop === (SONG_LOOP[song.code] || longest), `music ${song.code}: song loop ${songLoop} ticks (longest track loop ${longest})`);

  /* written-out size estimate over the song loop */
  if (songLoop) {
    const tracks = info.seq.tracks.filter(Boolean).map((ev) => Seq.follow(ev));
    const starts = tracks.filter((f) => f.loop).map((f) => f.loop.start);
    const end = (starts.length ? Math.max(...starts) : 0) + songLoop;
    const vlen = (v) => (v < 128 ? 1 : v < 16384 ? 2 : 3);
    let bytes = 33;
    for (const ev of info.seq.tracks.filter(Boolean)) {
      const f = Seq.follow(ev, end - 1, true);
      const evs = f.notes.map((x) => ({ t: x.t, s: 2 + vlen(x.len) })).concat(f.controls.map((c) => ({ t: c.t, s: 1 + (c.a ? c.a.length : 0) }))).sort((a, b) => a.t - b.t);
      let last = 0;
      for (const e of evs) { bytes += e.s + (e.t > last ? vlen(e.t - last) : 0); last = e.t; }
      bytes += 4;
    }
    if (bytes > largest.bytes) largest = { bytes, code: song.code };
  }
}
/* negative control: one note of music 16 a little softer must be reported as a difference */
{
  const song = data.songs.find((s) => s.code === 16), seq = Seq.decompile(song.bytes);
  const busiest = seq.tracks.filter(Boolean).sort((a, b) => b.filter((e) => e.k === 'note').length - a.filter((e) => e.k === 'note').length)[0];
  const note = busiest.filter((e) => e.k === 'note')[9];
  check(Seq.compile(seq).every((v, i) => v === song.bytes[i]), 'music 16: decompile and compile give back the same bytes (so the change below is the only one)');
  note.v = Math.max(1, note.v - 8);
  const d = G.firstAudioDifference(G.audio(G.playCode(16), 2400), G.audio(G.playBytes(Seq.compile(seq)), 2400));
  check(!!d, 'negative control: a single softer note in music 16 is reported as a difference');
}
done(`${identical} of ${n} pieces sound-identical from the preview slot; largest written-out piece about ${largest.bytes} bytes (music ${largest.code}) of the 65536-byte preview slot`);
