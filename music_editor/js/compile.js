/* The Studio's compiler: a project (version 1 or 2) into exactly the bytes the game plays.
 * Contract: docs/plan/04_FORMATS.md §1-2, 03_ARCHITECTURE.md §3-4; driver facts: 02_DRIVER.md.
 * Gates: G3 (the user's version-1 songs sound unchanged, checks/gates/g_v1_upgrade.js), G4 (all of
 * Capcom's music reopens and rebuilds sound-identical, with decomp.js), G6 (devices and rules,
 * checks/gates/g_devices.js).
 *
 * How a track is made. Everything a part says becomes items on a timeline of sequence ticks (song tick
 * + leadIn; a delayed copy adds its delay): the set-up, notes, lane points, raw commands, note bends,
 * delayed vibrato, Duck and Gate points, tempo and phrase markers (tempo track), the loop start and end.
 * Items at one tick go in this order: set-up, `pre` points, loop start, tempo, marker 1, points, the note,
 * `post` points (and bends), marker 2, loop end. At each item every setting the track has (bank,
 * program, volume, expression, pan, pitch as C3+E7, gain, LFO, glide; tempo on the tempo track) is
 * worked out and a command is written only where it differs from what the track already has. Settings
 * the driver starts neutral (pitch, gain, LFO, glide) are assumed neutral; the others start unknown.
 * The main loop: with loopRestore, every pass starts from the settings in force at the loop start (the
 * commands are written straight after D0 where some pass would otherwise differ); without it, every
 * setting that a pass can enter differently is treated as unknown at the loop start, so its first use
 * in the loop writes it (exactly what a copy of Capcom's music needs).
 */
(function (g) {
  'use strict';
  const Seq = g.SF3Seq || require('./seq.js');
  const BAR = Seq.BAR, LEAD_IN = Seq.LEAD_IN;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const has = (o, k) => o !== null && o !== undefined && o[k] !== undefined && o[k] !== null;

  /* ---- the project: defaults, version 1 -> 2 -------------------------------------------------- */
  const VIBRATO = { depth: 0, rate: 100, sync: true, delay: 0, tremolo: 0 };
  const DEVICE_DEFAULTS = {
    echo: { delay: 24, level: 0.5, pan: 'opposite', interval: 0, voices: null, repeats: 1 },
    double: { offset: 2, pan: 'opposite', detune: 0, level: 1 },
    harmony: { interval: -7, level: 0.7, pan: null },
    duck: { source: null, keys: null, depth: 0.6, hold: 6, release: 24 },
    gate: { pattern: [1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0], depth: 1, step: 12 },
    autopan: { mode: 'pingpong', width: 48, center: 64 },
    glide: { mode: 'slurred', rate: 40 },
    swing: { amount: 0.33, unit: 24 },
    humanize: { timing: 0, velocity: 6, seed: 1 },
  };
  const AUTO_TUNE_SURE = 0.8;      /* catalog tuningConfidence needed before auto-tune corrects a program */
  const LANES = ['volume', 'expression', 'pan', 'pitch', 'detune', 'fine', 'gain', 'vibDepth', 'vibRate', 'tremolo', 'vibSync', 'slide', 'program'];

  function partDefaults(i) {
    return { id: `p${i + 1}`, name: `Part ${i + 1}`, role: null, color: null, bank: 0, program: 0, volume: 80, expression: 100, pan: 64,
             transpose: 0, gain: 0, tune: 0, voices: 1, mute: false, solo: false, track: null, loopShift: 0, end: null, legato: false,
             vibrato: Object.assign({}, VIBRATO), layer: null, notes: [], automation: {}, devices: [], raw: [] };
  }
  function songDefaults() {
    return { format: 'sf3project', version: 2, name: 'Untitled', author: '', comment: '', bpm: 120, tempoChanges: [], bars: 8, length: null,
             loop: { on: true, startBar: 1, endBar: 8, start: 0, end: 8 * BAR }, markerBars: 2, markers: null, tempoPart: null, leadIn: LEAD_IN,
             loopRestore: true, autoTune: true, key: null, sections: [], chorusBar: null, parts: [], bank: null, names: {}, ui: {} };
  }
  const isV2 = (p) => !!p && p.format === 'sf3project' && p.version === 2;

  /* Version 1 (the old editor's projects and every song file in songs/) -> version 2: the same song.
   * Defaults are those that keep the sound (autoTune off, loopRestore on: version 1 put a part's own
   * settings back at every loop pass). A version-2 project comes back as it is. */
  function upgrade(project) {
    if (isV2(project)) return project;
    const p = clone(project), bars = p.bars || 1, loop = p.loop || { on: false, startBar: 1, endBar: bars };
    const out = songDefaults();
    for (const k of Object.keys(p)) if (k !== 'parts' && k !== 'loop') out[k] = p[k];
    Object.assign(out, { format: 'sf3project', version: 2, bars, length: null, markerBars: Number(p.markerBars) || 0, markers: null,
                         tempoPart: null, leadIn: LEAD_IN, loopRestore: true, autoTune: false, key: null, sections: [], chorusBar: null, bank: null,
                         names: p.names || {}, ui: p.ui || {}, tempoChanges: p.tempoChanges || [] });
    out.loop = { on: !!loop.on, startBar: loop.startBar, endBar: loop.endBar, start: (loop.startBar - 1) * BAR, end: loop.endBar * BAR };
    const ids = new Set();
    out.parts = (p.parts || []).map((part, i) => {
      const q = Object.assign(partDefaults(i), part);
      q.id = uniqueId(part.id || `p${i + 1}`, ids);
      q.vibrato = Object.assign({}, VIBRATO, part.vibrato || {});
      return q;
    });
    return out;
  }
  function uniqueId(id, used) { let k = String(id), n = 2; while (used.has(k)) k = `${id}_${n++}`; used.add(k); return k; }

  /* A complete version-2 copy of any project: every field the compiler reads, with its default. */
  function normalize(project) {
    const p = isV2(project) ? clone(project) : upgrade(project);
    const d = songDefaults();
    for (const k of Object.keys(d)) if (p[k] === undefined) p[k] = d[k];
    if (!p.loop) p.loop = { on: false };
    const L = p.loop;
    if (L.start === undefined || L.start === null) L.start = ((L.startBar || 1) - 1) * BAR;
    if (L.end === undefined || L.end === null) L.end = (L.endBar || p.bars) * BAR;
    if (L.startBar === undefined) L.startBar = Math.floor(L.start / BAR) + 1;
    if (L.endBar === undefined) L.endBar = Math.ceil(L.end / BAR);
    L.on = !!L.on;
    const ids = new Set();
    p.parts = (p.parts || []).map((part, i) => {
      const q = Object.assign(partDefaults(i), part);
      q.id = uniqueId(part.id || `p${i + 1}`, ids);
      q.vibrato = Object.assign({}, VIBRATO, part.vibrato || {});
      q.automation = q.automation || {};
      q.devices = (q.devices || []).map((dv) => Object.assign({}, DEVICE_DEFAULTS[dv.type] || {}, dv));
      q.raw = q.raw || [];
      q.notes = q.notes || [];
      return q;
    });
    return p;
  }

  /* ---- small helpers ------------------------------------------------------------------------ */
  function rng(seed) { let s = (seed >>> 0) || 1; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  const tempoWord = (bpm) => Seq.bpmToTempo(bpm);
  const s8 = (v) => v & 0xFF;
  function partEnd(P, part) {
    if (P.loop.on) return P.loop.end + (part.loopShift || 0);
    if (has(part, 'end')) return part.end;
    return has(P, 'length') ? P.length : P.bars * BAR;
  }

  /* Notes after the devices that move notes (swing, humanize) or mark them (glide, autopan). */
  function processNotes(part) {
    let notes = part.notes.map((n) => Object.assign({}, n));
    for (const dv of part.devices) {
      if (!dv || dv.on === false) continue;
      if (dv.type === 'swing') {
        const u = Math.max(1, Math.round(dv.unit)), shift = Math.round(clamp(dv.amount, 0, 0.5) * u);
        notes = notes.map((n) => (((n.t % (2 * u)) + 2 * u) % (2 * u) === u && shift ? Object.assign({}, n, { t: n.t + shift, len: Math.max(1, n.len - shift) }) : n));
      } else if (dv.type === 'humanize') {
        const r = rng(dv.seed), order = notes.map((n, i) => i).sort((a, b) => notes[a].t - notes[b].t || notes[a].n - notes[b].n || a - b);
        const out = notes.slice();
        for (const i of order) {
          const n = notes[i], dt = dv.timing ? Math.round((r() * 2 - 1) * dv.timing) : 0, dvv = dv.velocity ? Math.round((r() * 2 - 1) * dv.velocity) : 0;
          if (!dv.timing) r();
          out[i] = Object.assign({}, n, { t: Math.max(0, n.t + dt), v: clamp(n.v + dvv, 1, 127) });
        }
        notes = out;
      } else if (dv.type === 'glide') {
        const sorted = notes.map((n, i) => i).sort((a, b) => notes[a].t - notes[b].t || a - b);
        let prev = null;
        notes = notes.slice();
        for (const i of sorted) {
          const n = notes[i];
          const slurred = prev && (prev.tie || (part.legato && n.t <= prev.t + prev.len));
          if (prev && (dv.mode === 'all' || slurred) && !has(n, 'slide')) notes[i] = Object.assign({}, n, { slide: clamp(Math.round(dv.rate), 1, 127) });
          prev = n;
        }
      } else if (dv.type === 'autopan') {
        const sorted = notes.map((n, i) => i).sort((a, b) => notes[a].t - notes[b].t || a - b);
        notes = notes.slice();
        sorted.forEach((i, k) => {
          if (has(notes[i], 'pan')) return;
          const half = Math.round(dv.width / 2);
          notes[i] = Object.assign({}, notes[i], { pan: clamp(dv.center + (k % 2 ? half : -half), 0, 127) });
        });
      }
    }
    return notes;
  }

  /* One voice's notes, as version 1 cut and clipped them, with slurs (tie / legato). */
  function voiceNotes(notes, end, part, report) {
    const out = [];
    notes.forEach((note, i) => {
      const next = notes[i + 1];
      let len = note.len;
      const touches = next && next.t <= note.t + note.len;
      if (next && note.t + len > next.t) len = next.t - note.t;
      if (note.t + len > end) { len = end - note.t; report.clipped++; }
      const n = note.n + (part.transpose || 0);
      if (n < 0 || n > 127 || len <= 0) { report.dropped++; return; }
      const bend = (note.bend || []).filter(([dt]) => dt >= 0 && dt < (next ? next.t - note.t : end - note.t));
      const tie = !!next && next.t < end && (note.tie || (part.legato && touches)) ? 1 : 0;
      out.push({ src: note, t: note.t, n, v: clamp(Math.round(note.v / 2), 1, 63), len: tie ? next.t - note.t : len, tie, bend, nextT: next ? next.t : end });
    });
    return out;
  }

  /* ---- settings ------------------------------------------------------------------------------ */
  const ORDER = ['tempo', 'bank', 'program', 'volume', 'expression', 'pan', 'detune', 'fine', 'gain', 'vibSync', 'vibRate', 'vibDepth', 'tremolo', 'slide'];
  const OP = { bank: 0xC2, program: 0xC4, volume: 0xC6, expression: 0xC8, pan: 0xC7, detune: 0xC3, fine: 0xE7, gain: 0xDE, vibSync: 0xE0, vibRate: 0xE1, vibDepth: 0xC5, tremolo: 0xE2, slide: 0xC9 };
  const OP_SETTING = {};
  for (const k of Object.keys(OP)) OP_SETTING[OP[k]] = k;
  OP_SETTING[0xC1] = 'tempo';
  /* the driver's channel values after a music request, as far as the Studio relies on them */
  const NEUTRAL = { detune: 0, fine: 64, gain: 0, vibSync: 0, vibRate: 0, vibDepth: 0, tremolo: 0, slide: 0 };
  const UNKNOWN = undefined;
  const CARRY = '(carried from the pass before)';
  const command = (k, v) => (k === 'tempo' ? [0xC1, (v >> 8) & 0xFF, v & 0xFF] : [OP[k], (k === 'detune' || k === 'gain') ? s8(v) : v & 0x7F]);
  const settingOfRaw = (op, a) => (op === 0xC1 ? ['tempo', (a[0] << 8) | a[1]] : OP_SETTING[op] ? [OP_SETTING[op], (op === 0xC3 || op === 0xDE) ? ((a[0] << 24) >> 24) : a[0]] : null);

  /* ---- one track ----------------------------------------------------------------------------- */
  /* spec: { P, part, notes (voiceNotes), lead, delay, level, pan ('opposite' | number | null), interval,
   *         cents, tempo (bool), raw (bool), loop: { start, end } | null (song ticks, with the part's shift),
   *         end (song tick of FF when no loop), duck: [t], gate: { pattern, depth, step } | null, tune (fn) } */
  function makeTrack(spec, warnings) {
    const { P, part } = spec, lead = spec.lead, D = spec.delay || 0;
    const items = [];
    let seq = 0;
    const add = (s, ph, it) => { it.s = s; it.ph = ph; it.q = seq++; items.push(it); };
    const at = (t) => t + lead + D;                                 /* song tick -> sequence tick */
    const end = spec.loop ? spec.loop.end : spec.end;
    const inSong = (t) => t + lead >= 0 && t < end;
    /* points, raw commands and markers: a `pre` one may also sit on the loop end (or FF) tick, written before it */
    const inSongPt = (pt) => pt.t + lead >= 0 && (pt.t < end || (pt.t === end && !!pt.pre));
    const notes = spec.notes;
    const first = notes[0] || null;

    /* set-up: tempo and bank at tick 0, the rest at tick 1 (or 0 with no lead-in; a cycle build puts all
     * of it at tick 0: the driver crosses one wait per frame, so a 1-tick wait just before the first
     * notes would make them a frame late against the same notes inside the song). A setting that a lane
     * sets before the first note is left to the lane (no extra command, no extra wait). */
    add(0, 1, { k: 'setup', only: ['tempo', 'bank'] });
    add(spec.setupAt === undefined ? Math.min(1, lead) : spec.setupAt, 1, { k: 'setup', only: null });
    if (spec.loop) {
      add(at(spec.loop.start), 3, { k: 'loopStart' });
      add(at(spec.loop.end), 10, { k: 'loopEnd' });
    } else add(at(spec.end), 10, { k: 'end' });
    /* lanes */
    const lanes = part.automation || {};
    for (const name of Object.keys(lanes).sort()) {
      if (!LANES.includes(name)) { warnings.push({ code: 'lane.unknown', message: `The lane "${name}" is not one the game has; it was left out.`, partId: part.id }); continue; }
      for (const pt of lanes[name] || []) if (inSongPt(pt)) add(at(pt.t), pt.pre ? 2 : pt.post ? 8 : 6, { k: 'lane', lane: name, v: pt.v, bank: pt.bank });
    }
    /* settings a lane sets before the first note (or anywhere, when the part has no notes) */
    const laneSets = new Set();
    const LANE_SETS = { volume: ['volume'], expression: ['expression'], pan: ['pan'], pitch: ['detune', 'fine'], detune: ['detune', 'fine'], fine: ['detune', 'fine'],
                        gain: ['gain'], vibDepth: ['vibDepth'], vibRate: ['vibRate'], tremolo: ['tremolo'], vibSync: ['vibSync'], slide: ['slide'], program: ['program'] };
    for (const name of Object.keys(lanes)) {
      if (!LANE_SETS[name]) continue;
      for (const pt of lanes[name] || []) {
        if (!inSongPt(pt) || (first && (pt.t > first.t || (pt.t === first.t && pt.post)))) continue;
        if (name !== 'program' || (pt.v !== undefined && pt.v !== null)) for (const k of LANE_SETS[name]) laneSets.add(k);
        if (name === 'program' && pt.bank !== undefined && pt.bank !== null) laneSets.add('bank');
      }
    }
    if (spec.raw) for (const r of part.raw || []) {
      if (!inSongPt(r)) continue;
      if (D && (r.op === 0xE8 || r.op === 0xC1)) continue;
      add(at(r.t), r.pre ? 2 : r.post ? 8 : 6, { k: 'raw', op: r.op, a: (r.a || []).slice() });
    }
    /* notes, their bends, delayed vibrato */
    const vib = part.vibrato || VIBRATO;
    for (const note of notes) {
      add(at(note.t), 7, { k: 'note', note });
      for (const [dt, value] of note.bend) if (dt > 0) add(at(note.t + dt), 8, { k: 'bend', note, v: value });
      if (vib.delay > 0 && vib.depth > 0 && vib.delay < note.nextT - note.t) add(at(note.t + vib.delay), 8, { k: 'vibOn', note });
    }
    /* Duck and Gate: expression multipliers */
    const duckAt = [];
    if (spec.duck) for (const d of spec.duck) {
      const { times, depth, hold, release } = d;
      for (const t0 of times) {
        if (!inSong(t0)) continue;
        add(at(t0), 6, { k: 'mod' });
        if (inSong(t0 + hold)) add(at(t0 + hold), 6, { k: 'mod' });
        for (let x = 3; x < release; x += 3) if (inSong(t0 + hold + x)) add(at(t0 + hold + x), 6, { k: 'mod', ramp: true });
        if (inSong(t0 + hold + release)) add(at(t0 + hold + release), 6, { k: 'mod' });
      }
      duckAt.push({ times: times.slice().sort((a, b) => a - b), depth, hold, release });
    }
    if (spec.gate) for (let t = 0; t < end; t += Math.max(2, spec.gate.step)) add(at(t), 6, { k: 'mod' });
    /* tempo track: tempo changes and phrase markers */
    const tempoAt = (t) => { let bpm = P.bpm; for (const c of P.tempoChanges || []) if (c.t <= t) bpm = c.bpm; return tempoWord(bpm); };
    if (spec.tempo) {
      for (const c of (P.tempoChanges || []).slice().sort((a, b) => a.t - b.t)) if (c.t > 0 && c.t < end) add(at(c.t), 4, { k: 'tempo', t: c.t });
      if (Array.isArray(P.markers)) {
        for (const m of P.markers) if (inSongPt(m)) add(at(m.t), m.pre ? 2 : m.v === 2 ? 9 : 5, { k: 'marker', i: m.i || 0, v: m.v });
      } else if (Number(P.markerBars)) {
        const songEnd = end;
        add(at(spec.loop ? spec.loop.start : 0), 5, { k: 'marker', i: 0, v: 1 });
        const phrase = Number(P.markerBars) * BAR;
        for (let b = phrase; b <= songEnd; b += phrase) {
          add(at(b - 2), 9, { k: 'marker', i: 0, v: 2 });
          if (b < songEnd) add(at(b), 5, { k: 'marker', i: 0, v: 1 });
        }
      }
    }
    items.sort((a, b) => a.s - b.s || a.ph - b.ph || a.q - b.q);

    /* what every setting should be, given what has happened so far */
    const lfoUsed = vib.depth > 0 || vib.tremolo > 0 || ['vibDepth', 'tremolo'].some((k) => (lanes[k] || []).some((p) => p.v > 0));
    const tune = spec.tune;
    function want(env) {
      const L = env.lane, n = env.note ? env.note.src : null, out = {};
      out.tempo = env.tempoWord;
      /* a part field that is null leaves that setting as the driver has it (a copy of a track that never sets it) */
      const bank = has(L, 'programBank') ? L.programBank : has(n, 'bank') ? n.bank : part.bank;
      out.bank = bank === null || bank === undefined ? undefined : bank & 15;
      const program = has(L, 'program') ? L.program : has(n, 'program') ? n.program : part.program;
      out.program = program === null || program === undefined ? undefined : program & 127;
      const volume = has(L, 'volume') ? L.volume : has(n, 'volume') ? n.volume : part.volume;
      out.volume = volume === null || volume === undefined ? undefined : clamp(Math.round(volume), 0, 127);
      let ex = has(L, 'expression') ? L.expression : has(n, 'expression') ? n.expression : part.expression;
      if (ex === null || ex === undefined) out.expression = undefined;
      else { ex *= env.duck * env.gate * (spec.level === undefined ? 1 : spec.level); out.expression = clamp(Math.round(ex), 0, 127); }
      let pan = has(L, 'pan') ? L.pan : has(n, 'pan') ? n.pan : part.pan;
      if (spec.pan === 'opposite' && pan !== null && pan !== undefined) pan = 127 - pan; else if (typeof spec.pan === 'number') pan = spec.pan;
      out.pan = pan === null || pan === undefined ? undefined : clamp(Math.round(pan), 0, 127);
      const cents = (has(L, 'pitch') ? L.pitch : 0) + (part.tune || 0) + (spec.cents || 0) + (n && has(n, 'cents') ? n.cents : 0) + (tune ? tune(out.bank, out.program) : 0);
      const units = 24 * ((has(L, 'detune') ? L.detune : 0) + env.bend) + 4 * ((has(L, 'fine') ? L.fine : 64) - 64) + Math.round(2.56 * cents);
      out.detune = clamp(Math.round(units / 24), -128, 127);
      out.fine = clamp(64 + Math.round((units - out.detune * 24) / 4), 0, 127);
      out.gain = clamp(Math.round(has(L, 'gain') ? L.gain : part.gain || 0), -64, 63);
      out.vibDepth = has(L, 'vibDepth') ? L.vibDepth : env.vibHeld ? 0 : vib.depth;
      out.vibRate = has(L, 'vibRate') ? L.vibRate : lfoUsed ? vib.rate : 0;
      out.vibSync = has(L, 'vibSync') ? (L.vibSync ? 1 : 0) : lfoUsed && vib.sync ? 1 : 0;
      out.tremolo = has(L, 'tremolo') ? L.tremolo : vib.tremolo;
      out.slide = has(L, 'slide') ? L.slide : n && has(n, 'slide') ? n.slide : 0;
      if (!spec.tempo) out.tempo = undefined;
      return out;
    }
    function duckFactor(t) {
      let f = 1;
      for (const d of duckAt) {
        let i = upper(d.times, t) - 1;
        for (; i >= 0; i--) {
          const x = t - d.times[i];
          if (x >= d.hold + d.release) break;
          f = Math.min(f, x < d.hold ? 1 - d.depth : 1 - d.depth + d.depth * (x - d.hold) / d.release);
        }
      }
      return f;
    }
    const gateFactor = (t) => (spec.gate ? 1 - spec.gate.depth * (1 - clamp(spec.gate.pattern[Math.floor(t / spec.gate.step) % spec.gate.pattern.length] || 0, 0, 1)) : 1);

    /* walk the items; `pass` decides the loop's starting state (see the header) */
    function walk(loopEntry) {
      const ev = [];
      let now = 0;
      const put = (s, e) => { e.d = s - now; now = s; ev.push(e); };
      const state = {}, lin = {};          /* lin: the first pass's values, never CARRY */
      for (const k of ORDER) state[k] = lin[k] = Object.prototype.hasOwnProperty.call(NEUTRAL, k) ? NEUTRAL[k] : UNKNOWN;
      const env = { lane: {}, note: null, bend: 0, vibHeld: false, duck: 1, gate: 1, tempoWord: tempoWord(P.bpm) };
      /* CARRY (no loopRestore): a later pass may enter with another value. A point writes its own setting;
       * anything else that wants what the first pass has keeps whatever the pass brought (the driver's own
       * behaviour). own: the settings this item sets (null: all of them) */
      const emit = (s, w, only, own) => {
        for (const k of ORDER) {
          if (only && !only.includes(k)) continue;
          if (w[k] === undefined) continue;
          if (state[k] === CARRY) { if (own && !own.includes(k) && w[k] === lin[k]) continue; }
          else if (w[k] === state[k]) continue;
          const c = command(k, w[k]);
          put(s, { k: 'cmd', op: c[0], a: c.slice(1) });
          state[k] = lin[k] = w[k];
        }
      };
      let loopIndex = -1, entryState = null, restoreTo = null, lastExpr = -Infinity;
      for (const it of items) {
        const s = it.s, t = s - lead - D;
        if (it.k === 'setup') {
          const e2 = Object.assign({}, env, { note: first, bend: first && first.bend.length && first.bend[0][0] === 0 ? first.bend[0][1] : 0,
                                              duck: duckFactor(first ? first.t : 0), gate: gateFactor(first ? first.t : 0) });
          const w = want(e2);
          if (it.only) emit(s, w, it.only.filter((k) => !laneSets.has(k)));
          else emit(s, w, ORDER.filter((k) => k !== 'tempo' && k !== 'bank' && !laneSets.has(k)));
          continue;
        }
        if (it.k === 'loopStart') {
          put(s, { k: 'cmd', op: 0xD0, a: [] });
          loopIndex = ev.length;
          entryState = Object.assign({}, state);
          if (P.loopRestore) {
            restoreTo = want(Object.assign({}, env, { note: null, bend: 0, vibHeld: false, duck: duckFactor(t), gate: gateFactor(t) }));
            for (const k of ORDER) if (restoreTo[k] !== undefined) state[k] = restoreTo[k];
          } else if (loopEntry) {
            for (const k of loopEntry) state[k] = CARRY;
          }
          continue;
        }
        if (it.k === 'loopEnd') { put(s, { k: 'cmd', op: 0xD4, a: [0] }); continue; }
        if (it.k === 'end') { put(s, { k: 'cmd', op: 0xFF, a: [] }); continue; }
        if (it.k === 'marker') { put(s, { k: 'cmd', op: 0xE8, a: [it.i & 0xFF, it.v & 0xFF] }); continue; }
        if (it.k === 'tempo') { env.tempoWord = tempoAt(it.t); emit(s, want(env), ['tempo']); continue; }
        if (it.k === 'raw') {
          put(s, { k: 'cmd', op: it.op, a: it.a });
          const st = settingOfRaw(it.op, it.a);
          if (st) state[st[0]] = lin[st[0]] = st[1];
          continue;
        }
        if (it.k === 'lane') {
          /* a program point with v null changes the bank only (C2 alone) */
          const hasBank = it.bank !== undefined && it.bank !== null, hasProg = it.v !== undefined && it.v !== null;
          if (it.lane === 'program') { if (hasProg) env.lane.program = it.v; if (hasBank) env.lane.programBank = it.bank; }
          else env.lane[it.lane] = it.v;
          env.duck = duckFactor(t); env.gate = gateFactor(t);
          /* a point writes its own setting only (the set-up and the notes write the rest where they are needed) */
          const own = it.lane === 'program' ? (hasProg ? ['program'] : []).concat(hasBank ? ['bank'] : []) : LANE_SETS[it.lane];
          emit(s, want(env), own, own);
          if (state.expression !== undefined) lastExpr = s;
          continue;
        }
        if (it.k === 'mod') {
          if (it.ramp && s - lastExpr < 2) continue;
          env.duck = duckFactor(t); env.gate = gateFactor(t);
          const w = want(env), before = state.expression;
          emit(s, w, ['expression']);
          if (state.expression !== before) lastExpr = s;
          continue;
        }
        if (it.k === 'note') {
          const note = it.note;
          env.note = note; env.bend = note.bend.length && note.bend[0][0] === 0 ? note.bend[0][1] : 0;
          env.vibHeld = vib.delay > 0 && vib.depth > 0;
          env.duck = duckFactor(t); env.gate = gateFactor(t);
          emit(s, want(env), null, []);
          put(s, { k: 'note', v: note.v, n: clamp(note.n + (spec.interval || 0), 0, 127), tie: note.tie, len: note.len });
          continue;
        }
        if (it.k === 'bend') { if (env.note === it.note) { env.bend = it.v; emit(s, want(env), ['detune', 'fine']); } continue; }
        if (it.k === 'vibOn') { if (env.note === it.note) { env.vibHeld = false; emit(s, want(env), ['vibDepth']); } continue; }
      }
      return { ev, loopIndex, entryState, restoreTo, endState: Object.assign({}, state) };
    }

    let r = walk(null);
    if (r.loopIndex >= 0 && P.loopRestore) {
      /* write back, straight after D0, every setting some pass would otherwise enter differently */
      const fix = [];
      for (const k of ORDER) {
        const v = r.restoreTo[k];
        if (v === undefined) continue;
        if (r.entryState[k] !== v || r.endState[k] !== v) fix.push(k);
      }
      if (fix.length) {
        const c = fix.map((k) => { const b = command(k, r.restoreTo[k]); return { d: 0, k: 'cmd', op: b[0], a: b.slice(1) }; });
        r.ev.splice(r.loopIndex, 0, ...c);
      }
    } else if (r.loopIndex >= 0) {
      /* no restore: settings a pass can enter differently are unknown at the loop start */
      let unsure = [];
      for (let guard = 0; guard < 4; guard++) {
        const add2 = ORDER.filter((k) => r.entryState[k] !== r.endState[k] && !unsure.includes(k));
        if (!add2.length) break;
        unsure = unsure.concat(add2);
        r = walk(unsure);
      }
    }
    return r.ev;
  }
  function upper(sorted, t) { let lo = 0, hi = sorted.length; while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] <= t) lo = m + 1; else hi = m; } return lo; }

  /* ---- tracks made before ---------------------------------------------------------------------
   * An edit changes one part, yet every build made all sixteen tracks again: in a 16-track, 208-bar song that was
   * most of the 35-45 ms an edit cost. makeTrack is a pure function of what trackKey() holds: the song
   * settings it reads (tempo, tempo changes, markers, loopRestore), the part as normalized JSON (its notes after the
   * note devices follow from the part, its end, the lead-in and the voice), the track's own values, the duck sources
   * and the tuning table. A track made from an identical key is reused: the same events, frozen so nothing can change
   * them, and the same warnings again. normalize() is a JSON copy, so JSON text is exact for the part; the track's own
   * values are written with String(), which keeps undefined, null and NaN apart. */
  const KEPT_TRACKS = 160, madeTracks = new Map(), catalogIds = new WeakMap();
  let catalogSerial = 0;
  function freezeDeep(x) {
    if (x && typeof x === 'object' && !Object.isFrozen(x)) { Object.freeze(x); for (const k of Object.keys(x)) freezeDeep(x[k]); }
    return x;
  }
  function trackKey(spec, song, partJson, item, duckJson, tuneId) {
    const loop = spec.loop ? spec.loop.start + ',' + spec.loop.end : '-';
    return [song, partJson, item.kind, item.v, String(spec.delay), String(spec.level), String(spec.pan), String(spec.interval), String(spec.cents),
      spec.tempo ? 1 : 0, spec.raw ? 1 : 0, loop, String(spec.end), String(spec.lead), String(spec.setupAt), duckJson, tuneId].join('\u0001');
  }
  function madeTrack(spec, warnings, key) {
    const kept = madeTracks.get(key);
    if (kept) { madeTracks.delete(key); madeTracks.set(key, kept); for (const w of kept.warnings) warnings.push(Object.assign({}, w)); return kept.events; }
    const before = warnings.length, events = freezeDeep(makeTrack(spec, warnings));
    madeTracks.set(key, { events, warnings: warnings.slice(before).map((w) => Object.assign({}, w)) });
    while (madeTracks.size > KEPT_TRACKS) madeTracks.delete(madeTracks.keys().next().value);
    return events;
  }

  /* ---- the whole song ------------------------------------------------------------------------ */
  function build(project, options) {
    const opts = Object.assign({ compress: false, includeMuted: false, catalog: null, range: null, bankBase: 0x067F2000 }, options || {});
    let P = normalize(project);
    if (opts.range) P = rangeProject(P, opts.range);
    if (P.loop.on && P.loop.end <= P.loop.start) throw new Error('The loop must end after it starts.');
    const lead = Math.max(0, Math.round(P.leadIn));
    const report = { tracks: [], partTracks: {}, dropped: 0, clipped: 0, bytes: 0, bytesPlain: 0, loops: 0, warnings: [] };
    const warn = (code, message, partId) => report.warnings.push({ code, message, partId: partId || null });
    let tune = null;
    if (P.autoTune) {
      /* only a sure measurement is corrected: unpitched and noisy sounds measure anything (catalog.js) */
      if (opts.catalog && opts.catalog.programs) tune = (b, p) => { const c = opts.catalog.programs[`${b}:${p}`]; return c && typeof c.tuningCents === 'number' && c.tuningConfidence >= AUTO_TUNE_SURE ? -c.tuningCents : 0; };
      else warn('autotune.nocatalog', 'Keep instruments in tune is on, but the instrument catalog is not loaded yet: the song was built without the corrections.');
    }

    /* parts -> voices */
    const plan = [], derived = [];
    const processed = new Map();
    P.parts.forEach((part) => processed.set(part.id, processNotes(part)));
    P.parts.forEach((part, pi) => {
      if (part.mute && !opts.includeMuted) return;
      const end = partEnd(P, part);
      const all = processed.get(part.id);
      const usable = all.filter((n) => n.t < end && n.len > 0 && n.t + lead >= 0);
      const lanesUsed = Object.keys(part.automation || {}).some((k) => (part.automation[k] || []).length) || (part.raw || []).length;
      const isTempo = P.tempoPart === part.id;
      if (!usable.length && !lanesUsed && !isTempo) return;
      const split = Seq.lanes(usable, Math.max(1, Math.round(part.voices || 1)));
      report.dropped += split.dropped;
      const voices = split.lanes.length ? split.lanes : [[]];
      const loop = P.loop.on ? { start: P.loop.start + (part.loopShift || 0), end: P.loop.end + (part.loopShift || 0) } : null;
      voices.forEach((notes, v) => {
        const vn = voiceNotes(notes, end, part, report);
        plan.push({ part, pi, v, notes: vn, loop, end, kind: 'voice', count: notes.length });
      });
    });
    /* devices that add tracks: after every part's own voices, in part order */
    for (const item of plan.slice()) {
      const part = item.part;
      for (const dv of part.devices) {
        if (!dv || dv.on === false) continue;
        if (dv.type === 'echo') {
          if (Array.isArray(dv.voices) && !dv.voices.includes(item.v)) continue;
          for (let r = 1; r <= Math.max(1, Math.round(dv.repeats || 1)); r++)
            derived.push(Object.assign({}, item, { kind: 'echo', delay: Math.round(dv.delay) * r, level: Math.pow(dv.level, r), pan: dv.pan, interval: dv.interval || 0, cents: 0 }));
        } else if (dv.type === 'double') {
          derived.push(Object.assign({}, item, { kind: 'double', delay: Math.round(dv.offset), level: dv.level, pan: dv.pan, interval: 0, cents: dv.detune || 0 }));
        } else if (dv.type === 'harmony') {
          derived.push(Object.assign({}, item, { kind: 'harmony', delay: 0, level: dv.level, pan: dv.pan, interval: Math.round(dv.interval), cents: 0 }));
        }
      }
    }
    derived.sort((a, b) => a.pi - b.pi);   /* stable: part order, then device order */

    /* tracks: pinned voices first, then the rest in order, then the device tracks */
    const slots = new Array(16).fill(null), all = plan.concat(derived), placed = [];
    for (const item of plan) {
      if (item.v !== 0 || !Number.isInteger(item.part.track)) continue;
      const k = item.part.track;
      if (k >= 0 && k < 16 && !slots[k]) { slots[k] = item; item.slot = k; }
      else warn('track.pin', `${item.part.name} asks for track ${k + 1}, which is taken; it was given the next free track.`, item.part.id);
    }
    const left = [];
    for (const item of all) {
      if (item.slot !== undefined) continue;
      const k = slots.indexOf(null);
      if (k < 0) { left.push(item); continue; }
      slots[k] = item; item.slot = k;
    }
    if (left.length) {
      const names = left.map((x) => (x.kind === 'voice' ? `${x.part.name} (voice ${x.v + 1})` : `the ${x.kind} on ${x.part.name}`));
      warn('tracks.over', `${all.length} tracks needed, the game has 16: ${names.join(', ')} ${left.length > 1 ? 'were' : 'was'} left out. Lower the voices or turn a device off.`, left[0].part.id);
    }
    for (const item of all) if (item.slot !== undefined) placed.push(item);
    if (!placed.length) throw new Error('Nothing to play yet: every part is empty or muted.');

    /* the tempo track: the tempo part's first voice, else the lowest track used */
    let tempoSlot = -1;
    if (P.tempoPart) { const it = placed.find((x) => x.part.id === P.tempoPart && x.kind === 'voice' && x.v === 0); if (it) tempoSlot = it.slot; }
    if (tempoSlot < 0) tempoSlot = slots.findIndex((x) => x);

    /* Duck sources: the source part's notes after its own swing/humanize */
    const duckFor = (part) => part.devices.filter((dv) => dv && dv.on !== false && dv.type === 'duck' && dv.source).map((dv) => {
      const src = processed.get(dv.source) || [];
      const keys = Array.isArray(dv.keys) && dv.keys.length ? new Set(dv.keys) : null;
      const times = Array.from(new Set(src.filter((n) => !keys || keys.has(n.n)).map((n) => n.t))).sort((a, b) => a - b);
      return { times, depth: clamp(dv.depth, 0, 1), hold: Math.max(0, Math.round(dv.hold)), release: Math.max(1, Math.round(dv.release)) };
    });
    const gateOf = (part) => { const dv = part.devices.find((x) => x && x.on !== false && x.type === 'gate'); return dv ? { pattern: dv.pattern, depth: clamp(dv.depth, 0, 1), step: Math.max(1, Math.round(dv.step)) } : null; };

    const tracks = new Array(16).fill(null), partJson = new Map(), jsonOf = (part) => { let j = partJson.get(part); if (j === undefined) partJson.set(part, j = JSON.stringify(part)); return j; };
    const songKey = JSON.stringify([P.bpm, P.tempoChanges, P.markers, P.markerBars, P.loopRestore]);
    let tuneId = '-';
    if (tune) { let id = catalogIds.get(opts.catalog); if (!id) catalogIds.set(opts.catalog, (id = ++catalogSerial)); tuneId = 'catalog ' + id; }
    for (const item of placed) {
      const part = item.part, k = item.slot;
      const spec = { P, part, notes: item.notes, lead, delay: item.delay || 0, level: item.level, pan: item.kind === 'voice' ? null : item.pan,
                     interval: item.interval || 0, cents: item.cents || 0, tempo: k === tempoSlot, raw: item.v === 0,
                     loop: item.loop, end: item.end, duck: duckFor(part), gate: gateOf(part), tune, setupAt: opts.range ? 0 : undefined };
      const ducks = part.devices.filter((dv) => dv && dv.on !== false && dv.type === 'duck' && dv.source).map((dv) => { const src = P.parts.find((q) => q.id === dv.source); return src ? jsonOf(src) : '-'; });
      tracks[k] = madeTrack(spec, report.warnings, trackKey(spec, songKey, jsonOf(part), item, JSON.stringify(ducks), tuneId));
      report.tracks.push({ track: k, partId: part.id, partIndex: item.pi, kind: item.kind, voice: item.v, notes: item.notes.length, bytes: 0, sharedWithEffects: k >= 12 });
      (report.partTracks[part.id] = report.partTracks[part.id] || []).push(k);
    }
    report.tracks.sort((a, b) => a.track - b.track);
    for (const id of Object.keys(report.partTracks)) report.partTracks[id].sort((a, b) => a - b);

    /* bytes: plain, then compressed (the chorus event of every track kept outside every loop) */
    const plainBytes = Seq.compile({ tracks });
    report.bytesPlain = plainBytes.length;
    let out = tracks, bytes = plainBytes;
    const chorus = chorusEvents(P, tracks, lead);
    if (opts.compress) {
      out = tracks.map((ev, k) => (ev ? Seq.compress(ev, { barriers: chorus[k] === undefined ? [] : [chorus[k]] }) : null));
      bytes = Seq.compile({ tracks: out });
      report.loops = out.reduce((n, ev) => n + (ev ? ev.filter((e) => e.k === 'cmd' && e.op >= 0xD1 && e.op <= 0xD3).length : 0), 0);
    }
    report.bytes = bytes.length;
    for (const t of report.tracks) {
      const ev = out[t.track], one = new Array(16).fill(null); one[0] = ev;
      t.bytes = Seq.compile({ tracks: one }).length - 33;
    }
    let bank = null;
    if (P.bank) {
      const Bank = g.SF3Bank || (typeof require === 'function' ? tryRequire('./bank.js') : null);
      if (Bank) bank = Bank.buildBlob(P.bank, opts.bankBase);
      else warn('bank.missing', 'This song has custom instruments, but the instrument builder is not loaded.');
    }
    const loop = P.loop.on ? { start: P.loop.start, end: P.loop.end } : null;
    return { bytes, tracks: out, plainTracks: tracks, loop, report, bank, chorus, lead };
  }
  function tryRequire(f) { try { return require(f); } catch (e) { return null; } }

  /* the index, in each track's events, of its first event at or after the chorus bar line */
  function chorusEvents(P, tracks, lead) {
    const out = new Array(16);
    if (!P.chorusBar) return out;
    const at = (P.chorusBar - 1) * BAR + lead;
    tracks.forEach((ev, k) => {
      if (!ev) return;
      let s = 0;
      for (let i = 0; i < ev.length; i++) { s += ev[i].d; if (s >= at) { out[k] = i; return; } }
    });
    return out;
  }

  /* Cycle playback: the stretch range.from..range.to as its own looping song. Notes that begin before
   * the range are left out; settings in force at range.from become the parts' own; every pass of the
   * loop starts from them. */
  function rangeProject(P, range) {
    const from = Math.max(0, Math.round(range.from)), to = Math.round(range.to);
    if (!(to > from)) throw new Error('The cycle must end after it starts.');
    const Q = clone(P);
    let bpm = P.bpm;
    for (const c of P.tempoChanges || []) if (c.t <= from) bpm = c.bpm;
    Q.bpm = bpm;
    Q.tempoChanges = (P.tempoChanges || []).filter((c) => c.t > from && c.t < to).map((c) => ({ t: c.t - from, bpm: c.bpm }));
    Q.loop = { on: true, start: 0, end: to - from, startBar: 1, endBar: Math.ceil((to - from) / BAR) };
    Q.length = null; Q.bars = Math.ceil((to - from) / BAR); Q.markers = null; Q.markerBars = 0; Q.loopRestore = true; Q.chorusBar = null;
    Q.parts = Q.parts.map((part) => {
      const p = Object.assign({}, part, { loopShift: 0, end: null });
      p.notes = part.notes.filter((n) => n.t >= from && n.t < to).map((n) => Object.assign({}, n, { t: n.t - from }));
      const auto = {};
      for (const name of Object.keys(part.automation || {})) {
        const pts = (part.automation[name] || []).slice().sort((a, b) => a.t - b.t);
        const before = pts.filter((x) => x.t < from || (x.t === from && !x.post)).pop();
        const inside = pts.filter((x) => x.t > from || (x.t === from && x.post)).filter((x) => x.t < to).map((x) => Object.assign({}, x, { t: x.t - from, pre: false }));
        auto[name] = (before ? [Object.assign({}, before, { t: -Math.max(0, Math.round(P.leadIn)), post: false, pre: false })] : []).concat(inside);
      }
      p.automation = auto;
      p.raw = (part.raw || []).filter((r) => r.t >= from && r.t < to && r.op !== 0xE8).map((r) => Object.assign({}, r, { t: r.t - from }));
      return p;
    });
    return Q;
  }

  /* ---- song file (04_FORMATS §2) ------------------------------------------------------------- */
  function base64(bytes) {
    if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  /* opts: { names, compress: true, catalog, prove(plainBytes, smallBytes, built) -> true when they sound the same }.
   * sequence_b64 is always the plain build (every ROM build that reads version-1 song files keeps working).
   * The compressed sequence is added only when `prove` says it sounds the same. */
  function songFile(project, opts) {
    opts = Object.assign({ names: null, compress: true, catalog: null, prove: null }, opts || {});
    const P = normalize(project);
    const plain = build(P, { compress: false, catalog: opts.catalog });
    const parts = new Map(P.parts.map((p) => [p.id, p]));
    const file = {
      format: 'sf3song', version: 2, name: P.name, bpm: P.bpm, bytes: plain.bytes.length, sequence_b64: base64(plain.bytes),
      loop_ticks: plain.loop ? [plain.loop.start, plain.loop.end] : null, marker_bars: Number(P.markerBars) || 0,
      tracks: plain.report.tracks.map((t) => { const p = parts.get(t.partId); return { track: t.track + 1, part: p.name, bank: p.bank, program: p.program, notes: t.notes, kind: t.kind }; }),
      names: opts.names || P.names || {}, project: P,
      chorus_bar: P.chorusBar || null, layers: {}, bank: P.bank || null,
      needs: ['song'], checks: { tracks: plain.report.tracks.length, issues: plain.report.warnings.map((w) => w.code) }, studio: '1.0' };
    for (const t of plain.report.tracks) { const p = parts.get(t.partId); if (p && p.layer) (file.layers[p.layer] = file.layers[p.layer] || []).push(t.track + 1); }
    if (P.chorusBar) file.needs.push('chorus-entry');
    if (P.bank) file.needs.push('instruments');
    if (opts.compress) {
      const small = build(P, { compress: true, catalog: opts.catalog });
      let proven = false;
      if (typeof opts.prove === 'function') proven = !!opts.prove(plain.bytes, small.bytes, small);
      file.checks.compressed_sound_identical = proven;
      if (proven) file.compressed = { sequence_b64: base64(small.bytes), bytes: small.bytes.length, chorus_safe: true };
    }
    return file;
  }

  /* ---- chorus entry (wp/A3 step 8; working model: the research project's music_chorus.py) --------------------
   * A small sequence that starts every track with the settings in force at project.chorusBar and jumps
   * into the song at that bar. songAt: where the song (plain, or compressed when `compressed`) sits;
   * entryAt: where the entry will sit. Per track: D0 (the song's closing D4 00 returns to it, so later
   * rounds loop chorus -> end -> chorus), the settings, a wait to the track's first event at or after
   * the bar line, and a CE jump onto that event's command byte (past its delta). */
  function chorusEntry(project, opts) {
    const P = normalize(project);
    if (!P.chorusBar) throw new Error('This song has no "rounds 2+ start at bar".');
    if (!P.loop.on) throw new Error('A chorus entry needs a looping song.');
    const built = build(P, { compress: !!opts.compressed, catalog: opts.catalog });
    const lead = built.lead, at = (P.chorusBar - 1) * BAR + lead;
    if (!(at > P.loop.start + lead && at < P.loop.end + lead)) throw new Error('The chorus bar must lie inside the loop, after its start.');
    const song = built.bytes, offs = [];
    for (let k = 0; k < 16; k++) offs.push((song[1 + 2 * k] << 8) | song[2 + 2 * k]);
    /* the state in force at the bar line, per track, from the plain events (the compressed track plays the same) */
    const head = new Array(33).fill(0), body = [];
    const jumps = [];
    built.plainTracks.forEach((ev, k) => {
      if (!ev) return;
      const state = {}, order = [];
      let s = 0, target = -1;
      for (let i = 0; i < ev.length; i++) {
        s += ev[i].d;
        if (s >= at) { target = i; break; }
        const e = ev[i];
        if (e.k === 'cmd' && (OP_SETTING[e.op] || e.op === 0xC1)) { if (!(e.op in state)) order.push(e.op); state[e.op] = e.a; }
        if (e.k === 'cmd' && e.op === 0xFF) break;
      }
      if (target < 0) return;                                 /* the track has nothing at or after the chorus */
      let tickT = 0;
      for (let i = 0; i <= target; i++) tickT += ev[i].d;
      /* where that event sits in the song as built (compressed: found through `src`, and it must be at top level) */
      const cev = built.tracks[k];
      let ci = target;
      if (opts.compressed) {
        ci = cev.findIndex((e) => e.src === target);
        if (ci < 0) throw new Error(`track ${k + 1}: the chorus event was not kept outside the loops`);
        let depth = 0;
        for (let i = 0; i < ci; i++) { const e = cev[i]; if (e.k === 'cmd' && e.op >= 0xD1 && e.op <= 0xD3) depth++; else if (e.k === 'cmd' && e.op >= 0xD5 && e.op <= 0xD7) depth--; }
        if (depth !== 0) throw new Error(`track ${k + 1}: the chorus event lies inside a counted loop`);
      }
      let pos = offs[k];
      for (let i = 0; i < ci; i++) pos += Seq.deltaSize(cev[i].d) + eventBytes(cev[i]);
      const status = pos + Seq.deltaSize(cev[ci].d);
      const start = 33 + body.length;
      head[1 + 2 * k] = start >> 8; head[2 + 2 * k] = start & 0xFF;
      body.push(0xD0);
      const want = [0xC1, 0xC2, 0xC4, 0xC6, 0xC8, 0xC7, 0xC3, 0xE7, 0xDE, 0xE0, 0xE1, 0xC5, 0xE2, 0xC9];
      for (const op of want) if (op in state) body.push(op, ...state[op]);
      const wait = tickT - at, dd = [];
      let w = wait; while (w > 0) { dd.unshift(w % 128); w = Math.floor(w / 128); }
      body.push(...dd, 0xCE, 0, 0);
      jumps.push({ k, operand: 33 + body.length - 2, target: status });
    });
    const bytes = Uint8Array.from(head.concat(body));
    for (const j of jumps) {
      const after = opts.entryAt + j.operand + 2, off = opts.songAt + j.target - after;
      if (off < -0x8000 || off > 0x7FFF) throw new Error(`track ${j.k + 1}: the song is out of reach of the chorus entry (${off} bytes); place the entry within 32 KB of the song`);
      bytes[j.operand] = (off >> 8) & 0xFF; bytes[j.operand + 1] = off & 0xFF;
    }
    return bytes;
  }
  function eventBytes(e) { return e.k === 'note' ? 2 + (e.len < 0x80 ? 1 : e.len < 0x4000 ? 2 : e.len < 0x200000 ? 3 : 4) : e.k === 'jump' ? 3 : 1 + e.a.length; }

  const api = { normalize, upgrade, build, songFile, chorusEntry, rangeProject, processNotes, LANES, DEVICE_DEFAULTS, VIBRATO, NEUTRAL, AUTO_TUNE_SURE };
  g.SF3Compile = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
