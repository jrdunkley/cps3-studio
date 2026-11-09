/* Piano-roll checks are declared before the implementation; every gesture calls the same edit API. */
(function (g) {
  'use strict';
  const S = g.Studio, a = S.assert;
  S.test('roll', 'draw three notes and undo exactly', () => { S.state.newProject(S.demo()); S.state.select({ partId: S.state.project.parts[2].id }); const before = JSON.stringify(S.state.project); S.roll.draw(24, 72, 12, 90); a(S.roll.part().notes.some(n => n.t === 24 && n.n === 72)); S.state.undo(); a(JSON.stringify(S.state.project) === before); S.roll.draw(24, 72, 12, 90); S.roll.draw(48, 74, 12, 85); S.roll.draw(72, 76, 24, 80); });
  S.test('roll', 'selection moves in time and pitch', () => { const p = S.roll.part(), i = p.notes.length - 1; S.roll.select([i]); const n = { ...p.notes[i] }; S.roll.move(12, 1); a(S.roll.part().notes[i].t === n.t + 12 && S.roll.part().notes[i].n === n.n + 1); });
  S.test('roll', 'resize clamps at one tick', () => { S.roll.resize(-1000); a(S.roll.selected().every(n => n.len === 1)); });
  S.test('roll', 'multi-selection copies and pastes', () => { S.roll.select([0, 1, 2]); S.roll.copy(); const n = S.roll.part().notes.length; S.roll.paste(384); a(S.roll.part().notes.length === n + 3); });
  S.test('roll', 'duplicate and delete are reversible', () => { const n = S.roll.part().notes.length; S.roll.duplicate(); a(S.roll.part().notes.length === n + 3); S.roll.remove(); a(S.roll.part().notes.length === n); S.state.undo(); a(S.roll.part().notes.length === n + 3); });
  S.test('roll', 'quantise snaps selected notes only', () => { S.roll.select([0]); S.roll.move(7, 0); S.roll.quantize(12); a(S.roll.part().notes[0].t % 12 === 0); });
  S.test('roll', 'velocity edit is undoable', () => { const n = S.roll.part().notes[0].v; S.roll.velocity([0], 23); a(S.roll.part().notes[0].v === 23); S.state.undo(); a(S.roll.part().notes[0].v === n); });
  S.test('roll', 'automation point adds moves and deletes', () => { S.roll.lanePoint('expression', 96, 42); a(S.roll.part().automation.expression.some(x => x.t === 96 && x.v === 42)); S.roll.lanePoint('expression', 120, 64, 96); a(!S.roll.part().automation.expression.some(x => x.t === 96)); S.roll.laneDelete('expression', 120); a(S.roll.part().automation.expression.length === 0); });
  S.test('roll', 'automation ramp has steps every three ticks', () => { S.roll.ramp('pan', 0, 12, 0, 120); a(S.roll.part().automation.pan.length === 5 && S.roll.part().automation.pan[4].v === 120); });
  S.test('roll', 'kit rows use only the instrument’s playable keys', () => { S.state.select({ partId: S.state.project.parts[0].id }); const rows = S.roll.rows(); a(rows.length > 0 && rows.length < 128 && rows.every(r => Number.isInteger(r.note) && r.label)); });
  S.test('roll', 'note inspector edits the selection together', () => { S.roll.select([0, 1]); S.roll.setNotes({ v: 77, cents: -12, tie: true }); a(S.roll.selected().every(n => n.v === 77 && n.cents === -12 && n.tie)); });
  S.test('roll', 'typing step entry advances by snap', () => { S.transport.stop(); S.transport.position = 0; const n = S.roll.part().notes.length; S.roll.inputNote(60, 100, false); a(S.roll.part().notes.length === n + 1 && S.transport.position === S.roll.snap); });
})(window);

(function (g) {
  'use strict';
  const S = g.Studio, K = g.Kit, el = K.el, copy = x => JSON.parse(JSON.stringify(x));
  const R = S.roll = { snap: 12, length: 24, tool: 'draw', ghost: true, hear: true, follow: true, typing: false, scaleSnap: false, octave: 4 };
  let root, grid, lane, keyboard, gridCtl, laneCtl, off = [], from = 0, span = 768, top = 84, rowH = 14, activeLane = 'velocity', selectedBox, dragHint = null, indexes = new Map(), editId = 0, lastHear = 0;
  let clipboard = [], midi, stops = new Map(), kitScroll = 0, shownPart;
  function hold(key, promise) { if (!promise) return; const held = { released: false, stop: null }; stops.set(key, held); Promise.resolve(promise).then(stop => { held.stop = stop; if (held.released && stop) stop(); }).catch(e => K.status(e.message)); }
  function release(key) { const held = stops.get(key); if (held) { held.released = true; held.stop?.(); stops.delete(key); } }
  const limits = { velocity: [1, 127], pan: [0, 127], expression: [0, 127], pitch: [-100, 100], vibDepth: [0, 127], gain: [-64, 63] };
  for (const [k, v] of Object.entries(S.automation ? S.automation.LANES : {})) if (!limits[k]) limits[k] = v.range;
  let laneHead, laneHover = null, laneDrag = null, markersShown = [];
  /* the lane canvas: the lane buttons sit over its top band; the markers have their own strip below them; values below that */
  const markTop = () => (laneHead ? laneHead.offsetTop + laneHead.offsetHeight + 3 : 30), markBottom = () => markTop() + 11, valueTop = () => markBottom() + 5;
  R.part = () => S.state.project?.parts.find(p => p.id === S.state.selection.partId) || S.state.project?.parts[0];
  R.indices = () => (S.state.selection.notes || []).filter(i => R.part()?.notes[i]);
  R.selected = () => R.indices().map(i => R.part().notes[i]);
  R.select = ids => S.state.select({ partId: R.part()?.id, notes: [...new Set(ids)], tool: R.tool });
  const edit = (label, fn) => { const id = R.part()?.id; if (id) S.edit(label, p => fn(p.parts.find(q => q.id === id)), { gesture: /^(Gesture|Lane gesture) \d+$/.test(label) }); };
  R.draw = (t, n, len = R.length, v = 96, label) => { if (!R.part()) return; const i = R.part().notes.length; edit(label || 'Draw note ' + (++editId), p => p.notes.push({ t: Math.max(0, Math.round(t)), n: K.clamp(Math.round(n), 0, 127), len: Math.max(1, Math.round(len)), v: K.clamp(Math.round(v), 1, 127) })); R.select([i]); return i; };
  R.move = (dt, dn, label = 'Move notes') => { const ids = R.indices(), ns = R.selected(); if (!ns.length) return; dt = Math.max(dt, -Math.min(...ns.map(n => n.t))); dn = K.clamp(dn, -Math.min(...ns.map(n => n.n)), 127 - Math.max(...ns.map(n => n.n))); edit(label, p => ids.forEach(i => { p.notes[i].t += dt; p.notes[i].n += dn; })); };
  R.resize = (delta, label = 'Resize notes') => { const ids = R.indices(); edit(label, p => ids.forEach(i => { p.notes[i].len = Math.max(1, p.notes[i].len + delta); })); };
  R.setNotes = values => { const ids = R.indices(); edit('Note properties', p => ids.forEach(i => Object.assign(p.notes[i], values))); };
  R.remove = () => { const ids = new Set(R.indices()); edit('Delete notes', p => { p.notes = p.notes.filter((n, i) => !ids.has(i)); }); R.select([]); };
  R.copy = () => { const notes = R.selected(); if (!notes.length) return; const first = Math.min(...notes.map(n => n.t)); clipboard = notes.map(n => ({ ...copy(n), t: n.t - first })); };
  R.paste = tick => { if (!clipboard.length) return; const start = R.part().notes.length; edit('Paste notes', p => p.notes.push(...clipboard.map(n => ({ ...copy(n), t: n.t + Math.max(0, tick == null ? Math.round(S.transport.position) : tick) })))); R.select(clipboard.map((n, i) => start + i)); };
  R.duplicate = () => { const ns = R.selected(); if (!ns.length) return; const end = Math.max(...ns.map(n => n.t + n.len)); R.copy(); R.paste(end); };
  R.quantize = (snap = R.snap || 1) => { const ids = R.indices(); edit('Quantise notes', p => ids.forEach(i => { p.notes[i].t = Math.round(p.notes[i].t / snap) * snap; })); };
  R.velocity = (ids, value, label) => edit(label || 'Velocity', p => ids.forEach(i => { p.notes[i].v = K.clamp(Math.round(value), 1, 127); }));
  R.lanePoint = (name, t, v, oldTick, label) => edit(label || 'Lane ' + name, p => { const bounds = limits[name] || [0, 127]; const points = (p.automation[name] || []).filter(x => x.t !== Math.round(t) && x.t !== oldTick); points.push({ t: Math.max(0, Math.round(t)), v: K.clamp(v, ...bounds) }); p.automation[name] = points.sort((a, b) => a.t - b.t); });
  R.laneDelete = (name, tick) => edit('Delete lane point', p => { p.automation[name] = (p.automation[name] || []).filter(x => x.t !== tick); });
  R.ramp = (name, start, end, first, last, label) => edit(label || 'Lane ramp', p => { if (end < start) [start, end, first, last] = [end, start, last, first]; const points = (p.automation[name] || []).filter(x => x.t < start || x.t > end), bounds = limits[name]; for (let t = start; t <= end; t += 3) points.push({ t: Math.round(t), v: K.clamp(Math.round(first + (last - first) * (t - start) / Math.max(1, end - start)), ...bounds) }); p.automation[name] = points.sort((a, b) => a.t - b.t); });
  R.rows = () => { const p = R.part(), entry = p && S.state.catalog.programs[`${p.bank}:${p.program}`]; if (entry?.kit && entry.keys?.length) return entry.keys.map(k => ({ note: k.key, label: k.label })); return Array.from({ length: 128 }, (_, i) => ({ note: 127 - i, label: K.fmt.note(127 - i) })); };
  const isKit = () => { const p = R.part(); return !!(p && S.state.catalog.programs[`${p.bank}:${p.program}`]?.kit); };
  function audition(n, v) { if (!R.hear || location.hash.includes('selftest') || performance.now() - lastHear < 70) return; lastHear = performance.now(); S.transport.audition(R.part(), n, v || 100, R.length).catch(e => K.status(e.message)); }
  R.inputNote = (n, v, hear = true) => { if (!R.part()) return; const t = Math.round(S.transport.position / (R.snap || 1)) * (R.snap || 1); R.draw(t, n, R.length, v); if (!S.transport.playing) S.transport.jump(t + (R.snap || R.length)); if (hear && R.hear && !location.hash.includes('selftest')) return S.transport.audition(R.part(), n, v, R.length); };
  function scales() { return { minor: [0, 2, 3, 5, 7, 8, 10], major: [0, 2, 4, 5, 7, 9, 11], dorian: [0, 2, 3, 5, 7, 9, 10], mixolydian: [0, 2, 4, 5, 7, 9, 10] }; }
  function inScale(n) { const key = S.state.project.key; return !key || !scales()[key.scale] || scales()[key.scale].includes((n - key.root + 120) % 12); }
  function snapPitch(n) { if (!R.scaleSnap || isKit()) return n; for (let i = 0; i < 12; i++) { if (inScale(n - i)) return n - i; if (inScale(n + i)) return n + i; } return n; }
  const xTick = (x, alt) => Math.max(0, Math.round((from + (x - 64) / ((gridCtl.w - 64) / span)) / (alt ? 1 : R.snap || 1)) * (alt ? 1 : R.snap || 1));
  function visibleRows() { return isKit() ? R.rows().slice(kitScroll) : R.rows().slice(127 - top); }
  const yNote = y => snapPitch(visibleRows()[Math.max(0, Math.floor(y / rowH))]?.note ?? 0);
  const noteY = n => isKit() ? (R.rows().findIndex(r => r.note === n) - kitScroll) * rowH : (top - n) * rowH;
  function index() { indexes = new Map(); for (const p of S.state.project.parts) { const map = new Map(); p.notes.forEach((n, i) => { for (let bar = Math.floor(n.t / 192); bar <= Math.floor((n.t + n.len) / 192); bar++) { if (!map.has(bar)) map.set(bar, []); map.get(bar).push(i); } }); indexes.set(p.id, map); } }
  function visible(p) { const ids = new Set(), map = indexes.get(p.id); if (!map) return []; for (let bar = Math.floor(from / 192); bar <= Math.ceil((from + span) / 192); bar++) for (const i of map.get(bar) || []) ids.add(i); return [...ids]; }
  function hit(x, y) { const p = R.part(); if (!p || x < 64) return -1; const tick = from + (x - 64) / ((gridCtl.w - 64) / span), note = yNote(y); return visible(p).findLast(i => p.notes[i].n === note && p.notes[i].t <= tick && p.notes[i].t + p.notes[i].len >= tick) ?? -1; }
  function paint(c, w, h) {
    const started = performance.now();
    const css = K.css, p = R.part(), px = (w - 64) / span, x = tick => 64 + (tick - from) * px, rows = visibleRows();
    c.fillStyle = css('--bg-1'); c.fillRect(0, 0, w, h); c.font = css('--cv-mono-sm'); c.textBaseline = 'middle';
    rows.forEach((r, i) => { const y = i * rowH; if (y >= h) return; const black = [1, 3, 6, 8, 10].includes(r.note % 12); c.fillStyle = css(black ? '--cv-row-black' : '--cv-row'); c.fillRect(64, y, w, rowH); if (!inScale(r.note)) { c.fillStyle = css('--cv-out-of-scale'); c.fillRect(64, y, w, rowH); } c.fillStyle = css(r.note % 12 ? '--cv-line-faint' : '--line-2'); c.fillRect(64, y + rowH - 1, w, 1); });
    const step = px * (R.snap || 12) < 5 ? 48 : R.snap || 12;
    for (let t = Math.floor(from / step) * step; t <= from + span; t += step) { c.fillStyle = css(t % 192 === 0 ? '--line-3' : t % 48 === 0 ? '--line-2' : '--cv-grid-faint'); c.fillRect(Math.round(x(t)), 0, 1, h); }
    const selected = new Set(R.indices());
    function notes(part, ghost) {
      const inst = S.state.catalog.programs[`${part.bank}:${part.program}`], colour = css('--role-' + (part.role || 'fx'));
      c.save(); c.beginPath(); c.rect(64, 0, w - 64, h); c.clip();
      for (const i of visible(part)) { const n = part.notes[i], y = noteY(n.n), left = x(n.t), width = Math.max(2, n.len * px - 1); if (y < -rowH || y > h) continue;
        c.fillStyle = colour; c.globalAlpha = ghost ? 0.18 : 0.45 + 0.55 * n.v / 127; c.fillRect(left, y + 1, width, rowH - 2); c.globalAlpha = 1;
        if (ghost) continue; c.fillStyle = css('--cv-note-inner'); c.fillRect(left + 2, y + rowH / 2, Math.max(0, width - 4) * n.v / 127, 1);
        if (selected.has(i)) { c.strokeStyle = css('--cv-selected'); c.strokeRect(left + 0.5, y + 1.5, width - 1, rowH - 3); }
        const own = n.program == null ? inst : S.state.catalog.programs[`${n.bank == null ? part.bank : n.bank}:${n.program}`], range = own?.range; if (range && (n.n + part.transpose < range.low || n.n + part.transpose > range.high)) { c.strokeStyle = css('--warn'); c.strokeRect(left, y + 1, width, rowH - 2); }
        if (n.program != null || n.volume != null) { c.fillStyle = css('--ink'); c.fillRect(left + width - 3, y + 1, 3, 3); }
        if (n.tie) { c.fillStyle = colour; c.fillRect(left + width, y + rowH / 2, Math.max(3, 2 * px), 2); }
        if (n.slide) { c.strokeStyle = css('--ink'); c.beginPath(); c.moveTo(left, y + rowH - 2); c.lineTo(left + Math.min(10, width), y + 2); c.stroke(); }
        if (n.cents && width > 28) { c.fillStyle = css('--ink'); c.fillText((n.cents > 0 ? '+' : '') + n.cents, left + 3, y + rowH / 2); }
      } c.restore();
    }
    if (p && R.ghost) for (const other of S.state.project.parts) if (other.id !== p.id) notes(other, true);
    if (p) notes(p, false);
    c.fillStyle = css('--bg-2'); c.fillRect(0, 0, 64, h);
    rows.forEach((r, i) => { const y = i * rowH; if (y >= h) return; const black = !isKit() && [1, 3, 6, 8, 10].includes(r.note % 12); c.fillStyle = css(black ? '--cv-key-black' : '--cv-key'); c.fillRect(0, y, black ? 40 : 63, rowH - 1); if (isKit() || r.note % 12 === 0) { c.fillStyle = css('--cv-key-label'); c.fillText(r.label, 4, y + rowH / 2, 56); } });
    if (!p || !p.notes.length) { c.fillStyle = css('--ink-3'); c.font = css('--cv-font'); c.fillText(!p ? 'Add a part first (Add part, top left), then draw its notes here.' : S.state.project.ui.readOnly ? 'No notes in this part.' : R.tool === 'draw' ? 'Nothing here yet. Drag to draw notes.' : 'Nothing here yet. Press B, then drag to draw notes.', 88, h / 2); }
    R.paintMs = performance.now() - started;
  }
  function overlay(c, w, h) { const x = 64 + (S.transport.position - from) * (w - 64) / span; c.fillStyle = K.css('--cv-playhead'); if (x >= 64) c.fillRect(Math.round(x), 0, 1, h); if (selectedBox) { c.strokeStyle = K.css('--cv-selected'); c.strokeRect(selectedBox.x, selectedBox.y, selectedBox.w, selectedBox.h); }
    const n = dragHint && R.part()?.notes[dragHint.i]; if (n) { const px = (w - 64) / span, xr = 64 + (n.t + n.len - from) * px, y = noteY(n.n), text = lengthText(n.len); c.font = K.css('--cv-font'); const tw = c.measureText(text).width + 10, bx = Math.min(w - tw - 2, xr + 6), by = Math.max(2, y - 20); c.fillStyle = K.css('--cv-hint-bg') || K.css('--bg-0'); c.fillRect(bx, by, tw, 18); c.fillStyle = K.css('--cv-hint-ink') || K.css('--ink'); c.fillText(text, bx + 5, by + 13); } }
  /* What a press does at (x, y): the hover cursor and K.drag's start both ask this, so the pointer always shows the
     gesture a click-and-hold will make (keys play, a note's last 6 px resize, its body moves, empty cells draw or box-select). */
  function gestureAt(x, y) { if (!R.part()) return { kind: 'none', i: -1 }; if (x < 64) return { kind: 'key', i: -1 }; const i = hit(x, y);
    if (i >= 0) { if (R.tool === 'erase') return { kind: 'erase', i }; const n = R.part().notes[i], right = 64 + (n.t + n.len - from) * (gridCtl.w - 64) / span; return { kind: Math.abs(x - right) <= 6 ? 'resize' : 'move', i }; }
    return { kind: R.tool === 'draw' ? 'draw' : 'box', i: -1 }; }
  /* A note's box on the grid canvas (CSS pixels), for pointer tests that then hover and press there for real. */
  R.noteBox = i => { const n = R.part()?.notes[i]; if (!n || !gridCtl) return null; const px = (gridCtl.w - 64) / span; return { x: 64 + (n.t - from) * px, y: noteY(n.n), w: n.len * px, h: rowH }; };
  const CURSORS = { none: 'default', key: 'pointer', erase: 'not-allowed', resize: 'ew-resize', move: 'grab', draw: 'crosshair', box: 'cell' };
  const TITLES = { key: 'Click to hear this key', erase: 'Click to erase this note', resize: 'Drag to change the length', move: 'Drag to move · Ctrl-drag copies · Alt frees time snap', draw: 'Drag to draw a note', box: 'Drag a box to select notes' };
  function hover(x, y, m = {}) { if (!grid) return; const g = gestureAt(x, y); grid.style.cursor = g.kind === 'move' && m.ctrl ? 'copy' : CURSORS[g.kind]; grid.dataset.gesture = g.kind; }
  function lengthText(len) { const beats = len / 48, names = { 192: 'whole', 96: 'half', 48: 'quarter', 24: 'eighth', 12: '16th', 6: '32nd' }; return (names[len] ? names[len] + ' · ' : '') + (Number.isInteger(beats) ? beats + (beats === 1 ? ' beat' : ' beats') : beats.toFixed(2) + ' beats') + ' (' + len + ' ticks)'; }
  function paintLane(c, w, h) {
    const p = R.part(), css = K.css, x = t => 64 + (t - from) * (w - 64) / span, [low, high] = limits[activeLane], top = valueTop(), y = v => h - 4 - (v - low) / (high - low) * (h - top - 4);
    c.fillStyle = css('--bg-1'); c.fillRect(0, 0, w, h); c.font = css('--cv-mono-sm');
    for (let t = Math.floor(from / 48) * 48; t < from + span; t += 48) { c.fillStyle = css(t % 192 ? '--line' : '--line-3'); c.fillRect(x(t), top - 2, 1, h); }
    paintMarkers(c, w, x);
    if (!p) return; c.fillStyle = css('--role-' + (p.role || 'fx')); c.strokeStyle = css('--role-' + (p.role || 'fx')); c.lineWidth = 1;
    if (activeLane === 'velocity') for (const i of visible(p)) { const n = p.notes[i]; if (x(n.t) < 64) continue; const yy = y(n.v); c.fillRect(x(n.t), yy, 3, h - 4 - yy); c.beginPath(); c.arc(x(n.t) + 1.5, yy, 3, 0, Math.PI * 2); c.fill(); }
    else { const points = p.automation[activeLane] || []; let prev = { t: from, v: activeLane === 'pitch' || activeLane === 'gain' ? 0 : p[activeLane] || 0 }; c.beginPath(); c.moveTo(64, y(prev.v)); for (const point of points) { if (point.t < from) { prev = point; continue; } if (point.t > from + span) break; c.lineTo(x(point.t), y(prev.v)); c.lineTo(x(point.t), y(point.v)); c.fillRect(x(point.t) - 3, y(point.v) - 3, 6, 6); prev = point; } c.lineTo(w, y(prev.v)); c.stroke(); }
    c.fillStyle = css('--bg-2'); c.fillRect(0, 0, 64, h);
    c.fillStyle = css('--ink-3'); c.font = css('--cv-mono-sm'); c.textBaseline = 'middle'; c.fillText(String(high), 6, top + 4); c.fillText(String(low), 6, h - 8); c.fillText('Changes', 6, (markTop() + markBottom()) / 2);
    const hint = laneDrag ? laneDrag.hint : laneHover && laneHover.g.hint; if (hint) paintHint(c, w, h, (laneDrag || laneHover).x, (laneDrag || laneHover).y, hint);
  }
  const MARK = { sound: '--bad', lfo: '--accent', pitch: '--info', level: '--ink-3', raw: '--ink-2', loop: '--good' };
  /* one marker per event that changes or locks the sound (S.automation.events), on its tick; the hovered one grows */
  function paintMarkers(c, w, x) {
    const p = R.part(), y0 = markTop(), y1 = markBottom(); markersShown = []; if (!p || !S.automation) return;
    c.fillStyle = K.css('--bg-2'); c.fillRect(64, y0 - 1, w - 64, y1 - y0 + 2);
    for (const e of S.automation.events(p, S.state.project)) { const xx = Math.round(x(e.t)); if (xx < 64 || xx > w) continue; const on = laneHover && laneHover.g.marker === e;
      c.fillStyle = K.css(e.kind === 'pitch' ? '--role-bass' : MARK[e.kind] || '--ink-2') || K.css('--ink-2'); c.fillRect(xx, y0, on ? 3 : 2, y1 - y0); c.fillRect(xx - (on ? 4 : 3), y0 + 2, on ? 9 : 7, on ? 7 : 6); markersShown.push({ ...e, x: xx }); }
  }
  function paintHint(c, w, h, px, py, text) {
    c.font = K.css('--cv-font'); const lines = wrap(c, text, Math.min(420, w - 80)), tw = Math.max(...lines.map(l => c.measureText(l).width)) + 12, th = lines.length * 16 + 6;
    const bx = K.clamp(px + 12, 66, w - tw - 2), by = K.clamp(py <= markBottom() + 1 ? markBottom() + 4 : py - th - 8, markBottom() + 4, Math.max(markBottom() + 4, h - th - 2));
    c.fillStyle = K.css('--cv-hint-bg') || K.css('--bg-0'); c.fillRect(bx, by, tw, th); c.fillStyle = K.css('--cv-hint-ink') || K.css('--ink'); c.textBaseline = 'top'; lines.forEach((l, i) => c.fillText(l, bx + 6, by + 4 + i * 16));
  }
  function wrap(c, text, max) { const words = text.split(' '), out = []; let line = ''; for (const word of words) { const next = line ? line + ' ' + word : word; if (c.measureText(next).width > max && line) { out.push(line); line = word; } else line = next; } if (line) out.push(line); return out; }
  function redraw() { if (!gridCtl) return; if (shownPart !== R.part()?.id) fitPitch(); index(); gridCtl.invalidate(); laneCtl.invalidate(); gridCtl.invalidateOverlay(); if (keyboard) keyboard.textContent = R.part()?.name || 'Notes'; renderHead(); }
  R.focus = tick => { from = Math.max(0, tick); fitPitch(); redraw(); grid?.focus(); };
  function fitPitch() { const p = R.part(); if (!p) return; shownPart = p.id; kitScroll = 0; if (isKit()) { rowH = 18; top = 127; } else { rowH = 14; const high = p.notes.length ? Math.max(...p.notes.map(n => n.n)) : 72; top = K.clamp(high + 5, 12, 127); } }
  R.fit = () => { const p = R.part(); if (!p) return; from = p.notes.length ? Math.floor(Math.min(...p.notes.map(n => n.t)) / 192) * 192 : 0; span = Math.max(192, p.notes.length ? Math.ceil((Math.max(...p.notes.map(n => n.t + n.len)) - from) / 192) * 192 : 768); fitPitch(); redraw(); };
  const action = (id, title, hint, keys, run) => K.action({ id: 'roll.' + id, title, hint, keys, group: 'Piano roll', scope: 'roll', run, enabled: () => S.activeView === 'compose' && !!R.part() });
  const tool = value => { R.tool = value; if (root) for (const b of root.querySelectorAll('[data-tool]')) b.classList.toggle('on', b.dataset.tool === value); };
  action('select', 'Select notes', 'Drag a box around notes.', 'V', () => tool('select')); action('draw', 'Draw notes', 'Click and drag to write a note.', 'B', () => tool('draw')); action('erase', 'Erase notes', 'Click a note to remove it.', 'E', () => tool('erase'));
  action('all', 'Select all notes', 'Select every note in this part.', 'Ctrl A', () => R.select(R.part().notes.map((n, i) => i)));
  action('copy', 'Copy notes', 'Copy the selected notes.', 'Ctrl C', R.copy); action('cut', 'Cut notes', 'Copy and remove the selected notes.', 'Ctrl X', () => { R.copy(); R.remove(); }); action('paste', 'Paste notes', 'Paste copied notes at the playhead.', 'Ctrl V', () => R.paste()); action('duplicate', 'Duplicate notes', 'Repeat the selected notes after themselves.', 'Ctrl D', R.duplicate); action('delete', 'Delete notes', 'Remove the selected notes.', 'Delete, Backspace', R.remove); action('quantize', 'Quantize', 'Move selected notes to the time grid.', 'Q', () => R.quantize()); action('fit', 'Fit part', 'Fit this part’s notes into the view.', 'F', R.fit);
  for (const [id, keys, dt, dn] of [['left', 'Left', -1, 0], ['right', 'Right', 1, 0], ['up', 'Up', 0, 1], ['down', 'Down', 0, -1], ['octaveup', 'Shift Up', 0, 12], ['octavedown', 'Shift Down', 0, -12]]) action(id, 'Nudge ' + id, 'Move the selected notes in time or pitch.', keys, () => R.move(dt * (R.snap || 1), dn));
  action('shorter', 'Shorter notes', 'Shorten selected notes by one grid step.', '[', () => R.resize(-(R.snap || 1))); action('longer', 'Longer notes', 'Lengthen selected notes by one grid step.', ']', () => R.resize(R.snap || 1)); action('typing', 'Typing keyboard', 'Use letter keys as a piano keyboard.', 'K', () => { R.typing = !R.typing; if (root) root.querySelector('[data-typing]')?.classList.toggle('on', R.typing); K.status(R.typing ? 'Typing keyboard on. A–K plays notes; Z/X changes octave.' : 'Typing keyboard off.'); });
  const SEG = [['velocity', 'Velocity'], ['pan', 'Pan'], ['expression', 'Level'], ['pitch', 'Pitch'], ['vibDepth', 'Vibrato'], ['gain', 'Gain']];
  const laneCount = k => (R.part()?.automation?.[k] || []).length;
  R.showLane = name => { if (!limits[name]) return; activeLane = name; renderHead(); laneCtl?.invalidate(); };
  R.activeLane = () => activeLane;
  R.removeLane = name => { const label = (S.automation.LANES[name] || {}).label || name; edit('Remove ' + label + ' lane', p => { delete p.automation[name]; }); K.status('The ' + label + ' lane was removed. Undo brings it back.'); };
  R.laneSummary = () => R.part() && S.automation ? S.automation.summary(R.part(), S.state.project) : null;
  R.laneHint = () => (laneDrag ? laneDrag.hint : laneHover && laneHover.g.hint) || '';
  R.laneBox = () => { if (!lane || !laneCtl) return null; const b = lane.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height, from, span, markTop: markTop(), markBottom: markBottom(), valueTop: valueTop(), tickX: t => 64 + (t - from) * (laneCtl.w - 64) / span }; };
  R.laneMarkers = () => markersShown.map(m => ({ t: m.t, x: m.x, y: (markTop() + markBottom()) / 2, kind: m.kind, lane: m.lane, text: m.text }));
  function renderHead() {
    if (!laneHead || !S.automation) return; const p = R.part();
    for (const b of laneHead.querySelectorAll('[data-lane]')) { const n = laneCount(b.dataset.lane); b.classList.toggle('on', b.dataset.lane === activeLane); if (n) b.dataset.count = n; else delete b.dataset.count; }
    const more = laneHead.querySelector('.lane-more'), extra = Object.keys(S.automation.LANES).filter(k => !SEG.some(x => x[0] === k)), shown = extra.includes(activeLane), others = extra.reduce((n, k) => n + laneCount(k), 0);
    more.textContent = shown ? S.automation.LANES[activeLane].label : 'More'; more.classList.toggle('on', shown); if (others) more.dataset.count = others; else delete more.dataset.count;
    const badge = laneHead.querySelector('.lane-badge'), sum = p ? S.automation.summary(p, S.state.project) : null;
    badge.hidden = !sum || !sum.items.length; if (badge.hidden) return;
    badge.textContent = sum.items.length + (sum.items.length === 1 ? ' thing changes' : ' things change') + ' this sound' + (sum.locks ? ' · ' + sum.locks + ' locked' : '');
    badge.classList.toggle('warn', !!sum.locks);
  }
  function badgeMenu(anchor) {
    const sum = R.laneSummary(); if (!sum) return;
    K.menu(anchor, [{ heading: 'What changes this part’s sound' }, ...sum.items.map(i => ({ label: i.label + (i.count ? ' (' + i.count + ')' : '') + ' — ' + i.short, checked: i.lane === activeLane, run: () => { if (i.lane) R.showLane(i.lane); K.status(i.text); } })),
      ...(sum.lanes.length ? ['-', ...sum.lanes.map(l => ({ label: 'Remove the ' + l.label + ' lane', danger: true, run: () => R.removeLane(l.name) }))] : [])]);
  }
  R.mount = host => {
    root = host; root.dataset.scope = 'roll'; const tools = el('div.tools'); keyboard = el('span.title', null, R.part()?.name || 'Notes'); tools.append(keyboard);
    const btn = (text, hint, fn, cls = '') => el('button.btn.ghost', { class: cls, 'data-tip': text + '|' + hint, onclick: fn }, text);
    const toolSeg = el('div.seg'); for (const [value, icon] of [['select', 'select'], ['draw', 'draw'], ['erase', 'erase']]) toolSeg.append(el('button', { class: R.tool === value ? 'on' : '', 'data-tool': value, 'aria-label': value[0].toUpperCase() + value.slice(1) + ' tool', 'data-tip': value + '|Choose the ' + value + ' tool.', onclick: () => tool(value) }, K.icon(icon))); tools.append(toolSeg);
    const choice = (label, list, value, fn) => { const sel = el('select.field', { 'aria-label': label, 'data-tip': label + '|Choose ' + label.toLowerCase() + '.', onchange: e => fn(Number(e.target.value)) }, list.map(([v, title]) => el('option', { value: v }, title))); sel.value = value; return sel; };
    tools.append(choice('Snap', [[48, '1/4'], [24, '1/8'], [12, '1/16'], [6, '1/32'], [3, '1/64'], [16, '1/8 triplet'], [8, '1/16 triplet'], [0, 'Off']], R.snap, v => { R.snap = v; redraw(); }), choice('Length', [[192, 'Whole'], [96, '1/2'], [48, '1/4'], [24, '1/8'], [12, '1/16'], [6, '1/32']], R.length, v => { R.length = v; }), btn('Scale', 'Snap notes to the song’s scale.', e => { R.scaleSnap = !R.scaleSnap; e.currentTarget.classList.toggle('on', R.scaleSnap); }), btn('Ghosts', 'Show other parts faintly.', e => { R.ghost = !R.ghost; e.currentTarget.classList.toggle('on', R.ghost); redraw(); }, R.ghost ? 'on' : ''), el('span.grow'), btn('Quantize', 'Move selected notes to the time grid.', () => R.quantize()), btn('Humanize', 'Apply a small repeatable velocity variation.', () => { const ids = R.indices(); edit('Humanize notes', p => ids.forEach((i, j) => { p.notes[i].v = K.clamp(p.notes[i].v + ((j * 17 + 3) % 11) - 5, 1, 127); })); }, 'wide-only'), btn('−', 'Show more time.', () => { span = Math.min(32768, span * 1.5); redraw(); }, 'wide-only'), btn('+', 'Show less time.', () => { span = Math.max(48, span / 1.5); redraw(); }, 'wide-only'));
    const options = btn('⋯', 'Audition, typing, MIDI and following options.', e => K.menu(e.currentTarget, [{ label: 'Hear notes', checked: R.hear, run: () => { R.hear = !R.hear; } }, { label: 'Typing keyboard', checked: R.typing, action: 'roll.typing' }, { label: 'Follow playhead', checked: R.follow, run: () => { R.follow = !R.follow; } }, { label: 'Connect MIDI keyboard', run: async () => { if (!navigator.requestMIDIAccess) return K.toast('This browser has no MIDI keyboard support.'); try { midi = await navigator.requestMIDIAccess(); const wire = () => { for (const input of midi.inputs.values()) input.onmidimessage = event => { const [status, n, v] = event.data; if ((status & 240) === 144 && v) hold('midi-' + n, R.inputNote(n, v)); else if ((status & 240) === 128 || (status & 240) === 144) release('midi-' + n); }; }; wire(); midi.onstatechange = wire; K.toast('MIDI keyboard ready.'); } catch (error) { K.toast(error.message); } } }])); tools.append(options);
    grid = el('canvas', { tabIndex: 0, 'data-scope': 'roll', 'aria-label': 'Piano roll', 'data-status': 'Piano roll|Drag to draw or move; Alt frees time snap; Ctrl-drag copies.' }); const gridHost = el('div.grid', null, grid); grid.addEventListener('pointermove', e => { if (e.buttons) return; const b = grid.getBoundingClientRect(); hover(e.clientX - b.left, e.clientY - b.top, { ctrl: e.ctrlKey }); }); grid.addEventListener('pointerleave', () => { if (!dragHint) grid.style.cursor = ''; }); lane = el('canvas', { tabIndex: 0, 'data-scope': 'roll', 'aria-label': 'Automation lane', 'data-status': 'Lane|The pointer says what a press does: a point moves, empty adds, Alt ramps, right-click removes a point. Markers above show what changes the sound.' }); const which = el('div.which.seg'); for (const [value, name] of SEG) which.append(el('button', { class: activeLane === value ? 'on' : '', 'data-lane': value, 'data-tip': name + '|Show and edit the ' + name.toLowerCase() + ' lane.', onclick: () => R.showLane(value) }, name));
    const more = el('button.btn.ghost.lane-more', { 'data-tip': 'More lanes|Show another of the game’s lanes: instrument, volume, detune, fine tune, vibrato speed, tremolo, vibrato restart and glide.', onclick: e => K.menu(e.currentTarget, Object.entries(S.automation.LANES).filter(([k]) => !SEG.some(x => x[0] === k)).map(([k, v]) => ({ label: v.label + (laneCount(k) ? ' · ' + laneCount(k) + ' points' : ''), checked: activeLane === k, run: () => R.showLane(k) }))) }, 'More');
    const badge = el('button.btn.lane-badge', { hidden: true, 'data-tip': 'What changes this sound|Lanes, driver commands and borrowed tracks that change or lock this part’s sound. Click for the list; markers below show where each happens.', onclick: e => badgeMenu(e.currentTarget) });
    laneHead = el('div.lane-head', null, which, more, badge);
    host.replaceChildren(tools, gridHost, el('div.lane', null, lane, laneHead));
    index(); fitPitch(); gridCtl = K.canvas(grid, paint, { overlay }); laneCtl = K.canvas(lane, paintLane); renderHead();
    K.drag(grid, { threshold: 3, start(d) {
      grid.focus(); if (!R.part()) return false; if (d.x < 64) { const n = yNote(d.y); hold('pointer', S.transport.audition(R.part(), n, 100, 192)); return { kind: 'key' }; }
      const g = gestureAt(d.x, d.y), i = g.i, label = 'Gesture ' + (++editId), ns = R.indices();
      if (g.kind === 'erase') { R.select([i]); R.remove(); return false; }
      if (g.kind === 'resize' || g.kind === 'move') { R.select(d.shift ? ns.concat(i) : ns.includes(i) ? ns : [i]); const n = R.part().notes[i]; grid.style.cursor = g.kind === 'resize' ? 'ew-resize' : d.ctrl ? 'copy' : 'grabbing'; return { kind: g.kind, i, label, dt: 0, dn: 0, start: copy(n), copy: d.ctrl, didCopy: false }; }
      if (R.tool === 'draw') { const t = xTick(d.x, d.alt), n = yNote(d.y), i = R.draw(t, n, R.length, 96, label); audition(n); return { kind: 'draw', i, t, label, length: R.length }; }
      R.select(d.shift ? ns : []); return { kind: 'box', previous: d.shift ? ns : [] };
    }, move(d) {
      const st = d.state, snap = d.alt ? 1 : R.snap || 1, px = (gridCtl.w - 64) / span;
      if (st.kind === 'draw') { const len = Math.max(snap, xTick(d.x, d.alt) - st.t); edit(st.label, p => { p.notes[st.i].len = len; }); dragHint = { i: st.i }; }
      else if (st.kind === 'move' || st.kind === 'resize') { let dt = Math.round(d.dx / px / snap) * snap, dn = isKit() ? yNote(d.y) - yNote(d.oy) : -Math.round(d.dy / rowH); if (d.shift) { if (Math.abs(d.dx) > Math.abs(d.dy)) dn = 0; else dt = 0; } if (st.copy && !st.didCopy) { const old = R.indices(), start = R.part().notes.length; edit(st.label, p => p.notes.push(...old.map(i => copy(p.notes[i])))); R.select(old.map((i, j) => start + j)); st.didCopy = true; } if (st.kind === 'resize') { R.resize(dt - st.dt, st.label); dragHint = { i: st.i }; } else { R.move(dt - st.dt, dn - st.dn, st.label); if (dn !== st.dn) audition(R.selected()[0].n); } st.dt = dt; st.dn = dn; }
      else if (st.kind === 'box') { selectedBox = { x: Math.min(d.x, d.ox), y: Math.min(d.y, d.oy), w: Math.abs(d.dx), h: Math.abs(d.dy) }; const b = selectedBox; R.select(st.previous.concat(visible(R.part()).filter(i => { const n = R.part().notes[i], x = 64 + (n.t - from) * px, y = noteY(n.n); return x + n.len * px >= b.x && x <= b.x + b.w && y + rowH >= b.y && y <= b.y + b.h; }))); gridCtl.invalidateOverlay(); }
      if (dragHint) gridCtl.invalidateOverlay();
      if (d.x > gridCtl.w - 16) { from += snap; redraw(); } else if (d.x < 72 && from > 0) { from = Math.max(0, from - snap); redraw(); }
    }, end(d, cancelled) { dragHint = null; hover(d.x, d.y, d); if (d.state.kind === 'key') release('pointer'); if (cancelled && (d.moved || d.state.kind === 'draw')) S.state.undo(); selectedBox = null; gridCtl.invalidateOverlay(); } });
    const removeAt = e => { e.preventDefault(); const b = grid.getBoundingClientRect(), i = hit(e.clientX - b.left, e.clientY - b.top); if (i >= 0) { R.select([i]); R.remove(); } }; grid.oncontextmenu = removeAt; grid.ondblclick = removeAt;
    gridHost.onwheel = e => { e.preventDefault(); if (e.ctrlKey) { const b = grid.getBoundingClientRect(), fraction = K.clamp((e.clientX - b.left - 64) / (gridCtl.w - 64), 0, 1), at = from + fraction * span; span = K.clamp(span * (e.deltaY < 0 ? 0.85 : 1 / 0.85), 48, 32768); from = Math.max(0, at - fraction * span); } else if (e.shiftKey) from = Math.max(0, from + e.deltaY * span / 1000); else if (isKit()) kitScroll = K.clamp(kitScroll + Math.sign(e.deltaY) * 3, 0, Math.max(0, R.rows().length - Math.floor(gridCtl.h / rowH))); else { top = K.clamp(top + Math.sign(e.deltaY) * 3, 12, 127); } redraw(); };
    const laneValue = y => { const [lo, hi] = limits[activeLane], top = valueTop(); return Math.round(K.clamp((laneCtl.h - 4 - y) / (laneCtl.h - top - 4), 0, 1) * (hi - lo) + lo); };
    function nearest(t, points) { return points.reduce((best, p) => Math.abs(p.t - t) < Math.abs((best?.t ?? Infinity) - t) ? p : best, null); }
    /* What a press on the lane does at (x, y): hover and press ask this same question, so the cursor and the hint beside
       the pointer always describe the gesture (marker = explain and show its lane, point = move, empty = add, Alt = ramp,
       velocity = the note under the pointer). */
    function laneGestureAt(x, y, m = {}) {
      const p = R.part(); if (!p || x < 64 || y < markTop() - 1) return { kind: 'none', cursor: 'default' };
      if (y <= markBottom() + 1) { const mk = markersShown.reduce((b, e) => Math.abs(e.x - x) <= 5 && (!b || Math.abs(e.x - x) < Math.abs(b.x - x)) ? e : b, null);
        return mk ? { kind: 'marker', cursor: 'pointer', marker: mk, hint: mk.text + (mk.lane && mk.lane !== activeLane ? ' Click to show the ' + mk.label + ' lane.' : '') } : { kind: 'none', cursor: 'default' }; }
      const px = (laneCtl.w - 64) / span, at = from + (x - 64) / px, t = xTick(x, m.alt), value = laneValue(y), label = activeLane === 'velocity' ? 'Velocity' : (S.automation.LANES[activeLane] || {}).label || activeLane;
      if (activeLane === 'velocity') {
        if (m.alt) return { kind: 'vramp', cursor: 'crosshair', hint: 'Alt: drag across notes to ramp their velocities' };
        const note = nearest(at, p.notes); if (!note || Math.abs(64 + (note.t - from) * px - x) > 8) return { kind: 'none', cursor: 'default', hint: 'Point at a note’s bar to set its velocity' };
        return { kind: 'velocity', cursor: 'ns-resize', i: p.notes.indexOf(note), hint: 'Drag up or down: this note’s velocity (' + note.v + ')' };
      }
      if (m.alt) return { kind: 'ramp', cursor: 'crosshair', hint: 'Alt: drag to draw a ' + label + ' ramp starting at ' + value };
      const pt = nearest(at, p.automation[activeLane] || []);
      if (pt && Math.abs(64 + (pt.t - from) * px - x) <= 8) return { kind: 'point', cursor: 'grab', point: pt, hint: 'Drag to move this point (' + label + ' ' + pt.v + ', ' + S.automation.where(pt.t) + ') · right-click removes it' };
      return { kind: 'add', cursor: 'crosshair', hint: 'Click to add a ' + label + ' point: ' + value + ' at ' + S.automation.where(t) };
    }
    R.laneGestureAt = laneGestureAt;
    const laneHoverAt = (x, y, alt) => { const g = laneGestureAt(x, y, { alt }); lane.style.cursor = g.cursor; lane.dataset.gesture = g.kind; laneHover = { x, y, g, alt }; laneCtl.invalidate(); };
    lane.addEventListener('pointermove', e => { if (e.buttons) return; const b = lane.getBoundingClientRect(); laneHoverAt(e.clientX - b.left, e.clientY - b.top, e.altKey); });
    lane.addEventListener('pointerleave', () => { laneHover = null; if (!laneDrag) lane.style.cursor = ''; laneCtl.invalidate(); });
    const altKey = e => { if (e.key === 'Alt' && laneHover && !laneDrag) laneHoverAt(laneHover.x, laneHover.y, e.type === 'keydown'); };
    window.addEventListener('keydown', altKey); window.addEventListener('keyup', altKey); off.push(() => { window.removeEventListener('keydown', altKey); window.removeEventListener('keyup', altKey); });
    K.drag(lane, { start(d) { const g = laneGestureAt(d.x, d.y, d); if (g.kind === 'none') return false; lane.focus();
        if (g.kind === 'marker') { if (g.marker.lane) R.showLane(g.marker.lane); return false; }
        const t = xTick(d.x, d.alt), value = laneValue(d.y), label = 'Lane gesture ' + (++editId);   /* one undo step per gesture */
        if (g.kind === 'velocity') { R.velocity([g.i], value, label); return { kind: g.kind, t, value, i: g.i, label }; }
        if (g.kind === 'vramp' || g.kind === 'ramp') return { kind: g.kind, t, value, label };
        R.lanePoint(activeLane, t, value, g.kind === 'point' ? g.point.t : undefined, label); lane.style.cursor = 'grabbing'; return { kind: g.kind, t, value, oldTick: t, label };
      }, move(d) { const st = d.state, t = xTick(d.x, d.alt), value = laneValue(d.y), label = activeLane === 'velocity' ? 'Velocity' : (S.automation.LANES[activeLane] || {}).label || activeLane;
        if (st.kind === 'velocity') R.velocity([st.i], value, st.label);
        else if (st.kind === 'vramp') { const lo = Math.min(t, st.t), hi = Math.max(t, st.t); edit(st.label, p => p.notes.forEach(n => { if (n.t >= lo && n.t <= hi) n.v = K.clamp(Math.round(st.value + (value - st.value) * (n.t - st.t) / (t - st.t || 1)), 1, 127); })); }
        else if (st.kind === 'ramp') R.ramp(activeLane, st.t, t, st.value, value, st.label);
        else { R.lanePoint(activeLane, t, value, st.oldTick, st.label); st.oldTick = t; }
        laneDrag = { x: d.x, y: d.y, hint: label + ' ' + value + ' · ' + S.automation.where(t) }; K.status(label + ': ' + value); laneCtl.invalidate();
      }, end(d, cancelled) { laneDrag = null; if (cancelled) S.state.undo(); laneHoverAt(d.x, d.y, d.alt); } });
    lane.oncontextmenu = e => { e.preventDefault(); if (activeLane === 'velocity') return; const b = lane.getBoundingClientRect(), g = laneGestureAt(e.clientX - b.left, e.clientY - b.top, {}); if (g.kind === 'point') R.laneDelete(activeLane, g.point.t); else K.status('Right-click a point to remove it.'); };
    const typingKeys = 'awsedftgyhujk'; const keydown = e => { if (!R.typing || e.ctrlKey || e.metaKey || e.altKey || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return; const key = e.key.toLowerCase(); if (key === 'z' || key === 'x') { e.preventDefault(); e.stopPropagation(); R.octave = K.clamp(R.octave + (key === 'x' ? 1 : -1), 0, 8); return; } const n = typingKeys.indexOf(key); if (n < 0) return; e.preventDefault(); e.stopPropagation(); if (!e.repeat) hold('typing-' + key, R.inputNote(12 * (R.octave + 1) + n, 100)); };
    grid.addEventListener('keydown', keydown, true); grid.addEventListener('keyup', e => release('typing-' + e.key.toLowerCase())); grid.addEventListener('blur', () => { for (const key of [...stops.keys()]) release(key); });
    off = [S.on('project', redraw), S.on('selection', () => { redraw(); }), S.on('transport', () => { if (R.follow && S.transport.playing && (S.transport.position < from || S.transport.position > from + span)) { from = Math.floor(S.transport.position / 192) * 192; redraw(); } gridCtl.invalidateOverlay(); })];
    return () => { off.forEach(fn => fn()); gridCtl.destroy(); laneCtl.destroy(); if (midi) { for (const input of midi.inputs.values()) input.onmidimessage = null; midi.onstatechange = null; } for (const key of [...stops.keys()]) release(key); root = gridCtl = laneCtl = null; };
  };
})(window);
