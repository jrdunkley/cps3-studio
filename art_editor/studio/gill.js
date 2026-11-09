/* Native timed body colours, using the palette editor's conversion, ramps and project history. */
(function(g){
  'use strict';
  const K=g.Kit,el=K.el,G=g.ArtGill;
  async function open(){
    const A=g.ArtStudio,S=A.state,program=S.resources.program,cat=G.catalogue(program);
    let half=0,step=1,pen=9,tick=0,running=false,animation=0,handle=0,started=0;
    const selection=new Set([pen]),animations=A.library.animations(0).filter(a=>a.frames.length);
    const allowed=!!G.layout(program);
    const title=el('b'),note=el('p.hint'),grid=el('div.gill-grid'),canvas=el('canvas.gill-preview',{width:384,height:224,'aria-label':'Gill animated colour preview'});
    const channels=[0,1,2].map((c)=>el('input.field.num',{type:'number',min:0,max:31,'aria-label':['Red step','Green step','Blue step'][c],onchange:()=>editColour()}));
    const phase=el('select.field',{'aria-label':'Gill phase',onchange:()=>{running=false;step=Number(phase.value);refresh();}},...cat.tables[0].phases.map(p=>el('option',{value:p.step,selected:p.step===1},'Phase '+p.step)));
    const halves=el('select.field',{'aria-label':'Gill body half',onchange:()=>{half=Number(halves.value);refresh();}},el('option',{value:0},'Body half A'),el('option',{value:1},'Body half B'));
    const timeline=el('input',{type:'range',min:0,max:199,value:0,'aria-label':'Gill native tick',oninput:()=>{running=false;tick=Number(timeline.value);step=G.state(cat,half,tick,{initial:false}).step;refresh();}});
    const animate=el('button.btn',{onclick:()=>{running=!running;started=performance.now()-tick*1000/59.59949;animate.textContent=running?'Pause cycle':'Play cycle';}},'Play cycle');
    const anim=el('select.field',{'aria-label':'Preview animation',onchange:()=>{animation=Number(anim.value);draw();}},...animations.map((a,i)=>el('option',{value:i},a.name)));
    const format=el('select.field',{'aria-label':'Gill palette format'},...['json','act','jasc','riff','png'].map(f=>el('option',{value:f},f.toUpperCase())));
    const button=(label,fn,editing=false)=>el('button.btn',{disabled:editing&&!allowed,onclick:()=>Promise.resolve().then(fn).catch(e=>K.toast(e.message,{kind:'bad'}))},label);
    const body=el('div.gill-editor',null,
      el('div.vbox',null,el('div.hbox',null,halves,phase,animate),title,timeline,grid,
        el('div.hbox',null,...channels.map((input,i)=>el('label.lab',null,el('span',null,['R','G','B'][i]),input))),
        el('div.hbox',null,button('Gradient',()=>change(words=>ArtRamps.gradient(words,[...selection].sort((a,b)=>a-b))),true),button('Reset selected',()=>change(words=>words.map((w,p)=>selection.has(p)?source().words[p]:w)),true),button('Undo',()=>{S.undo();refresh();}),button('Redo',()=>{S.redo();refresh();})),
        el('div.hbox',null,format,button('Export phase',exportPhase),button('Import phase',importPhase,true)),note),
      el('div.vbox',null,anim,canvas,el('p.hint',null,'The running cycle starts at phase 1. Phase 0 is also available for the game\'s reset state. Repeated phases and all colour choices share their stored sources.'),
        el('p.hint',null,'Select pens with Shift to build a ramp. R, G and B use the arcade\'s exact 0 to 31 steps. The last 16 colours of each body row keep their preceding writer and are edited with the stored rows.'),
        button('Open Deliver',()=>{close();A.showView('deliver');}),
        allowed?null:el('p.hint',null,'This source can be inspected here. Its timed-colour export is waiting for the source-specific runtime check.')));
    const dialog=K.dialog({title:'Gill \u00b7 timed body colours',body,width:1000});
    let closed=false;function close(){if(!closed){closed=true;document.querySelector('.dialog footer button')?.click();}}
    function source(){const table=cat.tables.find(t=>t.address===cat.colours[0].halves[half].table),p=table.phases[step];return cat.sources.find(s=>s.source===p.source);}
    function rows(){return G.resolve(program,S.project.gillEdits||[]);}
    function words(){const s=source();return rows().find(r=>r.source===s.source)?.words||s.words;}
    function change(fn){if(!allowed)throw new Error('Timed Gill writing is not verified on this source');const s=source(),list=rows(),after=Array.from(fn(words().slice()));const at=list.findIndex(r=>r.source===s.source);if(at<0)list.push({source:s.source,words:after});else list[at]={source:s.source,words:after};const edits=G.delta(program,list);S.edit('Change Gill timed colours',p=>{p.gillEdits=edits;});refresh();}
    function editColour(){const rgb=channels.map(input=>Number(input.value));change(w=>w.map((v,p)=>selection.has(p)?ArtRamps.word(rgb,v):v));}
    function refresh(){const s=source(),w=words();phase.value=step;title.textContent='Phase '+step+' \u00b7 '+s.uses.length+' phase references';note.textContent=selection.size+' selected \u00b7 '+(S.project.gillEdits||[]).reduce((n,e)=>n+e.changes.length,0)+' authored colour changes';
      grid.replaceChildren(...w.map((word,p)=>{const rgb=ArtPalette.rgb(word,'state');return el('button.gill-pen',{class:selection.has(p)?'on':'',style:{background:`rgb(${rgb.join(',')})`},'aria-label':'Pen '+p,'aria-pressed':selection.has(p),title:'Pen '+p+' \u00b7 '+ArtRamps.channels(word).join(', '),onclick:event=>{if(event.shiftKey){if(selection.has(p)&&selection.size>1)selection.delete(p);else selection.add(p);}else{selection.clear();selection.add(p);}pen=p;refresh();}},String(p));}));
      ArtRamps.channels(w[pen]).forEach((v,i)=>{channels[i].value=v;channels[i].disabled=!allowed;});draw();}
    function draw(){const a=animations[animation];if(!a)return;const i=A.transport.frameAt(tick,true,a.frames),frame=a.frames[i],image=S.image(frame.spriteId),native=ArtPalette.character(program,S.resources.data,{character:0,side:0,colour:0}).rows;
      const edited=new Map(rows().map(r=>[r.source,r.words])),timed=[0,1].map(h=>{const p=running?G.state(cat,h,tick,{initial:false}):cat.tables.find(t=>t.address===cat.colours[0].halves[h].table).phases[step];return edited.get(p.source)||p.words;});
      const rgba=new Uint8ClampedArray(image.pixels.length*4);for(let p=0;p<image.pixels.length;p++){const v=image.pixels[p];if(!v)continue;const r=image.paletteRows[p],h=r===0?0:r===8?1:-1,stored=native.find(n=>n.row===r);if(!stored)continue;const isTimed=h>=0&&v<48,word=isTimed?timed[h][v]:stored.words[v];if(word===undefined)continue;rgba.set([...ArtPalette.rgb(word,isTimed?'state':'dma'),255],4*p);}
      const src=el('canvas',{width:image.width,height:image.height}),ctx=src.getContext('2d');ctx.putImageData(new ImageData(rgba,image.width,image.height),0,0);const c=canvas.getContext('2d');c.clearRect(0,0,384,224);c.imageSmoothingEnabled=false;const z=Math.max(1,Math.floor(Math.min(360/image.width,208/image.height)));c.drawImage(src,Math.floor((384-image.width*z)/2),224-image.height*z,image.width*z,image.height*z);}
    async function exportPhase(){const f=format.value,bytes=await ArtPalFmt.write(f,words(),{metadata:{name:'Gill phase '+step}});K.download('gill-phase-'+step+'.'+({jasc:'pal',riff:'pal'}[f]||f),bytes,'application/octet-stream');}
    async function importPhase(){const picked=await K.pickFile('.json,.act,.pal,.png');const file=picked?.[0]||picked;if(!file)return;const ext=file.name.split('.').pop().toLowerCase(),result=await ArtPalFmt.read(ext==='pal'?'jasc':ext,new Uint8Array(await file.arrayBuffer()),{toRGB:w=>ArtPalette.rgb(w,'state')});if(result.report?.length)throw new Error('This import requires colour rounding. Use exact arcade steps before importing it.');if(result.words?.length!==48)throw new Error('A Gill timed phase needs exactly 48 colours');change(current=>result.words.map((w,i)=>(w&32767)|(current[i]&32768)));}
    const off=S.on('history',refresh);
    function frame(now){if(running){tick=Math.floor((now-started)*59.59949/1000);timeline.value=tick%200;step=G.state(cat,half,tick,{initial:false}).step;refresh();}handle=requestAnimationFrame(frame);}
    refresh();handle=requestAnimationFrame(frame);
    try{await dialog;}finally{closed=true;cancelAnimationFrame(handle);off();}
  }
  g.ArtGillEditor={open};
})(window);
