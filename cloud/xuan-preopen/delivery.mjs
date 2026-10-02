import {attemptFor,attemptPrefix} from './attempts.mjs';
import {validateNightActionHtml} from '../../scripts/xuan-ib-night-action-guard.mjs';
// GitHub -> one Cloud Run job -> private completed files. This identity can
// neither read broker credentials/raw captures nor mutate report storage.
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {BUCKET, boundedText} from './cloud_io.mjs';
import {planPreopen} from './calendar.mjs';
import {loadTrustedContext} from './report.mjs';
import {extractNightActionModel} from '../../scripts/xuan-ib-night-action-view.mjs';
const JOB = 'projects/family-portfolio-gateway/locations/asia-east2/jobs/xuan-preopen-report';
const RUN = 'https://run.googleapis.com/v2/';
const fail = code => {throw new Error(`PREOPEN_DELIVERY_${code}`);};
export function deliveryTransport(token = process.env.XUAN_PREOPEN_GOOGLE_TOKEN) {
  if (!token || /[\r\n]/.test(token)) fail('IDENTITY_REQUIRED');
  return async (url, {method = 'GET', missing = false} = {}) => {
    const response = await fetch(url, {method, redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'}, ...(method === 'POST' ? {body: '{}'} : {})});
    if (missing && response.status === 404) return null;
    if (!response.ok) fail(`HTTP_${response.status}`);
    return boundedText(response, 500_000);
  };
}
export async function collectDelivery({request = null, now = Date.now, wait = ms => new Promise(r => setTimeout(r,ms)),
  loadContext = loadTrustedContext} = {}) {
  const plan = planPreopen(now());
  if (plan.status === 'no-action') return {...plan, outcome: 'no-action'};
  if (!plan.windowEnabled) return {outcome: 'outside-window', dataDate: plan.dataDate};
  request ||= deliveryTransport();
  const attempt=attemptFor(plan,now());
  const objectUrl = (file,index=attempt) => `https://storage.googleapis.com/storage/v1/b/${BUCKET}/o/${encodeURIComponent(attemptPrefix(plan,index)+file)}?alt=media`;
  const parse = value => {try {return JSON.parse(value);} catch {fail('JSON');}};
  let raw=null,execution=null,selected=attempt;
  // An earlier ready result permanently closes retries for this slot. A pending
  // execution is followed, never replaced by a new attempt.
  for(let index=0;index<=attempt;index++){
    const candidate=await request(objectUrl('receipt.json',index),{missing:true});
    if(candidate!==null){
      const receipt=parse(candidate);
      if(receipt.dataDate!==plan.dataDate||receipt.slotId!==plan.slotId||receipt.sourceDate!==plan.sourceDate||(receipt.attempt??0)!==index)fail('RECEIPT_SCOPE');
      if(receipt.status==='ready'||index===attempt){raw=candidate;selected=index;break;}
    }
    const startRaw=candidate===null?await request(objectUrl('start.json',index),{missing:true}):null;
    if(startRaw!==null){
      const start=parse(startRaw);
      if(start.dataDate!==plan.dataDate||start.slotId!==plan.slotId||start.sourceDate!==plan.sourceDate||(start.attempt??0)!==index||!/^xuan-preopen-report-[a-z0-9-]+$/.test(start.execution||''))fail('START_MARKER');
      const existingExecution=JOB+'/executions/'+start.execution;
      if(index<attempt){const prior=parse(await request(RUN+existingExecution));if(prior.failedCount||prior.cancelledCount||prior.completionTime)continue;}
      execution=existingExecution;selected=index;break;
    }
  }
  if(raw===null){
    if(!execution){
      const operation=parse(await request(RUN+JOB+':run',{method:'POST'}));
      execution=operation.metadata?.name||operation.response?.name;
    }
    if(!/^projects\/(family-portfolio-gateway|860729177589)\/locations\/asia-east2\/jobs\/xuan-preopen-report\/executions\/[a-z0-9-]+$/.test(execution||''))fail('EXECUTION_SCOPE');
    const deadline=now()+600000;let done=false;
    while(now()<deadline){
      const status=parse(await request(RUN+execution));
      if(status.failedCount||status.cancelledCount)fail('EXECUTION_FAILED');
      if(status.completionTime){if(status.succeededCount!==1||status.retriedCount||status.taskCount!==1)fail('EXECUTION_INCOMPLETE');done=true;break;}
      await wait(5000);
    }
    if(!done)fail('TIMEOUT');
    // A Cloud Run start crossing a ten-minute boundary derives its own attempt;
    // read the finite namespace, without an override permission or another run.
    for(let index=selected;index<3;index++){
      const candidate=await request(objectUrl('receipt.json',index),{missing:true});
      if(candidate!==null){raw=candidate;selected=index;break;}
    }
    if(raw===null)fail('COMPLETION_RECEIPT_MISSING');
  }
  const receipt=parse(raw),prefix=attemptPrefix(plan,selected);
  if(receipt.dataDate!==plan.dataDate||receipt.slotId!==plan.slotId||receipt.sourceDate!==plan.sourceDate||(receipt.attempt??0)!==selected
    ||!['ready','data-not-ready'].includes(receipt.status)||receipt.artifact?.privateObject!==prefix+'report.html')fail('RECEIPT');
  const html = await request(objectUrl('report.html',selected));
  if (crypto.createHash('sha256').update(html).digest('hex') !== receipt.artifact.sha256) fail('HASH');
  const context = await loadContext({now});
  if(receipt.status==='data-not-ready'){
    const model=extractNightActionModel(html);
    if(model.schemaVersion!==6||model.slotId!==plan.slotId||model.attempt!==selected
      ||JSON.stringify(model.reasonCodes)!==JSON.stringify(receipt.reasonCodes)
      ||JSON.stringify(model.association)!==JSON.stringify(receipt.association))fail('STATUS_RECEIPT');
    const started=Date.parse(receipt.startedAt),completed=Date.parse(receipt.completedAt);
    if(!Number.isFinite(started)||!Number.isFinite(completed)||completed<started||completed>now()||completed-started>300000||now()-started>1800000||Math.abs(Date.parse(model.asOfHkt.replace(' HKT','')+'+08:00')-started)>=60000)fail('STATUS_SOURCE_TIME');
    validateNightActionHtml(html,plan.dataDate,{snapshot:context.association,previousSourceSha:context.previousSourceSha,now:now()});
    return {outcome:'data-not-ready',dataDate:plan.dataDate,slotId:plan.slotId,html,receipt};
  }
  fail('ACTION_ADAPTER_NOT_CONFIGURED');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [outDir] = process.argv.slice(2);
    if (!outDir || process.argv.length !== 3) fail('OUTPUT_REQUIRED');
    const result = await collectDelivery();
    if (result.html) {
      fs.mkdirSync(outDir, {recursive: true, mode: 0o700});
      fs.writeFileSync(path.join(outDir,'report.html'), result.html, {mode: 0o600});
      fs.writeFileSync(path.join(outDir,'receipt.json'), JSON.stringify(result.receipt), {mode: 0o600});
    }
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `outcome=${result.outcome}\ndata_date=${result.dataDate}\n`);
    const {html, receipt, ...summary} = result;
    process.stdout.write(JSON.stringify(summary)+'\n');

  } catch (error) {
    process.stderr.write((/^PREOPEN_DELIVERY_[A-Z_0-9]+$/.test(error.message) ? error.message : 'PREOPEN_DELIVERY_FAILED')+'\n'); process.exitCode = 1;
  }
}
