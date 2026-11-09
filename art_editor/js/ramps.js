/* Native xBGR555 editing. Bit 15 belongs to the game and survives colour edits. */
(function (g) {
  'use strict';
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  function valid(w) { if (!Number.isInteger(w) || w < 0 || w > 65535) throw new Error('A palette word must be an integer from 0 to 65535.'); return w; }
  const channels = w => { valid(w); return [w & 31, (w >>> 5) & 31, (w >>> 10) & 31]; };
  function word(rgb, old = 0) { valid(old); if (rgb.length !== 3 || rgb.some(c => !Number.isInteger(c) || c < 0 || c > 31)) throw new Error('R G B each need a whole step from 0 to 31.'); return (old & 32768) | rgb[0] | (rgb[1] << 5) | (rgb[2] << 10); }
  const expanded = w => channels(w).map(c => (c << 3) | (c >>> 2));
  function hsv(w) {
    const [r, b, c] = channels(w).map(v => v / 31), hi = Math.max(r, b, c), lo = Math.min(r, b, c), d = hi - lo;
    const h = !d ? 0 : hi === r ? ((b - c) / d + 6) % 6 : hi === b ? (c - r) / d + 2 : (r - b) / d + 4;
    return [h * 60, hi ? d / hi : 0, hi];
  }
  function fromHSV(h, s, v, old = 0) {
    if (![h, s, v].every(Number.isFinite)) throw new Error('Hue, saturation and value must be numbers.');
    h = ((h % 360) + 360) % 360 / 60; s = clamp(s, 0, 1); v = clamp(v, 0, 1);
    const c = v * s, x = c * (1 - Math.abs(h % 2 - 1)), m = v - c;
    const rgb = [[c,x,0],[x,c,0],[0,c,x],[0,x,c],[x,0,c],[c,0,x]][Math.floor(h)];
    return word(rgb.map(n => Math.round((n + m) * 31)), old);
  }
  function toHSL(w) { const [h,s,v] = hsv(w), l = v * (1 - s / 2); return [h, l === 0 || l === 1 ? 0 : (v - l) / Math.min(l, 1 - l), l]; }
  function fromHSL(h, s, l, old) { l = clamp(l, 0, 1); s = clamp(s, 0, 1); const v = l + s * Math.min(l, 1 - l); return fromHSV(h, v ? 2 * (1 - l / v) : 0, v, old); }
  function shift(words, pens, delta = {}) {
    const out = Uint16Array.from(words); for (const p of pens) {
      if (!Number.isInteger(p) || p < 0 || p >= words.length) throw new Error('Ramp pen is outside this palette.');
      if (![delta.hue ?? 0, delta.saturation ?? 0, delta.light ?? 0].every(Number.isFinite)) throw new Error('Ramp shift must use finite numbers.');
      const [h,s,l] = toHSL(words[p]); out[p] = fromHSL(h + (delta.hue ?? 0), s + (delta.saturation ?? 0) / 100, l + (delta.light ?? 0) / 100, words[p]);
    } return out;
  }
  function gradient(words, pens) {
    if (pens.length < 2) throw new Error('Select at least two pens for a gradient.');
    const out = Uint16Array.from(words), a = channels(words[pens[0]]), b = channels(words[pens[pens.length - 1]]);
    pens.forEach((p,i) => { if (!Number.isInteger(p) || p < 0 || p >= words.length) throw new Error('Gradient pen is outside this palette.'); out[p] = word(a.map((v,k) => Math.round(v + (b[k] - v) * i / (pens.length - 1))), words[p]); }); return out;
  }
  /* Suggestions only: adjacent pens, monotone light and nearby hue. Artists may regroup them. */
  function find(words) {
    Array.from(words).forEach(valid); const result = []; let run = [], direction = 0;
    function finish() { if (run.length > 1) result.push({ name: 'Ramp ' + (result.length + 1), pens: run }); run = []; direction = 0; }
    for (let p = 1; p < words.length; p++) {
      if (!run.length) { run = [p]; continue; }
      const a = toHSL(words[run[run.length - 1]]), b = toHSL(words[p]), dh = Math.abs(a[0] - b[0]), d = Math.sign(b[2] - a[2]);
      if ((Math.min(dh, 360 - dh) <= 28 || a[1] < .12 || b[1] < .12) && Math.abs(a[2] - b[2]) < .3 && (!direction || !d || d === direction)) { run.push(p); if (d) direction = d; }
      else { finish(); run = [p]; }
    } finish(); return result;
  }
  const api = { valid, channels, word, expanded, hsv, fromHSV, toHSL, fromHSL, shift, gradient, find };
  g.ArtRamps = api; if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
