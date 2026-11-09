# CPS3 Studio kit

Shared by every CPS3 Studio module: Music today (`../music_editor`); a sprite or palette studio could join it
later. It is what makes separate tools feel like one product and lets them be bundled.

| File | What |
|---|---|
| `kit.css` | the design system: colour, type, spacing, every control; canvas tokens `--cv-*`; `.wide-only` for 1280-wide windows |
| `icons.js` | the icon set (`<svg class="ic"><use href="#i-play"/></svg>`) |
| `kit.js` | behaviour: tooltips, menus, dialogs, toasts, command palette, shortcuts, sliders and knobs, split panes, canvas, storage |
| `shell.js` | the app frame: module registry, settings, the welcome screen and the local ROM import |
| `core/zip.js` | reads and writes zip files |
| `core/cps3rom.js` | loads a CPS3 ROM set, recognises the release by checksum, decrypts the program, interleaves the graphics/sound ROM; patches and re-encrypts a program image for the music installer |
| `demo.html` | every control, live, with its own self-test (`node ../music_editor/checks/gates/g_style.js --browser`) |

Rules for a module:

1. A module is a folder beside this one that works on its own (`index.html`) and loads the kit by relative path.
2. Colours, font sizes, radii and shadows come only from `kit.css` tokens. Module CSS is layout. Need a new
   control? Add it here, in the kit's style, once.
3. It registers with the shell: `CPS3Studio.register({ id, title, icon, mount(root, ctx), unmount() })` and takes
   shared services from `ctx` (the loaded ROM, storage, actions, toasts, settings).
4. One ROM import serves all modules (`Cps3Rom.load`); each derives what it needs. Anything derived from a ROM stays
   private (browser storage or the module's `data/`), never in a published file.
