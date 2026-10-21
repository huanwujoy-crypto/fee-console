// Offline migration candidate only. No reader, schedule, authorization or publication.
// Preserve original bytes/route/status; the compatibility wrapper is derived data.
import crypto from 'node:crypto';
import {normalizeBrowserSnapshot,SHARESIGHT_BROWSER_SOURCE} from '../cloud/xuan-preopen/eod_sources.mjs';
import fs from 'node:fs';
import {readAiRiskAccounts} from './xuan-ib-ai-coefficient-resolver.mjs';
import {buildAiRiskInput,readAiRiskInput} from './xuan-ib-ai-risk-input.mjs';
import {fingerprint} from './xuan-ib-run-manifest.mjs';
import {normalizeSharesightReport,PERFORMANCE_MEMBERSHIP_SOURCE,isCalendarDate} from './xuan-ib-four-bucket.mjs';
import {buildWeeklyConcentration,renderWeeklyConcentration} from './xuan-weekly-concentration.mjs';

const fail=code=>{throw Error('ACTION_CONCENTRATION_'+code);};
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const instant=s=>typeof s==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(s)&&Number.isFinite(Date.parse(s))&&new Date(s).toISOString()===s;
const sourceKeys=Object.freeze({'ib-hk':'sharesight.ibGroupedPerformance','schwab-hk':'sharesight.schwabPerformance',webull:'sharesight.webullPerformance'});
const registry=JSON.parse(fs.readFileSync(new URL('../claude/xuan-ib-portfolio-registry.json',import.meta.url),'utf8'));
const hkt=s=>new Date(Date.parse(s)+28800000).toISOString().slice(0,10);

/** The receipt and bytes must be supplied from a pinned existing private capture.
 * Hashes detect drift; they do not independently authenticate a financial service
 * or attest that broker transactions were synchronized. No caller completeness
 * flag, rewritten status, inferred currency, or classification subset is used. */
export function normalizeActionConcentrationSource({bytes,receipt},{accountKey,cutoff,captureStartedAt,captureCompletedAt}={}){
  const account=readAiRiskAccounts().find(a=>a.key===accountKey);
  if(!account||!isCalendarDate(cutoff))fail('SCOPE_OR_CUTOFF');
  if(!instant(captureStartedAt)||!instant(captureCompletedAt)||captureStartedAt>captureCompletedAt)fail('CAPTURE_WINDOW');
  if(typeof bytes!=='string'||Buffer.byteLength(bytes)>8_000_000||!receipt||receipt.sourceKey!==sourceKeys[accountKey]
    ||receipt.sha256!==sha(bytes)||receipt.bytes!==Buffer.byteLength(bytes))fail('RECEIPT_BINDING');
  if(!['verified','date-verified'].includes(receipt.status)||receipt.sourceDate!==cutoff)fail('SOURCE_STATUS_OR_DATE');
  if(!instant(receipt.startedAt)||!instant(receipt.completedAt)||receipt.startedAt>receipt.completedAt
    ||receipt.startedAt<captureStartedAt||receipt.completedAt>captureCompletedAt
    ||hkt(receipt.startedAt)!==hkt(captureCompletedAt)||hkt(receipt.completedAt)!==hkt(captureCompletedAt))fail('READ_WINDOW');
  let raw;try{raw=JSON.parse(bytes);}catch{fail('SOURCE_JSON');}
  let shell,adapter='top-level-sharesight-to-normalizer-v1';
  if(receipt.route==='authenticated-browser'&&raw?.source===SHARESIGHT_BROWSER_SOURCE){
    const b=normalizeBrowserSnapshot(raw,{portfolioId:Number(account.portfolioId),sourceDate:cutoff});
    if(b.readAt!==receipt.completedAt)fail('READ_WINDOW');
    const report=structuredClone(b.raw.data.report),prior=b.raw.classification?.raw;
    const metadata=(prior?.report??prior?.data?.report??prior?.result?.data?.report)?.holdings??[];
    report.holdings=report.holdings.flatMap((h,i)=>{
      // The browser also shows closed historical rows. Keep them in the pinned
      // source, but zero quantity AND zero value contribute no current exposure.
      if(h.quantity===0&&h.value===0)return [];
      const old=metadata.filter(r=>r.id===h.id&&r.instrument?.id===h.instrument.id&&r.instrument.code===h.instrument.code
        &&r.instrument.market_code===h.instrument.market_code&&(r.instrument.currency_code??r.instrument.currency?.code)===h.instrument.currency_code);
      // Reuse identity/type only after exact account, holding, venue and currency match.
      // Financial values and quantities always come from the current observation.
      if(old.length!==1)fail('BROWSER_INSTRUMENT_IDENTITY_MISSING');
      const securityType=old[0].instrument.friendly_instrument_description_code??old[0].instrument.friendly_instrument_description;
      return [{...h,
        instrument:{...h.instrument,name:b.raw.observation.positions[i].description??h.instrument.code,...(securityType===undefined?{}:{friendly_instrument_description_code:securityType})}}];
    });
    report.cash_accounts=report.cash_accounts.map((c,i)=>({...c,name:b.raw.observation.cash[i].name}));
    shell={mode:'read_only',source:SHARESIGHT_BROWSER_SOURCE,portfolio:{id:Number(account.portfolioId),name:account.custodian,currency_code:'USD'},data:{report}};
    adapter='browser-table-to-normalizer-v1';
  }else if(receipt.route==='gateway'&&(raw?.source==='Sharesight User API'||raw?.ok===true&&raw.route==='gateway')&&!Object.hasOwn(raw,'result'))shell=raw;
  else if(receipt.route==='direct'&&raw?.ok===true&&raw.route==='direct'&&!Object.hasOwn(raw,'result'))shell=raw;
  else fail('SOURCE_ROUTE');
  if(shell.mode!=='read_only'||String(shell.portfolio?.id)!==account.portfolioId
    ||shell.portfolio?.name!==account.custodian||String(shell.data?.report?.portfolio_id)!==account.portfolioId)fail('SOURCE_IDENTITY');
  const sourceReport=shell.data.report;
  if(sourceReport.end_date!==cutoff||!Array.isArray(sourceReport.holdings))fail('SOURCE_CUTOFF_OR_ROWS');
  // Retain the entire source object inside and outside the wrapper, including
  // pagination/error indicators. Never edit the captured raw object or receipt.
  const derived={...raw,result:shell};
  const report=normalizeSharesightReport(derived,{
    registry,portfolioId:account.portfolioId,readStartedAt:receipt.startedAt,readCompletedAt:receipt.completedAt,
    portfolioRoles:['family','ai_only'],unconfirmedTransactionMode:'risk-read-only',
    listing:{source:PERFORMANCE_MEMBERSHIP_SOURCE,portfolioId:Number(account.portfolioId),readCompletedAt:receipt.completedAt,
      holdingIds:sourceReport.holdings.map(r=>r?.holding_id??r?.id)},
  });
  return {report,binding:{accountKey,sourceKey:receipt.sourceKey,sourceDate:cutoff,route:receipt.route,
    sourceStatus:receipt.status,sourceSha256:receipt.sha256,sourceBytes:receipt.bytes,
    readStartedAt:receipt.startedAt,readCompletedAt:receipt.completedAt,
    derivedFingerprint:report.sourceFingerprint,adapter,
    syncCompletion:'not-attested',membershipSource:report.listing.source,independentListing:'not-attested'}};
}

/** Accept only captured source bytes and their receipts. The three source read
 * times are independent; equal report cutoffs do not claim one fresh capture. */
export function buildActionConcentrationCandidate({sources,cutoff,captureStartedAt,captureCompletedAt}={}){
  const accounts=readAiRiskAccounts();
  if(!Array.isArray(sources)||sources.length!==accounts.length)fail('THREE_ACCOUNT_SOURCES_REQUIRED');
  captureStartedAt??=sources.map(s=>s?.receipt?.startedAt).sort()[0];
  captureCompletedAt??=sources.map(s=>s?.receipt?.completedAt).sort().at(-1);
  const normalized=accounts.map(account=>{
    const matches=sources.filter(s=>s?.receipt?.sourceKey===sourceKeys[account.key]);
    if(matches.length!==1)fail('ACCOUNT_SOURCE_MISSING_OR_DUPLICATE');
    return normalizeActionConcentrationSource(matches[0],{accountKey:account.key,cutoff,captureStartedAt,captureCompletedAt});
  });
  const envelope=buildAiRiskInput({reports:normalized.map(s=>s.report)});
  if(envelope.provenance.some(s=>s.reportCutoffDate!==cutoff))fail('CUTOFF_MISMATCH');
  const result=buildWeeklyConcentration(envelope,{cutoff});
  const contribution={status:'recorded',basis:'sharesight-book-date-verified',sourceDate:cutoff,
    readWindow:{startedAt:captureStartedAt,completedAt:captureCompletedAt,basis:'independent-same-cutoff'},
    bindings:normalized.map(s=>s.binding),envelope,resultFingerprint:fingerprint(result)};
  contribution.bindingFingerprint=fingerprint(contribution);
  return validateActionConcentration(contribution,cutoff);
}

export function validateActionConcentration(c,cutoff){
  const exact=(o,keys)=>o&&Object.getPrototypeOf(o)===Object.prototype&&Object.keys(o).sort().join('|')===keys.sort().join('|');
  if(!exact(c,['status','basis','sourceDate','readWindow','bindings','envelope','resultFingerprint','bindingFingerprint'])||c.status!=='recorded'||c.basis!=='sharesight-book-date-verified'||c.sourceDate!==cutoff)fail('CONTRIBUTION');
  const {bindingFingerprint,...body}=c;
  if(fingerprint(body)!==bindingFingerprint)fail('CONTRIBUTION_FINGERPRINT');
  const w=c.readWindow;
  if(!exact(w,['startedAt','completedAt','basis'])||w.basis!=='independent-same-cutoff'||!instant(w.startedAt)||!instant(w.completedAt)||w.startedAt>w.completedAt||hkt(w.startedAt)!==hkt(w.completedAt))fail('READ_WINDOW');
  readAiRiskInput(c.envelope);
  const accounts=readAiRiskAccounts();
  if(!Array.isArray(c.bindings)||c.bindings.length!==3)fail('SOURCE_BINDINGS');
  for(const [i,a] of accounts.entries()){
    const b=c.bindings[i],p=c.envelope.provenance.find(p=>p.key===a.key);
    if(!exact(b,['accountKey','sourceKey','sourceDate','route','sourceStatus','sourceSha256','sourceBytes','readStartedAt','readCompletedAt','derivedFingerprint','adapter','syncCompletion','membershipSource','independentListing'])
      ||b.accountKey!==a.key||b.sourceKey!==sourceKeys[a.key]||b.sourceDate!==cutoff||!['gateway','direct','authenticated-browser'].includes(b.route)||!['verified','date-verified'].includes(b.sourceStatus)
      ||! /^[a-f0-9]{64}$/.test(b.sourceSha256)||!Number.isSafeInteger(b.sourceBytes)||b.sourceBytes<1||b.sourceBytes>8_000_000
      ||!instant(b.readStartedAt)||!instant(b.readCompletedAt)||b.readStartedAt>b.readCompletedAt||b.readStartedAt<w.startedAt||b.readCompletedAt>w.completedAt
      ||b.membershipSource!==PERFORMANCE_MEMBERSHIP_SOURCE||b.independentListing!=='not-attested'||b.syncCompletion!=='not-attested'||b.adapter!==(b.route==='authenticated-browser'?'browser-table-to-normalizer-v1':'top-level-sharesight-to-normalizer-v1')||p?.reportCutoffDate!==cutoff
      ||p.readStartedAt!==b.readStartedAt||p.readCompletedAt!==b.readCompletedAt||p.sourceFingerprint!==b.derivedFingerprint)fail('SOURCE_BINDINGS');
  }
  if(fingerprint(buildWeeklyConcentration(c.envelope,{cutoff}))!==c.resultFingerprint)fail('CALCULATION');
  return c;
}

export function actionConcentrationResult(c){validateActionConcentration(c,c.sourceDate);return buildWeeklyConcentration(c.envelope,{cutoff:c.sourceDate});}

export function renderActionConcentration(c){
  if(!c)return renderPendingActionConcentration();
  validateActionConcentration(c,c.sourceDate);
  const esc=s=>String(s).replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const sources=c.bindings.map(b=>`<p>${esc(readAiRiskAccounts().find(a=>a.key===b.accountKey).custodian)} · 数据至 ${esc(b.sourceDate)} · 读取 ${esc(new Date(Date.parse(b.readCompletedAt)+28800000).toISOString().replace('T',' ').replace('Z',' HKT'))}</p>`).join('');
  const result=actionConcentrationResult(c);
  const staticWeekly=renderStaticWeeklyConcentration(result);
  const qualified=staticWeekly.replace('</h2>','</h2><p class="muted concentration-basis">同日账面值 · 来源独立读取 · 已核实下限</p>');
  return `<section class="card concentration">${qualified}<details><summary>三账户来源与读取时间</summary>${sources}<p>${c.bindings.some(b=>b.route==='authenticated-browser')?'Sharesight 账面值；各来源独立读取，非同一次五分钟捕获。同步完成按用户计算前提采用，未独立对账。分母为 IB-HK、Schwab-HK、Webull 全部持仓与现金；不包含 NOAH-HK，也不重复加入旧混合组合。数量及市值均为零的历史行保留在来源证据，不计入当前敞口。':'Sharesight 账面值；各来源独立读取，非同一次五分钟捕获。同步完成未获独立回执，不表示券商实时持仓。'}</p></details></section>`;
}

export function renderStaticWeeklyConcentration(result,options){
  const esc=s=>String(s).replace(/[&<>\"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[ch]));
  const weekly=renderWeeklyConcentration(result,options);
  const sourceUrls=new Set([...result.matchedFunds.map(f=>f.source),...result.rows.flatMap(r=>r.parts.map(p=>p.source).filter(Boolean))].map(esc));
  // The action's accepted private display is deliberately link-free. Transform
  // only the weekly renderer's three fixed source-anchor shapes after binding
  // their URLs to this calculation. Keep URLs in the original source audit;
  // never expose URL queries as display text or relax the static export gate.
  const staticWeekly=weekly.replace(/<a href="([^"]+)" rel="noopener noreferrer">(发行方目标|发行方资料|发行方前十)<\/a>/g,(_anchor,url,label)=>{
    if(!sourceUrls.has(url))fail('SOURCE_ANCHOR_BINDING');
    return `<span class="concentration-source-label">${label}</span>`;
  });
  if(/<a\b|(?:href|src)\s*=/i.test(staticWeekly))fail('SOURCE_ANCHOR_SHAPE');
  return staticWeekly;
}

// Current EOD sources have IB/NOAH only. This fixed missing-state UI neither
// consumes another account nor suggests that a financial source lacks data.
export function renderPendingActionConcentration(){
  return '<section class="card concentration"><h2>单票集中度</h2><p class="unavailable">本轮尚未计算：未接入 Schwab-HK／Webull 同日来源。</p><details><summary>周末原口径与缺项</summary><p>IB-HK／Schwab-HK／Webull，三账户含现金；直接个股＋ETF 同名穿透／前十＋已核实杠杆等效敞口，合并后至少 1%。</p><p>需三账户同日完整持仓与现金；当前行动版接入 IB-HK／NOAH-HK，NOAH-HK 不替代原模块账户。尚未接入不表示账户本身缺少数据。</p></details></section>';
}
