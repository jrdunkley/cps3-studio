(function(root,factory){const api=factory(typeof module==='object'?require('./doc.js'):root.ArtDoc);if(typeof module==='object')module.exports=api;else root.ArtHistory=api;})(typeof globalThis!=='undefined'?globalThis:this,function(D){
  'use strict';
  const meta=d=>{const m=D.copy(d);for(const l of m.layers){delete l.pixels;delete l.rgba;}delete m.original;return m;};
  const same=(a,b)=>JSON.stringify(D.serial(a))===JSON.stringify(D.serial(b));
  function equalBytes(a,b){if(!a||!b||a.length!==b.length)return false;for(let i=0;i<a.length;i++)if(a[i]!==b[i])return false;return true;}
  function rectangle(a,b,w,h){let x=w,y=h,z=-1,v=-1;for(let i=0;i<a.length;i++)if(a[i]!==b[i]){x=Math.min(x,i%w);y=Math.min(y,i/w|0);z=Math.max(z,i%w);v=Math.max(v,i/w|0);}return z<0?null:{x,y,w:z-x+1,h:v-y+1};}
  function bytes(b,w,r){const out=new Uint8Array(r.w*r.h);for(let y=0;y<r.h;y++)out.set(b.subarray((y+r.y)*w+r.x,(y+r.y)*w+r.x+r.w),y*r.w);return out;}
  class History {
    constructor(doc){this.doc=doc;this.commands=[];this.cursor=0;this.pending=null;}
    begin(label){if(this.pending)throw new Error('A change is already open.');this.pending={label,before:D.copy(this.doc)};}
    cancel(){if(!this.pending)return;const b=this.pending.before;for(const k of Object.keys(this.doc))delete this.doc[k];Object.assign(this.doc,D.copy(b));this.pending=null;}
    commit(){if(!this.pending)return false;const {label,before}=this.pending,after=this.doc;this.pending=null;const patches=[];
      for(const l of after.layers){const old=before.layers.find(o=>o.id===l.id);if(l.kind==='paint'&&old?.pixels){const rect=rectangle(old.pixels,l.pixels,after.width,after.height);if(rect)patches.push({id:l.id,rect,before:bytes(old.pixels,after.width,rect),after:bytes(l.pixels,after.width,rect)});}}
      const mb=meta(before),ma=meta(after),assets={before:{},after:{}};
      for(const [side,d,other] of [['before',before,after],['after',after,before]])for(const l of d.layers){const o=other.layers.find(v=>v.id===l.id);if(!o||l.kind==='reference'&&!equalBytes(l.rgba,o.rgba))assets[side][l.id]=D.copy(l.pixels||l.rgba);}
      if(!patches.length&&same(mb,ma)&&!Object.keys(assets.before).length&&!Object.keys(assets.after).length)return false;
      this.commands.splice(this.cursor);this.commands.push({label,patches,before:mb,after:ma,assets});this.cursor++;return true;
    }
    perform(label,fn){this.begin(label);try{fn();D.flatten(this.doc);return this.commit();}catch(e){this.cancel();throw e;}}
    apply(c,side){const current=new Map(this.doc.layers.map(l=>[l.id,l])),m=D.copy(c[side]);for(const l of m.layers){const key=l.kind==='paint'?'pixels':'rgba';l[key]=(c.assets[side][l.id]||current.get(l.id)?.[key])?.slice();if(!l[key])throw new Error('History layer bytes missing.');}const original=this.doc.original;for(const k of Object.keys(this.doc))delete this.doc[k];Object.assign(this.doc,m,{original});for(const p of c.patches){const l=this.doc.layers.find(l=>l.id===p.id);if(!l)continue;for(let y=0;y<p.rect.h;y++)l.pixels.set(p[side].subarray(y*p.rect.w,(y+1)*p.rect.w),(y+p.rect.y)*this.doc.width+p.rect.x);}}
    undo(){if(this.pending)this.commit();if(!this.cursor)return false;this.apply(this.commands[--this.cursor],'before');return true;}
    redo(){if(this.pending)this.commit();if(this.cursor===this.commands.length)return false;this.apply(this.commands[this.cursor++],'after');return true;}
  }
  return{History};
});
