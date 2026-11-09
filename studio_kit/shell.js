/* Shared Studio frame and local-only ROM import. Modules provide their own workspaces.
 * Where the game comes from: the original game (Fightcade's sfiii3nr1.zip + sfiii3.zip) is built in; a page
 * that knows another source registers it as plain data (CPS3Studio.addSource: title, the SHA-256 of its
 * decrypted program, its store names, modes, folder layout), remembered in a preference so every module
 * page offers and honours it. A set is recognised by its program's SHA-256. Each source keeps its own
 * browser store, so switching never mixes images, sounds or settings. A module lists the sources it is
 * proven on (register({ sources })); the default is the original only, and on another source the Studio
 * says so instead of computing.
 * Opened through the local Studio (cps3_studio/launch.py), the page never asks for files the computer holds: the
 * server finds Fightcade's ROMs, the Infinite client's prepared ROMs and folders the person chose before
 * (cps3_studio/rom_finder.py), and loadRom reads the set that is the chosen game from there. */
(function (g) {
  'use strict';
  const K = g.Kit, el = K.el;
  const ORIGINAL = { id: 'original', title: 'Original game', short: 'Original', store: 'rom', pack: 'music',
    program: '35ac2d569893926599b0f68d772e98f412573fb76b305ba3ed910f6136dd2de0', about: 'Street Fighter III 3rd Strike · Japan 990512 NO CD (rev 1)',
    hint: 'The original game: drop sfiii3nr1.zip and sfiii3.zip here, or choose Fightcade’s ROMs folder.' };
  const registry = () => {
    const saved = K.pref('studio.sources', null) || {}, builtins = g.CPS3Sources?.list || [ORIGINAL], out = { ...saved };
    for (const s of builtins) out[s.id] = { ...saved[s.id], ...s };
    return out;
  };
  const BIOS_MEMBER = 'sfiii3_japan_nocd.29f400.u2';
  const shell = g.CPS3Studio = { modules: new Map(), rom: null, pack: null, active: null, departures: [],
    register(spec) { shell.modules.set(spec.id, spec); if (shell.rail) drawRail(); },
    /* Work that must finish before the page is left (a pending save). Navigation waits up to 3 s. */
    leaving(fn) { shell.departures.push(fn); return () => { shell.departures = shell.departures.filter(f => f !== fn); }; },
    async flush() { await Promise.race([Promise.all(shell.departures.map(f => Promise.resolve().then(f).catch(() => {}))), new Promise(r => setTimeout(r, 3000))]); },
    mount(root, options = {}) {
      shell.root = root; shell.rail = el('nav.module-rail', { hidden: true, 'aria-label': 'Studio modules' }); root.prepend(shell.rail); drawRail();
      const bar = root.querySelector('.topbar'); if (bar && !bar.querySelector('[data-studio-modes]')) bar.querySelector('.brand').after(shell.modeSwitch());
      if (!options.characterProject) {
        if (bar && !bar.querySelector('[data-studio-file]')) bar.querySelector('[data-studio-modes]').after(shell.fileButton());
        g.CPS3Workspace?.mount(root);
      }
      return shell;
    },
    modeSwitch() {
      const art = /\/art_editor\//.test(location.pathname), game = /\/game_editor\//.test(location.pathname), moves = /\/move_editor\//.test(location.pathname);
      const list = [{ title: 'Music', href: '../music_editor/index.html', active: !art && !game && !moves }, { title: 'Art', href: '../art_editor/index.html', active: art }];
      list.push({ title: 'Moves', href: '../move_editor/index.html', active: moves });
      list.push({ title: 'Game', href: '../game_editor/index.html', active: game });
      return el('nav.seg', { 'aria-label': 'Studio mode', 'data-studio-modes': '' },
        ...list.map(m => el('a.btn' + (m.active ? '.on' : ''), { href: m.href, 'aria-current': m.active ? 'page' : 'false', 'data-tip': m.title + '|Open ' + m.title + '.',
          onclick: e => { if (m.active || e.button || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return; e.preventDefault(); shell.navigate(m.href); } }, m.title)));
    },
    async navigate(url) {
      if (shell.navigationGuard && !await shell.navigationGuard()) return false;
      await shell.flush(); location.href = url; return true;
    },
    async activate(id) {
      const mod = shell.modules.get(id); if (!mod) throw new Error('Unknown Studio module.');
      if (shell.active && shell.active.unmount) shell.active.unmount(); shell.active = mod;
      await mod.mount(shell.root, { rom: shell.rom, pack: shell.pack, store: K.store, actions: K.action, toast: K.toast, settings: K.pref, source: shell.source(), game: shell.game }); drawRail();
    },

    /* ---- the game source ---- */
    sources: registry,
    /* def: { id, title, short, store, pack, program (SHA-256 of the decrypted program), about, hint, modes: [names],
       modeOffsets: [settings-chip offsets holding the mode], folder: { marker, inner, zips, settings, settingsExt } } */
    addSource(def) { if (!def || !def.id || def.id === 'original' || !/^[0-9a-f]{64}$/.test(def.program)) throw new Error('A source needs an id and its program SHA-256.'); K.pref.set('studio.sources', Object.assign({}, K.pref('studio.sources', null) || {}, { [def.id]: JSON.parse(JSON.stringify(def)) })); },
    /* The game the person chose (every module that works on it uses it). */
    chosen() {
      const p = K.pref('studio.sources.chosen', null) || {}, reg = registry(), s = reg[p.id] || ORIGINAL, modes = s.modes || null;
      return { ...s, mode: modes && p.mode >= 0 && p.mode < modes.length ? p.mode : null, chosen: !!reg[p.id] };
    },
    /* The game this page works on: the chosen one, except that a module made for one game only (Music works on the
       original game's sound driver: register({ fallback: 'original', fallbackNote })) always uses that game, and says so
       in the Game menu instead of refusing to open. */
    source() {
      const chosen = shell.chosen(), mod = shell.module(), own = mod && mod.fallback && registry()[mod.fallback];
      if (own && !(mod.sources || ['original']).includes(chosen.id)) return { ...own, mode: null, chosen: true, instead: shell.sourceLabel(chosen) };
      return chosen;
    },
    sourceLabel(s = shell.source()) { return s.short + (s.modes && s.mode !== null ? ' · ' + s.modes[s.mode] : ''); },
    setSource(id, mode) { const s = registry()[id]; if (!s) throw new Error('Unknown game source.'); K.pref.set('studio.sources.chosen', { id, mode: s.modes && mode >= 0 && mode < s.modes.length ? mode : null }); shell.rom = null; shell.pack = null; g.SF3_PACK = undefined; },
    identify(rom) { return rom && Object.values(registry()).find(s => s.program === rom.sha256) || null; },
    module() { return shell.active || [...shell.modules.values()][0] || null; },
    supports(mod = shell.module(), s = shell.source()) { return !mod || (mod.sources || ['original']).includes(s.id); },
    /* The ROM dimension of a module's abilities (Game plan §4b B3): a source registers, as data, which of a module's
       abilities hold on it and why ({ [moduleId]: { [abilityId]: { state: 'holds' | 'not carried over', why } } }).
       On the original every proven ability holds; elsewhere only what the source lists as 'holds'. */
    abilities(moduleId, s = shell.source()) { return s.id === 'original' ? null : ((s.abilities || {})[moduleId] || {}); },
    abilityOn(moduleId, abilityId, s = shell.source()) { if (s.id === 'original') return true; const a = ((s.abilities || {})[moduleId] || {})[abilityId]; return !!a && a.state === 'holds'; },
    async switchSource(id, mode) { await shell.flush(); shell.setSource(id, mode); location.reload(); },
    /* Try in game (Game plan §4b B2): hand edited images to the Game page, which opens them at their own ready start and
       lands where the change shows. Nothing is written to disk: the images wait in this browser's storage, one try at a
       time (the next replaces it). o: { program (16 MiB decrypted), data (64 MiB graphics/sound; omit = the game's own),
       label, hint (one line: how to reach the change), landing: { type: 'ready' | 'scenario' | 'sound-test' | 'state', ... }, from (the page to come back to), paused }. */
    game: {
      async tryImages(o) {
        if (!o || !(o.program instanceof Uint8Array) || o.program.length !== 0x1000000) throw new Error('Try in game needs the 16 MiB program image.');
        if (o.data && (!(o.data instanceof Uint8Array) || o.data.length !== 0x4000000)) throw new Error('Try in game needs the 64 MiB graphics and sound image.');
        const s = shell.source();
        await K.store('game.try').set('latest', { program: o.program, data: o.data || null, label: o.label || 'Changed game', hint: typeof o.hint === 'string' ? o.hint.slice(0, 200) : '', landing: o.landing || { type: 'ready' }, from: o.from || location.href, source: s.id, mode: s.mode, at: Date.now() });
        await shell.flush();
        location.href = new URL('../game_editor/index.html?try=' + Date.now() + (o.paused ? '#paused' : ''), location.href).href;
      },
    },

    async loadPack() {
      await shell.arrived;
      const s = shell.source(); if (!shell.supports(shell.module(), s)) return null;
      shell.pack = (s.id === 'original' && g.SF3_PACK) || await K.store.pack.get(s.pack);
      if (!shell.pack && g.SF3PackBuild) { const rom = await shell.loadRom(); if (rom) { shell.pack = await SF3PackBuild.fromRomSet(rom); await K.store.pack.set(s.pack, shell.pack); g.SF3_PACK = shell.pack; } }
      return shell.pack;
    },
    async loadRom(opts = {}) {
      await shell.arrived;
      /* The Infinite client updates itself: a chosen older release this module cannot open gives way to the current
         release when the computer holds it (the older work stays saved under its own release). */
      const before = shell.source();
      if (before.family === 'infinite' && !before.current && !shell.supports(shell.module(), before) && shell.served()) {
        const now = registry()[g.CPS3Sources?.CURRENT];
        if (now && shell.supports(shell.module(), now) && (await shell.computer() || { sets: [] }).sets.some(x => x.program === now.program)) {
          shell.setSource(now.id, before.mode); shell.followed = { from: before.title, to: now.title }; shell.drawFileButton();
        }
      }
      if (shell.served() && !(K.pref('studio.sources.chosen', null) || {}).id) {
        /* A browser new to this local Studio works on the game the person confirmed there. */
        const v = await shell.computer(), c = v && v.confirmed, to = c && registry()[c.source];
        if (to && to.id !== shell.chosen().id) { shell.setSource(to.id, to.modes ? 0 : null); shell.drawFileButton(); }
      }
      const s = shell.source(); if (!shell.supports(shell.module(), s)) return null;
      if (shell.rom && (!opts.graphics || shell.rom.data)) return shell.rom;
      const store = K.store(s.store); shell.rom = await Cps3Rom.restoreImages(store, opts);
      if (shell.rom) shell.confirmKnown();
      if (!shell.rom) { let zips = await Cps3Rom.restoreZips(store); if (!zips && s.id === 'original') { zips = await localRom(); if (zips) await Cps3Rom.saveZips(store, zips); } if (zips) { shell.rom = await Cps3Rom.loadZips(zips, { ...opts, music: !opts.graphics }); await Cps3Rom.saveImages(store, shell.rom); await saveBios(store, zips, shell.rom); } else shell.rom = await shell.fromComputer(s, opts); }
      if (shell.rom && shell.rom.sha256 !== s.program) { shell.rom = null; throw new Error(`The game saved for ${s.title} is not ${s.title}. Choose its files again from the Game menu (Game files…).`); }
      if (shell.rom) shell.rom.source = s;
      return shell.rom;
    },
    /* ---- the game on this computer (only a page opened through the local Studio asks its server) ---- */
    /* Only a page the Studio's own local server served carries its mark; any other server (a static host, a test
       server) is never asked for the game, so it never logs a refused request. */
    served() { return /^https?:$/.test(location.protocol) && !!document.querySelector('meta[name="cps3-studio-server"]'); },
    /* { sets: [{ id, kind: 'fightcade' | 'infinite' | 'chosen', title, folder, why, files, settings, program (a client's
       own note of what it prepared, or null) }], looked: [{ what, where, found }], remembered } or null (not served). */
    computer(refresh) {
      if (!shell.served()) return Promise.resolve(null);
      if (refresh || !shell.found) shell.found = fetch('/api/roms' + (refresh ? '?refresh=1' : ''), { cache: 'no-store' }).then(r => r.ok ? r.json() : null).catch(() => null);
      return shell.found;
    },
    /* A folder window on this computer (the server's own, so the answer is remembered by path, not by a browser grant). */
    async chooseFolder() {
      const r = await fetch('/api/roms/choose', { method: 'POST', headers: { 'X-Studio-Request': '1', 'Content-Type': 'application/json' }, body: '{}' });
      const v = await r.json().catch(() => ({})); if (!r.ok) throw new Error(v.error || 'That folder could not be read.');
      shell.found = Promise.resolve(v); return v;
    },
    placeOf(set) { return set.kind === 'fightcade' ? 'Fightcade’s ROMs' : set.kind === 'infinite' ? 'the Infinite client' : 'the folder you chose'; },
    /* Read the chosen game from the computer: a set whose client note names its program first, then sets of the
       right kind. Every set is recognised from its own program before it is kept; the zips, images, BIOS and
       (for a source with modes) the client's settings files are saved like an import, so the next visit is instant. */
    async fromComputer(s = shell.source(), opts = {}) {
      const found = await shell.computer(); if (!found || !found.sets || !found.sets.length) return null;
      /* First run (nothing confirmed): the game files screen asks. Files picked in another browser are not here. */
      if ('confirmed' in found && (!found.confirmed || found.confirmed.kind === 'browser')) return null;
      const kindFits = x => s.id === 'original' ? x.kind !== 'infinite' : x.kind !== 'fightcade';
      const mine = found.confirmed && found.confirmed.source === s.id && found.sets.find(x => x.id === found.confirmed.set);
      const order = [...new Set([mine, ...found.sets.filter(x => x.program === s.program), ...found.sets.filter(x => !x.program && kindFits(x))].filter(Boolean))];
      for (const set of order) {
        const zips = {};
        for (const name of ['sfiii3nr1.zip', 'sfiii3.zip']) {
          K.status(`Reading ${name} from ${shell.placeOf(set)}…`);
          const r = await fetch(`/api/roms/${encodeURIComponent(set.id)}/${name}`, { cache: 'no-store' });
          if (!r.ok) throw new Error(`${name} could not be read from ${set.folder}.`);
          zips[name] = new Uint8Array(await r.arrayBuffer());
        }
        const rom = await Cps3Rom.loadZips(zips, { ...opts, music: !opts.graphics });
        if (rom.sha256 !== s.program) continue;
        const store = K.store(s.store);
        await Cps3Rom.saveZips(store, zips); await Cps3Rom.saveImages(store, rom); await saveBios(store, zips, rom);
        if (s.modes && set.settings && set.settings.length) {
          const nv = [];
          for (const name of set.settings) { const r = await fetch(`/api/roms/${encodeURIComponent(set.id)}/${name}`, { cache: 'no-store' }); if (r.ok) nv.push({ name, bytes: new Uint8Array(await r.arrayBuffer()) }); }
          if (nv.length) await saveSettings(store, rom, nv, s);
        }
        await store.set('found', { set: set.id, kind: set.kind, folder: set.folder, at: Date.now() }).catch(() => {});
        /* A game with modes starts in its first (the client's own default); the Game menu changes it. Asking here
           would stop the hand for a choice most modules do not depend on. */
        if (s.modes && shell.source().id === s.id && shell.source().mode === null) K.pref.set('studio.sources.chosen', { id: s.id, mode: 0 });
        K.status(shell.followed ? `${shell.followed.from} was chosen; this computer now has ${shell.followed.to}, so the Studio uses it.` : '');
        return rom;
      }
      return null;
    },
    /* The BIOS member as the zip holds it and the settings blocks of a source: { program, bios } / { program, modes: { 0: bytes, ... } } */
    async loadBios(s = shell.source()) { const b = await K.store(s.store).get('bios'); return b && b.program === s.program ? b.member : null; },
    async loadSettings(s = shell.source()) { const v = await K.store(s.store).get('settings'); return v && v.program === s.program ? v.modes : null; },
    /* opts.strict (the game files screen): refuse a set that is neither source. Without it (e.g.
       Music's Deliver loading a build to patch) such a set is used for this visit only and never saved. */
    async importZips(files, progress, opts = {}) {
      progress = progress || K.status; progress('Reading your ROM files. They stay on this computer.');
      const zips = {}, nv = [];
      for (const file of files) { const bytes = new Uint8Array(await file.arrayBuffer()); if (/\.nv$/i.test(file.name)) nv.push({ name: file.name, bytes }); else zips[file.name] = bytes; }
      const mod = shell.module(), graphics = !!(mod && (mod.id === 'art_editor' || mod.graphics));
      const rom = await Cps3Rom.loadZips(zips, { graphics, music: !graphics });
      if (graphics && mod.id === 'art_editor' && !rom.supported && !shell.identify(rom)) throw new Error('Art requires sfiii3nr1, Japan 990512 NO CD rev 1.');
      const kind = shell.identify(rom);
      if (!kind) {
        const releases = Object.values(registry()).filter(x => x.family === 'infinite').sort((a, b) => a.order - b.order), others = Object.values(registry()).filter(x => x.id !== 'original' && x.family !== 'infinite').map(x => x.title);
        const named = [...(releases.length ? [`a released Infinite set (${releases[0].release} to ${releases[releases.length - 1].release})`] : []), ...others];
        const why = rom.revision === 'sfiii3' ? `These files hold ${rom.revisionTitle} (sfiii3.zip on its own), not the ${ORIGINAL.about} release the Studio reads: add sfiii3nr1.zip as well.`
          : named.length ? `These files are neither the original game (${ORIGINAL.about}) nor ${named.join(' nor ')}: their program does not match.` : `These files are not the original game (${ORIGINAL.about}): their program does not match.`;
        if (opts.strict) throw new Error(rom.revision === 'sfiii3' ? why : why + ' The Studio reads only the games it knows.');
        shell.rom = rom; progress(why + ' They are used for this visit only and are not saved.');
        if (!graphics) { shell.pack = await SF3PackBuild.fromRomSet(rom); g.SF3_PACK = shell.pack; }
        return graphics ? rom : shell.pack;
      }
      const before = shell.source();
      if (before.instead && kind.id !== before.id) throw new Error(`These are ${kind.title} files. ${mod.title} needs the original game.`);
      if (before.id !== kind.id || !before.chosen) shell.setSource(kind.id, kind.id === before.id ? before.mode : null);
      const store = K.store(kind.store);
      progress(`${kind.title} recognised. Saving it on this computer.`);
      await Cps3Rom.saveZips(store, zips); await Cps3Rom.saveImages(store, rom); await saveBios(store, zips, rom); shell.rom = rom; rom.source = shell.source();
      if (nv.length) await saveSettings(store, rom, nv, kind);
      if (!shell.supports(mod)) { progress(`${kind.title} is saved. ${mod.title || 'This module'} is proven on the original game only.`); return null; }
      if (!graphics && kind.id === 'original' && g.SF3PackBuild) { progress('Preparing the sounds.'); shell.pack = await SF3PackBuild.fromRomSet(shell.rom); await K.store.pack.set(kind.pack, shell.pack); g.SF3_PACK = shell.pack; }
      progress(K.store.mode === 'memory' ? 'Ready for this visit. This browser cannot save, so the files are asked for again next time.' : ''); return graphics ? shell.rom : shell.pack;
    },
    /* A folder: Fightcade's ROMs folder (or the Fightcade folder) for the original game; for a registered
       source, the folder its layout names (marker file + inner folder, or the inner folder itself).
       Returns the files importZips takes. */
    async filesFromFolder(dir) {
      const list = async d => { const o = {}; for await (const [name, h] of d.entries()) o[name.toLowerCase()] = h; return o; };
      const file = h => h.getFile(), top = await list(dir);
      const layouts = new Map(); for (const x of Object.values(registry())) if (x.folder && !layouts.has(x.family || x.id)) layouts.set(x.family || x.id, x);
      for (const [family, s] of layouts) {
        const L = s.folder; if (!L) continue;
        const named = L.inner && top[L.inner.toLowerCase()];
        const inner = L.marker && top[L.marker.toLowerCase()] && named && named.kind === 'directory' ? named
          : top[L.zips] && top[L.zips].kind === 'directory' && top[L.settings] ? dir : null;
        if (!inner) continue;
        const i = inner === dir ? top : await list(inner), zipDir = await list(i[L.zips]), setDir = i[L.settings] ? await list(i[L.settings]) : {};
        const zips = ['sfiii3nr1.zip', 'sfiii3.zip'].filter(n => zipDir[n]);
        const name = s.family === 'infinite' ? 'Infinite' : s.title;
        if (zips.length < 2) throw new Error(`This ${name} folder has no sfiii3nr1.zip and sfiii3.zip in ${L.inner}\\${L.zips}. Start ${name} once so it prepares its game, then choose the folder again.`);
        const out = []; for (const n of zips) out.push(await file(zipDir[n]));
        for (const [n, h] of Object.entries(setDir)) if (n.endsWith(L.settingsExt || '.nv') && h.kind === 'file') out.push(await file(h));
        return { kind: family, files: out };
      }
      for (const path of [[], ['roms'], ['emulator', 'fbneo', 'roms']]) {
        let d = dir, entries = top;
        try { for (const p of path) { const sub = entries[p]; if (!sub || sub.kind !== 'directory') throw 0; d = sub; entries = await list(d); } } catch (e) { continue; }
        if (entries['sfiii3nr1.zip'] && entries['sfiii3.zip']) return { kind: 'original', files: [await file(entries['sfiii3nr1.zip']), await file(entries['sfiii3.zip'])] };
      }
      const others = [...new Set([...layouts.values()].map(x => x.folder.marker || x.title))];
      throw new Error(`This folder has neither sfiii3nr1.zip and sfiii3.zip (Fightcade\\emulator\\fbneo\\ROMs)${others.length ? ' nor ' + others.join(' nor ') : ''}.`);
    },
    /* ---- Your game files. The first run asks, with a real choice; nothing is imported behind the person's back and
       nothing afterwards reports what just happened. Find them automatically (the local Studio's finder:
       Fightcade, the Infinite client, folders chosen before) or Choose files myself (a folder, the two zips, a drop).
       What is found is listed with the best choice selected; Use these reads the files, recognises the game from its
       program and saves it, and the local Studio remembers the choice, so the screen comes back only from the Game menu
       (Game files…). Opened from disk (no local Studio) only Choose files myself is possible.
       o: { ready(result) (a module gets its ROM, or Music its sound pack), graphics (the page needs the graphics image) } */
    gameFiles(root, o = {}) {
      const served = shell.served(), picker = typeof g.showDirectoryPicker === 'function', reg = registry();
      const mod = shell.module(), graphics = o.graphics != null ? !!o.graphics : !!(mod && (mod.id === 'art_editor' || mod.graphics));
      /* On a page that always uses the original game (Music) while the others use another, only the original is asked for,
         and choosing it here leaves the other modules' game as it is. */
      const only = shell.source().instead ? shell.source() : null;
      const status = el('p.gamefiles-status.hint', { role: 'status', 'aria-live': 'polite' }), body = el('div.gamefiles-body');
      const input = el('input', { type: 'file', accept: '.zip,.nv', multiple: true, hidden: true });
      const way = (id, title, line, icon) => el('button.gamefiles-way', { type: 'button', 'data-way': id, 'aria-pressed': 'false', onclick: () => show(id) },
        K.icon(icon), el('span', null, el('strong', null, title), el('span', null, line)));
      const ways = el('div.gamefiles-ways', { role: 'group', 'aria-label': 'How to find your game files' },
        way('find', 'Find them automatically', 'Looks in Fightcade, the Infinite client and folders you chose before.', 'search'),
        way('manual', 'Choose files myself', 'Pick the folder that holds them, or the two zip files.', 'folder'));
      const panel = el('section.gamefiles.welcome', { 'aria-labelledby': 'gamefiles-title' },
        el('h2#gamefiles-title', null, 'Your game files'),
        only ? el('p.gamefiles-lede', null, `${mod.fallbackNote || ''} Choose the original game’s files: `, el('b', null, 'sfiii3nr1.zip'), ' with ', el('b', null, 'sfiii3.zip'),
          ` (Japan 990512 NO CD, rev 1), as Fightcade keeps them. Art, Moves and Game keep using ${only.instead}.`)
        : el('p.gamefiles-lede', null, 'CPS3 Studio works on your own copy of Street Fighter III 3rd Strike: ', el('b', null, 'sfiii3nr1.zip'), ' with ',
          el('b', null, 'sfiii3.zip'), ' (Japan 990512 NO CD, rev 1). The Studio only reads them, and they stay on this computer.'),
        served ? ways : '', body, status, input);
      const say = (text, bad) => { status.textContent = text || ''; status.classList.toggle('bad', !!bad); };
      const lock = on => { panel.classList.toggle('busy', on); panel.querySelectorAll('button, input').forEach(b => { b.disabled = on; }); };
      let current = null;
      function show(id) {
        current = id; say('');
        ways.querySelectorAll('[data-way]').forEach(b => { const on = b.dataset.way === id; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
        if (id === 'find') return found(); manual();
      }
      /* What the finder found, best first: the original game (every module works on it), then Infinite, then folders
         chosen before. A set is named from the program its client noted (Infinite); Fightcade's is the original game. */
      function describe(set) {
        const s = set.program ? Object.values(reg).find(x => x.program === set.program) || null : set.kind === 'fightcade' ? reg.original || ORIGINAL : null;
        const unknown = set.kind === 'infinite' && !s;
        const title = s ? s.title : unknown ? 'Infinite (a release this Studio does not know yet)' : 'Game files in a folder you chose';
        const note = unknown ? 'Update CPS3 Studio to work on this release.' : !s ? 'Checked when you use them.'
          : s.id === 'original' ? 'Every module works on it.' : 'Art, Moves and Game work on it. Music uses the original game’s sounds.';
        const where = (set.kind === 'fightcade' ? 'Fightcade' : set.kind === 'infinite' ? 'Infinite client' : 'Folder you chose') + ' · ' + (set.client || set.folder);
        const elsewhere = only && s && s.id !== only.id;
        return { set, s, title, note: elsewhere ? `${mod.title} needs the original game.` : note, where, usable: !unknown && !elsewhere, rank: !s ? 2 : s.id === 'original' ? 0 : 1 };
      }
      async function found() {
        body.replaceChildren(el('p.gamefiles-wait', null, 'Looking on this computer…'));
        const v = await shell.computer(true); if (current !== 'find') return;
        const rows = (v && v.sets || []).map(describe).sort((a, b) => a.rank - b.rank);
        const looked = el('details.gamefiles-looked', { open: !rows.length }, el('summary', null, 'Where the Studio looked'),
          el('ul', null, ...((v && v.looked) || []).map(l => el('li', null, el('b', null, l.what), el('span.faint', null, l.where), el('span', null, l.found ? 'found' : 'not there')))));
        if (!rows.length) {
          body.replaceChildren(el('p.gamefiles-none', null, el('strong', null, 'No game files found.'), ' Choose them yourself: the folder that holds sfiii3nr1.zip and sfiii3.zip, your Fightcade folder or your Infinite folder.'),
            el('div.gamefiles-actions', null, el('button.btn.primary.big', { type: 'button', onclick: () => show('manual') }, 'Choose files myself')), looked);
          return;
        }
        let pick = rows.find(r => r.usable) || null;
        const list = el('div.gamefiles-list', { role: 'radiogroup', 'aria-label': 'Game files found on this computer' }, ...rows.map(r => {
          const item = el('label.gamefiles-row' + (r.usable ? '' : '.off'), null,
            el('input', { type: 'radio', name: 'gamefiles-set', value: r.set.id, checked: r === pick, disabled: !r.usable, onchange: () => { pick = r; } }),
            el('span.gamefiles-row-text', null, el('strong', null, r.title), el('span.faint', null, r.where), el('span', null, r.note)));
          return item;
        }));
        const use = el('button.btn.primary.big', { type: 'button', disabled: !pick, onclick: () => pick && useSet(pick.set) }, 'Use these');
        body.replaceChildren(el('h3.gamefiles-sub', null, rows.length === 1 ? 'Found on this computer' : `Found on this computer (${rows.length})`), list,
          el('div.gamefiles-actions', null, use), looked);
        use.focus();
      }
      function manual() {
        const folder = el('button.btn.primary.big', { type: 'button', hidden: !(served || picker), onclick: () => served ? fromServer() : fromFolder() }, K.icon('folder'), 'Choose folder…');
        const zips = el('button.btn.big' + (served || picker ? '' : '.primary'), { type: 'button', onclick: () => input.click() }, 'Choose the zip files…');
        body.replaceChildren(
          el('div.gamefiles-actions', null, folder, zips),
          el('p.gamefiles-help', null, served || picker ? 'Choose the folder that holds sfiii3nr1.zip and sfiii3.zip, your Fightcade folder or your Infinite folder. Or choose the two zip files, or drop them here.'
            : 'Choose sfiii3nr1.zip and sfiii3.zip, or drop them here. Fightcade keeps them in Fightcade\\emulator\\fbneo\\ROMs.'));
      }
      /* Remember the choice in the local Studio, so no page asks again (a page from disk keeps it in its own storage). */
      async function confirm(kind, set) {
        if (!served || only) return;
        const s = shell.source(), rec = { source: s.id, kind, set: set ? set.id : null, folder: set ? (set.client || set.folder) : null };
        try { const r = await fetch('/api/roms/confirm', { method: 'POST', headers: { 'X-Studio-Request': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(rec) }); if (r.ok) shell.found = Promise.resolve(await r.json()); } catch (e) { /* an older local Studio: it never asks anyway */ }
      }
      async function done(result) {
        if (!shell.supports()) { shell.notice(root); return; }
        if (result === undefined) result = graphics ? shell.rom : (shell.pack || (g.SF3PackBuild ? await shell.loadPack() : null));
        panel.remove(); if (o.ready) await o.ready(result);
      }
      /* A found set: read its two zips, recognise the game from its program, save it as an import would. */
      async function useSet(set) {
        lock(true);
        try {
          const zips = {};
          for (const name of ['sfiii3nr1.zip', 'sfiii3.zip']) {
            say(`Reading ${name} from ${shell.placeOf(set)}…`);
            const r = await fetch(`/api/roms/${encodeURIComponent(set.id)}/${name}`, { cache: 'no-store' });
            if (!r.ok) throw new Error(`${name} could not be read from ${set.folder}.`);
            zips[name] = new Uint8Array(await r.arrayBuffer());
          }
          say('Checking the game…');
          const rom = await Cps3Rom.loadZips(zips, { graphics, music: !graphics }), kind = shell.identify(rom);
          if (!kind) throw new Error(rom.revision === 'sfiii3' ? `${set.folder} holds ${rom.revisionTitle}, not the ${ORIGINAL.about} release the Studio reads.` : `The files in ${set.folder} are not a game this Studio knows: their program does not match the original game or a released Infinite set.`);
          if (only && kind.id !== only.id) throw new Error(`These are ${kind.title} files. ${mod.title} needs the original game.`);
          if (!only) { const before = shell.source(); shell.setSource(kind.id, kind.id === before.id ? before.mode : kind.modes ? 0 : null); }
          const store = K.store(kind.store);
          say(`${kind.title} recognised. Saving it for the Studio…`);
          await Cps3Rom.saveZips(store, zips); await Cps3Rom.saveImages(store, rom); await saveBios(store, zips, rom);
          if (kind.modes && set.settings && set.settings.length) {
            const nv = [];
            for (const name of set.settings) { const r = await fetch(`/api/roms/${encodeURIComponent(set.id)}/${name}`, { cache: 'no-store' }); if (r.ok) nv.push({ name, bytes: new Uint8Array(await r.arrayBuffer()) }); }
            if (nv.length) await saveSettings(store, rom, nv, kind);
          }
          await store.set('found', { set: set.id, kind: set.kind, folder: set.folder, at: Date.now() }).catch(() => {});
          shell.rom = rom; rom.source = shell.source(); shell.pack = null;
          await confirm(set.kind, set); say('');
          await done();
        } catch (e) { say(e.message, true); }
        finally { if (panel.isConnected) lock(false); }
      }
      async function fromServer() {
        lock(true); say('A folder window is open on this computer. If you cannot see it, it may be behind this window.');
        try {
          const v = await shell.chooseFolder();
          if (v.cancelled) { say('No folder chosen.'); return; }
          const want = String(v.chosen).toLowerCase(), set = (v.sets || []).find(x => [x.folder, x.client].some(f => f && f.toLowerCase() === want));
          if (!set) { say(`${v.chosen} holds no sfiii3nr1.zip and sfiii3.zip.`, true); return; }
          lock(false); await useSet(set);
        } catch (e) { say(e.message, true); }
        finally { if (panel.isConnected) lock(false); }
      }
      async function fromFolder() {
        let dir; try { dir = await g.showDirectoryPicker({ mode: 'read' }); } catch (e) { return; }
        try { const f = await shell.filesFromFolder(dir); await K.store('kv').set('source.folder.' + f.kind, dir).catch(() => {}); waiting.clear(); await take(f.files); }
        catch (e) { say(e.message, true); }
      }
      /* Files are held between picks so the two zips can be chosen one at a time. A pick of two or more files is a new
         selection. A file that is not a zip is set aside (and named) and the rest are tried again. */
      const waiting = new Map();
      async function take(files) {
        files = [...files]; if (files.length > 1) waiting.clear();
        for (const f of files) waiting.set(f.name, f); input.value = ''; lock(true);
        const aside = [];
        try {
          for (;;) {
            try { const r = await shell.importZips([...waiting.values()], text => say(text), { strict: true }); await confirm('browser', null); say(''); await done(r === null ? undefined : r); return; }
            catch (e) { if (!(e && e.zipName && waiting.has(e.zipName))) throw e; aside.push(e.message); waiting.delete(e.zipName); if (!waiting.size) throw null; }
          }
        } catch (e) {
          const held = [...waiting.keys()];
          say([...aside.map(m => m + ' It was left out.'), e ? e.message : 'Choose sfiii3nr1.zip and sfiii3.zip.', held.length ? `Chosen so far: ${held.join(', ')}.` : ''].filter(Boolean).join(' '), true);
        } finally { if (panel.isConnected) lock(false); }
      }
      input.onchange = () => take(input.files);
      panel.ondragover = e => { e.preventDefault(); panel.classList.add('drop'); }; panel.ondragleave = e => { if (!panel.contains(e.relatedTarget)) panel.classList.remove('drop'); };
      panel.ondrop = e => { e.preventDefault(); e.stopPropagation(); panel.classList.remove('drop'); take(e.dataTransfer.files); };
      root.replaceChildren(panel);
      if (!served) manual(); else ways.querySelector('[data-way]').focus();
      return panel;
    },
    /* A module whose game is not there yet: the game files screen in its workspace. */
    welcome(root, ready) {
      if (!shell.supports()) return shell.notice(root);
      return shell.gameFiles(root, { ready });
    },
    /* True on the first run of the local Studio: nothing confirmed there yet and nothing saved in this browser. An older
       local Studio (no confirmation record) never asks; neither does a page opened from disk (its modules ask). */
    async firstRun() {
      if (!shell.served()) return false;
      const v = await shell.computer(); if (!v || !('confirmed' in v) || v.confirmed) return false;
      return !await shell.knownHere();
    },
    /* The game this browser already holds (from an earlier visit): { source, found } or null. */
    async knownHere() {
      for (const s of [shell.source(), ...Object.values(registry())]) { try { if (await K.store(s.store).get('images')) return { source: s, found: await K.store(s.store).get('found') || null }; } catch (e) { /* no storage */ } }
      return null;
    },
    /* A browser that used the Studio before the first-run screen existed confirms what it already uses, once. */
    async confirmKnown() {
      if (!shell.served()) return;
      const v = await shell.computer(); if (!v || !('confirmed' in v) || v.confirmed) return;
      const known = await shell.knownHere(); if (!known) return;
      const f = known.found || {};
      try { const r = await fetch('/api/roms/confirm', { method: 'POST', headers: { 'X-Studio-Request': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ source: known.source.id, kind: f.kind || 'browser', set: f.set || null, folder: f.folder || null }) }); if (r.ok) shell.found = Promise.resolve(await r.json()); } catch (e) { /* older local Studio */ }
    },
    /* A module on a source it is not proven on says so, and offers the way back. */
    notice(root) {
      const mod = shell.module(), s = shell.source(), title = (mod && mod.title) || 'This module', reg = registry();
      const proven = (mod && mod.sources || ['original']).map(id => reg[id]).filter(Boolean), current = reg[g.CPS3Sources?.CURRENT];
      const older = s.family === 'infinite' && !s.current && current;
      const head = older ? `${s.title} is an older Infinite release.` : `${title} does not work with ${s.title} yet.`;
      const body = older ? `The Studio works with the current release, ${current.release}. Start Infinite once so it updates its game; the Studio then finds it by itself.`
        : `Use the original game for ${title}. Your work is kept.`;
      const buttons = [el('button.btn.primary', { onclick: () => shell.switchSource('original') }, 'Use the original game')];
      if (older && current && mod && (mod.sources || []).includes(current.id)) buttons.push(el('button.btn', { onclick: () => shell.switchSource(current.id, 0) }, 'Use ' + current.title));
      const panel = el('div.empty.welcome.notice', null, el('b', null, head), el('p', null, body), el('div.hbox', null, ...buttons));
      root.replaceChildren(panel); K.status(`${title} · ${head}`); return panel;
    },
    fileButton() {
      const label = el('span.wide-only', null, 'Game: ' + shell.sourceLabel());
      const s = shell.source(), note = s.instead ? `${shell.module().fallbackNote || ''} Art, Moves and Game use ${s.instead}.`.trim() : 'Where the game comes from. Every module reads from it.';
      return el('button.btn.ghost', { 'data-studio-file': '', 'aria-haspopup': 'menu', 'aria-label': 'Game: ' + shell.sourceLabel(), 'data-tip': 'Game|' + note, onclick: e => shell.fileMenu(e.currentTarget) }, K.icon('folder'), label);
    },
    /* Redraw the Game button after the page's game changed under it (a browser new to this local Studio adopting the
       confirmed game, or an older Infinite release following the current one). */
    drawFileButton() { const old = document.querySelector('[data-studio-file]'); if (old) old.replaceWith(shell.fileButton()); },
    fileMenu(anchor) {
      const here = shell.source(), s = shell.chosen();
      const items = [];
      for (const x of Object.values(registry()).filter(x => x.listed || x.id === s.id)) {
        if (!x.modes) items.push({ label: x.title, checked: s.id === x.id, run: () => { if (s.id !== x.id) shell.switchSource(x.id); } });
        else x.modes.forEach((m, i) => items.push({ label: `${x.title} · ${m}`, checked: s.id === x.id && s.mode === i, run: () => { if (s.id !== x.id || s.mode !== i) shell.switchSource(x.id, i); } }));
      }
      return K.menu(anchor, [...(here.instead && shell.module().fallbackNote ? [{ heading: shell.module().fallbackNote.replace(/\.$/, '') }, '-'] : []), { heading: here.instead ? 'Game for Art, Moves and Game' : 'Game' }, ...items, '-', { label: 'Game files…', icon: 'folder', run: () => shell.changeLocation() }]);
    },
    changeLocation() {
      const host = el('div.gamefiles-dialog');
      const done = K.dialog({ title: 'Game files', body: host, width: 720, buttons: [{ label: 'Close', value: null }] });
      shell.gameFiles(host, { ready: async () => { done.close(true); await shell.flush(); location.reload(); } });
      return done;
    },
    settings() {
      const s = shell.source();
      const body = el('div.vbox', null,
        el('h3', null, 'Audio'), el('p', null, 'Fightcade monitors in mono. Stereo lets you hear the arcade board’s left and right placement.'),
        el('h3', null, 'ROM'), el('p', null, shell.pack ? `${s.about}. Sounds are stored only on this computer.` : 'Load your two ROM files to hear the game’s instruments.'),
        el('h3', null, 'Game'), el('p', null, `${shell.sourceLabel(s)}. Change it from the Game menu in the top bar.`),
        el('h3', null, 'About'), el('p', null, 'CPS3 Studio · Music. Playback runs the original arcade sound driver.'));
      return K.dialog({ title: 'Settings', body });
    }
  };
  /* The BIOS member as stored in the zip (decrypted by the module that runs the machine). */
  async function saveBios(store, zips, rom) {
    for (const bytes of Object.values(zips)) {
      try { const m = await KitZip.read(bytes, { only: n => n.slice(n.lastIndexOf('/') + 1) === BIOS_MEMBER }); const b = Object.values(m)[0]; if (b) { await store.set('bios', { program: rom.sha256, member: b }); return; } } catch (e) { /* not a zip that holds it */ }
    }
  }
  /* FBNeo settings files (.nv): "FB1 FS1", a 76-byte header (offset 24: the zlib stream's length; 28: the driver
     name), then the stream of the 0x400-byte settings chip, padded to 4 bytes. A source with modes says which
     chip offsets hold the mode (all must agree); the blocks are kept by mode. */
  async function saveSettings(store, rom, files, kind) {
    const modes = {}, at2 = kind.modeOffsets || [];
    for (const f of files) {
      const b = f.bytes, at = b.findIndex((v, i) => i >= 8 && v === 0x78 && b[i + 1] === 0x9C);
      if (String.fromCharCode(...b.slice(0, 7)) !== 'FB1 FS1' || at < 0) continue;
      const len = b[24] | b[25] << 8 | b[26] << 16 | b[27] << 24, body = b.subarray(at, len > 0 && at + len <= b.length ? at + len : b.length);
      let raw; try { raw = new Uint8Array(await new Response(new Blob([body]).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer()); } catch (e) { continue; }
      if (raw.length !== 0x400 || !at2.length || !at2.every(o => raw[o] === raw[at2[0]]) || !kind.modes || raw[at2[0]] >= kind.modes.length) continue;
      modes[raw[at2[0]]] = raw;
    }
    if (Object.keys(modes).length) await store.set('settings', { program: rom.sha256, modes });
  }
  /* A ROM prepared beside the Studio (studio_kit/local/rom.js, made by
     local/prepare_rom.py, never part of a package). Read once when a page opened from disk has
     nothing saved yet, so the Studio opens without asking; absent, the welcome asks instead.
     Only a private workspace has that file, so only there is it asked for: a package
     or public copy never requests a file it does not have (no console error). */
  const kitBase = (document.currentScript && document.currentScript.src || '').replace(/[^/]*$/, '');
  function workspaceKit() { return false; }
  function localRom() {
    if (!workspaceKit()) return Promise.resolve(null);
    return new Promise(done => {
      const tag = document.createElement('script'); tag.src = kitBase + 'local/rom.js';
      tag.onerror = () => { tag.remove(); done(null); };
      tag.onload = () => {
        const parts = g.CPS3_LOCAL_ROM, zips = {}; g.CPS3_LOCAL_ROM = null; tag.remove();
        if (!parts) { done(null); return; }
        K.status('Reading the ROM prepared on this computer.');
        for (const [name, chunks] of Object.entries(parts)) {
          const raw = chunks.map(atob), bytes = new Uint8Array(raw.reduce((n, s) => n + s.length, 0)); let at = 0;
          for (const s of raw) { for (let i = 0; i < s.length; i++) bytes[at + i] = s.charCodeAt(i); at += s.length; }
          zips[name] = bytes;
        }
        done(zips);
      };
      document.head.append(tag);
    });
  }

  /* ---- the Studio app. A Studio page opened from disk (file://) looks for the app's
     local server. When it runs, the page hands its saved browser work (projects, versions, settings: never ROM images
     or caches) to the server and continues in the app at the same page; the app keeps every item it does not already
     have and overwrites nothing. When it does not run, one line says how to start it. ?disk=1 stays on disk. ---- */
  const APP = 'http://127.0.0.1:8787/', SKIP = /^(pack|cache|rom(\..*)?|game\.try|game\.starts)$/;
  const b64 = u => { let t = ''; for (let i = 0; i < u.length; i += 32768) t += String.fromCharCode.apply(null, u.subarray(i, i + 32768)); return btoa(t); };
  const unb64 = t => Uint8Array.from(atob(t), c => c.charCodeAt(0));
  function encode(v) {
    if (ArrayBuffer.isView(v)) return { '\u0001ta': v.constructor.name, b: b64(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) };
    if (v instanceof ArrayBuffer) return { '\u0001ab': b64(new Uint8Array(v)) };
    if (Array.isArray(v)) return v.map(encode);
    if (v && typeof v === 'object') {
      if (v instanceof Date) return { '\u0001date': v.toISOString() };
      if (typeof v.getFile === 'function' || typeof v.entries === 'function' && typeof v.kind === 'string') throw new Error('not portable');
      const o = {}; for (const k of Object.keys(v)) o[k] = encode(v[k]); return o;
    }
    return v;
  }
  function decode(v) {
    if (Array.isArray(v)) return v.map(decode);
    if (v && typeof v === 'object') {
      if ('\u0001ta' in v) { const u = unb64(v.b), T = g[v['\u0001ta']] || Uint8Array; return T === Uint8Array ? u : new T(u.buffer, 0, u.byteLength / (T.BYTES_PER_ELEMENT || 1)); }
      if ('\u0001ab' in v) return unb64(v['\u0001ab']).buffer;
      if ('\u0001date' in v) return new Date(v['\u0001date']);
      const o = {}; for (const k of Object.keys(v)) o[k] = decode(v[k]); return o;
    }
    return v;
  }
  async function exportWork() {
    const stores = {}; let items = 0;
    for (const name of await K.store.names()) {
      if (SKIP.test(name)) continue;
      const st = K.store(name), rows = [];
      for (const key of await st.keys()) {
        if (name === 'kv' && /^source\.folder\./.test(String(key))) continue;
        try { rows.push([key, encode(await st.get(key))]); items++; } catch (e) { /* a browser-only handle: stays here */ }
      }
      if (rows.length) stores[name] = rows;
    }
    const prefs = {}; try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (/^cps3studio\.|^studio\./.test(k)) prefs[k] = localStorage.getItem(k); } } catch (e) { /* no storage */ }
    return { format: 'cps3-studio-handoff', version: 1, from: location.href, items, stores, prefs };
  }
  shell.arrived = (async () => {
    const params = new URLSearchParams(location.search), token = params.get('handoff');
    if (!token || location.protocol === 'file:') return;
    params.delete('handoff'); history.replaceState(null, '', location.pathname + (params.toString() ? '?' + params : '') + location.hash);
    try {
      const r = await fetch('/api/handoff/' + encodeURIComponent(token), { cache: 'no-store' }); if (!r.ok) return;
      const v = await r.json(); let kept = 0, had = 0;
      for (const [name, rows] of Object.entries(v.stores || {})) { const st = K.store(name); for (const [key, value] of rows) { if (await st.get(key) !== undefined) { had++; continue; } await st.set(key, decode(value)); kept++; } }
      try { for (const [k, val] of Object.entries(v.prefs || {})) if (localStorage.getItem(k) === null) localStorage.setItem(k, val); } catch (e) { /* no storage */ }
      shell.handoff = { kept, had };
      if (kept) setTimeout(() => K.status(`Your work saved in the page on disk is here too (${kept} item${kept === 1 ? '' : 's'}; ${had} already here were kept as they are).`), 1500);
    } catch (e) { /* nothing to bring */ }
  })();
  /* The page's place in its Studio folder (module folder and file), which is the same place in the app. */
  function pagePath() { const parts = decodeURIComponent(location.pathname).split('/'); return parts.slice(-2).join('/'); }
  function diskNote(app) {
    const bar = el('div.studio-disk-note', { role: 'note' },
      el('span', null, app ? 'This is the Studio’s copy on disk. The CPS3 Studio app opens this page in its own window, with your ROMs found (the CPS3 Studio shortcut on your Desktop does the same).' : 'Opened from disk, so the Studio cannot look for your game by itself. Start it with Open CPS3 Studio.bat (Python 3 needed) and it opens in its own window with your game found.'),
      app ? el('button.btn.primary', { type: 'button', 'data-tip': 'Open the app|Start CPS3 Studio and continue on this page in its own window.', onclick: () => { location.href = app.protocol + '://open/' + encodeURI(pagePath()) + location.search + location.hash; } }, 'Open the app') : '',
      el('button.btn.ghost', { type: 'button', 'aria-label': 'Hide this note', 'data-tip': 'Hide|Hide this note for this visit.', onclick: () => bar.remove() }, '×'));
    document.body.prepend(bar);
  }
  /* Only where the app is installed (install_app.py writes studio_kit/local/app.js in the workspace) does a disk page
     look for it; other disk copies open as they always did. */
  const installed = () => new Promise(done => { if (!workspaceKit()) return done(null); const tag = document.createElement('script'); tag.src = kitBase + 'local/app.js'; tag.onload = () => { tag.remove(); done(g.CPS3_APP || null); }; tag.onerror = () => { tag.remove(); done(null); }; document.head.append(tag); });
  if (location.protocol === 'file:' && !new URLSearchParams(location.search).has('disk')) (async () => {
      const app = await installed(); if (!app) return;
      const root = document.documentElement, hold = setTimeout(() => { root.style.visibility = ''; }, 900);
      root.style.visibility = 'hidden';
      let h = null;
      try { const r = await fetch(APP + 'api/health', { cache: 'no-store', signal: AbortSignal.timeout(700) }); h = r.ok && await r.json(); } catch (e) { h = null; }
      const here = decodeURIComponent(location.pathname).replace(/^\/(?=[A-Za-z]:)/, '').replace(/\\/g, '/').toLowerCase();
      if (h && h.app === 'cps3-studio-local-v1' && here.startsWith(String(h.root).replace(/\\/g, '/').toLowerCase() + '/')) {
        const rel = decodeURIComponent(location.pathname).replace(/^\/(?=[A-Za-z]:)/, '').replace(/\\/g, '/').slice(String(h.root).length + 1);
        let token = '';
        try { const body = JSON.stringify(await exportWork()); const r = await fetch(APP + 'api/handoff', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body }); token = (await r.json()).token || ''; } catch (e) { token = ''; }
        const q = new URLSearchParams(location.search); if (token) q.set('handoff', token);
        location.replace(APP + rel.split('/').map(encodeURIComponent).join('/') + (q.toString() ? '?' + q : '') + location.hash);
        return;
      }
      clearTimeout(hold); root.style.visibility = '';
      const show = () => diskNote(app); if (document.body) show(); else document.addEventListener('DOMContentLoaded', show);
  })();
  function drawRail() { if (!shell.rail) return; shell.rail.hidden = shell.modules.size < 2; shell.rail.replaceChildren(...[...shell.modules.values()].map(m => el('button.btn', { 'data-tip': `${m.title}|Open ${m.title}.`, onclick: () => shell.activate(m.id) }, K.icon(m.icon), m.title))); }
  K.action({ id: 'studio.settings', title: 'Settings', hint: 'See audio, ROM and Studio settings.', icon: 'settings', run: () => shell.settings() });
})(window);
