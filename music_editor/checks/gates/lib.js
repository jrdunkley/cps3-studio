/* Shared by the Studio's gates (docs/plan/06_GATES.md). The one question most gates ask is
 * "do these two sequences SOUND the same in the game's driver?". The plan's answer:
 *
 *   SOUND-IDENTICAL = the driver, booted in STEREO, renders the same audio for both, sample for
 *   sample, on both sides, for the whole compared length.
 *
 *   audio(setup, frames)          renders in stereo and returns { L, R, n } (raw integer mix).
 *   firstAudioDifference(a, b)    null when identical, else { sample, frame, seconds, side }.
 *   soundLog(setup, frames)       for DIAGNOSIS only: every chip write per frame (voice registers and
 *                                 key mask). Use it to see what differs at the frame the audio parts.
 *                                 It is not the criterion: writes to a silent voice do not matter.
 *
 * Stereo, because in mono (what Fightcade plays) pan is inaudible and a wrong pan would pass.
 * Never loosen a comparison to make a gate pass. If a gate fails, the code under test is wrong or the
 * plan needs a decision: say so, do not edit the gate.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..', '..');
require(path.join(root, 'data', 'pack.js'));
const { Engine } = require(path.join(root, 'js', 'engine.js'));
const Seq = require(path.join(root, 'js', 'seq.js'));
const Data = require(path.join(root, 'js', 'gamedata.js'));
const Project = require(path.join(root, 'js', 'project.js'));
const pack = globalThis.SF3_PACK;
const PREVIEW = 60;

function soundLog(setup, frames, options) {
  const log = [];
  const e = new Engine(pack, Object.assign({ log }, options || {}));
  log.length = 0;                                  /* drop the boot lines: both sides boot alike */
  setup(e);
  for (let f = 0; f < frames; f++) e.step();
  const out = [];
  let cur = null;
  for (const line of log) {
    if (line.charCodeAt(0) === 70 /* F */) { cur = []; out.push(cur); continue; }
    if (line.charCodeAt(0) === 72 /* H */) continue;
    if (cur) cur.push(line);
  }
  return out;                                       /* out[frame] = [ 'offset value', ... ] in write order */
}
/* the driver's init with the stereo switch on (second stack argument; checks/command_check.js) */
function stereoEngine() {
  const e = new Engine(pack);
  e.ram.fill(0); e.regs.fill(0); e.pos.fill(0); e.frac.fill(0); e.key = 0; e.cfg = 0; e.acc = 0; e.frame = 0;
  const cpu = e.cpu;
  cpu.r.fill(0); cpu.sr = 0; cpu.gbr = 0; cpu.vbr = 0; cpu.mach = 0; cpu.macl = 0; cpu.r[15] = 0x0200C000;
  e.call(0x06139310, 0x40);
  cpu.r[15] -= 8; e.w32(cpu.r[15], 0); e.w32(cpu.r[15] + 4, 1);
  e.call(0x06139316, 0x0678F000, 0x0678C000, 0x06788000, 1);
  cpu.r[15] += 8;
  return e;
}
function audio(setup, frames) {
  const e = stereoEngine();
  setup(e);
  const cap = frames * 627 + 64, L = new Int32Array(cap), R = new Int32Array(cap);
  let n = 0;
  for (let f = 0; f < frames; f++) n += e.step(L, R, n);
  return { L, R, n, frames };
}
function firstAudioDifference(a, b) {
  const n = Math.min(a.n, b.n);
  for (let i = 0; i < n; i++) {
    if (a.L[i] !== b.L[i] || a.R[i] !== b.R[i]) return { sample: i, frame: Math.floor(i / 625.63), seconds: +(i / 37286.89).toFixed(3), side: a.L[i] !== b.L[i] ? 'left' : 'right', a: [a.L[i], a.R[i]], b: [b.L[i], b.R[i]] };
  }
  return a.n === b.n ? null : { sample: n, frame: Math.floor(n / 625.63), seconds: +(n / 37286.89).toFixed(3), side: 'length', a: [a.n], b: [b.n] };
}
const playCode = (code) => (e) => e.request(code);
const playBytes = (bytes) => (e) => { e.patchSequence(bytes, PREVIEW, 0); e.request(PREVIEW); };

function firstDifference(a, b) {
  const n = Math.min(a.length, b.length);
  for (let f = 0; f < n; f++) {
    const x = a[f], y = b[f];
    if (x.length !== y.length || x.some((line, i) => line !== y[i])) {
      const i = x.findIndex((line, k) => line !== y[k]);
      return { frame: f, index: i < 0 ? Math.min(x.length, y.length) : i, a: x.slice(Math.max(0, i), i + 3), b: y.slice(Math.max(0, i), i + 3), writes: [x.length, y.length] };
    }
  }
  return a.length === b.length ? null : { frame: n, a: ['(ends)'], b: ['(ends)'], writes: [a.length, b.length] };
}
/* frames needed to hear a song's introduction and `passes` passes of its loop (or all of a piece that plays once) */
function framesFor(info, passes, cap) {
  const ticks = info.loopLength ? info.loopStart + (passes || 2) * info.loopLength : Math.max(...info.tracks.map((t) => t.end || 0)) + 96;
  return Math.min(cap || 14400, Math.ceil(ticks * 256 / (info.tempo || 464)) + 30);
}
function loadData() {
  const engine = new Engine(pack);
  return { engine, data: Data.load(engine, pack.names) };
}
/* saved version-1 songs: the original test songs in fixtures/songs (fixtures/make_songs.js), or the folder STUDIO_SONGS names */
function savedSongs() {
  const dir = process.env.STUDIO_SONGS ? path.resolve(process.env.STUDIO_SONGS) : path.join(__dirname, 'fixtures', 'songs');
  return fs.readdirSync(dir).filter((f) => f.endsWith('.sf3song.json')).map((f) => {
    const song = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    return { file: f, song, project: song.project, bytes: new Uint8Array(Buffer.from(song.sequence_b64, 'base64')) };
  });
}
function gate(name) {
  let failed = 0, checks = 0;
  const check = (ok, what) => { checks++; if (!ok) { failed++; console.log('FAIL', what); } return ok; };
  const done = (summary) => { console.log(`${name}: ${summary ? summary + '; ' : ''}${checks} checks, ${failed} failures`); process.exit(failed ? 1 : 0); };
  return { check, done };
}
/* a module the plan asks for; a clear message while it does not exist yet */
function need(file) {
  const full = path.join(root, file);
  if (!fs.existsSync(full)) { console.log(`NOT BUILT YET: ${file} (see docs/plan)`); process.exit(2); }
  return require(full);
}

module.exports = { root, pack, Engine, Seq, Data, Project, PREVIEW, stereoEngine, audio, firstAudioDifference, soundLog, playCode, playBytes, firstDifference, framesFor,
                   loadData, savedSongs, gate, need };
