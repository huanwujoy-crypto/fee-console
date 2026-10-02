// Read two already prepared, immutable selected-report artifacts through the existing
// delivery prefix grant. No broker access, refresh, job run or writes to GCP.
import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';import crypto from 'node:crypto';
import {BUCKET,boundedText} from './cloud_io.mjs';import {loadTrustedContext} from './report.mjs';import {validateNightActionHtml} from '../../scripts/xuan-ib-night-action-guard.mjs';import {extractNightActionModel} from '../../scripts/xuan-ib-night-action-view.mjs';
export async function collectLimitedDelivery({prefix,token=process.env.XUAN_PREOPEN_GOOGLE_TOKEN,fetchImpl=fetch,loadContext=loadTrustedContext,now=Date.now}={}){
 const fail=()=>{throw Error('LIMITED_DELIVERY_INVALID');},date=new Date(now()+28800000).toISOString().slice(0,10);
 if(typeof prefix!=='string'||!new RegExp('^delivery/'+date+'/(?:limited-readback|intraday-update)-[a-f0-9]{64}/$').test(prefix)||typeof token!=='string'||!token||/[\r\n\0]/.test(token))fail();
 const read=async file=>{const r=await fetchImpl(`https://storage.googleapis.com/storage/v1/b/${BUCKET}/o/${encodeURIComponent(prefix+file)}?alt=media`,{headers:{Authorization:'Bearer '+token},redirect:'error',signal:AbortSignal.timeout(30000)});if(!r.ok)fail();return boundedText(r,100000);};
 const [html,text]=await Promise.all([read('report.html'),read('receipt.json')]);const receipt=JSON.parse(text),model=extractNightActionModel(html),digest=crypto.createHash('sha256').update(html).digest('hex');
 if(!['private_limited_readback','private_intraday_update'].includes(receipt?.mode)||receipt.status!=='partial'||receipt.dataDate!==date||receipt.publication!=='none'||model.schemaVersion!==(receipt.mode==='private_intraday_update'?8:7)||receipt.evidenceSha256!==model.evidenceSha256||prefix!==`delivery/${date}/${model.schemaVersion===8?'intraday-update':'limited-readback'}-${model.evidenceSha256}/`||digest!==receipt.artifact?.sha256||model.captureStartedAt!==receipt.startedAt||model.captureCompletedAt!==receipt.completedAt)fail();
 const context=await loadContext({now});validateNightActionHtml(html,date,{snapshot:context.association,previousSourceSha:context.previousSourceSha,now:now()});
 return{html,receipt,dataDate:date,outcome:model.schemaVersion===8?'intraday-update':'limited-readback'};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{const [prefix,dir]=process.argv.slice(2);if(process.argv.length!==4||!dir)throw Error('LIMITED_DELIVERY_INVALID');const r=await collectLimitedDelivery({prefix});fs.mkdirSync(dir,{recursive:true,mode:0o700});fs.writeFileSync(path.join(dir,'report.html'),r.html,{mode:0o600});fs.writeFileSync(path.join(dir,'receipt.json'),JSON.stringify(r.receipt),{mode:0o600});if(process.env.GITHUB_OUTPUT)fs.appendFileSync(process.env.GITHUB_OUTPUT,`outcome=${r.outcome}\ndata_date=${r.dataDate}\n`);process.stdout.write(JSON.stringify({outcome:r.outcome,dataDate:r.dataDate})+'\n');}catch{process.stderr.write('LIMITED_DELIVERY_INVALID\n');process.exitCode=1;}
}
