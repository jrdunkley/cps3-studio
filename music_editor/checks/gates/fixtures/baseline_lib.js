/* Shared by checks/gates/g_midi.js (G16) and fixtures/record_midi_baseline.js: how "the same result as
 * before package A10" is measured. Only the fields the old js/midi.js produced take part; fields A10
 * added are ignored. The old module is loaded from the frozen copy with a private global object, so it
 * never replaces the live SF3Midi.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function loadFrozen() {
  const src = fs.readFileSync(path.join(__dirname, 'midi_v1_frozen.js'), 'utf8');
  const m = { exports: {} };
  new Function('module', 'window', src)(m, {});
  return m.exports;
}
const sha = (x) => crypto.createHash('sha256').update(typeof x === 'string' || x instanceof Uint8Array ? x : JSON.stringify(x)).digest('hex');

/* the part fields the old parse gave, in a fixed order; arrays as rows so the hash does not depend on key order */
function canonPart(p) {
  return {
    track: p.track, channel: p.channel, name: p.name, program: p.program, bank: p.bank, volume: p.volume, pan: p.pan, expression: p.expression,
    bendRange: p.bendRange, drums: p.drums, polyphony: p.polyphony,
    notes: p.notes.map((n) => [n.t, n.n, n.v, n.len]),
    bends: p.bends.map((b) => [b.t, b.v]),
    controls: p.controls.map((c) => [c.t, c.c, c.v]),
  };
}
function canon(m) {
  return { format: m.format, division: m.division, parts: m.parts.map(canonPart), tempo: m.tempo.map((x) => [x.t, x.bpm]),
           timeSignature: m.timeSignature, lengthTicks: m.lengthTicks, ours: m.ours };
}
/* what the fixture file stores about one parsed file: counts and hashes only, never the music */
function summary(m, bytes) {
  const c = canon(m);
  return {
    bytes: bytes.length, sha256: sha(bytes), format: m.format, division: m.division, lengthTicks: m.lengthTicks, ours: m.ours, timeSignature: m.timeSignature,
    tempo: { count: m.tempo.length, first: m.tempo[0] || null, last: m.tempo[m.tempo.length - 1] || null, sha256: sha(c.tempo) },
    parts: c.parts.map((p) => ({ track: p.track, channel: p.channel, name: p.name, program: p.program, bank: p.bank, volume: p.volume, pan: p.pan, expression: p.expression,
      notes: p.notes.length, polyphony: p.polyphony, bends: p.bends.length, bendRange: p.bendRange, controls: p.controls.length, drums: p.drums,
      firstNote: p.notes.length ? p.notes[0] : null, lastNote: p.notes.length ? p.notes[p.notes.length - 1] : null, notesSha256: sha(p.notes) })),
    parseSha256: sha(c),
  };
}

/* Midi.write inputs of the kind the editor gives it today (project_test.js, Project.gameMidi); fresh objects on every call
 * because write sorts its events in place. Deterministic: a small linear generator, no Math.random. */
function writeSamples() {
  let seed = 12345;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7FFFFFFF; return seed % n; };
  const out = [];
  out.push({ name: 'piano chord and drums', song: { bpm: 100, tracks: [
    { name: 'Piano', channel: 0, events: [{ t: 0, kind: 'program', value: 0 }, { t: 0, kind: 'note', n: 60, v: 100, len: 48 }, { t: 0, kind: 'note', n: 64, v: 100, len: 48 }] },
    { name: 'Drums', channel: 9, events: [{ t: 0, kind: 'note', n: 36, v: 100, len: 12 }] }] } });
  const busy = [];
  for (let i = 0; i < 400; i++) busy.push({ t: rnd(4000), kind: 'note', n: rnd(140) - 6, v: rnd(260) - 20, len: rnd(120) - 4 });
  busy.push({ t: 0, kind: 'cc', controller: 0, value: 3 }, { t: 0, kind: 'program', value: 77 }, { t: 5, kind: 'cc', controller: 7, value: 100 },
            { t: 5, kind: 'cc', controller: 11, value: 127 }, { t: 9, kind: 'cc', controller: 10, value: 200 }, { t: 3000, kind: 'program', value: 130 });
  out.push({ name: 'tempo changes, text, controllers, odd values', song: { bpm: 128.5, text: 'sf3music', tempoChanges: [{ t: 384, bpm: 140 }, { t: 960, bpm: 90.25 }, { t: 960, bpm: 91 }], tracks: [
    { name: 'Frédéric ♪', channel: 17, events: busy },
    { name: '', channel: 3, events: [] },
    { name: 'x'.repeat(130), channel: 4, events: [{ t: 10, kind: 'note', n: 60, v: 64, len: 3 }, { t: 10, kind: 'note', n: 60, v: 64, len: 3 }, { t: 13, kind: 'note', n: 61, v: 64, len: 1 }] }] } });
  out.push({ name: 'long delays and lengths', song: { bpm: 60, tracks: [{ name: 'Long', channel: 1, events: [{ t: 0, kind: 'note', n: 40, v: 80, len: 100000 }, { t: 300000, kind: 'note', n: 41, v: 80, len: 5 }] }] } });
  return out;
}
module.exports = { loadFrozen, sha, canon, canonPart, summary, writeSamples };
