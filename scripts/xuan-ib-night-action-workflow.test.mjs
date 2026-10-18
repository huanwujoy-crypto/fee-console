import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const validate = fs.readFileSync('.github/workflows/validate-xuan-ib-handover.yml', 'utf8');
const promote = fs.readFileSync('.github/workflows/promote-xuan-ib-handover.yml', 'utf8');

test('candidate validation loads and dispatches to the trusted action-page guard', () => {
  assert.match(validate, /scripts\/xuan-ib-night-action-view\.mjs/);
  assert.match(validate, /scripts\/xuan-ib-night-action-guard\.mjs/);
  assert.match(validate, /grep -Fq '<!-- xuan-ib-night-action-v1:'/);
  assert.match(validate, /xuan-ib-trusted\/scripts\/xuan-ib-night-action-guard\.mjs/);
});

test('promotion validates action pages both before selection and before publication', () => {
  assert.equal((promote.match(/grep -Fq '<!-- xuan-ib-night-action-v1:'/g) || []).length, 2);
  assert.equal((promote.match(/node scripts\/xuan-ib-night-action-guard\.mjs/g) || []).length, 2);
  assert.match(promote, /node scripts\/xuan-ib-sleep-priority\.mjs classify/);
});

const trustedCloudDependencies=[
  'cloud/xuan-preopen/eod_sources.mjs',
  'cloud/xuan-preopen/orders_probe.mjs',
  'cloud/xuan-preopen/ib_mcp.mjs',
  'cloud/xuan-preopen/cloud_io.mjs',
  'cloud/xuan-preopen/ib_diagnostics.mjs',
];
const trustedConcentrationDependencies=[
  'scripts/xuan-ib-action-concentration.mjs',
  'scripts/xuan-weekly-concentration.mjs',
  'scripts/xuan-weekly-leveraged-products.mjs',
  'claude/xuan-weekly-concentration-top10-v1.json',
  'claude/xuan-weekly-leveraged-products-v1.json',
];
test('trusted archive admits only the fixed main cloud dependency closure and checks every required file',()=>{
  const cloud=[...validate.matchAll(/git archive ([^\s]+) -- (cloud\/[^|\n]+)\s*\| tar -x -C "\$trusted_root"/g)];
  assert.equal(cloud.length,1);assert.equal(cloud[0][1],'origin/main');
  assert.deepEqual(cloud[0][2].trim().split(/\s+/),trustedCloudDependencies);
  const required=[...validate.matchAll(/^\s+(cloud\/xuan-preopen\/[^\s]+) \\$/gm)].map(m=>m[1]);
  assert.deepEqual(required,trustedCloudDependencies);
  const policies=[...validate.matchAll(/git archive ([^\s]+) -- (claude\/[^|\n]+)\s*\| tar -x -C "\$trusted_root"/g)];
  assert.equal(policies.length,1);assert.equal(policies[0][1],'origin/main');
  assert.deepEqual(policies[0][2].trim().split(/\s+/),[
    'claude/xuan-ib-portfolio-registry.json','claude/four-bucket-mapping.json','claude/xuan-ib-cash-identities-v1.json',
    'claude/xuan-ib-classification-delegation-v1.json','claude/xuan-ib-ai-tier-overrides-v1.json','claude/xuan-ib-auto-classification-v1.json',
    'claude/xuan-ib-venue-identity-v1.json','claude/xuan-ib-ai-risk-tiers-v1.json',...trustedConcentrationDependencies.filter(p=>p.endsWith('.json')),
  ]);
  for(const dependency of trustedConcentrationDependencies)assert.ok(validate.includes('            '+dependency+' \\'),dependency);
});

// Preserve this existing test name for the unchanged Docker history-test exclusion.
test('isolated trusted archive loads the action guard and rejects a missing pure codec dependency', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trusted-action-archive-'));
  try {
    const entries = [...validate.matchAll(/git archive origin\/main -- ([^|\n]+)\s*\| tar -x -C "\$trusted_root"/g)]
      .flatMap(match => match[1].trim().split(/\s+/));
    assert(entries.includes('cloud/xuan-preopen/eod_sources.mjs'));
    for (const entry of entries) {
      assert(!entry.startsWith('/') && !entry.split('/').includes('..'));
    }
    const archive = spawnSync('git', ['archive', 'HEAD', '--', ...entries], {maxBuffer: 64 * 1024 * 1024, timeout: 30000});
    assert.equal(archive.status, 0, archive.stderr?.toString());
    const extracted = spawnSync('tar', ['-x', '-C', root], {input: archive.stdout, encoding: 'utf8', timeout: 30000});
    assert.equal(extracted.status, 0, extracted.stderr);
    for(const dependency of trustedConcentrationDependencies)assert.ok(fs.existsSync(path.join(root,dependency)),`complete candidate HEAD must contain ${dependency}`);
    const program = `let networkCalls=0;globalThis.fetch=()=>{networkCalls++;throw Error('OFFLINE_ONLY');};
      const {renderNightActionReport}=await import('./scripts/xuan-ib-night-action-view.mjs');
      const {validateNightActionHtml}=await import('./scripts/xuan-ib-night-action-guard.mjs');
      const {qualifyRecordedPublicSummary}=await import('./scripts/xuan-ib-public-eod-summary.mjs');
      const model={schemaVersion:10,mode:'stored-eod-public-summary',status:'partial',dataDate:'2026-10-09',sourceDate:'2026-10-08',captureStartedAt:'2026-10-09T05:00:00.000Z',captureCompletedAt:'2026-10-09T05:00:00.100Z',risks:{reconciliation:'unknown',liveSource:'not-called'},unknowns:{orders:null,orderReserve:null,planning:null,executableBudget:null,availableFunds:null},concentration:{status:'observed',top1Pct:45,top5Pct:100}};
      for(const summary of [model,qualifyRecordedPublicSummary(model)]){
        const result=validateNightActionHtml(renderNightActionReport(summary),summary.dataDate,{now:Date.parse('2026-10-09T05:01:00Z'),publication:true});
        if(result.status!=='partial'||result.orderCount!==null)throw Error('INVALID_SUMMARY');
      }
      if(networkCalls!==0)throw Error('UNEXPECTED_NETWORK');`;
    const run = () => spawnSync(process.execPath, ['--input-type=module', '-e', program], {cwd: root, encoding: 'utf8', timeout: 30000});
    const complete = run();
    assert.equal(complete.status, 0, complete.stderr);
    for(const dependency of [...trustedCloudDependencies,...trustedConcentrationDependencies]){
      const file=path.join(root,dependency),bytes=fs.readFileSync(file);
      fs.unlinkSync(file);
      try{
        const missing=run();
        assert.notEqual(missing.status,0,dependency);
        assert.match(missing.stderr,dependency.endsWith('.json')?/ENOENT/:/ERR_MODULE_NOT_FOUND/);
        assert.ok(missing.stderr.includes(dependency),dependency);
      }finally{fs.writeFileSync(file,bytes);}
    }
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});
