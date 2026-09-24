#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractNightActionModel, renderNightActionReport } from './xuan-ib-night-action-view.mjs';

const fail = message => { throw new Error(`Night action guard: ${message}`); };

export function validateNightActionHtml(html, expectedDate) {
  if (typeof html !== 'string' || Buffer.byteLength(html) < 1_000 || Buffer.byteLength(html) > 100_000)
    fail('INVALID_SIZE');
  if (typeof expectedDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(expectedDate)) fail('INVALID_DATE');
  const model = extractNightActionModel(html);
  if (model.dataDate !== expectedDate) fail('DATE_MISMATCH');
  if (renderNightActionReport(model) !== html) fail('NONDETERMINISTIC_OR_MODIFIED_HTML');
  return { dataDate: model.dataDate, status: model.status,
    orderCount: model.orders.buys.length + model.orders.sells.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [file, expectedDate] = process.argv.slice(2);
    if (!file || !expectedDate || process.argv.length !== 4) fail('USAGE');
    const result = validateNightActionHtml(fs.readFileSync(file, 'utf8'), expectedDate);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`); process.exitCode = 1;
  }
}
