// Fee-first publication readback only. No CLI, environment/credential discovery,
// files, writes, retry, candidate/run queries, or ambient network implementation.
import crypto from 'node:crypto';
import {boundedJson} from './fee-http-json.mjs';
import {createLegacyPolicy} from './fee-legacy-policy.mjs';
import {validateHealth} from './fee-data-health.mjs';
import {validateFeeCalculationReceipt} from './fee-receipt-core.mjs';
import {assertIbManagerPublication} from './ib-manager-report.mjs';
import {createIbManagerReturnConsumer,createIbManagerDrawdownConsumer,validateIbManagerReportState} from './ib-manager-return.mjs';
import {createFeeReportConsumer} from './fee-report-metadata.mjs';
import {validateReportPlan,reportPlanReadiness} from './fee-report-period.mjs';

const API='https://api.github.com/repos/huanwujoy-crypto/fee-console/';
const PAGES='https://huanwujoy-crypto.github.io/fee-console/';
const MAX_DATA=2*1024*1024-1,MAX_HEALTH=64*1024;
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const oid=v=>typeof v==='string'&&/^[a-f0-9]{40}$/.test(v);
const hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const day=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v+'T00:00:00Z'))&&new Date(v+'T00:00:00Z').toISOString().slice(0,10)===v;
const token=v=>typeof v==='string'&&v.length>=20&&v.length<=8192&&!/[^\x21-\x7e]/.test(v);
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
const parse=b=>createLegacyPolicy().parseExactJson(b);
const proofs=new WeakSet();
const pair=async(a,b)=>{
  const results=await Promise.allSettled([a,b]);
  for(const result of results)if(result.status==='rejected')throw result.reason;
  return results.map(result=>result.value);
};
// The coordinator's handoff of the fee publication this ratio follows. It is
// an identity, not a date rule: ratio and fee keep their own real source dates.
export const FEE_HANDOFF_KEYS=Object.freeze(['mainSha','accountingThrough','dataSha256','healthSha256']);
export function validateFeeHandoff(v){
  return !!(exact(v,FEE_HANDOFF_KEYS)&&oid(v.mainSha)&&day(v.accountingThrough)&&hex(v.dataSha256)&&hex(v.healthSha256));
}
export const FEE_PUBLICATION_CODES=Object.freeze([
  'CONFIG','READ','MAIN','CONTENT','DATA_HASH','HEALTH_HASH','LIVE','PAGES_DATA','PAGES_HEALTH',
  'HEALTH','CUTOFF','DECRYPT','FEE_RECEIPT','REPORT_METADATA','JENNY_RECEIPT','CHANGED',
].map(s=>'FEE_PUBLICATION_'+s));
const fail=code=>{throw Error('FEE_PUBLICATION_'+code);};
export function feePublicationFailureCode(error){
  return FEE_PUBLICATION_CODES.includes(error?.message)?error.message:'FEE_PUBLICATION_READ';
}
export function isFeeFinalPublicationProof(value){return !!value&&proofs.has(value)&&Object.isFrozen(value);}

// Verifies that the handed-over fee publication is the one actually live:
// exact data/health bytes at the handed fee main, the same blobs on the live
// main (which must still be this ratio run's main), the same bytes on Pages,
// and the real decrypted fee/Jenny receipts for the handed accounting cutoff.
// GitHub API reads carry only the existing read-only Actions token and only to
// fixed repository URLs; Pages reads never carry it. No age gate replaces the
// identity binding: an older fee report is accepted only when explicitly handed
// over and still live, and a superseded one is refused. previousProof binds a
// second, complete re-read to the first. A proof is never a cached read.
export async function verifyFeeFinalPublication({handoff,runMain,repositoryToken,
  feeDataKey,ibBaselineSha256,fetchImpl,clock=()=>new Date(),previousProof}={}){
  const held=[];let key,plain;
  const time=()=>{const d=clock();if(!(d instanceof Date)||!Number.isFinite(d.getTime()))fail('CONFIG');return new Date(d);};
  try{
    if(typeof fetchImpl!=='function'||typeof clock!=='function'||!validateFeeHandoff(handoff)||!oid(runMain)
      ||!token(repositoryToken)||!hex(ibBaselineSha256)
      ||previousProof!==undefined&&(!isFeeFinalPublicationProof(previousProof)||previousProof.feeMainSha!==handoff.mainSha
        ||previousProof.accountingThrough!==handoff.accountingThrough||previousProof.runMainSha!==runMain)
      ||typeof feeDataKey!=='string'||!/^[A-Za-z0-9_+/-]{43}={0,2}$/.test(feeDataKey))fail('CONFIG');
    const {mainSha:feeMain,accountingThrough:targetDate}=handoff;
    key=Buffer.from(feeDataKey.replaceAll('-','+').replaceAll('_','/'),'base64');
    if(key.length!==32)fail('CONFIG');
    time();
    const read=async(url,maxBytes,authenticated)=>{
      // The token is attached only to fixed repository API URLs; Pages never.
      const repository=url.startsWith(API);
      if(repository!==authenticated||!repository&&!url.startsWith(PAGES))fail('CONFIG');
      try{
        const got=await boundedJson(fetchImpl,url,{method:'GET',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',
          headers:{Accept:repository?'application/vnd.github+json':'application/json',...(repository?{'X-GitHub-Api-Version':'2022-11-28',Authorization:'Bearer '+repositoryToken}:{})}},
          {timeoutMs:15000,maxBytes,includeBytes:true});
        held.push(got.bytes);return {json:parse(got.bytes),bytes:got.bytes};
      }catch{fail('READ');}
    };
    const github=(path,maxBytes)=>read(API+path,maxBytes,true),pages=(name,maxBytes)=>read(PAGES+name,maxBytes,false);
    const main=async()=>{
      const {json:r}=await github('git/ref/heads/main',16384);
      if(r?.ref!=='refs/heads/main'||r?.object?.type!=='commit'||r.object.sha!==runMain)fail('MAIN');
    };
    await main();
    const file=async(name,maxBytes)=>{
      const {json:f}=await github('contents/'+name+'?ref='+feeMain,Math.ceil(maxBytes*1.5)+16384);
      if(f?.type!=='file'||f.path!==name||f.name!==name||f.encoding!=='base64'
        ||!oid(f.sha)||!Number.isSafeInteger(f.size)||f.size<1||f.size>maxBytes||typeof f.content!=='string')fail('CONTENT');
      const encoded=f.content.replaceAll('\n',''),b=Buffer.from(encoded,'base64');held.push(b);
      if(b.length!==f.size||b.toString('base64')!==encoded
        ||crypto.createHash('sha1').update('blob '+b.length+'\0').update(b).digest('hex')!==f.sha)fail('CONTENT');
      return {bytes:b,blob:f.sha};
    };
    const [dataFile,healthFile]=await pair(file('data.json',MAX_DATA),file('fee-data-health.json',MAX_HEALTH));
    const data=dataFile.bytes,healthBytes=healthFile.bytes,dataSha256=hash(data),healthSha256=hash(healthBytes);
    if(dataSha256!==handoff.dataSha256)fail('DATA_HASH');
    if(healthSha256!==handoff.healthSha256)fail('HEALTH_HASH');
    // The live main must still carry exactly these blobs: a newer promotion or
    // any other replacement of the fee pair supersedes this handoff.
    const {json:root}=await github('contents?ref='+runMain,256*1024);
    const entry=name=>Array.isArray(root)?root.filter(x=>x?.name===name&&x?.path===name):[];
    const liveData=entry('data.json'),liveHealth=entry('fee-data-health.json');
    if(liveData.length!==1||liveHealth.length!==1||liveData[0].type!=='file'||liveHealth[0].type!=='file'
      ||liveData[0].sha!==dataFile.blob||liveHealth[0].sha!==healthFile.blob)fail('LIVE');
    let health;try{health=parse(healthBytes);}catch{fail('HEALTH');}
    // Structural and source-lag rules of the receipt still apply; its own 36h
    // age window does not decide which fee publication a ratio follows.
    if(validateHealth(health,{now:time(),maxAgeHours:Infinity}).length||!['updated','no-op'].includes(health.outcome)
      ||health.dataSha256!==dataSha256)fail('HEALTH');
    if(health.targetDate!==targetDate||!['schwab','webull'].every(k=>day(health.sourceDates[k])))fail('CUTOFF');
    const [pageData,pageHealth]=await pair(pages('data.json',MAX_DATA),pages('fee-data-health.json',MAX_HEALTH));
    if(!pageData.bytes.equals(data))fail('PAGES_DATA');
    if(!pageHealth.bytes.equals(healthBytes))fail('PAGES_HEALTH');
    let payload;
    try{
      const envelope=parse(data);
      if(!exact(envelope,['enc','v','data'])||envelope.enc!==true||envelope.v!==3||typeof envelope.data!=='string')fail('DECRYPT');
      const sealed=Buffer.from(envelope.data,'base64');held.push(sealed);
      if(sealed.length<29||sealed.toString('base64')!==envelope.data)fail('DECRYPT');
      const decipher=crypto.createDecipheriv('aes-256-gcm',key,sealed.subarray(0,12));decipher.setAuthTag(sealed.subarray(-16));
      const first=decipher.update(sealed.subarray(12,-16));held.push(first);
      const last=decipher.final();held.push(last);plain=Buffer.concat([first,last]);payload=parse(plain);
    }catch{fail('DECRYPT');}
    const fee=payload?.feeCalculationReceipt;
    if(!validateFeeCalculationReceipt(fee,payload).ok)fail('FEE_RECEIPT');
    if(fee.asOf!==targetDate||payload?.daily?.at(-1)?.d!==targetDate
      ||payload.status?.asOf!==targetDate)fail('CUTOFF');
    let priceThrough=targetDate;
    if(Object.hasOwn(payload,'feeReportPublication')){
      // Only the existing exact reviewed calendar/plan and fee-bound metadata
      // consumer may establish a distinct price cutoff.
      try{
        const metadata=payload.feeReportPublication,plan=metadata?.plan,at=time();
        if(!validateReportPlan(plan)||plan.accountingThrough!==targetDate||reportPlanReadiness(plan,at).state!=='due')fail('REPORT_METADATA');
        const view=await createFeeReportConsumer().project(metadata,{state:'verified',asOf:fee.asOf},fee,at);
        if(!['updated','pending-update'].includes(view.state)||view.accountingThrough!==targetDate||view.priceThrough!==plan.priceThrough)fail('REPORT_METADATA');
        priceThrough=view.priceThrough;
      }catch{fail('REPORT_METADATA');}
    }
    // Payload and receipt must agree on the price cutoff. A benchmark-pending
    // publication is refused here until its handoff semantics are reviewed.
    if(payload.daily.at(-1)?.bd!==priceThrough||health.sourceDates.benchmark!==priceThrough)fail('CUTOFF');
    try{
      const core=createIbManagerReturnConsumer(),view={state:'verified',...fee};
      if(payload.ibManagerReturnReceipt?.schema===core.dailySchema){
        const source=await validateIbManagerReportState(payload,ibBaselineSha256);
        if(!source||source.sourceAsOf!==targetDate)fail('JENNY_RECEIPT');
      }
      const ret=await core.project(payload.ibManagerReturnReceipt,view,payload.ibManagerSourceStatus);
      const dd=await createIbManagerDrawdownConsumer().project(payload.ibManagerDrawdownReceipt,payload.ibManagerReturnReceipt,view,payload.ibManagerSourceStatus);
      if(ret.state!=='verified'||dd.state!=='verified'||ret.asOf!==targetDate||dd.asOf!==targetDate)fail('JENNY_RECEIPT');
      await assertIbManagerPublication(payload,targetDate,{IB_MANAGER_READ_ENABLED:'true',IB_MANAGER_BASELINE_SHA256:ibBaselineSha256});
    }catch{fail('JENNY_RECEIPT');}
    await main();
    if(previousProof!==undefined&&(previousProof.dataSha256!==dataSha256||previousProof.healthSha256!==healthSha256))fail('CHANGED');
    const at=time();
    const proof=Object.freeze({schema:'fee-console.ratio-fee-publication-proof.v2',status:'FEE_FINAL_PUBLICATION_VERIFIED',
      accountingThrough:targetDate,feeMainSha:feeMain,runMainSha:runMain,dataSha256,healthSha256,verifiedAt:at.toISOString(),healthCheckedAt:health.checkedAt});
    proofs.add(proof);return proof;
  }catch(error){throw Error(feePublicationFailureCode(error));}
  finally{key?.fill(0);plain?.fill(0);for(const b of held)b.fill(0);}
}
