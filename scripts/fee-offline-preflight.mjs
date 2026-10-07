// Synthetic regression entrypoint; not acceptance of current financial inputs.
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';import path from 'node:path';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const files=['fee-cloud-source','fee-economic-source','daily','fee-management-exemption','fee-income-evidence','fee-data-health','fee-receipt-core','fee-cloud-commit','fee-cloud-supervisor','fee-publish-readback'].map(n=>`scripts/${n}.test.mjs`);
const env=Object.fromEntries(['PATH','LANG','LC_ALL','TMPDIR','TMP','TEMP','TZ','SystemRoot'].filter(k=>process.env[k]!==undefined).map(k=>[k,process.env[k]]));
const r=spawnSync(process.execPath,['--test',...files],{cwd:root,env,encoding:'utf8',timeout:120000,maxBuffer:8*1024*1024});
const number=n=>Number(new RegExp(`(?:ℹ |# )${n} (\\d+)`).exec(r.stdout||'')?.[1]||0);
console.log(JSON.stringify({schema:'fee.synthetic-regression.v1',state:r.status===0?'PASS':'FAILED',tests:number('tests'),passed:number('pass'),failed:number('fail'),skipped:number('skipped')}));
process.exitCode=r.status===0?0:1;
