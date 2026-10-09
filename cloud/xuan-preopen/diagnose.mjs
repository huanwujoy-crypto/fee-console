// Same-pipeline maintenance: fixed, bounded GETs only; no financial context.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {BUCKET, PROJECT, boundedText} from './cloud_io.mjs';

const JOB = `projects/${PROJECT}/locations/asia-east2/jobs/xuan-preopen-report`;
const EXECUTION_FIELDS = 'name,completionTime,taskCount,succeededCount,failedCount,cancelledCount,retriedCount';
const executionId = /^xuan-preopen-report-[a-z0-9-]{1,96}$/;
const validExecution = value => typeof value === 'string' && executionId.test(value) && !/[\r\n]/.test(value);
const failures = new Set(['INPUTS', 'DATE', 'IDENTITY', 'ACCESS_DENIED', 'CLOUD_READ_FAILED', 'RESPONSE', 'START', 'EXECUTION']);
const fail = code => { throw new Error(`PREOPEN_DIAGNOSTIC_${code}`); };
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const hktDate = instant => new Date(instant + 8 * 3_600_000).toISOString().slice(0, 10);

export function validateDiagnosticDate(dataDate, now = Date.now) {
  if (typeof dataDate !== 'string' || dataDate.length !== 10 || !/^\d{4}-\d{2}-\d{2}$/.test(dataDate)) fail('DATE');
  const day = Date.parse(`${dataDate}T00:00:00Z`), instant = now();
  if (!Number.isFinite(day) || !Number.isFinite(instant) || new Date(day).toISOString().slice(0, 10) !== dataDate) fail('DATE');
  if (dataDate !== hktDate(instant)) fail('DATE');
  return dataDate;
}

export function diagnosticTransport({dataDate, now = Date.now, token, fetchImpl = fetch} = {}) {
  validateDiagnosticDate(dataDate, now);
  if (typeof token !== 'string' || !token || /[\r\n]/.test(token)) fail('IDENTITY');
  async function get(url, limit) {
    let response;
    try {
      response = await fetchImpl(url, {method: 'GET', redirect: 'error', signal: AbortSignal.timeout(15_000),
        headers: {Authorization: `Bearer ${token}`, Accept: 'application/json'}});
    } catch { fail('CLOUD_READ_FAILED'); }
    if (response.status === 404) return null;
    if ([401, 403].includes(response.status)) fail('ACCESS_DENIED');
    if (response.status !== 200) fail('CLOUD_READ_FAILED');
    try { return JSON.parse(await boundedText(response, limit)); } catch { fail('RESPONSE'); }
  }
  return {
    readObject(file) {
      if (!['start.json', 'receipt.json'].includes(file)) fail('INPUTS');
      return get(`https://storage.googleapis.com/storage/v1/b/${BUCKET}/o/${encodeURIComponent(`delivery/${dataDate}/${file}`)}?alt=media`,
        file === 'start.json' ? 4_096 : 65_536);
    },
    readExecution(execution) {
      if (!validExecution(execution)) fail('START');
      return get(`https://run.googleapis.com/v2/${JOB}/executions/${execution}?fields=${EXECUTION_FIELDS}`, 8_192);
    },
  };
}

function validateStart(start, dataDate, instant) {
  if (!record(start) || Object.keys(start).sort().join(',') !== 'dataDate,execution,startedAt'
      || start.dataDate !== dataDate || !validExecution(start.execution)
      || typeof start.startedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(start.startedAt)
      || /[\r\n]/.test(start.startedAt) || !Number.isFinite(Date.parse(start.startedAt)) || Date.parse(start.startedAt) > instant
      || new Date(start.startedAt).toISOString() !== (start.startedAt.includes('.') ? start.startedAt : start.startedAt.replace(/Z$/, '.000Z'))
      || hktDate(Date.parse(start.startedAt)) !== dataDate) fail('START');
  return start.execution;
}

// Real UTC calendar/time, preserving fractional precision for time bounds.
function utcNanoseconds(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.(\d{1,9}))?Z$/.exec(value);
  if (!match || /[\r\n]/.test(value)) return null;
  const base = Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}Z`);
  if (!Number.isFinite(base) || new Date(base).toISOString().slice(0, 10) !== match[1]) return null;
  return BigInt(base) * 1_000_000n + BigInt((match[5] || '').padEnd(9, '0'));
}

function executionState(value, execution, startedAt, instant) {
  if (value === null) return 'unknown';
  const names = [JOB, JOB.replace(PROJECT, '860729177589')].map(job => `${job}/executions/${execution}`);
  if (!record(value) || !names.includes(value.name)) fail('EXECUTION');
  const counts = ['taskCount', 'succeededCount', 'failedCount', 'cancelledCount', 'retriedCount'];
  if (counts.some(key => value[key] !== undefined && (!Number.isSafeInteger(value[key]) || value[key] < 0 || value[key] > 1_000))) fail('EXECUTION');
  if (value.completionTime !== undefined) {
    const completed = utcNanoseconds(value.completionTime);
    if (completed === null || completed < utcNanoseconds(startedAt) || completed > BigInt(instant) * 1_000_000n) fail('EXECUTION');
  }
  if (value.failedCount || value.cancelledCount) return 'failed';
  if (!value.completionTime) return 'running';
  return value.succeededCount === 1 && value.taskCount === 1 && !value.retriedCount ? 'succeeded' : 'unknown';
}

function failureCode(receipt, execution) {
  const keys = ['schemaVersion', 'status', 'dataDate', 'sourceDate', 'execution', 'publication', 'errorCode'];
  if (receipt.schemaVersion === 2) keys.push('diagnostic');
  if (![1, 2].includes(receipt.schemaVersion) || Object.keys(receipt).sort().join(',') !== keys.sort().join(',')
      || receipt.publication !== 'none' || !validExecution(receipt.execution)
      || (execution && receipt.execution !== execution)
      || typeof receipt.sourceDate !== 'string' || receipt.sourceDate.length !== 10 || !/^\d{4}-\d{2}-\d{2}$/.test(receipt.sourceDate)
      || !Number.isFinite(Date.parse(`${receipt.sourceDate}T00:00:00Z`))
      || new Date(`${receipt.sourceDate}T00:00:00Z`).toISOString().slice(0, 10) !== receipt.sourceDate
      || receipt.sourceDate >= receipt.dataDate) fail('RESPONSE');
  // v2 can be consumed before its producer is deployed. We intentionally do
  // not interpret its nested diagnostics until that contract is verified.
  if (receipt.schemaVersion === 1 && ['IB_REAUTHORIZE_REQUIRED', 'DAILY_REPORT_FAILED'].includes(receipt.errorCode)) return receipt.errorCode;
  return 'FAILURE_RECEIPT_PRESENT';
}

// Every returned string is constructed or allowlisted, never a cloud message.
export async function collectDiagnostic({dataDate, now = Date.now, io, token, fetchImpl} = {}) {
  validateDiagnosticDate(dataDate, now);
  io ||= diagnosticTransport({dataDate, now, token, fetchImpl});
  const result = (status, code, diagnostic) => ({event: 'PREOPEN_DIAGNOSTIC', status, dataDate, code, diagnostic});
  const start = await io.readObject('start.json');
  const execution = start === null ? null : validateStart(start, dataDate, now());
  const receipt = await io.readObject('receipt.json');
  if (receipt !== null) {
    if (!record(receipt) || receipt.dataDate !== dataDate
        || (receipt.schemaVersion !== undefined && ![1, 2].includes(receipt.schemaVersion))) fail('RESPONSE');
    if (receipt.status === 'ready' && receipt.artifact?.privateObject === `delivery/${dataDate}/report.html`) {
      return result('receipt-ready', 'COMPLETION_RECEIPT_PRESENT', 'report-content-not-verified');
    }
    if (receipt.status === 'failed') {
      const code = failureCode(receipt, execution);
      // Legacy IB_REAUTHORIZE_REQUIRED merged refresh and MCP 401/403 errors;
      // its name does not establish that reauthorization is the remedy.
      return result('receipt-failed', code, 'root-cause-unknown');
    }
    if (receipt.status === 'no-action') return result('no-action', 'NO_ACTION_RECEIPT_PRESENT', 'calendar-no-action');
    fail('RESPONSE');
  }
  if (!execution) return result('unknown', 'START_AND_RECEIPT_MISSING', 'evidence-missing');
  const state = executionState(await io.readExecution(execution), execution, start.startedAt, now());
  if (state === 'failed') return result('execution-failed', 'EXECUTION_FAILED_RECEIPT_MISSING', 'root-cause-unknown');
  if (state === 'succeeded') return result('execution-succeeded-receipt-missing', 'COMPLETION_RECEIPT_MISSING', 'root-cause-unknown');
  if (state === 'running') return result('running', 'EXECUTION_RUNNING', 'completion-not-observed');
  return result('unknown', 'EXECUTION_UNCONFIRMED', 'root-cause-unknown');
}

export async function runDiagnosticCli(args, {env = process.env, now = Date.now, fetchImpl = fetch,
  stdout = value => process.stdout.write(value), stderr = value => process.stderr.write(value),
  append = (file, value) => fs.appendFileSync(file, value)} = {}) {
  try {
    if (args.length !== 1 || args[0] !== '--today') fail('INPUTS');
    const instant = now();
    if (!Number.isSafeInteger(instant)) fail('DATE');
    const dataDate = validateDiagnosticDate(hktDate(instant), () => instant);
    const summary = await collectDiagnostic({dataDate, now, token: env.XUAN_PREOPEN_GOOGLE_TOKEN, fetchImpl});
    const safeText = JSON.stringify(summary) + '\n';
    stdout(safeText);
    if (env.GITHUB_STEP_SUMMARY) append(env.GITHUB_STEP_SUMMARY, safeText);
    return 0;
  } catch (error) {
    const code = String(error?.message || '').replace(/^PREOPEN_DIAGNOSTIC_/, '');
    stderr(`PREOPEN_DIAGNOSTIC_${failures.has(code) ? code : 'FAILED'}\n`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runDiagnosticCli(process.argv.slice(2));
}
