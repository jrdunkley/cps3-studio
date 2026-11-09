/* Independent SMF framing oracle. Remove SysEx only, preserving elapsed ticks.
 * Explicit channel status in the output avoids introducing running-status state.
 * No production MIDI code is used here. */
'use strict';
module.exports = function withoutSysEx(input) {
  const b = Buffer.from(input), chunks = []; let pos = 0, count = 0, tracks = 0;
  if (b.length < 14 || b.toString('ascii', 0, 4) !== 'MThd') throw Error('Missing SMF header');
  const trackCount = b.readUInt16BE(10);
  const encode = n => { const a = [n % 128]; while ((n = Math.floor(n / 128))) a.unshift((n % 128) | 128); return a; };
  while (pos < b.length) {
    if (pos + 8 > b.length) throw Error('Truncated chunk');
    const tag = b.toString('ascii', pos, pos + 4), len = b.readUInt32BE(pos + 4), start = pos + 8, end = start + len;
    if (end > b.length) throw Error('Truncated chunk body');
    if (tag !== 'MTrk') { chunks.push(b.subarray(pos, end)); pos = end; continue; }
    let cursor = start, running = 0, elapsed = 0; const events = [];
    const byte = () => { if (cursor >= end) throw Error('Truncated event'); return b[cursor++]; };
    const number = () => { let n = 0; for (let i = 0; i < 4; i++) { const v = byte(); n = n * 128 + (v & 127); if (!(v & 128)) return n; } throw Error('Invalid VLQ'); };
    const body = n => { if (cursor + n > end) throw Error('Truncated event body'); const a = Array.from(b.subarray(cursor, cursor + n)); cursor += n; return a; };
    while (cursor < end) {
      elapsed += number();
      let status = b[cursor];
      if (status & 128) { byte(); if (status < 240) running = status; }
      else { status = running; if (!status) throw Error('Missing status'); }
      if (status === 240 || status === 247) { body(number()); count++; running = 0; continue; }
      let event;
      if (status === 255) { const type = byte(), size = number(); event = [255, type, ...encode(size), ...body(size)]; running = 0; }
      else if (status >= 128 && status < 240) event = [status, ...body((status >> 4) === 12 || (status >> 4) === 13 ? 1 : 2)];
      else throw Error('Unsupported system event');
      events.push(...encode(elapsed), ...event); elapsed = 0;
    }
    if (elapsed) events.push(...encode(elapsed), 255, 47, 0);
    const header = Buffer.alloc(8); header.write('MTrk'); header.writeUInt32BE(events.length, 4);
    chunks.push(header, Buffer.from(events)); pos = end;
    if (++tracks === trackCount) break; // Some files have non-SMF padding after the declared tracks.
  }
  return { bytes: Buffer.concat(chunks), count };
};
