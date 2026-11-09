# CPS3 Studio · Music

Make music for Street Fighter III 3rd Strike, Japan 990512 NO CD rev 1 (`sfiii3nr1`). The Studio runs the game's sound driver and sample chip locally. It needs no server, account, dependencies or build step.

Open `index.html` in Edge or Chrome (on Windows, double-click **Open the music editor.bat**). The first time, choose or drop your own `sfiii3nr1.zip` and `sfiii3.zip` on the welcome screen; the derived sound data then stays in the browser's storage. A private `data/pack.js` made with `node cli/studio.js rom import sfiii3nr1.zip sfiii3.zip` also works. Start with a template, open a MIDI/project/text score, or inspect one of Capcom's 49 pieces. Space plays; Ctrl K finds every command; F1 opens short task guides.

**Compose** arranges parts and sections above a piano roll. Draw notes, edit velocity and automation, set the loop and rounds-2+ entry, and add echo, double, harmony, duck, gate, glide, auto-pan, swing or humanize devices. Undo restores the whole project. Cycle a bar range to hear structural edits quickly.

**Mix** balances parts with real driver controls, mute/solo, per-track meters and a master spectrum. Game Check identifies track, pitch, loop and mix issues. Compare a stage theme at matched loudness, or use the Fight Simulator to hear actual hit and voice requests borrowing tracks 13–16. Fightcade monitoring is mono; Stereo exposes the board's pan setting.

**Sounds** browses instruments by musical role, auditions playable keys, and offers the break kits' original drum bars. Names can be changed locally and travel with projects. **My instruments** opens the optional Designer: zones, slices, loops, tuning and envelopes over existing ROM samples. It cannot import new recordings.

**Library** holds Capcom's originals, templates and locally saved projects. Originals open read-only; Make an editable copy preserves them. Autosave retains twenty versions per project. Ctrl S also downloads a portable project file; keep those backups because browser storage can be cleared.

**Deliver** writes WAVs and part stems, MIDI, editable projects, text scores, agent briefs and song files. The song file always carries a compatible plain sequence; compression is included only after exact stereo audio comparison. ROM delivery creates a patched image, encrypted program SIMMs, verified edits and a placement report. Follow [ROM_GUIDE.md](ROM_GUIDE.md) to use them in your own pipeline.

## Privacy

ROMs, packs, original sequences, renders and browser storage stay on this computer. Nothing is uploaded. Everything made from a ROM is derived from Capcom's work: do not distribute `data/`, `out/` or ROM-derived outputs (the repository's `.gitignore` keeps them out). A song file holds exactly what is in its project: if you start from a copy of a Capcom piece, those notes are Capcom's.

## The classic editor

The first editor remains at `classic.html` (**Open the classic editor.bat**): Game music, Sounds and My song tabs, a MIDI workflow, per-track controls and a key-lift demo. It reads the sound data only from `data/pack.js`, so run `node cli/studio.js rom import sfiii3nr1.zip sfiii3.zip` once before opening it. Its version-1 projects open in the Studio.

## What the game allows

MIDI channels are not game voices. A chord or overlapping drum hits may need several voices. If an import exceeds sixteen, later parts can be silent; Game Check names the omitted parts. Reduce Voices, remove duplicate layers, or turn off echoes to make room. Imported notes remain in the editable project.

There are sixteen monophonic tracks, 48 ticks per beat and 192 per 4/4 bar. A chord needs a track per voice; echo and double need extra tracks. The ROM has 733 used samples. There are no chip filters or reverb. Phrase markers let the game switch at musical boundaries. Custom instruments rearrange existing samples, not the sample ROM itself.

## Verification

From this folder run `node checks/run_tests.js --roms <folder with your two zips>`. [TESTING.md](TESTING.md) says what each test proves and what the research behind the Studio checked beyond them. `index.html#selftest` runs the page's own checks in your browser; `index.html#bench` measures performance on your machine.

Read [COMPOSING.md](COMPOSING.md) for musical guidance, [AGENT_GUIDE.md](AGENT_GUIDE.md) for the command line, and [FORMATS.md](FORMATS.md) for files. Instrument descriptions and numerical targets guide listening; they cannot certify that a song sounds good. New sample import, other CPS3 games and other releases of 3rd Strike are outside the Studio.
