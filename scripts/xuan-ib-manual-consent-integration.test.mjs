import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseDecisionJson } from './xuan-ib-decision-menu.mjs';
import { issueManualConsent, MANUAL_CONSENT_WINDOW_MS } from './xuan-ib-manual-consent.mjs';
import { prepareReport } from './xuan-ib-report-prepare.mjs';
import {
  APPROVED_IB_ACCOUNT_ID,
  RUN_STAGES,
  buildManifestComment,
  extractManifestComment,
  fingerprint,
  sha256Hex,
  validateManifest
} from './xuan-ib-run-manifest.mjs';
import {
  finishJournalStage,
  initRunJournal,
  startJournalStage
} from './xuan-ib-run-clock.mjs';
import { buildSourceEvidence } from './xuan-ib-source-adapter.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const previousHtml = fs.readFileSync(path.join(repoRoot, 'xuan-ib/latest.html'), 'utf8');
const previousMeta = JSON.parse(fs.readFileSync(path.join(repoRoot, 'xuan-ib/latest.meta.json'), 'utf8'));
const policy = JSON.parse(fs.readFileSync(path.join(repoRoot, 'claude/xuan-ib-policy-v2.json'), 'utf8'));
const registry = JSON.parse(fs.readFileSync(path.join(repoRoot, 'claude/xuan-ib-portfolio-registry.json'), 'utf8'));
const dataDate = previousMeta.dataDate;
const epoch = Date.parse(`${dataDate}T03:00:00.000Z`);
const now = epoch + 19_000;
const hktStamp = `${dataDate} 11:00–11:01 HKT`;
const manualDisclosure = '人工核验账户授权，仅限本次临时报告，不代表接口自动核验。';
const endpoints = ['accountSummary', 'balances', 'positions', 'orders', 'trades'];

const clone = value => JSON.parse(JSON.stringify(value));
const at = wallMs => ({
  wallNow: () => wallMs,
  monotonicNowMs: () => wallMs - epoch
});
const iso = offset => new Date(epoch + offset).toISOString();
const occurrences = (text, token) => text.split(token).length - 1;
const decisionTemplate = html => {
  const matches = [...html.matchAll(/<template id="xuan-ib-decision-state-v1" type="application\/json">([\s\S]*?)<\/template>/g)];
  assert.equal(matches.length, 1);
  return matches[0];
};
const priorDecisionTemplate = decisionTemplate(previousHtml);
const priorDecisionState = parseDecisionJson(priorDecisionTemplate[1], 2_000_000);

function workspace(t, label = 'main', initOffset = 0) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), `xuan-manual-integration-${label}-`));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const journalPath = path.join(root, 'run.jsonl');
  initRunJournal(journalPath, at(epoch + initOffset));
  return {
    root,
    journalPath,
    storePath: path.join(root, 'private', 'manual-consent.jsonl')
  };
}

function observation() {
  return {
    accountId: APPROVED_IB_ACCOUNT_ID,
    provider: 'Anthropic',
    consentRowObserved: true,
    singleConsentRow: true,
    claudeEnabled: true,
    otherAiDisabled: true,
    humanAttested: true,
    attester: 'owner-approved-operator',
    observedAt: iso(1_000)
  };
}

function issue(files) {
  startJournalStage(files.journalPath, 'bootstrap', at(epoch + 500));
  finishJournalStage(files.journalPath, 'bootstrap', {}, at(epoch + 900));
  return issueManualConsent({
    observation: observation(),
    journalPath: files.journalPath,
    previousSourceSha: previousMeta.sourceSha,
    storePath: files.storePath,
    now: epoch + 2_000
  });
}

const upstreamBoundaries = {
  'ib-read': [5_000, 10_000],
  'sharesight-read': [11_000, 12_000],
  validate: [13_000, 14_000],
  derive: [15_000, 16_000],
  narrative: [17_000, 18_000]
};

function finishUpstream(journalPath) {
  for (const name of ['ib-read', 'sharesight-read', 'validate', 'derive', 'narrative']) {
    const [start, end] = upstreamBoundaries[name];
    startJournalStage(journalPath, name, at(epoch + start));
    finishJournalStage(journalPath, name, {}, at(epoch + end));
  }
}

const receipt = (raw, start, end) => ({
  raw,
  status: 'ok',
  startedAt: iso(start),
  completedAt: iso(end),
  retries: 0,
  rawFingerprint: fingerprint(raw)
});

function rawInput({ native = false } = {}) {
  const summary = {
    ...(native ? { account_id: APPROVED_IB_ACCOUNT_ID } : {}),
    currency: 'USD',
    net_liquidation: 100,
    total_cash_value: 10
  };
  const ibRaw = {
    accountSummary: summary,
    balances: { balances: [] },
    positions: {
      positions: [{
        contract_description: 'SYNTH',
        position: 1,
        market_price: 100,
        market_value: 100,
        currency: 'USD'
      }]
    },
    orders: { orders: [] },
    trades: { trades: [] }
  };
  const input = {
    edition: 'adhoc',
    dataDate,
    previousSourceSha: previousMeta.sourceSha,
    ib: {},
    sharesight: []
  };
  endpoints.forEach((name, index) => {
    input.ib[name] = receipt(ibRaw[name], 5_100 + index * 900, 5_200 + index * 900);
  });
  input.sharesight = registry.portfolios.filter(item => item.requiredEachReport).map((item, index) => {
    const raw = {
      result: {
        mode: 'read_only',
        portfolio: { id: item.portfolioId, currency_code: 'USD' },
        data: {
          report: {
            portfolio_id: item.portfolioId,
            value: 100,
            end_date: dataDate,
            currency: { code: 'USD' },
            holdings: [],
            cash_accounts: []
          },
          api_transaction: { id: `synthetic-${index}` }
        }
      }
    };
    return receipt(raw, 11_100, 11_200);
  });
  return input;
}

const card = title => ({
  title,
  asOfHkt: hktStamp,
  lines: ['合成集成测试；不是金融数据。'],
  columns: ['项目', '状态'],
  rows: [['合成项', '仅测试']]
});

function reportView() {
  return {
    schemaVersion: 1,
    edition: 'adhoc',
    dataDate,
    asOfHkt: hktStamp,
    marketContext: '合成集成测试',
    alerts: [{ level: 'warning', text: '合成测试，不得发布。' }],
    summary: ['合成摘要一。', '合成摘要二。', '合成摘要三。'],
    kpis: [
      { label: '合成 NAV', value: 100, format: 'usd', asOfHkt: hktStamp, note: '合成数值' },
      { label: '合成现金', value: 10, format: 'usd', asOfHkt: hktStamp, note: '合成数值' },
      { label: '合成比例', value: 1, format: 'percent', asOfHkt: hktStamp, note: '仅测试' }
    ],
    holdings: {
      status: 'ok',
      asOfHkt: hktStamp,
      authoritativeValueUsd: 100,
      note: '合成持仓。',
      rows: [{
        symbol: 'SYNTH',
        market: 'TEST',
        quantity: 1,
        price: 100,
        priceCurrency: 'USD',
        marketValueUsd: 100,
        changePct: null,
        changeAsOfHkt: null,
        quoteStatus: 'unavailable'
      }]
    },
    risk: [card('② 风险')],
    allocation: [card('④ 配置')],
    rotation: card('换仓'),
    events: card('日历未查询'),
    decisions: priorDecisionState.decisions.map(item => ({
      decisionId: item.decisionId,
      asOfHkt: hktStamp,
      fact: '合成事实；不改历史意见。',
      isNew: false
    })),
    observations: ['合成观察'],
    notes: ['版次与时点：合成。', '数据与口径：合成。', '只读验证，不执行交易。'],
    cashPlan: { schemaVersion: 2, status: 'unavailable' }
  };
}

function manualFixture(t) {
  const files = workspace(t);
  const proof = issue(files);
  finishUpstream(files.journalPath);
  const input = rawInput();
  const evidence = buildSourceEvidence(input, registry, {
    manualConsentProof: proof,
    journalPath: files.journalPath,
    now
  });
  return { files, proof, input, evidence };
}

test('manual path is one-use, private, source-preserving and receipt-immutable end to end', t => {
  const files = workspace(t);
  const proof = issue(files);
  finishUpstream(files.journalPath);
  const input = rawInput();
  const originalInput = clone(input);
  const rawFingerprints = Object.fromEntries(endpoints.map(name => [name, fingerprint(input.ib[name].raw)]));
  const evidence = buildSourceEvidence(input, registry, {
    manualConsentProof: proof,
    journalPath: files.journalPath,
    now
  });

  assert.deepEqual(input, originalInput);
  for (const name of endpoints) {
    assert.equal(evidence.sources.ib[name].fingerprint, rawFingerprints[name]);
    assert.equal(evidence.sources.ib[name].readStartedAt, input.ib[name].startedAt);
  }

  const prepared = prepareReport(reportView(), evidence, {
    previousHtml,
    previousMeta,
    policy,
    registry,
    journalPath: files.journalPath,
    manualConsentStore: files.storePath,
    now
  });
  assert.equal(prepared.result.status, 'prepared-not-published');
  assert.equal(occurrences(prepared.html, manualDisclosure), 1);
  for (const privateValue of [
    APPROVED_IB_ACCOUNT_ID,
    'Anthropic',
    'consentRowObserved',
    proof.observationFingerprint,
    proof.proofId,
    ...Object.values(rawFingerprints)
  ]) assert.equal(prepared.html.includes(privateValue), false, `HTML leaked ${privateValue}`);

  const nextDecisionTemplate = decisionTemplate(prepared.html);
  assert.equal(nextDecisionTemplate[0], priorDecisionTemplate[0]);
  assert.deepEqual(
    parseDecisionJson(nextDecisionTemplate[1], 2_000_000).receipts,
    priorDecisionState.receipts
  );
  assert.deepEqual(input, originalInput);

  const replayJournal = path.join(files.root, 'replay-run.jsonl');
  initRunJournal(replayJournal, at(epoch));
  startJournalStage(replayJournal, 'bootstrap', at(epoch + 500));
  finishJournalStage(replayJournal, 'bootstrap', {}, at(epoch + 900));
  finishUpstream(replayJournal);
  assert.throws(() => prepareReport(reportView(), evidence, {
    previousHtml,
    previousMeta,
    policy,
    registry,
    journalPath: replayJournal,
    manualConsentStore: files.storePath,
    now
  }), /already been consumed/);
});

test('manual scope never overrides a wrong or null account_id at any IB endpoint or nesting level', t => {
  const { files, proof } = manualFixture(t);
  for (const endpoint of endpoints) {
    for (const badId of [null, 'WRONG-ACCOUNT']) {
      for (const nested of [false, true]) {
        const input = rawInput();
        if (nested) input.ib[endpoint].raw.metadata = { account_id: badId };
        else input.ib[endpoint].raw.account_id = badId;
        input.ib[endpoint].rawFingerprint = fingerprint(input.ib[endpoint].raw);
        assert.throws(() => buildSourceEvidence(input, registry, {
          manualConsentProof: proof,
          journalPath: files.journalPath,
          now
        }), /ACCOUNT_SCOPE/, `${endpoint} ${nested ? 'nested' : 'top-level'} ${String(badId)}`);
      }
    }
  }
});

test('manual proof is bound to journal, store, adhoc edition, prior SHA, run and half-open windows', t => {
  const { files, proof, input, evidence } = manualFixture(t);
  assert.throws(() => buildSourceEvidence(input, registry, {
    manualConsentProof: proof,
    now
  }), /MANUAL_JOURNAL_REQUIRED/);
  assert.throws(() => prepareReport(reportView(), evidence, {
    previousHtml, previousMeta, policy, registry, journalPath: files.journalPath, now
  }), /manual consent requires journal and private store/);

  const pm = clone(input);
  pm.edition = 'pm';
  assert.throws(() => buildSourceEvidence(pm, registry, {
    manualConsentProof: proof, journalPath: files.journalPath, now
  }), /adhoc|edition/);

  const wrongPrior = clone(input);
  wrongPrior.previousSourceSha = 'b'.repeat(40);
  assert.throws(() => buildSourceEvidence(wrongPrior, registry, {
    manualConsentProof: proof, journalPath: files.journalPath, now
  }), /previousSourceSha/);

  const other = workspace(t, 'other-run', 500);
  startJournalStage(other.journalPath, 'bootstrap', at(epoch + 600));
  finishJournalStage(other.journalPath, 'bootstrap', {}, at(epoch + 900));
  finishUpstream(other.journalPath);
  assert.throws(() => buildSourceEvidence(input, registry, {
    manualConsentProof: proof, journalPath: other.journalPath, now
  }), /different run/);

  assert.throws(() => buildSourceEvidence(input, registry, {
    manualConsentProof: proof,
    journalPath: files.journalPath,
    now: epoch + 1_000 + MANUAL_CONSENT_WINDOW_MS
  }), /expired/);

  for (const [field, value] of [
    ['startedAt', iso(4_999)],
    ['completedAt', iso(10_001)]
  ]) {
    const outside = clone(input);
    outside.ib.orders[field] = value;
    assert.throws(() => buildSourceEvidence(outside, registry, {
      manualConsentProof: proof, journalPath: files.journalPath, now
    }), /MANUAL_READ_OUTSIDE_JOURNAL/);
  }
});

test('native account path remains unchanged and cannot be mixed with manual evidence or a private store', t => {
  const input = rawInput({ native: true });
  const original = clone(input);
  const evidence = buildSourceEvidence(input, registry);
  assert.deepEqual(input, original);
  assert.equal(evidence.sources.ib.accountId, APPROVED_IB_ACCOUNT_ID);
  assert.equal(Object.hasOwn(evidence.sources.ib, 'manualConsent'), false);
  assert.equal(Object.hasOwn(evidence.sources.ib, 'accountScopeBasis'), false);
  endpoints.forEach(name => assert.equal(Object.hasOwn(evidence.sources.ib[name], 'readStartedAt'), false));

  const prepared = prepareReport(reportView(), evidence, {
    previousHtml, previousMeta, policy, registry
  });
  assert.equal(prepared.result.status, 'prepared-not-published');
  assert.equal(prepared.html.includes(manualDisclosure), false);

  const files = workspace(t, 'native');
  const proof = issue(files);
  assert.throws(() => buildSourceEvidence(input, registry, {
    manualConsentProof: proof,
    journalPath: files.journalPath,
    now: epoch + 2_000
  }), /MANUAL_EVIDENCE_WITH_NATIVE_ID/);
  assert.throws(() => prepareReport(reportView(), evidence, {
    previousHtml,
    previousMeta,
    policy,
    registry,
    manualConsentStore: files.storePath
  }), /private manual store supplied for a native-account report/);
});

function methods() {
  const components = {
    runtimeContractHash: sha256Hex('synthetic-runtime'),
    scheduleContractHash: sha256Hex('synthetic-schedule'),
    addendumHash: sha256Hex('synthetic-addendum'),
    registryHash: sha256Hex('synthetic-registry'),
    mappingHash: sha256Hex('synthetic-mapping')
  };
  return { ...components, methodBundleHash: fingerprint(components) };
}

function historicalManifest(evidence, proof) {
  const bounds = {
    bootstrap: [500, 900],
    'ib-read': [5_000, 10_000],
    'sharesight-read': [10_000, 12_000],
    validate: [12_000, 13_000],
    derive: [13_000, 14_000],
    narrative: [14_000, 15_000],
    render: [15_000, 16_000],
    guard: [16_000, 17_000],
    'candidate-prep': [17_000, 18_000]
  };
  return {
    schemaVersion: 1,
    runId: proof.runId,
    edition: 'adhoc',
    dataDate,
    startedAt: iso(0),
    preparedAt: iso(19_000),
    stages: RUN_STAGES.map(name => ({
      name,
      startedAt: iso(bounds[name][0]),
      endedAt: iso(bounds[name][1]),
      durationMs: bounds[name][1] - bounds[name][0],
      cacheHit: false,
      status: 'ok'
    })),
    sources: clone(evidence.sources),
    methods: methods(),
    inputFingerprint: sha256Hex('synthetic-input'),
    previousSourceSha: previousMeta.sourceSha
  };
}

test('historical manifest accepts an expired proof only with its exact recorded context', t => {
  const { proof, evidence } = manualFixture(t);
  const manifest = historicalManifest(evidence, proof);
  assert.equal(validateManifest(manifest, registry), manifest);
  const comment = buildManifestComment(manifest, registry);
  const extracted = extractManifestComment(`<!doctype html>${comment}`, registry);
  assert.deepEqual(extracted, manifest);
  assert.deepEqual(extracted.sources.ib.manualConsent, proof);
  assert.equal(JSON.stringify(extracted.sources.ib.manualConsent).includes(APPROVED_IB_ACCOUNT_ID), false);
  assert.equal(JSON.stringify(extracted.sources.ib.manualConsent).includes('Anthropic'), false);

  const mismatches = [
    [{ runId: 'b'.repeat(64) }, /different run/],
    [{ previousSourceSha: 'b'.repeat(40) }, /previousSourceSha/],
    [{ edition: 'pm' }, /adhoc|edition/],
    [{ preparedAt: proof.expiresAt }, /outside consent window/]
  ];
  for (const [change, pattern] of mismatches) {
    const invalid = clone(manifest);
    Object.assign(invalid, change);
    assert.throws(() => validateManifest(invalid, registry), pattern);
  }
  const missingPrior = clone(manifest);
  delete missingPrior.previousSourceSha;
  assert.throws(() => validateManifest(missingPrior, registry), /previousSourceSha/);
  const mismatchedReadStage = clone(manifest);
  const readStage = mismatchedReadStage.stages.find(stage => stage.name === 'ib-read');
  readStage.endedAt = iso(6_000);
  readStage.durationMs = 1_000;
  assert.throws(() => validateManifest(mismatchedReadStage, registry), /outside manifest read stage/);
});
