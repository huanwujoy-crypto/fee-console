// Undeployed fixed-source candidate. No IB OAuth/live call or producer claim.
import {APPROVED_IB_ACCOUNT_ID} from '../../scripts/xuan-ib-run-manifest.mjs';
import {CASH_ARCHIVE_BUCKET} from './cloud_io.mjs';
import {loadTrustedContext,readSharesightSnapshot} from './report.mjs';
import {adaptFlexArchive,digest,flexCurrencyCapability,inspectFlexArchive,validDate} from './eod_sources.mjs';
import {runPrivateEodReport} from './eod_report.mjs';

const QUERY='1630084', MAX_BYTES=8_000_000;
export const ARCHIVE_READ_BUDGET=Object.freeze({pagesPerPass:5,objectsPerPass:500,itemsPerPage:100,metadataBytes:2_000_000,candidates:4,bodyBytes:MAX_BYTES,deadlineMs:90_000});
const fail=code=>{throw new Error('EOD_ARCHIVE_'+code);};
const decimal=v=>typeof v==='string'&&/^[1-9]\d{0,29}$/.test(v);
function utcInstant(value){
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value))fail('CREATION_TIME');
  const ms=Date.parse(value);if(!Number.isFinite(ms)||new Date(ms).toISOString().slice(0,19)!==value.slice(0,19))fail('CREATION_TIME');return ms;
}
// Conservative reader window only. NY16 is not producer time or finality.
export function archiveEligibilityFloor(sourceDate){
  if(!validDate(sourceDate))fail('DATE');
  const anchor=Date.parse(sourceDate+'T16:00:00Z');
  const hour=Number(new Intl.DateTimeFormat('en',{timeZone:'America/New_York',hour:'2-digit',hourCycle:'h23'}).format(new Date(anchor)));
  if(![11,12].includes(hour))fail('TIMEZONE');
  return anchor+(16-hour)*3_600_000;
}
function objectIdentity(o,at){
  if(!o||!/^reports\/[a-f0-9]{64}\.xml$/.test(o.name||'')||!decimal(o.generation)||!decimal(o.metageneration)||!decimal(o.size)||Number(o.size)>MAX_BYTES)fail('OBJECT_METADATA');
  if(utcInstant(o.timeCreated)>at)fail('FUTURE_OBJECT');
  const metadata=o.metadata??{};
  if(Object.getPrototypeOf(metadata)!==Object.prototype||Object.entries(metadata).some(([k,v])=>!k||typeof v!=='string'||v.length>4096))fail('CUSTOM_METADATA');
  return {name:o.name,generation:o.generation,metageneration:o.metageneration,size:o.size,timeCreated:o.timeCreated,metadata:Object.fromEntries(Object.entries(metadata).sort(([a],[b])=>a.localeCompare(b)))};
}

export async function readFixedCashArchive({io,sourceDate,now=Date.now}={}){
  if(!io?.listCashArchives||!io?.getCashArchive)fail('IO_REQUIRED');
  const at=now(),floor=archiveEligibilityFloor(sourceDate),signal=AbortSignal.timeout(ARCHIVE_READ_BUDGET.deadlineMs);
  let metadataBytes=0;
  const charge=result=>{
    if(!Number.isSafeInteger(result?.responseBytes)||result.responseBytes<1)fail('METADATA_SIZE');
    metadataBytes+=result.responseBytes;if(metadataBytes>ARCHIVE_READ_BUDGET.metadataBytes)fail('METADATA_BUDGET');
    if(signal.aborted||now()-at>ARCHIVE_READ_BUDGET.deadlineMs)fail('DEADLINE');
  };
  async function enumerate(){
    const objects=[],names=new Set(),tokens=new Set();let pageToken;
    for(let pageIndex=0;pageIndex<ARCHIVE_READ_BUDGET.pagesPerPass;pageIndex++){
      const result=await io.listCashArchives({pageToken,signal});charge(result);
      const p=result.page;
      if(!p||Object.getPrototypeOf(p)!==Object.prototype||p.items!==undefined&&!Array.isArray(p.items)||(p.items??[]).length>ARCHIVE_READ_BUDGET.itemsPerPage)fail('PAGE_SHAPE');
      for(const raw of p.items??[]){
        if(names.has(raw?.name))fail('DUPLICATE_OBJECT');names.add(raw?.name);
        if(names.size>ARCHIVE_READ_BUDGET.objectsPerPass)fail('OBJECT_BUDGET');
        if(raw?.name==='reports/'&&String(raw.size)==='0')continue;
        objects.push(objectIdentity(raw,at));
      }
      if(p.nextPageToken===undefined)return objects.filter(o=>utcInstant(o.timeCreated)>=floor).sort((a,b)=>a.name.localeCompare(b.name));
      if(typeof p.nextPageToken!=='string'||!p.nextPageToken||p.nextPageToken.length>4096||tokens.has(p.nextPageToken))fail('PAGE_TOKEN');
      tokens.add(p.nextPageToken);pageToken=p.nextPageToken;
    }
    fail('PAGE_BUDGET');
  }
  const candidates=await enumerate();
  if(!candidates.length)fail('NO_ELIGIBLE_OBJECT');
  if(candidates.length>ARCHIVE_READ_BUDGET.candidates)fail('CANDIDATE_BUDGET');
  const matches=[];
  for(const selected of candidates){
    const result=await io.getCashArchive({...selected,signal});charge(result);
    if(digest(objectIdentity(result.object,at))!==digest(selected))fail('METADATA_CHANGED');
    const bytes=result.bytes;
    if(typeof bytes!=='string'||Buffer.byteLength(bytes)!==Number(selected.size)||Buffer.byteLength(bytes)>MAX_BYTES)fail('BODY_SIZE');
    const rawSha256=digest(bytes);if(selected.name!==`reports/${rawSha256}.xml`)fail('HASH');
    const scope=inspectFlexArchive(bytes,APPROVED_IB_ACCOUNT_ID);
    if(scope.sourceDate>sourceDate)fail('FUTURE_CUTOFF');
    const m=selected.metadata;
    if(m.sourceDate!==undefined&&m.sourceDate!==scope.sourceDate||m.configuredQueryId!==undefined&&m.configuredQueryId!==QUERY)fail('METADATA_CONFLICT');
    const currencyCapability=flexCurrencyCapability(scope,m);
    const archive={bytes,metadata:{privateObject:`gs://${CASH_ARCHIVE_BUCKET}/${selected.name}`,generation:selected.generation,metageneration:selected.metageneration,rawSha256,configuredQueryId:QUERY,producerQueryId:null,queryProvenance:'unknown',...currencyCapability,providerTimezone:null,timeCreated:selected.timeCreated,eligibilityFloor:new Date(floor).toISOString()}};
    // Validate every eligible original body, including late-uploaded stale ones.
    adaptFlexArchive(archive,{expectedAccount:APPROVED_IB_ACCOUNT_ID,expectedQueryId:QUERY,sourceDate:scope.sourceDate,readAt:new Date(now()).toISOString()});
    if(scope.sourceDate===sourceDate)matches.push(archive);
  }
  // Pagination is not a transaction. Reject changes in the eligible snapshot.
  if(digest(await enumerate())!==digest(candidates))fail('ENUMERATION_CHANGED');
  if(matches.length!==1)fail(matches.length?'AMBIGUOUS':'CUTOFF_NOT_FOUND');
  return matches[0];
}

export async function runFixedEodReport({sourceDate,io,now=Date.now,fetchImpl=fetch,privateNoahUiExport=null}={}){
  let token;
  return runPrivateEodReport({sourceDate,io,now,privateNoahUiExport,expectedAccount:APPROVED_IB_ACCOUNT_ID,expectedQueryId:QUERY,
    loadContext:()=>loadTrustedContext({fetchImpl,now}),
    readArchive:()=>readFixedCashArchive({io,sourceDate,now}),
    verifyArchive:async({archive})=>({status:'archive-verified',rawSha256:digest(archive.bytes),account:APPROVED_IB_ACCOUNT_ID,configuredQueryId:QUERY,producerQueryId:null,queryProvenance:'unknown',sourceDate,generation:archive.metadata.generation}),
    snapshotReader:async({sourceKey})=>{
      token??=Promise.resolve().then(()=>io.loadGatewayToken());
      return readSharesightSnapshot(sourceKey,sourceDate,await token,{fetchImpl,now});
    },
  });
}
