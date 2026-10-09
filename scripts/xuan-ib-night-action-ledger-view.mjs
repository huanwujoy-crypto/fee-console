// Explicit Sharesight readback only. It never certifies synchronization or cash.
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {planPreopen,hktDate} from '../cloud/xuan-preopen/calendar.mjs';
import {validateAssociationReceiptShape,validateAssociationReceipt} from './xuan-ib-account-association.mjs';
export const LEDGER_PROFILE='sharesight-ledger-view-v1';
export const PROFILE_PATH='claude/xuan-ib-preopen-report-profile-v1.json';
export const LEDGER_RECEIPT_MODE='private_sharesight_ledger_view';
const fail=code=>{throw Error('SHARESIGHT_LEDGER_'+code);};
const exact=(v,keys)=>v&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).sort().join('|')===keys.slice().sort().join('|');
const sha=v=>typeof v==='string'&&v.length===64&&/^[a-f0-9]{64}$/.test(v);
const gitSha=v=>typeof v==='string'&&v.length===40&&/^[a-f0-9]{40}$/.test(v);
const time=v=>typeof v==='string'&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
const date=v=>typeof v==='string'&&v.length===10&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&new Date(v+'T00:00:00Z').toISOString().slice(0,10)===v;
export const ledgerHash=v=>crypto.createHash('sha256').update(typeof v==='string'?v:JSON.stringify(v)).digest('hex');
export const profileBlob=text=>{const b=Buffer.from(text);return crypto.createHash('sha1').update(Buffer.from(`blob ${b.length}\0`)).update(b).digest('hex');};
export function validateReportProfile(config){
 if(!exact(config,['schemaVersion','purpose','profile'])||config.schemaVersion!==1||config.purpose!=='xuan-preopen-report-profile'||!['normal',LEDGER_PROFILE].includes(config.profile))fail('PROFILE');
 return config.profile;
}
export function trustedProfileAtAssociation(snapshot,{runGit=args=>execFileSync('git',args,{encoding:'utf8',timeout:45000,maxBuffer:16384})}={}){
 try{if(!gitSha(snapshot?.policyCommit))fail('TRUSTED_PROFILE_UNAVAILABLE');const text=runGit(['show',`${snapshot.policyCommit}:${PROFILE_PATH}`]);const config=JSON.parse(text);validateReportProfile(config);if(text!==JSON.stringify(config,null,2)+'\n')fail('PROFILE_ENCODING');return {profile:config.profile,profileBlob:profileBlob(text)};}catch{fail('TRUSTED_PROFILE_UNAVAILABLE');}
}
const caps={valuation:true,classification:true,sync:false,cash:false,trades:false,orders:false,buyingPower:false,holdingsDetails:false,returns:false,action:false};
export function validateLedgerView(m){
 if(!exact(m,['schemaVersion','mode','status','dataDate','sourceDate','captureStartedAt','captureCompletedAt','syncCompletion','cashReconciliation','capabilities','sourceKey','sourceHash','evidenceSha256','profileBlob','association','expiresAt','previousSourceSha','previousDataDate','allocation'])
   ||m.schemaVersion!==10||m.mode!==LEDGER_PROFILE||m.status!=='partial'||!date(m.dataDate)||!date(m.sourceDate)||m.sourceDate>=m.dataDate
   ||!time(m.captureStartedAt)||!time(m.captureCompletedAt)||m.syncCompletion!=='unverified'||m.cashReconciliation!=='pending'
   ||!exact(m.capabilities,Object.keys(caps))||Object.keys(caps).some(k=>m.capabilities[k]!==caps[k])
   ||m.sourceKey!=='sharesight.ibGroupedPerformance'||!sha(m.sourceHash)||!sha(m.evidenceSha256)||!gitSha(m.profileBlob)
   ||!gitSha(m.previousSourceSha)||!date(m.previousDataDate)||m.previousDataDate>m.dataDate||!time(m.expiresAt))fail('MODEL');
 const start=Date.parse(m.captureStartedAt),end=Date.parse(m.captureCompletedAt);
 if(end<start||end-start>300000||hktDate(start)!==m.dataDate||hktDate(end)!==m.dataDate)fail('TIME');
 const a=m.allocation,labels=['美国底仓','美国科技','非美发达','新兴市场'];
 const finite=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=1e12;
 if(!exact(a,['total','categories'])||!finite(a.total)||a.total<=0||!Array.isArray(a.categories)||a.categories.length!==4)fail('ALLOCATION');
 a.categories.forEach((r,i)=>{if(!exact(r,['label','marketValue','currentPct'])||r.label!==labels[i]||!finite(r.marketValue)||!finite(r.currentPct)||r.currentPct>100||Math.abs(r.currentPct-r.marketValue/a.total*100)>1e-8)fail('ALLOCATION');});
 if(Math.abs(a.categories.reduce((s,r)=>s+r.marketValue,0)-a.total)>0.001)fail('ALLOCATION');
 validateAssociationReceiptShape(m.association,{edition:'am',previousSourceSha:m.previousSourceSha});return m;
}
export function buildLedgerView({allocation,dataDate,sourceDate,startedAt,completedAt,sourceHash,profile,association,context}){
 const publicAllocation={total:allocation.total,categories:allocation.categories.map(({label,marketValue,currentPct})=>({label,marketValue,currentPct}))};
 const evidenceSha256=ledgerHash({allocation:publicAllocation,mode:LEDGER_PROFILE,dataDate,sourceDate,startedAt,completedAt,sourceHash,profileBlob:profile.profileBlob,association,previousSourceSha:context.previousSourceSha});
 return validateLedgerView({schemaVersion:10,mode:LEDGER_PROFILE,status:'partial',dataDate,sourceDate,captureStartedAt:startedAt,captureCompletedAt:completedAt,
  syncCompletion:'unverified',cashReconciliation:'pending',capabilities:{...caps},sourceKey:'sharesight.ibGroupedPerformance',sourceHash,evidenceSha256,
  profileBlob:profile.profileBlob,association,expiresAt:context.association.policy.expiresAt,previousSourceSha:context.previousSourceSha,previousDataDate:context.previousMeta.dataDate,
  allocation:publicAllocation});
}
const esc=v=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function renderLedgerView(m){
 validateLedgerView(m);const startHkt=new Date(Date.parse(m.captureStartedAt)+28800000).toISOString().slice(11,16),endHkt=new Date(Date.parse(m.captureCompletedAt)+28800000).toISOString().slice(11,16);const marker=Buffer.from(JSON.stringify(m)).toString('base64url');
 return `<!doctype html><html lang="zh-Hans"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>XUAN · 开市前行动版（部分）</title><!-- xuan-ib-night-action-v1:${marker} --><style>body{margin:0;background:#f6f7f8;color:#17191c;font:16px/1.6 -apple-system,BlinkMacSystemFont,sans-serif}main{max-width:680px;margin:auto;padding:24px 16px}section{background:white;border:1px solid #e4e6e8;border-radius:16px;padding:18px;margin:16px 0}h1{font-size:24px}h2{font-size:19px}.row{display:flex;justify-content:space-between;gap:14px;padding:12px 0;border-top:1px solid #eee}p{color:#5c636d}</style></head><body><main><header><h1>开市前行动版 · 部分报告</h1><p>${esc(m.dataDate)} · ${startHkt}–${endHkt} HKT · 估值日 ${esc(m.sourceDate)}</p><p>本轮读取 ${esc(m.captureStartedAt)} 至 ${esc(m.captureCompletedAt)}</p></header><section><h2>本轮同步完成未核</h2><p>以下为 Sharesight 当前记录的估值与分类；可能未包含待同步交易。同步完成、IB 现金及交易覆盖未核实；现金对账仍待核对。</p><p>本轮不显示 IB 现金、持仓明细、挂单、购买力、收益或行动建议；未取得不表示为零。不计为完整报告或完整同步。</p></section><section><h2>Sharesight 股票估值与分类</h2>${m.allocation.categories.map(r=>`<div class="row"><span>${esc(r.label)}</span><b>USD ${esc(r.marketValue)}<br>${r.currentPct.toFixed(1)}%</b></div>`).join('')}</section><section><p>上一份报告日期 ${esc(m.previousDataDate)}。账户范围沿用当前有效业主关联；此页没有读取 IB 实时账户身份。</p><a href="https://github.com/huanwujoy-crypto/fee-console/blob/${m.previousSourceSha}/xuan-ib/index.html">查看上一份报告</a></section></main></body></html>`;
}
export function validateLedgerPublication(m,{snapshot,previousSourceSha,now,profile}={}){
 validateLedgerView(m);const start=Date.parse(m.captureStartedAt),end=Date.parse(m.captureCompletedAt),plan=planPreopen(start);
 if(!Number.isSafeInteger(now)||end>now||now-start>1800000||hktDate(now)!==m.dataDate||plan.status!=='generate'||plan.sourceDate!==m.sourceDate)fail('STALE_OR_TARGET');
 if(profile?.profile!==LEDGER_PROFILE||profile.profileBlob!==m.profileBlob||!snapshot||m.expiresAt!==snapshot.policy.expiresAt||m.previousSourceSha!==previousSourceSha)fail('CONTEXT');
 validateAssociationReceipt(m.association,snapshot,{now,edition:'am',previousSourceSha,runId:m.association.runId});
 const evidence=ledgerHash({allocation:m.allocation,mode:LEDGER_PROFILE,dataDate:m.dataDate,sourceDate:m.sourceDate,startedAt:m.captureStartedAt,completedAt:m.captureCompletedAt,sourceHash:m.sourceHash,profileBlob:m.profileBlob,association:m.association,previousSourceSha:m.previousSourceSha});
 if(m.evidenceSha256!==evidence)fail('EVIDENCE');return m;
}
export function validateLedgerReceipt(receipt,m){
 if(receipt?.schemaVersion!==1||receipt.mode!==LEDGER_RECEIPT_MODE||receipt.status!=='partial'||receipt.sourceReadStatus!=='complete'||receipt.syncCompletion!=='unverified'
   ||receipt.dataDate!==m.dataDate||receipt.sourceDate!==m.sourceDate||receipt.startedAt!==m.captureStartedAt||receipt.completedAt!==m.captureCompletedAt
   ||receipt.publication!=='none'||receipt.sourceCount!==1||!Array.isArray(receipt.sources)||receipt.sources.length!==1
   ||receipt.sources[0].sourceKey!==m.sourceKey||receipt.sources[0].rawFingerprint!==m.sourceHash||!sha(receipt.sources[0].sha256)
   ||receipt.evidenceSha256!==m.evidenceSha256||receipt.profileBlob!==m.profileBlob||JSON.stringify(receipt.association)!==JSON.stringify(m.association))fail('RECEIPT');
 return receipt;
}
