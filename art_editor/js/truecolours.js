/* True colours: which stored colours the game draws a sprite in, read from the ROM's own tables.
 *
 * Stage-drawn sprites: every sprite a stage's own animation tables call (one table per physical
 * stage, 06615278) is drawn in that stage's first stored bank, at row 128 plus the cell's row bits
 * (selector 0619DE02 by physical index, descriptor table 061B4754).  Checked against 605 of 605
 * recorded sighted rows of such sprites (finish plan step 5).  Several stages may draw one sprite.
 * Ported from the research project's sprite account (derive.js).  No ROM data is stored here.
 */
(function (g) {
  'use strict';
  const BASE = 0x06000000;
  function stageContexts(program) {
    const v = new DataView(program.buffer, program.byteOffset, program.byteLength);
    const u16 = a => v.getUint16(a - BASE), u32 = a => v.getUint32(a - BASE);
    const tables = Array.from({ length: 23 }, (_, i) => u32(0x06615278 + i * 4)), edges = [...new Set([...tables, 0x064755bc])].sort((a, b) => a - b);
    const physical = new Map(), uses = new Map();
    for (const table of new Set(tables)) {
      const end = edges.find(x => x > table), pointers = []; let at = table, ptr;
      while (at + 4 <= end) { ptr = u32(at); at += 4; if (!ptr) break; if (at - table > 1024 || ptr <= table || ptr >= end) throw new Error('Stage pointer bounds'); pointers.push(ptr); }
      if (ptr || !pointers.length || at > Math.min(...pointers) - 8) throw new Error('Stage pointer terminator');
      const unique = [...new Set(pointers)].sort((a, b) => a - b), refs = new Set();
      for (let j = 0; j < unique.length; j++) {
        const p = unique[j], stop = j + 1 < unique.length ? unique[j + 1] - 8 : end, stride = v.getInt16(p - BASE - 8) * 4;
        if (![4, 8, 16, 24].includes(stride) || (stop - p) % stride) throw new Error('Stage stream domain');
        for (let a = p; a < stop; a += stride) { const code = u16(a); if (code >= 256 && stride >= 8) { const sprite = u16(a + 6); if (!u32(0x06800004 + sprite * 8)) throw new Error('Null stage sprite'); refs.add(sprite); } else if (code < 141 && stride >= 8) continue; else break; }
      }
      physical.set(table, refs);
    }
    for (let s = 0; s < 23; s++) { const index = u16(0x0619d8d0 + s * 6); if (index >= 23) throw new Error('Stage selector'); for (const sprite of physical.get(tables[index])) { if (!uses.has(sprite)) uses.set(sprite, []); uses.get(sprite).push(s); } }
    return uses;
  }
  /* Stored rows a stage-drawn sprite uses: [{stage, row, source}] (source as js/palette.js). */
  function stageSources(program, sprite, contexts) {
    const v = new DataView(program.buffer, program.byteOffset, program.byteLength), out = [];
    const p = v.getUint32(0x800004 + sprite * 8) - BASE; if (p < 0 || p + 12 > program.length) return out;
    const chunks = v.getUint16(p + 4), count = v.getUint16(p + 6), attrs = new Set();
    for (let c = 0; c < count; c++) attrs.add(v.getUint16(p + 12 + chunks * 8 + c * 8 + 2));
    for (const s of contexts.get(sprite) || []) {
      const index = v.getUint16(0x19d8d0 + s * 6), selector = v.getUint16(0x19de02 + index * 2), a = 0x1b4754 + selector * 12;
      const src = v.getUint32(a), dst = v.getUint32(a + 4), size = v.getUint32(a + 8);
      for (const attr of [...attrs].sort((x, y) => x - y)) { const row = 128 + (attr & 511), off = row * 128 - dst; if (attr & 512 && row < 512 && off >= 0 && off + 128 <= size) out.push({ stage: s, row, source: src + off }); }
    }
    return out;
  }
  // Bounded Original scene correspondences, checked by g_scene_palettes.js against
  // retained draw events and all 64 captured words of each row. A numeric row is
  // not a permanent owner: the Ryu illustration's bank changes during staff roll.
  const ORIGINAL = '35ac2d569893926599b0f68d772e98f412573fb76b305ba3ed910f6136dd2de0';
  const SCENES = [
    { id: 'title-logo', name: 'Title logo', first: 0xE3D0, last: 0xE3D5, base: 192, selector: 39,
      scope: 'Original title-logo context. Stored, unfaded colours; other scene phases may differ.' },
    { id: 'ryu-ending-illustration', name: 'Ryu ending illustration', first: 0xE3F0, last: 0xE3F6, base: 32, selector: 41,
      scope: 'Original Ryu illustration context. The later staff roll overwrites these rows; this is not an ending-wide palette.' },
    { id: 'stage-19-scenery', name: 'Stage 19 animated scenery', first: 55319, last: 55323, base: 128, selector: 3,
      table: 0x061B4754, stage: 19, relativeRow: 26,
      evidence: 'art/palette_stage_5_19: Original effect44/animation23 and colour loader; retained stage19 draw rows and exact stored-row correspondence',
      scope: 'Original stage 19 effect-44 context. Stored, unfaded colours; later scene transitions overwrite this row. Stage 5 shares the animation table, but its first bank does not cover this row; a stage-5 draw/source remains unproved.' }
  ];
  // The Original car consumer indexes this 7 x 8 x 18 table. Membership comes
  // from its records, not from adjacent sprite numbers or a shared charset.
  // The finite consumer gate executes all selections. Only five have retained
  // natural draw sightings; this family is deliberately a static context.
  function carContext(program, sprite, programHash) {
    if (programHash !== ORIGINAL || !Number.isInteger(sprite) || sprite < 44536 || sprite > 45543) return null;
    if (!(program instanceof Uint8Array) || program.length !== 0x1000000) throw new Error('16 MiB program required.');
    const v = new DataView(program.buffer, program.byteOffset, program.byteLength), refs = [];
    for (let index = 0; index < 1008; index++) if (v.getUint16(0x1c1854 + index * 4) === sprite) {
      const type = Math.floor(index / 144) + 1;
      refs.push({ address: 0x061c1854 + index * 4, type, damage: Math.floor(index % 144 / 18), pose: index % 18 + 1,
        colourCode: v.getUint16(0x1c1528 + type * 12 + 6) });
    }
    // Types 1/2 add 159 to cell row31 -> native row190, outside this bank.
    // Keep those 288 entries unresolved; OR-ing the values would give a false159.
    if (!refs.length || refs.some(r => r.colourCode !== 0x2080)) return null;
    const p = v.getUint32(0x800004 + sprite * 8) - BASE;
    if (p < 0 || p + 12 > program.length) return null;
    const chunks = v.getUint16(p + 4), count = v.getUint16(p + 6), cells = p + 12 + chunks * 8;
    if (!count || cells + count * 8 > program.length) return null;
    const physical = v.getUint16(0x19d8d0 + 21 * 6);
    if (physical !== 21) return null;
    const selector = v.getUint16(0x19de02 + physical * 2), descriptor = 0x061b4754 + selector * 12, a = descriptor - BASE;
    if (a < 0 || a + 12 > program.length) return null;
    const source = v.getUint32(a), destination = v.getUint32(a + 4), size = v.getUint32(a + 8), rows = new Map();
    if (destination % 128 || size % 128 || !size || destination + size > 0x40000 || source < 0x400000 || source + size > 0x4400000) return null;
    for (let i = 0; i < count; i++) {
      const attributes = v.getUint16(cells + i * 8 + 2), relativeRow = attributes & 511, row = 128 + relativeRow, offset = row * 128 - destination;
      if (!(attributes & 512) || row < 156 || row > 158 || offset < 0 || offset + 128 > size) return null;
      rows.set(row, { relativeRow, row, source: source + offset });
    }
    return { id: 'bonus-car-parts', name: 'Bonus car parts', state: 'static', base: 128, stage: 21, selector, descriptor, sprite,
      table: 0x061c1854, tableRecords: refs, evidenceSource: ORIGINAL,
      evidence: 'g_car_palette_consumer.py: all 1008 Original table selections; g_car_palettes.js: captured garage row words and five drawn parts',
      scope: 'Original bonus-car parts and damage states. Stored garage colours. Table membership and palette selection are verified; not every damage/pose combination has been observed in play. Fades and other uses may differ.',
      rows: [...rows.values()].sort((x, y) => x.row - y.row), reachability: 'static-consumer', exclusive: false };
  }
  function sceneContext(program, sprite, programHash) {
    if (programHash !== ORIGINAL || !Number.isInteger(sprite)) return null;
    const rule = SCENES.find(s => sprite >= s.first && sprite <= s.last);
    if (!rule) return carContext(program, sprite, programHash) || poisonContext(program, sprite, programHash);
    if (!(program instanceof Uint8Array) || program.length !== 0x1000000) throw new Error('16 MiB program required.');
    const v = new DataView(program.buffer, program.byteOffset, program.byteLength), p = v.getUint32(0x800004 + sprite * 8) - BASE;
    if (p < 0 || p + 12 > program.length) return null;
    const chunks = v.getUint16(p + 4), count = v.getUint16(p + 6), cells = p + 12 + chunks * 8;
    if (!count || cells + count * 8 > program.length) return null;
    if (rule.stage === 19) {
      // Shared table membership alone gave the wrong stage-5 default. Require
      // the independently checked stage19 loader and effect44/animation23 path.
      if (v.getUint16(0x19D8D0 + 19 * 6) !== 19 || v.getUint16(0x19DE02 + 19 * 2) !== rule.selector ||
          v.getUint32(0x615278 + 19 * 4) !== 0x0646F264 ||
          v.getUint16(0x1BE4A0 + 4) !== 128 || v.getUint16(0x1BE4A0 + 12) !== 23) return null;
      const stream = v.getUint32(0x46F264 + 23 * 4) - BASE;
      if (stream < 8 || stream + 64 > program.length || v.getUint16(stream - 8) !== 2 ||
          !Array.from({ length: 8 }, (_, i) => v.getUint16(stream + i * 8 + 6)).includes(sprite)) return null;
    }
    const descriptor = (rule.table || 0x061B3ED8) + rule.selector * 12, a = descriptor - BASE;
    const source = v.getUint32(a), destination = v.getUint32(a + 4), size = v.getUint32(a + 8), rows = new Map();
    if (destination % 128 || size % 128 || !size || destination + size > 0x40000 || source < 0x400000 || source + size > 0x4400000) return null;
    for (let i = 0; i < count; i++) {
      const attributes = v.getUint16(cells + i * 8 + 2);
      if (!(attributes & 512)) return null; // 256-pen cells need their own witnessed contract.
      const relativeRow = attributes & 511, row = rule.base + relativeRow, offset = row * 128 - destination;
      if (rule.relativeRow !== undefined && relativeRow !== rule.relativeRow) return null;
      if (row >= 512 || offset < 0 || offset + 128 > size) return null;
      rows.set(row, { relativeRow, row, source: source + offset });
    }
    return { ...rule, sprite, descriptor, evidenceSource: ORIGINAL, evidence: rule.evidence || 'g_scene_palettes.js: captured draw rows and exact stored-row correspondence',
      rows: [...rows.values()].sort((x, y) => x.row - y.row), reachability: 'observed-in-original-context', exclusive: false };
  }
  function poisonContext(program, sprite, programHash) {
    if (programHash !== ORIGINAL || !Number.isInteger(sprite) || !(sprite >= 9987 && sprite <= 10056 || sprite >= 10105 && sprite <= 10145)) return null;
    if (!(program instanceof Uint8Array) || program.length !== 0x1000000) throw new Error('16 MiB program required.');
    const v = new DataView(program.buffer, program.byteOffset, program.byteLength), p = v.getUint32(0x800004 + sprite * 8) - BASE;
    if (p < 0 || p + 12 > program.length) return null;
    const chunks = v.getUint16(p + 4), count = v.getUint16(p + 6), cells = p + 12 + chunks * 8;
    if (!count || cells + count * 8 > program.length) return null;
    for (let i = 0; i < count; i++) if ((v.getUint16(cells + i * 8 + 2) & 1023) !== 515) return null;
    const P = g.ArtPalette || (typeof require === 'function' && require('./palette.js')), loads = P.characterLoads(program, 6, 0, 0), source = P.loadedRows(loads.loads).get(4);
    if (source == null) return null;
    // These are the requested Poison artwork ranges. Original supporting-
    // character setup adds 1 to P1's colour, then the renderer adds cell row3.
    // 110 have references in the checked Poison streams; 10018 has none there.
    return { id: 'poison-pink', name: 'Poison · pink costume', state: 'static', base: 1, character: 6, side: 0, colour: 0,
      sprite, descriptor: loads.address, selector: null, artworkRole: 'palette-preview-artwork', evidenceSource: ORIGINAL,
      evidence: 'g_poison_palette_consumer.py: Original effect30/L6/L7 and renderer colour selection; g_poison_palettes.js: captured row and all requested artwork',
      scope: 'Original P1 Poison: pink hair, white top and blue shorts. P2 and the seventh Hugo colour use different costumes. Stored colours; fades and other contexts may differ.',
      usageEvidence: sprite === 10018 ? 'No reference found in the checked Poison animation tables. Palette preview only; this does not prove the frame is unused.' : 'Listed in the checked Poison animation tables. Natural reachability of each frame remains unresolved.',
      rows: [{ relativeRow: 3, row: 4, source }], reachability: 'palette-context-only', exclusive: false };
  }
  function scenePalette(program, data, sprite, programHash) {
    const context = sceneContext(program, sprite, programHash);
    if (!context) return null;
    const P = g.ArtPalette || (typeof require === 'function' && require('./palette.js'));
    const rows = context.rows.map(r => { const bytes = P.sourceBytes(data, r.source, 128), words = new Uint16Array(64);
      for (let i = 0; i < 64; i++) words[i] = bytes[i * 2] * 256 + bytes[i * 2 + 1];
      return { ...r, words, palette: P.rgbaRow(words, 'dma') };
    });
    return { context, rows };
  }
  const api = { stageContexts, stageSources, sceneContext, scenePalette, carContext, poisonContext, ORIGINAL };
  if (typeof module !== 'undefined') module.exports = api; else g.ArtTrueColours = api;
})(typeof window !== 'undefined' ? window : globalThis);
