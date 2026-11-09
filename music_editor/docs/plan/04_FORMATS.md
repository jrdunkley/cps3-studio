# 04 · Formats — the contracts every module shares

One page of truth for: the project (version 2), the song file, the text score, custom instruments,
the data pack and the ROM patch. Implementations must agree with this page; if the page is wrong,
fix the page first (and say so), then the code.

Units used everywhere: **tick** = 1/48 beat (192 per bar, 4/4). `t` = ticks from bar 1, beat 1.
**unit** = 1/256 semitone (the driver's pitch unit). MIDI note numbers = driver note numbers (60 = C4).

---

## 1. Project, version 2 (`*.sf3project.json`)

A plain JSON object. The compiler never needs anything outside it except the ROM.

```jsonc
{
  "format": "sf3project", "version": 2,
  "name": "Night Drive", "author": "", "comment": "",
  "bpm": 130,                                  // tempo at the start
  "tempoChanges": [ { "t": 3840, "bpm": 135 } ],
  "bars": 32,                                  // length in bars
  "length": null,                              // ticks; only when the song is not a whole number of bars
  "loop": { "on": true, "startBar": 5, "endBar": 32, "start": 768, "end": 6144 },
  "markerBars": 2,                             // 0 | 2 | 4: phrase markers every n bars (keep 2 unless told otherwise)
  "markers": null,                             // or [ { "t": 0, "i": 0, "v": 1 } ]: explicit E8 list, replaces markerBars
  "tempoPart": null,                           // id of the part whose track carries tempo and markers (default: the first track)
  "leadIn": 2,                                 // ticks of silence before bar 1 where set-up commands go
  "loopRestore": true,                         // every loop pass starts with the settings the first pass started with;
                                               // false: the passes run on with what the pass before left (the driver's own way; Capcom copies)
  "autoTune": true,                            // correct each instrument's measured pitch error (new songs: true)
  "key": { "root": 9, "scale": "minor" },      // or null; for display, snapping and analysis only
  "sections": [ { "bar": 1, "name": "Intro" }, { "bar": 5, "name": "Verse" } ],
  "chorusBar": null,                           // bar where rounds 2+ start (metadata for the game build)
  "parts": [ /* Part */ ],
  "bank": null,                                // custom instruments, section 4
  "names": { "0:20": "Deep bass" },            // the user's instrument names, "bank:program"
  "ui": {}                                     // editor state (zoom, colours); ignored by everything else
}
```

`loop.start` / `loop.end` (ticks) are what the compiler uses; `startBar` / `endBar` (1-based,
inclusive) are kept in step whenever the loop is bar-aligned and are what version 1 stored.
`start = (startBar − 1) × 192`, `end = endBar × 192`.

### Part

```jsonc
{
  "id": "p3", "name": "Lead", "role": "lead", "color": null,
  "bank": 0, "program": 43,
  "volume": 60, "expression": 58, "pan": 24,   // 0..127
  "transpose": 0,                              // semitones, added to every note number when building
  "gain": 0,                                   // -64..63, channel gain (DE); 0 = unity
  "tune": 0,                                   // cents, whole part
  "voices": 1,                                 // notes at once = driver tracks used
  "mute": false, "solo": false,
  "track": null,                               // 0..15: pin the first voice to this driver track
  "loopShift": 0,                              // ticks: this part's loop runs from loop.start+shift to loop.end+shift
  "end": null,                                 // ticks: where a part of a play-once piece ends (FF), if before the song's end
  "legato": false,                             // notes that touch or overlap are slurred (tie bit)
  "vibrato": { "depth": 0, "rate": 100, "sync": true, "delay": 0, "tremolo": 0 },
  "layer": null,                               // free tag, e.g. "intense": tracks the game may switch (metadata + preview)
  "notes": [ /* Note */ ],
  "automation": { /* lane name: [Point] */ },
  "devices": [ /* Device */ ],
  "raw": []                                    // [ { "t", "post", "op", "a": [..] } ] driver commands kept verbatim
}
```

`role`: `drums | perc | bass | chords | pad | lead | arp | fx` or null. It picks the colour, feeds the
analysis and the suggestions; it never changes the sound.

`bank`, `program`, `volume`, `expression`, `pan` may be `null`: the part never sets that setting, so the
driver keeps its own (copies of Capcom tracks that never set it).

### Note

`{ "t": 384, "n": 69, "v": 100, "len": 24 }` plus, all optional:

| Field | Meaning |
|---|---|
| `tie` | true: slur into the next note of the same voice (no key-off, next note not re-struck) |
| `slide` | 1..127: glide into this note from the previous one at `(slide + 1) × 2` units per frame (C9) |
| `cents` | fine tuning of this note, −100..100 |
| `bend` | `[[dt, value], …]`: detune during the note, `dt` ticks after its start, `value` in C3 steps (24 units, −128..127). Same as version 1 |
| `bank`, `program`, `volume`, `expression`, `pan` | this note only (version-1 style; lanes are preferred in new work) |

`v` is 1..127; the driver has 63 velocity steps (built as `round(v / 2)`, at least 1).

### Automation lanes

Each lane is a list of points `{ "t": tick, "v": value, "post": true?, "pre": true? }`, sorted by `t`.
A point is a **step**: the value holds until the next point. `post` = takes effect *after* a note that
starts on the same tick (default: before it). `pre` = takes effect before the loop start (`D0`) on the
same tick (17 of Capcom's tracks have a command there); on the part's last
tick (its loop end, or its `end`), a `pre` point is written before the loop end or `FF` (Capcom does
this on 14 tracks). Raw commands and `markers` take `pre` and `post` the same way. `t` may be negative
down to `−leadIn`.

| Lane | Command | Value |
|---|---|---|
| `volume`, `expression`, `pan` | C6, C8, C7 | 0..127 |
| `pitch` | C3 + E7 | cents, any number (resolved to 1.56 cent steps) |
| `detune` | C3 | raw −128..127 (24 units each) |
| `fine` | E7 | raw 0..127 (64 = none) |
| `gain` | DE | −64..63 |
| `vibDepth`, `vibRate`, `tremolo` | C5, E1, E2 | 0..127 (table index) |
| `vibSync` | E0 | 0 or 1 |
| `slide` | C9 | 0..127 |
| `program` | C4 (and C2 when `bank` is given: `{ "t", "v": program, "bank": 0 }`; `"v": null` with a `bank` = C2 alone) | 0..127 |

Resolution rules (the compiler's, stated once):
- A point writes its own setting (only if it differs from what the track already has). At each note-on
  every setting is worked out and a command written where it differs. The set-up (tick 0: tempo, bank;
  tick 1: the rest) writes only what no lane sets before the part's first note.
- `loopRestore` true: commands straight after `D0` put back every setting some pass would enter
  differently. False: nothing is put back; a setting that a pass can enter differently is written by
  the next point that sets it, and a note that wants what the first pass had keeps what the pass
  brought (exactly how the driver plays a loop; proven in G6 against the song written out twice).
- Expression = (lane value in force, else the note's own `expression`, else the part's) × Duck ×
  Gate × the device's level, rounded and clamped to 0..127.
- Pitch offset in units = `24 × (detune lane + note bend) + 4 × (fine lane − 64) +
  round(2.56 × (pitch lane + part tune + auto-tune + note cents))`, written as
  `C3 = round(units / 24)` (clamped) and `E7 = 64 + round(remainder / 4)`. `E7` is only emitted when
  it differs from 64 at some point in the track.
- Auto-tune = `−tuningCents` of the catalog entry `"bank:program"`, **only when its `tuningConfidence`
  is at least 0.8** (`SF3Compile.AUTO_TUNE_SURE`). Unpitched and noisy sounds measure anything
  (program 10 would otherwise move −5.6 semitones); 18 of the music bank's pitched
  programs qualify.
- Set-up: tempo and bank at tick 0, every other setting at tick 1 (version 1's layout, part of how
  existing songs sound). A cycle build (`range`) puts all of it at tick 0: the driver crosses at most
  one non-zero wait per frame (02_DRIVER §2), so a 1-tick wait just before the first notes would play
  them a frame late against the same notes inside the song.

### Devices

`{ "type": …, "on": true, … }`. Off devices are kept and ignored.

| Type | Fields (defaults) | Compiles to |
|---|---|---|
| `echo` | `delay` 24 ticks, `level` 0.5, `pan` `"opposite"` or 0..127, `interval` 0 semitones, `voices` (all), `repeats` 1 | one extra track per voice (and per repeat): the same notes and lanes `delay` ticks later, expression × level |
| `double` | `offset` 2 ticks, `pan` `"opposite"`, `detune` 0 cents, `level` 1 | one extra track per voice; with `detune` ≠ 0 it is a unison/chorus |
| `harmony` | `interval` −7, `level` 0.7, `pan` null | one extra track per voice at the interval |
| `duck` | `source` part id, `keys` null or list, `depth` 0.6, `hold` 6, `release` 24 ticks | expression dips on this part at each source note |
| `gate` | `pattern` 16 steps of 0..1, `depth` 1, `step` 12 ticks | expression pattern |
| `autopan` | `mode` `"pingpong"`, `width` 48, `center` 64 | pan per note, alternating |
| `glide` | `mode` `"slurred"` or `"all"`, `rate` 40 | sets `slide` on the notes it applies to |
| `swing` | `amount` 0..0.5, `unit` 24 ticks | delays every second `unit` |
| `humanize` | `timing` 0 ticks, `velocity` 6, `seed` 1 | deterministic small changes (same seed → same bytes) |

Extra tracks from devices are placed after every part's own voices, so a fight's effects (tracks
13–16) take them first. A delayed copy loops later by its delay (`loopShift`), so it is an exact
delayed copy forever.

### Version 1 → 2 (`SF3Compile.upgrade`)

A version-1 project (`{ name, bpm, tempoChanges, bars, loop{on,startBar,endBar}, markerBars, parts[…] }`,
no `version`) becomes version 2 by adding defaults: `leadIn` 2, `loopRestore` true, **`autoTune`
false**, loop ticks from the bars, part ids, empty lanes and devices. The result must sound identical
(gate G3). Version-1 files keep opening forever. `upgrade` of a version-2 project returns it unchanged.

---

## 2. Song file (`*.sf3song.json`) — what goes into a ROM

Version 1 fields, all kept (the game build reads `sequence_b64` and `name`):

```jsonc
{ "format": "sf3song", "version": 1, "name", "bpm", "bytes", "sequence_b64",
  "loop_ticks": [start, end] | null, "marker_bars", "tracks": [ { "track", "part", "bank", "program", "notes" } ],
  "names": {}, "project": { … } }
```

Version 2 adds (old readers ignore them):

```jsonc
{ "version": 2,
  "compressed": {                                    // present when "Compress loops" is on (the default)
    "sequence_b64": "…", "bytes": 6120,              // the same song with driver loops: same sound, far smaller
    "chorus_safe": true },                           // no loop crosses the chorus bar (a chorus entry may jump in there)
  "chorus_bar": 17,                                  // where rounds 2+ start, or null
  "layers": { "intense": [9, 10] },                  // driver tracks per layer tag
  "bank": null | { …section 4… },                    // custom instruments this song needs, or null
  "needs": [ "song" ],                               // what a ROM must install: "song", + "chorus-entry", + "instruments"
  "checks": { "compressed_sound_identical": true, "driver_load": 0.71, "tracks": 13, "issues": [] },
  "studio": "1.0" }
```

**Two rules that keep every existing ROM build safe:**

1. **`sequence_b64` is always the plain, version-1-compatible sequence** (every note written out, one
   loop). A build that knows nothing about the Studio (such as an existing ROM build script)
   keeps working, unchanged, with any song file. The compressed sequence travels *beside* it in
   `compressed`; only an installer that asks for it uses it.
2. The compressed sequence is written only after it has been proven sound-identical to the plain one.

Why an installer must *know* about compression: a build that starts later rounds "from the chorus"
(as some ROM builds do) jumps into the middle of the song's bytes. In a plain
sequence any event is a safe landing place. In a compressed one, landing inside a counted loop
breaks it. So: (a) the Studio never lets a loop cross `chorus_bar` (`chorus_safe`), and (b) the
chorus entry must be built by something that reads loops. **The Studio builds chorus entries itself**
(`SF3Compile.chorusEntry`, used by its own installer), so a ROM developer does not have to. A
developer with their own pipeline can either keep using the plain sequence, or follow
`docs/ROM_GUIDE.md`.

Raw export: `<name>.bin` = the sequence bytes (plain or compressed, as chosen); `<name>.listing.txt`
= the readable listing.

### The generic installer (`Cps3Rom.install`, CLI `studio rom install`, Deliver › ROM)

Input: a decrypted program image (stock, or a developer's build), and for each song: the song file,
a request code, optionally a second code for its chorus entry. It allocates in the cave after
whatever is already there, writes each piece, checks every byte it overwrites is zero, and returns
`edits.json` (section 6), the patched image, and a report of what went where and how much room is
left. Pieces: the sequence (compressed if present, unless told otherwise) · the request-table entry ·
the chorus entry and its request-table entry (when asked) · the instrument data and the bank pointer
(only when the song has `bank`). It then replays the patched image in the driver and requires the
same audio as the Studio's preview.

---

## 3. Text score (`*.sf3score`) — the same project as readable text

For people who like text and for AI agents. `SF3Score.parse(text)` → project;
`SF3Score.print(project)` → text; `print` then `parse` gives back the same project (gate G8).

```
cps3 score 1
title: Night Drive
tempo: 130
bars: 16
loop: 5-16
markers: 2
key: A minor
section 1: Intro
section 5: Verse

part Bass  program 20  volume 75  expression 64  pan 64  role bass
  device echo delay=24 level=0.5 pan=127
  bar 1 | E2:8 E2 G2 A2 B2:4 A2:8 G2 | % |
  bar 3 | E2:8 r E3:16 E3 r:8 D3 B2:4. | % |

part Break  program 1  volume 90  expression 88  pan 127  role drums
  device double offset=2
  bar 1 | #41:8 #42 #46!52 #44!60 #45 #46!52 #47!60 #48 | % | % | % |

part Pad  program 46  volume 64  expression 64  pan 108  voices 3
  lane expression: 0=40 96=52 192=64
  bar 1 | [A3 C4 E4]:=384 | | [F3 A3 C4]:=384 | |
```

Grammar:

- Lines starting with `#` followed by a space, and blank lines, are ignored. The first real line is
  `cps3 score 1`.
- Header lines `key: value`: `title`, `author`, `tempo`, `bars`, `loop` (`a-b` bars or `off`),
  `markers` (0, 2, 4), `key`, `lead`, `autotune` (`on`/`off`), `chorus` (bar), `section N: name`,
  `tempo-change <bar>.<beat>: <bpm>`.
- `part <name>` then `word value` pairs on the same line: `program bank volume expression pan
  transpose gain tune voices track role legato`. Names with spaces go in double quotes.
- Indented lines under a part:
  - `device <type> key=value …`
  - `lane <name>: tick=value tick=value! …` (`!` = `post`)
  - `vibrato depth=50 rate=110 sync=1 delay=48 tremolo=0`
  - `json <field>: <one-line JSON>` — anything else, kept exactly (also valid at top level, e.g. `json bank: {…}`)
  - voice lines: `[v<N>] bar <N> | <bar> | <bar> | …`
- Inside a bar, tokens left to right, a cursor starting at the bar line:
  - note `C4`, `F#3`, `Bb2` (C4 = 60) or raw key `#41`; chord `[A3 C4 E4]`; rest `r`
  - `:<dur>` length: `1 2 4 8 16 32` (fractions of a whole note), `.` dotted, `t` triplet
    (`8t` = 16 ticks), or `:=<ticks>` exact. **Sticky**: stays for the following tokens of the line.
  - `!<vel>` velocity 1..127, sticky. `~` slur into the next note. `{slide=40 cents=-14 pan=20}` extras.
  - `@<ticks>` moves the cursor to that tick of the bar (for notes off the grid and overlaps).
  - `%` alone in a bar repeats the previous bar of that voice.
- A note may be longer than what is left of the bar: it keeps sounding; the cursor stops at the bar
  line. A bar may be left short (the rest is silence). **A bar that runs over is an error**, reported
  as `part "Bass", bar 7: 12 ticks too long (204 of 192)`: a token that would *start* at or after the
  bar line, or a rest that runs past it. Errors always name the part, the bar and the token.
- As built (`js/score.js` is the reference): lane points take `!` for `post` and `<`
  for `pre`; note extras include `{bend=dt:v;dt:v}`; a bar may continue on the next line; `:8`, `!90`,
  `~` and `{…}` may stand alone; sticky length and velocity reset at each `bar` line and `%` leaves
  them unchanged; `json order: […]` appears only when a project's notes are not in canonical order.
  The header `markers: 2` is `markerBars`; an explicit E8 list is `json markers: […]`. Kit parts print
  raw keys only when the printer is given the instrument banks (`print(p, { banks })`) or the role is
  drums/perc; parsing never depends on it. Anything `print` cannot say exactly goes to a `json` line.
- Several notes at once: chords, or several voice lines (`v1 bar 1 | … |`, `v2 bar 1 | … |`).

`print` writes one voice line per simultaneous voice, four bars to a line, uses `%` for repeated
bars, the shortest length spelling, and falls back to `@` and `:=` for anything off the grid.

---

## 4. Custom instruments (`project.bank`)

```jsonc
{ "slot": 8,
  "views": [ { "id": "v1", "name": "Loop 7 slice 3", "source": 590, "start": 4321000, "loop": null, "end": 4327000, "root": 83 } ],
  "programs": {
    "0": { "name": "Voice pad", "regions": [
      { "keyHigh": 127, "sample": { "view": "v1" },        // or { "rom": 102 } for a sample of the ROM's own table
        "pan": null, "level": 0, "fine": 0,
        "attack": 63, "decay": 63, "sustain": 127, "sustainRate": 1, "release": 63, "ringOut": false } ] } } }
```

`start`, `loop`, `end`: byte offsets into the sample data in playing order (0..0x7F5B9D), as the ROM's
own sample table stores them; `loop: null` = plays once. `source` records which ROM sample the view
was cut from.

**Blob** (`SF3Bank.buildBlob(bank, base)`), for the engine preview and the ROM alike. `base` must be
inside the cave and a multiple of 16:

```
base + 0x000   128 × u16   program offsets from base (0 = none)
base + 0x100   regions     per program: 12 bytes per zone, then FF and one 00, so every program's list
                           starts at an even offset (Capcom's own layout: 632 of 632 program offsets
                           are even and 620 lists end FF 00)
(aligned to 16) views      16 bytes each: start, loop (or end), end, root   (u32 big-endian)
```

Region bytes as in `02_DRIVER.md` §4; byte 3 = root key; the sample number of a view is
`(view address − 0x0678C000) / 16` (17920..29693); bit 15 = `ringOut`. Result also gives the one ROM
edit: `u32 at 0x06788000 + 4 × slot = base`.

In the engine the blob goes to `0x067F2000` of the Studio's private copy. In a ROM it goes wherever
the installer allocates in the cave (it is rebuilt for that base).

**What custom instruments cost, stated wherever they appear** (Designer, Deliver, the guide):

- Size in the ROM = `align16(256 + 12 × zones + 2 × instruments) + 16 × views` bytes, exactly the
  blob's length. Ten instruments of two zones each with ten views = 688 bytes (0.7 KB). The music
  space in the ROM is 188,384 bytes in total and is **shared with the songs** themselves.
- Limits: 128 instruments in the custom bank; a zone's sound is always a stretch of the game's
  existing sample data — **no new recordings can be added to this ROM** (its sample space is full).
- **A ROM needs one extra change to play them**: the instrument data in the music space, and the
  game's bank-8 pointer set to it. Songs that use only the game's own instruments need nothing extra.
  Not every ROM build or developer will support custom instruments; a song that uses them says so in
  its file (`needs: [..., "instruments"]`) and in Deliver, and the Studio's own installer does it.
- One instrument table is shared by every song in a ROM. Two songs that both bring custom instruments
  must agree on what each instrument number is; the installer refuses a clash and says which.

---

## 5. Data pack (private, made from the user's ROM)

`data/pack.js` (version 1, exists): `SF3_PACK = { version, rom, program_sha256, names, prg: [ { addr,
b64 } ], samples_b64 }`. Version 2 (new, also what the browser stores in IndexedDB) may carry bytes
instead of base64 and a game description, so nothing in the engine is tied to one ROM:

```jsonc
{ "version": 2, "rom": "sfiii3nr1", "program_sha256": "35ac…",
  "names": { "16": "Chun-Li" },
  "prg": [ { "addr": 101941248, "bytes": Uint8Array } ],
  "samples": Uint8Array,
  "game": { "fn": { "setBank", "init", "request", "requestFade", "update", "pitchVolume", "tempoOffset", "stopMusic" },
            "tables": { "request", "samples", "banks" }, "channels", "tempo", "marker", "stereoFlag",
            "cave": [ 108863488, 109051872 ] } }        // 0x067D2000, 0x067FFFE0 (corrected 2026-10-02: was 0x100000 too high)
```

The engine accepts both versions; with no `game` it uses the sfiii3nr1 addresses it has today.
Never publish a pack, and never write one anywhere except `data/` and browser storage.

## 6. ROM patch

`edits.json`, the Studio's patch format:

```jsonc
{ "edits": [ { "owner": "music_studio", "address": "0x67d2000", "expected": "0000…", "replacement": "00210…", "rationale": "song \"Night Drive\"" } ] }
```

Addresses and lengths even; `expected` = the bytes there before. A song install is: the sequence into
the cave, the request-table entry, optionally a chorus entry with its own request-table entry, and —
only with custom instruments — the instrument data and the bank pointer. The Studio can also write
the patched program SIMM files (re-encrypted) into a zip for a stock ROM set; that never touches the
user's installed ROMs. How a developer does the same in their own pipeline: `docs/ROM_GUIDE.md`.
