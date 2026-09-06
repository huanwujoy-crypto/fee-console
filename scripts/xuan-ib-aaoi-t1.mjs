// Owner-approved measurement only. Never reads or writes a financial account.
import fs from 'node:fs';
const path=new URL('../claude/xuan-ib-classification-delegation-v1.json',import.meta.url);
export function calculateAaoiT1(input) {
  const policy=JSON.parse(fs.readFileSync(path,'utf8'));
  const rule=policy.overrides.find(r=>r.approvalId==='WU-20260906-AAOI-T1');
  if(!rule||policy.financialWrites!==false||policy.coefficientChanges!==false||
    rule.tier!=='T1'||rule.low!==0.6||rule.mid!==0.8||rule.high!==1)throw Error('AAOI approved policy mismatch');
  for(const key of ['symbol','portfolioId','holdingId','instrumentId','currency'])
    if(input[key]!==rule[key])throw Error(`AAOI identity mismatch: ${key}`);
  if(typeof input.marketValueUsd!=='number'||!Number.isFinite(input.marketValueUsd)||input.marketValueUsd<0||
    !/^\d+(?:\.\d{1,2})?$/.test(String(input.marketValueUsd))||input.marketValueUsd>1e12)throw Error('AAOI value must be verified USD cents');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(input.valueDate)||!Number.isFinite(Date.parse(input.valueDate))||
    new Date(input.valueDate).toISOString().slice(0,10)!==input.valueDate)throw Error('AAOI value date required');
  const cents=BigInt(Math.round(input.marketValueUsd*100));
  return {approvalId:rule.approvalId,tier:rule.tier,valueDate:input.valueDate,
    marketValueUsd:input.marketValueUsd,low:Number(cents*6n)/1000,mid:Number(cents*8n)/1000,high:Number(cents)/100,
    notifyId:`classification:${rule.portfolioId}:${rule.holdingId}:${rule.approvalId}`};
}
