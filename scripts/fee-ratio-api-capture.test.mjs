// Synthetic identifiers, names, amounts and credentials only. Every request
// below is answered by an in-memory stub; the real network is never reached.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import {runRatioApiCapture,RATIO_CAPTURE_BUDGET,RATIO_CAPTURE_CODES,RATIO_CAPTURE_STAGES,RATIO_CAPTURE_GROUPS,RATIO_CAPTURE_VIEW} from './fee-ratio-api-capture.mjs';
import {RATIO_SCHEDULE_CRON,RATIO_SCHEDULE_PREVIOUS,executeRatioCloud,validateRatioCapture,RATIO_BUCKET,RATIO_OWNER} from './fee-ratio-cloud-runtime.mjs';
import {validateRatioCloudPlan} from './fee-ratio-cloud-publish.mjs';
import {createRatioSourceCore} from './fee-ratio-source-core.mjs';
import {syntheticCapture} from './fee-ratio-api-source.test.mjs';
globalThis.fetch=async()=>{throw Error('OFFLINE_TEST_NETWORK_FORBIDDEN');};

const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const MAIN='a'.repeat(40),D='2026-11-10',NOW=new Date('2026-11-10T10:00:00.000Z'),API='https://api.sharesight.com',RUN='4242';
const SECRET='synthetic-client-secret-not-real',CLIENT='synthetic-client-id-not-real',TOKEN='synthetic-access-token-not-real-0123456789',STORAGE='synthetic-storage-token-not-real-0123456789';
const FEE={mainSha:'e'.repeat(40),accountingThrough:'2026-11-07',dataSha256:'1'.repeat(64),healthSha256:'2'.repeat(64)};
const PLAN=(extra={})=>({mode:'publish-api',previousBodySha256:'b'.repeat(64),asOf:D,fee:{...FEE},...extra});
// The shared synthetic report covers six of its ten members; give the other four a cash row so the report itself names all ten.
const base=()=>{const c=syntheticCapture();c.view.name=RATIO_CAPTURE_VIEW;c.group.name=c.report.custom_group.name=RATIO_CAPTURE_GROUPS.asset;const seen=new Set([...c.report.holdings,...c.report.cash_accounts].map(r=>r.portfolio.id));
  c.accounts.filter(a=>!seen.has(a.id)).forEach((a,i)=>{c.report.cash_accounts.push({...c.report.cash_accounts[0],id:7100+i,key:7100+i,value:6,portfolio:{id:a.id,consolidated:false,name:a.name}});c.report.value=Math.round(c.report.value*100+600)/100;});return c;};
const accounts=base().accounts,scopeSha=sha(JSON.stringify(accounts.map(a=>a.name).sort()));
const dispatch=(plan=PLAN(),extra={})=>{
  const text=JSON.stringify(plan),event={sender:{id:RATIO_OWNER},repository:{full_name:'huanwujoy-crypto/fee-console'},inputs:{ratio_main:MAIN,ratio_plan:text}};
  const env={GITHUB_ACTIONS:'true',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_RUN_ATTEMPT:'1',GITHUB_REF:'refs/heads/main',GITHUB_REPOSITORY:'huanwujoy-crypto/fee-console',GITHUB_ACTOR_ID:String(RATIO_OWNER),GITHUB_SHA:MAIN,GITHUB_RUN_ID:RUN,RATIO_PLAN:text,
    FEE_CLOUD_SHARESIGHT_CLIENT_ID:CLIENT,FEE_CLOUD_SHARESIGHT_CLIENT_SECRET:SECRET,RATIO_STORAGE_ACCESS_TOKEN:STORAGE,...extra};
  return {event,env};
};
const GROUP_IDS={asset:880,income:881,top:882,stock:883},STOCK=['美国底仓','美国科技','非美发达','新兴市场'],FUNDS=['VC/PE','对冲基金','常青基金'];
const GROUPING={asset:g=>g,income:g=>FUNDS.includes(g)?'Bucket '+FUNDS.indexOf(g):'Bucket other',top:()=>'Bucket all',stock:g=>STOCK.includes(g)?'Bucket equities':'Bucket rest'};
const route=(group,start,sales)=>`${API}/api/v3/portfolios/39000/performance?consolidated=true&custom_group_id=${GROUP_IDS[group]}&end_date=${D}&grouping=custom_group&include_limited=true&include_sales=${sales}&report_combined=false&start_date=${start}`;
function performanceReport(group,start,annualised){
  const r=base().report,asset=new Map(r.holdings.map(h=>[h.id,h.group_name]));
  r.start_date=start;r.include_sales=true;r.percentages_annualised=annualised;r.total_gain=321.5;r.total_gain_percent=4.25;r.custom_group={id:GROUP_IDS[group],name:RATIO_CAPTURE_GROUPS[group]};
  r.holdings=r.holdings.map((h,i)=>({...h,group_name:GROUPING[group](asset.get(h.id)),total_gain:10+i,total_gain_percent:1+i/8}));
  r.sub_totals=[...new Set(r.holdings.map(h=>h.group_name))].map((group_name,n)=>({group_id:9,group_name,value:50+n,total_gain:5+n,total_gain_percent:2+n/4}));
  r.cash_accounts=r.cash_accounts.map(c=>({...c,total_gain:null,total_gain_percent:null}));
  return r;
}
function routes(edit=()=>{}){
  const b=base(),holdingsOf=a=>b.report.holdings.filter(h=>h.portfolio.id===a.id),cashOf=a=>b.report.cash_accounts.filter(c=>c.portfolio.id===a.id);
  const r=new Map([
    [API+'/oauth2/token',{access_token:TOKEN,token_type:'Bearer'}],
    [API+'/api/v3/portfolios?consolidated=true',{portfolios:[{id:39000,name:RATIO_CAPTURE_VIEW,consolidated:true,currency_code:'USD'}]}],
    [API+'/api/v2/portfolios.json',{portfolios:[...accounts,{id:777,name:'Invented outsider'}]}],
    [API+'/api/v2/groups.json',{groups:Object.entries(RATIO_CAPTURE_GROUPS).map(([k,name])=>({id:GROUP_IDS[k],name}))}],
    [route('asset',D,false),{report:b.report}],
    ...accounts.map(a=>[`${API}/api/v3/portfolios/${a.id}/holdings?consolidated=false`,{holdings:holdingsOf(a).map(h=>({id:h.id,inception_date:'2020-03-04'}))}]),
    ...accounts.map(a=>[`${API}/api/v3/portfolios/${a.id}/trades.json?consolidated=false&end_date=${D}`,{trades:holdingsOf(a).map((h,i)=>({id:h.id*10,holding_id:h.id,transaction_date:'2020-03-04',description_code:i===0?'OPENING_BALANCE':'BUY',state:'confirmed'}))}]),
    ...accounts.map(a=>[`${API}/api/v2/portfolios/${a.id}/cash_accounts.json`,{cash_accounts:cashOf(a).map(c=>({id:c.id,name:c.name}))}]),
    ...b.report.cash_accounts.map(c=>[`${API}/api/v2/cash_accounts/${c.id}/cash_account_transactions.json?to=${D}`,{cash_account_transactions:[{id:c.id*10,date_time:'2019-05-06T00:00:00.000Z',amount:6}]}]),
    ...Object.keys(GROUP_IDS).flatMap(g=>[[route(g,'2019-05-06',true),{report:performanceReport(g,'2019-05-06',true)}],[route(g,'2025-11-10',true),{report:performanceReport(g,'2025-11-10',false)}]])]);
  edit(r,b);return r;
}
const UPLOAD='https://storage.googleapis.com/upload/storage/v1/b/'+RATIO_BUCKET+'/o?uploadType=media&name=';
function stub(map,{exists=false,refuse=null}={}){
  const calls=[],objects=new Map();let generation=100;
  const reply=(url,value,status=200)=>{const body=new TextEncoder().encode(JSON.stringify(value));let sent=false;
    return {url,status,redirected:false,ok:status===200,headers:{get:k=>k.toLowerCase()==='content-type'?'application/json':null},body:{getReader(){return {read:async()=>sent?{done:true}:(sent=true,{done:false,value:body}),cancel:async()=>{},releaseLock(){}};}}};};
  const fetchImpl=async(url,init)=>{
    calls.push({url,method:init.method,auth:init.headers.Authorization||null,redirect:init.redirect});
    if(url.startsWith(UPLOAD)){
      const name=decodeURIComponent(url.slice(UPLOAD.length).split('&')[0]);
      if(!url.endsWith('&ifGenerationMatch=0')||init.method!=='POST')throw new TypeError('unexpected upload');
      if(exists)return reply(url,{error:{code:412}},412);
      if(refuse)return reply(url,{error:{code:refuse,message:'Invented remote text with account 1234567'}},refuse);
      objects.set(name,Buffer.from(init.body));return reply(url,{bucket:RATIO_BUCKET,name,generation:String(++generation),size:String(init.body.length)});
    }
    if(!map.has(url))throw new TypeError('unexpected synthetic route');
    return reply(url,map.get(url));
  };
  return {fetchImpl,calls,objects};
}
const run=async(map=routes(),{plan,env,stubOptions,scope=scopeSha}={})=>{
  const s=stub(map,stubOptions),d=dispatch(plan,env);
  const result=await runRatioApiCapture({env:d.env,event:d.event,now:NOW,clock:()=>NOW.getTime(),fetchImpl:s.fetchImpl,...(scope===null?{}:{expectedScopeSha256:scope})});
  return {result,...s,...d};
};
const leakFree=result=>{const text=JSON.stringify(result);for(const secret of [SECRET,CLIENT,TOKEN,STORAGE,'Synthetic','IB-HK','TQQQ','39000','2020-03-04'])assert.equal(text.includes(secret),false,secret);};

test('one capture reads fixed routes, builds an API original with performance and pins both objects create-only',async()=>{
  const {result,calls,objects}=await run();
  assert.deepEqual([result.status,result.stage,result.code],['CAPTURED','COMPLETE',null]);
  // token + 3 discovery + classification + 10 holdings + 10 trades + 10 cash lists + one ledger per cash account + 8 reports + 2 uploads
  const expected=1+3+1+10+10+10+base().report.cash_accounts.length+8+2;assert.equal(result.requests,expected);assert.equal(calls.length,expected);
  assert.deepEqual(calls.filter(c=>c.method!=='GET').map(c=>[c.method,c.url.split('?')[0]]),[['POST',API+'/oauth2/token'],['POST',UPLOAD.split('?')[0]],['POST',UPLOAD.split('?')[0]]]);
  assert.equal(calls.every(c=>c.redirect==='error'),true);
  // The Sharesight token never goes to storage, and the storage token never goes to Sharesight.
  assert.equal(calls.filter(c=>c.url.startsWith(API)).every(c=>c.auth===null||c.auth==='Bearer '+TOKEN),true);assert.equal(calls.filter(c=>c.url.startsWith(UPLOAD)).every(c=>c.auth==='Bearer '+STORAGE),true);
  const original=objects.get(result.original.name),input=objects.get(result.input.name);
  assert.deepEqual([result.original.sha256,result.input.sha256,result.bundleId],[sha(original),sha(input),sha(Buffer.concat([original,input]))]);
  assert.match(result.original.name,/^inputs\/[a-f0-9]{64}\/original\.json$/);assert.equal(objects.size,2);
  const raw=JSON.parse(original),prepared=JSON.parse(input);
  assert.deepEqual([raw.schemaVersion,raw.allocation.schemaVersion,raw.allocation.source.transport,raw.performance.transport,prepared.schema],['sharesight-private-performance-v1','sharesight-api-full-v1','official-api','official-api','fee-console.ratio-sources.v3']);
  assert.deepEqual(raw.performance.reports.map(r=>[r.period,r.startDate,r.endDate]),[['all','2019-05-06',D],['oneYear','2025-11-10',D]]);
  assert.equal(raw.performance.topHoldings.targets.length,20);assert.equal(raw.performance.inceptionEvidence.members.some(m=>m.dateKind==='holding-opening-balance'),true);
  assert.equal(prepared.book.sourceSha256,sha(original));
  // What it pinned passes the same association check the publication step repeats.
  const facts=createRatioSourceCore(names=>sha(JSON.stringify(names.map(s=>s.replaceAll('&amp;','&')).sort()))).verifyBrowserSourceAssociations(raw,prepared,{scopeHash:scopeSha,now:NOW});
  assert.deepEqual(facts.sourceDates,{classification:D,exposure:D,performance:D});
  assert.doesNotMatch(original.toString(),/libfile_|workbook|xlsx|mtime/i);
  // The result is hashes and generations only, bound to this plan, main and run.
  leakFree(result);validateRatioCapture(result,{planSha256:result.planSha256,mainSha:MAIN,runId:RUN});
  assert.throws(()=>validateRatioCapture(result,{planSha256:result.planSha256,mainSha:MAIN,runId:'1'}));assert.throws(()=>validateRatioCapture({...result,extra:1}));assert.throws(()=>validateRatioCapture({...result,original:{...result.original,name:'inputs/x/original.json'}}));
});

test('the capture step refuses any publication secret, a different plan mode, a stale date and the real scope mismatch before a request',async()=>{
  for(const key of ['FEE_RATIO_MANAGER_TOKEN','FEE_DATA_KEY','FEE_ECON_GIST_ID','GITHUB_TOKEN','GH_TOKEN','NODE_OPTIONS']){const r=await run(routes(),{env:{[key]:'x'}});assert.deepEqual([r.result.status,r.result.stage,r.result.code,r.calls.length],['REFUSED','ADMISSION','RATIO_CAPTURE_ENVIRONMENT',0],key);}
  for(const env of [{GOOGLE_APPLICATION_CREDENTIALS:'/tmp/x'},{RATIO_STORAGE_ACCESS_TOKEN:''},{FEE_CLOUD_SHARESIGHT_CLIENT_SECRET:undefined},{GITHUB_RUN_ID:'x'}]){const r=await run(routes(),{env});assert.equal(r.result.code,'RATIO_CAPTURE_ENVIRONMENT');assert.equal(r.calls.length,0);}
  const verify=await run(routes(),{plan:{mode:'verify-current',previousBodySha256:'b'.repeat(64),bundleId:null,original:null,input:null,library:null,fee:null}});
  assert.deepEqual([verify.result.code,verify.calls.length],['RATIO_CAPTURE_PLAN',0]);
  for(const asOf of ['2026-11-05','2026-11-11']){const r=await run(routes(),{plan:PLAN({asOf})});assert.deepEqual([r.result.code,r.calls.length],['RATIO_CAPTURE_TARGET_DATE',0],asOf);}
  const other=await run(routes(),{env:{GITHUB_ACTOR_ID:'1'}});assert.deepEqual([other.result.code,other.calls.length],['RATIO_CLOUD_RUNTIME_REFUSED',0]);
  // Invented account names never match the reviewed ten-account scope: without the test override it stops at the first report.
  const scope=await run(routes(),{scope:null});assert.deepEqual([scope.result.stage,scope.result.code,scope.objects.size],['CLASSIFICATION','RATIO_CAPTURE_SCOPE',0]);
  for(const plan of [{...PLAN(),library:null},{...PLAN(),asOf:'2026-02-30'},{...PLAN(),fee:{}},{...PLAN(),fee:false},{mode:'publish-api',previousBodySha256:'b'.repeat(64),asOf:D}])assert.throws(()=>validateRatioCloudPlan(plan),/RATIO_CLOUD_REFUSED/);
  // The handoff is optional; the key is not.
  validateRatioCloudPlan({...PLAN(),fee:null});
  validateRatioCloudPlan(PLAN());
});

test('each stage stops with its own fixed code, never retries, and never uploads a partial result',async()=>{
  const cases=[
    [r=>r.set(API+'/oauth2/token',{access_token:'short',token_type:'Bearer'}),'TOKEN','RATIO_CAPTURE_AUTH_RESPONSE'],
    [r=>{r.get(API+'/api/v3/portfolios?consolidated=true').portfolios[0].name='Renamed';},'VIEWS','RATIO_CAPTURE_VIEW_IDENTITY'],
    [r=>{r.get(API+'/api/v2/groups.json').groups.pop();},'GROUPS','RATIO_CAPTURE_GROUP_IDENTITY'],
    [r=>{r.get(route('asset',D,false)).report.limited=true;},'CLASSIFICATION','RATIO_CAPTURE_INCOMPLETE'],
    [r=>{r.get(route('asset',D,false)).report.holdings[0].value=10.005;},'CLASSIFICATION','RATIO_API_SOURCE_HOLDING_VALUE'],
    [r=>{r.get(API+'/api/v2/portfolios.json').portfolios.shift();},'CLASSIFICATION','RATIO_CAPTURE_MEMBERS'],
    [r=>{r.delete(`${API}/api/v3/portfolios/${accounts[3].id}/holdings?consolidated=false`);},'HOLDINGS','RATIO_CAPTURE_TRANSPORT'],
    [r=>{r.get(`${API}/api/v3/portfolios/${accounts[0].id}/trades.json?consolidated=false&end_date=${D}`).links={next:'x'};},'TRADES','RATIO_CAPTURE_INCOMPLETE'],
    [r=>{r.get(`${API}/api/v2/portfolios/${accounts[0].id}/cash_accounts.json`).cash_accounts.push({name:'no id'});},'CASH','RATIO_CAPTURE_SHAPE'],
    [r=>{r.set(route('income','2019-05-06',true),{report:null});},'PERFORMANCE','RATIO_CAPTURE_SHAPE'],
    // A stock grouping whose sub-total is not exactly the four stock classes.
    [r=>{for(const s of ['2019-05-06','2025-11-10']){const rep=r.get(route('stock',s,true)).report;rep.holdings.find(h=>h.group_name==='Bucket rest'&&h.instrument.code==='TQQQ').group_name='Bucket equities';}},'BUILD','RATIO_API_PERFORMANCE_STOCK'],
    // A listed first-buy date that is not the earliest confirmed record.
    [r=>{r.get(`${API}/api/v3/portfolios/${accounts[0].id}/trades.json?consolidated=false&end_date=${D}`).trades[0].transaction_date='2020-01-01';},'BUILD','RATIO_API_PERFORMANCE_INCEPTION']];
  for(const [edit,stage,code]of cases){
    const {result,objects,calls}=await run(routes(edit));
    assert.deepEqual([result.status,result.stage,result.code,result.bundleId,objects.size],['REFUSED',stage,code,null,0],code);assert.ok(RATIO_CAPTURE_CODES.includes(result.code));
    assert.equal(new Set(calls.map(c=>c.url)).size,calls.length,'no request is repeated');leakFree(result);
  }
  const exists=await run(routes(),{stubOptions:{exists:true}});
  assert.deepEqual([exists.result.status,exists.result.stage,exists.result.code,exists.result.original],['REFUSED','UPLOAD','RATIO_CAPTURE_OBJECT_EXISTS',null]);
  // A refused upload is named by the service's numeric code only; an unlisted status is a transport refusal with value-free facts.
  for(const [status,code]of [[401,'UPLOAD_UNAUTHORIZED'],[403,'UPLOAD_FORBIDDEN'],[400,'UPLOAD_BAD_REQUEST'],[404,'UPLOAD_NOT_FOUND']]){
    const r=await run(routes(),{stubOptions:{refuse:status}});assert.deepEqual([r.result.status,r.result.stage,r.result.code,r.objects.size],['REFUSED','UPLOAD','RATIO_CAPTURE_'+code,0]);leakFree(r.result);assert.equal(JSON.stringify(r.result).includes('remote text'),false);
  }
  const odd=stub(routes(),{refuse:500}),d=dispatch();let seen=null;
  const failed=await runRatioApiCapture({env:d.env,event:d.event,now:NOW,clock:()=>NOW.getTime(),fetchImpl:odd.fetchImpl,expectedScopeSha256:scopeSha,onTransport:t=>{seen=t;}});
  assert.deepEqual([failed.stage,failed.code],['UPLOAD','RATIO_CAPTURE_TRANSPORT']);assert.deepEqual(Object.keys(seen).sort(),['category','kind','phase']);assert.equal(seen.kind,'HTTP');
  assert.equal(new Set(RATIO_CAPTURE_CODES).size,RATIO_CAPTURE_CODES.length);assert.equal(RATIO_CAPTURE_STAGES.at(-1),'COMPLETE');assert.equal(RATIO_CAPTURE_BUDGET.requests>=1+3+1+30+RATIO_CAPTURE_BUDGET.cashAccounts+8+2,true);
  const source=fs.readFileSync(new URL('./fee-ratio-api-capture.mjs',import.meta.url),'utf8');
  assert.doesNotMatch(source,/child_process|method:'(?:PUT|PATCH|DELETE)'|gist\.github|api\.github/);assert.equal((source.match(/method:'POST'/g)||[]).length,2,'the token exchange and the create-only upload');
});

test('a scheduled capture needs no operator plan and binds its result to the derived plan of that run',async()=>{
  const at=new Date('2026-11-11T01:00:05.000Z'),s=stub(routes()),d=dispatch();
  const env={...d.env,GITHUB_EVENT_NAME:'schedule',RATIO_PLAN:'',FEE_RATIO_AUTO_ENABLED:'true',RATIO_SCHEDULE:RATIO_SCHEDULE_CRON,FEE_REPORT_MARKETS:'NYSE,NASDAQ,LSE'};delete env.GITHUB_ACTOR_ID;
  const event={schedule:RATIO_SCHEDULE_CRON};
  const result=await runRatioApiCapture({env,event,now:at,clock:()=>at.getTime(),fetchImpl:s.fetchImpl,expectedScopeSha256:scopeSha});
  assert.deepEqual([result.status,result.stage,result.code],['CAPTURED','COMPLETE',null]);
  // The same derived plan the publication step computes: the previous Hong Kong date, no handoff, the placeholder previous body.
  const derived=JSON.stringify({mode:'publish-api',previousBodySha256:RATIO_SCHEDULE_PREVIOUS,asOf:D,fee:null});
  assert.equal(result.planSha256,sha(Buffer.from(derived)));assert.equal(result.mainSha,MAIN);assert.equal(result.runId,RUN);
  // Not opted in, another slot, or a day without a session: refused at admission before any request.
  for(const [e,ev,t] of [[{...env,FEE_RATIO_AUTO_ENABLED:'false'},event,at],[env,{schedule:'30 3 * * *'},at],[{...env,RATIO_SCHEDULE:'30 3 * * *'},event,at],[env,event,new Date('2026-11-09T01:00:00.000Z')],[{...env,RATIO_PLAN:JSON.stringify(PLAN())},event,at]]){
    const quiet=stub(routes()),r=await runRatioApiCapture({env:e,event:ev,now:t,clock:()=>t.getTime(),fetchImpl:quiet.fetchImpl,expectedScopeSha256:scopeSha});
    assert.equal(r.status,'REFUSED');assert.equal(r.requests,0);assert.equal(quiet.calls.length,0);assert.equal(quiet.objects.size,0);
  }
});
test('the publication step completes a publish-api plan only from the same run\'s capture and then follows the ordinary publish path',async()=>{
  const {result:capture}=await run(),d=dispatch();
  const env={...d.env,GITHUB_TOKEN:'synthetic-repository-token-not-real-123',FEE_ECON_GIST_ID:'0'.repeat(32),FEE_DATA_KEY:Buffer.alloc(32,7).toString('base64url'),FEE_RATIO_MANAGER_TOKEN:'synthetic-manager-token-not-real-123',RATIO_STORAGE_ACCESS_TOKEN:STORAGE};
  delete env.FEE_CLOUD_SHARESIGHT_CLIENT_ID;delete env.FEE_CLOUD_SHARESIGHT_CLIENT_SECRET;
  const fetchImpl=async url=>{const r=new Response(JSON.stringify({object:{sha:MAIN}}),{status:200});Object.defineProperty(r,'url',{value:url});return r;};
  const publish=async readCapture=>{
    const seen=[],saved=[];
    const result=await executeRatioCloud({env,event:d.event,fetchImpl,saveReceipt:async v=>{saved.push(v);},readCapture,
      publisher:{run:async({plan})=>{seen.push(plan);return {schema:'fee-console.ratio-cloud-safe-result.v1',status:'PUBLISHED_CONFIRMED',stage:'COMPLETE',claim:'OWNED',patchAttempts:1,bodySha256:'c'.repeat(64),contentSha256:'d'.repeat(64),cleanup:'LOCAL_AND_PINNED_INPUTS'};}}});
    return {result,seen};
  };
  const ok=await publish(async()=>structuredClone(capture));
  assert.equal(ok.result.status,'PUBLISHED_CONFIRMED');
  assert.deepEqual(ok.seen,[{mode:'publish',previousBodySha256:'b'.repeat(64),bundleId:capture.bundleId,original:capture.original,input:capture.input,library:null,fee:FEE}]);
  // No capture, a refused capture, or one from another run, main or plan: the publisher is never reached.
  for(const bad of [undefined,async()=>{throw Error('missing');},async()=>({...capture,runId:'1'}),async()=>({...capture,mainSha:'b'.repeat(40)}),async()=>({...capture,planSha256:'0'.repeat(64)}),
    async()=>({...capture,status:'REFUSED',stage:'UPLOAD',code:'RATIO_CAPTURE_TRANSPORT',bundleId:null,original:null,input:null}),async()=>({...capture,bundleId:'f'.repeat(64)})]){
    const r=await publish(bad);assert.deepEqual([r.result.status,r.result.stage,r.seen.length],['REFUSED','PLAN',0]);
  }
  // The preflight needs neither the capture nor any financial credential.
  const pre=await executeRatioCloud({env:{...d.env,GITHUB_TOKEN:'synthetic-repository-token-not-real-123'},event:d.event,fetchImpl,saveReceipt:async()=>{},preflight:true});
  assert.deepEqual(pre,{preflight:true,mode:'publish-api',due:true});
});
