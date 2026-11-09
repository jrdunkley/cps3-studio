/* GATE G15 (docs/plan/06_GATES.md): the instrument catalog.
 *
 *   node checks/gates/g_catalog.js [--quick]
 *
 * js/catalog.js turns the game's own tables into a catalog a musician can use: names, families,
 * zones, what Capcom plays, tuning, tone, kit keys, break bars. Everything measured is measured at
 * run time from the engine and the 49 sequences. This gate checks, against the real thing:
 *   1. build is deterministic (two fresh engines give the same JSON), does not touch its inputs, is
 *      plain JSON, headless (no fs, window, dates or random in the source) and fast;
 *   2. 59 bank-0 programs, 12 of them kits, plus the 573 effect and voice programs of banks 1-7 and 15,
 *      each with a unique, non-empty, plain-words name and one of the seven families; the zone tables
 *      equal the ROM's instrument tables;
 *   3. what Capcom plays: the notes of all 49 pieces read again straight from the bytes by a second,
 *      independent interpreter (first pass of every track, a loop counted past 64 passes read as
 *      endless) give the catalog's range, median, typical range, note count and list of pieces for
 *      every program; the same low, high and pieces are then observed in the DRIVER itself, playing
 *      every piece, key-on by key-on (--quick: 10 pieces; the board runs it whole);
 *   4. tuning equals what `node checks/tuning.js` prints, zone by zone, within 1 cent;
 *   5. break bars for kits 0 1 2 3 4 10 11 12 13 equal style/breaks.js's library, kit tempos too;
 *   6. kit keys: names, roles, lengths and slice analysis equal style/sounds.js at each key's pitch;
 *      tone equals style/sounds.js's tone at the same note (centroid within 1 Hz);
 *   7. suggest() is static and agrees with style/arrange3s.js (ROLE and pickProgram, read from its
 *      source) for every role and every GM program;
 *   8. the facts the plan states about Capcom's levels and tuning come out as stated;
 *   9. Capcom's levels, echoes, doubles and glides equal what style/techniques.js reports (run from a
 *      copy that writes into a temporary folder under out/tests/G15, removed afterwards).
 * Exit 0 only when all pass. Exit 2 while js/catalog.js does not exist yet.
 * Options: --verbose prints every passing check too; --quick checks the driver on 10 pieces only (the
 * board never passes it, so the board runs all 49).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');
const G = require('./lib.js');
const Catalog = G.need('js/catalog.js');
const gate = G.gate('G15 catalog'), done = gate.done;
const quick = process.argv.includes('--quick'), verbose = process.argv.includes('--verbose');   // --verbose also prints every check that passes
const check = (ok, what) => { if (verbose && ok) console.log('ok  ', what); return gate.check(ok, what); };
const ROOT_RATE = 42954500 / 3 / 384 * 0xFE1 / 4096;
const FAMILIES = ['Drums', 'Bass', 'Keys & plucks', 'Pads & strings', 'Leads', 'Hits & chops', 'Effects & voices'];
const ROLES = ['drums', 'perc', 'bass', 'chords', 'pad', 'lead', 'arp', 'fx'];
const KEY_ROLES = ['kick', 'snare', 'hat', 'slice', 'tom', 'clap', 'crash', 'ride', 'perc', 'bell', 'boom', 'loop', 'beat', 'hit', 'voice'];
const BREAK_KITS = [0, 1, 2, 3, 4, 10, 11, 12, 13];
const SHARED_FIVE = [19, 46, 57, 58, 60];                       // judged by ear by the project's owner (wp A5)
const sha = (a) => crypto.createHash('sha256').update(Buffer.from(a.buffer, a.byteOffset, a.byteLength)).digest('hex');
const median = (xs) => (xs.length ? xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null);
const quantile = (xs, f) => { const s = xs.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(f * s.length))]; };
const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);
const num = (v) => typeof v === 'number' && Number.isFinite(v);

/* ---- 1. build, twice, from two fresh engines ------------------------------------------------------ */
let { engine, data } = G.loadData();
const before = { rom: sha(engine.rom), samples: sha(engine.samples), banks: JSON.stringify(data.banks), songs: JSON.stringify(data.songs.map((s) => [s.code, Array.from(s.bytes)])) };
/* wall-clock time, and the process's own CPU time (the figure the limit is checked on, so another job on the machine cannot fail the gate) */
const timed = (fn) => {
  const c0 = process.cpuUsage(), t0 = process.hrtime.bigint(), result = fn(), c1 = process.cpuUsage(c0);
  return { result, wall: Number(process.hrtime.bigint() - t0) / 1e6, cpu: (c1.user + c1.system) / 1e3 };
};
const run1 = timed(() => Catalog.build(engine, data)), catalog = run1.result, ms1 = run1.wall;
const second = G.loadData();
const run2 = timed(() => Catalog.build(second.engine, second.data)), catalog2 = run2.result, ms2 = run2.wall;
const text = JSON.stringify(catalog);
check(text === JSON.stringify(catalog2), 'identical output on two runs (two fresh engines)');
check(text === JSON.stringify(Catalog.build(engine, data)), 'identical output when built again from the same engine and data');
/* buildAsync (for the browser's cold start): the same catalog, with progress, yielding between steps */
const asyncCheck = (async () => {
  if (typeof Catalog.buildAsync !== 'function') { check(false, 'SF3Catalog.buildAsync exists'); return; }
  const seen = [];
  const got = await Catalog.buildAsync(engine, data, { onProgress: (p) => seen.push(p), every: 3 });
  check(text === JSON.stringify(got), 'buildAsync gives exactly what build gives');
  const last = seen[seen.length - 1] || {};
  check(seen.length > 600 && seen[0].stage === 'pieces' && last.stage === 'programs' && last.done === last.total, `buildAsync reports progress (${seen.length} steps, pieces then programs)`);
})();
check(before.rom === sha(engine.rom) && before.samples === sha(engine.samples) && before.banks === JSON.stringify(data.banks) &&
      before.songs === JSON.stringify(data.songs.map((s) => [s.code, Array.from(s.bytes)])), 'build leaves the engine and the game data untouched');
check(same(JSON.parse(text), catalog), 'the catalog is plain JSON (nothing is lost or changed by a JSON round trip)');
check(Math.min(run1.cpu, run2.cpu) < 1500, `build takes under 1.5 s (Node: ${ms1.toFixed(0)} ms and ${ms2.toFixed(0)} ms on the clock, ${run1.cpu.toFixed(0)} and ${run2.cpu.toFixed(0)} ms of CPU)`);
const source = fs.readFileSync(path.join(G.root, 'js', 'catalog.js'), 'utf8');
check(!/\brequire\(\s*['"](fs|path|os|child_process)['"]/.test(source) && !/\bdocument\./.test(source) && !/\bwindow\./.test(source) && !/Math\.random|Date\.now|new Date|performance\./.test(source) && !/run[\\/]music_editor|data[\\/]pack/.test(source),
  'catalog.js is headless: no fs, window, document, clock, random or private music data path in the source');
check(typeof Catalog.build === 'function' && typeof Catalog.suggest === 'function' && Catalog.NAMES && typeof Catalog.NAMES === 'object', 'SF3Catalog exposes build, suggest and NAMES');
check(same(catalog.families, FAMILIES), 'families are the seven the plan lists, in order');

/* ---- 2. programs, names, zones ---------------------------------------------------------------------- */
const keys = Object.keys(catalog.programs);
const expectedKeys = [];
data.banks.forEach((programs, b) => programs.forEach((p) => { if (p) expectedKeys.push(`${b}:${p.program}`); }));
check(same(keys, expectedKeys), `programs are every non-empty program of the ROM's banks in order, keyed 'bank:program' (${keys.length}: ${expectedKeys.length} expected)`);
const bank0 = keys.filter((k) => k.startsWith('0:')), effects = keys.filter((k) => !k.startsWith('0:'));
check(bank0.length === 59, `59 bank-0 programs (${bank0.length})`);
check(effects.length === 573 && effects.every((k) => [1, 2, 3, 4, 5, 6, 7, 15].includes(+k.split(':')[0])), `573 effect and voice programs, all in banks 1-7 and 15 (${effects.length})`);
const kits0 = bank0.filter((k) => catalog.programs[k].kit).map((k) => catalog.programs[k].program);
check(kits0.length === 12 && same(kits0, [0, 1, 2, 3, 4, 5, 6, 7, 8, 11, 12, 13]), `12 kits in bank 0: 0-8, 11, 12, 13 (${kits0.join(',')})`);
check(bank0.every((k) => catalog.programs[k].kit === data.banks[0][catalog.programs[k].program].kit && catalog.programs[k].sustained === data.banks[0][catalog.programs[k].program].sustained), 'kit and sustained agree with the ROM tables (js/gamedata.js)');

const lowerNames = new Set(), plain = /\b(bank|channel|cave|hex|opcode|op-code|simply)\b|!|0x[0-9a-f]+/i;
let namesOk = true, unique = true, dupe = '';
for (const k of keys) {
  const p = catalog.programs[k];
  const name = typeof p.name === 'string' ? p.name.trim() : '';
  if (!name || /^program\s*\d+$/i.test(name) || plain.test(name)) { namesOk = false; console.log(`FAIL ${k}: name ${JSON.stringify(p.name)} is empty, a bare "Program n", or not plain words`); }
  if (lowerNames.has(name.toLowerCase())) { unique = false; dupe = `${k} "${name}"`; }
  lowerNames.add(name.toLowerCase());
}
check(namesOk, 'every program has a non-empty name in plain words');
check(unique, `names are unique across all ${keys.length} programs${dupe ? ` (duplicate: ${dupe})` : ''}`);
const NAMES = Catalog.NAMES;
check(same(Object.keys(NAMES).map(Number).sort((a, b) => a - b), data.banks[0].filter(Boolean).map((p) => p.program)), 'NAMES has an entry for each of the 59 bank-0 programs and nothing else');
check(Object.values(NAMES).every((n) => Array.isArray(n) && typeof n[0] === 'string' && n[0].trim() && typeof n[1] === 'string' && /\.$/.test(n[1].trim()) && !plain.test(n[1])),
  'each NAMES entry is [short name, one plain sentence ending in a full stop, sure?]');
check(same(Object.keys(NAMES).filter((p) => NAMES[p][2] === true).map(Number).sort((a, b) => a - b), SHARED_FIVE), `sure: true only on 19 slap bass, 46 strings, 57 deep pad, 58 harpsichord-like, 60 bell`);
check(bank0.every((k) => catalog.programs[k].name === NAMES[catalog.programs[k].program][0] && catalog.programs[k].sure === (NAMES[catalog.programs[k].program][2] === true)), 'bank-0 names and sure flags come from NAMES');
check(typeof Catalog.nameOf === 'function' && Catalog.nameOf(catalog, 0, 20, { '0:20': 'Deep bass' }) === 'Deep bass' && Catalog.nameOf(catalog, 0, 20, {}) === NAMES[20][0] && Catalog.nameOf(catalog, 0, 20, null) === NAMES[20][0] &&
  Catalog.nameOf(catalog, 3, 17, { '0:20': 'Deep bass' }) === catalog.programs['3:17'].name, "the user's own names win (SF3Catalog.nameOf)");
check(bank0.every((k) => FAMILIES.slice(0, 6).includes(catalog.programs[k].family)) && effects.every((k) => catalog.programs[k].family === 'Effects & voices'), 'bank-0 programs sit in the six music families; effects and voices in "Effects & voices"');
check(FAMILIES.slice(0, 6).every((f) => bank0.some((k) => catalog.programs[k].family === f)), 'every music family has programs');
check(bank0.every((k) => catalog.programs[k].kit ? ['drums', 'perc'].includes(catalog.programs[k].role) : true) && keys.every((k) => ROLES.includes(catalog.programs[k].role)) && effects.every((k) => catalog.programs[k].role === 'fx'),
  'every program has a project role; kits are drums or perc; effects are fx');

/* zone tables = the ROM's instrument tables */
let zonesOk = 0, zonesBad = '';
for (const k of keys) {
  const [b, pn] = k.split(':').map(Number), rom = data.banks[b][pn], p = catalog.programs[k];
  let ok = p.bank === b && p.program === pn && Array.isArray(p.zones) && p.zones.length === rom.live.length && p.zones.length > 0;
  if (ok) rom.live.forEach((r, i) => {
    const z = p.zones[i], s = data.samples[r.sample];
    const want = { keyLow: r.keyLow, keyHigh: r.keyHigh, sample: r.sample, root: s ? s.root : null, looped: s ? s.looped : false, level: r.level, pan: r.pan === 255 ? null : r.pan, fine: r.fine, ringOut: r.flag === 1,
                   seconds: s ? +((s.end - s.start) / ROOT_RATE).toFixed(3) : 0,
                   envelope: { attack: r.envelope[0], decay: r.envelope[1], sustain: r.envelope[2], sustainRate: r.envelope[3], release: r.envelope[4] } };
    for (const f of Object.keys(want)) if (!same(z[f], want[f])) { ok = false; zonesBad = `${k} zone ${i} ${f}: ${JSON.stringify(z[f])} not ${JSON.stringify(want[f])}`; }
  });
  if (ok) zonesOk++;
}
check(zonesOk === keys.length, `every program's zones equal the ROM's instrument tables (${zonesOk} of ${keys.length}${zonesBad ? '; ' + zonesBad : ''})`);

/* ---- 3. what Capcom plays: a second interpreter, straight from the bytes -------------------------- */
const FOREVER = 64;                                             // a loop counted past 64 passes is heard as endless (D4 126 in music 12, 15, 19, 45)
const PARAMS = { 0xC1: 2, 0xC2: 1, 0xC3: 1, 0xC4: 1, 0xC5: 1, 0xC6: 1, 0xC7: 1, 0xC8: 1, 0xC9: 1, 0xCF: 1, 0xDC: 1, 0xDD: 1, 0xDE: 1, 0xDF: 1,
                 0xE0: 1, 0xE1: 1, 0xE2: 1, 0xE3: 1, 0xE4: 2, 0xE5: 2, 0xE6: 1, 0xE7: 1, 0xE8: 2, 0xCC: 2, 0xCD: 2 };
function interpret(bytes) {
  const u16 = (p) => (bytes[p] << 8) | bytes[p + 1];
  const offs = [];
  for (let k = 0; k < 16; k++) offs.push(u16(1 + 2 * k));
  const starts = offs.filter((o) => o).sort((a, b) => a - b);
  const notes = [];
  let extent = 0;
  for (let k = 0; k < 16; k++) {
    if (!offs[k]) continue;
    const end = starts[starts.indexOf(offs[k]) + 1] || bytes.length;
    const counters = [0, 0, 0, 0], loopAt = [0, 0, 0, 0], seen = new Set();
    const st = { bank: 0, program: 0 };
    let p = offs[k], tick = 0;
    while (p < end) {
      const state = p + ':' + counters.map((c) => (c > FOREVER ? 0 : c)).join(',');
      if (seen.has(state)) break;
      seen.add(state);
      let q = p, delta = 0;
      while (bytes[q] < 0x80) delta = delta * 128 + bytes[q++];
      tick += delta;
      const op = bytes[q++];
      if (op < 0xC0) {
        const n = bytes[q++] & 0x7F;
        let len = 0, c;
        do { c = bytes[q++]; len = len * 128 + (c & 0x7F); } while (c & 0x80);
        notes.push({ t: tick, n, bank: st.bank, program: st.program });
        p = q; continue;
      }
      if (op === 0xFF) break;
      if (op >= 0xD0 && op <= 0xD3) { loopAt[op - 0xD0] = q; p = q; continue; }
      if (op >= 0xD4 && op <= 0xD7) {
        const c = op - 0xD4, n = bytes[q++];
        if (counters[c]) { counters[c]--; p = counters[c] ? loopAt[c] : q; } else { counters[c] = n; p = loopAt[c]; }
        continue;
      }
      if (op >= 0xD8 && op <= 0xDB) { const c = op - 0xD8, off = u16(q); q += 2; if (counters[c] === 1) { counters[c] = 0; p = q + off; } else p = q; continue; }
      if (op === 0xCE) { const off = (u16(q) << 16) >> 16; q += 2; p = q + off; continue; }
      const a = [];
      for (let i = 0; i < (PARAMS[op] || 0); i++) a.push(bytes[q++]);
      if (op === 0xC2) st.bank = a[0] & 15; else if (op === 0xC4) st.program = a[0] & 127;
      p = q;
    }
    extent = Math.max(extent, tick);
  }
  return { notes, extent };
}
const expect = new Map(), extents = new Map();
for (const song of data.songs) {
  const r = interpret(song.bytes);
  extents.set(song.code, r.extent);
  for (const n of r.notes) {
    const k = `${n.bank}:${n.program}`;
    if (!expect.has(k)) expect.set(k, { notes: [], pieces: new Set(), rootRel: [], keyCount: new Map(), zoneCount: new Map() });
    const e = expect.get(k);
    e.notes.push(n.n); e.pieces.add(song.code); e.keyCount.set(n.n, (e.keyCount.get(n.n) || 0) + 1);
    const rom = data.banks[n.bank][n.program], zone = rom && rom.live.find((r2) => r2.keyHigh >= n.n);
    if (zone && data.samples[zone.sample]) e.rootRel.push(n.n - data.samples[zone.sample].root);
    if (zone) { const zi = rom.live.indexOf(zone); e.zoneCount.set(zi, (e.zoneCount.get(zi) || 0) + 1); }
  }
}
let rangesOk = 0, rangeBad = '', usageOk = 0, usageBad = '', natOk = 0, natBad = '', zoneOk = 0, zoneBad = '';
for (const k of keys) {
  const p = catalog.programs[k], e = expect.get(k);
  if (!e) {
    if (p.range === null && p.usage && p.usage.notes === 0 && p.usage.pieces.length === 0 && p.naturalNote === null && p.zones.every((z) => z.notes === 0)) { rangesOk++; usageOk++; natOk++; zoneOk++; } else rangeBad = `${k}: Capcom never plays it, so its range must be null and its usage empty`;
    continue;
  }
  if (p.zones.every((z, i) => z.notes === (e.zoneCount.get(i) || 0))) zoneOk++; else zoneBad = `${k}: zone notes ${p.zones.map((z) => z.notes)} not ${p.zones.map((z, i) => e.zoneCount.get(i) || 0)}`;
  const want = { low: Math.min(...e.notes), high: Math.max(...e.notes), median: median(e.notes), typicalLow: quantile(e.notes, 0.02), typicalHigh: quantile(e.notes, 0.98) };
  if (p.range && same(p.range, want)) rangesOk++; else rangeBad = `${k}: ${JSON.stringify(p.range)} not ${JSON.stringify(want)}`;
  const pieces = Array.from(e.pieces).sort((a, b) => a - b);
  if (p.usage && p.usage.notes === e.notes.length && same(p.usage.pieces, pieces)) usageOk++; else usageBad = `${k}: ${JSON.stringify(p.usage && [p.usage.notes, p.usage.pieces])} not ${JSON.stringify([e.notes.length, pieces])}`;
  if (p.naturalNote === (e.rootRel.length ? median(e.rootRel) : null)) natOk++; else natBad = `${k}: natural note ${p.naturalNote} not ${median(e.rootRel)}`;
}
check(rangesOk === keys.length, `range (lowest, highest, median, typical 2%-98%) equals what the 49 pieces play, read again from the bytes: ${rangesOk} of ${keys.length}${rangeBad ? '; ' + rangeBad : ''}`);
check(usageOk === keys.length, `usage.notes and usage.pieces equal the second interpreter's: ${usageOk} of ${keys.length}${usageBad ? '; ' + usageBad : ''}`);
check(natOk === keys.length, `naturalNote = median of (note - root of the zone that sounds it): ${natOk} of ${keys.length}${natBad ? '; ' + natBad : ''}`);
check(zoneOk === keys.length, `each zone's note count is the notes the driver sounds from that zone (the first zone whose highest key is not below the note): ${zoneOk} of ${keys.length}${zoneBad ? '; ' + zoneBad : ''}`);
check(bank0.every((k) => catalog.programs[k].range !== null), 'Capcom plays all 59 music programs');
check(catalog.programs['15:12'].range && catalog.programs['15:12'].usage.pieces.join() === '5', "music 5's bank-15 voice is in the catalog with its piece");

/* the driver itself: every key-on of every piece, its program and its note */
{
  const observed = new Map();
  const pieces = data.songs.slice(0, quick ? 10 : data.songs.length);
  for (const song of pieces) {
    const need = extents.get(song.code) + 96;
    const e = new G.Engine(G.pack); e.request(song.code); e.keyOns = [];
    let ticks = 0, f = 0;
    while (ticks < need && f < 40000) {
      const first = e.keyOns.length, n = e.tick();
      ticks += e.tempo() / 256;
      for (let i = first; i < e.keyOns.length; i++) {
        const ch = e.channel(e.keyOns[i][1]), k = `${ch.bank}:${ch.program}`;
        if (!observed.has(k)) observed.set(k, { low: 999, high: -1, pieces: new Set() });
        const o = observed.get(k);
        o.low = Math.min(o.low, ch.note); o.high = Math.max(o.high, ch.note); o.pieces.add(song.code);
      }
      e.chip(n); f++;
    }
  }
  /* all 49 pieces: equal. --quick (a few pieces only): what the driver plays lies inside the catalog's range and pieces */
  const codes = new Set(pieces.map((s) => s.code));
  let ok = 0, bad = '';
  for (const k of keys) {
    const p = catalog.programs[k], o = observed.get(k), mine = p.usage.pieces.filter((c) => codes.has(c)), theirs = o ? Array.from(o.pieces).sort((a, b) => a - b) : [];
    const good = quick ? !o || (p.range && o.low >= p.range.low && o.high <= p.range.high && theirs.every((c) => p.usage.pieces.includes(c)))
      : o ? p.range && p.range.low === o.low && p.range.high === o.high && same(mine, theirs) : mine.length === 0;
    if (good) ok++; else bad = `${k}: catalog ${JSON.stringify(p.range && [p.range.low, p.range.high])} ${mine} / driver ${JSON.stringify(o && [o.low, o.high, Array.from(o.pieces)])}`;
  }
  check(ok === keys.length, `playing ${pieces.length} pieces in the driver: every program's lowest and highest note and its pieces ${quick ? 'lie inside' : 'equal'} the catalog's range (${ok} of ${keys.length}${bad ? '; ' + bad : ''})`);
}

/* ---- 4. tuning = checks/tuning.js ----------------------------------------------------------------- */
{
  const out = cp.execFileSync(process.execPath, [path.join(G.root, 'checks', 'tuning.js')], { encoding: 'utf8', windowsHide: true, cwd: G.root });
  const rows = out.split(/\r?\n/).map((l) => /^program\s+(\d+) keys (\d+)-(\d+)\s+sample\s+(\d+) (loop|once) (.*)$/.exec(l)).filter(Boolean).map((m) => {
    const c = /^([+-]?\d+) cents \(confidence ([\d.]+)\)$/.exec(m[6]);
    return { program: +m[1], low: +m[2], high: +m[3], sample: +m[4], cents: c ? +c[1] : null, conf: c ? +c[2] : null };
  });
  let matched = 0, bad = '', nonKitZones = 0;
  for (const k of bank0) {
    const p = catalog.programs[k];
    p.zones.forEach((z) => {
      if (p.kit) { if (z.tuningCents !== null) bad = `${k}: a kit zone has tuning`; return; }
      nonKitZones++;
      const r = rows.find((x) => x.program === p.program && x.sample === z.sample && x.low === z.keyLow && x.high === z.keyHigh);
      const good = r && (r.cents === null ? z.tuningCents === null : num(z.tuningCents) && Math.abs(z.tuningCents - r.cents) <= 1 && num(z.tuningConfidence) && Math.abs(z.tuningConfidence - r.conf) <= 0.01);
      if (good) matched++; else bad = `${k} keys ${z.keyLow}-${z.keyHigh}: ${z.tuningCents} (${z.tuningConfidence}) against tuning.js ${r ? r.cents + ' (' + r.conf + ')' : 'no row'}`;
    });
  }
  check(rows.length > 55 && matched === nonKitZones && rows.length === nonKitZones, `tuning equals checks/tuning.js zone by zone within 1 cent: ${matched} of ${nonKitZones} zones, tuning.js printed ${rows.length}${bad ? '; ' + bad : ''}`);
  const primaryOk = bank0.every((k) => {
    const p = catalog.programs[k];
    if (p.kit) return p.tuningCents === null && p.tuningConfidence === null;
    const zone = p.zones.reduce((a, z) => (z.notes > a.notes ? z : a), p.zones[0]);
    return p.tuningCents === zone.tuningCents && p.tuningConfidence === zone.tuningConfidence;
  });
  check(primaryOk, "a program's tuning is that of the zone Capcom plays most (the first zone when unused); kits have none");
}

/* ---- 5. break bars = style/breaks.js ---------------------------------------------------------------- */
const Breaks = require(path.join(G.root, 'style', 'breaks.js'));
const Sounds = require(path.join(G.root, 'style', 'sounds.js'));
const lib = Breaks.library();
{
  check(same(Object.keys(catalog.breaks), BREAK_KITS.map(String)), 'break bars exist for kits 0 1 2 3 4 10 11 12 13 and no others');
  let ok = 0, bad = '';
  for (const k of BREAK_KITS) {
    const mine = catalog.breaks[k], want = lib.kits[k], prog = catalog.programs[`0:${k}`];
    const sig = (b) => `${b.piece}|${b.notes.map((x) => `${x.t}:${x.n}:${x.len}`).join(' ')}`;
    const goal = want.patterns.map((x) => `${x.song}|${x.sig}`);
    const bars = mine && Array.isArray(mine.bars) ? mine.bars : [];
    const shaped = bars.every((b) => num(b.piece) && num(b.bpm) && Number.isInteger(b.bar) && b.bar >= 0 && Array.isArray(b.notes) && b.notes.length > 0 && b.notes.every((x) => Number.isInteger(x.t) && x.t >= 0 && x.t < 192 && Number.isInteger(x.n) && x.len > 0 && Number.isInteger(x.v) && x.v >= 1 && x.v <= 127));
    const sameBars = same(bars.map(sig), goal);
    /* the bar's own first occurrence, velocities doubled onto the project's 1..127 scale; the piece and its tempo as style/breaks.js has them */
    const velocities = sameBars && bars.every((b, i) => b.notes.every((x, j) => x.v === Math.max(1, want.patterns[i].notes[j].v * 2)) && b.bpm === want.patterns[i].bpm);
    if (mine && mine.tempo === want.tempo && prog.tempo === want.tempo && prog.breakKit === true && shaped && bars.length > 0 && sameBars && velocities) ok++;
    else bad = `kit ${k}: tempo ${mine && mine.tempo}/${prog && prog.tempo} vs ${want.tempo}; ${bars.length} bars vs ${goal.length}${shaped ? '' : ' (bad shape)'}${velocities ? '' : ' (velocities or piece tempos differ)'}`;
  }
  check(ok === BREAK_KITS.length, `break bars (their notes, pieces, order, velocities as 1..127) and tempos equal style/breaks.js for all nine kits: ${ok} of 9${bad ? '; ' + bad : ''}`);
  check(bank0.every((k) => (BREAK_KITS.includes(catalog.programs[k].program)) === (catalog.programs[k].breakKit === true) && (catalog.programs[k].tempo !== null) === (catalog.programs[k].breakKit === true)), 'breakKit and tempo are set on exactly the nine break kits');
  check(effects.every((k) => catalog.programs[k].tempo === null && !catalog.programs[k].breakKit), 'no effect program is a break kit');
  const total = BREAK_KITS.reduce((a, k) => a + catalog.breaks[k].bars.length, 0);
  check(total === BREAK_KITS.reduce((a, k) => a + lib.kits[k].patterns.length, 0) && total > 300, `Capcom's distinct break bars: ${total} in all`);
}

/* ---- 6. kit keys and tone = style/sounds.js ---------------------------------------------------------- */
{
  let keysOk = 0, keysBad = '', kitCount = 0, toneOk = 0, toneBad = '';
  const GM6 = { 36: 'kick', 38: 'snare', 39: 'clap', 42: 'closed hat', 45: 'long low boom', 46: 'open hat', 49: 'crash', 51: 'ride', 54: 'tambourine', 56: 'bell' };
  for (const k of keys) {
    const p = catalog.programs[k], rom = data.banks[p.bank][p.program];
    if (!p.kit) { if (p.keys !== null) keysBad = `${k}: only kits have keys`; else keysOk++; continue; }
    kitCount++;
    /* which keys a kit has: 36 to 72 as its zones sound them (the catch-all zone from 0 only by its top key), leaving out held, looped tones;
     * a break kit keeps every key up to 48, and above that one key per beat piece (the root key minus 20, within its zone) */
    const want = [];
    for (const r of rom.live) {
      const s = data.samples[r.sample];
      if (!s || s.looped) continue;
      for (let key = Math.max(r.keyLow, 36); key <= Math.min(r.keyHigh, 72); key++) {
        if (r.keyLow < 36 && key !== r.keyHigh) continue;
        if (p.breakKit && key > 48 && key !== Math.max(r.keyLow, Math.min(r.keyHigh, s.root - 20))) continue;
        want.push(key);
      }
    }
    let good = Array.isArray(p.keys) && p.keys.length >= 1 && same(p.keys.map((x) => x.key), want);
    if (!good) keysBad = `${k}: keys ${p.keys && p.keys.map((x) => x.key)} not ${want}`;
    if (good) {
      const labels = new Set();
      let last = -1;
      for (const kk of p.keys) {
        const zone = rom.live.find((r) => r.keyHigh >= kk.key);
        const s = zone && data.samples[zone.sample];
        good = good && zone && s && kk.key > last && typeof kk.label === 'string' && kk.label.trim() && !labels.has(kk.label) && KEY_ROLES.includes(kk.role) && kk.sample === zone.sample && num(kk.seconds) && kk.seconds > 0 && num(kk.uses);
        labels.add(kk.label); last = kk.key;
        if (good && p.bank === 0) {                                 // the slice analysis, at the pitch the key plays
          const m = Sounds.slice(s, ROOT_RATE * Math.pow(2, (kk.key - s.root) / 12));
          good = kk.seconds === m.seconds && kk.sound === m.label;
        }
        if (!good) { keysBad = `${k} key ${kk.key}: ${JSON.stringify(kk)}`; break; }
      }
    }
    if (good) keysOk++;
  }
  check(keysOk === keys.length, `kit keys: sorted, unique labels, the sample the driver plays, length and slice analysis equal style/sounds.js at each key's pitch; non-kits have none (${keysOk} of ${keys.length}${keysBad ? '; ' + keysBad : ''})`);
  check(kitCount >= 12, `${kitCount} kits in all banks`);
  /* how often Capcom plays each key (all 49 pieces, read from the bytes) and where in the bar (style/breaks.js's kick / snare / ghost) */
  let usesOk = 0, usesAll = 0, capOk = 0, capAll = 0, capBad = '';
  for (const k of keys) {
    const p = catalog.programs[k];
    if (!p.keys) continue;
    const e = expect.get(k);
    for (const kk of p.keys) {
      usesAll++;
      if (kk.uses === (e ? e.keyCount.get(kk.key) || 0 : 0)) usesOk++;
      if (p.breakKit) {
        capAll++;
        const ref = lib.kits[p.program].keys[kk.key];
        if (ref && kk.capcom === ref.role) capOk++; else capBad = `${k} key ${kk.key}: ${kk.capcom} against ${ref && ref.role}`;
      } else if (kk.capcom !== null) capBad = `${k} key ${kk.key}: only break kits have a placement role`;
    }
  }
  check(usesOk === usesAll && usesAll > 100, `every kit key's uses is the number of notes Capcom plays on it, read from the bytes (${usesOk} of ${usesAll} keys)`);
  check(capOk === capAll && capAll > 50 && !capBad, `break kit keys: Capcom's placement role (kick / snare / ghost) equals style/breaks.js (${capOk} of ${capAll} keys)${capBad ? '; ' + capBad : ''}`);
  const slicesOk = [0, 1, 2, 3, 4, 11, 12, 13].every((n) => {
    const ks = catalog.programs[`0:${n}`].keys;
    return [41, 42, 43, 44].every((key) => { const e = ks.find((x) => x.key === key); return e && e.label === `slice ${key - 40}`; }) && ks.filter((x) => /^slice \d$/.test(x.label)).every((x) => x.key >= 41 && x.key <= 49 && x.label === `slice ${x.key - 40}`);
  });
  check(slicesOk, 'break kits name their slices "slice 1" ... "slice 8" on keys 41 to 48 (kits 1 and 4 have a ninth slice-length piece on key 49), in loop order');
  check([0, 2, 11, 13].every((n) => [41, 42, 43, 44, 45, 46, 47, 48].every((key) => catalog.programs[`0:${n}`].keys.some((x) => x.key === key))) && catalog.programs['0:12'].keys.length === 4,
    'break kits 0, 2, 11 and 13 have all eight slices (keys 41 to 48); kit 12 has four');
  check(Object.keys(GM6).every((key) => { const e = catalog.programs['0:6'].keys.find((x) => x.key === +key); return e && e.label === GM6[key]; }), 'kit 6 uses the GM names from 02_DRIVER section 5: 36 kick, 38 snare, 39 clap, 42 closed hat, 45 long low boom, 46 open hat, 49 crash, 51 ride, 54 tambourine, 56 bell');
  check(catalog.programs['0:6'].keys.find((x) => x.key === 36).role === 'kick' && catalog.programs['0:6'].keys.find((x) => x.key === 38).role === 'snare' && ['hat'].includes(catalog.programs['0:6'].keys.find((x) => x.key === 42).role), 'kit 6: the kick, snare and hat keys have those roles');
  check([0, 1, 2, 3, 4, 11, 12].every((n) => catalog.programs[`0:${n}`].naturalNote === -20), 'break kits 0 1 2 3 4 11 12 are played 20 semitones under their root key (02_DRIVER section 5)');
  check(catalog.programs['0:10'].breakKit && catalog.programs['0:10'].keys === null, 'program 10 (Ryu\'s beat pieces) is a break kit that is played as pitched notes: no key map');

  for (const k of keys) {
    const p = catalog.programs[k], t = p.tone;
    let good = t && num(t.note) && num(t.seconds) && t.seconds > 0 && num(t.attackMs) && num(t.centroidHz) && num(t.peakDb) && num(t.rmsDb) && typeof t.looped === 'boolean' && (t.looped ? t.decayMs === null : num(t.decayMs));
    if (good && p.bank === 0) {
      const s = data.samples[t.sample], m = Sounds.tone(s, t.note);
      const zone = p.zones.find((z) => z.sample === t.sample);
      good = zone && t.note >= zone.keyLow && t.note <= zone.keyHigh && m.attackMs === t.attackMs && m.decayMs === t.decayMs && m.seconds === t.seconds && m.looped === t.looped && Math.abs(m.centroidHz - t.centroidHz) <= 1;
    }
    if (good) toneOk++; else toneBad = `${k}: ${JSON.stringify(t)}`;
  }
  check(toneOk === keys.length, `tone (attack, decay, length, centroid) equals style/sounds.js's tone at the same note, centroid within 1 Hz; effects have length and loudness (${toneOk} of ${keys.length}${toneBad ? '; ' + toneBad : ''})`);
}

/* ---- 7. suggest(): static, and Capcom's own choices ------------------------------------------------- */
{
  const src = fs.readFileSync(path.join(G.root, 'style', 'arrange3s.js'), 'utf8');
  const roleTable = /const ROLE = (\{[\s\S]*?\n\});/.exec(src), pick = /(function pickProgram\([\s\S]*?\n\})/.exec(src);
  check(!!roleTable && !!pick, 'style/arrange3s.js: ROLE and pickProgram found in its source');
  const ROLE = new Function(`return ${roleTable[1]}`)(), pickProgram = new Function(`${pick[1]}; return pickProgram;`)();
  const asRole = (r) => { const R = ROLE[r]; return { volume: R.vol, expression: R.expr, velocity: R.v * 2, pan: R.pan, echo: R.echo ? { delay: R.echo.delay, level: R.echo.level } : null }; };
  const shapeOk = (s) => s && s.bank === 0 && Number.isInteger(s.program) && num(s.volume) && num(s.expression) && num(s.velocity) && num(s.pan) && s.velocity >= 1 && s.velocity <= 127 && s.volume >= 0 && s.volume <= 127 &&
    (s.echo === null || (num(s.echo.delay) && s.echo.delay > 0 && num(s.echo.level) && s.echo.level > 0 && s.echo.level <= 1)) && Object.keys(s).sort().join() === 'bank,echo,expression,pan,program,velocity,volume';
  let pitchedOk = true, shapes = true, exists = true, bad = '';
  for (const role of ROLES) for (let gm = -1; gm < 128; gm++) {
    const s = Catalog.suggest(role, gm);
    if (!shapeOk(s)) { shapes = false; bad = `${role} ${gm}`; }
    if (!catalog.programs[`0:${s && s.program}`]) exists = false;
    if (['bass', 'chords', 'pad', 'lead', 'arp'].includes(role)) {
      const R = asRole(role);
      if (s.program !== pickProgram(role, gm) || !same({ volume: s.volume, expression: s.expression, velocity: s.velocity, pan: s.pan, echo: s.echo }, R)) { pitchedOk = false; bad = `${role} ${gm}: ${JSON.stringify(s)}`; }
    }
  }
  check(shapes, `suggest(role, gm) returns { bank: 0, program, volume, expression, velocity, pan, echo } for every role and GM program${bad && !shapes ? ' (' + bad + ')' : ''}`);
  check(exists, 'every suggested program exists in the catalog');
  check(pitchedOk, `bass, chords, pad, lead and arp: the program is style/arrange3s.js's pickProgram and the levels are its ROLE entry for every GM program 0-127 and none${bad && !pitchedOk ? ' (' + bad + ')' : ''}`);
  const d0 = Catalog.suggest('drums', -1), p0 = Catalog.suggest('perc', -1), f0 = Catalog.suggest('fx', -1);
  check(catalog.programs[`0:${d0.program}`].kit && same({ v: d0.volume, e: d0.expression, p: d0.pan }, { v: ROLE.break.vol, e: ROLE.break.expr, p: ROLE.break.pan }) && catalog.programs[`0:${d0.program}`].breakKit, "drums with no GM program: a break kit at Capcom's break levels");
  check(Catalog.suggest('drums', 25).program === 6 && same(Catalog.suggest('drums', 25).volume, ROLE.kick.vol), 'drums on an electronic GM kit (24-31): kit 6 (it follows GM keys) at the kick levels');
  check(p0.program === 6 && p0.volume === ROLE.perc.vol && p0.pan === ROLE.perc.pan && p0.echo === null, 'perc: kit 6 at the perc levels');
  check(catalog.programs[`0:${f0.program}`].role === 'fx', 'fx: a program whose role is fx');
  const a = Catalog.suggest('lead', 80), b = Catalog.suggest('lead', 80);
  a.echo.delay = 999; a.volume = 0;
  check(same(b, Catalog.suggest('lead', 80)) && Catalog.suggest('lead', 80).echo.delay !== 999, 'suggest gives a fresh object each time (changing one does not change the next)');
  check(same(Catalog.suggest('lead', null), Catalog.suggest('lead', -1)) && same(Catalog.suggest('lead', undefined), Catalog.suggest('lead', -1)) && Catalog.suggest(null, -1).program === Catalog.suggest('lead', -1).program, 'a missing GM program or role is read as "none given" (lead is the default role)');
  let threw = false;
  try { Catalog.suggest('banjo', 0); } catch (e) { threw = true; }
  check(threw, 'an unknown role is an error');
}

/* ---- 8. roles: Capcom's medians, and the facts the plan states ------------------------------------- */
{
  check(same(Object.keys(catalog.roles), ROLES), 'roles has the eight project roles');
  check(ROLES.every((r) => { const x = catalog.roles[r]; return x && [x.volume, x.expression, x.pan].every((v) => Number.isInteger(v) && v >= 0 && v <= 127) && Number.isInteger(x.velocity) && x.velocity >= 1 && x.velocity <= 127 &&
    (x.echo === null || (num(x.echo.delay) && num(x.echo.level))) && Array.isArray(x.programs) && num(x.tracks) && x.tracks > 0; }), 'each role has volume, expression, velocity, pan, echo, its programs and the tracks it was measured on');
  const U = (n) => catalog.programs[`0:${n}`].usage;
  const levels = { 18: [75, 75], 19: [75, 70], 20: [75, 64], 37: [85, 70], 39: [56, 58], 41: [64, 64], 43: [60, 58], 46: [64, 64], 57: [60, 64], 60: [90, 90] };
  const gotLevels = Object.keys(levels).filter((n) => U(n).volume === levels[n][0] && U(n).expression === levels[n][1]);
  check(gotLevels.length === Object.keys(levels).length, `Capcom's usual volume/expression for the ten programs 02_DRIVER section 5 lists: ${gotLevels.length} of 10 as stated${gotLevels.length < 10 ? ' (' + Object.keys(levels).filter((n) => !gotLevels.includes(n)).map((n) => `${n}: ${U(n).volume}/${U(n).expression} not ${levels[n].join('/')}`).join('; ') + ')' : ''}`);
  const looped = [18, 21, 37, 38, 39, 41, 42, 43].map((n) => catalog.programs[`0:${n}`]).filter((p) => p.tuningConfidence >= 0.7).map((p) => p.tuningCents);
  check(looped.length >= 6 && Math.max(...looped) - Math.min(...looped) <= 10, `looped instruments agree with each other in tune (02_DRIVER section 5): ${looped.join(', ')} cents`);
  const echoed = (n) => U(n).echoed;
  check([37, 39, 46, 57].every((n) => echoed(n) >= 3) && echoed(37) > echoed(20), `Capcom echoes pads 46/57/39 and stabs 37 most (style/README.txt): echoed tracks ${[37, 39, 46, 57, 20].map((n) => n + ':' + echoed(n)).join(' ')}`);
  check(Object.values(catalog.programs).every((p) => p.usage && num(p.usage.notes) && num(p.usage.tracks) && num(p.usage.echoed) && num(p.usage.glided) && Array.isArray(p.usage.pieces) &&
    (p.usage.basis === null ? p.usage.tracks === 0 : ['main', 'any', 'other'].includes(p.usage.basis) && p.usage.tracks > 0)), 'usage has pieces, notes, tracks, echoed and glided on every program; its basis is main, any or other, or null when no track is read');
  check(bank0.every((k) => catalog.programs[k].usage.basis !== null && num(catalog.programs[k].usage.volume) && num(catalog.programs[k].usage.expression)) && Number.isInteger(catalog.version) && catalog.version >= 1 && Catalog.VERSION === catalog.version,
    'every music program has Capcom levels (its own tracks, else any track that plays it, else the short pieces\'); the catalog carries a version for caches');
  /* a role's tracks are the original tracks whose usual program has that role */
  const roleTracks = (r) => bank0.map((k) => catalog.programs[k]).filter((p) => p.role === r && p.usage.basis === 'main').reduce((a, p) => a + p.usage.tracks, 0);
  check(ROLES.every((r) => catalog.roles[r].tracks === roleTracks(r)) && ROLES.every((r) => same(catalog.roles[r].programs, bank0.map((k) => catalog.programs[k]).filter((p) => p.role === r && p.usage.basis === 'main').map((p) => p.program))),
    'each role is measured on the tracks whose usual program has that role, and lists those programs');
}

/* ---- 9. levels, echoes, doubles and glides = style/techniques.js ------------------------------------- */
{
  /* the study is run from a copy of the script that writes into this gate's scratch folder (the original writes into out/style) */
  const scratch = path.join(G.root, 'out', 'tests', 'G15', `techniques_ref_${process.pid}`);     // one folder per run, removed below
  fs.mkdirSync(scratch, { recursive: true });
  const original = fs.readFileSync(path.join(G.root, 'style', 'techniques.js'), 'utf8');
  const a = "const root = path.join(__dirname, '..');", b = "const OUT = path.join(root, 'out', 'style');";
  const runnable = check(original.includes(a) && original.includes(b), 'style/techniques.js can be run from a copy that writes into this gate\'s scratch folder');
  if (runnable) {
    const copy = path.join(scratch, 'techniques_copy.js');
    fs.writeFileSync(copy, original.replace(a, `const root = ${JSON.stringify(G.root)};`).replace(b, `const OUT = ${JSON.stringify(scratch)};`));
    cp.execFileSync(process.execPath, [copy], { encoding: 'utf8', windowsHide: true, maxBuffer: 1 << 26 });
    const lines = fs.readFileSync(path.join(scratch, 'techniques.txt'), 'utf8').split(/\r?\n/);
    const head = /^Pieces studied: (\d+), tracks (\d+); copies (\d+) \((\d+) doubles, (\d+) echoes\)/.exec(lines.find((l) => l.startsWith('Pieces studied')) || '');
    const study = catalog.study;
    check(!!head && study && study.pieces === +head[1] && study.tracks === +head[2] && study.doubles === +head[4] && study.echoes === +head[5],
      `the echo and double search finds what style/techniques.js finds: ${head ? `${head[1]} pieces, ${head[2]} tracks, ${head[4]} doubles, ${head[5]} echoes` : 'no summary line'} (catalog: ${study && JSON.stringify(study)})`);
    const start = lines.findIndex((l) => l.startsWith('Program use'));
    let rows = 0, same_ = 0, bad = '';
    for (const l of lines.slice(start + 1)) {
      const m = /^\s*(\d+):\s+(\d+)\s+(\d+) \|\s+(\d+) \((\d+)-(\d+)\) \|\s+(\d+) \|\s+(\d+)\s+(\d+) \| (\d+) (\d+) (\d+)/.exec(l);
      if (!m) continue;
      rows++;
      const u = catalog.programs[`0:${m[1]}`].usage, want = { tracks: +m[2], noteLength: +m[7], volume: +m[8], expression: +m[9], echoed: +m[10], glided: +m[11] };
      if (u.basis === 'main' && Object.keys(want).every((f) => u[f] === want[f])) same_++; else bad = `${m[1]}: ${JSON.stringify([u.basis, u.tracks, u.noteLength, u.volume, u.expression, u.echoed, u.glided])} not ${JSON.stringify(Object.values(want))}`;
    }
    check(rows >= 35 && same_ === rows, `usage (tracks, note length, volume, expression, echoed tracks, glided tracks) equals style/techniques.js's table for its ${rows} programs: ${same_} of ${rows}${bad ? '; ' + bad : ''}`);
  }
  fs.rmSync(scratch, { recursive: true, force: true });
}

asyncCheck.then(() => done(`catalog of ${keys.length} programs (${bank0.length} music, ${effects.length} effects and voices) built in ${ms1.toFixed(0)} ms / ${ms2.toFixed(0)} ms (Node); ${quick ? 'driver cross-check on 10 pieces' : 'driver cross-check on all 49 pieces'}`));
