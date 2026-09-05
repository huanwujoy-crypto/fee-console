#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// A bounded owner-attested association, NOT source-account authentication.
// No key, account number, consent observation or financial value belongs here.
export const ASSOCIATION_BASIS = 'owner-attested-recurring-v1';
export const ASSOCIATION_POLICY_PATH = 'claude/xuan-ib-account-association-v1.json';
export const ASSOCIATION_RECEIPT_ID = 'xuan-ib-account-association-v1';
export const ASSOCIATION_DISCLOSURE_ID = 'xuan-ib-account-association-disclosure-v1';
export const MAX_ASSOCIATION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_POLICY_LOOKUP_AGE_MS = 60_000;
const POLICY_ID = 'ib-primary-7day-pilot-v1';
const PURPOSE = 'xuan-ib-read-only-report';
const PUBLISHER = 'claude-verified-candidate-v1';
const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const POLICY_KEYS = ['schemaVersion', 'policyId', 'accountAlias', 'basis', 'status', 'purpose', 'editions', 'publisher', 'validFrom', 'expiresAt'];
const RECEIPT_KEYS = ['schemaVersion', 'basis', 'policyId', 'policyBlob', 'policyCommit', 'policyCheckedAt', 'runId', 'previousSourceSha', 'edition'];
const fail = message => { throw new Error(`XUAN-IB account association: ${message}`); };
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const exactKeys = (value, keys, label) => {
  if (!plain(value)) fail(`${label} must be a plain object`);
  if (Object.keys(value).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(value, key))) fail(`${label} fields are not allowlisted`);
};
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : plain(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const json = value => JSON.stringify(canonical(value));
const clone = value => JSON.parse(json(value));
export const associationPolicyText = policy => `${JSON.stringify(canonical(policy), null, 2)}\n`;
export function associationPolicyBlob(policy) {
  const raw = Buffer.from(associationPolicyText(policy));
  return crypto.createHash('sha1').update(Buffer.from(`blob ${raw.length}\0`)).update(raw).digest('hex');
}
const epoch = (value, label) => {
  if (!Number.isSafeInteger(value) || value < 0 || !Number.isFinite(new Date(value).getTime())) fail(`${label} must be epoch milliseconds`);
  return value;
};
const instant = (value, label) => {
  if (typeof value !== 'string') fail(`${label} must be canonical UTC time`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) fail(`${label} must be canonical UTC time`);
  return parsed;
};
const hash = (value, pattern, label) => { if (typeof value !== 'string' || !pattern.test(value)) fail(`${label} is invalid`); };
const scope = ({ edition = 'adhoc', purpose = PURPOSE, publisher = PUBLISHER } = {}) => {
  if (edition !== 'adhoc' || purpose !== PURPOSE || publisher !== PUBLISHER) fail('report scope or publisher is not approved');
};

export function validateAssociationPolicy(policy, { now = Date.now(), edition = 'adhoc', purpose = PURPOSE, publisher = PUBLISHER, requireActive = true } = {}) {
  epoch(now, 'now');
  if (typeof requireActive !== 'boolean') fail('requireActive must be boolean');
  scope({ edition, purpose, publisher });
  exactKeys(policy, POLICY_KEYS, 'policy');
  if (policy.schemaVersion !== 1 || policy.policyId !== POLICY_ID || policy.accountAlias !== 'IB-HK' || policy.basis !== ASSOCIATION_BASIS || policy.purpose !== PURPOSE || policy.publisher !== PUBLISHER) fail('policy scope is not approved');
  if (!Array.isArray(policy.editions) || policy.editions.length !== 1 || policy.editions[0] !== 'adhoc') fail('policy must allow only adhoc');
  if (!['inactive', 'active', 'revoked'].includes(policy.status)) fail('policy status is invalid');
  if (policy.status === 'inactive') {
    if (policy.validFrom !== null || policy.expiresAt !== null) fail('inactive policy must not start a validity clock');
  } else {
    const start = instant(policy.validFrom, 'validFrom'), end = instant(policy.expiresAt, 'expiresAt');
    if (end <= start || end - start > MAX_ASSOCIATION_WINDOW_MS) fail('policy validity must be positive and at most seven days');
  }
  if (requireActive) {
    if (policy.status !== 'active') fail(`policy is ${policy.status}`);
    if (now < Date.parse(policy.validFrom)) fail('policy is not yet valid');
    if (now >= Date.parse(policy.expiresAt)) fail('policy has expired');
  }
  return clone(policy);
}

export function validateAssociationSnapshot(snapshot, { now = Date.now(), requireActive = true, requireFresh = true, ...context } = {}) {
  exactKeys(snapshot, ['policy', 'policyCommit', 'policyBlob', 'checkedAt'], 'policy snapshot');
  hash(snapshot.policyCommit, SHA, 'policyCommit');
  hash(snapshot.policyBlob, SHA, 'policyBlob');
  const checked = instant(snapshot.checkedAt, 'checkedAt');
  epoch(now, 'now');
  if (requireFresh && (checked > now || now - checked > MAX_POLICY_LOOKUP_AGE_MS)) fail('policy lookup is stale or in the future');
  validateAssociationPolicy(snapshot.policy, { now, requireActive, ...context });
  if (snapshot.policyBlob !== associationPolicyBlob(snapshot.policy)) fail('policy changed or snapshot blob does not match its canonical policy');
  return snapshot;
}
const validateSnapshot = validateAssociationSnapshot;

export function validateAssociationReceiptShape(receipt, context = {}) {
  exactKeys(receipt, RECEIPT_KEYS, 'association receipt');
  if (receipt.schemaVersion !== 1 || receipt.basis !== ASSOCIATION_BASIS || receipt.policyId !== POLICY_ID || receipt.edition !== 'adhoc') fail('association receipt scope is invalid');
  for (const key of ['policyBlob', 'policyCommit', 'previousSourceSha']) hash(receipt[key], SHA, key);
  hash(receipt.runId, HASH, 'runId');
  instant(receipt.policyCheckedAt, 'policyCheckedAt');
  for (const key of ['edition', 'previousSourceSha', 'runId']) {
    if (Object.hasOwn(context, key) && receipt[key] !== context[key]) fail(`association receipt ${key} does not bind this report`);
  }
  if (Object.hasOwn(context, 'preparedAt') && Date.parse(receipt.policyCheckedAt) > instant(context.preparedAt, 'preparedAt')) fail('association receipt check is after report preparation');
  return clone(receipt);
}

export function validateAssociationReceipt(receipt, snapshot, { now = Date.now(), edition = 'adhoc', previousSourceSha, runId, purpose = PURPOSE, publisher = PUBLISHER } = {}) {
  validateAssociationReceiptShape(receipt);
  validateSnapshot(snapshot, { now, edition, purpose, publisher });
  hash(previousSourceSha, SHA, 'context previousSourceSha');
  hash(runId, HASH, 'context runId');
  if (receipt.edition !== edition || receipt.previousSourceSha !== previousSourceSha || receipt.runId !== runId) fail('association receipt does not bind this run and previous report');
  if (receipt.policyId !== snapshot.policy.policyId || receipt.policyBlob !== snapshot.policyBlob) fail('association policy changed since the pre-read check');
  // Unrelated main commits are allowed: the exact policy blob, not main HEAD,
  // is immutable for this run. Each stage independently checks current main.
  const checked = Date.parse(receipt.policyCheckedAt);
  if (checked > now || checked > Date.parse(snapshot.checkedAt) || checked < Date.parse(snapshot.policy.validFrom) || checked >= Date.parse(snapshot.policy.expiresAt)) fail('receipt check is outside policy validity or after current lookup');
  return clone(receipt);
}

export function createAssociationReceipt(snapshot, { now = Date.now(), edition = 'adhoc', previousSourceSha, runId } = {}) {
  validateSnapshot(snapshot, { now, edition });
  const receipt = {
    schemaVersion: 1, basis: ASSOCIATION_BASIS, policyId: snapshot.policy.policyId,
    policyBlob: snapshot.policyBlob, policyCommit: snapshot.policyCommit,
    policyCheckedAt: snapshot.checkedAt, runId, previousSourceSha, edition
  };
  return validateAssociationReceipt(receipt, snapshot, { now, edition, previousSourceSha, runId });
}

const runGitDefault = (args, { cwd, encoding = 'utf8' } = {}) => execFileSync('git', args, {
  cwd, encoding, maxBuffer: 256 * 1024, timeout: 45_000,
  env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, stdio: ['ignore', 'pipe', 'pipe']
});
const validOrigin = value => [
  'https://github.com/huanwujoy-crypto/fee-console.git',
  'https://github.com/huanwujoy-crypto/fee-console',
  'git@github.com:huanwujoy-crypto/fee-console.git',
  'git@github.com:huanwujoy-crypto/fee-console',
  'ssh://git@github.com/huanwujoy-crypto/fee-console.git'
].includes(value);

/** Always performs a fresh network fetch. No environment path, cached ref or
 * candidate policy can authorize a run. runGit/clock are explicit test seams,
 * never exposed as CLI flags or read from environment variables. */
export function loadTrustedAssociationPolicy({ cwd = process.cwd(), now, wallNow = () => Date.now(), runGit = runGitDefault, requireActive = true } = {}) {
  const lookupRef = `refs/xuan-ib-policy-check/${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
  let fetched = false;
  try {
    const origins = String(runGit(['remote', 'get-url', '--all', 'origin'], { cwd })).trim().split(/\r?\n/);
    if (origins.length !== 1 || !validOrigin(origins[0])) fail('origin is not the approved repository');
    runGit(['fetch', '--no-tags', '--force', 'origin', `refs/heads/main:${lookupRef}`], { cwd });
    fetched = true;
    const policyCommit = String(runGit(['rev-parse', '--verify', `${lookupRef}^{commit}`], { cwd })).trim();
    hash(policyCommit, SHA, 'fetched main commit');
    const tree = String(runGit(['ls-tree', policyCommit, '--', ASSOCIATION_POLICY_PATH], { cwd })).trim();
    const match = /^100644 blob ([a-f0-9]{40})\tclaude\/xuan-ib-account-association-v1\.json$/.exec(tree);
    if (!match) fail('current main policy must be one regular tracked file');
    const policyBlob = match[1];
    const raw = Buffer.from(runGit(['cat-file', 'blob', policyBlob], { cwd, encoding: null }));
    if (raw.length === 0 || raw.length > 16_384) fail('policy size is invalid');
    const actualBlob = crypto.createHash('sha1').update(Buffer.from(`blob ${raw.length}\0`)).update(raw).digest('hex');
    if (actualBlob !== policyBlob) fail('policy blob does not match fetched content');
    let policy;
    try { policy = JSON.parse(raw.toString('utf8')); } catch { fail('current main policy is not valid JSON'); }
    if (raw.toString('utf8') !== associationPolicyText(policy)) fail('current main policy encoding is not canonical');
    const checkedNow = now === undefined ? wallNow() : now;
    const snapshot = { policy, policyCommit, policyBlob, checkedAt: new Date(epoch(checkedNow, 'lookup clock')).toISOString() };
    validateSnapshot(snapshot, { now: checkedNow, requireActive });
    return clone(snapshot);
  } catch (error) {
    if (error?.message?.startsWith('XUAN-IB account association:')) throw error;
    // Git stderr can include remote URLs and credential-helper diagnostics.
    fail('fresh trusted-main policy lookup failed; no cached policy is allowed');
  } finally {
    if (fetched) { try { runGit(['update-ref', '-d', lookupRef], { cwd }); } catch { /* non-authoritative temporary ref only */ } }
  }
}

export function renderAssociationReceipt(receipt) {
  validateAssociationReceiptShape(receipt);
  return `<template id="${ASSOCIATION_RECEIPT_ID}">${json(receipt)}</template>`;
}

export function extractAssociationReceipt(html) {
  if (typeof html !== 'string') fail('report HTML must be text');
  const occurrences = html.split(ASSOCIATION_RECEIPT_ID).length - 1;
  if (occurrences === 0) return null;
  if (occurrences !== 1) fail('report must have exactly one association receipt');
  const pattern = new RegExp(`<template id="${ASSOCIATION_RECEIPT_ID}">([^<]*)<\\/template>`);
  const match = pattern.exec(html);
  if (!match) fail('association receipt marker is not canonical');
  let receipt;
  try { receipt = JSON.parse(match[1]); } catch { fail('association receipt JSON is invalid'); }
  validateAssociationReceiptShape(receipt);
  if (match[0] !== renderAssociationReceipt(receipt)) fail('association receipt encoding is not canonical');
  // A marker hidden in a comment/script/style or nested template is not a
  // report's top-level inert receipt.
  const prefix = html.slice(0, match.index);
  if (prefix.lastIndexOf('<!--') > prefix.lastIndexOf('-->')) fail('association receipt is inside a comment');
  const stack = [];
  for (const tag of prefix.matchAll(/<\/?(script|style|template)\b[^>]*>/gi)) {
    const name = tag[1].toLowerCase();
    if (tag[0][1] === '/') { if (stack.at(-1) === name) stack.pop(); }
    else stack.push(name);
  }
  if (stack.length) fail('association receipt is inside an inert container');
  return receipt;
}

export function renderAssociationDisclosure(receipt, snapshot) {
  validateAssociationReceiptShape(receipt);
  validateSnapshot(snapshot, { requireActive: false, requireFresh: false });
  if (receipt.policyBlob !== snapshot.policyBlob || snapshot.policy.expiresAt === null) fail('disclosure policy does not match the receipt');
  const expiry = new Date(Date.parse(snapshot.policy.expiresAt) + 8 * 60 * 60 * 1000).toISOString().slice(0, 16).replace('T', ' ');
  return `<p id="${ASSOCIATION_DISCLOSURE_ID}">账户关联经所有者确认，有效至 ${expiry} HKT；接口本次未返回账户编号，并非接口身份认证。</p>`;
}

export function validatePublicationAssociation(html, snapshot, context) {
  const receipt = extractAssociationReceipt(html);
  if (!receipt) fail('association report is missing its receipt');
  validateAssociationReceipt(receipt, snapshot, context);
  const disclosure = renderAssociationDisclosure(receipt, snapshot);
  if (html.split(ASSOCIATION_DISCLOSURE_ID).length !== 2 || !html.includes(disclosure)) fail('association report is missing its canonical disclosure');
  const visible = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  if (!visible.includes(disclosure)) fail('association disclosure is hidden in an inert container');
  return receipt;
}

export async function createPreReadAssociationReceipt(snapshot, { journalPath, now = Date.now(), edition = 'adhoc', previousSourceSha } = {}) {
  // Import lazily: the source manifest may itself import this policy helper.
  const { showRunJournal } = await import('./xuan-ib-run-clock.mjs');
  const journal = showRunJournal(journalPath);
  if (journal.sourceBinding !== null || journal.timing.runningStages.length || journal.timing.completedStages.some(stage => stage !== 'bootstrap') || !journal.timing.completedStages.includes('bootstrap')) fail('pre-read check requires completed bootstrap and no financial stage started');
  if (journal.stages[0]?.status !== 'ok') fail('pre-read bootstrap must be successful');
  const checked = Date.parse(snapshot.checkedAt);
  if (checked < Date.parse(journal.timing.observedThrough) || checked > now) fail('policy lookup must follow this run bootstrap');
  const firstLine = fs.readFileSync(journalPath, 'utf8').split('\n')[0];
  const runId = crypto.createHash('sha256').update(firstLine).digest('hex');
  return createAssociationReceipt(snapshot, { now, edition, previousSourceSha, runId });
}

function saveNewReceipt(output, receipt) {
  if (typeof output !== 'string' || !path.isAbsolute(output)) fail('output must be an absolute path outside repositories');
  const parent = fs.realpathSync(path.dirname(output));
  // Check the filesystem, not a failed git invocation: an inaccessible or
  // malformed repository is not permission to save into it.
  for (let ancestor = parent; ; ancestor = path.dirname(ancestor)) {
    if (fs.existsSync(path.join(ancestor, '.git')) || (fs.existsSync(path.join(ancestor, 'HEAD')) && fs.existsSync(path.join(ancestor, 'objects')) && fs.existsSync(path.join(ancestor, 'refs')))) fail('receipt output must be outside all repositories');
    if (path.dirname(ancestor) === ancestor) break;
  }
  const target = path.join(parent, path.basename(output));
  const descriptor = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(descriptor, `${json(receipt)}\n`); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

async function main(args) {
  const [command, ...rest] = args;
  if (command === 'snapshot' && rest.length === 0) {
    process.stdout.write(`${json(loadTrustedAssociationPolicy())}\n`);
    return;
  }
  if (command !== 'check' || rest.length !== 8) fail('usage: check --journal PATH --previous-source-sha SHA --edition adhoc --output PATH; or snapshot');
  const options = {};
  for (let i = 0; i < rest.length; i += 2) {
    if (!['--journal', '--previous-source-sha', '--edition', '--output'].includes(rest[i]) || Object.hasOwn(options, rest[i]) || !rest[i + 1]) fail('invalid or duplicate CLI flag');
    options[rest[i]] = rest[i + 1];
  }
  const snapshot = loadTrustedAssociationPolicy();
  const receipt = await createPreReadAssociationReceipt(snapshot, { journalPath: options['--journal'], previousSourceSha: options['--previous-source-sha'], edition: options['--edition'] });
  saveNewReceipt(options['--output'], receipt);
  process.stdout.write('Account association checked; private run-bound receipt saved. No financial read or publication performed.\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
