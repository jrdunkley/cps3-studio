/* Installed Infinite stage banks. The user's program supplies every colour.
 * Original-SH2 copy/refresh evidence: cps3_studio/checks/g_stage_variants.py. */
(function(g){
 'use strict';
 const get=(n,p)=>g[n]||(typeof require==='function'&&require(p)),P=get('ArtPalette','./palette'),Rom=get('Cps3Rom','../../studio_kit/core/cps3rom');
 const BASE=0x06000000,TABLE=0x06F20100,DATA=0x06F21000,SIZE=0x1200;
 const handlers=[[0x06F20000,172,'3944db73938583af51d4418d4f4e02b427009fb79b65b8b639b3e60bf35c4109'],[0x06EE4E00,156,'98ca296700aa403bbee292a8af119809095b3e5afb75574649d3ab68021347ff']];
 const labels=['Oro dusk','Oro round 1','Oro round 2','Oro round 3','Oro round 4','Oro night','Garage'];
 const cache=new WeakMap();
 function reader(program){if(!(program instanceof Uint8Array)||program.length!==0x1000000)throw new Error('A complete program image is required.');const v=new DataView(program.buffer,program.byteOffset,program.byteLength),at=(a,n)=>{if(!Number.isInteger(a)||a<BASE||a+n>BASE+program.length)throw new Error('Stage colour source is outside program ROM.');return a-BASE;};return {word:a=>v.getUint16(at(a,2)),long:a=>v.getUint32(at(a,4)),at};}
 /* A release whose stage colour hook or handlers differ from the verified ones reads as having no installed variants
    (nothing is listed or written); unavailable(program) says why. */
 const unknown=new WeakMap();
 function layout(program){const r=reader(program),hook=r.long(0x060D4F44);if(hook===0x06137DF0)return null;if(hook!==0x06F61438){unknown.set(program,'its stage colour hook ('+hook.toString(16).toUpperCase()+') is code the Studio has not verified');return null;}
  for(const [at,n,hash]of handlers)if(Rom.sha256Js(program.subarray(at-BASE,at-BASE+n))!==hash){unknown.set(program,'its installed stage colour copy or refresh handler differs from the verified one');return null;}
  return {table:TABLE,count:7,size:SIZE,handlers,progression:{stage:9,first:2,last:6},defaults:{21:7}};
 }
 function catalogue(program,{fresh=false}={}){if(!fresh&&cache.has(program))return cache.get(program);const r=reader(program),runtime=layout(program),records=[],sources=new Map();
  if(runtime)for(let i=0;i<7;i++){const at=TABLE+i*32,stage=program[at-BASE+20],expectedStage=i<6?9:21,selectors=i<6?[223,224]:[194,209];if(stage!==expectedStage)throw new Error('The installed stage colour identity has changed.');
   const size=r.long(at+16);if(size!==SIZE)throw new Error('The installed stage bank geometry has changed.');
   const record={variant:i+1,stage,label:labels[i],size,banks:[]};
   for(let b=0;b<2;b++){const native=P.descriptor(program,selectors[b]),requestSource=r.long(at+b*4),source=r.long(at+8+b*4),destination=b?0x14000:0x4000;
    if(requestSource!==native.source||native.size!==size||native.destination!==destination||source!==DATA+i*SIZE*2+b*SIZE)throw new Error('The installed stage bank source or destination has changed.');r.at(source,size);const rows=[];
    for(let off=0;off<size;off+=128){const address=source+off,words=Array.from({length:64},(_,p)=>r.word(address+p*2)),use={variant:i+1,stage,bank:b,row:(destination+off)/128};if(sources.has(address))throw new Error('Installed stage bank sources overlap.');sources.set(address,{source:address,words,uses:[use]});rows.push({source:address,row:use.row,words,space:'program',family:'stage-variant',mode:'state'});}
    record.banks.push({bank:b,source,requestSource,destination,size,rows});
   }records.push(record);
  }const result={runtime,records,sources};cache.set(program,result);return result;
 }
 function select(program,{stage,chosen=0,losses=[0,0],magic=true,fade=0}={}){if(!Number.isInteger(stage)||stage<0||stage>22||!Number.isInteger(chosen)||chosen<0||chosen>7||!Array.isArray(losses)||losses.length!==2||losses.some(n=>!Number.isInteger(n)||n<0||n>255)||typeof magic!=='boolean'||!Number.isInteger(fade))throw new Error('Choose a stage, variant and two byte-sized loss counts.');const cat=catalogue(program);if(!cat.runtime||!magic||fade!==0)return null;const variant=chosen||(stage===9?2+Math.min(losses[0]+losses[1],4):stage===21?7:0);return cat.records.find(r=>r.variant===variant)||null;}
 function choices(program,stage){if(!Number.isInteger(stage)||stage<0||stage>22)throw new Error('Choose stage 0 to 22.');return [{variant:0,label:'Round rule'},...catalogue(program).records.filter(r=>r.stage===stage).map(({variant,label})=>({variant,label}))];}
 function resolve(program,edits=[]){if(!Array.isArray(edits))throw new Error('Stage colour edits must be a list.');if(!edits.length)return [];const cat=catalogue(program,{fresh:true}),seen=new Set();return edits.map(edit=>{const row=cat.sources.get(edit?.source);if(!row||seen.has(edit.source)||!Array.isArray(edit.changes)||!edit.changes.length)throw new Error('Stage colour changes need distinct known program rows.');seen.add(edit.source);const words=row.words.slice(),pens=new Set();for(const c of edit.changes){if(!c||!Number.isInteger(c.pen)||c.pen<0||c.pen>=64||pens.has(c.pen)||c.before!==row.words[c.pen]||!Number.isInteger(c.after)||c.after<0||c.after>65535||c.after===c.before)throw new Error('A stage colour change has an invalid pen or source precondition.');if((c.after&0x8000)!==(c.before&0x8000))throw new Error('A stage colour change alters a flag bit.');pens.add(c.pen);words[c.pen]=c.after;}return {source:edit.source,words,uses:row.uses,changedWords:pens.size};});}
 function apply(program,edits=[]){const rows=resolve(program,edits);if(!rows.length)return {program,changes:[]};const output=program.slice(),v=new DataView(output.buffer);for(const row of rows)row.words.forEach((w,i)=>v.setUint16(row.source-BASE+i*2,w));return {program:output,changes:rows};}
 function delta(program,rows){const cat=catalogue(program),edits=[],seen=new Set();for(const row of rows){const original=cat.sources.get(row.source),words=Array.from(row.words||[]);if(!original||words.length!==64||seen.has(row.source))throw new Error('Stage colours need distinct known 64-word sources.');seen.add(row.source);const changes=[];words.forEach((after,pen)=>{const before=original.words[pen];if(after!==before)changes.push({pen,before,after});});if(changes.length)edits.push({source:row.source,changes});}resolve(program,edits);return edits.sort((a,b)=>a.source-b.source);}
 function unavailable(program){return layout(program)?null:unknown.get(program)||null;}
 const api={layout,unavailable,catalogue,select,choices,resolve,apply,delta};g.ArtStageColours=api;if(typeof module!=='undefined')module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
