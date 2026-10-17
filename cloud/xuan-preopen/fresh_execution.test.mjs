// Portable synthetic tests of the actual maintenance bundle. No private binding,
// historical evidence, SDK, browser, socket or credential is opened by this suite.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import * as urls from 'node:url';
import vm from 'node:vm';
import {EventEmitter} from 'node:events';
import {spawnSync} from 'node:child_process';

const BUNDLE=urls.fileURLToPath(new URL('../../maintenance/ib-orders-fresh-execution-v1/',import.meta.url));
const ENTRY='xuan-ib-orders-fresh.mjs',OPERATOR='xuan-ib-orders-live-operator.mjs';
const BOOTSTRAP='source/scripts/xuan-ib-cloud-oauth-bootstrap.mjs',AUDIT='source/scripts/xuan-ib-oauth-registration-audit.mjs';
const FILES=['binding.mjs',ENTRY,OPERATOR,'renew.py',BOOTSTRAP,AUDIT,'source/scripts/xuan-ib-decision-menu.mjs',
  'source/cloud/xuan-preopen/cloud_io.mjs','source/cloud/xuan-preopen/ib_diagnostics.mjs'];
const SOURCES=new Map(await Promise.all(FILES.map(async n=>[n,await fs.readFile(path.join(BUNDLE,n))])));
const T=Date.parse('2031-05-06T10:00:00.000Z'),UID=process.getuid(),CANARY='SYNTHETIC_PRIVATE_CANARY_8a0f39';
const digest=x=>crypto.createHash('sha256').update(x).digest('hex');
const json=x=>Buffer.from(JSON.stringify(x)+'\n');
const clone=x=>JSON.parse(JSON.stringify(x));
const stable=x=>Array.isArray(x)?'['+x.map(stable).join(',')+']':x&&typeof x==='object'?'{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+stable(x[k])).join(',')+'}':JSON.stringify(x);
const uuid=n=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;

function fixtureBinding(fixed={}){
  const records={},bytes=new Map(),names={'/synthetic/previous':[]};
  for(let i=0;i<15;i++){
    const name=String(i).padStart(4,'0')+'.safe.json',n='/synthetic/previous/'+name,b=json({synthetic:true,sequence:i});
    records[n]=digest(b);bytes.set(n,b);names['/synthetic/previous'].push(name);
  }
  const binding={spec:'IB-ORDERS-FRESH-PRIVATE-BINDING-v1',candidate:'/synthetic/bundle',approvalDirectory:'/synthetic/approval',approvalPath:'/synthetic/approval/fresh.approval.json',
    fresh:{spec:'IB-ORDERS-FRESH-EXECUTION-v1',operationId:uuid(1),authorizationId:uuid(2),requestId:uuid(3),unusedRequestId:uuid(4),runtime:'/synthetic/runtime'},
    fixed:{source:'/synthetic/bundle/source',head:'1'.repeat(40),tree:'2'.repeat(40),image:'synthetic.invalid/report@sha256:'+'3'.repeat(64),
      redirectUri:'http://127.0.0.1:54868/oauth/ib/callback',project:'synthetic-project',region:'synthetic-region',secret:'projects/synthetic-project/secrets/synthetic-secret',
      job:'synthetic-probe',sourceSa:'synthetic-source@synthetic.invalid',bucket:'synthetic-private',operatorAccountSha256:digest('synthetic-operator'),
      python:'/synthetic/python',gh:'/synthetic/gh',sdkRoot:'/synthetic/sdk',consumerJobs:['synthetic-probe','synthetic-report','synthetic-check','synthetic-source'],
      eodJobs:['synthetic-eod-a','synthetic-eod-b'],schedulers:['synthetic-clock','synthetic-watch'],command:['node','synthetic-probe.mjs']},
    dependencies:{node:process.versions.node,python:'synthetic',googleCloudSdk:'synthetic',nodeExecutable:'/synthetic/node',pythonExecutable:'/synthetic/python',sdkCredentialSourceSha256:digest('synthetic SDK source')},externalPins:{},
    previousRecords:records,previousNames:names,previousDigest:digest(stable({records,names}))};
  const pin=Buffer.from('synthetic executable bytes');binding.externalPins['/synthetic/node']=digest(pin);bytes.set('/synthetic/node',pin);
  Object.assign(binding.fixed,fixed);
  return {binding,bytes};
}

function graph({fixed={},privateSeams=true}={}){
  const fixture=fixtureBinding(fixed),bindingBytes=json(fixture.binding),events=[];
  const deny=kind=>new Proxy(Object.create(null),{get(_target,method){return (..._args)=>{events.push(kind+':'+String(method));throw Error('SYNTHETIC_CAPABILITY_DENIED');};}});
  const proc=new EventEmitter();Object.assign(proc,{argv:[],env:{},versions:{node:process.versions.node},getuid:()=>UID,stdout:{write(){throw Error('UNEXPECTED_STDOUT');}}});
  const time={value:T};class ClockDate extends Date{constructor(...args){super(...(args.length?args:[time.value]));}static now(){return time.value;}}
  const context=vm.createContext({Buffer,URL,URLSearchParams,TextDecoder,AbortController,AbortSignal,Response,ReadableStream,Date:ClockDate,
    process:proc,setTimeout,clearTimeout,fetch:(..._args)=>{events.push('fetch');throw Error('SYNTHETIC_FETCH_DENIED');}});
  context.structuredClone=vm.runInContext('x=>JSON.parse(JSON.stringify(x))',context);
  const into=value=>{context.__value=JSON.stringify(value);try{return vm.runInContext('JSON.parse(__value)',context);}finally{delete context.__value;}};
  const cache=new Map(),seams=new Map(),staticImports=new Map(),exposures={factory:0,native:0},builtins={'node:crypto':{default:crypto},'node:path':{default:path},'node:url':urls,
    'node:fs/promises':deny('fs'),'node:fs':{default:deny('sync-fs')}};
  // Lower ESM syntax and replace this VM's binding digest. The private test
  // graph additionally observes two returns; the product-only graph has neither
  // observation. Guard, admission and effect implementations are never replaced.
  const load=n=>{
    if(cache.has(n))return cache.get(n);assert.ok(SOURCES.has(n),'CLOSED_SOURCE_GRAPH');
    let source=SOURCES.get(n).toString('utf8').replace(/^#![^\n]*\n/,'\n');
    if(n==='binding.mjs'){
      let replacements=0;source=source.replace(/(export const PRIVATE_BINDING_SHA256=)['"][a-f0-9]{64}['"]/g,(_all,prefix)=>{replacements++;return prefix+JSON.stringify(digest(bindingBytes));});
      assert.equal(replacements,1,'ONLY_SYNTHETIC_COMMITMENT_IS_REPLACED');
    }
    const imports=[];source=source.replace(/^import\s+([^\n;]+?)\s+from\s+['"]([^'"]+)['"];?\s*$/gm,(_all,clause,id)=>{
      const dependency=id.startsWith('.')?path.posix.normalize(path.posix.join(path.posix.dirname(n),id)):id;
      if(!staticImports.has(n))staticImports.set(n,[]);staticImports.get(n).push(dependency);
      const values=id.startsWith('.')?load(dependency):builtins[id];assert.ok(values,'CLOSED_STATIC_IMPORT:'+id);
      const index=imports.push(values)-1;
      if(clause.startsWith('* as '))return `const ${clause.slice(5)}=__imports[${index}];`;
      if(clause.startsWith('{'))return `const ${clause.replace(/\bas\b/g,':')}=__imports[${index}];`;
      assert.match(clause,/^[A-Za-z_$][\w$]*$/);return `const ${clause}=__imports[${index}].default;`;
    });
    const exports=[...source.matchAll(/^export\s+(?:async\s+)?(?:function|const|class)\s+([A-Za-z_$][\w$]*)/gm)].map(m=>m[1]);
    const extra=[];
    if(n===ENTRY&&privateSeams){
      // Test-only observation of the private closure's rejection paths. This
      // changes one return value, never a guard, import or effect implementation.
      source=source.replace(/^  return \{FRESH,FIXED,PATHS,HERE,/gm,()=>{
        exposures.native++;return '  return {__testNative:Object.freeze({createRpc,createCachedSdkProcessBridge,nativeAdapters,createNodeLoopbackAdapter,createExternalBrowserAdapter,nativeRenew}),FRESH,FIXED,PATHS,HERE,';
      });
      assert.equal(exposures.native,1,'ONE_TEST_ONLY_PRIVATE_RETURN_EXPOSURE');extra.push('createFreshExecution');exposures.factory++;
    }
    source=source.replace(/^export\s+/gm,'').replace(/import\.meta\.url/g,'__metaUrl').replace(/\bimport\s*\(/g,'__dynamicImport(');
    const dynamic=async id=>{events.push('dynamic:'+id);throw Error('SYNTHETIC_DYNAMIC_IMPORT_DENIED');};
    const body=`(function(__imports,__metaUrl,__dynamicImport){'use strict';\n${source}\nreturn {product:Object.freeze({${exports.join(',')}}),private:Object.freeze({${extra.join(',')}})};})`;
    const factory=new vm.Script(body,{filename:'synthetic-bundle/'+n}).runInContext(context);
    const module=factory(imports,urls.pathToFileURL('/synthetic/bundle/'+n).href,dynamic);cache.set(n,module.product);seams.set(n,module.private);return module.product;
  };
  const bindingModule=load('binding.mjs'),binding=bindingModule.validatePrivateBinding(bindingBytes);
  const entry=load(ENTRY),operatorModule=load(OPERATOR),audit=load(AUDIT),bootstrap=load(BOOTSTRAP);
  const privateEntry=seams.get(ENTRY),fresh=privateSeams?privateEntry.createFreshExecution(binding):null,operator=operatorModule.createOperator(binding);
  return {entry,privateEntry,operatorModule,bindingModule,audit,bootstrap,fresh,operator,binding,bindingBytes,fixture,into,events,proc,time,load,staticImports,exposures};
}

function approvalFixture(h,{renewal=0}={}){
  const identity=h.into({head:'a'.repeat(40),tree:'b'.repeat(40)}),files=h.into(Object.fromEntries(FILES.map(n=>[n,digest(SOURCES.get(n))])));
  const a=h.fresh.freshManifest(files,identity);Object.assign(a,{approved:true,liveActionsApproved:true,validFromUtc:new Date(T).toISOString(),validUntilUtc:new Date(T+7200000).toISOString()});
  a.googleSession.normalRenewalMaximum=renewal;
  const bytes=new Map([...h.fixture.bytes,...FILES.map(n=>[h.binding.candidate+'/'+n,SOURCES.get(n)])]);
  for(const [key,kind,name]of [['manualHold','manual-hold','manual-hold.safe.json'],['eodQuiet','independent-eod-quiet-no-context-read','eod-quiet.safe.json']]){
    const proof=json({spec:a.spec,kind,operationId:a.operationId,attestedBy:'owner',validFromUtc:a.validFromUtc,validUntilUtc:a.validUntilUtc,confirmed:true,
      scope:key==='manualHold'?a.maintenance.manualHoldScope:a.maintenance.eodQuietScope});
    a.proofHashes[key]=digest(proof);bytes.set(h.binding.approvalDirectory+'/'+name,proof);
  }
  a.finalApproval.granted=true;
  const {finalApproval,...scope}=a;a.finalApproval.scopeSha256=digest(h.entry.canonical(h.into(scope)));
  const human=json({spec:a.spec,source:'trusted-human-message',humanMessageId:'synthetic_message',confirmed:true,scopeSha256:a.finalApproval.scopeSha256,
    authorizationId:a.authorizationId,operationId:a.operationId,validFromUtc:a.validFromUtc,validUntilUtc:a.validUntilUtc,approvedAtUtc:a.validFromUtc});
  a.finalApproval.evidenceSha256=digest(human);bytes.set(h.binding.approvalDirectory+'/human-approval.safe.json',human);bytes.set(h.binding.approvalPath,json(a));
  const calls=[],io={async read(n){calls.push(['read',n]);assert.ok(bytes.has(n),'ONLY_SYNTHETIC_READS');return bytes.get(n);},
    async previousNames(){return h.into(h.binding.previousNames);},async codeIdentity(){return identity;}};
  return {a,identity,files,bytes,io,calls,args:()=>['--execute','--approval',h.binding.approvalPath,'--approval-sha256',digest(bytes.get(h.binding.approvalPath))]};
}

test('imports, unbound/bound defaults and plans are offline with forbidden native capabilities',async()=>{
  const h=graph();for(const api of [h.entry,h.fresh])for(const args of [[],['--plan']]){
    const r=await api.freshCli(args);assert.equal(r.status,'offline');assert.equal(r.liveActions,0);assert.equal(r.liveApproved,false);
    assert.equal(r.currentOldRemainingRegistrationMaximum,0);assert.equal(r.futureAdditionalMaximum,1);assert.equal(r.futureCumulativeMaximum,3);
    assert.equal(r.validFromUtc,null);assert.equal(r.validUntilUtc,null);
  }
  for(const args of [['--execute'],['--resume'],['--natural-refresh'],['--binding','/synthetic/other']])assert.equal((await h.entry.freshCli(args)).code,'REQUEST_INVALID');
  assert.deepEqual(h.events,[]);
});

test('binding digest, object brand and deep freeze reject substitution before factory effects',()=>{
  const h=graph();assert.equal(h.bindingModule.PRIVATE_BINDING_SHA256,digest(h.bindingBytes));
  for(const raw of [Buffer.concat([h.bindingBytes,Buffer.from(' ')]),json({...clone(h.binding),candidate:'/synthetic/other'}),h.bindingBytes.toString()]){
    assert.throws(()=>h.bindingModule.validatePrivateBinding(raw),/PRIVATE_BINDING_INVALID/);
  }
  for(const fake of [clone(h.binding),Object.freeze(clone(h.binding)),{},null]){
    assert.throws(()=>h.privateEntry.createFreshExecution(fake),/PRIVATE_BINDING_INVALID/);
    assert.throws(()=>h.operatorModule.createOperator(fake),/PRIVATE_BINDING_INVALID/);
    assert.throws(()=>h.audit.createBoundAudit(fake),/PRIVATE_BINDING_INVALID/);
  }
  assert.equal(Object.isFrozen(h.binding),true);assert.equal(Object.isFrozen(h.binding.fresh),true);
  assert.throws(()=>{h.binding.fresh.runtime='/synthetic/other';},TypeError);assert.deepEqual(h.events,[]);
});

const PRODUCT_EXPORTS={
  'binding.mjs':['PRIVATE_BINDING_SHA256','validatePrivateBinding','assertPrivateBinding'],
  [ENTRY]:['sha','canonical','CODE_FILES','LIMITS','buildOfflineManifest','offlinePlan','freshCli'],
  [OPERATOR]:['createOperator'],
  [BOOTSTRAP]:['BOOTSTRAP_SPEC','BOOTSTRAP','bootstrapFailure','validateLoopbackUri','registrationProfile','preflightLoopback','createBootstrap','SDK_BRIDGE_CODE','createSdkWriter'],
  [AUDIT]:['REGISTRATION_AUDIT_SPEC','registrationRequestProfile','registrationRequestHash','assessRegistration','validateRegistrationAudit','registrationAuditHash','createBoundAudit'],
  'source/scripts/xuan-ib-decision-menu.mjs':['parseDecisionJson'],
  'source/cloud/xuan-preopen/cloud_io.mjs':['uniqueCloudJson','validateIbCredentialBinding','validateBoundIbVersionName','validateIbRotationReceipt'],
  'source/cloud/xuan-preopen/ib_diagnostics.mjs':['ibError','inIbPhase','networkCategory','httpCategory','bearerError','safeIbFailure'],
};
const PURE_OPERATOR_KEYS=['FIXED','FRESH','SOURCE_HASHES','freshClaimRecord','safeJson','safeControlDiagnostic','boundedSafeSink','runStagedOperation',
  'executionAdmission','createObservedOAuthFetch','safeBootstrapDiagnostic','SafeFailure','validateStageMaintenance','versionOf','versionName',
  'validateJob','validateMaintenance','validateReceipt','CONTROL_BRIDGE','validateRegistrationAudit','registrationAuditHash'];
const NATIVE_NAMES=['createFreshExecution','nativeAdapters','createRpc','createCachedSdkProcessBridge','createNodeLoopbackAdapter',
  'createExternalBrowserAdapter','nativeFreshIO','nativeRenew','createSdkProcessBridge','privateCloudIo','boundedText'];
function assertDataOnly(value){
  assert.notEqual(typeof value,'function','PUBLIC_OFFLINE_DATA_MUST_NOT_RETURN_CAPABILITIES');
  if(value&&typeof value==='object')for(const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))){
    assert.ok(Object.hasOwn(descriptor,'value'),'NO_LAZY_CAPABILITY_GETTERS');assertDataOnly(descriptor.value);
  }
}

test('product-only graph has exact public exports and no private factory or native acquisition surface',()=>{
  const h=graph({privateSeams:false});assert.deepEqual(h.exposures,{factory:0,native:0});assert.deepEqual(Object.keys(h.privateEntry),[]);
  for(const [name,allowed]of Object.entries(PRODUCT_EXPORTS)){
    const module=h.load(name);assert.deepEqual(Object.getOwnPropertyNames(module).sort(),[...allowed].sort(),name);
    for(const native of NATIVE_NAMES)assert.equal(module[native],undefined,name+':'+native);
  }
  assert.deepEqual(Object.keys(h.operator).sort(),[...PURE_OPERATOR_KEYS].sort());
  for(const native of NATIVE_NAMES)assert.equal(h.operator[native],undefined);
  for(const [name,imports]of h.staticImports){if(name===ENTRY)continue;
    for(const dependency of imports)assert.ok(!/^node:(?:fs(?:\/|$)|child_process$|http|https|net$|tls$|dns$|dgram$)/.test(dependency),'PURE_TRANSITIVE_IMPORT:'+name+':'+dependency);
  }
  assert.deepEqual(h.events,[]);
});

test('reproduced no-op assertNativeApproval override cannot recover nativeAdapters from public createOperator',()=>{
  const h=graph({privateSeams:false});let guardCalls=0;
  const core=h.operatorModule.createOperator(h.binding,{assertNativeApproval:()=>{guardCalls++;}});
  assert.equal(h.operatorModule.createOperator.length,1);assert.equal(core.nativeAdapters,undefined);
  assert.throws(()=>core.nativeAdapters(h.into({approved:true}),new AbortController().signal),TypeError);
  assert.equal(guardCalls,0);assert.deepEqual(Object.keys(core).sort(),[...PURE_OPERATOR_KEYS].sort());assert.deepEqual(h.events,[]);
});

test('reproduced default cached-SDK bridge cannot be acquired without approval through any public module',()=>{
  const h=graph({privateSeams:false});let overrideCalls=0;
  for(const core of [h.operator,h.operatorModule.createOperator(h.binding,{assertNativeApproval:()=>{overrideCalls++;}})]){
    assert.equal(core.createCachedSdkProcessBridge,undefined);
    assert.throws(()=>core.createCachedSdkProcessBridge(h.bootstrap),TypeError);
    assert.equal(core.createRpc,undefined);assert.equal(core.nativeAdapters,undefined);
  }
  assert.equal(h.bootstrap.createNodeLoopbackAdapter,undefined);assert.equal(h.bootstrap.createExternalBrowserAdapter,undefined);
  assert.equal(h.load('source/cloud/xuan-preopen/cloud_io.mjs').privateCloudIo,undefined);
  assert.equal(overrideCalls,0);assert.deepEqual(h.events,[]);
});

test('public offline manifest returns data only and cannot mint native IO or approval',()=>{
  const h=graph({privateSeams:false}),files=h.into(Object.fromEntries(FILES.map(n=>[n,digest(SOURCES.get(n))]))),identity=h.into({head:'a'.repeat(40),tree:'b'.repeat(40)});
  const manifest=h.entry.buildOfflineManifest(h.binding,files,identity);assertDataOnly(manifest);
  assert.equal(manifest.approved,false);assert.equal(manifest.liveActionsApproved,false);assert.equal(manifest.finalApproval.granted,false);
  assert.equal(manifest.validFromUtc,null);assert.equal(manifest.validUntilUtc,null);
  assert.equal(manifest.oldRemainingRegistrationMaximum,0);assert.equal(manifest.registrationBudget.additionalMax,1);assert.equal(manifest.registrationBudget.cumulativeMax,3);
  for(const native of NATIVE_NAMES)assert.equal(manifest[native],undefined);assert.deepEqual(h.events,[]);
});

test('public freshCli ignores caller IO and guard injection and stops on its own private binding read',async()=>{
  const h=graph({privateSeams:false});let callerTouches=0;
  const injection=new Proxy({},{get(){callerTouches++;throw Error('CALLER_OVERRIDE_MUST_NOT_BE_USED');}});
  for(const args of [[],['--plan']])assert.equal((await h.entry.freshCli(args,injection)).status,'offline');assert.deepEqual(h.events,[]);
  const result=await h.entry.freshCli(['--execute','--binding','/synthetic/nonexistent-binding.json','--approval','/synthetic/approval.json','--approval-sha256','9'.repeat(64)],injection);
  assert.equal(result.status,'stopped');assert.equal(result.liveActions,0);assert.equal(result.automaticRetry,false);
  assert.equal(callerTouches,0);assert.deepEqual(h.events,['fs:lstat']);
});

test('pure public helpers require injected capabilities and acquire no default filesystem, HTTP or SDK transport',async()=>{
  const h=graph({privateSeams:false});assert.throws(()=>h.operator.createObservedOAuthFetch(),/BOOTSTRAP_FAILED/);
  await assert.rejects(h.bootstrap.preflightLoopback(),/BOOTSTRAP_LISTENER_BINDING_INVALID/);
  assert.throws(()=>h.bootstrap.createBootstrap(),/BOOTSTRAP_APPROVAL_REQUIRED/);
  assert.throws(()=>h.bootstrap.createSdkWriter({operatorAccount:'synthetic-operator',operatorAccountSha256:digest('synthetic-operator')}),/BOOTSTRAP_APPROVAL_REQUIRED/);
  const cloud=h.load('source/cloud/xuan-preopen/cloud_io.mjs');assert.deepEqual(clone(cloud.uniqueCloudJson('{"synthetic":true}')),{synthetic:true});
  assert.equal(cloud.privateCloudIo,undefined);assert.equal(cloud.boundedText,undefined);assert.deepEqual(h.events,[]);
});

test('test-only private return observations are singular and excluded from product exports',()=>{
  const h=graph();assert.deepEqual(h.exposures,{factory:1,native:1});assert.deepEqual(Object.keys(h.privateEntry),['createFreshExecution']);
  assert.equal(h.entry.createFreshExecution,undefined);assert.equal(h.entry.__testNative,undefined);
  assert.deepEqual(Object.keys(h.fresh.__testNative).sort(),['createRpc','createCachedSdkProcessBridge','nativeAdapters','createNodeLoopbackAdapter','createExternalBrowserAdapter','nativeRenew'].sort());
  assert.deepEqual(Object.getOwnPropertyNames(h.entry).sort(),[...PRODUCT_EXPORTS[ENTRY]].sort());assert.deepEqual(h.events,[]);
});

for(const helper of ['rpc','cached-default','cached-override','loopback','browser','adapters','renewal'])test('private '+helper+' rejects fake-IO approval before native import or effect',async()=>{
  const h=graph(),f=approvalFixture(h),a=await h.fresh.verifyFresh(f.a,json(f.a),f.io,T),native=h.fresh.__testNative,signal=new AbortController().signal;
  let overrides=0;const injected=()=>{overrides++;throw Error('OVERRIDE_MUST_NOT_RUN');};
  const cases={rpc:()=>native.createRpc({spawn:injected,approval:a,signal}),
    'cached-default':()=>native.createCachedSdkProcessBridge(h.bootstrap),
    'cached-override':()=>native.createCachedSdkProcessBridge(h.bootstrap,{approval:a,beforeSpawn:injected,spawn:injected,operatorAccountSha256:digest('synthetic-operator')}),
    loopback:()=>native.createNodeLoopbackAdapter(h.bootstrap,a),browser:()=>native.createExternalBrowserAdapter(h.bootstrap,a),
    adapters:()=>native.nativeAdapters(a,signal),renewal:()=>native.nativeRenew(a,signal)};
  await assert.rejects(Promise.resolve().then(cases[helper]),/APPROVAL_REQUIRED/);assert.equal(overrides,0);assert.deepEqual(h.events,[]);
});

test('actual copied source pins match the current pure dependency bytes',()=>{
  const h=graph({privateSeams:false});for(const [name,sha]of Object.entries(h.operator.SOURCE_HASHES)){
    assert.ok(SOURCES.has('source/'+name));assert.equal(sha,digest(SOURCES.get('source/'+name)),name);
  }
  assert.deepEqual(h.events,[]);
});

test('manifest binds exact head, tree, committed files, 15 records and zero/one/three allowance',async()=>{
  const h=graph(),f=approvalFixture(h);const a=await h.fresh.verifyFresh(f.a,json(f.a),f.io,T);
  assert.equal(a.oldRemainingRegistrationMaximum,0);assert.deepEqual(clone(a.registrationBudget),{priorOutcome:'unknown',priorPossible:2,additionalMax:1,cumulativeMax:3});
  assert.equal(Object.keys(a.previousRecords).length,15);assert.equal(a.code.executionHead,f.identity.head);assert.equal(a.code.executionTree,f.identity.tree);
  assert.equal(a.code.privateBindingSha256,digest(h.bindingBytes));assert.equal(a.precedingVersion,'14');assert.equal(a.unusedSecondRequestNeverExecutable,true);
  assert.equal(a.limits.refreshes,0);assert.equal(a.limits.rotationVersions,0);assert.equal(a.limits.ordersCalls,1);
  assert.equal(a.limits.deployments,0);assert.equal(a.limits.schedules,0);assert.equal(a.limits.productionResume,0);assert.deepEqual(h.events,[]);
});

const manifestMutations={operation:a=>a.operationId=uuid(90),authorization:a=>a.authorizationId=uuid(91),request:a=>a.requestIds[0]=uuid(92),
  unusedRequest:a=>a.requestIds[1]=uuid(93),runtime:a=>a.paths.claim='/synthetic/other/fresh.claim.safe.json',candidate:a=>a.paths.candidate='/synthetic/other',
  oldBudget:a=>a.oldRemainingRegistrationMaximum=1,futureBudget:a=>a.registrationBudget.additionalMax=2,totalBudget:a=>a.registrationBudget.cumulativeMax=4,
  refresh:a=>a.limits.refreshes=1,orders:a=>a.limits.ordersCalls=2,secondRequest:a=>a.unusedSecondRequestNeverExecutable=false,
  publicHead:a=>a.code.executionHead='c'.repeat(40),publicTree:a=>a.code.executionTree='d'.repeat(40),bindingDigest:a=>a.code.privateBindingSha256='e'.repeat(64),
  precedingVersion:a=>a.precedingVersion='15',extraField:a=>a.unreviewed=true};
for(const [name,change]of Object.entries(manifestMutations))test('exact approval rejects '+name,()=>{
  const h=graph(),f=approvalFixture(h),a=h.into(f.a);change(a);
  assert.throws(()=>h.fresh.validateFreshApproval(a,{now:T,files:f.files,identity:f.identity}),/CODE_MISMATCH/);assert.deepEqual(h.events,[]);
});

for(const drift of ['source-byte','head','tree','external-pin','old-record','old-directory','human-evidence','hold-proof'])test('verification rejects '+drift+' without native effects',async()=>{
  const h=graph(),f=approvalFixture(h);
  if(drift==='source-byte')f.bytes.set(h.binding.candidate+'/'+ENTRY,Buffer.from('changed synthetic bytes'));
  if(drift==='head'||drift==='tree')f.io.codeIdentity=async()=>h.into({...f.identity,[drift]:'f'.repeat(40)});
  if(drift==='external-pin')f.bytes.set('/synthetic/node',Buffer.from('changed synthetic executable'));
  if(drift==='old-record')f.bytes.set(Object.keys(h.binding.previousRecords)[0],json({changed:true}));
  if(drift==='old-directory')f.io.previousNames=async()=>h.into({'/synthetic/previous':['extra.safe.json']});
  if(drift==='human-evidence')f.bytes.set(h.binding.approvalDirectory+'/human-approval.safe.json',json({confirmed:true}));
  if(drift==='hold-proof')f.bytes.set(h.binding.approvalDirectory+'/manual-hold.safe.json',json({confirmed:true}));
  await assert.rejects(h.fresh.verifyFresh(f.a,json(f.a),f.io,T),/CODE_MISMATCH|PREVIOUS_RECORDS_MISMATCH|HUMAN_EVIDENCE_INVALID|PROOF_INVALID/);assert.deepEqual(h.events,[]);
});

test('a branded factory alone cannot admit native adapters or Google renewal',async()=>{
  const h=graph(),f=approvalFixture(h),signal=new AbortController().signal;
  assert.equal(h.operator.nativeAdapters,undefined);
  await assert.rejects(h.fresh.__testNative.nativeAdapters(f.a,signal),/APPROVAL_REQUIRED/);
  const io=await h.privateEntry.createFreshExecution(h.binding,{bindingFile:'/synthetic/binding.json'}).nativeFreshIO();
  await assert.rejects(io.openCaps(f.a,signal),/APPROVAL_REQUIRED/);await assert.rejects(io.renew(f.a,signal),/APPROVAL_REQUIRED/);
  assert.deepEqual(h.events,[],'NO_FS_OR_DYNAMIC_IMPORT_BEFORE_NATIVE_ADMISSION');
});

function mappedClaimFs(h,directory,{breakWrite=false,allowAudit=false}={}){
  const calls=[];const map=n=>{assert.ok([h.fresh.FRESH.runtime,h.fresh.PATHS.claim,...(allowAudit?[h.fresh.PATHS.audit]:[])].includes(n),'ONLY_ONE_FIXED_SYNTHETIC_RUNTIME');
    return n===h.fresh.FRESH.runtime?path.join(directory,'runtime'):path.join(directory,'runtime',path.basename(n));};
  const io={async mkdir(n,o){calls.push('mkdir');return fs.mkdir(map(n),o);},lstat:n=>fs.lstat(map(n)),readFile:n=>fs.readFile(map(n)),
    async open(n,...options){calls.push(options[0]==='wx'?'claim-open':'read-open');const handle=await fs.open(map(n),...options);
      return {stat:()=>handle.stat(),close:()=>handle.close(),readFile:()=>handle.readFile(),sync:()=>handle.sync(),
        async writeFile(bytes){calls.push('claim-write');if(breakWrite)throw Error(CANARY);return handle.writeFile(bytes);}};}};
  return {io,calls};
}

test('two contenders sharing the same synthetic runtime create exactly one durable claim',async()=>{
  const h=graph(),f=approvalFixture(h),a=await h.fresh.verifyFresh(f.a,json(f.a),f.io,T),dir=await fs.mkdtemp(path.join(os.tmpdir(),'fresh-contention-'));
  try{const mapped=mappedClaimFs(h,dir),options={fs:mapped.io,uid:UID,clock:{now:()=>T}};
    const results=await Promise.allSettled([h.fresh.persistFreshClaim(a,options),h.fresh.persistFreshClaim(a,options)]);
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.find(r=>r.status==='rejected').reason.message,'FRESH_ALREADY_CLAIMED');
    const filename=path.join(dir,'runtime/fresh.claim.safe.json'),bytes=await fs.readFile(filename),record=JSON.parse(bytes);
    assert.equal(record.operationId,h.binding.fresh.operationId);assert.equal(record.authorizationId,h.binding.fresh.authorizationId);
    assert.equal(record.oldRemainingRegistrationMaximum,0);assert.equal(record.remainingRegistrationMaximum,1);assert.equal(record.cumulativePossibleRegistrationMaximum,3);
    assert.equal((await fs.stat(filename)).mode&0o777,0o600);assert.equal((await fs.stat(path.dirname(filename))).mode&0o777,0o700);
    await assert.rejects(h.fresh.persistFreshClaim(a,options),/FRESH_ALREADY_CLAIMED/);assert.equal(mapped.calls.filter(x=>x==='claim-write').length,1);
    assert.equal(digest(await fs.readFile(filename)),digest(bytes));
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('uncertain claim write consumes the same directory and cannot be retried',async()=>{
  const h=graph(),f=approvalFixture(h),a=await h.fresh.verifyFresh(f.a,json(f.a),f.io,T),dir=await fs.mkdtemp(path.join(os.tmpdir(),'fresh-claim-unknown-'));
  try{const mapped=mappedClaimFs(h,dir,{breakWrite:true}),options={fs:mapped.io,uid:UID,clock:{now:()=>T}};
    await assert.rejects(h.fresh.persistFreshClaim(a,options),/CLAIM_OUTCOME_UNKNOWN/);
    await assert.rejects(h.fresh.persistFreshClaim(a,options),/FRESH_ALREADY_CLAIMED/);assert.equal(mapped.calls.filter(x=>x==='claim-write').length,1);
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('actual bound audit durably links one accepted profile to the same fresh claim',async()=>{
  const h=graph(),f=approvalFixture(h),a=await h.fresh.verifyFresh(f.a,json(f.a),f.io,T),dir=await fs.mkdtemp(path.join(os.tmpdir(),'fresh-bound-audit-'));
  try{const mapped=mappedClaimFs(h,dir,{allowAudit:true}),claimHash=await h.fresh.persistFreshClaim(a,{fs:mapped.io,uid:UID,clock:{now:()=>T}});
    const context=h.into({attemptId:uuid(50),operationId:a.operationId,approvalSha256:a.approvalSha256,codeSha256:'7'.repeat(64),
      redirectUri:h.binding.fixed.redirectUri,observedAtUtc:new Date(T).toISOString(),httpStatus:201});
    const audit=h.audit.assessRegistration(h.into({...h.audit.registrationRequestProfile(context.redirectUri),client_id:'SYNTHETIC_AUDITED_CLIENT',registration_access_token:CANARY}),context);
    const bound=h.audit.createBoundAudit(h.binding),expectedClaim=h.operator.freshClaimRecord(a),options={fs:mapped.io,claimPath:h.fresh.PATHS.claim,auditPath:h.fresh.PATHS.audit,
      expectedClaim,parse:h.operator.safeJson,uid:UID};
    const ack=await bound.persistRegistrationAudit(audit,options);assert.equal(ack.persisted,true);assert.equal(ack.auditSha256,h.audit.registrationAuditHash(audit));
    const envelope=JSON.parse(await fs.readFile(path.join(dir,'runtime/fresh.registration-audit.safe.json')));
    assert.equal(envelope.claimSha256,claimHash);assert.equal(JSON.stringify(envelope).includes(CANARY),false);
    const read=await bound.readPersistedRegistrationAudit({...options,expectedAttemptId:context.attemptId,expectedAuditSha256:ack.auditSha256,expectedCodeSha256:context.codeSha256});
    assert.equal(read.attemptId,context.attemptId);assert.equal(read.operationId,a.operationId);
    await assert.rejects(bound.persistRegistrationAudit(audit,options),/PERSISTENCE_UNCONFIRMED/);
    for(const change of [{claimPath:'/synthetic/other/fresh.claim.safe.json'},{expectedClaim:h.into({...expectedClaim,operationId:uuid(51)})},
      {expectedClaim:h.into({...expectedClaim,remainingRegistrationMaximum:2})},{expectedClaim:h.into({...expectedClaim,cumulativePossibleRegistrationMaximum:4})}]){
      const before=mapped.calls.length;await assert.rejects(bound.persistRegistrationAudit(audit,{...options,...change}),/PERSISTENCE_UNCONFIRMED/);assert.equal(mapped.calls.length,before);
    }
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});

for(const mode of ['cancelled','expired','not-yet-valid'])test('claim admission '+mode+' has no filesystem effect',async()=>{
  const h=graph(),f=approvalFixture(h),a=await h.fresh.verifyFresh(f.a,json(f.a),f.io,T),abort=new AbortController();
  if(mode==='cancelled')abort.abort();let calls=0;const forbidden=new Proxy({},{get(){calls++;throw Error(CANARY);}});
  await assert.rejects(h.fresh.persistFreshClaim(a,{fs:forbidden,signal:abort.signal,clock:{now:()=>mode==='expired'?T+7200000:mode==='not-yet-valid'?T-1:T}}),/CANCELLED|WINDOW_INVALID/);
  assert.equal(calls,0);
});

for(const mode of ['cancel','deadline'])test('OAuth fetch admission '+mode+' after reservation prevents transport',async()=>{
  const h=graph(),f=approvalFixture(h),abort=new AbortController();let transports=0;
  const observed=h.operator.createObservedOAuthFetch(async()=>{transports++;throw Error(CANARY);},{
    onEvent:async()=>{if(mode==='cancel')abort.abort();else h.time.value=T+7200000;},
    beforeFetch:()=>h.operator.executionAdmission(f.a,abort.signal)});
  await assert.rejects(observed.fetch(h.bootstrap.BOOTSTRAP.register,{signal:abort.signal}),/CANCELLED|DEADLINE_EXCEEDED|BOOTSTRAP_OUTCOME_UNKNOWN/);
  assert.equal(transports,0);assert.equal(observed.snapshot().registration.requestReservations,1);
  await assert.rejects(observed.fetch(h.bootstrap.BOOTSTRAP.register,{signal:abort.signal}));assert.equal(transports,0);
});

test('unknown OAuth transport outcome never submits again and safe projection excludes canaries',async()=>{
  const h=graph();let transports=0;const observed=h.operator.createObservedOAuthFetch(async()=>{transports++;throw Error(CANARY);});
  await assert.rejects(observed.fetch(h.bootstrap.BOOTSTRAP.register,{}),/BOOTSTRAP_OUTCOME_UNKNOWN/);
  await assert.rejects(observed.fetch(h.bootstrap.BOOTSTRAP.register,{}));assert.equal(transports,1);
  const diagnostic=h.operator.safeBootstrapDiagnostic(h.into({code:'BOOTSTRAP_DCR_OUTCOME_UNKNOWN',phase:'stopped',sideEffects:{registration:'unknown',codeExchange:'not-started',secretWrite:'not-started'},private:CANARY}),observed.snapshot());
  assert.equal(diagnostic.registrationOutcome,'request-reserved-outcome-unknown');assert.equal(JSON.stringify(diagnostic).includes(CANARY),false);
});

function cliHarness(h,{renewal=0,stopAt=null,stopMode='cancel',renewUnknown=false}={}){
  const f=approvalFixture(h,{renewal}),counts={reserve:0,renew:0,open:0,maintenance:0,dcr:0,orders:0,finish:0},events=[];let claimed=false;
  const stop=at=>{events.push(at);if(stopAt===at){if(stopMode==='cancel')h.proc.emit('SIGTERM');else h.time.value=T+7200000;}};
  Object.assign(f.io,{async reserve(){counts.reserve++;if(claimed)throw Error('FRESH_ALREADY_CLAIMED');claimed=true;stop('claim');},
    async verifyClaim(){assert.equal(claimed,true);stop('verify-claim');},async renew(){counts.renew++;stop('renew');if(renewUnknown)throw Error('GOOGLE_RENEWAL_OUTCOME_UNKNOWN');return h.into({status:'GOOGLE_SESSION_READY'});},
    async openCaps(a,signal){counts.open++;stop('open');return {async checkMaintenance(){counts.maintenance++;stop('maintenance');},
      async bootstrap({onBeforeRegistration}){stop('bootstrap-factory');return {async start(){await onBeforeRegistration();h.operator.executionAdmission(a,signal);counts.dcr++;throw Error(CANARY);},async cancel(){return {listenerClosed:true};}};},
      async probe(){counts.orders++;throw Error('UNEXPECTED_FINANCIAL_DISPATCH');},async close(){} };},
    async audit(value){assert.equal(JSON.stringify(value).includes(CANARY),false);},async finish(_a,value){counts.finish++;assert.equal(JSON.stringify(value).includes(CANARY),false);},claimState:()=>claimed?'confirmed':'not-started'});
  return {...f,counts,events};
}

for(const stopMode of ['cancel','deadline'])for(const stopAt of ['claim','verify-claim','renew','open','maintenance','bootstrap-factory'])test('entry '+stopMode+' after '+stopAt+' admits no DCR/orders',async()=>{
  const h=graph(),f=cliHarness(h,{renewal:1,stopAt,stopMode}),r=await h.fresh.freshCli(f.args(),{io:f.io,clock:{now:()=>h.time.value}});
  assert.ok(f.events.includes(stopAt),'THE_REQUESTED_BOUNDARY_WAS_ACTUALLY_REACHED');
  assert.equal(r.status,'stopped');assert.equal(f.counts.dcr,0);assert.equal(f.counts.orders,0);assert.ok(f.counts.reserve<=1);assert.ok(f.counts.renew<=1);
  assert.equal(r.automaticRetry,false);assert.equal(r.automaticMaintenanceResume,false);assert.deepEqual(h.events,[]);
});

test('unknown renewal stops before adapters, and unknown DCR re-entry cannot reset the claim',async()=>{
  const h=graph(),f=cliHarness(h,{renewal:1,renewUnknown:true});const first=await h.fresh.freshCli(f.args(),{io:f.io,clock:{now:()=>T}});
  assert.equal(first.code,'GOOGLE_RENEWAL_OUTCOME_UNKNOWN');assert.equal(f.counts.renew,1);assert.equal(f.counts.open,0);
  const again=await h.fresh.freshCli(f.args(),{io:f.io,clock:{now:()=>T}});assert.equal(again.code,'FRESH_ALREADY_CLAIMED');assert.equal(f.counts.renew,1);
  const other=graph(),g=cliHarness(other);const result=await other.fresh.freshCli(g.args(),{io:g.io,clock:{now:()=>T}});
  assert.equal(result.status,'stopped');assert.equal(g.counts.dcr,1);assert.equal(g.counts.orders,0);
  await other.fresh.freshCli(g.args(),{io:g.io,clock:{now:()=>T}});assert.equal(g.counts.dcr,1);assert.equal(g.counts.open,1);
});

async function stagedTiming({ttl=3600000,saveAdvance=0,maintenanceAdvance=0,mutate=null}={}){
  // These immutable destination constants are obtained from the actual pure
  // bootstrap module; no private identity, operation ID or path is copied here.
  const constants=graph().bootstrap.BOOTSTRAP,h=graph({fixed:{secret:constants.secret,job:constants.job}}),f=approvalFixture(h);
  const a=await h.fresh.verifyFresh(f.a,json(f.a),f.io,T);if(mutate)mutate(a);
  const counts={maintenance:0,reserve:0,dcr:0,save:0,posts:0},fixed=h.binding.fixed,version=fixed.secret+'/versions/15';
  const caps={async checkMaintenance(){counts.maintenance++;if(counts.maintenance===2)h.time.value+=maintenanceAdvance;},async close(){},
    async bootstrap({onBeforeRegistration,onSaved}){return {async start(){await onBeforeRegistration();counts.dcr++;
      onSaved(h.into({clientId:'SYNTHETIC_TIMING_CLIENT',expiresAt:T+ttl,versionName:version}));counts.save++;h.time.value+=saveAdvance;
      return h.into({status:'prepared-for-cloud-validation',code:'BOOTSTRAP_SECRET_VERSION_CONFIRMED',listenerClosed:true,savedVersion:{name:version,state:'ENABLED'},
        registration:{clientId:'SYNTHETIC_TIMING_CLIENT',requestedClientName:'XUAN Preopen Cloud Read-only v2',redirectUri:fixed.redirectUri,tokenEndpointAuthMethod:'none',
          grantTypes:['authorization_code','refresh_token'],responseTypes:['code'],scope:'mcp.read',issuer:constants.issuer,resource:constants.resource,
          observedAtUtc:new Date(T).toISOString(),codeSha256:h.operator.SOURCE_HASHES['scripts/xuan-ib-cloud-oauth-bootstrap.mjs'],managementCredentialReturned:false,managementCredentialPersisted:false}});
    },async cancel(){return {listenerClosed:true};}};},async probe(request,{index}){
      assert.equal(index,0,'NO_REFRESH_CONTINUATION');counts.posts++;const now=h.time.value;
      assert.ok(Date.parse(request.expiresAt)-now>=80000);assert.equal(Date.parse(request.expiresAt),Math.min(now+240000,Date.parse(a.validUntilUtc)-75000,
        Date.parse(new Date(now+28800000).toISOString().slice(0,10)+'T00:00:00.000+08:00')+86400000-1,T+ttl-125000));
      const short=fixed.job+'-synthetic-1',execution=`projects/${fixed.project}/locations/${fixed.region}/jobs/${fixed.job}/executions/${short}`;
      return h.into({execution,receipt:{status:'passed',mode:'cloud-orders-probe',requestId:request.requestId,dataDate:request.dataDate,expiresAt:request.expiresAt,
        execution:short,upstreamAttempted:true,ordersCalls:1,refreshCalls:0,credentialClientMatched:true,credentialVersionMatched:true,consumedCredentialVersion:version,
        savedCredentialVersion:null,credentialPersistence:'not-needed',startedAt:new Date(now).toISOString(),completedAt:new Date(now+1).toISOString(),receiptSha256:'8'.repeat(64),
        associationBasis:'owner-attested',responseAccountEvidence:'not-provided',nativeIdentityEvidence:'not-provided'}});
    }};
  const result=await h.operator.runStagedOperation(a,caps,{clock:{now:()=>h.time.value},reserve:async()=>{counts.reserve++;}});
  return {h,result,counts};
}

for(const [name,options,posts]of [
  ['short token TTL',{ttl:204999},0],['exact eighty-second dispatch allowance',{ttl:205000},1],
  ['save crosses token safety threshold',{ttl:205000,saveAdvance:1},0],
  ['maintenance crosses token safety threshold',{ttl:205000,maintenanceAdvance:1},0],
  ['save retains exact eighty seconds',{ttl:205001,saveAdvance:1},1],
  ['normal token TTL',{ttl:3600000},1],
])test('actual staged operation '+name,async()=>{
  const {h,result,counts}=await stagedTiming(options);assert.equal(counts.posts,posts);assert.equal(result.sideEffects.runPosts,posts);
  assert.equal(counts.dcr,1);assert.equal(counts.save,1);assert.equal(counts.reserve,1);assert.equal(result.confirmed.refreshCalls,0);
  if(posts)assert.equal(result.status,'initial-orders-passed-refresh-pending');else assert.equal(result.code,'WINDOW_OUTSIDE_APPROVAL');
  assert.deepEqual(h.events,[]);
});

for(const [name,mutate]of Object.entries({operation:a=>a.operationId=uuid(70),authorization:a=>a.authorizationId=uuid(71),request:a=>a.requestIds[0]=uuid(72),
  refreshContinuation:a=>a.stage='natural-refresh'}))test('staged logic rejects alternate '+name+' before bootstrap',async()=>{
  const {result,counts}=await stagedTiming({mutate});assert.equal(result.code,'APPROVAL_REQUIRED');assert.equal(counts.maintenance,0);
  assert.equal(counts.dcr,0);assert.equal(counts.posts,0);assert.equal(counts.reserve,0);
});

function bootstrapHarness(h,{unknown=null,stopAt=null,stopMode='cancel',exchangeAdvance=0,writeAdvance=0}={}){
  let now=T,sequence=0,handler,app;const timers=new Map(),counts={listen:0,close:0,maintenance:0,dcr:0,browser:0,audit:0,exchange:0,save:0};
  const clock={now:()=>now,setTimeout(fn,ms){const id=++sequence;timers.set(id,{fn,at:now+ms,ms});return id;},clearTimeout:id=>timers.delete(id)};
  const advance=ms=>{now+=ms;};
  const stop=async at=>{if(stopAt!==at)return;if(stopMode==='cancel')await app.cancel();else now=T+7200000;};
  const admission=()=>{if(now>=T+7200000)throw Error('DEADLINE_EXCEEDED');};
  const core=h.bootstrap,account='synthetic-operator',client='SYNTHETIC_CLIENT';
  const approval=h.into({spec:core.BOOTSTRAP_SPEC,codeSha256:'5'.repeat(64),redirectUri:h.binding.fixed.redirectUri,operatorAccount:account,precedingVersion:'14',approved:true,acceptMacReplacement:true});
  const context=h.into({attemptId:uuid(5),operationId:h.binding.fresh.operationId,approvalSha256:'6'.repeat(64)});
  const toResponse=value=>new Response(JSON.stringify(value),{status:200});
  app=core.createBootstrap({approval,operatorAccountSha256:digest(account),registrationContext:context,clock,admission,
    randomBytes:()=>Buffer.alloc(32,++sequence),
    listener:{async bind(){counts.listen++;await stop('listen');return {host:'127.0.0.1',port:54868,setHandler(fn){handler=fn;},async close(){counts.close++;}};}},
    browser:{async open(uri){counts.browser++;assert.equal(new URL(uri).pathname,core.BOOTSTRAP.startPath);assert.equal(new URL(uri).search,'');await stop('browser');}},
    maintenance:{async check(){counts.maintenance++;await stop(counts.maintenance===1?'maintenance':'final-maintenance');return h.into({entrypointsPaused:true,executionsDrained:true,manualOldVersionRunsBlocked:true,observedVersion:'14'});}},
    onRegistrationAudit:async audit=>{counts.audit++;await stop('audit');return h.into({persisted:true,auditSha256:h.audit.registrationAuditHash(audit)});},
    fetchImpl:async(endpoint,options)=>{assert.equal(options.method,'POST');assert.equal(options.redirect,'error');assert.equal(options.credentials,'omit');
      if(endpoint===core.BOOTSTRAP.register){counts.dcr++;if(unknown==='dcr')throw Error(CANARY);await stop('dcr');return toResponse({...core.registrationProfile(approval.redirectUri),client_id:client,registration_access_token:CANARY});}
      assert.equal(endpoint,core.BOOTSTRAP.token);counts.exchange++;if(unknown==='exchange')throw Error(CANARY);advance(exchangeAdvance);await stop('exchange');
      return toResponse({access_token:CANARY+'_access',refresh_token:CANARY+'_refresh',token_type:'Bearer',expires_in:3600,scope:'mcp.read'});
    },store:{async save(){counts.save++;advance(writeAdvance);if(unknown==='save')throw Error(CANARY);await stop('save');return h.into({name:core.BOOTSTRAP.secret+'/versions/15',state:'ENABLED'});}}});
  const request=(rawUrl,cookie)=>h.into({method:'GET',host:new URL(approval.redirectUri).host,hostCount:1,rawUrl,...(cookie?{cookie}:{})});
  const authorize=async()=>{
    assert.equal(typeof handler,'function');const start=await handler(request(core.BOOTSTRAP.startPath));assert.equal(start.statusCode,303);
    const url=new URL(start.headers.Location),cookie=start.headers['Set-Cookie'].split(';')[0];
    return ()=>handler(request(core.BOOTSTRAP.callbackPath+'?'+new URLSearchParams({code:CANARY+'_code',state:url.searchParams.get('state'),iss:core.BOOTSTRAP.issuer}),cookie));
  };
  return {app,counts,timers,advance,authorize,now:()=>now,async fire(ms){for(const [id,t]of [...timers])if(t.ms===ms){timers.delete(id);t.fn();}await Promise.resolve();await Promise.resolve();}};
}

test('actual bootstrap accepts callback just before ten minutes and finishes in its independent forty seconds',async()=>{
  const h=graph(),b=bootstrapHarness(h,{exchangeAdvance:1000,writeAdvance:1000});assert.equal((await b.app.start()).status,'pending');
  b.advance(599999);const submit=await b.authorize(),response=await submit(),result=await b.app.finished;
  assert.equal(response.statusCode,200);assert.equal(result.code,'BOOTSTRAP_SECRET_VERSION_CONFIRMED');assert.ok(b.now()>T+600000);
  assert.equal(result.listenerClosed,true);assert.deepEqual(b.counts,{listen:1,close:1,maintenance:2,dcr:1,browser:1,audit:1,exchange:1,save:1});
  assert.equal((await submit()).statusCode,409);assert.equal((await b.app.start()).code,'BOOTSTRAP_REPLAY_REJECTED');
  assert.equal(JSON.stringify(result).includes(CANARY),false);assert.deepEqual(h.events,[]);
});

test('actual bootstrap rejects callback at ten minutes without exchange or write',async()=>{
  const h=graph(),b=bootstrapHarness(h);await b.app.start();const submit=await b.authorize();b.advance(600000);
  assert.equal((await submit()).safe.code,'BOOTSTRAP_SESSION_EXPIRED');assert.equal(b.counts.exchange,0);assert.equal(b.counts.save,0);assert.equal(b.counts.close,1);
});

test('actual bootstrap cannot extend forty-second finalization with a late write acknowledgement',async()=>{
  const h=graph(),b=bootstrapHarness(h,{writeAdvance:40000});await b.app.start();const submit=await b.authorize();b.advance(599999);
  const response=await submit();assert.equal(response.safe.code,'BOOTSTRAP_FINALIZATION_EXPIRED');assert.equal(response.safe.sideEffects.secretWrite,'unknown');
  assert.equal(b.counts.save,1);assert.equal((await submit()).statusCode,409);assert.equal(b.counts.save,1);
});

for(const unknown of ['dcr','exchange','save'])test('actual bootstrap unknown '+unknown+' is terminal without retry or canary disclosure',async()=>{
  const h=graph(),b=bootstrapHarness(h,{unknown});const started=await b.app.start();let result;
  if(started.status==='pending'){const submit=await b.authorize();result=(await submit()).safe;assert.equal((await submit()).statusCode,409);}else result=started;
  assert.match(result.code,/OUTCOME_UNKNOWN/);assert.equal(result.automaticRetry,false);assert.equal(result.listenerClosed,true);
  await b.app.start();assert.equal(b.counts.dcr,1);assert.ok(b.counts.exchange<=1);assert.ok(b.counts.save<=1);assert.equal(JSON.stringify(result).includes(CANARY),false);
});

for(const stopMode of ['cancel','deadline'])for(const stopAt of ['maintenance','audit','browser','exchange','final-maintenance'])test('actual bootstrap '+stopMode+' at '+stopAt+' prevents later effects',async()=>{
  const h=graph(),b=bootstrapHarness(h,{stopMode,stopAt});let result=await b.app.start();
  if(result.status==='pending'){const submit=await b.authorize();result=(await submit()).safe;}
  assert.notEqual(result.status,'prepared-for-cloud-validation');assert.equal(b.counts.save,0);assert.equal(result.listenerClosed,true);
  if(['maintenance','audit','browser'].includes(stopAt))assert.equal(b.counts.exchange,0);
  if(stopAt==='maintenance')assert.equal(b.counts.dcr,0);assert.ok(b.counts.dcr<=1);assert.equal(JSON.stringify(result).includes(CANARY),false);
});

test('actual SDK writer consumes one submission after an unknown fake process result',async()=>{
  const h=graph();let submissions=0;const account='synthetic-operator';
  const writer=h.bootstrap.createSdkWriter({operatorAccount:account,operatorAccountSha256:digest(account),runProcess:async request=>{
    submissions++;assert.equal(request.discardStderr,true);assert.equal(request.args[2],h.bootstrap.SDK_BRIDGE_CODE);throw Error(CANARY);
  }});
  const credential=h.into({client_id:'SYNTHETIC_CLIENT',access_token:CANARY+'_access',refresh_token:CANARY+'_refresh',token_type:'Bearer',scope:'mcp.read',
    resource:h.bootstrap.BOOTSTRAP.resource,expires_at:T+3600000});
  const options={operatorAccount:account,precedingVersion:'14'};
  await assert.rejects(writer.save(credential,options),/BOOTSTRAP_SECRET_WRITE_OUTCOME_UNKNOWN/);
  await assert.rejects(writer.save(credential,options),/BOOTSTRAP_SECRET_WRITE_OUTCOME_UNKNOWN/);assert.equal(submissions,1);assert.deepEqual(h.events,[]);
});

const PYTHON_FAKE_TESTS=String.raw`
import sys,json,builtins,types,hashlib
payload=json.loads(sys.stdin.read())
original_import=builtins.__import__
forbidden=[]
def safe_import(name,*args,**kwargs):
    if name.split('.')[0] in {'google','googlecloudsdk','requests','socket','http','subprocess'}:
        forbidden.append(name)
        raise ImportError('SYNTHETIC_NATIVE_IMPORT_DENIED')
    return original_import(name,*args,**kwargs)
builtins.__import__=safe_import
def library(source,label):
    ns={'__name__':'synthetic_test','__file__':'/synthetic/'+label}
    exec(compile(source,'synthetic-'+label,'exec'),ns)
    return ns
renew=library(payload['renew'],'renew.py')
control=library(payload['control'],'control.py')
sdk=library(payload['sdk'],'writer.py')
passed=[]
def case(name,action):
    action();passed.append(name)
def raises(kind,action):
    try:action()
    except kind:return
    raise AssertionError('EXPECTED_CLOSED_FAILURE')
class Closed(Exception):pass
class Reply:
    def __init__(self,url,raw=b'{}',status=200):self.url=url;self.raw=raw;self.status_code=status;self.closed=0
    def iter_content(self,*args,**kwargs):yield self.raw
    def close(self):self.closed+=1
class Session:
    def __init__(self,kind='ok',raw=None):self.kind=kind;self.raw=raw;self.calls=[];self.mounts=[];self.closed=0;self.trust_env=True;self.reply=None
    def mount(self,scheme,adapter):self.mounts.append((scheme,adapter))
    def request(self,method,url,**kwargs):
        self.calls.append((method,url,kwargs))
        if self.kind=='timeout':raise TimeoutError('SYNTHETIC_UNCERTAIN')
        raw=self.raw if self.raw is not None else b'{}'
        self.reply=Reply(url if self.kind!='redirect' else 'https://synthetic.invalid',raw,401 if self.kind=='unauthorized' else 200)
        return self.reply
    def post(self,url,**kwargs):return self.request('POST',url,**kwargs)
    def close(self):self.closed+=1
TOKEN='https://oauth2.googleapis.com/token'
BODY='grant_type=refresh_token&refresh_token=SYNTHETIC_ONLY'
def once(kind='ok',raw=None):
    session=Session(kind,raw);return session,renew['OnceRequest'](session,Closed)
def submit_once(request,**changes):
    args=dict(url=TOKEN,method='POST',body=BODY,headers={});args.update(changes);return request(**args)
def renewal_success():
    session,request=once();result=submit_once(request)
    assert result.status==200 and request.reservations==1 and request.response_received
    assert len(session.calls)==1 and session.calls[0][2]['timeout']==(2,6)
    assert session.calls[0][2]['allow_redirects'] is False and session.calls[0][2]['stream'] is True
    assert session.reply.closed==1
    raises(Closed,lambda:submit_once(request));assert len(session.calls)==1
case('renewal transport reserves once and enforces bounded nonredirecting POST',renewal_success)
for label,changes in [('endpoint',{'url':'https://synthetic.invalid/token'}),('method',{'method':'GET'}),('grant',{'body':'grant_type=authorization_code&code=SYNTHETIC'}),('options',{'timeout':100})]:
    def action(changes=changes):
        session,request=once();raises(Closed,lambda:submit_once(request,**changes));assert request.reservations==0 and session.calls==[]
    case('renewal rejects '+label+' before HTTP',action)
for kind,raw in [('timeout',None),('redirect',None),('ok',b'x'*65537)]:
    def action(kind=kind,raw=raw):
        session,request=once(kind,raw);raises((Closed,TimeoutError),lambda:submit_once(request));assert request.reservations==1
        raises(Closed,lambda:submit_once(request));assert len(session.calls)==1
        if session.reply:assert session.reply.closed==1
    case('renewal '+('oversize' if raw else kind)+' remains consumed without retry',action)
def renewal_deadline():
    renew['time']=types.SimpleNamespace(time=lambda:1)
    renew['EXECUTION_DEADLINE_MS']=1000
    session,request=once();raises(RuntimeError,lambda:submit_once(request));assert request.reservations==0 and session.calls==[]
    renew['EXECUTION_DEADLINE_MS']=None
case('renewal absolute deadline admits zero HTTP',renewal_deadline)
class Credential:
    def __init__(self,valid=False,handler=None):self.valid=valid;self.refresh_handler=handler;self.refreshes=0
    def refresh(self,request):self.refreshes+=1;submit_once(request);self.valid=True
def renew_cached():
    session,request=once();credential=Credential(True);audit={}
    result=renew['renew_existing']('synthetic',credential,request,Closed,lambda:'synthetic',audit)
    assert result['state']=='not-needed' and credential.refreshes==0 and session.calls==[] and audit=={}
case('cached Google credential performs no renewal or scope request',renew_cached)
def renew_expired():
    session,request=once();credential=Credential();audit={}
    result=renew['renew_existing']('synthetic',credential,request,Closed,lambda:'synthetic',audit)
    assert result['state']=='confirmed' and audit['sdkRefreshInvoked'] and credential.refreshes==1
    assert credential._enable_reauth_refresh is False and len(session.calls)==1
    assert 'scope' not in session.calls[0][2]['data']
case('existing refresh disables reauth and introduces no scopes',renew_expired)
def renew_broker():
    session,request=once();credential=Credential(handler=lambda:None)
    raises(Closed,lambda:renew['renew_existing']('synthetic',credential,request,Closed,lambda:'synthetic',{}))
    assert credential.refreshes==0 and session.calls==[]
case('refresh handler cannot open an alternate authorization path',renew_broker)
def renew_unknown():
    session,request=once('timeout');credential=Credential()
    for _ in range(2):raises((Closed,TimeoutError),lambda:renew['renew_existing']('synthetic',credential,request,Closed,lambda:'synthetic',{}))
    assert len(session.calls)==1 and request.reservations==1
case('unknown existing refresh cannot repeat its reserved HTTP request',renew_unknown)

def adapter(**kwargs):assert kwargs=={'max_retries':0};return 'zero-retries'
now=[1000]
control['time']=types.SimpleNamespace(time=lambda:now[0]/1000)
ids=payload['ids']
request={'requestId':ids[0],'dataDate':'2031-05-06','expiresAt':'2031-05-06T10:01:00.000Z','credentialBinding':{'clientId':'SYNTHETIC_CLIENT','version':'15'}}
class Auth:
    def __init__(self,expire=False):self.calls=0;self.expire=expire
    def before_request(self,request,method,url,headers):
        self.calls+=1;headers['authorization']='Bearer SYNTHETIC_ONLY'
        if self.expire:now[0]=2000
def make_control(kind='ok',deadline=None,expire=False):
    operation=control['JOB'].split('/jobs/')[0]+'/operations/synthetic-operation'
    session=Session(kind,json.dumps({'name':operation}).encode());auth=Auth(expire)
    obj=control['Control']('synthetic',auth,lambda:session,adapter,lambda **kwargs:None,ids,deadline)
    return obj,session,auth
def control_success():
    obj,session,auth=make_control();result=obj.dispatch({'op':'run','request':request})
    assert result['operation'].endswith('/operations/synthetic-operation') and len(session.calls)==1 and auth.calls==1
    method,url,options=session.calls[0]
    assert method=='POST' and url=='https://run.googleapis.com/v2/'+control['JOB']+':run'
    assert options['timeout']==(1,2.5) and options['allow_redirects'] is False and options['stream'] is True
    overrides=options['json']['overrides'];assert overrides['taskCount']==1 and overrides['timeout']=='75s'
    assert json.loads(overrides['containerOverrides'][0]['args'][1])==request
    assert session.trust_env is False and session.mounts==[('https://','zero-retries')]
    raises(control['Closed'],lambda:obj.dispatch({'op':'run','request':request}));assert len(session.calls)==1
case('actual control uses fixed one-task endpoint and consumes the request once',control_success)
def control_unknown():
    obj,session,auth=make_control('timeout')
    for _ in range(2):raises(control['Closed'],lambda:obj.dispatch({'op':'run','request':request}))
    assert len(session.calls)==1 and obj.runs=={ids[0]:True} and auth.calls==1
case('actual control unknown Run POST remains consumed',control_unknown)
def control_deadline():
    now[0]=1000;obj,session,auth=make_control(deadline=1000)
    raises(control['Closed'],lambda:obj.dispatch({'op':'run','request':request}));assert session.calls==[] and auth.calls==0 and obj.runs=={}
case('actual control absolute deadline stops before credentials or POST',control_deadline)
def control_auth_deadline():
    now[0]=1000;obj,session,auth=make_control(deadline=2000,expire=True)
    raises(control['Closed'],lambda:obj.dispatch({'op':'run','request':request}));assert session.calls==[] and auth.calls==1
    assert obj.runs=={ids[0]:True};now[0]=1000
case('actual control rechecks deadline after credential preparation',control_auth_deadline)
def control_foreign_request():
    obj,session,auth=make_control();bad=dict(request,requestId=payload['foreignId'])
    raises(control['Closed'],lambda:obj.dispatch({'op':'run','request':bad}));assert session.calls==[] and obj.runs=={}
case('actual control rejects unbound request ID without POST',control_foreign_request)

account='synthetic-writer';operator_hash=hashlib.sha256(account.encode()).hexdigest()
credential={'client_id':'SYNTHETIC_CLIENT','access_token':'SYNTHETIC_ACCESS','refresh_token':'SYNTHETIC_REFRESH','token_type':'Bearer',
            'scope':'mcp.read','resource':payload['resource'],'expires_at':100000}
def writer(kind='ok',raw=None,wrong_identity=False):
    if raw is None:raw=json.dumps({'name':sdk['SECRET']+'/versions/15','state':'ENABLED'}).encode()
    session=Session(kind,raw);auth=Auth();created=[]
    def factory():created.append(True);return session
    def action():return sdk['submit'](dict(credential),lambda:('wrong' if wrong_identity else account,auth),factory,adapter,lambda **kwargs:None,operator_hash)
    return action,session,auth,created
def writer_success():
    action,session,auth,created=writer();assert action()=={'name':sdk['SECRET']+'/versions/15','state':'ENABLED'}
    assert created==[True] and len(session.calls)==1 and auth.calls==1 and session.trust_env is False
    assert session.mounts==[('https://','zero-retries')] and session.closed==1 and session.reply.closed==1
    method,url,options=session.calls[0];assert method=='POST' and url==sdk['URL']
    assert options['timeout']==(5,12) and options['allow_redirects'] is False and options['stream'] is True
case('actual SDK submit has zero retries, bounded one POST and fixed Secret',writer_success)
for kind,raw,label in [('timeout',None,'timeout'),('redirect',None,'redirect'),('unauthorized',None,'401'),
                       ('ok',b'{"state":"ENABLED","state":"ENABLED"}','duplicate JSON'),('ok',b'x'*8193,'oversize response')]:
    def action(kind=kind,raw=raw):
        submit,session,auth,created=writer(kind,raw);raises(sdk['BridgeFailure'],submit)
        assert len(session.calls)==1 and auth.calls==1 and session.closed==1
        if session.reply:assert session.reply.closed==1
    case('actual SDK submit '+label+' never resubmits',action)
def writer_identity():
    action,session,auth,created=writer(wrong_identity=True);raises(sdk['BridgeFailure'],action)
    assert created==[] and session.calls==[] and auth.calls==0
case('actual SDK submit rejects alternate operator before HTTP session',writer_identity)
assert forbidden==[], 'NO_NATIVE_SDK_OR_NETWORK_MODULE_WAS_IMPORTED'
print(json.dumps({'passed':passed,'nativeImports':forbidden,'realRequests':0}))
`;

test('actual Python renewal/control/SDK code executes only against blocked imports and fake transports',async t=>{
  const h=graph(),input={renew:SOURCES.get('renew.py').toString('utf8'),control:h.operator.CONTROL_BRIDGE,sdk:h.bootstrap.SDK_BRIDGE_CODE,
    ids:[uuid(3),uuid(4)],foreignId:uuid(99),resource:h.bootstrap.BOOTSTRAP.resource};
  const child=spawnSync('python3',['-I','-c',PYTHON_FAKE_TESTS],{input:JSON.stringify(input),encoding:'utf8',timeout:10000,maxBuffer:262144,
    env:{PATH:process.env.PATH??'/usr/bin:/bin',PYTHONDONTWRITEBYTECODE:'1'}});
  assert.equal(child.error,undefined,'A_STANDARD_PYTHON3_MUST_BE_AVAILABLE');assert.equal(child.status,0,child.stderr);
  // Apple's system python launcher can emit this fixed sandbox startup warning;
  // the executed fake program must emit no stderr, including exception values.
  assert.match(child.stderr,/^(?:python3: warning: confstr\(\) failed with code 5: couldn't get path of DARWIN_USER_TEMP_DIR; using \/tmp instead\n)?$/);
  assert.equal(child.stdout.includes(CANARY),false);
  const result=JSON.parse(child.stdout);assert.equal(result.realRequests,0);assert.deepEqual(result.nativeImports,[]);assert.ok(result.passed.length>=25);
  for(const name of result.passed)await t.test(name,()=>{});assert.deepEqual(h.events,[]);
});
