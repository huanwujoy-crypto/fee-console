import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webcrypto } from 'node:crypto';
const root=process.env.FUND_UI_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const active=html.includes('fund-profile-storage:start') || html.includes('id=\"p-investors\"');
if(active) for(const name of ['fund-investor-core','fund-profile-storage','fund-investor-render']) {
 assert(html.includes(`/* ${name}:start */`) && html.includes(`/* ${name}:end */`), `active investor UI is missing ${name}`);
}
const test=(name,fn)=>nodeTest(name,{skip:!active},fn);
const region=name=>html.split(`/* ${name}:start */`)[1]?.split(`/* ${name}:end */`)[0];
const helper=html.slice(html.indexOf('const usd='),html.indexOf('/* fee-legacy-policy:start */'));
const viewLink=html.match(/^function viewLink\(\).*$/m)[0];
const synthetic={schema:'fee-console.fund-profile.v1',manager:'SYNTHETIC MANAGER',fundName:'SYNTHETIC FUND',inceptionDate:'2026-08-20',inceptionNoticeDate:'2026-08-21',currency:'USD',initialShares:1000,investors:[{id:'A',name:'ALPHA',shares:600},{id:'B',name:'BETA',shares:400}]};
function context(){
 const ctx=vm.createContext({crypto:webcrypto,TextEncoder,TextDecoder,atob:s=>Buffer.from(s,'base64').toString('binary'),btoa:s=>Buffer.from(s,'binary').toString('base64'),setTimeout,clearTimeout,URLSearchParams,URL});
 vm.runInContext(`const values=new Map(),elements=new Map();const store={};const K={gid:'gid',key:'key',tok:'tok'};const cfg=k=>values.get(k)||'';const setCfg=(k,v)=>{v?values.set(k,v):values.delete(k);};const isMgr=()=>!!cfg(K.tok);const HASH={fund:''};let _sourceEpoch=0;let _receiptSource={state:'verified'};const sourceMatches=()=>true;const document={getElementById:id=>{if(!elements.has(id))elements.set(id,{innerHTML:'',textContent:''});return elements.get(id);}};const location={origin:'https://synthetic.invalid',pathname:'/',search:'',hash:'',get href(){return this.origin+this.pathname+this.search+this.hash}};const history={replaceState(_state,_unused,url){const value=String(url);location.hash=value.includes('#')?value.slice(value.indexOf('#')):'';}};let DAILY={};async function render(){await readFundProfile();}setCfg(K.gid,'synthetic-gist-A');setCfg(K.key,'${Buffer.alloc(32,7).toString('base64url')}');setCfg(K.tok,'synthetic-manager-token');`,ctx);
 vm.runInContext(helper+region('fund-investor-core')+region('fund-profile-storage')+region('fund-investor-render')+viewLink,ctx);
 vm.runInContext(`globalThis.profile=${JSON.stringify(synthetic)};globalThis.fixtureFee={state:'verified',start:'2026-08-01',asOf:'2026-08-22',status:{provisional:false},benchmarkInputs:{flows:[]}};DAILY={flowsAuto:[],flowsUnresolved:[],daily:[{d:'2026-08-20',schwab:100,webull:50},{d:'2026-08-21',schwab:110,webull:70},{d:'2026-08-22',schwab:150,webull:100}]};`,ctx);
 return ctx;
}
const run=(ctx,code)=>vm.runInContext(code,ctx);
const importProfile=ctx=>run(ctx,'importFundProfile({size:100,text:async()=>JSON.stringify(profile)})');
test('synthetic import stores only authenticated encrypted data and preserves source',async()=>{
 const c=context();await importProfile(c);const raw=run(c,'cfg(FUND_PROFILE_KEY)');assert(raw);assert(!raw.includes('SYNTHETIC'));assert(!raw.includes('ALPHA'));assert.equal(JSON.parse(raw).enc,true);const read=await run(c,'readFundProfile()');assert.equal(read.profile.fundName,'SYNTHETIC FUND');assert.equal(run(c,'cfg(K.gid)'),'synthetic-gist-A');assert(!run(c,'viewLink()').includes('synthetic-manager-token'));
});
test('shared link carries encrypted profile and reader caches authenticated profile for standalone use',async()=>{
 const c=context();await importProfile(c);const raw=run(c,'cfg(FUND_PROFILE_KEY)');const reader=context();run(reader,`setCfg(K.tok,'');HASH.fund=${JSON.stringify(raw)};`);const loaded=await run(reader,'readFundProfile()');assert.equal(loaded.profile.investors[0].id,'A');assert.equal(run(reader,'cfg(FUND_PROFILE_KEY)'),raw);assert(!run(reader,'viewLink()').includes('ALPHA'));
});
test('reader import changes only encrypted local display configuration',async()=>{const c=context();run(c,"setCfg(K.tok,'')");await importProfile(c);assert(run(c,'cfg(FUND_PROFILE_KEY)'));assert.equal(run(c,'cfg(K.tok)'), '');assert.equal(run(c,'cfg(K.gid)'), 'synthetic-gist-A');assert.equal(run(c,'_receiptSource.state'), 'verified');});
test('wrong key, corrupt ciphertext, or wrong Gist cannot yield a profile',async()=>{
 for(const kind of ['key','cipher','gid']){const c=context();await importProfile(c);if(kind==='key')run(c,`setCfg(K.key,'${Buffer.alloc(32,8).toString('base64url')}')`);else if(kind==='gid')run(c,"setCfg(K.gid,'different-gist')");else run(c,"{const outer=JSON.parse(cfg(FUND_PROFILE_KEY));outer.data=outer.data.slice(0,-3)+'AAA';setCfg(FUND_PROFILE_KEY,JSON.stringify(outer));}");const loaded=await run(c,'readFundProfile()');assert.equal(loaded.profile,null,kind);assert(!run(c,'viewLink()').includes('&fund='),kind);}
});
test('configuration disappearance and restoration restores sharing ciphertext',async()=>{
 const c=context();await importProfile(c);const before=run(c,'_fundProfileCipher');run(c,"setCfg(K.gid,'')");await run(c,'readFundProfile()');run(c,"setCfg(K.gid,'synthetic-gist-A')");await run(c,'readFundProfile()');assert.equal(run(c,'_fundProfileCipher'),before);assert(run(c,'viewLink()').includes('&fund='));
});
test('mid-decryption source switch cannot show or share previous profile',async()=>{
 const c=context();await importProfile(c);const pending=run(c,`(()=>{_fundProfileCache=null;globalThis.readEntered=new Promise(resolve=>globalThis.signalReadEntered=resolve);const original=decTxt;decTxt=async(...args)=>{const blocked=new Promise(resolve=>globalThis.releaseRead=resolve);signalReadEntered();await blocked;return original(...args)};return readFundProfile();})()`);await run(c,'readEntered');run(c,"setCfg(K.gid,'different-gist');releaseRead()");const loaded=await pending;assert.equal(loaded.profile,null);assert(!run(c,'viewLink()').includes('&fund='));
});
test('mid-import source invalidation leaves stored profile unchanged',async()=>{
 const c=context();await importProfile(c);const before=run(c,'cfg(FUND_PROFILE_KEY)');const pending=run(c,'importFundProfile({size:100,text:()=>new Promise(resolve=>globalThis.releaseFile=()=>resolve(JSON.stringify(profile)))})');run(c,'_sourceEpoch++;releaseFile()');await pending;assert.equal(run(c,'cfg(FUND_PROFILE_KEY)'),before);assert.match(run(c,'_fundProfileMessage'),/未保存/);
});
test('new valid import preserves only the prior encrypted envelope',async()=>{
 const c=context();await importProfile(c);const before=run(c,'cfg(FUND_PROFILE_KEY)');run(c,"profile.fundName='SYNTHETIC SECOND'");await importProfile(c);assert.equal(run(c,'cfg(FUND_PROFILE_KEY+\".previous\")'),before);assert(!run(c,'cfg(FUND_PROFILE_KEY)').includes('SYNTHETIC SECOND'));
});
test('renderer escapes private profile strings and SVG has accessible description',()=>{
 const c=context();run(c,`profile.manager='<img src=x onerror=alert(1)>';profile.fundName='<script>bad()</script>';profile.investors[0].name='ALPHA <svg onload=bad()>';renderInvestors({profile},fixtureFee);`);const profileHtml=run(c,'elements.get("fundProfileBox").innerHTML');assert(!profileHtml.includes('<img'));assert(!profileHtml.includes('<script'));assert(!profileHtml.includes('<svg'));assert(profileHtml.includes('&lt;script&gt;'));const body=run(c,'elements.get("fundInvestorBox").innerHTML');assert.match(body,/role="img" aria-label="A 费用前/);assert.match(body,/>\$150\.00</);assert.match(body,/费用前/);
});
test('future unknown flow shows only last safe dated investor value',()=>{
 const c=context();run(c,`fixtureFee.benchmarkInputs.flows=[{date:'2026-08-22',amountCents:999999}];renderInvestors({profile},fixtureFee);`);const body=run(c,'elements.get("fundInvestorBox").innerHTML');assert.match(body,/最近可计算市值/);assert.match(body,/当前市值待核验/);assert.match(body,/历史市值仅截至 2026-08-21/);assert.match(body,/>\$108\.00</);assert(!body.includes('>2026-08-22</td>'));assert.match(body,/外部资金流|投资人归属/);
});
test('unverified receipt clears previous investor amounts and history',()=>{
 const c=context();run(c,'renderInvestors({profile},fixtureFee);fixtureFee.state="pending";renderInvestors({profile},fixtureFee);');const body=run(c,'elements.get("fundInvestorBox").innerHTML');assert(!body.includes('$150.00'));assert(!body.includes('<svg'));assert(!body.includes('<tbody>'));assert.match(body,/回执待验证|资产与资金流水/);
});
test('profile disappearance clears existing identity and investor valuation panels',()=>{
 const c=context();run(c,'renderInvestors({profile},fixtureFee);renderInvestors({profile:null,reason:"synthetic invalid"},fixtureFee)');assert.equal(run(c,'elements.get("fundInvestorBox").innerHTML'),'');assert(!run(c,'elements.get("fundProfileBox").innerHTML').includes('ALPHA'));
});

test('the latest selected profile wins when imports complete out of order',async()=>{
 const c=context();const first=run(c,`(()=>{const older=JSON.stringify(profile);return importFundProfile({size:100,text:()=>new Promise(resolve=>globalThis.releaseFirstImport=()=>resolve(older))});})()`);run(c,"profile.fundName='SYNTHETIC NEWEST'");await importProfile(c);run(c,'releaseFirstImport()');await first;const loaded=await run(c,'readFundProfile()');assert.equal(loaded.profile.fundName,'SYNTHETIC NEWEST');
});

test('simultaneous offsetting external flows still stop individual valuation',()=>{
 const c=context();run(c,`fixtureFee.benchmarkInputs.flows=[{date:'2026-08-22',amountCents:5000},{date:'2026-08-22',amountCents:-5000}];renderInvestors({profile},fixtureFee)`);const body=run(c,'elements.get("fundInvestorBox").innerHTML');assert.match(body,/最近可计算市值/);assert.match(body,/历史市值仅截至 2026-08-21/);assert(!body.includes('>2026-08-22</td>'));
});
test('exact missing inception date never borrows the following day',()=>{
 const c=context();run(c,'DAILY.daily.shift();renderInvestors({profile},fixtureFee)');const body=run(c,'elements.get("fundInvestorBox").innerHTML');assert(!body.includes('$108.00'));assert(!body.includes('<svg'));assert.match(body,/成立日|每日总资产不完整/);
});
test('non-profile fields cannot be smuggled through the imported display config',async()=>{
 const c=context();run(c,"profile.admin=true");await importProfile(c);assert.equal(run(c,'cfg(FUND_PROFILE_KEY)'),'');assert.match(run(c,'_fundProfileMessage'),/格式/);
});

test('unconfirmed post-inception external cash candidate stops individual valuation',()=>{
 const c=context();run(c,`DAILY.flowsAuto=[{id:'synthetic-pending-deposit',date:'2026-08-22',acct:'webull',amount:500,desc:'external cash deposit',reason:'description shows an external transfer',effective:false}];renderInvestors({profile},fixtureFee)`);const body=run(c,'elements.get("fundInvestorBox").innerHTML');assert.match(body,/最近可计算市值/);assert.match(body,/历史市值仅截至 2026-08-21/);assert(!body.includes('>2026-08-22</td>'));
});

test('importing a newer profile from an old fund link survives a synthetic reload',async()=>{
 const c=context();await importProfile(c);run(c,`HASH.fund=cfg(FUND_PROFILE_KEY);location.hash='#gid='+encodeURIComponent(cfg(K.gid))+'&k='+encodeURIComponent(cfg(K.key))+'&fund='+encodeURIComponent(HASH.fund);profile.fundName='SYNTHETIC RELOADED NEW';`);await importProfile(c);run(c,"HASH.fund=new URLSearchParams(location.hash.slice(1)).get('fund')||'';_fundProfileCache=null");const loaded=await run(c,'readFundProfile()');assert.equal(loaded.profile.fundName,'SYNTHETIC RELOADED NEW');
});
