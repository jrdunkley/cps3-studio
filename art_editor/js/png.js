/* ArtPng: byte-preserving PNG, no colour correction or resampling.
 * read(bytes) / write({width,height,pens,palette,origin}|{width,height,rgba,origin}) are async.
 * Indexed 1/2/4/8-bit, grey 1/2/4/8-bit, RGB/grey-alpha/RGBA 8-bit; Adam7 and all filters.
 * 16-bit input is refused rather than losing precision. APNG is always refused.
 */
(function(g) {
  'use strict';
  const SIGN=Uint8Array.of(137,80,78,71,13,10,26,10), MAX_PIXELS=16777216;
  const PASSES=[[0,0,8,8],[4,0,8,8],[0,4,4,8],[2,0,4,4],[0,2,2,4],[1,0,2,2],[0,1,1,2]];
  class PngError extends Error { constructor(s) {super(s);this.name='PngError';} }
  const fail=s=>{throw new PngError(s);};
  function bytes(b) {if(b instanceof ArrayBuffer) return new Uint8Array(b);if(b instanceof Uint8Array) return new Uint8Array(b.buffer,b.byteOffset,b.byteLength);return fail('Give the bytes of a PNG picture.');}
  function size(w,h) {if(!Number.isSafeInteger(w)||!Number.isSafeInteger(h)||w<1||h<1||w*h>MAX_PIXELS) fail('This picture has an invalid size or more than 16,777,216 pixels.');}
  const TABLE=Uint32Array.from({length:256},(_,n)=>{let c=n;for(let k=0;k<8;k++) c=c&1?(c>>>1)^0xedb88320:c>>>1;return c>>>0;});
  function crc(b) {let c=-1;for(const n of b) c=TABLE[(c^n)&255]^(c>>>8);return (c^-1)>>>0;}
  function concat(a) {const out=new Uint8Array(a.reduce((n,b)=>n+b.length,0));let p=0;for(const b of a){out.set(b,p);p+=b.length;}return out;}
  function chunk(type,b) {const out=new Uint8Array(b.length+12),v=new DataView(out.buffer);v.setUint32(0,b.length);for(let i=0;i<4;i++) out[4+i]=type.charCodeAt(i);out.set(b,8);v.setUint32(out.length-4,crc(out.subarray(4,-4)));return out;}
  async function codec(b,encode,max) {
    if(typeof module!=='undefined' && typeof require==='function') {const z=require('zlib');try{return new Uint8Array(encode?z.deflateSync(b):z.inflateSync(b,{maxOutputLength:max}));}catch(_){return fail('This PNG is damaged: its compressed pixels cannot be read.');}}
    const C=encode?g.CompressionStream:g.DecompressionStream;if(!C) fail('This browser cannot read and write PNG pixels. Use a current browser.');
    try {const stream=new Blob([b]).stream().pipeThrough(new C('deflate')),reader=stream.getReader(),parts=[];let n=0;
      while(true){const r=await reader.read();if(r.done) break;n+=r.value.length;if(max&&n>max){await reader.cancel();fail('This PNG has more pixel data than its size allows.');}parts.push(r.value);}return concat(parts);
    }catch(e){if(e instanceof PngError) throw e;return fail('This PNG is damaged: its compressed pixels cannot be read.');}
  }
  function validatePens(pens) {const bad=[...new Set(Array.from(pens).filter(p=>!Number.isInteger(p)||p<0||p>63))].sort((a,b)=>a-b);if(bad.length) fail('This picture uses pens '+bad.join(', ')+'. The game has pens 0 to 63. Match its colours before importing.');}
  function toRgba(pens,palette) {const out=new Uint8Array(pens.length*4);for(let i=0;i<pens.length;i++){const p=palette[pens[i]];if(!p) fail('This picture uses a pen missing from its palette.');out.set([p[0],p[1],p[2],p[3]===undefined?(pens[i]?255:0):p[3]],i*4);}return out;}
  function alphaReport(rgba) {let partial=0,transparent=0;for(let i=3;i<rgba.length;i+=4){if(rgba[i]===0) transparent++;else if(rgba[i]!==255) partial++;}return {pixelCount:rgba.length/4,partialAlphaPixels:partial,transparentPixels:transparent,warnings:partial?[`${partial.toLocaleString('en')} pixels have partial alpha. Keep as a reference or choose how to make them opaque or see-through.`]:[]};}
  async function read(input) {
    const b=bytes(input);if(b.length<8||SIGN.some((v,i)=>b[i]!==v)) fail('This file is not a PNG picture, or it is cut short.');
    const view=new DataView(b.buffer,b.byteOffset,b.byteLength),chunks=[],seen=new Set();let head,plte,trns,origin,p=8,end=false,idatClosed=false;
    while(p<b.length){if(p+12>b.length) fail('This PNG is cut short.');const n=view.getUint32(p);if(n>b.length-p-12) fail('This PNG is cut short.');const type=String.fromCharCode(...b.subarray(p+4,p+8)),d=b.subarray(p+8,p+8+n);
      if(!/^[A-Za-z]{4}$/.test(type)) fail('This PNG has an invalid chunk name.');if(crc(b.subarray(p+4,p+8+n))!==view.getUint32(p+8+n)) fail('This PNG is damaged: a chunk checksum does not match.');
      if(['acTL','fcTL','fdAT'].includes(type)) fail('This is an animated PNG. Export its frames as separate PNG pictures or a sprite sheet.');
      if(!head&&type!=='IHDR') fail('This PNG is missing its size header.');
      if(['IHDR','PLTE','tRNS','IEND'].includes(type)&&seen.has(type)) fail('This PNG repeats a required chunk.');
      if(type==='IHDR'){if(n!==13) fail('This PNG has a damaged size header.');head=d.slice();}
      else if(type==='PLTE'){if(chunks.length||trns||!n||n%3||n>768) fail('This PNG has a damaged palette.');plte=d.slice();}
      else if(type==='tRNS'){if(chunks.length) fail('This PNG puts transparency after its pixels.');trns=d.slice();}
      else if(type==='IDAT'){if(idatClosed) fail('This PNG separates its pixel chunks.');chunks.push(d);}
      else {if(chunks.length) idatClosed=true;if(type==='IEND'){if(n!==0||!chunks.length) fail('This PNG is missing pixels or has a damaged end.');end=true;p+=12;break;}
        if(type==='tEXt'){const z=d.indexOf(0);if(z>0&&String.fromCharCode(...d.subarray(0,z))==='cps3:origin'){const s=String.fromCharCode(...d.subarray(z+1));if(!/^-?\d+,-?\d+$/.test(s)) fail('This PNG has an invalid origin.');const [x,y]=s.split(',').map(Number);if(!Number.isSafeInteger(x)||!Number.isSafeInteger(y)) fail('This PNG has an invalid origin.');origin={x,y};}}
        else if(type[0]===type[0].toUpperCase()) fail('This PNG uses an unsupported required chunk: '+type+'.');
      }
      seen.add(type);p+=n+12;
    }
    if(!end||p!==b.length) fail('This PNG is cut short or has data after its end.');
    const hv=new DataView(head.buffer),width=hv.getUint32(0),height=hv.getUint32(4),depth=head[8],type=head[9],interlace=head[12];size(width,height);
    if(depth===16) fail('This picture uses 16-bit colours. Export an 8-bit PNG to avoid silently losing colour precision.');
    const channels={0:1,2:3,3:1,4:2,6:4}[type];if(!channels||!([0,3].includes(type)?[1,2,4,8]:[8]).includes(depth)||head[10]||head[11]||interlace>1) fail('This PNG has an unsupported pixel format.');
    if(type===3&&(!plte||plte.length/3>(1<<depth)||trns&&trns.length>plte.length/3)) fail('This PNG has an invalid or missing palette.');
    if(trns&&((type===0&&trns.length!==2)||(type===2&&trns.length!==6)||[4,6].includes(type))) fail('This PNG has invalid transparency.');
    const palette=plte?Array.from({length:plte.length/3},(_,i)=>[...plte.subarray(i*3,i*3+3),trns&&i<trns.length?trns[i]:255]):undefined;
    const passes=(interlace?PASSES:[[0,0,1,1]]).map(([x,y,dx,dy])=>({x,y,dx,dy,w:Math.max(0,Math.ceil((width-x)/dx)),h:Math.max(0,Math.ceil((height-y)/dy))})).filter(p=>p.w&&p.h);
    const expected=passes.reduce((n,p)=>n+(1+Math.ceil(p.w*channels*depth/8))*p.h,0),raw=await codec(concat(chunks),false,expected);if(raw.length!==expected) fail('This PNG has the wrong amount of pixel data.');
    const pens=type===3?new Uint8Array(width*height):undefined,rgba=new Uint8Array(width*height*4),bpp=Math.max(1,Math.ceil(channels*depth/8));let at=0;
    const tv=trns?new DataView(trns.buffer):null;
    for(const pass of passes){const rowBytes=Math.ceil(pass.w*channels*depth/8);let prev=new Uint8Array(rowBytes);
      for(let y=0;y<pass.h;y++){const filter=raw[at++];if(filter>4) fail('This PNG has an invalid pixel filter.');const row=raw.slice(at,at+rowBytes);at+=rowBytes;
        for(let x=0;x<rowBytes;x++){const a=x>=bpp?row[x-bpp]:0,b=prev[x],c=x>=bpp?prev[x-bpp]:0,q=a+b-c,pa=Math.abs(q-a),pb=Math.abs(q-b),pc=Math.abs(q-c);row[x]=(row[x]+[0,a,b,Math.floor((a+b)/2),pa<=pb&&pa<=pc?a:pb<=pc?b:c][filter])&255;}
        for(let x=0;x<pass.w;x++){const dest=(pass.y+y*pass.dy)*width+pass.x+x*pass.dx;let pixel;
          if(type===3||type===0){const v=(row[Math.floor(x*depth/8)]>>(8-depth-x*depth%8))&((1<<depth)-1);if(type===3){if(!palette[v]) fail('This picture uses a pen missing from its palette.');pens[dest]=v;pixel=palette[v];}else{const grey=v*255/((1<<depth)-1);pixel=[grey,grey,grey,tv&&tv.getUint16(0)===v?0:255];}}
          else {const q=x*channels;if(type===6) pixel=row.subarray(q,q+4);else if(type===4) pixel=[row[q],row[q],row[q],row[q+1]];else pixel=[row[q],row[q+1],row[q+2],tv&&[0,1,2].every(i=>tv.getUint16(i*2)===row[q+i])?0:255];}rgba.set(pixel,dest*4);
        }prev=row;
      }
    }
    if(pens) validatePens(pens);
    return {width,height,pens,palette,rgba,origin,bitDepth:depth,interlaced:!!interlace,report:alphaReport(rgba)};
  }
  async function write(image) {
    const {width,height,origin}=image;size(width,height);const indexed=image.pens!==undefined;let pixels,palette;
    if(indexed){validatePens(image.pens);pixels=bytes(image.pens);if(pixels.length!==width*height) fail('The pen count does not match the picture size.');palette=image.palette;if(!Array.isArray(palette)||palette.length<1||palette.length>256||palette.some(p=>!Array.isArray(p)||p.length<3||p.some(n=>!Number.isInteger(n)||n<0||n>255))) fail('Give a palette of whole RGB or RGBA bytes.');if(pixels.some(p=>p>=palette.length)) fail('This picture uses a pen missing from its palette.');}
    else{pixels=bytes(image.rgba);if(pixels.length!==width*height*4) fail('The colour count does not match the picture size.');}
    const head=new Uint8Array(13),hv=new DataView(head.buffer);hv.setUint32(0,width);hv.setUint32(4,height);head[8]=8;head[9]=indexed?3:6;
    const parts=[SIGN,chunk('IHDR',head)];if(indexed){parts.push(chunk('PLTE',Uint8Array.from(palette.flatMap(p=>p.slice(0,3)))));parts.push(chunk('tRNS',Uint8Array.from(palette.map((p,i)=>p[3]===undefined?(i?255:0):p[3]))));}
    if(origin){if(!Number.isSafeInteger(origin.x)||!Number.isSafeInteger(origin.y)) fail('The origin must use whole pixels.');parts.push(chunk('tEXt',new TextEncoder().encode('cps3:origin\0'+origin.x+','+origin.y)));}
    const stride=width*(indexed?1:4),raw=new Uint8Array((stride+1)*height);for(let y=0;y<height;y++) raw.set(pixels.subarray(y*stride,(y+1)*stride),y*(stride+1)+1);
    parts.push(chunk('IDAT',await codec(raw,true)),chunk('IEND',new Uint8Array()));return concat(parts);
  }
  const api={read,write,toRgba,validatePens,alphaReport,PngError,MAX_PIXELS};g.ArtPng=api;if(typeof module!=='undefined') module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
