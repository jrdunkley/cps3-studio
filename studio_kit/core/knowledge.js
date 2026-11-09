/* Shared metadata graph. Facts retain evidence and source dependencies; guesses remain guesses. */
(function(g){
  'use strict';
  const clone=x=>JSON.parse(JSON.stringify(x)),STATES=['unknown','observed','static','verified'];
  class Registry{
    constructor(){this.records=new Map();this.incoming=new Map();this.revision=0;}
    add(record){if(!record?.id||!record.kind||!record.source?.program||!STATES.includes(record.state))throw new Error('Knowledge needs an ID, kind, source and evidence state');if(record.state!=='unknown'&&!record.evidence?.length)throw new Error('A knowledge fact needs evidence');if(this.records.has(record.id))throw new Error('Duplicate knowledge ID '+record.id);const r=clone(record);r.references=r.references||[];if(!Array.isArray(r.references)||r.references.some(ref=>!ref?.target||!ref.role))throw new Error('A reference needs target and role');this.records.set(r.id,r);for(const ref of r.references){if(!this.incoming.has(ref.target))this.incoming.set(ref.target,[]);this.incoming.get(ref.target).push({id:r.id,...ref});}this.revision++;return r;}
    get(id){return clone(this.records.get(id)||null);}
    uses(id){return clone(this.incoming.get(id)||[]);}
    search(query='',filter={}){const tokens=query.toLowerCase().trim().split(/\s+/).filter(Boolean);return [...this.records.values()].filter(r=>(!filter.kind||r.kind===filter.kind)&&(!filter.state||r.state===filter.state)&&(!filter.program||r.source.program===filter.program)&&tokens.every(t=>(r.id+' '+(r.name||'')+' '+(r.tags||[]).join(' ')).toLowerCase().includes(t))).map(clone);}
    validate(){const missing=[];for(const r of this.records.values())for(const ref of r.references)if(!this.records.has(ref.target)&&!ref.external)missing.push({id:r.id,target:ref.target,role:ref.role});return {passed:!missing.length,missing,records:this.records.size};}
  }
  const api={Registry,STATES};g.CPS3Knowledge=api;if(typeof module!=='undefined')module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
