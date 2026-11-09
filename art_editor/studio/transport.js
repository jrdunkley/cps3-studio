/* Linear prefixes are timed in real game frames; command paths are never invented. */
(function (g) {
  'use strict'; const A = g.ArtStudio;
  const T = A.transport = { frames: [], rate: 59.59949, speed: 1, index: 0, tick: 0, playing: false, loop: false, complete: false };
  let raf = 0, start = 0, from = 0;
  T.frameAt = (ticks, loop = T.loop, frames = T.frames) => { const hold=frames.findIndex(f=>f.hold),finite=hold<0?frames:frames.slice(0,hold),total=finite.reduce((s,f)=>s+f.duration,0);if(hold>=0&&ticks>=total)return hold;if(!total)return 0;let t=loop&&hold<0?((ticks%total)+total)%total:Math.min(total-1,Math.max(0,ticks));for(let i=0;i<finite.length;i++){t-=finite[i].duration;if(t<0)return i;}return finite.length-1; };
  T.set = timeline => { T.stop(); T.frames = timeline.frames; T.complete = timeline.complete; T.rate = timeline.rate; T.index = T.tick = 0; T.loop = !!timeline.complete; A.state.emit('transport', T); };
  T.advance = milliseconds => { T.tick = Math.floor(from + milliseconds * T.rate * T.speed / 1000); T.index = T.frameAt(T.tick); const total = T.frames.reduce((s, f) => s + f.duration, 0);if(T.frames[T.index]?.hold){T.tick=T.frames.slice(0,T.index).reduce((s,f)=>s+f.duration,0);T.playing=false;}else if (!T.loop && T.tick >= total) { T.tick = Math.max(0, total - 1); T.playing = false; } A.state.emit('transport', T); };
  function step(now) { if (!T.playing) return; T.advance(now - start); if (T.playing) raf = requestAnimationFrame(step); }
  T.play = () => { if (!T.frames.length) return; from = T.tick; start = performance.now(); T.playing = true; A.state.emit('transport', T); raf = requestAnimationFrame(step); };
  T.stop = () => { cancelAnimationFrame(raf); T.playing = false; A.state.emit('transport', T); };
  T.toggle = () => T.playing ? T.stop() : T.play();
  /* a viewing aid only: 1 is the game's own timing (one duration tick per arcade frame); playing on keeps the current tick */
  T.setSpeed = x => { if (![1, 0.5, 0.25].includes(x)) return; if (T.playing) { from = T.tick; start = performance.now(); } T.speed = x; A.state.emit('transport', T); };
  T.jump = i => { T.stop(); T.index = Math.max(0, Math.min(T.frames.length - 1, i)); T.tick = T.frames.slice(0, T.index).reduce((s, f) => s + f.duration, 0); A.state.emit('transport', T); };
  T.step = n => T.jump(Math.max(0, Math.min(T.frames.length - 1, T.index + n)));
})(window);
