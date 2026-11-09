/* What every sequence command, the envelope and the chip do, measured in the game's own driver
 * (node checks/command_check.js). These are the facts the Studio's compiler, devices and instrument
 * designer are built on (docs/plan/02_DRIVER.md); each is asserted here so a change to the engine or
 * a different ROM cannot silently break them. Static side: the research project's sound_command_evidence.py (not in this repository).
 *
 * Measured on voice 0 (track 1): chip step register (word 6), volume words 15 (left) and 14 (right),
 * loop flag (word 5), key mask. Pitch offsets are in the driver's unit, 1/256 semitone.
 */
'use strict';
const path = require('path');
const root = path.join(__dirname, '..');
require(path.join(root, 'data', 'pack.js'));
const { Engine } = require(path.join(root, 'js', 'engine.js'));
const Seq = require(path.join(root, 'js', 'seq.js'));
const Data = require(path.join(root, 'js', 'gamedata.js'));
const pack = globalThis.SF3_PACK;

let failed = 0, checks = 0;
const check = (ok, what) => { checks++; if (!ok) { failed++; console.log('FAIL', what); } };
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const cmd = (d, op, ...a) => ({ d, k: 'cmd', op, a });
const note = (d, n, v, len, tie) => ({ d, k: 'note', v, n, tie: tie ? 1 : 0, len });
const s16 = (v) => (v << 16) >> 16;
const units = (step, base) => 12 * Math.log2(step / base) * 256;
const BASE = 0x06000000, FN_SET_BANK = 0x06139310, FN_INIT = 0x06139316;
const REQ = 0x0678F000, SAMPLES = 0x0678C000, BANKS = 0x06788000;

/* the driver's init as the game calls it; the second stack argument is the stereo switch (0 = mono,
 * which is what Fightcade players hear; see style/README.txt and checks/stereo_check.py) */
function boot(stereo) {
  const e = new Engine(pack);
  e.ram.fill(0); e.regs.fill(0); e.pos.fill(0); e.frac.fill(0); e.key = 0; e.cfg = 0; e.acc = 0; e.frame = 0;
  const cpu = e.cpu;
  cpu.r.fill(0); cpu.sr = 0; cpu.gbr = 0; cpu.vbr = 0; cpu.mach = 0; cpu.macl = 0; cpu.r[15] = 0x0200C000;
  e.call(FN_SET_BANK, 0x40);
  cpu.r[15] -= 8; e.w32(cpu.r[15], 0); e.w32(cpu.r[15] + 4, stereo ? 1 : 0);
  e.call(FN_INIT, REQ, SAMPLES, BANKS, 1);
  cpu.r[15] += 8;
  return e;
}
function play(events, frames, e) {
  e = e || boot(false);
  e.keyOns = [];
  const tracks = new Array(16).fill(null); tracks[0] = events;
  e.patchSequence(Seq.compile({ tracks }), 60); e.request(60);
  const rows = [];
  for (let f = 0; f < frames; f++) { e.step(); rows.push({ step: e.regs[6], l: s16(e.regs[15]), r: s16(e.regs[14]), loop: e.regs[5], key: e.key & 1 }); }
  return { rows, keyOns: e.keyOns.map((k) => k[0]), e };
}
const P = 20;                                             /* a sustained (looped) bass */
const head = (prog, pan, bank) => [cmd(0, 0xC1, 2, 0), cmd(0, 0xC2, bank || 0), cmd(0, 0xC4, prog), cmd(0, 0xC6, 100), cmd(0, 0xC8, 127), cmd(0, 0xC7, pan === undefined ? 64 : pan)];
const held = (extra) => play([...head(P), ...(extra || []), note(1, 60, 50, 3000), cmd(3100, 0xFF)], 60).rows[30];
const plain = held();

/* ---- the driver's tables (values quoted in the plan) ------------------------------------------ */
const e0 = boot(false);
const table = (ptrAddr, n) => { const p = e0.r32(ptrAddr), out = []; for (let i = 0; i < n; i++) out.push(e0.rom16(p + 2 * i)); return out; };
const ENV_A = table(0x02078CE8, 64), ENV_B = table(0x02078CEC, 64), LFO_RATE = table(0x02078CF0, 128), VIB_DEPTH = table(0x02078CF4, 128), TREM_DEPTH = table(0x02078CF8, 128);
check(e0.r32(0x02078CE8) === 0x0660CBF8 && e0.r32(0x02078CEC) === 0x0660CC78 && e0.r32(0x02078CF0) === 0x0660CCF8 && e0.r32(0x02078CF4) === 0x0660CDF8 && e0.r32(0x02078CF8) === 0x0660CEF8,
      'table pointers: attack 0660CBF8, decay/release 0660CC78, LFO rate 0660CCF8, vibrato depth 0660CDF8, tremolo depth 0660CEF8');
check(ENV_A[0] === 0 && ENV_A[40] === 2630 && ENV_A[63] === 65535 && ENV_B[1] === 1 && ENV_B[32] === 381 && ENV_B[40] === 1522 && ENV_B[56] === 24356 && ENV_B[63] === 65535, 'envelope rate tables (64 entries each)');
check(LFO_RATE[1] === 280 && LFO_RATE[45] === 1790 && LFO_RATE[100] === 20582 && LFO_RATE[110] === 30426 && LFO_RATE[115] === 39375 && LFO_RATE[127] === 64432, 'LFO rate table (E1)');
check(VIB_DEPTH[1] === 12 && VIB_DEPTH[20] === 29 && VIB_DEPTH[50] === 106 && VIB_DEPTH[65] === 226 && VIB_DEPTH[127] === 3048, 'vibrato depth table (C5), in 1/256 semitone');
check(TREM_DEPTH[1] === 441 && TREM_DEPTH[64] === 16637 && TREM_DEPTH[127] === 65025, 'tremolo depth table (E2)');

/* ---- pitch: C3 detune, E7 fine pitch ----------------------------------------------------------- */
for (const v of [0, 32, 63, 65, 96, 127]) check(near(units(held([cmd(0, 0xE7, v)]).step, plain.step), (v - 64) * 4, 1.2), `E7 ${v}: fine pitch (v - 64) * 4 units`);
check(held([cmd(0, 0xE7, 64)]).step === plain.step, 'E7 64 is no offset');
for (const v of [1, 10, 127, 255, 246, 128]) { const s = (v << 24) >> 24; check(near(units(held([cmd(0, 0xC3, v)]).step, plain.step), s * 24, 2 + Math.abs(s) * 0.2), `C3 ${v}: detune s8 * 24 units`); }

/* ---- level: velocity, volume, expression, DE gain, mid-note changes --------------------------- */
const lv = (vol, ex, vel, extra) => play([cmd(0, 0xC1, 2, 0), cmd(0, 0xC2, 0), cmd(0, 0xC4, P), cmd(0, 0xC6, vol), cmd(0, 0xC8, ex), cmd(0, 0xC7, 64), ...(extra || []), note(1, 60, vel, 400), cmd(500, 0xFF)], 40).rows[30].l;
const ref = lv(100, 127, 50);
check(near(lv(50, 127, 50) / ref, 0.5, 0.01) && near(lv(100, 64, 50) / ref, 65 / 128, 0.01) && near(lv(127, 127, 50) / ref, 1.27, 0.01), 'level is linear in volume and in (expression + 1)');
check(near(lv(100, 127, 25) / ref, 0.5, 0.01) && near(lv(100, 127, 10) / ref, 0.2, 0.01), 'level is linear in velocity');
check(lv(100, 0, 50) === 0, 'expression 0 is silence');
check(near(lv(100, 127, 50, [cmd(0, 0xDE, 0xE0)]) / ref, 0.5, 0.01) && lv(100, 127, 50, [cmd(0, 0xDE, 0xC0)]) === 0 && lv(100, 127, 50, [cmd(0, 0xDE, 0)]) === ref, 'DE n: channel gain (64 + s8 n) / 64');
check(lv(100, 127, 50, [cmd(0, 0xDE, 32)]) === 32767, 'DE gain above full level clips at 0x7FFF');
{ const r = play([...head(P), note(1, 60, 50, 400), cmd(40, 0xC6, 50), cmd(400, 0xFF)], 60).rows; check(near(r[30].l / r[10].l, 0.5, 0.01), 'C6 acts on a sounding note at once'); }

/* ---- LFO: C5 vibrato depth, E1 rate, E0 key sync, E2 tremolo ----------------------------------- */
function lfo(c5, e1, sync) {
  const rows = play([...head(P), cmd(0, 0xE0, sync), cmd(0, 0xE1, e1), cmd(0, 0xC5, c5), note(1, 60, 50, 3000), cmd(3100, 0xFF)], 400).rows.filter((x) => x.key);
  const dev = rows.map((x) => units(x.step, plain.step)), ups = [];
  for (let i = 1; i < dev.length; i++) if (dev[i - 1] < 0 && dev[i] >= 0) ups.push(i);
  return { dev, max: Math.max(...dev), min: Math.min(...dev), period: (ups[ups.length - 1] - ups[0]) / (ups.length - 1) };
}
for (const [c5, e1] of [[65, 115], [50, 110], [127, 100], [20, 45]]) {
  /* a triangle between -depth and +depth; each swing takes a whole number of frames */
  const m = lfo(c5, e1, 1), want = 2 * Math.ceil(131072 / LFO_RATE[e1]);
  check(near(m.max, VIB_DEPTH[c5], 3) && near(m.min, -VIB_DEPTH[c5], 3), `C5 ${c5}: vibrato swings +-${VIB_DEPTH[c5]} units (${m.min.toFixed(0)}..${m.max.toFixed(0)})`);
  check(near(m.period, want, 0.05), `E1 ${e1}: one cycle in 2 * ceil(131072 / ${LFO_RATE[e1]}) = ${want} frames (${m.period.toFixed(2)})`);
}
{ const a = lfo(65, 115, 1).dev, b = lfo(65, 115, 0).dev;
  check(Math.abs(a[0]) < VIB_DEPTH[65] * 0.7 && Math.abs(b[0]) > VIB_DEPTH[65] * 0.9, 'E0 1 restarts the LFO at each note (E0 0: free-running)'); }
{ const rows = play([...head(P), cmd(0, 0xE0, 1), cmd(0, 0xE1, 100), cmd(0, 0xE2, 64), note(1, 60, 50, 3000), cmd(3100, 0xFF)], 200).rows.slice(20, 80).map((x) => x.l);
  const hi = Math.max(...rows), lo = Math.min(...rows);
  check(hi > plain.l * 1.2 && lo < plain.l * 0.8 && held([cmd(0, 0xE1, 100), cmd(0, 0xE2, 64)]).step === plain.step, `E2 64: tremolo (level ${lo}..${hi} around ${plain.l}), pitch untouched`); }

/* ---- C9 portamento: the pitch moves from the previous note at (n + 1) * 2 units a frame ------- */
for (const n of [1, 8, 32, 127]) {
  const r = play([...head(P), note(1, 48, 50, 60), cmd(0, 0xC9, n), note(64, 60, 50, 400), cmd(500, 0xFF)], 120);
  /* averaged over several frames: one count of the step register is about 3 units at this pitch */
  const at = r.keyOns[1], rows = r.rows, span = Math.max(4, Math.min(20, Math.floor(3072 / ((n + 1) * 2)) - 6));
  const slope = units(rows[at + 2 + span].step, rows[at + 2].step) / span;
  check(r.keyOns.length === 2 && near(slope, (n + 1) * 2, 0.6), `C9 ${n}: glide of ${(n + 1) * 2} units a frame from the last note (${slope.toFixed(1)})`);
  if (n === 127) check(near(units(rows[at + 14].step, rows[at - 5].step), 3072, 3), 'the glide stops on the new note (12 semitones up)');
}
{ const r = play([...head(P), note(1, 48, 50, 60), cmd(0, 0xC9, 0), note(64, 60, 50, 400), cmd(500, 0xFF)], 80);
  check(near(units(r.rows[r.keyOns[1] + 1].step, r.rows[r.keyOns[1] - 5].step), 3072, 3), 'C9 0: no glide'); }

/* ---- tie (note byte bit 7): the next note does not restart the sound --------------------------- */
{ const t = play([...head(P), note(1, 48, 50, 48, true), note(48, 55, 50, 48, true), note(48, 60, 50, 48), note(48, 62, 50, 48), cmd(100, 0xFF)], 150);
  const u = play([...head(P), note(1, 48, 50, 48), note(48, 55, 50, 48), note(48, 60, 50, 48), cmd(100, 0xFF)], 150);
  check(t.keyOns.length === 2 && u.keyOns.length === 3, `tie: notes 2 and 3 play without a new key-on (${t.keyOns.join(',')}); untied notes each key on (${u.keyOns.join(',')})`);
  check(near(units(t.rows[40].step, t.rows[10].step), 7 * 256, 3) && near(units(t.rows[65].step, t.rows[10].step), 12 * 256, 3) && t.rows[40].key === 1, 'tied notes change the pitch of the sounding voice'); }

/* ---- stereo switch and pan ----------------------------------------------------------------------- */
{ const lr = (stereo, pan) => { const r = play([...head(P, pan), note(1, 60, 50, 400), cmd(500, 0xFF)], 40, boot(stereo)).rows[30]; return [r.l, r.r]; };
  check(boot(false).r8(0x02079C5B) === 0 && boot(true).r8(0x02079C5B) === 1, 'init: the second stack argument sets the stereo flag 02079C5B');
  check([0, 64, 127].every((p) => { const [l, r] = lr(false, p); return l === ref && r === ref; }), 'mono (what Fightcade plays): pan has no effect, both sides at the full level');
  const [l0, r0] = lr(true, 0), [l64, r64] = lr(true, 64), [l127, r127] = lr(true, 127);
  check(l0 === 0 && r0 === ref && l127 === ref && r127 === 0 && l64 === ref && near(r64 / ref, 0.984, 0.01), `stereo: pan 0 = word 14 only, 127 = word 15 only, 64 = both (${l64}, ${r64})`);
  const r = play([...head(P, 64), note(1, 60, 50, 400), cmd(40, 0xC7, 0), cmd(40, 0xC7, 127), cmd(400, 0xFF)], 120, boot(true)).rows;
  check(r[30].l === 0 && r[30].r > 0 && r[60].l > 0 && r[60].r === 0, 'C7 acts on a sounding note at once'); }

/* ---- instruments: a bank in the cave, a sample view, the envelope ------------------------------- */
{
  const data = Data.load(e0, pack.names);
  check(Array.from({ length: 16 }, (_, b) => e0.rom32(BANKS + 4 * b)).every((p) => p >= 0x06788040 && p < SAMPLES), 'all 16 bank pointers are set');
  for (let b = 8; b <= 14; b++) { const p = e0.rom32(BANKS + 4 * b); let zero = true; for (let i = 0; i < 256; i++) if (e0.rom8(p + i)) zero = false; check(zero && data.banks[b].filter(Boolean).length === 0, `bank ${b}: an empty program table (256 zero bytes at ${p.toString(16)})`); }
  let freeSlots = 0; for (let i = 0; i < 768; i++) if (e0.rom32(SAMPLES + 16 * i) === 0 && e0.rom32(SAMPLES + 16 * i + 8) === 0) freeSlots++;
  check(freeSlots === 35 && data.samples.filter(Boolean).length === 733, 'sample table: 733 of 768 entries used');
  check(data.banks[0].every((p) => !p || p.regions.every((r) => r.envelope.slice(0, 2).every((v) => v <= 63) && r.envelope[3] <= 63 && r.envelope[4] <= 63)), 'envelope rates in bank 0 are 0..63');

  const CAVE = 0x067F0000, VIEW = CAVE + 0x1000, index = (VIEW - SAMPLES) / 16, src = data.samples[102];
  check(Number.isInteger(index) && index === 25856 && index < 0x8000, 'a 16-byte sample entry in the cave has a valid 15-bit index from the sample table');
  function custom(env, view) {
    const e = boot(false);
    const w8 = (a, v) => { e.rom[a - BASE] = v & 255; }, w16 = (a, v) => { w8(a, v >> 8); w8(a + 1, v); }, w32 = (a, v) => { w16(a, v >>> 16); w16(a + 2, v & 0xFFFF); };
    for (let p = (CAVE - BASE) >> 12; p < (CAVE + 0x2000 - BASE) >> 12; p++) e.loaded[p] = 1;
    w32(VIEW, view.start); w32(VIEW + 4, view.loop); w32(VIEW + 8, view.end); w32(VIEW + 12, view.root);
    w16(CAVE, 0x100);                                           /* bank: program 0 at +0x100 */
    const a = CAVE + 0x100;
    w8(a, 127); w8(a + 1, 0xFF); w8(a + 2, 0); w8(a + 3, view.root); w16(a + 4, index); w8(a + 6, 0); env.forEach((v, i) => w8(a + 7 + i, v)); w8(a + 12, 0xFF);
    w32(BANKS + 4 * 8, CAVE);                                   /* bank 8 -> the cave */
    return play([...head(0, 64, 8), note(1, 60, 50, 120), cmd(400, 0xFF)], 200, e);
  }
  const full = { start: src.start, loop: src.loop, end: src.end, root: src.root };
  const lev = (env) => custom(env, full).rows.map((x) => (x.key ? x.l : -1));
  const inst = lev([63, 63, 127, 1, 63]), peak = Math.max(...inst);
  check(inst.indexOf(peak) <= 4 && inst[58] > peak * 0.99, 'attack 63: full level at once; sustain 127 with sustain rate 1 holds');
  const slow = lev([40, 63, 127, 1, 63]), at = slow.indexOf(Math.max(...slow));
  check(Math.max(...slow) === peak && at >= 25 && at <= 40 && slow[10] < peak * 0.4, `attack 40: rises to the same level in about 30 frames (${at})`);
  const dec = lev([63, 40, 64, 1, 63]);
  check(dec[10] > peak * 0.7 && near(dec[40] / peak, 65 / 128, 0.02), 'decay 40, sustain 64: falls to (sustain + 1) / 128 of the peak and stays');
  const fall = lev([63, 63, 127, 30, 63]);
  check(fall[58] < peak * 0.85 && fall[58] > peak * 0.6 && fall[30] > fall[58], 'sustain rate 30: the held level keeps falling');
  const viewed = { start: src.start + ((src.end - src.start) >> 1), root: src.root }; viewed.loop = viewed.start + 200; viewed.end = viewed.start + 600;
  const v = custom([63, 63, 127, 1, 63], viewed), regs = v.e.regs;
  const reg32 = (hi, lo) => (((regs[hi] << 16) | regs[lo]) - 0x400000) >>> 0;
  check(reg32(3, 2) === viewed.start && reg32(9, 7) === viewed.loop && reg32(11, 10) === viewed.end && v.rows[20].loop === 1 && v.rows[20].key === 1, 'a view (own start, loop and end inside an existing sample) reaches the chip as written');
  /* the end of a note: the driver clears the chip's loop flag, so a looped sound runs to its end and stops there,
   * whatever the release rate; a release is only heard while sample is left after the loop point */
  const rel = custom([63, 63, 127, 1, 40], full).rows, off = rel.findIndex((x, i) => i > 30 && x.loop === 0);
  check(off > 55 && off < 66 && rel[off].key === 1 && rel.slice(off, off + 12).some((x) => !x.key), `note end: loop flag cleared at frame ${off}, the voice stops when the sample runs out`);
  const orig = play([...head(P), note(1, 60, 50, 120), cmd(400, 0xFF)], 200).rows, o = orig.findIndex((x, i) => i > 30 && x.loop === 0);
  const before = orig[o - 1].l, drop = before * (ENV_B[56] + 1) / 65536;
  check(near(before - orig[o].l, drop, 12) && near(orig[o].l - orig[o + 1].l, drop, 12), `release: a straight line, (level at the note's end) * (table[rate] + 1) / 65536 a frame (program 20, rate 56: ${before} ${orig[o].l} ${orig[o + 1].l})`);
}

console.log(`commands: ${checks} checks, ${failed} failures`);
process.exit(failed ? 1 : 0);
