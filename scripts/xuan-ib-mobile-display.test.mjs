// Minimal DOM contract model; real-width acceptance is a separate browser check.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {improveMobileDisplay,GUIDE_BODY,extractReadingMetrics,extractCashGuidance,MOBILE_READING_CSS,aiRiskStripValues} from './xuan-ib-mobile-display.mjs';
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
});
test('critical replenishment amounts remain visible without recomputing or guessing',()=>{
 assert.deepEqual(extractCashGuidance('EXUS $550,579 EIMI $128,701 USSC $75,476'),[['EXUS','$550,579'],['EIMI','$128,701'],['USSC','$75,476']]);
 assert.deepEqual(extractCashGuidance('EXUS $550,579EIMI $128,701USSC $75,476两类仍需 $84,768'),[['EXUS','$550,579'],['EIMI','$128,701'],['USSC','$75,476']]);
 assert.deepEqual(extractCashGuidance('EXUS 未取得 USSC 待回款后重算'),[['USSC','待回款后重算']]);
 assert.deepEqual(extractCashGuidance('无有效补仓数值'),[]);
});
test('reading metrics copy labelled values exactly, without inferring missing values',()=>{
 assert.deepEqual(extractReadingMetrics('中情景 21.76% · 分母 $6,198,031.57'),[['AI 中情景','21.76%'],['三账户总额','$6,198,031.57']]);
 assert.deepEqual(extractReadingMetrics('26 只 · 权威市值 $4,420,972'),[['持仓数量','26 只'],['持仓市值','$4,420,972']]);
 assert.deepEqual(extractReadingMetrics('行情未取得，低情景近似 16.20%'),[]);
 assert.deepEqual(extractReadingMetrics('HL 17.75% / 40% · 常青基金 15.93%'),[['HL 当前 / 目标','17.75% / 40%'],['常青基金','15.93%']]);
 assert.match(MOBILE_READING_CSS,/white-space:nowrap!important/);
 assert.match(MOBILE_READING_CSS,/repeat\(2,minmax\(0,1fr\)\)/);
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
