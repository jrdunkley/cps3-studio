/* KitZip: read and write zip files, no dependencies (CPS3 Studio kit, work package A9).
 *
 *   KitZip.read(bytes, { only, inflate })  -> Promise<{ memberName: Uint8Array }>
 *   KitZip.list(bytes)                     -> [ { name, size, packed, method, crc, offset } ]   (no unpacking)
 *   KitZip.write({ memberName: bytes })    -> Uint8Array   (every member stored, correct CRC-32 and sizes)
 *   KitZip.crc32(bytes, previous)          -> number (unsigned)
 *   KitZip.ZipError                        every complaint, with a message that is plain words for the user
 *
 * Same code in the browser and in Node, one promise-based API. Members are stored (method 0) or
 * deflated (method 8, what every ROM zip uses); the CRC-32 and the size of every unpacked member are
 * checked against the zip's own directory, so a damaged zip never gives wrong bytes silently.
 * Deflate is unpacked by zlib.inflateRawSync in Node and by DecompressionStream('deflate-raw') in the
 * browser (opts.inflate = 'node' | 'web' picks one, for tests; the default is Node's when present).
 *
 * `only` limits what is unpacked (a ROM zip holds 70 MB the music tools never read): an array or Set of
 * member names, or a function (name) -> boolean. Returned arrays are copies, never views of the zip.
 * Not supported, said plainly: ZIP64 (files over 4 GB), passwords, methods other than 0 and 8.
 * The writer is deterministic (a fixed 1980-01-01 date stamp), so the same members give the same bytes.
 */
(function (g) {
  'use strict';
  const SIG_LOCAL = 0x04034B50, SIG_CENTRAL = 0x02014B50, SIG_END = 0x06054B50;
  const MAX_MEMBER = 1 << 30;                       /* a member the directory claims is bigger than 1 GiB is not a ROM part */
  const NOT_A_ZIP = 'This file is not a zip file (or it is damaged).';

  class ZipError extends Error {
    constructor(message) { super(message); this.name = 'ZipError'; }
  }

  function nodeModule(name) {
    try { return typeof module !== 'undefined' && typeof require === 'function' ? require(name) : null; } catch (e) { return null; }
  }
  const zlib = nodeModule('zlib');

  /* ---- CRC-32 (IEEE, as zip uses), four bytes at a time ---- */
  const T = (() => {
    const t = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[0][n] = c >>> 0;
    }
    for (let n = 0; n < 256; n++) {
      let c = t[0][n];
      for (let k = 1; k < 4; k++) { c = t[0][c & 255] ^ (c >>> 8); t[k][n] = c >>> 0; }
    }
    return t;
  })();
  function crc32(input, previous) {
    const b = u8(input), t0 = T[0], t1 = T[1], t2 = T[2], t3 = T[3], n = b.length;
    let c = (previous || 0) ^ 0xFFFFFFFF, i = 0;
    for (const end = n - 3; i < end; i += 4) {
      c ^= b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24);
      c = t3[c & 255] ^ t2[(c >>> 8) & 255] ^ t1[(c >>> 16) & 255] ^ t0[c >>> 24];
    }
    for (; i < n; i++) c = t0[(c ^ b[i]) & 255] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  /* any byte container -> a plain Uint8Array over the same memory (a Node Buffer's slice() does not copy; a Uint8Array's does) */
  function u8(x) {
    if (x instanceof Uint8Array) return x.constructor === Uint8Array ? x : new Uint8Array(x.buffer, x.byteOffset, x.length);
    if (x instanceof ArrayBuffer) return new Uint8Array(x);
    if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
    throw new ZipError('Expected the bytes of a zip file.');
  }

  const decoder = typeof TextDecoder === 'function' ? new TextDecoder('utf-8') : null;
  const encoder = typeof TextEncoder === 'function' ? new TextEncoder() : null;
  function decodeName(bytes) {
    if (decoder) return decoder.decode(bytes);
    let s = ''; for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }
  function encodeName(name) {
    if (encoder) return encoder.encode(name);
    const out = new Uint8Array(name.length); for (let i = 0; i < name.length; i++) out[i] = name.charCodeAt(i) & 255;
    return out;
  }

  /* ---- directory ---- */
  function list(input) {
    const z = u8(input);
    if (z.length < 22) throw new ZipError(NOT_A_ZIP);
    const dv = new DataView(z.buffer, z.byteOffset, z.byteLength);
    let end = -1;
    for (let i = z.length - 22, stop = Math.max(0, z.length - 22 - 0xFFFF); i >= stop; i--) {
      if (dv.getUint32(i, true) === SIG_END && i + 22 + dv.getUint16(i + 20, true) <= z.length) { end = i; break; }
    }
    if (end < 0) throw new ZipError(NOT_A_ZIP);
    const count = dv.getUint16(end + 10, true), size = dv.getUint32(end + 12, true), at = dv.getUint32(end + 16, true);
    if (count === 0xFFFF || size === 0xFFFFFFFF || at === 0xFFFFFFFF) throw new ZipError('This zip uses the ZIP64 format (files over 4 GB), which the Studio cannot read.');
    if (at + size > end) throw new ZipError('This zip file is damaged: its directory is cut off.');
    const entries = [];
    let p = at;
    for (let n = 0; n < count; n++) {
      if (p + 46 > end || dv.getUint32(p, true) !== SIG_CENTRAL) throw new ZipError('This zip file is damaged: its directory is unreadable.');
      const nameLength = dv.getUint16(p + 28, true), extraLength = dv.getUint16(p + 30, true), commentLength = dv.getUint16(p + 32, true);
      if (p + 46 + nameLength > end) throw new ZipError('This zip file is damaged: its directory is cut off.');
      const name = decodeName(z.subarray(p + 46, p + 46 + nameLength));
      entries.push({ name, size: dv.getUint32(p + 24, true), packed: dv.getUint32(p + 20, true), method: dv.getUint16(p + 10, true),
                     crc: dv.getUint32(p + 16, true), offset: dv.getUint32(p + 42, true), flags: dv.getUint16(p + 8, true) });
      p += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
  }

  /* ---- unpacking ---- */
  async function inflateWeb(data, name) {
    if (typeof DecompressionStream !== 'function') throw new ZipError('This browser cannot unpack zip files. Use a current Edge, Chrome, Firefox or Safari.');
    let stream;
    try { stream = new DecompressionStream('deflate-raw'); } catch (e) { throw new ZipError('This browser cannot unpack zip files. Use a current Edge, Chrome, Firefox or Safari.'); }
    const writer = stream.writable.getWriter();
    const writing = writer.write(data).then(() => writer.close());        /* not awaited first: the reader below must drain it */
    writing.catch(() => {});
    try {
      return new Uint8Array(await new Response(stream.readable).arrayBuffer());
    } catch (e) {
      throw new ZipError(`"${name}" is damaged: its compressed data cannot be unpacked.`);
    }
  }
  function inflateNode(data, size, name) {
    try {
      const out = zlib.inflateRawSync(data, { maxOutputLength: Math.max(size, 1) });
      /* a Node Buffer may be a slice of a shared pool: hand out a plain array over its own memory */
      return out.byteOffset === 0 && out.buffer.byteLength === out.length ? new Uint8Array(out.buffer) : new Uint8Array(out.buffer.slice(out.byteOffset, out.byteOffset + out.length));
    } catch (e) {
      throw new ZipError(`"${name}" is damaged: its compressed data cannot be unpacked.`);
    }
  }

  async function unpack(z, dv, e, mode) {
    if (e.flags & 1) throw new ZipError(`"${e.name}" is password-protected. Remove the password from the zip and try again.`);
    if (e.method !== 0 && e.method !== 8) throw new ZipError(`"${e.name}" is packed with compression method ${e.method}, which the Studio cannot unpack. Make the zip again with ordinary zip (deflate) compression.`);
    if (e.size > MAX_MEMBER) throw new ZipError(`"${e.name}" claims to be ${e.size.toLocaleString('en')} bytes, which is too large to be right: the zip is damaged.`);
    const lo = e.offset;
    if (lo + 30 > z.length || dv.getUint32(lo, true) !== SIG_LOCAL) throw new ZipError(`"${e.name}" is damaged: the zip's directory points to the wrong place.`);
    const start = lo + 30 + dv.getUint16(lo + 26, true) + dv.getUint16(lo + 28, true), stop = start + e.packed;
    if (stop > z.length) throw new ZipError(`"${e.name}" is damaged: the zip file is cut short.`);
    const raw = z.subarray(start, stop);
    let data;
    if (e.method === 0) {
      if (e.packed !== e.size) throw new ZipError(`"${e.name}" is damaged: its sizes do not agree.`);
      data = raw.slice();
    } else {
      data = mode === 'web' ? await inflateWeb(raw, e.name) : inflateNode(raw, e.size, e.name);
    }
    if (data.length !== e.size) throw new ZipError(`"${e.name}" is damaged: it unpacks to ${data.length.toLocaleString('en')} bytes, not the ${e.size.toLocaleString('en')} the zip lists.`);
    if (crc32(data) !== e.crc) throw new ZipError(`"${e.name}" is damaged: its contents do not match the zip's checksum.`);
    return data;
  }

  function wanted(only) {
    if (only === undefined || only === null) return null;
    if (typeof only === 'function') return only;
    const set = only instanceof Set ? only : new Set(only);
    return (name) => set.has(name);
  }

  async function read(input, opts) {
    opts = opts || {};
    const z = u8(input), entries = list(z), dv = new DataView(z.buffer, z.byteOffset, z.byteLength), want = wanted(opts.only);
    const mode = opts.inflate || (zlib ? 'node' : 'web');
    const out = {};
    for (const e of entries) {
      if (e.name.endsWith('/') && e.size === 0) continue;                  /* folder entries */
      if (want && !want(e.name)) continue;
      out[e.name] = await unpack(z, dv, e, mode);
    }
    return out;
  }

  /* ---- writing: stored members ---- */
  function write(files) {
    const names = Object.keys(files);
    if (names.length > 0xFFFF) throw new ZipError('A zip can hold at most 65,535 members.');
    const items = names.map((name) => {
      if (!name || name[0] === '/' || name.indexOf('\\') >= 0 || name.split('/').some((part) => part === '..')) throw new ZipError(`"${name}" is not a safe member name for a zip (no empty names, folders from the root, backslashes or "..").`);
      const data = u8(files[name]), nameBytes = encodeName(name);
      return { data, nameBytes, utf8: nameBytes.length !== name.length || /[^\x20-\x7E]/.test(name), crc: crc32(data) };
    });
    let total = 22, offset = 0;
    for (const it of items) { it.offset = offset; offset += 30 + it.nameBytes.length + it.data.length; total += 30 + it.nameBytes.length + it.data.length + 46 + it.nameBytes.length; }
    if (total > 0xFFFFFFFF) throw new ZipError('These files are too large for an ordinary zip (over 4 GB).');
    const out = new Uint8Array(total), dv = new DataView(out.buffer);
    let p = 0;
    for (const it of items) {                                                /* local headers and data */
      dv.setUint32(p, SIG_LOCAL, true); dv.setUint16(p + 4, 20, true); dv.setUint16(p + 6, it.utf8 ? 0x800 : 0, true); dv.setUint16(p + 8, 0, true);
      dv.setUint16(p + 10, 0, true); dv.setUint16(p + 12, 0x21, true);       /* 1980-01-01 00:00:00 */
      dv.setUint32(p + 14, it.crc, true); dv.setUint32(p + 18, it.data.length, true); dv.setUint32(p + 22, it.data.length, true);
      dv.setUint16(p + 26, it.nameBytes.length, true); dv.setUint16(p + 28, 0, true);
      out.set(it.nameBytes, p + 30); out.set(it.data, p + 30 + it.nameBytes.length);
      p += 30 + it.nameBytes.length + it.data.length;
    }
    const directory = p;
    for (const it of items) {                                                /* central directory */
      dv.setUint32(p, SIG_CENTRAL, true); dv.setUint16(p + 4, 20, true); dv.setUint16(p + 6, 20, true); dv.setUint16(p + 8, it.utf8 ? 0x800 : 0, true);
      dv.setUint16(p + 10, 0, true); dv.setUint16(p + 12, 0, true); dv.setUint16(p + 14, 0x21, true);
      dv.setUint32(p + 16, it.crc, true); dv.setUint32(p + 20, it.data.length, true); dv.setUint32(p + 24, it.data.length, true);
      dv.setUint16(p + 28, it.nameBytes.length, true); dv.setUint32(p + 42, it.offset, true);
      out.set(it.nameBytes, p + 46);
      p += 46 + it.nameBytes.length;
    }
    dv.setUint32(p, SIG_END, true); dv.setUint16(p + 8, items.length, true); dv.setUint16(p + 10, items.length, true);
    dv.setUint32(p + 12, p - directory, true); dv.setUint32(p + 16, directory, true);
    return out;
  }

  const api = { read, list, write, crc32, ZipError };
  g.KitZip = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
