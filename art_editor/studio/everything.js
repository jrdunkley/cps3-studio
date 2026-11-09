/* Everything: every sprite the game stores, visible and explorable, named or not.
 *
 * ArtEverything.mount(root, { rom, onOpen?, status?, names?, groups?, onName?, onLabels? }) -> { select(id), destroy() }
 * Labels: the artist's names and categories, key (sprite number or unit key) -> text. Several pictures can be
 * chosen (Ctrl-click, Shift-click, Ctrl A) and labelled together; categories appear under "My labels".
 * Reads the user's ROM through ArtCel / ArtAnim / ArtNames / ArtPalette only; nothing is stored.
 * Sections are data (ArtEverything.sections(model)), so further catalogues can be added to them.
 */
(function (g) {
  'use strict';
  const SIZES = { large: { w: 124, h: 136, tw: 108, th: 100, up: 2 }, small: { w: 62, h: 66, tw: 56, th: 48, up: 1 } }, BLOCK = 1024, CACHE = 4000;

  function h(spec, attrs, ...kids) {
    const [tag, ...classes] = spec.split('.'), node = document.createElement(tag || 'div');
    if (classes.length) node.className = classes.join(' ');
    for (const [k, v] of Object.entries(attrs || {})) { if (k.startsWith('on')) node[k] = v; else if (v === true) node.setAttribute(k, ''); else if (v !== false && v != null) node.setAttribute(k, v); }
    for (const kid of kids.flat()) if (kid != null) node.append(kid);
    return node;
  }
  const count = n => n.toLocaleString('en-GB');
  let mounts = 0;
  const pretty = label => label.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
  const range = b => `${count(b * BLOCK)} – ${count(b * BLOCK + BLOCK - 1)}`;

  /* A palette for pictures whose real colours are not known: 8 hues, 8 steps of light each,
     so shapes and shading read clearly. It is labelled as such wherever it is used. */
  const clear = Array.from({ length: 64 }, (_, p) => {
    const hue = (p >> 3) * 45, light = .22 + (p & 7) * .095, c = (1 - Math.abs(2 * light - 1)) * .62, x = c * (1 - Math.abs((hue / 60) % 2 - 1)), m = light - c / 2;
    const [r, gr, b] = hue < 60 ? [c, x, 0] : hue < 120 ? [x, c, 0] : hue < 180 ? [0, c, x] : hue < 240 ? [0, x, c] : hue < 300 ? [x, 0, c] : [c, 0, x];
    return [Math.round((r + m) * 255), Math.round((gr + m) * 255), Math.round((b + m) * 255), p ? 255 : 0];
  });
  const grey = Array.from({ length: 64 }, (_, p) => { const v = Math.floor(p * 255 / 63); return [v, v, v, p ? 255 : 0]; });

  /* The model: one row per stored sprite, with who lists it. Built once from the ROM. */
  function model(rom) {
    const res = new ArtCel.Resources(rom.program, rom.data), cat = ArtNames.catalogue(rom.program, ArtAnim), rows = cat.rows.slice().sort((a, b) => a.sprite - b.sprite);
    let alone = 0, repeats = 0; const seen = new Set();
    for (const r of rows) {
      try { const d = res.descriptor(r.sprite); r.cells = d.count; r.drawable = d.records.every(x => (x.shape & 3) && (x.shape >>> 2));
        /* The same stored picture under another number (same stored bytes, same layout). */
        const sig = d.tableWord + '|' + d.uploads.map(u => u.source + ':' + u.length + ':' + u.dest).join(',') + '|' + d.records.map(x => [x.code, x.attributes, x.x, x.y, x.shape].join(':')).join(','); r.repeat = seen.has(sig); seen.add(sig); if (r.repeat) repeats++; }
      catch (e) { r.cells = 0; r.drawable = false; r.problem = e.message; }
      if (!r.drawable) alone++;
      r.effects = r.labels.filter(l => !l.startsWith('Shared animation set '));
      r.sets = [...new Set(r.labels.filter(l => l.startsWith('Shared animation set ')).map(l => l.split(', slot ')[0]))];
      r.kind = r.owners.length ? 'character' : r.effects.length ? 'effect' : r.sets.length ? 'set' : 'unlisted';
    }
    /* A sprite in no list that sits among one character's numbers is very likely that
       character's (a frame no animation reaches). Kept as a hint for colours and words, not a fact. */
    const NEAR = 96; let before = null;
    for (const r of rows) { if (r.owners.length === 1) before = r; else if (!r.owners.length && before && r.sprite - before.sprite <= NEAR) r.near = before.owners[0]; }
    let after = null;
    for (let i = rows.length - 1; i >= 0; i--) { const r = rows[i]; if (r.owners.length === 1) after = r; else if (!r.owners.length && r.near == null && after && after.sprite - r.sprite <= NEAR) r.near = after.owners[0]; }
    /* Sprites a stage's own animation tables draw take that stage's stored colours (js/truecolours.js). */
    let stageDrawn = new Map(); try { if (g.ArtTrueColours) stageDrawn = ArtTrueColours.stageContexts(rom.program); } catch (e) { stageDrawn = new Map(); }
    for (const r of rows) { r.stageContexts = stageDrawn.get(r.sprite) || []; r.sceneContext = g.ArtTrueColours?.sceneContext(rom.program, r.sprite, rom.sha256); }
    /* Pictures in the unused-content census's groups (js/cutcontent.js): a cut animation, art never-created effects load. */
    let cut = new Map(), cutFamilies = []; try { if (g.ArtCutContent) { cut = ArtCutContent.classify(rom.program, rom.sha256); cutFamilies = ArtCutContent.families(rom.program, rom.sha256); } } catch (e) { cut = new Map(); cutFamilies = []; }
    for (const r of rows) r.cut = cut.get(r.sprite) || null;
    return { res, rows, byId: new Map(rows.map(r => [r.sprite, r])), names: ArtNames.words.characters, alone, repeats, rom, stages: stageUnits(rom), tiles: tileUnits(rom), cutFamilies };
  }

  /* The other two places pictures are stored: stage layers and the 8 × 8 interface tiles.
     Each unit draws itself on demand, so nothing is decoded until it is looked at. */
  function canvasOf(width, height, rgba) { const c = document.createElement('canvas'); c.width = width; c.height = height; const ctx = c.getContext('2d'), d = ctx.createImageData(width, height); d.data.set(rgba); ctx.putImageData(d, 0, 0); return c; }
  function stageUnits(rom) {
    if (!g.ArtStage) return [];
    const out = [], held = new Map();
    const decoded = id => { if (!held.has(id)) { held.set(id, ArtStage.decode(rom.program, rom.data, id)); if (held.size > 2) held.delete(held.keys().next().value); } return held.get(id); };
    for (const id of ArtStage.initialIds) {
      let layers = 0; try { layers = ArtStage.recipe(rom.program, ArtStage.selectedIndex(rom.program, id)).map_bases.length; } catch (e) { layers = 0; }
      for (let n = 0; n < layers; n++) out.push({ unit: 'stage', key: `stage${id}.${n}`, stage: id, title: `Stage ${id} · layer ${n + 1}`, short: `Layer ${n + 1}`, name: ArtStage.availability(id).rule, size: '1024 × 1024', render() { const a = ArtStage.layer(decoded(id), n); return canvasOf(a.width, a.height, a.rgba); } });
    }
    return out;
  }
  function tileUnits(rom) {
    if (!g.ArtPalette || !ArtPalette.ssTile) return [];
    return Array.from({ length: 64 }, (_, sheet) => ({ unit: 'tiles', key: 'tiles' + sheet, title: `Tiles ${count(sheet * 1024)} – ${count(sheet * 1024 + 1023)}`, short: `from ${count(sheet * 1024)}`, name: 'Raw 8 × 8 tiles in grey. Which are text, gauges or leftovers is not identified yet.', size: '1,024 tiles of 8 × 8',
      render() {
        const rgba = new Uint8Array(256 * 256 * 4);
        for (let t = 0; t < 1024; t++) { const pens = ArtPalette.ssTile(rom.program, sheet * 1024 + t).pens, ox = (t % 32) * 8, oy = Math.floor(t / 32) * 8; for (let i = 0; i < 64; i++) if (pens[i]) { const at = ((oy + (i >> 3)) * 256 + ox + (i & 7)) * 4, v = 40 + pens[i] * 14; rgba[at] = rgba[at + 1] = rgba[at + 2] = v; rgba[at + 3] = 255; } }
        return canvasOf(256, 256, rgba);
      } }));
  }

  function sections(m) {
    const group = (title, note, items) => ({ title, note, items: items.filter(x => x.rows.length) });
    const blocks = (rows, prefix) => { const by = new Map(); for (const r of rows) { const b = Math.floor(r.sprite / BLOCK); if (!by.has(b)) by.set(b, []); by.get(b).push(r); } return [...by].map(([b, list]) => ({ id: prefix + b, title: range(b), rows: list })); };
    const by = pick => { const map = new Map(); for (const r of m.rows) for (const key of pick(r)) { if (!map.has(key)) map.set(key, []); map.get(key).push(r); } return map; };
    const effects = by(r => r.effects), sets = by(r => r.sets), unlisted = m.rows.filter(r => r.kind === 'unlisted');
    return [
      group('Everything, by number', 'Every stored sprite in the order the game numbers them.', blocks(m.rows, 'all')),
      group('Characters', 'Sprites a character’s animations show.', m.names.map((name, c) => ({ id: 'c' + c, title: name, rows: m.rows.filter(r => r.owners.includes(c)) }))),
      group('Projectiles and effects', 'Sprites named by the game’s effect lists. The names are suggestions.', [...effects].sort((a, b) => a[0].localeCompare(b[0])).map(([label, rows]) => ({ id: 'e' + label, title: pretty(label), rows }))),
      group('Shared sets', 'Sprites in animation sets every character can use (sparks, dust, shadows and the like).', [...sets].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true })).map(([label, rows]) => ({ id: 's' + label, title: label, rows }))),
      group('In no list yet', 'Stored sprites that no animation or effect list found so far names: stage objects, supporting cast, bonus stages, portraits, banners and more. Unnamed, not hidden.', blocks(unlisted, 'u')),
      group('Cut content', cutNote(m), cutItems(m)),
      group('Stage pictures', 'Each stage’s layers as the game first loads them. Moving parts and lighting are not shown.', [...new Set(m.stages.map(u => u.stage))].map(id => ({ id: 'stage' + id, title: 'Stage ' + id, rows: m.stages.filter(u => u.stage === id) }))),
      group('Interface tiles', 'The small 8 × 8 tiles used for text and gauges, in sheets of 1,024.', m.tiles.length ? [{ id: 'tiles', title: 'All tile sheets', rows: m.tiles }] : []),
    ];
  }

  /* Cut content: one item per picture group of the census; the note says what the census found and what it did not. */
  function cutItems(m) {
    return (m.cutFamilies || []).flatMap(f => (f.pictures || []).map(p => ({ id: 'cut:' + p.id, title: p.title, rows: m.rows.filter(r => r.cut && r.cut.some(c => c.id === p.id)) })));
  }
  function cutNote(m) {
    const fams = (m.cutFamilies || []).filter(f => !['cut-art', 'effect-art', 'inlined', 'data-tails'].includes(f.id)), n = (k, f) => f.counts[k] || 0;
    const routines = fams.reduce((a, f) => a + n('routine', f), 0), effects = fams.reduce((a, f) => a + (f.effects || []).filter(e => e[2] === 'unspawned').length, 0);
    return 'Art left in the game but never shown: an animation nothing plays, and the art that effects Capcom never finished would load (each note says whether the game shows the same frames elsewhere). ' +
      (fams.length ? `The game also holds ${routines.toLocaleString()} pieces of code that never run (a debug menu, ${effects} effects nothing creates, stage code without a stage, unused moves) and the data only they read.` : '');
  }

  function account(m) {
    const n = kind => m.rows.filter(r => r.kind === kind).length;
    return [['sprites in your ROM', m.rows.length], ['in character animations', n('character')], ['in effect lists', n('effect')], ['in shared sets', n('set')], ['in no list yet', n('unlisted')], ['repeat another sprite’s picture', m.repeats], ['stage layers', m.stages.length], ['interface tiles', m.tiles.length * 1024], ['in cut-content groups', m.rows.filter(r => r.cut).length]];
  }

  function mount(root, opts) {
    const status = opts.status || (g.Kit && Kit.status) || (() => {}), m = opts.model || model(opts.rom), parts = sections(m);
    const palettes = new Map(), thumbs = new Map();
    let rows = [], current = null, selected = null, choice = 'auto', frame = 0, alive = true, size = SIZES.large, hide = false;
    /* Names the artist gives. Kept on this computer and exportable; they never change the ROM. */
    const mine = opts.names || (() => { try { return JSON.parse(localStorage.getItem('cps3.art.names') || '{}'); } catch (e) { return {}; } })();
    const keyOf = r => r.unit ? r.key : String(r.sprite);
    /* Categories the artist makes (key -> category), kept with the names and under the same rules. */
    const groups = opts.groups || (() => { try { return JSON.parse(localStorage.getItem('cps3.art.groups') || '{}'); } catch (e) { return {}; } })();
    /* changes: [{ key, name?, group? }]; '' removes, undefined keeps. One undo step in the Studio (opts.onLabels). */
    function apply(changes) {
      if (!changes.length) return;
      if (opts.onLabels) opts.onLabels(changes);
      else {
        for (const c of changes) {
          if (c.name !== undefined) { if (c.name) mine[c.key] = c.name; else delete mine[c.key]; }
          if (c.group !== undefined) { if (c.group) groups[c.key] = c.group; else delete groups[c.key]; }
        }
        try { localStorage.setItem('cps3.art.names', JSON.stringify(mine)); localStorage.setItem('cps3.art.groups', JSON.stringify(groups)); } catch (e) { status('Names could not be saved in this browser.'); }
      }
      drawMine(); if (current) show(current, true); if (selected) select(selected, true);
    }
    function rename(r, text) { const k = keyOf(r); if(opts.onName){opts.onName(k,text.trim());draw();select(r,true);return;} if (text.trim()) mine[k] = text.trim(); else delete mine[k]; try { localStorage.setItem('cps3.art.names', JSON.stringify(mine)); } catch (e) { status('Names could not be saved in this browser.'); } draw(); }

    function characterPalette(c) {
      if (!palettes.has(c)) { let p = null; try { const rows = ArtPalette.character(m.rom.program, m.rom.data, { character: c, side: 0, colour: 0 }).rows; p = { base: rows[0].palette, rows: new Map(rows.map(x => [x.row, x.palette])) }; } catch (e) { p = null; } palettes.set(c, p); }
      return palettes.get(c);
    }
    /* Stage objects carry a row number of their own; a stage's stored colours start at row 128.
       Row 128 + the sprite's row is a reading of the stored data, shown as a choice, not a proof. */
    function stagePalette(s) {
      const key = 'st' + s;
      if (!palettes.has(key)) { let rowsBy = null; try { rowsBy = new Map(ArtPalette.stage(m.rom.program, m.rom.data, s, 'dma').banks[0].rows.map(x => [x.row, x.palette])); } catch (e) { rowsBy = null; } palettes.set(key, rowsBy); }
      return palettes.get(key);
    }
    function paletteFor(r) {
      if (String(choice).startsWith('st')) { const s = Number(choice.slice(2)), by = stagePalette(s); if (by) return { palette: clear, rows: by, offset: 128, name: `Stage ${s} stored colours (preview choice; scene palette is not established)` }; }
      if (choice === 'clear') return { palette: clear, name: 'Clear colours (not the game’s)' };
      if (choice === 'grey') return { palette: grey, name: 'Grey (pen numbers)' };
      if (choice === 'auto' && r.sceneContext) {
        const key = 'scene:' + r.sprite;
        if (!palettes.has(key)) palettes.set(key, ArtTrueColours.scenePalette(m.rom.program, m.rom.data, r.sprite, m.rom.sha256));
        const scene = palettes.get(key);
        if (scene) return { palette: clear, rows: new Map(scene.rows.map(row => [row.row, row.palette])), offset: scene.context.base,
          context: scene.context, name: scene.context.name + (scene.context.state === 'static' ? ' · verified Original table context (stored colours)' : ' · recorded Original context (stored colours)') };
      }
      if (choice === 'auto' && !r.owners.length && r.stageContexts?.length) { const s = r.stageContexts[0], by = stagePalette(s); if (by) return { palette: clear, rows: by, offset: 128, name: `Stage ${s} stored colours (drawn by the stage’s own tables` + (r.stageContexts.length > 1 ? `; also stages ${r.stageContexts.slice(1).join(', ')}` : '') + ')' }; }
      const guess = choice === 'auto' && !r.owners.length && r.near != null, c = choice === 'auto' ? (r.owners[0] ?? r.near) : Number(choice);
      const p = c == null ? null : characterPalette(c);
      return p ? { palette: p.base, rows: p.rows, offset: 0, name: m.names[c] + ' · first colour' + (guess ? ' (a guess: it sits among their sprites)' : '') } : { palette: clear, name: 'Clear colours (not the game’s)' };
    }
    function open(r){const used=paletteFor(r),image=m.res.image(r.sprite),nativeRows=[...new Set(image.paletteRows.filter((_,i)=>image.pixels[i]))];if(used.context&&nativeRows.length>1){status('This scene artwork uses several palette rows. View or export it here; indexed painting needs one row.');return;}const palette=used.rows?.get((used.offset??0)+(nativeRows[0]??0))||used.palette;opts.onOpen(r.sprite,{palette,name:used.name,choice,context:used.context?.id});}
    /* Resolve every pen through its own native row, including 256-pen cells.
       Export and preview deliberately share this conversion. */
    function pixels(image, used) {
      const rgba = new Uint8Array(image.pixels.length * 4);
      for (let i = 0; i < image.pixels.length; i++) {
        const pen = image.pixels[i]; if (!pen) continue;
        const row = image.bits[i] === 8 ? image.paletteRows[i] * 4 + (pen >>> 6) : image.paletteRows[i];
        const c = (used.rows?.get((used.offset ?? 0) + row) || used.palette)[pen & 63];
        rgba.set([c[0], c[1], c[2], 255], i * 4);
      }
      return rgba;
    }
    function picture(r) {
      if (r.unit) { if (!thumbs.has(r.key)) { let out; try { out = { canvas: r.render(), unit: true }; } catch (e) { out = { error: e.message }; } thumbs.set(r.key, out); } return thumbs.get(r.key); }
      const key = r.sprite + ':' + (choice === 'auto' ? 'a' + (r.owners[0] ?? r.near ?? 'x') : choice);
      if (thumbs.has(key)) { const hit = thumbs.get(key); thumbs.delete(key); thumbs.set(key, hit); return hit; }
      let out;
      try {
        const image = m.res.image(r.sprite), used = paletteFor(r), canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
        const ctx = canvas.getContext('2d'), data = ctx.createImageData(image.width, image.height);
        data.data.set(pixels(image, used));
        ctx.putImageData(data, 0, 0); out = { canvas, image };
      } catch (e) { out = { error: e.message }; }
      thumbs.set(key, out); if (thumbs.size > CACHE) thumbs.delete(thumbs.keys().next().value);
      return out;
    }
    function paint(canvas, pic, maxScale) {
      const ctx = canvas.getContext('2d'); ctx.clearRect(0, 0, canvas.width, canvas.height); if (!pic.canvas) return;
      const fit = Math.min(canvas.width / pic.canvas.width, canvas.height / pic.canvas.height), scale = fit >= 1 ? Math.min(maxScale, Math.floor(fit)) : fit;
      const w = Math.max(1, Math.round(pic.canvas.width * scale)), hh = Math.max(1, Math.round(pic.canvas.height * scale));
      ctx.imageSmoothingEnabled = false; ctx.drawImage(pic.canvas, Math.floor((canvas.width - w) / 2), Math.floor((canvas.height - hh) / 2), w, hh);
    }
    const labelOf = r => r.unit ? r.short : String(r.sprite), headOf = r => r.unit ? r.title : 'Sprite ' + r.sprite;
    const nameOf = r => mine[keyOf(r)] ? mine[keyOf(r)] : r.unit ? r.name : r.sceneContext ? r.sceneContext.name + ' artwork' : r.owners.length ? r.owners.map(c => m.names[c]).join(' / ') : r.effects.length ? pretty(r.effects[0]) : r.sets.length ? r.sets[0] : r.near != null ? 'Among ' + m.names[r.near] + '’s sprites' : 'Not named yet';

    /* Left: the account and the sections. */
    const search = h('input.field', { placeholder: 'Sprite number or name', 'aria-label': 'Find a sprite', 'data-tip': 'Find|Type a sprite number, or part of a character or effect name.' });
    /* Each section folds: closed at first, a click on its heading opens or closes it; which ones are open is remembered. */
    const nav = h('nav.ev-nav', null, search), items = new Map(), groupOf = new Map(), heads = new Map();
    const pref = g.Kit && g.Kit.pref, opened = new Set((pref && pref('art.everything.open', [])) || []);
    const setOpen = (title, on) => { const { head, list } = heads.get(title); list.hidden = !on; head.setAttribute('aria-expanded', String(on)); if (on) opened.add(title); else opened.delete(title); if (pref) pref.set('art.everything.open', [...opened]); };
    function fold(title, note, total) {
      const open = opened.has(title), counter = h('small', null, count(total));
      const head = h('button.ev-fold', { type: 'button', 'aria-expanded': String(open), 'data-tip': title + '|' + note + ' Click to show or hide its parts.', onclick: () => setOpen(title, head.getAttribute('aria-expanded') !== 'true') }, h('span.ev-chevron'), h('span.ev-fold-title', null, title), counter);
      const list = h('div.ev-group', { hidden: !open });
      heads.set(title, { head, list, counter });
      nav.append(h('h3', null, head), list);
      return list;
    }
    const itemButton = (item, title) => { const b = h('button.ev-item', { type: 'button', onclick: () => show(item) }, h('span', null, item.title), h('small.num', null, count(item.rows.length))); items.set(item.id, b); groupOf.set(item.id, title); return b; };
    const MINE = 'My labels';
    const mineList = fold(MINE, 'Pictures you have named or put in a category of your own. Choose several in the grid (Ctrl-click, Shift-click, Ctrl A) to label them together.', 0);
    for (const part of parts) {
      const list = fold(part.title, part.note, new Set(part.items.flatMap(x => x.rows)).size);
      for (const item of part.items) list.append(itemButton(item, part.title));
    }
    /* My labels: one entry per category, then the named pictures with no category, then everything labelled. */
    const allRows = () => [...m.rows, ...m.stages, ...m.tiles], rank = new Map(allRows().map((r, i) => [r, i]));
    const labelled = r => !!(mine[keyOf(r)] || groups[keyOf(r)]);
    function mineItems() {
      const cats = new Set(); for (const r of allRows()) { const c = groups[keyOf(r)]; if (c) cats.add(c); }
      const list = [...cats].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).map(c => ({ id: 'mine:' + c, title: c, get rows() { return allRows().filter(r => groups[keyOf(r)] === c); } }));
      list.push({ id: 'mine:named', title: 'Named, no category', get rows() { return allRows().filter(r => mine[keyOf(r)] && !groups[keyOf(r)]); } });
      list.push({ id: 'mine:all', title: 'Everything I labelled', get rows() { return allRows().filter(labelled); } });
      return list;
    }
    /* Middle: the account line and a grid that only builds what is on screen. */
    const facts = h('div.ev-account', null, account(m).map(([text,n],i)=>h('button.btn.ghost'+(i?'':'.lead'),{type:'button','data-tip':'Filter|Show the '+n.toLocaleString('en')+' '+(/^in /.test(text)?'sprites '+text:/^repeat /.test(text)?'sprites that '+text:text)+'.',onclick:()=>{const kinds=['character','effect','set','unlisted'],list=i===0?m.rows:i<5?m.rows.filter(r=>r.kind===kinds[i-1]):i===5?m.rows.filter(r=>r.repeat):i===6?m.stages:i===7?m.tiles:m.rows.filter(r=>r.cut);show({id:'account'+i,title:text,rows:list});}},h('b.num',null,count(n)),' '+text)));
    const heading = h('div.ev-heading'), pick = h('select.field', { id:'everything-colours', 'aria-label': 'Colours', 'data-tip': 'Colours|A sprite does not say which colours it wears. Character sprites use their character’s first colour; choose others here.' },
      h('option', { value: 'auto' }, 'Colours: best known'), h('option', { value: 'clear' }, 'Clear colours (not the game’s)'), h('option', { value: 'grey' }, 'Grey (pen numbers)'), m.names.map((n, c) => h('option', { value: c }, n + ' · first colour')), Array.from({ length: 23 }, (_, s) => h('option', { value: 'st' + s }, 'Stage ' + s + ' colours')));
    const dense = h('div.seg', null, ['large', 'small'].map(k => h('button' + (k === 'large' ? '.on' : ''), { type: 'button', 'data-tip': k === 'large' ? 'Large|Pictures with their numbers and names.' : 'Small|Many more pictures at once, to scan for what you are looking for.', onclick: e => { size = SIZES[k]; view.classList.toggle('small', k === 'small'); for (const b of dense.children) b.classList.toggle('on', b === e.currentTarget); layout(); } }, k === 'large' ? 'Large' : 'Small')));
    const repeatsButton = h('button.btn.ghost', { type: 'button', 'data-tip': 'Hide repeats|Many numbers show the very same stored picture. Hide the repeats to see each picture once.', onclick: () => { hide = !hide; repeatsButton.classList.toggle('on', hide); repeatsButton.textContent = hide ? 'Showing each picture once' : 'Hide repeats'; if (current) show(current); } }, 'Hide repeats');
    const saveNames = h('button.btn.ghost', { type: 'button', 'data-tip': 'Save my names|Download the names and categories you have given, as a small file you can share, keep or load again.', onclick: () => { const plain = o => Object.fromEntries(Object.keys(o).map(k => [k, o[k]])); const a = h('a', { href: URL.createObjectURL(new Blob([JSON.stringify({ format: 'cps3.art.names.v2', names: plain(mine), groups: plain(groups) }, null, 1)], { type: 'application/json' })), download: 'my_sprite_names.json' }); a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); status(Object.keys(mine).length + ' names and ' + Object.keys(groups).length + ' categorised pictures saved to a file.'); } }, 'Save my names');
    let hideMine = false;
    const mineButton = h('button.btn.ghost', { type: 'button', 'data-tip': 'Hide labelled|Leave out the pictures you have already named or put in a category, so the rest stand out.', onclick: () => { hideMine = !hideMine; mineButton.classList.toggle('on', hideMine); mineButton.textContent = hideMine ? 'Showing unlabelled only' : 'Hide labelled'; if (current) show(current); } }, 'Hide labelled');
    const loadInput = h('input', { type: 'file', accept: '.json,application/json', hidden: true });
    const loadNames = h('button.btn.ghost', { type: 'button', 'data-tip': 'Load names|Add names and categories from a file saved here before. Your current labels are kept unless the file names the same picture.', onclick: () => loadInput.click() }, 'Load names…');
    loadInput.onchange = async () => {
      const f = loadInput.files[0]; loadInput.value = ''; if (!f) return;
      try {
        const d = JSON.parse(await f.text()); if (!d || !/^cps3\.art\.names\.v[12]$/.test(d.format)) throw new Error('This is not a names file saved by the Studio.');
        const keys = new Set([...Object.keys(d.names || {}), ...Object.keys(d.groups || {})]);
        apply([...keys].map(key => ({ key, ...(d.names && key in d.names ? { name: String(d.names[key]) } : {}), ...(d.groups && key in d.groups ? { group: String(d.groups[key]) } : {}) })));
        status(`Loaded ${keys.size} labels from ${f.name}.`);
      } catch (e) { status(e.message); }
    };
    /* Choose several: Ctrl-click adds or removes one, Shift-click a run, Ctrl A every picture shown, Esc none. */
    const picked = new Set(); let anchor = null;
    const choices = h('datalist', { id: 'ev-groups-' + (++mounts) });
    const bulkCount = h('b.ev-bulk-count'), bulkName = h('input.field', { placeholder: 'Name', 'aria-label': 'Name for the chosen pictures', 'data-tip': 'Name|One name for every chosen picture.' });
    const numbered = h('input', { type: 'checkbox', 'aria-label': 'Number them' });
    const bulkGroup = h('input.field', { placeholder: 'Category, new or yours', list: choices.id, 'aria-label': 'Category', 'data-tip': 'Category|Type a new category or pick one you made. It appears under My labels.' });
    const act = (text, tip, run, primary) => h('button.btn' + (primary ? '.primary' : '.ghost'), { type: 'button', 'data-tip': tip, onclick: run }, text);
    const order = (a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0);
    const targets = () => (picked.size ? [...picked] : selected ? [selected] : []).sort(order);
    function label() {
      const list = targets(), name = bulkName.value.trim(), cat = bulkGroup.value.trim();
      if (!list.length) { status('Choose pictures first: click one, Ctrl-click or Shift-click more, or Ctrl A for all shown.'); return; }
      if (!name && !cat) { status('Type a name, a category, or both.'); return; }
      const width = String(list.length).length;
      apply(list.map((r, i) => ({ key: keyOf(r), ...(name ? { name: numbered.checked ? name + ' ' + String(i + 1).padStart(width, '0') : name } : {}), ...(cat ? { group: cat } : {}) })));
      if (cat && !opened.has(MINE)) setOpen(MINE, true);
      status(`Labelled ${count(list.length)} picture${list.length === 1 ? '' : 's'}` + (cat ? ` in “${cat}”` : '') + '.');
    }
    const bulk = h('div.ev-bulk', null, bulkCount, bulkName, h('label.ev-check', { 'data-tip': 'Number them|Adds 1, 2, 3… after the name, in the game’s order.' }, numbered, 'Number them'), bulkGroup, choices,
      act('Label', 'Label|Give the chosen pictures this name, this category, or both.', label, true),
      act('Choose all shown', 'Choose all shown|Choose every picture in this list (Ctrl A in the grid).', () => { for (const r of rows) picked.add(r); refreshPicks(); }),
      act('Remove names', 'Remove names|Take your names off the chosen pictures.', () => apply(targets().map(r => ({ key: keyOf(r), name: '' })))),
      act('Remove category', 'Remove category|Take the chosen pictures out of your categories.', () => apply(targets().map(r => ({ key: keyOf(r), group: '' })))),
      act('Clear choice', 'Clear choice|Choose no pictures (Esc).', () => { picked.clear(); refreshPicks(); }));
    function refreshPicks() {
      for (const cell of pad.children) cell.classList.toggle('picked', picked.has(cell.row));
      const n = targets().length; bulkCount.textContent = picked.size ? count(picked.size) + ' chosen' : n ? '1 chosen' : 'None chosen';
    }
    function pickClick(r, e) {
      if (e.shiftKey && anchor && rows.includes(anchor)) { const a = rows.indexOf(anchor), b = rows.indexOf(r); if (!(e.ctrlKey || e.metaKey)) picked.clear(); for (let i = Math.min(a, b); i <= Math.max(a, b); i++) picked.add(rows[i]); }
      else if (e.ctrlKey || e.metaKey) { if (picked.has(r)) picked.delete(r); else picked.add(r); anchor = r; }
      else { picked.clear(); anchor = r; }
      select(r); refreshPicks();
    }
    function drawMine() {
      for (const id of [...items.keys()]) if (id.startsWith('mine:')) { items.delete(id); groupOf.delete(id); }
      const list = mineItems();
      mineList.replaceChildren(...list.map(item => itemButton(item, MINE)));
      heads.get(MINE).counter.textContent = count(list[list.length - 1].rows.length);
      choices.replaceChildren(...list.filter(x => x.id !== 'mine:named' && x.id !== 'mine:all').map(x => h('option', { value: x.title })));
      if (current) { for (const [id, b] of items) b.classList.toggle('on', id === current.id); for (const [title, { head }] of heads) head.classList.toggle('has-on', groupOf.get(current.id) === title); }
    }
    const pad = h('div.ev-pad'), scroll = h('div.ev-scroll', { tabindex: 0 }, pad), middle = h('section.ev-middle', null, facts, h('div.ev-bar', null, heading, h('div.ev-tools', null, repeatsButton, mineButton, saveNames, loadNames, loadInput, dense, pick)), bulk, scroll);
    /* Right: the chosen sprite. */
    const big = h('canvas', { width: 296, height: 296 }), title = h('b'), lines = h('div.ev-lines'), exportButton = h('button.btn', { type: 'button', 'data-tip': 'Export|Save this sprite as a picture that keeps its pen numbers.', onclick: () => exportPng().catch(error=>status(error.message)) }, 'Export…'), openButton = opts.onOpen ? h('button.btn.primary', { type: 'button', onclick: () => selected && open(selected) }, 'Edit') : null;
    const naming = h('input.field', { placeholder: 'Give it a name', 'aria-label': 'Your name for this picture', 'data-tip': 'Your name|Name what you recognise. It is kept on this computer, shows in the grid and can be found by typing it.', onchange: () => { const text = naming.value.trim(); if (picked.size > 1) { const list = targets(); apply(list.map(r => ({ key: keyOf(r), name: text }))); status(text ? `Named ${count(list.length)} pictures: ${text}` : `Names removed from ${count(list.length)} pictures.`); } else if (selected) { rename(selected, naming.value); status(text ? `Named: ${text}` : 'Name removed.'); } } });
    const usesButton = opts.onUses ? h('button.btn', {type:'button',onclick:()=>selected && opts.onUses(selected.unit==='stage'?'stage:'+selected.stage:!selected.unit?'sprite:'+selected.sprite:null)}, 'What uses this?') : null;
    const side = h('aside.ev-side', null, h('div.ev-big', null, big), title, naming, lines, h('div.ev-actions', null, [openButton, exportButton, usesButton].filter(Boolean)));
    const view = h('div.ev', null, nav, middle, side); root.replaceChildren(view);

    function columns() { return Math.max(1, Math.floor((scroll.clientWidth - 16) / size.w)); }
    function show(item, keep) {
      current = item; rows = hide ? item.rows.filter(r => !r.repeat) : item.rows; if (hideMine && !String(item.id).startsWith('mine:')) rows = rows.filter(r => !labelled(r)); choice=opts.choices?.[item.id]||'auto';pick.value=choice;colourControl?.set(choice,true); for (const [id, b] of items) b.classList.toggle('on', id === item.id); for (const [title, { head }] of heads) head.classList.toggle('has-on', groupOf.get(item.id) === title);
      heading.replaceChildren(h('b', null, item.title), h('small', null, count(rows.length) + (rows[0] && rows[0].unit === 'stage' ? ' layers' : rows[0] && rows[0].unit === 'tiles' ? ' sheets of 1,024 tiles' : rows.length === 1 ? ' sprite' : ' sprites')));
      root.dataset.spriteCount=m.rows.length;root.dataset.sectionCount=rows.length;if (!keep) scroll.scrollTop = 0; layout(); if (!keep && rows.length) select(rows[0], true);
    }
    function layout() { pad.style.height = Math.ceil(rows.length / columns()) * size.h + 16 + 'px'; draw(); }
    function draw() {
      cancelAnimationFrame(frame); frame = requestAnimationFrame(() => {
        if (!alive) return; const cols = columns(), first = Math.max(0, Math.floor(scroll.scrollTop / size.h) - 1), last = Math.min(Math.ceil(rows.length / cols), Math.ceil((scroll.scrollTop + scroll.clientHeight) / size.h) + 1), cells = [], todo = [];
        for (let i = first * cols; i < Math.min(rows.length, last * cols); i++) {
          const r = rows[i], canvas = h('canvas', { width: size.tw, height: size.th });
          const cell = h('button.ev-cell' + (selected === r ? '.on' : '') + (mine[keyOf(r)] ? '.named' : '') + (groups[keyOf(r)] ? '.grouped' : '') + (picked.has(r) ? '.picked' : ''), { type: 'button', style: `left:${8 + (i % cols) * size.w}px;top:${8 + Math.floor(i / cols) * size.h}px`, 'data-tip': `${headOf(r)}|${nameOf(r)}${groups[keyOf(r)] ? ' · ' + groups[keyOf(r)] : ''}`, onclick: e => pickClick(r, e), ondblclick: () => opts.onOpen && !r.unit && open(r) }, canvas, h('span.num', null, labelOf(r)), h('small', null, nameOf(r)));
          cell.row = r; cells.push(cell); todo.push([r, canvas, cell]);
        }
        pad.replaceChildren(...cells);
        /* Decode a few each frame, so scrolling stays smooth with thousands of sprites. */
        const token = draw.token = {}; (function step() { if (!alive || draw.token !== token) return; const until = performance.now() + 8; while (todo.length && performance.now() < until) { const [r, canvas, cell] = todo.shift(), pic = picture(r); if (pic.error) { cell.classList.add('alone'); cell.querySelector('small').textContent = 'Needs its scene to draw'; } else paint(canvas, pic, size.up); } if (todo.length) requestAnimationFrame(step); })();
      });
    }
    function select(r, quiet) {
      if (typeof r === 'number') r = m.byId.get(r); if (!r) return false; selected = r;
      for (const cell of pad.children) cell.classList.toggle('on', cell.row === r); naming.value = mine[keyOf(r)] || '';
      const line = (k, v) => h('p', null, h('small', null, k), h('span', null, v));
      if (usesButton) usesButton.disabled=!!r.unit&&r.unit!=='stage';
      if (r.unit) { const pic = picture(r); paint(big, pic, 4); title.textContent = r.title; lines.replaceChildren(line('What it is', r.name), groups[keyOf(r)] ? line('My category', groups[keyOf(r)]) : null, line('Size', r.size), line('Colours shown', r.unit === 'stage' ? 'The stage’s own stored colours' : 'Grey (pen numbers)')); exportButton.disabled = !pic.canvas; if (openButton) openButton.disabled = true; if (!quiet) status(r.title); return true; }
      const pic = picture(r), used = paletteFor(r); paint(big, pic, 4); title.textContent = 'Sprite ' + r.sprite;
      lines.replaceChildren(...[
        line('Name', nameOf(r)),
        pic.image ? line('Size', `${pic.image.width} × ${pic.image.height} · ${r.cells} ${r.cells === 1 ? 'piece' : 'pieces'}`) : line('Picture', 'This sprite is laid out by the scene that shows it and cannot be drawn alone yet.'),
        r.owners.length ? line('Shown by', r.owners.map(c => m.names[c]).join(', ')) : null,
        r.effects.length ? line('Effect lists', r.effects.map(pretty).join(', ')) : null,
        r.sets.length ? line('Shared sets', r.labels.filter(l => l.startsWith('Shared animation set ')).slice(0, 6).join(' · ')) : null,
        r.kind === 'unlisted' ? line('Lists', 'In no animation or effect list found so far.') : null,
        r.cut ? line('Cut content', r.cut.map(c => c.title + '. ' + c.note).join(' ')) : null,
        groups[keyOf(r)] ? line('My category', groups[keyOf(r)]) : null,
        line('Colours shown', used.name),
        r.sceneContext ? line('Usage evidence', r.sceneContext.usageEvidence || (r.sceneContext.state === 'static' ? 'Listed by the Original game: ' : 'Recorded in Original: ') + r.sceneContext.name + '. Other uses remain possible.') : r.kind === 'unlisted' ? line('Usage evidence', 'Unresolved. Missing list references do not prove this artwork is unused.') : null,
        used.context ? line('Palette context', used.context.scope) : null,
        h('p.hood', { 'data-tip': 'Under the hood|The sprite’s number as the game writes it.' }, h('small', null, 'Under the hood'), h('span.num', null, '0x' + r.sprite.toString(16).toUpperCase().padStart(4, '0')))].filter(Boolean));
      exportButton.disabled = !pic.image; if (openButton) { openButton.disabled = !pic.image || !!used.context && new Set(pic.image.paletteRows.filter((_,i)=>pic.image.pixels[i])).size > 1; openButton.title = openButton.disabled && used.context ? 'Multiple palette rows: view and export are available; indexed painting needs one row.' : ''; }
      if (!quiet) status(`Sprite ${r.sprite} · ${nameOf(r)}`); return true;
    }
    function reveal(r) {
      if (!rows.includes(r)) { const home = parts[0].items.find(x => x.rows.includes(r)); if (home) show(home, true); }
      const at = rows.indexOf(r), top = Math.floor(at / columns()) * size.h; if (top < scroll.scrollTop || top + size.h > scroll.scrollTop + scroll.clientHeight) scroll.scrollTop = Math.max(0, top - size.h); select(r); draw();
    }
    async function exportPng() {
      if (!selected) return; const pic = picture(selected);
      if (selected.unit) { if (!pic.canvas) return; pic.canvas.toBlob(blob => { const a = h('a', { href: URL.createObjectURL(blob), download: selected.key + '.png' }); a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); status(`Saved ${selected.title} as a picture.`); }, 'image/png'); return; }
      if (!pic.image) return;
      const im = pic.image, used = paletteFor(selected), nativeRows = [...new Set(im.paletteRows.filter((_, i) => im.pixels[i]))], single = nativeRows.length <= 1 && im.bits.every((b, i) => !im.pixels[i] || b === 6);
      const palette = used.rows?.get((used.offset ?? 0) + (nativeRows[0] ?? 0)) || used.palette;
      const bytes = await ArtPng.write({ width: im.width, height: im.height, ...(single ? { pens: im.pixels, palette } : { rgba: pixels(im, used) }), origin: { x: -im.bounds[0], y: -im.bounds[1] } });
      if (g.Kit) { Kit.download(`sprite_${selected.sprite}.png`, bytes, 'image/png'); status(`Saved sprite ${selected.sprite} as a picture.`); return bytes; }
      const a = h('a', { href: URL.createObjectURL(new Blob([bytes], { type: 'image/png' })), download: `sprite_${selected.sprite}.png` }); a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); status(`Saved sprite ${selected.sprite} as a picture.`); return bytes;
    }
    search.oninput = () => {
      const text = search.value.trim().toLowerCase(); if (!text) return;
      const n = /^0x[0-9a-f]+$/.test(text) ? parseInt(text, 16) : /^\d+$/.test(text) ? Number(text) : null;
      if (n != null) { const r = m.byId.get(n); if (r) reveal(r); else status(`The game stores no sprite ${n}.`); return; }
      const found = [...m.rows, ...m.stages, ...m.tiles].filter(r => nameOf(r).toLowerCase().includes(text) || (groups[keyOf(r)] || '').toLowerCase().includes(text) || r.unit && r.title.toLowerCase().includes(text) || !r.unit && r.labels.some(l => l.toLowerCase().replace(/_/g, ' ').includes(text)));
      show({ id: 'search', title: `Found “${search.value.trim()}”`, rows: found });
    };
    const choose=value=>{choice=String(value);opts.onChoice?.(current?.id,choice);draw();if(selected)select(selected,true);};
    let colourControl=null;if(g.Kit){colourControl=Kit.select(pick,[...pick.options].map(o=>({value:o.value,label:o.textContent})),{onPick:choose});}else pick.onchange=()=>choose(pick.value);
    scroll.onscroll = draw;
    scroll.addEventListener('keydown', e => {
      if (e.key === 'Escape' && picked.size) { picked.clear(); refreshPicks(); e.preventDefault(); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') { for (const r of rows) picked.add(r); refreshPicks(); e.preventDefault(); e.stopPropagation(); }
    });
    scroll.onkeydown = e => { const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: columns(), ArrowUp: -columns() }[e.key]; if (!step || !selected) return; const next = rows[rows.indexOf(selected) + step]; if (next) { e.preventDefault(); reveal(next); } };
    const resize = new ResizeObserver(() => layout()); resize.observe(scroll);
    drawMine(); refreshPicks();
    show(parts[1].items[2] || parts[0].items[0]);
    return { model: m, sections: parts, exportPNG: exportPng, select: id => { const r = m.byId.get(id); if (r) reveal(r); return !!r; }, show: id => { for (const p of parts) for (const item of p.items) if (item.id === id) { show(item); return true; } return false; }, destroy() { alive = false; resize.disconnect(); view.remove(); } };
  }

  g.ArtEverything = { mount, model, sections, account };
})(window);
