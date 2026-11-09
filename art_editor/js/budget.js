/* R2's conditional software queue. Service opportunities are explicit inputs.
 * Stored stream bytes do not measure bandwidth or completion time. */
(function(g){
 'use strict';
 const CAPACITY=341,OBSERVED_PEAK=201;
 function command(source,destination,length,mode){mode&=255;if(mode){if(mode===3){length=127;destination=0;}mode=(mode+1)&255;}const word=mode===4?((mode<<21)|(length&0x1fffff))>>>0:(((mode<<21)|((length<<1)&0x1fffff))+1)>>>0;return[word,(destination>>>3)&0x1fffff,source&0x3ffffff];}
 class Queue{
  constructor({producer=0,consumer=1,pages=[[],[]],palette_counts=[0,0],offsets=[0,0],high_water=0,refused=0}={}){this.producer=producer;this.consumer=consumer;this.pages=pages.map(p=>p.map(r=>({...r,words:[...r.words]})));this.palette_counts=[...palette_counts];this.offsets=[...offsets];this.high_water=high_water;this.refused=refused;}
  request(words,frame,sequence){const page=this.pages[this.producer];if(page.length>=CAPACITY){this.refused++;return false;}page.push({words:[...words],requested:frame,sequence});this.high_water=Math.max(this.high_water,page.length);return true;}
  swap(){if(!(this.pages[this.producer].length||this.palette_counts[this.producer]))return false;if(this.pages[this.consumer].length||this.palette_counts[this.consumer])return false;this.producer^=1;this.consumer^=1;this.pages[this.producer]=[];this.palette_counts[this.producer]=0;this.offsets[this.producer]=0;return true;}
  service(frame){const result=this.pages[this.consumer].splice(0,CAPACITY);this.offsets[this.consumer]+=result.length;return result.map(r=>({sequence:r.sequence,words:r.words,latency_frames:frame-r.requested}));}
  pending(words){const wanted=new Set(words.map(w=>JSON.stringify(w)));return !!wanted.size&&this.pages.some(page=>{const present=new Set(page.map(r=>JSON.stringify(r.words)));return [...wanted].every(w=>present.has(w));});}
  get margin(){return CAPACITY-this.pages[this.producer].length;}
 }
 function predictAnimation(sprites,timing,{context=null}={}){
  if(context===null)return {status:'unknown',every_frame_resident:null,reason:'Initial queues, allocation/cache state and service opportunities are required; sizes and animation timing alone do not determine residency.'};
  const q=new Queue(context.queue),ready=new Set(context.resident||[]),outstanding=new Map(),admissions=new Map(),frames=[];let sequence=0,previous=-1;
  for(const e of timing){if(e.frame<previous)throw new Error('events must be in execution order');previous=e.frame;
   if(e.kind==='request'){const sprite=e.sprite;if(ready.has(sprite)&&sprites[sprite].cached)continue;ready.delete(sprite);const ids=[];let accepted=true;for(const triple of sprites[sprite].requests){if(!q.request(triple,e.frame,sequence)){accepted=false;break;}ids.push(sequence++);}admissions.set(sprite,accepted);outstanding.set(sprite,new Set(ids));if(accepted&&!ids.length)ready.add(sprite);}
   else if(e.kind==='swap')q.swap();
   else if(e.kind==='service'){const completed=new Set(q.service(e.frame).map(r=>r.sequence));for(const [sprite,pending]of outstanding){for(const n of completed)pending.delete(n);if(admissions.get(sprite)&&!pending.size)ready.add(sprite);}}
   else if(e.kind==='show'){const sprite=e.sprite;frames.push({frame:e.frame,sprite,state:ready.has(sprite)?'resident':admissions.get(sprite)===false?'refused':'deferred',request_margin:q.margin});}
   else throw new Error('unsupported event: '+e.kind);
  }
  return {status:'conditional',every_frame_resident:frames.every(f=>f.state==='resident'),frames,minimum_request_margin:frames.length?Math.min(...frames.map(f=>f.request_margin)):q.margin,refused_requests:q.refused,byte_margin:null,domain:'Supplied allocation/cache/scene schedule; FBNeo/native synchronous DMA target. No physical hardware bandwidth guarantee.'};
 }
 function demand(resources,id){const c=resources.descriptor(id);return {spriteId:id,requested_bytes:c.uploads.reduce((n,u)=>n+u.requested,0),new_load_requests:c.uploads.length+1,allocation:c.allocation,cached_group:c.flags&32768?null:c.flags};}
 function animation(resources,records){const frames=records.filter(r=>r.type==='frame'&&r.fields.cel_index!=null).map(r=>({...demand(resources,r.fields.cel_index),record:r.address,duration:r.fields.duration}));return {frames,maximum_bytes:Math.max(0,...frames.map(f=>f.requested_bytes)),maximum_requests:Math.max(0,...frames.map(f=>f.new_load_requests)),scope:'Fresh sprite loads, including one table request. Cache reuse, other objects and service timing need game context.'};}
 const api={CAPACITY,OBSERVED_PEAK,command,Queue,predictAnimation,demand,animation};g.ArtBudget=api;if(typeof module!=='undefined')module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
