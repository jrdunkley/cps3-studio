/* Measured cel-reader ownership. No unused bytes are labelled free space. */
(function(g) {
  'use strict';
  const Codec=g.ArtCodec6||(typeof require==='function'&&require('./codec6.js'));
  class Census {
    constructor(resources) {this.resources=resources;this.descriptors=resources.descriptors();this.regions=[];this.byPointer=new Map();this.fixedSizes=new Map();this.cachedGroups=new Map();
      for(const [pointer,ids]of this.descriptors){const c=resources.descriptor(ids[0]),regions=[{kind:'table',start:c.table,end:c.table+256,pointer}];
        for(const u of c.uploads){const d=Codec.decode(resources.data.subarray(u.sourceOffset),resources.data.subarray(c.table,c.table+256),u.requested);regions.push({kind:'source',start:u.sourceOffset,end:u.sourceOffset+d.sourceConsumed,pointer,upload:u,consumed:d.sourceConsumed,written:d.pixels.length});}
        this.regions.push(...regions);this.byPointer.set(pointer,{cel:c,ids,regions});
        if(!(c.flags&32768)){if(!this.cachedGroups.has(c.flags))this.cachedGroups.set(c.flags,[]);this.cachedGroups.get(c.flags).push(pointer);}
      }
      this.regions.sort((a,b)=>a.start-b.start||a.end-b.end);this.prefixEnd=new Uint32Array(this.regions.length);let max=0;this.regions.forEach((r,i)=>{max=Math.max(max,r.end);this.prefixEnd[i]=max;});
    }
    overlaps(start,end) {let lo=0,hi=this.regions.length;while(lo<hi){const m=(lo+hi)>>>1;if(this.regions[m].start<end)lo=m+1;else hi=m;}const out=[];for(let i=lo-1;i>=0&&this.prefixEnd[i]>start;i--){const r=this.regions[i];if(r.end>start)out.push(r);}return out;}
    /* Evidence describes byte locations, never values selected because they
       happen to match the requested address. Unknown bytes stay unknown. */
    storedCandidates(run,evidence={}) {
      const native=!Array.isArray(run),targetSpace=native?run.space:'data',[lo,hi]=native?[run.begin,run.end]:run;
      if(!Number.isInteger(lo)||!Number.isInteger(hi)||lo<0||lo>=hi||!['program','data'].includes(targetSpace)||(!native&&hi>this.resources.data.length))throw new Error('Half-open program or data range required.');
      if(native&&(lo<(targetSpace==='program'?0x06000000:0x400000)||hi>(targetSpace==='program'?0x07000000:0x4400000)))throw new Error('Range outside the native image.');
      const fields=new Set(),records=[];for(const [pointer,item]of this.byPointer){fields.add(pointer-0x06000000+8);for(const u of item.cel.uploads)fields.add(u.address-0x06000000);records.push([pointer-0x06000000,pointer-0x06000000+item.cel.descriptorBytes]);}
      const extraFields=new Map((evidence.extraFields||[]).map(f=>[f.offset,f])),pools=new Set(evidence.pools||[]);
      records.sort((a,b)=>a[0]-b[0]);const contains=(rows,o)=>{let a=0,b=rows.length;while(a<b){const m=(a+b)>>>1;if(rows[m][0]<=o)a=m+1;else b=m;}return a>0&&o+4<=rows[a-1][1];};
      const locations={program:(evidence.programRanges||[]).slice().sort((a,b)=>a.start-b.start),data:(evidence.dataRanges||[]).slice().sort((a,b)=>a.start-b.start)},results=[];
      for(const space of ['program','data']){const bytes=this.resources[space],v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
        for(let o=0;o+4<=bytes.length;o++){const word=v.getUint32(o,false),targets=native?(targetSpace==='program'?[['cpu_alias',(word&0xc7ffffff)>>>0]]:[['direct_data_address',word],['masked_hardware_word',2*(word&0x03ffffff)],['data_byte_offset',word+0x400000]]):[['byte_offset',word],['hardware_word',2*word-0x400000],['masked_hardware_word',2*(word&0x03ffffff)-0x400000]];
          const hits=targets.filter(([form,t])=>t>=lo&&t<hi);if(!hits.length)continue;
          let classification='unclassified',pointer_field=null;
          if(space==='program'&&fields.has(o)){classification='enumerated_record_field';pointer_field=true;}
          else if(space==='program'&&extraFields.has(o)){classification='enumerated_record_field';pointer_field=true;}
          else if(space==='program'&&contains(records,o)){classification='enumerated_record_scalar_bytes';pointer_field=false;}
          else if(space==='program'&&o>=0x800000&&o+4<=0x880000){classification=(o-0x800004)%8===0?'enumerated_record_field':'enumerated_index_scalar_bytes';pointer_field=classification==='enumerated_record_field';}
          else if(space==='program'&&pools.has(o)){classification='literal_pool_or_table_word';pointer_field=true;}
          else if(space==='program'&&evidence.executed&&[o,o+1,o+2,o+3].every(p=>evidence.executed[Math.floor(p/2)])){classification='executed_code_bytes';pointer_field=false;}
          else {const r=locations[space].find(r=>r.start<=o&&o+4<=r.end);if(r){classification=r.classification;pointer_field=false;}}
          for(const [form,target]of hits){const encoding=space==='program'?(extraFields.get(o)?.encoding||(fields.has(o)?'masked_hardware_word':(o>=0x800000&&o<0x880000&&(o-0x800004)%8===0?'cpu_alias':null))):null;
            const other=native&&encoding&&encoding!==form;results.push({space,offset:o,word,form,target,classification:other?'enumerated_field_other_address_form':classification,pointer_field:other?false:pointer_field});}
        }
      }
      results.sort((a,b)=>a.space.localeCompare(b.space)||a.offset-b.offset||a.form.localeCompare(b.form));
      return {run:[lo,hi],candidates:results,stored_reference_classification_closed:results.every(r=>!['unclassified','literal_pool_or_table_word'].includes(r.classification)),scope:'Stored candidates only; producer, overlap and live evidence are separate.'};
    }
    forCel(index,opts={}) {
      const row=this.resources.row(index),item=this.byPointer.get(row.pointer);if(!item)throw new Error('Null cel index row.');const shared=new Set(item.ids),sourceRegions=[];
      for(const region of item.regions){const readers=this.overlaps(region.start,region.end);if(region.kind==='source'||opts.tableEdit)for(const r of readers)for(const id of this.descriptors.get(r.pointer))shared.add(id);
        if(region.kind==='source'){const exclusive=readers.every(r=>r.pointer===row.pointer&&r.kind==='source'&&r.start===region.start&&r.end===region.end);sourceRegions.push({...region,exclusive,sharedDescriptors:[...new Set(readers.map(r=>r.pointer))]});}
      }
      const c=item.cel,owned=unionBytes(sourceRegions.filter(r=>r.exclusive)),consumed=unionBytes(sourceRegions),cachedPointers=c.flags&32768?[]:this.cachedGroups.get(c.flags),cachedIndices=cachedPointers.flatMap(p=>p===row.pointer?[]:this.descriptors.get(p));
      let fixed=0,original=0,requested=0,highest=0;const writes=[];
      for(const region of sourceRegions){const u=region.upload,key=[u.sourceOffset,c.table,u.requested].join(':');if(!this.fixedSizes.has(key)){const d=Codec.decode(this.resources.data.subarray(u.sourceOffset),this.resources.data.subarray(c.table,c.table+256),u.requested);this.fixedSizes.set(key,Codec.encodeFixed(d.pixels,this.resources.data.subarray(c.table,c.table+256),u.requested).source.length);}fixed+=this.fixedSizes.get(key);original+=region.consumed;requested+=u.requested;highest=Math.max(highest,u.destination+region.written);writes.push({start:u.destination,end:u.destination+region.written});}
      const footprint={descriptor:c.descriptorBytes,source_consumed_sum:original,source_union:consumed,fixed_sum:fixed,requested_upload_bytes:requested,actual_written_union:unionBytes(writes),allocation:c.allocation,highest_write:highest};
      const sourceSharedWith=[...shared].filter(i=>i!==index).sort((a,b)=>a-b);
      return {index,pointer:row.pointer,aliases:item.ids.slice(),sourceSharedWith,cachedSharedWith:cachedIndices.sort((a,b)=>a-b),sharedWith:[...new Set([...sourceSharedWith,...cachedIndices])].sort((a,b)=>a-b),descriptorBytes:c.descriptorBytes,allocation:c.allocation,consumedSourceBytes:consumed,ownedSourceBytes:owned,footprint,headroom:{reencode_savings_sum:original-fixed,unused_allocation_after_highest_write:Math.max(0,c.allocation-highest),proven_free_rom_bytes:0,rom_growth_authorized:false},unallocatedHeadroom:null,regions:sourceRegions,scope:'Exhaustive cel source/table readers and native cached groups. Re-encoding savings and unused character allocation are conditional capacity; no ROM padding or unaccounted reader space is licensed.'};
    }
  }
  function unionBytes(regions){const sorted=regions.slice().sort((a,b)=>a.start-b.start);let total=0,end=-1;for(const r of sorted){total+=Math.max(0,r.end-Math.max(end,r.start));end=Math.max(end,r.end);}return total;}
  const api={Census,unionBytes};g.ArtCensus=api;if(typeof module!=='undefined')module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
