/* An original eight-bar pattern. No Capcom sequence or melody is copied here. */
(function (g) {
  'use strict';
  g.Studio.demo = function () {
    const part = (id, name, role, program, volume) => ({ id, name, role, bank: 0, program, volume, expression: 80, pan: 64, voices: 1, notes: [] });
    const drums = part('drums', 'Pocket', 'drums', 6, 80), bass = part('bass', 'Night bass', 'bass', 20, 70), lead = part('lead', 'Street lights', 'lead', 43, 48);
    for (let bar = 0; bar < 8; bar++) {
      const t = bar * 192, root = [45, 45, 48, 43][bar % 4];
      for (let beat = 0; beat < 4; beat++) { drums.notes.push({ t: t + beat * 48, n: beat % 2 ? 38 : 36, v: 106, len: 12 }); bass.notes.push({ t: t + beat * 48 + (beat % 2 ? 12 : 0), n: root, v: 96, len: 30 }); }
      [0, 36, 84, 144].forEach((dt, i) => lead.notes.push({ t: t + dt, n: root + [24, 31, 27, 22][(bar + i) % 4], v: 82, len: 24 }));
    }
    lead.pan = 40; lead.devices = [{ type: 'echo', on: true, delay: 24, level: 0.45, pan: 'opposite' }];
    return SF3Compile.normalize({ format: 'sf3project', version: 2, name: 'Street lights', bpm: 126, bars: 8, loop: { on: true, start: 0, end: 1536 }, autoTune: true, key: { root: 9, scale: 'minor' }, sections: [{ bar: 1, name: 'Nightfall' }, { bar: 5, name: 'Homeward' }], parts: [drums, bass, lead] });
  };
})(window);
