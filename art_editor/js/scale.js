/* Scale (10-31): a selection, or whole rows and columns, made larger or smaller by repeating or dropping source lines, the way
   the CPS3 sprite hardware zooms a sprite (FBNeo cps3run.cpp cps3_drawgfxzoom_2: nearest neighbour, 16.16 fixed-point step from
   the top-left edge, no smoothing). The Move tool's handles on the selection drive it (studio/canvas.js, studio/edit.js).
   Shared indexed selection-scaling implementation. ROM-free; node-loadable.
   Buffers are pens 0..63 on a w x h canvas, 0 see-through. box = {x,y,w,h}; edge = {ex,ey}, each -1 (left/top edge dragged),
   0 (axis unchanged) or +1 (right/bottom edge dragged).
     cps3Map(n,N)   d = floor(n*65536/N); output line i reads source min(n-1, floor(i*d/65536)) - the emulator's own step
     cleanMap(...)  js/stretch.js picking: the |N-n| lines with the fewest 1-row marks, spread evenly (marks use the real
                    neighbours beyond the band); repeated when growing, dropped when shrinking; cps3Map when they do not fit
     applyScale     only the selection changes: resampled (pixels and mask), anchored at the edge opposite the dragged one,
                    pasted over the cleared selection; throws when the result leaves the canvas
     applyPush      whole rows (then columns) of the band; what lies beyond the dragged edge moves to make room, the other
                    side stays (push the top edge up = Stretch rows: everything above rises, the feet stay); lines pushed off
                    the canvas must be empty */
(function(root,factory){const St=typeof ArtStretch!=='undefined'?ArtStretch:(typeof require==='function'?require('./stretch.js'):null);const api=factory(St);if(typeof module==='object')module.exports=api;else root.ArtScale=api;})(typeof globalThis!=='undefined'?globalThis:this,function(St){
  'use strict';
  function range(n){const r=[];for(let i=0;i<n;i++)r.push(i);return r;}
  function cps3Map(n,N){const out=[];if(N<=0||n<=0)return out;const d=Math.floor(n*65536/N);for(let i=0;i<N;i++)out.push(Math.min(n-1,Math.floor(i*d/65536)));return out;}
  /* per band line (rows for axis y, columns for x): painted pixels unlike both neighbours along the axis, the real neighbours beyond the band when the frame has them, 0 beyond the frame; summed over the frames */
  function marksAxis(frames,w,h,axis,x0,y0,x1,y1){const n=axis==='x'?x1-x0+1:y1-y0+1,m=axis==='x'?y1-y0+1:x1-x0+1,L=axis==='x'?w:h,lo=axis==='x'?x0:y0,out=new Array(n).fill(0);
    for(const f of frames)for(let i=0;i<n;i++)for(let j=0;j<m;j++){const X=axis==='x'?x0+i:x0+j,Y=axis==='x'?y0+j:y0+i,p=f[Y*w+X];if(!p)continue;const k=lo+i;let a=0,b=0;
      if(axis==='x'){if(k>0)a=f[Y*w+X-1];if(k<L-1)b=f[Y*w+X+1];}else{if(k>0)a=f[(Y-1)*w+X];if(k<L-1)b=f[(Y+1)*w+X];}
      if(p!==a&&p!==b)out[i]++;}
    return out;}
  function cleanMap(frames,w,h,axis,x0,y0,x1,y1,N){const n=axis==='x'?x1-x0+1:y1-y0+1;if(N===n)return{map:range(n),clean:true};const k=Math.abs(N-n);let picked;
    try{picked=new Set(St.pickBand(marksAxis(frames,w,h,axis,x0,y0,x1,y1),0,n-1,k,'clean'));}catch(e){return{map:cps3Map(n,N),clean:false};}
    const map=[];for(let i=0;i<n;i++){if(N>n){map.push(i);if(picked.has(i))map.push(i);}else if(!picked.has(i))map.push(i);}return{map,clean:true};}
  function plan(frames,w,h,box,W,H,edge,opt={}){const push=opt.outside==='push';if(W<1||H<1)throw new Error('The selection cannot be smaller than one pixel.');
    if(opt.rows==='clean'){const rx0=push?0:box.x,rx1=push?w-1:box.x+box.w-1,r=H!==box.h?cleanMap(frames,w,h,'y',rx0,box.y,rx1,box.y+box.h-1,H):{map:range(box.h),clean:true};
      const cy0=push?0:box.y,cy1=push?h-1:box.y+box.h-1,c=W!==box.w?cleanMap(frames,w,h,'x',box.x,cy0,box.x+box.w-1,cy1,W):{map:range(box.w),clean:true};
      return{rowmap:r.map,colmap:c.map,rows_clean:r.clean,cols_clean:c.clean};}
    return{rowmap:cps3Map(box.h,H),colmap:cps3Map(box.w,W),rows_clean:false,cols_clean:false};}
  function applyScale(pixels,w,h,mask,box,W,H,edge,rowmap,colmap){const nx=edge.ex<0?box.x+box.w-W:box.x,ny=edge.ey<0?box.y+box.h-H:box.y;
    if(nx<0||ny<0||nx+W>w||ny+H>h)throw new Error('The scaled selection does not fit the canvas.');
    const out=pixels.slice(),om=new Uint8Array(w*h);for(let i=0;i<mask.length;i++)if(mask[i])out[i]=0;
    for(let j=0;j<H;j++){const sy=box.y+rowmap[j];for(let i=0;i<W;i++){const s=sy*w+box.x+colmap[i];if(!mask[s])continue;const o=(ny+j)*w+nx+i;out[o]=pixels[s];om[o]=1;}}
    return{pixels:out,mask:om,x:nx,y:ny,width:W,height:H};}
  function noRoom(axis,side,k){return new Error('No room: the '+side+' '+k+(axis==='y'?' rows':' columns')+' of the canvas are not empty.');}
  function pushAxis(src,w,h,axis,lo,hi,N,e,map){const L=axis==='y'?h:w,M=axis==='y'?w:h,n=hi-lo+1,k=N-n,out=new src.constructor(src.length);
    const get=(i,j)=>axis==='y'?src[i*w+j]:src[j*w+i],set=(i,j,v)=>{if(axis==='y')out[i*w+j]=v;else out[j*w+i]=v;},any=i=>{for(let j=0;j<M;j++)if(get(i,j))return true;return false;},copy=(d,s)=>{for(let j=0;j<M;j++)set(d,j,get(s,j));};
    if(e<0){if(lo-k<0)throw new Error('No room: the band would leave the canvas.');if(k>0)for(let s=0;s<k;s++)if(any(s))throw noRoom(axis,axis==='y'?'top':'left',k);
      for(let i=0;i<lo-k;i++){const s=i+k;if(s>=0&&s<lo)copy(i,s);}
      for(let t=0;t<N;t++)copy(lo-k+t,lo+map[t]);
      for(let i=hi+1;i<L;i++)copy(i,i);}
    else{if(lo+N>L)throw new Error('No room: the band would leave the canvas.');for(let i=0;i<lo;i++)copy(i,i);
      for(let t=0;t<N;t++)copy(lo+t,lo+map[t]);
      for(let i=hi+1;i<L;i++){const d=i+k;if(d>=0&&d<L)copy(d,i);else if(d>=L&&any(i))throw noRoom(axis,axis==='y'?'bottom':'right',k);}}
    return out;}
  function applyPush(pixels,w,h,box,W,H,edge,rowmap,colmap){let cur=pixels;
    if(H!==box.h&&edge.ey)cur=pushAxis(cur,w,h,'y',box.y,box.y+box.h-1,H,edge.ey,rowmap);
    if(W!==box.w&&edge.ex)cur=pushAxis(cur,w,h,'x',box.x,box.x+box.w-1,W,edge.ex,colmap);
    return cur===pixels?pixels.slice():cur;}
  return {cps3Map,marksAxis,cleanMap,plan,applyScale,applyPush};
});
