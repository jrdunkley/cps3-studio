/* CPS3 Studio kit: behaviour. Defines window.Kit (and module.exports, so Node can load it for the gate).
 *
 * The look is kit.css and icons.js; this file is how every Studio module behaves the same way: tooltips and the status
 * line, actions and shortcuts, the command palette, menus, dialogs, toasts, sliders and knobs that feel right, split
 * panes, sharp canvases, drag and wheel, storage, files. It knows nothing about music. Plain script, no build step, no
 * third-party code. Loading this file does not touch the page: the page is wired once, when it is ready (Kit.init), so
 * the pure parts (fmt, keys, fuzzy, the action registry, store, pref) also run in Node.
 *
 * Reference page, every control live: demo.html. Spec: music_editor/docs/plan/wp/B1_kit.md and 05_UX.md.
 *
 *   Kit.el(tag, props, ...kids)      Kit.icon(name)    Kit.clamp    Kit.css('--token')    Kit.fmt.*
 *   data-tip="Name|One sentence|Dim line" data-keys="Ctrl K"      Kit.status(text)      Kit.tip.*
 *   Kit.action({ id, title, hint, keys, group, run, enabled, checked })   Kit.bind(el, id)   Kit.run(id)   Kit.keys.*
 *   Kit.palette()   Kit.paletteSource(fn)   Kit.keymap()   Kit.fuzzy.*
 *   Kit.menu(anchor, items)   Kit.dialog(opts)   Kit.confirm   Kit.prompt   Kit.alert   Kit.toast(text, opts)
 *   Kit.slider   Kit.knob   Kit.number   Kit.seg   Kit.toggle   Kit.select   Kit.split   Kit.tabs
 *   Kit.canvas   Kit.drag   Kit.wheel      Kit.store(name)   Kit.pref(key, default)
 *   Kit.download   Kit.pickFile   Kit.readFile   Kit.drop   Kit.pickFolder   Kit.saveInto
 */
(function (g) {
  'use strict';
  const DOM = typeof document !== 'undefined' && typeof window !== 'undefined';
  const Kit = {};
  const isFn = (f) => typeof f === 'function';
  const clamp = (v, lo, hi) => (v !== v ? lo : v < lo ? lo : v > hi ? hi : v);
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const nextFrame = (fn) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(fn) : setTimeout(fn, 16));
  const decimals = (x) => ((String(x).split('.')[1] || '').replace(/e.*$/, '')).length;
  const DOT = String.fromCharCode(183);              /* the middle dot between a name and its sentence in the status line */
  Kit.clamp = clamp;

  /* ================================================================================== elements and icons == */
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const SVG_TAGS = new Set(['svg', 'use', 'path', 'g', 'circle', 'rect', 'line', 'polyline', 'polygon', 'ellipse', 'defs', 'symbol', 'text', 'tspan']);
  function classText(v) {
    if (!v) return '';
    if (Array.isArray(v)) return v.map(classText).filter(Boolean).join(' ');
    if (typeof v === 'object') return Object.keys(v).filter((k) => v[k]).join(' ');
    return String(v);
  }
  function setProp(node, k, v, svg) {
    if (v == null || v === false) return;
    if (k === 'class' || k === 'className') { const c = [node.getAttribute('class'), classText(v)].filter(Boolean).join(' '); node.setAttribute('class', c); return; }
    if (k === 'style') {
      if (typeof v === 'string') node.style.cssText += v;
      else for (const [p, val] of Object.entries(v)) { if (val == null || val === false) continue; if (p.includes('-')) node.style.setProperty(p, String(val)); else node.style[p] = val; }
      return;
    }
    if (k === 'dataset') { for (const [p, val] of Object.entries(v)) if (val != null) node.dataset[p] = String(val); return; }
    if (k === 'text') { node.textContent = String(v); return; }
    if (k.length > 2 && k[0] === 'o' && k[1] === 'n' && isFn(v)) { node.addEventListener(k.slice(2).toLowerCase(), v); return; }
    if (k === 'for') k = 'htmlFor';
    if (!svg && k in node && typeof v !== 'object') { node[k] = v; return; }
    node.setAttribute(k, v === true ? '' : String(v));
  }
  function append(node, kids) {
    for (const k of kids) {
      if (k == null || k === false || k === true) continue;
      if (Array.isArray(k)) append(node, k);
      else if (typeof k === 'object' && k.nodeType) node.append(k);
      else node.append(document.createTextNode(String(k)));
    }
  }
  /* el('button.btn.primary#save', { onclick, title: 'x', style: { '--v': .5 } }, icon('save'), 'Save')
   * props: class (string, array or { name: bool }), style (string or object), dataset, on<event> functions, text, and any
   * property or attribute; null, undefined and false are skipped. children: strings, numbers, nodes, arrays; the rest is skipped. */
  Kit.el = function el(tag, props, ...kids) {
    const m = /^([\w:-]+)((?:[.#][\w-]+)*)$/.exec(tag);
    if (!m) throw new TypeError('Kit.el: bad tag ' + tag);
    const svg = SVG_TAGS.has(m[1]);
    const node = svg ? document.createElementNS(SVG_NS, m[1]) : document.createElement(m[1]);
    const classes = [];
    m[2].replace(/([.#])([\w-]+)/g, (_, k, v) => { if (k === '.') classes.push(v); else node.id = v; });
    if (classes.length) node.setAttribute('class', classes.join(' '));
    if (props && typeof props === 'object' && !props.nodeType && !Array.isArray(props)) for (const [k, v] of Object.entries(props)) setProp(node, k, v, svg);
    else if (props != null && props !== false) kids.unshift(props);
    append(node, kids);
    return node;
  };
  const el = Kit.el;
  /* the sprite is injected by icons.js; this builds the element that points at a symbol */
  Kit.icon = function icon(name, cls) {
    const svg = el('svg', { class: 'ic' + (cls ? ' ' + cls : ''), 'aria-hidden': 'true' });
    svg.append(el('use', { href: '#i-' + name }));
    return svg;
  };
  const icon = Kit.icon;
  /* a token's value, for canvas code: Kit.css('--accent'). Cached until the next canvas draw (or Kit.css.flush()) */
  const cssCache = new Map();
  Kit.css = function css(name) {
    if (!DOM) return '';
    if (!cssCache.has(name)) cssCache.set(name, getComputedStyle(document.documentElement).getPropertyValue(name).trim());
    return cssCache.get(name);
  };
  Kit.css.flush = () => cssCache.clear();

  /* ======================================================================================== formatting == */
  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const grouped = (digits) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  Kit.fmt = {
    /* bars.beats.ticks as a musician reads it: bar and beat count from 1, ticks from 0 ("9.3.24"); 48 ticks to a beat, 4 to a bar unless told */
    pos(ticks, o) {
      const beat = (o && o.beat) || 48, beats = (o && o.beats) || 4, per = beat * beats, t = Math.round(+ticks || 0);
      const bar = Math.floor(t / per), rest = t - bar * per, b = Math.floor(rest / beat);
      return `${bar + 1}.${b + 1}.${rest - b * beat}`;
    },
    /* MIDI number to name: 60 is C4 (the plan's reading), 61 is C#4 */
    note(n) { if (!Number.isFinite(n)) return '-'; n = Math.round(n); return NOTE_NAMES[((n % 12) + 12) % 12] + (Math.floor(n / 12) - 1); },
    parseNote(s) {
      const m = /^([A-Ga-g])([#b]?)(-?\d+)$/.exec(String(s).trim());
      if (!m) return null;
      return (parseInt(m[3], 10) + 1) * 12 + { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }[m[1].toLowerCase()] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
    },
    /* "812 B", "4.1 KB", "5.0 MB" (1 KB is 1024 bytes); { kb: true } always gives KB ("0.4 KB") */
    bytes(n, o) {
      n = Math.max(0, +n || 0);
      const kb = o && o.kb;
      if (!kb && n < 1024) return Math.round(n) + ' B';
      return n < 1048576 || kb ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB';
    },
    int(n) { return Number.isFinite(n) ? (n < 0 ? '-' : '') + grouped(String(Math.round(Math.abs(n)))) : '-'; },
    /* seconds as m:ss.t */
    time(sec) {
      const tenths = Math.round(Math.max(0, +sec || 0) * 10), m = Math.floor(tenths / 600), rest = (tenths - m * 600) / 10;
      return `${m}:${rest.toFixed(1).padStart(4, '0')}`;
    },
    pct(x) { return Math.round(x * 100) + '%'; },
    signed(n) { return n > 0 ? '+' + n : String(n); },
  };

  /* ======================================================================================= key names == */
  const KEY_ALIASES = { escape: 'esc', return: 'enter', del: 'delete', ' ': 'space', spacebar: 'space', arrowup: 'up', arrowdown: 'down', arrowleft: 'left', arrowright: 'right', pgup: 'pageup', pgdn: 'pagedown', ins: 'insert' };
  const MOD_ALIASES = { ctrl: 'ctrl', control: 'ctrl', mod: 'ctrl', cmd: 'ctrl', command: 'ctrl', shift: 'shift', alt: 'alt', option: 'alt', opt: 'alt', meta: 'meta', win: 'meta', super: 'meta' };
  const KEY_WORDS = { pageup: 'PageUp', pagedown: 'PageDown' };
  /* 'Ctrl+Shift+Z', 'Ctrl K', 'Space', '?', 'Ctrl++' -> { ctrl, shift, alt, meta, key }. Ctrl also stands for the Mac command key. */
  function parseKeys(spec) {
    let s = String(spec).trim(), key = '';
    if (/(^|[+\s])\+$/.test(s)) { key = '+'; s = s.slice(0, -1); }
    const tokens = s.split(/[+\s]+/).filter(Boolean), p = { ctrl: false, shift: false, alt: false, meta: false, key: '' };
    if (!key) key = tokens.pop() || '';
    for (const t of tokens) { const mod = MOD_ALIASES[t.toLowerCase()]; if (!mod) throw new TypeError(`Kit.keys: "${t}" is not a modifier in "${spec}"`); p[mod] = true; }
    key = key.length === 1 ? key.toLowerCase() : (KEY_ALIASES[key.toLowerCase()] || key.toLowerCase());
    if (!key || MOD_ALIASES[key]) throw new TypeError(`Kit.keys: no key in "${spec}"`);
    p.key = key;
    return p;
  }
  const labelKeys = (spec) => {
    const p = typeof spec === 'string' ? parseKeys(spec) : spec, k = p.key;
    return [p.ctrl && 'Ctrl', p.shift && 'Shift', p.alt && 'Alt', p.meta && 'Meta', KEY_WORDS[k] || (k.length === 1 ? k.toUpperCase() : k[0].toUpperCase() + k.slice(1))].filter(Boolean).join(' ');
  };
  /* the key an event means, so shortcuts survive other layouts: an ASCII letter or digit as typed, else the physical key */
  function eventKey(e) {
    const k = e.key || '', code = e.code || '';
    if (k.length === 1 && /[a-zA-Z0-9]/.test(k)) return k.toLowerCase();
    if (k === ' ' || code === 'Space') return 'space';
    let m;
    if ((m = /^Key([A-Z])$/.exec(code))) return m[1].toLowerCase();
    if ((m = /^(?:Digit|Numpad)(\d)$/.exec(code))) return m[1];
    if (k.length === 1) return k;
    return KEY_ALIASES[k.toLowerCase()] || k.toLowerCase();
  }
  function matchesKeys(spec, e) {
    const p = typeof spec === 'string' ? parseKeys(spec) : spec;
    if (eventKey(e) !== p.key) return false;
    if (!(p.key.length === 1 && !/[a-z0-9]/.test(p.key)) && !!e.shiftKey !== p.shift) return false;   /* shift is part of a symbol's own character */
    if (!!e.altKey !== p.alt) return false;
    const c = !!e.ctrlKey, mt = !!e.metaKey;
    return p.meta ? mt && (p.ctrl ? c : !c) : p.ctrl ? c || mt : !(c || mt);
  }
  const sameCombo = (a, b) => a.key === b.key && a.ctrl === b.ctrl && a.shift === b.shift && a.alt === b.alt && a.meta === b.meta;

  /* ======================================================================== actions, shortcuts, scopes == */
  const actions = new Map();
  let bindings = [];                                 /* { keys: parsed, action } */
  let curScope = null;
  const isEnabled = (a) => !isFn(a.enabled) || !!a.enabled();
  /* Kit.action({ id, title, hint, keys: 'Ctrl+S, F5', group, icon, note, scope, repeat, run, enabled, checked }) registers a command once; buttons, menus,
   * shortcuts, tooltips and the palette all reuse it. id, title, hint and run are required (a missing one throws: every action is described).
   * Registering an id again replaces the action. scope: the action only fires while that scope is current (Kit.scope('roll') or a data-scope ancestor). */
  Kit.action = function action(spec) {
    if (!spec || typeof spec !== 'object') throw new TypeError('Kit.action needs an object { id, title, hint, run }');
    for (const k of ['id', 'title', 'hint']) if (typeof spec[k] !== 'string' || !spec[k].trim()) throw new TypeError(`Kit.action(${spec.id || '?'}): ${k} is required, a sentence in plain words`);
    if (!isFn(spec.run)) throw new TypeError(`Kit.action(${spec.id}): run must be a function`);
    const list = spec.keys == null || spec.keys === '' ? [] : Array.isArray(spec.keys) ? spec.keys : String(spec.keys).split(/\s*,\s*(?=\S)/);
    const parsed = list.map(parseKeys);
    const a = Object.assign({}, spec, { keys: list.slice(), scope: spec.scope || 'global', group: spec.group || 'General' });
    Kit.action.remove(spec.id);
    actions.set(a.id, a);
    for (const p of parsed) bindings.push({ keys: p, action: a });
    refresh();
    return a;
  };
  Kit.action.get = (id) => actions.get(id);
  Kit.action.remove = (id) => { const had = actions.delete(id); bindings = bindings.filter((b) => b.action.id !== id); return had; };
  Kit.actions = () => Array.from(actions.values());
  Kit.run = function run(id, ...args) {
    const a = actions.get(id);
    if (!a || !isEnabled(a)) return undefined;
    const r = a.run(...args);
    refresh();
    return r;
  };
  Kit.scope = (name) => { if (name !== undefined) curScope = name; return curScope; };
  Kit.keys = {
    parse: parseKeys,
    label: labelKeys,
    matches: matchesKeys,
    find(spec) { const p = parseKeys(spec), b = bindings.find((x) => sameCombo(x.keys, p)); return b ? b.action : null; },
  };

  /* buttons that follow an action: tooltip (name, hint, keys), accessible name, enabled and pressed state, optional key chip.
   * An empty element gets the action's icon, or its title when it has no icon. Disabled is aria-disabled, so the tooltip still explains. */
  const bound = new Set();
  const deref = (w) => (typeof WeakRef !== 'undefined' && w instanceof WeakRef ? w.deref() : w);
  Kit.bind = function bind(node, id, opts) {
    Kit.unbind(node);
    const b = { node, id, opts: opts || {}, onclick: (e) => { if (node.getAttribute('aria-disabled') === 'true') { e.preventDefault(); return; } Kit.run(id, e); } };
    node.addEventListener('click', b.onclick);
    node._kitBound = b;
    bound.add(typeof WeakRef !== 'undefined' ? new WeakRef(node) : node);
    syncBound(b);
    return node;
  };
  Kit.unbind = function unbind(node) { const b = node._kitBound; if (!b) return node; node.removeEventListener('click', b.onclick); node._kitBound = null; return node; };
  function syncBound(b) {
    const a = actions.get(b.id), node = b.node;
    if (!a) { node.setAttribute('aria-disabled', 'true'); return; }
    const tip = [a.title, a.hint, a.note || ''].join('|').replace(/\|+$/, ''), keys = a.keys.length ? labelKeys(a.keys[0]) : '';
    const changed = node.getAttribute('data-tip') !== tip || (node.getAttribute('data-keys') || '') !== keys;
    node.setAttribute('data-tip', tip);
    if (keys) node.setAttribute('data-keys', keys); else node.removeAttribute('data-keys');
    node.setAttribute('aria-label', a.title);
    if (!node.hasChildNodes() && b.opts.fill !== false) { if (a.icon) node.append(icon(a.icon)); if (!a.icon || b.opts.label) node.append(a.title); }
    if (b.opts.chip && keys) { let k = node.querySelector(':scope > kbd'); if (!k) { k = el('kbd'); node.append(k); } k.textContent = keys; }
    if (isEnabled(a)) node.removeAttribute('aria-disabled'); else node.setAttribute('aria-disabled', 'true');
    if (isFn(a.checked)) { const on = !!a.checked(); node.classList.toggle('on', on); node.setAttribute('aria-pressed', String(on)); }
    if (changed && T.owner === node && T.node) showTip(node);
  }
  let refreshQueued = false;
  function syncAll() {
    refreshQueued = false;
    for (const w of Array.from(bound)) { const node = deref(w); if (!node) { bound.delete(w); continue; } if (node._kitBound) syncBound(node._kitBound); else bound.delete(w); }
  }
  /* re-read enabled() and checked() of every bound element: after the next frame, or at once with Kit.refresh(true) */
  function refresh(sync) { if (sync === true) { syncAll(); return; } if (!refreshQueued && DOM) { refreshQueued = true; nextFrame(syncAll); } }
  Kit.refresh = refresh;

  /* =================================================================================== fuzzy matching == */
  /* one query word against a text: best subsequence by bonuses (text start, word start, camelCase, consecutive letters), or null */
  function scoreTerm(term, text) {
    const q = term.toLowerCase(), s = text.toLowerCase(), n = s.length, m = q.length;
    if (!m) return { score: 0, idx: [] };
    if (m > n) return null;
    const pos = q.split('').map(() => []);
    for (let j = 0; j < m; j++) for (let i = 0; i < n; i++) if (s[i] === q[j]) pos[j].push(i);
    if (pos.some((p) => !p.length)) return null;
    const bonus = (i) => (i === 0 ? 8 : /[\s\-_/.:]/.test(text[i - 1]) ? 6 : text[i - 1] === text[i - 1].toLowerCase() && text[i] !== text[i].toLowerCase() ? 4 : 0);
    let layer = new Map(), back = [];
    for (const i of pos[0]) layer.set(i, { score: 1 + bonus(i) + (text[i] === term[0] ? 0.5 : 0) - Math.min(i, 8) * 0.25, from: -1 });
    back.push(layer);
    for (let j = 1; j < m; j++) {
      const next = new Map();
      for (const i of pos[j]) {
        let best = null;
        for (const [k, v] of back[j - 1]) {
          if (k >= i) continue;
          const sc = v.score + (k === i - 1 ? 5 : -Math.min(i - k - 1, 6) * 0.5);
          if (!best || sc > best.score) best = { score: sc, from: k };
        }
        if (best) next.set(i, { score: best.score + 1 + bonus(i) + (text[i] === term[j] ? 0.5 : 0), from: best.from });
      }
      if (!next.size) return null;
      back.push(next);
    }
    let end = -1, top = -Infinity;
    for (const [i, v] of back[m - 1]) if (v.score > top) { top = v.score; end = i; }
    let idx = [];
    for (let j = m - 1, i = end; j >= 0; j--) { idx.unshift(i); i = back[j].get(i).from; }
    /* the whole word in one piece beats the same letters spread about; the whole text, or its start, beats a piece in the middle */
    const at = s.indexOf(q);
    let extra = (s === q ? 10 : s.startsWith(q) ? 4 : 0) - n * 0.02;
    if (at >= 0) { extra += at === 0 || /[\s\-_/.:]/.test(text[at - 1]) ? 12 : 6; idx = Array.from({ length: m }, (_, k) => at + k); }
    return { score: top + extra, idx };
  }
  /* every word of the query must match: { score, idx } or null. An empty query matches everything with score 0. */
  function fuzzyMatch(query, text) {
    const terms = String(query).trim().split(/\s+/).filter(Boolean);
    if (!terms.length) return { score: 0, idx: [] };
    let score = 0; const idx = new Set();
    for (const t of terms) { const r = scoreTerm(t, String(text)); if (!r) return null; score += r.score; r.idx.forEach((i) => idx.add(i)); }
    return { score, idx: Array.from(idx).sort((a, b) => a - b) };
  }
  Kit.fuzzy = {
    score(query, text) { const r = fuzzyMatch(query, text); return r ? r.score : -1; },
    /* [{ item, score, idx }] best first; ties keep the input order; getText(item) is the text matched */
    rank(query, items, getText) {
      const out = [];
      items.forEach((item, order) => { const r = fuzzyMatch(query, (getText || String)(item)); if (r) out.push({ item, score: r.score, idx: r.idx, order }); });
      out.sort((a, b) => b.score - a.score || a.order - b.order);
      return out.map(({ item, score, idx }) => ({ item, score, idx }));
    },
  };

  /* ============================================================================== layers: one stack == */
  const layers = [];                                 /* { kind, node, anchor, modal, close(value), onKey(e) } */
  let uid = 0, lastInput = 'pointer';
  const FOCUSABLE = 'button:not([disabled]):not([aria-disabled=true]), [href], input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  const focusables = (root) => Array.from(root.querySelectorAll(FOCUSABLE)).filter((n) => n.offsetParent !== null || n === document.activeElement);
  function pushLayer(l) { l.id = ++uid; l.prevFocus = document.activeElement; layers.push(l); return l; }
  function dropLayer(l, value) {
    const i = layers.indexOf(l);
    if (i < 0) return;
    for (let k = layers.length - 1; k > i; k--) layers[k].close(null);       /* what was opened from this layer goes first */
    layers.splice(i, 1);
    l.node.remove();
    if (l.anchor && l.anchor.setAttribute) l.anchor.setAttribute('aria-expanded', 'false');
    if (l.restoreFocus !== false && l.prevFocus && l.prevFocus.isConnected && isFn(l.prevFocus.focus)) l.prevFocus.focus({ preventScroll: true });
    l.resolve(value);
  }
  Kit.layers = () => layers.length;
  function place(node, r, o) {                       /* a menu-like box below (or above) a rectangle, never off-screen */
    const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight, M = 8, gap = o.gap == null ? 4 : o.gap;
    node.style.maxHeight = (vh - M * 2) + 'px'; node.style.left = '0px'; node.style.top = '0px';
    const w = node.offsetWidth, h = node.offsetHeight, point = r.width === 0 && r.height === 0;
    let x = o.align === 'right' ? r.right - w : r.left, y = point ? r.top : r.bottom + gap;
    if (point && x + w > vw - M) x = r.left - w;
    if (y + h > vh - M) { const above = r.top - gap - h; if (above >= M || r.top > vh - r.bottom) y = point ? r.top - h : above; }
    node.style.left = clamp(x, M, Math.max(M, vw - w - M)) + 'px'; node.style.top = clamp(y, M, Math.max(M, vh - h - M)) + 'px';
  }
  const rectOf = (a) => (a && a.getBoundingClientRect ? a.getBoundingClientRect() : { left: a.x, top: a.y, right: a.x, bottom: a.y, width: 0, height: 0 });

  /* ---- menus ---- */
  /* Kit.menu(anchor, items, { align: 'left'|'right', minWidth: 'anchor' }) -> Promise of the chosen item (or null). anchor: an element, { x, y } or a mouse event.
   * items: { label, icon, keys, run, disabled, checked, danger, action: 'id' } (an action fills in label, keys, enabled and run), '-' for a line, { heading: 'text' }.
   * Opening a menu from the element that already has one open closes it. Up, Down, Home, End, Enter, Esc and typing a name work. */
  Kit.menu = function menu(anchor, items, o) {
    o = o || {};
    if (anchor && anchor.clientX !== undefined && anchor.preventDefault) anchor = { x: anchor.clientX, y: anchor.clientY };
    const open = layers.find((l) => l.kind === 'menu' && l.anchor === anchor && anchor && anchor.nodeType);
    if (open) { open.close(null); return Promise.resolve(null); }
    let resolve; const promise = new Promise((r) => { resolve = r; });
    const node = el('div', { class: 'menu in', role: 'menu' });
    const lead = items.some((it) => it && typeof it === 'object' && (it.icon || it.checked !== undefined));
    const rows = [];
    for (const it of items) {
      if (!it) continue;
      if (it === '-' || it.sep) { node.append(el('hr')); continue; }
      if (it.heading) { node.append(el('h3', null, it.heading)); continue; }
      const a = it.action ? actions.get(it.action) : null;
      const label = it.label || it.title || (a && a.title) || '', keys = it.keys || (a && a.keys[0]);
      const enabled = it.disabled != null ? !it.disabled : a ? isEnabled(a) : true;
      const checked = it.checked !== undefined ? !!(isFn(it.checked) ? it.checked() : it.checked) : a && isFn(a.checked) ? !!a.checked() : undefined;
      const b = el('button', { type: 'button', role: checked === undefined ? 'menuitem' : 'menuitemcheckbox', tabindex: '-1', class: it.danger ? 'danger' : '', 'aria-checked': checked === undefined ? null : String(checked), 'aria-disabled': enabled ? null : 'true' },
        lead && el('span', { class: 'lead' }, checked ? icon('check') : (it.icon || (a && a.icon)) ? icon(it.icon || a.icon) : null), label, keys ? el('kbd', null, labelKeys(keys)) : null);
      b.addEventListener('pointerenter', () => focusRow(b));
      b.addEventListener('click', (e) => { e.preventDefault(); if (enabled) pick(it, a); });
      rows.push({ b, label: label.toLowerCase(), enabled });
      node.append(b);
    }
    const layer = pushLayer({ kind: 'menu', node, anchor, resolve, close: (v) => dropLayer(layer, v) });
    function focusRow(b) { rows.forEach((r) => r.b.classList.toggle('on', r.b === b)); if (b) b.focus({ preventScroll: true }); }
    function pick(it, a) { dropLayer(layer, it); if (isFn(it.run)) it.run(it); else if (a) Kit.run(a.id); }
    let typed = '', typedAt = 0;
    layer.onKey = (e) => {
      const live = rows.filter((r) => r.enabled), cur = live.findIndex((r) => r.b === document.activeElement);
      if (!live.length) return false;
      if (e.key === 'ArrowDown') focusRow(live[(cur + 1) % live.length].b);
      else if (e.key === 'ArrowUp') focusRow(live[(cur <= 0 ? live.length : cur) - 1].b);
      else if (e.key === 'Home') focusRow(live[0].b);
      else if (e.key === 'End') focusRow(live[live.length - 1].b);
      else if (e.key === 'Enter' || e.key === ' ') { if (cur >= 0) live[cur].b.click(); }
      else if (e.key === 'Tab') { layer.close(null); return false; }
      else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        typed = now() - typedAt > 700 ? e.key.toLowerCase() : typed + e.key.toLowerCase(); typedAt = now();
        const hit = live.find((r) => r.label.startsWith(typed)); if (hit) focusRow(hit.b);
      } else return false;
      return true;
    };
    document.body.append(node);
    if (o.minWidth === 'anchor' && anchor && anchor.getBoundingClientRect) node.style.minWidth = anchor.getBoundingClientRect().width + 'px';
    node.style.overflowY = 'auto';
    place(node, rectOf(anchor), o);
    layer.reposition = () => place(node, rectOf(anchor), o);
    if (anchor && anchor.setAttribute) anchor.setAttribute('aria-expanded', 'true');
    if (lastInput === 'key' && rows.some((r) => r.enabled)) focusRow(rows.find((r) => r.enabled).b); else node.setAttribute('tabindex', '-1');
    promise.close = layer.close; promise.el = node;
    return promise;
  };

  /* ---- dialogs ---- */
  /* Kit.dialog({ title, text, body, buttons, width, focus, dismiss }) -> Promise of the pressed button's value, or null when dismissed (Esc, a click outside).
   * body: a node, a string, an array, or a function(ctx) giving one; ctx = { el, close(value) }. buttons: [{ label, value, primary, danger, ghost, check }];
   * value may be a function (called when pressed); check() returning false keeps the dialog open. Enter in a field presses the primary button.
   * Tab stays inside; focus goes back to where it was. promise.close(value) closes it from outside. */
  Kit.dialog = function dialog(o) {
    o = o || {};
    let resolve; const promise = new Promise((r) => { resolve = r; });
    const id = 'kit-dialog-' + (uid + 1);
    const buttons = o.buttons || [{ label: 'OK', value: true, primary: true }];
    const cancelValue = o.cancelValue === undefined ? null : o.cancelValue;
    const ctx = { el: null, close: (v) => dropLayer(layer, v) };
    const content = isFn(o.body) ? o.body(ctx) : o.body;
    const btns = buttons.map((b) => el('button', { type: 'button', class: ['btn', b.primary && 'primary', b.danger && 'danger', b.ghost && 'ghost'], onclick: () => press(b) }, b.label));
    const dlg = el('div', { class: 'dialog in', role: o.role || 'dialog', 'aria-modal': 'true', 'aria-labelledby': o.title ? id : null },
      o.title || o.text ? el('header', null, o.title ? el('h2', { id }, o.title) : null, o.text ? el('p', null, o.text) : null) : null,
      content != null ? el('div', { class: 'body' }, content) : null,
      el('footer', null, btns));
    if (o.width) dlg.style.width = `min(${o.width}px, calc(100vw - 48px))`;
    ctx.el = dlg;
    const scrim = el('div', { class: 'scrim in' }, dlg);
    function press(b) {
      if (isFn(b.check) && b.check(ctx) === false) return;
      dropLayer(layer, isFn(b.value) ? b.value(ctx) : b.value);
    }
    const layer = pushLayer({ kind: 'dialog', node: scrim, modal: true, resolve, close: (v) => dropLayer(layer, v) });
    layer.onKey = (e) => {
      if (e.key === 'Tab') {
        const f = focusables(dlg);
        if (!f.length) { e.preventDefault(); return true; }
        const i = f.indexOf(document.activeElement);
        if (e.shiftKey && i <= 0) { f[f.length - 1].focus(); e.preventDefault(); return true; }
        if (!e.shiftKey && (i < 0 || i === f.length - 1)) { f[0].focus(); e.preventDefault(); return true; }
        return false;
      }
      if (e.key === 'Enter' && e.target && e.target.tagName === 'INPUT' && dlg.contains(e.target)) {
        const i = buttons.findIndex((b) => b.primary);
        if (i >= 0 && btns[i].getAttribute('aria-disabled') !== 'true') { e.preventDefault(); press(buttons[i]); return true; }
      }
      return false;
    };
    scrim.addEventListener('pointerdown', (e) => { if (e.target === scrim && o.dismiss !== false) dropLayer(layer, cancelValue); });
    layer.cancel = () => { if (o.dismiss !== false) dropLayer(layer, cancelValue); };
    document.body.append(scrim);
    const first = (o.focus && (typeof o.focus === 'string' ? dlg.querySelector(o.focus) : o.focus)) || dlg.querySelector('[autofocus]') ||
      (buttons.some((b) => b.primary && b.danger) ? btns[buttons.findIndex((b) => !b.danger)] : btns[Math.max(0, buttons.findIndex((b) => b.primary))]) || dlg;
    if (first && first.focus) first.focus({ preventScroll: true });
    promise.close = ctx.close; promise.el = dlg;
    return promise;
  };
  Kit.alert = (text, o) => Kit.dialog(Object.assign({ text, buttons: [{ label: 'OK', value: true, primary: true }] }, o));
  Kit.confirm = (text, o) => {
    o = o || {};
    return Kit.dialog({ title: o.title || 'Are you sure?', text, cancelValue: false, buttons: [{ label: o.cancel || 'Cancel', value: false }, { label: o.ok || 'OK', value: true, primary: true, danger: !!o.danger }] });
  };
  /* Kit.prompt(text, { title, value, placeholder, ok, cancel, validate(value) -> true | 'what is wrong' }) -> Promise of the text, or null */
  Kit.prompt = (text, o) => {
    o = o || {};
    const input = el('input', { class: 'field wide', type: 'text', value: o.value == null ? '' : o.value, placeholder: o.placeholder || '', autofocus: true, spellcheck: false });
    const err = el('p', { class: 'hint bad', hidden: true });
    input.addEventListener('input', () => { err.hidden = true; input.classList.remove('invalid'); });
    return Kit.dialog({ title: o.title || text, text: o.title ? text : null, body: [input, err], buttons: [{ label: o.cancel || 'Cancel', value: null }, {
      label: o.ok || 'OK', primary: true, value: () => input.value,
      check: () => { const r = isFn(o.validate) ? o.validate(input.value) : true; if (r === true || r === undefined) return true; err.textContent = typeof r === 'string' ? r : 'That does not work.'; err.hidden = false; input.classList.add('invalid'); input.focus(); return false; },
    }] });
  };

  /* ---- toasts ---- */
  let toastBox = null;
  /* Kit.toast(text, { kind: 'info'|'good'|'warn'|'bad', action: { label, run }, ms }) -> { close }. ms 0 stays until closed. At most four show. */
  Kit.toast = function toast(text, o) {
    if (typeof o === 'string') o = { kind: o };
    o = o || {};
    const kind = o.kind || 'info';
    if (!toastBox || !toastBox.isConnected) { toastBox = el('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' }); document.body.append(toastBox); }
    let timer = 0, closed = false;
    const ms = o.ms != null ? o.ms : kind === 'bad' ? 8000 : o.action || kind === 'warn' ? 6000 : 4000;
    const close = () => {
      if (closed) return; closed = true; clearTimeout(timer);
      node.classList.add('out'); setTimeout(() => node.remove(), 180);
    };
    const node = el('div', { class: 'toast in ' + kind }, icon({ info: 'info', good: 'check', warn: 'warn', bad: 'warn' }[kind] || 'info'), el('span', { class: 'grow' }, text),
      o.action ? el('button', { type: 'button', class: 'btn ghost', onclick: () => { close(); if (isFn(o.action.run)) o.action.run(); } }, o.action.label) : null,
      el('button', { type: 'button', class: 'btn icon ghost', 'aria-label': 'Dismiss', onclick: close }, icon('close')));
    const arm = (t) => { clearTimeout(timer); if (ms > 0) timer = setTimeout(close, t); };
    node.addEventListener('pointerenter', () => clearTimeout(timer)); node.addEventListener('pointerleave', () => arm(1500));
    toastBox.append(node);
    while (toastBox.querySelectorAll('.toast:not(.out)').length > 4) toastBox.querySelector('.toast:not(.out)').remove();
    arm(ms);
    return { close, el: node };
  };

  /* ==================================================================== tooltips and the status line == */
  const T = { owner: null, node: null, timer: 0, lastHide: -1e9, x: 0, y: 0, pinned: false };
  const parseTip = (s) => { const p = String(s).split('|'); return { name: (p[0] || '').trim(), text: (p[1] || '').trim(), note: (p[2] || '').trim() }; };
  function hideTip() { clearTimeout(T.timer); T.pinned = false; if (T.node) { T.node.remove(); T.node = null; T.lastHide = now(); } }
  function showTip(owner) {
    if (!owner || !owner.isConnected || !owner.getAttribute('data-tip')) return;
    const t = parseTip(owner.getAttribute('data-tip')), keys = owner.getAttribute('data-keys');
    if (T.node) T.node.remove();
    const node = el('div', { class: 'tip in', role: 'tooltip' }, el('b', null, t.name, keys ? el('kbd', null, keys) : null), t.text ? el('span', null, t.text) : null, t.note ? el('em', null, t.note) : null);
    document.body.append(node);
    T.node = node;
    const r = owner.getBoundingClientRect(), big = r.width > 320 || r.height > 120;
    const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight, M = 8, gap = 8;
    node.style.left = '0px'; node.style.top = '0px';
    const w = node.offsetWidth, h = node.offsetHeight;
    const a = big ? { left: T.x, right: T.x, top: T.y, bottom: T.y, width: 0, height: 0 } : r;
    /* below, above, right, left of the control: the first that fits without covering it; else the least moved */
    const spots = big ? [[a.left + 12, a.bottom + 16], [a.left + 12, a.top - 16 - h]] : [
      [a.left + a.width / 2 - w / 2, a.bottom + gap], [a.left + a.width / 2 - w / 2, a.top - gap - h], [a.right + gap, a.top + a.height / 2 - h / 2], [a.left - gap - w, a.top + a.height / 2 - h / 2]];
    let best = null;
    for (const [sx, sy] of spots) {
      const x = clamp(sx, M, Math.max(M, vw - w - M)), y = clamp(sy, M, Math.max(M, vh - h - M));
      const covers = !(x + w <= r.left || x >= r.right || y + h <= r.top || y >= r.bottom);
      const cost = (covers && !big ? 1e6 : 0) + Math.abs(x - sx) + Math.abs(y - sy);
      if (!best || cost < best.cost) best = { x, y, cost };
      if (cost === 0) break;
    }
    node.style.left = best.x + 'px'; node.style.top = best.y + 'px';
  }
  Kit.tip = {
    /* show now (no delay) the tip of an element; it stays until the pointer leaves another element or Kit.tip.hide() */
    show(owner) { T.owner = owner; hoverStatus(owner); showTip(owner); T.pinned = !!T.node; },
    hide() { hideTip(); },
    /* give an element a tip and, if it is showing, redraw it: Kit.tip.set(button, { name, text, note, keys }) */
    set(owner, spec) {
      owner.setAttribute('data-tip', [spec.name, spec.text || '', spec.note || ''].map((x) => String(x).replace(/\|/g, '/')).join('|').replace(/\|+$/, ''));
      if (spec.keys) owner.setAttribute('data-keys', spec.keys); else owner.removeAttribute('data-keys');
      if (T.owner === owner && T.node) showTip(owner);
    },
  };
  const status = { rest: null, hover: null };
  function renderStatus() {
    const node = document.querySelector('.statusbar .hintline, [data-kit-status]');
    if (!node) return;
    const v = status.hover != null ? status.hover : status.rest;
    node.replaceChildren();
    append(node, [v == null ? '' : v]);
  }
  /* Kit.status(text | node | [nodes]) sets what the status line says when the pointer is over nothing; null clears it. Hovering a data-tip or
   * data-status element shows its name, sentence and keys there instead, and the resting text comes back on leaving. */
  Kit.status = function setStatus(v) { status.rest = v; if (DOM) renderStatus(); };
  function hoverStatus(owner) {
    const s = owner && (owner.getAttribute('data-status') || owner.getAttribute('data-tip'));
    if (!s) { status.hover = null; renderStatus(); return; }
    const t = parseTip(s), keys = owner.getAttribute('data-keys');
    status.hover = [el('b', null, t.name), t.text ? ` ${DOT} ${t.text}` : '', t.note ? ` ${DOT} ${t.note}` : '', keys ? [` ${DOT} `, el('kbd', null, keys)] : ''];
    renderStatus();
  }
  function onOver(e) {
    T.x = e.clientX; T.y = e.clientY;
    const t = e.target instanceof Element ? e.target.closest('[data-tip],[data-status]') : null;
    if (t === T.owner) return;
    const had = !!T.node;
    hideTip(); T.owner = t;
    hoverStatus(t);
    if (!t || !t.hasAttribute('data-tip')) return;
    if (had || now() - T.lastHide < 250) showTip(t); else T.timer = setTimeout(() => { if (T.owner === t) showTip(t); }, 450);
  }
  function onOut(e) { if (!e.relatedTarget && T.owner) { hideTip(); T.owner = null; hoverStatus(null); } }

  /* ============================================================================== keyboard and clicks == */
  const NATIVE_EDIT = new Set(['a', 'c', 'v', 'x', 'z', 'y']);
  const isTyping = (t) => !!t && t.nodeType === 1 && (t.isContentEditable || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || (t.tagName === 'INPUT' && !/^(button|checkbox|radio|range|submit|reset|file|color|image)$/i.test(t.type)));
  const ownsArrows = (t) => !!t && t.nodeType === 1 && !!t.closest('input[type=range],[role=slider],[role=spinbutton],[role=separator],[role=tab],[role=radio],[role=menuitem],[role=option]');
  const isButtonish = (t) => !!t && t.nodeType === 1 && !!t.closest('button,a[href],summary,[role=button],[role=switch],[role=checkbox],input[type=checkbox],input[type=radio],input[type=button]');
  const ARROWISH = new Set(['up', 'down', 'left', 'right', 'home', 'end', 'pageup', 'pagedown']);
  /* capture phase: the top layer sees keys first. Esc closes it; its own handler may take more (menus: arrows; dialogs: Tab, Enter) */
  function onKeyLayer(e) {
    lastInput = 'key';
    hideTip();
    const top = layers[layers.length - 1];
    if (!top) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (top.cancel) top.cancel(); else top.close(null); return; }
    if (top.onKey && top.onKey(e) === true) { e.preventDefault(); e.stopPropagation(); }
  }
  /* bubble phase: shortcuts. Text fields keep their typing keys; sliders and tabs keep their arrows; buttons keep Space and Enter; no layer open */
  function onKey(e) {
    if (e.defaultPrevented || e.isComposing || layers.length) return;
    const t = e.target, k = eventKey(e), mod = e.ctrlKey || e.metaKey || e.altKey;
    if (isTyping(t)) {
      if (k === 'esc') { if (isFn(t.blur)) t.blur(); return; }
      if (!mod && !/^f\d+$/.test(k)) return;
      if ((e.ctrlKey || e.metaKey) && !e.altKey && NATIVE_EDIT.has(k)) return;
    }
    if (!mod && ARROWISH.has(k) && ownsArrows(t)) return;
    if (!mod && (k === 'space' || k === 'enter') && isButtonish(t)) return;
    const scopes = [];
    const holder = t && t.closest ? t.closest('[data-scope]') : null;
    if (holder) scopes.push(holder.getAttribute('data-scope'));
    if (curScope) scopes.push(curScope);
    scopes.push('global');
    let best = null, rank = 99, matched = false;
    for (const b of bindings) {
      if (!matchesKeys(b.keys, e)) continue;
      matched = true;
      const r = scopes.indexOf(b.action.scope);
      if (r < 0 || r >= rank || !isEnabled(b.action)) continue;
      best = b.action; rank = r;
    }
    if (best) { e.preventDefault(); if (!e.repeat || best.repeat) Kit.run(best.id, e); } else if (matched && mod) e.preventDefault();   /* a known but unavailable command still keeps the browser's own shortcut away */
  }
  function onPointerDown(e) {
    lastInput = 'pointer';
    hideTip();
    const top = layers[layers.length - 1];
    if (!top || top.kind !== 'menu') return;
    if (top.node.contains(e.target) || (top.anchor && top.anchor.contains && top.anchor.contains(e.target))) return;
    for (let i = layers.length - 1; i >= 0 && layers[i].kind === 'menu'; i--) layers[i].close(null);
  }
  function onFocusIn(e) {
    const top = layers[layers.length - 1];
    if (!top || !top.modal || top.node.contains(e.target)) return;
    const f = focusables(top.node);
    if (f.length) f[0].focus({ preventScroll: true });
  }
  function closeMenus() { for (let i = layers.length - 1; i >= 0 && layers[i].kind === 'menu'; i--) layers[i].close(null); }

  /* ============================================================================ command palette ======= */
  const sources = new Set();
  /* Kit.paletteSource(fn): fn(query) -> items or a promise of items { title, hint, group, icon, keys, run, enabled }; added to the actions. Returns a function that removes it. */
  Kit.paletteSource = (fn) => { sources.add(fn); return () => sources.delete(fn); };
  const recent = () => Kit.pref('palette.recent', []);
  /* Kit.palette({ placeholder, query }) -> Promise of the item that was run (or null). Fuzzy over every action and every source. Opening it again closes it. */
  Kit.palette = function palette(o) {
    o = o || {};
    const open = layers.find((l) => l.kind === 'palette');
    if (open) { open.close(null); return Promise.resolve(null); }
    let resolve; const promise = new Promise((r) => { resolve = r; });
    const input = el('input', { type: 'text', placeholder: o.placeholder || 'Type a command or a name', spellcheck: false, autocomplete: 'off', role: 'combobox', 'aria-label': 'Command palette', 'aria-expanded': 'true' });
    const results = el('div', { class: 'results', role: 'listbox' });
    const box = el('div', { class: 'palette in' }, input, results,
      el('div', { class: 'foot' }, el('kbd', null, 'Up'), el('kbd', null, 'Down'), 'choose', el('kbd', null, 'Enter'), 'run', el('kbd', null, 'Esc'), 'close'));
    const scrim = el('div', { class: 'scrim in' }, box);
    const layer = pushLayer({ kind: 'palette', node: scrim, modal: true, resolve, close: (v) => dropLayer(layer, v) });
    let shown = [], sel = 0, token = 0, base = [], late = [];
    const fromAction = (a) => ({ title: a.title, hint: a.hint, group: a.group, icon: a.icon, keys: a.keys[0], enabled: isEnabled(a), key: a.id, run: () => Kit.run(a.id) });
    const normalise = (it) => Object.assign({ key: it.title }, it, { enabled: it.enabled === undefined ? true : isFn(it.enabled) ? !!it.enabled() : !!it.enabled });
    /* a new query: every source is asked once; a source that answers later (a promise) adds its items when it does */
    function ask() {
      const mine = ++token, q = input.value;
      late = []; base = Kit.actions().map(fromAction);
      for (const src of sources) {
        let r; try { r = src(q); } catch (e) { r = []; }
        if (r && isFn(r.then)) r.then((list) => { if (mine === token) { late = late.concat((list || []).map(normalise)); update(false); } }, () => {});
        else if (Array.isArray(r)) base.push(...r.map(normalise));
      }
      update(true);
    }
    function update(fresh) {
      const q = input.value, items = base.concat(late);
      let ranked;
      if (q.trim()) {
        ranked = [];
        for (const it of items) {
          const t = fuzzyMatch(q, it.title);
          if (t) { ranked.push({ it, score: t.score * 4 - (it.enabled ? 0 : 60), idx: t.idx }); continue; }
          const h = fuzzyMatch(q, `${it.group || ''} ${it.hint || ''}`);
          if (h) ranked.push({ it, score: h.score - (it.enabled ? 0 : 60), idx: [] });
        }
        ranked.sort((a, b) => b.score - a.score);
      } else {
        const rec = recent();
        ranked = items.map((it, order) => ({ it, idx: [], order, r: rec.indexOf(it.key) })).sort((a, b) => (a.r < 0) - (b.r < 0) || (a.r - b.r) || (a.it.group || '').localeCompare(b.it.group || '') || a.order - b.order);
      }
      shown = ranked.slice(0, 60); sel = fresh ? 0 : Math.min(sel, Math.max(0, shown.length - 1));
      draw(q);
    }
    function mark(text, idx) {
      if (!idx.length) return text;
      const out = []; let run = '', on = false;
      for (let i = 0; i < text.length; i++) {
        const hit = idx.includes(i);
        if (hit !== on && run) { out.push(on ? el('mark', null, run) : run); run = ''; }
        on = hit; run += text[i];
      }
      if (run) out.push(on ? el('mark', null, run) : run);
      return out;
    }
    function draw(q) {
      results.replaceChildren();
      if (!shown.length) { results.append(el('div', { class: 'empty' }, el('b', null, 'Nothing matches'), el('span', null, q.trim() ? `Nothing is called "${q.trim()}". Try fewer letters.` : 'Nothing to show yet.'))); return; }
      const anyIcon = shown.some((r) => r.it.icon);                  /* rows without an icon keep its room, so the titles line up */
      shown.forEach((r, i) => {
        const it = r.it;
        const row = el('button', { type: 'button', role: 'option', class: i === sel ? 'on' : '', 'aria-selected': String(i === sel), 'aria-disabled': it.enabled ? null : 'true', tabindex: '-1' },
          it.icon ? icon(it.icon) : anyIcon ? el('span', { class: 'lead' }) : null, el('span', { class: 't' }, mark(it.title, r.idx)), it.hint ? el('span', { class: 'hint' }, it.hint) : null,
          el('small', null, it.keys ? el('kbd', null, labelKeys(it.keys)) : (it.group || '')));
        row.addEventListener('pointerenter', () => { if (sel !== i) { sel = i; mark2(); } });
        row.addEventListener('click', () => choose(i));
        results.append(row);
      });
      const on = results.children[sel]; if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest' });
    }
    function mark2() { Array.from(results.children).forEach((c, i) => { c.classList.toggle('on', i === sel); c.setAttribute('aria-selected', String(i === sel)); }); }
    function choose(i) {
      const r = shown[i];
      if (!r || !r.it.enabled) return;
      const rec = recent().filter((k) => k !== r.it.key); rec.unshift(r.it.key); Kit.pref.set('palette.recent', rec.slice(0, 8));
      dropLayer(layer, r.it);
      if (isFn(r.it.run)) r.it.run(r.it);
    }
    layer.onKey = (e) => {
      const open = actions.get('palette.open');
      if (open && open.keys.some((k) => matchesKeys(k, e))) { layer.close(null); return true; }          /* the key that opened it closes it */
      const n = shown.length, step = (d) => { sel = n ? (sel + d + n) % n : 0; mark2(); const on = results.children[sel]; if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest' }); return true; };
      if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) return step(1);
      if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) return step(-1);
      if (e.key === 'PageDown') return step(Math.min(6, n - 1 - sel) || 0);
      if (e.key === 'PageUp') return step(-Math.min(6, sel) || 0);
      if (e.key === 'Enter') { choose(sel); return true; }
      return false;
    };
    scrim.addEventListener('pointerdown', (e) => { if (e.target === scrim) layer.close(null); });
    input.addEventListener('input', ask);
    input.value = o.query || '';
    document.body.append(scrim);
    ask();
    input.focus();
    promise.close = layer.close;
    return promise;
  };
  /* the key map: every action that has keys, by group */
  Kit.keymap = function keymap() {
    const groups = new Map();
    for (const a of actions.values()) if (a.keys.length) { if (!groups.has(a.group)) groups.set(a.group, []); groups.get(a.group).push(a); }
    const body = Array.from(groups).map(([name, list]) => el('div', { class: 'keymap' }, el('h3', null, name),
      list.map((a) => el('div', { class: 'keyrow' }, el('span', null, a.title), a.keys.map((k) => el('kbd', null, labelKeys(k)))))));
    return Kit.dialog({ title: 'Keyboard shortcuts', text: 'Every key the Studio understands. Press Esc to close.', width: 640, body: body.length ? body : el('p', { class: 'hint' }, 'No shortcuts are set yet.'), buttons: [{ label: 'Close', value: true, primary: true }] });
  };
  Kit.action({ id: 'palette.open', title: 'Command palette', hint: 'Search every command and open anything by name.', keys: 'Ctrl K', group: 'General', icon: 'search', run: () => Kit.palette() });
  Kit.action({ id: 'keymap.show', title: 'Keyboard shortcuts', hint: 'Lists every key the Studio understands.', keys: '?', group: 'General', icon: 'help', run: () => Kit.keymap() });

  /* ================================================================================== drag and wheel == */
  /* Kit.drag(el, { start, move, end, button, threshold, cursor, filter }) with pointer capture. Each callback gets one object:
   * { e, x, y (inside the element), ox, oy (where it began), dx, dy (since the start), moved, state, shift, alt, ctrl }.
   * start(d) may return false to refuse, or a state object handed back as d.state. end(d, cancelled): Esc or pointercancel cancel.
   * threshold: pixels before it counts as a drag (move is not called before). cursor: 'ns' | 'ew' | 'col' | 'row' while dragging. */
  Kit.drag = function drag(host, o) {
    o = o || {};
    let st = null;
    const rect = () => host.getBoundingClientRect();
    const info = (e) => { const r = rect(); return { e, x: e.clientX - r.left, y: e.clientY - r.top, ox: st.ox, oy: st.oy, dx: e.clientX - st.x0, dy: e.clientY - st.y0, moved: st.moved, state: st.state, shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey || e.metaKey, host }; };
    function down(e) {
      if (st || e.button !== (o.button == null ? 0 : o.button) || (o.filter && !o.filter(e))) return;
      const r = rect(), s = { x0: e.clientX, y0: e.clientY, ox: e.clientX - r.left, oy: e.clientY - r.top, moved: false, state: undefined, id: e.pointerId };
      st = s;
      if (o.start) { const res = o.start(info(e)); if (res === false) { st = null; return; } s.state = res; }
      try { host.setPointerCapture(e.pointerId); } catch (err) { /* a synthetic or finished pointer */ }
      if (o.cursor && DOM) document.body.setAttribute('data-cursor', o.cursor);
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', cancel); window.addEventListener('keydown', key, true);
      if (o.preventDefault !== false) e.preventDefault();
    }
    function move(e) {
      if (!st || e.pointerId !== st.id) return;
      if (!st.moved) { if (Math.hypot(e.clientX - st.x0, e.clientY - st.y0) < (o.threshold || 0)) return; st.moved = true; }
      if (o.move) o.move(info(e));
    }
    function finish(e, cancelled) {
      const s = st; if (!s) return;
      const d = info(e); st = null;
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', cancel); window.removeEventListener('keydown', key, true);
      try { host.releasePointerCapture(s.id); } catch (err) { /* already released */ }
      if (o.cursor && DOM) document.body.removeAttribute('data-cursor');
      if (s.moved && o.swallowClick !== false) { const stop = (ev) => { ev.stopPropagation(); ev.preventDefault(); }; host.addEventListener('click', stop, true); setTimeout(() => host.removeEventListener('click', stop, true), 0); }
      if (o.end) o.end(d, cancelled);
    }
    function up(e) { if (st && e.pointerId === st.id) finish(e, false); }
    function cancel(e) { if (st && e.pointerId === st.id) finish(e, true); }
    function key(e) { if (e.key === 'Escape' && st) { e.stopPropagation(); finish(e, true); } }
    host.addEventListener('pointerdown', down);
    host.addEventListener('mousedown', (e) => { if (st) e.preventDefault(); });
    return { destroy() { host.removeEventListener('pointerdown', down); if (st) finish({ clientX: st.x0, clientY: st.y0 }, true); } };
  };
  /* Kit.wheel(el, { scroll(dx, dy, info), zoom(factor, info) }): wheel, trackpad and pinch made alike. Pixels whatever the device (lines and pages converted);
   * Shift turns vertical into horizontal; Ctrl (or a pinch) gives zoom with a factor above 1 for "in". info: { e, x, y, dx, dy, shift, alt, ctrl, pinch }. */
  Kit.wheel = function wheel(host, h) {
    h = h || {};
    const onWheel = (e) => {
      const px = (v) => (e.deltaMode === 1 ? v * 16 : e.deltaMode === 2 ? v * (host.clientHeight || 400) : v);
      const dx = px(e.deltaX), dy = px(e.deltaY), r = host.getBoundingClientRect();
      const info = { e, x: e.clientX - r.left, y: e.clientY - r.top, dx, dy, shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey || e.metaKey, pinch: false };
      if (e.ctrlKey || e.metaKey) {
        if (!isFn(h.zoom)) return;
        info.pinch = e.ctrlKey && !Number.isInteger(e.deltaY);
        e.preventDefault(); h.zoom(Math.exp(-dy * (info.pinch ? 0.01 : 0.0015)), info);
      } else if (isFn(h.scroll)) {
        e.preventDefault();
        h.scroll(e.shiftKey && !dx ? dy : dx, e.shiftKey && !dx ? 0 : dy, info);
      }
    };
    host.addEventListener('wheel', onWheel, { passive: false });
    return { destroy() { host.removeEventListener('wheel', onWheel); } };
  };
  /* one wheel notch (or 40 px of trackpad) is one step; when: 'focus' (default) only while the control has focus, so a scrolling panel is not hijacked */
  function wheelSteps(host, when, apply) {
    let acc = 0;
    host.addEventListener('wheel', (e) => {
      if (when !== 'hover' && document.activeElement !== host) return;
      e.preventDefault();
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      let n = 0;
      if (e.deltaMode === 1 || Math.abs(dy) >= 100) n = Math.sign(dy); else { acc += dy; n = Math.trunc(acc / 40); acc -= n * 40; }
      if (n) apply(-n, e.shiftKey);
    }, { passive: false });
  }

  /* ================================================================================= numeric controls == */
  /* the arithmetic every numeric control shares: a range, a step (0 = continuous), a fine step (a tenth of a step below 1, else the step itself: whole numbers have nothing finer).
   * snap(v) rounds to the step; snap(v, true) to the fine step, which is what Shift and typing use. */
  function numeric(o) {
    const min = +o.min, max = +o.max, step = o.step > 0 ? +o.step : 0, unit = step || (max - min) / 100;
    const fine = o.fine > 0 ? +o.fine : step ? (step < 1 ? step / 10 : step) : unit / 10, dec = Math.max(decimals(step), decimals(fine), decimals(min));
    const snap = (v, f) => {
      v = clamp(+v, min, max);
      const g = step ? (f ? fine : step) : 0;
      if (g) v = clamp(+(min + Math.round((v - min) / g) * g).toFixed(dec), min, max);
      return v;
    };
    return { min, max, step, snap, unit, fine, frac: (v) => (max > min ? (v - min) / (max - min) : 0) };
  }
  const labelOf = (node, o) => {
    if (o.label) return o.label;
    const lab = node.closest && node.closest('label'), first = lab && lab.querySelector(':scope > span:first-child');
    return node.getAttribute('aria-label') || (node.getAttribute('data-tip') || '').split('|')[0] || (first && first.textContent.trim()) || '';
  };
  /* Kit.slider(input, { min, max, step, value, def, format, onInput(v, { fine }), onCommit(v), readout, wheel: 'focus'|'hover', label }) -> { get, set(v, silent), el }.
   * Fills its track to the thumb; drag (a click on the track jumps), arrows, Shift = fine (a tenth of the pace, or the fine step), wheel, double-click = def. */
  Kit.slider = function slider(input, o) {
    o = o || {};
    const n = numeric({ min: o.min != null ? o.min : input.min !== '' ? input.min : 0, max: o.max != null ? o.max : input.max !== '' ? input.max : 100, step: o.step != null ? o.step : input.step && input.step !== 'any' ? input.step : 1, fine: o.fine });
    const fmt = o.format || ((v) => String(v)), start = o.value != null ? o.value : input.value !== '' ? +input.value : n.min, def = o.def != null ? o.def : start;
    input.type = 'range'; input.classList.add('slider'); input.min = n.min; input.max = n.max; input.step = n.step || 'any';
    let value = n.snap(start);
    const paint = () => {
      input.value = value;
      input.style.setProperty('--fill', `calc(6px + (100% - 12px) * ${n.frac(value).toFixed(4)})`);
      input.setAttribute('aria-valuetext', fmt(value)); const lab = labelOf(input, o); if (lab) input.setAttribute('aria-label', lab);
      if (o.readout) o.readout.textContent = fmt(value);
    };
    let fine = false, commitTimer = 0;
    const emit = () => { if (isFn(o.onInput)) o.onInput(value, { fine }); };
    const commit = () => { clearTimeout(commitTimer); if (isFn(o.onCommit)) o.onCommit(value); };
    const soon = () => { clearTimeout(commitTimer); commitTimer = setTimeout(commit, 250); };
    const set = (v, silent, fm) => { v = n.snap(v, fm); if (v === value && !silent) return; value = v; paint(); if (!silent) emit(); };
    paint();
    input.addEventListener('input', () => { const v = n.snap(+input.value); if (v !== value) { value = v; paint(); emit(); } });       /* the browser's own arrow keys */
    input.addEventListener('change', () => commit());
    input.addEventListener('keydown', (e) => {
      if (!e.shiftKey || !/^Arrow(Left|Right|Up|Down)$/.test(e.key)) return;
      e.preventDefault(); fine = true; set(value + (/Right|Up/.test(e.key) ? 1 : -1) * n.fine, false, true); fine = false; soon();
    });
    input.addEventListener('dblclick', () => { set(def); commit(); });
    wheelSteps(input, o.wheel, (dir, shift) => { fine = shift; set(value + dir * (shift ? n.fine : n.unit), false, shift); fine = false; soon(); });
    const geometry = () => { const r = input.getBoundingClientRect(); return { left: r.left + 6, width: Math.max(1, r.width - 12) }; };
    Kit.drag(input, {
      start(d) {
        const gm = geometry(), f = clamp((d.e.clientX - gm.left) / gm.width, 0, 1), onThumb = Math.abs(f - n.frac(value)) * gm.width <= 9;
        input.focus({ preventScroll: true });
        if (!onThumb) { value = n.snap(n.min + f * (n.max - n.min)); paint(); emit(); }
        return { base: value, x: d.e.clientX, fine: d.shift };
      },
      move(d) {
        const s = d.state, gm = geometry();
        if (d.shift !== s.fine) { s.base = value; s.x = d.e.clientX; s.fine = d.shift; }
        fine = s.fine;
        const v = n.snap(s.base + ((d.e.clientX - s.x) / gm.width) * (n.max - n.min) * (s.fine ? 0.1 : 1), s.fine);
        if (v !== value) { value = v; paint(); emit(); }
        fine = false;
      },
      end(d, cancelled) { if (!cancelled) commit(); },
    });
    return { get: () => value, set, el: input };
  };
  /* Kit.knob(el, { min, max, step, value, def, format, onInput, onCommit, pixels: 160, wheel, label }): the element is a .knob (add .bi for one that grows from the middle).
   * Drag up and down (the whole range takes `pixels`; Shift = a tenth of the pace), arrows, wheel, double-click = def. */
  Kit.knob = function knob(host, o) {
    o = o || {};
    const n = numeric({ min: o.min != null ? o.min : 0, max: o.max != null ? o.max : 1, step: o.step != null ? o.step : 0, fine: o.fine });
    const fmt = o.format || ((v) => String(v)), start = o.value != null ? o.value : n.min, def = o.def != null ? o.def : start;
    let value = n.snap(start), fine = false, commitTimer = 0;
    host.classList.add('knob'); host.setAttribute('role', 'slider'); host.setAttribute('aria-orientation', 'vertical'); if (!host.hasAttribute('tabindex')) host.tabIndex = 0;
    host.setAttribute('aria-valuemin', n.min); host.setAttribute('aria-valuemax', n.max);
    const paint = () => { host.style.setProperty('--v', n.frac(value).toFixed(4)); host.setAttribute('aria-valuenow', value); host.setAttribute('aria-valuetext', fmt(value)); const lab = labelOf(host, o); if (lab) host.setAttribute('aria-label', lab); };
    const emit = () => { if (isFn(o.onInput)) o.onInput(value, { fine }); };
    const commit = () => { clearTimeout(commitTimer); if (isFn(o.onCommit)) o.onCommit(value); };
    const soon = () => { clearTimeout(commitTimer); commitTimer = setTimeout(commit, 250); };
    const set = (v, silent, fm) => { v = n.snap(v, fm); if (v === value && !silent) return; value = v; paint(); if (!silent) emit(); };
    paint();
    host.addEventListener('keydown', (e) => {
      const big = n.unit * 10, f = e.shiftKey;
      const d = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[e.key];
      if (d) { e.preventDefault(); fine = f; set(value + d * (f ? n.fine : n.unit), false, f); fine = false; soon(); }
      else if (e.key === 'PageUp' || e.key === 'PageDown') { e.preventDefault(); set(value + (e.key === 'PageUp' ? big : -big)); soon(); }
      else if (e.key === 'Home' || e.key === 'End') { e.preventDefault(); set(e.key === 'Home' ? n.min : n.max); soon(); }
    });
    host.addEventListener('dblclick', () => { set(def); commit(); });
    wheelSteps(host, o.wheel, (dir, shift) => { fine = shift; set(value + dir * (shift ? n.fine : n.unit), false, shift); fine = false; soon(); });
    Kit.drag(host, {
      cursor: 'ns',
      start(d) { host.focus({ preventScroll: true }); return { base: value, y: d.e.clientY, fine: d.shift }; },
      move(d) {
        const s = d.state;
        if (d.shift !== s.fine) { s.base = value; s.y = d.e.clientY; s.fine = d.shift; }
        const v = n.snap(s.base - (d.e.clientY - s.y) * ((n.max - n.min) / (o.pixels || 160)) * (s.fine ? 0.1 : 1), s.fine);
        if (v !== value) { fine = s.fine; value = v; paint(); emit(); fine = false; }
      },
      end(d, cancelled) { if (!cancelled) commit(); },
    });
    return { get: () => value, set, el: host };
  };
  /* Kit.number(input, { min, max, step, value, def, format, parse, onInput, onCommit, scrub, wheel }): a field you type in, or drag sideways to scrub (a click
   * without moving focuses it), with Up and Down (Shift = fine, PageUp and PageDown = ten steps) and the wheel while it has focus. Enter or leaving commits, Esc reverts. */
  Kit.number = function number(input, o) {
    o = o || {};
    const n = numeric({ min: o.min != null ? o.min : -Infinity, max: o.max != null ? o.max : Infinity, step: o.step != null ? o.step : 1, fine: o.fine });
    const fmt = o.format || ((v) => String(v)), parse = o.parse || ((s) => { const m = /-?\d+(?:\.\d+)?/.exec(String(s)); return m ? parseFloat(m[0]) : NaN; });
    const start = o.value != null ? o.value : parse(input.value);
    input.type = 'text'; input.classList.add('field', 'num', 'scrub'); input.setAttribute('inputmode', 'decimal'); input.setAttribute('role', 'spinbutton'); input.setAttribute('autocomplete', 'off'); input.spellcheck = false;
    let value = n.snap(Number.isFinite(start) ? start : Number.isFinite(n.min) ? n.min : 0);
    const def = o.def != null ? o.def : value;
    const paint = () => { input.value = fmt(value); input.setAttribute('aria-valuenow', value); if (Number.isFinite(n.min)) input.setAttribute('aria-valuemin', n.min); if (Number.isFinite(n.max)) input.setAttribute('aria-valuemax', n.max); const lab = labelOf(input, o); if (lab) input.setAttribute('aria-label', lab); };
    const emit = (fine) => { if (isFn(o.onInput)) o.onInput(value, { fine: !!fine }); };
    const commit = () => { if (isFn(o.onCommit)) o.onCommit(value); };
    const set = (v, silent, fine) => { v = n.snap(v, fine); input.classList.remove('invalid'); if (v === value) { paint(); return; } value = v; paint(); if (!silent) emit(fine); };
    let commitTimer = 0;
    const soon = () => { clearTimeout(commitTimer); commitTimer = setTimeout(commit, 250); };
    const typed = () => { const p = parse(input.value); if (Number.isFinite(p)) { const changed = n.snap(p, true) !== value; set(p, false, true); if (changed) commit(); } else { paint(); } };       /* what is typed is kept to the fine step */
    paint();
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); typed(); input.select(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); paint(); input.blur(); }
      else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); typed(); set(value + (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? n.fine : n.step || n.unit), false, e.shiftKey); soon(); input.select(); }
      else if (e.key === 'PageUp' || e.key === 'PageDown') { e.preventDefault(); typed(); set(value + (e.key === 'PageUp' ? 10 : -10) * (n.step || n.unit)); soon(); input.select(); }
    });
    input.addEventListener('input', () => { const p = parse(input.value); input.classList.toggle('invalid', input.value.trim() !== '' && !Number.isFinite(p)); });
    input.addEventListener('blur', () => { typed(); input.classList.remove('invalid'); });
    input.addEventListener('focus', () => setTimeout(() => { if (document.activeElement === input) input.select(); }, 0));
    wheelSteps(input, o.wheel, (dir, shift) => { set(value + dir * (shift ? n.fine : n.step || n.unit), false, shift); soon(); });
    Kit.drag(input, {
      threshold: 3,
      filter: () => document.activeElement !== input,
      start(d) { return { base: value, x: d.e.clientX, fine: d.shift }; },
      move(d) {
        const s = d.state;
        if (d.shift !== s.fine) { s.base = value; s.x = d.e.clientX; s.fine = d.shift; }
        document.body.setAttribute('data-cursor', 'ew');
        set(s.base + (d.e.clientX - s.x) * (o.scrub != null ? o.scrub : (n.step || n.unit) / 4) * (s.fine ? 0.1 : 1), false, s.fine);
      },
      end(d, cancelled) {
        document.body.removeAttribute('data-cursor');
        if (cancelled) { set(d.state.base, true); return; }
        if (!d.moved) { input.focus(); input.select(); } else commit();
      },
    });
    return { get: () => value, set, reset: () => { set(def); commit(); }, el: input };
  };

  /* ===================================================================== segmented, toggle, select, tabs == */
  const asOption = (x) => (x && typeof x === 'object' ? x : { value: x, label: String(x) });
  /* Kit.seg(el, options, onPick, { value }) -> { get, set(value, silent), setOptions }: options 'a' or { value, label, icon, tip: 'Name|Sentence', keys }; one is on. With
   * options null, the buttons already in the element are used (data-value or their position). Left and Right move. */
  Kit.seg = function seg(host, options, onPick, o) {
    o = o || {};
    host.classList.add('seg'); host.setAttribute('role', 'radiogroup');
    let opts = [], value = null, buttons = [];
    const paint = () => buttons.forEach((b, i) => { const on = opts[i].value === value; b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); b.tabIndex = on || (value == null && i === 0) ? 0 : -1; });
    const pick = (v, silent) => { if (v === value) return; value = v; paint(); if (!silent && isFn(onPick)) onPick(v, opts.find((x) => x.value === v)); };
    function build(list) {
      host.replaceChildren(); opts = list.map(asOption);
      buttons = opts.map((op) => {
        const b = el('button', { type: 'button', role: 'radio', 'data-tip': op.tip, 'data-keys': op.keys, 'aria-label': op.label && !op.icon ? null : op.title || op.label }, op.icon ? icon(op.icon) : null, op.icon && !op.showLabel ? null : op.label);
        b.addEventListener('click', () => pick(op.value));
        host.append(b); return b;
      });
    }
    function adopt() {
      buttons = Array.from(host.querySelectorAll(':scope > button'));
      opts = buttons.map((b, i) => ({ value: b.dataset.value != null ? b.dataset.value : i, label: b.textContent.trim() }));
      buttons.forEach((b, i) => { b.setAttribute('role', 'radio'); b.addEventListener('click', () => pick(opts[i].value)); if (b.classList.contains('on')) value = opts[i].value; });
    }
    if (options) build(options); else adopt();
    if (o.value !== undefined) value = o.value;
    paint();
    host.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      const i = Math.max(0, opts.findIndex((x) => x.value === value)), j = (i + (e.key === 'ArrowRight' ? 1 : -1) + opts.length) % opts.length;
      pick(opts[j].value); buttons[j].focus();
    });
    return { get: () => value, set: pick, setOptions: (list, v) => { build(list); value = v === undefined ? value : v; paint(); }, el: host };
  };
  /* Kit.toggle(el, { value, onChange }) -> { get, set(v, silent) }: a .switch (role switch), or any button that shows .on (role button, aria-pressed). Space and Enter work. */
  Kit.toggle = function toggle(host, o) {
    o = o || {};
    const sw = host.classList.contains('switch');
    let on = o.value != null ? !!o.value : host.classList.contains('on');
    host.setAttribute('role', sw ? 'switch' : 'button');
    if (!/^(BUTTON|INPUT)$/.test(host.tagName) && !host.hasAttribute('tabindex')) host.tabIndex = 0;
    const lab = labelOf(host, o); if (lab) host.setAttribute('aria-label', lab);
    const paint = () => { host.classList.toggle('on', on); host.setAttribute(sw ? 'aria-checked' : 'aria-pressed', String(on)); };
    const set = (v, silent) => { v = !!v; if (v === on) return; on = v; paint(); if (!silent && isFn(o.onChange)) o.onChange(on); };
    paint();
    host.addEventListener('click', () => set(!on));
    host.addEventListener('keydown', (e) => { if ((e.key === ' ' || e.key === 'Enter') && !/^(BUTTON|INPUT)$/.test(host.tagName)) { e.preventDefault(); set(!on); } });
    const wrap = host.closest('label');                   /* the words of a labelled switch work too */
    if (wrap) wrap.addEventListener('click', (e) => { if (!host.contains(e.target) && !e.target.closest('input,button,select,.slider,.knob')) { e.preventDefault(); set(!on); } });
    return { get: () => on, set, el: host };
  };
  /* Kit.select(host, options, { value, onPick, minWidth }) -> { get, set(value, silent), setOptions, el }: a drop-down that opens a Kit.menu (so it looks like the rest).
   * host may be a <select>, which is replaced by a button with the same classes and its options. Space, Enter, Up and Down open it. */
  Kit.select = function select(host, options, o) {
    o = o || {};
    let list = options;
    if (host.tagName === 'SELECT') {
      list = list || Array.from(host.options).map((op) => ({ value: op.value, label: op.textContent }));
      const btn = el('button', { type: 'button', id: host.id || null, class: host.className, 'data-tip': host.getAttribute('data-tip'), 'aria-label': host.getAttribute('aria-label') });
      if (host.style.cssText) btn.style.cssText = host.style.cssText;
      if (o.value === undefined && host.selectedIndex >= 0) o = Object.assign({}, o, { value: host.options[host.selectedIndex].value });
      host.replaceWith(btn); host = btn;
    }
    host.classList.add('field', 'select'); host.setAttribute('aria-haspopup', 'listbox'); host.setAttribute('aria-expanded', 'false');
    let opts = (list || []).map(asOption), value = o.value !== undefined ? o.value : opts[0] ? opts[0].value : null;
    const label = el('span'); host.replaceChildren(label, icon('down'));
    const paint = () => { const op = opts.find((x) => x.value === value); label.textContent = op ? op.label : (o.placeholder || ''); };
    const pick = (v, silent) => { if (v === value) return; value = v; paint(); if (!silent && isFn(o.onPick)) o.onPick(v, opts.find((x) => x.value === v)); };
    const open = () => Kit.menu(host, opts.map((op) => ({ label: op.label, checked: op.value === value, icon: op.icon, disabled: op.disabled, value: op.value, run: () => pick(op.value) })), { minWidth: 'anchor' });
    host.addEventListener('click', open);
    host.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); lastInput = 'key'; open(); } });
    paint();
    return { get: () => value, set: pick, setOptions(l, v) { opts = l.map(asOption); if (v !== undefined) value = v; paint(); }, el: host };
  };
  /* Kit.tabs(el, { value, onPick, key, panels: { value: element } }) -> { get, set(value, silent) }: the buttons of a .tabs strip (data-tab or their text); key remembers the last tab */
  Kit.tabs = function tabs(host, o) {
    o = o || {};
    const buttons = Array.from(host.querySelectorAll(':scope > button')), vals = buttons.map((b) => (b.dataset.tab != null ? b.dataset.tab : b.textContent.trim()));
    host.setAttribute('role', 'tablist');
    let value = o.key ? Kit.pref('tabs.' + o.key, null) : null;
    if (value == null || !vals.includes(value)) value = o.value != null ? o.value : (buttons.find((b) => b.classList.contains('on')) ? vals[buttons.findIndex((b) => b.classList.contains('on'))] : vals[0]);
    const paint = () => {
      buttons.forEach((b, i) => { const on = vals[i] === value; b.classList.toggle('on', on); b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1; });
      if (o.panels) for (const [k, p] of Object.entries(o.panels)) p.hidden = k !== String(value);
    };
    const set = (v, silent) => { if (v === value) return; value = v; paint(); if (o.key) Kit.pref.set('tabs.' + o.key, v); if (!silent && isFn(o.onPick)) o.onPick(v); };
    buttons.forEach((b, i) => b.addEventListener('click', () => set(vals[i])));
    host.addEventListener('keydown', (e) => {
      if (!/^(ArrowLeft|ArrowRight|Home|End)$/.test(e.key)) return;
      e.preventDefault();
      const i = vals.indexOf(value), j = e.key === 'Home' ? 0 : e.key === 'End' ? vals.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + vals.length) % vals.length;
      set(vals[j]); buttons[j].focus();
    });
    paint();
    return { get: () => value, set, el: host };           /* a remembered tab (key) is not announced through onPick: read get() after creating */
  };

  /* ======================================================================================== split panes == */
  /* Kit.split(splitter, { var, host, target, measure, after, invert, min, max, key }) -> { get, set(px), reset }: drag a .splitter (.v: a vertical bar, sizes a width; .h: sizes a height).
   * Either set a CSS variable ({ var: '--roll-h', host: gridElement }, for grid layouts: use var(--roll-h, 47%) there) or size the target element directly (default: the previous
   * sibling; after: true sizes the next one, which then grows as the bar moves away). min and max are pixels or functions. key remembers the size. Double-click resets;
   * arrows move it by 16 px (Shift 64); Home and End go to the limits. */
  Kit.split = function split(bar, o) {
    o = o || {};
    const vert = bar.classList.contains('v') || o.dir === 'v', prop = vert ? 'width' : 'height';
    const target = o.target || (o.after ? bar.nextElementSibling : bar.previousElementSibling), host = o.host || bar.parentElement, measure = o.measure || target;
    const grows = (o.after ? -1 : 1) * (o.invert ? -1 : 1);
    const lim = (v, d) => (isFn(v) ? v() : v == null ? d : v);
    const size = () => measure.getBoundingClientRect()[prop];
    const apply = (px) => {
      px = clamp(Math.round(px), lim(o.min, 40), lim(o.max, 1e5));
      if (o.var) host.style.setProperty(o.var, px + 'px'); else { target.style[prop] = px + 'px'; target.style.flex = 'none'; }
      bar.setAttribute('aria-valuenow', px);
      return px;
    };
    bar.setAttribute('role', 'separator'); bar.setAttribute('aria-orientation', vert ? 'vertical' : 'horizontal'); bar.tabIndex = 0;
    const reset = () => { if (o.var) host.style.removeProperty(o.var); else { target.style[prop] = ''; target.style.flex = ''; } if (o.key) Kit.pref.del('split.' + o.key); };
    const set = (px, remember) => { const v = apply(px); if (o.key && remember !== false) Kit.pref.set('split.' + o.key, v); return v; };
    if (o.key) { const saved = Kit.pref('split.' + o.key, null); if (saved != null) apply(saved); }
    Kit.drag(bar, {
      cursor: vert ? 'col' : 'row',
      start() { bar.classList.add('drag'); return { size: size() }; },
      move(d) { set(d.state.size + grows * (vert ? d.dx : d.dy), true); },
      end(d, cancelled) { bar.classList.remove('drag'); if (cancelled) set(d.state.size); },
    });
    bar.addEventListener('dblclick', reset);
    bar.addEventListener('keydown', (e) => {
      const inc = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
      if (inc !== undefined && (vert ? /Left|Right/ : /Up|Down/).test(e.key)) { e.preventDefault(); set(size() + grows * inc * (e.shiftKey ? 64 : 16)); }
      else if (e.key === 'Home' || e.key === 'End') { e.preventDefault(); set(e.key === 'Home' ? lim(o.min, 40) : lim(o.max, size())); }
    });
    if (DOM) window.addEventListener('resize', () => { if (o.var ? host.style.getPropertyValue(o.var) : target.style[prop]) apply(size()); });
    return { get: size, set: (px) => set(px), reset, el: bar };
  };

  /* ================================================================================================ canvas == */
  /* Kit.canvas(canvas, draw(ctx, w, h, ctl), { overlay(ctx, w, h, ctl) }) -> { ctx, w, h, dpr, invalidate(), invalidateOverlay(), snap(v), destroy(), overlay }
   * Sizes the bitmap to the device pixels, scales the context so you draw in CSS pixels, redraws on resize, zoom and invalidate() (coalesced to one frame).
   * The optional overlay is a second, click-through canvas on top, for things that move every frame (the playhead): invalidateOverlay() redraws only that one.
   * The canvas must fill its (positioned) parent. Read colours with Kit.css('--token'); draw lines on snap(x) so they land on whole device pixels. */
  Kit.canvas = function canvas(cv, draw, o) {
    o = o || {};
    const ctl = { el: cv, ctx: cv.getContext('2d'), w: 0, h: 0, dpr: 1, overlay: null, invalidate, invalidateOverlay, snap, destroy };
    let queued = false, queuedOverlay = false, ov = null, ovCtx = null, dead = false;
    if (isFn(o.overlay)) {
      if (cv.parentElement && getComputedStyle(cv.parentElement).position === 'static') cv.parentElement.style.position = 'relative';
      ov = el('canvas', { class: cv.className, 'aria-hidden': 'true', style: { position: 'absolute', inset: '0', width: '100%', height: '100%', pointerEvents: 'none' } });
      cv.after(ov); ovCtx = ov.getContext('2d'); ctl.overlay = ov;
    }
    function fit(c, ctx) {
      const w = c.clientWidth, h = c.clientHeight, dpr = window.devicePixelRatio || 1, pw = Math.max(0, Math.round(w * dpr)), ph = Math.max(0, Math.round(h * dpr));
      if (c.width !== pw || c.height !== ph) { c.width = pw; c.height = ph; }
      ctl.w = w; ctl.h = h; ctl.dpr = dpr;
      if (w && h) { ctx.setTransform(pw / w, 0, 0, ph / h, 0, 0); ctx.clearRect(0, 0, w, h); }
      return !!(w && h);
    }
    function snap(v) { return Math.round(v * ctl.dpr) / ctl.dpr; }
    function paintOverlay() { queuedOverlay = false; if (dead || !ov) return; if (fit(ov, ovCtx)) o.overlay(ovCtx, ctl.w, ctl.h, ctl); }
    function paint() { queued = false; if (dead) return; Kit.css.flush(); if (fit(cv, ctl.ctx)) draw(ctl.ctx, ctl.w, ctl.h, ctl); paintOverlay(); }
    function invalidate() { if (!queued && !dead) { queued = true; nextFrame(paint); } }
    function invalidateOverlay() { if (!queuedOverlay && !queued && !dead) { queuedOverlay = true; nextFrame(paintOverlay); } }
    let ro = null;
    if (typeof ResizeObserver !== 'undefined') { ro = new ResizeObserver(invalidate); ro.observe(cv); }
    window.addEventListener('resize', invalidate);
    function destroy() { dead = true; if (ro) ro.disconnect(); window.removeEventListener('resize', invalidate); if (ov) ov.remove(); }
    paint();
    return ctl;
  };

  /* =========================================================================================== storage == */
  const DB_NAME = 'cps3studio', STORE_NAMES = ['kv', 'projects', 'versions', 'pack', 'cache'];
  const mem = new Map();                              /* name -> Map: the fallback when IndexedDB is missing or refuses */
  const clone = (v) => (typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v)));
  let dbReady = null, dbMode = 'pending';
  const hasIdb = () => { try { return typeof indexedDB !== 'undefined' && !!indexedDB && isFn(indexedDB.open); } catch (e) { return false; } };
  function wire(db) { db.onversionchange = () => { db.close(); if (dbReady) dbReady = null; }; return db; }
  /* open the database (at a version, or the current one) and give the connection to done(db), or null if the browser refuses. "Blocked" is not a refusal: another
   * connection (this page's own, finishing a transaction, or another tab on an older version) has not closed yet and the open goes on when it does. */
  function openAt(version, upgrade, done) {
    let req, timer = 0;
    try { req = version ? indexedDB.open(DB_NAME, version) : indexedDB.open(DB_NAME); } catch (e) { dbMode = 'memory'; done(null); return; }
    req.onupgradeneeded = () => upgrade(req.result);
    req.onsuccess = () => { clearTimeout(timer); dbMode = 'indexeddb'; done(wire(req.result)); };
    req.onerror = () => { clearTimeout(timer); dbMode = 'memory'; done(null); };
    req.onblocked = () => { timer = setTimeout(() => { dbMode = 'memory'; done(null); }, 5000); };
  }
  function openDb() {
    if (!hasIdb()) { dbMode = 'memory'; return Promise.resolve(null); }
    if (!dbReady) dbReady = new Promise((resolve) => openAt(0, (db) => { for (const s of STORE_NAMES) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s); }, resolve));
    return dbReady;
  }
  /* a store name nobody planned for: reopen the database one version higher with the new store added. One at a time: two new names asked for together
   * would both reopen at the same version, and the second would find a database without its store. */
  let storeQueue = Promise.resolve();
  function withStore(name) {
    const job = storeQueue.then(() => openDb()).then((db) => {
      if (!db || db.objectStoreNames.contains(name)) return db;
      dbReady = new Promise((resolve) => { const v = db.version + 1; db.close(); openAt(v, (d) => { if (!d.objectStoreNames.contains(name)) d.createObjectStore(name); }, resolve); });
      return dbReady;
    });
    storeQueue = job.catch(() => null);
    return job;
  }
  const stores = new Map();
  /* Kit.store(name) -> { get(key), set(key, value), del(key), keys(), clear() }, all promises; values are copied, so bytes (Uint8Array), objects and arrays go in and
   * come out as the same kind. IndexedDB database cps3studio; Kit.store.kv, .projects, .versions, .pack and .cache are the planned stores. Without IndexedDB
   * (a private window, a refused file page) the same calls work in memory for this visit; Kit.store.mode says which: 'indexeddb', 'memory' or 'pending'. */
  Kit.store = function store(name) {
    if (stores.has(name)) return stores.get(name);
    const map = () => { if (!mem.has(name)) mem.set(name, new Map()); return mem.get(name); };
    /* a later store being added closes this connection; if that happened between getting it and using it, ask again (once) */
    const run = (mode, fn, fallback, tries) => withStore(name).then((db) => {
      if (!db) return fallback(map());
      return new Promise((resolve, reject) => {
        let tx;
        try { tx = db.transaction(name, mode); } catch (e) { if ((tries || 0) < 3 && e && e.name === 'InvalidStateError') resolve(run(mode, fn, fallback, (tries || 0) + 1)); else reject(e); return; }
        const os = tx.objectStore(name);
        let out; const r = fn(os);
        if (r) r.onsuccess = () => { out = r.result; };
        tx.oncomplete = () => resolve(out); tx.onerror = tx.onabort = () => reject(tx.error);
      });
    });
    const s = {
      get: (key) => run('readonly', (os) => os.get(key), (m) => (m.has(key) ? clone(m.get(key)) : undefined)),
      set: (key, value) => run('readwrite', (os) => os.put(value, key), (m) => { m.set(key, clone(value)); }).then(() => value),
      del: (key) => run('readwrite', (os) => os.delete(key), (m) => { m.delete(key); }).then(() => undefined),
      keys: () => run('readonly', (os) => os.getAllKeys(), (m) => Array.from(m.keys())),
      clear: () => run('readwrite', (os) => os.clear(), (m) => { m.clear(); }).then(() => undefined),
    };
    stores.set(name, s);
    return s;
  };
  for (const s of STORE_NAMES) Object.defineProperty(Kit.store, s, { get: () => Kit.store(s), enumerable: true });
  /* Kit.store.names() -> every store this browser holds for the Studio (planned and later ones), for a hand-over of saved work. */
  Kit.store.names = () => openDb().then((db) => (db ? Array.from(db.objectStoreNames) : Array.from(mem.keys())));
  Object.defineProperty(Kit.store, 'mode', { get: () => (hasIdb() ? dbMode : 'memory') });
  const PREF = 'cps3studio.', prefMem = new Map();
  const ls = () => { try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch (e) { return null; } };
  /* Kit.pref(key, default): a small per-viewer setting (a remembered tab, a panel size) kept in localStorage, in memory where that is refused. Kit.pref.set(key, value), .del(key). */
  Kit.pref = function pref(key, def) {
    let raw = prefMem.has(key) ? prefMem.get(key) : null;
    if (raw == null) { const s = ls(); if (s) { try { raw = s.getItem(PREF + key); } catch (e) { raw = null; } } }
    if (raw == null) return def;
    try { return JSON.parse(raw); } catch (e) { return def; }
  };
  Kit.pref.set = (key, value) => {
    const raw = JSON.stringify(value), s = ls();
    if (s) { try { s.setItem(PREF + key, raw); prefMem.delete(key); return value; } catch (e) { /* refused: keep it in memory */ } }
    prefMem.set(key, raw);
    return value;
  };
  Kit.pref.del = (key) => { prefMem.delete(key); const s = ls(); if (s) { try { s.removeItem(PREF + key); } catch (e) { /* nothing to remove */ } } };

  /* =========================================================================================== files == */
  /* Kit.download(name, bytes | string | Blob, type): the browser's own save. */
  Kit.download = function download(name, data, type) {
    const blob = typeof Blob !== 'undefined' && data instanceof Blob ? data : new Blob([data], { type: type || 'application/octet-stream' });
    const url = URL.createObjectURL(blob), a = el('a', { href: url, download: name, hidden: true });
    document.body.append(a); a.click();
    setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 4000);
    return blob;
  };
  /* Kit.pickFile('.mid,.json', { multiple }) -> Promise of a File (or an array), or null when cancelled */
  Kit.pickFile = function pickFile(accept, o) {
    o = o || {};
    return new Promise((resolve) => {
      const inp = el('input', { type: 'file', accept: accept || '', multiple: !!o.multiple, hidden: true });
      let done = false;
      const finish = (v) => { if (done) return; done = true; inp.remove(); resolve(v); };
      inp.addEventListener('change', () => { const f = Array.from(inp.files || []); finish(o.multiple ? f : f[0] || null); });
      inp.addEventListener('cancel', () => finish(o.multiple ? [] : null));
      document.body.append(inp); inp.click();
    });
  };
  Kit.readFile = (file) => file.arrayBuffer().then((b) => new Uint8Array(b));
  const accepts = (file, accept) => !accept || String(accept).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean).some((a) =>
    a.startsWith('.') ? file.name.toLowerCase().endsWith(a) : a.endsWith('/*') ? (file.type || '').toLowerCase().startsWith(a.slice(0, -1)) : (file.type || '').toLowerCase() === a);
  /* Kit.drop(target, { accept, onDrop(files, e), onHover(bool), onReject(files) }): files dropped on an element; it carries .dropping while one is over it */
  Kit.drop = function drop(target, o) {
    o = o || {};
    let depth = 0;
    const has = (dt) => !!dt && Array.from(dt.types || []).includes('Files');
    const off = () => { depth = 0; target.classList.remove('dropping'); if (isFn(o.onHover)) o.onHover(false); };
    const enter = (e) => { if (!has(e.dataTransfer)) return; e.preventDefault(); if (!depth++) { target.classList.add('dropping'); if (isFn(o.onHover)) o.onHover(true); } };
    const over = (e) => { if (!has(e.dataTransfer)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; };
    const leave = (e) => { if (has(e.dataTransfer) && --depth <= 0) off(); };
    const dropped = (e) => {
      if (!has(e.dataTransfer)) return;
      e.preventDefault(); off();
      const all = Array.from(e.dataTransfer.files), good = all.filter((f) => accepts(f, o.accept));
      if (good.length && isFn(o.onDrop)) o.onDrop(good, e); else if (!good.length && isFn(o.onReject)) o.onReject(all, e);
    };
    target.addEventListener('dragenter', enter); target.addEventListener('dragover', over); target.addEventListener('dragleave', leave); target.addEventListener('drop', dropped);
    return { destroy() { target.removeEventListener('dragenter', enter); target.removeEventListener('dragover', over); target.removeEventListener('dragleave', leave); target.removeEventListener('drop', dropped); off(); } };
  };
  /* Kit.pickFolder() -> a folder handle you can write into, or null (cancelled, or this browser has no File System Access API) */
  Kit.pickFolder = function pickFolder() {
    if (!DOM || !isFn(g.showDirectoryPicker)) return Promise.resolve(null);
    return g.showDirectoryPicker({ mode: 'readwrite' }).catch(() => null);
  };
  /* Kit.saveInto(folderHandle, [{ name, bytes }]) -> Promise of the names written. Plain file names only; an existing file of the same name is replaced. */
  Kit.saveInto = async function saveInto(dir, files) {
    if (!dir || !isFn(dir.getFileHandle)) throw new TypeError('Kit.saveInto needs a folder from Kit.pickFolder(); this browser may not allow it, use Kit.download instead');
    for (const f of files) if (!/^[^\\/:*?"<>|\u0000-\u001f]+$/.test(f.name) || f.name === '.' || f.name === '..') throw new TypeError(`Kit.saveInto: "${f.name}" is not a plain file name`);
    const done = [];
    for (const f of files) {
      const w = await (await dir.getFileHandle(f.name, { create: true })).createWritable();
      await w.write(f.bytes); await w.close(); done.push(f.name);
    }
    return done;
  };

  /* ================================================================================================ init == */
  Kit.init = function init() {
    if (!DOM || Kit.init.done) return;
    Kit.init.done = true;
    if (g.KitIcons && isFn(g.KitIcons.inject)) g.KitIcons.inject(document);
    document.addEventListener('pointerover', onOver, true);
    document.addEventListener('pointerout', onOut, true);
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyLayer, true);
    document.addEventListener('keydown', onKey);
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('scroll', hideTip, true);
    document.addEventListener('wheel', hideTip, { passive: true, capture: true });
    window.addEventListener('blur', () => { hideTip(); closeMenus(); });
    /* a resize keeps what was opened on purpose (a menu is placed again, a tip shown by Kit.tip.show stays); a tip that came from hovering goes */
    window.addEventListener('resize', () => { if (!T.pinned) hideTip(); for (const l of layers) if (l.reposition) l.reposition(); });
    document.documentElement.setAttribute('data-kit', '1');
    refresh();
  };
  g.Kit = Kit;
  if (typeof module !== 'undefined' && module.exports) module.exports = Kit;
  if (DOM) { if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', Kit.init); else Kit.init(); }
})(typeof window !== 'undefined' ? window : globalThis);
