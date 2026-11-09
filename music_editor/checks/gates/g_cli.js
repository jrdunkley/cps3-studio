/* G13 exercises every CLI command through its public process interface and inspects real outputs. */
'use strict';
const fs = require('fs'), path = require('path'), cp = require('child_process'), G = require('./lib.js'), C = require('../../js/compile.js'), Midi = require('../../js/midi.js');
const gate = G.gate('G13 CLI'), check = gate.check, cli = path.join(G.root, 'cli/studio.js'), out = path.resolve(G.root, 'out/tests/G13');
if (!fs.existsSync(cli)) { console.log('NOT BUILT YET: cli/studio.js'); process.exit(2); }
fs.mkdirSync(out, { recursive: true }); const file = n => path.join(out, n);
const project = C.normalize({ format: 'sf3project', version: 2, name: 'CLI fixture', bpm: 132, bars: 2, markerBars: 1, chorusBar: 2, parts: [{ id: 'bass', name: 'Bass', bank: 0, program: 20, role: 'bass', notes: [{ t: 0, n: 48, len: 48, v: 80 }, { t: 192, n: 55, len: 48, v: 88 }] }] });
fs.writeFileSync(file('fixture.sf3project.json'), JSON.stringify(project)); fs.writeFileSync(file('fixture.mid'), Midi.fromProject(project));
function run(args, status = 0) { const r = cp.spawnSync(process.execPath, [cli, ...args, '--json'], { cwd: G.root, encoding: 'utf8', windowsHide: true, timeout: 240000, maxBuffer: 16 * 1024 * 1024 }); check(r.status === status, args.join(' ') + ': status ' + r.status + ', ' + r.stderr); if (status) { check(r.stderr.trim().split(/\r?\n/).length === 1 && !r.stdout.trim(), 'error is one stderr line with no stdout'); return null; } try { const data = JSON.parse(r.stdout); check(data && !Array.isArray(data) && data.command, args[0] + ': one JSON object identifies its command'); return data; } catch (_) { check(false, 'invalid JSON: ' + r.stdout.slice(0, 160)); return {}; } }
const input = file('fixture.sf3project.json');
for (const command of ['info', 'instruments', 'pieces', 'piece', 'new', 'midi', 'arrange', 'convert', 'build', 'check', 'analyze', 'render', 'options', 'brief', 'listing', 'rom']) check(run([command, '--help']).example, command + ' help includes an example');
const info = run(['info']); check(info.pieces === 49 && info.samples === 733 && info.musicSpace.total === 188384, 'info matches ROM facts');
check(run(['pieces']).pieces.length === 49, 'pieces lists every piece');
check(run(['instruments', '--family', 'Bass']).instruments.every(i => i.family === 'Bass'), 'catalog family filter');
run(['new', '--out', file('empty.json')]); check(JSON.parse(fs.readFileSync(file('empty.json'))).parts.length === 0, 'new creates an empty project');
run(['new', '--like', '16', '--out', file('template.json')]); check(JSON.parse(fs.readFileSync(file('template.json'))).parts.every(p => !p.notes.length && p.track == null), 'CLI template clears notes and track pins');
for (const [flag, name] of [['project', 'piece.json'], ['score', 'piece.sf3score'], ['midi', 'piece.mid'], ['wav', 'piece.wav']]) run(['piece', '16', '--' + flag, file(name), '--loops', '1', '--fade', '0']);
check(run(['piece', '16', '--listing']).listing.includes('track 16'), 'original listing includes its tracks');
run(['midi', file('fixture.mid'), '--out', file('midi.json')]);
run(['convert', input, '--out', file('round.sf3score')]); run(['convert', file('round.sf3score'), '--out', file('round.json')]);
check(Buffer.from(C.build(JSON.parse(fs.readFileSync(file('round.json')))).bytes).equals(Buffer.from(C.build(project).bytes)), 'score conversion preserves sequence bytes');
run(['convert', input, '--out', file('round.mid')]); check(Midi.parse(fs.readFileSync(file('round.mid'))).parts.length > 0, 'convert emits readable MIDI');
const build = run(['build', input, '--out', file('song.sf3song.json'), '--bin', file('song.bin'), '--listing', file('song.txt')]);
const song = JSON.parse(fs.readFileSync(file('song.sf3song.json'))); check(song.checks.compressed_sound_identical && song.compressed.bytes <= song.bytes && build.tracks === 1, 'build proves compression and reports tracks');
run(['build', input, '--plain', '--out', file('plain.sf3song.json')]); check(!JSON.parse(fs.readFileSync(file('plain.sf3song.json'))).compressed, 'plain keeps only the compatible sequence');
check(Array.isArray(run(['check', input]).issues), 'check reports issues');
const bad = JSON.parse(JSON.stringify(project)); bad.parts = Array.from({ length: 17 }, (_, i) => ({ ...bad.parts[0], id: 'p' + i })); fs.writeFileSync(file('bad.json'), JSON.stringify(bad));
const fault = cp.spawnSync(process.execPath, [cli, 'check', file('bad.json'), '--json'], { encoding: 'utf8', windowsHide: true }); check(fault.status === 1 && JSON.parse(fault.stdout).issues.some(i => i.code === 'tracks.over'), 'check exits 1 and returns structured error issues');
const analysis = run(['analyze', input, '--reference', '16', '--seconds', '3']); check(analysis.metrics && analysis.harmony.bars.length === 2 && analysis.reference.metrics && analysis.load.peak > 0, 'analysis includes sound, harmony, reference and driver load');
run(['render', input, '--wav', file('render.wav'), '--rate', '44100', '--loops', '1', '--fade', '0', '--stereo', '--stems', file('stems'), '--bars', '1-1', '--solo', 'Bass']); const wav = fs.readFileSync(file('render.wav')); check(wav.toString('ascii', 0, 4) === 'RIFF' && wav.readUInt32LE(24) === 44100 && fs.readdirSync(file('stems')).some(n => n.endsWith('.wav')), 'render writes requested rate and stems');
const looped = run(['render', input, '--wav', file('exact.wav'), '--exact-loop', '--stems', file('exact-stems')]); const exact = fs.readFileSync(looped.wav), exactStem = fs.readFileSync(looped.stems[0]); check(exact.readUInt32LE(40) === exactStem.readUInt32LE(40), 'exact-loop stems and mix have equal sample counts');
run(['render', '--piece', '5', '--wav', file('reference.wav'), '--fade', '0']);
run(['render', input, '--wav', file('muted.wav'), '--mute', 'Bass', '--loops', '1', '--fade', '0']); check(fs.readFileSync(file('muted.wav')).subarray(44).every(v => v === 0), 'render mute silences the selected part');
const opts = run(['options', input, '--part', 'Bass', '--programs', '20,21', '--bars', '1-1', '--out', file('options')]); check(opts.options.length === 2 && opts.options.every(o => fs.existsSync(o.wav) && Number.isFinite(o.gainDb)), 'options writes measured level-matched alternatives');
check(run(['brief', input]).brief.includes('Bass'), 'brief describes the part'); check(run(['listing', input, '--track', '1']).listing.includes('track:'), 'listing filters a driver track');
const arrangement = JSON.parse(JSON.stringify(project)); arrangement.parts[0].notes = Array.from({ length: 16 }, (_, i) => ({ t: i * 24, n: 48 + i % 4, len: 20, v: 80 })); fs.writeFileSync(file('arrange.mid'), Midi.fromProject(arrangement));
run(['arrange', file('fixture.mid'), '--out', file('too-short')], 1);
run(['arrange', file('arrange.mid'), '--out', file('arranged')]); check(fs.existsSync(file('arranged')) && fs.readdirSync(file('arranged')).some(n => n.endsWith('.sf3project.json')), 'existing arranger writes only the requested output folder');
const roms = process.env.CPS3_ROMS ? path.resolve(process.env.CPS3_ROMS) : path.join(G.root, 'roms'), nr = path.join(roms, 'sfiii3nr1.zip'), parent = path.join(roms, 'sfiii3.zip');
if (![nr, parent].every(p => fs.existsSync(p))) { check(false, `the rom commands need your sfiii3nr1.zip and sfiii3.zip in ${roms} (set CPS3_ROMS to their folder)`); gate.done('stopped before the rom commands'); }
const stamps = [nr, parent].map(p => [p, fs.statSync(p).size, fs.statSync(p).mtimeMs]);
run(['rom', 'import', nr, parent, '--out', file('pack.js')]); check(fs.readFileSync(file('pack.js'), 'utf8').includes('SF3_PACK'), 'import writes a browser/Node pack');
check(run(['rom', 'space', nr, parent]).space.free === 188384, 'ROM space measures the stock image');
const installed = run(['rom', 'install', '--rom', nr, '--rom', parent, '--song', file('song.sf3song.json'), '--code', '50', '--chorus-code', '51', '--out', file('patch')]); check(installed.report.free < 188384 && fs.statSync(file('patch/program.bin')).size === 0x1000000 && JSON.parse(fs.readFileSync(file('patch/edits.json'))).edits.length > 0, 'installer emits report, exact edits and full image');
check(stamps.every(([p, size, time]) => fs.statSync(p).size === size && fs.statSync(p).mtimeMs === time), 'input ROM zips remain unchanged');
for (const args of [['unknown'], ['piece', '9999'], ['build', file('missing.json')], ['render', input, '--bars', '5-1'], ['rom', 'install', '--song', input, '--code', '1']]) run(args, 1);
fs.writeFileSync(file('malformed.sf3score'), 'song ???'); run(['convert', file('malformed.sf3score'), '--out', file('invalid.json')], 1);
for (const name of ['AGENT_GUIDE.md', 'COMPOSING.md']) { const text = fs.readFileSync(path.join(G.root, 'docs', name), 'utf8'); for (const match of text.matchAll(/```text\n(cps3 score 1[\s\S]*?)```/g)) { try { const project = require('../../js/score.js').parse(match[1]), built = C.build(project); check(built.bytes.length > 0 && built.report.tracks.length <= 16, name + ': complete score example builds'); } catch (e) { check(false, name + ': ' + e.message); } } }
gate.done('all commands, outputs, JSON, errors and read-only ROM inputs');
