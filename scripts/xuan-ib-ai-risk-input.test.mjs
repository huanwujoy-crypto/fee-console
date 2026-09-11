import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  buildAiRiskInputFromCapture, readBoundAiRiskInput,
} from './xuan-ib-ai-risk-input.mjs';
import { fingerprint } from './xuan-ib-run-manifest.mjs';
import { buildAiTierCoverage } from './xuan-ib-ai-tier-coverage.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const registry = JSON.parse(fs.readFileSync(
  path.join(root, 'claude/xuan-ib-portfolio-registry.json'), 'utf8'));
const date = '2026-09-11';
const completedAt = '2026-09-11T13:30:00.000Z';
const startedAt = '2026-09-11T13:29:59.000Z';
const autoRecordId = 'AUTO:AUTO-20260911-NEWSTK-T1-R1:1350094:99000001';
const previousHtml = `<template id="xuan-ib-ai-tier-records-v1" type="application/json">${JSON.stringify([
  { key: '1350094:99000001', symbol: 'SYNTH', custodian: 'Webull',
    portfolioId: '1350094', holdingId: '99000001', instrumentId: '99000001',
    namespace: 'AUTO', recordId: autoRecordId, status: 'classified' },
])}</template>`;

const reportRaw = (portfolioId, { holding = false } = {}) => {
  const holdings = holding ? [{ id: 99000001, portfolio: { id: portfolioId }, instrument: {
    id: 99000001, code: 'SYNTH', market_code: 'TEST', name: 'Synthetic stock',
    currency_code: 'USD', friendly_instrument_description_code: 'ordinary_shares' },
  instrument_currency: { code: 'USD' }, valid_position: true, quantity: 1,
  value: 100.01, instrument_price: 100.01, labels: [], group_name: 'Ordinary Shares',
  number_of_unconfirmed_transactions: 0 }] : [];
  const cash_accounts = holding ? [] : [{ id: portfolioId, portfolio: { id: portfolioId },
    name: 'USD Cash', value: 100.01, currency: { code: 'USD' } }];
  return { result: { mode: 'read_only', portfolio: { id: portfolioId, currency_code: 'USD' },
    data: { report: { portfolio_id: portfolioId, value: 100.01, start_date: date,
      end_date: date, percentages_annualised: false, include_sales: false,
      currency: { code: 'USD' }, holdings, cash_accounts },
    links: { self: 'https://example.invalid/performance?consolidated=false&include_sales=false&report_combined=false' } } } };
};

const receipt = raw => ({ raw, status: 'ok', startedAt, completedAt, retries: 0,
  rawFingerprint: fingerprint(raw) });

const capture = () => ({ sharesight: [
  receipt(reportRaw(936247)), receipt(reportRaw(936249)),
  receipt(reportRaw(1350094, { holding: true })),
] });

test('one immutable capture derives holdings, cash-inclusive denominator and carried AUTO state', () => {
  const envelope = buildAiRiskInputFromCapture(capture(), {
    previousTrustedHtml: previousHtml, registry,
  });
  assert.equal(envelope.riskConstituents.length, 1);
  assert.equal(envelope.riskConstituents[0].marketValueMicro, '100010000');
  assert.equal(envelope.riskConstituents[0].firstSeen, false);
  assert.equal(envelope.riskConstituents[0].previousAutoRecordId, autoRecordId);
  assert.deepEqual(envelope.riskDenominator.components.map(item => [item.key, item.valueMicro]), [
    ['ib-hk', '100010000'], ['schwab-hk', '100010000'], ['webull', '100010000'],
  ]);

  const evidence = { sources: { sharesight: capture().sharesight.map(item => ({
    portfolioId: item.raw.result.portfolio.id, status: 'ok', asOf: item.completedAt,
    fingerprint: item.rawFingerprint,
  })) } };
  const bound = readBoundAiRiskInput(envelope, { previousTrustedHtml: previousHtml, evidence });
  assert.equal(bound.riskConstituents[0].symbol, 'SYNTH');
});

test('a hand-edited first-seen state or mismatched source evidence is refused', () => {
  const envelope = buildAiRiskInputFromCapture(capture(), {
    previousTrustedHtml: previousHtml, registry,
  });
  envelope.riskConstituents[0].firstSeen = true;
  envelope.bindingFingerprint = fingerprint({
    kind: envelope.kind, accounts: envelope.accounts,
    previousManifest: envelope.previousManifest, provenance: envelope.provenance,
    riskConstituents: envelope.riskConstituents,
    riskDenominator: envelope.riskDenominator,
  });
  const evidence = { sources: { sharesight: capture().sharesight.map(item => ({
    portfolioId: item.raw.result.portfolio.id, status: 'ok', asOf: item.completedAt,
    fingerprint: item.rawFingerprint,
  })) } };
  assert.throws(() => readBoundAiRiskInput(envelope, { previousTrustedHtml: previousHtml, evidence }),
    /ENVELOPE_PREVIOUS_MANIFEST_MISMATCH/);

  const fresh = buildAiRiskInputFromCapture(capture(), {
    previousTrustedHtml: previousHtml, registry,
  });
  evidence.sources.sharesight[0].fingerprint = '0'.repeat(64);
  assert.throws(() => readBoundAiRiskInput(fresh, { previousTrustedHtml: previousHtml, evidence }),
    /ENVELOPE_SOURCE_EVIDENCE_MISMATCH/);
});

test('a prior exclusion is never mistaken for a carried AUTO classification', () => {
  const excludedHtml = `<template id="xuan-ib-ai-tier-records-v1" type="application/json">${JSON.stringify([
    { key: '1350094:99000001', symbol: 'SYNTH', custodian: 'Webull',
      portfolioId: '1350094', holdingId: '99000001', instrumentId: '99000001',
      namespace: 'AUTO', recordId: autoRecordId, status: 'excluded',
      reason: 'asset-type-unknown-or-ambiguous' },
  ])}</template>`;
  const envelope = buildAiRiskInputFromCapture(capture(), {
    previousTrustedHtml: excludedHtml, registry,
  });
  assert.equal(envelope.riskConstituents[0].firstSeen, false);
  assert.equal(envelope.riskConstituents[0].previousAutoRecordId, null);
  const coverage = buildAiTierCoverage(envelope.riskConstituents);
  assert.equal(coverage.entries[0].status, 'excluded');
  assert.equal(coverage.entries[0].reason, 'not-first-seen-position');
  assert.deepEqual(coverage.autoRecords, []);
});
