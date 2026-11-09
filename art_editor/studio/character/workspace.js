'use strict';
window.ArtCharacterWorkspace = function (config) {
  const $ = id => document.getElementById(id), documents = new Map(), records = new Map(), saved = new Map(), dirty = new Set();
  let project, editor, active, loading = false, saving = false, activeSave = null, elapsed = 0, lastTime = 0, stage;
  const avatar = new URLSearchParams(location.search).get('avatar');
  const ALL = new URLSearchParams(location.search).get('all') === '1', allQuery = ALL ? 'all=1' : '';
  const hudBase = '';
  const storageKey = name => 'studio.character.' + config.id + (avatar ? '.avatar.' + avatar : '') + '.' + name;
  const api = name => config.api + '/' + name;
  const endpoint = name => avatar ? hudBase + '/api/hud/' + name + (name === 'save' ? '' : '?avatar=' + encodeURIComponent(avatar)) : '/api/' + name + (name === 'project' && ALL ? '?all=1' : '');
  if (avatar) document.body.classList.add('hud-workspace');
  async function avatarList() {
    try {
      let catalog;
      const q = ALL ? '?all=1' : '';
      catalog = await request('/api/hud/catalog' + q);
      $('avatars').replaceChildren();
      for (const entry of catalog.entries) {
        const link = document.createElement('a'); link.textContent = entry.name;
        link.href = CPS3CharacterProjects.url(config.id, {avatar: entry.key, ...(ALL ? {all: '1'} : {})}); link.classList.toggle('on', avatar === entry.key);
        $('avatars').append(link);
      }
      if (avatar) { const link = document.createElement('a'); link.href = CPS3CharacterProjects.url(config.id, ALL ? {all: '1'} : {}); link.textContent = 'Body sprites & animations'; $('avatars').append(link); }
    } catch (error) { $('avatars').textContent = 'Avatars and select art unavailable: ' + error.message; }
  }
  const decode = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));
  const encode = bytes => { let text = ''; for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192)); return btoa(text); };
  const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
  function message(text, error = false) { $('message').textContent = text; $('message').classList.toggle('error', error); }
  const esc = s => String(s).replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
  async function request(url, options) { const response = await fetch(url.startsWith('/api/') ? api(url.slice(5)) : url, options); const result = await response.json(); if (!response.ok) throw Error(result.error || response.statusText); return result; }
  function updateDirty() {
    $('dirty').textContent = dirty.size ? dirty.size + ' unsaved' : 'Saved';
    $('save').disabled = !dirty.size || saving || loading;
    for (const button of $('drawings').children) button.classList.toggle('changed', dirty.has(+button.dataset.id));
  }
  function changed({doc, spriteId}) {
    if (!records.get(spriteId)?.editable) return;
    if (same(ArtDoc.flatten(doc), saved.get(spriteId))) dirty.delete(spriteId); else dirty.add(spriteId);
    updateDirty();
  }
  function frameInfo() {
    if (!editor || !active) return;
    const a = editor.state, i = a.playing ? a.previewIndex : a.frameIndex, f = active.frames[i], r = records.get(a.spriteId);
    const previewTicks = ArtCharacterPlayback.durations([f], $('short-holds').checked)[0], wired = !String(active.id).startsWith('unwired:');
    $('frame').textContent = `${i + 1} / ${active.frames.length} · ${previewTicks} ticks${wired && previewTicks !== f.duration ? ' preview / ' + f.duration + ' game' : ''}`;
    if (document.activeElement !== $('ticks')) $('ticks').value = previewTicks;
    $('sprite-label').textContent = `Sprite ${a.spriteId} · ${r?.editable ? 'editable PNG' : 'original reference'}`;
    $('play').textContent = a.playing ? 'Pause' : 'Play';
    $('loop').checked = a.loop;
    $('export').disabled = !r?.editable;
    window.ArtCharacterTimeline?.refresh();
    rememberPosition();
  }
  function readPosition() {
    try { return JSON.parse(localStorage.getItem(storageKey('position')) || '{}'); } catch (_) { return {}; }
  }
  function rememberPosition() {
    if (!editor || !active || loading || editor.state.playing) return;
    try { localStorage.setItem(storageKey('position'), JSON.stringify({animation: active.id, sprite: editor.state.spriteId, frame: editor.state.frameIndex, palette: Number($('colour').value)})); } catch (_) {}
  }
  function fit() {
    if (!editor?.state.doc) return;
    const a = editor.state, bounds = a.canvas.host.getBoundingClientRect();
    editor.setView({zoom: Math.max(1, Math.floor(Math.min((bounds.width - 60) / a.doc.width, (bounds.height - 40) / a.doc.height)))});
  }
  function stageFor(frames) {
    const list = frames.map(f => records.get(f.spriteId));
    const left = Math.min(-20, ...list.map(r => r.x0)), right = Math.max(20, ...list.map(r => r.x0 + r.width));
    const bounds = {left, right, top: Math.min(-20, ...list.map(r => r.y0)), bottom: Math.max(8, ...list.map(r => r.y0 + r.height))};
    if (frames.some(f => window.ArtCharacterEffects?.data.poses[f.spriteId])) {
      const s = ArtCharacterEffects.data.stage; bounds.left=Math.min(bounds.left,s[0]); bounds.right=Math.max(bounds.right,s[2]); bounds.top=Math.min(bounds.top,s[1]);
    }
    return bounds;
  }
  function renderPreview(canvas, id, doc, options) {
    const dpr = devicePixelRatio || 1, w = options.width, h = options.height;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    const c = canvas.getContext('2d'); c.scale(dpr, dpr); c.imageSmoothingEnabled = false;
    c.fillStyle = '#171b22'; c.fillRect(0, 0, w, h);
    if (!doc || !stage) return;
    const r = records.get(id), span = Math.max(Math.abs(stage.left), Math.abs(stage.right)) * 2;
    const asp = options.arcade ? 7 / 9 : 1;                      // 4:3 screen: each pixel 7/9 as wide as tall
    const scale = Math.min((w - 24) / (span * asp), (h - 18) / (stage.bottom - stage.top));
    const ox = w / 2, oy = 8 - stage.top * scale;
    c.strokeStyle = '#39404b'; c.beginPath(); c.moveTo(0, oy); c.lineTo(w, oy); c.moveTo(ox, 0); c.lineTo(ox, h); c.stroke();
    c.translate(ox, oy); c.scale((options.flip ? -scale : scale) * asp, options.flipY ? -scale : scale);
    const body = editor ? editor.state.getImage(doc) : ArtPreview.image(doc, project.palettes.find(p => p.id === project.defaultPalette).colours);
    const aura = $('aura').checked && window.ArtCharacterEffects?.render(id, body, [r.x0,r.y0], editor?.state.playbackElapsed || 0);
    if (aura) c.drawImage(aura.image, aura.origin[0], aura.origin[1]); else c.drawImage(body, r.x0, r.y0);
  }
  function choose(animation, sprite) {
    active = animation; elapsed = 0; stage = stageFor(animation.frames);
    editor.setFrames(animation.frames, documents);
    if (sprite !== undefined) { const index = animation.frames.findIndex(f => f.spriteId === sprite); if (index >= 0) editor.state.setFrame(index); }
    const added = newFrames(animation);
    $('move-name').textContent = animation.name + (added ? ` · ${added} new frame${added > 1 ? 's' : ''}` : '');
    $('quality').disabled = !rateable(animation); $('quality').value = rateable(animation) ? String(qualityOf(animation) ?? '') : '';
    $('move-input').textContent = animation.input || animation.detail || (animation.source || 'Drawing available for manual cleanup');
    $('move-input').title = [animation.detail, animation.source].filter(Boolean).join('\n');
    const commandText = animation.commands?.length ? ` Includes ${animation.commands.length} command records; branches are shown in stored order.` : '';
    $('preview-note').textContent = avatar ? project.previewNote : 'Short holds speeds up long waits for preview only. Turn it off for recorded holds. Effect previews use separate layers; movement and hit detection are not simulated.' + commandText;
    for (const button of $('moves').children) button.classList.toggle('on', button.dataset.id === animation.id);
    frameInfo(); fit();
  }
  function openDrawing(id) {
    const current = active?.frames.some(f => f.spriteId === id) && active.id !== 'drawings' ? active : project.animations.find(a => a.frames.some(f => f.spriteId === id));
    choose(current || {id: 'drawings', name: 'New drawings', input: 'Individual drawings, including parts used as effects.', frames: [...records.values()].filter(r => r.editable).map(r => ({spriteId: r.id, duration: 8})), commands: []}, id);
  }
  const ALIASES = [[/stance/, 'neutral idle stance'], [/walk forward/, 'walk_f walk fwd'], [/walk back/, 'walk_b backward'],
                   [/crouch/, 'crouch duck'], [/taunt/, 'taunt personal action'], [/win pose/, 'victory win'],
                   [/round entry/, 'intro entrance'], [/shoryuken/, 'dp uppercut srk dragon punch'], [/tatsu/, 'tatsumaki'],
                   [/hadouken|air fireball/, 'fireball hadoken'], [/metsu hadouken/, 'sa1 super'], [/messatsu goshoryu/, 'sa2 super'],
                   [/hurricane \(sa3/, 'sa3 super tornado senpuu'], [/raging demon/, 'shun goku satsu sgs super'],
                   [/ryusokyaku/, 'axe kick overhead'], [/hop kick/, 'overhead uoh'], [/parry/, 'parry headbutt'],
                   [/block|guard/, 'block guard']];
  function searchText(animation) {
    const base = `${animation.name} ${animation.reference ? '' : animation.input || ''} ${animation.section} ${animation.slot} ${animation.frames.map(f => f.spriteId + ' ' + (f.gameCel || '')).join(' ')}`.toLowerCase();
    return base + ' ' + ALIASES.filter(([re]) => re.test(base)).map(([, words]) => words).join(' ') + (newFrames(animation) ? ' new frames inbetween in-between' : '');
  }
  const mtimeOf = id => { const sig = project?.sigs?.[id]; return sig ? Number(sig.split(':')[0]) / 1e6 : 0; };
  const recency = animation => Math.max(0, ...animation.frames.filter(f => records.get(f.spriteId)?.editable).map(f => mtimeOf(f.spriteId)));
  function ago(ms) {
    if (!ms) return ''; const d = new Date(ms), now = new Date(), mins = Math.round((now - d) / 60000), hhmm = d.toTimeString().slice(0, 5);
    if (mins < 1) return 'just now'; if (mins < 60) return `${mins} min ago`;
    const day = Math.floor((new Date(now.getFullYear(), now.getMonth(), now.getDate()) - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000);
    return day === 0 ? `today ${hhmm}` : day === 1 ? `yesterday ${hhmm}` : day < 7 ? `${day} days ago` : d.toISOString().slice(0, 10);
  }
  const sortMode = () => { try { return localStorage.getItem(storageKey('sort')) || 'recent'; } catch (e) { return 'recent'; } };
  const newFrames = animation => animation.frames.filter(f => String(f.key || '').startsWith('new:')).length;
  const qualityOf = animation => Number.isInteger(animation?.quality) ? animation.quality : null;
  const workRank = animation => qualityOf(animation) ?? (newFrames(animation) ? 10.5 : 11);
  const rateable = animation => !!animation && !avatar && !animation.reference && animation.id !== 'drawings';
  function badges(animation) {
    const span = document.createElement('span'); span.className = 'character-badges';
    const n = newFrames(animation), q = qualityOf(animation);
    if (n) { const b = document.createElement('span'); b.className = 'character-badge new'; b.textContent = `+${n} new`; b.title = `${n} frame${n > 1 ? 's' : ''} added by a drawing plan, not in the game build yet`; span.append(b); }
    if (q !== null) { const b = document.createElement('span'); b.className = 'character-badge q ' + (q <= 4 ? 'low' : q <= 7 ? 'mid' : 'high'); b.textContent = `${q}/10`; b.title = 'Your quality mark'; span.append(b); }
    return span;
  }
  const tabOf = () => { try { return localStorage.getItem(storageKey('tab')) || 'his'; } catch (e) { return 'his'; } };
  function library() {
    const words = $('search').value.trim().toLowerCase().split(/\s+/).filter(Boolean); $('moves').replaceChildren();
    const tab = tabOf(); for (const b of document.querySelectorAll('.character-tab')) b.classList.toggle('on', b.dataset.tab === tab);
    const list = project.animations.filter(a => (a.reference) === (tab === 'reference'));
    if (sortMode() === 'recent' && tab !== 'reference') list.sort((a, b) => (b.priority || 0) - (a.priority || 0) || recency(b) - recency(a));   // his starred items stay first; ties keep the stored order
    else if (sortMode() === 'work' && tab !== 'reference') list.sort((a, b) => workRank(a) - workRank(b) || recency(b) - recency(a));
    for (const animation of list) {
      if (words.length && !words.every(w => searchText(animation).includes(w))) continue;
      const button = document.createElement('button'); button.className = 'character-move'; button.dataset.id = animation.id;
      const name = document.createElement('b'); name.textContent = animation.name;
      const detail = document.createElement('small'); const edits = new Set(animation.frames.filter(f => records.get(f.spriteId).editable).map(f => f.spriteId));
      const when = ago(recency(animation));
      detail.textContent = `${animation.section} ${animation.slot} · ${animation.frames.length} frames${edits.size ? ' · ' + edits.size + ' drawings' : ''}${when ? ' · saved ' + when : ''}`;
      const head = document.createElement('span'); head.className = 'character-move-head'; head.append(name, badges(animation));
      button.append(head, detail); button.onclick = () => choose(animation); button.classList.toggle('on', active?.id === animation.id); $('moves').append(button);
    }
  }
  function play() {
    const a = editor.state;
    if (!a.playing) elapsed = ArtCharacterPlayback.durations(active.frames, $('short-holds').checked).slice(0, a.frameIndex).reduce((sum, n) => sum + n, 0);
    else a.setFrame(a.previewIndex);
    a.playing = !a.playing; a.strip.mark(); frameInfo();
  }
  function tick(time) {
    const delta = lastTime ? Math.min(time - lastTime, 250) : 0; lastTime = time;
    if (editor?.state.playing && active) {
      const a = editor.state;
      elapsed += delta * project.rate * +$('speed').value / 1000;
      const cursor = ArtCharacterPlayback.at(active.frames, elapsed, a.loop, $('short-holds').checked), index = cursor.index;
      if (cursor.ended) { elapsed = cursor.total - 1; a.playing = false; }
      a.previewIndex = index; a.playbackElapsed = elapsed * 1000 / project.rate;
      a.preview.render(); a.strip.mark(); frameInfo();
      if (!a.playing) a.setFrame(index);
    }
    requestAnimationFrame(tick);
  }
  async function load() {
    if (loading || saving) return;
    if (dirty.size && !confirm('Reload will discard unsaved drawing changes. Continue?')) return;
    loading = true; updateDirty(); message('Loading the latest completed build and current drawings…');
    const resumed = readPosition();
    const previous = active?.id || resumed.animation, previousSprite = editor?.state.spriteId ?? resumed.sprite;
    const previousFrame = editor?.state.frameIndex ?? resumed.frame;
    try {
      const packet = await request(endpoint('project'));
      const ramps = (packet.ramps || []).map(r => r.slice());
      editor?.destroy(); editor = null; project = packet; documents.clear(); records.clear(); saved.clear(); dirty.clear();
      document.querySelector('[data-tab=his]').textContent = config.title;
      document.querySelector('[data-tab=reference]').textContent = project.referenceTitle || 'References';
      $('aura').closest('label').hidden = !window.ArtCharacterEffects;
      const palette = project.palettes.find(p => p.id === project.defaultPalette).colours;
      for (const r of project.sprites) {
        records.set(r.id, r); const pixels = decode(r.pens);
        const doc = ArtDoc.create({width: r.width, height: r.height, pixels, palette, hash: r.hash});
        doc.origin = {x: -r.x0, y: -r.y0}; doc.spriteId = r.id;
        if (!r.editable) doc.layers.forEach(layer => { layer.locked = true; });
        doc.ownedTiles = ArtDoc.tiles(doc); documents.set(r.id, doc); saved.set(r.id, pixels.slice());
      }
      for (const animation of project.animations) for (const f of animation.frames) f.origin = {...documents.get(f.spriteId).origin};
      $('colour').replaceChildren();
      for (const p of project.palettes) { const option = new Option(p.name, p.id); option.selected = p.id === project.defaultPalette; $('colour').add(option); }
      active = project.animations.find(a => a.id === previous) || project.animations[0];
      stage = stageFor(active.frames); const first = active.frames[0].spriteId;
      editor = ArtEdit.mount($('editor'), {doc: documents.get(first), spriteId: first, documents, frames: active.frames, palette, ramps,
        externalTransport: true, onPlay: play, onChange: changed, onFrame: frameInfo, onReadout: frameInfo, renderPreview,
        aspectToggle: true, arcade: (() => { try { return localStorage.getItem(storageKey('arcade')) === '1'; } catch (e) { return false; } })(), onAspect: on => { try { localStorage.setItem(storageKey('arcade'), on ? '1' : '0'); } catch (e) {} },
        parts: avatar ? [] : project.parts || [],
        inspector: {roomSentence: 'Save writes the indexed source PNG. The character build encodes it separately.'}});
      const a = editor.state, canPaint = a.canPaint, change = a.change;
      const baseCopy = a.copy, basePaste = a.paste;
      a.copy = whole => { baseCopy(whole); const r = records.get(a.spriteId); if (a.clipboard && r) a.clipboard.origin = {x0: r.x0, y0: r.y0, from: a.spriteId}; };
      a.paste = () => {
        const c = a.clipboard, r = records.get(a.spriteId), d = a.doc;
        if (!c || !d) return basePaste();
        const dx = c.origin && r ? c.origin.x0 - r.x0 : 0, dy = c.origin && r ? c.origin.y0 - r.y0 : 0;
        const W = d.width, H = d.height, X = c.x + dx, Y = c.y + dy;
        let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1, left = 0; const edges = new Set();
        for (let j = 0; j < c.height; j++) for (let i = 0; i < c.width; i++) {
          const k = j * c.width + i; if (!c.mask[k] || !c.pixels[k]) continue;
          const tx = X + i, ty = Y + j;
          if (tx < 0 || ty < 0 || tx >= W || ty >= H) {
            left++; if (tx < 0) edges.add('left'); if (tx >= W) edges.add('right'); if (ty < 0) edges.add('top'); if (ty >= H) edges.add('bottom'); continue;
          }
          x0 = Math.min(x0, i); y0 = Math.min(y0, j); x1 = Math.max(x1, i); y1 = Math.max(y1, j);
        }
        if (x1 < 0) { if (left) message(`All ${left} copied pixels fall outside drawing ${r?.id ?? ''}: nothing pasted.`, true); else basePaste(); return; }
        const w = x1 - x0 + 1, h = y1 - y0 + 1, pixels = new Uint8Array(w * h), mask = new Uint8Array(w * h);
        for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
          const k = (j + y0) * c.width + i + x0, tx = X + x0 + i, ty = Y + y0 + j;
          if (tx < 0 || ty < 0 || tx >= W || ty >= H) continue;
          mask[j * w + i] = c.mask[k]; pixels[j * w + i] = c.mask[k] ? c.pixels[k] : 0;
        }
        a.clipboard = Object.assign({}, c, {width: w, height: h, pixels, mask, x: X + x0, y: Y + y0});
        try { basePaste(); } finally { a.clipboard = c; }
        if (left) message(`Pasted; ${left} copied pixels fell past the ${[...edges].join(' and ')} edge of drawing ${r?.id ?? ''}'s canvas and were left out. Ctrl Z undoes. Ask for a bigger canvas if the pose needs them.`, true);
      };
      if (avatar) { a.pen = project.initialPen ?? 3; a.pens.render(); $('save-note').textContent = project.saveNote; }
      $('editor').querySelectorAll('.art-pens .art-pen').forEach((button, pen) => {
        button.style.display = pen < (project.penCount ?? 64) ? '' : 'none';
      });
      a.canPaint = () => { if (records.get(a.spriteId)?.editable) return canPaint(); offerCopy(); return false; };
      a.change = (label, fn) => { if (records.get(a.spriteId)?.editable || /^Select(ion| )/.test(label)) change(label, fn); else offerCopy(); };
      drawingList();
      $('build').textContent = `${project.build} · ${project.listing === 'all' ? 'everything on disk (all=1)' : 'in-game assets only'} · current drawing PNGs`;
      $('reload').classList.remove('primary'); warned = '';
      library(); choose(active, previousSprite);
      if (active.id === previous && Number.isInteger(previousFrame)) editor.state.setFrame(Math.min(previousFrame, active.frames.length - 1));
      if (project.palettes.some(p => p.id === resumed.palette)) { $('colour').value = resumed.palette; editor.setPalette(project.palettes.find(p => p.id === resumed.palette).colours); }
      frameInfo(); requestAnimationFrame(fit);
      const want = +location.hash.slice(1); if (want && records.has(want)) openDrawing(want);
      message(`Ready: ${project.sprites.filter(r => r.editable).length} drawings, every PNG in ${project.saveFolder}${project.wiringStale?.length ? ' (copy requests to re-check: ' + project.wiringStale.join(', ') + ')' : ''}. Paint, then Save drawings. Each save keeps a backup.`);
    } catch (error) { message(error.message, true); }
    finally { loading = false; updateDirty(); rememberPosition(); }
  }
  async function saveAll() {
    if (saving) return activeSave;
    if (loading) return false;
    editor?.state.canvas.finish();
    if (!dirty.size) return true;
    activeSave = saveDrawings();
    return activeSave;
  }
  async function saveDrawings() {
    editor.state.canvas.finish(); saving = true; updateDirty();
    let count = 0;
    try {
      for (const id of [...dirty]) {
        const r = records.get(id), pixels = ArtDoc.flatten(documents.get(id));
        const result = await request(endpoint('save'), {method: 'POST', headers: {'Content-Type': 'application/json', 'X-Studio-Token': project.token}, body: JSON.stringify({id, avatar, hash: r.hash, pens: encode(pixels)})});
        r.hash = result.hash; saved.set(id, pixels.slice()); changed({doc: documents.get(id), spriteId: id}); count++;
        const now = await request(endpoint('sigs')); project.sigs[id] = now[id];     // our own save is not an outside change
      }
      message(`Saved ${count} drawing${count === 1 ? '' : 's'} to ${project.saveFolder}. Backups kept; ` + (avatar ? project.saveMessage : 'rebuild the character to see them in game.'));
    } catch (error) { message((count ? `${count} saved. ` : '') + error.message, true); }
    finally { saving = false; updateDirty(); if (count) { library(); drawingList(); } }
    return dirty.size === 0;     // the saved move rises to the top of "Recent first"
  }
  async function exportDraft() {
    if (!editor || !records.get(editor.state.spriteId)?.editable) return;
    try {
      const doc = editor.state.doc, bytes = await ArtPng.write({width: doc.width, height: doc.height, pens: ArtDoc.flatten(doc), palette: editor.state.palette});
      const url = URL.createObjectURL(new Blob([bytes], {type: 'image/png'})), link = document.createElement('a');
      link.href = url; link.download = (avatar || editor.state.spriteId) + '-draft.png'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch (error) { message(error.message, true); }
  }
  function drawingList() {
    $('drawings').replaceChildren();
    const recent = sortMode() === 'recent';
    for (const r of project.sprites.filter(r => r.editable).sort((a, b) => recent ? (mtimeOf(b.id) - mtimeOf(a.id)) || (a.id - b.id) : a.id - b.id)) {
      const button = document.createElement('button'); button.className = 'btn'; button.textContent = r.id; button.dataset.id = r.id;
      const when = ago(mtimeOf(r.id)); button.title = (r.source || '') + (when ? ` · saved ${when}` : ''); button.onclick = () => openDrawing(r.id); $('drawings').append(button);
    }
    $('drawing-count').textContent = `(${project.sprites.filter(r => r.editable).length})`;
  }
  let asking = false;
  function offerCopy() {
    if (asking || !editor || !active || loading) return;
    const a = editor.state, id = a.spriteId, index = a.frameIndex;
    if (records.get(id)?.editable || !active.frames[index] || active.frames[index].spriteId !== id) return;
    asking = true; a.playing = false;
    const mine = project.animations.filter(x => !x.reference && x.animationEdit && !x.animationEdit.stale && x.frames.some(f => f.spriteId === id));
    const places = mine.reduce((n, x) => n + x.frames.filter(f => f.spriteId === id).length, 0);
    const everywhere = places > 1 ? `<button data-m="everywhere">A · Make it yours everywhere: one editable drawing for all ${places} frames in ${mine.length} move${mine.length > 1 ? 's' : ''} (${esc(mine.map(x => x.name).join(', '))})</button>` : '';
    const scrim = document.createElement('div'); scrim.className = 'character-ask';
    scrim.innerHTML = `<div class="character-ask-box" role="dialog" aria-modal="true"><b>Sprite ${id} is the reference character's own frame, shared with the reference character: read-only.</b>
      <span>Make an editable copy for this project for <i>${esc(active.name)}</i>, frame ${index + 1} of ${active.frames.length}?</span>
      ${everywhere}<button data-m="before">1 · Insert a copy before this frame</button><button data-m="after">2 · Insert a copy after this frame</button>
      <button data-m="replace">3 · Replace this frame with an editable duplicate</button><button data-m="">4 · Cancel</button>
      <small>The copy is saved at once as a new drawing (review panel too) and starts as the reference character's pixels. The game uses it after the next build wires it.</small></div>`;
    const close = () => { scrim.remove(); document.removeEventListener('keydown', key, true); asking = false; };
    const pick = mode => { close(); if (mode === 'everywhere') ownEverywhere(id, index); else if (mode) makeCopy(id, index, mode); };
    const key = e => { const m = {'1': 'before', '2': 'after', '3': 'replace', '4': '', Escape: '', ...(everywhere ? {a: 'everywhere', A: 'everywhere'} : {})}[e.key]; if (m !== undefined) { e.preventDefault(); e.stopPropagation(); pick(m); } };
    scrim.addEventListener('click', e => { const b = e.target.closest('button'); if (b) pick(b.dataset.m); else if (e.target === scrim) pick(''); });
    document.addEventListener('keydown', key, true); document.body.append(scrim); scrim.querySelector('button').focus();
  }
  async function ownEverywhere(id, index) {
    try {
      const pixels = ArtDoc.flatten(documents.get(id));
      const r = await request('/api/own-everywhere', {method: 'POST', headers: {'Content-Type': 'application/json', 'X-Studio-Token': project.token},
        body: JSON.stringify({source: id, sourcePens: records.get(id).pens, pens: encode(pixels)})});
      const here = active?.id;
      r.animations.forEach((animation, k) => adoptAnimation({animation, sprite: k ? null : r.sprite, spriteSig: r.spriteSig}, animation.id === here ? index : 0));
      if (active?.id === here) editor.state.setFrame(index);
      message(`Drawing ${r.sprite.id} is yours: ${r.frames} frames in ${r.animations.length} moves now show it instead of ${id}${r.skipped.length ? ' (skipped, plan out of date: ' + r.skipped.join(', ') + ')' : ''}. Paint it, then Save. Each move's Undo in Edit animation restores ${id}.`);
    } catch (error) { message('Not done: ' + error.message, true); }
  }
  async function makeCopy(id, index, mode) {
    try {
      const r = await request('/api/copy', {method: 'POST', headers: {'Content-Type': 'application/json', 'X-Studio-Token': project.token},
        body: JSON.stringify({id, mode, index, animation: active.id, name: active.name})});
      const pixels = decode(r.pens), palette = project.palettes.find(p => p.id === project.defaultPalette).colours;
      const doc = ArtDoc.create({width: r.width, height: r.height, pixels, palette, hash: r.hash});
      doc.origin = {x: -r.x0, y: -r.y0}; doc.spriteId = r.id; doc.ownedTiles = ArtDoc.tiles(doc);
      records.set(r.id, r); documents.set(r.id, doc); saved.set(r.id, pixels.slice()); project.sprites.push(r);
      const frame = Object.assign({}, active.frames[index], {spriteId: r.id, origin: {...doc.origin}});
      if (mode === 'replace') active.frames[index] = frame; else active.frames.splice(index + (mode === 'after' ? 1 : 0), 0, frame);
      project.sigs[r.id] = (await request('/api/sigs'))[r.id];
      drawingList(); library(); choose(active, r.id); updateDirty();
      message(`Drawing ${r.id} = editable copy of reference ${id} (${mode === 'replace' ? 'replaces it' : mode + ' it'}), saved in ${project.saveFolder}. Paint it, then Save. The next build wires it.`);
    } catch (error) {
      if (/saved sequence plan/.test(error.message) && active?.animationEdit && window.ArtCharacterTimeline) {
        editor.state.setFrame(index); await ArtCharacterTimeline.act(mode === 'replace' ? 'own' : mode); return;
      }
      message(error.message, true);
    }
  }
  function adoptAnimation(result, selected) {
    const r = result.sprite;
    if (r) {
      const pixels = decode(r.pens), palette = project.palettes.find(p => p.id === project.defaultPalette).colours;
      const doc = ArtDoc.create({width:r.width, height:r.height, pixels, palette, hash:r.hash});
      doc.origin = {x:-r.x0,y:-r.y0}; doc.spriteId=r.id; doc.ownedTiles=ArtDoc.tiles(doc);
      records.set(r.id,r); documents.set(r.id,doc); saved.set(r.id,pixels.slice()); project.sprites.push(r);
      project.sigs[r.id]=result.spriteSig;
    }
    const target=project.animations.find(a=>a.id===result.animation.id);
    Object.assign(target,result.animation);
    for(const f of target.frames) f.origin={...documents.get(f.spriteId).origin};
    if(active?.id===target.id) {choose(target); editor.state.setFrame(Math.min(selected,target.frames.length-1));}
    drawingList(); library(); updateDirty();
  }
  let warned = '';
  async function watch() {
    if (!project?.sigs || loading || saving) return;
    try {
      const now = await request(endpoint('sigs')), ids = Object.keys(now).filter(k => now[k] !== project.sigs[k]);
      const text = ids.join(' ');
      if (!text || text === warned) return;
      warned = text; $('reload').classList.add('primary');
      const mine = ids.filter(k => dirty.has(+k));
      message(`Changed on disk since you loaded: ${ids.slice(0, 12).join(', ')}${ids.length > 12 ? ' …' : ''}. ` +
        (mine.length ? `Your unsaved edits on ${mine.join(', ')} are on the older file: Export draft PNG first. ` : '') + 'Press "Reload from disk" for the newest.', true);
    } catch (error) { /* server restarting: try again */ }
  }
  setInterval(watch, 4000);
  window.addEventListener('hashchange', () => { const n = +location.hash.slice(1); if (n && records.has(n)) openDrawing(n); });
  $('avatars').addEventListener('click', event => {const link = event.target.closest('a');if (link && !event.ctrlKey && !event.metaKey) {event.preventDefault();CPS3Studio.navigate(link.href);}});
  $('reload').onclick = load; $('save').onclick = saveAll; $('export').onclick = exportDraft; $('search').oninput = library;
  $('sort').value = sortMode(); $('sort').onchange = () => { try { localStorage.setItem(storageKey('sort'), $('sort').value); } catch (e) {} if (project) { library(); drawingList(); } };
  $('play').onclick = () => editor && play();
  $('quality').onchange = async () => {                    // the 0-10 quality mark for the animation on screen
    if (!project || !rateable(active)) return;
    const target = active, value = $('quality').value, score = value === '' ? null : +value;
    try {
      await request('/api/quality', {method: 'POST', headers: {'Content-Type': 'application/json', 'X-Studio-Token': project.token},
        body: JSON.stringify({animation: target.id, score, name: target.name})});
      if (score === null) delete target.quality; else target.quality = score;
      library(); message(score === null ? `Quality mark cleared for ${target.name}` : `${target.name}: ${score}/10 saved`);
    } catch (error) { $('quality').value = String(qualityOf(target) ?? ''); message('Quality mark not saved: ' + error.message, true); }
  };
  for (const b of document.querySelectorAll('.character-tab')) b.onclick = () => { try { localStorage.setItem(storageKey('tab'), b.dataset.tab); } catch (e) {} if (project) library(); };
  $('ticks').onchange = async () => {                      // preview-only duration of the frame on screen
    if (!editor || !active) return;
    const a = editor.state, i = a.playing ? a.previewIndex : a.frameIndex, f = active.frames[i], raw = $('ticks').value.trim();
    const ticks = raw === '' ? null : Math.round(Number(raw));
    if (ticks !== null && !(ticks >= 1 && ticks <= 255)) { message('Ticks must be 1-255.', true); frameInfo(); return; }
    try {
      await request('/api/timing', {method: 'POST', headers: {'Content-Type': 'application/json', 'X-Studio-Token': project.token},
        body: JSON.stringify({animation: active.id, index: i, spriteId: f.spriteId, ticks})});
      if (ticks === null) delete f.previewDuration; else f.previewDuration = ticks;
      message(ticks === null ? `Frame ${i + 1}: preview duration cleared` : `Frame ${i + 1}: ${ticks} ticks (preview only; the game is unchanged)`);
    } catch (error) { message('Could not save the duration: ' + error.message, true); }
    frameInfo();
  };
  $('loop').onchange = () => { if (editor) { editor.state.loop = $('loop').checked; editor.state.strip.mark(); } };
  $('short-holds').onchange = () => { if (editor) { elapsed = 0; editor.state.previewIndex = 0; editor.state.preview.render(); frameInfo(); } };
  $('aura').onchange = () => editor?.state.preview.render();
  const step = amount => { if (!editor) return; editor.state.playing = false; editor.state.step(amount); frameInfo(); };
  $('previous').onclick = () => step(-1); $('next').onclick = () => step(1);
  $('fit').onclick = fit; $('help').onclick = () => editor?.state.help();
  $('colour').onchange = () => {editor.setPalette(project.palettes.find(p => p.id === +$('colour').value).colours);rememberPosition();};
  document.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); saveAll(); }
    if (event.target.closest?.('input,select,textarea,.scrim,.menu') || event.defaultPrevented) return;
    if (event.key === 'Enter') { event.preventDefault(); if (editor) play(); }
    if (event.key === ',') { event.preventDefault(); step(-1); }
    if (event.key === '.') { event.preventDefault(); step(1); }
  }, true);
  window.addEventListener('beforeunload', event => { if (dirty.size) { event.preventDefault(); event.returnValue = ''; } });
  const instance = window.ArtCharacter = {get editor() { return editor; }, get project() { return project; }, get active() { return active; }, get busy() {return saving||loading;}, documents, records, dirty, choose, openDrawing, saveAll, load, adoptAnimation, message, makeCopy, ownEverywhere, api, config, get saving() {return saving;}};
  requestAnimationFrame(tick);
  instance.ready = avatarList().then(load);
  return instance;
};
