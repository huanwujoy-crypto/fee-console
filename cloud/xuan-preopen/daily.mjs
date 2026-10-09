// Cloud job entry point. It has no GitHub credential or public-write ability.
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {planPreopen} from './calendar.mjs';
import {privateCloudIo} from './cloud_io.mjs';
import {runSharesightLedgerReport,loadProductionProfile,runLedgerReadback} from './sharesight_ledger_report.mjs';
import {LEDGER_PROFILE,LEDGER_RECEIPT_MODE} from '../../scripts/xuan-ib-night-action-ledger-view.mjs';
import {runPrivateReport} from './report.mjs';
export async function runDaily({io = privateCloudIo(), now = Date.now, generate = runPrivateReport,
  execution = process.env.CLOUD_RUN_EXECUTION,loadProfile=loadProductionProfile,generateLedger=runSharesightLedgerReport} = {}) {
  const plan = planPreopen(now()), prefix = `delivery/${plan.dataDate}/`;
  if (plan.status === 'no-action') {
    const receipt = {...plan, publication: 'none', sourceCount: 0};
    await io.savePrivate(prefix+'receipt.json', receipt);
    return receipt;
  }
  if (!/^xuan-preopen-report-[a-z0-9-]+$/.test(execution || '')) throw new Error('DAILY_EXECUTION_REQUIRED');
  const profile=await loadProfile({now});
  if(!['normal',LEDGER_PROFILE].includes(profile?.profile))throw Error('DAILY_PROFILE_REQUIRED');
  // Acquire the immutable daily start marker BEFORE any financial read. A
  // restarted job loses this create-only race and cannot refresh IB twice.
  await io.savePrivate(prefix+'start.json', {dataDate: plan.dataDate, execution, startedAt: new Date(now()).toISOString()});
  // All raw financial sources remain under report-check/, inaccessible to the
  // delivery identity. Only the two completed delivery files can be read by it.
  let html;
  const wrapped = {loadGatewayToken:()=>io.loadGatewayToken(),...(profile.profile==='normal'?{ibStore:io.ibStore}:{}), savePrivate: async (name, value) => {
    if (name.endsWith('/report.html')) html = value;
    return io.savePrivate(name, value);
  }};
  const receipt = profile.profile===LEDGER_PROFILE?await generateLedger({sourceDate:plan.sourceDate,io:wrapped,now,loadProfile}):await generate({sourceDate: plan.sourceDate, io: wrapped, now});
  if ((profile.profile===LEDGER_PROFILE?(receipt.mode!==LEDGER_RECEIPT_MODE||receipt.status!=='partial'||receipt.sourceReadStatus!=='complete'||receipt.syncCompletion!=='unverified'):receipt.status !== 'ready') || typeof html !== 'string') throw new Error('DAILY_REPORT_INCOMPLETE');
  const artifact = {privateObject: prefix+'report.html', ...await io.savePrivate(prefix+'report.html', html)};
  const delivery = {...receipt, artifact, calendar: plan};
  await io.savePrivate(prefix+'receipt.json', delivery); // Completion marker LAST.
  return {status: delivery.status, dataDate: delivery.dataDate, sourceDate: delivery.sourceDate,
    startedAt: delivery.startedAt, completedAt: delivery.completedAt, publication: 'none'};
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args=process.argv.slice(2);
  const valid=args.length===0||args.length===1&&args[0]==='--ledger-readback';
  const action=!valid?Promise.reject(Error('DAILY_ARGUMENTS_INVALID')):args.length?runLedgerReadback({io:privateCloudIo()}):runDaily();
  action.then(result => process.stdout.write(JSON.stringify(result)+'\n')).catch(error => {
    const code = /^[A-Z_0-9]+$/.test(error.message || '') ? error.message : 'DAILY_REPORT_FAILED';
    process.stdout.write(JSON.stringify({status: 'failed', code, publication: 'none'})+'\n'); process.exitCode = 1;
  });
}
