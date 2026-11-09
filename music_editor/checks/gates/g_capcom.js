/* GATE G4 (docs/plan/06_GATES.md): the Studio's song model can say everything Capcom's music says.
 *
 *   node checks/gates/g_capcom.js [code ...] [--quick]
 *
 * For every piece of music in the ROM (49), or the codes given:
 *   1. SF3Decomp.fromGame(song, info) opens it as an ordinary editable version-2 project;
 *   2. SF3Compile.build(project, { compress: false }) builds it again;
 *   3. the rebuilt sequence is SOUND-IDENTICAL to the original (checks/gates/lib.js: same stereo audio,
 *      sample for sample) for the introduction and two passes of the loop (pieces that play once: to the
 *      end), at most 240 s (--quick: 40 s);
 *   4. the project survives JSON (build of JSON.parse(JSON.stringify(project)) gives the same bytes);
 *   5. with { compress: true } it is still sound-identical, and over the 34 stage themes (codes 10..43)
 *      the compressed builds total at most 1.35 times Capcom's own bytes.
 * Exit 0 only when all pass. Exit 2 while the modules do not exist yet.
 */
'use strict';
const G = require('./lib.js');
const Compile = G.need('js/compile.js');
const Decomp = G.need('js/decomp.js');
const { check, done } = G.gate('G4 capcom');
const args = process.argv.slice(2), quick = args.includes('--quick');
const wanted = args.filter((a) => /^\d+$/.test(a)).map(Number);
const { data } = G.loadData();
const same = (x, y) => x.length === y.length && x.every((v, i) => v === y[i]);

let capcomBytes = 0, plainBytes = 0, smallBytes = 0, identical = 0;
for (const song of data.songs) {
  if (wanted.length && !wanted.includes(song.code)) continue;
  const info = G.Data.describe(song), frames = G.framesFor(info, 2, quick ? 2400 : 14400);
  let project, plain, small;
  try {
    project = Decomp.fromGame(song, info);
    plain = Compile.build(project, { compress: false });
    small = Compile.build(project, { compress: true });
  } catch (e) { check(false, `music ${song.code} (${song.name}): ${e.message}`); continue; }
  check(project.format === 'sf3project' && project.version === 2 && Array.isArray(project.parts) && project.parts.length <= 16, `music ${song.code}: a version-2 project of at most 16 parts`);
  const original = G.audio(G.playCode(song.code), frames);
  const d1 = G.firstAudioDifference(original, G.audio(G.playBytes(plain.bytes), frames));
  if (check(!d1, `music ${song.code} (${song.name}): rebuilt copy differs from Capcom's at ${d1 && d1.seconds} s (frame ${d1 && d1.frame}, ${d1 && d1.side})`)) identical++;
  const d2 = G.firstAudioDifference(original, G.audio(G.playBytes(small.bytes), frames));
  check(!d2, `music ${song.code}: compressed build differs at ${d2 && d2.seconds} s`);
  const again = Compile.build(JSON.parse(JSON.stringify(project)), { compress: false });
  check(same(again.bytes, plain.bytes), `music ${song.code}: the project builds to the same bytes after a JSON round trip`);
  check(small.bytes.length <= plain.bytes.length, `music ${song.code}: compression does not grow the song (${plain.bytes.length} -> ${small.bytes.length})`);
  if (song.code >= 10 && song.code <= 43) { capcomBytes += song.bytes.length; plainBytes += plain.bytes.length; smallBytes += small.bytes.length; }
}
if (!wanted.length) check(smallBytes <= capcomBytes * 1.35, `stage themes: compressed ${smallBytes} bytes against Capcom's ${capcomBytes} (limit x1.35 = ${Math.round(capcomBytes * 1.35)})`);
done(`${identical} pieces sound-identical; stage themes ${capcomBytes} bytes by Capcom, ${plainBytes} rebuilt plain, ${smallBytes} compressed`);
