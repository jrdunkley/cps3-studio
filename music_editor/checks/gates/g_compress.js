/* GATE G5 (docs/plan/06_GATES.md, wp/A2_sequence.md): loop compression and the sequence tools.
 *
 *   node checks/gates/g_compress.js
 *
 * For every track of every Capcom piece (written out first with Seq.unroll) and for 200 seeded random
 * streams with planted repeats (tails, nesting, first-delta mismatch, counts over 255, barriers):
 *   - Seq.unroll(Seq.compress(x)) equals x, event for event;
 *   - the waits the driver crosses are the same, in order, with the same events between them (a wait split
 *     in two keeps the ticks but not the sound: the driver crosses one wait per frame, 02_DRIVER.md §2;
 *     added 2026-10-02 after G3 caught a split wait one frame late);
 *   - the driver's own reading (Seq.follow, which predates the Studio) gives the same notes and commands
 *     at the same ticks for x and for the compressed track; and unroll agrees with follow on the original;
 *   - the output compiles, decompiles and compiles to the same bytes, passes Seq.check (the twin of
 *     check_sequence.py) and, for a sample, the Python original itself;
 *   - same input gives the same output; no CA..CF command is emitted; never larger than the input;
 *   - barrier events stay outside every loop the compressor made; no loop count above 255.
 * Also: exact output for small hand-made cases, speed (a 6,000-event track in under 300 ms),
 * Seq.COMMANDS covers every command of docs/plan/02_DRIVER.md §3, and Seq.listing is stable.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const G = require('./lib.js');
const Seq = G.Seq;
const { check, done } = G.gate('G5 compress');
if (typeof Seq.compress !== 'function' || typeof Seq.unroll !== 'function') { console.log('NOT BUILT YET: Seq.compress / Seq.unroll in js/seq.js (see docs/plan)'); process.exit(2); }

const OUT = path.join(G.root, 'out', 'tests', 'G5');
fs.mkdirSync(OUT, { recursive: true });

const canon = (e) => e.k === 'note' ? `${e.d}|n${e.v},${e.n},${e.tie ? 1 : 0},${e.len}` : e.k === 'cmd' ? `${e.d}|c${e.op},${e.a.join(',')}` : `${e.d}|j${e.op},${e.to}`;
const sameEvents = (a, b) => a.length === b.length && a.every((e, i) => canon(e) === canon(b[i]));
const trackBytes = (ev) => { const t = new Array(16).fill(null); t[0] = ev; return Seq.compile({ tracks: t }); };
const size = (ev) => trackBytes(ev).length - 33;
function followSame(a, b, horizon) {
  const fa = Seq.follow(a, horizon, true), fb = Seq.follow(b, horizon, true);
  const na = fa.notes.map((x) => `${x.t}:${x.n}:${x.v}:${x.len}:${x.tie}`).join(' '), nb = fb.notes.map((x) => `${x.t}:${x.n}:${x.v}:${x.len}:${x.tie}`).join(' ');
  const ca = fa.controls.map((x) => `${x.t}:${x.op}:${x.a}`).join(' '), cb = fb.controls.map((x) => `${x.t}:${x.op}:${x.a}`).join(' ');
  return na === nb && ca === cb && fa.end === fb.end;
}
/* the waits the driver crosses, in order, with the events between them (loops that never end pass once) */
function waitPath(ev) {
  const out = [], counters = [0, 0, 0, 0], ls = [0, 0, 0, 0];
  let i = 0, guard = 0;
  while (i < ev.length && guard++ < 5e6) {
    const e = ev[i];
    if (e.d) out.push('w' + e.d);
    if (e.k === 'cmd' && e.op >= 0xD0 && e.op <= 0xD3) { ls[e.op - 0xD0] = i + 1; i++; continue; }
    if (e.k === 'cmd' && e.op >= 0xD4 && e.op <= 0xD7) {
      const c = e.op - 0xD4;
      if (e.a[0] === 0 || (c === 0 && e.a[0] >= 100)) { i++; continue; }
      if (counters[c]) { counters[c]--; i = counters[c] ? ls[c] : i + 1; } else { counters[c] = e.a[0]; i = ls[c]; }
      continue;
    }
    if (e.k === 'jump') { const c = e.op - 0xD8; if (e.op >= 0xD8 && counters[c] === 1) { counters[c] = 0; i = e.to; } else i++; continue; }
    out.push(canon(Object.assign({}, e, { d: 0 })));
    i++;
  }
  return out.join(' ');
}
/* loops the compressor made: every barrier event must sit outside them; counts at most 255 */
function loopsOk(out, inputLevels, barrierEvents) {
  let depth = 0, ok = true;
  const inside = new Set();
  out.forEach((e, i) => {
    if (e.k === 'cmd' && e.op >= 0xD1 && e.op <= 0xD3 && !inputLevels.has(e.op - 0xD0)) depth++;
    else if (e.k === 'cmd' && e.op >= 0xD5 && e.op <= 0xD7 && !inputLevels.has(e.op - 0xD4)) { depth--; if (e.a[0] > 255) ok = false; }
    else if (depth > 0) inside.add(e);
  });
  return ok && depth === 0 && barrierEvents.every((e) => !inside.has(e));
}
const noCaCf = (ev) => ev.every((e) => !(e.op >= 0xCA && e.op <= 0xCF));
let pyBatch = [];
function fullCheck(name, x, opts, horizon) {
  const t0 = process.hrtime.bigint();
  let y;
  try { y = Seq.compress(x, opts); } catch (e) { check(false, `${name}: compress threw ${e.message}`); return null; }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  let back;
  try { back = Seq.unroll(y); } catch (e) { check(false, `${name}: unroll of the compressed track threw ${e.message}`); return null; }
  check(sameEvents(back, x), `${name}: unroll(compress(x)) equals x`);
  check(followSame(x, y, horizon), `${name}: the driver's reading (Seq.follow) is the same for the compressed track`);
  const bx = size(x), by = size(y);
  check(by <= bx, `${name}: never larger (${bx} -> ${by} bytes)`);
  const seq = trackBytes(y);
  let rt = false; try { rt = Seq.compile(Seq.decompile(seq)).every((v, i) => v === seq[i]); } catch (e) { rt = false; }
  check(rt, `${name}: compile -> decompile -> compile gives the same bytes`);
  let ok = true; try { Seq.check(seq); } catch (e) { ok = false; } check(ok, `${name}: passes Seq.check`);
  check(noCaCf(y), `${name}: no CA..CF command emitted`);
  check(JSON.stringify(Seq.compress(x, opts)) === JSON.stringify(y), `${name}: same input, same output`);
  const levels = new Set(x.filter((e) => e.k === 'cmd' && e.op >= 0xD0 && e.op <= 0xD7).map((e) => (e.op - 0xD0) & 3));
  const barrierEvents = ((opts && opts.barriers) || []).map((i) => y.find((e) => e.src === i)).filter(Boolean);
  check(barrierEvents.length === ((opts && opts.barriers) || []).length && loopsOk(y, levels, barrierEvents), `${name}: barriers outside every new loop, counts at most 255`);
  return { y, bx, by, ms, seq };
}

/* ---- Seq.COMMANDS and Seq.check -------------------------------------------------------------- */
{
  const ops = [0xC1, 0xC2, 0xC3, 0xC4, 0xC5, 0xC6, 0xC7, 0xC8, 0xC9, 0xCA, 0xCB, 0xCC, 0xCD, 0xCE, 0xCF, 0xD0, 0xD1, 0xD2, 0xD3, 0xD4, 0xD5, 0xD6, 0xD7,
               0xD8, 0xD9, 0xDA, 0xDB, 0xDC, 0xDD, 0xDE, 0xDF, 0xE0, 0xE1, 0xE2, 0xE3, 0xE4, 0xE5, 0xE6, 0xE7, 0xE8, 0xFF, 0xC0];
  check(ops.every((op) => { const c = Seq.COMMANDS && Seq.COMMANDS[op]; return c && c.name && c.text && c.params === Seq.paramCount(op); }), 'Seq.COMMANDS: every command of 02_DRIVER §3 with name, text and its parameter count');
  const throws = (b) => { try { Seq.check(Uint8Array.from(b)); return false; } catch (e) { return true; } };
  check(!throws([0, 0, 33, ...new Array(30).fill(0), 0xFF]) && throws([1, 0, 33, ...new Array(30).fill(0), 0xFF]) && throws([0, 0, 34, ...new Array(30).fill(0), 0, 0xFF])
        && !throws([0, 0, 33, ...new Array(30).fill(0), 0x80, 60, 10, 0xD8, 0, 0, 0x80, 61, 10, 0xFF]) && throws([0, 0, 33, ...new Array(30).fill(0), 0x80, 60, 10, 0xD8, 0, 1, 0x80, 61, 10, 0xFF])
        && throws([0, 0, 33, ...new Array(30).fill(0), 0x80, 60]), 'Seq.check: accepts a minimal sequence; refuses a non-music byte 0, a bad first offset, an exit landing inside an event, a cut-off track');
}

/* ---- hand-made cases with known answers --------------------------------------------------------- */
{
  const n = (d, k, len) => ({ d, k: 'note', v: 40, n: k, tie: 0, len: len || 12 });
  const c = (d, op, ...a) => ({ d, k: 'cmd', op, a });
  const X = [n(12, 60), n(12, 64)], Y = [n(12, 67)];
  const body = (...parts) => [].concat(...parts.map((p) => p.map((e) => Object.assign({}, e))));
  const ops = (ev) => ev.map((e) => e.k === 'note' ? 'N' + e.n : e.k === 'jump' ? 'J' + e.op.toString(16) : e.op.toString(16) + (e.a.length ? ':' + e.a.join(',') : '')).join(' ');
  const r1 = Seq.compress(body([c(0, 0xD0)], X, X, X, X, X, [c(0, 0xD4, 0)]));
  check(ops(r1) === 'd0 d1 N60 N64 d5:4 d4:0', `X X X X X -> D1 X D5 04 (${ops(r1)})`);
  const r2 = Seq.compress(body(X, Y, X, Y, X, [c(5, 0xFF)]));
  check(ops(r2) === 'd1 N60 N64 Jd9 N67 d5:2 ff', `X Y X Y X -> D1 X D9 Y D5 02 (${ops(r2)})`);
  const Z = [n(0, 60), n(12, 64)], first = body(Z, Z, Z, Z); first[0].d = 40;
  const r3 = Seq.compress(body(first, [c(0, 0xFF)]));
  check(ops(r3) === 'd1 N60 N64 d5:3 ff' && r3[0].d === 40 && r3[1].d === 0, `first-delta mismatch with a 0 delta on later passes: the whole first wait goes on the loop start (${ops(r3)}, deltas ${r3[0].d}/${r3[1].d})`);
  const split = body(X, X, X, X); split[0].d = 40;
  const r3b = Seq.compress(body(split, [c(0, 0xFF)]));
  check(waitPath(r3b) === waitPath(body(split, [c(0, 0xFF)])) && r3b.length < 9, `first-delta mismatch with a non-zero delta on later passes: no wait is split, the repeats still loop (${ops(r3b)})`);
  const hats = []; for (let i = 0; i < 600; i++) hats.push(n(12, 42, 6));
  const r4 = Seq.compress(body([c(0, 0xD0)], hats, [c(0, 0xD4, 0)]));
  check(Seq.unroll(r4).length === 602 && r4.every((e) => !(e.op >= 0xD4 && e.op <= 0xD7) || e.a[0] <= 255) && r4.length < 12, `600 passes are split into loops of at most 256 (${ops(r4)})`);
  const A = body(X, X, X, Y), r5 = Seq.compress(body([c(0, 0xD0)], A, A, A, [c(0, 0xD4, 0)]));
  check(ops(r5) === 'd0 d1 d2 N60 N64 d6:2 N67 d5:2 d4:0', `nesting: (X X X Y) x 3 -> D1 D2 X D6 02 Y D5 02 (${ops(r5)})`);
  const r6 = Seq.compress(body([c(0, 0xD0)], X, X, X, X, [c(0, 0xD4, 0)]), { barriers: [5] });
  const seen = r6.find((e) => e.src === 5);
  check(!!seen && loopsOk(r6, new Set([0]), [seen]), `a barrier in the middle of a repeat stays outside the loops (${ops(r6)})`);
  const flat = body([c(0, 0xD0)], [n(5, 60), n(7, 61), n(9, 62)], [c(0, 0xD4, 0)]);
  check(ops(Seq.compress(flat)) === ops(flat), 'nothing to gain: unchanged');
}

/* ---- every Capcom piece ---------------------------------------------------------------------- */
const { data } = G.loadData();
let capcom = 0, plain = 0, packed = 0, tracks = 0, slowest = { ms: 0 };
for (const song of data.songs) {
  const seq = Seq.decompile(song.bytes);
  const outTracks = new Array(16).fill(null);
  seq.tracks.forEach((ev, k) => {
    if (!ev) return;
    tracks++;
    const name = `music ${song.code} track ${k + 1}`;
    let x;
    try { x = Seq.unroll(ev); } catch (e) { check(false, `${name}: unroll threw ${e.message}`); return; }
    check(followSame(ev, x, 60000), `${name}: unroll agrees with Seq.follow (notes, commands, ticks)`);
    const finite = x.filter((e) => e.k === 'cmd' && e.op >= 0xD4 && e.op <= 0xD7 && e.a[0] !== 0 && !(e.op === 0xD4 && e.a[0] >= 100));
    check(!x.some((e) => e.k === 'jump') && !finite.length, `${name}: unroll keeps only loops that never end (the main loop)`);
    const r = fullCheck(name, x, {}, 60000);
    if (!r) return;
    outTracks[k] = r.y;
    if (r.ms > slowest.ms) slowest = { ms: r.ms, name, events: x.length };
    if (song.code >= 10 && song.code <= 43) { plain += r.bx; packed += r.by; }
  });
  if (song.code >= 10 && song.code <= 43) capcom += song.bytes.length - 33;
  try { const whole = Seq.compile({ tracks: outTracks }); fs.writeFileSync(path.join(OUT, `capcom_${song.code}.bin`), whole); pyBatch.push(path.join(OUT, `capcom_${song.code}.bin`)); } catch (e) { check(false, `music ${song.code}: the compressed piece compiles (${e.message})`); }
}

/* ---- 200 seeded random streams with planted repeats --------------------------------------------- */
function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
let rx = 0, ry = 0;
for (let seed = 1; seed <= 200; seed++) {
  const R = rng(seed), pick = (a) => a[Math.floor(R() * a.length)], int = (lo, hi) => lo + Math.floor(R() * (hi - lo + 1));
  const DELTAS = [0, 1, 3, 6, 12, 12, 24, 24, 48, 200];
  const token = () => R() < 0.85 ? { d: pick(DELTAS), k: 'note', v: int(1, 63), n: int(36, 84), tie: R() < 0.05 ? 1 : 0, len: pick([6, 12, 24, 48, 130]) }
                                 : { d: pick(DELTAS), k: 'cmd', op: pick([0xC6, 0xC8, 0xC7, 0xC3, 0xE7]), a: [int(0, 127)] };
  const block = (n) => Array.from({ length: n }, token);
  const copy = (ev) => ev.map((e) => Object.assign({}, e, e.a ? { a: e.a.slice() } : {}));
  function planted(depth) {
    const kind = R();
    if (kind < 0.25 || depth > 2) return block(int(1, 6));
    if (kind < 0.55) { const X = depth < 2 && R() < 0.4 ? planted(depth + 1) : block(int(1, 5)), k = int(2, 6), out = []; for (let i = 0; i < k; i++) out.push(...copy(X)); if (R() < 0.4) out.push(...copy(X.slice(0, int(1, X.length)))); if (R() < 0.3 && out.length) out[0].d += int(1, 30); return out; }
    if (kind < 0.7) { const X = block(int(1, 2)), out = []; for (let i = 0, k = int(256, 700); i < k; i++) out.push(...copy(X)); return out; }
    const X = planted(depth + 1), Y = block(int(1, 3)), out = [];
    for (let i = 0, k = int(2, 4); i < k; i++) out.push(...copy(X), ...copy(Y));
    return out;
  }
  let body = [];
  for (let i = 0, k = int(1, 5); i < k; i++) body.push(...planted(0));
  const intro = R() < 0.4 ? planted(1) : [];
  const shape = R();
  let x;
  if (shape < 0.6) x = [...intro, { d: pick(DELTAS), k: 'cmd', op: 0xD0, a: [] }, ...body, { d: pick(DELTAS), k: 'cmd', op: 0xD4, a: [0] }];
  else if (shape < 0.8) x = [...intro, ...body, { d: pick(DELTAS), k: 'cmd', op: 0xFF, a: [] }];
  else x = [...intro, { d: 0, k: 'cmd', op: 0xD0, a: [] }, ...body, { d: 3, k: 'cmd', op: 0xD4, a: [126] }, { d: 0, k: 'cmd', op: 0xFF, a: [] }];
  const barriers = [];
  for (let i = 0, k = int(0, 3); i < k; i++) barriers.push(int(0, x.length - 1));
  const uniq = [...new Set(barriers)].sort((a, b) => a - b);
  const r = fullCheck(`random stream ${seed} (${x.length} events, barriers ${uniq.join(',') || 'none'})`, x, { barriers: uniq }, 400000);
  if (r) { rx += r.bx; ry += r.by; if (seed <= 20) { const p = path.join(OUT, `random_${seed}.bin`); fs.writeFileSync(p, r.seq); pyBatch.push(p); } }
}

/* ---- speed: a 6,000-event track ----------------------------------------------------------------- */
{
  const R = rng(4242), int = (lo, hi) => lo + Math.floor(R() * (hi - lo + 1));
  const bar = (fill) => { const out = []; for (let s = 0; s < 16; s++) { if (s % 4 === 0) out.push({ d: s ? 12 : 0, k: 'note', v: 50, n: 36, tie: 0, len: 12 }); out.push({ d: s % 4 === 0 ? 0 : 12, k: 'note', v: fill ? int(20, 60) : 30 + (s % 2) * 10, n: fill && s > 8 ? int(38, 50) : 42, tie: 0, len: 6 }); } out[0].d = 12; return out; };
  const x = [{ d: 0, k: 'cmd', op: 0xD0, a: [] }];
  for (let b = 0; x.length < 6000; b++) x.push(...bar(b % 8 === 7), ...(b % 16 === 15 ? [{ d: 0, k: 'cmd', op: 0xC6, a: [int(60, 90)] }] : []));
  x.push({ d: 12, k: 'cmd', op: 0xD4, a: [0] });
  const r = fullCheck(`synthetic drum track (${x.length} events)`, x, {}, 400000);
  if (r) check(r.ms < 300, `a ${x.length}-event track compresses in ${r.ms.toFixed(0)} ms (limit 300)`);
  const noise = [{ d: 0, k: 'cmd', op: 0xD0, a: [] }];
  for (let i = 0; i < 6000; i++) noise.push({ d: int(1, 40), k: 'note', v: int(1, 63), n: int(30, 90), tie: 0, len: int(1, 200) });
  noise.push({ d: 1, k: 'cmd', op: 0xD4, a: [0] });
  const t = process.hrtime.bigint(); const y = Seq.compress(noise); const ms = Number(process.hrtime.bigint() - t) / 1e6;
  check(ms < 300 && sameEvents(Seq.unroll(y), noise), `6,000 events with no repeats: ${ms.toFixed(0)} ms (limit 300), unchanged in sound`);
}

/* ---- the Python original of check_sequence on a sample ------------------------------------------ */
{
  const list = path.join(OUT, 'py_list.txt');
  fs.writeFileSync(list, pyBatch.join('\n'));
  const py = `import ast, struct, sys
src = open(r'${path.join(G.root, 'check_sequence.py')}', encoding='utf-8').read()
tree = ast.parse(src)
ns = {'struct': struct}
for node in tree.body:
    if (isinstance(node, ast.Assign) and any(getattr(t, 'id', '') == 'PARAMS' for t in node.targets)) or (isinstance(node, ast.FunctionDef) and node.name == 'check_sequence'):
        exec(compile(ast.Module(body=[node], type_ignores=[]), 'check_sequence.py', 'exec'), ns)
bad = 0
for p in open(sys.argv[1]).read().split('\\n'):
    try: ns['check_sequence'](open(p, 'rb').read())
    except Exception as e: bad += 1; print('BAD', p, e)
print('checked', len(open(sys.argv[1]).read().split('\\n')), 'bad', bad)`;
  let out = '';
  try { out = execFileSync('python', ['-B', '-c', py, list], { windowsHide: true, encoding: 'utf8' }); } catch (e) { out = String(e.stdout || e.message); }
  check(/checked \d+ bad 0/.test(out), `check_sequence.py (Python) accepts ${pyBatch.length} compressed sequences (${out.trim().split('\n').pop()})`);
}

/* ---- listing --------------------------------------------------------------------------------- */
{
  const song = data.songs.find((s) => s.code === 16);
  const a = Seq.listing(song.bytes), b = Seq.listing(song.bytes);
  const events = Seq.decompile(song.bytes).tracks.filter(Boolean).reduce((s, t) => s + t.length, 0);
  const lines = a.split('\n').filter((l) => /^\s*[0-9A-F]{4,} /.test(l));
  check(a === b && lines.length === events && /loop start/.test(a) && /note /.test(a), `Seq.listing: stable, one line per event (${lines.length} of ${events}), loops and notes named`);
  const ev = Seq.decompile(song.bytes).tracks.find(Boolean);
  check(typeof Seq.listing(ev) === 'string' && Seq.listing(ev).split('\n').filter((l) => /^\s*[0-9A-F]{4,} /.test(l)).length === ev.length, 'Seq.listing of one track\'s events');
}
done(`${tracks} Capcom tracks; stage themes: Capcom ${capcom} bytes of tracks, written out ${plain}, compressed ${packed} (${(packed / capcom).toFixed(2)} x Capcom); random streams ${rx} -> ${ry} bytes; slowest real track ${slowest.ms.toFixed(0)} ms (${slowest.name}, ${slowest.events} events)`);
