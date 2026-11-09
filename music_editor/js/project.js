/* Editor projects: made from a MIDI file or from a piece of game music, built into a sequence,
 * and written out as the song file a ROM build installs. No page code here, so the same
 * functions run in the checks under Node.
 *
 * project: { name, bpm, tempoChanges:[{t,bpm}], bars, loop:{ on, startBar, endBar }, markerBars: 0|2|4,
 *            parts:[{ name, notes:[{t,n,v,len, bank?,program?,volume?,expression?,pan?}], polyphony,
 *                     bank, program, volume, pan, expression, transpose, voices, mute }] }
 * Note times are in ticks from the first beat, 48 to the beat, 192 to the bar.
 */
(function (g) {
  'use strict';
  const Seq = g.SF3Seq || require('./seq.js');
  const Midi = g.SF3Midi || require('./midi.js');
  const BAR = Seq.BAR;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const MARK = 'sf3music';                      // text put in MIDI this editor writes: programs are the game's

  function fromMidi(name, midi, banks) {
    if (!midi.parts.length) throw new Error('The MIDI file has no notes.');
    const pitched = banks[0].find((x) => x && !x.kit && x.sustained) || banks[0].find((x) => x && !x.kit), kit = banks[0].find((x) => x && x.kit);
    const bars = Math.max(1, Math.ceil(midi.lengthTicks / BAR));
    return {
      name: name.replace(/\.midi?$/i, ''), bpm: midi.tempo.length ? Math.round(midi.tempo[0].bpm * 10) / 10 : 120,
      tempoChanges: midi.tempo.slice(1).filter((c) => c.t > 0), bars,
      loop: { on: true, startBar: 1, endBar: bars }, markerBars: 2,
      parts: midi.parts.map((p) => {
        const own = midi.ours && p.program !== null && banks[p.bank || 0] && banks[p.bank || 0][p.program];
        return { name: p.name + (p.drums && !midi.ours ? ' (drums)' : ''), notes: p.notes, polyphony: p.polyphony,
          bank: own ? (p.bank || 0) : 0, program: own ? p.program : ((p.drums ? kit : pitched) || { program: 0 }).program,
          volume: own && p.volume !== null ? p.volume : 80, pan: own && p.pan !== null ? p.pan : 64, expression: own && p.expression !== null ? p.expression : 100,
          transpose: 0, voices: clamp(p.polyphony, 1, 4), mute: false };
      }),
    };
  }

  /* An editable copy of a piece of game music: its introduction and one pass of its loop.
   * info = SF3Data.describe(song). Pitch bends, detune and vibrato settings are not carried over. */
  function fromGame(song, info) {
    const end = info.loopLength ? info.loopStart + info.loopLength : Math.max(...info.tracks.map((t) => t.end || 0));
    const lead = info.lead, parts = [];
    info.seq.tracks.forEach((events, k) => {
      if (!events) return;
      const f = Seq.follow(events, end - 1, true);
      const st = { bank: 0, program: 0, volume: 0, expression: 64, pan: 64 };
      const controls = f.controls.slice().sort((a, b) => a.t - b.t);
      let ci = 0, part = null;
      for (const n of f.notes) {
        while (ci < controls.length && controls[ci].t <= n.t) {
          const c = controls[ci++];
          if (c.op === 0xC2) st.bank = c.a[0] & 0x0F; else if (c.op === 0xC4) st.program = c.a[0] & 0x7F;
          else if (c.op === 0xC6) st.volume = c.a[0] & 0x7F; else if (c.op === 0xC8) st.expression = c.a[0] & 0x7F;
          else if (c.op === 0xC7) st.pan = c.a[0] & 0x7F;
        }
        if (!part) part = Object.assign({ name: `Track ${k + 1}`, notes: [], polyphony: 1, transpose: 0, voices: 1, mute: false }, st);
        const note = { t: Math.max(0, n.t - lead), n: n.n, v: n.v * 2, len: n.len };
        for (const field of ['bank', 'program', 'volume', 'expression', 'pan']) if (st[field] !== part[field]) note[field] = st[field];
        part.notes.push(note);
      }
      if (part) parts.push(part);
    });
    const loopStart = info.loopLength ? Math.max(0, info.loopStart - lead) : 0;
    const bars = Math.max(1, Math.ceil((end - lead) / BAR));
    return { name: song.name + ' (copy)', bpm: Math.round(info.bpm * 10) / 10, tempoChanges: [], bars,
             loop: { on: !!info.loopLength, startBar: Math.floor(loopStart / BAR) + 1, endBar: bars },
             markerBars: info.markers.gap === 768 ? 4 : info.markers.gap ? 2 : 0, parts };
  }

  function build(project) {
    const loop = project.loop.on ? { start: (project.loop.startBar - 1) * BAR, end: project.loop.endBar * BAR } : null;
    if (loop && loop.end <= loop.start) throw new Error('The loop must end after it starts.');
    const built = Seq.buildTracks({ bpm: project.bpm, tempoChanges: project.tempoChanges, lengthTicks: project.bars * BAR, loop,
                                    markerBars: Number(project.markerBars), parts: project.parts });
    return { bytes: Seq.compile({ tracks: built.tracks }), report: built.report, loop };
  }

  function base64(bytes) {
    if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }

  /* the song file a ROM build installs */
  function songFile(project, built, names) {
    return { format: 'sf3song', version: 1, name: project.name, bpm: project.bpm, bytes: built.bytes.length, sequence_b64: base64(built.bytes),
      loop_ticks: built.loop ? [built.loop.start, built.loop.end] : null, marker_bars: Number(project.markerBars),
      tracks: built.report.tracks.map((t) => ({ track: t.track + 1, part: t.part.name, bank: t.part.bank, program: t.part.program, notes: t.notes })),
      names: names || {}, project };
  }

  /* a piece of game music as MIDI: its introduction and `passes` passes of its loop */
  function gameMidi(song, info, passes) {
    const end = info.loopLength ? info.loopStart + (passes || 2) * info.loopLength : 400000;
    const tracks = [];
    info.seq.tracks.forEach((events, k) => {
      if (!events) return;
      const f = Seq.follow(events, end - 1, true), out = [];
      for (const c of f.controls) {
        if (c.op === 0xC4) out.push({ t: c.t, kind: 'program', value: c.a[0] });
        else if (c.op === 0xC2) out.push({ t: c.t, kind: 'cc', controller: 0, value: c.a[0] });
        else if (c.op === 0xC6) out.push({ t: c.t, kind: 'cc', controller: 7, value: c.a[0] });
        else if (c.op === 0xC7) out.push({ t: c.t, kind: 'cc', controller: 10, value: c.a[0] });
        else if (c.op === 0xC8) out.push({ t: c.t, kind: 'cc', controller: 11, value: c.a[0] });
      }
      for (const n of f.notes) out.push({ t: n.t, kind: 'note', n: n.n, v: n.v * 2, len: n.len });
      tracks.push({ name: `Track ${k + 1}`, channel: k, events: out });
    });
    return Midi.write({ bpm: info.bpm, tracks, text: MARK });
  }

  const api = { fromMidi, fromGame, build, songFile, gameMidi, MARK };
  g.SF3Project = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
