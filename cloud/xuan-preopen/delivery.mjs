import {validateReadinessReceipt} from './source_readiness.mjs';
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
export async function collectDelivery({request = null, now = Date.now, wait = ms => new Promise(r => setTimeout(r,ms)),
  loadContext = loadTrustedContext} = {}) {
  const plan = planPreopen(now());
  if (plan.status === 'no-action') return {...plan, outcome: 'no-action'};
  if (!plan.windowEnabled) return {outcome: 'outside-window', dataDate: plan.dataDate};
  request ||= deliveryTransport();
  const objectUrl = file => `https://storage.googleapis.com/storage/v1/b/${BUCKET}/o/${encodeURIComponent(`delivery/${plan.dataDate}/${plan.slotId}/${file}`)}?alt=media`;
  const parse = value => {try {return JSON.parse(value);} catch {fail('JSON');}};
  let raw = await request(objectUrl('receipt.json'), {missing: true}), execution = null;
  if (raw === null) {
    const startRaw = await request(objectUrl('start.json'), {missing: true});
    if (startRaw !== null) {
      const start = parse(startRaw);
      if (start.dataDate !== plan.dataDate || start.slotId !== plan.slotId || start.sourceDate !== plan.sourceDate || !/^xuan-preopen-report-[a-z0-9-]+$/.test(start.execution || '')) fail('START_MARKER');
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
  if (receipt.status === 'data-not-ready' && receipt.dataDate === plan.dataDate
      && receipt.sourceDate === plan.sourceDate && receipt.slotId === plan.slotId)
    return {outcome: 'data-not-ready', dataDate: plan.dataDate, message: '数据未齐，未生成行动建议'};
  if (receipt.dataDate !== plan.dataDate || receipt.slotId !== plan.slotId || receipt.sourceDate !== plan.sourceDate || receipt.status !== 'ready' || receipt.readiness?.status !== 'ready'
      || receipt.artifact?.privateObject !== `delivery/${plan.dataDate}/${plan.slotId}/report.html`) fail('RECEIPT');
  const html = await request(objectUrl('report.html'));
  if (crypto.createHash('sha256').update(html).digest('hex') !== receipt.artifact.sha256) fail('HASH');
  const context = await loadContext({now});
  if (!validateReadinessReceipt(receipt.readiness, receipt.sources || [], {sourceDate: plan.sourceDate, now: now()})) fail('SOURCE_COVERAGE');
  const started = Date.parse(receipt.startedAt), completed = Date.parse(receipt.completedAt), time = now();
  if (!Number.isFinite(started) || !Number.isFinite(completed) || started < plan.startEpoch * 1000
      || completed < started || completed > time || completed - started > 300_000
      || time - started > 30 * 60_000) fail('STALE');
  const model = extractNightActionModel(html);
  if (model.dataDate !== plan.dataDate || model.status !== 'ready'
      || !model.asOfHkt.endsWith(`数据至 ${plan.sourceDate}`)) fail('MODEL');
  const capturedTime = model.asOfHkt.match(/\b(\d{2}:\d{2})\b/)?.[1];
  const capturedEpoch = Date.parse(`${plan.dataDate}T${capturedTime}:00+08:00`);
  if (!Number.isFinite(capturedEpoch) || capturedEpoch < plan.startEpoch * 1000
      || Math.abs(capturedEpoch - started) >= 60_000) fail('MODEL_SOURCE_TIME');
  if (gitBlobSha(context.previousHtml) === gitBlobSha(html)) {
    const meta = context.previousMeta;
    if (meta?.dataDate !== plan.dataDate || model.schemaVersion < 4 || !Number.isInteger(meta.sourceCommitEpoch) || meta.sourceCommitEpoch < plan.startEpoch
        || meta.htmlBlob !== gitBlobSha(html) || meta.sourceSha !== context.previousSourceSha) fail('PUBLICATION_CONFLICT');
    // Same bytes plus a current, fresh, exact-slot receipt prove idempotency.
    return {outcome: 'already-published', dataDate: plan.dataDate, slotId: plan.slotId};
  }
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
    if (result.outcome === 'data-not-ready') process.exitCode = 1;
  } catch (error) {
    process.stderr.write((/^PREOPEN_DELIVERY_[A-Z_0-9]+$/.test(error.message) ? error.message : 'PREOPEN_DELIVERY_FAILED')+'\n'); process.exitCode = 1;
  }
}
