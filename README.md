# CPS3 Studio · Music and Art

Open `Open CPS3 Studio.bat` or `Open CPS3 Studio.html` and choose **Music** or **Art**.
Import your own `sfiii3nr1.zip` and `sfiii3.zip` once: both modes remember the same ROM
in this browser, and switching keeps each mode's work on this computer.

**Art** reads sprites, character colours, initial stage layers and small interface tiles
from that ROM. Browse every sprite by number, draw with 64 pens and layers, import sheets,
preview animations and prepare supported replacements. Unnamed artwork stays visible.
Larger sprites and new frames need verified room; an editable preview is not a delivery promise.
Read [the artist guide](art_editor/docs/ART_GUIDE.md),
[Art commands](art_editor/docs/AGENT_GUIDE.md) and
[the generated limits](art_editor/docs/WHAT_ART_CANNOT_DO_YET.md).

A music workstation for **Street Fighter III 3rd Strike** on Capcom's CPS3 arcade board. It runs the
game's own sound driver (the SH-2 code from your ROM) and an emulation of the board's sample chip in your
browser. What you hear while you compose is what the arcade board plays, sample for sample.

Write songs on a piano roll, import MIDI, arrange with the game's 59 music programs (12 of them drum kits),
study and copy Capcom's 49 original pieces, and export WAV, MIDI, editable projects, text scores and song
files that a ROM build can install. Everything runs locally: no server, no account, no install, no build step.

**Bring your own ROM.** This repository contains no Capcom code, music, samples or data. The Studio reads
them from your own copy of the game when you open it, and keeps what it derives on your computer.

## Quick start

1. Open `Open CPS3 Studio.html` in Edge or Chrome (or `index.html` at the top). On
   Windows, double-click `Open CPS3 Studio.bat`, then choose Music or Art.
2. On the welcome screen choose, or drop, your own **`sfiii3nr1.zip`** (Japan 990512 NO CD rev 1, the
   program) and **`sfiii3.zip`** (the sound samples), the ROM sets FBNeo and Fightcade use. The Studio
   checks them by checksum, decrypts the program in the page and keeps the derived sound data in the
   browser's own storage. Nothing is uploaded.
3. Start with a template, open a MIDI file, or open one of Capcom's pieces from the Library. Space plays,
   Ctrl K finds every command and F1 opens short guides.

The page also works from any static web host (GitHub Pages, for example): the ROM is read by the visitor's
browser and never leaves it.

## What is in it

- **Compose**: parts and sections above a piano roll; velocity and automation lanes; loop and
  "from the chorus" entry for later rounds; devices (echo, double, harmony, duck, gate, glide, auto-pan,
  swing, humanize) that write real driver commands; whole-project undo.
- **Mix**: driver-level volume, expression and pan, mute and solo, meters, a spectrum, Game Check (track,
  pitch, loop and mix problems) and a Fight Simulator that lets hit sounds and voices take voices 13–16 as
  they do in a match. Mono, as Fightcade plays it, or the board's stereo.
- **Sounds**: every instrument by musical role, with its playable range and the drum kits' original bars;
  an optional Instrument Designer that builds new instruments from slices and loops of the existing samples.
- **Library**: Capcom's originals (read-only, with "make an editable copy"), templates and your projects,
  with automatic local versions.
- **Deliver**: WAV and stems, MIDI, project, text score, agent brief and song file. A song file always holds
  the plain sequence; a smaller loop-compressed sequence is added only after the Studio has proved, in the
  driver, that it sounds identical. Deliver › ROM patches a program image for a ROM developer.
- **Classic editor** (`music_editor/classic.html`): the first, simpler editor, kept as it was.

## Command line (for scripts and AI agents)

The same compiler, driver and checks run under Node.js (22.4 or newer; no packages to install):

```sh
cd music_editor
node cli/studio.js rom import path/to/sfiii3nr1.zip path/to/sfiii3.zip    # writes data/pack.js (private)
node cli/studio.js pieces --json
node cli/studio.js build song.sf3score --out song.sf3song.json --json
node cli/studio.js render song.sf3score --wav song.wav --json
```

[`music_editor/docs/AGENT_GUIDE.md`](music_editor/docs/AGENT_GUIDE.md) lists every command and its JSON.

## Documentation

| Page | For |
|---|---|
| [docs/README.md](music_editor/docs/README.md) | the workspaces, privacy, limits |
| [docs/COMPOSING.md](music_editor/docs/COMPOSING.md) | writing for the game's driver: voices, drums, levels, a first song |
| [docs/AGENT_GUIDE.md](music_editor/docs/AGENT_GUIDE.md) | the command line and the text score, with complete examples |
| [docs/FORMATS.md](music_editor/docs/FORMATS.md) and [plan/04_FORMATS.md](music_editor/docs/plan/04_FORMATS.md) | project, song file, score and patch formats |
| [docs/ROM_GUIDE.md](music_editor/docs/ROM_GUIDE.md) | putting songs into a ROM image: what changes and why it is safe |
| [docs/plan/02_DRIVER.md](music_editor/docs/plan/02_DRIVER.md) | the CPS3 sound driver and chip, command by command |
| [docs/TESTING.md](music_editor/docs/TESTING.md) | the test suite and what each test proves |

## Tests

```sh
cd music_editor
node checks/run_tests.js --roms path/to/the/folder/with/your/zips
```

The runner makes the private `data/pack.js` from your zips if it is not there yet, then runs every test:
among them, all 49 of Capcom's pieces opened as projects and rebuilt **sound-identical** (the same stereo
audio from the driver, sample for sample), loop compression, devices, text scores, MIDI, the command line
and both pages' self-tests in a hidden browser. See [docs/TESTING.md](music_editor/docs/TESTING.md).

## Layout

```
index.html            opens the Music and Art landing page
art_editor/           artwork browsing, editing, imports, palettes, delivery and guides
music_editor/         the Music studio: index.html (Studio), classic.html, js/ (engine, driver CPU,
                      compiler, formats), studio/ (workspaces), cli/, style/ (arranger), checks/, docs/
studio_kit/           the shared design system and the ROM loader (zip reader, CPS3 decryption)
cps3_studio/          a launcher page for the suite
```

## Limits

- One game and release: Street Fighter III 3rd Strike, Japan 990512 NO CD rev 1 (`sfiii3nr1`).
- Sixteen monophonic voices; a chord takes a voice per note. In a match the game's effects borrow voices 13–16.
- No new samples: the ROM's sample space is full. Custom instruments rearrange the existing samples.
- No filters or reverb: the chip has none.

## Privacy and legal

Street Fighter III, its music, sounds and program are Capcom's. This project includes none of them and is
not affiliated with or endorsed by Capcom. Use your own ROM files. Packs, renders, decompiled pieces and
patched images made from a ROM are derived from Capcom's work: keep them private. The `.gitignore` keeps
`music_editor/data/`, `music_editor/out/`, `music_editor/songs/` and ROM files out of the repository.

The source code is released under the [MIT licence](LICENSE). [THIRD_PARTY.md](THIRD_PARTY.md) records
where outside knowledge was used.
