/* Bounded scenario and A/B runs for the same machine and inputs. No hidden writes or file I/O. */
(function(g){
  'use strict';
  function factory(Start){
  function validate(s){s=Start.parse(s);let frames=0;if(!Array.isArray(s.inputs)||!Array.isArray(s.checks||[]))throw new Error('Scenario inputs and checks must be arrays');for(const run of s.inputs){if(!Array.isArray(run)||run.length!==3||run.some(n=>!Number.isSafeInteger(n))||run[0]<0||run[0]>0xffffffff||run[1]<0||run[1]>0xffffffff||run[2]<1||run[2]>1000000)throw new Error('Invalid scenario input run');frames+=run[2];if(frames>1000000)throw new Error('Scenario exceeds one million frames');}for(const c of s.checks||[]){if(!Number.isSafeInteger(c.at)||c.at<0||c.at>frames)throw new Error('Scenario check lies outside its input frames');if(!c.state&&!c.ram&&!c.rgb&&!c.peek)throw new Error('Scenario check has no assertion');for(const k of ['state','ram','rgb'])if(c[k]&&!/^[0-9a-f]{16}$/i.test(c[k]))throw new Error('Invalid '+k+' hash');if(c.peek){if(!Array.isArray(c.peek)||c.peek.length!==2||!Number.isSafeInteger(c.peek[0])||!Number.isSafeInteger(c.peek[1])||c.peek[1]<1||c.peek[0]<0x02000000||c.peek[0]+c.peek[1]>0x02080000)throw new Error('Scenario peek outside main RAM');if(typeof c.equals!=='string'||c.equals.length!==c.peek[1]*2||!/^[0-9a-f]+$/i.test(c.equals))throw new Error('Scenario peek needs exact expected bytes');}}return {...s,frames};}
  function observe(core,check){const out={at:check.at,passed:true,observations:{}};for(const [key,method]of [['state','hashState'],['ram','hashRam'],['rgb','hashRgb']])if(check[key]){const actual=core[method]();out.observations[key]={actual,expected:check[key]};out.passed&&=actual.toLowerCase()===check[key].toLowerCase();}if(check.peek){const [address,length]=check.peek,actual=Array.from(core.ram().subarray(address-0x02000000,address-0x02000000+length),b=>b.toString(16).padStart(2,'0')).join('');out.observations.peek={address,actual,expected:check.equals};out.passed&&=actual===check.equals.toLowerCase();}return out;}
  function run(core,scenario,{onFrame=null,render=true}={}){
    const s=validate(scenario),checks=(s.checks||[]).slice().sort((a,b)=>a.at-b.at),results=[];let frame=0,ci=0;
    function check(){while(ci<checks.length&&checks[ci].at===frame){const result=observe(core,checks[ci]);results.push(result);ci++;}}
    try{
      if(render)core.render();check();
      for(const [a,b,count]of s.inputs)for(let i=0;i<count;i++){
        const fault=core.frame(a,b,render?1:2);if(fault)return {passed:false,ok:false,frames:frame,fault,results,checksExecuted:ci};
        frame++;check();if(onFrame)onFrame(core,frame);
      }
      const passed=ci===checks.length&&results.every(r=>r.passed);
      return {passed,ok:passed,frames:frame,results,checksExecuted:ci,state:core.hashState(),ram:core.hashRam(),rgb:core.hashRgb()};
    }catch(cause){const error=cause instanceof Error?cause:new Error(String(cause));error.scenarioProgress={frames:frame,results,checksExecuted:ci};throw error;}
  }
  /* Legacy settings IDs describe an explicit launch recipe. They are accepted
   * only when the caller can reproduce that exact recipe, never as raw hashes. */
  function identity(s,actual){
    s=validate(s);const mismatches=[];
    const mismatch=(field,expected,value)=>mismatches.push({field,expected,actual:value??null});
    if(s.source!=null){if(s.source!==actual.source)mismatch('source',s.source,actual.source);if((s.mode??null)!==(actual.mode??null))mismatch('mode',s.mode??null,actual.mode??null);}
    if(s.images!=null){
      if(typeof s.images!=='object'||Array.isArray(s.images))throw new Error('Scenario image identity must be an object');
      for(const [key,expected]of Object.entries(s.images)){
        if(!['program','data','bios','eeprom'].includes(key)||typeof expected!=='string')throw new Error('Invalid scenario image identity '+key);
        const legacy=key==='eeprom'&&/^(factory|[0-9a-f]{64}):free[01]:mode(-|[012])$/i.test(expected);
        if(!legacy&&!/^[0-9a-f]{64}$/i.test(expected))throw new Error('Invalid scenario '+key+' fingerprint');
        const value=legacy?actual.legacyEeprom:actual.images?.[key];
        if(typeof value!=='string'||expected.toLowerCase()!==value.toLowerCase())mismatch(key,expected,value);
      }
    }
    return {passed:!mismatches.length,mismatches};
  }
  function assertIdentity(s,actual){
    const alternatives=Array.isArray(actual)?actual:[actual],checks=alternatives.map(a=>identity(s,a));
    if(checks.some(c=>c.passed))return checks.find(c=>c.passed);
    const error=new Error('Scenario identity differs: '+checks[0].mismatches.map(m=>m.field+' expected '+m.expected+', got '+(m.actual??'unavailable')).join('; '));
    error.code='SCENARIO_IDENTITY';error.detail=checks;throw error;
  }
  function compare(left,right,scenario,{limit=256}={}){const s=validate(scenario),differences=[];let changedFrames=0,frame=0;for(const [a,b,count]of s.inputs)for(let i=0;i<count;i++){const lf=left.frame(a,b,1),rf=right.frame(a,b,1);if(lf||rf)return {passed:false,frames:frame,faults:[lf,rf],differences};frame++;const stateEqual=left.hashState()===right.hashState(),pictureEqual=left.hashRgb()===right.hashRgb();if(!stateEqual||!pictureEqual){changedFrames++;if(differences.length<limit)differences.push({frame,stateEqual,pictureEqual,left:{state:left.hashState(),rgb:left.hashRgb()},right:{state:right.hashState(),rgb:right.hashRgb()}});}}return {passed:true,frames:frame,changedFrames,differences,truncated:changedFrames>differences.length};}
  return {validate,observe,run,compare,identity,assertIdentity};
  }
  const api=factory(g.Cps3GameStart||(typeof require==='function'&&require('./start')));api.factory=factory;g.CPS3Scenarios=api;if(typeof module!=='undefined')module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
