#!/usr/bin/env node
// One command after real source capture: validate -> derive -> deterministic
// narrative -> existing render/guard/candidate preparation. Never fetches a
// financial source, edits policy, publishes, or rewrites a completed run.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { validateCaptureDirectory, validateCaptureFile, readCaptureJson, writeCaptureJson } from './xuan-ib-source-capture.mjs';
import { buildSourceEvidence } from './xuan-ib-source-adapter.mjs';
import { buildMinimalReport } from './xuan-ib-minimal-report.mjs';
import { validateReportView } from './xuan-ib-report-view.mjs';
import { runPrepareCli } from './xuan-ib-report-prepare.mjs';
import { loadTrustedAssociationPolicy } from './xuan-ib-account-association.mjs';
import { startJournalStage, finishJournalStage, showRunJournal } from './xuan-ib-run-clock.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fail = code => { throw new Error(`Minimal prepare: ${code}`); };
const BASELINE_FILES = ['xuan-ib/latest.html', 'xuan-ib/latest.meta.json',
  'claude/xuan-ib-portfolio-registry.json', 'claude/xuan-ib-policy-v2.json'];

function currentBaseline(snapshot) {
  // Existing prepare uses checkout files. Prove they equal the freshly pinned
  // main, rather than quietly inheriting old or candidate-edited history.
  const content = BASELINE_FILES.map(file => {
    const result = spawnSync('git', ['show', `${snapshot.policyCommit}:${file}`],
      { cwd: root, encoding: 'utf8', maxBuffer: 2_000_000, timeout: 15_000 });
    if (result.status !== 0 || typeof result.stdout !== 'string') fail('TRUSTED_BASELINE_READ_FAILED');
    if (fs.readFileSync(path.join(root, file), 'utf8') !== result.stdout) fail('CHECKOUT_BASELINE_NOT_CURRENT_MAIN');
    return result.stdout;
  });
  return { previousHtml: content[0], previousMeta: JSON.parse(content[1]), registry: JSON.parse(content[2]) };
}

// Dependency seams are for offline tests only. The operational CLI exposes no
// supplied policy snapshot, clock, baseline, fallback or publication override.
export function prepareMinimalRun(dir, { journalPath,
  loadPolicy = loadTrustedAssociationPolicy, readBaseline = currentBaseline,
  prepareCandidate = runPrepareCli, wallNow = () => Date.now(),
} = {}) {
  dir = validateCaptureDirectory(dir);
  journalPath = validateCaptureFile(journalPath);
  const outputNames = ['view.json', 'sources.json', 'candidate.html'];
  if (outputNames.some(name => fs.existsSync(path.join(dir, name)))) fail('OUTPUT_ALREADY_EXISTS');
  const journal = showRunJournal(journalPath);
  if (journal.timing.runningStages.length || journal.stages.length !== 3
    || !['bootstrap', 'ib-read', 'sharesight-read'].every(name => journal.stages.some(stage => stage.name === name && stage.status === 'ok'))) {
    fail('EXACT_COMPLETED_READ_STAGES_REQUIRED');
  }
  const input = readCaptureJson(path.join(dir, 'input.json'));
  const associationReceipt = readCaptureJson(path.join(dir, 'association.json'), 16_384);
  if (input.edition !== 'adhoc') fail('ADHOC_TRIAL_ONLY');
  const stage = (name, action) => {
    startJournalStage(journalPath, name);
    try {
      const value = action();
      finishJournalStage(journalPath, name);
      return value;
    } catch (error) {
      finishJournalStage(journalPath, name, { status: 'failed', errorCode: 'MINIMAL_PREPARE_FAILED' });
      throw error;
    }
  };
  let associationSnapshot, baseline, sourceOptions;
  stage('validate', () => {
    associationSnapshot = loadPolicy({ cwd: root, requireActive: true });
    baseline = readBaseline(associationSnapshot);
    sourceOptions = { associationReceipt, associationSnapshot, journalPath };
    buildSourceEvidence(input, baseline.registry, { ...sourceOptions, now: wallNow() });
  });
  const prepared = stage('derive', () => buildMinimalReport(input,
    { ...baseline, ...sourceOptions, now: wallNow() }));
  stage('narrative', () => {
    validateReportView(prepared.view);
    writeCaptureJson(dir, 'view.json', prepared.view);
    writeCaptureJson(dir, 'sources.json', prepared.evidence);
  });
  // This separately refreshes main policy and retains all existing source,
  // history, journal, renderer and trusted-guard checks. No hand-written HTML.
  return prepareCandidate([path.join(dir, 'view.json'), path.join(dir, 'sources.json'),
    path.join(dir, 'candidate.html'), '--journal', journalPath]);
}

export function runMinimalPrepareCli(args) {
  if (args.length !== 3 || args[1] !== '--journal') fail('USAGE_PRIVATE_DIR_JOURNAL');
  return prepareMinimalRun(args[0], { journalPath: args[2] });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(`${JSON.stringify(runMinimalPrepareCli(process.argv.slice(2)))}\n`); }
  catch (error) {
    // Never echo upstream response values, native descriptions, paths or IDs.
    const known = /^(?:Minimal prepare|Minimal report|XUAN-IB source capture): ([A-Z][A-Z0-9_]{0,63})$/.exec(error.message);
    process.stderr.write(`${JSON.stringify({ status: 'failed', code: known?.[1] ?? 'MINIMAL_PREPARE_FAILED' })}\n`);
    process.exitCode = 1;
  }
}
