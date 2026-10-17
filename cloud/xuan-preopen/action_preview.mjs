// Private composition after one separately approved cloud orders test. No IB
// reader, refresh, job dispatch, public write, key or credential creation here.
import {digest} from './eod_sources.mjs';
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
  readSharesight=readSharesightAction,expectedAccount=APPROVED_IB_ACCOUNT_ID,concentrationInput=null}={}){
  if(typeof io?.savePrivate!=='function'||typeof loadContext!=='function')fail();
  const context=await loadContext({now});validateAssociationSnapshot(context.association,{now:now(),edition:'am'});
  const source=validatePreviewOrdersBundle(bundle,{now:now(),association:context.association,expectedAccount});
  const snapshotReader=createEodSnapshotReader({sourceDate,readSharesightBatch:async date=>{
    if(typeof io.loadGatewayToken!=='function')throw Error('SHARESIGHT_READ_SCOPE_INVALID');
    const token=await io.loadGatewayToken();return readSharesight(date,token,{now,settle:true});
  }});
  return runPrivateEodReport({sourceDate,io,now,loadContext,fieldMode:true,initialStartedAt:Date.parse(source.startedAt),
    readArchive:null,verifyArchive:null,snapshotReader,
    captureOptionalLive:async()=>({status:'captured',sources:[source],probeEvidence:{receiptSha256:bundle.receiptSha256,object:bundle.object}}),concentrationInput});
}
