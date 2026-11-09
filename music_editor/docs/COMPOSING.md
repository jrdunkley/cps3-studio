# Writing for 3rd Strike

The sixteen tracks are sixteen monophonic chip voices. Allocate bass, drums and the essential melody early. A three-note chord costs three tracks; its echo costs three more. Actual fights borrow voices 13–16 for effects and voices. Put expendable echoes and layers there and audition the Fight Simulator. Listen in Fightcade mono before deciding a part works.

These observations come from the original sequences, the running driver and the catalog; [plan/02_DRIVER.md](plan/02_DRIVER.md) links the evidence. Names such as “main bass” describe observed roles. Some timbre descriptions come from listening and remain subjective.

Sounds identifies each voice by its bank and program, independently of the name.
These numbers are CPS3 instruments, not General MIDI program numbers. Program 57
is the sax-like reed voice formerly called “Deep pad”; a pad is one use for it,
not its instrument identity. Other unconfirmed names describe tone or use rather
than claiming an acoustic instrument. Search accepts old names as well as current
ones. Your own names take precedence; clear a custom name to restore the catalog
label. Updating labels does not change a song's instrument numbers or audio.

## Drums

Capcom mostly uses recorded breaks sliced into eighth notes. Kits 0, 1, 2, 3, 4 and 11 run near 118, 116, 124, 130, 128 and 112 BPM respectively; kits 10 and 13 also contain beat-length pieces. Use Sounds → Drums to hear the actual playable keys and original bars. Keys from 41 usually select slices. Whole-loop kits 7 and 8 behave differently; do not assume GM notes work on every kit.

In the measured corpus, 33 of 35 pieces with breaks double them one or two ticks apart. Try a Double at two ticks, opposite pan, then check mono. Kit 6 follows GM keys for kick 36, snare/clap 38/39, hats 42/46, crash 49 and ride 51. A restrained overlay can add accents without another full break. Repeating every slice at maximum velocity loses the original accent pattern.

## Bass, chords and melody

Start with the catalog's observed key range. Main bass 20 commonly uses keys 38–61 at volume/expression 75/64. Pads commonly sit near 56–64 / 58–64; leads near 48–64 / 48–64; stabs near 85/70. These are corpus medians or typical settings, not interchangeable loudness values: sample and velocity matter too. Bright lead 42 tends to sound harsh at high levels. Compare alternatives at matched loudness before moving octaves or changing the melody.

Long pads often span two to four bars. A note ending does not guarantee a long release: the driver disables its sample loop, and the chip reaches the sample end. A short-loop instrument can stop quickly despite a slow release setting. Fade its expression before note end if a smooth tail is needed.

## Movement and space

The measured 41-piece study found 152 echo tracks, usually delayed 8–32 ticks at roughly 0.53 of the source's volume × expression, often on the opposite side. Start with one quiet repeat. A Double is a much shorter copy. Both consume real tracks. Pan remains useful on a stereo board, but mono is the normal Fightcade monitor.

Glide slides between notes. Slur joins touching notes without another key-on. Capcom also writes short detune ramps into attacks and longer falls. Vibrato depth, rate and delay can leave a straight attack before movement begins. Auto-tune corrects sufficiently confident catalog measurements; audition uncertain one-shots. Duck and Gate automate levels; neither invents a filter or reverb.

Keep the song loop and phrase markers deliberate. Two- or four-bar markers identify musical transition points. A rounds-2+ bar needs a safe entry with its starting controls restored; use the Studio's song export and installer rather than jumping arbitrarily into compressed data.

## Reading the mix

Published rounded 10th–90th-percentile ranges over the 34 stage themes, measured in mono for 40 seconds:

| Measurement | Published range |
|---|---|
| Energy below 150 Hz | 49–68% |
| Low mids, 150–600 Hz | 18–30% |
| High mids, 600–2500 Hz | 6–17% |
| Highs, above 2500 Hz | 3–13% |
| Crest (peak relative to RMS) | 15.0–16.9 dB |
| Loudness motion | 6–12 dB |
| Key-ons per second | 23–42 |

These are descriptive references, not pass/fail loudness limits. Rounding changes how many themes fall inside a displayed interval. G11 checks the exact percentile order statistics and their published rounding. Studio Mix measures your busiest 20 seconds; the CLI's default analysis measures from the start of the supplied project/range. Choose `--bars` when comparing a busy section. A wrong key, missing bass or excessive density needs a musical decision, not automatic normalization.

## Eight bars to begin

Save the following as `first.sf3score`. This original example uses a GM kit, bass and a modest echoed lead; it is a starting point for listening, not a transcription of a game theme.

```text
cps3 score 1
title: Evening practice
tempo: 128
bars: 8
loop: 1-8
markers: 2
key: A minor
chorus: 5
section 1: Question
section 5: Answer

part Drums program 6 volume 72 expression 64 role drums
  bar 1 | #36:4!80 #38!68 #36!75 #38!72 | % | % | % |
  bar 5 | #36:4!80 #38!68 #36:8!75 #36!60 #38:4!72 | % | % | % |

part Bass program 20 volume 75 expression 64 role bass
  bar 1 | A2:4!88 r:8 E3:8 A2:4 G2:4 | % | F2:4 r:8 C3:8 F2:4 E2:4 | % |
  bar 5 | A2:4!88 E3:4 G2:4 E3:4 | % | F2:4 C3:4 E2:4 G2:4 | A2:2 r:2 |

part Lead program 43 volume 55 expression 54 pan 24 role lead
  device echo delay=24 level=0.45 pan=110 repeats=1
  bar 1 | E4:4!75 A4:4 C5:2 | B4:4 G4:4 E4:2 | A4:2 G4:4 E4:4 | r:1 |
  bar 5 | E4:4!75 A4:4 C5:4 B4:4 | G4:2 E4:2 | A4:4 C5:4 B4:4 G4:4 | A4:2 r:2 |
```

Build and render with the commands in [AGENT_GUIDE.md](AGENT_GUIDE.md). First listen to the bass and drums alone. Then add the melody, compare the echo in mono, and try a Duck on a held pad if you add one. Keep both the earlier version and the revision when changing the arrangement by ear.
