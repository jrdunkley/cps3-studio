/* Prop-fed Palettes workspace. No ROM, captured data or emulator dependencies. */
(function (g) {
  'use strict';
  const R = g.ArtRamps || (typeof require === 'function' ? require('../js/ramps.js') : null);
  const F = g.ArtPalFmt || (typeof require === 'function' ? require('../js/palfmt.js') : null);
  const clone = o => JSON.parse(JSON.stringify(o));
  const member = (id,p) => id + ':' + p;
  function createModel(groups, notify = () => {}) {
    const ids = new Set(), rows = new Map(), owners = new Map();
    groups.forEach(group => {
      if (!group.id || ids.has(group.id)) throw new Error('Characters and stages need unique ids.'); ids.add(group.id);
      (group.rows || []).forEach(row => {
        if (!row.id || rows.has(row.id) || row.words.length !== (row.size || 64) || ![16,64].includes(row.words.length)) throw new Error('Rows need unique ids and exactly 64 words (16 for faces).');
        const orig = Array.from(row.words); orig.forEach(R.valid);
        if (row.readOnly && !row.rule) throw new Error('A read-only row needs its rule.');
        rows.set(row.id,{ ...row, orig, cur:orig.slice() }); owners.set(row.id,group.id);
      });
    });
    let groupId = groups[0] && groups[0].id, selected = new Set(), name = 'Untitled colours', editorGroups = {};
    groups.forEach(group => { editorGroups[group.id] = clone(group.editorGroups || (group.rows || []).flatMap(row => (row.ramps || R.find(row.words)).map(ramp=>({name:ramp.name,members:ramp.pens.map(p=>member(row.id,p))})))); });
    const past = [], future = []; let clip = null, pending = null, importPending = null;
    function ref(m) { const i = m.lastIndexOf(':'), row = rows.get(m.slice(0,i)), pen = Number(m.slice(i+1)); if (!row || !Number.isInteger(pen) || pen < 0 || pen >= row.orig.length) throw new Error('Unknown palette pen: '+m); return { row, pen }; }
    /* The groups change only through addGroup, editGroup, applyImport and restore, which bump groupsVersion: snapshots and
       change notices share one frozen copy until then (a deep copy per colour edit cost a tenth of a second on a ROM). */
    let groupsVersion=0, frozenAt=-1, frozen=null;
    function frozenGroups() { if (frozenAt !== groupsVersion) { frozen = clone(editorGroups); frozenAt = groupsVersion; } return frozen; }
    function snapshot() { return { words:Object.fromEntries([...rows].map(([id,row])=>[id,row.cur.slice()])), editorGroups:frozenGroups(), name }; }
    /* History keeps only what a step changed (the rows, the groups if they moved, the name): a ROM has thousands of rows,
       and whole copies made every change cost most of a second and grew without bound. restore() takes either form. */
    function restore(s) { version++; for (const [id,w] of Object.entries(s.words)) rows.get(id).cur = w.slice(); if (s.editorGroups) { editorGroups = clone(s.editorGroups); groupsVersion++; } if ('name' in s) name = s.name; pending = null; importPending = null; }
    function diffSnap(before, after) {
      const b = { words:{}, name:before.name }, a = { words:{}, name:after.name }; let changed = before.name !== after.name;
      for (const id in after.words) { const x = before.words[id], y = after.words[id]; for (let i = 0; i < y.length; i++) if (x[i] !== y[i]) { b.words[id] = x; a.words[id] = y; changed = true; break; } }
      if (before.editorGroups !== after.editorGroups && JSON.stringify(before.editorGroups) !== JSON.stringify(after.editorGroups)) { b.editorGroups = before.editorGroups; a.editorGroups = after.editorGroups; changed = true; }
      return changed ? { before:b, after:a } : null;
    }
    /* The current colours, cached by version: the preview asks every frame and nothing changed most of the time.
       Every change to a row goes through transaction, restore, syncRows or nudge, which bump the version. */
    let version = 0, effCache = null, effVersion = -1;
    function effective(original = false, overrides = null) {
      if (!original && !overrides && effVersion === version && effCache) return effCache;
      const result = computeEffective(original, overrides); if (!original && !overrides) { effCache = result; effVersion = version; } return result;
    }
    function computeEffective(original, overrides) {
      const out = Object.fromEntries([...rows].map(([id,row])=>[id,(original ? row.orig : overrides && overrides[id] || row.cur).slice()]));
      for (const [id,row] of rows) if (row.compute && !original) {
        out[id] = Array.from(row.compute(clone(out))); if (out[id].length !== row.orig.length) throw new Error('Computed row needs '+row.orig.length+' words.'); out[id].forEach(R.valid);
      } return out;
    }
    function changes() { let n = 0; for (const row of rows.values()) if (!row.readOnly) row.cur.forEach((w,i)=>{ if (w!==row.orig[i]) n++; }); return n; }
    let nudging=false, pendingRef=null, pendingAt=-1, pendingView=null;
    function emit() { notify({ groupId, rows:effective(), changes:changes(), editorGroups:frozenGroups(), name, coalesce:nudging }); }
    function transaction(fn) { const before = snapshot(); version++; try { fn(); version++; effective(); } catch (e) { restore(before); throw e; } const step = diffSnap(before, snapshot()); pending = null; importPending = null; if (step) { past.push(step); future.length = 0; emit(); } }
    function editable() { const list = [...selected].map(ref); if (!list.length) throw new Error('Select some pens first.'); if(list.some(x=>x.pen===0))throw new Error('Pen 0 is never drawn.');if (list.some(x=>x.row.readOnly)) throw new Error('This selection includes a computed row. Select editable pens.'); return list; }
    function select(list, mode = 'replace') {
      pending = null; importPending = null; list.forEach(m => { const {row} = ref(m); if (owners.get(row.id) !== groupId) throw new Error('Select pens in the open character or stage.'); });
      if (mode === 'replace') selected = new Set(list); else if(mode === 'remove') list.forEach(m=>selected.delete(m)); else if(mode === 'toggle') list.forEach(m=>selected.has(m)?selected.delete(m):selected.add(m)); else list.forEach(m=>selected.add(m));
    }
    function put(values) { editable(); transaction(()=>{ [...selected].forEach((m,i)=> { const {row,pen}=ref(m); row.cur[pen] = R.word(R.channels(values[i%values.length]),row.cur[pen]); }); }); }
    function normalizedGroups(list) {
      if (!Array.isArray(list)) throw new Error('Groups must be a list.');
      return list.map(gr=> { if (typeof gr.name !== 'string' || !gr.name.trim() || !Array.isArray(gr.members)) throw new Error('Each group needs a name and members.');
        const members = gr.members.map(m=> {
          try { ref(m); return m; } catch (_) {
            const i=m.lastIndexOf(':'), key=m.slice(0,i), pen=Number(m.slice(i+1)), row=[...rows.values()].find(r=>r.legacy && r.legacy.key===key && r.legacy.row===Math.floor(pen/64));
            if (!row) throw new Error('Group member has no matching row: '+m); return member(row.id,pen%64);
          }
        }); members.forEach(m=> { const x=ref(m); if(owners.get(x.row.id)!==groupId) throw new Error('Group belongs to another character or stage.'); }); return { name:gr.name.trim(), members:[...new Set(members)] }; });
    }
    function stageImport(parsed) {
      const pairs = []; const gr = groups.find(x=>x.id===groupId);
      if (parsed.metadata && parsed.metadata.key && parsed.metadata.key !== gr.id && parsed.metadata.key !== gr.legacyKey) throw new Error('This file belongs to '+parsed.metadata.key+'. Open that character or stage first.');
      if (parsed.rows && parsed.rows.length) {
        for (const imported of parsed.rows) {
          let row = rows.get(imported.id);
          if (!row && imported.legacy) row = [...rows.values()].find(r=>owners.get(r.id)===groupId && r.legacy && r.legacy.key===imported.legacy.key && r.legacy.row===imported.legacy.row);
          if (!row && parsed.rows.length===1) row=ref([...selected][0] || member(gr.rows[0].id,0)).row;
          if (!row || owners.get(row.id)!==groupId) throw new Error('No matching palette row for '+imported.name+'.');
          if (row.readOnly) continue;
          pairs.push([row,imported.words.slice()]);
        }
      } else if (parsed.words) {
        const row = ref([...selected][0] || member(gr.rows[0].id,0)).row, size=row.orig.length;
        if (row.readOnly) throw new Error(row.rule);
        if (!parsed.words.length) throw new Error('This palette has no colours.');
        /* A shorter palette fills the leading pens; a longer one gives its first colours. Pen 0 is kept. */
        const words=parsed.words.slice(0,size), notes=[];
        if (parsed.words.length>size) notes.push('This file has '+parsed.words.length+' colours; the first '+size+' are used.');
        if (words.length<size) { notes.push('This file has '+words.length+' colours; pens '+words.length+'–'+(size-1)+' keep their colours.'); for (let i=words.length;i<size;i++) words.push(row.cur[i]); }
        parsed={...parsed,notes:[...(parsed.notes||[]),...notes]}; pairs.push([row,words]);
      }
      if (new Set(pairs.map(([r])=>r.id)).size!==pairs.length) throw new Error('This import targets the same row twice.');
      pairs.forEach(([r,w])=> { if(w.length!==r.orig.length) throw new Error('Imported row needs '+r.orig.length+' colours.'); w.forEach(R.valid); });
      const newGroups = parsed.groups && parsed.groups.length ? normalizedGroups(parsed.groups) : null;
      importPending={ pairs, newGroups, parsed }; pending=null; return clone(parsed.report || []);
    }
    const api = {
      /* A host's own copy of some rows (stored colours several rows share): set them without touching history. */
      syncRows(words) { for (const [id,w] of Object.entries(words)) { const row=rows.get(id); if(!row||w.length!==row.orig.length) throw new Error('Unknown palette row: '+id); w.forEach(R.valid); row.cur=Array.from(w); } version++; pending=null; },
      groups, rows, ref, effective, changes, snapshot, restoreDraft(s) {
        if(!s || Object.keys(s.words || {}).length!==rows.size) throw new Error('Draft rows do not match.');
        for (const [id,w] of Object.entries(s.words)) { if(!rows.has(id)||w.length!==rows.get(id).orig.length) throw new Error('Draft rows do not match.'); w.forEach(R.valid); if(rows.get(id).readOnly && w.some((v,i)=>v!==rows.get(id).orig[i])) throw new Error('Draft changes a computed row.'); }
        for(const group of groups) { const previous=groupId; groupId=group.id; try { normalizedGroups(s.editorGroups[group.id]); } finally { groupId=previous; } }
        restore(s); emit();
      },
      get groupId() { return groupId; }, get selected() { return [...selected]; }, get name() { return name; }, get editorGroups() { return clone(editorGroups[groupId] || []); }, get groupsVersion() { return groupsVersion; }, get pending() { if(!pending) return null; if(pendingRef!==pending||pendingAt!==version){pendingRef=pending;pendingAt=version;pendingView=effective(false,pending);} return pendingView; }, get importPending() { return importPending; }, get canUndo() { return !!past.length; }, get canRedo() { return !!future.length; },
      setGroup(id) { if (!groups.some(x=>x.id===id)) throw new Error('Unknown character or stage.'); groupId=id; selected.clear(); pending=null; importPending=null; },
      setName(value) { transaction(()=> { name=String(value); }); }, select,
      setRGB(rgb) { const w=R.word(rgb); put([w]); },
      setChannel(channel,value) { if(!Number.isInteger(value)||value<0||value>31) throw new Error('Use a whole step from 0 to 31.'); editable(); transaction(()=>[...selected].forEach(m=> { const {row,pen}=ref(m), rgb=R.channels(row.cur[pen]); rgb[channel]=value; row.cur[pen]=R.word(rgb,row.cur[pen]); })); },
      /* Keyboard nudge: one channel of every selected pen moves by delta steps (0-31, clamped). A run of nudges on the same
         pens and channel, with no other change in between and less than 3 s between presses, is one undo step. */
      nudge(channel,delta) { if(![0,1,2].includes(channel)||!Number.isInteger(delta)) throw new Error('Nudge R, G or B by whole steps.'); const list=editable(), key=[...selected].join(',')+'/'+channel, top=past[past.length-1], at=Date.now(), merge=!!(top&&top.nudge===key&&top.version===version&&at-top.at<3000&&!future.length);
        const before=merge?null:snapshot(); let moved=0; for(const {row,pen} of list){ const c=R.channels(row.cur[pen]), v=Math.max(0,Math.min(31,c[channel]+delta)); if(v!==c[channel]){ c[channel]=v; row.cur[pen]=R.word(c,row.cur[pen]); moved++; } }
        if(!moved) return 0; version++; pending=null; importPending=null; let step; if(merge){ step=top; step.after={words:Object.fromEntries(Object.keys(top.before.words).map(id=>[id,rows.get(id).cur.slice()])),name}; } else { step=diffSnap(before,snapshot())||{before:{words:{},name},after:{words:{},name}}; step.nudge=key; past.push(step); future.length=0; }
        nudging=merge; try { emit(); } finally { nudging=false; } step.at=Date.now(); step.version=version; return moved; },
      setHSV(h,s,v) { put([R.fromHSV(h,s,v)]); },
      setWord(w) { R.valid(w); put([w]); },
      reset(all = false) { const list = all ? [...rows.values()].filter(r=>owners.get(r.id)===groupId && !r.readOnly).flatMap(r=>Array.from({length:r.orig.length},(_,p)=>member(r.id,p))) : api.selected; if(!all) editable(); transaction(()=>list.forEach(m=> { const {row,pen}=ref(m); row.cur[pen]=row.orig[pen]; })); },
      resetRow(id) { const row=rows.get(id); if(!row || row.readOnly) throw new Error(row ? row.rule : 'Unknown row.'); transaction(()=>row.cur=row.orig.slice()); },
      copy(rowMode = false) { editable(); if(rowMode) { const row=ref([...selected][0]).row; clip={ row:true, words:row.cur.slice() }; } else clip={ row:false, words:[...selected].map(m=>{const {row,pen}=ref(m);return row.cur[pen];}) }; return clone(clip); },
      paste(rowMode = false) { if(!clip) throw new Error('Copy colours first.'); if(rowMode) { const row=editable()[0].row; if(!clip.row) throw new Error('Copy a row first.'); transaction(()=>row.cur=clip.words.map((w,i)=>R.word(R.channels(w),row.cur[i]))); } else put(clip.words); },
      swap() { const list=editable(); if(list.length!==2) throw new Error('Select exactly two colours to swap.'); const a=list[0],b=list[1], w=a.row.cur[a.pen]; transaction(()=>{a.row.cur[a.pen]=R.word(R.channels(b.row.cur[b.pen]),w);b.row.cur[b.pen]=R.word(R.channels(w),b.row.cur[b.pen]);}); },
      previewShift(delta) { editable(); const next={}; for(const m of selected) { const {row,pen}=ref(m); next[row.id]=Array.from(R.shift(next[row.id]||row.cur,[pen],delta)); } pending=next; importPending=null; return clone(pending); },
      /* A colour shown on the selected pens while a picker is dragged: no history until the drag ends (setRGB). */
      previewColour(rgb) { const list=editable(), next={}; for(const {row,pen} of list){ if(!next[row.id]) next[row.id]=row.cur.slice(); next[row.id][pen]=R.word(rgb,row.cur[pen]); } pending=next; importPending=null; },
      get previewing() { return !!pending; },
      previewGradient() { const list=editable(); if(new Set(list.map(x=>x.row.id)).size!==1) throw new Error('Choose gradient pens in one row.'); const pens=list.map(x=>x.pen).sort((a,b)=>a-b), row=list[0].row; pending=effective(); pending[row.id]=Array.from(R.gradient(row.cur,pens)); return clone(pending); },
      applyPreview() { if(!pending) throw new Error('Preview a shift or gradient first.'); const draft=pending; editable(); transaction(()=>{for(const [id,w] of Object.entries(draft)) if(!rows.get(id).readOnly) rows.get(id).cur=w.slice();}); },
      cancelPreview() { pending=null; importPending=null; },
      /* Greyscale, invert and reverse, as PalMod's Tools menu offers, previewed like a shift. */
      previewTransform(kind) { const list=editable(); pending=Object.fromEntries([...rows].map(([id,row])=>[id,row.cur.slice()]));
        const byRow=new Map(); for(const x of list){ if(!byRow.has(x.row.id)) byRow.set(x.row.id,[]); byRow.get(x.row.id).push(x.pen); }
        for(const [id,pens] of byRow){ const row=rows.get(id), out=pending[id];
          if(kind==='reverse'){ const sorted=pens.slice().sort((a,b)=>a-b), values=sorted.map(p=>row.cur[p]); sorted.forEach((p,i)=>out[p]=R.word(R.channels(values[values.length-1-i]),row.cur[p])); }
          else for(const p of pens){ const c=R.channels(row.cur[p]); out[p]=R.word(kind==='invert'?c.map(v=>31-v):kind==='grey'?Array(3).fill(Math.round(c[0]*.299+c[1]*.587+c[2]*.114)):(()=>{throw new Error('Choose greyscale, invert or reverse.');})(),row.cur[p]); } }
        return clone(pending); },
      /* Colours as text: PalMod's string, or #RRGGBB lists. Selection order wins; nothing selected = the whole row. */
      copyText(rowId) { const list=selected.size?[...selected].map(ref):rowId?Array.from({length:rows.get(rowId).orig.length},(_,p)=>({row:rows.get(rowId),pen:p})):[]; if(!list.length) throw new Error('Select some pens or a row first.'); return list.map(x=>x.row.cur[x.pen]); },
      pasteWords(words, rowId) {
        if(!words || !words.length) throw new Error('There are no colours to paste.');
        let targets=[...selected].map(ref).filter(x=>x.pen>0);
        if(!targets.length){ const row=rowId&&rows.get(rowId); if(!row) throw new Error('Select pens or a row to paste into.'); const n=row.orig.length;
          /* A whole palette (PalMod copies all of it) includes pen 0, which is kept; shorter lists start at pen 1. */
          if(words.length>=n) words=words.slice(1,n); targets=Array.from({length:Math.min(n-1,words.length)},(_,i)=>({row,pen:i+1})); }
        if(targets.some(x=>x.row.readOnly)) throw new Error('This selection includes a computed row. Select editable pens.');
        const n=Math.min(targets.length,words.length); transaction(()=>{ for(let i=0;i<n;i++){ const {row,pen}=targets[i]; row.cur[pen]=R.word(R.channels(words[i]&32767),row.cur[pen]); } });
        return { pasted:n, extra:Math.max(0,words.length-targets.length), short:Math.max(0,targets.length-words.length) }; },
      addGroup(n) { if(!selected.size) throw new Error('Select colours to group.'); transaction(()=>{groupsVersion++;editorGroups[groupId].push({name:n || 'New ramp',members:api.selected});}); },
      editGroup(index,action,value) { transaction(()=>{ groupsVersion++; const list=editorGroups[groupId], gr=list[index]; if(!gr) throw new Error('Choose a ramp first.'); if(action==='rename') gr.name=String(value).trim() || gr.name; if(action==='add') gr.members=[...new Set([...gr.members,...api.selected])]; if(action==='remove') gr.members=gr.members.filter(m=>!selected.has(m)); if(action==='delete') list.splice(index,1); if(action==='up' && index>0) list.splice(index-1,0,list.splice(index,1)[0]); if(action==='down' && index<list.length-1) list.splice(index+1,0,list.splice(index,1)[0]); }); },
      selectMatching() { const originals=new Set(api.selected.map(m=>{const {row,pen}=ref(m);return row.orig[pen]&32767;})); select([...rows.values()].filter(r=>owners.get(r.id)===groupId&&!r.readOnly).flatMap(r=>r.orig.flatMap((w,p)=>p>0&&originals.has(w&32767)?[member(r.id,p)]:[]))); },
      stageImport,
      applyImport() { if(!importPending) throw new Error('Open a palette file first.'); const plan=importPending; transaction(()=>{groupsVersion++;plan.pairs.forEach(([r,w])=>r.cur=w.map((value,i)=>i===0?r.cur[0]:plan.parsed.flagSource==='file'?value:R.word(R.channels(value),r.cur[i])));if(plan.newGroups)editorGroups[groupId]=plan.newGroups;if(plan.parsed.metadata && plan.parsed.metadata.name)name=plan.parsed.metadata.name;}); },
      exportData() { return { rows:groups.find(x=>x.id===groupId).rows.map(r=>({id:r.id,name:r.name,words:effective()[r.id],readOnly:!!r.readOnly,rule:r.rule||'',legacy:r.legacy})), groups:api.editorGroups }; },
      undo() { if(!past.length) return false; const step=past.pop(); restore(step.before);future.push(step);emit();return true; },
      redo() { if(!future.length) return false;const step=future.pop();restore(step.after);past.push(step);emit();return true; }
    }; return api;
  }
  function mount(root, props) {
    if(!props || typeof props.toRGB!=='function') throw new Error('Palettes needs the host’s arcade colour conversion.');
    const K=g.Kit, el=K.el, disposers=[], actionIds=[]; let destroyed=false, ready=false, view=0, zoom=1, compare=false, flash=false, flashOn=false, previewInfo=null, groupIndex=0, activeRow=null, format='json', draftMessage='';
    function say(text) { (props.status || K.status)(text); }
    function safe(fn) { return (...args)=> { try { const result=fn(...args); if(result && result.catch) result.catch(e=>say(e.message)); return result; } catch(e) { say(e.message); } }; }
    const draftKey='art-palettes:'+ (props.storageKey || 'workspace'), fingerprint=JSON.stringify(props.groups.map(gr=>[gr.id,gr.rows.map(r=>[r.id,Array.from(r.words)])]));
    const model=createModel(props.groups,change=> { if(props.onChange)props.onChange(change); if(ready){saveDraft(); if(!destroyed)render();} });
    function saveDraft() { try { if(props.persist!==false) localStorage.setItem(draftKey,JSON.stringify({fingerprint,state:model.snapshot(),groupId:model.groupId,view,zoom})); draftMessage='Draft kept on this computer'; } catch(_) { draftMessage='Browser storage unavailable; export JSON to keep your work'; } }
    if(props.persist!==false) { try { const saved=JSON.parse(localStorage.getItem(draftKey)); if(saved && saved.fingerprint===fingerprint) { model.restoreDraft(saved.state); model.setGroup(saved.groupId); view=saved.view||0;zoom=saved.zoom||1;draftMessage='Draft restored'; } } catch(_) { draftMessage='Draft could not be restored; export JSON to keep your work'; } }
    function button(title,hint,fn,cls='btn') { return el('button',{class:cls,type:'button','data-tip':title+'|'+hint,onclick:safe(fn)},title); }
    function bind(title,hint,fn,keys,enabled) { const id='art.palettes.'+ title.toLowerCase().replace(/[^a-z0-9]+/g,'.'); K.action({id,title,hint,keys,group:'Palettes',run:safe(fn),enabled:()=>root.isConnected && (!enabled||enabled())}); actionIds.push(id); const b=button(title,hint,()=>{}); b.onclick=null;K.bind(b,id);disposers.push(()=>K.unbind(b));return b; }
    const left=el('aside.pal-browser'), center=el('section.pal-center'), right=el('aside.pal-editor');
    const search=el('input.field',{placeholder:'Find a character or stage','aria-label':'Find a character or stage','data-tip':'Find|Filter the characters and stages.',oninput:()=>renderBrowser()});
    const nav=el('div.pal-nav'); left.append(el('div.group',null,el('h3',null,'Palettes'),search),nav,el('div.pal-note',null,'All 64 pens · arcade colour steps'));
    const title=el('h2.grow'), count=el('span.tag.num'), rowsHost=el('div.pal-rows',{'data-tip':'Palette rows|Click a pen; Shift adds. Drag a box; Alt removes.'});
    const undo=bind('Undo','Undo the last colour or ramp edit.',()=>props.onUndo?props.onUndo():model.undo(),'Ctrl Z',()=>props.onUndo||model.canUndo),redo=bind('Redo','Restore the last undone edit.',()=>props.onRedo?props.onRedo():model.redo(),'Ctrl Shift Z, Ctrl Y',()=>props.onRedo||model.canRedo);
    const toolbar=el('header.pal-heading',null,title,count,undo,redo);
    const variant=el('input.field.bare.grow',{value:model.name,'aria-label':'Variant name','data-tip':'Variant name|Name these colours for export.',onchange:safe(e=>model.setName(e.target.value))});
    const onlyUsed=button('All rows','Show only rows used in the current preview.',()=> { showUnused=!showUnused;onlyUsed.textContent=showUnused?'All rows':'Used rows';renderRows(); });let showUnused=props.usedRowsOnly?false:true;if(!showUnused)onlyUsed.textContent='Used rows';
    let rowPage=0,rowAnchor=null;const pageLabel=el('span.faint.num',{'aria-live':'polite'}),previousRows=button('‹','Show previous palette rows.',()=>{rowPage--;renderRows();rowsHost.scrollTop=0;}),nextRows=button('›','Show next palette rows.',()=>{rowPage++;renderRows();rowsHost.scrollTop=0;});previousRows.setAttribute('aria-label','Previous palette rows');nextRows.setAttribute('aria-label','Next palette rows');
    const rowDescription=el('span.dim.grow');center.append(toolbar,el('div.pal-subhead',null,rowDescription,onlyUsed,previousRows,pageLabel,nextRows),rowsHost);
    const canvas=el('canvas.pal-preview',{width:384,height:224,'data-tip':'Pick a pen|Click a pixel to pick the pen that draws it; drag a box to pick several. Hold O to compare with the original.'}), previewWrap=el('div.pal-preview-wrap',null,canvas), box=el('div.pal-box',{hidden:true});previewWrap.append(box);
    /* The picture holds still while the pointer is on it, so a moving pen can be clicked; it plays on when the pointer leaves. */
    /* The picture's room, read when it changes (not on every draw, which would force a layout after each edit). */
    const wrapSize={w:0,h:0};const wrapWatch=new ResizeObserver(e=>{const r=e[0].contentRect;wrapSize.w=r.width;wrapSize.h=r.height;drawPreview();});wrapWatch.observe(previewWrap);disposers.push(()=>wrapWatch.disconnect());
    let pointerTime=null;canvas.addEventListener('pointerenter',()=>{pointerTime=performance.now()/1000;});canvas.addEventListener('pointerleave',()=>{pointerTime=null;});
    const hold=button('Original','Hold this button or O to compare with the original.',()=>{});
    hold.onpointerdown=e=> { try{hold.setPointerCapture(e.pointerId);}catch(_){} compare=true;render(); }; hold.onpointerup=hold.onpointercancel=()=> {compare=false;render();};
    const flashButton=button('Flash selection','Blink pixels that use the selected pens.',()=> {flash=!flash;flashButton.classList.toggle('on',flash);drawPreview();});
    const viewButton=button('View','Choose another pose or stage view.',()=> {const views=props.groups.find(gr=>gr.id===model.groupId).views || ['Preview']; K.menu(viewButton,views.map((v,i)=>({label:typeof v==='string'?v:v.name,checked:i===view,run:()=>{view=i;saveDraft();drawPreview();}})));});
    const zoomButton=button('100%','Zoom the preview from 100 to 400 per cent.',()=>{zoom=zoom===4?1:zoom+1;saveDraft();drawPreview();});
    const all=bind('All in view','Select all editable pens shown in the preview.',()=>selectView(false),'Ctrl A'), invert=button('Invert','Select the unselected pens in this view.',()=>selectView(true)), edited=button('Edited','Select every changed pen in this character or stage.',()=> {const gr=props.groups.find(x=>x.id===model.groupId);model.select(gr.rows.filter(r=>!r.readOnly).flatMap(r=>model.rows.get(r.id).cur.flatMap((w,p)=>w!==model.rows.get(r.id).orig[p]?[member(r.id,p)]:[])));render();});
    center.append(el('div.pal-preview-head',null,el('h3.grow',null,props.previewTitle||'Live preview'),...(props.previewTools||[]),viewButton,zoomButton,hold,flashButton),previewWrap,el('div.pal-foot',null,all,invert,edited,el('span.grow'),el('span.faint',null,props.conversionLabel || 'Arcade colour · supplied by host')));
    const selectionLabel=el('h3'), selectionFacts=el('span.faint.num'), current=el('canvas',{width:136,height:36}), original=el('canvas',{width:136,height:36});
    const samples=el('div.pal-samples',null,el('div',null,current,el('small.faint',null,'Edited')),el('div',null,original,el('small.faint',null,'Original')));
    const controls={}, inputControllers={};
    function number(label,min,max,onCommit,initial=0) { const input=el('input.field.num',{'data-tip':label+'|Type a value or drag the number.', 'aria-label':label}); const control=K.number(input,{min,max,step:1,value:initial,onCommit:safe(onCommit)}); controls[label]=input;inputControllers[label]=control;return input; }
    const rgb=el('div.pal-colour-fields'), hsv=el('div.pal-colour-fields');
    ['R','G','B'].forEach((ch,i)=>{const field=number(ch,0,31,v=>{model.setChannel(i,v);render();});field.dataset.tip=ch+'|Type a value or drag the number. Keys '+['Q / A','W / S','E / D'][i]+' nudge '+ch+' up / down one step on every selected pen; Shift: four steps.';rgb.append(el('label',null,el('span.faint',null,ch),field));});
    ['Hue','Saturation','Value'].forEach((ch,i)=>hsv.append(el('label',null,el('span.faint',{title:ch},ch==='Saturation'?'Sat':ch),number(ch,0,i===0?359:31,v=>{const first=model.ref(model.selected[0]), values=R.hsv(first.row.cur[first.pen]);values[i]=i===0?v:v/31;model.setHSV(...values);render();}))));
    const native=number('Stored value',0,65535,w=>{model.setWord(w);render();});
    const selectionCommands=el('div.pal-command-grid',null,bind('Copy pens','Copy selected colours in selection order.',()=>model.copy(),'Ctrl C'),bind('Paste pens','Paste copied colours, preserving the game’s flag bits.',()=>model.paste(),'Ctrl V'),button('Same original','Select pens that shared this original colour.',()=>{model.selectMatching();render();}),button('Reset pens','Restore selected colours to their original values.',()=>model.reset()),button('Swap colours','Exchange two selected colours.',()=>model.swap()),button('Clear','Clear the selection.',()=>{model.select([]);render();}));
    /* The picker (studio_kit/colourpicker.js): drag the square, the hue strip or any track and the selected pens and the
       picture follow at once; the release is one undo step. The numbers stay, folded away under Numbers. */
    const pickerHost=el('div.pal-picker');
    let pickerRow=null;const pickerCss=c=>rgbCSS(R.word(c),pickerRow);pickerCss.key='';
    const picker=g.CPS3ColourPicker.create(pickerHost,{css:pickerCss,
      input:safe(c=>{model.previewColour(c);live();}),
      commit:safe(c=>{model.cancelPreview();model.setRGB(c);render();say('Colour set on '+model.selected.length+' pen'+(model.selected.length===1?'':'s')+'. Ctrl Z undoes.');}),
      compare:on=>{compare=on;live();}});
    const numbers=el('details.pal-numbers',null,el('summary',{'data-tip':'Numbers|The same colour as numbers: R G B and saturation/value 0–31, hue in degrees, the stored word.'},'Numbers'),rgb,hsv,el('div.hbox',null,el('span.faint.grow',null,'Stored value'),native),el('p.faint.pal-help',null,'Keys Q/A, W/S, E/D nudge R, G, B (Shift: 4 steps). The game’s flag stays intact.'));
    /* Several pens are usually a ramp: the ramp shifter leads (each pen keeps its own shading); one colour for all of
       them is a step away. One pen: the picker. */
    let oneColour=false,lastSelectionKey='';const oneColourButton=button('Make them one colour','Show the picker to set every selected pen to the same colour.',()=>{oneColour=!oneColour;render();});
    const rampBox=el('div.pal-ramp-box',null,el('p.cp-note',null,'Drag a track: the selected pens shift together and keep their shading. Release to apply.'));
    right.append(el('div.group',null,el('div.hbox',null,selectionLabel,el('span.grow'),selectionFacts),rampBox,pickerHost,el('div.hbox.pal-one-colour',null,el('span.grow'),oneColourButton),numbers));
    const shiftValues={hue:0,saturation:0,light:0},shiftControls={};
    const shiftFields=el('div.pal-colour-fields'); ['Hue shift','Saturation shift','Light shift'].forEach((label,i)=> {const k=['hue','saturation','light'][i];const field=number(label,i===0?-180:-100,i===0?180:100,v=> {shiftValues[k]=v;model.previewShift(shiftValues);render();});shiftControls[k]=inputControllers[label];shiftFields.append(el('label',null,el('span.faint',{title:['Hue','Saturation','Light'][i]},['Hue','Sat','Light'][i]),field));});
    const beforeAfter=el('canvas.pal-shift-strip',{width:304,height:44,'data-tip':'Ramp preview|Top is before, bottom is after; every result is a stored colour.'}), pendingLabel=el('p.faint');
    const apply=button('Apply','Apply the preview as one undo step.',()=>model.applyPreview(),'btn primary'), cancel=button('Cancel','Discard the preview.',()=>{model.cancelPreview();render();}), gradient=button('Gradient','Preview a gradient through selected pens, between its two ends.',()=>{model.previewGradient();render();});
    const transform=button('More…','Greyscale, invert or reverse the selected colours, previewed before you apply.',()=>K.menu(transform,[{label:'Greyscale',run:safe(()=>{model.previewTransform('grey');render();})},{label:'Invert colours',run:safe(()=>{model.previewTransform('invert');render();})},{label:'Reverse order',run:safe(()=>{model.previewTransform('reverse');render();})}]));
    /* Ramp: drag a track to turn every selected pen's hue, strength or brightness together; before above, after below. */
    const shifterHost=el('div.pal-shifter');
    const shifter=g.CPS3ColourPicker.shifter(shifterHost,{enabled:()=>{try{const list=model.selected;return list.length>0&&!list.some(m=>{const x=model.ref(m);return x.pen===0||x.row.readOnly;});}catch(_){return false;}},
      preview:safe(d=>{model.previewShift(d);live();}),commit:safe(d=>{model.previewShift(d);model.applyPreview();render();say('Ramp shifted on '+model.selected.length+' pens. Ctrl Z undoes.');}),cancel:()=>{model.cancelPreview();render();}});
    rampBox.append(shifterHost,beforeAfter,pendingLabel);right.append(el('div.group',null,el('h3',null,'Ramp tools'),el('details.pal-numbers',null,el('summary',{'data-tip':'Numbers|Type a hue, saturation or light shift, previewed until you apply.'},'Numbers'),shiftFields),el('div.hbox',null,gradient,transform,el('span.grow'),cancel,apply)),el('div.group',null,selectionCommands));
    const groupName=el('input.field.grow',{'aria-label':'Ramp name',placeholder:'New ramp name','data-tip':'Ramp name|Name a material, such as cloth or skin.'}),groupList=el('div.pal-group-list');
    const newGroup=bind('New group','Make a named group from selected pens.',()=>{model.addGroup(groupName.value.trim());groupName.value='';},'Ctrl G');
    const groupsSave=button('Save groups','Save editor groups without palette colours.',()=>K.download('palette_groups.json',JSON.stringify({format:'cps3-palette-groups',version:1,key:model.groupId,groups:model.editorGroups},null,2),'application/json'));
    const groupsLoad=button('Load groups','Load a groups file or groups from a palette export.',async()=> {const file=await K.pickFile('.json');if(!file)return;const parsed=await F.read('json',await file.text()); if(!parsed.groups.length)throw new Error('This file has no editor groups.');model.stageImport({...parsed,rows:[],words:undefined});model.applyImport();});
    right.append(el('div.group',null,el('div.hbox',null,el('h3.grow',null,'Ramps & groups'),groupsSave,groupsLoad),el('div.hbox',null,groupName,newGroup),groupList));
    const copyRow=button('Copy row','Copy all 64 pens of the selected row.',()=>model.copy(true)),pasteRow=button('Paste row','Paste a complete row, preserving each destination flag.',()=>model.paste(true)),resetRow=button('Reset row','Restore the selected row.',()=>model.resetRow(activeRow));
    const formatButton=el('button.field',{'data-tip':'File format|Choose a palette interchange format.'});K.select(formatButton,[{value:'json',label:'JSON · rows & groups'},{value:'act',label:'ACT · PalMod, Photoshop'},{value:'act-mugen',label:'ACT · MUGEN, Fighter Factory'},{value:'gpl',label:'GIMP GPL · Aseprite, Krita'},{value:'jasc',label:'JASC PAL'},{value:'riff',label:'RIFF PAL'},{value:'png',label:F.hasPng()?'PNG strip':'PNG strip · awaits ArtPng',disabled:!F.hasPng()}],{value:format,onPick:v=>format=v});
    const importButton=button('Import…','Open a palette file. Colour changes are shown before applying.',async()=> {const file=await K.pickFile('.act,.pal,.gpl,.json,.png,.gif,.bmp'); if(file)await importFile(file);});
    const exportButton=button('Export…','Save this row, or all rows and groups as JSON.',async()=> {const data=format==='json'?model.exportData():model.effective()[activeRow];if(!data)throw new Error('Select a row first.'); const bytes=await F.write(format,data,{metadata:{key:model.groupId,name:model.name}});K.download(model.groupId+'_'+model.name.replace(/[^a-z0-9_-]+/gi,'_')+(format==='act-mugen'?'_mugen':'')+'.'+(format==='act-mugen'?'act':format==='jasc'||format==='riff'?'pal':format),bytes);say('Exported colours; native metadata keeps the game’s flag bits.');});
    const share=g.ArtPalShare;
    /* A colour sheet: the character in each of its seven colours, side by side, as PalMod's image export and the
       palette-sharing sites show them. Uses the live preview, so edits appear as they will in the game. */
    async function colourSheet(){const gr=props.groups.find(x=>x.id===model.groupId);if(!gr||gr.kind!=='character'||!props.preview)throw new Error('Open a character to make a colour sheet.');
      const bodies=[];for(let c=0;c<7;c++){const r=gr.rows.find(x=>!x.face&&x.colour===c&&x.side===0&&x.nativeRow===0);if(r)bodies.push(r);}if(!bodies.length)throw new Error(gr.name+' has no selectable colours to show.');
      const W=384,H=256,pad=12,label=22,cols=Math.min(4,bodies.length),rows=Math.ceil(bodies.length/cols),sheet=document.createElement('canvas');sheet.width=cols*W+(cols+1)*pad;sheet.height=40+rows*(H+label)+(rows+1)*pad;
      const ctx=sheet.getContext('2d'),css=n=>getComputedStyle(document.documentElement).getPropertyValue(n).trim();ctx.fillStyle=css('--bg-0')||'#0d0f12';ctx.fillRect(0,0,sheet.width,sheet.height);
      ctx.fillStyle=css('--ink')||'#e9ecf2';ctx.font='600 18px sans-serif';ctx.textBaseline='middle';ctx.fillText(gr.name+(model.name&&model.name!=='Untitled colours'?' · '+model.name:''),pad,24);
      const data=model.effective();bodies.forEach((b,i)=>{const x=pad+(i%cols)*(W+pad),y=40+pad+Math.floor(i/cols)*(H+label+pad),tmp=document.createElement('canvas');tmp.width=W;tmp.height=H;
        props.preview(tmp,data,{groupId:gr.id,rowId:b.id,view:0,zoom:1,original:false,selected:[],flash:false,time:0,toRGB:props.toRGB});ctx.fillStyle=css('--bg-1')||'#14171c';ctx.fillRect(x,y,W,H);ctx.imageSmoothingEnabled=false;ctx.drawImage(tmp,x,y,W,H);
        ctx.fillStyle=css('--ink-2')||'#a9b1c0';ctx.font='13px sans-serif';ctx.fillText(b.name,x,y+H+label/2+2);});
      const blob=await new Promise(r=>sheet.toBlob(r,'image/png'));K.download(gr.name.replace(/[^a-z0-9_-]+/gi,'_')+'_colours.png',new Uint8Array(await blob.arrayBuffer()),'image/png');say('Colour sheet saved: '+bodies.length+' colours.');}
    async function clipboardText(){ try { if(navigator.clipboard&&navigator.clipboard.readText) return await navigator.clipboard.readText(); } catch(_) {} const box=el('textarea.field',{rows:5,style:'width:100%',placeholder:'("a0080…)  or  #F8F8F8 #C0A080 …','aria-label':'Colours to paste'}); const ok=await K.dialog({title:'Paste colours',body:el('div.vbox',null,el('p',null,'Paste a PalMod colour string, or #RRGGBB colours.'),box),width:560,buttons:[{label:'Cancel',value:false},{label:'Paste',value:true,primary:true}]}); return ok?box.value:''; }
    const copyText=button('Copy for PalMod','Copy the selected colours, or the whole row, as a PalMod colour string to share or paste into PalMod.',async()=>{ const text=share.toPalMod(model.copyText(activeRow)); let copied=false; try { await navigator.clipboard.writeText(text); copied=true; } catch(_) {} if(copied) say('Copied '+((text.length-4)/4)+' colours as a PalMod string.'); else await K.dialog({title:'PalMod colour string',body:el('div.vbox',null,el('p',null,'Copy this text. PalMod pastes it with Ctrl+V.'),el('textarea.field',{rows:5,style:'width:100%',readonly:true},text)),width:560,buttons:[{label:'Done',value:true,primary:true}]}); });
    const pasteText=button('Paste colours','Paste a PalMod colour string or #RRGGBB colours into the selected pens, or the row from pen 1.',async()=>{ const text=await clipboardText(); if(!text) return; const parsed=share.fromText(text), r=model.pasteWords(parsed.words,activeRow); render(); say(parsed.note+' '+r.pasted+' pasted'+(r.extra?', '+r.extra+' left over':'')+(r.short?', '+r.short+' selected pens kept':'')+'.'); });
    right.append(el('div.group',null,el('h3',null,'Rows & files'),el('div.hbox',null,el('span.faint',null,'Variant'),variant),el('div.hbox',null,copyRow,pasteRow,resetRow),...(share?[el('div.hbox',null,copyText,pasteText)]:[]),formatButton,el('div.hbox',null,importButton,exportButton),...(props.preview?[button('Colour sheet…','Save a picture of this character in all seven colours, to share or to check them together.',colourSheet)]:[]),...(props.onOpenMod?[button('Open a mod…','Open a palette mod made with PalMod or another tool: a ROM zip, SIMM files, PalMod’s 51 file, IPS patches or an FBNeo patch folder. Changed colours are shown before applying.',()=>props.onOpenMod({model,refresh:()=>render(),say}))]:[]),el('p.faint.pal-help',null,'JSON keeps rows, names and groups. ACT, GIMP and PAL files hold one row of colours. Pen 0 is never changed.')));
    root.classList.add('palettes');root.replaceChildren(left,center,right);
    /* Studio panels: both side columns resize by their edge, hide and come back; remembered per layout. */
    const panels=g.CPS3Panels?g.CPS3Panels.attach(root,{id:'art.palettes',title:'Palettes',columns:[{el:left,name:'Palettes list',size:220,min:160,max:420},{flex:true},{el:right,name:'Colour editor',size:340,min:300,max:640}]}):null;if(panels)disposers.push(()=>panels.destroy());
    const resetAll=bind('Reset all','Restore every editable row in this character or stage.',()=>model.reset(true)); toolbar.append(resetAll);
    function rgbCSS(w,row) { const c=props.toRGB(w,row); if(!c || c.length<3 || c.slice(0,3).some(n=>!Number.isInteger(n)||n<0||n>255))throw new Error('Host colour conversion returned invalid RGB.'); return '#'+c.slice(0,3).map(n=>n.toString(16).padStart(2,'0')).join(''); }
    function renderBrowser() {
      const query=search.value.trim().toLowerCase();nav.replaceChildren();
      const label={character:'Characters',stage:'Stages',project:'Project colours'},has=k=>props.groups.some(gr=>(gr.kind||'character')===k);
      ['character','stage','project'].filter(k=>k==='project'?has('project'):has('character')||has('stage')).forEach(kind=> {nav.append(el('h3.pal-section-label',null,label[kind]));const found=props.groups.filter(gr=>(gr.kind||'character')===kind && gr.name.toLowerCase().includes(query));
        if(!found.length)nav.append(el('p.pal-note.faint',null,'No '+label[kind].toLowerCase()+' found.'));
        found.forEach(gr=> {const n=gr.rows.reduce((sum,r)=>sum+model.rows.get(r.id).cur.filter((w,i)=>!r.readOnly && w!==model.rows.get(r.id).orig[i]).length,0);const b=button(gr.name,'Open '+gr.name+'’s palette rows.',()=>{model.setGroup(gr.id);activeRow=gr.rows[0]?.id;view=0;saveDraft();render();},'btn ghost pal-group'+(model.groupId===gr.id?' on':''));b.append(el('span.grow'),el('span.faint.num',null,n?String(n):String(gr.rows.length)));nav.append(b);});});
      /* Host links: other palette sources this workspace can open (project colours, or back to the ROM's). */
      if(props.links&&props.links.length){nav.append(el('h3.pal-section-label',null,props.linksLabel||'Also'));for(const link of props.links){const b=button(link.name,link.hint||'Open '+link.name+'.',link.run,'btn ghost pal-group'+(link.on?' on':''));if(link.detail)b.append(el('span.grow'),el('span.faint',null,link.detail));nav.append(b);}}
    }
    function renderRows() {
      rowsHost.replaceChildren();const gr=props.groups.find(x=>x.id===model.groupId);if(!gr || !gr.rows.length){rowsHost.append(el('div.empty',null,el('b',null,'No palette rows here.'),el('p',null,'Choose another character or stage.')));return;}
      const effective=compare?model.effective(true):model.pending || model.effective();
      const ramps=model.editorGroups,byMember=new Map(),selected=new Set(model.selected),used=new Set((previewInfo?.members||[]).filter(Boolean).map(m=>m.slice(0,m.lastIndexOf(':')))),visible=gr.rows.filter(r=>showUnused||!previewInfo?.members||used.has(r.id));
      for(const ramp of ramps)for(const m of ramp.members){if(!byMember.has(m))byMember.set(m,[]);byMember.get(m).push(ramp);}
      if(rowAnchor!==activeRow){const at=visible.findIndex(r=>r.id===activeRow);rowPage=at<0?0:Math.floor(at/12);rowAnchor=activeRow;}
      rowPage=Math.max(0,Math.min(rowPage,Math.ceil(visible.length/12)-1));const first=rowPage*12,last=Math.min(first+12,visible.length);pageLabel.textContent=(visible.length?first+1:0)+'–'+last+' of '+visible.length;previousRows.disabled=rowPage===0;nextRows.disabled=last>=visible.length;
      visible.slice(first,last).forEach(r=> {
        const row=model.rows.get(r.id), article=el('div',{class:'pal-row'+(activeRow===r.id?' active':'')+(r.readOnly?' readonly':'')}), header=el('div.pal-row-header');
        const selectRow=button(r.name,r.readOnly?r.rule:'Select the editable pens in this row. Pen 0 is never drawn.',e=>{activeRow=r.id;model.select(Array.from({length:row.orig.length-1},(_,p)=>member(r.id,p+1)),e.shiftKey?'add':'replace');render();},'btn ghost');
        const n=row.cur.filter((w,i)=>w!==row.orig[i]).length;header.append(selectRow,el('span.grow'),el('span.tag',{'data-row-tag':r.id},r.readOnly?(r.compute?'Computed · read-only':'Read-only'):n?n+' changed':row.orig.length+' pens'));
        if(r.readOnly)header.append(el('span.faint.pal-rule',{'data-tip':'Read-only|'+r.rule},r.ruleLabel||r.rule));
        const grid=el('div.pal-swatches'); for(let p=0;p<row.orig.length;p++) {
          const m=member(r.id,p), inGroups=byMember.get(m)||[], b=button(String(p),p===0?'Pen 0 is never drawn.':r.readOnly?r.rule:'Select pen '+p+'. Shift adds to the selection.',()=>{},'btn pal-pen'+(selected.has(m)?' selected':'')+(row.cur[p]!==row.orig[p]?' edited':'')+(inGroups.length?' joined':'')+(p===0?' transparent':''));
          if(p===0)b.dataset.tip='See-through|Pen 0 is never drawn.';
          const mark=r.marks&&r.marks[p];if(mark&&p>0){b.dataset.mark=mark.kind;b.dataset.tip='Pen '+p+' · '+mark.label+'|'+mark.text+' Shift adds to the selection.';}
          b.dataset.member=m;b.style.setProperty('--pen',rgbCSS(effective[r.id][p],r));{const c=props.toRGB(effective[r.id][p],r);b.style.setProperty('--pen-ink',(c[0]*.299+c[1]*.587+c[2]*.114)>150?'#101114':'#f4f4f6');}b.setAttribute('aria-pressed',String(selected.has(m)));b.setAttribute('aria-label',r.name+', pen '+p+(mark&&p>0?', '+mark.label:'')+(inGroups.length?', '+inGroups.map(x=>x.name).join(', '):''));
          if(inGroups.length){b.classList.toggle('ramp-start',!inGroups[0].members.includes(member(r.id,p-1)));b.classList.toggle('ramp-end',!inGroups[0].members.includes(member(r.id,p+1)));b.dataset.tip+=' Ramps: '+inGroups.map(x=>x.name).join(', ')+'.';}grid.append(b);
        }
        for(const ramp of ramps){const pens=ramp.members.filter(m=>m.startsWith(r.id+':')).map(m=>model.ref(m).pen).sort((a,b)=>a-b);let start=0;
          while(start<pens.length){let end=start;while(end+1<pens.length && pens[end+1]===pens[end]+1 && Math.floor(pens[end+1]/16)===Math.floor(pens[start]/16))end++;
            const bracket=el('div.pal-ramp-bracket',{'aria-hidden':'true'});bracket.style.left=(pens[start]%16*100/16)+'%';bracket.style.width=((pens[end]-pens[start]+1)*100/16)+'%';bracket.style.top=(Math.floor(pens[start]/16)*26)+'px';grid.append(bracket);start=end+1;
          }
        }article.append(header,grid);rowsHost.append(article);
      });
    }
    const usedKeys=new WeakMap();let lastUsedKey=null,usedInfo=null;
    function usedKeyOf(m){let k=usedKeys.get(m);if(k===undefined){const seen=new Set();let last=null;for(const x of m)if(x&&x!==last){last=x;seen.add(x);}const set=new Set();for(const x of seen)set.add(x.slice(0,x.lastIndexOf(':')));k=[...set].sort().join('|');usedKeys.set(m,k);}return k;}
    function drawPreview() {
      if(destroyed)return;const gr=props.groups.find(x=>x.id===model.groupId);if(!gr)return;
      const data=compare?model.effective(true):model.pending || model.effective();
      if(props.preview)previewInfo=props.preview(canvas,data,{groupId:model.groupId,rowId:activeRow,view,zoom,original:compare,selected:model.selected,flash:flash && flashOn,time:pointerTime??performance.now()/1000,toRGB:props.toRGB}) || null;
      else {const c=canvas.getContext('2d');c.clearRect(0,0,canvas.width,canvas.height);previewInfo=null;}
      /* 'Used rows': the rows follow what the picture draws, including the first picture after mounting. */
      if(!showUnused&&previewInfo&&previewInfo.members&&previewInfo!==usedInfo){usedInfo=previewInfo;const k=usedKeyOf(previewInfo.members);if(k!==lastUsedKey){lastUsedKey=k;renderRows();}}
      if(!wrapSize.w){wrapSize.w=previewWrap.clientWidth;wrapSize.h=previewWrap.clientHeight;}const fit=zoom===1?Math.max(.1,Math.min(1,(wrapSize.w-24)/canvas.width,(wrapSize.h-24)/canvas.height)):zoom;
      const sw=canvas.width*fit+'px',sh=canvas.height*fit+'px';if(canvas.style.width!==sw)canvas.style.width=sw;if(canvas.style.height!==sh)canvas.style.height=sh;
      const zoomText=fit<1?'Fit':zoom*100+'%',viewText=(gr.views||['Preview'])[view]?.name || (gr.views||['Preview'])[view] || 'Preview';
      if(zoomButton.textContent!==zoomText)zoomButton.textContent=zoomText;if(viewButton.textContent!==viewText)viewButton.textContent=viewText;
    }
    function selectView(invertMode) { const gr=props.groups.find(x=>x.id===model.groupId), available=new Set(previewInfo && previewInfo.members?previewInfo.members.filter(Boolean):gr.rows.filter(r=>!r.readOnly).flatMap(r=>Array.from({length:model.rows.get(r.id).orig.length},(_,p)=>member(r.id,p))));model.select([...available].filter(m=>model.ref(m).pen>0&&!model.ref(m).row.readOnly && (!invertMode||!model.selected.includes(m))));render(); }
    function renderGroups() {
      groupList.replaceChildren();const list=model.editorGroups;if(!list.length)groupList.append(el('p.faint',null,'No groups yet. Select pens, then name a ramp.'));
      list.forEach((gr,i)=> { const row=el('div.pal-ramp-row'), b=button(gr.name,'Select this ramp. Shift adds; double-click renames.',e=>{groupIndex=i;model.select(gr.members,e.shiftKey?'add':'replace');render(!!props.inlineRename);},'btn ghost grow'+(i===groupIndex?' on':''));b.ondblclick=safe(async()=>{if(!props.inlineRename){const n=await K.prompt('Rename group',{value:gr.name});if(n)model.editGroup(i,'rename',n);return;}let done=false;const input=el('input.field.grow',{value:gr.name,'aria-label':'Ramp name','data-tip':'Ramp name|Type a material name; Enter keeps it, Escape cancels.'});const finish=keep=>{if(done)return;done=true;if(keep&&input.value.trim()&&input.value.trim()!==gr.name)model.editGroup(i,'rename',input.value);else render();};input.onkeydown=e=>{if(e.key==='Enter'||e.key==='Escape'){e.preventDefault();e.stopPropagation();finish(e.key==='Enter');}};input.onblur=()=>finish(true);b.replaceWith(input);input.focus();input.select();});
        row.append(b,el('span.num.faint',null,String(gr.members.length)),button('+','Add selected pens to this ramp.',()=>model.editGroup(i,'add')),button('−','Remove selected pens from this ramp.',()=>model.editGroup(i,'remove')),button('↑','Move this ramp up.',()=>model.editGroup(i,'up')),button('↓','Move this ramp down.',()=>model.editGroup(i,'down')),button('×','Delete this editor group; keep its colours.',()=>model.editGroup(i,'delete')));groupList.append(row);});
    }
    function sample(cv,w,row) {const c=cv.getContext('2d');c.clearRect(0,0,cv.width,cv.height);if(w!==undefined){c.fillStyle=rgbCSS(w,row);c.fillRect(0,0,cv.width,cv.height);}}
    function render(preserveGroups=false) {
      if(destroyed || !root.isConnected)return;if(model.selected[0])activeRow=model.ref(model.selected[0]).row.id;renderBrowser();const gr=props.groups.find(x=>x.id===model.groupId);title.textContent=gr?gr.name:'Palettes';count.textContent=model.changes()+' changes';variant.value=model.name;rowDescription.textContent=gr?.description||(gr?.kind==='stage'?'Palette rows by layer · computed colours stay read-only':'Selectable colours · shared effects and flashes');const rowsKey=[model.groupId,activeRow,rowPage,showUnused,lastUsedKey,compare,model.selected.join(','),model.groupsVersion].join('|');
      /* A colour change keeps every row, pen and ramp where it is: repaint the colours and counts in place. Rebuilding
         768 pens and the ramp list on each release cost a visible hitch. */
      if(rowsKey===lastRowsKey&&rowsHost.childElementCount)repaintRows();else{lastRowsKey=rowsKey;renderRows();}
      const groupsKey=model.groupsVersion+'|'+model.groupId+'|'+model.selected.join(',');
      if(!preserveGroups&&groupsKey!==lastGroupsKey){lastGroupsKey=groupsKey;renderGroups();}else [...groupList.querySelectorAll('.pal-ramp-row > button:first-child')].forEach((b,i)=>b.classList.toggle('on',i===groupIndex));drawPreview();
      const sel=model.selected,first=sel[0]?model.ref(sel[0]):null, transparent=sel.some(m=>model.ref(m).pen===0),ro=transparent||sel.some(m=>model.ref(m).row.readOnly);if(first)activeRow=first.row.id;
      selectionLabel.textContent=sel.length?sel.length===1?'Colour editor':'Selection':'Colour editor';selectionFacts.textContent=sel.length?sel.length+(sel.length===1?' pen':' pens'):'Pick a pen';
      const w=first?model.effective()[first.row.id][first.pen]:undefined;sample(current,w,first?.row);sample(original,first?first.row.orig[first.pen]:undefined,first?.row);
      {const key=first?(first.row.mode||'')+'|'+(first.row.kind||''):'';if(pickerCss.key!==key){pickerCss.key=key;}pickerRow=first?first.row:null;}
      {const key=sel.join(',');if(key!==lastSelectionKey){lastSelectionKey=key;oneColour=false;}const multi=sel.length>1&&!ro;rampBox.hidden=!multi;pickerHost.hidden=multi&&!oneColour;oneColourButton.parentElement.hidden=!multi;oneColourButton.textContent=oneColour?'Back to the ramp':'Make them one colour';}
      picker.set(first?R.channels(w):null,first?R.channels(first.row.orig[first.pen]):null,{enabled:!!first&&!ro,note:!sel.length?'Pick a pen: click a pixel in the picture, or a pen above. Drag across pens for a ramp.':transparent?'Pen 0 is never drawn.':ro?(first.row.rule||'This row is read-only.'):sel.length>1?'Sets all '+sel.length+' selected pens to one colour.':''});
      if(first){const c=R.channels(w),h=R.hsv(w);['R','G','B'].forEach((ch,i)=>inputControllers[ch].set(c[i],true));['Hue','Saturation','Value'].forEach((ch,i)=>inputControllers[ch].set(Math.round(i===0?h[i]:h[i]*31),true));inputControllers['Stored value'].set(w,true);}
      for(const key of ['R','G','B','Hue','Saturation','Value','Stored value','Hue shift','Saturation shift','Light shift'])controls[key].disabled=!sel.length||ro;
      selectionCommands.querySelectorAll('button').forEach(b=>b.setAttribute('aria-disabled',String(!sel.length||ro)));
      selectionCommands.querySelectorAll('button').forEach(b=>b.disabled=!sel.length||ro);
      const has=!!model.pending;apply.disabled=!has;cancel.disabled=!has;gradient.disabled=sel.length<2||ro;
      pendingLabel.textContent=has?'Preview · before above, after below.':transparent?'Pen 0 is never drawn.':ro?(first.row.rule || 'Computed row · read-only'):sel.length>1?'Top: the colours now. Bottom: while you drag, the colours you will get.':'';
      drawStrip();
      [copyRow,pasteRow,resetRow].forEach(b=>b.disabled=!first||ro);undo.setAttribute('aria-disabled',String(!model.canUndo));redo.setAttribute('aria-disabled',String(!model.canRedo));if(props.onSelection)props.onSelection(sel);
    }
    /* Before above, after below, for the selected pens (a preview, a shift being dragged, or the current colours). */
    function drawStrip(){const sel=model.selected,has=model.previewing,c=beforeAfter.getContext('2d'),pend=has?model.pending:null;c.clearRect(0,0,304,44);sel.forEach((m,i)=>{const {row,pen}=model.ref(m), width=304/Math.max(sel.length,1);c.fillStyle=rgbCSS(row.cur[pen],row);c.fillRect(Math.floor(i*width),0,Math.ceil(width),20);c.fillStyle=rgbCSS(pend?pend[row.id][pen]:row.cur[pen],row);c.fillRect(Math.floor(i*width),24,Math.ceil(width),20);});}
    /* While a picker or a ramp track is dragged: the pens, the strip and the picture follow every frame; nothing else
       is rebuilt and nothing enters the history until the release. */
    let lastRowsKey=null,lastGroupsKey=null;
    function repaintRows(){const eff=compare?model.effective(true):model.pending||model.effective();
      for(const b of rowsHost.querySelectorAll('[data-member]')){const m=b.dataset.member,i=m.lastIndexOf(':'),row=model.rows.get(m.slice(0,i));if(!row)continue;const p=Number(m.slice(i+1)),w=eff[row.id][p],css=rgbCSS(w,row);if(b.style.getPropertyValue('--pen')!==css){b.style.setProperty('--pen',css);const c=props.toRGB(w,row);b.style.setProperty('--pen-ink',(c[0]*.299+c[1]*.587+c[2]*.114)>150?'#101114':'#f4f4f6');}}
      for(const t of rowsHost.querySelectorAll('[data-row-tag]')){const row=model.rows.get(t.dataset.rowTag);if(!row||row.readOnly)continue;const n=row.cur.filter((w,i)=>w!==row.orig[i]).length,text=n?n+' changed':row.orig.length+' pens';if(t.textContent!==text)t.textContent=text;}}
    let liveFrame=0;
    function live(){if(liveFrame)return;liveFrame=requestAnimationFrame(()=>{liveFrame=0;if(destroyed)return;const eff=compare?model.effective(true):model.pending||model.effective();
      for(const b of rowsHost.querySelectorAll('[data-member]')){const m=b.dataset.member,i=m.lastIndexOf(':'),row=model.rows.get(m.slice(0,i));if(!row)continue;const w=eff[row.id][Number(m.slice(i+1))],css=rgbCSS(w,row);if(b.style.getPropertyValue('--pen')!==css)b.style.setProperty('--pen',css);}
      drawStrip();drawPreview();});}
    async function importFile(file) {
      let ext=file.name.split('.').pop().toLowerCase();if(ext==='act'&&/mugen|fighter.?factory|_ff3/i.test(file.name))ext='act-mugen';const parsed=await F.read(ext,ext==='json'?await file.text():new Uint8Array(await file.arrayBuffer()),{flags:model.effective()[activeRow],toRGB:props.toRGB,size:model.rows.get(activeRow)?.orig.length});const report=model.stageImport(parsed),notes=model.importPending?.parsed?.notes||[];
      const body=el('div.vbox',null,el('p',null,report.length?report.length+' colours change to the nearest game steps.':'Colours fit the game exactly.'),el('p.faint',null,parsed.flagSource==='none'?'This file has no game flags. Target flags are kept.':'Native words or target flags are kept.'),...notes.map(n=>el('p.faint',null,n)));
      if(report.length){const table=el('table.pal-report',null,el('thead',null,el('tr',null,...['Pen','Before','After','Difference'].map(x=>el('th',null,x))))),tbody=el('tbody');report.forEach(r=>tbody.append(el('tr',null,...[r.index,r.before.join(' '),r.after.join(' '),r.delta.map(n=>(n>0?'+':'')+n).join(' ')].map(x=>el('td.num',null,String(x))))));table.append(tbody);body.append(table);}
      const result=await K.dialog({title:'Import palette',body,width:600,buttons:[{label:'Cancel',value:false},{label:'Apply colours',value:true,primary:true}]});if(result)model.applyImport();else model.cancelPreview();render();
    }
    /* Box selection of swatches, or the host's optional pixel-to-member map. */
    function wireBox(surface,previewMode) {
      let start=null;
      const down=e=>{if(e.button!==0 || (!previewMode && e.target instanceof Element && e.target.closest('button') && !e.target.closest('[data-member]')))return;start={x:e.clientX,y:e.clientY};try{surface.setPointerCapture(e.pointerId);}catch(_){};};
      const move=e=>{if(!start)return;const rect=previewMode?previewWrap.getBoundingClientRect():rowsHost.getBoundingClientRect();box.hidden=false;(previewMode?previewWrap:rowsHost).append(box);Object.assign(box.style,{left:Math.min(start.x,e.clientX)-rect.left+(previewMode?previewWrap.scrollLeft:rowsHost.scrollLeft)+'px',top:Math.min(start.y,e.clientY)-rect.top+(previewMode?previewWrap.scrollTop:rowsHost.scrollTop)+'px',width:Math.abs(start.x-e.clientX)+'px',height:Math.abs(start.y-e.clientY)+'px'});};
      const up=e=>{if(!start)return;const a=start;start=null;box.hidden=true;let found=[];
        if(previewMode && previewInfo && previewInfo.members){const rect=canvas.getBoundingClientRect(),w=previewInfo.width||canvas.width,h=previewInfo.height||canvas.height;const x0=Math.max(0,Math.floor((Math.min(a.x,e.clientX)-rect.left)/rect.width*w)),x1=Math.min(w-1,Math.floor((Math.max(a.x,e.clientX)-rect.left)/rect.width*w)),y0=Math.max(0,Math.floor((Math.min(a.y,e.clientY)-rect.top)/rect.height*h)),y1=Math.min(h-1,Math.floor((Math.max(a.y,e.clientY)-rect.top)/rect.height*h));for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++){const m=previewInfo.members[y*w+x];if(m && !model.ref(m).row.readOnly)found.push(m);}}
        else if(!previewMode){const dragged=Math.abs(a.x-e.clientX)+Math.abs(a.y-e.clientY)>4; if(!dragged){const target=document.elementFromPoint(e.clientX,e.clientY)?.closest('[data-member]');if(target)found=[target.dataset.member];}else rowsHost.querySelectorAll('[data-member]').forEach(b=>{const r=b.getBoundingClientRect();if(r.right>=Math.min(a.x,e.clientX)&&r.left<=Math.max(a.x,e.clientX)&&r.bottom>=Math.min(a.y,e.clientY)&&r.top<=Math.max(a.y,e.clientY))found.push(b.dataset.member);});}
        if(!found.length && previewMode && !previewInfo?.members){say('The host has not supplied picture selection for this preview. Select the swatches.');return;}
        model.select([...new Set(found)],e.altKey?'remove':e.shiftKey?'add':'replace');if(found[0])activeRow=model.ref(found[0]).row.id;render();say(model.selected.length+' pens selected.');};
      const cancel=()=>{start=null;box.hidden=true;},wrappedUp=safe(up);surface.addEventListener('pointerdown',down);surface.addEventListener('pointermove',move);surface.addEventListener('pointerup',wrappedUp);surface.addEventListener('pointercancel',cancel);disposers.push(()=>{surface.removeEventListener('pointerdown',down);surface.removeEventListener('pointermove',move);surface.removeEventListener('pointerup',wrappedUp);surface.removeEventListener('pointercancel',cancel);});
    }
    wireBox(rowsHost,false);wireBox(canvas,true);
    const keydown=e=>{if((e.target instanceof Element && e.target.closest('input,textarea,[contenteditable=true]'))||e.ctrlKey||e.metaKey)return;const nudge={q:[0,1],a:[0,-1],w:[1,1],s:[1,-1],e:[2,1],d:[2,-1]}[e.key.toLowerCase()];if(nudge&&!e.altKey&&model.selected.length&&root.isConnected){e.preventDefault();e.stopPropagation();try{if(model.nudge(nudge[0],nudge[1]*(e.shiftKey?4:1)))render();else say('Already at the end of '+'RGB'[nudge[0]]+'.');}catch(error){say(error.message);}return;}if(e.key.toLowerCase()==='o'){compare=true;render();}if(e.key==='Escape'){model.select([]);render();}if(e.key==='+'||e.key==='='||e.key==='-'){zoom=Math.max(1,Math.min(4,zoom+(e.key==='-'?-1:1)));drawPreview();saveDraft();}};
    const keyup=e=>{if(e.key.toLowerCase()==='o'){compare=false;render();}},blur=()=>{compare=false;render();};document.addEventListener('keydown',keydown);document.addEventListener('keyup',keyup);g.addEventListener('blur',blur);disposers.push(()=>{document.removeEventListener('keydown',keydown);document.removeEventListener('keyup',keyup);g.removeEventListener('blur',blur);});
    const hover=e=>{const tip=e.target.closest('[data-tip]');if(tip && props.status)props.status(tip.dataset.tip.replace(/\|/g,' · '));};root.addEventListener('pointerover',hover);disposers.push(()=>root.removeEventListener('pointerover',hover));
    const resize=()=>drawPreview();g.addEventListener('resize',resize);disposers.push(()=>g.removeEventListener('resize',resize));
    /* the picture's clock: 60 Hz while it plays (props.animate, or props.animate() when the view decides), the selection
       blink every 350 ms, nothing otherwise */
    const animating=()=>typeof props.animate==='function'?!!props.animate():!!props.animate;let timer=0;
    const tick=()=>{if(destroyed)return;const playing=animating();if(flash){flashOn=Math.floor(performance.now()/350)%2===0;drawPreview();}else if(playing)drawPreview();timer=setTimeout(tick,playing?1000/60:350);};
    timer=setTimeout(tick,350);disposers.push(()=>clearTimeout(timer));
    activeRow=props.groups.find(x=>x.id===model.groupId)?.rows[0]?.id;ready=true;render();say(draftMessage || 'Click a pen or drag a box. Shift adds; Alt removes.');
    return {model, get view(){return view;}, setView(i){view=i;saveDraft();drawPreview();}, redrawPreview(){drawPreview();}, select(list,mode){model.select(list,mode);render();const target=[...rowsHost.querySelectorAll('[data-member]')].find(b=>b.dataset.member===list[0]);if(target)target.closest('.pal-row').scrollIntoView({block:'nearest'});},setGroup(id){model.setGroup(id);activeRow=props.groups.find(x=>x.id===id).rows[0]?.id;view=0;render();saveDraft();},refresh:render,importFile,previewShift(delta){model.previewShift(delta);Object.assign(shiftValues,delta);Object.entries(shiftControls).forEach(([k,c])=>c.set(shiftValues[k],true));render();},getPreviewInfo:()=>previewInfo,destroy(){saveDraft();destroyed=true;disposers.forEach(fn=>fn());actionIds.forEach(id=>K.action.remove(id));root.replaceChildren();root.classList.remove('palettes');}};
  }
  const api={mount,createModel,member};g.ArtPalettes=api;if(typeof module!=='undefined')module.exports=api;
})(typeof window !== 'undefined' ? window : globalThis);
