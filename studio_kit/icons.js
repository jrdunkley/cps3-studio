/* CPS3 Studio kit: the icon set. One 16 x 16 symbol per icon, drawn with a 1.6 px round stroke so they
 * sit with the kit's text. Use: <svg class="ic"><use href="#i-play"/></svg>  (class "solid" for filled ones).
 * Injected into the page once; file:// pages cannot load an external sprite, so it lives here.
 */
(function (g) {
  'use strict';
  const ICONS = {
    /* transport */
    play: '<path d="M5 3.2v9.6L13 8z" fill="currentColor" stroke="none"/>',
    pause: '<path d="M5 3v10M11 3v10" stroke-width="2.4"/>',
    stop: '<rect x="3.5" y="3.5" width="9" height="9" rx="1" fill="currentColor" stroke="none"/>',
    start: '<path d="M3.5 3v10"/><path d="M13 3.5v9L6 8z" fill="currentColor" stroke="none"/>',
    loop: '<path d="M4 6.5V6a2 2 0 0 1 2-2h6.5M10.5 2l2 2-2 2M12 9.5v.5a2 2 0 0 1-2 2H3.5M5.5 14l-2-2 2-2"/>',
    record: '<circle cx="8" cy="8" r="4.5" fill="currentColor" stroke="none"/>',
    metronome: '<path d="M5.5 14h5L9.2 2.5H6.8zM8 11l3.5-6"/>',
    /* tools */
    select: '<path d="M3.5 2.5l8.5 5-3.8 1.2L6.6 13z"/>',
    draw: '<path d="M11.2 2.6l2.2 2.2L5.8 12.4l-3 .8.8-3z"/><path d="M9.8 4l2.2 2.2"/>',
    erase: '<path d="M6.5 13.5h6M3 10.2l6-6.4 3.6 3.4-5.6 6H5.6z"/><path d="M6.2 7l3.4 3.4"/>',
    cut: '<circle cx="4.5" cy="4.5" r="1.8"/><circle cx="4.5" cy="11.5" r="1.8"/><path d="M6 5.6l7.5 5.4M6 10.4L13.5 5"/>',
    snap: '<path d="M3 3v5a5 5 0 0 0 10 0V3h-3v5a2 2 0 0 1-4 0V3z"/><path d="M3 5.5h3M10 5.5h3"/>',
    undo: '<path d="M5.5 3L2.5 6l3 3"/><path d="M3 6h6.5a3.5 3.5 0 0 1 0 7H7"/>',
    redo: '<path d="M10.5 3l3 3-3 3"/><path d="M13 6H6.5a3.5 3.5 0 0 0 0 7H9"/>',
    quantize: '<path d="M2.5 13V3M6.2 13V3M9.9 13V3M13.5 13V3"/><rect x="5" y="6" width="6" height="4" rx="1" fill="currentColor" stroke="none"/>',
    /* general */
    plus: '<path d="M8 3v10M3 8h10"/>',
    minus: '<path d="M3 8h10"/>',
    close: '<path d="M3.5 3.5l9 9M12.5 3.5l-9 9"/>',
    check: '<path d="M3 8.5l3.2 3.2L13 4.5"/>',
    down: '<path d="M4 6l4 4 4-4"/>',
    right: '<path d="M6 4l4 4-4 4"/>',
    more: '<circle cx="3.5" cy="8" r="1.1" fill="currentColor" stroke="none"/><circle cx="8" cy="8" r="1.1" fill="currentColor" stroke="none"/><circle cx="12.5" cy="8" r="1.1" fill="currentColor" stroke="none"/>',
    search: '<circle cx="7" cy="7" r="4"/><path d="M10 10l3.5 3.5"/>',
    settings: '<circle cx="8" cy="8" r="2.2"/><path d="M8 1.8v1.8M8 12.4v1.8M1.8 8h1.8M12.4 8h1.8M3.6 3.6l1.3 1.3M11.1 11.1l1.3 1.3M12.4 3.6l-1.3 1.3M4.9 11.1l-1.3 1.3"/>',
    help: '<circle cx="8" cy="8" r="6"/><path d="M6.2 6.2a1.9 1.9 0 1 1 2.7 1.7c-.6.3-.9.7-.9 1.4"/><circle cx="8" cy="11.4" r=".6" fill="currentColor" stroke="none"/>',
    info: '<circle cx="8" cy="8" r="6"/><path d="M8 7.2v4"/><circle cx="8" cy="4.9" r=".6" fill="currentColor" stroke="none"/>',
    warn: '<path d="M8 2.2l6.2 11H1.8z"/><path d="M8 6.5v3.2"/><circle cx="8" cy="11.4" r=".6" fill="currentColor" stroke="none"/>',
    spark: '<path d="M8 1.8l1.5 4.2 4.2 1.5-4.2 1.5L8 13.2 6.5 9 2.3 7.5 6.5 6z"/>',
    link: '<path d="M6.8 9.2a2.6 2.6 0 0 0 3.7 0l2.2-2.2a2.6 2.6 0 0 0-3.7-3.7l-.8.8M9.2 6.8a2.6 2.6 0 0 0-3.7 0L3.3 9a2.6 2.6 0 0 0 3.7 3.7l.8-.8"/>',
    lock: '<rect x="3.5" y="7" width="9" height="6.5" rx="1.2"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/>',
    folder: '<path d="M2 4.2a1 1 0 0 1 1-1h3l1.4 1.6H13a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z"/>',
    save: '<path d="M3 2.5h8l2.5 2.5v8.5H3z"/><path d="M5.2 2.5v3.6h5V2.5M5.2 13.5V9.6h5.6v3.9"/>',
    export: '<path d="M8 10V2.5M5 5l3-3 3 3"/><path d="M3 9.5v3a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-3"/>',
    import: '<path d="M8 2.5V10M5 7.5l3 3 3-3"/><path d="M3 9.5v3a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-3"/>',
    copy: '<rect x="5.5" y="5.5" width="8" height="8" rx="1.2"/><path d="M10.5 5.5V3.7a1.2 1.2 0 0 0-1.2-1.2H3.7a1.2 1.2 0 0 0-1.2 1.2v5.6a1.2 1.2 0 0 0 1.2 1.2h1.8"/>',
    trash: '<path d="M3 4.5h10M6.2 4.5V3h3.6v1.5M4.3 4.5l.6 9h6.2l.6-9"/>',
    zoomin: '<circle cx="7" cy="7" r="4"/><path d="M10 10l3.5 3.5M5.2 7h3.6M7 5.2v3.6"/>',
    zoomout: '<circle cx="7" cy="7" r="4"/><path d="M10 10l3.5 3.5M5.2 7h3.6"/>',
    /* music */
    compose: '<path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11"/><rect x="4" y="3.3" width="3.2" height="2.4" rx=".6" fill="currentColor" stroke="none"/><rect x="8.5" y="6.8" width="4" height="2.4" rx=".6" fill="currentColor" stroke="none"/><rect x="5.2" y="10.3" width="2.6" height="2.4" rx=".6" fill="currentColor" stroke="none"/>',
    mix: '<path d="M4 2.5v11M8 2.5v11M12 2.5v11"/><rect x="2.6" y="8.5" width="2.8" height="2.4" rx=".6" fill="currentColor" stroke="none"/><rect x="6.6" y="4" width="2.8" height="2.4" rx=".6" fill="currentColor" stroke="none"/><rect x="10.6" y="7" width="2.8" height="2.4" rx=".6" fill="currentColor" stroke="none"/>',
    sounds: '<path d="M1.8 8h1.4M4.6 5.2v5.6M7.2 2.8v10.4M9.8 5.6v4.8M12.4 6.8v2.4M14.2 8h0"/>',
    library: '<path d="M3 2.5v11M6 2.5v11M8.6 3.4l3.4 9.8"/><path d="M2 13.5h12"/>',
    deliver: '<path d="M2.5 8.5l10.5-5-3.4 10-2.2-4.2z"/><path d="M7.4 9.3L13 3.5"/>',
    piano: '<rect x="2" y="3" width="12" height="10" rx="1"/><path d="M5 3v10M8 3v10M11 3v10"/><path d="M4 3v5.5h2V3M7 3v5.5h2V3M10 3v5.5h2V3" fill="currentColor"/>',
    note: '<path d="M6 11.5V3.5l6-1.5v8"/><circle cx="4.4" cy="11.6" r="1.7" fill="currentColor"/><circle cx="10.4" cy="10.1" r="1.7" fill="currentColor"/>',
    drum: '<ellipse cx="8" cy="6" rx="5.5" ry="2.4"/><path d="M2.5 6v4.5c0 1.3 2.5 2.4 5.5 2.4s5.5-1.1 5.5-2.4V6"/>',
    speaker: '<path d="M2.5 6.2h2.3L8 3.5v9L4.8 9.8H2.5z"/><path d="M10.4 5.8a3 3 0 0 1 0 4.4M12.2 4.2a5.4 5.4 0 0 1 0 7.6"/>',
    mono: '<circle cx="8" cy="8" r="5.5"/><circle cx="8" cy="8" r="1.6" fill="currentColor" stroke="none"/>',
    stereo: '<circle cx="5.6" cy="8" r="3.8"/><circle cx="10.4" cy="8" r="3.8"/>',
    echo: '<path d="M2.5 13V6M6 13V3.5" /><path d="M9.5 13V7.5" opacity=".65"/><path d="M13 13v-3" opacity=".35"/>',
    env: '<path d="M1.8 13L4.6 3l2.6 4.5h3.6L13.8 13"/>',
    tune: '<path d="M8 2.5v11"/><path d="M5 5.5c1.8-1.3 4.2-1.3 6 0M3.6 9c2.6-2.2 6.2-2.2 8.8 0" opacity=".7"/>',
    chip: '<rect x="4" y="4" width="8" height="8" rx="1"/><path d="M6 1.8V4M8 1.8V4M10 1.8V4M6 12v2.2M8 12v2.2M10 12v2.2M1.8 6H4M1.8 8H4M1.8 10H4M12 6h2.2M12 8h2.2M12 10h2.2"/>',
    fight: '<path d="M3 13l4.5-4.5M9 3l4 4-3.5 3.5-4-4z"/><path d="M5.5 6.5L3 4"/>',
    game: '<rect x="1.8" y="5" width="12.4" height="7" rx="3"/><path d="M5 7.2v2.6M3.7 8.5h2.6"/><circle cx="10.2" cy="7.8" r=".7" fill="currentColor" stroke="none"/><circle cx="11.8" cy="9.4" r=".7" fill="currentColor" stroke="none"/>',
    rom: '<rect x="2.5" y="3.5" width="11" height="9" rx="1"/><path d="M5 3.5v-1.5M8 3.5v-1.5M11 3.5v-1.5M5 12.5V14M8 12.5V14M11 12.5V14M5.5 8h5"/>',
    text: '<path d="M3 4h10M3 8h7M3 12h9"/>',
  };
  function inject(doc) {
    if (doc.getElementById('kit-icons')) return;
    const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.id = 'kit-icons'; svg.setAttribute('width', '0'); svg.setAttribute('height', '0'); svg.style.position = 'absolute';
    svg.innerHTML = Object.entries(ICONS).map(([name, body]) => `<symbol id="i-${name}" viewBox="0 0 16 16">${body}</symbol>`).join('');
    (doc.body || doc.documentElement).prepend(svg);
  }
  /* icon('play') -> an <svg class="ic"> element; pass extra classes as the second argument */
  function icon(name, cls) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'ic' + (cls ? ' ' + cls : ''));
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#i-' + name);
    svg.append(use);
    return svg;
  }
  g.KitIcons = { ICONS, inject, icon };
  if (typeof document !== 'undefined') { if (document.body) inject(document); else document.addEventListener('DOMContentLoaded', () => inject(document)); }
})(typeof window !== 'undefined' ? window : globalThis);
