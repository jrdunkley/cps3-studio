/* CPS3 colour picker (shared Studio component): a colour editor for the hand and the eye, not for numbers. A CPS3 colour is three 5-bit channels (0-31): the picker draws
 * every surface in those steps, so what the mouse shows is exactly what the game can store.
 *
 *   CPS3ColourPicker.create(host, { css(rgb) -> CSS colour of a 5-bit colour (the host's arcade conversion),
 *                                   input(rgb) while dragging (live preview, no history), commit(rgb) once on release,
 *                                   compare(on) while the Original swatch is held })
 *     -> { set(rgb, original, { enabled, note }), element, destroy() }
 *   CPS3ColourPicker.shifter(host, { preview({ hue, saturation, light }), commit(delta), cancel(), enabled() })
 *     -> { element, reset(), destroy() }: drag a track left or right to shift a whole ramp; release applies it.
 *   CPS3ColourPicker.hsv(rgb) / fromHSV(h, s, v): the colour model used here (h 0-360, s and v 0-1), in 5-bit steps.
 *
 * Surfaces: a saturation x brightness square (32 x 32 steps) beside a hue strip; R, G, B, H, S and V tracks whose
 * steps show the colour each would give; the new colour beside the original (press and hold it to compare). Every
 * track also takes the keyboard (arrows one step, Shift four), and its number can be typed, but nothing needs them. */
(function (g) {
  'use strict';
  const K = g.Kit, el = K.el;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const same = (a, b) => !!a && !!b && a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
  function hsv([r, gr, b]) {
    r /= 31; gr /= 31; b /= 31; const hi = Math.max(r, gr, b), lo = Math.min(r, gr, b), d = hi - lo;
    const h = !d ? 0 : hi === r ? ((gr - b) / d + 6) % 6 : hi === gr ? (b - r) / d + 2 : (r - gr) / d + 4;
    return [h * 60, hi ? d / hi : 0, hi];
  }
  function fromHSV(h, s, v) {
    h = ((h % 360) + 360) % 360 / 60; s = clamp(s, 0, 1); v = clamp(v, 0, 1);
    const c = v * s, x = c * (1 - Math.abs(h % 2 - 1)), m = v - c, i = Math.floor(h) % 6;
    return [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][i].map(n => clamp(Math.round((n + m) * 31), 0, 31));
  }
  const defaultCss = c => '#' + c.map(v => ((v << 3) | (v >> 2)).toString(16).padStart(2, '0')).join('');
  /* marker strokes and labels use the kit's own tokens: a dark outline (--bg-0) under a light line (--ink) reads on any colour */
  const tone = () => ({ dark: K.css('--bg-0'), light: K.css('--ink') });
  /* A canvas sized to its box at the screen's pixel density; draw(ctx, w, h) in CSS pixels. */
  /* Sizes come from a ResizeObserver, never from a layout read in paint: after a host rebuilds its DOM a read would force
     a full layout on every frame of a drag. */
  function surface(cls, attrs, draw) {
    const cv = el('canvas.' + cls, attrs), box = { w: 0, h: 0 };
    new ResizeObserver(e => { const r = e[0].contentRect; box.w = r.width; box.h = r.height; if (cv.isConnected) paint(); }).observe(cv);
    const paint = () => { if (!box.w || !box.h) return; const d = g.devicePixelRatio || 1, w = Math.max(1, Math.round(box.w)), h = Math.max(1, Math.round(box.h));
      if (cv.width !== Math.round(w * d) || cv.height !== Math.round(h * d)) { cv.width = Math.round(w * d); cv.height = Math.round(h * d); }
      const ctx = cv.getContext('2d'); ctx.setTransform(d, 0, 0, d, 0, 0); ctx.clearRect(0, 0, w, h); draw(ctx, w, h); };
    return { cv, paint };
  }
  function ring(ctx, x, y, r) { const t = tone(); ctx.lineWidth = 3; ctx.strokeStyle = t.dark; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke(); ctx.lineWidth = 1.5; ctx.strokeStyle = t.light; ctx.stroke(); }
  function bar(ctx, x, y, w, h) { const t = tone(); ctx.lineWidth = 3; ctx.strokeStyle = t.dark; ctx.strokeRect(x, y, w, h); ctx.lineWidth = 1.5; ctx.strokeStyle = t.light; ctx.strokeRect(x, y, w, h); }
  /* Pointer drags with capture; fn(x, y, rect, phase) with phase 'start' | 'move' | 'end' | 'cancel'. */
  function drag(node, fn) {
    let id = null;
    node.addEventListener('pointerdown', e => { if (e.button !== 0) return; id = e.pointerId; try { node.setPointerCapture(id); } catch (_) {} e.preventDefault(); node.focus({ preventScroll: true }); fn(e.clientX, e.clientY, node.getBoundingClientRect(), 'start', e); });
    node.addEventListener('pointermove', e => { if (e.pointerId === id) fn(e.clientX, e.clientY, node.getBoundingClientRect(), 'move', e); });
    const end = (e, phase) => { if (e.pointerId !== id) return; id = null; fn(e.clientX, e.clientY, node.getBoundingClientRect(), phase, e); };
    node.addEventListener('pointerup', e => end(e, 'end')); node.addEventListener('pointercancel', e => end(e, 'cancel'));
    node.addEventListener('lostpointercapture', e => { if (id !== null && e.pointerId === id) end(e, 'end'); });
  }

  function create(host, o = {}) {
    const css = o.css || defaultCss; if (css.key === undefined) css.key = '';   /* css.key: the host changes it when its colour conversion changes */
    let rgb = [0, 0, 0], original = [0, 0, 0], h = 0, s = 0, v = 0, enabled = false, start = null, live = false;
    const setFrom = (c, keepHue) => { const [hh, ss, vv] = hsv(c); if (!(keepHue && (ss === 0 || vv === 0))) h = hh; if (!(keepHue && vv === 0)) s = ss; v = vv; };
    function change(next, phase) {
      if (!enabled) return;
      if (phase === 'start') { start = rgb.slice(); live = false; }
      if (!same(next, rgb)) { rgb = next; live = true; if (o.input) o.input(rgb.slice()); }
      if (phase === 'end') { const moved = start && !same(start, rgb); start = null; live = false; if (moved && o.commit) o.commit(rgb.slice()); }
      if (phase === 'cancel') { const was = start; start = null; live = false; if (was && !same(was, rgb)) { rgb = was; setFrom(rgb, true); if (o.input) o.input(rgb.slice()); } }
      paintAll();
    }
    /* the saturation x brightness square, in the game's 32 x 32 steps at the current hue */
    /* Fixed parts are drawn once and kept (the square per hue, the hue strip per size, the hue track per S and V), so a
       drag repaints only what moved: a 60 fps hand needs the whole picker in well under a frame. */
    const kept = new Map();
    function cached(key, w, hh, draw) { let c = kept.get(key); if (!c) { if (kept.size > 48) kept.clear(); c = document.createElement('canvas'); const d = g.devicePixelRatio || 1; c.width = Math.max(1, Math.round(w * d)); c.height = Math.max(1, Math.round(hh * d)); const x = c.getContext('2d'); x.setTransform(d, 0, 0, d, 0, 0); draw(x, w, hh); kept.set(key, c); } return c; }
    const square = surface('cp-square', { tabindex: 0, role: 'slider', 'aria-label': 'Saturation and brightness', 'data-tip': 'Saturation and brightness|Drag to choose. Right is stronger, up is brighter; the colour snaps to the game’s 32 steps.' }, (ctx, w, hh) => {
      const hueKey = Math.round(h), img = cached('sq|' + hueKey + '|' + w + 'x' + hh + '|' + css.key, w, hh, (x, ww, h2) => {
        for (let i = 0; i < 32; i++) for (let j = 0; j < 32; j++) { x.fillStyle = css(fromHSV(h, i / 31, 1 - j / 31)); x.fillRect(Math.floor(i * ww / 32), Math.floor(j * h2 / 32), Math.ceil(ww / 32) + 1, Math.ceil(h2 / 32) + 1); } });
      ctx.drawImage(img, 0, 0, w, hh);
      if (enabled) ring(ctx, (Math.round(s * 31) + .5) * w / 32, (31 - Math.round(v * 31) + .5) * hh / 32, 6);
    });
    drag(square.cv, (x, y, r, phase) => { const si = clamp(Math.floor((x - r.left) / r.width * 32), 0, 31), vi = 31 - clamp(Math.floor((y - r.top) / r.height * 32), 0, 31); s = si / 31; v = vi / 31; change(fromHSV(h, s, v), phase); });
    /* the hue strip, top to bottom */
    const hue = surface('cp-hue', { tabindex: 0, role: 'slider', 'aria-label': 'Hue', 'data-tip': 'Hue|Drag up or down to change the colour’s hue; saturation and brightness stay.' }, (ctx, w, hh) => {
      ctx.drawImage(cached('hue|' + w + 'x' + hh + '|' + css.key, w, hh, (x, ww, h2) => { for (let y = 0; y < h2; y++) { x.fillStyle = css(fromHSV(y / h2 * 360, 1, 1)); x.fillRect(0, y, ww, 1); } }), 0, 0, w, hh);
      if (enabled) { const y = h / 360 * hh; bar(ctx, 1.5, y - 3, w - 3, 6); }
    });
    drag(hue.cv, (x, y, r, phase) => { h = clamp((y - r.top) / r.height, 0, .9999) * 360; change(fromHSV(h, s || (v ? 1 : 0), v || 1), phase); if (s === 0 || v === 0) setFrom(rgb, true); });
    /* new beside original: press and hold the original to see it in the picture */
    const now = el('div.cp-now'), was = el('button.cp-was', { type: 'button', 'data-tip': 'Original|Press and hold to see the original colours in the picture.' }, el('span', null, 'Original'));
    let comparing = false;
    const compare = on => { if (comparing === on) return; comparing = on; was.classList.toggle('on', on); if (o.compare) o.compare(on); };
    was.addEventListener('pointerdown', e => { if (e.button) return; try { was.setPointerCapture(e.pointerId); } catch (_) {} compare(true); });
    for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) was.addEventListener(ev, () => compare(false));
    const nowLabel = el('span', null, 'New'), swatch = el('div.cp-swatch', null, el('div.cp-now-wrap', { 'data-tip': 'New|The colour the selected pens have now.' }, now, nowLabel), was);
    /* tracks: R G B H S V, each drawn as the colours its steps would give */
    const TRACKS = [
      ['R', 'Red', 32, () => rgb[0], k => [k, rgb[1], rgb[2]]], ['G', 'Green', 32, () => rgb[1], k => [rgb[0], k, rgb[2]]], ['B', 'Blue', 32, () => rgb[2], k => [rgb[0], rgb[1], k]],
      ['H', 'Hue', 360, () => Math.round(h), k => fromHSV(k, s, v)], ['S', 'Saturation', 32, () => Math.round(s * 31), k => fromHSV(h, k / 31, v)], ['V', 'Brightness', 32, () => Math.round(v * 31), k => fromHSV(h, s, k / 31)]];
    const tracks = TRACKS.map(([key, name, n, get, make]) => {
      const t = surface('cp-track', { tabindex: 0, role: 'slider', 'aria-label': name, 'aria-valuemin': 0, 'aria-valuemax': n - 1, 'data-tip': name + '|Drag along the track; each step shows the colour you would get. Arrow keys move one step (Shift: four).' }, (ctx, w, hh) => {
        if (n === 360) ctx.drawImage(cached('ht|' + Math.round(s * 31) + '|' + Math.round(v * 31) + '|' + w + 'x' + hh + '|' + css.key, w, hh, (x, ww, h2) => { const steps = Math.max(2, Math.round(ww)); for (let k = 0; k < steps; k++) { x.fillStyle = css(make(k / steps * 360)); x.fillRect(Math.floor(k * ww / steps), 0, Math.ceil(ww / steps) + 1, h2); } }), 0, 0, w, hh);
        else for (let k = 0; k < n; k++) { ctx.fillStyle = css(make(k)); ctx.fillRect(Math.floor(k * w / n), 0, Math.ceil(w / n) + 1, hh); }
        if (!enabled) return; const at = n === 360 ? h / 360 * w : (get() + .5) * w / n, half = n === 360 ? 3 : Math.max(3, w / n / 2);
        bar(ctx, at - half, 1.5, half * 2, hh - 3);
      });
      const value = el('input.cp-value.num', { 'aria-label': name + ' value', 'data-tip': name + '|Type a value: ' + (n === 360 ? '0–359 degrees.' : '0–31, the game’s steps.'), inputmode: 'numeric' });
      const set = (k, phase) => { k = clamp(Math.round(k), 0, n - 1); if (key === 'H') h = k; if (key === 'S') s = k / 31; if (key === 'V') v = k / 31; const next = make(k); if (key === 'R' || key === 'G' || key === 'B') setFrom(next, true); change(next, phase); };
      drag(t.cv, (x, y, r, phase) => set((x - r.left) / r.width * n - (n === 360 ? 0 : .5), phase));
      t.cv.addEventListener('keydown', e => { const d = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 }[e.key]; if (!d || !enabled) return; e.preventDefault(); const step = (e.shiftKey ? 4 : 1) * (n === 360 ? 5 : 1); set(get() + d * step, 'start'); set(get(), 'end'); });
      value.addEventListener('change', () => { const k = Number(value.value); if (!Number.isFinite(k)) { value.value = String(get()); return; } set(k, 'start'); set(k, 'end'); });
      value.addEventListener('keydown', e => { if (e.key === 'Enter') value.blur(); });
      return { key, row: el('div.cp-row', null, el('span.cp-key', { title: name }, key), t.cv, value), t, value, get };
    });
    const note = el('p.cp-note', { 'aria-live': 'polite' });
    const element = el('div.cp', null, el('div.cp-pick', null, square.cv, hue.cv), swatch, el('div.cp-tracks', null, ...tracks.map(x => x.row)), note);
    host.append(element);
    let frame = 0;
    function paintAll() { if (frame) return; frame = requestAnimationFrame(() => { frame = 0; paintNow(); }); }
    function paintNow() {
      element.classList.toggle('off', !enabled);
      square.paint(); hue.paint(); for (const t of tracks) { t.t.paint(); if (document.activeElement !== t.value) t.value.value = enabled ? String(t.get()) : ''; t.t.cv.setAttribute('aria-valuenow', String(t.get())); t.value.disabled = !enabled; }
      now.style.background = enabled ? css(rgb) : 'transparent'; was.style.background = enabled ? css(original) : 'transparent';
      const light = c => (c[0] * .3 + c[1] * .59 + c[2] * .11) > 15, t = tone(); nowLabel.style.color = enabled && light(rgb) ? t.dark : t.light; nowLabel.style.textShadow = enabled && light(rgb) ? 'none' : '';
      was.style.color = enabled && light(original) ? t.dark : t.light;
    }
    const resize = new ResizeObserver(() => paintAll()); resize.observe(element);
    return {
      element,
      get dragging() { return start !== null; },
      /* the selection's colour and its original; enabled false shows the picker resting, with a note saying why */
      set(next, orig, opts = {}) { if (start !== null) return; enabled = opts.enabled !== false && !!next; if (next) { const keep = rgb && same(next, rgb); rgb = next.slice(); setFrom(rgb, keep); } if (orig) original = orig.slice(); note.textContent = opts.note || ''; note.hidden = !opts.note; paintAll(); },
      destroy() { resize.disconnect(); cancelAnimationFrame(frame); element.remove(); }
    };
  }

  /* Ramp shifter: three tracks with their centre at "no change". Drag one: the whole selection follows live; release
     applies it as one step and the track springs back to the centre. Esc while dragging cancels. */
  function shifter(host, o = {}) {
    const SPECS = [['hue', 'Hue', 180, '°', 'Turn the hue of every selected pen together, keeping each pen’s own shading.'],
      ['saturation', 'Saturation', 100, '%', 'Make the selected pens stronger (right) or greyer (left) together.'],
      ['light', 'Brightness', 100, '%', 'Make the selected pens brighter (right) or darker (left) together.']];
    let active = null;
    const rows = SPECS.map(([key, name, max, unit, tip]) => {
      const knob = el('span.cp-shift-knob'), label = el('span.cp-shift-value.num', null, '0'), track = el('div.cp-shift-track', { tabindex: 0, role: 'slider', 'aria-label': name + ' shift', 'data-tip': name + '|' + tip + ' Release to apply; Ctrl Z undoes.' }, el('span.cp-shift-mid'), knob);
      const show = d => { knob.style.left = (50 + d / max * 50) + '%'; label.textContent = (d > 0 ? '+' : '') + Math.round(d) + unit; track.classList.toggle('live', !!d); };
      let delta = 0;
      drag(track, (x, y, r, phase, e) => {
        if (phase === 'start') { if (o.enabled && !o.enabled()) return; active = key; }
        if (active !== key) return;
        delta = Math.round(clamp(((x - r.left) / r.width - .5) * 2, -1, 1) * max);
        if (phase === 'start' || phase === 'move') { show(delta); if (o.preview) o.preview({ hue: 0, saturation: 0, light: 0, [key]: delta }); }
        if (phase === 'end') { active = null; const d = delta; delta = 0; show(0); if (d && o.commit) o.commit({ hue: 0, saturation: 0, light: 0, [key]: d }); else if (o.cancel) o.cancel(); }
        if (phase === 'cancel') { active = null; delta = 0; show(0); if (o.cancel) o.cancel(); }
      });
      track.addEventListener('keydown', e => { const d = { ArrowLeft: -1, ArrowRight: 1 }[e.key]; if (!d || (o.enabled && !o.enabled())) return; e.preventDefault(); const step = (e.shiftKey ? 20 : 5) * d * (max === 180 ? 1 : 1); if (o.commit) o.commit({ hue: 0, saturation: 0, light: 0, [key]: step }); });
      show(0);
      return el('div.cp-shift', null, el('span.cp-shift-name', null, name), track, label);
    });
    const esc = e => { if (e.key === 'Escape' && active) { active = null; for (const r of rows) r.querySelector('.cp-shift-knob').style.left = '50%'; if (o.cancel) o.cancel(); } };
    document.addEventListener('keydown', esc, true);
    const element = el('div.cp-shifter', null, ...rows); host.append(element);
    return { element, get dragging() { return !!active; }, reset() { for (const r of rows) { r.querySelector('.cp-shift-knob').style.left = '50%'; r.querySelector('.cp-shift-value').textContent = '0'; } }, destroy() { document.removeEventListener('keydown', esc, true); element.remove(); } };
  }

  g.CPS3ColourPicker = { create, shifter, hsv, fromHSV };
})(typeof window !== 'undefined' ? window : globalThis);
