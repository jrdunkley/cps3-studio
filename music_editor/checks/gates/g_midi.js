/* GATE G16 (docs/plan/06_GATES.md): MIDI in and out (package A10, js/midi.js).
 *
 *   node checks/gates/g_midi.js
 *
 * Passes when
 *   A. nothing regressed: parse() gives, for three awkward real MIDI files (private, not in this repository:
 *      set STUDIO_MIDI_DIR to compare files of your own) the parts, channels, note counts, tempo and hashes recorded before the change
 *      (fixtures/midi_baseline.json: counts and hashes only), and the same result (after independently removing SysEx and preserving its elapsed time where present) as the frozen old module
 *      (fixtures/midi_v1_frozen.js) for every .mid in that folder; write() gives the same bytes on the old kinds of input
 *      and Project.gameMidi for all 49 pieces; Project.fromMidi gives the same projects;
 *   B. the pitfalls: running status, note-on with velocity 0, overlapping notes of one pitch, SMPTE time (clear error),
 *      several channels in one track, other time divisions with chord notes kept together, other chunks skipped;
 *   C. write(): pitch wheel with the bend range set by RPN 0, any controller, markers, several tempo changes, time and
 *      key signatures, texts, the end of the song, `post` ordering;
 *   D. parse() additions: markers, every tempo and time-signature change, later program changes, GM names (128),
 *      sustain-pedal lengthening (optional), channel fine tuning;
 *   E. project -> MIDI -> project keeps notes, tempo map, programs, banks, volumes, pans, expressions, lanes, bends
 *      (as pitch wheel), slurs, sections, loop, key, name; drum kits on channel 10 when the kit follows GM keys; a
 *      version-1 project is accepted; the user's own songs come back note for note;
 *   F. toProject() on files from outside: version-2 shape, roles guessed, instruments and levels from the catalog's
 *      suggest (or the built-in copy), GM drums onto kit 6, slurs only in single-line parts, octave fitting, nothing
 *      in the input changed.
 * Exit 0 only when all pass.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const G = require('./lib.js');
const B = require('./fixtures/baseline_lib.js');
const { check, done } = G.gate('G16 midi');
const Midi = require('../../js/midi.js');
const Project = G.Project;

const MIDI_DIR = process.env.STUDIO_MIDI_DIR || '';   /* optional: a folder of your own MIDI files */
const AWKWARD = [];   /* the three recorded files are private; fixtures/midi_baseline.json keeps only public records */
const BAR = 192;
const json = (x) => JSON.stringify(x);
const same = (a, b) => json(a) === json(b);
/* first place where two plain values differ, for the failure message */
function firstDiff(a, b, where) {
  where = where || '';
  if (typeof a !== typeof b || (a === null) !== (b === null)) return where || '(root)';
  if (a && typeof a === 'object') {
    if (Array.isArray(a) !== Array.isArray(b)) return where;
    const keys = new Set(Object.keys(a).concat(Object.keys(b)));
    for (const k of keys) { const d = firstDiff(a[k], b[k], `${where}${Array.isArray(a) ? `[${k}]` : `.${k}`}`); if (d) return d; }
    return null;
  }
  return a === b ? null : `${where}: ${json(a)} vs ${json(b)}`;
}
/* a section that throws is one failure with the place, not a crash that hides every later check */
function section(name, fn) { try { fn(); } catch (e) { check(false, `${name} threw: ${String(e.stack || e).split('\n').slice(0, 3).join(' | ')}`); } }
const approx = (a, b, tol) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= tol;

/* ------------------------------------------------------------------ a tiny MIDI file builder and an independent reader */
const vlq = (v) => { const d = [v & 0x7F]; v = Math.floor(v / 128); while (v > 0) { d.unshift((v & 0x7F) | 0x80); v = Math.floor(v / 128); } return d; };
const ev = (delta, ...bytes) => [].concat(vlq(delta), bytes);
const metaEv = (delta, type, data) => [].concat(vlq(delta), [0xFF, type], vlq(data.length), data);
const text = (s) => Array.from(Buffer.from(s, 'utf8'));
const EOT = [0, 0xFF, 0x2F, 0];
const chunk = (tag, data) => [].concat(Array.from(tag).map((c) => c.charCodeAt(0)), [(data.length >>> 24) & 255, (data.length >> 16) & 255, (data.length >> 8) & 255, data.length & 255], data);
const smf = (format, division, tracks, extraChunks) => Uint8Array.from([].concat(
  chunk('MThd', [0, format, (tracks.length >> 8) & 255, tracks.length & 255, (division >> 8) & 255, division & 255]),
  ...(extraChunks || []), ...tracks.map((t) => chunk('MTrk', t))));
/* every event of a file with absolute ticks as written (no conversion): the independent check of what write() puts in the bytes */
function rawEvents(bytes) {
  let p = 14;
  const division = (bytes[12] << 8) | bytes[13], out = [];
  while (p < bytes.length) {
    const len = ((bytes[p + 4] << 24) | (bytes[p + 5] << 16) | (bytes[p + 6] << 8) | bytes[p + 7]) >>> 0, end = p + 8 + len;
    p += 8;
    const events = [];
    let t = 0, status = 0;
    while (p < end) {
      let v = 0, c;
      do { c = bytes[p++]; v = v * 128 + (c & 0x7F); } while (c & 0x80);
      t += v;
      if (bytes[p] & 0x80) status = bytes[p++];
      if (status === 0xFF) {
        const type = bytes[p++]; let l = 0;
        do { c = bytes[p++]; l = l * 128 + (c & 0x7F); } while (c & 0x80);
        events.push({ t, meta: type, data: Array.from(bytes.slice(p, p + l)) }); p += l;
      } else {
        const kind = status & 0xF0, ch = status & 15;
        if (kind === 0xC0 || kind === 0xD0) events.push({ t, kind, ch, a: bytes[p++] });
        else { events.push({ t, kind, ch, a: bytes[p], b: bytes[p + 1] }); p += 2; }
      }
    }
    out.push(events);
  }
  return { division, tracks: out };
}

const nameOf = (s) => Array.from(new TextEncoder().encode(s));
const noteOnOff = (delta, ch, n, v, len) => [].concat(ev(delta, 0x90 | ch, n, v), ev(len, 0x80 | ch, n, 0));

/* ================================================================== the module under test must exist
 * (this gate is written first: until js/midi.js has the new functions it fails, and says what is missing) */
for (const f of ['fromProject', 'toProject']) check(typeof Midi[f] === 'function', `SF3Midi.${f} exists`);
check(Array.isArray(Midi.GM_NAMES) && Midi.GM_NAMES.length === 128, 'SF3Midi.GM_NAMES: the 128 General MIDI program names');

/* ================================================================== A. nothing regressed */
const baseline = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'midi_baseline.json'), 'utf8'));
const frozen = B.loadFrozen();
const withoutSysEx = require('./fixtures/midi_sysex_reference.js');
const haveMidiDir = fs.existsSync(MIDI_DIR);
if (!haveMidiDir) console.log('note: STUDIO_MIDI_DIR is not set; the comparison on real MIDI files is skipped');
const readFile = (f) => new Uint8Array(fs.readFileSync(path.join(MIDI_DIR, f)));
const { data } = G.loadData();
const awkwardParsed = {};
for (const f of AWKWARD) {
  if (!haveMidiDir || !fs.existsSync(path.join(MIDI_DIR, f))) { console.log(`note: ${f} is not in ${MIDI_DIR}; skipped`); continue; }
  const bytes = readFile(f), rec = baseline.files[f];
  let m;
  try { m = Midi.parse(bytes); } catch (e) { check(false, `${f}: parse threw ${e.message}`); continue; }
  awkwardParsed[f] = m;
  check(B.sha(bytes) === rec.sha256, `${f}: the file is the one the baseline was recorded from`);
  const filtered = withoutSysEx(bytes);
  const expected = filtered.count ? B.summary(frozen.parse(filtered.bytes), bytes) : rec;
  const now = B.summary(m, bytes), d = firstDiff(expected, now);
  check(!d, `${f}: parts, channels, note counts, tempo and hashes match ${filtered.count ? "independent SysEx reference" : "recorded baseline"} (first difference: ${d})`);
  check(m.parts.length === expected.parts.length && m.parts.every((p, i) => p.notes.length === expected.parts[i].notes && p.channel === expected.parts[i].channel), `${f}: ${rec.parts.length} parts, same channels and note counts`);
}
/* every .mid in the folder: the old module and the new one agree on everything the old one gave (the new may also read what the old refused) */
let compared = 0, newlyReadable = 0;
if (haveMidiDir) {
  for (const f of fs.readdirSync(MIDI_DIR).filter((x) => /\.midi?$/i.test(x)).sort()) {
    const bytes = readFile(f);
    let a, b, ea = null, eb = null;
    let filtered;
    try { filtered = withoutSysEx(bytes); } catch (_) { filtered = { bytes, count: 0 }; }
    try { a = frozen.parse(filtered.count ? filtered.bytes : bytes); } catch (e) { ea = e.message; }
    try { b = Midi.parse(bytes); } catch (e) { eb = e.message; }
    if (ea && !eb) { newlyReadable++; continue; }
    compared++;
    if (ea || eb) check(ea === eb, `${f}: old and new parse refuse the file alike (${ea} / ${eb})`);
    else { const d = firstDiff(B.canon(a), B.canon(b)); check(!d, `${f}: ${filtered.count ? "independent SysEx framing and frozen event semantics" : "parse as before"} (first difference: ${d})`); }
  }
  console.log(`note: ${compared} files in ${MIDI_DIR} compared with the frozen module${newlyReadable ? `, ${newlyReadable} more readable than before` : ''}`);
}
for (const s of B.writeSamples()) {
  const now = Midi.write(s.song), old = frozen.write(B.writeSamples().find((x) => x.name === s.name).song);
  check(B.sha(now) === baseline.write[s.name] && B.sha(now) === B.sha(old), `write(): "${s.name}" gives the same bytes as before`);
}
let gameSame = 0;
for (const song of data.songs) {
  const info = G.Data.describe(song), rec = baseline.gameMidi[song.code];
  if (rec && B.sha(Project.gameMidi(song, info, 1)) === rec.passes1 && B.sha(Project.gameMidi(song, info, 2)) === rec.passes2) gameSame++;
}
check(gameSame === 49 && data.songs.length === 49, `Project.gameMidi: the same MIDI bytes as before for the game's music (${gameSame} of ${data.songs.length})`);
for (const f of Object.keys(awkwardParsed)) {
  const filtered = withoutSysEx(readFile(f));
  const expected = filtered.count ? B.sha(Project.fromMidi(f, frozen.parse(filtered.bytes), data.banks)) : baseline.fromMidi[f];
  check(B.sha(Project.fromMidi(f, awkwardParsed[f], data.banks)) === expected, `Project.fromMidi(${f}): same project as independent reference`);
}

/* Approved SysEx correction: independent framing plus explicit boundaries. */
section('SysEx framing', () => {
  for (const status of [0xF0, 0xF7]) for (const size of [0, 1, 127, 128, 130, 16384]) {
    const payload = Array.from({length:size}, (_, i) => [0, 127, 128, 255, 247][i % 5]);
    const bytes = smf(0, 48, [[].concat(ev(17, status), vlq(size), payload,
      ev(23, 0xF7, 0), metaEv(7, 3, text('SysEx')), noteOnOff(11, 0, 60, 99, 48),
      ev(5, 0x90, 62, 80), ev(24, 62, 0), EOT)]);
    const filtered = withoutSysEx(bytes), parsed = Midi.parse(bytes);
    check(filtered.count === 2 && !firstDiff(B.canon(parsed), B.canon(frozen.parse(filtered.bytes))), `SysEx ${status.toString(16)}, length ${size}: independent events match`);
    check(same(parsed.parts[0].notes.map(n => [n.t,n.n,n.v,n.len]), [[58,60,99,48],[111,62,80,24]]), `SysEx ${status.toString(16)}, length ${size}: exact notes and elapsed time`);
  }
  for (const body of [[0,0xF0,5,1], [0,0xF7,0x81], [0,0xF0,0x80,0x80,0x80,0x80,0]]) {
    let error=''; try { Midi.parse(smf(0,48,[body])); } catch(e) { error=e.message; }
    check(/SysEx|damaged/.test(error), 'truncated/invalid SysEx length or body is rejected');
  }
});

/* ================================================================== B. pitfalls of reading */
section('B pitfalls', () => {
  const ok = (name, bytes, fn) => { try { fn(Midi.parse(bytes)); } catch (e) { check(false, `${name}: ${e.message}`); } };
  const notesOf = (m, i) => m.parts[i || 0].notes.map((n) => [n.t, n.n, n.v, n.len]);
  /* running status, and note-on with velocity 0 as a note off */
  ok('running status', smf(0, 48, [[].concat(ev(0, 0x90, 60, 100), ev(48, 60, 0), ev(0, 62, 100), ev(48, 62, 0), EOT)]), (m) =>
    check(same(notesOf(m), [[0, 60, 100, 48], [48, 62, 100, 48]]), 'running status and note-on with velocity 0 read as notes'));
  ok('note off with release velocity', smf(0, 48, [[].concat(ev(0, 0x90, 60, 100), ev(48, 0x80, 60, 64), ev(0, 0x90, 61, 90), ev(10, 0x80, 61, 33), EOT)]), (m) =>
    check(same(notesOf(m), [[0, 60, 100, 48], [48, 61, 90, 10]]), 'note off (0x80) with a release velocity ends the note'));
  /* overlapping notes of one pitch: the first off ends the first on */
  ok('overlap', smf(0, 48, [[].concat(ev(0, 0x90, 60, 100), ev(24, 0x90, 60, 90), ev(24, 0x80, 60, 0), ev(24, 0x80, 60, 0), EOT)]), (m) =>
    check(same(notesOf(m), [[0, 60, 100, 48], [24, 60, 90, 48]]), 'overlapping notes of one pitch: two notes, each off ends the earlier on'));
  /* SMPTE time keeps its clear error; garbage too */
  let err = '';
  try { Midi.parse(smf(0, 0xE728, [EOT])); } catch (e) { err = e.message; }
  check(/SMPTE/.test(err) && /beats/.test(err), `SMPTE time: the clear error is kept ("${err}")`);
  err = '';
  try { Midi.parse(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16])); } catch (e) { err = e.message; }
  check(/not a MIDI file/.test(err), 'a file that is not MIDI: a clear error');
  err = '';
  try { Midi.parse(smf(0, 48, [[].concat(ev(0, 0xF1, 1), EOT)])); } catch (e) { err = e.message; }
  check(/damaged/.test(err), 'an unknown event: "damaged" error as before');
  /* several channels in one track */
  ok('channels', smf(1, 48, [[].concat(metaEv(0, 3, nameOf('Mix')), noteOnOff(0, 0, 60, 100, 48), noteOnOff(0, 1, 64, 90, 48), noteOnOff(0, 9, 36, 100, 12), EOT)]), (m) => {
    check(m.parts.length === 3 && same(m.parts.map((p) => p.channel), [0, 1, 9]) && same(m.parts.map((p) => p.drums), [false, false, true]), 'one track with three channels: three parts, channel 10 is drums');
    check(same(m.parts.map((p) => p.name), ['Mix (channel 1)', 'Mix (channel 2)', 'Mix (channel 10)']) && m.parts.every((p) => p.track === 0), 'parts of a multi-channel track are named with their channel');
  });
  /* other time divisions: 48 ticks to the beat always, chord notes stay together */
  for (const d of [24, 96, 120, 192, 384, 480, 960, 1920]) {
    ok(`division ${d}`, smf(0, d, [[].concat(ev(d, 0x90, 60, 100), ev(d / 2, 0x80, 60, 0), EOT)]), (m) =>
      check(same(notesOf(m), [[48, 60, 100, 24]]) && m.division === d, `division ${d}: one beat is 48 ticks`));
  }
  ok('chord rounding', smf(0, 480, [[].concat(ev(7, 0x90, 60, 100), ev(0, 0x90, 64, 100), ev(0, 0x90, 67, 100), ev(100, 0x80, 60, 0), ev(100, 0x80, 64, 0), ev(100, 0x80, 67, 0), EOT)]), (m) =>
    check(m.parts[0].notes.length === 3 && new Set(m.parts[0].notes.map((n) => n.t)).size === 1 && same(m.parts[0].notes.map((n) => n.len), [10, 20, 30]), 'chord notes with one start tick keep one start tick when rounded to 48 per beat'));
  ok('two tracks same tick', smf(1, 480, [[].concat(ev(7, 0x90, 60, 100), ev(100, 0x80, 60, 0), EOT), [].concat(ev(7, 0x90, 64, 100), ev(100, 0x80, 64, 0), EOT)]), (m) =>
    check(m.parts.length === 2 && m.parts[0].notes[0].t === m.parts[1].notes[0].t, 'notes of two tracks that start together stay together'));
  /* chunks of other kinds are skipped; the end of track is reported */
  ok('other chunk', smf(1, 48, [[].concat(noteOnOff(0, 0, 60, 100, 48), EOT)], [chunk('XFIH', [1, 2, 3, 4, 5])]).slice(), (m) => check(m.parts.length === 1, 'a chunk of another kind before the tracks is skipped'));
  {
    const withChunkBetween = Uint8Array.from([].concat(chunk('MThd', [0, 1, 0, 2, 0, 48]), chunk('MTrk', [].concat(noteOnOff(0, 0, 60, 100, 48), EOT)), chunk('XFIH', [9, 9]), chunk('MTrk', [].concat(noteOnOff(0, 1, 62, 100, 48), EOT))));
    ok('chunk between tracks', withChunkBetween, (m) => check(m.parts.length === 2, 'a chunk of another kind between tracks is skipped'));
  }
  ok('end of track', smf(0, 48, [[].concat(noteOnOff(0, 0, 60, 100, 48), ev(150, 0xFF, 0x2F, 0))]), (m) =>
    check(m.lengthTicks === 48 && m.endTicks === 198, `the end of the track is reported (endTicks ${m.endTicks}) apart from the last note (lengthTicks ${m.lengthTicks})`));
});

/* ================================================================== C. write() */
section('C write', () => {
  const song = {
    bpm: 120, tempoChanges: [{ t: 240, bpm: 90 }, { t: 480, bpm: 150.5 }, { t: 960, bpm: 75 }], name: 'Wheel test \u00e9', copyright: 'Me 2026', text: 'sf3music', texts: ['hello', 'second note'],
    timeSignatures: [{ t: 0, num: 7, den: 8 }, { t: 336, num: 4, den: 4 }], keySignature: { sf: -3, minor: true },
    markers: [{ t: 0, text: 'Intro' }, { t: 192, text: 'Verse \u00e9' }, { t: 384, text: 'loopEnd' }], endTick: 1000,
    tracks: [
      { name: 'Lead', channel: 2, bendRange: 12, events: [
        { t: 0, kind: 'cc', controller: 0, value: 3 }, { t: 0, kind: 'program', value: 43 },
        { t: 0, kind: 'cc', controller: 1, value: 40 }, { t: 5, kind: 'cc', controller: 91, value: 80 }, { t: 5, kind: 'cc', controller: 74, value: 99 }, { t: 6, kind: 'cc', controller: 64, value: 127 },
        { t: 10, kind: 'bend', value: -8192 }, { t: 20, kind: 'bend', value: 8191 }, { t: 30, kind: 'bend', value: 0 }, { t: 40, kind: 'bend', value: 9000 }, { t: 50, kind: 'bend', value: -9000 }, { t: 60, kind: 'bend', value: 1234 },
        { t: 48, kind: 'note', n: 60, v: 100, len: 48 }, { t: 48, kind: 'cc', controller: 7, value: 20, post: true }, { t: 48, kind: 'bend', value: 64 },
        { t: 100, kind: 'marker', text: 'in track' }, { t: 100, kind: 'text', text: 'a text' },
      ] },
      { name: 'Tuned', channel: 5, tune: 14, events: [{ t: 0, kind: 'note', n: 50, v: 90, len: 24 }, { t: 0, kind: 'rpn', rpn: [0, 0], value: [24, 0] }] },
    ],
  };
  const bytes = Midi.write(song);
  const raw = rawEvents(bytes);
  check(bytes[0] === 0x4D && bytes[8] === 0 && bytes[9] === 1 && bytes[10] === 0 && bytes[11] === 3 && raw.division === 48, 'write(): format 1, three tracks, 48 ticks to the beat');
  const cond = raw.tracks[0], lead = raw.tracks[1], tuned = raw.tracks[2];
  const metas = (events, type) => events.filter((e) => e.meta === type);
  check(same(metas(cond, 0x51).map((e) => [e.t, (e.data[0] << 16) | (e.data[1] << 8) | e.data[2]]), [[0, 500000], [240, 666667], [480, 398671], [960, 800000]]), 'write(): several tempo changes, each at its tick (microseconds per beat)');
  check(same(metas(cond, 0x58).map((e) => [e.t, e.data[0], e.data[1]]), [[0, 7, 3], [336, 4, 2]]), 'write(): a time signature, and a change of it (7/8, then 4/4)');
  check(same(metas(cond, 0x59).map((e) => e.data), [[253, 1]]), 'write(): a key signature (3 flats, minor)');
  check(same(metas(cond, 0x06).map((e) => [e.t, Buffer.from(e.data).toString('utf8')]), [[0, 'Intro'], [192, 'Verse \u00e9'], [384, 'loopEnd']]), 'write(): markers');
  check(Buffer.from(metas(cond, 0x03)[0].data).toString('utf8') === 'Wheel test \u00e9' && Buffer.from(metas(cond, 0x02)[0].data).toString() === 'Me 2026', 'write(): the song name and copyright');
  check(same(metas(cond, 0x01).map((e) => Buffer.from(e.data).toString()).sort(), ['hello', 'second note', 'sf3music']), 'write(): text events');
  check(metas(cond, 0x2F)[0].t === 1000 && metas(lead, 0x2F)[0].t === 1000 && metas(tuned, 0x2F)[0].t === 1000, 'write(): every track ends at the song end (endTick)');
  const ccs = lead.filter((e) => e.kind === 0xB0);
  const rpn0 = ccs.filter((e) => e.t === 0);
  check(same(rpn0.slice(0, 6).map((e) => [e.a, e.b]), [[101, 0], [100, 0], [6, 12], [38, 0], [101, 127], [100, 127]]), 'write(): bendRange 12 is RPN 0 (controllers 101, 100, data entry 6 = 12 semitones, 38 = 0 cents) closed with RPN null');
  check([0, 1, 91, 74, 64].every((c) => ccs.some((e) => e.a === c)) && ccs.find((e) => e.a === 1).b === 40 && ccs.find((e) => e.a === 91).b === 80 && ccs.find((e) => e.a === 74).b === 99, 'write(): any controller (modulation 1, reverb 91, 74, pedal 64, bank 0)');
  const wheel = lead.filter((e) => e.kind === 0xE0).map((e) => [e.t, (((e.b << 7) | e.a) - 8192)]);
  check(same(wheel, [[10, -8192], [20, 8191], [30, 0], [40, 8191], [50, -8192], [48, 64], [60, 1234]].sort((a, b) => a[0] - b[0])), 'write(): pitch wheel events with their 14-bit values, out of range ones clamped');
  const at48 = lead.filter((e) => e.t === 48).map((e) => (e.kind === 0x90 ? 'on' : e.kind === 0xB0 ? 'cc' : e.kind === 0xE0 ? 'bend' : e.kind));
  check(same(at48, ['bend', 'on', 'cc']), `write(): at one tick a bend comes before the note, a post controller after it (${at48.join(' ')})`);
  check(metas(lead, 0x06).some((e) => e.t === 100 && Buffer.from(e.data).toString() === 'in track') && metas(lead, 0x01).some((e) => e.t === 100), 'write(): markers and texts inside a track');
  const tuneCcs = tuned.filter((e) => e.kind === 0xB0).map((e) => [e.a, e.b]);
  check(same(tuneCcs.slice(0, 5), [[101, 0], [100, 1], [6, 72], [38, 123], [101, 127]]), 'write(): tune 14 cents is RPN 1 (8192 + 14 x 81.92 = 9339: 72 / 123)');
  const m = Midi.parse(bytes);
  check(same(m.tempo.map((x) => [x.t, Math.round(x.bpm * 1000) / 1000]), [[0, 120], [240, 90], [480, 150.5], [960, 75]]), 'parse of that: the tempo map');
  check(same(m.markers.map((x) => [x.t, x.text, x.kind]), [[0, 'Intro', 'marker'], [100, 'in track', 'marker'], [192, 'Verse \u00e9', 'marker'], [384, 'loopEnd', 'marker']]), 'parse of that: markers (conductor and track), UTF-8 kept');
  check(same(m.timeSignatures, [{ t: 0, num: 7, den: 8 }, { t: 336, num: 4, den: 4 }]) && same(m.timeSignature, [7, 8]), 'parse of that: every time signature, the first as before');
  check(same(m.keySignatures, [{ t: 0, sf: -3, minor: true }]), 'parse of that: the key signature');
  check(m.title === 'Wheel test \u00e9' && m.copyright === 'Me 2026' && m.ours && m.endTicks === 1000, 'parse of that: title, copyright, our mark, song end');
  const lp = m.parts.find((p) => p.channel === 2);
  check(lp.bendRange === 12 && same(lp.bends.map((b) => [b.t, b.v]), wheel), 'parse of that: bend range from RPN 0 and every wheel value');
  check(lp.bank === 3 && lp.program === 43, 'parse of that: bank and program');
  const tp = m.parts.find((p) => p.channel === 5);
  check(approx(tp.tune, 14, 0.01) && tp.bendRange === 24, `parse of that: fine tuning from RPN 1 (${tp.tune} cents) and a bend range from an rpn event (${tp.bendRange})`);
  check(same(Array.from(Midi.write(song)), Array.from(Midi.write(JSON.parse(json(song))))), 'write(): the same input gives the same bytes');
});

/* ================================================================== D. parse() additions */
section('D parse additions', () => {
  check(new Set(Midi.GM_NAMES).size === 128 && Midi.GM_NAMES.every((n) => typeof n === 'string' && n.length > 2), 'the 128 GM names are all different and non-empty');
  check(Midi.GM_NAMES[0] === 'Acoustic Grand Piano' && Midi.GM_NAMES[33] === 'Electric Bass (finger)' && Midi.GM_NAMES[80] === 'Lead 1 (square)' && Midi.GM_NAMES[127] === 'Gunshot' && Midi.gmName(56) === 'Trumpet' && Midi.gmName(8, true) === 'Room Kit', 'GM names: spot checks, drum kits by program on channel 10');
  const file = smf(1, 48, [
    [].concat(metaEv(0, 0x51, [7, 0xA1, 0x20]), EOT),
    [].concat(ev(0, 0xC0, 33), ev(0, 0x90, 40, 100), ev(48, 0x80, 40, 0), ev(48, 0xB0, 0, 2), ev(0, 0xC0, 34), ev(0, 0xC0, 35), ev(0, 0x90, 41, 100), ev(48, 0x80, 41, 0), EOT),
    [].concat(ev(0, 0xC9, 8), noteOnOff(0, 9, 36, 100, 12), EOT),
    [].concat(noteOnOff(0, 3, 60, 100, 12), EOT),
  ]);
  const m = Midi.parse(file);
  const bass = m.parts[0];
  check(bass.program === 33 && same(bass.programChanges, [{ t: 96, program: 34, bank: 2 }, { t: 96, program: 35, bank: 2 }]), `program changes after the first are listed with the bank in force (${json(bass.programChanges)})`);
  check(bass.programName === 'Electric Bass (finger)' && m.parts[1].programName === 'Room Kit' && m.parts[2].programName === null && m.parts[2].program === null, 'the GM name of the first program, the drum kit name, null when there was no program change');
  check(m.parts.every((p) => Array.isArray(p.programChanges)), 'every part has a programChanges list');
  const ours = Midi.parse(Midi.write({ bpm: 100, text: 'sf3music', tracks: [{ name: 'X', channel: 0, events: [{ t: 0, kind: 'program', value: 37 }, { t: 0, kind: 'note', n: 60, v: 100, len: 12 }] }] }));
  check(ours.ours && ours.parts[0].programName === null, "a file made by this editor: programs are the game's, no GM name");
  /* sustain pedal: optional */
  const pedal = (events) => smf(0, 48, [[].concat(...events, EOT)]);
  const held = pedal([ev(0, 0x90, 60, 100), ev(10, 0xB0, 64, 127), ev(10, 0x80, 60, 0), ev(80, 0xB0, 64, 0)]);
  check(Midi.parse(held).parts[0].notes[0].len === 20 && Midi.parse(held, {}).parts[0].notes[0].len === 20, 'sustain: off by default (the note ends where it was released)');
  check(Midi.parse(held, { sustain: true }).parts[0].notes[0].len === 100 && Midi.parse(held, { sustain: true }).lengthTicks === 100, 'sustain: with the flag a note released under the pedal lasts until the pedal is lifted');
  const restruck = pedal([ev(0, 0x90, 60, 100), ev(10, 0xB0, 64, 127), ev(10, 0x80, 60, 0), ev(30, 0x90, 60, 90), ev(20, 0x80, 60, 0), ev(30, 0xB0, 64, 0)]);
  check(same(Midi.parse(restruck, { sustain: true }).parts[0].notes.map((n) => [n.t, n.len]), [[0, 50], [50, 50]]), 'sustain: a note struck again under the pedal cuts the held one there');
  const never = pedal([ev(0, 0xB0, 64, 127), ev(0, 0x90, 60, 100), ev(10, 0x80, 60, 0), ev(60, 0xFF, 0x01, 0)]);
  check(Midi.parse(never, { sustain: true }).parts[0].notes[0].len === 70, 'sustain: a pedal never lifted ends at the end of the track');
  check(same(Midi.parse(held).parts[0].controls.map((c) => [c.t, c.c, c.v]), [[10, 64, 127], [100, 64, 0]]), 'the pedal changes are still listed as controls');
});

/* ================================================================== E. project -> MIDI -> project */
const canonBend = (b, limit) => {           // what a note's bend list means: the value at each tick after its start (none = 0); only changes are kept
  const m = new Map();
  for (const [dt, v] of b || []) if (limit === undefined || dt < limit) m.set(dt, v);
  const out = []; let cur = 0;
  for (const dt of Array.from(m.keys()).sort((a, b) => a - b)) { if (m.get(dt) !== cur) out.push([dt, m.get(dt)]); cur = m.get(dt); }
  return out;
};
const note = (t, n, v, len, extra) => Object.assign({ t, n, v, len }, extra || {});
const part = (id, name, o) => Object.assign({ id, name, role: null, color: null, bank: 0, program: 20, volume: 75, expression: 64, pan: 64, transpose: 0, gain: 0, tune: 0, voices: 1,
  mute: false, solo: false, track: null, loopShift: 0, end: null, legato: false, vibrato: { depth: 0, rate: 100, sync: true, delay: 0, tremolo: 0 }, layer: null, notes: [], automation: {}, devices: [], raw: [] }, o);
function richProject() {
  const kit = [];
  for (let i = 0; i < 16; i++) { kit.push(note(i * 48, i % 2 ? 38 : 36, 100 + i, 12), note(i * 48, 42, 70, 12)); }
  kit.push(note(144, 46, 80, 24));
  const brk = [];
  for (let i = 0; i < 16; i++) brk.push(note(i * 12, 41 + (i % 8), 100, 12));
  return {
    format: 'sf3project', version: 2, name: 'Night Drive \u00e9', author: 'Test Author', comment: 'A comment line', bpm: 130.25,
    tempoChanges: [{ t: 384, bpm: 135 }, { t: 960, bpm: 90.5 }, { t: 1536, bpm: 128.75 }], bars: 12, length: null,
    loop: { on: true, startBar: 3, endBar: 11, start: 384, end: 2112 }, markerBars: 2, markers: null, tempoPart: null, leadIn: 2, loopRestore: true, autoTune: true,
    key: { root: 9, scale: 'minor' }, sections: [{ bar: 1, name: 'Intro' }, { bar: 3, name: 'Verse' }, { bar: 9, name: 'Chorus' }], chorusBar: null, bank: null, names: {}, ui: {},
    parts: [
      part('p1', 'Bass', { role: 'bass', program: 20, volume: 75, expression: 64, pan: 64, notes: [
        note(0, 40, 100, 48), note(48, 43, 90, 48, { tie: true }), note(96, 45, 80, 96, { tie: true }), note(192, 40, 100, 48, { bend: [[0, -8], [12, 0]] }),
        note(240, 41, 100, 48), note(288, 43, 60, 24, { bend: [[6, 5], [12, -5], [18, 0], [30, 3]] }), note(384, 36, 127, 192), note(1536, 38, 111, 192)] }),      // the last bend is after the note ends, before the next starts
      part('p2', 'Lead', { role: 'lead', program: 43, volume: 56, expression: 52, pan: 24, notes: [
        note(0, 72, 100, 24), note(48, 74, 100, 48, { tie: true }), note(96, 76, 90, 48), note(144, 77, 90, 100), note(288, 79, 95, 48), note(576, 72, 100, 48), note(624, 74, 100, 96),
        note(768, 76, 100, 48), note(1000, 69, 100, 48), note(1100, 71, 100, 48)],
        automation: { volume: [{ t: 96, v: 70 }], expression: [{ t: 0, v: 30 }, { t: 192, v: 80 }], pan: [{ t: 240, v: 100 }], program: [{ t: 480, v: 44 }, { t: 1000, v: 5, bank: 2 }], pitch: [{ t: 600, v: 50 }, { t: 700, v: 0 }] } }),
      part('p3', 'Pad', { role: 'pad', program: 46, volume: 64, expression: 64, pan: 108, voices: 3, notes: [
        note(0, 57, 70, 192, { tie: true }), note(0, 60, 70, 192, { tie: true }), note(0, 64, 70, 192, { tie: true }),
        note(192, 53, 70, 192), note(192, 57, 70, 192), note(192, 60, 70, 192, { tie: true }),
        note(384, 55, 70, 96), note(384, 59, 70, 96), note(384, 62, 70, 96)] }),
      part('p4', 'Kit', { role: 'drums', program: 6, volume: 80, expression: 76, pan: 64, voices: 2, notes: kit }),
      part('p5', 'Break', { role: 'drums', program: 1, volume: 85, expression: 85, pan: 127, notes: brk }),
      part('p6', 'Effect', { role: 'fx', bank: 2, program: 5, volume: 100, expression: 90, pan: 10, notes: [note(96, 60, 50, 24), note(300, 62, 40, 10)] }),
    ],
  };
}
/* what the project should be after the trip: the same, except the two notes under the pitch lane carry its bends (a C3 step is 9.375 cents: 50 cents = 5 steps) */
function expectedAfter(p) {
  const e = JSON.parse(json(p));
  const lead = e.parts[1];
  lead.notes.find((n) => n.t === 576).bend = [[24, 5]];
  lead.notes.find((n) => n.t === 624).bend = [[0, 5], [76, 0]];
  return e;
}
section('E round trip', () => {
  const proj = richProject(), before = json(proj);
  let bytes, midi, back;
  try { bytes = Midi.fromProject(proj); midi = Midi.parse(bytes); back = Midi.toProject(midi, { name: 'x.mid' }); } catch (e) { check(false, `project -> MIDI -> project threw: ${e.stack.split('\n').slice(0, 3).join(' | ')}`); }
  if (back) {
    check(json(proj) === before, 'fromProject does not change the project it is given');
    check(same(Array.from(bytes), Array.from(Midi.fromProject(richProject()))), 'fromProject: the same project gives the same bytes');
    check(midi.ours === true && midi.format === 1 && midi.division === 48 && midi.parts.length === 6, 'the MIDI is format 1, 48 per beat, carries the editor\'s mark, has one track per part');
    const exp = expectedAfter(richProject());
    check(back.format === 'sf3project' && back.version === 2 && Array.isArray(back.parts), 'toProject gives a version-2 project');
    check(back.name === exp.name && back.author === exp.author && back.comment === exp.comment, `name, author and comment kept (${back.name} / ${back.author} / ${back.comment})`);
    check(approx(back.bpm, exp.bpm, 0.001) && back.tempoChanges.length === 3 && back.tempoChanges.every((c, i) => c.t === exp.tempoChanges[i].t && approx(c.bpm, exp.tempoChanges[i].bpm, 0.005)), `the tempo map is kept to a hundredth of a beat per minute (${back.bpm} ${json(back.tempoChanges)})`);
    check(back.bars === 12 && back.length === null, `the length in bars is kept even with silence at the end (${back.bars})`);
    check(same(back.loop, exp.loop), `the loop is kept as markers loopStart / loopEnd: ${json(back.loop)}`);
    check(same(back.sections, exp.sections), 'sections are kept as markers');
    check(same(back.key, exp.key), `the key is kept (${json(back.key)})`);
    check(back.markerBars === 2 && back.leadIn === 2 && back.loopRestore === true && back.chorusBar === null && back.bank === null && same(back.names, {}) && same(back.markers, null), 'the other version-2 fields have their defaults');
    exp.parts.forEach((ep, i) => {
      const q = back.parts[i];
      if (!q) { check(false, `part ${ep.name} is missing`); return; }
      check(q.id === `p${i + 1}` && q.name === ep.name, `${ep.name}: id and name`);
      check(q.bank === ep.bank && q.program === ep.program && q.volume === ep.volume && q.expression === ep.expression && q.pan === ep.pan,
        `${ep.name}: bank ${q.bank}/${ep.bank}, program ${q.program}/${ep.program}, volume ${q.volume}/${ep.volume}, expression ${q.expression}/${ep.expression}, pan ${q.pan}/${ep.pan}`);
      const norm = (n) => ({ t: n.t, n: n.n, v: n.v, len: n.len, tie: !!n.tie, bend: canonBend(n.bend) });
      const a = ep.notes.map(norm).sort((x, y) => x.t - y.t || x.n - y.n), b = q.notes.map(norm).sort((x, y) => x.t - y.t || x.n - y.n);
      const d = firstDiff(a, b);
      check(!d, `${ep.name}: ${ep.notes.length} notes with times, pitches, velocities, lengths, slurs and bends kept (first difference ${d})`);
      check(q.transpose === 0 && q.tune === 0 && q.mute === false && q.layer === null && Array.isArray(q.devices) && q.devices.length === 0 && Array.isArray(q.raw), `${ep.name}: the version-2 part fields have their defaults`);
      for (const lane of ['volume', 'expression', 'pan', 'program']) {
        const want = (ep.automation[lane] || []).map((x) => (x.bank !== undefined && lane === 'program' && x.bank !== ep.bank ? { t: x.t, v: x.v, bank: x.bank } : { t: x.t, v: x.v }));
        check(same(q.automation[lane] || [], want), `${ep.name}: lane ${lane} kept (${json(q.automation[lane])})`);
      }
    });
    check(back.parts[2].voices === 3 && back.parts[0].voices === 1 && back.parts[1].voices === 1, 'voices follow how many notes sound at once (slurs do not count as two)');
    /* channels as written */
    const raw = rawEvents(bytes);
    const chanOf = (i) => Array.from(new Set(raw.tracks[i + 1].filter((e) => e.kind === 0x90).map((e) => e.ch)));
    check(same(chanOf(0), [0]) && same(chanOf(1), [1]) && same(chanOf(2), [2]) && same(chanOf(3), [9]) && same(chanOf(4), [3]) && same(chanOf(5), [4]), `channels: the kit that follows GM keys (kit 6) is on channel 10, the break kit and the others in order (${[0, 1, 2, 3, 4, 5].map((i) => chanOf(i)).join(' ')})`);
    check(midi.parts[3].drums === true && midi.parts[4].drums === false, 'the kit on channel 10 reads back as drums, the break kit as an ordinary part');
    const wheelOf = (i) => raw.tracks[i + 1].filter((e) => e.kind === 0xE0);
    const rpnOf = (i) => raw.tracks[i + 1].filter((e) => e.kind === 0xB0 && e.t === 0 && (e.a === 101 || e.a === 100 || e.a === 6)).map((e) => e.b);
    check(wheelOf(0).length > 0 && same(rpnOf(0).slice(0, 3), [0, 0, 12]) && wheelOf(2).length === 0 && wheelOf(3).length === 0, 'pitch wheel and the RPN 0 range 12 only where a part bends');
    const bendAt = (t) => wheelOf(0).filter((e) => e.t === t).map((e) => ((e.b << 7) | e.a) - 8192);
    check(same(bendAt(192), [-512]) && same(bendAt(204), [0]) && same(bendAt(294), [320]) && same(bendAt(300), [-320]) && same(bendAt(306), [0]), `a note's bend steps are 64 wheel units each (${bendAt(192)} ${bendAt(294)} ${bendAt(300)})`);
    const leadWheel = wheelOf(1).map((e) => [e.t, ((e.b << 7) | e.a) - 8192]);
    check(same(leadWheel, [[600, 341], [700, 0]]), `the pitch lane (50 cents) is the pitch wheel: 341 units at tick 600 (${json(leadWheel)})`);
  }
});
/* ties, legato, cuts, transpose, clipping, ranges, odd projects */
section('E ties and odd projects', () => {
  const trip = (parts, extra) => {
    const p = Object.assign(richProject(), { parts, tempoChanges: [], sections: [], loop: { on: false, startBar: 1, endBar: 4 }, bars: 4, key: null, author: '', comment: '' }, extra || {});
    const bytes = Midi.fromProject(p);
    return { bytes, midi: Midi.parse(bytes), back: Midi.toProject(Midi.parse(bytes), {}), raw: rawEvents(bytes) };
  };
  const brief = (q) => q.notes.map((n) => [n.t, n.n, n.len, !!n.tie]);
  {
    const r = trip([part('p1', 'A', { notes: [note(0, 60, 100, 24, { tie: true }), note(96, 62, 100, 48), note(200, 64, 100, 200, { tie: true }), note(288, 65, 100, 48)] })]);
    check(same(brief(r.back.parts[0]), [[0, 60, 96, true], [96, 62, 48, false], [200, 64, 88, true], [288, 65, 48, false]]), `a slurred note comes back cut at the note it slurs into, short ones extended to it (${json(brief(r.back.parts[0]))})`);
    const ons = r.raw.tracks[1].filter((e) => e.kind === 0x90), offs = r.raw.tracks[1].filter((e) => e.kind === 0x80);
    check(offs.find((e) => e.a === 60).t === 97 && ons.find((e) => e.a === 62).t === 96, 'a slur is written as overlapping notes: the first one ends 1 tick after the next starts');
  }
  {
    const r = trip([part('p1', 'A', { legato: true, notes: [note(0, 60, 100, 48), note(48, 62, 100, 48), note(100, 64, 100, 20)] })]);
    check(same(brief(r.back.parts[0]), [[0, 60, 48, true], [48, 62, 48, false], [100, 64, 20, false]]), `a legato part: touching notes are slurred, a gap is not (${json(brief(r.back.parts[0]))})`);
  }
  {
    const r = trip([part('p1', 'A', { notes: [note(0, 60, 100, 50), note(48, 62, 100, 48), note(200, 64, 100, 70), note(240, 65, 100, 48)] })]);
    check(same(brief(r.back.parts[0]), [[0, 60, 48, false], [48, 62, 48, false], [200, 64, 70, false], [240, 65, 48, false]]), `a note ending 1..3 ticks after the next starts is cut back (so it is not read as a slur), a longer overlap is kept (${json(brief(r.back.parts[0]))})`);
    check(r.back.parts[0].voices === 2, 'a real overlap counts as two voices');
  }
  {
    const r = trip([part('p1', 'A', { notes: [note(0, 60, 100, 15), note(10, 62, 100, 48), note(12, 64, 100, 48), note(14, 65, 100, 48), note(100, 67, 100, 12)] })]);
    check(same(brief(r.back.parts[0]), [[0, 60, 10, false], [10, 62, 48, false], [12, 64, 48, false], [14, 65, 48, false], [100, 67, 12, false]]), `a note ending just after several notes that start a few ticks apart is cut back past all of them (none reads as a slur) (${json(brief(r.back.parts[0]))})`);
    const again = Midi.toProject(Midi.parse(Midi.fromProject(r.back)), {});
    check(same(brief(again.parts[0]), brief(r.back.parts[0])), 'writing and reading a project that came from MIDI changes no note');
  }
  {
    const r = trip([part('p1', 'A', { transpose: -12, notes: [note(0, 72, 100, 24), note(48, 5, 100, 24)] }), part('p2', 'K', { program: 6, transpose: 7, notes: [note(0, 36, 100, 12)] }),
                    part('p3', 'H', { transpose: 60, notes: [note(0, 100, 100, 12), note(48, 40, 100, 12)] })]);
    check(same(r.back.parts[0].notes.map((n) => n.n), [60]) && same(r.back.parts[1].notes.map((n) => n.n), [36]) && same(r.back.parts[2].notes.map((n) => n.n), [100]), `transpose is applied to what is written, a kit on channel 10 is not transposed, notes pushed outside 0..127 are left out (${r.back.parts.map((q) => q.notes.map((n) => n.n))})`);
  }
  {
    const r = trip([part('p1', 'A', { notes: [note(100, 60, 100, 500), note(300, 62, 100, 30)] })], { bars: 1 });
    check(r.midi.parts[0].notes[0].len === 92 && r.back.bars >= 2 && r.midi.endTicks >= 330, `a note starting inside the declared length is cut at its end; one starting after it is kept and the song grows (len ${r.midi.parts[0].notes[0].len}, bars ${r.back.bars})`);
    const q = trip([part('p1', 'A', { notes: [note(0, 60, 100, 48)] })], { bars: 4 });
    check(q.back.bars === 4 && q.midi.endTicks === 4 * BAR, 'trailing silence: the MIDI ends at the declared length, so the bars come back');
  }
  {
    const r = trip([part('p1', 'A', { notes: [note(0, 60, 100, 48, { volume: 30 }), note(48, 62, 100, 48), note(96, 64, 100, 48, { program: 7, expression: 10 }), note(144, 65, 100, 48)] })]);
    const lanes = r.back.parts[0].automation;
    check(same(lanes.volume, [{ t: 0, v: 30 }, { t: 48, v: 75 }]) && same(lanes.expression, [{ t: 96, v: 10 }, { t: 144, v: 64 }]) && same(lanes.program, [{ t: 96, v: 7 }, { t: 144, v: 20 }]),
      `version-1 style settings on single notes are written as controllers and come back as lanes (${json(lanes)})`);
  }
  {
    const r = trip([part('p1', 'A', { tune: 14, notes: [note(0, 60, 100, 48)], automation: { detune: [{ t: 96, v: -10 }], pitch: [{ t: 120, v: 50 }] } }), part('p2', 'B', { tune: 0, notes: [note(0, 60, 100, 48)] })]);
    check(approx(r.back.parts[0].tune, 14, 0.01) && r.back.parts[1].tune === 0, `part tune is channel fine tuning (RPN 1): ${r.back.parts[0].tune}`);
    const w = r.midi.parts[0].bends.map((b) => [b.t, b.v]);
    check(same(w, [[96, -640], [120, -640 + 341]]) , `a detune lane (raw steps) and a pitch lane (cents) add on the wheel: ${json(w)}`);
  }
  {
    const many = [];
    for (let i = 0; i < 20; i++) many.push(part(`p${i + 1}`, `Part ${i + 1}`, { program: 20 + (i % 5), notes: [note(i * 4, 60 + (i % 12), 100, 4)] }));
    const r = trip(many);
    check(r.midi.parts.length === 20 && r.raw.tracks.length === 21 && r.back.parts.length === 20, 'twenty parts: twenty tracks (channels are shared after fifteen), nothing lost');
  }
  {
    const r = trip([part('p1', 'Muted', { mute: true, notes: [note(0, 60, 100, 48)] })]);
    check(r.back.parts.length === 1 && r.back.parts[0].mute === false, 'a muted part is still written');
    const e = Midi.fromProject({ name: 'Empty', bpm: 100, bars: 2, parts: [] });
    let msg = '';
    try { Midi.toProject(Midi.parse(e), {}); } catch (x) { msg = x.message; }
    check(Midi.parse(e).parts.length === 0 && /no notes/.test(msg), 'a project without parts is a valid MIDI file with no notes (and reading it as a project says so)');
    const v1 = { name: 'Old', bpm: 100, tempoChanges: [], bars: 2, loop: { on: false, startBar: 1, endBar: 2 }, markerBars: 2,
                 parts: [{ name: 'A', notes: [{ t: 0, n: 60, v: 90, len: 48 }, { t: 48, n: 64, v: 90, len: 48 }], bank: 0, program: 20, volume: 70, pan: 30, expression: 80, transpose: 0, voices: 1, mute: false, polyphony: 1 }] };
    const back = Midi.toProject(Midi.parse(Midi.fromProject(v1)), {});
    check(back.parts[0].volume === 70 && back.parts[0].pan === 30 && back.parts[0].expression === 80 && back.parts[0].program === 20 && back.parts[0].notes.length === 2 && back.bars === 2, 'a version-1 project (no ids, lanes, devices or version) is accepted');
  }
});
/* the user's own songs, note for note */
section('the user songs', () => { for (const s of G.savedSongs()) {
  const P = s.project, before = json(P);
  let m, back;
  try { m = Midi.parse(Midi.fromProject(P)); back = Midi.toProject(m, {}); } catch (e) { check(false, `${s.file}: ${e.message}`); continue; }
  check(json(P) === before, `${s.file}: the project is not changed by writing it`);
  const shiftOf = (p) => ((p.bank || 0) === 0 && p.program === 6 ? 0 : (p.transpose || 0) | 0);      // a kit that follows GM keys is not transposed
  const playable = P.parts.filter((p) => p.notes.some((n) => n.n + shiftOf(p) >= 0 && n.n + shiftOf(p) <= 127));
  check(back.parts.length === playable.length && back.bars === P.bars && m.ours, `${s.file}: ${playable.length} parts come back, ${P.bars} bars, recognised as our file`);
  check(back.parts.every((q, i) => q.program === playable[i].program && q.bank === (playable[i].bank || 0) && q.volume === playable[i].volume && q.pan === playable[i].pan && q.expression === playable[i].expression), `${s.file}: programs, volumes, pans and expressions of every part kept`);
  let bad = 0, shown = '';
  playable.forEach((p, i) => {
    const q = back.parts[i];
    /* the one documented change of length: a note that would end 1..3 ticks after another one starts is cut there (SLUR_MAX); notes are cut at the song end */
    const starts = p.notes.map((n) => n.t).sort((a, b) => a - b), kit = shiftOf(p) === 0 && (p.bank || 0) === 0 && p.program === 6;
    const ends = p.notes.filter((n) => n.n + shiftOf(p) >= 0 && n.n + shiftOf(p) <= 127).map((n) => {
      let end = n.t + n.len;
      for (;;) {                                         // cut back while it ends 1..3 ticks after a later note starts (a kit on channel 10 is left alone)
        const inside = starts.filter((t) => t > n.t && t < end), last = inside.length ? inside[inside.length - 1] : null;
        if (kit || last === null || end - last > 3) break;
        end = last;
      }
      if (n.t < P.bars * BAR) end = Math.min(end, P.bars * BAR);
      return { t: n.t, n: n.n + shiftOf(p), v: n.v, end };
    });
    /* MIDI pairs each note-off with the earliest unfinished note-on of that pitch: where two notes of one pitch overlap and the later one ends first,
     * the two notes swap their ends (the same sound; it is how every MIDI reader pairs them) */
    const byPitch = new Map();
    for (const x of ends) { if (!byPitch.has(x.n)) byPitch.set(x.n, []); byPitch.get(x.n).push(x); }
    for (const list of byPitch.values()) { list.sort((a, b) => a.t - b.t); const sortedEnds = list.map((x) => x.end).sort((a, b) => a - b); list.forEach((x, i) => { x.end = sortedEnds[i]; }); }
    const want = ends.map((x) => [x.t, x.n, x.v, x.end - x.t]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const got = q.notes.map((n) => [n.t, n.n, n.v, n.len]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    if (!same(want, got)) { bad++; shown = shown || `${p.name}: ${firstDiff(want, got)}`; }
  });
  check(bad === 0, `${s.file}: every note of every part (time, pitch, velocity, length) comes back (${bad} parts differ; ${shown})`);
  /* bends of single-line parts: the same meaning (shared wheel makes simultaneous notes bend together, which is the one limit) */
  let badBends = 0, shownBend = '', bendParts = 0;
  playable.forEach((p, i) => {
    const q = back.parts[i];
    const starts = p.notes.map((n) => n.t);
    if (new Set(starts).size !== starts.length) return;
    const sorted = p.notes.map((n, k) => ({ n, k })).sort((a, b) => a.n.t - b.n.t);
    if (sorted.some((x, j) => j && x.n.t < sorted[j - 1].n.t + sorted[j - 1].n.len - 3)) return;      // overlapping notes share the wheel
    bendParts++;
    const qs = q.notes.slice().sort((a, b) => a.t - b.t);
    sorted.forEach((x, j) => {
      const limit = j + 1 < sorted.length ? sorted[j + 1].n.t - x.n.t : x.n.len;
      const a = canonBend(x.n.bend, limit), b = canonBend(qs[j].bend, limit);
      if (!same(a, b)) { badBends++; shownBend = shownBend || `${p.name} t ${x.n.t}: ${json(a)} vs ${json(b)}`; }
    });
  });
  check(badBends === 0, `${s.file}: bends of the notes in ${bendParts} single-line parts keep their meaning (${badBends} differ; ${shownBend})`);
} });

/* ================================================================== F. toProject on files from outside */
section('F toProject', () => {
  /* a small band as a file from outside: GM programs, channel 10 drums, no editor mark */
  const lead = [], bass = [], chords = [], pad = [], drums = [], fx = [];
  for (let i = 0; i < 32; i++) lead.push({ t: i * 24, kind: 'note', n: 70 + [0, 2, 4, 5, 7, 9][i % 6], v: 90, len: i % 4 === 3 ? 26 : 24 });     // moving high line; every fourth note overlaps the next by 2
  for (let i = 0; i < 32; i++) bass.push({ t: i * 24, kind: 'note', n: 26 + [0, 0, 7, 5][i % 4], v: 100, len: 20 });
  for (let i = 0; i < 16; i++) for (const k of [0, 7]) chords.push({ t: i * 48, kind: 'note', n: 55 + k, v: 80, len: 50 });                    // dyads with 2 ticks of overlap
  for (let i = 0; i < 8; i++) for (const k of [0, 7]) pad.push({ t: i * 192, kind: 'note', n: 52 + k, v: 70, len: 192 });
  for (let i = 0; i < 32; i++) drums.push({ t: i * 24, kind: 'note', n: i % 8 === 0 ? 36 : i % 8 === 4 ? 38 : 42, v: 100, len: 10 });
  drums.push({ t: 0, kind: 'note', n: 35, v: 120, len: 10 }, { t: 24, kind: 'note', n: 44, v: 60, len: 10 }, { t: 96, kind: 'note', n: 49, v: 100, len: 40 }, { t: 120, kind: 'note', n: 41, v: 90, len: 10 }, { t: 144, kind: 'note', n: 56, v: 90, len: 10 });
  for (let i = 0; i < 2; i++) fx.push({ t: i * 96, kind: 'note', n: 60, v: 80, len: 10 });
  const prog = (v) => ({ t: 0, kind: 'program', value: v });
  const file = Midi.write({ bpm: 128, tracks: [
    { name: 'Drums', channel: 9, events: drums }, { name: 'Bass', channel: 1, events: [prog(33)].concat(bass) }, { name: 'Chords', channel: 2, events: [prog(4)].concat(chords) },
    { name: 'Lead', channel: 3, events: [prog(80)].concat(lead) }, { name: 'Pad', channel: 4, events: [prog(89)].concat(pad) }, { name: 'Noise', channel: 5, events: [prog(120)].concat(fx) }] });
  const m = Midi.parse(file), mBefore = json(m);
  check(!m.ours && m.parts.length === 6, 'a file from outside is not taken for ours');
  const roles = (o) => Midi.toProject(m, o).parts.map((p) => p.role);
  let proj;
  try { proj = Midi.toProject(m, { name: 'band.mid' }); } catch (e) { check(false, `toProject threw: ${e.stack.split('\n').slice(0, 3).join(' | ')}`); }
  if (proj) {
    check(json(m) === mBefore, 'toProject does not change the parsed file it is given');
    check(proj.format === 'sf3project' && proj.version === 2 && proj.name === 'band' && approx(proj.bpm, 128, 0.01) && proj.parts.length === 6 && proj.loop.on && proj.loop.startBar === 1 && proj.loop.endBar === proj.bars, `a version-2 project named after the file, ${proj.bars} bars, loop over all of it`);
    const need = ['id', 'name', 'role', 'color', 'bank', 'program', 'volume', 'expression', 'pan', 'transpose', 'gain', 'tune', 'voices', 'mute', 'solo', 'track', 'loopShift', 'end', 'legato', 'vibrato', 'layer', 'notes', 'automation', 'devices', 'raw'];
    check(proj.parts.every((p) => need.every((k) => k in p)), '04_FORMATS section 1: every part field is there');
    const needTop = ['format', 'version', 'name', 'author', 'comment', 'bpm', 'tempoChanges', 'bars', 'length', 'loop', 'markerBars', 'markers', 'tempoPart', 'leadIn', 'loopRestore', 'autoTune', 'key', 'sections', 'chorusBar', 'parts', 'bank', 'names', 'ui'];
    check(needTop.every((k) => k in proj) && proj.leadIn === 2 && proj.loopRestore === true && proj.autoTune === true, '04_FORMATS section 1: every project field is there, with the defaults for a new song');
    check(same(proj.parts.map((p) => p.role), ['drums', 'bass', 'chords', 'lead', 'pad', 'fx']), `roles guessed: drums on channel 10, the low single line is the bass, notes at once are chords, the high moving line is the lead, held chords a pad, a sound-effect patch is fx (${proj.parts.map((p) => p.role)})`);
    const P = proj.parts;
    check(P[0].bank === 0 && P[0].program === 6, 'GM drums are put on the game\'s kit 6');
    check(P[0].notes.every((n) => [36, 38, 39, 42, 45, 46, 49, 51, 53, 54, 55, 56].includes(n.n)), 'GM drum keys land on keys kit 6 has');
    check(same(P[0].notes.filter((n) => n.t === 0).map((n) => [n.n, n.v]), [[36, 120]]), 'two GM keys on one hit at one tick (35 and 36) play once, at the louder velocity');
    check(P[0].notes.some((n) => n.t === 24 && n.n === 42) && P[0].notes.some((n) => n.t === 96 && n.n === 49) && P[0].notes.some((n) => n.t === 120 && n.n === 45) && P[0].notes.some((n) => n.t === 144 && n.n === 56), 'pedal hat -> closed hat, crash -> crash, tom -> boom, cowbell -> bell');
    const gm = [[35, 36], [36, 36], [37, 39], [38, 38], [39, 39], [40, 38], [41, 45], [42, 42], [43, 45], [44, 42], [45, 45], [46, 46], [47, 45], [48, 45], [49, 49], [50, 45], [51, 51], [52, 49], [53, 51], [54, 54], [55, 49], [56, 56], [57, 49], [59, 51], [69, 53], [70, 55]];
    check(gm.every(([from, to]) => Midi.drumToKit6(from) === to) && Array.from({ length: 61 }, (_, i) => 27 + i).every((k) => [36, 38, 39, 42, 45, 46, 49, 51, 53, 54, 55, 56].includes(Midi.drumToKit6(k))), 'the GM drum key table (35..59, 69, 70) and every key 27..87 mapped to a kit 6 key');
    check(P[1].program === 20 && P[1].volume === 75 && P[1].expression === 64 && P[1].pan === 64, 'bass: the built-in suggestion (program 20, 75 / 64 / 64) for a GM electric bass');
    check(P[3].program === 44 && P[3].volume === 56 && P[3].expression === 52 && P[3].pan === 24 && P[2].program === 60 && P[4].program === 57 && P[4].pan === 108, 'lead, chords and pad: instruments from the GM program, levels from the role');
    check(P[1].transpose === 12 && P.filter((p) => p.role !== 'bass').every((p) => p.transpose === 0), `a bass played below where Capcom's basses sit is lifted by octaves (transpose ${P[1].transpose}); nothing else moves without a catalog`);
    check(P[3].notes.filter((n) => n.tie).length === 7 && P[3].notes.every((n) => !n.tie || n.len === 24) && P[3].voices === 1, `a single line with 2-tick overlaps: the 7 overlapped notes that have a next note are slurred and cut where it starts (${P[3].notes.filter((n) => n.tie).length}, voices ${P[3].voices})`);
    check(P[2].notes.every((n) => !n.tie) && P[2].notes.every((n) => n.len === 50) && P[2].voices === 2 && P[4].voices === 2, `dyads that overlap by 2 ticks are not turned into slurs, and the overlap does not make more voices (voices ${P[2].voices}, ${P[4].voices})`);
    check(P[1].devices.length === 0 && P[0].devices.length === 0 && P[3].devices.length === 1 && P[3].devices[0].type === 'echo' && P[3].devices[0].on === true && P[3].devices[0].delay === 24 && P[3].devices[0].level === 0.5 && P[3].devices[0].pan === 'opposite' && P[2].devices.length === 1 && P[4].devices.length === 1, 'echoes the way Capcom\'s themes use them: lead, chords and pad, not bass and drums');
    check(roles({ echo: false }).length === 6 && Midi.toProject(m, { echo: false }).parts.every((p) => p.devices.length === 0), 'echo: false leaves out the devices');
    check(P.every((p) => Number.isInteger(p.program) && p.program >= 0 && p.program < 128 && p.volume >= 0 && p.volume <= 127 && p.pan >= 0 && p.pan <= 127 && p.voices >= 1 && p.voices <= 4), 'every part has a valid instrument, levels and 1 to 4 voices');
    check(P.every((p) => p.notes.every((n, i, a) => n.t >= 0 && n.len >= 1 && n.v >= 1 && n.v <= 127 && (!i || a[i - 1].t < n.t || (a[i - 1].t === n.t && a[i - 1].n <= n.n)))), 'notes are in order with valid values');
    check(proj.ui && proj.ui.import && proj.ui.import.parts.p2.gmProgram === 33 && proj.ui.import.parts.p2.gmName === 'Electric Bass (finger)' && proj.ui.import.ours === false, 'the GM program and its name are kept for display (ui.import)');
    /* the catalog: an injected suggest, the global one, and the built-in copy */
    const fake = (role, gm) => ({ bank: 3, program: 77, volume: 11, expression: 22, velocity: 33, pan: 44, echo: role === 'lead' ? { delay: 9, level: 0.25 } : null });
    const viaOpt = Midi.toProject(m, { suggest: fake });
    check(viaOpt.parts.filter((p) => p.role !== 'drums').every((p) => p.bank === 3 && p.program === 77 && p.volume === 11 && p.expression === 22 && p.pan === 44) && viaOpt.parts[0].program === 6 && viaOpt.parts[0].volume === 11, 'opts.suggest decides instrument and levels (drums stay on kit 6)');
    check(viaOpt.parts[3].devices.length === 1 && viaOpt.parts[3].devices[0].delay === 9 && viaOpt.parts[3].devices[0].level === 0.25 && viaOpt.parts[2].devices.length === 0, 'and the echo of the suggestion');
    globalThis.SF3Catalog = { suggest: fake };
    const viaGlobal = Midi.toProject(m, {});
    delete globalThis.SF3Catalog;
    check(viaGlobal.parts[3].program === 77 && viaGlobal.parts[2].volume === 11, 'SF3Catalog.suggest is used when that module is loaded');
    const viaBroken = Midi.toProject(m, { suggest: () => { throw new Error('boom'); } });
    check(viaBroken.parts[3].program === 44, 'a suggest that fails falls back to the built-in copy');
    check(Midi.toProject(m, {}).parts[3].program === 44, 'without a catalog the built-in copy of the arranger\'s choices is used');
    /* octave fitting from the catalog's ranges */
    const high = Midi.write({ bpm: 120, tracks: [{ name: 'Lead', channel: 0, events: [prog(80)].concat(Array.from({ length: 12 }, (_, i) => ({ t: i * 24, kind: 'note', n: 96 + (i % 5), v: 90, len: 20 }))) }] });
    const catalog = { programs: { '0:44': { range: { low: 55, high: 76, median: 66 } } } };
    check(Midi.toProject(Midi.parse(high), { catalog }).parts[0].transpose === -12 && Midi.toProject(Midi.parse(high), {}).parts[0].transpose === 0 && Midi.toProject(Midi.parse(high), { catalog, octave: false }).parts[0].transpose === 0, 'a lead centred far above where Capcom plays its instrument comes down an octave (with the catalog\'s range); not without one, not with octave: false');
    check(same(Midi.toProject(Midi.parse(high), { catalog }).parts[0].notes.map((n) => n.n), Array.from({ length: 12 }, (_, i) => 96 + (i % 5))), 'the octave is the part\'s transpose: the notes stay as written');
  }
  /* ours: programs are the game's, a kit is a drums part, an invalid program falls back */
  const ours = Midi.write({ bpm: 100, text: 'sf3music', tracks: [
    { name: 'Break', channel: 0, events: [{ t: 0, kind: 'cc', controller: 0, value: 0 }, { t: 0, kind: 'program', value: 1 }].concat(Array.from({ length: 8 }, (_, i) => ({ t: i * 12, kind: 'note', n: 41 + i, v: 100, len: 12 }))) },
    { name: 'Gone', channel: 1, events: [{ t: 0, kind: 'cc', controller: 0, value: 9 }, { t: 0, kind: 'program', value: 99 }, { t: 0, kind: 'note', n: 60, v: 100, len: 12 }] }] });
  const o = Midi.toProject(Midi.parse(ours), { banks: data.banks });
  check(o.parts[0].program === 1 && o.parts[0].role === 'drums' && o.parts[1].program !== 99 && o.parts[1].bank === 0, 'a file of ours with the game\'s data: kits are drums, a program the game does not have gets a suggestion');
  const o2 = Midi.toProject(Midi.parse(ours), {});
  check(o2.parts[1].program === 99 && o2.parts[1].bank === 9 && o2.parts[0].role === 'drums', 'a file of ours without the game\'s data keeps the programs it names');
  /* markers: loop and sections from a file of outside */
  const marked = smf(1, 480, [[].concat(metaEv(0, 0x03, nameOf('Song')), metaEv(0, 0x59, [1, 0]), metaEv(0, 0x51, [0x07, 0xA1, 0x20]), metaEv(0, 0x06, nameOf('Intro')),
                                  metaEv(480, 0x51, [0x06, 0x1A, 0x80]), metaEv(1440, 0x06, nameOf('loopStart')), metaEv(0, 0x07, nameOf('Verse cue')), metaEv(5760, 0x06, nameOf('loopEnd')), EOT),
                              [].concat(noteOnOff(0, 0, 60, 100, 480), ev(9000, 0xFF, 0x2F, 0))]);
  const mp = Midi.toProject(Midi.parse(marked), { name: 'marked.MID' });
  check(same(mp.sections, [{ bar: 1, name: 'Intro' }, { bar: 2, name: 'Verse cue' }]) && mp.loop.start === 192 && mp.loop.end === 768 && mp.loop.startBar === 2 && mp.loop.endBar === 4 && mp.bars >= 4, `markers loopStart / loopEnd are the loop, others sections (${json(mp.sections)} ${json(mp.loop)})`);
  check(mp.name === 'marked' && same(mp.key, { root: 7, scale: 'major' }) && approx(mp.bpm, 120, 0.01) && mp.tempoChanges.length === 1 && mp.tempoChanges[0].t === 48 && approx(mp.tempoChanges[0].bpm, 150, 0.01), `name from the file name, key signature (1 sharp) is G major, tempo changes at their tick (${json(mp.tempoChanges)})`);
  /* tempo before the first event, duplicates at one tick (some real files have none at 0, others several) */
  const tempoOdd = smf(1, 48, [[].concat(metaEv(48, 0x51, [0x07, 0xA1, 0x20]), EOT), [].concat(metaEv(0, 0x51, [0x08, 0x00, 0x00]), metaEv(0, 0x51, [0x07, 0xA1, 0x20]), metaEv(96, 0x51, [0x06, 0x1A, 0x80]), metaEv(0, 0x51, [0x06, 0x1A, 0x80]), noteOnOff(0, 0, 60, 100, 200), EOT)]);
  const to = Midi.toProject(Midi.parse(tempoOdd), {});
  check(approx(to.bpm, 120, 0.01) && same(to.tempoChanges.map((c) => c.t), [96]) && approx(to.tempoChanges[0].bpm, 150, 0.01), `tempo at tick 0 is the last one written there; a change to the same value is not a change (${to.bpm} ${json(to.tempoChanges)})`);
  /* the real awkward files read as projects as well */
  for (const f of Object.keys(awkwardParsed)) {
    const mm = awkwardParsed[f], before = json(B.canon(mm));
    let pr;
    try { pr = Midi.toProject(mm, { name: f, banks: data.banks }); } catch (e) { check(false, `${f}: toProject threw ${e.message}`); continue; }
    const old = Project.fromMidi(f, mm, data.banks);
    check(json(B.canon(mm)) === before, `${f}: toProject leaves the parsed file alone`);
    check(pr.version === 2 && pr.parts.length === old.parts.length && pr.parts.every((p, i) => p.name === mm.parts[i].name) && pr.bars === old.bars && approx(pr.bpm, old.bpm, 0.06),
      `${f}: as a project it has ${pr.parts.length} parts like fromMidi (${old.parts.length}), ${pr.bars} bars (${old.bars}), ${pr.bpm} BPM (${old.bpm})`);
    check(pr.tempoChanges.every((c, i, a) => c.t > 0 && (!i || c.t > a[i - 1].t) && c.bpm !== (i ? a[i - 1].bpm : pr.bpm)), `${f}: tempo changes in order, after tick 0, each a real change (${pr.tempoChanges.length})`);
    const echoTracks = pr.parts.reduce((a, p) => a + p.voices * p.devices.filter((d) => d.type === 'echo' && d.on).length, 0), voiceTracks = pr.parts.reduce((a, p) => a + p.voices, 0);
    check(echoTracks === 0 || voiceTracks + echoTracks <= 16, `${f}: echoes are only added while the 16 driver tracks last (${voiceTracks} voices + ${echoTracks} for echoes)`);
    check(pr.parts.every((p, i) => p.notes.length <= old.parts[i].notes.length && (p.role === 'drums' ? p.notes.length > 0 : p.notes.length === old.parts[i].notes.length)), `${f}: no note is lost (drums may merge two keys onto one hit)`);
    check(pr.parts.every((p) => ['drums', 'perc', 'bass', 'chords', 'pad', 'lead', 'arp', 'fx'].includes(p.role)) && pr.parts.filter((p) => p.role === 'bass').length <= 1, `${f}: every part has a role from the list, at most one bass (${pr.parts.map((p) => p.role).join(' ')})`);
    const drumSrc = mm.parts.map((p, i) => [p, i]).filter(([p]) => p.drums);
    check(drumSrc.every(([, i]) => pr.parts[i].bank === 0 && pr.parts[i].program === 6 && pr.parts[i].role === 'drums'), `${f}: channel 10 parts are drums on kit 6`);
  }
});

done('MIDI in and out');
