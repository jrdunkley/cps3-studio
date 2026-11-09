# Working with an agent

Use the same compiler and arcade driver as the page: **write score → build → check → analyze → render for a human → revise**. Run commands from the `music_editor` folder. Node is the only CLI runtime; there are no packages to install. The page itself needs only a browser.

```sh
node cli/studio.js build song.sf3score --out song.sf3song.json --json
node cli/studio.js check song.sf3score --json
node cli/studio.js analyze song.sf3score --bars 5-12 --reference 16 --json
node cli/studio.js render song.sf3score --wav song.wav --json
```

Deliver the editable score/project, a WAV and the song file. Keep an earlier version when revising by ear. Give two level-matched options for a disputed instrument. Never replace notes or octaves merely to make a numeric target green. Never install into a game build unless asked; assign new songs unused request codes. ROMs, packs, original sequences and derived renders are private: never commit them.

## Commands and JSON

Add `--json` for exactly one JSON object on stdout. Commands identify themselves with `command`. Ordinary failures return nonzero with one reason on stderr and no stdout. **`check` is the exception:** errors in the music return its JSON issue report and exit 1. Help is `node cli/studio.js COMMAND --help`; `--pack PATH` selects a private pack. Relative paths resolve from the working directory; default output is `music_editor/out/cli/` (git-ignored).

The table shows commands after `node cli/studio.js`, followed by abbreviated JSON shapes. Arrays and nested report objects may contain more fields; numbers below illustrate types, not measured results for an unspecified song.

| Example | JSON fields |
|---|---|
| `info --json` | `{"command":"info","rom":"sfiii3nr1","pieces":49,"samples":733,"musicSpace":{"total":188384}}` |
| `instruments --family Bass --json` | `{"command":"instruments","instruments":[{"bank":0,"program":20,"name":"Main bass","family":"Bass"}]}` |
| `pieces --json` | `{"command":"pieces","pieces":[{"code":16,"name":"…","bpm":130,"bars":32,"tracks":16,"bytes":5000}]}` |
| `piece 16 --score theme.sf3score --json` | `{"command":"piece","code":16,"name":"…","files":["…/theme.sf3score"]}` |
| `new --like 16 --out new.sf3project.json --json` | `{"command":"new","file":"…/new.sf3project.json","parts":16}` |
| `midi input.mid --out imported.sf3project.json --json` | `{"command":"midi","file":"…/imported.sf3project.json","parts":4}` |
| `arrange input.mid --out alternatives --json` | `{"command":"arrange","stem":"…","bytes":4000,"metrics":{},"report":{}}` |
| `convert song.sf3score --out song.mid --json` | `{"command":"convert","file":"…/song.mid","parts":4}` |
| `build song.sf3score --out song.sf3song.json --json` | `{"command":"build","tracks":4,"files":["…/song.sf3song.json"]}` plus byte counts/report |
| `check song.sf3score --json` | `{"command":"check","tracks":4,"issues":[{"code":"tracks.effects","level":"warn","message":"…"}]}` |
| `analyze song.sf3score --reference 16 --json` | `{"command":"analyze","metrics":{},"harmony":{},"issues":[],"targets":{},"load":{},"sections":[],"reference":{"code":16,"metrics":{}}}` |
| `render song.sf3score --wav song.wav --stems stems --json` | `{"command":"render","wav":"…/song.wav","rate":37287,"seconds":30,"peak":0.5,"stems":["…/stems/Bass.wav"]}` |
| `options song.sf3score --part Lead --programs 43,21 --bars 1-8 --out options --json` | `{"command":"options","part":"…","options":[{"program":43,"wav":"…","project":"…","gainDb":0,"expression":58}]}` |
| `brief song.sf3score --json` | `{"command":"brief","brief":"…"}` |
| `listing --piece 16 --track 1 --json` | `{"command":"listing","listing":"…"}` |
| `rom import sfiii3nr1.zip sfiii3.zip --out private-pack.js --json` | `{"command":"rom import","pack":"…/private-pack.js","revision":"…","sha256":"…"}` |
| `rom space program.bin --json` | `{"command":"rom space","space":{"total":188384,"used":0,"free":188384,"next":108863488,"pieces":[]}}` |
| `rom install --rom program.bin --song song.sf3song.json --code 50 --chorus-code 51 --out patch --json` | `{"command":"rom install","files":["…/program.bin","…/edits.json"],"report":{"placed":[],"free":180000,"total":188384}}` |

`piece` also accepts `--project`, `--midi`, `--wav` and `--listing`. `new --like` keeps the band's settings and clears notes; the browser's template additionally keeps four drum bars. `arrange` wraps the existing arranger, accepts a JS plan and optional variant index, and refuses phrases too short to arrange. CLI arrangement output goes only to `--out`.

`convert` chooses JSON, MIDI, score or song-file output from the extension. `build --plain` omits compression; `--bin` and `--listing` save raw bytes and their listing. `--bars A-B` selects an inclusive bar range before compiling, checking, analyzing or rendering. Render accepts `--piece CODE`, `--rate 44100`, `--loops 2`, `--fade 8`, `--stereo`, `--normalise`, `--exact-loop`, `--solo NAME` and `--mute NAME`. Exact loops omit the introduction and carry WAV loop points. Stems share one normalization gain. Options adjust part expression to match its isolated RMS; the 1–127 control limit can prevent an exact loudness match.

For installation, repeat `--song` and `--code` together, with corresponding `--chorus-code` values when required. Two `--rom` arguments accept the zips; one accepts a decrypted program image. `--plain` selects the compatible sequence. Follow [ROM_GUIDE.md](ROM_GUIDE.md), especially the shared bank and chorus-entry constraints.

## Reading the results

`metrics` describes the rendered audio: RMS and crest in dB, spectral band energy, loudness motion, stereo width and key-on density. Published targets describe the original 34 stage themes, using exact 10th/90th order statistics and rounded display bounds. They are musical comparisons, not acceptance quotas. The CLI measures the requested interval from its start; choose the busy bars explicitly. `load` compares driver work with original music. `harmony` reports pitch evidence and candidate interpretations; drum parts are excluded. Treat a suggested key or chord as an inference to audition. `issues` use stable `code`, severity `level`, message and part/note locations where available. Error issues block delivery; warnings need review.

Do not confuse volume with velocity or expression; they affect the driver differently. Do not normalize each stem separately, remove phrase markers, count parts instead of tracks, equate note end with silence, or install a compressed chorus entry using a plain-only parser. Do not present “within target” as proof of a good arrangement.

## Three complete scores

The score header is `cps3 score 1`. Bars are 4/4, 192 ticks, with 48 ticks per beat. `C4` is MIDI 60; `#41` is a raw kit key. `:4` is a quarter note, `:8` an eighth, `:8t` a triplet eighth, `:4.` dotted, `:=24` exact ticks. Duration and `!velocity` remain in effect across a bar line within one `bar` statement. `%` repeats the preceding bar. `r` rests, `~` slurs; `@tick` moves the cursor inside the bar. Voices and chords consume real tracks.

**A simple bass phrase:**

```text
cps3 score 1
title: Bass sketch
tempo: 120
bars: 2
loop: 1-2
markers: 2
key: D minor
part Bass program 20 volume 75 expression 64 role bass
  bar 1 | D2:4!88 A2:4 C3:4 A2:4 | D2:2 r:2 |
```

**A sliced break with a double:**

```text
cps3 score 1
title: Break sketch
tempo: 116
bars: 2
loop: 1-2
markers: 2
part Break program 1 volume 85 expression 85 pan 127 role drums
  device double offset=2 level=1 pan=0
  bar 1 | #41:8!80 #42!70 #46!52 #44!60 #45!75 #46!52 #47!60 #48!66 | % |
```

**A pad, melody and stepped automation:**

```text
cps3 score 1
title: Held light
tempo: 128
bars: 4
loop: 1-4
markers: 2
key: A minor
part Pad program 57 volume 60 expression 58 voices 3 role pad
  lane expression: 0=38 96=48 192=58 576=44
  bar 1 | [A3 C4 E4]:=384!65 | | [F3 A3 C4]:=384 | |
part Lead program 43 volume 54 expression 54 pan 24 role lead
  device echo delay=24 level=0.45 pan=110 repeats=1
  vibrato depth=24 rate=100 sync=1 delay=24 tremolo=0
  bar 1 | E4:4!74 A4:4 C5:2 | B4:4 G4:4 E4:2 | A4:2 G4:4 E4:4 | A4:2 r:2 |
```

Use `json FIELD: {...}` for lossless fields that ordinary score syntax cannot express, including custom banks and raw driver commands. Never delete those lines from a decompiled original. [FORMATS.md](FORMATS.md) links the full grammar and data contracts. [COMPOSING.md](COMPOSING.md) contains a worked eight-bar song.
