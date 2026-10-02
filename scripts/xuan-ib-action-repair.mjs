// A same-source correction of an already published report, never a new IB read.
import {validateAssociationReceiptShape,validateAssociationReceipt} from './xuan-ib-account-association.mjs';
const fail=()=>{throw Error('ACTION_REPAIR_INVALID');};
const exact=(v,k)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join('|')===k.sort().join('|');
const sha=v=>typeof v==='string'&&/^[a-f0-9]{40}$/.test(v),hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
export function validateActionRepairMetadata(r){
 if(!exact(r,['schemaVersion','previousSourceSha','previousHtmlBlob','ibEvidenceSha256','ibStartedAt','ibCompletedAt','sourceDate','sharesightStartedAt','sharesightCompletedAt','sources','reserveHash','association'])||r.schemaVersion!==1||!sha(r.previousSourceSha)||!sha(r.previousHtmlBlob)||!hash(r.ibEvidenceSha256)||!hash(r.reserveHash)||!/^\d{4}-\d{2}-\d{2}$/.test(r.sourceDate))fail();
 for(const k of ['ibStartedAt','ibCompletedAt','sharesightStartedAt','sharesightCompletedAt'])if(!Number.isFinite(Date.parse(r[k])))fail();
 if(Date.parse(r.ibCompletedAt)<Date.parse(r.ibStartedAt)||Date.parse(r.sharesightCompletedAt)<Date.parse(r.sharesightStartedAt)||Date.parse(r.sharesightStartedAt)<Date.parse(r.ibCompletedAt))fail();
 const keys=['ib.accountSummary','ib.positions','ib.orders','ib.balances','ib.trades','sharesight.ibGroupedPerformance','sharesight.noahPerformance'];
 if(!Array.isArray(r.sources)||r.sources.length!==7||keys.some(k=>r.sources.filter(s=>exact(s,['sourceKey','sha256'])&&s.sourceKey===k&&hash(s.sha256)).length!==1))fail();
 validateAssociationReceiptShape(r.association);return r;
}
export function validateActionRepairBinding(model,previousModel,{previousSourceSha,previousHtmlBlob,snapshot,now=Date.now()}={}){
 const r=validateActionRepairMetadata(model.actionRepair);if(previousModel?.schemaVersion!==8||r.previousSourceSha!==previousSourceSha||r.previousHtmlBlob!==previousHtmlBlob||r.ibEvidenceSha256!==previousModel.evidenceSha256||r.ibStartedAt!==previousModel.captureStartedAt||r.ibCompletedAt!==previousModel.captureCompletedAt||r.sourceDate!==previousModel.sourceDate||model.dataDate!==previousModel.dataDate||!model.asOfHkt.includes(previousModel.asOfHkt)||!model.asOfHkt.includes('盘中修订'))fail();
 const ssStart=Date.parse(r.sharesightStartedAt),ssEnd=Date.parse(r.sharesightCompletedAt);if(ssEnd>now||now-ssStart>1800000||ssEnd-ssStart>300000)fail();
 if(!snapshot)fail();validateAssociationReceipt(r.association,snapshot,{now,edition:'am',previousSourceSha,runId:r.association.runId});
 const cash=previousModel.balances.reduce((n,b)=>n+b.cashBalance*b.exchangeRate,0);if(previousModel.cashCrossCheck!=='base-cash-cross-checked'||model.cash.status!=='ready'||Math.abs(model.cash.ib-cash)>Math.max(0.055,Math.abs(cash)*1e-6+0.005))fail();
 const old=previousModel.orders.map(o=>[o.description,o.side,String(o.quantity),Number(o.limit),o.currency,o.status].join('|')).sort(),next=[...model.orders.buys,...model.orders.sells].map(o=>[o.description,o.side,String(Number(o.quantity)),Number(o.limit),o.currency,o.status].join('|')).sort();if(JSON.stringify(old)!==JSON.stringify(next))fail();
 return r;
}
