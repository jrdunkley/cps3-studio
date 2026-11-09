/* B2's initial ROM tables. Fixed allocation is a viewing coordinate system,
 * never permission to install or a prediction of the game's camera/scheduler. */
(function(g) {
  'use strict';
  const Codec=typeof module!=='undefined'?require('./codec6.js'):g.ArtCodec6;
  const Palette=typeof module!=='undefined'?require('./palette.js'):g.ArtPalette;
  const BASE=0x06000000, DATA=0x00400000;
  const staticIds=[0,1,2,4,5,6,9,11,12,13,16,17,18];
  function readers(program) {
    if(!(program instanceof Uint8Array)||program.length!==0x1000000)throw new Error('16 MiB sfiii3nr1 program required.');
    const v=new DataView(program.buffer,program.byteOffset,program.byteLength);
    const at=(a,n)=>{if(!Number.isSafeInteger(a)||a<BASE||a+n>BASE+program.length)throw new Error('Stage table outside program.');return a-BASE;};
    return {u16:a=>v.getUint16(at(a,2)),u32:a=>v.getUint32(at(a,4)),at};
  }
  function selectedIndex(program,id,area=0) {
    if(!Number.isInteger(id)||id<0||id>22||!Number.isInteger(area)||area<0||area>2)throw new Error('Stage identity must be 0–22 and area 0–2.');
    return readers(program).u16(0x0619d8d0+id*6+area*2);
  }
  function recipe(program,index) {
    if(!Number.isInteger(index)||index<0||index>22)throw new Error('Physical stage index must be 0–22.');
    const {u16,u32}=readers(program),count=u16(0x0619c1f0+index*2),blank=u32(0x0619d038+index*4);
    if(count<1||count>3)throw new Error('Unsupported layer count.');
    const low=(u16(0x0619cf1e+index*2)+u16(0x0619de30+index*2))&65535,blocks=[],bases=[];
    for(let layer=0;layer<count;layer++) {
      const base=0x30000+layer*0x4000;bases.push(base);
      for(const off of [0,64,128,192,4096,4160,4224,4288])blocks.push({source:blank,destination:base+off,high_add:0x3c40,low_add:low});
      const pointer=u32(0x06614f40+layer*4),n=u16(0x0619cf66+index*6+layer*2);
      for(let k=0;k<n;k++)blocks.push({source:blank+u32(pointer+k*8+4)*1024,destination:base+u32(pointer+k*8),high_add:0x3c40,low_add:low});
    }
    const palettes=[0x0619de02,0x0619ddd4].map(a=>{const selector=u16(a+index*2),address=0x061b4754+selector*12;return {selector,source:u32(address),destination:u32(address+4),length:u32(address+8),fade:0};});
    return {physicalIndex:index,map_bases:bases,map_blocks:blocks,tile_uploads:[{mode:2,source:u32(0x0619cbbc+index*16)*2,table:u32(0x0619cbb4+index*16)*2,destination:0x1e2000,length:(u32(0x0619cbb8+index*16)+1)*16}],palette_uploads:palettes};
  }
  function availability(id) {
    if(!Number.isInteger(id)||id<0||id>22)throw new Error('Stage identity must be 0–22.');
    return {available:true,static:staticIds.includes(id),rule:id===20?'Initial layers only. The later reconstruction gate fails because earlier lighting positions are needed.':id>=21?'Initial layers only. The two bonus scenes were only seen black.':staticIds.includes(id)?'Initial static layers only. Camera, decorations, other rounds and variants are not reconstructed.':'Initial layers only. Moving parts and lighting need the game’s timing and controls.'};
  }
  function decode(program,data,id,{physical=false}={}) {
    selectedIndex(program,id);
    if(!(data instanceof Uint8Array)||data.length!==0x4000000)throw new Error('64 MiB graphics image required.');
    const index=physical?id:selectedIndex(program,id),r=recipe(program,index),read=readers(program),maps=new Map(r.map_bases.map(b=>[b,new Uint8Array(0x4000)]));
    for(const block of r.map_blocks)for(let y=0;y<16;y++)for(let x=0;x<16;x++) {
      const dest=block.destination+(y*64+x)*4,base=dest&~0x3fff,map=maps.get(base);
      if(!map)throw new Error('Map copy outside initial allocation.');
      const src=block.source+(y*16+x)*4,v=new DataView(map.buffer);
      v.setUint16(dest-base,(read.u16(src)+block.high_add)&65535);v.setUint16(dest-base+2,(read.u16(src+2)+block.low_add)&65535);
    }
    const upload=r.tile_uploads[0],sp=upload.source-DATA,tp=upload.table-DATA;
    if(sp<0||sp>=data.length||tp<0||tp+256>data.length||upload.destination+upload.length+63>0x800000)throw new Error('Stage upload outside graphics or video memory.');
    const decoded=Codec.decode(data.subarray(sp),data.slice(tp,tp+256),upload.length),palette=new Map();
    for(const bank of r.palette_uploads){const bytes=Palette.sourceBytes(data,bank.source,bank.length);for(let i=0;i<bytes.length;i+=2)palette.set(bank.destination+i,bytes[i]*256+bytes[i+1]);}
    return {id,physicalIndex:index,recipe:r,maps,pens:decoded.pixels,penBase:upload.destination,sourceConsumed:decoded.sourceConsumed,palette,rule:physical&&id===18?'Unchecked. This stored stage picture was never seen to load.':availability(id).rule};
  }
  function layer(decoded,number,{words=null,modes=null,addresses=false}={}) {
    const map=[...decoded.maps.values()][number];if(!map)throw new Error('Choose an existing stage layer.');
    const v=new DataView(map.buffer,map.byteOffset,map.byteLength),pixels=new Uint8Array(1024*1024*4),missing=new Set(),colours=addresses?new Uint32Array(1024*1024).fill(0xFFFFFFFF):null;
    for(let j=0;j<4096;j++) {
      const cell=v.getUint32(j*4),tile=cell>>>17,bits=cell&512?6:8,pal=(cell&511)<<bits;
      for(let y=0;y<16;y++)for(let x=0;x<16;x++) {
        const p=tile*256+(cell&0x800?15-y:y)*16+(cell&0x1000?15-x:x)-decoded.penBase;
        const pen=p>=0&&p<decoded.pens.length?decoded.pens[p]:0;if(!pen)continue;
        const address=(pal+pen)*2,word=words?.get(address)??decoded.palette.get(address);
        // B2's atlas explicitly leaves cells with unknown colours transparent.
        // Keep their missing word addresses as facts; this is never a complete scene.
        if(word===undefined){missing.add(address);continue;}
        const at=((Math.floor(j/64)*16+y)*1024+(j%64*16+x))*4;pixels.set([...Palette.rgb(word,modes?.get(address)||'dma'),255],at);if(colours)colours[at/4]=address;
      }
    }
    return {width:1024,height:1024,rgba:pixels,...(colours?{colourAddresses:colours}:{}),missingPaletteWords:[...missing].sort((a,b)=>a-b)};
  }
  /* A map atlas crop, with explicit order/pan. This is an optional reference,
     not an arcade camera or animation reconstruction. */
  function backdrop(decoded,{x=0,y=0,width=384,height=224,order=[...decoded.maps.keys()].map((_,i)=>i).reverse(),camera=null}={}) {
    /* camera (js/stage_camera.js): each layer at the game's own scroll on its own screen lines, in the machine's draw order */
    if(camera){const rgba=new Uint8Array(width*height*4);for(const c of camera.layers){const atlas=layer(decoded,c.layer).rgba;for(let py=Math.max(0,c.from);py<=Math.min(height-1,c.to);py++){const ay=(py+c.y)&1023;for(let px=0;px<width;px++){const src=(ay*1024+((px+c.x)&1023))*4;if(atlas[src+3])rgba.set(atlas.subarray(src,src+4),(py*width+px)*4);}}}return {width,height,rgba,rule:'Initial layers where the game’s camera is at a round start (measured in the exact machine); stage objects, animation and lighting are not drawn.'};}
    if(![x,y,width,height].every(Number.isInteger)||width<1||height<1||x<0||y<0||x+width>1024||y+height>1024)throw new Error('Backdrop crop outside layer atlas.');
    const rgba=new Uint8Array(width*height*4);
    for(const n of order){const atlas=layer(decoded,n);for(let py=0;py<height;py++)for(let px=0;px<width;px++){const src=((y+py)*1024+x+px)*4;if(atlas.rgba[src+3])rgba.set(atlas.rgba.subarray(src,src+4),(py*width+px)*4);}}
    return {width,height,rgba,rule:'Reference crop of initial layers; game camera and draw order are not predicted.'};
  }
  function timeline(){throw new Error('Stage animation and lighting schedules are not reconstructed. Use initial layers only.');}
  const api={staticIds,initialIds:Array.from({length:23},(_,i)=>i),selectedIndex,recipe,availability,decode,layer,backdrop,timeline};g.ArtStage=api;if(typeof module!=='undefined')module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
