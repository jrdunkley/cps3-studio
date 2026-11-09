/* GATE G6 (docs/plan/06_GATES.md): the compiler's devices and rules do what 04_FORMATS §1-2 says.
 *
 *   node checks/gates/g_devices.js
 *
 * Proofs by AUDIO (lib.audio, same stereo samples) where a device has an exact equivalent the compiler
 * must agree with: echo (and repeats) = a hand-made part with the notes and lanes moved `delay` later,
 * expression × level, pan opposite and the loop shifted by the delay; double = a hand-made part moved by
 * the offset with the detune as the part's tune; harmony = a hand-made part transposed by the interval at
 * level; legato = explicit ties; the compressed build = the plain build. Each audio proof also checks the
 * device is heard at all (the song without it differs).
 *
 * Proofs by the compiled events (Seq events of each track, first pass, sequence ticks): duck, gate,
 * auto-pan, glide (C9), swing, humanize, slur (tie bit; one key-on, counted in the driver), delayed
 * vibrato (C5 0 then the depth), pitch in cents (C3/E7, no E7 for whole steps), auto-tune (catalog
 * cents, only when the measurement is sure), track order, pins, the 17th-track warning, report.partTracks,
 * post/pre points, negative ticks, explicit markers, part end, length, loop ticks, tempo changes,
 * velocities, dropped notes, includeMuted, the argument unchanged, same input -> same bytes.
 *
 * Proofs by WHAT THE CHIP PLAYS per frame for loopRestore, cycle playback (`range`) and the chorus entry:
 * after every driver frame, the key mask, the voices keyed on in that frame and all sixteen registers of
 * every voice that sounds. Their audio cannot be sample-identical in general: the song reaches the bar at
 * a fractional tick phase and a different chip-sample phase. So these test songs use tempo word 512
 * (exactly two ticks per frame), every note ends before the bar lines that matter, and the gate compares
 * every frame from the frame the song reaches the bar, through one pass and the first loop back (frame
 * offsets follow exactly from two ticks per frame). Raw chip writes are not compared: the driver keeps
 * writing the last note's pitch to a voice that is silent, which cannot be heard (found 2026-10-02: voice
 * 1's step register differed between passes while voice 1 was keyed off). A hand-broken build shows each
 * comparison has teeth (it must differ).
 *
 * Exit 0 only when all pass; 2 while js/compile.js does not exist.
 */
'use strict';
const G = require('./lib.js');
const Compile = G.need('js/compile.js');
const { check, done } = G.gate('G6 devices');
const Seq = G.Seq, BAR = Seq.BAR, LEAD = Seq.LEAD_IN;
const clone = (x) => JSON.parse(JSON.stringify(x));
/* the same value with every object's keys in another order (reversed) */
const reorder = (x) => (Array.isArray(x) ? x.map(reorder) : x && typeof x === 'object' ? Object.keys(x).reverse().reduce((o, k) => { o[k] = reorder(x[k]); return o; }, {}) : x);
const sameBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const s8 = (v) => (v << 24) >> 24;
const T512 = Seq.tempoToBpm(512);
check(Seq.bpmToTempo(T512) === 512, 'tempo 512 is reachable from a bpm');

/* ---- test songs ------------------------------------------------------------------------------- */
function song(parts, extra) {
  return Object.assign({ format: 'sf3project', version: 2, name: 'G6', author: '', comment: '', bpm: 131, tempoChanges: [], bars: 4, length: null,
    loop: { on: true, startBar: 2, endBar: 4, start: 192, end: 768 }, markerBars: 2, markers: null, tempoPart: null, leadIn: 2,
    loopRestore: true, autoTune: false, key: null, sections: [], chorusBar: null, parts, bank: null, names: {}, ui: {} }, extra || {});
}
function part(id, o) {
  return Object.assign({ id, name: id, role: null, bank: 0, program: 43, volume: 80, expression: 100, pan: 40, transpose: 0, gain: 0, tune: 0,
    voices: 1, mute: false, solo: false, track: null, loopShift: 0, end: null, legato: false,
    vibrato: { depth: 0, rate: 100, sync: true, delay: 0, tremolo: 0 }, layer: null, notes: [], automation: {}, devices: [], raw: [] }, o || {});
}
/* a single line: 8 notes a bar, every note ends before the next starts (and before the bar line) */
function melody(bars, o) {
  o = o || {};
  const pitches = [69, 72, 76, 74, 71, 67, 64, 65], lens = [18, 20, 12, 22], out = [];
  for (let b = 0; b < bars; b++) for (let i = 0; i < 8; i++)
    out.push({ t: b * BAR + i * 24, n: pitches[(i + b * 3) % 8] + (o.oct || 0), v: 40 + ((i * 13 + b * 7) % 80), len: lens[(i + b) % 4] });
  return out;
}
function framesFor(P, extraTicks) {
  const loop = P.loop.on ? P.loop.start + 1.25 * (P.loop.end - P.loop.start) : P.bars * BAR;
  return Math.ceil((LEAD + loop + 96 + (extraTicks || 0)) * 256 / Seq.bpmToTempo(P.bpm)) + 30;
}
const built = (P, o) => Compile.build(clone(P), o);
const audioOf = (bytes, frames) => G.audio(G.playBytes(bytes), frames);
function soundSame(a, b, frames, what) {
  const d = G.firstAudioDifference(audioOf(a, frames), audioOf(b, frames));
  return check(!d, `${what}${d ? `: differs at ${d.seconds} s (frame ${d.frame}, ${d.side})` : ''}`);
}
function soundDiffers(a, b, frames, what) {
  return check(!!G.firstAudioDifference(audioOf(a, frames), audioOf(b, frames)), `${what} (it is heard: the song without it differs)`);
}
/* a track's events, first pass, with sequence ticks */
function flat(ev) { let s = 0; return ev.map((e) => { s += e.d; return Object.assign({ s }, e); }); }
const notesOf = (list) => list.filter((e) => e.k === 'note');
/* the value of command `op` in force at event index i (commands before it, in order) */
function before(list, i, op) { let v; for (let j = 0; j < i; j++) if (list[j].k === 'cmd' && list[j].op === op) v = list[j].a; return v; }
/* the value of command `op` in force once everything at sequence tick s has run (notes included) */
function atTick(list, s, op) { let v; for (const e of list) { if (e.s > s) break; if (e.k === 'cmd' && e.op === op) v = e.a; } return v; }
function trackOf(b, partId, kind, voice) {
  const t = b.report.tracks.find((x) => x.partId === partId && (kind ? x.kind === kind : x.kind === 'voice') && (voice === undefined || x.voice === voice));
  return t ? flat(b.plainTracks[t.track]) : null;
}
function shiftLanes(auto, dt, map) {
  const out = {};
  for (const k of Object.keys(auto || {})) out[k] = auto[k].map((p) => Object.assign({}, p, { t: p.t + dt, v: map && map[k] ? map[k](p.v) : p.v }));
  return out;
}

/* ---- 1. echo, double, harmony: audio against hand-made parts ---------------------------------- */
{
  const lead = part('lead', { notes: melody(4), automation: { expression: [{ t: 0, v: 90 }, { t: 400, v: 70 }], pan: [{ t: 300, v: 30 }] } });
  const base = song([lead, part('bass', { program: 20, pan: 64, notes: melody(4, { oct: -24 }).filter((n, i) => i % 2 === 0) })]);
  const frames = framesFor(base, 48);
  const plainBase = built(base).bytes;

  const echoP = clone(base); echoP.parts[0].devices = [{ type: 'echo', on: true, delay: 24, level: 0.5, pan: 'opposite' }];
  const handEcho = clone(base);
  handEcho.parts.push(part('lead_e', Object.assign({}, clone(lead), { id: 'lead_e', name: 'lead_e', expression: 50, pan: 127 - 40, loopShift: 24,
    notes: lead.notes.map((n) => Object.assign({}, n, { t: n.t + 24 })),
    automation: shiftLanes(lead.automation, 24, { expression: (v) => v * 0.5, pan: (v) => 127 - v }) })));
  const be = built(echoP), bh = built(handEcho);
  check(be.report.tracks.length === 3 && be.report.tracks[2].kind === 'echo' && be.report.tracks[2].partId === 'lead', 'echo: one extra track, after every part\'s own voices');
  soundSame(be.bytes, bh.bytes, frames, 'echo = the source 24 ticks later at level 0.5, pan opposite (hand-shifted part)');
  soundDiffers(be.bytes, plainBase, frames, 'echo');

  const echo2 = clone(base); echo2.parts[0].devices = [{ type: 'echo', delay: 24, level: 0.5, pan: 'opposite', repeats: 2 }];
  const hand2 = clone(handEcho);
  hand2.parts.push(part('lead_e2', Object.assign({}, clone(lead), { id: 'lead_e2', name: 'lead_e2', expression: 25, pan: 127 - 40, loopShift: 48,
    notes: lead.notes.map((n) => Object.assign({}, n, { t: n.t + 48 })),
    automation: shiftLanes(lead.automation, 48, { expression: (v) => v * 0.25, pan: (v) => 127 - v }) })));
  const be2 = built(echo2);
  check(be2.report.tracks.filter((t) => t.kind === 'echo').length === 2, 'echo with 2 repeats: two echo tracks');
  soundSame(be2.bytes, built(hand2).bytes, framesFor(base, 96), 'echo, 2 repeats = copies 24 and 48 ticks later at 0.5 and 0.25');

  const dbl = clone(base); dbl.parts[0].devices = [{ type: 'double', offset: 2, detune: 10 }];
  const handD = clone(base);
  handD.parts.push(part('lead_d', Object.assign({}, clone(lead), { id: 'lead_d', name: 'lead_d', pan: 127 - 40, tune: 10, loopShift: 2,
    notes: lead.notes.map((n) => Object.assign({}, n, { t: n.t + 2 })), automation: shiftLanes(lead.automation, 2, { pan: (v) => 127 - v }) })));
  const bd = built(dbl);
  check(bd.report.tracks.filter((t) => t.kind === 'double').length === 1, 'double: one extra track');
  soundSame(bd.bytes, built(handD).bytes, frames, 'double = the source 2 ticks later, 10 cents up, pan opposite (hand-made part)');
  soundDiffers(bd.bytes, plainBase, frames, 'double');

  const har = clone(base); har.parts[0].devices = [{ type: 'harmony' }];
  const handH = clone(base);
  handH.parts.push(part('lead_h', Object.assign({}, clone(lead), { id: 'lead_h', name: 'lead_h', transpose: -7, expression: 70,
    automation: shiftLanes(lead.automation, 0, { expression: (v) => v * 0.7 }) })));
  const bhh = built(har);
  check(bhh.report.tracks.filter((t) => t.kind === 'harmony').length === 1, 'harmony: one extra track');
  soundSame(bhh.bytes, built(handH).bytes, frames, 'harmony = the source a fifth down at level 0.7 (hand-made part)');
  soundDiffers(bhh.bytes, plainBase, frames, 'harmony');

  /* echo on chosen voices only */
  const chordsP = song([part('ch', { voices: 2, notes: melody(4).flatMap((n) => [n, Object.assign({}, n, { n: n.n - 5 })]), devices: [{ type: 'echo', voices: [1] }] })]);
  const bc = built(chordsP);
  const echoes = bc.report.tracks.filter((t) => t.kind === 'echo');
  check(echoes.length === 1 && echoes[0].voice === 1, 'echo voices [1]: one echo track, for the second voice');
  if (echoes.length === 1) {
    const v1 = notesOf(trackOf(bc, 'ch', 'voice', 1)), e1 = notesOf(flat(bc.plainTracks[echoes[0].track]));
    check(v1.length === e1.length && v1.every((n, i) => e1[i].s === n.s + 24 && e1[i].n === n.n && e1[i].len === n.len && e1[i].v === n.v), 'echo voices [1]: the echo plays voice 2\'s notes 24 ticks later');
  }

  /* compression keeps the sound of the device song */
  soundSame(built(echo2, { compress: true }).bytes, be2.bytes, framesFor(base, 96), 'echo song: compressed = plain');
}

/* ---- 2. duck ------------------------------------------------------------------------------------ */
{
  const kick = part('kick', { program: 6, pan: 64, notes: Array.from({ length: 16 }, (_, i) => ({ t: i * 48, n: 36, v: 100, len: 12 })) });
  const pad = part('pad', { program: 57, expression: 100, notes: [0, 1, 2, 3].map((b) => ({ t: b * BAR, n: 57, v: 90, len: 190 })),
    devices: [{ type: 'duck', source: 'kick', depth: 0.6, hold: 6, release: 24 }] });
  const P = song([kick, pad]);
  const b = built(P), list = trackOf(b, 'pad');
  const ex = (t) => { const a = atTick(list, t + LEAD, 0xC8); return a ? a[0] : null; };
  let okDip = 0, okBack = 0, okHold = 0, okRamp = 0;
  for (const n of kick.notes) {
    if (ex(n.t) === 40) okDip++;
    if (ex(n.t + 5) === 40) okHold++;
    if (ex(n.t + 30) === 100) okBack++;
    let prev = 40, mono = true;
    for (let x = 6; x <= 30; x++) { const v = ex(n.t + x); if (v === null || v < prev || v > 100) mono = false; else prev = v; }
    if (mono && ex(n.t + 18) === 70) okRamp++;
  }
  check(okDip === 16, `duck: expression 100 x (1 - 0.6) = 40 at every kick (${okDip} of 16)`);
  check(okHold === 16, `duck: held for 6 ticks (${okHold} of 16)`);
  check(okRamp === 16, `duck: rises steadily over 24 ticks, 70 half way (${okRamp} of 16)`);
  check(okBack === 16, `duck: back to 100 after hold + release (${okBack} of 16)`);
  const c8 = list.filter((e) => e.k === 'cmd' && e.op === 0xC8 && e.s >= LEAD + 8);
  check(c8.every((e, i) => i === 0 || e.s - c8[i - 1].s >= 2), 'duck: at most one expression command per 2 ticks');
  check(notesOf(trackOf(b, 'kick')).length === 16 && !trackOf(b, 'kick').some((e) => e.k === 'cmd' && e.op === 0xC8 && e.s > LEAD + 1), 'duck: the source part is untouched');

  /* keys filter, and the source's swing moves the dips */
  const drums = part('drums', { program: 6, pan: 64, devices: [{ type: 'swing', amount: 0.5, unit: 24 }],
    notes: Array.from({ length: 8 }, (_, i) => [{ t: i * 96, n: 36, v: 100, len: 8 }, { t: i * 96 + 24, n: 38, v: 100, len: 8 }]).flat() });
  const pad2 = Object.assign(clone(pad), { devices: [{ type: 'duck', source: 'drums', keys: [38], depth: 0.6, hold: 6, release: 24 }] });
  const b2 = built(song([drums, pad2])), l2 = trackOf(b2, 'pad');
  const ex2 = (t) => { const a = atTick(l2, t + LEAD, 0xC8); return a ? a[0] : null; };
  let swungDip = 0, notAtGrid = 0, notOther = 0;
  for (let i = 0; i < 8; i++) {
    if (ex2(i * 96 + 36) === 40) swungDip++;
    if (ex2(i * 96 + 24) === 100) notAtGrid++;
    if (ex2(i * 96) === 100) notOther++;
  }
  check(swungDip === 8, `duck: dips at the source's swung notes (${swungDip} of 8)`);
  check(notAtGrid === 8, `duck: not at their unswung ticks (${notAtGrid} of 8)`);
  check(notOther === 8, `duck keys [38]: no dip at the other drum (${notOther} of 8)`);
}

/* ---- 3. gate -------------------------------------------------------------------------------------- */
{
  const pattern = [1, 0, 0.5, 0, 1, 1, 0, 0.25, 1, 0, 0.75, 0, 1, 0, 1, 0];
  for (const depth of [1, 0.8]) {
    const g = part('g', { program: 57, notes: [0, 1, 2, 3].map((bb) => ({ t: bb * BAR, n: 60, v: 90, len: 190 })), devices: [{ type: 'gate', pattern, depth, step: 12 }] });
    const b = built(song([g])), list = trackOf(b, 'g');
    let ok = 0, n = 0;
    for (let t = 0; t < 768; t += 12) {
      n++;
      const want = Math.round(100 * (1 - depth * (1 - pattern[(t / 12) % 16]))), a = atTick(list, t + LEAD, 0xC8);
      if (a && a[0] === want) ok++;
    }
    check(ok === n, `gate depth ${depth}: expression follows the pattern every 12 ticks (${ok} of ${n} steps)`);
  }
  const fine = part('g', { program: 57, notes: [{ t: 0, n: 60, v: 90, len: 760 }], devices: [{ type: 'gate', pattern: [1, 0, 0, 1], depth: 1, step: 1 }] });
  const lf = trackOf(built(song([fine])), 'g').filter((e) => e.k === 'cmd' && e.op === 0xC8 && e.s >= LEAD);
  check(lf.length > 10 && lf.every((e, i) => i === 0 || e.s - lf[i - 1].s >= 2), 'gate with a 1-tick step: at most one expression command per 2 ticks');
}

/* ---- 4. auto-pan, glide, swing, humanize ------------------------------------------------------------ */
{
  const notes = melody(1); notes[3].pan = 10;
  const ap = part('ap', { notes, devices: [{ type: 'autopan', width: 48, center: 64 }] });
  const list = trackOf(built(song([ap], { bars: 1, loop: { on: false } })), 'ap');
  let ok = 0;
  notesOf(list).forEach((n, k) => { const idx = list.indexOf(n), pan = before(list, idx, 0xC7)[0]; if (pan === (k === 3 ? 10 : k % 2 ? 88 : 40)) ok++; });
  check(ok === 8, `auto-pan: 40 / 88 alternating per note, a note's own pan kept (${ok} of 8)`);
}
{
  const ns = [{ t: 0, n: 60, v: 90, len: 24, tie: true }, { t: 24, n: 64, v: 90, len: 24 }, { t: 72, n: 67, v: 90, len: 24 }, { t: 96, n: 65, v: 90, len: 24 }, { t: 120, n: 62, v: 90, len: 24 }];
  const slide = (dev, legato) => {
    const l = trackOf(built(song([part('gl', { notes: clone(ns), legato: !!legato, devices: dev ? [dev] : [] })], { bars: 1, loop: { on: false } })), 'gl');
    return notesOf(l).map((n) => { const a = before(l, l.indexOf(n), 0xC9); return a ? a[0] : 0; });
  };
  const s1 = slide({ type: 'glide', mode: 'slurred', rate: 40 });
  check(JSON.stringify(s1) === JSON.stringify([0, 40, 0, 0, 0]), `glide slurred: C9 40 before the slurred note only, C9 0 after (${s1})`);
  const s2 = slide({ type: 'glide', mode: 'all', rate: 40 });
  check(JSON.stringify(s2) === JSON.stringify([0, 40, 40, 40, 40]), `glide all: every note after the first (${s2})`);
  const s3 = slide({ type: 'glide', mode: 'slurred', rate: 40 }, true);
  check(JSON.stringify(s3) === JSON.stringify([0, 40, 0, 40, 40]), `glide slurred with legato: touching notes glide, the note after a gap does not (${s3})`);
  const l4 = trackOf(built(song([part('gl', { notes: clone(ns), devices: [{ type: 'glide', mode: 'slurred', rate: 40 }] })], { bars: 1, loop: { on: false } })), 'gl');
  const i2 = l4.indexOf(notesOf(l4)[1]), i3 = l4.indexOf(notesOf(l4)[2]);
  check(l4[i2 - 1].k === 'cmd' && l4[i2 - 1].op === 0xC9 && l4[i2 - 1].a[0] === 40 && l4[i2 - 1].s === l4[i2].s, 'glide: C9 written on the note\'s own tick, just before it');
  check(l4[i3 - 1].k === 'cmd' && l4[i3 - 1].op === 0xC9 && l4[i3 - 1].a[0] === 0 && l4[i3 - 1].s === l4[i3].s, 'glide: C9 0 just before the next note that does not glide');
  check(slide(null).every((v) => v === 0) && !trackOf(built(song([part('gl', { notes: clone(ns) })], { bars: 1, loop: { on: false } })), 'gl').some((e) => e.k === 'cmd' && e.op === 0xC9), 'no glide: no C9 at all');
}
{
  const ns = Array.from({ length: 16 }, (_, i) => ({ t: i * 24, n: 60 + (i % 5), v: 90, len: 20 }));
  const l = notesOf(trackOf(built(song([part('sw', { notes: ns, devices: [{ type: 'swing', amount: 0.5, unit: 24 }] })], { bars: 2, loop: { on: false } })), 'sw'));
  check(l.length === 16 && l.every((n, i) => n.s === LEAD + i * 24 + (i % 2 ? 12 : 0)), 'swing 0.5 of 24: every second 24-tick note 12 ticks late');
  check(l.every((n, i) => n.len === (i % 2 ? 8 : 20)), 'swing: a late note still ends where it did');
  const l2 = notesOf(trackOf(built(song([part('sw', { notes: ns, devices: [{ type: 'swing', amount: 0.25, unit: 48 }] })], { bars: 2, loop: { on: false } })), 'sw'));
  check(l2.every((n, i) => n.s === LEAD + i * 24 + (i % 4 === 2 ? 12 : 0)), 'swing 0.25 of 48: only the notes on the second 48-tick half move, by 12');
}
{
  const ns = Array.from({ length: 32 }, (_, i) => ({ t: i * 24, n: 60 + (i % 7), v: 64 + (i % 3) * 20, len: 16 }));
  const mk = (seed, timing) => song([part('hu', { notes: clone(ns), devices: [{ type: 'humanize', timing, velocity: 6, seed }] })]);
  const a = built(mk(1, 3)).bytes, b = built(mk(1, 3)).bytes, c = built(mk(2, 3)).bytes;
  check(sameBytes(a, b), 'humanize: the same seed gives the same bytes');
  check(!sameBytes(a, c), 'humanize: another seed gives other bytes');
  const P = mk(1, 3), keep = JSON.stringify(P);
  const h = Compile.processNotes(Compile.normalize(P).parts[0]);
  check(JSON.stringify(P) === keep, 'humanize: the project is not changed');
  check(h.every((n, i) => Math.abs(n.v - ns[i].v) <= 6 && Math.abs(n.t - ns[i].t) <= 3) && h.some((n, i) => n.v !== ns[i].v) && h.some((n, i) => n.t !== ns[i].t),
    'humanize: velocities within 6, times within 3 ticks, and some do change');
}

/* ---- 5. slur, delayed vibrato, pitch, auto-tune ----------------------------------------------------- */
function keyOnCount(bytes, frames) {
  const e = G.stereoEngine(); G.playBytes(bytes)(e); e.keyOns = [];
  for (let f = 0; f < frames; f++) e.step();
  return e.keyOns.length;
}
{
  const ns = (t1, t2) => [{ t: 0, n: 60, v: 90, len: 24, tie: t1 }, { t: 24, n: 64, v: 90, len: 24, tie: t2 }, { t: 48, n: 67, v: 90, len: 24 }];
  const one = (t1, t2, legato) => song([part('sl', { program: 57, legato: !!legato, notes: ns(t1, t2) })], { bars: 1, loop: { on: false } });
  const bt = built(one(true, false)), bn = built(one(false, false));
  const lt = notesOf(trackOf(bt, 'sl')), ln = notesOf(trackOf(bn, 'sl'));
  check(lt[0].tie === 1 && lt[0].len === 24 && lt[1].tie === 0 && ln.every((n) => n.tie === 0), 'slur: the tie bit on the slurred note only');
  const fr = Math.ceil(200 * 256 / Seq.bpmToTempo(131)) + 30;
  const kt = keyOnCount(bt.bytes, fr), kn = keyOnCount(bn.bytes, fr);
  check(kn === 3 && kt === 2, `slur: one key-on for the slurred pair (${kt} key-ons with the slur, ${kn} without)`);
  soundDiffers(bt.bytes, bn.bytes, fr, 'slur');
  const blg = built(one(false, false, true));
  soundSame(blg.bytes, built(one(true, true)).bytes, fr, 'legato on touching notes = explicit slurs');
  const lg = notesOf(trackOf(blg, 'sl'));
  check(lg[0].tie === 1 && lg[1].tie === 1 && lg[2].tie === 0, 'legato: every touching note slurs into the next, the last does not');
  check(keyOnCount(blg.bytes, fr) === 1, 'legato: three touching notes, one key-on');
}
{
  const ns = [{ t: 0, n: 60, v: 90, len: 40 }, { t: 48, n: 62, v: 90, len: 40 }, { t: 96, n: 64, v: 90, len: 8 }, { t: 144, n: 65, v: 90, len: 40 }];
  const P = song([part('vb', { program: 57, notes: ns, vibrato: { depth: 40, rate: 100, sync: true, delay: 12, tremolo: 0 } })], { bars: 1, loop: { on: false } });
  const l = trackOf(built(P), 'vb');
  let ok = 0;
  for (const n of notesOf(l)) {
    const i = l.indexOf(n), d0 = before(l, i, 0xC5);
    const on = l.find((e) => e.k === 'cmd' && e.op === 0xC5 && e.s === n.s + 12);
    if (d0 && d0[0] === 0 && on && on.a[0] === 40) ok++;
  }
  check(ok === 4, `delayed vibrato: C5 0 at each note, C5 40 twelve ticks later (${ok} of 4)`);
  const first = l.indexOf(notesOf(l)[0]);
  check((before(l, first, 0xE1) || [])[0] === 100 && (before(l, first, 0xE0) || [])[0] === 1, 'vibrato: rate E1 100 and key sync E0 1 set before the first note');
  const P2 = clone(P); P2.parts[0].vibrato.delay = 0;
  const l2 = trackOf(built(P2), 'vb');
  check(l2.filter((e) => e.k === 'cmd' && e.op === 0xC5).length === 1 && notesOf(l2).every((n) => before(l2, l2.indexOf(n), 0xC5)[0] === 40), 'vibrato without delay: one C5 40, in force at every note');
}
{
  const unitsAt = (l, i) => 24 * s8((before(l, i, 0xC3) || [0])[0]) + 4 * ((before(l, i, 0xE7) || [64])[0] - 64);
  const ns = [{ t: 0, n: 60, v: 90, len: 20 }, { t: 24, n: 62, v: 90, len: 20, cents: -14 }, { t: 48, n: 64, v: 90, len: 20, cents: 100 }, { t: 72, n: 65, v: 90, len: 20, cents: -100 }];
  const P = song([part('pc', { program: 57, tune: 7, notes: ns, automation: { pitch: [{ t: 0, v: 50 }, { t: 60, v: -33 }] } })], { bars: 1, loop: { on: false } });
  const l = trackOf(built(P), 'pc');
  const cents = [50 + 7, 50 + 7 - 14, 50 + 7 + 100, -33 + 7 - 100];
  let ok = 0;
  notesOf(l).forEach((n, k) => {
    const i = l.indexOf(n), want = Math.round(2.56 * cents[k]), c3 = s8(before(l, i, 0xC3)[0]);
    if (c3 === Math.max(-128, Math.min(127, Math.round(want / 24))) && Math.abs(unitsAt(l, i) - want) <= 2) ok++;
  });
  check(ok === 4, `pitch in cents (lane + part tune + note cents) -> C3 = round(units / 24) and E7 for the rest, within 2 units (${ok} of 4)`);
  const bendOnly = song([part('bd', { program: 57, notes: [{ t: 0, n: 60, v: 90, len: 40, bend: [[0, 2], [12, -3], [24, 5]] }, { t: 48, n: 62, v: 90, len: 20 }],
    automation: { detune: [{ t: 30, v: 4 }] } })], { bars: 1, loop: { on: false } });
  const lb = trackOf(built(bendOnly), 'bd');
  check(!lb.some((e) => e.k === 'cmd' && e.op === 0xE7), 'whole steps only (bends, detune lane): no E7 at all');
  const c3s = lb.filter((e) => e.k === 'cmd' && e.op === 0xC3).map((e) => `${e.s}:${s8(e.a[0])}`).join(' ');
  check(c3s === `1:2 ${LEAD + 12}:-3 ${LEAD + 24}:5 ${LEAD + 30}:9 ${LEAD + 48}:4`, `bends and the detune lane add up in C3 steps; the first note's set-up in the lead-in (${c3s})`);
  const fineL = song([part('fl', { program: 57, notes: [{ t: 0, n: 60, v: 90, len: 20 }], automation: { fine: [{ t: 0, v: 70 }] } })], { bars: 1, loop: { on: false } });
  const lf = trackOf(built(fineL), 'fl'), fi = lf.indexOf(notesOf(lf)[0]);
  check(unitsAt(lf, fi) === 24 && s8(before(lf, fi, 0xC3)[0]) === 1 && (before(lf, fi, 0xE7) || [64])[0] === 64, 'fine lane 70 = 24 units: written as C3 1, E7 stays 64');
}
{
  const unitsOf = (P, id) => { const l = trackOf(built(P, { catalog: P.__cat }), id), i = l.indexOf(notesOf(l)[0]); return 24 * s8((before(l, i, 0xC3) || [0])[0]) + 4 * ((before(l, i, 0xE7) || [64])[0] - 64); };
  const mk = (autoTune) => song([part('a', { program: 43, notes: [{ t: 0, n: 60, v: 90, len: 20 }] }), part('b', { program: 20, notes: [{ t: 0, n: 40, v: 90, len: 20 }] })], { autoTune, bars: 1, loop: { on: false } });
  const cat = { programs: { '0:43': { tuningCents: 30, tuningConfidence: 0.9 }, '0:20': { tuningCents: -200, tuningConfidence: 0.3 } } };
  const P = mk(true); Object.defineProperty(P, '__cat', { value: cat, enumerable: false });
  check(Math.abs(unitsOf(P, 'a') - Math.round(2.56 * -30)) <= 2, `auto-tune: a sure measurement of +30 cents is corrected by -30 (${unitsOf(P, 'a')} units)`);
  check(unitsOf(P, 'b') === 0, 'auto-tune: an unsure measurement (confidence 0.3) is left alone');
  const Q = mk(false); Object.defineProperty(Q, '__cat', { value: cat, enumerable: false });
  check(unitsOf(Q, 'a') === 0, 'auto-tune off: no correction');
  const nc = built(mk(true));
  check(nc.report.warnings.some((w) => w.code === 'autotune.nocatalog') && !trackOf(nc, 'a').some((e) => e.k === 'cmd' && (e.op === 0xC3 || e.op === 0xE7)), 'auto-tune without a catalog: a warning and no correction');
  /* the real catalog (A5) */
  let real = null;
  try { const Cat = require('../../js/catalog.js'); const { engine, data } = G.loadData(); real = Cat.build(engine, data); } catch (e) { check(false, `the instrument catalog could not be built: ${e.message}`); }
  if (real) {
    const sure = Object.keys(real.programs).filter((k) => k.startsWith('0:') && typeof real.programs[k].tuningCents === 'number' && real.programs[k].tuningConfidence >= 0.8);
    const unsure = Object.keys(real.programs).filter((k) => k.startsWith('0:') && typeof real.programs[k].tuningCents === 'number' && real.programs[k].tuningConfidence < 0.8);
    let ok = 0;
    for (const k of sure.concat(unsure)) {
      const R = song([part('r', { program: Number(k.slice(2)), notes: [{ t: 0, n: 60, v: 90, len: 20 }] })], { autoTune: true, bars: 1, loop: { on: false } });
      Object.defineProperty(R, '__cat', { value: real, enumerable: false });
      const want = sure.includes(k) ? Math.round(2.56 * -real.programs[k].tuningCents) : 0;
      if (Math.abs(unitsOf(R, 'r') - want) <= 2) ok++;
    }
    check(sure.length > 0 && ok === sure.length + unsure.length, `auto-tune with the real catalog: ${sure.length} sure programs corrected by their measured cents, ${unsure.length} unsure left alone (${ok} right)`);
  }
}

/* ---- 6. tracks: order, pins, the 17th, partTracks, includeMuted ------------------------------------- */
{
  const one = (id, o) => part(id, Object.assign({ notes: melody(1) }, o));
  const P = song([one('a', { voices: 2, notes: melody(1).flatMap((n) => [n, Object.assign({}, n, { n: n.n - 3 })]) }), one('b', { devices: [{ type: 'echo' }] }), one('c', { track: 5 }), one('d', { mute: true })], { bars: 1, loop: { on: false } });
  const b = built(P);
  check(JSON.stringify(b.report.partTracks) === JSON.stringify({ a: [0, 1], b: [2, 3], c: [5] }), `track order: voices in part order, device tracks after, pin honoured (${JSON.stringify(b.report.partTracks)})`);
  check(b.report.tracks.find((t) => t.track === 3).kind === 'echo' && b.report.tracks.find((t) => t.track === 5).partId === 'c', 'report.tracks: kind and part per track');
  const bm = built(P, { includeMuted: true });
  check(JSON.stringify(bm.report.partTracks.d) === '[3]' && JSON.stringify(bm.report.partTracks.b) === '[2,4]' && !b.report.partTracks.d, 'includeMuted builds the muted part too (its voice before the device tracks), and the report says which track it has');
  const Pin = song([one('a', { track: 3 }), one('b', { track: 3 })], { bars: 1, loop: { on: false } });
  const bp = built(Pin);
  check(bp.report.partTracks.a[0] === 3 && bp.report.partTracks.b[0] === 0 && bp.report.warnings.some((w) => w.code === 'track.pin' && w.partId === 'b'), 'two pins on one track: the second gets the next free track, with a warning');
  const many = song(Array.from({ length: 8 }, (_, i) => one(`p${i}`, { voices: 2, notes: melody(1).flatMap((n) => [n, Object.assign({}, n, { n: n.n - 4 })]) })).concat([one('fx', { devices: [{ type: 'echo' }] })]), { bars: 1, loop: { on: false } });
  const bo = built(many);
  const w = bo.report.warnings.find((x) => x.code === 'tracks.over');
  check(bo.report.tracks.length === 16 && !!w && /the echo on fx/.test(w.message) && /fx \(voice 1\)/.test(w.message) && /18 tracks/.test(w.message),
    `18 tracks needed: 16 built, warning tracks.over names what was left out (${w ? w.message : 'no warning'})`);
  check(bo.plainTracks.filter(Boolean).length === 16, 'the sequence has 16 tracks');
}

/* ---- 7. compiler rules ------------------------------------------------------------------------------ */
{
  const P = song([part('r', { transpose: 12, notes: [{ t: 0, n: 60, v: 127, len: 20 }, { t: 24, n: 120, v: 90, len: 20 }, { t: 48, n: 61, v: 1, len: 20 }, { t: 72, n: 62, v: 2, len: 20 }, { t: 96, n: 63, v: 3, len: 20 }] })], { bars: 1, loop: { on: false } });
  const keep = JSON.stringify(P);
  const b = Compile.build(P);
  check(JSON.stringify(P) === keep, 'build never changes its argument');
  check(sameBytes(b.bytes, Compile.build(clone(P)).bytes) && sameBytes(b.bytes, Compile.build(reorder(P)).bytes), 'same input -> same bytes, whatever the key order');
  const ln = notesOf(trackOf(b, 'r'));
  check(ln.map((n) => n.v).join(' ') === '63 1 1 2' && ln.map((n) => n.n).join(' ') === '72 73 74 75', `velocity round(v / 2) in 1..63; transpose added (${ln.map((n) => `${n.n}/${n.v}`).join(' ')})`);
  check(b.report.dropped === 1, `a note outside 0..127 after transpose is dropped and counted (${b.report.dropped})`);
}
{
  /* post and pre points, negative ticks, explicit markers, tempo changes and the tempo part */
  const P = song([part('a', { notes: [{ t: 0, n: 60, v: 90, len: 20 }, { t: 96, n: 62, v: 90, len: 20 }],
    automation: { volume: [{ t: -2, v: 50 }, { t: 96, v: 60 }, { t: 96, v: 70, post: true }], pan: [{ t: 192, v: 10, pre: true }] } }),
  part('b', { notes: [{ t: 0, n: 50, v: 90, len: 20 }] })],
  { markers: [{ t: 0, i: 0, v: 1 }, { t: 190, i: 1, v: 2 }], markerBars: 2, tempoPart: 'b', tempoChanges: [{ t: 384, bpm: 150 }] });
  const b = built(P), la = trackOf(b, 'a'), lb = trackOf(b, 'b');
  const vol = la.filter((e) => e.k === 'cmd' && e.op === 0xC6).map((e) => `${e.s}:${e.a[0]}`);
  const n96 = la.findIndex((e) => e.k === 'note' && e.s === 96 + LEAD), v70 = la.findIndex((e) => e.k === 'cmd' && e.op === 0xC6 && e.a[0] === 70);
  check(vol[0] === '0:50' || vol[0] === '1:50', `a point at tick -2 lands in the lead-in (${vol.join(' ')})`);
  check(vol.includes(`${96 + LEAD}:60`) && v70 > n96 && la[v70].s === 96 + LEAD && la[n96 - 1].op === 0xC6 && la[n96 - 1].a[0] === 60, 'a point is written before the note on its tick; a post point after it');
  const d0 = la.findIndex((e) => e.k === 'cmd' && e.op === 0xD0), p10 = la.findIndex((e) => e.k === 'cmd' && e.op === 0xC7 && e.a[0] === 10);
  check(p10 >= 0 && p10 < d0 && la[p10].s === la[d0].s, 'a pre point on the loop start tick is written before D0');
  const e8 = lb.filter((e) => e.k === 'cmd' && e.op === 0xE8).map((e) => `${e.s}:${e.a.join(',')}`).join(' ');
  check(e8 === `${LEAD}:0,1 ${190 + LEAD}:1,2` && !la.some((e) => e.k === 'cmd' && e.op === 0xE8), `explicit markers replace markerBars, on the tempo part's track (${e8})`);
  const c1 = lb.filter((e) => e.k === 'cmd' && e.op === 0xC1).map((e) => `${e.s}:${(e.a[0] << 8) | e.a[1]}`).join(' ');
  check(c1 === `0:${Seq.bpmToTempo(131)} ${192 + LEAD}:${Seq.bpmToTempo(131)} ${384 + LEAD}:${Seq.bpmToTempo(150)}` && !la.some((e) => e.k === 'cmd' && e.op === 0xC1),
    `tempo and its changes on the tempo part's track only; every pass starts at the first pass's tempo (${c1})`);
  const P2 = clone(P); P2.markers = null;
  const e82 = trackOf(built(P2), 'b').filter((e) => e.k === 'cmd' && e.op === 0xE8).map((e) => `${e.s}:${e.a[1]}`).join(' ');
  check(e82 === `${192 + LEAD}:1 ${382 + LEAD}:2 ${384 + LEAD}:1 ${766 + LEAD}:2`, `markerBars 2: marker 1 at the loop start and every 2 bars, marker 2 two ticks before (${e82})`);
}
{
  /* loop in ticks, part end, length, loop shift */
  const P = song([part('a', { notes: melody(4) }), part('b', { notes: melody(4, { oct: -12 }), loopShift: 6 })], { loop: { on: true, start: 100, end: 700 }, markerBars: 0 });
  const b = built(P), la = trackOf(b, 'a'), lb = trackOf(b, 'b');
  const pos = (l, op) => (l.find((e) => e.k === 'cmd' && e.op === op) || {}).s;
  check(pos(la, 0xD0) === 100 + LEAD && pos(la, 0xD4) === 700 + LEAD, `loop in ticks: D0 at ${pos(la, 0xD0)}, D4 at ${pos(la, 0xD4)}`);
  check(pos(lb, 0xD0) === 106 + LEAD && pos(lb, 0xD4) === 706 + LEAD, 'loopShift 6 moves that part\'s loop by 6 ticks');
  check(notesOf(la).every((n) => n.s + n.len <= 700 + LEAD), 'notes are cut at the loop end');
  const Q = song([part('a', { notes: melody(2), end: 300 }), part('b', { notes: melody(2) })], { bars: 2, loop: { on: false }, length: 350, markerBars: 0 });
  const bq = built(Q), qa = trackOf(bq, 'a'), qb = trackOf(bq, 'b');
  check(pos(qa, 0xFF) === 300 + LEAD && pos(qb, 0xFF) === 350 + LEAD, `play once: a part's end and the song's length give FF (${pos(qa, 0xFF)}, ${pos(qb, 0xFF)})`);
  check(notesOf(qa).every((n) => n.s + n.len <= 300 + LEAD), 'notes are cut at the part\'s end');
}

/* ---- 8. loopRestore: every pass sounds like the first (chip writes per frame) ------------------------ */
/* What the chip plays in each frame: the key mask, the voices keyed on in that frame, and all registers
 * of each voice that sounds. */
function logs(setup, frames) {
  const e = G.stereoEngine(); setup(e); e.keyOns = [];
  const out = [];
  for (let f = 0; f < frames; f++) {
    const k0 = e.keyOns.length;
    e.step();
    const v = [];
    for (let i = 0; i < 16; i++) v.push(e.key & (1 << i) ? Array.from(e.regs.subarray(i * 16, i * 16 + 16), (x) => x.toString(16)).join(' ') : '');
    out.push({ key: e.key, ons: e.keyOns.slice(k0).map((x) => x[1]), v });
  }
  return out;
}
/* Frames fa.. of a against fb.. of b. Only voices keyed on inside the compared stretch count: a voice
 * still ringing from before it (the driver lets a sample play out after its note ends) is the song's own
 * tail, not something the build under test can change; a song started at its chorus or its cycle starts
 * in silence. Writes to voices that are not sounding are never compared (the driver keeps writing the
 * last note's pitch to a silent voice; found 2026-10-02). */
function sameFrames(a, fa, b, fb, n) {
  let freshA = 0, freshB = 0;
  const view = (fr, fresh) => {
    const lines = [`key ${(fr.key & fresh).toString(16)}`, `on ${fr.ons.join(',')}`];
    for (let i = 0; i < 16; i++) if (fr.key & fresh & (1 << i)) lines.push(`v${i} ${fr.v[i]}`);
    return lines;
  };
  for (let i = 0; i < n; i++) {
    const x = a[fa + i], y = b[fb + i];
    if (!x || !y) return { frame: i, a: [x ? 'frame' : '(missing)'], b: [y ? 'frame' : '(missing)'] };
    for (const v of x.ons) freshA |= 1 << v;
    for (const v of y.ons) freshB |= 1 << v;
    const X = view(x, freshA), Y = view(y, freshB);
    if (X.join('|') !== Y.join('|')) return { frame: i, a: X.slice(0, 4), b: Y.slice(0, 4) };
  }
  return null;
}
function keyOnsIn(l, f0, n) { let w = 0; for (let i = f0; i < f0 + n; i++) if (l[i] && l[i].ons.length) w++; return w; }const lr = song([
  part('a', { notes: melody(5), automation: { expression: [{ t: 0, v: 110 }, { t: 192 + 96, v: 50 }], pan: [{ t: 192 + 120, v: 100 }], detune: [{ t: 192 + 150, v: 3 }] } }),
  part('b', { program: 20, pan: 64, notes: melody(5, { oct: -24 }).filter((n, i) => i % 3 === 0), automation: { volume: [{ t: 192 + 40, v: 30 }], gain: [{ t: 192 + 60, v: -20 }] } })],
{ bpm: T512, bars: 5, loop: { on: true, startBar: 2, endBar: 5, start: 192, end: 960 } });
{
  const span = (960 - 192) / 2, F = Math.ceil((192 + LEAD) / 2) + 2;
  for (const restore of [true]) {
    const P = clone(lr); P.loopRestore = restore;
    const b = built(P), l = logs(G.playBytes(b.bytes), F + 2 * span + 4);
    const d = sameFrames(l, F, l, F + span, span);
    check(!d && keyOnsIn(l, F, span) > 20, `loopRestore ${restore}: pass 2 plays what pass 1 plays, frame for frame${d ? ` (differs ${d.frame} frames in: ${d.a} / ${d.b})` : ''}`);
    if (restore) {
      const la = trackOf(b, 'a'), i = la.findIndex((e) => e.k === 'cmd' && e.op === 0xD0);
      const after = []; for (let k = i + 1; k < la.length && la[k].k === 'cmd' && la[k].s === la[i].s; k++) after.push(la[k].op);
      check(after.includes(0xC8) && after.includes(0xC7) && after.includes(0xC3), `loopRestore: expression, pan and detune written back straight after D0 (${after.map((x) => x.toString(16)).join(' ')})`);
      /* teeth: without those commands pass 2 differs */
      const broken = b.plainTracks.map((ev) => {
        if (!ev) return null;
        const j = ev.findIndex((e) => e.k === 'cmd' && e.op === 0xD0), out = ev.slice();
        let k = j + 1; while (k < out.length && out[k].k === 'cmd' && out[k].d === 0 && out[k].op !== 0xE8) out.splice(k, 1);
        return out;
      });
      const lb = logs(G.playBytes(Seq.compile({ tracks: broken })), F + 2 * span + 4);
      check(!!sameFrames(lb, F, lb, F + span, span), 'loopRestore check has teeth: removing the commands after D0 makes pass 2 differ');
    }
  }
}

{
  /* loopRestore false: the passes run on, as the driver plays them (what a copy of Capcom's music needs: its
   * second pass may differ from its first). Proof by audio: the looped build sounds like the same song written
   * out for two passes with no loop, every point repeated in pass 2, so a value set late in pass 1 carries into
   * pass 2 until a point sets it again. Part a also gets a point at the loop start equal to what the introduction
   * leaves (expression 110): needless in pass 1, needed in pass 2, so it must be written. No phrase markers (their
   * places differ between a loop and a written-out song; they are not heard). */
  const P = clone(lr); P.loopRestore = false; P.markerBars = 0;
  P.parts[0].automation.expression = [{ t: 0, v: 110 }, { t: 192, v: 110 }, { t: 192 + 96, v: 50 }];
  const L = 960 - 192, lin = clone(P);
  lin.loop = { on: false }; lin.length = 960 + L; lin.bars = Math.ceil(lin.length / BAR);
  for (const p of lin.parts) {
    p.notes = p.notes.concat(p.notes.filter((n) => n.t >= 192 && n.t < 960).map((n) => Object.assign({}, n, { t: n.t + L })));
    for (const k of Object.keys(p.automation)) p.automation[k] = p.automation[k].concat(p.automation[k].filter((x) => x.t >= 192 && x.t < 960).map((x) => Object.assign({}, x, { t: x.t + L })));
  }
  /* up to the frame where the loop starts pass 3 and the written-out song reaches its end (tick 1730: frame 1730 / 2 + 1) */
  const frames = (LEAD + 960 + L) / 2 + 1;
  const bl = built(P);
  soundSame(bl.bytes, built(lin).bytes, frames, 'loopRestore false: the loop sounds like the song written out twice (values carry into the next pass)');
  const Pt = clone(P); Pt.loopRestore = true;
  soundDiffers(built(Pt).bytes, bl.bytes, frames, 'loopRestore true against false');
  const la = trackOf(bl, 'a'), i = la.findIndex((e) => e.k === 'cmd' && e.op === 0xD0);
  check(la.some((e, k) => k > i && e.s === la[i].s && e.k === 'cmd' && e.op === 0xC8 && e.a[0] === 110), 'loopRestore false: a point needless in pass 1 but needed in pass 2 is written');
}

/* ---- 9. cycle playback (range): the stretch, then the stretch again ----------------------------------- */
{
  const from = 384, to = 768, span = (to - from) / 2;
  const whole = built(lr), rng = built(lr, { range: { from, to } });
  check(rng.loop && rng.loop.start === 0 && rng.loop.end === to - from, 'range: a song that loops over the stretch');
  const lw = logs(G.playBytes(whole.bytes), from / 2 + span + 8), lrg = logs(G.playBytes(rng.bytes), 2 * span + 8);
  const d1 = sameFrames(lw, from / 2 + 1, lrg, 1, span), d2 = sameFrames(lw, from / 2 + 1, lrg, span + 1, span);
  check(!d1 && keyOnsIn(lrg, 1, span) > 10, `range bars 3-4: the first pass plays what the whole song plays from bar 3${d1 ? ` (differs ${d1.frame} frames in: ${d1.a} / ${d1.b})` : ''}`);
  check(!d2, `range: the loop back plays bars 3-4 again${d2 ? ` (differs ${d2.frame} frames in: ${d2.a} / ${d2.b})` : ''}`);
  check(JSON.stringify(rng.report.partTracks) === JSON.stringify(whole.report.partTracks), 'range: the same tracks for the same parts');
  const early = built(lr, { range: { from: 192, to } }), le = logs(G.playBytes(early.bytes), span + 8);
  check(!!sameFrames(lw, from / 2 + 1, le, 1, span), 'range check has teeth: another stretch differs');
}

/* ---- 10. chorus entry: the entry sounds like the song from that bar, then loops chorus -> end ---------- */
{
  const P = clone(lr); P.chorusBar = 4; P.bars = 5;
  /* a part that repeats every bar, so the compressed song has loops on both sides of the chorus bar */
  P.parts.push(part('c', { program: 6, pan: 64, notes: Array.from({ length: 20 }, (_, i) => ({ t: (i >> 2) * BAR + (i & 3) * 48, n: [36, 42, 38, 42][i & 3], v: 100, len: 8 })) }));
  const at = (P.chorusBar - 1) * BAR + LEAD, span = (960 + LEAD - at) / 2;
  const plain = built(P), CAVE = G.Engine.CAVE;
  const place = (song, entry, songAt, entryAt) => (e) => { e.patchAt(songAt, song); e.patchAt(entryAt, entry); e.setRequest(60, songAt); e.setRequest(61, entryAt); e.request(61); };
  const ref = logs(G.playBytes(plain.bytes), at / 2 + span + 8);
  for (const compressed of [false, true]) {
    const songBytes = compressed ? built(P, { compress: true }).bytes : plain.bytes;
    const songAt = CAVE.preview, entryAt = CAVE.preview + ((songBytes.length + 15) & ~15);
    let entry = null;
    try { entry = Compile.chorusEntry(clone(P), { songAt, entryAt, compressed }); } catch (e) { check(false, `chorus entry (${compressed ? 'compressed' : 'plain'} song): ${e.message}`); continue; }
    const le = logs(place(songBytes, entry, songAt, entryAt), 2 * span + 8);
    const d1 = sameFrames(ref, at / 2, le, 0, span), d2 = sameFrames(ref, at / 2, le, span, span);
    check(!d1 && keyOnsIn(le, 0, span) > 10, `chorus entry, ${compressed ? 'compressed' : 'plain'} song: plays the song from bar 4${d1 ? ` (differs ${d1.frame} frames in: ${d1.a} / ${d1.b})` : ''}`);
    check(!d2, `chorus entry, ${compressed ? 'compressed' : 'plain'} song: then loops back to bar 4${d2 ? ` (differs ${d2.frame} frames in: ${d2.a} / ${d2.b})` : ''}`);
    if (compressed) check(songBytes.length < plain.bytes.length, `the compressed song is smaller (${songBytes.length} of ${plain.bytes.length} bytes)`);
  }
  const Q = clone(P); Q.chorusBar = 3;
  const wrong = Compile.chorusEntry(Q, { songAt: CAVE.preview, entryAt: CAVE.preview + ((plain.bytes.length + 15) & ~15), compressed: false });
  const lw = logs(place(plain.bytes, wrong, CAVE.preview, CAVE.preview + ((plain.bytes.length + 15) & ~15)), span + 8);
  check(!!sameFrames(ref, at / 2, lw, 0, span), 'chorus check has teeth: an entry for bar 3 differs from the song at bar 4');
  let threw = '';
  try { Compile.chorusEntry(clone(P), { songAt: CAVE.preview, entryAt: CAVE.preview + 0x9000, compressed: false }); } catch (e) { threw = e.message; }
  check(/out of reach/.test(threw), `a chorus entry too far from the song is refused (${threw || 'not refused'})`);
  let threw2 = '';
  try { const R = clone(P); R.chorusBar = 1; Compile.chorusEntry(R, { songAt: CAVE.preview, entryAt: CAVE.preview + 0x4000 }); } catch (e) { threw2 = e.message; }
  check(/inside the loop/.test(threw2), `a chorus bar before the loop start is refused (${threw2 || 'not refused'})`);
}

/* ---- 11. the song file -------------------------------------------------------------------------------- */
{
  const saved = G.savedSongs()[0];
  const v1 = saved.project;
  const old = G.Project.songFile(v1, G.Project.build(clone(v1)), { x: 'y' });
  let proved = null;
  const f = Compile.songFile(clone(v1), { names: { x: 'y' }, prove: (a, b) => { proved = [a.length, b.length]; return true; } });
  const plain = Compile.build(clone(v1), { compress: false });
  check(Object.keys(old).every((k) => k in f) && f.format === 'sf3song' && f.version === 2, 'song file: every version-1 field is there');
  check(f.sequence_b64 === Buffer.from(plain.bytes).toString('base64') && f.bytes === plain.bytes.length, 'song file: sequence_b64 is the plain build');
  check(f.name === old.name && f.bpm === old.bpm && JSON.stringify(f.loop_ticks) === JSON.stringify(old.loop_ticks) && f.marker_bars === old.marker_bars && JSON.stringify(f.names) === JSON.stringify(old.names),
    'song file: name, bpm, loop ticks, marker bars and names as version 1 writes them');
  check(f.tracks.length === old.tracks.length && f.tracks.every((t, i) => ['track', 'part', 'bank', 'program', 'notes'].every((k) => t[k] === old.tracks[i][k])), 'song file: the tracks list as version 1 writes it');
  check(!!f.compressed && proved && proved[0] === plain.bytes.length && f.compressed.bytes === proved[1] && proved[1] < proved[0] && f.checks.compressed_sound_identical === true, 'song file: compressed added once proven');
  const g2 = Compile.songFile(clone(v1), { prove: () => false });
  check(!g2.compressed && g2.checks.compressed_sound_identical === false && g2.sequence_b64 === f.sequence_b64, 'song file: not proven -> no compressed sequence, the plain one unchanged');
  const g3 = Compile.songFile(clone(v1), {});
  check(!g3.compressed, 'song file: no proof given -> no compressed sequence');
  const P = clone(lr); P.chorusBar = 4;
  const g4 = Compile.songFile(P, { compress: false });
  check(JSON.stringify(g4.needs) === '["song","chorus-entry"]' && g4.chorus_bar === 4 && !g4.compressed, 'song file: needs and chorus_bar');
}

done('devices, tracks, rules, loopRestore, range and chorus entry');
