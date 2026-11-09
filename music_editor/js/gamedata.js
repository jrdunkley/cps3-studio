/* Read the game's sound tables out of the engine's ROM image: the request table, the music
 * sequences, the sample table and the instrument banks (layouts: the research project's 
 * sound_sequence_evidence.py and the driver's note handler at 0613AFC2).
 *
 * Instrument bank table 06788000: 16 pointers. A bank starts with 128 u16 offsets (0 = no program);
 * a program is a list of 12-byte regions ended by 0xFF: [0] highest key, [1] pan (0xFF = use the
 * track's), [2] level trim, [4..5] sample number, [6] fine tune, [7..11] envelope.
 * Sample table 0678C000: 16-byte entries of start, loop, end, root key.
 */
(function (g) {
  'use strict';
  const Seq = g.SF3Seq || require('./seq.js');
  const REQ_TABLE = 0x0678F000, SAMPLE_TABLE = 0x0678C000, BANKS = 0x06788000, BASE = 0x06000000;

  function load(engine, names) {
    const rom = engine.rom;
    const u8 = (a) => rom[a - BASE], u16 = (a) => (rom[a - BASE] << 8) | rom[a - BASE + 1];
    const u32 = (a) => ((rom[a - BASE] << 24) | (rom[a - BASE + 1] << 16) | (rom[a - BASE + 2] << 8) | rom[a - BASE + 3]) >>> 0;
    const count = u16(REQ_TABLE);
    const offsets = [];
    for (let c = 0; c < count; c++) offsets.push(u32(REQ_TABLE + 4 + 4 * c));
    const sorted = Array.from(new Set(offsets.filter((o) => o))).sort((a, b) => a - b);
    const next = new Map(sorted.map((o, i) => [o, sorted[i + 1] || 0]));
    const requests = [];
    for (let c = 0; c < count; c++) if (offsets[c]) requests.push({ code: c, kind: u8(REQ_TABLE + offsets[c]) });

    const samples = [];
    for (let i = 0; i < (REQ_TABLE - SAMPLE_TABLE) / 16; i++) {
      const a = SAMPLE_TABLE + 16 * i;
      const start = u32(a), loop = u32(a + 4), end = u32(a + 8), root = u32(a + 12);
      if (start === 0 && end === 0) continue;
      samples[i] = { index: i, start, loop, end, root, looped: loop !== end };
    }

    const banks = [];
    for (let b = 0; b < 16; b++) {
      const base = u32(BANKS + 4 * b), programs = [];
      for (let p = 0; p < 128; p++) {
        const off = u16(base + 2 * p);
        if (!off) continue;
        const regions = [];
        for (let a = base + off; u8(a) !== 0xFF && regions.length < 128; a += 12) {
          const level = u8(a + 2);
          regions.push({ keyHigh: u8(a), pan: u8(a + 1), level: level > 127 ? level - 256 : level, sample: u16(a + 4) & 0x7FFF,
                         flag: u16(a + 4) >> 15, fine: (u8(a + 6) << 24) >> 24, envelope: [u8(a + 7), u8(a + 8), u8(a + 9), u8(a + 10), u8(a + 11)] });
        }
        /* the driver takes the first region whose highest key is not below the note */
        let top = -1;
        for (const r of regions) { r.keyLow = top + 1; r.reachable = r.keyHigh > top; top = Math.max(top, r.keyHigh); }
        const live = regions.filter((r) => r.reachable);
        const narrow = live.filter((r) => r.keyHigh - r.keyLow < 3).length;
        programs[p] = { bank: b, program: p, regions, live,
                        kit: live.length > 1 && narrow * 2 >= live.length,                 // a different sound on each key
                        sustained: live.some((r) => samples[r.sample] && samples[r.sample].looped) };
      }
      banks.push(programs);
    }

    const songs = [];
    for (const r of requests) {
      if (r.kind !== 0) continue;
      const off = offsets[r.code], end = next.get(off);
      if (!end) continue;
      const addr = REQ_TABLE + off;
      const bytes = rom.slice(addr - BASE, REQ_TABLE + end - BASE);
      songs.push({ code: r.code, name: (names && names[r.code]) || `Music ${r.code}`, addr, bytes });
    }
    return { count, offsets, requests, samples, banks, songs };
  }

  /* What a song uses: tempo, loop, per-track instruments and note ranges. */
  function describe(song) {
    const seq = Seq.decompile(song.bytes);
    const tracks = [];
    let tempo = 0, loopLength = 0, loopStart = 0, marks = [], firstNote = Infinity;
    seq.tracks.forEach((events, k) => {
      if (!events) return;
      const f = Seq.follow(events);
      const lines = f.controls.filter((c) => c.op === 0xE8 && c.a[0] === 0 && c.a[1] === 1).map((c) => c.t);
      if (lines.length > marks.length) marks = lines;
      if (f.notes.length) firstNote = Math.min(firstNote, f.notes[0].t);
      let bank = 0, program = 0;
      const used = new Map();
      const controls = f.controls.slice().sort((a, b) => a.t - b.t);
      let ci = 0;
      for (const note of f.notes) {
        while (ci < controls.length && controls[ci].t <= note.t) {
          const c = controls[ci++];
          if (c.op === 0xC2) bank = c.a[0] & 0x0F;
          if (c.op === 0xC4) program = c.a[0] & 0x7F;
        }
        const key = bank * 128 + program;
        if (!used.has(key)) used.set(key, { bank, program, low: note.n, high: note.n, notes: 0 });
        const u = used.get(key);
        u.low = Math.min(u.low, note.n); u.high = Math.max(u.high, note.n); u.notes++;
      }
      for (const c of f.controls) if (c.op === 0xC1) tempo = tempo || ((c.a[0] << 8) | c.a[1]);
      if (f.loop && f.loop.length > loopLength) { loopLength = f.loop.length; loopStart = f.loop.start; }
      tracks.push({ track: k, events: events.length, notes: f.notes.length, instruments: Array.from(used.values()), loop: f.loop, end: f.end });
    });
    /* phrase lines the song posts (E8 0 1): the first one is the first beat, the rest are phrase ends */
    const gaps = marks.slice(1).map((t, i) => t - marks[i]);
    const gap = gaps.length ? Math.min(...gaps) : 0;
    const lead = (marks.length ? marks[0] : (firstNote === Infinity ? 0 : firstNote)) % Seq.BAR;   // ticks before the first beat
    return { seq, tracks, tempo, bpm: Seq.tempoToBpm(tempo), loopStart, loopLength, bars: loopLength / Seq.BAR,
             markers: { first: marks.length ? marks[0] : 0, gap }, lead };
  }

  const api = { load, describe };
  g.SF3Data = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
