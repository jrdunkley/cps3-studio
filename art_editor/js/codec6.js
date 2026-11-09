/* Six-bit CPS3 DMA. Pair values are semantic bytes, never recursive tokens. */
(function(g) {
  'use strict';
  function decode(source, table, length, maxOutput = length + 63, collectReads = false) {
    if (!(source instanceof Uint8Array) || !(table instanceof Uint8Array) || table.length !== 256 || !Number.isSafeInteger(length) || length <= 0 || !Number.isSafeInteger(maxOutput) || maxOutput < length) throw new Error('Positive upload length and a 256-byte pair table required.');
    const out = new Uint8Array(maxOutput), positions = collectReads ? new Set() : null; let p = 0, n = 0, last = 0, tableReads = 0;
    while (n < length) {
      if (p >= source.length) throw new Error('Compressed upload is truncated.');
      const token = source[p++], pair = !!(token & 128), at = (token & 127) * 2;
      for (let k = 0; k < (pair ? 2 : 1); k++) {
        const v = pair ? table[at + k] : token;
        if (pair) { tableReads++; if (positions) positions.add(at+k); }
        const count = v & 64 ? (v & 63) + 1 : 1, pen = v & 64 ? last & 63 : v;
        if (!(v & 64)) last = v;
        if (n + count > maxOutput) throw new Error('Upload exceeds output capacity including its RLE tail.');
        out.fill(pen, n, n + count); n += count;
        if (n >= length) break;
      }
    }
    return { pixels: out.slice(0, n), sourceConsumed: p, tableReads, ...(positions ? {tablePositions:[...positions].sort((a,b)=>a-b)} : {}) };
  }
  function check(pixels) { if (!(pixels instanceof Uint8Array) || !pixels.length || pixels.some(p => p > 63)) throw new Error('Nonempty six-bit pens (0..63) required.'); }
  /* Exact shortest parse for a fixed table, restricted to Capcom's stock
     grammar (the only grammar proven on a real board):
       - the first element is a literal (no implicit initial pen);
       - a run never directly follows a run, inside a pair or across tokens
         (0 of 12,286,315 stock runs do; on a physical CPS3 a chained
         transparent run paints the tile with its own code's colour, while
         FBNeo/MAME decode it as a continuation);
       - a pair's second element is never left unused at the end;
       - a pair starting with literal 0 never directly follows a direct literal 0
         (the one remaining element transition absent from all stock data).
     With these four rules every element transition is one Capcom's data uses.
     The board report is in the research project (not in this repository). State: 0 = after a literal (or start),
     1 = after a run, 2 = after a direct literal 0. */
  function encodeFixed(pixels, table, requestedLength = pixels.length) {
    check(pixels); if (!(table instanceof Uint8Array) || table.length !== 256) throw new Error('Pair table must be 256 bytes.');
    const n = pixels.length, runs = new Uint32Array(n), INF = 0xffffffff, S = 3;
    const cost = [], choice = [], advance = [], after = [];
    for (let s = 0; s < S; s++) { cost.push(new Uint32Array(n + 1).fill(INF)); choice.push(new Uint8Array(n)); advance.push(new Uint16Array(n)); after.push(new Uint8Array(n)); cost[s][n] = 0; }
    if (!Number.isSafeInteger(requestedLength) || requestedLength <= 0 || requestedLength > n || n > requestedLength + 63) throw new Error('Invalid requested upload length / RLE tail.');
    for (let p = n - 1; p >= 0; p--) runs[p] = 1 + (p + 1 < n && pixels[p] === pixels[p + 1] ? runs[p + 1] : 0);
    const lists = Array.from({ length: 64 }, () => []), runPairs = [];
    for (let t = 0; t < 128; t++) { const v = table[t * 2], w = table[t * 2 + 1]; if (v & 64) { if (!(w & 64)) runPairs.push(t); } else if (v < 64) lists[v].push(t); }
    for (let p = requestedLength - 1; p >= 0; p--) {
      const last = p ? pixels[p - 1] : -1, pen = pixels[p];
      for (let r = 0; r < S; r++) {
        let best = INF, token = pen, step = 0, next = 0;
        const offer = (t, k, r2) => { const e = p + k; if (e > n || (e >= requestedLength && e !== n) || cost[r2][e] === INF) return; if (cost[r2][e] + 1 < best) { best = cost[r2][e] + 1; token = t; step = k; next = r2; } };
        offer(pen, 1, pen === 0 ? 2 : 0);
        const canRun = r !== 1 && p > 0 && pen === last;
        if (canRun) for (let k = 1, end = Math.min(64, runs[p]); k <= end; k++) offer(63 + k, k, 1);
        if (!(r === 2 && pen === 0)) for (const t of lists[pen]) {   // literal pen, then a used second element
          const w = table[t * 2 + 1], j = p + 1; if (j >= requestedLength) continue;
          if (w & 64) { const k = (w & 63) + 1; if (pixels[j] === pen && runs[j] >= k) offer(128 + t, 1 + k, 1); }
          else if (pixels[j] === w) offer(128 + t, 2, 0);
        }
        if (canRun) for (const t of runPairs) {   // run of the previous pen, then a used literal
          const k = (table[t * 2] & 63) + 1, w = table[t * 2 + 1], j = p + k;
          if (runs[p] >= k && j < requestedLength && pixels[j] === w) offer(128 + t, k + 1, 0);
        }
        cost[r][p] = best; choice[r][p] = token; advance[r][p] = step; after[r][p] = next;
      }
    }
    if (cost[0][0] === INF) throw new Error('Intended RLE tail cannot be encoded with this pair table in stock grammar.');
    const source = new Uint8Array(cost[0][0]); for (let p = 0, o = 0, r = 0; p < n;) { source[o++] = choice[r][p]; const s = advance[r][p]; r = after[r][p]; p += s; }
    return { source, table: table.slice(), decodedLength: n, optimal: true };
  }
  /* Stock-grammar census of one upload: every element transition must occur in
     Capcom's data. Returns the list of faults (empty = hardware-proven grammar). */
  function grammarFaults(source, table, length) {
    const faults = []; let p = 0, n = 0, prev = 'start';
    while (n < length) {
      if (p >= source.length) { faults.push('truncated'); break; }
      const token = source[p++], pair = !!(token & 128), at = (token & 127) * 2;
      for (let k = 0; k < (pair ? 2 : 1); k++) {
        const v = pair ? table[at + k] : token, run = !!(v & 64);
        if (run && prev === 'start') faults.push('run-first@' + (p - 1));
        if (run && prev === 'run') faults.push('run-after-run@' + (p - 1));
        if (pair && k === 0 && v === 0 && prev === 'direct0') faults.push('direct0-then-pair0@' + (p - 1));
        n += run ? (v & 63) + 1 : 1; prev = run ? 'run' : (!pair && v === 0 ? 'direct0' : 'literal');
        if (n >= length) { if (pair && k === 0) faults.push('unused-pair-second@' + (p - 1)); break; }
      }
    }
    return faults;
  }
  /* Free-table construction is deterministic frequency selection followed by
     the exact fixed-table parser. Table selection itself is not globally optimal.
     Long runs re-establish their pen (pen, run, pen, run) as Capcom's data does. */
  function encode(pixels, requestedLength = pixels.length) {
    check(pixels); const tokens = []; let last = -1;
    for (let p = 0; p < pixels.length;) {
      const pen = pixels[p]; if (pen !== last || tokens[tokens.length - 1] >= 64) { tokens.push(pen); last = pen; p++; }
      else { let k = 1; while (k < 64 && p + k < pixels.length && pixels[p + k] === pen) k++; tokens.push(63 + k); p += k; }
    }
    const frequency = new Map(); for (let i = 0; i + 1 < tokens.length; i++) { const pair = tokens[i] * 256 + tokens[i + 1]; frequency.set(pair, (frequency.get(pair) || 0) + 1); }
    const pairs = [...frequency].sort((a,b) => b[1] - a[1] || a[0] - b[0]).slice(0,128), table = new Uint8Array(256);
    pairs.forEach(([v],i) => { table[2*i] = v >>> 8; table[2*i+1] = v & 255; });
    return { ...encodeFixed(pixels, table, requestedLength), optimal: false, parseOptimal: true };
  }
  const api = { decode, encode, encodeFixed, grammarFaults }; g.ArtCodec6 = api; if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
