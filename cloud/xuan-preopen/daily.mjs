import {validateEodReceipt} from './eod_report.mjs';
// Cloud job entry point. It has no GitHub credential or public-write ability.
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {planPreopen} from './calendar.mjs';
import {privateCloudIo} from './cloud_io.mjs';
import {runEodDailyReport} from './eod_daily.mjs';
import {validateEodSourceConfiguration} from './eod_source_config.mjs';
import {ibError, safeIbFailure} from './ib_diagnostics.mjs';
import {ordersCheckCli, ORDERS_CHECK_ARGS, isDailyDiagnosticArgs} from './orders_check.mjs';
export async function runDaily({io = privateCloudIo(), now = Date.now, generate = runEodDailyReport,
  execution = process.env.CLOUD_RUN_EXECUTION} = {}) {
  const plan = planPreopen(now()), prefix = `delivery/${plan.dataDate}/`;
  if (plan.status === 'no-action') {
    const receipt = {...plan, publication: 'none', sourceCount: 0};
    await io.savePrivate(prefix+'receipt.json', receipt);
    return receipt;
  }
  if (!/^xuan-preopen-report-[a-z0-9-]+$/.test(execution || '')) throw new Error('DAILY_EXECUTION_REQUIRED');
  // Local configuration must be frozen/approved before consuming the daily
  // marker. This does no credential or financial read and does not unlock it.
  if (generate === runEodDailyReport) validateEodSourceConfiguration();
  // Acquire the immutable daily start marker BEFORE any financial read. A
  // restarted job loses this create-only race and cannot refresh IB twice.
  await io.savePrivate(prefix+'start.json', {dataDate: plan.dataDate, execution, startedAt: new Date(now()).toISOString()});
  // All raw financial sources remain under report-check/, inaccessible to the
  // delivery identity. Only the two completed delivery files can be read by it.
  let html;
  const wrapped = {...io, savePrivate: async (name, value) => {
    if (name.endsWith('/report.html')) html = value;
    return io.savePrivate(name, value);
  }};
  const receipt = await generate({sourceDate: plan.sourceDate, io: wrapped, now});
  if (receipt.mode === 'private_eod_action') validateEodReceipt(receipt, html, plan.dataDate, plan.sourceDate);
  if ((receipt.mode === 'private_eod_action' ? receipt.status !== 'partial' : receipt.status !== 'ready') || typeof html !== 'string') throw new Error('DAILY_REPORT_INCOMPLETE');
  const artifact = {privateObject: prefix+'report.html', ...await io.savePrivate(prefix+'report.html', html)};
  const delivery = {...receipt, artifact, calendar: plan};
  await io.savePrivate(prefix+'receipt.json', delivery); // Completion marker LAST.
  return {status: delivery.status, dataDate: delivery.dataDate, sourceDate: delivery.sourceDate,
    startedAt: delivery.startedAt, completedAt: delivery.completedAt, publication: 'none'};
}
// No arguments retain the normal daily pipeline. Nonempty arguments never
// fall through to it, including incomplete or unrecognised diagnostic flags.
export async function dailyCli(args, {daily = runDaily, diagnostic = ordersCheckCli} = {}) {
  if (Array.isArray(args) && args.length === 0) return daily();
  if (!isDailyDiagnosticArgs(args)) {
    return safeIbFailure(ibError('IB_DIAGNOSTIC_REQUEST_INVALID', {phase: 'diagnostic_request', category: 'forbidden'}),
      {execution: process.env.CLOUD_RUN_EXECUTION});
  }
  return diagnostic([...ORDERS_CHECK_ARGS]);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  dailyCli(process.argv.slice(2)).then(result => {
    process.stdout.write(JSON.stringify(result)+'\n');
    if (result.status === 'failed') process.exitCode = 1;
  }).catch(error => {
    process.stdout.write(JSON.stringify(safeIbFailure(error, {fallback: 'DAILY_REPORT_FAILED',
      execution: process.env.CLOUD_RUN_EXECUTION}))+'\n'); process.exitCode = 1;
  });
}
