/* SF3PackBuild: the music editor's data pack, made in JavaScript from the user's own ROM set (work package A9).
 * The same thing the research project's extract.py does for data/pack.js (that file stays as it is and is the gate's yardstick), but
 * from the zips in the browser or in Node, and as a version-2 pack (docs/plan/04_FORMATS.md section 5):
 *
 *   await SF3PackBuild.fromRomSet(loaded)  -> pack   loaded = Cps3Rom.load(...) / Cps3Rom.loadZips(...)
 *   await SF3PackBuild.fromRomSet(files)   -> pack   files = what Cps3Rom.load takes (it loads them first)
 *
 *   pack = { version: 2, rom: 'sfiii3nr1', program_sha256, names, prg: [ { addr, bytes: Uint8Array } ],
 *            samples: Uint8Array, game: { fn, tables, channels, tempo, marker, stereoFlag, cave } }
 *
 * What goes in (the research project's extract.py): the parts of the program ROM the sound driver runs or reads, found by tracing the
 * reference runner over every piece of music (REGIONS: runtime helpers, the driver, its tables, the instrument
 * banks / sample table / request table / sequences), and the 8-bit samples of the sound SIMMs in playing order
 * (byte pairs swapped: sample n is user byte n ^ 1).
 * The addresses are those of the Japan 990512 NO CD build (sfiii3nr1); any other release is refused in plain
 * words. A pack is made from the ROM and stays private: browser storage or data/, never published.
 */
(function (g) {
  'use strict';
  const Rom = g.Cps3Rom || require('../../studio_kit/core/cps3rom.js');
  const BASE = 0x06000000;
  /* 4 KiB pages: 0612D runtime helpers, 06139..0613B driver, 0660C..0660E driver tables, 06788000..067D1FFF banks,
     sample table, request table and sequences (the research project's extract.py REGIONS) */
  const REGIONS = [[0x0612D000, 0x0612E000], [0x06139000, 0x0613C000], [0x0660C000, 0x0660F000], [0x06788000, 0x067D2000]];
  const SAMPLE_TABLE = 0x0678C000, REQUEST_TABLE = 0x0678F000, REQUESTS = 3251, SAMPLE_TOP = 0x7F5B9D;
  /* arcade track numbers, as the research project's extract.py NAMES */
  const NAMES = { 1: 'Opening', 10: 'Alex / Ken', 12: 'Necro / Twelve', 14: 'Hugo', 16: 'Chun-Li', 18: 'Ryu', 20: 'Ibuki', 22: 'Makoto', 24: 'Akuma',
                  26: 'Elena', 28: 'Oro / Sean', 30: 'Dudley', 32: 'Yun / Yang', 34: 'Remy', 36: 'Urien', 38: 'Gill', 40: 'Q', 42: 'Bonus stage - garage',
                  43: 'Bonus stage - basketball', 44: 'Ending 1', 45: 'Ending 2', 46: 'Staff credits' };
  /* the driver of sfiii3nr1 (02_DRIVER.md; the engine's constants): what the engine reads when a pack carries a game table.
     cave = where the editor's own data may live: zero in the stock ROM, no code literal points into it (067D2000..067FFFE0). */
  const gameTable = () => ({
    fn: { setBank: 0x06139310, init: 0x06139316, request: 0x061394D0, requestFade: 0x0613A2BC, update: 0x0613A408, pitchVolume: 0x0613A324, tempoOffset: 0x061392FC, stopMusic: 0x0613A1E8 },
    tables: { request: REQUEST_TABLE, samples: SAMPLE_TABLE, banks: 0x06788000 },
    channels: 0x02078D0C, tempo: 0x02079C14, marker: 0x02079C5C, stereoFlag: 0x02079C5B,
    cave: [0x067D2000, 0x067FFFE0],
  });

  function names() {
    const out = Object.assign({}, NAMES);
    for (let code = 10; code < 42; code += 2) out[code + 1] = out[code] + ' (second arrangement)';
    return out;
  }

  async function fromRomSet(input, opts) {
    const loaded = input && input.program && input.sha256 && input.user ? input : await Rom.load(input, opts);
    if (loaded.game !== 'sfiii3') throw new Rom.RomError(`The music tools work with Street Fighter III 3rd Strike; these files are ${loaded.title}.`);
    if (!loaded.supported) {
      throw new Rom.RomError(`The Studio's sound data is mapped for the Japan 990512 NO CD release (sfiii3nr1.zip); these files are ${loaded.revisionTitle}. Add sfiii3nr1.zip to use the music tools.`);
    }
    const prg = loaded.program, user = loaded.user;
    const u16 = (a) => (prg[a - BASE] << 8) | prg[a - BASE + 1];
    const u32 = (a) => ((prg[a - BASE] << 24) | (prg[a - BASE + 1] << 16) | (prg[a - BASE + 2] << 8) | prg[a - BASE + 3]) >>> 0;
    if (prg.length !== 0x1000000 || u16(REQUEST_TABLE) !== REQUESTS) throw new Rom.RomError('The sound data in this program is not the data the Studio knows: the request table is not where it should be.');
    let top = 0;
    for (let a = SAMPLE_TABLE; a < REQUEST_TABLE; a += 16) {
      const start = u32(a), end = u32(a + 8);
      if (!(start === 0 && end === 0) && end > top) top = end;
    }
    if (top !== SAMPLE_TOP) throw new Rom.RomError('The sound data in this program is not the data the Studio knows: the sample table ends in the wrong place.');
    const size = (top + 0xFFF) & ~0xFFF;
    if (user.length < size) throw new Rom.RomError(`The samples are incomplete: sfiii3-simm3.0 to sfiii3-simm3.3 (in sfiii3.zip) are needed; only ${loaded.userMembers} of the graphics/sound members are there.`);
    const samples = new Uint8Array(size);
    for (let n = 0; n < size; n += 2) { samples[n] = user[n + 1]; samples[n + 1] = user[n]; }      /* playing order: sample n is byte (n ^ 1) */
    return {
      version: 2, rom: loaded.revision, program_sha256: loaded.sha256, names: names(),
      prg: REGIONS.map(([a, b]) => ({ addr: a, bytes: prg.slice(a - BASE, b - BASE) })),
      samples, game: gameTable(),
    };
  }

  const api = { fromRomSet, REGIONS, NAMES, names, gameTable };
  g.SF3PackBuild = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
