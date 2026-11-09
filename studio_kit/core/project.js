/* Versioned authored project documents, exact compound history and recoverable immutable saves. */
(function(g){
  'use strict';
  const Sources=g.CPS3Sources||(typeof require==='function'&&require('./sources')),Rom=g.Cps3Rom||(typeof require==='function'&&require('./cps3rom'));
  const clone=x=>JSON.parse(JSON.stringify(x));
  function canonical(x){if(x===null||typeof x!=='object')return JSON.stringify(x);if(Array.isArray(x))return '['+x.map(canonical).join(',')+']';return '{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')+'}';}
  const text=x=>new TextEncoder().encode(canonical(x));
  function create(source,name='Untitled project'){return {format:'cps3project',version:1,id:'project-'+(g.crypto?.randomUUID?.()||Date.now().toString(36)+Math.random().toString(36).slice(2)),name,source:Sources.identity(source),documents:{},resources:{},layers:[],scenarios:{}};}
  function validate(p){if(p?.format!=='cps3project'||p.version!==1)throw new Error('Unsupported CPS3 project version');if(!p.id||!p.name||!p.documents||Array.isArray(p.documents)||!p.resources||!Array.isArray(p.layers)||!p.scenarios)throw new Error('Incomplete CPS3 project');Sources.identity(p.source);for(const [id,r] of Object.entries(p.resources)){if(!id||!['authored','delta','recipe'].includes(r.origin)||!r.media||typeof r.value!=='string')throw new Error('Resource '+id+' needs an authored value, delta or source recipe');if(r.origin==='recipe'&&!r.source)throw new Error('A source recipe needs its dependency');}return p;}
  function migrate(value,source){if(value?.format==='cps3project')return validate(clone(value));const p=create(source,value.name||'Imported project');if(value?.format==='sf3project'||Array.isArray(value?.parts)){p.documents.music={format:'sf3project',version:value.version||2,value:clone(value)};return p;}throw new Error('Open legacy Art projects through the Art importer so original pixels remain source recipes.');}
  /* History keeps the canonical text of every earlier project. A large document makes every step large (a 16-track,
   * 208-bar song: 0.5 MB), and the whole history is saved with each version, so it is kept to the newest steps that
   * fit HISTORY_CHARS, and never more than HISTORY_STEPS (saving cost grew with every edit of a session). */
  const HISTORY_STEPS=100,HISTORY_CHARS=8e6;
  function bounded(list){let total=0,keep=list.length;while(keep>0&&list.length-keep<HISTORY_STEPS){const n=list[keep-1].value.length;if(total+n>HISTORY_CHARS&&keep<list.length)break;total+=n;keep--;}if(keep>0)list.splice(0,keep);return list;}
  class Session{
    constructor(project){this.project=clone(validate(project));this.text=canonical(this.project);this.past=[];this.future=[];this.revision=0;this.listeners=new Set();}
    on(fn){this.listeners.add(fn);return()=>this.listeners.delete(fn);}
    emit(label){this.revision++;for(const fn of this.listeners)fn(this.project,{label,revision:this.revision});}
    edit(label,fn){const before=this.text,draft=clone(this.project);fn(draft);validate(draft);const after=canonical(draft);if(before===after)return false;this.past.push({label,value:before});bounded(this.past);this.future=[];this.project=draft;this.text=after;this.emit(label);return true;}
    document(id,value,format,version=1){return this.edit('Edit '+id,p=>{p.documents[id]={format,version,value:clone(value)};});}
    undo(){const x=this.past.pop();if(!x)return false;this.future.push({label:x.label,value:this.text});bounded(this.future);this.project=JSON.parse(x.value);this.text=x.value;this.emit('Undo '+x.label);return true;}
    redo(){const x=this.future.pop();if(!x)return false;this.past.push({label:x.label,value:this.text});bounded(this.past);this.project=JSON.parse(x.value);this.text=x.value;this.emit('Redo '+x.label);return true;}
  }
  class Repository{
    constructor(store){this.store=store;this.queue=Promise.resolve();}
    save(project,known){const value=clone(validate(project));this.queue=this.queue.catch(()=>{}).then(async()=>{const content=typeof known==='string'?known:canonical(value),hash=await Rom.sha256(new TextEncoder().encode(content)),key='version:'+value.id+':'+hash;await this.store.set(key,{hash,value});const check=await this.store.get(key);if(!check||(JSON.stringify(check.value)!==JSON.stringify(value)&&await Rom.sha256(text(check.value))!==hash))throw new Error('Project version could not be saved');const headKey='head:'+Sources.key(value.source),head=await this.store.get(headKey);await this.store.set(headKey,{id:value.id,key,previous:head?.key||null});return {key,hash};});return this.queue;}
    async load(source,key){const head=key?null:await this.store.get('head:'+Sources.key(source));for(const candidate of key?[key]:[head?.key,head?.previous]){if(!candidate)continue;const d=await this.store.get(candidate);if(d&&await Rom.sha256(text(d.value))===d.hash&&Sources.equal(d.value.source,source))return clone(validate(d.value));}return null;}
    async versions(id){return (await this.store.keys()).filter(k=>String(k).startsWith('version:'+id+':')).sort();}
  }
  function exportProject(project){return JSON.stringify(validate(project),null,2)+'\n';}
  function importProject(value,source){const p=migrate(typeof value==='string'?JSON.parse(value):value,source);if(!Sources.equal(p.source,source))throw new Error('This project belongs to another source or mode');return p;}
  const api={VERSION:1,create,validate,migrate,Session,Repository,canonical,clone,exportProject,importProject};g.CPS3Project=api;if(typeof module!=='undefined')module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
