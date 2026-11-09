/* Project colours in the Palettes workspace. A local character project (served by cps3_studio/local_server.py) can
 * offer a palette block of its own: a colour file its build installs, with game frames it captured and a per-pixel pen
 * map for each. The block opens in the normal Palettes tools (pen grid, R G B and keys, ramps, copy and paste, undo);
 * the preview is the captured frame with every mapped pixel recoloured from the pens being edited, at 1x, or through
 * the project's CRT renderer. Every edit is saved back to the project; Write build file asks the project for the file
 * in its build's own form. Nothing here is bundled: the project serves the frames and colours. */
(function (g) {
  'use strict';
  const K = g.Kit, el = K.el;
  /* FBNeo's colour expansion (v << 3 | v >> 2): the captured frames are FBNeo pictures, so edited pixels match them. */
  const fbneo = w => [0, 5, 10].map(s => { const v = (w >>> s) & 31; return v << 3 | v >> 2; });
  const W = 384, H = 224;
  async function decode(url) {
    const img = new Image(); img.src = url; await img.decode();
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const x = c.getContext('2d', {willReadFrequently: true}); x.drawImage(img, 0, 0); return x.getImageData(0, 0, c.width, c.height);
  }
  async function post(block, operation, body) {
    const response = await fetch(block.project.api + '/' + operation, {method: 'POST', headers: {'Content-Type': 'application/json', 'X-Studio-Token': block.project.token}, body: JSON.stringify(body)});
    const value = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(value.error || 'The project did not accept this (' + response.status + ').');
    return value;
  }
  const time = iso => iso ? new Date(iso).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit', second: '2-digit'}) : '';

  async function mount(host, block, opts = {}) {
    const say = opts.status || K.status, gid = 'project-' + block.project.id + '-' + block.id, rowId = i => gid + '-row-' + i;
    const group = {id: gid, kind: 'project', name: block.title, description: 'Rows the picture draws · the bar under a pen number says what draws it', views: block.crt ? ['In game', 'CRT · 1084S'] : ['In game'],
      rows: block.rows.map((r, i) => ({id: rowId(i), name: r.name, words: r.words, marks: r.marks || {}}))};
    const frames = await Promise.all(block.frames.map(async f => {
      const picture = await decode(f.picture), pens = await decode(f.pens), members = new Array(W * H).fill(null);
      for (let i = 0; i < W * H; i++) if (pens.data[i * 4 + 3]) members[i] = rowId(pens.data[i * 4 + 1]) + ':' + pens.data[i * 4];
      return {name: f.name, box: f.box, picture, pens, members};
    }));
    const n = frames.length, step = block.frameStep || 1;
    const union = frames.reduce((b, f) => [Math.min(b[0], f.box[0]), Math.min(b[1], f.box[1]), Math.max(b[2], f.box[2]), Math.max(b[3], f.box[3])], [W, H, 0, 0]);
    const crtBox = [Math.max(0, union[0] - 48), Math.max(0, union[1] - 32), Math.min(W, union[2] + 48), Math.min(H, union[3] + 32)];
    let frameAt = null, lastIndex = 0, instance = null;
    const crt = {key: null, image: null, members: null, busy: false, error: '', timer: null};

    /* host bar: what this is, starting points, the pen legend, save and build-file state */
    const saveState = el('span.faint.num', {'aria-live': 'polite'}, block.draft ? 'Draft from ' + time(block.draft.saved) + ' restored' : 'Not changed yet');
    const deliverState = el('span.faint', {'aria-live': 'polite'}, block.ready ? 'Build file written ' + time(block.ready.written) : 'No build file written yet');
    const starts = (block.starts || []).map(s => {
      const b = el('button.btn', {type: 'button', 'data-tip': s.name + '|' + s.about + ' Sets pens ' + Object.keys(s.pens)[0] + '–' + Object.keys(s.pens).slice(-1)[0] + ' of ' + block.rows[s.row].name + ' as one step; undo restores.'}, s.name);
      b.onclick = () => { try { applyStart(s); } catch (e) { say(e.message); } };
      return b;
    });
    const deliver = el('button.btn.primary', {type: 'button', 'data-tip': 'Write build file|Write ' + block.file + ' in the form the build reads, with a note of every changed pen. The live build is not changed.'}, 'Write build file');
    deliver.onclick = async () => {
      deliver.disabled = true;
      try { await flush(); const r = await post(block, 'palettes/deliver', {block: block.id, rows: rowsNow()});
        deliverState.textContent = 'Written ' + time(r.written) + ' · ' + r.changed + ' changed colours · ' + r.path;
        deliverState.classList.toggle('warn', !!(r.sharedPensChanged && r.sharedPensChanged.length));
        say(r.sharedNote); }
      catch (e) { deliverState.textContent = e.message; deliverState.classList.add('warn'); say(e.message); }
      finally { deliver.disabled = false; }
    };
    const legend = el('span.pal-legend.faint', null,
      el('span', null, el('i.used'), 'drawn by the ' + block.title.toLowerCase()),
      ...(block.shared && block.shared.length ? [el('span', null, el('i.shared'), 'also ' + block.sharedWith), el('span', null, el('i.other'), block.sharedWith.replace(/\s*\(.*\)$/, '') + ' only')] : []));
    const bar = el('div.art-palette-domain.pal-project-bar', null,
      el('div.vbox.grow', null,
        el('div.hbox', null, el('b', null, block.title), el('span.faint', null, block.subtitle), el('span.faint', null, '·'), el('span.faint', null, 'Start from'), ...starts),
        el('div.hbox', null, legend, el('span.grow'), saveState)),
      el('div.vbox.pal-project-deliver', null, deliver, deliverState));
    const paletteHost = el('div.art-palette-component');
    host.append(bar, paletteHost);

    /* the preview: the captured frame, recoloured from the current pens, playing or held on one frame */
    const frameLabel = el('span.faint.num', {style: 'min-width:9ch;text-align:center'});
    const crtLabel = el('span.faint', {hidden: true});
    const stepTo = d => { frameAt = ((frameAt == null ? lastIndex : frameAt) + d + n) % n; play.textContent = 'Play'; instance && instance.refresh(); };
    const prev = el('button.btn', {type: 'button', 'data-tip': 'Previous frame|Hold the previous captured frame (every ' + step + ' game frames).', 'aria-label': 'Previous frame'}, '‹');
    const next = el('button.btn', {type: 'button', 'data-tip': 'Next frame|Hold the next captured frame.', 'aria-label': 'Next frame'}, '›');
    const play = el('button.btn', {type: 'button', 'data-tip': 'Play|Play the captured frames at game speed, or hold the one on screen.'}, 'Hold');
    const crtToggle = el('button.btn', {type: 'button', hidden: !block.crt, 'data-tip': 'CRT look|Show the held frame through the default CRT (CRT Lola 1084S), rendered by the client’s own shader. It catches up about two seconds after your last change.'}, 'CRT look');
    crtToggle.onclick = () => { const on = instance.view !== 1; instance.setView(on ? 1 : 0); crtToggle.classList.toggle('on', on); };
    prev.onclick = () => stepTo(-1); next.onclick = () => stepTo(1);
    play.onclick = () => { if (frameAt == null) { frameAt = lastIndex; play.textContent = 'Play'; } else { frameAt = null; play.textContent = 'Hold'; } instance && instance.refresh(); };

    function rowsNow() { const e = instance.model.effective(); return block.rows.map((_, i) => Array.from(e[rowId(i)])); }
    function compose(index, data, original) {
      const f = frames[index], out = new ImageData(new Uint8ClampedArray(f.picture.data), W, H), P = f.pens.data, D = out.data;
      const lut = block.rows.map((r, i) => Array.from(original ? r.words : data[rowId(i)], fbneo));
      for (let i = 0; i < W * H; i++) if (P[i * 4 + 3]) { const c = lut[P[i * 4 + 1]][P[i * 4]]; D[i * 4] = c[0]; D[i * 4 + 1] = c[1]; D[i * 4 + 2] = c[2]; }
      return out;
    }
    function requestCrt(index, data, original) {
      const key = index + '|' + original + '|' + JSON.stringify(block.rows.map((_, i) => original ? 0 : data[rowId(i)]));
      if (crt.key === key || crt.wanted === key) return;
      crt.wanted = key; clearTimeout(crt.timer);
      crt.timer = setTimeout(async () => {
        if (crt.busy) { crt.wanted = null; crt.timer = null; return; }   // the next draw asks again
        crt.busy = true; crtLabel.textContent = 'CRT · rendering…';
        try {
          const c = document.createElement('canvas'); c.width = W; c.height = H; c.getContext('2d').putImageData(compose(index, data, original), 0, 0);
          const r = await post(block, 'palettes/crt', {frame: c.toDataURL('image/png'), height: 896, box: crtBox});
          const img = new Image(); img.src = r.image; await img.decode();
          crt.image = img; crt.key = key; crt.error = ''; crt.members = null;
          crtLabel.textContent = 'CRT · up to date';
        } catch (e) { crt.error = e.message; crtLabel.textContent = 'CRT · ' + e.message; }
        finally { crt.busy = false; crt.wanted = null; instance && instance.refresh(); }
      }, 250);
    }
    function preview(cv, data, o) {
      const index = frameAt != null ? frameAt : Math.floor(o.time * 60 / step) % n; lastIndex = index;
      frameLabel.textContent = 'Frame ' + (index + 1) + ' / ' + n;
      crtLabel.hidden = o.view !== 1; crtToggle.classList.toggle('on', o.view === 1);
      const ctx = cv.getContext('2d'), selected = new Set(o.selected);
      if (o.view === 1) {
        if (frameAt == null) { frameAt = index; play.textContent = 'Play'; }   // the CRT shows one held frame
        requestCrt(index, data, o.original);
        if (crt.image) {
          const w = crt.image.width, h = crt.image.height;
          if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
          ctx.drawImage(crt.image, 0, 0);
          if (!crt.members || crt.members.index !== index) {
            const f = frames[index], m = new Array(w * h), bw = crtBox[2] - crtBox[0], bh = crtBox[3] - crtBox[1];
            for (let y = 0; y < h; y++) { const gy = crtBox[1] + Math.floor(y * bh / h); for (let x = 0; x < w; x++) m[y * w + x] = f.members[gy * W + crtBox[0] + Math.floor(x * bw / w)]; }
            crt.members = {index, list: m};
          }
          return {width: w, height: h, members: crt.members.list};
        }
        if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
        ctx.putImageData(compose(index, data, o.original), 0, 0);
        return {width: W, height: H, members: frames[index].members};
      }
      if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
      const image = compose(index, data, o.original);
      if (o.flash && selected.size) { const D = image.data, m = frames[index].members; for (let i = 0; i < W * H; i++) if (m[i] && selected.has(m[i])) { D[i * 4] = 255; D[i * 4 + 1] = 176; D[i * 4 + 2] = 0; } }
      ctx.putImageData(image, 0, 0);
      return {width: W, height: H, members: frames[index].members};
    }

    /* saving: every change goes back to the project after a short pause; Ctrl S saves at once */
    let saveTimer = null, saving = Promise.resolve();
    function flush() {
      clearTimeout(saveTimer); saveTimer = null;
      saving = saving.then(async () => {
        try { const r = await post(block, 'palettes/save', {block: block.id, rows: rowsNow()}); saveState.textContent = 'Saved to the project ' + time(r.saved); saveState.classList.remove('warn'); }
        catch (e) { saveState.textContent = 'Not saved: ' + e.message; saveState.classList.add('warn'); say('Not saved: ' + e.message); }
      });
      return saving;
    }
    function applyStart(s) {
      const m = instance.model, targets = Object.keys(s.pens).map(Number).filter(p => p > 0).sort((a, b) => a - b);
      m.select(targets.map(p => rowId(s.row) + ':' + p), 'replace');
      m.pasteWords(targets.map(p => s.pens[p]));
      instance.refresh(); say(s.name + ' applied to pens ' + targets[0] + '–' + targets[targets.length - 1] + '. Undo restores the previous colours.');
    }

    instance = ArtPalettes.mount(paletteHost, {
      groups: [group], persist: false, inlineRename: true, animate: () => frameAt == null, status: say,
      toRGB: w => fbneo(w), conversionLabel: 'FBNeo colour, as in the captured frames',
      previewTitle: block.title + ' in game', previewTools: [prev, frameLabel, next, play, crtToggle, crtLabel], usedRowsOnly: true,
      links: opts.links || [], linksLabel: opts.linksLabel,
      onChange: () => { saveState.textContent = 'Saving…'; clearTimeout(saveTimer); saveTimer = setTimeout(flush, 400); },
      preview
    });
    if (block.draft && block.draft.rows) {
      const snap = instance.model.snapshot(); block.rows.forEach((_, i) => { snap.words[rowId(i)] = block.draft.rows[i]; });
      instance.model.restoreDraft(snap); instance.refresh(); clearTimeout(saveTimer); saveTimer = null;
      saveState.textContent = 'Draft from ' + time(block.draft.saved) + ' restored';
    }
    say('Click a pen or a pixel of the ' + block.title.toLowerCase() + '. Q/A, W/S, E/D nudge R, G, B.');
    return {instance, model: instance.model, flush, frames, rowId, crtBox, step: stepTo, togglePlay: () => play.onclick(),
      show: i => { frameAt = ((i % n) + n) % n; play.textContent = 'Play'; instance.refresh(); },
      applyStart: id => applyStart(block.starts.find(s => s.id === id)), deliver: () => deliver.onclick(),
      destroy() { clearTimeout(crt.timer); if (saveTimer) flush(); instance.destroy(); }};
  }
  /* Deliver's card: each project block with its saved draft, and the same Write build file as in Palettes. */
  async function deliverCard(host, opts = {}) {
    const list = g.CPS3CharacterProjects ? await g.CPS3CharacterProjects.palettes().catch(() => []) : [];
    const column = host.querySelector('.art-deliver-column');
    if (!list.length || !column || !host.isConnected) return null;
    const body = el('div.group');
    for (const block of list) {
      const rows = block.draft && block.draft.rows ? block.draft.rows : block.rows.map(r => r.words);
      const changed = rows.reduce((n, r, i) => n + r.filter((w, p) => w !== block.rows[i].words[p]).length, 0);
      const state = el('p.hint', null, block.ready ? 'Build file written ' + time(block.ready.written) + '.' : 'No build file written yet.');
      const write = el('button.btn.primary', {type: 'button', 'data-tip': 'Write build file|Write ' + block.file + ' from the saved colours, in the form the build reads. The live build is not changed.'}, 'Write build file');
      write.onclick = async () => { write.disabled = true; try { const r = await post(block, 'palettes/deliver', {block: block.id, rows}); state.textContent = 'Written ' + time(r.written) + ' · ' + r.changed + ' changed colours · ' + r.path + '. ' + r.sharedNote; state.classList.toggle('warn', !!(r.sharedPensChanged && r.sharedPensChanged.length)); } catch (e) { state.textContent = e.message; state.classList.add('warn'); } finally { write.disabled = false; } };
      const open = el('button.btn', {type: 'button', 'data-tip': 'Open|Edit these colours in Palettes.'}, 'Open');
      open.onclick = () => opts.open && opts.open(block.project.id + '/' + block.id);
      body.append(el('div.vbox', null, el('b', null, block.title + ' · ' + block.project.title),
        el('p.hint', null, block.file + ' · ' + (changed ? changed + ' colours changed' : 'no colour changed') + (block.draft ? ' · saved ' + time(block.draft.saved) : '')),
        el('div.hbox', null, write, open), state));
    }
    const card = el('section.panel.art-deliver-card.pal-project-deliver-card', {'aria-label': 'Project colours'}, el('header', null, el('h3', null, 'Project colours')), body);
    column.append(card);
    /* Deliver redraws its columns as checks finish: put the card back whenever a redraw drops it */
    const watch = new MutationObserver(() => { if (card.isConnected) return; const next = host.querySelector('.art-deliver-column'); if (next) next.append(card); });
    watch.observe(host, {childList: true, subtree: true});
    return {card, stop: () => watch.disconnect()};
  }
  g.ArtProjectPalettes = {mount, deliverCard, list: () => (g.CPS3CharacterProjects ? g.CPS3CharacterProjects.palettes() : Promise.resolve([])), fbneo};
})(window);
