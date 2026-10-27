// Original open-position evidence only. No network, credentials, encryption,
// source writes or authority to certify transactions or future IB cash flows.
import fs from 'node:fs';
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
export function verifyBrowserSourceAssociations(raw,input,{scopeHash,now=new Date()}={}){
  if(!exact(input,['schema','exposure','book'])||input.schema!=='fee-console.ratio-sources.v1'||input.book?.schema!=='fee-console.ratio-sharesight-browser-book.v1')fail();
  const b=input.book,s=input.exposure?.summary,p=b.provenance;
  if(!raw||raw.schemaVersion!=='sharesight-private-full-v1'||raw.source?.provider!=='Sharesight'||raw.source.apiResponse!==false||raw.source.view!=='All Together'||!Array.isArray(raw.accounts)||raw.accounts.length!==10||hashScope(raw.accounts)!==scopeHash||hashScope(s.accounts)!==scopeHash)fail();
  const snap=raw.snapshot,coverage=raw.coverage;
  if(!snap||!date(snap.asOf)||snap.asOf!==b.asOf||snap.asOf!==s.asOf||snap.currency!=='USD'||b.currency!=='USD'||s.currency!=='USD'||!p||time(snap.observedAt)!==time(b.retrievedAt)||time(snap.observedAt)!==time(input.exposure.retrievedAt)||time(snap.exportCreatedAt)!==time(p.exportCreatedAt)||time(snap.exportReceivedAtFilesystem)!==time(p.exportLastWrittenAt)||time(snap.classificationSnapshotSavedAt)!==time(p.classificationSavedAt)||Math.floor(time(p.exportLastWrittenAt)/1000)*1000!==time(b.retrievedAt))fail();
  const clock=now.getTime(),captured=time(snap.observedAt);if(!Number.isFinite(clock)||clock<captured||clock-captured>36*3600000||[p.exportCreatedAt,p.exportLastWrittenAt,p.classificationSavedAt].some(t=>time(t)>clock))fail();
  if(!coverage||coverage.originalDirectPositionTableCompleteForObservedOpenScope!==true||coverage.allExportRowsIncluded!==true||coverage.closedPositionsIncluded!==false||coverage.transactionHistoryIncluded!==false||coverage.completeETFUniverseClaimed!==false||raw.readOnlySupplement?.mustNotSilentlyMergeIntoOriginalSnapshot!==true)fail();
  for(const k of ['directHoldingsConsolidated','directPositionsByAccount','cashAccounts','classTotals','fourClassTotals'])if(!Array.isArray(raw[k])||raw[k].length>5000)fail();
  if(raw.directHoldingsConsolidated.length!==coverage.directConsolidatedSecurities||raw.directPositionsByAccount.length!==coverage.directAccountPositions||raw.cashAccounts.length!==coverage.cashAccounts||raw.directPositionsByAccount.some(r=>r.holdingId!==null||r.valuationCurrency!=='USD'||!raw.accounts.includes(r.account))||raw.cashAccounts.some(r=>r.valuationCurrency!=='USD'||!raw.accounts.includes(r.account)))fail();
  const combined=new Map();for(const r of raw.directPositionsByAccount){amount(r.valueUSD);combined.set(key(r),(combined.get(key(r))||0)+r.valueUSD);}
  const consolidated=new Map(raw.directHoldingsConsolidated.map(r=>[key(r),r]));if(consolidated.size!==raw.directHoldingsConsolidated.length||consolidated.size!==combined.size||[...combined].some(([k,v])=>!consolidated.has(k)||cents(v)!==cents(consolidated.get(k).valueUSD)))fail();
  const original=raw.directPositionsByAccount.filter(r=>r.account==='IB-HK'),byKey=new Map(original.map(r=>[key(r),r]));
  if(b.ib===null||b.noah===null||original.length!==byKey.size||original.length!==b.ib.holdings.length)fail();
  for(const h of b.ib.holdings){const r=byKey.get(JSON.stringify([h.code,h.market]));if(!r||h.group!==r.sharesightCategory||cents(h.valueUSD)!==cents(r.valueUSD)||h.quantity!==r.quantity||h.name!==null&&h.name!==r.name)fail();}
  const ibCash=raw.cashAccounts.filter(r=>r.account==='IB-HK'),cashMap=new Map(ibCash.map(r=>[r.name,r]));
  if(ibCash.length!==cashMap.size||ibCash.length!==b.ib.cashRows.length||b.ib.cashRows.some(r=>!cashMap.has(r.label)||r.valueBasis!=='portfolio-usd-converted'||cents(r.valueUSD)!==cents(cashMap.get(r.label).valueUSD)))fail();
  const noah=raw.cashAccounts.filter(r=>r.account==='NOAH-HK');
  if(cents(total(original))!==cents(b.ib.holdingsValueUSD)||cents(total(ibCash))!==cents(b.ib.cashValueUSD)||cents(total(original)+total(ibCash))!==cents(b.ib.totalValueUSD)||!noah.length||b.noah.name!=='NOAH-HK'||b.noah.valueBasis!=='portfolio-usd-converted'||cents(total(noah))!==cents(b.noah.cashValueUSD))fail();
  const e=raw.exposure;if(!e||!Array.isArray(e.rows)||e.rows.length>100000||!Array.isArray(e.securitiesAggregatedFromExport)||e.securitiesAggregatedFromExport.length>100000||e.rows.length!==coverage.exposureExportRows||e.securitiesAggregatedFromExport.length!==coverage.exposureSecurityAggregateCount)fail();
  const counts={Direct:0,Underlying:0,Residual:0,Cash:0},agg=new Map(),rowIds=new Set();
  for(const r of e.rows){if(!Object.hasOwn(counts,r.ownership)||!raw.accounts.includes(r.account)||!Number.isSafeInteger(r.sourceRow)||r.sourceRow<1||rowIds.has(r.sourceRow))fail();rowIds.add(r.sourceRow);counts[r.ownership]++;signed(r.valueUSD);if(['Direct','Underlying'].includes(r.ownership)){const k=key(r);agg.set(k,(agg.get(k)||0)+r.valueUSD);}}
  for(const [k,v]of Object.entries(counts))if(v!==coverage['exposure'+k+'Rows'])fail();
  const sourceAgg=new Map(e.securitiesAggregatedFromExport.map(r=>[key(r),r]));if(sourceAgg.size!==agg.size||sourceAgg.size!==e.securitiesAggregatedFromExport.length||[...agg].some(([k,v])=>!sourceAgg.has(k)||!near(v,sourceAgg.get(k).valueUSD)))fail();
  for(const h of b.ib.holdings)if(h.valueBasis==='same-export-underlying-plus-residual'){
    const linked=e.rows.filter(r=>r.account==='IB-HK'&&(r.ownership==='Underlying'&&String(r.withinETF||'').split('.')[0]===h.code||r.ownership==='Residual'&&key(r)===JSON.stringify([h.code,h.market])));
    if(!linked.length||cents(total(linked))!==cents(h.valueUSD))fail();
  }
  const xlsx=Object.entries(raw.sourceFileSHA256||{}).filter(([k])=>k.toLowerCase().endsWith('.xlsx'));
  if(xlsx.length!==1||s.sourceXlsxSHA256!==xlsx[0][1]||s.source.url!==raw.source.exposureURL||cents(s.totalValueUSD)!==cents(snap.totalValueUSD))fail();
  const four=new Map(raw.fourClassTotals.map(r=>[r.name,r]));if(four.size!==4||s.classes.some(g=>!four.has(g.name)||cents(g.totalValueUSD)!==cents(four.get(g.name).valueUSD)))fail();
  for(const g of s.classes.slice(0,3)){
    const rows=raw.directHoldingsConsolidated.filter(r=>r.fourClass===g.name),top=[...rows].sort((a,b)=>b.valueUSD-a.valueUSD).slice(0,5),linked=[];
    for(const old of g.top5){const display=normalize(old.name).toLowerCase(),matches=rows.filter(r=>new RegExp('(?<![\\w])'+esc(String(r.securityCode).toLowerCase())+'(?![\\w])','u').test(display));if(matches.length!==1||cents(matches[0].valueUSD)!==cents(old.valueUSD))fail();linked.push(key(matches[0]));}
    if(new Set(linked).size!==5||top.some(r=>!linked.includes(key(r))))fail();
  }
  const secondary=new Map();for(const r of e.rows)if(r.fourClass==='二级市场'&&['Direct','Underlying'].includes(r.ownership))secondary.set(key(r),(secondary.get(key(r))||0)+r.valueUSD);
  const known=new Map((e.uiKnownAggregateDifferences||[]).map(r=>[key(r),r]));
  for(const r of known.values())if(!sourceAgg.has(key(r))||cents(sourceAgg.get(key(r)).valueUSD)!==cents(r.exportSumValueUSD))fail();
  const secondaryKeys=s.classes[3].top5.map(r=>key(r));if(new Set(secondaryKeys).size!==5||[...secondary].sort((a,b)=>b[1]-a[1]).slice(0,5).some(([k])=>!secondaryKeys.includes(k)))fail();
  for(const old of s.classes[3].top5){const k=key(old),v=secondary.get(k),ui=known.get(k);if(v===undefined||cents(old.valueUSD)!==cents(v)&&(!ui||cents(ui.originalUIValueUSD)!==cents(old.valueUSD)||cents(ui.exportSumValueUSD)!==cents(v)))fail();}
  if(cents(s.residualETFs.valueUSD)!==cents(e.residualValueUSD)||Math.abs(s.residualETFs.weightTotalPct-e.residualWeightTotalPct)>.0051||Math.abs(s.residualETFs.weightSecondaryClassPct-e.residualWeightSecondaryPct)>.0051||cents(total(e.rows))!==cents(e.exportRowsTotalUSD)||Math.round((total(e.rows)-snap.totalValueUSD)*100)!==Math.round(e.roundingDeltaVersusOriginalPortfolioUSD*100)||cents(total([...raw.directPositionsByAccount,...raw.cashAccounts]))!==cents(coverage.directPlusCashRowsValueUSD)||Math.round((total(raw.classTotals)-snap.totalValueUSD)*100)!==Math.round(coverage.directPlusCashRoundingDeltaVersusReportedTotalUSD*100))fail();
  return {observedAt:new Date(captured).toISOString(),asOf:snap.asOf,migrationPending:raw.transferReconciliation?.receiptConfirmed!==true,classificationDeltaCents:Math.round((total(raw.classTotals)-snap.totalValueUSD)*100),exposureDeltaCents:Math.round(e.roundingDeltaVersusOriginalPortfolioUSD*100)};
}

export function readVerifiedBrowserEvidence({planPath,expectedScopeId,input,now=new Date(),runtime=browserEvidenceRuntime(),exposureCore=createRankedExposureCore()}={}){
  if(!/^[a-f0-9]{64}$/.test(expectedScopeId||''))fail();
  const workspace=path.dirname(planPath);privateDir(workspace);const st=fs.lstatSync(planPath);if(!st.isFile()||st.isSymbolicLink()||(st.mode&0o777)!==0o600||st.uid!==process.getuid()||st.nlink!==1||st.size>16384)fail();
  const fd=fs.openSync(planPath,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);let rawPlan;try{const a=fs.fstatSync(fd);if(a.ino!==st.ino||a.dev!==st.dev)fail();rawPlan=fs.readFileSync(fd);}finally{fs.closeSync(fd);}const plan=parse(rawPlan),pf=frozen({path:planPath,sha256:sha(rawPlan)},workspace);
  if(!exact(plan,['schema','workspace','source','input','library','managerScopeId','localOwnerUid'])||plan.schema!=='fee-console.ratio-browser-evidence-plan.v1'||plan.workspace!==workspace||plan.managerScopeId!==expectedScopeId||plan.localOwnerUid!==runtime.uid||runtime.uid!==process.getuid()||!exact(plan.library,['libraryFileId','version'])||!/^libfile_[a-f0-9]{32}$/.test(plan.library.libraryFileId)||!Number.isSafeInteger(plan.library.version)||plan.library.version<0)fail();
  const original=frozen(plan.source,workspace),data=frozen(plan.input,workspace);if(canonical(parse(data.bytes))!==canonical(input)||sha(original.bytes)!==input.book?.sourceSha256||input.book.provenance.fullSourceBytes!==original.bytes.length)fail();
  const identity=()=>{const x=runtime.readIdentity(plan.source.path);if(!exact(x,['libraryFileId','version'])||x.libraryFileId!==plan.library.libraryFileId||String(x.version)!==String(plan.library.version))fail();};identity();
  exposureCore.buildRankedExposureView(input.exposure);
  const facts=verifyBrowserSourceAssociations(parse(original.bytes),input,{scopeHash:exposureCore.ALL_TOGETHER_SCOPE_SHA256,now}),body={schema:'fee-console.ratio-browser-proof.v1',sourceSha256:plan.source.sha256,inputSha256:plan.input.sha256,library:plan.library,scopeId:expectedScopeId,localOwnerUid:plan.localOwnerUid,...facts};
  const proof=Object.freeze({...body,associationId:sha(canonical(body)),inputCanonicalHash:sha(canonical(input)),check(){pf.check();original.check();data.check();identity();}});accepted.add(proof);proof.check();return proof;
}
export function consumeBrowserEvidence(proof,input,scopeId,now=new Date()){
  if(!proof||!accepted.has(proof)||proof.scopeId!==scopeId||proof.inputCanonicalHash!==sha(canonical(input))||proof.sourceSha256!==input.book?.sourceSha256||proof.asOf!==input.book.asOf)fail();
  const age=now.getTime()-time(proof.observedAt);if(age<0||age>36*3600000)fail();proof.check();
  return {associationId:proof.associationId,managerScopeId:proof.scopeId,sourceVersion:proof.library.version,migrationPending:proof.migrationPending,classificationDeltaCents:proof.classificationDeltaCents,exposureDeltaCents:proof.exposureDeltaCents};
}
