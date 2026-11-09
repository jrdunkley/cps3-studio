/* ArtMatch: deterministic CIE Lab (D65), Euclidean Delta E 1976.
 * convert(image, palette, {overrides:{'r,g,b,a':{pen,locked}}, dither:false,
 * alphaPolicy:'opaque'|'see-through'}) -> pens, exact report and Float32 difference per pixel.
 * Partial alpha needs a deliberate policy or per-colour assignment. Never inferred.
 */
(function(g){
  'use strict';
  const P=typeof module!=='undefined'?require('./png'):g.ArtPng;
  const BAYER=[0,8,2,10,12,4,14,6,3,11,1,9,15,7,13,5];
  function lab(rgb){const v=rgb.slice(0,3).map(n=>{n/=255;return n<=.04045?n/12.92:((n+.055)/1.055)**2.4;});const [r,b,c]=v;
    const f=n=>n>.008856?Math.cbrt(n):7.787*n+16/116;
    const x=f((r*.4124564+b*.3575761+c*.1804375)/.95047),y=f(r*.2126729+b*.7151522+c*.072175),z=f((r*.0193339+b*.119192+c*.9503041)/1.08883);return [116*y-16,500*(x-y),200*(y-z)];}
  function distance(a,b){const x=lab(a),y=lab(b);return Math.hypot(x[0]-y[0],x[1]-y[1],x[2]-y[2],((a[3]??255)-(b[3]??255))*100/255);}
  function colours(image){const rgba=image.rgba||P.toRgba(image.pens,image.palette);if(rgba.length!==image.width*image.height*4) throw new Error('The picture size and colour count do not agree.');const rows=new Map();for(let i=0;i<rgba.length;i+=4){const c=Array.from(rgba.subarray(i,i+4)),key=c.join(',');if(!rows.has(key)) rows.set(key,{key,rgba:c,count:0});rows.get(key).count++;}return [...rows.values()];}
  function convert(image,palette,opts={}) {
    if(!Array.isArray(palette)||palette.length!==64||palette.some(p=>!Array.isArray(p)||p.length<3||p.length>4||p.some(n=>!Number.isInteger(n)||n<0||n>255))) throw new Error('Give the game palette with exactly 64 RGB or RGBA byte entries.');
    const pal=palette.map((p,i)=>[...p.slice(0,3),i?255:0]);
    const rgba=image.rgba||P.toRgba(image.pens,image.palette),rows=colours(image),labs=pal.map(lab);
    const nearest=c=>{const l=lab(c);let best=1,score=Infinity;for(let p=1;p<64;p++){const d=Math.hypot(...l.map((n,i)=>n-labs[p][i]));if(d<score){best=p;score=d;}}return best;};
    for(const row of rows){const override=opts.overrides?.[row.key];let pen=typeof override==='number'?override:override?.pen;
      row.locked=!!override?.locked;row.overridden=pen!==undefined;
      if(pen!==undefined&&(!Number.isInteger(pen)||pen<0||pen>63)) throw new Error('Choose a pen from 0 to 63.');
      if(pen===undefined){if(row.rgba[3]===0) pen=0;else if(row.rgba[3]!==255){if(!['opaque','see-through'].includes(opts.alphaPolicy)) throw new Error('This picture has partial alpha. Keep it as a reference, make those pixels opaque, or assign them to See-through.');pen=opts.alphaPolicy==='see-through'?0:nearest(row.rgba);}else pen=nearest(row.rgba);}
      row.pen=pen;row.difference=distance(row.rgba,pal[pen]);
    }
    const packed=(b,p=0)=>(b[p]|b[p+1]<<8|b[p+2]<<16|b[p+3]<<24)>>>0;
    const byKey=new Map(rows.map(r=>{r.actualDifferences=[];r.changed=[];if(opts.dither&&!r.overridden&&!r.locked&&r.pen) r.ditherPens=BAYER.map(v=>nearest(r.rgba.map((n,k)=>k<3?Math.max(0,Math.min(255,n+(v-7.5)*2)):n)));return [packed(r.rgba),r];})),pens=new Uint8Array(image.width*image.height),difference=new Float32Array(pens.length),penCounts=Array(64).fill(0);let changedPixels=0,largestDifference=0;
    for(let i=0;i<pens.length;i++){const r=byKey.get(packed(rgba,i*4)),x=i%image.width,y=Math.floor(i/image.width),pen=r.ditherPens?r.ditherPens[(y%4)*4+x%4]:r.pen;
      if(r.actualDifferences[pen]===undefined){r.actualDifferences[pen]=distance(r.rgba,pal[pen]);r.changed[pen]=r.rgba.some((n,k)=>n!==pal[pen][k]);}
      pens[i]=pen;penCounts[pen]++;const d=r.actualDifferences[pen];difference[i]=d;largestDifference=Math.max(largestDifference,d);if(r.changed[pen]) changedPixels++;
    }
    for(const row of rows){delete row.actualDifferences;delete row.changed;delete row.ditherPens;}
    const report={pixelCount:pens.length,sourceColours:rows.length,usedPens:penCounts.filter(n=>n>0).length,penCounts,changedPixels,unchangedPixels:pens.length-changedPixels,largestDifference,colours:rows,partialAlphaPixels:P.alphaReport(rgba).partialAlphaPixels,dither:!!opts.dither,alphaPolicy:opts.alphaPolicy||null,distance:'CIE Lab D65, Delta E 1976 with alpha difference'};
    return {width:image.width,height:image.height,pens,palette:pal,difference,report};
  }
  function pensCompatible(image,palette){return !!image.pens&&image.palette.every((p,i)=>i<64&&p.every((v,k)=>v===(palette[i]?.[k]??(k===3?(i?255:0):undefined))))&&image.palette.every((p,i)=>(p[3]??255)===(i?255:0));}
  const api={convert,colours,distance,lab,pensCompatible};g.ArtMatch=api;if(typeof module!=='undefined') module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
