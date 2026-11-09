/* Audio always comes from the arcade driver. Catch-up is sliced so the current engine keeps playing; a long
 * catch-up runs in a Worker (seekWorker below) so drawing and editing stay at full speed. */
(function (g) {
  'use strict';
  const S = g.Studio, E = SF3Engine, RATE = E.CHIP_RATE, CODE = 60;
  const T = S.transport = { playing: false, engine: null, built: null, cycle: null, position: 0, volume: 0.78, stereo: false,
    snapshots: new Map(), levels: new Float32Array(16), partLevels: {}, catchingUp: false, catchUp: null };
  let live = null, ctx, gain, timer, next = 0, serial = 0, silent = false, pendingRefresh, refreshTimer, starting = null;
  const sources = new Set(), chunks = [], stamps = [], auditions = []; let auditionIndex = 0, reference = null;
  const copy = x => JSON.parse(JSON.stringify(x)), yieldUI = () => g.scheduler?.yield ? g.scheduler.yield() : new Promise(r => { const channel = new MessageChannel(); channel.port1.onmessage = () => { channel.port1.close(); channel.port2.close(); r(); }; channel.port2.postMessage(0); });
  function context() {
    if (!ctx) { ctx = new (g.AudioContext || g.webkitAudioContext)(); gain = ctx.createGain(); gain.connect(ctx.destination); T.setVolume(T.volume); }
    return ctx.resume().then(() => { if (ctx.state !== 'running') throw new Error('Click Play to enable sound.'); });
  }
  function clearAudio() { for (const s of sources) { try { s.stop(); } catch (_) {} } sources.clear(); chunks.length = 0; stamps.length = 0; if (ctx) next = ctx.currentTime + 0.015; }
  /* Replace only buffers that have not begun. Restoring their first driver frame prevents the
   * quarter-second scheduling lead from being skipped when a control changes. */
  function boundary() {
    if (!ctx || silent || !live) return;
    const chunk = chunks.find(c => c.at >= ctx.currentTime + 0.005);
    if (!chunk) return;
    live.engine.restore(chunk.state); live.ticks = chunk.ticks;
    for (const c of chunks.filter(c => c.at >= chunk.at)) { try { c.source.stop(); } catch (_) {} sources.delete(c.source); }
    while (chunks.length && chunks[chunks.length - 1].at >= chunk.at) chunks.pop();
    while (stamps.length && stamps[stamps.length - 1].at >= chunk.at) stamps.pop();
    next = chunk.at;
  }
  function make(built, project, range) {
    const engine = new E.Engine(S.pack, { stereo: T.stereo });
    if (built.bank) engine.installBank(built.bank);
    engine.patchAt(E.CAVE.preview, built.bytes); engine.setRequest(CODE, E.CAVE.preview); engine.request(CODE);
    return { engine, built, project: copy(project), range, ticks: 0, lead: range ? 0 : project.leadIn, snaps: new Map() };
  }
  function tickPosition(x) {
    let t = Math.max(0, x.ticks - x.lead), loop = x.built.loop;
    if (loop && t >= loop.end && loop.end > loop.start) t = loop.start + (t - loop.start) % (loop.end - loop.start);
    return t + (x.range ? x.range.from : 0);
  }
  function step(x, L, R, at) {
    if (x === live && T.playing) S.state.emit('driver-frame', x.engine);
    const n = x.engine.step(L, R, at);
    x.ticks += (x.engine.tempo() + x.engine.tempoOffsetValue()) / 256;
    const t = x.ticks - x.lead, bar = Math.floor(t / 192);
    if (t >= 0 && bar % 4 === 0 && !x.snaps.has(bar) && (!x.built.loop || t < x.built.loop.end)) x.snaps.set(bar, { ticks: x.ticks, state: x.engine.snapshot() });
    return n;
  }
  /* ---- catch-up ------------------------------------------------------------------------------
   * After an edit the driver replays the song from its start (or the nearest saved state of the same build) up to the
   * playing position: the driver's RAM holds pointers into the sequence, so only a replay is exact. Deep in a long song
   * that is thousands of frames (bar 180 of a 208-bar, 16-track song: about 17,000 frames, 2 s of work), which on the
   * page's thread stalled drawing to ~9 fps for seconds. A catch-up longer than FAR frames therefore runs in a Worker
   * made from the engine's own source (sh2.js and engine.js register their module functions in SF3Modules): it builds
   * the engine as make() does, steps it as step() does (the same tick sums, the same 4-bar snapshots) and hands back
   * the engine's saved state, which restore() puts into the page's engine, so the sound is the same frame for frame.
   * It works in slices of about 40 ms, so a newer request or a stop is answered at once, and it chases a moving
   * target (the position the sound will have when the new engine takes over). Without Workers, or if the Worker
   * fails, the page's thread does the whole catch-up as before. */
  const FAR = 24, seeker = { worker: null, off: false, pack: null, id: 0, waits: new Map(), mode: 'auto' };
  const ticksPerFrame = () => Math.max(0.25, ((S.state.project && S.state.project.bpm) || 120) * 48 / 60 / E.FRAME_RATE);
  function seekWorker(self) {
    'use strict';
    const E = self.SF3Engine, jobs = new Map(), buffers = s => [s.ram.buffer, s.regs.buffer, s.pos.buffer, s.frac.buffer, s.cpu.r.buffer];
    let pack = null;
    self.onmessage = e => {
      const m = e.data;
      try {
        if (m.type === 'pack') { pack = m.pack; return; }
        if (m.type === 'drop') { jobs.delete(m.id); return; }
        let x = jobs.get(m.id);
        if (m.type === 'start') {
          const engine = new E.Engine(pack, { stereo: m.stereo });
          if (m.bank) engine.installBank(m.bank);
          engine.patchAt(E.CAVE.preview, m.bytes); engine.setRequest(m.code, E.CAVE.preview); engine.request(m.code);
          x = { engine, ticks: 0, lead: m.lead, loopEnd: m.loopEnd, have: new Set(m.have), snaps: [], frames: 0 };
          if (m.from) { engine.restore(m.from.state); x.ticks = m.from.ticks; }
          jobs.set(m.id, x);
        }
        if (!x) return;
        const until = performance.now() + 40; let n = 0;
        while (x.ticks < m.target) {
          x.engine.step();
          x.ticks += (x.engine.tempo() + x.engine.tempoOffsetValue()) / 256;
          const t = x.ticks - x.lead, bar = Math.floor(t / 192);
          if (t >= 0 && bar % 4 === 0 && !x.have.has(bar) && (x.loopEnd === null || t < x.loopEnd)) { x.have.add(bar); x.snaps.push({ bar, ticks: x.ticks, state: x.engine.snapshot() }); }
          if (++x.frames > 400000) throw new Error('This position is beyond the playback limit.');
          if ((++n & 15) === 0 && performance.now() > until) break;
        }
        const reached = x.ticks >= m.target;
        if (reached && m.take) {
          jobs.delete(m.id);
          const state = x.engine.snapshot(), transfer = buffers(state);
          for (const snap of x.snaps) transfer.push(...buffers(snap.state));
          self.postMessage({ type: 'state', id: m.id, ticks: x.ticks, frames: x.frames, state, snaps: x.snaps }, transfer);
        } else self.postMessage({ type: 'at', id: m.id, ticks: x.ticks, reached });
      } catch (err) { jobs.delete(m.id); self.postMessage({ type: 'error', id: m.id, message: (err && err.message) || String(err) }); }
    };
  }
  function seekerLost(why) {
    seeker.off = true; T.seekWorker = 'off: ' + why;
    try { if (seeker.worker) seeker.worker.terminate(); } catch (_) {}
    seeker.worker = null; for (const w of seeker.waits.values()) w({ type: 'lost' }); seeker.waits.clear();
  }
  function seekerWorker() {
    if (seeker.off || seeker.mode === 'page') return null;
    if (!seeker.worker) {
      const M = g.SF3Modules;
      if (!M || !M.sh2 || !M.engine || typeof g.Worker !== 'function') { seeker.off = true; T.seekWorker = 'off: no Worker'; return null; }
      try {
        const url = URL.createObjectURL(new Blob([`(${M.sh2})(self);\n(${M.engine})(self);\n(${seekWorker})(self);\n`], { type: 'text/javascript' }));
        try { seeker.worker = new Worker(url); } finally { URL.revokeObjectURL(url); }
      } catch (e) { seeker.off = true; T.seekWorker = 'off: ' + e.message; return null; }
      seeker.worker.onmessage = e => { const w = seeker.waits.get(e.data.id); if (w) { seeker.waits.delete(e.data.id); w(e.data); } };
      seeker.worker.onerror = e => { if (e.preventDefault) e.preventDefault(); seekerLost(e.message || 'the worker stopped'); };
      seeker.pack = null; T.seekWorker = 'on';
    }
    if (seeker.pack !== S.pack) {
      /* exact copies, moved (not copied again) into the worker; the page keeps its own */
      const P = E.preparePack(S.pack), prg = P.prg.map(r => ({ addr: r.addr, bytes: r.bytes.slice() })), samples = new Uint8Array(P.samples.buffer, P.samples.byteOffset, P.samples.length).slice();
      seeker.worker.postMessage({ type: 'pack', pack: { prg, samples, game: S.pack.game } }, [samples.buffer, ...prg.map(r => r.bytes.buffer)]);
      seeker.pack = S.pack;
    }
    return seeker.worker;
  }
  const ask = (w, message) => new Promise(resolve => { seeker.waits.set(message.id, resolve); w.postMessage(message); });
  /* null: no worker (the page's thread goes on from where x is); false: superseded; true: x holds the worker's state */
  async function seekFar(x, best, goal, token) {
    const w = seekerWorker(); if (!w) return null;
    const id = ++seeker.id, began = performance.now(), near = 6 * ticksPerFrame(), bank = x.built.bank;
    const from = best ? { ticks: best.ticks, state: best.state } : x.ticks > 0 ? { ticks: x.ticks, state: x.engine.snapshot() } : null, first = from ? from.ticks : 0;
    let target = goal(), reply = await ask(w, { type: 'start', id, code: CODE, bytes: x.built.bytes, bank: bank ? { bytes: bank.bytes, base: bank.base, slot: bank.slot } : null, stereo: x.engine.stereo,
      lead: x.lead, loopEnd: x.built.loop ? x.built.loop.end : null, have: [...x.snaps.keys()], from, target, take: false });
    for (;;) {
      if (reply.type === 'lost') return null;
      if (reply.type === 'error') throw new Error(reply.message);
      if (reply.type === 'state') {
        x.engine.restore(reply.state); x.ticks = reply.ticks;
        for (const snap of reply.snaps) if (!x.snaps.has(snap.bar)) x.snaps.set(snap.bar, { ticks: snap.ticks, state: snap.state });
        T.seekStats = { at: began, frames: reply.frames, elapsed: performance.now() - began, worker: true }; return true;
      }
      if (token !== serial) { w.postMessage({ type: 'drop', id }); return false; }
      target = goal();
      if (performance.now() - began > 250) { T.catchingUp = true; T.catchUp = { done: Math.max(0, Math.min(1, (reply.ticks - first) / Math.max(1, target - first))) }; S.state.emit('transport', T); }
      reply = await ask(w, { type: 'run', id, target, take: target - reply.ticks <= near });
    }
  }
  async function seek(x, tick, token) {
    const goal = () => Math.max(0, (typeof tick === 'function' ? tick() : tick) - (x.range ? x.range.from : 0)) + x.lead;
    let best = null;
    const target = goal(), start = performance.now();
    for (const snap of x.snaps.values()) if (snap.ticks <= target && snap.ticks > x.ticks && (!best || snap.ticks > best.ticks)) best = snap;
    let far = null;
    if ((target - (best ? best.ticks : x.ticks)) / ticksPerFrame() > FAR) {
      far = await seekFar(x, best, goal, token);
      if (far === false) return false;
      if (far) best = null;
    }
    if (best) { x.engine.restore(best.state); x.ticks = best.ticks; }
    const end = goal(); let frames = 0, slice = performance.now(), waiting = 0;
    while (x.ticks < end) {
      step(x); if (++frames > 400000) throw new Error('This position is beyond the playback limit.');
      if (performance.now() - slice > 12) { if (performance.now() - start > 300) T.catchingUp = true; const waitStart = performance.now(); await yieldUI(); waiting += performance.now() - waitStart; if (token !== serial) return false; slice = performance.now(); }
    }
    if (far) Object.assign(T.seekStats, { pageFrames: frames, total: performance.now() - start, waiting });
    else T.seekStats = { frames, elapsed: performance.now() - start, waiting, worker: false };
    x.engine.peaks.fill(0); return token === serial;
  }
  /* the song position of the first queued buffer that has not begun: where boundary() lets a new engine take over */
  function upcoming() {
    if (ctx && !silent && live) { const c = chunks.find(c => c.at >= ctx.currentTime + 0.005); if (c) return tickPosition({ ticks: c.ticks, lead: live.lead, built: live.built, range: live.range }); }
    return live ? tickPosition(live) : T.position;
  }
  function mute(x) {
    const parts = S.state.project.parts, solo = parts.some(p => p.solo); let mask = 0;
    for (const p of parts) if (p.mute || (solo && !p.solo)) for (const tr of x.built.report.partTracks[p.id] || []) mask |= 1 << tr;
    x.engine.mute = mask;
  }
  function publish(x) {
    live = x; T.engine = x.engine; T.built = x.built; T.snapshots = x.snaps; T.position = tickPosition(x); T.catchingUp = false; T.catchUp = null; mute(x); S.state.emit('transport', T);
  }
  /* A start (play or jump) builds from the current project itself: a refresh scheduled by an edit just before it is
   * dropped, and an edit made while it catches up is applied after it, so the requested position always wins. */
  T.play = function (opts) { clearTimeout(refreshTimer); const run = start(opts); starting = run; const done = () => { if (starting === run) starting = null; }; run.then(done, done); return run; };
  async function start(opts) {
    opts = opts || {}; const token = ++serial; silent = !!opts.silent;
    if (!silent) await context();
    seekerWorker();
    const range = T.cycle && { ...T.cycle }, b = S.state.build({ range }), x = make(b, S.state.project, range);
    if (live && live.built === b) x.snaps = live.snaps;
    const position = opts.tick == null ? T.position : opts.tick;
    if (!await seek(x, range ? Math.max(range.from, Math.min(range.to - 1, position)) : position, token) || token !== serial) return;
    clearAudio(); publish(x); T.playing = true;
    clearInterval(timer); if (!silent) { timer = setInterval(pump, 20); pump(); }
    S.state.emit('transport', T);
  }
  T.stop = function () { ++serial; clearTimeout(refreshTimer); clearInterval(timer); clearAudio(); T.playing = false; T.catchingUp = false; T.catchUp = null; reference = null; T.referenceCode = null; if (S.mix) S.mix.referenceOn = false; auditions.length = 0; T.levels.fill(0); S.state.emit('transport', T); };
  T.toggle = () => T.playing ? T.stop() : T.play();
  T.jump = tick => { T.position = Math.max(0, tick); if (T.playing) return T.play({ tick, silent }); S.state.emit('transport', T); return Promise.resolve(); };
  T.setCycle = range => { if (range && !(Number.isFinite(range.from) && range.from >= 0 && range.to > range.from)) throw new Error('Choose a cycle with an end after its start.'); T.cycle = range ? { from: range.from, to: range.to } : null; S.state.emit('transport', T); };
  T.setStereo = on => { T.stereo = !!on; if (live) live.engine.setStereo(T.stereo); if (reference) reference.engine.setStereo(T.stereo); for (const a of auditions) if (a) a.engine.setStereo(T.stereo); Kit.pref.set('music.stereo', T.stereo); S.state.emit('transport', T); };
  T.setVolume = value => { T.volume = Math.max(0, Math.min(1, value)); if (gain) gain.gain.value = T.volume * T.volume; };
  /* Tempo and mixer flags have a direct, verified driver control. Other edits catch up an engine;
   * this preserves automation, derived tracks and envelope state instead of guessing their RAM. */
  function structural(p) { const x = copy(p); delete x.bpm; delete x.name; delete x.ui; for (const part of x.parts) { delete part.mute; delete part.solo; for (const name of ['volume', 'pan', 'expression']) if (!(part.automation[name] || []).length && !part.notes.some(n => n[name] !== undefined) && !part.devices.some(d => d.on !== false)) delete part[name]; } return JSON.stringify(x); }
  T.refresh = function () {
    clearTimeout(refreshTimer);
    if (starting) return starting.then(() => T.refresh(), () => {});
    if (!T.playing || !live) return Promise.resolve();
    if (pendingRefresh) return pendingRefresh.then(() => T.refresh());
    const revision = S.state.revision;
    pendingRefresh = (async () => {
      const project = S.state.project, range = T.cycle && { ...T.cycle }, b = S.state.build({ range });
      if (b === live.built) { mute(live); return; }
      if (JSON.stringify(range) === JSON.stringify(live.range) && structural(project) === structural(live.project) && b.bytes.length === live.built.bytes.length) {
        boundary();
        live.engine.patchAt(E.CAVE.preview, b.bytes);
        if (project.bpm !== live.project.bpm) live.engine.setTempo(SF3Seq.bpmToTempo(project.bpm));
        for (const part of project.parts) { const old = live.project.parts.find(p => p.id === part.id); for (const [name, offset] of [['volume', 98], ['expression', 100], ['pan', 109]]) if (part[name] !== old[name]) for (const tr of b.report.partTracks[part.id] || []) live.engine.w8(E.CHANNELS + tr * E.CHANNEL_SIZE + offset, part[name] & 127); }
        live.project = copy(project); live.built = b; live.snaps.clear(); T.built = b; mute(live); if (!silent) pump(); return;
      }
      const token = ++serial, x = make(b, project, range);
      if (!await seek(x, upcoming, token) || token !== serial) return;
      /* Keep the old sound until the new engine is ready, then replace the queued buffers. */
      boundary();
      if (!await seek(x, tickPosition(live), token) || token !== serial) return;
      publish(x); if (!silent) pump();
    })().finally(() => { pendingRefresh = null; T.catchingUp = false; T.catchUp = null; });
    return pendingRefresh.then(() => { if (S.state.revision !== revision) return T.refresh(); });
  };
  S.state.on('project', () => { if (live) mute(live); if (T.playing) { clearTimeout(refreshTimer); refreshTimer = setTimeout(() => T.refresh().catch(fail), 15); } });
  function fail(e) { T.stop(); Kit.toast(e.message, { kind: 'bad' }); }
  T.advance = function (frames) { if (!live) throw new Error('Start playback first.'); for (let i = 0; i < frames; i++) step(live); T.position = tickPosition(live); S.state.emit('transport', T); };
  function pump() {
    if (!ctx || ctx.state !== 'running') return;
    try {
      if (next < ctx.currentTime) next = ctx.currentTime + 0.015;
      let guard = 0;
      while ((T.playing || auditions.some(Boolean)) && next < ctx.currentTime + (document.hidden ? 1.5 : 0.25) && guard++ < 25) {
        const L = new Int32Array(4096), R = new Int32Array(4096), state = live && live.engine.snapshot(), ticks = live && live.ticks; let n = 0;
        if (T.playing) for (let f = 0; f < 4; f++) {
          if (reference) { const count = live ? step(live) : 1; n += reference.engine.step(L, R, n); if (!count) break; }
          else n += step(live, L, R, n);
        }
        for (let i = 0; i < auditions.length; i++) { const a = auditions[i]; if (!a) continue; let count = 0; for (let f = 0; f < 4; f++) count += a.engine.step(L, R, count); n = Math.max(n, count); a.frames += 4; if (a.frames > 20 && !a.engine.key) auditions[i] = null; if (a.frames > 3600) auditions[i] = null; }
        if (!n) break;
        if (reference) for (let i = 0; i < n; i++) { L[i] = Math.round(L[i] * reference.gain); R[i] = Math.round(R[i] * reference.gain); }
        const buffer = ctx.createBuffer(2, n, RATE), left = buffer.getChannelData(0), right = buffer.getChannelData(1);
        for (let i = 0; i < n; i++) { left[i] = Math.max(-1, Math.min(1, L[i] / 32768)); right[i] = Math.max(-1, Math.min(1, R[i] / 32768)); }
        const source = ctx.createBufferSource(); source.buffer = buffer; source.connect(gain); sources.add(source); source.onended = () => { sources.delete(source); const i = chunks.findIndex(c => c.source === source); if (i >= 0) chunks.splice(i, 1); }; source.start(next);
        if (live) chunks.push({ source, at: next, state, ticks });
        if (live) { stamps.push({ at: next, position: tickPosition(live), levels: live.engine.peaks.slice(), audio: { L, R, n, rate: RATE } }); live.engine.peaks.fill(0); }
        next += n / RATE;
      }
      while (stamps.length && stamps[0].at <= ctx.currentTime) { const s = stamps.shift(); T.position = s.position; T.levels = s.levels; T.audio = s.audio; }
      if (live) { T.partLevels = {}; for (const [id, tracks] of Object.entries(live.built.report.partTracks)) T.partLevels[id] = tracks.reduce((sum, tr) => sum + T.levels[tr], 0); }
      S.state.emit('transport', T);
    } catch (e) { fail(e); }
  }
  T.audition = async function (part, note, velocity, ticks) {
    await context(); const p = copy(part); p.mute = p.solo = false; p.notes = [{ t: 0, n: note, v: velocity || 100, len: ticks || 48 }];
    const project = SF3Compile.normalize({ format: 'sf3project', version: 2, bpm: S.state.project.bpm, bars: Math.max(1, Math.ceil(((ticks || 48) + 384) / 192)), loop: { on: false }, parts: [p], bank: S.state.project.bank });
    const x = make(SF3Compile.build(project, { catalog: S.state.catalog }), project, null); x.frames = 0;
    const slot = auditionIndex++ % 4; auditions[slot] = x; if (!T.playing) { clearInterval(timer); timer = setInterval(pump, 20); } pump();
    return () => { if (auditions[slot] === x) auditions[slot] = null; };
  };
  T.reference = async function (code, opts = {}) { boundary(); if (!code) { reference = null; T.referenceCode = null; if (!live) T.stop(); return; } if (!opts.silent) await context(); const engine = new E.Engine(S.pack, { stereo: T.stereo }); engine.request(code); reference = { engine, code, gain: opts.gain == null ? 1 : opts.gain }; T.referenceCode = code; if (!T.playing) { if (S.state.project.parts.some(p => p.notes.length)) await T.play(opts); else { live = null; T.engine = engine; T.playing = true; silent = !!opts.silent; clearAudio(); if (!silent) { clearInterval(timer); timer = setInterval(pump, 20); pump(); } S.state.emit('transport', T); } } };
  T.control = fn => { if (!live) return; boundary(); fn(live.engine); };
  /* where catch-ups run: 'auto' (a Worker when long) or 'page' (always the page's thread; checks compare the two) */
  T.seekMode = mode => { if (mode) seeker.mode = mode; return seeker.mode; };
  document.addEventListener('visibilitychange', pump);
})(window);
