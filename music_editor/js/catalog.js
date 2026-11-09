/* The instrument catalog: every instrument the game's sound driver can play, with a name, a family
 * and the true facts a musician can use. Headless (browser and Node); nothing here reads a file.
 *
 *   SF3Catalog.build(engine, data) -> catalog      engine: the sound engine (its sample data); data: SF3Data.load(engine)
 *   SF3Catalog.NAMES                               our own short names and sentences for the 59 music programs
 *   SF3Catalog.suggest(role, gmProgram)            a starting instrument and Capcom's levels for a part's role (static)
 *   SF3Catalog.nameOf(catalog, bank, program, names)   the user's own name wins, then ours
 *
 * Everything measured comes from the engine's samples and the 49 pieces of music, each time it is built:
 *  - what Capcom plays: every track of every piece is walked the way the driver walks it, from its
 *    first note to the first time its state repeats (so one pass of a loop, intro included). A loop
 *    counted past 64 passes (Capcom's `D4 126`, 127 passes) is read as endless. Tracks are not cut at the
 *    song's loop length. checks/gates/g_catalog.js reads the bytes again with a second interpreter and
 *    watches the driver play every piece; both give the same notes.
 *  - tuning: the pitch of each sample against the pitch the driver assumes (port of checks/tuning.js);
 *  - tone and kit slices: attack, decay, centroid, kick/snare/hat labels (ports of style/sounds.js);
 *  - break bars: every bar of break programming per kit (port of style/breaks.js);
 *  - echoes, doubles and glides, found the way style/techniques.js finds them, and Capcom's usual levels.
 * Names, families and roles are ours (NAMES, FAMILY_OF, ROLE_OF below), not Capcom's.
 *
 * SF3Catalog.build(engine, data) -> catalog; SF3Catalog.buildAsync(engine, data, { onProgress, every }) -> the same, yielding to the page
 *   between pieces and programs (for a responsive cold start in the browser)
 * catalog = { version, programs, breaks, roles, families, study }                 (plain JSON; build twice = identical)
 *  programs['bank:program']  every program of the ROM: the 59 music programs ('0:20') and the 573 effects and voices (banks 1-7, 15)
 *    { bank, program, name, sure, description, family, role, kit, breakKit, sustained, zones, range, naturalNote, usage,
 *      tuningCents, tuningConfidence, tone, keys, tempo }
 *    zones   [ { keyLow, keyHigh, sample, root, looped, seconds (at the root key), level, pan (null: the track's), fine,
 *               envelope { attack, decay, sustain, sustainRate, release }, ringOut, notes (Capcom's notes in this zone), tuningCents, tuningConfidence } ]
 *    range   { low, high, median, typicalLow, typicalHigh }: the notes of all 49 pieces (typical = 2 % to 98 %); null if Capcom never plays it
 *    naturalNote  median of (note - root key of the zone that sounds it): where Capcom plays the sample, relative to its root (kits: -20)
 *    usage   { pieces: [codes], notes } count all 49 pieces. { tracks, basis, volume, expression, velocity, pan, noteLength (ticks),
 *            echoed, doubled, glided (tracks), glides (notes) } are read from the original tracks (not their echoes) of the 41 fighting and
 *            long pieces, as style/techniques.js does: basis 'main' = the tracks whose usual program this is; 'any' = nobody's usual program,
 *            so the tracks that play it at all; 'other' = only the short pieces and jingles play it, so their tracks; null = none
 *    tuning  of the zone Capcom plays most (a kit has none): cents sharp (+) or flat (-) and the measurement's confidence (0..1);
 *            low confidence means a noisy or unpitched sound: do not auto-correct it
 *    tone    at the note Capcom plays most in that zone: { note, sample, attackMs, decayMs (null: it loops), seconds, looped, centroidHz, brightness
 *            (centroid / the note's pitch), peakDb, rmsDb }
 *    keys    kits only: [ { key, label ('slice 3', 'snare'...), role, sound (K S H M), seconds, sample, level (dB), uses, capcom } ] in key order
 *    tempo   break kits: the loop's own tempo
 *  breaks['1'] = { tempo, bars: [ { piece, bpm, bar, notes: [ { t, n, len, v } ] } ] }   Capcom's distinct bars for kits 0 1 2 3 4 10 11 12 13,
 *            t in ticks from the bar line, v on the project's 1..127 scale, so a bar can be written into a part as it is
 *  roles.bass = { volume, expression, velocity, pan, echo: { delay (ticks), level } | null, tracks, programs }   Capcom's medians per role
 *  study = { pieces, tracks, doubles, echoes }   what the echo and double search found over the fighting and long pieces
 *
 * Tuning sign: tuningCents > 0 means the sound plays that many cents SHARP of the key it is mapped to
 * (so auto-tune adds -tuningCents). Velocities are on the project's 1..127 scale (the driver's 0..63, doubled).
 * Keys of catalog.programs are 'bank:program' ('0:20'). The catalog is derived from the user's ROM: private.
 */
(function (g) {
  'use strict';
  const Seq = g.SF3Seq || require('./seq.js');
  const Data = g.SF3Data || require('./gamedata.js');

  const CHIP_RATE = 42954500 / 3 / 384, ROOT_RATE = CHIP_RATE * 0xFE1 / 4096;     // a note equal to the root key plays at step 0x0FE1
  const BAR = Seq.BAR, FOREVER = 64;
  const VERSION = 2;                                              // includes corrected names: rebuild cached catalogs too
  const FAMILIES = ['Drums', 'Bass', 'Keys & plucks', 'Pads & strings', 'Leads', 'Hits & chops', 'Effects & voices'];
  const ROLES = ['drums', 'perc', 'bass', 'chords', 'pad', 'lead', 'arp', 'fx'];
  const BREAK_KITS = [0, 1, 2, 3, 4, 10, 11, 12, 13];
  const EFFECT_BANKS = [1, 2, 3, 4, 5, 6, 7, 15];

  /* ---- names, families, roles: ours ---------------------------------------------------------------- */
  /* One short name and one plain sentence per music program: [name, sentence, sure]. Ours, not Capcom's. `sure` is true only where the
   * Studio's author judged the sound by ear (19 slap bass, 46 strings, 57 sax-like voice, 58 harpsichord-like, 60 bell); every other name
   * describes what was measured, never a guessed instrument. No numbers in the sentences: the catalog measures those. */
  const NAMES = {
    0: ['Break A', 'A one-bar drum loop cut into eight slices, one per key. Kick-heavy at the start, hats at the end.'],
    1: ['Break B', 'A one-bar drum loop cut into nine slices, one per key. Mostly kicks first, then snares.'],
    2: ['Break C', 'A one-bar drum loop cut into eight slices. Only the first is a kick; the rest are hats and cymbals.'],
    3: ['Break D', 'A one-bar drum loop cut into seven slices, with kicks and two snares.'],
    4: ['Break E', 'A one-bar drum loop cut into nine slices, one per key, with kicks, snares and a hat.'],
    5: ['Drum hits (variant)', 'Single drum and percussion hits laid out like General MIDI, with other hats than the main set.'],
    6: ['Drum hits (GM keys)', 'Single drum and percussion hits laid out like General MIDI: kick, snare, clap, hats, crash, ride and more. Capcom layers them over its breaks.'],
    7: ['Loop set A', 'Whole one-bar drum loops, one per key, most of them about two seconds long.'],
    8: ['Loop set B', 'More whole one-bar drum loops, one per key, most of them about two and a half seconds long.'],
    9: ['Slow rise', 'A one-shot sound that rises over more than a second and lasts about three seconds. Capcom uses it once.'],
    10: ['Beat pieces', 'Beat-long drum pieces, played as notes. Capcom uses them in the two Ryu themes.'],
    11: ['Break F', 'A slower one-bar drum loop cut into eight slices, with kicks and snares.'],
    12: ['Break G', 'A short break kit: four slices, all snare-heavy.'],
    13: ['Break H', 'A fast one-bar drum loop cut into eight slices, with longer beat pieces on the keys above.'],
    18: ['Sub bass', 'A round, nearly pure low tone that holds for as long as the note lasts.'],
    19: ['Slap bass', 'A snappy slap bass that holds while the note lasts and plays over a wide range.', true],
    20: ['Main bass', 'Round and sustained: Capcom\'s usual bass.'],
    21: ['Synth tone', 'A thin, almost plain tone made from a very short loop. Capcom plays it high, with a lot of glides.'],
    22: ['Split tone', 'Four zones: a looped tone in the low zone and one-shot sounds above it.'],
    23: ['Single chop', 'A short, bright one-shot sound.'],
    24: ['Chop set A \u00B7 1', 'One of six short one-shot chops that Capcom plays together, echoed, in a few themes.'],
    25: ['Chop set A \u00B7 2', 'One of six short one-shot chops that Capcom plays together, echoed, in a few themes.'],
    26: ['Chop set A \u00B7 3', 'One of six short one-shot chops that Capcom plays together, echoed, in a few themes.'],
    27: ['Chop set A \u00B7 4', 'One of six short one-shot chops that Capcom plays together, echoed, in a few themes.'],
    28: ['Chop set A \u00B7 5', 'One of six short one-shot chops that Capcom plays together, echoed, in a few themes.'],
    29: ['Chop set A \u00B7 6', 'One of six short one-shot chops that Capcom plays together, echoed, in a few themes.'],
    30: ['Chop set B \u00B7 1', 'One of seven one-shot tones that fade in quickly and last about half a second.'],
    31: ['Chop set B \u00B7 2', 'One of seven one-shot tones that fade in quickly and last about half a second.'],
    32: ['Chop set B \u00B7 3', 'One of seven one-shot tones that fade in quickly and last about half a second.'],
    33: ['Chop set B \u00B7 4', 'One of seven one-shot tones that fade in quickly and last about half a second.'],
    34: ['Chop set B \u00B7 5', 'One of seven one-shot tones that fade in quickly and last about half a second.'],
    35: ['Chop set B \u00B7 6', 'One of seven one-shot tones that fade in quickly and last about half a second.'],
    36: ['Chop set B \u00B7 7', 'One of seven one-shot tones that fade in quickly and last about half a second.'],
    37: ['Bright chord voice', 'A bright, sustained tone. Capcom plays it as short chord stabs and echoes it often.'],
    38: ['Mellow chord voice', 'A sustained tone like Bright chord voice, but less bright.'],
    39: ['Airy pad', 'A bright, sustained tone for high held chords. Capcom keeps it quiet and echoes it often.'],
    40: ['Swell', 'A one-shot swell: it fades in over about half a second and dies away in about two seconds.'],
    41: ['Chord tone', 'A smooth, almost plain sustained tone in three zones. Capcom plays short chords with it.'],
    42: ['Bright sustained voice', 'A bright, sustained tone used for melodies. Capcom keeps it quiet and glides into its notes. The label describes its sound.'],
    43: ['Thin sustained voice', 'A thin, sustained tone used for high melodies. The label describes its sound, not a General MIDI instrument.'],
    44: ['Rich sustained voice', 'A sustained tone rich in high harmonics. Capcom plays it in quick, short notes. The label describes its sound.'],
    45: ['Slow pad', 'A sustained tone that fades in over more than a second, for very long held notes.'],
    46: ['Strings', 'A sustained, string-like pad in three zones. Capcom echoes it in many themes.', true],
    47: ['Long swell', 'A one-shot swell that fades in over about a second and lasts nearly three seconds.'],
    48: ['Buzz tone', 'A buzzy sustained tone with many high harmonics. Capcom uses it in short notes in only a few pieces.'],
    49: ['Chop set C \u00B7 1', 'One of eight one-shot tones, up to a second long, that Capcom plays together in a few themes.'],
    50: ['Chop set C \u00B7 2', 'One of eight one-shot tones, up to a second long, that Capcom plays together in a few themes.'],
    51: ['Chop set C \u00B7 3', 'One of eight one-shot tones, up to a second long, that Capcom plays together in a few themes.'],
    52: ['Chop set C \u00B7 4', 'One of eight one-shot tones, up to a second long, that Capcom plays together in a few themes.'],
    53: ['Chop set C \u00B7 5', 'One of eight one-shot tones, up to a second long, that Capcom plays together in a few themes.'],
    54: ['Chop set C \u00B7 6', 'One of eight one-shot tones, up to a second long, that Capcom plays together in a few themes.'],
    55: ['Chop set C \u00B7 7', 'One of eight one-shot tones, up to a second long, that Capcom plays together in a few themes.'],
    56: ['Chop set C \u00B7 8', 'One of eight one-shot tones, up to a second long, that Capcom plays together in a few themes.'],
    57: ['Sax-like reed voice', 'A reedy, sax-like voice; its long sample loop also works for held chords. Previously labelled Deep pad: pad describes its use in an arrangement, not its instrument identity.', true],
    58: ['Harpsichord-like pluck', 'A plucked tone that plays once and fades.', true],
    59: ['Slow chop', 'A one-shot sound that swells in over about three quarters of a second and lasts over two seconds.'],
    60: ['Bell', 'A short, bell-like pluck.', true],
    61: ['Percussion hits', 'Very short single percussion hits spread over the keyboard.'],
    62: ['Short chop', 'A very short one-shot hit, under half a second.'],
  };
  /* program -> family and project role. Kits and loops are drums (5, 6 and 61, single hits, are perc); the chop sets and the one-off rise (9)
   * are fx; swells and slow tones are pads. A pitched program's role is how Capcom uses it (range, note length, where it sits in the mix). */
  const FAMILY_OF = {}, ROLE_OF = {};
  // Old display names remain searchable. These are timbre/usage descriptions, not GM program identities.
  const ALIASES = {
    37: ['Bright stab'], 38: ['Mellow stab'], 42: ['Bright lead'],
    43: ['Thin lead'], 44: ['Rich lead'], 57: ['Deep pad', 'sax', 'saxophone', 'reed'],
  };
  const put = (family, role, programs) => programs.forEach((p) => { FAMILY_OF[p] = family; ROLE_OF[p] = role; });
  put('Drums', 'drums', [0, 1, 2, 3, 4, 7, 8, 10, 11, 12, 13]);
  put('Drums', 'perc', [5, 6, 61]);
  put('Bass', 'bass', [18, 19, 20]);
  put('Keys & plucks', 'chords', [37, 38, 41, 48]);
  put('Keys & plucks', 'arp', [58, 60]);
  put('Pads & strings', 'pad', [22, 39, 40, 45, 46, 47, 57]);
  put('Leads', 'lead', [21, 42, 43, 44]);
  put('Hits & chops', 'fx', [9, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 49, 50, 51, 52, 53, 54, 55, 56, 59, 62]);

  /* kit 6 follows General MIDI keys (02_DRIVER section 5); kit 5 shares its samples on most keys */
  const GM_KEYS = { 36: ['kick', 'kick'], 38: ['snare', 'snare'], 39: ['clap', 'clap'], 42: ['closed hat', 'hat'], 45: ['long low boom', 'boom'], 46: ['open hat', 'hat'],
                    49: ['crash', 'crash'], 51: ['ride', 'ride'], 54: ['tambourine', 'perc'], 56: ['bell', 'bell'] };

  /* ---- small helpers --------------------------------------------------------------------------------- */
  const median = (xs) => { if (!xs.length) return null; const s = xs.slice().sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
  const quantile = (xs, f) => { const s = xs.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(f * s.length))]; };
  const round = (v, d) => { const k = Math.pow(10, d); return Math.round(v * k) / k; };
  const db = (v) => 20 * Math.log10(Math.max(v, 1e-6));

  /* ---- measuring a sample ---------------------------------------------------------------------------- */
  /* RBJ biquad filters (as style/sounds.js) */
  function biquad(type, f0, fs, q) {
    const w = 2 * Math.PI * f0 / fs, c = Math.cos(w), s = Math.sin(w), a = s / (2 * (q || 0.707));
    let b0, b1, b2;
    if (type === 'lp') { b0 = (1 - c) / 2; b1 = 1 - c; b2 = (1 - c) / 2; }
    else if (type === 'hp') { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = (1 + c) / 2; }
    else { b0 = a; b1 = 0; b2 = -a; }
    const a0 = 1 + a, a1 = -2 * c, a2 = 1 - a;
    return (x) => { const y = new Float64Array(x.length); let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
      for (let i = 0; i < x.length; i++) { const v = (b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0; x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v; } return y; };
  }
  const rms = (x, from, to) => { let s = 0; to = Math.min(to, x.length); for (let i = from; i < to; i++) s += x[i] * x[i]; return to > from ? Math.sqrt(s / (to - from)) : 0; };
  function pcm(samples, s) { const x = new Float64Array(s.end - s.start); for (let i = 0; i < x.length; i++) x[i] = samples[s.start + i] / 128; return x; }

  /* A drum slice at the rate it plays: band levels in 10 ms windows; K kick (low band), S snare, H hat, M mid. */
  function slice(samples, s, rate) {
    const x = pcm(samples, s), win = Math.max(1, Math.round(rate * 0.010));
    const low = biquad('lp', 110, rate, 0.8)(x), mid = biquad('bp', 1200, rate, 0.7)(x), high = biquad('hp', 3500, rate, 0.7)(x);
    const frames = [];
    for (let i = 0; i < x.length; i += win) frames.push({ all: rms(x, i, i + win), low: rms(low, i, i + win), mid: rms(mid, i, i + win), high: rms(high, i, i + win) });
    let peak = 0;
    for (const f of frames) if (f.all > peak) peak = f.all;
    peak = peak || 1;
    const head = frames.slice(0, 4), sum = (b) => head.reduce((a, f) => a + f[b], 0);
    const lo = sum('low'), mi = sum('mid'), hi = sum('high'), tot = lo + mi + hi || 1;
    let label = '';
    if (lo / tot > 0.45) label += 'K';
    if (mi / tot > 0.35 && hi / tot > 0.12 && lo / tot < 0.5) label += 'S';
    if (!label) label = hi / tot > 0.35 ? 'H' : mi / tot > 0.5 ? 'M' : 'K';
    return { seconds: +(x.length / rate).toFixed(3), label, low: +(lo / tot).toFixed(2), mid: +(mi / tot).toFixed(2), high: +(hi / tot).toFixed(2), level: +db(peak).toFixed(1) };
  }

  /* 512-point spectrum of a Hann-windowed stretch, by FFT (style/sounds.js uses the plain DFT: same numbers, a thousand times faster) */
  const FFT_N = 512, HANN = new Float64Array(FFT_N), COS = new Float64Array(FFT_N / 2), SIN = new Float64Array(FFT_N / 2), REV = new Uint16Array(FFT_N);
  for (let i = 0; i < FFT_N; i++) HANN[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / FFT_N);
  for (let i = 0; i < FFT_N / 2; i++) { COS[i] = Math.cos(2 * Math.PI * i / FFT_N); SIN[i] = Math.sin(2 * Math.PI * i / FFT_N); }
  for (let i = 0; i < FFT_N; i++) { let r = 0; for (let b = 0; b < 9; b++) if (i & (1 << b)) r |= 1 << (8 - b); REV[i] = r; }
  const RE = new Float64Array(FFT_N), IM = new Float64Array(FFT_N);
  function centroid(x, from, rate) {
    for (let i = 0; i < FFT_N; i++) { RE[REV[i]] = from + i < x.length ? x[from + i] * HANN[i] : 0; IM[REV[i]] = 0; }
    for (let size = 2; size <= FFT_N; size <<= 1) {
      const half = size >> 1, step = FFT_N / size;
      for (let i = 0; i < FFT_N; i += size) for (let j = 0; j < half; j++) {
        const wr = COS[j * step], wi = -SIN[j * step], a = i + j, b = a + half;
        const tr = RE[b] * wr - IM[b] * wi, ti = RE[b] * wi + IM[b] * wr;
        RE[b] = RE[a] - tr; IM[b] = IM[a] - ti; RE[a] += tr; IM[a] += ti;
      }
    }
    let num = 0, den = 0;
    for (let k = 1; k < FFT_N / 2; k++) { const m = Math.hypot(RE[k], IM[k]); num += m * k * rate / FFT_N; den += m; }
    return { hz: Math.round(num / (den || 1)), raw: num / (den || 1) };
  }

  /* A pitched sound at a note: attack, decay to -10 % of its loudest 10 ms, length, brightness (as style/sounds.js tone) */
  function tone(samples, s, note) {
    const rate = ROOT_RATE * Math.pow(2, (note - s.root) / 12);
    const x = pcm(samples, s), win = Math.max(1, Math.round(rate * 0.010));
    const env = [];
    for (let i = 0; i < x.length; i += win) env.push(rms(x, i, i + win));
    let peak = 0, at = 0;
    for (let k = 0; k < env.length; k++) if (env[k] > peak) { peak = env[k]; at = k; }
    peak = peak || 1;
    let decay = env.length;
    for (let k = at; k < env.length; k++) if (env[k] < peak * 0.1) { decay = k; break; }
    const c = centroid(x, Math.min(at * win, Math.max(0, x.length - FFT_N)), rate);
    const f0 = 440 * Math.pow(2, (note - 69) / 12);
    let top = 0, sq = 0;
    for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); if (a > top) top = a; sq += x[i] * x[i]; }
    return { note, attackMs: at * 10, decayMs: s.looped ? null : decay * 10, seconds: +(x.length / rate).toFixed(2), looped: s.looped, centroidHz: c.hz,
             brightness: +(c.raw / f0).toFixed(1), peakDb: +db(top).toFixed(1), rmsDb: +db(Math.sqrt(sq / (x.length || 1))).toFixed(1) };
  }

  /* How far from its key is a sound's pitch, in cents (port of checks/tuning.js: autocorrelation followed out to about 40 periods;
   * the nearest octave is ignored, since a root key can be labelled an octave away). null when there is no clear pitch. */
  function tuning(samples, s) {
    const from = s.looped ? s.loop : s.start + Math.floor((s.end - s.start) * 0.25);
    const n = Math.min(s.end - from, 6000);
    if (n < 400) return null;
    const x = new Float64Array(n);
    let mean = 0;
    for (let i = 0; i < n; i++) { x[i] = samples[from + i]; mean += x[i]; }
    mean /= n; for (let i = 0; i < n; i++) x[i] -= mean;
    const corr = (lag) => { let a = 0, b = 0, c = 0; for (let i = 0; i + lag < n; i++) { a += x[i] * x[i + lag]; b += x[i] * x[i]; c += x[i + lag] * x[i + lag]; } return a / Math.sqrt(b * c + 1e-9); };
    let best = 0, period = 0;
    const cs = [];
    for (let lag = 4; lag < Math.min(900, n / 3); lag++) cs[lag] = corr(lag);
    for (let lag = 5; lag < cs.length - 1; lag++) if (cs[lag] > cs[lag - 1] && cs[lag] >= cs[lag + 1] && cs[lag] > best + 0.03) { if (cs[lag] > 0.5 && !period) period = lag; best = Math.max(best, cs[lag]); }
    if (!period) return null;
    let p = period, conf = cs[period];
    for (let k = 2; k * p < n * 0.6 && k <= 40; k = Math.ceil(k * 1.5)) {
      const centre = Math.round(k * p);
      let bl = centre, bc = -2;
      for (let lag = centre - 3; lag <= centre + 3; lag++) { const c = corr(lag); if (c > bc) { bc = c; bl = lag; } }
      if (bc < 0.4) break;
      const l = corr(bl - 1), r = corr(bl + 1), shift = (l - r) / (2 * (l - 2 * bc + r) || 1);
      p = (bl + shift) / k; conf = bc;
    }
    const hz = ROOT_RATE / p, want = 440 * Math.pow(2, (s.root - 69) / 12);
    let cents = 1200 * Math.log2(hz / want);
    cents -= 1200 * Math.round(cents / 1200);
    return { cents: round(cents, 1), confidence: round(conf, 3) };
  }

  /* ---- walking a track as the driver does -------------------------------------------------------------- */
  /* Notes in play order with the settings in force at each. Stops at the end of the track or the first time
   * its state (position and loop counters) comes round again; a counter past FOREVER does not count.
   * With `limit` the track is played on (loops unrolled) up to that tick, as a song's own loop length cuts it. */
  function walk(events, limit) {
    const counters = [0, 0, 0, 0], loopStart = [0, 0, 0, 0], seen = new Set();
    const st = { bank: 0, program: 0, volume: -1, expression: -1, pan: -1 };
    const notes = [];
    let i = 0, tick = 0, cur = null, steps = 0, looped = false;
    while (i < events.length && steps++ < 4000000) {
      tick += events[i].d;
      if (limit !== undefined && tick > limit) break;
      if (!looped) {
        const key = i + ':' + counters.map((c) => (c > FOREVER ? 0 : c)).join(',');
        if (seen.has(key)) { if (limit === undefined) break; looped = true; } else seen.add(key);
      }
      const e = events[i];
      if (e.k === 'note') {
        cur = { t: tick, n: e.n, v: e.v, len: e.len, bank: st.bank, program: st.program, volume: st.volume, expression: st.expression, pan: st.pan, glide: false };
        notes.push(cur); i++; continue;
      }
      const op = e.op;
      if (e.k === 'jump') {
        if (op >= 0xD8) { const c = op - 0xD8; if (counters[c] === 1) { counters[c] = 0; i = e.to; } else i++; }
        else if (op === 0xCE) i = e.to;
        else i++;
        continue;
      }
      if (op >= 0xD0 && op <= 0xD3) { loopStart[op - 0xD0] = i + 1; i++; continue; }
      if (op >= 0xD4 && op <= 0xD7) {
        const c = op - 0xD4;
        if (counters[c]) { counters[c]--; i = counters[c] ? loopStart[c] : i + 1; } else { counters[c] = e.a[0]; i = loopStart[c]; }
        continue;
      }
      if (op === 0xFF) break;
      if (op === 0xC2) st.bank = e.a[0] & 15; else if (op === 0xC4) st.program = e.a[0] & 127;
      else if (op === 0xC6) st.volume = e.a[0]; else if (op === 0xC8) st.expression = e.a[0]; else if (op === 0xC7) st.pan = e.a[0];
      else if (op === 0xC3 && cur && tick > cur.t) cur.glide = true;           // a detune inside a note: a glide
      i++;
    }
    return { notes };
  }

  /* B copies A, later by at most 96 ticks: most of B's notes are A's moved by a fixed shift (and interval). The shortest shift that
   * most notes agree on wins, so a 2-tick double is not mistaken for a 190-tick echo (style/techniques.js copyOf; only the pairs
   * within the window are looked at, which is every pair the original counts). */
  function copyOf(a, b) {
    if (a.notes.length < 4 || b.notes.length < 4) return null;
    const votes = new Map();
    let lo = 0;
    for (const nb of b.notes) {
      while (lo < a.notes.length && a.notes[lo].t < nb.t - 96) lo++;
      for (let j = lo; j < a.notes.length && a.notes[j].t < nb.t; j++) {
        const na = a.notes[j], k = (nb.t - na.t) * 256 + (nb.n - na.n + 128);
        votes.set(k, (votes.get(k) || 0) + 1);
      }
    }
    let top = 0;
    for (const v of votes.values()) top = Math.max(top, v);
    const best = { d: 1e9, hits: 0, interval: 0 };
    for (const [k, v] of votes) if (v >= top * 0.95 && (k >> 8) < best.d) { best.hits = v; best.d = k >> 8; best.interval = (k & 255) - 128; }
    const share = best.hits / Math.max(a.notes.length, b.notes.length);
    if (share < 0.6) return null;
    return { delay: best.d, interval: best.interval, share: +share.toFixed(2) };
  }

  /* one piece: its tracks walked (`notes`: the first pass; `window`: unrolled to the song's loop length, so tracks line up in
   * time) and which are echoes or doubles of which (searched in fighting and long pieces only, as style/techniques.js) */
  function analysePiece(song) {
    const info = Data.describe(song), end = info.loopStart + info.loopLength;
    const tracks = [];
    info.seq.tracks.forEach((events, k) => {
      if (!events) return;
      const w = walk(events);
      if (!w.notes.length) return;
      tracks.push({ k, notes: w.notes, window: info.loopLength ? walk(events, end - 1).notes : w.notes });
    });
    const copies = [], isCopy = new Set(), fighting = !!(info.loopLength && info.bars >= 4);
    if (fighting) {
      const cands = [], lines = tracks.map((t) => ({ k: t.k, notes: t.window }));
      for (const b of lines) for (const a of lines) if (a !== b) { const c = copyOf(a, b); if (c) cands.push(Object.assign({ source: a.k, track: b.k }, c)); }
      cands.sort((p, q) => p.delay - q.delay || q.share - p.share);
      const level = (t) => median(t.notes.map((n) => n.volume)) * median(t.notes.map((n) => n.expression));
      for (const found of cands) {
        if (isCopy.has(found.track) || isCopy.has(found.source) || copies.some((c) => c.source === found.track)) continue;
        const a = lines.find((t) => t.k === found.source), b = lines.find((t) => t.k === found.track);
        found.level = level(b) / Math.max(1, level(a));
        found.kind = found.delay <= 4 ? 'double' : 'echo';
        found.program = median(a.notes.map((n) => n.program));
        found.bank = median(a.notes.map((n) => n.bank));
        copies.push(found); isCopy.add(b.k);
      }
    }
    return { song, info, tracks, copies, isCopy, fighting };
  }


  /* ---- kit keys and break bars -------------------------------------------------------------------------- */
  /* the keys of a kit: every key from 36 to 72 that one of its zones sounds (the catch-all zone from 0 only by its top key).
   * A held, looped tone inside a kit (kit 13's sub bass above key 71) is a pitched instrument, not a pad, and is left out. */
  function kitKeyList(program, samples) {
    const out = [];
    for (const r of program.live) {
      const s = samples[r.sample];
      if (s && s.looped) continue;
      for (let key = Math.max(r.keyLow, 36); key <= Math.min(r.keyHigh, 72); key++) {
        if (r.keyLow < 36 && key !== r.keyHigh) continue;
        out.push({ key, region: r });
      }
    }
    return out;
  }

  /* what a slice is, from the sound analysis (K kick, S snare, H hat or cymbal, M mid-range hit; both K and S: a mixed slice) */
  const SOUND_ROLE = { K: 'kick', S: 'snare', H: 'hat', M: 'perc', KS: 'slice' };

  /* where Capcom puts a key in the bar decides if it is a kick or a snare (style/breaks.js) */
  function placementRole(m, st) {
    const on = st.steps[0] + st.steps[4], back = st.steps[2] + st.steps[6], between = st.steps[1] + st.steps[3] + st.steps[5] + st.steps[7] + st.off, total = on + back + between;
    return total >= 8 && back / total > 0.5 ? 'snare' : total >= 8 && on / total > 0.5 && m.low > 0.4 ? 'kick' : m.label === 'K' && m.low >= 0.55 ? 'kick' : m.label === 'S' ? 'snare' : 'ghost';
  }

  /* every key of a kit, named, with its length and sound analysed at the pitch the key plays it */
  function kitKeys(samples, data, bank, rom, uses, stats) {
    const isBreak = bank === 0 && BREAK_KITS.includes(rom.program), isLoops = bank === 0 && (rom.program === 7 || rom.program === 8), isHits = bank === 0 && (rom.program === 5 || rom.program === 6);
    /* a break kit's beat pieces (above its slices) are played at one key each, the key that is their root minus 20; the keys around it
     * play the same piece at other pitches and are left out */
    const native = (k) => k.key === Math.max(k.region.keyLow, Math.min(k.region.keyHigh, k.s.root - 20));
    const list = kitKeyList(rom, data.samples).map((k) => { const s = data.samples[k.region.sample]; return { key: k.key, region: k.region, s, m: s ? slice(samples, s, ROOT_RATE * Math.pow(2, (k.key - s.root) / 12)) : null }; })
      .filter((k) => k.m && (!isBreak || k.key <= 48 || native(k)));
    const lens = list.filter((k) => k.key >= 41 && k.key <= 48).map((k) => k.m.seconds);
    const sliceLen = lens.length ? median(lens) : 0;
    /* kit 6 follows General MIDI keys; kit 5 has the same sounds on most keys, so it takes the same names where the sample is the same */
    const gm6 = isHits && data.banks[0][6] ? kitKeyList(data.banks[0][6], data.samples) : [];
    const likeKit6 = (key, sample) => { const x = gm6.find((e) => e.key === key); return !!x && x.region.sample === sample; };
    let beats = 0;
    return list.map((k) => {
      const m = k.m;
      let label, role = bank === 0 ? SOUND_ROLE[m.label] || 'slice' : 'hit';
      if (isBreak && (k.key <= 48 || m.seconds <= 1.3 * sliceLen)) label = `slice ${k.key - 40}`;
      else if (isBreak) { label = `beat piece ${++beats}`; role = 'beat'; }
      else if (isLoops) { label = `loop ${k.key - 59}`; role = 'loop'; }
      else if (isHits && GM_KEYS[k.key] && (rom.program === 6 || likeKit6(k.key, k.region.sample))) { label = GM_KEYS[k.key][0]; role = GM_KEYS[k.key][1]; }
      else if (isHits) label = `hit ${k.key}`;
      else label = bank === 0 ? `hit ${k.key}` : `sound ${k.key}`;
      const st = isBreak ? (stats && stats[k.key]) || { steps: new Array(8).fill(0), off: 0 } : null;
      return { key: k.key, label, role, sound: m.label, seconds: m.seconds, sample: k.region.sample, level: m.level, uses: uses.get(k.key) || 0, capcom: st ? placementRole(m, st) : null };
    });
  }

  /* ---- the catalog --------------------------------------------------------------------------------------- */
  /* build() runs the steps straight through; buildAsync() lets the page breathe between them (same result) */
  function build(engine, data) {
    const it = steps(engine, data);
    let r = it.next();
    while (!r.done) r = it.next();
    return r.value;
  }
  /* opts: { onProgress({ stage, done, total }), every (steps between pauses, default 4: about 5 ms each) };
   * resolves to exactly what build() returns. No clock is read: the catalog stays deterministic. */
  async function buildAsync(engine, data, opts) {
    opts = opts || {};
    const every = Math.max(1, opts.every || 4);
    const it = steps(engine, data);
    let r = it.next(), n = 0;
    while (!r.done) {
      if (opts.onProgress) opts.onProgress(r.value);
      if (++n % every === 0) await new Promise((res) => setTimeout(res, 0));
      r = it.next();
    }
    return r.value;
  }
  function* steps(engine, data) {
    const samples = engine.samples;
    const pieces = [];
    for (let i = 0; i < data.songs.length; i++) { pieces.push(analysePiece(data.songs[i])); yield { stage: 'pieces', done: i + 1, total: data.songs.length }; }
    const programTotal = data.banks.reduce((n, list) => n + list.filter(Boolean).length, 0);
    let programDone = 0;

    /* what Capcom plays: every note of every piece (first pass of each track) */
    const use = new Map();                                       // 'bank:program' -> { notes, pieces, zoneNotes, rootRel, keyUses }
    const slot = (key) => { if (!use.has(key)) use.set(key, { notes: [], pieces: new Set(), zoneNotes: new Map(), rootRel: [], keyUses: new Map() }); return use.get(key); };
    /* how Capcom sets its tracks up: per original track of the fighting and long pieces. A track belongs to the program that is the
     * median of its notes' programs (style/techniques.js); a program no track belongs to is read from the tracks that play it at all. */
    const newAcc = () => ({ tracks: 0, echoed: 0, doubled: 0, glided: 0, glides: 0, volume: [], expression: [], velocity: [], pan: [], length: [] });
    const main = new Map(), any = new Map(), other = new Map();      // other: the short pieces and jingles, for programs only they play
    const accOf = (map, key) => { if (!map.has(key)) map.set(key, newAcc()); return map.get(key); };
    const addTrack = (a, ns, src) => {
      a.tracks++;
      if (src && src.echo) a.echoed++;
      if (src && src.double) a.doubled++;
      const glides = ns.filter((n) => n.glide).length;
      if (glides) a.glided++;
      a.glides += glides;
      const set = (name, vals) => { vals = vals.filter((v) => v >= 0); if (vals.length) a[name].push(median(vals)); };
      set('volume', ns.map((n) => n.volume)); set('expression', ns.map((n) => n.expression)); set('pan', ns.map((n) => n.pan));
      a.velocity.push(median(ns.map((n) => n.v * 2))); a.length.push(median(ns.map((n) => n.len)));
    };
    const roleAcc = {}, study = { pieces: 0, tracks: 0, doubles: 0, echoes: 0 };
    for (const r of ROLES) roleAcc[r] = { acc: newAcc(), programs: new Set(), delays: [], levels: [] };
    const breakStats = {}, breaks = {};
    for (const k of BREAK_KITS) { breakStats[k] = {}; breaks[k] = { tempo: 0, bars: [], seen: new Set() }; }

    for (const pc of pieces) {
      const sources = new Map();
      for (const c of pc.copies) { if (!sources.has(c.source)) sources.set(c.source, {}); sources.get(c.source)[c.kind] = true; }
      if (pc.fighting) {
        study.pieces++; study.tracks += pc.tracks.length;
        study.doubles += pc.copies.filter((c) => c.kind === 'double').length; study.echoes += pc.copies.filter((c) => c.kind === 'echo').length;
      }
      for (const t of pc.tracks) {
        for (const n of t.notes) {
          const key = `${n.bank}:${n.program}`, u = slot(key);
          u.notes.push(n.n); u.pieces.add(pc.song.code);
          u.keyUses.set(n.n, (u.keyUses.get(n.n) || 0) + 1);
          const rom = data.banks[n.bank] && data.banks[n.bank][n.program], zi = rom ? rom.live.findIndex((r) => r.keyHigh >= n.n) : -1;
          if (zi >= 0) { u.zoneNotes.set(zi, (u.zoneNotes.get(zi) || 0) + 1); const s = data.samples[rom.live[zi].sample]; if (s) u.rootRel.push(n.n - s.root); }
        }
        if (pc.isCopy.has(t.k)) continue;
        const w = t.window, src = sources.get(t.k);
        const groups = new Map();
        for (const n of w) { const key = `${n.bank}:${n.program}`; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(n); }
        if (!pc.fighting) { for (const [key, ns] of groups) addTrack(accOf(other, key), ns, null); continue; }
        for (const [key, ns] of groups) addTrack(accOf(any, key), ns, src);
        const bank = median(w.map((n) => n.bank)), program = median(w.map((n) => n.program)), mainKey = `${bank}:${program}`;
        addTrack(accOf(main, mainKey), w, src);
        const role = bank === 0 ? ROLE_OF[program] : 'fx';
        if (role && roleAcc[role]) { addTrack(roleAcc[role].acc, w, src); roleAcc[role].programs.add(bank === 0 ? program : -1); }
      }
      for (const c of pc.copies) if (c.kind === 'echo') { const role = c.bank === 0 ? ROLE_OF[c.program] : 'fx'; if (role && roleAcc[role]) { roleAcc[role].delays.push(c.delay); roleAcc[role].levels.push(c.level); } }
      /* Capcom's break bars: every bar of break programming per kit, from the first beat on, in the intro and one pass of the loop (style/breaks.js) */
      if (pc.info.loopLength) for (const t of pc.tracks) {
        const bars = new Map();
        for (const n of t.window) {
          if (n.bank !== 0 || !breaks[n.program]) continue;
          const rel = n.t - pc.info.lead, bar = Math.floor(rel / BAR);
          if (rel < 0) continue;
          const key = `${n.program}:${bar}`;
          if (!bars.has(key)) bars.set(key, { program: n.program, bar, notes: [] });
          bars.get(key).notes.push({ t: rel - bar * BAR, n: n.n, len: n.len, v: Math.max(1, n.v * 2) });      // v as a project note: 1..127
          const st = breakStats[n.program][n.n] || (breakStats[n.program][n.n] = { steps: new Array(8).fill(0), off: 0 }), pos = rel % BAR;
          if (pos % 24 < 3 || pos % 24 > 21) st.steps[Math.round(pos / 24) % 8]++; else st.off++;
        }
        for (const b of bars.values()) {
          const kit = breaks[b.program], sig = b.notes.map((x) => `${x.t}:${x.n}:${x.len}`).join(' ');
          if (!kit.seen.has(sig)) { kit.seen.add(sig); kit.bars.push({ piece: pc.song.code, bpm: +pc.info.bpm.toFixed(1), bar: b.bar, notes: b.notes }); }
        }
      }
    }

    /* every program of every bank, in order */
    const programs = {};
    for (let bank = 0; bank < data.banks.length; bank++) for (const rom of data.banks[bank]) {
      if (!rom) continue;
      const key = `${bank}:${rom.program}`, u = use.get(key);
      const zones = rom.live.map((r, i) => {
        const s = data.samples[r.sample];
        return { keyLow: r.keyLow, keyHigh: r.keyHigh, sample: r.sample, root: s ? s.root : null, looped: s ? s.looped : false,
                 seconds: s ? +((s.end - s.start) / ROOT_RATE).toFixed(3) : 0, level: r.level, pan: r.pan === 255 ? null : r.pan, fine: r.fine,
                 envelope: { attack: r.envelope[0], decay: r.envelope[1], sustain: r.envelope[2], sustainRate: r.envelope[3], release: r.envelope[4] }, ringOut: r.flag === 1,
                 notes: u && u.zoneNotes.get(i) || 0, tuningCents: null, tuningConfidence: null };
      });
      /* tuning of every zone of the pitched programs of the music bank (kits are not pitched) */
      if (bank === 0 && !rom.kit) zones.forEach((z) => { const s = data.samples[z.sample], m = s && tuning(samples, s); if (m) { z.tuningCents = m.cents; z.tuningConfidence = m.confidence; } });
      let primary = 0;
      zones.forEach((z, i) => { if (z.notes > zones[primary].notes) primary = i; });
      const zone = zones[primary], played = u ? u.notes.length : 0;
      let range = null;
      if (played) {
        let low = 127, high = 0;
        for (const n of u.notes) { if (n < low) low = n; if (n > high) high = n; }
        range = { low, high, median: median(u.notes), typicalLow: quantile(u.notes, 0.02), typicalHigh: quantile(u.notes, 0.98) };
      }
      const naturalNote = u && u.rootRel.length ? median(u.rootRel) : null;
      /* tone: the sound of the zone Capcom plays most, at the note it plays it (unplayed: at its own root key) */
      const inZone = u ? u.notes.filter((n) => n >= zone.keyLow && n <= zone.keyHigh) : [];
      const sample = data.samples[zone.sample];
      const note = Math.max(zone.keyLow, Math.min(zone.keyHigh, inZone.length ? median(inZone) : zone.root !== null ? zone.root : 60));
      const t = sample ? tone(samples, sample, note) : { note, attackMs: 0, decayMs: null, seconds: 0, looped: false, centroidHz: 0, brightness: 0, peakDb: -120, rmsDb: -120 };
      t.sample = zone.sample;
      /* Capcom's usual levels: from the tracks whose program this is, else (nobody's usual program) from the tracks that play it at all,
       * else (only the short pieces play it) from their tracks */
      const m = main.get(key), a = any.get(key), o = other.get(key);
      const basis = m && m.tracks ? 'main' : a && a.tracks ? 'any' : o && o.tracks ? 'other' : null, s = basis === 'main' ? m : basis === 'any' ? a : basis === 'other' ? o : null;
      const med = (xs) => (s && xs.length ? median(xs) : null);
      const info = bank === 0 ? NAMES[rom.program] || [`Instrument ${rom.program}`, 'An instrument the catalog has no name for.'] : null;
      const loud = t.rmsDb > -12 ? 'loud' : t.rmsDb > -20 ? 'medium loud' : 'quiet';
      programs[key] = {
        bank, program: rom.program,
        name: info ? info[0] : `Effect ${bank} \u00B7 ${rom.program}`, sure: !!(info && info[2] === true),
        aliases: bank === 0 ? (ALIASES[rom.program] || []).slice() : [],
        nameKind: info && info[2] === true ? 'listening' : 'description',
        description: info ? info[1] : `A sound from the game, ${t.seconds} s long${rom.sustained ? ', repeating while a note is held' : ''}, ${loud}. It can be played as an instrument.`,
        family: bank === 0 ? FAMILY_OF[rom.program] || (rom.kit ? 'Drums' : 'Hits & chops') : 'Effects & voices', role: bank === 0 ? ROLE_OF[rom.program] || (rom.kit ? 'drums' : 'fx') : 'fx',
        kit: rom.kit, breakKit: bank === 0 && BREAK_KITS.includes(rom.program), sustained: rom.sustained, zones, range, naturalNote,
        usage: { pieces: u ? Array.from(u.pieces).sort((x, y) => x - y) : [], notes: played, tracks: s ? s.tracks : 0, basis, volume: med(s ? s.volume : []), expression: med(s ? s.expression : []),
                 velocity: med(s ? s.velocity : []), pan: med(s ? s.pan : []), noteLength: med(s ? s.length : []), echoed: s ? s.echoed : 0, doubled: s ? s.doubled : 0, glided: s ? s.glided : 0, glides: s ? s.glides : 0 },
        tuningCents: zone.tuningCents, tuningConfidence: zone.tuningConfidence, tone: t,
        keys: rom.kit ? kitKeys(samples, data, bank, rom, u ? u.keyUses : new Map(), bank === 0 ? breakStats[rom.program] : null) : null, tempo: null,
      };
      yield { stage: 'programs', done: ++programDone, total: programTotal };
    }

    /* break kits: the kit's own tempo (eight slices make a bar, so 60 / (2 x a slice)), and Capcom's bars */
    const outBreaks = {};
    for (const k of BREAK_KITS) {
      const p = programs[`0:${k}`], rom = data.banks[0][k];
      let tempo = 0;
      if (p && p.keys) { const lens = p.keys.filter((x) => x.key >= 41 && x.key <= 48).map((x) => x.seconds); tempo = lens.length ? round(60 / (2 * median(lens)), 1) : 0; }
      else if (rom) {                                              // beat-long pieces (Ryu): the piece on key 72 is one beat
        const r = rom.live.find((x) => x.keyHigh >= 72), s = r && data.samples[r.sample];
        if (s) tempo = round(60 / slice(samples, s, ROOT_RATE * Math.pow(2, (72 - s.root) / 12)).seconds, 1);
      }
      if (p) p.tempo = tempo;
      outBreaks[k] = { tempo, bars: breaks[k].bars };
    }

    /* Capcom's medians per role */
    const roles = {};
    for (const r of ROLES) {
      const x = roleAcc[r], med = (xs) => (xs.length ? median(xs) : 0);
      roles[r] = { volume: med(x.acc.volume), expression: med(x.acc.expression), velocity: Math.max(1, med(x.acc.velocity)), pan: med(x.acc.pan),
                   echo: x.delays.length >= 3 ? { delay: median(x.delays), level: round(median(x.levels), 2) } : null,
                   tracks: x.acc.tracks, programs: Array.from(x.programs).filter((p) => p >= 0).sort((p, q) => p - q) };
    }
    return { version: VERSION, programs, breaks: outBreaks, roles, families: FAMILIES.slice(), study };
  }

  /* ---- suggest(): a starting instrument and Capcom's levels for a part's role (static: no engine needed) --------- */
  /* Capcom's levels per role, as the arranger uses them (style/arrange3s.js ROLE: medians of the game's own tracks).
   * v is the driver's velocity 0..63; suggest() returns it doubled, on the project's 1..127 scale. */
  const LEVELS = {
    break: { vol: 85, expr: 85, v: 60, pan: 127 },
    kick:  { vol: 75, expr: 72, v: 55, pan: 64 },
    perc:  { vol: 70, expr: 70, v: 40, pan: 112 },
    bass:  { vol: 75, expr: 64, v: 50, pan: 64 },
    lead:  { vol: 56, expr: 52, v: 44, pan: 24, echo: { delay: 24, level: 0.5 } },
    pad:   { vol: 64, expr: 64, v: 40, pan: 108, echo: { delay: 16, level: 0.55 } },
    chords: { vol: 80, expr: 64, v: 38, pan: 64, echo: { delay: 20, level: 0.5 } },
    arp:   { vol: 72, expr: 72, v: 40, pan: 40, echo: { delay: 24, level: 0.5 } },
    fx:    { vol: 75, expr: 75, v: 45, pan: 64, echo: { delay: 24, level: 0.5 } },
  };
  /* instrument per role, steered by the MIDI part's GM program (-1 = none given): style/arrange3s.js pickProgram, where the
   * choices were judged by ear (slap bass 19, strings 46, sax lead 57 not 42, harpsichord 58) */
  function pickProgram(role, gm) {
    const in_ = (a, b) => gm >= a && gm <= b;
    if (role === 'bass') return in_(36, 37) ? 19 : in_(38, 39) ? 18 : 20;
    if (role === 'pad') return in_(88, 95) ? 57 : in_(16, 23) ? 22 : in_(0, 7) ? 39 : 46;
    if (role === 'chords') return in_(0, 3) || gm === 6 ? 58 : in_(4, 5) || gm === 7 || in_(8, 15) ? 60 : in_(16, 31) ? 22 : in_(40, 55) ? 46 : in_(56, 63) ? 37 : in_(88, 95) ? 39 : 37;
    if (role === 'lead') return in_(64, 67) ? 57 : in_(68, 79) || in_(52, 54) ? 42 : in_(56, 63) ? 43 : in_(80, 87) || in_(24, 31) ? 44 : in_(0, 7) ? 58 : in_(40, 51) ? 46 : 43;
    if (role === 'arp') return in_(4, 15) ? 60 : 58;
    return 43;
  }
  /* role: drums | perc | bass | chords | pad | lead | arp | fx (missing: lead). gm: the General MIDI program of the part, or -1.
   * drums: kit 1 at Capcom's break levels; an electronic GM kit (24-31) gets kit 6, which follows GM keys, at the kick levels.
   * perc: kit 6. fx: the chop set Capcom uses in the most pieces (program 24). */
  function suggest(role, gm) {
    gm = Number.isInteger(gm) && gm >= 0 && gm < 128 ? gm : -1;
    if (role === undefined || role === null) role = 'lead';
    if (ROLES.indexOf(role) < 0) throw new Error(`unknown role "${role}"`);
    let program, L;
    if (role === 'drums') { if (gm >= 24 && gm <= 31) { program = 6; L = LEVELS.kick; } else { program = 1; L = LEVELS.break; } }
    else if (role === 'perc') { program = 6; L = LEVELS.perc; }
    else if (role === 'fx') { program = 24; L = LEVELS.fx; }
    else { program = pickProgram(role, gm); L = LEVELS[role]; }
    return { bank: 0, program, volume: L.vol, expression: L.expr, velocity: L.v * 2, pan: L.pan, echo: L.echo ? { delay: L.echo.delay, level: L.echo.level } : null };
  }

  /* the name to show: the user's own name for it (project.names, keyed 'bank:program') wins, then ours */
  function nameOf(catalog, bank, program, names) {
    const key = `${bank}:${program}`;
    if (names && typeof names[key] === 'string' && names[key].trim()) return names[key];
    const p = catalog && catalog.programs[key];
    return p ? p.name : program == null ? 'Instrument chosen during the song' : `Instrument ${program}`;
  }

  const api = { VERSION, build, buildAsync, suggest, nameOf, NAMES, FAMILIES, ROLES, BREAK_KITS, EFFECT_BANKS, FAMILY_OF, ROLE_OF, walk, analysePiece, slice, tone, tuning, ROOT_RATE };
  g.SF3Catalog = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
