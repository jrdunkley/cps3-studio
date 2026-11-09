/* Sounds: the instrument browser and Capcom's drum breaks (package B6). Three columns: categories and search, instrument
 * cards, and the chosen sound's detail. Everything shown comes from the catalog (js/catalog.js); every change to the song goes
 * through ctx.edit, so it is one undo step. Sound is made only by the transport's audition (studio/transport.js): a note
 * is one audition, a bar of Capcom's break is a short run of timed auditions at the song's tempo.
 *
 *   Studio.sounds.entries()                  every instrument { key 'bank:program', p (catalog entry), music }
 *   Studio.sounds.select(key, { hear })      choose an instrument (the view must be open to show it)
 *   Studio.sounds.auditionPart(bank, program)  the part the transport plays when the sound is auditioned
 *   Studio.sounds.use(key, partId)           give a part this instrument            Studio.sounds.newPart(key)
 *   Studio.sounds.rename(key, text)          the user's own name (project and preferences)
 *   Studio.sounds.barsOf(kit)                Capcom's bars for a break kit          Studio.sounds.insertBar(kit, index)
 *   Studio.sounds.generate('fill' | 'roll' | 'stop' | 'toms', kit)   plain notes at the playhead's bar
 */
(function (g) {
  'use strict';
  const S = g.Studio, K = g.Kit, el = K.el, copy = x => JSON.parse(JSON.stringify(x));
  const BAR = 192, BEAT = 48, SURE = 0.8, OCTAVE_MIN = 24, OCTAVE_MAX = 96;
  const Z = S.sounds = {};
  let V = null;                                                     /* the mounted view, or null */
  const memory = { key: null, sig: null };                          /* what was last shown, so coming back finds it again */

  /* ---- small helpers ------------------------------------------------------------------------------------ */
  const edit = (...args) => (V ? V.ctx.edit : S.edit)(...args);
  const catalog = () => S.state.catalog, project = () => S.state.project, programOf = key => catalog().programs[key];
  const name12 = n => K.fmt.note(n);
  const plural = (n, word) => `${K.fmt.int(n)} ${word}${n === 1 ? '' : 's'}`;
  const secs = x => (x < 10 ? x.toFixed(2) : x.toFixed(1)) + ' s';
  const baseName = n => String(n).replace(/\s*\(second arrangement\)\s*$/i, '');
  const pieceName = code => { const s = S.data && S.data.songs.find(x => x.code === code); return (s && s.name) || `Music ${code}`; };
  const num = x => el('b.num', null, x);
  const joinWords = list => list.length < 2 ? list.join('') : list.slice(0, -1).join(', ') + ' and ' + list[list.length - 1];
  const FAMILY_ROLE = { 'Drums': 'drums', 'Bass': 'bass', 'Keys & plucks': 'chords', 'Pads & strings': 'pad', 'Leads': 'lead', 'Hits & chops': 'arp', 'Effects & voices': 'fx' };
  const LENGTHS = [{ value: 24, label: '1/8', tip: 'Length 1/8|Hold each note for an eighth of a bar.' }, { value: 48, label: '1/4', tip: 'Length 1/4|Hold each note for a beat.' },
    { value: 96, label: '1/2', tip: 'Length 1/2|Hold each note for two beats.' }, { value: 192, label: '1 bar', tip: 'Length 1 bar|Hold each note for a whole bar.' }];
  const TYPING = { a: 0, w: 1, s: 2, e: 3, d: 4, f: 5, t: 6, g: 7, y: 8, h: 9, u: 10, j: 11, k: 12 };
  const WHITE = [0, 2, 4, 5, 7, 9, 11], isWhite = n => WHITE.includes(((n % 12) + 12) % 12);
  const DIGITS = '1234567890';

  /* ---- the list of instruments -------------------------------------------------------------------------- */
  let cache = null;
  function entries() {
    const c = catalog(); if (!c) return [];
    if (cache && cache.catalog === c) return cache.list;
    const list = Object.keys(c.programs).map(key => {
      const p = c.programs[key], pieces = [...new Set(p.usage.pieces.map(code => baseName(pieceName(code))))];
      return { key, p, music: p.bank === 0, pieces, fixed: [p.name, p.description, ...(p.aliases || []), p.family, p.role, 'bank ' + p.bank, 'program ' + p.program, p.bank ? 'effect' : '', ...pieces].join(' ').toLowerCase() };
    });
    list.sort((x, y) => x.p.bank - y.p.bank || x.p.program - y.p.program);
    cache = { catalog: c, list, map: new Map(list.map(e => [e.key, e])) };
    return list;
  }
  const entry = key => { entries(); return cache && cache.map.get(key); };
  Z.entries = entries;

  /* the user's own names: the song first, then the ones kept in preferences, then ours */
  const prefNames = () => { const v = K.pref('music.names', {}); return v && typeof v === 'object' ? v : {}; };
  const own = (map, key) => map && typeof map[key] === 'string' && map[key].trim() ? map[key].trim() : '';
  const nameOf = key => { const p = programOf(key); return own(project() && project().names, key) || own(prefNames(), key) || (p ? p.name : key); };
  Z.nameOf = nameOf;
  Z.rename = (key, text) => {
    const p = programOf(key); if (!p) return false;
    text = String(text || '').trim(); const clear = !text || text === p.name, names = prefNames();
    edit('Rename instrument', P => { P.names = P.names || {}; if (clear) delete P.names[key]; else P.names[key] = text; });
    if (clear) delete names[key]; else names[key] = text;
    K.pref.set('music.names', names); if (V) refreshAll();
    return true;
  };
  /* names the user chose before are put into a song that uses those instruments, so every workspace shows them */
  function adoptNames() {
    const prefs = prefNames(), P = project(); if (!P) return;
    const need = {};
    for (const part of P.parts) { const key = part.bank + ':' + part.program; if (own(prefs, key) && !own(P.names, key)) need[key] = prefs[key]; }
    if (Object.keys(need).length) edit('Instrument names', q => { q.names = Object.assign({}, q.names, need); });
  }

  const selectedPart = () => { const P = project(); return P ? P.parts.find(x => x.id === S.state.selection.partId) || P.parts[0] || null : null; };
  function usedMap() {
    const map = new Map(), P = project();
    if (P) for (const part of P.parts) { const key = part.bank + ':' + part.program; if (!map.has(key)) map.set(key, []); map.get(key).push(part); }
    return map;
  }

  /* ---- facts, in plain words ---------------------------------------------------------------------------- */
  /* the tuning badge follows the one rule auto-tune follows: a pitch is trusted from 0.8 up (SF3Compile.AUTO_TUNE_SURE) */
  function tuning(p) {
    const c = p.tuningCents, conf = p.tuningConfidence, sure = (g.SF3Compile && g.SF3Compile.AUTO_TUNE_SURE) || SURE;
    if (p.kit || c === null || c === undefined) return null;
    if (!(conf >= sure)) return { kind: 'unsure', label: 'Tuning unclear', cls: '', tip: 'Tuning unclear|This sound is noisy or has no steady pitch, so its tuning cannot be measured reliably. The Studio leaves it as it is.' };
    const cents = Math.round(c), way = c > 0 ? 'sharp' : 'flat';
    if (Math.abs(c) < 5) return { kind: 'ok', label: 'In tune', cls: 'good', tip: 'In tune|Measured within 5 cents of the key it is played on.' };
    if (project() && project().autoTune) return { kind: 'fixed', label: 'Corrected', cls: 'good', cents, tip: `Corrected|It plays ${Math.abs(cents)} cents ${way}. Keep instruments in tune is on, so the Studio corrects it.|Switch it off in the Song tab of Compose.` };
    return { kind: 'off', label: K.fmt.signed(cents) + ' cents', cls: 'warn', cents, tip: `${K.fmt.signed(cents)} cents|It plays ${Math.abs(cents)} cents ${way} of its key. Turn on Keep instruments in tune to correct it.|Keep instruments in tune is in the Song tab of Compose.` };
  }
  Z.tuning = tuning;
  const lengthWords = ticks => {
    const steps = [[6, 'a 32nd note'], [12, 'a 16th note'], [24, 'an eighth note'], [48, 'a quarter note'], [96, 'a half note'], [192, 'a whole bar']];
    let best = steps[0]; for (const s of steps) if (Math.abs(Math.log(ticks / s[0])) < Math.abs(Math.log(ticks / best[0]))) best = s;
    return best[1];
  };
  const share = (n, total) => total ? n / total : 0;
  const habit = (x, verb) => x >= 0.5 ? `usually ${verb}` : x >= 0.15 ? `sometimes ${verb}` : '';
  function loopFacts(p, sampleIndex) {
    const s = S.data.samples[sampleIndex]; if (!s || !s.looped) return null;
    const rate = SF3Catalog.ROOT_RATE, loop = (s.end - s.loop) / rate, from = (s.loop - s.start) / rate;
    return { loop, from };
  }
  /* the facts as three short paragraphs: how Capcom uses it, where it plays it, what the sound does */
  function facts(en) {
    const p = en.p, u = p.usage, paras = [[], [], []], zone = p.zones[mainZone(p)];
    const say = (i, ...parts) => { if (paras[i].length) paras[i].push(' '); paras[i].push(...parts); };
    if (p.bank !== 0) {
      say(0, 'A sound effect used as an instrument. It lasts ', num(secs(p.tone.seconds || zone.seconds)), p.sustained ? ' and repeats while a note is held.' : ' and plays once.');
      say(0, 'Capcom’s music never plays it; the game uses these for hits, voices and other effects.');
    } else {
      if (!u.pieces.length) say(0, 'Capcom’s music never plays it.');
      else {
        const named = en.pieces.filter(n => !/^Music \d+$/.test(n)), shown = named.slice(0, 3), more = named.length - shown.length;
        say(0, 'Capcom uses it in ', num(K.fmt.int(u.pieces.length)), u.pieces.length === 1 ? ' piece' : ' pieces', shown.length ? ', among them ' + (more > 0 ? `${shown.join(', ')} and ${more} more` : joinWords(shown)) : '', '.');
      }
      if (u.basis) {
        const phrases = [habit(share(u.echoed, u.tracks), 'echoes it'), habit(share(u.doubled, u.tracks), 'doubles it on the other side'), habit(share(u.glided, u.tracks), 'glides into its notes')].filter(Boolean);
        const lead = u.basis === 'other' ? 'Only short pieces and jingles play it, at' : u.basis === 'any' ? 'It is a side sound, at' : 'Its tracks usually sit at';
        say(0, lead + ' volume ', num(u.volume), ' and expression ', num(u.expression), '.');
        if (phrases.length) say(0, 'Capcom ' + joinWords(phrases) + '.');
      }
      if (p.keys) { if (u.pieces.length) say(1, 'Capcom plays ', num(p.keys.filter(k => k.uses > 0).length), ' of its ', num(p.keys.length), ' keys.'); }
      else if (p.range) say(1, 'Capcom plays it from ', num(name12(p.range.low)), ' to ', num(name12(p.range.high)), ', mostly between ', num(name12(p.range.typicalLow)), ' and ', num(name12(p.range.typicalHigh)), '.', u.noteLength ? [' Its notes are usually ', lengthWords(u.noteLength), ' long.'] : '');
    }
    if (!p.kit) {
      const lf = p.sustained ? loopFacts(p, zone.sample) : null;
      if (p.sustained && lf) say(2, 'It keeps sounding while a note is held. Its loop lasts ', num(secs(lf.loop)), lf.loop < 0.5 ? ', so when a note ends the sound stops within that time.' : ', so the end of a note fades out properly.');
      else if (p.sustained) say(2, 'It keeps sounding while a note is held.');
      else if (p.bank === 0) say(2, 'It plays once and fades by itself in about ', num(secs(p.tone.seconds || zone.seconds)), '.');
      const t = tuning(p);
      if (t && t.kind === 'unsure') say(2, 'Its pitch could not be measured reliably, so the Studio leaves it as it is.');
      else if (t && t.kind !== 'ok') say(2, 'It plays ', num(Math.abs(Math.round(p.tuningCents))), ' cents', p.tuningCents > 0 ? ' sharp' : ' flat', t.kind === 'fixed' ? ' of its key. Keep instruments in tune corrects it.' : ' of its key. Keep instruments in tune would correct it.');
    }
    return paras.filter(x => x.length);
  }
  const mainZone = p => { const i = p.zones.findIndex(z => z.sample === p.tone.sample); return i < 0 ? 0 : i; };

  /* ---- sound: the transport's audition ---------------------------------------------------------------- */
  Z.auditionPart = (bank, program) => {
    const key = bank + ':' + program, p = catalog().programs[key], role = p ? p.role : 'lead', preset = SF3Catalog.suggest(role);
    const part = SF3Compile.normalize({ format: 'sf3project', version: 2, parts: [{ id: 'audition', name: 'Audition', role, bank, program, volume: preset.volume, expression: preset.expression, pan: 64, voices: 1, notes: [] }] }).parts[0];
    /* the audition is built with Keep instruments in tune on; when the song has it off, cancel the correction so the sound is the song's */
    if (p && p.tuningCents !== null && p.tuningConfidence >= SURE && project() && !project().autoTune) part.tune = p.tuningCents;
    return part;
  };
  function usualNote(en) {
    const p = en.p;
    if (p.keys) { const best = p.keys.slice().sort((x, y) => y.uses - x.uses)[0]; return best ? best.key : 60; }
    if (p.range) return p.range.median;
    const z = p.zones[mainZone(p)]; return z.root !== null ? z.root : 60;
  }
  Z.usualNote = key => usualNote(entry(key));
  function toastError(e) { K.toast(e && e.message ? e.message : String(e), { kind: 'warn' }); return null; }
  function hear(key, note, o) {
    o = o || {}; const p = programOf(key); if (!p) return Promise.resolve(null);
    const part = Z.auditionPart(p.bank, p.program);
    return Promise.resolve().then(() => S.transport.audition(part, note, o.v || (V && V.velocity) || 100, o.len || (V && V.length) || 96)).catch(toastError);
  }
  Z.hear = hear;
  /* Capcom's bar at the song's tempo: the transport plays one note at a time, so each note is its own audition, started on time */
  function playBar(kit, bar, index) {
    cancelBar(); if (!V) return;
    const bpm = (project() && project().bpm) || bar.bpm || 120, ms = t => t * 60000 / (BEAT * bpm), part = Z.auditionPart(0, kit);
    V.playing = bar; markPlaying();
    bar.notes.forEach(n => V.timers.push(setTimeout(() => Promise.resolve().then(() => S.transport.audition(part, n.n, n.v, n.len)).catch(toastError), ms(n.t))));
    V.timers.push(setTimeout(() => { if (V) { V.playing = null; markPlaying(); } }, ms(BAR) + 250));
  }
  function cancelBar() { if (!V) return; V.timers.forEach(clearTimeout); V.timers = []; V.playing = null; markPlaying(); }
  function markPlaying() { if (V && V.bars) for (const row of V.bars.querySelectorAll('.sn-bar')) row.classList.toggle('on', row._bar === V.playing); }

  /* ---- writing into the song ------------------------------------------------------------------------------ */
  const uid = () => 'p-' + crypto.randomUUID();
  function newPartSpec(key) {
    const p = programOf(key), preset = SF3Catalog.suggest(p.role);
    return SF3Compile.normalize({ format: 'sf3project', version: 2, parts: [{ id: uid(), name: nameOf(key), role: p.role, bank: p.bank, program: p.program, volume: preset.volume, expression: preset.expression, pan: preset.pan, voices: 1, notes: [] }] }).parts[0];
  }
  Z.use = (key, partId) => {
    const p = programOf(key), part = project().parts.find(x => x.id === partId) || selectedPart(); if (!p || !part) return false;
    edit('Use instrument', P => { const q = P.parts.find(x => x.id === part.id); q.bank = p.bank; q.program = p.program; });
    { const q = S.state.project.parts.find(x => x.id === part.id), n = q && S.automation && S.automation.note(q, 'program'); if (n && n.lane) K.toast(n.text + ' Show it from the part’s inspector.', { kind: n.level === 'ignored' ? 'bad' : undefined }); }
    S.state.select({ partId: part.id }); return part.id;
  };
  Z.newPart = key => {
    const spec = newPartSpec(key); edit('Add part', P => { P.parts.push(spec); }); S.state.select({ partId: spec.id }); return spec.id;
  };
  const doubleOn = () => (V ? V.double : K.pref('music.sounds', {}).double !== false);
  /* where Capcom's notes go: the selected part if it already plays this kit; an empty selected part, switched to the kit; otherwise a new part */
  function targetFor(kit) {
    const part = selectedPart();
    if (!part) return { mode: 'new', part: null };
    if (part.bank === 0 && part.program === kit) return { mode: 'same', part };
    return part.notes.length ? { mode: 'new', part } : { mode: 'switch', part };
  }
  Z.targetFor = targetFor;
  function targetWords(kit) {
    const t = targetFor(kit), kitName = nameOf('0:' + kit);
    if (!t.part) return `A new part is made for ${kitName}.`;
    if (t.mode === 'same') return `Goes into ${t.part.name}.`;
    if (t.mode === 'switch') return `${t.part.name} is empty, so it switches to ${kitName}.`;
    return `${t.part.name} plays another sound, so a new part is made for ${kitName}.`;
  }
  /* replace what the part has in [span.from, span.to) with these notes (t from the start of the span's bar) */
  function writeNotes(kit, at, span, notes, label, o) {
    o = o || {}; const t = targetFor(kit), spec = t.mode === 'new' ? newPartSpec('0:' + kit) : null, id = spec ? spec.id : t.part.id;
    edit(label, P => {
      let part;
      if (spec) { P.parts.push(spec); part = P.parts[P.parts.length - 1]; } else { part = P.parts.find(x => x.id === id); if (t.mode === 'switch') { part.bank = 0; part.program = kit; } }
      part.notes = part.notes.filter(n => n.t < at + span.from || n.t >= at + span.to).concat(notes.map(n => Object.assign({}, n, { t: at + n.t }))).sort((x, y) => x.t - y.t);
      P.bars = Math.max(P.bars, Math.ceil((at + span.to) / BAR));
      if (o.double && !part.devices.some(d => d.type === 'double' && d.on !== false)) part.devices.push(Object.assign({ type: 'double', on: true }, copy(SF3Compile.DEVICE_DEFAULTS.double)));
    });
    S.state.select({ partId: id });
    return { part: project().parts.find(x => x.id === id), mode: t.mode };
  }
  const barsOf = kit => (catalog().breaks[kit] || { bars: [] }).bars;
  Z.barsOf = barsOf;
  Z.insertBar = (kit, index) => {
    const bar = barsOf(kit)[index]; if (!bar) return null;
    const at = Math.round(S.transport.position), r = writeNotes(kit, at, { from: 0, to: BAR }, bar.notes.map(n => ({ t: n.t, n: n.n, v: n.v, len: n.len })), 'Insert Capcom’s bar', { double: doubleOn() });
    toast(`Capcom’s bar from ${baseName(pieceName(bar.piece))} is in ${r.part.name} at ${K.fmt.pos(at)}.`, r);
    return r;
  };
  function toast(text, r) { K.toast(text, { kind: 'good', action: { label: 'Undo', run: () => S.state.undo() } }); }
  /* the key a roll or fill hits: the slice Capcom uses most as a snare, else the one it plays most in its bars */
  function snareKey(kit) {
    const p = programOf('0:' + kit);
    if (p.keys) { const snares = p.keys.filter(k => k.capcom === 'snare' || (k.capcom === null && k.role === 'snare')).sort((a, b) => b.uses - a.uses); if (snares.length && snares[0].uses > 0) return snares[0].key; }
    const count = new Map(); for (const b of barsOf(kit)) for (const n of b.notes) count.set(n.n, (count.get(n.n) || 0) + 1);
    let best = null; for (const [k, c] of count) if (!best || c > best[1]) best = [k, c];
    return best ? best[0] : usualNote(entry('0:' + kit));
  }
  Z.snareKey = snareKey;
  const ramp = (a, b, i, n) => Math.max(1, Math.min(127, Math.round(a + (b - a) * i / Math.max(1, n - 1))));
  const MAKERS = {
    /* the last beat stuttered in 16ths at alternating strength (Capcom's fills) */
    fill: key => ({ span: { from: 144, to: 192 }, label: 'Fill', notes: [0, 1, 2, 3].map(i => ({ t: 144 + i * 12, n: key, v: i % 2 ? 90 : 104, len: 12 })) }),
    /* 16ths over the third beat, 32nds over the fourth, getting louder */
    roll: key => { const ts = [0, 1, 2, 3].map(i => 96 + i * 12).concat([0, 1, 2, 3, 4, 5, 6, 7].map(i => 144 + i * 6)); return { span: { from: 96, to: 192 }, label: 'Roll', notes: ts.map((t, i) => ({ t, n: key, v: ramp(60, 126, i, ts.length), len: t < 144 ? 12 : 6 })) }; },
    /* one hit with the band, then nothing */
    stop: key => ({ span: { from: 0, to: 192 }, label: 'Stop', notes: [{ t: 0, n: key, v: 126, len: 48 }] }),
    /* eight 16ths over the last two beats, each bent lower than the one before */
    toms: key => ({ span: { from: 96, to: 192 }, label: 'Toms', notes: [0, 0, -21, -21, -43, -43, -64, -64].map((d, i) => Object.assign({ t: 96 + i * 12, n: key, v: ramp(96, 126, i, 8), len: 12 }, d ? { bend: [[0, d]] } : {})) })
  };
  Z.generate = (kind, kit) => {
    if (!MAKERS[kind] || !programOf('0:' + kit)) return null;
    const bar = Math.floor(S.transport.position / BAR), spec = MAKERS[kind](snareKey(kit)), r = writeNotes(kit, bar * BAR, spec.span, spec.notes, spec.label, { double: false });
    toast(`${spec.label} is in bar ${bar + 1} of ${r.part.name}.`, r); return r;
  };

  /* ---- actions: the palette, tooltips and the status line all read these ------------------------------------ */
  const selected = () => V && entry(V.sel);
  const isBreak = () => { const en = selected(); return !!en && en.p.breakKit && en.p.bank === 0; };
  function act(id, title, hint, icon, run, enabled) { K.action({ id: 'sounds.' + id, title, hint, icon, group: 'Sounds', run, enabled: enabled || (() => !!V && !!selected()) }); }
  act('hear', 'Hear this sound', 'Play the chosen instrument where Capcom usually plays it.', 'play', () => hearChosen());
  act('use', 'Use on selected part', 'Give the part you selected in Compose this sound. Its notes stay as they are.', 'check', () => useChosen(), () => !!V && !!selected() && !!selectedPart());
  act('new', 'New part with this sound', 'Add a part that plays this sound, with the levels Capcom gives its role.', 'plus', () => { const id = Z.newPart(V.sel); K.toast(`Added ${project().parts.find(x => x.id === id).name}.`, { kind: 'good', action: { label: 'Undo', run: () => S.state.undo() } }); });
  act('insert', 'Insert at playhead', 'Write the chosen Capcom bar into the selected part at the playhead.', 'plus', () => { if (V.bar) Z.insertBar(entry(V.sel).p.program, V.bar.index); }, () => isBreak() && !!V.bar);
  for (const [kind, title, hint, icon] of [['fill', 'Write a fill', 'Stutter the last beat of the playhead’s bar on the snare slice.', 'drum'], ['roll', 'Write a roll', 'Rising 16ths, then 32nds, over the last two beats of the playhead’s bar.', 'echo'],
    ['stop', 'Write a stop', 'One hit on the first beat of the playhead’s bar, then silence.', 'stop'], ['toms', 'Write falling toms', 'Eight 16ths falling in pitch over the last two beats of the playhead’s bar.', 'down']])
    act(kind, title, hint, icon, () => Z.generate(kind, entry(V.sel).p.program), () => isBreak());
  function hearChosen() {
    const en = selected(); if (!en) return;
    if (en.p.breakKit && en.p.bank === 0 && barsOf(en.p.program).length) { const bars = barsOf(en.p.program); playBar(en.p.program, bars[0], 0); return; }
    hear(en.key, usualNote(en));
  }
  function useChosen() {
    const part = selectedPart(); if (!part) return;
    Z.use(V.sel, part.id); K.toast(`${part.name} now plays ${nameOf(V.sel)}.`, { kind: 'good', action: { label: 'Undo', run: () => S.state.undo() } });
  }

  /* ---- drawing: waveforms, keyboard, a bar's steps -------------------------------------------------------- */
  let samplesArr = null; const peakCache = new Map();
  const sampleBytes = () => samplesArr || (samplesArr = new SF3Engine.Engine(S.pack).samples);
  function peaksOf(index, cols, info) {
    const k = index + ':' + cols; if (peakCache.has(k)) return peakCache.get(k);
    const bytes = sampleBytes(), n = info.end - info.start, out = new Int16Array(cols * 2);
    for (let x = 0; x < cols; x++) {
      const a = info.start + Math.floor(x * n / cols), b = Math.max(a + 1, info.start + Math.floor((x + 1) * n / cols)); let lo = 127, hi = -128;
      for (let i = a; i < b; i++) { const v = bytes[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
      out[x * 2] = lo; out[x * 2 + 1] = hi;
    }
    if (peakCache.size > 400) peakCache.clear(); peakCache.set(k, out); return out;
  }
  function drawWave(c, w, h, index, role, o) {
    o = o || {}; const info = S.data.samples[index];
    c.fillStyle = K.css('--bg-0'); c.fillRect(0, 0, w, h);
    const mid = h / 2; c.fillStyle = K.css('--line-2'); c.fillRect(0, Math.round(mid), w, 1);
    if (!info) return;
    const n = info.end - info.start, cols = Math.max(1, Math.floor(w)), peaks = peaksOf(index, cols, info), lx = info.looped ? (info.loop - info.start) / n * w : w;
    if (info.looped) { c.fillStyle = K.css('--cv-band'); c.fillRect(Math.round(lx), 0, w - Math.round(lx), h); }
    /* shown as large as the picture allows: a quiet sample is still readable (its level is in the zone table) */
    let peak = 1; for (let i = 0; i < peaks.length; i++) peak = Math.max(peak, Math.abs(peaks[i]));
    c.fillStyle = K.css('--role-' + role); c.globalAlpha = 0.92; const amp = (mid - (o.small ? 2 : 4)) * Math.min(8, 124 / peak);
    for (let x = 0; x < cols; x++) { const hi = peaks[x * 2 + 1] / 128, lo = peaks[x * 2] / 128, y0 = mid - hi * amp, y1 = mid - lo * amp; c.fillRect(x, y0, 1, Math.max(1, y1 - y0)); }
    c.globalAlpha = 1;
    if (o.small) return;
    c.font = K.css('--cv-mono-sm'); c.textBaseline = 'top';
    c.fillStyle = K.css('--ink-3'); c.textAlign = 'right'; c.fillText(secs(n / SF3Catalog.ROOT_RATE), w - 6, 5);
    if (info.looped) { c.fillStyle = K.css('--accent'); c.fillRect(Math.round(lx), 0, 1, h); c.textAlign = 'left'; c.fillText('loop', Math.min(w - 40, Math.round(lx) + 5), 5); }
    c.textAlign = 'left';
  }
  /* the keyboard: the window of white keys starting one octave below the typing octave */
  function keyGeometry(w) {
    const wanted = Math.max(14, Math.floor(w / 17)), first = V.oct - 12, whites = [];
    for (let m = first; m <= 127 && whites.length < wanted; m++) if (isWhite(m)) whites.push(m);
    const ww = w / whites.length, index = new Map(whites.map((m, i) => [m, i]));
    return { whites, ww, first, last: whites[whites.length - 1], index, bw: Math.max(6, ww * 0.62) };
  }
  const blackLeft = (G, m) => { const i = G.index.get(m - 1); return i === undefined ? null : (i + 1) * G.ww - G.bw / 2; };
  function noteAt(G, x, y, blackH) {
    if (y < blackH) for (let m = G.first; m <= G.last; m++) { if (isWhite(m)) continue; const left = blackLeft(G, m); if (left !== null && x >= left && x < left + G.bw) return m; }
    const i = Math.floor(x / G.ww); return G.whites[Math.max(0, Math.min(G.whites.length - 1, i))];
  }
  const wposOf = (G, m) => { let count = 0; for (const wm of G.whites) { if (wm < m) count++; else break; } return count * G.ww; };
  /* the keys, the lane above them and the zone stripe below: the same numbers draw the keyboard and find the key under the pointer */
  function kbLayout(p, w, h) { const G = keyGeometry(Math.max(1, w)), multi = p.zones.length > 1, y0 = 10, y1 = multi ? h - 10 : h, kh = y1 - y0; return { G, multi, y0, y1, kh, blackH: kh * 0.6 }; }
  function drawKeyboard(c, w, h) {
    const en = selected(); if (!en) return;
    const p = en.p, { G, multi, y0, y1, kh } = kbLayout(p, w, h), role = '--role-' + p.role, reach = p.zones[p.zones.length - 1].keyHigh;
    c.fillStyle = K.css('--bg-0'); c.fillRect(0, 0, w, h);
    /* the lane above: where Capcom plays it (faint: ever; solid: most of the time; tick: the middle note) */
    c.fillStyle = K.css('--bg-3'); c.fillRect(0, 0, w, 6);
    if (p.range) {
      const x = m => Math.max(0, Math.min(w, wposOf(G, m)));
      c.fillStyle = K.css(role); c.globalAlpha = 0.35; c.fillRect(x(p.range.low), 0, Math.max(2, x(p.range.high + 1) - x(p.range.low)), 6);
      c.globalAlpha = 0.95; c.fillRect(x(p.range.typicalLow), 0, Math.max(2, x(p.range.typicalHigh + 1) - x(p.range.typicalLow)), 6); c.globalAlpha = 1;
      c.fillStyle = K.css('--cv-playhead'); c.fillRect(Math.round(x(p.range.median)), 0, 1, 6);
    }
    const down = V.pressed, zone = V.zone;
    G.whites.forEach((m, i) => {
      const x = i * G.ww, silent = m > reach, hit = down.has(m);
      c.fillStyle = K.css(hit ? '--accent' : '--cv-key'); c.fillRect(x + 0.5, y0, G.ww - 1, kh);
      if (!hit && p.range && m >= p.range.typicalLow && m <= p.range.typicalHigh) { c.fillStyle = K.css(role); c.globalAlpha = 0.3; c.fillRect(x + 0.5, y0, G.ww - 1, kh); c.globalAlpha = 1; }
      if (silent) { c.fillStyle = K.css('--bg-0'); c.globalAlpha = 0.55; c.fillRect(x + 0.5, y0, G.ww - 1, kh); c.globalAlpha = 1; }
    });
    for (let m = G.first; m <= G.last; m++) {
      if (isWhite(m)) continue; const left = blackLeft(G, m); if (left === null) continue; const hit = down.has(m);
      c.fillStyle = K.css(hit ? '--accent-2' : '--cv-key-black'); c.fillRect(left, y0, G.bw, kh * 0.6);
      if (!hit && p.range && m >= p.range.typicalLow && m <= p.range.typicalHigh) { c.fillStyle = K.css(role); c.globalAlpha = 0.45; c.fillRect(left, y0, G.bw, kh * 0.6); c.globalAlpha = 1; }
      if (m > reach) { c.fillStyle = K.css('--bg-0'); c.globalAlpha = 0.55; c.fillRect(left, y0, G.bw, kh * 0.6); c.globalAlpha = 1; }
    }
    c.font = K.css('--cv-mono-sm'); c.textBaseline = 'alphabetic'; c.textAlign = 'center';
    G.whites.forEach((m, i) => { if (m % 12 === 0) { c.fillStyle = K.css('--cv-key-label'); c.fillText(name12(m), i * G.ww + G.ww / 2, y1 - 5); } });
    /* the letters that play the keys */
    for (const [letter, off] of Object.entries(TYPING)) {
      const m = V.oct + off; if (m < G.first || m > G.last) continue;
      if (isWhite(m)) { c.fillStyle = K.css('--ink-3'); c.fillText(letter.toUpperCase(), G.index.get(m) * G.ww + G.ww / 2, y1 - 18); }
      else { const left = blackLeft(G, m); c.fillStyle = K.css('--ink-2'); c.fillText(letter.toUpperCase(), left + G.bw / 2, y0 + kh * 0.6 - 6); }
    }
    /* the root key of the chosen zone */
    const root = p.zones[zone].root;
    if (root !== null && root >= G.first && root <= G.last) {
      const x = isWhite(root) ? G.index.get(root) * G.ww + G.ww / 2 : (blackLeft(G, root) || 0) + G.bw / 2;
      c.fillStyle = K.css(isWhite(root) ? '--ink-3' : '--ink-2'); c.beginPath(); c.arc(x, isWhite(root) ? y1 - 28 : y0 + kh * 0.6 - 18, 2.5, 0, Math.PI * 2); c.fill();
    }
    /* zones: one stripe per zone under the keys */
    if (multi) p.zones.forEach((z, i) => {
      const a = wposOf(G, Math.max(z.keyLow, G.first)), b = z.keyHigh >= G.last ? w : wposOf(G, z.keyHigh + 1);
      if (b <= a) return; c.fillStyle = K.css(i === zone ? '--accent' : i % 2 ? '--line-3' : '--bg-4'); c.fillRect(a + 0.5, h - 6, Math.max(1, b - a - 1), 6);
    });
  }
  /* a bar as steps: one row per key it uses, a stroke per note, beat lines behind */
  function drawSteps(c, w, h, bar) {
    c.fillStyle = K.css('--bg-0'); c.fillRect(0, 0, w, h);
    const keys = [...new Set(bar.notes.map(n => n.n))].sort((a, b) => b - a), rows = Math.max(1, keys.length), rh = Math.max(2, Math.min(6, Math.floor((h - 6) / rows))), top = Math.round((h - rows * rh) / 2);
    for (let t = 0; t < BAR; t += 12) { c.fillStyle = K.css(t % 48 ? '--cv-grid-faint' : '--line-2'); c.fillRect(Math.round(t / BAR * w), 0, 1, h); }
    c.fillStyle = K.css('--role-drums');
    for (const n of bar.notes) { c.globalAlpha = 0.4 + 0.6 * n.v / 127; c.fillRect(Math.round(n.t / BAR * w), top + keys.indexOf(n.n) * rh, Math.max(2, Math.round(Math.min(n.len, 24) / BAR * w)), rh - 1); }
    c.globalAlpha = 1;
  }
  function track(cv, draw) { const ctl = K.canvas(cv, draw); V.ctls.push(ctl); return ctl; }

  /* ---- building the view ----------------------------------------------------------------------------------- */
  const tag = (text, cls, tip) => el('span.tag' + (cls ? '.' + cls : ''), tip ? { 'data-tip': tip } : null, text);
  const group = (title, right, ...kids) => el('section.group', null, el('h3', null, el('span', null, title), right || null), ...kids);
  const programNumber = p => p.bank === 0 ? String(p.program) : `${p.bank} · ${p.program}`;
  function kindTag(p) { return p.kit ? tag(p.breakKit ? 'Break kit' : 'Kit') : p.sustained ? tag('Sustains') : tag('Plays once'); }
  function cardTags(en) {
    const p = en.p, tags = [kindTag(p)];
    if (p.kit) tags.push(tag(`${p.keys.length} keys`)); else if (p.zones.length > 1) tags.push(tag(`${p.zones.length} zones`));
    else if (p.bank !== 0) tags.push(tag(secs(p.tone.seconds || p.zones[0].seconds)));
    if (p.kit && p.tempo) tags.push(tag(`${Math.round(p.tempo)} BPM`));
    else { const t = tuning(p); if (t) tags.push(tag(t.label, t.cls, t.tip)); }
    return tags;
  }
  const LO = 24, HI = 108, at = m => Math.max(0, Math.min(100, (m - LO) / (HI - LO) * 100)) + '%';
  function rangeBar(p) {
    const r = p.range; if (!r) return el('div.sn-range.none');
    return el('div.sn-range', null, el('i.full', { style: { left: at(r.low), width: `calc(${at(r.high + 1)} - ${at(r.low)})` } }), el('i.typ', { style: { left: at(r.typicalLow), width: `calc(${at(r.typicalHigh + 1)} - ${at(r.typicalLow)})` } }), el('i.med', { style: { left: at(r.median) } }));
  }
  function cardNode(en, used) {
    const p = en.p, name = nameOf(en.key), parts = used.get(en.key) || [];
    const foot = p.range ? `${name12(p.range.typicalLow)}–${name12(p.range.typicalHigh)}` : p.bank !== 0 ? '' : 'Not played';
    const count = p.usage.pieces.length;
    const node = el('button.sn-card', { type: 'button', class: { on: V.sel === en.key }, 'data-key': en.key, style: { '--c': 'var(--role-' + p.role + ')' },
      'data-tip': `${name}|${p.description}|Click to hear it and see its details.`, onclick: () => Z.select(en.key, { hear: true }) },
      el('span.sn-stripe'),
      el('div.sn-body', null,
        el('div.sn-top', null, el('b.sn-name', null, name), parts.length ? el('span.sn-used', { 'data-tip': `In this song|${joinWords(parts.slice(0, 3).map(x => x.name))}${parts.length > 3 ? ` and ${parts.length - 3} more` : ''} play${parts.length === 1 ? 's' : ''} it.` }, K.icon('check')) : null, el('span.num.sn-no', null, programNumber(p))),
        el('div.sn-tags', null, ...cardTags(en)),
        rangeBar(p),
        el('div.sn-foot.num', null, el('span', null, foot), el('span', null, count ? plural(count, 'piece') : p.bank === 0 ? 'unused' : 'effect'))));
    return node;
  }

  /* ---- the list of cards, drawn only for what is on screen ----------------------------------------------------- */
  const CARD_H = 96, CARD_MIN = 224;
  function inCategory(en, id, used) {
    if (id === 'music') return en.music;
    if (id === 'song') return used.has(en.key);
    if (id.startsWith('fam:')) return en.p.family === id.slice(4);
    return false;
  }
  function matches(en, tokens) {
    const hay = (nameOf(en.key) + ' ' + en.fixed).toLowerCase();
    return tokens.every(t => /^\d+$/.test(t) ? new RegExp('(^|[^0-9])' + t + '([^0-9]|$)').test(hay) : hay.includes(t));
  }
  function search(query) {
    const tokens = String(query).toLowerCase().split(/\s+/).filter(Boolean); if (!tokens.length) return [];
    const hits = entries().filter(en => matches(en, tokens)), first = tokens[0];
    return hits.map((en, i) => ({ en, i, rank: nameOf(en.key).toLowerCase().startsWith(first) ? 0 : nameOf(en.key).toLowerCase().includes(first) ? 1 : 2 })).sort((a, b) => a.rank - b.rank || a.i - b.i).map(x => x.en);
  }
  Z.search = search;
  function computeList() {
    const used = usedMap(); let list = V.query.trim() ? search(V.query) : entries().filter(en => inCategory(en, V.category, used));
    if (V.filter === 'sustains') list = list.filter(en => en.p.sustained && !en.p.kit);
    else if (V.filter === 'once') list = list.filter(en => !en.p.sustained && !en.p.kit);
    else if (V.filter === 'kits') list = list.filter(en => en.p.kit || en.p.breakKit);
    V.list = list; V.used = used; V.range = null;
  }
  Z.list = () => V ? V.list.map(en => en.key) : [];
  function layoutGrid(force) {
    const sc = V.scroll, w = sc.clientWidth, h = sc.clientHeight; if (!w || !h) return;
    const cols = Math.max(1, Math.floor(w / CARD_MIN)), rows = Math.ceil(V.list.length / cols);
    const first = Math.max(0, Math.floor(sc.scrollTop / CARD_H) - 2), last = Math.min(rows, Math.ceil((sc.scrollTop + h) / CARD_H) + 2);
    const sig = [first, last, cols, V.list.length].join();
    if (!force && V.range === sig) return; V.range = sig;
    V.grid.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`; V.grid.style.paddingTop = first * CARD_H + 'px'; V.grid.style.paddingBottom = (rows - last) * CARD_H + 'px';
    V.cols = cols; V.grid.replaceChildren(...V.list.slice(first * cols, last * cols).map(en => cardNode(en, V.used)));
    V.empty.hidden = V.list.length > 0; V.grid.hidden = !V.list.length;
  }
  function ensureVisible(key) {
    const i = V.list.findIndex(en => en.key === key); if (i < 0 || !V.cols) return;
    const sc = V.scroll, row = Math.floor(i / V.cols), top = row * CARD_H;
    /* off screen: bring its row to the middle, on a whole row so no card is cut at the top */
    if (top < sc.scrollTop || top + CARD_H > sc.scrollTop + sc.clientHeight) sc.scrollTop = Math.max(0, Math.round((top - (sc.clientHeight - CARD_H) / 2) / CARD_H) * CARD_H);
    layoutGrid();
  }
  function markSelected() { for (const node of V.grid.children) node.classList.toggle('on', node.dataset.key === V.sel); }

  /* ---- categories ---------------------------------------------------------------------------------------------------- */
  function categories() {
    const all = entries(), used = usedMap();
    return [{ id: 'music', label: 'All music', icon: 'sounds', count: all.filter(e => e.music).length, tip: 'All music|The 59 instruments Capcom’s music can play.' },
      { id: 'song', label: 'In this song', icon: 'note', count: [...used.keys()].filter(k => entry(k)).length, tip: 'In this song|The instruments your parts use now.' }, { sep: true },
      ...catalog().families.map(f => ({ id: 'fam:' + f, label: f, dot: FAMILY_ROLE[f] || 'fx', count: all.filter(e => e.p.family === f).length,
        tip: f === 'Effects & voices' ? 'Effects and voices|The game’s own sound effects and voices. They play as instruments too.' : `${f}|${all.filter(e => e.p.family === f).length} of the game’s instruments.` })), { sep: true },
      { id: 'mine', label: 'My instruments', icon: 'piano', tip: 'My instruments|Instruments you build from the game’s own sounds.' }];
  }
  function renderRail() {
    V.cats.replaceChildren(...categories().map(c => c.sep ? el('hr.sn-sep') : el('button.sn-cat', { type: 'button', class: { on: !V.query.trim() && V.category === c.id }, 'data-cat': c.id, 'data-tip': c.tip, onclick: () => Z.category(c.id) },
      c.dot ? el('span.dot', { style: { background: 'var(--role-' + c.dot + ')' } }) : K.icon(c.icon), el('span.sn-cat-name', null, c.label), c.count !== undefined ? el('span.num.count', null, c.count) : null)));
  }
  Z.category = id => {
    if (!V) return false;
    V.category = id; V.query = ''; V.search.value = ''; V.clear.hidden = true; V.root.classList.toggle('mine', id === 'mine');
    if (id === 'mine') showMine(); else hideMine();
    refreshList(); return true;
  };
  function headerText() {
    const q = V.query.trim(), n = V.list.length;
    const label = q ? `Results for “${q}”` : (categories().find(c => c.id === V.category) || {}).label || 'Sounds';
    V.title.textContent = label; V.count.textContent = plural(n, 'sound');
  }
  /* what Capcom does with this family: the medians of its tracks in the fighting and long pieces (catalog.roles) */
  const LESSON = { 'Drums': ['drums', 'drum'], 'Bass': ['bass', 'bass'], 'Keys & plucks': ['chords', 'chord and pluck'], 'Pads & strings': ['pad', 'pad'], 'Leads': ['lead', 'lead'], 'Hits & chops': ['fx', 'chop and hit'] };
  function renderLesson() {
    const box = V.lesson, c = catalog(), family = V.category.startsWith('fam:') ? V.category.slice(4) : null, spec = family && LESSON[family];
    box.hidden = !spec || !!V.query.trim() || !V.list.length; if (box.hidden) { box.replaceChildren(); return; }
    const r = c.roles[spec[0]], side = r.pan <= 44 ? 'to the left' : r.pan >= 84 ? 'to the right' : 'in the middle';
    box.replaceChildren(el('h3', null, `How Capcom sets up ${spec[1]} parts`),
      el('p.sn-fact', null, `Across its ${c.study.pieces} fighting and long pieces, Capcom’s ${spec[1]} tracks sit at volume `, num(r.volume), ' and expression ', num(r.expression), `, panned ${side}`, r.echo ? [', with an echo at about ', num(Math.round(r.echo.level * 100) + '%'), ' of the level'] : ', usually without an echo', '. ', el('span.faint', null, `Measured over ${r.tracks} tracks.`)));
  }
  function refreshList() { computeList(); headerText(); renderRail(); V.emptyText.textContent = V.query.trim() ? `No sound matches “${V.query.trim()}”.` : V.category === 'song' ? 'No part uses a sound yet. Add a part in Compose and it appears here.' : V.filter !== 'all' ? 'No sound in this group matches the filter.' : 'Nothing here yet.'; layoutGrid(true); markSelected(); renderLesson(); }
  function refreshAll() { if (!V) return; refreshList(); renderDetail(); }

  /* ---- My instruments: the Designer's place -------------------------------------------------------------------------------- */
  function showMine() {
    V.mine.replaceChildren(); const designer = S.views.get('designer');
    if (designer) { V.designer = designer; designer.mount(V.mine, V.ctx); return; }
    V.mine.append(el('div.empty', null, K.icon('piano', 'lg'), el('b', null, 'Custom instruments are optional.'), el('p', null, 'They arrive with the Instrument Designer.')));
  }
  function hideMine() { if (V.designer && V.designer.unmount) V.designer.unmount(); V.designer = null; V.mine.replaceChildren(); }

  /* ---- selecting ---------------------------------------------------------------------------------------------------------------- */
  Z.select = (key, o) => {
    o = o || {}; const en = entry(key); if (!en) return false;
    memory.key = key;
    if (!V) return true;
    cancelBar(); V.sel = key; V.zone = mainZone(en.p); V.pad = null; V.barPage = 1; V.barPiece = 'all'; V.bar = null;
    V.oct = Math.max(OCTAVE_MIN, Math.min(OCTAVE_MAX, Math.floor(usualNote(en) / 12) * 12));
    if (V.category === 'mine' || !V.list.some(x => x.key === key)) {
      /* the instrument is not in the list on screen: show it in its own family, with nothing filtered out */
      if (V.category === 'mine') { hideMine(); V.root.classList.remove('mine'); }
      V.query = ''; V.search.value = ''; V.clear.hidden = true; V.filter = 'all'; V.filterCtl.set('all', true); V.category = 'fam:' + en.p.family; refreshList();
    }
    markSelected(); ensureVisible(key); renderDetail();
    if (o.hear) hearChosen();
    return true;
  };

  /* ---- the detail column ------------------------------------------------------------------------------------------------------ */
  function disposeDetail() { for (const ctl of V.ctls) ctl.destroy(); V.ctls = []; V.kbd = V.wave = null; }
  function renderDetail() {
    if (!V) return; const en = selected(); if (!en) return;
    const top = V.detail.scrollTop, same = V.shown === en.key; disposeDetail(); V.bars = null;
    V.detail.replaceChildren(...(en.p.keys ? kitDetail(en) : pitchedDetail(en)));
    V.shown = en.key; V.detail.scrollTop = same ? top : 0;
    memory.sig = signature();
  }
  const signature = () => { const part = selectedPart(); return part ? part.id + ':' + part.bank + ':' + part.program : ''; };

  function headBlock(en) {
    const p = en.p, name = nameOf(en.key), c = 'var(--role-' + p.role + ')';
    const input = el('input.field.bare.grow', { value: name, 'aria-label': 'Instrument name', spellcheck: false, 'data-tip': 'Name|Call this instrument what you hear. It is saved with the song and in your preferences.|Clear the box to get the catalog name back.',
      onchange: e => { Z.rename(en.key, e.target.value); }, onkeydown: e => { if (e.key === 'Enter') e.target.blur(); else if (e.key === 'Escape') { e.target.value = nameOf(en.key); e.target.blur(); } } });
    const part = selectedPart(), partName = part ? part.name : 'a part';
    const use = K.bind(el('button.btn.primary', { type: 'button' }, K.icon('check'), el('span.sn-trunc', null, part ? `Use on ${partName}` : 'Use on a part')), 'sounds.use');
    const hearBtn = K.bind(el('button.btn', { type: 'button' }, K.icon('play'), 'Hear it'), 'sounds.hear');
    const newBtn = K.bind(el('button.btn', { type: 'button' }, K.icon('plus'), 'New part with this'), 'sounds.new');
    const label = (p.sure ? [tag('Named by ear', 'good', 'Named by ear|The Studio’s author judged this sound by ear and named it.')] : []);
    return el('section.group.sn-headblock', { style: { '--c': c } },
      el('div.sn-head', null, el('span.sn-swatch'), input, el('span.tag.num', { 'data-tip': 'Program|The instrument’s number in the game’s sound set.' }, p.bank === 0 ? 'Program ' + p.program : 'Effect ' + programNumber(p))),
      el('p.hint.sn-desc', null, p.description),
      el('p.hint.sn-identity', null, `${p.bank === 0 ? 'Music' : 'Effects'} set ${p.bank}, program ${p.program} · Arrangement role: ${p.role}. ` + (p.sure ? 'Timbre named by listening.' : 'Descriptive label; audition to identify the instrument.')),
      el('div.sn-tags', null, ...[kindTag(p), p.bank !== 0 ? tag('Sound effect', '', 'Sound effect|A sound effect used as an instrument.') : null, p.kit ? tag(`${p.keys.length} keys`) : p.zones.length > 1 ? tag(`${p.zones.length} zones`) : null,
        p.kit && p.tempo ? tag(`${Math.round(p.tempo)} BPM`) : (() => { const t = tuning(p); return t ? tag(t.label, t.cls, t.tip) : null; })(), ...label].filter(Boolean)),
      el('div.sn-actions', null, hearBtn, use, newBtn));
  }

  function pitchedDetail(en) {
    const p = en.p, kids = [headBlock(en)];
    /* keyboard */
    const cv = el('canvas'), readout = el('span.num.dim.sn-readout', null, ''), kb = el('div.sn-kbd', { tabindex: 0, 'data-tip': 'Keyboard|Click a key to hear it, or type A W S E D F T G Y H U J K for one octave. Z and X move the octave.|The bar above the keys shows where Capcom plays this sound.' }, cv);
    /* the readout shows the keys on screen, or the key under the pointer */
    V.hover = ''; const showReadout = () => { const G = keyGeometry(Math.max(1, cv.clientWidth)); readout.textContent = V.hover || `${name12(G.first)} – ${name12(G.last)}`; }; V.showReadout = showReadout;
    const shift = d => { V.oct = Math.max(OCTAVE_MIN, Math.min(OCTAVE_MAX, V.oct + d)); V.kbd.invalidate(); };
    const left = el('button.btn.icon.ghost.sn-left', { type: 'button', 'data-tip': 'Lower octave|Move the keyboard down an octave.|Z', onclick: () => shift(-12) }, K.icon('right'));
    const right = el('button.btn.icon.ghost', { type: 'button', 'data-tip': 'Higher octave|Move the keyboard up an octave.|X', onclick: () => shift(12) }, K.icon('right'));
    kids.push(group('Keyboard', el('span.hbox', null, readout, left, right)));
    const kbGroup = kids[kids.length - 1]; kbGroup.append(kb, rangeLegend(p));
    V.kbd = track(cv, (c, w, h, ctl) => { drawKeyboard(c, w, h, ctl); showReadout(); });
    wireKeyboard(cv, kb, en);
    /* velocity and length for auditioning */
    kbGroup.append(auditionControls());
    /* the sample */
    kids.push(waveGroup(en));
    kids.push(zoneGroup(en));
    if (p.tempo) kids.push(tempoGroup(en));
    if (p.breakKit && p.bank === 0 && barsOf(p.program).length) { kids.push(barsGroup(en)); kids.push(toolsGroup(en)); }
    kids.push(factGroup(en));
    return kids;
  }
  function rangeLegend(p) {
    const r = p.range;
    return el('p.hint.sn-legend', null, r ? ['Capcom plays it from ', num(name12(r.low)), ' to ', num(name12(r.high)), ', mostly ', num(name12(r.typicalLow)), ' to ', num(name12(r.typicalHigh)), '. The bar above the keys shows it.'] : p.bank !== 0 ? 'Capcom’s music never plays it. Its own pitch is at the dot.' : 'Capcom never plays it in the music.');
  }
  function auditionControls() {
    const readout = el('span.num.dim.sn-vel', null, V.velocity), slider = el('input.slider', { type: 'range', min: 1, max: 127, value: V.velocity, 'aria-label': 'Velocity', 'data-tip': 'Velocity|How hard each note is struck when you audition.|Soft notes also start more slowly.' });
    K.slider(slider, { min: 1, max: 127, step: 1, value: V.velocity, def: 100, readout, onInput: v => { V.velocity = v; savePrefs(); } });
    const seg = el('div'); K.seg(seg, LENGTHS, v => { V.length = v; savePrefs(); }, { value: V.length });
    return el('div.sn-ctl', null, el('label.lab', null, el('span', null, 'Velocity'), el('span.hbox', null, slider, readout)), el('label.lab', null, el('span', null, 'Length'), seg));
  }
  function savePrefs() { K.pref.set('music.sounds', { velocity: V.velocity, length: V.length, double: V.double }); }

  function wireKeyboard(cv, kb, en) {
    let pressed = null;
    const hover = m => {
      const p = en.p, r = p.range;
      const zi = p.zones.findIndex(z => m <= z.keyHigh), words = zi < 0 ? 'No sound above here' : r ? (m >= r.typicalLow && m <= r.typicalHigh ? 'Capcom plays this key' : m >= r.low && m <= r.high ? 'Capcom rarely plays it' : 'Capcom never plays it') : '';
      V.hover = `${name12(m)}${words ? ' · ' + words : ''}`; V.showReadout();
    };
    const play = m => {
      V.pressed = new Set([m]); V.kbd.invalidate(); const zi = en.p.zones.findIndex(z => m <= z.keyHigh);
      if (zi >= 0 && zi !== V.zone) setZone(zi); hover(m);
      if (zi >= 0) hear(en.key, m);
    };
    const layout = () => kbLayout(en.p, cv.clientWidth, cv.clientHeight), keyAt = (x, y) => { const L = layout(); return y < L.y0 ? null : noteAt(L.G, x, y - L.y0, L.blackH); };
    K.drag(cv, { start(d) { kb.focus({ preventScroll: true }); pressed = keyAt(d.x, d.y); if (pressed === null) return false; play(pressed); return {}; },
      move(d) { const m = keyAt(d.x, d.y); if (m !== null && m !== pressed) { pressed = m; play(m); } },
      end() { pressed = null; V.pressed = new Set(); V.kbd.invalidate(); } });
    cv.addEventListener('pointermove', e => { if (pressed !== null) return; const r = cv.getBoundingClientRect(), m = keyAt(e.clientX - r.left, e.clientY - r.top); if (m !== null) hover(m); });
    cv.addEventListener('pointerleave', () => { if (pressed === null) { V.hover = ''; V.showReadout(); } });
  }

  function waveGroup(en) {
    const p = en.p, cv = el('canvas'), box = el('div.sn-wave', { 'data-tip': 'Sample|The recording this sound plays. The shaded part loops while a note is held; the amber line is where the loop starts.' }, cv);
    const title = el('span.num.dim'), caption = el('p.hint.sn-legend');
    const index = () => V.pad !== null && p.keys ? p.keys.find(k => k.key === V.pad).sample : p.zones[V.zone].sample;
    const refresh = () => { const idx = index(), s = S.data.samples[idx]; if (!s) return; const lf = loopFacts(p, idx);
      title.textContent = `Sample ${idx} · ${secs((s.end - s.start) / SF3Catalog.ROOT_RATE)}`;
      caption.replaceChildren(...(lf ? ['It loops from ', num(secs(lf.from)), '; the loop lasts ', num(secs(lf.loop)), lf.loop < 0.5 ? '. A short loop stops the sound soon after a note ends.' : '. A long loop lets a note fade out.'] : ['It plays once from start to end.'])); };
    V.wave = track(cv, (c, w, h) => { drawWave(c, w, h, index(), p.role); }); V.waveText = refresh; refresh();
    return group('Sound', title, box, caption);
  }
  function setZone(i) {
    V.zone = i; if (V.kbd) V.kbd.invalidate(); if (V.wave) V.wave.invalidate(); if (V.waveText) V.waveText();
    if (V.zoneRows) V.zoneRows.forEach((tr, k) => tr.classList.toggle('on', k === i));
  }
  const keysText = (z, p) => z.keyLow === 0 && z.keyHigh >= 127 ? 'All keys' : z.keyLow === 0 ? 'to ' + name12(z.keyHigh) : z.keyHigh >= 127 ? 'from ' + name12(z.keyLow) : `${name12(z.keyLow)}–${name12(z.keyHigh)}`;
  const dB = trim => { const f = (64 + trim) / 64; return (f > 0 ? 20 * Math.log10(f) : -99); };
  function zoneGroup(en) {
    const p = en.p, sure = SURE;
    const rows = p.zones.map((z, i) => {
      const t = z.tuningCents === null ? '–' : K.fmt.signed(Math.round(z.tuningCents)), reliable = z.tuningConfidence >= sure, d = dB(z.level);
      const tr = el('tr', { class: { on: i === V.zone }, 'data-tip': `Zone ${i + 1}|Plays ${keysText(z, p)} from sample ${z.sample}. Click to see its waveform.`, onclick: () => setZone(i) },
        el('td', null, keysText(z, p)), el('td.num', null, z.root === null ? '–' : name12(z.root)), el('td.num', null, z.sample), el('td.num', null, secs(z.seconds)), el('td', null, z.looped ? 'loops' : 'once'),
        el('td.num', { class: reliable ? '' : 'faint', 'data-tip': z.tuningCents === null ? null : reliable ? `Tuning|${t} cents against the key it is played on.` : 'Tuning unclear|Too noisy to measure reliably, so it is never corrected.' }, t), el('td.num', null, (d >= 0 ? '+' : '−') + Math.abs(d).toFixed(1)));
      return tr;
    });
    V.zoneRows = rows;
    const table = el('table.sn-zones', null, el('thead', null, el('tr', null, ...['Keys', 'Root', 'Sample', 'Length', 'Loop', 'Cents', 'dB'].map((h, i) => el('th', { class: i > 0 && h !== 'Loop' ? 'r' : '' }, h)))), el('tbody', null, ...rows));
    return group(p.zones.length === 1 ? 'Zone' : 'Zones', el('span.num.dim', null, plural(p.zones.length, 'zone')), table, p.zones.length > 1 ? el('p.hint.sn-legend', null, 'Each zone is its own recording, used for the keys shown. Click a zone, or play a key, to see its waveform.') : null);
  }
  function factGroup(en) { return group('How Capcom uses it', null, ...facts(en).map(parts => el('p.sn-fact', null, ...parts.flat()))); }

  /* ---- kits: pads, tempo, Capcom's bars, fills ------------------------------------------------------------------------------------- */
  function kitDetail(en) {
    const p = en.p, kids = [headBlock(en)];
    if (V.pad === null) V.pad = (p.keys.slice().sort((a, b) => b.uses - a.uses)[0] || p.keys[0]).key;
    kids.push(padGroup(en));
    if (p.tempo) kids.push(tempoGroup(en));
    if (p.breakKit && p.bank === 0 && barsOf(p.program).length) { kids.push(barsGroup(en)); kids.push(toolsGroup(en)); }
    kids.push(waveGroupKit(en)); kids.push(factGroup(en));
    return kids;
  }
  const padName = k => /^hit \d+$/.test(k.label) ? 'Hit ' + name12(k.key) : k.label[0].toUpperCase() + k.label.slice(1);
  /* what the slice is: where Capcom puts it in the bar decides (kick on the beat, snare on 2 and 4); else what it sounds like */
  const padKind = k => k.capcom === 'kick' ? 'kick' : k.capcom === 'snare' ? 'snare' : k.capcom === 'ghost' ? 'ghost' : k.role === 'loop' ? 'loop' : k.role === 'beat' ? 'beat' : { K: 'kick', S: 'snare', H: 'hat', M: 'mid' }[k.sound] || 'hit';
  function padGroup(en) {
    const p = en.p, grid = el('div.sn-pads'), pads = [];
    p.keys.forEach((k, i) => {
      const cv = el('canvas'), typed = i < DIGITS.length ? DIGITS[i] : null;
      const node = el('button.sn-pad', { type: 'button', class: { on: V.pad === k.key }, 'data-key': k.key, 'data-tip': `${padName(k)}|Key ${name12(k.key)}, ${secs(k.seconds)} long. ${k.uses ? 'Capcom plays it ' + plural(k.uses, 'time') + '.' : 'Capcom never plays it.'}${typed ? '|Type ' + typed + ' to play it.' : ''}`,
        onclick: () => playPad(en, k, node) }, el('div.t', null, el('span.sn-padname', null, padName(k)), typed ? el('kbd', null, typed) : null), cv, el('div.m.num', null, el('span', null, name12(k.key)), el('span', null, padKind(k))));
      track(cv, (c, w, h) => drawWave(c, w, h, k.sample, p.role, { small: true })); pads.push(node); grid.append(node);
    });
    V.pads = pads;
    return group('Pads', el('span.num.dim', null, plural(p.keys.length, 'key')), grid);
  }
  function playPad(en, k, node) {
    V.pad = k.key; for (const n of V.pads) n.classList.toggle('on', n.dataset.key === String(k.key));
    if (node) { node.classList.add('hit'); setTimeout(() => node.classList.remove('hit'), 140); }
    if (V.wave) V.wave.invalidate(); if (V.waveText) V.waveText();
    hear(en.key, k.key, { len: Math.min(V.length, 48) });
  }
  function waveGroupKit(en) {
    const p = en.p, cv = el('canvas'), box = el('div.sn-wave', { 'data-tip': 'Sample|The recording of the chosen pad.' }, cv), title = el('span.num.dim');
    const slice = () => p.keys.find(k => k.key === V.pad) || p.keys[0];
    V.waveText = () => { const k = slice(), s = S.data.samples[k.sample]; title.textContent = `${padName(k)} · ${s ? secs((s.end - s.start) / SF3Catalog.ROOT_RATE) : ''}`; };
    V.wave = track(cv, (c, w, h) => drawWave(c, w, h, slice().sample, p.role)); V.waveText();
    return group('Sound', title, box);
  }
  function tempoGroup(en) {
    const p = en.p, kitBpm = p.tempo, songBpm = (project() && project().bpm) || 120, diff = songBpm / kitBpm - 1, unit = p.program === 10 ? 'beat piece' : 'slice', bars = barsOf(p.program);
    const stat = (label, value, tip) => el('div.sn-stat', { 'data-tip': tip }, el('small', null, label), el('b.num', null, value.toFixed(1)), el('small', null, 'BPM'));
    let words;
    if (Math.abs(diff) <= 0.02) words = `The song and the break run at the same tempo, so ${unit}s fit end to end.`;
    else if (diff > 0) words = `The song is faster, so each step is shorter than a ${unit}: ${unit}s are cut slightly short, as Capcom does.`;
    else words = `The song is slower, so each step is longer than a ${unit}: ${unit}s end early and small gaps open between them.`;
    const bpms = bars.map(b => b.bpm), capcom = bpms.length ? [Math.min(...bpms), Math.max(...bpms)] : null;
    return group('Tempo', null, el('div.sn-tempo', null, stat('This break', kitBpm, 'This break|The tempo at which this drum loop was recorded.'), stat('Your song', songBpm, 'Your song|The song’s tempo, set at the top of the window.')),
      el('p.sn-fact', null, el('b', null, Math.abs(Math.round(diff * 100)) <= 2 ? 'A match. ' : `${diff > 0 ? '+' : '−'}${Math.abs(Math.round(diff * 100))} %. `), words), capcom ? el('p.hint', null, `Capcom’s own pieces run it between ${Math.round(capcom[0])} and ${Math.round(capcom[1])} BPM.`) : null);
  }

  /* words that depend on where the playhead is and on which part is selected; kept current while the view is open */
  const liveText = {
    insert: kit => `Insert writes at the playhead, ${K.fmt.pos(Math.round(S.transport.position))}. ${targetWords(kit)}`,
    tools: kit => `Plain notes on the snare slice, in the bar the playhead is in. ${targetWords(kit)}`,
    bar: () => 'bar ' + (Math.floor(S.transport.position / BAR) + 1)
  };
  let liveFrame = 0;
  function refreshLive() {
    if (liveFrame || !V) return;
    liveFrame = requestAnimationFrame(() => {
      liveFrame = 0; const en = V && selected(); if (!en || !en.p.breakKit) return;
      for (const node of V.detail.querySelectorAll('[data-live]')) { const text = liveText[node.dataset.live](en.p.program); if (node.textContent !== text) node.textContent = text; }
    });
  }
  const PAGE = 20;
  function barsGroup(en) {
    const p = en.p, kit = p.program, all = barsOf(kit), pieces = [...new Set(all.map(b => b.piece))];
    const list = el('div.sn-bars'); V.bars = list;
    const doubleSwitch = el('button.switch', { type: 'button', 'aria-label': 'Double it', 'data-tip': 'Double|The same part again a moment later on the other side. Capcom does this to every drum break.|Costs one track per voice.' });
    K.toggle(doubleSwitch, { value: V.double, onChange: v => { V.double = v; savePrefs(); } });
    const options = [{ value: 'all', label: `All pieces · ${all.length}` }, ...pieces.map(c => ({ value: String(c), label: `${baseName(pieceName(c))} · ${all.filter(b => b.piece === c).length}` }))];
    const select = el('button'); K.select(select, options, { value: V.barPiece, onPick: v => { V.barPiece = v; V.barPage = 1; fill(); } }); select.setAttribute('data-tip', 'Piece|Show only the bars from one of Capcom’s pieces.');
    const target = el('p.hint.sn-target', { 'data-live': 'insert' }, liveText.insert(kit));
    const fill = () => {
      const shown = all.map((b, index) => Object.assign({ index }, b)).filter(b => V.barPiece === 'all' || String(b.piece) === V.barPiece).sort((x, y) => x.piece - y.piece || x.bar - y.bar || x.index - y.index), page = shown.slice(0, V.barPage * PAGE);
      list.replaceChildren(...page.map(b => barRow(en, b)), shown.length > page.length ? el('button.btn.ghost.sn-more', { type: 'button', 'data-tip': 'More bars|Show more of Capcom’s bars for this kit.', onclick: () => { V.barPage++; fill(); } }, `Show ${Math.min(PAGE, shown.length - page.length)} more of ${shown.length - page.length}`) : null);
      markPlaying();
    };
    V.fillBars = fill; fill();
    return group('Capcom’s bars', el('span.num.dim', null, plural(all.length, 'bar')), el('p.hint', null, 'Every bar Capcom wrote for this kit. Click one to hear it at your song’s tempo.'),
      el('div.sn-barctl', null, select, el('label.hbox.dim', { 'data-tip': 'Double|The same part again a moment later on the other side. Capcom does this to every drum break.|Costs one track per voice.' }, doubleSwitch, 'Double it')), target, list);
  }
  function barRow(en, b) {
    const kit = en.p.program, cv = el('canvas.sn-steps'), name = baseName(pieceName(b.piece));
    const play = el('button.btn.icon.ghost', { type: 'button', 'data-tip': 'Hear this bar|Play Capcom’s bar at your song’s tempo.', onclick: e => { e.stopPropagation(); V.bar = b; playBar(kit, b, b.index); } }, K.icon('play'));
    const insert = el('button.btn.ghost', { type: 'button', 'data-tip': 'Insert at playhead|Write this bar into the selected part, starting at the playhead. It replaces that bar’s notes.|Undo restores them.', onclick: e => { e.stopPropagation(); V.bar = b; Z.insertBar(kit, b.index); } }, K.icon('plus'), el('span.wide-only', null, 'Insert'));
    const row = el('div.sn-bar', { class: { on: V.playing === b }, 'data-tip': `${name}, bar ${b.bar + 1}|Click to hear it at your song’s tempo.|Capcom’s own tempo here was ${Math.round(b.bpm)} BPM.`, onclick: () => { V.bar = b; playBar(kit, b, b.index); } },
      cv, el('div.grow', null, el('b.sn-barname', null, name), el('small.num.dim', null, `bar ${b.bar + 1} · ${Math.round(b.bpm)} BPM`)), play, insert);
    row._bar = b; track(cv, (c, w, h) => drawSteps(c, w, h, b)); return row;
  }
  function toolsGroup(en) {
    const kit = en.p.program;
    /* each button is its action (palette, keys, enabled state) with the tool's own one-line tip */
    const tool = (id, label, text, note) => { const b = K.bind(el('button.btn', { type: 'button' }, K.icon(K.action.get('sounds.' + id).icon), label), 'sounds.' + id); K.tip.set(b, { name: label, text, note }); return b; };
    const row = el('div.sn-tools', null, tool('fill', 'Fill', 'Stutters the last beat of the bar on the snare slice, in 16ths.', 'Replaces the notes in that beat.'), tool('roll', 'Roll', 'Rising 16ths, then 32nds, getting louder.', 'Replaces the notes in the last two beats.'),
      tool('stop', 'Stop', 'One loud hit on the first beat, then silence.', 'Replaces the whole bar.'), tool('toms', 'Toms', 'Eight 16ths on the snare slice, each lower than the last.', 'Each note carries a pitch bend.'));
    return group('Fills and rolls', el('span.num.dim', { 'data-live': 'bar' }, liveText.bar(kit)), el('p.hint', { 'data-live': 'tools' }, liveText.tools(kit)), row);
  }

  /* ---- mounting ------------------------------------------------------------------------------------------------------------- */
  function typingKey(e) {
    if (!V || e.ctrlKey || e.metaKey || e.altKey || K.layers() > 0) return;
    const t = e.target; if (t && t.nodeType === 1 && (t.isContentEditable || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || (t.tagName === 'INPUT' && !/^(button|checkbox|radio|range|submit|reset|file|color|image)$/i.test(t.type)))) return;
    const en = selected(); if (!en || V.category === 'mine') return;
    const key = e.key.toLowerCase();
    if (en.p.keys) {
      const i = DIGITS.indexOf(key); if (key.length !== 1 || i < 0 || i >= en.p.keys.length) return;
      e.preventDefault(); e.stopPropagation(); if (!e.repeat) playPad(en, en.p.keys[i], V.pads && V.pads[i]); return;
    }
    if (key === 'z' || key === 'x') { e.preventDefault(); e.stopPropagation(); if (V.kbd) { V.oct = Math.max(OCTAVE_MIN, Math.min(OCTAVE_MAX, V.oct + (key === 'x' ? 12 : -12))); V.kbd.invalidate(); } return; }
    if (!(key in TYPING)) return;
    e.preventDefault(); e.stopPropagation(); if (e.repeat) return;
    const m = V.oct + TYPING[key]; if (m > 127) return;
    const zi = en.p.zones.findIndex(z => m <= z.keyHigh); if (zi < 0) return;
    V.pressed = new Set([m]); if (zi !== V.zone) setZone(zi); else if (V.kbd) V.kbd.invalidate();
    hear(en.key, m);
  }
  function typingUp(e) { if (V && V.pressed.size) { V.pressed = new Set(); if (V.kbd) V.kbd.invalidate(); } }

  function mount(host, ctx) {
    const prefs = K.pref('music.sounds', {});
    V = { ctx, root: null, sel: null, category: 'music', query: '', filter: 'all', list: [], used: new Map(), range: null, cols: 1, zone: 0, pad: null, oct: 48, pressed: new Set(), ctls: [], timers: [], offs: [], shown: null, bar: null, playing: null, barPage: 1, barPiece: 'all',
      velocity: Math.max(1, Math.min(127, Number(prefs.velocity) || 100)), length: LENGTHS.some(x => x.value === prefs.length) ? prefs.length : 96, double: prefs.double !== false };
    adoptNames();
    /* the view: categories | cards | detail */
    const search = el('input.field', { type: 'text', placeholder: 'Search sounds', spellcheck: false, autocomplete: 'off', 'aria-label': 'Search sounds', 'data-tip': 'Search|Find a sound by its name, its number, its family or a piece that uses it, such as Makoto.|Esc clears the search.' });
    const clear = el('button.btn.icon.ghost', { type: 'button', hidden: true, 'data-tip': 'Clear search|Show the categories again.', onclick: () => { search.value = ''; onSearch(); search.focus(); } }, K.icon('close'));
    const cats = el('div.sn-cats');
    const rail = el('aside.sn-rail', null, el('header', null, el('div.sn-search', null, K.icon('search'), search, clear)), cats,
      el('p.hint.sn-railnote', null, 'Capcom’s music uses 59 instruments. The game has 573 more sound effects and voices, and they play as instruments too.'));
    const title = el('h3'), count = el('span.num.dim'), filter = el('div');
    const filterCtl = K.seg(filter, [{ value: 'all', label: 'All', tip: 'All|Show every sound in this group.' }, { value: 'sustains', label: 'Sustains', tip: 'Sustains|Sounds that keep going while a note is held.' }, { value: 'once', label: 'Plays once', tip: 'Plays once|Sounds that play through once and fade, whatever the note length.' }, { value: 'kits', label: 'Kits', tip: 'Kits|Sounds with a different drum on each key.' }], v => { V.filter = v; refreshList(); }, { value: 'all' });
    const emptyText = el('p'), emptyClear = el('button.btn', { type: 'button', 'data-tip': 'Show all music|Clear the search and the filter and list the 59 instruments of Capcom’s music.', onclick: () => { V.filterCtl.set('all', true); V.filter = 'all'; Z.category('music'); } }, 'Show all music');
    const empty = el('div.empty', { hidden: true }, K.icon('search', 'lg'), el('b', null, 'Nothing found.'), emptyText, emptyClear);
    const grid = el('div.sn-grid'), lesson = el('div.sn-lesson', { hidden: true }), scroll = el('div.sn-scroll', { tabindex: -1 }, grid, lesson, empty);
    const main = el('section.sn-main', null, el('header', null, title, count, el('span.grow'), filter), scroll);    const detail = el('aside.sn-detail'), mine = el('section.sn-mine');
    const root = el('div.sounds', null, rail, main, detail, mine); host.append(root);
    Object.assign(V, { root, search, clear, cats, title, count, scroll, grid, lesson, empty, emptyText, detail, mine, filterCtl });
    function onSearch() { V.query = search.value; clear.hidden = !search.value; if (V.category === 'mine' && search.value) { V.category = 'music'; V.root.classList.remove('mine'); hideMine(); } refreshList(); }
    search.addEventListener('input', onSearch);
    search.addEventListener('keydown', e => { if (e.key === 'Escape' && search.value) { e.stopPropagation(); search.value = ''; onSearch(); } else if (e.key === 'ArrowDown' && V.list.length) { e.preventDefault(); const first = V.grid.querySelector('.sn-card'); if (first) first.focus(); } });
    /* arrow keys walk the cards, like a sound browser: each one is chosen and heard */
    scroll.addEventListener('keydown', e => {
      const d = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: V.cols, ArrowUp: -V.cols }[e.key]; if (!d || !V.list.length) return;
      e.preventDefault(); const i = Math.max(0, V.list.findIndex(x => x.key === V.sel)), j = Math.max(0, Math.min(V.list.length - 1, i + d)); if (j === i) return;
      Z.select(V.list[j].key, { hear: true }); const node = V.grid.querySelector(`[data-key="${V.list[j].key}"]`); if (node) node.focus({ preventScroll: true });
    });
    let frame = 0; scroll.addEventListener('scroll', () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; if (V) layoutGrid(); }); });
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => { if (V) layoutGrid(); }) : null; if (ro) ro.observe(scroll);
    V.stopResize = () => { if (ro) ro.disconnect(); };
    /* what to show first: the link, the part's own instrument, or where the user was */
    const params = new URLSearchParams(location.hash.slice(1)), part = selectedPart(), partKey = part ? part.bank + ':' + part.program : null;
    let key = params.get('instrument');
    if (!key || !entry(key)) key = memory.key && memory.sig === signature() && entry(memory.key) ? memory.key : partKey && entry(partKey) ? partKey : '0:20';
    const en = entry(key); V.sel = key; V.zone = mainZone(en.p); V.category = en.music ? 'fam:' + en.p.family : 'fam:Effects & voices';
    V.oct = Math.max(OCTAVE_MIN, Math.min(OCTAVE_MAX, Math.floor(usualNote(en) / 12) * 12));
    refreshList(); ensureVisible(key); renderDetail();
    V.offs = [ctx.on('project', () => { if (V) refreshAll(); }), ctx.on('selection', () => { if (V) renderDetail(); }), ctx.on('transport', refreshLive)];
    g.addEventListener('keydown', typingKey, true); g.addEventListener('keyup', typingUp, true);
    K.status('Click a card to hear it. Arrow keys walk the list. Type A W S E D F T G Y H U J K to play the keyboard.');
    if (params.get('category') === 'mine') Z.category('mine');
  }
  function unmount() {
    if (!V) return;
    cancelBar(); if (V.designer && V.designer.unmount) V.designer.unmount();
    V.offs.forEach(off => off && off()); V.stopResize(); disposeDetail();
    g.removeEventListener('keydown', typingKey, true); g.removeEventListener('keyup', typingUp, true);
    V.root.remove(); V = null; K.status('Ready. Space to play · Ctrl K for every command.');
  }
  Z.current = () => V ? V.sel : null;
  Z.view = () => V;
  S.view({ id: 'sounds', title: 'Sounds', icon: 'sounds', mount, unmount });
})(window);

/* ---- self-test: registered here, run by studio.html#selftest ------------------------------------------------------ */
(function (g) {
  'use strict';
  const S = g.Studio, K = g.Kit, a = S.assert, Z = S.sounds, copy = x => JSON.parse(JSON.stringify(x));
  const fresh = key => { S.state.newProject(S.demo()); S.transport.position = 0; if (S.activeView !== 'sounds') S.showView('sounds'); else if (Z.view()) Z.category('music'); if (key) Z.select(key); return Z.view(); };
  const tip = node => !!node.closest('[data-tip]');
  /* the transport's audition is replaced by a recorder, so the page makes no sound while it is tested */
  async function recording(fn) {
    const T = S.transport, original = T.audition, calls = []; T.audition = async (part, note, velocity, ticks) => { calls.push({ part: copy(part), note, velocity, ticks }); return () => {}; };
    try { await fn(calls); } finally { T.audition = original; }
    return calls;
  }
  const same = (x, y) => x.length === y.length && x.every((v, i) => v === y[i]);
  /* what the chip is told to play: the part is built and run in a driver like the transport's audition does, and the sample address is read from the chip */
  function chipStart(part, note) {
    const p = copy(part); p.notes = [{ t: 0, n: note, v: 100, len: 48 }]; p.mute = p.solo = false;
    const project = SF3Compile.normalize({ format: 'sf3project', version: 2, bpm: S.state.project.bpm, bars: 2, loop: { on: false }, parts: [p] });
    const built = SF3Compile.build(project, { catalog: S.state.catalog }), engine = new SF3Engine.Engine(S.pack);
    engine.patchAt(SF3Engine.CAVE.preview, built.bytes); engine.setRequest(60, SF3Engine.CAVE.preview); engine.request(60);
    for (let frame = 0; frame < 240; frame++) { engine.step(); for (let v = 0; v < 16; v++) if (engine.key & (1 << v)) return ((((engine.regs[v * 16 + 3] << 16) | engine.regs[v * 16 + 2]) - 0x400000) >>> 0); }
    return null;
  }
  const sampleStart = (key, note) => { const z = S.state.catalog.programs[key].zones.find(x => note <= x.keyHigh); return S.data.samples[z.sample].start; };
  const keyOnStarts = (bytes, frames) => {
    const engine = new SF3Engine.Engine(S.pack), seen = new Set(); engine.patchAt(SF3Engine.CAVE.preview, bytes); engine.setRequest(60, SF3Engine.CAVE.preview); engine.request(60);
    for (let f = 0; f < frames; f++) { engine.step(); for (let v = 0; v < 16; v++) if (engine.key & (1 << v)) seen.add(((((engine.regs[v * 16 + 3] << 16) | engine.regs[v * 16 + 2]) - 0x400000) >>> 0)); }
    return seen;
  };

  S.test('sounds', 'the 59 music instruments are listed with names and each opens its detail', () => {
    fresh(); const music = Z.entries().filter(e => e.music); a(music.length === 59, 'music instruments: ' + music.length);
    for (const en of music) {
      const name = Z.nameOf(en.key); a(name && !/^Instrument \d+$/.test(name), 'no name for ' + en.key);
      Z.select(en.key); const head = document.querySelector('.sn-head input'), card = document.querySelector(`.sn-card[data-key="${en.key}"]`);
      a(head && head.value === name, 'detail of ' + en.key); a(card && card.querySelector('.sn-name').textContent === name, 'card of ' + en.key);
    }
    a(new Set(music.map(e => Z.nameOf(e.key))).size === 59, 'names are distinct');
  });
  S.test('sounds', 'the families add up and the game’s sound effects are there to browse', () => {
    fresh(); const cats = [...document.querySelectorAll('.sn-cat')].map(b => b.dataset.cat); a(['music', 'song', 'mine'].every(c => cats.includes(c)) && S.state.catalog.families.every(f => cats.includes('fam:' + f)), 'categories ' + cats);
    Z.category('fam:Effects & voices'); a(Z.list().length === 573); a(Z.entries().filter(e => e.music).length + 573 === Z.entries().length);
    let total = 0; for (const f of S.state.catalog.families.filter(x => x !== 'Effects & voices')) { Z.category('fam:' + f); total += Z.list().length; } a(total === 59, 'families hold ' + total);
    Z.category('music'); a(document.querySelectorAll('.sn-card').length > 0 && document.querySelectorAll('.sn-card').length < 59 + 1);
  });
  S.test('sounds', 'search finds a sound by name, number, family and piece', () => {
    const V = fresh(); a(Z.search('bell').some(e => e.key === '0:60'), 'by name'); a(Z.search('60').some(e => e.key === '0:60'), 'by number');
    const leads = Z.search('leads'); a(leads.length >= 4 && leads.some(e => e.p.family === 'Leads'), 'by family');
    const makoto = Z.search('Makoto'); a(makoto.length > 0 && makoto.every(e => e.p.usage.pieces.some(c => /makoto/i.test(S.data.songs.find(s => s.code === c).name))), 'by piece');
    V.search.value = 'makoto'; V.search.dispatchEvent(new Event('input', { bubbles: true }));
    a(Z.list().length === makoto.length && /Results for/.test(V.title.textContent) && !document.querySelector('.sn-cat.on'), 'the list follows the search box');
    V.search.value = 'zzzz'; V.search.dispatchEvent(new Event('input', { bubbles: true })); a(!V.empty.hidden && /No sound matches/.test(V.empty.textContent), 'empty state');
    V.search.value = ''; V.search.dispatchEvent(new Event('input', { bubbles: true })); a(V.empty.hidden && Z.list().length > 0);
  });
  S.test('sounds', 'the tuning badge follows auto-tune’s 0.8 rule', () => {
    fresh(); a(SF3Compile.AUTO_TUNE_SURE === 0.8);
    const check = on => { for (const en of Z.entries()) {
      const p = en.p, t = Z.tuning(p), part = Z.auditionPart(p.bank, p.program);
      if (p.kit || p.tuningCents === null) { a(t === null, 'kit or unmeasured: ' + en.key); continue; }
      if (!(p.tuningConfidence >= 0.8)) { a(t.kind === 'unsure' && part.tune === 0, 'unsure ' + en.key); continue; }
      a(t.kind === (Math.abs(p.tuningCents) < 5 ? 'ok' : on ? 'fixed' : 'off'), `${en.key} is ${t.kind}`);
      if (t.kind === 'off') a(/^[+-]\d+ cents$/.test(t.label), t.label);
      a(part.tune === (on ? 0 : p.tuningCents), 'the audition is the song’s: ' + en.key);
    } };
    check(true); S.edit('Auto-tune off', P => { P.autoTune = false; }); check(false); S.state.undo();
    a(Z.entries().some(e => Z.tuning(e.p) && Z.tuning(e.p).kind === 'unsure') && Z.entries().some(e => Z.tuning(e.p) && Z.tuning(e.p).kind === 'fixed'));
  });
  S.test('sounds', 'a card click chooses and plays; the audition reaches the chip with the chosen program', async () => {
    fresh(); const keys = ['0:46', '0:20', '0:43', '1:5'], starts = new Set();
    for (const key of keys) {
      const [bank, program] = key.split(':').map(Number), note = Z.usualNote(key);
      const calls = await recording(async () => { Z.select('0:1'); Z.select('0:6'); Z.category('fam:' + S.state.catalog.programs[key].family); const card = document.querySelector(`.sn-card[data-key="${key}"]`) || (Z.select(key), document.querySelector(`.sn-card[data-key="${key}"]`)); card.click(); await new Promise(r => setTimeout(r, 30)); });
      a(calls.length === 1 && calls[0].part.bank === bank && calls[0].part.program === program && calls[0].note === note, 'a click on ' + key + ' auditions it');
      const start = chipStart(calls[0].part, note); a(start === sampleStart(key, note), `${key}: the chip plays the sample of its zone`); starts.add(start);
    }
    a(starts.size === keys.length, 'each program reaches the chip as its own sample');
  });
  S.test('sounds', 'typing plays the keyboard, Z and X move it, digits play the pads', async () => {
    const V = fresh('0:46'), press = key => document.body.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    const oct = V.oct, calls = await recording(async () => { press('a'); press('w'); press('k'); await new Promise(r => setTimeout(r, 30)); });
    a(calls.length === 3 && calls.map(c => c.note).join() === [oct, oct + 1, oct + 12].join() && calls.every(c => c.part.program === 46), 'letters: ' + calls.map(c => c.note));
    press('x'); a(V.oct === oct + 12); press('z'); press('z'); a(V.oct === oct - 12); press('x');
    const kit = await recording(async () => { Z.select('0:1'); press('1'); press('3'); await new Promise(r => setTimeout(r, 30)); });
    const keys = S.state.catalog.programs['0:1'].keys; a(kit.map(c => c.note).join() === [keys[0].key, keys[2].key].join() && kit.every(c => c.part.program === 1), 'pads: ' + kit.map(c => c.note));
    const typing = recording(async () => { const input = Z.view().search; input.focus(); input.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true })); }); a((await typing).length === 0, 'typing in the search box plays nothing');
  });
  S.test('sounds', 'the keyboard plays the key under the pointer, with the chosen velocity and length', async () => {
    const V = fresh('0:46'), cv = document.querySelector('.sn-kbd canvas'), r = cv.getBoundingClientRect(), saved = [V.velocity, V.length];
    const fire = (type, x, y, target) => (target || cv).dispatchEvent(new PointerEvent(type, { clientX: r.left + x, clientY: r.top + y, button: 0, pointerId: 7, bubbles: true, isPrimary: true }));
    const slider = document.querySelector('.sn-ctl input[type=range]'); slider.value = 30; slider.dispatchEvent(new Event('input', { bubbles: true }));
    [...document.querySelectorAll('.sn-ctl .seg button')].find(b => b.textContent === '1/8').click();
    const calls = await recording(async () => { fire('pointerdown', 100, 70); await new Promise(x => setTimeout(x, 20)); fire('pointermove', 170, 70, window); fire('pointerup', 170, 70, window); await new Promise(x => setTimeout(x, 30)); });
    a(calls.length === 2 && calls[0].note !== calls[1].note && calls.every(c => c.velocity === 30 && c.ticks === 24 && c.part.program === 46), 'two keys, velocity 30, an eighth: ' + JSON.stringify(calls.map(c => [c.note, c.velocity, c.ticks])));
    a(V.pressed.size === 0, 'released');
    slider.value = saved[0]; slider.dispatchEvent(new Event('input', { bubbles: true })); [...document.querySelectorAll('.sn-ctl .seg button')].find(b => b.textContent === (saved[1] === 24 ? '1/8' : saved[1] === 48 ? '1/4' : saved[1] === 96 ? '1/2' : '1 bar')).click();
  });
  S.test('sounds', 'Use on gives the part the sound, changes the build, and undoes', () => {
    fresh('0:57'); const part = S.state.project.parts[1]; S.state.select({ partId: part.id });
    const json = JSON.stringify(S.state.project), before = S.state.build().bytes.slice(), button = [...document.querySelectorAll('.sn-actions button')].find(b => /^Use on/.test(b.textContent));
    a(button && button.textContent.includes(part.name) && button.getAttribute('aria-disabled') !== 'true', 'the button names the part');
    button.click(); const q = S.state.project.parts[1]; a(q.bank === 0 && q.program === 57 && q.notes.length === part.notes.length, 'program and notes');
    a(!same(before, S.state.build().bytes), 'the build changed'); S.state.undo(); a(JSON.stringify(S.state.project) === json && same(before, S.state.build().bytes), 'undo restores the song');
    Z.use('1:5', part.id); a(S.state.project.parts[1].bank === 1 && S.state.build().bytes.length > 33, 'a sound effect can be an instrument'); S.state.undo();
    S.edit('Empty the song', P => { P.parts = []; }); S.state.select({}); const none = [...document.querySelectorAll('.sn-actions button')].find(b => /^Use on/.test(b.textContent));
    a(none && none.getAttribute('aria-disabled') === 'true', 'no part, no “Use on”'); S.state.undo();
  });
  S.test('sounds', 'New part with this brings Capcom’s levels for the role', () => {
    fresh('0:57'); const n = S.state.project.parts.length, tracks = S.state.build().report.tracks.length, json = JSON.stringify(S.state.project);
    const id = Z.newPart('0:57'), q = S.state.project.parts.find(x => x.id === id), preset = SF3Catalog.suggest('pad');
    a(S.state.project.parts.length === n + 1 && q.bank === 0 && q.program === 57 && q.role === 'pad' && q.volume === preset.volume && q.expression === preset.expression && q.pan === preset.pan, 'pad levels');
    a(S.state.selection.partId === id && S.state.build().report.tracks.length >= tracks, 'selected and built');
    const kitId = Z.newPart('0:1'), k = S.state.project.parts.find(x => x.id === kitId), brk = SF3Catalog.suggest('drums'); a(k.role === 'drums' && k.volume === brk.volume && k.pan === brk.pan && k.program === 1, 'drum levels');
    S.state.undo(); S.state.undo(); a(JSON.stringify(S.state.project) === json, 'undo');
    const button = [...document.querySelectorAll('.sn-actions button')].find(b => /New part/.test(b.textContent)); a(button, 'the button'); button.click(); a(S.state.project.parts.length === n + 1 && S.state.project.parts[n].program === 57); S.state.undo();
  });
  S.test('sounds', 'a rename is kept in the song and in preferences, and follows into new songs', () => {
    const old = K.pref('music.names', null); K.pref.del('music.names');
    try {
      fresh('0:20'); Z.rename('0:20', 'Rubber bass');
      a(S.state.project.names['0:20'] === 'Rubber bass' && K.pref('music.names', {})['0:20'] === 'Rubber bass', 'both places');
      a(Z.nameOf('0:20') === 'Rubber bass' && SF3Catalog.nameOf(S.state.catalog, 0, 20, S.state.project.names) === 'Rubber bass', 'Compose reads it too');
      a(document.querySelector('.sn-head input').value === 'Rubber bass' && document.querySelector('.sn-card[data-key="0:20"] .sn-name').textContent === 'Rubber bass', 'shown');
      S.state.newProject(S.demo()); S.showView('compose'); S.showView('sounds');
      a(S.state.project.names['0:20'] === 'Rubber bass', 'the new song uses the name, so Compose shows it');
      Z.rename('0:20', ''); a(!S.state.project.names['0:20'] && !K.pref('music.names', {})['0:20'] && Z.nameOf('0:20') === 'Main bass', 'cleared');
      Z.rename('0:20', 'Main bass'); a(!S.state.project.names['0:20'], 'the catalog’s own name is not stored');
    } finally { if (old) K.pref.set('music.names', old); else K.pref.del('music.names'); }
  });
  S.test('sounds', 'a break kit shows every bar Capcom wrote and compares its tempo with the song’s', () => {
    fresh(); const catalog = S.state.catalog;
    for (const kit of SF3Catalog.BREAK_KITS) {
      Z.select('0:' + kit); const bars = Z.barsOf(kit), p = catalog.programs['0:' + kit];
      a(bars.length === catalog.breaks[kit].bars.length && bars.length > 0, 'bars of kit ' + kit);
      a(document.querySelectorAll('.sn-bar').length === Math.min(20, bars.length), 'rows of kit ' + kit);
      const stats = [...document.querySelectorAll('.sn-stat b')].map(b => b.textContent); a(stats[0] === p.tempo.toFixed(1) && stats[1] === S.state.project.bpm.toFixed(1), 'tempo of kit ' + kit);
      a(/^bar \d+ · \d+ BPM$/.test(document.querySelector('.sn-bar small').textContent), 'a bar says where it is from');
    }
    Z.select('0:1'); const words = bpm => { S.edit('Tempo', P => { P.bpm = bpm; }); return document.querySelector('.sn-tempo').parentElement.querySelector('.sn-fact').textContent; };
    a(/cut slightly short/.test(words(150)), 'faster song'); a(/gaps/.test(words(90)), 'slower song'); a(/same tempo/.test(words(116.3)), 'same tempo');
    S.state.undo(); S.state.undo(); S.state.undo();
  });
  S.test('sounds', 'a Capcom bar is heard at the song’s tempo, then inserted, built, played by the driver and undone', async () => {
    const V = fresh('0:1'), bars = Z.barsOf(1), index = bars.findIndex(b => b.notes.length >= 6), bar = bars[index];
    S.transport.position = 2 * 192; const json = JSON.stringify(S.state.project), plain = S.state.build().bytes.slice();
    const row = document.querySelector('.sn-bar'), heard = row._bar;
    const calls = await recording(async () => { row.click(); await new Promise(r => setTimeout(r, 60000 * 4 / S.state.project.bpm + 200)); });
    a(calls.length === heard.notes.length && calls.every(c => c.part.program === 1) && [...new Set(calls.map(c => c.note))].sort().join() === [...new Set(heard.notes.map(n => n.n))].sort().join(), 'the whole bar is auditioned, note by note');
    a(Z.targetFor(1).mode === 'new', 'the demo’s selected part plays another sound, so a new part is made');
    const r = Z.insertBar(1, index), part = r.part, built = S.state.build();
    a(part.program === 1 && part.notes.length === bar.notes.length && part.notes.every(n => n.t >= 384 && n.t < 576), 'notes at the playhead');
    a(part.notes.every((n, i) => bar.notes.some(b => b.n === n.n && b.t === n.t - 384 && b.v === n.v && b.len === n.len)), 'Capcom’s notes, unchanged');
    a(part.devices.some(d => d.type === 'double' && d.on !== false) && built.report.partTracks[part.id].length === 2, 'offers the Double: two tracks');
    a(!same(plain, built.bytes), 'the build changed');
    const kit = new Set(S.state.catalog.programs['0:1'].zones.map(z => S.data.samples[z.sample].start)), seen = keyOnStarts(built.bytes, 1500);
    a([...seen].some(s => kit.has(s)), 'the driver plays the kit’s slices');
    const again = Z.insertBar(1, index); a(again.mode === 'same' && again.part.notes.length === bar.notes.length, 'a second insert replaces that bar, it does not pile up');
    S.state.undo(); S.state.undo(); a(JSON.stringify(S.state.project) === json && same(plain, S.state.build().bytes), 'undo');
    S.edit('Switch', P => { P.parts[0].notes = []; }); S.state.select({ partId: S.state.project.parts[0].id }); a(Z.targetFor(1).mode === 'switch', 'an empty selected part switches to the kit');
    const sw = Z.insertBar(1, index); a(sw.part.id === S.state.project.parts[0].id && sw.part.program === 1 && sw.part.notes.length === bar.notes.length, 'switched'); S.state.undo(); S.state.undo();
    void V;
  });
  S.test('sounds', 'Fill, Roll, Stop and Toms write plain notes into the playhead’s bar', () => {
    fresh('0:1'); S.transport.position = 3 * 192 + 20; const at = 3 * 192, key = Z.snareKey(1), json = JSON.stringify(S.state.project);
    a(S.state.catalog.programs['0:1'].keys.some(k => k.key === key), 'the key is one of the kit’s');
    const run = kind => { const r = Z.generate(kind, 1); a(r && r.part.program === 1, kind); return r.part.notes.filter(n => n.t >= at && n.t < at + 192); };
    let notes = run('fill'); a(notes.length === 4 && notes.every(n => n.n === key && n.t >= at + 144 && n.len === 12) && notes[0].v !== notes[1].v, 'fill: a stutter on the last beat'); S.state.undo();
    notes = run('roll'); a(notes.length === 12 && notes.every((n, i) => i === 0 || n.v >= notes[i - 1].v) && notes[0].t === at + 96 && notes[11].v > notes[0].v && notes.some(n => n.len === 6) && notes.some(n => n.len === 12), 'roll: rising 16ths then 32nds'); S.state.undo();
    notes = run('stop'); a(notes.length === 1 && notes[0].t === at && notes[0].v > 100, 'stop: one hit'); S.state.undo();
    notes = run('toms'); a(notes.length === 8 && notes.every(n => n.t >= at + 96) && notes[7].bend[0][1] < notes[3].bend[0][1] && notes[3].bend[0][1] < 0 && !notes[0].bend && SF3Compile.build(S.state.project, { catalog: S.state.catalog }).bytes.length > 33, 'toms: falling pitch by bend');
    S.state.undo(); a(JSON.stringify(S.state.project) === json, 'undo');
    S.transport.position = 0; const r = Z.generate('fill', 1); S.transport.position = 3 * 192; const r2 = Z.generate('stop', 1); a(r2.mode === 'same' && r2.part.id === r.part.id, 'the next tool writes into the same part'); S.state.undo(); S.state.undo();
  });
  S.test('sounds', 'the pads of a kit play, and the Capcom piece filter narrows the bars', async () => {
    fresh('0:1'); const p = S.state.catalog.programs['0:1'], pads = document.querySelectorAll('.sn-pad');
    a(pads.length === p.keys.length && [...pads].every(x => x.querySelector('canvas') && x.dataset.tip !== ''), 'a pad for every key');
    const calls = await recording(async () => { pads[2].click(); await new Promise(r => setTimeout(r, 30)); }); a(calls.length === 1 && calls[0].note === p.keys[2].key && calls[0].part.program === 1, 'a pad click plays its key');
    const V = Z.view(), pieces = [...new Set(Z.barsOf(1).map(b => b.piece))]; a(pieces.length > 1);
    V.barPiece = String(pieces[0]); V.barPage = 1; V.fillBars(); const rows = [...document.querySelectorAll('.sn-bar')]; a(rows.length === Math.min(20, Z.barsOf(1).filter(b => b.piece === pieces[0]).length) && rows.every(r => r._bar.piece === pieces[0]), 'one piece');
    V.barPiece = 'all'; V.fillBars();
  });
  S.test('sounds', 'a sound effect plays as an instrument and says what it is', async () => {
    fresh('1:0'); a(/A sound effect used as an instrument/.test(document.querySelector('.sn-detail').textContent));
    const calls = await recording(async () => { await Z.hear('1:0', Z.usualNote('1:0')); }); a(calls.length === 1 && calls[0].part.bank === 1 && calls[0].part.program === 0);
    a(chipStart(calls[0].part, calls[0].note) === sampleStart('1:0', calls[0].note), 'the chip plays it'); a(!/\bbank\b/i.test(document.querySelector('.sounds').textContent), 'no “bank” in the words');
  });
  S.test('sounds', 'cards show the song’s instruments and how Capcom uses each sound', () => {
    fresh(); Z.category('song'); const keys = Z.list(), used = new Set(S.state.project.parts.map(p => p.bank + ':' + p.program));
    a(keys.length === used.size && keys.every(k => used.has(k)), 'In this song lists the parts’ instruments'); Z.category('music');
    for (const key of used) { Z.select(key); a(document.querySelector(`.sn-card[data-key="${key}"] .sn-used`), 'marked ' + key); }
    Z.select('0:46'); const card = document.querySelector('.sn-card[data-key="0:46"]'); a(/\d+ pieces?/.test(card.textContent) && card.querySelector('.sn-range .typ') && card.querySelector('.tag'), 'used-by count, range bar and tags');
    a(document.querySelector('.sn-detail .sn-fact').textContent.startsWith('Capcom uses it in'), 'facts in sentences');
  });
  S.test('sounds', 'the part chosen in Compose is the sound shown', () => {
    S.state.newProject(S.demo()); S.showView('compose'); S.state.select({ partId: S.state.project.parts[1].id }); S.showView('sounds'); a(Z.current() === '0:20', 'bass part: ' + Z.current());
    S.showView('compose'); S.state.select({ partId: S.state.project.parts[2].id }); S.showView('sounds'); a(Z.current() === '0:43', 'lead part: ' + Z.current());
  });
  S.test('sounds', 'My instruments gives way to the Designer, or says it is optional', () => {
    fresh(); Z.category('mine'); const mine = document.querySelector('.sn-mine'), had = S.views.has('designer');
    if (!had) { a(/Custom instruments are optional\./.test(mine.textContent) && /Instrument Designer/.test(mine.textContent), 'empty state'); let mounted = 0, unmounted = 0; S.view({ id: 'designer', title: 'Designer', icon: 'sounds', mount(root) { mounted++; root.append(K.el('div', { id: 'designer-probe' })); }, unmount() { unmounted++; } });
      try { Z.category('music'); Z.category('mine'); a(mounted === 1 && document.getElementById('designer-probe'), 'the Designer mounts in the slot'); Z.category('music'); a(unmounted === 1 && !document.getElementById('designer-probe'), 'and unmounts'); } finally { S.views.delete('designer'); } }
    else a(mine.children.length > 0, 'the Designer is in the slot'); Z.category('music');
  });
  S.test('sounds', 'every control has a tooltip, in the pitched, kit and effect views', () => {
    fresh(); const missing = [];
    for (const key of ['0:46', '0:1', '0:10', '1:0']) { Z.select(key); for (const n of document.querySelectorAll('.sounds button, .sounds input, .sounds [tabindex="0"], .sounds tbody tr')) if (!tip(n)) missing.push(key + ' ' + n.className + ' ' + n.textContent.slice(0, 20)); }
    a(!missing.length, 'no tooltip: ' + missing.slice(0, 5).join(' | '));
  });
  S.test('sounds', 'the page leaves Compose open again', () => { S.state.newProject(S.demo()); S.transport.position = 0; S.showView('compose'); return S.activeView === 'compose'; });
})(window);
