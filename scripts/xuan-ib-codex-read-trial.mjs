#!/usr/bin/env node

// Private, read-only end-to-end source trial. Does not publish a candidate,
// alter schedules, or place trades. A failed run is retained for audit and
// never reinterpreted as successful current data.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { initRunJournal, startJournalStage, finishJournalStage } from './xuan-ib-run-clock.mjs';
import { loadTrustedAssociationPolicy, createPreReadAssociationReceipt } from './xuan-ib-account-association.mjs';
import { writeCaptureJson, assembleSourceCaptures } from './xuan-ib-source-capture.mjs';
import { captureCodexIb } from './xuan-ib-codex-mcp-capture.mjs';
import { captureSharesightDirect } from './xuan-ib-sharesight-direct-capture.mjs';
import { prepareMinimalRun } from './xuan-ib-minimal-prepare.mjs';

const checkout = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const registry = JSON.parse(fs.readFileSync(path.join(checkout, 'claude/xuan-ib-portfolio-registry.json'), 'utf8'));
const todayHkt = () => new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10);

export async function runCodexReadTrial({ captureIb = captureCodexIb,
  captureSharesight = captureSharesightDirect, policyLookup = loadTrustedAssociationPolicy,
  readPublishedMeta = commit => JSON.parse(execFileSync('git', ['show', `${commit}:xuan-ib/latest.meta.json`],
    { cwd: checkout, encoding: 'utf8', timeout: 15_000 })), date = todayHkt(),
  edition = 'adhoc', prepare = false, prepareCandidate = prepareMinimalRun } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date !== todayHkt()) throw new Error('TRIAL_DATE_NOT_CURRENT_HKT');
  if (!['adhoc', 'pm'].includes(edition) || typeof prepare !== 'boolean') throw new Error('INVALID_TRIAL_MODE');
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'xuan-codex-trial-'));
  fs.chmodSync(root, 0o700);
  const dir = path.join(root, 'sources'); fs.mkdirSync(dir, { mode: 0o700 });
  const journalPath = path.join(root, 'run.jsonl');
  let stage = null;
  try {
    initRunJournal(journalPath);
    startJournalStage(journalPath, 'bootstrap'); stage = 'bootstrap';
    finishJournalStage(journalPath, 'bootstrap'); stage = null;
    const snapshot = policyLookup({ cwd: checkout, requireActive: true });
    const previous = readPublishedMeta(snapshot.policyCommit);
    if (!/^[a-f0-9]{40}$/.test(previous.sourceSha) || previous.dataDate > date)
      throw new Error('TRIAL_PUBLISHED_BASELINE_INVALID');
    const receipt = await createPreReadAssociationReceipt(snapshot, {
      journalPath, previousSourceSha: previous.sourceSha, edition,
    });
    writeCaptureJson(dir, 'association.json', receipt);
    startJournalStage(journalPath, 'ib-read'); stage = 'ib-read';
    const ib = await captureIb({ dir, journalPath });
    if (ib.status !== 'captured' || ib.sources.length !== 5) throw new Error('TRIAL_IB_INCOMPLETE');
    finishJournalStage(journalPath, 'ib-read'); stage = null;
    startJournalStage(journalPath, 'sharesight-read'); stage = 'sharesight-read';
    const required = registry.portfolios.filter(item => item.requiredEachReport);
    if (required.length !== 9) throw new Error('TRIAL_REGISTRY_SCOPE_CHANGED');
    for (const portfolio of required) {
      const result = captureSharesight({ dir, journalPath, portfolioId: portfolio.portfolioId,
        startDate: date, endDate: date });
      if (result.status !== 'captured') throw new Error('TRIAL_SHARESIGHT_INCOMPLETE');
    }
    finishJournalStage(journalPath, 'sharesight-read'); stage = null;
    const assembled = assembleSourceCaptures(dir, { journalPath, previousSourceSha: previous.sourceSha,
      dataDate: date, edition });
    const prepared = prepare ? prepareCandidate(dir, { journalPath }) : null;
    if (prepare && prepared?.status !== 'prepared-not-published') throw new Error('TRIAL_CANDIDATE_NOT_PREPARED');
    return { status: prepare ? 'private-candidate-prepared' : 'private-sources-assembled',
      date, edition, root, journalPath, inputPath: assembled.path,
      ibSources: 5, sharesightSources: required.length,
      ...(prepare ? { candidatePath: path.join(dir, 'candidate.html') } : {}) };
  } catch (error) {
    if (stage) {
      try { finishJournalStage(journalPath, stage, { status: 'failed', errorCode: 'CODEX_TRIAL_FAILED' }); }
      catch { /* Keep original failure and private evidence; no retry. */ }
    }
    const wrapped = new Error('CODEX_READ_TRIAL_FAILED');
    wrapped.privateRoot = root;
    wrapped.cause = error;
    throw wrapped;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length > 3 || (process.argv.length === 3 && process.argv[2] !== '--pm-prepare'))
      throw new Error('UNSUPPORTED_TRIAL_ARGUMENT');
    const result = await runCodexReadTrial(process.argv[2] === '--pm-prepare'
      ? { edition: 'pm', prepare: true } : {});
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ status: 'failed', code: 'CODEX_READ_TRIAL_FAILED',
      privateRoot: error.privateRoot ?? null })}\n`);
    process.exitCode = 1;
  }
}
