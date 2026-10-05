// Optional private source matrices never enter Git, the image or the public report.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {DEFAULT_POLICY,buildAiExposure} from './xuan-weekly-ai-exposure.mjs';
export const PRIVATE_MANIFEST={schema:'weekly-private-ai-snapshots.v1',entries:[]};
export function readPrivateManifest(file){return file?JSON.parse(fs.readFileSync(file,'utf8')):PRIVATE_MANIFEST;}
const day=d=>/^\d{4}-\d{2}-\d{2}$/.test(d||'')?Date.parse(d+'T00:00:00Z'):NaN;
export function loadPrivateAiPolicy({cutoff,directory,policy=DEFAULT_POLICY,manifest=PRIVATE_MANIFEST}={}){
 if(manifest.schema!=='weekly-private-ai-snapshots.v1'||!Array.isArray(manifest.entries)||manifest.entries.length>6)throw Error('weekly_private_manifest_invalid');
 const seen=new Set(),out=structuredClone(policy),observations=[];
 const readPinned=ref=>{
  if(!ref||!/^[a-f0-9]{64}$/.test(ref.sha256)||ref.maxBytes!==2097152||!directory)throw Error('private_patch_invalid');
  const file=path.join(directory,ref.sha256+'.json'),stat=fs.lstatSync(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>ref.maxBytes)throw Error('private_patch_invalid');
  const bytes=fs.readFileSync(file);if(createHash('sha256').update(bytes).digest('hex')!==ref.sha256)throw Error('private_patch_invalid');
  return JSON.parse(bytes);
 };
 if(manifest.policyPatch){
  try{
   const patch=readPinned(manifest.policyPatch);
   if(Object.keys(patch).some(k=>!['underlyingIssuers','issuerAliases','etfSnapshots'].includes(k)))throw Error('private_patch_invalid');
   if(patch.etfSnapshots){
    if(!Array.isArray(patch.etfSnapshots))throw Error('private_patch_invalid');
    const ids=new Set();for(const s of patch.etfSnapshots){const old=out.etfSnapshots.find(x=>x.instrumentId===s.instrumentId);if(!old||ids.has(s.instrumentId)||s.symbol!==old.symbol||s.fundName!==old.fundName||s.isin!==old.isin)throw Error('private_patch_invalid');ids.add(s.instrumentId);}
   }
   const candidate={...out,...patch,etfSnapshots:out.etfSnapshots.map(s=>patch.etfSnapshots?.find(x=>x.instrumentId===s.instrumentId)||s),methodId:out.methodId+'-private-reviewed-v1'};
   buildAiExposure({riskDenominator:{components:[{key:'one',valueMicro:'1000000'},{key:'two',valueMicro:'0'},{key:'three',valueMicro:'0'}]},riskConstituents:[]},{cutoff,policy:candidate});
   Object.assign(out,candidate);observations.push({status:'reviewed_policy_loaded'});
  }catch{return {policy:structuredClone(policy),observations:[{status:'reviewed_policy_unavailable_or_invalid'}]};}
 }
 for(const e of manifest.entries){
  if(!/^\d+$/.test(e.instrumentId)||!e.symbol||!/^\d{4}-\d{2}-\d{2}$/.test(e.asOf)||! /^[a-f0-9]{64}$/.test(e.sha256)||seen.has(e.instrumentId)||e.maxBytes!==2097152)throw Error('weekly_private_manifest_invalid');
  seen.add(e.instrumentId);const i=out.etfSnapshots.findIndex(s=>s.instrumentId===e.instrumentId&&s.symbol===e.symbol);
  if(i<0)throw Error('weekly_private_target_invalid');
  const age=(day(cutoff)-day(e.asOf))/86400000;
  let status='missing';
  if(!Number.isFinite(age)||age<0||age>100)status='outside_source_window';
  else if(directory){
   try{
    const file=path.join(directory,e.sha256+'.json'),stat=fs.lstatSync(file);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>e.maxBytes)throw Error('unsafe');
    const bytes=fs.readFileSync(file);
    if(createHash('sha256').update(bytes).digest('hex')!==e.sha256)throw Error('hash');
    const s=JSON.parse(bytes);
    if(s.instrumentId!==e.instrumentId||s.symbol!==e.symbol||s.asOf!==e.asOf||s.fundName!==out.etfSnapshots[i].fundName||s.isin!==out.etfSnapshots[i].isin||!Array.isArray(s.holdings))throw Error('target');
    const candidate=structuredClone(out);candidate.etfSnapshots[i]=s;
    buildAiExposure({riskDenominator:{components:[{key:'fixture-1',valueMicro:'1000000'},{key:'fixture-2',valueMicro:'0'},{key:'fixture-3',valueMicro:'0'}]},riskConstituents:[{portfolioId:'private-source-validation',instrumentId:e.instrumentId,symbol:e.symbol,assetType:'ETF',custodian:'Synthetic',identityVerified:true,valueDate:cutoff,marketValueMicro:'1000000'}]},{cutoff,policy:candidate});
    out.etfSnapshots[i]=s;status='loaded';
   }catch{status='unavailable_or_invalid';}
  }
  observations.push({symbol:e.symbol,asOf:e.asOf,status,fallback:'existing dated public snapshot; unavailable coverage remains unknown'});
 }
 return {policy:out,observations};
}
