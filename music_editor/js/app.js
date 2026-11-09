/* 3rd Strike Music Editor: the page. Engine = the game's driver (engine.js); this file is only
 * interface: lists, the audio pump, the MIDI import table and the exports.
 */
(function () {
  'use strict';
  const $ = (s, root) => (root || document).querySelector(s);
  const $$ = (s, root) => Array.from((root || document).querySelectorAll(s));
  const el = (tag, props, ...kids) => {
    const node = Object.assign(document.createElement(tag), props || {});
    for (const kid of kids) node.append(kid);
    return node;
  };
  const status = (text, bad) => { const s = $('#status'); s.textContent = text; s.className = 'status' + (bad ? ' bad' : ''); };
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  const pack = window.SF3_PACK;
  if (!pack) { status('The data pack is missing. In this folder run: node cli/studio.js rom import sfiii3nr1.zip sfiii3.zip (your own ROM files), then reload this page.', true); return; }
  const { Engine, CHIP_RATE, CHANNELS, CHANNEL_SIZE } = window.SF3Engine;
  const Seq = window.SF3Seq, Data = window.SF3Data, Midi = window.SF3Midi, Project = window.SF3Project;
  let engine, data;
  try { engine = new Engine(pack); data = Data.load(engine, pack.names); }
  catch (e) { status('The data pack could not be read: ' + e.message, true); return; }
  engine.keyOns = [];
  const RATE = Math.round(CHIP_RATE), BAR = Seq.BAR;
  const PREVIEW_CODE = 60, AUDITION_CODE = 61;

  /* ---------------------------------------------------------------- stored names */
  const store = {
    get(key, fallback) { try { const v = localStorage.getItem('sf3music.' + key); return v === null ? fallback : JSON.parse(v); } catch (e) { return fallback; } },
    set(key, value) { try { localStorage.setItem('sf3music.' + key, JSON.stringify(value)); } catch (e) { /* storage may be off */ } },
  };
  let names = store.get('names', {});
  const instKey = (bank, program) => `${bank}:${program}`;
  const instName = (bank, program) => names[instKey(bank, program)] || `Program ${program}` + (bank ? ` (bank ${bank})` : '');

  /* ---------------------------------------------------------------- song facts */
  const facts = new Map();
  const info = (song) => { if (!facts.has(song.code)) facts.set(song.code, Data.describe(song)); return facts.get(song.code); };
  const usedBy = new Map();                         // instrument -> { names:Set, low, high }
  for (const song of data.songs) {
    for (const tr of info(song).tracks) for (const u of tr.instruments) {
      const key = instKey(u.bank, u.program);
      if (!usedBy.has(key)) usedBy.set(key, { songs: new Set(), low: u.low, high: u.high });
      const x = usedBy.get(key);
      x.songs.add(song.name.replace(' (second arrangement)', '')); x.low = Math.min(x.low, u.low); x.high = Math.max(x.high, u.high);
    }
  }

  /* ---------------------------------------------------------------- audio pump */
  const play = { kind: null, ticks: 0, lastMarker: 0, lines: 0, lead: 2, gap: 384, firstLine: 2, lit: new Float64Array(16) };
  const lift = { pending: null, tracks: [], all: 0, baseTempo: 0 };
  const player = {
    ctx: null, gain: null, next: 0, timer: 0, L: new Int32Array(4096), R: new Int32Array(4096), levels: [],
    ensure() {
      if (!this.ctx) {
        this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        this.gain = this.ctx.createGain(); this.gain.connect(this.ctx.destination); this.volume();
      }
      if (this.ctx.state === 'suspended') this.ctx.resume();
    },
    volume() { if (this.gain) this.gain.gain.value = Math.pow($('#master').value / 100, 2); },
    start() {
      this.ensure();
      this.next = this.ctx.currentTime + 0.06;
      if (!this.timer) this.timer = setInterval(() => this.pump(), 20);
      this.pump();
    },
    stop() {
      clearInterval(this.timer); this.timer = 0; this.levels.length = 0;
      if (this.ctx) { this.gain.disconnect(); this.gain = this.ctx.createGain(); this.gain.connect(this.ctx.destination); this.volume(); }
    },
    pump() {
      const ctx = this.ctx, L = this.L, R = this.R;
      if (this.next < ctx.currentTime) this.next = ctx.currentTime + 0.03;
      try {
        for (let guard = 0; this.next < ctx.currentTime + 0.2 && guard < 10; guard++) {
          let n = 0;
          L.fill(0); R.fill(0);
          for (let f = 0; f < 4; f++) { n += engine.step(L, R, n); frame(); }
          /* the voices' levels for this block, shown when the block is heard */
          this.levels.push({ at: this.next, peaks: engine.peaks.slice() });
          engine.peaks.fill(0);
          const buffer = ctx.createBuffer(2, n, RATE), a = buffer.getChannelData(0), b = buffer.getChannelData(1);
          for (let i = 0; i < n; i++) { a[i] = clamp(L[i] / 32768, -1, 1); b[i] = clamp(R[i] / 32768, -1, 1); }
          const source = ctx.createBufferSource();
          source.buffer = buffer; source.connect(this.gain); source.start(this.next);
          this.next += n / RATE;
        }
      } catch (e) { this.stop(); status('Playback stopped: ' + e.message, true); }
    },
  };

  /* once per driver frame: activity lights, song position, the key lift waiting for its line */
  function frame() {
    const now = performance.now();
    for (const [, voice] of engine.keyOns) play.lit[voice] = now;
    engine.keyOns.length = 0;
    play.ticks += (engine.tempo() + engine.tempoOffsetValue()) / 256;
    const marker = engine.marker();
    if (play.lastMarker === 2 && marker === 1) {
      play.lines++;
      if (lift.pending && lift.pending.when !== 'now') {
        const index = Math.round((play.ticks - play.firstLine) / 384);
        if (lift.pending.when === 'phrase' || play.gap >= 768 || index % 2 === 0) applyLift();
      }
    }
    play.lastMarker = marker;
    if (play.kind === 'mine') snapshotMaybe();
  }

  function beginPlay(kind, lead, gap, firstLine) {
    Object.assign(play, { kind, ticks: 0, lastMarker: 0, lines: 0, lead: lead || 0, gap: gap || 384, firstLine: firstLine || lead || 0 });
    Object.assign(lift, { pending: null, tracks: [], all: 0, baseTempo: 0 });
    $('#lift-state').textContent = '';
    engine.keyOns.length = 0;
    applyMutes();
  }

  function stopAll() { player.stop(); engine.reset(); play.kind = null; $('#now').textContent = ''; }

  const lights = $('#lights');
  for (let i = 0; i < 16; i++) lights.append(el('i', { className: i >= 12 ? 'fx' : '', title: `Voice ${i + 1}` + (i >= 12 ? ' (shared with sound effects in a fight)' : '') }));
  /* meters: each voice's level as it is heard (the pump works about 0.2 s ahead), falling back slowly */
  const shown = new Float32Array(16);
  function meters() {
    let fresh = null;
    const t = player.ctx ? player.ctx.currentTime : 0;
    while (player.levels.length && player.levels[0].at <= t) fresh = player.levels.shift().peaks;
    for (let i = 0; i < 16; i++) shown[i] = Math.max(fresh ? fresh[i] : 0, shown[i] * 0.88);
    const width = (level) => `${Math.round(Math.min(1, Math.sqrt(level / 0.5)) * 100)}%`;    // a quiet part still shows
    for (const m of $$('#parts .meter')) {
      const tracks = (play.kind === 'mine' && live.partTracks[Number(m.dataset.part)]) || [];
      let level = 0;
      for (const v of tracks) level = Math.max(level, shown[v]);
      m.firstChild.style.width = width(level);
      m.classList.toggle('live', level > 0.002);
    }
    for (const m of $$('#song-tracks .meter')) {
      const level = play.kind === 'game' ? shown[Number(m.dataset.track)] : 0;
      m.firstChild.style.width = width(level);
      m.classList.toggle('live', level > 0.002);
    }
  }
  function refresh() {
    const now = performance.now();
    $$('#lights i').forEach((node, i) => node.classList.toggle('on', now - play.lit[i] < 110));
    if (play.kind && player.timer) {
      const beats = Math.max(0, (play.ticks - play.lead) / Seq.TICKS_PER_BEAT);
      const bpm = Seq.tempoToBpm(engine.tempo() + engine.tempoOffsetValue());
      $('#now').textContent = `bar ${Math.floor(beats / 4) + 1}, beat ${Math.floor(beats % 4) + 1}   ${bpm.toFixed(1)} BPM`;
      if (play.kind === 'mine' && !dragging) { const bar = currentBar(); $('#p-pos').value = bar; $('#p-pos-n').textContent = bar; }
    }
    meters();
    requestAnimationFrame(refresh);
  }

  /* ---------------------------------------------------------------- tabs */
  function showTab(name) {
    $$('nav button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
    $$('main > section').forEach((s) => { s.hidden = s.id !== 'tab-' + name; });
    store.set('tab', name);
  }
  $$('nav button').forEach((b) => { b.onclick = () => showTab(b.dataset.tab); });
  $('#stop').onclick = stopAll;
  $('#master').oninput = () => { player.volume(); store.set('volume', $('#master').value); };
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') stopAll(); });

  /* ---------------------------------------------------------------- game music */
  let song = null;
  const songList = $('#songs');
  for (const s of data.songs) {
    const f = info(s);
    const item = el('div', { className: 'item' }, el('span', { textContent: s.name }), el('small', { textContent: f.loopLength ? `${f.bpm.toFixed(0)} BPM` : 'plays once' }));
    item.onclick = () => selectSong(s);
    item.dataset.code = s.code;
    songList.append(item);
  }
  const pitchSelect = $('#song-pitch');
  for (let s = -4; s <= 4; s++) pitchSelect.append(el('option', { value: s, textContent: s === 0 ? 'original' : (s > 0 ? '+' : '') + s + ' semitone' + (Math.abs(s) > 1 ? 's' : ''), selected: s === 0 }));

  function selectSong(s) {
    song = s;
    const f = info(s);
    $$('#songs .item').forEach((n) => n.classList.toggle('on', Number(n.dataset.code) === s.code));
    $('#song-title').textContent = s.name;
    $('#song-facts').textContent = [f.loopLength ? `${f.bpm.toFixed(1)} BPM` : `${f.bpm.toFixed(1)} BPM, plays once`,
      f.loopLength ? `${f.bars}-bar loop` : '', `${f.tracks.length} tracks`, `${s.bytes.length.toLocaleString()} bytes in the ROM`,
      `request number ${s.code}`, f.markers.gap ? `phrase line every ${f.markers.gap / BAR} bars` : 'no phrase lines'].filter(Boolean).join('  ·  ');
    const table = $('#song-tracks');
    table.replaceChildren(el('tr', null, ...['Track', 'Instruments', 'Notes', 'Level', 'Mute', 'Solo', 'Lift'].map((h) => el('th', { textContent: h }))));
    for (const tr of f.tracks) {
      const row = el('tr', { className: tr.track >= 12 ? 'shared' : '' });
      const kit = tr.instruments.some((u) => isKit(u.bank, u.program));
      row.append(el('td', { textContent: tr.track + 1, title: tr.track >= 12 ? 'Shared with sound effects during a fight' : '' }),
        el('td', null, ...tr.instruments.map((u) => el('span', { className: 'tag', textContent: instName(u.bank, u.program) + (isKit(u.bank, u.program) ? ' · kit' : '') }))),
        el('td', { className: 'num', textContent: tr.notes }),
        el('td', null, (() => { const m = el('span', { className: 'meter' }, el('i')); m.dataset.track = tr.track; return m; })()),
        el('td', null, el('input', { type: 'checkbox', className: 'mute', onchange: applyMutes })),
        el('td', null, el('input', { type: 'checkbox', className: 'solo', onchange: applyMutes })),
        el('td', null, el('input', { type: 'checkbox', className: 'lift', checked: !kit && tr.notes > 0 })));
      row.dataset.track = tr.track;
      table.append(row);
    }
    store.set('song', s.code);
  }

  function applyMutes() {
    let mute = 0, solo = 0;
    if (play.kind === 'game' || !play.kind) {
      for (const row of $$('#song-tracks tr[data-track]')) {
        const bit = 1 << Number(row.dataset.track);
        if ($('.mute', row).checked) mute |= bit;
        if ($('.solo', row).checked) solo |= bit;
      }
    }
    engine.mute = solo ? (~solo & 0xFFFF) : mute;
  }

  function playSong() {
    if (!song) return;
    const f = info(song);
    engine.restoreRequestTable(); engine.reset();
    beginPlay('game', f.lead, f.markers.gap, f.markers.first);
    engine.request(song.code, Number($('#song-fade').value));
    applyDriverControls();
    player.start();
    status(`Playing ${song.name}.`);
  }
  $('#song-play').onclick = playSong;

  function applyDriverControls() {
    const level = Number($('#song-atten').value);
    engine.setPitchVolume((Number(pitchSelect.value) + lift.all) * 256, level ? 256 - level : 0);
    const n = Number($('#song-speed').value);
    engine.setTempoOffset(n & 0xFF);
    $('#song-speed-text').textContent = n ? `${n > 0 ? '+' : ''}${(3 * n / 256 * Seq.FRAME_RATE / 48 * 60).toFixed(1)} BPM` : 'original';
  }
  pitchSelect.onchange = applyDriverControls;
  $('#song-speed').oninput = applyDriverControls;
  $('#song-atten').oninput = applyDriverControls;

  function applyLift() {
    const want = lift.pending; lift.pending = null;
    if (want.what === 'tracks') {
      const rows = play.kind === 'game' ? $$('#song-tracks tr[data-track]').filter((r) => $('.lift', r).checked).map((r) => Number(r.dataset.track)) : [];
      for (const i of rows) { engine.transpose(i, 1); lift.tracks.push(i); }
    } else {
      if (!lift.baseTempo) lift.baseTempo = engine.tempo();
      lift.all++;
      engine.setTempo(Math.round(lift.baseTempo * Math.pow(2, lift.all / 12)));
      applyDriverControls();
    }
    $('#lift-state').textContent = `Lifted at bar ${Math.floor(Math.max(0, play.ticks - play.lead) / BAR) + 1}.`;
  }
  $('#lift').onclick = () => {
    if (play.kind !== 'game' || !player.timer) { status('Play a piece of game music first, then lift.'); return; }
    lift.pending = { when: $('#lift-when').value, what: $('#lift-what').value };
    if (lift.pending.when === 'now' || !play.gap) applyLift();
    else $('#lift-state').textContent = 'Waiting for the line…';
  };
  $('#lift-reset').onclick = () => {
    for (const i of lift.tracks) engine.transpose(i, -1);
    if (lift.baseTempo) engine.setTempo(lift.baseTempo);
    Object.assign(lift, { pending: null, tracks: [], all: 0, baseTempo: 0 });
    applyDriverControls();
    $('#lift-state').textContent = 'Original key.';
  };

  /* ---------------------------------------------------------------- files out */
  function download(name, bytes, type) {
    const url = URL.createObjectURL(new Blob([bytes], { type: type || 'application/octet-stream' }));
    const a = el('a', { href: url, download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  const safeName = (s) => s.replace(/[^A-Za-z0-9 _-]+/g, ' ').trim().replace(/\s+/g, '_') || 'song';

  function wav(samples) {                       // interleaved Float32 stereo at the chip rate
    const n = samples.length, out = new DataView(new ArrayBuffer(44 + n * 2));
    const text = (at, s) => { for (let i = 0; i < s.length; i++) out.setUint8(at + i, s.charCodeAt(i)); };
    text(0, 'RIFF'); out.setUint32(4, 36 + n * 2, true); text(8, 'WAVEfmt '); out.setUint32(16, 16, true);
    out.setUint16(20, 1, true); out.setUint16(22, 2, true); out.setUint32(24, RATE, true); out.setUint32(28, RATE * 4, true);
    out.setUint16(32, 4, true); out.setUint16(34, 16, true); text(36, 'data'); out.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) out.setInt16(44 + 2 * i, Math.round(clamp(samples[i], -1, 1) * 32767), true);
    return new Uint8Array(out.buffer);
  }

  /* render with a second engine so the playing one is not disturbed */
  function renderOffline(setup, frames) {
    const side = new Engine(pack);
    setup(side);
    return wav(side.render(frames));
  }
  const framesForTicks = (ticks, tempo) => Math.ceil(ticks * 256 / tempo);

  $('#song-wav').onclick = () => {
    if (!song) return;
    const f = info(song), ticks = f.loopLength ? f.loopStart + f.loopLength : Math.max(...f.tracks.map((t) => t.end || 0)) + 96;
    status('Rendering…');
    setTimeout(() => {
      download(safeName(song.name) + '.wav', renderOffline((e) => e.request(song.code), framesForTicks(ticks, f.tempo || 464)), 'audio/wav');
      status(`Saved ${song.name} as a WAV file.`);
    }, 20);
  };

  const songMidi = (s) => Project.gameMidi(s, info(s), 2);       // introduction and two passes of the loop
  $('#song-midi').onclick = () => { if (song) { download(safeName(song.name) + '.mid', songMidi(song), 'audio/midi'); status(`Saved ${song.name} as MIDI (introduction and two passes of the loop).`); } };

  /* ---------------------------------------------------------------- sounds */
  const isKit = (bank, program) => { const p = data.banks[bank] && data.banks[bank][program]; return !!p && p.kit; };
  const bankSelect = $('#bank');
  data.banks.forEach((programs, b) => {
    const count = programs.filter(Boolean).length;
    if (count) bankSelect.append(el('option', { value: b, textContent: b === 0 ? `0 · music instruments (${count})` : `${b} · effects and voices (${count})` }));
  });
  let inst = null;
  function listPrograms() {
    const b = Number(bankSelect.value), box = $('#programs');
    box.replaceChildren();
    data.banks[b].forEach((p) => {
      if (!p) return;
      const used = usedBy.get(instKey(b, p.program));
      const item = el('div', { className: 'item' }, el('span', { textContent: instName(b, p.program) }),
        el('small', { textContent: (p.kit ? `kit, ${p.live.length} keys` : p.sustained ? 'pitched, sustains' : 'pitched, one-shot') + (used ? ` · ${used.songs.size} song${used.songs.size > 1 ? 's' : ''}` : '') }));
      item.dataset.program = p.program;
      item.onclick = () => selectInst(p);
      box.append(item);
    });
  }
  bankSelect.onchange = listPrograms;

  function audition(bank, program, note) {
    const len = Number($('#inst-len').value), vel = Number($('#inst-vel').value);
    const cmd = (d, op, ...a) => ({ d, k: 'cmd', op, a });
    const events = [cmd(0, 0xC1, 2, 0), cmd(0, 0xC2, bank), cmd(1, 0xC4, program), cmd(0, 0xC6, 110), cmd(0, 0xC8, 127), cmd(0, 0xC7, 64),
                    { d: 1, k: 'note', v: clamp(Math.round(vel / 2), 1, 63), n: note, tie: 0, len }, cmd(len + 96, 0xFF)];
    const tracks = new Array(16).fill(null); tracks[0] = events;
    engine.patchSequence(Seq.compile({ tracks }), AUDITION_CODE, 1);
    if (play.kind !== 'audition') { engine.reset(); beginPlay('audition', 0, 0, 0); engine.mute = 0; }
    engine.request(AUDITION_CODE);
    if (!player.timer) player.start();
  }

  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const noteName = (n) => NOTE_NAMES[n % 12] + (Math.floor(n / 12) - 1);
  function selectInst(p) {
    inst = p;
    const used = usedBy.get(instKey(p.bank, p.program));
    $$('#programs .item').forEach((n) => n.classList.toggle('on', Number(n.dataset.program) === p.program));
    $('#inst-title').textContent = instName(p.bank, p.program);
    $('#inst-name').value = names[instKey(p.bank, p.program)] || '';
    $('#inst-facts').textContent = [`bank ${p.bank}, program ${p.program}`,
      p.kit ? `kit: ${p.live.length} keys, each its own sound` : (p.live.length > 1 ? `pitched, ${p.live.length} samples across the keyboard` : 'pitched, one sound across the keyboard') + (p.sustained ? ', holds as long as the note' : ', plays once per note'),
      used ? `used by ${Array.from(used.songs).join(', ')} (notes ${noteName(used.low)} to ${noteName(used.high)})` : 'not used by the game\'s music'].join('  ·  ');
    const keys = $('#keys');
    keys.replaceChildren();
    if (p.kit) {
      for (const r of p.live) keys.append(el('button', { textContent: `${r.keyHigh}`, title: `Key ${r.keyHigh} (${noteName(r.keyHigh)}), sample ${r.sample}`, onclick: () => audition(p.bank, p.program, r.keyHigh) }));
    } else {
      const lo = used ? Math.max(0, Math.min(used.low - 5, 48)) : 36, hi = used ? Math.min(127, Math.max(used.high + 5, 72)) : 84;
      const root = data.samples[p.regions[0].sample] ? data.samples[p.regions[0].sample].root : -1;
      for (let n = lo; n <= hi; n++) {
        const black = [1, 3, 6, 8, 10].includes(n % 12);
        keys.append(el('button', { textContent: noteName(n), className: (black ? 'black' : '') + (used && n >= used.low && n <= used.high ? ' root' : ''), title: `Note ${n}` + (n === root ? ' (the sample\'s own pitch)' : ''), onclick: () => audition(p.bank, p.program, n) }));
      }
    }
    const table = $('#regions');
    table.replaceChildren(el('tr', null, ...['Keys', 'Sample', 'Own pitch', 'Length', 'Sustains', 'Level trim'].map((h) => el('th', { textContent: h }))));
    for (const r of p.live) {
      const s = data.samples[r.sample];
      table.append(el('tr', null, el('td', { textContent: r.keyLow === r.keyHigh ? r.keyHigh : `${r.keyLow} to ${r.keyHigh}` }), el('td', { className: 'num', textContent: r.sample }),
        el('td', { textContent: s ? `${noteName(s.root)} (${s.root})` : '?' }), el('td', { className: 'num', textContent: s ? (s.end - s.start).toLocaleString() + ' bytes' : '?' }),
        el('td', { textContent: s && s.looped ? 'yes (loops)' : 'no (plays once)' }), el('td', { className: 'num', textContent: r.level })));
    }
  }
  $('#inst-name').onchange = () => {
    if (!inst) return;
    const key = instKey(inst.bank, inst.program), value = $('#inst-name').value.trim();
    if (value) names[key] = value; else delete names[key];
    store.set('names', names);
    listPrograms(); selectInst(inst); if (song) selectSong(song); renderParts();
  };

  const effects = data.requests.filter((r) => r.kind !== 0).map((r) => r.code);
  function playEffect(code) {
    code = clamp(code, 0, data.count - 1);
    $('#sfx-code').value = code;
    const r = data.requests.find((x) => x.code === code);
    $('#sfx-info').textContent = r ? (r.kind === 0 ? 'this number is music' : `effect or voice (type ${r.kind})`) : 'nothing at this number';
    if (!r || r.kind === 0) return;
    engine.restoreRequestTable();
    if (play.kind !== 'audition' && play.kind !== 'effects') { engine.reset(); beginPlay('effects', 0, 0, 0); engine.mute = 0; }
    engine.request(code);
    if (!player.timer) player.start();
  }
  const stepEffect = (dir) => {
    const cur = Number($('#sfx-code').value);
    const next = dir > 0 ? effects.find((c) => c > cur) : effects.slice().reverse().find((c) => c < cur);
    if (next !== undefined) playEffect(next);
  };
  $('#sfx-play').onclick = () => playEffect(Number($('#sfx-code').value));
  $('#sfx-next').onclick = () => stepEffect(1);
  $('#sfx-prev').onclick = () => stepEffect(-1);

  /* ---------------------------------------------------------------- my song */
  let project = null;
  const projectFromMidi = (name, midi) => Project.fromMidi(name, midi, data.banks);
  const projectFromGame = (s) => Project.fromGame(s, info(s));

  function instrumentSelect(part) {
    const select = el('select');
    data.banks.forEach((programs, b) => {
      const group = el('optgroup', { label: b === 0 ? 'Music instruments (bank 0)' : `Bank ${b}` });
      programs.forEach((p) => {
        if (!p) return;
        const used = usedBy.get(instKey(b, p.program));
        group.append(el('option', { value: instKey(b, p.program), textContent: instName(b, p.program) + (p.kit ? ' · kit' : p.sustained ? ' · sustains' : '') + (used ? ` · ${Array.from(used.songs).slice(0, 2).join(', ')}` : ''),
          selected: b === part.bank && p.program === part.program }));
      });
      if (group.children.length) select.append(group);
    });
    select.onchange = () => { const [b, p] = select.value.split(':').map(Number); part.bank = b; part.program = p; changed(); };
    return select;
  }

  function renderParts() {
    $('#mine').hidden = !project; $('#mine-empty').hidden = !!project;
    if (!project) return;
    $('#p-name').value = project.name; $('#p-bpm').value = project.bpm;
    $('#p-loop').checked = project.loop.on; $('#p-loop-start').value = project.loop.startBar; $('#p-loop-end').value = project.loop.endBar;
    $('#p-loop-start').max = project.bars; $('#p-loop-end').max = project.bars;
    $('#p-markers').value = project.markerBars;
    const table = $('#parts');
    const sources = project.sources || [];
    table.replaceChildren(el('tr', null, ...['On', 'Part', 'Level', 'Notes from', 'Notes', 'At once', 'Instrument', '', 'Range', 'Transpose', 'Voices', 'Volume', 'Left / right', 'Expression', '', ''].map((h) => el('th', { textContent: h }))));
    $('#p-pos').max = project.bars;
    project.parts.forEach((part, index) => {
      const meter = el('span', { className: 'meter', title: 'What this part is playing now (its tracks\' output)' }, el('i'));
      meter.dataset.part = index;
      const number = (field, min, max) => el('input', { type: 'number', min, max, value: part[field], onchange: (e) => { part[field] = clamp(Number(e.target.value) || 0, min, max); e.target.value = part[field]; changed(); renderParts(); } });
      const range = (field) => el('input', { type: 'range', min: 0, max: 127, value: part[field], oninput: (e) => { part[field] = Number(e.target.value); changed(); } });
      const from = el('select', { title: 'Which part of the imported MIDI file this instrument plays' });
      from.append(el('option', { value: -1, textContent: sources.length ? (part.notes.length && part.source === undefined ? '(its own notes)' : '(nothing)') : '(its own notes)' }));
      sources.forEach((s, i) => from.append(el('option', { value: i, textContent: `${s.name} · ${s.notes.length} notes`, selected: part.source === i })));
      from.disabled = !sources.length;
      from.onchange = () => { takeNotes(part, Number(from.value)); changed(); renderParts(); };
      const fit = rangeCheck(part), cell = el('td', { className: fit.outside ? 'warn' : '', textContent: fit.text, title: fit.title });
      if (fit.suggest !== null && fit.suggest !== part.transpose) cell.append(' ', el('button', { textContent: `Fit (${fit.suggest > 0 ? '+' : ''}${fit.suggest})`, title: 'Move this part by whole octaves into the range the game uses this instrument in', onclick: () => { part.transpose = fit.suggest; changed(); renderParts(); } }));
      table.append(el('tr', null,
        el('td', null, el('input', { type: 'checkbox', checked: !part.mute, onchange: (e) => { part.mute = !e.target.checked; changed(); } })),
        el('td', null, el('input', { type: 'text', value: part.name, size: 14, onchange: (e) => { part.name = e.target.value; changed(); } })),
        el('td', null, meter),
        el('td', null, from),
        el('td', { className: 'num', textContent: part.notes.length }), el('td', { className: 'num', textContent: part.polyphony }),
        el('td', null, instrumentSelect(part)),
        el('td', null, el('button', { textContent: 'Hear', title: 'Play one note of this part on this instrument', onclick: () => audition(part.bank, part.program, hearNote(part)) })),
        cell, el('td', null, number('transpose', -48, 48)),
        el('td', null, number('voices', 1, 8)), el('td', null, range('volume')), el('td', null, range('pan')), el('td', null, range('expression')),
        el('td', null, el('button', { textContent: 'Copy', title: 'Duplicate this part (notes, instrument and settings) just below it', onclick: () => duplicatePart(index) })),
        el('td', null, el('button', { textContent: '×', title: 'Remove this part', onclick: () => { project.parts.splice(index, 1); changed(); renderParts(); } }))));
    });
    summary();
  }

  /* where an instrument sounds right: the notes the game's own music plays on it; a kit's keys */
  function instrumentRange(bank, program) {
    const p = data.banks[bank] && data.banks[bank][program];
    if (!p) return null;
    if (p.kit) return { kit: true, low: p.live.length > 1 ? p.live[1].keyLow - 1 : 0, high: p.live[p.live.length - 1].keyHigh };
    const used = usedBy.get(instKey(bank, program));
    return used ? { kit: false, low: used.low, high: used.high } : null;
  }
  function rangeCheck(part) {
    if (!part.notes.length) return { text: 'no notes yet', title: '', outside: 0, suggest: null };
    const r = instrumentRange(part.bank, part.program);
    let lo = 127, hi = 0;
    for (const n of part.notes) { lo = Math.min(lo, n.n); hi = Math.max(hi, n.n); }
    const span = `${noteName(clamp(lo + part.transpose, 0, 127))} to ${noteName(clamp(hi + part.transpose, 0, 127))}`;
    if (!r) return { text: span, title: 'The game\'s music never uses this instrument, so there is no range to compare with.', outside: 0, suggest: null };
    const outsideAt = (shift) => part.notes.reduce((c, n) => c + (n.n + shift < r.low || n.n + shift > r.high ? 1 : 0), 0);
    const outside = outsideAt(part.transpose);
    if (r.kit) return { text: outside ? `${outside} notes off the kit's keys` : 'on the kit\'s keys', outside, suggest: null,
                        title: `This kit has its sounds on keys ${r.low} to ${r.high}. A drum part needs each of its notes moved to the key of the drum you want, in your music program.` };
    let best = null, bestOut = outside;                 // whole octaves only; the smallest move among the best
    for (let k = -4; k <= 4; k++) {
      const out = outsideAt(12 * k);
      if (out < bestOut || (out === bestOut && best !== null && Math.abs(12 * k) < Math.abs(best))) { best = 12 * k; bestOut = out; }
    }
    return { text: span + (outside ? ` · ${outside} outside` : ' · fits'), outside, suggest: best,
             title: `The game's own music plays this instrument from ${noteName(r.low)} to ${noteName(r.high)}. Outside that it still plays, but may sound thin or muddy.` };
  }
  function hearNote(part) {
    if (part.notes.length) {
      if (isKit(part.bank, part.program)) return clamp(part.notes[0].n + part.transpose, 0, 127);
      return clamp(Math.round(part.notes.reduce((a, n) => a + n.n, 0) / part.notes.length) + part.transpose, 0, 127);
    }
    const r = instrumentRange(part.bank, part.program);
    return r ? (r.kit ? r.high : Math.round((r.low + r.high) / 2)) : 60;
  }
  /* give a part the notes of one part of the imported MIDI file (or none), keeping its instrument */
  function takeNotes(part, i) {
    const s = (project.sources || [])[i];
    part.source = i;
    part.notes = s ? s.notes.map((n) => ({ t: n.t, n: n.n, v: n.v, len: n.len })) : [];
    part.polyphony = s ? s.polyphony : 0;
    part.voices = s ? clamp(s.polyphony, 1, 4) : 1;
    part.transpose = 0;
    part.mute = false;
    if (s) { part.name = s.name; const fit = rangeCheck(part); if (fit.suggest !== null) part.transpose = fit.suggest; }
  }
  /* a MIDI file brought into an open song: the instruments stay, their notes are cleared, and each
   * instrument is then given one of the file's parts in the "Notes from" column */
  function bringIn(name, midi) {
    if (!midi.parts.length) throw new Error('The MIDI file has no notes.');
    const bars = Math.max(1, Math.ceil(midi.lengthTicks / BAR));
    Object.assign(project, { name: name.replace(/\.midi?$/i, ''), bars, tempoChanges: midi.tempo.slice(1).filter((c) => c.t > 0),
      loop: { on: true, startBar: 1, endBar: bars },
      sources: midi.parts.map((p) => ({ name: p.name + (p.drums ? ' (drums)' : ''), notes: p.notes, polyphony: p.polyphony })) });
    if (midi.tempo.length) project.bpm = Math.round(midi.tempo[0].bpm * 10) / 10;
    for (const part of project.parts) takeNotes(part, -1);
  }
  /* a part twice: the copy has its own notes and settings, so changing one leaves the other alone */
  function duplicatePart(index) {
    const copy = JSON.parse(JSON.stringify(project.parts[index]));
    copy.name = `${project.parts[index].name} copy`;
    project.parts.splice(index + 1, 0, copy);
    changed(); renderParts();
    status(`"${copy.name}" added below "${project.parts[index].name}". It needs ${copy.voices} more track${copy.voices > 1 ? 's' : ''}.`);
  }
  $('#part-add').onclick = () => {
    const p = data.banks[0].find((x) => x && !x.kit && x.sustained) || data.banks[0].find(Boolean);
    project.parts.push({ name: 'New part', notes: [], polyphony: 0, source: -1, bank: 0, program: p.program, volume: 80, pan: 64, expression: 100, transpose: 0, voices: 1, mute: false });
    changed(); renderParts();
  };
  $('#project-close').onclick = () => { project = null; store.set('project', null); renderParts(); status('Song closed. Import a MIDI file to start a new one.'); };

  const build = () => Project.build(project);

  function summary() {
    if (!project) return;
    try {
      const b = build(), r = b.report;
      const lines = [`${r.tracks.length} of 16 tracks, ${b.bytes.length.toLocaleString()} bytes.`];
      if (r.tracks.some((t) => t.sharedWithEffects)) lines.push(`Tracks 13 to 16 (${r.tracks.filter((t) => t.sharedWithEffects).map((t) => t.part.name).join(', ')}) are cut by sound effects during a fight.`);
      if (r.dropped) lines.push(`${r.dropped} notes left out (more notes at once than the part's voices, or out of range).`);
      for (const w of r.warnings) lines.push(w);
      $('#p-summary').textContent = lines[0];
      $('#p-report').textContent = lines.slice(1).join('\n');
      return b;
    } catch (e) { $('#p-summary').textContent = ''; $('#p-report').textContent = e.message; return null; }
  }

  let saveTimer = 0;
  function changed() {
    summary();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => store.set('project', project), 400);
    if (play.kind === 'mine' && player.timer) liveChange();
  }
  $('#p-name').onchange = (e) => { project.name = e.target.value; changed(); };
  $('#p-bpm').onchange = (e) => { project.bpm = clamp(Number(e.target.value) || 120, 30, 300); changed(); };
  $('#p-loop').onchange = (e) => { project.loop.on = e.target.checked; changed(); };
  $('#p-loop-start').onchange = (e) => { project.loop.startBar = clamp(Number(e.target.value) || 1, 1, project.bars); changed(); };
  $('#p-loop-end').onchange = (e) => { project.loop.endBar = clamp(Number(e.target.value) || 1, 1, project.bars); changed(); };
  $('#p-markers').onchange = (e) => { project.markerBars = Number(e.target.value); changed(); };

  /* ---------------------------------------------------------------- My song, live
   * Play starts at the bar on the position slider: the driver is run silently up to it (about
   * 0.7 s per 100 s of music, and a saved state every 4 bars makes later jumps quick), so a jump
   * sounds exactly as if the song had played through. While it plays, a change that leaves the
   * song's byte layout alone (volume, expression, pan, transpose, velocity, tempo) is written into
   * the running song and into the driver's track records (+98 volume, +100 expression, +109 pan),
   * so it is heard at once and survives the loop; anything else rebuilds and jumps back to the same
   * bar. Muted parts stay in while playing and are silenced in the mixer, so mute is instant too. */
  const ROM_BASE = window.SF3Engine.ROM_BASE;
  const live = { at: 0, bytes: null, partTracks: [], withMuted: false, loop: null, bpm: 0, snaps: new Map(), timer: 0 };
  function playBuild() {
    let parts = project.parts.map((p) => Object.assign({}, p, { mute: false })), b;
    try { b = Project.build(Object.assign({}, project, { parts })); } catch (e) { status(e.message, true); return null; }
    b.withMuted = true;
    if (b.report.warnings.length) {                     // too many tracks with the muted parts in: play without them
      parts = project.parts;
      try { b = Project.build(project); } catch (e) { status(e.message, true); return null; }
      b.withMuted = false;
    }
    b.partTracks = project.parts.map(() => []);
    for (const t of b.report.tracks) { const i = parts.indexOf(t.part); if (i >= 0) b.partTracks[i].push(t.track); }
    return b;
  }
  function liveMute() {
    let mask = 0;
    if (live.withMuted) project.parts.forEach((p, i) => { if (p.mute) for (const t of live.partTracks[i] || []) mask |= 1 << t; });
    engine.mute = mask;
  }
  /* same events at the same places, differing only in values the driver reads as it goes */
  const FREE = new Set([0xC1, 0xC3, 0xC6, 0xC7, 0xC8, 0xDC, 0xDD]);
  function sameLayout(x, y) {
    if (!x || x.length !== y.length) return false;
    const a = Seq.decompile(x).tracks, b = Seq.decompile(y).tracks;
    for (let k = 0; k < 16; k++) {
      if (!a[k] !== !b[k]) return false;
      if (!a[k]) continue;
      if (a[k].length !== b[k].length) return false;
      for (let i = 0; i < a[k].length; i++) {
        const p = a[k][i], q = b[k][i];
        if (p.k !== q.k || p.d !== q.d) return false;
        if (p.k === 'note' && (p.len !== q.len || p.tie !== q.tie)) return false;
        if (p.k === 'jump' && (p.op !== q.op || p.to !== q.to)) return false;
        if (p.k === 'cmd' && (p.op !== q.op || (!FREE.has(p.op) && p.a.join() !== q.a.join()))) return false;
      }
    }
    return true;
  }
  const songTick = () => {                            // where in the song (first beat = 0), folded into the loop
    let s = Math.max(0, play.ticks - play.lead);
    if (live.loop && s >= live.loop.end) s = live.loop.start + (s - live.loop.start) % (live.loop.end - live.loop.start);
    return s;
  };
  const currentBar = () => Math.floor(songTick() / BAR) + 1;
  function snapshotMaybe() {
    const s = play.ticks - play.lead;
    if (s < 0 || (live.loop && s >= live.loop.end)) return;          // the first pass only
    const bar = Math.floor(s / BAR);
    if (bar % 4 || live.snaps.has(bar)) return;
    live.snaps.set(bar, { ram: engine.ram.slice(), regs: engine.regs.slice(), pos: engine.pos.slice(), frac: engine.frac.slice(),
                          key: engine.key, cfg: engine.cfg, acc: engine.acc, frame: engine.frame, ticks: play.ticks, marker: play.lastMarker });
  }
  function fastForward(target) {
    for (let guard = 0; play.ticks < target && guard < 400000; guard++) {
      const n = engine.tick(); engine.chip(n);
      engine.keyOns.length = 0;
      play.ticks += (engine.tempo() + engine.tempoOffsetValue()) / 256;
      play.lastMarker = engine.marker();
      snapshotMaybe();
    }
    engine.peaks.fill(0);
  }
  /* play My song from a bar (1 = the start); quiet = get there but do not start the sound (self-test) */
  function playFrom(bar, quiet) {
    const b = playBuild();
    if (!b) return;
    summary();
    bar = clamp(Math.round(bar) || 1, 1, project.bars);
    const target = Seq.LEAD_IN + (bar - 1) * BAR;
    player.stop();
    const same = live.bytes && b.bytes.length === live.bytes.length && b.bytes.every((x, i) => x === live.bytes[i]);
    if (!same) live.snaps.clear();
    engine.restoreRequestTable();
    live.at = engine.patchSequence(b.bytes, PREVIEW_CODE, 0);
    Object.assign(live, { bytes: b.bytes, partTracks: b.partTracks, withMuted: b.withMuted, loop: b.loop, bpm: project.bpm });
    let snap = null;
    for (const [k, s] of live.snaps) if (s.ticks <= target && (!snap || s.ticks > snap.ticks)) snap = s;
    beginPlay('mine', Seq.LEAD_IN, Number(project.markerBars) * BAR, Seq.LEAD_IN);
    if (snap) {
      engine.ram.set(snap.ram); engine.regs.set(snap.regs); engine.pos.set(snap.pos); engine.frac.set(snap.frac);
      Object.assign(engine, { key: snap.key, cfg: snap.cfg, acc: snap.acc, frame: snap.frame });
      play.ticks = snap.ticks; play.lastMarker = snap.marker;
    } else {
      engine.reset();
      engine.request(PREVIEW_CODE);
    }
    fastForward(target);
    liveMute();
    if (!quiet) player.start();
    $('#p-pos').value = bar; $('#p-pos-n').textContent = bar;
    status(`Playing ${project.name} in the game's driver from bar ${bar}.`);
  }
  function playProject() { playFrom(Number($('#p-pos').value) || 1); }
  /* a change while My song plays */
  function liveChange() { clearTimeout(live.timer); live.timer = setTimeout(applyLive, 60); }
  function applyLive() {
    {
      if (play.kind !== 'mine' || !player.timer || !project) return;
      const b = playBuild();
      if (!b) return;
      if (b.withMuted === live.withMuted && sameLayout(live.bytes, b.bytes)) {
        engine.rom.set(b.bytes, live.at - ROM_BASE);
        project.parts.forEach((p, i) => {
          for (const t of b.partTracks[i]) {
            const c = CHANNELS + t * CHANNEL_SIZE;
            engine.w8(c + 98, p.volume & 127); engine.w8(c + 100, p.expression & 127);
            if (!p.notes.some((n) => n.pan !== undefined)) engine.w8(c + 109, p.pan & 127);
          }
        });
        if (project.bpm !== live.bpm) engine.setTempo(Seq.bpmToTempo(project.bpm));
        Object.assign(live, { bytes: b.bytes, partTracks: b.partTracks, bpm: project.bpm });
        live.snaps.clear();
        liveMute();
        return 'live';
      }
      playFrom(currentBar());
      return 'restarted';
    }
  }
  $('#p-play').onclick = playProject;
  $('#p-rewind').onclick = () => { $('#p-pos').value = 1; $('#p-pos-n').textContent = 1; if (play.kind === 'mine' && player.timer) playFrom(1); };
  $('#p-back').onclick = () => { const bar = Math.max(1, (play.kind === 'mine' && player.timer ? currentBar() : Number($('#p-pos').value)) - 4); if (play.kind === 'mine' && player.timer) playFrom(bar); else { $('#p-pos').value = bar; $('#p-pos-n').textContent = bar; } };
  $('#p-fwd').onclick = () => { const bar = Math.min(project.bars, (play.kind === 'mine' && player.timer ? currentBar() : Number($('#p-pos').value)) + 4); if (play.kind === 'mine' && player.timer) playFrom(bar); else { $('#p-pos').value = bar; $('#p-pos-n').textContent = bar; } };
  let dragging = false;
  $('#p-pos').onpointerdown = () => { dragging = true; };
  $('#p-pos').oninput = (e) => { $('#p-pos-n').textContent = e.target.value; };
  $('#p-pos').onchange = (e) => { dragging = false; if (play.kind === 'mine' && player.timer) playFrom(Number(e.target.value)); };

  $('#p-export').onclick = () => {
    const b = summary();
    if (!b) return;
    download(safeName(project.name) + '.sf3song.json', JSON.stringify(Project.songFile(project, b, names)), 'application/json');
    status(`Exported ${project.name}: ${b.bytes.length} bytes of music data. A ROM build can install it (docs/ROM_GUIDE.md).`);
  };
  $('#project-save').onclick = () => { if (project) download(safeName(project.name) + '.sf3project.json', JSON.stringify({ format: 'sf3project', version: 1, names, project }), 'application/json'); };
  $('#p-wav').onclick = () => {
    const b = summary();
    if (!b) return;
    const ticks = Seq.LEAD_IN + (b.loop ? b.loop.end + (b.loop.end - b.loop.start) : project.bars * BAR) + 96;
    status('Rendering…');
    setTimeout(() => {
      download(safeName(project.name) + '.wav', renderOffline((e) => { e.patchSequence(b.bytes, PREVIEW_CODE, 0); e.request(PREVIEW_CODE); }, framesForTicks(ticks, Seq.bpmToTempo(project.bpm))), 'audio/wav');
      status(`Saved ${project.name} as a WAV file` + (b.loop ? ' (two passes of the loop).' : '.'));
    }, 20);
  };

  function openProject(p, where) {
    project = p;
    renderParts(); showTab('mine'); changed();
    status(where);
  }
  async function loadFile(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    try {
      if (/\.midi?$/i.test(file.name)) {
        const midi = Midi.parse(bytes);
        if (project && project.parts.length) {
          bringIn(file.name, midi);
          openProject(project, `Brought in ${file.name}: ${midi.parts.length} parts. The instruments are kept. Choose in "Notes from" which part each instrument plays. (Close song first to start from the MIDI file alone.)`);
        } else openProject(projectFromMidi(file.name, midi), `Imported ${file.name}: ${midi.parts.length} parts. Give each part an instrument, then press Play.`);
      } else {
        const j = JSON.parse(new TextDecoder().decode(bytes));
        if (!j.project) throw new Error('This file is not a music editor project.');
        if (j.names) { names = Object.assign({}, j.names, names); store.set('names', names); listPrograms(); }
        openProject(j.project, `Opened ${file.name}.`);
      }
    } catch (e) { status(e.message, true); }
  }
  $('#midi-file').onchange = (e) => { if (e.target.files[0]) loadFile(e.target.files[0]); e.target.value = ''; };
  $('#project-file').onchange = (e) => { if (e.target.files[0]) loadFile(e.target.files[0]); e.target.value = ''; };
  document.addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('drop'); });
  document.addEventListener('dragleave', () => document.body.classList.remove('drop'));
  document.addEventListener('drop', (e) => { e.preventDefault(); document.body.classList.remove('drop'); if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]); });
  $('#song-copy').onclick = () => { if (song) openProject(projectFromGame(song), `${song.name} copied. Changes of pitch bend and vibrato inside the original are not carried over.`); };

  /* arrangements made outside the page: style/library.js lists them in data/library.js */
  const library = window.SF3_LIBRARY || [];
  if (library.length) {
    const select = $('#library'), groups = new Map();
    library.forEach((item, i) => {
      if (!groups.has(item.folder)) { groups.set(item.folder, el('optgroup', { label: item.folder })); select.append(groups.get(item.folder)); }
      groups.get(item.folder).append(el('option', { value: i, textContent: `${item.name} · ${item.bars} bars · ${item.made}`, title: item.report }));
    });
    $('#library-row').hidden = false;
    $('#library-open').onclick = () => {
      const item = library[Number(select.value)];
      if (!item) return;
      if (item.names && Object.keys(item.names).length) { names = Object.assign({}, item.names, names); store.set('names', names); listPrograms(); }
      openProject(JSON.parse(JSON.stringify(item.project)), `Opened ${item.name} (${item.folder}, ${item.file}).` + (item.report ? ' ' + item.report.split('\n').slice(0, 2).join(' ') : ''));
    };
  }

  /* ---------------------------------------------------------------- start */
  $('#master').value = store.get('volume', 80);
  listPrograms();
  selectSong(data.songs.find((s) => s.code === store.get('song', 16)) || data.songs[0]);
  const first = data.banks[0].find(Boolean); if (first) selectInst(first);
  const saved = store.get('project', null);
  if (saved && saved.parts) { project = saved; }
  renderParts();
  showTab(store.get('tab', 'game'));
  status(`Ready: ${data.songs.length} pieces of music, ${data.samples.filter(Boolean).length} sounds, ${data.banks[0].filter(Boolean).length} music instruments, from your ${pack.rom} ROM.`);
  requestAnimationFrame(refresh);
  /* links: index.html#tab=sounds opens a tab, #copy=16 opens an editable copy of that music */
  const link = new URLSearchParams(location.hash.slice(1));
  if (link.get('copy')) { const s = data.songs.find((x) => x.code === Number(link.get('copy'))); if (s) openProject(projectFromGame(s), `${s.name} copied.`); }
  if (link.get('tab')) showTab(link.get('tab'));

  /* ---------------------------------------------------------------- self-test (#selftest, read with a headless browser's --dump-dom) */
  if (location.hash.startsWith('#selftest')) {
    const log = []; let failed = 0;
    const ok = (cond, what) => { log.push((cond ? 'ok   ' : 'FAIL ') + what); if (!cond) failed++; };
    try {
      ok(data.songs.length === 49 && $$('#songs .item').length === 49, '49 pieces of music listed');
      ok(data.samples.filter(Boolean).length === 733, '733 samples');
      ok($$('#programs .item').length === 59, '59 music instruments listed');
      let same = 0;
      for (const s of data.songs) { const again = Seq.compile(Seq.decompile(s.bytes)); if (again.length === s.bytes.length && again.every((b, i) => b === s.bytes[i])) same++; }
      ok(same === 49, 'all music converts to events and back to the same bytes');
      const chun = data.songs.find((s) => s.code === 16);
      const midi = Midi.parse(songMidi(chun));
      ok(midi.parts.length === info(chun).tracks.filter((t) => t.notes).length && Math.abs(midi.tempo[0].bpm - 135) < 0.2, `MIDI written and read back (${midi.parts.length} parts)`);
      const fromMidi = projectFromMidi('test.mid', midi);
      ok(fromMidi.parts.length === midi.parts.length && fromMidi.bars >= 24, 'a project is made from MIDI');
      project = projectFromGame(chun); renderParts();
      const b = build();
      ok(b.report.tracks.length === info(chun).tracks.filter((t) => t.notes).length && b.report.dropped === 0, `Chun-Li's theme copied: ${b.report.tracks.length} tracks, ${b.bytes.length} bytes`);
      ok($$('#parts tr').length === project.parts.length + 1, 'parts table drawn');
      const side = new Engine(pack); side.keyOns = [];
      side.patchSequence(b.bytes, PREVIEW_CODE, 0); side.request(PREVIEW_CODE);
      const orig = new Engine(pack); orig.keyOns = []; orig.request(16);
      for (let f = 0; f < 1500; f++) { side.step(); orig.step(); }
      const ratio = side.keyOns.length / orig.keyOns.length;
      ok(ratio > 0.97 && ratio < 1.03, `the copy plays ${side.keyOns.length} notes in 25 s, the original ${orig.keyOns.length}`);
      ok(Math.abs(side.tempo() - orig.tempo()) <= 1, 'the copy keeps the tempo');
      const audio = orig.render(120); let peak = 0; for (const v of audio) peak = Math.max(peak, Math.abs(v));
      ok(peak > 0.05 && peak <= 1, `audio renders (peak ${peak.toFixed(2)})`);
      /* the buttons: play game music, lift the key on the ticked tracks, play the project, stop */
      selectSong(chun); playSong();
      ok(engine.frame >= 4 && play.kind === 'game' && player.timer && !$('#status').classList.contains('bad'), `Play starts the audio pump (${engine.frame} driver frames mixed)`);
      $('#lift-when').value = 'now'; $('#lift-what').value = 'tracks'; $('#lift').click();
      ok(lift.tracks.length > 0 && engine.transpose(lift.tracks[0]) === 1, `key lift moves ${lift.tracks.length} ticked tracks up a semitone`);
      $('#lift-reset').click();
      ok(lift.tracks.length === 0 && engine.transpose(4) === 0, 'and back');
      $('#lift-what').value = 'all'; $('#lift').click();
      ok(engine.r16(0x02079C0C) === 256 && Math.abs(engine.tempo() / 464 - Math.pow(2, 1 / 12)) < 0.003, 'lifting everything sets the driver\'s music pitch and raises the tempo to match');
      $('#lift-reset').click();
      playProject();
      ok(engine.frame >= 4 && play.kind === 'mine' && !$('#status').classList.contains('bad'), 'the project plays through the audio pump');
      stopAll();
      ok(!player.timer && play.kind === null, 'Stop stops');
      /* a MIDI file brought into the copied song: instruments kept, notes assigned one part at a time */
      const band = project.parts.map((p) => p.bank + ':' + p.program).join(',');
      bringIn('other.mid', midi); renderParts();
      ok(project.parts.every((p) => !p.notes.length) && project.parts.map((p) => p.bank + ':' + p.program).join(',') === band && project.sources.length === midi.parts.length, 'bringing in MIDI keeps the instruments and clears their notes');
      takeNotes(project.parts[4], 4); project.parts[4].transpose = 24; renderParts();
      const fit = rangeCheck(project.parts[4]);
      ok(project.parts[4].notes.length === midi.parts[4].notes.length && fit.outside > 0 && fit.suggest === 0, `a part two octaves too high is flagged (${fit.text}) and Fit offers the right octave`);
      ok(build().report.tracks.length === 1 && $$('#parts tr').length === project.parts.length + 1, 'the song builds with the one assigned part');
      {
        const count = project.parts.length, src = project.parts[4], tracksBefore = build().report.tracks.length;
        duplicatePart(4);
        const copy = project.parts[5];
        copy.transpose = 12; copy.notes[0].n += 1;
        ok(project.parts.length === count + 1 && copy.notes.length === src.notes.length && copy.program === src.program && src.transpose === 24 && src.notes[0].n === copy.notes[0].n - 1 &&
           build().report.tracks.length === tracksBefore + copy.voices && $$('#parts tr').length === project.parts.length + 1,
           'Copy duplicates a part just below it, with its own notes and settings, and the song gets its tracks');
      }
      /* every arrangement in data/library.js opens from the list and builds to its song file's bytes */
      if (library.length) {
        let same = 0, compared = 0;
        library.forEach((item, i) => {
          $('#library').value = i; $('#library-open').click();
          if (!item.sequence) return;
          compared++;
          const want = Engine.b64bytes ? Engine.b64bytes(item.sequence) : Uint8Array.from(atob(item.sequence), (c) => c.charCodeAt(0));
          const got = build().bytes;
          if (got.length === want.length && got.every((x, k) => x === want[k])) same++;
        });
        ok(!$('#library-row').hidden && same === compared && compared > 0, `the ${library.length} listed arrangements open; ${same} of ${compared} rebuild to their song file's exact bytes`);
      }
      /* playing My song from a bar: the same driver state as playing straight through to it */
      project = projectFromGame(chun); renderParts(); stopAll();
      const straight = (bar) => {
        const x = new Engine(pack), bytes = playBuild().bytes, target = Seq.LEAD_IN + (bar - 1) * BAR;
        x.patchSequence(bytes, PREVIEW_CODE, 0); x.request(PREVIEW_CODE);
        let ticks = 0;
        while (ticks < target) { const n = x.tick(); x.chip(n); ticks += (x.tempo() + x.tempoOffsetValue()) / 256; }
        return x;
      };
      const sameState = (x) => x.ram.every((v, i) => v === engine.ram[i]) && x.regs.every((v, i) => v === engine.regs[i]) && x.pos.every((v, i) => v === engine.pos[i]) && x.key === engine.key;
      live.bytes = null;
      playFrom(9, true);
      const there = straight(9);
      ok(sameState(there) && live.snaps.size >= 2, `jumping to bar 9 gives the driver state of playing straight there (${live.snaps.size} saved positions on the way)`);
      playFrom(13, true);
      ok(sameState(straight(13)), 'jumping on to bar 13 from a saved position gives the same state as playing straight there');
      playFrom(9, true);
      ok(sameState(there), 'jumping back to bar 9 from a saved position, too');
      /* while it plays: a volume change is heard at once and written into the song; mute is instant */
      playFrom(1); for (let f = 0; f < 3; f++) player.pump();
      const p0 = project.parts[0], tracks0 = live.partTracks[0];
      p0.volume = (p0.volume + 7) & 127;
      const how = applyLive();
      const wantBytes = playBuild().bytes, at = live.at - ROM_BASE;
      ok(how === 'live' && tracks0.every((t) => engine.r8(CHANNELS + t * CHANNEL_SIZE + 98) === p0.volume) && wantBytes.every((x, i) => engine.rom[at + i] === x),
         `a volume change while playing goes into the driver's track record and the running song (tracks ${tracks0.map((t) => t + 1).join(', ')})`);
      p0.mute = true; applyLive();
      ok(tracks0.every((t) => engine.mute & (1 << t)), 'muting a part while playing silences its tracks at once');
      p0.mute = false; applyLive();
      ok(player.levels.some((l) => l.peaks.some((v) => v > 0)), 'the level meters receive the voices\' levels');
      stopAll();
      project = saved && saved.parts ? saved : null; renderParts();
    } catch (e) { ok(false, 'exception: ' + e.message); }
    log.push(`selftest: ${log.length} checks, ${failed} failures`);
    document.body.append(el('pre', { id: 'selftest', textContent: log.join('\n') }));
  }
})();
