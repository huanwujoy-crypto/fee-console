#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const PUBLIC_ETF_LEDGER_CHECKPOINT = 'claude/xuan-ib-etf-ledger-public-genesis-v1.json';
export const PUBLIC_ETF_LEDGER_ESTABLISHED_CHECKPOINT = 'claude/xuan-ib-etf-ledger-public-established-v1.json';

const HASH_RE = /^[a-f0-9]{64}$/;
const PUBLIC_KEYS = [
  'baselineStatus', 'checkpointHash', 'commitmentAlgorithm', 'commitmentKeyId',
  'entryCount', 'ledgerId', 'methodId', 'mode', 'previousCheckpointHash',
  'previousPrivateHeadCommitment', 'privateHeadCommitment', 'schemaVersion', 't0DateHkt',
];
const PRIVATE_LEDGER_NAME_RE = /(?:private[-_. /]?ledger|ledger[-_. /]?private)/i;
const LIVE_AMOUNT_KEY_RE = /(?:amount|value|valueusd|marketvalue|price|cash|quantity|qty)$/;
const SENSITIVE_KEYS = new Set(['records', 'payload', 'nav', 'holdings', 'positions', 'units']);

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const canonicalize = value => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
};
const canonicalJson = value => JSON.stringify(canonicalize(value));
const normalizedKey = key => String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
const containsLiveScalar = value => {
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return /^\s*(?:[$€£]|[A-Z]{3}\s*)?[+-]?(?:\d[\d,]*)(?:\.\d+)?\s*$/i.test(value);
  if (Array.isArray(value)) return value.some(containsLiveScalar);
  if (isRecord(value)) return Object.values(value).some(containsLiveScalar);
  return false;
};

function normalizeRepositoryPath(filePath) {
  if (typeof filePath !== 'string' || filePath.includes('\0')) {
    throw new Error('Repository path must be a NUL-free string');
  }
  const normalized = path.posix.normalize(filePath.replaceAll('\\', '/')).replace(/^\.\//, '');
  if (!normalized || normalized === '.' || normalized.startsWith('../') || normalized.startsWith('/')) {
    throw new Error(`Repository path escapes the repository: ${filePath}`);
  }
  return normalized;
}

function parseWholeJson(content) {
  if (typeof content !== 'string') return null;
  const trimmed = content.trim();
  if (!trimmed || !['{', '['].includes(trimmed[0])) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

const isEtfLedgerJsonPath = filePath => {
  const normalized = filePath.toLowerCase();
  return normalized.endsWith('.json') && normalized.includes('etf') && normalized.includes('ledger');
};

function inspectJsonShape(value) {
  const found = new Set();
  let strongEtfLedgerIdentity = false;
  let descriptiveEtfLedgerIdentity = false;
  let liveAmount = false;

  const visit = node => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!isRecord(node)) return;
    for (const [key, child] of Object.entries(node)) {
      const normalized = normalizedKey(key);
      if (SENSITIVE_KEYS.has(normalized)) found.add(normalized);
      if ((['nav', 'units'].includes(normalized) || LIVE_AMOUNT_KEY_RE.test(normalized))
          && containsLiveScalar(child)) liveAmount = true;
      if (['ledgerid', 'methodid', 'mode'].includes(normalized)
          && typeof child === 'string'
          && (/(?:etf.*ledger|ledger.*etf)/i.test(child)
            || /(?:private.*ledger|ledger.*private|public.*checkpoint)/i.test(child))) {
        strongEtfLedgerIdentity = true;
      }
      if (typeof child === 'string' && /(?:etf.*ledger|ledger.*etf)/i.test(child)) {
        descriptiveEtfLedgerIdentity = true;
      }
      visit(child);
    }
  };
  visit(value);

  const financialShapeCount = ['nav', 'holdings', 'positions', 'units']
    .filter(key => found.has(key)).length;
  const privateLedgerShape = (found.has('records') && found.has('payload'))
    || financialShapeCount >= 2
    || (liveAmount && financialShapeCount >= 1);
  return {
    descriptiveEtfLedgerIdentity,
    found,
    liveAmount,
    privateLedgerShape,
    strongEtfLedgerIdentity,
  };
}

function validatePublicCheckpoint(content, expectedStatus) {
  const checkpoint = parseWholeJson(content);
  if (!isRecord(checkpoint)) return 'the public ETF checkpoint must be one canonical JSON object';
  const keys = Object.keys(checkpoint).sort();
  if (keys.length !== PUBLIC_KEYS.length || PUBLIC_KEYS.some((key, index) => key !== keys[index])) {
    return 'the public ETF checkpoint contains an unknown, missing, or private field';
  }
  if (checkpoint.schemaVersion !== 1
      || checkpoint.ledgerId !== 'xuan-ib-etf-measurement-ledger-v1'
      || checkpoint.methodId !== 'xuan-ib-etf-abc-v1'
      || checkpoint.mode !== 'read-only-public-checkpoint'
      || checkpoint.t0DateHkt !== '2026-09-01'
      || checkpoint.commitmentAlgorithm !== 'HMAC-SHA256'
      || !HASH_RE.test(checkpoint.commitmentKeyId)
      || !HASH_RE.test(checkpoint.privateHeadCommitment)
      || !HASH_RE.test(checkpoint.checkpointHash)) {
    return 'the public ETF checkpoint identity or value-free state is invalid';
  }
  const validGenesis = expectedStatus === 'pending'
    && checkpoint.baselineStatus === 'pending'
    && checkpoint.entryCount === 1
    && checkpoint.previousCheckpointHash === null
    && checkpoint.previousPrivateHeadCommitment === null;
  const validEstablished = expectedStatus === 'established'
    && checkpoint.baselineStatus === 'established'
    && checkpoint.entryCount === 2
    && HASH_RE.test(checkpoint.previousCheckpointHash)
    && HASH_RE.test(checkpoint.previousPrivateHeadCommitment);
  if (!validGenesis && !validEstablished) {
    return 'the public ETF checkpoint identity or value-free state is invalid';
  }
  if (content !== `${canonicalJson(checkpoint)}\n`) {
    return 'the public ETF checkpoint must remain byte-canonical JSON';
  }
  return null;
}

export function auditEtfLedgerEntries(entries) {
  if (!Array.isArray(entries)) throw new Error('ETF ledger leak audit requires a file list');
  const violations = [];
  for (const entry of entries) {
    const filePath = normalizeRepositoryPath(entry.path);
    const content = typeof entry.content === 'string' ? entry.content : '';
    if (filePath === PUBLIC_ETF_LEDGER_CHECKPOINT
        || filePath === PUBLIC_ETF_LEDGER_ESTABLISHED_CHECKPOINT) {
      const expectedStatus = filePath === PUBLIC_ETF_LEDGER_CHECKPOINT ? 'pending' : 'established';
      const reason = validatePublicCheckpoint(content, expectedStatus);
      if (reason) violations.push({ path: filePath, reason });
      continue;
    }

    if (PRIVATE_LEDGER_NAME_RE.test(filePath)) {
      violations.push({ path: filePath, reason: 'private-ledger naming is forbidden in the public repository' });
      continue;
    }
    if (isEtfLedgerJsonPath(filePath)) {
      violations.push({ path: filePath, reason: 'only the approved public ETF ledger genesis JSON may be tracked' });
      continue;
    }

    const json = parseWholeJson(content);
    if (json === null) continue;
    const shape = inspectJsonShape(json);
    if (shape.strongEtfLedgerIdentity
        || shape.privateLedgerShape
        || (shape.descriptiveEtfLedgerIdentity && shape.found.size > 0)) {
      const markers = [...shape.found].sort();
      if (shape.liveAmount) markers.push('live-amount');
      violations.push({
        path: filePath,
        reason: `ledger-shaped JSON contains private markers: ${markers.join(', ') || 'ETF-ledger-identity'}`,
      });
    }
  }
  return violations;
}

function runGit(cwd, args) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'buffer',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const detail = result.stderr?.toString('utf8').trim() || `git ${args[0]} failed`;
    throw new Error(detail);
  }
  return result.stdout;
}

const splitNul = buffer => buffer.toString('utf8').split('\0').filter(Boolean);

export function collectTrackedAndChangedPaths(cwd, baseSha = null) {
  const sources = new Map();
  for (const filePath of splitNul(runGit(cwd, ['ls-files', '-z']))) {
    sources.set(normalizeRepositoryPath(filePath), new Set(['tracked']));
  }
  if (baseSha) {
    runGit(cwd, ['rev-parse', '--verify', `${baseSha}^{commit}`]);
    for (const filePath of splitNul(runGit(cwd, [
      'diff', '--name-only', '-z', '--diff-filter=ACMRTUXB', `${baseSha}...HEAD`,
    ]))) {
      const normalized = normalizeRepositoryPath(filePath);
      if (!sources.has(normalized)) sources.set(normalized, new Set());
      sources.get(normalized).add('changed');
    }
  }
  return sources;
}

export function auditGitRepository({ cwd = process.cwd(), baseSha = null } = {}) {
  const root = fs.realpathSync(cwd);
  const paths = collectTrackedAndChangedPaths(root, baseSha);
  const entries = [];
  for (const filePath of paths.keys()) {
    const absolutePath = path.resolve(root, filePath);
    if (absolutePath !== root && !absolutePath.startsWith(`${root}${path.sep}`)) {
      throw new Error(`Tracked path escapes the repository: ${filePath}`);
    }
    let content = '';
    const stat = fs.lstatSync(absolutePath);
    if (stat.isFile()) {
      const bytes = fs.readFileSync(absolutePath);
      if (!bytes.includes(0)) content = bytes.toString('utf8');
    }
    entries.push({ path: filePath, content });
  }
  return { fileCount: entries.length, violations: auditEtfLedgerEntries(entries) };
}

function main() {
  if (process.argv.length > 3) throw new Error('Usage: xuan-ib-etf-ledger-leak-guard.mjs [base-sha]');
  const baseSha = process.argv[2] || process.env.BASE_SHA || null;
  const result = auditGitRepository({ baseSha });
  if (result.violations.length > 0) {
    console.error('ETF private ledger leak guard rejected the public repository:');
    result.violations.forEach(violation => console.error(`- ${violation.path}: ${violation.reason}`));
    process.exitCode = 1;
    return;
  }
  console.log(`ETF private ledger leak guard passed (${result.fileCount} tracked/changed files scanned).`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  try {
    main();
  } catch (error) {
    console.error(`ETF private ledger leak guard failed closed: ${error.message}`);
    process.exitCode = 1;
  }
}
