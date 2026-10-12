import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {runDaily, dailyCli} from './daily.mjs';
import {DAILY_DIAGNOSTIC_ARGS, ORDERS_CHECK_ARGS, ordersCheckCli} from './orders_check.mjs';
test('joint holiday never loads credentials or reads financial sources', async () => {
  const saved = []; let generated = false;
  const result = await runDaily({now: () => Date.parse('2026-12-25T05:00:00Z'), io: {savePrivate: async (name,value) => saved.push({name,value})},
    generate: async () => {generated = true;}});
  assert.equal(generated, false); assert.equal(result.status, 'no-action'); assert.equal(saved.length, 1);
});
test('delivery exposes only HTML and completion receipt, written in that order', async () => {
  const saved = [], io = {savePrivate: async (name,value) => {saved.push({name,value}); return {sha256: 'a'.repeat(64), generation: '1'};}};
  await runDaily({now: () => Date.parse('2026-10-01T05:00:00Z'), execution: 'xuan-preopen-report-test', io, generate: async ({sourceDate,io: wrapped}) => {
    assert.equal(sourceDate,'2026-09-30'); await wrapped.savePrivate('report-check/id/report.html','private html');
    return {status: 'ready', artifact: {}, dataDate: '2026-10-01', sourceDate};
  }});
  assert.deepEqual(saved.map(x => x.name), ['delivery/2026-10-01/start.json','report-check/id/report.html','delivery/2026-10-01/report.html','delivery/2026-10-01/receipt.json']);
});
test('partial generation does not create a delivery completion marker', async () => {
  const saved = [];
  await assert.rejects(runDaily({now: () => Date.parse('2026-10-01T05:00:00Z'), execution: 'xuan-preopen-report-test', io: {savePrivate: async name => saved.push(name)},
    generate: async () => ({status: 'partial'})}), /INCOMPLETE/);
  assert.deepEqual(saved,['delivery/2026-10-01/start.json']);
});
test('an existing daily start marker blocks duplicate financial generation', async () => {
  let generated = false;
  await assert.rejects(runDaily({now: () => Date.parse('2026-10-01T05:00:00Z'), execution: 'xuan-preopen-report-test',
    io: {savePrivate: async () => {throw new Error('CLOUD_HTTP_412');}}, generate: async () => {generated = true;}}), /412/);
  assert.equal(generated,false);
});
test('empty CLI arguments retain the normal daily path and original failure', async () => {
  let calls = 0;
  const sentinel = {status: 'ready', sentinel: true};
  assert.equal(await dailyCli([], {daily: async () => {calls++; return sentinel;},
    diagnostic: () => assert.fail('No diagnostic')}), sentinel);
  assert.equal(calls, 1);
  const error = new Error('DAILY_REPORT_INCOMPLETE');
  await assert.rejects(dailyCli([], {daily: async () => {throw error;}}), e => e === error);
});
test('only the complete diagnostic vector routes away from normal report generation', async () => {
  let calls = 0;
  const result = await dailyCli([...DAILY_DIAGNOSTIC_ARGS], {daily: () => assert.fail('No daily'),
    diagnostic: async args => {calls++; assert.deepEqual(args, [...ORDERS_CHECK_ARGS]); return {status:'checked'};}});
  assert.equal(calls, 1); assert.equal(result.status, 'checked');
});
test('unknown, partial and mixed CLI arguments never fall through to either I/O path', async () => {
  const deny = () => assert.fail('No capability creation');
  for (const args of [undefined, null, 'bad', ['--unknown'], ['--ib-orders-check'],
    DAILY_DIAGNOSTIC_ARGS.slice(0,-1), ['--auth-check',...DAILY_DIAGNOSTIC_ARGS.slice(1)],
    [...DAILY_DIAGNOSTIC_ARGS,'--execute'], [...DAILY_DIAGNOSTIC_ARGS,'PRIVATE_CANARY']]) {
    const result=await dailyCli(args,{daily:deny,diagnostic:deny});
    assert.equal(result.code,'IB_DIAGNOSTIC_REQUEST_INVALID');
    assert.equal(JSON.stringify(result).includes('PRIVATE_CANARY'),false);
  }
});
test('full daily diagnostic routing rejects a local runtime before creating cloud I/O', async () => {
  const result=await dailyCli([...DAILY_DIAGNOSTIC_ARGS], {daily:()=>assert.fail('No daily'),
    diagnostic: args=>ordersCheckCli(args,{env:{},ioFactory:()=>assert.fail('No IO')})});
  assert.equal(result.code,'IB_DIAGNOSTIC_RUNTIME_REQUIRED');
});
test('real daily executable rejects unknown input safely with nonzero exit before network', () => {
  const p=spawnSync(process.execPath,[new URL('./daily.mjs',import.meta.url).pathname,'--unknown','PRIVATE_CANARY'],
    {encoding:'utf8',timeout:5000});
  assert.equal(p.status,1); assert.equal(p.stderr,'');
  const result=JSON.parse(p.stdout); assert.equal(result.code,'IB_DIAGNOSTIC_REQUEST_INVALID');
  assert.equal(p.stdout.includes('PRIVATE_CANARY'),false);
});
test('importing the default daily entry performs no network I/O', () => {
  const script=`globalThis.fetch=()=>{throw Error('NO_IO')};await import(${JSON.stringify(new URL('./daily.mjs',import.meta.url).href)});`;
  assert.equal(execFileSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8'}),'');
});
