#!/usr/bin/env node

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ETF_ABC_METHOD_ID, ETF_ABC_POLICY_FINGERPRINT, ETF_ABC_T0_DATE } from './xuan-ib-etf-abc.mjs';

// PUBLIC REPOSITORY SAFETY: only a value-free public checkpoint belongs here.
// The evidence manifest, authoritative ledger, and HMAC secret must remain in
// an owner-only approved private root outside this public repository.
export const ETF_LEDGER_SCHEMA_VERSION = 1;
export const ETF_LEDGER_ID = 'xuan-ib-etf-measurement-ledger-v1';
export const ETF_LEDGER_PUBLIC_MODE = 'read-only-public-checkpoint';
export const ETF_LEDGER_PRIVATE_MODE = 'read-only-private-ledger';
export const ETF_BASELINE_EVIDENCE_ID = 'xuan-ib-etf-t0-baseline-evidence-v1';
export const ETF_LEDGER_COMMITMENT_ALGORITHM = 'HMAC-SHA256';
export const ETF_LEDGER_PRIVATE_ROOT_ENV = 'XUAN_ETF_PRIVATE_ROOT';

const T0_COMMON_CUTOFF_HKT = '2026-09-02T04:00:00+08:00';
const MAX_PRIVATE_FILE_BYTES = 4 * 1024 * 1024;
const PUBLIC_REPOSITORY_ROOT = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const HASH_RE = /^[a-f0-9]{64}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const DECIMAL_RE = /^(?:0|[1-9]\d{0,15})(?:\.\d{1,8})?$/;
const LEDGER_KEYS = ['baselineStatus', 'headHash', 'ledgerId', 'methodId', 'mode', 'records', 'schemaVersion', 't0DateHkt'];
const ENTRY_KEYS = ['entryHash', 'entryType', 'payload', 'previousEntryHash', 'sequence'];
const BASELINE_PAYLOAD_KEYS = ['aHoldingsFingerprint', 'aValueUsd', 'bHoldingsFingerprint', 'bValueUsd', 'baselineDateHkt', 'evidenceManifest', 'evidenceManifestFingerprint', 'status'];
const EVIDENCE_KEYS = ['currency', 'evidenceId', 'evidenceObservedAtHkt', 'holdings', 'methodId', 'policyFingerprint', 'schemaVersion', 'scopeFingerprint', 'sourceFingerprint', 't0DateHkt', 'valuationCalendarFingerprint', 'valuationCutoffAtHkt'];
const HOLDING_KEYS = ['accountKey', 'holdingId', 'instrumentId', 'quantity', 'sourceFingerprint', 'unitPriceUsd', 'valuationAsOfHkt', 'valuationEvidenceFingerprint'];
const PUBLIC_KEYS = ['baselineStatus', 'checkpointHash', 'commitmentAlgorithm', 'commitmentKeyId', 'entryCount', 'ledgerId', 'methodId', 'mode', 'previousCheckpointHash', 'previousPrivateHeadCommitment', 'privateHeadCommitment', 'schemaVersion', 't0DateHkt'];

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

function exactKeys(value, keys, label) {
  if (!isRecord(value) || Object.keys(value).length !== keys.length
      || keys.some(key => !Object.prototype.hasOwnProperty.call(value, key))) {
    throw new Error(`${label} has an unknown, missing, or private field`);
  }
}

function canonicalize(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('ETF ledger canonical JSON forbids non-finite numbers');
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) throw new Error('ETF ledger canonical JSON requires plain JSON values');
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
}

export const canonicalEtfLedgerJson = value => JSON.stringify(canonicalize(value));
export const serializeCanonicalEtfLedger = value => `${canonicalEtfLedgerJson(value)}\n`;
const sha256 = value => createHash('sha256').update(String(value)).digest('hex');
const validHash = value => typeof value === 'string' && HASH_RE.test(value);

function validHktTimestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/.test(value)) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds)
    && new Date(milliseconds + 8 * 60 * 60 * 1000).toISOString().slice(0, 19) === value.slice(0, 19);
}

function epoch(value, label) {
  if (!validHktTimestamp(value)) throw new Error(`${label} must be an exact +08:00 timestamp`);
  return Date.parse(value);
}

function normalizeNow(now) {
  const value = now instanceof Date ? now.getTime() : typeof now === 'number' ? now : Date.now();
  if (!Number.isFinite(value)) throw new Error('ETF evidence validation requires a valid current time');
  return value;
}

function parseDecimal(value, label, { positive = false } = {}) {
  if (typeof value !== 'string' || !DECIMAL_RE.test(value)) {
    throw new Error(`${label} must be a canonical decimal string with at most 8 places`);
  }
  const [whole, fraction = ''] = value.split('.');
  const scale = 10n ** BigInt(fraction.length);
  const units = BigInt(whole) * scale + BigInt(fraction || '0');
  if (positive && units === 0n) throw new Error(`${label} must be positive`);
  return { units, scale };
}

function lineValueCents(quantityText, priceText) {
  const quantity = parseDecimal(quantityText, 'holding.quantity', { positive: true });
  const price = parseDecimal(priceText, 'holding.unitPriceUsd', { positive: true });
  const numerator = quantity.units * price.units * 100n;
  const denominator = quantity.scale * price.scale;
  return (numerator + denominator / 2n) / denominator;
}

export function validateBaselineEvidenceManifest(manifest, { now } = {}) {
  exactKeys(manifest, EVIDENCE_KEYS, 'ETF baseline evidence manifest');
  if (manifest.schemaVersion !== 1 || manifest.evidenceId !== ETF_BASELINE_EVIDENCE_ID
      || manifest.methodId !== ETF_ABC_METHOD_ID || manifest.t0DateHkt !== ETF_ABC_T0_DATE
      || manifest.currency !== 'USD' || manifest.policyFingerprint !== ETF_ABC_POLICY_FINGERPRINT
      || !validHash(manifest.scopeFingerprint) || !validHash(manifest.sourceFingerprint)
      || !validHash(manifest.valuationCalendarFingerprint)) {
    throw new Error('ETF baseline evidence identity, policy, scope, source, or calendar is invalid');
  }
  const cutoff = epoch(manifest.valuationCutoffAtHkt, 'valuationCutoffAtHkt');
  const observed = epoch(manifest.evidenceObservedAtHkt, 'evidenceObservedAtHkt');
  if (manifest.valuationCutoffAtHkt !== T0_COMMON_CUTOFF_HKT
      || observed < cutoff || observed > normalizeNow(now)) {
    throw new Error('ETF baseline evidence must use the completed T0 common cutoff and cannot be future evidence');
  }
  if (!Array.isArray(manifest.holdings) || manifest.holdings.length === 0) {
    throw new Error('ETF baseline evidence requires a non-empty A holdings inventory');
  }
  const ids = new Set();
  for (const [index, holding] of manifest.holdings.entries()) {
    exactKeys(holding, HOLDING_KEYS, `ETF baseline holding ${index}`);
    const valuationAsOf = epoch(holding.valuationAsOfHkt, `holdings[${index}].valuationAsOfHkt`);
    if (!ID_RE.test(holding.accountKey) || !ID_RE.test(holding.holdingId) || !ID_RE.test(holding.instrumentId)
        || ids.has(holding.holdingId) || (index > 0 && manifest.holdings[index - 1].holdingId >= holding.holdingId)
        || valuationAsOf < Date.parse(`${ETF_ABC_T0_DATE}T00:00:00+08:00`) || valuationAsOf > cutoff
        || !validHash(holding.sourceFingerprint) || !validHash(holding.valuationEvidenceFingerprint)) {
      throw new Error('ETF baseline holdings must be unique, sorted, source-bound, and valuation-bound');
    }
    ids.add(holding.holdingId);
    parseDecimal(holding.quantity, `holdings[${index}].quantity`, { positive: true });
    parseDecimal(holding.unitPriceUsd, `holdings[${index}].unitPriceUsd`, { positive: true });
  }
  return manifest;
}

export function deriveBaselineFromEvidence(manifest, options = {}) {
  validateBaselineEvidenceManifest(manifest, options);
  const identity = manifest.holdings.map(holding => ({
    accountKey: holding.accountKey, holdingId: holding.holdingId, instrumentId: holding.instrumentId,
    quantity: holding.quantity, sourceFingerprint: holding.sourceFingerprint,
  }));
  const holdingsFingerprint = sha256(canonicalEtfLedgerJson(identity));
  const totalCents = manifest.holdings.reduce(
    (sum, holding) => sum + lineValueCents(holding.quantity, holding.unitPriceUsd), 0n,
  );
  if (totalCents < 1n || totalCents > 100000000000000n) throw new Error('Derived ETF T0 value is outside the accepted positive range');
  return {
    evidenceManifestFingerprint: sha256(canonicalEtfLedgerJson(manifest)),
    holdingsFingerprint,
    valueUsd: Number(totalCents) / 100,
  };
}

function unsignedEntry(entry) {
  return { entryType: entry.entryType, payload: entry.payload, previousEntryHash: entry.previousEntryHash, sequence: entry.sequence };
}
const sealEntry = entry => ({ ...entry, entryHash: sha256(canonicalEtfLedgerJson(unsignedEntry(entry))) });

function pendingPayload() {
  return {
    status: 'pending', baselineDateHkt: ETF_ABC_T0_DATE,
    evidenceManifest: null, evidenceManifestFingerprint: null,
    aHoldingsFingerprint: null, bHoldingsFingerprint: null,
    aValueUsd: null, bValueUsd: null,
  };
}

function validatePendingPayload(payload) {
  exactKeys(payload, BASELINE_PAYLOAD_KEYS, 'pending baseline payload');
  if (payload.status !== 'pending' || payload.baselineDateHkt !== ETF_ABC_T0_DATE
      || Object.entries(payload).some(([key, value]) => !['status', 'baselineDateHkt'].includes(key) && value !== null)) {
    throw new Error('Pending baseline must remain at T0 without invented evidence or values');
  }
}

function validateEstablishedPayload(payload, options) {
  exactKeys(payload, BASELINE_PAYLOAD_KEYS, 'established baseline payload');
  if (payload.status !== 'established' || payload.baselineDateHkt !== ETF_ABC_T0_DATE || !isRecord(payload.evidenceManifest)) {
    throw new Error('Established baseline must be derived from an embedded canonical evidence manifest');
  }
  const derived = deriveBaselineFromEvidence(payload.evidenceManifest, options);
  if (payload.evidenceManifestFingerprint !== derived.evidenceManifestFingerprint
      || payload.aHoldingsFingerprint !== derived.holdingsFingerprint
      || payload.bHoldingsFingerprint !== derived.holdingsFingerprint
      || payload.aValueUsd !== derived.valueUsd || payload.bValueUsd !== derived.valueUsd) {
    throw new Error('Established baseline values and B clone must be code-derived from private evidence');
  }
}

function validateEntry(entry, index, previousHash, options) {
  exactKeys(entry, ENTRY_KEYS, `private ledger record ${index}`);
  if (entry.sequence !== index || entry.previousEntryHash !== previousHash || !validHash(entry.entryHash)
      || entry.entryHash !== sha256(canonicalEtfLedgerJson(unsignedEntry(entry)))) {
    throw new Error('ETF private ledger hash-chain continuity is invalid');
  }
  if (index === 0 && entry.entryType === 'baseline-pending' && entry.previousEntryHash === null) {
    validatePendingPayload(entry.payload);
    return;
  }
  if (index === 1 && entry.entryType === 'baseline-established') {
    validateEstablishedPayload(entry.payload, options);
    return;
  }
  throw new Error('ETF private ledger v1 permits only pending genesis and one evidence-derived establishment');
}

export function createInitialPrivateEtfLedger() {
  const genesis = sealEntry({ entryType: 'baseline-pending', payload: pendingPayload(), previousEntryHash: null, sequence: 0 });
  return {
    schemaVersion: ETF_LEDGER_SCHEMA_VERSION, ledgerId: ETF_LEDGER_ID,
    methodId: ETF_ABC_METHOD_ID, mode: ETF_LEDGER_PRIVATE_MODE,
    t0DateHkt: ETF_ABC_T0_DATE, baselineStatus: 'pending', records: [genesis], headHash: genesis.entryHash,
  };
}

export function validatePrivateEtfLedger(ledger, options = {}) {
  exactKeys(ledger, LEDGER_KEYS, 'private ETF ledger');
  if (ledger.schemaVersion !== ETF_LEDGER_SCHEMA_VERSION || ledger.ledgerId !== ETF_LEDGER_ID
      || ledger.methodId !== ETF_ABC_METHOD_ID || ledger.mode !== ETF_LEDGER_PRIVATE_MODE
      || ledger.t0DateHkt !== ETF_ABC_T0_DATE || !Array.isArray(ledger.records)
      || ledger.records.length < 1 || ledger.records.length > 2) throw new Error('ETF private ledger identity or v1 record count is invalid');
  let previousHash = null;
  const hashes = new Set();
  ledger.records.forEach((entry, index) => {
    validateEntry(entry, index, previousHash, options);
    if (hashes.has(entry.entryHash)) throw new Error('ETF private ledger repeats an entry hash');
    hashes.add(entry.entryHash);
    previousHash = entry.entryHash;
  });
  const expectedStatus = ledger.records.length === 1 ? 'pending' : 'established';
  if (ledger.baselineStatus !== expectedStatus || ledger.headHash !== previousHash) throw new Error('ETF private ledger head or derived baseline status is invalid');
  return ledger;
}

export function appendEstablishedBaseline(ledger, evidenceManifest, options = {}) {
  validatePrivateEtfLedger(ledger, options);
  if (ledger.baselineStatus !== 'pending' || ledger.records.length !== 1) throw new Error('ETF T0 baseline can be established only once');
  const derived = deriveBaselineFromEvidence(evidenceManifest, options);
  const entry = sealEntry({
    entryType: 'baseline-established', previousEntryHash: ledger.headHash, sequence: 1,
    payload: {
      status: 'established', baselineDateHkt: ETF_ABC_T0_DATE,
      evidenceManifest: canonicalize(evidenceManifest), evidenceManifestFingerprint: derived.evidenceManifestFingerprint,
      aHoldingsFingerprint: derived.holdingsFingerprint, bHoldingsFingerprint: derived.holdingsFingerprint,
      aValueUsd: derived.valueUsd, bValueUsd: derived.valueUsd,
    },
  });
  return validatePrivateEtfLedger({
    ...ledger, baselineStatus: 'established', records: [...ledger.records, entry], headHash: entry.entryHash,
  }, options);
}

export function validatePrivateEtfLedgerContinuity(previous, next, options = {}) {
  validatePrivateEtfLedger(previous, options);
  validatePrivateEtfLedger(next, options);
  for (const key of ['schemaVersion', 'ledgerId', 'methodId', 'mode', 't0DateHkt']) {
    if (previous[key] !== next[key]) throw new Error('ETF private ledger identity changed across append');
  }
  if (next.records.length < previous.records.length) throw new Error('ETF private ledger history was truncated');
  previous.records.forEach((entry, index) => {
    if (canonicalEtfLedgerJson(entry) !== canonicalEtfLedgerJson(next.records[index])) throw new Error('ETF private ledger history is not an immutable ordered prefix');
  });
  return next;
}

function normalizeSecret(secret) {
  if (!(Buffer.isBuffer(secret) || secret instanceof Uint8Array) || secret.byteLength < 32) {
    throw new Error('ETF checkpoint HMAC requires a private random secret of at least 32 bytes');
  }
  return Buffer.from(secret);
}
const hmac = (secret, domain, value) => createHmac('sha256', normalizeSecret(secret)).update(`${domain}\0${value}`).digest('hex');
const commitmentKeyId = secret => sha256(normalizeSecret(secret));
const headCommitment = (secret, ledger) => hmac(secret, 'xuan-etf-private-head-v1', canonicalEtfLedgerJson({
  entryCount: ledger.records.length,
  headHash: ledger.headHash,
  ledgerId: ledger.ledgerId,
  methodId: ledger.methodId,
  t0DateHkt: ledger.t0DateHkt,
}));
const checkpointMac = (secret, state) => hmac(secret, 'xuan-etf-public-checkpoint-v1', canonicalEtfLedgerJson(state));
const unsignedCheckpoint = checkpoint => {
  const { checkpointHash, ...unsigned } = checkpoint;
  return unsigned;
};

export function validatePublicEtfLedgerCheckpoint(checkpoint) {
  exactKeys(checkpoint, PUBLIC_KEYS, 'public ETF ledger checkpoint');
  if (checkpoint.schemaVersion !== 1 || checkpoint.ledgerId !== ETF_LEDGER_ID
      || checkpoint.methodId !== ETF_ABC_METHOD_ID || checkpoint.mode !== ETF_LEDGER_PUBLIC_MODE
      || checkpoint.t0DateHkt !== ETF_ABC_T0_DATE || checkpoint.commitmentAlgorithm !== ETF_LEDGER_COMMITMENT_ALGORITHM
      || !validHash(checkpoint.commitmentKeyId)
      || !['pending', 'established'].includes(checkpoint.baselineStatus)
      || !Number.isSafeInteger(checkpoint.entryCount) || ![1, 2].includes(checkpoint.entryCount)
      || !validHash(checkpoint.privateHeadCommitment) || !validHash(checkpoint.checkpointHash)
      || (checkpoint.previousCheckpointHash !== null && !validHash(checkpoint.previousCheckpointHash))
      || (checkpoint.previousPrivateHeadCommitment !== null && !validHash(checkpoint.previousPrivateHeadCommitment))
      || (checkpoint.baselineStatus === 'pending' && checkpoint.entryCount !== 1)
      || (checkpoint.baselineStatus === 'established' && checkpoint.entryCount !== 2)) throw new Error('Public ETF ledger checkpoint is invalid');
  const nullLinks = checkpoint.previousCheckpointHash === null && checkpoint.previousPrivateHeadCommitment === null;
  const hashLinks = validHash(checkpoint.previousCheckpointHash) && validHash(checkpoint.previousPrivateHeadCommitment);
  if (!nullLinks && !hashLinks) throw new Error('Public ETF checkpoint predecessor links are incomplete');
  return checkpoint;
}

function verifyCheckpointMac(checkpoint, secret, privateLedger) {
  validatePublicEtfLedgerCheckpoint(checkpoint);
  const expectedMac = checkpointMac(secret, unsignedCheckpoint(checkpoint));
  if (!timingSafeEqual(Buffer.from(checkpoint.checkpointHash, 'hex'), Buffer.from(expectedMac, 'hex'))
      || checkpoint.commitmentKeyId !== commitmentKeyId(secret)
      || checkpoint.privateHeadCommitment !== headCommitment(secret, privateLedger)
      || checkpoint.baselineStatus !== privateLedger.baselineStatus || checkpoint.entryCount !== privateLedger.records.length) {
    throw new Error('Public ETF checkpoint HMAC or private-head binding is invalid');
  }
}

export function verifyPublicEtfLedgerCheckpoint(checkpoint, {
  commitmentSecret, privateLedger, previousCheckpoint = null, previousPrivateLedger = null, now,
} = {}) {
  validatePrivateEtfLedger(privateLedger, { now });
  const secret = normalizeSecret(commitmentSecret);
  verifyCheckpointMac(checkpoint, secret, privateLedger);
  if (previousCheckpoint === null || previousPrivateLedger === null) {
    if (previousCheckpoint !== null || previousPrivateLedger !== null || privateLedger.records.length !== 1
        || checkpoint.previousCheckpointHash !== null || checkpoint.previousPrivateHeadCommitment !== null) {
      throw new Error('Only the private pending genesis may start a checkpoint chain');
    }
    return checkpoint;
  }
  validatePrivateEtfLedger(previousPrivateLedger, { now });
  verifyCheckpointMac(previousCheckpoint, secret, previousPrivateLedger);
  validatePrivateEtfLedgerContinuity(previousPrivateLedger, privateLedger, { now });
  if (checkpoint.previousCheckpointHash !== previousCheckpoint.checkpointHash
      || checkpoint.previousPrivateHeadCommitment !== previousCheckpoint.privateHeadCommitment) {
    throw new Error('Public ETF checkpoint does not continue the previous private head and checkpoint');
  }
  return checkpoint;
}

export function projectPublicEtfLedgerCheckpoint(privateLedger, {
  commitmentSecret, previousCheckpoint = null, previousPrivateLedger = null, now,
} = {}) {
  validatePrivateEtfLedger(privateLedger, { now });
  const secret = normalizeSecret(commitmentSecret);
  if ((previousCheckpoint === null) !== (previousPrivateLedger === null)) throw new Error('Public ETF checkpoint requires both predecessor records or neither');
  if (previousPrivateLedger !== null) {
    verifyPublicEtfLedgerCheckpoint(previousCheckpoint, { commitmentSecret: secret, privateLedger: previousPrivateLedger, now });
    validatePrivateEtfLedgerContinuity(previousPrivateLedger, privateLedger, { now });
  } else if (privateLedger.records.length !== 1) throw new Error('An established checkpoint must continue the pending genesis checkpoint');
  const state = {
    schemaVersion: 1, ledgerId: ETF_LEDGER_ID, methodId: ETF_ABC_METHOD_ID,
    mode: ETF_LEDGER_PUBLIC_MODE, t0DateHkt: ETF_ABC_T0_DATE,
    commitmentAlgorithm: ETF_LEDGER_COMMITMENT_ALGORITHM,
    commitmentKeyId: commitmentKeyId(secret),
    baselineStatus: privateLedger.baselineStatus, entryCount: privateLedger.records.length,
    privateHeadCommitment: headCommitment(secret, privateLedger),
    previousPrivateHeadCommitment: previousCheckpoint?.privateHeadCommitment ?? null,
    previousCheckpointHash: previousCheckpoint?.checkpointHash ?? null,
  };
  const checkpoint = { ...state, checkpointHash: checkpointMac(secret, state) };
  return verifyPublicEtfLedgerCheckpoint(checkpoint, {
    commitmentSecret: secret, privateLedger, previousCheckpoint, previousPrivateLedger, now,
  });
}

function parseCanonical(json, validator, label, options) {
  if (typeof json !== 'string') throw new Error(`${label} must be canonical JSON text`);
  let parsed;
  try { parsed = JSON.parse(json); } catch { throw new Error(`${label} is not valid JSON`); }
  validator(parsed, options);
  if (serializeCanonicalEtfLedger(parsed) !== json) throw new Error(`${label} is not canonical JSON or contains duplicate/reordered fields`);
  return parsed;
}

export const parseCanonicalBaselineEvidenceManifest = (json, options) => parseCanonical(json, validateBaselineEvidenceManifest, 'ETF baseline evidence manifest', options);
export const parseCanonicalPrivateEtfLedger = (json, options) => parseCanonical(json, validatePrivateEtfLedger, 'Private ETF ledger', options);
export const parseCanonicalPublicEtfLedgerCheckpoint = json => parseCanonical(json, validatePublicEtfLedgerCheckpoint, 'Public ETF ledger checkpoint');

function resolveApprovedRoot(explicitRoot) {
  const requested = explicitRoot ?? process.env[ETF_LEDGER_PRIVATE_ROOT_ENV];
  if (typeof requested !== 'string' || !path.isAbsolute(requested)) throw new Error(`An absolute approved private root is required via argument or ${ETF_LEDGER_PRIVATE_ROOT_ENV}`);
  const requestedStat = fs.lstatSync(requested);
  if (requestedStat.isSymbolicLink()) throw new Error('Approved ETF private root cannot be a symbolic link');
  const root = fs.realpathSync(requested);
  const stat = fs.statSync(root);
  const repositoryRelative = path.relative(PUBLIC_REPOSITORY_ROOT, root);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700
      || repositoryRelative === ''
      || (!repositoryRelative.startsWith(`..${path.sep}`) && !path.isAbsolute(repositoryRelative))) {
    throw new Error('Approved ETF private root must be an external current-user-owned, owner-only 0700 directory');
  }
  return root;
}

function secureReadPrivateFile(filePath, approvedRoot) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) throw new Error('ETF private file path must be absolute');
  const root = resolveApprovedRoot(approvedRoot);
  const normalized = path.resolve(filePath);
  // macOS exposes /var through /private/var. Compare the resolved parent so a
  // legitimate direct child remains usable without weakening the direct-child
  // boundary or following a symlink at the private file itself.
  if (fs.realpathSync(path.dirname(normalized)) !== root) {
    throw new Error('ETF private file must be a direct child of the approved private root');
  }
  const lst = fs.lstatSync(filePath);
  if (!lst.isFile() || lst.isSymbolicLink() || lst.uid !== process.getuid()
      || (lst.mode & 0o777) !== 0o600 || lst.nlink !== 1
      || lst.size < 1 || lst.size > MAX_PRIVATE_FILE_BYTES) {
    throw new Error('ETF private file must be a nonempty, single-link, regular, current-user-owned 0600 file within the size limit');
  }
  const realFile = fs.realpathSync(filePath);
  const relative = path.relative(root, realFile);
  if (relative === '' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('ETF private file must remain under the approved private root');
  if (typeof fs.constants.O_NOFOLLOW !== 'number') throw new Error('ETF private file loading requires O_NOFOLLOW support');
  const fd = fs.openSync(realFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.uid !== process.getuid() || (before.mode & 0o777) !== 0o600
        || before.nlink !== 1 || before.size < 1 || before.size > MAX_PRIVATE_FILE_BYTES
        || before.dev !== lst.dev || before.ino !== lst.ino) {
      throw new Error('ETF private file changed or failed secure descriptor validation');
    }
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count === 0) throw new Error('ETF private file ended before its validated size');
      offset += count;
    }
    const after = fs.fstatSync(fd);
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
        || after.mode !== before.mode || after.nlink !== before.nlink) {
      throw new Error('ETF private file changed during secure read');
    }
    return bytes;
  } finally {
    fs.closeSync(fd);
  }
}

export function loadPrivateBaselineEvidenceManifest(filePath, { approvedRoot, now } = {}) {
  return parseCanonicalBaselineEvidenceManifest(secureReadPrivateFile(filePath, approvedRoot).toString('utf8'), { now });
}
export function loadPrivateEtfLedger(filePath, { approvedRoot, now } = {}) {
  return parseCanonicalPrivateEtfLedger(secureReadPrivateFile(filePath, approvedRoot).toString('utf8'), { now });
}
export function loadPrivateCommitmentSecret(filePath, { approvedRoot } = {}) {
  return normalizeSecret(secureReadPrivateFile(filePath, approvedRoot));
}

function isDirectRun() {
  return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isDirectRun()) {
  const [command, filePath, rootFlag, approvedRoot] = process.argv.slice(2);
  try {
    if (rootFlag !== '--private-root' || !approvedRoot) throw new Error('A --private-root path is mandatory');
    if (command === '--check-private') {
      const ledger = loadPrivateEtfLedger(filePath, { approvedRoot });
      process.stdout.write(`ok private-ledger entries=${ledger.records.length} baseline=${ledger.baselineStatus}\n`);
    } else if (command === '--check-evidence') {
      const evidence = loadPrivateBaselineEvidenceManifest(filePath, { approvedRoot });
      const derived = deriveBaselineFromEvidence(evidence);
      process.stdout.write(`ok private-evidence holdings=${evidence.holdings.length} fingerprint=${derived.evidenceManifestFingerprint}\n`);
    } else throw new Error('usage: --check-private PATH --private-root ROOT | --check-evidence PATH --private-root ROOT');
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
