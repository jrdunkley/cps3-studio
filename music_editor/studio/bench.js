/* Reproducible browser budgets. No synthetic audio or substitute compiler. */
(function (g) {
  'use strict';
  const S = g.Studio, now = () => performance.now(), pause = () => new Promise(r => setTimeout(r, 0));
  S.runBench = async function () {
    const saved = JSON.parse(JSON.stringify(S.state.project)), T = S.transport, results = [], out = Kit.el('pre', { id: 'bench' });
    document.body.append(out); T.stop(); S.showView('compose');
    function record(name, value, limit, lower = false, unit = 'ms') { results.push({ name, value: Math.round(value * 100) / 100, limit, unit, pass: lower ? value >= limit : value < limit }); out.textContent = JSON.stringify({ complete: false, results }, null, 2); }
    const timed = async fn => { const start = now(); await fn(); return now() - start; };
    try {
      const p = { format: 'sf3project', version: 2, name: 'Four minutes · 16 tracks', bpm: 160, bars: 160, loop: { start: 0, end: 30720 }, parts: Array.from({ length: 16 }, (_, i) => ({ id: 'bench-' + i, name: 'Part ' + (i + 1), program: 20, bank: 0, voices: 1, volume: 40, expression: 70, notes: Array.from({ length: 640 }, (_, j) => ({ t: j * 48, n: 36 + i, len: 36, v: 70 })) })) };
      record('Page ready, including catalog preparation', S.readyMs, 1500);
      S.state.newProject(p);
      record('Cold jump to bar 160', await timed(() => T.play({ silent: true, tick: 159 * 192 })), 1500);
      results[results.length - 1].seek = T.seekStats;
      record('Saved-state jump to bar 158', await timed(() => T.jump(157 * 192)), 150);
      T.stop(); T.setCycle({ from: 0, to: 192 }); await T.play({ silent: true, tick: 0 });
      record('Cycle edit to rebuilt driver', await timed(async () => { S.edit('Benchmark note', x => { x.parts[0].notes[0].n++; }); await T.refresh(); }), 100);
      T.stop(); T.setCycle(null);
      for (const compress of [false, true]) { const times = []; for (let i = 0; i < 3; i++) { await pause(); times.push(await timed(() => SF3Compile.build(p, { compress, catalog: S.state.catalog }))); } record(compress ? 'Build compressed, median of 3' : 'Build plain, median of 3', times.sort((a, b) => a - b)[1], compress ? 600 : 60); }
      const built = S.state.build(); let audio;
      const renderMs = await timed(() => { audio = SF3Audio.render(SF3Engine, S.pack, built, { frames: 600 }); });
      record('Offline render', audio.n / audio.rate / (renderMs / 1000), 80, true, '× real time');
      S.edit('Dense piano roll', x => { x.parts[0].notes = Array.from({ length: 5000 }, (_, i) => ({ t: i * 6, n: 36 + i % 36, len: 5, v: 70 })); });
      S.state.select({ partId: S.state.project.parts[0].id }); S.roll.fit();
      const paints = []; for (let i = 0; i < 12; i++) { S.roll.focus(i * 192); await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); paints.push(S.roll.paintMs); }
      record('5000-note roll paint, slowest of 12 scrolls', Math.max(...paints), 1000 / 60);
      await T.play({ silent: true, tick: 0 });
      if (performance.memory) record('JS heap while playing', performance.memory.usedJSHeapSize / 1048576, 400, false, 'MB');
      else results.push({ name: 'JS heap', pass: false, note: 'Browser did not expose performance.memory.' });
    } catch (e) { results.push({ name: 'Benchmark execution', pass: false, error: e.stack }); }
    finally { T.stop(); T.setCycle(null); S.state.newProject(saved); S.benchResult = { complete: true, results, failures: results.filter(r => !r.pass).length }; out.textContent = JSON.stringify(S.benchResult, null, 2); }
    return S.benchResult;
  };
})(window);
