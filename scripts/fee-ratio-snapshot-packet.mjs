// Public-recipient-only, local candidate builder. Never authenticates a formal
// publication, reads credentials, contacts a service or edits fee data/health.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createLegacyPolicy} from './fee-legacy-policy.mjs';
import {createRankedExposureCore} from './xuan-ib-sharesight-exposure.mjs';
import {createFeeRatioCore} from './fee-ratio-management.mjs';
import {createRatioSourceCore} from './fee-ratio-source-core.mjs';
import {createRatioSnapshotCore} from './fee-ratio-snapshot.mjs';
import {buildRatioModel} from './fee-ratio-packet.mjs';
import {readVerifiedBrowserEvidence} from './fee-ratio-browser-evidence.mjs';
const fail=()=>{throw Error('RATIO_SNAPSHOT_PACKET_REFUSED');};
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const parse=b=>createLegacyPolicy().parseExactJson(b);
const exact=(o,k)=>o&&typeof o==='object'&&!Array.isArray(o)&&Object.keys(o).sort().join(',')===[...k].sort().join(',');
function privateDir(p){
  if(typeof p!=='string'||!path.isAbsolute(p)||fs.realpathSync(p)!==p)fail();
  const s=fs.lstatSync(p);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid()||(s.mode&0o777)!==0o700)fail();
  for(let at=p;;at=path.dirname(at)){if(fs.existsSync(path.join(at,'.git')))fail();if(at===path.dirname(at))break;}
}
function pinned(spec){
  if(!exact(spec,['path','sha256'])||!/^[a-f0-9]{64}$/.test(spec.sha256||''))fail();privateDir(path.dirname(spec.path));
  const read=()=>{const s=fs.lstatSync(spec.path);if(!s.isFile()||s.isSymbolicLink()||fs.realpathSync(spec.path)!==spec.path||s.nlink!==1||s.uid!==process.getuid()||(s.mode&0o777)!==0o600||s.size<1||s.size>5*1024*1024)fail();
    const fd=fs.openSync(spec.path,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const a=fs.fstatSync(fd),b=fs.readFileSync(fd),z=fs.fstatSync(fd);if(a.ino!==s.ino||a.dev!==s.dev||a.size!==z.size||a.mtimeMs!==z.mtimeMs||a.ctimeMs!==z.ctimeMs||hash(b)!==spec.sha256)fail();return b;}finally{fs.closeSync(fd);}};
  const bytes=read();return {bytes,check(){privateDir(path.dirname(spec.path));if(!read().equals(bytes))fail();}};
}
export async function stageIndependentRatioSnapshot({plan,now=new Date(),environ=process.env,evidenceRuntime,exposureCore=createRankedExposureCore()}={}){
  if(!exact(plan,['schema','workspace','evidence','recipient','previous'])||plan.schema!=='fee-console.ratio-snapshot-plan.v1'||['FEE_DATA_KEY','FEE_ECON_GIST_ID','GH_TOKEN','GITHUB_TOKEN','NODE_OPTIONS','NODE_PATH'].some(k=>Object.hasOwn(environ,k))||Object.keys(environ).some(k=>/^(DYLD_|LD_)/.test(k))||process.execArgv.some(a=>/^(?:--inspect(?:-brk|-wait)?|--(?:require|import|loader|experimental-loader|cpu-prof|heap-prof|trace-events-enabled|report-on-signal|report-on-fatalerror|heapsnapshot-signal)|-r)(?:=|$)/.test(a)||/^--heapsnapshot-near-heap-limit=(?!0$)/.test(a)))fail();
  privateDir(plan.workspace);const ep=pinned(plan.evidence),rp=pinned(plan.recipient),pp=plan.previous===null?null:pinned(plan.previous),evidencePlan=parse(ep.bytes);
  const ip=pinned(evidencePlan.input),op=pinned(evidencePlan.source),input=parse(ip.bytes),recipient=parse(rp.bytes),ratio=createFeeRatioCore(exposureCore,crypto.webcrypto),snapshot=createRatioSnapshotCore(ratio,exposureCore,createRatioSourceCore,parse,crypto.webcrypto);
  const sourceProof=readVerifiedBrowserEvidence({planPath:plan.evidence.path,expectedScopeId:recipient.scopeId,input,now,...(evidenceRuntime?{runtime:evidenceRuntime}:{}),exposureCore});
  const model=await buildRatioModel(input,{kind:'snapshot',targetDate:input.schema==='fee-console.ratio-sources.v2'?input.exposure.summary.asOf:input.book.asOf,feeAccountingThrough:null,now,browserEvidence:sourceProof,managerScopeId:recipient.scopeId,viewCore:ratio});
  const proof=await snapshot.verifyOriginal({originalBytes:new Uint8Array(op.bytes),inputBytes:new Uint8Array(ip.bytes),model,recipient,sourceSha256:evidencePlan.source.sha256,inputSha256:evidencePlan.input.sha256,libraryVersion:evidencePlan.library.version,now});
  const packet=await snapshot.candidate({model,recipient,proof,previous:pp?parse(pp.bytes):null,now}),out=path.join(plan.workspace,'ratio-independent-candidate');
  const check=()=>{ep.check();rp.check();pp?.check();ip.check();op.check();sourceProof.check();};check();if(fs.existsSync(out))fail();
  const validation={schema:'fee-console.ratio-snapshot-candidate-validation.v1',status:'RATIO_INDEPENDENT_CANDIDATE_ONLY',sourceDate:model.report.targetDate,sourceCapturedAt:packet.body.source.capturedAt,sourceExpiresAt:packet.body.source.expiresAt,sourceSha256:packet.body.source.sourceSha256,cipherSha256:await ratio.digest(packet.body.envelope),version:packet.body.version,publicationReady:false,managerAuthentication:false,feeOrHealthWrite:false,financialRead:false,keychainRead:false};
  let made=false;try{fs.mkdirSync(out,{mode:0o700});made=true;for(const [name,value]of [['fee-console-ratio-snapshot.candidate.json',packet],['ratio.envelope.json',packet.body.envelope],['validation.json',validation]]){check();fs.writeFileSync(path.join(out,name),JSON.stringify(value)+'\n',{flag:'wx',mode:0o600});}check();return validation;}
  catch{if(made){for(const name of ['fee-console-ratio-snapshot.candidate.json','ratio.envelope.json','validation.json']){const f=path.join(out,name);if(fs.existsSync(f)&&fs.lstatSync(f).isFile()&&!fs.lstatSync(f).isSymbolicLink())fs.unlinkSync(f);}if(!fs.readdirSync(out).length)fs.rmdirSync(out);}fail();}
}
async function main(){if(process.argv.length!==3||!path.isAbsolute(process.argv[2]))fail();privateDir(path.dirname(process.argv[2]));const st=fs.lstatSync(process.argv[2]);if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.uid!==process.getuid()||(st.mode&0o777)!==0o600||st.size<1||st.size>16384)fail();const spec={path:process.argv[2],sha256:hash(fs.readFileSync(process.argv[2]))},p=pinned(spec),plan=parse(p.bytes);if(plan.workspace!==path.dirname(spec.path))fail();p.check();const result=await stageIndependentRatioSnapshot({plan});p.check();console.log(result.status);}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(()=>{console.error('RATIO_SNAPSHOT_PACKET_REFUSED');process.exitCode=1;});
