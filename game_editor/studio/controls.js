/* CPS3 Studio · Game: keyboard and gamepads -> the machine's input words (two players, coin, start).
 * GameControls.attach(onChange) starts listening; onChange({ p01, p23 }) is called when the pressed set changes.
 * The test and service buttons are not on keys: they are pressed from the Game menu (plan step 3). */
(function (g) {
  'use strict';
  const K = g.Kit;
  /* KeyboardEvent.code -> [player, control] */
  const DEFAULT_KEYS = {
    KeyW: ['p1', 'up'], KeyS: ['p1', 'down'], KeyA: ['p1', 'left'], KeyD: ['p1', 'right'],
    KeyU: ['p1', 'lp'], KeyI: ['p1', 'mp'], KeyO: ['p1', 'hp'], KeyJ: ['p1', 'lk'], KeyK: ['p1', 'mk'], KeyL: ['p1', 'hk'],
    Digit1: ['p1', 'start'], Digit5: ['p1', 'coin'],
    ArrowUp: ['p2', 'up'], ArrowDown: ['p2', 'down'], ArrowLeft: ['p2', 'left'], ArrowRight: ['p2', 'right'],
    Numpad4: ['p2', 'lp'], Numpad5: ['p2', 'mp'], Numpad6: ['p2', 'hp'], Numpad1: ['p2', 'lk'], Numpad2: ['p2', 'mk'], Numpad3: ['p2', 'hk'],
    Digit2: ['p2', 'start'], Digit6: ['p2', 'coin'],
  };
  /* standard-mapping gamepad button -> control (X LP, Y MP, RB HP, A LK, B MK, RT HK; LB / LT repeat HP / HK) */
  const PAD = { 2: 'lp', 3: 'mp', 5: 'hp', 0: 'lk', 1: 'mk', 7: 'hk', 4: 'hp', 6: 'hk', 9: 'start', 8: 'coin', 12: 'up', 13: 'down', 14: 'left', 15: 'right' };
  const NAMES = { up: 'Up', down: 'Down', left: 'Left', right: 'Right', lp: 'Light punch', mp: 'Medium punch', hp: 'Heavy punch', lk: 'Light kick', mk: 'Medium kick', hk: 'Heavy kick', start: 'Start', coin: 'Coin' };
  const ORDER = ['up', 'down', 'left', 'right', 'lp', 'mp', 'hp', 'lk', 'mk', 'hk', 'start', 'coin'];
  const held = new Set(), pads = new Set(), extra = new Set();     /* 'p1.lp', 'p2.start', 'sys.test' */
  let onChange = null, last = '', keys = Object.assign({}, DEFAULT_KEYS, K.pref('game.keys', null) || {});
  const typing = (e) => (e.target && (e.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName))) || !!document.querySelector('.scrim');

  function current() {
    const p1 = [], p2 = [], sys = [];
    for (const k of new Set([...held, ...pads, ...extra])) { const [who, c] = k.split('.'); (who === 'p1' ? p1 : who === 'p2' ? p2 : sys).push(c); }
    return Cps3GameCore.words(p1, p2, sys);
  }
  function emit() { const w = current(), sig = w.p01 + ':' + w.p23; if (sig !== last) { last = sig; if (onChange) onChange(w); } }
  function pollPads() {
    pads.clear();
    const list = (navigator.getGamepads ? Array.from(navigator.getGamepads()) : []).filter(Boolean).slice(0, 2);
    list.forEach((p, i) => {
      const who = 'p' + (i + 1);
      p.buttons.forEach((b, n) => { if (b.pressed && PAD[n]) pads.add(`${who}.${PAD[n]}`); });
      const x = p.axes[0] || 0, y = p.axes[1] || 0;
      if (x < -0.5) pads.add(who + '.left'); if (x > 0.5) pads.add(who + '.right'); if (y < -0.5) pads.add(who + '.up'); if (y > 0.5) pads.add(who + '.down');
    });
  }
  g.GameControls = {
    DEFAULT_KEYS, NAMES, ORDER, current,
    attach(fn) {
      onChange = fn;
      window.addEventListener('keydown', (e) => { const m = keys[e.code]; if (!m || typing(e) || e.ctrlKey || e.metaKey || e.altKey) return; e.preventDefault(); held.add(m.join('.')); emit(); });
      window.addEventListener('keyup', (e) => { const m = keys[e.code]; if (!m) return; held.delete(m.join('.')); emit(); });
      window.addEventListener('blur', () => { held.clear(); emit(); });
      const loop = () => { pollPads(); emit(); requestAnimationFrame(loop); }; requestAnimationFrame(loop);
    },
    press(name, on) { if (on) extra.add(name); else extra.delete(name); emit(); },
    keyOf(who, control) { return Object.keys(keys).find((code) => keys[code][0] === who && keys[code][1] === control) || ''; },
    label(code) { return code ? code.replace(/^Key/, '').replace(/^Digit/, '').replace(/^Numpad/, 'Num ').replace(/^Arrow/, '') : '—'; },
    setKey(who, control, code) {
      for (const c of Object.keys(keys)) if (keys[c][0] === who && keys[c][1] === control) delete keys[c];
      keys[code] = [who, control];
      const diff = {}; for (const [c, v] of Object.entries(keys)) if (!DEFAULT_KEYS[c] || DEFAULT_KEYS[c].join() !== v.join()) diff[c] = v;
      for (const c of Object.keys(DEFAULT_KEYS)) if (!keys[c]) diff[c] = null;
      K.pref.set('game.keys', diff); keys = Object.fromEntries(Object.entries(Object.assign({}, DEFAULT_KEYS, diff)).filter(([, v]) => v));
    },
    resetKeys() { keys = Object.assign({}, DEFAULT_KEYS); K.pref.del('game.keys'); },
  };
  keys = Object.fromEntries(Object.entries(keys).filter(([, v]) => v));
})(window);
