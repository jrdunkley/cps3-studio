/* Public source identities. Compatibility is an operation-specific proof, not a version guess.
 * A game set is recognised by the SHA-256 of its decrypted 16 MiB program image (program) and of its 64 MiB
 * graphics and sound image (data). Every released Infinite set is listed by both, oldest first; the newest is the
 * current release. Hashes from 1.04 on were measured by rebuilding each release from the Infinite client's own
 * replay vault (Infinite/runtime-vault/<version>/rom-patch.json applied to the current set) and hashing the result
 * with this Studio's ROM reader; 1.033's from its release folder. A release whose program equals an earlier one's
 * (1.05a kept 1.041b's game) is one entry. When a release ships, add its row here: the suite fails on a version
 * string older than CURRENT anywhere in the package. */
(function(g){
  'use strict';
  const data='605dec69e5895663cdd99f01e3f6bcdb62e10073b475d3b876f1ddd065a0f350',bios='8303455407cef92fde62ab6509515cacd0878e21eaa9c3295aca916614d60b3a';
  const original={id:'original',title:'Original game',short:'Original',store:'rom',pack:'music',program:'35ac2d569893926599b0f68d772e98f412573fb76b305ba3ed910f6136dd2de0',data,bios,about:'Street Fighter III 3rd Strike · Japan 990512 NO CD (rev 1)',hint:'The original game: Fightcade’s sfiii3nr1.zip and sfiii3.zip (Fightcade\\emulator\\fbneo\\ROMs).',runtime:[],listed:true};
  /* [id, version, program, data] in release order. The ids of 1.033 and 1.04 are kept (saved projects name them). */
  const RELEASES=[
    ['infinite','1.033','0d97e70a16b287bd5ffc16c8119d35e0748e59aa02dd3c316762275bee52c10d',data],
    ['infinite104','1.04','cd05243fa991ea252d78d0f214393fb8c40a1bce3ebd08d511521ecab18f3f9e',data],
    ['infinite1041','1.041','d172e4cbc0960b82fd9fbe7ecc52b99cad29410dc3047805199ac9a81e653beb',data],
    ['infinite1041b','1.041b / 1.05a','3fa956f00059f02d44a032167b40af8f9314972dc299aac7f44f77924c52e739',data],
    ['infinite105b','1.05b','28be8963cdf27e79025f5a5f12ee3045a176a6ad7986cfe11c02c64646688f39',data],
    ['infinite105c','1.05c','e346e10c574780fd7529a5032579cc4b7ca93cea79d146f7dce20d1f50f27f03',data],
    ['infinite106','1.06','207f33139a521b763528424fbf9c0f2ca9d4fe53c20978bfea615ac8cee6e646','59f02dada17d72e6a75e14e3fa7e3cbcb14b6660bb7f9a30a94895babbab7a65'],
    ['infinite1061','1.06-1','8239a237ed0eb97dba2a0c47f26a2f474a253ceb23d58c143b34c257acc0d6b6','1910ed891c87b58827bb61eb2a7bfe3ebebdf388686cd4ca5806dc33f2264d7c'],
    ['infinite1062','1.06-2','89999340c094719cb79639b5fb78a92d14aa15e9c9e2284663db1401732836a7','e0232baaa759c6e0a63ae83264145401e81743aac5a286671fffb2fcf6914c7c'],
    ['infinite1063','1.06-3','ab08722a0ad0b2c4020d03bea2c1fa4038fc03b66313860e97251f50e571e0c1','b9708ca5ef8bdc2a2848b9794fbb392a76b1947270f6a7052123bf874bb3b90d'],
    ['infinite107','1.07','82bbc7d671c39b72c307dc08b10a2665a8eda1dfa5106132ee16db18e2ac68e7','43d941f3851ae9f2dc21c7d395b631cc870f3295adbae847d881de23cfdc160a'],
    ['infinite1071','1.07-1','6995ea84d2c221ceea8466d28d4bed66f625c2f49ea4a3cb6b31fdcfa9bfebc8','43d941f3851ae9f2dc21c7d395b631cc870f3295adbae847d881de23cfdc160a'],
    ['infinite107b','1.07b','6ce1686649ce9f820fb6c7fd75b05af022f1d162fff538d65c3ed4211f8cd004','fe9bb660e68a85d02134e66e5148a43fab7e4cd80f69ece271a7d28d27db40b2'],
  ];
  const CURRENT='infinite107b';
  function infinite([id,version,program,setData],order){const current=id===CURRENT;return {id,title:'Infinite '+version,short:'Infinite '+version,family:'infinite',release:version,order,current,listed:current,store:'rom.'+id,pack:'music.'+id,program,data:setData,bios,about:'Infinite '+version+' · Japan 990512 NO CD (rev 1)',
    hint:current?'Infinite '+version+': the Infinite client’s prepared ROMs (Infinite\\roms) and its mode settings (Infinite\\modes). Choose the folder containing Infinite.exe.':'Infinite '+version+' is an older release. Start Infinite once to update it to the current release.',
    modes:['Super SF3','3rd Strike','3v3'],modeOffsets:[37,85],folder:{marker:'Infinite.exe',inner:'Infinite',zips:'roms',settings:'modes',settingsExt:'.nv'},runtime:['infinite','assists','super-assists']};}
  const list=[original,...RELEASES.map(infinite)];
  const byId=new Map(list.map(s=>[s.id,s]));
  function get(id){const s=byId.get(id);if(!s)throw new Error('Unknown source: '+id);return JSON.parse(JSON.stringify(s));}
  function byProgram(program){const s=list.find(x=>x.program===program);return s?get(s.id):null;}
  const current=()=>get(CURRENT);
  function identity(s){const def=get(s.id),mode=s.mode==null?null:s.mode;if(def.program!==s.program||s.data&&s.data!==def.data||s.bios&&s.bios!==def.bios)throw new Error('Source fingerprints do not match '+def.title);if(mode!==null&&(!def.modes||!Number.isInteger(mode)||mode<0||mode>=def.modes.length))throw new Error('Invalid source mode');if(s.settings&&!/^[0-9a-f]{64}$/i.test(s.settings))throw new Error('Invalid settings fingerprint');return {id:def.id,mode,program:def.program,data:def.data,bios:def.bios,...(s.settings?{settings:s.settings}:{})};}
  function key(s){const v=identity(s);return [v.id,v.mode==null?'original':v.mode,v.program,v.data,v.bios,v.settings||'factory'].join(':');}
  function equal(a,b){return key(a)===key(b);}
  const api={list,get,byProgram,current,CURRENT,identity,key,equal};g.CPS3Sources=api;if(typeof module!=='undefined')module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
