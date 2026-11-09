/* Lazy metadata worker: loading the complete graph never blocks drawing or scrolling. */
(function (g) {
  'use strict';
  let worker, ready, serial = 0;
  const pending = new Map();
  function call(op, value) {
    const request = ++serial;
    return new Promise((resolve, reject) => {
      pending.set(request, { resolve, reject });
      worker.postMessage({ request, op, ...value });
    });
  }
  function load() {
    if (ready) return ready;
    const url = URL.createObjectURL(new Blob([g.ArtDiscoveryWorkerSource], { type: 'text/javascript' }));
    worker = new Worker(url); URL.revokeObjectURL(url);
    worker.onmessage = ({ data }) => {
      const p = pending.get(data.id); if (!p) return;
      pending.delete(data.id); data.error ? p.reject(new Error(data.error)) : p.resolve(data.value);
    };
    worker.onerror = event => {
      for (const p of pending.values()) p.reject(new Error(event.message || 'Discovery worker failed.'));
      pending.clear(); worker.terminate(); ready = null;
    };
    const S = ArtStudio.state;
    const started=worker;
    ready = call('init', { rom: { program: S.resources.program, data: S.resources.data },
      source: { ...CPS3Studio.source(), program: S.romHash } }).catch(error=>{if(worker===started){started.terminate();worker=null;ready=null;}throw error;});
    return ready;
  }
  async function inspect(id) { await load(); return call('inspect', { id }); }
  async function search(query, filter = {}) { await load(); return call('search', { query, filter }); }
  async function show(id, open) {
    const K = Kit, el = K.el, body = el('div.vbox', null, el('p.hint', null, 'Reading uses from your game…'));
    const dialog = K.dialog({ title: 'What uses this?', body, width: 760 });
    let revision = 0;
    async function render(target) {
      const token = ++revision;
      try {
        const result = await inspect(target); if (token !== revision || !dialog.el.isConnected) return;
        const record = result.record;
        if (!record) { body.replaceChildren(el('p', null, 'This asset has no parsed usage record yet.')); return; }
        const link = (id, name) => el('button.btn.ghost', { onclick: () => render(id) }, name || id);
        const roleName = role => ({'observed-artwork':'Artwork in this context','consumer-table-artwork':'Listed car artwork','palette-preview-artwork':'Artwork using this palette preview','stored-colour-correspondence':'Stored colour source','stage-table-artwork':'Listed stage artwork','listed-for-stage':'Stage','native-bank-candidate':'Stored stage colour candidate'}[role] || role);
        body.replaceChildren(el('b', null, record.name || record.id),
          el('p.hint', null, record.state === 'observed' ? 'Recorded context · Original ROM only. Other uses and scene phases remain unresolved.' : 'Table evidence · ' + record.state + '. A table reference does not prove a scene was reached.'),
          el('p', null, result.total + ' incoming references' + (result.total > result.uses.length ? ' (first 500 shown)' : '')));
        if (record.kind === 'sprite' && open) body.append(el('button.btn.primary', { onclick: () => { dialog.close();
          if(result.uses.some(use=>use.record?.kind==='palette-context')){ArtStudio.showView('library:everything');ArtStudio.everything.select(record.number);}else open(record.number);
        } }, 'Open artwork'));
        if(record.intent)body.append(el('p',null,record.intent));
        if(record.kind==='composition')body.append(el('p',null,record.groups+' map group · '+record.bands+' bands · '+record.size+' bytes'));
        if(record.status)body.append(el('p.hint',null,'Recipe: '+record.status+' · '+record.frames+' frames'));
        for(const note of record.obstructions||[])body.append(el('p.hint',null,note));
        if(record.fields)body.append(el('details',null,el('summary',null,'Native fields'),el('pre',null,JSON.stringify(record.fields,null,2))));
        const refs = record.references || [], isArt = ref => ['consumer-table-artwork','palette-preview-artwork'].includes(ref.role), artwork = refs.filter(isArt);
        for (const ref of refs.filter(ref => !isArt(ref))) body.append(el('div.hbox', null, el('small', null, roleName(ref.role)), link(ref.target)));
        if (artwork.length) {
          const artList = el('div.vbox', { style: 'max-height:240px;overflow:auto' });
          for (const ref of artwork) artList.append(link(ref.target, 'Sprite ' + ref.target.split(':')[1]));
          body.append(el('details', null, el('summary', null, artwork.length.toLocaleString('en-GB') + (artwork[0].role === 'consumer-table-artwork' ? ' car artwork references' : ' artwork palette previews')), artList));
        }
        const list = el('div.vbox', { style: 'max-height:360px;overflow:auto' });
        for (const use of result.uses) list.append(el('div.hbox', null, el('small', null, roleName(use.role)), link(use.id, use.record?.name || use.id)));
        body.append(list);
        if (!result.total) body.append(el('p.hint', null, record.state === 'observed' ? 'No additional users have been linked to this recorded context.' : 'No incoming reference was found in these parsed tables. Reachability remains unknown.'));
      } catch (error) { body.replaceChildren(el('p', null, error.message)); }
    }
    render(id); return dialog;
  }
  function mount(host,{kind='scene'}={}){
    const K=Kit,el=K.el,A=ArtStudio;let revision=0,destroyed=false;
    const query=el('input.field',{type:'search',placeholder:'Find scenes, compositions or colour sources','aria-label':'Search discovery'}),filter=el('select.field',{'aria-label':'Discovery kind'}),count=el('span.faint.num'),rows=el('div.vbox',{style:{overflow:'auto',minHeight:'0',padding:'12px'}});
    for(const [id,name]of [['scene','Scenes'],['composition','Scene compositions'],['map-band','Map bands'],['stage-art-use','Stage artwork references'],['stage-variant','Stage variants'],['colour-choice','Colour choices'],['palette-context','Artwork colour contexts'],['palette-source','Palette sources'],['animation','Animations'],['sprite','Sprites']])filter.append(el('option',{value:id},name));filter.value=kind;
    const panel=el('section.vbox',{style:{height:'100%',minHeight:'0',padding:'12px'}},el('div.hbox',null,A.button('Library','Return to the artwork library.',()=>A.showView('library')),el('h2.grow',null,'Discovery'),count),el('div.hbox',null,query,filter),el('p.hint',null,'Read from the loaded source. Scene recipes retain their prerequisites and observed obstructions.'),rows);host.append(panel);
    async function draw(){const token=++revision;count.textContent='Reading…';try{const found=await search(query.value,{kind:filter.value});if(destroyed||token!==revision)return;rows.replaceChildren();count.textContent=found.total.toLocaleString('en')+' records'+(found.total>found.records.length?' · first '+found.records.length:'');for(const record of found.records){const button=A.button(record.name||record.id,'Inspect references, source fields and recipe prerequisites.',()=>show(record.id,id=>A.openSprite(id)));button.style.textAlign='left';button.append(el('small.faint',{style:{display:'block'}},record.kind+' · '+(record.status||record.state)));rows.append(button);}if(!found.total)rows.append(el('p.hint',null,'No records match. Change the kind or search text.'));}catch(error){if(!destroyed&&token===revision){count.textContent='Unavailable';rows.replaceChildren(el('p',null,error.message));}}}
    query.oninput=filter.onchange=draw;draw();return {destroy(){destroyed=true;revision++;host.replaceChildren();}};
  }
  g.ArtDiscovery = { load, inspect, search, show, mount };
})(window);
