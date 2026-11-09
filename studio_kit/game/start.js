/* Cps3GameStart: named starting moments the engine makes from power-on by inputs only (CPS3 Studio · Game,
 * plan §4b B1). A start is a recipe (ROM-free data) plus the images it ran on; the snapshot it gives is
 * cached per image key and remade whenever an image changes, because RAM and character RAM at that moment
 * already hold data copied from the ROM.
 *
 * "ready-select" (the default start for Play, Try in game, scenarios, tests and batch runs): the black frame
 * immediately before character select starts loading, both players in. Evidence (the game verification notes: 
 * ready_select_probe.js, ready-select evidence): with the Studio's settings chip (free play),
 * P1 Start held on frames 400-403 and P2 Start on 404-407 after power-on; after frame 410 the scene words
 * G_No (02015436, four words) are 1,1,0,0 (Game00), the screen is all black, P1's Operator_Status (020156E2)
 * is human, P2's entry is latched (02011390 = 1); on frame 411 G_No becomes 1,1,1,0 (Game01, select) and
 * the first select upload (palette DMA) happens; the select picture appears 40 frames later, when P2's
 * Operator_Status and Play_Type (020113B4 = 1) are written. Identical on the original and on all three
 * Infinite modes (rechecked on 1.07b, the current release: Game reaches this start on Super SF3, 3rd Strike and 3v3).
 * Without credits (free play off) Start does nothing and the facts do not hold.
 *
 *   Cps3GameStart.RECIPES['ready-select']          { id, version, frames, steps, label }
 *   Cps3GameStart.inputs(recipe) -> [[p01, p23], ...]   one entry per frame
 *   Cps3GameStart.facts(core) -> { ok, gNo, op, p2Entry, black, why }   the moment's checks (core = Cps3GameCore)
 *   Cps3GameStart.key({ digest, program, data, bios, eeprom, recipe }) -> string   (hashes are hex strings)
 *   Cps3GameStart.scenario(...) / runScenario(core, scenario)   see below
 * Same code in Node, the page and the engine worker.
 */
(function (g) {
  'use strict';
  /* a factory, so the engine worker can include it as text (cps3game.js); CoreApi = Cps3GameCore */
  function factory(CoreApi) {
  const Core = () => CoreApi;

  const RECIPES = {
    'ready-select': {
      id: 'ready-select', version: 1, frames: 410, label: 'Ready at character select',
      about: 'Power on with the Studio settings chip (free play); P1 Start on frames 400-403, P2 Start on 404-407; the start is the state after frame 410.',
      steps: [{ wait: 399 }, { press: ['p1.start'], frames: 4 }, { press: ['p2.start'], frames: 4 }, { wait: 3 }],
    },
  };

  function inputs(recipe) {
    const list = Core().framesOf(recipe.steps);
    if (list.length !== recipe.frames) throw new Error(`The recipe ${recipe.id} gives ${list.length} frames, not ${recipe.frames}.`);
    return list;
  }

  const word = (ram, a) => ram[a - 0x02000000] << 8 | ram[a - 0x02000000 + 1];
  function facts(core) {
    const ram = core.ram(), rgb = core.rgb();
    const gNo = [0, 1, 2, 3].map((i) => word(ram, 0x02015436 + 2 * i));
    const op = [ram[0x156E2], ram[0x156E3]], p2Entry = ram[0x11390];
    let black = true; for (let i = 0; i < rgb.length; i++) if (rgb[i]) { black = false; break; }
    const why = [];
    if (gNo.join() !== '1,1,0,0') why.push(`the scene words are ${gNo.join(',')}, not 1,1,0,0 (the black screen before select)`);
    if (!(op[0] & 0x7F)) why.push('player 1 has not joined');
    if (!(op[1] & 0x7F) && p2Entry !== 1) why.push('player 2 has not joined');
    if (!black) why.push('the screen is not black');
    return { ok: !why.length, gNo, op, p2Entry, black, why };
  }

  function key(o) {
    const r = o.recipe || RECIPES['ready-select'];
    return ['start', r.id, r.version, o.digest, o.program, o.data, o.bios, o.eeprom].join(':');
  }

  /* Scenario files: small, ROM-free, shareable. The Studio rebuilds the start from its recipe on the
     user's own images; the image hashes say which images the scenario was recorded on.
       { format: 'cps3studio-scenario', version: 1, start: 'ready-select' | 'power-on', source, mode,
         images: { program, data, bios, eeprom }, inputs: [[p01, p23, count], ...] (run-length), checks: [...] }
     checks: { at: frame (from the start), state?: hex, ram?: hex, peek?: [addr, len], equals?: hex } */
  function rle(list) {
    const out = [];
    for (const [a, b] of list) { const l = out[out.length - 1]; if (l && l[0] === a && l[1] === b) l[2]++; else out.push([a, b, 1]); }
    return out;
  }
  function unrle(runs) { const out = []; for (const [a, b, n] of runs) for (let i = 0; i < n; i++) out.push([a >>> 0, b >>> 0]); return out; }
  function scenario(o) {
    return { format: 'cps3studio-scenario', version: 1, start: o.start || 'ready-select', source: o.source || null, mode: o.mode == null ? null : o.mode,
      images: o.images || null, inputs: rle(o.inputs || []), checks: o.checks || [], note: o.note || '' };
  }
  function parse(text) {
    const s = typeof text === 'string' ? JSON.parse(text) : text;
    if (!s || s.format !== 'cps3studio-scenario' || s.version !== 1) throw new Error('This is not a CPS3 Studio scenario file.');
    if (s.start !== 'ready-select' && s.start !== 'power-on') throw new Error(`Unknown start "${s.start}".`);
    return s;
  }

  /* From the ready start to a sound request through the game's own service menu (the game verification notes: 
     sound_test_route.md): the board's test button, 3) SOUND & VOICE TEST, the code by 1P Right (+0x10) and Up (+1),
     1P Shot1 = REQUEST. Inputs only; the stock game asks for codes 50-95 nowhere else. */
  function soundTestRoute(code) {
    const d = (k) => ({ press: [k], frames: 2, then: 14 }), steps = [{ press: ['test'], frames: 4, then: 200 }, d('p1.down'), d('p1.down'), { press: ['p1.lp'], frames: 2, then: 90 }];
    for (let i = 0; i < (code >> 4); i++) steps.push(d('p1.right'));
    for (let i = 0; i < (code & 15); i++) steps.push(d('p1.up'));
    steps.push({ press: ['p1.lp'], frames: 2, then: 0 });
    return Core().framesOf(steps);
  }

  return { RECIPES, inputs, facts, key, scenario, parse, rle, unrle, soundTestRoute };
  }
  const core = g.Cps3GameCore || (typeof require === 'function' ? require('./core.js') : null);
  const api = factory(core);
  /* Compatibility entry uses the same strict service as the Game worker and CLI. */
  api.runScenario=(machine,s,render=true)=>(g.CPS3Scenarios||(typeof require==='function'&&require('./scenarios.js'))).run(machine,s,{render});
  api.factory = factory;
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else g.Cps3GameStart = api;
})(typeof self !== 'undefined' ? self : this);
