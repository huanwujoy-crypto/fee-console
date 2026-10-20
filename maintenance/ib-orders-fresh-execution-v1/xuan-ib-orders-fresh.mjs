// Fixed native maintenance entry. Import, no args and --plan perform no IO.
import crypto from 'node:crypto';
import path from 'node:path';
import * as fs from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {validatePrivateBinding,assertPrivateBinding,PRIVATE_BINDING_SHA256} from './binding.mjs';
import {createOperator} from './xuan-ib-orders-live-operator.mjs';
import {createBoundAudit,verifyExistingClientEvidence} from './source/scripts/xuan-ib-oauth-registration-audit.mjs';
const SELF=fileURLToPath(import.meta.url);
export const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const plain=x=>x&&Object.getPrototypeOf(x)===Object.prototype;
export const canonical=x=>Array.isArray(x)?'['+x.map(canonical).join(',')+']':plain(x)?'{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')+'}':JSON.stringify(x);
const exact=(x,keys)=>plain(x)&&Object.keys(x).sort().join('|')===[...keys].sort().join('|');
const hex=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const iso=x=>typeof x==='string'&&Number.isFinite(Date.parse(x))&&new Date(x).toISOString()===x;
export const CODE_FILES=Object.freeze(['binding.mjs','xuan-ib-orders-fresh.mjs','xuan-ib-orders-live-operator.mjs','renew.py',
  'source/cloud/xuan-preopen/cloud_io.mjs','source/cloud/xuan-preopen/ib_diagnostics.mjs','source/scripts/xuan-ib-cloud-oauth-bootstrap.mjs',
  'source/scripts/xuan-ib-decision-menu.mjs','source/scripts/xuan-ib-oauth-registration-audit.mjs']);
export const LIMITS=Object.freeze({registrations:0,ownerConsents:1,codeExchanges:1,initialVersions:1,runPosts:1,ordersCalls:1,refreshes:0,rotationVersions:0,
  newInfrastructure:0,iamChanges:0,secretServiceChanges:0,deployments:0,schedules:0,productionResume:0,newGoogleLogins:0,newGoogleGrants:0,newGoogleScopes:0});
const hex40=x=>typeof x==='string'&&/^[a-f0-9]{40}$/.test(x);
function createFreshExecution(binding,{bindingFile=null}={}){
  assertPrivateBinding(binding);
  const nativeApprovals=new WeakSet(),nativeClaims=new WeakSet(),nativeIOs=new WeakSet();
  const reusedClients=new WeakMap(),reuse=Boolean(binding.existingClient);
  const assertNativeApproval=a=>{if(!nativeApprovals.has(a)||!nativeClaims.has(a))throw Error('APPROVAL_REQUIRED');};
  const core=createOperator(binding);
  const {persistRegistrationAudit}=createBoundAudit(binding);
  const {FRESH,FIXED,SOURCE_HASHES,freshClaimRecord,safeJson,safeControlDiagnostic,boundedSafeSink,runStagedOperation,SafeFailure,executionAdmission,createObservedOAuthFetch,validateStageMaintenance,validateMaintenance,versionOf,versionName,CONTROL_BRIDGE}=core;
  const HERE=binding.candidate,APPROVAL_DIRECTORY=binding.approvalDirectory,APPROVAL_PATH=binding.approvalPath;
  const DEPENDENCIES=Object.freeze(Object.fromEntries(['node','python','googleCloudSdk','nodeExecutable','pythonExecutable','sdkCredentialSourceSha256'].map(k=>[k,binding.dependencies[k]])));
  const EXTERNAL_PINS=binding.externalPins,PREVIOUS_RECORDS=binding.previousRecords,PREVIOUS_NAMES=binding.previousNames,PREVIOUS_DIGEST=binding.previousDigest;
  const PATHS=Object.freeze({claim:FRESH.runtime+'/fresh.claim.safe.json',audit:FRESH.runtime+'/fresh.registration-audit.safe.json',result:FRESH.runtime+'/fresh.result.safe.json',
    renewClaim:FRESH.runtime+'/google-renew-once.claim.safe.json',renewResult:FRESH.runtime+'/google-renew-once.result.safe.json'});
const CODES=new Set(['REQUEST_INVALID','APPROVAL_REQUIRED','CODE_MISMATCH','PACKAGE_MANIFEST_INVALID','PACKAGE_PATHS_NOT_FRESH','HUMAN_EVIDENCE_INVALID','PROOF_INVALID','WINDOW_INVALID',
  'CANCELLED','DEADLINE_EXCEEDED','PREVIOUS_RECORDS_MISMATCH','PRIVATE_FILE_INVALID','FRESH_ALREADY_CLAIMED','CLAIM_OUTCOME_UNKNOWN','CLAIM_INVALID','GOOGLE_RENEWAL_STOPPED',
  'GOOGLE_RENEWAL_OUTCOME_UNKNOWN','RESULT_PERSISTENCE_UNCONFIRMED','INTERNAL_FAILED']);
class Closed extends Error{constructor(c){super(CODES.has(c)?c:'INTERNAL_FAILED');}}
const fail=c=>{throw new Closed(c);};
function admit(a,signal,clock=Date){
  if(signal?.aborted)fail('CANCELLED');const now=clock.now();
  if(a&&(!iso(a.validFromUtc)||!iso(a.validUntilUtc)||now<Date.parse(a.validFromUtc)||now>=Date.parse(a.validUntilUtc)))fail('WINDOW_INVALID');
}

function freshManifest(files,identity={head:null,tree:null}){
  if(!exact(files,CODE_FILES)||!Object.values(files).every(hex))fail('CODE_MISMATCH');
  return {spec:FRESH.spec,approved:false,stage:'initial-orders',operationId:FRESH.operationId,authorizationId:FRESH.authorizationId,
    requestIds:[FRESH.requestId,FRESH.unusedRequestId],unusedSecondRequestNeverExecutable:true,previousRecordsDigest:PREVIOUS_DIGEST,previousRecords:PREVIOUS_RECORDS,previousNames:PREVIOUS_NAMES,
    oldRemainingRegistrationMaximum:0,registrationBudget:{priorOutcome:'unknown',priorPossible:reuse?3:2,additionalMax:reuse?0:1,cumulativeMax:3},
    limits:{...LIMITS,registrations:reuse?0:1},
    ...(reuse?{registrationMode:'existing-client',existingClientEvidence:binding.existingClient}:{}),
    paths:{candidate:HERE,approval:APPROVAL_PATH,...PATHS},
    code:{executionHead:identity.head,executionTree:identity.tree,privateBindingSha256:PRIVATE_BINDING_SHA256,sourceHead:FIXED.head,sourceTree:FIXED.tree,image:FIXED.image,imageAdmission:'future-fresh-metadata-only-not-verified-this-preparation',files,dependencies:DEPENDENCIES,externalPins:EXTERNAL_PINS},
    profile:{requestedClientName:'XUAN Preopen Cloud Read-only v2',issuer:'https://api.ibkr.com',resource:'https://api.ibkr.com/v1/api/mcp-public',
      registrationEndpoint:'https://api.ibkr.com/oauth2/register',tokenEndpoint:'https://api.ibkr.com/oauth2/api/v1/token',scope:'mcp.read',
      redirectUri:FIXED.redirectUri,tokenEndpointAuthMethod:'none',grantTypes:['authorization_code','refresh_token'],responseTypes:['code'],
      bindHost:'127.0.0.1',bindPort:54868,bindFailure:'stop-no-alternate-port'},
    resources:{project:FIXED.project,region:FIXED.region,job:FIXED.job,serviceAccount:FIXED.sourceSa,bucket:FIXED.bucket,secret:FIXED.secret,operatorAccountSha256:FIXED.operatorAccountSha256},
    precedingVersion:'14',precedingVersionMetadataOnly:true,driftAction:'stop',
    googleSession:{normalRenewalMaximum:0,maximumSelectable:1,existingIdentityOnly:true,newLogin:false,newGrant:false,newScopes:false,unknownAction:'stop-no-retry'},
    risk:reuse?{acceptMacReplacement:true,restoreProduction:false}:{acceptUnknownPriorRegistration:true,acceptDuplicateClientRisk:true,acceptMacReplacement:true,restoreProduction:false},
    cost:{estimateUsd:0.2,reviewAmountUsd:1,estimateIsHardCap:false,reviewAmountIsHardCap:false,higherSpendingApproved:false},
    timing:{ownerAdmissionMs:600000,finalizationMs:40000,minimumRemainingMs:960000,automaticExtension:false,effectAdmission:'current-absolute-window-and-cancellation-before-each-new-effect',childDeadline:'same-approved-absolute-validUntil'},
    maintenance:{manualHoldScope:[...FIXED.consumerJobs,...FIXED.eodJobs,'xuan-preopen-cloud-producer.yml'],eodQuietScope:[...FIXED.eodJobs],
      proofSource:'owner',automaticResume:false,eodContextReads:0},
    validFromUtc:null,validUntilUtc:null,proofHashes:{manualHold:null,eodQuiet:null},
    finalApproval:{granted:false,scopeSha256:null,evidenceSha256:null},liveActionsApproved:false};
}
const scopeDigest=a=>{const{finalApproval,...scope}=a;return sha(canonical(scope));};
function validateFreshApproval(a,{now,files,identity}={}){
  if(!plain(a)||a.approved!==true||a.liveActionsApproved!==true)fail('APPROVAL_REQUIRED');
  const expected=freshManifest(files,identity);
  if(!identity||!hex40(identity.head)||!hex40(identity.tree))fail('CODE_MISMATCH');
  const normalized={...a,approved:false,liveActionsApproved:false,validFromUtc:null,validUntilUtc:null,proofHashes:expected.proofHashes,finalApproval:expected.finalApproval,
    googleSession:{...a.googleSession,normalRenewalMaximum:0}};
  if(canonical(normalized)!==canonical(expected))fail('CODE_MISMATCH');
  if(![0,1].includes(a.googleSession.normalRenewalMaximum))fail('APPROVAL_REQUIRED');
  if(!iso(a.validFromUtc)||!iso(a.validUntilUtc)||now<Date.parse(a.validFromUtc)||now>=Date.parse(a.validUntilUtc)
    ||Date.parse(a.validUntilUtc)-Date.parse(a.validFromUtc)>7200000)fail('WINDOW_INVALID');
  if(!exact(a.proofHashes,['manualHold','eodQuiet'])||!Object.values(a.proofHashes).every(hex)
    ||!exact(a.finalApproval,['granted','scopeSha256','evidenceSha256'])||a.finalApproval.granted!==true||!hex(a.finalApproval.evidenceSha256)
    ||!hex(a.finalApproval.scopeSha256)||scopeDigest(a)!==a.finalApproval.scopeSha256)fail('APPROVAL_REQUIRED');
  return structuredClone(a);
}
function validateHuman(a,raw,now){
  if(sha(raw)!==a.finalApproval.evidenceSha256)fail('HUMAN_EVIDENCE_INVALID');const h=safeJson(raw.toString());
  if(!exact(h,['spec','source','humanMessageId','confirmed','scopeSha256','authorizationId','operationId','validFromUtc','validUntilUtc','approvedAtUtc'])
    ||h.spec!==FRESH.spec||h.source!=='trusted-human-message'||h.confirmed!==true||h.scopeSha256!==a.finalApproval.scopeSha256
    ||h.authorizationId!==FRESH.authorizationId||h.operationId!==FRESH.operationId||h.validFromUtc!==a.validFromUtc||h.validUntilUtc!==a.validUntilUtc
    ||!iso(h.approvedAtUtc)||Date.parse(h.approvedAtUtc)>now
    ||typeof h.humanMessageId!=='string'||!/^[A-Za-z0-9_:-]{1,200}$/.test(h.humanMessageId))fail('HUMAN_EVIDENCE_INVALID');
  // Local supplementary evidence cannot replace the actual trusted human message
  // or the execution platform's approval review. Agents cannot grant this consent.
}
function validateProof(a,raw,kind){
  const key=kind==='manual-hold'?'manualHold':'eodQuiet';if(sha(raw)!==a.proofHashes[key])fail('PROOF_INVALID');const p=safeJson(raw.toString());
  if(!exact(p,['spec','kind','operationId','attestedBy','validFromUtc','validUntilUtc','confirmed','scope'])||p.spec!==FRESH.spec||p.kind!==kind
    ||p.operationId!==FRESH.operationId||p.attestedBy!=='owner'||p.confirmed!==true||p.validFromUtc!==a.validFromUtc||p.validUntilUtc!==a.validUntilUtc
    ||canonical(p.scope)!==canonical(kind==='manual-hold'?a.maintenance.manualHoldScope:a.maintenance.eodQuietScope))fail('PROOF_INVALID');
}
// Shared local-only package prefix. This helper never grants approval or claims.
async function verifyPackageSnapshot(io,{native=false}={}){
  const files={};for(const n of CODE_FILES)files[n]=sha(await io.read(HERE+'/'+n));
  const identity=await io.codeIdentity();
  for(const[n,h]of Object.entries(EXTERNAL_PINS)){const b=await io.read(n);if(sha(b)!==h)fail('CODE_MISMATCH');}
  if(!hex(files['renew.py']))fail('CODE_MISMATCH');
  if(process.versions.node!==DEPENDENCIES.node||native&&process.execPath!==DEPENDENCIES.nodeExecutable)fail('CODE_MISMATCH');
  for(const[n,h]of Object.entries(PREVIOUS_RECORDS))if(sha(await io.read(n))!==h)fail('PREVIOUS_RECORDS_MISMATCH');
  if(canonical(await io.previousNames())!==canonical(PREVIOUS_NAMES))fail('PREVIOUS_RECORDS_MISMATCH');
  let existingClient=null;
  if(reuse){
    try{
      const {path:filename,expected}=binding.existingClient;
      if(PREVIOUS_RECORDS[filename]!==expected.envelopeSha256)fail('CODE_MISMATCH');
      existingClient=verifyExistingClientEvidence(await io.read(filename),expected);
      if(existingClient.redirectUri!==FIXED.redirectUri)fail('CODE_MISMATCH');
    }catch{fail('PREVIOUS_RECORDS_MISMATCH');}
  }
  return {files,identity,existingClient};
}
async function verifyFresh(a,raw,io,now){
  const {files,identity,existingClient}=await verifyPackageSnapshot(io,{native:nativeIOs.has(io)});
  a=validateFreshApproval(a,{now,files,identity});
  const [human,hold,eod]=await Promise.all(['human-approval.safe.json','manual-hold.safe.json','eod-quiet.safe.json'].map(n=>io.read(APPROVAL_DIRECTORY+'/'+n)));
  validateHuman(a,human,now);validateProof(a,hold,'manual-hold');validateProof(a,eod,'independent-eod-quiet-no-context-read');
  const admitted={...a,approvalSha256:sha(raw),manualHold:{attested:true},eodQuiet:{attested:true}};
  if(reuse)reusedClients.set(admitted,existingClient);
  if(nativeIOs.has(io))nativeApprovals.add(admitted);return admitted;
}
async function privateDirectory(n){const s=await fs.lstat(n);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid()||(s.mode&0o777)!==0o700)fail('PRIVATE_FILE_INVALID');return s;}
// Fixed-path durable primitive. Tests may inject a filesystem that maps only this
// fresh runtime to a new temporary private directory; no path is selectable.
async function persistFreshClaim(a,{fs:io=fs,uid=process.getuid(),signal,clock=Date}={}){
  if(io===fs&&!nativeApprovals.has(a))fail('APPROVAL_REQUIRED');
  admit(a,signal,clock);
  const record=freshClaimRecord(a),raw=Buffer.from(JSON.stringify(record)+'\n');let handle,dir,created=false;
  try{
    admit(a,signal,clock);await io.mkdir(FRESH.runtime,{mode:0o700});created=true;admit(a,signal,clock);
    const d=await io.lstat(FRESH.runtime);if(!d.isDirectory()||d.isSymbolicLink()||d.uid!==uid||(d.mode&0o777)!==0o700)fail('PRIVATE_FILE_INVALID');
    admit(a,signal,clock);handle=await io.open(PATHS.claim,'wx',0o600);admit(a,signal,clock);const c=await handle.stat();
    if(!c.isFile()||c.nlink!==1||c.uid!==uid||(c.mode&0o777)!==0o600)fail('PRIVATE_FILE_INVALID');
    admit(a,signal,clock);await handle.writeFile(raw);await handle.sync();await handle.close();handle=null;
    dir=await io.open(FRESH.runtime,'r');await dir.sync();await dir.close();dir=null;
    const after=await io.lstat(FRESH.runtime),st=await io.lstat(PATHS.claim);
    if(after.ino!==d.ino||after.dev!==d.dev||st.ino!==c.ino||st.dev!==c.dev||!(await io.readFile(PATHS.claim)).equals(raw))fail('CLAIM_OUTCOME_UNKNOWN');
    return sha(raw);
  }catch(e){if(!created&&e?.code==='EEXIST')fail('FRESH_ALREADY_CLAIMED');fail('CLAIM_OUTCOME_UNKNOWN');}
  finally{for(const h of[handle,dir])if(h)try{await h.close();}catch{}}
}
function projectGoogleRenewal(r){
  if(r?.spec!=='IB-ORDERS-GOOGLE-SESSION-RENEW-ONCE-v1'||r.project!==FIXED.project||!['GOOGLE_SESSION_READY','GOOGLE_SESSION_RENEWAL_STOPPED'].includes(r.status)
    ||['newLogin','newGrant','newScopesRequested','claimModified','automaticRetry'].some(k=>r[k]!==false)||['ibOAuthCalls','financialCalls','cloudWrites'].some(k=>r[k]!==0))fail('GOOGLE_RENEWAL_OUTCOME_UNKNOWN');
  const x=r.renewal;if(!x||!['not-needed','confirmed','unknown','stopped'].includes(x.state)||![0,1].includes(x.requestReservations)||typeof x.responseReceived!=='boolean'
    ||!(x.httpStatus===null||Number.isInteger(x.httpStatus)&&x.httpStatus>=100&&x.httpStatus<=599)||!['not-needed','returned','unconfirmed'].includes(x.sdkCacheUpdate)
    ||typeof x.identityMatched!=='boolean'||typeof x.sdkRefreshInvoked!=='boolean')fail('GOOGLE_RENEWAL_OUTCOME_UNKNOWN');
  if(r.status==='GOOGLE_SESSION_READY'&&!(x.identityMatched&&(x.state==='confirmed'&&x.requestReservations===1&&x.responseReceived&&x.httpStatus===200&&x.sdkCacheUpdate==='returned'&&x.sdkRefreshInvoked
    ||x.state==='not-needed'&&x.requestReservations===0&&!x.sdkRefreshInvoked)))fail('GOOGLE_RENEWAL_OUTCOME_UNKNOWN');
  return {status:r.status,renewal:{state:x.state,requestReservations:x.requestReservations,responseReceived:x.responseReceived,httpStatus:x.httpStatus,
    sdkCacheUpdate:x.sdkCacheUpdate,identityMatched:x.identityMatched,sdkRefreshInvoked:x.sdkRefreshInvoked}};
}
async function nativeRenew(a,signal,{clock=Date}={}){
  if(!bindingFile)fail('APPROVAL_REQUIRED');assertNativeApproval(a);
  admit(a,signal,clock);if(a.googleSession.normalRenewalMaximum!==1)fail('APPROVAL_REQUIRED');await privateDirectory(FRESH.runtime);admit(a,signal,clock);
  await fs.writeFile(PATHS.renewClaim,JSON.stringify({spec:FRESH.spec,operationId:FRESH.operationId,approvalSha256:a.approvalSha256,normalRenewalMaximum:1,automaticRetry:false})+'\n',{flag:'wx',mode:0o600});
  admit(a,signal,clock);const {spawn}=await import('node:child_process');admit(a,signal,clock);
  const raw=await new Promise((resolve,reject)=>{let child,done=false,size=0,chunks=[];
    const end=(e,b)=>{if(done)return;done=true;if(e){child?.kill('SIGKILL');reject(new Closed('GOOGLE_RENEWAL_OUTCOME_UNKNOWN'));}else resolve(b);};
    admit(a,signal,clock);child=spawn(FIXED.python,['-I',HERE+'/renew.py','--approved-google-renew-once','--binding',bindingFile],{shell:false,cwd:'/private/tmp',
      env:{PATH:'/usr/bin:/bin:/usr/sbin:/sbin',CLOUDSDK_CONFIG:'/Users/huanwu/.config/gcloud',CLOUDSDK_CORE_PROJECT:FIXED.project,CLOUDSDK_CORE_LOG_HTTP:'false',CLOUDSDK_CORE_VERBOSITY:'none',
        CLOUDSDK_CORE_DISABLE_PROMPTS:'1',CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT:'',CLOUDSDK_CORE_UNIVERSE_DOMAIN:'googleapis.com',IB_ORDERS_APPROVED_UNTIL_MS:String(Date.parse(a.validUntilUtc))},stdio:['ignore','pipe','ignore'],timeout:20000,killSignal:'SIGKILL',signal});
    child.stdout.on('data',b=>{size+=b.length;if(size>65536)end(true);else chunks.push(b);});child.on('error',()=>end(true));child.on('close',c=>end(c!==0,Buffer.concat(chunks)));});
  let projected;try{projected=projectGoogleRenewal(safeJson(raw.toString()));}catch{fail('GOOGLE_RENEWAL_OUTCOME_UNKNOWN');}
  await fs.writeFile(PATHS.renewResult,JSON.stringify(projected)+'\n',{flag:'wx',mode:0o600});
  if(projected.status!=='GOOGLE_SESSION_READY')fail(projected.renewal.state==='unknown'?'GOOGLE_RENEWAL_OUTCOME_UNKNOWN':'GOOGLE_RENEWAL_STOPPED');return projected;
}
async function nativePackageReadIO(){
  if(!bindingFile)fail('APPROVAL_REQUIRED');
  const readAllowed=new Set([APPROVAL_PATH,...['human-approval.safe.json','manual-hold.safe.json','eod-quiet.safe.json'].map(n=>APPROVAL_DIRECTORY+'/'+n),
    ...CODE_FILES.map(n=>HERE+'/'+n),...Object.keys(PREVIOUS_RECORDS),...Object.keys(EXTERNAL_PINS)]);
  const io={async codeIdentity(){
      const {execFile}=await import('node:child_process');
      const run=args=>new Promise((resolve,reject)=>execFile('/usr/bin/git',['-c','core.fsmonitor=false',...args],{cwd:HERE,env:{PATH:'/usr/bin:/bin',GIT_OPTIONAL_LOCKS:'0'},encoding:'utf8',maxBuffer:2000000},(e,out)=>e?reject(Error('CODE_MISMATCH')):resolve(out.trim())));
      const root=await run(['rev-parse','--show-toplevel']);
      if(path.resolve(root,'maintenance/ib-orders-fresh-execution-v1')!==HERE||await run(['status','--porcelain','--untracked-files=all']))fail('CODE_MISMATCH');
      const head=await run(['rev-parse','--verify','HEAD']),tree=await run(['rev-parse','--verify','HEAD^{tree}']);
      for(const n of CODE_FILES){
        const relative='maintenance/ib-orders-fresh-execution-v1/'+n;
        const row=await run(['ls-tree','--full-tree','HEAD','--',relative]);if(!row.startsWith('100644 blob ')||!row.endsWith('\t'+relative))fail('CODE_MISMATCH');
        const committed=await new Promise((resolve,reject)=>execFile('/usr/bin/git',['-c','core.fsmonitor=false','show','HEAD:'+relative],{cwd:HERE,env:{PATH:'/usr/bin:/bin',GIT_OPTIONAL_LOCKS:'0'},encoding:'buffer',maxBuffer:2000000},(e,out)=>e?reject(Error('CODE_MISMATCH')):resolve(out)));
        if(sha(committed)!==sha(await fs.readFile(HERE+'/'+n)))fail('CODE_MISMATCH');
      }
      return {head,tree};
    },async read(n){if(!readAllowed.has(n))fail('PRIVATE_FILE_INVALID');const s=await fs.lstat(n),d=await fs.lstat(path.dirname(n));
      if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.uid!==process.getuid()||s.size>([DEPENDENCIES.nodeExecutable,FIXED.python].includes(n)?150000000:200000)||!([DEPENDENCIES.nodeExecutable,FIXED.python].includes(n)?[0o755]:[0o400,0o600,0o644]).includes(s.mode&0o777)
        ||!d.isDirectory()||d.isSymbolicLink()||d.uid!==process.getuid())fail('PRIVATE_FILE_INVALID');
      if(CODE_FILES.some(file=>n===HERE+'/'+file)){if(![0o500,0o700,0o755].includes(d.mode&0o777))fail('PRIVATE_FILE_INVALID');}
      else if(![DEPENDENCIES.nodeExecutable,FIXED.python].includes(n)&&!n.startsWith(FIXED.sdkRoot+'/')&&((s.mode&0o777)===0o644||![0o500,0o700].includes(d.mode&0o777)))fail('PRIVATE_FILE_INVALID');return fs.readFile(n);},
    async previousNames(){const names={};for(const n of Object.keys(PREVIOUS_NAMES))names[n]=(await fs.readdir(n)).sort();return names;}};
  return Object.freeze(io);
}
async function nativeFreshIO(){
  const packageIO=await nativePackageReadIO();
  let claimState='not-started',claimHash=null,seq=0;
  const write=async(n,value)=>{await privateDirectory(FRESH.runtime);await fs.writeFile(n,JSON.stringify(value)+'\n',{flag:'wx',mode:0o600});};
  const io={...packageIO,
    async reserve(a,options={}){if(!nativeApprovals.has(a))fail('APPROVAL_REQUIRED');admit(a,options.signal,options.clock??Date);claimState='attempted-outcome-unknown';try{claimHash=await persistFreshClaim(a,options);claimState='confirmed';}catch(e){if(e.message==='FRESH_ALREADY_CLAIMED')claimState='already-claimed';throw e;}},
    async verifyClaim(a){nativeClaims.delete(a);if(!nativeApprovals.has(a))fail('APPROVAL_REQUIRED');await privateDirectory(FRESH.runtime);const st=await fs.lstat(PATHS.claim);
      if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.uid!==process.getuid()||(st.mode&0o777)!==0o600||st.size>65536)fail('CLAIM_INVALID');
      const h=await fs.open(PATHS.claim,'r');let b;try{const opened=await h.stat();if(opened.ino!==st.ino||opened.dev!==st.dev)fail('CLAIM_INVALID');b=await h.readFile();}finally{await h.close();}
      if(sha(b)!==claimHash||canonical(safeJson(b.toString()))!==canonical(freshClaimRecord(a)))fail('CLAIM_INVALID');nativeClaims.add(a);},
    renew:nativeRenew,openCaps:(a,signal)=>nativeAdapters(a,signal),
    audit:state=>write(FRESH.runtime+'/fresh.'+String(seq++).padStart(4,'0')+'.safe.json',{spec:FRESH.spec,...state}),
    finish:(a,result)=>write(PATHS.result,{spec:FRESH.spec,operationId:FRESH.operationId,authorizationId:FRESH.authorizationId,approvalSha256:a.approvalSha256,claimSha256:claimHash,
      previousRecordsDigest:PREVIOUS_DIGEST,oldRemainingRegistrationMaximum:0,maximumCumulativePossibleRegistrations:3,result}),claimState:()=>claimState};
  Object.freeze(io);nativeIOs.add(io);return io;
}
function boundOfflinePlan(){return {spec:FRESH.spec,status:'offline',liveActions:0,liveApproved:false,operationId:FRESH.operationId,authorizationId:FRESH.authorizationId,
  currentOldRemainingRegistrationMaximum:0,newRegistrationAuthorization:false,priorPossibleRegistrations:reuse?3:2,futureAdditionalMaximum:reuse?0:1,futureCumulativeMaximum:3,
  manifest:HERE+'/fresh-execution.NOT-APPROVED.json',validFromUtc:null,validUntilUtc:null,automaticRetry:false,automaticMaintenanceResume:false};}
async function boundVerifyPackage(manifestPath,manifestSha256){
  try{
    if(path.dirname(fileURLToPath(import.meta.url))!==HERE||FIXED.source!==HERE+'/source'
      ||!path.isAbsolute(APPROVAL_DIRECTORY)||!path.isAbsolute(FRESH.runtime)||APPROVAL_DIRECTORY===FRESH.runtime
      ||APPROVAL_PATH!==APPROVAL_DIRECTORY+'/fresh.approval.json')fail('CODE_MISMATCH');
    if(!bindingFile||manifestPath!==path.join(path.dirname(bindingFile),'execution-manifest.NOT-APPROVED.json')||!hex(manifestSha256))fail('REQUEST_INVALID');
    const raw=await readPrivateControlBytes(manifestPath);if(sha(raw)!==manifestSha256)fail('PACKAGE_MANIFEST_INVALID');
    const supplied=safeJson(raw.toString()),io=await nativePackageReadIO();
    // Force actual native dependency identity even though this read-only IO is
    // deliberately never admitted to the native approval/claim WeakSets.
    const {files,identity}=await verifyPackageSnapshot(io,{native:true});
    if(canonical(supplied)!==canonical(freshManifest(files,identity)))fail('PACKAGE_MANIFEST_INVALID');
    for(const[name,pattern]of [['binding.mjs',/^export const PRIVATE_BINDING_SHA256='([a-f0-9]{64})';$/gm],['renew.py',/^PRIVATE_BINDING_SHA256='([a-f0-9]{64})'$/gm]]){
      const matches=[...(await io.read(HERE+'/'+name)).toString().matchAll(pattern)];
      if(matches.length!==1||matches[0][1]!==PRIVATE_BINDING_SHA256)fail('CODE_MISMATCH');
    }
    // Absence is preparation-only: never add this to the execution prefix,
    // which must recheck the source after the real durable claim exists.
    for(const n of [APPROVAL_DIRECTORY,FRESH.runtime]){
      try{await fs.lstat(n);fail('PACKAGE_PATHS_NOT_FRESH');}catch(e){if(e?.code!=='ENOENT')fail('PACKAGE_PATHS_NOT_FRESH');}
    }
    return {spec:'IB-ORDERS-FRESH-PACKAGE-VERIFICATION-v1',status:'verified-package',readOnly:true,liveActions:0,
      executionAuthorization:false,humanProofVerified:false,claimVerified:false,liveAdmissionVerified:false,signatureVerified:false,
      code:{head:identity.head,tree:identity.tree,files,privateBindingSha256:PRIVATE_BINDING_SHA256},manifestSha256,
      checked:{runtimeFiles:CODE_FILES.length,externalPins:Object.keys(EXTERNAL_PINS).length,historicalRecords:Object.keys(PREVIOUS_RECORDS).length,
        historicalDirectories:Object.keys(PREVIOUS_NAMES).length,nativeNodeIdentity:true,dualBindingPins:true,approvalDirectoryAbsent:true,runtimeAbsent:true},
      validFromUtc:null,validUntilUtc:null,automaticRetry:false};
  }catch(e){return {status:'stopped',code:CODES.has(e?.message)?e.message:'PRIVATE_FILE_INVALID',readOnly:true,liveActions:0,automaticRetry:false};}
}
async function boundFreshCli(args=[],{io,clock=Date}={}){
  if(args.length===0||canonical(args)===canonical(['--plan']))return boundOfflinePlan();
  if(args.length!==5||args[0]!=='--execute'||args[1]!=='--approval'||args[2]!==APPROVAL_PATH||args[3]!=='--approval-sha256'||!hex(args[4]))return {status:'stopped',code:'REQUEST_INVALID',liveActions:0};
  let a,caps,result,claimed=false,timer,googleSession=null;const abort=new AbortController(),cancel=()=>abort.abort();
  process.once('SIGINT',cancel);process.once('SIGTERM',cancel);
  const check=()=>admit(a,abort.signal,clock);
  const checkInitial=()=>{check();if(a&&Date.parse(a.validUntilUtc)-clock.now()<960000)fail('WINDOW_INVALID');};
  try{
    if(path.dirname(fileURLToPath(import.meta.url))!==HERE||['NODE_OPTIONS','NODE_PATH','NODE_EXTRA_CA_CERTS','NODE_TLS_REJECT_UNAUTHORIZED'].some(k=>process.env?.[k]))fail('APPROVAL_REQUIRED');
    io??=await nativeFreshIO();check();let raw;try{raw=await io.read(APPROVAL_PATH);}catch(e){if(e?.code==='ENOENT')fail('APPROVAL_REQUIRED');throw e;}
    if(sha(raw)!==args[4])fail('APPROVAL_REQUIRED');const supplied=safeJson(raw.toString());
    a=await verifyFresh(supplied,raw,io,clock.now());check();
    if(Date.parse(a.validUntilUtc)-clock.now()<960000)fail('WINDOW_INVALID');
    timer=setTimeout(()=>abort.abort(),Math.max(1,Date.parse(a.validUntilUtc)-clock.now()));
    // The exclusive operation claim precedes any possible Google renewal or IB
    // activity, so concurrent contenders cannot each consume a renewal budget.
    checkInitial();await io.reserve(a,{signal:abort.signal,clock});claimed=true;check();await io.verifyClaim(a);checkInitial();
    if(a.googleSession.normalRenewalMaximum===1){check();googleSession=await io.renew(a,abort.signal,{clock});checkInitial();}
    await verifyFresh(supplied,raw,io,clock.now());check();await io.verifyClaim(a);checkInitial();
    caps=await io.openCaps(a,abort.signal);checkInitial();
    result=await runStagedOperation(a,caps,{clock,signal:abort.signal,reserve:async()=>{
      checkInitial();await verifyFresh(supplied,raw,io,clock.now());check();await io.verifyClaim(a);checkInitial();},audit:state=>io.audit(state)});
    if(result.status==='initial-orders-passed-refresh-pending')result={...result,status:'passed',code:'FRESH_INITIAL_ORDERS_PASSED',refreshContinuationAuthorized:false};
    result={spec:FRESH.spec,...result,operationId:FRESH.operationId,authorizationId:FRESH.authorizationId,approvalSha256:a.approvalSha256,
      previousRecordsDigest:PREVIOUS_DIGEST,oldRemainingRegistrationMaximum:0,maximumCumulativePossibleRegistrations:3,googleSession,automaticRetry:false,automaticMaintenanceResume:false};
    await boundedSafeSink(()=>io.finish(a,result));return result;
  }catch(e){const allowed=new Set([...CODES,'READINESS_FAILED','IDENTITY_INVALID','CONTROL_IDENTITY_FAILED','CONTROL_MAINTENANCE_FAILED','MAINTENANCE_UNCONFIRMED','JOB_CONFIG_INVALID']);
    const stopped={spec:FRESH.spec,...(result??{}),status:'stopped',code:result?'RESULT_PERSISTENCE_UNCONFIRMED':allowed.has(e?.message)?e.message:'INTERNAL_FAILED',
      claimState:io?.claimState?.()??'not-started',oldRemainingRegistrationMaximum:0,maximumCumulativePossibleRegistrations:3,
      controlDiagnostic:safeControlDiagnostic(e?.controlDiagnostic),maintenanceRequired:true,automaticRetry:false,automaticMaintenanceResume:false};
    if(claimed&&!result)try{await boundedSafeSink(()=>io.finish(a,stopped));}catch{}return stopped;
  }finally{clearTimeout(timer);process.removeListener('SIGINT',cancel);process.removeListener('SIGTERM',cancel);abort.abort();if(caps)try{await caps.close();}catch{}}
}

const nativeFail=code=>{throw new SafeFailure(code);};
const CONTROL_OPS=new Set(['startup','identity','maintenance','run','operation','execution','receipt']);
async function subprocess(executable,args,{signal,limit=65536,timeout=4500,env,approval,beforeSpawn=()=>{}}={}){
  assertNativeApproval(approval);
  const {spawn}=await import('node:child_process');beforeSpawn();
  return new Promise((resolve,reject)=>{let child,settled=false,bytes=0,parts=[],timer;
    const done=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);if(error){child?.kill('SIGKILL');reject(new SafeFailure('MAINTENANCE_UNCONFIRMED'));}else resolve(value);};
    const abort=()=>done(true);if(signal?.aborted){abort();return;}
    beforeSpawn();child=spawn(executable,args,{shell:false,cwd:'/private/tmp',env,stdio:['ignore','pipe','ignore']});timer=setTimeout(abort,timeout);signal?.addEventListener('abort',abort,{once:true});
    child.on('error',abort);child.stdout.on('data',b=>{bytes+=b.length;if(bytes>limit)abort();else parts.push(b);});child.on('close',c=>c===0?done(false,Buffer.concat(parts).toString('utf8')):done(true));
  });
}
function createRpc({spawn,approval,signal}){
  assertNativeApproval(approval);
  executionAdmission(approval,signal);
  // Native startup is explicit and outside imports/tests. No SDK token crosses this pipe.
  const env={PATH:'/usr/bin:/bin:/usr/sbin:/sbin',CLOUDSDK_CONFIG:'/Users/huanwu/.config/gcloud',CLOUDSDK_CORE_PROJECT:FIXED.project,
    CLOUDSDK_CORE_LOG_HTTP:'false',CLOUDSDK_CORE_VERBOSITY:'none',CLOUDSDK_CORE_DISABLE_PROMPTS:'1',CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT:'',CLOUDSDK_CORE_UNIVERSE_DOMAIN:'googleapis.com'};
  const child=spawn(FIXED.python,['-I','-c',CONTROL_BRIDGE],{shell:false,cwd:'/private/tmp',env,stdio:['pipe','pipe','ignore']});
  let pending=null,buffer=Buffer.alloc(0),closed=false,broken=false;
  const localDiagnostic=(op,category)=>({spec:'IB-ORDERS-CONTROL-DIAGNOSTIC-v1',stage:'rpc',operation:CONTROL_OPS.has(op)?op:'startup',resource:'none',category,exceptionType:'none',origin:'createRpc',line:null,httpStatus:null});
  const failure=(op,diagnostic)=>{
    const e=new SafeFailure(op==='identity'?'CONTROL_IDENTITY_FAILED':op==='maintenance'?'CONTROL_MAINTENANCE_FAILED':'RUN_OUTCOME_UNKNOWN');
    e.controlDiagnostic=safeControlDiagnostic(diagnostic,op)??localDiagnostic(op,'RPC_FRAME_INVALID');return e;
  };
  const stop=(reason='RPC_CHILD_CLOSED')=>{broken=true;child.kill('SIGKILL');if(pending){const p=pending;pending=null;clearTimeout(p.timer);p.reject(failure(p.op,localDiagnostic(p.op,reason)));}};
  child.on('error',()=>stop('RPC_CHILD_ERROR'));child.on('close',()=>{closed=true;stop();});child.stdin.on('error',()=>stop('RPC_CHILD_ERROR'));
  child.stdout.on('data',b=>{
    buffer=Buffer.concat([buffer,b]);if(buffer.length>131072){stop('RPC_FRAME_TOO_LARGE');return;}
    let end;while((end=buffer.indexOf(10))>=0){const line=buffer.subarray(0,end);buffer=buffer.subarray(end+1);
      if(!pending){stop('RPC_UNEXPECTED_FRAME');return;}const p=pending;pending=null;clearTimeout(p.timer);
      try{const r=safeJson(line.toString('utf8'));
        if(r.ok===true)p.resolve(r.value);
        else{const diagnostic=r.code==='CONTROL_FAILED'?safeControlDiagnostic(r.diagnostic,p.op):null;p.reject(failure(p.op,diagnostic));}
      }catch{p.reject(failure(p.op,localDiagnostic(p.op,'RPC_FRAME_INVALID')));}
    }
  });
  child.stdin.write(JSON.stringify({requestIds:approval.stage==='natural-refresh'?[...approval.requestIds].reverse():approval.requestIds,...(approval.stage?{cachedOnly:true}:{}),...(approval.spec===FRESH.spec?{deadlineMs:Date.parse(approval.validUntilUtc)}:{})})+'\n');
  const rpc=(op,params={},timeout=4500)=>{
    if(broken||closed||pending||signal?.aborted)return Promise.reject(failure(op,localDiagnostic(op,'RPC_CHILD_CLOSED')));
    try{executionAdmission(approval,signal);}catch(e){return Promise.reject(e);}
    return new Promise((resolve,reject)=>{const timer=setTimeout(()=>stop('RPC_TIMEOUT'),timeout);pending={resolve,reject,timer,op};child.stdin.write(JSON.stringify({op,...params})+'\n');});
  };
  const abort=()=>stop('RPC_CHILD_CLOSED');signal?.addEventListener('abort',abort,{once:true});
  return {rpc,close:async()=>{signal?.removeEventListener('abort',abort);stop();child.stdin.destroy();}};
}
async function githubProof(signal,a){
  assertNativeApproval(a);
  const base='repos/huanwujoy-crypto/fee-console',env={PATH:'/usr/bin:/bin',HOME:'/Users/huanwu',GH_HOST:'github.com',GH_PROMPT_DISABLED:'1',GH_DEBUG:''};
  const get=async endpoint=>safeJson(await subprocess(FIXED.gh,['api','--hostname','github.com',endpoint],{signal,env,approval:a,beforeSpawn:()=>executionAdmission(a,signal)}));
  const [workflow,mode,...runs]=await Promise.all([
    get(base+'/actions/workflows/xuan-preopen-cloud-producer.yml'),get(base+'/actions/variables/XUAN_PREOPEN_CLOUD_MODE'),
    ...['queued','in_progress','waiting','pending','requested'].map(s=>get(base+'/actions/workflows/xuan-preopen-cloud-producer.yml/runs?status='+s+'&per_page=1'))]);
  if(runs.some(r=>!Number.isSafeInteger(r.total_count)||r.total_count<0))nativeFail('MAINTENANCE_UNCONFIRMED');
  return {complete:true,observedAtUtc:new Date().toISOString(),workflowState:workflow.state,mode:mode.value,unfinished:runs.reduce((n,r)=>n+r.total_count,0)};
}
function createCachedSdkProcessBridge(core,{approval,beforeSpawn=()=>{},validUntilUtc=null}={}){
  assertNativeApproval(approval);
  const operatorAccountSha256=FIXED.operatorAccountSha256;
  if(!hex(operatorAccountSha256))nativeFail('APPROVAL_REQUIRED');
  return async request=>{
    beforeSpawn();
    if(request?.executable!==FIXED.python||JSON.stringify(request.args)!==JSON.stringify(['-I','-c',core.SDK_BRIDGE_CODE])
      ||typeof request.operatorAccount!=='string'||sha(request.operatorAccount)!==operatorAccountSha256||!Buffer.isBuffer(request.stdin)
      ||request.stdin.length>65536||request.discardStderr!==true||request.stdoutLimit!==8192||request.timeoutMs!==20000)nativeFail('APPROVAL_REQUIRED');
    const shim=`ns={'__name__':'cached_only_writer'}\nexec(compile(${JSON.stringify(core.SDK_BRIDGE_CODE)},'reviewed-sdk-writer','exec'),ns)\noriginal=ns['live_identity']\nclass CachedOnly:\n    def __init__(self,c): self.c=c\n    def before_request(self,request,method,url,headers):\n        if self.c.valid is not True: raise ns['BridgeFailure']()\n        self.c.apply(headers)\ndef identity():\n    account,c=original()\n    if c.valid is not True: raise ns['BridgeFailure']()\n    return account,CachedOnly(c)\nns['live_identity']=identity\n${validUntilUtc===null?'':`import time\nDEADLINE_MS=${Date.parse(validUntilUtc)}\ndef admit():\n    if time.time()*1000>=DEADLINE_MS: raise ns['BridgeFailure']()\ndef admitted_identity():\n    admit()\n    import sys,hashlib\n    sys.path[:0]=[ns['SDK_ROOT']+'/lib',ns['SDK_ROOT']+'/lib/third_party']\n    from googlecloudsdk.core import properties\n    from googlecloudsdk.core.credentials import creds\n    from google.oauth2.credentials import Credentials\n    admit();account=properties.VALUES.core.account.Get();admit()\n    if not isinstance(account,str) or hashlib.sha256(account.encode()).hexdigest()!=ns['OPERATOR_HASH']:raise ns['BridgeFailure']()\n    store=creds.GetCredentialStore();admit();credential=store.Load(account);admit()\n    if not isinstance(credential,Credentials) or credential.valid is not True:raise ns['BridgeFailure']()\n    return account,CachedOnly(credential)\nns['live_identity']=admitted_identity\noriginal_submit=ns['submit']\ndef submit(credential,identity_loader,session_factory,adapter_factory,request_factory,operator_hash=ns['OPERATOR_HASH']):\n    admit()\n    def session():\n        admit()\n        result=session_factory()\n        post=result.post\n        def admitted_post(*args,**kwargs):\n            admit()\n            return post(*args,**kwargs)\n        result.post=admitted_post\n        return result\n    return original_submit(credential,identity_loader,session,adapter_factory,request_factory,operator_hash)\nns['submit']=submit\nadmit()\n`}raise SystemExit(ns['main']())\n`;
    assertNativeApproval(approval);
    const spawn=(await import('node:child_process')).spawn;
    const env={PATH:'/usr/bin:/bin:/usr/sbin:/sbin',CLOUDSDK_CONFIG:'/Users/huanwu/.config/gcloud',CLOUDSDK_CORE_PROJECT:FIXED.project,
      CLOUDSDK_CORE_ACCOUNT:request.operatorAccount,CLOUDSDK_CORE_LOG_HTTP:'false',CLOUDSDK_CORE_VERBOSITY:'none',CLOUDSDK_CORE_DISABLE_PROMPTS:'1',CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT:'',CLOUDSDK_CORE_UNIVERSE_DOMAIN:'googleapis.com'};
    return new Promise((resolve,reject)=>{
      let child,timer,done=false,size=0,chunks=[];
      const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);request.signal?.removeEventListener('abort',abort);if(error){child?.kill('SIGKILL');reject(new SafeFailure('BOOTSTRAP_OUTCOME_UNKNOWN'));}else resolve(value);};
      const abort=()=>finish(true);if(request.signal?.aborted){abort();return;}
      beforeSpawn();
      child=spawn(FIXED.python,['-I','-c',shim],{shell:false,cwd:'/private/tmp',env,stdio:['pipe','pipe','ignore']});
      timer=setTimeout(abort,20000);request.signal?.addEventListener('abort',abort,{once:true});
      child.on('error',abort);child.stdin.on('error',abort);child.stdout.on('data',b=>{size+=b.length;if(size>8192)abort();else chunks.push(b);});
      child.on('close',code=>finish(false,{exitCode:code,stdout:Buffer.concat(chunks).toString('utf8')}));child.stdin.end(request.stdin);
    });
  };
}
async function nativeAdapters(a,signal){
  assertPrivateBinding(binding);assertNativeApproval(a);executionAdmission(a,signal);
  const {spawn}=await import('node:child_process');executionAdmission(a,signal);
  const core=await import(pathToFileURL(path.join(FIXED.source,'scripts/xuan-ib-cloud-oauth-bootstrap.mjs')).href);
  executionAdmission(a,signal);const bridge=createRpc({spawn,approval:a,signal});
  try{
    const identity=await bridge.rpc('identity',{},15000),operatorAccount=identity?.operatorAccount;executionAdmission(a,signal);
    if(typeof operatorAccount!=='string'||sha(operatorAccount)!==FIXED.operatorAccountSha256)nativeFail('IDENTITY_INVALID');
    if(a.stage&&(!Number.isSafeInteger(identity.cachedGoogleValidUntilMs)||identity.cachedGoogleValidUntilMs-Date.now()<(a.stage==='initial-orders'?1200000:600000)))nativeFail('READINESS_FAILED');
    const checkMaintenance=async expected=>{
      executionAdmission(a,signal);const local=new AbortController(),timer=setTimeout(()=>local.abort(),4400);
      try{
        const [g,gh]=await Promise.race([Promise.all([bridge.rpc('maintenance'),githubProof(AbortSignal.any([signal,local.signal]),a)]),
          new Promise((_,reject)=>local.signal.addEventListener('abort',()=>reject(new SafeFailure('MAINTENANCE_UNCONFIRMED')),{once:true}))]);
        return (a.stage?validateStageMaintenance:validateMaintenance)(g,gh,a,expected,Date.now());
      }finally{clearTimeout(timer);}
    };
    executionAdmission(a,signal);const writer=core.createSdkWriter({operatorAccount,runProcess:createCachedSdkProcessBridge(core,{approval:a,beforeSpawn:()=>executionAdmission(a,signal),validUntilUtc:a.validUntilUtc})});
    let stageRuns=0;
    return {checkMaintenance,async bootstrap({onSaved,onDiagnostic,onBeforeRegistration}){
      executionAdmission(a,signal);if(a.stage==='natural-refresh')nativeFail('APPROVAL_REQUIRED');
      let app,reserved=false;
      // The actual transport rejects DCR before reserving or issuing a request.
      const observed=createObservedOAuthFetch(globalThis.fetch,{registrationAllowed:!reuse,onEvent:async transport=>{
        if(a.stage&&!reserved&&transport.registration.requestReservations===1){if(typeof onBeforeRegistration!=='function')nativeFail('APPROVAL_REQUIRED');await onBeforeRegistration();reserved=true;}
        await onDiagnostic({result:app?.snapshot(),transport});},beforeFetch:endpoint=>{executionAdmission(a,signal);if(a.spec===FRESH.spec&&endpoint==='https://api.ibkr.com/oauth2/register'&&Date.parse(a.validUntilUtc)-Date.now()<960000)nativeFail('WINDOW_OUTSIDE_APPROVAL');}});
      if(reuse&&!reusedClients.has(a))nativeFail('APPROVAL_REQUIRED');
      app=core.createBootstrap({existingClient:reuse?reusedClients.get(a):null,
        admission:()=>executionAdmission(a,signal),registrationContext:{attemptId:crypto.randomUUID(),operationId:a.operationId,approvalSha256:a.approvalSha256},
        onRegistrationAudit:async(registrationAudit,{signal:auditSignal})=>{
          // The legacy consumption entry has no approved phase1 claim and remains closed.
          if(a.stage!=='initial-orders'||!reserved||registrationAudit.codeSha256!==SOURCE_HASHES['scripts/xuan-ib-cloud-oauth-bootstrap.mjs']
            ||registrationAudit.redirectUri!==FIXED.redirectUri)nativeFail('APPROVAL_REQUIRED');
          const expectedClaim=freshClaimRecord(a);
          const ack=await persistRegistrationAudit(registrationAudit,{fs,claimPath:FRESH.runtime+'/fresh.claim.safe.json',
            auditPath:FRESH.runtime+'/fresh.registration-audit.safe.json',expectedClaim,parse:safeJson,uid:process.getuid(),signal:auditSignal});
          await onDiagnostic({result:app.snapshot(),transport:observed.snapshot()});
          await observed.confirmDiagnostics({signal:auditSignal});return ack;
        },approval:{spec:core.BOOTSTRAP_SPEC,codeSha256:SOURCE_HASHES['scripts/xuan-ib-cloud-oauth-bootstrap.mjs'],redirectUri:a.stage?FIXED.redirectUri:a.redirectUri,
        operatorAccount,precedingVersion:a.precedingVersion,approved:true,acceptMacReplacement:a.stage?a.risk.acceptMacReplacement:a.acceptMacReplacement},
        fetchImpl:observed.fetch,listener:createNodeLoopbackAdapter(core,a),browser:createExternalBrowserAdapter(core,a),
        maintenance:{check:({expectedVersion})=>checkMaintenance(expectedVersion)},
        store:{async save(credential,options){const meta={clientId:credential.client_id,expiresAt:credential.expires_at};
          executionAdmission(a,signal);if(options?.signal?.aborted)nativeFail('CANCELLED');const ack=await writer.save(credential,options);onSaved({...meta,versionName:ack.name});return ack;}}});
      return {start:app.start,finished:app.finished,cancel:app.cancel,snapshot:app.snapshot,networkStatus:observed.snapshot};
    },
    async wait(ms,s){await new Promise((resolve,reject)=>{const timer=setTimeout(done,ms);function done(){s.removeEventListener('abort',abort);resolve();}
      function abort(){clearTimeout(timer);s.removeEventListener('abort',abort);reject(new SafeFailure('CANCELLED'));}if(s.aborted)abort();else s.addEventListener('abort',abort,{once:true});});},
    async probe(request,{deadline}){
      executionAdmission(a,signal);if(a.stage&&stageRuns++!==0)nativeFail('RUN_OUTCOME_UNKNOWN');
      const ack=await bridge.rpc('run',{request},15000);let execution;
      while(Date.now()<deadline){
        signal.throwIfAborted();const operation=await bridge.rpc('operation',{operation:ack.operation});execution=operation.execution;
        if(execution){const e=await bridge.rpc('execution',{execution});
          if(e.completionTime){if(e.failedCount||e.cancelledCount||e.succeededCount!==1||e.runningCount)nativeFail('EXECUTION_FAILED');
            return {execution,receipt:await bridge.rpc('receipt',{execution})};}}
        await this.wait(1000,signal);
      }
      nativeFail('RUN_OUTCOME_UNKNOWN');
    },close:bridge.close};
  }catch(error){await bridge.close();throw error;}
}

function createNodeLoopbackAdapter(core,a){
  assertNativeApproval(a);
  const fail=code=>{throw core.bootstrapFailure(code);},SafeError=core.bootstrapFailure('BOOTSTRAP_INTERNAL_FAILED').constructor;
  return {async bind({host,port,signal,admission=()=>{}}){
    const check=()=>{assertNativeApproval(a);executionAdmission(a,signal);if(signal?.aborted)fail('BOOTSTRAP_CANCELLED');admission();};check();
    if(host!=='127.0.0.1'||!Number.isInteger(port)||port<0||port>65535)fail('BOOTSTRAP_LISTENER_BINDING_INVALID');
    const {createServer}=await import('node:http');check();let handler=null;
    const server=createServer(async(req,res)=>{
      let response;try{
        const hosts=req.rawHeaders.filter((_,i)=>i%2===0&&req.rawHeaders[i].toLowerCase()==='host').length;
        response=handler?await handler({method:req.method,host:req.headers.host,hostCount:hosts,rawUrl:req.url,cookie:req.headers.cookie}):{statusCode:404,body:'Not active.'};
      }catch{response={statusCode:400,body:'Authorization stopped.'};}
      if(!res.destroyed){res.writeHead(response.statusCode,{'content-type':'text/plain; charset=utf-8','cache-control':'no-store','referrer-policy':'no-referrer',
        'x-content-type-options':'nosniff','connection':'close',...(response.headers||{})});res.end(response.body);}
    });
    server.requestTimeout=5000;server.headersTimeout=5000;server.maxHeadersCount=32;
    let onAbort;
    try{await new Promise((resolve,reject)=>{onAbort=()=>reject(new SafeError('BOOTSTRAP_CANCELLED'));signal?.addEventListener('abort',onAbort,{once:true});
      server.once('error',()=>reject(new SafeError('BOOTSTRAP_LISTENER_BINDING_INVALID')));check();server.listen({host,port,exclusive:true},resolve);});check();}
    catch(error){server.close();server.closeIdleConnections();if(error instanceof SafeError)throw error;fail('BOOTSTRAP_LISTENER_BINDING_INVALID');}
    finally{signal?.removeEventListener('abort',onAbort);}
    const address=server.address();if(!address||typeof address==='string'||address.address!=='127.0.0.1'){server.close();fail('BOOTSTRAP_LISTENER_BINDING_INVALID');}
    return {host:address.address,port:address.port,setHandler(fn){handler=fn;},async close(){handler=null;server.close();server.closeIdleConnections();}};
  }};
}
function createExternalBrowserAdapter(core,a){
  assertNativeApproval(a);
  const {BOOTSTRAP,validateLoopbackUri}=core;
  const fail=code=>{throw core.bootstrapFailure(code);},SafeError=core.bootstrapFailure('BOOTSTRAP_INTERNAL_FAILED').constructor;
  return {async open(startUri,{signal,admission=()=>{}}={}){
    const check=()=>{assertNativeApproval(a);executionAdmission(a,signal);if(signal?.aborted)fail('BOOTSTRAP_CANCELLED');admission();};check();
    let u;try{u=new URL(startUri);}catch{fail('BOOTSTRAP_REQUEST_INVALID');}validateLoopbackUri(u.origin+BOOTSTRAP.callbackPath);
    if(u.pathname!==BOOTSTRAP.startPath||u.search||u.hash||u.username||u.password)fail('BOOTSTRAP_REQUEST_INVALID');
    // The argument has no state, code, cookie, verifier or authorization query.
    const {spawn}=await import('node:child_process');check();
    try{await new Promise((resolve,reject)=>{let child,done=false,timer;
      const stop=error=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);
        if(error){child?.kill('SIGKILL');reject(new SafeError('BOOTSTRAP_INTERNAL_FAILED'));}else resolve();};
      const abort=()=>stop(true);check();child=spawn('/usr/bin/open',[startUri],{shell:false,stdio:'ignore'});
      timer=setTimeout(abort,15000);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted){abort();return;}
      child.once('error',()=>stop(true));child.once('exit',code=>stop(code!==0));});}
    catch{fail('BOOTSTRAP_INTERNAL_FAILED');}
  }};
}

  return {FRESH,FIXED,PATHS,HERE,APPROVAL_PATH,APPROVAL_DIRECTORY,PREVIOUS_DIGEST,DEPENDENCIES,EXTERNAL_PINS,PREVIOUS_RECORDS,PREVIOUS_NAMES,
    freshManifest,validateFreshApproval,validateHuman,verifyFresh,persistFreshClaim,projectGoogleRenewal,nativeFreshIO,freshCli:boundFreshCli,verifyPackage:boundVerifyPackage,offlinePlan:boundOfflinePlan};
}
// Pure data only: this helper exposes no native IO, approval mint or executor.
export function buildOfflineManifest(binding,files,identity){return createFreshExecution(binding).freshManifest(files,identity);}
export function offlinePlan(){return {spec:'IB-ORDERS-FRESH-EXECUTION-v1',status:'offline',liveActions:0,liveApproved:false,
  registrationMode:'existing-client',currentOldRemainingRegistrationMaximum:0,newRegistrationAuthorization:false,priorPossibleRegistrations:3,futureAdditionalMaximum:0,futureCumulativeMaximum:3,
  privateBindingSha256:PRIVATE_BINDING_SHA256,validFromUtc:null,validUntilUtc:null,automaticRetry:false,automaticMaintenanceResume:false};}
async function readPrivateControlBytes(filename){
  if(typeof filename!=='string'||!path.isAbsolute(filename))throw Error('PRIVATE_BINDING_INVALID');
  const st=await fs.lstat(filename),dir=await fs.lstat(path.dirname(filename));
  if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.uid!==process.getuid()||(st.mode&0o777)!==0o600||st.size>200000
    ||!dir.isDirectory()||dir.isSymbolicLink()||dir.uid!==process.getuid()||(dir.mode&0o777)!==0o700)throw Error('PRIVATE_BINDING_INVALID');
  return fs.readFile(filename);
}
async function readPrivateBinding(filename){return validatePrivateBinding(await readPrivateControlBytes(filename));}
export async function freshCli(args=[]){
  if(args.length===0||canonical(args)===canonical(['--plan']))return offlinePlan();
  const readOnly=args[0]==='--verify-package';
  if(args.length!==7||!['--execute','--verify-package'].includes(args[0])||args[1]!=='--binding'
    ||args[3]!== (readOnly?'--manifest':'--approval')||args[5]!== (readOnly?'--manifest-sha256':'--approval-sha256')||!hex(args[6]))return {status:'stopped',code:'REQUEST_INVALID',liveActions:0};
  try{
    if(['NODE_OPTIONS','NODE_PATH','NODE_EXTRA_CA_CERTS','NODE_TLS_REJECT_UNAUTHORIZED'].some(k=>process.env?.[k]))throw Error('APPROVAL_REQUIRED');
    const binding=await readPrivateBinding(args[2]);
    if(path.dirname(SELF)!==binding.candidate)throw Error('CODE_MISMATCH');
    if(readOnly)return await createFreshExecution(binding,{bindingFile:args[2]}).verifyPackage(args[4],args[6]);
    return await createFreshExecution(binding,{bindingFile:args[2]}).freshCli(['--execute','--approval',args[4],'--approval-sha256',args[6]]);
  }catch(e){return {status:'stopped',code:['PRIVATE_BINDING_INVALID','APPROVAL_REQUIRED','CODE_MISMATCH'].includes(e?.message)?e.message:'APPROVAL_REQUIRED',liveActions:0,automaticRetry:false};}
}
if(process.argv[1]&&path.resolve(process.argv[1])===SELF)freshCli(process.argv.slice(2)).then(r=>{
  process.stdout.write(JSON.stringify(r)+'\n');if(!['offline','passed','verified-package'].includes(r.status))process.exitCode=1;
}).catch(()=>{process.stdout.write('{"status":"stopped","code":"INTERNAL_FAILED","automaticRetry":false}\n');process.exitCode=1;});
