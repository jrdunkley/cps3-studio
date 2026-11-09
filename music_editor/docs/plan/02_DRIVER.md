# 02 · The CPS3 sound driver and chip — verified reference

Everything the Studio does compiles down to what is on this page. Each statement was established by the
research project behind the Studio (scripts that read the driver's instructions in the ROM; not part of this
repository) and the driver's behaviour is measured again, in the running driver, by `checks/command_check.js`
(64 checks, gate G1) whenever the tests run.

ROM: sfiii3nr1 (Japan 990512 NO CD rev1), decrypted program SHA-256 `35ac2d56…2de0`.
Rule: **the driver is the instrument.** Never imitate it in JavaScript. To know what something sounds
like, how loud it is, or what an envelope does, run the driver (`js/engine.js`) and measure.

## 1. The chip

- 16 voices. Each plays signed 8-bit PCM from the graphics/sound flash, from `start` to `end`; when
  the loop flag is set it wraps from `end` to `loop`, otherwise the voice stops there (the chip clears
  its key bit).
- Step register: 4096 = one sample byte per output sample. Output rate 42,954,500 / 3 / 384 =
  **37,286.9 Hz**. Frame rate 59.59949 Hz (625.6 output samples per driver frame).
- Two 16-bit volumes per voice (register words 15 and 14), mixed as `(sample * volume) >> 8`.
- No filter, no reverb, no ADPCM. Anything that sounds like an effect is done with notes and commands.
- Voice registers (word index within the voice's 16 words): 2/3 start, 5 loop flag, 6 step, 7/9 loop,
  10/11 end, 14 and 15 volumes. Key mask at +0x200.
- **There is no free flash for new samples** (graphics SIMMs are full; the 42 KB after the last sample
  is in use). New sounds must be made from the existing 8.34 MB of sample data (section 6).

## 2. The driver

Entry points: init `06139316` (request table, sample table, banks, 1; two stack arguments, the second
is the **stereo switch**), request `061394D0(code)`, request with fade-in `0613A2BC`, per-frame update
`0613A408`, stop music `0613A1E8`, master pitch/level `0613A324`, tempo offset `061392FC`.

- 16 music channels (records of 0x74 bytes at `02078D0C`); channel *k* drives chip voice *k*.
- **Sound effects in a fight take voices 13–16** (tracks 13–16). Whatever a song has there is cut
  while an effect plays. Capcom puts echoes there.
- **Mono on Fightcade**: the game boots the driver with the stereo switch off, so every player hears
  mono: pan does nothing and both sides get the full level. With the switch on: pan 0 = one side only,
  127 = the other, 64 = both. The Studio monitors mono by default and offers stereo.
- Time: 48 ticks per beat, 192 per bar (4/4). Tempo word = ticks per frame × 256
  (`bpm = tempo / 256 × 59.59949 / 48 × 60`). Events fire on frame boundaries, so timing is quantised
  to 16.8 ms. That is part of the sound.
  **One wait per frame** (measured 2026-10-02; asserted by G6): each
  frame a track's wait goes down by tempo/256 ticks; when it is used up the track runs events up to the
  next non-zero delta, adds that delta to the (carried, possibly negative) wait and stops for the frame.
  At tempo 512 a note at tick 2 keys on in frame 3, but after a command at tick 1 it keys on in frame 4;
  later events are back on time. So two waits of 1 tick cost a frame each when the tempo is above 256.
  After a request, a note at tick 0 keys on in the second driver frame (`engine.frame` 2).
- **A note's end is not a key-off**: the voice keeps sounding until its sample plays out (looped
  samples stop looping, §4). Tails ring past bar lines and loop points.
- Master controls (not used by sequences): music pitch word `02079C0C` (256 = a semitone), level
  offset byte `02079C58`, tempo offset `02007EE8`, music level byte `02079C59`.

## 3. Sequence format

Byte 0 = 0 (music). Then 16 big-endian u16 track offsets (0 = unused). A track is `[delta][event]…`.
Delta: base-128 digits, bytes < 0x80, none for 0. Note length: MIDI-style variable length.

**Note**: status `0x80..0xBF` = velocity `(status & 63)`, the driver doubles it. Then the note byte
(bit 7 = **tie**), then the length in ticks.

| Command | Bytes | Meaning (channel field) |
|---|---|---|
| `C1 hh ll` | 2 | tempo word |
| `C2 n` | 1 | bank = n & 15 |
| `C4 n` | 1 | program = n & 127; used by the **next note-on** |
| `C6 n` | 1 | volume 0..127 — acts at once on a sounding note |
| `C8 n` | 1 | expression 0..127 — acts at once; 0 = silence |
| `C7 n` | 1 | pan 0..127 — acts at once (stereo only) |
| `C3 n` | 1 | detune, signed byte, **24 units** each (unit = 1/256 semitone ≈ 0.39 cent; 24 units = 9.4 cents; range ±12 semitones) — acts at once |
| `E7 n` | 1 | fine pitch, `(n − 64) × 4` units (1.56 cents each, ±1 semitone); 64 = none — acts at once |
| `DE n` / `DF n` | 1 | set / add channel gain: level × `(64 + s8 n) / 64` (0 = unity, −64 = silence, +63 ≈ ×2, clips at full scale) |
| `DC n` / `DD n` | 1 | set / add transpose in semitones, used by the next note-on (the instrument region is still chosen by the written note) |
| `C5 n` | 1 | **vibrato depth** = table[n] units (table at `0660CDF8`: 1→12, 20→29, 50→106, 65→226, 127→3048) |
| `E1 n` | 1 | **LFO rate** = table[n] (`0660CCF8`); one cycle = `2 × ceil(131072 / rate)` frames (45→148 frames, 100→14, 110→10, 115→8); 0 = LFO off |
| `E2 n` | 1 | **tremolo depth** = table[n] (`0660CEF8`); level swings around its value (64 ≈ ±25 %) |
| `E0 n` | 1 | n ≠ 0: the LFO restarts at each note-on (Capcom always uses 1) |
| `C9 n` | 1 | **portamento**: n ≠ 0 → the pitch travels from the previous note's pitch to the new note at `(n + 1) × 2` units per frame; 0 = off. The previous pitch is remembered even while off |
| `E3 n` | 1 | n ≠ 0: channel ignores the music level byte |
| `E8 i v` | 2 | write v to game byte `02079C5C + i` (phrase markers: i = 0) |
| `D0..D3` | 0 | loop start, four nesting levels |
| `D4..D7 n` | 1 | loop end for that level: **n more passes** (0 = forever) |
| `D8..DB hh ll` | 2 | on the **last** pass of that level's loop: jump forward by hh ll (from the byte after the operands) |
| `CE hh ll` | 2 | signed relative jump |
| `CF n` | 1 | continue at the start of track n |
| `CA` `CB` `CC` `CD` | 0/0/2/2 | first-pass / later-pass controls (not used by the game's music; do not emit) |
| `FF` | 0 | end of track. **Silences the voice at once** unless the instrument region has the ring-out bit |
| `C0`, `E4 E5` (2), `E6` (1), `E9..FE` | | ignored |

Loop counting: the first arrival at `D4 n` sets the counter to n and jumps back; later arrivals count
down; so the body plays n + 1 times. `D8` leaves when the counter is 1, i.e. on the last pass.

**Names in the decompiled driver.** The community decompilation of 3rd Strike rebuilds the arcade program
byte for byte; its voice sequencer (`voice_process_primary`) names every event and the channel field each
handler sets. The Studio keeps its own command names (the table above is measured) and lists these beside
them (`SF3Seq.COMMANDS[code].source`). Only names are used; no decompiled code is included.

| Code | Source name | Field set | What the source adds |
|---|---|---|---|
| `C1` `C2` `C3` `C4` | SEQ_TEMPO, SEQ_BANK, SEQ_BEND, SEQ_PROG | bgm_ticks, instrument_bank, coarse_pitch_bend, program_index | |
| `C5` `C6` `C8` `C9` | SEQ_PLFO, SEQ_VOL, SEQ_EXPR, SEQ_PORTA | pitch_lfo_depth, volume, expression, portamento_step | |
| `C7` | SEQ_PAN | pan_override | used only when the instrument patch has no pan of its own (patch pan 0xFF) |
| `CA` `CB` | SEQ_REPEAT, SEQ_END_REPEAT | loop_latch, status | first pass: back to the track start once; repeat pass: the track ends at `CB` |
| `CC` `CD` | SEQ_JUMP1, SEQ_JUMP2 | loop_latch | jump on the first pass only / on the repeat pass only |
| `CE` `CF` | SEQ_JUMP, SEQ_JUMP_TRACK | (cursor), origin | |
| `D0..DB` | SEQ_LOOP_START, SEQ_LOOP, SEQ_LOOP_EXIT (+ level) | loop_cursor, loop_count | |
| `DC` `DD` | SEQ_KEY, SEQ_KEY_ADD | transpose | |
| `DE` `DF` | SEQ_TUNE, SEQ_TUNE_ADD | volume_offset | named a tune, but the handler sets the level offset: level × `((64 + n) & 127) / 64`, so values outside −64..63 wrap (the Studio keeps gain inside it) |
| `E0` `E1` `E2` | SEQ_LFO_SYNC, SEQ_LFO_RATE, SEQ_VLFO | status, lfo_rate, volume_lfo_depth | |
| `E3` | SEQ_PRIO | priority_flags | n ≠ 0 also skips the master fade in stereo |
| `E4` `E5` `E6` | SEQ_E4, SEQ_E5, SEQ_E6 | none | read past (2, 2, 1 bytes) |
| `E7` `E8` `FF` | SEQ_FINE, SEQ_STATUS, SEQ_END | fine_pitch_control, gSeqStatus, status | |
| `C0`, `E9..FE` | SEQ_NOP; no name | none | no routine reads them: the driver moves on |

What Capcom's 49 pieces use: C1 C2 C3 C4 C5 C6 C7 C8, D0–D2 / D4–D6 / D8–DA, E0 E1 E7 E8, FF.
Never used by them: ties, C9, DE/DF, E2, DC/DD, CE, CF. All of these work (measured) and the Studio
offers them.

**Tie** (measured): a note with the tie bit gets no key-off when its length runs out, and the next
note on that track gets no key-on — its pitch simply changes. This is a true slur.

**Pitch of a note**: `(note − sample root + transpose + 7) × 256 + 0x80 + region fine tune`, then
every frame `+ vibrato + detune × 24 + (fine − 64) × 4`. A note equal to the sample's root key plays the
sample at step 0x0FE1 (37,005 Hz), i.e. at that key's concert pitch: **MIDI note numbers are driver
note numbers.**

**Level** is linear in velocity, in volume and in (expression + 1), times gain, times the region's
level trim, times the envelope.

## 4. Instruments

Bank pointer table `06788000` (16 pointers, all set). A bank = 128 u16 program offsets (0 = none),
relative to the bank. A program = a list of 12-byte regions ended by `FF`; a note uses the **first
region whose highest key is not below it**.

| Byte | Field |
|---|---|
| 0 | highest key |
| 1 | pan (`FF` = use the track's; bank 0 is all `FF`) |
| 2 | level trim, signed: × `(64 + trim) / 64` |
| 3 | not read by the driver (bank 0 keeps a key number here) |
| 4–5 | sample number, 15 bits; bit 15 = keep ringing after `FF` |
| 6 | fine tune, signed, units of 1/256 semitone |
| 7 | attack rate 0..63 |
| 8 | decay rate 0..63 |
| 9 | sustain level 0..127 |
| 10 | sustain rate 0..63 (how fast a held note keeps falling; 1 ≈ holds) |
| 11 | release rate 0..63 |

Sample table `0678C000`: 16-byte entries `start, loop, end, root key` (u32 each; offsets into the
sample data in playing order; `loop == end` means plays once). 733 used of 768.

Banks: 0 = the 59 music programs (12 kits + pitched); 1–7 and 15 = effects and voices (573
programs); **8–14 are empty tables** (a note there is silent in the stock game).

**Envelope** (level word, per frame). Peak = velocity × 2 × 256.
1. Attack: `+ step` until the peak. 2. Decay: `− step` until `peak × (sustain + 1) / 128`.
3. Sustain: `− step` until 0. 4. Release (after the note's length): `− step` until 0.
`step = reference × (table[rate] + 1) >> 16` (at least 1) where the reference is the peak (attack,
decay), the sustain level (sustain) or the level when the note ends (release, so a release is a
straight line that takes `65536 / (table[rate] + 1)` frames whatever the level). Tables: attack
`0660CBF8`, decay/sustain/release `0660CC78`, 64 words each (rate 63 = at once; decay/release rate
56 ≈ 3 frames, 48 ≈ 11 frames, 40 ≈ 43 frames, 36 ≈ 86 frames, 32 ≈ 172 frames).
The attack step is scaled again by `(velocity × 2 + 1) / 128`: soft notes also attack slower.

**The end of a note** (measured): the driver writes 0 to the chip's loop flag. A looped sample then
runs on to its `end` and the chip stops the voice there. Consequence: *a release tail is only heard
while there is sample left after the current position.* Long-loop pads (program 57: 5 s loop at its
playing pitch) get real releases; short-loop sounds stop within one loop pass whatever their release
rate. To fade such a sound, lower its expression before the note ends.

## 5. What is in bank 0 (measured; names are provisional until judged by ear)

Kits (a different sound on each key):

| Program | What | Keys | Notes |
|---|---|---|---|
| 0, 1, 2, 3, 4, 11, 12 | **break kits**: a one-bar drum loop cut into 8th-note slices | 41–48 (49) | own tempo ≈ 118, 116, 124, 130, 128, 112 BPM; played 20 semitones under root; Capcom doubles the part 1–2 ticks apart |
| 13 | break kit for the 165 BPM themes | 41–48 slices, 49–71 beat pieces | ≈ 159 BPM |
| 10 | beat-long pieces (Ryu) | 72–75 | |
| 5, 6 | single hits; **6 follows GM keys**: 36 kick, 38/39 snare/clap, 42/46 hats, 49 crash, 51 ride, 54 tambourine, 56 bell, 45 long low boom | 36–72 | in 38 of 49 pieces |
| 7, 8 | whole one-bar loops (2.0–2.6 s each) | 60–69 | opening, music 2/6/8 |
| 61 | hand percussion | 36–89 | |

Pitched (program: character, Capcom's range and usual level volume/expression):
18 sub bass (41–63, 75/75) · 19 slap bass (36–88, 75/70) · 20 main bass (38–61, 75/64) ·
21 short-loop synth tone (41–94) · 22 multi-zone strings/hits (41–72) · 37 bright stab (49–77, 85/70,
most echoed) · 38 stab 2 · 39 airy high pad (43–95, 56/58) · 40 swell, about a fourth off its root key ·
41 comping keys, 3 zones (41–93, 64/64) · 42 bright lead — harsh above volume ≈ 30–48 · 43 thin lead
(53–92, 60/58) · 44 lead 3 (55–76) · 45 slow pad · 46 strings pad, 3 zones (52–93, 64/64) ·
47 2.9 s swell · 57 deep pad, 5 s loop (43–67, 60/64) · 58 harpsichord-like pluck (57–83) ·
60 bell pluck (49–64, 90/90) · 23–36, 49–56, 59, 62: one-shot hit and chop sets (0.3–2.3 s).
Tuning: looped instruments agree with each other; one-shots 40, 23, 59, 44, 52, 60, 61, 62, 10 are
measurably off (`checks/tuning.js`). The Studio can correct this with `E7`/`C3` (auto-tune).

How Capcom produces (measured over 41 pieces, `style/README.txt`): breaks doubled 1–2 ticks apart
(33 of 35 pieces); 152 echo tracks (delay 8–32 ticks, level ≈ 0.53, opposite side, on tracks 12–16);
2,701 pitch glides written as `C3` ramps (about 5 ticks into a note, or a beat for falls); per-note
pan on 143 tracks; pads held 2–4 bars; leads low (48–64). Mix targets: energy below 150 Hz
0.49–0.68, crest 15.0–16.9 dB, 23–42 key-ons per second.

## 6. Room in the ROM

- **The cave**: `067D2000..067FFFE0` (188,384 bytes) is zero in the stock ROM and no code literal
  points into it. Songs go here; the 4-byte request-table entry `0678F004 + 4 × code` points at a
  song. Request codes 50..95 are free. Songs built by the classic editor
  repeat every note; loop compression typically brings them to 40–80 % of that, and songs written in
  patterns, as Capcom's are, take 3–6 KB each.
- **New instruments without new samples**: a region's sample number is a 15-bit index of 16-byte
  entries from `0678C000`, so indices **17920..29693 are 16-byte slots inside the cave**. A sample
  entry written there can describe *any stretch of the existing sample data* with its own start,
  loop, end and root key (a "view"): a slice of a drum loop, one cycle of a voice, a new loop point.
  A bank of new programs (key zones, envelopes, tuning) can live in the cave too; pointing bank 8's
  pointer (`06788020`) at it is the single extra ROM edit. Verified in the engine
  (`command_check.js`, last block). **Established 2026-10-02**: no request of the 2007 selects
  bank 8..14 (the research project's `sound_bank8_evidence.py`, every track of every request read along
  the driver's control flow), and played for their whole length in the driver none reads bank 8's
  table (G7). Effect and voice requests use the music header (a kind byte, then 16 track offsets);
  their track k runs on channel record 16 + k (measured for all 2,063 such tracks).
- Music itself selects bank 0 only (music 5: bank 15).
