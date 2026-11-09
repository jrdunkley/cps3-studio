/* Standard MIDI files: read one into parts for the editor, and write songs out.
 * Times are converted to the game's 48 ticks per beat.
 *
 *   parse(bytes, { sustain })   a file -> { format, division, parts, tempo, timeSignature, lengthTicks, ours,
 *                               + markers, timeSignatures, keySignatures, texts, copyright, title, endTicks }
 *                               and per part: programChanges, programName, tune (cents)
 *   write(song)                 low level: { bpm, tempoChanges, timeSignature(s), keySignature, markers, texts, name, endTick,
 *                               tracks:[{ name, channel, events }] }, events: note, program, cc, bend, rpn, marker, text
 *   fromProject(project, opts)  an editor project (version 1 or 2) -> MIDI bytes, one track per part
 *   toProject(midi, opts)       parsed MIDI -> a version-2 project (04_FORMATS.md section 1)
 *
 * How things travel (docs/plan/wp/A10_midi.md):
 *  - Programs are the game's numbers, with the text mark "sf3music" in the first track, so the Studio
 *    recognises its own files (parse().ours). Other files carry GM programs, shown by name (gmName).
 *  - Pitch: a note's `bend` and the lanes `pitch` / `detune` become the pitch wheel, bend range 12 semitones
 *    set by RPN 0. A C3 step (24/256 semitone) is then exactly 64 wheel units, so bends survive the trip exactly.
 *    The wheel belongs to the channel: notes of one part that sound together share one bend.
 *  - Slurs: a note with `tie` (or any touching/overlapping note of a `legato` part) is written one tick longer
 *    than the start of the note it slurs into; reading, a note that ends 1..3 ticks after a later note of its
 *    part starts is slurred into it (SLUR_MAX). In a file from outside this is done only for parts that are
 *    otherwise a single line, so held chords that overlap a little are not turned into slurs. For the same
 *    reason a note of the project that is not slurred is cut back to that start when it would end 1..3 ticks
 *    after it, and a slurred note comes back with its length cut at the note it slurs into.
 *  - Not carried by MIDI: devices, vibrato, gain, per-note `slide` and `cents`, the `post` flag of a lane
 *    point, muting, the part roles, and the phrase marker settings. Everything else is.
 */
(function (g) {
  'use strict';
  const TPB = 48, BAR = 4 * TPB, MARK = 'sf3music', SLUR_MAX = 3;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const round2 = (v) => Math.round(v * 100) / 100;

  /* the 128 General MIDI program names, and the drum kits channel 10 selects */
  const GM_NAMES = [
    'Acoustic Grand Piano', 'Bright Acoustic Piano', 'Electric Grand Piano', 'Honky-tonk Piano', 'Electric Piano 1', 'Electric Piano 2', 'Harpsichord', 'Clavinet',
    'Celesta', 'Glockenspiel', 'Music Box', 'Vibraphone', 'Marimba', 'Xylophone', 'Tubular Bells', 'Dulcimer',
    'Drawbar Organ', 'Percussive Organ', 'Rock Organ', 'Church Organ', 'Reed Organ', 'Accordion', 'Harmonica', 'Tango Accordion',
    'Acoustic Guitar (nylon)', 'Acoustic Guitar (steel)', 'Electric Guitar (jazz)', 'Electric Guitar (clean)', 'Electric Guitar (muted)', 'Overdriven Guitar', 'Distortion Guitar', 'Guitar Harmonics',
    'Acoustic Bass', 'Electric Bass (finger)', 'Electric Bass (pick)', 'Fretless Bass', 'Slap Bass 1', 'Slap Bass 2', 'Synth Bass 1', 'Synth Bass 2',
    'Violin', 'Viola', 'Cello', 'Contrabass', 'Tremolo Strings', 'Pizzicato Strings', 'Orchestral Harp', 'Timpani',
    'String Ensemble 1', 'String Ensemble 2', 'Synth Strings 1', 'Synth Strings 2', 'Choir Aahs', 'Voice Oohs', 'Synth Voice', 'Orchestra Hit',
    'Trumpet', 'Trombone', 'Tuba', 'Muted Trumpet', 'French Horn', 'Brass Section', 'Synth Brass 1', 'Synth Brass 2',
    'Soprano Sax', 'Alto Sax', 'Tenor Sax', 'Baritone Sax', 'Oboe', 'English Horn', 'Bassoon', 'Clarinet',
    'Piccolo', 'Flute', 'Recorder', 'Pan Flute', 'Blown Bottle', 'Shakuhachi', 'Whistle', 'Ocarina',
    'Lead 1 (square)', 'Lead 2 (sawtooth)', 'Lead 3 (calliope)', 'Lead 4 (chiff)', 'Lead 5 (charang)', 'Lead 6 (voice)', 'Lead 7 (fifths)', 'Lead 8 (bass + lead)',
    'Pad 1 (new age)', 'Pad 2 (warm)', 'Pad 3 (polysynth)', 'Pad 4 (choir)', 'Pad 5 (bowed)', 'Pad 6 (metallic)', 'Pad 7 (halo)', 'Pad 8 (sweep)',
    'FX 1 (rain)', 'FX 2 (soundtrack)', 'FX 3 (crystal)', 'FX 4 (atmosphere)', 'FX 5 (brightness)', 'FX 6 (goblins)', 'FX 7 (echoes)', 'FX 8 (sci-fi)',
    'Sitar', 'Banjo', 'Shamisen', 'Koto', 'Kalimba', 'Bagpipe', 'Fiddle', 'Shanai',
    'Tinkle Bell', 'Agogo', 'Steel Drums', 'Woodblock', 'Taiko Drum', 'Melodic Tom', 'Synth Drum', 'Reverse Cymbal',
    'Guitar Fret Noise', 'Breath Noise', 'Seashore', 'Bird Tweet', 'Telephone Ring', 'Helicopter', 'Applause', 'Gunshot',
  ];
  const GM_DRUM_KITS = { 0: 'Standard Kit', 8: 'Room Kit', 16: 'Power Kit', 24: 'Electronic Kit', 25: 'TR-808 Kit', 32: 'Jazz Kit', 40: 'Brush Kit', 48: 'Orchestra Kit', 56: 'SFX Kit' };
  const gmName = (program, drums) => (program === null || program === undefined) ? null
    : drums ? (GM_DRUM_KITS[program] || 'Drum Kit') : (GM_NAMES[program & 0x7F] || null);

  const decodeText = (raw) => {                        // names: UTF-8 when the bytes are UTF-8 (Frédéric), else Latin-1
    try { return new TextDecoder('utf-8', { fatal: true }).decode(raw).trim(); } catch (e) { return new TextDecoder('latin1').decode(raw).trim(); }
  };

  /* ================================================================================================ parse */
  function parse(bytes, options) {
    const sustain = !!(options && options.sustain);           // optional: a note off while the pedal is down waits for the pedal
    let p = 0;
    const u32 = () => { const v = ((bytes[p] << 24) | (bytes[p + 1] << 16) | (bytes[p + 2] << 8) | bytes[p + 3]) >>> 0; p += 4; return v; };
    const u16 = () => { const v = (bytes[p] << 8) | bytes[p + 1]; p += 2; return v; };
    const tag = () => { const s = String.fromCharCode(bytes[p], bytes[p + 1], bytes[p + 2], bytes[p + 3]); p += 4; return s; };
    const vlq = () => { let v = 0, c; do { c = bytes[p++]; v = v * 128 + (c & 0x7F); } while (c & 0x80); return v; };
    if (tag() !== 'MThd') throw new Error('This is not a MIDI file.');
    const headerLength = u32(), format = u16(), trackCount = u16(), division = u16();
    p += headerLength - 6;
    if (division & 0x8000) throw new Error('This MIDI file uses SMPTE time; save it with beats (PPQ) timing instead.');
    if (!division) throw new Error('The MIDI file is damaged (no time division).');
    const toTick = (t) => Math.round(t * TPB / division);
    const parts = new Map(), tempo = [], markers = [], timeSignatures = [], keySignatures = [], texts = [], trackNames = [];
    let lengthTicks = 0, endTicks = 0, timeSignature = null, ours = false, copyright = '';
    for (let ti = 0; ti < trackCount && p < bytes.length; ti++) {
      let id = tag(), chunkLength = u32();
      while (id !== 'MTrk' && /^[\x20-\x7E]{4}$/.test(id) && p + chunkLength + 8 <= bytes.length) {   // a chunk of another kind: skipped, as the standard asks
        p += chunkLength; id = tag(); chunkLength = u32();
      }
      if (id !== 'MTrk') throw new Error('The MIDI file is damaged (missing track).');
      const end = p + chunkLength;
      let t = 0, status = 0, trackName = '';
      const open = new Map();
      const pedal = new Array(16).fill(0), held = [];
      const part = (ch) => {
        const key = ti * 16 + ch;
        if (!parts.has(key)) parts.set(key, { track: ti, channel: ch, name: '', program: null, bank: null, volume: null, pan: null, expression: null, notes: [],
                                              bends: [], bendRange: 2, controls: [], rpn: [127, 127], programChanges: [], tune: 0, _bank: null, _tune: [64, 0] });
        return parts.get(key);
      };
      const finish = (ch, note, on, tOff) => {
        const start = toTick(on.t), len = Math.max(1, toTick(tOff) - start);
        part(ch).notes.push({ t: start, n: note, v: on.v, len });
        lengthTicks = Math.max(lengthTicks, start + len);
      };
      const release = (pred, tOff) => { for (let i = 0; i < held.length;) { const h = held[i]; if (pred(h)) { finish(h.ch, h.note, h.on, tOff); held.splice(i, 1); } else i++; } };
      while (p < end) {
        t += vlq();
        let b = bytes[p];
        if (b & 0x80) { status = b; p++; } else b = status;          // running status
        const type = status & 0xF0, ch = status & 0x0F;
        if (status === 0xFF) {
          const meta = bytes[p++], len = vlq();
          if (meta === 0x51 && len === 3) tempo.push({ t: toTick(t), bpm: 60000000 / ((bytes[p] << 16) | (bytes[p + 1] << 8) | bytes[p + 2]) });
          else if (meta === 0x03) trackName = decodeText(bytes.slice(p, p + len));
          else if (meta === 0x01) {
            if (new TextDecoder('latin1').decode(bytes.slice(p, p + len)).includes('sf3music')) ours = true;
            texts.push({ t: toTick(t), text: decodeText(bytes.slice(p, p + len)) });
          }
          else if (meta === 0x02) { if (!copyright) copyright = decodeText(bytes.slice(p, p + len)); }
          else if (meta === 0x06 || meta === 0x07) markers.push({ t: toTick(t), text: decodeText(bytes.slice(p, p + len)), kind: meta === 0x06 ? 'marker' : 'cue' });
          else if (meta === 0x58 && len >= 2) {
            if (!timeSignature) timeSignature = [bytes[p], 1 << bytes[p + 1]];
            timeSignatures.push({ t: toTick(t), num: bytes[p], den: 1 << bytes[p + 1] });
          }
          else if (meta === 0x59 && len >= 2) keySignatures.push({ t: toTick(t), sf: (bytes[p] << 24) >> 24, minor: bytes[p + 1] === 1 });
          p += len;
        } else if (status === 0xF0 || status === 0xF7) {
          // Read the length before advancing the body cursor. `p += vlq()`
          // captures p before vlq consumes its own bytes and desynchronizes.
          let len = 0, c, digits = 0;
          do {
            if (p >= end || p >= bytes.length || digits++ === 4) throw new Error('The MIDI file is damaged (invalid SysEx length).');
            c = bytes[p++]; len = len * 128 + (c & 0x7F);
          } while (c & 0x80);
          if (p + len > end || p + len > bytes.length) throw new Error('The MIDI file is damaged (truncated SysEx body).');
          p += len;
        }
        else if (type === 0x90 || type === 0x80) {
          const note = bytes[p++], vel = bytes[p++], key = ch * 128 + note;
          if (type === 0x90 && vel > 0) {
            if (sustain) release((h) => h.ch === ch && h.note === note, t);   // struck again while held: the held one stops here
            if (!open.has(key)) open.set(key, []);
            open.get(key).push({ t, v: vel });
          } else if (open.has(key) && open.get(key).length) {
            const on = open.get(key).shift();
            if (sustain && pedal[ch] >= 64) held.push({ ch, note, on }); else finish(ch, note, on, t);
          }
        } else if (type === 0xC0) {
          const pc = bytes[p++], x = part(ch);
          if (x.program === null) x.program = pc; else x.programChanges.push({ t: toTick(t), program: pc, bank: x._bank });
        }
        else if (type === 0xD0) p += 1;
        else if (type === 0xB0) {                                   // the first bank, volume, pan and expression of a part
          const controller = bytes[p++], value = bytes[p++], x = part(ch);
          const field = { 0: 'bank', 7: 'volume', 10: 'pan', 11: 'expression' }[controller];
          if (field && x[field] === null) x[field] = value;
          if (controller === 0) x._bank = value;
          if (controller === 64 && sustain) { pedal[ch] = value; if (value < 64) release((h) => h.ch === ch, t); }
          /* every volume, pan, expression and sustain change, and the bend range (RPN 0, data entry) */
          if (controller === 7 || controller === 10 || controller === 11 || controller === 64) x.controls.push({ t: toTick(t), c: controller, v: value });
          else if (controller === 101) x.rpn[0] = value; else if (controller === 100) x.rpn[1] = value;
          else if (controller === 6 && x.rpn[0] === 0 && x.rpn[1] === 0 && value > 0) x.bendRange = value;
          else if ((controller === 6 || controller === 38) && x.rpn[0] === 0 && x.rpn[1] === 1) {            // RPN 1: channel fine tuning, 8192 = none, +-100 cents
            x._tune[controller === 6 ? 0 : 1] = value;
            x.tune = round2((((x._tune[0] << 7) | x._tune[1]) - 8192) / 81.92);
          }
        }
        else if (type === 0xE0) { part(ch).bends.push({ t: toTick(t), v: ((bytes[p + 1] << 7) | bytes[p]) - 8192 }); p += 2; }   // pitch bend, -8192..8191
        else if (type === 0xA0) p += 2;
        else throw new Error('The MIDI file is damaged (unknown event).');
      }
      p = end;
      release(() => true, t);
      endTicks = Math.max(endTicks, toTick(t));
      trackNames[ti] = trackName;
      for (const part of parts.values()) if (part.track === ti && !part.name) part.name = trackName;
    }
    const list = Array.from(parts.values()).filter((x) => x.notes.length);
    list.forEach((x, i) => {
      x.notes.sort((a, b) => a.t - b.t || a.n - b.n);
      delete x.rpn; delete x._bank; delete x._tune;
      x.drums = x.channel === 9;
      x.name = x.name || `Track ${x.track + 1}`;
      if (list.filter((y) => y.track === x.track).length > 1) x.name += ` (channel ${x.channel + 1})`;
      x.programName = ours ? null : gmName(x.program, x.drums);     // GM names are for files from outside; this editor's own files hold the game's numbers
      /* most notes sounding at once */
      const edges = [];
      for (const n of x.notes) { edges.push([n.t, 1]); edges.push([n.t + n.len, -1]); }
      edges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      let cur = 0, max = 0;
      for (const e of edges) { cur += e[1]; max = Math.max(max, cur); }
      x.polyphony = max;
    });
    tempo.sort((a, b) => a.t - b.t);
    markers.sort((a, b) => a.t - b.t);
    timeSignatures.sort((a, b) => a.t - b.t);
    keySignatures.sort((a, b) => a.t - b.t);
    /* the song's title: the first track's name when that track holds no notes (the usual tempo track), or a format 0 file's one track name */
    const withNotes = new Set(list.map((x) => x.track));
    const title = trackNames[0] && (!withNotes.has(0) || format === 0) ? trackNames[0] : '';
    return { format, division, parts: list, tempo, timeSignature, lengthTicks, ours, markers, timeSignatures, keySignatures, texts, copyright, title, endTicks };
  }

  /* ================================================================================================ write */
  /* song: { bpm, tempoChanges:[{t,bpm}], text, texts:[string], name, copyright, timeSignature:[n,d] | timeSignatures:[{t,num,den}],
   *         keySignature:{sf,minor}, markers:[{t,text}], endTick,
   *         tracks:[{ name, channel, bendRange, tune, events:[{t, kind:'note'|'program'|'cc'|'bend'|'rpn'|'marker'|'text', ...}] }] } at 48 ticks per beat.
   *   note {n, v, len}  program {value}  cc {controller, value}  bend {value: -8192..8191}  rpn {rpn:[msb,lsb], value:[msb,lsb?]}
   *   marker / text {text}.  cc, program and bend take `post: true` to follow a note that starts on the same tick.
   *   bendRange (semitones) and tune (cents) are shorthand for the RPN 0 and RPN 1 messages at tick 0. */
  function write(song) {
    const chunks = [];
    const vlq = (out, v) => { const d = [v & 0x7F]; v = Math.floor(v / 128); while (v > 0) { d.unshift((v & 0x7F) | 0x80); v = Math.floor(v / 128); } out.push(...d); };
    const textBytes = (s, max) => Array.from(new TextEncoder().encode(String(s))).slice(0, max);
    const meta = (type, data) => { const out = [0xFF, type]; vlq(out, data.length); return out.concat(data); };
    const track = (events, endTick) => {
      const out = [];
      let last = 0;
      events.sort((a, b) => a.t - b.t || a.order - b.order);
      for (const e of events) { vlq(out, Math.max(0, e.t - last)); last = Math.max(last, e.t); out.push(...e.bytes); }
      vlq(out, Math.max(0, Math.round(endTick || 0) - last));
      out.push(0xFF, 0x2F, 0);
      chunks.push([0x4D, 0x54, 0x72, 0x6B, (out.length >>> 24) & 0xFF, (out.length >> 16) & 0xFF, (out.length >> 8) & 0xFF, out.length & 0xFF, ...out]);
    };
    const tempoEvents = [{ t: 0, bpm: song.bpm }].concat(song.tempoChanges || []).map((c) => {
      const us = clamp(Math.round(60000000 / c.bpm), 1, 0xFFFFFF);
      return { t: c.t, order: 0, bytes: [0xFF, 0x51, 3, (us >> 16) & 0xFF, (us >> 8) & 0xFF, us & 0xFF] };
    });
    const sigs = song.timeSignatures || [{ t: 0, num: (song.timeSignature || [4, 4])[0], den: (song.timeSignature || [4, 4])[1] }];
    for (const s of sigs) tempoEvents.push({ t: Math.round(s.t), order: -1, bytes: [0xFF, 0x58, 4, clamp(Math.round(s.num), 1, 255), clamp(Math.round(Math.log2(s.den)), 0, 7), 24, 8] });
    if (!sigs.some((s) => Math.round(s.t) === 0)) tempoEvents.push({ t: 0, order: -1.5, bytes: [0xFF, 0x58, 4, 4, 2, 24, 8] });
    if (song.text) { const text = textBytes(song.text, 100); tempoEvents.push({ t: 0, order: -3, bytes: [0xFF, 0x01, text.length, ...text] }); }
    if (song.name) tempoEvents.push({ t: 0, order: -4, bytes: meta(0x03, textBytes(song.name, 100)) });
    if (song.copyright) tempoEvents.push({ t: 0, order: -3.5, bytes: meta(0x02, textBytes(song.copyright, 200)) });
    (song.texts || []).forEach((s, i) => tempoEvents.push({ t: 0, order: -2.5 + i * 0.001, bytes: meta(0x01, textBytes(s, 1000)) }));
    if (song.keySignature) tempoEvents.push({ t: 0, order: -1.2, bytes: [0xFF, 0x59, 2, clamp(song.keySignature.sf | 0, -7, 7) & 0xFF, song.keySignature.minor ? 1 : 0] });
    for (const m of song.markers || []) tempoEvents.push({ t: Math.round(m.t), order: 5, bytes: meta(0x06, textBytes(m.text, 200)) });
    track(tempoEvents, song.endTick);
    for (const tr of song.tracks) {
      const ch = tr.channel & 0x0F, events = [];
      const name = Array.from(new TextEncoder().encode(tr.name || '')).slice(0, 100);
      events.push({ t: 0, order: -2, bytes: [0xFF, 0x03, name.length, ...name] });
      const rpn = (t, order, number, data) => {
        events.push({ t, order, bytes: [0xB0 | ch, 101, number[0] & 0x7F] }, { t, order, bytes: [0xB0 | ch, 100, number[1] & 0x7F] },
                    { t, order, bytes: [0xB0 | ch, 6, data[0] & 0x7F] });
        if (data.length > 1) events.push({ t, order, bytes: [0xB0 | ch, 38, data[1] & 0x7F] });
        events.push({ t, order, bytes: [0xB0 | ch, 101, 127] }, { t, order, bytes: [0xB0 | ch, 100, 127] });   // RPN null: later data entries change nothing
      };
      if (tr.bendRange) rpn(0, 1.5, [0, 0], [clamp(Math.round(tr.bendRange), 1, 127), 0]);
      if (tr.tune) { const v = clamp(Math.round(8192 + tr.tune * 81.92), 0, 16383); rpn(0, 1.5, [0, 1], [v >> 7, v & 0x7F]); }
      for (const e of tr.events) {
        const after = e.post ? 4 : 2;
        if (e.kind === 'note') {
          events.push({ t: e.t, order: 3, bytes: [0x90 | ch, e.n & 0x7F, Math.max(1, Math.min(127, e.v))] });
          events.push({ t: e.t + Math.max(1, e.len), order: 1, bytes: [0x80 | ch, e.n & 0x7F, 0] });
        } else if (e.kind === 'program') events.push({ t: e.t, order: after, bytes: [0xC0 | ch, e.value & 0x7F] });
        else if (e.kind === 'cc') events.push({ t: e.t, order: after, bytes: [0xB0 | ch, e.controller & 0x7F, e.value & 0x7F] });
        else if (e.kind === 'bend') { const v = clamp(Math.round(e.value), -8192, 8191) + 8192; events.push({ t: Math.round(e.t), order: after, bytes: [0xE0 | ch, v & 0x7F, (v >> 7) & 0x7F] }); }
        else if (e.kind === 'rpn') rpn(Math.round(e.t), 1.5, e.rpn, [].concat(e.value));
        else if (e.kind === 'marker' || e.kind === 'text') events.push({ t: Math.round(e.t), order: 0, bytes: meta(e.kind === 'marker' ? 0x06 : 0x01, textBytes(e.text, 1000)) });
      }
      track(events, song.endTick);
    }
    const n = chunks.length;
    const head = [0x4D, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, (n >> 8) & 0xFF, n & 0xFF, (TPB >> 8) & 0xFF, TPB & 0xFF];
    return Uint8Array.from(head.concat(...chunks));
  }

  /* ================================================================================================ small helpers shared by both directions */
  const sortedUnique = (list) => Array.from(new Set(list)).sort((a, b) => a - b);
  /* the largest onset s with lo < s < hi, or undefined (onsets sorted) */
  function onsetBefore(onsets, lo, hi) {
    let a = 0, b = onsets.length;
    while (a < b) { const m = (a + b) >> 1; if (onsets[m] >= hi) b = m; else a = m + 1; }
    const s = a > 0 ? onsets[a - 1] : undefined;
    return s !== undefined && s > lo ? s : undefined;
  }
  /* the smallest onset greater than t, or undefined (onsets sorted) */
  function onsetAfter(onsets, t) {
    let a = 0, b = onsets.length;
    while (a < b) { const m = (a + b) >> 1; if (onsets[m] > t) b = m; else a = m + 1; }
    return a < onsets.length ? onsets[a] : undefined;
  }
  function maxAtOnce(notes, lenOf) {
    const edges = [];
    for (const n of notes) { edges.push([n.t, 1]); edges.push([n.t + lenOf(n), -1]); }
    edges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let cur = 0, max = 0;
    for (const e of edges) { cur += e[1]; max = Math.max(max, cur); }
    return max;
  }
  /* key signature <-> key: a number of sharps (negative: flats) and major/minor <-> a tonic pitch class and "major" / "minor" */
  const tonicOf = (sf, minor) => { const major = (((sf * 7) % 12) + 12) % 12; return minor ? (major + 9) % 12 : major; };
  const signatureOf = (root, minor) => { const major = ((minor ? root + 3 : root) % 12 + 12) % 12; return ((major * 7 + 6) % 12) - 6; };

  /* ================================================================================================ project -> MIDI */
  /* One MIDI track per part. Drum kits that follow GM keys (the game's kit 6; opts.gmKits lists the programs) go on
   * channel 10, everything else on the other channels in order. opts.catalog is accepted for later use (kit descriptions). */
  function fromProject(project, opts) {
    opts = opts || {};
    const P = project || {};
    const parts = Array.isArray(P.parts) ? P.parts : [];
    const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);
    const gmKits = opts.gmKits || [6];
    const isGmKit = (part) => (num(part.bank, 0) | 0) === 0 && gmKits.includes(num(part.program, 0) | 0);
    const WHEEL_STEP = 64, WHEEL_CENT = 8192 / 1200;            // range 12 semitones: a C3 step is 64 units, a cent 6.83

    const pool = [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15];
    /* the song's declared length: a note that starts inside it is cut at its end, as the builder does (a note starting after it is kept and the song grows) */
    const bars = num(P.bars, 0), declared = Math.max(num(P.length, 0) > 0 ? Math.round(P.length) : 0, Math.round(bars * BAR));
    let used = 0, lastTick = 0;
    const tracks = parts.map((part) => {
      const gmKit = isGmKit(part);
      const ch = gmKit ? 9 : pool[used++ % pool.length];
      const transpose = gmKit ? 0 : (num(part.transpose, 0) | 0);
      const auto = part.automation || {};
      const lane = (name) => (Array.isArray(auto[name]) ? auto[name].filter((q) => q && isFinite(q.t) && isFinite(q.v)).sort((a, b) => a.t - b.t) : []);
      const defaults = { bank: num(part.bank, 0) & 0x0F, program: num(part.program, 0) & 0x7F, volume: clamp(Math.round(num(part.volume, 80)), 0, 127),
                         pan: clamp(Math.round(num(part.pan, 64)), 0, 127), expression: clamp(Math.round(num(part.expression, 100)), 0, 127) };
      const notes = (Array.isArray(part.notes) ? part.notes : []).filter((n) => n && isFinite(n.t) && isFinite(n.n)).map((n, i) => ({ n, i, t: Math.round(n.t), len: Math.max(1, Math.round(num(n.len, 1))) }));
      notes.sort((a, b) => a.t - b.t || b.n.n - a.n.n || a.i - b.i);
      const onsets = sortedUnique(notes.map((x) => x.t));
      /* voices: the first free line takes each note (a slurred note frees its line for the next one), as the compiler's voices do */
      const legato = !!part.legato, linesOf = [];
      for (const x of notes) {
        const tie = !!x.n.tie || legato;
        let line = linesOf.find((l) => l.end <= x.t || (l.tie && l.last.t < x.t));
        if (line) { if (line.tie && line.last.t < x.t) line.last.succ = x; } else { line = { end: 0, last: null, tie: false }; linesOf.push(line); }
        line.last = x; line.end = x.t + x.len; line.tie = tie;
      }
      for (const x of notes) {
        const slur = x.succ && (x.n.tie || (legato && x.t + x.len >= x.succ.t));
        let end = x.t + x.len;
        if (slur) end = x.succ.t + 1;                                  // sounds on into the next note
        else if (!gmKit) {                                             // an end 1..3 ticks after a later note starts would read back as a slur: cut back (repeated, the new end may do the same)
          for (;;) { const s = onsetBefore(onsets, x.t, end); if (s === undefined || end - s > SLUR_MAX) break; end = s; }
        }
        if (declared > 0 && x.t < declared && end > declared) end = declared;
        x.end = end;
      }
      const bendOf = (n) => (Array.isArray(n.bend) ? n.bend.filter((b) => Array.isArray(b) && isFinite(b[0]) && isFinite(b[1]) && b[0] >= 0).sort((a, b) => a[0] - b[0]) : []);
      const usesWheel = !gmKit && (notes.some((x) => bendOf(x.n).length) || lane('pitch').length || lane('detune').length);

      /* everything on the timeline in order: lane points before the notes of their tick, then notes, then bends inside notes, then `post` points */
      const items = [];
      for (const name of ['volume', 'expression', 'pan', 'program', 'pitch', 'detune']) for (const q of lane(name)) items.push({ t: Math.max(0, Math.round(q.t)), ph: q.post ? 2 : 0, kind: 'point', name, q });
      notes.forEach((x, k) => {
        items.push({ t: x.t, ph: 1, kind: 'note', x });
        const bend = bendOf(x.n);
        if (!bend.length) return;
        const next = onsetAfter(onsets, x.t), limit = next === undefined ? x.t + x.len : next;     // bends after the next note starts belong to it
        for (const [dt, value] of bend) if (dt > 0 && x.t + dt < limit) items.push({ t: x.t + Math.round(dt), ph: 1.5, kind: 'bend', value, k });
      });
      items.forEach((it, i) => { it.i = i; });
      items.sort((a, b) => a.t - b.t || a.ph - b.ph || a.i - b.i);

      const events = [];
      const cur = Object.assign({}, defaults), laneNow = {};
      events.push({ t: 0, kind: 'cc', controller: 0, value: cur.bank }, { t: 0, kind: 'program', value: cur.program },
                  { t: 0, kind: 'cc', controller: 7, value: cur.volume }, { t: 0, kind: 'cc', controller: 10, value: cur.pan }, { t: 0, kind: 'cc', controller: 11, value: cur.expression });
      let wheel = 0, noteBend = 0, detuneLane = 0, pitchLane = 0;
      const setWheel = (t, post) => {
        if (!usesWheel) return;
        const total = clamp(Math.round((noteBend + detuneLane) * WHEEL_STEP + pitchLane * WHEEL_CENT), -8192, 8191);
        if (total !== wheel) { events.push({ t, kind: 'bend', value: total, post }); wheel = total; }
      };
      const setControl = (t, controller, field, value, post) => {
        if (value !== cur[field]) { events.push({ t, kind: 'cc', controller, value, post }); cur[field] = value; }
      };
      const setProgram = (t, program, bank, post) => {
        if (bank !== cur.bank) { events.push({ t, kind: 'cc', controller: 0, value: bank, post }); cur.bank = bank; cur.program = -1; }
        if (program !== cur.program) { events.push({ t, kind: 'program', value: program, post }); cur.program = program; }
      };
      const CC = { volume: 7, expression: 11, pan: 10 };
      for (const it of items) {
        if (it.kind === 'point') {
          const { name, q } = it, post = it.ph === 2;
          if (name === 'volume' || name === 'expression' || name === 'pan') { const v = clamp(Math.round(q.v), 0, 127); laneNow[name] = v; setControl(it.t, CC[name], name, v, post); }
          else if (name === 'program') { laneNow.program = clamp(Math.round(q.v), 0, 127); laneNow.bank = q.bank !== undefined ? (q.bank & 0x0F) : cur.bank; setProgram(it.t, laneNow.program, laneNow.bank, post); }
          else if (name === 'detune') { detuneLane = q.v; setWheel(it.t, post); }
          else { pitchLane = q.v; setWheel(it.t, post); }
        } else if (it.kind === 'note') {
          const n = it.x.n;
          for (const name of ['volume', 'expression', 'pan']) {
            const want = laneNow[name] !== undefined ? laneNow[name] : n[name] !== undefined ? clamp(Math.round(n[name]), 0, 127) : defaults[name];
            setControl(it.t, CC[name], name, want, false);
          }
          const wantBank = laneNow.bank !== undefined ? laneNow.bank : n.bank !== undefined ? (n.bank & 0x0F) : defaults.bank;
          const wantProgram = laneNow.program !== undefined ? laneNow.program : n.program !== undefined ? (n.program & 0x7F) : defaults.program;
          setProgram(it.t, wantProgram, wantBank, false);
          const bend = bendOf(n);
          noteBend = bend.length && bend[0][0] === 0 ? bend[0][1] : 0;
          setWheel(it.t, false);
          const key = n.n + transpose;
          if (key >= 0 && key <= 127) {
            events.push({ t: it.t, kind: 'note', n: key, v: clamp(Math.round(num(n.v, 100)), 1, 127), len: it.x.end - it.t });
            lastTick = Math.max(lastTick, it.x.end);
          }
        } else { noteBend = it.value; setWheel(it.t, false); }
      }
      return { name: part.name || '', channel: ch, events, bendRange: usesWheel ? 12 : 0, tune: gmKit ? 0 : num(part.tune, 0) };
    });

    /* conductor track: tempo map, time signature, key, name, markers (sections, loop) */
    const endTick = Math.max(declared, Math.ceil(lastTick / BAR) * BAR);
    const markers = [];
    for (const s of Array.isArray(P.sections) ? P.sections : []) if (s && isFinite(s.bar) && s.bar >= 1 && s.name) markers.push({ t: Math.round((s.bar - 1) * BAR), text: String(s.name) });
    const lp = P.loop && P.loop.on ? P.loop : null;
    if (lp) {
      const start = isFinite(lp.start) ? lp.start : (num(lp.startBar, 1) - 1) * BAR;
      const end = isFinite(lp.end) ? lp.end : num(lp.endBar, bars || 1) * BAR;
      if (end > start) markers.push({ t: Math.round(start), text: 'loopStart' }, { t: Math.round(end), text: 'loopEnd' });
    }
    const key = P.key && (P.key.scale === 'major' || P.key.scale === 'minor') && isFinite(P.key.root) ? { sf: signatureOf(P.key.root | 0, P.key.scale === 'minor'), minor: P.key.scale === 'minor' } : null;
    return write({
      bpm: num(P.bpm, 120), tempoChanges: (Array.isArray(P.tempoChanges) ? P.tempoChanges : []).filter((c) => c && c.t > 0 && c.bpm > 0).map((c) => ({ t: Math.round(c.t), bpm: c.bpm })),
      text: MARK, texts: P.comment ? [String(P.comment)] : [], name: P.name || '', copyright: P.author || '',
      markers, keySignature: key, endTick, tracks,
    });
  }

  /* ================================================================================================ MIDI -> project */
  /* instruments and levels, ported from style/arrange3s.js (ROLE, pickProgram) for when SF3Catalog.suggest is not loaded.
   * velocity is in driver steps (0..63), as there. */
  const ROLE = {
    drums:  { vol: 80, expr: 76, v: 55, pan: 64 },
    perc:   { vol: 70, expr: 70, v: 40, pan: 112 },
    bass:   { vol: 75, expr: 64, v: 50, pan: 64 },
    lead:   { vol: 56, expr: 52, v: 44, pan: 24, echo: { delay: 24, level: 0.5 } },
    pad:    { vol: 64, expr: 64, v: 40, pan: 108, echo: { delay: 16, level: 0.55 } },
    chords: { vol: 80, expr: 64, v: 38, pan: 64, echo: { delay: 20, level: 0.5 } },
    arp:    { vol: 72, expr: 72, v: 40, pan: 40, echo: { delay: 24, level: 0.5 } },
    fx:     { vol: 64, expr: 64, v: 40, pan: 64 },
  };
  const GAME_KITS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 61];      // bank 0 programs that are drum kits (02_DRIVER.md section 5)
  function pickProgram(role, gm) {
    const within = (a, b) => gm >= a && gm <= b;
    if (role === 'drums' || role === 'perc') return 6;
    if (role === 'bass') return within(36, 37) ? 19 : within(38, 39) ? 18 : 20;
    if (role === 'pad') return within(88, 95) ? 57 : within(16, 23) ? 22 : within(0, 7) ? 39 : 46;
    if (role === 'chords') return within(0, 3) || gm === 6 ? 58 : within(4, 5) || gm === 7 || within(8, 15) ? 60 : within(16, 31) ? 22 : within(40, 55) ? 46
      : within(56, 63) ? 37 : within(88, 95) ? 39 : 37;
    if (role === 'lead') return within(64, 67) ? 57 : within(68, 79) || within(52, 54) ? 42 : within(56, 63) ? 43 : within(80, 87) || within(24, 31) ? 44
      : within(0, 7) ? 58 : within(40, 51) ? 46 : 43;
    if (role === 'arp') return within(4, 15) ? 60 : 58;
    return 43;
  }
  function fallbackSuggest(role, gm) {
    const R = ROLE[role] || ROLE.fx;
    return { bank: 0, program: pickProgram(role, gm), volume: R.vol, expression: R.expr, velocity: R.v, pan: R.pan, echo: R.echo ? { delay: R.echo.delay, level: R.echo.level } : null };
  }
  function catalogSuggest() {
    try {
      const C = g.SF3Catalog || (typeof require === 'function' ? require('./catalog.js') : null);
      return C && typeof C.suggest === 'function' ? C.suggest.bind(C) : null;
    } catch (e) { return null; }
  }

  /* GM drum key -> the key of the game's kit 6 (which follows GM keys for 36 kick, 38 snare, 39 clap, 42/46 hats, 49 crash,
   * 51 ride, 54 tambourine, 56 bell, 45 low boom; 53 and 55 are its other percussion hits, as style/arrange3s.js uses them) */
  function drumToKit6(key) {
    if (key === 35 || key === 36) return 36;
    if (key === 37 || key === 39) return 39;
    if (key === 38 || key === 40) return 38;
    if (key === 42 || key === 44) return 42;
    if (key === 46) return 46;
    if ([49, 52, 55, 57].includes(key)) return 49;
    if ([51, 53, 59].includes(key)) return 51;
    if ([41, 43, 45, 47, 48, 50].includes(key)) return 45;
    return ({ 54: 54, 56: 56, 69: 53, 70: 55, 82: 55, 81: 54, 75: 53, 76: 53, 77: 53 })[key] || (key >= 60 && key <= 68 ? 53 : 54);
  }

  /* what a part plays like, for guessing its job (the reasoning of style/arrange3s.js: analyse, guessRoles) */
  function analysePart(part, songTicks) {
    const notes = part.notes, median = (xs) => { if (!xs.length) return 0; const s = xs.slice().sort((a, b) => a - b); return s[s.length >> 1]; };
    const keys = notes.map((n) => n.n).sort((a, b) => a - b);
    const edges = [];
    for (const n of notes) { edges.push([n.t, 1]); edges.push([n.t + n.len, -1]); }
    edges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let cur = 0, last = 0, sounding = 0, weighted = 0;
    for (const [t, d] of edges) { if (cur > 0) { sounding += t - last; weighted += cur * (t - last); } cur += d; last = t; }
    const onsets = new Map();                         // chords: onsets with two or more different pitch classes
    for (const n of notes) { const k = Math.round(n.t / 3); if (!onsets.has(k)) onsets.set(k, new Set()); onsets.get(k).add(n.n % 12); }
    let chordy = Array.from(onsets.values()).filter((c) => c.size >= 2).length / Math.max(1, onsets.size);
    const avgPoly = sounding ? weighted / sounding : 0, medKey = keys[keys.length >> 1];
    if (chordy < 0.3 && avgPoly >= 2.5 && medKey >= 52) chordy = 0.5;           // stacks of octaves are chords, not a tune
    let moved = 0;
    for (let i = 1; i < notes.length; i++) if (notes[i].n !== notes[i - 1].n) moved++;
    return { count: notes.length, median: medKey, avgPoly, chordy, coverage: sounding / Math.max(1, songTicks), medLen: median(notes.map((n) => n.len)),
             moves: moved / Math.max(1, notes.length - 1), gm: part.program === null ? -1 : part.program };
  }
  /* role of every part: drums | perc | bass | chords | pad | lead | arp | fx. Drums = channel 10; the lowest single-note part is the bass;
   * parts playing several different notes at once are chords (held: a pad); the high moving part is the lead. Returns Map(part -> role). */
  function guessRoles(parts, songTicks) {
    const roles = new Map();
    const melodic = parts.filter((p) => !p.drums);
    for (const p of parts) if (p.drums) roles.set(p, 'drums');
    const stats = new Map(), S = (p) => stats.get(p);
    for (const p of melodic) stats.set(p, analysePart(p, songTicks));
    const live = [];
    for (const p of melodic) {
      if (S(p).gm >= 120) roles.set(p, 'fx');
      else if (S(p).gm >= 112) roles.set(p, 'perc');
      else if (S(p).count < 4) roles.set(p, 'fx');
      else live.push(p);
    }
    const family = (p) => (S(p).gm >= 0 ? S(p).gm >> 3 : -1);
    const bassCands = live.filter((p) => !roles.has(p) && (S(p).median < 50 || family(p) === 4) && S(p).chordy < 0.35);
    bassCands.sort((a, b) => S(b).count * S(b).coverage - S(a).count * S(a).coverage);
    if (bassCands[0]) roles.set(bassCands[0], 'bass');
    for (const p of live) if (!roles.has(p) && S(p).chordy >= 0.3 && S(p).avgPoly >= 1.6) roles.set(p, S(p).medLen >= 72 ? 'pad' : 'chords');
    for (const p of live) if (!roles.has(p) && S(p).median < 50 && S(p).medLen >= 96) roles.set(p, 'pad');     // a drone under the bass line
    const named = (p) => /vocal|vox|voice|melody|singer|sing\b/i.test(p.name) && !/backing|choir|harmony/i.test(p.name);
    const salience = (p) => S(p).count * Math.sqrt(S(p).coverage + 0.05) * (S(p).median / 72) * Math.sqrt(Math.min(1, S(p).medLen / 24)) * (0.3 + S(p).moves)
      * ([8, 7, 10, 9].includes(family(p)) ? 1.3 : [5, 6, 11].includes(family(p)) ? 0.6 : 1) * (named(p) ? 6 : 1);
    const melodies = live.filter((p) => !roles.has(p) && S(p).median >= 55).sort((a, b) => salience(b) - salience(a));
    if (melodies[0]) roles.set(melodies[0], 'lead');
    for (const p of live) {
      if (roles.has(p)) continue;
      if (S(p).medLen <= 12 && S(p).count >= 32) roles.set(p, 'arp');
      else if (S(p).chordy >= 0.3) roles.set(p, S(p).medLen >= 72 ? 'pad' : 'chords');
      else roles.set(p, 'lead');                       // another line over the first: a second lead
    }
    return roles;
  }

  /* slurs: a note that ends 1..SLUR_MAX ticks after a later note of its part starts is slurred into that note (it gets `tie` and is cut there) */
  function slurCandidates(notes) {                       // [note, onset it would be cut at]
    const onsets = sortedUnique(notes.map((n) => n.t)), cuts = [];
    for (const n of notes) {
      const e = n.t + n.len, s = onsetBefore(onsets, n.t, e);
      if (s !== undefined && e - s <= SLUR_MAX) cuts.push([n, s]);
    }
    return cuts;
  }
  function detectSlurs(notes, monoOnly) {
    const cuts = slurCandidates(notes);
    if (!cuts.length) return 0;
    if (monoOnly) {                                      // a part that is a single line apart from these overlaps
      const cut = new Map(cuts.map(([n, s]) => [n, s - n.t]));
      if (maxAtOnce(notes, (n) => (cut.has(n) ? cut.get(n) : n.len)) > 1) return 0;
    }
    for (const [n, s] of cuts) { n.tie = true; n.len = s - n.t; }
    return cuts.length;
  }
  /* voices a part needs: notes sounding at once, not counting the last few ticks of a note that runs into the next one's start */
  function voicesOf(notes) {
    const cut = new Map(slurCandidates(notes).map(([n, s]) => [n, s - n.t]));
    return maxAtOnce(notes, (n) => (cut.has(n) ? cut.get(n) : n.len));
  }
  /* the wheel in force at each note and the changes during it -> the note's `bend` (C3 steps of 24/256 semitone, -128..127) */
  function bendsFrom(part, notes) {
    const wheel = part.bends;
    if (!wheel || !wheel.length) return 0;
    const range = part.bendRange || 2, steps = (v) => clamp(Math.round(v / 8192 * range * 256 / 24), -128, 127);
    const sorted = wheel.slice().sort((a, b) => a.t - b.t);
    let count = 0;
    const onsets = sortedUnique(notes.map((n) => n.t));
    for (const n of notes) {
      let lo = 0, hi = sorted.length;                   // the last wheel event at or before the note's start
      while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m].t <= n.t) lo = m + 1; else hi = m; }
      const before = lo > 0 ? steps(sorted[lo - 1].v) : 0, out = [];
      if (before) out.push([0, before]);
      const next = onsetAfter(onsets, n.t), stop = next === undefined ? n.t + n.len : next;      // the same limit the builder uses: bends before the next note starts
      let lastValue = before, lastDt = -1;
      for (let i = lo; i < sorted.length && sorted[i].t < stop; i++) {
        const u = steps(sorted[i].v), dt = sorted[i].t - n.t;
        if (u === lastValue) continue;
        if (dt === lastDt) out[out.length - 1][1] = u; else out.push([dt, u]);
        lastValue = u; lastDt = dt;
      }
      if (out.length) { n.bend = out; count++; }
    }
    return count;
  }

  /* opts: { name (file name), banks (SF3Data banks: validates this editor's own programs and tells kits), catalog (SF3Catalog.build result: where
   * Capcom plays each instrument), suggest (role, gmProgram) -> { bank, program, volume, expression, pan, echo } (default SF3Catalog.suggest, else a built-in
   * copy of the arranger's), echo: false (no echo devices), octave: false (no octave fitting) } */
  function toProject(midi, opts) {
    opts = opts || {};
    if (!midi || !midi.parts || !midi.parts.length) throw new Error('The MIDI file has no notes.');
    const ours = !!midi.ours, banks = opts.banks || null, catalog = opts.catalog || null;
    const suggestFn = opts.suggest || catalogSuggest() || fallbackSuggest;
    const suggest = (role, gm) => { try { const s = suggestFn(role, gm); if (s && typeof s.program === 'number') return s; } catch (e) { /* fall back */ } return fallbackSuggest(role, gm); };
    const kitOf = (bank, program) => {                    // from the game's data when given, else bank 0's kits as 02_DRIVER.md lists them
      const known = (banks && banks[bank] && banks[bank][program]) || (catalog && catalog.programs && catalog.programs[`${bank}:${program}`]);
      return known ? !!known.kit : bank === 0 && GAME_KITS.includes(program);
    };
    const rangeOf = (program) => { const e = catalog && catalog.programs && catalog.programs[`0:${program}`]; return e && e.range && isFinite(e.range.low) ? e.range : null; };

    /* tempo: the value at tick 0 (the last one written there), else 120; every later change once, as the file has it */
    let bpm = 120;
    const changes = [];
    for (const c of midi.tempo.slice().sort((a, b) => a.t - b.t)) {
      const v = round2(c.bpm);
      if (c.t <= 0) bpm = v;
      else if (changes.length && changes[changes.length - 1].t === c.t) changes[changes.length - 1].bpm = v;
      else changes.push({ t: c.t, bpm: v });
    }
    const tempoChanges = changes.filter((c, i) => c.bpm !== (i ? changes[i - 1].bpm : bpm));

    let bars = Math.max(1, Math.ceil((ours ? Math.max(midi.lengthTicks, midi.endTicks || 0) : midi.lengthTicks) / BAR));
    /* markers: loopStart / loopEnd are the loop, the rest are sections */
    let loopStart = null, loopEnd = null;
    const sections = [], seenBar = new Set();
    for (const m of midi.markers || []) {
      const text = (m.text || '').trim(), low = text.toLowerCase().replace(/[\s_-]/g, '');
      if (low === 'loopstart') { if (loopStart === null) loopStart = m.t; }
      else if (low === 'loopend') { if (loopEnd === null) loopEnd = m.t; }
      else if (text) { const bar = Math.floor(m.t / BAR) + 1; if (!seenBar.has(bar)) { seenBar.add(bar); sections.push({ bar, name: text }); } }
    }
    let loop = { on: true, startBar: 1, endBar: bars, start: 0, end: bars * BAR };
    if (loopStart !== null || loopEnd !== null) {
      const s = loopStart !== null ? loopStart : 0, e = loopEnd !== null ? loopEnd : bars * BAR;
      if (e > s) {
        bars = Math.max(bars, Math.ceil(e / BAR));
        loop = { on: true, startBar: Math.floor(s / BAR) + 1, endBar: Math.max(Math.floor(s / BAR) + 1, Math.ceil(e / BAR)), start: s, end: e };
      }
    }
    const ks = (midi.keySignatures || [])[0];
    const key = ks ? { root: tonicOf(ks.sf, ks.minor), scale: ks.minor ? 'minor' : 'major' } : null;
    const stem = (opts.name || '').replace(/\.midi?$/i, '');
    const name = (ours && midi.title) || stem || midi.title || 'MIDI song';
    const comment = (midi.texts || []).filter((x) => x.t === 0 && x.text && !x.text.includes(MARK)).map((x) => x.text).join('\n').slice(0, 1000);

    const roles = guessRoles(midi.parts, Math.max(BAR, midi.lengthTicks));
    const info = {};
    const parts = midi.parts.map((src, idx) => {
      const id = `p${idx + 1}`;
      let notes = src.notes.map((n) => ({ t: n.t, n: n.n, v: n.v, len: n.len }));
      const role = roles.get(src) || 'lead';
      let bank = 0, program = 0, volume, expression, pan, transpose = 0, tune = 0;
      const automation = {};
      const own = ours && src.program !== null && (!banks || (banks[(src.bank || 0) & 0x0F] && banks[(src.bank || 0) & 0x0F][src.program & 0x7F]));
      let sug = null;
      if (own) {
        bank = (src.bank || 0) & 0x0F; program = src.program & 0x7F;
        volume = src.volume !== null ? src.volume : 80; pan = src.pan !== null ? src.pan : 64; expression = src.expression !== null ? src.expression : 100;
        tune = src.tune || 0;
        /* later volume, pan and expression messages and program changes become lanes (the first of each is the part's own value) */
        const seen = { 7: 0, 10: 0, 11: 0 }, field = { 7: 'volume', 10: 'pan', 11: 'expression' };
        for (const c of src.controls) {
          if (c.c === 64) continue;
          if (seen[c.c]++ === 0) continue;
          (automation[field[c.c]] = automation[field[c.c]] || []).push({ t: c.t, v: c.v });
        }
        for (const c of src.programChanges) {
          const point = { t: c.t, v: c.program & 0x7F };
          if (c.bank !== null && (c.bank & 0x0F) !== bank) point.bank = c.bank & 0x0F;
          (automation.program = automation.program || []).push(point);
        }
      } else {
        sug = suggest(role, src.program === null ? -1 : src.program);
        bank = sug.bank | 0; program = sug.program | 0;
        volume = sug.volume; expression = sug.expression; pan = sug.pan;
        if (src.drums) {                                  // GM drum keys onto the game's kit 6; two keys landing on one hit at one tick play once, at the louder velocity
          bank = 0; program = 6;
          const at = new Map();
          for (const n of notes) {
            const k = drumToKit6(n.n), id2 = `${n.t}:${k}`;
            if (at.has(id2)) at.get(id2).v = Math.max(at.get(id2).v, n.v); else { n.n = k; at.set(id2, n); }
          }
          notes = Array.from(at.values());
        }
      }
      const isKit = own && kitOf(bank, program);
      const finalRole = isKit ? 'drums' : role;
      if (!src.drums && !isKit) detectSlurs(notes, !own);
      /* octave: a bass goes where Capcom's basses sit; others only when most of the part is far outside where Capcom plays the instrument */
      if (!own && !src.drums && opts.octave !== false) {
        const sorted = notes.map((n) => n.n).sort((a, b) => a - b), med = sorted[sorted.length >> 1];
        if (finalRole === 'bass') { let k = 0; while (med + k < 40) k += 12; while (med + k > 52) k -= 12; transpose = k; }
        else {
          const r = rangeOf(program);
          if (r) { const away = (m) => (m < r.low ? r.low - m : m > r.high ? m - r.high : 0); let k = 0; while (away(med + k) > 15 && Math.abs(k) < 36) k += med + k < r.low ? 12 : -12; transpose = k; }
        }
      }
      if (!src.drums) bendsFrom(src, notes);
      notes.sort((a, b) => a.t - b.t || a.n - b.n);
      const poly = voicesOf(notes);
      info[id] = { track: src.track, channel: src.channel, gmProgram: src.program, gmName: src.programName, notes: src.notes.length };
      return {
        id, name: src.name, role: finalRole, color: null, bank, program,
        volume: clamp(Math.round(volume), 0, 127), expression: clamp(Math.round(expression), 0, 127), pan: clamp(Math.round(pan), 0, 127),
        transpose, gain: 0, tune, voices: clamp(poly, 1, ours ? 16 : 4), mute: false, solo: false, track: null, loopShift: 0, end: null, legato: false,
        vibrato: { depth: 0, rate: 100, sync: true, delay: 0, tremolo: 0 }, layer: null, notes, automation, devices: [], raw: [], _sug: sug,
      };
    });
    /* echoes the way Capcom's themes use them, while the 16 driver tracks last */
    let tracksUsed = parts.reduce((a, p) => a + p.voices, 0);
    if (!ours && opts.echo !== false) {
      for (const role of ['lead', 'chords', 'pad', 'arp']) for (const p of parts) {
        if (p.role !== role || !p._sug || !p._sug.echo || tracksUsed + p.voices > 16) continue;
        p.devices.push({ type: 'echo', on: true, delay: p._sug.echo.delay, level: p._sug.echo.level, pan: 'opposite', interval: 0, repeats: 1 });
        tracksUsed += p.voices;
      }
    }
    for (const p of parts) delete p._sug;
    return {
      format: 'sf3project', version: 2, name, author: midi.copyright || '', comment, bpm, tempoChanges, bars, length: null, loop, markerBars: 2, markers: null, tempoPart: null,
      leadIn: 2, loopRestore: true, autoTune: true, key, sections, chorusBar: null, parts, bank: null, names: {},
      ui: { import: { source: opts.name || null, ours, format: midi.format, parts: info } },
    };
  }

  const api = { parse, write, fromProject, toProject, guessRoles, drumToKit6, gmName, GM_NAMES, GM_DRUM_KITS, MARK, SLUR_MAX, TPB };
  g.SF3Midi = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
