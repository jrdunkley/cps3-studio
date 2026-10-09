# CPS3 Studio

A local creative toolkit for **Street Fighter III 3rd Strike on CPS3**. Compose music, edit artwork and colours, inspect and adjust stored move data, then try supported changes in the browser's game preview.

**Music | Art | Moves | Gameplay** share one ROM import and a project workspace. Open the included HTML launcher: there is no account, package installation or frontend build step.

**Bring your own game files.** The download contains tools, documentation and compatibility metadata. It contains no ROM images, BIOS images, extracted sprites, palette contents, recordings, music sequences from the game or sound samples. The game engine executes the program supplied by you.

## Quick start

1. Extract the entire ZIP to a folder. Keep the folder structure intact.
2. Open **`Open CPS3 Studio.html`** in a current desktop Chrome or Edge. On Windows you can use **`Open CPS3 Studio.bat`**. The root `index.html` opens the same launcher.
3. Choose **Music**, **Art**, **Moves** or **Game**.
4. At the welcome screen, select your own **`sfiii3nr1.zip`** and **`sfiii3.zip`** together. The original target is **Japan 990512 NO CD rev 1**. Supply the complete sets, including the BIOS and graphics members needed by Game and Art. You can also select the folder containing your game.
5. Let Studio verify and import the files. Switching modules reuses this import in the same browser.
6. Export your projects regularly. Browser storage is convenient working storage; clearing site data or moving between browsers can remove or separate it.

The pages can also be served by a local or static web server. Files selected in the welcome screen are read in your browser. The application does not upload them. Browser storage is separate for each origin; a disk launch and an HTTP launch may need separate imports.

## What each module does

| Module | Main workflow |
| --- | --- |
| **Music** | Compose on a piano roll, import MIDI, arrange parts, mix, inspect instruments, and export songs, audio and editable projects. |
| **Art** | Browse stored sprites and animations, draw with indexed pens and layers, import images and sheets, explore palettes and scene usage, and deliver supported replacements. |
| **Moves** | Select a character and stored move, inspect its timeline, edit supported fields, view collision boxes, and test against an opponent. |
| **Game** | Run the supplied game, pause and step, save moments, compare runs, and inspect the resources contributing to the picture. |

### Music

Music runs the sound driver read from your ROM through Studio's SH-2 interpreter and sample-chip model. Its Library can open the original game's 49 pieces read-only and make editable copies locally. It provides 59 music programs, including 12 drum kits.

- Piano roll, parts, sections, velocities, automation and project undo.
- Volume, expression, pan, mute and solo, with meters and Game Check.
- Echo, harmony, swing and other devices compiled into driver commands.
- Instrument Designer for rearranging slices and loops of existing samples.
- WAV and stems, MIDI, editable projects, text scores and song-file export.
- Optional loop compression, checked against plain-sequence playback before use.
- The earlier [Classic editor](music_editor/classic.html) remains available.

Use the [composing guide](music_editor/docs/COMPOSING.md) for a first song and the [Music guide](music_editor/docs/README.md) for the workspaces.

### Art

Art reads the artwork from your imported ROM. The Library includes character animations and an **Everything** browser that keeps unnamed sprites accessible by their original IDs.

- Indexed drawing, layers, selection, undo/redo, onion skin and animation playback.
- PNG and sprite-sheet import/export with frame and origin information.
- Character colours, supported extended colours and stage colour variants.
- Gill's timed palette phases, with explicit handling of shared colour sources.
- Discovery links between artwork, palettes, animations and known scene tables.
- More palette context for title/ending art, the bonus car and Poison.
- Cut-content annotations with addresses and digest checks; these do not imply that every unreferenced asset is unused.
- Background and scene inspection, plus supported fixed-size sprite and colour delivery.

Some edits affect shared artwork or palette sources. Read the displayed usage information before building. The [artist guide](art_editor/docs/ART_GUIDE.md) explains the workflow; the [capability list](art_editor/docs/WHAT_ART_CANNOT_DO_YET.md) records the limits.

### Moves

Choose a character and move group, then select a frame or command in the stored timeline. The inspector exposes supported timing, artwork links, attack/collision records, movement fields and rectangles. Unsupported or unsafe fields remain constrained by the model.

Use **Artwork** to inspect animation and boxes. **Hit preview** loads the imported game in a controlled two-character setup; choose the opponent and spacing, then use the input controls or available move recipe. The game itself performs collision, damage and reactions. The stored animation view alone is not a full combat simulation.

Move edits support undo/redo and shared-project saving. **Build ROM** produces a separate output ZIP; **Try in game** sends the edited images to Game. This release edits existing records at their existing sizes. It does not promise arbitrary new moves, new command layouts or extra storage.

### Game

Game includes Studio's CPS3 machine emulator compiled to WebAssembly, with its C source. It needs the program, BIOS, graphics and sound data from your import.

- Play, pause, frame step, rewind and speed controls.
- Keyboard and gamepad controls, sound settings and local save slots.
- Original/edited previews through **Try in game**.
- Scenario recording and comparison tools.
- Pixel inspection and frame resource information, with navigation into known artwork.

Game preview is a development tool. Its counters describe the emulator, and its results are not a claim that every edit has been tested on a physical arcade board. See [Game and Moves workflows](docs/WORKFLOWS.md).

## One project across the tools

The shared workspace keeps source identity, documents, history, versions and staged build layers together. Work is separated by game source and, where applicable, game mode. Exported shared projects use **`.cps3project`**; existing Music and Art formats remain supported in their own modules.

Stage changes from each editor's delivery/build controls before creating a combined build. The Builder checks the selected source, original-byte preconditions, dependencies, storage claims and overlapping writes. Conflicting writes are refused. Saving a draft does not by itself make every draft operation deliverable.

Use exported project files for backups. Projects, patched images and exports can contain material derived from your game, so keep them out of the public tool repository.

## Supported sources

| Source | Music | Art / Moves / Game |
| --- | --- | --- |
| Original Japan 990512 NO CD rev 1 (`sfiii3nr1`) | Available | Available, within each operation's stated limits |
| Recognised Infinite 1.033 | Not enabled by the Music module | Available; operation-specific checks still apply |
| Recognised Infinite 1.04 | Not enabled by the Music module | Available; operation-specific checks still apply |

Recognition uses image hashes, not archive names alone. Infinite modes include Super SF3, 3rd Strike and 3v3. Other builds, including later updates, are not automatically compatible. Importing a recognised source does not grant permission for every possible edit on that source.

## Command line

Node.js **22.4 or newer** runs the JavaScript tools without npm packages. Python is used by the optional sequence checks and engine build tools.

```sh
# Music: import your local ROMs, list pieces, compile and render
cd music_editor
node cli/studio.js rom import /path/to/sfiii3nr1.zip /path/to/sfiii3.zip
node cli/studio.js pieces --json
node cli/studio.js build song.sf3score --out song.sf3song.json --json
node cli/studio.js render song.sf3score --wav song.wav --json
```

From the repository root:

```sh
# Inspect a shared project without loading a ROM
node cps3_studio/cli.js inspect --project my-project.cps3project

# Validate and build against your own source files
node cps3_studio/cli.js validate --project my-project.cps3project --roms /path/to/roms
node cps3_studio/cli.js build --project my-project.cps3project --roms /path/to/roms --out out/my-build

# Run or compare scenarios saved in the project
node cps3_studio/cli.js scenarios --project my-project.cps3project --roms /path/to/roms
node cps3_studio/cli.js compare --project my-project.cps3project --roms /path/to/roms
node cps3_studio/cli.js sources
```

The build destination must be new. CLI outputs and browser downloads are local files; they are not automatically installed into Fightcade. See the [Music command reference](music_editor/docs/AGENT_GUIDE.md), [Art command reference](art_editor/docs/AGENT_GUIDE.md) and [Art delivery API](art_editor/docs/DELIVER_API.md).

## Tests and engine source

```sh
cd music_editor
node checks/run_tests.js --roms /path/to/roms
```

The Music runner derives its private pack from your files and exercises the compiler, driver, compression, MIDI and browser self-tests. Read [the test guide](music_editor/docs/TESTING.md) for dependencies and coverage.

The bundled game engine can be rebuilt using the recorded Zig version, **0.16.0**:

```sh
python studio_kit/game/build_engine.py --zig /path/to/zig --check
```

This compiles only the emulator and compares its WebAssembly with the bundled payload. It does not need or compile a game ROM. Browser users do not need Zig. See [engine build notes](studio_kit/game/BUILDING.md).

## Layout

```text
Open CPS3 Studio.html   browser launcher
Open CPS3 Studio.bat    Windows launcher
index.html             alternative entry point
cps3_studio/           module selector and shared-project CLI
music_editor/          music engine, workspaces, CLI, guides and tests
art_editor/            artwork, palettes, discovery and delivery
move_editor/           move records, timeline and combat preview
game_editor/           game controls, comparison and inspection
studio_kit/            shared UI, ROM loader, project and Builder
studio_kit/game/src/   source of the bundled machine emulator
docs/                  cross-module workflows
```

## Limits and troubleshooting

- This is an evolving toolkit, not a finished character or stage construction suite. General assist authoring, character assembly, arbitrary sprite growth and unrestricted stage/screen editing are not completed features of this release.
- Art writes remain limited by ownership, layout, source and capacity checks. A browsable or drawable asset is not necessarily installable.
- Music uses 16 monophonic voices; chords consume several voices, and game effects share voices 13?16. New sample storage, chip filters and chip reverb are not supplied.
- If import fails, check the exact revision and supply both complete archives. Renaming a different ROM set does not make it compatible.
- If a mode asks for ROMs again, check the selected source and browser origin. Keep all extracted files together and use the same browser for continued work.
- If an export is refused, read the source, conflict or capacity message. Export the editable project while resolving it.
- If audio is silent, interact with the page, check the module's sound control and browser permissions. Automated checks intentionally mute browser output.

## Documentation

- [Cross-module workflows](docs/WORKFLOWS.md)
- [Release notes](CHANGELOG.md)
- [Art guide](art_editor/docs/ART_GUIDE.md) and [capabilities](art_editor/docs/WHAT_ART_CANNOT_DO_YET.md)
- [Music guide](music_editor/docs/README.md), [composing](music_editor/docs/COMPOSING.md) and [formats](music_editor/docs/FORMATS.md)
- [Music ROM guide](music_editor/docs/ROM_GUIDE.md) and [Art ROM guide](art_editor/docs/ROM_GUIDE.md)
- [Contributing](CONTRIBUTING.md), [third-party notes](THIRD_PARTY.md) and [licence](LICENSE)

## Privacy and ownership

Street Fighter III and its game content belong to Capcom. CPS3 Studio is not affiliated with or endorsed by Capcom. Supply your own game files. Names, addresses, hashes and format descriptions in the tools identify compatible data; the underlying game content is loaded locally.

The public package excludes ROMs, extracted artwork/audio, private songs, captures and saved games. Its embedded WebAssembly is the tool's emulator, not a bundled game program. The source is provided under the [MIT licence](LICENSE); this licence does not cover game content imported or exported by a user. The [third-party notes](THIRD_PARTY.md) describe the emulator references.

The included `.gitignore` excludes common generated and ROM-derived files. Review files before committing: ignore rules cannot undo files already tracked by Git.
