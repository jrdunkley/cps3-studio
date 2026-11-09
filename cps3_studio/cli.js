#!/usr/bin/env node
/* Local Studio command line. ROM inputs are read-only; output destinations must be new. */
'use strict';
const fs=require('fs'),path=require('path');
const Sources=require('../studio_kit/core/sources'),Project=require('../studio_kit/core/project'),Builder=require('../studio_kit/core/builder'),Rom=require('../studio_kit/core/cps3rom'),Zip=require('../studio_kit/core/zip');
const args=process.argv.slice(2),command=args.shift(),opt=name=>{const i=args.indexOf('--'+name);return i<0?null:args[i+1];};
function json(value){console.log(JSON.stringify(value,null,2));}
async function images(folder){if(!folder)throw new Error('--roms FOLDER is required');const archives={};for(const name of ['sfiii3nr1.zip','sfiii3.zip'])archives[name]=await Zip.read(fs.readFileSync(path.join(folder,name)));return {rom:await Rom.load(archives,{graphics:true}),archives};}
async function main(){
 if(!command||command==='help'||command==='--help'){console.log('CPS3 Studio\n  node cli.js inspect --project FILE\n  node cli.js validate --project FILE --roms FOLDER\n  node cli.js build --project FILE --roms FOLDER --out NEW_FOLDER\n  node cli.js scenario --project FILE --roms FOLDER --scenario ID [--bios FILE --eeprom FILE]\n  node cli.js scenarios --project FILE --roms FOLDER [--timeout-ms 120000]\n  node cli.js compare --project FILE --roms FOLDER [--scenario ID --timeout-ms 120000]\n  node cli.js sources');return;}
 if(command==='sources'){json(Sources.list);return;}
 if(!['inspect','validate','build','scenario','scenarios','compare'].includes(command))throw new Error('Unknown command '+command);
 const file=opt('project');if(!file)throw new Error('--project FILE is required');const p=Project.validate(JSON.parse(fs.readFileSync(file,'utf8')));
 if(command==='inspect'){json({format:p.format,version:p.version,id:p.id,name:p.name,source:p.source,documents:Object.keys(p.documents),resources:Object.keys(p.resources),layers:p.layers.map(l=>({id:l.id,operation:l.operation,writes:l.writes?.length||0,reservations:l.reservations?.length||0})),scenarios:Object.keys(p.scenarios)});return;}
 const {rom,archives}=await images(opt('roms'));
 const plan=await Builder.plan(rom,p.source,p.layers,p.pools||[]);
 if(command==='validate'){json({passed:true,layers:plan.layers,ledger:plan.ledger,writes:plan.writes.length});return;}
 const built=await Builder.build(rom,p.source,p.layers,p.pools||[],{members:command==='build'});
 if(command==='build'){const out=opt('out');if(!out)throw new Error('--out NEW_FOLDER is required');if(fs.existsSync(out))throw new Error('Output folder already exists; choose a new destination');fs.mkdirSync(out,{recursive:true});for(const f of built.files){if(path.basename(f.name)!==f.name)throw new Error('Unsafe output name');fs.writeFileSync(path.join(out,f.name),f.bytes);}json({passed:true,output:path.resolve(out),files:built.files.length,hashes:built.report.hashes});return;}
 const GameRom=require('../studio_kit/game/rom'),Core=require('../studio_kit/game/core'),Runner=require('../studio_kit/game/runner'),Wasm=require('../studio_kit/game/engine_wasm'),Scenario=require('../studio_kit/game/scenarios');
 const bios=opt('bios')?new Uint8Array(fs.readFileSync(opt('bios'))):GameRom.bios(archives['sfiii3nr1.zip']);if(await Rom.sha256(bios)!==p.source.bios)throw new Error('The decrypted BIOS differs from the selected source');
 const source=Sources.get(p.source.id);if(source.modes&&p.source.mode===null)throw new Error('Choose an Infinite mode in the project before running the game');
 const make=async images=>{const core=await Core.create(new Uint8Array(Buffer.from(Wasm.Cps3GameWasm.base64,'base64')));core.setImages(images.program,bios,images.data);return core;};
 let eeprom=opt('eeprom')?new Uint8Array(fs.readFileSync(opt('eeprom'))):null;if(eeprom&&eeprom.length!==1024)eeprom=await GameRom.nvPayload(eeprom);
 if(!eeprom){const core=await make(rom);core.coldBoot(null);for(let i=0;i<30;i++)if(core.frame(0,0,2))throw new Error('Factory settings boot failed');eeprom=core.eeprom().slice();eeprom[2]=eeprom[50]=0x12;if(p.source.mode!==null)for(const offset of source.modeOffsets||[])eeprom[offset]=p.source.mode;}
 if(source.modes&&GameRom.settingsMode(eeprom)!==p.source.mode)throw new Error('The settings chip holds another Infinite mode');if(p.source.settings&&await Rom.sha256(eeprom)!==p.source.settings)throw new Error('The settings chip differs from the project source fingerprint');
 const names=opt('scenario')?[opt('scenario')]:Object.keys(p.scenarios);if(command==='scenario'&&!opt('scenario'))throw new Error('--scenario ID is required');if(!names.length||names.some(n=>!p.scenarios[n]))throw new Error('Choose existing project scenarios');
 const cases=names.map(id=>{const value=p.scenarios[id],scenario=Scenario.validate(value.scenario||value);return {id,scenario,watch:value.watch||[]};});
 const timeoutMs=Number(opt('timeout-ms')||120000),imageHashes={program:await Rom.sha256(built.program),data:await Rom.sha256(built.data),bios:await Rom.sha256(bios),eeprom:await Rom.sha256(eeprom)};
 const identity={source:p.source.id,mode:p.source.mode,images:imageHashes,legacyEeprom:opt('eeprom')?null:'factory:free1:mode'+(p.source.mode??'-')};
 if(command==='compare'){const results=[],baseIdentity={...identity,images:{...imageHashes,program:await Rom.sha256(rom.program),data:await Rom.sha256(rom.data)}};for(const c of cases){try{Scenario.assertIdentity(c.scenario,[baseIdentity,identity]);const left=await make(rom),right=await make(built);Runner.start(left,c.scenario,eeprom);Runner.start(right,c.scenario,eeprom);results.push({id:c.id,...Runner.compare(left,right,c.scenario,{timeoutMs})});}catch(error){results.push({id:c.id,passed:false,ok:false,frames:0,failure:{kind:error.code||'execution',message:error.message,detail:error.detail||null}});}}const report={passed:results.every(r=>r.passed),ok:results.every(r=>r.passed),equal:results.every(r=>r.equal),source:p.source,images:imageHashes,results};json(report);if(!report.passed)process.exitCode=1;return;}
 const result=await Runner.batch(async()=>({core:await make(built),eeprom,images:imageHashes,identity}),cases,{timeoutMs});json({...result,source:p.source,images:imageHashes});if(!result.ok)process.exitCode=1;
}
main().catch(e=>{console.error(JSON.stringify({passed:false,error:e.message,code:e.code||null,detail:e.detail||null}));process.exitCode=1;});
