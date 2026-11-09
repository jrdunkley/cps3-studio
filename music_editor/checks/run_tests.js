/* The Studio's test suite: every test that needs nothing but your own ROM zips (docs/TESTING.md).
 *
 *   node checks/run_tests.js --roms <folder>       the folder that holds your sfiii3nr1.zip and sfiii3.zip
 *   node checks/run_tests.js --quick               shorter audio comparisons in G3 and G4
 *   node checks/run_tests.js --only G4,G13         only these tests
 *   node checks/run_tests.js --no-browser          skip G12 (it needs Chrome, Chromium or Edge; or set STUDIO_BROWSER)
 *
 * CPS3_ROMS may name the ROM folder instead of --roms. When data/pack.js does not exist yet it is made from the zips
 * first (node cli/studio.js rom import). Each test's own exit code decides: 0 pass, anything else fail. Full output
 * goes to out/tests/logs/<id>.log. Exit 0 only when nothing failed.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const LOGS = path.join(ROOT, 'out', 'tests', 'logs');
const args = process.argv.slice(2);
const value = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const has = (name) => args.includes(name);
if (has('--help') || has('-h')) { console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^\/\* ?/, '').replace(/^ \* ?/gm, '')); process.exit(0); }
const roms = value('--roms') || process.env.CPS3_ROMS;
if (roms) process.env.CPS3_ROMS = path.resolve(roms);
const quick = has('--quick'), noBrowser = has('--no-browser');
const only = new Set((value('--only') || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean));

/* id, what it proves, runs (each [script, ...arguments]), takes --quick, needs a browser */
const TESTS = [
  ['G1', 'the driver facts, measured in the running driver', [['checks/command_check.js']]],
  ['G3', 'version-1 songs build as before; upgraded and compressed they sound identical', [['checks/gates/g_v1_upgrade.js']], true],
  ['G4', "all 49 of Capcom's pieces open as projects and rebuild sound-identical", [['checks/gates/g_capcom.js']], true],
  ['G4C', "G4's yardstick: Capcom's own bytes played from the preview slot sound identical", [['checks/gates/g4_control.js']]],
  ['G5', 'loop compression keeps every event and every wait', [['checks/gates/g_compress.js']]],
  ['G6', 'devices, track allocation, ranges, chorus entries, song files', [['checks/gates/g_devices.js']]],
  ['G8', 'text scores round-trip projects; malformed scores are refused', [['checks/gates/g_score.js']]],
  ['G11', 'mix measurements, percentiles, harmony and Game Check', [['checks/gates/g_analyze.js']]],
  ['G12', "both pages' own self-tests in a hidden browser", [['checks/studio_browser.js', 'index.html#selftest'], ['checks/studio_browser.js', 'classic.html#selftest']], false, true],
  ['G13', 'every command-line command, its JSON, errors and output files; the ROM installer from your zips', [['checks/gates/g_cli.js']]],
  ['G14', 'styles come only from the kit; every action is described', [['checks/gates/g_style.js']]],
  ['G15', 'the instrument catalog, measured against the originals', [['checks/gates/g_catalog.js']]],
  ['G16', 'MIDI in and out', [['checks/gates/g_midi.js']]],
];

function ensurePack() {
  const pack = path.join(ROOT, 'data', 'pack.js');
  if (fs.existsSync(pack)) return true;
  const zips = roms ? ['sfiii3nr1.zip', 'sfiii3.zip'].map((z) => path.join(process.env.CPS3_ROMS, z)) : [];
  if (!zips.length || !zips.every((z) => fs.existsSync(z))) {
    console.log('The tests need the sound data from your own ROM. Give the folder that holds sfiii3nr1.zip and sfiii3.zip:\n'
      + '  node checks/run_tests.js --roms <folder>\n(or make data/pack.js once: node cli/studio.js rom import sfiii3nr1.zip sfiii3.zip)');
    return false;
  }
  console.log('Making data/pack.js from your ROM zips (private: git ignores it)...');
  const r = cp.spawnSync(process.execPath, [path.join(ROOT, 'cli', 'studio.js'), 'rom', 'import', ...zips], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) { console.log(r.stderr || r.stdout); return false; }
  return fs.existsSync(pack);
}

function main() {
  if (!ensurePack()) process.exit(2);
  fs.mkdirSync(LOGS, { recursive: true });
  let failed = 0, skipped = 0;
  for (const [id, what, runs, takesQuick, browser] of TESTS) {
    if (only.size && !only.has(id)) continue;
    if (browser && noBrowser) { skipped++; console.log(`${id.padEnd(4)} SKIPPED  ${what}`); continue; }
    const started = Date.now(), log = [];
    let ok = true, last = '';
    for (const [script, ...rest] of runs) {
      const argv = [path.join(ROOT, script), ...rest, ...(quick && takesQuick ? ['--quick'] : [])];
      const r = cp.spawnSync(process.execPath, argv, { cwd: ROOT, encoding: 'utf8', windowsHide: true, maxBuffer: 1 << 28, timeout: 45 * 60 * 1000 });
      log.push(`$ node ${[script, ...argv.slice(1)].join(' ')}\n${r.stdout || ''}\n${r.stderr || ''}\n[exit ${r.status}${r.error ? ' ' + r.error.message : ''}]\n`);
      const lines = `${r.stdout || ''}\n${r.stderr || ''}`.split(/\r?\n/).filter((l) => l.trim());
      last = lines.length ? lines[lines.length - 1] : '(no output)';
      if (r.status !== 0) { ok = false; break; }
    }
    fs.writeFileSync(path.join(LOGS, `${id}.log`), log.join('\n'));
    if (!ok) failed++;
    console.log(`${id.padEnd(4)} ${ok ? 'PASS   ' : 'FAIL   '}  ${what}  [${Math.round((Date.now() - started) / 1000)} s]\n       ${last.slice(0, 200)}`);
  }
  console.log(`\n${failed} failed${skipped ? `, ${skipped} skipped` : ''}. Logs: ${LOGS}`);
  process.exit(failed ? 1 : 0);
}

main();
