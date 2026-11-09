/* Cps3GameRom: what the engine needs from the user's ROM beyond Cps3Rom's program/graphics images
 * (CPS3 Studio · Game). Same code in Node and the browser.
 *
 *   Cps3GameRom.bios(zipMembers) -> Uint8Array(512 KiB)  the sfiii3nr1 BIOS, decrypted as FBNeo's
 *       cps3_decrypt_bios does (first 0x20000 bytes XOR cps3_mask(offset), except the flash command
 *       block 0x1FF00..0x1FF6B), in logical (big-endian) byte order. FBNeo's reset-time region patch
 *       is applied by the engine (core.setImages biosDip), not here.
 *   Cps3GameRom.nvPayload(bytes) -> Uint8Array(0x400)  the settings chip from an FBNeo .nv file
 *   Cps3GameRom.settingsMode(eeprom) -> 0..2 | null       Infinite's GAME MODE byte (both copies agree)
 * Everything returned is the user's private data.
 */
(function (g) {
  'use strict';
  const BIOS_MEMBER = 'sfiii3_japan_nocd.29f400.u2', BIOS_SIZE = 0x80000;
  const Rom = () => g.Cps3Rom || (typeof require === 'function' ? require('../core/cps3rom.js') : null);

  function bios(members) {
    const name = Object.keys(members).find((n) => n.slice(n.lastIndexOf('/') + 1) === BIOS_MEMBER);
    if (!name) throw new Error(`The BIOS (${BIOS_MEMBER}) is missing: it is in sfiii3nr1.zip.`);
    const src = members[name];
    if (src.length !== BIOS_SIZE) throw new Error(`${BIOS_MEMBER} is ${src.length} bytes; it should be ${BIOS_SIZE}.`);
    const out = new Uint8Array(src), [k1, k2] = Rom().GAMES.sfiii3.keys;
    for (let i = 0; i < 0x20000; i += 4) {
      if (i >= 0x1FF00 && i <= 0x1FF6B) continue;
      const m = Rom().mask(i, k1, k2);
      out[i] ^= m >>> 24; out[i + 1] ^= (m >>> 16) & 255; out[i + 2] ^= (m >>> 8) & 255; out[i + 3] ^= m & 255;
    }
    if (out[0] !== 0 || out[1] !== 0 || out[2] !== 4 || out[3] !== 0 || out[4] !== 2 || out[5] !== 8) throw new Error('The BIOS did not decrypt to the expected reset vector; it may be from another game.');
    return out;
  }

  /* FBNeo NV file: "FB1 FS1" header (offset 24 = zlib stream length, 28 = driver name), then the stream of the 0x400-byte EEPROM at 0x4C, padded to 4 bytes. */
  async function nvPayload(bytes) {
    const at = bytes.findIndex((b, i) => b === 0x78 && bytes[i + 1] === 0x9C && i >= 8);
    if (String.fromCharCode(...bytes.slice(0, 7)) !== 'FB1 FS1' || at < 0) throw new Error('This is not an FBNeo settings (.nv) file.');
    const len = bytes[24] | bytes[25] << 8 | bytes[26] << 16 | bytes[27] << 24;          /* header: stream length; the stream is padded to 4 bytes */
    const body = bytes.subarray(at, len > 0 && at + len <= bytes.length ? at + len : bytes.length);
    let raw;
    if (typeof require === 'function' && typeof window === 'undefined') raw = new Uint8Array(require('zlib').inflateSync(body));
    else { const s = new Blob([body]).stream().pipeThrough(new DecompressionStream('deflate')); raw = new Uint8Array(await new Response(s).arrayBuffer()); }
    if (raw.length !== 0x400) throw new Error('This .nv file does not hold a CPS3 settings chip.');
    return raw;
  }

  function settingsMode(e) { return e && e[37] === e[85] && e[37] <= 2 ? e[37] : null; }

  const api = { bios, nvPayload, settingsMode, BIOS_MEMBER };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else g.Cps3GameRom = api;
})(typeof self !== 'undefined' ? self : this);
