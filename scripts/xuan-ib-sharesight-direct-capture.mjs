#!/usr/bin/env node

// Fixed, read-only Sharesight producer for the existing private capture flow.
// The native client owns its Keychain credentials; neither this process nor
// the report receives them. A caller must already have opened sharesight-read.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { beginSourceCapture, finishSourceCapture } from './xuan-ib-source-capture.mjs';
import { unwrapSource } from './xuan-ib-source-adapter.mjs';

const CLIENT = '/Users/huanwu/Library/Application Support/SharesightNative/Sharesight API Client.app/Contents/MacOS/SharesightNative';
const registry = JSON.parse(fs.readFileSync(new URL('../claude/xuan-ib-portfolio-registry.json', import.meta.url), 'utf8'));
const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;

export function captureSharesightDirect({ dir, journalPath, portfolioId, startDate, endDate,
  runClient = (args) => execFileSync(CLIENT, args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 90_000 }) }) {
  const portfolio = registry.portfolios.find(item => item.requiredEachReport && item.portfolioId === portfolioId);
  if (!portfolio || !date(startDate) || !date(endDate) || startDate > endDate) throw new Error('INVALID_DIRECT_CAPTURE_SCOPE');
  const key = `sharesight.${portfolioId}`;
  beginSourceCapture(dir, key, { journalPath });
  const response = JSON.parse(runClient(['direct', 'performance', '--portfolio', portfolio.portfolioName,
    '--start-date', startDate, '--end-date', endDate, '--grouping', 'investment_type']));
  const raw = { result: response };
  unwrapSource('sharesight', raw);
  if (response.ok !== true || response.route !== 'direct' || response.portfolio.id !== portfolioId)
    throw new Error('DIRECT_SOURCE_IDENTITY_MISMATCH');
  const rawFile = path.join(dir, `${key}.native.json`);
  const bytes = Buffer.from(`${JSON.stringify(raw)}\n`);
  const fd = fs.openSync(rawFile, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.fchmodSync(fd, 0o600); fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  return finishSourceCapture(dir, key, rawFile, { journalPath });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [dir, journalPath, id, startDate, endDate] = process.argv.slice(2);
  if (!dir || !journalPath || !/^\d+$/.test(id || '') || !startDate || !endDate || process.argv.length !== 7)
    throw new Error('USAGE: capture DIR JOURNAL PORTFOLIO_ID START_DATE END_DATE');
  const result = captureSharesightDirect({ dir, journalPath, portfolioId: Number(id), startDate, endDate });
  process.stdout.write(`${result.status} ${result.sourceKey}\n`);
}
