// Synthetic offline test fixtures only; no production data or credentials.
import crypto from 'node:crypto';
import {runSharesightLedgerReport} from './sharesight_ledger_report.mjs';
import {LEDGER_PROFILE,profileBlob} from '../../scripts/xuan-ib-night-action-ledger-view.mjs';
import {extractNightActionModel} from '../../scripts/xuan-ib-night-action-view.mjs';
import {associationPolicyBlob} from '../../scripts/xuan-ib-account-association.mjs';
export const clock=Date.parse('2026-10-09T05:00:00.000Z'),stamp=new Date(clock).toISOString(),date='2026-10-09',sourceDate='2026-10-08';
const hash=v=>crypto.createHash('sha256').update(typeof v==='string'?v:JSON.stringify(v)).digest('hex');
export function fixture(){
 const config={schemaVersion:1,purpose:'xuan-preopen-report-profile',profile:LEDGER_PROFILE},text=JSON.stringify(config,null,2)+'\n';
 const policy={schemaVersion:1,policyId:'ib-primary-7day-pilot-v1',accountAlias:'IB-HK',basis:'owner-attested-recurring-v1',status:'active',purpose:'xuan-ib-read-only-report',editions:['adhoc','am','pm'],publisher:'codex-verified-candidate-v1',validFrom:'2026-09-11T13:30:00.000Z',expiresAt:'2026-10-10T13:30:00.000Z'};
 const context={association:{policy,policyCommit:'a'.repeat(40),policyBlob:associationPolicyBlob(policy),checkedAt:stamp},previousSourceSha:'b'.repeat(40),previousMeta:{dataDate:'2026-10-08'},previousHtml:'<span class="date">2026-10-08 · 睡前版</span>'};
 const profile={profile:LEDGER_PROFILE,profileBlob:profileBlob(text),context};
 const raw={mode:'read_only',source:'Sharesight User API',report:{portfolio_id:936247,currency:{code:'USD'},grouping:'custom_group_category',custom_group:{id:83569,name:'资产类别'},end_date:sourceDate,
  holdings:['美国底仓','美国科技','非美发达','新兴市场'].map((group_name,i)=>({id:i+1,group_name,value:[450,200,230,120][i],instrument:{code:['CSPX','GOOG','EXUS','EIMI'][i]}}))}};
 const calls=[],saved=[],now=()=>clock,loadProfile=async()=>structuredClone(profile);
 const fetchImpl=async(url,options)=>{calls.push({url:String(url),options});return new Response(JSON.stringify(raw));};
 const io={get ibStore(){throw Error('IB_STORE_MUST_NEVER_BE_TOUCHED');},loadGatewayToken:async()=>'SYNTHETIC-READ-TOKEN',savePrivate:async(name,value)=>{saved.push({name,value});return {sha256:hash(value),generation:'1'};}};
 return {config,text,context,profile,raw,calls,saved,now,loadProfile,fetchImpl,io,options:{sourceDate,io,now,loadProfile,fetchImpl}};
}
export async function prepared(f=fixture()){
 const receipt=await runSharesightLedgerReport(f.options),html=f.saved.find(s=>s.name.endsWith('/report.html')).value;
 return {f,html,receipt,model:extractNightActionModel(html)};
}
