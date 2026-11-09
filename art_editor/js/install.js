/* Same-shape, fixed-table replacement. No relocation or padding allocation. */
(function(g){
  'use strict';
  const get=(name,file)=>g[name]||(typeof require==='function'&&require(file)),Cel=get('ArtCel','./cel.js'),Codec=get('ArtCodec6','./codec6.js'),Census=get('ArtCensus','./census.js');
  function install(resources,replacements,opts={}) {
    if(!Array.isArray(replacements)||!replacements.length)throw new Error('Choose at least one replacement.');
    const census=opts.census||new Census.Census(resources),program=resources.program.slice(),data=resources.data.slice(),edits=[],reports=[],touched=new Map();
    if(new Set(replacements.map(x=>x.index)).size!==replacements.length)throw new Error('Duplicate cel replacement.');
    for(const item of replacements){const c=resources.decode(item.index),pens=item.pens;
      if(!(pens instanceof Uint8Array)||pens.length!==c.pens.length||pens.some(p=>p>63))throw new Error('Replacement must preserve the exact allocation and six-bit pens.');
      if(pens.every((p,i)=>p===c.pens[i]))throw new Error('Replacement has no intended pixel change.');
      if(c.records.some(r=>!(r.attributes&512)))throw new Error('Only six-bit normal sprites are supported.');
      if(!(c.flags&32768))throw new Error('Cached-group replacement requires a proven resident-sharing method.');
      if(c.uploads.some(u=>u.destination+u.written>c.allocation))throw new Error('Upload tail lies outside the proven character allocation.');
      for(let i=0;i<pens.length;i++)if(!c.written[i]&&pens[i]!==c.pens[i])throw new Error('Replacement changes bytes outside existing uploads.');
      const report=census.forCel(item.index),table=data.subarray(c.table,c.table+256);let used=0,capacity=0;
      if(report.aliases.length!==1)throw new Error('Aliased index rows cannot be installed in-place.');
      const destinations=c.uploads.map(u=>[u.destination,u.destination+u.written]).sort((a,b)=>a[0]-b[0]);if(destinations.some((span,i)=>i&&destinations[i-1][1]>span[0]))throw new Error('Overlapping destination uploads require per-upload expectations.');
      for(const u of c.uploads){
        const old=resources.data.subarray(u.sourceOffset,u.sourceOffset+u.consumed),target=pens.subarray(u.destination,u.destination+u.written);
        if(c.pens.subarray(u.destination,u.destination+u.written).every((x,i)=>x===target[i]))continue;
        const overlaps=census.overlaps(u.sourceOffset,u.sourceOffset+u.consumed);if(overlaps.some(r=>r.kind==='table'||r.pointer!==c.pointer||r.upload.address!==u.address))throw new Error('Source is shared with another upload, cel or pair table.');
        if(u.sourceOffset<0x800000)throw new Error('Source overlaps the sound region.');
        const e=Codec.encodeFixed(target,table,u.requested);if(e.source.length>u.consumed)throw new Error('Replacement exceeds the original consumed source extent.');
        const got=Codec.decode(e.source,table,u.requested,u.written);if(got.pixels.length!==target.length||!got.pixels.every((x,i)=>x===target[i]))throw new Error('Replacement decode-back mismatch.');
        for(let i=0;i<e.source.length;i++){const at=u.sourceOffset+i;if(touched.has(at)&&touched.get(at)!==e.source[i])throw new Error('Replacements disagree in shared compressed bytes.');touched.set(at,e.source[i]);}
        data.set(e.source,u.sourceOffset);edits.push({region:'graphics',start:u.sourceOffset,end:u.sourceOffset+e.source.length,capacityEnd:u.sourceOffset+u.consumed,expected:Array.from(old.subarray(0,e.source.length)),replacement:Array.from(e.source),index:item.index,upload:c.uploads.indexOf(u)});used+=e.source.length;capacity+=u.consumed;
      }
      reports.push({index:item.index,aliases:report.aliases,sharing:report.sharedWith,capacityUsed:used,capacityLeft:capacity-used});
    }
    const patched=new Cel.Resources(program,data);for(const item of replacements){const actual=patched.decode(item.index);if(actual.pens.some((x,i)=>x!==item.pens[i]))throw new Error('Installed cel differs after all uploads.');}
    let changed=0;for(const [at]of touched)changed+=data[at]!==resources.data[at];
    return {program,data,edits,report:{method:'same-shape-fixed-table-in-place',programBytesChanged:0,graphicsBytesChanged:changed,items:reports,scope:'Cel-domain surgical replacement; in-game acceptance is the separate P1 AG7 gate.'}};
  }
  /* Map an assembled indexed canvas back into its existing cells. Conflicting
     aliases or overlapping cells are refused, never silently merged. */
  function replacement(resources,index,image){const c=resources.decode(index),base=Cel.assemble(c);if(image.width!==base.width||image.height!==base.height||image.pixels.length!==base.pixels.length)throw new Error('Same-shape replacement required; resizing is unavailable.');const pens=c.pens.slice(),assigned=new Map(),covered=new Uint8Array(image.pixels.length);
    for(const r of Cel.geometry(c))for(let col=0;col<r.nx;col++)for(let row=0;row<r.ny;row++)for(let y=0;y<16;y++)for(let x=0;x<16;x++){
      const px=r.left-base.bounds[0]+(r.attributes&4096?(r.nx-1-col)*16+15-x:col*16+x),py=r.top-base.bounds[1]+(r.attributes&2048?(r.ny-1-row)*16+15-y:row*16+y),i=py*base.width+px,at=(Math.floor(r.code/2)+col*r.ny+row)*256+y*16+x,pen=image.pixels[i];
      if(covered[i])throw new Error('Overlapping cells require an explicit per-cell replacement.');covered[i]=1;if(assigned.has(at)&&assigned.get(at)!==pen)throw new Error('Repeated tile receives conflicting pixels.');assigned.set(at,pen);pens[at]=pen;
    }for(let i=0;i<covered.length;i++)if(!covered[i]&&image.pixels[i])throw new Error('Pixels outside existing cells cannot be installed.');return {index,pens};
  }
  async function expectations(result,replacements,pensFiles,context={}) {
    const Rom=get('Cps3Rom','../../studio_kit/core/cps3rom.js'),items=[];
    for(const item of replacements){const file=pensFiles[item.index];if(typeof file!=='string'||!file)throw new Error('A saved full-pen file path is required for every replacement.');items.push({cel:item.index,pens_file:file,pens_sha256:await Rom.sha256(item.pens),uploads:[...new Set(result.edits.filter(e=>e.index===item.index).map(e=>e.upload))].sort((a,b)=>a-b)});}
    if(Object.keys(context).some(k=>!['episode','frames','animation','prediction_domain','limits'].includes(k)))throw new Error('Unsupported expectations field.');
    const frames=context.frames==null?1:context.frames;
    if(!Number.isSafeInteger(frames)||frames<=0||context.episode!=null&&typeof context.episode!=='string')throw new Error('Expectations need a positive whole frame count and an optional episode path.');
    return {schema:'cps3.art.p1.expectations.v1',frames,...(!context.episode?{limits:'Static-only manifest: frames=1 is an unused schema-required placeholder. No live episode, visibility or timing acceptance is asserted.'}:{}),...context,replacements:items};
  }
  /* Advanced paths stay behind the lead-owned ability registry. Candidate
     compaction is available through ArtRoom for private verification only. */
  function advanced(resources,id,args={},opts={}){
    const ids=['sprite.room','sprite.tiles','sprite.owncopy','sprite.new','sprite.origin'];
    if(!ids.includes(id))throw new Error('Unknown room method.');
    const Limits=get('ArtLimits','./limits.js');
    if(!Limits.allowed(id))throw new Error(Limits.reason(id));
    if(id!=='sprite.room')throw new Error('This record-editing method has no closed instruction and reference licence.');
    const Room=get('ArtRoom','./room.js'),planner=new Room.Planner(resources,opts),result=planner.plan(args.run,args.edits);
    if(!result.ok||!result.productLicence)throw new Error(result.reason||'Occupied run is not licensed under S1.');
    return Room.apply(resources.program,resources.data,result);
  }
  /* Stored colour rows: 64 big-endian words each (16 for HUD and Judgement faces), written in place in the
     graphics image. `sources` is a Set of 64-colour sources or a Map source -> colour count.
     Every row named must be a known stored source; aliases are one source, written once. */
  function palettes(data,edits,sources){
    const bySource=new Map(),written=[],size=s=>sources instanceof Map?sources.get(s):64;
    for(const e of edits||[]){const s=Number(e.source),w=Array.from(e.words);
      if(!sources.has(s))throw new Error('Unknown stored colour row.');if(w.length!==size(s))throw new Error('A colour row needs '+size(s)+' colours.');
      const prior=bySource.get(s);if(prior&&prior.some((x,i)=>x!==w[i]))throw new Error('Two different edits name one stored colour row.');bySource.set(s,w);}
    for(const [s,w]of bySource){const at=s-0x400000;let changed=0;
      for(let k=0;k<w.length;k++){const old=data[at+2*k]*256+data[at+2*k+1];if((w[k]&0x8000)!==(old&0x8000))throw new Error('A colour changes the flag bit the game keeps.');if(w[k]!==old){data[at+2*k]=w[k]>>>8;data[at+2*k+1]=w[k]&255;changed++;}}
      written.push({source:s,words:w,changedWords:changed});}
    return written;
  }
  const api={install,replacement,expectations,advanced,palettes,
    room:(r,a,o)=>advanced(r,'sprite.room',a,o),tiles:(r,a,o)=>advanced(r,'sprite.tiles',a,o),
    owncopy:(r,a,o)=>advanced(r,'sprite.owncopy',a,o),newSprite:(r,a,o)=>advanced(r,'sprite.new',a,o),
    origin:(r,a,o)=>advanced(r,'sprite.origin',a,o)};g.ArtInstall=api;if(typeof module!=='undefined')module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
