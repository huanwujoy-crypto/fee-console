#!/usr/bin/env node

// One bounded, local-only action-page run. It reads three IB endpoints and two
// Sharesight portfolios, builds the four approved cards, and never publishes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { initRunJournal, startJournalStage, finishJournalStage } from './xuan-ib-run-clock.mjs';
import { captureCodexIbAction } from './xuan-ib-codex-mcp-capture.mjs';
import { buildNightActionModel } from './xuan-ib-night-action-model.mjs';
import { renderNightActionReport } from './xuan-ib-night-action-view.mjs';

const checkout = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PYTHON = '/Users/huanwu/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3';
const SHARESIGHT = '/Users/huanwu/.codex/skills/sharesight-portfolio-api/scripts/sharesight_client.py';
const dateHkt = () => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Hong_Kong', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());
const timeHkt = () => new Date(Date.now() + 8 * 3_600_000).toISOString().slice(11, 16);
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));

function sharesightPerformance(portfolio, date, grouping) {
  return JSON.parse(execFileSync(PYTHON, [SHARESIGHT, 'performance', '--portfolio', portfolio,
    '--start-date', date, '--end-date', date, '--grouping', grouping], {
    encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 90_000,
  }));
}

function currentReserve(date) {
  const ledger = readJson(path.join(checkout, 'claude/xuan-ib-etf-pending-calls-v1.json'));
  if (ledger.schemaVersion !== 1 || ledger.purpose !== 'xuan-etf-owner-declared-pending-calls'
    || !Array.isArray(ledger.entries)) throw new Error('INVALID_PENDING_CALL_LEDGER');
  const eligible = ledger.entries.filter(entry => entry && /^\d{4}-\d{2}-\d{2}$/.test(entry.date)
    && entry.date <= date && Number.isFinite(entry.usd) && entry.usd >= 0).sort((a, b) => a.date.localeCompare(b.date));
  if (!eligible.length) throw new Error('PENDING_CALL_RESERVE_UNAVAILABLE');
  return eligible.at(-1).usd;
}

export async function runNightActionLivePreview({ out, date = dateHkt(), previousHtml = null }) {
  if (typeof out !== 'string' || !path.isAbsolute(out) || !/^\d{4}-\d{2}-\d{2}$/.test(date)
    || date !== dateHkt()) throw new Error('INVALID_LIVE_PREVIEW_SCOPE');
  const started = Date.now();
  const startedHkt = timeHkt();
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'xuan-action-'));
  fs.chmodSync(root, 0o700);
  const dir = path.join(root, 'sources'); fs.mkdirSync(dir, { mode: 0o700 });
  const journalPath = path.join(root, 'run.jsonl');
  initRunJournal(journalPath);
  startJournalStage(journalPath, 'bootstrap'); finishJournalStage(journalPath, 'bootstrap');
  startJournalStage(journalPath, 'ib-read');
  try {
    const result = await captureCodexIbAction({ dir, journalPath });
    if (result.status !== 'captured' || result.sources.length !== 3) throw new Error('ACTION_IB_INCOMPLETE');
    finishJournalStage(journalPath, 'ib-read');
  } catch (error) {
    try { finishJournalStage(journalPath, 'ib-read', { status: 'failed', errorCode: 'ACTION_IB_FAILED' }); } catch {}
    throw error;
  }
  const sharesightStarted = Date.now();
  const [grouped, noah] = await Promise.all([
    Promise.resolve().then(() => sharesightPerformance('IB-HK', date, '83569')),
    Promise.resolve().then(() => sharesightPerformance('NOAH-HK', date, 'investment_type')),
  ]);
  const completedHkt = timeHkt();
  const sourceAsOfHkt = `${date} ${startedHkt}–${completedHkt} HKT`;
  const model = buildNightActionModel({
    dataDate: date, asOfHkt: sourceAsOfHkt, ordersAsOfHkt: `${date} ${completedHkt} HKT`,
    ibAccountSummary: readJson(path.join(dir, 'ib.accountSummary.native.json')),
    ibPositions: readJson(path.join(dir, 'ib.positions.native.json')),
    ibOrders: readJson(path.join(dir, 'ib.orders.native.json')),
    ibGroupedPerformance: grouped, noahPerformance: noah, reserve: currentReserve(date),
    previousHtml: previousHtml ?? (() => {
      const file = path.join(checkout, 'xuan-ib/latest.html');
      return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    })(),
  });
  fs.writeFileSync(out, renderNightActionReport(model), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  return { status: model.status, dataDate: model.dataDate, out,
    orderCount: model.orders.buys.length + model.orders.sells.length,
    replenishmentStatus: model.replenishment.status,
    elapsedSeconds: Math.round((Date.now() - started) / 100) / 10,
    sharesightSeconds: Math.round((Date.now() - sharesightStarted) / 100) / 10 };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [flag, out] = process.argv.slice(2);
  if (flag !== '--out' || !out || process.argv.length !== 4) throw new Error('USAGE: --out ABSOLUTE_FILE');
  const result = await runNightActionLivePreview({ out });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
