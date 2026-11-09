/* View packages register themselves before boot. This file owns only the shared frame. */
(function (g) {
  'use strict';
  const S = g.Studio, K = g.Kit, el = K.el, $ = id => document.getElementById(id), T = S.transport;
  const names = ['compose', 'mix', 'sounds', 'library', 'deliver']; let mounted = null, ready = false;
  const empty = { compose: ['Nothing here yet.', 'Start a song, open a project or choose an instrument to begin.'], mix: ['Make room for every part.', 'Add parts in Compose to begin balancing your song.'], sounds: ['The game is your instrument.', 'Choose from the game’s sounds or build an instrument of your own.'], library: ['A place to start.', 'Explore Capcom’s music, open a project or start a new song.'], deliver: ['Give your music to the game.', 'Write a song, then export audio, a project or a song file.'] };
  function action(id, title, hint, icon, keys, run) { K.action({ id, title, hint, icon, keys, group: 'Music', enabled: () => ready, run }); }
  action('music.play', 'Play / pause', 'Play from the playhead, or stop where you are.', 'play', 'Space', () => T.toggle());
  action('music.start', 'Play from the start', 'Start playing at the beginning of the song.', 'play', 'Enter', () => T.play({ tick: T.cycle ? T.cycle.from : 0 }));
  action('music.stop', 'Stop', 'Stop playback and keep the playhead here.', 'stop', '', () => T.stop());
  action('music.rewind', 'Rewind', 'Return to the beginning of the song.', 'start', '', () => T.jump(0));
  action('music.cycle', 'Cycle', 'Repeat the selected range while you work.', 'loop', 'L', async () => { T.setCycle(T.cycle ? null : S.state.selection.range || { from: 0, to: S.state.project.bars * 192 }); if (T.playing) await T.play(); renderTransport(); });
  action('music.undo', 'Undo', 'Undo the last change to the song.', 'undo', 'Ctrl Z', () => S.state.undo());
  action('music.redo', 'Redo', 'Restore the last undone change.', 'redo', 'Ctrl Y, Ctrl Shift Z', () => S.state.redo());
  action('music.save', 'Save project', 'Save an editable project file and a local version.', 'save', 'Ctrl S', async () => { await S.state.save(); K.download(S.state.project.name + '.sf3project.json', JSON.stringify(S.state.project, null, 2), 'application/json'); });
  action('music.new', 'New song', 'Start an empty song; your current song is saved locally.', 'plus', '', async () => { await S.state.save(); T.stop(); S.state.newProject(); S.showView('compose'); });
  action('music.open', 'Open file', 'Open a MIDI, project, song or text score.', 'folder', 'Ctrl O', async () => { const file = await K.pickFile('.mid,.midi,.sf3project.json,.sf3song.json,.sf3score'); if (file) { await S.state.open(file); S.showView('compose'); } });
  S.showView = function (id) {
    if (mounted && mounted.unmount) mounted.unmount(); mounted = null;
    S.activeView = id; const root = $('workspace'); root.replaceChildren();
    document.querySelectorAll('[data-view]').forEach(b => b.classList.toggle('on', b.dataset.view === (id === 'designer' ? 'sounds' : id)));
    const view = S.views.get(id);
    if (view) { let content = root; if (id === 'compose' && S.state.project.ui.readOnly) { content = el('div.original-content'); const copy = el('button.btn.primary', { 'data-tip': 'Make an editable copy|Keep the original and start your own version.', onclick: () => S.library.makeCopy() }, 'Make an editable copy'); root.append(el('div.original-banner', null, el('b', null, 'Capcom’s original'), copy), content); root.classList.add('original-workspace'); } else root.classList.remove('original-workspace'); mounted = view; view.mount(content, { state: S.state, transport: T, data: S.data, catalog: S.state.catalog, pack: S.pack, edit: S.edit, on: S.on, studio: S }); }
    else { const text = empty[id] || ['Workspace', 'This workspace is not available yet.']; root.append(el('div.empty.studio-empty', null, K.icon(id), el('b', null, text[0]), el('p', null, text[1]), el('div.hbox', null, button('music.new'), button('music.open')))); }
    K.refresh(true); S.state.emit('view', id);
  };
  function button(id) { return K.bind(el('button.btn', null, K.action.get(id).title), id); }
  let emptyHint = false;
  function renderProject() {
    const p = S.state.project; if (!p) return;
    $('song-name').value = p.name; $('tempo').value = Math.round(p.bpm * 100) / 100; for (const id of ['song-name', 'tempo', 'song-key']) $(id).disabled = !!p.ui.readOnly; $('saved').textContent = S.state.dirty ? 'Saving…' : 'Saved'; $('saved').classList.toggle('good', !S.state.dirty); $('saved').hidden = !p.parts.length || !!p.ui.readOnly;
    $('song-key').textContent = p.key ? ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'][p.key.root] + ' ' + p.key.scale : 'No key';
    try { const b = S.state.build(); $('track-count').textContent = b.report.tracks.length; $('song-size').textContent = K.fmt.bytes(b.bytes.length); $('game-check').textContent = b.report.warnings.length ? `${b.report.warnings.length} issue${b.report.warnings.length === 1 ? '' : 's'}` : 'Game Check'; if (emptyHint) { emptyHint = false; K.status(p.ui.readOnly ? 'Capcom’s original: listen to it, or make an editable copy to change it.' : 'Ready. Space to play · Ctrl K for every command.'); } }
    catch (e) { $('track-count').textContent = '0'; $('song-size').textContent = '0 B'; $('game-check').textContent = 'Game Check'; if (p.parts.length) K.status(e.message); else { emptyHint = true; K.status('Add a part to begin.'); } }
  }
  function renderTransport() { $('position').textContent = K.fmt.pos(T.position); $('cycle').classList.toggle('on', !!T.cycle); $('mono').classList.toggle('on', !T.stereo); $('stereo').classList.toggle('on', T.stereo); const dl = $('driver-label'), dt = T.catchingUp ? 'Updating the sound…' + (T.catchUp ? ' ' + Math.round(T.catchUp.done * 100) + '%' : '') : 'Driver sfiii3nr1 · ' + (T.stereo ? 'stereo' : 'mono'); if (dl.textContent !== dt) { dl.textContent = dt; dl.dataset.tip = T.catchingUp ? 'Updating the sound|Your change is heard once the game’s driver has replayed the song up to the playing position, so it sounds exactly as in the game. Until then the music you hear goes on as it was.' : 'Sound driver|The game’s own sound driver plays the music, in mono as Fightcade plays it, or in stereo.'; } [...$('voices').children].forEach((b, i) => b.style.setProperty('--v', Math.min(1, T.levels[i] * 3))); }
  async function boot(pack) {
    await S.state.init(pack); ready = true; K.refresh(true);
    const params = new URLSearchParams(location.hash.slice(1));
    if (params.get('demo') === '1') S.state.newProject(S.demo());
    if (params.has('open')) {
      if (!g.SF3Decomp) throw new Error('Opening Capcom’s music is not available yet.');
      const song = S.data.songs.find(x => x.code === Number(params.get('open'))); if (!song) throw new Error('This piece was not found.');
      const project = SF3Decomp.fromGame(song, SF3Data.describe(song)); project.ui = { ...project.ui, readOnly: true, originalCode: song.code }; S.state.newProject(project);
    }
    S.showView(params.get('view') || (params.has('demo') || params.has('open') || params.has('selftest') || params.has('bench') ? 'compose' : 'start')); S.readyMs = performance.now(); renderProject(); renderTransport(); K.status('Ready. Space to play · Ctrl K for every command.');
    if (params.has('selftest')) await S.runTests();
    if (params.has('bench')) await S.runBench();
  }
  async function start() {
    for (const id of names) { const title = id[0].toUpperCase() + id.slice(1); const b = el('button', { 'data-view': id, 'data-tip': `${title}|Open the ${title} workspace.`, onclick: () => ready && S.showView(id) }, K.icon(id), title); $('workspaces').insertBefore(b, $('workspaces').lastElementChild); }
    for (let i = 0; i < 16; i++) $('voices').append(el('i', { class: i >= 12 ? 'fx' : '' }));
    document.querySelectorAll('[data-action]').forEach(b => K.bind(b, b.dataset.action));
    $('song-name').onchange = e => S.edit('Song name', p => { p.name = e.target.value; });
    $('tempo').onchange = e => S.edit('Tempo', p => { p.bpm = K.clamp(Number(e.target.value) || 120, 30, 300); });
    $('mono').onclick = () => T.setStereo(false); $('stereo').onclick = () => T.setStereo(true); $('master').oninput = e => T.setVolume(e.target.value / 100);
    $('song-key').onclick = async () => { const root = el('select.field', { 'aria-label': 'Root note' }, ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'].map((n, i) => el('option', { value: i }, n))); const scale = el('select.field', { 'aria-label': 'Scale' }, ['minor', 'major', 'dorian', 'mixolydian', 'chromatic'].map(n => el('option', { value: n }, n))); root.value = S.state.project.key ? S.state.project.key.root : 0; scale.value = S.state.project.key ? S.state.project.key.scale : 'minor'; if (await K.dialog({ title: 'Song key', body: el('div.hbox', null, root, scale), buttons: [{ label: 'Cancel', value: false }, { label: 'Apply', primary: true, value: true }] })) S.edit('Song key', p => { p.key = { root: Number(root.value), scale: scale.value }; }); };
    $('game-check').onclick = () => K.run('mix.check');
    S.state.on('project', renderProject); S.state.on('saved', renderProject); S.state.on('transport', renderTransport);
    window.addEventListener('dragover', e => e.preventDefault()); window.addEventListener('drop', async e => { e.preventDefault(); try { const files = [...e.dataTransfer.files]; if (files.some(f => /\.zip$/i.test(f.name))) await boot(await CPS3Studio.importZips(files)); else { for (const f of files) await S.state.open(f); S.showView('compose'); } } catch (error) { K.toast(error.message, { kind: 'bad' }); } });
    CPS3Studio.register({ id: 'music', title: 'Music', icon: 'note', fallback: 'original', fallbackNote: 'Music uses the original game’s sounds.', mount() {}, unmount() { T.stop(); } }); CPS3Studio.mount($('studio-app'));
    const pack = await CPS3Studio.loadPack(); if (pack) await boot(pack); else { K.status(''); CPS3Studio.welcome($('workspace'), boot); }
  }
  document.addEventListener('DOMContentLoaded', () => start().catch(e => { K.status(e.message); if (location.hash.includes('selftest')) { const out = el('pre', { id: 'selftest' }, `FAIL boot: ${e.stack}\nselftest: 0 checks, 1 failures`); document.body.append(out); } else K.toast(e.message, { kind: 'bad' }); }));
})(window);
