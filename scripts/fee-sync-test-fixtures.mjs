// Shared synthetic HTTP fixtures for offline capture/coordinator integration tests.
// Nothing here reads real credentials, account data or a network.
import assert from 'node:assert/strict';
import {SharesightCloudReader,CLOUD_ACCOUNTS} from './fee-cloud-source.mjs';
import {SharesightIbManagerReader,ibBaselineBusinessHash} from './ib-manager-source.mjs';
import {buildIbManagerReturnReceipt,buildIbManagerDrawdownReceipt,buildIbOwnerBaseline} from './ib-manager-return.mjs';
// Real reader/normalizer instances, synthetic in-memory HTTP responses only.
const D='2026-09-02',B={spy:100,qqq:100};
const instrument={id:8,code:'SYNTH',market_code:'NYSE',currency_code:'USD'};
function response(url,body){const r=new Response(body,{headers:{'content-type':'application/json'}});Object.defineProperty(r,'url',{value:url});return r;}
function cloudFixture({extraListing=false,quantity='1.0000000000000001',catalogNote='synthetic catalog'}={}){
  const calls=[],bodies=new Map(),token='synthetic-capture-token-123456';let reader,extra=false;
  const fetchImpl=async(url,init)=>{
    calls.push({url,method:init.method});const u=new URL(url),p=u.pathname,q=u.searchParams;let data;
    if(p==='/oauth2/token')data={access_token:token,token_type:'bearer'};
    else{
      assert.equal(init.method,'GET');assert.equal(init.redirect,'error');
      if(p==='/api/v2/portfolios.json')data={portfolios:Object.values(CLOUD_ACCOUNTS).map(x=>({id:x.portfolioId,name:x.name,currency_code:'USD'}))};
      else{
        const role=p.includes('936249')||p.includes('/3/')?'schwab':'webull',x=CLOUD_ACCOUNTS[role],cashId=role==='schwab'?3:4,holdingId=role==='schwab'?5:6;
        const portfolio={id:x.portfolioId,name:x.name},holding={id:holdingId,portfolio,valid_position:true,instrument,instrument_currency:{code:'USD'},quantity:1,value:100};
        if(p.endsWith('/performance'))data={report:{portfolio_id:x.portfolioId,start_date:q.get('start_date'),end_date:q.get('end_date'),include_sales:false,currency:{code:'USD'},portfolio_tz_name:'America/New_York',value:150,holdings:[holding],cash_accounts:[{id:cashId,portfolio,currency:{code:'USD'},value:50}]}};
        else if(p.endsWith('/holdings'))data={holdings:[{...holding,annotation:catalogNote}]};
        else if(p.endsWith('/cash_accounts.json'))data={cash_accounts:[{id:cashId,portfolio_id:x.portfolioId,portfolio_currency:'USD',currency:'USD',date:q.get('date'),balance:50,balance_in_portfolio_currency:50}]};
        else if(p.endsWith('/trades.json'))data={trades:[]};
        else if(p.endsWith('/cash_account_transactions.json'))data={cash_account_transactions:[]};
        else assert.fail('unexpected synthetic route');
      }
    }
    const body=JSON.stringify(data).replace(/"quantity":1/g,'"quantity":'+quantity);bodies.set(url,body);return response(url,body);
  };
  const onSourceResponse=extraListing?async bytes=>{
    if(!extra&&JSON.parse(bytes).portfolios){extra=true;try{await reader.get('https://api.sharesight.com/api/v2/portfolios.json',token);}finally{extra=false;}}
  }:null;
  reader=new SharesightCloudReader({clientId:'synthetic-client',clientSecret:'synthetic-secret',fetchImpl,sourceMode:'sharesight-reference',onSourceResponse});
  return {reader,calls,bodies,scope:role=>({role,...CLOUD_ACCOUNTS[role],targetDate:D,fromDate:D})};
}
function ibFixture({nativePayout=false}={}){
  const calls=[],baseline={from:'2026-09-01',asOf:D},business={points:[{d:'2026-09-01',tot:150},{d:D,tot:nativePayout?157:150}],openT:150,from:'2026-09-01',to:D,days:2,flowByDate:{},rate:0,cr:0,cumBefore:0,hwmBefore:0};
  const args={targetDate:D,baseline,expectedBaselineHash:ibBaselineBusinessHash(business)},scope={role:'ib-manager',name:'IB-HK',portfolioId:1,targetDate:D,fromDate:baseline.from};
  const fetchImpl=async(url,init)=>{
    calls.push({url,method:init.method});const p=new URL(url).pathname,q=new URL(url).searchParams;let data;
    const portfolio={id:1,name:'IB-HK'},holding={id:2,portfolio,valid_position:true,instrument,instrument_currency:{code:'USD'},quantity:1,value:100};
    if(p==='/oauth2/token')data={access_token:'synthetic-capture-token-123456',token_type:'bearer'};
    else{
      assert.equal(init.method,'GET');assert.equal(init.redirect,'error');
      if(p==='/api/v2/portfolios.json')data={portfolios:[{id:1,name:'IB-HK',currency_code:'USD'}]};
      else if(p.endsWith('/holdings'))data={holdings:[holding]};
      else if(p.endsWith('/performance')){const cash=nativePayout&&q.get('end_date')===D?57:50;data={report:{portfolio_id:1,start_date:q.get('start_date'),end_date:q.get('end_date'),include_sales:false,currency:{code:'USD'},portfolio_tz_name:'America/New_York',value:100+cash,holdings:[holding],cash_accounts:[{id:3,portfolio,currency:{code:'USD'},value:cash}]}};}
      else if(p.endsWith('/cash_accounts.json')){const cash=nativePayout&&q.get('date')===D?57:50;data={cash_accounts:[{id:3,portfolio_id:1,portfolio_currency:'USD',currency:'USD',date:q.get('date'),balance:cash,balance_in_portfolio_currency:cash}]};}
      else if(p.endsWith('/trades.json'))data={trades:[]};
      else if(p.endsWith('/cash_account_transactions.json'))data={cash_account_transactions:nativePayout?[{id:12,cash_account_id:3,date_time:D+'T00:00:00.000Z',amount:7,balance:57,cash_account_transaction_type:{name:'PAYOUT'},trade_id:null,holding_id:2,payout_id:13}]:[]};
      else if(p==='/api/v2/payouts/13.json')data={id:13,portfolio_id:1,holding_id:2,currency:'USD',paid_on:D,confirmed:true,state:'confirmed',non_taxable:false,gross_amount:10,resident_withholding_tax:3,amount:7,tax_credit:0};
      else assert.fail('unexpected synthetic IB route');
    }
    return response(url,JSON.stringify(data));
  };
  return {reader:new SharesightIbManagerReader({clientId:'synthetic-client',clientSecret:'synthetic-secret',fetchImpl}),calls,args,scope};
}

export async function seededIbFixture(options){
  const f=ibFixture(options),baseline={from:'2026-09-01',asOf:'2026-09-01'};
  const business={points:[{d:baseline.from,tot:150}],openT:150,from:baseline.from,to:baseline.asOf,days:1,flowByDate:{},rate:0,cr:0,cumBefore:0,hwmBefore:0};
  const frozen={schema:'fee-console.ib-manager-return-input.v1',currency:'USD',timezone:'America/New_York',flowTiming:'eod',flowsComplete:true,correctionsConfirmed:true,sourceSha256:'e'.repeat(64),periodReturnsInput:business};
  const expectedBaselineHash=ibBaselineBusinessHash(business),payload={ibManagerReturnReceipt:await buildIbManagerReturnReceipt(frozen),ibManagerDrawdownReceipt:await buildIbManagerDrawdownReceipt(frozen)};
  const ownerBaseline=await buildIbOwnerBaseline(payload,frozen,expectedBaselineHash);payload.ibManagerBaselineState=ownerBaseline;
  return {...f,args:{targetDate:D,baseline,expectedBaselineHash,ownerBaseline},scope:{...f.scope,fromDate:D},payload,environ:{IB_MANAGER_READ_ENABLED:'true',IB_MANAGER_BASELINE_SHA256:expectedBaselineHash}};
}
export {D,B,cloudFixture,ibFixture};
