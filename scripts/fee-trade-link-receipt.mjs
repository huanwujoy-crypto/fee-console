// Private per-trade provenance, not a whole-day broker COMPLETE receipt.
import {canonicalTradeId} from './fee-runtime-evidence.mjs';
import crypto from 'node:crypto';import {isControlledWebullNetProceeds} from './fee-cloud-source.mjs';
const hash=x=>crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
const money=x=>{const n=typeof x==='number'?x:typeof x==='string'&&/^\d+(?:\.\d+)?$/.test(x)?Number(x):NaN;return Number.isFinite(n)&&n>=0&&Number.isSafeInteger(Math.round(n*100))&&Math.abs(n*100-Math.round(n*100))<1e-4?Math.round(n*100):null;};
export function verifyWebullTradeLink({targetDate,business,cashRecord,trades,sourceEvidenceHash,approvalHash}={}){
 const fail=()=>{throw Error('FEE_TRADE_LINK_MISMATCH');};
 if(!business||business.source!=='WEBULL_OFFICIAL_READ'||business.status!=='FILLED'||business.side!=='SELL'||business.business_date!==targetDate||![sourceEvidenceHash,approvalHash].every(h=>/^[a-f0-9]{64}$/.test(h||'')))fail();
 if(!isControlledWebullNetProceeds({account:'webull',row:cashRecord,movement:cashRecord?.amount,targetDate,trades}))fail();
 const tradeId=/Sharesight trade ([1-9]\d*);/.exec(cashRecord.description)[1],trade=trades.find(t=>canonicalTradeId(t.id)===tradeId);
 const order=/Order ([A-Z0-9]+);/.exec(cashRecord.description)[1];
 const feeParts=['commission','sec','other'].map(k=>money(business.fees?.[k]));
 if(feeParts.some(x=>x===null)||business.order_id!==order||business.symbol!==trade.instrument.code||Number(business.quantity)!==trade.quantity||Number(business.price)!==trade.price||money(business.cash_net)!==money(cashRecord.amount)||feeParts.reduce((a,b)=>a+b,0)!==money(trade.brokerage))fail();
 return {schema:'fee.trade-cash-fee-link.v1',broker:'webull',targetDate,state:'VERIFIED_SINGLE_TRADE',tradeId,cashRecordId:cashRecord.id,actualFeeStatus:'PROVEN',sourceEvidenceHash,approvalHash,businessHash:hash(business),destinationHash:hash({cashRecord,trade}),wholeDayComplete:false};
}
export function assertSameTradeLink(before,after){if(JSON.stringify(before)!==JSON.stringify(after)||before?.state!=='VERIFIED_SINGLE_TRADE')throw Error('FEE_TRADE_LINK_CHANGED');}
