/* ArtSlice: whole-pixel rectangles only. No resize, padding or implicit edge crop. */
(function(g){
  'use strict';
  function integer(n,min,label){if(!Number.isSafeInteger(n)||n<min) throw new Error(label+' must be a whole number of at least '+min+'.');return n;}
  function rect(image,r){for(const k of ['x','y']) integer(r[k],0,k);for(const k of ['width','height']) integer(r[k],1,k);if(r.x+r.width>image.width||r.y+r.height>image.height) throw new Error('This frame reaches outside the picture.');return r;}
  function grid(image,{cellWidth,cellHeight,margin=0,gap=0,marginX=margin,marginY=margin,gapX=gap,gapY=gap}={}) {
    integer(cellWidth,1,'Cell width');integer(cellHeight,1,'Cell height');for(const [n,k] of [[marginX,'Margin'],[marginY,'Margin'],[gapX,'Gap'],[gapY,'Gap']]) integer(n,0,k);
    const frames=[];for(let y=marginY;y+cellHeight<=image.height-marginY;y+=cellHeight+gapY) for(let x=marginX;x+cellWidth<=image.width-marginX;x+=cellWidth+gapX) frames.push({x,y,width:cellWidth,height:cellHeight});return frames;
  }
  function occupied(image,i){if(image.rgba) return image.rgba[i*4+3]!==0;return image.palette?((image.palette[image.pens[i]]?.[3]??255)!==0):image.pens[i]!==0;}
  function find(image){const w=image.width,h=image.height,seen=new Uint8Array(w*h),boxes=[];
    for(let i=0;i<w*h;i++){if(seen[i]||!occupied(image,i)) continue;const queue=[i];seen[i]=1;let minX=w,minY=h,maxX=0,maxY=0;
      for(let at=0;at<queue.length;at++){const p=queue[at],x=p%w,y=Math.floor(p/w);minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);
        for(let dy=-1;dy<=1;dy++) for(let dx=-1;dx<=1;dx++){const xx=x+dx,yy=y+dy,q=yy*w+xx;if(xx>=0&&xx<w&&yy>=0&&yy<h&&!seen[q]&&occupied(image,q)){seen[q]=1;queue.push(q);}}
      }boxes.push({x:minX,y:minY,width:maxX-minX+1,height:maxY-minY+1});
    }
    // Overlapping component boxes form one sprite: disconnected detail enclosed by a body is retained.
    let merged=true;while(merged){merged=false;outer:for(let a=0;a<boxes.length;a++) for(let b=a+1;b<boxes.length;b++){const A=boxes[a],B=boxes[b];if(A.x<B.x+B.width&&B.x<A.x+A.width&&A.y<B.y+B.height&&B.y<A.y+A.height){const x=Math.min(A.x,B.x),y=Math.min(A.y,B.y);boxes[a]={x,y,width:Math.max(A.x+A.width,B.x+B.width)-x,height:Math.max(A.y+A.height,B.y+B.height)-y};boxes.splice(b,1);merged=true;break outer;}}}
    // Form rows by overlapping vertical spans, then sort left to right within each row.
    boxes.sort((a,b)=>a.y-b.y||a.x-b.x);const rows=[];for(const b of boxes){const row=rows.find(r=>b.y<r.bottom&&b.y+b.height>r.top);if(row){row.items.push(b);row.bottom=Math.max(row.bottom,b.y+b.height);}else rows.push({top:b.y,bottom:b.y+b.height,items:[b]});}return rows.flatMap(r=>r.items.sort((a,b)=>a.x-b.x||a.y-b.y));
  }
  function crop(image,r){rect(image,r);const out={width:r.width,height:r.height};for(const key of ['pens','rgba']) if(image[key]){const c=key==='rgba'?4:1,b=new Uint8Array(r.width*r.height*c);for(let y=0;y<r.height;y++) b.set(image[key].subarray(((r.y+y)*image.width+r.x)*c,((r.y+y)*image.width+r.x+r.width)*c),y*r.width*c);out[key]=b;}if(image.palette) out.palette=image.palette.map(p=>p.slice());if(image.origin) out.origin={x:image.origin.x-r.x,y:image.origin.y-r.y};return out;}
  const api={grid,find,crop,rect,occupied};g.ArtSlice=api;if(typeof module!=='undefined') module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
