/* Character projects use the normal Art entry point and Studio module navigation. */
window.ArtCharacterStart = async function () {
  const requested = new URLSearchParams(location.search).get('character');
  const config = await CPS3CharacterProjects.selected();
  if (!config) {
    if (requested) throw new Error('This character project is unavailable. Open Studio with its local workspace launcher.');
    return false;
  }
  const root = document.getElementById('studio-app');
  document.body.classList.add('character-project');
  root.innerHTML = ArtCharacterView;
  document.getElementById('character-title').textContent = config.title;
  document.title = config.title + ' · CPS3 Studio';
  CPS3Studio.register({id: 'art_editor', title: 'Art', icon: 'grid', mount() {}, unmount() {}});
  CPS3Studio.mount(root, {characterProject: true});
  if (config.effects) {
    const url = new URL(config.effects, location.href);
    if (url.origin !== location.origin || !url.pathname.startsWith(config.api + '/')) throw new Error('Invalid project effects location.');
    await new Promise((resolve, reject) => {
      const script = document.createElement('script'); script.src = url.href;
      script.onload = resolve; script.onerror = () => reject(new Error('Project effects could not load.'));
      document.head.append(script);
    });
  }
  const workspace = ArtCharacterWorkspace(config);
  ArtCharacterTimelineMount();
  CPS3Studio.navigationGuard = async () => {
    if (ArtCharacterTimeline.busy) { workspace.message('Wait for the animation save to finish.', true); return false; }
    const saved = await workspace.saveAll();
    if (!saved) workspace.message('Your drawing changes are still unsaved. Save or export them before leaving.', true);
    return saved;
  };
  document.getElementById('character-projects').onclick = async event => {
    const anchor = event.currentTarget;
    const registry = await CPS3CharacterProjects.list();
    Kit.menu(anchor, [
      {heading: 'Character projects'},
      ...registry.projects.map(project => ({label: project.title, run: () => CPS3Studio.navigate(CPS3CharacterProjects.url(project.id))})),
      '-', {label: 'Browse ROM artwork', run: () => CPS3Studio.navigate('index.html?rom=1')}
    ]);
  };
  document.getElementById('character-backup').onclick = async () => {
    if (!await CPS3Studio.navigationGuard()) return;
    try {
      const response = await fetch(config.api + '/export');
      if (!response.ok) throw new Error((await response.json()).error || 'Backup export failed');
      Kit.download(config.id + '.cps3character.zip', new Uint8Array(await response.arrayBuffer()), 'application/zip');
      workspace.message('Project backup exported: drawings, sequence plans and project metadata.');
    } catch (error) { workspace.message(error.message, true); }
  };
  await workspace.ready;
  if (!workspace.editor) throw new Error('Character project did not open. ' + document.getElementById('message').textContent);
  CPS3CharacterProjects.remember(config.id);
  ArtStudio.ready = true;
  ArtStudio.characterProject = workspace;
  Object.defineProperty(ArtStudio, 'editor', {configurable: true, get: () => workspace.editor});
  return true;
};
