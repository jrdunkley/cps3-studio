# Updates

## 2026-11-09

The Studio is now published as its source files: download or clone the repository and open it, nothing to build.

- **Infinite 1.07b.** The current Infinite release is recognised by its program and data hashes. Art, Moves and Game open on it; its extra colours, stage variants and Gill's timed colours behave as on the previous release (not listed yet, and Palettes says why).
- **Music works whichever game you chose.** Music always uses the original game's sounds and opens normally while Art, Moves and Game work on Infinite. If the original files are missing, Music asks for them without changing the other modules' game.
- **Plain words.** Every view, tooltip, command and help page was read through and rewritten where it used internal terms. Technical details stay one click away under Technical detail; Art's capability list says what works, what works with limits and what does not yet.
- **Fixes found on real paths.** Music's Instrument panel on Capcom's tracks, a stale "Add a part" hint, read-only pieces showing Saved, tempo decimals, "1 warnings" and "plays 0 notes a second"; Art's Deliver and game-check messages; the Game label on a new browser's first visit.

## 2026-11-08

The first minutes, walked as a new user and smoothed out.

- **Your game files.** The first time the Studio starts it asks where your game is: Find them automatically (Fightcade, the Infinite client, folders you chose before) or Choose files myself (a folder, the two zip files, or a drop). What it finds is listed with the best choice selected and checked when you use it; after that it never asks again. Game files… in the Game menu brings the screen back, and the home page names the game in use with Change….
- **Infinite 1.07-1.** The current Infinite release is recognised. Art, Moves and Game open on it in all three modes; its extra colours, stage variants and Gill's timed colours behave as on the previous release (not listed yet).
- **Quieter.** No status line about files that were just read, no "Saved" on a song or artwork that holds nothing yet, no empty "Untitled art" in Recent projects, and the Music tour starts only when you ask for it.
- **Clearer.** The piano roll says to add a part before drawing; Try in game says how to reach the change; Art's sprite panel says when it is still measuring instead of naming internal steps.

## 2026-11-07

Colours now line up with the tools the 3rd Strike community already uses, and the Studio finds your game by itself.

- **No more "Where is your game?" on this computer.** Started through its local launcher, the Studio finds Fightcade's ROMs and the Infinite client's prepared ROMs by itself, opens a link straight into its tool, and asks only when the game is nowhere to be found. The folder you then choose is remembered.
- **Infinite 1.07.** Every released Infinite set is recognised by its program and data hashes, and Art, Moves and Game open on the current release, 1.07. Older releases are named and the Studio asks you to update them. On 1.07 Infinite's extra colours, stage variants and Gill's timed colours are not listed yet, and Palettes says why.
- **A colour editor for the mouse.** Palettes has a saturation/brightness square and a hue strip, and red, green, blue, hue, saturation and brightness tracks drawn in the colours each step gives, all snapping to the game's 32 levels. Hold Original to compare. Click a pixel in the picture to pick its pen; the picture holds still under the pointer. Drag across several pens and the ramp tools turn, saturate or brighten them together, with a before/after strip. The preview follows every drag live, and each release is one undo step. Numbers stay one click away under Numbers.
- **Panels you can arrange.** In Art Palettes, Art Library, Moves and Music Compose, drag a column edge to resize it, hide a panel with the button on its edge and bring it back with the edge tab. The layout is remembered; Reset layout is in Ctrl K.
- **Music stays smooth while you edit a long song.** An edit while playing deep into a song used to stall the window for seconds while playback caught up; the catch-up now runs in the background where the browser allows it, and an edit rebuilds only the parts that changed. Built songs are byte for byte the same.
- **Palettes at rest.** The Palettes picture plays with the transport (Play or Space) and otherwise holds its frame, so an idle Palettes view draws nothing.

- **PalMod colour strings.** Copy for PalMod puts selected pens, or a whole row, on the clipboard in PalMod's own 3rd Strike format. Paste colours reads PalMod strings from any CPS3 game and lists of `#RRGGBB` colours.
- **Palette files.** ACT is written exactly as PalMod and Photoshop write it, and ACT files that mark colour 0 as transparent now import. New: MUGEN ACT (upside down, for Fighter Factory), GIMP GPL (Aseprite, Krita), and the colour table of any indexed PNG, GIF or BMP. Colours saved by CPS3 tools import without rounding.
- **Open a mod.** Reads palette mods made with PalMod or other tools: patched ROM zips, SIMM files, PalMod's `51` file, IPS patches and FBNeo patch folders. Every changed colour is listed by character and row before it is applied.
- **FBNeo patch.** Deliver can save your colours and sprites as IPS patches with FBNeo's `.dat` list, ready for FBNeo's IPS manager. A colour change is a few hundred bytes.
- **HUD and Judgement faces.** Each colour now includes the face beside the life bar and the face the judges hold up after a time-out decision, each previewed as the game draws it. Faces follow body carries body changes onto the faces of all seven colours. Checked in Fightcade's emulator: face colours delivered as an FBNeo patch load exactly at fight start and at the time-out decision, and show on the HUD and on the judges' panels.
- **Colour sheet**, greyscale, invert colours and reverse order in Palettes.
- **Board-safe sprites.** Deliver re-checks every changed sprite stream against the grammar Capcom's own data uses, because a real CPS3 board draws solid blocks for streams that emulators show correctly. The encoder already writes only that grammar; all 205,298 original uploads re-encode within it.
- **Moves: cancels and more, named.** 3rd Strike now rebuilds byte for byte from community C source, so the move data's remaining fields could be read off the code that uses them. Each frame shows its cancels as checkboxes (chain, target combo, rapid press, special or taunt, Super Art, high jump, dash, button release), where it branches when the attack connects, and its camera zoom. Collision records show how hurt boxes glide between frames, attacks show their hit mark, and move headers show the bytes the CPU opponent reads.
- **Moves: every script command explained.** All 141 commands have a one-line description, and 66 more of them now have named operands (251 in all, up from 82). Jump values are decoded beside them ("0x4002 = skip 1 record forward"), effect numbers are named from the game's effect table, and values past the end of that table are refused because the game would crash on them. Operands that pick a jump target, a script variable or a routine stay locked until a target can be checked.
- **Moves: hit marks and hurt-box glides read out.** An attack's hit mark is decoded from the game's own hit-mark table (mark, sound, quake, colour, and the marks used when guarded or chipped). Hurt-box glide values carry the labels from Capcom's own debug editor ("ud: X even, Y slowing down"). A cancel edit was checked in Fightcade's emulator: with Ryu's close LP Super Art cancel turned off, the same inputs give a Shoryuken instead and no stock is spent, while the special cancel is unchanged.
- **Music: the driver's own names.** The driver guide (`music_editor/docs/plan/02_DRIVER.md`) and the command table in `js/seq.js` give each sequence command's name in the decompiled sound driver and the channel value it sets, with what the source adds: pan applies only to instruments without their own pan, the gain value wraps outside -64..63, and the 'ignore music level' flag also skips the master fade.
- A clearer launcher, the same module switch on every page, readable pen numbers on light colours, and several wording fixes.

## 2026-11-04 · local test candidate

- Added character-project mode inside the normal Art page and Studio module navigation.
- Carried over direct indexed drawing saves, exact pre-save backups, stale-save protection, saved sequence editing, shared-frame copies, reference artwork, quality marks and project backup export.
- Opening Studio restores the registered character project, animation and frame. Module switching saves first and stays in the editor if saving fails.
- Added a local provider interface. Project artwork, palettes, stamps, effect images and project-specific build adapters remain local inputs.
- Character source saves still use the project's separate game-build workflow; there is no automatic installation into a running game.

## 2026-11-03

- Brought the newer drawing tools into Art: Tween, drag scaling, clean-row stretch, Smear, Sweep, Streak, Form, Edge, Tidy, Ribbon, Fray and reusable stamps.
- Connected palette shade ramps to the main editor, with undoable project settings; added origin-aligned guides excluded from saves and exports.
- Improved indexed drawing, selection/layer controls, canvas and preview layout, and multi-frame undo.
- Corrected the misleading Deep pad label to Sax-like reed voice (program 57). Clarified descriptive voice names, separated arrangement role from timbre, and added searchable old names and bank/program identity.
- Invalidated old instrument catalog caches while preserving user names and song program numbers.
- Included the current Music playback, piano-roll, CLI and shared-source fixes since the October package.

This update uses focused editing, Music playback, launcher/import and package checks.
It does not repeat the unchanged exhaustive game/compiler acceptance suites.

## 2026-10-09

- Added Moves: stored timelines, editable move fields, collision boxes, undo/redo and opponent hit preview.
- Added Game: browser gameplay, frame controls, save slots, comparisons, pixel inspection and Try in game links.
- Added shared projects and combined builds with source checks, saved versions and write-conflict detection.
- Expanded Art discovery, scene usage, cut-content annotations and palette tools, including Gill, stage variants, bonus-car and Poison context.
- Added recognised Infinite 1.033/1.04 sources to Art, Moves and Game, with separate source/mode storage.
- Updated portable packaging, bundled emulator source, asset exclusions and documentation.

These notes compare this package with the 2026-10-05 Music/Art release. Capability and storage limits remain in place; this is not a declaration that every planned editor is complete.
