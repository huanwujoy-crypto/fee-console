import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { associationPolicyBlob } from './xuan-ib-account-association.mjs';
import { beginSourceCapture, finishSourceCapture, readCaptureJson } from './xuan-ib-source-capture.mjs';
import { runCodexReadTrial } from './xuan-ib-codex-read-trial.mjs';
import { showRunJournal } from './xuan-ib-run-clock.mjs';

const today = () => new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10);
const sha = 'a'.repeat(40);
const policy = { schemaVersion: 1, policyId: 'ib-primary-7day-pilot-v1', accountAlias: 'IB-HK',
  basis: 'owner-attested-recurring-v1', status: 'active', purpose: 'xuan-ib-read-only-report',
  editions: ['adhoc', 'am', 'pm'], publisher: 'codex-verified-candidate-v1',
  validFrom: new Date(Date.now() - 86_400_000).toISOString(),
  expiresAt: new Date(Date.now() + 86_400_000).toISOString() };
const options = () => ({
  date: today(),
  policyLookup: () => ({ policy, policyBlob: associationPolicyBlob(policy), policyCommit: sha,
    checkedAt: new Date().toISOString() }),
  readPublishedMeta: () => ({ sourceSha: sha, dataDate: today() }),
});
function captureRaw({ dir, journalPath }, key, raw) {
  beginSourceCapture(dir, key, { journalPath });
  const file = path.join(dir, `${key}.native.json`);
  fs.writeFileSync(file, `${JSON.stringify(raw)}\n`, { flag: 'wx', mode: 0o600 });
  return finishSourceCapture(dir, key, file, { journalPath });
}
const ibBodies = {
  accountSummary: { currency: 'USD', net_liquidation: 100, total_cash_value: 20 },
  balances: { balances: [] }, positions: { positions: [] }, orders: { orders: [] }, trades: { trades: [] },
};

test('private trial captures a run-bound five-plus-nine source batch, never publishes', async t => {
  let root;
  const result = await runCodexReadTrial({ ...options(),
    captureIb: context => ({ status: 'captured', sources: Object.entries(ibBodies).map(([name, raw]) => {
      captureRaw(context, `ib.${name}`, raw); return `ib.${name}`;
    }) }),
    captureSharesight: context => captureRaw(context, `sharesight.${context.portfolioId}`, {
      result: { mode: 'read_only', portfolio: { id: context.portfolioId, currency_code: 'USD' },
        data: { report: { portfolio_id: context.portfolioId, value: 1,
          end_date: today(), currency: { code: 'USD' }, holdings: [], cash_accounts: [] } } },
    }),
  });
  root = result.root;
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(result.status, 'private-sources-assembled');
  assert.equal(fs.statSync(root).mode & 0o777, 0o700);
  const input = readCaptureJson(result.inputPath);
  assert.equal(Object.keys(input.ib).length, 5);
  assert.equal(input.sharesight.length, 9);
  assert.equal(showRunJournal(result.journalPath).stages.length, 3);
  assert.ok(!fs.existsSync(path.join(root, 'candidate.html')));
});

test('a failed IB read cannot masquerade as a complete source run', async () => {
  let root;
  await assert.rejects(runCodexReadTrial({ ...options(), captureIb: () => {
    throw new Error('private sample must not appear in public diagnostics');
  }, captureSharesight: () => { throw new Error('unreachable'); } }).catch(error => {
    root = error.privateRoot;
    assert.equal(error.message, 'CODEX_READ_TRIAL_FAILED');
    assert.equal(showRunJournal(path.join(root, 'run.jsonl')).stages.at(-1).status, 'failed');
    throw error;
  }), /CODEX_READ_TRIAL_FAILED/);
  fs.rmSync(root, { recursive: true, force: true });
});
