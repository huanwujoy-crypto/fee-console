// Opt-in compact report authoring. Pure rendering only: no connector, network,
// trading, publication or opinion-response capability. The existing guard is
// still mandatory; renderer success is NOT source-validation/publication proof.
import { createHash } from 'node:crypto';
import { renderCashPlan } from './xuan-ib-cash-plan.mjs';
import { renderPolicySection } from './xuan-ib-policy-page.mjs';
import { renderClassificationDisclosure } from './xuan-ib-classification-disclosure.mjs';
import { ETF_TAB_CSS_V1, ETF_TAB_RADIO_V1, ETF_TAB_LABEL_V1 } from './xuan-ib-etf-pane.mjs';
import { buildDecisionMenu, parseDecisionJson, extractPairedDecisionCardFragments } from './xuan-ib-decision-menu.mjs';
import { parseEtfSummary } from './xuan-ib-etf-summary-transport.mjs';
import { parseEtfAbcPublicRuntimeStateJson, renderEtfAbcPublicRuntimeCard,
  ETF_ABC_RUNTIME_START, ETF_ABC_RUNTIME_END } from './xuan-ib-etf-abc.mjs';

const fail = message => { throw new Error(`Compact report: ${message}`); };
const exact = (object, keys, label) => {
  if (!object || Object.getPrototypeOf(object) !== Object.prototype
      || Object.keys(object).sort().join('|') !== [...keys].sort().join('|')) fail(`${label} has missing or unknown fields`);
};
const list = (value, min, max, label) => {
  if (!Array.isArray(value) || value.length < min || value.length > max) fail(`${label} count must be ${min}..${max}`);
};
const text = (value, max = 240, label = 'text') => {
  if (typeof value !== 'string' || !value.trim() || [...value].length > max
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/u.test(value)) fail(`${label} is missing or too long`);
  // The input is public display data, never a place to hide raw API material.
  if (/(?:github_pat_|gh[pousr]_|\bsk-[A-Za-z0-9_-]{12,}|\bBearer\s+|(?:token|password|secret|api[_ -]?key)\s*[:=]|\b[UF]\d{6,}\b|(?:账户|账号|帐号|account|portfolio)\s*[:#：-]\s*[A-Z0-9-]{5,}|https?:\/\/|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/iu.test(value)) fail(`${label} contains private or external material`);
  return value;
};
const esc = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const date = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)
      || !Number.isFinite(Date.parse(`${value}T00:00:00Z`))
      || new Date(`${value}T00:00:00Z`).toISOString().slice(0,10) !== value) fail('invalid date');
  return value;
};
const asOf = (value, reportDate) => {
  text(value, 64, 'source time');
  const match = value.match(/^(\d{4}-\d{2}-\d{2})(?: (\d{2}):(\d{2})(?:–(\d{2}):(\d{2}))? HKT)?$/);
  if (!match || date(match[1]) > reportDate) fail('source time must be a dated HKT value no later than the report');
  if (match[2] && (Number(match[2]) > 23 || Number(match[3]) > 59
      || (match[4] && (Number(match[4]) > 23 || Number(match[5]) > 59
      || Number(match[4])*60+Number(match[5]) < Number(match[2])*60+Number(match[3]))))) fail('invalid source clock');
};
const finite = (value, label, { negative = false, nullable = true } = {}) => {
  if (value === null && nullable) return;
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1e12
      || (!negative && value < 0)) fail(`invalid ${label}`);
};
const number = (value, digits = 2) => value === null ? '未取得' : value.toLocaleString('en-US', {maximumFractionDigits:digits});
const money = value => value === null ? '未取得' : `$${number(Math.round(value),0)}`;
const direction = value => value === null || value === 0 ? '' : value > 0 ? 'up' : 'dn';
const marker = (state, edge) => `<!-- xuan-ib-decision-group:v1:${state}:${edge} -->`;
const template = (html, id) => {
  const matches = [...html.matchAll(new RegExp(`<template id="${id}" type="application/json">([\\s\\S]*?)</template>`, 'g'))];
  if (matches.length > 1) fail(`duplicate ${id}`);
  return matches[0] || null;
};
export const reportHtmlBlob = html => createHash('sha1').update(`blob ${Buffer.byteLength(html)}\0`).update(html).digest('hex');

function validateCard(card, reportDate) {
  exact(card, ['title','asOfHkt','lines','columns','rows'], 'card');
  text(card.title,80); asOf(card.asOfHkt,reportDate);
  list(card.lines,0,6,'card lines'); card.lines.forEach(line=>text(line,240));
  list(card.columns,0,6,'columns'); card.columns.forEach(label=>text(label,40));
  list(card.rows,0,60,'rows');
  if ((!card.columns.length && card.rows.length) || (!card.lines.length && !card.rows.length)) fail('empty or unheaded card');
  card.rows.forEach(row=>{list(row,card.columns.length,card.columns.length,'table cells');row.forEach(cell=>text(cell,160));});
}

export function validateReportView(view) {
  exact(view, ['schemaVersion','edition','dataDate','asOfHkt','marketContext','alerts','summary',
    'kpis','holdings','risk','allocation','rotation','events','decisions','observations','notes','cashPlan'], 'view');
  if (view.schemaVersion !== 1 || !['pm','adhoc'].includes(view.edition)) fail('compact v1 is opt-in PM/adhoc only; AM remains unchanged');
  date(view.dataDate); asOf(view.asOfHkt,view.dataDate);
  if (!view.asOfHkt.startsWith(view.dataDate+' ')) fail('run read window must include report date and time');
  text(view.marketContext,120);
  list(view.alerts,0,3,'alerts'); view.alerts.forEach(item=>{exact(item,['level','text'],'alert'); if(!['warning','error'].includes(item.level))fail('invalid alert');text(item.text,160);});
  list(view.summary,3,3,'summary'); view.summary.forEach(line=>text(line,150));
  list(view.kpis,3,3,'KPI');
  view.kpis.forEach(item=>{
    exact(item,['label','value','format','asOfHkt','note'],'KPI');text(item.label,50);text(item.note,160);asOf(item.asOfHkt,view.dataDate);
    if(!['usd','percent','number'].includes(item.format))fail('invalid KPI format');finite(item.value,'KPI',{negative:true});
  });
  const holdings=view.holdings;
  exact(holdings,['status','asOfHkt','authoritativeValueUsd','note','rows'],'holdings');
  if(!['ok','fallback','unavailable'].includes(holdings.status))fail('invalid holdings status');
  asOf(holdings.asOfHkt,view.dataDate);text(holdings.note,400);finite(holdings.authoritativeValueUsd,'authoritative holdings');
  list(holdings.rows,0,200,'holdings');
  if(holdings.status==='unavailable' && holdings.rows.length)fail('unavailable holdings cannot contain guessed rows');
  const identities=new Set();
  holdings.rows.forEach(row=>{
    exact(row,['symbol','market','quantity','price','priceCurrency','marketValueUsd','changePct','changeAsOfHkt','quoteStatus'],'holding');
    text(row.symbol,30);text(row.market,30);
    const identity=row.market+':'+row.symbol;if(identities.has(identity))fail('duplicate holding');identities.add(identity);
    finite(row.quantity,'quantity',{negative:true,nullable:false});finite(row.price,'price');finite(row.marketValueUsd,'holding value',{negative:true});
    if(!/^[A-Z]{3}$/.test(row.priceCurrency))fail('invalid price currency');
    finite(row.changePct,'daily change',{negative:true});
    if(!['ok','delayed','unavailable'].includes(row.quoteStatus))fail('invalid quote status');
    if(row.changePct===null){if(row.changeAsOfHkt!==null || row.quoteStatus!=='unavailable')fail('missing change must be explicitly unavailable');}
    else {if(row.quoteStatus==='unavailable')fail('unavailable quote has a change');asOf(row.changeAsOfHkt,view.dataDate);}
  });
  for(const key of ['risk','allocation']){list(view[key],1,8,key);view[key].forEach(card=>validateCard(card,view.dataDate));}
  validateCard(view.rotation,view.dataDate);validateCard(view.events,view.dataDate);
  list(view.decisions,0,100,'decision cards');const ids=new Set();
  view.decisions.forEach(item=>{
    exact(item,item.isNew?['decisionId','title','asOfHkt','fact','options','recommendation','isNew']:['decisionId','asOfHkt','fact','isNew'],'decision card');
    if(!/^D-\d{8}-[A-Z][A-Z0-9-]*$/.test(item.decisionId) || ids.has(item.decisionId))fail('invalid/duplicate decision identity');ids.add(item.decisionId);
    if(typeof item.isNew!=='boolean')fail('isNew must be boolean');
    asOf(item.asOfHkt,view.dataDate);text(item.fact,500);
    if(item.isNew){
      if(!item.decisionId.startsWith(`D-${view.dataDate.replaceAll('-','')}-`))fail('new decision identity must use report date');
      text(item.title,200);text(item.recommendation,400);list(item.options,2,5,'decision options');item.options.forEach(option=>text(option,160));
    }
    for(const value of [item.title,item.fact,item.recommendation,...(item.options||[])].filter(Boolean)){
      if(/待 Wu 审核|已决定\s*\/\s*待落实|已拒绝\s*\/\s*已结案|已取代\s*\/\s*已结案|xuan-ib-decision-group|xuan-compact-card-body/.test(value))fail('reserved decision status/marker in free text');
    }
  });
  list(view.observations,0,5,'observations');view.observations.forEach(item=>text(item,200));
  list(view.notes,3,3,'report notes');view.notes.forEach(item=>text(item,400));
  if(view.cashPlan.schemaVersion!==2)fail('approved three-way cash plan v2 required');
  renderCashPlan(view.cashPlan);
  if(view.cashPlan.status==='snapshot')asOf(view.cashPlan.sourceAsOfHkt,view.dataDate);
  // Bound total inference output. It must not grow back into a novel or HTML.
  if(Buffer.byteLength(JSON.stringify(view))>70_000)fail('view exceeds 70KB public input limit');
  return view;
}

const table = (columns,rows) => !columns.length?'':`<div class="tblwrap"><table><thead><tr>${columns.map(x=>`<th>${esc(x)}</th>`).join('')}</tr></thead><tbody>${rows.map(row=>`<tr>${row.map(x=>`<td>${esc(x)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
const cardBody = card => `<p class="sub">数据时点：${esc(card.asOfHkt)}</p>${card.lines.map(line=>`<p>${esc(line)}</p>`).join('')}${table(card.columns,card.rows)}`;
const card = value => `<section class="card"><h2>${esc(value.title)}</h2>${cardBody(value)}</section>`;
const fold = (title,body,open=false,right='') => `<details${open?' open':''}><summary>${esc(title)}${right?` <span class="rt">${esc(right)}</span>`:''}</summary><div class="dbody">${body}</div></details>`;

function holdingsView(holdings, reportDate) {
  // Daily changes whose quote date differs from this report's data date are
  // displayed as old, never classified as a fresh >1% move.
  const usable=row=>row.changePct!==null && row.changeAsOfHkt.startsWith(reportDate);
  // Do not round 0.9999% into a displayed 1% in the <1% group. Exact JS decimal
  // text is used only at a rounding boundary; ordinary values stay compact.
  const change=value=>Math.abs(value)<1&&Math.abs(Number(value.toFixed(2)))>=1?String(value):number(value);
  const groups=[holdings.rows.filter(row=>usable(row)&&Math.abs(row.changePct)>=1),holdings.rows.filter(row=>usable(row)&&Math.abs(row.changePct)<1),holdings.rows.filter(row=>!usable(row))];
  const rows = items => `<div class="tblwrap"><table style="min-width:480px;overflow-wrap:normal"><thead><tr><th>标的</th><th>估值价</th><th>日涨跌</th><th>行情时点</th><th>市值 $</th></tr></thead><tbody>${items.map(row=>`<tr><td><span class="sym">${esc(row.symbol)}</span><span class="sub">${esc(row.market)} · ${number(row.quantity,6)}</span></td><td>${esc(row.priceCurrency)} ${number(row.price,4)}</td><td class="${direction(usable(row)?row.changePct:null)}">${row.changePct===null?'未取得':`${row.changePct>0?'+':''}${change(row.changePct)}%${usable(row)?'':'（旧值）'}`}</td><td>${row.changeAsOfHkt===null?'未取得':esc(row.changeAsOfHkt)}${row.quoteStatus==='delayed'?' · 延迟':''}</td><td>${number(row.marketValueUsd,0)}</td></tr>`).join('')}</tbody></table></div>`;
  return `<section class="card"><h2>① 持仓一览</h2><p class="sub">估值时点 ${esc(holdings.asOfHkt)} · ${holdings.rows.length} 只 · 权威市值 ${money(holdings.authoritativeValueUsd)} · ${esc(holdings.status)}</p><p>${esc(holdings.note)}</p>${fold(`价格变化 ≥1%（${groups[0].length}）`,groups[0].length?rows(groups[0]):'<p>暂无已核实的 ≥1% 变化；不代表未取得行情的持仓没有变化。</p>',true)}${fold(`其它持仓（${groups[1].length}）`,rows(groups[1]))}${fold(`涨跌数据待核验（${groups[2].length}）`,rows(groups[2]))}</section>`;
}

function decisionGroup(state, views, group, originalCards) {
  const items=state.decisions.filter(item=>(item.status==='awaiting_user')===(group==='awaiting_user'));
  const title=group==='awaiting_user'?`⑤ 待决定事项 <small>${items.length} 项待 Wu 裁决</small>`:`已决定 / 待落实 <small>${items.length} 项 · 只记录意见，不执行交易</small>`;
  return `${marker(group,'start')}<h2 data-decision-group-title="${group}">${title}</h2>${items.map((item,index)=>{
    const view=views.find(x=>x.decisionId===item.decisionId);
    if(!view.isNew){
      const original=originalCards.get(item.decisionId);if(!original)fail('original visible decision card missing');
      const start='<!-- xuan-compact-card-body:start -->',end='<!-- xuan-compact-card-body:end -->';
      const starts=original.body.split(start).length-1,ends=original.body.split(end).length-1;
      if(starts!==ends || starts>1 || (starts===1&&original.body.indexOf(start)>original.body.indexOf(end)))fail('invalid historical card preservation markers');
      const preserved=starts?original.body.slice(original.body.indexOf(start)+start.length,original.body.indexOf(end)):original.body;
      // Original options/recommendation remain immutable. Only the separately
      // labelled current-facts section is regenerated, without recursive growth.
      return original.prefix+`<div class="dbody"><p><b>本期事实更新：</b>${esc(view.fact)}</p><p class="sub">${esc(view.asOfHkt)}；下列为原事项记录，历史金额不代表本期值。</p>${fold('原事项记录（保留历史意见）',start+preserved+end)}</div></details>`;
    }
    const label=({awaiting_user:'待 Wu 审核',accepted:'已决定 / 待落实',modified:'已决定 / 待落实',rejected:'已拒绝 / 已结案',superseded:'已取代 / 已结案'})[item.status];
    return `<details id="${item.decisionId}" data-decision-id="${item.decisionId}" data-decision-status="${item.status}"><summary>${index+1} · ${esc(view.title)} <span class="rt">${esc(view.recommendation)} · ${label}</span></summary><div class="dbody"><p class="sub">当前事实时点：${esc(view.asOfHkt)}；原意见回执保持不变。</p><p><b class="lab">事实/选项：</b>${esc(view.fact)}</p>${view.options.length?`<ol>${view.options.map(x=>`<li>${esc(x)}</li>`).join('')}</ol>`:''}<p><b class="lab">Claude 意见：</b>${esc(view.recommendation)}</p><p><b class="lab">状态：</b> <b>${label}</b>（<code>${item.status}</code>）</p></div></details>`;
  }).join('')}${marker(group,'end')}`;
}

const STYLE = `:root{--ink:#171717;--bg:#fafaf8;--mut:#777;--line:#deded8;--card:#fff;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:16px;color:var(--ink);background:var(--bg)}*{box-sizing:border-box}body{margin:0}.page{background:var(--bg);color:var(--ink);min-height:100vh}.wrap{max-width:1000px;margin:auto;padding:12px}.hdr{display:flex;justify-content:space-between;gap:10px}.date{font-weight:650;font-size:14px}.tgl{display:flex;gap:5px}.tgl label{min-height:44px;padding:10px;border:1px solid var(--line);border-radius:30px}input[type=radio]{position:absolute;opacity:0;pointer-events:none}#td:checked~.page{--bg:#151515;--card:#202020;--ink:#eee;--mut:#aaa;--line:#444}h2{font-size:18px;margin:0 0 10px}h3{font-size:16px}p{line-height:1.55;margin:8px 0}small,.sub{font-size:14px;color:var(--mut)}.sub{display:block}.card,details,.kpi{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:14px;margin:12px 0;min-width:0;overflow-wrap:anywhere}details{padding:0}summary{cursor:pointer;min-height:48px;padding:14px;font-weight:700}.dbody{padding:0 14px 14px}.rt{color:var(--mut);font-size:14px;font-weight:500}.kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}.kpi .big{font-size:28px;font-weight:800}.kpi .lab{font-size:14px;color:var(--mut)}.num,td{font-variant-numeric:tabular-nums}.tabbar{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:5px;position:sticky;top:0;z-index:1;background:var(--bg);padding:8px 0}.tabbar label{display:flex;align-items:center;justify-content:center;gap:4px;min-height:48px;border:1px solid var(--line);border-radius:40px;cursor:pointer;font-size:14px}.dot{background:var(--line);color:#171717;border-radius:20px;padding:0 5px}.pane{display:none}#s1:checked~.p1,#s2:checked~.p2,#s3:checked~.p3,#s4:checked~.p4{display:block}#s1:checked~.tabbar label[for="s1"],#s2:checked~.tabbar label[for="s2"],#s3:checked~.tabbar label[for="s3"],#s4:checked~.tabbar label[for="s4"]{background:var(--ink);color:var(--bg)}.tblwrap{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:14px}th,td{text-align:right;padding:9px 6px;border-bottom:1px solid var(--line);vertical-align:top}th:first-child,td:first-child{text-align:left}.sym{font-weight:700}.up,.gv{color:#15803d}.dn{color:#dc2626}.wv,.or{color:#a16207}.alert{border:1px solid #e4ae37;background:#fff2ca;color:#6b4500;padding:12px;border-radius:14px;margin:12px 0}.error{background:#ffe7e7;color:#991b1b;border-color:#dc2626}.foot{font-size:13px;color:var(--mut);padding:14px 0}.kv{display:flex;justify-content:space-between;gap:12px;border-bottom:1px solid var(--line);padding:10px 0}.v{text-align:right}@media(max-width:640px){.kpis{grid-template-columns:repeat(2,minmax(0,1fr))}.kpi .big{font-size:24px}.wrap{padding:10px}}\n${ETF_TAB_CSS_V1}`;

export function renderReport(view, { previousHtml, previousMeta, policy }) {
  validateReportView(view);
  // This validates the exact previous pair and its existing machine state. A
  // mismatched/unparseable history is not grounds to bootstrap empty receipts.
  buildDecisionMenu({html:previousHtml,meta:previousMeta});
  if(view.dataDate<previousMeta.dataDate)fail('report cannot move back before prior data date');
  const oldTemplate=template(previousHtml,'xuan-ib-decision-state-v1');
  if(!oldTemplate)fail('previous decision state required');
  const state=parseDecisionJson(oldTemplate[1]);
  const oldCards=extractPairedDecisionCardFragments({html:previousHtml,meta:previousMeta});
  const oldIds=new Set(state.decisions.map(item=>item.decisionId));
  for(const item of view.decisions){
    if(item.isNew && state.interaction!=='enabled')fail('cannot add decisions while interaction is disabled');
    if(oldIds.has(item.decisionId)&&item.isNew)fail('existing decision cannot be recreated');
    if(!oldIds.has(item.decisionId)){if(!item.isNew)fail('unknown decision must be explicitly new');state.decisions.push({decisionId:item.decisionId,status:'awaiting_user'});}
  }
  if(state.decisions.length!==view.decisions.length || state.decisions.some(item=>!view.decisions.some(card=>card.decisionId===item.decisionId)))fail('every old decision needs current sourced facts');
  // Preserve the original template byte-for-byte when no new issue is added.
  // If an issue is new, replace ONLY the validated simple decisions array;
  // the receipt bytes, whitespace, key order and historical wording survive.
  let stateTemplate=oldTemplate[0];
  if(view.decisions.some(item=>item.isNew)){
    const arrayPattern=/"decisions"\s*:\s*\[[^\]]*\]/g;
    if([...oldTemplate[1].matchAll(arrayPattern)].length!==1)fail('cannot locate unique simple decision array');
    const body=oldTemplate[1].replace(arrayPattern,`"decisions":${JSON.stringify(state.decisions)}`);
    if(JSON.stringify(parseDecisionJson(body))!==JSON.stringify(state))fail('decision append changed historical state');
    stateTemplate=oldTemplate[0].replace(oldTemplate[1],body);
  }
  let etf='';
  const legacy=template(previousHtml,'xuan-ib-etf-abc-state-v1');
  if(legacy){
    const prior=parseEtfAbcPublicRuntimeStateJson(legacy[1]);
    // This is only the existing incomplete runtime marker, not ABC valuation.
    if(prior.comparisonStatus!=='incomplete'||prior.baselineStatus!=='pending')fail('established legacy ABC requires its own reviewed producer');
    // These dates belong to an explicitly unavailable placeholder, not prices.
    // Roll the pending marker consistently; never alter an actual open summary.
    const runtime={...prior,economicDateHkt:view.dataDate,effectiveMarketDate:view.dataDate,
      calendarStatus:'unavailable',staleMarketClosed:false};
    etf=`${ETF_ABC_RUNTIME_START}\n<template id="xuan-ib-etf-abc-state-v1" type="application/json">${JSON.stringify(runtime)}</template>\n${renderEtfAbcPublicRuntimeCard(runtime)}\n${ETF_ABC_RUNTIME_END}`;
  }
  const summary=template(previousHtml,'xuan-etf-open-summary-v3');
  if(summary){parseEtfSummary(summary[1]);etf+=`\n${summary[0]}`;} // preserve baseline/date and bytes
  const cash=renderCashPlan(view.cashPlan), pending=state.decisions.filter(item=>item.status==='awaiting_user').length;
  const edition={pm:'睡前版',adhoc:'临时版'}[view.edition];
  const day='日一二三四五六'[new Date(`${view.dataDate}T00:00:00Z`).getUTCDay()];
  const kpis=view.kpis.map(item=>`<div class="kpi"><div class="lab">${esc(item.label)}</div><div class="big num">${item.value===null?'待核实':item.format==='usd'?money(item.value):`${number(item.value)}${item.format==='percent'?'%':''}`}</div><div class="sub">${esc(item.note)}<br>${esc(item.asOfHkt)}</div></div>`).join('')+cash.kpi;
  const html=`<!doctype html>\n<html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="XUAN-投资管理"><title>XUAN-投资管理</title><style>${STYLE}</style></head><body><!-- xuan-ib-handover:v1 -->
<input type="radio" name="th" id="tl" checked><input type="radio" name="th" id="td"><div class="page"><div class="wrap"><div class="hdr"><span class="date">${view.dataDate} 周${day} · ${edition} · ${esc(view.marketContext)}</span><div class="tgl"><label for="tl">浅</label><label for="td">深</label></div></div>
${view.alerts.map(item=>`<div class="alert ${item.level==='error'?'error':''}">${esc(item.text)}</div>`).join('')}
${fold('三行摘要',`<ol>${view.summary.map(line=>`<li>${esc(line)}</li>`).join('')}</ol>`,false,'最重要的排第一')}<div class="kpis">${kpis}</div>
<div class="tabs"><input type="radio" name="sec" id="s1" checked><input type="radio" name="sec" id="s2"><input type="radio" name="sec" id="s3"><input type="radio" name="sec" id="s4">${ETF_TAB_RADIO_V1}<div class="tabbar"><label for="s1">概览</label><label for="s2">风险</label><label for="s3">配置</label><label for="s4" aria-label="待办 ${pending} 项">待办${pending?` <span class="dot" aria-hidden="true">${pending}</span>`:''}</label>${ETF_TAB_LABEL_V1}</div>
<div class="pane p1">${holdingsView(view.holdings,view.dataDate)}${fold('③ 今夜你睡着时会发生什么',cardBody(view.events))}</div>
<div class="pane p2">${view.risk.map(card).join('')}</div>
<div class="pane p3">${cash.detail}${view.allocation.map(card).join('')}</div>
<div class="pane p4">${fold('⑥ 换仓触发检查',cardBody(view.rotation),true)}${decisionGroup(state,view.decisions,'awaiting_user',oldCards,previousMeta.dataDate)}${decisionGroup(state,view.decisions,'resolved',oldCards,previousMeta.dataDate)}${fold('已结案 / 只读观察',`<ol>${view.observations.map(line=>`<li>${esc(line)}</li>`).join('')}</ol>`,false,`最近 ${view.observations.length} 项`)}</div>
<div class="pane p5">${renderPolicySection(policy)}${etf}</div></div>
${fold('报告说明',`<ol>${view.notes.map(line=>`<li>${esc(line)}</li>`).join('')}</ol>${view.edition==='adhoc'?'<p>本次为手动临时版，不替代定时版成功证据。</p>':''}<p>发布仍须通过 Validate → Promote → Pages，并核对公开版本；生成候选不等于已发布。</p>${renderClassificationDisclosure()}`,false,'版别 · 取数时点 · 数据日 · 只读')}
<div class="foot">只读报告 · 数据截至 ${esc(view.asOfHkt)} · 不是交易指令</div></div></div>
${stateTemplate}\n${cash.template}\n</body></html>\n`;
  // Also prove that the rebuilt native decision menu remains functional.
  buildDecisionMenu({html,meta:{...previousMeta,dataDate:view.dataDate,htmlBlob:reportHtmlBlob(html)}});
  return html;
}
