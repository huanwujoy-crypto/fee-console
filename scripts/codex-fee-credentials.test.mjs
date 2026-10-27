import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseManagerLink, readPrivateManagerLink } from "./codex-fee-credentials.mjs";

const key = crypto.randomBytes(32).toString("base64url");
const gist = "a".repeat(32);

test("manager link returns only the read locator and encryption key", () => {
  const input = `https://huanwujoy-crypto.github.io/fee-console/#tok=WRITE_SECRET&gid=${gist}&k=${key}&who=Example`;
  assert.deepEqual(parseManagerLink(input), { gist, key });
  assert.equal(Object.values(parseManagerLink(input)).includes("WRITE_SECRET"), false);
});

test("untrusted destinations and duplicate or malformed link fields fail closed", () => {
  for (const input of [
    `https://example.com/fee-console/#tok=x&gid=${gist}&k=${key}`,
    `http://huanwujoy-crypto.github.io/fee-console/#tok=x&gid=${gist}&k=${key}`,
    `https://huanwujoy-crypto.github.io/fee-console/#gid=${gist}&k=${key}`,
    `https://huanwujoy-crypto.github.io/fee-console/#tok=x&gid=${gist}&gid=${gist}&k=${key}`,
    `https://huanwujoy-crypto.github.io/fee-console/#tok=x&gid=${gist}&k=bad`,
  ]) assert.throws(() => parseManagerLink(input), /MANAGER_LINK_INVALID/);
});

test("private-file setup only reads an owned, restricted regular file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fee-link-test-"));
  try {
    const link = `https://huanwujoy-crypto.github.io/fee-console/#tok=WRITE_SECRET&gid=${gist}&k=${key}`;
    const file = path.join(dir, "manager.txt");
    fs.writeFileSync(file, `${link}\n`, { mode: 0o600 });
    assert.equal(readPrivateManagerLink(file), `${link}\n`);
    fs.chmodSync(file, 0o644);
    assert.throws(() => readPrivateManagerLink(file), /MANAGER_LINK_FILE_UNSAFE/);
    fs.chmodSync(file, 0o600);
    const alias = path.join(dir, "alias.txt");
    fs.symlinkSync(file, alias);
    assert.throws(() => readPrivateManagerLink(alias), /MANAGER_LINK_FILE_UNSAFE/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});


// All new attachment tests use random secrets and synthetic encrypted fixtures.
// Fixed transport functions are exercised with mock spawn/fetch; security and
// real network are never called. Only the actual Node writer/reporter run.
import {spawnSync} from 'node:child_process';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {createLocalAttachmentRuntime,prepareLocalIbAttachment,readLocalAttachmentPlan} from './codex-fee-credentials.mjs';
import {buildFeeCalculationReceipt} from './fee-receipt-core.mjs';
import {convertEncryptedV3Copy} from './fee-econ-v3-copy.mjs';
import {createLegacyPolicy} from './fee-legacy-policy.mjs';
const CORE_ROOT=path.resolve(new URL('..',import.meta.url).pathname);
const SERVICES={key:'fee-console.codex.FEE_DATA_KEY',gist:'fee-console.codex.FEE_ECON_GIST_ID'};
const NOW=new Date('2026-10-26T12:00:00Z'),TARGET='2026-10-23',LOCATOR='00000000000000000000000000000000',HEAD='a'.repeat(40),TREE='b'.repeat(40);
const PUBLIC_API='https://api.github.com/repos/huanwujoy-crypto/fee-console';
const originalFetch=globalThis.fetch,originalSpawn=childProcess.spawnSync,originalExec=childProcess.execFileSync;
globalThis.fetch=async()=>{throw Error('REAL_NETWORK_DISABLED');};
childProcess.spawnSync=(binary,...args)=>{if(binary!==process.execPath)throw Error('REAL_SYSTEM_PROCESS_DISABLED');return originalSpawn(binary,...args);};
childProcess.execFileSync=()=>{throw Error('REAL_SYSTEM_PROCESS_DISABLED');};syncBuiltinESMExports();
test.after(()=>{globalThis.fetch=originalFetch;childProcess.spawnSync=originalSpawn;childProcess.execFileSync=originalExec;syncBuiltinESMExports();});
const digest=b=>crypto.createHash('sha256').update(b).digest('hex');
const gitBlob=b=>crypto.createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex');
const add=d=>new Date(Date.parse(d+'T00:00:00Z')+86400000).toISOString().slice(0,10);
const seal=(o,key,v)=>{const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',key,iv);return Buffer.from(JSON.stringify({enc:true,v,data:Buffer.concat([iv,c.update(JSON.stringify(o)),c.final(),c.getAuthTag()]).toString('base64')}));};
const open=(b,key)=>{const x=Buffer.from(JSON.parse(b).data,'base64'),d=crypto.createDecipheriv('aes-256-gcm',key,x.subarray(0,12));d.setAuthTag(x.subarray(-16));return JSON.parse(Buffer.concat([d.update(x.subarray(12,-16)),d.final()]));};
function fixture(t,options={}){
  const rawRoot=fs.mkdtempSync(path.join(os.tmpdir(),'ib-local-synthetic-'));fs.chmodSync(rawRoot,0o700);const root=fs.realpathSync(rawRoot);t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const key=crypto.randomBytes(32),keyText=key.toString('base64url'),calls={secrets:[],requests:[],public:[],children:[],cleanup:0},environ={};
  let economic={v:4,settings:{start:'2026-08-01',mgmt:2,carry:20,fx:{USD:1}},accounts:[{id:'schwab',opening:60},{id:'webull',opening:40}],months:[],fees:[]},legacy;
  if(options.legacy){const original={...economic,v:3,updatedAt:'2026-10-26T00:00:00Z',settings:{...economic.settings,who:'SYNTHETIC OWNER',openingAt:'2026-07-31',fx:{USD:1,HKD:1,CNY:1,EUR:1,SGD:1,GBP:1,JPY:1}},accounts:economic.accounts.map(a=>({...a,name:'SYNTHETIC '+a.id}))};legacy=seal(original,key,3);economic=open(convertEncryptedV3Copy(legacy,key,{policyId:createLegacyPolicy().LEGACY_POLICY_ID}),key);}
  const daily=[];for(let i=0,d='2026-08-01';d<=TARGET;i++,d=add(d))daily.push({d,schwab:60+i*.01,webull:40+i*.01,spy:100,qqq:100,bd:d,bstate:'session'});
  const data={daily,flowsAuto:[],flowsUnresolved:[],status:{asOf:TARGET,provisional:false,calibrated:true,unresolvedCount:0},opaqueExistingRecord:{synthetic:'must stay exactly unchanged'},feeReportPublication:{syntheticOnly:true}};
  data.feeCalculationReceipt=buildFeeCalculationReceipt({data,economicInput:economic});
  const points=daily.map((p,i)=>({d:p.d,tot:100+i*.01}));
  const ib={schema:'fee-console.ib-manager-return-input.v1',currency:'USD',timezone:'America/New_York',flowTiming:'eod',flowsComplete:true,correctionsConfirmed:true,sourceSha256:'a'.repeat(64),periodReturnsInput:{points,openT:100,from:'2026-08-01',to:TARGET,days:84,flowByDate:{},rate:0,cr:0,cumBefore:0,hwmBefore:0}};
  const write=(name,b)=>{const p=path.join(root,name);fs.writeFileSync(p,b,{mode:0o600});return {path:p,sha256:digest(Buffer.from(b))};};
  const baseData=write('base-data.json',seal(data,key,3));
  const health={schema:'fee-console.daily-health.v1',checkedAt:'2026-10-26T06:00:00.000Z',targetDate:TARGET,sourceDates:{schwab:TARGET,webull:TARGET,benchmark:TARGET},outcome:'updated',dataSha256:baseData.sha256,errorCode:null};
  const baseHealth=write('base-health.json',JSON.stringify(health,null,2)+'\n'),ibInput=write('ib-input.json',JSON.stringify(ib)),legacySource=options.legacy&&options.includeLegacy?write('original-legacy.json',legacy):null;
  const plan={schema:'fee-console.ib-local-attachment-plan.v1',targetDate:TARGET,workspace:root,baseData,baseHealth,ibInput,legacySource};
  const scripts=fs.readdirSync(path.join(CORE_ROOT,'scripts')).filter(n=>n.endsWith('.mjs')).map(n=>({path:'scripts/'+n,type:'blob',mode:'100644',sha:gitBlob(fs.readFileSync(path.join(CORE_ROOT,'scripts',n)))}));
  const tree={sha:TREE,truncated:false,tree:[...scripts,{path:'data.json',type:'blob',mode:'100644',sha:gitBlob(fs.readFileSync(baseData.path))},{path:'fee-data-health.json',type:'blob',mode:'100644',sha:gitBlob(fs.readFileSync(baseHealth.path))}]};
  options.mutateTree?.(tree);
  let fetchCount=0,refCount=0,childCount=0;
  const sealEconomic=seal(economic,key,4);
  const response=body=>new Response(JSON.stringify(body),{status:200,headers:{'content-type':'application/json',etag:'"synthetic-fixed"'}});
  const fetchMock=async(url,init)=>{
    assert.equal(init.method,'GET');assert.equal(init.redirect,'manual');assert.equal(init.credentials,'omit');assert.equal(init.headers.Authorization,undefined);
    if(String(url).startsWith(PUBLIC_API)){
      const route=String(url).slice(PUBLIC_API.length);calls.public.push(route);if(options.publicRedirect)return new Response(null,{status:302});
      if(route==='/git/ref/heads/main'){refCount++;return response({object:{sha:options.mainChanged&&refCount>1?'f'.repeat(40):HEAD}});}
      if(route==='/commits/'+HEAD)return response({sha:HEAD,author:{login:options.publicAuthor||'huanwujoy-crypto',id:options.wrongOwnerId?0:283054367},commit:{verification:{verified:!options.unverifiedMain},tree:{sha:TREE}}});
      if(route==='/git/trees/'+TREE+'?recursive=1')return response(tree);throw Error('unexpected public route');
    }
    assert.equal(String(url),'https://api.github.com/gists/'+LOCATOR);calls.requests.push({method:init.method,route:'fixed-gist-only',hasAuthorization:false});fetchCount++;
    if(options.redirect)return new Response(null,{status:302});
    const content=sealEconomic.toString(),body={id:LOCATOR,owner:{login:'huanwujoy-crypto'},public:false,truncated:false,history:[{version:options.changeSourceOnRecheck&&fetchCount>=3?'b'.repeat(40):'a'.repeat(40)}],files:{'fee-console-db.json':{filename:'fee-console-db.json',content,size:sealEconomic.length,truncated:false}}};
    options.mutateResponse?.(body);return response(body);
  };
  const spawnMock=(binary,args,opts)=>{
    assert.equal(opts.shell,false);assert.deepEqual(opts.stdio,['ignore','pipe','pipe']);assert.equal(opts.killSignal,'SIGKILL');
    if(binary==='/usr/bin/git'){
      assert.equal(opts.cwd,CORE_ROOT);assert.deepEqual(opts.env,{PATH:'/usr/bin:/bin',TMPDIR:'/tmp'});
      if(args.join(' ')==='rev-parse HEAD')return {status:0,stdout:HEAD+'\n',stderr:''};
      if(args.join(' ')==='status --porcelain --untracked-files=all')return {status:0,stdout:options.dirtyMain||(options.codeChangedDuringWriter&&childCount>0)?' M scripts/daily.mjs\n':'',stderr:''};
      throw Error('unexpected git invocation');
    }
    if(binary==='/usr/bin/security'){
      assert.equal(opts.timeout,15000);assert.equal(opts.maxBuffer,4096);assert.deepEqual(opts.env,{PATH:'/usr/bin:/bin',TMPDIR:'/tmp'});assert.deepEqual(args.slice(0,2),['find-generic-password','-s']);assert.deepEqual(args.slice(3),['-a','huanwujoy-crypto','-w']);
      const service=args[2];assert.ok(Object.values(SERVICES).includes(service));calls.secrets.push(service);
      if(options.denyService===service)return {status:1,stdout:'MOCK_SECRET_'+keyText,stderr:'MOCK_SECRET_'+keyText};
      return {status:0,stdout:service===SERVICES.key?(options.badKey?'invalid mock key':keyText+'\n'):(options.badLocator?'https://invalid.example/token':LOCATOR+'\n'),stderr:''};
    }
    assert.equal(binary,process.execPath);childCount++;assert.equal(opts.cwd,CORE_ROOT);assert.equal(opts.timeout,20000);
    const name=path.basename(args[0]);assert.ok(['daily.mjs','fee-receipt-report.mjs'].includes(name));assert.equal(args[0],path.join(CORE_ROOT,'scripts',name));
    assert.equal(opts.env.FEE_DATA_KEY,keyText);assert.equal(opts.env.NODE_OPTIONS,undefined);assert.equal(opts.env.FEE_ECON_GITHUB_TOKEN,undefined);assert.equal(opts.env.GH_TOKEN,undefined);assert.ok(!args.some(a=>a.includes(keyText)||a.includes(LOCATOR)));
    calls.children.push({name,args:args.map(a=>a.startsWith('--file=')?'--file=<private>':a.startsWith('--ib-return-input=')?'--ib-return-input=<private>':a.startsWith('--ib-return-output=')?'--ib-return-output=<private>':path.isAbsolute(a)?name:a),envNames:Object.keys(opts.env).sort()});
    if(options.noisyChild&&childCount===1)return options.noisyChild==='success'?{status:0,stdout:'IB_RETURN_ATTACHMENT_DRY_RUN_OK\n'+keyText,stderr:''}:{status:1,stdout:keyText,stderr:'MOCK_SECRET_'+LOCATOR};
    const r=spawnSync(binary,args,{...opts,env:opts.env});
    if(options.corruptCandidate&&childCount===2){const file=path.join(root,'candidate/data.json'),out=open(fs.readFileSync(file),key);out.opaqueExistingRecord.synthetic='changed';fs.writeFileSync(file,seal(out,key,3));}
    if(options.mutateInput&&childCount===1)fs.appendFileSync(ibInput.path,' ');
    if(options.reporterFail&&name==='fee-receipt-report.mjs')return {status:1,stdout:keyText,stderr:'MOCK_PRIVATE_AMOUNT'};
    if(options.badOutputMode&&childCount===2)fs.chmodSync(path.join(root,'candidate/data.json'),0o644);
    if(options.symlinkOutput&&childCount===2){fs.unlinkSync(path.join(root,'candidate/data.json'));fs.symlinkSync(baseData.path,path.join(root,'candidate/data.json'));}
    if(options.unexpectedOutput&&childCount===2)fs.writeFileSync(path.join(root,'candidate/user-owned.txt'),'preserve me');
    return r;
  };
  const actual=createLocalAttachmentRuntime({spawnImpl:spawnMock,fetchImpl:fetchMock,now:()=>NOW,platform:'darwin'});
  const runtime={...actual,async acquireEconomic(...args){const s=await actual.acquireEconomic(...args);return {...s,cleanup(){calls.cleanup++;s.cleanup();if(options.cleanupFail)throw Error('MOCK_SECRET_'+keyText);if(options.mutateAfterCleanup)fs.appendFileSync(baseData.path,' ');}};}};
  return {root,key,keyText,data,economic,health,plan,runtime,environ,calls,tree,sealEconomic,write};
}

const execute=f=>prepareLocalIbAttachment({plan:f.plan,environ:f.environ,runtime:f.runtime});
async function refused(f,pattern){let error;try{await execute(f);assert.fail('must refuse');}catch(e){error=e;}assert.match(error.message,pattern||/^IB_LOCAL_/);assert.ok(!String(error).includes(f.keyText));assert.ok(!String(error).includes(LOCATOR));assert.equal(fs.existsSync(path.join(f.root,'candidate/fee-data-health.json')),false);return error;}

test('actual writer/reporter and source inspector stage a private candidate with no health/publication claim',async t=>{
  const f=fixture(t),base=fs.readFileSync(f.plan.baseData.path),health=fs.readFileSync(f.plan.baseHealth.path),input=fs.readFileSync(f.plan.ibInput.path),r=await execute(f);
  assert.equal(r.status,'IB_LOCAL_ATTACHMENT_STAGED_HEALTH_PENDING');assert.equal(r.healthCreated,false);assert.equal(r.publicationReady,false);
  assert.deepEqual(f.calls.secrets,[SERVICES.key,SERVICES.gist]);assert.equal(f.calls.requests.length,4);assert.equal(f.calls.cleanup,1);assert.equal(f.calls.children.length,3);
  assert.deepEqual(f.calls.children.map(c=>c.name),['daily.mjs','daily.mjs','fee-receipt-report.mjs']);assert.ok(f.calls.children[2].args.includes('--format=validate'));
  const file=path.join(f.root,'candidate/data.json'),after=open(fs.readFileSync(file),f.key),strip=o=>Object.fromEntries(Object.entries(o).filter(([k])=>!['ibManagerReturnReceipt','ibManagerDrawdownReceipt'].includes(k)));
  assert.deepEqual(strip(after),f.data);assert.deepEqual(after.feeCalculationReceipt,f.data.feeCalculationReceipt);assert.ok(after.ibManagerReturnReceipt);assert.ok(after.ibManagerDrawdownReceipt);
  assert.deepEqual(fs.readFileSync(f.plan.baseData.path),base);assert.deepEqual(fs.readFileSync(f.plan.baseHealth.path),health);assert.deepEqual(fs.readFileSync(f.plan.ibInput.path),input);
  assert.equal(fs.statSync(file).mode&0o777,0o600);assert.equal(fs.statSync(path.dirname(file)).mode&0o777,0o700);assert.equal(fs.statSync(path.join(f.root,'candidate/validation.json')).mode&0o777,0o600);
  assert.deepEqual(fs.readdirSync(path.dirname(file)).sort(),['data.json','validation.json']);assert.ok(!JSON.stringify(r).includes(f.keyText));assert.ok(!JSON.stringify(r).includes(LOCATOR));
  assert.equal(fs.readdirSync(f.root).some(n=>n.startsWith('fee-economic-source-')),false);
});
test('replay cannot overwrite an existing private candidate and reads no key',async t=>{const f=fixture(t);await execute(f);const before=fs.readFileSync(path.join(f.root,'candidate/data.json'));f.calls.secrets=[];await refused(f,/IB_LOCAL_OUTPUT/);assert.deepEqual(f.calls.secrets,[]);assert.deepEqual(fs.readFileSync(path.join(f.root,'candidate/data.json')),before);});
test('fixed service and source requests cannot be broadened',async()=>{const r=createLocalAttachmentRuntime({spawnImpl(){throw Error('must not spawn');}});assert.throws(()=>r.readKeychain('unrelated-service'),/KEYCHAIN/);await assert.rejects(()=>r.publicRead('https://invalid.example'),/PUBLIC_BASE/);});
for(const [name,change] of [
 ['self-approval rejected',f=>f.plan.approved=true],['style claim rejected',f=>f.plan.stylePreflight='pass'],['different target',f=>f.plan.targetDate='2026-10-26'],['new service override',f=>f.plan.service='unrelated'],['new URL override',f=>f.plan.url='https://invalid.example'],['mode escalation',f=>f.plan.mode='real'],['live adapter',f=>f.runtime={...f.runtime,platform:'linux'}],['Actions refused',f=>f.environ.GITHUB_ACTIONS='true'],['review lock changed',f=>f.tree.tree.find(r=>r.path==='scripts/daily.mjs').sha='f'.repeat(40)],['private input permissions',f=>fs.chmodSync(f.plan.ibInput.path,0o644)],['private directory permissions',f=>fs.chmodSync(f.root,0o755)],['input hash changed',f=>fs.appendFileSync(f.plan.ibInput.path,' ')],['stale health',f=>{f.health.checkedAt='2026-10-23T20:00:00Z';f.plan.baseHealth=f.write('base-health.json',JSON.stringify(f.health,null,2)+'\n');}],['health hash wrong',f=>{f.health.dataSha256='f'.repeat(64);f.plan.baseHealth=f.write('base-health.json',JSON.stringify(f.health,null,2)+'\n');}],['future health',f=>{f.health.checkedAt='2026-10-27T06:00:00Z';f.plan.baseHealth=f.write('base-health.json',JSON.stringify(f.health,null,2)+'\n');}],['health extra authority field',f=>{f.health.sourceVerified=true;f.plan.baseHealth=f.write('base-health.json',JSON.stringify(f.health,null,2)+'\n');}],
])test('before secrets: '+name,async t=>{const f=fixture(t);change(f);await refused(f);assert.equal(f.calls.secrets.length,0);assert.equal(f.calls.children.length,0);});
for(const [name,options,wantSecrets] of [
 ['key access denied',{denyService:SERVICES.key},1],['gist access denied',{denyService:SERVICES.gist},2],['bad key stops before locator',{badKey:true},1],['malformed locator',{badLocator:true},2],['source redirects',{redirect:true},2],['source owner mismatch',{mutateResponse:b=>b.owner.login='other'},2],['public source refused',{mutateResponse:b=>b.public=true},2],['truncated source refused',{mutateResponse:b=>b.truncated=true},2],
])test('failure stops without raw secret logs: '+name,async t=>{const f=fixture(t,options);await refused(f);assert.equal(f.calls.secrets.length,wantSecrets);assert.equal(f.calls.children.length,0);assert.equal(fs.existsSync(path.join(f.root,'candidate')),false);});
for(const [name,options] of [['child error contains canary',{noisyChild:true}],['extra success output refused',{noisyChild:'success'}],['output permissions broadened',{badOutputMode:true}],['input changes during writer',{mutateInput:true}],['non-IB mutation',{corruptCandidate:true}],['reporter fails',{reporterFail:true}],['remote revision changes after staging',{changeSourceOnRecheck:true}],['source cleanup fails',{cleanupFail:true}],['input changes at cleanup',{mutateAfterCleanup:true}]])test('late failure removes only the new candidate: '+name,async t=>{const f=fixture(t,options);await refused(f);assert.equal(fs.existsSync(path.join(f.root,'candidate')),false);assert.equal(f.calls.cleanup,1);});
test('symlink input is rejected before opening target or reading keys',async t=>{const f=fixture(t),p=f.plan.ibInput.path;fs.renameSync(p,p+'.original');fs.symlinkSync(p+'.original',p);await refused(f,/PRIVATE_FILE/);assert.equal(f.calls.secrets.length,0);assert.ok(fs.existsSync(p+'.original'));});
test('authentic legacy source is not synthesized from the embedded copy',async t=>{const f=fixture(t,{legacy:true});await refused(f,/LEGACY_SOURCE/);assert.equal(f.calls.children.length,0);assert.equal(fs.existsSync(path.join(f.root,'original-legacy.json')),false);});
test('separately supplied synthetic original legacy source preserves its genuine guard',async t=>{const f=fixture(t,{legacy:true,includeLegacy:true});const bytes=fs.readFileSync(f.plan.legacySource.path),r=await execute(f);assert.equal(r.publicationReady,false);assert.deepEqual(fs.readFileSync(f.plan.legacySource.path),bytes);});
test('CLI rejects malformed local plans without exposing the supplied path or reading credentials',()=>{
  for(const file of ['relative-file','/nonexistent/synthetic-plan.json']){const r=spawnSync(process.execPath,[path.join(CORE_ROOT,'scripts/codex-fee-credentials.mjs'),'attach-ib',file],{encoding:'utf8',env:{PATH:path.dirname(process.execPath)+':/usr/bin:/bin'}});assert.equal(r.status,1);assert.match(r.stderr,/^CODEX_FEE_SETUP_FAILED:(IB_LOCAL_PLAN|SOURCE_CHECK_FAILED)\n$/);assert.equal(r.stdout,'');assert.ok(!r.stderr.includes(file));}
});

test('unknown output is preserved for review rather than deleting user content',async t=>{const f=fixture(t,{unexpectedOutput:true});await refused(f,/CLEANUP/);assert.equal(fs.existsSync(path.join(f.root,'candidate/data.json')),false);assert.equal(fs.readFileSync(path.join(f.root,'candidate/user-owned.txt'),'utf8'),'preserve me');});
test('symlink output cannot cause an original file to be read or removed',async t=>{const f=fixture(t,{symlinkOutput:true}),base=fs.readFileSync(f.plan.baseData.path);await refused(f,/CLEANUP/);assert.deepEqual(fs.readFileSync(f.plan.baseData.path),base);});
test('child environment excludes tracing/preloads and unrelated tokens',async t=>{const f=fixture(t);f.environ={NODE_OPTIONS:'--import=must-not-load',GH_TOKEN:'mock-token-canary',FEE_ECON_GITHUB_TOKEN:'mock-token-canary'};await refused(f,/LOCAL_ONLY/);assert.equal(f.calls.secrets.length,0);assert.equal(f.calls.children.length,0);});

for(const [name,options] of [
 ['unmerged or dirty code',{dirtyMain:true}],['unsigned main',{unverifiedMain:true}],['wrong main author',{publicAuthor:'other'}],['wrong immutable owner identity',{wrongOwnerId:true}],['redirected public metadata',{publicRedirect:true}],
 ['truncated public tree',{mutateTree:t=>t.truncated=true}],['duplicate public path',{mutateTree:t=>t.tree.push(t.tree[0])}],['wrong base ciphertext',{mutateTree:t=>t.tree.find(f=>f.path==='data.json').sha='f'.repeat(40)}],['wrong base health',{mutateTree:t=>t.tree.find(f=>f.path==='fee-data-health.json').sha='f'.repeat(40)}],['unsafe script mode',{mutateTree:t=>t.tree.find(f=>f.path==='scripts/daily.mjs').mode='120000'}],
])test('public code and base binding before secrets: '+name,async t=>{const f=fixture(t,options);await refused(f);assert.equal(f.calls.secrets.length,0);assert.equal(f.calls.children.length,0);});
test('changed public main at final recheck discards candidate',async t=>{const f=fixture(t,{mainChanged:true});await refused(f,/PUBLIC_BASE/);assert.equal(fs.existsSync(path.join(f.root,'candidate')),false);});
test('dirty code during writer discards candidate without touching source code',async t=>{const f=fixture(t,{codeChangedDuringWriter:true});await refused(f,/CODE_CHANGED/);assert.equal(fs.existsSync(path.join(f.root,'candidate')),false);});
test('four UTC day window is enforced before public or private access',async t=>{const f=fixture(t);f.runtime={...f.runtime,now:()=>new Date('2026-10-28T00:00:00Z')};await refused(f,/WINDOW/);assert.equal(f.calls.secrets.length,0);assert.equal(f.calls.public.length,0);});
test('private plan has strict permissions, duplicate-key parsing and use-time binding',t=>{
 const f=fixture(t),p=path.join(f.root,'plan.json');fs.writeFileSync(p,JSON.stringify(f.plan),{mode:0o600});const r=readLocalAttachmentPlan(p);assert.deepEqual(r.plan,f.plan);fs.appendFileSync(p,' ');assert.throws(r.check,/INPUT_CHANGED/);
 fs.writeFileSync(p,'{"schema":1,"schema":2}');assert.throws(()=>readLocalAttachmentPlan(p));fs.writeFileSync(p,JSON.stringify(f.plan));fs.chmodSync(p,0o644);assert.throws(()=>readLocalAttachmentPlan(p),/PRIVATE_FILE/);
});
test('diagnostics and preloads are refused before any private access',async t=>{
 const f=fixture(t),old=[...process.execArgv];try{for(const flag of ['--inspect','--inspect-brk=0','--import=untrusted','--require=untrusted','--cpu-prof','--heap-prof','--heapsnapshot-near-heap-limit=1']){process.execArgv.splice(0,process.execArgv.length,...old,flag);await refused(f,/LOCAL_ONLY/);assert.equal(f.calls.secrets.length,0);assert.equal(f.calls.public.length,0);}}finally{process.execArgv.splice(0,process.execArgv.length,...old);}
});
