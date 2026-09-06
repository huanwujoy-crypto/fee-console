// Deterministic report integration. Private raw reads never enter HTML.
import { deriveFourBucket, familyPortfolioIds, loadTrustedInputs, parseFourBucketTemplate,
  renderFourBucketTemplate, validateFourBucketSnapshot, assertFourBucketAdvances,
  FOUR_BUCKET_TEMPLATE_ID, BUCKETS, formatMicroUsd } from './xuan-ib-four-bucket.mjs';
import { fingerprint, canonicalJson } from './xuan-ib-run-manifest.mjs';
import { parseDecisionJson } from './xuan-ib-decision-menu.mjs';

export const FOUR_BUCKET_REPORT_ID = 'xuan-ib-four-bucket-report-v1';
const CARD_ID = 'xuan-ib-four-bucket-card-v1';
const fail = code => { throw new Error(`Four bucket report: ${code}`); };
const esc = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const instant = value => typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN;
const hkt = value => new Date(instant(value) + 8 * 3600000).toISOString().slice(0,16).replace('T',' ') + ' HKT';
const usd = micro => '$' + Number(formatMicroUsd(micro)).toLocaleString('en-US',{maximumFractionDigits:0});
const keys = (value, expected) => value && Object.keys(value).sort().join('|') === [...expected].sort().join('|');

export function previousFourBucket(html, registry) {
  if (!String(html ?? '').includes(FOUR_BUCKET_TEMPLATE_ID)) return null;
  return parseFourBucketTemplate(html,{registry});
}

/** Bind each family response to the already validated source evidence and
 * real sharesight-read stage. No caller-provided mapping or guessed listing.
 * Binding failures abort; source/content classification failures degrade only
 * the four-bucket card via the calculator's explicit last-good fallback. */
export function prepareFourBucketReport(input, { evidence, previousHtml, journal = null,
  now = Date.now(), trusted = loadTrustedInputs() } = {}) {
  const previous = previousFourBucket(previousHtml, trusted.registry);
  if (!keys(input,['schemaVersion','reads','pendingRedemption']) || input.schemaVersion !== 1 || !Array.isArray(input.reads)) fail('INPUT_SHAPE');
  if (!Array.isArray(evidence?.sources?.sharesight) || evidence.sources.sharesightWeekly) fail('DIRECT_READS_REQUIRED');
  const ids = familyPortfolioIds(trusted.registry);
  if (input.reads.map(r=>r.portfolioId).sort((a,b)=>a-b).join(',') !== ids.join(',')) fail('EXACT_FAMILY_SCOPE_REQUIRED');
  const stage = journal?.stages?.find(s=>s.name==='sharesight-read');
  if (journal && (!stage || stage.status!=='ok')) fail('READ_STAGE_REQUIRED');
  for (const read of input.reads) {
    if (!keys(read,['portfolioId','raw','readStartedAt','readCompletedAt','listing'])
      || !keys(read.listing,['raw','readStartedAt','readCompletedAt'])) fail('RAW_READ_SHAPE');
    const source = evidence.sources.sharesight.find(s=>s.portfolioId===read.portfolioId);
    if (!source || source.status!=='ok' || source.fingerprint!==fingerprint(read.raw)
      || instant(source.asOf)!==instant(read.readCompletedAt)
      || (source.readStartedAt && instant(source.readStartedAt)!==instant(read.readStartedAt))) fail('SOURCE_RECEIPT_MISMATCH');
    for (const pair of [read,read.listing]) {
      const start=instant(pair.readStartedAt), end=instant(pair.readCompletedAt);
      if (!Number.isFinite(start)||!Number.isFinite(end)||start>end||end>now
        || hkt(pair.readCompletedAt).slice(0,10)!==evidence.dataDate
        || hkt(pair.readStartedAt).slice(0,10)!==evidence.dataDate
        || (stage&&(start<instant(stage.startedAt)||end>instant(stage.endedAt)))) fail('READ_OUTSIDE_RUN');
    }
  }
  const result=deriveFourBucket({reads:input.reads,previous,pendingRedemption:input.pendingRedemption,now,trusted});
  return {status:result.status,reason:result.reason??null,snapshot:result.snapshot??null};
}

export function validateFourBucketReport(result, { registry = null } = {}) {
  if (!keys(result,['status','reason','snapshot']) || !['fresh','fallback','unavailable'].includes(result.status)) fail('RESULT_SHAPE');
  if (result.status==='fresh' ? result.reason!==null : typeof result.reason!=='string'||!/^[A-Z][A-Z0-9_]{0,95}$/.test(result.reason)) fail('RESULT_REASON');
  if (result.status==='unavailable') { if(result.snapshot!==null) fail('UNAVAILABLE_HAS_AMOUNTS'); }
  else validateFourBucketSnapshot(result.snapshot,{registry});
  return result;
}

export function renderFourBucketCard(result) {
  validateFourBucketReport(result);
  const s=result.snapshot;
  const state={fresh:'本次重算',fallback:'沿用上次',unavailable:'未取得'}[result.status];
  if(!s) return `<section id="${CARD_ID}" class="card"><h3>四桶 · 未取得</h3><p>本次未通过完整核验，金额不显示为零。</p></section>`;
  const labels={highly_liquid:'高流动性',vc_pe:'VC / PE',hedge_fund:'对冲基金',evergreen:'常青基金'};
  const rows=BUCKETS.map(b=>`<tr><td>${labels[b]}</td><td class="num" style="white-space:nowrap;text-align:right">${usd(s.totals.buckets[b].usdMicro)}</td><td class="num" style="white-space:nowrap;text-align:right">${s.totals.percent[b]}%</td></tr>`).join('');
  return `<section id="${CARD_ID}" class="card"><h3>四桶 · ${state}</h3><p class="sub">读取 ${hkt(s.readWindow.completedAt)} · 毛值</p><div style="overflow-x:auto"><table style="width:100%"><thead><tr><th>类别</th><th>市值 USD</th><th>占比</th></tr></thead><tbody>${rows}</tbody></table></div><p>合计 <strong class="num" style="white-space:nowrap">${usd(s.totals.totalUsdMicro)}</strong></p></section>`;
}

export function renderFourBucketReportTransport(result) {
  validateFourBucketReport(result);
  const state={schemaVersion:1,status:result.status,reason:result.reason,snapshotFingerprint:result.snapshot?.fingerprint??null};
  return `<template id="${FOUR_BUCKET_REPORT_ID}" type="application/json">${canonicalJson(state)}</template>`
    +(result.snapshot?renderFourBucketTemplate(result.snapshot):'');
}

export function parseFourBucketReport(html, {registry=null}={}) {
  const source=String(html??'');
  if(!source.includes(FOUR_BUCKET_REPORT_ID)) {
    if(source.includes(FOUR_BUCKET_TEMPLATE_ID)||source.includes(CARD_ID)) fail('MISSING_REPORT_STATE');
    return null;
  }
  const matches=[...source.matchAll(new RegExp(`<template id="${FOUR_BUCKET_REPORT_ID}" type="application/json">([^<]*)</template>`,'g'))];
  if(matches.length!==1 || source.split(FOUR_BUCKET_REPORT_ID).length!==2) fail('REPORT_STATE_NOT_UNIQUE');
  parseDecisionJson(matches[0][1],4096);
  const state=JSON.parse(matches[0][1]);
  if(!keys(state,['schemaVersion','status','reason','snapshotFingerprint'])||state.schemaVersion!==1||canonicalJson(state)!==matches[0][1])fail('REPORT_STATE_INVALID');
  const snapshot=state.status==='unavailable'?null:parseFourBucketTemplate(source,{registry});
  if(state.status==='unavailable'&&source.includes(FOUR_BUCKET_TEMPLATE_ID))fail('UNAVAILABLE_HAS_SNAPSHOT');
  if(state.snapshotFingerprint!==(snapshot?.fingerprint??null))fail('REPORT_FINGERPRINT_MISMATCH');
  return validateFourBucketReport({status:state.status,reason:state.reason,snapshot},{registry});
}

export function validateFourBucketReportHtml(html,{previousHtml=null,registry=null,recordsUpdate=false,reportDate=null}={}) {
  try {
    if(!String(html??'').includes(FOUR_BUCKET_REPORT_ID)&&!String(previousHtml??'').includes(FOUR_BUCKET_REPORT_ID)) {
      parseFourBucketReport(html); return [];
    }
    const trusted=loadTrustedInputs();
    registry??=trusted.registry;
    const result=parseFourBucketReport(html,{registry}), previous=parseFourBucketReport(previousHtml,{registry});
    if(!result){if(previous)fail('REPORT_STATE_REMOVED');return [];}
    const canonical=renderFourBucketCard(result);
    if(reportDate&&result.snapshot){
      const readDate=hkt(result.snapshot.readWindow.completedAt).slice(0,10);
      if(readDate>reportDate||(result.status==='fresh'&&readDate!==reportDate))fail('REPORT_DATE_MISMATCH');
    }
    if(result.status==='fresh'&&!recordsUpdate&&(result.snapshot.inputs.mappingFingerprint!==fingerprint(trusted.mapping)
      ||result.snapshot.inputs.cashIdentityFingerprint!==fingerprint(trusted.cashIdentities)))fail('TRUSTED_RULE_FINGERPRINT_MISMATCH');
    const visible=String(html).replace(/<!--[\s\S]*?-->/g,'').replace(/<(script|style|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,'');
    if(!visible.includes(canonical)||visible.split(CARD_ID).length!==2)fail('CARD_NOT_CANONICAL');
    if(recordsUpdate){if(canonicalJson(result)!==canonicalJson(previous))fail('RECORD_UPDATE_CHANGED_BUCKETS');}
    else if(result.status==='fallback'){
      if(!previous?.snapshot||canonicalJson(result.snapshot)!==canonicalJson(previous.snapshot))fail('FALLBACK_NOT_PREVIOUS');
    }else if(result.status==='fresh')assertFourBucketAdvances(previous?.snapshot,result.snapshot);
    else if(previous?.snapshot)fail('LAST_GOOD_SNAPSHOT_DROPPED');
    return [];
  }catch(error){return [error.message];}
}

export function fourBucketDisclosure(result) {
  validateFourBucketReport(result);
  const s=result.snapshot;
  if(!s)return '<li>本次四桶未取得有效结果，金额不可用；未把缺失值填零。</li>';
  const net=s.evergreenNet.status==='available'
    ? `常青基金待赎回证据日期 ${esc(s.evergreenNet.evidenceDate)}，扣除待赎回后的展示净值 ${usd(s.evergreenNet.netUsdMicro)}；待赎回不计为现金。`
    : '常青基金展示毛值；缺少当期待赎回凭证，扣除待赎回后的净值不可用。';
  return `<li>${result.status==='fresh'?'本次按完整家庭范围重新读取并分类计算':'本次计算未通过，沿用上次已核验结果，不改写原日期'}。读取 ${hkt(s.readWindow.startedAt)} 至 ${hkt(s.readWindow.completedAt)}；Sharesight 报告截止 ${s.reportCutoff.earliest} 至 ${s.reportCutoff.latest}。这是读取／报告日期，不是所有基金的净值日期。</li><li>现金按来源的独立现金账户识别；证券代理现金仅接受已核验身份和明确来源凭证。${net} 分类未知、重复或金额对账失败时，不发布新四桶数值。四桶毛值不等于可投资现金；补仓、AI 压力和 ETF 比较各按自身来源与日期。</li>`;
}
