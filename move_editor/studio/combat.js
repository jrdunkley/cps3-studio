(function(g){'use strict';
 const K=Kit,el=K.el,C=CPS3MoveCombat,$=id=>document.getElementById(id);
 const P=g.MoveOpponent={game:null,ready:false,active:false,busy:false,playing:false,position:0,frames:[],baseline:null,stats:null,dirty:true};
 let app,host,canvas,ctx,message,readout,recipeLabel,selection,opponent=11,distance=48,rate=1,epoch=0,frames=null,stamp='',snapshot=null,runId=0;
 const error=e=>{message.textContent=e.message;K.toast(e.message,{kind:'bad'});};
 function button(label,fn,id){return el('button.btn',{type:'button',id,onclick:()=>Promise.resolve().then(fn).catch(error)},label);}
 function pause(){P.playing=false;runId++;if($('hit-play'))$('hit-play').textContent='Play';}
 function busy(on,text){P.busy=on;for(const b of host.querySelectorAll('button,select,input'))b.disabled=on;if(text)message.textContent=text;}
 function choice(label,id,options,fn){return el('label',null,label,el('select.field',{id,'aria-label':label,onchange:fn},...options.map(([v,t])=>el('option',{value:v},t))));}
 async function bios(s){let member=await CPS3Studio.loadBios(s);if(!member){const zips=await Cps3Rom.restoreZips(K.store(s.store));for(const bytes of Object.values(zips||{})){const m=await KitZip.read(bytes,{only:n=>n.endsWith(Cps3GameRom.BIOS_MEMBER)});member=Object.values(m)[0];if(member)break;}}if(!member)throw Error('Choose the game ZIPs again to load its BIOS.');return Cps3GameRom.bios({[Cps3GameRom.BIOS_MEMBER]:member});}
 async function settings(s){const modes=s.modes&&s.mode!==null?await CPS3Studio.loadSettings(s):null;return modes?.[s.mode]?{eeprom:modes[s.mode],freePlay:true}:{freePlay:true,mode:s.mode,modeOffsets:s.modeOffsets};}
 function draw(p){ctx.putImageData(new ImageData(p.rgba,384,224),0,0);P.shown=p.frame;P.game.releaseFrame(p);}
 async function stats(){const bytes=await P.game.peek(C.players[0],0x498*2),p=[C.state(bytes.slice(0,0x498)),C.state(bytes.slice(0x498))];P.stats={players:p,damage:160-p[1].hp,frame:P.position,matched:P.stats?.matched||p[0].stream===app.move.address};readout.textContent='Frame '+P.position+' · Damage '+P.stats.damage+' · Opponent HP '+p[1].hp+' · Hit stop '+Math.abs(p[1].hitstop)+(P.stats.matched?' · Selected sequence reached':'');return p;}
 P.invalidate=()=>{P.dirty=true;epoch++;pause();if(P.active)message.textContent='Edits changed. Test hit will rebuild the preview.';};
 P.selectionChanged=()=>{pause();if(!app)return;frames=null;P.dirty=true;if(P.busy){epoch++;P.dirty=true;}const name=ArtAnimationNames[app.move?.id],r=C.recipe(name);recipeLabel.textContent=r?'Input: '+r.label:'Use the input controls below for this sequence.';selection=r;P.stats=null;};
 P.mount=(a)=>{app=a;host=el('section.hit-preview',{hidden:true});canvas=el('canvas#hit-canvas',{width:384,height:224,'aria-label':'Hit preview against an opponent'});ctx=canvas.getContext('2d');message=el('p.hint#hit-message',null,'Choose an opponent, then test your move.');readout=el('p.hint#hit-stats');recipeLabel=el('span.hint');
  const opponentField=choice('Opponent','hit-opponent',app.model.characters.map(ch=>[ch.id,ch.name]),e=>{opponent=+e.target.value;P.invalidate();});opponentField.querySelector('select').value=opponent;
  const spacing=choice('Spacing','hit-spacing',[[48,'Close'],[88,'Medium'],[150,'Far']],e=>{distance=+e.target.value;P.invalidate();});
  const test=button('Test selected move',()=>P.test(),'hit-test');test.classList.add('primary');
  const tools=el('div.hit-tools',null,opponentField,spacing,test,button('Reset',()=>P.reset(),'hit-reset'));
  const transport=el('div.hit-tools',null,button('Play',()=>P.toggle(),'hit-play'),button('−1 frame',()=>P.back(),'hit-back'),button('+1 frame',()=>P.step(),'hit-step'),choice('Speed','hit-speed',[[1,'1×'],[.5,'½×'],[.25,'¼×']],e=>{rate=+e.target.value;}),el('label',null,el('input#hit-pause',{type:'checkbox'}),'Pause on hit'));
  const attacks=choice('Input','hit-input',[['lp','LP'],['mp','MP'],['hp','HP'],['lk','LK'],['mk','MK'],['hk','HK'],['throw','Throw']],()=>{}),motion=choice('Motion','hit-motion',[['stand','Standing'],['down','Crouching'],['qcf','↓ ↘ →'],['qcb','↓ ↙ ←'],['dp','→ ↓ ↘'],['double','↓ ↘ → ↓ ↘ →'],['jump','Jump']],()=>{});
  host.append(tools,el('div.hit-screen',null,canvas),message,readout,transport,el('div.hit-tools',null,recipeLabel),el('details.hit-inputs',null,el('summary',null,'Try another input'),el('div.hit-tools',null,motion,attacks,button('Run input',()=>P.custom(),'hit-custom'))),el('p.hint.hit-footnote',null,'Controlled matchup · the game runs your built project, including collision, reactions and effects.'));
  return host;
 };
 P.open=()=>{P.active=true;host.hidden=false;P.selectionChanged();};
 P.close=()=>{P.active=false;pause();host.hidden=true;};
 async function prepare(){pause();const current=++epoch;busy(true,'Building your move edits and loading the matchup…');try{
  const built=await app.build(),s=CPS3Studio.source(),key=[await Cps3Rom.sha256(built.program),await Cps3Rom.sha256(built.data),CPS3Sources.key(s),app.character,opponent,distance].join(':');
  if(key!==stamp||!P.ready){P.ready=false;P.game?.destroy();P.game=await Cps3Game.create({program:built.program,data:built.data,bios:await bios(s),allowFixtures:true});P.game.onFrame=draw;P.game.onFault=f=>{pause();error(Error('Preview stopped at CPU fault '+f.fault));};
   const start=await P.game.readyStart(await settings(s));if(!start.facts.ok)throw Error('The game could not reach character select.');
   message.textContent='Loading '+app.model.characters[app.character].name+' and '+app.model.characters[opponent].name+'…';
   await P.game.call('fixture',{steps:C.select(app.character,opponent)});let next;for(let i=0;i<30;i++){next=C.next(await P.game.peek(0x02015436,0x78));if(!next)break;await P.game.call('fixture',{steps:next});}if(next)throw Error('The matchup did not reach the fighting scene.');const p=await stats();if(p[0].character!==app.character||p[1].character!==opponent||p.some(x=>x.hp!==160))throw Error('This matchup did not reach its expected starting state.');
   await P.game.call('fixture',{steps:C.place(distance)});snapshot=await P.game.save();stamp=key;P.images={program:key.split(':')[0],data:key.split(':')[1],source:s.id,mode:s.mode};P.ready=true;
  }
  if(current!==epoch)throw Error('The selection or edits changed while loading. Test again to use the latest version.');await restore();P.dirty=false;message.textContent='Ready. The preview uses your latest built project.';
 }catch(e){P.ready=false;throw e;}finally{busy(false);}}
 async function restore(){pause();await P.game.load(snapshot.bytes,snapshot.inspection);await P.game.input({p01:0,p23:0});P.position=0;P.stats=null;await stats();}
 P.reset=async()=>{if(P.busy)return;if(!P.ready||P.dirty)return prepare();await restore();message.textContent='Starting position restored.';};
 async function advance(){if(P.position>=frames.length)return false;const previousStop=P.stats?.players[1].hitstop||0,w=frames[P.position++];await P.game.run({inputs:[w],render:'last'});const p=await stats();if($('hit-pause').checked&&!previousStop&&p[1].hitstop!==0){pause();message.textContent='Paused on contact. Step forward to inspect the reaction and hit spark.';}return true;}
 async function play(){if(P.busy)return;P.playing=true;$('hit-play').textContent='Pause';const id=++runId;let next=performance.now();while(P.playing&&id===runId&&P.active){if(!await advance()){pause();message.textContent=P.stats?.matched?'Replay complete. Test again to rebuild and replay.':'Replay complete. This input did not reach the selected sequence; adjust spacing or use another input.';break;}next+=1000/(59.59949*rate);await new Promise(r=>setTimeout(r,Math.max(0,next-performance.now())));}}
 P.test=async()=>{if(P.busy)return;P.selectionChanged();if(!selection){message.textContent='This sequence needs a custom input. Choose a motion and attack under “Try another input”.';return;}await prepare();frames=selection.inputs;P.frames=frames;await play();};
 P.toggle=async()=>{if(P.busy)return;if(P.playing)return pause();if(!P.ready||P.dirty||!frames)return P.test();if(P.position>=frames.length)await restore();await play();};
 P.step=async()=>{if(P.busy)return;pause();if(!P.ready||P.dirty){await prepare();frames=selection?.inputs||Array.from({length:120},()=>[0,0]);P.frames=frames;}if(!frames)frames=selection?.inputs||Array.from({length:120},()=>[0,0]);await advance();};
 P.back=async()=>{if(P.busy||!P.ready||P.dirty||!P.position)return;pause();await P.game.rewind(1);P.position--;await stats();};
 P.custom=async()=>{if(P.busy)return;await prepare();const key=$('hit-input').value,m=$('hit-motion').value,steps=[],press=names=>steps.push({press:names.map(n=>'p1.'+n),frames:2});if(m==='jump')steps.push({press:['p1.up'],frames:1,then:10});for(let n=0;n<(m==='double'?2:1);n++){if(m==='qcf'||m==='double'){press(['down']);press(['down','right']);press(['right']);}if(m==='qcb'){press(['down']);press(['down','left']);press(['left']);}if(m==='dp'){press(['right']);press(['down']);press(['down','right']);}}
  steps.push({press:[...(key==='throw'?['p1.lp','p1.lk']:['p1.'+key]),...(m==='down'?['p1.down']:[])],frames:1,then:179});frames=Cps3GameCore.framesOf(steps);P.frames=frames;await play();};
 P.dispose=()=>{pause();epoch++;P.game?.destroy();P.game=null;P.ready=false;stamp='';snapshot=null;};window.addEventListener('pagehide',P.dispose);
})(window);
