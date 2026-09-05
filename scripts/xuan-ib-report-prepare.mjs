#!/usr/bin/env node
// Existing read-only connector tools produce the view + source evidence.
// Prepares and guards a candidate; the operational command freshly reads the
// trusted policy via Git. No broker APIs, financial writes, scheduler changes
// or publication claims. Pure API snapshots are test seams, not release proof.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { renderReport, reportHtmlBlob, validateReportView } from './xuan-ib-report-view.mjs';
import { parseDecisionJson } from './xuan-ib-decision-menu.mjs';
import { assessSourceReadiness, fingerprint } from './xuan-ib-run-manifest.mjs';
import { startJournalStage, finishJournalStage, showRunJournal } from './xuan-ib-run-clock.mjs';
import { getManualConsentRunId, validateManualConsentProof, consumeManualConsent } from './xuan-ib-manual-consent.mjs';
import { loadTrustedAssociationPolicy, validateAssociationReceipt } from './xuan-ib-account-association.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
// Strict parser first rejects duplicate keys/depth abuse; normalize its
// null-prototype containers for existing plain-JSON contract validators.
const read=file=>JSON.parse(JSON.stringify(parseDecisionJson(fs.readFileSync(file,'utf8'),2_000_000)));
const fail=message=>{throw new Error(`Report prepare: ${message}`);};
const copy=value=>JSON.parse(JSON.stringify(value));
const COMPACT_CRITICAL_IB=['accountSummary','balances','orders','trades'];
const COMPACT_UPSTREAM=['bootstrap','ib-read','sharesight-read','validate','derive','narrative'];
const SOURCE_INSTANT=/(?:Z|[+-]\d{2}:\d{2})$/i;
const sourceHktDate=value=>/^\d{4}-\d{2}-\d{2}$/.test(value)
  ? value : new Date(Date.parse(value)+8*60*60_000).toISOString().slice(0,10);

function requireCompactFreshSources(evidence,registry,readiness){
  // Compact v1 is deliberately stricter than the global manifest policy: it
  // has no per-card availability map, so one missing critical endpoint could
  // otherwise leave unrelated-looking current numbers or PASS prose visible.
  for(const endpoint of COMPACT_CRITICAL_IB){
    if(evidence.sources.ib[endpoint].status!=='ok')fail(`compact report requires direct IB ${endpoint}`);
  }
  if(!['ib','sharesight-ib-hk'].includes(readiness.positionSource))fail('compact report requires direct positions or the approved IB-HK fallback');
  if(readiness.positionSource==='ib'&&evidence.sources.ib.positions.status!=='ok')fail('direct positions source is not usable');
  if(readiness.positionSource==='sharesight-ib-hk'&&!['failed','unavailable'].includes(evidence.sources.ib.positions.status)){
    fail('IB positions fallback must be derived from an unavailable direct endpoint');
  }

  for(const endpoint of [...COMPACT_CRITICAL_IB,'positions']){
    const source=evidence.sources.ib[endpoint];
    if(source.status!=='ok')continue;
    if(!SOURCE_INSTANT.test(source.asOf))fail(`direct IB ${endpoint} needs an RFC 3339 read instant`);
    if(sourceHktDate(source.asOf)!==evidence.dataDate)fail(`direct IB ${endpoint} is not fresh for the report date`);
  }

  const byPortfolio=new Map(evidence.sources.sharesight.map(source=>[source.portfolioId,source]));
  for(const portfolio of registry.portfolios.filter(item=>item.requiredEachReport)){
    const source=byPortfolio.get(portfolio.portfolioId);
    // The registry contains no approved fallback for an individual Sharesight
    // portfolio. Retried final success is `ok`; fallback is not fresh evidence.
    if(!source||source.status!=='ok')fail(`required Sharesight portfolio ${portfolio.portfolioId} is not fresh and direct`);
    if(sourceHktDate(source.asOf)!==evidence.dataDate)fail(`required Sharesight portfolio ${portfolio.portfolioId} is not fresh for the report date`);
  }
  if(readiness.positionSource==='sharesight-ib-hk'){
    const ibHk=byPortfolio.get(936247);
    if(!ibHk||ibHk.status!=='ok'||!Number.isInteger(ibHk.completedUsTradingDayLag)||ibHk.completedUsTradingDayLag>1){
      fail('approved IB-HK positions fallback is outside its completed-trading-day freshness limit');
    }
  }
}

function requireCompactUpstreamJournal(journalPath,readiness){
  const snapshot=showRunJournal(journalPath),byStage=new Map(snapshot.stages.map(stage=>[stage.name,stage]));
  for(const name of COMPACT_UPSTREAM){
    const stage=byStage.get(name);
    if(!stage)fail(`upstream journal stage ${name} is missing or still running`);
    if(['bootstrap','sharesight-read','validate','derive'].includes(name)&&stage.status!=='ok'){
      fail(`upstream journal stage ${name} must be ok`);
    }
    if(name==='ib-read'){
      const fallback=readiness.positionSource==='sharesight-ib-hk';
      const allowed=fallback
        ? stage.status==='degraded'&&stage.errorCode==='IB_POSITIONS_FALLBACK'
        : stage.status==='ok';
      if(!allowed)fail('upstream journal stage ib-read contradicts direct/fallback source state');
    }
    if(name==='narrative'&&!(stage.status==='ok'
      || (stage.status==='degraded'&&stage.errorCode==='NARRATIVE_REDUCED'))){
      fail('upstream journal stage narrative must be ok or explicitly NARRATIVE_REDUCED');
    }
  }
}

export function prepareReport(viewInput,evidence,{previousHtml,previousMeta,policy,registry,journalPath=null,manualConsentStore=null,associationSnapshot=null,now=null}={}){
  const required=['schemaVersion','edition','dataDate','previousSourceSha','sources'];
  if(!evidence || Object.keys(evidence).sort().join('|')!==required.sort().join('|') || evidence.schemaVersion!==1)fail('invalid source evidence envelope');
  if(evidence.dataDate!==viewInput.dataDate||evidence.edition!==viewInput.edition||evidence.previousSourceSha!==previousMeta.sourceSha)fail('view/evidence/prior publication mismatch');
  const manual=Object.hasOwn(evidence.sources?.ib||{},'manualConsent');
  const association=evidence.sources?.ib?.accountAssociation??null;
  if(manual&&association)fail('manual and recurring account association are mutually exclusive');
  if(evidence.edition==='adhoc'&&!associationSnapshot)fail('current account association policy snapshot is required');
  if(evidence.edition==='adhoc'&&associationSnapshot.policy.status!=='inactive'&&!association)fail('selected recurring policy requires account association receipt');
  let runId;
  if(association){
    if(!journalPath||manualConsentStore!==null)fail('recurring association needs its own journal, never the manual consent store');
    runId=getManualConsentRunId(journalPath);
    validateAssociationReceipt(association,associationSnapshot,{edition:evidence.edition,previousSourceSha:previousMeta.sourceSha,runId,now:now??Date.now()});
    const snapshot=showRunJournal(journalPath),bootstrap=snapshot.stages.find(item=>item.name==='bootstrap');
    if(!bootstrap||bootstrap.status!=='ok'||Date.parse(association.policyCheckedAt)<Date.parse(bootstrap.endedAt))fail('recurring policy check must follow completed bootstrap');
    for(const [stageName,sources] of [['ib-read',Object.values(evidence.sources.ib).filter(item=>item&&typeof item==='object'&&Object.hasOwn(item,'readStartedAt'))],['sharesight-read',evidence.sources.sharesight]]){
      const stage=snapshot.stages.find(item=>item.name===stageName);
      if(!stage||Date.parse(stage.startedAt)<=Date.parse(association.policyCheckedAt))fail('financial reads must follow the recurring policy check');
      for(const source of sources){
        const endedAt=source?.asOf??source?.attemptCompletedAt;
        if(!source||!Number.isFinite(Date.parse(source.readStartedAt))||!Number.isFinite(Date.parse(endedAt))||Date.parse(source.readStartedAt)<Date.parse(stage.startedAt)||Date.parse(endedAt)>Date.parse(stage.endedAt)||Date.parse(endedAt)>(now??Date.now()))fail('recurring source receipt outside journal read stage');
      }
    }
  }
  if(manual){
    if(!journalPath||!manualConsentStore)fail('manual consent requires journal and private store');
    const snapshot=showRunJournal(journalPath);
    runId=getManualConsentRunId(journalPath);
    const proof=evidence.sources.ib.manualConsent;
    validateManualConsentProof(proof,{journalRunId:runId,previousSourceSha:previousMeta.sourceSha,edition:evidence.edition,requireUnexpired:true,now:now??Date.now()});
    const ibStage=snapshot.stages.find(stage=>stage.name==='ib-read');
    if(!ibStage)fail('manual consent requires completed IB read stage');
    for(const endpoint of [...COMPACT_CRITICAL_IB,'positions']){
      const source=evidence.sources.ib[endpoint];
      if(!source||Date.parse(source.readStartedAt)<Date.parse(ibStage.startedAt)||Date.parse(source.asOf)>Date.parse(ibStage.endedAt)||Date.parse(source.asOf)>(now??Date.now()))fail('manual IB receipt outside journal read stage');
    }
  }else if(manualConsentStore!==null){fail('private manual store supplied for a native-account report');}
  const readiness=assessSourceReadiness(evidence.sources,registry,{edition:evidence.edition,previousSourceSha:evidence.previousSourceSha,runId,associationSnapshot:association?associationSnapshot:undefined,now:now??Date.now()});
  if(readiness.blocked)fail(`publication blocked: ${readiness.issues.join(',')}`);
  requireCompactFreshSources(evidence,registry,readiness);
  const view=copy(viewInput);
  const expected=({ib:'ok','sharesight-ib-hk':'fallback',unavailable:'unavailable'})[readiness.positionSource];
  if(view.holdings.status!==expected)fail('holdings status contradicts source evidence');
  if(expected==='ok' && (!view.holdings.asOfHkt.startsWith(view.dataDate+' ')||view.holdings.authoritativeValueUsd===null))fail('direct holdings require current read time and authoritative value');
  if(expected==='ok'&&view.holdings.authoritativeValueUsd>0&&!view.holdings.rows.length)fail('positive direct authoritative holdings require at least one holding row');
  if(expected==='unavailable' && (view.holdings.rows.length||view.holdings.authoritativeValueUsd!==null))fail('unavailable holdings cannot retain current-looking numbers');
  // Field-level degradation is conspicuous and source-bound, never hidden by
  // optional prose. Financial derivation still belongs to the source adapter.
  if(readiness.degraded){
    const field=expected==='fallback'?'持仓使用获批替代源；原始数据日期见持仓栏。':'部分来源未取得；受影响指标不得视为已核实。';
    view.alerts=[{level:'warning',text:field},...view.alerts].slice(0,3);
  }
  if(journalPath)requireCompactUpstreamJournal(journalPath,readiness);
  // Consumption is atomic and precedes render; even a later guard/render
  // failure cannot reopen this observation for a second candidate attempt.
  if(manual)consumeManualConsent({proof:evidence.sources.ib.manualConsent,journalPath,
    previousSourceSha:previousMeta.sourceSha,edition:evidence.edition,storePath:manualConsentStore,
    sourceEvidenceFingerprint:fingerprint(evidence),now:now??Date.now()});
  const stage=(name,fn)=>{
    if(journalPath)startJournalStage(journalPath,name);
    try{const value=fn();if(journalPath)finishJournalStage(journalPath,name);return value;}
    catch(error){if(journalPath)finishJournalStage(journalPath,name,{status:'failed',errorCode:'PREPARE_FAILED'});throw error;}
  };
  const html=stage('render',()=>renderReport(view,{previousHtml,previousMeta,policy,manualAccountConsent:manual,associationReceipt:association,associationSnapshot}));
  stage('guard',()=>{
    const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'xuan-prepare-'));
    try{
      const candidate=path.join(temporary,'candidate.html'),prior=path.join(temporary,'previous.html'),policyFile=path.join(temporary,'policy.json'),associationFile=path.join(temporary,'association.json');
      fs.writeFileSync(candidate,html,{mode:0o600});fs.writeFileSync(prior,previousHtml,{mode:0o600});fs.writeFileSync(policyFile,JSON.stringify(policy),{mode:0o600});
      if(associationSnapshot)fs.writeFileSync(associationFile,JSON.stringify(associationSnapshot),{mode:0o600});
      const guardEnv={...process.env,XUAN_IB_PREVIOUS_SOURCE_SHA:previousMeta.sourceSha,XUAN_IB_PREVIOUS_HTML_BLOB:previousMeta.htmlBlob,XUAN_IB_POLICY_V2_JSON:policyFile};
      delete guardEnv.XUAN_IB_ASSOCIATION_SNAPSHOT_JSON;
      if(associationSnapshot)guardEnv.XUAN_IB_ASSOCIATION_SNAPSHOT_JSON=associationFile;
      const checked=spawnSync(process.execPath,[path.join(root,'scripts/handover-guard.mjs'),candidate,evidence.dataDate,prior],{
        encoding:'utf8',timeout:30_000,maxBuffer:256_000,
        env:guardEnv});
      if(checked.status!==0)fail(`trusted guard failed: ${(checked.stderr||checked.stdout||checked.error?.message||'UNKNOWN').slice(0,1000)}`);
    }finally{fs.rmSync(temporary,{recursive:true,force:true});}
  });
  if(manual)validateManualConsentProof(evidence.sources.ib.manualConsent,{journalRunId:runId,
    previousSourceSha:previousMeta.sourceSha,edition:evidence.edition,requireUnexpired:true,now:now??Date.now()});
  if(association)validateAssociationReceipt(association,associationSnapshot,{edition:evidence.edition,previousSourceSha:previousMeta.sourceSha,runId,now:now??Date.now()});
  return {html,result:{schemaVersion:1,status:'prepared-not-published',edition:view.edition,dataDate:view.dataDate,
    previousSourceSha:previousMeta.sourceSha,htmlBlob:reportHtmlBlob(html),viewFingerprint:fingerprint(view),sourceEvidenceFingerprint:fingerprint(evidence),degraded:readiness.degraded,issues:readiness.issues}};
}

export function runPrepareCli(args,{loadAssociationPolicy=loadTrustedAssociationPolicy}={}){
  if(args[0]==='preflight-text-retry'){
    if(args.length!==3)fail('Usage: preflight-text-retry BASE.json CANDIDATE.json');
    const baseline=read(args[1]),candidate=read(args[2]);
    // No amount, source, order, decision, brief or timestamp may drift while
    // repairing the narrative that failed its first local draft check.
    const limits={summary:150,observations:200,notes:400},fields=Object.keys(limits);
    const nonText=value=>Object.fromEntries(Object.entries(value).filter(([key])=>!fields.includes(key)));
    if(fingerprint(nonText(baseline))!==fingerprint(nonText(candidate)))fail('TEXT_RETRY_CHANGED_NON_TEXT');
    let changed=0;
    for(const field of fields){
      if(!Array.isArray(baseline[field])||!Array.isArray(candidate[field])||baseline[field].length!==candidate[field].length)fail('TEXT_RETRY_CHANGED_STRUCTURE');
      baseline[field].forEach((value,index)=>{
        const next=candidate[field][index];
        if(value!==next){
          if(typeof value!=='string'||typeof next!=='string'||[...value].length<=limits[field]||[...next].length>=[...value].length)fail('TEXT_RETRY_NOT_OVERLONG_OR_NOT_SHORTER');
          changed+=1;
        }
      });
    }
    if(!changed)fail('TEXT_RETRY_NO_CHANGE');
    validateReportView(candidate);
    return {status:'valid-text-only-not-prepared',changed};
  }
  // Draft checks never finish/reopen a journal stage or refetch any source.
  // Keep narrative active until this strict local check succeeds.
  if(args[0]==='preflight-view'){
    if(args.length!==2)fail('Usage: preflight-view VIEW.json');
    validateReportView(read(args[1]));
    return {status:'valid-not-prepared'};
  }
  // Pure API rendering remains usable in unit tests. The operational command
  // may never omit the journal and then claim a timed pilot run.
  if(![5,7].includes(args.length))fail('Usage: VIEW.json SOURCES.json OUTPUT.html --journal FILE (required) [--manual-consent-store FILE]');
  const [viewFile,evidenceFile,outputFile,flag,journalPath,manualFlag,manualConsentStore]=args;
  if(flag!=='--journal'||!journalPath)fail('a real run journal is required');
  if(args.length===7&&(manualFlag!=='--manual-consent-store'||!manualConsentStore))fail('invalid manual consent store option');
  const output=path.resolve(outputFile);
  if(!output.endsWith('.html') || ['latest.html','policy.html'].includes(path.basename(output)) || output===path.join(root,'index.html'))fail('output must be a candidate HTML, never latest, policy or fee console');
  if(fs.existsSync(output))fail('output already exists; use a new staging path, then stage only validated candidate bytes');
  const prepared=prepareReport(read(viewFile),read(evidenceFile),{
    previousHtml:fs.readFileSync(path.join(root,'xuan-ib/latest.html'),'utf8'),previousMeta:read(path.join(root,'xuan-ib/latest.meta.json')),
    policy:read(path.join(root,'claude/xuan-ib-policy-v2.json')),registry:read(path.join(root,'claude/xuan-ib-portfolio-registry.json')),journalPath,manualConsentStore:manualConsentStore??null,
    // Never accept a candidate-selected snapshot path in the operational CLI.
    associationSnapshot:read(evidenceFile).edition==='adhoc'?loadAssociationPolicy({cwd:root,requireActive:false}):null});
  if(journalPath)startJournalStage(journalPath,'candidate-prep');
  try{
    fs.writeFileSync(output,prepared.html,{flag:'wx',mode:0o600});
    // Verify the actual written bytes, not only the in-memory rendering.
    if(reportHtmlBlob(fs.readFileSync(output,'utf8'))!==prepared.result.htmlBlob)fail('candidate output read-back mismatch');
    if(journalPath)finishJournalStage(journalPath,'candidate-prep');
  }catch(error){if(journalPath)finishJournalStage(journalPath,'candidate-prep',{status:'failed',errorCode:'CANDIDATE_WRITE_FAILED'});throw error;}
  return prepared.result;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{process.stdout.write(`${JSON.stringify(runPrepareCli(process.argv.slice(2)))}\n`);}
  catch(error){process.stderr.write(`${error.message}\n`);process.exitCode=1;}
}
