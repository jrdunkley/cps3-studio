# CPS3 Studio · Art

Browse the artwork in your own Street Fighter III 3rd Strike ROM, draw with the game's pens,
work with layers, bring in pictures and sprite sheets, and prepare replacements for the game.
Music and Art share one welcome: choose your `sfiii3nr1.zip` and `sfiii3.zip` once, then both
modes remember them in this browser. Switching modes keeps each mode's work on this computer.

Open `Open CPS3 Studio.bat` or `Open CPS3 Studio.html` at the top of the folder. Choose Art.
The supported release is Japan 990512 NO CD rev 1. No game data comes with the Studio.
Keep an exported project as well as the browser's saved copy: clearing browser storage clears
local projects and the remembered ROM. Storage failures are reported; a visit-only import
needs importing again next time.

- [ART_GUIDE.md](ART_GUIDE.md): change a frame, import a sheet, recolour and deliver.
- [ROM_GUIDE.md](ROM_GUIDE.md): what delivery writes and how to try it privately.
- [AGENT_GUIDE.md](AGENT_GUIDE.md): command-line tasks and their limits.
- [WHAT_ART_CANNOT_DO_YET.md](WHAT_ART_CANNOT_DO_YET.md): the capability registry at build time.
- [CORE_API.md](CORE_API.md) and [DELIVER_API.md](DELIVER_API.md): the code interfaces.

Sprites use pens 0–63. Pen 0 is see-through. A frame shows a sprite for a time; an animation
contains frames. Frames can share one sprite, so changing that picture changes them all.
A tile is a 16 × 16 block. The origin is where the game places the picture.

Everything in the ROM keeps unnamed pictures visible by number. Suggested names are labels,
and a palette choice for unfamiliar art may be a reading rather than a proved match.
The stage and interface views show their verification limits in the workspace.

Work files store your changes against the same ROM. Pictures and sheets exported from the
ROM, browser caches and patched ROM files contain game artwork: keep those private.
An imported reference made from game artwork stays private inside a work file too.
The public source folder contains no pictures, palettes, captures or ROM payloads.
