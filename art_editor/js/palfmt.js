/* Palette interchange, without silent quantisation. Native metadata retains bit 15.
 * ACT uses a trailing CPS3 record; JASC a comment; RIFF an optional c3wd chunk.
 * Readers that remove metadata still retain ordinary RGB, but cannot retain flags.
 * PNG is supplied by lane U3 through setPng(adapter), never a second PNG codec. */
(function (g) {
  'use strict';
  const R = g.ArtRamps || (typeof require === 'function' ? require('./ramps.js') : null);
  const enc = s => new TextEncoder().encode(s), dec = b => new TextDecoder('utf-8', { fatal: true }).decode(b);
  const signature = 'CPS3WORDS1:';
  let pngAdapter = null;
  const conversionCache = new WeakMap();
  function words(list) { const a = Array.from(list || [], w => typeof w === 'string' && /^0x[\da-f]{1,4}$/i.test(w) ? Number(w) : w); if (!a.length || a.length > 256) throw new Error('A palette file needs 1 to 256 colours.'); a.forEach(R.valid); return a; }
  function snap(colours, options = {}) {
    let lut=null;
    if(options.toRGB) { if(typeof options.toRGB!=='function')throw new Error('Give a colour conversion function.');lut=conversionCache.get(options.toRGB);if(!lut){lut=Array.from({length:32768},(_,w)=>Array.from(options.toRGB(w)).slice(0,3));if(lut.some(c=>c.length!==3||c.some(n=>!Number.isInteger(n)||n<0||n>255)))throw new Error('Colour conversion needs three whole bytes.');conversionCache.set(options.toRGB,lut);} }
    /* Files from CPS3 tools hold expanded 5-bit steps (MAME/PalMod v<<3, FBNeo v<<3|v>>2). Read those exactly. */
    const expansion = v => { const s = v >> 3; return v === s << 3 || v === ((s << 3) | (s >> 2)); };
    const exact = !options.nearest && colours.every(c => c.slice(0,3).every(v => Number.isInteger(v) && v >= 0 && v <= 255 && expansion(v)));
    const report = [], out = colours.map((rgb, index) => {
      if (rgb.length < 3 || rgb.slice(0,3).some(c => !Number.isInteger(c) || c < 0 || c > 255)) throw new Error('Colour ' + index + ' needs R G B from 0 to 255.');
      if (rgb.length > 3 && rgb[3] !== 255) throw new Error('Colour ' + index + ' has transparency; palette strips need opaque colours.');
      let native=R.word(rgb.slice(0,3).map(c => exact ? c >> 3 : Math.round(c * 31 / 255)));
      if(lut && !exact){let distance=Infinity;for(let w=0;w<32768;w++){const c=lut[w],d=(c[0]-rgb[0])**2+(c[1]-rgb[1])**2+(c[2]-rgb[2])**2;if(d<distance){distance=d;native=w;}}}
      const w=native | (options.flags ? (options.flags[index] || 0)&32768 : 0), after = lut ? lut[native] : R.expanded(w), delta = after.map((c,k) => c - rgb[k]);
      if (!exact && delta.some(c => c)) report.push({ index, before: rgb.slice(0,3), after, delta, maximum: Math.max(...delta.map(Math.abs)), distance: Math.hypot(...delta) });
      return w;
    });
    return { words: out, report, metadata: {}, flagSource: options.flags ? 'target' : 'none' };
  }
  function metadata(native, colours, options) {
    if(colours.some(c=>c.length>3 && c[3]!==255))throw new Error('This palette strip has transparency. Use opaque colours.');
    if (!native) return snap(colours, options);
    const out = words(native); if (out.length !== colours.length || out.some((w,i) => R.expanded(w).some((c,k) => c !== colours[i][k]))) throw new Error('Native palette metadata disagrees with the visible colours.');
    return { words: out, report: [], metadata: {}, flagSource: 'file' };
  }
  function join(...arrays) { const out = new Uint8Array(arrays.reduce((s,a) => s+a.length,0)); let p = 0; arrays.forEach(a => { out.set(a,p); p += a.length; }); return out; }
  /* Only ancillary metadata framing here; pixels and PNG validation belong to ArtPng. */
  function pngRecord(record) {
    const data=enc('cps3:palette\0'+record),out=new Uint8Array(data.length+12),v=new DataView(out.buffer);v.setUint32(0,data.length);out.set(enc('tEXt'),4);out.set(data,8);
    let crc=4294967295;for(const byte of out.slice(4,-4)){crc^=byte;for(let k=0;k<8;k++)crc=crc&1?(crc>>>1)^3988292384:crc>>>1;}v.setUint32(out.length-4,(crc^4294967295)>>>0);return out;
  }
  function readPngRecord(b) {
    const view=new DataView(b.buffer,b.byteOffset,b.byteLength);let p=8,record;
    while(p+12<=b.length){const n=view.getUint32(p);if(p+n+12>b.length)throw new Error('Truncated palette PNG metadata.');if(dec(b.slice(p+4,p+8))==='tEXt'){const data=b.slice(p+8,p+8+n),z=data.indexOf(0);if(z>0 && dec(data.slice(0,z))==='cps3:palette'){if(record!==undefined)throw new Error('PNG repeats native palette metadata.');record=dec(data.slice(z+1));}}p+=n+12;}return record;
  }
  const u32 = (b,p) => new DataView(b.buffer,b.byteOffset,b.byteLength).getUint32(p,true);
  function jsonRead(input, options = {}) {
    const j = typeof input === 'string' ? JSON.parse(input) : input instanceof Uint8Array ? JSON.parse(dec(input)) : input;
    if (!j || typeof j !== 'object') throw new Error('This JSON has no palette.');
    if (j.format === 'cps3-palette-groups') { if (!Array.isArray(j.groups)) throw new Error('This groups file has no groups.'); return { rows: [], groups: j.groups, metadata: j, report: [] }; }
    if (j.format === 'cps3-palette-variant') {
      if (j.version !== 1 || !Array.isArray(j.banks) || !j.banks.length) throw new Error('This palette variant has no supported rows.');
      const rows = [];
      for (const bank of j.banks) {
        if (!Number.isInteger(bank.rows) || bank.rows < 1 || !Array.isArray(bank.words) || bank.words.length !== bank.rows * 64) throw new Error('Legacy palette row count does not match its words.');
        for (let n = 0; n < bank.rows; n++) rows.push({ id: bank.key + ':' + n, name: bank.key + ' ' + (n+1), words: words(bank.words.slice(n*64,n*64+64)), readOnly: !!bank.derived, rule: bank.derived || '', legacy: { key: bank.key, row: n, dst: bank.dst, paletteRows: bank.palette_rows && bank.palette_rows[n] } });
      }
      return { rows, words: rows.length === 1 ? rows[0].words : undefined, groups: j.editor_groups || [], metadata: j, report: [], flagSource: 'file' };
    }
    if (j.format === 'cps3-art-palette' && j.version === 1) {
      const rows = (j.rows || []).map(r => ({ ...r, words: words(r.words) }));
      if (!rows.length || rows.some(r => r.words.length !== 64)) throw new Error('A Studio palette row needs exactly 64 words.');
      return { rows, words: rows.length === 1 ? rows[0].words : undefined, groups: j.groups || [], metadata: j, report: [], flagSource: 'file' };
    }
    if (Array.isArray(j.colours)) return snap(j.colours,options);
    throw new Error('This JSON is not a supported palette or groups file.');
  }
  async function write(format, input, options = {}) {
    if (format === 'json') {
      const rows = Array.isArray(input.rows) ? input.rows.map(r => ({ ...r, words: words(r.words) })) : [{ id: options.id || 'row', name: options.name || 'Palette', words: words(input) }];
      if (rows.some(r => r.words.length !== 64)) throw new Error('A Studio palette row needs exactly 64 words.');
      return enc(JSON.stringify({ format: 'cps3-art-palette', version: 1, ...options.metadata, rows, groups: input.groups || options.groups || [] }, null, 2));
    }
    const list = words(input), rgb = list.map(R.expanded), record = signature + JSON.stringify(list);
    /* ACT: 772 bytes, colour count and transparent index 0, exactly as PalMod and Photoshop write it (PalMod refuses
     * any other size). 'act-mugen' is the upside-down table MUGEN and Fighter Factory use: pen 0 in the last slot. */
    if (format === 'act' || format === 'act-mugen') { const b = new Uint8Array(772), v = new DataView(b.buffer), up = format === 'act-mugen'; if (list.length > 256) throw new Error('ACT holds at most 256 colours.'); rgb.forEach((c,i) => b.set(c,(up ? 255 - i : i)*3)); v.setUint16(768,up ? 256 : list.length,false); v.setUint16(770,0,false); return b; }
    /* GIMP palette as PalMod writes it: transparent pen 0 left out (PalMod adds it back on import). */
    if (format === 'gpl') { const name = String(options.name || (options.metadata && options.metadata.name) || 'CPS3 colours').replace(/[\r\n]+/g,' '); return enc(['GIMP Palette','Name: '+name,'Columns: 16','# CPS3 Studio. Pen 0 (transparent) is left out, as in PalMod.','# '+record,...rgb.slice(1).map((c,i)=>c.map(n=>String(n).padStart(3)).join(' ')+'\tPen '+(i+1)),''].join('\n')); }
    if (format === 'jasc' || format === 'pal') return enc(['JASC-PAL','0100',list.length,...rgb.map(c=>c.join(' ')),'# '+record,''].join('\r\n'));
    if (format === 'riff') {
      const payload = new Uint8Array(4+list.length*4), v = new DataView(payload.buffer); v.setUint16(0,768,true); v.setUint16(2,list.length,true); rgb.forEach((c,i)=>payload.set(c,4+i*4));
      function chunk(name,data) { const h = new Uint8Array(8); h.set(enc(name)); new DataView(h.buffer).setUint32(4,data.length,true); return join(h,data,new Uint8Array(data.length%2)); }
      const body = join(enc('PAL '),chunk('data',payload),chunk('c3wd',enc(record))), h = new Uint8Array(8); h.set(enc('RIFF')); new DataView(h.buffer).setUint32(4,body.length,true); return join(h,body);
    }
    if (format === 'png') {
      const adapter = pngAdapter || g.ArtPng; if (!adapter || typeof adapter.write !== 'function') throw new Error('PNG palette strips await the ArtPng writer from lane U3.');
      const image=list.length<=64?{width:list.length,height:1,pens:Uint8Array.from(list,(_,i)=>i),palette:rgb.map(c=>[...c,255])}:{width:list.length,height:1,rgba:Uint8Array.from(rgb.flatMap(c=>[...c,255]))};
      const bytes=await adapter.write(image);return join(bytes.slice(0,33),pngRecord(record),bytes.slice(33));
    }
    throw new Error('Choose ACT, MUGEN ACT, GIMP GPL, JASC PAL, RIFF PAL, PNG strip or JSON.');
  }
  function pngHeight(b) { return b.length > 24 && b[0] === 0x89 && b[1] === 0x50 ? new DataView(b.buffer,b.byteOffset,b.byteLength).getUint32(20) : -1; }
  /* The colour table of an indexed PNG, GIF or BMP, in index order: how PalMod, Aseprite and MUGEN rips keep pens. */
  function imageTable(b) {
    const v = new DataView(b.buffer,b.byteOffset,b.byteLength), rgb = (at,n,step,bgr) => Array.from({length:n},(_,i)=>{const p=at+i*step;if(p+3>b.length)throw new Error('This picture’s colour table is cut short.');return bgr?[b[p+2],b[p+1],b[p]]:[b[p],b[p+1],b[p+2]];});
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) {
      for (let p = 8; p + 8 <= b.length;) { const n = v.getUint32(p), type = String.fromCharCode(...b.subarray(p+4,p+8)); if (type === 'PLTE') { if (!n || n % 3 || n > 768) throw new Error('This PNG has a damaged colour table.'); return rgb(p+8,n/3,3); } if (type === 'IDAT' || type === 'IEND') break; p += n + 12; }
      throw new Error('This PNG has no colour table: it is a true-colour picture. Save it as an indexed (palette) PNG, or import the picture in Import instead.');
    }
    if (dec(b.slice(0,3)) === 'GIF') {
      if (b.length < 13) throw new Error('This GIF is cut short.');
      if (b[10] & 0x80) return rgb(13,2 << (b[10] & 7),3);
      let p = 13; while (p < b.length) { if (b[p] === 0x21) { p += 2; while (p < b.length && b[p]) p += b[p] + 1; p++; } else if (b[p] === 0x2C) { const f = b[p+9]; if (f & 0x80) return rgb(p+10,2 << (f & 7),3); break; } else break; }
      throw new Error('This GIF has no colour table.');
    }
    if (b[0] === 0x42 && b[1] === 0x4D && b.length > 54) {
      const dib = v.getUint32(14,true), bpp = v.getUint16(28,true), used = dib >= 40 ? v.getUint32(46,true) : 0;
      if (bpp > 8) throw new Error('This BMP has ' + bpp + '-bit colour and no colour table. Save it as an 8-bit (256 colour) BMP.');
      return rgb(14 + dib, used || (1 << bpp), dib === 12 ? 3 : 4, true);
    }
    throw new Error('This picture is not a PNG, GIF or BMP.');
  }
  async function read(format, input, options = {}) {
    if (format === 'json') return jsonRead(input,options);
    const b = input instanceof Uint8Array ? input : typeof input === 'string' ? enc(input) : new Uint8Array(input);
    let colours, native;
    if (format === 'act' || format === 'act-mugen') {
      if (b.length !== 768 && b.length < 772) throw new Error('This ACT file is truncated.');
      const up = format === 'act-mugen', n = up ? 256 : b.length >= 772 ? new DataView(b.buffer,b.byteOffset,b.byteLength).getUint16(768,false) || 256 : 256;
      if (n > 256) throw new Error('ACT declares more than 256 colours.');
      /* The transparent index (PalMod and Photoshop write 0) only marks pen 0, which the game never draws. */
      colours = Array.from({length:n},(_,i)=>Array.from(b.slice((up ? 255 - i : i)*3,(up ? 255 - i : i)*3+3)));
      if (b.length > 772 && !up) { const s = dec(b.slice(772)); if (!s.startsWith(signature)) throw new Error('This ACT has an unknown trailing record.'); native = JSON.parse(s.slice(signature.length)); }
      if (options.size && colours.length > options.size) colours = colours.slice(0, options.size);
    } else if (format === 'jasc' || format === 'pal') {
      if (b.length >= 4 && dec(b.slice(0,4)) === 'RIFF') return read('riff',b,options);
      const lines = dec(b).trim().split(/\r?\n/);
      if (lines[0] !== 'JASC-PAL' || lines[1] !== '0100' || !/^\d+$/.test(lines[2])) throw new Error('This is not a JASC palette.');
      const n = Number(lines[2]); if (n < 1 || n > 256 || lines.length < n+3) throw new Error('This JASC palette has an invalid colour count or is truncated.');
      colours = lines.slice(3,3+n).map(l=> { if (!/^\d+\s+\d+\s+\d+$/.test(l.trim())) throw new Error('A JASC colour needs three whole numbers.'); return l.trim().split(/\s+/).map(Number); });
      const tail = lines.slice(3+n); if (tail.some(l => !l.startsWith('#'))) throw new Error('This JASC palette has unexpected trailing data.');
      const record = tail.find(l=>l.startsWith('# '+signature)); if (record) native = JSON.parse(record.slice(signature.length+2));
    } else if (format === 'riff') {
      if (b.length < 12 || dec(b.slice(0,4)) !== 'RIFF' || dec(b.slice(8,12)) !== 'PAL ' || u32(b,4)+8 !== b.length) throw new Error('This RIFF palette is truncated or has an invalid header.');
      let p = 12;
      while (p < b.length) { if (p+8 > b.length) throw new Error('Truncated RIFF chunk.'); const tag = dec(b.slice(p,p+4)), size = u32(b,p+4); p += 8; if (p+size+(size%2) > b.length) throw new Error('Truncated RIFF chunk.');
        if (tag === 'data') { if (colours || size < 4) throw new Error('Invalid RIFF palette data.'); const v = new DataView(b.buffer,b.byteOffset+p,size), n = v.getUint16(2,true); if (v.getUint16(0,true) !== 768 || n < 1 || n > 256 || size !== 4+n*4) throw new Error('RIFF colour count does not match the data.'); colours = Array.from({length:n},(_,i)=> { if(b[p+7+i*4]) throw new Error('RIFF entry flags are not supported.'); return Array.from(b.slice(p+4+i*4,p+7+i*4)); }); }
        if (tag === 'c3wd') { const s = dec(b.slice(p,p+size)); if (native || !s.startsWith(signature)) throw new Error('Invalid native RIFF palette record.'); native = JSON.parse(s.slice(signature.length)); } p += size+(size%2);
      } if (!colours) throw new Error('This RIFF palette has no colours.');
    } else if (format === 'gpl') {
      const lines = dec(b).replace(/^\uFEFF/,'').split(/\r?\n/);
      if ((lines[0] || '').trim() !== 'GIMP Palette') throw new Error('This is not a GIMP palette (it should start with GIMP Palette).');
      colours = [];
      for (const line of lines.slice(1)) { const t = line.trim(); if (!t || /^(Name|Columns):/i.test(t)) continue; if (t[0] === '#') { if (t.startsWith('# ' + signature)) native = JSON.parse(t.slice(signature.length + 2)); continue; }
        const m = /^(\d+)\s+(\d+)\s+(\d+)/.exec(t); if (!m || [m[1],m[2],m[3]].some(n => +n > 255)) throw new Error('A GIMP palette line needs three numbers from 0 to 255: ' + t.slice(0,40)); colours.push([+m[1],+m[2],+m[3]]); }
      if (!colours.length || colours.length > 256) throw new Error('A GIMP palette needs 1 to 256 colours.');
      /* PalMod leaves out pen 0; a full row's worth of colours includes it. */
      if (native && native.length === colours.length + 1) colours.unshift(R.expanded(native[0]));
      else if (!native && (!options.size || colours.length === options.size - 1)) colours.unshift([0,0,0]);
    } else if (format === 'gif' || format === 'bmp' || (format === 'png' && pngHeight(b) !== 1)) {
      colours = imageTable(b);
      if (options.size && colours.length > options.size) colours = colours.slice(0, options.size);
    } else if (format === 'png') {
      const adapter = pngAdapter || g.ArtPng; if (!adapter || typeof adapter.read !== 'function') throw new Error('PNG palette strips await the ArtPng reader from lane U3.');
      const image = await adapter.read(b);
      if (image.height !== 1 || image.width < 1 || image.width > 256) throw new Error('A palette strip must be one pixel high and 1 to 256 pixels wide.');
      if (image.palette && image.pens) colours = Array.from(image.pens,p=>image.palette[p]);
      else if (image.rgba) colours = Array.from({length:image.width},(_,i)=>Array.from(image.rgba.slice(i*4,i*4+4)));
      else throw new Error('ArtPng returned no indexed or RGBA pixels.');
      const record = readPngRecord(b); if (record) { if (!record.startsWith(signature)) throw new Error('Invalid native PNG palette record.'); native = JSON.parse(record.slice(signature.length)); }
    } else throw new Error('This palette format is not supported.');
    return metadata(native,colours,options);
  }
  const api = { read, write, snap, jsonRead, setPng(adapter) { pngAdapter = adapter; }, hasPng() { return !!(pngAdapter || g.ArtPng); } };
  g.ArtPalFmt = api; if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
