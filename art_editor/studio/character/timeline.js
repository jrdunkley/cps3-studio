'use strict';
window.ArtCharacterTimelineMount = function () {
  const $=id=>document.getElementById(id), S=()=>window.ArtCharacter;
  let pending=false;
  const root=document.createElement('section'); root.id='animation-panel'; root.className='character-timeline'; root.hidden=true;
  root.innerHTML=`<div class="character-timeline-head"><strong>Animation timing &amp; drawings</strong><button class="btn" id="animation-close">Close</button></div>
    <p id="animation-budget" class="num"></p><p id="animation-status" role="status"></p><label class="character-loop"><input type="checkbox" id="animation-proposed">Propose gameplay timing changes — requires build review</label>
    <div class="character-timeline-controls"><label>Selected drawing <input id="animation-ticks" class="field num" type="number" min="1" max="255" step="1" aria-label="Drawing duration"></label><span>ticks</span><button class="btn" id="animation-duration">Set duration</button>
    <button class="btn" id="animation-before">Insert before</button><button class="btn" id="animation-after">Insert after</button><button class="btn" id="animation-remove">Remove frame</button><button class="btn" id="animation-own">Make own drawing</button><button class="btn" id="animation-earlier">◀ Move earlier</button><button class="btn" id="animation-later">Move later ▶</button>
    <button class="btn" id="animation-undo">Undo sequence</button><button class="btn" id="animation-redo">Redo sequence</button><button class="btn" id="animation-reset">Use game sequence</button></div>
    <p id="animation-frame-note"></p><small>Edits save immediately, with backups. Inserts and Make own drawing make a separate editable copy (Make own drawing keeps the frame and its timing, so the frames that shared the drawing stop changing with it); removal keeps its PNG. Move earlier / later reorders: inside one game span the frame takes its ticks along; across a game boundary or a protected frame only the drawings swap. Fixed timing redistributes ticks within each game span. Proposal mode can change the budget; event records and command boundaries stay protected. Saved drafts need a reviewed build before appearing in game.</small>`;
  document.querySelector('.character-main').insertBefore(root,$('editor'));
  function sharing(s,a,i){
    const id=a.frames[i].spriteId,out=[];
    for(const x of s.project.animations){
      if(x.reference||String(x.id).startsWith('unwired:'))continue;
      x.frames.forEach((g,j)=>{if(g.spriteId===id&&!(x===a&&j===i))out.push(x===a?'frame '+(j+1):x.name+' frame '+(j+1));});
    }
    return out;
  }
  function refresh(){
    const s=S(),a=s?.active,info=a?.animationEdit,editing=!!s?.project?.animationEditor&&!s.project.avatar;
    $('animation-edit').disabled=!info||s?.busy||pending;
    $('animation-edit').title=info?'Edit drawing durations and sequence within the game timing budget':a?.pendingWiring?'Existing copy requests must be built first':'This list has no verified editable game timeline';
    $('ticks').disabled=!!info?.changed;
    if(!editing||!info){root.hidden=true;return;}
    const i=s.editor.state.playing?s.editor.state.previewIndex:s.editor.state.frameIndex,f=a.frames[i];
    if(!f)return;
    $('animation-budget').textContent=`Game: ${info.gameDrawings} drawings · ${info.gameTicks} stored ticks   |   Draft: ${info.drawings} drawings · ${info.ticks} stored ticks`;
    $('animation-status').textContent=info.stale?'Game sequence changed. The earlier draft is preserved; use the current game sequence to start again.':`${info.proposed?'GAMEPLAY TIMING PROPOSAL: '+(info.tickDelta>=0?'+':'')+info.tickDelta+' stored ticks; review required. ':info.timingMatches?'Timing budget matches. ':''}${info.protected} protected game records · ${a.commands.length} command records. ${info.changed?'Draft saved; build review required.':'Current game sequence.'}`;
    $('animation-status').classList.toggle('error',info.stale||info.proposed);
    $('animation-proposed').checked=info.proposed;
    const field=$('animation-ticks');if(document.activeElement!==field)field.value=f.duration;
    const twins=sharing(s,a,i);
    $('animation-frame-note').textContent=`Frame ${i+1}: ${f.locked?'Protected event record — '+f.reasons.join(', '):info.proposed?'Duration edits change the proposed game timing.':'Duration changes borrow from neighbouring drawings in the same game span.'} ${a.commands.length?'Stored ticks are a budget; branches and game events can change runtime duration.':''} ${twins.length?`Drawing ${f.spriteId} is also shown in ${twins.join(', ')}: painting it changes those too. Make own drawing gives this frame its own copy.`:`Only this frame shows drawing ${f.spriteId}.`}`;
    const disabled=pending||s.busy||s.editor.state.playing||info.stale;
    const canRetime=!f.locked||(info.proposed&&f.gameFields?.event_type!==255);
    for(const action of ['duration','before','after','remove']) $('animation-'+action).disabled=disabled||(action==='duration'?!canRetime:f.locked)||((action==='before'||action==='after')&&(!info.proposed&&f.duration<2));
    const reference=!s.records.get(f.spriteId)?.editable;
    $('animation-own').disabled=disabled||(!twins.length&&!reference);
    for(const [action,j] of [['earlier',i-1],['later',i+1]]){
      const b=$('animation-'+action),g=a.frames[j],whole=g&&g.block===f.block&&!g.locked&&!f.locked;
      b.disabled=disabled||!g||g.spriteId===f.spriteId;
      b.title=!g?`Frame ${i+1} is already the ${action==='earlier'?'first':'last'} frame.`:g.spriteId===f.spriteId?`Frame ${j+1} shows the same drawing.`:
        whole?`Move frame ${i+1} (drawing ${f.spriteId}, ${f.duration} ticks) ${action==='earlier'?'before':'after'} frame ${j+1}; its ticks move with it, inside the same game span.`:
        `Frame ${j+1} is ${g.locked||f.locked?'a protected game record':'across a game timing boundary'}: swaps only the drawings ${f.spriteId} and ${g.spriteId}; each frame keeps its ticks and game record.`;
    }
    $('animation-own').title=twins.length?`Give frame ${i+1} its own drawing (a copy of ${f.spriteId}, same timing). ${twins.join(', ')} keep ${f.spriteId}.`:reference?`Give frame ${i+1} an editable drawing of its own (a copy of the original ${f.spriteId}, same timing and game record).`:`Only this frame shows drawing ${f.spriteId}.`;
    field.disabled=disabled||!canRetime;
    $('animation-proposed').disabled=disabled;
    $('animation-undo').disabled=disabled||!info.undo;
    $('animation-redo').disabled=disabled||!info.redo;
    $('animation-reset').disabled=pending||s.busy||(!info.changed&&!info.stale);
    $('ticks').disabled=!!info.changed;
  }
  async function act(action){
    const s=S();if(pending||s.busy||!s.active?.animationEdit)return;
    const proposed=$('animation-proposed').checked,ticks=Number($('animation-ticks').value);
    s.editor.state.canvas.finish();s.editor.state.playing=false;
    const a=s.active,info=a.animationEdit,index=s.editor.state.frameIndex,f=a.frames[index];
    const body={animation:a.id,revision:info.revision,baseHash:info.baseHash,action,index};
    if(action==='mode')body.proposed=proposed;
    if(action==='duration')body.ticks=ticks;
    if(action==='before'||action==='after'||action==='own'){
      body.hash=s.records.get(f.spriteId).hash;
      if(!s.records.get(f.spriteId).editable)body.sourcePens=s.records.get(f.spriteId).pens;
      const pixels=ArtDoc.flatten(s.documents.get(f.spriteId));let text='';for(let i=0;i<pixels.length;i+=8192)text+=String.fromCharCode(...pixels.subarray(i,i+8192));body.pens=btoa(text);
    }
    pending=true;refresh();s.message('Saving animation…');
    try{
      const response=await fetch(s.api('animation'),{method:'POST',headers:{'Content-Type':'application/json','X-Studio-Token':s.project.token},body:JSON.stringify(body)});
      const result=await response.json();if(!response.ok)throw Error(result.error||response.statusText);
      s.adoptAnimation(result,index+(action==='after'||action==='later'?1:action==='earlier'?-1:0));     // selection follows the moved drawing
      s.message(`Animation saved. ${result.animation.frames.length} drawings; ${result.animation.animationEdit.proposed?'gameplay timing PROPOSAL':'stored timing budget kept'}. ${result.sprite?'New drawing '+result.sprite.id+' is ready to paint. ':''}Build review is required to use this sequence in game.`);
    }catch(error){s.message('Animation not saved: '+error.message,true);}
    finally{pending=false;refresh();}
  }
  $('animation-edit').onclick=()=>{root.hidden=!root.hidden;refresh();};
  $('animation-close').onclick=()=>{root.hidden=true;};
  for(const action of ['duration','before','after','remove','own','earlier','later','undo','redo','reset'])$('animation-'+action).onclick=()=>act(action);
  $('animation-ticks').onkeydown=event=>{if(event.key==='Enter'){event.preventDefault();act('duration');}};
  $('animation-proposed').onchange=()=>act('mode');
  window.ArtCharacterTimeline={refresh,act,get busy(){return pending;}};
};
