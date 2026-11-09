'use strict';
// Preview transport only. Stored game holds remain available with Short holds off.
((root) => {
  function durations(frames, shorten) {
    return frames.map(f => {
      if (Number(f.previewDuration) >= 1) return Math.min(255, Math.floor(f.previewDuration));   // set in the Studio: played as set
      const n = Math.max(1, Number(f.duration) || 1);
      return shorten && n >= 60 ? 12 : n;
    });
  }
  function at(frames, ticks, loop, shorten) {
    const ds = durations(frames, shorten), total = ds.reduce((a,b) => a+b, 0);
    let t = loop ? ((ticks % total) + total) % total : Math.min(Math.max(0,ticks), total-1);
    let index = 0;
    while (index < ds.length-1 && t >= ds[index]) t -= ds[index++];
    return {index, total, ended: !loop && ticks >= total};
  }
  const api = {durations, at};
  if (typeof module !== 'undefined') module.exports = api;
  root.ArtCharacterPlayback = api;
})(typeof window === 'undefined' ? globalThis : window);
