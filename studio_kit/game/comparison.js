/* Original and edited machines live in one worker and receive exactly the same starts and inputs. */
(function(g){
  'use strict';
  function workerMain(Core,Start,Scenarios,Runner){
    let left,right,eeprom,identities;
    const api={async init(o){left=await Core.create(new Uint8Array(o.wasm));right=await Core.create(new Uint8Array(o.wasm));left.setImages(new Uint8Array(o.base.program),new Uint8Array(o.bios),new Uint8Array(o.base.data));right.setImages(new Uint8Array(o.edited.program),new Uint8Array(o.bios),new Uint8Array(o.edited.data));eeprom=new Uint8Array(o.eeprom);identities=o.identities;return true;},
      compare(o){let s=Scenarios.validate(o.scenario);Scenarios.assertIdentity(s,identities);if(o.to!==undefined){if(!Number.isSafeInteger(o.to)||o.to<0||o.to>s.frames)throw new Error('Comparison frame is outside the scenario');let left=o.to;const inputs=[];for(const [a,b,n]of s.inputs){const take=Math.min(left,n);if(take)inputs.push([a,b,take]);left-=take;if(!left)break;}s={...s,inputs,checks:(s.checks||[]).filter(c=>c.at<=o.to)};}
        const starts=[Runner.start(left,s,eeprom),Runner.start(right,s,eeprom)],result=Runner.compare(left,right,s,o.options||{}),pictures=[left.rgba().slice(),right.rgba().slice()];
        return {report:{...result,starts,initialEqual:starts[0].state===starts[1].state,meters:[left.meters(),right.meters()]},pictures};},
      batch(o){return Runner.batch(async()=>({core:o.variant==='base'?left:right,eeprom,identity:identities[o.variant==='base'?0:1]}),o.cases,o.options||{});}};
    self.onmessage=async({data:m})=>{try{const value=await api[m.name](m.args);self.postMessage({id:m.id,value},value?.pictures?value.pictures.map(p=>p.buffer):[]);}catch(error){self.postMessage({id:m.id,error:error.message});}};
  }
  async function create({base,edited,bios,eeprom,source=null,mode=null,legacyEeprom=null}){
    const workerSource=`const Core=(${g.Cps3GameCore.factory.toString()})();const Start=(${g.Cps3GameStart.factory.toString()})(Core);const Scenarios=(${g.CPS3Scenarios.factory.toString()})(Start);const Runner=(${g.CPS3ScenarioRunner.factory.toString()})(Scenarios,Start);(${workerMain.toString()})(Core,Start,Scenarios,Runner);`;
    const url=URL.createObjectURL(new Blob([workerSource],{type:'text/javascript'})),worker=new Worker(url);URL.revokeObjectURL(url);let sequence=0,closed=false;const pending=new Map();
    worker.onmessage=({data:m})=>{const p=pending.get(m.id);if(!p)return;pending.delete(m.id);if(m.error)p.reject(new Error(m.error));else p.resolve(m.value);};worker.onerror=e=>{for(const p of pending.values())p.reject(new Error(e.message||'Comparison worker stopped'));pending.clear();};
    function call(name,args){if(closed)return Promise.reject(new Error('Comparison closed'));return new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});worker.postMessage({id,name,args});});}
    const wasm=Uint8Array.from(atob(g.Cps3GameWasm.base64),c=>c.charCodeAt(0));
    try{const sha=bytes=>g.Cps3Rom.sha256(bytes),common={source,mode,legacyEeprom},biosHash=await sha(bios),eepromHash=await sha(eeprom),identities=await Promise.all([base,edited].map(async image=>({...common,images:{program:await sha(image.program),data:await sha(image.data),bios:biosHash,eeprom:eepromHash}})));await call('init',{base,edited,bios,eeprom,wasm,identities});}catch(error){worker.terminate();throw error;}
    return {compare:(scenario,to,options)=>call('compare',{scenario,to,options}),batch:(cases,variant='edited',options)=>call('batch',{cases,variant,options}),destroy(){closed=true;worker.terminate();for(const p of pending.values())p.reject(new Error('Comparison closed'));pending.clear();}};
  }
  g.CPS3Comparison={create};
})(window);
