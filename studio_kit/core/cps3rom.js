/* Cps3Rom: load a CPS3 ROM set, decrypt the program, interleave the graphics/sound ROM (CPS3 Studio kit,
 * work package A9). The same code runs in the browser and in Node; everything that waits is a promise.
 *
 *   Cps3Rom.load(files, opts)    -> Promise<{ game, title, revision, revisionTitle, supported, program, user,
 *                                             userMembers, sha256, notes }>
 *   Cps3Rom.loadZips(zips, opts) -> the same, from the zips' own bytes (unpacks only what the music tools read)
 *   Cps3Rom.wanted(opts)         -> (memberName) => boolean, for KitZip.read({ only })
 *   Cps3Rom.program(files, game) -> Uint8Array   the decrypted program image as the CPU sees it (16 MiB for sfiii3)
 *   Cps3Rom.encrypt(program, game) -> { memberName: Uint8Array }   the program SIMM members again (XOR is its own inverse)
 *   Cps3Rom.user(files, game)    -> Uint8Array   RomUser: pairs of members interleaved by byte
 *   Cps3Rom.mask(address, key1, key2), Cps3Rom.sha256(bytes) -> Promise<hex>, Cps3Rom.sha256Js(bytes) -> hex
 *   Cps3Rom.GAMES                the table of games (members, keys, releases)
 *
 * `files` is a map { memberName: Uint8Array } of the members of one zip, an ARRAY of such maps (one per
 * zip, any order) or a map of zips { 'sfiii3.zip': { members } }. Give an array or a map of zips when
 * several zips are involved: sfiii3nr1.zip and sfiii3.zip both hold members called sfiii3-simm1.0 .. 1.3
 * (the Japan 990512 NO CD build's bank 1 and the original release's), so one flat map cannot hold both.
 * load() recognises the release by its checksums, prefers the rev 1 bank 1 and says in plain words what
 * is missing (a RomError with .missing = member names and .needZips = zips to add).
 *
 * Program (BRF_PRG): banks of four 2 MiB members, byte k of every big-endian dword from member .k, the
 * banks one after the other from 06000000; the game's data reads see the image XORed with
 * cps3_mask(06000000 + offset, key1, key2) (FBNeo cps3run.cpp cps3_decrypt_game). New Generation has
 * its own keys; 2nd Impact is not encrypted (cps3_isSpecial). The tables were checked against the
 * research project's Python reference loader (hashes equal).
 * RomUser (BRF_GRA): members .0/.1 are the even/odd bytes of the first 4 MiB, .2/.3 the next 4 MiB, ...
 * Everything returned is Capcom's data: keep it private (browser storage, the module's data/).
 * install / musicSpace / simms (the generic installer) are work package A9 part 2.
 */
(function (g) {
  'use strict';
  const BASE = 0x06000000, LANE = 0x200000, BANK = 0x800000;

  function nodeModule(name) {
    try { return typeof module !== 'undefined' && typeof require === 'function' ? require(name) : null; } catch (e) { return null; }
  }
  const nodeCrypto = nodeModule('crypto');
  const zipModule = () => g.KitZip || nodeModule('./zip.js');

  class RomError extends Error {
    constructor(message, info) { super(message); this.name = 'RomError'; this.missing = (info && info.missing) || []; this.needZips = (info && info.needZips) || []; }
  }

  const members = (prefix, group, count) => { const out = []; for (const s of group) for (let i = 0; i < count; i++) out.push(`${prefix}-simm${s}.${i}`); return out; };
  /* revisions[].bank1 = CRC-32 of members .0 .. .3 of the first program bank, which is what differs between releases */
  const GAMES = {
    sfiii3: {
      id: 'sfiii3', title: 'Street Fighter III 3rd Strike', zip: 'sfiii3.zip', banks: [1, 2], keys: [0xA55432B4, 0x0C129981], decrypt: true,
      program: members('sfiii3', [1, 2], 4), graphics: members('sfiii3', [3, 4, 5, 6], 8), soundMembers: 4,
      revisions: [
        { id: 'sfiii3nr1', title: 'Japan 990512 NO CD (rev 1)', zip: 'sfiii3nr1.zip', supported: true, bank1: [0x66E66235, 0x186E8C5F, 0xBCE18CAB, 0x129DC2C9],
          sha256: '35ac2d569893926599b0f68d772e98f412573fb76b305ba3ed910f6136dd2de0' },
        { id: 'sfiii3', title: 'the sfiii3.zip release', zip: 'sfiii3.zip', supported: false, bank1: [0x11DFD3CD, 0xC50585E6, 0x8E011D9B, 0xDCA8D92F],
          sha256: '2970d33d70f1d440dc5f3375ac3e3f697c67c5cf612a2b6554fef4eb0e1d21f8' },
      ],
    },
    sfiii2: {
      id: 'sfiii2', title: 'Street Fighter III 2nd Impact', zip: 'sfiii2.zip', banks: [1, 2], keys: [0, 0], decrypt: false,
      program: members('sfiii2', [1, 2], 4), graphics: members('sfiii2', [3, 4, 5], 8), soundMembers: 0,
      revisions: [{ id: 'sfiii2', title: 'the sfiii2.zip release', zip: 'sfiii2.zip', supported: false, bank1: [0x2D666F0B, 0x2A3A8EF6, 0x161D2206, 0x87DED8A3],
                    sha256: '127ea590b588006b79cc787fb9cc1a4af9d6944bf2720fc518570a3001d52a87' }],
    },
    sfiii: {
      id: 'sfiii', title: 'Street Fighter III New Generation', zip: 'sfiii.zip', banks: [1], keys: [0xB5FE053E, 0xFC03925A], decrypt: true,
      program: members('sfiii', [1], 4), graphics: members('sfiii', [3, 4], 8).concat(['sfiii-simm5.0', 'sfiii-simm5.1']), soundMembers: 0,
      revisions: [{ id: 'sfiii', title: 'the sfiii.zip release', zip: 'sfiii.zip', supported: false, bank1: [0xCFC9E45A, 0x57920546, 0x0D8F2680, 0xEA4CA054],
                    sha256: '9c9490b0baccbb79ebb6bfbdf8bf0f487eac582f5a72b81340159e985b2848dc' }],
    },
  };
  const ORDER = ['sfiii3', 'sfiii2', 'sfiii'];          /* when a set holds more than one game, the music tools' game wins */
  const SUPPORTED_ZIP = 'sfiii3nr1.zip';

  /* a game id or table entry; when omitted: the game the member names in `files` belong to, else 3rd Strike */
  function gameOf(game, files) {
    if (game === undefined || game === null) {
      const names = files ? Object.keys(files) : [];
      game = ORDER.find((id) => names.some((n) => n.startsWith(`${id}-simm`))) || 'sfiii3';
    }
    const G = typeof game === 'string' ? GAMES[game] : game;
    if (!G || !G.program) throw new RomError(`Unknown game "${game}". Known games: ${Object.keys(GAMES).join(', ')}.`);
    return G;
  }

  /* ---- the address mask (FBNeo cps3run.cpp cps3_mask), 16 bits wide and repeated in both halves ---- */
  function rotl(v, n) { return ((v << n) | (v >>> (16 - n))) & 0xFFFF; }
  function rotxor(val, x) { const res = (val + rotl(val, 2)) & 0xFFFF; return rotl(res, 4) ^ (res & (val ^ x)); }
  function mask16(address, key1, key2) {
    const a = (address ^ key1) >>> 0;
    let val = (a & 0xFFFF) ^ 0xFFFF;
    val = rotxor(val, key2 & 0xFFFF);
    val ^= (a >>> 16) ^ 0xFFFF;
    val = rotxor(val, key2 >>> 16);
    val ^= (a & 0xFFFF) ^ (key2 & 0xFFFF);
    return val & 0xFFFF;
  }
  function mask(address, key1, key2) { const v = mask16(address, key1, key2); return ((v | (v << 16)) >>> 0); }

  const u8 = (x) => (x instanceof Uint8Array ? (x.constructor === Uint8Array ? x : new Uint8Array(x.buffer, x.byteOffset, x.length))
                     : x instanceof ArrayBuffer ? new Uint8Array(x) : ArrayBuffer.isView(x) ? new Uint8Array(x.buffer, x.byteOffset, x.byteLength) : null);
  const isBytes = (x) => x instanceof ArrayBuffer || ArrayBuffer.isView(x);
  const num = (n) => n.toLocaleString('en');

  function lanesOf(files, names, G) {
    return names.map((name) => {
      const b = u8(files[name]);
      if (!b) throw new RomError(`${name} is missing from the files given.`, { missing: [name] });
      if (b.length !== LANE) throw new RomError(`${name} is ${num(b.length)} bytes; this ROM part should be ${num(LANE)} bytes. The file may be damaged or from a different release.`);
      return b;
    });
  }

  /* ---- program: interleave four members per bank, XOR with the mask ---- */
  function program(files, game) {
    const G = gameOf(game, files), out = new Uint8Array(G.banks.length * BANK), [key1, key2] = G.keys;
    G.banks.forEach((bank, bi) => {
      const [l0, l1, l2, l3] = lanesOf(files, [0, 1, 2, 3].map((k) => G.program[bi * 4 + k]), G);
      if (!G.decrypt) {
        for (let i = 0, o = bi * BANK; i < LANE; i++, o += 4) { out[o] = l0[i]; out[o + 1] = l1[i]; out[o + 2] = l2[i]; out[o + 3] = l3[i]; }
        return;
      }
      for (let i = 0, o = bi * BANK; i < LANE; i++, o += 4) {
        const v = mask16(BASE + o, key1, key2), hi = v >>> 8, lo = v & 255;
        out[o] = l0[i] ^ hi; out[o + 1] = l1[i] ^ lo; out[o + 2] = l2[i] ^ hi; out[o + 3] = l3[i] ^ lo;
      }
    });
    return out;
  }

  /* ---- encrypt: the program image back into its SIMM members ---- */
  function encrypt(image, game) {
    const G = gameOf(game), p = u8(image), [key1, key2] = G.keys, out = {};
    if (!p || p.length !== G.banks.length * BANK) throw new RomError(`The program image should be ${num(G.banks.length * BANK)} bytes, not ${p ? num(p.length) : 'something else'}.`);
    G.banks.forEach((bank, bi) => {
      const m = [0, 1, 2, 3].map((k) => (out[G.program[bi * 4 + k]] = new Uint8Array(LANE)));
      for (let i = 0, o = bi * BANK; i < LANE; i++, o += 4) {
        const v = G.decrypt ? mask16(BASE + o, key1, key2) : 0, hi = v >>> 8, lo = v & 255;
        m[0][i] = p[o] ^ hi; m[1][i] = p[o + 1] ^ lo; m[2][i] = p[o + 2] ^ hi; m[3][i] = p[o + 3] ^ lo;
      }
    });
    return out;
  }

  /* ---- user: RomUser, pairs of 2 MiB members interleaved by byte (as many leading pairs as are present) ---- */
  function user(files, game, opts) {
    const G = gameOf(game, files), names = G.graphics;
    let pairs = 0;
    while (2 * pairs + 1 < names.length && files[names[2 * pairs]] && files[names[2 * pairs + 1]] && (!opts || opts.pairs === undefined || pairs < opts.pairs)) pairs++;
    const out = new Uint8Array(pairs * 2 * LANE);
    for (let p = 0; p < pairs; p++) {
      const [a, b] = lanesOf(files, [names[2 * p], names[2 * p + 1]], G);
      for (let i = 0, o = p * 2 * LANE; i < LANE; i++, o += 2) { out[o] = a[i]; out[o + 1] = b[i]; }
    }
    return out;
  }

  /* ---- SHA-256: the system's where there is one, else our own ---- */
  const K256 = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);
  function sha256Js(input) {
    const b = u8(input), n = b.length, h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]), w = new Uint32Array(64);
    function block(src, at) {
      for (let i = 0; i < 16; i++, at += 4) w[i] = (src[at] << 24) | (src[at + 1] << 16) | (src[at + 2] << 8) | src[at + 3];
      for (let i = 16; i < 64; i++) {
        const x = w[i - 15], y = w[i - 2];
        w[i] = (w[i - 16] + (((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3)) + w[i - 7] + (((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10))) | 0;
      }
      let a = h[0], bb = h[1], c = h[2], d = h[3], e = h[4], f = h[5], gg = h[6], hh = h[7];
      for (let i = 0; i < 64; i++) {
        const t1 = (hh + (((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))) + ((e & f) ^ (~e & gg)) + K256[i] + w[i]) | 0;
        const t2 = ((((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))) + ((a & bb) ^ (a & c) ^ (bb & c))) | 0;
        hh = gg; gg = f; f = e; e = (d + t1) | 0; d = c; c = bb; bb = a; a = (t1 + t2) | 0;
      }
      h[0] += a; h[1] += bb; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += gg; h[7] += hh;
    }
    let at = 0;
    for (; at + 64 <= n; at += 64) block(b, at);
    const rest = n - at, tail = new Uint8Array(rest < 56 ? 64 : 128), bits = n * 8;
    tail.set(b.subarray(at, n)); tail[rest] = 0x80;
    const dv = new DataView(tail.buffer);
    dv.setUint32(tail.length - 8, Math.floor(bits / 4294967296)); dv.setUint32(tail.length - 4, bits >>> 0);
    for (let o = 0; o < tail.length; o += 64) block(tail, o);
    let hex = '';
    for (let i = 0; i < 8; i++) hex += h[i].toString(16).padStart(8, '0');
    return hex;
  }
  function sha256(bytes) {
    const data = u8(bytes);
    if (nodeCrypto) return Promise.resolve(nodeCrypto.createHash('sha256').update(data).digest('hex'));
    if (g.crypto && g.crypto.subtle) {
      return g.crypto.subtle.digest('SHA-256', data).then((d) => Array.from(new Uint8Array(d), (v) => v.toString(16).padStart(2, '0')).join(''));
    }
    return Promise.resolve(sha256Js(data));
  }

  /* ---- load ---- */
  function sourcesOf(files) {
    if (Array.isArray(files)) return files.map((f) => ({ files: f }));
    if (!files || typeof files !== 'object') throw new RomError('Give the ROM files as { member name: bytes }, an array of those (one per zip), or { zip name: { members } }.');
    const values = Object.values(files);
    if (values.every(isBytes)) return [{ files }];
    if (values.every((v) => v && typeof v === 'object' && !isBytes(v))) return Object.keys(files).map((zip) => ({ zip, files: files[zip] }));
    throw new RomError('The ROM files are mixed: give either members (name -> bytes) or zips (zip name -> members), not both.');
  }
  /* members from a zip made with a folder ("roms/sfiii3-simm1.0") are found by their file name */
  const baseName = (name) => name.slice(name.lastIndexOf('/') + 1);
  function withoutFolders(members) {
    let out = members;
    for (const k of Object.keys(members)) {
      if (k.indexOf('/') < 0) continue;
      if (out === members) out = Object.assign({}, members);
      delete out[k]; out[baseName(k)] = members[k];
    }
    return out;
  }
  const first = (sources, name) => { for (const s of sources) if (s.files[name]) return s.files[name]; return null; };
  const sameCrcs = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

  function pickGame(sources, opts) {
    if (opts && opts.game) return gameOf(opts.game);
    for (const id of ORDER) {
      const prefix = `${id}-simm`;
      if (sources.some((s) => Object.keys(s.files).some((n) => n.startsWith(prefix)))) return GAMES[id];
    }
    throw new RomError(`These files are not a Street Fighter III ROM set the Studio can read. For the music tools add ${SUPPORTED_ZIP} and sfiii3.zip (Street Fighter III 3rd Strike, from your own copy of the game).`,
                       { needZips: [SUPPORTED_ZIP, 'sfiii3.zip'] });
  }

  /* choose, for each bank, the members to use; returns { files, missing: [{ name, kind }], notes } */
  function resolve(sources, G) {
    const files = {}, missing = [], notes = [];
    G.banks.forEach((bank, bi) => {
      const names = [0, 1, 2, 3].map((k) => G.program[bi * 4 + k]);
      const kind = bi === 0 ? 'first' : 'second';
      const complete = sources.filter((s) => names.every((n) => s.files[n]));
      let chosen = null;
      if (complete.length === 1) chosen = complete[0].files;
      else if (complete.length > 1) {
        const KitZip = zipModule();                              /* its crc32 tells the releases apart */
        if (!KitZip) throw new RomError('The zip reader (core/zip.js) must be loaded before core/cps3rom.js.');
        const ranked = complete.map((s, order) => {
          const crcs = names.map((n) => KitZip.crc32(s.files[n])), rev = bi === 0 ? G.revisions.find((r) => sameCrcs(r.bank1, crcs)) : null;
          return { s, order, rev, rank: !rev ? 1 : rev.supported ? 0 : 2 };
        }).sort((a, b) => a.rank - b.rank || a.order - b.order);
        chosen = ranked[0].s.files;
        if (ranked.some((r) => !r.rev && r !== ranked[0]) && bi === 0) notes.push(`More than one first half of the program was given; the one that was used is ${ranked[0].rev ? 'the ' + ranked[0].rev.title : 'the first unknown one'}.`);
      }
      for (const n of names) {
        const found = chosen ? chosen[n] : first(sources, n);
        if (found) files[n] = found; else missing.push({ name: n, kind });
      }
    });
    G.graphics.forEach((n, i) => {
      const found = first(sources, n);
      if (found) files[n] = found; else if (i < G.soundMembers) missing.push({ name: n, kind: 'sound' });
    });
    return { files, missing, notes };
  }

  function missingError(G, missing, zipFor) {
    const kinds = { first: G.banks.length > 1 ? 'the first half of the program' : 'the program', second: 'the second half of the program', sound: 'the samples' };
    const byZip = new Map();
    for (const m of missing) {
      const zip = zipFor(m.name, m.kind);
      if (!byZip.has(zip)) byZip.set(zip, new Map());
      if (!byZip.get(zip).has(m.kind)) byZip.get(zip).set(m.kind, []);
      byZip.get(zip).get(m.kind).push(m.name);
    }
    /* "sfiii3-simm2.0 to sfiii3-simm2.3" when the missing members are a run in the ROM's own order, else the list */
    const which = (kind, names) => {
      const order = kind === 'sound' ? G.graphics : G.program, at = order.indexOf(names[0]);
      const run = names.length > 2 && names.every((n, i) => order[at + i] === n);
      return run ? `${names[0]} to ${names[names.length - 1]}` : names.join(', ');
    };
    const describe = (kindMap) => {
      const parts = [...kindMap].map(([kind, names]) => `${kinds[kind]} (${which(kind, names)})`);
      return parts.length > 1 ? parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1] : parts[0];
    };
    const zips = [...byZip.keys()];
    const message = zips.length === 1
      ? `${zips[0]} is needed too: it holds ${describe(byZip.get(zips[0]))}.`
      : `More files are needed: ${zips.map((z) => `${z} (it holds ${describe(byZip.get(z))})`).join(' and ')}.`;
    return new RomError(message, { missing: missing.map((m) => m.name), needZips: zips });
  }

  async function load(files, opts) {
    opts = opts || {};
    const sources = sourcesOf(files).map((s) => ({ zip: s.zip, files: withoutFolders(s.files || {}) }));
    for (const s of sources) for (const n of Object.keys(s.files)) if (!isBytes(s.files[n])) throw new RomError(`${n} is not file data (expected bytes).`);
    const G = pickGame(sources, opts);
    const { files: picked, missing, notes } = resolve(sources, G);
    if (opts.graphics) for (const name of G.graphics) if (!picked[name] && !missing.some(m => m.name === name)) missing.push({ name, kind: 'sound' });
    /* which zip to ask for: the first program bank is in the rev 1 zip (the supported release), everything else in sfiii3.zip */
    if (missing.length) throw missingError(G, missing, (name, kind) => (kind === 'first' && G.id === 'sfiii3' ? SUPPORTED_ZIP : G.zip));
    const image = program(picked, G);
    const hash = await sha256(image);
    const rev = G.revisions.find((r) => r.sha256 === hash) || null;
    const supported = !!(rev && rev.supported);
    if (!supported) {
      if (G.id !== 'sfiii3') notes.push(`The Studio's music tools are made for Street Fighter III 3rd Strike (Japan 990512 NO CD), not for ${G.title}.`);
      else if (rev) notes.push(`This is ${rev.title}. The Studio's music tools are made for the Japan 990512 NO CD release: add ${SUPPORTED_ZIP} as well to use them.`);
      else notes.push(`This program image is not one the Studio knows (it differs from the releases it has seen, for example because it was changed). It opens, but the music tools only work with the Japan 990512 NO CD release (${SUPPORTED_ZIP}).`);
    }
    const userImage = user(picked, G, opts.music ? { pairs: G.soundMembers / 2 } : undefined);
    return { game: G.id, title: G.title, revision: rev ? rev.id : 'unknown', revisionTitle: rev ? rev.title : 'an unknown release', supported,
             program: image, user: userImage, data: opts.graphics ? userImage : undefined, userMembers: userImage.length / LANE, sha256: hash, notes };
  }

  /* what a caller needs to unpack from the zips: the program members of every known game and the sound members;
     opts.graphics = true: every graphics member as well (a sprite or palette module) */
  function wanted(opts) {
    const set = new Set();
    for (const G of Object.values(GAMES)) {
      for (const n of G.program) set.add(n);
      (opts && opts.graphics ? G.graphics : G.graphics.slice(0, G.soundMembers)).forEach((n) => set.add(n));
    }
    return (name) => set.has(baseName(name));
  }

  async function loadZips(zips, opts) {
    opts = opts || {};
    const KitZip = zipModule();
    if (!KitZip) throw new RomError('The zip reader (KitZip) is not loaded.');
    const named = Array.isArray(zips) ? zips.map((z, i) => [`zip ${i + 1}`, z]) : Object.entries(zips);
    const sources = [], only = wanted(opts);
    for (const [name, bytes] of named) {
      try { sources.push(await KitZip.read(bytes, { only, inflate: opts.inflate })); }
      catch (e) { if (e && e.name === 'ZipError') { e.message = `${name}: ${e.message}`; e.zipName = name; } throw e; }
    }
    return load(sources, opts);
  }

  function graphicsMembers(data, game = 'sfiii3') {
    const G = gameOf(game), bytes = u8(data), out = {};
    if (!bytes || bytes.length !== G.graphics.length * LANE) throw new RomError('A complete interleaved graphics image is required.');
    for (let pair = 0; pair < G.graphics.length / 2; pair++) {
      const a = new Uint8Array(LANE), b = new Uint8Array(LANE);
      for (let i = 0, p = pair * 2 * LANE; i < LANE; i++, p += 2) { a[i] = bytes[p]; b[i] = bytes[p + 1]; }
      out[G.graphics[pair * 2]] = a; out[G.graphics[pair * 2 + 1]] = b;
    } return out;
  }
  /* Preserve all original members, including the parent's different bank 1 and
     BIOS. Only the selected revision's program members and selected data change. */
  async function rebuildZips(zips, images, opts = {}) {
    const Zip = zipModule(), entries = Object.entries(zips), sources = [];
    for (const [name, bytes] of entries) sources.push({ zip: name, files: await Zip.read(bytes) });
    const G = gameOf(images.game || opts.game || 'sfiii3'), normalized = sources.map(s => ({ zip: s.zip, files: withoutFolders(s.files) })), selected = resolve(normalized, G).files;
    const replacement = { ...encrypt(images.program, G), ...(images.data ? graphicsMembers(images.data, G) : {}) }, outputs = {};
    for (let i = 0; i < sources.length; i++) {
      const files = { ...sources[i].files };
      for (const [name, bytes] of Object.entries(files)) { const base = baseName(name); if (replacement[base] && normalized[i].files[base] === selected[base]) files[name] = replacement[base]; }
      outputs[sources[i].zip] = Zip.write(files);
    } return outputs;
  }
  /* Large data uses binary chunks in IndexedDB, never localStorage/base64. The
     manifest is committed last; a failed write leaves the previous import valid.
     Music reads only the two leading sound chunks from a saved graphics image. */
  const CHUNK = 4 * 1024 * 1024;
  async function saveChunks(store, key, inputs, metadata) {
    const previous = await store.get(key), token = key + ':' + Date.now() + ':' + Math.random().toString(36).slice(2), items = {}, written = [];
    try {
      for (const [name, input] of Object.entries(inputs)) { const bytes = u8(input), keys = [], hashes = []; if (!bytes) throw new RomError('ROM storage needs binary bytes.');
        for (let p = 0; p < bytes.length; p += CHUNK) { const part = token + ':' + name + ':' + p, data = bytes.slice(p,p+CHUNK); await store.set(part, data); keys.push(part); written.push(part); hashes.push(await sha256(data)); }
        items[name] = { length: bytes.length, keys, hashes, sha256: await sha256(bytes) };
      }
      await store.set(key, { version: 1, metadata, items });
    } catch (e) { for (const k of written) await store.del(k); throw new RomError('ROM could not be saved locally (storage quota or permission). Previous import is retained: ' + e.message); }
    if (previous) for (const item of Object.values(previous.items || {})) for (const k of item.keys) await store.del(k);
  }
  async function readChunks(store, item, limit) {
    if (!item) return null;
    const n = limit == null ? item.length : Math.min(limit, item.length), bytes = new Uint8Array(n); let at = 0;
    for (let i = 0; i < item.keys.length; i++) { if (at >= n) break; const part = u8(await store.get(item.keys[i])); if (!part || part.length !== Math.min(CHUNK, item.length - at) || await sha256(part) !== item.hashes[i]) throw new RomError('Saved ROM is incomplete or damaged; import it again.'); bytes.set(part.subarray(0,n-at),at); at += part.length; }
    if (Math.min(at,n) !== n || n === item.length && await sha256(bytes) !== item.sha256) throw new RomError('Saved ROM checksum differs; import it again.');
    return bytes;
  }
  async function saveImages(store, rom) {
    const inputs = { program: rom.program, ...(rom.data ? { data: rom.data } : { user: rom.user }) }, metadata = {};
    for (const k of ['game','title','revision','revisionTitle','supported','sha256','notes']) metadata[k] = rom[k];
    return saveChunks(store, 'images', inputs, metadata);
  }
  async function restoreImages(store, opts = {}) {
    const saved = await store.get('images'); if (!saved) return null;
    const program = await readChunks(store,saved.items.program), item = saved.items.data || saved.items.user;
    if (opts.graphics && !saved.items.data) return null;
    const user = await readChunks(store,item,opts.graphics ? undefined : gameOf(saved.metadata.game).soundMembers * LANE);
    return { ...saved.metadata, program, user, data: opts.graphics ? user : undefined, userMembers: user.length / LANE };
  }
  async function saveZips(store, zips) { return saveChunks(store,'archives',zips,{}); }
  async function restoreZips(store) { const saved = await store.get('archives'); if (!saved) return null; const out = {}; for (const [name,item] of Object.entries(saved.items)) out[name] = await readChunks(store,item); return out; }

  /* Music installation: allocation and exact preimages follow the classic installer (its sequence check is music_editor/check_sequence.py).
   * Work on a private copy and publish it only when the entire batch validates. No filesystem I/O. */
  const MUSIC = 0x067D2000, MUSIC_END = 0x067FFFE0, REQUESTS = 0x0678F000, BANK_PTR = 0x06788020, SAMPLES = 0x0678C000;
  const align16 = n => (n + 15) & ~15;
  const read16 = (b, a) => (b[a - BASE] << 8) | b[a - BASE + 1];
  const read32 = (b, a) => ((read16(b, a) << 16) | read16(b, a + 2)) >>> 0;
  const word = n => Uint8Array.of(n >>> 24, n >>> 16, n >>> 8, n);
  const hexBytes = b => Array.from(b, n => n.toString(16).padStart(2, '0')).join('');
  function imageCheck(image) {
    if (!(image instanceof Uint8Array) || image.length !== 0x1000000 || read16(image, REQUESTS) !== 3251) throw new RomError('Use a decrypted 16 MiB sfiii3nr1 program image.');
  }
  function musicSpace(image) {
    imageCheck(image); let last = MUSIC - 1;
    for (let a = MUSIC_END - 1; a >= MUSIC; a--) if (image[a - BASE]) { last = a; break; }
    const next = Math.min(MUSIC_END, Math.max(MUSIC, align16(last + 1))), pieces = [];
    for (let code = 50; code <= 95; code++) { const offset = read32(image, REQUESTS + 4 + code * 4), address = REQUESTS + offset; if (offset) pieces.push({ code, address, inMusicSpace: address >= MUSIC && address < MUSIC_END }); }
    return { total: MUSIC_END - MUSIC, used: next - MUSIC, free: MUSIC_END - next, next, pieces };
  }
  function codeLiteralRefs(image) {
    const refs = [];
    for (let pc = 0x400; pc < 0x13C000; pc += 2) {
      const op = (image[pc] << 8) | image[pc + 1];
      if ((op & 0xF000) !== 0xD000) continue;
      const target = ((pc + 4) & ~3) + (op & 255) * 4, value = read32(image, BASE + target);
      if (value >= 0x067D1F6B && value < MUSIC_END) refs.push({ instruction: BASE + pc, literal: BASE + target, value });
    }
    return refs;
  }
  function decodeSong(text) {
    if (typeof text !== 'string' || !text.length || text.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) throw new RomError('The song’s sequence is not valid base64. Export the song again.');
    if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(text, 'base64'));
    return Uint8Array.from(atob(text), c => c.charCodeAt(0));
  }
  function checkSequence(bytes) {
    const fail = () => { throw new RomError('The song has a malformed sequence. Export the song again.'); };
    if (bytes.length < 34 || bytes[0]) fail();
    const offsets = []; for (let i = 1; i < 33; i += 2) { const n = bytes[i] * 256 + bytes[i + 1]; if (n) offsets.push(n); }
    offsets.sort((a, b) => a - b); if (!offsets.length || offsets[0] !== 33 || new Set(offsets).size !== offsets.length) fail();
    const params = { 0xC1: 2, 0xC2: 1, 0xC3: 1, 0xC4: 1, 0xC5: 1, 0xC6: 1, 0xC7: 1, 0xC8: 1, 0xC9: 1, 0xCC: 2, 0xCD: 2, 0xCE: 2, 0xCF: 1, 0xDC: 1, 0xDD: 1, 0xDE: 1, 0xDF: 1, 0xE0: 1, 0xE1: 1, 0xE2: 1, 0xE3: 1, 0xE4: 2, 0xE5: 2, 0xE6: 1, 0xE7: 1, 0xE8: 2, 0xD4: 1, 0xD5: 1, 0xD6: 1, 0xD7: 1, 0xD8: 2, 0xD9: 2, 0xDA: 2, 0xDB: 2 };
    offsets.forEach((start, i) => {
      const end = offsets[i + 1] || bytes.length, marks = new Set(), jumps = []; let p = start;
      if (start >= end || end > bytes.length) fail();
      while (p < end) {
        marks.add(p); let delta = 0;
        while (p < end && bytes[p] < 128) { if (++delta > 5) fail(); p++; }
        if (p >= end) fail(); const op = bytes[p++];
        if (op < 0xC0) { p++; let length = 0; do { if (p >= end || ++length > 5) fail(); } while (bytes[p++] & 128); }
        else { const n = params[op] || 0; if (p + n > end) fail(); if (op >= 0xD8 && op <= 0xDB) jumps.push(p + 2 + bytes[p] * 256 + bytes[p + 1]); if (op === 0xCE) jumps.push(p + 2 + (((bytes[p] * 256 + bytes[p + 1]) << 16) >> 16)); p += n; }
      }
      marks.add(end); if (p !== end || jumps.some(j => !marks.has(j))) fail();
    });
  }
  /* Read only bank 8. Existing custom regions are carried forward when a developer adds songs;
   * view identities use their actual sample bounds, not editor-local names or relocated indices. */
  function existingBank(image) {
    const at = read32(image, BANK_PTR), bank = { slot: 8, views: [], programs: {} }, known = new Map();
    if (at < BASE || at + 256 > BASE + image.length) throw new RomError('The custom instrument table is outside the program image.');
    for (let i = 0; i < 128; i++) {
      const off = read16(image, at + i * 2); if (!off) continue;
      if (at < MUSIC || at >= MUSIC_END) throw new RomError('Instrument 8 already contains data outside the music space. This build needs its own instrument installer.');
      const regions = []; let address = at + off;
      for (let count = 0; ; count++, address += 12) {
        if (address >= MUSIC_END || count > 128) throw new RomError('The existing custom instrument table is malformed.');
        const o = address - BASE; if (image[o] === 255) break; if (address + 12 > MUSIC_END) throw new RomError('The existing custom instrument table is truncated.');
        const number = read16(image, address + 4), index = number & 32767; let sample = { rom: index };
        if (index >= (MUSIC - SAMPLES) / 16) {
          const viewAt = SAMPLES + index * 16; if (viewAt < MUSIC || viewAt + 16 > MUSIC_END) throw new RomError('An existing custom sample view lies outside the music space.');
          if (!known.has(index)) { const id = 'existing-' + index; known.set(index, id); bank.views.push({ id, start: read32(image, viewAt), loop: read32(image, viewAt + 4), end: read32(image, viewAt + 8), root: read32(image, viewAt + 12) }); }
          sample = { view: known.get(index) };
        }
        regions.push({ keyHigh: image[o], pan: image[o + 1] === 255 ? null : image[o + 1], level: (image[o + 2] << 24) >> 24, root: image[o + 3], sample, ringOut: !!(number & 32768), fine: (image[o + 6] << 24) >> 24, attack: image[o + 7], decay: image[o + 8], sustain: image[o + 9], sustainRate: image[o + 10], release: image[o + 11] });
      }
      bank.programs[i] = { regions };
    }
    return bank;
  }
  function mergeBanks(banks, Bank) {
    const merged = { slot: 8, views: [], programs: {} }, signatures = new Map(), views = new Map();
    for (const bank of banks) {
      if (bank.slot != null && bank.slot !== 8) throw new RomError('Custom instruments must use instrument table 8.');
      if (!Object.keys(bank.programs || {}).length) continue;
      Bank.buildBlob(bank, MUSIC); // Validate before simplifying any input fields.
      const localViews = new Map();
      for (const v of bank.views || []) {
        const signature = JSON.stringify([v.start, v.loop == null ? v.end : v.loop, v.end, v.root]);
        if (!views.has(signature)) { const id = 'view-' + views.size; views.set(signature, id); merged.views.push({ id, start: v.start, loop: v.loop == null ? v.end : v.loop, end: v.end, root: v.root }); }
        localViews.set(v.id, views.get(signature));
      }
      for (const [number, p] of Object.entries(bank.programs || {})) {
        const regions = p.regions.map(r => ({ keyHigh: r.keyHigh, pan: r.pan == null ? null : r.pan, level: r.level || 0, fine: r.fine || 0, sample: r.sample.view != null ? { view: localViews.get(r.sample.view) } : { rom: r.sample.rom }, attack: r.attack, decay: r.decay, sustain: r.sustain, sustainRate: r.sustainRate, release: r.release, ringOut: !!r.ringOut }));
        const signature = JSON.stringify(regions);
        if (signatures.has(number) && signatures.get(number) !== signature) throw new RomError(`Custom instrument ${number} has different sounds in these songs. Give the new instrument another number.`);
        signatures.set(number, signature); merged.programs[number] = { name: p.name, regions };
      }
    }
    return merged;
  }
  async function install(input, items, opts) {
    opts = opts || {}; imageCheck(input);
    if (!Array.isArray(items) || !items.length) throw new RomError('Choose at least one song to install.');
    if (codeLiteralRefs(input).length) throw new RomError('This program has code pointing into the music space. Its developer must choose safe space before adding music.');
    const Compile = opts.compile || g.SF3Compile || nodeModule('../../music_editor/js/compile.js'), Bank = opts.bankBuilder || g.SF3Bank || nodeModule('../../music_editor/js/bank.js');
    const image = new Uint8Array(input), edits = [], placed = [], codes = new Set(); let cursor = musicSpace(image).next;
    const edit = (address, replacement, rationale) => {
      const bytes = new Uint8Array(replacement.length + (replacement.length & 1)); bytes.set(replacement);
      if (address % 2 || address < BASE || address + bytes.length > BASE + image.length) throw new RomError('The patch is outside the program image.');
      const expected = image.slice(address - BASE, address - BASE + bytes.length);
      if (address >= MUSIC && (address + bytes.length > MUSIC_END || expected.some(x => x))) throw new RomError('There is no zero-filled space for this song.');
      edits.push({ owner: 'music_studio', address: '0x' + address.toString(16), expected: hexBytes(expected), replacement: hexBytes(bytes), rationale }); image.set(bytes, address - BASE);
    };
    const allocate = (bytes, kind, info) => {
      const at = cursor; if (at + bytes.length + (bytes.length & 1) > MUSIC_END) throw new RomError('There is not enough music space left in this ROM.');
      edit(at, bytes, kind + (info.name ? ` "${info.name}"` : '')); cursor = Math.min(MUSIC_END, align16(at + bytes.length)); placed.push(Object.assign({ kind, address: at, bytes: bytes.length }, info)); return at;
    };
    const request = (code, address) => {
      if (!Number.isInteger(code) || code < 50 || code > 95) throw new RomError('New songs need an unused request code from 50 to 95.');
      if (codes.has(code)) throw new RomError(`Request ${code} was chosen more than once.`); codes.add(code);
      const at = REQUESTS + 4 + code * 4, old = read32(image, at);
      if (old && !opts.replace) throw new RomError(`Request ${code} is already used. Choose another code or explicitly replace that song.`);
      if (old && (REQUESTS + old < MUSIC || REQUESTS + old >= MUSIC_END)) throw new RomError(`Request ${code} belongs to data outside the music space and cannot be replaced.`);
      edit(at, word(address - REQUESTS), `Music request ${code}`);
    };
    for (const item of items) {
      const song = item.song; if (!song || song.format !== 'sf3song') throw new RomError('Choose a song file exported by the music editor.');
      const compressed = opts.compress !== false && !!song.compressed;
      if (compressed && (!song.checks || song.checks.compressed_sound_identical !== true)) throw new RomError('The compressed song has not been verified. Export it again or install its plain sequence.');
      const bytes = decodeSong(compressed ? song.compressed.sequence_b64 : song.sequence_b64); checkSequence(bytes);
      const songAt = allocate(bytes, 'song', { name: song.name, code: item.code, compressed }); request(item.code, songAt);
      if (item.chorusCode != null) {
        if (!Compile || !song.project) throw new RomError('A chorus entry needs the song’s editable project and the music compiler.');
        if (compressed && !song.compressed.chorus_safe) throw new RomError('Export this compressed song again with a chorus-safe entry.');
        const built = Compile.build(song.project, { compress: compressed, catalog: opts.catalog });
        if (built.bytes.length !== bytes.length || !built.bytes.every((v, i) => v === bytes[i])) throw new RomError('The song’s bytes differ from its editable project. Export it again before adding a chorus entry.');
        const entry = Compile.chorusEntry(song.project, { songAt, entryAt: cursor, compressed, catalog: opts.catalog });
        const at = allocate(entry, 'chorus', { name: song.name, code: item.chorusCode, songCode: item.code }); request(item.chorusCode, at);
      }
    }
    const banks = items.filter(x => x.song.bank).map(x => x.song.bank);
    if (banks.length) {
      if (!Bank) throw new RomError('The custom instrument builder is not loaded.');
      const existing = existingBank(input), merged = mergeBanks([existing, ...banks], Bank), old = mergeBanks([existing], Bank);
      const sonic = bank => JSON.stringify({ views: bank.views, programs: Object.fromEntries(Object.entries(bank.programs).map(([k, p]) => [k, p.regions])) });
      if (sonic(merged) !== sonic(old)) { const blob = Bank.buildBlob(merged, cursor); allocate(blob.bytes, 'bank', { slot: 8 }); edit(BANK_PTR, word(blob.base), 'Custom instruments in table 8'); }
    }
    return { program: image, edits: { edits }, report: { placed, free: musicSpace(image).free, total: MUSIC_END - MUSIC } };
  }
  const simms = image => { imageCheck(image); return encrypt(image, 'sfiii3'); };

  const api = { GAMES, BASE, mask, program, encrypt, user, sha256, sha256Js, load, loadZips, wanted, RomError, install, musicSpace, simms, codeLiteralRefs, graphicsMembers, rebuildZips, saveImages, restoreImages, saveZips, restoreZips };
  g.Cps3Rom = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
