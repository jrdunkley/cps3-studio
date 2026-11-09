# CPS3 Studio

**Music, art and move tools for Street Fighter III: 3rd Strike, heard and seen the way the arcade board plays them.**

CPS3 Studio runs in your browser and works from your own copy of the game. Music plays on the game's own sound program, artwork and colours come straight from the ROM, and a built-in CPS3 emulator lets you try your changes in the game. There is nothing to install or build, no account, and your files never leave your computer.

**Music | Art | Moves | Gameplay** share one import of your game and one project.

**Bring your own ROMs.** This repository contains no Capcom code, music, samples, artwork or other game data.

## What you can do

### Music

Write songs for 3rd Strike on a piano roll. The Studio runs the game's sound program from your ROM on an emulation of the board's sound chip, so what you hear while you compose is what the arcade board plays.

- Start from scratch or import MIDI, and arrange with the game's 59 instruments, 12 of them drum kits.
- Open Capcom's 49 original pieces to listen and study, and make your own editable copies.
- Mix with volume, expression, pan, mute and solo; add echo, harmony and swing.
- Make new instruments from slices and loops of the game's own samples in the Instrument Designer.
- Export WAV, stems, MIDI, text scores and song files, create a ROM patch with your song, or try it in the game.

The earlier [Classic editor](music_editor/classic.html) is still included. Start with the [composing guide](music_editor/docs/COMPOSING.md).

### Art

Browse and edit the game's sprites, animations and colours.

- Find any sprite by character and animation, or by number in the **Everything** browser.
- Draw in the game's own colours, with layers, selection, undo, onion skin and animation playback.
- Import and export PNG images and sprite sheets.
- Edit every character colour, including the faces shown beside the life bar and on the judges' panels, and Gill's timed colours, with a colour picker that snaps to the game's 32 levels.
- Share colours with the tools the community already uses: PalMod colour strings, ACT (Photoshop, MUGEN), GIMP and Aseprite palettes. Open palette mods from ROM files, IPS patches and FBNeo patch folders, and save your own as FBNeo patches.
- Sprites are written only in the form Capcom's own data uses, which a real CPS3 board draws correctly.

The [artist guide](art_editor/docs/ART_GUIDE.md) walks through it.

### Moves

Look inside every character's moves.

- Step through a move frame by frame: timing, artwork, hit and hurt boxes, movement, and the cancels each frame allows.
- Change the stored values, with undo.
- **Hit preview** runs the game with two characters at the distance you choose, so you can watch the move connect.
- **Build ROM** saves a patched copy of the game; **Try in game** plays it straight away.

### Game

A CPS3 emulator built into the Studio, compiled to WebAssembly from the C source in this repository.

- Play, pause, step one frame at a time, rewind and change speed.
- Keyboard and gamepad controls, sound settings and save slots.
- **Try in game** plays your Music, Art and Moves changes before you build anything.
- Record runs and compare them; click any pixel to see what drew it, and open that artwork in Art.

## Getting started

1. Download the Studio: **Code → Download ZIP** on this page, then extract all of it, or clone the repository. Keep the folders together.
2. Have your ROMs ready: **sfiii3nr1.zip** (Japan 990512, NO CD) and its parent **sfiii3.zip**. If you play on Fightcade, you already have them.
3. Start the Studio:
   - **Windows:** double-click `Open CPS3 Studio.bat`. With Python 3 installed, the Studio opens in its own window and can find your game files for you, in Fightcade or the Infinite client. Without Python it opens in your browser.
   - **Any system:** open `Open CPS3 Studio.html` in a current desktop Chrome or Edge.
4. The first time, the Studio asks for your game files. Let it find them, or choose the folder or the two zip files yourself. It checks them and remembers them.
5. Choose **Music**, **Art**, **Moves** or **Game**.

Your work is kept in the browser as you go. Export a project (`.cps3project`) to keep a copy or to carry on in another browser.

## Infinite

The Studio works with the original game and with Infinite.

- Art, Moves and Game work on **Infinite 1.07b**, the current release, in all three modes: Super SF3, 3rd Strike and 3v3. Change the mode in the Game menu.
- Music always uses the original game's sounds.
- Infinite's extra colours, stage colour variants and Gill's timed colours aren't listed on Infinite yet.
- An older Infinite release is recognised, and the Studio asks you to start the Infinite client once to update it.

The Studio recognises a game by its contents, not its file names. Other modified versions of the game aren't supported.

## Good to know

- **Your files stay on your computer.** The Studio reads them in your browser and uploads nothing.
- **Changes keep their size.** A changed sprite has to fit in the space the original used, and move edits change existing values. New moves, bigger sprites and new sound samples aren't possible yet. The [Art capability list](art_editor/docs/WHAT_ART_CANNOT_DO_YET.md) has the details.
- **Music has 16 voices.** A chord uses several, and the game's sound effects share voices 13 to 16.
- **Nothing is installed into Fightcade for you.** ROM patches and exports are ordinary files on your computer. FBNeo patches load through FBNeo's IPS manager.
- **Game is an emulator.** Try finished work in the real game as well.
- **Sound needs a click.** Browsers keep a page silent until you interact with it; if you hear nothing, click the page and check the sound button.

## Command line

Node.js 22.4 or newer runs the tools from a terminal, with no packages to install.

```sh
# Music: read your ROMs, list the pieces, build and render a song
cd music_editor
node cli/studio.js rom import /path/to/sfiii3nr1.zip /path/to/sfiii3.zip
node cli/studio.js pieces --json
node cli/studio.js build song.sf3score --out song.sf3song.json --json
node cli/studio.js render song.sf3score --wav song.wav --json
```

```sh
# Projects, from the repository folder
node cps3_studio/cli.js inspect --project my-project.cps3project
node cps3_studio/cli.js validate --project my-project.cps3project --roms /path/to/roms
node cps3_studio/cli.js build --project my-project.cps3project --roms /path/to/roms --out out/my-build
node cps3_studio/cli.js sources
```

The build folder must be new. See the [Music commands](music_editor/docs/AGENT_GUIDE.md), [Art commands](art_editor/docs/AGENT_GUIDE.md) and the [Art delivery API](art_editor/docs/DELIVER_API.md).

## Tests and the emulator

```sh
cd music_editor
node checks/run_tests.js --roms /path/to/roms
```

The [test guide](music_editor/docs/TESTING.md) lists what the tests cover and what they need.

The emulator can be rebuilt with Zig **0.16.0**. This compiles only the emulator and compares it with the one included; it needs no game files:

```sh
python studio_kit/game/build_engine.py --zig /path/to/zig --check
```

See the [emulator build notes](studio_kit/game/BUILDING.md).

## What's where

```text
Open CPS3 Studio.html   start the Studio in a browser
Open CPS3 Studio.bat    start the Studio on Windows
cps3_studio/            home screen, local launcher and project command line
music_editor/           Music
art_editor/             Art
move_editor/            Moves
game_editor/            Game
studio_kit/             shared interface, ROM reader and projects
studio_kit/game/src/    C source of the emulator
docs/                   working across the modules
```

## Documentation

- [Working across the modules](docs/WORKFLOWS.md)
- [What's new](CHANGELOG.md)
- [Art guide](art_editor/docs/ART_GUIDE.md) and [capability list](art_editor/docs/WHAT_ART_CANNOT_DO_YET.md)
- [Music guide](music_editor/docs/README.md), [composing](music_editor/docs/COMPOSING.md) and [file formats](music_editor/docs/FORMATS.md)
- [Music ROM guide](music_editor/docs/ROM_GUIDE.md) and [Art ROM guide](art_editor/docs/ROM_GUIDE.md)
- [Contributing](CONTRIBUTING.md) and [third-party notes](THIRD_PARTY.md)

## Legal

Street Fighter III and its content belong to Capcom. CPS3 Studio is not affiliated with or endorsed by Capcom. The [MIT licence](LICENSE) covers the Studio's own code, not game content you load or export. Projects and exports can contain material from your game, so keep them out of public repositories; the included `.gitignore` already leaves out ROMs and generated files.
