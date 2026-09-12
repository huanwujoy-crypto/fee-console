// Minimal DOM contract model; real-width acceptance is a separate browser check.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {improveMobileDisplay,GUIDE_BODY,extractReadingMetrics,extractCashGuidance,conciseHoldingsNote,MOBILE_READING_CSS,aiRiskStripValues,aiRiskBandValues,largestOrdinaryConcentration,familySingleStockConcentration,cashRiskSummary,reserveRiskSummary} from './xuan-ib-mobile-display.mjs';
const cell=text=>({textContent:text});
const row=values=>({children:values.map(cell),insertBefore(node,ref){if(node===ref)return;this.children.splice(this.children.indexOf(node),1);this.children.splice(this.children.indexOf(ref),0,node);}});
test('verified display reorders intact cells with stable descending amounts and missing values last',()=>{
 const head=row(['标的','估值价','日涨跌','行情时点','市值 $']);
 const rows=[row(['SMALL','1','1%','old','10']),row(['UNKNOWN','?','?','old','未取得']),row(['BIG','2','2%','old','2,000']),row(['TIE','2','2%','old','2,000'])];
 const body={children:rows,append(r){this.children.splice(this.children.indexOf(r),1);this.children.push(r);}};
 const table={classList:{add(){}},querySelectorAll(s){return s==='thead th'?head.children:[head,...body.children];},querySelector(){return body;}};
 const doc={querySelectorAll(){return [table];},querySelector(){return null;},getElementById(){return true;}};
 const originals=rows.flatMap(r=>r.children);
 improveMobileDisplay(doc);improveMobileDisplay(doc);
 assert.deepEqual(head.children.map(c=>c.textContent),['标的','市值 $','估值价','日涨跌','行情时点']);
 assert.deepEqual(body.children.map(r=>r.children[0].textContent),['BIG','TIE','SMALL','UNKNOWN']);
 assert.ok(originals.every(c=>body.children.some(r=>r.children.includes(c))));
});
test('header guide matches shared wording and runs only after verification',()=>{
 const loader=fs.readFileSync(new URL('../xuan-ib/index.html',import.meta.url),'utf8');
 assert.ok(loader.includes(GUIDE_BODY));
 assert.match(loader,/renderedDocument === doc && lastVerified\?\.blob === record\.blob/);
  assert.match(loader,/if \(!current\(\)\) return;\s*try \{\s*doc\.getElementById\('xuan-mobile-layout-status'\)\?\.remove\(\);\s*view\.improveMobileDisplay\(doc\)/);
 assert.ok(loader.indexOf('class="header-guide"')<loader.indexOf('id="refresh"'));
 const module=fs.readFileSync(new URL('./xuan-ib-mobile-display.mjs',import.meta.url),'utf8');
 assert.doesNotMatch(module,/fetch\(|localStorage|sessionStorage|innerHTML\s*=/);
 assert.match(module,/for\(let i=1;i<=5;i\+\+\)/);
 assert.match(module,/if\(notes\.has\(1\)&&roots\.length\)/);
 assert.match(module,/querySelectorAll\('\.pane\.p1 \.holdings-source-context'\)/);
 assert.match(module,/\.cash-reserve-strip,details,li/);
 assert.doesNotMatch(module,/cloneNode\(true\)[\s\S]{0,300}数据日期与共同口径/);
});
test('critical replenishment amounts remain visible without recomputing or guessing',()=>{
 assert.deepEqual(extractCashGuidance('EXUS $550,579 EIMI $128,701 USSC $75,476'),[['EXUS','$550,579'],['EIMI','$128,701'],['USSC','$75,476']]);
 assert.deepEqual(extractCashGuidance('EXUS $550,579EIMI $128,701USSC $75,476两类仍需 $84,768'),[['EXUS','$550,579'],['EIMI','$128,701'],['USSC','$75,476']]);
 assert.deepEqual(extractCashGuidance('EXUS 未取得 USSC 待回款后重算'),[['USSC','待回款后重算']]);
 assert.deepEqual(extractCashGuidance('无有效补仓数值'),[]);
});
test('reading metrics copy labelled values exactly, without inferring missing values',()=>{
 assert.deepEqual(extractReadingMetrics('中情景 21.76% · 分母 $6,198,031.57'),[['AI 中情景','21.76%'],['三账户总额','$6,198,031.57']]);
 assert.deepEqual(extractReadingMetrics('26 只 · 权威市值 $4,420,972'),[['持仓数量','26 只']]);
 assert.deepEqual(extractReadingMetrics('行情未取得，低情景近似 16.20%'),[]);
 assert.deepEqual(extractReadingMetrics('HL 17.75% / 40% · 常青基金 15.93%'),[['HL 当前 / 目标','17.75% / 40%'],['常青基金','15.93%']]);
 assert.match(MOBILE_READING_CSS,/white-space:nowrap!important/);
 assert.match(MOBILE_READING_CSS,/repeat\(2,minmax\(0,1fr\)\)/);
});
test('holdings note keeps only the readable calculation basis and verified coverage',()=>{
 const technical='IB 五端点直读；日涨跌用 session-pnl-v1（daily_pnl ÷ 本轮开盘基准），逐仓经受信 venue resolver 定位，覆盖 26/26。盘中读数与次日早间版收盘读数本就不同，不作对账。';
 assert.equal(conciseHoldingsNote(technical),'IB 数据直读；日涨跌按本轮开盘基准计算，已覆盖 26/26 只持仓。');
 assert.equal(conciseHoldingsNote('其它来源说明保持原文。'),'其它来源说明保持原文。');
});

const risk={title:'AI 压力敞口 · §0-C',state:'brief-signal attention',
 takeaway:'1. 中情景 22.50%，提醒区间，未越 25%',action:'2. 下一步：观察',
 kpiLabel:'AI 压力中情景',kpiValue:'22.50%',kpiDetails:'三账户含现金 · 提醒区间（>20%，未越 25%）'};
test('AI strip copies agreeing source value and labels the two explicit reference lines',()=>{
 assert.deepEqual(aiRiskStripValues(risk),[['提醒','20%'],['当前','22.50%'],['预警','25%']]);
 for(const value of ['20.01','21.91','24.99'])assert.equal(aiRiskStripValues({...risk,
  takeaway:`1. 中情景 ${value}%，提醒区间，未越 25%`,kpiValue:`${value}%`})[1][1],`${value}%`);
 assert.match(MOBILE_READING_CSS,/\.ai-risk-strip\{display:flex;flex-wrap:wrap/);
 assert.doesNotMatch(MOBILE_READING_CSS,/\.ai-risk-strip[^}]*overflow:hidden/);
});
test('newer bedtime reports keep the Draft three-point AI strip',()=>{
 assert.deepEqual(aiRiskBandValues('27.82%'),{values:[['提醒','20%'],['当前','27.82%'],['预警','25%']],band:'alert'});
 assert.equal(aiRiskBandValues('22.02%').band,'attention');
 assert.equal(aiRiskBandValues('19.99%').band,'normal');
 for(const value of ['', '27.82', '未取得', '-1%', '101%'])assert.equal(aiRiskBandValues(value),null,value);
 assert.match(MOBILE_READING_CSS,/data-band="alert"/);
});
test('AI KPI uses the primary three-account single-stock view, excludes BRK.B, and retains the IB fallback',()=>{
 const headers=['IB 视图标的','市值 $','占比 / 线','余量 $'];
 const rows=[['BRK.B 专线','228,546','4.24% / 12.8%','461,206'],['META','64,890','1.20% / 5%','204,544'],['TSLA','142,849','2.65% / 5%','126,585'],['GOOG','72,380','1.34% / 5%','197,054']];
 assert.deepEqual(largestOrdinaryConcentration(headers,rows,'1. GOOG 三账户 4.70%，IB 视图 0 项告警'),{symbol:'GOOG',percent:4.7,label:'GOOG 4.70%'});
 assert.deepEqual(largestOrdinaryConcentration(headers,rows),{symbol:'TSLA',percent:2.65,label:'TSLA 2.65%'});
 assert.deepEqual(largestOrdinaryConcentration(headers,rows,'BRK.B 三账户 9.99%'),{symbol:'TSLA',percent:2.65,label:'TSLA 2.65%'});
 assert.equal(largestOrdinaryConcentration(['标的','市值','占比','余量'],rows),null);
 assert.match(MOBILE_READING_CSS,/\.kpi-secondary/);
});
test('current family single-stock value is derived exactly from the published fact and AI denominator',()=>{
 const fact='本期三账户 GOOG/GOOGL：IB 220.00 股 74,082.80 USD（盘中）、Schwab-HK GOOGL 302.00 股 102,447.46 USD、Webull GOOG 360.00 股 121,217.40 USD，合计 297,747.66 USD；阈值与执行口径不变。';
 assert.deepEqual(familySingleStockConcentration(fact,'618529884'),{symbol:'GOOG',percent:4.81,label:'GOOG 4.81%',amount:'297,747.66'});
 for(const [bad,denominator] of [['其它事实','618529884'],[fact,''],[fact,'0'],[fact,'not-a-number']])assert.equal(familySingleStockConcentration(bad,denominator),null);
});
test('Thursday-style risk cards copy verified cash values without recomputing them',()=>{
 assert.deepEqual(cashRiskSummary('$556,709 · 占 NAV 11.07%'),{label:'IB 现金',value:'$556,709',detail:'占 NAV 11.07%'});
 assert.equal(cashRiskSummary('$556,709 · 未取得'),null);
 assert.equal(reserveRiskSummary('reserve $240,000，<1.0x 才告警'),'$240,000');
 assert.equal(reserveRiskSummary('预留 CALL：$240,000'),'$240,000');
 assert.equal(reserveRiskSummary('规划预算扣除预留 $240,000，共 $690,586'),'$240,000');
 assert.equal(reserveRiskSummary('预留款未取得'),null);
 assert.match(MOBILE_READING_CSS,/\.thursday-risk-summary/);
 assert.match(MOBILE_READING_CSS,/\.pane\.p2>section\.card/);
 assert.match(MOBILE_READING_CSS,/\.cash-reserve-strip/);
});
test('AI strip preserves unfamiliar, missing, qualified, mismatched and genuine action states',()=>{
 for(const patch of [{title:'单票集中度'},{title:'历史 AI 压力敞口'},{state:'brief-signal normal'},
  {state:'brief-signal attention unverified'},{action:'2. 下一步：待你裁决'},
  {takeaway:'1. 中情景约 22.50%，提醒区间，未越 25%'},
  {takeaway:risk.takeaway+'；来源缺失'},{kpiValue:'22.51%'},{kpiValue:'22.50%（估计）'},
  {kpiValue:''},{kpiLabel:'低情景'},{kpiDetails:'提醒区间（>18%，未越 25%）'},
  {kpiDetails:'提醒区间（>20%，未越 30%）'},{kpiDetails:'未取得'},
  {kpiDetails:risk.kpiDetails+'；中情景近似'},{kpiDetails:risk.kpiDetails+'；来源缺失'},
  {kpiDetails:risk.kpiDetails+'；尚未计入 AAOI'},
  ...['数据冲突','未取得','数据降级','已过期'].map(x=>({kpiDetails:risk.kpiDetails+'；'+x}))]){
  assert.equal(aiRiskStripValues({...risk,...patch}),null,JSON.stringify(patch));
 }
 for(const value of ['0','20','25','25.01','30','100','-1','NaN','Infinity'])assert.equal(aiRiskStripValues({...risk,
  takeaway:`1. 中情景 ${value}%，提醒区间，未越 25%`,kpiValue:`${value}%`}),null,value);
 assert.equal(aiRiskStripValues(),null);
});
