// Pure, pinned historical projection contract. This does not grant source
// authenticity, current-cloud approval, identity verification or publication.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath, pathToFileURL} from 'node:url';

const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'projection_reference');
const pins={
 'fee-ratio-official-source.mjs':'013301288812b4a043a96edabca5e66ecbcf5bdb59881473cb18fe23c9810842',
 'fee-ratio-company-exposure.mjs':'d04f8dfad864c6c5f93ccfac38f476432040be191a1989c65dda7aca1c1ced2c',
 'fee-ratio-aggregate-returns.mjs':'a4dcfc93b9eb14409eb3da553459c6e32c8655b8689cae73ae8599cd5e5d4448',
 'fee-ratio-source-core.mjs':'0a53193f0a1e67d0a50aa5806bb30860b86c6f080280b68507303b86d2a27461'
};
const fail=()=>{throw Error('PINNED_PROJECTION_REFUSED');};
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const exact=(v,k)=>v&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).sort().join('|')===[...k].sort().join('|');
function checkCode(){for(const [name,sha] of Object.entries(pins)){const file=path.join(root,name),st=fs.lstatSync(file);if(!st.isFile()||st.isSymbolicLink()||hash(fs.readFileSync(file))!==sha)fail();}}
try{
 checkCode();
 const requestBytes=fs.readFileSync(0);if(requestBytes.length>8*1024*1024)fail();
 const request=JSON.parse(requestBytes);
 if(!exact(request,['mode','allocation','performance','performanceCapturedAt','now'])||!['targets','validate'].includes(request.mode)||!Number.isFinite(Date.parse(request.now)))fail();
 const {createOfficialRatioSourceCore}=await import(pathToFileURL(path.join(root,'fee-ratio-official-source.mjs')));
 const {createFeeCompanyExposureCore}=await import(pathToFileURL(path.join(root,'fee-ratio-company-exposure.mjs')));
 const {createAggregateReturnsCore}=await import(pathToFileURL(path.join(root,'fee-ratio-aggregate-returns.mjs')));
 const {createRatioSourceCore}=await import(pathToFileURL(path.join(root,'fee-ratio-source-core.mjs')));
 const raw=request.mode==='validate'?{schemaVersion:'sharesight-private-performance-v1',accounts:request.allocation.accounts,allocation:request.allocation,performance:request.performance,performanceCapturedAt:request.performanceCapturedAt}:request.allocation;
 const bytes=Buffer.from(JSON.stringify(raw)),sha=hash(bytes);
 const built=createOfficialRatioSourceCore().build(request.allocation,{sourceSha256:sha,sourceBytes:bytes.length});
 const company=createFeeCompanyExposureCore(),companyModel=company.build(request.allocation,built.input,built.companyContext);
 const companyView=company.validate(companyModel,built.input.exposure,sha);
 if(companyView.state!=='projection-complete')fail();
 const aggregate=createAggregateReturnsCore(),targets=aggregate.topTargets(built.input.exposure,companyView.top);
 if(request.mode==='validate'){
  const input={...built.input,schema:'fee-console.ratio-sources.v3',performance:structuredClone(request.performance)};
  // Scope is derived here solely for internal association consistency. The
  // fixed repository scope policy is enforced by the Python IO boundary.
  const scope=a=>hash(JSON.stringify(a.map(x=>x.replaceAll('&amp;','&')).sort()));
  createRatioSourceCore(scope).verifyBrowserSourceAssociations(raw,input,{scopeHash:scope(raw.accounts),now:new Date(request.now)});
  aggregate.build(request.performance,{expectedAccounts:raw.accounts,expectedAsOf:request.performance.asOf,topTargets:targets});
 }
 checkCode();
 process.stdout.write(JSON.stringify({state:'PINNED_PURE_PROJECTION_PASSED',targets,codeReferenceBase:'6de56ffb708e8995edfc3b67895841ab474a2c02',sourceOriginVerified:false,publicationReady:false,currentCloudCompatibilityValidated:false}));
}catch{
 process.stderr.write('PINNED_PROJECTION_REFUSED\n');process.exitCode=1;
}
