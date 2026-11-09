/* Delivery checks precede the UI implementation and keep exports entirely in memory. */
(function (g) {
  const S = g.Studio, a = S.assert;
  S.test('deliver', 'WAV export has a valid header and exact byte length', async () => { S.state.newProject(S.demo()); const bytes = await S.deliver.wav({ frames: 60, rate: SF3Audio.CHIP_RATE, stereo: true, fadeSeconds: 0 }); const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); a(String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && v.getUint32(4, true) + 8 === bytes.length); });
  S.test('deliver', 'song file keeps plain bytes and proven compressed bytes', async () => { const file = await S.deliver.songFile(); const plain = SF3Compile.build(S.state.project, { catalog: S.state.catalog }); a(file.sequence_b64 === S.deliver.base64(plain.bytes)); a(file.compressed && file.checks.compressed_sound_identical === true && file.compressed.bytes <= file.bytes); });
  S.test('deliver', 'text score and MIDI round trip retain notes', () => { const p = S.state.project, score = SF3Score.parse(SF3Score.print(p)); a(JSON.stringify(SF3Compile.build(score, { catalog: S.state.catalog }).bytes) === JSON.stringify(SF3Compile.build(p, { catalog: S.state.catalog }).bytes)); const midi = SF3Midi.toProject(SF3Midi.parse(SF3Midi.fromProject(p))); a(midi.parts.reduce((n, p) => n + p.notes.length, 0) === p.parts.reduce((n, p) => n + p.notes.length, 0)); });
  S.test('deliver', 'ROM install uses only documented locations in a private image', async () => { const engine = new SF3Engine.Engine(S.pack), program = new Uint8Array(0x1000000); program.set(engine.rom); const file = await S.deliver.songFile({ compress: false }); const result = await Cps3Rom.install(program, [{ song: file, code: 50 }]); a(result.edits.edits.every(e => Number(e.address) >= SF3Engine.CAVE.preview || Number(e.address) === 0x0678F004 + 50 * 4)); a(result.report.free < 188384 && program[0x7D2000] === 0 && result.program !== program); });
  S.test('deliver', 'a cancelled render releases its job', async () => { const token = { cancelled: true }; let cancelled = false; try { await S.deliver.wav({ frames: 3600 }, token); } catch (e) { cancelled = /cancel/i.test(e.message); } a(cancelled); });
  S.test('deliver', 'exact-loop stems trim their introduction and retain loop points', () => { const samples = Int32Array.from([0, 11, 22, 33, 44, 55]), wav = SF3Audio.wav({ L: samples, R: samples, n: 6, rate: 44100 }, { mono: true, loop: { start: 2, end: 5 } }), trimmed = S.deliver.trimLoop(wav), v = new DataView(trimmed.buffer); a(v.getUint32(40, true) === 6 && v.getInt16(44, true) === 22 && v.getInt16(48, true) === 44 && v.getUint32(4, true) + 8 === trimmed.length && v.getUint32(50 + 52, true) === 0 && v.getUint32(50 + 56, true) === 2); });
})(window);

(function (g) {
  'use strict';
  const S = g.Studio, K = g.Kit, el = K.el, E = SF3Engine.Engine, A = SF3Audio, pause = () => new Promise(r => setTimeout(r, 0));
  const D = S.deliver = { busy: false, progress: 0, program: null }, clone = x => JSON.parse(JSON.stringify(x));
  let root, progress, status, stop, token, off, lastSong;
  const options = { rate: A.CHIP_RATE, stereo: false, loops: 2, fadeSeconds: 8, exactLoop: false, normalise: false, compress: true, code: 50, chorusCode: 51, chorus: false };
  D.base64 = bytes => { let text = ''; for (let i = 0; i < bytes.length; i += 32768) text += String.fromCharCode(...bytes.subarray(i, i + 32768)); return btoa(text); };
  function notify(value, text) { D.progress = value; if (progress) progress.style.setProperty('--v', value); if (status && text) status.textContent = text; }
  async function jobResult(job, cancellation = {}, label = 'Rendering') {
    while (!job.done) { if (cancellation.cancelled) { job.cancel(); throw new Error('Export cancelled.'); } job.advance(12); notify(job.progress, `${label} · ${Math.round(job.progress * 100)}%`); if (!job.done) await pause(); }
    return job.result;
  }
  function build(project = S.state.project, compressed = false) { return SF3Compile.build(project, { compress: compressed, catalog: S.state.catalog }); }
  function audioMask(project, built) { const solo = project.parts.some(p => p.solo); let mask = 0; for (const part of project.parts) if (part.mute || solo && !part.solo) for (const track of built.report.partTracks[part.id] || []) mask |= 1 << track; return mask; }
  D.wav = async (opts = {}, cancellation = {}) => {
    const project = clone(S.state.project), built = build(project), settings = A.lengthFor(built, project, { ...options, ...opts, mute: audioMask(project, built) });
    let audio = await jobResult(A.renderJob(E, S.pack, built, settings), cancellation);
    if (cancellation.cancelled) throw new Error('Export cancelled.');
    if (settings.exactLoop && audio.loop) { const start = audio.loop.start, end = audio.loop.end; audio = { ...audio, L: audio.L.slice(start, end), R: audio.R.slice(start, end), n: end - start, loop: { start: 0, end: end - start } }; }
    if (settings.rate !== audio.rate) { notify(0.96, 'Preparing the chosen sample rate…'); await pause(); audio = A.resample(audio, settings.rate); }
    return A.wav(audio, { bits: 16, normalise: !!settings.normalise, mono: !settings.stereo, loop: settings.exactLoop ? audio.loop : undefined });
  };
  D.referenceWav = async code => { const song = S.data.songs.find(s => s.code === code), info = SF3Data.describe(song); const settings = info.loopLength ? { intro: info.loopStart, loopTicks: info.loopLength, loops: 2, fadeSeconds: 8 } : { ticks: Math.max(...info.tracks.map(t => t.end || 0)) + 96 }; const audio = await jobResult(A.renderJob(E, S.pack, code, settings)); return A.wav(audio, { mono: true }); };
  // Audio's stems retain the introduction and mark the loop. The one-loop delivery option
  // slices the already-rendered PCM, retaining the common gain and exact chip samples.
  D.trimLoop = bytes => { const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), size = v.getUint32(40, true), smpl = 44 + size, frame = v.getUint16(32, true); if (smpl + 68 > bytes.length) return bytes; const from = v.getUint32(smpl + 52, true), to = v.getUint32(smpl + 56, true) + 1, n = (to - from) * frame, out = new Uint8Array(44 + n + 68); out.set(bytes.subarray(0, 44)); out.set(bytes.subarray(44 + from * frame, 44 + to * frame), 44); out.set(bytes.subarray(smpl, smpl + 68), 44 + n); const w = new DataView(out.buffer); w.setUint32(4, out.length - 8, true); w.setUint32(40, n, true); w.setUint32(44 + n + 52, 0, true); w.setUint32(44 + n + 56, to - from - 1, true); return out; };
  D.stems = async (opts = {}, cancellation = {}) => { const project = clone(S.state.project), built = S.state.build({ includeMuted: true }), settings = { ...options, ...opts }; settings.mono = !settings.stereo; settings.mute = audioMask(project, built); const files = await jobResult(A.stemsJob(E, S.pack, built, project, settings), cancellation, 'Rendering parts'); return KitZip.write(Object.fromEntries(files.map(f => [f.name, settings.exactLoop ? D.trimLoop(f.bytes) : f.bytes]))); };
  /* Compare the entire introduction and two loop passes in bounded buffers. No giant pair of
   * waveforms, no special songs and no acceptance based only on notes or raw chip writes. */
  D.prove = async (plain, compressed, project, cancellation = {}) => {
    const engines = [plain, compressed].map(b => { const e = new E(S.pack, { stereo: true }); if (b.bank) e.installBank(b.bank); e.patchAt(SF3Engine.CAVE.preview, b.bytes); e.setRequest(60, SF3Engine.CAVE.preview); e.request(60); return e; });
    const target = project.leadIn + (project.loop.on ? project.loop.end + project.loop.end - project.loop.start : project.length || project.bars * 192) + 96;
    const arrays = Array.from({ length: 4 }, () => new Int32Array(4096)); let ticks = 0, frames = 0, started = performance.now();
    while (ticks < target) {
      if (cancellation.cancelled) throw new Error('Export cancelled.'); arrays.forEach(a => a.fill(0)); let left = 0, right = 0;
      for (let i = 0; i < 4; i++) { const tempo = engines[0].tempo() + engines[0].tempoOffsetValue(); left += engines[0].step(arrays[0], arrays[1], left); right += engines[1].step(arrays[2], arrays[3], right); ticks += tempo / 256; frames++; }
      if (left !== right) throw new Error('Compressed playback has a different duration. Export the plain sequence.');
      for (let i = 0; i < left; i++) if (arrays[0][i] !== arrays[2][i] || arrays[1][i] !== arrays[3][i]) throw new Error(`Compressed playback differs near frame ${frames - 4}. Export the plain sequence.`);
      if (frames > 72000) throw new Error('This song is too long to verify in one export. Export its plain sequence.');
      if (performance.now() - started > 12) { notify(Math.min(1, ticks / target), 'Checking compressed playback…'); await pause(); started = performance.now(); }
    }
    return true;
  };
  D.songFile = async (opts = {}, cancellation = {}) => {
    const project = clone(S.state.project), file = SF3Compile.songFile(project, { compress: false, catalog: S.state.catalog });
    if (opts.compress ?? options.compress) { const plain = build(project), compressed = build(project, true); await D.prove(plain, compressed, project, cancellation); file.compressed = { sequence_b64: D.base64(compressed.bytes), bytes: compressed.bytes.length, chorus_safe: true }; file.checks.compressed_sound_identical = true; }
    lastSong = file; return file;
  };
  D.needs = (project = S.state.project) => { let bytes = 0; try { bytes = build(project).bytes.length; } catch (_) {} const out = [`The song (${K.fmt.bytes(bytes)})`]; if (project.chorusBar) out.push(`A chorus entry, because rounds 2+ start at bar ${project.chorusBar}`); if (project.bank) out.push(`Custom instruments (${K.fmt.bytes(SF3Bank.size(project.bank))}) and the instrument table change`); return out; };
  D.brief = () => { const p = S.state.project, b = build(p), ctx = { catalog: S.state.catalog, metrics: S.mix?.measured, targets: S.mix?.targets }; return SF3Analyze.brief(p, b, { ...SF3Analyze.analyze(p, b, ctx), catalog: S.state.catalog }); };
  async function confirmIssues() { if (!g.SF3Analyze) return true; const issues = SF3Analyze.lint(S.state.project, build(), { catalog: S.state.catalog }).filter(i => i.level === 'error'); if (!issues.length) return true; return K.dialog({ title: 'Game Check', text: issues.map(i => i.message).join('\n'), buttons: [{ label: 'Back', value: false }, { label: 'Export anyway', primary: true, value: true }] }); }
  async function work(label, fn) { if (D.busy || !await confirmIssues()) return; D.busy = true; token = { cancelled: false }; if (stop) stop.hidden = false; notify(0, label); try { await fn(token); notify(1, label + ' ready.'); } catch (e) { notify(0, e.message); K.toast(e.message, { kind: 'bad' }); } finally { D.busy = false; if (stop) stop.hidden = true; } }
  const button = (text, hint, fn, primary = false) => el('button.btn', { class: primary ? 'primary' : '', 'data-tip': text + '|' + hint, onclick: fn }, text);
  const select = (label, key, choices) => { const input = el('select.field', { 'aria-label': label, 'data-tip': label + '|Choose ' + label.toLowerCase() + '.', onchange: e => { options[key] = typeof options[key] === 'number' ? Number(e.target.value) : e.target.value === 'true'; } }, choices.map(([value, title]) => el('option', { value: String(value) }, title))); input.value = String(options[key]); return el('label.lab', null, el('span', null, label), input); };
  const number = (label, key, min, max, fn) => el('label.lab', null, el('span', null, label), el('input.field.num', { type: 'number', min, max, value: options[key], 'aria-label': label, 'data-tip': label + '|Choose ' + label.toLowerCase() + '.', onchange: e => { options[key] = K.clamp(Number(e.target.value), min, max); if (fn) fn(options[key]); } }));
  const toggle = (label, key) => { const b = el('button.switch', { class: options[key] ? 'on' : '', role: 'switch', 'aria-checked': options[key], 'aria-label': label, 'data-tip': label + '|Turn ' + label.toLowerCase() + ' on or off.', onclick: () => { options[key] = !options[key]; b.classList.toggle('on', options[key]); b.setAttribute('aria-checked', options[key]); } }); return el('label.lab', null, el('span', null, label), b); };
  function card(title, subtitle, children) { return el('section.panel.deliver-card', null, el('header', null, el('h3', null, title)), el('div.group', null, el('p.hint', null, subtitle), children)); }
  function downloadJson(suffix, value) { K.download(A.safeName(S.state.project.name) + suffix, JSON.stringify(value, null, 2), 'application/json'); }
  async function loadRom() {
    const files = await K.pickFile('.zip,.bin', { multiple: true }); if (!files?.length) return;
    try { if (files.every(f => /\.zip$/i.test(f.name))) { await CPS3Studio.importZips(files, text => notify(0, text)); D.program = CPS3Studio.rom.program; } else if (files.length === 1 && /\.bin$/i.test(files[0].name)) D.program = new Uint8Array(await files[0].arrayBuffer()); else throw new Error('Choose both ROM zips, or one decrypted program image.'); const space = S.musicSpace = Cps3Rom.musicSpace(D.program); const used = new Set(space.pieces.map(p => p.code)), free = Array.from({ length: 46 }, (_, i) => i + 50).filter(i => !used.has(i)); options.code = free[0] || 50; options.chorusCode = free[1] || 51; render(); } catch (e) { K.toast(e.message, { kind: 'bad' }); }
  }
  async function install(cancellation) {
    if (!D.program) throw new Error('Load your ROM zips or a decrypted program image first.');
    const file = await D.songFile({}, cancellation), result = await Cps3Rom.install(D.program, [{ song: file, code: options.code, chorusCode: options.chorus && S.state.project.chorusBar ? options.chorusCode : null }], { catalog: S.state.catalog, compress: options.compress });
    const combined = await combine(result, D.program);
    if (cancellation.cancelled) throw new Error('Export cancelled.'); notify(0.9, 'Preparing patched program files…'); await pause();
    const files = [{ name: 'edits.json', bytes: new TextEncoder().encode(JSON.stringify(result.edits, null, 2)) }, { name: 'report.json', bytes: new TextEncoder().encode(JSON.stringify(result.report, null, 2)) }, ...(combined ? combined.files : Object.entries(Cps3Rom.simms(result.program)).map(([name, bytes]) => ({ name, bytes })))];
    const folder = await K.pickFolder(); if (folder) await K.saveInto(folder, files); else K.download('music-ROM-patch.zip', KitZip.write(Object.fromEntries(files.map(f => [f.name, f.bytes]))), 'application/zip'); notify(1, `Patch ready · ${K.fmt.bytes(result.report.free)} music space remains.`);
  }
  /* Try in game (Game plan §4b B2, hook added by the Game Studio): the same install as Create ROM patch, played by the game
     itself in the Studio's Game page through its own sound test (from the ready start); nothing is written. */
  async function tryInGame(cancellation) {
    const program = D.program || (await CPS3Studio.loadRom() || {}).program;
    if (!program) throw new Error('Load your ROM zips or a decrypted program image first.');
    const space = Cps3Rom.musicSpace(program), used = new Set(space.pieces.map(p => p.code));
    if (used.has(options.code)) throw new Error(`Request ${options.code} already holds a song in this ROM; choose a free request.`);
    const file = await D.songFile({}, cancellation), result = await Cps3Rom.install(program, [{ song: file, code: options.code, chorusCode: options.chorus && S.state.project.chorusBar ? options.chorusCode : null }], { catalog: S.state.catalog, compress: options.compress });
    const combined = await combine(result, program);
    if (cancellation.cancelled) throw new Error('Cancelled.');
    const hex = options.code.toString(16).toUpperCase();
    await CPS3Studio.game.tryImages({ program: combined?.program || result.program, data: combined?.data, label: `Music · ${S.state.project.name} on request ${options.code}`,
      landing: { type: 'sound-test', code: options.code, sound: true, note: `The game’s own sound test plays request ${options.code} (shown as ${hex}); Shot 2 stops it, Shot 1 plays it again.` }, from: location.href });
  }
  D.tryInGame = tryInGame;
  async function combine(result, program) {
    if (!g.CPS3Workspace || location.hash.includes('selftest')) return null;
    await S.state.save(); const rom = await CPS3Studio.loadRom({ graphics: true });
    if (!rom || await Cps3Rom.sha256(program) !== rom.sha256) throw new Error('Select this build as the project’s source before combining changes.');
    return g.CPS3Workspace.stageResult('music', rom, { program: result.program }, { provenance: 'Cps3Rom.install', requests: [options.code] });
  }
  function render() {
    if (!root) return; const p = S.state.project; let plain, small; try { plain = build(); small = build(p, true); } catch (_) {}
    const listen = card('Listen', 'As the game plays it. Rendering uses its own driver, so you can keep listening while exporting.', [select('Sample rate', 'rate', [[A.CHIP_RATE, 'As the chip · 37,287 Hz'], [44100, '44,100 Hz'], [48000, '48,000 Hz']]), select('Monitor', 'stereo', [[false, 'Fightcade · mono'], [true, 'Stereo']]), number('Loop passes', 'loops', 1, 16), number('Fade (seconds)', 'fadeSeconds', 0, 60), toggle('One loop exactly', 'exactLoop'), toggle('Normalise', 'normalise'), el('div.hbox', null, button('Export WAV', 'Render the song to a WAV file.', () => work('WAV', async t => K.download(A.safeName(p.name) + '.wav', await D.wav({}, t), 'audio/wav')), true), button('Export stems', 'Render one WAV per part, including its devices.', () => work('Stems', async t => K.download(A.safeName(p.name) + '_stems.zip', await D.stems({}, t), 'application/zip')))), el('p.hint', null, 'Need an MP3? Convert the WAV with any audio converter.')]);
    const chorus = el('input.field.num', { type: 'number', min: 0, max: p.bars, value: p.chorusBar || 0, 'aria-label': 'Rounds 2+ start at bar', 'data-tip': 'Rounds 2+ start at bar|Zero starts the song from its beginning.', onchange: e => S.edit('Chorus bar', q => { q.chorusBar = Number(e.target.value) || null; }) });
    const game = card('Game', 'The song file always holds a plain copy of your song, and a smaller packed copy once the Studio has checked that it sounds the same.', [el('p.num', null, `Plain ${K.fmt.bytes(plain?.bytes.length || 0)} · compressed ${K.fmt.bytes(small?.bytes.length || 0)}`), toggle('Compress loops', 'compress'), el('label.lab', null, el('span', null, 'Rounds 2+ start at bar'), chorus), el('h3', null, 'What a ROM needs for this song'), el('ul.deliver-needs', null, D.needs().map(line => el('li', null, K.icon('check'), line))), el('p.hint', null, p.bank ? 'The Studio’s installer handles the song, chorus entry and custom instruments you choose.' : 'Uses only the game’s own instruments.'), el('a', { href: 'docs/ROM_GUIDE.md', target: '_blank', 'data-tip': 'ROM guide|Read what the patch changes and how to apply it.' }, 'Read the ROM guide'), el('div.hbox', null, button('Export song file', 'Save a song for a ROM build.', () => work('Song file', async t => downloadJson('.sf3song.json', await D.songFile({}, t))), true), button('Raw bytes', 'Save the compiled sequence bytes.', () => work('Raw bytes', () => K.download(A.safeName(p.name) + '.bin', build(p, options.compress).bytes))), button('Listing', 'Save readable notes and driver commands.', () => work('Listing', () => K.download(A.safeName(p.name) + '_listing.txt', SF3Seq.listing(build(p, options.compress).bytes), 'text/plain'))))]);
    const workCard = card('Work', 'Editable files for musicians and agents. Your project keeps every part, device and lane.', [el('div.deliver-buttons', null, button('Project JSON', 'Save everything you can edit in the Studio.', () => work('Project', () => downloadJson('.sf3project.json', p)), true), button('Text score', 'Save a readable score with every project detail.', () => work('Text score', () => K.download(A.safeName(p.name) + '.sf3score', SF3Score.print(p), 'text/plain'))), button('MIDI', 'Save notes and controls for another music editor.', () => work('MIDI', () => K.download(A.safeName(p.name) + '.mid', SF3Midi.fromProject(p), 'audio/midi'))), button('Copy agent brief', 'Copy structure, instruments and checks for an AI collaborator.', () => work('Agent brief', async () => { const text = D.brief(); try { await navigator.clipboard.writeText(text); } catch (_) { K.dialog({ title: 'Agent brief', body: el('textarea.field', { rows: 18, readOnly: true, value: text }) }); } }))), el('p.hint', null, 'Project and text score keep devices and custom instruments. MIDI carries the played notes and supported controls.')]);
    if (!D.program && CPS3Studio.rom) D.program = CPS3Studio.rom.program;
    let space; try { if (D.program) space = Cps3Rom.musicSpace(D.program); } catch (_) {}
    const rom = card('ROM · advanced', 'Creates patch files for a folder you choose. The installed game is never changed.', [button('Load ROM or program…', 'Choose your ROM zips or a build’s decrypted program image.', loadRom), el('p.num', null, space ? `${K.fmt.bytes(space.used)} used · ${K.fmt.bytes(space.free)} free · ${K.fmt.bytes(space.total)} total` : 'Music space: 188,384 bytes in total'), space?.pieces.length ? el('p.hint', null, 'Already used: ' + space.pieces.map(x => x.code).join(', ')) : el('p.hint', null, 'New songs use request codes 50 to 95. Stage themes remain in place.'), number('Song request', 'code', 50, 95), toggle('Include chorus entry', 'chorus'), number('Chorus request', 'chorusCode', 50, 95), button('Create ROM patch', 'Write exact edits, a placement report and patched program SIMMs.', () => work('ROM patch', install), true), g.CPS3Studio && CPS3Studio.game ? button('Try in game', 'Hear it played by the game itself in the Studio: nothing is written.', () => work('Try in game', tryInGame)) : null]);
    progress = el('span.bar.deliver-progress', { style: { '--v': D.progress } }, el('i')); status = el('span.grow', null, D.busy ? 'Working…' : 'Choose a format to export.'); stop = button('Cancel', 'Stop the current export.', () => { if (token) token.cancelled = true; }); stop.hidden = !D.busy;
    root.replaceChildren(el('div.deliver-grid', null, listen, game, workCard, rom), el('div.deliver-status', null, progress, status, stop));
  }
  S.view({ id: 'deliver', title: 'Deliver', icon: 'deliver', mount(host) { root = el('div.deliver-workspace'); host.append(root); render(); off = S.on('project', render); }, unmount() { off?.(); root = progress = status = stop = null; } });
  K.action({ id: 'deliver.open', title: 'Deliver', hint: 'Export audio, a project or a song for the game.', group: 'Music', run: () => S.showView('deliver') });
})(window);
