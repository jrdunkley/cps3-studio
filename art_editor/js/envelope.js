/* The board envelope (gate AGH): a delivered ROM may ask the CPS3 only for what the stock game
 * already asks of it.  Derived from the user's own ROM at run time; no ROM data lives here.
 *
 * Every changed byte must belong to a structure the Studio knows (sprite index row, sprite
 * record, sprite stream, animation frame call, palette row, stage tile stream, stage map) and
 * obey that structure's stock envelope:
 *   records   field values inside the stock ranges (flags, capacity, chunk and cell counts,
 *             allocation, cell shapes and attribute bits, pair tables, source address forms);
 *   streams   six-bit streams use literals, runs and pair tokens only where Fightcade (FBNeo),
 *             MAME and the open FPGA core (jtcps3_chardma.v) write the same pens: no run may
 *             cross the requested length (the FPGA stops at the length, the others write the
 *             whole run) and no pair byte may be 0x80 to 0xBF (a pen beyond 63) — unless the
 *             stream is byte-for-byte a stock stream read the stock way;
 *   addresses records inside the 16 MiB program image, sources and tables inside the 64 MiB
 *             graphics image (SIMMs 1 to 6; a seventh SIMM is never addressed);
 *   loading   a frame that replaces another loads no more commands and no more decoded bytes
 *             than the stock frame it replaces, and never more than stock live play's maxima.
 * The BIOS flash menu's checksum display is reported, never silenced.
 */
(function (g) {
  'use strict';
  const node = typeof module !== 'undefined';
  const Codec = node ? require('./codec6.js') : g.ArtCodec6;
  const Anim = node ? require('./anim.js') : g.ArtAnim;
  const Stage = node ? require('./stage.js') : g.ArtStage;
  const Palette = node ? require('./palette.js') : g.ArtPalette;
  const Gill = node ? require('./gill.js') : g.ArtGill;
  const Extended = node ? require('./extendedcolours.js') : g.ArtExtendedColours;
  const StageColours = node ? require('./stagecolours.js') : g.ArtStageColours;
  const BASE = 0x06000000, INDEX = 0x800000, DATA = 0x400000, PROGRAM_SIZE = 0x1000000, DATA_SIZE = 0x4000000;
  /* Measured in stock live play (finish plan 1.1, R2 corpus): load commands and decoded bytes in one frame. */
  const LIVE = { commands: 196, decoded: 67584 };
  const BIOS = 'The BIOS flash menu (3. CHECKSUM) adds up each SIMM and shows the total; a changed set shows other totals there. Nothing at power-on compares them: a changed set boots to play.';

  const u16 = (b, o) => (b[o] << 8) | b[o + 1];
  const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  const s16 = (b, o) => (u16(b, o) << 16) >> 16;
  const dataOffset = (word) => ((word & 0x03ffffff) * 2) - DATA;
  const allocationOf = (capacity) => ((capacity >>> 5) + 1) * 4096;
  const DIMS = [8, 1, 2, 4];

  function images(x) {
    if (!x || !(x.program instanceof Uint8Array) || x.program.length !== PROGRAM_SIZE || !(x.data instanceof Uint8Array) || x.data.length !== DATA_SIZE)
      throw new Error('16 MiB program and 64 MiB graphics images required.');
    return x;
  }

  /* One sprite record as the game reads it (field layout as js/cel.js). */
  function record(program, pointer) {
    const a = pointer - BASE;
    if (a < 0 || a + 12 > PROGRAM_SIZE) return { pointer, outside: true };
    const flags = u16(program, a), capacity = u16(program, a + 2), chunks = u16(program, a + 4), count = u16(program, a + 6), tableWord = u32(program, a + 8);
    const bytes = 12 + 8 * (chunks + count);
    if (a + bytes > PROGRAM_SIZE) return { pointer, flags, capacity, chunks, count, tableWord, bytes, outside: true };
    const uploads = [], cells = [];
    for (let i = 0; i < chunks; i++) { const p = a + 12 + 8 * i, word = u32(program, p); uploads.push({ word, source: dataOffset(word), length: u16(program, p + 4), dest: u16(program, p + 6), requested: (u16(program, p + 4) + 1) * 16 }); }
    for (let i = 0; i < count; i++) { const p = a + 12 + 8 * chunks + 8 * i; cells.push({ code: u16(program, p), attributes: u16(program, p + 2), x: s16(program, p + 4), shape: program[p + 6] >>> 4 }); }
    return { pointer, flags, capacity, chunks, count, tableWord, table: dataOffset(tableWord), uploads, cells, bytes, allocation: allocationOf(capacity) };
  }
  function rows(program) {
    const out = new Map();
    for (let i = 0; i < 65536; i++) { const ptr = u32(program, INDEX + 8 * i + 4); if (ptr) out.set(i, { origin_x: s16(program, INDEX + 8 * i), origin_y: s16(program, INDEX + 8 * i + 2), pointer: ptr }); }
    return out;
  }
  function load(rec) { return rec && !rec.outside ? { commands: rec.chunks + 1, decoded: rec.uploads.reduce((a, u) => a + u.requested, 0) } : null; }

  /* Animation frame calls: address of each frame record's sprite number (character tables). */
  function calls(program) {
    const out = new Map();
    for (let c = 0; c < 21; c++) {
      let list = [];
      try { list = Anim.animations(program, c); } catch (e) { continue; }
      const seen = new Set();
      for (const a of list) {
        if (seen.has(a.address) || a.stride < 8) continue; seen.add(a.address);
        for (const r of a.records()) if (r.type === 'frame') out.set(r.address + 6, r.fields.cel_index);
      }
    }
    return out;
  }
  function stages(program, data) {
    const out = [];
    for (let i = 0; i < 23; i++) {
      let r; try { r = Stage.recipe(program, i); } catch (e) { continue; }
      const t = r.tile_uploads[0], src = t.source - DATA, table = t.table - DATA;
      if (src < 0 || src >= DATA_SIZE || table < 0 || table + 256 > DATA_SIZE) continue;
      const d = Codec.decode(data.subarray(src), data.slice(table, table + 256), t.length);
      const blocks = [...new Set(r.map_blocks.map(b => b.source))].map(s => [s - BASE, s - BASE + 1024]);
      let maxTile = 0, flags = 0;
      for (const [a, b] of blocks) for (let p = a; p < b; p += 4) { maxTile = Math.max(maxTile, u16(program, p)); flags |= u16(program, p + 2); }
      out.push({ index: i, tile: { source: src, table, length: t.length, consumed: d.sourceConsumed }, blocks, maxTile, flags,
        palettes: r.palette_uploads.map(p => [p.source - DATA, p.source - DATA + p.length]) });
    }
    return out;
  }
  function paletteRows(program) {
    const out = [];
    try { for (const source of Palette.catalogue(program).aliases.keys()) out.push([source - DATA, source - DATA + 128]); } catch (e) { /* rows stay unknown */ }
    return merge(out);
  }
  function merge(iv) {
    iv = iv.slice().sort((a, b) => a[0] - b[0]); const out = [];
    for (const [a, b] of iv) { const l = out[out.length - 1]; if (!l || a > l[1]) out.push([a, b]); else if (b > l[1]) l[1] = b; }
    return out;
  }

  /* --------------------------------------------------------------- derive */
  function derive(stock) {
    const { program, data } = images(stock), recs = new Map(), r = rows(program);
    const env = { flags: new Set(), capacity: 0, chunks: 0, count: 0, allocation: 0, uploadLength: 0, shapes: new Set(), attributes: 0,
      tables: new Set(), sourceHigh: new Set(), uploadSlack: 0, origin: [0, 0, 0, 0], tableBytesHigh: 0 };
    for (const [, row] of r) {
      env.origin[0] = Math.min(env.origin[0], row.origin_x); env.origin[1] = Math.max(env.origin[1], row.origin_x);
      env.origin[2] = Math.min(env.origin[2], row.origin_y); env.origin[3] = Math.max(env.origin[3], row.origin_y);
      if (recs.has(row.pointer)) continue;
      const c = record(program, row.pointer); recs.set(row.pointer, c);
      if (c.outside) throw new Error('A stock record lies outside the program image.');
      env.flags.add(c.flags); env.capacity = Math.max(env.capacity, c.capacity); env.chunks = Math.max(env.chunks, c.chunks); env.count = Math.max(env.count, c.count);
      env.allocation = Math.max(env.allocation, c.allocation); env.tables.add(c.table);
      for (const u of c.uploads) { env.uploadLength = Math.max(env.uploadLength, u.length); env.sourceHigh.add(u.word >>> 26); env.uploadSlack = Math.max(env.uploadSlack, u.dest * 16 + u.requested - c.allocation); }
      for (const cell of c.cells) { env.shapes.add(cell.shape); env.attributes |= cell.attributes; }
    }
    for (const t of env.tables) for (let i = 0; i < 256; i++) if ((data[t + i] & 0xc0) === 0x80) env.tableBytesHigh++;
    return { schema: 'cps3art-envelope-v1', records: recs.size, rows: r.size, ...env, flags: [...env.flags].sort((a, b) => a - b), shapes: [...env.shapes].sort((a, b) => a - b),
      tables: [...env.tables].sort((a, b) => a - b), sourceHigh: [...env.sourceHigh].sort((a, b) => a - b), live: LIVE, bios: BIOS,
      calls: calls(program), stages: stages(program, data), palettes: paletteRows(program),
      /* A program without a recognised native handler allows no program colour writes (the safe side). */
      gill: tolerant(() => Gill.catalogue(program).sources.map(s => [s.source - BASE, s.source - BASE + 96])),
      extendedColours: tolerant(() => [...Extended.catalogue(program,{fresh:true}).sources.keys()].map(s => [s - BASE, s - BASE + 128])),
      stageColours: tolerant(() => [...StageColours.catalogue(program,{fresh:true}).sources.keys()].map(s => [s - BASE, s - BASE + 128])) };
  }

  function tolerant(fn) { try { return fn(); } catch (e) { return []; } }
  /* --------------------------------------------------------------- check */
  function diff(a, b) {
    const out = []; let start = -1;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) { if (start < 0) start = i; }
      else if (start >= 0) { out.push([start, i]); start = -1; }
    }
    if (start >= 0) out.push([start, a.length]);
    return out;
  }
  const overlaps = (ranges, s, e) => { let lo = 0, hi = ranges.length; while (lo < hi) { const m = (lo + hi) >> 1; if (ranges[m][1] <= s) lo = m + 1; else hi = m; } return lo < ranges.length && ranges[lo][0] < e; };
  const inside = (list, s, e) => list.some(([a, b]) => s < b && a < e);

  function check(env, stockImages, editedImages) {
    const stock = images(stockImages), edited = images(editedImages), findings = [];
    const fail = (rule, where, sentence) => findings.push({ level: 'error', rule, where, sentence });
    const warn = (rule, where, sentence) => findings.push({ level: 'warning', rule, where, sentence });
    const pd = diff(stock.program, edited.program), dd = diff(stock.data, edited.data);
    const summary = { programBytes: pd.reduce((a, [s, e]) => a + e - s, 0), dataBytes: dd.reduce((a, [s, e]) => a + e - s, 0),
      rows: 0, records: 0, calls: 0, streams: 0, collateral: 0, palettes: 0, gill: 0, stageTiles: 0, stageMaps: 0, loads: [] };
    if (!pd.length && !dd.length) return { passed: true, findings, summary };
    findings.push({ level: 'note', rule: 'bios-checksum', where: 'BIOS', sentence: BIOS });

    const sr = rows(stock.program), er = rows(edited.program), sRec = new Map(), eRec = new Map();
    const recOf = (map, program, ptr) => { if (!map.has(ptr)) map.set(ptr, record(program, ptr)); return map.get(ptr); };
    /* extents of every record either image can reach */
    const extents = [];
    for (const [, row] of sr) { const c = recOf(sRec, stock.program, row.pointer); if (!c.outside) extents.push([c.pointer - BASE, c.pointer - BASE + c.bytes]); }
    for (const [, row] of er) { const c = recOf(eRec, edited.program, row.pointer); if (!c.outside) extents.push([c.pointer - BASE, c.pointer - BASE + c.bytes]); }
    const extentList = merge(extents);
    const mapRanges = env.stages.flatMap(s => s.blocks.map(b => [...b, s])).sort((a, b) => a[0] - b[0]);
    const gillRanges = env.gill || [];
    const extendedRanges = env.extendedColours || [];
    const stageColourRanges = env.stageColours || [];
    for (const [a, b] of stageColourRanges) if (overlaps(pd, a, b)) {
      summary.stageColours = (summary.stageColours || 0) + 1;
      for (let p = a; p < b; p += 2) if ((u16(stock.program, p) & 0x8000) !== (u16(edited.program, p) & 0x8000))
        fail('stage-colour-flag', (BASE + p).toString(16).toUpperCase(), 'A stage colour changes its preserved flag bit.');
    }
    for (const [a, b] of extendedRanges) if (overlaps(pd, a, b)) {
      summary.extendedColours = (summary.extendedColours || 0) + 1;
      for (let p = a; p < b; p += 2) if ((u16(stock.program, p) & 0x8000) !== (u16(edited.program, p) & 0x8000))
        fail('extra-colour-flag', (BASE + p).toString(16).toUpperCase(), 'An extra colour changes its preserved flag bit.');
    }
    for (const [a, b] of gillRanges) if (overlaps(pd, a, b)) {
      summary.gill++;
      for (let p = a; p < b; p += 2) if ((u16(stock.program, p) & 0x8000) !== (u16(edited.program, p) & 0x8000))
        fail('gill-colour-flag', (BASE + p).toString(16).toUpperCase(), 'A timed Gill body colour changes its preserved flag bit.');
    }

    /* 1. program bytes: classify */
    const changedCalls = [];
    for (const [s, e] of pd) for (let p = s; p < e; p++) {
      if (inside(gillRanges, p, p + 1)) continue;
      if (inside(extendedRanges, p, p + 1)) continue;
      if (inside(stageColourRanges, p, p + 1)) continue;
      if (p >= INDEX && p < INDEX + 65536 * 8) continue;
      const callAt = env.calls.has(BASE + p) ? BASE + p : env.calls.has(BASE + p - 1) ? BASE + p - 1 : null;
      if (callAt !== null) { if (!changedCalls.includes(callAt)) changedCalls.push(callAt); continue; }
      if (overlaps(extentList, p, p + 1)) continue;
      const m = mapRanges.find(([a, b]) => p >= a && p < b);
      if (m) continue;
      fail('unknown-program-byte', (BASE + p).toString(16).toUpperCase(), 'A program byte changed outside every sprite row, record, animation call and stage map the Studio knows.');
      break;
    }
    /* 2. rows and records reachable in the edited image whose bytes differ */
    const checkedRecords = new Map();
    for (const [i, row] of er) {
      const stockRow = sr.get(i), c = eRec.get(row.pointer);
      const rowChanged = !stockRow || stockRow.pointer !== row.pointer || stockRow.origin_x !== row.origin_x || stockRow.origin_y !== row.origin_y;
      const bytesChanged = !c.outside && (!sRec.has(row.pointer) || overlaps(pd, c.pointer - BASE, c.pointer - BASE + c.bytes));
      if (!rowChanged && !bytesChanged) continue;
      if (rowChanged) summary.rows++;
      if (row.origin_x < env.origin[0] || row.origin_x > env.origin[1] || row.origin_y < env.origin[2] || row.origin_y > env.origin[3])
        fail('origin', 'sprite ' + i, 'The sprite origin is outside every stock origin.');
      if (!checkedRecords.has(row.pointer)) checkedRecords.set(row.pointer, { rec: c, numbers: [] });
      checkedRecords.get(row.pointer).numbers.push(i);
    }
    const tableSet = new Set(env.tables), flagSet = new Set(env.flags), shapeSet = new Set(env.shapes), highSet = new Set(env.sourceHigh);
    for (const [ptr, { rec: c, numbers }] of checkedRecords) {
      summary.records++;
      const where = 'record ' + ptr.toString(16).toUpperCase() + ' (sprite ' + numbers.slice(0, 3).join(', ') + ')';
      if (c.outside) { fail('record-address', where, 'The record lies outside the 16 MiB program image.'); continue; }
      if (!flagSet.has(c.flags)) fail('record-flags', where, 'Record flags the stock game never uses.');
      if (c.capacity > env.capacity) fail('record-capacity', where, 'Capacity above the stock maximum ' + env.capacity + '.');
      if (c.chunks > env.chunks) fail('record-chunks', where, 'More uploads than any stock sprite (' + env.chunks + ').');
      if (c.count > env.count) fail('record-cells', where, 'More cells than any stock sprite (' + env.count + ').');
      if (c.allocation > env.allocation) fail('record-allocation', where, 'Video-memory allocation above the stock maximum.');
      if (c.table < 0 || c.table + 256 > DATA_SIZE || (c.tableWord >>> 26) !== 0) fail('record-table', where, 'A pair table outside the 64 MiB graphics image.');
      else if (!tableSet.has(c.table)) findings.push({ level: 'note', rule: 'new-table', where, sentence: 'A pair table at a new address (the same construct as the stock tables; its used entries are checked per stream).' });
      for (const cell of c.cells) {
        if (!shapeSet.has(cell.shape)) { fail('cell-shape', where, 'A cell shape the stock sprites never use.'); break; }
        if (cell.attributes & ~env.attributes) { fail('cell-attributes', where, 'Cell attribute bits the stock sprites never set.'); break; }
        const nx = DIMS[cell.shape & 3], ny = DIMS[cell.shape >>> 2];
        if ((cell.shape & 3) && (cell.shape >>> 2) && (Math.floor(cell.code / 2) + nx * ny) * 256 > c.allocation) { fail('cell-tiles', where, 'A cell draws tiles beyond the record allocation.'); break; }
      }
      for (const u of c.uploads) {
        if (!highSet.has(u.word >>> 26)) fail('source-form', where, 'An upload address form the stock records never use.');
        if (u.length > env.uploadLength) fail('upload-length', where, 'An upload longer than any stock upload.');
        if (u.source < 0 || u.source >= DATA_SIZE) fail('source-address', where, 'An upload source outside the 64 MiB graphics image.');
        if (u.dest * 16 + u.requested - c.allocation > env.uploadSlack) fail('upload-destination', where, 'An upload writes past the record allocation.');
      }
    }
    /* 3. streams: every upload of a checked record, and every upload whose window holds changed data */
    const streamChecked = new Set(), streamOwners = [];
    const checkStream = (c, u, where, collateral) => {
      const key = u.source + ':' + u.requested + ':' + c.table; if (streamChecked.has(key)) return; streamChecked.add(key);
      if (u.source < 0 || u.source >= DATA_SIZE || c.table < 0 || c.table + 256 > DATA_SIZE) return;
      let d;
      try { d = Codec.decode(edited.data.subarray(u.source), edited.data.slice(c.table, c.table + 256), u.requested, u.requested + 64, true); }
      catch (e) { (collateral ? warn : fail)('stream-decode', where, 'A stream does not decode inside the graphics image: ' + e.message); return; }
      streamOwners.push([u.source, u.source + d.sourceConsumed]);
      if (collateral) summary.collateral++; else summary.streams++;
      const identical = !overlaps(dd, u.source, u.source + d.sourceConsumed) && !overlaps(dd, c.table, c.table + 256);
      if (identical) return;
      if (d.pixels.length > u.requested) (collateral ? warn : fail)('stream-tail', where, 'A run crosses the requested length: Fightcade and MAME write the whole run, the FPGA core stops at the length.');
      const t = edited.data.subarray(c.table, c.table + 256);
      if ((d.tablePositions || []).some(p => (t[p] & 0xc0) === 0x80)) (collateral ? warn : fail)('stream-pair-byte', where, 'A pair token expands to a pen above 63 (a byte 0x80 to 0xBF).');
    };
    for (const [ptr, { rec: c, numbers }] of checkedRecords) if (!c.outside) for (const u of c.uploads) checkStream(c, u, 'sprite ' + numbers[0] + ' upload at ' + u.dest * 16, false);
    /* a stream of a sprite that a known or changed animation call loads is held to the full rule;
       other readers of changed bytes (numbers nothing is known to call) are reported as warnings */
    const callers = new Set(env.calls.values());
    for (const at of changedCalls) callers.add(u16(edited.program, at - BASE));
    const numbersOf = new Map();
    for (const [i, row] of er) { if (!numbersOf.has(row.pointer)) numbersOf.set(row.pointer, []); numbersOf.get(row.pointer).push(i); }
    if (dd.length) for (const [ptr, c] of eRec) {
      if (c.outside || checkedRecords.has(ptr)) continue;
      const nums = numbersOf.get(ptr) || [], loaded = nums.some(n => callers.has(n));
      for (const u of c.uploads) if (overlaps(dd, u.source, u.source + u.requested)) checkStream(c, u, 'sprite ' + nums.slice(0, 3).join(', ') + ' upload at ' + u.dest * 16, !loaded);
    }
    /* 4. data bytes: every changed byte read by a sprite stream, a palette row or a stage stream */
    const owned = merge(streamOwners);
    const stageTiles = env.stages.map(s => [s.tile.source, s.tile.source + s.tile.consumed, s]);
    for (const [s, e] of dd) {
      let p = s;
      while (p < e) {
        if (overlaps(owned, p, p + 1)) { p++; continue; }
        const st = stageTiles.find(([a, b]) => p >= a && p < b);
        if (st) { p = Math.min(e, st[1]); continue; }
        if (inside(env.palettes, p, p + 1) || env.stages.some(x => inside(x.palettes, p, p + 1))) { p++; continue; }
        warn('unread-data-byte', p.toString(16).toUpperCase(), 'Graphics bytes changed that no known sprite stream, palette row or stage stream reads. The board is asked nothing new; whether anything else reads them is an ownership question.');
        p = e; break;
      }
    }
    /* 5. palettes: the flag bit of every colour word stays as stock */
    const palettes = env.palettes.concat(env.stages.flatMap(x => x.palettes));
    for (const [s, e] of dd) for (const [a, b] of palettes) {
      if (!(s < b && a < e)) continue;
      for (let w = Math.max(a, s & ~1); w < Math.min(b, e); w += 2) {
        if (w < a || (w - a) % 2) continue;
        summary.palettes++;
        if ((stock.data[w] & 0x80) !== (edited.data[w] & 0x80)) { fail('palette-flag', 'colour word ' + w.toString(16).toUpperCase(), 'A colour word changes the flag bit the game keeps.'); break; }
      }
    }
    /* 6. stage tile streams and maps */
    for (const x of env.stages) {
      const t = x.tile;
      if (overlaps(dd, t.source, t.source + t.consumed + 1) || overlaps(dd, t.table, t.table + 256)) {
        summary.stageTiles++;
        let d;
        try { d = Codec.decode(edited.data.subarray(t.source), edited.data.slice(t.table, t.table + 256), t.length, t.length + 64, true); }
        catch (e) { fail('stage-stream', 'stage ' + x.index, 'The stage tile stream no longer decodes: ' + e.message); continue; }
        if (d.sourceConsumed > t.consumed) fail('stage-stream-size', 'stage ' + x.index, 'The stage tile stream grew past its stock bytes.');
        if (d.pixels.length > t.length) fail('stream-tail', 'stage ' + x.index, 'A run crosses the requested length of the stage tiles.');
        const tb = edited.data.subarray(t.table, t.table + 256);
        if ((d.tablePositions || []).some(p => (tb[p] & 0xc0) === 0x80)) fail('stream-pair-byte', 'stage ' + x.index, 'A pair token expands to a pen above 63 (a byte 0x80 to 0xBF).');
      }
      for (const [a, b] of x.blocks) if (overlaps(pd, a, b)) {
        summary.stageMaps++;
        for (let p = a; p < b; p += 4) {
          if (u16(edited.program, p) > x.maxTile) { fail('stage-map-tile', 'stage ' + x.index, 'A map cell names a tile beyond the stage tiles.'); break; }
          if (u16(edited.program, p + 2) & ~x.flags) { fail('stage-map-bits', 'stage ' + x.index, 'A map cell sets bits the stage maps never set.'); break; }
        }
      }
    }
    /* 7. loading: a call loads no more than the stock frame it replaces */
    const called = new Set();
    for (const at of changedCalls) {
      summary.calls++;
      const oldCel = u16(stock.program, at - BASE), newCel = u16(edited.program, at - BASE);
      const so = sr.get(oldCel), eo = er.get(newCel);
      if (!eo) { fail('call-null', 'call ' + at.toString(16).toUpperCase(), 'An animation frame calls a sprite number with no record.'); continue; }
      called.add(newCel);
      const before = so ? load(sRec.get(so.pointer)) : { commands: 0, decoded: 0 }, after = load(eRec.get(eo.pointer));
      summary.loads.push({ call: at.toString(16).toUpperCase(), replaced: oldCel, by: newCel, before, after });
      if (!after) continue;
      if (after.commands > before.commands || after.decoded > before.decoded)
        fail('load-heavier', 'call ' + at.toString(16).toUpperCase(), `Sprite ${newCel} loads ${after.commands} commands and ${after.decoded} bytes where the stock frame ${oldCel} loaded ${before.commands} and ${before.decoded}.`);
      if (after.commands > LIVE.commands || after.decoded > LIVE.decoded) fail('load-live', 'call ' + at.toString(16).toUpperCase(), 'One frame would load more than stock live play ever does.');
    }
    const stockCalled = new Set(env.calls.values());
    for (const [ptr, { rec: c, numbers }] of checkedRecords) for (const i of numbers) {
      if (called.has(i)) continue;
      const so = sr.get(i), before = so && load(sRec.get(so.pointer)), after = load(c);
      if (!after) continue;
      const heavier = !before || after.commands > before.commands || after.decoded > before.decoded;
      if (heavier && stockCalled.has(i)) fail('load-heavier', 'sprite ' + i, `Sprite ${i} now loads more than it did, and stock animations call it.`);
      else if (heavier) warn('load-uncalled', 'sprite ' + i, `Sprite ${i} loads more than before; no known animation calls it.`);
    }
    const errors = findings.filter(f => f.level === 'error');
    return { passed: errors.length === 0, findings, summary };
  }
  function guard(env, stock, edited) {
    const r = check(env, stock, edited), errors = r.findings.filter(f => f.level === 'error');
    if (errors.length) { const e = new Error('Outside what a CPS3 board is asked by the stock game: ' + errors.map(x => x.sentence + ' (' + x.where + ')').join(' ')); e.envelope = r; throw e; }
    return r;
  }

  const api = { derive, check, guard, record, load, LIVE, BIOS };
  if (node) module.exports = api; else g.ArtEnvelope = api;
})(typeof window !== 'undefined' ? window : globalThis);
