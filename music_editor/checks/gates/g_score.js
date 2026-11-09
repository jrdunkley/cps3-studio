/* GATE G8 (docs/plan/06_GATES.md, wp/A7_score.md): the whole project as readable text and back.
 *
 *   node checks/gates/g_score.js
 *
 *   1. Round trip: parse(print(p)) deep-equals SF3Compile.normalize(p) (ui aside) and the tempo word survives
 *      (Seq.bpmToTempo of both bpm values is the same, and the numbers are identical), for
 *        - SF3Project.fromGame of each of the 49 Capcom pieces, upgraded (and, once js/decomp.js exists,
 *          SF3Decomp projects of all 49 as well; a note is printed while it does not),
 *        - the user's saved songs, every project in data/library.js,
 *        - the three hand-written fixtures (checks/gates/fixtures/*.sf3score),
 *        - hand-made edge projects with every version-2 field, and 300 seeded random projects (including values the
 *          grammar cannot say, which must go through `json` lines).
 *      Printing twice gives the same text, and printing what was parsed gives the same text again.
 *   2. Shape: no part of the real projects falls back to `json notes` (they stay readable bar lines); kit parts print
 *      raw keys (#41), pitched parts print sharps; one exact golden text pins the canonical spelling.
 *   3. The three fixtures say what they were written to say (counts, ticks, velocities, extras, lanes, device).
 *   4. Six malformed scores (fixtures/bad_*.sf3score) raise ScoreError with exactly this line, column, part, bar,
 *      token and message; so do a few smaller malformed texts.
 * Exit 0 only when all pass. Exit 2 while js/score.js does not exist yet.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const G = require('./lib.js');
const Score = G.need('js/score.js');
const Compile = G.need('js/compile.js');
const { check, done } = G.gate('G8 score');
const Seq = G.Seq;
const FIX = path.join(__dirname, 'fixtures');
const clone = (x) => JSON.parse(JSON.stringify(x));
const stripUi = (p) => { const q = clone(p); delete q.ui; return q; };

/* ---- an independent deep comparison that says where ---------------------------------------------- */
function firstDiff(a, b, where) {
  if (a === b) return null;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return `${where}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
  if (Array.isArray(a) !== Array.isArray(b)) return `${where}: array vs object`;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return `${where}: length ${a.length} vs ${b.length}`;
    for (let i = 0; i < a.length; i++) { const d = firstDiff(a[i], b[i], `${where}[${i}]`); if (d) return d; }
    return null;
  }
  const keys = new Set(Object.keys(a).concat(Object.keys(b)));
  for (const k of keys) {
    if (!(k in a)) return `${where}.${k}: missing on the left`;
    if (!(k in b)) return `${where}.${k}: missing on the right`;
    const d = firstDiff(a[k], b[k], `${where}.${k}`);
    if (d) return d;
  }
  return null;
}

const { data } = G.loadData();
const stats = { texts: 0, chars: 0, jsonNotes: 0, jsonOrder: 0, lines: 0, parts: 0, notes: 0 };

/* print -> parse -> compare; `real` projects must also stay readable */
function roundTrip(label, project, real) {
  let text, back, want;
  try {
    want = stripUi(Compile.normalize(project));
    text = Score.print(project, { banks: data.banks });
    back = stripUi(Score.parse(text));
  } catch (e) { check(false, `${label}: ${e.message}`); return null; }
  const d = firstDiff(want, back, 'project');
  check(!d, `${label}: parse(print(p)) differs from normalize(p) at ${d}`);
  check(Seq.bpmToTempo(back.bpm) === Seq.bpmToTempo(want.bpm) && back.bpm === want.bpm, `${label}: tempo ${want.bpm} came back as ${back.bpm}`);
  let again;
  try { again = Score.print(project, { banks: data.banks }); } catch (e) { again = `error ${e.message}`; }
  check(again === text, `${label}: printing twice gives different text`);
  let third;
  try { third = Score.print(Score.parse(text), { banks: data.banks }); } catch (e) { third = `error ${e.message}`; }
  check(third === text, `${label}: print(parse(print(p))) is not the same text`);
  stats.texts++; stats.chars += text.length; stats.parts += back.parts.length;
  stats.lines += text.split('\n').length;
  for (const p of back.parts) stats.notes += p.notes.length;
  const jn = (text.match(/^ *json notes:/gm) || []).length, jo = (text.match(/^ *json order:/gm) || []).length;
  if (real) {
    check(jn === 0, `${label}: ${jn} part(s) fell back to "json notes" instead of bar lines`);
    check(jo === 0, `${label}: ${jo} part(s) needed "json order"`);
    stats.jsonNotes += jn; stats.jsonOrder += jo;
  }
  return text;
}

/* ---- the real projects ----------------------------------------------------------------------------- */
const capcom = data.songs.map((song) => ({ song, info: G.Data.describe(song) }));
check(capcom.length === 49, `49 Capcom pieces expected, found ${capcom.length}`);
for (const { song, info } of capcom) {
  roundTrip(`Capcom ${song.code} (${song.name}) copy`, Compile.upgrade(G.Project.fromGame(song, info)), true);
}
const decompFile = path.join(G.root, 'js', 'decomp.js');
if (fs.existsSync(decompFile)) {
  const Decomp = require(decompFile);
  let n = 0;
  for (const { song, info } of capcom) {
    let project;
    try { project = Decomp.fromGame(song, info); } catch (e) { check(false, `Decomp ${song.code}: ${e.message}`); continue; }
    roundTrip(`Decomp ${song.code} (${song.name})`, project, false);
    n++;
  }
  console.log(`js/decomp.js found: ${n} of 49 richer projects round-tripped`);
} else console.log('NOTE: js/decomp.js does not exist yet; the SF3Decomp projects of the 49 pieces are not round-tripped (do it again when A4 lands)');

for (const s of G.savedSongs()) roundTrip(`saved song ${s.file}`, s.project, true);
try { require(path.join(G.root, 'data', 'library.js')); } catch (e) { console.log('NOTE: data/library.js not loadable: ' + e.message); }
const library = globalThis.SF3_LIBRARY || [];
for (const it of library) roundTrip(`library ${it.file}`, it.project, true);
check(library.length > 0 || !fs.existsSync(path.join(G.root, 'data', 'library.js')), 'data/library.js lists no projects');

/* ---- the fixtures ----------------------------------------------------------------------------------- */
const fixture = (name) => fs.readFileSync(path.join(FIX, name), 'utf8');
const fixtures = {};
for (const name of ['groove', 'break', 'pad']) {
  let project;
  try { project = Score.parse(fixture(`${name}.sf3score`)); } catch (e) { check(false, `fixture ${name}: ${e.message}`); continue; }
  fixtures[name] = project;
  roundTrip(`fixture ${name}`, project, true);
}
const NT = (p, i) => p.parts[i].notes;
const col = (notes, k) => notes.map((n) => n[k]);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
if (fixtures.groove) {
  const p = fixtures.groove;
  check(p.name === 'Night Drive' && p.author === 'Test Writer' && p.bpm === 118 && p.bars === 8 && p.markerBars === 2, 'groove: header');
  check(p.loop.on && p.loop.startBar === 1 && p.loop.endBar === 8 && p.loop.start === 0 && p.loop.end === 1536, 'groove: loop 1-8');
  check(same(p.key, { root: 9, scale: 'minor' }) && same(p.sections, [{ bar: 1, name: 'Intro' }, { bar: 5, name: 'Verse' }]), 'groove: key and sections');
  check(same(p.parts.map((x) => x.name), ['Bass', 'Keys', 'Lead', 'Drums']) && same(p.parts.map((x) => x.program), [20, 2, 43, 1]) && same(p.parts.map((x) => x.voices), [1, 3, 1, 1])
        && same(p.parts.map((x) => x.role), ['bass', 'chords', 'lead', 'drums']), 'groove: four parts with their words');
  const [bass, keys, lead, drums] = [NT(p, 0), NT(p, 1), NT(p, 2), NT(p, 3)];
  check(same([bass.length, keys.length, lead.length, drums.length], [35, 27, 20, 60]), `groove: note counts ${[bass.length, keys.length, lead.length, drums.length]}`);
  check(same(col(bass.slice(0, 7), 't'), [0, 24, 48, 72, 96, 144, 168]) && same(col(bass.slice(0, 7), 'n'), [40, 40, 43, 45, 47, 45, 43]) && same(col(bass.slice(0, 7), 'len'), [24, 24, 24, 24, 48, 24, 24])
        && bass.slice(0, 7).every((n) => n.v === 100), 'groove: bass bar 1');
  check(same(bass.slice(14, 19).map((n) => [n.t, n.n, n.len]), [[384, 40, 24], [432, 52, 12], [444, 52, 12], [480, 50, 24], [504, 47, 72]]), 'groove: bass bar 3 (rests, sticky lengths, dotted)');
  check(same(bass.slice(19, 24).map((n) => n.t), [576, 624, 636, 672, 696]) && same(bass.slice(24, 35).map((n) => [n.t, n.n, n.len]),
        [[768, 40, 48], [816, 40, 48], [864, 43, 48], [912, 45, 48], [960, 40, 48], [1008, 40, 48], [1056, 43, 48], [1104, 45, 48], [1152, 40, 96], [1248, 43, 96], [1344, 45, 192]]),
        'groove: bass % repeats and bars 5-8');
  check(same(keys.slice(0, 3).map((n) => [n.t, n.n, n.len, n.v]), [[0, 52, 96, 100], [0, 48, 96, 100], [0, 45, 96, 100]]), 'groove: chord notes come highest first');
  check(same(keys.filter((n) => n.t === 576).map((n) => [n.n, n.len, n.v]), [[47, 192, 90], [44, 192, 90], [40, 192, 90]]), 'groove: chord with its own length and velocity');
  check(same(keys.filter((n) => n.t >= 768).map((n) => [n.t, n.n, n.len, n.v]), [[768, 52, 384, 100], [768, 48, 384, 100], [768, 45, 384, 100], [1152, 48, 384, 100], [1152, 45, 384, 100], [1152, 41, 384, 100]]), 'groove: chords longer than their bar');
  check(same(lead.slice(0, 8).map((n) => n.n), [69, 72, 76, 74, 72, 71, 72, 69]) && lead[0].t === 384 && same(lead.slice(8, 12).map((n) => [n.t, n.n, n.len]), [[576, 76, 72], [648, 74, 24], [672, 72, 48], [720, 71, 48]]), 'groove: lead bars 3-4');
  check(lead[12].tie === true && lead[12].t === 768 && lead[12].len === 96 && lead[13].cents === -14 && lead[13].pan === 20 && lead[13].t === 864 && !('tie' in lead[13]), 'groove: slur and {cents pan} extras');
  check(lead[14].v === 80 && lead[15].tie === true && lead[15].v === 100 && lead[17].slide === 40 && lead[17].t === 1104 && lead[18].t === 1248 && lead[18].len === 96, 'groove: velocities, slide, rest then note');
  check(lead[19].t === 1344 && lead[19].len === 192 && same(lead[19].bend, [[0, 2], [24, -3]]), 'groove: bend extra');
  check(same(col(drums.slice(0, 8), 'n'), [36, 42, 38, 42, 36, 36, 38, 42]) && same(col(drums.slice(0, 8), 'v'), [110, 70, 100, 70, 110, 110, 110, 70]), 'groove: drum bar 1 keys and sticky velocities');
  check(same(drums.slice(24, 35).map((n) => [n.t, n.n, n.len, n.v]), [[576, 38, 12, 100], [588, 38, 12, 100], [600, 38, 12, 100], [612, 38, 12, 100], [624, 45, 12, 100], [636, 45, 12, 100], [648, 47, 12, 100], [660, 47, 12, 100], [672, 48, 24, 100], [696, 48, 24, 100], [720, 49, 48, 100]]), 'groove: drum fill');
  check(drums[59].t === 1344 && drums[59].v === 127 && drums[59].len === 192, 'groove: last crash');
}
if (fixtures.break) {
  const p = fixtures.break;
  check(p.name === 'Break Test' && p.bpm === 140.37 && p.loop.on === false && p.markerBars === 0 && p.autoTune === false, 'break: header (tempo 140.37, no loop)');
  check(p.parts.length === 1 && p.parts[0].devices.length === 1 && p.parts[0].devices[0].type === 'double' && p.parts[0].devices[0].offset === 2 && p.parts[0].devices[0].pan === 'opposite', 'break: one part with a double device');
  const n = NT(p, 0);
  check(n.length === 18, `break: 18 hits, found ${n.length}`);
  check(same(n.slice(0, 8).map((x) => [x.t, x.n, x.v]), [[0, 41, 100], [24, 42, 100], [48, 46, 52], [72, 44, 60], [96, 45, 60], [120, 46, 52], [144, 47, 60], [168, 48, 60]]), 'break: bar 1 raw keys');
  check(same(n.slice(8, 12).map((x) => [x.t, x.n, x.len, x.v]), [[195, 38, 7, 120], [242, 38, 5, 120], [293, 42, 9, 64], [382, 46, 2, 90]]), 'break: off-grid hits (@)');
  check(same(n.slice(12, 16).map((x) => [x.t, x.n, x.len, x.v]), [[384, 49, 40, 80], [384, 36, 10, 110], [404, 42, 12, 70], [575, 46, 30, 70]]), 'break: overlapping hits and a hit that crosses the bar line');
  check(same(n.slice(16).map((x) => [x.t, x.n, x.len, x.v]), [[672, 38, 48, 127], [720, 38, 48, 127]]), 'break: bar 4');
}
if (fixtures.pad) {
  const p = fixtures.pad;
  check(p.name === 'Glass Pad' && p.bpm === 90 && same(p.tempoChanges, [{ t: 384, bpm: 95 }]) && p.comment === 'a pad with lanes' && p.autoTune === false, 'pad: header, tempo-change 3.1, json comment');
  const part = p.parts[0];
  check(part.voices === 3 && part.role === 'pad' && part.layer === 'intense' && part.color === '#88aaff', 'pad: words and json fields');
  check(same(part.automation.expression, [{ t: 0, v: 40 }, { t: 96, v: 52 }, { t: 192, v: 64 }, { t: 384, v: 30, post: true }]), 'pad: expression lane with a post point');
  check(same(part.automation.volume, [{ t: -2, v: 60, pre: true }, { t: 0, v: 64 }]), 'pad: volume lane with a negative-tick pre point');
  check(part.devices.length === 1 && part.devices[0].type === 'echo' && part.devices[0].delay === 36 && part.devices[0].level === 0.4 && part.devices[0].repeats === 2 && part.devices[0].pan === 'opposite', 'pad: echo device');
  check(same(part.vibrato, { depth: 50, rate: 110, sync: true, delay: 48, tremolo: 0 }), 'pad: vibrato');
  check(same(part.notes.map((n) => [n.t, n.n, n.len]), [[0, 64, 384], [0, 60, 384], [0, 57, 384], [384, 60, 384], [384, 57, 384], [384, 53, 384]]), 'pad: two long chords');
}

/* ---- the canonical spelling, pinned ----------------------------------------------------------------- */
{
  const proj = { format: 'sf3project', version: 2, name: 'Golden', bpm: 120, bars: 3, autoTune: true, loop: { on: true, startBar: 1, endBar: 3 },
    parts: [{ name: 'Bass', program: 20, volume: 75, expression: 64, pan: 64, role: 'bass', notes: [
      { t: 0, n: 40, v: 100, len: 24 }, { t: 24, n: 40, v: 100, len: 24 }, { t: 48, n: 43, v: 90, len: 48 }, { t: 96, n: 45, v: 90, len: 48 }, { t: 144, n: 47, v: 90, len: 24 },
      { t: 192, n: 40, v: 100, len: 24 }, { t: 216, n: 40, v: 100, len: 24 }, { t: 240, n: 43, v: 90, len: 48 }, { t: 288, n: 45, v: 90, len: 48 }, { t: 336, n: 47, v: 90, len: 24 },
      { t: 389, n: 60, v: 100, len: 7 }] }] };
  const golden = ['cps3 score 1', 'title: Golden', 'tempo: 120', 'bars: 3', 'loop: 1-3', 'markers: 2', 'autotune: on', '',
    'part Bass program 20 volume 75 expression 64 pan 64 role bass', '  bar 1 | E2:8 E2 G2:4!90 A2 B2:8 | % | @5 C4:=7!100 |', ''].join('\n');
  let text = '';
  try { text = Score.print(proj); } catch (e) { text = e.message; }
  check(text === golden, `golden text differs:\n${text}\n--- expected ---\n${golden}`);
  roundTrip('golden project', proj, true);
  /* kit by program (a kit program of the game's bank 0) prints raw keys; a pitched part prints sharps, never flats */
  const kitProgram = data.banks[0].find((x) => x && x.kit).program, pitched = data.banks[0].find((x) => x && !x.kit && x.sustained).program;
  const two = { format: 'sf3project', version: 2, name: 'Kits', bpm: 100, bars: 1, parts: [
    { name: 'Hits', bank: 0, program: kitProgram, notes: [{ t: 0, n: 41, v: 100, len: 24 }, { t: 24, n: 61, v: 100, len: 24 }] },
    { name: 'Tune', bank: 0, program: pitched, notes: [{ t: 0, n: 61, v: 100, len: 24 }, { t: 24, n: 70, v: 100, len: 24 }, { t: 48, n: 41, v: 100, len: 24 }] },
    { name: 'Roled', role: 'perc', bank: 0, program: pitched, notes: [{ t: 0, n: 38, v: 100, len: 24 }] }] };
  const t2 = Score.print(two, { banks: data.banks });
  const lineOf = (name) => { const i = t2.split('\n').findIndex((l) => l.startsWith(`part ${name} `)); return t2.split('\n').slice(i + 1).find((l) => /bar 1 \|/.test(l)); };
  check(/#41\S* #61/.test(lineOf('Hits')) && !/[A-G][#b]?\d/.test(lineOf('Hits').replace(/#\d+/g, '')), `kit part (program ${kitProgram}) prints raw keys: ${lineOf('Hits')}`);
  check(/C#4/.test(lineOf('Tune')) && /A#4/.test(lineOf('Tune')) && /F2/.test(lineOf('Tune')) && !/[A-G]b\d/.test(lineOf('Tune')), `pitched part prints note names with sharps: ${lineOf('Tune')}`);
  check(/#38/.test(lineOf('Roled')), `a part with role perc prints raw keys: ${lineOf('Roled')}`);
  roundTrip('kit and pitched parts', two, true);
}

/* ---- every version-2 field, by hand -------------------------------------------------------------------- */
const edge = () => ({
  format: 'sf3project', version: 2, name: '  Edge: "case" \\ #1  ', author: 'Anna & Bo', comment: 'line one\nline two', bpm: 164.99999999999997,
  tempoChanges: [{ t: 384, bpm: 130.5 }, { t: 770, bpm: 99.123456789 }], bars: 7, length: 1300,
  loop: { on: true, startBar: 2, endBar: 7, start: 200, end: 1300 }, markerBars: 4, markers: [{ t: 0, i: 0, v: 1 }, { t: 96, i: 1, v: 0 }],
  tempoPart: 'two', leadIn: 4, loopRestore: false, autoTune: false, key: { root: 3, scale: 'dorian' }, sections: [{ bar: 1, name: 'A: B' }, { bar: 3, name: ' padded ' }],
  chorusBar: 4, bank: { slot: 8, views: [], programs: {} }, names: { '0:20': 'Deep bass' }, ui: { zoom: 3 }, extraField: { any: ['thing', 1, null] },
  parts: [
    { id: 'one', name: 'Part with spaces', role: 'bass', color: '#112233', bank: 0, program: 20, volume: 75.5, expression: 64, pan: 0, transpose: -12, gain: -3, tune: 7.5, voices: 2,
      mute: true, solo: true, track: 3, loopShift: 24, end: 1200, legato: true, vibrato: { depth: 5, rate: 90, sync: false, delay: 3, tremolo: 2 }, layer: 'intense', polyphony: 2,
      notes: [{ t: 0, n: 40, v: 100, len: 30, tie: true }, { t: 30, n: 43, v: 90, len: 300, slide: 40, cents: -14 }, { t: 40, n: 47, v: 1, len: 5, bend: [[0, 3], [2, -8]] },
              { t: 400, n: 0, v: 127, len: 1, bank: 1, program: 7, volume: 50, expression: 51, pan: 52 }, { t: 1290, n: 127, v: 64, len: 40 }],
      automation: { volume: [{ t: -4, v: 60, pre: true }, { t: 0, v: 64, post: true }, { t: 100, v: 70.5 }], pitch: [{ t: 10, v: -33.3 }], program: [{ t: 50, v: 9, bank: 1 }], vibSync: [], weird: [{ t: 1, v: 2 }] },
      devices: [{ type: 'echo', on: false, delay: 36, level: 0.4, pan: 'opposite', repeats: 2 }, { type: 'duck', source: 'two', keys: [36, 38], depth: 0.5 }, { type: 'gate', pattern: [1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 1] },
                { type: 'swing', amount: 0.25 }, { type: 'humanize', seed: 9 }, { type: 'glide', mode: 'all' }, { type: 'autopan' }, { type: 'harmony', interval: 4, pan: 30 }, { type: 'double', offset: 3, detune: -4 }, { type: 'wobble', speed: 'fast' }],
      raw: [{ t: 0, op: 224, a: [1] }, { t: -2, op: 203, a: [8, 9], pre: true }, { t: 50, op: 232, a: [0, 1], post: true }] },
    { id: 'two', name: '', role: null, program: 3, volume: 80, expression: 100, pan: 64, notes: [
        { t: 500, n: 60, v: 100, len: 50 }, { t: 0, n: 61, v: 100, len: 10 }, { t: 0, n: 64, v: 100, len: 10 }, { t: 5, n: 62, v: 99, len: 10 }, { t: 5, n: 62, v: 98, len: 10 }, { t: 192, n: 50, v: 100, len: 400 }, { t: 200, n: 52, v: 100, len: 3 }] },
    { name: 'Odd values', program: 5, volume: 90, expression: 90, pan: 64, bank: 3, voices: 1, notes: [{ t: 0.5, n: 60, v: 100, len: 10 }, { t: 12, n: 60.5, v: 100, len: 10 }, { t: 24, n: 60, v: 0, len: 10 }, { t: 36, n: 60, v: 100, len: 0 }, { t: -5, n: 60, v: 100, len: 3 }, { t: 48, n: 60, v: 100, len: 3, odd: 1 }] },
    { name: 'D', id: 'p3', role: 'drums', program: 1, notes: [], automation: { volume: [] }, vibrato: { depth: 0, rate: 100, sync: true, delay: 0, tremolo: 0 }, devices: [] },
    { name: 'x"y', id: 'p1', program: 1, volume: 80, expression: 80, pan: 80, notes: [{ t: 0, n: 36, v: 100, len: 2000 }, { t: 192, n: 36, v: 100, len: 2000 }] },
  ],
});
roundTrip('edge project', edge(), false);
{
  const v1 = { name: 'Old', bpm: 120, tempoChanges: [], bars: 2, loop: { on: false, startBar: 1, endBar: 2 }, markerBars: 2,
    parts: [{ name: 'Old part', notes: [{ t: 0, n: 40, v: 100, len: 24 }], polyphony: 1, bank: 0, program: 20, volume: 80, pan: 64, expression: 100, transpose: 0, voices: 1, mute: false }] };
  roundTrip('version-1 project (no version field)', v1, true);
  roundTrip('empty project', { format: 'sf3project', version: 2, name: 'Empty', bpm: 120, bars: 1, parts: [] }, true);
  roundTrip('empty part', { format: 'sf3project', version: 2, name: 'One empty', bpm: 120, bars: 1, parts: [{ name: 'Silent' }] }, true);
  const unsorted = { format: 'sf3project', version: 2, name: 'Unsorted', bpm: 120, bars: 2, parts: [{ name: 'U', program: 20, volume: 80, expression: 100, pan: 64, notes: [
    { t: 200, n: 40, v: 100, len: 10 }, { t: 0, n: 43, v: 100, len: 10 }, { t: 0, n: 47, v: 100, len: 10 }, { t: 100, n: 41, v: 100, len: 10 }] }] };
  const ut = roundTrip('unsorted notes keep their order', unsorted, false);
  check(ut && /json order:/.test(ut) && !/json notes:/.test(ut), 'unsorted notes: print keeps bar lines and adds a "json order" line');
}

/* ---- seeded random projects ---------------------------------------------------------------------------------- */
function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function randomProject(seed) {
  const r = rng(seed), int = (a, b) => a + Math.floor(r() * (b - a + 1)), pick = (l) => l[int(0, l.length - 1)], chance = (p) => r() < p;
  const bars = int(1, 9), words = ['Lead', 'Bass', 'Pad', 'My part', 'x y', 'A"B', 'päd', '#hash', 'json', 'part', 'bar 1'];
  const lens = [3, 6, 12, 16, 24, 32, 36, 48, 72, 96, 144, 192, 384, 7, 50];
  const project = { format: 'sf3project', version: 2, name: chance(0.2) ? pick(['', ' sp ', 'a:b', 'x\ny', 'Z']) : `Song ${seed}`, bpm: chance(0.5) ? int(60, 220) : 60 + r() * 160, bars,
    markerBars: pick([0, 2, 4]), autoTune: chance(0.5), leadIn: chance(0.2) ? int(0, 6) : 2, loopRestore: chance(0.5), parts: [] };
  if (chance(0.3)) project.tempoChanges = Array.from({ length: int(1, 3) }, () => ({ t: chance(0.7) ? int(1, bars - 1 || 1) * 48 : int(1, 900), bpm: int(60, 200) }));
  project.loop = chance(0.2) ? { on: false } : chance(0.5) ? { on: true, startBar: 1, endBar: bars } : { on: true, start: int(0, 100), end: int(500, bars * 192 + 10) };
  if (chance(0.3)) project.key = { root: int(0, 11), scale: pick(['major', 'minor', 'dorian']) };
  if (chance(0.3)) project.sections = [{ bar: 1, name: pick(['Intro', 'A: b', ' x ', '']) }];
  if (chance(0.2)) project.chorusBar = int(1, bars);
  if (chance(0.1)) project.length = int(100, bars * 192);
  if (chance(0.1)) project.markers = [{ t: 0, i: 0, v: 1 }];
  if (chance(0.1)) project.tempoPart = 'p1';
  if (chance(0.1)) project.comment = pick(['hi', 'two\nlines', '']);
  for (let i = 0, count = int(1, 4); i < count; i++) {
    const part = { name: pick(words), program: int(0, 127), volume: int(0, 127), expression: int(0, 127), pan: int(0, 127), notes: [], automation: {}, devices: [], raw: [] };
    if (chance(0.3)) part.bank = int(0, 15);
    if (chance(0.2)) part.role = pick(['bass', 'drums', 'perc', 'pad', null, 'two words']);
    if (chance(0.3)) part.transpose = int(-24, 24);
    if (chance(0.2)) part.gain = int(-64, 63);
    if (chance(0.2)) part.tune = r() * 50 - 25;
    if (chance(0.3)) part.voices = int(1, 6);
    if (chance(0.1)) part.track = int(0, 15);
    if (chance(0.2)) part.legato = true;
    if (chance(0.1)) part.mute = true;
    if (chance(0.1)) part.loopShift = int(-48, 48);
    if (chance(0.1)) part.end = int(100, 1000);
    if (chance(0.1)) part.id = pick(['p1', 'p2', 'zed', 'p9']);
    if (chance(0.2)) part.vibrato = { depth: int(0, 127), rate: int(0, 127), sync: chance(0.5), delay: int(0, 60), tremolo: int(0, 5) };
    const kit = chance(0.3), weird = chance(0.3);
    let cursor = 0;
    for (let k = 0, n = int(0, 40); k < n; k++) {
      const t = chance(0.7) ? cursor : int(0, bars * 192), len = pick(lens);
      const note = { t, n: kit ? int(36, 51) : int(30, 90), v: chance(0.1) ? int(1, 127) : pick([100, 90, 64]), len };
      if (chance(0.1)) note.tie = true;
      if (chance(0.08)) note.slide = int(1, 127);
      if (chance(0.08)) note.cents = int(-100, 100);
      if (chance(0.06)) note.bend = [[0, int(-20, 20)], [int(1, 30), int(-20, 20)]];
      if (chance(0.06)) note.pan = int(0, 127);
      if (chance(0.04)) note.program = int(0, 127);
      if (chance(0.03)) note.bank = int(0, 15);
      if (weird && chance(0.05)) note.v = pick([0, 128, 50.5]);
      if (weird && chance(0.05)) note.t = r() * 100;
      if (weird && chance(0.05)) note.len = pick([0, -4, 2.5]);
      if (weird && chance(0.05)) note.n = pick([-1, 128, 60.5]);
      if (weird && chance(0.05)) note.extra = 'x';
      part.notes.push(note);
      cursor = Math.max(0, t + len + (chance(0.3) ? int(1, 60) : 0));
    }
    if (chance(0.1)) part.notes.reverse();
    if (chance(0.3)) part.automation.volume = Array.from({ length: int(0, 4) }, () => Object.assign({ t: int(-2, 500), v: int(0, 127) }, chance(0.2) ? { post: true } : {}, chance(0.2) ? { pre: true } : {}));
    if (chance(0.2)) part.automation.pitch = [{ t: int(0, 100), v: r() * 200 - 100 }];
    if (chance(0.1)) part.automation.program = [{ t: 4, v: 3, bank: 1 }];
    if (chance(0.05)) part.automation.nothing = [{ t: 1, v: 1 }];
    if (chance(0.2)) part.devices.push(pick([{ type: 'echo', delay: int(1, 96), level: 0.5, repeats: int(1, 3) }, { type: 'duck', source: 'p1', keys: [36], on: chance(0.5) }, { type: 'gate', depth: 0.5 }, { type: 'swing', amount: 0.2 }, { type: 'humanize', seed: int(1, 99) }, { type: 'echo', pan: 'opposite', interval: 7 }]));
    if (chance(0.1)) part.raw.push({ t: int(-2, 400), op: pick([0xE0, 0xCB]), a: [int(0, 127)], post: chance(0.5) || undefined });
    project.parts.push(part);
  }
  return clone(project);
}
{
  let jsonFallbacks = 0;
  for (let seed = 1; seed <= 300; seed++) {
    const project = randomProject(seed);
    const text = roundTrip(`random project ${seed}`, project, false);
    if (text && /^ *json notes:/m.test(text)) jsonFallbacks++;
  }
  console.log(`random projects: ${jsonFallbacks} of 300 needed a "json notes" line (values the grammar cannot say)`);
}

/* ---- tolerant in layout ------------------------------------------------------------------------------------------------ */
{
  const original = fixture('groove.sf3score');
  const want = stripUi(Score.parse(original));
  /* every bar on its own line, tabs and extra spaces, Windows line ends, no space after the bar number */
  const mangled = original.split('\n').map((line) => {
    if (!/^\s*(v\d+\s+)?bar\s+\d+\s*\|/.test(line)) return line;
    const m = /^(\s*)((?:v\d+\s+)?bar\s+\d+)\s*\|(.*)$/.exec(line);
    const bars = m[3].split('|');
    const trailing = bars.pop();
    return [`${m[1]}${m[2]}|`].concat(bars.map((b) => `\t   ${b.trim().replace(/ /g, '  \t')}\t|`)).concat(trailing.trim() ? [`  ${trailing.trim()}`] : []).join('\n');
  }).join('\r\n').replace(/^(title|tempo):/gm, '$1 :  ');
  let back = null, why = '';
  try { back = stripUi(Score.parse(mangled)); } catch (e) { why = e.message; }
  check(back && !firstDiff(want, back, 'p'), `layout: spacing, tabs, CRLF and bars on separate lines change the project (${why || firstDiff(want, back, 'p')})`);
  let open = null;
  try { open = stripUi(Score.parse('cps3 score 1\ntempo: 100\npart A program 3\n  bar 1 | C4:4 D4 E4 F4 | G4:1 |\n  bar 3 | A4:1 | B4:1')); } catch (e) { why = e.message; }
  check(open && open.parts[0].notes.length === 7 && open.parts[0].notes[6].t === 576 && open.bars === 4, 'layout: a last bar without its closing | is still a bar');
  /* a bar may also be a continuation over several lines, even in the middle of a bar */
  let mid = null;
  try { mid = Score.parse('cps3 score 1\npart A\n  bar 1 | C4:8 D4 E4\n     F4 G4 A4 B4 C5 | D4:1 |'); } catch (e) { why = e.message; }
  check(mid && mid.parts[0].notes.length === 9 && mid.parts[0].notes[8].t === 192, 'layout: a bar may go on over the next line');
}

/* ---- negative controls: the comparison catches what it should --------------------------------------------------------------- */
{
  let proj, text;
  for (const c of capcom) {
    proj = Compile.upgrade(G.Project.fromGame(c.song, c.info));
    text = Score.print(proj, { banks: data.banks });
    if (/ % \|/.test(text) && /^ *json polyphony:/m.test(text)) break;
  }
  const want = stripUi(Compile.normalize(proj));
  const bump = text.replace(/(bar 1 \| )(#?\w+)/, (m, a, b) => `${a}${b === 'C4' ? 'D4' : 'C4'}`);
  check(bump !== text && firstDiff(want, stripUi(Score.parse(bump)), 'p'), 'control: a changed first note is caught');
  const noRepeat = text.replace(/ % \|/, ' |');
  check(noRepeat !== text && firstDiff(want, stripUi(Score.parse(noRepeat)), 'p'), 'control: a dropped % repeat is caught');
  const noJson = text.replace(/^ *json polyphony:.*\n/m, '');
  check(noJson !== text && firstDiff(want, stripUi(Score.parse(noJson)), 'p'), 'control: a dropped json line is caught');
  const tempo = text.replace(/^tempo: .*$/m, 'tempo: 99');
  check(Seq.bpmToTempo(Score.parse(tempo).bpm) !== Seq.bpmToTempo(want.bpm), 'control: a changed tempo is caught by the tempo word');
}

/* ---- malformed scores -------------------------------------------------------------------------------------------- */
const BAD = [
  { file: 'bad_overrun.sf3score', line: 7, part: 'Bass', bar: 7, token: 'E2:16', message: 'part "Bass", bar 7: 12 ticks too long (204 of 192)' },
  { file: 'bad_note.sf3score', line: 5, part: 'Lead', bar: 3, token: 'H4', message: 'part "Lead", bar 3: unknown token "H4"' },
  { file: 'bad_word.sf3score', line: 6, part: 'Pad', bar: null, token: 'volum', message: 'part "Pad": unknown word "volum" (did you mean "volume"?)' },
  { file: 'bad_repeat.sf3score', line: 5, part: 'Break', bar: 1, token: '%', message: 'part "Break", bar 1: nothing to repeat (the bar before is not written for this voice)' },
  { file: 'bad_velocity.sf3score', line: 5, part: 'Bass', bar: 2, token: 'E2:8!200', message: 'part "Bass", bar 2: velocity 200 is not 1..127' },
  { file: 'bad_length.sf3score', line: 5, part: 'Pad', bar: 1, token: 'C4:5', message: 'part "Pad", bar 1: :5 is not a note length (use 1 2 4 8 16 32 64, with . or t, or :=ticks)' },
];
for (const b of BAD) {
  const text = fixture(b.file);
  let e = null;
  try { Score.parse(text); } catch (x) { e = x; }
  if (!check(e instanceof Score.ScoreError, `${b.file}: expected a ScoreError, got ${e ? e.constructor.name + ': ' + e.message : 'no error'}`)) continue;
  const column = text.split('\n')[b.line - 1].indexOf(b.token) + 1;
  check(e.line === b.line, `${b.file}: line ${e.line}, expected ${b.line}`);
  check(e.column === column, `${b.file}: column ${e.column}, expected ${column}`);
  check(e.part === b.part && e.bar === b.bar, `${b.file}: part ${JSON.stringify(e.part)} bar ${e.bar}, expected ${JSON.stringify(b.part)} bar ${b.bar}`);
  check(e.token === b.token, `${b.file}: token ${JSON.stringify(e.token)}, expected ${JSON.stringify(b.token)}`);
  check(e.message === b.message, `${b.file}: message\n  ${e.message}\nexpected\n  ${b.message}`);
  console.log(`  ${b.file} -> ${e.message}  [line ${e.line}, column ${e.column}, token ${e.token}]`);
}
const SMALL = [
  ['no first line', 'title: x\n', { line: 1, token: 'title:' }],
  ['wrong version', 'cps3 score 2\n', { line: 1, token: '2' }],
  ['empty text', '', { line: 1 }],
  ['bar line before a part', 'cps3 score 1\nbar 1 | C4 |\n', { line: 2, token: 'bar' }],
  ['unknown header', 'cps3 score 1\ntitel: x\n', { line: 2, token: 'titel' }],
  ['unknown device', 'cps3 score 1\npart A\n  device reverbb mix=1\n', { line: 3, part: 'A', token: 'reverbb' }],
  ['unknown device key', 'cps3 score 1\npart A\n  device echo wet=1\n', { line: 3, part: 'A', token: 'wet=1' }],
  ['unknown lane', 'cps3 score 1\npart A\n  lane volum: 0=1\n', { line: 3, part: 'A', token: 'volum' }],
  ['bad lane point', 'cps3 score 1\npart A\n  lane volume: 0-1\n', { line: 3, part: 'A', token: '0-1' }],
  ['unclosed chord', 'cps3 score 1\npart A\n  bar 1 | [C4 E4 |\n', { line: 3, part: 'A', bar: 1 }],
  ['bar written twice', 'cps3 score 1\npart A\n  bar 1 | C4 |\n  bar 1 | D4 |\n', { line: 4, part: 'A', bar: 1 }],
  ['rest runs over', 'cps3 score 1\npart A\n  bar 1 | C4:2 r:1 |\n', { line: 3, part: 'A', bar: 1, token: 'r:1' }],
  ['@ past the bar', 'cps3 score 1\npart A\n  bar 1 | @192 C4 |\n', { line: 3, part: 'A', bar: 1, token: '@192' }],
  ['second bar overruns', 'cps3 score 1\npart A\n  bar 1 | C4:1 | D4:1 D4 |\n', { line: 3, part: 'A', bar: 2, token: 'D4' }],
  ['header after a part', 'cps3 score 1\npart A\ntempo: 100\n', { line: 3, part: 'A', token: 'tempo' }],
  ['bad json', 'cps3 score 1\njson bank: {nope}\n', { line: 2, token: 'json bank' }],
  ['volume out of range', 'cps3 score 1\npart A volume 300\n', { line: 2, part: 'A', token: '300' }],
  ['order that is not a permutation', 'cps3 score 1\npart A\n  json order: [0]\n  bar 1 | C4 D4 |\n', { part: 'A', token: 'json order' }],
];
for (const [what, text, want] of SMALL) {
  let e = null;
  try { Score.parse(text); } catch (x) { e = x; }
  if (!check(e instanceof Score.ScoreError, `malformed (${what}): expected a ScoreError`)) continue;
  for (const k of Object.keys(want)) check(e[k] === want[k], `malformed (${what}): ${k} is ${JSON.stringify(e[k])}, expected ${JSON.stringify(want[k])} (${e.message})`);
  check(e.part === null || e.message.startsWith(`part "${e.part}"`), `malformed (${what}): the message names the part: ${e.message}`);
}

done(`${stats.texts} projects round-tripped (${stats.parts} parts, ${stats.notes} notes, ${stats.lines} text lines, ${(stats.chars / 1e6).toFixed(1)} MB); no real part fell back to json notes`);
