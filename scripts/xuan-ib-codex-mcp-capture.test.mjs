import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { initRunJournal, startJournalStage, finishJournalStage } from './xuan-ib-run-clock.mjs';
import { parseCodexIbEvent, captureCodexIb } from './xuan-ib-codex-mcp-capture.mjs';

const native = {
  get_account_summary: { currency: 'USD', net_liquidation: 100, total_cash_value: 20 },
  get_account_balances: { balances: [] },
  get_account_positions: { positions: [] },
  get_account_orders: { orders: [] },
  get_account_trades: { trades: [] },
};
const event = (tool, overrides = {}) => ({ type: 'item.completed', item: {
  type: 'mcp_tool_call', server: 'ibkr', tool, status: 'completed',
  arguments: tool === 'get_account_trades' ? { period: 'TODAY' } : {},
  result: { structured_content: native[tool] }, ...overrides,
} });
const setup = t => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'xuan-codex-ib-'));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'captures'); fs.mkdirSync(dir, { mode: 0o700 });
  const journalPath = path.join(root, 'run.jsonl');
  initRunJournal(journalPath);
  startJournalStage(journalPath, 'bootstrap'); finishJournalStage(journalPath, 'bootstrap', {});
  startJournalStage(journalPath, 'ib-read');
  return { dir, journalPath };
};
function fakeSpawn(events, code = 0) {
  return (binary, args) => {
    assert.match(binary, /codex$/);
    assert.ok(args.includes('--json'));
    assert.ok(args.includes('read-only'));
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => {};
    queueMicrotask(() => {
      for (const value of events) child.stdout.write(`${JSON.stringify(value)}\n`);
      child.stdout.end(); child.stderr.end(); child.emit('close', code);
    });
    return child;
  };
}

test('Codex JSON event accepts only reviewed IB read shapes', () => {
  const result = parseCodexIbEvent(event('get_account_orders'));
  assert.deepEqual(result, { sourceKey: 'ib.orders', raw: { orders: [] } });
  assert.equal(parseCodexIbEvent({ type: 'thread.started' }), null);
  assert.equal(parseCodexIbEvent({ ...event('get_account_orders'), type: 'item.started' }), null);
  assert.throws(() => parseCodexIbEvent({ type: 'item.started', item: { type: 'command_execution' } }), /UNEXPECTED_CODEX_ACTION/);
  assert.throws(() => parseCodexIbEvent({ ...event('create_order'), type: 'item.started' }), /UNEXPECTED_MCP_TOOL/);
  assert.throws(() => parseCodexIbEvent(event('create_order')), /UNEXPECTED_MCP_TOOL/);
  assert.throws(() => parseCodexIbEvent(event('get_account_orders', { arguments: { account: 'other' } })), /INVALID_TOOL_INPUT/);
  assert.throws(() => parseCodexIbEvent(event('get_account_trades', { arguments: { period: 'WEEK' } })), /INVALID_TOOL_INPUT/);
  assert.throws(() => parseCodexIbEvent(event('get_account_orders', { result: { is_error: true } })), /MCP_READ_FAILED/);
});

test('five read results produce private captured receipts without financial stdout', async t => {
  const files = setup(t);
  const events = Object.keys(native).map(tool => event(tool));
  const result = await captureCodexIb({ ...files, spawnCodex: fakeSpawn(events) });
  assert.equal(result.status, 'captured');
  assert.equal(result.sources.length, 5);
  assert.equal(fs.statSync(path.join(files.dir, 'ib.orders.native.json')).mode & 0o777, 0o600);
  assert.ok(fs.existsSync(path.join(files.dir, 'ib.orders.receipt.json')));
  assert.ok(!JSON.stringify(result).includes('net_liquidation'));
});

test('missing or duplicate tool result fails closed', async t => {
  const files = setup(t);
  await assert.rejects(captureCodexIb({ ...files,
    spawnCodex: fakeSpawn([event('get_account_orders')]) }), /INCOMPLETE_IB_MCP_CAPTURE/);
  assert.ok(!fs.existsSync(path.join(files.dir, 'ib.positions.receipt.json')));
});
