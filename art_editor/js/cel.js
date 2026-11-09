(function(g) {
  'use strict';
  const Codec = g.ArtCodec6 || (typeof require === 'function' && require('./codec6.js'));
  const BASE = 0x06000000, INDEX = 0x800000, DIMS = [8,1,2,4];
  function view(bytes) { if (!(bytes instanceof Uint8Array)) throw new Error('Byte image required.'); return new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength); }
  function dataOffset(word) { const at = ((word & 0x03ffffff) * 2) - 0x400000; if (at < 0 || at >= 0x4000000) throw new Error('Graphics address outside 64 MiB data image.'); return at; }
  class Resources {
    constructor(program, data) { if (program.length !== 0x1000000 || data.length !== 0x4000000) throw new Error('16 MiB program and 64 MiB graphics images required.'); this.program = program; this.data = data; this.v = view(program); }
    row(index) { if (!Number.isInteger(index) || index < 0 || index > 65535) throw new Error('Cel index must be unsigned 16-bit.'); const p = INDEX + index * 8; return { index, origin_x: this.v.getInt16(p), origin_y: this.v.getInt16(p+2), pointer: this.v.getUint32(p+4) }; }
    /* Every row whose pointer is a cel descriptor. A later build may store other data in index rows it does not use for
       cels (Infinite 1.07b keeps stage code and data in parts of rows 34752-65535): a row whose pointer does not lead to a
       well-formed descriptor inside the program and data images is not a cel, and is left out rather than failing. */
    descriptors() { const found = new Map(); for (let i=0;i<65536;i++) { const row=this.row(i); if (row.pointer && this.isCel(i, row)) { if (!found.has(row.pointer)) found.set(row.pointer,[]); found.get(row.pointer).push(i); } } return found; }
    isCel(index, row = this.row(index)) { if (!row.pointer) return false; if (!this.cels) this.cels = new Map(); if (this.cels.has(row.pointer)) return this.cels.get(row.pointer); let ok; try { this.descriptor(index); ok = true; } catch (e) { ok = false; } this.cels.set(row.pointer, ok); return ok; }
    descriptor(index) {
      const row = this.row(index); if (!row.pointer) throw new Error('Null cel index row.');
      const p = row.pointer-BASE, v=this.v; if (p < 0 || p+12 > this.program.length) throw new Error('Descriptor outside program image.');
      const flags=v.getUint16(p), capacity=v.getUint16(p+2), chunks=v.getUint16(p+4), count=v.getUint16(p+6), tableWord=v.getUint32(p+8), table=dataOffset(tableWord), allocation=((capacity>>>5)+1)*4096;
      if (p+12+8*(chunks+count)>this.program.length || table+256>this.data.length) throw new Error('Truncated cel descriptor/table.');
      const uploads=[], records=[];
      for (let i=0;i<chunks;i++) { const a=p+12+8*i, source=v.getUint32(a)&0x03ffffff, length=v.getUint16(a+4), dest=v.getUint16(a+6); uploads.push({ source, length, dest, sourceOffset:dataOffset(source), requested:(length+1)*16, destination:dest*16, address:BASE+a }); }
      for (let i=0;i<count;i++) { const a=p+12+chunks*8+i*8, y=v.getInt16(a+6); records.push({code:v.getUint16(a),attributes:v.getUint16(a+2),x:v.getInt16(a+4),y:((y+512)&1023)-512,shape:(y&65535)>>>12}); }
      return {...row,flags,capacity,chunks,count,tableWord,table,allocation,uploads,records,descriptorBytes:12+8*(chunks+count)};
    }
    decode(index) {
      const c=this.descriptor(index), pens=new Uint8Array(c.allocation+64), written=new Uint8Array(pens.length), table=this.data.subarray(c.table,c.table+256);
      for (const u of c.uploads) { if (u.destination>pens.length) throw new Error('Upload destination exceeds allocation.'); const got=Codec.decode(this.data.subarray(u.sourceOffset),table,u.requested,pens.length-u.destination); pens.set(got.pixels,u.destination); written.fill(1,u.destination,u.destination+got.pixels.length); u.consumed=got.sourceConsumed; u.written=got.pixels.length; }
      return {...c,pens,written};
    }
    image(index, opts={}) { return assemble(this.decode(index),opts); }
  }
  function geometry(c) {
    return c.records.map(r => { if (!(r.shape&3) || !(r.shape>>>2)) throw new Error('Tilemap/disabled record requires layer context.'); const nx=DIMS[r.shape&3],ny=DIMS[r.shape>>>2],width=nx*16,height=ny*16; return {...r,nx,ny,width,height,left:r.x+c.origin_x-width/2+1,top:r.y+c.origin_y-height/2-18}; });
  }
  function assemble(c, opts={}) {
    const parts=geometry(c), bounds=parts.length ? [Math.min(...parts.map(r=>r.left)),Math.min(...parts.map(r=>r.top)),Math.max(...parts.map(r=>r.left+r.width)),Math.max(...parts.map(r=>r.top+r.height))] : [0,0,1,1], width=bounds[2]-bounds[0],height=bounds[3]-bounds[1];
    if (width*height>16777216) throw new Error('Cel image exceeds bounded canvas size.');
    const pixels=new Uint8Array(width*height), paletteRows=new Uint16Array(width*height), bits=new Uint8Array(width*height);
    for (const r of parts) for(let col=0;col<r.nx;col++) for(let row=0;row<r.ny;row++) for(let y=0;y<16;y++) for(let x=0;x<16;x++) {
      const tile=(Math.floor(r.code/2)+col*r.ny+row)*256, at=tile+y*16+x; if(at>=c.pens.length)throw new Error('Cell samples outside allocation.'); const pen=c.pens[at]; if(!pen)continue;
      let px=r.left-bounds[0]+(r.attributes&4096 ? (r.nx-1-col)*16+15-x : col*16+x), py=r.top-bounds[1]+(r.attributes&2048 ? (r.ny-1-row)*16+15-y : row*16+y);
      if(opts.flipX)px=width-1-px;if(opts.flipY)py=height-1-py; const i=py*width+px;
      pixels[i]=pen;paletteRows[i]=(opts.paletteNumber||0)+(r.attributes&511);bits[i]=r.attributes&512?6:8;
    }
    return {width,height,pixels,paletteRows,bits,bounds,origin:[c.origin_x,c.origin_y],index:c.index,pointer:c.pointer};
  }
  function rgba(image, opts={}) {
    const out=new Uint8Array(image.pixels.length*4);
    for(let i=0;i<image.pixels.length;i++) {const pen=image.pixels[i];if(!pen)continue; let rgb;
      if(opts.paletteRam) { const n=((image.paletteRows[i]<<(image.bits[i]||6))|pen)*2;if(n+2>opts.paletteRam.length)throw new Error('Palette RAM index out of bounds.'); const w=opts.paletteRam[n]*256+opts.paletteRam[n+1],green=((w>>>5)&31)*8;rgb=[(w&31)*8,green|((green>>>5)&4),((w>>>10)&31)*8]; }
      else if(opts.palette) {if(pen*3+3>opts.palette.length)throw new Error('Pen missing from palette.');rgb=opts.palette.subarray(pen*3,pen*3+3);}
      else {const v=Math.min(255,Math.floor(pen*255/((1<<(image.bits[i]||6))-1)));rgb=[v,v,v];}
      out.set(rgb,i*4);out[i*4+3]=255;
    } return out;
  }
  const api={Resources,dataOffset,geometry,assemble,rgba};g.ArtCel=api;if(typeof module!=='undefined')module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
