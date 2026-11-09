/* What changes or locks a part's sound beyond its own settings, read the way the compiler reads it (js/compile.js
 * want()): a lane overrides the part's own setting from its first point (from the start when that point is at or
 * before the first note); pitch, detune, fine and glide lanes add to the part's tuning; a note's own sound, level or
 * pan applies to that note unless a lane sets it; raw driver commands play as Capcom wrote them; tracks 13-16 are
 * borrowed by the game's sound effects in a fight; the loop and the chorus entry change what plays next.
 * One reading for the lane strip (markers and the header badge), the inspector and the mixer (a note beside every
 * control a lane overrides), so the same words appear wherever the effect is felt. */
(function (g) {
  'use strict';
  const S = g.Studio;
  const BAR = 192, BEAT = 48;
  /* every lane the game has: what it is called here, what it does, and the part control it overrides */
  const LANES = {
    program: { label: 'Instrument', kind: 'sound', control: 'program', range: [0, 127] },
    gain: { label: 'Gain', kind: 'sound', control: 'gain', range: [-64, 63] },
    volume: { label: 'Volume', kind: 'level', control: 'volume', range: [0, 127] },
    expression: { label: 'Level', kind: 'level', control: 'expression', range: [0, 127] },
    pan: { label: 'Pan', kind: 'level', control: 'pan', range: [0, 127] },
    vibDepth: { label: 'Vibrato', kind: 'lfo', control: 'vibDepth', range: [0, 127] },
    vibRate: { label: 'Vibrato speed', kind: 'lfo', control: 'vibRate', range: [0, 127] },
    vibSync: { label: 'Vibrato restart', kind: 'lfo', control: 'vibSync', range: [0, 1] },
    tremolo: { label: 'Tremolo', kind: 'lfo', control: 'tremolo', range: [0, 127] },
    pitch: { label: 'Pitch', kind: 'pitch', adds: true, range: [-100, 100] },
    detune: { label: 'Detune', kind: 'pitch', adds: true, range: [-128, 127] },
    fine: { label: 'Fine tune', kind: 'pitch', adds: true, range: [0, 127] },
    slide: { label: 'Glide', kind: 'pitch', range: [0, 127] }
  };
  /* the part controls a lane can make do nothing, as the inspector and the mixer name them */
  const CONTROLS = { program: 'instrument', gain: 'Gain', volume: 'Volume', expression: 'Expression', pan: 'Pan', vibDepth: 'Vibrato depth',
                     vibRate: 'Vibrato speed', vibSync: 'Restart vibrato', tremolo: 'Tremolo' };
  const NOTE_KEYS = { program: 'own sound', volume: 'own volume', expression: 'own level', pan: 'own pan' };
  const where = t => { const bar = Math.floor(t / BAR) + 1, beat = Math.floor((t % BAR) / BEAT) + 1; return beat === 1 ? 'bar ' + bar : 'bar ' + bar + ' beat ' + beat; };
  const instrument = (bank, program) => { try { return g.SF3Catalog && S.state.catalog ? SF3Catalog.nameOf(S.state.catalog, bank, program) : 'program ' + program; } catch (_) { return 'program ' + program; } };
  function valueText(name, pt, part) {
    if (name === 'program') return pt.v == null ? 'instrument set ' + pt.bank : '“' + instrument(pt.bank ?? part.bank ?? 0, pt.v) + '”';
    if (name === 'gain') return (pt.v > 0 ? '+' : '') + pt.v + (pt.v <= -64 ? ' (silent)' : pt.v === 0 ? ' (unity)' : '');
    if (name === 'pitch') return (pt.v > 0 ? '+' : '') + pt.v + ' cents';
    if (name === 'vibSync') return pt.v ? 'on' : 'off';
    if (name === 'pan') return pt.v === 64 ? 'centre' : pt.v < 64 ? (64 - pt.v) + ' left' : (pt.v - 64) + ' right';
    return String(pt.v);
  }
  function lanesOf(part) {
    const firstNote = part.notes.length ? Math.min(...part.notes.map(n => n.t)) : null, out = [];
    for (const [name, points] of Object.entries(part.automation || {})) {
      const info = LANES[name]; if (!info || !points || !points.length) continue;
      const first = Math.min(...points.map(p => p.t)), whole = firstNote === null || first <= firstNote;
      out.push({ name, ...info, count: points.length, first, whole, points });
    }
    const order = Object.keys(LANES); return out.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
  }
  /* the plain-words note beside a part control, or null when nothing overrides it */
  function note(part, control) {
    const lane = lanesOf(part).find(l => l.control === control), own = NOTE_KEYS[control] ? part.notes.filter(n => n[control === 'program' ? 'program' : control] != null).length : 0;
    const label = control === 'program' ? 'instrument' : (CONTROLS[control] || control).toLowerCase();
    if (lane) {
      const n = lane.count + (lane.count === 1 ? ' point' : ' points');
      return { lane: lane.name, level: lane.whole ? 'ignored' : 'partly',
        text: lane.whole ? `Not heard: the ${lane.label} lane sets the ${label} from the start (${n}), so this ${control === 'program' ? 'choice' : 'control'} does nothing.`
          : `Heard until ${where(lane.first)}; from there the ${lane.label} lane sets the ${label} (${n}).` };
    }
    if (own) return { lane: null, level: 'notes', text: `${own} note${own === 1 ? '' : 's'} set ${own === 1 ? 'its' : 'their'} ${NOTE_KEYS[control]}; this sets the others.` };
    return null;
  }
  /* markers for the lane strip: every point that changes the sound, raw commands, the loop and the chorus entry */
  function events(part, project) {
    const out = [];
    for (const lane of lanesOf(part)) {
      if (lane.kind === 'level' && lane.points.length > 24) { out.push({ t: lane.first, lane: lane.name, kind: lane.kind, label: lane.label, text: `${lane.label} lane: ${lane.count} points from ${where(lane.first)}.` }); continue; }
      let prev;
      for (const pt of lane.points) {
        if (prev && prev.v === pt.v && prev.bank === pt.bank) continue; prev = pt;
        const what = lane.control ? ` The part’s ${lane.name === 'program' ? 'instrument' : CONTROLS[lane.control].toLowerCase()} is not heard from here.` : lane.adds ? ' It adds to the part’s tuning.' : '';
        out.push({ t: pt.t, lane: lane.name, kind: lane.kind, label: lane.label, text: `${where(pt.t)} · ${lane.label} → ${valueText(lane.name, pt, part)}.${what}` });
      }
    }
    for (const r of part.raw || []) {
      const c = g.SF3Seq && SF3Seq.COMMANDS[r.op];
      if (r.op === 0xC0) continue;                                             // the driver's no-op: holds a tick, changes nothing
      out.push({ t: r.t, lane: null, kind: 'raw', label: 'Driver command', text: `${where(r.t)} · driver command ${r.op.toString(16).toUpperCase()}${c ? ' (' + c.name + ')' : ''}${r.a && r.a.length ? ' ' + r.a.join(' ') : ''}: played as Capcom wrote it.${c && c.text ? ' ' + c.text : ''}` });
    }
    if (project && project.loop && project.loop.on) {
      out.push({ t: project.loop.start, lane: null, kind: 'loop', label: 'Loop start', text: `${where(project.loop.start)} · the loop starts here: after the loop end the song comes back to this point.` });
      out.push({ t: project.loop.end, lane: null, kind: 'loop', label: 'Loop end', text: `${where(project.loop.end)} · the loop ends here and the song returns to ${where(project.loop.start)}.` });
    }
    if (project && project.chorusBar) out.push({ t: (project.chorusBar - 1) * BAR, lane: null, kind: 'loop', label: 'Chorus entry', text: `${where((project.chorusBar - 1) * BAR)} · rounds 2 and later start here (chorus entry), with the settings in force at this bar.` });
    return out.sort((a, b) => a.t - b.t);
  }
  /* the lane header badge: what in this part changes or locks its sound */
  function summary(part, project) {
    const lanes = lanesOf(part), raw = (part.raw || []).filter(r => r.op !== 0xC0).length, borrowed = part.track != null && part.track >= 12;
    const locks = lanes.filter(l => l.control && l.whole), alters = lanes.filter(l => !(l.control && l.whole));
    const items = lanes.map(l => ({ lane: l.name, label: l.label, count: l.count, kind: l.kind,
      short: l.control ? (l.whole ? 'the part’s ' + (l.name === 'program' ? 'instrument' : CONTROLS[l.control].toLowerCase()) + ' does nothing' : 'takes over at ' + where(l.first)) : l.adds ? 'adds to the tuning' : 'glides between notes',
      text: l.control ? (l.whole ? `${l.label} lane (${l.count}): sets the part’s ${l.name === 'program' ? 'instrument' : CONTROLS[l.control].toLowerCase()} from the start; that control does nothing.` : `${l.label} lane (${l.count}): takes over the part’s ${l.name === 'program' ? 'instrument' : CONTROLS[l.control].toLowerCase()} at ${where(l.first)}.`)
        : `${l.label} lane (${l.count}): ${l.adds ? 'adds to the part’s tuning' : 'glides between notes'} from ${where(l.first)}.` }));
    if (raw) items.push({ lane: null, label: 'Driver commands', count: raw, kind: 'raw', short: 'played as Capcom wrote them', text: `${raw} driver command${raw === 1 ? '' : 's'} kept exactly as Capcom wrote ${raw === 1 ? 'it' : 'them'} (markers on the strip say what each does).` });
    if (borrowed) items.push({ lane: null, label: 'Track ' + (part.track + 1), count: 0, kind: 'sound', short: 'fight sound effects borrow it', text: `This part plays on track ${part.track + 1}. In a fight the game’s sound effects borrow tracks 13 to 16, so hits and voices cut into it.` });
    return { items, locks: locks.length, count: lanes.length + (raw ? 1 : 0) + (borrowed ? 1 : 0), lanes };
  }
  S.automation = { LANES, CONTROLS, lanesOf, note, events, summary, where };
})(window);
