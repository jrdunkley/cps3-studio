/* The game's music sequence format: read, write, follow, and build from a project.
 * Format facts are from the driver's interpreter (0613AC14) and are checked by
 * the research project's sound_sequence_evidence.py; checks/seq_test.js requires that every piece of
 * music in the ROM converts to events and back to identical bytes.
 *
 * Sequence: byte 0 = 0 for music, 16 big-endian u16 track offsets (0 = unused), then the tracks.
 * Track: [delta][event]... Delta: base-128 digits (bytes < 0x80), none for 0. 48 ticks per beat.
 *   0x80..0xBF  note: velocity = status & 0x3F (the driver doubles it), note byte (bit 7 = tie: no
 *               key-off when the length runs out), then a MIDI-style variable length (ticks).
 *   0xC1 hh ll  tempo = ticks per frame * 256        0xC2 bank      0xC4 program
 *   0xC6 volume    0xC7 pan    0xC8 expression       0xC3 detune (24/256 semitone each)   0xE7 bend
 *   0xD0..D3 loop start    0xD4..D7 n loop end (n more passes; 0 = forever)
 *   0xD8..DB hh ll: on the last pass jump forward (unsigned offset)   0xCE hh ll: signed jump
 *   0xDC n / 0xDD n set / add transpose (semitones)    0xE8 i v: write v to game byte 02079C5C+i
 *   0xFF end of track.
 */
(function (g) {
  'use strict';
  const PARAMS = { 0xC0: 0, 0xC1: 2, 0xC2: 1, 0xC3: 1, 0xC4: 1, 0xC5: 1, 0xC6: 1, 0xC7: 1, 0xC8: 1, 0xC9: 1, 0xDC: 1, 0xDD: 1,
                   0xDE: 1, 0xDF: 1, 0xE0: 1, 0xE1: 1, 0xE2: 1, 0xE3: 1, 0xE4: 2, 0xE5: 2, 0xE6: 1, 0xE7: 1, 0xE8: 2 };
  const TICKS_PER_BEAT = 48, FRAME_RATE = 59.59949;
  const paramCount = (op) => {
    if (op in PARAMS) return PARAMS[op];
    if (op === 0xCC || op === 0xCD || op === 0xCE || (op >= 0xD8 && op <= 0xDB)) return 2;
    if (op === 0xCF || (op >= 0xD4 && op <= 0xD7)) return 1;
    return 0;
  };
  const isJump = (op) => op === 0xCC || op === 0xCD || op === 0xCE || (op >= 0xD8 && op <= 0xDB);

  const tempoToBpm = (tempo) => tempo / 256 * FRAME_RATE / TICKS_PER_BEAT * 60;
  const bpmToTempo = (bpm) => Math.max(1, Math.min(0xFFFF, Math.round(bpm * TICKS_PER_BEAT * 256 / 60 / FRAME_RATE)));

  function readDelta(b, p) { let v = 0; while (!(b[p] & 0x80)) v = v * 128 + b[p++]; return [v, p]; }
  function readLength(b, p) {
    let c = b[p++];
    if (!(c & 0x80)) return [c, p];
    let v = c & 0x7F;
    for (;;) { c = b[p++]; v = v * 128 + (c & 0x7F); if (!(c & 0x80)) return [v, p]; }
  }
  function pushDelta(out, v) {
    const digits = [];
    while (v > 0) { digits.unshift(v % 128); v = Math.floor(v / 128); }
    for (const d of digits) out.push(d);
  }
  function pushLength(out, v) {
    const digits = [v % 128];
    v = Math.floor(v / 128);
    while (v > 0) { digits.unshift((v % 128) | 0x80); v = Math.floor(v / 128); }
    for (const d of digits) out.push(d);
  }

  /* bytes: one whole music sequence (header and tracks). Returns { tracks: [events | null] x 16 }.
   * Events: { d, k:'note', v, n, tie, len } | { d, k:'cmd', op, a:[..] } | { d, k:'jump', op, to }
   * where `to` is the index of the event the jump lands on (events.length = end of the track). */
  function decompile(bytes) {
    if (bytes[0] !== 0) throw new Error('not a music sequence');
    const offs = [];
    for (let k = 0; k < 16; k++) offs.push((bytes[1 + 2 * k] << 8) | bytes[2 + 2 * k]);
    const starts = offs.filter((o) => o).sort((a, b) => a - b);
    const tracks = [];
    for (let k = 0; k < 16; k++) {
      if (!offs[k]) { tracks.push(null); continue; }
      const end = starts[starts.indexOf(offs[k]) + 1] || bytes.length;
      const events = [], at = new Map(), pending = [];
      let p = offs[k];
      while (p < end) {
        at.set(p, events.length);
        let d; [d, p] = readDelta(bytes, p);
        const op = bytes[p++];
        if (op < 0xC0) {
          const nb = bytes[p++];
          let len; [len, p] = readLength(bytes, p);
          events.push({ d, k: 'note', v: op & 0x3F, n: nb & 0x7F, tie: nb >> 7, len });
        } else if (isJump(op)) {
          const hi = bytes[p], lo = bytes[p + 1];
          const off = (op >= 0xD8) ? (hi << 8) + lo : op === 0xCE ? (((hi << 24) >> 16) | lo) : ((hi << 24) >> 16) + lo;
          p += 2;
          const e = { d, k: 'jump', op, to: -1 };
          pending.push([e, p + off]);              // every jump is relative to the byte after its operands
          events.push(e);
        } else {
          const n = paramCount(op);
          events.push({ d, k: 'cmd', op, a: Array.from(bytes.slice(p, p + n)) });
          p += n;
        }
      }
      if (p !== end) throw new Error(`track ${k} does not end on an event`);
      at.set(end, events.length);
      for (const [e, target] of pending) {
        if (!at.has(target)) throw new Error(`track ${k}: a jump lands inside an event`);
        e.to = at.get(target);
      }
      tracks.push(events);
    }
    return { tracks };
  }

  function eventSize(e) {
    const tmp = [];
    pushDelta(tmp, e.d);
    if (e.k === 'note') { tmp.push(0, 0); pushLength(tmp, e.len); }
    else if (e.k === 'jump') tmp.push(0, 0, 0);
    else { tmp.push(0); for (let i = 0; i < e.a.length; i++) tmp.push(0); }
    return tmp.length;
  }

  /* A frozen track (compile.js keeps the tracks it has made, frozen) cannot change, so its bytes are kept with it. */
  const compiledTracks = new WeakMap();
  function compileTrack(events) {
    if (Object.isFrozen(events)) { let bytes = compiledTracks.get(events); if (!bytes) compiledTracks.set(events, (bytes = Object.freeze(compileEvents(events)))); return bytes; }
    return compileEvents(events);
  }
  function compileEvents(events) {
    const pos = [0];
    for (const e of events) pos.push(pos[pos.length - 1] + eventSize(e));
    const out = [];
    events.forEach((e, i) => {
      pushDelta(out, e.d);
      if (e.k === 'note') {
        out.push(0x80 | (e.v & 0x3F), (e.n & 0x7F) | (e.tie ? 0x80 : 0));
        pushLength(out, e.len);
      } else if (e.k === 'jump') {
        const off = pos[e.to] - pos[i + 1];
        if (e.op >= 0xD8 && (off < 0 || off > 0xFFFF)) throw new Error('loop exit must jump forward');
        if (off < -0x8000 || off > 0xFFFF) throw new Error('jump too far');
        out.push(e.op, (off >> 8) & 0xFF, off & 0xFF);
      } else {
        if (e.a.length !== paramCount(e.op)) throw new Error(`command ${e.op.toString(16)} needs ${paramCount(e.op)} values`);
        out.push(e.op, ...e.a);
      }
    });
    return out;
  }

  function compile(song) {
    const header = new Array(33).fill(0), body = [];
    song.tracks.forEach((events, k) => {
      if (!events) return;
      const at = 33 + body.length;
      if (at > 0xFFFF) throw new Error('sequence too long');
      header[1 + 2 * k] = at >> 8; header[2 + 2 * k] = at & 0xFF;
      for (const b of compileTrack(events)) body.push(b);
    });
    return Uint8Array.from(header.concat(body));
  }

  /* Follow one track as the driver does and list what happens with absolute ticks.
   * Stops at the end of the track, when a state repeats (returns loop start/length), or at maxTicks.
   * With unroll the loop is reported once and playing continues up to maxTicks. */
  function follow(events, maxTicks, unroll) {
    const counters = [0, 0, 0, 0], loopStart = [0, 0, 0, 0], seen = new Map();
    const out = { notes: [], controls: [], loop: null, end: null };
    let i = 0, tick = 0;
    maxTicks = maxTicks || 400000;
    while (i < events.length && tick <= maxTicks) {
      tick += events[i].d;
      if (tick > maxTicks) break;
      const key = i + ':' + counters.join(',');
      if (!out.loop && seen.has(key)) {
        out.loop = { start: seen.get(key), length: tick - seen.get(key) };
        if (!unroll) return out;
      }
      if (!out.loop) seen.set(key, tick);
      const e = events[i];
      if (e.k === 'note') { out.notes.push({ t: tick, n: e.n, v: e.v, len: e.len, tie: e.tie }); i++; continue; }
      const op = e.op;
      if (e.k === 'jump') {
        if (op >= 0xD8) { const c = op - 0xD8; if (counters[c] === 1) { counters[c] = 0; i = e.to; } else i++; }
        else if (op === 0xCE) i = e.to;
        else i++;                                   // CC / CD (not used by the game's music)
        continue;
      }
      if (op >= 0xD0 && op <= 0xD3) { loopStart[op - 0xD0] = i + 1; i++; continue; }
      if (op >= 0xD4 && op <= 0xD7) {
        const c = op - 0xD4;
        if (counters[c]) { counters[c]--; i = counters[c] ? loopStart[c] : i + 1; }
        else { counters[c] = e.a[0]; i = loopStart[c]; }
        continue;
      }
      if (op === 0xFF) { out.end = tick; return out; }
      out.controls.push({ t: tick, op, a: e.a });
      i++;
    }
    if (i >= events.length) out.end = tick;
    return out;
  }

  /* ---- building a sequence from an editor project ---------------------------------------------
   * project: { bpm, tempoChanges:[{t, bpm}], lengthTicks, loop: { start, end } | null, markerBars: 0|2|4,
   *            parts: [{ bank, program, volume, pan, expression, transpose, voices, mute, notes:[{t, n, v, len}] }] }
   * Ticks are from the first beat (48 per beat); the sequence adds the 2-tick lead-in the game's songs use.
   */
  const LEAD_IN = 2, BAR = 4 * TICKS_PER_BEAT;

  /* Split a part's notes into single-note lanes (the driver plays one note per track). */
  function lanes(notes, maxVoices) {
    const sorted = notes.slice().sort((a, b) => a.t - b.t || b.n - a.n);
    const out = [];
    let dropped = 0;
    for (const note of sorted) {
      let lane = out.find((l) => l.end <= note.t);
      if (!lane) {
        if (out.length < maxVoices) { lane = { end: 0, notes: [] }; out.push(lane); }
        else {                                       // steal the lane that finishes soonest
          lane = out.reduce((a, b) => (a.end <= b.end ? a : b));
          const last = lane.notes[lane.notes.length - 1];
          if (last.t >= note.t) { dropped++; continue; }
          last.len = note.t - last.t;
        }
      }
      const copy = Object.assign({}, note);
      lane.notes.push(copy);
      lane.end = note.t + note.len;
    }
    return { lanes: out.map((l) => l.notes), dropped };
  }

  function buildTracks(project) {
    const report = { tracks: [], dropped: 0, clipped: 0, warnings: [] };
    const loop = project.loop, songEnd = loop ? loop.end : project.lengthTicks;
    const plan = [];
    for (const part of project.parts) {
      if (part.mute || !part.notes.length) continue;
      const usable = part.notes.filter((n) => n.t < songEnd && n.len > 0);
      const split = lanes(usable, Math.max(1, part.voices || 1));
      report.dropped += split.dropped;
      split.lanes.forEach((notes, i) => plan.push({ part, notes, lane: i }));
    }
    if (plan.length > 16) {
      report.warnings.push(`The song needs ${plan.length} tracks; the game has 16. The last ${plan.length - 16} were left out.`);
      plan.length = 16;
    }
    if (!plan.length) throw new Error('Nothing to play yet: every part is empty or muted.');
    const tracks = new Array(16).fill(null);
    plan.forEach((item, k) => {
      const part = item.part, ev = [];
      let now = 0;                                     // tick of the last emitted event (sequence time)
      const at = (tick, e) => { e.d = tick - now; now = tick; ev.push(e); };
      const cmd = (tick, op, ...a) => at(tick, { k: 'cmd', op, a });
      if (k === 0) { const t = bpmToTempo(project.bpm); cmd(0, 0xC1, t >> 8, t & 0xFF); }
      /* a note may carry its own bank, program, volume, expression or pan (music copied from the game
       * changes these as it goes); the track's settings are restored at the top of every loop pass */
      const FIELDS = [['bank', 0xC2, 0x0F], ['program', 0xC4, 0x7F], ['volume', 0xC6, 0x7F], ['expression', 0xC8, 0x7F], ['pan', 0xC7, 0x7F]];
      const defaults = {}, state = {};
      for (const [name, , mask] of FIELDS) defaults[name] = state[name] = part[name] & mask;
      const overrides = item.notes.some((n) => FIELDS.some(([name]) => n[name] !== undefined));
      /* a note may bend: bend = [[ticks after its start, detune], ...], detune in units of 24/256
       * semitone (command C3, -128..127). The driver keeps a detune for the following notes, so a
       * note starts from its own first value at 0 ticks, or from 0. */
      const bends = item.notes.some((n) => n.bend && n.bend.length);
      let detune = 0;
      cmd(0, 0xC2, defaults.bank);
      cmd(1, 0xC4, defaults.program);
      cmd(1, 0xC6, defaults.volume);
      cmd(1, 0xC8, defaults.expression);
      cmd(1, 0xC7, defaults.pan);
      if (bends) cmd(1, 0xC3, 0);
      /* everything on the timeline, in order: loop start, markers and tempo (track 0), notes, loop end */
      const timeline = [];
      if (loop) timeline.push({ t: loop.start, order: 0, make: (t) => {
        cmd(t, 0xD0);
        if (overrides) for (const [name, op] of FIELDS) { cmd(t, op, defaults[name]); state[name] = defaults[name]; }
        if (bends) { cmd(t, 0xC3, 0); detune = 0; }
      } });
      if (k === 0) {
        timeline.push({ t: loop ? loop.start : 0, order: 1, make: (t) => cmd(t, 0xE8, 0, 1) });
        if (project.markerBars) {
          const phrase = project.markerBars * BAR;
          for (let b = phrase; b <= songEnd; b += phrase) {
            timeline.push({ t: b - 2, order: 3, make: (t) => cmd(t, 0xE8, 0, 2) });
            if (b < songEnd) timeline.push({ t: b, order: 1, make: (t) => cmd(t, 0xE8, 0, 1) });
          }
        }
        for (const change of project.tempoChanges || []) {
          if (change.t > 0 && change.t < songEnd) {
            const t = bpmToTempo(change.bpm);
            timeline.push({ t: change.t, order: 1, make: (tick) => cmd(tick, 0xC1, t >> 8, t & 0xFF) });
          }
        }
        /* with tempo changes, each pass of the loop starts at the tempo in force where the loop begins */
        const changes = (project.tempoChanges || []).filter((c) => c.t > 0 && c.t < songEnd);
        if (loop && changes.length) {
          const before = changes.filter((c) => c.t <= loop.start).pop();
          const t = bpmToTempo(before ? before.bpm : project.bpm);
          timeline.push({ t: loop.start, order: 0.5, make: (tick) => cmd(tick, 0xC1, t >> 8, t & 0xFF) });
        }
      }
      item.notes.forEach((note, i) => {
        const next = item.notes[i + 1];
        let len = note.len;
        if (next && note.t + len > next.t) len = next.t - note.t;
        if (note.t + len > songEnd) { len = songEnd - note.t; report.clipped++; }
        const n = note.n + (part.transpose || 0);
        if (n < 0 || n > 127 || len <= 0) { report.dropped++; return; }
        const v = Math.max(1, Math.min(63, Math.round(note.v / 2)));
        const bend = (note.bend || []).filter(([dt]) => dt >= 0 && dt < (next ? next.t - note.t : songEnd - note.t));
        const first = bend.length && bend[0][0] === 0 ? bend[0][1] : 0;
        timeline.push({ t: note.t, order: 2, make: (t) => {
          for (const [name, op, mask] of FIELDS) {
            const want = note[name] === undefined ? defaults[name] : note[name] & mask;
            if (want !== state[name]) { cmd(t, op, want); state[name] = want; }
          }
          if (bends && detune !== first) { cmd(t, 0xC3, first & 0xFF); detune = first; }
          at(t, { k: 'note', v, n, tie: 0, len });
        } });
        for (const [dt, value] of bend) {
          if (dt === 0) continue;
          timeline.push({ t: note.t + dt, order: 2.5, make: (t) => { if (value !== detune) { cmd(t, 0xC3, value & 0xFF); detune = value; } } });
        }
      });
      timeline.sort((a, b) => a.t - b.t || a.order - b.order);
      for (const item2 of timeline) item2.make(item2.t + LEAD_IN);
      if (loop) cmd(loop.end + LEAD_IN, 0xD4, 0); else cmd(songEnd + LEAD_IN, 0xFF);
      tracks[k] = ev;
      report.tracks.push({ track: k, part, lane: item.lane, notes: item.notes.length, sharedWithEffects: k >= 12 });
    });
    return { tracks, report };
  }

  /* ==== Studio additions (docs/plan/wp/A2_sequence.md; gate checks/gates/g_compress.js) ===========
   * COMMANDS (every command, named and explained), check (the twin of check_sequence.py),
   * listing (readable text), unroll (inner loops written out) and compress (repeats written as driver
   * loops, as Capcom did). Nothing above this line changes. */
  const COMMANDS = (() => {
    const t = {};
    const add = (op, name, text) => { t[op] = { name, params: paramCount(op), text }; };
    for (let op = 0xC0; op <= 0xFF; op++) add(op, 'nothing', 'Ignored by the driver.');
    add(0xC1, 'tempo', 'Tempo word: ticks per frame x 256.');
    add(0xC2, 'bank', 'Instrument bank (value & 15) for the next notes.');
    add(0xC3, 'detune', 'Detune in signed steps of 24/256 semitone; acts at once.');
    add(0xC4, 'program', 'Instrument used by the next note-on.');
    add(0xC5, 'vibrato depth', 'Vibrato depth (index into the driver\'s depth table).');
    add(0xC6, 'volume', 'Volume 0..127; acts at once on a sounding note.');
    add(0xC7, 'pan', 'Pan 0..127; acts at once (heard only with the stereo switch on).');
    add(0xC8, 'expression', 'Expression 0..127; acts at once; 0 is silence.');
    add(0xC9, 'portamento', 'Glide from the previous note at (value + 1) x 2 units a frame; 0 = off.');
    add(0xCA, 'first-pass control', 'First-pass control (not used by the game\'s music; never written by the Studio).');
    add(0xCB, 'later-pass control', 'Later-pass control (not used by the game\'s music; never written by the Studio).');
    add(0xCC, 'first-pass jump', 'First-pass jump (not used by the game\'s music; never written by the Studio).');
    add(0xCD, 'later-pass jump', 'Later-pass jump (not used by the game\'s music; never written by the Studio).');
    add(0xCE, 'jump', 'Signed relative jump.');
    add(0xCF, 'continue at track', 'Continue at the start of another track.');
    for (let l = 0; l < 4; l++) {
      add(0xD0 + l, `loop start ${l}`, `Start of a loop on level ${l}${l ? '' : ' (the main loop)'}.`);
      add(0xD4 + l, `loop end ${l}`, `End of the level-${l} loop: the body plays (value + 1) times; 0 = forever.`);
      add(0xD8 + l, `last-pass exit ${l}`, `On the last pass of the level-${l} loop, jump forward past its end.`);
    }
    add(0xDC, 'set transpose', 'Transpose in semitones for the next note-ons.');
    add(0xDD, 'add transpose', 'Adds semitones to the transpose for the next note-ons.');
    add(0xDE, 'set gain', 'Channel gain: level x (64 + value) / 64; 0 = unity, -64 = silence.');
    add(0xDF, 'add gain', 'Adds to the channel gain.');
    add(0xE0, 'LFO key sync', 'Not 0: the vibrato and tremolo restart at each note-on.');
    add(0xE1, 'LFO rate', 'Vibrato and tremolo speed (index into the rate table); 0 = off.');
    add(0xE2, 'tremolo', 'Tremolo depth (index into the depth table).');
    add(0xE3, 'ignore music level', 'Not 0: this channel ignores the game\'s music level.');
    add(0xE7, 'fine pitch', 'Fine pitch: (value - 64) x 4 units (1.56 cents each); 64 = none.');
    add(0xE8, 'game byte', 'Writes a value to the game byte 02079C5C + index (index 0: phrase markers).');
    add(0xFF, 'end', 'End of track; silences the voice at once unless its instrument rings out.');
    /* Names in the decompiled driver (gibletto sfIII3-cps3-decomp d4408370, byte-exact; names only, no code): the
     * event name, the voice field its handler in voice_process_primary sets, and what the source adds to the
     * measured meaning above. Codes the handler has no case for are marked as read by no routine. */
    const SOURCE = {
      0xC0: ['SEQ_NOP', null], 0xC1: ['SEQ_TEMPO', 'bgm_ticks'], 0xC2: ['SEQ_BANK', 'instrument_bank'], 0xC3: ['SEQ_BEND', 'coarse_pitch_bend'],
      0xC4: ['SEQ_PROG', 'program_index'], 0xC5: ['SEQ_PLFO', 'pitch_lfo_depth'], 0xC6: ['SEQ_VOL', 'volume'],
      0xC7: ['SEQ_PAN', 'pan_override', 'Used only when the instrument patch has no pan of its own (patch pan 0xFF).'],
      0xC8: ['SEQ_EXPR', 'expression'], 0xC9: ['SEQ_PORTA', 'portamento_step'],
      0xCA: ['SEQ_REPEAT', 'loop_latch', 'First pass only: go back to the start of the track and mark the repeat.'],
      0xCB: ['SEQ_END_REPEAT', 'status', 'On the repeat pass the track ends here.'],
      0xCC: ['SEQ_JUMP1', 'loop_latch', 'First pass only: jump (offset counted from the operand) and mark the repeat.'],
      0xCD: ['SEQ_JUMP2', 'loop_latch', 'Repeat pass only: jump by the signed offset.'],
      0xCE: ['SEQ_JUMP', null], 0xCF: ['SEQ_JUMP_TRACK', 'origin'],
      0xDC: ['SEQ_KEY', 'transpose'], 0xDD: ['SEQ_KEY_ADD', 'transpose'],
      0xDE: ['SEQ_TUNE', 'volume_offset', 'The source names it a tune; its handler sets the level offset: level x ((64 + value) & 127) / 64, so values outside -64..63 wrap.'],
      0xDF: ['SEQ_TUNE_ADD', 'volume_offset', 'Adds to the same level offset; the sum wraps the same way.'],
      0xE0: ['SEQ_LFO_SYNC', 'status'], 0xE1: ['SEQ_LFO_RATE', 'lfo_rate'], 0xE2: ['SEQ_VLFO', 'volume_lfo_depth'],
      0xE3: ['SEQ_PRIO', 'priority_flags', 'Not 0: the channel skips the music master level and, in stereo, the master fade.'],
      0xE4: ['SEQ_E4', null, 'Read past (2 bytes).'], 0xE5: ['SEQ_E5', null, 'Read past (2 bytes).'], 0xE6: ['SEQ_E6', null, 'Read past (1 byte).'],
      0xE7: ['SEQ_FINE', 'fine_pitch_control'], 0xE8: ['SEQ_STATUS', 'gSeqStatus'], 0xFF: ['SEQ_END', 'status'],
    };
    for (let l = 0; l < 4; l++) { SOURCE[0xD0 + l] = [`SEQ_LOOP_START+${l}`, 'loop_cursor']; SOURCE[0xD4 + l] = [`SEQ_LOOP+${l}`, 'loop_count']; SOURCE[0xD8 + l] = [`SEQ_LOOP_EXIT+${l}`, 'loop_count']; }
    for (let op = 0xC0; op <= 0xFF; op++) {
      const s = SOURCE[op];
      t[op].source = s ? { name: s[0], field: s[1], note: s[2] || '' } : { name: null, field: null, note: 'No routine reads this: the driver has no case for it and moves on.' };
    }
    return t;
  })();

  /* The same linear reading as check_sequence.py (Python): throws on anything the driver
   * would misread; returns the number of events. */
  function check(bytes) {
    if (!bytes || bytes[0] !== 0) throw new Error('not a music sequence');
    const offsets = [];
    for (let k = 0; k < 16; k++) offsets.push((bytes[1 + 2 * k] << 8) | bytes[2 + 2 * k]);
    const starts = offsets.filter((o) => o).sort((a, b) => a - b);
    if (!(starts.length && starts[0] === 0x21 && new Set(starts).size === starts.length)) throw new Error('track offsets');
    let events = 0;
    const at = (p) => { if (p >= bytes.length) throw new Error('a track runs past the end of the sequence'); return bytes[p]; };
    starts.forEach((start, i) => {
      const end = i + 1 < starts.length ? starts[i + 1] : bytes.length;
      let p = start;
      const marks = new Set(), jumps = [];
      while (p < end) {
        marks.add(p);
        while (!(at(p) & 0x80)) p++;
        const op = bytes[p++];
        if (op < 0xC0) { p++; while (at(p) & 0x80) p++; p++; }
        else {
          if (op >= 0xD8 && op <= 0xDB) jumps.push(p + 2 + (at(p) << 8) + at(p + 1));
          p += paramCount(op);
        }
        events++;
      }
      if (p !== end) throw new Error(`track at 0x${start.toString(16)} does not end on an event`);
      marks.add(end);
      if (!jumps.every((j) => marks.has(j))) throw new Error('a loop exit lands inside an event');
    });
    return events;
  }

  /* ---- sizes and identity of events ---------------------------------------------------------- */
  const deltaSize = (d) => (d <= 0 ? 0 : d < 0x80 ? 1 : d < 0x4000 ? 2 : d < 0x200000 ? 3 : 4);
  const lengthSize = (v) => (v < 0x80 ? 1 : v < 0x4000 ? 2 : v < 0x200000 ? 3 : 4);
  const bodySize = (e) => (e.k === 'note' ? 2 + lengthSize(e.len) : e.k === 'jump' ? 3 : 1 + e.a.length);
  const eventKey = (e) => (e.k === 'note' ? `n${e.v & 63},${e.n & 127},${e.tie ? 1 : 0},${e.len}` : e.k === 'cmd' ? `c${e.op},${e.a.join(',')}` : `j${e.op},${e.to}`);
  const isStart = (e) => e.k === 'cmd' && e.op >= 0xD0 && e.op <= 0xD3;
  const isEnd = (e) => e.k === 'cmd' && e.op >= 0xD4 && e.op <= 0xD7;
  const isExit = (e) => e.k === 'jump' && e.op >= 0xD8 && e.op <= 0xDB;
  const copyEvent = (e, d) => { const c = Object.assign({}, e); if (d !== undefined) c.d = d; if (e.a) c.a = e.a.slice(); delete c.src; return c; };

  /* ---- unroll: every loop that ends written out ------------------------------------------------
   * Kept as they are: loops that never end (count 0 on any level, or the main loop's long count D4 n
   * with n >= 100: 127 passes last a quarter of an hour or more; music 12, 15, 19, 45) and loop starts
   * that no end closes. Everything else is played through as the driver does (Seq.follow's rules) and
   * written out, the dropped loop commands' waits carried to the next event, so the notes and commands
   * land on the same ticks. */
  function keptLoops(events) {
    const open = [[], [], [], []], kept = new Set();
    events.forEach((e, i) => {
      if (isStart(e)) open[e.op - 0xD0].push(i);
      else if (isEnd(e)) {
        const lv = e.op - 0xD4, s = open[lv].pop();
        if (e.a[0] === 0 || (lv === 0 && e.a[0] >= 100)) { kept.add(i); if (s !== undefined) kept.add(s); }
      }
    });
    for (const st of open) for (const s of st) kept.add(s);
    return kept;
  }
  function unroll(events, maxTicks) {
    maxTicks = maxTicks || 2000000;
    const kept = keptLoops(events);
    const out = [], counters = [0, 0, 0, 0], loopStart = [0, 0, 0, 0], keptOpen = [false, false, false, false];
    let i = 0, carry = 0, tick = 0, expanded = 0;
    while (i < events.length) {
      const e = events[i];
      tick += e.d;
      if (tick > maxTicks) throw new Error('unroll: the track runs past maxTicks');
      if (kept.has(i)) {
        if (expanded) throw new Error('unroll: a loop that never ends inside one that does');
        if (isStart(e)) keptOpen[e.op - 0xD0] = true; else keptOpen[e.op - 0xD4] = false;
        out.push(copyEvent(e, e.d + carry)); carry = 0; i++;
        continue;
      }
      if (isStart(e)) { loopStart[e.op - 0xD0] = i + 1; carry += e.d; i++; expanded++; continue; }
      if (isEnd(e)) {
        const lv = e.op - 0xD4;
        carry += e.d;
        if (counters[lv]) { counters[lv]--; if (counters[lv]) i = loopStart[lv]; else { i++; expanded--; } }
        else { counters[lv] = e.a[0]; i = loopStart[lv]; }
        continue;
      }
      if (isExit(e)) {
        const lv = e.op - 0xD8;
        if (keptOpen[lv]) throw new Error('unroll: an exit from a loop that never ends');
        carry += e.d;
        if (counters[lv] === 1) { counters[lv] = 0; i = e.to; expanded--; } else i++;
        continue;
      }
      if (e.k === 'jump') throw new Error(`unroll: command ${e.op.toString(16).toUpperCase()} is not supported`);
      out.push(copyEvent(e, e.d + carry)); carry = 0; i++;
    }
    if (carry) throw new Error('unroll: the track ends inside a loop');
    return out;
  }

  /* ---- compress: repeats written once, as driver loops (03_ARCHITECTURE.md §5) -------------------
   * Input: a written-out track (Seq.unroll; only loops that never end). Tokens = (delta, event); two
   * tokens are equal when both are. A loop replays its bytes exactly, set-up commands included, so a
   * run of equal tokens is exactly what a loop can say. For each period p the run lengths of
   * token[i] == token[i + p] are found backwards; a run of m matches from s is a repeat of
   * c = 1 + floor(m / p) passes and a tail of m mod p tokens (written with a last-pass exit). The first
   * token of a body carries the delta of the second pass; a larger first delta goes on the loop start
   * only when the second pass's delta is 0 (never two waits where the input had one: the driver crosses
   * one wait per frame, so a split wait can land a frame late; found 2026-10-02 in G3).
   * The best saving is taken (ties: longer span, then earlier start), then the same is done inside its
   * body (next level) and before and after it (same level), until nothing saves bytes.
   * Never crossed by a loop: barrier events (opts.barriers, input indices: they stay outside every new
   * loop and never start one), loop commands already there, FF. New loops use levels 1..3 not already
   * open around them; counts stay at or below 255. CA..CF are never written. Every output event that
   * came from the input carries `src` = its input index. */
  const MAX_PERIOD = 2048;
  function compress(events, opts) {
    opts = opts || {};
    const n = events.length;
    const barrier = new Uint8Array(n);
    for (const b of opts.barriers || []) if (b >= 0 && b < n) barrier[b] = 1;
    const ids = new Int32Array(n), eids = new Int32Array(n), sizes = new Int32Array(n);
    const idOf = new Map(), eidOf = new Map();
    events.forEach((e, i) => {
      if (e.k === 'jump') throw new Error('compress: the track has a jump; write it out first (Seq.unroll)');
      if (e.k === 'cmd' && (isStart(e) || isEnd(e) || e.op === 0xFF || (e.op >= 0xCA && e.op <= 0xCF))) barrier[i] = 1;
      const ek = eventKey(e), k = e.d + '|' + ek;
      if (!idOf.has(k)) idOf.set(k, idOf.size);
      if (!eidOf.has(ek)) eidOf.set(ek, eidOf.size);
      ids[i] = idOf.get(k); eids[i] = eidOf.get(ek); sizes[i] = deltaSize(e.d) + bodySize(e);
    });
    const out = [], exits = [];
    const emit = (k) => { const c = copyEvent(events[k]); c.src = k; out.push(c); };

    function best(idx) {
      const m = idx.length, id = new Int32Array(m), eid = new Int32Array(m), d = new Float64Array(m), S = new Float64Array(m + 1);
      for (let k = 0; k < m; k++) { id[k] = ids[idx[k]]; eid[k] = eids[idx[k]]; d[k] = events[idx[k]].d; S[k + 1] = S[k] + sizes[idx[k]]; }
      let top = null;
      const consider = (s, matched, extra, p) => {
        let c = 1 + Math.floor(matched / p), t = matched % p;
        if (c + (t ? 1 : 0) > 256) { c = 256; t = 0; }
        if (c < 2 && !t) return;
        const span = c * p + t;
        const saving = (S[s + span] - S[s]) - (deltaSize(extra) + 1 + sizes[idx[s + p]] + (S[s + p] - S[s + 1]) + (t ? 3 : 0) + 2);
        if (saving > 0 && (!top || saving > top.saving || (saving === top.saving && (span > top.span || (span === top.span && s < top.s)))))
          top = { s, p, c, t, extra, saving, span };
      };
      const maxP = Math.min(MAX_PERIOD, m - 1);
      for (let p = 1; p <= maxP; p++) {
        let r = 0;
        for (let k = m - p - 1; k >= -1; k--) {
          if (k >= 0 && id[k] === id[k + p]) { r++; continue; }
          if (r) {
            consider(k + 1, r, 0, p);
            if (r >= p && r % p) consider(k + 1 + (r % p), r - (r % p), 0, p);     /* the phase with no tail */
          }
          /* first-delta mismatch: only when the later passes' first delta is 0, so the loop start carries
           * the whole first wait. Splitting a wait in two (part on the loop start, part on the body) keeps
           * the ticks but not the sound: the driver crosses one wait per frame (02_DRIVER.md §2). */
          if (k >= 0 && eid[k] === eid[k + p] && d[k] > d[k + p] && d[k + p] === 0) {
            consider(k, r + 1, d[k] - d[k + p], p);
            const q = (r + 1) % p;
            if (r + 1 >= p && q) consider(k + q, r + 1 - q, 0, p);
          }
          r = 0;
        }
      }
      return top;
    }
    function run(idx, levels, depth) {
      if (depth >= levels.length || idx.length < 2) { for (const k of idx) emit(k); return; }
      const b = best(idx);
      if (!b) { for (const k of idx) emit(k); return; }
      const level = levels[depth];
      run(idx.slice(0, b.s), levels, depth);
      out.push({ d: b.extra, k: 'cmd', op: 0xD0 + level, a: [] });
      const body = [idx[b.s + b.p]].concat(idx.slice(b.s + 1, b.s + b.p));
      let exit = null;
      if (b.t) {
        run(body.slice(0, b.t), levels, depth + 1);
        exit = { d: 0, k: 'jump', op: 0xD8 + level, to: -1 };
        out.push(exit);
        run(body.slice(b.t), levels, depth + 1);
      } else run(body, levels, depth + 1);
      const end = { d: 0, k: 'cmd', op: 0xD4 + level, a: [b.c + (b.t ? 1 : 0) - 1] };
      out.push(end);
      if (exit) exits.push([exit, end]);
      run(idx.slice(b.s + b.span), levels, depth);
    }

    const open = [0, 0, 0, 0];
    for (let i = 0; i < n;) {
      if (barrier[i]) {
        const e = events[i];
        emit(i);
        if (isStart(e)) open[e.op - 0xD0]++;
        else if (isEnd(e) && open[e.op - 0xD4]) open[e.op - 0xD4]--;
        i++;
        continue;
      }
      let j = i;
      while (j < n && !barrier[j]) j++;
      const idx = [];
      for (let k = i; k < j; k++) idx.push(k);
      run(idx, [1, 2, 3].filter((l) => !open[l]), 0);
      i = j;
    }
    if (exits.length) {
      const where = new Map(out.map((e, i) => [e, i]));
      for (const [exit, end] of exits) exit.to = where.get(end) + 1;
    }
    return out;
  }

  /* ---- listing: one line per event, loops indented, with byte offsets and the bytes ---------------- */
  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const noteName = (n) => NOTE_NAMES[n % 12] + (Math.floor(n / 12) - 1);
  const s8 = (v) => (v << 24) >> 24;
  const hexb = (v, w) => v.toString(16).toUpperCase().padStart(w || 2, '0');
  function describe(e, target) {
    if (e.k === 'note') return `note ${noteName(e.n)} vel ${e.v} len ${e.len}${e.tie ? ' tie' : ''}`;
    const op = e.op, a = e.a || [];
    if (e.k === 'jump') {
      if (op >= 0xD8) return `last-pass exit (level ${op - 0xD8}) to ${hexb(target, 4)}`;
      return `${COMMANDS[op].name} to ${hexb(target, 4)}`;
    }
    if (op >= 0xD0 && op <= 0xD3) return `loop start (level ${op - 0xD0})`;
    if (op >= 0xD4 && op <= 0xD7) return `loop end (level ${op - 0xD4}): ${a[0] ? `${a[0]} more pass${a[0] > 1 ? 'es' : ''}` : 'forever'}`;
    switch (op) {
      case 0xC1: return `tempo ${tempoToBpm((a[0] << 8) | a[1]).toFixed(2)} bpm`;
      case 0xC2: return `bank ${a[0] & 15}`;
      case 0xC3: return `detune ${s8(a[0])} (${s8(a[0]) * 24} units)`;
      case 0xC4: return `program ${a[0] & 127}`;
      case 0xE7: return `fine pitch ${a[0]} (${(a[0] - 64) * 4} units)`;
      case 0xDC: case 0xDD: case 0xDE: case 0xDF: return `${COMMANDS[op].name} ${s8(a[0])}`;
      case 0xE8: return `game byte ${a[0]} = ${a[1]}${a[0] === 0 ? ' (phrase marker)' : ''}`;
      case 0xCF: return `continue at track ${a[0] + 1}`;
      case 0xFF: return 'end of track';
      default: return `${COMMANDS[op].name}${a.length ? ' ' + a.join(' ') : ''}`;
    }
  }
  function listTrack(events, base, lines) {
    const pos = [base];
    for (const e of events) pos.push(pos[pos.length - 1] + deltaSize(e.d) + bodySize(e));
    let tick = 0, depth = 0;
    events.forEach((e, i) => {
      tick += e.d;
      if (isEnd(e) && depth) depth--;
      const bytes = [];
      pushDelta(bytes, e.d);
      if (e.k === 'note') { bytes.push(0x80 | (e.v & 0x3F), (e.n & 0x7F) | (e.tie ? 0x80 : 0)); pushLength(bytes, e.len); }
      else if (e.k === 'jump') { const off = pos[e.to] - pos[i + 1]; bytes.push(e.op, (off >> 8) & 0xFF, off & 0xFF); }
      else bytes.push(e.op, ...e.a);
      const where = `${Math.floor(tick / BAR) + 1}.${Math.floor((tick % BAR) / TICKS_PER_BEAT) + 1}.${String(tick % TICKS_PER_BEAT).padStart(2, '0')}`;
      lines.push(`${hexb(pos[i], 4)} ${String(tick).padStart(7)} ${where.padStart(10)}  ${'  '.repeat(depth)}${describe(e, pos[e.to])}  [${bytes.map((b) => hexb(b)).join(' ')}]`);
      if (isStart(e)) depth++;
    });
    return pos[pos.length - 1] - base;
  }
  /* bytesOrEvents: a whole sequence (Uint8Array / array of bytes) or one track's events */
  function listing(bytesOrEvents) {
    const lines = [];
    if (bytesOrEvents.length && typeof bytesOrEvents[0] === 'object') {
      const n = listTrack(bytesOrEvents, 0, lines);
      return [`track: ${bytesOrEvents.length} events, ${n} bytes  (offset, tick, bar.beat.tick, event, bytes)`].concat(lines).join('\n');
    }
    const bytes = bytesOrEvents, seq = decompile(bytes), out = [`sequence: ${bytes.length} bytes; ticks are the sequence's own (48 a beat), counted as written (a loop's body once)`];
    seq.tracks.forEach((ev, k) => {
      if (!ev) return;
      const at = (bytes[1 + 2 * k] << 8) | bytes[2 + 2 * k], body = [];
      const n = listTrack(ev, at, body);
      out.push('', `track ${k + 1} · offset ${hexb(at, 4)} · ${n} bytes · ${ev.length} events`);
      for (const l of body) out.push(l);
    });
    return out.join('\n');
  }

  const api = { PARAMS, TICKS_PER_BEAT, BAR, LEAD_IN, FRAME_RATE, paramCount, tempoToBpm, bpmToTempo, readDelta, readLength,
                decompile, compile, follow, lanes, buildTracks,
                COMMANDS, check, listing, unroll, compress, eventKey, deltaSize, noteName };
  g.SF3Seq = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
