/* Writes the test songs in fixtures/songs/: original music, made here, saved the way the classic editor saves a
 * song (a version-1 project, built by SF3Project.build, written by SF3Project.songFile). The gates that check that
 * old songs still work (G3 upgrade, G6 song file, G8 score, G16 MIDI) read them through lib.js savedSongs(); set
 * STUDIO_SONGS to a folder of your own .sf3song.json files to run those gates on your songs instead.
 *
 *   node checks/gates/fixtures/make_songs.js        (only needed to make the fixtures again; they are kept in git)
 *
 * The scores are the examples printed in docs/COMPOSING.md and docs/AGENT_GUIDE.md. No game music is copied.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..', '..', '..');
const Score = require(path.join(root, 'js', 'score.js'));
const Project = require(path.join(root, 'js', 'project.js'));

const SCORES = {
  evening_practice: `cps3 score 1
title: Evening practice
tempo: 128
bars: 8
loop: 1-8
markers: 2
key: A minor

part Drums program 6 volume 72 expression 64 role drums
  bar 1 | #36:4!80 #38!68 #36!75 #38!72 | % | % | % |
  bar 5 | #36:4!80 #38!68 #36:8!75 #36!60 #38:4!72 | % | % | % |

part Bass program 20 volume 75 expression 64 role bass
  bar 1 | A2:4!88 r:8 E3:8 A2:4 G2:4 | % | F2:4 r:8 C3:8 F2:4 E2:4 | % |
  bar 5 | A2:4!88 E3:4 G2:4 E3:4 | % | F2:4 C3:4 E2:4 G2:4 | A2:2 r:2 |

part Lead program 43 volume 55 expression 54 pan 24 role lead
  bar 1 | E4:4!75 A4:4 C5:2 | B4:4 G4:4 E4:2 | A4:2 G4:4 E4:4 | r:1 |
  bar 5 | E4:4!75 A4:4 C5:4 B4:4 | G4:2 E4:2 | A4:4 C5:4 B4:4 G4:4 | A4:2 r:2 |
`,
  held_light: `cps3 score 1
title: Held light
tempo: 128
bars: 4
loop: 1-4
markers: 2
key: A minor
part Pad program 57 volume 60 expression 58 voices 3 role pad
  bar 1 | [A3 C4 E4]:=384!65 | | [F3 A3 C4]:=384 | |
part Lead program 43 volume 54 expression 54 pan 24 role lead
  bar 1 | E4:4!74 A4:4 C5:2 | B4:4 G4:4 E4:2 | A4:2 G4:4 E4:4 | A4:2 r:2 |
part Bass program 20 volume 75 expression 64 role bass
  bar 1 | A2:4!88 E3:4 A2:4 E3:4 | % | F2:4 C3:4 F2:4 C3:4 | % |
`,
  /* sixteen bars built the way most game themes are: a one-bar beat, a two-bar riff and a four-bar tune, repeated */
  night_run: `cps3 score 1
title: Night run
tempo: 140
bars: 16
loop: 1-16
markers: 4
key: E minor

part Kick program 6 volume 80 expression 70 role drums
  bar 1 | #36:8!96 r #38!80 r #36!96 #36!70 #38!84 r | % | % | % | % | % | % | % |
  bar 9 | #36:8!96 r #38!80 r #36!96 #36!70 #38!84 r | % | % | % | % | % | % | #38:16!70 #38 #38 #38 #38:8!84 #38 #38:4!96 #36 |

part Hats program 6 volume 60 expression 60 pan 90 role drums
  bar 1 | #42:8!60 #42!44 #42!60 #42!44 #42!60 #42!44 #46!60 #42!44 | % | % | % | % | % | % | % |
  bar 9 | #42:8!60 #42!44 #42!60 #42!44 #42!60 #42!44 #46!60 #42!44 | % | % | % | % | % | % | % |

part Bass program 20 volume 75 expression 64 role bass
  bar 1 | E2:8!90 E2 B2 E2 D3 E2 B2 G2 | C2:8 C2 G2 C2 D2:8 D2 A2 D2 | E2:8!90 E2 B2 E2 D3 E2 B2 G2 | C2:8 C2 G2 C2 D2:8 D2 A2 D2 |
  bar 5 | E2:8!90 E2 B2 E2 D3 E2 B2 G2 | C2:8 C2 G2 C2 D2:8 D2 A2 D2 | E2:8!90 E2 B2 E2 D3 E2 B2 G2 | C2:8 C2 G2 C2 D2:8 D2 A2 D2 |
  bar 9 | E2:8!90 E2 B2 E2 D3 E2 B2 G2 | C2:8 C2 G2 C2 D2:8 D2 A2 D2 | E2:8!90 E2 B2 E2 D3 E2 B2 G2 | C2:8 C2 G2 C2 D2:8 D2 A2 D2 |
  bar 13 | E2:8!90 E2 B2 E2 D3 E2 B2 G2 | C2:8 C2 G2 C2 D2:8 D2 A2 D2 | E2:8!90 E2 B2 E2 D3 E2 B2 G2 | C2:2 D2:2 |

part Lead program 43 volume 52 expression 56 pan 40 role lead
  bar 1 | r:1 | r:1 | r:1 | r:1 |
  bar 5 | B4:4.!80 A4:8 G4:4 E4:4 | G4:2 A4:2 | B4:4.!80 D5:8 B4:4 A4:4 | G4:1 |
  bar 9 | B4:4.!80 A4:8 G4:4 E4:4 | G4:2 A4:2 | B4:4.!80 D5:8 B4:4 A4:4 | G4:1 |
  bar 13 | E5:4.!84 D5:8 B4:4 A4:4 | G4:2 A4:2 | B4:4 A4:4 G4:4 F#4:4 | E4:1 |
`,
};

/* a version-2 project from the score, written the way the classic editor keeps a song (js/project.js header) */
function versionOne(p) {
  return {
    name: p.name, bpm: p.bpm, tempoChanges: [], bars: p.bars, loop: { on: !!p.loop.on, startBar: p.loop.startBar, endBar: p.loop.endBar }, markerBars: p.markerBars,
    parts: p.parts.map((part) => {
      const notes = part.notes.map((n) => ({ t: n.t, n: n.n, v: n.v, len: n.len }));
      let polyphony = 1;
      for (const a of notes) polyphony = Math.max(polyphony, notes.filter((b) => b.t <= a.t && b.t + b.len > a.t).length);
      return { name: part.name, notes, polyphony, bank: part.bank || 0, program: part.program, volume: part.volume, pan: part.pan === undefined || part.pan === null ? 64 : part.pan,
               expression: part.expression, transpose: 0, voices: Math.max(1, Math.min(4, polyphony)), mute: false };
    }),
  };
}

const out = path.join(__dirname, 'songs');
fs.mkdirSync(out, { recursive: true });
for (const [file, text] of Object.entries(SCORES)) {
  const v1 = versionOne(Score.parse(text));
  const song = Project.songFile(v1, Project.build(JSON.parse(JSON.stringify(v1))), {});
  fs.writeFileSync(path.join(out, file + '.sf3song.json'), JSON.stringify(song, null, 1) + '\n');
  console.log(`${file}.sf3song.json: ${v1.parts.length} parts, ${song.bytes} bytes`);
}
