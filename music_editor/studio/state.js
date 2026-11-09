/* The project is committed only after a successful edit. History contains exact JSON, never references. */
(function (g) {
  'use strict';
  const S = g.Studio = g.Studio || {}, copy = x => JSON.parse(JSON.stringify(x)), events = new Map();
  const history = [], future = [], cache = new Map();
  let timer, lastEdit = null, saving = Promise.resolve(), version = 0;
  const test = location.hash.includes('selftest');
  const legacyLastKey=test?'music.test-last':'music.last',lastKey=()=>legacyLastKey+':'+(state.source?g.CPS3Sources.key(state.source):'standalone');
  const state = S.state = { project: null, revision: 0, dirty: false, selection: {}, catalog: null,source:null,
    on(name, fn) { if (!events.has(name)) events.set(name, new Set()); events.get(name).add(fn); return () => events.get(name).delete(fn); },
    emit(name, value) { for (const fn of events.get(name) || []) fn(value); },
    /* opts.gesture: every edit of one pointer gesture (a unique label) is one undo step, however slow the machine */
    edit(label, fn, opts = {}) {
      if (state.project?.ui?.readOnly) throw new Error('Capcom’s original is read-only. Make an editable copy first.');
      const before = JSON.stringify(state.project), draft = copy(state.project); fn(draft);
      if (JSON.stringify(draft) === before) return;
      const now = performance.now();
      if (!lastEdit || lastEdit.label !== label || (!opts.gesture && now - lastEdit.at > 500)) history.push({ label, json: before });
      lastEdit = { label, at: now }; future.length = 0; state.project = draft; changed();
    },
    undo() { if (!history.length) return; const x = history.pop(); future.push({ label: x.label, json: JSON.stringify(state.project) }); state.project = JSON.parse(x.json); lastEdit = null; changed(); },
    redo() { if (!future.length) return; const x = future.pop(); history.push({ label: x.label, json: JSON.stringify(state.project) }); state.project = JSON.parse(x.json); lastEdit = null; changed(); },
    select(selection) { state.selection = copy(selection); state.project.ui = state.project.ui || {}; state.project.ui.selection = copy(selection); state.emit('selection', state.selection); schedule(); },
    newProject(project) {
      state.project = SF3Compile.normalize(project || { format: 'sf3project', version: 2, name: 'Untitled song', bpm: 120, bars: 8, parts: [], autoTune: true });
      state.project.ui.projectId = test ? 'music-selftest' : state.project.ui.projectId || 'music-' + crypto.randomUUID();
      history.length = future.length = 0; lastEdit = null; state.selection = state.project.ui.selection || {}; changed(); return state.project;
    },
    async open(file) {
      let value = file;
      if (typeof File !== 'undefined' && file instanceof File) {
        if (/\.midi?$/i.test(file.name)) value = SF3Midi.toProject(SF3Midi.parse(new Uint8Array(await file.arrayBuffer())), { name: file.name.replace(/\.midi?$/i, '') });
        else if (/\.sf3score$/i.test(file.name)) { if (!g.SF3Score) throw new Error('Text scores are not available yet.'); value = SF3Score.parse(await file.text()); }
        else value = JSON.parse(await file.text());
      } else if (typeof file === 'string') value = JSON.parse(file);
      if (value?.format === 'sf3song') { if (!value.project) throw new Error('This song file has no editable project.'); value = value.project; }
      if (value?.version === 1 && value.project) value = SF3Compile.upgrade({ ...value.project, names: value.names || value.project.names || {} });
      if (!value || !Array.isArray(value.parts)) throw new Error('This file is not a music project.');
      if (state.project) await state.save(); S.transport && S.transport.stop(); return state.newProject(value);
    },
    build(opts) {
      opts = Object.assign({ compress: false, includeMuted: true, catalog: state.catalog }, opts);
      const key = JSON.stringify([state.revision, !!opts.compress, opts.includeMuted, opts.range || null]);
      if (!cache.has(key)) cache.set(key, SF3Compile.build(state.project, opts)); return cache.get(key);
    },
    save() {
      clearTimeout(timer); if (!state.project) return Promise.resolve();
      const project = copy(state.project), revision = state.revision, source=state.source,sourceLastKey=lastKey(),id = project.ui.projectId, key = `${id}:${Date.now()}:${String(++version).padStart(8, '0')}`;
      saving = saving.catch(() => {}).then(async () => {
        await Kit.store.projects.set(id, project); await Kit.store.kv.set(sourceLastKey, id); await Kit.store.versions.set(key, project);
        const keys = (await Kit.store.versions.keys()).filter(k => String(k).startsWith(id + ':')).sort();
        for (const old of keys.slice(0, -20)) await Kit.store.versions.del(old);
        if (!test && g.CPS3Workspace && g.CPS3Sources.equal(source,g.CPS3Studio.source())) await g.CPS3Workspace.setDocument('music', project, 'sf3project', project.version || 2,source);
        if (state.revision === revision) { state.dirty = false; state.emit('saved', true); }
      }); return saving;
    },
    async restore(id) { id = id || await Kit.store.kv.get(lastKey());if(!id&&(!state.source||state.source.id==='original'))id=await Kit.store.kv.get(legacyLastKey); const p = id && await Kit.store.projects.get(id); if (!p) return false; state.project = p; state.selection = p.ui?.selection || {}; history.length = future.length = 0; lastEdit = null; state.revision++; cache.clear(); state.dirty = false; state.emit('project', p); return true; },
    async init(pack) {
      state.source=g.CPS3Sources&&g.CPS3Studio?g.CPS3Sources.identity(g.CPS3Studio.source()):null;
      S.pack = pack; S.data = SF3Data.load(new SF3Engine.Engine(pack), pack.names);
      const key = 'catalog:' + (pack.program_sha256 || pack.rom) + ':' + SF3Catalog.VERSION;
      state.catalog = await Kit.store.cache.get(key);
      if (!state.catalog) { state.catalog = await SF3Catalog.buildAsync(new SF3Engine.Engine(pack), S.data, { every: 12, onProgress: p => Kit.status(`Preparing instruments: ${p.done} / ${p.total}`) }); await Kit.store.cache.set(key, state.catalog); }
      if (!test && g.CPS3Workspace) {
        const doc = await g.CPS3Workspace.document('music');
        if (doc) { state.project = SF3Compile.normalize(doc.value); state.selection = state.project.ui.selection || {}; state.revision++; cache.clear(); state.dirty = false; state.emit('project', state.project); return; }
      }
      if (!test && await state.restore()) return; state.newProject();
    }
  };
  function schedule() { clearTimeout(timer); if (!test) timer = setTimeout(() => state.save().catch(e => Kit.toast('Could not save: ' + e.message, { kind: 'bad' })), 2000); }
  /* An edit made just before leaving (mode switch, closing the tab) is saved, not lost to the timer. */
  const flushNow = () => (state.dirty && !test ? state.save() : saving);
  if (g.CPS3Studio && g.CPS3Studio.leaving) g.CPS3Studio.leaving(flushNow);
  if (!test && g.CPS3Workspace) g.CPS3Workspace.register('music', { restore(value) {
    state.project = SF3Compile.normalize(value); state.selection = state.project.ui.selection || {}; history.length = future.length = 0; lastEdit = null; changed();
  } });
  g.addEventListener('pagehide', () => { flushNow(); });
  g.document.addEventListener('visibilitychange', () => { if (g.document.visibilityState === 'hidden') flushNow(); });
  function changed() { state.revision++; cache.clear(); state.dirty = true; schedule(); state.emit('project', state.project); }
  S.edit = (...args) => state.edit(...args); S.on = (...args) => state.on(...args);
  S.views = new Map(); S.view = spec => { if (!spec.id || !spec.mount) throw new Error('A view needs an id and mount function.'); S.views.set(spec.id, spec); if (S.activeView === spec.id && S.showView) S.showView(spec.id); };
})(window);
