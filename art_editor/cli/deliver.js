'use strict';
const fs=require('fs'),path=require('path'),Rom=require('../../studio_kit/core/cps3rom'),Delivery=require('../js/delivery');
module.exports=async function deliver(pos,opt){const last=k=>opt[k]?.at(-1);if(!pos[0]||!last('out'))throw new Error('Use deliver project.cps3art --rom <directory> --out <empty directory>.');
  const inputs=(opt.rom||[]).flatMap(p=>fs.statSync(p).isDirectory()?['sfiii3nr1.zip','sfiii3.zip'].map(n=>path.join(p,n)):[p]);if(!inputs.length)throw new Error('Choose your ROM directory with --rom.');
  const out=path.resolve(last('out')),tools=path.resolve(__dirname,'../..'),installed=path.resolve(__dirname,'../../../..','emulator');
  function within(parent,child){const rel=path.relative(parent,child);return rel===''||!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel);}
  let existing=out;while(!fs.existsSync(existing))existing=path.dirname(existing);const real=fs.realpathSync(existing);if(real!==existing)throw new Error('Output folders through links are refused. Choose a separate empty folder.');
  if(within(tools,out)||within(installed,out)||inputs.some(p=>within(path.dirname(path.resolve(p)),out)))throw new Error('Choose an output folder outside the product, installed game and input ROM directories.');
  if(fs.existsSync(out)&&(!fs.statSync(out).isDirectory()||fs.readdirSync(out).length))throw new Error('Output must be an empty directory; existing files are never replaced.');
  const zips=Object.fromEntries(inputs.map(p=>[path.basename(p),new Uint8Array(fs.readFileSync(p))])),rom=await Rom.loadZips(zips,{graphics:true});if(!rom.supported)throw new Error('Use sfiii3nr1, Japan 990512 NO CD rev 1.');
  const project=await Delivery.open(new Uint8Array(fs.readFileSync(pos[0])),rom),result=await Delivery.build(project,Delivery.context(rom));
  fs.mkdirSync(out,{recursive:true});for(const f of result.files)fs.writeFileSync(path.join(out,f.name),f.bytes,{flag:'wx'});return {command:'deliver',output:out,report:result.report};
};
