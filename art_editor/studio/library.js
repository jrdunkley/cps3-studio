/* Bounded rows and visibility-driven thumbnails: thousands of frames never become thousands of canvases. */
(function(g) {
  'use strict'; const A = g.ArtStudio, K = Kit, el = K.el, S = A.state;
  const cache = new Map(), uses = new Map(); let root, nav, scroller, content, detail, observer, generation = 0, current = [], filter = 'all', query = '';
  const L = A.library = { characters: [], character: 2, selected: null, frame: 0, census: new Map(),censusPending:new Set(), censusState: 'Finding which frames share this sprite (about half a minute after Art opens)…', expanded: new Set() };
  L.sections=new Map();
  L.registerSection=section=>{if(!section.id||!section.title)throw new Error('A Library section needs an id and title.');L.sections.set(section.id,section);if(nav)drawNav();return()=>{L.sections.delete(section.id);if(nav)drawNav();};};
  L.mountSection=(host,id)=>{const section=L.sections.get(id);if(!section)return A.empty(host,'Nothing here yet.','This artwork section has not been joined.');if(!section.mount||section.capability&&!ArtLimits.allowed(section.capability)){A.empty(host,section.title,section.capability?ArtLimits.reason(section.capability):'This artwork section has not been joined.');return;}return section.mount(host,{studio:A,state:S,library:L});};
  for(const [id,title,capability]of[['backgrounds','Stages','background.view'],['interface','Interface','interface.view'],['effects','Effects','palette.computed']])L.registerSection({id,title,capability});
  const button = (title, hint, run, primary=false) => A.button(title,hint,run,primary);
  L.animations = id => {
    if (!cache.has(id)) cache.set(id, ArtAnim.animations(S.resources.program,id).map((native,index) => ({ native, id: id+':'+index, number:index+1, name:(g.ArtAnimationNames?.[id+':'+native.section+':'+native.slot]||'Animation '+(index+1)).replace(/_/g,' ').replace(/\b\w/g,c=>c.toUpperCase()),referenceName:!!g.ArtAnimationNames?.[id+':'+native.section+':'+native.slot], ...ArtAnim.timeline(native,S.resources.program) })));
    const animations=cache.get(id);if(!animations.numbered){const seen=new Map(),total=new Map();for(const a of animations)total.set(a.name,(total.get(a.name)||0)+1);for(const a of animations){if(total.get(a.name)<2)continue;const n=(seen.get(a.name)||0)+1;seen.set(a.name,n);a.name=a.name+' · '+n+' of '+total.get(a.name);}animations.numbered=true;}
    for(const anim of animations)for(const frame of anim.frames)frame.hold=frame.duration===250;return animations;
  };
  L.durationLabel=anim=>{const hold=anim.frames.findIndex(f=>f.hold),ticks=hold<0?anim.ticks:anim.frames.slice(0,hold).reduce((sum,f)=>sum+f.duration,0);return hold===0?'hold':ticks+'f'+(hold<0?ticks>120?' / '+(ticks/anim.rate).toFixed(2)+'s':'':' + hold');};
  L.selectCharacter = id => {
    A.findings.group='characters'; A.findings.selected=null; document.getElementById('studio-app').dataset.artBrowseOnly='false'; L.character = Number(id); S.project.ui.character = L.character; A.refreshColours?.();
    current = L.animations(L.character); L.expanded.clear(); const anim = current.find(x=>x.frames.some(f=>S.resources.row(f.spriteId).pointer));
    L.selected = anim || null; L.frame = 0; if(anim){L.expanded.add(anim.id); A.transport.set(anim);} else A.transport.set({frames:[],ticks:0,rate:59.59949,complete:false});
    if(root) { drawNav(); drawRows(); drawDetail(); } S.schedule();
  };
  L.select = (anim,index=0) => { L.selected=anim; L.frame=index; S.project.ui.animation=anim.id; S.project.ui.frame=index; A.transport.set(anim); A.transport.jump(index); L.expanded.add(anim.id); if(root){drawRows();drawDetail();} S.schedule(); };
  L.usage = id => uses.get(Number(id)) || [];
  L.init = async () => {
    L.characters=ArtAnim.characters(S.resources.program); A.findings.init();
    for (const ch of L.characters) {
      for (const anim of L.animations(ch.id)) for (const [frame,r] of ArtNames.records(anim.native).filter(r=>r.type==='frame'&&r.fields.cel_index!==undefined).entries()) {
        const spriteId=r.fields.cel_index;if(!uses.has(spriteId))uses.set(spriteId,[]);uses.get(spriteId).push({character:ch.id,characterName:ch.name,animation:anim.number,animationName:anim.name,spriteId,id:anim.id,frame,prefix:frame<anim.frames.length&&anim.frames[frame].spriteId===spriteId,duration:r.fields.duration,flip:r.fields.flip});
      }
      await new Promise(r=>setTimeout(r,0));
    }
    L.selectCharacter(S.project.ui.character ?? 2);
    K.paletteSource(q=> {
      const found=L.characters.map(ch=>({key:'character:'+ch.id,title:ch.name,hint:'Browse this character’s animations.',group:'Characters',run:()=>{A.showView('library');L.selectCharacter(ch.id);}}));
      if(q.trim()) for(const ch of L.characters)for(const anim of L.animations(ch.id)) { const title=ch.name+' · '+anim.name; if((title+' '+anim.frames.map(f=>f.spriteId).join(' ')).toLowerCase().includes(q.toLowerCase()))found.push({key:anim.id,title,hint:anim.frames.length+' frames · '+anim.ticks+' game frames',group:'Animations',run:()=>{A.showView('library');L.selectCharacter(ch.id);L.select(anim);}}); }
      const id=Number(q.replace(/^sprite\s*/i,'')); if(Number.isInteger(id)&&id>=0&&id<65536&&S.resources.row(id).pointer)found.push({key:'sprite:'+id,title:'Sprite '+id,hint:'Open this sprite number.',group:'Sprites',run:()=>A.openSprite(id)}); return found;
    });
    L.startCensus();
  };
  L.startCensus = () => {
    /* Build an exhaustive reader census off the UI thread. A failure stays unknown. */
    const modules=['codec6','cel','census'].map(n=>new URL('js/'+n+'.js',location.href).href);   /* relative to the page; a query or hash (which may hold a '/') is ignored */
    /* From disk (file://) a worker cannot import files: use the generated source capsule. */
    const head=location.protocol==='file:'?(g.ArtCensusWorkerSource?g.ArtCensusWorkerSource+String.fromCharCode(10,59,10):null):`importScripts(${modules.map(x=>JSON.stringify(x)).join(',')});`;
    if(head===null){L.censusState='Sprite sharing cannot be checked: studio/census_worker_source.js is missing.';return;}
    const code=head+`let census;onmessage=e=>{try{if(e.data.init){census=new ArtCensus.Census(new ArtCel.Resources(e.data.program,e.data.data));postMessage({ready:true});}else{postMessage({id:e.data.id,value:census.forCel(e.data.id)});}}catch(err){postMessage({error:err.message,id:e.data.id});}};`;
    const url=URL.createObjectURL(new Blob([code],{type:'text/javascript'})); let worker;
    try { worker=new Worker(url); } catch(e){L.censusState='Sprite sharing cannot be checked: '+e.message;URL.revokeObjectURL(url);return;}
    L.worker=worker;worker.onmessage=e=>{if(e.data.error){L.censusPending.delete(e.data.id);L.censusState='Sprite sharing could not be checked: '+e.data.error;return;}if(e.data.ready){L.censusState='ready';L.requestCensus(L.selected?.frames[L.frame]?.spriteId);}else{L.censusPending.delete(e.data.id);L.census.set(e.data.id,e.data.value);S.emit('census',e.data);if(root)drawDetail();}};
    worker.onerror=e=>{L.censusState='Sprite sharing cannot be checked in this browser. No spare room is assumed.';S.emit('census');};
    worker.postMessage({init:true,program:S.resources.program,data:S.resources.data}); URL.revokeObjectURL(url);
  };
  L.requestCensus = id => { if(id!==undefined&&L.censusState==='ready'&&!L.census.has(id)&&!L.censusPending.has(id)){L.censusPending.add(id);L.worker.postMessage({id});} };
  L.inspector = id => {
    L.requestCensus(id); const c=L.census.get(Number(id)), u=L.usage(id), animationCount=new Set(u.map(x=>x.id)).size;
    const priced=A.deliveryFacts?.(id),changed=!!S.project.sprites[id];
    const sharedUses=c?[...new Set([Number(id),...c.sharedWith])].flatMap(sprite=>L.usage(sprite)):u;
    return {measuring:L.censusState==='ready'||/^Finding/.test(L.censusState),sharedFrames:u.filter(use=>!(use.id===L.selected?.id&&use.frame===L.frame)).slice(0,8).map(use=>({...use,frameIndex:use.frame,animation:use.animationName,flipX:!!(use.flip&1),flipY:!!(use.flip&2)})),bytesUsed:priced?.changed?priced.bytesUsed:c?c.footprint.fixed_sum:undefined,bytesOwned:c?.footprint.source_consumed_sum,exclusiveBytes:c?.ownedSourceBytes,sharedWith:c?.sharedWith||[],uses:u,sharedUses,animationCount,roomSentence:changed?(priced?.room==null?'Pricing this change; no spare ROM bytes are assumed.':priced.room<0?(-priced.room)+' bytes too large. No spare ROM bytes are proved.':priced.room+' bytes left inside the stored streams. No spare ROM bytes are proved.'):c?'No spare room. Re-encoding would save '+c.headroom.reencode_savings_sum+' bytes.':L.censusState==='ready'?'Checking this sprite’s ownership…':L.censusState};
  };
  L.openUse=use=>{L.selectCharacter(use.character);const anim=L.animations(use.character).find(a=>a.id===use.id);if(use.prefix){L.select(anim,use.frame);A.openAnimation(anim,use.frame);}else{L.selected={name:use.animationName+' · frame '+(use.frame+1),frames:[{spriteId:use.spriteId,duration:use.duration,flip:use.flip}],ticks:use.duration,rate:59.59949,complete:false};L.frame=0;A.showView('edit');}};
  L.sharedSheet=id=>{
    let dialog;const items=L.inspector(id).sharedUses,viewport=el('div.shared-viewport'),body=el('div',{style:{height:items.length*56+'px',position:'relative'}});viewport.append(body);
    const draw=()=>{body.replaceChildren();const from=Math.max(0,Math.floor(viewport.scrollTop/56)-2),end=Math.min(items.length,from+12);for(let i=from;i<end;i++){const use=items[i],row=button(use.characterName+' · '+use.animationName+' · frame '+(use.frame+1),'Open this stored frame. Conditional playback needs game context.',()=>{dialog.close();L.openUse(use);});row.className='btn shared-row';row.style.top=i*56+'px';const cv=el('canvas',{width:48,height:48});row.prepend(cv);try{A.drawSprite(cv,S.image(use.spriteId),{width:48,height:48,character:use.character});}catch(_){}body.append(row);}};
    viewport.onscroll=draw;draw();dialog=K.dialog({title:'Shared artwork · '+items.length+' stored frames',body:viewport,width:720});return dialog;
  };
  function drawNav() {
    nav.replaceChildren(button('Everything in the ROM','Browse every stored sprite, named or unknown.',()=>A.showView('library:everything')),el('h3',null,'Characters'),el('input.field',{value:query,placeholder:'Find animation or sprite',type:'search','aria-label':'Search Library','data-tip':'Search|Find a character, animation or sprite number.',oninput:e=>{query=e.target.value;drawRows();}}));
    nav.firstElementChild.classList.add('library-everything-link');nav.firstElementChild.replaceChildren(el('b',null,'Everything in the ROM'),el('small.num',null,A.everythingModel().rows.length.toLocaleString('en-US')+' sprites'));
    for(const ch of L.characters){const b=button(ch.name,'Browse '+ch.name+' in the game’s order.',()=>L.selectCharacter(ch.id));b.classList.add('character-row');b.classList.toggle('on',ch.id===L.character);b.dataset.character=ch.id;const cv=el('canvas',{width:32,height:36});b.prepend(cv);const idle=L.animations(ch.id).find(a=>a.frames.length);if(idle)observe(cv,idle.frames[0].spriteId,32,36,ch.id);nav.append(b);}
    A.findings.nav(nav);
    for(const section of [...L.sections.values()].filter(s=>!A.findings.sectionIds.includes(s.id))){if(section.id==='everything')continue;const enabled=!!section.mount&&(!section.capability||ArtLimits.allowed(section.capability));nav.append(el('div'+(enabled?'':' .library-unavailable').replace(' ',''),null,enabled?button(section.title,section.capability?ArtLimits.reason(section.capability):'Browse this artwork.',()=>A.showView('library:'+section.id)):el('h3',null,section.title),!enabled&&el('p.hint',null,section.capability?ArtLimits.reason(section.capability):'This artwork section has not been joined.')));}
    nav.append(button('My projects','Open a saved project or an earlier version.',()=>L.projects()),button('Open project…','Open a .cps3art file using this ROM.',()=>K.run('art.open')));
  }
  function observe(canvas,id,width=64,height=64,character=L.character) {canvas.dataset.sprite=id;canvas.dataset.character=character;canvas.dataset.width=width;canvas.dataset.height=height;observer?.observe(canvas);}
  function thumbnail(cv) {
    try {const id=Number(cv.dataset.sprite),im=S.image(id),doc=S.project.sprites[id];if(doc)ArtPreview.draw(cv,doc,A.palette(),{width:+cv.dataset.width,height:+cv.dataset.height});else A.drawSprite(cv,im,{width:+cv.dataset.width,height:+cv.dataset.height,character:+cv.dataset.character});}
    catch(e){cv.title=e.message;}observer.unobserve(cv);
  }
  function matching() {
    let rows=current.filter(anim=>anim.frames.length&&(!query || (anim.name+' '+L.characters[L.character].name+' '+anim.frames.map(f=>f.spriteId).join(' ')).toLowerCase().includes(query.toLowerCase())));
    if(filter==='edited')rows=rows.filter(anim=>anim.frames.some(f=>S.project.sprites[f.spriteId]));
    if(filter==='shared')rows=rows.filter(anim=>anim.frames.some(f=>L.usage(f.spriteId).length>1));return rows;
  }
  function drawRows() {
    if(!content)return;root.querySelector('.library-heading h2').textContent=A.findings.group==='characters'?'Animations':A.findings.titles[A.findings.group];if(A.findings.group!=='characters'){A.findings.drawRows(content,scroller,query,filter);return;}for(const cv of content.querySelectorAll('canvas'))observer?.unobserve(cv);const rows=matching(), positioned=[];let height=0;
    for(const anim of rows){const h=L.expanded.has(anim.id)?140:44;positioned.push({anim,top:height,h});height+=h;}
    content.style.height=Math.max(height,scroller.clientHeight)+'px';
    const top=Math.max(0,scroller.scrollTop-180),end=scroller.scrollTop+scroller.clientHeight+180;
    content.replaceChildren();
    for(const {anim,top:y,h}of positioned){if(y+h<top||y>end)continue;const row=el('section.animation-row',{style:{top:y+'px',height:h+'px'}});
      const b=button(anim.name,anim.frames.length+' frames. Double-click to open in Edit.',()=>{L.expanded.has(anim.id)?L.expanded.delete(anim.id):L.expanded.add(anim.id);L.selected=anim;L.frame=0;A.transport.set(anim);drawRows();drawDetail();});b.className='animation-heading';b.dataset.animation=anim.id;b.ondblclick=()=>A.openAnimation(anim,0);b.append(el('span.grow'),el('span.num',null,anim.frames.length+(anim.frames.length===1?' frame':' frames')),el('span.num',null,L.durationLabel(anim)));row.append(b);
      if(L.expanded.has(anim.id)){const strip=el('div.library-frames',{'data-tip':'Frames|Double-click to edit. The number below is the duration in game frames.'});
        /* Horizontal virtualization keeps long animations bounded as well. */
        const spacer=el('div',{style:{width:anim.frames.length*76+'px',height:'88px',position:'relative'}});strip.append(spacer);
        const frames=()=>{if(!strip.isConnected||!scroller)return;for(const cv of spacer.querySelectorAll('canvas'))observer.unobserve(cv);spacer.replaceChildren();const first=Math.max(0,Math.floor(strip.scrollLeft/76)-2),last=Math.min(anim.frames.length,first+Math.ceil((strip.clientWidth||scroller.clientWidth)/76)+4);
          for(let i=first;i<last;i++){const f=anim.frames[i],frame=button('','Frame '+(i+1)+' · sprite '+f.spriteId+' · '+f.duration+' game frames.',()=>L.select(anim,i));frame.className='library-frame'+(L.selected===anim&&L.frame===i?' on':'');frame.style.left=i*76+'px';frame.dataset.frame=i;frame.setAttribute('aria-label','Frame '+(i+1));frame.ondblclick=()=>A.openAnimation(anim,i);const cv=el('canvas',{width:64,height:56});frame.append(cv,el('span.num',null,(i+1)+' · '+(f.hold?'hold':f.duration+'f')));observe(cv,f.spriteId,64,56);if(S.project.sprites[f.spriteId])frame.append(el('i.edited'));if(L.usage(f.spriteId).length>1)frame.append(el('span.shared',null,'↔'));spacer.append(frame);}}
        strip.onscroll=frames;row.append(strip);requestAnimationFrame(frames);}
      content.append(row);
    }
    if(!rows.length)content.append(el('div.app-empty',null,el('b',null,'No matching frames.'),el('p.hint',null,'Try a sprite number, or choose All.')));
  }
  function drawDetail() {
    if(!detail)return;if(A.findings.group!=='characters'){A.findings.detail(detail);return;}detail.replaceChildren();const anim=L.selected,f=anim?.frames[L.frame];if(!f){detail.append(el('div.app-empty',null,el('b',null,'Choose an animation.'),el('p.hint',null,'Some streams begin with a game command and have no stand-alone frame.')));return;}
    detail.append(el('header.library-detail-head',null,el('h2',null,L.characters[L.character].name),el('span.num.faint',null,'Sprite '+f.spriteId)));
    const cv=el('canvas.library-preview',{width:288,height:260,'data-tip':'Preview|The selected sprite, drawn at its stored size.'});detail.append(cv);
    try {const im=S.image(f.spriteId),info=L.inspector(f.spriteId),doc=S.project.sprites[f.spriteId];if(doc)ArtPreview.draw(cv,doc,A.palette(),{width:288,height:260,arcade:A.arcade,flip:!!(f.flip&1),flipY:!!(f.flip&2)});else A.drawSprite(cv,im,{width:288,height:260,arcade:A.arcade,flip:!!(f.flip&1),flipY:!!(f.flip&2)});
      const c=S.resources.descriptor(f.spriteId),tiles=ArtCel.geometry(c).reduce((n,r)=>n+r.nx*r.ny,0);
      detail.append(el('div.library-facts',null,el('b',null,im.width+' × '+im.height+' · '+tiles+' tiles'),el('p.hint',null,'Used by '+info.uses.length+' frames of '+info.animationCount+' animations'),el('p.hint',null,info.roomSentence)));
      if(!anim.complete)detail.append(el('p.library-boundary',{'data-tip':'Preview ends early|After this point the game decides what comes next from the fight (commands, hits, conditions); the Studio cannot play that part without the running game.'},'Preview ends where the game decides what comes next.'));
      if(!A.hasPalettes)detail.append(el('p.app-limit',null,'Pen values shown in grey. Character colours await verified ROM palette rows.'));
      detail.append(el('div.library-actions',null,button('Edit','Open this sprite with its real animation frames.',()=>A.openAnimation(anim,L.frame),true),button('Export…','Save an indexed PNG at its exact pixel size.',()=>A.exportSprite(f.spriteId)),button('Import onto…','Match your picture to this sprite’s pens.',()=>A.importPictures(null,'frames'))));
      const shared=el('div.library-shared',null,el('h3',null,'Shared with'));
      for(const use of info.uses.filter(x=>x.id!==anim.id||x.frame!==L.frame).slice(0,5)){
        const owner=L.characters.find(c=>c.id===use.character)?.name,label=(owner&&!String(use.animationName).startsWith(owner)?owner+' · ':'')+use.animationName+' · frame '+(use.frame+1);
        const twin=button(label,'This frame shows the same sprite, so a change shows here too.',()=>L.openUse(use));
        const thumb=el('canvas',{width:48,height:48});twin.prepend(thumb);try{A.drawSprite(thumb,S.image(use.spriteId),{width:48,height:48,character:use.character});}catch(_){}shared.append(twin);
      }shared.append(button('Show all','See every frame this sprite’s change would show on.',()=>L.sharedSheet(f.spriteId)));detail.append(shared);
    }catch(e){detail.append(el('p.app-limit',null,'This picture needs another asset class: '+e.message));}
  }
  L.redrawFindings=()=>{if(!root)return;scroller.scrollTop=0;drawNav();drawRows();drawDetail();};
  L.projects=async()=>{const body=el('div.vbox');for(const p of await S.recent()){const row=el('div.hbox',null,button(p.name,'Open this locally saved project.',async()=>{await S.save();await S.restore(p.id);A.showView('library');}),button('Versions','Restore one of the last twenty saves.',async()=>{const versions=await S.versions(p.id);const list=el('div.vbox');for(const key of versions)list.append(button(new Date(Number(key.split(':')[1])).toLocaleString(),'Open this saved version.',async()=>{await S.save();await S.restore(p.id,key);A.showView('library');}));K.dialog({title:'Versions · '+p.name,body:list});}));body.append(row);}if(!body.children.length)body.append(el('p.hint',null,'Your saved projects will appear here.'));return K.dialog({title:'My projects',body,width:680});};
  A.view({id:'library',mount(host){root=el('div.art-library');nav=el('aside.library-nav');const middle=el('section.library-middle'),head=el('header.library-heading',null,el('h2.grow',null,'Animations'));for(const mode of ['all','edited','shared']){const b=button(mode[0].toUpperCase()+mode.slice(1),'Show '+mode+' animations.',()=>{filter=mode;for(const n of head.querySelectorAll('button'))n.classList.toggle('on',n===b);drawRows();});b.classList.toggle('on',filter===mode);head.append(b);}scroller=el('div.library-scroll');content=el('div.library-content');detail=el('aside.library-detail');L.findingsDetail=detail;scroller.append(content);middle.append(head,scroller);root.append(nav,middle,detail);host.append(root);if(g.CPS3Panels)g.CPS3Panels.attach(root,{id:'art.library',title:'Library',columns:[{el:nav,name:'Characters',size:220,min:160,max:420},{flex:true},{el:detail,name:'Sprite details',size:320,min:260,max:620}]});A.findings.account(root);observer=new IntersectionObserver(entries=>{for(const e of entries)if(e.isIntersecting)thumbnail(e.target);},{root:null,rootMargin:'100px'});scroller.onscroll=drawRows;drawNav();drawRows();drawDetail();
    const off=S.on('transport',t=>{if(L.selected&&t.frames===L.selected.frames&&t.index!==L.frame){L.frame=t.index;drawDetail();}}),off2=S.on('project',()=>{drawRows();drawDetail();});return{destroy(){generation++;off();off2();observer.disconnect();L.findingsDetail=null;root=nav=scroller=content=detail=null;}};
  }});
})(window);
