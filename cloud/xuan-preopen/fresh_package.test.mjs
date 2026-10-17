// Actual read-only CLI in a wholly synthetic local package. These tests never
// load a real private binding, credential, historical record or live executor.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const run=promisify(execFile),PREFIX='maintenance/ib-orders-fresh-execution-v1';
const BUNDLE=fileURLToPath(new URL('../../'+PREFIX+'/',import.meta.url));
const ENTRY='xuan-ib-orders-fresh.mjs',BASENAME='execution-manifest.NOT-APPROVED.json';
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const json=x=>Buffer.from(JSON.stringify(x)+'\n');
const canonical=x=>Array.isArray(x)?'['+x.map(canonical).join(',')+']':x&&typeof x==='object'?'{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')+'}':JSON.stringify(x);
const uuid=n=>`70000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const source=await fs.readFile(path.join(BUNDLE,ENTRY),'utf8');
const lists=[...source.matchAll(/export const CODE_FILES=Object\.freeze\(\[([\s\S]*?)\]\);/g)];
assert.equal(lists.length,1,'EXACTLY_ONE_ACTUAL_CODE_FILE_LIST');
const FILES=[...lists[0][1].matchAll(/'([^']+)'/g)].map(m=>m[1]);
assert.equal(FILES.length,9);assert.equal(new Set(FILES).size,9);
assert.ok(FILES.every(n=>!n.startsWith('/')&&!n.split('/').includes('..')));
const SOURCES=new Map(await Promise.all(FILES.map(async n=>[n,await fs.readFile(path.join(BUNDLE,n))])));
const childEnv={PATH:'/usr/bin:/bin',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0'};

async function write(n,b,mode=0o600){await fs.mkdir(path.dirname(n),{recursive:true,mode:0o700});await fs.writeFile(n,b,{mode});await fs.chmod(n,mode);}
async function git(repo,args){return (await run('/usr/bin/git',args,{cwd:repo,env:childEnv,encoding:'utf8',maxBuffer:2000000})).stdout.trim();}
async function absent(n){await assert.rejects(fs.lstat(n),e=>e.code==='ENOENT');}

// The preload changes no product bytes or branches. It denies acquisition of
// native effects, records actual Git reads, and prevents reading any real home,
// SDK or private file. It is passed as a Node option, outside the CLI's 7 args.
function guardSource(allowedFiles,allowedDirs,historyDirs,here){return `
import fs from 'node:fs';
import cp from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import dgram from 'node:dgram';
import dns from 'node:dns';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {syncBuiltinESMExports} from 'node:module';
const allowedFiles=new Set(${JSON.stringify(allowedFiles)}),allowedDirs=new Set(${JSON.stringify(allowedDirs)}),historyDirs=new Set(${JSON.stringify(historyDirs)});
const moduleFiles=new Set(${JSON.stringify(FILES.map(n=>path.join(here,n)))});
const observed={git:[],reads:[],stats:[],names:[],denied:[]},here=${JSON.stringify(here)};
const key=n=>n instanceof URL?fileURLToPath(n):typeof n==='string'?path.resolve(n):String(n);
const deny=kind=>(...args)=>{observed.denied.push(kind);throw Error('PACKAGE_TEST_EFFECT_DENIED:'+kind);};
const promises=fs.promises;
for(const [method,allowed,log]of [['readFile',allowedFiles,'reads'],['lstat',new Set([...allowedFiles,...allowedDirs]),'stats'],['readdir',historyDirs,'names']]){
  const original=promises[method].bind(promises);promises[method]=async(n,...args)=>{const p=key(n);if(!allowed.has(p))return deny('fs.'+method+':'+p)();observed[log].push(p);return original(n,...args);};
}
for(const method of ['open','writeFile','appendFile','mkdir','mkdtemp','rm','rmdir','unlink','rename','copyFile','cp','chmod','chown','symlink','link','truncate','utimes'])promises[method]=deny('fs.promises.'+method);
// Node's ESM loader may use synchronous reads after --import. Only the nine
// copied public modules may take that path; package/history reads stay async.
const readFileSync=fs.readFileSync.bind(fs),openSync=fs.openSync.bind(fs);
fs.readFileSync=(n,...args)=>{if(!moduleFiles.has(key(n)))return deny('fs.readFileSync:'+key(n))();return readFileSync(n,...args);};
fs.openSync=(n,flags,...args)=>{if(!moduleFiles.has(key(n))||!['r',0].includes(flags))return deny('fs.openSync:'+key(n))();return openSync(n,flags,...args);};
for(const method of ['readFile','open','writeFile','writeFileSync','appendFile','appendFileSync','mkdir','mkdirSync','rm','rmSync','unlink','unlinkSync','rename','renameSync','createReadStream','createWriteStream'])fs[method]=deny('fs.'+method);
const originalExecFile=cp.execFile.bind(cp);
cp.execFile=(exe,args,options,callback)=>{
  const a=args.slice(2);
  const basic=[['rev-parse','--show-toplevel'],['status','--porcelain','--untracked-files=all'],['rev-parse','--verify','HEAD'],['rev-parse','--verify','HEAD^{tree}']];
  const same=(x,y)=>JSON.stringify(x)===JSON.stringify(y);
  const relative=n=>${JSON.stringify(FILES.map(n=>PREFIX+'/'+n))}.includes(n);
  const ls=a.length===5&&same(a.slice(0,4),['ls-tree','--full-tree','HEAD','--'])&&relative(a[4]);
  const show=a.length===2&&a[0]==='show'&&a[1].startsWith('HEAD:')&&relative(a[1].slice(5));
  if(exe!=='/usr/bin/git'||!Array.isArray(args)||!same(args.slice(0,2),['-c','core.fsmonitor=false'])||!basic.some(x=>same(x,a))&&!ls&&!show||options.cwd!==here||same(options.env,{PATH:'/usr/bin:/bin',GIT_OPTIONAL_LOCKS:'0'})!==true||options.maxBuffer!==2000000||options.encoding!==(show?'buffer':'utf8'))return deny('child_process.execFile')();
  observed.git.push({args:a,encoding:options.encoding});return originalExecFile(exe,args,options,callback);
};
for(const method of ['spawn','spawnSync','fork','exec','execSync','execFileSync'])cp[method]=deny('child_process.'+method);
for(const [name,mod,methods]of [['http',http,['request','get','createServer']],['https',https,['request','get','createServer']],['net',net,['connect','createConnection','createServer']],['tls',tls,['connect','createServer']],['dgram',dgram,['createSocket']],['dns',dns,['lookup','resolve']]])for(const method of methods)mod[method]=deny(name+'.'+method);
globalThis.fetch=deny('fetch');syncBuiltinESMExports();
process.once('exit',()=>process.stderr.write('PACKAGE_TEST_GUARD '+JSON.stringify(observed)+'\\n'));
`;}

async function fixture(t,{nodeVersion=process.versions.node,nodeDrift=false,pythonPinMismatch=false,badAbsence=null}={}){
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'fresh package actual CLI ')));await fs.chmod(root,0o700);
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const repo=path.join(root,'synthetic repository with spaces'),here=path.join(repo,PREFIX),pkg=path.join(root,'private package');
  await fs.mkdir(here,{recursive:true,mode:0o755});await fs.mkdir(pkg,{mode:0o700});
  const bin=path.join(root,'executables'),sdkRoot=path.join(root,'fake sdk'),external=path.join(root,'ordinary external pins');
  await fs.mkdir(bin,{mode:0o700});await fs.mkdir(sdkRoot,{mode:0o700});await fs.mkdir(external,{mode:0o700});
  let node=process.execPath;const nodeStat=await fs.lstat(node),nodeDir=await fs.lstat(path.dirname(node));
  if(nodeStat.isSymbolicLink()||nodeStat.uid!==process.getuid()||nodeDir.uid!==process.getuid()||(nodeStat.mode&0o777)!==0o755){
    node=path.join(bin,'node');await fs.copyFile(process.execPath,node);await fs.chmod(node,0o755);
  }
  const pinnedNode=nodeDrift?path.join(bin,'different-node'):node;
  if(nodeDrift){await fs.copyFile(node,pinnedNode);await fs.chmod(pinnedNode,0o755);}
  const python=path.join(bin,'python-never-run');await write(python,'#!/bin/sh\nexit 93\n',0o755);
  const sdkVersion=path.join(sdkRoot,'VERSION'),sdkCredential=path.join(sdkRoot,'credential-source.py'),driver=path.join(external,'historical-driver.mjs'),bridge=path.join(external,'historical-bridge.mjs');
  await write(sdkVersion,'synthetic-sdk-version\n');await write(sdkCredential,'# synthetic SDK source; not imported\n');
  await write(driver,'// synthetic historical provenance only\n');await write(bridge,'// synthetic historical bridge only\n');
  const approvalDirectory=path.join(root,'approval-must-not-exist'),runtime=path.join(root,'runtime-must-not-exist');
  const records={},names={};
  for(let d=0;d<3;d++){
    const dir=path.join(root,'historical safe group '+d);names[dir]=[];
    for(let i=0;i<5;i++){
      const name=String(i).padStart(4,'0')+'.safe.json',n=path.join(dir,name),b=json({synthetic:true,group:d,sequence:i});
      await write(n,b);records[n]=sha(b);names[dir].push(name);
    }
  }
  const externalPins={};for(const n of [pinnedNode,python,sdkVersion,sdkCredential,driver,bridge])externalPins[n]=sha(await fs.readFile(n));
  const binding={spec:'IB-ORDERS-FRESH-PRIVATE-BINDING-v1',candidate:here,approvalDirectory,approvalPath:approvalDirectory+'/fresh.approval.json',
    fresh:{spec:'IB-ORDERS-FRESH-EXECUTION-v1',operationId:uuid(1),authorizationId:uuid(2),requestId:uuid(3),unusedRequestId:uuid(4),runtime},
    fixed:{source:here+'/source',head:'1'.repeat(40),tree:'2'.repeat(40),image:'synthetic.invalid/image@sha256:'+'3'.repeat(64),
      redirectUri:'http://127.0.0.1:54868/oauth/ib/callback',project:'synthetic-project',region:'synthetic-region',secret:'projects/synthetic-project/secrets/synthetic-secret',
      job:'synthetic-probe',sourceSa:'synthetic-source@synthetic.invalid',bucket:'synthetic-private',operatorAccountSha256:sha('synthetic-operator'),python,gh:python,sdkRoot,
      consumerJobs:['synthetic-probe','synthetic-report','synthetic-check','synthetic-source'],eodJobs:['synthetic-eod-a','synthetic-eod-b'],schedulers:['synthetic-clock','synthetic-watch'],command:['node','synthetic-probe.mjs']},
    dependencies:{node:nodeVersion,python:'synthetic-never-executed',googleCloudSdk:'synthetic-never-imported',nodeExecutable:pinnedNode,pythonExecutable:python,sdkCredentialSourceSha256:externalPins[sdkCredential]},
    externalPins,previousRecords:records,previousNames:names,previousDigest:sha(canonical({records,names}))};
  if(badAbsence){
    const regular=path.join(root,'regular-file-parent');await write(regular,'synthetic non-directory\n');
    if(badAbsence==='approval'){binding.approvalDirectory=regular+'/absent';binding.approvalPath=binding.approvalDirectory+'/fresh.approval.json';}
    else binding.fresh.runtime=regular+'/absent';
  }
  const rawBinding=json(binding),bindingSha=sha(rawBinding),bindingPath=path.join(pkg,'private-binding.json');await write(bindingPath,rawBinding);
  for(const n of FILES){
    let b=SOURCES.get(n);
    if(n==='binding.mjs'||n==='renew.py'){
      let count=0;const pattern=n==='binding.mjs'?/^(export const PRIVATE_BINDING_SHA256=)'[a-f0-9]{64}';$/gm:/^(PRIVATE_BINDING_SHA256=)'[a-f0-9]{64}'$/gm;
      b=Buffer.from(b.toString().replace(pattern,(_all,prefix)=>{count++;return prefix+"'"+(n==='renew.py'&&pythonPinMismatch?'0'.repeat(64):bindingSha)+"'"+(n==='binding.mjs'?';':'');}));
      assert.equal(count,1,'ONLY_THE_TWO_COMMITMENT_LITERALS_CHANGE:'+n);
    }
    await write(path.join(here,n),b,0o644);
  }
  await git(repo,['init','--quiet']);
  for(const [k,v]of [['user.name','Synthetic Package Test'],['user.email','synthetic-package-test@example.invalid'],['commit.gpgsign','false'],['core.hooksPath','/dev/null'],['core.fsmonitor','false'],['core.fileMode','true'],['core.autocrlf','false']])await git(repo,['config','--local',k,v]);
  await git(repo,['add','--',PREFIX]);await git(repo,['commit','--quiet','-m','synthetic read-only package fixture']);
  assert.equal(await git(repo,['remote']), '');
  const head=await git(repo,['rev-parse','HEAD']),tree=await git(repo,['rev-parse','HEAD^{tree}']);
  const files=Object.fromEntries(await Promise.all(FILES.map(async n=>[n,sha(await fs.readFile(path.join(here,n)))])));
  // Import the actual pure builder rather than copying its manifest algorithm.
  const build=`import fs from 'node:fs/promises';import {pathToFileURL} from 'node:url';const [bindingPath,entryPath,files,identity]=process.argv.slice(1);const b=await import(pathToFileURL(entryPath.replace(/[^/]+$/,'binding.mjs')));const e=await import(pathToFileURL(entryPath));const binding=b.validatePrivateBinding(await fs.readFile(bindingPath));process.stdout.write(JSON.stringify(e.buildOfflineManifest(binding,JSON.parse(files),JSON.parse(identity)))+'\\n');`;
  const entry=path.join(here,ENTRY),built=await run(node,['--input-type=module','-e',build,bindingPath,entry,JSON.stringify(files),JSON.stringify({head,tree})],{cwd:root,env:childEnv,encoding:'utf8',maxBuffer:2000000});
  const manifest=JSON.parse(built.stdout),manifestPath=path.join(pkg,BASENAME);await write(manifestPath,json(manifest));
  const allowedFiles=[bindingPath,manifestPath,...FILES.map(n=>path.join(here,n)),...Object.keys(records),...Object.keys(externalPins)];
  const allowedDirs=[...new Set(allowedFiles.map(n=>path.dirname(n)))].concat(binding.approvalDirectory,binding.fresh.runtime);
  const guard=path.join(root,'read-only-guard.mjs');await write(guard,guardSource(allowedFiles,allowedDirs,Object.keys(names),here));
  const args=()=>['--verify-package','--binding',bindingPath,'--manifest',manifestPath,'--manifest-sha256',sha(json(manifest))];
  async function cli(argv=args()){
    assert.equal(argv[0],'--verify-package','THE_TEST_NEVER_REQUESTS_EXECUTION');
    let result;try{result=await run(node,['--import',pathToFileURL(guard).href,entry,...argv],{cwd:root,env:{...childEnv,HOME:root},encoding:'utf8',maxBuffer:2000000,timeout:20000});}
    catch(e){if(typeof e.code!=='number')throw e;result={stdout:e.stdout,stderr:e.stderr,code:e.code};}
    const lines=result.stderr.split('\n').filter(s=>s.startsWith('PACKAGE_TEST_GUARD '));assert.equal(lines.length,1,'GUARD_RAN_ON_ACTUAL_CLI');
    const observed=JSON.parse(lines[0].slice('PACKAGE_TEST_GUARD '.length));assert.deepEqual(observed.denied,[],'NO_FORBIDDEN_EFFECT_OR_PRIVATE_READ_ATTEMPT');
    const value=JSON.parse(result.stdout);assert.equal(value.liveActions,0);assert.notEqual(value.executionAuthorization,true);
    return {value,observed,exitCode:result.code??0};
  }
  return {root,repo,here,pkg,node,binding,bindingPath,bindingSha,manifest,manifestPath,files,head,tree,args,cli,
    async persist(){await write(manifestPath,json(manifest));},
    async ensureFresh(){await absent(binding.approvalDirectory);await absent(binding.fresh.runtime);assert.equal(await git(repo,['status','--porcelain','--untracked-files=all']),'');}};
}

function stopped(r,code){assert.equal(r.exitCode,1);assert.equal(r.value.status,'stopped');assert.equal(r.value.code,code);}

test('actual read-only package CLI admits one complete synthetic default package',async t=>{
  const f=await fixture(t),r=await f.cli();assert.equal(r.exitCode,0);
  assert.equal(r.value.status,'verified-package');assert.equal(r.value.readOnly,true);
  for(const k of ['executionAuthorization','humanProofVerified','claimVerified','liveAdmissionVerified'])assert.equal(r.value[k],false,k);
  assert.deepEqual(r.value.code,{head:f.head,tree:f.tree,files:f.files,privateBindingSha256:f.bindingSha});
  assert.equal(r.value.manifestSha256,sha(await fs.readFile(f.manifestPath)));
  assert.deepEqual(r.value.checked,{runtimeFiles:9,externalPins:6,historicalRecords:15,historicalDirectories:3,nativeNodeIdentity:true,dualBindingPins:true,approvalDirectoryAbsent:true,runtimeAbsent:true});
  assert.equal(r.value.validFromUtc,null);assert.equal(r.value.validUntilUtc,null);assert.equal(r.value.automaticRetry,false);
  assert.equal(r.observed.git.length,22);assert.equal(r.observed.git.filter(c=>c.args.includes('ls-tree')).length,9);
  assert.equal(r.observed.git.filter(c=>c.args[0]==='show'&&c.encoding==='buffer').length,9);
  for(const n of FILES)assert.ok(r.observed.reads.includes(path.join(f.here,n)),n);
  for(const n of [...Object.keys(f.binding.previousRecords),...Object.keys(f.binding.externalPins)])assert.ok(r.observed.reads.includes(n),n);
  assert.deepEqual([...r.observed.names].sort(),Object.keys(f.binding.previousNames).sort());await f.ensureFresh();
});

test('actual CLI rejects malformed arguments and a wrong manifest byte hash',async t=>{
  const f=await fixture(t),base=f.args();
  const variants=[['missing hash value',base.slice(0,-1)],['extra argument',[...base,'--unexpected']],['wrong flag',base.map((x,i)=>i===3?'--approval':x)],['reordered flags',[base[0],base[3],base[4],base[1],base[2],base[5],base[6]]],['invalid digest',base.map((x,i)=>i===6?'not-a-sha256':x)]];
  for(const [name,args]of variants)await t.test(name,async()=>{const r=await f.cli(args);stopped(r,'REQUEST_INVALID');assert.equal(r.observed.git.length,0);});
  await t.test('correct shape with wrong raw digest',async()=>{const r=await f.cli(base.map((x,i)=>i===6?'f'.repeat(64):x));stopped(r,'PACKAGE_MANIFEST_INVALID');assert.equal(r.observed.git.length,0);});
  await f.ensureFresh();
});

test('actual CLI requires the complete unapproved default manifest',async t=>{
  const f=await fixture(t),original=structuredClone(f.manifest);
  const variants=[['approved flag',a=>a.approved=true],['live flag',a=>a.liveActionsApproved=true],['grant flag',a=>a.finalApproval.granted=true],
    ['window',a=>{a.validFromUtc='2031-05-06T10:00:00.000Z';a.validUntilUtc='2031-05-06T10:30:00.000Z';}],['proof',a=>a.proofHashes.manualHold='a'.repeat(64)],
    ['scope digest',a=>a.finalApproval.scopeSha256='a'.repeat(64)],['different operation ID',a=>a.operationId=uuid(99)],['Google renewal one',a=>a.googleSession.normalRenewalMaximum=1],
    ['budget increase',a=>a.registrationBudget.additionalMax=2],['missing default field',a=>delete a.precedingVersionMetadataOnly],['extra field',a=>a.testOnly=true]];
  for(const [name,change]of variants)await t.test(name,async()=>{
    Object.keys(f.manifest).forEach(k=>delete f.manifest[k]);Object.assign(f.manifest,structuredClone(original));change(f.manifest);await f.persist();
    stopped(await f.cli(),'PACKAGE_MANIFEST_INVALID');await f.ensureFresh();
  });
});

test('actual CLI detects source, external pin and history drift before any claim',async t=>{
  const f=await fixture(t);
  await t.test('untracked root file makes repository dirty',async()=>{const n=path.join(f.repo,'untracked synthetic root');await write(n,'dirty\n');try{stopped(await f.cli(),'CODE_MISMATCH');}finally{await fs.unlink(n);}});
  await t.test('tracked namespace change makes repository dirty',async()=>{const n=path.join(f.here,'renew.py'),b=await fs.readFile(n);await fs.appendFile(n,'\n# synthetic dirty change\n');try{stopped(await f.cli(),'CODE_MISMATCH');}finally{await fs.writeFile(n,b);}});
  await t.test('ordinary external pin bytes drift',async()=>{const n=Object.keys(f.binding.externalPins).find(n=>n.endsWith('historical-driver.mjs')),b=await fs.readFile(n);await fs.appendFile(n,'// changed\n');try{stopped(await f.cli(),'CODE_MISMATCH');}finally{await fs.writeFile(n,b);}});
  await t.test('historical bytes drift',async()=>{const n=Object.keys(f.binding.previousRecords)[0],b=await fs.readFile(n);await fs.appendFile(n,' ');try{stopped(await f.cli(),'PREVIOUS_RECORDS_MISMATCH');}finally{await fs.writeFile(n,b);}});
  await t.test('historical directory gains an unpinned name',async()=>{const n=path.join(Object.keys(f.binding.previousNames)[0],'unexpected.safe.json');await write(n,'{}\n');try{stopped(await f.cli(),'PREVIOUS_RECORDS_MISMATCH');}finally{await fs.unlink(n);}});
  await f.ensureFresh();
});

test('actual CLI requires a private fixed-name control package',async t=>{
  const f=await fixture(t);
  await t.test('other basename rejects before reading it',async()=>{const args=f.args();args[4]=path.join(f.pkg,'other.NOT-APPROVED.json');const r=await f.cli(args);stopped(r,'REQUEST_INVALID');assert.equal(r.observed.git.length,0);});
  await t.test('manifest mode must be 0600',async()=>{await fs.chmod(f.manifestPath,0o644);try{stopped(await f.cli(),'PRIVATE_FILE_INVALID');}finally{await fs.chmod(f.manifestPath,0o600);}});
  await t.test('package mode must be 0700',async()=>{await fs.chmod(f.pkg,0o755);try{stopped(await f.cli(),'PRIVATE_BINDING_INVALID');}finally{await fs.chmod(f.pkg,0o700);}});
  await t.test('binding raw bytes must match both commitments',async()=>{const b=await fs.readFile(f.bindingPath);await fs.appendFile(f.bindingPath,' ');try{stopped(await f.cli(),'PRIVATE_BINDING_INVALID');}finally{await fs.writeFile(f.bindingPath,b);}});
  await f.ensureFresh();
});

test('actual CLI refuses existing approval or runtime without creating either',async t=>{
  const f=await fixture(t);
  for(const [name,n]of [['approval directory',f.binding.approvalDirectory],['runtime directory',f.binding.fresh.runtime]])await t.test(name,async()=>{
    await fs.mkdir(n,{mode:0o700});try{stopped(await f.cli(),'PACKAGE_PATHS_NOT_FRESH');assert.deepEqual(await fs.readdir(n),[]);}finally{await fs.rmdir(n);}
  });
  await f.ensureFresh();
});

for(const location of ['approval','runtime'])test('actual CLI refuses '+location+' absence lookup errors other than ENOENT',async t=>{
  const f=await fixture(t,{badAbsence:location});stopped(await f.cli(),'PACKAGE_PATHS_NOT_FRESH');assert.equal(await git(f.repo,['status','--porcelain','--untracked-files=all']),'');
});

test('actual CLI rejects a clean Git package with a mismatched Python binding pin',async t=>{
  const f=await fixture(t,{pythonPinMismatch:true});stopped(await f.cli(),'CODE_MISMATCH');await f.ensureFresh();
});

test('actual CLI verifies the actual Node version rather than the manifest assertion',async t=>{
  const f=await fixture(t,{nodeVersion:'0.0.0-synthetic-drift'});stopped(await f.cli(),'CODE_MISMATCH');await f.ensureFresh();
});

test('actual CLI verifies the actual child execPath rather than another pinned executable',async t=>{
  const f=await fixture(t,{nodeDrift:true});stopped(await f.cli(),'CODE_MISMATCH');await f.ensureFresh();
});
