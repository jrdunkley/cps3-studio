/* CPS3 Studio · Game: the game itself, exact, from the user's own ROM (plan step 3, Play; §4b B1 starts).
 * Canvas at integer scale, two players on keyboard or pads, pause, frame step, 1/4 to 4x, rewind, save
 * slots, sound. It opens at the ready start (start.js: the black screen before character select, both players
 * in), made from power-on by its recipe and cached per image; Power on stays in the menu. Slots are kept per
 * image; scenarios (inputs from the ready start) save to and open from small ROM-free files.
 * window.GameStudio is the page's handle for its own browser gate (checks/g_play.js). */
(function (g) {
  'use strict';
  const K = g.Kit, el = K.el, $ = (id) => document.getElementById(id);
  const S = g.GameStudio = { game: null, rom: null, source: null, frame: 0, ready: false, shown: 0, fps: 0, scale: 0, ids: null, at: null, start: null, image: null };
  const SPEEDS = [0.25, 0.5, 1, 2, 4], SLICE4 = 4 * 104166;
  let canvas, ctx, image, queue = [], frames = [], speedSeg = null, wasPlaying = false;

  /* ---- the ROM's own pieces ---- */
  async function bios(s) {
    let member = await CPS3Studio.loadBios(s);
    if (!member) {
      const zips = await Cps3Rom.restoreZips(K.store(s.store));
      for (const bytes of Object.values(zips || {})) { const m = await KitZip.read(bytes, { only: (n) => n.endsWith(Cps3GameRom.BIOS_MEMBER) }); member = Object.values(m)[0]; if (member) break; }
      if (!member) throw new Error('The BIOS (sfiii3_japan_nocd.29f400.u2 in sfiii3nr1.zip) is not saved. Choose the game files again from the Game menu (Game files…).');
      await K.store(s.store).set('bios', { program: s.program, member });
    }
    return Cps3GameRom.bios({ [Cps3GameRom.BIOS_MEMBER]: member });
  }
  /* Original: a blank settings chip (the game writes its factory settings) or the same with free play, as its own menu sets it.
     A source with modes: the mode's settings block from its files, else the factory block with the mode bytes (its files are exactly that). */
  async function settings(s) {
    const free = K.pref('game.freePlay', true);
    if (!s.modes || s.mode === null) return { freePlay: free };
    const modes = await CPS3Studio.loadSettings(s), block = modes && modes[s.mode];
    return block ? { eeprom: block, freePlay: free } : { freePlay: free, mode: s.mode, modeOffsets: s.modeOffsets };
  }

  /* ---- screen ---- */
  /* The arcade monitor shows the 384 x 224 picture at 4:3 (FBNeo: BurnDrvSetAspect(4, 3)): its pixels are narrower than
     tall. The height is a whole multiple of 224 and the width follows at 4:3. The picture is enlarged with whole pixels
     first (sharp rows), then narrowed to 4:3 with smoothing across, so columns stay even. Settings → Square pixels
     shows it as stored instead. */
  let src = null, big = null;
  function fit() {
    const ws = $('workspace'), want = K.pref('game.scale', 0), square = K.pref('game.square', false), w1 = square ? 384 : 224 * 4 / 3;
    const banner = ws.querySelector('.game-try'), top = banner ? banner.offsetHeight : 0; ws.style.setProperty('--try-h', top + 'px');
    const most = Math.max(1, Math.floor(Math.min((ws.clientWidth - 16) / w1, (ws.clientHeight - 16 - top) / 224)));
    S.scale = want ? Math.min(want, most) : most;
    const cssW = Math.round(w1 * S.scale), cssH = 224 * S.scale, dpr = window.devicePixelRatio || 1;
    canvas.style.width = cssW + 'px'; canvas.style.height = cssH + 'px';
    canvas.width = Math.round(cssW * dpr); canvas.height = Math.round(cssH * dpr);
    const k = Math.max(1, Math.ceil(canvas.height / 224));
    big = el('canvas', { width: 384 * k, height: 224 * k });
    paint();
  }
  function paint() {
    const b = big.getContext('2d'); b.imageSmoothingEnabled = false; b.drawImage(src, 0, 0, big.width, big.height);
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high'; ctx.drawImage(big, 0, 0, canvas.width, canvas.height);
  }
  /* Present the picture whose sound is playing. Discard only already-due pictures when the page falls behind. */
  function draw() {
    let due=0;while(due<queue.length&&S.game.frameDue(queue[due]))due++;
    if(due>2)for(const old of queue.splice(0,due-1))S.game.releaseFrame(old);
    const p = queue.length&&S.game.frameDue(queue[0])?queue.shift():null;
    if (p) { image.data.set(p.rgba); src.getContext('2d').putImageData(image, 0, 0); paint(); S.frame = p.frame; S.shown++; frames.push(performance.now()); renderReadout(p);S.game.releaseFrame(p); }
    requestAnimationFrame(draw);
  }
  S.flushPicture=()=>{for(const old of queue.splice(0,Math.max(0,queue.length-1)))S.game.releaseFrame(old);};
  function renderReadout(p) {
    $('frame').textContent = p.frame; const sec = Math.floor(p.frame / 59.59949); $('time').textContent = Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
    const m = p.meters; if (m) {$('cpu').textContent = Math.round(100 * m.busyCycles / SLICE4) + '%';g.GameResources?.update(m);}
    const now = performance.now(); while (frames.length && frames[0] < now - 1000) frames.shift(); S.fps = frames.length; $('fps').textContent = S.game && S.game.playing ? frames.length + ' fps' : 'paused';
  }

  /* ---- actions ---- */
  function action(id, title, hint, keys, run, icon) { K.action({ id: 'game.' + id, title, hint, keys, icon, group: 'Game', enabled: () => S.ready, run }); }
  async function togglePlay() { if (S.game.playing) await S.game.pause(); else { await S.game.play(); ensureSound(); } $('play').classList.toggle('on', S.game.playing); $('play').replaceChildren(K.icon(S.game.playing ? 'pause' : 'play')); }
  async function back(seconds) {
    wasPlaying = S.game.playing; if (wasPlaying) await S.game.pause();
    try { await S.game.rewind(Math.round(seconds * 59.59949)); } catch (e) { K.status(e.message); }
    if (wasPlaying) await S.game.play();
  }
  /* Slots are kept per image (program + graphics/sound hashes): what a moment holds in RAM and character RAM
     came from its image. A small index (a preference) lists every slot without reading the snapshots. */
  function slotKey(n, image = S.image) { return `${image.key}:${n}`; }
  const slotIndex = () => K.pref('game.slotIndex', null) || {};
  async function saveSlot(n) {
    const v = await S.game.save();
    await K.store('game.slots').set(slotKey(n), { bytes: v.bytes, inspection:v.inspection, frame: v.frame, at: Date.now(), image: S.image.key, label: S.image.label, digest: Cps3GameWasm.digest });
    K.pref.set('game.slotIndex', Object.assign(slotIndex(), { [slotKey(n)]: { n, frame: v.frame, at: Date.now(), image: S.image.key, label: S.image.label, source: S.source.id } }));
    K.toast(`Saved to slot ${n} · frame ${v.frame}.`, { kind: 'good' });
  }
  async function loadSlot(n, key = slotKey(n)) {
    const v = await K.store('game.slots').get(key);
    if (!v) { K.toast(`Slot ${n} is empty for this game.`, { kind: 'warn' }); return; }
    const other = v.image && v.image !== S.image.key;
    if (other) {
      const go = await K.dialog({ title: 'A moment from another image', text: `This slot was saved with ${v.label || 'another image'}. What is already in memory in it (main RAM and character RAM) holds data that image copied from its ROM; from here on the program and graphics are ${S.image.label}. The result can differ from both.`,
        buttons: [{ label: 'Cancel', value: false, ghost: true }, { label: 'Load anyway', value: true, primary: true }] });
      if (!go) return;
    }
    await S.game.load(v.bytes,other?null:v.inspection); S.at = 'slot'; S.scenarioFrom = null;
    K.toast(`Loaded slot ${n} · frame ${v.frame}${other ? ' (saved with ' + (v.label || 'another image') + ')' : ''}.`, { kind: other ? 'warn' : 'good' });
  }
  async function slotsMenu(anchor) {
    const rows = [], idx = slotIndex();
    for (let n = 1; n <= 4; n++) rows.push({ n, v: idx[slotKey(n)] || await K.store('game.slots').get(slotKey(n)) });
    const others = Object.entries(idx).filter(([, v]) => v.image !== S.image.key && v.source === S.source.id).sort((a, b) => b[1].at - a[1].at).slice(0, 8);
    K.menu(anchor, [{ heading: 'Save' }, ...rows.map(({ n, v }) => ({ label: `Save to slot ${n}${v ? ' (replaces frame ' + v.frame + ')' : ''}`, icon: 'save', run: () => saveSlot(n) })),
      '-', { heading: 'Load' }, ...rows.map(({ n, v }) => ({ label: v ? `Slot ${n} · frame ${v.frame}` : `Slot ${n} · empty`, disabled: !v, icon: 'folder', run: () => loadSlot(n) })),
      ...(others.length ? ['-', { heading: 'Saved with other images' }, ...others.map(([k, v]) => ({ label: `${v.label} · slot ${v.n} · frame ${v.frame}`, icon: 'folder', run: () => loadSlot(v.n, k) }))] : [])]);
  }
  let soundAsked = false;
  function ensureSound() { if (soundAsked || !K.pref('game.sound', true)) return; soundAsked = true; S.game.sound(true).catch((e) => K.status('Sound is unavailable: ' + e.message)); }
  async function toggleSound() { const on = !K.pref('game.sound', true); K.pref.set('game.sound', on); soundAsked = on; await S.game.sound(on); paintSound(); }
  function paintSound() { $('sound').replaceChildren(K.icon(K.pref('game.sound', true) ? 'speaker' : 'mono')); $('sound').classList.toggle('on', K.pref('game.sound', true)); }
  async function powerOn() {
    const was = S.game.playing; if (was) await S.game.pause();
    await S.game.coldBoot(await settings(S.source)); S.at = 'power-on'; S.scenarioFrom = 0; if (was) await S.game.play();
    K.status('Powered on again.');
  }

  /* ---- starts (plan §4b B1) ---- */
  const sha = (bytes) => Cps3Rom.sha256(bytes);
  async function settingsId(st) { return (st.eeprom ? await sha(st.eeprom) : 'factory') + ':free' + (st.freePlay ? 1 : 0) + ':mode' + (st.mode == null ? '-' : st.mode); }
  /* cached starts in the browser (each about 12 MB); the newest few are kept, listed in a small preference */
  const STARTS_KEPT = 6;
  const startCache = {
    get: (k) => K.store('game.starts').get(k),
    async set(k, v) {
      const st = K.store('game.starts'), idx = Object.assign(K.pref('game.startIndex', null) || {}, { [k]: Date.now() });
      await st.set(k, v);
      for (const old of Object.keys(idx).sort((a, b) => idx[b] - idx[a]).slice(STARTS_KEPT)) { await st.del(old); delete idx[old]; }
      K.pref.set('game.startIndex', idx);
    },
  };
  /* to the ready start of the images in use; falls back to power-on (saying why) when its facts do not hold */
  async function goReady(quiet) {
    const st = await settings(S.source);
    const key = Cps3GameStart.key({ digest: Cps3GameWasm.digest, program: S.ids.program, data: S.ids.data, bios: S.ids.bios, eeprom: await settingsId(st) });
    const r = await S.game.readyStart(Object.assign({}, st, { key, cache: startCache }));
    S.lastStart = Object.assign({ key }, r);
    if (!r.facts.ok) {
      await S.game.coldBoot(st); S.at = 'power-on'; S.scenarioFrom = 0;
      K.status(`Powered on instead: the ready start did not hold (${r.facts.why.join('; ')}). It needs free play (⚙ Settings).`);
      return r;
    }
    S.at = 'ready-select'; S.start = { key, frame: r.frame, state: r.state }; S.scenarioFrom = r.frame;
    if (!quiet) K.status(`Ready at character select · ${r.cached ? 'from this computer’s cache' : 'made from power-on'} in ${Math.round(r.totalMs)} ms.`);
    return r;
  }
  async function toReady() { const was = S.game.playing; if (was) await S.game.pause(); await goReady(false); if (was) await S.game.play(); }

  /* ---- scenarios: the inputs from the ready start, as a small ROM-free file ---- */
  async function saveScenario() {
    if (S.at !== 'ready-select' || S.scenarioFrom == null) { K.toast('A scenario starts at the ready start: use “Back to character select” first, then play.', { kind: 'warn' }); return; }
    const was = S.game.playing; if (was) await S.game.pause();
    const inputs = await S.game.call('inputLog', { from: S.scenarioFrom, to: S.game.frame }), h = await S.game.hash();
    const file = Cps3GameStart.scenario({ start: 'ready-select', source: S.source.id, mode: S.source.mode, images: { ...S.ids, eeprom: await sha(Uint8Array.from(await S.game.call('eeprom'))) }, inputs, checks: [{ at: inputs.length, state: h.state }] });
    K.download(`scenario_${inputs.length}_frames.cps3scenario.json`, JSON.stringify(file), 'application/json');
    K.toast(`Scenario saved: ${inputs.length} frames from the ready start.`, { kind: 'good' });
    S.lastScenarioFile = file;
    if (was) await S.game.play();
    return file;
  }
  async function runScenario(s) {
    s = CPS3Scenarios.validate(s);
    CPS3Scenarios.assertIdentity({...s,images:null},{source:S.source.id,mode:S.source.mode});
    const was = S.game.playing; if (was) await S.game.pause();
    if (s.start === 'power-on') await powerOn(); else { const r = await goReady(true); if (!r.facts.ok) return { ok: false, why: r.facts.why }; }
    CPS3Scenarios.assertIdentity(s,{source:S.source.id,mode:S.source.mode,images:{...S.ids,eeprom:await sha(Uint8Array.from(await S.game.call('eeprom')))},legacyEeprom:await settingsId(await settings(S.source))});
    const result = await S.game.scenario(s), last = (s.checks || []).find(c => c.at === result.frames && c.state);
    const out = { ...result, expected: last?.state || null, equal: result.passed, sameImages: true };
    K.toast(`Scenario replayed: ${result.frames} frames, ${result.checksExecuted} checks ${result.passed ? 'passed' : 'failed'}.`, { kind: result.passed ? 'good' : 'warn' });
    S.lastScenario = out;
    return out;
  }
  async function openScenario() {
    const f = await K.pickFile('.json'); if (!f) return;
    try { await runScenario(Cps3GameStart.parse(new TextDecoder().decode(await K.readFile(f)))); } catch (e) { K.toast(e.message, { kind: 'bad' }); }
  }
  S.runScenario = runScenario; S.goReady = goReady; S.saveScenario = saveScenario;S.legacySettingsIdentity=async()=>settingsId(await settings(S.source));
  function serviceButton(name, label) { return { label, run: async () => { GameControls.press('sys.' + name, true); await new Promise((r) => setTimeout(r, 120)); GameControls.press('sys.' + name, false); } }; }
  function settingsDialog() {
    const free = el('button.switch', { class: K.pref('game.freePlay', true) ? 'on' : '', role: 'switch', 'aria-label': 'Free play', onclick: () => { const v = !K.pref('game.freePlay', true); K.pref.set('game.freePlay', v); free.classList.toggle('on', v); K.status('Free play applies at the next power-on.'); } });
    const scale = el('div'); K.seg(scale, [{ value: 0, label: 'Fit' }, { value: 1, label: '1×' }, { value: 2, label: '2×' }, { value: 3, label: '3×' }], (v) => { K.pref.set('game.scale', v); fit(); }, { value: K.pref('game.scale', 0) });
    const shape = el('div'); K.seg(shape, [{ value: false, label: 'Arcade 4:3', tip: 'Arcade 4:3|The shape the arcade monitor shows: pixels narrower than tall.' }, { value: true, label: 'Square pixels', tip: 'Square pixels|The picture as stored, 384 x 224.' }], (v) => { K.pref.set('game.square', v); fit(); }, { value: K.pref('game.square', false) });
    const audioBuffer=el('select.field',{'aria-label':'Audio buffer',onchange:async()=>{const n=Number(audioBuffer.value);await S.game.audioBuffer(n);K.pref.set('game.audioBufferFrames',n);}},...[2,6,12,16].map(n=>el('option',{value:n,selected:n===K.pref('game.audioBufferFrames',12)},`${n} frames (about ${Math.round(n*1000/59.59949)} ms)`)));
    const keys = el('div.game-keys', null, el('span.head', null, 'Control'), el('span.head', null, 'Player 1'), el('span.head', null, 'Player 2'),
      ...GameControls.ORDER.flatMap((c) => [el('span', null, GameControls.NAMES[c]), ...['p1', 'p2'].map((who) => el('button.btn', { 'data-tip': `${GameControls.NAMES[c]}|Press to change, then press the new key.`, onclick: (e) => rebind(e.currentTarget, who, c) }, el('kbd', null, GameControls.label(GameControls.keyOf(who, c)))))]));
    function rebind(button, who, c) { button.replaceChildren(el('kbd', null, '…')); const f = (e) => { e.preventDefault(); e.stopPropagation(); window.removeEventListener('keydown', f, true); GameControls.setKey(who, c, e.code); button.replaceChildren(el('kbd', null, GameControls.label(e.code))); }; window.addEventListener('keydown', f, true); }
    return K.dialog({ title: 'Game · Settings', width: 560, body: el('div.vbox', null,
      el('h3', null, 'Settings chip'), el('label.lab', null, el('span', null, 'Free play'), free),
      el('p.hint', null, 'Free play is what the game’s own service menu sets (coin setting → FREE PLAY). It lives in this computer’s emulation only and is never written to a ROM.'),
      el('h3', null, 'Picture'), shape, scale,
      el('h3',null,'Sound'),el('label.lab',null,el('span',null,'Audio buffer'),audioBuffer),el('p.hint',null,'A larger buffer covers browser pauses and adds input latency. Picture and sound use the same playhead. The default is 12 frames.'),
      el('h3', null, 'Controls'), keys, el('p.hint', null, 'Gamepads: X light punch, Y medium punch, RB heavy punch, A light kick, B medium kick, RT heavy kick; Back is coin, Start is start. The first pad is player 1.'),
      el('div.hbox', null, el('button.btn', { onclick: () => { GameControls.resetKeys(); K.status('Keys reset to the defaults.'); } }, 'Default keys'))) });
  }

  /* ---- Try in game (plan §4b B2): images handed over by Art or Music through CPS3Studio.game.tryImages ---- */
  async function tryRecord() {
    if (!/[?&]try=/.test(location.search)) return null;
    const rec = await K.store('game.try').get('latest').catch(() => null);
    if (!rec || rec.source !== CPS3Studio.source().id) { K.toast('Nothing to try: open Try in game from Art or Music again.', { kind: 'warn' }); return null; }
    return rec;
  }
  function tryBanner(rec) {
    const back = rec.from ? el('a.btn', { href: rec.from, 'data-tip': 'Back|Return to the page you came from.' }, '← Back') : null;
    return el('div.game-try', null, el('span.tag', null, 'Trying'), el('b', null, rec.label), el('span.hint', null, (rec.hint ? rec.hint + ' ' : '') + 'In the Studio only: nothing is written to the ROM or to disk.'), el('span.grow'), back);
  }
  async function land(rec) {
    const l = rec.landing || { type: 'ready' };
    if (l.type === 'scenario' && l.scenario) {
      const sc = Cps3GameStart.parse(l.scenario), list = Cps3GameStart.unrle(sc.inputs);
      for (let i = 0; i < list.length; i += 600) await S.game.run({ inputs: list.slice(i, i + 600), render: i + 600 >= list.length ? 'last' : false });
    } else if (l.type === 'sound-test' && l.code >= 0) {                 /* the game's own sound test, from the ready start */
      await S.game.run({ inputs: Cps3GameStart.soundTestRoute(l.code), render: 'last' }); S.at = 'sound-test';
    } else if (l.type === 'state' && l.raw) {
      await S.game.loadFbneo(l.raw); S.at = 'state'; S.scenarioFrom = null;
      if (l.inputs && l.inputs.length) await S.game.run({ inputs: l.inputs, render: 'last' });
    }
    if (l.note) K.status(l.note);
  }

  async function boot(rom) {
    S.rom = rom; S.source = CPS3Studio.source();
    const rec = S.tryRec = await tryRecord();
    $('source-tag').textContent = CPS3Studio.sourceLabel(S.source) + (rec ? ' · trying' : '');
    const ws = $('workspace');
    K.status('Starting the machine…');
    canvas = el('canvas.game-screen', { width: 384, height: 224, tabindex: 0, 'aria-label': 'The game' }); ctx = canvas.getContext('2d');
    src = el('canvas', { width: 384, height: 224 }); image = src.getContext('2d').createImageData(384, 224);
    ws.replaceChildren(...(rec ? [tryBanner(rec)] : []), el('div.game-stage', null, canvas));
    fit(); window.addEventListener('resize', fit);
    const program = rec ? rec.program : rom.program, data = rec && rec.data ? rec.data : rom.data;
    S.game = await Cps3Game.create({ program, bios: await bios(S.source), data, audioBufferFrames:K.pref('game.audioBufferFrames',12) });
    S.game.onFrame = (p) => { queue.push(p); };
    S.game.onFault = (m) => { K.toast(`The machine stopped at frame ${m.frame} (CPU fault ${m.fault}).`, { kind: 'bad' }); $('play').replaceChildren(K.icon('play')); };
    GameControls.attach((w) => S.game.input(w));
    S.ids = { program: rec ? await sha(program) : rom.sha256, data: rec && rec.data ? await sha(data) : rom.dataSha256 || (rom.dataSha256 = await sha(rom.data)), bios: await sha(await bios(S.source)) };
    S.image = { key: `${S.source.id}:${S.ids.program.slice(0, 16)}:${S.ids.data.slice(0, 16)}`, label: rec ? rec.label : CPS3Studio.sourceLabel(S.source) };
    if (/[#&?]poweron\b/.test(location.href)) { await S.game.coldBoot(await settings(S.source)); S.at = 'power-on'; S.scenarioFrom = 0; }
    else await goReady(true);
    if (rec) await land(rec);
    requestAnimationFrame(draw);
    S.ready = true; K.refresh(true);
    if (!location.hash.includes('paused')) { await togglePlay(); if (rec && rec.landing && rec.landing.sound) ensureSound(); }
    canvas.focus();
    const where = rec ? `Trying ${rec.label}${rec.landing && rec.landing.note ? ' · ' + rec.landing.note : ''}` : `${S.at === 'ready-select' ? 'Ready at character select' : 'Powered on'} · ${CPS3Studio.sourceLabel(S.source)}`;
    K.status(`${where}. P1: WASD + U I O / J K L, 1 start, 5 coin · P2: arrows + numpad, 2 start, 6 coin.`);
  }

  async function start() {
    action('play', 'Play / pause', 'Run or stop the game.', 'Space', togglePlay, 'play');
    action('step', 'Next frame', 'Run one frame while paused.', '.', async () => { if (S.game.playing) await togglePlay(); await S.game.step(1); }, 'right');
    action('back', 'Back 5 seconds', 'Rewind five seconds through the kept moments.', 'Backspace', () => back(5), 'start');
    action('save1', 'Quick save', 'Save this moment to slot 1.', 'Ctrl S', () => saveSlot(1), 'save');
    action('load1', 'Quick load', 'Load slot 1.', 'Ctrl O', () => loadSlot(1), 'folder');
    action('ready', 'Back to character select', 'Restart at the ready start: the black screen just before character select, both players in.', 'Home', toReady, 'start');
    action('power', 'Power on again', 'Restart the machine from power-on with the current settings.', '', powerOn, 'start');
    action('scenario.save', 'Save scenario…', 'Save the inputs played since the ready start as a small file (no ROM data) that replays exactly.', '', saveScenario, 'save');
    action('scenario.open', 'Open scenario…', 'Replay a scenario file from the ready start of this game.', '', openScenario, 'folder');
    action('test', 'Service menu (test button)', 'Press the board’s test button: the game opens its own service menu.', '', () => serviceButton('test').run());
    action('service', 'Service coin', 'Press the board’s service button: one credit.', '', () => serviceButton('service').run());
    document.querySelectorAll('[data-action]').forEach((b) => K.bind(b, b.dataset.action));
    document.querySelector('[data-action="palette.open"]').prepend(K.icon('search')); $('settings').append(K.icon('settings')); $('settings').onclick = settingsDialog;
    $('slots').onclick = (e) => slotsMenu(e.currentTarget); $('sound').onclick = toggleSound; paintSound();
    speedSeg = K.seg($('speed'), SPEEDS.map((v) => ({ value: v, label: v < 1 ? (v === 0.25 ? '¼' : '½') : v + '×', tip: `Speed ${v}×|Run the game at ${v} times normal speed. Sound plays at 1× only.` })), (v) => S.game && S.game.speed(v), { value: 1 });
    document.addEventListener('pointerover', (e) => { const tip = e.target.closest('[data-tip]'); if (tip) K.status(tip.dataset.tip.replace(/\|/g, ' · ')); });
    window.addEventListener('pointerdown', () => S.ready && ensureSound(), { once: false });
    window.addEventListener('keydown', () => S.ready && ensureSound());
    CPS3Studio.register({ id: 'game_editor', title: 'Game', icon: 'game', sources: ['original', 'infinite', 'infinite104', 'infinite107', 'infinite1071', 'infinite107b'], graphics: true,
      async mount() { const rom = await CPS3Studio.loadRom({ graphics: true }); if (rom) await boot(rom); else CPS3Studio.welcome($('workspace'), boot); },
      unmount() { if (S.game) S.game.destroy(); } });
    CPS3Studio.mount($('studio-app'));
    await CPS3Studio.activate('game_editor');
  }
  document.addEventListener('DOMContentLoaded', () => start().catch((e) => { K.status(e.message); K.toast(e.message, { kind: 'bad' }); S.error = e.message; }));
})(window);
