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

// A pinned behavioural snapshot of `calculateDelegatedTier`, captured from the
// reader as it stood before the 2026-09-11 identity-integrity work. Adding the
// BE rule beside AAOI and VST, and adding an entirely separate AUTO policy for
// first-seen positions, must leave this function's inputs, outputs and error
// codes identical. In particular its fail-closed refusal for an instrument with
// no approved rule is unchanged: the automatic policy is a different module and
// is never reachable from here.
const BEFORE=Object.freeze([
  {label:'VST resolves to its approved tier',
    run:()=>calculateDelegatedTier(vst(),{approvalId:VST}),
    value:{approvalId:VST,tier:'T1',symbol:'VST',portfolioId:'1350094',holdingId:'29098649',
      instrumentId:'1753523',currency:'USD',valueDate:'2026-09-09',marketValueUsd:12500,
      low:7500,mid:10000,high:12500,
      notifyId:'classification:1350094:29098649:DELEG-20260910-VST-T1',notifyOnce:true}},
  {label:'AAOI resolves through the same generic reader',
    run:()=>calculateDelegatedTier(aaoi(),{approvalId:'WU-20260906-AAOI-T1'}),
    value:{approvalId:'WU-20260906-AAOI-T1',tier:'T1',symbol:'AAOI',portfolioId:'1350094',
      holdingId:'28656360',instrumentId:'523742',currency:'USD',valueDate:'2026-09-05',
      marketValueUsd:10553,low:6331.8,mid:8442.4,high:10553,
      notifyId:'classification:1350094:28656360:WU-20260906-AAOI-T1',notifyOnce:true}},
  // The fail-closed cases, byte for byte. An unknown instrument has no rule and
  // never acquires one here, however the rest of the repository changes.
  {label:'an unapproved instrument is refused',
    run:()=>calculateDelegatedTier(vst(),{approvalId:'WU-20260910-NVDA-T1'}),code:'RULE_NOT_APPROVED'},
  {label:'a brand new position with no rule at all is refused',
    run:()=>calculateDelegatedTier({symbol:'NEWCO',portfolioId:'1350094',holdingId:'99000001',
      instrumentId:'99000002',currency:'USD',marketValueUsd:1000,valueDate:'2026-09-10'},
    {approvalId:'DELEG-20260911-NEWCO-T1'}),code:'RULE_NOT_APPROVED'},
  {label:'a near identity match is refused',
    run:()=>calculateDelegatedTier({...vst(),venue:'NASDAQ'},{approvalId:VST}),code:'IDENTITY_MISMATCH'},
  {label:'an unverified value is refused',
    run:()=>calculateDelegatedTier({...vst(),marketValueUsd:null},{approvalId:VST}),
    code:'VALUE_NOT_VERIFIED_USD_CENTS'},
  {label:'a malformed input is refused',
    run:()=>calculateDelegatedTier(null,{approvalId:VST}),code:'INPUT_MALFORMED'},
]);

test('calculateDelegatedTier behaves identically before and after the identity-integrity change',()=>{
  for(const item of BEFORE){
    if(item.value){
      const actual=item.run();
      assert.deepEqual(actual,item.value,item.label);
      // Key order is part of the published shape, not an accident.
      assert.deepEqual(Object.keys(actual),Object.keys(item.value),item.label);
      continue;
    }
    assert.throws(item.run,error=>{
      assert.ok(error instanceof DelegatedTierException,item.label);
      assert.equal(error.code,item.code,item.label);
      assert.equal(error.owner,'Codex',item.label);
      assert.equal(error.requiresOwnerDecision,false,item.label);
      return true;
    },item.label);
  }
  // The reader gained no new entry point and no automatic path.
  assert.deepEqual(Object.keys(SUPPORTED_TIERS),['T1']);
});

test('the BE rule is a DELEG record with complete identity and no new coefficient',()=>{
  const BE='DELEG-20260911-BE-T1';
  const {rule}=findDelegatedRule(BE);
  assert.deepEqual([rule.low,rule.mid,rule.high],[0.6,0.8,1]);
  assert.equal(rule.tier,'T1');
  // Every identity field the approval records must be matched exactly.
  const be=()=>({symbol:'BE',custodian:'Webull',venue:'NYSE',
    instrumentName:'Bloom Energy Corp - Ordinary Shares - Class A',
    portfolioId:'1350094',holdingId:'29037698',instrumentId:'1893267',currency:'USD',
    marketValueUsd:5000,valueDate:'2026-09-10'});
  const value=calculateDelegatedTier(be(),{approvalId:BE});
  assert.deepEqual([value.low,value.mid,value.high],[3000,4000,5000]);
  assert.equal(value.notifyId,'classification:1350094:29037698:DELEG-20260911-BE-T1');
  // One stable identity per rule, across a moved value and date.
  assert.equal(value.notifyId,
    calculateDelegatedTier({...be(),marketValueUsd:5100,valueDate:'2026-09-11'},{approvalId:BE}).notifyId);
  for(const [key,other] of [['custodian','IB-HK'],['venue','NASDAQ'],['instrumentName','Bloom Energy Corp'],
    ['portfolioId','936247'],['holdingId','29098649'],['instrumentId','1753523']]){
    assert.throws(()=>calculateDelegatedTier({...be(),[key]:other},{approvalId:BE}),/IDENTITY_MISMATCH/);
  }
  // It does not satisfy, and is not satisfied by, another instrument's rule.
  assert.throws(()=>calculateDelegatedTier(be(),{approvalId:VST}),/IDENTITY_MISMATCH/);
  assert.throws(()=>calculateDelegatedTier(vst(),{approvalId:BE}),/IDENTITY_MISMATCH/);
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
