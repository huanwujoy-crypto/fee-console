import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {projectSharesightSyncAccount,syncProjectionFailureCode} from './fee-sync-source-projection.mjs';

// Synthetic source JSON only. No real portfolio data, credentials or IO.
const scope={role:'ib-manager',portfolioId:1,name:'IB-HK',fromDate:'2026-09-01',targetDate:'2026-09-02'};
const instrument={id:8,code:'SYNTH',market_code:'SYNTH',currency_code:'USD'};
function fixture(){
  const portfolio={id:1,name:'IB-HK'};
  const report={portfolio_id:1,start_date:scope.targetDate,end_date:scope.targetDate,currency:{code:'USD'},portfolio_tz_name:'America/New_York',include_sales:false,value:1307,
    holdings:[{id:2,portfolio,valid_position:true,instrument,instrument_currency:{code:'USD'},quantity:1,value:900}],
    cash_accounts:[{id:3,portfolio,currency:{code:'USD'},value:407}]};
  const cash_accounts=[{id:3,portfolio_id:1,portfolio_currency:'USD',date:scope.targetDate,currency:'USD',balance:407,balance_in_portfolio_currency:407}];
  const trades=[{id:4,portfolio_id:1,holding_id:2,transaction_date:'2026-09-01',description_code:'BUY',state:'confirmed',instrument,quantity:1,price:900,value:-900,brokerage:0}];
  const cash_account_transactions=[
    {id:14,cash_account_id:3,date_time:'2026-09-02T05:00:00.000Z',amount:300,balance:407,cash_account_transaction_type:{name:'DEPOSIT'},description:'Synthetic owner cash contribution'},
    {id:12,cash_account_id:3,date_time:'2026-09-01T23:30:00-04:00',amount:7,balance:107,cash_account_transaction_type:{name:'Payout'},trade_id:null,holding_id:2,payout_id:13}
  ];
  const payout={id:13,portfolio_id:1,holding_id:2,currency:'USD',paid_on:'2026-09-02',state:'confirmed',confirmed:true,gross_amount:10,resident_withholding_tax:3,amount:7,tax_credit:0};
  return {scope:{...scope},raw:{performance:JSON.stringify({report}),cashAccounts:JSON.stringify({cash_accounts}),trades:JSON.stringify({trades}),cashTransactions:{3:JSON.stringify({cash_account_transactions})},payouts:{13:JSON.stringify(payout)}}};
}
function change(f,key,mutate){const parts=key.split('.');let parent=f.raw;for(const p of parts.slice(0,-1))parent=parent[p];const k=parts.at(-1),v=JSON.parse(parent[k]);mutate(v);parent[k]=JSON.stringify(v);}
function refuse(f,code){assert.throws(()=>projectSharesightSyncAccount(f),e=>{assert.equal(syncProjectionFailureCode(e),'FEE_SYNC_PROJECTION_'+code);assert.equal(e.message,'FEE_SYNC_PROJECTION_'+code);return true;});}

test('preserves original event dates, exact decimals and stable source binding without approving business rules',()=>{
  const f=fixture();f.raw.performance=f.raw.performance.replace('"quantity":1','"quantity":1.0000000000000001');
  const before=JSON.stringify(f),r=projectSharesightSyncAccount(f);
  assert.equal(JSON.stringify(f),before);assert.equal(r.schema,'fee-console.sync-source-projection.v1');
  assert.equal(r.identity.provider,'Sharesight');assert.equal(r.holdings[0].quantity,'10000000000000001e-16');
  assert.equal(r.reportedValue,'1307e0');assert.equal(r.cash[0].nativeBalance,'407e0');
  assert.deepEqual(r.cashEvents.map(x=>x.id),[12,14]);
  assert.equal(r.cashEvents[0].dateTime,'2026-09-01T23:30:00-04:00');
  assert.equal(r.payouts[0].paidOn,'2026-09-02');assert.equal(r.trades[0].transactionDate,'2026-09-01');
  assert.ok(Object.isFrozen(r));assert.ok(Object.isFrozen(r.cashEvents[0]));
  assert.match(r.sourceSha256,/^[a-f0-9]{64}$/);
  assert.equal(r.publicationReady,undefined);assert.equal(r.accepted,undefined);assert.equal(r.synchronized,undefined);
  assert.deepEqual(projectSharesightSyncAccount(f),r);
  f.raw.performance+=' ';assert.notEqual(projectSharesightSyncAccount(f).sourceSha256,r.sourceSha256);
});
test('raw map order and all result arrays are deterministic; source bytes remain bound',()=>{
  const f=fixture();change(f,'performance',p=>p.report.holdings.unshift({...p.report.holdings[0],id:5}));
  const a=projectSharesightSyncAccount(f),g={raw:{payouts:f.raw.payouts,cashTransactions:f.raw.cashTransactions,trades:f.raw.trades,cashAccounts:f.raw.cashAccounts,performance:f.raw.performance},scope:{...f.scope}};
  assert.deepEqual(projectSharesightSyncAccount(g),a);assert.deepEqual(a.holdings.map(x=>x.id),[2,5]);
  assert.equal(a.sourceSha256.length,createHash('sha256').update('x').digest('hex').length);
});
test('optional linked payout evidence is not fabricated',()=>{
  const f=fixture();delete f.raw.payouts;const r=projectSharesightSyncAccount(f);
  assert.deepEqual(r.payouts,[]);assert.equal(r.cashEvents[0].payoutId,13);
});
test('linked official payout date outside cash query window is preserved for business validation',()=>{
  const f=fixture();change(f,'payouts.13',p=>p.paid_on='2026-08-31');
  const r=projectSharesightSyncAccount(f);
  assert.equal(r.payouts[0].paidOn,'2026-08-31');assert.equal(r.cashEvents[0].dateTime,'2026-09-01T23:30:00-04:00');
  assert.equal(r.identity.fromDate,'2026-09-01');assert.equal(r.publicationReady,undefined);
  change(f,'payouts.13',p=>p.paid_on='2026-08-32');refuse(f,'DATE');
});
test('retains unknown types and unequal dates or balances for original business validator',()=>{
  const f=fixture();change(f,'cashTransactions.3',p=>p.cash_account_transactions[0].cash_account_transaction_type.name='UNKNOWN_SOURCE_TYPE');
  change(f,'cashAccounts',p=>p.cash_accounts[0].balance=408);
  const r=projectSharesightSyncAccount(f);assert.equal(r.cashEvents[1].type,'UNKNOWN_SOURCE_TYPE');
  assert.equal(r.cash[0].nativeBalance,'408e0');assert.equal(r.cash[0].reportValue,'407e0');
});
test('retains legal cross-midnight source timestamps without guessing a business date',async t=>{
  const cases=[
    ['UTC date after target but New York still target','2026-09-03T03:59:59.999Z'],
    ['printed date before range but New York within range','2026-08-31T23:30:00-07:00'],
    ['midnight date carrier remains unchanged','2026-09-02T00:00:00.000Z']
  ];
  for(const [name,dateTime]of cases)await t.test(name,()=>{
    const f=fixture();change(f,'cashTransactions.3',p=>p.cash_account_transactions[0].date_time=dateTime);
    const r=projectSharesightSyncAccount(f);
    assert.equal(r.cashEvents.find(x=>x.id===14).dateTime,dateTime);
    assert.equal(r.identity.fromDate,scope.fromDate);assert.equal(r.identity.targetDate,scope.targetDate);
    assert.equal(Object.hasOwn(r.cashEvents.find(x=>x.id===14),'businessDate'),false);
    assert.equal(r.accepted,undefined);assert.equal(r.publicationReady,undefined);
  });
});
test('projection does not approve event range; the original validator must do so',()=>{
  const f=fixture();change(f,'cashTransactions.3',p=>p.cash_account_transactions[0].date_time='2026-08-30T12:00:00Z');
  const r=projectSharesightSyncAccount(f);
  assert.equal(r.cashEvents.find(x=>x.id===14).dateTime,'2026-08-30T12:00:00Z');
  assert.equal(r.accepted,undefined);assert.equal(r.synchronized,undefined);assert.equal(r.publicationReady,undefined);
  // A changed coordinator query scope cannot reuse this source binding even
  // though the projection does not derive business dates from cash timestamps.
  f.scope.fromDate='2026-08-30';
  assert.notEqual(projectSharesightSyncAccount(f).sourceSha256,r.sourceSha256);
});
test('supports native currency independently from USD reporting value',()=>{
  const f=fixture();change(f,'performance',p=>p.report.cash_accounts.push({id:6,portfolio:{id:1,name:'IB-HK'},currency:{code:'CAD'},value:40}));
  change(f,'cashAccounts',p=>p.cash_accounts.push({id:6,portfolio_id:1,portfolio_currency:'USD',date:scope.targetDate,currency:'CAD',balance:55.55,balance_in_portfolio_currency:40}));
  f.raw.cashTransactions[6]='{"cash_account_transactions":[]}';
  const r=projectSharesightSyncAccount(f);assert.deepEqual(r.cash[1],{id:6,currency:'CAD',date:scope.targetDate,nativeBalance:'5555e-2',portfolioBalance:'4e1',reportValue:'4e1'});
});
test('fixed two-account roles and identity are enforced',()=>{
  for(const [role,name,portfolioId]of [['schwab','Schwab-HK',936249],['webull','Webull',1350094]]){
    const f=fixture();f.scope={...scope,role,name,portfolioId};
    for(const key of ['performance','cashAccounts','trades','payouts.13'])change(f,key,p=>{
      const replace=v=>{if(v&&typeof v==='object'){for(const [k,x]of Object.entries(v)){if(k==='portfolio_id')v[k]=portfolioId;else if(k==='portfolio')v[k]={id:portfolioId,name};else replace(x);}}};replace(p);
    });
    assert.equal(projectSharesightSyncAccount(f).identity.role,role);
    f.scope.portfolioId++;refuse(f,'SCOPE');
  }
});
test('rejects incomplete or ambiguous source sets',async t=>{
  const scenarios=[
    ['performance pagination','performance',p=>p.links={next:'next'},'INCOMPLETE'],
    ['report restriction','performance',p=>p.report.restricted=true,'INCOMPLETE'],
    ['cash incomplete','cashAccounts',p=>p.complete=false,'INCOMPLETE'],
    ['malformed completion flag','cashAccounts',p=>p.complete='false','INCOMPLETE'],
    ['trade pagination','trades',p=>p.meta={pagination:{next_page:2}},'INCOMPLETE'],
    ['event pagination','cashTransactions.3',p=>p.has_more=true,'INCOMPLETE'],
    ['payout pagination','payouts.13',p=>p.truncated=true,'INCOMPLETE'],
    ['holding duplicates','performance',p=>p.report.holdings.push(p.report.holdings[0]),'DUPLICATE'],
    ['cash duplicates','cashAccounts',p=>p.cash_accounts.push(p.cash_accounts[0]),'DUPLICATE'],
    ['trade duplicates','trades',p=>p.trades.push(p.trades[0]),'DUPLICATE'],
    ['event duplicates','cashTransactions.3',p=>p.cash_account_transactions.push(p.cash_account_transactions[0]),'DUPLICATE'],
    ['holding portfolio','performance',p=>p.report.holdings[0].portfolio.id=99,'IDENTITY'],
    ['holding currency','performance',p=>p.report.holdings[0].instrument_currency.code='CAD','IDENTITY'],
    ['cash portfolio','cashAccounts',p=>p.cash_accounts[0].portfolio_id=99,'IDENTITY'],
    ['cash currency','cashAccounts',p=>p.cash_accounts[0].currency='CAD','CURRENCY'],
    ['trade portfolio','trades',p=>p.trades[0].portfolio_id=99,'IDENTITY'],
    ['event account','cashTransactions.3',p=>p.cash_account_transactions[0].cash_account_id=99,'IDENTITY'],
    ['event portfolio link','cashTransactions.3',p=>p.cash_account_transactions[0].links={portfolio:'https://api.sharesight.com/api/v2/portfolios/99'},'IDENTITY'],
    ['payout holding','payouts.13',p=>p.holding_id=99,'IDENTITY'],
    ['payout currency','payouts.13',p=>p.currency='CAD','IDENTITY']
  ];
  for(const [name,key,mutate,code]of scenarios)await t.test(name,()=>{const f=fixture();change(f,key,mutate);refuse(f,code);});
});
test('rejects missing and unexpected mapped cash or payout IDs',()=>{
  const f=fixture();delete f.raw.cashTransactions[3];refuse(f,'IDENTITY');
  const g=fixture();g.raw.cashTransactions[4]='{"cash_account_transactions":[]}';refuse(g,'IDENTITY');
  const h=fixture();h.raw.payouts[14]=h.raw.payouts[13];refuse(h,'IDENTITY');
  const j=fixture();j.raw.cashTransactions['03']=j.raw.cashTransactions[3];refuse(j,'SCHEMA');
  const k=fixture();change(k,'payouts.13',p=>delete p.confirmed);refuse(k,'SCHEMA');
  const m=fixture();change(m,'performance',p=>p.report.holdings[0].instrument.code='');refuse(m,'IDENTITY');
});
test('validates dates without substituting synchronization day or timezone',async t=>{
  const cases=[
    ['trade date','trades',p=>p.trades[0].transaction_date='2026-09-03'],
    ['impossible payout day','payouts.13',p=>p.paid_on='2026-02-30'],
    ['cross-midnight invalid hour','cashTransactions.3',p=>p.cash_account_transactions[0].date_time='2026-09-03T24:00:00Z'],
    ['cross-midnight invalid offset','cashTransactions.3',p=>p.cash_account_transactions[0].date_time='2026-08-31T23:30:00-14:30'],
    ['impossible event day','cashTransactions.3',p=>p.cash_account_transactions[0].date_time='2026-02-30T12:00:00Z'],
    ['event hour','cashTransactions.3',p=>p.cash_account_transactions[0].date_time='2026-09-02T24:00:00Z'],
    ['invalid UTC offset','cashTransactions.3',p=>p.cash_account_transactions[0].date_time='2026-09-02T12:00:00+14:30'],
    ['missing timezone','cashTransactions.3',p=>p.cash_account_transactions[0].date_time='2026-09-02T12:00:00']
  ];
  for(const [name,key,mutate]of cases)await t.test(name,()=>{const f=fixture();change(f,key,mutate);refuse(f,'DATE');});
  const f=fixture();change(f,'cashAccounts',p=>p.cash_accounts[0].date='2026-09-01');refuse(f,'IDENTITY');
});
test('strict raw JSON refuses duplicate keys, overflow, underflow and invalid numeric tokens',async t=>{
  const cases=[
    ['duplicate root','{"trades":[],"trades":[]}'],
    ['escaped duplicate',String.raw`{"trades":[],"tr\u0061des":[]}`],
    ['nested duplicate','{"trades":[{"id":1,"id":2}]}'],
    ['infinite','{"trades":[],"unused":1e309}'],
    ['underflow','{"trades":[],"unused":1e-999}'],
    ['unsafe integer','{"trades":[],"unused":9007199254740993}'],
    ['negative zero','{"trades":[],"unused":-0}'],
    ['NaN','{"trades":[],"unused":NaN}'],
    ['trailing','{"trades":[]} false'],
    ['prototype','{"trades":[],"__proto__":{}}']
  ];
  for(const [name,source]of cases)await t.test(name,()=>{const f=fixture();f.raw.trades=source;refuse(f,'JSON');});
});
test('does not execute hostile caller accessors or proxies and never leaks source text',()=>{
  let calls=0;const f=fixture();Object.defineProperty(f,'raw',{enumerable:true,get(){calls++;throw Error('PRIVATE_SYNTH');}});refuse(f,'JSON');
  const p=new Proxy(fixture(),{ownKeys(){calls++;throw Error('PRIVATE_SYNTH');}});refuse(p,'JSON');
  const c=fixture();c.raw.cashTransactions.self=c.raw;refuse(c,'JSON');
  const a=fixture();Object.defineProperty(a.scope,Symbol('private'),{value:1});refuse(a,'JSON');
  assert.equal(calls,0);assert.equal(syncProjectionFailureCode(new Error('PRIVATE_SYNTH')),'FEE_SYNC_PROJECTION_REFUSED');
});
test('rounded JSON identities cannot impersonate a valid integer identity',()=>{
  for(const field of ['portfolio_id','id']){
    const f=fixture();f.raw.performance=f.raw.performance.replace('"'+field+'":1','"'+field+'":1.0000000000000001');refuse(f,'IDENTITY');
  }
  const f=fixture();f.raw.cashTransactions[3]=f.raw.cashTransactions[3].replace('"payout_id":13','"payout_id":13.0000000000000001');refuse(f,'IDENTITY');
});
test('bounded source, unsupported roles and schema do not fall back to a broad source',()=>{
  const f=fixture();f.raw.trades=' '.repeat(2*1024*1024+1);refuse(f,'SIZE');
  const g=fixture();g.scope.role='other';refuse(g,'SCOPE');
  const h=fixture();h.scope.name='Other';refuse(h,'SCOPE');
  const j=fixture();j.scope.fromDate='2026-09-03';refuse(j,'DATE');
  const k=fixture();k.raw.url='https://example.invalid';refuse(k,'SCHEMA');
});
