/* FROZEN COPY of js/midi.js as it was before package A10 (2026-10-01 22:09, 8302 bytes, sha256 0897335624acebd7c11df49a3048df1266d7519a737f1483996b470f43dd0eec; only this comment added).
 * checks/gates/g_midi.js (G16) runs it beside the live module and requires the same results on every present input.
 * Never edit this file; it is the yardstick. It is loaded with a private global object so it does not replace SF3Midi. */
/* Standard MIDI files: read one into parts for the editor, and write the game's songs out.
 * Times are converted to the game's 48 ticks per beat.
 */
(function (g) {
  'use strict';
  const TPB = 48;

  function parse(bytes) {
    let p = 0;
    const u32 = () => { const v = ((bytes[p] << 24) | (bytes[p + 1] << 16) | (bytes[p + 2] << 8) | bytes[p + 3]) >>> 0; p += 4; return v; };
    const u16 = () => { const v = (bytes[p] << 8) | bytes[p + 1]; p += 2; return v; };
    const tag = () => { const s = String.fromCharCode(bytes[p], bytes[p + 1], bytes[p + 2], bytes[p + 3]); p += 4; return s; };
    const vlq = () => { let v = 0, c; do { c = bytes[p++]; v = v * 128 + (c & 0x7F); } while (c & 0x80); return v; };
    if (tag() !== 'MThd') throw new Error('This is not a MIDI file.');
    const headerLength = u32(), format = u16(), trackCount = u16(), division = u16();
    p += headerLength - 6;
    if (division & 0x8000) throw new Error('This MIDI file uses SMPTE time; save it with beats (PPQ) timing instead.');
    const toTick = (t) => Math.round(t * TPB / division);
    const parts = new Map(), tempo = [];
    let lengthTicks = 0, timeSignature = null, ours = false;
    for (let ti = 0; ti < trackCount && p < bytes.length; ti++) {
      if (tag() !== 'MTrk') throw new Error('The MIDI file is damaged (missing track).');
      const chunkLength = u32(), end = p + chunkLength;
      let t = 0, status = 0, trackName = '';
      const open = new Map();
      const part = (ch) => {
        const key = ti * 16 + ch;
        if (!parts.has(key)) parts.set(key, { track: ti, channel: ch, name: '', program: null, bank: null, volume: null, pan: null, expression: null, notes: [],
                                              bends: [], bendRange: 2, controls: [], rpn: [127, 127] });
        return parts.get(key);
      };
      while (p < end) {
        t += vlq();
        let b = bytes[p];
        if (b & 0x80) { status = b; p++; } else b = status;          // running status
        const type = status & 0xF0, ch = status & 0x0F;
        if (status === 0xFF) {
          const meta = bytes[p++], len = vlq();
          if (meta === 0x51 && len === 3) tempo.push({ t: toTick(t), bpm: 60000000 / ((bytes[p] << 16) | (bytes[p + 1] << 8) | bytes[p + 2]) });
          else if (meta === 0x03) {                    // names: UTF-8 when the bytes are UTF-8 (Frédéric), else Latin-1
            const raw = bytes.slice(p, p + len);
            try { trackName = new TextDecoder('utf-8', { fatal: true }).decode(raw).trim(); } catch (e) { trackName = new TextDecoder('latin1').decode(raw).trim(); }
          }
          else if (meta === 0x01 && new TextDecoder('latin1').decode(bytes.slice(p, p + len)).includes('sf3music')) ours = true;
          else if (meta === 0x58 && !timeSignature) timeSignature = [bytes[p], 1 << bytes[p + 1]];
          p += len;
        } else if (status === 0xF0 || status === 0xF7) { p += vlq(); }
        else if (type === 0x90 || type === 0x80) {
          const note = bytes[p++], vel = bytes[p++], key = ch * 128 + note;
          if (type === 0x90 && vel > 0) {
            if (!open.has(key)) open.set(key, []);
            open.get(key).push({ t, v: vel });
          } else if (open.has(key) && open.get(key).length) {
            const on = open.get(key).shift();
            const start = toTick(on.t), len = Math.max(1, toTick(t) - start);
            part(ch).notes.push({ t: start, n: note, v: on.v, len });
            lengthTicks = Math.max(lengthTicks, start + len);
          }
        } else if (type === 0xC0) { const pc = bytes[p++]; if (part(ch).program === null) part(ch).program = pc; }
        else if (type === 0xD0) p += 1;
        else if (type === 0xB0) {                                   // the first bank, volume, pan and expression of a part
          const controller = bytes[p++], value = bytes[p++], x = part(ch);
          const field = { 0: 'bank', 7: 'volume', 10: 'pan', 11: 'expression' }[controller];
          if (field && x[field] === null) x[field] = value;
          /* every volume, pan, expression and sustain change, and the bend range (RPN 0, data entry) */
          if (controller === 7 || controller === 10 || controller === 11 || controller === 64) x.controls.push({ t: toTick(t), c: controller, v: value });
          else if (controller === 101) x.rpn[0] = value; else if (controller === 100) x.rpn[1] = value;
          else if (controller === 6 && x.rpn[0] === 0 && x.rpn[1] === 0 && value > 0) x.bendRange = value;
        }
        else if (type === 0xE0) { part(ch).bends.push({ t: toTick(t), v: ((bytes[p + 1] << 7) | bytes[p]) - 8192 }); p += 2; }   // pitch bend, -8192..8191
        else if (type === 0xA0) p += 2;
        else throw new Error('The MIDI file is damaged (unknown event).');
      }
      p = end;
      for (const part of parts.values()) if (part.track === ti && !part.name) part.name = trackName;
    }
    const list = Array.from(parts.values()).filter((x) => x.notes.length);
    list.forEach((x, i) => {
      x.notes.sort((a, b) => a.t - b.t || a.n - b.n);
      delete x.rpn;
      x.drums = x.channel === 9;
      x.name = x.name || `Track ${x.track + 1}`;
      if (list.filter((y) => y.track === x.track).length > 1) x.name += ` (channel ${x.channel + 1})`;
      /* most notes sounding at once */
      const edges = [];
      for (const n of x.notes) { edges.push([n.t, 1]); edges.push([n.t + n.len, -1]); }
      edges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      let cur = 0, max = 0;
      for (const e of edges) { cur += e[1]; max = Math.max(max, cur); }
      x.polyphony = max;
    });
    tempo.sort((a, b) => a.t - b.t);
    return { format, division, parts: list, tempo, timeSignature, lengthTicks, ours };
  }

  /* song: { bpm, tempoChanges:[{t,bpm}], tracks:[{ name, channel, events:[{t, kind:'note'|'program'|'bank'|'cc', ...}] }] } at 48 ticks per beat */
  function write(song) {
    const chunks = [];
    const vlq = (out, v) => { const d = [v & 0x7F]; v = Math.floor(v / 128); while (v > 0) { d.unshift((v & 0x7F) | 0x80); v = Math.floor(v / 128); } out.push(...d); };
    const track = (events) => {
      const out = [];
      let last = 0;
      events.sort((a, b) => a.t - b.t || a.order - b.order);
      for (const e of events) { vlq(out, Math.max(0, e.t - last)); last = Math.max(last, e.t); out.push(...e.bytes); }
      out.push(0, 0xFF, 0x2F, 0);
      chunks.push([0x4D, 0x54, 0x72, 0x6B, (out.length >>> 24) & 0xFF, (out.length >> 16) & 0xFF, (out.length >> 8) & 0xFF, out.length & 0xFF, ...out]);
    };
    const tempoEvents = [{ t: 0, bpm: song.bpm }].concat(song.tempoChanges || []).map((c) => {
      const us = Math.round(60000000 / c.bpm);
      return { t: c.t, order: 0, bytes: [0xFF, 0x51, 3, (us >> 16) & 0xFF, (us >> 8) & 0xFF, us & 0xFF] };
    });
    tempoEvents.push({ t: 0, order: -1, bytes: [0xFF, 0x58, 4, 4, 2, 24, 8] });
    if (song.text) { const text = Array.from(new TextEncoder().encode(song.text)).slice(0, 100); tempoEvents.push({ t: 0, order: -3, bytes: [0xFF, 0x01, text.length, ...text] }); }
    track(tempoEvents);
    for (const tr of song.tracks) {
      const ch = tr.channel & 0x0F, events = [];
      const name = Array.from(new TextEncoder().encode(tr.name || '')).slice(0, 100);
      events.push({ t: 0, order: -2, bytes: [0xFF, 0x03, name.length, ...name] });
      for (const e of tr.events) {
        if (e.kind === 'note') {
          events.push({ t: e.t, order: 3, bytes: [0x90 | ch, e.n & 0x7F, Math.max(1, Math.min(127, e.v))] });
          events.push({ t: e.t + Math.max(1, e.len), order: 1, bytes: [0x80 | ch, e.n & 0x7F, 0] });
        } else if (e.kind === 'program') events.push({ t: e.t, order: 2, bytes: [0xC0 | ch, e.value & 0x7F] });
        else if (e.kind === 'cc') events.push({ t: e.t, order: 2, bytes: [0xB0 | ch, e.controller & 0x7F, e.value & 0x7F] });
      }
      track(events);
    }
    const n = chunks.length;
    const head = [0x4D, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, (n >> 8) & 0xFF, n & 0xFF, (TPB >> 8) & 0xFF, TPB & 0xFF];
    return Uint8Array.from(head.concat(...chunks));
  }

  const api = { parse, write, TPB };
  g.SF3Midi = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
