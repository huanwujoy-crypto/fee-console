import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initRunJournal, startJournalStage, finishJournalStage } from './xuan-ib-run-clock.mjs';
import { captureSharesightDirect } from './xuan-ib-sharesight-direct-capture.mjs';

const setup = t => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'xuan-direct-'));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'captures'); fs.mkdirSync(dir, { mode: 0o700 });
  const journalPath = path.join(root, 'run.jsonl');
  initRunJournal(journalPath);
  startJournalStage(journalPath, 'bootstrap'); finishJournalStage(journalPath, 'bootstrap', {});
  startJournalStage(journalPath, 'sharesight-read');
  return { root, dir, journalPath };
};

test('direct client result is bound to the reviewed portfolio and captured privately', t => {
  const f = setup(t);
  const args = [];
  const result = captureSharesightDirect({ ...f, portfolioId: 936247,
    startDate: '2026-09-20', endDate: '2026-09-22', runClient: command => {
      args.push(...command);
      return JSON.stringify({ ok: true, mode: 'read_only', route: 'direct',
        portfolio: { id: 936247, currency_code: 'USD' },
        data: { report: { portfolio_id: 936247, value: 1, end_date: '2026-09-22',
          currency: { code: 'USD' }, holdings: [], cash_accounts: [] } } });
    } });
  assert.equal(result.status, 'captured');
  assert.deepEqual(args, ['direct', 'performance', '--portfolio', 'IB-HK', '--start-date',
    '2026-09-20', '--end-date', '2026-09-22', '--grouping', 'investment_type']);
  assert.equal(fs.statSync(result.path).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(f.dir, 'sharesight.936247.native.json')).mode & 0o777, 0o600);
});

test('direct client rejects a different portfolio and does not finish its receipt', t => {
  const f = setup(t);
  assert.throws(() => captureSharesightDirect({ ...f, portfolioId: 936247,
    startDate: '2026-09-20', endDate: '2026-09-22', runClient: () => JSON.stringify({
      ok: true, mode: 'read_only', route: 'direct', portfolio: { id: 936238, currency_code: 'USD' },
      data: { report: { portfolio_id: 936238, value: 1, end_date: '2026-09-22',
        currency: { code: 'USD' }, holdings: [], cash_accounts: [] } }
    }) }), /DIRECT_SOURCE_IDENTITY_MISMATCH/);
  assert.equal(fs.existsSync(path.join(f.dir, 'sharesight.936247.receipt.json')), false);
});

test('unknown portfolio is rejected before the client or capture begins', t => {
  const f = setup(t);
  assert.throws(() => captureSharesightDirect({ ...f, portfolioId: 1021747,
    startDate: '2026-09-20', endDate: '2026-09-22', runClient: () => { throw new Error('called'); } }),
  /INVALID_DIRECT_CAPTURE_SCOPE/);
  assert.deepEqual(fs.readdirSync(f.dir), []);
});
