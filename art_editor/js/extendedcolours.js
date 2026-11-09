/* Installed Infinite extra colours, where the installed handlers match the verified ones. Values come from the user's ROM.
 * Handler equality and execution: cps3_studio/checks/g_extended_palettes.py.
 * Direct palette writes use the state RGB conversion, including green expansion. */
(function(g){
 'use strict';
 const get=(n,p)=>g[n]||(typeof require==='function'&&require(p)),P=get('ArtPalette','./palette'),Rom=get('Cps3Rom','../../studio_kit/core/cps3rom');
 const BASE=0x06000000,N=33,BODY=0x06FC0000,EXROWS=0x06FD6000,CHORDS=0x06F00500,HAS=0x06F005A0;
 const handlers=[[0x06F00000,124,'f99602272cda621b109d34f0b030dd0408c099b183a3610329712eba14cb81f3'],[0x06F00100,464,'4670bafbfcbf6c1419e8e77bc1b12cc6231651d9d656ca1e878d53502a4f29bd'],[CHORDS,132,'26a447bec7fa7abf9e663c46ae38e7429bd349cf57d21031f86b8b8eb2751c99']];
 const baseMasks=[16,32,64,128,256,512,336],names=['LP','MP','HP','LK','MK','HK','LP + MK + HP'];
 const cache=new WeakMap(); // UI resources are immutable; compilers request a fresh read.
 function reader(program){if(!(program instanceof Uint8Array)||program.length!==0x1000000)throw new Error('A complete program image is required.');const v=new DataView(program.buffer,program.byteOffset,program.byteLength),at=(a,n)=>{if(!Number.isInteger(a)||a<BASE||a+n>BASE+program.length)throw new Error('Extra colour source is outside program ROM.');return a-BASE;};return {word:a=>v.getUint16(at(a,2)),long:a=>v.getUint32(at(a,4)),at};}
 /* A later Infinite release whose colour hooks or handlers differ from the verified ones reads as having no installed
    extra colours (nothing is listed or written); unavailable(program) says why, for the place the colours would show. */
 const unknown=new WeakMap();
 function parse(program){const r=reader(program),pick=r.long(0x0609F588),dma=r.long(0x060D5010);if(pick===0x060A28FE&&dma===0x06137DF0)return null;
  if(pick!==0x06F00000||dma!==0x06F00100)return 'its colour hooks are chained through code the Studio has not verified (selection '+pick.toString(16).toUpperCase()+', fighter colours '+dma.toString(16).toUpperCase()+')';
  for(const [at,n,hash]of handlers)if(Rom.sha256Js(program.subarray(at-BASE,at-BASE+n))!==hash)return 'its installed extra colour handler at '+at.toString(16).toUpperCase()+' differs from the verified one';
  for(let ch=0;ch<21;ch++)if(program[HAS-BASE+ch]!==Number(ch!==0&&ch!==15))return 'its extra colour character list differs from the verified one';
  return {count:N,body:BODY,extraRows:EXROWS,chords:CHORDS,has:HAS,handlers};
 }
 function layout(program){const v=parse(program);if(typeof v==='string'){unknown.set(program,v);return null;}return v;}
 function unavailable(program){return layout(program)?null:unknown.get(program)||null;}
 const chord=mask=>['LP','MP','HP','LK','MK','HK'].filter((_,i)=>mask&(16<<i)).join(' + ');
 function catalogue(program,{fresh=false}={}){if(!fresh&&cache.has(program))return cache.get(program);const r=reader(program),runtime=layout(program),records=[],sources=new Map();
  if(!runtime){const result={runtime:null,records,sources};cache.set(program,result);return result;}
  const add=(address,use)=>{r.at(address,128);if(!sources.has(address))sources.set(address,{source:address,words:Array.from({length:64},(_,p)=>r.word(address+p*2)),uses:[]});sources.get(address).uses.push(use);};
  for(let ch=0;ch<21;ch++)if(program[HAS-BASE+ch])for(let extra=0;extra<N;extra++){
   const mask=r.word(CHORDS+extra*4),base=baseMasks.indexOf(r.word(CHORDS+extra*4+2));if(base<0)throw new Error('Extra colour base mask is outside the native domain.');
   const at=EXROWS+(ch*N+extra)*8,source=r.long(at),destination=r.word(at+4),size=r.word(at+6),record={character:ch,colour:extra+7,extra:extra+1,mask,base,label:chord(mask),body:BODY+(ch*N+extra)*128,rows:[]};
   add(record.body,{character:ch,colour:record.colour,row:0,kind:'body-and-copy'});
   if(source){if(destination%128||size%128||!size||destination+size>0x800)throw new Error('Extra colour row descriptor is outside a fighter block.');r.at(source,size);for(let off=0;off<size;off+=128){record.rows.push({row:(destination+off)/128,source:source+off});add(source+off,{character:ch,colour:record.colour,row:(destination+off)/128,kind:'auxiliary'});}}
   else if(destination||size)throw new Error('Null extra colour row has nonzero geometry.');
   records.push(record);
  }const result={runtime,records,sources};cache.set(program,result);return result;
 }
 function choices(program,character){if(!Number.isInteger(character)||character<0||character>20)throw new Error('Choose character row 0 to 20.');return [...names.map((label,colour)=>({colour,label,base:colour,extra:0,mask:baseMasks[colour]})),...catalogue(program).records.filter(r=>r.character===character).map(({colour,label,base,extra,mask})=>({colour,label,base,extra,mask}))];}
 function character(program,data,options){const {character:ch,side,colour}=options||{};if(!Number.isInteger(colour)||colour<0)throw new Error('Choose a colour index.');
  if(colour<7)return P.character(program,data,options);
  const cat=catalogue(program),record=cat.records.find(r=>r.character===ch&&r.colour===colour);if(!record)throw new Error('This character has no extra colour at that index.');
  const native=P.character(program,data,{...options,colour:record.base}),r=reader(program),eligible=new Map();
  for(const load of native.loads){const low=load.destination&0x7FF;if(low%0x400===0&&load.size===128&&load.source<0x03340000)eligible.set(load.destination/128,record.body);
   const descriptor=EXROWS+(ch*N+record.extra-1)*8,src=r.long(descriptor),dst=r.word(descriptor+4),size=r.word(descriptor+6);
   if(src&&low===dst&&load.size===size)for(let off=0;off<size;off+=128)eligible.set((load.destination+off)/128,src+off);
  }
  const rows=native.rows.map(row=>{const source=eligible.get(row.row);if(source===undefined)return {...row,space:'data',mode:'dma'};const stored=cat.sources.get(source);if(!stored)throw new Error('Extra colour source was not enumerated.');const words=Uint16Array.from(stored.words);return {...row,source,space:'program',mode:'state',words,bytes:program.slice(source-BASE,source-BASE+128),palette:P.rgbaRow(words,'state')};});
  return {...native,...options,extra:record.extra,baseColour:record.base,mask:record.mask,label:record.label,rows,limits:'Installed extra colour sources. Direct body/copy/assist requests are verified; fades and native fallback rows retain their own writers.'};
 }
 function resolve(program,edits=[]){if(!Array.isArray(edits))throw new Error('Extra colour edits must be a list.');if(!edits.length)return [];
  const cat=catalogue(program,{fresh:true}),seen=new Set();return edits.map(edit=>{const row=cat.sources.get(edit?.source);if(!row||seen.has(edit.source)||!Array.isArray(edit.changes)||!edit.changes.length)throw new Error('Extra colour changes need distinct known program rows.');seen.add(edit.source);const words=row.words.slice(),pens=new Set();
   for(const c of edit.changes){if(!c||!Number.isInteger(c.pen)||c.pen<0||c.pen>=64||pens.has(c.pen)||c.before!==row.words[c.pen]||!Number.isInteger(c.after)||c.after<0||c.after>65535||c.after===c.before)throw new Error('An extra colour change has an invalid pen or source precondition.');if((c.after&0x8000)!==(c.before&0x8000))throw new Error('An extra colour change alters a flag bit.');pens.add(c.pen);words[c.pen]=c.after;}
   return {source:edit.source,words,uses:row.uses,changedWords:pens.size};});
 }
 function apply(program,edits=[]){const rows=resolve(program,edits);if(!rows.length)return {program,changes:[]};const output=program.slice(),v=new DataView(output.buffer);for(const row of rows)row.words.forEach((w,i)=>v.setUint16(row.source-BASE+i*2,w));return {program:output,changes:rows};}
 function delta(program,rows){const cat=catalogue(program),edits=[],seen=new Set();for(const row of rows){const original=cat.sources.get(row.source),words=Array.from(row.words||[]);if(!original||words.length!==64||seen.has(row.source))throw new Error('Extra colour rows need distinct known 64-word sources.');seen.add(row.source);const changes=[];words.forEach((after,pen)=>{const before=original.words[pen];if(after!==before)changes.push({pen,before,after});});if(changes.length)edits.push({source:row.source,changes});}resolve(program,edits);return edits.sort((a,b)=>a.source-b.source);}
 const api={layout,unavailable,catalogue,choices,character,resolve,apply,delta};g.ArtExtendedColours=api;if(typeof module!=='undefined')module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
