// GitHub -> one Cloud Run job -> private completed files. This identity can
// neither read broker credentials/raw captures nor mutate report storage.
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {BUCKET, boundedText} from './cloud_io.mjs';
import {planPreopen} from './calendar.mjs';
import {loadTrustedContext} from './report.mjs';
import {gitBlobSha} from '../../scripts/xuan-ib-publish-health.mjs';
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
export async function collectDelivery({request = deliveryTransport(), now = Date.now, wait = ms => new Promise(r => setTimeout(r,ms)),
  loadContext = loadTrustedContext} = {}) {
  const plan = planPreopen(now());
  if (plan.status === 'no-action') return {...plan, outcome: 'no-action'};
  const objectUrl = file => `https://storage.googleapis.com/storage/v1/b/${BUCKET}/o/${encodeURIComponent(`delivery/${plan.dataDate}/${file}`)}?alt=media`;
  const parse = value => {try {return JSON.parse(value);} catch {fail('JSON');}};
  let raw = await request(objectUrl('receipt.json'), {missing: true}), execution = null;
  if (raw === null) {
    const startRaw = await request(objectUrl('start.json'), {missing: true});
    if (startRaw !== null) {
      const start = parse(startRaw);
      if (start.dataDate !== plan.dataDate || !/^xuan-preopen-report-[a-z0-9-]+$/.test(start.execution || '')) fail('START_MARKER');
      execution = JOB+'/executions/'+start.execution;
    } else {
      // ONE run request, never a timeout/retry loop that launches another run.
      const operation = parse(await request(RUN+JOB+':run', {method: 'POST'}));
      execution = operation.metadata?.name || operation.response?.name;
    }
    if (!/^projects\/(family-portfolio-gateway|860729177589)\/locations\/asia-east2\/jobs\/xuan-preopen-report\/executions\/[a-z0-9-]+$/.test(execution || '')) fail('EXECUTION_SCOPE');
    const deadline = now()+10*60_000; let done = false;
    while (now() < deadline) {
      const status = parse(await request(RUN+execution));
      if (status.failedCount || status.cancelledCount) fail('EXECUTION_FAILED');
      if (status.completionTime) {
        if (status.succeededCount !== 1 || status.retriedCount || status.taskCount !== 1) fail('EXECUTION_INCOMPLETE');
        done = true; break;
      }
      await wait(5000);
    }
    if (!done) fail('TIMEOUT');
    raw = await request(objectUrl('receipt.json'), {missing: true});
    if (raw === null) fail('COMPLETION_RECEIPT_MISSING');
  }
  const receipt = parse(raw);
  if (receipt.dataDate !== plan.dataDate || receipt.sourceDate !== plan.sourceDate || receipt.status !== 'ready'
      || receipt.artifact?.privateObject !== `delivery/${plan.dataDate}/report.html`) fail('RECEIPT');
  const html = await request(objectUrl('report.html'));
  if (crypto.createHash('sha256').update(html).digest('hex') !== receipt.artifact.sha256) fail('HASH');
  const context = await loadContext({now});
  if (gitBlobSha(context.previousHtml) === gitBlobSha(html)) return {outcome: 'already-published', dataDate: plan.dataDate};
  return {outcome: execution ? 'generated' : 'reused', dataDate: plan.dataDate, sourceDate: plan.sourceDate, execution, html, receipt};
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
