// Offline test entrypoint. No credentials, financial network or business writes.
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';import path from 'node:path';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const files=['fee-cloud-source','fee-economic-source','daily','fee-management-exemption','fee-income-evidence','fee-data-health','fee-receipt-core','fee-cloud-commit','fee-cloud-supervisor','fee-publish-readback'].map(n=>`scripts/${n}.test.mjs`);
const r=spawnSync(process.execPath,['--test',...files],{cwd:root,encoding:'utf8',timeout:120000,maxBuffer:8*1024*1024});
const number=n=>Number(new RegExp(`(?:ℹ |# )${n} (\\d+)`).exec(r.stdout||'')?.[1]||0);
console.log(JSON.stringify({schema:'fee.offline-preflight.v1',state:r.status===0?'PASS':'FAILED',tests:number('tests'),passed:number('pass'),failed:number('fail'),skipped:number('skipped'),financialNetworkReads:0,productionWrites:0}));
process.exitCode=r.status===0?0:1;
