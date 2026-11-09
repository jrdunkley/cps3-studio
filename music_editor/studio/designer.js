/* Instrument Designer (package B7; docs/plan/wp/B7_designer.md, 05_UX.md section 5, 04_FORMATS.md section 4).
 * Sound design on a board whose sample ROM is full: cut, loop, tune and shape the game's own audio into new
 * instruments. Everything about an instrument is in js/bank.js (SF3Bank); this file is the interface and the
 * undoable edits behind it. The instruments live in project.bank and change only through ctx.edit / Studio.edit.
 *
 * Registers: Studio.view({ id: 'designer' }), self-test checks (group "designer"), Kit actions "designer.*".
 * Studio.designer (D) is the same code the screen uses, for the self-test and for other views:
 *   D.create({ name, sample, preset })       a new instrument from one of the game's 733 sounds (preset: plain | pluck | pad | loop)
 *   D.rename / duplicate / remove (n)        instrument number n (0..127; the part's "program" in bank 8)
 *   D.setZone(n, z, patch) / setView / setSource / moveSplit / addZone / removeZone
 *   D.findLoop(n, z, 'cycle' | 'long')       the Wave Miner      D.detectPitch(n, z)      D.slice(n, z, opts)
 *   D.exportData(numbers) / importData(obj)  *.sf3bank.json
 *   D.space() / D.needs(project)             the figures the two always-visible texts show; what a ROM must do
 *   D.measure(n, z)                          the envelope of a zone, measured in the driver
 *   D.sources()                              the picker's rows: all of the game's sounds, grouped
 * Optional input from Deliver (package B8): Studio.musicSpace = { total, free } once a ROM build has been loaded;
 * the space line then shows the real free figure.
 * Words the player sees follow 05_UX section 8: never "bank", "cave" or hex except under "Under the hood".
 */
(function (g) {
  'use strict';
  const S = g.Studio, K = g.Kit, el = K.el, clamp = K.clamp, copy = (x) => JSON.parse(JSON.stringify(x));
  const D = S.designer = {};
  const SLOT = 8, MAX_INSTRUMENTS = 128, FRAME = 59.59949, MIN_CUT = 8;
  const MID = '·', EN = '–', EM = '—', ELL = '…', MINUS = '−';
  const Bk = () => g.SF3Bank, Eng = () => g.SF3Engine;
  const samples = () => Eng().preparePack(S.pack).samples;                 /* Int8Array, in playing order */
  const caveOf = () => Eng().preparePack(S.pack).cave;                     /* { preview, audition, bank, end } */
  const table = () => S.data.samples;                                      /* [{ index, start, loop, end, root, looped }] with holes */
  const totalBytes = () => Math.min(Bk().SAMPLE_BYTES, samples().length);
  const proj = () => S.state.project;
  const slotOf = (bank) => (bank && bank.slot !== undefined && bank.slot !== null ? bank.slot : SLOT);
  const fail = (m) => { throw new Error(m); };
  const kb = (n) => K.fmt.bytes(n, { kb: true });
  const noteName = (n) => K.fmt.note(n);
  const tip = (name, text, note) => [name, text, note].filter(Boolean).join('|');
  const listOf = (bank) => (bank && bank.programs ? Object.keys(bank.programs).filter((k) => /^\d+$/.test(k)).map(Number).sort((a, b) => a - b) : []);
  const zoneLow = (regions, z) => (z === 0 ? 0 : regions[z - 1].keyHigh + 1);
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many || one + 's'}`;

  /* ---- the envelope, in plain units ------------------------------------------------------------------------- */
  /* Rates are table indices 0..63 (02_DRIVER section 4): a rate takes 65536 / (table[rate] + 1) frames to travel the full
   * level (attack: at full velocity). The tables are read from the driver's own ROM. */
  let rates = null;
  function rateTables() {
    if (rates) return rates;
    const e = new (Eng().Engine)(S.pack), A = [], B = [];
    const pa = e.r32(0x02078CE8) || 0x0660CBF8, pb = e.r32(0x02078CEC) || 0x0660CC78;
    for (let i = 0; i < 64; i++) { A.push(e.rom16(pa + 2 * i)); B.push(e.rom16(pb + 2 * i)); }
    return (rates = { A, B });
  }
  D.attackSeconds = (rate) => 65536 / (rateTables().A[clamp(rate, 0, 63)] + 1) / FRAME;
  D.fallSeconds = (rate) => 65536 / (rateTables().B[clamp(rate, 0, 63)] + 1) / FRAME;
  D.decaySeconds = (rate, sustain) => D.fallSeconds(rate) * (1 - (sustain + 1) / 128);
  function seconds(t) {
    if (t < 0.03) return 'instant';
    if (t < 0.0995) return `${Math.round(t * 1000)} ms`;
    if (t < 10) return `${t.toFixed(2)} s`;
    if (t < 60) return `${t.toFixed(1)} s`;
    return 'over a minute';
  }
  const ENV = {
    plain: { attack: 63, decay: 63, sustain: 127, sustainRate: 1, release: 63 },
    pluck: { attack: 63, decay: 46, sustain: 14, sustainRate: 34, release: 48 },
    pad: { attack: 38, decay: 63, sustain: 127, sustainRate: 1, release: 36 },
  };
  D.presets = ENV;
  const ENV_KEYS = ['attack', 'decay', 'sustain', 'sustainRate', 'release'];

  /* ---- the game's sounds, grouped, with a peak cache for thumbnails ------------------------------------------ */
  let sourceCache = null;
  D.sources = function () {
    const catalog = S.state.catalog, key = catalog || 'none';
    if (sourceCache && sourceCache.key === key) return sourceCache;
    const rows = [], byIndex = new Map(), seen = new Set(), T = table();
    S.data.banks.forEach((list, b) => {
      const group = b === 0 ? 'music' : 'fx';
      for (const prog of list) {
        if (!prog) continue;
        const info = catalog && catalog.programs[`${b}:${prog.program}`], name = info ? info.name : `Instrument ${prog.program}`;
        let headed = false;
        prog.live.forEach((r, zi) => {
          const s = T[r.sample];
          if (!s || seen.has(r.sample)) return;
          seen.add(r.sample);
          if (group === 'music' && !headed) { headed = true; rows.push({ kind: 'head', group, title: name, sub: info && info.kit ? 'a different sound on each key' : info && info.sustained ? 'sustains' : 'plays once' }); }
          const keyInfo = info && info.keys && info.keys.find((k) => k.sample === r.sample);
          const parts = [];
          if (prog.live.length > 1) parts.push(keyInfo ? keyInfo.label : `zone ${zi + 1} of ${prog.live.length} (${noteName(r.keyLow)}${EN}${noteName(Math.min(127, r.keyHigh))})`);
          parts.push(s.looped ? 'loops' : 'plays once');
          const title = group === 'music' ? (prog.live.length > 1 ? `${name} ${MID} ${parts[0]}` : name) : name + (prog.live.length > 1 ? ` ${MID} zone ${zi + 1}` : '');
          const row = { kind: 'row', index: r.sample, group, title, sub: parts.slice(group === 'music' && prog.live.length > 1 ? 1 : 0).join(` ${MID} `) || parts.join(` ${MID} `), seconds: (s.end - s.start) / Bk().ROOT_RATE, looped: s.looped, bank: b, program: prog.program, kit: !!(info && info.kit), breakKit: !!(info && info.breakKit), natural: info && info.naturalNote || 0 };
          row.search = `${title} ${row.sub} ${(info?.aliases || []).join(' ')} ${group === 'music' ? 'music instrument' : 'effect voice sound'} bank ${b} program ${prog.program} ${r.sample}`.toLowerCase();
          rows.push(row); byIndex.set(r.sample, row);
        });
      }
    });
    return (sourceCache = { key, rows, byIndex });
  };
  const sampleLabel = (i) => { const r = D.sources().byIndex.get(i); return r ? r.title : `Sound ${i}`; };
  D.sampleLabel = sampleLabel;
  const peakCache = new Map();
  function peaks(lo, hi, n) {
    const key = `${lo}:${hi}:${n}`;
    let out = peakCache.get(key);
    if (out) return out;
    const sm = samples(), len = hi - lo;
    out = new Int8Array(2 * n);
    for (let c = 0; c < n; c++) {
      const a = lo + Math.floor(c * len / n), b = Math.max(a + 1, lo + Math.floor((c + 1) * len / n)), step = Math.max(1, Math.floor((b - a) / 48));
      let mn = 127, mx = -128;
      for (let i = a; i < b; i += step) { const v = sm[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
      out[2 * c] = mn; out[2 * c + 1] = mx;
    }
    if (peakCache.size > 600) peakCache.clear();
    peakCache.set(key, out);
    return out;
  }
  function thumb(canvas, lo, hi, w, h) {
    const dpr = g.devicePixelRatio || 1, n = Math.max(8, Math.round(w));
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    const c = canvas.getContext('2d'); c.setTransform(canvas.width / w, 0, 0, canvas.height / h, 0, 0);
    c.clearRect(0, 0, w, h);
    const p = peaks(lo, hi, n), mid = h / 2;
    c.fillStyle = K.css('--line-2'); c.fillRect(0, Math.round(mid), w, 1);
    c.fillStyle = K.css('--ink-3');
    for (let i = 0; i < n; i++) { const top = mid - p[2 * i + 1] / 128 * (mid - 1), bot = mid - p[2 * i] / 128 * (mid - 1); c.fillRect(i * w / n, top, Math.max(1, w / n - 0.2), Math.max(1, bot - top)); }
  }

  /* ---- views and zones (04_FORMATS section 4) ------------------------------------------------------------------ */
  const romEntry = (i) => { const s = table()[i]; return s ? { start: s.start, loop: s.looped ? s.loop : null, end: s.end, root: clamp(s.root | 0, 0, 127), source: i } : null; };
  function viewOf(bank, region) {
    if (!region || !region.sample) return null;
    if (region.sample.view !== undefined) return (bank.views || []).find((v) => v.id === region.sample.view) || null;
    if (region.sample.rom !== undefined) { const e = romEntry(region.sample.rom); return e && Object.assign({ id: null, virtual: true, name: sampleLabel(region.sample.rom) }, e); }
    return null;
  }
  const refs = (bank, id) => { let n = 0; for (const k of listOf(bank)) for (const r of bank.programs[k].regions) if (r.sample && r.sample.view === id) n++; return n; };
  function viewId(bank) { let max = 0; for (const v of bank.views) { const m = /^v(\d+)$/.exec(v.id); if (m) max = Math.max(max, +m[1]); } return 'v' + (max + 1); }
  /* a cut that only this zone uses: a ROM-sample zone is turned into one, a shared one is copied */
  function ownView(bank, region) {
    const v = viewOf(bank, region);
    if (!v) fail('This zone has no sound.');
    if (!v.virtual && refs(bank, v.id) <= 1) return v;
    const nv = Object.assign({}, v, { id: viewId(bank) }); delete nv.virtual;
    bank.views.push(nv); region.sample = { view: nv.id }; delete region.root;
    return nv;
  }
  function zoneOf(bank, n, z) {
    const prog = bank && bank.programs && bank.programs[n];
    if (!prog) fail('That instrument is not in this song.');
    const region = prog.regions[z];
    if (!region) fail('That zone does not exist.');
    return { prog, region, regions: prog.regions };
  }
  const isKit = (prog) => { const rs = prog.regions || []; let narrow = 0; rs.forEach((r, i) => { if (r.keyHigh - zoneLow(rs, i) < 3) narrow++; }); return rs.length > 2 && narrow * 2 >= rs.length; };
  const ownBytes = (bank, n) => { const prog = bank.programs[n], ids = new Set(); for (const r of prog.regions) if (r.sample && r.sample.view !== undefined) ids.add(r.sample.view); return 12 * prog.regions.length + 2 + 16 * ids.size; };
  /* where a cut can be edited: the recording it came from (a view may only lie inside the game's sound data) */
  function sourceRange(view) {
    const T = table(), s = view.source !== undefined && view.source !== null ? T[view.source] : null;
    if (s && s.start <= view.start && s.end >= view.end) return { lo: s.start, hi: s.end, sample: s };
    for (const t of T) if (t && t.start <= view.start && t.end >= view.end) return { lo: t.start, hi: t.end, sample: t };
    return { lo: Math.max(0, view.start - 4096), hi: Math.min(totalBytes(), view.end + 4096), sample: null };
  }

  /* ---- editing: every change is one undoable edit and is refused if the builder would refuse it ---------------- */
  function ensure(p) { if (!p.bank) p.bank = { slot: SLOT, views: [], programs: {} }; if (!p.bank.views) p.bank.views = []; if (!p.bank.programs) p.bank.programs = {}; return p.bank; }
  function tidy(p) {
    const B = p.bank;
    p.names = p.names || {};
    const slot = slotOf(B);
    if (B) {
      const nums = listOf(B);
      if (nums.length) {
        const used = new Set();
        for (const n of nums) for (const r of B.programs[n].regions) if (r.sample && r.sample.view !== undefined) used.add(r.sample.view);
        B.views = (B.views || []).filter((v) => used.has(v.id));
        for (const k of Object.keys(p.names)) if (k.startsWith(slot + ':') && !B.programs[k.slice(String(slot).length + 1)]) delete p.names[k];
        for (const n of nums) { const name = B.programs[n].name; if (name) p.names[`${slot}:${n}`] = name; else delete p.names[`${slot}:${n}`]; }
        return;
      }
      p.bank = null;
    }
    for (const k of Object.keys(p.names)) if (k.startsWith(slot + ':')) delete p.names[k];
  }
  function commit(label, fn) {
    let result;
    S.edit(label, (p) => {
      result = fn(p);
      tidy(p);
      if (p.bank) {
        const limit = caveOf().end - caveOf().bank;
        if (Bk().size(p.bank) > limit) fail(`That would make the custom instruments ${kb(Bk().size(p.bank))}. This preview has room for ${kb(limit)}. Remove a zone or an instrument first.`);
        try { Bk().buildBlob(p.bank, caveOf().bank); } catch (e) { fail(e.message); }
      }
    });
    return result;
  }
  function newView(bank, s, name) { const e = romEntry(s.index); return Object.assign({ id: viewId(bank), name: name || sampleLabel(s.index) }, e); }
  function defaultName(sample, preset) { const base = sampleLabel(sample); return preset === 'pluck' || preset === 'pad' || preset === 'loop' ? `${base} ${preset}` : base; }
  /* The Wave Miner on the steady part of the sound (where the game's own loop sits) first, then on the whole cut. */
  function mineLoop(v, region, mode) {
    const sm = samples(), src = sourceRange(v), to = v.end, tries = [];
    if (src.sample && src.sample.looped && src.sample.loop > v.start) tries.push(src.sample.loop);
    tries.push(v.start);
    let r = null;
    for (const from of tries) {
      if (to - from < 400) continue;
      if (mode === 'cycle') r = Bk().findLoop(sm, from, to, { periods: 1 });
      else {
        const m = Bk().pitch(sm, from, to);
        if (m) { const kmax = Math.floor((to - from) / m.period) - 1; if (kmax >= 2) r = Bk().findLoop(sm, from, to, { periods: [Math.max(2, Math.ceil(kmax / 2)), kmax] }); }
        if (!r) r = Bk().findLoop(sm, from, to, {});
      }
      if (r) break;
    }
    if (!r) return null;
    v.loop = r.loop; v.end = r.end; v.root = r.root; region.fine = clamp(r.fine, -128, 127);
    return { periods: r.periods, seconds: (r.end - r.loop) / Bk().ROOT_RATE, cents: r.cents };
  }

  D.create = function (o) {
    const out = { n: null, loop: null };
    commit('New instrument', (p) => {
      const bank = ensure(p), n = nextFree(bank);
      if (n === null) fail(`The list is full: a song can carry ${MAX_INSTRUMENTS} custom instruments at most.`);
      const s = table()[o.sample];
      if (!s) fail('That sound is not in the game.');
      const v = newView(bank, s); bank.views.push(v);
      const region = Object.assign({ keyHigh: 127, sample: { view: v.id }, pan: null, level: 0, fine: 0, ringOut: false }, ENV[o.preset === 'pluck' || o.preset === 'pad' ? o.preset : 'plain']);
      bank.programs[n] = { name: o.name || defaultName(o.sample, o.preset), regions: [region] };
      if (o.preset === 'loop') out.loop = mineLoop(v, region, 'cycle');
      out.n = n; sel = { n, z: 0 };
    });
    return out;
  };
  function nextFree(bank) { for (let n = 0; n < MAX_INSTRUMENTS; n++) if (!bank.programs[n]) return n; return null; }
  D.rename = (n, name) => commit('Rename instrument', (p) => { zoneOf(p.bank, n, 0); p.bank.programs[n].name = String(name).slice(0, 48); });
  D.duplicate = function (n) {
    const out = { n: null };
    commit('Duplicate instrument', (p) => {
      const bank = p.bank, src = zoneOf(bank, n, 0).prog, to = nextFree(bank);
      if (to === null) fail(`The list is full: a song can carry ${MAX_INSTRUMENTS} custom instruments at most.`);
      const prog = copy(src), map = new Map();
      for (const r of prog.regions) if (r.sample && r.sample.view !== undefined) {
        if (!map.has(r.sample.view)) { const v = copy(viewOf(bank, r)); v.id = viewId(bank); bank.views.push(v); map.set(r.sample.view, v.id); }
        r.sample = { view: map.get(r.sample.view) };
      }
      prog.name = `${src.name || 'Instrument'} copy`.slice(0, 48); bank.programs[to] = prog; out.n = to; sel = { n: to, z: 0 };
    });
    return out;
  };
  D.remove = (n) => commit('Delete instrument', (p) => { zoneOf(p.bank, n, 0); delete p.bank.programs[n]; });
  D.setZone = function (n, z, patch) {
    const label = 'Instrument ' + Object.keys(patch).map((k) => k.replace(/[A-Z]/g, (m) => ' ' + m.toLowerCase())).join(' and ');
    return commit(label, (p) => {
      const { region } = zoneOf(p.bank, n, z);
      for (const [k, v0] of Object.entries(patch)) {
        const v = v0 === null ? null : typeof v0 === 'boolean' ? v0 : Math.round(Number(v0));
        if (k === 'pan') { if (v !== null && !(v >= 0 && v <= 127)) fail('Pan must be between 0 and 127.'); }
        else if (k === 'level') { if (!(v >= -64 && v <= 63)) fail('Level must be between -64 and 63.'); }
        else if (k === 'fine') { if (!(v >= -128 && v <= 127)) fail('Fine tune must stay within half a semitone.'); }
        else if (k === 'ringOut') { if (typeof v !== 'boolean') fail('Ring out is on or off.'); }
        else if (k === 'attack' || k === 'decay' || k === 'sustainRate' || k === 'release') { if (!(v >= 0 && v <= 63)) fail('A rate must be between 0 and 63.'); }
        else if (k === 'sustain') { if (!(v >= 0 && v <= 127)) fail('The sustain level must be between 0 and 127.'); }
        else fail(`${k} is not a zone setting.`);
        region[k] = v;
      }
    });
  };
  D.applyPreset = (n, z, name) => D.setZone(n, z, ENV[name]);
  D.setView = (n, z, patch) => commit('Instrument cut', (p) => {
    const { region } = zoneOf(p.bank, n, z), v = ownView(p.bank, region);
    const num = (x) => { x = Math.round(Number(x)); if (!Number.isFinite(x)) fail('That is not a number.'); return x; };
    let { start, loop, end, root } = v;
    if ('start' in patch) start = num(patch.start);
    if ('end' in patch) end = num(patch.end);
    if ('loop' in patch) loop = patch.loop === null ? null : num(patch.loop);
    if ('root' in patch) root = num(patch.root);
    if (!(start >= 0 && end <= totalBytes() && end - start >= MIN_CUT)) fail(`A cut must lie inside the game's sound data and be at least ${MIN_CUT} samples long.`);
    if (loop !== null && loop !== undefined) { loop = clamp(loop, start, end); if (loop >= end) loop = null; }
    if (!(root >= 0 && root <= 127)) fail('The root key must be between 0 and 127.');
    Object.assign(v, { start, loop: loop === undefined ? null : loop, end, root });
  });
  D.setLoop = (n, z, on) => commit('Instrument loop', (p) => {
    const { region } = zoneOf(p.bank, n, z), v = ownView(p.bank, region);
    if (!on) { v.loop = null; return; }
    if (v.loop !== null && v.loop !== undefined && v.loop < v.end) return;
    const sm = samples(), want = v.start + Math.floor((v.end - v.start) / 2);
    let at = want;
    for (let d = 0; d < 2000; d++) { const a = want - d, b = want + d; if (a > v.start && sm[a - 1] < 0 && sm[a] >= 0) { at = a; break; } if (b < v.end - MIN_CUT && sm[b - 1] < 0 && sm[b] >= 0) { at = b; break; } }
    v.loop = clamp(at, v.start, v.end - MIN_CUT);
  });
  D.setSource = (n, z, index) => commit('Instrument sound', (p) => {
    const { region } = zoneOf(p.bank, n, z), s = table()[index];
    if (!s) fail('That sound is not in the game.');
    const old = viewOf(p.bank, region);
    let v;
    if (old && !old.virtual && refs(p.bank, old.id) <= 1) v = old;
    else { v = { id: viewId(p.bank) }; p.bank.views.push(v); region.sample = { view: v.id }; }
    Object.assign(v, romEntry(index), { name: sampleLabel(index) });
    region.fine = 0; delete region.root;
  });
  D.findLoop = function (n, z, mode) {
    let info = null;
    commit('Find a clean loop', (p) => {
      const { region } = zoneOf(p.bank, n, z), v = ownView(p.bank, region);
      info = mineLoop(v, region, mode);
      if (!info) fail(mode === 'cycle' ? 'No clean one-cycle loop was found. Try a sound with a steady pitch, or a long loop.' : 'No clean loop was found. Try a sound with a steady pitch, or cut it shorter.');
    });
    return info;
  };
  D.detectPitch = function (n, z) {
    let info = null;
    commit('Detect pitch', (p) => {
      const { region } = zoneOf(p.bank, n, z), v = ownView(p.bank, region);
      const from = v.loop !== null && v.loop !== undefined && v.loop < v.end ? v.loop : v.start;
      // Autocorrelation needs several periods. A one-cycle cut is periodic when the chip
      // plays it, so measure repeated copies of that exact loop instead of a truncated cycle.
      const sm = samples(), length = v.end - from, shortLoop = from === v.loop && length < 400;
      const repeated = shortLoop ? Int8Array.from({ length: Math.max(6000, length * 8) }, (_, i) => sm[from + i % length]) : null;
      const m = repeated ? Bk().pitch(repeated, 0, repeated.length) : Bk().pitch(sm, from, v.end);
      if (!m) fail('No steady pitch was found. Drum hits, noise and very short sounds have none.');
      const rf = Bk().rootFor(m.hz);
      v.root = rf.root; region.fine = clamp(rf.fine, -128, 127);
      info = { note: m.note, cents: m.cents, confidence: m.confidence, root: rf.root, fine: region.fine };
    });
    return info;
  };
  D.moveSplit = (n, z, key) => commit('Move zone split', (p) => {
    const { regions } = zoneOf(p.bank, n, z), lo = zoneLow(regions, z), hi = z === regions.length - 1 ? 127 : regions[z + 1].keyHigh - 1;
    regions[z].keyHigh = clamp(Math.round(key), lo, hi);
  });
  D.addZone = function (n, z, at) {
    const out = { z };
    commit('Split zone', (p) => {
      const { regions } = zoneOf(p.bank, n, z), lo = zoneLow(regions, z), hi = regions[z].keyHigh;
      if (hi <= lo) fail('This zone is one key wide, so it cannot be split.');
      const k = clamp(at === undefined ? Math.ceil((lo + hi) / 2) + 1 : Math.round(at), lo + 1, hi);
      const low = copy(regions[z]); low.keyHigh = k - 1;
      if (low.sample && low.sample.view !== undefined) { const v = copy(viewOf(p.bank, low)); v.id = viewId(p.bank); p.bank.views.push(v); low.sample = { view: v.id }; }
      regions.splice(z, 0, low);
      out.z = at === undefined || at < k ? z : z + 1;
    });
    return out;
  };
  D.removeZone = (n, z) => commit('Remove zone', (p) => {
    const { regions } = zoneOf(p.bank, n, z);
    if (regions.length < 2) fail('An instrument needs at least one zone. Delete the instrument instead.');
    const gone = regions.splice(z, 1)[0];
    if (z === regions.length) regions[z - 1].keyHigh = gone.keyHigh;
  });
  /* opts: { count } or { atHits: true }, firstKey, natural (where Capcom plays the source relative to its root: -20 for the break kits), name */
  D.slice = function (n, z, o) {
    const out = { n: null, count: 0 };
    commit('Slice into a kit', (p) => {
      const bank = ensure(p), { region } = zoneOf(bank, n, z), v = viewOf(bank, region);
      const views = Bk().slice(samples(), v.start, v.end, o.atHits ? { atHits: true } : { count: o.count || 8 });
      if (views.length < 2) fail('No separate hits were found in this sound. Try cutting it evenly instead.');
      const first = clamp(Math.round(o.firstKey === undefined ? 41 : o.firstKey), 0, 127);
      if (first + views.length - 1 > 127) fail(`${views.length} slices from ${noteName(first)} would run past the top key. Start lower or use fewer slices.`);
      const to = nextFree(bank);
      if (to === null) fail(`The list is full: a song can carry ${MAX_INSTRUMENTS} custom instruments at most.`);
      const label = v.name || sampleLabel(v.source), kit = Bk().kitFrom(views, first, o.natural || 0, { prefix: 'k', name: `${label} kit`, envelope: ENV.plain }), map = {};
      kit.views.forEach((kv, i) => { const id = viewId(bank); map[kv.id] = id; bank.views.push(Object.assign({}, kv, { id, name: `${label} slice ${i + 1}`, source: v.source })); });
      bank.programs[to] = { name: o.name || `${label} kit`, regions: kit.program.regions.map((r) => Object.assign({}, r, { sample: { view: map[r.sample.view] } })) };
      out.n = to; out.count = views.length; sel = { n: to, z: 0 };
    });
    return out;
  };
  D.usePart = (partId, n) => S.edit('Use custom instrument', (p) => {
    const part = p.parts.find((x) => x.id === partId);
    if (!part) fail('That part is not in this song.');
    part.bank = slotOf(p.bank); part.program = n;
  });

  /* import and export: *.sf3bank.json (or the instruments of a song file or a project) */
  D.exportData = function (numbers, project) {
    const P = project || proj(), bank = P.bank;
    if (!bank || !listOf(bank).length) fail('There are no custom instruments to export.');
    const nums = numbers && numbers.length ? numbers : listOf(bank), programs = {}, ids = new Set();
    for (const n of nums) { if (!bank.programs[n]) fail(`Instrument ${n} is not in this song.`); programs[n] = copy(bank.programs[n]); for (const r of programs[n].regions) if (r.sample && r.sample.view !== undefined) ids.add(r.sample.view); }
    return { format: 'sf3bank', version: 1, name: nums.length === 1 ? bank.programs[nums[0]].name : P.name || 'Instruments', slot: slotOf(bank), views: bank.views.filter((v) => ids.has(v.id)).map(copy), programs, studio: '1.0' };
  };
  D.importData = function (obj) {
    const src = obj && obj.format === 'sf3bank' ? obj : obj && obj.bank && obj.bank.programs ? obj.bank : obj && obj.programs ? obj : null;
    if (!src || typeof src.programs !== 'object' || src.programs === null) fail('This file has no custom instruments in it.');
    const out = { numbers: [] };
    commit('Import instruments', (p) => {
      const bank = ensure(p), map = new Map();
      for (const v of src.views || []) {
        if (!v || typeof v.id !== 'string') fail('A cut in this file has no name.');
        const id = viewId(bank); bank.views.push(Object.assign({}, copy(v), { id })); map.set(v.id, id);
      }
      const nums = Object.keys(src.programs).filter((k) => /^\d+$/.test(k)).map(Number).sort((a, b) => a - b);
      if (!nums.length) fail('This file has no custom instruments in it.');
      for (const k of nums) {
        const prog = copy(src.programs[k]);
        if (!prog || !Array.isArray(prog.regions) || !prog.regions.length) fail(`Instrument ${k} in this file has no zones.`);
        for (const r of prog.regions) if (r && r.sample && r.sample.view !== undefined) { if (!map.has(r.sample.view)) fail(`Instrument ${k} uses a cut that is not in this file.`); r.sample = { view: map.get(r.sample.view) }; }
        const n = k < MAX_INSTRUMENTS && !bank.programs[k] ? k : nextFree(bank);
        if (n === null) fail(`The list is full: a song can carry ${MAX_INSTRUMENTS} custom instruments at most.`);
        bank.programs[n] = prog; out.numbers.push(n);
      }
      sel = { n: out.numbers[0], z: 0 };
    });
    return out;
  };

  /* ---- what the two always-visible texts say ------------------------------------------------------------------- */
  D.space = function (project) {
    const P = project || proj(), bank = P.bank, nums = listOf(bank), u = Bk().used(P), cave = caveOf();
    let song = null;
    try { song = (project ? SF3Compile.build(P, { catalog: S.state.catalog }) : S.state.build()).bytes.length; } catch (e) { song = null; }
    const rom = S.musicSpace && Number.isFinite(S.musicSpace.free) ? S.musicSpace : null;
    let zones = 0; for (const n of nums) zones += bank.programs[n].regions.length;
    return { custom: nums.length ? Bk().size(bank) : 0, count: nums.length, zones, views: nums.length ? bank.views.length : 0, used: u.programs.length, usedBytes: u.bank ? Bk().size(u.bank) : 0,
             song, total: rom && Number.isFinite(rom.total) ? rom.total : cave.end - cave.preview, free: rom ? rom.free : null, limit: cave.end - cave.bank };
  };
  /* what a ROM must do for this song: the same facts Deliver states (SF3Compile.build carries the whole bank) */
  D.needs = function (project) {
    const P = project || proj(), sp = D.space(P), uses = !!P.bank && sp.count > 0;
    return { instruments: uses, count: sp.count, used: sp.used, unused: sp.count - sp.used, bytes: sp.custom,
             lines: uses ? [`Custom instruments (${kb(sp.custom)}) and the instrument table change`] : [`Uses only the game${'’'}s own instruments`] };
  };
  const usage = function (project) {
    const map = new Map();
    if (!project.bank) return map;
    for (const part of project.parts || []) for (const n of Bk().used({ bank: project.bank, parts: [part] }).programs) { if (!map.has(n)) map.set(n, []); map.get(n).push(part.name || part.id); }
    return map;
  };

  /* ---- sound: a player of its own (the transport keeps the song) and the measurement ----------------------- */
  const Player = { ctx: null, gain: null, source: null };
  async function audio() {
    if (!Player.ctx) { Player.ctx = new (g.AudioContext || g.webkitAudioContext)(); Player.gain = Player.ctx.createGain(); Player.gain.connect(Player.ctx.destination); }
    await Player.ctx.resume();
    if (Player.ctx.state !== 'running') throw new Error('Click again to enable sound.');
    const vol = S.transport && Number.isFinite(S.transport.volume) ? S.transport.volume : 0.78;
    Player.gain.gain.value = vol * vol;
  }
  const toTrack = (program, bank, note, velocity, ticks, tail) => {
    const v = clamp(Math.round(velocity / 2), 1, 63), t = new Array(16).fill(null);
    t[0] = [{ d: 0, k: 'cmd', op: 0xC1, a: [2, 0] }, { d: 0, k: 'cmd', op: 0xC2, a: [bank] }, { d: 0, k: 'cmd', op: 0xC4, a: [program] }, { d: 0, k: 'cmd', op: 0xC6, a: [100] },
            { d: 0, k: 'cmd', op: 0xC8, a: [110] }, { d: 0, k: 'cmd', op: 0xC7, a: [64] }, { d: 1, k: 'note', v, n: note, tie: 0, len: ticks }, { d: ticks + tail, k: 'cmd', op: 0xFF, a: [] }];
    return g.SF3Seq.compile({ tracks: t });
  };
  /* one note of a bank, rendered by the driver (about 100 times faster than it plays) */
  function renderNote(bank, program, note, o) {
    o = Object.assign({ velocity: 100, ticks: 120, tail: 420 }, o || {});
    const E = Eng(), e = new E.Engine(S.pack, { stereo: !!(S.transport && S.transport.stereo) });
    e.installBank(Bk().buildBlob(bank, E.CAVE.bank));
    e.patchSequence(toTrack(program, slotOf(bank), note, o.velocity, o.ticks, o.tail), 60, 0); e.request(60);
    const frames = Math.ceil((o.ticks + o.tail + 1) / 2) + 6, L = new Int32Array(frames * 640), R = new Int32Array(frames * 640);
    let at = 0, silent = 0;
    for (let f = 0; f < frames; f++) { at += e.step(L, R, at); if (f > 6 && !e.key) { if (++silent > 12) break; } else silent = 0; }
    return { L, R, n: at };
  }
  async function play(bank, program, note, o) {
    await audio();
    const r = renderNote(bank, program, note, o), buf = Player.ctx.createBuffer(2, Math.max(1, r.n), Eng().CHIP_RATE), l = buf.getChannelData(0), rr = buf.getChannelData(1);
    for (let i = 0; i < r.n; i++) { l[i] = clamp(r.L[i] / 32768, -1, 1); rr[i] = clamp(r.R[i] / 32768, -1, 1); }
    if (Player.source) { try { Player.source.stop(); } catch (e) { /* already finished */ } }
    const src = Player.ctx.createBufferSource(); src.buffer = buf; src.connect(Player.gain); src.start(); Player.source = src;
    return src;
  }
  const ticksFor = (sec) => Math.round(sec * 2 * FRAME);
  D.hear = (n, key, o) => { const bank = proj().bank; if (!bank || !bank.programs[n]) fail('That instrument is not in this song.'); return play(bank, n, key, Object.assign({ ticks: ticksFor(1.4) }, o)); };
  D.hearSample = function (index, o) {
    const s = table()[index]; if (!s) return Promise.resolve();
    const region = { keyHigh: 127, sample: { rom: index }, pan: null, level: 0, fine: 0, ringOut: false, root: clamp(s.root | 0, 0, 127) }, bank = { slot: SLOT, views: [], programs: { 0: { regions: [Object.assign(region, ENV.plain)] } } };
    return play(bank, 0, clamp(s.root | 0, 0, 127), Object.assign({ ticks: ticksFor(Math.min(2.4, Math.max(0.6, (s.end - s.start) / Bk().ROOT_RATE + 0.1))), tail: 60 }, o));
  };
  /* the zone's note, measured in the driver: the level word per frame (SF3Bank.envelope), and the frame the voice stops */
  function probe(bank, n, z) {
    const E = Eng(), region = copy(bank.programs[n].regions[z]), v = viewOf(bank, region);
    if (!v) return null;
    region.keyHigh = 127; region.pan = null;
    const views = region.sample.view !== undefined ? [copy(v)] : [], note = clamp(v.root, 0, 127), ticks = 120, frames = 240, velocity = 100;
    const levels = Bk().envelope(E, S.pack, region, { note, velocity, ticks, frames, views });
    /* the same note again with the track left open, to see the chip: envelope() ends the track a tick after the note */
    const e = new E.Engine(S.pack);
    e.installBank(Bk().buildBlob({ slot: SLOT, views, programs: { 0: { regions: [Object.assign({ pan: null, level: 0, fine: 0 }, region)] } } }, E.CAVE.bank));
    e.patchSequence(toTrack(0, SLOT, note, velocity, ticks, 700), 60, 0); e.request(60);
    const key = [], flag = [];
    for (let f = 0; f < frames; f++) { e.step(); key.push(e.key & 1); flag.push(e.regs[5] ? 1 : 0); }
    const peak = Math.max(...levels), f0 = levels.findIndex((x) => x > 0), looped = v.loop !== null && v.loop !== undefined && v.loop < v.end;
    let on = key.findIndex((x) => x), stop = null;
    if (on >= 0) for (let f = on + 1; f < frames; f++) if (!key[f]) { stop = f; break; }
    let off = f0 + ticks / 2;
    if (looped && on >= 0) { const d = flag.findIndex((x, i) => i > on && !x); if (d > 0) off = d; }
    const cut = stop !== null && stop >= 1 && levels[Math.min(stop, frames - 1)] > peak * 0.03 ? (looped ? 'loop' : 'end') : null;
    return { levels, frames, f0: Math.max(0, f0), off, stop, cut, peak, looped, ticks, note };
  }
  D.measure = (n, z) => { const bank = proj().bank; if (!bank) return null; return probe(bank, n, z === undefined ? 0 : z); };

  /* ---- selection (survives the view being left and entered again) -------------------------------------------------- */
  let sel = { n: null, z: 0 };
  const mounts = [];
  function fixSel() {
    const nums = listOf(proj().bank);
    if (!nums.length) { sel = { n: null, z: 0 }; return; }
    if (!nums.includes(sel.n)) sel = { n: nums[0], z: 0 };
    sel.z = clamp(sel.z, 0, proj().bank.programs[sel.n].regions.length - 1);
  }
  D.select = (n, z) => { sel = { n, z: z || 0 }; fixSel(); mounts.forEach((m) => m.refresh(true)); };
  D.selected = () => ({ n: sel.n, z: sel.z });
  const run = (fn) => { try { return fn(); } catch (e) { K.toast(e.message, { kind: 'bad' }); return undefined; } };
  const later = (fn) => Promise.resolve().then(fn);

  /* ---- dialogs: the source picker and the slicer ------------------------------------------------------------------ */
  const ROW = 40;
  /* o: { title, create: true | 'plain' | 'pluck' | 'pad' | 'loop', current } -> { sample, preset } or null */
  function pickSource(o) {
    o = o || {};
    const all = D.sources().rows, T = table();
    let filter = 'all', query = '', chosen = o.current !== undefined && o.current !== null ? o.current : null, shown = [];
    const search = el('input.field', { type: 'text', placeholder: `Search the game${'’'}s sounds`, 'aria-label': 'Search sounds', autofocus: true, spellcheck: false, autocomplete: 'off', 'data-tip': tip('Search sounds', 'Type part of a name, such as bass, snare or effect.') });
    const seg = el('div.seg');
    const scroller = el('div.dz-pick-scroll', { tabindex: 0 }), inner = el('div.dz-pick-inner'), info = el('div.dz-pick-info');
    scroller.append(inner);
    function visible() {
      const rows = filter === 'all' ? all : all.filter((r) => r.group === filter);
      if (!query.trim()) return rows;
      return K.fuzzy.rank(query, rows.filter((r) => r.kind === 'row'), (r) => r.search).map((x) => x.item);
    }
    function describe() {
      const r = chosen !== null ? D.sources().byIndex.get(chosen) : null;
      info.textContent = r ? `${r.title} ${MID} ${seconds(r.seconds)} ${MID} ${r.sub}` : `Choose one of ${K.fmt.int(D.sources().byIndex.size)} sounds. Click the arrow to hear it.`;
    }
    function rowEl(r, i) {
      if (r.kind === 'head') return el('div.dz-pick-head', { style: { top: i * ROW + 'px' } }, el('h3', null, r.title), el('small', null, r.sub));
      const s = T[r.index], cv = el('canvas', { 'aria-hidden': 'true' });
      thumb(cv, s.start, s.end, 72, 28);
      const hear = el('button.btn.icon.ghost', { type: 'button', 'aria-label': 'Hear this sound', 'data-tip': tip('Hear', 'Play this sound at its own pitch.'), onclick: (e) => { e.stopPropagation(); run(() => D.hearSample(r.index)); } }, K.icon('play'));
      const row = el('div.dz-pick-row', { class: chosen === r.index ? 'on' : '', style: { top: i * ROW + 'px' }, 'data-tip': tip(r.title, `${seconds(r.seconds)} long, ${r.looped ? 'loops while a note is held' : 'plays once'}. Click to choose it, double-click to use it now.`) },
        cv, el('div', { class: 'grow' }, el('b', null, r.title), el('small', null, r.sub)), el('span.num', null, seconds(r.seconds)), hear);
      row.onclick = () => { chosen = r.index; describe(); paint(); };
      row.ondblclick = () => { chosen = r.index; dialog.close(result(o.create === true ? 'plain' : o.create || null)); };
      return row;
    }
    function paint() {
      const first = Math.max(0, Math.floor(scroller.scrollTop / ROW) - 1), last = Math.min(shown.length, Math.ceil((scroller.scrollTop + (scroller.clientHeight || 400)) / ROW) + 1);
      inner.replaceChildren(...shown.slice(first, last).map((r, k) => rowEl(r, first + k)));
    }
    function layout(reset) { shown = visible(); inner.style.height = shown.length * ROW + 'px'; if (reset) scroller.scrollTop = 0; if (!shown.length) inner.replaceChildren(el('div.empty', null, el('b', null, 'Nothing matches.'), el('p', null, 'Try another word, or choose All sounds.'))); else paint(); }
    K.seg(seg, [{ value: 'all', label: 'All sounds', tip: tip('All sounds', 'Every sound the game has, music first.') }, { value: 'music', label: 'Music instruments', tip: tip('Music instruments', 'The sounds the game’s music is played with, grouped by instrument.') }, { value: 'fx', label: 'Effects and voices', tip: tip('Effects and voices', 'Hits, shouts and other sounds from the fights.') }], (v) => { filter = v; layout(true); }, { value: 'all' });
    search.addEventListener('input', () => { query = search.value; layout(true); });
    scroller.addEventListener('scroll', () => { if (shown.length) paint(); });
    search.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      const list = shown.filter((r) => r.kind === 'row'), at = list.findIndex((r) => r.index === chosen), next = list[clamp(at + (e.key === 'ArrowDown' ? 1 : -1), 0, list.length - 1)];
      if (!next) return;
      chosen = next.index; describe();
      const y = shown.indexOf(next) * ROW; if (y < scroller.scrollTop) scroller.scrollTop = y; else if (y + ROW > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = y + ROW - scroller.clientHeight;
      paint();
    });
    const result = (preset) => ({ sample: chosen, preset });
    const need = () => { if (chosen === null) { K.toast('Choose a sound first.', { kind: 'warn' }); return false; } return true; };
    const buttons = [{ label: 'Cancel', value: null }];
    if (o.create === true) for (const k of ['plain', 'pluck', 'pad', 'loop']) buttons.push({ label: `Make it ${k}`, primary: k === 'plain', value: () => result(k), check: need });
    else if (o.create) buttons.push({ label: `Make a ${o.create === 'plain' ? 'plain instrument' : o.create}`, primary: true, value: () => result(o.create), check: need });
    else buttons.push({ label: 'Use this sound', primary: true, value: () => result(null), check: need });
    const body = el('div.dz-pick', null, el('div.hbox', null, search, seg), scroller, info);
    const dialog = K.dialog({ title: o.title || `Choose a sound`, text: o.create ? 'Every instrument starts as a stretch of one of the game’s own sounds. You can cut, loop, tune and shape it afterwards.' : null, body, buttons, width: 760, focus: search });
    describe(); layout(true);
    if (chosen !== null) { const at = shown.findIndex((r) => r.index === chosen); if (at >= 0) { scroller.scrollTop = Math.max(0, at * ROW - 80); paint(); } }
    return dialog;
  }
  function sliceDialog(q) {
    const view = q.view, src = sourceRange(view), row = src.sample ? D.sources().byIndex.get(src.sample.index) : null;
    const state = { mode: 'even8', first: 41, speed: row && row.breakKit ? 'capcom' : 'own' };
    const note = el('div.hint'), seg = el('div.seg'), speed = el('div.seg'), first = el('input.field.num', { 'aria-label': 'First key', 'data-tip': tip('First key', 'The key that plays the first piece. The rest follow upwards, one key each.') });
    const preview = () => {
      let count = 0;
      try { count = Bk().slice(samples(), view.start, view.end, state.mode === 'hits' ? { atHits: true } : { count: state.mode === 'even16' ? 16 : 8 }).length; } catch (e) { count = 0; }
      note.textContent = count < 2 ? 'No separate hits were found in this sound.' : `${count} pieces on keys ${noteName(state.first)}${EN}${noteName(Math.min(127, state.first + count - 1))}. Each piece costs 12 bytes for its zone and 16 for its cut.`;
      return count;
    };
    K.seg(seg, [{ value: 'even8', label: '8 even pieces', tip: tip('8 even pieces', 'Cut the sound into eight equal pieces, at points where the wave crosses zero.') }, { value: 'even16', label: '16 even pieces', tip: tip('16 even pieces', 'Cut the sound into sixteen equal pieces.') }, { value: 'hits', label: 'At the hits', tip: tip('At the hits', 'Cut before each loud hit the sound makes.') }], (v) => { state.mode = v; preview(); }, { value: state.mode });
    K.seg(speed, [{ value: 'capcom', label: 'As Capcom plays it', tip: tip('As Capcom plays it', 'Pitch each piece 20 semitones down, the way the game plays its drum breaks.') }, { value: 'own', label: 'At its own speed', tip: tip('At its own speed', 'Each piece plays at the speed it was recorded.') }], (v) => { state.speed = v; }, { value: state.speed });
    K.number(first, { min: 0, max: 127, step: 1, value: state.first, format: noteName, parse: (s) => { const n = K.fmt.parseNote(s); return n !== null ? n : parseFloat(s); }, onInput: (v) => { state.first = v; preview(); } });
    const body = el('div.dz-slice', null, el('p', { class: 'dim' }, 'Each piece gets its own key, so you can play them in any order, like a chopped drum break. This makes a new instrument and leaves this one as it is.'),
      el('label.lab', null, el('span', null, 'Cut into'), seg), el('label.lab', null, el('span', null, 'Speed'), speed), el('label.lab', null, el('span', null, 'First key'), first), note);
    preview();
    return K.dialog({ title: 'Slice into a kit', body, width: 560, buttons: [{ label: 'Cancel', value: null }, { label: 'Make the kit', primary: true, check: () => preview() >= 2, value: () => Object.assign({}, state, { count: state.mode === 'even16' ? 16 : 8, atHits: state.mode === 'hits', natural: state.speed === 'capcom' ? -20 : 0 }) }] });
  }

  /* ---- the screen -------------------------------------------------------------------------------------------------- */
  const NOTICE_TITLE = 'Custom instruments are optional.';
  const NOTICE_A = ' They are made from the sounds already in the game — new recordings cannot be added to this ROM. To play them, a ROM needs one extra change besides the song (the Studio\'s installer does it; see the ';
  const NOTICE_B = '). Songs that use only the game\'s own instruments need nothing extra.';
  const USES_NONE = 'This song uses only the game\'s own instruments.';

  function mount(root, ctx) {
    const live = [], timers = new Set(), canvases = [], offs = [], host = el('div.designer', { 'data-dz': 'root' });
    let listSig = '', edSig = '', win = null, winKey = '', lastDetect = null, flash = null, stripC = null, meas = null, measKey = '', hoodOpen = !!K.pref('designer.hood', false), snapOn = true, dead = false;
    const P = () => ctx.state.project;
    const cur = () => {
      const B = P().bank, prog = B && B.programs[sel.n];
      if (!prog) return null;
      const region = prog.regions[sel.z];
      if (!region) return null;
      const view = viewOf(B, region);
      return { P: P(), bank: B, n: sel.n, z: sel.z, prog, regions: prog.regions, region, view, range: view ? sourceRange(view) : null };
    };
    const after = (ms, fn) => { const t = setTimeout(() => { timers.delete(t); if (!dead) fn(); }, ms); timers.add(t); return t; };
    const btn = (label, tipText, onclick, o) => { o = o || {}; const b = el('button', { type: 'button', class: ['btn', o.cls], 'data-tip': tipText, 'aria-label': o.aria || (label ? null : 'Button'), onclick }, o.icon ? K.icon(o.icon) : null, label); return b; };
    const group = (title, ...kids) => el('section.group', null, el('h3', null, title), ...kids);
    const canvasOf = (cv, draw, opts) => { const c = K.canvas(cv, draw, opts); canvases.push(c); return c; };

    /* the two texts */
    const space = el('div.dz-space', { 'data-dz': 'space' }), uses = el('div.dz-uses', { 'data-dz': 'uses' });
    const guide = el('a', { href: 'docs/ROM_GUIDE.md', target: '_blank', rel: 'noopener', 'data-tip': tip('ROM guide', 'How a ROM build adds the song and its custom instruments.') }, 'ROM guide');
    const notice = el('div.dz-notice', { 'data-dz': 'notice' }, K.icon('info'), el('div', null, el('b', null, NOTICE_TITLE), NOTICE_A, guide, NOTICE_B));
    const top = el('div.dz-top', null, notice, el('div.dz-status', null, space, uses));
    function renderTop() {
      const sp = D.space(), bank = P().bank;
      const used = sp.total - (sp.free === null ? sp.total : sp.free), v = clamp(sp.free !== null ? used / sp.total : (sp.custom + (sp.song || 0)) / sp.total, 0, 1);
      const breakdown = sp.count ? `256 B of table, ${sp.zones} × 12 B for zones, ${sp.count} × 2 B for instruments, ${sp.views} × 16 B for cuts = ${sp.custom} B.` : 'Each custom instrument costs a few bytes: 12 per zone, 2 per instrument and 16 per cut of a sound.';
      space.replaceChildren('Custom instruments: ', el('b.num', null, sp.count ? kb(sp.custom) : 'none'), ` ${MID} this song: `, el('b.num', null, sp.song === null ? EM : kb(sp.song)),
        ` ${MID} music space in the ROM: `, ...(sp.free !== null ? [el('b.num', null, `${kb(sp.free)} free`), ' of ', el('span.num', null, kb(sp.total)), ', shared by all songs'] : [el('b.num', null, kb(sp.total)), ' in total, shared by all songs']),
        el('span.bar', { class: v >= 1 ? 'bad' : v > 0.8 ? 'warn' : '', style: { '--v': v } }, el('i')));
      space.setAttribute('data-tip', tip('ROM space', 'What the custom instruments and this song take of the music space in the ROM. Every song and the instrument data share it.', breakdown));
      let text;
      if (!sp.used && !sp.count) text = [K.icon('check'), USES_NONE, el('span.faint', null, 'Nothing extra is needed in a ROM.')];
      else if (!sp.used) text = [K.icon('check'), USES_NONE, el('span.faint', null, `${plural(sp.count, 'custom instrument')} (${kb(sp.custom)}) still travel${sp.count === 1 ? 's' : ''} with the song file, so a ROM would need the instrument change. Delete ${sp.count === 1 ? 'it' : 'them'} to send nothing extra.`)];
      else text = [K.icon('sounds'), `This song uses ${plural(sp.used, 'custom instrument')} (${kb(sp.usedBytes)}): the ROM needs the instrument data and the instrument table change.`, el('span.faint', null, 'The Studio\'s installer does both.')];
      uses.className = 'dz-uses' + (sp.used || (bank && sp.count) ? ' custom' : '');
      uses.replaceChildren(...text);
    }

    /* the list of instruments */
    const rows = el('div.dz-rows', { role: 'listbox', 'aria-label': 'My instruments' }), count = el('div.dz-count'), list = el('aside.dz-list');
    const addBtn = btn('New', tip('New instrument', 'Make an instrument from one of the game’s own sounds, or import some from a file.'), () => newMenu(addBtn), { icon: 'plus' });
    const importBtn = btn('Import' + ELL, tip('Import', 'Add instruments from a .sf3bank.json file. They keep their numbers where those are free.'), () => run(importFile), { icon: 'import' });
    const exportBtn = btn('Export all' + ELL, tip('Export all', 'Save every instrument of this song as one .sf3bank.json file.'), () => run(() => exportFile()), { icon: 'export' });
    list.append(el('header', null, el('h3', { class: 'grow' }, 'My instruments'), addBtn), rows, el('div.dz-listfoot', null, count, el('div.hbox', null, importBtn, exportBtn)));
    K.drop(list, { accept: '.json', onDrop: (files) => files.forEach((f) => run(() => importText(f))), onReject: () => K.toast('Drop a .sf3bank.json file here.', { kind: 'warn' }) });
    function renderList() {
      const p = P(), bank = p.bank, nums = listOf(bank), use = usage(p);
      const sig = JSON.stringify([nums.map((n) => [n, bank.programs[n].name, bank.programs[n].regions.length, ownBytes(bank, n), use.get(n) || 0, isKit(bank.programs[n])]), sel.n]);
      const c = nums.length;
      count.replaceChildren(el('span', { class: 'num' }, `${c} of ${MAX_INSTRUMENTS}`), el('span.bar', { class: c > 115 ? 'warn' : '', style: { '--v': c / MAX_INSTRUMENTS } }, el('i')), el('span', null, 'instruments'));
      count.setAttribute('data-tip', tip('Instruments', `A song can carry ${MAX_INSTRUMENTS} custom instruments at most.`, 'Each costs 2 bytes, plus 12 for every zone.'));
      exportBtn.setAttribute('aria-disabled', c ? 'false' : 'true');
      if (sig === listSig) return;
      listSig = sig;
      if (!c) { rows.replaceChildren(el('div.dz-listempty', null, 'Nothing here yet. Instruments you make appear in this list and in the part chooser.')); return; }
      rows.replaceChildren(...nums.map((n) => {
        const prog = bank.programs[n], where = use.get(n), kit = isKit(prog);
        const row = el('div.dz-row', { class: n === sel.n ? 'on' : '', role: 'option', 'aria-selected': String(n === sel.n), tabindex: 0, 'data-n': n, 'data-tip': tip(prog.name || `Instrument ${n}`, 'Select this instrument to edit it. Double-click its name to rename it; right-click for more.', `${plural(prog.regions.length, 'zone')}, ${ownBytes(bank, n)} bytes.`) },
          K.icon(kit ? 'drum' : 'sounds'), el('div', { class: 'grow' }, el('div.name', null, prog.name || `Instrument ${n}`), el('div', { class: 'meta' + (where ? ' used' : '') }, [plural(prog.regions.length, 'zone'), kit ? 'kit' : null, where ? where.join(', ') : 'not used yet'].filter(Boolean).join(` ${MID} `))),
          el('span.tag.num', null, `${ownBytes(bank, n)} B`));
        row.onclick = () => choose(n);
        row.querySelector('.name').ondblclick = (e) => { e.stopPropagation(); renameDialog(n); };
        row.oncontextmenu = (e) => { e.preventDefault(); choose(n); instrumentMenu(e); };
        row.onkeydown = (e) => {
          const i = nums.indexOf(n);
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const to = nums[clamp(i + (e.key === 'ArrowDown' ? 1 : -1), 0, nums.length - 1)]; choose(to); later(() => { const r = rows.querySelector(`[data-n="${to}"]`); if (r) r.focus(); }); }
          else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); hearZone(); }
          else if (e.key === 'F2') { e.preventDefault(); renameDialog(n); }
          else if (e.key === 'Delete') { e.preventDefault(); removeDialog(n); }
        };
        return row;
      }));
    }
    function choose(n, z) { sel = { n, z: z || 0 }; renderList(); renderEditor(); }
    async function renameDialog(n) { const name = await K.prompt('Instrument name', { value: P().bank.programs[n].name || '', ok: 'Rename' }); if (name !== null && name.trim()) run(() => D.rename(n, name.trim())); }
    async function removeDialog(n) {
      const where = usage(P()).get(n), name = P().bank.programs[n].name || `Instrument ${n}`;
      const ok = await K.confirm(where ? `${where.join(' and ')} play${where.length === 1 ? 's' : ''} this instrument. If you delete it, ${where.length === 1 ? 'that part' : 'those parts'} will be silent.` : 'This removes the instrument and its cuts of the game’s sounds from the song.', { title: `Delete ${name}?`, ok: 'Delete', danger: true });
      if (ok) run(() => D.remove(n));
    }
    function instrumentMenu(anchor) {
      const n = sel.n, items = [{ label: 'Rename' + ELL, run: () => renameDialog(n) }, { label: 'Duplicate', icon: 'copy', run: () => run(() => D.duplicate(n)) }, { label: 'Export this instrument' + ELL, icon: 'export', run: () => run(() => exportFile([n])) }, '-', { label: 'Delete' + ELL, icon: 'trash', danger: true, run: () => removeDialog(n) }];
      K.menu(anchor, items);
    }
    function newMenu(anchor) {
      K.menu(anchor, [{ label: 'From a game sound' + ELL, icon: 'sounds', run: () => startNew(true) }, { heading: 'Start from a preset' },
        { label: 'Pluck' + ELL, run: () => startNew('pluck') }, { label: 'Pad' + ELL, run: () => startNew('pad') }, { label: 'Loop' + ELL, run: () => startNew('loop') }, '-', { label: 'Import from a file' + ELL, icon: 'import', run: () => run(importFile) }]);
    }
    async function startNew(create) {
      const r = await pickSource({ title: create === true ? 'Make an instrument from a game sound' : `Make a ${create} from a game sound`, create });
      if (!r) return;
      const made = run(() => D.create({ sample: r.sample, preset: r.preset }));
      if (!made) return;
      if (r.preset === 'loop') K.toast(made.loop ? `A clean loop of ${plural(made.loop.periods, 'cycle')} was found (${seconds(made.loop.seconds)}), and the sound is tuned to it.` : 'No clean loop was found in this sound, so the instrument plays it as it is. Try a sound with a steady pitch.', { kind: made.loop ? 'good' : 'warn' });
    }
    async function importFile() { const f = await K.pickFile('.json,.sf3bank.json'); if (f) await importText(f); }
    async function importText(file) {
      let obj;
      try { obj = JSON.parse(await file.text()); } catch (e) { fail('This file is not a readable instrument file.'); }
      let made;
      try { made = D.importData(obj); } catch (e) { fail(/^This file/.test(e.message) ? e.message : `These instruments cannot be used here: ${e.message}`); }
      K.toast(`Added ${plural(made.numbers.length, 'instrument')} from ${file.name}.`, { kind: 'good' });
    }
    function exportFile(numbers) {
      const data = D.exportData(numbers), name = (numbers && numbers.length === 1 ? data.name : proj().name || 'Instruments').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').trim() || 'Instruments';
      K.download(`${name}.sf3bank.json`, JSON.stringify(data, null, 2), 'application/json');
      K.toast(`Saved ${plural(Object.keys(data.programs).length, 'instrument')} as ${name}.sf3bank.json.`, { kind: 'good' });
    }

    /* the editor */
    const main = el('section.dz-main'), insp = el('aside.dz-inspector'), body = el('div.dz-body', null, list, main, insp);
    const clearLive = () => { live.length = 0; while (canvases.length) canvases.pop().destroy(); };
    function renderEditor() {
      clearLive();
      const c = cur();
      body.classList.toggle('empty', !c);
      if (!c) { edSig = ''; main.replaceChildren(emptyState()); insp.replaceChildren(); return; }
      edSig = editorSig(c);
      winKey = '';
      const keep = insp.scrollTop, keepMain = main.scrollTop;
      main.replaceChildren(buildHead(), buildZones(), buildSound());
      insp.replaceChildren(...buildInspector());
      insp.scrollTop = keep; main.scrollTop = keepMain;
      syncEditor();
    }
    const editorSig = (c) => [c.n, c.z, c.regions.length, c.region.sample && (c.region.sample.view !== undefined ? 'v' : 'r'), c.view && c.view.source].join('|');
    function syncEditor() { for (const f of live) f(); measureSoon(); }
    function emptyState() {
      const starter = (kind, label, text) => btn(label, tip(label, text), () => startNew(kind));
      return el('div.empty', { 'data-dz': 'empty' }, K.icon('sounds', 'lg'), el('b', null, 'Make an instrument from the game’s own sounds'),
        el('p', null, 'Choose any of the game’s 733 sounds, cut it, loop it, tune it and shape how it starts and fades. Your instruments appear here and in the part chooser.'),
        el('div.hbox', null, btn('From a game sound' + ELL, tip('From a game sound', 'Choose a sound and make a plain instrument from it.'), () => startNew(true), { cls: 'primary', icon: 'plus' }), btn('Import' + ELL, tip('Import', 'Add instruments from a .sf3bank.json file.'), () => run(importFile), { icon: 'import' })),
        el('p', { class: 'hint' }, 'Or start from a preset:'),
        el('div.hbox', null, starter('pluck', 'Pluck', 'Fast decay: a struck or plucked sound.'), starter('pad', 'Pad', 'Slow attack and a long release: a swelling sound.'), starter('loop', 'Loop', 'A one-cycle loop, a steady tone found for you.')));
    }

    /* header: name, tags, buttons */
    function buildHead() {
      const name = el('input.field.bare.dz-name', { 'aria-label': 'Instrument name', spellcheck: false, 'data-tip': tip('Instrument name', 'Rename this instrument. The part chooser and the piano roll show this name.') });
      name.onchange = () => run(() => { if (name.value.trim()) D.rename(sel.n, name.value.trim()); });
      name.onkeydown = (e) => { if (e.key === 'Enter') name.blur(); };
      const num = el('span.tag.num', { 'data-tip': tip('Instrument number', 'The number a song file uses for this instrument. Songs that share a ROM must agree on it.') });
      const zones = el('span.tag'), bytes = el('span.tag.num', { 'data-tip': tip('Size', 'What this instrument takes in the ROM: 2 bytes, 12 for each zone and 16 for each cut.') });
      const kit = el('span.tag.accent', { 'data-tip': tip('Kit', 'A different sound on each key, like a drum kit.') }, 'kit');
      const use = btn('Use on a part', tip('Use on a part', 'Make a part of this song play this instrument, or start a new part with it.'), () => useMenu(use), { icon: 'link' });
      const more = btn('', tip('More', 'Rename, duplicate, export or delete this instrument.'), () => instrumentMenu(more), { icon: 'more', cls: 'icon ghost', aria: 'More' });
      live.push(() => {
        const c = cur(); if (!c) return;
        if (document.activeElement !== name) name.value = c.prog.name || '';
        num.textContent = `No. ${c.n}`; zones.textContent = plural(c.regions.length, 'zone'); bytes.textContent = `${ownBytes(c.bank, c.n)} B`; kit.hidden = !isKit(c.prog);
      });
      return el('div.dz-head', null, name, num, zones, kit, bytes, el('span.grow'), use, more);
    }
    function useMenu(anchor) {
      const parts = P().parts, n = sel.n;
      const items = parts.map((p) => ({ label: p.name || p.id, run: () => run(() => D.usePart(p.id, n)) }));
      if (items.length) items.push('-');
      items.push({ label: 'New part with this instrument', icon: 'plus', run: () => run(() => {
        const prog = P().bank.programs[n], role = isKit(prog) ? 'drums' : 'lead';
        if (!S.compose || !S.compose.addPart) fail('Open Compose to add a part.');
        const id = S.compose.addPart(role, { bank: slotOf(P().bank), program: n });
        ctx.edit('Name part', (p) => { const part = p.parts.find((x) => x.id === id); if (part) part.name = prog.name || part.name; });
      }) });
      K.menu(anchor, items);
    }
    const hearKey = (n, key) => Promise.resolve(run(() => D.hear(n, key))).catch((e) => K.toast(e.message, { kind: 'warn' }));
    function hearZone() {
      const c = cur(); if (!c || !c.view) return;
      hearKey(c.n, clamp(c.view.root, zoneLow(c.regions, c.z), Math.min(127, c.region.keyHigh)));
    }

    /* key zones on a keyboard strip */
    const LO = 12, HI = 120, PADX = 10, BAND = 34;
    function buildZones() {
      const hint = el('span.hint', null, '12 bytes a zone');
      const split = btn('Split', tip('Split zone', 'Cut the selected zone in two at its middle. The new zone starts as a copy.', 'Costs 12 bytes, and 16 more for its own cut.'), () => run(() => { const c = cur(); const r = D.addZone(c.n, c.z); sel.z = r.z; renderEditor(); }), { icon: 'plus' });
      const remove = btn('Remove', tip('Remove zone', 'Delete the selected zone. The zone above it takes over its keys.'), () => run(() => { const c = cur(); D.removeZone(c.n, c.z); sel.z = clamp(c.z, 0, cur().regions.length - 1); renderEditor(); }), { icon: 'minus' });
      live.push(() => { const c = cur(); if (!c) return; remove.setAttribute('aria-disabled', c.regions.length < 2 ? 'true' : 'false'); const w = c.region.keyHigh - zoneLow(c.regions, c.z); split.setAttribute('aria-disabled', w < 1 ? 'true' : 'false'); });
      const cv = el('canvas', { 'aria-label': 'Key zones', 'data-tip': tip('Key zones', 'Each zone is a range of keys that plays one sound. Click a zone to edit it, drag its edge to move the split, double-click to split it, click a key to hear it.', 'Costs 12 bytes a zone.') });
      const wrap = el('div.dz-strip', null, cv);
      const G = (w) => { const kw = (w - 2 * PADX) / (HI - LO + 1); return { kw, x: (k) => PADX + (k - LO) * kw }; };
      const keyAt = (px, w) => clamp(Math.floor((px - PADX) / G(w).kw) + LO, 0, 127);
      const edgeAt = (px, py, w) => {
        const c = cur(); if (!c || py > BAND + 4) return -1;
        for (let z = 0; z < c.regions.length; z++) { const hi = c.regions[z].keyHigh; if (hi >= HI) continue; if (Math.abs(px - G(w).x(hi + 1)) <= 5) return z; }
        return -1;
      };
      const zoneAt = (key) => { const c = cur(); let z = c.regions.findIndex((r) => r.keyHigh >= key); return z < 0 ? c.regions.length - 1 : z; };
      const canvas = canvasOf(cv, (c, w, h) => {
        const q = cur(); if (!q) return;
        const css = K.css, geo = G(w);
        c.fillStyle = css('--bg-1'); c.fillRect(0, 0, w, h);
        c.font = css('--cv-font'); c.textBaseline = 'middle';
        q.regions.forEach((r, z) => {
          const low = Math.max(zoneLow(q.regions, z), LO), high = Math.min(r.keyHigh, HI);
          if (high < low) return;
          const x0 = geo.x(low), x1 = geo.x(high + 1), on = z === q.z;
          c.fillStyle = css(on ? '--accent-soft' : '--bg-3'); c.beginPath(); c.roundRect(x0 + 1, 6, Math.max(2, x1 - x0 - 2), BAND - 8, 3); c.fill();
          if (on) { c.fillStyle = css('--accent'); c.fillRect(x0 + 1, BAND - 4, Math.max(2, x1 - x0 - 2), 2); }
          const v = viewOf(q.bank, r), label = (v && v.name) || `Zone ${z + 1}`;
          c.save(); c.beginPath(); c.rect(x0 + 5, 6, Math.max(0, x1 - x0 - 10), BAND - 8); c.clip();
          c.fillStyle = css(on ? '--accent-2' : '--ink-2'); c.fillText(x1 - x0 > 60 ? label : String(z + 1), x0 + 7, 17); c.restore();
          if (r.keyHigh < HI) { c.fillStyle = css(on ? '--accent' : '--line-3'); c.fillRect(Math.round(x1) - 1, 6, 2, BAND - 8); }
        });
        const kt = BAND + 6, kh = h - kt - 16;
        for (let k = LO; k <= HI; k++) {
          const black = [1, 3, 6, 8, 10].includes(k % 12), x = geo.x(k), inZone = k >= zoneLow(q.regions, q.z) && k <= q.region.keyHigh;
          c.fillStyle = css(black ? '--cv-key-black' : '--cv-key'); c.fillRect(x, kt, Math.max(1, geo.kw - 1), kh);
          if (inZone) { c.fillStyle = css('--accent-soft'); c.fillRect(x, kt, Math.max(1, geo.kw - 1), kh); }
          if (flash && flash.key === k && flash.until > performance.now()) { c.fillStyle = css('--accent'); c.fillRect(x, kt, Math.max(1, geo.kw - 1), kh); }
        }
        c.font = css('--cv-mono-sm'); c.fillStyle = css('--ink-3'); c.textBaseline = 'alphabetic';
        for (let k = LO; k <= HI; k++) if (k % 12 === 0) c.fillText(noteName(k), geo.x(k), h - 4);
        if (q.view) { const rk = clamp(q.view.root, LO, HI), x = geo.x(rk) + geo.kw / 2; c.fillStyle = css('--accent'); c.beginPath(); c.moveTo(x - 4, kt + kh + 1); c.lineTo(x + 4, kt + kh + 1); c.lineTo(x, kt + kh - 5); c.fill(); }
      });
      stripC = canvas; live.push(() => canvas.invalidate());
      let hoverEdge = false;
      cv.addEventListener('pointermove', (e) => { const r = cv.getBoundingClientRect(), edge = edgeAt(e.clientX - r.left, e.clientY - r.top, r.width) >= 0; if (edge !== hoverEdge) { hoverEdge = edge; cv.style.cursor = edge ? 'ew-resize' : ''; } });
      K.drag(cv, {
        threshold: 3,
        start(d) { const z = edgeAt(d.x, d.y, canvas.w); return z >= 0 ? { edge: z, edited: false } : { edge: -1 }; },
        move(d) { if (d.state.edge < 0) return; const c = cur(); if (!c) return; const key = Math.round((d.x - PADX) / G(canvas.w).kw) + LO - 1; const before = c.regions[d.state.edge].keyHigh; run(() => D.moveSplit(c.n, d.state.edge, key)); if (cur().regions[d.state.edge].keyHigh !== before) d.state.edited = true; },
        end(d, cancelled) {
          if (d.state.edge >= 0) { if (cancelled && d.state.edited) ctx.state.undo(); return; }
          if (cancelled || d.moved) return;
          const key = keyAt(d.x, canvas.w), z = zoneAt(key);
          if (z !== sel.z) { sel.z = z; renderEditor(); }
          if (d.y > BAND + 4) { const c = cur(); flash = { key, until: performance.now() + 260 }; if (stripC) stripC.invalidate(); after(280, () => { if (stripC) stripC.invalidate(); }); hearKey(c.n, key); }
        },
      });
      cv.addEventListener('dblclick', (e) => {
        const r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
        if (y > BAND + 4 || edgeAt(x, y, r.width) >= 0) return;
        const c = cur(), key = keyAt(x, r.width), z = zoneAt(key);
        run(() => { const out = D.addZone(c.n, z, key); sel.z = out.z; renderEditor(); });
      });
      return el('div.dz-block', { 'data-dz': 'zones' }, el('header', null, el('h3', null, 'Key zones'), split, remove, hint), wrap);
    }

    /* sound: the cut, the loop and the waveform */
    function buildSound() {
      const label = el('span', { class: 'dim' }), hint = el('span.hint', null, '16 bytes a cut');
      const loopSw = el('button.switch', { 'aria-label': 'Loop' }), snapSw = el('button.switch', { 'aria-label': 'Snap to cycles' });
      const loopT = K.toggle(loopSw, { onChange: (on) => run(() => D.setLoop(sel.n, sel.z, on)) }), snapT = K.toggle(snapSw, { value: snapOn, onChange: (on) => { snapOn = on; } });
      const hear = btn('Hear', tip('Hear', 'Play this zone at its root key.', 'A looped sound plays on for the length of the note.'), hearZone, { icon: 'play' });
      const find = btn('Find a clean loop', tip('Find a clean loop', 'Looks for a loop of whole cycles that joins without a click, and tunes the sound to match it.'), () => K.menu(find, [
        { label: 'One cycle (a steady tone)', run: () => doLoop('cycle') }, { label: 'Long loop (keeps the sound’s character)', run: () => doLoop('long') }]), { icon: 'loop' });
      const slice = btn('Slice into a kit' + ELL, tip('Slice into a kit', 'Cut this sound into pieces and give each piece its own key, like a drum break chopped into hits.', 'Makes a new instrument.'), async () => {
        const c = cur(); if (!c || !c.view) return;
        const o = await sliceDialog(c); if (!o) return;
        const made = run(() => D.slice(c.n, c.z, o));
        if (made) K.toast(`Made a kit of ${made.count} pieces on keys ${noteName(o.first)}${EN}${noteName(o.first + made.count - 1)}.`, { kind: 'good' });
      }, { icon: 'drum' });
      const zoomOut = btn('', tip('Zoom out', 'Show more of the sound.', 'Scroll the wheel over the waveform to zoom.'), () => zoomBy(1 / 1.6), { icon: 'zoomout', cls: 'icon ghost', aria: 'Zoom out' });
      const zoomIn = btn('', tip('Zoom in', 'Show less of the sound, in more detail.'), () => zoomBy(1.6), { icon: 'zoomin', cls: 'icon ghost', aria: 'Zoom in' });
      const fitBtn = btn('Fit', tip('Fit', 'Show the whole cut. Press again to show the whole recording.'), () => fitWin(true), { cls: 'ghost' });
      const tools = el('div.dz-tools', null, hear, el('span.sep'), el('label.dz-sw', { 'data-tip': tip('Loop', 'On: the sound repeats its loop while a note is held. Off: it plays once and stops where it ends.', 'A looped sound stops within one loop after the note ends.') }, loopSw, 'Loop'),
        el('label.dz-sw', { 'data-tip': tip('Snap to cycles', 'Handles jump to the nearest rising zero crossing, so cuts and loops do not click.', 'Hold Alt to place a handle freely.') }, snapSw, 'Snap'), el('span.sep'), find, slice, el('span.grow'), zoomOut, zoomIn, fitBtn);

      const cv = el('canvas', { 'aria-label': 'Waveform', 'data-tip': tip('Waveform', 'Drag a handle to move the start, the loop or the end of the sound. Scroll to zoom, Shift-scroll to move along it, drag the background to pan.', 'Alt places a handle freely.') });
      const ov = el('canvas', { 'aria-label': 'Overview', 'data-tip': tip('Overview', 'The whole recording. Drag the box to move along it; the bracket is the cut.') });
      const nums = el('div.dz-nums'), info = el('span.grow.num');
      const numField = (name, key, hintText) => {
        const input = el('input.field.num', { 'aria-label': name, 'data-tip': tip(name, hintText, 'In samples from the start of the recording.') });
        const ctl = K.number(input, { min: 0, max: 8347648, step: 1, value: 0, format: (v) => K.fmt.int(v), parse: (s) => parseFloat(String(s).replace(/[, ]/g, '')), onInput: (v) => { const q = cur(); if (!q) return; run(() => D.setView(q.n, q.z, { [key]: v + q.range.lo })); } });
        live.push(() => { const q = cur(); if (!q || !q.view || document.activeElement === input) return; let v = q.view[key]; if (key === 'loop') { const on = v !== null && v !== undefined && v < q.view.end; input.disabled = !on; v = on ? v : q.view.end; } ctl.set(v - q.range.lo, true); });
        return el('label.lab', { 'data-tip': tip(name, hintText, 'In samples from the start of the recording.') }, el('span', null, name), input);
      };
      nums.append(numField('Start', 'start', 'Where the sound begins.'), numField('Loop', 'loop', 'Where the repeating part begins. It repeats until the end.'), numField('End', 'end', 'Where the sound stops, and where its loop turns round.'), info);
      live.push(() => {
        const q = cur(); if (!q || !q.view) return;
        label.textContent = `${q.view.name || sampleLabel(q.view.source)}`;
        loopT.set(q.view.loop !== null && q.view.loop !== undefined && q.view.loop < q.view.end, true);
        info.textContent = `${seconds((q.view.end - q.view.start) / Bk().ROOT_RATE)} ${MID} ${K.fmt.int(q.view.end - q.view.start)} samples`;
      });

      const RUL = 22, MIN = MIN_CUT;
      const range = () => { const q = cur(); return q && q.view ? q : null; };
      function fitWin(toggle) {
        const q = range(); if (!q) return;
        const pad = Math.max(32, (q.view.end - q.view.start) * 0.06), whole = { from: q.range.lo, to: q.range.hi }, cutW = { from: Math.max(q.range.lo, q.view.start - pad), to: Math.min(q.range.hi, q.view.end + pad) };
        const nearCut = win && Math.abs(win.from - cutW.from) < 2 && Math.abs(win.to - cutW.to) < 2;
        win = toggle && nearCut ? whole : cutW; canvas.invalidate(); overview.invalidate();
      }
      function setWin(from, to) {
        const q = range(); if (!q) return;
        const span = clamp(to - from, 32, q.range.hi - q.range.lo);
        from = clamp(from, q.range.lo, q.range.hi - span); win = { from, to: from + span }; canvas.invalidate(); overview.invalidate();
      }
      function zoomBy(f, at) { if (!win) return; const mid = at === undefined ? (win.from + win.to) / 2 : at, span = (win.to - win.from) / f; setWin(mid - (mid - win.from) / f, mid - (mid - win.from) / f + span); }
      const sx = (i, w) => (i - win.from) / (win.to - win.from) * w, at = (x, w) => win.from + x / w * (win.to - win.from);
      function ensureWin() { const q = range(); if (!q) return false; const key = `${q.n}:${q.z}:${q.range.lo}`; if (!win || key !== winKey) { winKey = key; fitWin(false); } return true; }
      function handles(q, w) {
        const v = q.view, out = [{ k: 'start', x: sx(v.start, w) }, { k: 'end', x: sx(v.end, w) }];
        if (v.loop !== null && v.loop !== undefined && v.loop < v.end) out.push({ k: 'loop', x: sx(v.loop, w) });
        return out;
      }
      const canvas = canvasOf(cv, (c, w, h) => {
        if (!ensureWin()) return;
        const q = cur(), css = K.css, v = q.view, sm = samples(), span = win.to - win.from, spp = span / w, mid = RUL + (h - RUL) / 2, amp = (h - RUL) / 2 - 8;
        c.fillStyle = css('--bg-0'); c.fillRect(0, 0, w, h); c.fillStyle = css('--bg-1'); c.fillRect(0, 0, w, RUL);
        const loopOn = v.loop !== null && v.loop !== undefined && v.loop < v.end, xs = Math.max(0, sx(v.start, w)), xe = Math.min(w, sx(v.end, w));
        if (loopOn) { c.fillStyle = css('--accent-soft'); const xl = Math.max(0, sx(v.loop, w)); c.fillRect(xl, RUL, Math.max(0, xe - xl), h - RUL); }
        c.fillStyle = css('--cv-out-of-scale'); if (xs > 0) c.fillRect(0, RUL, xs, h - RUL); if (xe < w) c.fillRect(xe, RUL, w - xe, h - RUL);
        /* time ruler, in seconds at the root key's own speed */
        c.font = css('--cv-mono-sm'); c.textBaseline = 'middle';
        const per = Bk().ROOT_RATE, steps = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2], pxPerSec = w / (span / per), stepS = steps.find((s) => s * pxPerSec >= 64) || 5;
        for (let t = Math.ceil((win.from - q.range.lo) / per / stepS) * stepS; q.range.lo + t * per < win.to; t += stepS) {
          const x = Math.round(sx(q.range.lo + t * per, w));
          c.fillStyle = css('--cv-grid-faint'); c.fillRect(x, RUL, 1, h - RUL); c.fillStyle = css('--ink-3'); c.fillText(`${+t.toFixed(3)} s`, x + 4, RUL / 2 + 1);
        }
        c.fillStyle = css('--line-2'); c.fillRect(0, Math.round(mid), w, 1);
        /* the wave: one column of minimum and maximum per pixel, or a line when zoomed far in */
        const lo = Math.max(win.from, q.range.lo), hi = Math.min(win.to, q.range.hi);
        if (spp <= 1.2) {
          c.lineWidth = 1.5; c.beginPath();
          for (let i = Math.max(Math.floor(lo), 0); i <= hi; i++) { const x = sx(i, w), y = mid - sm[i] / 128 * amp; if (i === Math.max(Math.floor(lo), 0)) c.moveTo(x, y); else c.lineTo(x, y); }
          c.strokeStyle = css('--ink'); c.stroke();
          if (spp < 0.12) { c.fillStyle = css('--ink'); for (let i = Math.max(Math.floor(lo), 0); i <= hi; i++) c.fillRect(sx(i, w) - 1.5, mid - sm[i] / 128 * amp - 1.5, 3, 3); }
        } else {
          for (let px = 0; px < w; px++) {
            const a = Math.floor(win.from + px * spp), b = Math.max(a + 1, Math.floor(win.from + (px + 1) * spp));
            if (a < q.range.lo || a >= q.range.hi) continue;
            let mn = 127, mx = -128;
            for (let i = a, e = Math.min(b, q.range.hi); i < e; i++) { const s = sm[i]; if (s < mn) mn = s; if (s > mx) mx = s; }
            const inside = a >= v.start && a < v.end;
            c.fillStyle = css(inside ? '--ink-2' : '--ink-4');
            c.fillRect(px, mid - mx / 128 * amp, 1, Math.max(1, (mx - mn) / 128 * amp + 1));
          }
        }
        /* handles */
        c.textBaseline = 'middle'; c.font = css('--cv-font');
        for (const hd of handles(q, w)) {
          if (hd.x < -2 || hd.x > w + 2) continue;
          const x = Math.round(hd.x), col = css(hd.k === 'loop' ? '--accent' : '--ink'), name = hd.k === 'start' ? 'Start' : hd.k === 'end' ? 'End' : 'Loop';
          c.fillStyle = col; c.fillRect(x, 0, 1, h);
          const tw = c.measureText(name).width + 10, fx = hd.k === 'end' ? x - tw : x;
          c.fillRect(fx, 2, tw, RUL - 6); c.fillStyle = css(hd.k === 'loop' ? '--accent-ink' : '--bg-0'); c.fillText(name, fx + 5, RUL / 2 - 1);
        }
      });
      live.push(() => { canvas.invalidate(); overview.invalidate(); });
      let drag = null;
      const handleAt = (x) => { const q = range(); if (!q) return null; let best = null; for (const hd of handles(q, canvas.w)) { const d = Math.abs(hd.x - x); if (d <= 7 && (!best || d < best.d || (d === best.d && hd.k === 'loop'))) best = { k: hd.k, d }; } return best && best.k; };
      cv.addEventListener('pointermove', (e) => { if (drag) return; const r = cv.getBoundingClientRect(); cv.style.cursor = handleAt(e.clientX - r.left) ? 'ew-resize' : 'grab'; });
      function snapZero(i, radius) { const sm = samples(); for (let d = 0; d <= radius; d++) for (const j of [i - d, i + d]) if (j > 0 && sm[j - 1] < 0 && sm[j] >= 0) return j; return i; }
      K.drag(cv, {
        threshold: 2,
        start(d) { const k = handleAt(d.x); if (!ensureWin()) return false; drag = { kind: k || 'pan', from: win.from, to: win.to, edited: false }; return drag; },
        move(d) {
          const st = d.state, q = range(); if (!q) return;
          if (st.kind === 'pan') { const spp = (st.to - st.from) / canvas.w, sh = -d.dx * spp; setWin(st.from + sh, st.to + sh); return; }
          const v = q.view, spp = (win.to - win.from) / canvas.w;
          let i = Math.round(at(d.x, canvas.w));
          if (snapOn && !d.alt) i = snapZero(i, clamp(Math.round(7 * spp), 6, 4000));
          const loopOn = v.loop !== null && v.loop !== undefined && v.loop < v.end;
          if (st.kind === 'start') i = clamp(i, q.range.lo, v.end - MIN);
          else if (st.kind === 'end') i = clamp(i, v.start + MIN, q.range.hi);
          else i = clamp(i, v.start, v.end - MIN);
          if (i === v[st.kind] && !(st.kind === 'loop' && !loopOn)) return;
          const patch = { [st.kind]: i }; if (st.kind === 'end' && loopOn && v.loop > i - MIN) patch.loop = i - MIN;
          run(() => D.setView(q.n, q.z, patch)); st.edited = true;
        },
        end(d, cancelled) { drag = null; if (cancelled && d.state.edited) ctx.state.undo(); },
      });
      K.wheel(cv, { scroll(dx, dy, info) { if (!win) return; if (dx) setWin(win.from + dx * (win.to - win.from) / canvas.w, win.to + dx * (win.to - win.from) / canvas.w); else zoomBy(Math.exp(-dy * 0.0015), at(info.x, canvas.w)); }, zoom(f, info) { zoomBy(f, at(info.x, canvas.w)); } });

      const overview = canvasOf(ov, (c, w, h) => {
        const q = range(); if (!q || !ensureWin()) return;
        const css = K.css, v = q.view, span = q.range.hi - q.range.lo, X = (i) => (i - q.range.lo) / span * w, p = peaks(q.range.lo, q.range.hi, Math.max(16, Math.round(w))), mid = h / 2;
        c.fillStyle = css('--bg-1'); c.fillRect(0, 0, w, h);
        if (v.loop !== null && v.loop !== undefined && v.loop < v.end) { c.fillStyle = css('--accent-soft'); c.fillRect(X(v.loop), 0, X(v.end) - X(v.loop), h); }
        const n = p.length / 2;
        for (let i = 0; i < n; i++) { const x = i * w / n, inside = x >= X(v.start) - 1 && x <= X(v.end); c.fillStyle = css(inside ? '--ink-2' : '--ink-4'); const top = mid - p[2 * i + 1] / 128 * (mid - 3), bot = mid - p[2 * i] / 128 * (mid - 3); c.fillRect(x, top, Math.max(1, w / n), Math.max(1, bot - top)); }
        c.strokeStyle = css('--ink-3'); c.lineWidth = 1; c.strokeRect(Math.round(X(win.from)) + 0.5, 1.5, Math.max(4, Math.round(X(win.to) - X(win.from))), h - 3);
      });
      K.drag(ov, {
        threshold: 0,
        start(d) { if (!ensureWin()) return false; const q = range(), span = q.range.hi - q.range.lo, i = q.range.lo + d.x / ov.clientWidth * span; if (i < win.from || i > win.to) setWin(i - (win.to - win.from) / 2, i + (win.to - win.from) / 2); return { grab: i - win.from }; },
        move(d) { const q = range(), span = q.range.hi - q.range.lo, i = q.range.lo + d.x / ov.clientWidth * span, w = win.to - win.from; setWin(i - d.state.grab, i - d.state.grab + w); },
      });
      const doLoop = (mode) => {
        const q = cur(); if (!q) return;
        const info2 = run(() => D.findLoop(q.n, q.z, mode));
        if (info2) { fitWin(false); K.toast(`A clean loop of ${plural(info2.periods, 'cycle')} (${seconds(info2.seconds)}) was found. The root key and fine tune were set to match.`, { kind: 'good' }); }
      };
      return el('div.dz-block.dz-sound', { 'data-dz': 'sound' }, el('header', null, el('h3', null, 'Sound'), label, hint), tools,
        el('div.dz-wave', null, cv), el('div.dz-over', null, ov), nums);
    }

    /* zone settings */
    function slideRow(name, tipText, o) {
      const input = el('input', { type: 'range' }), out = el('span.num.dim.dz-out');
      const sl = K.slider(input, { min: o.min, max: o.max, step: 1, value: o.min, def: o.def, format: o.format, readout: out, label: name, onInput: (v) => run(() => o.set(v)) });
      live.push(() => { if (cur()) sl.set(o.get(), true); });
      return el('label.lab', { 'data-tip': tipText }, el('span', null, name), el('span.hbox.dz-ctl', null, input, out));
    }
    function switchRow(name, tipText, get, set) {
      const sw = el('button.switch', { 'aria-label': name }), t = K.toggle(sw, { onChange: (on) => run(() => set(on)) });
      live.push(() => { if (cur()) t.set(get(), true); });
      return el('label.lab', { 'data-tip': tipText }, el('span', null, name), sw);
    }
    function buildInspector() {
      /* zone */
      const zsel = K.select(el('button', { type: 'button', 'aria-label': 'Zone', 'data-tip': tip('Zone', 'Choose which key zone to edit. The strip above shows them all.') }), [], { value: 0, onPick: (v) => { sel.z = Number(v); renderEditor(); } });
      const high = el('input.field.num', { 'aria-label': 'Highest key' }), highCtl = K.number(high, { min: 0, max: 127, step: 1, value: 127, format: noteName, parse: (s) => { const n = K.fmt.parseNote(s); return n !== null ? n : parseFloat(s); }, onInput: (v) => { const c = cur(); if (c) run(() => D.moveSplit(c.n, c.z, v)); } });
      const from = el('span.num.dim');
      live.push(() => {
        const c = cur(); if (!c) return;
        zsel.setOptions(c.regions.map((r, i) => ({ value: i, label: `Zone ${i + 1} ${MID} ${noteName(zoneLow(c.regions, i))}${EN}${noteName(Math.min(127, r.keyHigh))}` })), c.z);
        if (document.activeElement !== high) highCtl.set(c.region.keyHigh, true);
        from.textContent = `from ${noteName(zoneLow(c.regions, c.z))}`;
      });
      const zone = group('Zone', el('div.dz-zonebar', null, zsel.el), el('label.lab', { 'data-tip': tip('Highest key', 'The top key this zone plays. Dragging the zone’s edge on the strip does the same.') }, el('span', null, 'Highest key'), el('span.hbox', null, from, high)));

      /* sound card */
      const thumbCv = el('canvas', { 'aria-hidden': 'true' }), cardTitle = el('b'), cardSub = el('small');
      const card = el('button.dz-source', { type: 'button', 'data-tip': tip('Change sound', 'Pick a different one of the game’s 733 sounds for this zone.', 'Resets the cut and the tuning.') }, thumbCv, el('div.grow', null, cardTitle, cardSub), K.icon('down'));
      card.onclick = async () => {
        const c = cur(); if (!c) return;
        const r = await pickSource({ title: 'Choose a sound for this zone', current: c.view && c.view.source });
        if (r) run(() => D.setSource(c.n, c.z, r.sample));
      };
      let cardKey = '';
      live.push(() => {
        const c = cur(); if (!c || !c.view) return;
        const key = `${c.range.lo}:${c.range.hi}`; if (key !== cardKey) { cardKey = key; thumb(thumbCv, c.range.lo, c.range.hi, 72, 28); }
        cardTitle.textContent = c.range.sample ? sampleLabel(c.range.sample.index) : (c.view.name || 'Sound');
        cardSub.textContent = c.range.sample ? `${seconds((c.range.hi - c.range.lo) / Bk().ROOT_RATE)} ${MID} ${c.range.sample.looped ? 'loops' : 'plays once'} ${MID} cut ${seconds((c.view.end - c.view.start) / Bk().ROOT_RATE)}` : 'A stretch of the game’s sound data';
      });
      const sound = group('Source', card);

      /* tuning */
      const root = el('input.field.num', { 'aria-label': 'Root key' }), rootCtl = K.number(root, { min: 0, max: 127, step: 1, value: 60, format: noteName, parse: (s) => { const n = K.fmt.parseNote(s); return n !== null ? n : parseFloat(s); }, onInput: (v) => { const c = cur(); if (c) run(() => D.setView(c.n, c.z, { root: v })); } });
      const fine = el('input.field.num', { 'aria-label': 'Fine tune' }), fineCtl = K.number(fine, { min: -50, max: 49, step: 1, value: 0, format: (v) => `${v > 0 ? '+' : v < 0 ? MINUS : ''}${Math.abs(Math.round(v))} c`, parse: (s) => parseFloat(String(s).replace(MINUS, '-')), onInput: (v) => { const c = cur(); if (c) run(() => D.setZone(c.n, c.z, { fine: Math.round(v * 2.56) })); } });
      const detect = el('div.hint.dz-detect');
      const detectBtn = btn('Detect pitch', tip('Detect pitch', 'Measures the sound’s pitch and sets the root key and fine tune so it plays in tune.', 'Works on steady, pitched sounds. Drum hits and noise have no pitch to find.'), () => {
        const c = cur(); if (!c) return;
        const r = run(() => D.detectPitch(c.n, c.z));
        if (r) { lastDetect = `Measured ${noteName(r.note)}, ${Math.abs(Math.round(r.cents))} cents ${r.cents < 0 ? 'flat' : 'sharp'}${r.confidence < 0.8 ? ' (not sure: the sound is not clearly pitched)' : ''}. Root key and fine tune were set to match.`; renderDetect(); }
      }, { icon: 'tune' });
      const renderDetect = () => { detect.textContent = lastDetect || ''; detect.className = 'hint dz-detect' + (lastDetect && /not sure/.test(lastDetect) ? ' bad' : ''); };
      live.push(() => { const c = cur(); if (!c || !c.view) return; if (document.activeElement !== root) rootCtl.set(c.view.root, true); if (document.activeElement !== fine) fineCtl.set(Math.round(c.region.fine / 2.56), true); renderDetect(); });
      const tuning = group('Tuning',
        el('label.lab', { 'data-tip': tip('Root key', 'The key on which this sound plays at its own pitch. Every other key moves it up or down from there.') }, el('span', null, 'Root key'), root),
        el('label.lab', { 'data-tip': tip('Fine tune', 'Nudge the pitch of this zone in cents. 100 cents is one semitone.') }, el('span', null, 'Fine tune'), fine),
        el('div.hbox', null, detectBtn), detect);

      /* level, pan, ring out */
      const panKnob = el('span.knob.bi', { 'aria-label': 'Pan' }), followSw = el('button.switch', { 'aria-label': 'Follow the part’s pan' });
      const panCtl = K.knob(panKnob, { min: 0, max: 127, step: 1, value: 64, def: 64, label: 'Pan', onInput: (v) => { const c = cur(); if (c) run(() => D.setZone(c.n, c.z, { pan: v })); } });
      const followT = K.toggle(followSw, { onChange: (on) => { const c = cur(); if (c) run(() => D.setZone(c.n, c.z, { pan: on ? null : 64 })); } });
      live.push(() => { const c = cur(); if (!c) return; const follow = c.region.pan === null || c.region.pan === undefined; followT.set(follow, true); panCtl.set(follow ? 64 : c.region.pan, true); panKnob.setAttribute('aria-disabled', follow ? 'true' : 'false'); });
      const level = group('Level',
        slideRow('Level', tip('Level', 'Make this zone louder or quieter than the rest of the instrument.'), { min: -64, max: 63, def: 0, get: () => cur().region.level || 0, set: (v) => D.setZone(sel.n, sel.z, { level: v }), format: (v) => `${Math.round((64 + v) / 64 * 100)}%` }),
        el('label.lab', { 'data-tip': tip('Pan', 'Where this zone sits between left and right. Switch on to let the part decide.', 'Fightcade plays in mono, so pan only matters on a board set to stereo.') }, el('span', null, 'Pan'), el('span.hbox', null, el('span.dim', null, 'follow the part'), followSw, panKnob)),
        switchRow('Ring out', tip('Ring out', 'Let the sound play on after the part’s last note. Otherwise the end of a track cuts it at once.'), () => !!cur().region.ringOut, (on) => D.setZone(sel.n, sel.z, { ringOut: on })));

      /* envelope */
      const preset = (name, label2, text) => btn(label2, tip(label2, text), () => { const c = cur(); if (!c) return; if (name === 'loop') { run(() => { D.applyPreset(c.n, c.z, 'plain'); const m = D.findLoop(c.n, c.z, 'cycle'); K.toast(`A one-cycle loop (${seconds(m.seconds)}) was found, and the sound is tuned to it.`, { kind: 'good' }); }); } else run(() => D.applyPreset(c.n, c.z, name)); }, { cls: 'ghost' });
      const presets = el('div.seg', null, preset('pluck', 'Pluck', 'Fast decay, a short fade: a struck or plucked sound.'), preset('pad', 'Pad', 'Slow attack and a long release: a swelling sound.'), preset('loop', 'Loop', 'A plain envelope and a one-cycle loop, a steady tone found for you.'));
      const curveCv = el('canvas', { 'aria-label': 'Envelope' }), cut = el('div.dz-cut', { hidden: true }, K.icon('warn'), el('span'));
      const curve = el('div.dz-curve', { 'data-tip': tip('Envelope as the game plays it', 'The level of one note, measured from the game’s own sound code each time you move a slider.', 'The note is held for a second, then let go.') }, curveCv);
      const eg = (key, name, tipText, o) => slideRow(name, tipText, Object.assign({ min: 0, max: 63, def: 63 - ENV.plain[key], get: () => 63 - (cur().region[key] || 0), set: (v) => D.setZone(sel.n, sel.z, { [key]: 63 - v }) }, o));
      const sliders = el('div.vbox', null,
        eg('attack', 'Attack', tip('Attack', 'How long the sound takes to reach full level after a note starts. At the far left it is instant.'), { def: 0, format: (v) => seconds(D.attackSeconds(63 - v)) }),
        eg('decay', 'Decay', tip('Decay', 'How long it then takes to fall to the sustain level. At the far left it falls at once.'), { def: 0, format: (v) => seconds(D.decaySeconds(63 - v, cur() ? cur().region.sustain : 127)) }),
        slideRow('Sustain level', tip('Sustain level', 'The level a held note settles at, as a share of full level.'), { min: 0, max: 127, def: 127, get: () => cur().region.sustain, set: (v) => D.setZone(sel.n, sel.z, { sustain: v }), format: (v) => `${Math.round((v + 1) / 128 * 100)}%` }),
        eg('sustainRate', 'Sustain fade', tip('Sustain fade', 'How fast a held note keeps dying away. At the far right it holds for good.'), { def: 62, format: (v) => { const t = D.fallSeconds(63 - v); return t >= 60 ? 'holds' : `fades in ${seconds(t)}`; } }),
        eg('release', 'Release', tip('Release', 'How long the sound takes to die away after the note ends.', 'A looped sound stops within one loop after the note ends, whatever this says.'), { def: 0, format: (v) => seconds(D.fallSeconds(63 - v)) }));
      const envelope = el('section.group', { 'data-dz': 'envelope' }, el('h3', null, 'Envelope', presets), curve, cut, sliders);

      const curveDraw = canvasOf(curveCv, (c, w, h) => {
        const css = K.css; c.fillStyle = css('--bg-0'); c.fillRect(0, 0, w, h);
        c.font = css('--cv-mono-sm'); c.textBaseline = 'alphabetic';
        const PADL = 6, PADR = 6, T = 14, B = 16, ww = w - PADL - PADR, hh = h - T - B, total = 240 / FRAME;
        for (let s = 0; s <= total; s += 0.5) { const x = Math.round(PADL + s / total * ww); c.fillStyle = css(s % 1 === 0 ? '--line-2' : '--cv-grid-faint'); c.fillRect(x, T, 1, hh); if (s % 1 === 0) { c.fillStyle = css('--ink-3'); c.fillText(`${s} s`, x + 3, h - 4); } }
        c.fillStyle = css('--line-2'); c.fillRect(PADL, T + hh, ww, 1);
        const m = meas; if (!m) return;
        const X = (f) => PADL + f / (m.frames - 1) * ww * ((m.frames - 1) / FRAME) / total, Y = (v) => T + hh - v / m.peak * hh;
        const lastAudible = m.stop === null ? m.frames - 1 : m.stop;
        c.beginPath(); c.moveTo(X(0), Y(0)); for (let f = 0; f <= lastAudible; f++) c.lineTo(X(f), Y(m.levels[f])); c.lineTo(X(lastAudible), Y(0)); c.closePath(); c.fillStyle = css('--accent-soft'); c.fill();
        c.beginPath(); for (let f = 0; f <= lastAudible; f++) { if (f === 0) c.moveTo(X(f), Y(m.levels[f])); else c.lineTo(X(f), Y(m.levels[f])); } c.strokeStyle = css('--accent'); c.lineWidth = 1.5; c.stroke();
        if (m.stop !== null && m.stop < m.frames - 1) { c.beginPath(); c.setLineDash([3, 3]); for (let f = m.stop; f < m.frames; f++) { if (f === m.stop) c.moveTo(X(f), Y(m.levels[f])); else c.lineTo(X(f), Y(m.levels[f])); } c.strokeStyle = css('--ink-3'); c.lineWidth = 1; c.stroke(); c.setLineDash([]); }
        c.setLineDash([2, 3]); c.fillStyle = css('--ink-3'); c.strokeStyle = css('--ink-3'); c.lineWidth = 1; c.beginPath(); const xo = Math.round(X(m.off)) + 0.5; c.moveTo(xo, T); c.lineTo(xo, T + hh); c.stroke(); c.setLineDash([]);
        c.fillText('key up', Math.min(xo + 4, w - 40), T - 3);
        if (m.cut) { const xc = Math.round(X(m.stop)) + 0.5; c.strokeStyle = css('--warn'); c.fillStyle = css('--warn'); c.beginPath(); c.moveTo(xc, T); c.lineTo(xc, T + hh); c.stroke(); c.fillText('sound ends', Math.min(xc + 4, w - 58), T + 10); }
      });
      live.push(() => curveDraw.invalidate());

      /* under the hood */
      const hood = el('div.dz-hood', { hidden: !hoodOpen }), hoodBtn = btn('Under the hood', tip('Under the hood', 'The exact bytes this zone becomes, for people who build ROMs.'), () => { hoodOpen = !hoodOpen; K.pref.set('designer.hood', hoodOpen); renderHood(); }, { cls: 'ghost dz-hoodbtn', icon: 'chip' });
      const row = (a, b) => el('div', null, el('span', null, a), el('span.num', null, b));
      const hex = (v, n) => (v >>> 0).toString(16).toUpperCase().padStart(n, '0');
      function renderHood() {
        hood.hidden = !hoodOpen; if (!hoodOpen) return;
        const c = cur(); if (!c) return;
        let kids = [];
        try {
          const blob = Bk().buildBlob(c.bank, caveOf().bank), at = (blob.bytes[2 * c.n] << 8) | blob.bytes[2 * c.n + 1], zb = Array.from(blob.bytes.slice(at + 12 * c.z, at + 12 * c.z + 12)).map((x) => hex(x, 2)).join(' ');
          const v = c.region.sample.view !== undefined ? blob.views.find((x) => x.id === c.region.sample.view) : null;
          kids = [row('Instrument number', `${c.n} (bank ${slotOf(c.bank)})`), row('Zone bytes (12)', zb), row('Cut entry', v ? `sample ${v.index}, at ${hex(v.address, 8)}` : `the game’s own sample ${c.region.sample.rom}`), row('Instrument data', `${blob.bytes.length} B at ${hex(blob.base, 8)} in the preview`), row('The one ROM edit', `${hex(blob.pointer.address, 8)} = base of the data`)];
          if (c.view) kids.splice(3, 0, row('Cut (start loop end root)', `${hex(c.view.start, 6)} ${hex(c.view.loop === null || c.view.loop === undefined ? c.view.end : c.view.loop, 6)} ${hex(c.view.end, 6)} ${c.view.root}`));
        } catch (e) { kids = [row('Not available', e.message)]; }
        hood.replaceChildren(...kids);
      }
      live.push(renderHood);
      const under = el('section.group', null, hoodBtn, hood);
      return [zone, sound, tuning, level, envelope, under];
    }

    /* measuring the envelope in the driver: only when something that changes it changed */
    let measTimer = 0;
    function measureSoon() {
      const c = cur(); if (!c || !c.view) return;
      const key = JSON.stringify([c.region, c.view]);
      if (key === measKey) return;
      measKey = key; clearTimeout(measTimer);
      measTimer = after(50, () => { const q = cur(); if (!q) return; try { meas = probe(q.bank, q.n, q.z); } catch (e) { meas = null; } renderMeas(); });
    }
    function renderMeas() {
      for (const c of canvases) c.invalidate();
      const cutBox = insp.querySelector('.dz-cut');
      if (!cutBox) return;
      const m = meas;
      if (m && m.cut) { cutBox.hidden = false; cutBox.lastChild.textContent = m.cut === 'loop' ? 'A looped sound stops within one loop after the note ends — this machine has no release for short loops.' : 'This sound plays once, so it ends where the recording does, whatever the envelope says.'; }
      else cutBox.hidden = true;
    }

    /* project changes: rebuild what changed in structure, update the rest in place */
    function refresh(force) {
      if (dead) return;
      fixSel(); renderTop(); renderList();
      const c = cur();
      if (force || (c ? editorSig(c) : '') !== edSig) { if (force) measKey = ''; renderEditor(); } else syncEditor();
      if (force) renderMeas();
    }
    offs.push(ctx.on('project', () => { refresh(false); renderMeas(); }));
    if (/(^|[#&])demo=1/.test(g.location.hash) && !P().bank && !demoSeeded) { demoSeeded = true; run(() => D.demo()); }
    fixSel();
    host.append(top, body); root.append(host);
    renderTop(); renderList(); renderEditor(); renderMeas();
    mounts.push({ refresh, openNew: () => startNew(true), openImport: () => run(importFile), dispose() { dead = true; timers.forEach(clearTimeout); timers.clear(); offs.forEach((f) => f()); offs.length = 0; clearLive(); host.remove(); } });
  }
  let demoSeeded = false;

  /* a few instruments for pictures and tours (#view=designer&demo=1): not the game's, not a recording */
  D.demo = function () {
    const rowFor = (b, p, z) => { const prog = S.data.banks[b][p]; return prog && prog.live[Math.min(z || 0, prog.live.length - 1)]; };
    const bell = rowFor(0, 60), pad = rowFor(0, 57), loops = rowFor(0, 7);
    const glass = D.create({ name: 'Glass pluck', sample: bell.sample, preset: 'pluck' });
    const night = D.create({ name: 'Night pad', sample: pad.sample, preset: 'pad' });
    D.addZone(night.n, 0);
    D.setSource(night.n, 0, rowFor(0, 46).sample);
    const source = D.create({ name: 'Break source', sample: loops.sample, preset: 'plain' });
    D.slice(source.n, 0, { count: 8, firstKey: 41, natural: -20, name: 'Chopped break' });
    D.remove(source.n);
    const lead = proj().parts.find((p) => p.role === 'lead') || proj().parts[0];
    if (lead) D.usePart(lead.id, glass.n);
    sel = { n: glass.n, z: 0 };
  };

  const view = { id: 'designer', title: 'Instrument Designer', icon: 'sounds', mount, unmount() { const m = mounts.pop(); if (m) m.dispose(); } };
  S.view(view);
  const there = () => mounts.length > 0, front = () => mounts[mounts.length - 1];
  K.action({ id: 'designer.new', title: 'New custom instrument', hint: 'Make an instrument from one of the game’s own sounds.', icon: 'plus', group: 'Sounds', enabled: there, run: () => front().openNew() });
  K.action({ id: 'designer.import', title: 'Import custom instruments', hint: 'Add instruments from a .sf3bank.json file.', icon: 'import', group: 'Sounds', enabled: there, run: () => front().openImport() });
  K.action({ id: 'designer.export', title: 'Export custom instruments', hint: 'Save every custom instrument of this song as a .sf3bank.json file.', icon: 'export', group: 'Sounds', enabled: () => there() && listOf(proj().bank).length > 0, run: () => run(() => { const data = D.exportData(); K.download(`${proj().name || 'Instruments'}.sf3bank.json`, JSON.stringify(data, null, 2), 'application/json'); }) });
  D.pickSource = pickSource;

  /* ---- self-test (studio.html#selftest): group "designer" ------------------------------------------------------------ */
  const T = (name, fn) => S.test('designer', name, fn), a = S.assert;
  const fixture = () => { S.state.newProject(S.demo()); sel = { n: null, z: 0 }; };
  const sampleOf = (b, p, z) => { const prog = S.data.banks[b][p]; return prog.live[z || 0].sample; };
  const BASS = () => sampleOf(0, 20, 0), BREAK = () => sampleOf(0, 7, 0);
  const regs32 = (e, hi, lo) => (((e.regs[hi] << 16) | e.regs[lo]) - 0x400000) >>> 0;
  const harness = () => { const wrap = document.createElement('div'); document.body.append(wrap); const ctx = { state: S.state, transport: S.transport, data: S.data, catalog: S.state.catalog, pack: S.pack, edit: S.edit, on: S.on, studio: S }; view.mount(wrap, ctx); return { wrap, done() { view.unmount(); wrap.remove(); } }; };

  T('the picker lists all of the game\'s sounds once, grouped', () => {
    const src = D.sources(), n = S.data.samples.filter(Boolean).length;
    a(n === 733 && src.byIndex.size === 733 && src.rows.filter((r) => r.kind === 'row').length === 733, 'every one of the 733 sounds appears exactly once');
    a(src.rows.some((r) => r.group === 'music' && r.kind === 'head') && src.rows.some((r) => r.group === 'fx'), 'music instruments and effects are grouped');
  });
  T('an instrument is made from a ROM sample, is undoable and costs what SF3Bank.size says', () => {
    fixture(); const before = JSON.stringify(S.state.project), s = S.data.samples[BASS()];
    const made = D.create({ name: 'Test bass', sample: BASS(), preset: 'plain' }), B = S.state.project.bank, v = B.views[0];
    a(made.n === 0 && B.programs[0].name === 'Test bass' && B.programs[0].regions.length === 1 && B.programs[0].regions[0].keyHigh === 127, 'one instrument with one zone over all keys');
    a(v.start === s.start && v.end === s.end && v.root === s.root && v.source === BASS() && (v.loop === (s.looped ? s.loop : null)), 'its cut starts as the sound\'s own table entry');
    a(S.state.project.names['8:0'] === 'Test bass', 'the name is known to the part chooser');
    a(SF3Bank.size(B) === SF3Bank.buildBlob(B, SF3Engine.CAVE.bank).bytes.length && D.space().custom === SF3Bank.size(B), 'the size is the blob\'s length');
    S.state.undo(); a(JSON.stringify(S.state.project) === before, 'undo restores the exact project');
  });
  T('the cut and the envelope reach the chip: a note plays the view and the envelope\'s shape', async () => {
    fixture(); const s = S.data.samples[BASS()], made = D.create({ name: 'Reg', sample: BASS(), preset: 'plain' }), n = made.n;
    const start = s.start + Math.min(100, Math.floor((s.loop - s.start) / 2)), loop = s.loop + 40, end = s.end - 30;
    D.setView(n, 0, { start, loop, end });
    D.setZone(n, 0, { attack: 50, decay: 40, sustain: 90, sustainRate: 4, release: 30 });
    // The reference envelope below uses two ticks per frame; use that exact tempo here too.
    S.edit('Test part', (p) => { p.bpm = SF3Seq.tempoToBpm(512); p.loop = { on: false }; p.parts = SF3Compile.normalize({ format: 'sf3project', version: 2, parts: [{ id: 'dz', name: 'Test', role: 'lead', bank: 8, program: n, volume: 100, expression: 110, pan: 64, voices: 1, notes: [{ t: 0, n: s.root, v: 100, len: 120 }] }] }).parts; });
    await S.transport.play({ silent: true, tick: 0 });
    const e = S.transport.engine, vols = [], keys = [];
    for (let f = 0; f < 200; f++) { S.transport.advance(1); vols.push(e.regs[15]); keys.push(e.key & 1); }
    const on = keys.findIndex((k) => k === 1);
    a(on >= 0, 'the voice keys on');
    a(regs32(e, 3, 2) === start && regs32(e, 9, 7) === loop && regs32(e, 11, 10) === end, `the chip has the view's start, loop and end (${regs32(e, 3, 2)} ${regs32(e, 9, 7)} ${regs32(e, 11, 10)} for ${start} ${loop} ${end})`);
    const peak = Math.max(...vols), peakAt = vols.indexOf(peak) - on;
    a(peakAt >= 3 && peakAt <= 12 && vols[on + 1] < peak * 0.7, `attack 50 rises over several frames, not at once (peak after ${peakAt} frames)`);
    a(Math.abs(vols[on + 40] / peak - 91 / 128) < 0.04, `decay settles at the sustain level (${(vols[on + 40] / peak).toFixed(3)} for ${(91 / 128).toFixed(3)})`);
    const offAt = on + 60 + 8, steps = [0, 1, 2, 3].map((k) => vols[offAt + k] - vols[offAt + k + 1]);
    a(steps.every((x) => x > 0 && Math.abs(x - steps[0]) <= 1), `after the note the level falls in a straight line (${steps.join(' ')})`);
    const m = D.measure(n, 0), at = m.levels.findIndex((x) => x > 0);
    a(m.levels.length === 240 && [5, 10, 20, 40].every((k) => Math.abs(m.levels[at + k] / m.peak - vols[on + k] / peak) < 0.03), 'the curve the screen draws is the curve the chip plays');
    S.transport.stop();
  });
  T('envelope sliders speak in seconds, from the driver\'s tables', () => {
    a(Math.abs(D.attackSeconds(40) - 0.418) < 0.005 && D.attackSeconds(63) < 0.03 && Math.abs(D.fallSeconds(32) - 2.879) < 0.01 && D.fallSeconds(0) > 60, 'attack 40 = 0.42 s, rate 63 is instant, release 32 = 2.9 s, rate 0 holds');
    a(Math.abs(D.decaySeconds(40, 63) - D.fallSeconds(40) / 2) < 0.02, 'decay is the fall from the peak to the sustain level');
  });
  T('the Wave Miner loops whole cycles; Detect pitch sets root and fine; both are one undo', () => {
    fixture(); const n = D.create({ sample: BASS(), preset: 'plain' }).n, before = JSON.stringify(S.state.project);
    const info = D.findLoop(n, 0, 'cycle'), v = S.state.project.bank.views[0], sm = SF3Engine.preparePack(S.pack).samples, z = S.state.project.bank.programs[n].regions[0];
    a(info.periods === 1 && v.loop < v.end && sm[v.loop - 1] < 0 && sm[v.loop] >= 0 && sm[v.end - 1] < 0 && sm[v.end] >= 0 && Math.abs(info.cents) <= 3, 'one cycle, rising zero crossing to rising zero crossing, within 3 cents');
    const repeated = Int8Array.from({ length: 6000 }, (_, i) => sm[v.loop + i % (v.end - v.loop)]);
    a(SF3Bank.rootFor(SF3Bank.pitch(repeated, 0, repeated.length).hz).root === v.root, 'the root key matches the pitch of the loop repeated as the chip plays it');
    S.state.undo(); a(JSON.stringify(S.state.project) === before, 'one undo');
    const d = D.detectPitch(n, 0), v2 = S.state.project.bank.views[0], rf = SF3Bank.rootFor(SF3Bank.pitch(sm, v2.loop !== null && v2.loop < v2.end ? v2.loop : v2.start, v2.end).hz);
    a(d.confidence > 0.5 && v2.root === rf.root && S.state.project.bank.programs[n].regions[0].fine === rf.fine && Math.abs(d.cents) <= 50, `root ${noteName(v2.root)} and fine ${rf.fine} set, measured error ${d.cents.toFixed(1)} cents`); void z;
    a(!!D.findLoop(n, 0, 'long') && S.state.project.bank.views[0].loop < S.state.project.bank.views[0].end, 'a long loop is found too');
  });
  T('Slice into a kit makes one zone per piece, in key order, at Capcom\'s speed', () => {
    fixture(); const n = D.create({ sample: BREAK(), preset: 'plain' }).n, out = D.slice(n, 0, { count: 8, firstKey: 41, natural: -20 }), B = S.state.project.bank, kit = B.programs[out.n];
    a(out.count === 8 && kit.regions.length === 8 && kit.regions.every((r, i) => r.keyHigh === 41 + i), 'eight zones on keys 41 to 48');
    const views = kit.regions.map((r) => B.views.find((v) => v.id === r.sample.view));
    a(views.every((v, i) => v.root === 41 + i + 20 && (i === 0 || v.start === views[i - 1].end)), 'contiguous pieces, root = key + 20');
    a(JSON.stringify(Object.keys(B.programs)) === JSON.stringify([String(n), String(out.n)]) && isKit(kit), 'a new instrument, recognised as a kit');
    const hits = D.slice(n, 0, { atHits: true, firstKey: 36, natural: 0 }); a(hits.count >= 2, 'slicing at the hits works on a drum loop');
  });
  T('zones: split, move, remove keep the keys in order and are undoable', () => {
    fixture(); const n = D.create({ sample: BASS(), preset: 'plain' }).n, B = () => S.state.project.bank.programs[n].regions;
    D.addZone(n, 0); a(B().length === 2 && B()[0].keyHigh === 64 && B()[1].keyHigh === 127 && S.state.project.bank.views.length === 2, 'split at the middle: two zones, each with its own cut');
    D.moveSplit(n, 0, 200); a(B()[0].keyHigh === 126, 'a split cannot cross the next zone');
    D.moveSplit(n, 0, 50); a(B()[0].keyHigh === 50, 'a split moves');
    D.addZone(n, 0, 20); a(B().length === 3 && B()[0].keyHigh === 19 && B()[1].keyHigh === 50 && B().every((r, i, l) => i === 0 || r.keyHigh > l[i - 1].keyHigh), 'a double-click splits where it was clicked');
    const full = JSON.stringify(S.state.project);
    D.removeZone(n, 0); a(B().length === 2 && B()[0].keyHigh === 50, 'removing a zone gives its keys to the one above');
    S.state.undo(); a(JSON.stringify(S.state.project) === full, 'removing a zone is one undo');
    D.removeZone(n, 0); D.removeZone(n, 0); a(B().length === 1 && B()[0].keyHigh === 127 && S.state.project.bank.views.length === 1, 'down to one zone covering every key, with one cut');
    let refused = false; try { D.removeZone(n, 0); } catch (e) { refused = /at least one zone/.test(e.message); } a(refused, 'the last zone cannot be removed');
  });
  T('edits the builder would refuse are refused and leave the project as it was', () => {
    fixture(); const n = D.create({ sample: BASS(), preset: 'plain' }).n, before = JSON.stringify(S.state.project), bad = [];
    for (const [name, f] of [['a cut past the sound data', () => D.setView(n, 0, { end: SF3Bank.SAMPLE_BYTES + 5 })], ['a cut that ends before it starts', () => D.setView(n, 0, { start: 100, end: 90 })], ['a rate of 64', () => D.setZone(n, 0, { attack: 64 })], ['a sustain of 128', () => D.setZone(n, 0, { sustain: 128 })], ['a missing instrument', () => D.rename(99, 'x')], ['a root of 200', () => D.setView(n, 0, { root: 200 })]]) { try { f(); } catch (e) { continue; } bad.push(name); }
    a(!bad.length && JSON.stringify(S.state.project) === before, `refused: ${bad.length ? 'NOT ' + bad.join(', ') : 'all six'}`);
  });
  T('a song carries 128 custom instruments at most', () => {
    fixture(); const n = D.create({ sample: BASS(), preset: 'plain' }).n;
    for (let i = 1; i < 128; i++) D.duplicate(n);
    a(listOf(S.state.project.bank).length === 128 && SF3Bank.size(S.state.project.bank) === SF3Bank.buildBlob(S.state.project.bank, SF3Engine.CAVE.bank).bytes.length, '128 instruments are accepted');
    let msg = ''; try { D.duplicate(n); } catch (e) { msg = e.message; } a(/128/.test(msg), 'the 129th is refused in plain words');
  });
  T('rename, duplicate and delete keep the part chooser\'s names in step', () => {
    fixture(); const n = D.create({ name: 'First', sample: BASS(), preset: 'plain' }).n;
    D.rename(n, 'Renamed'); a(S.state.project.names['8:' + n] === 'Renamed' && SF3Catalog.nameOf(S.state.catalog, 8, n, S.state.project.names) === 'Renamed', 'the name is shared');
    const d = D.duplicate(n).n; a(S.state.project.bank.programs[d].name === 'Renamed copy' && S.state.project.bank.views.length === 2, 'a copy has its own cut');
    D.remove(n); D.remove(d); a(S.state.project.bank === null && !Object.keys(S.state.project.names).some((k) => k.startsWith('8:')), 'deleting the last instrument leaves no custom instruments and no stray names');
  });
  T('export and import round-trip an instrument and renumber on a clash', () => {
    fixture(); const n = D.create({ name: 'Moving', sample: BASS(), preset: 'pluck' }).n; D.addZone(n, 0);
    const file = JSON.parse(JSON.stringify(D.exportData([n]))), size = SF3Bank.size(S.state.project.bank);
    a(file.format === 'sf3bank' && Object.keys(file.programs).length === 1 && file.views.length === 2, 'one instrument and the cuts it uses');
    const made = D.importData(file), B = S.state.project.bank;
    a(made.numbers.length === 1 && made.numbers[0] !== n && B.programs[made.numbers[0]].name === 'Moving' && B.views.length === 4, 'the copy took a free number and its own cuts');
    a(JSON.stringify(B.programs[made.numbers[0]].regions.map((r) => [r.keyHigh, r.attack, r.decay, r.sustain, r.sustainRate, r.release])) === JSON.stringify(B.programs[n].regions.map((r) => [r.keyHigh, r.attack, r.decay, r.sustain, r.sustainRate, r.release])), 'zones and envelopes are the same');
    a(SF3Bank.size(B) > size, 'the size grew'); S.state.undo();
    fixture(); const into = D.importData(file); a(into.numbers[0] === n, 'into an empty song it keeps its number');
    let refused = ''; try { D.importData({ format: 'sf3bank', programs: {} }); } catch (e) { refused = e.message; } a(/no custom instruments/.test(refused), 'a file with nothing in it is refused');
  });
  T('the screen always states what custom instruments are, and the ROM space line is live', () => {
    fixture(); const h = harness();
    try {
      const q = (id) => h.wrap.querySelector(`[data-dz="${id}"]`), notice = q('notice').textContent;
      a(notice.includes('Custom instruments are optional.') && notice.includes('new recordings cannot be added to this ROM') && notice.includes('one extra change besides the song') && notice.includes('need nothing extra'), 'the statement is on screen in its own words');
      a(q('uses').textContent.includes('This song uses only the game\'s own instruments.') && /Custom instruments: none/.test(q('space').textContent), 'with nothing made, the line says the song needs nothing');
      const n = D.create({ sample: BASS(), preset: 'plain' }).n;
      const sp = D.space();
      a(q('space').textContent.includes(`Custom instruments: ${kb(SF3Bank.size(S.state.project.bank))}`) && q('space').textContent.includes(`this song: ${kb(S.state.build().bytes.length)}`) && q('space').textContent.includes(`${kb(sp.total)} in total, shared by all songs`), 'the figures come from SF3Bank.size and the build');
      a(q('uses').textContent.includes('only the game\'s own instruments') && /still travel/.test(q('uses').textContent), 'an unused instrument is said to travel with the song');
      S.edit('Use it', (p) => { p.parts[0].bank = 8; p.parts[0].program = n; });
      a(/This song uses 1 custom instrument/.test(q('uses').textContent) && /instrument table change/.test(q('uses').textContent), 'a used instrument is named with what the ROM needs');
      S.musicSpace = { total: 188384, free: 150000 }; D.select(n, 0);
      a(q('space').textContent.includes(`${kb(150000)} free of ${kb(188384)}`), 'a loaded ROM shows the real free figure'); S.musicSpace = null;
    } finally { h.done(); S.musicSpace = null; }
  });
  T('a song that uses a custom instrument builds, exports with needs, and says what a ROM needs', () => {
    fixture(); const n = D.create({ name: 'Needs', sample: BASS(), preset: 'pad' }).n;
    S.edit('Use it', (p) => { p.parts[0].bank = 8; p.parts[0].program = n; });
    const b = S.state.build(), file = SF3Compile.songFile(S.state.project), need = D.needs();
    a(b.bank && b.bank.bytes.length === SF3Bank.size(S.state.project.bank), 'the build carries the instrument data');
    a(file.needs.includes('instruments') && file.bank && Object.keys(file.bank.programs).length === 1, 'the song file asks for the instruments');
    a(need.instruments && need.used === 1 && need.lines[0].startsWith('Custom instruments (') && need.lines[0].endsWith('and the instrument table change'), 'D.needs words it for Deliver');
    fixture(); a(!D.needs().instruments && D.needs().lines[0].startsWith('Uses only the game'), 'a song with none says so');
  });
  T('the parts that play an instrument are listed with it, and a deleted one goes silent in the list', () => {
    fixture(); const n = D.create({ sample: BASS(), preset: 'plain' }).n;
    S.edit('Use it', (p) => { p.parts[1].bank = 8; p.parts[1].program = n; });
    const u = usage(S.state.project); a(JSON.stringify(u.get(n)) === JSON.stringify([S.state.project.parts[1].name]), 'where used');
    const h = harness();
    try { a(h.wrap.querySelector('.dz-row').textContent.includes(S.state.project.parts[1].name) && h.wrap.querySelector('.dz-row .tag').textContent === `${ownBytes(S.state.project.bank, n)} B`, 'the row shows the part and its own bytes'); } finally { h.done(); }
  });
  T('the Designer mounts, shows the editor and the envelope, and unmounts cleanly', async () => {
    fixture(); D.create({ sample: BASS(), preset: 'pluck' }); const h = harness();
    try {
      await new Promise((r) => setTimeout(r, 120));
      a(h.wrap.querySelector('[data-dz="zones"] canvas') && h.wrap.querySelector('[data-dz="sound"] canvas') && h.wrap.querySelector('[data-dz="envelope"] canvas'), 'strip, waveform and envelope curve exist');
      const sliders = h.wrap.querySelectorAll('[data-dz="envelope"] input[type=range]'); a(sliders.length === 5, 'five envelope sliders');
      a(Array.from(h.wrap.querySelectorAll('[data-dz="envelope"] .dz-out')).every((x) => x.textContent.length > 0), 'each slider says its time or level');
      a(!!h.wrap.querySelector('.dz-head input').value, 'the name field holds the instrument\'s name');
      for (const x of h.wrap.querySelectorAll('button, canvas, label.lab, input.field')) a(x.getAttribute('data-tip') || x.closest('[data-tip]') || x.getAttribute('aria-label') || x.textContent.trim(), 'every control has a tooltip or a name');
    } finally { h.done(); }
    a(!document.querySelector('.designer'), 'unmounting removes the screen');
  });
})(window);
