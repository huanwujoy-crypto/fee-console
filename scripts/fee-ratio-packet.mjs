#!/usr/bin/env node
// Existing private-file handoff -> manager-recipient ciphertext. No Keychain,
// financial calls, network, Gist write, fee write, workflow or publication.
import fs from 'node:fs';
import {createRatioSourceCore} from './fee-ratio-source-core.mjs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createRankedExposureCore} from './xuan-ib-sharesight-exposure.mjs';
import {createFeeRatioCore} from './fee-ratio-management.mjs';
import {validateFeeCalculationReceipt,canonicalJson} from './fee-receipt-core.mjs';
import {buildIbOwnerBaseline} from './ib-manager-return.mjs';
import {ibBaselineBusinessHash,validateIbBootstrapCoverage} from './ib-manager-source.mjs';
import {readVerifiedBrowserEvidence,consumeBrowserEvidence} from './fee-ratio-browser-evidence.mjs';
import {createLegacyPolicy} from './fee-legacy-policy.mjs';
import {parseSharesightStockAllocation,parseSharesightCash,STOCK_CLASS_TARGETS} from './xuan-ib-sharesight-allocation.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const fail=()=>{throw Error('RATIO_PACKET_REFUSED');};
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
const iso=d=>typeof d==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(d)&&new Date(d+'T00:00:00Z').toISOString().slice(0,10)===d;
const parse=bytes=>createLegacyPolicy().parseExactJson(bytes);
const core=createFeeRatioCore(createRankedExposureCore(),crypto.webcrypto);
// Preserved browser evidence is a distinct transport, never an API-shaped
// report with invented identifiers. Parsing is not source authentication.
export function buildBrowserRatioBook(input,targetDate){return createRatioSourceCore().buildBrowserRatioBook(input,targetDate);}

export function buildRatioBook(input,targetDate){
  if(input===null)return null;
  if(['fee-console.ratio-sharesight-browser-book.v1','fee-console.ratio-sharesight-browser-book.v2'].includes(input.schema))return buildBrowserRatioBook(input,targetDate);
  if(!exact(input,['schema','source','asOf','retrievedAt','sourceSha256','ib','noah'])||input.schema!=='fee-console.ratio-sharesight-book.v1'||input.source!=='Sharesight'||input.asOf!==targetDate||!/^[a-f0-9]{64}$/.test(input.sourceSha256||''))fail();
  const source=(s,name)=>{
    if(s===null)return null;
    if(!exact(s,['portfolio','performance'])||!exact(s.portfolio,['id','name','currency'])||s.portfolio.name!==name||s.portfolio.currency!=='USD'||!Number.isSafeInteger(s.portfolio.id)||s.portfolio.id<=0||s.performance?.report?.end_date!==targetDate||s.performance.report.currency?.code!=='USD'||s.performance.report.portfolio_id!==s.portfolio.id||!Array.isArray(s.performance.report.holdings)||!Array.isArray(s.performance.report.cash_accounts)||s.performance.next_page||s.performance.links?.next||s.performance.report.next_page||s.performance.report.truncated===true||s.performance.report.holdings.length>5000||new Set(s.performance.report.holdings.map(h=>h.id)).size!==s.performance.report.holdings.length)fail();
    return s;
  };
  const ib=source(input.ib,'IB-HK'),noah=source(input.noah,'NOAH-HK');
  let allocation=null,holdings=null;
  if(ib){
    const a=parseSharesightStockAllocation(ib.performance,{portfolioId:ib.portfolio.id});
    allocation={totalCents:Math.round(a.total*100),categories:a.categories.map(c=>({label:c.label,valueCents:Math.round(c.marketValue*100),targetPct:c.targetPct})),usscCents:Math.round(a.ussc*100),cashLike:a.cashLike.items.map(c=>({symbol:c.symbol,valueCents:Math.round(c.amount*100)}))};
    holdings=ib.performance.report.holdings.map(h=>{if(typeof h.instrument?.name!=='string'||!h.instrument.name||typeof h.instrument?.code!=='string')fail();return {name:h.instrument.name,symbol:h.instrument.code,valueCents:Math.round(h.value*100),category:h.group_name};});
  }
  const cash=s=>s===null?null:Math.round(parseSharesightCash(s.performance,{portfolioId:s.portfolio.id}).total*100);
  return {source:'Sharesight',asOf:input.asOf,retrievedAt:input.retrievedAt,sourceSha256:input.sourceSha256,ibCashCents:cash(ib),noahCashCents:cash(noah),allocation,holdings};
}
export async function buildRatioModel(input,{kind,targetDate,feeAccountingThrough=null,now=new Date(),viewCore=core,previewOnly=false,browserEvidence=null,managerScopeId=null}={}){
  if(!iso(targetDate)||!(feeAccountingThrough===null||iso(feeAccountingThrough))||!['snapshot','weekly','monthly','weekly-monthly'].includes(kind))fail();
  const official=input?.schema==='fee-console.ratio-sources.v2',wrapped=official||input?.schema==='fee-console.ratio-sources.v1';
  if(wrapped&&!exact(input,['schema','exposure','book',...(official?['classification']:[])]))fail();
  const browser=wrapped&&['fee-console.ratio-sharesight-browser-book.v1','fee-console.ratio-sharesight-browser-book.v2'].includes(input.book?.schema),verified=browser&&browserEvidence?consumeBrowserEvidence(browserEvidence,input,managerScopeId,now):null;
  if(browser&&!previewOnly&&!verified)fail();
  if(wrapped&&input.book!==null){const at=Date.parse(input.book.retrievedAt);if(!Number.isFinite(at)||at>now.getTime()||now.getTime()-at>36*3600000)fail();}
  const exposure=wrapped?input.exposure:input,view=createRankedExposureCore().buildRankedExposureView(exposure);
  if(view.valuationDate!==targetDate||!view.retrievedAt||Date.parse(view.retrievedAt)>now.getTime()||now.getTime()-Date.parse(view.retrievedAt)>36*3600000||Math.floor((Date.parse(now.toISOString().slice(0,10))-Date.parse(targetDate))/86400000)>7)fail();
  const model={schema:official?'fee-console.ratio-view.v2':core.SCHEMA,source:'Sharesight',report:{kind,targetDate,feeAccountingThrough,generatedAt:now.toISOString()},exposure:structuredClone(exposure),book:buildRatioBook(wrapped?input.book:null,official?input.book.asOf:targetDate),...(official?{sourceDates:{classification:input.book.asOf,exposure:input.exposure.summary.asOf},classificationSummary:structuredClone(input.classification)}:{}),limitations:['CALL／资本承诺字段尚无已验收的 Sharesight 读取契约；预留和净预算保持未知。','没有完整订单来源，不生成成交后投影或可执行预算；不恢复券商／Flex／邮件读取。','All Together 十账户用于比例管理，不扩大原管理费计费组合。']};
  if(verified){const {companyExposure,sourceDates,classificationSummary,...association}=verified;model.book.browserEvidence={...model.book.browserEvidence,integrity:'verified-original-library-association',...association};model.companyExposure=companyExposure;if(official){model.sourceDates=sourceDates;model.classificationSummary=classificationSummary;}}
  const result=await viewCore.validateModel(model);browserEvidence?.check();return result;
}
// The sole daily writer constructs the official envelope itself. An opaque
// externally encrypted candidate is never accepted as source/health proof.
export async function attachIbBootstrap(data,baselineInput,coverage){
  if(data.ibManagerSourceState||data.ibManagerBaselineState||data.ibManagerCoverageState)fail();
  const expected=ibBaselineBusinessHash(baselineInput.periodReturnsInput),state=await buildIbOwnerBaseline(data,baselineInput,expected);
  const audit=validateIbBootstrapCoverage(coverage,expected,{baselineAsOf:baselineInput.periodReturnsInput.to});
  return {...data,ibManagerBaselineState:state,ibManagerCoverageState:audit};
}
export async function attachRatioToPayload(data,input,recipient,{kind,sourceDate,now=new Date(),scopeId,viewCore=core,browserEvidence=null}={}){
  const fee=data?.feeCalculationReceipt;
  if(!validateFeeCalculationReceipt(fee,data).ok||!iso(sourceDate)||sourceDate>fee.asOf)fail();
  const r=await viewCore.validateRecipient(recipient,scopeId);
  const model=await buildRatioModel(input,{kind,targetDate:sourceDate,feeAccountingThrough:fee.asOf,now,viewCore,browserEvidence,managerScopeId:scopeId});
  const old=data.ratioManagerEnvelope,previousCipherSha256=old?await viewCore.digest(old):null;
  const binding={schema:'fee-console.ratio-binding.v1',revision:crypto.randomUUID(),previousCipherSha256,feeReceiptId:fee.receiptId,feeAsOf:fee.asOf,sourceDate};
  if(data.ratioManagerPublication){
    const p=data.ratioManagerPublication;
    if(p.cipherSha256!==previousCipherSha256||p.binding.sourceDate>sourceDate||p.binding.feeAsOf>fee.asOf||p.generatedAt>now.toISOString())fail();
  }else if(old)fail();
  const envelope=await viewCore.seal(model,r,binding),publication=await viewCore.publication(envelope,model);
  await viewCore.validatePublication(envelope,publication,fee);
  const after={...data,ratioManagerEnvelope:envelope,ratioManagerPublication:publication};
  const strip=v=>Object.fromEntries(Object.entries(v).filter(([k])=>!['ratioManagerEnvelope','ratioManagerPublication'].includes(k)));
  if(canonicalJson(strip(data))!==canonicalJson(strip(after))||!validateFeeCalculationReceipt(fee,after).ok)fail();
  return after;
}
export function prepareRatioAttachment(options={}){return preparePrivateAttachment({...options,bootstrapOnly:false});}
export function prepareIbBootstrapAttachment(options={}){return preparePrivateAttachment({...options,bootstrapOnly:true});}
async function preparePrivateAttachment({file,inputFile,recipientFile,outputFile,kind,sourceDate,scopeId,keyText,baselineFile=null,coverageFile=null,browserEvidenceFile=null,evidenceContext=undefined,execute=false,environ=process.env,now=new Date(),viewCore=core,bootstrapOnly}={}){
  if(!!baselineFile!==!!coverageFile)fail();
  if(bootstrapOnly){if(!baselineFile||[inputFile,recipientFile,kind,sourceDate,scopeId,browserEvidenceFile,evidenceContext].some(v=>v!==undefined&&v!==null))fail();}
  else if(!/^[a-f0-9]{64}$/.test(scopeId||''))fail();
  if(/^(true|1)$/i.test(String(environ.GITHUB_ACTIONS||''))||typeof keyText!=='string'||!/^[A-Za-z0-9_+/-]{43}={0,2}$/.test(keyText))fail();
  const dir=privateDirectory(path.dirname(file)),spec=p=>{if(path.dirname(p)!==dir)fail();const st=fs.lstatSync(p);if(!st.isFile()||st.isSymbolicLink()||fs.realpathSync(p)!==p||st.uid!==process.getuid()||(st.mode&0o777)!==0o600||st.size<1||st.size>5*1024*1024)fail();const fd=fs.openSync(p,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);let raw;try{const at=fs.fstatSync(fd);if(at.ino!==st.ino||at.dev!==st.dev)fail();raw=fs.readFileSync(fd);}finally{fs.closeSync(fd);}return frozenFile({path:p,sha256:hash(raw)},dir);};
  const base=spec(file),input=bootstrapOnly?null:spec(inputFile),recipient=bootstrapOnly?null:spec(recipientFile),baseline=baselineFile?spec(baselineFile):null,coverage=coverageFile?spec(coverageFile):null,outer=parse(base.bytes),key=Buffer.from(keyText.replace(/-/g,'+').replace(/_/g,'/'),'base64');
  if(key.length!==32||!exact(outer,['enc','v','data'])||outer.enc!==true||outer.v!==3||typeof outer.data!=='string')fail();
  const decode=data=>{const b=Buffer.from(data,'base64');if(b.length<29||b.toString('base64')!==data)fail();const d=crypto.createDecipheriv('aes-256-gcm',key,b.subarray(0,12));d.setAuthTag(b.subarray(-16));const plain=Buffer.concat([d.update(b.subarray(12,-16)),d.final()]);try{return parse(plain);}finally{plain.fill(0);}};
  try{
    const sourceInput=input?parse(input.bytes):null,browserEvidence=browserEvidenceFile?readVerifiedBrowserEvidence({...evidenceContext,planPath:browserEvidenceFile,expectedScopeId:scopeId,input:sourceInput,now}):null;
    const before=decode(outer.data);
    if(!validateFeeCalculationReceipt(before.feeCalculationReceipt,before).ok)fail();
    const seeded=baseline?await attachIbBootstrap(before,parse(baseline.bytes),parse(coverage.bytes)):before,after=bootstrapOnly?seeded:await attachRatioToPayload(seeded,sourceInput,parse(recipient.bytes),{kind,sourceDate,scopeId,now,viewCore,browserEvidence});
    const checks=()=>{base.check();input?.check();recipient?.check();baseline?.check();coverage?.check();browserEvidence?.check();};
    checks();if(!execute)return {status:bootstrapOnly?'IB_BOOTSTRAP_DRY_RUN_OK':'RATIO_ATTACHMENT_DRY_RUN_OK'};
    if(!path.isAbsolute(outputFile)||path.dirname(path.dirname(outputFile))!==dir||path.basename(outputFile)!=='data.json'||fs.existsSync(outputFile)||privateDirectory(path.dirname(outputFile))!==path.dirname(outputFile))fail();
    const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key,iv),plain=Buffer.from(JSON.stringify(after));let packed;
    try{packed=Buffer.concat([iv,cipher.update(plain),cipher.final(),cipher.getAuthTag()]);}finally{plain.fill(0);}
    if(canonicalJson(decode(packed.toString('base64')))!==canonicalJson(after))fail();
    const encoded=JSON.stringify({enc:true,v:3,data:packed.toString('base64')})+'\n';checks();
    fs.writeFileSync(outputFile,encoded,{flag:'wx',mode:0o600});if(fs.readFileSync(outputFile,'utf8')!==encoded)fail();return {status:bootstrapOnly?'IB_BOOTSTRAP_ENCRYPTED_CANDIDATE_PREPARED':'RATIO_ATTACHMENT_ENCRYPTED_CANDIDATE_PREPARED'};
  }finally{key.fill(0);}
}
function privateDirectory(p){
  if(typeof p!=='string'||!path.isAbsolute(p))fail();const s=fs.lstatSync(p),r=fs.realpathSync(p),rel=path.relative(ROOT,r);
  if(!s.isDirectory()||s.isSymbolicLink()||r!==p||s.uid!==process.getuid()||(s.mode&0o777)!==0o700||!(rel==='..'||rel.startsWith('..'+path.sep)))fail();
  for(let at=r;;at=path.dirname(at)){if(fs.existsSync(path.join(at,'.git')))fail();if(at===path.dirname(at))break;}return r;
}
function frozenFile(spec,dir){
  if(!exact(spec,['path','sha256'])||path.dirname(spec.path||'')!==dir||!/^[a-f0-9]{64}$/.test(spec.sha256||''))fail();
  const read=()=>{privateDirectory(dir);const s=fs.lstatSync(spec.path);if(!s.isFile()||s.isSymbolicLink()||fs.realpathSync(spec.path)!==spec.path||s.uid!==process.getuid()||(s.mode&0o777)!==0o600||s.size<1||s.size>5*1024*1024)fail();const fd=fs.openSync(spec.path,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const a=fs.fstatSync(fd);if(a.ino!==s.ino||a.dev!==s.dev)fail();const b=fs.readFileSync(fd),z=fs.fstatSync(fd);if(a.size!==z.size||a.ctimeMs!==z.ctimeMs||a.mtimeMs!==z.mtimeMs||hash(b)!==spec.sha256)fail();return b;}finally{fs.closeSync(fd);}};
  const bytes=read();return {bytes,check(){if(privateDirectory(dir)!==dir||!read().equals(bytes))fail();}};
}
export async function stageRatioPacket({plan,checkPlan=()=>{},now=new Date(),environ=process.env,viewCore=core}={}){
  if(!exact(plan,['schema','workspace','kind','targetDate','feeAccountingThrough','scopeId','input','recipient'])||plan.schema!=='fee-console.ratio-stage-plan.v1'||!/^[a-f0-9]{64}$/.test(plan.scopeId||'')||['FEE_DATA_KEY','FEE_ECON_GIST_ID','GH_TOKEN','GITHUB_TOKEN','NODE_OPTIONS','NODE_PATH'].some(k=>Object.hasOwn(environ,k)))fail();
  const diagnostic=a=>/^(?:--inspect(?:-brk|-wait)?|--(?:require|import|loader|experimental-loader|cpu-prof|heap-prof|trace-events-enabled|report-on-signal|report-on-fatalerror|heapsnapshot-signal)|-r)(?:=|$)/.test(a)||/^--heapsnapshot-near-heap-limit=(?!0$)/.test(a);
  if(process.execArgv.some(diagnostic)||Object.keys(environ).some(n=>/^(DYLD_|LD_)/.test(n)))fail();
  const dir=privateDirectory(plan.workspace),input=frozenFile(plan.input,dir),recipient=frozenFile(plan.recipient,dir),out=path.join(dir,'ratio-candidate');
  if(fs.existsSync(out))fail();checkPlan();
  const model=await buildRatioModel(JSON.parse(input.bytes),{kind:plan.kind,targetDate:plan.targetDate,feeAccountingThrough:plan.feeAccountingThrough,now,viewCore,previewOnly:true}),r=await viewCore.validateRecipient(JSON.parse(recipient.bytes),plan.scopeId),envelope=await viewCore.seal(model,r);
  input.check();recipient.check();checkPlan();let created=false;
  try{
    fs.mkdirSync(out,{mode:0o700});created=true;const file=path.join(out,'ratio.envelope.json');fs.writeFileSync(file,JSON.stringify(envelope)+'\n',{mode:0o600,flag:'wx'});
    const result={schema:'fee-console.ratio-stage-validation.v1',status:'RATIO_MANAGER_CANDIDATE_ONLY',targetDate:plan.targetDate,source:'Sharesight',recipientId:r.recipientId,cipherSha256:hash(fs.readFileSync(file)),financialRead:false,keychainRead:false,feeOrIbWrite:false,publicationReady:false};
    input.check();recipient.check();checkPlan();fs.writeFileSync(path.join(out,'validation.json'),JSON.stringify(result,null,2)+'\n',{mode:0o600,flag:'wx'});return result;
  }catch{if(created){for(const name of ['ratio.envelope.json','validation.json']){const f=path.join(out,name);if(fs.existsSync(f)&&fs.lstatSync(f).isFile()&&!fs.lstatSync(f).isSymbolicLink())fs.unlinkSync(f);}if(!fs.readdirSync(out).length)fs.rmdirSync(out);}fail();}
}
async function main(){
  if(process.argv.length!==3||!path.isAbsolute(process.argv[2]))fail();const p=process.argv[2],dir=privateDirectory(path.dirname(p)),s=fs.lstatSync(p);if(!s.isFile()||s.isSymbolicLink()||(s.mode&0o777)!==0o600||s.uid!==process.getuid()||s.size>16384)fail();
  const raw=fs.readFileSync(p),plan=JSON.parse(raw);if(plan.workspace!==dir)fail();const result=await stageRatioPacket({plan,checkPlan(){if(!fs.readFileSync(p).equals(raw)||fs.lstatSync(p).isSymbolicLink())fail();}});console.log(result.status);
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(()=>{console.error('RATIO_PACKET_REFUSED');process.exitCode=1;});
