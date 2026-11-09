/* GATE G3 (docs/plan/06_GATES.md): nothing the user already made changes.
 *
 *   node checks/gates/g_v1_upgrade.js [--quick]
 *
 * Saved songs (lib.js savedSongs: the test songs in fixtures/songs, or STUDIO_SONGS) and the
 * arrangements list (data/library.js) are version-1 projects. For each:
 *   1. the version-1 builder (SF3Project.build, untouched) still produces the stored bytes exactly;
 *   2. SF3Compile.upgrade(project) gives a version-2 project, and SF3Compile.build of it is
 *      SOUND-IDENTICAL to the stored song (same stereo audio, sample for sample) for the introduction
 *      and one and a quarter passes of the loop, at most 200 s (--quick: 40 s);
 *   3. the same with { compress: true }; no song grows, and the saved songs together come to at most
 *      70 % of their stored size (a throwaway prototype of the planned method reached 59 %: 39 % to
 *      80 % per song);
 *   4. the upgraded project survives JSON and upgrade() leaves a version-2 project unchanged.
 * Exit 0 only when all pass. Exit 2 while the module does not exist yet.
 */
'use strict';
const path = require('path');
const G = require('./lib.js');
const Compile = G.need('js/compile.js');
const { check, done } = G.gate('G3 v1 upgrade');
const quick = process.argv.includes('--quick');
const same = (x, y) => x.length === y.length && x.every((v, i) => v === y[i]);
const BAR = G.Seq.BAR;

const items = G.savedSongs().map((s) => ({ name: s.file, project: s.project, bytes: s.bytes, mustShrink: true }));
try {
  require(path.join(G.root, 'data', 'library.js'));
  for (const it of (globalThis.SF3_LIBRARY || []).filter((x) => x.sequence).slice(0, quick ? 2 : 8))
    items.push({ name: `library: ${it.name}`, project: it.project, bytes: new Uint8Array(Buffer.from(it.sequence, 'base64')), mustShrink: false });
} catch (e) { /* no arrangements list on this machine */ }

let stored = 0, small = 0;
for (const it of items) {
  const p = it.project;
  const v1 = G.Project.build(JSON.parse(JSON.stringify(p)));
  check(same(v1.bytes, it.bytes), `${it.name}: the version-1 builder still gives the stored bytes`);
  const ticks = G.Seq.LEAD_IN + (p.loop.on ? p.loop.endBar * BAR + Math.round(0.25 * (p.loop.endBar - p.loop.startBar + 1) * BAR) : p.bars * BAR) + 96;
  const frames = Math.min(quick ? 2400 : 12000, Math.ceil(ticks * 256 / G.Seq.bpmToTempo(p.bpm)) + 30);
  let up, plain, packed;
  try {
    up = Compile.upgrade(JSON.parse(JSON.stringify(p)));
    plain = Compile.build(up, { compress: false });
    packed = Compile.build(up, { compress: true });
  } catch (e) { check(false, `${it.name}: ${e.message}`); continue; }
  check(up.format === 'sf3project' && up.version === 2, `${it.name}: upgraded to version 2`);
  const want = G.audio(G.playBytes(it.bytes), frames);
  const d1 = G.firstAudioDifference(want, G.audio(G.playBytes(plain.bytes), frames));
  check(!d1, `${it.name}: the upgraded song differs from the stored one at ${d1 && d1.seconds} s (frame ${d1 && d1.frame}, ${d1 && d1.side})`);
  const d2 = G.firstAudioDifference(want, G.audio(G.playBytes(packed.bytes), frames));
  check(!d2, `${it.name}: the compressed song differs at ${d2 && d2.seconds} s`);
  check(packed.bytes.length <= plain.bytes.length && packed.bytes.length <= it.bytes.length, `${it.name}: compression does not grow the song (${it.bytes.length} stored, ${plain.bytes.length} plain, ${packed.bytes.length} compressed)`);
  if (it.mustShrink) { stored += it.bytes.length; small += packed.bytes.length; }
  const twice = Compile.upgrade(JSON.parse(JSON.stringify(up)));
  check(JSON.stringify(twice) === JSON.stringify(up), `${it.name}: upgrade() leaves a version-2 project unchanged`);
  check(same(Compile.build(JSON.parse(JSON.stringify(up)), { compress: false }).bytes, plain.bytes), `${it.name}: same bytes after a JSON round trip`);
}
if (stored) check(small <= stored * 0.7, `the saved songs together: ${small} of ${stored} bytes compressed (limit 70 %)`);
done(`${items.length} songs; the saved songs ${stored} bytes stored, ${small} compressed`);
