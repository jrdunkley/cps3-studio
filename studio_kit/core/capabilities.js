/* Operation-specific acceptance. A stale, missing or limited proof cannot become a complete feature. */
(function(g){
  'use strict';
  const Rom=g.Cps3Rom||(typeof require==='function'&&require('./cps3rom'));
  class Registry{
    constructor(){this.operations=new Map();}
    add(spec){if(!spec?.id||!spec.source?.program||!['unverified','limited','proven'].includes(spec.state)||!spec.domain)throw new Error('Capability needs ID, source, state and domain');const key=spec.source.program+':'+spec.id;if(this.operations.has(key))throw new Error('Duplicate capability '+spec.id);if(spec.state!=='unverified'&&(!spec.proofs?.length||!spec.dependencies?.length))throw new Error('An accepted capability needs proofs and dependencies');this.operations.set(key,JSON.parse(JSON.stringify(spec)));return spec;}
    get(source,id){return this.operations.get(source.program+':'+id)||{id,source,state:'unverified',domain:'No accepted implementation for this source.'};}
    async check(source,id,read){const op=this.get(source,id),changed=[];if(op.state==='unverified')return {allowed:false,complete:false,operation:op,changed};for(const dep of op.dependencies){try{const bytes=await read(dep.id);if(await Rom.sha256(bytes)!==dep.sha256)changed.push(dep.id);}catch(e){changed.push(dep.id);}}for(const proof of op.proofs)if(proof.passed!==true)changed.push(proof.id);return {allowed:!changed.length,complete:!changed.length&&op.state==='proven',operation:op,changed};}
    matrix(){return [...this.operations.values()].map(x=>JSON.parse(JSON.stringify(x)));}
  }
  const api={Registry};g.CPS3Capabilities=api;if(typeof module!=='undefined')module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
