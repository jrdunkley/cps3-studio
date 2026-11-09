/* How hard does a sequence work the sound driver? The driver runs inside the game's VBlank handler,
 * so its time comes out of the frame. Counts SH-2 instructions per driver frame for the given
 * sequence and for every piece of the game's own music, and prints JSON.
 * usage: node driver_load.js <sequence.bin> [frames]      (no file: only the game's music)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
require(path.join(root, 'data', 'pack.js'));
const { Engine } = require(path.join(root, 'js', 'engine.js'));

function measure(setup, frames) {
  const engine = new Engine(globalThis.SF3_PACK);
  setup(engine);
  let peak = 0, total = 0;
  for (let f = 0; f < frames; f++) {
    const before = engine.cpu.steps;
    engine.step();
    const used = engine.cpu.steps - before;
    peak = Math.max(peak, used); total += used;
  }
  return { peak, mean: Math.round(total / frames) };
}

const frames = Number(process.argv[3] || 3600);
let game = { peak: 0, mean: 0, code: 0 };
for (let code = 1; code < 50; code++) {
  const m = measure((e) => e.request(code), 1800);
  if (m.peak > game.peak) game = Object.assign(m, { code });
}
const out = { game_busiest: game };
if (process.argv[2]) {
  const bytes = new Uint8Array(fs.readFileSync(process.argv[2]));
  out.song = measure((e) => { e.patchSequence(bytes, 60); e.request(60); }, frames);
  out.song_peak_vs_game = Math.round(out.song.peak / game.peak * 100) / 100;
}
console.log(JSON.stringify(out));
