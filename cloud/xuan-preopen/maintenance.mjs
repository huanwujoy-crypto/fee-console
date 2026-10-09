// Infrastructure maintenance only. No source client, job run or publication API.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
export const FIXED = Object.freeze({
  project:'family-portfolio-gateway', number:'860729177589', region:'asia-east2',
  repository:'huanwujoy-crypto/fee-console', repositoryId:1334738755, owner:'huanwujoy-crypto', ownerId:283054367,
  workflow:'.github/workflows/xuan-preopen-image-maintenance.yml',
  job:'projects/family-portfolio-gateway/locations/asia-east2/jobs/xuan-preopen-report',
  sourceSa:'xuan-preopen-source@family-portfolio-gateway.iam.gserviceaccount.com',
  image:'asia-east2-docker.pkg.dev/family-portfolio-gateway/xuan-preopen-maintenance/xuan-preopen-report',
  dockerfile:'cloud/xuan-preopen/Maintenance.Dockerfile'
});
const SHA=/^[a-f0-9]{40}$/, DIGEST=/^sha256:[a-f0-9]{64}$/;
const fail=code=>{throw Error('PREOPEN_MAINTENANCE_'+code);};
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
function eventContext(e){
  if(e.event!=='workflow_dispatch'||e.ref!=='refs/heads/main'||e.repository!==FIXED.repository||String(e.repositoryId)!==String(FIXED.repositoryId)||String(e.ownerId)!==String(FIXED.ownerId)||String(e.actorId)!==String(FIXED.ownerId)||e.triggeringActor!==FIXED.owner||e.workflowRef!==`${FIXED.repository}/${FIXED.workflow}@refs/heads/main`||!SHA.test(e.workflowSha||''))fail('CONTEXT');
  if(!SHA.test(e.approvedSha||'')||!/^\d{1,8}$/.test(String(e.approvalPr||'')))fail('INPUT');
}
// Bounded, closed GET API; errors never include server messages or responses.
async function body(response,max){
  if(response.status!==200||!response.body)fail('HTTP');
  const declared=Number(response.headers.get('content-length'));if(Number.isFinite(declared)&&declared>max)fail('OVERSIZED');
  const chunks=[];let length=0;for await(const c of response.body){length+=c.length;if(length>max)fail('OVERSIZED');chunks.push(c);}
  return Buffer.concat(chunks);
}
export function githubReader(token,fetchImpl=fetch){
  if(typeof token!=='string'||!token||/[\r\n\0]/.test(token))fail('TOKEN');
  return async route=>{
    if(!new RegExp(`^/(?:repos/${FIXED.repository}/(?:git/ref/heads/main|commits/[a-f0-9]{40}|pulls/[0-9]{1,8}|issues/[0-9]{1,8}/comments\\?per_page=100&page=[1-5]))$`).test(route))fail('ROUTE');
    try{return JSON.parse((await body(await fetchImpl('https://api.github.com'+route,{method:'GET',redirect:'error',signal:AbortSignal.timeout(30_000),headers:{Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'}}),2*1024*1024)).toString('utf8'));}catch(e){if(/^PREOPEN_MAINTENANCE_/.test(e.message))throw e;fail('GITHUB_READ');}
  };
}
export async function verifyApprovedSource(e,{read=githubReader(process.env.GH_TOKEN)}={}){
  eventContext(e);const prefix='/repos/'+FIXED.repository;
  const main=await read(prefix+'/git/ref/heads/main');if(main?.object?.sha!==e.workflowSha)fail('MAIN_MOVED');
  const pr=await read(prefix+'/pulls/'+e.approvalPr);
  if(pr?.state!=='closed'||pr.merged!==true||pr.draft!==false||pr.user?.login!==FIXED.owner||pr.user?.id!==FIXED.ownerId||pr.user?.type!=='User'||pr.base?.ref!=='main'||pr.base?.repo?.id!==FIXED.repositoryId||pr.head?.repo?.id!==FIXED.repositoryId||pr.head?.sha!==e.approvedSha||pr.merge_commit_sha!==e.workflowSha)fail('MERGED_APPROVAL');
  const source=await read(prefix+'/commits/'+e.approvedSha),merged=await read(prefix+'/commits/'+e.workflowSha);
  if(source?.sha!==e.approvedSha||source.author?.id!==FIXED.ownerId||source.author?.login!==FIXED.owner||source.author?.type!=='User'||source.parents?.length!==1||!SHA.test(source.parents[0]?.sha||'')||!((source.committer?.id===FIXED.ownerId&&source.committer?.login===FIXED.owner)||(source.committer?.id===19864447&&source.committer?.login==='web-flow'))||source.commit?.verification?.verified!==true||source.commit.verification.reason!=='valid'||!SHA.test(source.commit?.tree?.sha||'')||merged?.sha!==e.workflowSha||merged.commit?.tree?.sha!==source.commit.tree.sha)fail('SIGNED_SOURCE');
  let approved=false,ended=false;
  for(let page=1;page<=5;page++){
    const comments=await read(prefix+`/issues/${e.approvalPr}/comments?per_page=100&page=${page}`);
    if(!Array.isArray(comments)||comments.length>100)fail('COMMENTS');
    for(const c of comments)if(c.author_association==='OWNER'&&c.user?.id===FIXED.ownerId&&c.user?.login===FIXED.owner&&c.user?.type==='User'&&typeof c.body==='string'&&c.body.split('\n').some(l=>l.trim()===`/approve-xuan-ib-maintenance ${e.approvedSha}`))approved=true;
    if(comments.length<100){ended=true;break;}
  }
  if(!ended||!approved)fail('EXACT_HEAD_APPROVAL');
  return {approvedSha:e.approvedSha,sourceTree:source.commit.tree.sha,workflowSha:e.workflowSha,approvalPr:Number(e.approvalPr)};
}
const git=(args)=>execFileSync('git',args,{encoding:'utf8',timeout:30_000,maxBuffer:1024*1024}).trim();
export function verifyCheckout(e,proof,{runGit=git,allowMerge=false}={}){
  if(runGit(['rev-parse','HEAD'])!==(allowMerge?proof.workflowSha:proof.approvedSha)||runGit(['rev-parse','HEAD^{tree}'])!==proof.sourceTree||proof.approvedSha!==e.approvedSha||proof.workflowSha!==e.workflowSha)fail('CHECKOUT');
  if(runGit(['status','--porcelain','--untracked-files=all'])!=='')fail('DIRTY_SOURCE');
  return proof;
}
const labelNames={approvedSha:'org.opencontainers.image.revision',sourceTree:'fee-console.source-tree',workflowSha:'fee-console.approved-merge',approvalPr:'fee-console.approval-pr'};
export const COPY_PATHS=Object.freeze(['scripts','.github/workflows/validate-xuan-ib-handover.yml','.github/workflows/promote-xuan-ib-handover.yml','.github/workflows/xuan-preopen-image-maintenance.yml','.github/workflows/xuan-preopen-image-build.yml','.github/workflows/xuan-preopen-image-deploy.yml','claude/xuan-ib-portfolio-registry.json','security/xuan-preopen-maintenance-iam.json','cloud/xuan-preopen']);
export function createBuildContext(root,temp,{runGit=args=>execFileSync('git',args,{cwd:root,encoding:'utf8',timeout:30_000,maxBuffer:4*1024*1024})}={}){
  if(typeof temp!=='string'||!path.isAbsolute(temp))fail('BUILD_CONTEXT');
  const context=fs.mkdtempSync(path.join(temp,'xuan-preopen-build-'));
  const entries=runGit(['ls-tree','-r','-z','--full-tree','HEAD','--',...COPY_PATHS]).split('\0').filter(Boolean);
  if(!entries.length||entries.length>5000)fail('BUILD_CONTEXT');
  for(const entry of entries){
    const m=/^(100644|100755) blob ([a-f0-9]{40})\t([^\x00-\x1f\x7f]+)$/.exec(entry);
    if(!m)fail('BUILD_CONTEXT');const [,mode,blob,file]=m,parts=file.split('/');
    if(parts.some(p=>['','.','..','.git'].includes(p))||!COPY_PATHS.some(p=>file===p||file.startsWith(p+'/')))fail('BUILD_CONTEXT');
    for(let i=1;i<parts.length;i++){const parent=fs.lstatSync(path.join(root,...parts.slice(0,i)));if(parent.isSymbolicLink()||!parent.isDirectory())fail('BUILD_CONTEXT');}
    const source=path.join(root,file),stat=fs.lstatSync(source);if(stat.isSymbolicLink()||!stat.isFile())fail('BUILD_CONTEXT');
    const bytes=fs.readFileSync(source),actual=crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');if(actual!==blob)fail('BUILD_CONTEXT');
    const target=path.join(context,file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,bytes,{mode:mode==='100755'?0o755:0o644});
  }
  return context;
}
export function dockerBuildArgs(proof,context='.'){
  if(!SHA.test(proof.approvedSha||'')||!SHA.test(proof.sourceTree||'')||!SHA.test(proof.workflowSha||'')||!Number.isSafeInteger(proof.approvalPr)||proof.approvalPr<1)fail('PROOF');
  return ['build','--network=none','--platform','linux/amd64','--file',FIXED.dockerfile,...Object.entries(labelNames).flatMap(([k,n])=>['--label',`${n}=${proof[k]}`]),'--label',`org.opencontainers.image.source=https://github.com/${FIXED.repository}`,'--tag',`${FIXED.image}:${proof.approvedSha}`,context];
}
export function dockerPushDigest(output){
  const matches=[...String(output).matchAll(/^[^\n]*digest: (sha256:[a-f0-9]{64}) size: [0-9]+$/gm)];
  if(matches.length!==1)fail('PUSH_DIGEST');return matches[0][1];
}
export async function verifyRegistryImage(digest,proof,{token,fetchImpl=fetch}={}){
  dockerBuildArgs(proof);
  if(!DIGEST.test(digest||'')||typeof token!=='string'||!token||/[\r\n\0]/.test(token))fail('IMAGE');
  const registry='https://asia-east2-docker.pkg.dev/v2/family-portfolio-gateway/xuan-preopen-maintenance/xuan-preopen-report/';
  const get=async(route,max)=>{
    try{return await body(await fetchImpl(registry+route,{method:'GET',redirect:'error',signal:AbortSignal.timeout(30_000),headers:{Authorization:'Basic '+Buffer.from('oauth2accesstoken:'+token).toString('base64'),Accept:'application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json'}}),max);}catch(e){if(/^PREOPEN_MAINTENANCE_/.test(e.message))throw e;fail('REGISTRY_READ');}
  };
  const manifestBytes=await get('manifests/'+digest,1024*1024);if('sha256:'+hash(manifestBytes)!==digest)fail('MANIFEST_DIGEST');
  let manifest;try{manifest=JSON.parse(manifestBytes);}catch{fail('MANIFEST');}
  if(manifest.schemaVersion!==2||!['application/vnd.docker.distribution.manifest.v2+json','application/vnd.oci.image.manifest.v1+json'].includes(manifest.mediaType)||!DIGEST.test(manifest.config?.digest||'')||!Number.isSafeInteger(manifest.config.size)||manifest.config.size<1||manifest.config.size>1024*1024)fail('MANIFEST');
  const configBytes=await get('blobs/'+manifest.config.digest,1024*1024);if(configBytes.length!==manifest.config.size||'sha256:'+hash(configBytes)!==manifest.config.digest)fail('CONFIG_DIGEST');
  let c;try{c=JSON.parse(configBytes);}catch{fail('CONFIG');}
  if(c.os!=='linux'||c.architecture!=='amd64'||c.config?.User!=='node'||c.config.WorkingDir!=='/app'||JSON.stringify(c.config.Entrypoint)!==JSON.stringify(['node','cloud/xuan-preopen/daily.mjs'])||JSON.stringify(c.config.Cmd||[])!=='[]')fail('IMAGE_ENTRY');
  if(c.config.Labels?.['org.opencontainers.image.source']!==`https://github.com/${FIXED.repository}`||Object.entries(labelNames).some(([k,n])=>c.config.Labels?.[n]!==String(proof[k])))fail('IMAGE_SOURCE');
  return `${FIXED.image}@${digest}`;
}
const canonical=v=>JSON.stringify((function order(x){if(Array.isArray(x))return x.map(order);if(plain(x))return Object.fromEntries(Object.keys(x).sort().map(k=>[k,order(x[k])]));return x;})(v));
const mutable=['name','labels','annotations','client','clientVersion','launchStage','binaryAuthorization','template'];
const isReconciled=job=>!Object.hasOwn(job,'reconciling')||job.reconciling===false;
export function jobConfiguration(job){
  if(!plain(job)||job.name!==FIXED.job||typeof job.etag!=='string'||!job.etag||job.etag.length>256||!isReconciled(job)||!/^\d+$/.test(String(job.generation))||job.generation!==job.observedGeneration||job.terminalCondition?.state!=='CONDITION_SUCCEEDED'||job.deleteTime||job.startExecutionToken||job.runExecutionToken)fail('JOB');
  const t=job.template, task=t?.template, c=task?.containers;
  if(!plain(t)||!plain(task)||t.taskCount!==1||t.parallelism!==1||task.maxRetries!==0||task.serviceAccount!==FIXED.sourceSa||!Array.isArray(c)||c.length!==1||!plain(c[0])||!immutableImage(c[0].image)||JSON.stringify(c[0].command||[])!=='[]'||JSON.stringify(c[0].args||[])!=='[]')fail('JOB_CONFIG');
  return Object.fromEntries(mutable.filter(k=>Object.hasOwn(job,k)).map(k=>[k,structuredClone(job[k])]));
}
function immutableImage(image){return typeof image==='string'&&/^asia-east2-docker\.pkg\.dev\/family-portfolio-gateway\/(?:cloud-run-source-deploy|xuan-preopen-maintenance)\/xuan-preopen-report@sha256:[a-f0-9]{64}$/.test(image);}
export function imageOnlyPatch(job,image){
  if(!image.startsWith(FIXED.image+'@')||!DIGEST.test(image.slice(FIXED.image.length+1)))fail('DEPLOY_IMAGE');
  const patch=jobConfiguration(job);patch.etag=job.etag;patch.template.template.containers[0].image=image;return patch;
}
// Only exact job GET/PATCH. No operations API or execution route exists.
export function runTransport(token,fetchImpl=fetch){
  if(typeof token!=='string'||!token||/[\r\n\0]/.test(token))fail('TOKEN');
  const jobUrl='https://run.googleapis.com/v2/'+FIXED.job;
  const read=async(url,method='GET',value)=>{
    try{const response=await fetchImpl(url,{method,redirect:'error',signal:AbortSignal.timeout(30_000),headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(value?{body:JSON.stringify(value)}:{})});return JSON.parse((await body(response,2*1024*1024)).toString('utf8'));}catch(e){if(/^PREOPEN_MAINTENANCE_/.test(e.message))throw e;fail('RUN_API');}
  };
  return {getJob:()=>read(jobUrl),patchJob:value=>{if(value?.name!==FIXED.job||value.startExecutionToken||value.runExecutionToken)fail('PATCH');return read(jobUrl+'?allowMissing=false','PATCH',value);}};
}
export async function deployImage({image,api,wait=ms=>new Promise(r=>setTimeout(r,ms)),beforePatch=async()=>{},onPlan=()=>{}}){
  const before=await api.getJob(),original=jobConfiguration(before),patch=imageOnlyPatch(before,image),rollback=original.template.template.containers[0].image;
  if(rollback===image)return {status:'unchanged',image,rollbackImage:rollback,configurationSha256:hash(canonical(original))};
  onPlan({rollbackImage:rollback,configurationSha256:hash(canonical(original))});
  // Revalidate approval/current main immediately before the only mutation.
  await beforePatch();await api.patchJob(patch);
  const expected=structuredClone(original);expected.template.template.containers[0].image=image;
  let after;
  for(let i=0;i<40;i++){
    await wait(3000);after=await api.getJob();
    if(after?.name!==FIXED.job||after.deleteTime||after.startExecutionToken||after.runExecutionToken)fail('JOB');
    if(!isReconciled(after)&&after.reconciling!==true)fail('JOB');
    if(!/^\d+$/.test(String(after.generation)))fail('DEPLOYMENT');
    const generation=BigInt(after.generation),previous=BigInt(before.generation);
    if(generation<previous)fail('DEPLOYMENT');
    if(generation===previous){
      // A delayed GET may still return the exact previous ready snapshot.
      // Only that unchanged snapshot is allowed to wait; it is never success.
      if(!isReconciled(after)||after.etag!==before.etag||canonical(jobConfiguration(after))!==canonical(original))fail('CONFIG_CHANGED');
      if(i===39)fail('DEPLOYMENT_TIMEOUT');continue;
    }
    if(isReconciled(after)){
      const actual=jobConfiguration(after);if(canonical(actual)!==canonical(expected))fail('CONFIG_CHANGED');break;
    }
    if(i===39)fail('DEPLOYMENT_TIMEOUT');
  }
  return {status:'deployed-not-executed',image,rollbackImage:rollback,configurationSha256:hash(canonical(original))};
}
function envContext(){return {event:process.env.GITHUB_EVENT_NAME,ref:process.env.GITHUB_REF,repository:process.env.GITHUB_REPOSITORY,repositoryId:process.env.GITHUB_REPOSITORY_ID,ownerId:process.env.GITHUB_REPOSITORY_OWNER_ID,actorId:process.env.GITHUB_ACTOR_ID,triggeringActor:process.env.GITHUB_TRIGGERING_ACTOR,workflowRef:process.env.GITHUB_WORKFLOW_REF,workflowSha:process.env.GITHUB_SHA,approvedSha:process.env.APPROVED_SHA,approvalPr:process.env.APPROVAL_PR};}
export async function main(args=process.argv.slice(2)){
  if(args.length!==1||!['preflight','build','deploy'].includes(args[0]))fail('ARGUMENTS');
  const e=envContext(),proof=await verifyApprovedSource(e);verifyCheckout(e,proof,{allowMerge:args[0]==='preflight'});
  if(args[0]==='preflight'){if(process.env.GITHUB_OUTPUT)fs.appendFileSync(process.env.GITHUB_OUTPUT,`source_tree=${proof.sourceTree}\n`);return {status:'approved-source-verified',...proof};}
  const token=process.env.MAINTENANCE_GOOGLE_TOKEN;
  if(args[0]==='build'){
    const context=createBuildContext(process.cwd(),process.env.RUNNER_TEMP);
    execFileSync('docker',dockerBuildArgs(proof,context),{stdio:'inherit',timeout:15*60_000});
    const output=execFileSync('docker',['push',`${FIXED.image}:${proof.approvedSha}`],{encoding:'utf8',timeout:5*60_000,maxBuffer:16*1024*1024});
    const digest=dockerPushDigest(output);await verifyRegistryImage(digest,proof,{token});
    if(process.env.GITHUB_OUTPUT)fs.appendFileSync(process.env.GITHUB_OUTPUT,`image_digest=${digest}\n`);return {status:'built-not-executed',digest,...proof};
  }
  const image=await verifyRegistryImage(process.env.BUILT_DIGEST,proof,{token});
  return deployImage({image,api:runTransport(token),beforePatch:()=>verifyApprovedSource(e),onPlan:p=>{process.stdout.write(JSON.stringify({status:'deployment-plan',...p})+'\n');if(process.env.GITHUB_OUTPUT)fs.appendFileSync(process.env.GITHUB_OUTPUT,`rollback_image=${p.rollbackImage}\n`);}});
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().then(r=>process.stdout.write(JSON.stringify(r)+'\n')).catch(e=>{process.stderr.write((/^PREOPEN_MAINTENANCE_[A-Z_]+$/.test(e.message)?e.message:'PREOPEN_MAINTENANCE_FAILED')+'\n');process.exitCode=1;});
