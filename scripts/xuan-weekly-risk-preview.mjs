// All values and identities below are synthetic; never a real portfolio report.
import fs from 'node:fs';
import {build} from './xuan-weekly-build.mjs';
export function syntheticWeeklyFixture(){
  const date='2026-08-03', stamp='2026-08-04T01:00:00Z';
  const sharesight=[936247,936249,1350094].map(id=>({status:'ok',startedAt:stamp,completedAt:stamp,raw:{result:{mode:'read_only',
    portfolio:{id,currency_code:'USD'},data:{report:{portfolio_id:id,value:100,start_date:date,end_date:date,
      percentages_annualised:false,include_sales:false,currency:{code:'USD'},cash_accounts:[],holdings:[{
        id:id+10,portfolio:{id},instrument:{id:1879420,code:'AVGO',market_code:'TEST',name:'Synthetic',currency_code:'USD',
          friendly_instrument_description_code:'ordinary_shares'},instrument_currency:{code:'USD'},valid_position:true,
        quantity:1,value:100,instrument_price:100,labels:[],group_name:'Ordinary Shares',number_of_unconfirmed_transactions:0}]},
        links:{self:'https://example.invalid/performance?consolidated=false&include_sales=false&report_combined=false'}}}}}));
  for(const receipt of sharesight){const report=receipt.raw.result.data.report,id=report.portfolio_id,known=report.holdings[0];known.value=40;known.instrument_price=40;report.holdings.push({...structuredClone(known),id:id+20,instrument:{...known.instrument,id:999999,code:'SYNTHETIC_UNKNOWN',name:'Synthetic unknown'},value:40});report.cash_accounts=[{id,portfolio:{id},name:'Synthetic cash',value:20,currency:{code:'USD'}}];}
  const quotes={};for(const d of ['2026-07-31','2026-08-01','2026-08-02',date])quotes[d]=Object.fromEntries(['CSPX','EXUS','EIMI','USSC'].map(s=>[s,d===date||d==='2026-07-31'?{status:'close',date:d,usd:100,source:'synthetic'}:{status:'closed'}]));
  return {riskCutoff:date,sharesight,abc:{cutoff:date,quotes,nav:[{date:'2026-07-31',usd:100},{date,usd:100}],flows:[],
    coverage:{source:'ib-flex',currency:'USD',from:'2026-07-31',to:date,verified:true,sha256:'a'.repeat(64),closedDates:['2026-08-01','2026-08-02'],unresolvedDates:[]}}};
}

export function syntheticRiskPreview(){const result=build(syntheticWeeklyFixture());result.html=result.html.replace(/<section id="abc">[\s\S]*?<\/section>/,'').replace(/<nav>[\s\S]*?<\/nav>/,'').replace(/\$[\d,.]+/g,'合成金额省略').replace('<h1>XUAN · 周末记录</h1>','<h1>合成演示 · 风险首页</h1><p>全部数字为合成数据，不代表当前组合。</p>');return result;}
if(process.argv[1]?.endsWith('xuan-weekly-risk-preview.mjs')){const result=syntheticRiskPreview();if(!process.argv[2])throw Error('synthetic_preview_output_required');fs.writeFileSync(process.argv[2],result.html);}
