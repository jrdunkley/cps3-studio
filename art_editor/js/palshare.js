/* ArtPalShare: colours in the formats the CPS3 community already uses. ROM-free: callers pass bytes.
 *
 *   PalMod colour strings   toPalMod(words) -> '("a…)'   fromText(text) -> { words, kind, note }
 *   IPS patches             ipsWrite(before, after) -> bytes   ipsRecords(bytes)   ipsApply(bytes, patch)
 *   FBNeo patch lists       fbneoDat({ title, description, files })   fbneoDatRead(text)
 *   ROM layout              memberAt(dataOffset)   dataOffset(member, offset)   FILE51
 *   Mod import              patchedData(stockData, inputs, { zip })   changedSources(stock, patched, sources)
 *   Player package          fbneoPackage({ set, title, description, before, after, preview })
 *
 * Facts this follows (checked 2026-11-07 against PalMod d3ab88e1 and FBNeo master, and on sfiii3nr1):
 * - The graphics image interleaves each pair of 2 MiB SIMM files byte by byte (.0 even, .1 odd), four
 *   MiB per pair, SIMM 3.0 first. PalMod's 3rd Strike file "51" is pairs 5.4/5.5 then 5.6/5.7, so its
 *   offset X is data-image offset 0x2800000 + X. Character colours live in SIMM files 5.6 and 5.7.
 * - A PalMod colour string is '(' + game code + count + 4 hex digits per colour + ')'. 3rd Strike arcade
 *   uses code '"' (game 1 + 33). Each colour is the stored word with its two bytes swapped, and PalMod
 *   always sets the top bit when it copies. Other CPS3 games share the format.
 * - FBNeo (and Fightcade's FBNeo) patches each ROM file before interleaving, from support/ips/<set>/:
 *   a .dat whose lines read 'romfile patch.ips' until a '[' section, then '[en_US]' and the title line
 *   (slashes make folders), and an optional .png preview with the .dat's name.
 */
(function (g) {
  'use strict';
  const LANE = 0x200000, PAIR = 0x400000, DATA = 0x4000000, FILE51 = { base: 0x2800000, size: 0x800000 };
  const GRAPHICS = []; for (const s of [3, 4, 5, 6]) for (let i = 0; i < 8; i++) GRAPHICS.push('sfiii3-simm' + s + '.' + i);
  const enc = s => new TextEncoder().encode(s), dec = b => new TextDecoder('utf-8').decode(b);
  const swap = w => ((w & 255) << 8) | (w >>> 8);

  /* ---- layout ---- */
  function memberAt(offset) {
    if (!Number.isInteger(offset) || offset < 0 || offset >= DATA) throw new Error('This offset is outside the graphics image.');
    const pair = Math.floor(offset / PAIR), within = offset % PAIR;
    return { name: GRAPHICS[pair * 2 + (within & 1)], offset: within >>> 1 };
  }
  function memberName(name) {
    const base = String(name).split(/[\\/]/).pop().toLowerCase().replace(/\.ips$/, '');
    const m = /(?:^|[^0-9])(?:sfiii3-)?simm([3-6])\.([0-7])$/.exec(base);
    return m ? 'sfiii3-simm' + m[1] + '.' + m[2] : null;
  }
  function dataOffset(name, offset) {
    const i = GRAPHICS.indexOf(memberName(name));
    if (i < 0) throw new Error(name + ' is not a 3rd Strike graphics SIMM file.');
    if (!Number.isInteger(offset) || offset < 0 || offset >= LANE) throw new Error('This offset is outside a SIMM file.');
    return (i >> 1) * PAIR + offset * 2 + (i & 1);
  }
  /* Replace one member's bytes inside a copy of the data image. */
  function putMember(data, name, bytes) {
    const i = GRAPHICS.indexOf(memberName(name)); if (i < 0) throw new Error(name + ' is not a graphics SIMM file.');
    if (bytes.length !== LANE) throw new Error(name + ' should be exactly 2 MiB; this one is ' + bytes.length.toLocaleString('en-GB') + ' bytes.');
    const base = (i >> 1) * PAIR + (i & 1); for (let k = 0; k < LANE; k++) data[base + k * 2] = bytes[k];
  }
  function getMember(data, name) {
    const i = GRAPHICS.indexOf(memberName(name)); if (i < 0) throw new Error(name + ' is not a graphics SIMM file.');
    const out = new Uint8Array(LANE), base = (i >> 1) * PAIR + (i & 1); for (let k = 0; k < LANE; k++) out[k] = data[base + k * 2]; return out;
  }

  /* ---- colour strings ---- */
  const CPS3_GAMES = new Map([[1, '3rd Strike'], [43, 'New Generation'], [80, 'New Generation'], [38, '2nd Impact'], [81, '2nd Impact'], [8, "JoJo's"], [28, 'Red Earth'], [89, 'Red Earth']]);
  const CPS3_MODE = 3; /* PalMod ColMode::COLMODE_RGB555_LE_CPS3, used by its '~' overflow form */
  function toPalMod(words) {
    const list = Array.from(words || []); if (!list.length) throw new Error('Choose at least one colour to copy.');
    list.forEach(w => { if (!Number.isInteger(w) || w < 0 || w > 65535) throw new Error('A colour word must be 0 to 65535.'); });
    const count = list.length + 33;
    return '("' + String.fromCharCode(count < 127 ? count : 33) + list.map(w => swap((w & 0x7FFF) | 0x8000).toString(16).toUpperCase().padStart(4, '0')).join('') + ')';
  }
  function hexColour(h) { h = h.replace(/^#|^0x/i, ''); if (h.length === 8) h = h.slice(2); const n = parseInt(h, 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
  function from8(rgb) { const c = rgb.map(v => Math.min(31, Math.round(v * 31 / 255))); return c[0] | (c[1] << 5) | (c[2] << 10); }
  /* Accepts PalMod strings from any CPS3 game, and lists of #RRGGBB / RRGGBB / 0xRRGGBB colours. */
  function fromText(text) {
    const s = String(text || '').replace(/[\s​]+/g, '');
    if (!s) throw new Error('Paste a PalMod colour string or a list of #RRGGBB colours.');
    const p = /\(([\s\S])([\s\S])([0-9A-Fa-f]*)\)/.exec(s);
    if (p) {
      const code = p[1].charCodeAt(0) - 33, flag = p[2].charCodeAt(0) - 33, hex = p[3];
      const cps3 = CPS3_GAMES.has(code) || (code === 93 && flag === CPS3_MODE);
      if (!cps3) throw new Error('This PalMod string comes from a game with another colour system (code ' + p[1] + '). Paste it into PalMod with a CPS3 game open, copy it again there, then paste it here.');
      if (!hex.length || hex.length % 4) throw new Error('This PalMod string is cut short. Copy it again in full, from ( to ).');
      const words = []; for (let i = 0; i < hex.length; i += 4) words.push(swap(parseInt(hex.slice(i, i + 4), 16)) & 0x7FFF);
      return { words, kind: 'palmod', note: words.length + (words.length === 1 ? ' colour' : ' colours') + ' from PalMod (' + (CPS3_GAMES.get(code) || 'CPS3') + ').' };
    }
    if (/\([\s\S]{2}[0-9A-Fa-f]{4}/.test(s)) throw new Error('This PalMod string is cut short. Copy it again in full, from ( to ).');
    const list = [...String(text).matchAll(/(?:#|0x|\b)([0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?)\b/g)].map(m => m[1]);
    if (list.length) return { words: list.map(h => from8(hexColour(h))), kind: 'hex', note: list.length + (list.length === 1 ? ' colour' : ' colours') + ' from RGB values (nearest game steps).' };
    throw new Error('This text has no PalMod string or #RRGGBB colours.');
  }

  /* ---- IPS ---- */
  const EOF = 0x454F46;
  function ipsWrite(before, after, { gap = 6 } = {}) {
    if (!(before instanceof Uint8Array) || !(after instanceof Uint8Array)) throw new Error('IPS needs the original and changed bytes.');
    if (after.length !== before.length) throw new Error('IPS patches here keep the file size; the files differ in length.');
    if (after.length > 0xFFFFFF) throw new Error('IPS cannot address files over 16 MiB.');
    const runs = []; let i = 0;
    while (i < after.length) {
      if (after[i] === before[i]) { i++; continue; }
      let start = i, end = i + 1, quiet = 0;
      for (let k = end; k < after.length && k - start < 0xFFFF; k++) { if (after[k] !== before[k]) { end = k + 1; quiet = 0; } else if (++quiet >= gap) break; }
      if (start === EOF) start--; /* a record may not begin at the bytes 'EOF' */
      runs.push([start, end]); i = end;
    }
    const parts = [enc('PATCH')];
    for (const [a, b] of runs) { const h = new Uint8Array(5); h[0] = a >>> 16; h[1] = (a >>> 8) & 255; h[2] = a & 255; h[3] = (b - a) >>> 8; h[4] = (b - a) & 255; parts.push(h, after.slice(a, b)); }
    parts.push(enc('EOF'));
    const out = new Uint8Array(parts.reduce((n, x) => n + x.length, 0)); let p = 0; for (const x of parts) { out.set(x, p); p += x.length; }
    return out;
  }
  function ipsRecords(patch) {
    const b = patch instanceof Uint8Array ? patch : new Uint8Array(patch);
    if (b.length < 8 || dec(b.slice(0, 5)) !== 'PATCH') throw new Error('This is not an IPS patch (it should start with PATCH).');
    const out = []; let p = 5;
    for (;;) {
      if (p + 3 > b.length) throw new Error('This IPS patch is cut short (no EOF).');
      const at = (b[p] << 16) | (b[p + 1] << 8) | b[p + 2]; p += 3;
      if (at === EOF) break;
      if (p + 2 > b.length) throw new Error('This IPS patch is cut short.');
      let size = (b[p] << 8) | b[p + 1]; p += 2;
      if (size) { if (p + size > b.length) throw new Error('This IPS patch is cut short.'); out.push({ offset: at, bytes: b.slice(p, p + size) }); p += size; }
      else { if (p + 3 > b.length) throw new Error('This IPS patch is cut short.'); size = (b[p] << 8) | b[p + 1]; out.push({ offset: at, bytes: new Uint8Array(size).fill(b[p + 2]) }); p += 3; }
    }
    return out;
  }
  function ipsApply(bytes, patch) {
    const out = bytes.slice(); for (const r of ipsRecords(patch)) { if (r.offset + r.bytes.length > out.length) throw new Error('This IPS patch writes past the end of its file; it was made for a different file.'); out.set(r.bytes, r.offset); }
    return out;
  }

  /* ---- FBNeo patch lists ---- */
  function cleanLine(s, fallback) { const t = String(s || '').replace(/[\r\n]+/g, ' ').trim(); return t || fallback; }
  function fbneoDat({ title, description = '', files }) {
    if (!files || !files.length) throw new Error('There are no changed files to patch.');
    const lines = files.map(f => f.member + ' "' + f.file + '"');
    const text = String(description || '').split(/\r?\n/).map(l => l.replace(/^\[/, '(')).filter(l => l.trim());
    return lines.concat(['', '[en_US]', cleanLine(title, 'CPS3 Studio colours'), ...text, '']).join('\r\n');
  }
  function token(s) { s = s.trim(); if (!s) return null; if (s[0] === '"') { const e = s.indexOf('"', 1); return e < 0 ? [s.slice(1), ''] : [s.slice(1, e), s.slice(e + 1)]; } const m = /^(\S+)(.*)$/.exec(s); return [m[1], m[2]]; }
  function fbneoDatRead(text) {
    const entries = [], descriptions = {}; let lang = null;
    for (const raw of String(text).replace(/^﻿/, '').split(/\r?\n/)) {
      if (lang === null && raw[0] !== '[') { const t = token(raw); if (!t || t[0][0] === '#') continue; const u = token(t[1]); if (!u) continue; const crc = /crc\s*\(?\s*([0-9a-f]{8})/i.exec(u[1]); entries.push({ rom: t[0], patch: u[0], crc: crc ? parseInt(crc[1], 16) : null }); continue; }
      const head = /^\[([^\]]+)\]/.exec(raw); if (head) { lang = head[1]; descriptions[lang] = []; continue; }
      if (lang) descriptions[lang].push(raw);
    }
    const text0 = (descriptions.en_US || Object.values(descriptions)[0] || []).filter(l => l.trim());
    return { entries, title: text0[0] || '', description: text0.slice(1).join('\n') };
  }

  /* ---- importing other people's mods ---- */
  /* inputs: [{ name, bytes }] - ROM zips, SIMM files, PalMod's '51', IPS patches, FBNeo .dat lists, or zips of them. */
  async function patchedData(stock, inputs, { zip } = {}) {
    if (!(stock instanceof Uint8Array) || stock.length !== DATA) throw new Error('The stock graphics image is required.');
    const data = stock.slice(), applied = [], ignored = [], files = [];
    async function expand(name, bytes, depth) {
      if (/\.zip$/i.test(name) || (bytes[0] === 0x50 && bytes[1] === 0x4B && bytes[2] === 3 && bytes[3] === 4)) {
        if (!zip) throw new Error('Zip support is not loaded.'); if (depth > 1) { ignored.push({ name, why: 'a zip inside a zip inside a zip' }); return; }
        const members = await zip.read(bytes); for (const [n, b] of Object.entries(members)) if (!n.endsWith('/')) await expand(n, b, depth + 1); return;
      }
      files.push({ name, bytes });
    }
    for (const input of inputs) await expand(input.name, input.bytes instanceof Uint8Array ? input.bytes : new Uint8Array(input.bytes), 0);
    const base = n => String(n).split(/[\\/]/).pop();
    const dats = files.filter(f => /\.dat$/i.test(f.name)).map(f => ({ ...fbneoDatRead(dec(f.bytes)), name: f.name }));
    const ipsByName = new Map(files.filter(f => /\.ips$/i.test(f.name)).map(f => [base(f.name).toLowerCase(), f]));
    const used = new Set();
    for (const f of files) {
      const short = base(f.name), lower = short.toLowerCase(), member = memberName(short);
      if (/\.(dat|ips)$/i.test(short)) continue;
      if (member && f.bytes.length === LANE) {
        const before = getMember(data, member); let n = 0; for (let k = 0; k < LANE; k++) n += before[k] !== f.bytes[k];
        putMember(data, member, f.bytes); applied.push({ name: short, target: member, changedBytes: n }); continue;
      }
      if ((lower === '51' || lower === '51.bin') && f.bytes.length === FILE51.size) {
        let n = 0; for (let k = 0; k < FILE51.size; k++) { if (data[FILE51.base + k] !== f.bytes[k]) n++; data[FILE51.base + k] = f.bytes[k]; }
        applied.push({ name: short, target: 'PalMod 51 file', changedBytes: n }); continue;
      }
      if (/^sfiii3-simm[12]\.\d$|^10$|^20$/.test(lower)) { ignored.push({ name: short, why: 'program file: its colours (Gill’s glow) are edited with Gill timed colours, not imported' }); continue; }
      ignored.push({ name: short, why: /\.(png|txt|md|jpg|gif)$/i.test(short) ? 'not a ROM file' : member ? 'wrong size for a SIMM file' : 'not a 3rd Strike graphics file' });
    }
    function patchTarget(target, patch, label) {
      if (target === '51') { const cur = data.slice(FILE51.base, FILE51.base + FILE51.size), out = ipsApply(cur, patch); let n = 0; for (let k = 0; k < out.length; k++) n += cur[k] !== out[k]; data.set(out, FILE51.base); applied.push({ name: label, target: 'PalMod 51 file', changedBytes: n }); return; }
      const before = getMember(data, target), out = ipsApply(before, patch); let n = 0; for (let k = 0; k < LANE; k++) n += before[k] !== out[k]; putMember(data, target, out); applied.push({ name: label, target, changedBytes: n });
    }
    for (const dat of dats) for (const e of dat.entries) {
      const f = ipsByName.get(base(e.patch).toLowerCase()) || ipsByName.get((base(e.patch) + '.ips').toLowerCase()), member = memberName(e.rom);
      if (!f) { ignored.push({ name: e.patch, why: 'listed in ' + base(dat.name) + ' but not supplied' }); continue; }
      used.add(f);
      if (!member) { ignored.push({ name: base(f.name), why: 'patches ' + e.rom + ', which holds no colours this Studio reads' }); continue; }
      patchTarget(member, f.bytes, base(f.name) + (dat.title ? ' · ' + dat.title : ''));
    }
    for (const f of ipsByName.values()) {
      if (used.has(f)) continue; const short = base(f.name), lower = short.toLowerCase(), member = memberName(short);
      if (member) { patchTarget(member, f.bytes, short); continue; }
      const records = ipsRecords(f.bytes), end = records.reduce((m, r) => Math.max(m, r.offset + r.bytes.length), 0);
      if (/^51(\.bin)?\.ips$/.test(lower) || (end > LANE && end <= FILE51.size && !/^10(\.bin)?\.ips$/.test(lower))) { patchTarget('51', f.bytes, short); continue; }
      ignored.push({ name: short, why: /^10/.test(lower) ? 'patches the program file (Gill’s glow); use Gill timed colours' : 'cannot tell which ROM file this patch is for; name it after the SIMM file (for example sfiii3-simm5.6.ips) or use its .dat' });
    }
    if (!applied.length) throw new Error(ignored.length ? 'Nothing here changes 3rd Strike graphics: ' + ignored.map(x => x.name + ' (' + x.why + ')').join('; ') + '.' : 'Choose a palette mod: ROM zip, SIMM files, PalMod 51 file or IPS patches.');
    return { data, applied, ignored };
  }
  /* Changed 16- or 64-colour rows at known stored sources (CPS3 source addresses, data = source - 0x400000). */
  function changedSources(stock, patched, sources) {
    const out = [], seen = new Set(), word = (b, o) => (b[o] << 8) | b[o + 1];
    for (const s of sources) {
      const key = s.source + ':' + s.size; if (seen.has(key)) continue; seen.add(key);
      const at = s.source - 0x400000, before = [], after = [], pens = [];
      for (let i = 0; i < s.size; i++) { const a = word(stock, at + i * 2), b = word(patched, at + i * 2); before.push(a); after.push(b); if (a !== b) pens.push(i); }
      if (pens.length) out.push({ ...s, before, after, pens });
    }
    return out;
  }
  /* Bytes that changed outside every known colour row: reported, never imported. */
  function unknownChanges(stock, patched, sources) {
    const known = []; for (const s of sources) known.push([s.source - 0x400000, s.source - 0x400000 + s.size * 2]);
    known.sort((a, b) => a[0] - b[0]);
    let n = 0, first = -1;
    for (let k = 0; k < DATA; k++) if (stock[k] !== patched[k]) {
      let inside = false; for (const [a, b] of known) { if (k < a) break; if (k < b) { inside = true; break; } }
      if (!inside) { n++; if (first < 0) first = k; }
    }
    return { bytes: n, first: first < 0 ? null : memberAt(first) };
  }

  /* ---- a player-ready FBNeo patch folder ---- */
  function slug(s) { return cleanLine(s, 'cps3-studio-colours').replace(/[^A-Za-z0-9 _-]+/g, '').trim().replace(/\s+/g, '_').slice(0, 48) || 'cps3-studio-colours'; }
  function fbneoPackage({ set = 'sfiii3nr1', title, description, before, after, preview }) {
    const name = slug(title), files = {}, list = [];
    for (const member of Object.keys(after).sort()) {
      const a = before[member], b = after[member]; if (!a || a.length !== b.length) throw new Error('Missing the original ' + member + '.');
      let same = true; for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) { same = false; break; } if (same) continue;
      const file = name + '_' + member.replace(/^sfiii3-/, '') + '.ips';
      files['support/ips/' + set + '/' + file] = ipsWrite(a, b); list.push({ member, file });
    }
    if (!list.length) throw new Error('No colours differ from the original game, so there is nothing to patch.');
    files['support/ips/' + set + '/' + name + '.dat'] = enc(fbneoDat({ title, description, files: list }));
    if (preview) files['support/ips/' + set + '/' + name + '.png'] = preview;
    return { name, files, patched: list.map(x => x.member) };
  }

  const api = { GRAPHICS, FILE51, LANE, memberAt, memberName, dataOffset, putMember, getMember, toPalMod, fromText, ipsWrite, ipsRecords, ipsApply, fbneoDat, fbneoDatRead, patchedData, changedSources, unknownChanges, fbneoPackage };
  g.ArtPalShare = api; if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
