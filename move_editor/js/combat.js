/* Controlled authoring setup, made from the user's own images. Cursor recipe: naming2/roster.py;
   two-player ready start: game/start.js. Hidden fighters use selection-byte overrides. No instruction
   patches or shipped state. Native loader, collision, damage, effects and reaction code run normally. */
(function(g){'use strict';
 const cursors=[[6,0],[1,0],[5,2],[6,1],[3,2],[4,0],[1,2],[3,0],[2,2],[4,2],[0,1],[0,2],[2,0],[5,0],[6,0],[6,0],[3,1],[2,1],[4,1],[1,1],[5,1]],players=[0x02068c6c,0x02069104];
 const Core=()=>g.Cps3GameCore||(typeof require==='function'?require('../../studio_kit/game/core'):null);
 function select(p1,p2){if(![p1,p2].every(n=>Number.isInteger(n)&&n>=0&&n<21))throw Error('Choose two characters.');const steps=[];
  for(let f=1;f<=900;f++){const pressed=[61,125,189,300].some(s=>f>=s&&f<s+4),w=Core().words(pressed?['lp']:[],pressed?['lp']:[]),writes=[];
   if(f===46)for(const [side,ch]of [p1,p2].entries())writes.push([0x020154cf+2*side,cursors[ch][0]],[0x0201566b+2*side,cursors[ch][1]]);
   if(f>=61&&f<=150)for(const [side,ch]of [p1,p2].entries())if(ch===0||ch===15)writes.push([0x02011387+side,ch]);
   if(f===150)for(const [side,ch]of [p1,p2].entries())writes.push([0x02016cf8+side,ch]);
   steps.push({input:[w.p01,w.p23],writes});
  }return steps;
 }
 function place(distance){if(!Number.isInteger(distance)||distance<24||distance>240)throw Error('Spacing must be 24 to 240 pixels.');const writes=[];for(const [i,b]of players.entries()){const x=512+(i?Math.ceil(distance/2):-Math.floor(distance/2));writes.push([b+0x64,x>>>8],[b+0x65,x&255],[b+0x66,0],[b+0x67,0]);}return [{input:[0,0],writes},{input:[0,0]}];}
 function state(bytes){const b=Uint8Array.from(bytes),d=new DataView(b.buffer),u=o=>d.getUint16(o),i=o=>d.getInt16(o);return {character:u(0x3c0),hp:i(0x9e),x:i(0x64),y:i(0x68),state:[u(0x26),u(0x28),u(0x2a)],hitstop:i(0x44),stream:d.getUint32(0x200),cel:u(0x21a)};}
 function recipe(name){let m=/^(?:(cl|d|f|b|u|ub|uf)_)?(LP|MP|HP|LK|MK|HK)$/.exec(name||'');if(m){const dir=m[1],key=m[2].toLowerCase(),steps=[];if(dir?.startsWith('u'))steps.push({press:['p1.up',...(dir==='ub'?['p1.left']:dir==='uf'?['p1.right']:[])],frames:1,then:10});steps.push({press:['p1.'+key,...(dir==='d'?['p1.down']:dir==='f'?['p1.right']:dir==='b'?['p1.left']:[])],frames:1,then:119});return {label:name.replaceAll('_',' '),inputs:Core().framesOf(steps)};}if(/^throw_(neutral|forward|back)$/.test(name||''))return {label:name.replaceAll('_',' '),inputs:Core().framesOf([{press:['p1.lp','p1.lk',...(name.endsWith('back')?['p1.left']:name.endsWith('forward')?['p1.right']:[])],frames:1,then:179}])};return null;}
 /* Scene bytes start at G_No (02015436). Infinite has extra team selections; Gill has a longer
    intro. Confirm only while character select is active, then wait for the actual fighting scene. */
 function next(bytes){const u=o=>(bytes[o]<<8)|bytes[o+1];if(u(2)===2&&u(0x70)===2)return null;const selecting=u(2)===1&&u(4)===1;return Array.from({length:80},(_,i)=>{const w=Core().words(selecting&&i>=10&&i<14?['lp']:[],selecting&&i>=10&&i<14?['lp']:[]);return {input:[w.p01,w.p23]};});}
 const api={select,place,state,recipe,next,players,cursors};if(typeof module==='object'&&module.exports)module.exports=api;else g.CPS3MoveCombat=api;
})(typeof window!=='undefined'?window:globalThis);
