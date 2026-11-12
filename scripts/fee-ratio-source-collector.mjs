// Intake boundary for a future official Sharesight collector. No transport,
// credential discovery, download assertion, encryption or publication authority.
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createLegacyPolicy} from './fee-legacy-policy.mjs';
import {createOfficialRatioSourceCore} from './fee-ratio-official-source.mjs';
import {createRatioSourceCore} from './fee-ratio-source-core.mjs';
import {createRankedExposureCore} from './xuan-ib-sharesight-exposure.mjs';
import {createAggregateReturnsCore} from './fee-ratio-aggregate-returns.mjs';

const MAX=5*1024*1024,errors=new WeakMap();
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const scopeHash=accounts=>hash(JSON.stringify(accounts.map(s=>s.replaceAll('&amp;','&')).sort()));
const collectionError=code=>{const e=new Error('RATIO_COLLECTION_'+code);errors.set(e,code);return e;};
const refusal=code=>{throw collectionError(code);};
export const ratioCollectionFailureCode=e=>'RATIO_COLLECTION_'+(errors.get(e)||'REFUSED');

// These are capability gaps, never a request to obtain new permissions. The
// official public API's Performance/Diversity support does not establish an
// Exposure export, the ten-account consolidated scope, or workbook semantics.
export function ratioCollectionReadiness(){
  return {
    schema:'fee-console.ratio-collection-readiness.v1',status:'BLOCKED',
    automaticCollectionReady:false,publicationReady:false,
    blockers:['OFFICIAL_EXPOSURE_TRANSPORT_UNVERIFIED',
      'CLASSIFICATION_EXPORT_TRANSPORT_UNVERIFIED',
      'NATIVE_AGGREGATE_PERFORMANCE_TRANSPORT_UNVERIFIED',
      'AUTHORIZED_TEN_ACCOUNT_SESSION_UNVERIFIED'],
  };
}

// A pin proves byte integrity only. Existing Library/source authentication and
// fee-first publication/readback gates must still consume these exact bytes.
// No API response is relabelled as an official workbook or aggregate return.
export function prepareCollectedRatioInput({originalBytes,expectedSha256,
  requirePerformance=true,now=new Date(),exposureCore=createRankedExposureCore()}={}){
  if(!(originalBytes instanceof Uint8Array)||originalBytes.byteLength<1||originalBytes.byteLength>MAX
    ||typeof expectedSha256!=='string'||!/^[a-f0-9]{64}$/.test(expectedSha256)
    ||typeof requirePerformance!=='boolean'||!(now instanceof Date)||!Number.isFinite(now.getTime()))refusal('INPUT');
  const original=Buffer.from(originalBytes);
  if(hash(original)!==expectedSha256)refusal('HASH');
  let raw;
  try{raw=createLegacyPolicy().parseExactJson(original);}catch{refusal('JSON');}
  const performance=raw?.schemaVersion==='sharesight-private-performance-v1';
  if(requirePerformance&&!performance)refusal('PERFORMANCE_REQUIRED');
  const allocation=performance?raw.allocation:raw;
  if(allocation?.schemaVersion!=='sharesight-private-full-v2')refusal('OFFICIAL_ORIGINAL_REQUIRED');
  let input,facts;
  try{
    input=createOfficialRatioSourceCore().build(allocation,{
      sourceSha256:expectedSha256,sourceBytes:original.length,
    }).input;
    if(performance)input={...input,schema:'fee-console.ratio-sources.v3',performance:structuredClone(raw.performance)};
    facts=createRatioSourceCore(scopeHash).verifyBrowserSourceAssociations(raw,input,{
      scopeHash:exposureCore.ALL_TOGETHER_SCOPE_SHA256,now,
    });
    exposureCore.buildRankedExposureView(input.exposure);
  }catch{refusal('SOURCE_CONTRACT');}
  const inputBytes=Buffer.from(JSON.stringify(input));
  if(inputBytes.length>MAX)refusal('INPUT');
  return {
    schema:'fee-console.ratio-collected-input.v1',status:'PREPARED_UNAUTHENTICATED',
    publicationReady:false,downloadVerified:false,
    originalBytes:new Uint8Array(original),inputBytes:new Uint8Array(inputBytes),
    sourceSha256:expectedSha256,inputSha256:hash(inputBytes),
    sourceDates:structuredClone(facts.sourceDates),earliestCapturedAt:facts.observedAt,
    performanceIncluded:performance,
  };
}

// An integration can supply a reader for an already pinned original export.
// Merely injecting one never authenticates its origin or unlocks publication.
// No reader means no source call, no fallback, and an explicit blocked result.
export async function collectRatioSourceInput({readOriginal=null,expectedSha256,
  requirePerformance=true,clock=()=>new Date(),exposureCore,
  timeoutMs=20_000,signal}={}){
  if(readOriginal===null)return ratioCollectionReadiness();
  if(typeof readOriginal!=='function')refusal('CONFIG');
  // Validate the independently supplied pin before any source IO. Do not let
  // the reader choose both the content and its supposed trusted checksum.
  if(typeof expectedSha256!=='string'||!/^[a-f0-9]{64}$/.test(expectedSha256)
    ||typeof requirePerformance!=='boolean'||typeof clock!=='function'
    ||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>30_000
    ||signal!==undefined&&!(signal instanceof AbortSignal))refusal('INPUT');
  const readClock=code=>{try{const at=clock();if(!(at instanceof Date)||!Number.isFinite(at.getTime()))refusal(code);return new Date(at.getTime());}catch{refusal(code);}};
  const startedAt=readClock('INPUT').getTime();
  if(signal?.aborted)refusal('ABORTED');
  const controller=new AbortController();let timer,onAbort,bytes;
  const boundary=new Promise((_,reject)=>{
    onAbort=()=>{reject(collectionError('ABORTED'));controller.abort();};
    signal?.addEventListener('abort',onAbort,{once:true});
    timer=setTimeout(()=>{reject(collectionError('TIMEOUT'));controller.abort();},timeoutMs);
  });
  // Bound even a reader that ignores AbortSignal. Such a reader may continue
  // its own work, but a late result cannot turn this refusal into a prepared
  // result. The transport must also enforce its own IO and cleanup limits.
  const read=Promise.resolve().then(()=>{
    if(controller.signal.aborted)refusal('ABORTED');
    return readOriginal({signal:controller.signal});
  }).catch(()=>{refusal('READ');});
  try{bytes=await Promise.race([read,boundary]);}
  finally{clearTimeout(timer);signal?.removeEventListener('abort',onAbort);}
  // Check freshness at completion. This one-shot intake never changes source
  // capture times, refreshes credentials or retries a failed/denied read.
  if(signal?.aborted)refusal('ABORTED');
  const now=readClock('CLOCK');
  if(now.getTime()<startedAt)refusal('CLOCK');
  return prepareCollectedRatioInput({originalBytes:bytes,expectedSha256,
    requirePerformance,now,exposureCore});
}

const XLSX_SCRIPT=fileURLToPath(new URL('./fee-ratio-xlsx.py',import.meta.url));
const XLSX_CODES=new Set('INPUT HASH PROFILE ZIP XML UNSUPPORTED DATE CURRENCY SCOPE HEADER ROWS VALUE RESIDUAL PERFORMANCE TIMEOUT ABORTED PROCESS OUTPUT'.split(' '));
const xlsxErrors=new WeakMap();
function xlsxError(code){const e=new Error('RATIO_XLSX_'+code);xlsxErrors.set(e,code);return e;}
export const ratioWorkbookFailureCode=e=>'RATIO_XLSX_'+(xlsxErrors.get(e)||'REFUSED');

// The profile is an explicit layout mapping, not approval or authentication.
// No official Sharesight profile is supplied. The isolated Python reader uses
// only stdin/stdout; its result cannot enter the official intake as a proof.
export async function parseRatioWorkbook({workbookBytes,expectedSha256,profile,
  now=new Date(),timeoutMs=20_000,signal,spawnImpl=spawn}={}){
  if(!(workbookBytes instanceof Uint8Array)||!workbookBytes.byteLength||workbookBytes.byteLength>MAX
    ||typeof expectedSha256!=='string'||!/^[a-f0-9]{64}$/.test(expectedSha256)
    ||!profile||typeof profile!=='object'||Array.isArray(profile)
    ||!(now instanceof Date)||!Number.isFinite(now.getTime())
    ||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>30_000
    ||signal!==undefined&&!(signal instanceof AbortSignal)||typeof spawnImpl!=='function')throw xlsxError('INPUT');
  const bytes=Buffer.from(workbookBytes);
  if(hash(bytes)!==expectedSha256)throw xlsxError('HASH');
  if(signal?.aborted)throw xlsxError('ABORTED');
  let profileJson;
  try{profileJson=JSON.stringify(profile);if(Buffer.byteLength(profileJson)>65536)throw Error();}
  catch{throw xlsxError('PROFILE');}
  const profileSha256=hash(Buffer.from(profileJson));
  const request=Buffer.from(JSON.stringify({schema:'fee-console.ratio-xlsx-request.v1',
    workbookBase64:bytes.toString('base64'),workbookSha256:expectedSha256,profileJson,
    now:now.toISOString(),budgetMs:Math.min(timeoutMs,15000)}));
  return new Promise((resolve,reject)=>{
    let child,timer,done=false,size=0,errSize=0;const parts=[];
    const finish=(error,value)=>{
      if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);
      if(error){try{child?.kill('SIGKILL');}catch{}reject(error);}else resolve(value);
    };
    const abort=()=>finish(xlsxError('ABORTED'));
    try{
      child=spawnImpl('/usr/bin/python3',['-I',XLSX_SCRIPT],{
        stdio:['pipe','pipe','pipe'],env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8',PYTHONIOENCODING:'utf-8'},
        windowsHide:true,
      });
      child.on('error',()=>finish(xlsxError('PROCESS')));
      child.stdin.on('error',()=>finish(xlsxError('PROCESS')));
      child.stdout.on('data',part=>{
        if(done)return;if(!(part instanceof Uint8Array))return finish(xlsxError('OUTPUT'));
        size+=part.byteLength;if(size>MAX)return finish(xlsxError('OUTPUT'));parts.push(Buffer.from(part));
      });
      // Never expose stderr or a raw subprocess exception, even on failure.
      child.stderr.on('data',part=>{if(done)return;if(!(part instanceof Uint8Array))return finish(xlsxError('OUTPUT'));errSize+=part.byteLength;if(errSize>4096)finish(xlsxError('OUTPUT'));});
      child.on('close',code=>{
        if(done)return;
        try{
          if(errSize)throw xlsxError('OUTPUT');
          const value=createLegacyPolicy().parseExactJson(Buffer.concat(parts,size));
          if(code===2&&Object.keys(value).join(',')==='error'&&typeof value.error==='string'){
            const reason=value.error.replace(/^RATIO_XLSX_/,'');
            if(value.error==='RATIO_XLSX_'+reason&&XLSX_CODES.has(reason))return finish(xlsxError(reason));
          }
          const keys=['schema','status','kind','publicationReady','sourceVerified','completenessVerified',
            'metadata','rows','rowCount','additionalWorksheetCount','workbookSha256','profileSha256'];
          if(code!==0||!value||typeof value!=='object'||Object.keys(value).sort().join(',')!==keys.sort().join(',')
            ||value.schema!=='fee-console.ratio-xlsx-preview.v1'||value.status!=='PARSED_UNAUTHENTICATED'
            ||value.publicationReady!==false||value.sourceVerified!==false||value.completenessVerified!==false
            ||value.kind!==profile.kind||value.workbookSha256!==expectedSha256||value.profileSha256!==profileSha256
            ||!Array.isArray(value.rows)||value.rowCount!==value.rows.length||!Number.isSafeInteger(value.rowCount)||value.rowCount<1
            ||!Number.isSafeInteger(value.additionalWorksheetCount)||value.additionalWorksheetCount<0)throw xlsxError('OUTPUT');
          finish(null,value);
        }catch(error){finish(xlsxErrors.has(error)?error:xlsxError('OUTPUT'));}
      });
      signal?.addEventListener('abort',abort,{once:true});
      timer=setTimeout(()=>finish(xlsxError('TIMEOUT')),timeoutMs);
      if(signal?.aborted)return abort();
      child.stdin.end(request);
    }catch{finish(xlsxError('PROCESS'));}
  });
}

const XLSX_SET_KINDS={classification:['classification',null],exposure:['exposure',null],
  'assetclass-all':['performance','all'],'assetclass-one-year':['performance','oneYear'],
  'strategy-all':['performance','all'],'strategy-one-year':['performance','oneYear'],
  'stock-all':['performance','all'],'stock-one-year':['performance','oneYear'],
  'top5-all':['performance','all'],'top5-one-year':['performance','oneYear']};
export const RATIO_XLSX_ROLES=Object.freeze(Object.keys(XLSX_SET_KINDS));

const xlsxDay=d=>typeof d==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(d)
  &&Number.isFinite(Date.parse(d+'T00:00:00Z'))&&new Date(d+'T00:00:00Z').toISOString().slice(0,10)===d;

function snapshotWorkbookSet(workbooks){
  if(!Array.isArray(workbooks)||workbooks.length!==RATIO_XLSX_ROLES.length)throw xlsxError('INPUT');
  const snapshots=new Map();let inputSize=0;
  // Check every role/pin and copy every input before the first child starts.
  // A bad last pin must not waste nine processes or permit partial output.
  for(const item of workbooks){
    if(!item||typeof item!=='object'||Array.isArray(item)
      ||Object.keys(item).sort().join(',')!=='expectedSha256,profile,role,workbookBytes'
      ||!RATIO_XLSX_ROLES.includes(item.role)||snapshots.has(item.role)
      ||!(item.workbookBytes instanceof Uint8Array)||!item.workbookBytes.byteLength||item.workbookBytes.byteLength>MAX
      ||typeof item.expectedSha256!=='string'||!/^[a-f0-9]{64}$/.test(item.expectedSha256))throw xlsxError('INPUT');
    inputSize+=item.workbookBytes.byteLength;if(inputSize>20*1024*1024)throw xlsxError('INPUT');
    const bytes=Buffer.from(item.workbookBytes);
    if(hash(bytes)!==item.expectedSha256)throw xlsxError('HASH');
    let profile;
    try{const json=JSON.stringify(item.profile);if(Buffer.byteLength(json)>65536)throw Error();profile=createLegacyPolicy().parseExactJson(Buffer.from(json));}
    catch{throw xlsxError('PROFILE');}
    if(!profile||typeof profile!=='object'||Array.isArray(profile)||profile.kind!==XLSX_SET_KINDS[item.role][0]
      ||!Array.isArray(profile.expectedAccounts)||!profile.expectedAccounts.length
      ||profile.expectedAccounts.some(v=>typeof v!=='string'||!v.length)
      ||new Set(profile.expectedAccounts).size!==profile.expectedAccounts.length
      ||typeof profile.expectedView!=='string'||!profile.expectedView.length)throw xlsxError('PROFILE');
    snapshots.set(item.role,{role:item.role,workbookBytes:bytes,expectedSha256:item.expectedSha256,profile});
  }
  const accounts=JSON.stringify([...snapshots.get('classification').profile.expectedAccounts].sort());
  for(const input of snapshots.values())if(JSON.stringify([...input.profile.expectedAccounts].sort())!==accounts)throw xlsxError('SCOPE');
  if(snapshots.get('classification').profile.expectedView!==snapshots.get('exposure').profile.expectedView)throw xlsxError('SCOPE');
  for(const family of ['assetclass','strategy','stock','top5']){
    if(snapshots.get(family+'-all').profile.expectedView!==snapshots.get(family+'-one-year').profile.expectedView)throw xlsxError('SCOPE');
  }
  return snapshots;
}

// Decode an already supplied, fully pinned ten-workbook set. This function has
// no reader, URL, file path or publisher dependency. Role coverage is not proof
// of complete worksheets, actual account scope, or an official download.
export async function parseRatioWorkbookSet({workbooks,now=new Date(),timeoutMs=30_000,
  signal,spawnImpl=spawn}={}){
  const started=process.hrtime.bigint();
  if(!(now instanceof Date)||!Number.isFinite(now.getTime())
    ||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>30_000
    ||signal!==undefined&&!(signal instanceof AbortSignal)||typeof spawnImpl!=='function')throw xlsxError('INPUT');
  if(signal?.aborted)throw xlsxError('ABORTED');
  const frozenNow=new Date(now.getTime()),snapshots=snapshotWorkbookSet(workbooks);
  const remaining=()=>Math.ceil(timeoutMs-Number(process.hrtime.bigint()-started)/1e6);
  if(remaining()<=0)throw xlsxError('TIMEOUT');
  const controller=new AbortController(),abort=()=>controller.abort();let timedOut=false,decodedSize=0;
  signal?.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(()=>{timedOut=true;controller.abort();},remaining());
  const parsed=[],dates={};
  const day=xlsxDay;
  try{
    for(const role of RATIO_XLSX_ROLES){
      if(signal?.aborted)throw xlsxError('ABORTED');
      const left=remaining();if(left<=0||timedOut)throw xlsxError('TIMEOUT');
      const input=snapshots.get(role);
      const preview=await parseRatioWorkbook({...input,now:frozenNow,
        timeoutMs:Math.min(20_000,left),signal:controller.signal,spawnImpl});
      const m=preview.metadata;
      if(!m||typeof m!=='object'||Array.isArray(m)||m.currency!=='USD')throw xlsxError('CURRENCY');
      if(!day(m.asOf))throw xlsxError('DATE');
      if(m.view!==input.profile.expectedView)throw xlsxError('SCOPE');
      if(role==='classification'||role==='exposure')dates[role]=m.asOf;
      else{
        if(m.period!==XLSX_SET_KINDS[role][1]||m.includeClosed!==true
          ||!day(m.startDate)||m.startDate>m.asOf||m.endDate!==m.asOf
          ||!['included','excluded','mixed','unknown'].includes(m.cashPerformance)
          ||m.period==='oneYear'&&m.startDate!==createAggregateReturnsCore().oneYearBefore(m.asOf))throw xlsxError('PERFORMANCE');
        if(dates.performance&&dates.performance!==m.asOf)throw xlsxError('DATE');
        dates.performance=m.asOf;
      }
      decodedSize+=Buffer.byteLength(JSON.stringify(preview));
      if(decodedSize>20*1024*1024)throw xlsxError('OUTPUT');
      parsed.push({role,preview});
    }
    if(signal?.aborted)throw xlsxError('ABORTED');
    if(remaining()<=0||timedOut)throw xlsxError('TIMEOUT');
    if(dates.classification>dates.exposure||dates.performance>dates.exposure)throw xlsxError('DATE');
    const manifest={schema:'fee-console.ratio-xlsx-set-manifest.v1',status:'UNAUTHENTICATED',
      sourceDates:dates,workbooks:parsed.map(({role,preview})=>({role,workbookSha256:preview.workbookSha256,
        profileSha256:preview.profileSha256,reportDate:preview.metadata.asOf,declaredView:preview.metadata.view}))};
    return {schema:'fee-console.ratio-xlsx-set-preview.v1',status:'PARSED_UNAUTHENTICATED',
      publicationReady:false,sourceVerified:false,completenessVerified:false,
      sourceDates:{...dates},workbooks:parsed,manifest,
      manifestSha256:hash(Buffer.from(JSON.stringify(manifest)))};
  }catch(error){if(timedOut)throw xlsxError('TIMEOUT');throw xlsxErrors.has(error)?error:xlsxError('OUTPUT');}
  finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}

const sourceExact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)
  &&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
const sourceText=value=>typeof value==='string'&&value.length>0&&value.length<=1000&&!/[\x00-\x1f\x7f]/.test(value);
const instant=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  &&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
const hkDay=at=>new Date(at+8*3600000).toISOString().slice(0,10);
function sourceClock(clock){
  try{const value=clock();if(!(value instanceof Date)||!Number.isFinite(value.getTime()))throw Error();return new Date(value.getTime());}
  catch{throw xlsxError('SOURCE_DATE');}
}
function normalizedSourceContract(value,bindings){
  let contract;
  try{const bytes=Buffer.from(JSON.stringify(value));if(bytes.length>65536)throw Error();contract=createLegacyPolicy().parseExactJson(bytes);}
  catch{throw xlsxError('SOURCE_CONTRACT');}
  if(!sourceExact(contract,['schema','requestDataAsOf','sources'])||contract.schema!=='fee-console.ratio-xlsx-source-contract.v1'
    ||!xlsxDay(contract.requestDataAsOf)||!Array.isArray(contract.sources)||contract.sources.length!==RATIO_XLSX_ROLES.length)throw xlsxError('SOURCE_CONTRACT');
  const seen=new Set();
  for(const s of contract.sources){
    if(!sourceExact(s,['role','workbookSha256','profileSha256','provider','report','transport','view','dateMode','requestedDate','capture'])
      ||!RATIO_XLSX_ROLES.includes(s.role)||seen.has(s.role)||s.provider!=='Sharesight'
      ||!['browser-xlsx','archived-xlsx'].includes(s.transport)||!sourceText(s.view)
      ||!sourceExact(s.capture,['basis','at'])||!['download-completed','original-file-mtime','unknown'].includes(s.capture.basis)
      ||(s.capture.basis==='unknown'?s.capture.at!==null:!instant(s.capture.at)))throw xlsxError('SOURCE_CONTRACT');
    seen.add(s.role);const b=bindings.get(s.role);
    if(!b||s.workbookSha256!==b.workbookSha256||s.profileSha256!==b.profileSha256||s.view!==b.view)throw xlsxError('SOURCE_CONTRACT');
    if(s.role==='exposure'){
      if(s.report!=='Exposure'||s.dateMode!=='current-only'||s.requestedDate!==null)throw xlsxError('SOURCE_CONTRACT');
    }else{
      if(!xlsxDay(s.requestedDate)||s.requestedDate>contract.requestDataAsOf)throw xlsxError('SOURCE_CONTRACT');
      if(s.role==='classification'){
        if(!['Diversity','Performance','Investments'].includes(s.report)||s.dateMode!=='as-of'
          ||s.report==='Investments'&&s.transport!=='archived-xlsx')throw xlsxError('SOURCE_CONTRACT');
      }else if(s.report!=='Performance'||s.dateMode!=='period')throw xlsxError('SOURCE_CONTRACT');
    }
  }
  if(new Set(contract.sources.filter(s=>s.role!=='classification'&&s.role!=='exposure').map(s=>s.requestedDate)).size!==1)throw xlsxError('SOURCE_CONTRACT');
  contract.sources.sort((a,b)=>RATIO_XLSX_ROLES.indexOf(a.role)-RATIO_XLSX_ROLES.indexOf(b.role));
  return {value:contract,sha256:hash(Buffer.from(createOfficialRatioSourceCore().canonical(contract)))};
}
function checkCaptureClaims(contract,now){
  if(contract.requestDataAsOf>hkDay(now.getTime()))throw xlsxError('SOURCE_DATE');
  const issues=[];
  for(const s of contract.sources){
    if(s.capture.at===null)issues.push({role:s.role,code:'CAPTURE_TIME_UNKNOWN'});
    else{
      const age=now.getTime()-Date.parse(s.capture.at);
      if(age<0||age>36*3600000)throw xlsxError('CAPTURE');
      if(s.capture.basis==='original-file-mtime')issues.push({role:s.role,code:'CAPTURE_MTIME_ONLY'});
    }
  }
  return issues;
}

// This contract describes declared provenance and actual workbook dates. It
// neither authenticates the provider nor turns a timestamp into download proof.
export function assessRatioWorkbookSources(preview,sourceContract,{now=new Date()}={}){
  const clock=sourceClock(()=>now),bindings=new Map(),dates={};
  if(!preview||preview.schema!=='fee-console.ratio-xlsx-set-preview.v1'||preview.status!=='PARSED_UNAUTHENTICATED'
    ||preview.publicationReady!==false||preview.sourceVerified!==false||preview.completenessVerified!==false
    ||!Array.isArray(preview.workbooks)||preview.workbooks.length!==RATIO_XLSX_ROLES.length)throw xlsxError('SOURCE_CONTRACT');
  for(const item of preview.workbooks){
    const p=item?.preview,m=p?.metadata;
    if(!RATIO_XLSX_ROLES.includes(item?.role)||bindings.has(item.role)||p?.kind!==XLSX_SET_KINDS[item.role][0]
      ||p.sourceVerified!==false||p.publicationReady!==false||p.completenessVerified!==false||m?.currency!=='USD'
      ||!xlsxDay(m.asOf)||!sourceText(m.view)||!/^[a-f0-9]{64}$/.test(p.workbookSha256||'')||!/^[a-f0-9]{64}$/.test(p.profileSha256||''))throw xlsxError('SOURCE_CONTRACT');
    bindings.set(item.role,{workbookSha256:p.workbookSha256,profileSha256:p.profileSha256,view:m.view,asOf:m.asOf});
    const age=(Date.parse(hkDay(clock.getTime()))-Date.parse(m.asOf))/86400000;
    if(age<0||age>4)throw xlsxError('SOURCE_DATE');
    if(item.role==='classification'||item.role==='exposure')dates[item.role]=m.asOf;
    else{if(dates.performance&&dates.performance!==m.asOf)throw xlsxError('SOURCE_DATE');dates.performance=m.asOf;}
  }
  if(dates.classification>dates.exposure||dates.performance>dates.exposure
    ||createOfficialRatioSourceCore().canonical(dates)!==createOfficialRatioSourceCore().canonical(preview.sourceDates))throw xlsxError('SOURCE_DATE');
  const normalized=normalizedSourceContract(sourceContract,bindings),contract=normalized.value;
  const issues=[{role:null,code:'SOURCE_ORIGIN_UNVERIFIED'},...checkCaptureClaims(contract,clock)];
  for(const s of contract.sources){
    const actual=bindings.get(s.role).asOf;
    if(s.dateMode!=='current-only'&&actual!==s.requestedDate)throw xlsxError('SOURCE_DATE');
    if(s.capture.at!==null&&actual>hkDay(Date.parse(s.capture.at)))throw xlsxError('CAPTURE');
    if(s.role==='exposure'&&actual!==contract.requestDataAsOf)issues.push({role:s.role,
      code:actual>contract.requestDataAsOf?'EXPOSURE_CURRENT_ONLY_AFTER_REQUEST':'EXPOSURE_ASOF_BEFORE_REQUEST'});
  }
  return {schema:'fee-console.ratio-xlsx-source-assessment.v1',status:'UNVERIFIED',publicationReady:false,
    sourceVerified:false,requestDataAsOf:contract.requestDataAsOf,sourceDates:{...dates},
    sourceContractSha256:normalized.sha256,declaredReports:Object.fromEntries(contract.sources.map(s=>[s.role,s.report])),
    declaredCaptures:Object.fromEntries(contract.sources.map(s=>[s.role,{...s.capture}])),issues};
}

// Explicit recovery of local decoding only. No read/export/publisher callback
// exists. Every resume restarts the same pinned bytes and rechecks original
// capture times at the current clock; status JSON cannot restore a session.
export function createRatioWorkbookSession({workbooks,sourceContract,clock=()=>new Date(),
  timeoutMs=30_000,spawnImpl=spawn}={}){
  if(typeof clock!=='function'||typeof spawnImpl!=='function'||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>30_000)throw xlsxError('INPUT');
  let frozen=[...snapshotWorkbookSet(workbooks).values()];
  const bindings=new Map(frozen.map(i=>[i.role,{workbookSha256:i.expectedSha256,profileSha256:hash(Buffer.from(JSON.stringify(i.profile))),view:i.profile.expectedView}]));
  const contract=normalizedSourceContract(sourceContract,bindings);
  let state='NEW',code=null,attempt=0,active=null,lastClock=-Infinity;
  const status=()=>({schema:'fee-console.ratio-xlsx-session-status.v1',state,code,attempt,resumable:state==='PAUSED',
    sourceContractSha256:contract.sha256,publicationReady:false,sourceVerified:false,completenessVerified:false});
  const readClock=()=>{const at=sourceClock(clock);if(at.getTime()<lastClock)throw xlsxError('SOURCE_DATE');lastClock=at.getTime();return at;};
  async function execute(resume,options={}){
    if(!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(k=>!['signal','timeoutMs'].includes(k))
      ||(resume?state!=='PAUSED':state!=='NEW'))throw xlsxError('RECOVERY_STATE');
    const limit=options.timeoutMs??timeoutMs,signal=options.signal;
    if(!Number.isInteger(limit)||limit<1||limit>30_000||signal!==undefined&&!(signal instanceof AbortSignal))throw xlsxError('INPUT');
    state='RUNNING';code=null;attempt++;active=new AbortController();
    const controller=active,abort=()=>controller.abort(),started=process.hrtime.bigint();
    signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    try{
      if(controller.signal.aborted)throw xlsxError('ABORTED');
      const begin=readClock();checkCaptureClaims(contract.value,begin);
      const remaining=Math.ceil(limit-Number(process.hrtime.bigint()-started)/1e6);
      if(remaining<=0)throw xlsxError('TIMEOUT');
      const preview=await parseRatioWorkbookSet({workbooks:frozen,now:begin,timeoutMs:remaining,signal:controller.signal,spawnImpl});
      if(state==='CLOSED')return status();
      const assessment=assessRatioWorkbookSources(preview,contract.value,{now:readClock()});
      if(controller.signal.aborted)throw xlsxError('ABORTED');
      if(Number(process.hrtime.bigint()-started)/1e6>=limit)throw xlsxError('TIMEOUT');
      state='PREVIEW_READY';code='PARSED_UNAUTHENTICATED';
      return {...status(),preview,sourceAssessment:assessment};
    }catch(error){
      if(state==='CLOSED')return status();
      const known=xlsxErrors.has(error)?error:xlsxError('OUTPUT');code=ratioWorkbookFailureCode(known);
      state=['RATIO_XLSX_TIMEOUT','RATIO_XLSX_ABORTED'].includes(code)?'PAUSED':'BLOCKED';return status();
    }finally{signal?.removeEventListener('abort',abort);active=null;}
  }
  return Object.freeze({run:options=>execute(false,options),resume:options=>execute(true,options),status,
    close(){state='CLOSED';code='RATIO_XLSX_CLOSED';active?.abort();frozen=null;return status();}});
}

// Pure control intentions for the three observed Tools report pages. Exact
// placeholders are observed text, not tested selectors or download authority.
const EXPOSURE_GROUPS=Object.freeze(['Market','Currency','Sector classification','Industry classification','Investment type','Country','No grouping']);
const uiDay=iso=>iso.slice(8,10)+'/'+iso.slice(5,7)+'/'+iso.slice(0,4);
function controlDay(value){
  if(typeof value!=='string'||!/^\d{2}\/\d{2}\/\d{4}$/.test(value))refusal('CONTROLS_DATE');
  const iso=value.slice(6,10)+'-'+value.slice(3,5)+'-'+value.slice(0,2);
  if(!xlsxDay(iso))refusal('CONTROLS_DATE');return iso;
}
export function planRatioReportControls(intent){
  if(!sourceExact(intent,['role','report','view','asOf','startDate','period','exposure'])
    ||!RATIO_XLSX_ROLES.includes(intent.role)||!sourceText(intent.view))refusal('CONTROLS_INPUT');
  let dateInputs=[],includeClosed=null,exposure=null;
  if(intent.role==='exposure'){
    if(intent.report!=='Exposure'||intent.asOf!==null||intent.startDate!==null||intent.period!==null
      ||!sourceExact(intent.exposure,['grouping','top'])||!EXPOSURE_GROUPS.includes(intent.exposure.grouping)
      ||![50,100,250,500].includes(intent.exposure.top))refusal('CONTROLS_INPUT');
    exposure={grouping:intent.exposure.grouping,top:intent.exposure.top};
  }else if(intent.role==='classification'){
    // Classification through Performance needs an accepted mapping, not a
    // synthetic conversion of a period report to a one-date report.
    if(intent.report!=='Diversity'||intent.startDate!==null||intent.period!==null||intent.exposure!==null)refusal('CONTROLS_INPUT');
    if(!xlsxDay(intent.asOf))refusal('CONTROLS_DATE');
    dateInputs=[{placeholder:'Enter your date',value:uiDay(intent.asOf)}];
  }else{
    if(intent.report!=='Performance'||intent.exposure!==null||intent.period!==XLSX_SET_KINDS[intent.role][1])refusal('CONTROLS_INPUT');
    if(!xlsxDay(intent.asOf)||!xlsxDay(intent.startDate)||intent.startDate>intent.asOf
      ||intent.period==='oneYear'&&intent.startDate!==createAggregateReturnsCore().oneYearBefore(intent.asOf))refusal('CONTROLS_DATE');
    dateInputs=[{placeholder:'Enter your start date',value:uiDay(intent.startDate)},
      {placeholder:'Enter your end date',value:uiDay(intent.asOf)}];includeClosed=true;
  }
  const request={role:intent.role,report:intent.report,view:intent.view,asOf:intent.asOf,
    startDate:intent.startDate,period:intent.period,exposure:exposure?{...exposure}:null};
  return {schema:'fee-console.ratio-report-control-plan.v1',status:'PLANNED_UNVERIFIED',
    request,dateInputs,includeClosedLabel:includeClosed===null?null:'Include closed positions',includeClosed,exposure,
    intentSha256:hash(Buffer.from(createOfficialRatioSourceCore().canonical(request))),
    sourceVerified:false,scopeVerified:false,downloadVerified:false,publicationReady:false};
}

export function assessRatioReportControls(intent,observed){
  const plan=planRatioReportControls(intent);
  const sameExposure=plan.exposure===null?observed?.exposure===null:
    sourceExact(observed?.exposure,['grouping','top'])&&observed.exposure.grouping===plan.exposure.grouping&&observed.exposure.top===plan.exposure.top;
  if(!sourceExact(observed,['report','view','dateInputs','includeClosedLabel','includeClosed','exposure','exportVisible'])
    ||observed.report!==plan.request.report||observed.view!==plan.request.view
    ||typeof observed.exportVisible!=='boolean'||!Array.isArray(observed.dateInputs)
    ||observed.dateInputs.length!==plan.dateInputs.length||observed.includeClosed!==plan.includeClosed
    ||observed.includeClosedLabel!==plan.includeClosedLabel
    ||!sameExposure)refusal('CONTROLS_MISMATCH');
  const dates={},seen=new Set();
  for(const input of observed.dateInputs){
    if(!sourceExact(input,['placeholder','value'])||seen.has(input.placeholder))refusal('CONTROLS_MISMATCH');
    const expected=plan.dateInputs.find(v=>v.placeholder===input.placeholder);
    if(!expected)refusal('CONTROLS_MISMATCH');
    const iso=controlDay(input.value);
    if(input.value!==expected.value)refusal('CONTROLS_MISMATCH');
    seen.add(input.placeholder);dates[input.placeholder]=iso;
  }
  return {schema:'fee-console.ratio-report-control-assessment.v1',status:'CONTROLS_MATCH_UNVERIFIED',
    role:plan.request.role,report:plan.request.report,observedViewLabel:observed.view,
    normalizedDates:dates,intentSha256:plan.intentSha256,exportControlVisible:observed.exportVisible,
    sourceVerified:false,scopeVerified:false,downloadVerified:false,publicationReady:false,
    issues:['SOURCE_ORIGIN_UNVERIFIED','VIEW_SCOPE_UNVERIFIED','DOWNLOAD_NOT_OBSERVED',
      ...(observed.exportVisible?[]:['EXPORT_CONTROL_NOT_OBSERVED'])]};
}
