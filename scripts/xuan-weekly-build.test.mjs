import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from './xuan-weekly-build.mjs';
import {ordinaryStockConcentrations,familyOrdinaryConcentrations} from './xuan-ib-single-stock-concentration.mjs';
import {DEFAULT_TOP10_POLICY,buildWeeklyConcentration,renderWeeklyConcentration} from './xuan-weekly-concentration.mjs';
function fixture(){
  const date='2026-08-03', stamp='2026-08-04T01:00:00Z';
  const sharesight=[936247,936249,1350094].map(id=>({status:'ok',startedAt:stamp,completedAt:stamp,raw:{result:{mode:'read_only',
    portfolio:{id,currency_code:'USD'},data:{report:{portfolio_id:id,value:100,start_date:date,end_date:date,
      percentages_annualised:false,include_sales:false,currency:{code:'USD'},cash_accounts:[],holdings:[{
        id:id+10,portfolio:{id},instrument:{id:id+10,code:'TESTSTK',market_code:'TEST',name:'Synthetic',currency_code:'USD',
          friendly_instrument_description_code:'ordinary_shares'},instrument_currency:{code:'USD'},valid_position:true,
        quantity:1,value:100,instrument_price:100,labels:[],group_name:'Ordinary Shares',number_of_unconfirmed_transactions:0}]},
        links:{self:'https://example.invalid/performance?consolidated=false&include_sales=false&report_combined=false'}}}}}));
  const quotes={};for(const d of ['2026-07-31','2026-08-01','2026-08-02',date])quotes[d]=Object.fromEntries(['CSPX','EXUS','EIMI','USSC'].map(s=>[s,d===date||d==='2026-07-31'?{status:'close',date:d,usd:100,source:'synthetic'}:{status:'closed'}]));
  return {riskCutoff:date,sharesight,abc:{cutoff:date,quotes,nav:[{date:'2026-07-31',usd:100},{date,usd:100}],flows:[],
    coverage:{source:'ib-flex',currency:'USD',from:'2026-07-31',to:date,verified:true,sha256:'a'.repeat(64),closedDates:['2026-08-01','2026-08-02'],unresolvedDates:[]}}};
}
test('complete weekly artifact has no overview or old method wording',()=>{
  const r=build(fixture());assert.equal(r.receipt.complete,true);assert.equal(r.receipt.abcRows,4);
  assert.match(r.html,/不扣待 CALL/);assert.match(r.html,/ABC · 同资金路径/);assert.doesNotMatch(r.html,/<h2>持仓|<h2>总览/);
  assert.match(r.html,/href="#concentration"/);assert.match(r.html,/id="concentration"/);
  assert.match(r.html,/含 BRK.B/);assert.match(r.html,/ETF 同名穿透／前十大股票/);assert.match(r.html,/计算过程与资料日期/);
  assert.match(r.html,/累计 TWR/);assert.match(r.html,/未实扣管理费/);
  assert.match(r.html,/资金记录 · IB 自动读取/);assert.match(r.html,/计算过程与逐日核算/);
  assert.match(r.html,/不再扣一次 15%/);assert.match(r.html,/现金入金/);
  assert.match(r.html,/AI 相关集中度/);assert.match(r.html,/AI 投资周期敏感/);assert.match(r.html,/综合平台与应用/);
  assert.match(r.html,/ETF 待穿透／待分类/);assert.match(r.html,/待确认/);assert.doesNotMatch(r.html,/中情景|压力金额排序|<h3>系数/);
  assert.equal(r.pressure,undefined);assert.equal(r.aiExposure.groups.find(g=>g.key==='pending').percent,100);
});
test('weekly concentration opt-in includes Berkshire variants and amount without changing daily defaults',()=>{
 const rows=['BRK-B','BRK.B','BRK/B'].map(symbol=>({symbol,status:'excluded',assetType:'STK',marketValueCents:'20000'}));
 assert.deepEqual(familyOrdinaryConcentrations(rows,'1000000'),[]);
 const out=ordinaryStockConcentrations(rows,'1000000',{aboveHundredths:100n,includeBerkshire:true});
 assert.equal(out.length,1);assert.equal(out[0].label,'BRK.B');assert.equal(out[0].marketValueCents,'60000');assert.equal(out[0].percent,6);
});
test('weekly issuer candidate union combines direct stocks with ETF matches beyond top ten before the 1% screen',()=>{
 const cutoff='2026-09-25';
 const holding=(holdingId,symbol,assetType,marketValueMicro,instrumentId=holdingId)=>({portfolioId:'1',holdingId:String(holdingId),instrumentId:String(instrumentId),symbol,custodian:'IB-HK',assetType,marketValueMicro:String(marketValueMicro),valueDate:cutoff,identityVerified:true});
 const envelope={riskDenominator:{components:[{key:'a',valueMicro:'34000000000'},{key:'b',valueMicro:'33000000000'},{key:'c',valueMicro:'33000000000'}]},
  riskConstituents:[holding(1,'GOOG','STK',400000000),holding(2,'GOOGL','STK',300000000),holding(3,'BRK-B','STK',1000000000),holding(4,'CSPX','ETF',20000000000,'1310832'),holding(5,'UNKNOWN','ETF',1000000000,'999999')]};
 const result=buildWeeklyConcentration(envelope,{cutoff});
 const alphabet=result.rows.find(r=>r.issuer==='ALPHABET');
 assert.equal(alphabet.directCents,'70000');assert.equal(alphabet.etfCents,'108600');
 assert.equal(alphabet.marketValueCents,'178600');assert.equal(alphabet.percent,1.79);
 assert.equal(alphabet.parts.filter(p=>p.kind==='etf').length,2);
 assert.equal(result.rows.find(r=>r.issuer==='NVDA').etfCents,'163200');
 const berkshire=result.rows.find(r=>r.issuer==='BERKSHIRE');
 assert.equal(berkshire.directCents,'100000');assert.equal(berkshire.etfCents,'28200');
 assert.equal(berkshire.marketValueCents,'128200');assert.equal(berkshire.percent,1.28);
 assert.equal(berkshire.parts.find(p=>p.kind==='etf').scope,'directMatch');
 assert.deepEqual(result.candidateSources,{direct:2,etfTopTen:9});
 assert.equal(result.candidateCount,10);
 assert.deepEqual(result.missingFunds.map(f=>f.symbol),['UNKNOWN']);
 assert.equal(result.listedMarketValueCents,result.rows.reduce((sum,r)=>sum+BigInt(r.marketValueCents),0n).toString());
 assert.ok(result.listedPercent>0);
 const html=renderWeeklyConcentration(result);
 assert.match(html,/已列 \d+ 个单票合计/);
 assert.match(html,/已列单票合计先汇总/);
 assert.match(html,/CSPX.*20,000.*3\.01%/);assert.match(html,/未计入：UNKNOWN/);
 assert.match(html,/可见下限/);assert.match(html,/发行方资料/);assert.match(html,/两组候选/);
 assert.match(html,/直接持股同名、非前十/);
});
test('weekly listed concentration total excludes issuers below 1% and uses the cash-inclusive denominator',()=>{
 const cutoff='2026-09-25';
 const envelope={riskDenominator:{components:[{key:'a',valueMicro:'3000000000'},{key:'b',valueMicro:'3000000000'},{key:'c',valueMicro:'4000000000'}]},
  riskConstituents:[['A',600000000],['B',500000000],['C',50000000]].map(([symbol,micro],i)=>({portfolioId:'1',instrumentId:String(i),symbol,custodian:'IB-HK',assetType:'STK',marketValueMicro:String(micro),valueDate:cutoff,identityVerified:true}))};
 const result=buildWeeklyConcentration(envelope,{cutoff});
 assert.equal(result.rows.length,2);
 assert.equal(result.listedMarketValueCents,'110000');
 assert.equal(result.listedPercent,11);
 assert.match(renderWeeklyConcentration(result),/已列 2 个单票合计[\s\S]*\$1,100[\s\S]*11\.00%/);
});
test('non-top-ten matches never create new ETF-only candidates or double count a top-ten issuer',()=>{
 const cutoff='2026-09-25';
 const envelope={riskDenominator:{components:[{key:'a',valueMicro:'1000000000'},{key:'b',valueMicro:'1000000000'},{key:'c',valueMicro:'1000000000'}]},
  riskConstituents:[{portfolioId:'1',holdingId:'1',instrumentId:'1310832',symbol:'CSPX',custodian:'IB-HK',assetType:'ETF',marketValueMicro:'1000000000',valueDate:cutoff,identityVerified:true}]};
 const result=buildWeeklyConcentration(envelope,{cutoff});
 assert.equal(result.candidateCount,9);
 assert.equal(result.rows.some(r=>r.issuer==='BERKSHIRE'),false);
 const policy=structuredClone(DEFAULT_TOP10_POLICY);
 policy.funds.find(f=>f.symbol==='CSPX').directIssuerMatches.push(['NVDA',1]);
 assert.throws(()=>buildWeeklyConcentration(envelope,{cutoff,policy}),/direct_match_invalid/);
});
test('outdated ETF top ten are not silently reused',()=>{
 const cutoff='2026-11-20';
 const envelope={riskDenominator:{components:[{key:'a',valueMicro:'1000000000'},{key:'b',valueMicro:'1000000000'},{key:'c',valueMicro:'1000000000'}]},
 riskConstituents:[{portfolioId:'1',holdingId:'1',instrumentId:'1310832',symbol:'CSPX',custodian:'IB-HK',assetType:'ETF',marketValueMicro:'1000000000',valueDate:cutoff,identityVerified:true}]};
 const result=buildWeeklyConcentration(envelope,{cutoff});
 assert.equal(result.rows.length,0);assert.equal(result.missingFunds[0].reason,'前十资料过期或身份不符');
});
test('previous private identity records survive subsequent run',()=>{
  const f=fixture(),first=build(f);f.previousRecords=first.records;
  assert.equal(build(f).receipt.previousManifest.status,'present');
});
test('different source cutoff cannot masquerade as current risk',()=>{
  const f=fixture();f.riskCutoff='2026-08-04';assert.throws(()=>build(f),/cutoff/);
});
