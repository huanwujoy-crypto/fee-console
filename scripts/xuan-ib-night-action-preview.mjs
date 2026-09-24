#!/usr/bin/env node

// Local-only layout preview. It reads the owner's Sharesight classification
// directly, renders the real current four-class allocation, and leaves every
// not-yet-connected IB field explicitly unavailable. It never publishes.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseSharesightStockAllocation } from './xuan-ib-sharesight-allocation.mjs';
import { renderNightActionReport } from './xuan-ib-night-action-view.mjs';

const PYTHON = '/Users/huanwu/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3';
const CLIENT = '/Users/huanwu/.codex/skills/sharesight-portfolio-api/scripts/sharesight_client.py';
const usage = 'Usage: xuan-ib-night-action-preview.mjs --out FILE [--date YYYY-MM-DD]';
const args = process.argv.slice(2);
const option = name => {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(usage);
  return args[index + 1];
};
const out = option('--out');
const todayHkt = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Hong_Kong', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());
const date = option('--date') || todayHkt;
if (!out || !/^\d{4}-\d{2}-\d{2}$/.test(date)
  || args.some((arg, index) => arg.startsWith('--') && !['--out', '--date'].includes(arg)
    || (!arg.startsWith('--') && !args[index - 1]?.startsWith('--')))) throw new Error(usage);

const response = JSON.parse(execFileSync(PYTHON, [
  CLIENT, 'performance', '--portfolio', 'IB-HK', '--start-date', date,
  '--end-date', date, '--grouping', '83569',
], {
  encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 90_000,
}));
const allocation = parseSharesightStockAllocation(response);
const model = {
  schemaVersion: 1,
  dataDate: allocation.dataDate,
  asOfHkt: `${allocation.dataDate} · 本地排版预览`,
  status: 'partial',
  replenishment: { status: 'unavailable' },
  orders: { status: 'unavailable', asOfHkt: '实时 IB 接入中', buys: [], sells: [] },
  cash: { status: 'unavailable' },
  allocation,
  notes: [
    '股票四类为 Sharesight 当日直读；主题投资和防御资产不计入四类分母。',
    '本页只预览排版；不下单、不转账、不发布公网。',
  ],
};
const resolved = path.resolve(out);
fs.writeFileSync(resolved, renderNightActionReport(model), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
process.stdout.write(`${resolved}\n`);

if (process.argv[1] && path.resolve(process.argv[1]) !== fileURLToPath(import.meta.url))
  throw new Error('INVALID_ENTRYPOINT');
