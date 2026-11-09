/* Studio panels: columns that resize by dragging and hide, as in a professional editing suite. One shared system for every module's column layouts.
 *
 *   CPS3Panels.attach(container, { id, title, columns: [ { el, name, size, min, max } | { flex: true } | { fixed: '1px' } ] })
 *     container is a CSS grid; each entry is one of its columns, in order. A sized column gets a splitter on its inner
 *     edge (the cursor shows col-resize before the press): drag to resize, double-click to restore its size, the
 *     button on the edge hides it, and a hidden column leaves a tab on the edge that brings it back. Sizes and hidden
 *     columns are remembered per layout (Kit.pref 'panels.<id>'); every layout on the page answers Reset layout.
 *     -> { layout(), reset(), toggle(name), destroy() }
 *   CPS3Panels.menu(anchor): the Panels menu (show or hide each column, Reset layout); also in Ctrl K.
 */
(function (g) {
  'use strict';
  const K = g.Kit, el = K.el, live = new Set();
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  function attach(container, o) {
    const key = 'panels.' + o.id, saved = K.pref(key, null) || {};
    const cols = o.columns.map(c => ({ ...c, width: c.el ? clamp(saved.sizes && saved.sizes[c.name] || c.size, c.min || 120, c.max || 900) : 0, hidden: !!(saved.hidden && saved.hidden[c.name]) }));
    if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
    container.classList.add('panels');
    const save = () => K.pref.set(key, { sizes: Object.fromEntries(cols.filter(c => c.el).map(c => [c.name, Math.round(c.width)])), hidden: Object.fromEntries(cols.filter(c => c.el && c.hidden).map(c => [c.name, true])) });
    const handles = [];
    cols.forEach((c, i) => {
      if (!c.el) return;
      const side = cols.slice(0, i).some(x => x.flex) ? 'right' : 'left';
      const hide = el('button.panel-hide', { type: 'button', 'aria-label': 'Hide ' + c.name, 'data-tip': 'Hide ' + c.name + '|Fold this panel away; the tab on the edge brings it back. Panels menu: Ctrl K, then Panels.' }, side === 'left' ? '‹' : '›');
      const tab = el('button.panel-tab.' + side, { type: 'button', 'data-tip': 'Show ' + c.name + '|Bring this panel back.' }, side === 'left' ? '›' : '‹', el('span', null, c.name));
      const grip = el('div.panel-split', { role: 'separator', tabindex: 0, 'aria-orientation': 'vertical', 'aria-label': 'Resize ' + c.name, 'data-tip': c.name + '|Drag to resize. Double-click: its usual size. Arrow keys: 16 px.' }, hide);
      hide.addEventListener('pointerdown', e => e.stopPropagation());
      hide.onclick = () => toggle(c.name, true); tab.onclick = () => toggle(c.name, false);
      let start = null;
      grip.addEventListener('pointerdown', e => { if (e.button || c.hidden) return; start = { x: e.clientX, w: c.width }; try { grip.setPointerCapture(e.pointerId); } catch (_) {} grip.classList.add('dragging'); e.preventDefault(); });
      grip.addEventListener('pointermove', e => { if (!start) return; const d = e.clientX - start.x; c.width = clamp(start.w + (side === 'left' ? d : -d), c.min || 120, c.max || 900); layout(); });
      const end = () => { if (!start) return; start = null; grip.classList.remove('dragging'); save(); g.dispatchEvent(new Event('resize')); };
      grip.addEventListener('pointerup', end); grip.addEventListener('pointercancel', end); grip.addEventListener('lostpointercapture', end);
      grip.addEventListener('dblclick', () => { c.width = c.size; layout(); save(); g.dispatchEvent(new Event('resize')); });
      grip.addEventListener('keydown', e => { const d = { ArrowLeft: -16, ArrowRight: 16 }[e.key]; if (d) { e.preventDefault(); c.width = clamp(c.width + (side === 'left' ? d : -d), c.min || 120, c.max || 900); layout(); save(); } else if (e.key === 'Enter') toggle(c.name); });
      grip.addEventListener('contextmenu', e => { e.preventDefault(); menu(grip); });
      container.append(grip, tab); handles.push({ c, grip, tab, side });
    });
    function layout() {
      container.style.gridTemplateColumns = cols.map(c => c.flex ? 'minmax(0,1fr)' : c.fixed ? c.fixed : c.hidden ? '0px' : Math.round(c.width) + 'px').join(' ');
      for (const c of cols) if (c.el) c.el.classList.toggle('panel-hidden', c.hidden);
      /* the splitter sits on the column's inner edge: after the columns before it (left) or before the columns after it (right) */
      for (const h of handles) {
        const i = cols.indexOf(h.c), w = x => x.flex ? 0 : x.hidden ? 0 : x.fixed ? parseFloat(x.fixed) || 0 : x.width;
        const before = cols.slice(0, i + 1).filter(x => !x.flex).reduce((n, x) => n + w(x), 0), after = cols.slice(i).filter(x => !x.flex).reduce((n, x) => n + w(x), 0);
        if (h.side === 'left') { h.grip.style.left = before - 3 + 'px'; h.grip.style.right = ''; h.tab.style.left = '0'; h.tab.style.right = ''; }
        else { h.grip.style.right = after - 3 + 'px'; h.grip.style.left = ''; h.tab.style.right = '0'; h.tab.style.left = ''; }
        h.grip.hidden = h.c.hidden; h.tab.hidden = !h.c.hidden;
      }
    }
    function toggle(name, hidden) { const c = cols.find(x => x.name === name); if (!c) return; c.hidden = hidden === undefined ? !c.hidden : hidden; layout(); save(); g.dispatchEvent(new Event('resize')); K.status((c.hidden ? 'Hid ' : 'Showing ') + c.name + (c.hidden ? '. The tab on the edge brings it back.' : '.')); }
    function reset() { for (const c of cols) { c.width = c.size; c.hidden = false; } layout(); K.pref.set(key, null); g.dispatchEvent(new Event('resize')); }
    const api = { id: o.id, title: o.title || o.id, columns: cols, layout, reset, toggle, destroy() { live.delete(api); for (const h of handles) { h.grip.remove(); h.tab.remove(); } container.style.gridTemplateColumns = ''; container.classList.remove('panels'); } };
    live.add(api); layout();
    return api;
  }
  function menu(anchor) {
    const items = [{ heading: 'Panels' }];
    for (const p of live) { if (!p.columns.some(c => c.el && document.contains(c.el))) continue; for (const c of p.columns) if (c.el) items.push({ label: c.name, checked: !c.hidden, run: () => p.toggle(c.name) }); }
    items.push('-', { label: 'Reset layout', run: () => { for (const p of live) p.reset(); K.status('Panels back to their usual sizes.'); } });
    return K.menu(anchor, items);
  }
  K.action({ id: 'studio.panels', title: 'Panels', hint: 'Show or hide the panels of this workspace, or reset the layout.', run: () => menu(document.querySelector('[data-studio-modes]') || document.body) });
  K.action({ id: 'studio.panels.reset', title: 'Reset layout', hint: 'Every panel back to its usual size, none hidden.', run: () => { for (const p of live) p.reset(); K.status('Panels back to their usual sizes.'); } });
  g.CPS3Panels = { attach, menu };
})(window);
