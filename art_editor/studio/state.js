/* Project history belongs to the application, including edits made by prop-fed workspaces. */
(function (g) {
  'use strict';
  const A = g.ArtStudio = { views: new Map() }, copy = ArtDoc.copy, events = new Map();
  const past = [], future = [], histories = new WeakMap(), drafts = new Map(), images = new Map();
  const projects = Kit.store('art-projects'), versions = Kit.store('art-versions');
  let timer, saving = Promise.resolve(), serial = 0, restoring = false;
  const test = location.hash.includes('selftest') || location.hash.includes('review');
  const legacyLastKey = test ? 'art.test-last' : 'art.last';
  const lastKey = () => legacyLastKey+':'+S.romHash+':'+(S.source?.mode??'original');
  const S = A.state = {
    opened:new Set(),project: null, dirty: false, revision: 0, resources: null, romHash: '',source:null,
    on(name, fn) { if (!events.has(name)) events.set(name, new Set()); events.get(name).add(fn); return () => events.get(name).delete(fn); },
    emit(name, value) { for (const fn of events.get(name) || []) fn(value); },
    image(id) {
      id = Number(id); if (images.has(id)) { const im = images.get(id); images.delete(id); images.set(id, im); return im; }
      const im = S.resources.image(id); images.set(id, im);
      if (images.size > 128) images.delete(images.keys().next().value); return im;
    },
    baseline(id) { const im = S.image(id); return { width: im.width, height: im.height, pens: im.pixels, origin: { x: -im.bounds[0], y: -im.bounds[1] } }; },
    previewDocument(id) { const saved=S.project.sprites[id]||drafts.get(Number(id));if(saved)return saved;const im=S.image(id);return {width:im.width,height:im.height,origin:S.baseline(id).origin,original:im.pixels,layers:[{kind:'paint',visible:true,pixels:im.pixels}]}; },
    document(id) {
      id = Number(id);S.opened.add(id); if (S.project.sprites[id]) return S.project.sprites[id];
      if (drafts.has(id)) return drafts.get(id);
      const im = S.image(id); if (im.pixels.some((p,i) => p > 63||p&&im.bits[i]===8)) throw new Error(ArtLimits.reason('sprite.eightbit'));
      if(new Set(im.paletteRows.filter((_,i)=>im.pixels[i])).size>1)throw new Error('This sprite uses several palette rows. Indexed painting for this layout is not yet available.');
      const owned = new Map(), shape = ArtCel.geometry(S.resources.descriptor(id));
      for (const cell of shape) for (let y = Math.floor((cell.top - im.bounds[1]) / 16); y < Math.ceil((cell.top - im.bounds[1] + cell.height) / 16); y++) for (let x = Math.floor((cell.left - im.bounds[0]) / 16); x < Math.ceil((cell.left - im.bounds[0] + cell.width) / 16); x++) owned.set(x + ',' + y, { x, y });
      const origin=S.baseline(id).origin,palette=A.palette?.(id);
      /* Native anchors can lie outside a tight sprite. Preserve them without padding or clamping.
         ArtDoc.create currently accepts only interior anchors; its layer operations accept this record. */
      let d;
      if(origin.x>=0&&origin.x<im.width&&origin.y>=0&&origin.y<im.height)d=ArtDoc.create({width:im.width,height:im.height,pixels:im.pixels,origin,ownedTiles:[...owned.values()],palette});
      else {d={width:im.width,height:im.height,origin,hash:'',layers:[],nextLayer:1,ownedTiles:[...owned.values()],original:im.pixels.slice(),selection:null};ArtDoc.addLayer(d,'paint','Paint',{pixels:im.pixels});ArtDoc.addLayer(d,'reference','Original',{rgba:ArtPng.toRgba(im.pixels,palette),visible:false,locked:true});}
      d.spriteId=id;
      drafts.set(id, d); return d;
    },
    history(doc, id) {
      let h = histories.get(doc); if (h) return h;
      h = new ArtHistory.History(doc); const commit = h.commit.bind(h);
      h.commit = () => { const wasPresent = !!S.project.sprites[id], changed = commit(); if (changed && !restoring) {
        const command = h.commands[h.cursor - 1],substantive=wasPresent||command.patches.length||JSON.stringify(command.before.layers)!==JSON.stringify(command.after.layers);
        past.push({ label: command.label, undo() { h.apply(command, 'before'); h.cursor--; if (!wasPresent) delete S.project.sprites[id]; }, redo() { h.apply(command, 'after'); h.cursor++; if(substantive)S.project.sprites[id] = doc; } });
        if(substantive)S.project.sprites[id] = doc; future.length = 0; S.changed();
      } return changed; }; histories.set(doc, h); return h;
    },
    groupHistory(count) { if(count>1){const members=past.splice(-count);past.push({label:'Edit selected sprites',undo(){for(const m of members.slice().reverse())m.undo();},redo(){for(const m of members)m.redo();}});} },
    edit(label, fn) {
      const before = copy(S.project); try { fn(S.project); } catch (e) { S.project = before; throw e; }
      const after = copy(S.project); if (JSON.stringify(ArtDoc.serial(before)) === JSON.stringify(ArtDoc.serial(after))) return false;
      past.push({ label, undo: () => S.replace(before), redo: () => S.replace(after) }); future.length = 0; S.changed(); return true;
    },
    /* coalesce: this change continues a run of key nudges on the same pens; it joins the run's undo step. */
    paletteChange(snapshot, coalesce) {
      /* Rows that did not change are shared with the previous state instead of deep-copied (a ROM has thousands of rows:
         two whole copies and two JSON texts per colour edit cost a quarter of a second). Nothing changes a stored row in
         place; the live object gets its own words map, so a later Fix that drops a row leaves this history intact. */
      const prior = S.project.paletteEdits, top = past[past.length - 1];
      const same = (a, b) => a === b || !!a && !!b && a.length === b.length && a.every((w, i) => w === b[i]);
      const words = {}; let differs = !prior || !prior.words || prior.name !== snapshot.name;
      for (const [id, w] of Object.entries(snapshot.words || {})) { const was = prior && prior.words && prior.words[id]; if (was && same(was, w)) words[id] = was; else { words[id] = Array.from(w); differs = true; } }
      if (prior && prior.words) for (const id of Object.keys(prior.words)) if (!(id in words)) differs = true;
      let groups = snapshot.editorGroups;
      if (prior && prior.editorGroups && (prior.editorGroupsRef === groups || JSON.stringify(prior.editorGroups) === JSON.stringify(groups))) groups = prior.editorGroups; else { groups = copy(groups); differs = true; }
      const after = { ...snapshot, words, editorGroups: groups }; Object.defineProperty(after, 'editorGroupsRef', { value: snapshot.editorGroups, enumerable: false });
      if (restoring || !differs) return;
      const before = prior, live = () => ({ ...after, words: { ...after.words } });
      if (coalesce && top && top.palette && !future.length) { top.redo = () => { S.project.paletteEdits = copy(after); }; S.project.paletteEdits = live(); S.changed(); return; }
      past.push({ label: 'Change colours', palette: true, undo: () => { S.project.paletteEdits = before ? copy(before) : before; }, redo: () => { S.project.paletteEdits = copy(after); } });
      S.project.paletteEdits = live(); future.length = 0; S.changed();
    },
    replace(value) {
      /* Retain document identities: existing history commands refer to these objects. */
      const next = copy(value);
      for (const [id, doc] of Object.entries(next.sprites)) { const live = S.project.sprites[id] || drafts.get(Number(id)); if (live) { for (const k of Object.keys(live)) delete live[k]; Object.assign(live, doc); next.sprites[id] = live; } }
      S.project = next;
    },
    undo() { A.editor?.state.canvas.finish(); const x = past.pop(); if (!x) return false; restoring = true; try { x.undo(); } finally { restoring = false; } future.push(x); S.changed(); S.emit('history'); return true; },
    redo() { A.editor?.state.canvas.finish(); const x = future.pop(); if (!x) return false; restoring = true; try { x.redo(); } finally { restoring = false; } past.push(x); S.changed(); S.emit('history'); return true; },
    get canUndo() { return !!past.length; }, get canRedo() { return !!future.length; },
    changed() { S.revision++; S.dirty = true; if(A.editor?.state.doc&&S.project.sprites[A.editor.state.spriteId]){S.project.ui.lastEditedSprite=A.editor.state.spriteId;S.project.ui.lastEditedCharacter=A.library.character;S.project.ui.lastEditedColour=S.project.ui.colour??0;} S.schedule(); S.emit('project', S.project); },
    schedule() { clearTimeout(timer); timer = setTimeout(() => S.save().catch(e => { S.emit('saveError', e); Kit.status('Could not save: ' + e.message + '. Export your project to keep it.'); }), 800); },
    async save() {
      clearTimeout(timer); if (!S.project) return; const value = copy(S.project), revision = S.revision,source=S.source,resources=S.resources,sourceLastKey=lastKey(),palette=A.palette(); value.time=Date.now(); for(const doc of Object.values(value.sprites))doc.layers=doc.layers.filter(l=>!l.guide);
      saving = saving.catch(() => {}).then(async () => {
        await projects.set(value.id, value); await Kit.store.kv.set(sourceLastKey, value.id);
        await versions.set(value.id + ':' + Date.now() + ':' + String(++serial).padStart(8, '0'), value);
        const keys = (await versions.keys()).filter(k => k.startsWith(value.id + ':')).sort(); for (const key of keys.slice(0, -20)) await versions.del(key);
        if (!test && g.CPS3Workspace && g.CPS3Sources.equal(source,g.CPS3Studio.source())) {
          const bytes = await ArtDelivery.save(value, { resources }, palette);
          if(!g.CPS3Sources.equal(source,g.CPS3Studio.source()))return;
          await g.CPS3Workspace.setDocument('art', { archive: g.CPS3Workspace.encode(bytes), ui: copy(value.ui), id: value.id }, 'cps3art-project', 1,source);
        }
        if (S.revision === revision) { S.dirty = false; S.emit('saved', true); }
      }); return saving;
    },
    /* A project holding no work: no sprites, colours or imports, and never renamed. */
    blank(p) { return !!p && !Object.keys(p.sprites || {}).length && !p.paletteEdits && !(p.imports || []).length && p.name === 'Untitled art'; },
    async recent() { return (await Promise.all((await projects.keys()).map(id => projects.get(id)))).filter(p => p?.romHash === S.romHash && !S.blank(p)).map(p => {const spriteId=p.sprites[p.ui.lastEditedSprite]?p.ui.lastEditedSprite:Object.keys(p.sprites).at(-1);return { id:p.id,name:p.name,time:p.time||0,spriteId,document:p.sprites[spriteId],character:p.ui.lastEditedCharacter??p.ui.character??2,colour:p.ui.lastEditedColour??p.ui.colour??0,paletteWords:p.paletteEdits?.words };}); },
    async versions(id) { return (await versions.keys()).filter(k => k.startsWith(id + ':')).sort().reverse(); },
    async restore(id, versionKey) {
      id = id || await Kit.store.kv.get(lastKey());
      if(!id&&!versionKey){const old=await Kit.store.kv.get(legacyLastKey),p=old&&await projects.get(old);if(p?.romHash===S.romHash)id=old;}
      const p = versionKey ? await versions.get(versionKey) : id && await projects.get(id); if (!p) return false;
      if (p.romHash !== S.romHash) throw new Error('This project needs the same ROM it started from.');
      const next=copy(p);A.normaliseColours?.(next);S.project = next; drafts.clear(); past.length = future.length = 0; S.revision++; S.dirty = false; S.emit('project', next); return true;
    },
    newProject(project) {
      const next = { id: 'art-' + crypto.randomUUID(), name: 'Untitled art', romHash: S.romHash, sprites: {}, paletteEdits: null, imports: [], ui: {}, ...copy(project || {}), time: Date.now() };
      A.normaliseColours?.(next);S.project=next;
      drafts.clear(); past.length = future.length = 0;
      /* A blank project is saved with its first change, so opening Art never lists an empty "Untitled art". */
      if (S.blank(next)) { S.revision++; S.dirty = false; S.emit('project', next); } else S.changed();
      return S.project;
    },
    async init(rom) {
      if ((!rom.supported&&!g.CPS3Studio?.identify(rom)) || !rom.program || !rom.data) throw new Error('Art needs the complete program and graphics from a registered game source.');
      S.resources = new ArtCel.Resources(rom.program, rom.data);
      S.source=g.CPS3Sources.identity(rom.source||g.CPS3Studio.source());
      /* ROM identity hashes bytes directly, never interpreted as pens. */
      S.romHash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', rom.program))].map(n => n.toString(16).padStart(2, '0')).join('');
      if (!test && g.CPS3Workspace) { const doc = await g.CPS3Workspace.document('art'); if (doc) { await restoreShared(doc.value); return; } }
      if ((!test || !location.hash.includes('selftest')) && await S.restore()) return; S.newProject();
    },
    async projectBytes() { const baselines = Object.fromEntries(Object.keys(S.project.sprites).map(id => [id, S.baseline(id)])); const entries=await KitZip.read(await ArtFormats.saveProject(S.project, { baselines, palette: A.palette() }));entries['workspace.json']=new TextEncoder().encode(JSON.stringify({version:1,ui:S.project.ui}));return KitZip.write(entries); },
    async open(file) {
      const bytes = new Uint8Array(await file.arrayBuffer()), entries = await KitZip.read(bytes), manifest = JSON.parse(new TextDecoder().decode(entries['project.json']));
      const baselines = Object.fromEntries(manifest.sprites.map(x => [x.spriteId, S.baseline(x.spriteId)]));
      const project = await ArtFormats.openProject(bytes, { romHash: S.romHash, baselines }); if(entries['workspace.json']){const workspace=JSON.parse(new TextDecoder().decode(entries['workspace.json']));if(workspace.version!==1||!workspace.ui||typeof workspace.ui!=='object')throw new Error('This project has damaged workspace names or colours.');project.ui=workspace.ui;}await S.save(); S.newProject(project); return project;
    }
  };
  A.on = S.on; A.view = spec => A.views.set(spec.id, spec);
  async function restoreShared(value) {
    const project = await ArtDelivery.open(g.CPS3Workspace.decode(value.archive), { program: S.resources.program, data: S.resources.data });
    const next={ ...project, id: value.id, ui: copy(value.ui || {}), time: Date.now() };A.normaliseColours?.(next);S.project=next; drafts.clear(); past.length = future.length = 0; S.revision++; S.dirty = false; S.emit('project', S.project);
  }
  if (!test && g.CPS3Workspace) g.CPS3Workspace.register('art', { restore: restoreShared });
  g.addEventListener('pagehide', () => S.save());
  if (g.CPS3Studio && g.CPS3Studio.leaving) g.CPS3Studio.leaving(() => S.save());
})(window);
