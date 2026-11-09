/* All exhaustive ownership, encoding and installation work stays off the canvas thread. */
importScripts('../../studio_kit/core/zip.js','../../studio_kit/core/cps3rom.js','../js/codec6.js','../js/cel.js','../js/census.js','../js/install.js','../js/limits.js','../js/png.js','../js/slice.js','../js/formats.js','../js/gill.js','../js/palette.js','../js/extendedcolours.js','../js/stagecolours.js','../js/gamecheck.js','../js/anim.js','../js/stage.js','../js/envelope.js','../js/delivery.js');
let ctx,project={sprites:{},paletteEdits:[]};
onmessage=async({data:m})=>{try{
  if(m.type==='init'){ctx=ArtDelivery.context(m.rom);ctx.frameUses=m.frameUses;ctx.paletteUses=m.paletteUses;ctx.domains=m.domains||ctx.domains;ctx.spriteChecks=new Map();if(m.limits)for(const x of m.limits)ArtLimits.set(x.id,x.state,x);postMessage({type:'ready'});}
  else if(m.type==='start'){project.sprites[m.id]=m.doc;ctx.spriteChecks.delete(m.id);}
  else if(m.type==='buffer'){const l=project.sprites[m.id].layers[m.layer];if(!l[m.field])l[m.field]=new Uint8Array(m.length);l[m.field].set(m.bytes,m.offset);}
  else if(m.type==='remove'){delete project.sprites[m.id];ctx.spriteChecks.delete(m.id);}
  else if(m.type==='check'){project.paletteEdits=m.paletteEdits||[];project.gillEdits=m.gillEdits||[];project.extendedColourEdits=m.extendedColourEdits||[];project.stageColourEdits=m.stageColourEdits||[];const check=ArtGameCheck.analyze(project,ctx);postMessage({type:'check',version:m.version,check:{...check,items:check.items.map(x=>({...x,replacements:null}))}});}
  else if(m.type==='build'){const r=await ArtDelivery.build(project,ctx);postMessage({type:'built',request:m.request,files:r.files,report:r.report},r.files.map(f=>f.bytes.buffer));}
}catch(e){postMessage({type:'error',version:m.version,request:m.request,message:e.message});}};
