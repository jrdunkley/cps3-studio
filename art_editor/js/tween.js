/* Tween: rebuilds a region of a drawing from the drawings before and after it by moving their own pixels (block flow, no model).
   Indexed block flow; neighbours are aligned by their origins before tracking. Pens 0..63; 0 is transparent. */
(function(root,factory){const api=factory();if(typeof module==='object')module.exports=api;else root.ArtTween=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  function bbox(mask,w,h){let x0=w,y0=h,x1=-1,y1=-1;for(let i=0;i<mask.length;i++)if(mask[i]){const x=i%w,y=i/w|0;if(x<x0)x0=x;if(x>x1)x1=x;if(y<y0)y0=y;if(y>y1)y1=y;}return x1<0?null:{x0,y0,x1,y1};}
  /* pen -> material class: pens that show the same colour in this palette share a class; 0 (see-through) stays 0 */
  function colourClasses(palette){const cls=new Int32Array(64),seen=new Map();for(let p=1;p<Math.min(64,palette.length);p++){const key=Array.from(palette[p]).join(',');if(!seen.has(key))seen.set(key,seen.size+1);cls[p]=seen.get(key);}return cls;}
  /* the window mean as the reference computes it (scipy uniform_filter, mode constant): a vertical then a horizontal mean over 2 win + 1
     cells of a cw x ch crop, nothing beyond the crop counting, each pass rounded to float32 (out and tmp are Float32Arrays) so that exact
     ties between candidate shifts break exactly as measured */
  function mean32(src,cw,ch,win,out,tmp){const k=2*win+1;
    for(let x=0;x<cw;x++){let s=0;for(let y=0;y<win&&y<ch;y++)s+=src[y*cw+x];for(let y=0;y<ch;y++){if(y+win<ch)s+=src[(y+win)*cw+x];if(y-win-1>=0)s-=src[(y-win-1)*cw+x];tmp[y*cw+x]=s/k;}}
    for(let y=0;y<ch;y++){const row=y*cw;let s=0;for(let x=0;x<win&&x<cw;x++)s+=tmp[row+x];for(let x=0;x<cw;x++){if(x+win<cw)s+=tmp[row+x+win];if(x-win-1>=0)s-=tmp[row+x-win-1];out[row+x]=s/k;}}}
  const rint=x=>{const f=Math.floor(x),d=x-f;return d<0.5?f:d>0.5?f+1:(f%2===0?f:f+1);};   /* numpy rint: halves to even */
  /* the displacement of the region's content from prev to next: the offset at which next best matches prev's painted pixels inside the
     mask (pen equality); ties go to the smaller move; below minAgree the content is not found and (0, 0) is returned */
  function estimateShift(prev,nxt,mask,w,h,o={}){const R=o.search??10,minAgree=o.minAgree??0.25,ys=[],xs=[],pv=[];let ymin=h,ymax=-1,xmin=w,xmax=-1;
    for(let i=0;i<mask.length;i++)if(mask[i]&&prev[i]){const y=i/w|0,x=i%w;ys.push(y);xs.push(x);pv.push(prev[i]);if(y<ymin)ymin=y;if(y>ymax)ymax=y;if(x<xmin)xmin=x;if(x>xmax)xmax=x;}
    if(!pv.length)return{dx:0,dy:0,agree:0};
    const y0=Math.max(0,ymin-R),y1=Math.min(h,ymax+R+1),x0=Math.max(0,xmin-R),x1=Math.min(w,xmax+R+1);let bdx=0,bdy=0,bsc=-1;
    for(let dy=-R;dy<=R;dy++)for(let dx=-R;dx<=R;dx++){let n=0;for(let k=0;k<pv.length;k++){const Y=ys[k]+dy,X=xs[k]+dx;if(Y>=y0&&Y<y1&&X>=x0&&X<x1&&nxt[Y*w+X]===pv[k])n++;}const sc=n/pv.length;
      if(sc>bsc+1e-9||(Math.abs(sc-bsc)<=1e-9&&Math.abs(dx)+Math.abs(dy)<Math.abs(bdx)+Math.abs(bdy))){bdx=dx;bdy=dy;bsc=sc;}}
    return bsc>=minAgree?{dx:bdx,dy:bdy,agree:bsc}:{dx:0,dy:0,agree:bsc};}
  /* per-pixel displacement of prev towards next inside the mask (no resampling): for every candidate shift s in [-R, R]^2 the share of a
     (2 win + 1)^2 window around each pixel that agrees between prev and next moved back by s; each pixel takes the best s, less lam per
     pixel of distance from base (the region's whole shift) so flat areas follow the region; a 3 x 3 median smooths the field. With classes
     (pen -> material) a pixel is matched only against the window pixels of its own material when at least minSame of them exist, and the
     median runs within the material. -> {fx, fy, conf} on the full canvas (zero outside the crop) */
  function blockFlow(prev,nxt,mask,w,h,o={}){const R=o.R??8,win=o.win??3,lam=o.lam??0.015,bx=o.base?.dx||0,by=o.base?.dy||0,cls=o.classes||null,minSame=o.minSame??3,k=2*win+1,k2=k*k,pad=R+win,b=bbox(mask,w,h);
    const FX=new Int32Array(w*h),FY=new Int32Array(w*h),C=new Float64Array(w*h);if(!b)return{fx:FX,fy:FY,conf:C,crop:null};
    const y0=Math.max(0,b.y0-pad),y1=Math.min(h,b.y1+pad+1),x0=Math.max(0,b.x0-pad),x1=Math.min(w,b.x1+pad+1),cw=x1-x0,ch=y1-y0,n=cw*ch;
    const P=new Uint8Array(n),N=new Uint8Array(n);for(let y=0;y<ch;y++)for(let x=0;x<cw;x++){P[y*cw+x]=prev[(y+y0)*w+x+x0];N[y*cw+x]=nxt[(y+y0)*w+x+x0];}
    const best=new Float64Array(n).fill(-1),fx=new Int32Array(n),fy=new Int32Array(n),eq=new Uint8Array(n),both=new Uint8Array(n),tmp=new Float32Array(n),mean=new Float32Array(n),num=new Float32Array(n),sc=new Float32Array(n);
    const present=[],same=new Map(),den=new Map();
    if(cls){const CP=new Int32Array(n);for(let i=0;i<n;i++)CP[i]=cls[P[i]];for(const c of [...new Set(CP.filter(c=>c>0))].sort((a,b)=>a-b)){present.push(c);const s=new Uint8Array(n);for(let i=0;i<n;i++)s[i]=+(CP[i]===c);same.set(c,s);const d=new Float32Array(n);mean32(s,cw,ch,win,mean,tmp);for(let i=0;i<n;i++)d[i]=mean[i]*k2;den.set(c,d);}}
    for(let dy=-R;dy<=R;dy++)for(let dx=-R;dx<=R;dx++){
      for(let y=0;y<ch;y++){const Y=y+dy,ok=Y>=0&&Y<ch;for(let x=0;x<cw;x++){const X=x+dx;eq[y*cw+x]=+(ok&&X>=0&&X<cw&&N[Y*cw+X]===P[y*cw+x]);}}
      mean32(eq,cw,ch,win,sc,tmp);
      for(const c of present){const s=same.get(c),d=den.get(c);for(let i=0;i<n;i++)both[i]=eq[i]&s[i];mean32(both,cw,ch,win,mean,tmp);for(let i=0;i<n;i++)if(s[i]&&d[i]>=minSame){num[i]=mean[i]*k2;sc[i]=num[i]/Math.max(d[i],1);}}
      const cost=Math.fround(lam*(Math.abs(dx-bx)+Math.abs(dy-by)));for(let i=0;i<n;i++){const v=Math.fround(sc[i]-cost);if(v>best[i]+1e-9){best[i]=v;fx[i]=dx;fy[i]=dy;}}}
    const mfx=new Int32Array(n),mfy=new Int32Array(n),vals=new Float64Array(9),pairs=[[fx,mfx],[fy,mfy]];
    if(!present.length){const ref=(v,m)=>v<0?-v-1:v>=m?2*m-v-1:v;for(let y=0;y<ch;y++)for(let x=0;x<cw;x++)for(const [arr,out] of pairs){let m=0;for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++)vals[m++]=arr[ref(y+dy,ch)*cw+ref(x+dx,cw)];out[y*cw+x]=Array.from(vals).sort((a,b)=>a-b)[4];}}
    else{mfx.set(fx);mfy.set(fy);for(const c of present){const s=same.get(c);for(let y=0;y<ch;y++)for(let x=0;x<cw;x++){const i=y*cw+x;if(!s[i])continue;for(const [arr,out] of pairs){let m=0;for(let dy=-1;dy<=1;dy++){const Y=y+dy;if(Y<0||Y>=ch)continue;for(let dx=-1;dx<=1;dx++){const X=x+dx;if(X<0||X>=cw||!s[Y*cw+X])continue;vals[m++]=arr[Y*cw+X];}}const v=Array.from(vals.subarray(0,m)).sort((a,b)=>a-b);out[i]=m?rint(m%2?v[(m-1)/2]:(v[m/2-1]+v[m/2])/2):arr[i];}}}}
    for(let y=0;y<ch;y++)for(let x=0;x<cw;x++){const i=(y+y0)*w+x+x0,j=y*cw+x;FX[i]=mfx[j];FY[i]=mfy[j];C[i]=best[j];}
    return{fx:FX,fy:FY,conf:C,crop:{x0,y0,x1,y1}};}
  /* clean a splatted region inside the mask: pinholes (see-through cells with 3+ painted 4-neighbours) take the majority pen of their
     painted 8-neighbours, specks (painted cells with no painted 4-neighbour) go; two passes */
  function tidySplat(out,mask,w,h,passes=2){let pinholes=0,specks=0;const n=w*h,op=new Uint8Array(n),n4=new Uint8Array(n);
    for(let pass=0;pass<passes;pass++){for(let i=0;i<n;i++)op[i]=+(out[i]>0);
      for(let y=0;y<h;y++)for(let x=0;x<w;x++)n4[y*w+x]=(x>0?op[y*w+x-1]:0)+(x<w-1?op[y*w+x+1]:0)+(y>0?op[(y-1)*w+x]:0)+(y<h-1?op[(y+1)*w+x]:0);
      const pin=[],spk=[];for(let i=0;i<n;i++)if(mask[i]){if(!op[i]&&n4[i]>=3)pin.push(i);else if(op[i]&&!n4[i])spk.push(i);}
      if(!pin.length&&!spk.length)break;const before=out.slice(),counts=new Int32Array(64);
      for(const i of pin){const y=i/w|0,x=i%w;counts.fill(0);let any=false;for(let dy=-1;dy<=1;dy++){const Y=y+dy;if(Y<0||Y>=h)continue;for(let dx=-1;dx<=1;dx++){const X=x+dx;if((!dy&&!dx)||X<0||X>=w)continue;const v=before[Y*w+X];if(v){counts[v]++;any=true;}}}
        if(any){let pen=0,most=0;for(let p=1;p<64;p++)if(counts[p]>most){most=counts[p];pen=p;}out[i]=pen;pinholes++;}}
      for(const i of spk)out[i]=0;specks+=spk.length;}
    return{pinholes,specks};}
  /* the region at time t between prev and next by piecewise motion: every painted pixel of the leading frame moves t of the way along its
     own flow (the most confident pixel wins a cell), cells still empty take the other frame's pixels moved back along its flow, the rest
     stays see-through; pinholes and specks tidied. F = flow prev -> next, G = next -> prev (blockFlow). Outside the mask: cur. */
  function flowTween(cur,w,h,mask,prev,nxt,F,G,o={}){const t=o.t??0.5,R=o.R??8,leadPrev=o.lead!=='next',b=bbox(mask,w,h),out=new Uint8Array(cur),score=new Float64Array(w*h).fill(-1);
    for(let i=0;i<mask.length;i++)if(mask[i])out[i]=0;if(!b)return{pixels:out,stats:{fromPrev:0,fromNext:0,pinholes:0,specks:0}};
    const ny0=Math.max(0,b.y0-R),ny1=Math.min(h,b.y1+R+1),nx0=Math.max(0,b.x0-R),nx1=Math.min(w,b.x1+R+1);
    const splat=(src,f,frac,order)=>{let moved=0;for(let y=ny0;y<ny1;y++)for(let x=nx0;x<nx1;x++){const i=y*w+x,p=src[i];if(!p)continue;const qx=x+Math.floor(frac*f.fx[i]+0.5),qy=y+Math.floor(frac*f.fy[i]+0.5);if(qx<0||qy<0||qx>=w||qy>=h)continue;const j=qy*w+qx;if(!mask[j])continue;const s=f.conf[i]+order;if(s>score[j]){score[j]=s;out[j]=p;moved++;}}return moved;};
    let fromPrev,fromNext;if(leadPrev){fromPrev=splat(prev,F,t,10);fromNext=splat(nxt,G,1-t,0);}else{fromNext=splat(nxt,G,1-t,10);fromPrev=splat(prev,F,t,0);}
    const tidy=tidySplat(out,mask,w,h,2);return{pixels:out,stats:{fromPrev,fromNext,...tidy}};}
  /* a neighbour moved as one block: prev t of the way along the tracked shift, or next back the rest (whole pixels, one landing spot) */
  function block(cur,w,h,mask,prev,nxt,shift,t,how){const dx=shift.dx,dy=shift.dy,fx=Math.floor(t*dx+0.5),fy=Math.floor(t*dy+0.5),out=new Uint8Array(cur);let painted=0;
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){const i=y*w+x;if(!mask[i])continue;let v=0;if(how==='prev'){const X=x-fx,Y=y-fy;if(X>=0&&Y>=0&&X<w&&Y<h)v=prev[Y*w+X];}else{const X=x+dx-fx,Y=y+dy-fy;if(X>=0&&Y>=0&&X<w&&Y<h)v=nxt[Y*w+X];}out[i]=v;if(v)painted++;}
    return{pixels:out,stats:{painted}};}
  /* the four versions of the region from one shift estimate and two block flows: previous leads, next leads, previous block, next block.
     o: t (0.5 = midway), R (reach, px), classes (colourClasses, or null for plain matching), search (shift search radius) */
  function candidates(cur,w,h,mask,prev,nxt,o={}){const t=o.t??0.5,R=o.R??8,win=o.win??3,lam=o.lam??0.015,classes=o.classes||null,shift=estimateShift(prev,nxt,mask,w,h,{search:o.search??10});
    const F=blockFlow(prev,nxt,mask,w,h,{R,win,lam,base:shift,classes}),G=blockFlow(nxt,prev,mask,w,h,{R,win,lam,base:{dx:-shift.dx,dy:-shift.dy},classes});
    const list=[{id:'flow-prev',label:'Previous leads',...flowTween(cur,w,h,mask,prev,nxt,F,G,{t,R,lead:'prev'})},{id:'flow-next',label:'Next leads',...flowTween(cur,w,h,mask,prev,nxt,F,G,{t,R,lead:'next'})},
      {id:'block-prev',label:'Previous block',...block(cur,w,h,mask,prev,nxt,shift,t,'prev')},{id:'block-next',label:'Next block',...block(cur,w,h,mask,prev,nxt,shift,t,'next')}];
    return{shift,t,candidates:list,crop:F.crop};}
  return{bbox,colourClasses,mean32,estimateShift,blockFlow,tidySplat,flowTween,block,candidates};
});
