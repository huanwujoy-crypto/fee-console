// Fixed preview-image builder only. No Cloud Build, IAM, Run, source or object API.
// Existing maintenance exact-head OWNER/source guards are reused unchanged.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {FIXED as MAINTENANCE,verifyApprovedSource,verifyCheckout,githubReader,dockerPushDigest} from './maintenance.mjs';
export const PREVIEW_BUILD=Object.freeze({repository:MAINTENANCE.repository,workflow:MAINTENANCE.workflow,
  image:'asia-east2-docker.pkg.dev/family-portfolio-gateway/xuan-preopen-maintenance/xuan-preopen-action-preview',
  dockerfile:'cloud/xuan-preopen/ActionPreviewOnce.Dockerfile',entrypoint:['node','cloud/xuan-preopen/action_preview_once.mjs'],
  builder:'xuan-preopen-image-builder@family-portfolio-gateway.iam.gserviceaccount.com'});
const SHA=/^[a-f0-9]{40}$/,DIGEST=/^sha256:[a-f0-9]{64}$/;
const fail=code=>{throw Error('PREVIEW_IMAGE_'+code);};
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
export const PREVIEW_COPY_PATHS=Object.freeze([
  "claude/xuan-ib-portfolio-registry.json",
  "cloud/xuan-preopen/ActionPreviewOnce.Dockerfile",
  "cloud/xuan-preopen/action_preview.mjs",
  "cloud/xuan-preopen/action_preview.test.mjs",
  "cloud/xuan-preopen/action_preview_once.mjs",
  "cloud/xuan-preopen/action_preview_once.test.mjs",
  "cloud/xuan-preopen/calendar.mjs",
  "cloud/xuan-preopen/call_record.mjs",
  "cloud/xuan-preopen/cloud_io.mjs",
  "cloud/xuan-preopen/eod_adapters.mjs",
  "cloud/xuan-preopen/eod_report.mjs",
  "cloud/xuan-preopen/eod_sources.mjs",
  "cloud/xuan-preopen/ib_diagnostics.mjs",
  "cloud/xuan-preopen/ib_diagnostics.test.mjs",
  "cloud/xuan-preopen/ib_mcp.mjs",
  "cloud/xuan-preopen/ib_mcp.test.mjs",
  "cloud/xuan-preopen/orders_probe.mjs",
  "cloud/xuan-preopen/orders_probe.test.mjs",
  "cloud/xuan-preopen/report.mjs",
  "scripts/xuan-ib-account-association.mjs",
  "scripts/xuan-ib-action-fields.mjs",
  "scripts/xuan-ib-cash-plan.mjs",
  "scripts/xuan-ib-decision-menu.mjs",
  "scripts/xuan-ib-eod-action-model.mjs",
  "scripts/xuan-ib-eod-holdings.mjs",
  "scripts/xuan-ib-hook-response.mjs",
  "scripts/xuan-ib-intraday-update.mjs",
  "scripts/xuan-ib-limited-status.mjs",
  "scripts/xuan-ib-manual-consent.mjs",
  "scripts/xuan-ib-night-action-guard.mjs",
  "scripts/xuan-ib-night-action-model.mjs",
  "scripts/xuan-ib-night-action-view.mjs",
  "scripts/xuan-ib-order-view.mjs",
  "scripts/xuan-ib-public-eod-summary.mjs",
  "scripts/xuan-ib-run-clock.mjs",
  "scripts/xuan-ib-run-manifest.mjs",
  "scripts/xuan-ib-sharesight-allocation.mjs",
  "scripts/xuan-ib-source-adapter.mjs",
  "scripts/xuan-ib-source-capture.mjs",
  "scripts/xuan-ib-source-hook.mjs",
  "scripts/xuan-ib-weekly-snapshot.mjs"
]);
const labels={approvedSha:'org.opencontainers.image.revision',sourceTree:'fee-console.source-tree',workflowSha:'fee-console.approved-merge',approvalPr:'fee-console.approval-pr'};
export function validatePreviewBuildMode(e){
  if(e?.imageKind!=='preview'||e.deployImage!=='false')fail('BUILD_ONLY_MODE');
  return e;
}
export async function verifyPreviewBuildSource(e,options){
  validatePreviewBuildMode(e);return verifyApprovedSource(e,options);
}
export function createPreviewBuildContext(root,temp,{runGit=args=>execFileSync('git',args,{cwd:root,encoding:'utf8',timeout:30000,maxBuffer:4*1024*1024})}={}){
  if(!path.isAbsolute(root||'')||!path.isAbsolute(temp||'')||fs.realpathSync(root)!==root||fs.realpathSync(temp)!==temp||temp===root||temp.startsWith(root+path.sep))fail('CONTEXT');
  const entries=runGit(['ls-tree','-r','-z','--full-tree','HEAD','--',...PREVIEW_COPY_PATHS]).split('\0').filter(Boolean),seen=new Set(),verified=[];
  if(entries.length!==PREVIEW_COPY_PATHS.length)fail('CONTEXT');
  for(const row of entries){
    const m=/^(100644|100755) blob ([a-f0-9]{40})\t([^\x00-\x1f\x7f]+)$/.exec(row);if(!m)fail('CONTEXT');
    const [,mode,blob,file]=m,parts=file.split('/');
    if(!PREVIEW_COPY_PATHS.includes(file)||seen.has(file)||parts.some(p=>['','.','..','.git'].includes(p)))fail('CONTEXT');seen.add(file);
    for(let i=1;i<parts.length;i++){const s=fs.lstatSync(path.join(root,...parts.slice(0,i)));if(s.isSymbolicLink()||!s.isDirectory())fail('CONTEXT');}
    const source=path.join(root,file),s=fs.lstatSync(source);if(s.isSymbolicLink()||!s.isFile()||((s.mode&0o111)?'100755':'100644')!==mode)fail('CONTEXT');
    const bytes=fs.readFileSync(source),actual=crypto.createHash('sha1').update(Buffer.from('blob '+bytes.length+'\0')).update(bytes).digest('hex');if(actual!==blob)fail('CONTEXT');
    verified.push({file,mode,bytes});
  }
  if(seen.size!==PREVIEW_COPY_PATHS.length)fail('CONTEXT');
  const context=fs.mkdtempSync(path.join(temp,'xuan-preview-image-'));
  try{for(const {file,mode,bytes} of verified){const target=path.join(context,file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,bytes,{mode:mode==='100755'?0o755:0o644});}return context;}
  catch{fs.rmSync(context,{recursive:true,force:true});fail('CONTEXT');}
}
export function previewDockerBuildArgs(proof,context){
  if(!SHA.test(proof?.approvedSha||'')||!SHA.test(proof.sourceTree||'')||!SHA.test(proof.workflowSha||'')||!Number.isSafeInteger(proof.approvalPr)||proof.approvalPr<1||typeof context!=='string'||!path.isAbsolute(context))fail('PROOF');
  return ['build','--network=none','--platform','linux/amd64','--file',PREVIEW_BUILD.dockerfile,...Object.entries(labels).flatMap(([key,label])=>['--label',label+'='+proof[key]]),
    '--label','org.opencontainers.image.source=https://github.com/'+PREVIEW_BUILD.repository,'--label','fee-console.preview-kind=action-once','--tag',PREVIEW_BUILD.image+':'+proof.approvedSha,context];
}
async function bounded(response,max){
  if(response.status!==200||!response.body)fail('REGISTRY_HTTP');
  const declared=Number(response.headers.get('content-length'));if(Number.isFinite(declared)&&declared>max)fail('REGISTRY_SIZE');
  const chunks=[];let size=0;for await(const c of response.body){size+=c.length;if(size>max)fail('REGISTRY_SIZE');chunks.push(c);}return Buffer.concat(chunks);
}
export async function verifyPreviewRegistryImage(digest,proof,{token,fetchImpl=fetch}={}){
  previewDockerBuildArgs(proof,'/synthetic-proof-only');
  if(!DIGEST.test(digest||'')||typeof token!=='string'||!token||/[\r\n\0]/.test(token))fail('IMAGE');
  const registry='https://asia-east2-docker.pkg.dev/v2/family-portfolio-gateway/xuan-preopen-maintenance/xuan-preopen-action-preview/';
  const get=async route=>{try{return await bounded(await fetchImpl(registry+route,{method:'GET',redirect:'error',signal:AbortSignal.timeout(30000),headers:{Authorization:'Basic '+Buffer.from('oauth2accesstoken:'+token).toString('base64'),Accept:'application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json'}}),1024*1024);}catch(e){if(/^PREVIEW_IMAGE_[A-Z_]+$/.test(e?.message))throw e;fail('REGISTRY_READ');}};
  const bytes=await get('manifests/'+digest);if('sha256:'+hash(bytes)!==digest)fail('MANIFEST_DIGEST');let manifest;try{manifest=JSON.parse(bytes);}catch{fail('MANIFEST');}
  if(manifest.schemaVersion!==2||!['application/vnd.docker.distribution.manifest.v2+json','application/vnd.oci.image.manifest.v1+json'].includes(manifest.mediaType)||!DIGEST.test(manifest.config?.digest||'')||!Number.isSafeInteger(manifest.config.size)||manifest.config.size<1||manifest.config.size>1024*1024)fail('MANIFEST');
  const configBytes=await get('blobs/'+manifest.config.digest);if(configBytes.length!==manifest.config.size||'sha256:'+hash(configBytes)!==manifest.config.digest)fail('CONFIG_DIGEST');let c;try{c=JSON.parse(configBytes);}catch{fail('CONFIG');}
  if(c.os!=='linux'||c.architecture!=='amd64'||c.config?.User!=='node'||c.config.WorkingDir!=='/app'||JSON.stringify(c.config.Entrypoint)!==JSON.stringify(PREVIEW_BUILD.entrypoint)||JSON.stringify(c.config.Cmd||[])!=='[]')fail('IMAGE_ENTRY');
  if(c.config.Labels?.['org.opencontainers.image.source']!=='https://github.com/'+PREVIEW_BUILD.repository||c.config.Labels['fee-console.preview-kind']!=='action-once'||Object.entries(labels).some(([key,label])=>c.config.Labels[label]!==String(proof[key])))fail('IMAGE_SOURCE');
  if(!Array.isArray(c.config.Env)||c.config.Env.some(v=>typeof v!=='string'||!['PATH','NODE_VERSION','YARN_VERSION'].includes(v.split('=')[0]))||new Set(c.config.Env.map(v=>v.split('=')[0])).size!==c.config.Env.length)fail('IMAGE_ENV');
  return PREVIEW_BUILD.image+'@'+digest;
}
function contextFromEnv(env){return {event:env.GITHUB_EVENT_NAME,ref:env.GITHUB_REF,repository:env.GITHUB_REPOSITORY,repositoryId:env.GITHUB_REPOSITORY_ID,ownerId:env.GITHUB_REPOSITORY_OWNER_ID,actorId:env.GITHUB_ACTOR_ID,triggeringActor:env.GITHUB_TRIGGERING_ACTOR,workflowRef:env.GITHUB_WORKFLOW_REF,workflowSha:env.GITHUB_SHA,approvedSha:env.APPROVED_SHA,approvalPr:env.APPROVAL_PR,imageKind:env.IMAGE_KIND,deployImage:env.DEPLOY_IMAGE};}
const realDocker=(args,{capture=false,timeout}={})=>execFileSync('docker',args,{timeout,...capture?{encoding:'utf8',maxBuffer:16*1024*1024}:{stdio:'inherit'}});
export async function executePreviewImageBuild({event,root,temp,token,read=githubReader(process.env.GH_TOKEN),runGit,runDocker=realDocker,fetchImpl=fetch}={}){
  const proof=await verifyPreviewBuildSource(event,{read});
  if(typeof token!=='string'||!token||/[\r\n\0]/.test(token))fail('IMAGE');
  const sourceGit=runGit??(args=>execFileSync('git',args,{cwd:root,encoding:'utf8',timeout:30000,maxBuffer:4*1024*1024}).trim());
  verifyCheckout(event,proof,{runGit:sourceGit});
  const context=createPreviewBuildContext(root,temp,{runGit:sourceGit});
  try{
    runDocker(previewDockerBuildArgs(proof,context),{timeout:15*60_000});
    // The build may take minutes: recheck the exact source/main/OWNER and clean
    // checkout immediately before the sole immutable registry push.
    await verifyPreviewBuildSource(event,{read});verifyCheckout(event,proof,{runGit:sourceGit});
    const output=runDocker(['push',PREVIEW_BUILD.image+':'+proof.approvedSha],{capture:true,timeout:5*60_000}),digest=dockerPushDigest(output);
    const image=await verifyPreviewRegistryImage(digest,proof,{token,fetchImpl});return {status:'preview-image-built-not-executed',image,digest,...proof};
  }finally{fs.rmSync(context,{recursive:true,force:true});}
}
async function stdinToken(){
  let bytes=Buffer.alloc(0);try{for await(const chunk of process.stdin){if(bytes.length+chunk.length>8192)fail('IMAGE');bytes=Buffer.concat([bytes,chunk]);}return bytes.toString('utf8').replace(/\n$/,'');}finally{bytes.fill(0);}
}
export async function previewImageMain(args=process.argv.slice(2),{env=process.env,readToken=stdinToken,fetchImpl=fetch}={}){
  if(args[0]==='verify'){
    if(args.length!==2||!DIGEST.test(args[1]))fail('ARGUMENTS');validatePreviewBuildMode({imageKind:env.IMAGE_KIND,deployImage:env.DEPLOY_IMAGE});
    let proof;try{proof=JSON.parse(env.PREVIEW_SOURCE_PROOF);if(JSON.stringify(proof)!==env.PREVIEW_SOURCE_PROOF||Object.keys(proof).sort().join('|')!=='approvalPr|approvedSha|sourceTree|workflowSha')fail('PROOF');previewDockerBuildArgs(proof,'/verification-only');}catch{fail('PROOF');}
    let token=await readToken();try{const image=await verifyPreviewRegistryImage(args[1],proof,{token,fetchImpl});return {status:'preview-image-bytes-verified-only',approval:'not-asserted',image,...proof};}finally{token=null;}
  }
  if(args.length!==1||!['preflight','build'].includes(args[0]))fail('ARGUMENTS');const event=contextFromEnv(env);validatePreviewBuildMode(event);
  if(args[0]==='preflight'){const proof=await verifyPreviewBuildSource(event);verifyCheckout(event,proof,{allowMerge:true});return {status:'preview-source-approved-not-built',...proof};}
  const result=await executePreviewImageBuild({event,root:process.cwd(),temp:env.RUNNER_TEMP,token:env.MAINTENANCE_GOOGLE_TOKEN});
  if(env.GITHUB_OUTPUT)fs.appendFileSync(env.GITHUB_OUTPUT,'image_digest='+result.digest+'\n');return result;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))previewImageMain().then(r=>process.stdout.write(JSON.stringify(r)+'\n')).catch(e=>{process.stderr.write((/^(?:PREVIEW_IMAGE|PREOPEN_MAINTENANCE)_[A-Z_]+$/.test(e?.message)?e.message:'PREVIEW_IMAGE_FAILED')+'\n');process.exitCode=1;});
