import vm from "node:vm";
import crypto from "node:crypto";
import { buildFeeCalculationReceipt } from "./fee-receipt-core.mjs";
/**
 * 收益率口径 v4.6.1 的回归测试。
 *
 * 本文件用完全合成、不对应任何账户的数字钉住两件事：
 *   1. 口径 §9 写「时间加权」，实现就必须是逐日 TWR，不能回退成
 *      逐月 Modified Dietz。合成场景故意把较多收益放在流入后，使两种方法明显分开。
 *   2. 出入金的在场天数差一天：转入按 8/20 收盘价计价，当天吃不到行情，只在场
 *      8/21–8/24 共 4 天；旧代码曾按 5 天计权，系统性低估流入月的收益率。
 *
 * 合成数字只服务于方法回归，不表示任何实际组合、持仓、交易或市场快照。
 *
 * periodReturns 由可信 writer 的纯引擎提供。手机迁移后只消费计算回执，
 * 不再保留或执行这套公式。
 */
import "./fund-investor-core.test.mjs";
import "./fund-investor-ui.test.mjs";
import "./fund-remote-storage.test.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { periodReturns } from "./fee-engine.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");

const block = periodReturns.toString();
const annMatch = html.match(/function ann\(r,days\)\{([^}]*)\}/);
assert.ok(annMatch, "index.html must carry the annualisation helper");
const annualise = new Function("r", "days", annMatch[1]);
const versionMatch = html.match(/" · v(\d+)\.(\d+)\.(\d+)"/);
assert.ok(versionMatch, "index.html must carry a semantic UI version");
const versionCode = Number(versionMatch[1]) * 1e6 + Number(versionMatch[2]) * 1e3 + Number(versionMatch[3]);
const usesDailyEodFee = versionCode >= 4e6 + 6e3 + 1;

/* ---------------- 24 天合成场景 ---------------- */

const OPEN = 100000;
const TRANSFER = 24000; // 第 20 天收盘记账，只参与后续 4/24 的资金权重
const DATES = Array.from({ length: 24 }, (_, i) =>
  `2026-08-${String(i + 1).padStart(2, "0")}`);

// 组合仅在第 3 天涨 1%、第 24 天涨 3%；第 20 天只有收盘流入。
// 流入后的收益较高，因而 TWR 与 Modified Dietz 必然明显分开。
let syntheticNav = OPEN;
const TOTALS = DATES.map(d => {
  if (d === "2026-08-03") syntheticNav *= 1.01;
  if (d === "2026-08-20") syntheticNav += TRANSFER;
  if (d === "2026-08-24") syntheticNav *= 1.03;
  return [d, syntheticNav];
});

const points = TOTALS.map(([d, tot]) => ({ d, tot }));

const august = (over = {}) => periodReturns({
    points, openT: OPEN, from: "2026-08-01", to: "2026-08-24", days: 24,
    flowByDate: { "2026-08-20": TRANSFER },
    rate: 0.02, cr: 0.20, cumBefore: 0, hwmBefore: 0, feesBefore: 0,
    ...over,
  });

const near = (actual, expected, tol, label) =>
  assert.ok(Math.abs(actual - expected) <= tol,
    `${label}: got ${actual}, expected ${expected} ±${tol}`);

test("invalid returns never annualise to a real-looking zero", () => {
  assert.equal(annualise(null, 366), null);
  assert.equal(annualise(undefined, 366), null);
  assert.equal(annualise(Number.NaN, 366), null);
  assert.equal(annualise(0.10, 0), null);
  near(annualise(0.10, 365), 0.10, 1e-12, "有效年化");
});

test("the writer return engine contains no duplicate benchmark implementation", () => {
  assert.doesNotMatch(block, /benchmark|bPrev|bVal|bHas|\brB\b/);
  assert.equal((html.match(/function benchmarkView\s*\(/g) || []).length, 1,
    "index.html must have exactly one benchmarkView implementation");
  if (!html.includes("/* benchmark-state-evidence:start */")) {
    assert.doesNotMatch(html, /BENCH_STATE_EVIDENCE_FROM|\bbstate\b/,
      "an unmarked partial benchmark-state rollout cannot pass");
    return;
  }
  assert.equal(html.split("/* benchmark-state-evidence:start */").length, 2);
  assert.equal(html.split("/* benchmark-state-evidence:end */").length, 2);
  assert.doesNotMatch(html, /laterProvesClosed|benchmarkWeekend|推定休市/);
});

/* ---------------- 费用链条：逐日 EOD pre-flow NAV 与口径 §3 / §4 一致 ---------------- */

test("gross gain excludes the synthetic EOD flow, and daily management fees match §3/§4", () => {
  const r = august();
  near(r.pnl, 4750, 0.01, "当月净收益（毛）");
  // 每日基数使用收盘总资产减去当日 EOD flow：8/20 的 24,000 入金从次日起计费。
  const dailyBases = 100000 * 2 + 101000 * 18 + 125000 * 3 + 128750;
  const endpointAverage = (OPEN + 128750) / 2 * 0.02 * 24 / 365;
  const expectedMgmt = usesDailyEodFee ? dailyBases * 0.02 / 365 : endpointAverage;
  near(r.mgmt, expectedMgmt, 0.01, "版本对应的管理费 §3");
  near(r.mgmt, usesDailyEodFee ? 138.18 : 150.41, 0.01, "管理费");
  near(r.carry, 950, 0.01, "Carry");
  near(r.fees, usesDailyEodFee ? 1088.18 : 1100.41, 0.02, "费用合计");
});

test("an EOD contribution starts accruing management fees on the following day", () => {
  const r = periodReturns({
    points: [
      { d: "2026-09-01", tot: 100 },
      { d: "2026-09-02", tot: 150 },
      { d: "2026-09-03", tot: 150 },
    ],
    openT: 100, from: "2026-09-01", to: "2026-09-03", days: 3,
    flowByDate: { "2026-09-02": 50 }, rate: 0.0365, cr: 0,
    cumBefore: 0, hwmBefore: 0,
  });
  // 基数 100 + (150−50) + 150；日费率 0.0365/365 = 0.0001。
  near(r.mgmt, usesDailyEodFee ? 0.035 : 0.0375, 1e-12, "EOD 入金版本门槛");
});

test("an EOD withdrawal still accrues on the pre-withdrawal NAV that day", () => {
  const r = periodReturns({
    points: [
      { d: "2026-09-01", tot: 100 },
      { d: "2026-09-02", tot: 60 },
      { d: "2026-09-03", tot: 60 },
    ],
    openT: 100, from: "2026-09-01", to: "2026-09-03", days: 3,
    flowByDate: { "2026-09-02": -40 }, rate: 0.0365, cr: 0,
    cumBefore: 0, hwmBefore: 0,
  });
  // 基数 100 + (60−(−40)) + 60。
  near(r.mgmt, usesDailyEodFee ? 0.026 : 0.024, 1e-12, "EOD 出金版本门槛");
});

test("v4.6.1 and later expose only decision-useful TWR metrics", () => {
  if (!usesDailyEodFee) return;
  assert.doesNotMatch(html, /扣费后 TWR|组合扣费后 TWR/);
  assert.doesNotMatch(block, /\brN\b|\bidxN\b|\bprevN\b/);
  assert.match(html, /SPY·含息 ETF TWR/);
  assert.match(html, /QQQ·含息 ETF TWR/);
  assert.match(html, /现金流匹配的被动账户期末值/);
  assert.match(html, /相同资金路径下的期末金额/);
});

/* ---------------- 1. 逐日 TWR，而不是逐月 Modified Dietz ---------------- */

test("the gross rate is a daily time-weighted chain", () => {
  const r = august();
  near(r.rG, 1.01 * 1.03 - 1, 1e-12, "投资收益率（逐日 TWR，扣费前）");
  // 逐月 Modified Dietz 会给 4.5673%；故意的时点差异让回归足够敏感。
  assert.ok(Math.abs(r.rG - (r.pnl / r.den)) > 0.005,
    "rG must not fall back to monthly Modified Dietz");
});

/* ---------------- 2. 出入金在场天数：4/24，不是 5/24 ---------------- */

test("a flow booked at its own close is out of the market that day", () => {
  const r = august();
  // 分母 = 100,000 + 24,000 × 4/24
  near(r.den, OPEN + TRANSFER * 4 / 24, 1e-12, "Modified Dietz 分母");
  assert.ok(Math.abs(r.den - (OPEN + TRANSFER * 5 / 24)) > 1,
    "the flow must not be credited with the day it was priced on");
});

test("the LP rate is Modified Dietz and converges on the true IRR", () => {
  const r = august();
  near(r.rD, usesDailyEodFee ? 0.035209826132771335 : 0.035092202318229716,
    1e-12, "出资方净收益率");
  // 同一合成现金流序列的数值求解 IRR 为 3.5112%，两种 money-weighted
  // 方法必须收敛。
  near(r.rD, 0.035111545404666544, 0.0001, "Modified Dietz vs IRR");
});

test("the LP rate carries the LP's own timing, so it is not a fee gap", () => {
  const r = august();
  // 合成流入后发生了较大涨幅，因此未扣费的资金加权择时效应为正；
  // Modified Dietz 仍含费用，不应拿它和组合毛 TWR 相减解释费用。
  near((r.pnl / r.den) - r.rG, 0.005373076923076918, 1e-12, "出资方择时效应");
  assert.ok(r.rD < r.pnl / r.den, "the LP rate must reflect accrued fees");
});

test("a flow on the first day is in the market for days-1", () => {
  const r = august({ flowByDate: { "2026-08-01": TRANSFER } });
  near(r.den, OPEN + TRANSFER * 23 / 24, 0.01, "首日流入的分母");
});

test("a flow on the last day earns nothing at all", () => {
  const r = august({ flowByDate: { "2026-08-24": TRANSFER } });
  near(r.den, OPEN, 0.01, "末日流入的分母");
});

test("a flow date without a same-day valuation disables returns instead of creating a false gain", () => {
  const broken = periodReturns({
    points: [
      { d: "2026-08-01", tot: 100 },
      { d: "2026-08-03", tot: 1100 },
    ],
    openT: 100, from: "2026-08-01", to: "2026-08-03", days: 3,
    flowByDate: { "2026-08-02": 1000 }, rate: 0, cr: 0,
    cumBefore: 0, hwmBefore: 0, feesBefore: 0,
  });
  assert.equal(broken.rG, null);
  assert.ok(broken.issues.some(x=>/出入金当日缺少估值 2026-08-02/.test(x)), broken.issues.join("; "));
});

test("a same-month flow outside the requested interval is refused", () => {
  const broken = periodReturns({
    points: [{ d: "2026-08-10", tot: 100 }],
    openT: 100, from: "2026-08-10", to: "2026-08-10", days: 1,
    flowByDate: { "2026-08-05": 50 }, rate: 0, cr: 0,
    cumBefore: 0, hwmBefore: 0, feesBefore: 0,
  });
  assert.equal(broken.rG, null);
  assert.equal(broken.flowT, 0);
  assert.ok(broken.issues.some(x=>/出入金日期越界 2026-08-05/.test(x)), broken.issues.join("; "));
});

/* maximum-drawdown-contract:start */
{

// Entirely synthetic fixtures. No financial source, credential, real ledger,
// encryption/decryption, browser state or network access is used by this suite.
const here=path.dirname(fileURLToPath(import.meta.url));
const htmlPath=process.env.FEE_LEDGER_TEST_INDEX||path.join(here,'..','index.html');
if(process.env.GITHUB_ACTIONS==='true'&&process.env.FEE_LEDGER_TEST_INDEX)throw new Error('external UI preview is local-only');
const html=fs.readFileSync(htmlPath,'utf8');
const hasDrawdown=html.includes('/* max-drawdown-view:start */');
const hasPeriodDisplay=html.includes('/* return-period-display:start */');
const hasDrawdownEpisode=html.includes('/* drawdown-episode-metadata:start */');
const episodeTest=(name,fn)=>test(name,{skip:hasDrawdownEpisode?false:'support stage: episode metadata is in the separate index-only UI change'},fn);
const periodDisplayTest=(name,fn)=>test(name,{skip:hasPeriodDisplay?false:'support stage: shared period display is in the separate index-only UI change'},fn);
const drawdownTest=(name,fn)=>test(name,{skip:hasDrawdown?false:'support stage: display implementation is in the separate index-only UI PR'},fn);

const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-10,`${a} != ${b}`);
const plain=x=>JSON.parse(JSON.stringify(x));
const section=(start,end)=>{
  assert.equal(html.split(start).length,2);assert.equal(html.split(end).length,2);
  return html.slice(html.indexOf(start)+start.length,html.indexOf(end));
};
function fixture(){
  const economicInput={v:4,settings:{start:'2026-08-01',mgmt:2,carry:20,fx:{USD:1}},
    accounts:[{id:'schwab',opening:60},{id:'webull',opening:40}],
    months:[{ym:'2026-08',flows:[
      {id:'synthetic-deposit',date:'2026-08-02',acct:'webull',amount:900,note:'SYNTHETIC cash contribution'},
      {id:'synthetic-withdrawal',date:'2026-08-04',acct:'webull',amount:-300,note:'SYNTHETIC withdrawal'}]}],
    fees:[{id:'external-fee',date:'2026-08-05',amount:25,ccy:'USD'}]};
  const totals=[100,120,990,1210,580,942.5],spy=[100,100,90,95,80,110],qqq=[100,110,90,100,120,130];
  const data={daily:totals.map((value,i)=>({d:i?`2026-08-0${i}`:'2026-07-31',schwab:0,webull:value,spy:spy[i],qqq:qqq[i]})),
    flowsAuto:[],flowsUnresolved:[],status:{asOf:'2026-08-05',provisional:false,calibrated:true,unresolvedCount:0}};
  return {data,economicInput};
}
async function model(input=fixture()){
  const receipt=buildFeeCalculationReceipt(input),nodes={};
  const sandbox={crypto:{subtle:{digest:crypto.webcrypto.subtle.digest.bind(crypto.webcrypto.subtle)}},
    TextEncoder,TextDecoder,Uint8Array,structuredClone,DAILY:input.data,DB:input.economicInput,
    document:{getElementById:id=>nodes[id]??=(id==='benchExplain'?{open:false}:{innerHTML:''})}};
  vm.createContext(sandbox);
  vm.runInContext(section('/* fee-receipt-consumer:start */','/* fee-receipt-consumer:end */'),sandbox);
  vm.runInContext(section('/* fee-receipt-render:start */','/* fee-receipt-render:end */'),sandbox);
  vm.runInContext(`
    const num=v=>{const n=parseFloat(v);return isFinite(n)?n:0;};
    const usd=(v,d=2)=>v==null||!isFinite(v)?'—':(v<0?'-$':'$')+Math.abs(v).toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d});
    const fmt=(v,d=2)=>v==null||!isFinite(v)?'—':Number(v).toFixed(d);
    const pct=(v,d=2)=>v==null||!isFinite(v)?'—':(v>0?'+':'')+(v*100).toFixed(d)+'%';
    const sgn=v=>v>0?'pos':v<0?'neg':'';
    const esc=v=>String(v??'');
    const ann=()=>null;
    function dailySorted(){return [...DAILY.daily].sort((a,b)=>a.d.localeCompare(b.d));}
    function totOf(p){return DB.accounts.reduce((sum,a)=>sum+num(p[a.id]),0);}
    function topHoldingsView(){return '';}
  `,sandbox);
  vm.runInContext(html.slice(html.indexOf('const BENCH_ALL='),html.indexOf('function receiptBalance(')),sandbox);
  vm.runInContext(html.slice(html.indexOf('function renderKPIs('),html.indexOf('function renderChart1(')),sandbox);
  const validation=await sandbox.feeReceiptUiModel({...input,receipt});
  assert.equal(validation.ok,true);
  const feeView=sandbox.feeReceiptRenderProjection(validation),st=sandbox.receiptState(feeView);
  return {sandbox,feeView,st,receipt,input,nodes};
}

test('the complete inline source parses',()=>{
  for(const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi))new vm.Script(m[2]);
});

drawdownTest('real receipt gate + flow-adjusted curve finds peak/trough despite cash movement and recovery',async()=>{
  const {sandbox,feeView,st}=await model(),out=sandbox.drawdownView(feeView);
  near(st.twrG,.30);near(out.actual.value,1-.8/1.2);
  assert.equal(out.actual.peakDate,'2026-08-01');assert.equal(out.actual.troughDate,'2026-08-04');
  near(out.spy.value,.20);near(out.qqq.value,1-90/110);
  assert.equal(out.start,'2026-08-01');assert.equal(out.through,'2026-08-05');
});

drawdownTest('cash and in-kind transfers never manufacture a drawdown on a flat unit curve',async()=>{
  const input=fixture(),values=[100,100,1000,1000,700,700];
  input.data.daily.forEach((p,i)=>Object.assign(p,{webull:values[i],spy:100,qqq:100}));
  const businessKey='synthetic:source->target;holding:1';
  const id=crypto.createHash('sha256').update(`external_asset_transfer ${businessKey}`).digest('hex').slice(0,16);
  input.data.flowsAuto=[{id,date:'2026-08-02',acct:'webull',amount:900,effective:true,businessKey,
    reason:`verified external asset transfer ${businessKey}`,desc:'SYNTHETIC in-kind'}];
  input.economicInput.months[0].flows[0].src=id;
  const {sandbox,feeView,receipt}=await model(input),out=sandbox.drawdownView(feeView);
  assert.equal(receipt.effectiveFlowCount,2);
  for(const key of ['actual','spy','qqq']){assert.equal(out[key].state,'verified');near(out[key].value,0);}
});

drawdownTest('the initial unit value participates: a first-day loss is a drawdown',async()=>{
  const {sandbox}=await model();
  const out=sandbox.maxDrawdownFromFactors([{d:'2026-08-01',factor:.7}],'2026-07-31');
  near(out.value,.30);assert.equal(out.peakDate,'2026-07-31');assert.equal(out.troughDate,'2026-08-01');
});

drawdownTest('rising prices and verified flat prices return zero, not pending',async()=>{
  const {sandbox}=await model();
  for(const factors of [[1.1,1.2,1.01],[1,1,1]]){
    const out=sandbox.maxDrawdownFromFactors(factors.map((factor,i)=>({d:`2026-08-0${i+1}`,factor})),'2026-07-31');
    assert.equal(out.state,'verified');assert.equal(out.value,0);assert.equal(out.peakDate,null);
  }
});

drawdownTest('total loss is 100%; malformed/negative/nonfinite/empty curves remain unverified',async()=>{
  const {sandbox}=await model();near(sandbox.maxDrawdownFromFactors([{d:'2026-08-01',factor:0}],'2026-07-31').value,1);
  for(const factors of [[],[{d:'2026-08-01',factor:-1}],[{d:'2026-08-01',factor:NaN}],[{d:'2026-08-01',factor:Infinity}],
    [{d:'2026-08-01',factor:1},{d:'2026-08-01',factor:.5}],
    [{d:'2026-08-01',factor:1e308},{d:'2026-08-02',factor:1e308}]]){
    const out=sandbox.maxDrawdownFromFactors(factors,'2026-07-31');assert.equal(out.state,'pending');assert.equal(out.value,null);
  }
});

drawdownTest('dividend-adjusted benchmark drawdown uses the same factor as the existing TWR',async()=>{
  const input=fixture();input.data.daily.forEach(p=>Object.assign(p,{spy:100,qqq:100}));
  input.data.daily[1].spy=90;input.data.daily[1].spyd=10;
  const {sandbox,feeView,st}=await model(input),out=sandbox.drawdownView(feeView);
  near(sandbox.benchmarkDailyFactor(90,10,100,false),.97);
  near(out.spy.value,.03);
  // The same first-day .97 factor is the beginning of the existing TWR chain.
  near(st.bench[0].twr,.97*(100/90)-1);
});

drawdownTest('external fee payment and accrual changes never affect the gross drawdown series',async()=>{
  const first=await model(),input=fixture();input.economicInput.fees[0].amount=999;
  input.economicInput.settings.mgmt=7;input.economicInput.settings.carry=50;
  const second=await model(input);
  assert.notEqual(first.receipt.balance.paidCents,second.receipt.balance.paidCents);
  assert.notEqual(first.receipt.totals.investorDietzPpm,second.receipt.totals.investorDietzPpm);
  assert.deepEqual(plain(first.sandbox.drawdownView(first.feeView)),plain(second.sandbox.drawdownView(second.feeView)));
});

drawdownTest('missing receipt/flows/account value stays unverified, never real-looking zero',async()=>{
  const {sandbox,feeView,input}=await model();
  for(const view of [{...feeView,state:'pending'},{...feeView,benchmarkInputs:null},
    {...feeView,benchmarkInputs:{...feeView.benchmarkInputs,openingCents:0}}]){
    const out=sandbox.drawdownView(view);assert.equal(out.actual.state,'pending');assert.equal(out.actual.value,null);
  }
  delete input.data.daily[2].webull;
  const out=sandbox.drawdownView(feeView);assert.equal(out.actual.state,'pending');assert.equal(out.spy.state,'verified');
});

drawdownTest('a missing calendar day suppresses affected coverage rather than bridging the gap',async()=>{
  const {sandbox,feeView,input}=await model();input.data.daily.splice(2,1);
  const out=sandbox.drawdownView(feeView);
  for(const key of ['actual','spy','qqq']){assert.equal(out[key].state,'pending');assert.equal(out[key].value,null);}
});

drawdownTest('one absent benchmark does not fabricate zero or hide the valid portfolio/other benchmark',async()=>{
  const {sandbox,feeView,input}=await model();for(const p of input.data.daily)delete p.qqq;
  const out=sandbox.drawdownView(feeView);
  assert.equal(out.actual.state,'verified');assert.equal(out.spy.state,'verified');assert.equal(out.qqq.state,'pending');
  assert.equal(out.through,feeView.asOf);
});

drawdownTest('common cutoff clips all three drawdowns and clearly labels the later asset date',async()=>{
  const input=fixture(),dates=['2026-09-14','2026-09-15','2026-09-16','2026-09-17'];
  input.economicInput.settings.start=dates[1];input.economicInput.months=[];input.economicInput.fees=[];
  input.data.daily=input.data.daily.slice(0,4);
  const values=[100,120,110,50],spy=[100,100,90,10],qqq=[100,110,100,10];
  input.data.daily.forEach((p,i)=>Object.assign(p,{d:dates[i],bd:dates[i],bstate:'session',webull:values[i],spy:spy[i],qqq:qqq[i]}));
  delete input.data.daily[3].qqq;input.data.status.asOf=dates[3];
  const {sandbox,feeView}=await model(input),out=sandbox.drawdownView(feeView);
  assert.equal(out.through,dates[2]);assert.equal(out.latest,dates[3]);
  near(out.actual.value,1-110/120);near(out.spy.value,.10);near(out.qqq.value,1-100/110);
  assert.match(sandbox.renderDrawdowns(feeView),hasPeriodDisplay?/回撤统计期间：2026-09-15 → 2026-09-16，共 2 个自然日（收益截至 2026-09-17，区间不同）/:/2026-09-15 → 2026-09-16（共同截至；最新资产 2026-09-17）/);
});

drawdownTest('verified closed-session carry is flat; false carry and closed-session dividends are unverified',async()=>{
  const input=fixture(),dates=['2026-09-17','2026-09-18','2026-09-19','2026-09-20'];
  input.economicInput.settings.start=dates[1];input.economicInput.months=[];input.economicInput.fees=[];
  input.data.daily=input.data.daily.slice(0,4);
  input.data.daily.forEach((p,i)=>Object.assign(p,{d:dates[i],bd:i>1?dates[1]:dates[i],bstate:i>1?'closed':'session',webull:100,spy:100,qqq:100}));
  input.data.status.asOf=dates[3];
  const {sandbox,feeView}=await model(input);
  near(sandbox.drawdownView(feeView).spy.value,0);
  input.data.daily[2].spy=80;assert.equal(sandbox.drawdownView(feeView).spy.state,'pending');
  input.data.daily[2].spy=100;input.data.daily[2].spyd=1;assert.equal(sandbox.drawdownView(feeView).spy.state,'pending');
});

drawdownTest('original four returns remain unchanged; drawdown is an independent adjacent three-series group',async()=>{
  const {sandbox,feeView,st,nodes,receipt}=await model();
  sandbox.renderKPIs(feeView,st,{due:receipt.balance.dueCents/100},{hold:false,holdReasons:[]});
  const out=nodes.kpis.innerHTML;
  assert.match(out,/组合毛 TWR（管理能力）/);assert.match(out,/出资方 Modified Dietz（EOD flow 模型）/);
  assert.match(out,/data-drawdown-series="actual"[^]*?-33\.33%/);
  assert.match(out,/data-drawdown-series="spy"[^]*?-20\.00%/);
  assert.match(out,/data-drawdown-series="qqq"[^]*?-18\.18%/);
  assert.equal((out.match(/data-drawdown-series=/g)||[]).length,3);
  assert.match(out,/Modified Dietz 是期间收益率，不单独计算回撤/);
  assert.ok(out.indexOf('同期最大回撤')>out.indexOf('出资方 Modified Dietz'));
});

drawdownTest('pending receipt renders three explicit unverified values and no invented 0.00%',async()=>{
  const {sandbox}=await model();
  const out=sandbox.renderDrawdowns({state:'pending',start:null,asOf:null});
  assert.equal((out.match(/未核实<\/b>/g)||[]).length,3);
  assert.ok(!out.includes('0.00%'));assert.match(out,hasPeriodDisplay?/回撤统计期间待核实/:/日期区间待核实/);
});

drawdownTest('drawdown calculation has no access to fee payments, credentials, network, storage or publication',()=>{
  const code=section('/* max-drawdown-view:start */','/* max-drawdown-view:end */');
  assert.doesNotMatch(code,/DB\.fees|fetch\(|localStorage|sessionStorage|crypto\.|cfg\(|GH_|publish|decrypt|Keychain/);
});

// The support PR remains valid before the independently protected UI rollout.
// A partial/unmarked rollout must not silently skip the contract suite.
test('drawdown rollout is either absent or fully marked for this contract suite',()=>{
  if(!hasDrawdown){
    assert.ok(!html.includes('function maxDrawdownFromFactors('));
    assert.ok(!html.includes('function drawdownView('));
    assert.ok(!html.includes('function renderDrawdowns('));
    assert.ok(!html.includes('/* max-drawdown-view:end */'));
  }else{
    section('/* max-drawdown-view:start */','/* max-drawdown-view:end */');
    assert.ok(html.includes('function maxDrawdownFromFactors('));
    assert.ok(html.includes('function drawdownView('));
    assert.ok(html.includes('function renderDrawdowns('));
  }
});

/* return-period-display-contract:start */
periodDisplayTest('period labels use inclusive calendar days, not elapsed dates or the opening anchor',async()=>{
  const {sandbox}=await model();
  assert.equal(sandbox.returnPeriodLabel('2026-08-01','2026-10-22'),'2026-08-01 → 2026-10-22，共 83 个自然日');
  assert.equal(sandbox.returnPeriodLabel('2026-08-01','2026-08-01'),'2026-08-01 → 2026-08-01，共 1 个自然日');
});

periodDisplayTest('calendar labels remain correct across leap days, year boundaries and DST dates',async()=>{
  const {sandbox}=await model();
  for(const [from,to,days] of [['2024-02-28','2024-03-01',3],['2026-02-28','2026-03-01',2],
    ['2026-12-31','2027-01-01',2],['2026-03-07','2026-03-09',3]]){
    assert.equal(sandbox.returnPeriodLabel(from,to),`${from} → ${to}，共 ${days} 个自然日`);
  }
});

periodDisplayTest('invalid or reversed periods remain unverified instead of showing a false zero-day window',async()=>{
  const {sandbox}=await model();
  for(const [from,to] of [[null,null],['','2026-08-01'],['2026-02-30','2026-03-01'],
    ['2026-08-05','2026-08-01'],['2026-08-01','invalid']])assert.equal(sandbox.returnPeriodLabel(from,to),null);
});

periodDisplayTest('matching returns and drawdown windows share exactly one period line with daily-close wording',async()=>{
  const {sandbox,feeView,st,nodes,receipt}=await model();
  sandbox.renderKPIs(feeView,st,{due:receipt.balance.dueCents/100},{hold:false,holdReasons:[]});
  const out=nodes.kpis.innerHTML,range='2026-08-01 → 2026-08-05';
  assert.match(out,/统计期间：2026-08-01 → 2026-08-05，共 5 个自然日/);
  assert.equal(out.split(range).length-1,1);
  assert.ok(!sandbox.renderDrawdowns(feeView).includes(range));
  assert.match(out,/同期最大回撤 · 费前/);
  assert.match(out,/日末单位净值（TWR）曲线计算/);
});

periodDisplayTest('the existing model window updates the shared period automatically without a fixed 83-day assumption',async()=>{
  const input=fixture();input.economicInput.settings.start='2026-09-01';
  input.economicInput.months=[];input.economicInput.fees=[];
  const dates=['2026-08-31','2026-09-01','2026-09-02','2026-09-03'];
  input.data.daily=input.data.daily.slice(0,4);
  input.data.daily.forEach((p,i)=>Object.assign(p,{d:dates[i],webull:[100,110,105,120][i],spy:[100,101,99,102][i],qqq:[100,102,100,103][i]}));
  input.data.status.asOf='2026-09-03';
  const {sandbox,feeView,st,nodes,receipt}=await model(input);
  sandbox.renderKPIs(feeView,st,{due:receipt.balance.dueCents/100},{hold:false,holdReasons:[]});
  assert.match(nodes.kpis.innerHTML,/统计期间：2026-09-01 → 2026-09-03，共 3 个自然日/);
  assert.ok(!nodes.kpis.innerHTML.includes('83 个自然日'));
});

periodDisplayTest('lagged drawdown coverage uses its own day count and never claims the same period',async()=>{
  const input=fixture(),dates=['2026-09-14','2026-09-15','2026-09-16','2026-09-17'];
  input.economicInput.settings.start=dates[1];input.economicInput.months=[];input.economicInput.fees=[];
  input.data.daily=input.data.daily.slice(0,4);
  input.data.daily.forEach((p,i)=>Object.assign(p,{d:dates[i],bd:dates[i],bstate:'session',webull:[100,120,110,50][i],spy:[100,100,90,10][i],qqq:[100,110,100,10][i]}));
  delete input.data.daily[3].qqq;input.data.status.asOf=dates[3];
  const {sandbox,feeView,st,nodes,receipt}=await model(input);
  sandbox.renderKPIs(feeView,st,{due:receipt.balance.dueCents/100},{hold:false,holdReasons:[]});
  const drawdown=sandbox.renderDrawdowns(feeView);
  assert.match(nodes.kpis.innerHTML,/统计期间：2026-09-15 → 2026-09-17，共 3 个自然日/);
  assert.match(drawdown,/回撤统计期间：2026-09-15 → 2026-09-16，共 2 个自然日（收益截至 2026-09-17，区间不同）/);
  assert.ok(!drawdown.includes('同期'));
  assert.match(nodes.kpis.innerHTML,/截至 2026-09-16/);
});

periodDisplayTest('missing periods keep the date and all three drawdowns explicitly unverified',async()=>{
  const {sandbox}=await model();
  const out=sandbox.renderDrawdowns({state:'pending',start:null,asOf:null});
  assert.match(out,/回撤统计期间待核实/);
  assert.equal((out.match(/未核实<\/b>/g)||[]).length,3);
  assert.ok(!out.includes('0 个自然日'));assert.ok(!out.includes('同期'));
});

periodDisplayTest('displayed day counts come from actual dates and rendering leaves calculation inputs intact',async()=>{
  const {sandbox,feeView,st,nodes,receipt,input}=await model();
  const original=JSON.stringify({feeView,input});
  sandbox.renderKPIs(feeView,{...st,spanDays:999},{due:receipt.balance.dueCents/100},{hold:false,holdReasons:[]});
  assert.match(nodes.kpis.innerHTML,/共 5 个自然日/);
  assert.ok(!nodes.kpis.innerHTML.includes('999 个自然日'));
  assert.equal(JSON.stringify({feeView,input}),original);
});

test('shared period display rollout is either absent or fully marked',()=>{
  if(hasPeriodDisplay){section('/* return-period-display:start */','/* return-period-display:end */');}
  else{
    assert.ok(!html.includes('function returnPeriodLabel('));
    assert.ok(!html.includes('/* return-period-display:end */'));
  }
});
/* return-period-display-contract:end */

/* drawdown-episode-contract:start */
const factorsFromLevels=(levels,anchor='2026-07-31')=>levels.slice(1).map((value,i)=>({
  d:new Date(Date.parse(anchor+'T00:00:00Z')+(i+1)*86400000).toISOString().slice(0,10),factor:value/levels[i]
}));

episodeTest('episode metadata preserves the original drawdown result and input factors exactly',async()=>{
  const {sandbox}=await model();let seed=123456;
  const random=()=>((seed=(1664525*seed+1013904223)>>>0)/2**32);
  for(let sample=0;sample<64;sample++){
    const factors=Array.from({length:48},(_,i)=>({d:new Date(Date.parse('2026-07-31T00:00:00Z')+(i+1)*86400000).toISOString().slice(0,10),factor:.7+random()*.7}));
    const before=JSON.stringify(factors),base=sandbox.maxDrawdownFromFactors(factors,'2026-07-31'),out=sandbox.drawdownEpisodeFromFactors(factors,'2026-07-31');
    for(const key of ['state','value','peakDate','troughDate'])assert.equal(out[key],base[key]);
    assert.equal(JSON.stringify(factors),before);
  }
});

episodeTest('decline duration is the calendar-date difference without inclusive-day addition',async()=>{
  const {sandbox}=await model();
  for(const [anchor,through,days] of [['2024-01-05','2024-01-20',15],['2024-04-03','2024-05-07',34],['2025-02-03','2025-02-19',16],['2024-02-28','2024-03-01',2],['2026-03-07','2026-03-09',2],['2026-12-31','2027-01-01',1]]){
    const factors=Array.from({length:days},(_,i)=>({d:new Date(Date.parse(anchor+'T00:00:00Z')+(i+1)*86400000).toISOString().slice(0,10),factor:.99}));
    const out=sandbox.drawdownEpisodeFromFactors(factors,anchor);
    assert.equal(out.peakDate,anchor);assert.equal(out.troughDate,through);assert.equal(out.declineDays,days);
    assert.equal(out.recoveryState,'unrecovered');assert.equal(out.recoveryDate,null);
  }
});

episodeTest('first regained daily-close peak records recovery date and days from the selected trough',async()=>{
  const {sandbox}=await model(),out=sandbox.drawdownEpisodeFromFactors(factorsFromLevels([100,120,60,100,120,110,121]),'2026-07-31');
  near(out.value,.5);assert.equal(out.peakDate,'2026-08-01');assert.equal(out.troughDate,'2026-08-02');
  assert.equal(out.declineDays,1);assert.equal(out.recoveryDate,'2026-08-04');assert.equal(out.recoveryDays,2);assert.equal(out.recoveryState,'recovered');
});

episodeTest('recovery of an earlier smaller decline cannot recover the later selected maximum drawdown',async()=>{
  const {sandbox}=await model(),out=sandbox.drawdownEpisodeFromFactors(factorsFromLevels([100,110,99,110,120,60,100]),'2026-07-31');
  near(out.value,.5);assert.equal(out.peakDate,'2026-08-04');assert.equal(out.troughDate,'2026-08-05');
  assert.equal(out.recoveryState,'unrecovered');assert.equal(out.recoveryDate,null);assert.equal(out.recoveryDays,null);
});

episodeTest('equal highs and tied maximum drawdowns retain the existing first-selected episode',async()=>{
  const {sandbox}=await model(),out=sandbox.drawdownEpisodeFromFactors(factorsFromLevels([100,100,80,100,80]),'2026-07-31');
  near(out.value,.2);assert.equal(out.peakDate,'2026-07-31');assert.equal(out.troughDate,'2026-08-02');
  assert.equal(out.declineDays,2);assert.equal(out.recoveryDate,'2026-08-03');assert.equal(out.recoveryDays,1);
});

episodeTest('recovery handles floating-point equality without treating a material remaining loss as recovered',async()=>{
  const {sandbox}=await model();
  const almost=sandbox.drawdownEpisodeFromFactors(factorsFromLevels([1,1.25,1,1.25*(1-1e-14)]),'2026-07-31');
  const below=sandbox.drawdownEpisodeFromFactors(factorsFromLevels([1,1.25,1,1.25*(1-1e-8)]),'2026-07-31');
  assert.equal(almost.recoveryState,'recovered');assert.equal(almost.recoveryDate,'2026-08-03');
  assert.equal(below.recoveryState,'unrecovered');assert.equal(below.recoveryDate,null);
});

episodeTest('zero and unverified curves do not invent episode dates, zero durations or recovery',async()=>{
  const {sandbox}=await model();
  const zero=sandbox.drawdownEpisodeFromFactors(factorsFromLevels([100,100,110]),'2026-07-31');
  assert.equal(zero.value,0);assert.equal(zero.declineDays,null);assert.equal(zero.recoveryState,'not-applicable');assert.equal(zero.recoveryDate,null);
  for(const factors of [[],[{d:'2026-08-01',factor:-1}],[{d:'2026-08-01',factor:NaN}],[{d:'2026-08-01',factor:Infinity}]]){
    const out=sandbox.drawdownEpisodeFromFactors(factors,'2026-07-31');
    assert.equal(out.state,'pending');assert.equal(out.declineDays,null);assert.equal(out.recoveryDate,null);assert.equal(out.recoveryState,'pending');
  }
});

episodeTest('the initial anchor and a total loss retain a real one-day decline with no fabricated recovery',async()=>{
  const {sandbox}=await model(),out=sandbox.drawdownEpisodeFromFactors([{d:'2026-08-01',factor:0}],'2026-07-31');
  assert.equal(out.value,1);assert.equal(out.peakDate,'2026-07-31');assert.equal(out.troughDate,'2026-08-01');
  assert.equal(out.declineDays,1);assert.equal(out.recoveryState,'unrecovered');assert.equal(out.recoveryDate,null);
});

episodeTest('portfolio and benchmarks derive their distinct episode and recovery dates from the existing flow-neutral curves',async()=>{
  const {sandbox,feeView}=await model(),out=sandbox.drawdownView(feeView);
  assert.deepEqual(plain([out.actual.declineDays,out.actual.recoveryDate,out.actual.recoveryDays]),[3,'2026-08-05',1]);
  assert.deepEqual(plain([out.spy.declineDays,out.spy.recoveryDate,out.spy.recoveryDays]),[4,'2026-08-05',1]);
  assert.deepEqual(plain([out.qqq.declineDays,out.qqq.recoveryDate,out.qqq.recoveryDays]),[1,'2026-08-04',2]);
});

episodeTest('a large external contribution cannot masquerade as recovery of the portfolio unit curve',async()=>{
  const input=fixture();input.data.daily[5].webull=700;
  const {sandbox,feeView}=await model(input),out=sandbox.drawdownView(feeView);
  assert.ok(input.data.daily[2].webull>input.data.daily[1].webull);
  near(out.actual.value,1-.8/1.2);assert.equal(out.actual.recoveryState,'unrecovered');assert.equal(out.actual.recoveryDate,null);
  assert.match(sandbox.renderDrawdowns(feeView),/截至 2026-08-05 尚未恢复前高/);
});

episodeTest('each row visibly displays its own decline interval and separate recovery instead of relying on title hover',async()=>{
  const {sandbox,feeView}=await model(),out=sandbox.renderDrawdowns(feeView),text=out.replace(/<[^>]+>/g,' ');
  for(const line of ['高点 2026-08-01 → 低点 2026-08-04 · 下跌 3 个自然日','高点 2026-07-31 → 低点 2026-08-04 · 下跌 4 个自然日','高点 2026-08-01 → 低点 2026-08-02 · 下跌 1 个自然日'])assert.ok(text.includes(line));
  assert.equal((text.match(/该次回撤恢复前高/g)||[]).length,3);
  assert.ok(text.includes('低点后 2 个自然日'));assert.equal((out.match(/data-drawdown-series=/g)||[]).length,3);
  assert.match(text,/下跌历时为高点至低点的日期差；恢复历时从低点起算/);
});

episodeTest('recovery is clipped to verified common coverage and never claims the later report date',async()=>{
  const input=fixture(),dates=['2026-09-14','2026-09-15','2026-09-16','2026-09-17'];
  input.economicInput.settings.start=dates[1];input.economicInput.months=[];input.economicInput.fees=[];input.data.daily=input.data.daily.slice(0,4);
  input.data.daily.forEach((p,i)=>Object.assign(p,{d:dates[i],bd:dates[i],bstate:'session',webull:[100,120,110,200][i],spy:[100,100,90,200][i],qqq:[100,110,100,200][i]}));
  delete input.data.daily[3].qqq;input.data.status.asOf=dates[3];
  const {sandbox,feeView}=await model(input),out=sandbox.drawdownView(feeView),text=sandbox.renderDrawdowns(feeView).replace(/<[^>]+>/g,' ');
  assert.equal(out.through,dates[2]);
  for(const key of ['actual','spy','qqq']){assert.equal(out[key].recoveryDate,null);assert.equal(out[key].recoveryState,'unrecovered');}
  assert.equal((text.match(/截至 2026-09-16 尚未恢复前高/g)||[]).length,3);
  assert.ok(!text.includes('截至 2026-09-17 尚未恢复前高'));
});

episodeTest('missing source coverage keeps all episode and recovery details unverified',async()=>{
  const {sandbox,feeView,input}=await model();input.data.daily.splice(2,1);
  const view=sandbox.drawdownView(feeView),text=sandbox.renderDrawdowns(feeView).replace(/<[^>]+>/g,' ');
  for(const key of ['actual','spy','qqq']){assert.equal(view[key].state,'pending');assert.equal(view[key].declineDays,null);assert.equal(view[key].recoveryState,'pending');}
  assert.equal((text.match(/回撤期间未核实/g)||[]).length,3);assert.equal((text.match(/恢复情况未核实/g)||[]).length,3);
  assert.ok(!text.includes('下跌 0'));assert.ok(!text.includes('尚未恢复前高'));
});

episodeTest('flat unit curves render no episode and no misleading zero-day recovery',async()=>{
  const input=fixture(),values=[100,100,1000,1000,700,700];
  input.data.daily.forEach((p,i)=>Object.assign(p,{webull:values[i],spy:100,qqq:100}));
  const {sandbox,feeView}=await model(input),text=sandbox.renderDrawdowns(feeView).replace(/<[^>]+>/g,' ');
  assert.equal((text.match(/无回撤，无对应下跌区间/g)||[]).length,3);
  assert.ok(!text.includes('低点后 0'));assert.ok(!text.includes('尚未恢复前高'));
});

test('drawdown episode rollout is either absent or fully marked',()=>{
  if(hasDrawdownEpisode){section('/* drawdown-episode-metadata:start */','/* drawdown-episode-metadata:end */');assert.ok(html.includes('function drawdownEpisodeFromFactors('));}
  else{assert.ok(!html.includes('function drawdownEpisodeFromFactors('));assert.ok(!html.includes('/* drawdown-episode-metadata:end */'));assert.ok(!html.includes('value.declineDays'));}
});
/* drawdown-episode-contract:end */
}
/* maximum-drawdown-contract:end */
