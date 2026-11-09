(function(root,factory){const api=factory();if(typeof module==='object')module.exports=api;else root.ArtDoc=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  function integer(n,name){if(!Number.isInteger(n)||n<1)throw new Error(name+' must be a positive integer.');return n;}
  function pens(input,length){if(input.length!==length)throw new Error('Wrong pixel count.');for(const p of input)if(!Number.isInteger(p)||p<0||p>63)throw new Error('Pens must be 0 to 63.');return Uint8Array.from(input);}
  function copy(v){if(ArrayBuffer.isView(v))return v.slice();if(Array.isArray(v))return v.map(copy);if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,copy(x)]));return v;}
  function addLayer(d,kind='paint',name='Paint',options={}){
    if(!['paint','reference'].includes(kind))throw new Error('Unknown layer kind.');
    const id='layer-'+d.nextLayer,l={...copy(options),id,name,kind,visible:options.visible??true,locked:options.locked??false};
    if(kind==='paint')l.pixels=pens(options.pixels||new Uint8Array(d.width*d.height),d.width*d.height);
    else {l.width=integer(options.width??d.width,'Reference width');l.height=integer(options.height??d.height,'Reference height');l.offset=copy(options.offset||{x:0,y:0});l.opacity=options.opacity??1;if(!Number.isFinite(l.opacity)||l.opacity<0||l.opacity>1)throw new Error('Reference opacity must be 0 to 1.');l.rgba=Uint8Array.from(options.rgba||new Uint8Array(l.width*l.height*4));if(l.rgba.length!==l.width*l.height*4)throw new Error('Wrong reference size.');}
    d.layers.push(l);d.nextLayer++;return l;
  }
  function create(o={}){
    const width=integer(o.width??64,'Width'),height=integer(o.height??96,'Height'),pixels=pens(o.pixels||new Uint8Array(width*height),width*height);
    const d={width,height,origin:copy(o.origin||{x:width/2,y:height-1}),hash:o.hash||'',layers:[],nextLayer:1,ownedTiles:copy(o.ownedTiles||[]),original:pixels.slice(),selection:null};
    if(!Number.isFinite(d.origin.x)||!Number.isFinite(d.origin.y)||d.origin.x<0||d.origin.x>=width||d.origin.y<0||d.origin.y>=height)throw new Error('Origin must be inside the canvas.');
    addLayer(d,'paint','Paint',{pixels});
    const rgba=new Uint8Array(width*height*4);for(let i=0;i<pixels.length;i++){const c=o.palette?.[pixels[i]]||[pixels[i]*4,pixels[i]*4,pixels[i]*4,255];rgba.set([c[0],c[1],c[2],pixels[i]?c[3]??255:0],i*4);}
    addLayer(d,'reference','Original',{rgba,visible:false,locked:true});return d;
  }
  // Guide layers (another sprite laid under the drawing) are never part of the sprite.
  function flatten(d){const b=new Uint8Array(d.width*d.height);for(const l of d.layers)if(l.kind==='paint'&&l.visible&&!l.guide){pens(l.pixels,b.length);for(let i=0;i<b.length;i++)if(l.pixels[i])b[i]=l.pixels[i];}return b;}
  function tiles(d,b=flatten(d)){if(b.length!==d.width*d.height)throw new Error('Wrong pixel count.');const out=[];for(let ty=0;ty<Math.ceil(d.height/16);ty++)for(let tx=0;tx<Math.ceil(d.width/16);tx++){let filled=false;scan:for(let y=ty*16;y<Math.min(d.height,(ty+1)*16);y++)for(let x=tx*16;x<Math.min(d.width,(tx+1)*16);x++)if(b[y*d.width+x]){filled=true;break scan;}if(filled)out.push({x:tx,y:ty});}return out;}
  function serial(v){if(ArrayBuffer.isView(v))return [...v];if(Array.isArray(v))return v.map(serial);if(v&&typeof v==='object')return Object.fromEntries(Object.keys(v).sort().map(k=>[k,serial(v[k])]));return v;}
  function project(){return {sprites:Object.create(null),paletteEdits:[],imports:[]};}
  function mergeDown(d,index){const top=d.layers[index],bottom=d.layers.slice(0,index).findLast(l=>l.kind==='paint'&&!l.guide);if(!top||!bottom||top.kind!=='paint'||top.locked||bottom.locked)throw new Error('Merge needs two unlocked paint layers.');if(top.visible){if(!bottom.visible)bottom.pixels.fill(0);for(let i=0;i<top.pixels.length;i++)if(top.pixels[i])bottom.pixels[i]=top.pixels[i];bottom.visible=true;}d.layers.splice(index,1);return bottom;}
  return {create,addLayer,flatten,tiles,copy,serial,pens,project,mergeDown};
});
