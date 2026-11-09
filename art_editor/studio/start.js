(function(g){'use strict';const A=g.ArtStudio,el=Kit.el;
 A.view({id:'start',mount(host){
  const recent=el('div.start-recent'),characters=el('div.start-characters'),root=el('section.start-screen',null,
   el('div.start-heading',null,el('div',null,el('h1',null,'Make artwork for the game.'),el('p.hint',null,'Choose a character, return to your work, or bring in a picture.')),el('span.tag',null,'21 characters · your ROM')),
   el('h3',null,'Browse the characters'),characters);
  for(const ch of A.library.characters){
   const b=A.button(ch.name,'Browse '+ch.name+' and open an animation.',()=>{A.showView('library');A.library.selectCharacter(ch.id);});b.className='btn ghost start-character';b.dataset.startCharacter=ch.id;
   const cv=el('canvas',{width:56,height:96});b.replaceChildren(cv,el('span',null,ch.name));characters.append(b);
   const idle=A.library.animations(ch.id).find(a=>a.frames.length);
   if(idle)try{A.drawSprite(cv,A.state.image(idle.frames[0].spriteId),{width:56,height:96,character:ch.id,slot:0,fill:true});cv.dataset.sprite=idle.frames[0].spriteId;}catch(error){cv.title=error.message;}
  }
  const doors=[['art-tiles','Everything in the ROM','All '+A.everythingModel().rows.length.toLocaleString('en-US')+' sprites, named or unknown.',()=>A.showView('library:everything')],['library','Browse the characters','Find a frame, then draw on its sprite.',()=>A.showView('library')],['folder','Open a project','Return to your layers and colour edits.',()=>Kit.run('art.open')],['import','Import pictures','Match a picture to the game’s pens.',()=>{A.showView('library');A.importPictures();}],['tune','Edit colours','Work in exact arcade colour steps.',()=>A.showView('palettes')]];
  root.append(el('div.start-doors',null,doors.map(([icon,title,text,run])=>{const b=A.button(title,text,run);b.className='btn ghost start-door';b.dataset.startDoor='';b.replaceChildren(Kit.icon(icon),el('span',null,el('b',null,title),el('small.hint',null,text)));return b;})),
   el('div.start-heading',null,el('h3',null,'Recent projects'),el('span.faint',null,'Saved on this computer')),recent,
   el('div.hbox',null,A.button('Help','Short guides to the main tasks.',()=>A.help.show()),A.button('What is available','What Art can do, and what it cannot do yet.',()=>A.help.show(4))));
  host.append(root);let live=true;
  const loaded=A.state.recent().then(items=>{if(!live)return;recent.replaceChildren(...items.sort((a,b)=>b.time-a.time).slice(0,6).map(p=>{
   const b=A.button(p.name,'Open this locally saved project.',async()=>{await A.state.save();await A.state.restore(p.id);A.showView('library');});b.className='btn ghost start-project';b.dataset.recentProject=p.id;
   const cv=el('canvas',{width:88,height:88});b.replaceChildren(cv,el('span',null,el('b',null,p.name),el('time.hint',{dateTime:new Date(p.time).toISOString()},new Date(p.time).toLocaleString([], {day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}))));
   if(p.spriteId!==undefined)try{A.drawSprite(cv,A.state.image(p.spriteId),{width:88,height:88,character:p.character,slot:p.colour,pens:ArtDoc.flatten(p.document),words:p.paletteWords});cv.dataset.sprite=p.spriteId;}catch(error){cv.title=error.message;}
   else{cv.replaceWith(Kit.icon('folder'));}return b;
  }));if(!items.length)recent.append(el('p.hint.start-no-projects',null,'Your saved projects will appear here. Open a frame to begin.'));}).catch(error=>Kit.status('Could not list projects: '+error.message));
  return{loaded,destroy(){live=false;}};
 }});
})(window);
