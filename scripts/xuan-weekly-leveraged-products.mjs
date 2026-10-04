// Explicit reviewed product and source holding identities; never infer from ticker/name.
import fs from 'node:fs';
export const LEVERAGED_POLICY=JSON.parse(fs.readFileSync(new URL('../claude/xuan-weekly-leveraged-products-v1.json',import.meta.url),'utf8'));
export function resolveLeveragedProduct(row,{cutoff,policy=LEVERAGED_POLICY}={}){
  if(policy.schema!=='weekly-leveraged-products.v1'||!/^\d{4}-\d{2}-\d{2}$/.test(policy.reviewedOn)||!/^\d{4}-\d{2}-\d{2}$/.test(policy.reviewBy)||policy.reviewedOn>policy.reviewBy||!Array.isArray(policy.products))throw Error('weekly_leverage_policy_invalid');
  const refs=new Set(); let match=null;
  for(const p of policy.products){
    if(!p.symbol||p.assetType!=='ETF'||!p.underlying||!/^\d+$/.test(p.underlyingInstrumentId)||p.basis!=='daily-target'||!Number.isSafeInteger(p.dailyMultiplierBp)||p.dailyMultiplierBp<10000||p.dailyMultiplierBp>50000||!/^https:\/\//.test(p.source)||!p.holdingRefs?.length)throw Error('weekly_leverage_policy_invalid');
    for(const ref of p.holdingRefs){
      if(!/^\d+:\d+$/.test(ref)||refs.has(ref))throw Error('weekly_leverage_identity_invalid');
      refs.add(ref);
      if(ref===String(row.portfolioId)+':'+String(row.holdingId)&&row.symbol===p.symbol&&row.assetType===p.assetType&&row.identityVerified===true&&cutoff<=policy.reviewBy)match=p;
    }
  }
  return match;
}
