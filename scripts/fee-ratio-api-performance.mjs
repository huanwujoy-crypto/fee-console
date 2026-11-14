// Pure builder: Sharesight API reports -> the existing performance source, in
// its separately labelled API form (`transport: 'official-api'`).
//
// It reads nothing, writes nothing and computes no return. Every figure is the
// provider's own: a group sub-total's `total_gain_percent`, the report's own
// total, or one holding's own row. A row's scope is decided by WHICH positions
// the provider's sub-total covers, never by what a custom group is called, so
// renaming a group in Sharesight cannot silently move a figure. Anything that
// does not fit exactly is refused with a fixed code; nothing is guessed.
//
// A success means only that these reports fitted the existing source contract.
// The result is then validated by the same core the viewer uses.
import crypto from 'node:crypto';
import {createAggregateReturnsCore} from './fee-ratio-aggregate-returns.mjs';

export function createApiPerformanceCore(){
  const CAPTURE='fee-console.ratio-api-performance.v1';
  const CODES=Object.freeze(['CAPTURE','REPORT','MEMBER','CLASS','STRATEGY','SECONDARY','STOCK','INCEPTION','CASH','TOP','CONTRACT']);
  const fail=code=>{throw Error('RATIO_API_PERFORMANCE_'+(CODES.includes(code)?code:'CAPTURE'));};
  const GROUPS=Object.freeze(['asset','income','top','stock']),PERIODS=Object.freeze(['all','oneYear']);
  const FUND_PARENTS=Object.freeze(['对冲基金','常青基金']),STOCK=Object.freeze(['美国底仓','美国科技','非美发达','新兴市场']);
  const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
  const exact=(o,k)=>object(o)&&Object.keys(o).sort().join('|')===[...k].sort().join('|');
  const text=s=>typeof s==='string'&&s.length>0&&s.length<=1000&&!/[\u0000-\u001f\u007f]/.test(s);
  const date=s=>typeof s==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(s)&&new Date(s+'T00:00:00Z').toISOString().slice(0,10)===s;
  const instant=s=>typeof s==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(s)&&Number.isFinite(Date.parse(s));
  const hex=s=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s);
  const id=v=>typeof v==='number'&&Number.isSafeInteger(v)&&v>0?String(v):typeof v==='string'&&/^[1-9]\d{0,14}$/.test(v)?v:null;
  const finite=v=>typeof v==='number'&&Number.isFinite(v)&&Math.abs(v)<=1e9;
  const cents=v=>typeof v==='number'&&Number.isFinite(v)&&Math.abs(v)<=1e12&&/^-?\d+(?:\.\d{1,2})?$/.test(String(v));
  const key=m=>JSON.stringify([m.account,m.market,m.securityCode]);
  const sameSet=(a,b)=>a.size===b.size&&[...a].every(x=>b.has(x));
  const oneYearBefore=end=>{const y=Number(end.slice(0,4))-1,m=Number(end.slice(5,7)),d=Number(end.slice(8,10));return String(y).padStart(4,'0')+'-'+String(m).padStart(2,'0')+'-'+String(Math.min(d,new Date(Date.UTC(y,m,0)).getUTCDate())).padStart(2,'0');};
  // The same first-field rule the allocation uses for fund strategies.
  const strategyOf=code=>{
    const dated=code.match(/^(.*?)((?:19|20)\d{2}[-/.](?:0[1-9]|1[0-2])[-–—_:：/\s]|(?:19|20)\d{2}年(?:0?[1-9]|1[0-2])月)/);
    if(!dated)return null;
    return dated[1].trim().split(/[-–—_:：/]+/u)[0].trim()||'未分类';
  };
  // A stable report id from what the report is, not from when it was read.
  const reportId=(asOf,name)=>'apireport_'+crypto.createHash('sha256').update(JSON.stringify([CAPTURE,asOf,name])).digest('hex').slice(0,32);

  function build(capture,{topTargets}={}){
    if(!exact(capture,['schema','asOf','allStartDate','accounts','reports','holdings','trades','cash'])||capture.schema!==CAPTURE||!date(capture.asOf)||!date(capture.allStartDate)||capture.allStartDate>capture.asOf
      ||!Array.isArray(capture.accounts)||capture.accounts.length!==10||!Array.isArray(topTargets))fail('CAPTURE');
    const asOf=capture.asOf,accountName=new Map();
    for(const a of capture.accounts){const aid=exact(a,['id','name'])?id(a.id):null;if(!aid||!text(a.name)||accountName.has(aid)||[...accountName.values()].includes(a.name))fail('CAPTURE');accountName.set(aid,a.name);}
    const starts={all:capture.allStartDate,oneYear:oneYearBefore(asOf)};

    // ---- eight reports, each with the hash of its exact response ----
    // Optional pair: the `top` grouping read again with `report_combined=true`. Its extra `combined_holdings`
    // list carries the provider's own return for one security held in several accounts. Both or neither.
    const COMBINED='topCombined',withCombined=PERIODS.some(p=>Object.hasOwn(capture.reports||{},COMBINED+'.'+p));
    if(!exact(capture.reports,[...GROUPS,...(withCombined?[COMBINED]:[])].flatMap(g=>PERIODS.map(p=>g+'.'+p))))fail('REPORT');
    const parsed={};
    for(const g of [...GROUPS,...(withCombined?[COMBINED]:[])])for(const p of PERIODS){
      const slot=g+'.'+p,entry=capture.reports[slot];
      if(!exact(entry,['report','sha256'])||!hex(entry.sha256)||!object(entry.report))fail('REPORT');
      const r=entry.report;
      if(r.start_date!==starts[p]||r.end_date!==asOf||r.include_sales!==true||r.currency?.code!=='USD'||typeof r.percentages_annualised!=='boolean'
        ||!Array.isArray(r.holdings)||!Array.isArray(r.sub_totals)||!Array.isArray(r.cash_accounts)||r.holdings.length>20000)fail('REPORT');
      const members=new Map(),groupsOf=new Map();
      r.holdings.forEach((h,i)=>{
        const pid=object(h?.portfolio)?id(h.portfolio.id):null,hid=object(h)?id(h.id):null;
        if(!pid||!hid||!accountName.has(pid)||h.limited!==false||!text(h.instrument?.code)||!text(h.instrument?.market_code)||!text(h.instrument?.name)||!text(h.group_name))fail('MEMBER');
        const m={account:accountName.get(pid),market:h.instrument.market_code,securityCode:h.instrument.code};
        if(members.has(key(m)))fail('MEMBER');
        members.set(key(m),{member:m,listingKey:pid+'|'+hid,row:i+1,name:h.instrument.name,returnPct:h.total_gain_percent});
        groupsOf.set(h.group_name,[...(groupsOf.get(h.group_name)||[]),key(m)]);
      });
      const subs=r.sub_totals.map((s,i)=>{
        if(!object(s)||!text(s.group_name)||!groupsOf.has(s.group_name))fail('REPORT');
        return {name:s.group_name,row:i+1,returnPct:s.total_gain_percent,keys:new Set(groupsOf.get(s.group_name))};
      });
      // Every holding belongs to exactly one sub-total of its own report.
      if(new Set(subs.map(s=>s.name)).size!==subs.length||subs.length!==groupsOf.size)fail('REPORT');
      parsed[slot]={r,members,subs,source:{apiReportId:reportId(asOf,slot),sha256:entry.sha256,locator:'api-v3-performance-custom-group '+slot}};
    }
    // The combined reading is used only when it repeats the plain `top` report exactly (same positions, same
    // sub-totals with the same figures). Otherwise it is ignored and the result is what it was without it.
    const combinedOf={};
    for(const p of PERIODS){
      const plain=parsed['top.'+p],again=parsed[COMBINED+'.'+p];
      if(!again||!Array.isArray(again.r.combined_holdings)||again.r.combined_holdings.length>20000)continue;
      const figure=m=>[...m.members].map(([k,e])=>[k,e.listingKey,e.returnPct]).sort((a,b)=>a[0].localeCompare(b[0]));
      const totals=m=>m.subs.map(x=>[x.name,x.returnPct,[...x.keys].sort()]).sort((a,b)=>a[0].localeCompare(b[0]));
      if(JSON.stringify([figure(plain),totals(plain)])!==JSON.stringify([figure(again),totals(again)]))continue;
      const pidOf=new Map([...accountName].map(([pid,name])=>[name,pid])),rows=new Map();
      again.r.combined_holdings.forEach((h,i)=>{
        if(!object(h)||!text(h.instrument?.code)||!text(h.instrument?.market_code)||!Array.isArray(h.portfolios)||!h.portfolios.length)return;
        const pids=h.portfolios.map(x=>object(x)?id(x.id):id(x));
        if(pids.some(x=>!x||!accountName.has(x))||new Set(pids).size!==pids.length)return;
        const security=h.instrument.market_code+'|'+h.instrument.code,list=rows.get(security)||[];
        list.push({row:i+1,returnPct:h.total_gain_percent,pids:new Set(pids)});rows.set(security,list);
      });
      combinedOf[p]={source:again,rows,pidOf};
    }

    // ---- first-buy dates and their record kind, for every position any report covers ----
    const h=capture.holdings,t=capture.trades,c=capture.cash;
    if(!exact(h,['sha256','capturedAt','rows'])||!hex(h.sha256)||!instant(h.capturedAt)||!Array.isArray(h.rows)
      ||!exact(t,['rows'])||!Array.isArray(t.rows)||!exact(c,['sha256','capturedAt','accounts','transactions'])||!hex(c.sha256)||!instant(c.capturedAt)||!Array.isArray(c.accounts)||!Array.isArray(c.transactions))fail('CAPTURE');
    const listing=new Map();
    for(const row of h.rows){const pid=id(row?.portfolioId),hid=object(row?.holding)?id(row.holding.id):null;if(!pid||!hid||!accountName.has(pid)||!date(row.holding.inception_date)||listing.has(pid+'|'+hid))fail('INCEPTION');listing.set(pid+'|'+hid,row.holding.inception_date);}
    const earliest=new Map();
    for(const row of t.rows){
      const pid=id(row?.portfolioId),tr=row?.trade;
      if(!pid||!object(tr)||tr.state!=='confirmed'||!date(tr.transaction_date)||!id(tr.holding_id)||typeof tr.description_code!=='string')continue;
      const k=pid+'|'+id(tr.holding_id),seen=earliest.get(k);
      if(!seen||tr.transaction_date<seen.date)earliest.set(k,{date:tr.transaction_date,codes:new Set([tr.description_code])});else if(tr.transaction_date===seen.date)seen.codes.add(tr.description_code);
    }
    const HOLDINGS_ID=reportId(asOf,'member-holdings'),CASH_ID=reportId(asOf,'cash-account-transactions');
    const inception=new Map();
    const dateHolding=entry=>{
      const k=key(entry.member);if(inception.has(k))return inception.get(k);
      const startDate=listing.get(entry.listingKey),first=earliest.get(entry.listingKey);
      // The probe showed the listed date always equals the earliest confirmed record's date. Require it.
      if(!startDate||startDate>asOf||first&&first.date!==startDate)fail('INCEPTION');
      const item={...entry.member,startDate,dateKind:first?.codes.has('OPENING_BALANCE')?'holding-opening-balance':'holding-inception',sourceFileId:HOLDINGS_ID,sourceLocator:'holdings.inception_date'};
      inception.set(k,item);return item;
    };
    // ---- cash accounts as members, dated by their first transaction ----
    const cashStart=new Map();
    for(const row of c.transactions){const cid=id(row?.cashAccountId),day=typeof row?.dateTime==='string'?row.dateTime.slice(0,10):null;if(!cid||!date(day))fail('CASH');if(!cashStart.has(cid)||day<cashStart.get(cid))cashStart.set(cid,day);}
    const cashMembers=report=>report.cash_accounts.map(row=>{
      const pid=object(row?.portfolio)?id(row.portfolio.id):null,cid=object(row)?id(row.id):null;
      if(!pid||!cid||!accountName.has(pid)||!text(row.name)||!c.accounts.some(a=>id(a?.portfolioId)===pid&&id(a?.cashAccountId)===cid))fail('CASH');
      const m={account:accountName.get(pid),market:'CASH',securityCode:row.name},k=key(m);
      if(!inception.has(k)){const startDate=cashStart.get(cid);if(!startDate||startDate>asOf)fail('CASH');inception.set(k,{...m,startDate,dateKind:'cash-first-transaction',sourceFileId:CASH_ID,sourceLocator:'cash_account_transactions.date_time'});}
      return m;
    });

    // A rate is labelled annualised only on the provider's own flag AND a holding period of at least one year.
    const unitOf=(report,period,members)=>{
      if(period==='oneYear')return report.percentages_annualised===false?'period':'unknown';
      return report.percentages_annualised===true&&members.every(m=>inception.get(key(m)).startDate<=starts.oneYear)?'p.a.':'unknown';
    };
    const row=(scope,members,sheet,n,returnPct,report,period,extra={})=>{
      if(!finite(returnPct))fail('REPORT');
      return {scope,members,sourceSheet:sheet,sourceRow:n,returnPct,unit:unitOf(report,period,members),termEvidence:{type:'unknown'},...extra};
    };
    const classification=name=>({type:'classification',name,parent:null});

    const reports=PERIODS.map(period=>{
      const asset=parsed['asset.'+period],income=parsed['income.'+period],stock=parsed['stock.'+period];
      const classOf=new Map(),rows=[];
      const members=(source,keys)=>[...keys].map(k=>{const e=source.members.get(k);dateHolding(e);return e.member;}).sort((a,b)=>key(a).localeCompare(key(b)));
      // Main report: one classification row per asset-class sub-total.
      for(const s of asset.subs){
        const name=s.name==='VC/PE'?'PE/VC':s.name;
        for(const k of s.keys)classOf.set(k,name);
        rows.push(row(classification(name),members(asset,s.keys),'report.sub_totals',s.row,s.returnPct,asset.r,period));
      }
      if(new Set(rows.map(x=>x.scope.name)).size!==rows.length)fail('CLASS');
      // The four reports of one period must describe the same positions.
      for(const other of [income,stock,parsed['top.'+period]])if(!sameSet(new Set(other.members.keys()),new Set(asset.members.keys())))fail('MEMBER');
      // The report's own total covers its holdings and its cash rows.
      const cash=cashMembers(asset.r),amount=asset.r.total_gain;
      rows.push(row({type:'portfolio',name:'All Together',parent:null},[...members(asset,asset.members.keys()),...cash].sort((a,b)=>key(a).localeCompare(key(b))),'report',1,asset.r.total_gain_percent,asset.r,period,{returnAmountUSD:cents(amount)?amount:null}));

      // Income grouping: fund strategies of the two fund classes, and the secondary market as a whole.
      const secondaryKeys=new Set([...classOf].filter(([,name])=>!['PE/VC',...FUND_PARENTS].includes(name)).map(([k])=>k)),strategies=new Set();
      let secondary=0;
      for(const s of income.subs){
        const parents=new Set([...s.keys].map(k=>classOf.get(k)));
        if(parents.size===1&&FUND_PARENTS.includes([...parents][0])){
          const names=new Set([...s.keys].map(k=>strategyOf(income.members.get(k).member.securityCode)).filter(Boolean));
          if(names.size>1)fail('STRATEGY');
          const parent=[...parents][0],name=[...names][0]||'未分类';
          if(strategies.has(parent+'|'+name))fail('STRATEGY');strategies.add(parent+'|'+name);
          rows.push(row({type:'fund-strategy',name,parent},members(income,s.keys),'report.sub_totals',s.row,s.returnPct,income.r,period,{sourceFileId:income.source.apiReportId}));
        }else if(parents.size===1&&[...parents][0]==='PE/VC'){/* no strategy rows for this class */}
        else if([...s.keys].every(k=>secondaryKeys.has(k))){
          if(!sameSet(s.keys,secondaryKeys))fail('SECONDARY');secondary++;
          rows.push(row(classification('二级市场'),members(income,s.keys),'report.sub_totals',s.row,s.returnPct,income.r,period,{sourceFileId:income.source.apiReportId}));
        }else fail('STRATEGY');
      }
      if(secondary>1)fail('SECONDARY');
      // Each fund class must be exactly partitioned by its strategy rows.
      for(const parent of FUND_PARENTS){
        const want=new Set([...classOf].filter(([,name])=>name===parent).map(([k])=>k)),got=rows.filter(x=>x.scope.type==='fund-strategy'&&x.scope.parent===parent).flatMap(x=>x.members.map(key));
        if(got.length!==new Set(got).size||!sameSet(new Set(got),want))fail('STRATEGY');
      }
      // Stock grouping: only the sub-total that is exactly the four stock classes together.
      const stockKeys=new Set([...classOf].filter(([,name])=>STOCK.includes(name)).map(([k])=>k)),match=stock.subs.filter(s=>sameSet(s.keys,stockKeys));
      const withStock=stockKeys.size>0;
      if(withStock){if(match.length!==1)fail('STOCK');rows.push(row(classification('股票市场'),members(stock,match[0].keys),'report.sub_totals',match[0].row,match[0].returnPct,stock.r,period,{sourceFileId:stock.source.apiReportId}));}
      return {period,startDate:starts[period],endDate:asOf,includeClosed:true,calculationMethod:'sharesight-native',currency:'USD',
        // The report total includes its cash rows; not every cash row carries a gain.
        cashPerformance:'included',source:asset.source,additionalSources:withStock?[income.source,stock.source]:[income.source],rows,
        unavailable:[{scope:classification('现金类'),reason:'native-aggregate-not-provided'}]};
    });

    // ---- top five: a single holding's own row, or the top grouping's sub-total for the same instruments ----
    const targets=structuredClone(topTargets);
    const topReports=PERIODS.map((period,index)=>{
      // One `top` source per period: the combined reading when in use (it repeats the plain one exactly), else the plain one.
      const asset=parsed['asset.'+period],top=combinedOf[period]?combinedOf[period].source:parsed['top.'+period],parent=reports[index],rows=[],unavailable=[];
      for(const target of targets){
        if(!exact(target,['category','name','members','basis'])||!Array.isArray(target.members))fail('TOP');
        const want=target.members.map(key),ref={category:target.category,name:target.name};
        if(!want.length||want.some(k=>!asset.members.has(k))){unavailable.push({target:ref,reason:want.length?'native-aggregate-not-provided':'no-direct-holding'});continue;}
        const evidence=(source,keys)=>[...keys].map(k=>{const e=source.members.get(k);dateHolding(e);return {...e.member,name:e.name,category:target.category,sourceRow:e.row};}).sort((a,b)=>a.sourceRow-b.sourceRow);
        if(want.length===1){
          const e=asset.members.get(want[0]);
          if(!finite(e.returnPct)){unavailable.push({target:ref,reason:'native-aggregate-not-provided'});continue;}
          dateHolding(e);
          rows.push({target:ref,memberEvidence:evidence(asset,want),sourceSheet:'report.holdings',sourceRow:e.row,returnPct:e.returnPct,unit:unitOf(asset.r,period,[e.member]),termEvidence:{type:'unknown'}});continue;
        }
        const instruments=new Set(target.members.map(m=>m.market+'|'+m.securityCode));
        // Several accounts: the provider's own sub-total covering exactly these instruments, sold lots included.
        const match=top.subs.filter(s=>want.every(k=>s.keys.has(k))&&[...s.keys].every(k=>{const m=top.members.get(k).member;return instruments.has(m.market+'|'+m.securityCode);}));
        if(match.length!==1||!finite(match[0].returnPct)){
          // No such sub-total. One security: the provider's own combined row for it, when the combined
          // reading is in use. It must be the only such row, name every account that holds it now, and cover exactly
          // the positions (sold ones included) the same report lists for that security in those accounts.
          const joined=combinedOf[period];
          if(joined&&instruments.size===1){
            const security=[...instruments][0],found=joined.rows.get(security)||[],now=target.members.map(m=>joined.pidOf.get(m.account));
            const keys=[...joined.source.members].filter(([,e])=>e.member.market+'|'+e.member.securityCode===security).map(([k])=>k);
            const holders=new Set(keys.map(k=>joined.source.members.get(k).listingKey.split('|')[0]));
            if(found.length===1&&finite(found[0].returnPct)&&now.every(x=>found[0].pids.has(x))&&sameSet(holders,found[0].pids)&&want.every(k=>keys.includes(k))){
              const ev=evidence(joined.source,keys);
              rows.push({target:ref,memberEvidence:ev,sourceSheet:'report.combined_holdings',sourceRow:found[0].row,returnPct:found[0].returnPct,unit:unitOf(joined.source.r,period,ev.map(e=>({account:e.account,market:e.market,securityCode:e.securityCode}))),termEvidence:{type:'unknown'},sourceFileId:joined.source.source.apiReportId});continue;
            }
          }
          unavailable.push({target:ref,reason:'native-aggregate-not-provided'});continue;
        }
        const ev=evidence(top,match[0].keys);
        rows.push({target:ref,memberEvidence:ev,sourceSheet:'report.sub_totals',sourceRow:match[0].row,returnPct:match[0].returnPct,unit:unitOf(top.r,period,ev.map(e=>({account:e.account,market:e.market,securityCode:e.securityCode}))),termEvidence:{type:'unknown'},sourceFileId:top.source.apiReportId});
      }
      return {period,startDate:parent.startDate,endDate:asOf,includeClosed:true,calculationMethod:'sharesight-native',currency:'USD',cashPerformance:parent.cashPerformance,source:parent.source,additionalSources:rows.some(r=>r.sourceFileId)?[top.source]:[],rows,unavailable};
    });

    const used=new Set([...inception.values()].map(m=>m.sourceFileId));
    const sources=[{apiReportId:HOLDINGS_ID,sha256:h.sha256,locator:'api-v3 member holdings listings',capturedAt:h.capturedAt},{apiReportId:CASH_ID,sha256:c.sha256,locator:'api-v2 cash account transactions',capturedAt:c.capturedAt}].filter(s=>used.has(s.apiReportId));
    const performance={schema:'fee-console.ratio-performance-source.v2',provider:'Sharesight',transport:'official-api',currency:'USD',asOf,accounts:capture.accounts.map(a=>a.name),reports,
      ...(targets.length?{topHoldings:{schema:'fee-console.ratio-top5-source.v1',targets,reports:topReports}}:{}),
      inceptionEvidence:{schema:'fee-console.ratio-inception-source.v2',capturedAt:sources.map(s=>s.capturedAt).sort().at(-1),includeClosed:true,
        sources:sources.map(({capturedAt,...s})=>s),sourceCaptures:sources.map(s=>({apiReportId:s.apiReportId,capturedAt:s.capturedAt,sourceKind:'sharesight-api-holdings'})),
        members:[...inception.values()].sort((a,b)=>key(a).localeCompare(key(b)))}};
    // The same core the viewer uses must accept the result as it stands.
    try{createAggregateReturnsCore().build(performance,{expectedAccounts:performance.accounts,expectedAsOf:asOf,...(targets.length?{topTargets:targets}:{})});}catch{fail('CONTRACT');}
    return performance;
  }
  return {CAPTURE,CODES,GROUPS,PERIODS,build};
}
