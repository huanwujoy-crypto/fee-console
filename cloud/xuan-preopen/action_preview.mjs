// Private composition after one separately approved cloud orders test. No IB
// reader, refresh, job dispatch, public write, key or credential creation here.
import {digest,readVerifiedSnapshot,SNAPSHOT_SCOPES,SHARESIGHT_BROWSER_SOURCE,SHARESIGHT_VALUATION_DATE_BASIS} from './eod_sources.mjs';
import {runPrivateEodReport} from './eod_report.mjs';
import {loadTrustedContext,readSharesightAction} from './report.mjs';
import {createEodSnapshotReader} from './eod_adapters.mjs';
import {inspectOrdersAccountEvidence} from './orders_probe.mjs';
import {APPROVED_IB_ACCOUNT_ID,fingerprint} from '../../scripts/xuan-ib-run-manifest.mjs';
import {validateAssociationSnapshot} from '../../scripts/xuan-ib-account-association.mjs';
const fail=()=>{throw Error('PRIVATE_ACTION_PROBE_BINDING_INVALID');};
const instant=s=>typeof s==='string'&&Number.isFinite(Date.parse(s))&&new Date(s).toISOString()===s;
const hkt=n=>new Date(n+28800000).toISOString().slice(0,10);

// The approved controller must fetch these exact new-operation objects from
// the fixed private bucket and pin generation, never from an older EOD context.
// This pure check binds that supplied evidence; it does not authenticate an
// arbitrary caller's objects or independently prove their network origin.
export function validatePreviewOrdersBundle(bundle,{now=Date.now(),association,expectedAccount=APPROVED_IB_ACCOUNT_ID}={}){
  const {receipt:r,source:s,object:o,receiptSha256}=bundle??{};
  if(r?.schemaVersion!==1||r.mode!=='cloud-orders-probe'||r.status!=='passed'||r.dataDate!==hkt(now)
    ||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(r.requestId||'')
    ||!/^xuan-preopen-orders-probe-[a-z0-9-]+$/.test(r.execution||'')||r.upstreamAttempted!==true||r.ordersCalls!==1||![0,1].includes(r.refreshCalls)
    ||!['not-needed','saved'].includes(r.credentialPersistence)||!instant(r.startedAt)||!instant(r.completedAt)||r.startedAt>r.completedAt
    ||Date.parse(r.completedAt)>now||Date.parse(r.completedAt)-Date.parse(r.startedAt)>65000||now-Date.parse(r.startedAt)>300000
    ||r.association?.policyBlob!==association?.policyBlob||r.association?.accountAlias!==association?.policy?.accountAlias
    ||r.artifact?.privateObject!=='report-check/orders-probe-'+r.requestId+'/orders.json'||!/^\d+$/.test(r.artifact?.generation||'')
    ||o?.name!==r.artifact.privateObject||o.generation!==r.artifact.generation||o.sha256!==r.artifact.sha256||digest(s)!==o.sha256||digest(r)!==receiptSha256
    ||s?.sourceKey!=='ib.orders'||!instant(s.startedAt)||!instant(s.completedAt)||s.startedAt<r.startedAt
    ||s.startedAt>s.completedAt||s.completedAt>r.completedAt||s.rawFingerprint!==fingerprint(s.raw))fail();
  const rawEvidence=inspectOrdersAccountEvidence(s.raw,{expectedAccount}),evidence=s.accountEvidence;
  // The pinned source retains the R3 transport verdict for identifiers present
  // only in discarded RPC wrappers. Its origin still requires the controller's
  // authorized fixed-bucket read; no caller-provided enum proves an origin.
  if(!evidence||Object.keys(evidence).sort().join('|')!=='associationBasis|nativeIdentityEvidence|responseAccountEvidence'
    ||evidence.associationBasis!=='owner-attested'||!['matched','not-provided'].includes(evidence.responseAccountEvidence)
    ||evidence.nativeIdentityEvidence!==(evidence.responseAccountEvidence==='matched'?'response-account-id':'not-provided')
    ||rawEvidence.responseAccountEvidence==='matched'&&evidence.responseAccountEvidence!=='matched')fail();
  for(const key of Object.keys(evidence))if(r[key]!==evidence[key])fail();
  return s;
}

export async function composePrivateActionPreview({bundle,sourceDate,io,now=Date.now,loadContext=loadTrustedContext,
  readSharesight=readSharesightAction,expectedAccount=APPROVED_IB_ACCOUNT_ID,concentrationInput=null,assumeSharesightSynchronized=true,snapshotReader:providedSnapshotReader=null,captureStartedAt=null}={}){
  if(typeof io?.savePrivate!=='function'||typeof loadContext!=='function')fail();
  const context=await loadContext({now});validateAssociationSnapshot(context.association,{now:now(),edition:'am'});
  const source=validatePreviewOrdersBundle(bundle,{now:now(),association:context.association,expectedAccount});
  const snapshotReader=providedSnapshotReader??createEodSnapshotReader({sourceDate,readSharesightBatch:async date=>{
    if(typeof io.loadGatewayToken!=='function')throw Error('SHARESIGHT_READ_SCOPE_INVALID');
    const token=await io.loadGatewayToken();return readSharesight(date,token,{now,settle:true});
  }});
  return runPrivateEodReport({sourceDate,io,now,loadContext,fieldMode:true,initialStartedAt:captureStartedAt===null?Date.parse(source.startedAt):Date.parse(captureStartedAt),
    readArchive:null,verifyArchive:null,snapshotReader,
    captureOptionalLive:async()=>({status:'captured',sources:[source],probeEvidence:{receiptSha256:bundle.receiptSha256,object:bundle.object}}),concentrationInput,assumeSharesightSynchronized});
}

// No source clients: the parent supplies authenticated browser observations.
// Validate/model/render every object locally before the one create-only claim.
// The real access factory is separately protected; tests inject only synthetic IO.
export async function composeBrowserActionEvidence({sourceDate,snapshots,captureStartedAt,ordersCapture=null,access,now=Date.now,loadContext=loadTrustedContext}={}){
  // Local-only recovery registration is outside the unchanged cloud image.
  const {registeredOwnerRecovery}=await import('./owner_source_recovery.mjs');
  const registration=registeredOwnerRecovery(),keys=Object.keys(SNAPSHOT_SCOPES),start=Date.parse(captureStartedAt);
  if(!instant(captureStartedAt)||!Number.isFinite(start)||start>now()||now()-start>300000||hkt(start)!==registration.dataDate
    ||!snapshots||Object.keys(snapshots).sort().join('|')!==keys.sort().join('|')
    ||typeof access?.beginEvidence!=='function'||typeof access?.writeEvidence!=='function')fail();
  // Browser sourceDate is the visible book valuation date, not a price date.
  const dateBasis=SHARESIGHT_VALUATION_DATE_BASIS;
  if(sourceDate>hkt(start))fail();
  const verified={};
  for(const key of keys){
    const raw=snapshots[key];if(raw?.source!==SHARESIGHT_BROWSER_SOURCE)fail();
    const value=await readVerifiedSnapshot(key,{reader:async()=>({raw}),sourceDate,now});
    if(value.status!=='date-verified'||Date.parse(value.provenance?.readAt)<start||Date.parse(value.provenance?.readAt)>now())fail();
    verified[key]=structuredClone(raw);
  }
  const context=await loadContext({now}),contextReader=async()=>context;
  // Reuse the existing private-runner capture shape for a separately authorized
  // normal MCP read. This is data only: no source client, callback, credential,
  // old probe claim or cloud-job execution is created here. The controller owns
  // authentic capture; fingerprints alone do not authenticate a caller.
  let live={status:'not-called',code:'IB_MCP_ROUTES_UNAVAILABLE'};
  if(ordersCapture!==null){
    const capture=structuredClone(ordersCapture),s=capture?.sources?.[0],sourceKeys=Object.keys(s??{}).sort().join('|');
    if(Object.keys(capture??{}).sort().join('|')!=='channel|sources|status'||!['cloud-mcp','mac-mcp'].includes(capture.channel)||capture.status!=='captured'||capture.sources?.length!==1
      ||!s||!['accountEvidence|completedAt|raw|rawFingerprint|sourceKey|startedAt',
        'accountEvidence|completedAt|raw|rawFingerprint|sourceKey|startedAt|transportFingerprint|wrapper'].includes(sourceKeys)
      ||s.sourceKey!=='ib.orders'||s.rawFingerprint!==fingerprint(s.raw)||!instant(s.startedAt)||!instant(s.completedAt)
      ||Date.parse(s.startedAt)<start||s.startedAt>s.completedAt||Date.parse(s.completedAt)>now())fail();
    // The existing decoder retains transport metadata in its pinned source.
    // Native transport equals raw; a decoded JSON string retains its separate
    // original fingerprint, whose provenance is the controller's pinned object.
    if(Object.hasOwn(s,'wrapper')&&(!['native-object','json-string'].includes(s.wrapper)
      ||!/^[a-f0-9]{64}$/.test(s.transportFingerprint||'')||s.wrapper==='native-object'&&s.transportFingerprint!==s.rawFingerprint))fail();
    const evidence=inspectOrdersAccountEvidence(s.raw),e=s.accountEvidence;
    if(!e||Object.keys(e).sort().join('|')!=='associationBasis|nativeIdentityEvidence|responseAccountEvidence'
      ||e.associationBasis!=='owner-attested'||!['matched','not-provided'].includes(e.responseAccountEvidence)
      ||e.nativeIdentityEvidence!==(e.responseAccountEvidence==='matched'?'response-account-id':'not-provided')
      ||evidence.responseAccountEvidence==='matched'&&e.responseAccountEvidence!=='matched')fail();
    live={status:capture.status,sources:capture.sources,normalMcpEvidence:{schema:'xuan.normal-mcp-orders.v1',requestId:registration.requestId,channel:capture.channel}};
  }
  const captureOptionalLive=async()=>structuredClone(live);
  let stagedBytes=0;
  await runPrivateEodReport({sourceDate,dateBasis,now,loadContext:contextReader,fieldMode:true,initialStartedAt:start,
    readArchive:null,verifyArchive:null,assumeSharesightSynchronized:true,
    snapshotReader:async({sourceKey})=>({raw:verified[sourceKey]}),captureOptionalLive,
    io:{savePrivate:async(name,value)=>{const size=Buffer.byteLength(typeof value==='string'?value:JSON.stringify(value));
      const limit=name.endsWith('/report.html')?2*1024*1024:name.endsWith('/receipt.json')?128*1024:4*1024*1024;
      stagedBytes+=size;if(size>limit||stagedBytes>31*1024*1024)fail();return {generation:'1',sha256:digest(value)};}}});
  // All model, date, CALL, normalization and HTML checks above finish without IO.
  // Native admission chooses the immutable run ID; rebuild from these same
  // verified in-memory values, then upload once with actual generation pins.
  const attempt=await access.beginEvidence({requestId:registration.requestId,captureStartedAt});
  if(attempt.requestId!==registration.requestId||attempt.dataDate!==registration.dataDate||attempt.captureStartedAt!==captureStartedAt
    ||! /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(attempt.runId))fail();
  const reportRunId=attempt.runId;
  const saved=await runPrivateEodReport({sourceDate,dateBasis,now,loadContext:contextReader,fieldMode:true,initialStartedAt:start,sourceRunId:reportRunId,
    readArchive:null,verifyArchive:null,assumeSharesightSynchronized:true,
    snapshotReader:async({sourceKey})=>({raw:verified[sourceKey]}),captureOptionalLive,
    io:{savePrivate:(name,value)=>access.writeEvidence(name,Buffer.from(typeof value==='string'?value:JSON.stringify(value)))}});
  const bytes=Buffer.from(JSON.stringify(saved)),pin=await access.writeEvidence(registration.receiptObject,bytes);
  return {requestId:registration.requestId,receipt:saved,receiptObject:registration.receiptObject,...pin};
}
