// Original open-position evidence only. No network, credentials, encryption,
// source writes or authority to certify transactions or future IB cash flows.
import fs from 'node:fs';
import {createRatioSourceCore} from './fee-ratio-source-core.mjs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createLegacyPolicy} from './fee-legacy-policy.mjs';
import {createRankedExposureCore} from './xuan-ib-sharesight-exposure.mjs';

const ROOT=path.resolve(new URL('..',import.meta.url).pathname),accepted=new WeakSet();
const fail=()=>{throw Error('RATIO_BROWSER_EVIDENCE_REFUSED');};
const exact=(o,k)=>o&&typeof o==='object'&&!Array.isArray(o)&&Object.keys(o).sort().join(',')===[...k].sort().join(',');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const canonical=o=>Array.isArray(o)?'['+o.map(canonical).join(',')+']':o&&typeof o==='object'?'{'+Object.keys(o).sort().map(k=>JSON.stringify(k)+':'+canonical(o[k])).join(',')+'}':JSON.stringify(o);
const parse=b=>createLegacyPolicy().parseExactJson(b);
const key=r=>JSON.stringify([r.securityCode,r.market]);
const signed=n=>{if(typeof n!=='number'||!Number.isFinite(n)||Math.abs(n)>1e15)fail();return n;};
const amount=n=>{signed(n);if(n<0)fail();return n;};
const cents=n=>Math.round(amount(n)*100),near=(a,b)=>Math.abs(a-b)<=1e-7;
const time=s=>{if(typeof s!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(s)||!Number.isFinite(Date.parse(s)))fail();return Date.parse(s);};
const date=s=>typeof s==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(s)&&new Date(s+'T00:00:00Z').toISOString().slice(0,10)===s;
const total=rows=>rows.reduce((s,r)=>s+signed(r.valueUSD),0);
const normalize=s=>String(s).replaceAll('&amp;','&');
const hashScope=accounts=>sha(JSON.stringify(accounts.map(normalize).sort()));
const esc=s=>String(s).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');

function privateDir(p){
  if(typeof p!=='string'||!path.isAbsolute(p)||fs.realpathSync(p)!==p)fail();
  const s=fs.lstatSync(p);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid()||(s.mode&0o777)!==0o700)fail();
  for(let at=p;;at=path.dirname(at)){if(fs.existsSync(path.join(at,'.git')))fail();if(at===path.dirname(at))break;}
  const rel=path.relative(ROOT,p);if(rel!== '..'&&!rel.startsWith('..'+path.sep))fail();
  return s;
}
function frozen(spec,workspace){
  if(!exact(spec,['path','sha256'])||typeof spec.path!=='string'||!/^[a-f0-9]{64}$/.test(spec.sha256))fail();
  const rel=path.relative(workspace,spec.path);if(!rel||rel.startsWith('..')||path.isAbsolute(rel))fail();
  const read=()=>{
    for(let p=path.dirname(spec.path);;p=path.dirname(p)){privateDir(p);if(p===workspace)break;if(p===path.dirname(p))fail();}
    const st=fs.lstatSync(spec.path);if(!st.isFile()||st.isSymbolicLink()||fs.realpathSync(spec.path)!==spec.path||st.uid!==process.getuid()||st.nlink!==1||(st.mode&0o777)!==0o600||st.size<1||st.size>5*1024*1024)fail();
    const fd=fs.openSync(spec.path,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
    try{const a=fs.fstatSync(fd);if(a.ino!==st.ino||a.dev!==st.dev)fail();const b=fs.readFileSync(fd),z=fs.fstatSync(fd);if(a.size!==z.size||a.ctimeMs!==z.ctimeMs||a.mtimeMs!==z.mtimeMs||sha(b)!==spec.sha256)fail();return {bytes:b,ino:a.ino,dev:a.dev};}finally{fs.closeSync(fd);}
  };
  const first=read();return {...first,check(){const n=read();if(n.ino!==first.ino||n.dev!==first.dev||!n.bytes.equals(first.bytes))fail();}};
}
export function browserEvidenceRuntime(){return {uid:process.getuid(),readIdentity(file){
  if(process.platform!=='darwin')fail();
  const read=name=>execFileSync('/usr/bin/xattr',['-p',name,file],{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:5000,maxBuffer:4096}).trim();
  return {libraryFileId:read('user.library-file-id'),version:read('user.library-file-version')};
}};}

// Recompute from complete original arrays. A summary/audit JSON or caller
// verified=true marker is never an alternative to original source bytes.
export function verifyBrowserSourceAssociations(raw,input,options){return createRatioSourceCore(hashScope).verifyBrowserSourceAssociations(raw,input,options);}

export function readVerifiedBrowserEvidence({planPath,expectedScopeId,input,now=new Date(),runtime=browserEvidenceRuntime(),exposureCore=createRankedExposureCore()}={}){
  if(!/^[a-f0-9]{64}$/.test(expectedScopeId||''))fail();
  const workspace=path.dirname(planPath);privateDir(workspace);const st=fs.lstatSync(planPath);if(!st.isFile()||st.isSymbolicLink()||(st.mode&0o777)!==0o600||st.uid!==process.getuid()||st.nlink!==1||st.size>16384)fail();
  const fd=fs.openSync(planPath,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);let rawPlan;try{const a=fs.fstatSync(fd);if(a.ino!==st.ino||a.dev!==st.dev)fail();rawPlan=fs.readFileSync(fd);}finally{fs.closeSync(fd);}const plan=parse(rawPlan),pf=frozen({path:planPath,sha256:sha(rawPlan)},workspace);
  if(!exact(plan,['schema','workspace','source','input','library','managerScopeId','localOwnerUid'])||plan.schema!=='fee-console.ratio-browser-evidence-plan.v1'||plan.workspace!==workspace||plan.managerScopeId!==expectedScopeId||plan.localOwnerUid!==runtime.uid||runtime.uid!==process.getuid()||!exact(plan.library,['libraryFileId','version'])||!/^libfile_[a-f0-9]{32}$/.test(plan.library.libraryFileId)||!Number.isSafeInteger(plan.library.version)||plan.library.version<0)fail();
  const original=frozen(plan.source,workspace),data=frozen(plan.input,workspace);if(canonical(parse(data.bytes))!==canonical(input)||sha(original.bytes)!==input.book?.sourceSha256||input.book.provenance.fullSourceBytes!==original.bytes.length)fail();
  const identity=()=>{const x=runtime.readIdentity(plan.source.path);if(!exact(x,['libraryFileId','version'])||x.libraryFileId!==plan.library.libraryFileId||String(x.version)!==String(plan.library.version))fail();};identity();
  exposureCore.buildRankedExposureView(input.exposure);
  const facts=verifyBrowserSourceAssociations(parse(original.bytes),input,{scopeHash:exposureCore.ALL_TOGETHER_SCOPE_SHA256,now}),body={schema:'fee-console.ratio-browser-proof.v1',sourceSha256:plan.source.sha256,inputSha256:plan.input.sha256,library:plan.library,scopeId:expectedScopeId,localOwnerUid:plan.localOwnerUid,...facts};
  const freeze=v=>{if(v&&typeof v==='object'){for(const x of Object.values(v))freeze(x);Object.freeze(v);}return v;};freeze(body.companyExposure);
  const proof=Object.freeze({...body,associationId:sha(canonical(body)),inputCanonicalHash:sha(canonical(input)),check(){pf.check();original.check();data.check();identity();}});accepted.add(proof);proof.check();return proof;
}
export function consumeBrowserEvidence(proof,input,scopeId,now=new Date()){
  if(!proof||!accepted.has(proof)||proof.scopeId!==scopeId||proof.inputCanonicalHash!==sha(canonical(input))||proof.sourceSha256!==input.book?.sourceSha256||proof.asOf!==input.book.asOf)fail();
  const age=now.getTime()-time(proof.observedAt);if(age<0||age>36*3600000)fail();proof.check();
  return {associationId:proof.associationId,managerScopeId:proof.scopeId,sourceVersion:proof.library.version,migrationPending:proof.migrationPending,classificationDeltaCents:proof.classificationDeltaCents,exposureDeltaCents:proof.exposureDeltaCents,companyExposure:structuredClone(proof.companyExposure)};
}
