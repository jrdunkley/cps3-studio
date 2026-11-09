/* Arrange any MIDI file in the style of 3rd Strike's own music (node style/arrange3s.js <midi|plan.js> [variant]).
 *
 * What it copies from Capcom (all measured from the game's music, see style/README.txt):
 *  - drums are breakbeats: a kit of 8th-note slices of a real drum loop, re-sequenced to follow
 *    the MIDI's kick and snare, using Capcom's own bar patterns when one fits (style/breaks.js),
 *    played twice 2 ticks apart; hats, cymbals and percussion come from kit 6 on their own tracks;
 *  - instruments by role (bass, pad, chords, lead, counter line, arpeggio) in the note ranges
 *    Capcom plays them, at Capcom's levels for that role;
 *  - echoes: a later, quieter copy of the lead, chords and pad on the tracks a fight's sound
 *    effects take first (13 to 16);
 *  - glides: the MIDI's pitch bends, portamento between legato lead notes and a scoop into chord
 *    stabs, all as the driver's detune command (24/256 semitone units);
 *  - pads held to the next chord, ping-pong pan on stabs and percussion, phrase markers every 2 bars.
 *
 * A plan (optional) is a .js file exporting { midi, name, file, bpm?, bars?: [first, last] (1-based),
 * loopStart?: bar, parts?: { '<MIDI part name>': { role, program, octave, voices, level, echo, glide } },
 * drums?: { kit, boom, kickLayer, hats }, variants?: [ { ...overrides } ] }.
 * Without a plan, everything is chosen from the MIDI. Writes out/style_out/<file>.*
 * (sf3project.json for the editor, sf3song.json for the game, wav as the game plays it, report.txt).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
if (!globalThis.SF3_PACK) require(path.join(root, 'data', 'pack.js'));
const { Engine, CHIP_RATE } = require(path.join(root, 'js', 'engine.js'));
const Seq = require(path.join(root, 'js', 'seq.js'));
const Midi = require(path.join(root, 'js', 'midi.js'));
const Project = require(path.join(root, 'js', 'project.js'));
const Capcom = require('./capcom.js');
const Metrics = require('./metrics.js');

const BAR = Seq.BAR, BEAT = 48;
const OUT = path.join(root, 'out', 'style_out');
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const median = (xs) => { if (!xs.length) return 0; const s = xs.slice().sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const UNITS_PER_SEMITONE = 256 / 24;

/* ---- Capcom's levels and placement per role (medians of the game's own tracks) ------------- */
const ROLE = {
  break:   { vol: 85, expr: 85, v: 60, pan: 127 },
  hats:    { vol: 70, expr: 64, v: 40, pan: 24 },
  cymbals: { vol: 64, expr: 64, v: 40, pan: 112 },
  boom:    { vol: 85, expr: 85, v: 55, pan: 64 },
  kick:    { vol: 75, expr: 72, v: 55, pan: 64 },
  perc:    { vol: 70, expr: 70, v: 40, pan: 112 },
  bass:    { vol: 75, expr: 64, v: 50, pan: 64 },
  lead:    { vol: 56, expr: 52, v: 44, pan: 24, echo: { delay: 24, level: 0.5 } },        // leads sit low (Capcom 48-64 / 48-64)
  pad:     { vol: 64, expr: 64, v: 40, pan: 108, echo: { delay: 16, level: 0.55 } },
  chords:  { vol: 80, expr: 64, v: 38, pan: 64, echo: { delay: 20, level: 0.5 } },
  counter: { vol: 64, expr: 64, v: 42, pan: 96, echo: { delay: 20, level: 0.5 } },
  arp:     { vol: 72, expr: 72, v: 40, pan: 40, echo: { delay: 24, level: 0.5 } },
};
/* instrument per role, steered by the MIDI part's GM program (-1 = none given). Where the previous
 * arrangements were judged by ear the same choice is used: slap bass 19, strings 46, sax 42,
 * harpsichord 58. The rest follows how Capcom uses each program. */
function pickProgram(role, gm) {
  const in_ = (a, b) => gm >= a && gm <= b;
  if (role === 'bass') return in_(36, 37) ? 19 : in_(38, 39) ? 18 : 20;
  if (role === 'pad') return in_(88, 95) ? 57 : in_(16, 23) ? 22 : in_(0, 7) ? 39 : 46;          // held piano chords: Jazzy NYC's pad
  if (role === 'chords') return in_(0, 3) || gm === 6 ? 58 : in_(4, 5) || gm === 7 || in_(8, 15) ? 60 : in_(16, 31) ? 22 : in_(40, 55) ? 46
    : in_(56, 63) ? 37 : in_(88, 95) ? 39 : 37;
  /* a sax lead on 42 was judged "bad and too loud", on 57 right */
  if (role === 'lead' || role === 'counter') return in_(64, 67) ? 57 : in_(68, 79) || in_(52, 54) ? 42 : in_(56, 63) ? 43 : in_(80, 87) || in_(24, 31) ? 44
    : in_(0, 7) ? 58 : in_(40, 51) ? 46 : role === 'lead' ? 43 : 44;
  if (role === 'arp') return in_(4, 15) ? 60 : 58;
  return 43;
}

/* ---- MIDI drums -> categories ----------------------------------------------------------------- */
function drumCategory(key) {
  if (key === 35 || key === 36) return 'K';
  if (key === 38 || key === 40) return 'S';
  if (key === 37) return 'side';
  if (key === 39) return 'clap';
  if (key === 42 || key === 44) return 'CH';
  if (key === 46) return 'OH';
  if (key === 49 || key === 57 || key === 52 || key === 55) return 'crash';
  if (key === 51 || key === 59 || key === 53) return 'ride';
  if ([41, 43, 45, 47, 48, 50].includes(key)) return 'tom';
  return 'perc';
}
const TOM_DETUNE = { 41: -64, 43: -54, 45: -43, 47: -32, 48: -16, 50: 0 };   // low toms = slices tuned down (C3 units)
/* kit 6 keys for the overlay (kit 6 follows GM for these: 36 kick, 38/39 snare/clap, 42/46 hats, 49 crash, 51 ride, 54 tambourine, 56 bell) */
const OVERLAY_KEY = { CH: 42, OH: 46, crash: 49, ride: 51, clap: 39, side: 39 };
const PERC_KEY = (k) => ({ 54: 54, 56: 56, 69: 53, 70: 55, 82: 55, 81: 54, 75: 53, 76: 53, 77: 53 })[k] || (k >= 60 && k <= 68 ? 53 : null);

/* ---- part analysis ------------------------------------------------------------------------- */
function analyse(part, songTicks) {
  const notes = part.notes;
  const keys = notes.map((n) => n.n).sort((a, b) => a - b);
  const edges = [];
  for (const n of notes) { edges.push([n.t, 1]); edges.push([n.t + n.len, -1]); }
  edges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0, last = 0, sounding = 0, weighted = 0;
  for (const [t, d] of edges) { if (cur > 0) { sounding += t - last; weighted += cur * (t - last); } cur += d; last = t; }
  /* chords: onsets with two or more different notes (octave doubles, as in a doubled bass line, are one note) */
  const onsets = new Map();
  for (const n of notes) { const t = Math.round(n.t / 3); if (!onsets.has(t)) onsets.set(t, new Set()); onsets.get(t).add(n.n % 12); }
  let chordy = Array.from(onsets.values()).filter((c) => c.size >= 2).length / Math.max(1, onsets.size);
  let legato = 0, pairs = 0;
  for (let i = 1; i < notes.length; i++) { const gap = notes[i].t - (notes[i - 1].t + notes[i - 1].len); if (notes[i].t > notes[i - 1].t) { pairs++; if (Math.abs(gap) <= 3) legato++; } }
  const avgPoly = sounding ? weighted / sounding : 0, medKey = keys[keys.length >> 1];
  /* stacks of three or more octaves above the bass register (string sections) are chords, not a
   * tune; a melody doubled at one octave (about 2 notes at once) stays a melody */
  if (chordy < 0.3 && avgPoly >= 2.5 && medKey >= 52) chordy = 0.5;
  return { count: notes.length, low: keys[Math.floor(keys.length * 0.05)], high: keys[Math.floor(keys.length * 0.95)], median: keys[keys.length >> 1],
           avgPoly: sounding ? weighted / sounding : 0, chordy, coverage: sounding / Math.max(1, songTicks), medLen: median(notes.map((n) => n.len)),
           legato: pairs ? legato / pairs : 0, gm: part.program === null ? -1 : part.program };
}

function guessRoles(parts, songTicks) {
  const melodic = parts.filter((p) => !p.drums);
  for (const p of melodic) p.stats = analyse(p, songTicks);
  /* the same line twice (octave doubles, layered patches), or a delayed copy already written into
   * the MIDI as an echo: keep the first, busier one (the arranger makes its own echoes) */
  for (const a of melodic) for (const b of melodic) {
    if (a === b || a.double || b.double || a.stats.count < b.stats.count || (a.stats.count === b.stats.count && melodic.indexOf(a) > melodic.indexOf(b))) continue;
    const best = new Map();
    const at = new Map();
    for (const n of a.notes) { const k = n.n % 12; if (!at.has(k)) at.set(k, []); at.get(k).push(n.t); }
    for (const n of b.notes) for (const t of at.get(n.n % 12) || []) { const d = Math.round((n.t - t) / 2) * 2; if (d >= 0 && d <= 96) best.set(d, (best.get(d) || 0) + 1); }
    let top = 0, delay = 0;
    for (const [d, c] of best) if (c > top || (c === top && d < delay)) { top = c; delay = d; }
    /* and played alike: held strings over a chugging guitar on the same notes are not a copy */
    const alike = Math.max(a.stats.medLen, b.stats.medLen) <= 2 * Math.max(1, Math.min(a.stats.medLen, b.stats.medLen));
    if (top >= 0.8 * b.notes.length && alike) b.double = delay ? `${a.name}, ${delay} ticks later` : a.name;
  }
  for (const p of melodic) if (p.stats.gm >= 112 && !p.double) p.effect = true;      // GM percussive/sound-effect patches
  const live = melodic.filter((p) => !p.double && !p.effect && p.stats.count >= 4);
  const roles = new Map();
  for (const p of live) if (p.role) roles.set(p, p.role);            // given by whoever made the part (splitPiano)
  const gmFamily = (p) => p.stats.gm >= 0 ? p.stats.gm >> 3 : -1;
  /* bass: the low, mostly single-note part */
  const bassCands = live.filter((p) => !roles.has(p) && (p.stats.median < 50 || gmFamily(p) === 4) && p.stats.chordy < 0.35);
  bassCands.sort((a, b) => b.stats.count * b.stats.coverage - a.stats.count * a.stats.coverage);
  if (bassCands[0] && !Array.from(roles.values()).includes('bass')) roles.set(bassCands[0], 'bass');
  /* chords and pads: parts that play chords */
  for (const p of live) if (!roles.has(p) && p.stats.chordy >= 0.3 && p.stats.avgPoly >= 1.6) roles.set(p, p.stats.medLen >= 72 ? 'pad' : 'chords');
  /* long low notes under the bass line (Deeper Underground's "Bass Pad"): a drone pad */
  for (const p of live) if (!roles.has(p) && p.stats.median < 50 && p.stats.medLen >= 96) roles.set(p, 'pad');
  /* lead: the busiest high single-note line */
  const melodies = live.filter((p) => !roles.has(p) && p.stats.median >= 55);
  /* a tune moves: stutters (one note repeated very short) and drones score low */
  const moves = (p) => { let m = 0; for (let i = 1; i < p.notes.length; i++) if (p.notes[i].n !== p.notes[i - 1].n) m++; return m / Math.max(1, p.notes.length - 1); };
  /* a part named for the singer or the tune is the tune (Through the Fire and Flames: the vocals, not the shred) */
  const named = (p) => /vocal|vox|voice|melody|singer|sing\b/i.test(p.name) && !/backing|choir|harmony/i.test(p.name);
  const salience = (p) => p.stats.count * Math.sqrt(p.stats.coverage + 0.05) * (p.stats.median / 72) * Math.sqrt(Math.min(1, p.stats.medLen / 24)) * (0.3 + moves(p))
    * ([8, 7, 10, 9].includes(gmFamily(p)) ? 1.3 : [5, 6, 11].includes(gmFamily(p)) ? 0.6 : 1) * (named(p) ? 6 : 1);
  melodies.sort((a, b) => salience(b) - salience(a));
  if (melodies[0] && !Array.from(roles.values()).includes('lead')) roles.set(melodies[0], 'lead');
  for (const p of live) {
    if (roles.has(p)) continue;
    if (p.stats.medLen <= 12 && p.stats.count >= 32) roles.set(p, 'arp');
    else if (p.stats.chordy >= 0.3) roles.set(p, p.stats.medLen >= 72 ? 'pad' : 'chords');
    else roles.set(p, 'counter');
  }
  return roles;
}

/* ---- breakbeat drums ------------------------------------------------------------------------- */
function chooseKit(bpm, lib, wanted) {
  if (wanted !== undefined && wanted !== 'auto') return Number(wanted);
  const cands = [0, 1, 3, 4, 11, 2].map((k) => ({ k, tempo: lib.kits[k].tempo }));
  if (bpm >= 148) cands.push({ k: 13, tempo: lib.kits[13].tempo });
  /* slices may be cut short (song faster than the kit) more freely than leave gaps (slower) */
  const cost = (c) => { const r = Math.log(bpm / c.tempo); return r >= 0 ? r : -r * 2.5; };
  cands.sort((a, b) => cost(a) - cost(b));
  return cands[0].k;
}

/* pattern grid of a Capcom bar for one kit: kick/snare per 16th */
function grid(notes, kit) {
  const k = new Array(16).fill(0), s = new Array(16).fill(0);
  for (const n of notes) {
    const step = Math.round(n.t / 12);
    if (step > 15 || Math.abs(n.t - step * 12) > 3) continue;
    const role = kit.keys[n.n] ? kit.keys[n.n].role : 'ghost';
    if (role === 'kick') k[step] = 1; else if (role === 'snare') s[step] = 1;
  }
  return { k, s };
}

function breakBar(hits, kit, kitNo) {
  const K = new Array(16).fill(0), S = new Array(16).fill(0), T = new Array(16).fill(null), V = new Array(16).fill(0);
  for (const h of hits) {
    const step = Math.round(h.t / 12);
    if (step > 15) continue;
    if (h.cat === 'K') K[step] = 1; else if (h.cat === 'S' || h.cat === 'clap') S[step] = 1;
    else if (h.cat === 'tom') T[step] = h.key; else continue;
    V[step] = Math.max(V[step], h.v);
  }
  const nK = K.reduce((a, b) => a + b, 0), nS = S.reduce((a, b) => a + b, 0), nT = T.filter((x) => x !== null).length;
  if (!nK && !nS && !nT) return { notes: [], how: 'none' };
  const beatPieces = kitNo === 13 || kitNo === 10;
  /* 1. one of Capcom's own bars, if its kicks and snares are the MIDI's */
  if (!nT || nT < 3) {
    let best = null;
    for (const p of kit.patterns) {
      if (p.notes.length < 4) continue;
      const g = grid(p.notes, kit);
      let score = 0;
      for (let i = 0; i < 16; i++) {
        if (K[i] && g.k[i]) score += 2; else if (K[i]) score -= 2; else if (g.k[i]) score -= 0.6;
        if (S[i] && g.s[i]) score += 2; else if (S[i]) score -= 2; else if (g.s[i]) score -= 1;
      }
      const span = Math.max(...p.notes.map((x) => x.t + x.len));
      if (span < BAR - 30) score -= 3;                                          // a bar that leaves holes
      if (!best || score > best.score) best = { score, p };
    }
    if (best && best.score >= 2 * (nK + nS) - 1.2) {
      return { notes: best.p.notes.map((x) => ({ t: x.t, n: x.n, len: x.len, v: x.v })), how: `Capcom bar (music ${best.p.song})` };
    }
  }
  /* 2. built from the kit's slices: the slice Capcom puts most often at this point of the bar */
  /* 8th-slice kits: the slices on 41..48 Capcom uses; beat-piece kits (10, 13 from 49): the pieces */
  const keys = Object.values(kit.keys).filter((x) => beatPieces ? x.uses > 0 && x.key >= 49 : x.key >= 41 && x.key <= 49 && (x.uses > 0 || x.sound));
  const pick = (role, step8) => {
    let pool = keys.filter((x) => x.role === role);
    if (!pool.length) pool = keys.slice().sort((a, b) => (role === 'kick' ? b.kick - a.kick : b.snare - a.snare)).slice(0, 1);
    if (role === 'ghost') pool = keys.filter((x) => x.role !== 'snare' && (x.low || 0) < 0.6);
    if (!pool.length) pool = keys;
    pool.sort((a, b) => (b.steps[step8] + 0.05 * b.uses) - (a.steps[step8] + 0.05 * a.uses));
    return pool[0].key;
  };
  const vel = (midiV, base) => clamp(Math.round(base * (0.75 + 0.25 * (midiV || 100) / 100)), 20, 63);
  const out = [];
  const unit = beatPieces ? 48 : 24;
  for (let i = 0; i < 16; i++) {
    const t = i * 12, onUnit = t % unit === 0;
    /* a snare and a kick together: the snare slice (the backbeat is the break's character;
     * a four-on-the-floor kick gets its own kit 6 track) */
    let role = S[i] ? 'snare' : K[i] ? 'kick' : T[i] !== null ? 'tom' : null;
    if (!role && onUnit) role = 'ghost';
    if (!role) continue;
    const step8 = Math.floor(i / 2) % 8;
    const n = { t, n: pick(role === 'tom' ? 'snare' : role, step8), len: 12, v: role === 'ghost' ? 45 : vel(V[i], 60) };
    if (role === 'tom') n.bend = [[0, TOM_DETUNE[T[i]] || 0]];
    out.push(n);
  }
  for (let i = 0; i < out.length; i++) out[i].len = (i + 1 < out.length ? out[i + 1].t : BAR) - out[i].t;
  return { notes: out, how: 'built from slices' };
}

/* A song slower than its break leaves a gap after every slice. Played lower (detune, C3) a slice
 * also plays slower and longer, as a sampler pitches a break down to a slower tempo: the detune
 * that stretches the kit's own tempo to the song's, when the song is over 6 % slower (6 semitones
 * at most). Faster songs just cut each slice short, as Capcom's do. */
function slowDown(bpm, kitTempo) {
  if (!kitTempo || bpm >= kitTempo * 0.94) return 0;
  return clamp(Math.round(12 * Math.log2(bpm / kitTempo) * UNITS_PER_SEMITONE), -64, 0);
}
function tuneDown(notes, units) {
  for (const n of notes) n.bend = [[0, clamp((n.bend && n.bend[0] && n.bend[0][0] === 0 ? n.bend[0][1] : 0) + units, -128, 127)]];
}

/* ---- pitched parts -------------------------------------------------------------------------- */
/* Octave moves. A bass goes where Capcom's basses sit (median 40..52: samples played far below
 * that get muddy). Everything else keeps the MIDI's own register (moving brass down an octave to
 * fit Capcom's range was heard as "way too low") unless most of the part
 * falls outside where Capcom plays the instrument and a move fixes that. */
function fitOctave(notes, prog, role) {
  const med = median(notes.map((n) => n.n));
  if (role === 'bass') { let k = 0; while (med + k < 40) k += 12; while (med + k > 52) k -= 12; return k; }
  if (!prog) return 0;
  /* a sax lead at 74..81 on program 57 (Capcom: 43..67) was approved by ear, so only a
   * part centred more than 15 semitones outside Capcom's use is moved, by whole octaves */
  const away = (m) => (m < prog.low ? prog.low - m : m > prog.high ? m - prog.high : 0);
  let k = 0;
  while (away(med + k) > 15 && Math.abs(k) < 36) k += med + k < prog.low ? 12 : -12;
  return k;
}

/* MIDI pitch bends inside each note -> detune steps (thinned to one per tick, 1 unit or more) */
function bendsFor(note, part) {
  if (!part.bends || !part.bends.length) return null;
  const range = part.bendRange || 2;
  const units = (v) => clamp(Math.round(v / 8192 * range * UNITS_PER_SEMITONE), -128, 127);
  let before = 0;
  for (const b of part.bends) { if (b.t <= note.t) before = b.v; else break; }
  const out = [];
  if (units(before)) out.push([0, units(before)]);
  let lastT = -1, lastU = units(before);
  for (const b of part.bends) {
    if (b.t <= note.t || b.t >= note.t + note.len) continue;
    const u = units(b.v), dt = b.t - note.t;
    if (u === lastU || dt === lastT) continue;
    out.push([dt, u]); lastT = dt; lastU = u;
  }
  return out.length ? out : null;
}

/* minLen: no slides inside fast runs (a shred of 16ths at 200 BPM gliding on every note smears) */
function glide(notes, kind, minLen) {
  minLen = minLen || 12;
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    if (n.bend) continue;
    if (kind === 'scoop') { if (n.len >= 18) n.bend = [[0, -11], [1, -9], [2, -6], [3, -4], [4, -2], [5, 0]]; continue; }   // a scoop smears very short notes
    if (kind === 'legato' && i > 0) {
      const p = notes[i - 1], gap = n.t - (p.t + p.len), interval = p.n - n.n;
      if (Math.abs(gap) <= 3 && interval && Math.abs(interval) <= 12 && n.len >= minLen && p.len >= minLen) {
        const from = clamp(Math.round(interval * UNITS_PER_SEMITONE), -128, 127);
        n.bend = [0, 1, 2, 3, 4].map((dt) => [dt, Math.round(from * (1 - dt / 5))]).concat([[5, 0]]);
      }
    }
  }
}

/* ---- reading the MIDI ------------------------------------------------------------------------- */
/* Where the bar lines really are. A MIDI file can start its song part-way into a bar (one real file:
 * 64 ticks in), which puts every snare off the backbeat. The shift that puts the most snares on
 * beats 2 and 4 and kicks on beat 1 is used when it is clearly better than none. */
function phase(parts) {
  const hits = [];
  for (const p of parts) if (p.drums) for (const n of p.notes) {
    if ([38, 40, 39].includes(n.n)) hits.push([n.t, 'S']); else if (n.n === 35 || n.n === 36) hits.push([n.t, 'K']);
  }
  if (hits.length < 16) return harmonicPhase(parts);
  const score = (d) => {
    let s = 0;
    for (const [t, c] of hits) {
      const p = ((t + d) % BAR + BAR) % BAR;
      if (c === 'S' && (Math.abs(p - 48) <= 3 || Math.abs(p - 144) <= 3)) s += 1;
      if (c === 'K' && (p <= 3 || p >= BAR - 3)) s += 0.5;
    }
    return s;
  };
  const none = score(0);
  let top = 0;
  const scores = [];
  for (let d = 0; d < BAR; d++) { scores[d] = score(d); top = Math.max(top, scores[d]); }
  if (top <= none * 1.3) return 0;
  /* several shifts within the tolerance score alike: take the one that puts the snares closest to the beat */
  const dev = (d) => { let s = 0, c = 0; for (const [t, k] of hits) if (k === 'S') { const p = ((t + d) % 96 + 96) % 96; s += Math.abs(p - 48); c++; } return c ? s / c : 0; };
  let best = -1;
  for (let d = 0; d < BAR; d++) if (scores[d] >= top * 0.98 && (best < 0 || dev(d) < dev(best))) best = d;
  return best;
}

/* No drums to go by: chords change and long notes start on the bar line. The half-bar or beat
 * shift (0, 48, 96, 144 ticks) that puts the most long notes (a half bar or more) on bar lines,
 * when clearly better than none (a file seen where every chord starts on beat 3). */
function harmonicPhase(parts) {
  const starts = [];
  for (const p of parts) if (!p.drums) for (const n of p.notes) if (n.len >= 96) starts.push(n.t);
  if (starts.length < 16) return 0;
  const score = (d) => starts.filter((t) => { const q = ((t + d) % BAR + BAR) % BAR; return q <= 3 || q >= BAR - 3; }).length;
  let best = 0;
  for (const d of [48, 96, 144]) if (score(d) > score(best) * 1.5 + 2) best = d;
  return best;
}

function prepare(plan) {
  const midi = Midi.parse(new Uint8Array(fs.readFileSync(plan.midi)));
  /* written at double speed (for example a song at 330 BPM): every MIDI beat becomes an 8th at half the tempo */
  const fast = (midi.tempo.length ? midi.tempo[0].bpm : 120) > 250 && plan.halve !== false;
  /* or written at half speed (SF2 Ken at 94 BPM in 16ths is a 188 BPM rock beat): plan.timeScale 2 */
  const scale = fast ? 0.5 : plan.timeScale || 1;
  if (scale !== 1) {
    for (const p of midi.parts) {
      for (const n of p.notes) { n.t = Math.round(n.t * scale); n.len = Math.max(1, Math.round(n.len * scale)); }
      for (const b of p.bends || []) b.t = Math.round(b.t * scale);
    }
    for (const c of midi.tempo) { c.t = Math.round(c.t * scale); c.bpm *= scale; }
    midi.lengthTicks = Math.round(midi.lengthTicks * scale);
  }
  const shift = plan.shift !== undefined ? plan.shift : phase(midi.parts);
  /* without a plan, the song starts at the bar of its first note (MIDI files often begin with empty bars) */
  const firstNote = Math.min(...midi.parts.map((p) => p.notes.length ? p.notes[0].t + shift : Infinity));
  const lastNote = Math.max(...midi.parts.map((p) => p.notes.reduce((a, n) => Math.max(a, n.t + shift + 1), 0)));
  const firstBar = plan.bars ? plan.bars[0] - 1 : Math.floor(firstNote / BAR);
  const lastBar = plan.bars ? Math.min(plan.bars[1], Math.ceil(lastNote / BAR)) : Math.ceil(lastNote / BAR);
  const from = firstBar * BAR - shift, to = lastBar * BAR - shift, bars = lastBar - firstBar;
  const clip = (notes) => notes.filter((n) => n.t >= from && n.t < to).map((n) => Object.assign({}, n, { t: n.t - from, len: Math.min(n.len, to - n.t) }));
  /* short names: drop a long prefix every part shares (one-track MIDIs name parts "<title> (channel n)") */
  const names = midi.parts.map((p) => p.name);
  let common = names.length > 1 ? names[0] : '';
  for (const n of names) while (common && !n.startsWith(common)) common = common.slice(0, -1);
  const short = (n) => (common.length > 12 ? n.slice(common.length).replace(/^[\s(]+|\)$/g, '') : n) || n;
  let parts = midi.parts.map((p) => Object.assign({}, p, { name: short(p.name), notes: clip(p.notes), bends: (p.bends || []).map((b) => ({ t: b.t - from, v: b.v })) })).filter((p) => p.notes.length);
  /* the tempo where the song starts, and its changes after that (Through the Fire and Flames: 200, 170, 200) */
  const inForce = midi.tempo.filter((c) => c.t <= from).pop() || midi.tempo[0];
  const bpm = plan.bpm || (inForce ? Math.round(inForce.bpm * 10) / 10 : 120);
  const tempoChanges = plan.bpm ? [] : midi.tempo.filter((c) => c.t > from && c.t < to).map((c) => ({ t: c.t - from, bpm: Math.round(c.bpm * 10) / 10 }));
  const report = [`${plan.name}: ${bars} bars at ${bpm} BPM from ${path.basename(plan.midi)} (MIDI bars ${firstBar + 1}-${lastBar}` +
    `${shift ? `, moved ${shift} ticks so the beats fall on the bar lines` : ''}${fast ? ', written at double speed so halved' : scale !== 1 ? `, time x${scale}` : ''})` +
    (tempoChanges.length ? `; tempo changes ${tempoChanges.map((c) => `bar ${Math.floor(c.t / BAR) + 1}: ${c.bpm}`).join(', ')}` : '')];
  /* one part playing everything (a piano reduction): bass, tune and chords taken apart */
  const melodicParts = parts.filter((p) => !p.drums);
  if (melodicParts.length === 1 && plan.split !== false) {
    const p = melodicParts[0], s = analyse(p, to - from);
    if (s.avgPoly >= 1.8 && s.high - s.low >= 24) {
      const split = splitPiano(p);
      parts = parts.filter((x) => x !== p).concat(split);
      report.push(`one part plays everything: "${p.name}" taken apart into ${split.map((x) => `${x.name} (${x.notes.length} notes)`).join(', ')}`);
    }
  }
  /* no drums at all: a plain backbeat wherever two parts play, for the breaks to follow */
  if (!parts.some((p) => p.drums) && plan.addDrums !== false) {
    const notes = [];
    const busy = (b) => parts.filter((p) => p.notes.some((n) => n.t < (b + 1) * BAR && n.t + n.len > b * BAR)).length >= 2;
    /* dance tempos (140 and up) get a kick on every beat, slower songs kick on 1 and 3 */
    const kicks = bpm >= 140 ? [0, 48, 96, 144] : [0, 96];
    for (let b = 0; b < bars; b++) {
      if (!busy(b)) continue;
      for (const t of kicks) notes.push({ t: b * BAR + t, n: 36, v: 100, len: 12 });
      for (const t of [48, 144]) notes.push({ t: b * BAR + t, n: 38, v: 100, len: 12 });
      for (let t = 0; t < BAR; t += 24) notes.push({ t: b * BAR + t, n: 42, v: t % 48 ? 70 : 90, len: 12 });
    }
    if (notes.length) {
      notes.sort((a, b) => a.t - b.t);
      parts.push({ name: 'Backbeat (added)', drums: true, channel: 9, program: 0, notes, bends: [], polyphony: 2 });
      report.push(`the MIDI has no drums: a plain beat (kick ${bpm >= 140 ? 'on every beat' : 'on 1 and 3'}, snare on 2 and 4, 8th hats) was added where two parts play, for the breaks to follow`);
    }
  }
  const roles = guessRoles(parts, to - from);
  const over = plan.parts || {};
  for (const p of parts) {
    const o = over[p.name];
    if (o && o.role) { if (o.role === 'off') roles.delete(p); else roles.set(p, o.role); }
  }
  return { midi, bpm, bars, parts, roles, report, over, shift, tempoChanges, firstBar };
}

/* A piano part playing bass, tune and chords at once. At each moment: the lowest note, when it is
 * in the bass register (below A3: an octave bass jumps up to its upper octave, as some MIDI files
 * F#2-F#3 8ths do), is the bass; the highest, from A3 up, is the tune; anything between is chords. */
function splitPiano(p) {
  const groups = new Map();
  for (const n of p.notes) { const g = Math.round(n.t / 3); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(n); }
  const bass = [], tune = [], chords = [];
  for (const g of groups.values()) {
    g.sort((a, b) => b.n - a.n);
    const rest = g.slice();
    if (rest.length && rest[rest.length - 1].n < 57) bass.push(rest.pop());
    if (rest.length && rest[0].n >= 57) tune.push(rest.shift());           // the top, from A3 up, alone or not
    chords.push(...rest);
  }
  /* each piece is given its role, and no GM sound (the piano's would put the tune on a piano) */
  const mk = (name, notes, role) => Object.assign({}, p, { name: `${p.name} ${name}`, notes: notes.sort((a, b) => a.t - b.t), bends: [], program: null, role });
  return [mk('bass', bass, 'bass'), mk('tune', tune, 'lead'), mk('chords', chords, 'chords')].filter((x) => x.notes.length >= 8);
}

/* ---- the arrangement ------------------------------------------------------------------------- */
function arrange(plan) {
  const cap = Capcom.load();
  const { bpm, bars, parts, roles, report, over, tempoChanges, firstBar } = prepare(plan);

  const out = [];                                       // project parts in track priority order
  const echoes = [];
  const lib = cap.breaks;
  const drums = parts.filter((p) => p.drums && !(over[p.name] && over[p.name].role === 'off'));
  const dplan = plan.drums || {};

  /* drums */
  if (drums.length) {
    const hits = [];
    for (const p of drums) for (const n of p.notes) hits.push({ t: n.t, key: n.n, cat: drumCategory(n.n), v: n.v });
    hits.sort((a, b) => a.t - b.t);
    const kitNo = chooseKit(bpm, lib, dplan.kit);
    const kit = lib.kits[kitNo];
    const breakNotes = [], how = new Map();
    for (let b = 0; b < bars; b++) {
      const inBar = hits.filter((h) => h.t >= b * BAR && h.t < (b + 1) * BAR).map((h) => Object.assign({}, h, { t: h.t - b * BAR }));
      const r = breakBar(inBar, kit, kitNo);
      how.set(r.how, (how.get(r.how) || 0) + 1);
      for (const n of r.notes) breakNotes.push(Object.assign({}, n, { t: n.t + b * BAR }));
    }
    report.push(`drums: break kit ${kitNo} (its tempo ${kit.tempo}), bars: ${Array.from(how.entries()).map(([k, v]) => `${v} ${k}`).join(', ')}`);
    const down = slowDown(bpm, kit.tempo);
    if (down) { tuneDown(breakNotes, down); report.push(`drums: the song is slower than the break, so its slices play ${(-down / UNITS_PER_SEMITONE).toFixed(1)} semitones down to fill each 8th (a pitched-down break)`); }
    if (breakNotes.length) {
      const base = { bank: 0, program: kitNo, volume: ROLE.break.vol, expression: ROLE.break.expr, transpose: 0, voices: 1, mute: false, polyphony: 1 };
      out.push(Object.assign({ name: 'Break', role: 'break', notes: breakNotes, pan: 127 }, base));
      out.push(Object.assign({ name: 'Break (double)', role: 'break', notes: breakNotes.map((n) => Object.assign({}, n, { t: n.t + 2 })), pan: 0 }, base));
    }
    const overlay = (name, role, list) => {
      if (!list.length) return;
      out.push({ name, role, notes: list, bank: 0, program: 6, volume: ROLE[role].vol, expression: ROLE[role].expr, pan: ROLE[role].pan, transpose: 0, voices: 1, mute: false, polyphony: 1 });
    };
    /* hats: Capcom accents the beat and leaves the off-beats lighter */
    const hats = hits.filter((h) => h.cat === 'CH' || h.cat === 'OH').map((h) => ({ t: h.t, n: OVERLAY_KEY[h.cat], len: h.cat === 'OH' ? 46 : 22,
      v: Math.round((h.t % 24 === 0 ? 40 : 28) * (0.8 + 0.2 * h.v / 100)) * 2 }));
    if (dplan.hats !== false) overlay('Hats', 'hats', hats);
    const cym = hits.filter((h) => h.cat === 'crash' || h.cat === 'ride').map((h) => ({ t: h.t, n: OVERLAY_KEY[h.cat], len: h.cat === 'crash' ? 192 : 48, v: (h.cat === 'crash' ? 44 : 34) * 2 }));
    overlay('Cymbals', 'cymbals', cym);
    /* the long low boom on beat 1 (kit 6 key 45) Capcom puts under its breaks */
    const kicksOnOne = new Set(hits.filter((h) => h.cat === 'K' && h.t % BAR < 4).map((h) => Math.floor(h.t / BAR)));
    const four = bars && hits.filter((h) => h.cat === 'K' && h.t % BEAT < 3).length >= 3.5 * kicksOnOne.size && kicksOnOne.size > bars / 2;
    if (dplan.kickLayer === true || (dplan.kickLayer !== false && four)) {
      overlay('Kick', 'kick', hits.filter((h) => h.cat === 'K').map((h) => ({ t: h.t, n: 36, len: 22, v: 110 })));
      report.push('drums: four on the floor, so a kit 6 kick on every kick (as in Dudley\'s theme)');
    } else if (dplan.boom !== false) {
      overlay('Boom', 'boom', Array.from(kicksOnOne).sort((a, b) => a - b).map((b) => ({ t: b * BAR, n: 45, len: BAR, v: 110 })));
    }
    /* claps first: when a clap and a shaker fall together the clap is kept */
    const perc = hits.filter((h) => h.cat === 'clap' || h.cat === 'side').concat(hits.filter((h) => h.cat === 'perc'))
      .map((h) => ({ t: h.t, n: h.cat === 'perc' ? PERC_KEY(h.key) : OVERLAY_KEY[h.cat], len: 22, v: 80 })).filter((n) => n.n).sort((a, b) => a.t - b.t);
    perc.forEach((n, i) => { n.pan = i % 2 ? 16 : 112; });
    overlay('Percussion', 'perc', perc);
  }

  /* pitched parts, in Capcom's track order: bass, lead, chords/pad, counter, arpeggio */
  const order = ['bass', 'lead', 'chords', 'pad', 'counter', 'arp'];
  const weight = (p) => p.notes.length * Math.sqrt(p.stats.coverage + 0.05);
  const pitched = parts.filter((p) => roles.has(p)).sort((a, b) => order.indexOf(roles.get(a)) - order.indexOf(roles.get(b)) || weight(b) - weight(a));
  const taken = new Map(), usedPrograms = new Set();
  for (const p of pitched) {
    const role = roles.get(p), o = over[p.name] || {};
    taken.set(role, (taken.get(role) || 0) + 1);
    const rank = taken.get(role);
    /* a pad down in the bass register is a drone: the clean looped tone of program 18 */
    let program = o.program !== undefined ? o.program : role === 'pad' && p.stats.median < 50 ? 18 : pickProgram(role, p.stats.gm);
    /* two parts on one instrument blur into each other: the second takes the next sound for its role */
    if (o.program === undefined && usedPrograms.has(program)) program = (ALTERNATIVES[role] || []).find((x) => !usedPrograms.has(x)) || program;
    usedPrograms.add(program);
    const prog = cap.programs[program];
    const notes = p.notes.map((n) => Object.assign({}, n, { bend: bendsFor(n, p) }));
    const octave = o.octave !== undefined ? o.octave * 12 : fitOctave(notes, prog, role);
    for (const n of notes) { n.n += octave; if (!n.bend) delete n.bend; }
    const R = ROLE[role];
    const level = o.level || 1;
    /* velocities: Capcom's base for the role, shaped by the MIDI's own dynamics */
    const meanV = notes.reduce((a, n) => a + n.v, 0) / notes.length;
    for (const n of notes) n.v = clamp(Math.round(R.v * Math.pow(n.v / meanV, 0.6)), 10, 63) * 2;
    if (role === 'pad') {                                       // pads hold to the next chord
      const starts = Array.from(new Set(notes.map((n) => n.t))).sort((a, b) => a - b);
      for (const n of notes) { const next = starts.find((s) => s > n.t + 2); if (next !== undefined && next - n.t <= 2 * BAR) n.len = Math.max(n.len, next - n.t); }
    }
    const g = o.glide !== undefined ? o.glide : role === 'lead' || role === 'counter' ? 'legato' : role === 'chords' && program === 37 ? 'scoop' : null;
    if (g) glide(notes, g, bpm >= 170 ? 24 : 12);
    const chordal = role === 'pad' || role === 'chords';
    const want = o.voices || (chordal ? clamp(Math.round(p.polyphony), 1, 3) : 1);
    const part = { name: `${p.name} (${role})`, role, notes, bank: 0, program, volume: Math.round(R.vol * level), expression: R.expr, pan: R.pan,
                   transpose: 0, voices: want, want, min: chordal ? Math.min(2, want) : 1, mute: false, polyphony: p.polyphony, rank,
                   priority: PRIORITY[role] - (rank - 1) * 30, desc: `program ${program}${octave ? ` (${octave > 0 ? '+' : ''}${octave / 12} octave)` : ''}, median key ${p.stats.median + octave}, ${notes.filter((n) => n.bend).length} glides` };
    if (role === 'chords' || role === 'arp') notes.forEach((n, i) => { n.pan = [64, 120, 8][i % 3]; });
    out.push(part);
    const echo = o.echo === false ? null : R.echo;
    if (echo) {
      part.echo = { delay: (o.echo && o.echo.delay) || echo.delay + (bpm >= 150 ? 4 : 0), level: echo.level, priority: part.priority - (role === 'lead' ? 15 : 28) };
    }
  }
  for (const p of parts) if (p.double) report.push(`left out: "${p.name}" (copy of "${p.double}")`);
  for (const p of parts) if (p.effect) report.push(`left out: "${p.name}" (a sound-effect patch, GM ${p.stats.gm})`);

  /* 16 tracks. Everything is ranked (PRIORITY); parts and echoes go in by rank at their fewest
   * voices, then chord parts get voices back by rank. Echoes sit last, on 13..16, the tracks a
   * fight's sound effects take first. */
  for (const p of out) { if (p.priority === undefined) p.priority = PRIORITY[p.role]; if (!p.min) { p.min = 1; p.want = p.voices; } }
  const items = out.map((p) => ({ p, priority: p.priority }));
  for (const p of out) if (p.echo) items.push({ p, echo: true, priority: p.echo.priority });
  items.sort((a, b) => b.priority - a.priority);
  let used = 0;
  const kept = [];
  for (const it of items) {
    const cost = it.echo ? 1 : it.p.min;
    if (it.echo && !kept.some((k) => k.p === it.p && !k.echo)) continue;
    if (used + cost > 16) { report.push(`left out for room: ${it.p.name}${it.echo ? ' echo' : ''}`); continue; }
    kept.push(it); used += cost;
  }
  for (const it of kept) if (!it.echo) it.p.voices = it.p.min;
  for (const it of kept) {
    if (it.echo) continue;
    while (it.p.voices < it.p.want && used < 16) { it.p.voices++; used++; }
  }
  const final = out.filter((p) => kept.some((k) => k.p === p && !k.echo));
  for (const p of final) {
    if (p.role === 'pad' || p.role === 'chords') p.notes = thinChords(p.notes, p.voices);
    else if (p.voices === 1) p.notes = onePerOnset(p.notes, p.role === 'bass' ? 'low' : ['lead', 'counter', 'arp'].includes(p.role) ? 'high' : 'first');
    if (p.desc) report.push(`${p.role.padEnd(7)} "${p.name.replace(/ \(\w+\)$/, '')}" -> ${p.desc}, ${p.voices} voice(s)${p.voices < p.want ? ` of ${p.want}` : ''}`);
  }
  const loopLen = (bars - (plan.loopStart ? plan.loopStart - 1 : 0)) * BAR;
  for (const it of kept) {
    if (!it.echo) continue;
    const p = it.p, top = p.role === 'pad' || p.role === 'chords' ? Seq.lanes(p.notes, p.voices).lanes[0] : p.notes;
    final.push({ name: `${p.name.replace(/ \(\w+\)$/, '')} (echo)`, role: 'echo', bank: 0, program: p.program, volume: p.volume, expression: Math.round(p.expression * p.echo.level),
      pan: p.pan < 64 ? 127 : 0, transpose: 0, voices: 1, mute: false, polyphony: 1,
      notes: top.map((n) => { let t = n.t + p.echo.delay; if (t >= bars * BAR) t -= loopLen; const c = Object.assign({}, n, { t }); delete c.pan; return c; }).sort((a, b) => a.t - b.t) });
  }
  for (const p of final) { for (const n of p.notes) if (n.pan === undefined) delete n.pan; delete p.want; delete p.min; delete p.priority; delete p.echo; delete p.desc; delete p.rank; }
  return { firstBar, project: { name: plan.name, bpm, tempoChanges, bars, loop: { on: true, startBar: plan.loopStart || 1, endBar: bars }, markerBars: 2, parts: final }, report };
}

/* a one-track part: one note per moment (a bass keeps its lowest, a melody its highest; drum
 * overlays keep the first listed, which the caller puts in order of importance) */
function onePerOnset(notes, keep) {
  const by = new Map();
  for (const n of notes) {
    const had = by.get(n.t);
    if (!had || (keep === 'low' && n.n < had.n) || (keep === 'high' && n.n > had.n)) by.set(n.t, n);
  }
  return Array.from(by.values()).sort((a, b) => a.t - b.t);
}

/* other sounds for a role, in order, when its first choice is already taken by another part */
const ALTERNATIVES = { bass: [20, 19, 18], lead: [43, 44, 42, 41, 57, 21], counter: [44, 42, 41, 43, 21, 38], chords: [37, 22, 58, 60, 39, 38, 46],
                       pad: [46, 57, 39, 45], arp: [58, 60, 41, 23] };

/* ---- in the style of one of Capcom's themes (style/templates/*.js) ----------------------------
 * The theme decides the tracks: its breaks and their bars, its instrument, level, pan, echo and
 * timing for bass, lead, stabs and pad. The MIDI decides the notes. Slots are filled from the
 * MIDI's parts by role: the lead takes the main melody and other lead-like parts where it rests,
 * the stabs take the chord parts (brass first), the pad the held chords, and one more part may go
 * on the track the theme leaves free. plan.register: 'theme' (default) moves each part by octaves
 * to where the theme plays that track; 'midi' keeps the MIDI's octaves. */
function arrangeTemplate(plan) {
  const tpl = typeof plan.template === 'string' ? require(path.join(__dirname, 'templates', plan.template + '.js')) : plan.template;
  const { bpm, bars, parts, roles, report, over, tempoChanges, firstBar } = prepare(plan);
  const T = tpl.parts, END = bars * BAR, out = [], used = new Set();
  const byTheme = plan.register !== 'midi';
  report.push(`style: ${tpl.name} (${tpl.from}); ${byTheme ? 'parts moved by octaves to the theme\'s registers' : 'the MIDI\'s own octaves'}`);
  const weight = (p) => p.notes.length * Math.sqrt(p.stats.coverage + 0.05);
  const melodic = parts.filter((p) => !p.drums && roles.has(p)).sort((a, b) => weight(b) - weight(a));
  const slotOf = (p) => (over[p.name] && over[p.name].slot) || null;
  const pick = (slot, test) => melodic.filter((p) => !used.has(p) && (slotOf(p) ? slotOf(p) === slot : test(p)));
  const gm = (p) => p.stats.gm, isBrass = (p) => gm(p) >= 56 && gm(p) <= 63;
  const shiftTo = (notes, target) => byTheme && target ? Math.round((target - median(notes.map((n) => n.n))) / 12) * 12 : 0;
  const dyn = (notes, base) => { const mean = notes.reduce((a, n) => a + n.v, 0) / Math.max(1, notes.length); for (const n of notes) n.v = clamp(Math.round(base * Math.pow(n.v / mean, 0.6)), 8, 63) * 2; };
  const part = (name, role, notes, spec, program) => ({ name, role, notes, bank: 0, program, volume: spec.vol, expression: spec.expr, pan: spec.pan, transpose: 0, voices: 1, mute: false, polyphony: 1 });
  const slots = {};

  /* bass */
  const bassP = pick('bass', (p) => roles.get(p) === 'bass')[0];
  if (bassP) {
    used.add(bassP);
    let notes = onePerOnset(bassP.notes.map((n) => Object.assign({}, n, { bend: bendsFor(n, bassP) })), 'low');
    const med = median(notes.map((n) => n.n)), [lo, hi] = T.bass.range;
    let k = 0; while (med + k < lo + 2) k += 12; while (med + k > hi - 2) k -= 12;
    notes.forEach((n) => { n.n += k; if (!n.bend) delete n.bend; });
    dyn(notes, T.bass.v);
    slots.bass = part('Bass', 'bass', notes, T.bass, T.bass.program);
    report.push(`bass  <- "${bassP.name}" on ${T.bass.program}${k ? ` (${k > 0 ? '+' : ''}${k / 12} octave)` : ''}`);
  }
  /* lead: the melody, and lead-like parts where it rests (a beat clear either side) */
  const leadP = pick('lead', (p) => roles.get(p) === 'lead')[0];
  if (leadP) {
    used.add(leadP);
    const notes = leadP.notes.map((n) => Object.assign({}, n, { bend: bendsFor(n, leadP) }));
    const busy = notes.map((n) => [n.t - BEAT, n.t + n.len + BEAT]);
    /* lead-like: synth leads, reeds and pipes, voices (GM 80-87, 64-79, 52-54) or a part with no GM sound */
    const leadLike = (p) => gm(p) < 0 || (gm(p) >= 80 && gm(p) <= 87) || (gm(p) >= 64 && gm(p) <= 79) || (gm(p) >= 52 && gm(p) <= 54);
    const fills = pick('lead', (p) => leadLike(p) && p.stats.chordy < 0.3 && p.stats.median >= 55 && ['lead', 'counter', 'arp'].includes(roles.get(p)));
    for (const q of fills) {
      used.add(q);
      let added = 0;
      for (const n of q.notes) if (!busy.some(([a, b]) => n.t < b && n.t + n.len > a)) { notes.push(Object.assign({}, n, { bend: bendsFor(n, q) })); added++; }
      report.push(`lead  <- "${q.name}" where the melody rests (${added} of ${q.notes.length} notes)`);
    }
    notes.sort((a, b) => a.t - b.t);
    const lead = onePerOnset(notes, 'high');
    const k = shiftTo(lead, T.lead.median || 81);
    lead.forEach((n) => { n.n += k; if (!n.bend) delete n.bend; });
    dyn(lead, T.lead.v);
    if (T.lead.glide) glide(lead, T.lead.glide, bpm >= 170 ? 24 : 1);    // Jazzy NYC slides into almost every note
    slots.lead = part('Lead', 'lead', lead, T.lead, T.lead.program);
    report.push(`lead  <- "${leadP.name}" on ${T.lead.program}${k ? ` (${k > 0 ? '+' : ''}${k / 12} octave)` : ''}, ${lead.filter((n) => n.bend).length} of ${lead.length} notes glide`);
  }
  /* stabs: chord parts, brass first; the top two notes of each chord on two tracks */
  let stabSrc = pick('stabs', (p) => isBrass(p) && p.stats.median >= 48);
  if (!stabSrc.length) stabSrc = pick('stabs', (p) => roles.get(p) === 'chords').slice(0, 1);
  if (stabSrc.length) {
    const groups = new Map();
    for (const p of stabSrc) { used.add(p); for (const n of p.notes) { const g = Math.round(n.t / 3); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(Object.assign({}, n)); } }
    const top = [], second = [];
    let i = 0;
    for (const g of Array.from(groups.keys()).sort((a, b) => a - b)) {
      const c = groups.get(g).sort((a, b) => b.n - a.n), pan = T.stabs.pingpong ? T.stabs.pingpong[i++ % T.stabs.pingpong.length] : undefined;
      top.push(Object.assign(c[0], { pan }));
      if (c[1] && c[1].n !== c[0].n) second.push(Object.assign(c[1], { pan }));
    }
    const k = shiftTo(top, T.stabs.median || 67);
    const voices = [top, second].map((notes) => { notes = onePerOnset(notes, 'high'); notes.forEach((n) => { n.n += k; }); dyn(notes, T.stabs.v); if (T.stabs.glide) glide(notes, T.stabs.glide); return notes; });
    slots.stabs = voices.map((notes, v) => notes.length ? part(`Stabs ${v + 1}`, 'chords', notes, T.stabs.voices[v], T.stabs.program) : null).filter(Boolean);
    report.push(`stabs <- ${stabSrc.map((p) => `"${p.name}"`).join(' + ')} on ${T.stabs.program}, top two notes of each chord${k ? `, ${k > 0 ? '+' : ''}${k / 12} octave` : ''}`);
  }
  /* pad: held chords, top three notes, laid back; a low voice on the bass's notes */
  const padP = pick('pad', (p) => roles.get(p) === 'pad')[0] || pick('pad', (p) => roles.get(p) === 'chords')[0];
  if (padP) {
    used.add(padP);
    const groups = new Map();
    for (const n of padP.notes) { const g = Math.round(n.t / 3); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(n); }
    /* strings (GM 40..55) fill the pad where the main pad part rests (the intro's string swell) */
    const padFills = pick('pad', (p) => gm(p) >= 40 && gm(p) <= 55);
    for (const q of padFills) {
      used.add(q);
      let added = 0;
      for (const n of q.notes) if (!padP.notes.some((x) => n.t < x.t + x.len && n.t + n.len > x.t)) { const g = Math.round(n.t / 3); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(n); added++; }
      report.push(`pad   <- "${q.name}" where "${padP.name}" rests (${added} of ${q.notes.length} notes)`);
    }
    const keys = Array.from(groups.keys()).sort((a, b) => a - b);
    const k = shiftTo(padP.notes, T.pad.median || 73);
    const late = T.pad.late || 0;
    const voices = [[], [], []], low = [];
    keys.forEach((g, i) => {
      const c = groups.get(g).sort((a, b) => b.n - a.n), t = c[0].t;
      const next = keys[i + 1] !== undefined ? groups.get(keys[i + 1])[0].t : END;
      const len = Math.max(Math.max(...c.map((n) => n.len)), next - t <= 2 * BAR ? next - t : 0);
      c.slice(0, 3).forEach((n, v) => voices[v].push({ t: t + late, n: n.n + k, v: n.v, len }));
      if (T.pad.low) {
        const b = slots.bass && slots.bass.notes.filter((x) => x.t <= t + 12 && x.t + x.len > t - 12).sort((x, y) => x.n - y.n)[0];
        let n = b ? b.n : c[c.length - 1].n;
        const [lo, hi] = T.pad.low.range;
        while (n < lo) n += 12; while (n > hi) n -= 12;
        low.push({ t: t + late, n, v: c[0].v, len });
      }
    });
    slots.pad = voices.map((notes, v) => { notes = onePerOnset(notes.filter((n) => n.t < END), 'high'); dyn(notes, T.pad.v); return notes.length ? part(`Pad ${v + 1}`, 'pad', notes, T.pad.voices[v], T.pad.program) : null; }).filter(Boolean);
    if (low.length) { const notes = onePerOnset(low.filter((n) => n.t < END), 'low'); dyn(notes, T.pad.low.v); slots.padLow = part('Pad low', 'pad', notes, T.pad.low, T.pad.program); }
    report.push(`pad   <- "${padP.name}" on ${T.pad.program}, ${late} ticks behind the beat${k ? `, ${k > 0 ? '+' : ''}${k / 12} octave` : ''}${low.length ? ', low voice on the bass notes' : ''}`);
  }
  /* the free track: the busiest part left */
  const extraP = T.extra ? pick('extra', () => true)[0] : null;
  if (extraP) {
    used.add(extraP);
    const r = roles.get(extraP), program = (over[extraP.name] && over[extraP.name].program) || (gm(extraP) >= 24 && gm(extraP) <= 31 ? 58 : pickProgram(r, gm(extraP)));
    const notes = onePerOnset(extraP.notes.map((n) => Object.assign({}, n)), 'high');
    dyn(notes, T.extra.v);
    slots.extra = part(`${extraP.name} (extra)`, 'extra', notes, T.extra, program);
    report.push(`extra <- "${extraP.name}" on ${program}, quiet, on the last track`);
  }
  for (const p of melodic) if (!used.has(p)) report.push(`left out: "${p.name}" (${roles.get(p)}, ${p.notes.length} notes)`);
  for (const p of parts) if (p.double) report.push(`left out: "${p.name}" (copy of "${p.double}")`);
  for (const p of parts) if (p.effect) report.push(`left out: "${p.name}" (a sound-effect patch)`);

  /* drums: the theme's own bars wherever the MIDI has drums; 8-bar blocks with three or more
   * other parts playing get the second break on top (the main one drops under it), and the
   * last bar of a block before more drums is the theme's fill */
  const D = tpl.drums, mainN = [], secondN = [];
  const hits = new Array(bars).fill(0);
  for (const p of parts) if (p.drums) for (const n of p.notes) { const b = Math.floor(n.t / BAR); if (b < bars) hits[b]++; }
  const sources = [bassP, leadP, padP, ...(stabSrc || [])].filter(Boolean);
  const active = (b) => sources.filter((p) => p.notes.some((n) => n.t < (b + 1) * BAR && n.t + n.len > b * BAR)).length;
  const blocks = Math.ceil(bars / 8), high = [];
  for (let k = 0; k < blocks; k++) { let s = 0, c = 0; for (let b = k * 8; b < Math.min(bars, k * 8 + 8); b++) { s += active(b); c++; } high.push(D.second && s / c >= 3); }
  const put = (list, barNotes, b, vScale) => { for (const n of barNotes) list.push({ t: b * BAR + n.t, n: n.n, v: clamp(Math.round(n.v * (vScale || 1)), 1, 63) * 2, len: 0, bend: n.bend }); };
  const crashes = [];
  /* a drum script (plan.drumScript(bar) -> { main, second, crash }) arranges the drums bar by bar */
  if (plan.drumScript) {
    for (let b = 0; b < bars; b++) {
      const s = plan.drumScript(b + 1);
      if (!s) continue;
      if (s.main) put(mainN, s.main, b);
      if (s.second) put(secondN, s.second, b);
      if (s.crash) crashes.push(b * BAR);
    }
  }
  for (let b = 0; b < bars && !plan.drumScript; b++) {
    if (hits[b] < 2) continue;
    const k = Math.floor(b / 8), last = b % 8 === 7 || b === bars - 1, more = b + 1 < bars && hits[b + 1] >= 2;
    const fill = last && more && b !== bars - 1;
    if (high[k]) {
      put(mainN, D.main.bars[b % D.main.bars.length], b, D.main.under);
      put(secondN, fill ? D.second.fill : D.second.bars[b % D.second.bars.length], b);
    } else {
      put(mainN, fill ? D.main.fill : D.main.bars[b % D.main.bars.length], b);
      if (fill && high[k + 1] && D.second.pickup) put(secondN, D.second.pickup, b);
    }
  }
  const lengths = (list) => { list.sort((a, b) => a.t - b.t); list.forEach((n, i) => { const next = list[i + 1]; n.len = Math.min(next ? next.t - n.t : 24, 25); }); return list; };
  const breakParts = [], kits = Capcom.load().breaks.kits;
  for (const [key, list] of [['main', mainN], ['second', secondN]]) {
    if (!list.length) continue;
    lengths(list);
    const down = slowDown(bpm, kits[D[key].kit] && kits[D[key].kit].tempo);
    if (down) { tuneDown(list, down); report.push(`drums: ${key} break ${(-down / UNITS_PER_SEMITONE).toFixed(1)} semitones down to fill the slower tempo`); }
    D[key].tracks.forEach((tr, i) => breakParts.push(part(`Break ${key}${i ? ' (double)' : ''}`, 'break', list.map((n) => Object.assign({}, n, { t: n.t + (tr.delay || 0) })), tr, D[key].kit)));
  }
  report.push(`drums: ${tpl.name}'s breaks (kit ${D.main.kit}${secondN.length ? ` and kit ${D.second.kit}` : ''}); ` +
    (plan.drumScript ? `arranged bar by bar by the plan's drum script, ${crashes.length} crashes` : `8-bar blocks ${high.map((h) => (h ? 'full' : 'light')).join(' ')}`));

  /* percussion: the MIDI's hand percussion on kit 6 (it follows GM keys), one hit at a time (claps
   * first, then bells, then triangle/tambourine, then shakers ping-ponging), and the crashes */
  if (T.perc && plan.percussion !== false) {
    const KIT6 = { 39: [39, 0], 37: [39, 0], 67: [56, 1], 68: [56, 1], 56: [56, 1], 80: [54, 2], 81: [54, 2], 54: [54, 2], 70: [55, 3], 69: [53, 3], 82: [55, 3] };
    const raw = [];
    for (const p of parts) if (p.drums) for (const n of p.notes) if (KIT6[n.n]) raw.push({ t: n.t, n: KIT6[n.n][0], rank: KIT6[n.n][1], v: n.v });
    raw.sort((a, b) => a.t - b.t || a.rank - b.rank);
    const one = [];
    for (const n of raw) if (!one.length || one[one.length - 1].t !== n.t) one.push(n);
    let shake = 0;
    for (const n of one) { delete n.rank; n.len = 22; if (n.n === 55 || n.n === 53) { n.n = shake % 2 ? 53 : 55; n.pan = shake++ % 2 ? 16 : 112; } }
    const notes = one.filter((n) => !crashes.some((c) => n.t >= c && n.t < c + BEAT));
    dyn(notes, T.perc.v);
    for (const c of crashes) notes.push({ t: c, n: 49, v: 88, len: 96, pan: 100 });
    notes.sort((a, b) => a.t - b.t);
    if (notes.length) { slots.perc = part('Percussion', 'perc', notes, T.perc, 6); report.push(`percussion: ${one.length} hits from the MIDI's hand percussion on kit 6${crashes.length ? `, ${crashes.length} crashes at section starts` : ''}`); }
  }

  /* echoes, as the theme places them */
  const echo = (src, spec, name, pans) => src && spec ? part(name, 'echo', src.notes.map((n, i) => { let t = n.t + spec.delay; if (t >= END) t -= END; const c = Object.assign({}, n, { t }); if (pans) c.pan = pans[i % pans.length]; else delete c.pan; return c; }).sort((a, b) => a.t - b.t), spec, src.program) : null;
  const final = [...breakParts, slots.bass, slots.lead, ...(slots.stabs || []), ...(slots.pad || []), slots.padLow, slots.perc,
    echo(slots.pad && slots.pad[0], T.pad.echo, 'Pad echo'), echo(slots.stabs && slots.stabs[0], T.stabs.echo, 'Stabs echo', T.stabs.echoPingpong || [64, 127, 0]),
    echo(slots.lead, T.lead.echo, 'Lead echo'), slots.extra].filter(Boolean);
  /* over 16 tracks: the quietest echo goes first, then the extra part, then from the end */
  for (const name of ['Pad echo', slots.extra && slots.extra.name]) {
    const i = final.findIndex((p) => p.name === name);
    if (final.length > 16 && i >= 0) report.push(`left out for room: ${final.splice(i, 1)[0].name}`);
  }
  while (final.length > 16) report.push(`left out for room: ${final.splice(final.length - 1, 1)[0].name}`);
  for (const p of final) for (const n of p.notes) { if (n.pan === undefined) delete n.pan; if (n.bend === undefined || n.bend === null) delete n.bend; }
  return { firstBar, project: { name: plan.name, bpm, tempoChanges, bars, loop: { on: true, startBar: plan.loopStart || 1, endBar: bars }, markerBars: 2, parts: final }, report };
}

/* what is kept when 16 tracks are not enough (higher first) */
const PRIORITY = { break: 100, bass: 95, lead: 90, chords: 86, pad: 84, hats: 80, boom: 70, kick: 70, cymbals: 64, counter: 58, arp: 52, perc: 30 };

/* a chord part on fewer tracks than its chords have notes: keep the top and bottom notes of each
 * chord and the middle ones after them (the driver plays one note per track) */
function thinChords(notes, voices) {
  const groups = new Map();
  for (const n of notes) { const k = Math.round(n.t / 3); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(n); }
  const out = [];
  for (const g of groups.values()) {
    if (g.length <= voices) { out.push(...g); continue; }
    g.sort((a, b) => b.n - a.n);
    const idx = new Set(voices === 1 ? [0] : Array.from({ length: voices }, (_, i) => Math.round(i * (g.length - 1) / (voices - 1))));
    out.push(...g.filter((_, i) => idx.has(i)));
  }
  return out.sort((a, b) => a.t - b.t || b.n - a.n);
}

/* ---- render and write ------------------------------------------------------------------------ */
function render(bytes, frames, skip) {
  const e = new Engine(globalThis.SF3_PACK);
  e.patchSequence(bytes, 60); e.request(60);
  for (let f = 0; f < (skip || 0); f++) { const n = e.tick(); e.chip(n); }          // run silently up to the part to hear
  e.keyOns = [];
  const base = e.frame;
  const cap = Math.ceil(frames * 626) + 16, L = new Int32Array(cap), R = new Int32Array(cap);
  let at = 0, voiceSum = 0;
  for (let f = 0; f < frames; f++) { at += e.step(L, R, at); for (let i = 0; i < 16; i++) if (e.key & (1 << i)) voiceSum++; }
  let peak = 0;
  for (let i = 0; i < at; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
  /* busiest 20 s: key-ons per second (Capcom's fighting themes: 23..42 over their first 40 s) */
  const on = e.keyOns.map(([f]) => f - base), win = Math.round(20 * 59.6);
  let busiest = 0;
  for (let i = 0, j = 0; i < on.length; i++) { while (on[i] - on[j] > win) j++; busiest = Math.max(busiest, i - j + 1); }
  return { L, R, n: at, peak: peak / 32768, keyOns: on.filter((f) => f >= 60 && f < 60 + 40 * 59.6).length, voices: voiceSum / frames, busiest: busiest / 20 };
}

function writeWav(file, r) {
  const wav = Buffer.alloc(44 + r.n * 4), rate = Math.round(CHIP_RATE);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + r.n * 4, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(2, 22);
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 4, 28); wav.writeUInt16LE(4, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(r.n * 4, 40);
  for (let i = 0; i < r.n; i++) { wav.writeInt16LE(clamp(r.L[i], -32768, 32767), 44 + 4 * i); wav.writeInt16LE(clamp(r.R[i], -32768, 32767), 46 + 4 * i); }
  fs.writeFileSync(file, wav);
}

function build(plan, options = {}) {
  /* a plan may arrange the song itself (plan.arrange(plan, helpers) -> { project, report, firstBar }) */
  const helpers = { prepare, onePerOnset, bendsFor, glide, thinChords, Capcom, BAR, BEAT, UNITS_PER_SEMITONE };
  const arrangeFor = (p) => (p.arrange ? p.arrange(p, helpers) : p.template ? arrangeTemplate(p) : arrange(p));
  let { project, report, firstBar } = arrangeFor(plan);
  if (!project.parts.some(p => p.notes.length)) throw new Error('The arranger found no usable phrase. Try a longer MIDI phrase or give its parts roles in a plan.');
  /* size: the editor previews songs up to 64 KB and the ROM has 188 KB free for all added songs,
   * so a longer song keeps its first whole 8-bar blocks that fit in about 60 KB */
  /* the sequence format itself stops at 64 KB of track starts: past that, estimate from the notes (about 5 bytes each) */
  const LIMIT = 60000;
  const sizeOf = (p) => { try { return Project.build(p).bytes.length; } catch (e) { return Infinity; } };
  const notesIn = (p) => p.parts.reduce((a, x) => a + x.notes.length, 0);
  const whole = sizeOf(project), estimate = Number.isFinite(whole) ? whole : notesIn(project) * 5;
  if (whole > LIMIT && !plan.bars) {
    for (let keep = Math.max(8, Math.floor(project.bars * LIMIT * 0.92 / estimate / 8) * 8); keep >= 8; keep -= 8) {
      const r2 = arrangeFor(Object.assign({}, plan, { bars: [firstBar + 1, firstBar + keep] }));
      const size = sizeOf(r2.project);
      if (size <= LIMIT || keep === 8) {
        r2.report.push(`size: the whole song would be ${Number.isFinite(whole) ? whole.toLocaleString() + ' bytes' : `about ${estimate.toLocaleString()} bytes, more than a song can hold`}; kept its first ${keep} bars (${size.toLocaleString()} bytes). A plan with bars: [first, last] picks another stretch.`);
        ({ project, report } = r2);
        break;
      }
    }
  }
  const loopFrames = Math.ceil(project.bars * BAR * 256 / Seq.bpmToTempo(project.bpm));
  /* the mix, toward Capcom's own balance (style/metrics.js over the fighting themes): low end
   * (below 150 Hz) about 0.57 of the energy, 0.49..0.68 allowed; punch (crest) 15.0..16.9 dB.
   * Bass, boom and kick move together for the low end; for punch, everything that is not drums
   * moves against the drums. Then every volume is scaled until the loudest moment is about 0.8. */
  const LOW = new Set(['bass', 'boom', 'kick']), DRUM = new Set(['break', 'hats', 'cymbals', 'boom', 'kick', 'perc']);
  const gain = { low: 1, rest: 1, drums: 1 };
  const base = project.parts.map((p) => p.volume);
  let scale = 1, built, r;
  /* the mix is judged where the song is busiest (an intro of pads alone misled it): the 12 bars
   * with the most notes, reached by running the driver silently */
  const perBar = new Array(project.bars).fill(0);
  for (const p of project.parts) for (const n of p.notes) { const b = Math.floor(n.t / BAR); if (b >= 0 && b < project.bars) perBar[b]++; }
  let hotBar = 0, best = -1;
  for (let b = 0; b + Math.min(12, project.bars) <= project.bars; b++) { const s = perBar.slice(b, b + 12).reduce((a, x) => a + x, 0); if (s > best) { best = s; hotBar = b; } }
  const framesPerTick = 256 / Seq.bpmToTempo(project.bpm);
  const skip = Math.round((Seq.LEAD_IN + hotBar * BAR) * framesPerTick);
  const hotFrames = Math.round(40 * 59.6);                                  // 40 s from there, as the final numbers
  report.push(`mix judged on bars ${hotBar + 1}-${Math.min(project.bars, hotBar + 12)}, the busiest stretch`);
  const apply = () => project.parts.forEach((p, i) => {
    const g = (LOW.has(p.role) ? gain.low : 1) * (DRUM.has(p.role) ? gain.drums : gain.rest);
    p.volume = clamp(Math.round(base[i] * g * scale), 1, 127);
  });
  if (plan.balance !== false) {
    let crestTried = null;                       // one step on the punch lever, kept only if it helps
    let lowTried = null, lowDone = false;        // the same for the low end: a break can carry it, not the bass
    for (let pass = 0; pass < 4; pass++) {
      apply();
      built = Project.build(project);
      r = render(built.bytes, hotFrames, skip);
      const m = Metrics.measure(r, Math.min(38, r.n / CHIP_RATE - 1.5));
      const low = m.bands[0];
      if (crestTried && m.crest < crestTried.crest + 0.3) { Object.assign(gain, crestTried.gain); crestTried.undone = true; }
      if (lowTried && Math.abs(low - 0.57) > Math.abs(lowTried.low - 0.57) - 0.02) {
        gain.low = lowTried.gain; lowDone = true;
        report.push(`balance: the bass, boom and kick do not carry this low end (${lowTried.low.toFixed(2)} -> ${low.toFixed(2)}); their level is kept`);
      }
      lowTried = null;
      let moved = false;
      if (!lowDone && (low > 0.64 || low < 0.5)) { lowTried = { low, gain: gain.low }; gain.low *= clamp(Math.pow(0.57 / low, 1.2), 0.6, 1.5); moved = true; }
      if (!crestTried && !plan.template && !plan.arrange && (m.crest < 14.8 || m.crest > 17.2)) {    // a theme's own levels are kept
        crestTried = { crest: m.crest, gain: Object.assign({}, gain) };
        if (m.crest < 14.8) gain.rest *= 0.85; else gain.drums *= 0.88;
        moved = true;
      }
      report.push(`balance ${pass + 1}: low ${low.toFixed(2)}, crest ${m.crest} dB${moved ? ` -> gains low x${gain.low.toFixed(2)}, others x${gain.rest.toFixed(2)}, drums x${gain.drums.toFixed(2)}` : ' (in range)'}`);
      if (!moved) break;
    }
    if (crestTried && crestTried.undone) report.push('balance: the punch step did not help and was taken back');
  }
  /* density: Capcom's busiest 20 s run 28..50 key-ons a second (median 39). Busier than 48 reads
   * as a mess, so the least important echoes go first. */
  let full;
  apply(); built = Project.build(project);
  for (let pass = 0; pass < 5; pass++) {
    full = render(built.bytes, loopFrames + 180);
    if (full.busiest <= 48) break;
    const idx = project.parts.map((p) => p.role).lastIndexOf('echo');
    if (idx < 0) { report.push(`busy: ${full.busiest.toFixed(1)} key-ons a second at the busiest (Capcom 28..50), no echo left to take out`); break; }
    report.push(`busy: ${full.busiest.toFixed(1)} key-ons a second at the busiest (Capcom 28..50): left out ${project.parts[idx].name}`);
    project.parts.splice(idx, 1); base.splice(idx, 1);
    apply(); built = Project.build(project);
  }
  for (let pass = 0; pass < 6; pass++) {                  // the loudest moment of the whole song, about 0.8
    if (full.peak > 0.74 && full.peak < 0.86) break;
    scale *= 0.8 / full.peak;
    apply(); built = Project.build(project);
    full = render(built.bytes, loopFrames + 180);
  }
  report.push(`mix: volumes x${scale.toFixed(2)}, peak ${full.peak.toFixed(2)}, ${built.report.tracks.length} tracks, ${built.bytes.length} bytes, dropped notes ${built.report.dropped}`);
  report.push(`tracks: ${built.report.tracks.map((t) => `${t.track + 1}:${t.part.name}`).join(' | ')}`);
  for (const w of built.report.warnings) report.push('WARNING ' + w);
  const m = Metrics.measure(render(built.bytes, Math.round(41 * 59.6), skip), 40);       // the busiest stretch, as heard
  report.push(`sound: bands ${m.bands.map((b) => b.toFixed(2)).join(' ')} (Capcom median 0.57 0.23 0.09 0.07), crest ${m.crest} dB (Capcom 15.0..16.9), motion ${m.motion} (6.2..11.8), key-ons/s ${m.keys}, busiest 20 s ${full.busiest.toFixed(1)} (28..50)`);
  const output = options.out || OUT;
  fs.mkdirSync(output, { recursive: true });
  const stem = path.join(output, plan.file);
  fs.writeFileSync(stem + '.sf3project.json', JSON.stringify({ format: 'sf3project', version: 1, names: {}, project }));
  fs.writeFileSync(stem + '.sf3song.json', JSON.stringify(Project.songFile(project, built, {})));
  writeWav(stem + '.wav', full);
  fs.writeFileSync(stem + '.report.txt', report.join('\n') + '\n');
  if (!options.out) require('./library.js').write();      // the classic editor lists its own arrangements
  return { report, stem, bytes: built.bytes.length, metrics: m };
}

module.exports = { arrange, build, breakBar, chooseKit, guessRoles, analyse, prepare };

if (require.main === module) {
  const arg = process.argv[2];
  let plan = /\.midi?$/i.test(arg) ? { midi: arg, name: path.basename(arg).replace(/\.midi?$/i, ''), file: path.basename(arg).replace(/\.midi?$/i, '').replace(/[^\w-]+/g, '_') + '_3s' }
    : require(path.resolve(arg));
  const v = process.argv[3];
  if (v !== undefined && plan.variants) plan = Object.assign({}, plan, plan.variants[Number(v)]);
  const r = build(plan);
  console.log(r.report.join('\n'));
  console.log(`wrote ${r.stem}.{sf3project.json,sf3song.json,wav,report.txt}`);
}
