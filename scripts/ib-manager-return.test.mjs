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

test('the risk desk folds leveraged products into their underlying and finds the margin-call distance',()=>{
  const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8'),box={};vm.createContext(box);
  vm.runInContext(`const esc=v=>String(v??'');const usd=(v,d=2)=>(v<0?'-$':'$')+Math.abs(Number(v)).toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d});`,box);
  vm.runInContext(html.slice(html.indexOf('/* risk-desk:start */'),html.indexOf('/* risk-desk:end */'))+';globalThis.riskDeskModel=riskDeskModel;globalThis.riskDeskView=riskDeskView;globalThis.riskDeskCarry=riskDeskCarry;globalThis.riskDeskCarryHint=riskDeskCarryHint;',box);
  const defs=[{id:'schwab',name:'Schwab'},{id:'webull',name:'Webull'}],near=(a,b)=>assert.ok(Math.abs(a-b)<1e-6,`${a} vs ${b}`);
  const lp={d:'2026-11-18',schwab:600000,webull:400000,riskBook:{schemaVersion:1,accounts:{
    schwab:{cash:20000,holdings:[{ticker:'GOOG',value:300000},{ticker:'AVGO',value:280000}]},
    webull:{cash:-200000,holdings:[{ticker:'VST',value:200000},{ticker:'TQQQ',value:150000},{ticker:'NVDL',value:100000},{ticker:'GGLL',value:80000},{ticker:'VSTL',value:70000}]}}}};
  // Ordinary securities at 25%, leveraged products at 60%, whatever their multiple.
  const P={maint:.25,levMaint:.6},m=box.riskDeskModel(lp,defs,{...P,shock:-.2});
  near(m.nav,1000000);near(m.gross,1180000);near(m.exposure,1730000);near(m.borrowed,200000);near(m.economicLeverage,1.73);
  assert.deepEqual(JSON.parse(JSON.stringify(m.unders.map(u=>[u.under,u.direct,u.levered,u.exposure]))),
    [['GOOG/GOOGL',300000,80000,460000],['QQQ',0,150000,450000],['VST',200000,70000,340000],['AVGO',280000,0,280000],['NVDA',0,100000,200000]]);
  // Every security down 20%: 3x and 2x products fall 60% and 40%.
  near(m.scenario.pnl,-346000);assert.equal(m.margin.length,1);
  const w=m.margin[0];near(w.loan,200000);near(w.leverage,1.5);near(w.equityAfter,170000);
  near(w.requiredAfter,160000*.25+(60000+60000+48000+42000)*.6);near(w.excessAfter,170000-166000);assert.equal(w.fix,null);
  near(w.excessNow,400000-200000*.25-400000*.6);
  // The reported distance is exactly where equity meets the requirement.
  const at=box.riskDeskModel(lp,defs,{...P,shock:-w.callDrop}).margin[0];assert.ok(Math.abs(at.excessAfter)<1e-3);assert.ok(w.callDrop>.2&&w.callDrop<.21);
  // A shortfall is measured against maintenance; the remedies restore the higher initial requirement.
  const deep=box.riskDeskModel(lp,defs,{...P,shock:-.3}).margin[0];near(-deep.excessAfter,140000*.25+(15000+40000+32000+28000)*.6-55000);
  const gap=140000*.3125+115000*(.6/.9)-55000;near(deep.initialAfter-deep.equityAfter,gap);
  near(deep.fix.deposit,gap);near(deep.fix.sellPlain,gap/(.3125+.6875*.3));near(deep.fix.sellLevered,gap/(.6/.9+(1-.6/.9)*.9));assert.equal(deep.fix.levMult,3);
  const after=change=>{const c=structuredClone(lp);change(c);const a=box.riskDeskModel(c,defs,{...P,shock:-.3}).margin[0];return a.initialAfter-a.equityAfter;};
  assert.ok(Math.abs(after(c=>{c.webull+=gap;c.riskBook.accounts.webull.cash+=gap;}))<1e-6);
  assert.ok(Math.abs(after(c=>{const s=deep.fix.sellPlain;c.riskBook.accounts.webull.holdings[0].value-=s;c.riskBook.accounts.webull.cash+=s;}))<1e-6);
  assert.ok(Math.abs(after(c=>{const s=deep.fix.sellLevered;c.riskBook.accounts.webull.holdings[1].value-=s;c.riskBook.accounts.webull.cash+=s;}))<1e-6);
  // One underlying only: its leveraged product moves with it, nothing else does.
  const one=box.riskDeskModel(lp,defs,{shock:-.5,scope:'VST'});near(one.scenario.pnl,-170000);assert.equal(one.scope,'VST');
  assert.equal(box.riskDeskModel(lp,defs,{shock:-.5,scope:'NOPE'}).scope,'all');
  // A product never loses more than its value; the shock and the assumptions are bounded.
  near(box.riskDeskModel(lp,defs,{shock:-.6}).scenario.pnl,-(580000*.6+200000*.6+150000+250000+0));
  const bounded=box.riskDeskModel(lp,defs,{shock:-9,maint:.01,levMaint:7,rate:9});near(bounded.shock,-.6);near(bounded.maint,.25);near(bounded.levMaint,1);near(bounded.rate,.3);
  // Defaults: 40% ordinary, 66% leveraged, 4.75% financing.
  const d=box.riskDeskModel(lp,defs,{});near(d.maint,.4);near(d.levMaint,.66);near(d.rate,.0475);near(d.interest.annual,9500);
  near(d.margin[0].excessNow,400000-200000*.4-400000*.66);
  // No financing: no margin account, and the text says so.
  const cashOnly=structuredClone(lp);cashOnly.riskBook.accounts.webull.cash=5000;
  const none=box.riskDeskModel(cashOnly,defs,{shock:-.3});assert.equal(none.margin.length,0);near(none.borrowed,0);
  const text=out=>out.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
  assert.match(text(box.riskDeskView(cashOnly,defs,{})),/距追缴 无融资/);
  assert.match(text(box.riskDeskView(lp,defs,{...P,shock:-.3})),/融资额 \$200,000 Webull 账户杠杆 1\.50× 距追缴 标普跌 1\d\.\d% 各标的同跌则为 20\.\d%.*保证金缺口 \$49,000.*入金或还款 \$65,417 现在减持普通股票约 \$126,104 现在减持 3 倍杠杆产品约 \$67,672/);
  // Anything unusable shows the waiting note rather than a figure.
  for(const change of [c=>{delete c.riskBook;},c=>{c.riskBook.schemaVersion=2;},c=>{delete c.riskBook.accounts.schwab;},c=>{c.riskBook.accounts.extra={cash:0,holdings:[]};},
    c=>{c.riskBook.accounts.webull.cash='x';},c=>{c.riskBook.accounts.webull.holdings[0].value=-1;},c=>{c.riskBook.accounts.webull.holdings[0].ticker='<b>';},c=>{c.webull=NaN;},c=>{c.schwab=0;c.webull=0;}]){
    const c=structuredClone(lp);change(c);assert.equal(box.riskDeskModel(c,defs,{}),null);assert.match(box.riskDeskView(c,defs,{}),/下一次每日发布自动带入/);
  }
  // S&P 500 scenario: each underlying moves by its beta, leveraged products by beta times the multiple, floored at -100%.
  const sp=box.riskDeskModel(lp,defs,{...P,shock:-.1,scope:'spx'});assert.equal(sp.scope,'spx');
  near(sp.spxBeta,(300000*1.1+280000*1.5+200000*1.4+150000*3*1.2+100000*2*1.9+80000*2*1.1+70000*2*1.4)/1000000);near(sp.scenario.pnl,-232200);
  assert.deepEqual([...sp.unknownBeta],[]);
  const sw=sp.margin[0];assert.ok(sw.callDropSpx>0&&sw.callDropSpx<sw.callDrop);
  assert.ok(Math.abs(box.riskDeskModel(lp,defs,{...P,shock:-sw.callDropSpx,scope:'spx'}).margin[0].excessAfter)<1e-3);
  near(box.riskDeskModel(lp,defs,{shock:-.5,scope:'spx'}).scenario.pnl,-(300000*.55+280000*.75+200000*.7+150000+100000+80000+70000));
  const odd=structuredClone(lp);odd.riskBook.accounts.schwab.holdings.push({ticker:'ZZZQ',value:1000},{ticker:'BRK/B',value:1000});
  const om=box.riskDeskModel(odd,defs,{shock:-.1,scope:'spx'});assert.deepEqual([...om.unknownBeta],['ZZZQ']);
  near(om.scenario.pnl-sp.scenario.pnl,-(1000*.1+1000*.07));
  const spView=text(box.riskDeskView(odd,defs,{scope:'spx'}));assert.match(spView,/标普500 每变动 1%，组合约变动 2\.3%/);assert.match(spView,/按 1\.0 处理：ZZZQ。/);
  assert.match(box.riskDeskView(lp,defs,{scope:'spx'}),/<option value="spx" selected>标普500 指数<\/option>/);
  // Carry line: the gap to the high-water mark, the move that closes it in the chosen scope, and the Carry a scenario adds.
  const fee={cum:-50000,hwm:100000,rate:.2},flat=box.riskDeskCarry(lp,defs,box.riskDeskModel(lp,defs,{scope:'spx'}),fee);
  near(flat.gap,150000);near(flat.short,150000);near(flat.carry,0);near(flat.need,150000/2322000);assert.equal(flat.needPct,7);
  const up=box.riskDeskCarry(lp,defs,box.riskDeskModel(lp,defs,{scope:'spx',shock:.07}),fee);near(up.cumAfter,-50000+162540);near(up.carry,12540*.2);near(up.short,0);
  const even=box.riskDeskCarry(lp,defs,box.riskDeskModel(lp,defs,{scope:'all'}),fee);near(even.need,150000/1730000);assert.equal(even.needPct,9);
  assert.equal(box.riskDeskCarry(lp,defs,box.riskDeskModel(lp,defs,{scope:'spx'}),{cum:-900000,hwm:100000,rate:.2}).needPct,44);
  near(box.riskDeskCarry(lp,defs,box.riskDeskModel(lp,defs,{shock:-.1}),{cum:120000,hwm:120000,rate:.2}).need,0);
  for(const bad of [null,undefined,{cum:null,hwm:1,rate:.2},{cum:1,hwm:NaN,rate:.2},{cum:1,hwm:2,rate:0}])assert.equal(box.riskDeskCarry(lp,defs,sp,bad),null);
  const withFee=box.riskDeskView(lp,defs,{scope:'spx',shock:.07},fee);
  assert.match(text(withFee),/距 Carry 起算线还差 \$150,000 ，按当前选择约需 \+7% （点按即模拟）。.*累计毛收益（模拟后） \+\$112,540 新增 Carry（按 20%） \$2,508/);
  assert.match(withFee,/<button type="button" class="risk-link" data-risk-shock="7">\+7%<\/button>/);
  assert.match(text(box.riskDeskView(lp,defs,{scope:'spx'},fee)),/距 Carry 起算线 还差 \$150,000/);
  assert.match(text(box.riskDeskView(lp,defs,{scope:'spx'},{cum:-900000,hwm:100000,rate:.2})),/约需上涨 44%，超出滑块范围/);
  assert.match(text(box.riskDeskView(lp,defs,{},{cum:5,hwm:5,rate:.2})),/已在 Carry 起算线之上，再上涨的部分按 20% 计提 Carry/);
  // Without a verified fee statement the card says nothing about Carry.
  assert.match(box.riskDeskView(lp,defs,{}),/id="riskCarry" hidden><\/p>/);assert.doesNotMatch(text(box.riskDeskView(lp,defs,{shock:.1})),/累计毛收益（模拟后）/);
  // The card is for every viewer of the page, read-only links included: it must not depend on the manager token.
  const render=html.slice(html.indexOf('function renderRiskDesk(st,feeView){'),html.indexOf('function riskDeskInput(event){'));
  assert.ok(render.includes('show=!!lp;'));assert.ok(!render.includes('isMgr'));
});

test('the month-end payable estimate adds the remaining management fee and the Carry a move would bring',()=>{
  const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8'),box={};vm.createContext(box);
  vm.runInContext("const esc=v=>String(v??'');const usd=(v,d=2)=>(v<0?'-$':'$')+Math.abs(Number(v)).toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d});",box);
  vm.runInContext(html.slice(html.indexOf('/* payable-forecast:start */'),html.indexOf('/* payable-forecast:end */'))+';globalThis.M=payableForecastModel;globalThis.V=payableForecastView;',box);
  const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-6,a+' vs '+b),text=out=>out.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
  const input={asOf:'2026-11-18',nav:1000000,due:4000,cum:-50000,hwm:100000,hwmBefore:100000,mgmtRate:.02,carryRate:.2,baseShare:1};
  // Twelve days are left in November; a flat month adds only the management fee.
  const flat=box.M(input,0);assert.equal(flat.days,12);assert.equal(flat.monthEnd,'2026-11-30');near(flat.mgmt,12*1000000*.02/365);near(flat.carry,0);near(flat.short,150000);near(flat.dueEnd,4000+flat.mgmt);
  // A gain past the high-water mark adds Carry on the excess; the fee base follows the average of the path.
  const up=box.M(input,.2);near(up.pnl,200000);near(up.mgmt,12*1000000*1.1*.02/365);near(up.carry,50000*.2);near(up.dueEnd,4000+up.mgmt+10000);
  near(box.M({...input,baseShare:.5},0).mgmt,flat.mgmt/2);near(box.M(input,.9).move,.2);near(box.M(input,-.9).move,-.2);
  // The month in progress can lose Carry it has accrued so far, but never more than that.
  const ahead={...input,cum:130000,hwm:130000,hwmBefore:100000};near(box.M(ahead,-.01).carry,-10000*.2);near(box.M(ahead,-.2).carry,-30000*.2);near(box.M(ahead,.01).carry,10000*.2);
  near(box.M({...input,hwmBefore:undefined},.2).carry,10000);
  assert.equal(box.M({...input,asOf:'2026-11-30'},0).days,0);assert.equal(box.M({...input,asOf:'2028-02-10'},0).monthEnd,'2028-02-29');
  for(const bad of [null,{},{...input,asOf:'x'},{...input,nav:0},{...input,due:NaN},{...input,hwm:null},{...input,mgmtRate:-1}]){assert.equal(box.M(bad,0),null);}
  assert.equal(box.V(null),'');
  assert.match(text(box.V(flat)),/月底预估 到月底组合涨跌 0% 剩余 12 天管理费 \$658 新增 Carry 无（距起算线还差 \$150,000） 2026-11-30 应付约 \$4,658 方向性估算/);
  assert.match(text(box.V(up)),/\+20% 剩余 12 天管理费 \$723 新增 Carry（按 20%） \$10,000 2026-11-30 应付约 \$14,723/);
  assert.match(text(box.V(box.M(ahead,-.2))),/本月 Carry 减少 −\$6,000/);
  assert.match(box.V(flat),/<input class="risk-range" id="balMove" type="range" min="-20" max="20" step="1" value="0"/);
  // The estimate reads the verified statement only and is never shown while the payable figure is withheld.
  const wire=html.slice(html.indexOf('function renderBalForecast('),html.indexOf('/* day-brief:start */'));
  assert.match(wire,/feeView\?\.state==="verified"&&B&&!G\?\.hold&&st\?\.hwm!=null/);assert.doesNotMatch(wire,/fetch\(|store\b|DB\./);
});

test('the daily brief states margin-call distance, the Carry line and the payable figure, each jumping to its card',()=>{
  const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8'),box={};vm.createContext(box);
  vm.runInContext("const esc=v=>String(v??'').replace(/</g,'&lt;');const usd=(v,d=2)=>(v<0?'-$':'$')+Math.abs(Number(v)).toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d});",box);
  vm.runInContext(html.slice(html.indexOf('/* day-brief:start */'),html.indexOf('/* day-brief:end */'))+';globalThis.I=dayBriefItems;globalThis.V=dayBriefView;',box);
  const text=out=>out.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim(),plain=v=>JSON.parse(JSON.stringify(v));
  const risk=drop=>({borrowed:200000,margin:[{callDropSpx:.3},{callDropSpx:drop}]}),carry={gap:150000,rate:.2,needPct:7},pay={dueNow:4000,dueEnd:4658,days:12};
  const all=plain(box.I({risk:risk(.132),carry,pay}));
  assert.deepEqual(all.map(i=>[i.jump,i.lab,i.tone]),[['riskDesk','追缴','warn'],['riskDesk','Carry',''],['balBox','应付','']]);
  assert.equal(text(box.V(all,'2026-11-18')),'今日要点 · 数据日 2026-11-18 追缴 标普再跌 13.2% 触发 ，融资 $200,000 › Carry 距起算线还差 $150,000 ，约需标普 +7% › 应付 现在 $4,000 ，持平到月底约 $4,658 ›');
  assert.match(box.V(all,'2026-11-18'),/<button type="button" class="brief-row" data-jump="balBox">/);
  // The tone follows the distance; the nearest account decides.
  assert.equal(box.I({risk:risk(.05)})[0].tone,'bad');assert.equal(box.I({risk:risk(.25)})[0].tone,'ok');
  // call-alert:v1 — inside 25% the line is tinted; at 25% or beyond, and on the other lines, it is not.
  assert.equal(box.I({risk:risk(.22)})[0].tone,'warn');assert.equal(box.I({risk:risk(.22)})[0].alert,true);assert.equal(box.I({risk:risk(.05)})[0].alert,true);assert.equal(box.I({risk:risk(0)})[0].alert,true);
  assert.equal(Object.hasOwn(box.I({risk:risk(.25)})[0],'alert'),false);assert.deepEqual(all.map(i=>i.alert===true),[true,false,false]);
  assert.match(box.V(all,'2026-11-18'),/<button type="button" class="brief-row brief-alert" data-jump="riskDesk">/);assert.equal(box.V(all,'2026-11-18').split('brief-alert').length,2);
  assert.doesNotMatch(box.V(plain(box.I({risk:risk(.3),carry,pay})),'2026-11-18'),/brief-alert/);
  assert.equal(box.I({risk:risk(0)})[0].head,'已低于维持保证金');
  assert.equal(box.I({risk:{borrowed:5,margin:[{callDropSpx:null}]}})[0].head,'不会触发');
  assert.equal(box.I({risk:{borrowed:0,margin:[]}})[0].head,'无融资');
  assert.equal(box.I({carry:{gap:0,rate:.2,needPct:0}})[0].head,'已在起算线之上');
  assert.equal(box.I({carry:{gap:9,rate:.2,needPct:null}})[0].tail,'');
  assert.equal(box.I({pay:{dueNow:1,dueEnd:1,days:0}})[0].tail,'本月已到月底');
  // Nothing usable: the card stays empty and hidden.
  assert.deepEqual(plain(box.I({})),[]);assert.deepEqual(plain(box.I(null)),[]);assert.equal(box.V([],'x'),'');
  // It only rereads models the other cards already built, and the overview chip returns to the top where it sits.
  const wire=html.slice(html.indexOf('function renderDayBrief(){'),html.indexOf('function renderFees('));
  assert.match(wire,/scope:"spx",shock:0/);assert.doesNotMatch(wire,/fetch\(|setItem|location|history\./);
  assert.match(html,/<div class="card brief" id="briefBox" hidden><\/div>\n  <div class="kpis" id="kpis"><\/div>/);
  assert.match(html,/if\(target\.id==='kpis'\)\{globalThis\.scrollTo\?\.\(\{top:0,behavior:'smooth'\}\);return;\}/);
});

test('the month strip shows each month as a bar, marks Carry months and selects a month on tap',()=>{
  const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8'),box={};vm.createContext(box);
  vm.runInContext("const esc=v=>String(v??'').replace(/</g,'&lt;');const usd=(v,d=2)=>(v<0?'-$':'$')+Math.abs(Number(v)).toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d});",box);
  vm.runInContext(html.slice(html.indexOf('/* month-strip:start */'),html.indexOf('/* month-strip:end */'))+';globalThis.S=monthStripView;',box);
  const months=[{ym:'2026-11',pnl:-40000,carry:0,inProgress:true},{ym:'2026-08',pnl:100000,carry:20000},{ym:'2026-10',pnl:-5000,carry:0},{ym:'2026-09',pnl:0,carry:0}];
  const out=box.S(months,'2026-10'),picks=[...out.matchAll(/data-month-pick="([\d-]+)" aria-pressed="(true|false)" aria-label="([^"]+)"/g)].map(m=>[m[1],m[2],m[3]]);
  // Oldest on the left whatever order the rows arrive in; the selected month is pressed.
  assert.deepEqual(picks,[['2026-08','false','2026-08，毛收益 +$100,000，计提 Carry $20,000'],['2026-09','false','2026-09，毛收益 $0'],['2026-10','true','2026-10，毛收益 -$5,000'],['2026-11','false','2026-11，毛收益 -$40,000，进行中']]);
  // Bars scale to the largest month, with a visible minimum; a flat month draws none; only Carry months carry the dot.
  assert.deepEqual([...out.matchAll(/class="bar (up|down)" style="height:([\d.]+)px"/g)].map(m=>[m[1],Number(m[2])]),[['up',23],['down',2],['down',9]]);
  assert.equal(out.split('class="carry"').length-1,1);assert.match(out,/<span class="m">8月<\/span>/);
  // At most twelve months, the most recent ones; fewer than two months is not a strip.
  const many=Array.from({length:15},(_,i)=>({ym:'20'+(25+Math.floor(i/12))+'-'+String(i%12+1).padStart(2,'0'),pnl:i+1,carry:0}));
  const shown=[...box.S(many,'x').matchAll(/data-month-pick="([\d-]+)"/g)].map(m=>m[1]);assert.equal(shown.length,12);assert.equal(shown[0],'2025-04');assert.equal(shown.at(-1),'2026-03');
  assert.equal(box.S([months[0]],'2026-11'),'');assert.equal(box.S(null,'x'),'');assert.equal(box.S([{ym:'bad',pnl:1},{ym:'2026-01',pnl:NaN}],'x'),'');
  // Tapping only changes which month the page shows.
  assert.match(html,/closest\?\.\("\[data-month-pick\]"\)\?\.getAttribute\("data-month-pick"\);if\(\/\^\\d\{4\}-\(\?:0\[1-9\]\|1\[0-2\]\)\$\/\.test\(String\(ym\|\|""\)\)&&ym!==_monthHistoryYm\)\{_monthHistoryYm=ym;scheduleRender\(\);\}/);
  assert.match(html,/box\.innerHTML=`\$\{monthStripView\(model\.months,r\.ym\)\}<div class="history-tools">/);
});

test('the investor scenario applies the fund-wide S&P scenario to one investor by share',()=>{
  const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8'),box={};vm.createContext(box);
  vm.runInContext("const esc=v=>String(v??'').replace(/</g,'&lt;');const usd=(v,d=2)=>(v<0?'-$':'$')+Math.abs(Number(v)).toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d});",box);
  vm.runInContext(html.slice(html.indexOf('/* risk-desk:start */'),html.indexOf('/* risk-desk:end */'))+html.slice(html.indexOf('/* investor-scenario:start */'),html.indexOf('/* investor-scenario:end */'))+';globalThis.R=riskDeskModel;globalThis.M=investorScenarioModel;globalThis.V=investorScenarioView;',box);
  const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-6,a+' vs '+b),text=out=>out.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
  const defs=[{id:'schwab',name:'Schwab'},{id:'webull',name:'Webull'}];
  const lp={d:'2026-11-18',schwab:600000,webull:400000,riskBook:{schemaVersion:1,accounts:{
    schwab:{cash:20000,holdings:[{ticker:'GOOG',value:300000},{ticker:'AVGO',value:280000}]},
    webull:{cash:-200000,holdings:[{ticker:'VST',value:200000},{ticker:'TQQQ',value:150000},{ticker:'NVDL',value:100000},{ticker:'GGLL',value:80000},{ticker:'VSTL',value:70000}]}}}};
  const who={id:'A',date:'2026-11-18',share:.25,value:250000},P={maint:.25,levMaint:.6,scope:'spx'};
  // A quarter of the fund takes a quarter of the fund-wide result.
  const down=box.M(who,box.R(lp,defs,{...P,shock:-.1}));near(down.delta,-232200*.25);near(down.after,250000-58050);near(down.fundPct,-.2322);near(down.beta,2.322);
  assert.equal(down.financed,true);assert.ok(down.callDrop>0&&down.callDrop<.2);assert.equal(down.called,false);
  const flat=box.M(who,box.R(lp,defs,{...P,shock:0}));near(flat.delta,0);near(flat.after,250000);
  assert.equal(box.M(who,box.R(lp,defs,{...P,shock:-.3})).called,true);
  for(const bad of [null,{...who,share:0},{...who,share:1.2},{...who,share:null},{...who,value:NaN},{...who,value:0}])assert.equal(box.M(bad,box.R(lp,defs,P)),null);
  assert.equal(box.M(who,null),null);assert.equal(box.V(null),'');
  const view=box.V(down);
  assert.match(text(view),/情景模拟 标普500 每变动 1%，基金约变动 2\.3%；标普再跌 1\d\.\d% 时基金的融资账户会被追缴。 标普500 涨跌 -10% .* A 的市值变动 -\$58,050（-23\.2%） 模拟后市值 · 费用前 \$191,950 方向性估算，数据日 2026-11-18/);
  assert.match(view,/<input class="risk-range" id="invShock" type="range" min="-50" max="30" step="1" value="-10"/);assert.match(view,/data-inv-shock="10">\+10%<\/button>/);
  assert.match(text(box.V(box.M(who,box.R(lp,defs,{...P,shock:-.3})))),/这个跌幅下基金的融资账户会被追缴/);
  const calm=structuredClone(lp);calm.riskBook.accounts.webull.cash=5000;assert.match(text(box.V(box.M(who,box.R(calm,defs,P)))),/基金当前没有融资/);
  // Shown only when the risk snapshot is the same fund on the same day as the share valuation; the fund page block itself stays independent.
  const wire=html.slice(html.indexOf('function renderInvestorScenario('),html.indexOf('function investorScenarioInput('));
  assert.match(wire,/ctx\.date===_riskPoint\.d&&Math\.abs\(risk\.nav-total\)<=risk\.nav\*\.005/);
  assert.match(html,/if\(typeof renderInvestorScenario==="function"\)renderInvestorScenario\(\{id:investor\.id,date:last\?\.date,share:held&&latestShares\?held\.shares\/latestShares:null,valueCents:held\?\.valueCents,totalCents:last\?\.totalCents\}\);/);
});

test('the payments page shows how much of the accrued fee is paid and offers a draft for the amount due',()=>{
  const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8'),box={};vm.createContext(box);
  vm.runInContext("const esc=v=>String(v??'').replace(/</g,'&lt;');const usd=(v,d=2)=>(v<0?'-$':'$')+Math.abs(Number(v)).toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d});",box);
  vm.runInContext(html.slice(html.indexOf('/* fee-progress:start */'),html.indexOf('/* fee-progress:end */'))+';globalThis.M=feeProgressModel;globalThis.V=feeProgressView;',box);
  const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-9,a+' vs '+b),text=out=>out.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim(),plain=v=>JSON.parse(JSON.stringify(v));
  const m=box.M({accrued:29000,paid:25000,due:4000.004,asOf:'2026-11-18'});near(m.share,25000/29000);
  assert.deepEqual(plain(m.fill),{amount:'4000.00',note:'截至 2026-11-18 应付费用'});
  assert.equal(text(box.V(m)),'已付 $25,000 ／ 累计费用 $29,000 （86%） 应付 $4,000');assert.match(box.V(m),/class="fill" style="width:86\.2%"/);
  // Fully paid or overpaid: nothing to draft, and the bar never runs past the end.
  const over=box.M({accrued:29000,paid:30000,due:-1000,asOf:'2026-11-18'});near(over.share,1);assert.equal(over.fill,null);assert.match(text(box.V(over)),/（100%） 多付 \$1,000/);
  assert.equal(box.M({accrued:100,paid:100,due:0,asOf:'2026-11-18'}).fill,null);near(box.M({accrued:0,paid:0,due:0,asOf:'2026-11-18'}).share,0);
  // Withheld or unusable figures show nothing.
  for(const bad of [null,{accrued:1,paid:1,due:NaN,asOf:'2026-11-18'},{accrued:1,paid:0,due:1,asOf:'x'},{accrued:1,paid:0,due:1,asOf:'2026-11-18',hold:true}])assert.equal(box.M(bad),null);
  assert.equal(box.V(null),'');
  // The one-tap entry is an ordinary draft row through the same guarded path as a manual one, and locks with the other edit controls.
  assert.match(html,/if\(T\.id==="btnAddFeeDue"\)\{const fill=_feeDueFill;if\(fill\)changeDraft\(d=>d\.fees\.push\(\{id:crypto\.randomUUID\(\),date:todayStr\(\),amount:fill\.amount,ccy:"USD",fx:"",note:fill\.note\}\)\);return;\}/);
  assert.match(html,/#btnAddFee,#btnAddFeeDue,\[data-delfee\]/);assert.match(html,/<button class="btn" id="btnAddFeeDue" hidden><\/button>/);
});

// fund-hurdle:v1 (owner request 2026-11-28). Synthetic figures only.
test('the fund hurdle table compares each annualised fund return with an assumed stand-in plus a premium',()=>{
  const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8'),block=html.slice(html.indexOf('/* fund-hurdle:start */'),html.indexOf('/* fund-hurdle:end */')),box={};vm.createContext(box);
  const memory=new Map();box.store={getItem:k=>memory.has(k)?memory.get(k):null,setItem:(k,v)=>memory.set(k,String(v))};
  vm.runInContext("const esc=v=>String(v??'').replace(/&/g,'&amp;').replace(/</g,'&lt;');"+block+';globalThis.P=fundHurdleParams;globalThis.X=fundHurdleProxy;globalThis.M=fundHurdleModel;globalThis.V=fundHurdleView;',box);
  const plain=v=>JSON.parse(JSON.stringify(v)),a=plain(box.P());
  assert.deepEqual(a,{stock:8,cash:4,credit:6.5,premium:2.5});
  // The stand-in follows the class and the first field of the name.
  assert.deepEqual(plain(box.X('对冲基金','多策略',a)),{label:'四成股票＋六成现金',pct:5.6});
  assert.deepEqual(plain(box.X('常青基金','私募债',a)),{label:'高收益债',pct:6.5});
  assert.deepEqual(plain(box.X('常青基金','基建',a)),{label:'股票与高收益债各半',pct:7.25});
  assert.deepEqual(plain(box.X('常青基金','私募二级 Secondary',a)),{label:'全球股票',pct:8});
  const items=[{cls:'常青基金',strategy:'软件PE',name:'Fund <A>',since:'2024-04',pct:12,status:'annualised'},{cls:'常青基金',strategy:'私募债',name:'Fund B',since:'2024-02',pct:5,status:'annualised'},
    {cls:'常青基金',strategy:'基建',name:'Fund C',since:'2026-03',pct:30,status:'under-one-year'},{cls:'常青基金',strategy:'地产',name:'Fund D',since:'',pct:NaN,status:'none'},{cls:'常青基金',strategy:'软件PE',name:'Fund E',since:'2025-01',pct:10.5,status:'annualised'}];
  const m=plain(box.M(items,a));
  assert.deepEqual(m.rows.map(r=>[r.name,r.hurdle,r.gap]),[['Fund <A>',10.5,1.5],['Fund E',10.5,0],['Fund B',9,-4]]);
  assert.deepEqual([m.above,m.young,m.blank],[2,1,1]);
  const view=box.V(box.M(items,a),a),text=view.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ');
  assert.match(text,/已满一年的 3 笔中，2 笔不低于门槛；另有 1 笔未满一年，1 笔暂无年化收益率，未比较。/);
  assert.match(view,/<td class="risk-ok">\+1\.50<\/td>/);assert.match(view,/<td class="risk-ok">\+0\.00<\/td>/);assert.match(view,/<td class="risk-bad">−4\.00<\/td>/);
  assert.match(view,/Fund &lt;A>/);assert.doesNotMatch(view,/Fund C|Fund D|NaN|undefined/);
  assert.match(text,/仅供比较，不构成买卖建议。/);assert.equal(view.split('data-hurdle="').length,5);
  // fund-hurdle:v2 — without every lot's amount there is no value reading, and no amount line.
  assert.equal(m.value,null);assert.doesNotMatch(view,/fund-hurdle-whole|fund-hurdle-amount/);
  {const worth=[300,100,50,25,600],priced=items.map((it,i)=>({...it,amount:worth[i]})),official={pct:9.4,annualised:true};
    const pm=plain(box.M(priced,a,official)),pv=box.V(box.M(priced,a,official),a),pt=pv.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ');
    // Compared 300+100+600; at or above the hurdle 300+600; not compared 50+25. The weighted hurdle is (10.5*900+9*100)/1000.
    assert.deepEqual([pm.value.compared,pm.value.above,pm.value.rest],[1000,900,75]);assert.equal(pm.value.aboveShare,.9);
    assert.ok(Math.abs(pm.value.hurdle-10.35)<1e-9);assert.ok(Math.abs(pm.value.gap-(-.95))<1e-9);assert.ok(Math.abs(pm.value.restShare-75/1075)<1e-12);
    assert.match(pt,/按市值 90\.0% 不低于门槛 已比较 \$1,000，其中 \$900；未比较 \$75，占本类持仓 7\.0%/);
    assert.match(pt,/本类整体 9\.40% 对 10\.35%\s+−0\.95 左：Sharesight 本类年化，含已平仓；右：各笔门槛按市值加权/);assert.match(pv,/<i class="risk-bad">−0\.95<\/i>/);
    assert.equal(pv.split('fund-hurdle-amount').length,4);assert.match(pv,/<small class="fund-hurdle-amount">\$300<\/small>/);
    // The fund returns themselves are never averaged: no weighted return appears anywhere in the model.
    assert.deepEqual(Object.keys(pm.value).sort(),['above','aboveShare','compared','gap','hurdle','official','rest','restShare']);
    // fund-hurdle:v3 — a class figure whose report does not say whether it is annualised is shown, marked, and left uncoloured.
    {const off={pct:9.4,annualised:false,unspecified:true},x=plain(box.M(priced,a,off)),xv=box.V(box.M(priced,a,off),a);
      assert.equal(x.value.official,9.4);assert.equal(x.value.unspecified,true);assert.ok(Math.abs(x.value.gap-(-.95))<1e-9);
      assert.match(xv,/9\.40% 对 10\.35%　<i>−0\.95<\/i>/);assert.match(xv,/左：Sharesight 本类收益率，含已平仓，原报表未注明是否年化；右：各笔门槛按市值加权/);
      assert.equal(Object.hasOwn(pm.value,'unspecified'),false);assert.doesNotMatch(pv,/未注明是否年化；右/);}
    // A class figure that is not annualised, or absent, is not compared; the weighted hurdle still shows.
    for(const off of [null,{pct:9.4,annualised:false},{pct:9.4,annualised:false,unspecified:false},{pct:NaN,annualised:true},{pct:NaN,annualised:false,unspecified:true}]){const x=plain(box.M(priced,a,off));assert.equal(Object.hasOwn(x.value,'official'),false);assert.match(box.V(box.M(priced,a,off),a),/加权门槛 10\.35%/);}
    // One missing amount anywhere leaves the value reading out rather than understating a side.
    assert.equal(box.M(priced.map((it,i)=>i===2?{...it,amount:NaN}:it),a,official).value,null);assert.equal(box.M(priced.map((it,i)=>i===0?{...it,amount:0}:it),a,official).value,null);}
  // Nothing to compare still shows the assumptions and says why.
  assert.match(box.V(box.M([items[2]],a),a),/暂无已满一年且有年化收益率的持仓（1 笔未满一年）。/);
  // Saved assumptions are read back; anything out of range falls back to the default.
  memory.set('fee-fund-hurdle-v1',JSON.stringify({stock:10,cash:-1,credit:'x',premium:99}));assert.deepEqual(plain(box.P()),{stock:10,cash:4,credit:6.5,premium:2.5});
  memory.set('fee-fund-hurdle-v1','{broken');assert.deepEqual(plain(box.P()),{stock:8,cash:4,credit:6.5,premium:2.5});
  // Display only: the block reaches no ledger, draft, publication or network, and never touches a status label.
  assert.doesNotMatch(block,/changeDraft|EDIT\.|saveLedger|fetch\(|ghApi|ratioCore|XMLHttpRequest|sendBeacon/);
});
