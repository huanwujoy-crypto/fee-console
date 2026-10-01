// Cloud job entry point. It has no GitHub credential or public-write ability.
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {planPreopen} from './calendar.mjs';
import {privateCloudIo} from './cloud_io.mjs';
import {runPrivateReport} from './report.mjs';
export async function runDaily({io = privateCloudIo(), now = Date.now, generate = runPrivateReport,
  execution = process.env.CLOUD_RUN_EXECUTION} = {}) {
  const plan = planPreopen(now()), prefix = `delivery/${plan.dataDate}/`;
  if (plan.status === 'no-action') {
    const receipt = {...plan, publication: 'none', sourceCount: 0};
    await io.savePrivate(prefix+'receipt.json', receipt);
    return receipt;
  }
  if (!/^xuan-preopen-report-[a-z0-9-]+$/.test(execution || '')) throw new Error('DAILY_EXECUTION_REQUIRED');
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
  if (receipt.status !== 'ready' || typeof html !== 'string') throw new Error('DAILY_REPORT_INCOMPLETE');
  const artifact = {privateObject: prefix+'report.html', ...await io.savePrivate(prefix+'report.html', html)};
  const delivery = {...receipt, artifact, calendar: plan};
  await io.savePrivate(prefix+'receipt.json', delivery); // Completion marker LAST.
  return {status: delivery.status, dataDate: delivery.dataDate, sourceDate: delivery.sourceDate,
    startedAt: delivery.startedAt, completedAt: delivery.completedAt, publication: 'none'};
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runDaily().then(result => process.stdout.write(JSON.stringify(result)+'\n')).catch(error => {
    const code = /^[A-Z_0-9]+$/.test(error.message || '') ? error.message : 'DAILY_REPORT_FAILED';
    process.stdout.write(JSON.stringify({status: 'failed', code, publication: 'none'})+'\n'); process.exitCode = 1;
  });
}
