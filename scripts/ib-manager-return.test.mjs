import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {buildIbManagerReturnReceipt,createIbManagerReturnConsumer,buildIbManagerDrawdownReceipt,createIbManagerDrawdownConsumer} from './ib-manager-return.mjs';
import {prepareIbManagerReturn} from './ib-manager-return-file.mjs';
import {buildFeeCalculationReceipt} from './fee-receipt-core.mjs';
// Entirely synthetic. No account identity, private input, key store or network.
const fixture=()=>({schema:'fee-console.ib-manager-return-input.v1',currency:'USD',timezone:'America/New_York',flowTiming:'eod',flowsComplete:true,correctionsConfirmed:true,sourceSha256:'a'.repeat(64),periodReturnsInput:{points:[{d:'2026-08-31',tot:100},{d:'2026-09-01',tot:150},{d:'2026-09-02',tot:135}],openT:100,from:'2026-08-31',to:'2026-09-02',days:3,flowByDate:{'2026-09-01':50},rate:0,cr:0,cumBefore:0,hwmBefore:0}});
const core=createIbManagerReturnConsumer();
const feeView=r=>({state:'verified',start:r.start,asOf:r.asOf,periods:r.periods.map(({grossTwrPpm,...p})=>p)});
test('cash and in-kind EOD flows are excluded; zero and negative months remain real values',async()=>{
  const r=await buildIbManagerReturnReceipt(fixture());
  assert.deepEqual(r.periods.map(p=>p.grossTwrPpm),[0,-100000]);assert.equal(r.grossTwrPpm,-100000);
  const v=await core.project(r,feeView(r));assert.equal(v.state,'verified');assert.equal(v.byMonth['2026-08'],0);assert.equal(v.byMonth['2026-09'],-.1);
  const x=fixture();x.periodReturnsInput.points[1].tot=50;x.periodReturnsInput.points[2].tot=45;x.periodReturnsInput.flowByDate['2026-09-01']=-50;
  assert.deepEqual((await buildIbManagerReturnReceipt(x)).periods,r.periods);
});
test('missing, unconfirmed, misdated or malformed history never becomes a return',async()=>{
  const changes=[x=>x.flowsComplete=false,x=>x.correctionsConfirmed=false,x=>x.currency='HKD',x=>x.periodReturnsInput.points.pop(),x=>x.periodReturnsInput.points[1].d='2026-09-02',x=>x.periodReturnsInput.points[1].tot=NaN,x=>x.periodReturnsInput.openT=0,x=>x.periodReturnsInput.days=4,x=>x.periodReturnsInput.flowByDate['2026-09-03']=1,x=>x.periodReturnsInput.flowByDate['bad']=0,x=>x.periodReturnsInput.rate=.02];
  for(const change of changes){const x=fixture();change(x);await assert.rejects(buildIbManagerReturnReceipt(x));}
  assert.equal((await core.project(null,{})).value,null);assert.equal((await core.project({},{})).state,'pending');
});
test('receipt tampering and mismatched dates/month boundaries suppress all IB values',async()=>{
  const r=await buildIbManagerReturnReceipt(fixture()),v=feeView(r);
  for(const mutate of [x=>x.periods[0].grossTwrPpm++,x=>x.scope='composite',x=>x.currency='HKD',x=>x.asOf='2026-09-03',x=>x.extra=1]){const bad=structuredClone(r);mutate(bad);assert.equal((await core.project(bad,v)).value,null);}
  for(const mutate of [x=>x.asOf='2026-09-03',x=>x.start='2026-08-01',x=>x.periods[0].from='2026-08-01',x=>x.state='pending']){const bad=structuredClone(v);mutate(bad);const out=await core.project(r,bad);assert.equal(out.state,'pending');assert.equal(out.value,null);assert.deepEqual(out.byMonth,{});assert.equal(out.asOf,r.asOf);}
  assert.deepEqual(feeView(r),v);
});
test('receipt contains only dates/returns/commitments, never raw positions, flow amounts or identifiers',async()=>{
  const r=await buildIbManagerReturnReceipt(fixture()),s=JSON.stringify(r);
  assert.doesNotMatch(s,/openT|flowByDate|quantity|accountId|portfolioId|\"tot\"|\"amount\"/);
  assert.equal((await core.validate(r)).ok,true);
});
test('the browser consumes the exact reviewed receipt factory',async()=>{
  const file=process.env.FEE_LEDGER_TEST_INDEX||new URL('../index.html',import.meta.url);
  if(process.env.GITHUB_ACTIONS==='true'&&process.env.FEE_LEDGER_TEST_INDEX)throw Error('local preview only');
  const html=fs.readFileSync(file,'utf8'),a='/* ib-manager-return-consumer:start */',b='/* ib-manager-return-consumer:end */';
  if(!html.includes(a)){assert.ok(!html.includes(b));return;}
  const block=html.slice(html.indexOf(a)+a.length,html.indexOf(b));
  if(html.includes('/* ib-manager-report-source:v1 */'))assert.equal(block.trim(),createIbManagerReturnConsumer.toString());
  const box={crypto:crypto.webcrypto,TextEncoder,structuredClone};vm.createContext(box);vm.runInContext(block+';globalThis.ibTestCore=createIbManagerReturnConsumer();',box);
  const r=await buildIbManagerReturnReceipt(fixture()),actual=JSON.parse(JSON.stringify(await box.ibTestCore.project(r,feeView(r)))),expected=await core.project(r,feeView(r));
  if(!html.includes('/* ib-manager-report-source:v1 */')){delete expected.historyMode;assert.equal(box.ibTestCore.schema,'fee-console.ib-manager-return-receipt.v1');assert.equal((await box.ibTestCore.validate({...r,scope:'other'})).ok,false);}
  assert.deepEqual(actual,expected);
});
test('comparison row and monthly column consume only verified IB outputs, including zero/negative values',async()=>{
  const file=process.env.FEE_LEDGER_TEST_INDEX||new URL('../index.html',import.meta.url),html=fs.readFileSync(file,'utf8');
  if(!html.includes('/* ib-manager-return:receipt-v1 */'))return;
  const box={};vm.createContext(box);
  vm.runInContext(`const esc=v=>String(v??'');const pct=v=>v==null?'—':(v>0?'+':'')+(v*100).toFixed(2)+'%';const sgn=v=>v>0?'pos':v<0?'neg':'';const ymLabel=v=>v;`,box);
  vm.runInContext(html.slice(html.indexOf('function ibManagerReturnNote('),html.indexOf('const DRAWDOWN_METHOD_NOTE=')),box);
  vm.runInContext(html.slice(html.indexOf('function renderReturnComparison('),html.indexOf('/* compact-comparison-tables:end */')),box);
  vm.runInContext(html.slice(html.indexOf('let _monthHistoryYm='),html.indexOf('function toggleMonthReturnHistory(')),box);
  const r=await buildIbManagerReturnReceipt(fixture()),view=await core.project(r,feeView(r)),st={twrG:.2,mwrD:.1,bench:[{k:'spy',twr:.3},{k:'qqq',twr:.4}],ibManager:view},before=structuredClone(st);
  const out=box.renderReturnComparison(st),ib=out.match(/<tr data-return-series="ib"[^]*?<\/tr>/)[0];
  assert.match(ib,/-10\.00%/);assert.ok(out.includes(ib+'<tr data-return-series="spy"'));assert.match(out,/后续尚未自动更新/);assert.deepEqual(st,before);
  const model={months:r.periods.map(p=>({...p,rG:.2,rB:{spy:.3,qqq:.4}})),selectedYm:'2026-09'};
  const table=box.monthlyReturnsTable(model,view);assert.match(table,/0\.00%/);assert.match(table,/-10\.00%/);assert.match(table,/\+20\.00%/);assert.match(table,/\+30\.00%/);
  for(const mode of ['missing','invalid','period-mismatch']){const pending={state:'pending',reason:mode,asOf:r.asOf,value:null,byMonth:{}};st.ibManager=pending;const text=box.renderReturnComparison(st).match(/<tr data-return-series="ib"[^]*?<\/tr>/)[0];assert.match(text,/待核对/);assert.doesNotMatch(text,/%/);for(const cell of box.monthlyReturnsTable(model,pending).matchAll(/<td data-return-series="ib"[^]*?<\/td>/g))assert.doesNotMatch(cell[0],/%/);}
  const flat=fixture();flat.periodReturnsInput.points[2].tot=150;const zero=await buildIbManagerReturnReceipt(flat);st.ibManager=await core.project(zero,feeView(zero));assert.match(box.renderReturnComparison(st).match(/<tr data-return-series="ib"[^]*?<\/tr>/)[0],/0\.00%/);
  assert.match(html,/ibManagerReturnCore\.project\(source\.state==="verified"&&sourceMatches\(source\)\?DAILY\.ibManagerReturnReceipt:null,feeView(?:,DAILY\.ibManagerSourceStatus)?\)/);
  if(html.includes('/* ib-manager-report-source:v1 */')){
    st.ibManager={...view,historyMode:'confirmed-baseline-source-verified-daily'};
    const live=box.renderReturnComparison(st);assert.match(live,/本次 Sharesight 只读来源已核验/);assert.doesNotMatch(live,/后续尚未自动更新/);
    st.ibManager={state:'pending',reason:'source-unavailable',value:null,byMonth:{}};
    const failed=box.renderReturnComparison(st);assert.match(failed,/本次来源尚未通过核验/);assert.doesNotMatch(failed.match(/<tr data-return-series="ib"[^]*?<\/tr>/)[0],/%/);
  }
});
test('requested display names are consistent across comparison, monthly details and explanations',()=>{
  const file=process.env.FEE_LEDGER_TEST_INDEX||new URL('../index.html',import.meta.url),html=fs.readFileSync(file,'utf8');
  if(!html.includes('/* return-display-names:manager-jenny-ib:v1 */'))return;
  assert.doesNotMatch(html,/组合毛|>IB<(?:\/span>|br>)/);
  assert.match(html,/row\("actual","管理方","TWR","管理能力",sub\?linked\(r=>r\.rG\):st\.twrG\)/);
  assert.match(html,/<span class="scenario">Jenny's IB<\/span>/);
  assert.match(html,/<th scope="col">管理方<br>TWR<\/th>/);
  assert.match(html,/<th scope="col">Jenny's IB<br>TWR<small>管理能力<\/small><\/th>/);
  assert.match(html,/aria-label="管理方 TWR、Jenny's IB 独立 TWR、SPY 和 QQQ 税后含息 TWR 月度比较"/);
  for(const label of ['verified','period-mismatch','invalid'])assert.ok(html.includes(label));
  assert.match(html,/Jenny's IB 独立回执待核对，暂未纳入正式收益/);
  assert.match(html,/年化：管理方 TWR/);assert.match(html,/<span>管理方 TWR <b>/);
  assert.match(html,/Jenny's IB 不纳入原管理费组合及计费本金/);
  const build=html.match(/<meta name="fee-console-build" content="(\d+\.\d+\.\d+)">/);assert.ok(build);assert.ok(html.includes('UI_VERSION_LABEL=" · v'+build[1]+'"'));
});
test('offline encrypted candidate preserves every composite input, fee receipt and original ciphertext',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ib-return-synthetic-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const key=crypto.randomBytes(32),keyText=key.toString('base64url'),file=path.join(dir,'existing.enc.json'),inputFile=path.join(dir,'input.json'),outputFile=path.join(dir,'candidate.enc.json');
  const source=fixture(),economicInput={v:4,settings:{start:source.periodReturnsInput.from,mgmt:2,carry:20,fx:{USD:1}},accounts:[{id:'schwab',opening:60},{id:'webull',opening:40}],months:[],fees:[]};
  const data={daily:source.periodReturnsInput.points.map(p=>({d:p.d,schwab:60,webull:40})),flowsAuto:[],flowsUnresolved:[],status:{asOf:source.periodReturnsInput.to,provisional:false,calibrated:true,unresolvedCount:0}};data.feeCalculationReceipt=buildFeeCalculationReceipt({data,economicInput});
  const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',key,iv),original=JSON.stringify({enc:true,v:3,data:Buffer.concat([iv,c.update(JSON.stringify(data)),c.final(),c.getAuthTag()]).toString('base64')});
  fs.writeFileSync(file,original);fs.writeFileSync(inputFile,JSON.stringify(source),{mode:0o600});
  const args={file,inputFile,outputFile,keyText,environ:{}};
  assert.equal((await prepareIbManagerReturn(args)).status,'IB_RETURN_ATTACHMENT_DRY_RUN_OK');assert.equal(fs.existsSync(outputFile),false);
  await prepareIbManagerReturn({...args,execute:true});assert.equal(fs.readFileSync(file,'utf8'),original);assert.equal(fs.statSync(outputFile).mode&0o777,0o600);
  const b=Buffer.from(JSON.parse(fs.readFileSync(outputFile)).data,'base64'),d=crypto.createDecipheriv('aes-256-gcm',key,b.subarray(0,12));d.setAuthTag(b.subarray(-16));const candidate=JSON.parse(Buffer.concat([d.update(b.subarray(12,-16)),d.final()]));
  const {ibManagerReturnReceipt,ibManagerDrawdownReceipt,...rest}=candidate;assert.deepEqual(rest,data);assert.equal((await core.validate(ibManagerReturnReceipt)).ok,true);assert.equal((await createIbManagerDrawdownConsumer().validate(ibManagerDrawdownReceipt,ibManagerReturnReceipt)).ok,true);
  await assert.rejects(prepareIbManagerReturn({...args,execute:true}));
  await assert.rejects(prepareIbManagerReturn({...args,environ:{GITHUB_ACTIONS:'true'}}));
  // Offline history never clears or hides a failed normal-source status.
  const blocked={...data,ibManagerSourceStatus:{state:'pending',targetDate:source.periodReturnsInput.to,reasonCode:'IB_SOURCE_COVERAGE_UNVERIFIED'}};
  const pendingIv=crypto.randomBytes(12),pendingCipher=crypto.createCipheriv('aes-256-gcm',key,pendingIv);
  const pendingFile=path.join(dir,'pending-source.enc.json');fs.writeFileSync(pendingFile,JSON.stringify({enc:true,v:3,data:Buffer.concat([pendingIv,pendingCipher.update(JSON.stringify(blocked)),pendingCipher.final(),pendingCipher.getAuthTag()]).toString('base64')}));
  await assert.rejects(prepareIbManagerReturn({...args,file:pendingFile}));
  const mismatch=fixture();mismatch.periodReturnsInput.from='2026-08-30';fs.writeFileSync(inputFile,JSON.stringify(mismatch));await assert.rejects(prepareIbManagerReturn({...args,outputFile:path.join(dir,'refused.json'),execute:true}));assert.equal(fs.existsSync(path.join(dir,'refused.json')),false);
});

test('daily drawdown path uses the gross engine flow timing and preserves old monthly receipts',async()=>{
  const source=fixture(),ret=await buildIbManagerReturnReceipt(source),dd=await buildIbManagerDrawdownReceipt(source),consumer=createIbManagerDrawdownConsumer();
  assert.deepEqual(dd.dailyFactors.map(p=>p.factor),[1,1,.9]);
  assert.equal(dd.anchorDate,'2026-08-30');assert.equal(dd.returnReceiptId,ret.receiptId);
  assert.equal((await consumer.project(dd,ret,feeView(ret))).state,'verified');
  assert.equal((await core.project(ret,feeView(ret))).state,'verified');
  assert.equal((await consumer.project(null,ret,feeView(ret))).state,'pending');
  const withdrawal=fixture();withdrawal.periodReturnsInput.points[1].tot=50;withdrawal.periodReturnsInput.points[2].tot=45;withdrawal.periodReturnsInput.flowByDate['2026-09-01']=-50;
  assert.deepEqual((await buildIbManagerDrawdownReceipt(withdrawal)).dailyFactors,dd.dailyFactors,'securities transferred out are external flows, not drawdown');
  assert.doesNotMatch(JSON.stringify(dd),/openT|flowByDate|quantity|accountId|portfolioId|\"tot\"|\"amount\"/);
});
test('daily path integrity, calendar, return binding and common period fail closed',async()=>{
  const source=fixture(),ret=await buildIbManagerReturnReceipt(source),dd=await buildIbManagerDrawdownReceipt(source),consumer=createIbManagerDrawdownConsumer();
  for(const mutate of [x=>x.dailyFactors.pop(),x=>x.dailyFactors[1].d='2026-09-02',x=>x.dailyFactors[1].factor=-1,x=>x.returnReceiptId='a'.repeat(64),x=>x.sourceInputsHash='b'.repeat(64),x=>x.anchorDate='2026-08-31',x=>x.asOf='2026-09-03']){
    const bad=structuredClone(dd);mutate(bad);const{receiptId,...body}=bad;bad.receiptId=await core.digest(body);assert.equal((await consumer.project(bad,ret,feeView(ret))).state,'pending');
  }
  const wrongMonth=structuredClone(dd);wrongMonth.dailyFactors[2].factor=.8;const{receiptId,...body}=wrongMonth;wrongMonth.receiptId=await core.digest(body);assert.equal((await consumer.validate(wrongMonth,ret)).ok,false);
  const changed=feeView(ret);changed.asOf='2026-09-03';assert.equal((await consumer.project(dd,ret,changed)).state,'pending');
  const file=process.env.FEE_LEDGER_TEST_INDEX||new URL('../index.html',import.meta.url),html=fs.readFileSync(file,'utf8'),start='/* ib-manager-drawdown-consumer:start */',end='/* ib-manager-drawdown-consumer:end */';
  if(html.includes(start))assert.equal(html.slice(html.indexOf(start)+start.length,html.indexOf(end)).trim(),createIbManagerDrawdownConsumer.toString());
});

test('a shorter comparison window links the monthly TWR already shown; the default view is untouched',()=>{
  const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8'),box={};vm.createContext(box);
  vm.runInContext(`const esc=v=>String(v??'');const pct=v=>v==null||!isFinite(v)?'—':(v>0?'+':'')+(v*100).toFixed(2)+'%';const sgn=v=>v>0?'pos':v<0?'neg':'';const ibManagerReturnNote=()=>'';`,box);
  vm.runInContext(html.slice(html.indexOf('function renderReturnComparison('),html.indexOf('/* compact-comparison-tables:end */')),box);
  const month=(ym,rG,spy,qqq,ib)=>({ym,from:ym+'-01',to:ym+'-28',rG,rB:spy===undefined?{}:{spy,qqq},ib});
  const rows=[month('2025-11',.10,.05,.02,.01),month('2025-12',-.05,.01,.03,.02),month('2026-01',.02,.04,-.01,.03),month('2026-02',.03,-.02,.05,-.04),month('2026-03',.01,.03,.01,.05)];
  const st={twrG:.9,mwrD:.8,rows,bench:[{k:'spy',twr:.7},{k:'qqq',twr:.6}],ibManager:{state:'verified',value:.5,byMonth:Object.fromEntries(rows.map(r=>[r.ym,r.ib]))}},before=structuredClone(st);
  const cell=(out,key)=>out.match(new RegExp('<tr data-return-series="'+key+'"[^]*?</tr>'))[0].match(/<b class="metric-value[^"]*">([^<]*)<\/b>/)[1];
  const view=key=>{vm.runInContext('_returnWindow='+JSON.stringify(key),box);return box.renderReturnComparison(st);};
  // Default: the receipt totals, exactly as before, plus the chips. 今年 (3 months) repeats 近3个月, so only one is offered.
  const all=view('all');
  assert.deepEqual(['actual','investor','ib','spy','qqq'].map(k=>cell(all,k)),['+90.00%','+80.00%','+50.00%','+70.00%','+60.00%']);
  assert.deepEqual([...all.matchAll(/data-return-window="(\w+)" aria-selected="(\w+)">([^<]+)</g)].map(m=>m.slice(1)),[['all','true','全部'],['ytd','false','今年'],['month','false','本月']]);
  assert.doesNotMatch(all,/return-window-note/);
  // 今年 = Jan..Mar linked: (1.02)(1.03)(1.01)-1, and the same for each benchmark and for Jenny's IB.
  const ytd=view('ytd'),link=v=>{const x=v.reduce((a,b)=>a*(1+b),1)-1;return (x>0?'+':'')+(x*100).toFixed(2)+'%';};
  assert.deepEqual(['actual','ib','spy','qqq'].map(k=>cell(ytd,k)),[link([.02,.03,.01]),link([.03,-.04,.05]),link([.04,-.02,.03]),link([-.01,.05,.01])]);
  // Modified Dietz is not linked from months. These rows carry no flow figures, so the window shows — (see the next test).
  assert.equal(cell(ytd,'investor'),'—');assert.doesNotMatch(ytd,/仅全部期间/);
  assert.match(ytd,/2026-01-01 → 2026-03-28 · 由月度 TWR 逐月连乘/);assert.match(ytd,/data-return-window="ytd" aria-selected="true"/);
  assert.equal(cell(view('month'),'actual'),'+1.00%');
  // A month without a benchmark figure, or an impossible one, makes that window unknown rather than a partial product.
  st.rows[3].rB={};assert.equal(cell(view('ytd'),'spy'),'—');assert.equal(cell(view('ytd'),'actual'),link([.02,.03,.01]));
  st.rows[3].rG=-1;assert.equal(cell(view('ytd'),'actual'),'—');st.rows[3]=before.rows[3];
  // A window that is not on offer falls back to 全部; one month of history offers no chips at all; nothing is mutated.
  assert.equal(cell(view('m3'),'actual'),'+90.00%');
  assert.deepEqual(st,before);
  const single={...st,rows:rows.slice(-1)};assert.doesNotMatch(box.renderReturnComparison(single),/return-windows/);
  const none={...st};delete none.rows;vm.runInContext('_returnWindow="ytd"',box);assert.equal(cell(box.renderReturnComparison(none),'actual'),'+90.00%');
  // Pending Jenny's IB stays 待核对 in every window.
  vm.runInContext('_returnWindow="ytd"',box);assert.match(box.renderReturnComparison({...st,ibManager:{state:'pending',value:null,byMonth:{}}}).match(/<tr data-return-series="ib"[^]*?<\/tr>/)[0],/待核对/);
});

// Owner 2026-11-18: the investor row was empty in the shorter windows.
test('Modified Dietz for a window is rebuilt from each month\'s own denominator and equals the direct calculation',()=>{
  const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8'),box={};vm.createContext(box);
  vm.runInContext(`const esc=v=>String(v??'');const pct=v=>v==null||!isFinite(v)?'—':(v>0?'+':'')+(v*100).toFixed(2)+'%';const sgn=v=>v>0?'pos':v<0?'neg':'';const ibManagerReturnNote=()=>'';`,box);
  vm.runInContext(html.slice(html.indexOf('function renderReturnComparison('),html.indexOf('/* compact-comparison-tables:end */')),box);
  const days=(a,b)=>Math.round((Date.parse(b)-Date.parse(a))/864e5)+1;
  // A month built the way fee-engine.mjs builds it: opening plus each flow weighted by the days left after it.
  const month=(from,to,open,flows,close,fees)=>{const d=days(from,to);let den=open,flow=0;for(const [date,amount] of flows){den+=amount*((d-days(from,date))/d);flow+=amount;}
    return {ym:from.slice(0,7),from,to,days:d,openT:open,closeT:close,flowT:flow,den,pnl:close-open-flow,fees,rD:(close-open-flow-fees)/den,rG:.01,rB:{},flows};};
  const rows=[month('2026-08-01','2026-08-31',1000,[['2026-08-10',200]],1250,3),month('2026-09-01','2026-09-30',1250,[['2026-09-20',-100],['2026-09-05',50]],1300,4),month('2026-10-01','2026-10-31',1300,[],1280,2),month('2026-11-01','2026-11-17',1280,[['2026-11-17',-30]],1300,1)];
  const direct=part=>{const from=part[0].from,span=days(from,part.at(-1).to);let den=part[0].openT,net=0;for(const r of part){for(const [date,amount] of r.flows)den+=amount*((span-days(from,date))/span);net+=r.pnl-r.fees;}return net/den;};
  for(const part of [rows,rows.slice(1),rows.slice(-2),rows.slice(0,2)])assert.ok(Math.abs(box.windowDietz(part)-direct(part))<1e-12);
  assert.equal(box.windowDietz(rows.slice(-1)),rows[3].rD);
  // Months that are not consecutive, a missing figure or a non-positive denominator give no figure.
  assert.equal(box.windowDietz([rows[0],rows[2]]),null);assert.equal(box.windowDietz([{...rows[0],den:NaN},rows[1]]),null);
  assert.equal(box.windowDietz([{...rows[0],den:0},rows[1]]),null);assert.equal(box.windowDietz([]),null);assert.equal(box.windowDietz([{...rows[3],rD:undefined}]),null);
  // In the table: the default keeps the receipt total; a window shows the rebuilt figure and no longer says 仅全部期间.
  const st={twrG:.9,mwrD:.8,rows,bench:[],ibManager:null},cell=out=>out.match(/<tr data-return-series="investor"[^]*?<\/tr>/)[0].match(/<b class="metric-value[^"]*">([^<]*)<\/b>/)[1];
  const show=v=>(v>0?'+':'')+(v*100).toFixed(2)+'%',view=key=>{vm.runInContext('_returnWindow='+JSON.stringify(key),box);return box.renderReturnComparison(st);};
  assert.equal(cell(view('all')),'+80.00%');assert.equal(cell(view('m3')),show(direct(rows.slice(-3))));assert.equal(cell(view('month')),show(rows[3].rD));
  assert.match(view('m3'),/出资方按该期间的资金流重新加权/);assert.doesNotMatch(view('m3'),/仅全部期间/);
});

test('the holdings list shows up to five rows with their total; three-row history keeps its own title',()=>{
  const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8'),box={};vm.createContext(box);
  vm.runInContext(`const esc=v=>String(v??'');const usd=(v,d=2)=>'$'+Number(v).toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d});`,box);
  vm.runInContext(html.slice(html.indexOf('/* top-holdings-view:start */'),html.indexOf('/* top-holdings-view:end */')),box);
  const text=out=>out.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim(),five=[['A',300],['B',200],['C',100],['D',50],['E',25]].map(([ticker,value])=>({ticker,value}));
  assert.equal(text(box.topHoldingsView({stock:900,topHoldings:five},1000)),'前五大持仓 不含现金及其它 · 占总资产 1 A $300 30.0% 2 B $200 20.0% 3 C $100 10.0% 4 D $50 5.0% 5 E $25 2.5% 合计 $675 67.5%');
  assert.equal(text(box.topHoldingsView({stock:900,topHoldings:five.slice(0,3)},1000)),'前三大持仓 不含现金及其它 · 占总资产 1 A $300 30.0% 2 B $200 20.0% 3 C $100 10.0% 合计 $600 60.0%');
  assert.doesNotMatch(box.topHoldingsView({stock:900,topHoldings:five.slice(0,1)},1000),/合计/);
  assert.equal(box.topHoldingsView({stock:900,topHoldings:[...five,{ticker:'F',value:10}]},1000),'');
  assert.equal(box.topHoldingsView({stock:500,topHoldings:five},1000),'');
});
