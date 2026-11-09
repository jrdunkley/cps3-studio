/* Cps3Game: the exact CPS3 machine running in a Web Worker, for every Studio module (CPS3 Studio · Game).
 *
 *   const game = await Cps3Game.create({ program, bios, data })     decrypted program, decrypted BIOS, 64 MiB SIMM 3-6
 *   await game.coldBoot({ eeprom, freePlay, mode })                   power on (see settingsBlock below)
 *   await game.readyStart({ eeprom, freePlay, mode, key, cache })     the default start: ready at character select
 *                                                                     (start.js), made from power-on by its recipe or
 *                                                                     restored from cache.get(key); -> { frame, facts, cached, ms }
 *   game.play() / game.pause() / game.step(n) / game.speed(x)         x in {0.25, 0.5, 1, 2, 4}
 *   game.input(words)                                                 current pressed bits {p01, p23} (Cps3GameCore.words)
 *   game.onFrame = ({ rgba, frame, meters, audioClock }) => ...       picture (384 x 224 RGBA); releaseFrame after copying
 *   await game.sound(true|false)                                      chip-rate audio through an AudioWorklet
 *   await game.rewind(frames) / game.replay(frames)                   back through keyframes / forward again on the recorded inputs
 *   await game.save() -> { bytes, frame } / await game.load(bytes)    whole-machine snapshots
 *   await game.hash() -> { ram, state, frame }                        for gates
 *   await game.call(name, ...args)                                    anything the worker exposes (peek, run, ...)
 *
 * Pacing: with sound on at 1x the audio clock drives the machine (the worklet reports what it played,
 * the worker keeps a configurable queue (default twelve frames, about 201 ms). Frame timestamps let
 * the page present the matching picture as that audio plays. The cushion covers browser scheduling stalls;
 * otherwise performance.now() at 59.59949 Hz x speed. Rendering never changes what the machine does.
 * The page cannot fetch files from disk, so the worker is made from this script's own source (a Blob).
 */
(function (g) {
  'use strict';
  const FPS = 59.59949, CHIP_RATE = 42954500 / 3 / 384;

  /* ---------------------------------------------------------------- worker side (stringified) -- */
  function workerMain(self, CoreApi, StartApi, ScenarioApi) {
    let core = null, playing = false, speed = 1, soundOn = false, port = null, timer = 0, lastTick = 0, due = 0, allowFixtures = false;
    let frame = 0, input = { p01: 0, p23: 0 }, log = new Uint32Array(2 * 65536), logEnd = 0;
    const KEY_EVERY = 60, PAGE = 4096, keys = new Map(); let keyLimit = 7200;          /* keyframes: frame -> [page refs] */
    let queued = 0, played = 0, audioEpoch = 0;                                                          /* audio samples sent / reported played */
    /* Audio-port messages wake the worker directly. Buffered audio and video share one playhead. */
    let bufferFrames=12; const post = (m, t) => self.postMessage(m, t || []);

    function resetAudio() {
      queued=played=0; audioEpoch++;
      if(port)port.postMessage({reset:audioEpoch,active:playing&&soundOn&&speed===1,prime:bufferFrames*625});
    }
    function record(f, w) {
      if(f<logEnd&&(log[2*f] !== (w.p01>>>0) || log[2*f+1] !== (w.p23>>>0))){
        logEnd=f;for(const [at,pages]of keys)if(at>f){releasePages(pages);keys.delete(at);}
      }
      if (2 * f + 2 > log.length) { const n = new Uint32Array(log.length * 2); n.set(log); log = n; }
      log[2 * f] = w.p01; log[2 * f + 1] = w.p23; if (f + 1 > logEnd) logEnd = f + 1;
    }
    const freePages = [];
    function releasePages(pages) { for (const page of pages) if (!--page.refs) freePages.push(page); }
    function clearKeys() { for (const pages of keys.values()) releasePages(pages); keys.clear(); }
    function keyframe(force = false) {
      if (!force && frame % KEY_EVERY) return;
      for (const [f,pages] of keys) if (f < frame-keyLimit) { releasePages(pages); keys.delete(f); }
      const snap=core.saveView(), words=new Uint32Array(snap.buffer,snap.byteOffset,snap.length/4);
      const prev=keys.get(frame-KEY_EVERY), pages=[];
      for(let o=0,i=0;o<snap.length;o+=PAGE,i++) {
        const length=Math.min(PAGE,snap.length-o), old=prev&&prev[i];
        let same=!!old&&old.bytes.length===length;
        if(same)for(let k=0;k<length/4;k++)if(words[(o/4)+k]!==old.words[k]){same=false;break;}
        let page=old;
        if(!same){const at=freePages.findIndex(p=>p.bytes.length===length);page=at<0?null:freePages.splice(at,1)[0];
          if(!page){const bytes=new Uint8Array(length);page={bytes,words:new Uint32Array(bytes.buffer),refs:0};}
          page.bytes.set(snap.subarray(o,o+length));
        }
        page.refs++;pages.push(page);
      }
      pages.inspection=core.saveInspection();
      const replaced=keys.get(frame);if(replaced)releasePages(replaced);keys.set(frame,pages);
    }
    function restoreKey(f) {
      const pages = keys.get(f), n = core.snapshotSize(), b = new Uint8Array(n); let o = 0;
      for (const p of pages) { b.set(p.bytes, o); o += p.bytes.length; }
      core.restore(b);core.restoreInspection(pages.inspection); frame = f;
    }
    const audioPool=[], framePool=[];
    function audioOut() {
      const s = core.audio(), n = s.length >> 1;
      if (!playing || !soundOn || speed!==1 || !port || !n) return;
      const slot=audioPool.findIndex(b=>b.length===2*n);
      const out = slot<0?new Float32Array(2*n):audioPool.splice(slot,1)[0];
      for (let i = 0; i < 2 * n; i++) out[i] = s[i] / 32768;
      port.postMessage({epoch:audioEpoch,samples:out}, [out.buffer]); queued += n;
    }
    function runOne(w, render, live) {
      if (live) record(frame, w);
      const f = core.frame(w.p01, w.p23, render ? 1 : 0);
      if (f) { playing = false; resetAudio(); post({ type: 'fault', fault: f, frame, meters: core.meters() }); return false; }
      frame++; if (live) audioOut(); keyframe();                          /* the sound goes out before the keyframe's work */
      return true;
    }
    function show() {
      const rgba = framePool.pop() || new Uint8ClampedArray(384*224*4);rgba.set(core.rgba());
      const audioClock=playing&&soundOn&&speed===1?{epoch:audioEpoch,end:queued}:null;
      post({ type: 'frame', frame, meters: core.meters(), audioClock, rgba: rgba.buffer }, [rgba.buffer]);
    }
    const perf = { frames: 0, ms: 0, worstTick: 0, worstGap: 0, ticks: 0, since: performance.now() };     /* worker time spent running the machine */
    /* live play: every frame is drawn and sent, the page shows them one per display refresh */
    function run(n, render = true) {
      const t = performance.now();
      for (let i = 0; i < n; i++) { if (!runOne(input, render, true)) return; if (render) show(); }
      const d = performance.now() - t; perf.frames += n; perf.ms += d; perf.ticks++; if (d > perf.worstTick) perf.worstTick = d;
    }
    function tick() {
      if (timer) clearTimeout(timer);
      timer = 0; if (!playing) return;
      const now = performance.now();
      perf.worstGap = Math.max(perf.worstGap, now - lastTick);
      let n;
      if (soundOn && speed === 1 && port) n = Math.max(0, Math.ceil((bufferFrames*626 - (queued - played)) / 626));
      else { due += (now - lastTick) / 1000 * 59.59949 * speed; n = Math.floor(due); due -= n; }
      lastTick = now;
      if (n > 8) { n = 8; due = 0; }                                    /* behind: drop pace, never spiral */
      if (n) run(n);
      timer = setTimeout(tick, 4);
    }
    const api = {
      async init(o) {
        allowFixtures = o.allowFixtures === true;
        core = await CoreApi.create(o.wasm);
        core.setImages(new Uint8Array(o.program), new Uint8Array(o.bios), new Uint8Array(o.data), { biosDip: o.biosDip });
        core.observe(true);
        return { snapshotSize: core.snapshotSize() };
      },
      /* eeprom: bytes or null; prepare: { freePlay, mode } applied to the factory block the game itself writes */
      cold(o) {
        api.pause();
        let block = o.eeprom ? new Uint8Array(o.eeprom) : null;
        if (o.prepare && !block) { core.coldBoot(null); for (let i = 0; i < 30; i++) core.frame(0, 0, 2); block = core.eeprom().slice(); }
        if (o.prepare && block) { if (o.prepare.freePlay) { block[2] = 0x12; block[50] = 0x12; } if (o.prepare.mode != null) for (const at of o.prepare.modeOffsets || []) block[at] = o.prepare.mode; }
        core.coldBoot(block); frame = 0; logEnd = 0; clearKeys(); keyframe();
        if (!o.quiet) { core.render(); show(); }
        return { eeprom: block ? Array.from(block) : null };
      },
      /* the ready start: from the cached snapshot when given (checked against the recipe's facts), else power on + recipe */
      ready(o) {
        api.pause();
        const t = performance.now(); let block = null;
        if (o.snapshot) {core.restore(new Uint8Array(o.snapshot));if(o.inspection)core.restoreInspection(new Uint8Array(o.inspection));}
        else {
          block = api.cold(Object.assign({}, o, { quiet: true })).eeprom;
          for (const [p01, p23] of o.frames) { const f = core.frame(p01, p23, 0); if (f) throw new Error('The machine stopped while making the start (CPU fault ' + f + ').'); }
        }
        frame = core.frameNumber(); logEnd = frame; clearKeys(); keyframe(true); core.render();
        const facts = StartApi.facts(core); show();
        const out = { frame, facts, ms: performance.now() - t, eeprom: block, state: core.hashState() };
        if (!o.snapshot && facts.ok) {out.bytes = core.save().buffer;out.inspection=core.saveInspection()?.buffer;}
        return out;
      },
      loadFbneo(o) { api.pause();core.loadFbneo(new Uint8Array(o.raw)); frame = 0; logEnd = 0; clearKeys(); keyframe(); core.render(); show(); return true; },
      play() { if (!playing) { playing = true; lastTick = performance.now(); due = 0; resetAudio(); tick(); } return true; },
      pause() { playing = false; resetAudio(); if (timer) clearTimeout(timer); timer = 0; return frame; },
      speed(x) { if(![0.25,0.5,1,2,4].includes(x))throw new Error('Unsupported game speed');speed = x; due = 0;resetAudio(); return speed; },
      input(w) { input = w; return true; },
      inspectPixel(x,y) { api.pause(); return {frame,...core.inspectPixel(x,y)}; },
      step(n = 1) { run(n); return frame; },
      run(o) {                                                           /* scripted: o.inputs = [[p01, p23], ...] or n frames of the current input */
        const list = o.inputs || [], n = o.frames || list.length, rgb = o.hashes ? [] : null;  /* o.hashes: every frame drawn, its picture hash kept */
        for (let i = 0; i < n; i++) {
          const w = list[i] ? { p01: list[i][0] >>> 0, p23: list[i][1] >>> 0 } : input;
          if (!runOne(w, !!rgb || o.render === 'each' || (o.render !== false && i === n - 1), true)) break;
          if (rgb) rgb.push(core.hashRgb());
        }
        if (o.render !== false && n) show();
        return { frame, ram: core.hashRam(), rgb };
      },
      scenario(s) {
        if (!ScenarioApi) throw new Error('The scenario service is not loaded.');
        api.pause(); const start = frame;
        const result = ScenarioApi.run(core, s, { onFrame: () => { frame = core.frameNumber(); keyframe(); } });
        const list = StartApi.unrle(s.inputs); for (let i = 0; i < result.frames; i++) record(start + i, { p01: list[i][0], p23: list[i][1] });
        frame = core.frameNumber(); show(); return result;
      },
      rewind(n) {
        api.pause();
        const target = Math.max(0, frame - n), base = [...keys.keys()].filter(f => f <= target).sort((a, b) => b - a)[0];
        if (base === undefined) throw new Error('Nothing to rewind to: the oldest kept moment is later.');
        restoreKey(base);
        while (frame < target) { if (!runOne({ p01: log[2 * frame], p23: log[2 * frame + 1] }, frame === target - 1, false)) break; }
        if (frame === base) core.render();
        show(); return frame;
      },
      replay(n) {                                                       /* forward on the recorded inputs */
        api.pause();
        const end = Math.min(logEnd, frame + n);
        while (frame < end) if (!runOne({ p01: log[2 * frame], p23: log[2 * frame + 1] }, frame === end - 1, false)) break;
        show(); return frame;
      },
      save() { const b = core.save(),inspection=core.saveInspection(); return { bytes: b.buffer, inspection:inspection?.buffer, frame }; },
      load(o) { api.pause();core.restore(new Uint8Array(o.bytes));if(o.inspection)core.restoreInspection(new Uint8Array(o.inspection)); frame = core.frameNumber(); logEnd = frame; clearKeys(); keyframe(true); core.render(); show(); return frame; },
      hash() { return { ram: core.hashRam(), state: core.hashState(), frame }; },
      meters() { return core.meters(); },
      peek(o) { if(!Number.isSafeInteger(o.addr)||!Number.isSafeInteger(o.length)||o.addr<0x02000000||o.length<0||o.addr+o.length>0x02080000)throw new Error('Peek range is outside main RAM');const ram = core.ram(), off = o.addr - 0x02000000; return Array.from(ram.subarray(off, off + o.length)); },
      /* Explicit authoring fixtures, available only to opted-in isolated machines. A fixture starts a
         new replay history: input-only rewind must never silently replay across unrecorded RAM writes. */
      fixture(o) {
        if (!allowFixtures) throw new Error('Authoring fixtures are disabled for this machine.');
        if (!Array.isArray(o.steps) || !o.steps.length || o.steps.length > 2000) throw new Error('Invalid fixture length.');
        for (const s of o.steps) {
          if (!Array.isArray(s.input) || s.input.length !== 2 || s.input.some(v => !Number.isInteger(v) || v < 0 || v > 0xffffffff)) throw new Error('Invalid fixture input.');
          if (s.writes && (!Array.isArray(s.writes) || s.writes.length > 256 || s.writes.some(w => !Array.isArray(w) || w.length !== 2 || !Number.isInteger(w[0]) || w[0] < 0x02000000 || w[0] >= 0x02080000 || !Number.isInteger(w[1]) || w[1] < 0 || w[1] > 255))) throw new Error('Fixture write is outside main RAM or byte range.');
        }
        api.pause(); input = {p01:0,p23:0}; clearKeys();
        try {
          for (const s of o.steps) {
            const ram = core.ram(); for (const [addr, value] of s.writes || []) ram[addr - 0x02000000] = value;
            const fault = core.frame(s.input[0], s.input[1], 0); frame++;
            if (fault) throw new Error('The authoring fixture stopped at CPU fault ' + fault + '.');
          }
        } finally { logEnd = frame; keyframe(true); core.render(); show(); }
        return {frame,ram:core.hashRam(),state:core.hashState()};
      },
      eeprom() { return Array.from(core.eeprom()); },
      frameNumber() { return frame; },
      /* the inputs of frames [from, to) as [[p01, p23], ...] (what live play, run and replay recorded) */
      inputLog(o) { const out = [], to = Math.min(o.to, logEnd); for (let f = o.from; f < to; f++) out.push([log[2 * f], log[2 * f + 1]]); return out; },
      inputNow() { return input; },
      perf(reset) { const out = { ...perf, wall: performance.now() - perf.since, msPerFrame: perf.frames ? perf.ms / perf.frames : 0 }; if (reset) Object.assign(perf, { frames: 0, ms: 0, worstTick: 0, worstGap: 0, ticks: 0, since: performance.now() }); return out; },
      audioPort(o) { port = o.port; port.onmessage = (e) => {if(e.data.recycle){if(audioPool.length<32)audioPool.push(new Float32Array(e.data.recycle));return;} if(e.data.epoch!==audioEpoch)return;played = e.data.played; if (playing && soundOn && speed === 1) tick(); }; resetAudio(); return true; },
      sound(on) { if(soundOn!==!!on){soundOn = !!on;resetAudio();} return soundOn; },
      audioBuffer(n) { if(!Number.isInteger(n)||n<2||n>16)throw new Error('Audio buffer must be 2 to 16 native frames');bufferFrames=n;resetAudio();return n; },
      clock() { return {frame,t:performance.now(),queued:queued-played,epoch:audioEpoch}; },
      keyLimit(n) { if(!Number.isSafeInteger(n)||n<60||n>36000)throw new Error('Rewind history must be 60 to 36000 frames');keyLimit = n; return n; },
    };
    self.onmessage = async (e) => {
      if(e.data.recycle){if(framePool.length<16)framePool.push(new Uint8ClampedArray(e.data.recycle));return;}
      const { id, name, args } = e.data;
      try { const value = await api[name](...(args || [])); self.postMessage({ id, value }, value && value.bytes ? [value.bytes] : []); }
      catch (err) { self.postMessage({ id, error: err && err.message || String(err) }); }
    };
  }

  /* ---------------------------------------------------------------- audio worklet (stringified) -- */
  function workletMain() {
    class Cps3Out extends AudioWorkletProcessor {
      constructor() {
        super();
        this.q = []; this.at = 0; this.played = 0; this.since = 0; this.under = 0; this.worker = null; this.epoch=0; this.active=false; this.started=false;
        this.port.onmessage = (e) => {
          if (e.data && e.data.port) { this.worker = e.data.port; this.worker.onmessage = ({data:m}) => {if(m.reset!=null){this.epoch=m.reset;this.active=m.active;this.prime=m.prime;this.started=false;for(const samples of this.q)this.recycle(samples);this.q=[];this.at=this.played=0;}else if(m.epoch===this.epoch&&this.active)this.q.push(m.samples);}; }
          
        };
      }
      recycle(samples) {const buffer=samples.buffer;this.worker.postMessage({recycle:buffer},[buffer]);}
      process(inputs, outputs) {
        const out = outputs[0], L = out[0], R = out[1] || out[0];
        if(this.active&&!this.started&&this.q.reduce((n,c)=>n+c.length/2,0)>=this.prime)this.started=true;
        for (let i = 0; i < L.length; i++) {
          if(!this.active||!this.started){L[i]=R[i]=0;continue;}
          while (this.q.length && this.at >= this.q[0].length) { this.recycle(this.q.shift()); this.at = 0; }
          if (!this.q.length) { L[i] = R[i] = 0; if(this.active)this.under++; continue; }
          const c = this.q[0]; L[i] = c[this.at]; R[i] = c[this.at + 1]; this.at += 2; this.played++;
        }
        this.since += L.length;
        if (this.worker) this.worker.postMessage({ played: this.played, epoch:this.epoch });                 /* every block: the worker's view of the queue stays fresh */
        if (this.since >= 512) { this.since = 0; this.port.postMessage({ played: this.played, epoch:this.epoch, active:this.active, started:this.started, underruns: this.under, queued: this.q.reduce((n, c) => n + c.length / 2, 0) - this.at / 2 }); }
        return true;
      }
    }
    registerProcessor('cps3-out', Cps3Out);
  }

  const blobUrl = (text) => URL.createObjectURL(new Blob([text], { type: 'text/javascript' }));
  function b64(text) { const s = atob(text), out = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i); return out; }

  async function create(o) {
    if (!g.Cps3GameWasm || !g.Cps3GameCore) throw new Error('The game engine scripts are not loaded.');
    if (!g.Cps3GameStart) throw new Error('The game start script (start.js) is not loaded.');
    const scenarioFactory = g.CPS3Scenarios ? g.CPS3Scenarios.factory.toString() : '() => null';
    const src = `const CoreApi = (${g.Cps3GameCore.factory.toString()})();\nconst StartApi = (${g.Cps3GameStart.factory.toString()})(CoreApi);\nconst ScenarioApi = (${scenarioFactory})(StartApi);\n(${workerMain.toString()})(self, CoreApi, StartApi, ScenarioApi);`;
    const worker = new Worker(blobUrl(src));
    let seq = 0; const waiting = new Map();
    const game = { worker, frame: 0, meters: null, onFrame: null, onFault: null, audio: null, playing: false, rate: 1 };
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'frame') { game.frame = m.frame; game.meters = m.meters; const frame={rgba:new Uint8ClampedArray(m.rgba),frame:m.frame,meters:m.meters,audioClock:m.audioClock};if (game.onFrame) game.onFrame(frame);else game.releaseFrame(frame); return; }
      if (m.type === 'fault') { game.playing = false; if (game.onFault) game.onFault(m); return; }
      const w = waiting.get(m.id); if (!w) return; waiting.delete(m.id);
      if (m.error) w.reject(new Error(m.error)); else w.resolve(m.value);
    };
    worker.onerror = (e) => { for (const w of waiting.values()) w.reject(new Error(e.message || 'The engine stopped.')); waiting.clear(); };
    game.releaseFrame = p => {const buffer=p.rgba?.buffer;if(buffer?.byteLength)worker.postMessage({recycle:buffer},[buffer]);};
    game.call = (name, ...args) => new Promise((resolve, reject) => {
      const id = ++seq; waiting.set(id, { resolve, reject });
      const transfer = []; for (const a of args) if (a && a.port instanceof MessagePort) transfer.push(a.port);
      worker.postMessage({ id, name, args }, transfer);
    });
    const copy = (b) => b.slice().buffer;
    await game.call('init', { wasm: b64(g.Cps3GameWasm.base64), program: copy(o.program), bios: copy(o.bios), data: copy(o.data), biosDip: o.biosDip, allowFixtures:o.allowFixtures });
    game.bufferFrames=o.audioBufferFrames||12;await game.call('audioBuffer',game.bufferFrames);
    game.audioBuffer=n=>game.call('audioBuffer',n).then(v=>game.bufferFrames=v);
    game.frameDue=p=>!game.playing||game.rate!==1||!p.audioClock||!game.audioStats?.active||p.audioClock.epoch!==game.audioStats.epoch||p.audioClock.end<=game.audioStats.played+626;
    /* eeprom: a settings block (an Infinite mode's .nv payload) or none (a blank chip: the game writes its
       factory settings itself). freePlay / mode change the block the game would use, as its own service menu does. */
    game.coldBoot = (c = {}) => {game.playing=false;return game.call('cold', { eeprom: c.eeprom || null, prepare: (c.freePlay || c.mode != null) ? { freePlay: !!c.freePlay, mode: c.mode == null ? null : c.mode, modeOffsets: c.modeOffsets || [] } : null });};
    game.inspectPixel = async(x,y) => {await game.pause();return game.call('inspectPixel',x,y);};
    game.loadFbneo = (raw) => {game.playing=false;return game.call('loadFbneo', { raw });};
    /* c: the coldBoot settings plus { key, cache: { get(key) -> record|null, set(key, record) }, recipe }. A cached
       snapshot whose facts fail (it should never happen: the key covers every image) is dropped and remade. */
    game.readyStart = async (c = {}) => {
      game.playing=false;
      const recipe = c.recipe || g.Cps3GameStart.RECIPES['ready-select'];
      const base = { eeprom: c.eeprom || null, prepare: (c.freePlay || c.mode != null) ? { freePlay: !!c.freePlay, mode: c.mode == null ? null : c.mode, modeOffsets: c.modeOffsets || [] } : null };
      const t = performance.now();
      const cached = c.cache && c.key ? await Promise.resolve(c.cache.get(c.key)).catch(() => null) : null;
      let r = null;
      if (cached && cached.bytes) { r = await game.call('ready', Object.assign({}, base, { snapshot: cached.bytes.slice().buffer,inspection:cached.inspection?.slice().buffer })).catch(() => null); if (r && (!r.facts.ok || (cached.state && r.state !== cached.state))) r = null; }
      if (!r) {
        r = await game.call('ready', Object.assign({}, base, { frames: g.Cps3GameStart.inputs(recipe) }));
        if (r.bytes && c.cache && c.key) await Promise.resolve(c.cache.set(c.key, { bytes: new Uint8Array(r.bytes), inspection:r.inspection?new Uint8Array(r.inspection):null,state: r.state, recipe: recipe.id + ':' + recipe.version, at: Date.now() })).catch(() => {});
        r.cached = false;
      } else r.cached = true;
      delete r.bytes;delete r.inspection; r.totalMs = performance.now() - t; game.start = { recipe: recipe.id, frame: r.frame, state: r.state };
      return r;
    };
    game.play = () => { game.playing = true; return game.call('play'); };
    game.pause = () => { game.playing = false; return game.call('pause'); };
    game.step = (n = 1) => game.call('step', n);
    game.speed = (x) => { game.rate = x; return game.call('speed', x); };
    game.input = (w) => game.call('input', w);
    game.run = (opts) => game.call('run', opts);
    game.scenario = (scenario) => { game.playing = false; return game.call('scenario', scenario); };
    game.rewind = (n) => {game.playing=false;return game.call('rewind', n);};
    game.replay = (n) => {game.playing=false;return game.call('replay', n);};
    game.save = () => game.call('save').then((v) => ({ bytes: new Uint8Array(v.bytes), inspection:v.inspection?new Uint8Array(v.inspection):null, frame: v.frame }));
    game.load = (bytes,inspection) => {game.playing=false;return game.call('load', { bytes: bytes.slice().buffer,inspection:inspection?.slice().buffer });};
    game.hash = () => game.call('hash');
    game.peek = (addr, length) => game.call('peek', { addr, length });
    game.sound = async (on) => {
      if (on && !game.audio) {
        const ctx = new AudioContext({ sampleRate: Math.round(CHIP_RATE), latencyHint: 'interactive' });
        /* file: pages may not load a worklet from a blob: URL; a data: URL is allowed */
        const code = `(${workletMain.toString()})();`;
        try { await ctx.audioWorklet.addModule('data:text/javascript;base64,' + btoa(unescape(encodeURIComponent(code)))); }
        catch (e) { await ctx.audioWorklet.addModule(blobUrl(code)); }
        const node = new AudioWorkletNode(ctx, 'cps3-out', { numberOfInputs: 0, outputChannelCount: [2] });
        node.connect(ctx.destination);
        const ch = new MessageChannel();
        node.port.postMessage({ port: ch.port1 }, [ch.port1]);
        node.port.onmessage = (e) => { game.audioStats = e.data; };
        await game.call('audioPort', { port: ch.port2 });
        game.audio = { ctx, node };
      }
      if (!game.audio) return game.call('sound', false);
      const ctx = game.audio.ctx;
      /* the audio clock paces the machine only while the context really runs (a page without a click may keep it suspended) */
      ctx.onstatechange = () => game.call('sound', game.audio.want && ctx.state === 'running');
      game.audio.want = !!on;
      if (on) ctx.resume().catch(() => {}); else ctx.suspend().catch(() => {});
      return game.call('sound', !!on && ctx.state === 'running');
    };
    game.destroy = () => { worker.terminate(); if (game.audio) game.audio.ctx.close(); };
    return game;
  }

  g.Cps3Game = { create, FPS, CHIP_RATE };
})(typeof window !== 'undefined' ? window : globalThis);
