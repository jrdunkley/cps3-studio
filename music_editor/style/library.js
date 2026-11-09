/* The list of arrangements the editor offers under "My song" (node style/library.js).
 * A page opened from disk cannot list folders, so this writes data/library.js: every project in
 * out/style_out (made by style/arrange3s.js) and in songs/ (approved songs), with the
 * arranger's report. arrange3s.js runs it after each arrangement; reload the page to see new ones.
 * data/ stays private like the rest of the data folder.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const FOLDERS = [
  { folder: 'Approved songs', dir: path.join(root, 'songs') },
  { folder: 'Arrangements', dir: path.join(root, 'out', 'style_out') },
];

function write() {
  const items = [];
  for (const { folder, dir } of FOLDERS) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sf3project.json')).sort()) {
      const file = path.join(dir, f);
      let j;
      try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { continue; }
      if (!j.project) continue;
      const report = file.replace('.sf3project.json', '.report.txt'), song = file.replace('.sf3project.json', '.sf3song.json');
      let sequence = null;                             // the song file's bytes: the page's self-test rebuilds the project and compares
      try { sequence = JSON.parse(fs.readFileSync(song, 'utf8')).sequence_b64; } catch (e) { /* no song file */ }
      items.push({ folder, file: f, name: j.project.name, made: fs.statSync(file).mtime.toISOString().slice(0, 16).replace('T', ' '),
                   bars: j.project.bars, bpm: j.project.bpm, tracks: j.project.parts.length, names: j.names || {},
                   report: fs.existsSync(report) ? fs.readFileSync(report, 'utf8') : '', sequence, project: j.project });
    }
  }
  const out = path.join(root, 'data', 'library.js');
  fs.writeFileSync(out, '/* Made by style/library.js: arrangements for the editor\'s list. Private like the rest of data/. */\n' +
    `(function (g) { g.SF3_LIBRARY = ${JSON.stringify(items)}; })(typeof window !== "undefined" ? window : globalThis);\n`);
  return { out, count: items.length };
}

module.exports = { write };
if (require.main === module) { const r = write(); console.log(`wrote ${r.out}: ${r.count} arrangements`); }
