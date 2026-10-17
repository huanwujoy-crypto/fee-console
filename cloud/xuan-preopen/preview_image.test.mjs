import {spawnSync} from 'node:child_process';
// All identities, credentials, repository responses and Docker results are SYNTHETIC.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {PREVIEW_BUILD,PREVIEW_COPY_PATHS,validatePreviewBuildMode,verifyPreviewBuildSource,createPreviewBuildContext,previewDockerBuildArgs,verifyPreviewRegistryImage,executePreviewImageBuild,previewImageMain} from './preview_image.mjs';
import {FIXED} from './maintenance.mjs';
globalThis.fetch=()=>assert.fail('No real cloud, registry, identity or financial request');
const sha='a'.repeat(40),tree='b'.repeat(40),merge='c'.repeat(40),proof={approvedSha:sha,sourceTree:tree,workflowSha:merge,approvalPr:17};
const event={event:'workflow_dispatch',ref:'refs/heads/main',repository:FIXED.repository,repositoryId:FIXED.repositoryId,ownerId:FIXED.ownerId,actorId:FIXED.ownerId,triggeringActor:FIXED.owner,workflowRef:`${FIXED.repository}/${FIXED.workflow}@refs/heads/main`,workflowSha:merge,approvedSha:sha,approvalPr:'17',imageKind:'preview',deployImage:'false'};
const hash=b=>'sha256:'+crypto.createHash('sha256').update(b).digest('hex');
function sourceFixture(){const owner={id:FIXED.ownerId,login:FIXED.owner,type:'User'},responses={
 [`/repos/${FIXED.repository}/git/ref/heads/main`]:{object:{sha:merge}},
 [`/repos/${FIXED.repository}/pulls/17`]:{state:'closed',merged:true,draft:false,user:owner,base:{ref:'main',repo:{id:FIXED.repositoryId}},head:{sha,repo:{id:FIXED.repositoryId}},merge_commit_sha:merge},
 [`/repos/${FIXED.repository}/commits/${sha}`]:{sha,author:owner,committer:{id:19864447,login:'web-flow'},parents:[{sha:'f'.repeat(40)}],commit:{tree:{sha:tree},verification:{verified:true,reason:'valid'}}},
 [`/repos/${FIXED.repository}/commits/${merge}`]:{sha:merge,commit:{tree:{sha:tree}}},
 [`/repos/${FIXED.repository}/issues/17/comments?per_page=100&page=1`]:[{author_association:'OWNER',user:owner,body:'/approve-xuan-ib-maintenance '+sha}]};let reads=0;return {responses,read:async route=>{reads++;return structuredClone(responses[route]);},reads:()=>reads};}
function contextFixture(){const temp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'preview-build-test-'))),root=path.join(temp,'source');fs.mkdirSync(root);const rows=[];
 for(const file of PREVIEW_COPY_PATHS){const p=path.join(root,file),bytes=Buffer.from('// SYNTHETIC '+file);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,bytes);const blob=crypto.createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex');rows.push('100644 blob '+blob+'\t'+file);}
 const runGit=args=>args[0]==='ls-tree'?rows.join('\0')+'\0':args[0]==='status'?'':args[1]==='HEAD'?sha:tree;
 return {root,temp,rows,runGit,clean:()=>fs.rmSync(temp,{recursive:true,force:true})};}
function imageFixture(mutate=()=>{}){const c={os:'linux',architecture:'amd64',config:{User:'node',WorkingDir:'/app',Entrypoint:PREVIEW_BUILD.entrypoint,Cmd:[],Env:['PATH=/usr/local/bin','NODE_VERSION=24.0.0','YARN_VERSION=1.0.0'],Labels:{'org.opencontainers.image.source':'https://github.com/'+FIXED.repository,'org.opencontainers.image.revision':sha,'fee-console.source-tree':tree,'fee-console.approved-merge':merge,'fee-console.approval-pr':'17','fee-console.preview-kind':'action-once'}}};mutate(c);const config=JSON.stringify(c),manifest=JSON.stringify({schemaVersion:2,mediaType:'application/vnd.docker.distribution.manifest.v2+json',config:{digest:hash(config),size:Buffer.byteLength(config)}});return {config,manifest,digest:hash(manifest)};}
const files=(root,prefix='')=>fs.readdirSync(path.join(root,prefix)).flatMap(n=>{const f=prefix?prefix+'/'+n:n;return fs.lstatSync(path.join(root,f)).isDirectory()?files(root,f):[f];}).sort();

test('preview is a fixed build-only source extension; invalid modes and deploy requests stop before all remote reads',async()=>{
 for(const change of [{imageKind:'report'},{imageKind:'other'},{deployImage:'true'},{deployImage:false},{deployImage:undefined}]){let reads=0;await assert.rejects(verifyPreviewBuildSource({...event,...change},{read:async()=>{reads++;}}),/BUILD_ONLY_MODE/);assert.equal(reads,0);}
 assert.equal(validatePreviewBuildMode(event),event);const f=sourceFixture();assert.deepEqual(await verifyPreviewBuildSource(event,{read:f.read}),proof);
});
test('same existing signed-head, OWNER, main/tree, repository/actor and workflow checks are retained',async()=>{
 for(const mutate of [f=>f.responses[`/repos/${FIXED.repository}/issues/17/comments?per_page=100&page=1`]=[],f=>f.responses[`/repos/${FIXED.repository}/commits/${sha}`].commit.verification.verified=false,f=>f.responses[`/repos/${FIXED.repository}/commits/${merge}`].commit.tree.sha=sha,f=>f.responses[`/repos/${FIXED.repository}/git/ref/heads/main`].object.sha=sha]){const f=sourceFixture();mutate(f);await assert.rejects(verifyPreviewBuildSource(event,{read:f.read}),/PREOPEN_MAINTENANCE_/);}
 for(const change of [{event:'schedule'},{actorId:1},{workflowRef:'other'},{ref:'refs/heads/other'}]){const f=sourceFixture();await assert.rejects(verifyPreviewBuildSource({...event,...change},{read:f.read}));assert.equal(f.reads(),0);}
});
test('fixed minimal COPY closure excludes unrelated tracked/untracked credentials and private source files',()=>{
 assert.equal(PREVIEW_COPY_PATHS.length,54);assert.equal(new Set(PREVIEW_COPY_PATHS).size,54);const f=contextFixture();
 try{for(const name of ['data.json','scripts/codex-fee-credentials.mjs','.git/config','private-snapshot.json','scripts/extra-untracked.mjs']){const p=path.join(f.root,name);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,'SYNTHETIC_PRIVATE_CANARY');}
  const dir=createPreviewBuildContext(f.root,f.temp,{runGit:f.runGit});assert.deepEqual(files(dir),[...PREVIEW_COPY_PATHS].sort());assert.ok(!PREVIEW_COPY_PATHS.some(p=>/credential|private-snapshot|data\.json|\.git\//.test(p)));
 }finally{f.clean();}
});
test('missing/extra/duplicate/unsafe/mode-mismatched/modified files fail before any context is created',()=>{
 const f=contextFixture();try{const bad=[f.rows.slice(1),[...f.rows,f.rows[0]],[f.rows[1],...f.rows.slice(1)],[f.rows[0].replace('100644','120000'),...f.rows.slice(1)],[f.rows[0].replace('100644','100755'),...f.rows.slice(1)],[f.rows[0].split('\t')[0]+'\tscripts/../data.json',...f.rows.slice(1)]];
  for(const rows of bad)assert.throws(()=>createPreviewBuildContext(f.root,f.temp,{runGit:()=>rows.join('\0')+'\0'}),/CONTEXT/);
  fs.writeFileSync(path.join(f.root,PREVIEW_COPY_PATHS[0]),'SYNTHETIC_TAMPERING');assert.throws(()=>createPreviewBuildContext(f.root,f.temp,{runGit:f.runGit}),/CONTEXT/);assert.deepEqual(fs.readdirSync(f.temp),['source']);
 }finally{f.clean();}
});
test('symlink roots, parents and leaves or context inside source are rejected',()=>{
 for(const kind of ['root','parent','leaf','inside']){const f=contextFixture();try{let root=f.root,temp=f.temp;
  if(kind==='root'){root=path.join(f.temp,'linked');fs.symlinkSync(f.root,root);}if(kind==='parent'){fs.renameSync(path.join(root,'scripts'),path.join(f.temp,'scripts-real'));fs.symlinkSync(path.join(f.temp,'scripts-real'),path.join(root,'scripts'));}
  if(kind==='leaf'){const p=path.join(root,PREVIEW_COPY_PATHS[0]);fs.unlinkSync(p);fs.symlinkSync(path.join(root,PREVIEW_COPY_PATHS[1]),p);}if(kind==='inside'){temp=path.join(root,'tmp');fs.mkdirSync(temp);}
  assert.throws(()=>createPreviewBuildContext(root,temp,{runGit:f.runGit}),/CONTEXT/);
 }finally{f.clean();}}
});
test('only fixed preview image/Dockerfile, offline network, platform and exact-source labels enter Docker arguments',()=>{
 const args=previewDockerBuildArgs(proof,'/synthetic-context');assert.deepEqual(args.slice(0,6),['build','--network=none','--platform','linux/amd64','--file',PREVIEW_BUILD.dockerfile]);assert.ok(args.includes(PREVIEW_BUILD.image+':'+sha));assert.ok(args.includes('fee-console.preview-kind=action-once'));assert.equal(args.at(-1),'/synthetic-context');
 for(const p of [{...proof,approvedSha:'main'},{...proof,approvalPr:0},{...proof,sourceTree:'other'}])assert.throws(()=>previewDockerBuildArgs(p,'/synthetic-context'));assert.throws(()=>previewDockerBuildArgs(proof,'.'));
});
test('two fixed registry GETs bind manifest/config hashes and controller source/entry, with no cloud service API',async()=>{
 const i=imageFixture(),calls=[];const fetchImpl=async(u,o)=>{calls.push({u,o});return new Response(u.includes('/manifests/')?i.manifest:i.config);};
 assert.equal(await verifyPreviewRegistryImage(i.digest,proof,{token:'SYNTHETIC_TOKEN',fetchImpl}),PREVIEW_BUILD.image+'@'+i.digest);assert.equal(calls.length,2);assert.ok(calls.every(c=>c.u.startsWith('https://asia-east2-docker.pkg.dev/v2/family-portfolio-gateway/xuan-preopen-maintenance/xuan-preopen-action-preview/')&&c.o.method==='GET'&&c.o.redirect==='error'));
 for(const mutate of [c=>c.config.Entrypoint=['node','cloud/xuan-preopen/daily.mjs'],c=>c.config.Cmd=['--run'],c=>c.config.Labels['fee-console.preview-kind']='report',c=>c.config.Labels['org.opencontainers.image.revision']=merge,c=>c.architecture='arm64',c=>c.config.User='root',c=>c.config.Env.push('SECRET=SYNTHETIC_PRIVATE_CANARY')]){const bad=imageFixture(mutate);await assert.rejects(verifyPreviewRegistryImage(bad.digest,proof,{token:'synthetic',fetchImpl:async u=>new Response(u.includes('/manifests/')?bad.manifest:bad.config)}));}
 await assert.rejects(verifyPreviewRegistryImage('sha256:'+'f'.repeat(64),proof,{token:'synthetic',fetchImpl:async()=>new Response(i.manifest)}),/MANIFEST_DIGEST/);
 await assert.rejects(verifyPreviewRegistryImage(i.digest,proof,{token:'synthetic',fetchImpl:async u=>new Response(u.includes('/manifests/')?i.manifest:'tampered')}),/CONFIG_DIGEST/);
});
test('registry permission/network/private-message/oversize failures expose only fixed errors, no retry',async()=>{
 const i=imageFixture();for(const fetcher of [async()=>new Response('SYNTHETIC_PRIVATE_CANARY',{status:403}),async()=>{throw Error('SYNTHETIC_TOKEN');},async()=>new Response('x'.repeat(1024*1024+1))]){let calls=0;await assert.rejects(verifyPreviewRegistryImage(i.digest,proof,{token:'synthetic',fetchImpl:async(...a)=>{calls++;return fetcher(...a);}}),e=>/^PREVIEW_IMAGE_[A-Z_]+$/.test(e.message)&&!e.message.includes('SYNTHETIC'));assert.equal(calls,1);}
});
test('native build orchestration verifies source twice, pushes once, verifies digest and always removes its context',async()=>{
 const f=contextFixture(),s=sourceFixture(),i=imageFixture(),calls=[];try{const r=await executePreviewImageBuild({event,root:f.root,temp:f.temp,token:'SYNTHETIC_TOKEN',read:s.read,runGit:f.runGit,runDocker:(a)=>{calls.push(a);return a[0]==='push'?sha+': digest: '+i.digest+' size: 100\n':'';},fetchImpl:async u=>new Response(u.includes('/manifests/')?i.manifest:i.config)});
  assert.equal(r.status,'preview-image-built-not-executed');assert.equal(r.image,PREVIEW_BUILD.image+'@'+i.digest);assert.equal(s.reads(),10);assert.equal(calls.length,2);assert.equal(calls[1][0],'push');assert.deepEqual(fs.readdirSync(f.temp),['source']);assert.ok(!JSON.stringify(r).includes('SYNTHETIC_TOKEN'));
 }finally{f.clean();}
});
test('changed main/revoked OWNER/dirty checkout or build failure stops before push; push failure never retries',async()=>{
 for(const kind of ['main','owner','dirty','build','push']){const f=contextFixture(),s=sourceFixture();let calls=0,dirty=false;try{
  await assert.rejects(executePreviewImageBuild({event,root:f.root,temp:f.temp,token:'synthetic',read:s.read,runGit:a=>a[0]==='status'&&dirty?'?? synthetic':f.runGit(a),runDocker:a=>{calls++;if(a[0]==='build'){if(kind==='build')throw Error('SYNTHETIC_BUILD_FAILURE');if(kind==='main')s.responses[`/repos/${FIXED.repository}/git/ref/heads/main`].object.sha=sha;if(kind==='owner')s.responses[`/repos/${FIXED.repository}/issues/17/comments?per_page=100&page=1`]=[];if(kind==='dirty')dirty=true;}if(a[0]==='push')throw Error('SYNTHETIC_PUSH_FAILURE');return '';}}));
  assert.equal(calls,kind==='push'?2:1);assert.deepEqual(fs.readdirSync(f.temp),['source']);
 }finally{f.clean();}}
});
test('invalid CLI never reaches identity, Docker, cloud or source APIs',async()=>{
 for(const args of [[],['deploy'],['build','--image=other'],['run'],['bootstrap']])await assert.rejects(previewImageMain(args,{env:{}}),/ARGUMENTS/);await assert.rejects(previewImageMain(['preflight'],{env:{IMAGE_KIND:'preview',DEPLOY_IMAGE:'true'}}),/BUILD_ONLY_MODE/);
});
test('independent pre-run verify CLI reads only two fixed registry objects with transient stdin token and exact approved proof',async()=>{
 const i=imageFixture(),env={IMAGE_KIND:'preview',DEPLOY_IMAGE:'false',PREVIEW_SOURCE_PROOF:JSON.stringify(proof)};let tokenReads=0,calls=0;
 const r=await previewImageMain(['verify',i.digest],{env,readToken:async()=>{tokenReads++;return 'SYNTHETIC_TRANSIENT_TOKEN';},fetchImpl:async u=>{calls++;return new Response(u.includes('/manifests/')?i.manifest:i.config);}});
 assert.equal(r.status,'preview-image-bytes-verified-only');assert.equal(r.approval,'not-asserted');assert.equal(tokenReads,1);assert.equal(calls,2);assert.ok(!JSON.stringify(r).includes('SYNTHETIC_TRANSIENT_TOKEN'));
 for(const raw of ['{}',JSON.stringify({...proof,selector:'other'}),' {"approvedSha":"a"}']){let reads=0;await assert.rejects(previewImageMain(['verify',i.digest],{env:{...env,PREVIEW_SOURCE_PROOF:raw},readToken:async()=>{reads++;}}),/PROOF/);assert.equal(reads,0);}
 const f=contextFixture(),s=sourceFixture();try{let docker=0;await assert.rejects(executePreviewImageBuild({event,root:f.root,temp:f.temp,token:'',read:s.read,runGit:f.runGit,runDocker:()=>docker++}),/IMAGE/);assert.equal(docker,0);}finally{f.clean();}
});
test('workflow extends explicit preview build only, reuses exact existing WIF claims and never routes preview to deploy',()=>{
 const caller=fs.readFileSync(new URL('../../.github/workflows/xuan-preopen-image-maintenance.yml',import.meta.url),'utf8'),callee=fs.readFileSync(new URL('../../.github/workflows/xuan-preopen-image-build.yml',import.meta.url),'utf8');
 assert.ok(caller.includes('options: [report, preview]'));assert.ok(caller.includes("inputs.image_kind != 'preview'"));assert.ok(callee.includes('preview_image.mjs preflight'));assert.ok(callee.indexOf('preview_image.mjs preflight')<callee.indexOf('id: builder'));assert.ok(callee.includes('preview_image.mjs build'));assert.ok(callee.includes('DEPLOY_IMAGE: ${{ inputs.deploy_image }}'));
 for(const part of ['workload_identity_provider: projects/860729177589/locations/global/workloadIdentityPools/fee-console-github/providers/xuan-preopen-image-builder','service_account: '+PREVIEW_BUILD.builder,'create_credentials_file: false'])assert.ok(callee.includes(part));
 const source=fs.readFileSync(new URL('./preview_image.mjs',import.meta.url),'utf8');for(const api of ['cloudbuild.googleapis.com','run.googleapis.com','secretmanager.googleapis.com','iam.googleapis.com','storage.googleapis.com'])assert.ok(!source.includes(api));assert.ok(!callee.includes('gcloud'));
});

// Real retained source bytes, with only the Git listing injected. This verifies
// the minimal runtime context without a Docker daemon, Git checkout or network.
// The complete committed HEAD is checked separately by the trusted archive test.
test('minimal fixed image context imports its real entrypoint and rejects missing concentration dependencies',()=>{
  const root=fs.realpathSync('.'),temp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'concentration-image-closure-')));
  const dependencies=["claude/xuan-weekly-concentration-top10-v1.json", "claude/xuan-weekly-leveraged-products-v1.json", "scripts/xuan-ib-action-concentration.mjs", "scripts/xuan-ib-ai-coefficient-resolver.mjs", "scripts/xuan-ib-ai-risk-input.mjs", "scripts/xuan-ib-ai-risk-registry.mjs", "scripts/xuan-ib-auto-classification.mjs", "scripts/xuan-ib-cash-identity.mjs", "scripts/xuan-ib-classification-audit.mjs", "scripts/xuan-ib-delegated-tier.mjs", "scripts/xuan-ib-four-bucket.mjs", "scripts/xuan-weekly-concentration.mjs", "scripts/xuan-weekly-leveraged-products.mjs"];
  try{
    const rows=PREVIEW_COPY_PATHS.map(file=>{const bytes=fs.readFileSync(path.join(root,file));const blob=crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');return `${fs.statSync(path.join(root,file)).mode&0o111?'100755':'100644'} blob ${blob}\t${file}`;});
    const context=createPreviewBuildContext(root,temp,{runGit:()=>rows.join('\0')+'\0'});
    const program="globalThis.fetch=()=>{throw Error('OFFLINE_ONLY');};await import('./cloud/xuan-preopen/action_preview_once.mjs');";
    const run=()=>spawnSync(process.execPath,['--input-type=module','-e',program],{cwd:context,encoding:'utf8',timeout:30000});
    const complete=run();assert.equal(complete.status,0,complete.stderr);
    for(const dependency of dependencies){
      const file=path.join(context,dependency),bytes=fs.readFileSync(file);fs.unlinkSync(file);
      try{const missing=run();assert.notEqual(missing.status,0,dependency);assert.ok(missing.stderr.includes(dependency),dependency);}
      finally{fs.writeFileSync(file,bytes);}
    }
    const docker=fs.readFileSync(path.join(root,'cloud/xuan-preopen/ActionPreviewOnce.Dockerfile'),'utf8');
    for(const file of dependencies.filter(p=>p.endsWith('.json')))assert.ok(docker.includes(`COPY ${file} ${file}`),file);
  }finally{fs.rmSync(temp,{recursive:true,force:true});}
});
