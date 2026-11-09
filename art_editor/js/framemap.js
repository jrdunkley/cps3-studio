/* ArtFrameMap: mapping and tile-aware placement; never changes source size. */
(function(g){
  'use strict';
  const P=typeof module!=='undefined'?require('./png'):g.ArtPng;
  function match(sources,targets,{mode='order',manifest=[]}={}){const pairs=[],s=new Set(),t=new Set();
    const add=(source,target)=>{if(!Number.isInteger(source)||source<0||source>=sources.length||!Number.isInteger(target)||target<0||target>=targets.length||s.has(source)||t.has(target)) throw new Error('Each source and target frame must be joined at most once, within the frame lists.');pairs.push({source,target});s.add(source);t.add(target);};
    if(mode==='manifest') for(const p of manifest) add(p.source,p.target);
    else if(mode==='order') for(let i=0;i<Math.min(sources.length,targets.length);i++) add(i,i);
    else if(mode==='name'||mode==='number'){const key=f=>mode==='number'?String(f.number??f.spriteId??''):String(f.name??f.number??f.spriteId??'');for(let i=0;i<sources.length;i++){const k=key(sources[i]);if(!k) continue;const candidates=targets.map((f,j)=>key(f)===k&&!t.has(j)?j:-1).filter(j=>j>=0);if(candidates.length>1) throw new Error('More than one target frame has the name or number '+k+'. Join these frames yourself.');if(candidates.length) add(i,candidates[0]);}}
    else throw new Error('Choose matching by order, name or manifest.');
    return {pairs,unmatchedSources:sources.map((_,i)=>i).filter(i=>!s.has(i)),unmatchedTargets:targets.map((_,i)=>i).filter(i=>!t.has(i))};
  }
  function place(source,target,{alignment='feet',offset={x:0,y:0},trim=false,reference=false}={}) {
    source={...source,pens:source.pens??source.pixels};for(const f of [source,target]) if(!Number.isSafeInteger(f.width)||!Number.isSafeInteger(f.height)||f.width<1||f.height<1||f.width*f.height>P.MAX_PIXELS) throw new Error('Every frame needs its original width and height, within the picture size limit.');
    if(reference&&!source.rgba&&source.pens&&source.palette) source.rgba=P.toRgba(source.pens,source.palette);
    if(reference?!source.rgba:!source.pens) throw new Error(reference?'A reference frame needs its original RGBA picture.':'Match the picture’s colours to pens before placing it.');
    if(source.pens&&source.pens.length!==source.width*source.height||source.rgba&&source.rgba.length!==source.width*source.height*4) throw new Error('The frame pixels do not match its original size.');
    let x,y;if(alignment==='origin'){if(!source.origin||!target.origin) throw new Error('Both frames need an origin to align by origin.');x=target.origin.x-source.origin.x;y=target.origin.y-source.origin.y;}
    else if(alignment==='feet'){x=Math.floor(target.width/2)-Math.floor(source.width/2);y=target.height-source.height;}
    else if(alignment==='centre'){x=Math.floor(target.width/2)-Math.floor(source.width/2);y=Math.floor(target.height/2)-Math.floor(source.height/2);}else throw new Error('Choose Origin, Feet or Centre.');
    x+=offset.x??0;y+=offset.y??0;if(!Number.isSafeInteger(x)||!Number.isSafeInteger(y)) throw new Error('Offsets must use whole pixels.');
    const tiles=target.storedTiles??target.ownedTiles?.map(t=>({x:t.x*16,y:t.y*16}));if(tiles?.some(t=>!Number.isSafeInteger(t.x)||!Number.isSafeInteger(t.y)||t.x%16||t.y%16)) throw new Error('Stored tiles must start on whole 16-pixel boundaries.');
    const owned=tiles?new Set(tiles.map(t=>`${t.x},${t.y}`)):null;
    const inside=(xx,yy)=>owned?owned.has(`${Math.floor(xx/16)*16},${Math.floor(yy/16)*16}`):xx>=0&&yy>=0&&xx<target.width&&yy<target.height;
    const pens=source.pens?.slice(),rgba=source.rgba?.slice(),overflow=new Uint8Array(source.width*source.height),extra=new Set();let overflowPixels=0;
    if(pens) P.validatePens(pens);
    for(let p=0;p<overflow.length;p++){const painted=reference?rgba?.[p*4+3]>0:pens?pens[p]!==0:rgba?.[p*4+3]>0;if(!painted) continue;const xx=x+p%source.width,yy=y+Math.floor(p/source.width);if(!inside(xx,yy)){overflow[p]=1;overflowPixels++;extra.add(`${Math.floor(xx/16)*16},${Math.floor(yy/16)*16}`);if(trim){if(pens) pens[p]=0;if(rgba) rgba.fill(0,p*4,p*4+4);}}}
    const extraTiles=[...extra].map(s=>{const [x,y]=s.split(',').map(Number);return {x,y};}).sort((a,b)=>a.y-b.y||a.x-b.x);
    return {width:source.width,height:source.height,pens:reference?undefined:pens,rgba:reference?rgba:undefined,offset:{x,y},origin:source.origin,overflow,report:{pixelCount:overflow.length,overflowPixels,extraTiles,extraTileCount:extra.size,extraPixelBytes:reference?0:extra.size*192,trimmedPixels:trim?overflowPixels:0,trim:!!trim,roomVerified:!!target.roomVerified,roomBytes:target.roomBytes??null,reference:!!reference}};
  }
  const api={match,place};g.ArtFrameMap=api;if(typeof module!=='undefined') module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
