/* Engine counters describe their native units; no board throughput is inferred. */
(function(g){
 'use strict';const K=Kit,el=K.el;let current=null,paint=null;
 function rows(m){return [
  ['Emulated CPU before idle',m.busyCycles+' / '+4*m.sliceCycles+' cycles ('+(100*m.busyCycles/(4*m.sliceCycles)).toFixed(1)+'%)'],
  ['CPU slices without idle',m.overruns+' / 4'],['Character uploads',m.charDma+' requests'],['Palette uploads',m.palDma+' requests'],['Sprite-list copies',m.sprDma+' requests'],
  ['Sprite subrecords drawn',m.sprites],['Blended subrecords',m.blended],['IRQ 10 / 12 taken',m.irq10+' / '+m.irq12],['Mixed sound',m.audioSamples+' stereo samples'],['Zoom register',m.zoom],['Renderer error',m.renderError],['Unmodelled on-chip accesses',m.onchipUnmodelled]
 ];}
 async function open(){
  const body=el('div.vbox'),table=el('div.game-resource-table');body.append(table,el('p.hint',null,'Counters cover the most recently emulated frame. Four CPU slices each have '+(current?.sliceCycles||104166)+' cycles. Upload counts are requests, without a byte or time estimate. Sprite counts are drawn subrecords, which may contain several tiles.'),el('p.hint',null,'These figures come from the emulator. They are not timings measured on a real board, and they do not show free space in the ROM.'));
  const dialog=K.dialog({title:'Frame resources',body,width:650});paint=()=>{if(current)table.replaceChildren(...rows(current).flatMap(([name,value])=>[el('small',null,name),el('span.num',null,String(value))]));};paint();try{await dialog;}finally{paint=null;}
 }
 g.GameResources={update(m){current=m;paint?.();},open,rows};
 document.addEventListener('DOMContentLoaded',()=>{K.action({id:'game.resources',title:'Frame resources',hint:'See what the machine did this frame: processor, graphics uploads, drawing and colours.',group:'Game',enabled:()=>GameStudio.ready,run:open});K.bind(document.getElementById('resources'),'game.resources');});
})(window);
