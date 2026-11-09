/* Conditional occupied-run compaction. A candidate plan grants no ROM bytes. */
(function(g){
  'use strict';
  const get=(n,f)=>g[n]||(typeof require==='function'&&require(f)),Codec=get('ArtCodec6','./codec6.js'),Census=get('ArtCensus','./census.js');
  const equal=(a,b)=>a.length===b.length&&a.every((x,i)=>x===b[i]);
  function candidatePlan(program,data,run,streams,edits){
    const [lo,hi]=run;if(!Number.isInteger(lo)||!Number.isInteger(hi)||lo<0||hi>data.length||lo>=hi||lo%2)throw new Error('Invalid even-start occupied run');
    const rows=streams.slice().sort((a,b)=>a.sourceOffset-b.sourceOffset),replacements=new Map();let cursor=lo;
    for(const s of rows){if(s.sourceOffset!==cursor)throw new Error('Run has a gap or partial source overlap');cursor+=s.consumed;}
    if(cursor!==hi)throw new Error('Run is not exactly the original occupied extent');
    for(const e of edits){if(replacements.has(e.sourceOffset)||!rows.some(s=>s.sourceOffset===e.sourceOffset))throw new Error('Duplicate or outside-run edit');replacements.set(e.sourceOffset,e);}
    const patches=[],placements=[],v=new DataView(program.buffer,program.byteOffset,program.byteLength);cursor=lo;
    for(const s of rows){
      const table=data.subarray(s.table,s.table+256),old=Codec.decode(data.subarray(s.sourceOffset,s.sourceOffset+s.consumed),table,s.requested,s.written);
      if(old.sourceConsumed!==s.consumed||old.pixels.length!==s.written)throw new Error('Original parse extent changed');
      const target=replacements.has(s.sourceOffset)?new Uint8Array(replacements.get(s.sourceOffset).pixels):old.pixels;
      if(target.length!==s.written)throw new Error('Growth must retain decoded footprint');
      const packed=Codec.encodeFixed(target,table,s.requested).source;cursor+=cursor%2;
      if(cursor+packed.length>hi)throw new Error('Edited stream and run-mates exceed the occupied run');
      if(!equal(Codec.decode(packed,table,s.requested,s.written).pixels,target))throw new Error('Edited decode-back mismatch');
      patches.push({region:'graphics',start:cursor,expected:Array.from(data.subarray(cursor,cursor+packed.length)),replacement:Array.from(packed)});
      const fields=s.fields.slice().sort((a,b)=>a-b);
      if(cursor!==s.sourceOffset)for(const field of fields){const o=field-0x06000000;if(!Number.isInteger(o)||o<0||o+4>program.length)throw new Error('Invalid source field');const before=v.getUint32(o,false);
        if(2*(before&0x03ffffff)-0x400000!==s.sourceOffset)throw new Error('Stale source-field identity');
        const after=((before&0xfc000000)|((cursor+0x400000)/2))>>>0;
        patches.push({region:'program',start:o,expected:Array.from(program.subarray(o,o+4)),replacement:[after>>>24,(after>>>16)&255,(after>>>8)&255,after&255]});}
      placements.push({sourceOffset:s.sourceOffset,newSourceOffset:cursor,bytes:packed.length,fields});cursor+=packed.length;
    }
    return {run:[lo,hi],placements,patches,tail:[cursor,hi],productLicence:false};
  }
  function apply(program,data,result){const p=program.slice(),d=data.slice();for(const patch of result.patches){const image=patch.region==='program'?p:patch.region==='graphics'?d:null;if(!image)throw new Error('Invalid patch region');
      if(!equal(image.subarray(patch.start,patch.start+patch.expected.length),patch.expected))throw new Error('Stale patch');image.set(patch.replacement,patch.start);}return {program:p,data:d};}
  class Planner{
    constructor(resources,opts={}){this.resources=resources;this.census=opts.census||new Census.Census(resources);}
    plan(run,edits,opts={}){
      try{
        const [lo,hi]=run;
        if((opts.pendingRanges||[]).some(([a,b])=>a<hi&&lo<b))throw new Error('Run overlaps a command already queued in the start state');
        if((opts.protectedRanges||[]).some(([a,b])=>a<hi&&lo<b))throw new Error('Run overlaps an indexed producer source domain');
        const a=this.census.overlaps(lo,hi);if(a.some(r=>r.kind==='table'))throw new Error('Run overlaps a pair table');
        if(lo<0x800000)throw new Error('Run overlaps the protected sound window');
        const grouped=new Map();for(const r of a){if(r.kind!=='source'||r.start<lo||r.end>hi)throw new Error('Partial source overlap');
          const s={sourceOffset:r.start,consumed:r.consumed,table:this.census.byPointer.get(r.pointer).cel.table,requested:r.upload.requested,written:r.written,fields:[r.upload.address]};
          if(grouped.has(r.start)){const old=grouped.get(r.start);if(['consumed','table','requested','written'].some(k=>old[k]!==s[k]))throw new Error('Shared bytes have different parse contexts');old.fields.push(...s.fields);}else grouped.set(r.start,s);}
        if(!opts.experiment)throw new Error('S1 reader closure and the required game witness are not licensed.');
        const plan=candidatePlan(this.resources.program,this.resources.data,run,[...grouped.values()],edits);
        return {ok:true,classification:'experiment under S1',registryId:'sprite.room',...plan};
      }catch(e){return {ok:false,reason:e.message,registryId:'sprite.room',productLicence:false};}
    }
  }
  const api={Planner,candidatePlan,apply};g.ArtRoom=api;if(typeof module!=='undefined')module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
