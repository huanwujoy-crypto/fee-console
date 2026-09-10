import test from 'node:test';
import assert from 'node:assert/strict';
import {calculateDelegatedTier, findDelegatedRule, listDelegatedRules,
  SUPPORTED_TIERS, DelegatedTierException} from './xuan-ib-delegated-tier.mjs';
import {calculateAaoiT1} from './xuan-ib-aaoi-t1.mjs';

const VST='DELEG-20260910-VST-T1';
// The exact instrument identity the owner approved. No market value here is a
// real holding: every amount below is synthetic.
const vst=()=>({symbol:'VST',custodian:'Webull',venue:'NYSE',instrumentName:'Vistra Corp',
  portfolioId:'1350094',holdingId:'29098649',instrumentId:'1753523',currency:'USD',
  marketValueUsd:12500,valueDate:'2026-09-09'});
const aaoi=()=>({symbol:'AAOI',portfolioId:'1350094',holdingId:'28656360',
  instrumentId:'523742',currency:'USD',marketValueUsd:10553,valueDate:'2026-09-05'});

test('VST is recorded as standard T1 and calculated from exact cents',()=>{
  const value=calculateDelegatedTier(vst(),{approvalId:VST});
  assert.equal(value.tier,'T1');
  assert.deepEqual([value.low,value.mid,value.high],[7500,10000,12500]);
  assert.equal(value.instrumentId,'1753523');
  assert.equal(value.valueDate,'2026-09-09');
  // The coefficients come from the approved whitelist, never from the caller.
  const {rule}=findDelegatedRule(VST);
  assert.deepEqual([rule.low,rule.mid,rule.high],[0.6,0.8,1]);
  // Cent arithmetic, not binary floating point: 0.6 * 10553 drifts, 6n does not.
  assert.equal(calculateDelegatedTier({...vst(),marketValueUsd:10553},{approvalId:VST}).low,6331.8);
});

test('one stable notification identity per rule, never one per run',()=>{
  const first=calculateDelegatedTier(vst(),{approvalId:VST});
  const later=calculateDelegatedTier({...vst(),marketValueUsd:13000,valueDate:'2026-09-10'},{approvalId:VST});
  // A new dated value under the same established tier is not a new
  // classification, so it must not produce a second notification identity.
  assert.equal(first.notifyId,later.notifyId);
  assert.equal(first.notifyId,'classification:1350094:29098649:DELEG-20260910-VST-T1');
  assert.equal(first.notifyOnce,true);
  // A different rule is a distinct event and keeps its own identity.
  assert.notEqual(first.notifyId,calculateAaoiT1(aaoi()).notifyId);
});

test('identity is exact: a near match is refused, never assigned',()=>{
  for(const [key,value] of [['symbol','VSTA'],['custodian','IB-HK'],['venue','NASDAQ'],
    ['instrumentName','Vistra Energy'],['portfolioId','936247'],['holdingId','28656360'],
    ['instrumentId','523742'],['currency','HKD']]){
    assert.throws(()=>calculateDelegatedTier({...vst(),[key]:value},{approvalId:VST}),
      /IDENTITY_MISMATCH/,`${key} must not be treated as a near-enough match`);
  }
  // A rule that records more identity than the input supplies is not satisfied
  // by the weaker input; the extra evidence is part of what was approved.
  for(const key of ['custodian','venue','instrumentName']){
    const partial={...vst()};delete partial[key];
    assert.throws(()=>calculateDelegatedTier(partial,{approvalId:VST}),/IDENTITY_MISMATCH/);
  }
  // An unapproved instrument has no rule at all, and is not invented from one.
  assert.throws(()=>calculateDelegatedTier(vst(),{approvalId:'WU-20260910-NVDA-T1'}),/RULE_NOT_APPROVED/);
  for(const input of [null,'VST',[],undefined]) assert.throws(()=>calculateDelegatedTier(input,{approvalId:VST}),/INPUT_MALFORMED/);
});

test('a missing, unverified or over-precise value never becomes zero or an assignment',()=>{
  for(const value of [null,undefined,-1,1.001,Number.NaN,Infinity,'12500',1e13]){
    assert.throws(()=>calculateDelegatedTier({...vst(),marketValueUsd:value},{approvalId:VST}),
      /VALUE_NOT_VERIFIED_USD_CENTS/);
  }
  for(const date of [null,'2026-02-30','2026-9-9',20260909]){
    assert.throws(()=>calculateDelegatedTier({...vst(),valueDate:date},{approvalId:VST}),/VALUE_DATE_REQUIRED/);
  }
  // A genuinely zero position is still calculable; it is absence that is refused.
  const empty=calculateDelegatedTier({...vst(),marketValueUsd:0},{approvalId:VST});
  assert.deepEqual([empty.low,empty.mid,empty.high],[0,0,0]);
});

test('every failure is a Codex technical exception, never an owner decision',()=>{
  const failures=[()=>calculateDelegatedTier(vst(),{approvalId:'WU-20260910-NVDA-T1'}),
    ()=>calculateDelegatedTier({...vst(),venue:'NASDAQ'},{approvalId:VST}),
    ()=>calculateDelegatedTier({...vst(),marketValueUsd:null},{approvalId:VST}),
    ()=>calculateDelegatedTier({...vst(),valueDate:'2026-02-30'},{approvalId:VST}),
    ()=>calculateDelegatedTier(null,{approvalId:VST})];
  for(const run of failures){
    assert.throws(run,error=>{
      assert.ok(error instanceof DelegatedTierException);
      // Routine classification must never queue another awaiting_user item.
      assert.equal(error.owner,'Codex');
      assert.equal(error.requiresOwnerDecision,false);
      assert.equal(typeof error.code,'string');
      return true;
    });
  }
});

test('only whitelisted coefficients may be applied, and the file is validated whole',()=>{
  assert.deepEqual(Object.keys(SUPPORTED_TIERS),['T1']);
  assert.deepEqual([SUPPORTED_TIERS.T1.low,SUPPORTED_TIERS.T1.mid,SUPPORTED_TIERS.T1.high],[0.6,0.8,1]);
  const rules=listDelegatedRules();
  assert.ok(rules.length>=2);
  for(const {rule} of rules){
    // Adopting a coefficient is a decision the delegation withholds, so every
    // deployed rule must already match an approved triple exactly.
    const tier=SUPPORTED_TIERS[rule.tier];
    assert.ok(tier,`${rule.approvalId} names an unsupported tier`);
    assert.deepEqual([rule.low,rule.mid,rule.high],[tier.low,tier.mid,tier.high]);
    assert.ok(rule.approvalId.endsWith(`-${rule.tier}`));
  }
  // One holding cannot carry two approved tiers, and no approval repeats.
  const ids=rules.map(entry=>entry.rule.approvalId);
  const holdings=rules.map(entry=>`${entry.rule.portfolioId}:${entry.rule.holdingId}`);
  assert.equal(new Set(ids).size,ids.length);
  assert.equal(new Set(holdings).size,holdings.length);
});

test('the historical AAOI approval keeps its exact result through the generic reader',()=>{
  const value=calculateAaoiT1(aaoi());
  assert.deepEqual([value.low,value.mid,value.high],[6331.8,8442.4,10553]);
  assert.equal(value.notifyId,'classification:1350094:28656360:WU-20260906-AAOI-T1');
  assert.deepEqual(Object.keys(value),
    ['approvalId','tier','valueDate','marketValueUsd','low','mid','high','notifyId']);
  assert.equal(value.notifyId,calculateAaoiT1({...aaoi(),marketValueUsd:10600,valueDate:'2026-09-06'}).notifyId);
  // AAOI's approval records no venue or custodian, so it must not start
  // demanding them; a VST identity must not satisfy it either.
  assert.throws(()=>calculateAaoiT1(vst()),/IDENTITY_MISMATCH/);
});
