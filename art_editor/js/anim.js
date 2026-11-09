/* Native animation tables. Physical records are not executable reachability. */
(function(g) {
  'use strict';
  const BASE=0x06000000, names=['Gill','Alex','Ryu','Yun','Dudley','Necro','Hugo','Ibuki','Elena','Oro','Yang','Ken','Sean','Urien','Akuma','Shin Akuma','Chun-Li','Makoto','Q','Twelve','Remy'];
  const sections='nmca dmca btca caca cuca atca saca exca cbca yuca stxy mvxy sernd ovct ovix rict hiit boda hana cata caua atta hosa atit'.split(' ');
  function reader(program) {if(!(program instanceof Uint8Array)||program.length!==0x1000000)throw new Error('16 MiB program required.');return new DataView(program.buffer,program.byteOffset,program.byteLength);}
  function frame(program,address,size) {
    const v=reader(program),a=address-BASE; if(![4,8,16,24].includes(size)||a<0||a+size>program.length)throw new Error('Frame address/stride outside supported domain.');
    const r={duration:v.getUint8(a),event_type:v.getUint8(a+1),sound_selector:v.getUint16(a+2)>>>4,priority:(v.getUint16(a+2)>>>2)&3,flip:v.getUint16(a+2)&3};
    if(size>=8)Object.assign(r,{overlap_index:v.getUint16(a+4)>>>4,jump_offset_selector:v.getUint16(a+4)&15,cel_index:v.getUint16(a+6)});
    if(size>=16){const w=v.getUint32(a+8);Object.assign(r,{signed_attack_selector:w>>22,collision_index:(w>>>13)&511,meoshi_bits:w&8191,unknown_0c:v.getUint8(a+12),unknown_0d:v.getUint8(a+13),effect_initializer:v.getUint8(a+14),effect_argument:v.getUint8(a+15)});}
    if(size>=24)Object.assign(r,{unknown_10:v.getUint16(a+16),rival_catch_index:v.getUint16(a+18),step_word_index:v.getUint16(a+20),next_record:v.getUint8(a+22),status_update:v.getUint8(a+23)});
    return r;
  }
  function header(program,address) {const v=reader(program),a=address-BASE-8;return {stride_dwords:v.getInt16(a),pattern_status:v.getUint8(a+2),move_kind:v.getUint8(a+3),unknown_04:v.getUint8(a+4),unknown_05:v.getUint8(a+5),unknown_06:v.getUint8(a+6),unknown_07:v.getUint8(a+7)};}
  function characters(program) {
    const v=reader(program);return names.map((name,id)=>{const charset=v.getUint8(0x195b90+id);if(charset>=24)throw new Error('Native charset outside reviewed table.');const roots={};sections.forEach((s,i)=>roots[s]=v.getUint32(0x18b148+charset*108+i*4));roots.prot=v.getUint32(0x5fbf40+id*4);return {id,name,charset,roots};});
  }
  function animations(program,character,section) {
    const v=reader(program),chars=characters(program),ch=chars[character];if(!ch)throw new Error('Character must be 0..20.');
    const anchors=new Set([BASE+program.length,0x0634f028]);for(let row=0;row<24;row++)for(let col=0;col<24;col++){const p=v.getUint32(0x18b148+row*108+col*4);if(p>=BASE&&p<BASE+program.length)anchors.add(p);}for(const c of chars)anchors.add(c.roots.prot);
    const ordered=[...anchors].sort((a,b)=>a-b),out=[];
    for(const s of sections.slice(0,10).filter(s=>!section||s===section)){
      const start=ch.roots[s],end=ordered.find(a=>a>start);if(!end||start<BASE)throw new Error('Unbounded animation section.');
      const pointers=[];let at=start;
      while(at+4<=end){const p=v.getUint32(at-BASE);at+=4;if(!p)break;if(p<at+8||p>=end)throw new Error('Malformed animation pointer table.');pointers.push(p);}
      if(v.getUint32(at-BASE-4)!==0)throw new Error('No animation pointer terminator.');
      const streams=[...new Set(pointers)].sort((a,b)=>a-b);
      for(let slot=0;slot<pointers.length;slot++) {const p=pointers[slot],h=header(program,p),physicalEnd=streams[streams.indexOf(p)+1]-8||end,size=h.stride_dwords*4;
        out.push({character,section:s,slot,address:p,header:h,stride:size,physicalEnd,aliases:pointers.map((x,i)=>x===p?i:null).filter(x=>x!==null),records:()=>records(program,p,size,physicalEnd),scope:'physical stream; command paths require game context'});
      }
    }return out;
  }
  function records(program,start,stride,end) {
    const v=reader(program),out=[];if(![4,8,16,24].includes(stride))return [{type:'unknown',address:start,end,reason:'Unsupported stride'}];
    for(let a=start,n=1;a+stride<=end;a+=stride,n++) {const code=v.getUint16(a-BASE);if(code>=256)out.push({type:'frame',address:a,recordNumber:n,fields:frame(program,a,stride)});else if(code<141&&stride>=8){const operands=[v.getInt16(a-BASE+2),v.getInt16(a-BASE+4),v.getInt16(a-BASE+6)];out.push({type:'command',address:a,recordNumber:n,opcode:code,operands,raw:program.slice(a-BASE,a-BASE+stride)});}else{out.push({type:'unknown',address:a,end,reason:'Unassigned stream tail'});break;}}
    return out;
  }
  function timeline(animation,program) {
    const frames=[];let ticks=0,stop=null;
    for(const r of animation.records()) {if(r.type!=='frame'){stop={address:r.address,reason:'Command or unknown record requires runtime context'};break;}const f=r.fields;if(f.cel_index==null){stop={address:r.address,reason:'Short frame has no cel field'};break;}
      frames.push({spriteId:f.cel_index,duration:f.duration,startTick:ticks,flip:f.flip,offset:{x:null,y:null},unknown:Object.fromEntries(Object.entries(f).filter(([k])=>k.startsWith('unknown_'))),fields:f});ticks+=f.duration;
    }return {frames,ticks,rate:59.59949,complete:stop===null,stop};
  }
  const api={characters,animations,frame,header,records,timeline};g.ArtAnim=api;if(typeof module!=='undefined')module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
