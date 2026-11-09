# Files the Studio uses

The Studio saves ordinary local files. Keep editable source alongside delivered audio and song files. The exact schema and score grammar are in [plan/04_FORMATS.md](plan/04_FORMATS.md); this guide explains what to choose.

| File | Use |
|---|---|
| `.sf3project.json` | Editable song, devices, automation, instrument definitions and editor state |
| `.sf3score` | The same musical project as readable text, suitable for agents and version control |
| `.sf3song.json` | ROM delivery: plain sequence, optional proven compression, project and installation requirements |
| `.mid` / `.midi` | Exchange notes, programs, controls, tempo maps and bends with other tools |
| `.wav` | Listen elsewhere; PCM audio from the actual sound driver |
| `.bin` / `.listing.txt` | Raw sequence and readable commands for ROM developers |
| `edits.json` / `report.json` | Checked ROM replacements and their placement/space report |

## Projects

New projects use `format: "sf3project", version: 2`. A song has a name, starting `bpm`, `tempoChanges`, `bars`, loop, phrase markers, sections, optional `chorusBar`, parts, optional custom `bank`, instrument `names` and `ui`. Version-1 flat projects and classic wrapper files are upgraded on opening.

Time is in ticks: 48 per beat and 192 per bar. Notes use `{t,n,len,v}`: start tick, MIDI pitch, duration and velocity 1–127. Optional tie, glide, tuning, bend and per-note controls retain driver behavior. `loop.start` is inclusive and `loop.end` exclusive, in ticks; user-facing `startBar`/`endBar` are one-based and inclusive. The normal two-tick lead-in lets controls run before the first note. `ui` is ignored by the compiler.

Parts have stable IDs, names, roles, bank/program, volume, expression, pan, gain, transpose, tuning, voices, mute/solo, notes, automation, devices and raw commands. Volume/expression/pan use 0–127. Some decompiled parts intentionally use null controls, meaning the driver retains its own state. Preserve them when studying an original. A pinned `track` is zero-based; ordinary songs can leave allocation automatic.

Automation is a sorted list of `{t,v}` points per lane. Values hold until the next point. `post` applies after a simultaneous note; `pre` preserves ordering around loop boundaries. Devices derive notes or controls without destroying source notes. Echo, Double and Harmony allocate extra voices; others transform timing, pitch or levels. Unknown/raw commands must survive round trips.

## Song files

`sequence_b64` always contains the plain compatible sequence. `bytes`, `tracks`, `loop_ticks` and `marker_bars` describe it. The editable `project` travels with it. Version 2 may add `compressed: {sequence_b64,bytes,chorus_safe}`, `chorus_bar`, `layers`, custom `bank`, `needs`, `checks` and `studio`.

Compression is included only after sample-identical stereo comparison with the plain sequence. A consumer can keep using the plain sequence. `needs` states whether installation requires just a song, a chorus entry or instrument data too. A compressed chorus entry must be built with loop-aware tooling; it cannot jump inside a counted loop. See [ROM_GUIDE.md](ROM_GUIDE.md).

## Scores and MIDI

Scores start with `cps3 score 1`; header fields precede named parts and bar lines. Durations, velocities, repeats, chord notation, automation and devices are readable. `json` lines preserve details that cannot be expressed concisely. Parser errors identify their location. Three complete examples are in [AGENT_GUIDE.md](AGENT_GUIDE.md).

MIDI import quantizes to the 48-tick grid and preserves supported tempo, instrument, mixer, bend and slur information. MIDI is an interchange format; keep a project or score as the authoritative editable copy when using Studio-specific devices or custom instruments.

## Custom banks, packs and patches

A custom bank has version 1, slot 8, sample `views` and numbered `instruments` with key zones. A view identifies start, loop, end and root key in existing ROM sample data. Zones assign views or original samples, tuning and envelope settings. No new recordings are embedded. The installer allocates this data in the music space and changes bank 8's pointer. All songs in one image must agree on shared instrument numbers.

Packs are private ROM-derived data. Version 1 carries base64 program regions and samples; version 2 can carry byte arrays plus game addresses, provenance and a program hash. They are not distributed with source packages. The browser stores imported data locally; `data/pack.js` (made by `node cli/studio.js rom import`) serves the classic editor, the command line and the tests.

The generic installer returns a copy of the patched program, `{edits:[...]}` and a report. Each edit records owner, address, expected bytes, replacement bytes and rationale. Check every preimage before applying any edit. Request pointers and optional bank pointer are the only documented writes outside the allocated music space. Program SIMMs are encrypted output files for a developer's own ROM pipeline. No installer output is applied to the user's running game automatically.
