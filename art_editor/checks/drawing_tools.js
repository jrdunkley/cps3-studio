/* Small ROM-free witnesses for the portable animation drawing tools. */
'use strict';
const assert = require('assert');
const Scale = require('../js/scale.js'), Stretch = require('../js/stretch.js');
const Tween = require('../js/tween.js'), Doc = require('../js/doc.js'), Ops = require('../js/ops.js');
let checks = 0;
const same = (a, b, why) => { assert.deepStrictEqual(Array.from(a), Array.from(b), why); checks++; };
const ok = (v, why) => { assert(v, why); checks++; };
same(Scale.cps3Map(3, 5), [0, 0, 1, 1, 2], 'fixed-point CPS3 nearest, grow');
same(Scale.cps3Map(5, 3), [0, 1, 3], 'fixed-point CPS3 nearest, shrink');
const p = new Uint8Array(64); p.set([11, 12], 18); p.set([13, 14], 26);
const mask = Ops.boxMask(8, 8, 2, 2, 3, 3), box = { x: 2, y: 2, w: 2, h: 2 }, edge = { ex: 1, ey: 0 };
const resized = Scale.applyScale(p, 8, 8, mask, box, 3, 2, edge, [0, 1], [0, 0, 1]);
const expected = new Uint8Array(64); expected.set([11, 11, 12], 18); expected.set([13, 13, 14], 26);
same(resized.pixels, expected, 'selection scaling preserves exact pens and footprint');
same(p.slice(18, 20), [11, 12], 'scaling leaves input untouched');
assert.throws(() => {
  const plan = Scale.plan([p], 8, 8, box, 20, 2, edge, { rows: 'cps3', outside: 'stay' });
  Scale.applyScale(p, 8, 8, mask, box, 20, 2, edge, plan.rowmap, plan.colmap);
}, /canvas/); checks++;
const band = new Uint8Array(32); for (let y = 2; y <= 5; y++) band.fill(y, y * 4, y * 4 + 4);
const stretched = Stretch.stretch(band, 4, 8, [3]), wanted = new Uint8Array(32);
for (const [y, pen] of [[1, 2], [2, 3], [3, 3], [4, 4], [5, 5]]) wanted.fill(pen, y * 4, y * 4 + 4);
same(stretched, wanted, 'row stretch raises upper rows and leaves feet fixed');
const unsafe = band.slice(); unsafe[0] = 8;
assert.throws(() => Stretch.stretch(unsafe, 4, 8, [3]), /empty|outside|canvas|top/i); checks++;
const W = 24, H = 24, prev = new Uint8Array(W * H), next = new Uint8Array(W * H);
for (let y = 6; y < 16; y++) for (let x = 6; x < 15; x++) { const pen = 1 + (x * 7 + y * 13) % 60; prev[y * W + x] = pen; next[(y + 1) * W + x + 2] = pen; }
const all = new Uint8Array(W * H).fill(1), shift = Tween.estimateShift(prev, next, all, W, H);
ok(shift.dx === 2 && shift.dy === 1, 'tracks a known two-column, one-row displacement');
const copy = prev.slice(), result = Tween.candidates(copy, W, H, all, prev, prev, { R: 2 });
ok(result.candidates.length === 4, 'four tween candidates');
for (const candidate of result.candidates) same(candidate.pixels, prev, 'stationary neighbours reproduce indexed pixels');
same(copy, prev, 'candidate calculation does not edit the current drawing');
const palette = Array.from({ length: 64 }, (_, i) => [i, i, i, i ? 255 : 0]); palette[4] = palette[3].slice();
const classes = Tween.colourClasses(palette); ok(classes[0] === 0 && classes[3] === classes[4] && classes[2] !== classes[3], 'material classes respect equal colours and transparency');
const d = Doc.create({ width: 8, height: 8, pixels: p }); Doc.addLayer(d, 'paint', 'Guide', { pixels: new Uint8Array(64).fill(63), guide: true });
same(Doc.flatten(d), p, 'guides never change exported pens');
console.log(JSON.stringify({ passed: true, checks }));
