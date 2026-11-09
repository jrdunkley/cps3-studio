/* A deterministic, source-bound write planner. Module compilers retain their independent safety gates. */
(function(g){
  'use strict';
  const Rom=g.Cps3Rom||(typeof require==='function'&&require('./cps3rom'));
  const copy=x=>JSON.parse(JSON.stringify(x)),hex=b=>Array.from(b,v=>v.toString(16).padStart(2,'0')).join('');
  const unhex=s=>{if(typeof s!=='string'||s.length%2||!/^[0-9a-f]*$/i.test(s))throw new Error('Invalid byte string');return Uint8Array.from(s.match(/../g)||[],v=>parseInt(v,16));};
  class BuildError extends Error{constructor(code,message,detail){super(message);this.name='BuildError';this.code=code;this.detail=detail;}}
  function fail(code,message,detail){throw new BuildError(code,message,detail);}
  function integer(x,name,min=0){if(!Number.isSafeInteger(x)||x<min)fail('invalid',name+' must be a whole number');return x;}
  function bytes(x){if(!(x instanceof Uint8Array))fail('invalid','Image must contain bytes');return x;}
  function same(a,b){return a.length===b.length&&a.every((v,i)=>v===b[i]);}
  function sourceEqual(a,b){return ['program','data'].every(k=>!a[k]||a[k]===b[k])&&(!a.id||a.id===b.id)&&((a.mode??null)===(b.mode??null));}
  class Ledger{
    constructor(pools,source){
      this.source=source;this.pools=new Map();this.claims=[];
      const spaces={program:0x1000000,data:0x4000000,'sprite-id':65536,'palette-row':2048,'video-byte':0x800000,'ram-byte':0x80000};
      for(const p of pools||[]){
        if(!p.id||this.pools.has(p.id))fail('pool','Duplicate or missing storage pool ID');
        integer(p.start,'Pool start');integer(p.end,'Pool end',p.start+1);integer(p.alignment||1,'Pool alignment',1);
        const space=p.space||p.kind;
        if(!Object.hasOwn(spaces,space)||p.end>spaces[space])fail('pool','Pool needs a bounded physical address space: '+p.id);
        if(!p.evidence||!p.owner||!p.kind||!p.source?.program||!p.source?.data||!sourceEqual(p.source,source))fail('pool','Storage pool needs source-bound ownership evidence: '+p.id);
        this.pools.set(p.id,{...copy(p),space});
      }
    }
    reserve(c){const p=this.pools.get(c.pool);if(!p)fail('pool','No verified pool '+c.pool);integer(c.size,'Reservation size',1);const alignment=c.alignment||p.alignment||1;integer(alignment,'Alignment',1);if(alignment%(p.alignment||1))fail('alignment','Reservation alignment is incompatible with '+p.id);if(!c.owner||!c.id||this.claims.some(x=>x.id===c.id))fail('reservation','Reservation requires a unique ID and owner');let start=c.start;
      const occupied=this.claims.filter(x=>x.space===p.space).sort((a,b)=>a.start-b.start);
      if(start==null){start=Math.ceil(p.start/alignment)*alignment;for(const x of occupied){if(start+c.size<=x.start)break;if(start<x.end)start=Math.ceil(x.end/alignment)*alignment;}}
      integer(start,'Reservation start');const end=start+c.size;integer(end,'Reservation end');if(start%alignment)fail('alignment','Misaligned reservation '+c.id);if(start<p.start||end>p.end)fail('capacity','Not enough verified '+p.kind+' storage for '+c.id,{required:c.size,available:Math.max(0,p.end-start),pool:p.id,space:p.space});const collision=occupied.find(x=>start<x.end&&end>x.start);if(collision)fail('reservation-conflict',c.id+' overlaps '+collision.id,{first:collision,second:c});const result={...copy(c),kind:p.kind,space:p.space,start,end,evidence:p.evidence};this.claims.push(result);return result;}
    report(){return {pools:[...this.pools.values()].map(p=>({...p,used:this.claims.filter(c=>c.pool===p.id).reduce((n,c)=>n+c.size,0)})),claims:copy(this.claims)};}
  }
  function difference(before,after,space,target){bytes(before);bytes(after);if(before.length!==after.length)fail('size','Image size changes require a different hardware target');const writes=[];let start=-1;for(let i=0;i<=before.length;i++){const changed=i<before.length&&before[i]!==after[i];if(changed&&start<0)start=i;if(!changed&&start>=0){writes.push({space,offset:start,before:hex(before.subarray(start,i)),after:hex(after.subarray(start,i)),target:target+':'+start});start=-1;}}return writes;}
  async function layer(id,source,base,result,details={}){if(!id)fail('invalid','A layer needs an ID');const writes=[];for(const s of ['program','data'])if(result[s])writes.push(...difference(base[s],result[s],s,id));return {id,source:copy(source),operation:'module-result',depends:[],reservations:[],...copy(details),writes};}
  async function plan(base,source,layers=[],pools=[]){
    for(const s of ['program','data']){bytes(base[s]);if(base[s].length!==(s==='program'?0x1000000:0x4000000))fail('size','Wrong '+s+' image length');if(await Rom.sha256(base[s])!==source[s])fail('wrong-source','Loaded '+s+' image does not match the project source');}
    const ledger=new Ledger(pools,source),ids=new Set(),ordered=[],pending=new Map();
    for(const l of layers){if(!l||!l.id||ids.has(l.id))fail('layer','Duplicate or missing layer ID');ids.add(l.id);pending.set(l.id,l);if(!l.source?.program||!l.source?.data||!sourceEqual(l.source,source))fail('wrong-source','Layer '+l.id+' belongs to another source');}
    while(pending.size){const ready=[...pending.values()].filter(l=>(l.depends||[]).every(d=>ordered.some(x=>x.id===d))).sort((a,b)=>a.id.localeCompare(b.id,'en'));if(!ready.length)fail('dependency','Missing dependency or dependency cycle',{layers:[...pending.keys()]});for(const l of ready){ordered.push(l);pending.delete(l.id);}}
    for(const l of ordered)for(const c of [...(l.reservations||[])].sort((a,b)=>a.id.localeCompare(b.id,'en')))ledger.reserve({...c,owner:l.id});
    const writes=[],targets=new Map();
    for(const l of ordered)for(const w of l.writes||[]){if(!['program','data'].includes(w.space))fail('space','Unsupported image '+w.space);integer(w.offset,'Write offset');const a=unhex(w.before),b=unhex(w.after);if(!a.length||a.length!==b.length||w.offset+a.length>base[w.space].length)fail('bounds','Invalid write footprint in '+l.id);if(!same(base[w.space].subarray(w.offset,w.offset+a.length),a))fail('precondition','Source bytes changed at '+w.space+':'+w.offset,{layer:l.id,target:w.target});if(!w.target)fail('target','Write needs a stable target ID');
      if(w.pointer){const p=w.pointer;integer(p.value,'Pointer value');integer(p.width,'Pointer width',1);integer(p.min,'Pointer minimum');integer(p.max,'Pointer maximum',p.min+1);integer(p.alignment||1,'Pointer alignment',1);if(![2,4].includes(p.width)||b.length!==p.width||p.value<p.min||p.value>=p.max||p.value%(p.alignment||1))fail('pointer','Pointer target is outside its verified domain');let decoded=0;for(const x of b)decoded=decoded*256+x;if(decoded!==p.value)fail('pointer','Encoded pointer differs from target');const old=targets.get(w.target);if(old!=null&&old!==p.value)fail('pointer-conflict','Two layers redirect '+w.target+' differently');targets.set(w.target,p.value);}
      writes.push({...w,layer:l.id,a,b,end:w.offset+b.length});}
    writes.sort((a,b)=>a.space.localeCompare(b.space)||a.offset-b.offset||a.layer.localeCompare(b.layer));
    const active={program:[],data:[]};let sharedBytes=0;
    for(const w of writes){active[w.space]=active[w.space].filter(x=>x.end>w.offset);for(const x of active[w.space]){const end=Math.min(x.end,w.end);for(let i=w.offset;i<end;i++){if(x.b[i-x.offset]!==w.b[i-w.offset])fail('write-conflict',x.layer+' and '+w.layer+' write different bytes at '+w.space+':0x'+i.toString(16),{first:{layer:x.layer,target:x.target},second:{layer:w.layer,target:w.target},offset:i,space:w.space});sharedBytes++;}}active[w.space].push(w);}
    return {source:copy(source),layers:ordered.map(l=>l.id),writes,ledger:ledger.report(),sharedBytes};
  }
  async function build(base,source,layers=[],pools=[],options={}){const p=await plan(base,source,layers,pools),result={program:base.program.slice(),data:base.data.slice()};for(const w of p.writes)result[w.space].set(w.b,w.offset);const report={schema:'cps3-build-v1',source:p.source,layers:p.layers,writes:p.writes.map(({a,b,end,...w})=>w),ledger:p.ledger,sharedBytes:p.sharedBytes,hashes:{program:await Rom.sha256(result.program),data:await Rom.sha256(result.data)},deterministic:true};const files=[];if(options.members!==false){for(const [name,b] of Object.entries({...Rom.simms(result.program),...Rom.graphicsMembers(result.data)}))files.push({name,bytes:b});}files.push({name:'cps3-build.json',bytes:new TextEncoder().encode(JSON.stringify(report,null,2)+'\n')});return {...result,files,report};}
  const api={BuildError,Ledger,difference,layer,plan,build,hex,unhex};g.CPS3Builder=api;if(typeof module!=='undefined')module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
