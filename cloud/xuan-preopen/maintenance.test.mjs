import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {FIXED,COPY_PATHS,createBuildContext,verifyApprovedSource,verifyCheckout,dockerBuildArgs,dockerPushDigest,verifyRegistryImage,jobConfiguration,imageOnlyPatch,runTransport,githubReader,deployImage,main} from './maintenance.mjs';
const sha='a'.repeat(40),tree='b'.repeat(40),merge='c'.repeat(40),digest='sha256:'+'d'.repeat(64),old='sha256:'+'e'.repeat(64);
const proof={approvedSha:sha,sourceTree:tree,workflowSha:merge,approvalPr:17};
const event={event:'workflow_dispatch',ref:'refs/heads/main',repository:FIXED.repository,repositoryId:FIXED.repositoryId,ownerId:FIXED.ownerId,actorId:FIXED.ownerId,triggeringActor:FIXED.owner,workflowRef:`${FIXED.repository}/${FIXED.workflow}@refs/heads/main`,workflowSha:merge,approvedSha:sha,approvalPr:'17'};
const owner={id:FIXED.ownerId,login:FIXED.owner,type:'User'};
const hash=v=>'sha256:'+crypto.createHash('sha256').update(v).digest('hex');
function githubFixture(){const calls=[],responses={
 [`/repos/${FIXED.repository}/git/ref/heads/main`]:{object:{sha:merge}},
 [`/repos/${FIXED.repository}/pulls/17`]:{state:'closed',merged:true,draft:false,user:owner,base:{ref:'main',repo:{id:FIXED.repositoryId}},head:{sha,repo:{id:FIXED.repositoryId}},merge_commit_sha:merge},
 [`/repos/${FIXED.repository}/commits/${sha}`]:{sha,author:owner,committer:{id:19864447,login:'web-flow'},parents:[{sha:'f'.repeat(40)}],commit:{tree:{sha:tree},verification:{verified:true,reason:'valid'}}},
 [`/repos/${FIXED.repository}/commits/${merge}`]:{sha:merge,commit:{tree:{sha:tree}}},
 [`/repos/${FIXED.repository}/issues/17/comments?per_page=100&page=1`]:[{author_association:'OWNER',user:owner,body:`/approve-xuan-ib-maintenance ${sha}`}]
 };const isolated=structuredClone(responses);return {responses:isolated,calls,read:async route=>{calls.push(route);return structuredClone(isolated[route]);}};}
function job(){return {name:FIXED.job,etag:'safe-etag',generation:'11',observedGeneration:'11',reconciling:false,terminalCondition:{state:'CONDITION_SUCCEEDED'},labels:{purpose:'report'},annotations:{keep:'unchanged'},template:{taskCount:1,parallelism:1,template:{serviceAccount:FIXED.sourceSa,maxRetries:0,timeout:'300s',containers:[{image:`asia-east2-docker.pkg.dev/family-portfolio-gateway/cloud-run-source-deploy/xuan-preopen-report@${old}`,resources:{limits:{cpu:'1',memory:'512Mi'}},env:[{name:'SYNTHETIC_PRIVATE',value:'CONFIG-AND-TOKEN-CANARY'},{name:'FIXED_SECRET',valueSource:{secretKeyRef:{secret:'synthetic-secret',version:'latest'}}}]}]}}};}
function imageFixture(mutate=()=>{}){const c={os:'linux',architecture:'amd64',config:{User:'node',WorkingDir:'/app',Entrypoint:['node','cloud/xuan-preopen/daily.mjs'],Cmd:[],Labels:{'org.opencontainers.image.source':`https://github.com/${FIXED.repository}`,'org.opencontainers.image.revision':sha,'fee-console.source-tree':tree,'fee-console.approved-merge':merge,'fee-console.approval-pr':'17'}}};mutate(c);const config=JSON.stringify(c),manifest=JSON.stringify({schemaVersion:2,mediaType:'application/vnd.docker.distribution.manifest.v2+json',config:{digest:hash(config),size:Buffer.byteLength(config)}});return {config,manifest,digest:hash(manifest)};}
test('exact signed OWNER head, existing exact approval and equal merged tree are required; signed alone grants nothing',async()=>{
 const f=githubFixture();assert.deepEqual(await verifyApprovedSource(event,{read:f.read}),proof);assert.equal(f.calls.length,5);
 for(const mutation of [r=>r[`/repos/${FIXED.repository}/pulls/17`].merged=false,r=>r[`/repos/${FIXED.repository}/pulls/17`].head.sha=merge,r=>r[`/repos/${FIXED.repository}/pulls/17`].head.repo.id=1,r=>r[`/repos/${FIXED.repository}/commits/${sha}`].commit.verification.verified=false,r=>r[`/repos/${FIXED.repository}/commits/${sha}`].author.id=1,r=>r[`/repos/${FIXED.repository}/commits/${sha}`].committer.id=1,r=>r[`/repos/${FIXED.repository}/commits/${merge}`].commit.tree.sha='f'.repeat(40),r=>r[`/repos/${FIXED.repository}/git/ref/heads/main`].object.sha=sha,r=>r[`/repos/${FIXED.repository}/issues/17/comments?per_page=100&page=1`][0].body=`/approve-xuan-ib-maintenance ${merge}`,r=>r[`/repos/${FIXED.repository}/issues/17/comments?per_page=100&page=1`][0].user.id=1]){
  const bad=githubFixture();mutation(bad.responses);await assert.rejects(verifyApprovedSource(event,{read:bad.read}),/^Error: PREOPEN_MAINTENANCE_[A-Z_]+$/);
 }
});
test('untrusted branch/event/actor/workflow/repository and malformed inputs reject before any remote read',async()=>{
 for(const [key,value] of [['event','schedule'],['ref','refs/heads/other'],['actorId',1],['triggeringActor','attacker'],['repositoryId',1],['ownerId',1],['workflowRef','other'],['approvedSha','HEAD;PRIVATE-CANARY'],['approvalPr','17/../18'],['workflowSha','short']]){let calls=0;await assert.rejects(verifyApprovedSource({...event,[key]:value},{read:async()=>{calls++;}}));assert.equal(calls,0);}
});
test('bounded exact-head approval pagination cannot accept a truncated comment history',async()=>{
 const f=githubFixture();let pages=0;const read=async route=>route.includes('/comments?')?(pages++,Array(100).fill({body:'untrusted'})):f.read(route);
 await assert.rejects(verifyApprovedSource(event,{read}),/EXACT_HEAD_APPROVAL/);assert.equal(pages,5);
});
test('clean checkout binds approved HEAD and full source tree, with explicit equal-tree trusted preflight only',()=>{
 const runGit=args=>args[0]==='status'?'':args[1]==='HEAD'?sha:tree;
 assert.deepEqual(verifyCheckout(event,proof,{runGit}),proof);
 assert.throws(()=>verifyCheckout(event,proof,{runGit:args=>args[0]==='status'?'?? untracked':runGit(args)}),/DIRTY_SOURCE/);
 assert.throws(()=>verifyCheckout(event,proof,{runGit:()=>merge}),/CHECKOUT/);
 assert.deepEqual(verifyCheckout(event,proof,{allowMerge:true,runGit:args=>args[0]==='status'?'':args[1]==='HEAD'?merge:tree}),proof);
});
test('fixed Docker build/push binds source labels and accepts only one immutable push digest',()=>{
 const args=dockerBuildArgs(proof);assert.equal(args[0],'build');assert.ok(args.includes(FIXED.dockerfile));assert.ok(args.includes(`${FIXED.image}:${sha}`));assert.ok(args.includes('org.opencontainers.image.revision='+sha));assert.ok(args.includes('fee-console.source-tree='+tree));
 assert.equal(dockerPushDigest(`${sha}: digest: ${digest} size: 123\n`),digest);for(const out of ['',`digest: ${digest} size: 1\ndigest: ${old} size: 1\n`,'digest: latest size: 1'])assert.throws(()=>dockerPushDigest(out));
 assert.throws(()=>dockerBuildArgs({...proof,approvedSha:'main'}));
});
test('pushed manifest/config bytes, source labels and normal entry are independently verified by exactly two closed GETs',async()=>{
 const img=imageFixture(),calls=[];const fetchImpl=async(url,options)=>{calls.push({url,options});return new Response(url.includes('/manifests/')?img.manifest:img.config);};
 assert.equal(await verifyRegistryImage(img.digest,proof,{token:'SYNTHETIC-TOKEN',fetchImpl}),`${FIXED.image}@${img.digest}`);assert.equal(calls.length,2);assert.ok(calls.every(c=>c.options.method==='GET'&&c.options.redirect==='error'));assert.ok(calls[0].url.endsWith('/manifests/'+img.digest));assert.ok(calls[1].url.endsWith('/blobs/'+hash(img.config)));
 for(const mutate of [c=>c.config.Labels['org.opencontainers.image.revision']=merge,c=>c.config.Labels['fee-console.source-tree']=sha,c=>c.config.Entrypoint=['node','cloud/xuan-preopen/probe.mjs'],c=>c.config.Cmd=['--source-check'],c=>c.os='windows']){const bad=imageFixture(mutate);await assert.rejects(verifyRegistryImage(bad.digest,proof,{token:'synthetic',fetchImpl:async url=>new Response(url.includes('/manifests/')?bad.manifest:bad.config)}));}
 await assert.rejects(verifyRegistryImage(digest,proof,{token:'synthetic',fetchImpl:async()=>new Response(img.manifest)}),/MANIFEST_DIGEST/);
 await assert.rejects(verifyRegistryImage(img.digest,proof,{token:'synthetic',fetchImpl:async url=>new Response(url.includes('/manifests/')?img.manifest:'tampered')}),/CONFIG_DIGEST/);
});
test('fixed job image-only PATCH retains env/secret references/network/resource/arguments and etag without execution tokens',()=>{
 const before=job(),original=structuredClone(before),image=FIXED.image+'@'+digest,patch=imageOnlyPatch(before,image);assert.deepEqual(before,original);assert.equal(patch.etag,before.etag);assert.equal(patch.template.template.containers[0].image,image);
 const wanted=jobConfiguration(before);wanted.etag=before.etag;wanted.template.template.containers[0].image=image;assert.deepEqual(patch,wanted);assert.ok(!Object.hasOwn(patch,'generation'));assert.ok(!Object.hasOwn(patch,'startExecutionToken'));assert.ok(!Object.hasOwn(patch,'runExecutionToken'));
 for(const mutate of [j=>j.template.taskCount=2,j=>j.template.parallelism=2,j=>j.template.template.maxRetries=1,j=>j.template.template.serviceAccount='another',j=>j.template.template.containers[0].args=['--ledger-readback'],j=>j.template.template.containers[0].command=['node','probe.mjs'],j=>j.template.template.containers[0].image='latest',j=>j.reconciling=true,j=>j.terminalCondition.state='CONDITION_FAILED',j=>j.runExecutionToken='go']){const bad=job();mutate(bad);assert.throws(()=>imageOnlyPatch(bad,image));}
 assert.throws(()=>imageOnlyPatch(before,'other@'+digest));
});
test('deployment polls only the fixed job and requires newer ready generation plus identical nonimage configuration',async()=>{
 const before=job(),image=FIXED.image+'@'+digest,after=structuredClone(before);after.template.template.containers[0].image=image;after.generation=after.observedGeneration='12';let gets=0,patches=0,plans=0,checks=0;
 const api={getJob:async()=>++gets===1?before:after,patchJob:async patch=>{patches++;assert.equal(patch.etag,before.etag);return {name:'ignored-operation-no-read'};}};
 const result=await deployImage({image,api,wait:async()=>{},beforePatch:async()=>{checks++;},onPlan:p=>{plans++;assert.ok(!JSON.stringify(p).includes('CONFIG-AND-TOKEN-CANARY'));assert.equal(p.rollbackImage,before.template.template.containers[0].image);}});
 assert.equal(result.status,'deployed-not-executed');assert.equal(gets,2);assert.equal(patches,1);assert.equal(checks,1);assert.equal(plans,1);assert.ok(!JSON.stringify(result).includes('CONFIG-AND-TOKEN-CANARY'));
});
test('revoked approval, etag conflict, permission errors, failed reconciliation, altered config and timeouts never retry PATCH/run/rollback',async()=>{
 const image=FIXED.image+'@'+digest;
 for(const kind of ['approval','permission','failed','changed','same-generation','timeout']){let patches=0,gets=0;const before=job();const after=structuredClone(before);after.template.template.containers[0].image=image;after.generation=after.observedGeneration='12';if(kind==='failed')after.terminalCondition.state='CONDITION_FAILED';if(kind==='changed')after.template.template.containers[0].env[0].value='ALTERED';if(kind==='same-generation')after.generation=after.observedGeneration='11';if(kind==='timeout')after.reconciling=true;
  const api={getJob:async()=>++gets===1?before:after,patchJob:async()=>{patches++;if(kind==='permission')throw Error('PREOPEN_MAINTENANCE_HTTP');return {};}};
  await assert.rejects(deployImage({image,api,wait:async()=>{},beforePatch:async()=>{if(kind==='approval')throw Error('REVOKED');}}));assert.equal(patches,kind==='approval'?0:1);assert.ok(gets<=41);
 }
});
test('real transports have a closed GET/PATCH route set, bounded bodies and never echo private responses',async()=>{
 const calls=[],api=runTransport('SYNTHETIC-TOKEN',async(url,options)=>{calls.push({url,options});return new Response(JSON.stringify(options.method==='PATCH'?{}:job()));});await api.getJob();await api.patchJob(imageOnlyPatch(job(),FIXED.image+'@'+digest));assert.equal(calls.length,2);assert.equal(calls[0].url,`https://run.googleapis.com/v2/${FIXED.job}`);assert.equal(calls[1].url,calls[0].url+'?allowMissing=false');assert.equal(calls[1].options.method,'PATCH');assert.equal(calls[1].options.redirect,'error');assert.ok(!calls.some(c=>c.url.includes(':run')||c.url.includes('/operations/')));
 await assert.rejects(runTransport('synthetic',async()=>new Response('PRIVATE-RESPONSE-CANARY',{status:403})).getJob(),e=>e.message==='PREOPEN_MAINTENANCE_HTTP');
 await assert.rejects(runTransport('synthetic',async()=>{throw Error('PRIVATE-TOKEN-AMOUNT');}).getJob(),e=>e.message==='PREOPEN_MAINTENANCE_RUN_API');
 const read=githubReader('synthetic',async()=>new Response('{}'));for(const route of ['/repos/other/repo/git/ref/heads/main',`/repos/${FIXED.repository}/actions/runs`,`/repos/${FIXED.repository}/commits/main`])await assert.rejects(read(route),/ROUTE/);
 await assert.rejects(githubReader('synthetic',async()=>new Response('x'.repeat(2*1024*1024+1)))(`/repos/${FIXED.repository}/git/ref/heads/main`),/OVERSIZED/);
});
test('invalid CLI inputs have no source, credential, cloud or Docker action',async()=>{
 for(const args of [[],['run'],['deploy','--job=other'],['build','--image=other'],['--ledger-readback']])await assert.rejects(main(args),/ARGUMENTS/);
});
test('workflow/Docker/IAM plan isolate maintenance identity and preserve daily production routes',()=>{
 const entry=fs.readFileSync(new URL('../../'+FIXED.workflow,import.meta.url),'utf8'),workflow=entry+fs.readFileSync(new URL('../../.github/workflows/xuan-preopen-image-build.yml',import.meta.url),'utf8')+fs.readFileSync(new URL('../../.github/workflows/xuan-preopen-image-deploy.yml',import.meta.url),'utf8'),docker=fs.readFileSync(new URL('./Maintenance.Dockerfile',import.meta.url),'utf8'),iam=JSON.parse(fs.readFileSync(new URL('../../security/xuan-preopen-maintenance-iam.json',import.meta.url),'utf8'));
 for(const k of ['build','deploy'])assert.ok(entry.includes(`uses: ${FIXED.repository}/.github/workflows/xuan-preopen-image-${k}.yml@main`));assert.ok(!entry.includes('uses: ./.github/workflows/'));assert.ok(workflow.includes('workflow_dispatch:'));assert.ok(!workflow.includes('schedule:'));assert.ok(!workflow.includes('FEE_CLOUD_GITHUB_TOKEN'));assert.ok(!workflow.includes('xuan-preopen-delivery@'));assert.ok(!workflow.includes('cloud_io.mjs'));assert.ok(workflow.includes('XUAN_PREOPEN_IMAGE_MAINTENANCE_ENABLED'));assert.ok(workflow.indexOf('maintenance.mjs preflight')<workflow.indexOf('id: builder'));assert.equal((workflow.match(/create_credentials_file: false/g)||[]).length,2);assert.equal((workflow.match(/actions\/setup-node@2028fbc5c25fe9cf00d9f06a71cc4710d4507903/g)||[]).length,2);assert.equal((workflow.match(/node-version: '24'/g)||[]).length,2);assert.equal((workflow.match(/package-manager-cache: false/g)||[]).length,2);assert.ok(!workflow.includes('gcloud'));assert.ok(!workflow.includes('environment:'));
 assert.ok(docker.includes("RUN --network=none node --test --test-skip-pattern='^phone '"));assert.ok(docker.includes('ENTRYPOINT ["node", "cloud/xuan-preopen/daily.mjs"]'));assert.ok(docker.includes('CMD []'));assert.ok(!/COPY (?:\.git(?:\/| )|data\.json |xuan-ib\/)/.test(docker));
 assert.equal(iam.providers.length,2);assert.equal(iam.bindings.filter(b=>b.role==='roles/iam.workloadIdentityUser').length,2);
 for(const [i,p] of iam.providers.entries()){assert.ok(p.attributeCondition.includes("assertion.repository_id == '1334738755'"));assert.ok(p.attributeCondition.includes("assertion.repository_owner_id == '283054367'"));assert.ok(p.attributeCondition.includes("assertion.ref == 'refs/heads/main'"));assert.ok(p.attributeCondition.includes("assertion.event_name == 'workflow_dispatch'"));assert.ok(p.attributeCondition.includes("assertion.workflow_ref == '"+event.workflowRef+"'"));assert.ok(p.attributeCondition.includes("assertion.job_workflow_ref == 'huanwujoy-crypto/fee-console/.github/workflows/xuan-preopen-image-"+(i===0?'build':'deploy')+".yml@refs/heads/main'"));assert.ok(!p.attributeCondition.includes('assertion.sub =='));assert.ok(p.attributeCondition.includes('assertion.job_workflow_sha == assertion.sha'));assert.ok(p.attributeCondition.includes('assertion.job_workflow_sha == assertion.workflow_sha')); assert.equal(p.attributeMapping['attribute.xuan_preopen_image_identity'],i===0?"'builder-v1'":"'deployer-v1'");assert.ok(iam.bindings[i].member.includes('/attribute.xuan_preopen_image_identity/'));assert.ok(!iam.bindings[i].member.includes('/attribute.repository_id/'));}
 assert.deepEqual(iam.customRoles.find(r=>r.name.endsWith('/xuanPreopenImageDeploy')).includedPermissions,['run.jobs.get','run.jobs.update']);assert.ok(!iam.customRoles.flatMap(r=>r.includedPermissions).some(p=>iam.neverGrant.includes(p)));assert.ok(iam.bindings.every(b=>!b.resource.includes('cloud-run-source-deploy')));assert.equal(iam.existingCloudRunServiceAgent.newBindingRequired,false);
});

test('fixed Docker COPY closure excludes host credentials, git/data/pages and rejects symlinks',()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'maintenance-context-test-')),root=path.join(temp,'source');fs.mkdirSync(root);
 try{
  for(const f of COPY_PATHS){const p=path.join(root,f);fs.mkdirSync(path.dirname(p),{recursive:true});if(f==='scripts'||f==='cloud/xuan-preopen'){fs.mkdirSync(p);fs.writeFileSync(path.join(p,'synthetic.mjs'),'// safe synthetic');}else fs.writeFileSync(p,'synthetic');}
  fs.writeFileSync(path.join(root,'data.json'),'PRIVATE-CANARY');fs.mkdirSync(path.join(root,'.git'));fs.writeFileSync(path.join(root,'.git','config'),'TOKEN-CANARY');fs.mkdirSync(path.join(root,'xuan-ib'));fs.writeFileSync(path.join(root,'xuan-ib','latest.html'),'PRIVATE-PAGE');
  const rows=[];function collect(f){const p=path.join(root,f);if(fs.statSync(p).isDirectory()){for(const name of fs.readdirSync(p))collect(f+'/'+name);}else{const b=fs.readFileSync(p),sha=crypto.createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex');rows.push(`100644 blob ${sha}\t${f}`);}}
  for(const f of COPY_PATHS)collect(f);const listing=rows.join('\0')+'\0';const runGit=()=>listing;
  fs.writeFileSync(path.join(root,'scripts','ignored-credential.txt'),'HOST-TOKEN-CANARY');
  const context=createBuildContext(root,temp,{runGit});assert.ok(!fs.existsSync(path.join(context,'scripts','ignored-credential.txt')));assert.ok(!fs.existsSync(path.join(context,'data.json')));assert.ok(!fs.existsSync(path.join(context,'.git')));assert.ok(!fs.existsSync(path.join(context,'xuan-ib')));assert.ok(!dockerBuildArgs(proof,context).includes(root));assert.ok(dockerBuildArgs(proof,context).includes('--network=none'));
  fs.symlinkSync(path.join(root,'data.json'),path.join(root,'scripts','canary-link'));assert.throws(()=>createBuildContext(root,temp,{runGit:()=>listing+`100644 blob ${'f'.repeat(40)}\tscripts/canary-link\0`}),/BUILD_CONTEXT/);
  fs.writeFileSync(path.join(root,'scripts','synthetic.mjs'),'tampered source');assert.throws(()=>createBuildContext(root,temp,{runGit}),/BUILD_CONTEXT/);
 }finally{fs.rmSync(temp,{recursive:true,force:true});}
});

test('isolated Docker COPY context runs the EOD runtime suite with its public policy/proposal dependencies',()=>{
 const root=fileURLToPath(new URL('../../',import.meta.url)),temp=fs.mkdtempSync(path.join(os.tmpdir(),'maintenance-eod-closure-'));
 try{
  const docker=fs.readFileSync(path.join(root,FIXED.dockerfile),'utf8');
  const copies=[...docker.matchAll(/^COPY (\S+) (\S+)$/gm)].map(([,source,target])=>{assert.equal(source,target);return source.replace(/\/$/,'');});
  assert.deepEqual(copies,[...COPY_PATHS]);
  // Model only the already allowlisted public source tree. The committed-tree
  // production implementation separately checks Git blob identity; this fixture
  // also runs inside the image, where no Git metadata or executable is copied.
  const rows=[];
  function collect(file){const p=path.join(root,file),stat=fs.lstatSync(p);assert.equal(stat.isSymbolicLink(),false);if(stat.isDirectory()){for(const name of fs.readdirSync(p))collect(file+'/'+name);}else{assert.equal(stat.isFile(),true);const bytes=fs.readFileSync(p),blob=crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');rows.push(`100644 blob ${blob}\t${file}`);}}
  for(const file of COPY_PATHS)collect(file);
  const context=createBuildContext(root,temp,{runGit:()=>rows.join('\0')+'\0'});
  for(const file of ['claude/xuan-ib-account-association-v1.json','security/xuan-preopen-eod-source-iam.proposed.json','docs/xuan-preopen-eod-association-renewal.patch'])assert.ok(fs.existsSync(path.join(context,file)));
  assert.equal(fs.existsSync(path.join(context,'.git')),false);
  assert.equal(fs.existsSync(path.join(context,'data.json')),false);
  assert.equal(fs.existsSync(path.join(context,'xuan-ib')),false);
  // No recursive maintenance test: this real subprocess is the suite whose
  // ENOENT failure escaped the full-repository tests when COPY was incomplete.
  const output=execFileSync(process.execPath,['--test','--test-reporter=tap','cloud/xuan-preopen/eod_runtime.test.mjs'],{cwd:context,encoding:'utf8',timeout:30_000,maxBuffer:1024*1024,env:{PATH:process.env.PATH,TMPDIR:temp}});
  assert.match(output,/# fail 0\b/);assert.match(output,/# skipped 0\b/);
 }finally{fs.rmSync(temp,{recursive:true,force:true});}
});

test('provider condition fixtures reject cross-leaf identity exchange and caller/callee/event SHA drift',()=>{
 const iam=JSON.parse(fs.readFileSync(new URL('../../security/xuan-preopen-maintenance-iam.json',import.meta.url),'utf8'));
 const claims={repository_id:'1334738755',repository_owner_id:'283054367',repository:FIXED.repository,ref:'refs/heads/main',event_name:'workflow_dispatch',workflow_ref:event.workflowRef,actor_id:'283054367',job_workflow_ref:`${FIXED.repository}/.github/workflows/xuan-preopen-image-build.yml@refs/heads/main`,job_workflow_sha:merge,sha:merge,workflow_sha:merge};
 // Evaluate only the proposed equality-conjunction grammar, not Google's live CEL engine.
 const accepts=(provider,c,aud)=>provider.allowedAudiences.includes(aud)&&provider.attributeCondition.split(' && ').every(term=>{const m=/^assertion\.([a-z_]+) == (?:'([^']*)'|assertion\.([a-z_]+))$/.exec(term);assert.ok(m,'unsupported condition grammar');return typeof c[m[1]]==='string'&&c[m[1]]===(m[3]?c[m[3]]:m[2]);});
 const [builder,deployer]=iam.providers;assert.equal(accepts(builder,claims,builder.allowedAudiences[0]),true);
 assert.equal(accepts(deployer,claims,deployer.allowedAudiences[0]),false);
 const deployClaims={...claims,job_workflow_ref:`${FIXED.repository}/.github/workflows/xuan-preopen-image-deploy.yml@refs/heads/main`};assert.equal(accepts(deployer,deployClaims,deployer.allowedAudiences[0]),true);assert.equal(accepts(builder,deployClaims,builder.allowedAudiences[0]),false);
 for(const mutation of [{job_workflow_sha:sha},{workflow_sha:sha},{sha},{job_workflow_sha:undefined},{job_workflow_ref:`${FIXED.repository}/.github/workflows/xuan-preopen-image-build.yml@${merge}`}])assert.equal(accepts(builder,{...claims,...mutation},builder.allowedAudiences[0]),false);
});

test('ProtoJSON omitted reconciling false is accepted; wrong types and omitted retry oneof fail closed',async()=>{
 const before=job();delete before.reconciling;assert.equal(jobConfiguration(before).name,FIXED.job);
 for(const value of [null,'false',0,1,undefined]){const bad=job();bad.reconciling=value;assert.throws(()=>jobConfiguration(bad));}
 const retry=job();delete retry.template.template.maxRetries;assert.throws(()=>jobConfiguration(retry),/JOB_CONFIG/);
 const image=FIXED.image+'@'+digest,after=structuredClone(before);after.template.template.containers[0].image=image;after.generation=after.observedGeneration='12';after.etag='new-etag';let gets=0;
 const result=await deployImage({image,api:{getJob:async()=>++gets===1?before:after,patchJob:async()=>({})},wait:async()=>{}});assert.equal(result.status,'deployed-not-executed');assert.equal(gets,2);
 for(const value of [null,'false',0]){let reads=0;const bad={...after,reconciling:value};await assert.rejects(deployImage({image,api:{getJob:async()=>++reads===1?before:bad,patchJob:async()=>({})},wait:async()=>{}}),/JOB/);}
});
test('after one PATCH old ready snapshot may lag; only exact old configuration may wait and never count as deployed',async()=>{
 const before=job(),image=FIXED.image+'@'+digest,after=structuredClone(before);after.template.template.containers[0].image=image;after.generation=after.observedGeneration='12';after.etag='new-etag';let gets=0,patches=0;
 const result=await deployImage({image,api:{getJob:async()=>++gets<4?structuredClone(before):after,patchJob:async()=>{patches++;return {};}},wait:async()=>{}});assert.equal(result.status,'deployed-not-executed');assert.equal(patches,1);assert.equal(gets,4);
 for(const mutate of [j=>j.template.template.containers[0].env[0].value='changed',j=>j.template.template.containers[0].image=image,j=>j.etag='different-etag']){
  let reads=0,writes=0;const bad=structuredClone(before);mutate(bad);await assert.rejects(deployImage({image,api:{getJob:async()=>++reads===1?before:bad,patchJob:async()=>{writes++;return {};}},wait:async()=>{}}),/CONFIG_CHANGED/);assert.equal(writes,1);assert.equal(reads,2);
 }
 let reads=0,writes=0;await assert.rejects(deployImage({image,api:{getJob:async()=>{reads++;return before;},patchJob:async()=>{writes++;return {};}},wait:async()=>{}}),/DEPLOYMENT_TIMEOUT/);assert.equal(writes,1);assert.equal(reads,41);
});
