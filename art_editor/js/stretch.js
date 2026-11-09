/* Stretch (10-29): a drawing made taller by repeating whole rows inside chosen bands, the way the CPS3 sprite hardware scales a
   sprite (FBNeo cps3run.cpp cps3_drawgfxzoom_2: nearest neighbour, each screen row repeats a source row, no smoothing), but
   only inside the band and on the rows that show it least. Shared indexed row-stretch implementation. Buffers are pens 0..63 on a w x h canvas, 0 see-through.
   bands: [[top, bottom, add]] in canvas rows (inclusive). Everything above the first repeated row rises by the rows added;
   rows below the last repeated row stay (the feet stay on the floor); the canvas keeps its size, so the top rows must be empty.
   'clean' (default) picks the rows with the fewest 1-row marks (a painted pixel unlike the pixels above and below it: fold
   lines, hems, outline steps) summed over every frame given, never two side by side, pulled toward even spacing (integer
   scores, dynamic programming, ties to the earlier row); 'even' is the hardware's own spacing. */
(function(root,factory){const api=factory();if(typeof module==='object')module.exports=api;else root.ArtStretch=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  function marks(frames,w,h){const out=new Array(h).fill(0);
    for(const f of frames)for(let y=0;y<h;y++)for(let x=0;x<w;x++){const p=f[y*w+x];if(!p)continue;const up=y>0?f[(y-1)*w+x]:0,dn=y<h-1?f[(y+1)*w+x]:0;if(p!==up&&p!==dn)out[y]++;}
    return out;}
  function pickBand(cost,top,bottom,add,mode){const n=bottom-top+1;if(add<=0)return [];if(add>n)throw new Error('The band has '+n+' rows; it cannot repeat '+add+'.');
    if(mode==='even'){const r=[];for(let i=0;i<add;i++)r.push(top+Math.floor(n*(i+1)/(add+1)));return r;}
    const k1=add+1;let gap=Math.max(2,Math.floor(n*4/(5*k1)));if((add-1)*gap+1>n)gap=add>1?Math.max(1,Math.floor((n-1)/Math.max(1,add-1))):1;
    const score=(i,j)=>k1*cost[top+j]+3*Math.abs(k1*(top+j)-(k1*top+n*(i+1)));
    let dp=new Array(n);for(let j=0;j<n;j++)dp[j]=score(0,j);const back=[null];
    for(let i=1;i<add;i++){const nd=new Array(n).fill(null),bk=new Array(n).fill(-1);let best=null,bj=-1;
      for(let j=0;j<n;j++){const jp=j-gap;if(jp>=0&&dp[jp]!==null&&(best===null||dp[jp]<best)){best=dp[jp];bj=jp;}if(best!==null){nd[j]=best+score(i,j);bk[j]=bj;}}
      dp=nd;back.push(bk);}
    let v=null,j=-1;for(let q=0;q<n;q++)if(dp[q]!==null&&(v===null||dp[q]<v)){v=dp[q];j=q;}
    if(j<0)throw new Error('The band is too short to repeat '+add+' rows apart.');
    const rows=[j];for(let i=add-1;i>0;i--){j=back[i][j];rows.push(j);}
    return rows.map(r=>top+r).sort((a,b)=>a-b);}
  function pickRows(frames,w,h,bands,mode='clean'){const cost=marks(frames,w,h),rows=[];for(const [t,b,k] of bands)rows.push(...pickBand(cost,t,b,k,mode));
    if(new Set(rows).size!==rows.length)throw new Error('The bands overlap.');return rows.sort((a,b)=>a-b);}
  /* repeats each canvas row in rows once; returns a new buffer of the same type and size */
  function stretch(pixels,w,h,rows){const k=rows.length,set=new Set(rows);for(let i=0;i<k*w;i++)if(pixels[i])throw new Error('No room: the top '+k+' rows of the canvas are not empty.');
    const order=[];for(let y=0;y<h;y++){order.push(y);if(set.has(y))order.push(y);}
    const src=order.slice(k),out=new pixels.constructor(w*h);for(let y=0;y<h;y++)out.set(pixels.subarray(src[y]*w,src[y]*w+w),y*w);return out;}
  return {marks,pickBand,pickRows,stretch};
});
