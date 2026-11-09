# Tests

```sh
cd music_editor
node checks/run_tests.js --roms <folder with sfiii3nr1.zip and sfiii3.zip>
```

The first run makes the private `data/pack.js` from your zips (git ignores it). A full run takes about five
minutes; `--quick` shortens the audio comparisons of G3 and G4, `--only G4,G13` runs a selection and
`--no-browser` skips G12. Each test prints one line ending `N checks, M failures` and decides by its exit code;
full logs go to `out/tests/logs/`.

You need Node.js 22.4 or newer, Python 3 (G5 runs the Python twin of the sequence check) and, for G12, Chrome,
Chromium or Edge (set `STUDIO_BROWSER` to its executable if it is not in the usual place).

## What "sound-identical" means

The driver, booted in stereo, renders the same audio for both sequences, sample for sample, on both sides, for
the whole compared length (`checks/gates/lib.js`). Stereo, because in mono (what Fightcade plays) a wrong pan
would pass. When a comparison fails, `soundLog` shows the chip writes at the frame where the audio parts.

## The tests

| Id | Test | Proves |
|---|---|---|
| G1 | `checks/command_check.js` | the driver facts the Studio relies on (commands, envelopes, LFO, pitch, banks, sample views), measured in the running driver |
| G3 | `checks/gates/g_v1_upgrade.js` | version-1 songs (the original test songs in `checks/gates/fixtures/songs/`) still build to their stored bytes; upgraded to version 2 they sound identical, plain and loop-compressed; compression shrinks them |
| G4 | `checks/gates/g_capcom.js` | all 49 of Capcom's pieces open as editable projects and rebuild sound-identical, plain and compressed |
| G4C | `checks/gates/g4_control.js` | G4's yardstick: Capcom's own bytes played from the Studio's preview slot sound identical to the original request, and one changed note is caught |
| G5 | `checks/gates/g_compress.js` | loop compression gives back every event of every Capcom track and of seeded random streams, keeps the driver's waits in order, and passes the sequence check in JavaScript and in Python (`check_sequence.py`) |
| G6 | `checks/gates/g_devices.js` | each device and switch does what `plan/04_FORMATS.md` says (checked in the driver), track allocation, loop restore, bar ranges, chorus entries frame by frame, song files |
| G8 | `checks/gates/g_score.js` | text scores print and parse back to the same project for every Capcom copy, the test songs and the fixtures; malformed scores give errors that name part, bar and token |
| G11 | `checks/gates/g_analyze.js` | mix numbers equal the reference measurement, percentile targets are exact, each planted fault raises its issue, harmony fixtures are read right |
| G12 | `checks/studio_browser.js` | the Studio's own self-test (more than 100 checks) and the classic page's, in a hidden browser |
| G13 | `checks/gates/g_cli.js` | every command-line command on temporary files: JSON fields, errors, output files; `rom import`, `rom space` and `rom install` on your zips, which stay unchanged |
| G14 | `checks/gates/g_style.js` | no colour, font size, radius or shadow outside the kit; every registered action has a title and a hint |
| G15 | `checks/gates/g_catalog.js` | the instrument catalog: ranges as the 49 pieces play them, tuning, break bars, kit keys, Capcom's usual levels, the same result twice |
| G16 | `checks/gates/g_midi.js` | MIDI in and out: the pitfalls of real files, writing every event kind, project → MIDI → project, imports from other tools |

Optional inputs: `STUDIO_SONGS` runs G3, G6, G8 and G16 on a folder of your own version-1 song files instead of
the test songs; `STUDIO_MIDI_DIR` lets G16 also compare the old and new MIDI readers on your own MIDI files.

## Not in this repository

The research project behind the Studio also checks things that need private material, so they are not here:

- the JavaScript engine against a C build of the same driver (11 million log lines identical), against an
  in-game capture, and against MAME recordings of the real game (correlation 0.98 and 0.97);
- engine additions checked against that C build (stereo boot, saved states, writing into the music space);
- custom instruments: the bank layout against the C build and the evidence that bank 8 is never used by the game;
- audio export checks that use private songs as material;
- the ROM installer's full gate, which compares a patched image played by the C build with the preview.

G1, G4 and G13 cover the same ground from the public side: the driver's measured facts, Capcom's own music
rebuilt sample for sample, and the installer run end to end on your zips.

## Rules for changes

Never loosen a comparison to make a test pass, skip a case or special-case a song. If a test fails, the code
under test is wrong, or the expectation needs a reasoned change that you state in the commit. After changing
`js/engine.js`, `js/sh2.js` or `js/seq.js`, run everything.
