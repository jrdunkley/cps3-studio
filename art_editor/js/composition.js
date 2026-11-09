/* 061384E0 scene-list grammar and GPU record projection. These are map-band
 * records, not stored sprite IDs. Reading a list grants no installer ownership.
 * Original instruction walk and differential gate: scene_constructor.c. */
(function(g){
  'use strict';
  const BASE=0x06000000,LIMIT=0x07000000,s16=n=>(n<<16)>>16;
  function parse(program,address,{maxWords=4096,maxGroups=8}={}){
    if(!(program instanceof Uint8Array)||program.length!==0x1000000)throw new Error('A 16 MiB program image is required.');
    if(!Number.isInteger(address)||address<0||address>0xFFFFFFFF||address%2)throw new Error('Composition address must be an aligned unsigned address.');
    if(!Number.isInteger(maxWords)||maxWords<1||maxWords>32768||!Number.isInteger(maxGroups)||maxGroups<0||maxGroups>16383)throw new Error('Invalid composition read bounds.');
    const physical=(address&~0x20000000)>>>0;
    if(physical<BASE||physical>=LIMIT)throw new Error('Composition is outside program ROM.');
    const view=new DataView(program.buffer,program.byteOffset,program.byteLength),words=[],groups=[];let elements=0;
    function next(){if(words.length>=maxWords)throw new Error('Composition exceeds its word bound.');const at=physical-BASE+words.length*2;if(at+2>program.length)throw new Error('Composition ends outside program ROM.');const w=view.getUint16(at);words.push(w);return w;}
    for(let header=next();header!==0xFFFF;header=next()){
      if(groups.length>=maxGroups)throw new Error('Composition exceeds its group bound.');
      const group={address:physical+(words.length-1)*2,header,scroll:header&7,priority:s16(next()),bands:[]};
      for(let y=next();y!==0xFFFF;y=next()){
        const band={address:physical+(words.length-1)*2,y,sizeWord:next(),flags:next()};group.bands.push(band);elements++;
      }groups.push(group);
    }
    return {address:physical,end:physical+words.length*2,words,groups,elements};
  }
  function project(list,slot,start=0){
    if(!list||!Array.isArray(list.groups)||!Number.isInteger(slot)||slot<0||slot>0xFFFFFFFF||!Number.isInteger(start)||start<0||start>0x7FFF)throw new Error('Invalid composition projection.');
    let n=0;const groups=list.groups.map((group,i)=>{
      const first=n,bands=group.bands.map(band=>{
        const size=(((band.sizeWord<<16)>>>0)|((slot&3)<<4)|(band.flags&15))>>>0;n++;
        return {address:band.address,cell:0,position:band.y,size,xSize:size&3,ySize:(size>>>2)&3,map:(size>>>4)&3,width:((size>>>16)&127)+1,height:((size>>>24)&127)+1};
      });
      return {address:group.address,offset:(i*20)&255,command:((group.scroll<<12)+bands.length)&65535,start:(start+first)&65535,x:0,y:0,priority:group.priority,enabled:1,bands};
    });
    return {slot,slotOffset:s16(slot*168),groups,elements:n,allocationUnits:Math.trunc(s16(n)/16)+1};
  }
  const api={parse,project};g.ArtComposition=api;if(typeof module!=='undefined')module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
