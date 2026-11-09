/* Studio checks register from their own files; no sound or user project is changed by this runner. */
(function (g) {
  'use strict';
  const S = g.Studio = g.Studio || {}, checks = [];
  S.test = (group, name, fn) => checks.push({ group, name, fn });
  S.assert = (ok, message) => { if (!ok) throw new Error(message || 'Assertion failed'); };
  S.runTests = async function () {
    const out = document.createElement('pre'); out.id = 'selftest'; document.body.append(out);
    let failures = 0;
    for (const c of checks) {
      try { if (await c.fn() === false) throw new Error('returned false'); out.textContent += `PASS ${c.group}: ${c.name}\n`; }
      catch (e) { failures++; out.textContent += `FAIL ${c.group}: ${c.name}: ${e.stack || e}\n`; }
    }
    if (checks.length < 60) { failures++; out.textContent += 'FAIL runner: at least 60 checks ran\n'; }
    else out.textContent += 'PASS runner: at least 60 checks ran\n';
    out.textContent += `selftest: ${checks.length + 1} checks, ${failures} failures`;
    S.transport.stop(); return { checks: checks.length + 1, failures };
  };
  const a = S.assert, fixture = () => S.demo();
  S.test('boot', 'play control enables when sounds are ready', () => a(!document.querySelector('[data-action="music.play"]').disabled));
  S.test('boot', 'ROM has 49 pieces and 733 samples', () => a(S.data.songs.length === 49 && S.data.samples.length === 733));
  S.test('boot', 'catalog has 59 music instruments', () => a(Object.values(S.state.catalog.programs).filter(p => p.bank === 0).length === 59));
  S.test('state', 'new project normalises and builds', () => { S.state.newProject(fixture()); const b = S.state.build(); a(b.bytes.length > 33 && b.report.tracks.length > 0); });
  S.test('state', 'unchanged revision reuses the build', () => a(S.state.build() === S.state.build()));
  S.test('state', 'undo and redo restore exact JSON', () => {
    const before = JSON.stringify(S.state.project); S.edit('Test notes', p => p.parts[0].notes.push({ t: 48, n: 64, v: 90, len: 12 }));
    const after = JSON.stringify(S.state.project); a(before !== after); S.state.undo(); a(JSON.stringify(S.state.project) === before); S.state.redo(); a(JSON.stringify(S.state.project) === after);
  });
  S.test('state', 'failed edit leaves project and history intact', () => { const before = JSON.stringify(S.state.project); try { S.edit('Fail', p => { p.name = 'broken'; throw new Error('expected'); }); } catch (_) {} a(JSON.stringify(S.state.project) === before); });
  S.test('state', 'selection emits its own event', () => { let seen = false; const off = S.state.on('selection', () => { seen = true; }); S.state.select({ partId: S.state.project.parts[0].id }); off(); a(seen); });
  S.test('state', 'autosave reload preserves project', async () => { const before = JSON.stringify(S.state.project); await S.state.save(); await S.state.restore(); a(JSON.stringify(S.state.project) === before && !S.state.dirty); });
  S.test('transport', 'silent play advances the actual driver', async () => { await S.transport.play({ silent: true, tick: 0 }); const f = S.transport.engine.frame; S.transport.advance(120); a(S.transport.engine.frame === f + 120 && S.transport.position > 0 && S.transport.engine.key !== 0); });
  S.test('transport', 'tempo edit reaches the running driver', async () => { S.edit('Tempo test', p => { p.bpm = 144; }); await S.transport.refresh(); a(S.transport.engine.tempo() === SF3Seq.bpmToTempo(144)); });
  S.test('transport', 'mute and solo use the mixer mask', async () => { S.edit('Mute test', p => { p.parts[0].mute = true; }); await S.transport.refresh(); const tracks = S.state.build().report.partTracks[S.state.project.parts[0].id]; a(tracks.every(t => S.transport.engine.mute & (1 << t))); S.edit('Solo test', p => { p.parts[0].mute = false; p.parts[0].solo = true; }); await S.transport.refresh(); a(tracks.every(t => !(S.transport.engine.mute & (1 << t)))); a(S.transport.engine.mute !== 0); S.edit('Clear solo', p => { p.parts[0].solo = false; }); });
  S.test('transport', 'cycle builds the requested range', async () => { S.transport.setCycle({ from: 192, to: 576 }); await S.transport.play({ silent: true, tick: 192 }); a(S.transport.built.bytes.every((v, i) => v === S.state.build({ range: { from: 192, to: 576 } }).bytes[i])); S.transport.advance(400); a(S.transport.position >= 192 && S.transport.position < 576); });
  S.test('transport', 'structural cycle edit reaches a second engine', async () => { const old = S.transport.engine; S.edit('Cycle notes', p => p.parts[0].notes.push({ t: 240, n: 70, v: 100, len: 18 })); await S.transport.refresh(); a(S.transport.engine !== old); a(S.transport.built.bytes.every((v, i) => v === S.state.build({ range: { from: 192, to: 576 } }).bytes[i])); });
  S.test('transport', 'jump uses saved driver state without changing audio', async () => {
    S.transport.setCycle(null); await S.transport.play({ silent: true, tick: 0 }); S.transport.advance(650); await S.transport.jump(768);
    const engine = S.transport.engine, reference = new SF3Engine.Engine(S.pack, { stereo: engine.stereo }), built = S.state.build();
    reference.patchAt(SF3Engine.CAVE.preview, built.bytes); reference.setRequest(60, SF3Engine.CAVE.preview); reference.request(60);
    for (let i = 0; i < engine.frame; i++) reference.step();
    const audio = engine.render(20), again = reference.render(20); a(audio.length === again.length && audio.every((v, i) => v === again[i]), 'seek differs from uninterrupted playback'); a(S.transport.snapshots.size > 0);
  });
  S.test('transport', 'a long catch-up in the worker leaves the driver exactly as the page would', async () => {
    /* A catch-up longer than a few frames runs in a Worker; its saved state must equal the page's own catch-up,
     * frame for frame, with the same 4-bar snapshots and the same following sound. Bar 7 of the 8-bar demo is 1,300+ frames. */
    const T = S.transport, run = async mode => { T.seekMode(mode); S.state.newProject(fixture()); await T.play({ silent: true, tick: 7 * 192 + 24 }); const e = T.engine, s = e.snapshot(); return { stats: T.seekStats, frame: e.frame, ticks: T.position, s, snaps: [...T.snapshots.keys()].sort((x, y) => x - y).join(), audio: e.render(90) }; };
    const same = (x, y) => x.length === y.length && x.every((v, i) => v === y[i]);
    const before = JSON.parse(JSON.stringify(S.state.project)), at = T.position;
    try {
      T.setCycle(null); const w = await run('auto'), p = await run('page');
      a(w.stats.worker && !p.stats.worker, 'the worker ran the long catch-up and the page ran its own'); a(w.frame === p.frame && w.ticks === p.ticks, `same frame and position (worker ${w.frame} ${w.ticks}, page ${p.frame} ${p.ticks})`);
      for (const k of ['ram', 'regs', 'pos', 'frac']) a(same(w.s[k], p.s[k]), k + ' differs'); a(same(w.s.cpu.r, p.s.cpu.r) && w.s.key === p.s.key && w.s.acc === p.s.acc, 'chip and CPU state');
      a(w.snaps === p.snaps && w.snaps.length > 0, 'same 4-bar snapshots'); a(same(w.audio, p.audio), 'the following sound differs');
    } finally { T.seekMode('auto'); T.stop(); S.state.newProject(before); await T.play({ silent: true, tick: at }); }
  });
  S.test('transport', 'value-only volume edits patch in place', async () => { const engine = S.transport.engine; S.edit('Level test', p => { p.parts[0].volume = 35; }); await S.transport.refresh(); a(S.transport.engine === engine); const tr = S.transport.built.report.partTracks[S.state.project.parts[0].id][0]; a(engine.r8(SF3Engine.CHANNELS + tr * SF3Engine.CHANNEL_SIZE + 98) === 35); });
  S.test('transport', 'stereo switch and master volume work', () => { S.transport.setStereo(true); a(S.transport.engine.stereo); S.transport.setVolume(0.4); a(S.transport.volume === 0.4); S.transport.setStereo(false); });
  S.test('transport', 'stop cancels playback', () => { S.transport.stop(); a(!S.transport.playing); });
  S.test('files', 'song files open their editable project', async () => { const p = fixture(); await S.state.open({ format: 'sf3song', project: p }); a(S.state.project.name === p.name); });
  S.test('plugins', 'external view mounts and unmounts', () => { let mounted = false, unmounted = false; S.view({ id: 'probe', title: 'Probe', icon: 'note', mount(root, ctx) { mounted = !!root && ctx.state === S.state; }, unmount() { unmounted = true; } }); S.showView('probe'); S.showView('compose'); S.views.delete('probe'); a(mounted && unmounted); });
  S.test('plugins', 'every action is described', () => a(Kit.actions().every(x => x.title && x.hint)));
  S.test('shell', 'one module hides the module rail', () => a(CPS3Studio.modules.size === 1 && CPS3Studio.rail.hidden));
  if (typeof module !== 'undefined') { console.log('NOT BUILT YET: run index.html#selftest in the hidden browser'); }
})(typeof window !== 'undefined' ? window : globalThis);
