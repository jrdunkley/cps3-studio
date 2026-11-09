/* Local character projects are supplied by a loopback workspace, never bundled art. */
(function (g) {
  'use strict';
  const key = 'studio.character.last';
  let available;
  const service = g.CPS3CharacterProjects = {
    async list() {
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname)) return null;
      if (!available) available = fetch('/api/character-projects', {signal: AbortSignal.timeout(3000)})
        .then(async response => response.ok ? response.json() : null).catch(() => null);
      return available;
    },
    /* Palette blocks the local projects offer to Art's Palettes view (a project's own colour file, e.g. an effect's),
       each with { project: { id, title, api, token } }. A project without them answers 400 and is skipped. */
    async palettes() {
      const registry = await service.list();
      if (!registry) return [];
      const out = [];
      for (const project of registry.projects) {
        try {
          const response = await fetch(project.api + '/palettes', {signal: AbortSignal.timeout(10000)});
          if (!response.ok) continue;
          const value = await response.json();
          for (const block of value.blocks || []) out.push({...block, project: {id: project.id, title: project.title, api: project.api, token: value.token}});
        } catch (_) { /* this project offers no palettes */ }
      }
      return out;
    },
    last() { try { return localStorage.getItem(key); } catch (_) { return null; } },
    remember(id) { try { localStorage.setItem(key, id); } catch (_) { /* storage may be unavailable */ } },
    url(id, extra = {}) {
      const url = new URL('../art_editor/index.html', location.href);
      url.searchParams.set('character', id);
      for (const [key, value] of Object.entries(extra)) url.searchParams.set(key, value);
      return url.href;
    },
    async selected() {
      const params = new URLSearchParams(location.search);
      if (params.has('rom') || params.has('projects')) return null;
      const registry = await service.list();
      if (!registry) return null;
      const id = params.get('character') || service.last() || registry.defaultProject;
      return registry.projects.find(project => project.id === id) || null;
    },
    async launcher() {
      const selected = await service.selected();
      if (selected) location.replace(service.url(selected.id));
    }
  };
})(window);
