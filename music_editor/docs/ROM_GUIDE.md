# Putting Studio songs into a ROM: a guide for ROM developers

This guide is for people who build their own `sfiii3nr1` program image (Street Fighter III 3rd Strike,
Japan 990512 NO CD rev 1) and want to add music made in CPS3 Studio · Music. It covers plain songs,
compressed songs, "from the chorus" entries and custom instruments, and the Studio's generic installer
that does all of it for you.

Not every pipeline will want every feature. A plain song needs two edits and nothing else. Everything
beyond that is optional, and each section says exactly what it costs.

Everything here is proven against the game's own sound driver: the Studio runs the driver's code
(`js/engine.js`, checked against a C reference build and an in-game capture), and the gates named in
each section pass on the stock image. Nothing in this guide is a guess.

---

## 1. What a song is in the ROM

**The music space.** `067D2000..067FFFE0` (188,384 bytes) is zero in the stock program image, and no
code literal points into it (checked: every `MOV.L @(disp,PC)` literal from `06000400` to `0613C000`).
The game's own music data ends just before it. Songs, chorus entries and custom instruments all go
here, and they share this space.

**The request table.** `0678F000`: a 16-bit count (3251), then one 32-bit entry per request code at
`0678F004 + 4 × code`. An entry is the offset of the request's bytes from `0678F000`; 0 = unused. Codes
1..49 are the game's music and 96 onwards are effects and voices. **Codes 50..95 are unused in the
stock image**: put new songs there. Never replace a stage's own music; new songs go on new codes.

**A sequence** (the bytes of one song): byte 0 = 0 (music), then 16 big-endian 16-bit track offsets
from the start of the sequence (0 = no track), then the tracks. The first track starts at offset 33.
Track format: `docs/plan/02_DRIVER.md` §3.

**A plain song is two edits:**

1. the sequence bytes, written into zero-filled music space (start on an even address; the Studio
   aligns to 16);
2. the request-table entry for your code: `u32 at 0678F004 + 4 × code = (song address − 0678F000)`.

**Checks an installer must make** (the Studio's installer makes all of them):

- every byte it overwrites in the music space is zero, and the entry for the code is zero (or the
  developer explicitly asked to replace a song that is itself in the music space);
- the code is 50..95 and is not used twice in one batch;
- the sequence is well-formed: byte 0 = 0, the first track at 33, offsets distinct, every event
  complete, every jump landing on an event (the Studio's `checkSequence`, and its Python twin
  `check_sequence.py`);
- your image has no code literal pointing into the space you write (a developer may have used the
  space for something else).

A song file (`*.sf3song.json`) always carries this plain sequence in `sequence_b64`. Any pipeline that
already installs version-1 song files keeps working unchanged with Studio song files.

---

## 2. Compressed songs

A song file may also carry `compressed`: the **same song** written with the driver's own counted loops
(`D1..D3` start, `D5..D7` end, `D9..DB` last-pass exits), typically a third to two thirds of the plain
size (Capcom's 34 stage themes rebuilt and compressed: 0.62 ×
Capcom's own bytes).

- Installing it is **the same two edits**, with smaller data.
- The Studio writes `compressed` only after proving it plays exactly like the plain sequence in the
  driver (`checks.compressed_sound_identical: true` in the song file). The installer refuses a
  compressed sequence without that proof.
- Why sound is not just "the same notes on the same ticks": the driver crosses at most one non-zero
  wait per track per frame (`02_DRIVER.md` §2). A compressor that moves part of a wait onto a loop
  command can delay a note by a frame. The Studio's compressor never splits a wait (gate G5 checks the
  driver's waits event by event; G3 and G4 check the audio).

**The one thing to know: entries into the middle of a song.** A "from the chorus" entry (a ROM build can start
later rounds from a song's chorus) jumps into the song's bytes at a bar. In a plain
sequence any event is a safe landing place. In a compressed one, landing inside a counted loop breaks
the loop count. So:

- the Studio never lets a loop cross the song's chorus bar (`compressed.chorus_safe: true`);
- the Studio builds chorus entries itself (`SF3Compile.chorusEntry`, used by its installer).

**A chorus entry, byte by byte** (if you build it yourself): a small sequence of its own.

```
byte 0       0
bytes 1..32  16 track offsets, from the start of the entry; a track with nothing at or after the bar has none
per track:   D0                      loop start: the song's closing D4 00 will return here, so later
                                     passes play bar N .. end, then bar N again
             the settings in force at the bar, as the song left them, in this order and only those
             the track had set:  C1 tempo (first track only), C2 bank, C4 program, C6 volume, C8
             expression, C7 pan, C3 detune, E7 fine pitch, DE gain, E0 key sync, E1 LFO rate,
             C5 vibrato depth, E2 tremolo, C9 glide
             <wait>                  the delta from the bar line to the track's first event at or after it
             CE hh ll                a signed 16-bit jump, counted from the byte after hh ll, onto that
                                     event's command byte (past its own delta: the wait replaces it)
```

Rules: the jump must reach (±32 KB: place the entry close to the song); the landing event must be
outside every counted loop (in the song's compressed bytes, count `D1..D3` minus `D5..D7` before it:
it must be 0); the bar must lie inside the song's main loop, after its start.

**How to check an entry**: play the song from its start and the entry from its start in the driver.
From the frame the song reaches the bar, the entry must play the same: the same keys keyed on in the
same frames and the same registers on every sounding voice, through one full pass and the first loop
back. (Compare what is audible, not raw chip writes: the driver keeps writing the last note's pitch to
a silent voice; and ignore tails still ringing from before the bar, because a note's end is not a
key-off.) Gate G6 does exactly this for plain and compressed songs. Song tempo, phrase markers and
everything else carry over unchanged.

---

## 3. Custom instruments (optional)

A song may use instruments that are not in the game: new key zones, envelopes and tuning over
**stretches of the game's existing sample data** ("views": a slice of a drum loop, one cycle of a
voice, a new loop point). No new recordings can be added to this ROM: its sample space is full.

**The data** (`project.bank`, format in `docs/plan/04_FORMATS.md` §4): one block in the music space,
16-byte aligned:

```
base + 0x000  128 x u16   instrument offsets from base (0 = none)
base + 0x100  per instrument: 12 bytes per zone, then FF 00
(aligned)     views: 16 bytes each (start, loop, end, root key; u32 big-endian)
```

A zone's sample number for a view is `(view address − 0678C000) / 16`: the sample table's slots that
fall inside the music space (17920..29693).

**Size** = `align16(256 + 12 × zones + 2 × instruments) + 16 × views` bytes. Ten instruments of two
zones each with ten views = 688 bytes. It comes out of the same 188,384 bytes as the songs.

**The one extra ROM edit**: bank 8's pointer, `u32 at 06788020 = base`. That is all. Songs that use
custom instruments select bank 8 (`C2 08`).

**Why bank 8 is safe** (proven by the research project's `sound_bank8_evidence.py` and the Studio's gate G7,
neither in this repository): banks
8..14 are empty tables in the stock game; none of the 2007 requests (music, effects and voices; 2703
tracks read along the driver's own control flow) selects bank 8..14; and every request played in the
driver for its whole length (352,167 frames in all) reads bank 8's table zero times.

**One table per ROM.** All songs in one image share bank 8. Two songs that both bring custom
instruments must agree on what each instrument number is. The installer merges them (identical views
are stored once) and refuses a clash, naming the instrument. If your image already has instrument
data at bank 8 inside the music space, the installer carries it forward.

**Room left**: `Cps3Rom.musicSpace(image)` gives `{ total, used, free, next, pieces }` (it treats
everything up to the last non-zero byte of the music space as used).

Not every pipeline needs this. A song that uses custom instruments says so in its file
(`needs: [..., "instruments"]`); a pipeline that does not support them should refuse such a song
rather than install it without the instrument data (its notes would be silent).

---

## 4. The generic installer

From `music_editor`, with your own inputs and a new output folder:

```sh
node cli/studio.js rom space --program program.bin --json
node cli/studio.js build song.sf3score --out song.sf3song.json --json
node cli/studio.js rom install --rom program.bin --song song.sf3song.json --code 50 --chorus-code 51 --out patch --json
```

Use `--rom sfiii3nr1.zip --rom sfiii3.zip` instead of the program image to import the two zips. Repeat `--song` and `--code` for several songs, and supply corresponding chorus codes when needed. Omit `--chorus-code` if the project has no rounds-2+ entry. `--plain` chooses the compatible uncompressed sequence. Output includes `program.bin`, `edits.json`, `report.json` and eight encrypted program SIMMs. Choose unused request codes; the installer refuses collisions unless explicitly told to replace.

In the page, open Deliver › ROM, load the two zips or decrypted image, choose free song/chorus codes, and export to a chosen folder or download a zip. The space report includes custom instrument costs. These actions produce files; applying them to a game build is a separate developer action.


`Cps3Rom.install(image, items, opts)` (`studio_kit/core/cps3rom.js`; the same code runs in the
browser's Deliver › ROM and in Node):

```js
const result = await Cps3Rom.install(programImage, [
  { song: songFile, code: 50 },                    // plain or compressed (opts.compress, default true)
  { song: otherSong, code: 51, chorusCode: 55 },   // also a "from the chorus" entry on code 55
], { compress: true });
// result.program  the patched 16 MiB image (a copy; the input is not changed)
// result.edits    { edits: [ { owner, address, expected, replacement, rationale } ] }
// result.report   { placed: [ { kind: 'song' | 'chorus' | 'bank', address, bytes, ... } ], free, total }
```

- `image`: a decrypted 16 MiB `sfiii3nr1` program image (stock, or your own build).
- It allocates after whatever the music space already holds, checks every overwritten byte, writes the
  songs, their request entries, the chorus entries and, only when a song has custom instruments, the
  instrument data and bank 8's pointer. It never writes outside the music space except those table
  entries.
- `Cps3Rom.simms(result.program)` gives the eight encrypted program SIMM files again, for a ROM set.
  The Studio never writes into your installed ROMs; it gives you files.

**`edits.json`** is the Studio's patch format: each edit names its address (even), the bytes
expected there before, the replacement, and why. To apply it in another pipeline: for each edit, check
the image holds `expected` at `address`, then write `replacement`; refuse the whole patch if any
`expected` does not match.

**Verifying.** The Studio's preview is the game's own driver code, running in `js/engine.js`. The research
project behind the Studio compared it with a C build of the same driver (11 million log lines identical), with
an in-game capture and with MAME recordings; those comparisons are not part of this repository. Here, `node
checks/gates/g_cli.js` installs a song into the stock image from your zips and checks the report, the edits and
the image, and G3 to G6 prove in the driver that song files and chorus entries sound as the Studio previews
them (see `TESTING.md`).

---

## Where the proofs are

| What | Proven by |
|---|---|
| The engine is the driver | the research project's comparisons (C reference, in-game capture, MAME); here G1 measures 64 driver facts in the running driver |
| Studio songs sound as previewed; compressed = plain | G3 (version-1 songs), G4 (all 49 Capcom pieces rebuilt), G5 (waits) |
| Chorus entries | G6 (plain and compressed, frame by frame from the bar) |
| Custom instruments, bank 8 is free | the research project's evidence and gate G7 (not in this repository) |
| The installer | G13 (the stock image from your zips: report, exact edits, full image) |

Run `node checks/run_tests.js --roms <folder with your zips>` from `music_editor` to see them all
([TESTING.md](TESTING.md)).
