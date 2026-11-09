/* Open Capcom's music exactly (wp/A4_decompile.md; gate G4: checks/gates/g_capcom.js).
 *
 *   SF3Decomp.fromGame(song, info) -> a version-2 project that SF3Compile.build turns back into the same sound
 *   SF3Decomp.walk(events, opts)   -> what the driver plays on one track, in order (loops, counts, last-pass exits)
 *   SF3Decomp.annotate(project)    -> [{ partId, of, kind: 'echo' | 'double' | 'harmony', delay, interval, level }] (annotation only)
 *
 * How (exact first, readable second):
 *  - Each track is walked as the driver walks it (Seq's loop rules; a long-count main loop, D4 126, counts as
 *    forever). Its main loop is the loop that never ends; it starts where that loop's start command runs (tick
 *    X) and lasts L ticks. The song loop starts at the earliest X and lasts the least common multiple of the
 *    L's; a track with a shorter loop is written out to the full length, and its part's loopShift = X - start.
 *    A piece with no main loop plays once: each part ends where its FF is.
 *  - One part per track (track pinned, one voice). Every command becomes a point at its exact tick (t = tick -
 *    lead): a lane where the setting has one, a marker for E8 on the tempo track, a raw command otherwise. Within
 *    a tick: before D0 -> pre; after the note -> post; before the loop end or FF on the last tick -> pre.
 *    loopRestore false (passes run on, as the driver plays them); autoTune false; the part's own fields are the
 *    values in force at its first note, null where the track never set them (the driver's own default stays).
 *  - Timing: the driver crosses one wait per frame (02_DRIVER.md §2), so the rebuilt track must have events on
 *    exactly the ticks the original has. Loop commands, written-out loop ends and commands the compiler finds
 *    needless leave a tick empty; a C0 (the driver's no-op) is put there. Checked here by building the project
 *    and comparing the ticks; extra ticks in the rebuild throw (they would move the music).
 */
(function (g) {
  'use strict';
  const Seq = g.SF3Seq || require('./seq.js');
  const Compile = g.SF3Compile || require('./compile.js');
  const Catalog = g.SF3Catalog || (typeof require === 'function' ? (() => { try { return require('./catalog.js'); } catch (e) { return null; } })() : null);
  const BAR = Seq.BAR;
  const s8 = (v) => (v << 24) >> 24;
  const gcd = (a, b) => (b ? gcd(b, a % b) : a), lcm = (a, b) => a / gcd(a, b) * b;
  const isStart = (e) => e.k === 'cmd' && e.op >= 0xD0 && e.op <= 0xD3;
  const isEnd = (e) => e.k === 'cmd' && e.op >= 0xD4 && e.op <= 0xD7;
  const isExit = (e) => e.k === 'jump' && e.op >= 0xD8 && e.op <= 0xDB;

  /* the main loop: the loop end that never finishes (count 0, or a long count on level 0) and its start */
  function mainLoop(events) {
    const open = [[], [], [], []];
    let found = null;
    events.forEach((e, i) => {
      if (isStart(e)) open[e.op - 0xD0].push(i);
      else if (isEnd(e)) {
        const lv = e.op - 0xD4, s = open[lv].pop();
        if (!found && s !== undefined && (e.a[0] === 0 || (lv === 0 && e.a[0] >= 100))) found = { start: s, end: i };
      }
    });
    return found;
  }

  /* Walk one track as the driver does. opts: { stopAt (tick of the main loop end to stop at), maxTicks }.
   * Returns { items: [{ s, e, i, kind: 'note' | 'cmd' | 'flow' | 'mainStart' | 'mainEnd' | 'ff' }], loop: { X, L } | null, ff } */
  function walk(events, opts) {
    opts = opts || {};
    const main = mainLoop(events);
    const counters = [0, 0, 0, 0], loopStart = [0, 0, 0, 0];
    const items = [];
    let i = 0, s = 0, X = null, L = null, ff = null, guard = 0;
    const max = opts.maxTicks || 400000;
    while (i < events.length) {
      if (++guard > 5e6) throw new Error('decomp: the track never ends');
      const e = events[i];
      s += e.d;
      if (s > max) throw new Error(`decomp: the track runs past ${max} ticks`);
      if (e.k === 'note') { items.push({ s, e, i, kind: 'note' }); i++; continue; }
      if (main && i === main.start) {
        if (X === null) { X = s; items.push({ s, e, i, kind: 'mainStart' }); }
        loopStart[e.op - 0xD0] = i + 1; i++; continue;
      }
      if (main && i === main.end) {
        if (L === null) L = s - X;
        if (opts.stopAt !== undefined && s >= opts.stopAt) { items.push({ s, e, i, kind: 'mainEnd' }); break; }
        items.push({ s, e, i, kind: 'flow' });
        i = loopStart[e.op - 0xD4];
        if (opts.stopAt === undefined) break;                         /* first pass only: X and L are known */
        continue;
      }
      if (isStart(e)) { items.push({ s, e, i, kind: 'flow' }); loopStart[e.op - 0xD0] = i + 1; i++; continue; }
      if (isEnd(e)) {
        items.push({ s, e, i, kind: 'flow' });
        const c = e.op - 0xD4;
        if (counters[c]) { counters[c]--; i = counters[c] ? loopStart[c] : i + 1; }
        else if (e.a[0] === 0) i = loopStart[c];
        else { counters[c] = e.a[0]; i = loopStart[c]; }
        continue;
      }
      if (isExit(e)) {
        items.push({ s, e, i, kind: 'flow' });
        const c = e.op - 0xD8;
        if (counters[c] === 1) { counters[c] = 0; i = e.to; } else i++;
        continue;
      }
      if (e.k === 'jump') {
        items.push({ s, e, i, kind: 'flow' });
        if (e.op === 0xCE) { i = e.to; continue; }
        throw new Error(`decomp: jump ${e.op.toString(16)} is not handled`);
      }
      if (e.op === 0xFF) { ff = s; items.push({ s, e, i, kind: 'ff' }); break; }
      items.push({ s, e, i, kind: 'cmd' });
      i++;
    }
    return { items, loop: X !== null && L ? { X, L } : null, ff };
  }

  const LANE_OF = { 0xC6: 'volume', 0xC8: 'expression', 0xC7: 'pan', 0xC3: 'detune', 0xE7: 'fine', 0xDE: 'gain', 0xC5: 'vibDepth', 0xE1: 'vibRate', 0xE2: 'tremolo', 0xE0: 'vibSync', 0xC9: 'slide' };

  function partName(k, program, bank) {
    if (Catalog && Catalog.NAMES && bank === 0 && Catalog.NAMES[program]) return `${k + 1} · ${Catalog.NAMES[program][0]}`;
    return `Track ${k + 1}`;
  }
  function roleOf(program, bank, notes) {
    if (bank === 0 && Catalog && Catalog.ROLE_OF && Catalog.ROLE_OF[program]) return Catalog.ROLE_OF[program];
    if (!notes.length) return null;
    const med = notes.map((n) => n.n).sort((a, b) => a - b)[notes.length >> 1];
    return med < 48 ? 'bass' : 'lead';
  }

  /* ---- a piece -> a project ------------------------------------------------------------------------- */
  function fromGame(song, info) {
    info = info || (g.SF3Data || require('./gamedata.js')).describe(song);
    const seq = info.seq || Seq.decompile(song.bytes);
    const lead = info.lead || 0;
    /* each track's main loop, then the song loop */
    const first = [];
    seq.tracks.forEach((ev, k) => { if (ev) first.push({ k, ev, w: walk(ev) }); });
    const loops = first.filter((x) => x.w.loop);
    const looping = loops.length > 0;
    if (looping && loops.length !== first.length) throw new Error(`music ${song.code}: some tracks loop and some do not`);
    let S = 0, LL = 0;
    if (looping) { S = Math.min(...loops.map((x) => x.w.loop.X)); LL = loops.map((x) => x.w.loop.L).reduce(lcm); }
    const tempoTrack = first.find((x) => x.w.items.some((it) => it.kind === 'cmd' && it.e.op === 0xC1));
    let tempoWord = 0;
    const markers = [];
    const parts = [];
    const walks = new Map();
    for (const { k, ev } of first) {
      const w0 = first.find((x) => x.k === k).w;
      const w = looping ? walk(ev, { stopAt: w0.loop.X + LL }) : walk(ev);
      walks.set(k, w);
      const X = looping ? w0.loop.X : null, stop = looping ? X + LL : w.ff;
      const auto = {}, raw = [], notes = [];
      const lane = (name, pt) => { (auto[name] = auto[name] || []).push(pt); };
      let bank = null, program = null, firstNote = null;
      const at1 = {};                                               /* settings in force at the first note */
      const its = w.items;
      for (let j = 0; j < its.length; j++) {
        const it = its[j], e = it.e, t = it.s - lead;
        if (it.kind === 'note') {
          if (!firstNote) { firstNote = it; Object.assign(at1, { bank, program }); }
          notes.push({ t, n: e.n, v: Math.max(1, e.v * 2), len: e.len });
          if (e.tie) notes[notes.length - 1].tie = true;
          continue;
        }
        if (it.kind !== 'cmd') continue;
        /* where in its tick: before D0 / before the loop end or FF (pre), after this tick's note (post) */
        const sameTick = (q) => q.s === it.s;
        let pre = false, post = false;
        if (looping && it.s === X && its.some((q, m) => m > j && sameTick(q) && q.kind === 'mainStart')) pre = true;
        if (it.s === stop && its.some((q, m) => m > j && sameTick(q) && (q.kind === 'mainEnd' || q.kind === 'ff'))) pre = true;
        if (its.some((q, m) => m < j && sameTick(q) && q.kind === 'note')) post = true;
        const flags = pre ? { pre: true } : post ? { post: true } : {};
        const op = e.op, a = e.a;
        if (op === 0xC1 && tempoTrack && k === tempoTrack.k && it.s === 0 && !tempoWord) { tempoWord = (a[0] << 8) | a[1]; continue; }
        if (op === 0xE8 && tempoTrack && k === tempoTrack.k) { markers.push(Object.assign({ t, i: a[0], v: a[1] }, pre ? { pre: true } : {})); continue; }
        if (op === 0xC2) { bank = a[0] & 15; lane('program', Object.assign({ t, v: null, bank }, flags)); continue; }      /* the bank only */
        if (op === 0xC4) { program = a[0] & 127; lane('program', Object.assign({ t, v: program }, bank === null ? {} : { bank }, flags)); continue; }
        const name = LANE_OF[op];
        if (name && (op === 0xC3 || op === 0xDE || a[0] <= 127)) {             /* C3 and DE are signed: every byte is a value */
          const v = op === 0xC3 || op === 0xDE ? s8(a[0]) : op === 0xE0 ? (a[0] ? 1 : 0) : a[0];
          lane(name, Object.assign({ t, v }, flags));
          if (!firstNote) at1[name] = v;
          continue;
        }
        raw.push(Object.assign({ t, op, a: a.slice() }, flags));
      }
      const fieldOr = (name) => (at1[name] === undefined ? null : at1[name]);
      const part = {
        id: `t${k + 1}`, name: partName(k, at1.program === null || at1.program === undefined ? 0 : at1.program, at1.bank || 0), role: null, color: null,
        bank: at1.bank === undefined ? null : at1.bank, program: at1.program === undefined ? null : at1.program,
        volume: fieldOr('volume'), expression: fieldOr('expression'), pan: fieldOr('pan'),
        transpose: 0, gain: 0, tune: 0, voices: 1, mute: false, solo: false, track: k,
        loopShift: looping ? X - S : 0, end: looping ? null : (w.ff === null ? null : w.ff - lead), legato: false,
        vibrato: { depth: 0, rate: 0, sync: false, delay: 0, tremolo: 0 }, layer: null,
        notes, automation: auto, devices: [], raw,
      };
      part.role = roleOf(part.program || 0, part.bank || 0, notes);
      parts.push(part);
    }
    const P = {
      format: 'sf3project', version: 2, name: song.name || `Music ${song.code}`, author: 'Capcom', comment: `Opened from the game (music ${song.code}).`,
      bpm: Seq.tempoToBpm(tempoWord || info.tempo || 256), tempoChanges: [],
      bars: 1, length: null, loop: { on: false }, markerBars: 0, markers, tempoPart: tempoTrack ? `t${tempoTrack.k + 1}` : null,
      leadIn: lead, loopRestore: false, autoTune: false, key: null, sections: [], chorusBar: null, parts, bank: null, names: {}, ui: {},
    };
    if (looping) {
      const start = S - lead, end = start + LL;
      P.loop = { on: true, start, end, startBar: Math.floor(start / BAR) + 1, endBar: Math.ceil(end / BAR) };
      P.bars = Math.ceil(end / BAR);
    } else {
      const ends = parts.map((p) => p.end).filter((x) => x !== null);
      P.length = ends.length ? Math.max(...ends) : 0;
      P.bars = Math.max(1, Math.ceil(P.length / BAR));
    }
    fillTicks(P, walks, lead, song);
    return P;
  }

  /* Put a C0 (no-op) on every tick where the original track has an event and the rebuild has none. */
  function fillTicks(P, walks, lead, song) {
    for (let round = 0; round < 3; round++) {
      const built = Compile.build(P, { compress: false, includeMuted: true });
      let added = 0;
      for (const part of P.parts) {
        const k = part.track, w = walks.get(k);
        const slot = built.report.tracks.find((x) => x.partId === part.id);
        if (!slot) throw new Error(`music ${song.code}: track ${k + 1} was not built`);
        const have = new Set();
        let s = 0;
        for (const e of built.plainTracks[slot.track]) { s += e.d; have.add(s); }
        const want = new Set(w.items.map((it) => it.s));
        const missing = Array.from(want).filter((x) => !have.has(x));
        const extra = Array.from(have).filter((x) => !want.has(x));
        if (extra.length) throw new Error(`music ${song.code} track ${k + 1}: the rebuild has events on ticks the original has none (${extra.slice(0, 6).join(', ')})`);
        for (const x of missing) { part.raw.push({ t: x - lead, op: 0xC0, a: [] }); added++; }
        part.raw.sort((a, b) => a.t - b.t);
      }
      if (!added) return;
    }
    throw new Error(`music ${song.code}: the event ticks did not settle`);
  }

  /* ---- annotate: which parts are echoes or doubles of which (style/techniques.js copyOf's idea) ------------- */
  function annotate(project) {
    const out = [];
    const parts = project.parts || [];
    parts.forEach((b, bi) => {
      for (const a of parts.slice(0, bi)) {                           /* the source is an earlier part */
        if (!a.notes.length || a.notes.length !== b.notes.length) continue;
        const d = b.notes[0].t - a.notes[0].t, iv = b.notes[0].n - a.notes[0].n;
        if (d < 0 || d > 48 || (d === 0 && iv === 0)) continue;
        if (!a.notes.every((n, i) => b.notes[i].t - n.t === d && b.notes[i].n - n.n === iv && b.notes[i].len === n.len)) continue;
        const ea = (a.expression || 0) * (a.volume || 0), eb = (b.expression || 0) * (b.volume || 0);
        const kind = d === 0 ? 'harmony' : d <= 2 ? 'double' : 'echo';
        out.push({ partId: b.id, of: a.id, kind, delay: d, interval: iv, level: ea ? +(eb / ea).toFixed(2) : null });
        break;
      }
    });
    return out;
  }

  const api = { fromGame, walk, mainLoop, annotate };
  g.SF3Decomp = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
