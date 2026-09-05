import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// This is a bounded, one-run evidence helper. The store prevents accidental
// replay within one caller-controlled filesystem; it is not cryptographic
// authentication and makes no cross-store replay claim.

export const MANUAL_CONSENT_WINDOW_MS = 20 * 60 * 1000;

const ACCOUNT_ID = 'U6859001';
const PROVIDER = 'Anthropic';
const EDITION = 'adhoc';
const PROOF_KIND = 'xuan-ib-manual-consent';
const VERSION = 1;
const HASH = /^[a-f0-9]{64}$/;
const SHA = /^[a-f0-9]{40}$/;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const MAX_FILE_BYTES = 512 * 1024;
const RUN_STAGES = new Set([
  'bootstrap', 'ib-read', 'sharesight-read', 'validate', 'derive',
  'narrative', 'render', 'guard', 'candidate-prep'
]);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const fail = message => {
  throw new Error(`XUAN-IB manual consent: ${message}`);
};

const plainObject = value => value !== null && typeof value === 'object'
  && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

const exactKeys = (value, required, optional, label) => {
  if (!plainObject(value)) fail(`${label} must be a plain object`);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`${label} contains unknown field ${key}`);
  for (const key of required) if (!Object.hasOwn(value, key)) fail(`${label} is missing ${key}`);
};

const canonicalize = value => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('canonical value contains a non-finite number');
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!plainObject(value)) fail('canonical value contains a non-plain object');
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
};

const canonicalJson = value => JSON.stringify(canonicalize(value));
const sha256 = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const fingerprint = value => sha256(canonicalJson(value));
const clone = value => JSON.parse(canonicalJson(value));

const assertHash = (value, label) => {
  if (typeof value !== 'string' || !HASH.test(value)) fail(`${label} must be lowercase SHA-256`);
};

const assertSha = (value, label = 'previousSourceSha') => {
  if (typeof value !== 'string' || !SHA.test(value)) fail(`${label} must be a lowercase 40-character commit hash`);
};

const assertNow = (value, label = 'now') => {
  if (!Number.isSafeInteger(value) || value < 0 || !Number.isFinite(new Date(value).getTime())) {
    fail(`${label} must be finite epoch milliseconds`);
  }
  return value;
};

const parseCanonicalInstant = (value, label) => {
  if (typeof value !== 'string') fail(`${label} must be a canonical UTC instant`);
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== value) {
    fail(`${label} must be a canonical UTC instant`);
  }
  return epoch;
};

const iso = epoch => new Date(assertNow(epoch)).toISOString();

const validateObservation = observation => {
  exactKeys(observation, [
    'accountId', 'provider', 'consentRowObserved', 'singleConsentRow',
    'claudeEnabled', 'otherAiDisabled', 'humanAttested', 'attester', 'observedAt'
  ], [], 'observation');
  if (observation.accountId !== ACCOUNT_ID) fail('observation account is outside the approved scope');
  if (observation.provider !== PROVIDER) fail('observation provider must be Anthropic');
  for (const key of [
    'consentRowObserved', 'singleConsentRow', 'claudeEnabled',
    'otherAiDisabled', 'humanAttested'
  ]) {
    if (observation[key] !== true) fail(`observation ${key} must be explicitly true`);
  }
  if (observation.attester !== 'owner-approved-operator') fail('observation attester is invalid');
  parseCanonicalInstant(observation.observedAt, 'observation.observedAt');
  return clone(observation);
};

const eventKeys = {
  init: ['v', 'seq', 'type', 'wallMs', 'monotonicMs'],
  'stage-start': ['v', 'seq', 'type', 'stage', 'wallMs', 'monotonicMs'],
  'stage-finish': [
    'v', 'seq', 'type', 'stage', 'wallMs', 'monotonicMs', 'status', 'cacheHit', 'errorCode'
  ],
  'source-bind': ['v', 'seq', 'type', 'sourceSha', 'wallMs', 'monotonicMs']
};

const secureFileStat = (filePath, label) => {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    fail(`${label} cannot be opened (${error?.code ?? 'IO_ERROR'})`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${label} must be a regular non-symlink file`);
  if ((stat.mode & 0o777) !== 0o600) fail(`${label} permissions must be 0600`);
  if (stat.size <= 0 || stat.size > MAX_FILE_BYTES) fail(`${label} size is invalid`);
  return stat;
};

const readCanonicalLines = (filePath, label) => {
  secureFileStat(filePath, label);
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    fail(`${label} cannot be read (${error?.code ?? 'IO_ERROR'})`);
  }
  if (!content.endsWith('\n')) fail(`${label} has a partial final record`);
  const lines = content.slice(0, -1).split('\n');
  if (!lines.length || lines.some(line => !line)) fail(`${label} contains an empty record`);
  return lines.map((line, index) => {
    let value;
    try { value = JSON.parse(line); } catch { fail(`${label} record ${index} is not valid JSON`); }
    if (JSON.stringify(value) !== line) fail(`${label} record ${index} is not canonical`);
    return value;
  });
};

const readJournal = journalPath => {
  if (typeof journalPath !== 'string' || !journalPath) fail('journalPath is required');
  const events = readCanonicalLines(journalPath, 'journal');
  const active = new Set(), completed = new Map();
  let init = null, lastMonotonic = null, sourceBound = false;
  for (const [index, event] of events.entries()) {
    if (!plainObject(event) || typeof event.type !== 'string' || !eventKeys[event.type]) {
      fail(`journal event ${index} has an unsupported type`);
    }
    exactKeys(event, eventKeys[event.type], [], `journal event ${index}`);
    if (event.v !== 1 || event.seq !== index) fail(`journal event ${index} has invalid version or sequence`);
    assertNow(event.wallMs, `journal event ${index} wallMs`);
    assertNow(event.monotonicMs, `journal event ${index} monotonicMs`);
    if (index === 0) {
      if (event.type !== 'init') fail('journal must begin with init');
      init = event;
      lastMonotonic = event.monotonicMs;
      continue;
    }
    if (event.type === 'init') fail('journal contains duplicate init');
    if (event.wallMs < init.wallMs || event.monotonicMs < lastMonotonic) {
      fail(`journal event ${index} precedes prior journal evidence`);
    }
    if (event.type === 'stage-start') {
      if (!RUN_STAGES.has(event.stage)) fail(`journal event ${index} has an unknown stage`);
      if (active.has(event.stage) || completed.has(event.stage)) fail(`journal repeats stage ${event.stage}`);
      active.add(event.stage);
    } else if (event.type === 'stage-finish') {
      if (!RUN_STAGES.has(event.stage) || !active.has(event.stage)) fail(`journal finish for ${event.stage} is invalid`);
      if (!['ok', 'degraded', 'failed'].includes(event.status) || typeof event.cacheHit !== 'boolean') {
        fail(`journal finish for ${event.stage} has invalid status`);
      }
      if (['ib-read', 'sharesight-read'].includes(event.stage) && event.cacheHit) {
        fail(`journal finish for ${event.stage} cannot be a cache hit`);
      }
      if ((event.status === 'ok' && event.errorCode !== null)
        || (event.status !== 'ok' && (typeof event.errorCode !== 'string' || !ERROR_CODE.test(event.errorCode)))) {
        fail(`journal finish for ${event.stage} has invalid errorCode`);
      }
      active.delete(event.stage);
      completed.set(event.stage, { status: event.status, errorCode: event.errorCode });
    } else if (event.type === 'source-bind') {
      assertSha(event.sourceSha, 'journal sourceSha');
      if (sourceBound) fail('journal repeats source binding');
      sourceBound = true;
    }
    lastMonotonic = event.monotonicMs;
  }
  return {
    events,
    initWallMs: init.wallMs,
    latestWallMs: Math.max(...events.map(event => event.wallMs)),
    runId: sha256(JSON.stringify(init)),
    active,
    completed,
    started: new Set(events.filter(event => event.type === 'stage-start').map(event => event.stage)),
    sourceBound
  };
};

export function getManualConsentRunId(journalPath) {
  return readJournal(journalPath).runId;
}

const proofWithoutId = proof => Object.fromEntries(
  Object.entries(proof).filter(([key]) => key !== 'proofId')
);

export function validateManualConsentProof(proof, context) {
  exactKeys(context, ['journalRunId', 'previousSourceSha', 'edition', 'requireUnexpired'], ['now'], 'context');
  if (typeof context.requireUnexpired !== 'boolean') fail('context.requireUnexpired must be boolean');
  if (context.requireUnexpired && !Object.hasOwn(context, 'now')) {
    fail('context.now is required for live validation');
  }
  if (Object.hasOwn(context, 'now')) assertNow(context.now, 'context.now');
  assertHash(context.journalRunId, 'context.journalRunId');
  assertSha(context.previousSourceSha, 'context.previousSourceSha');
  if (context.edition !== EDITION) fail('context.edition must be adhoc');

  exactKeys(proof, [
    'schemaVersion', 'kind', 'runId', 'edition', 'previousSourceSha',
    'observedAt', 'issuedAt', 'expiresAt',
    'observationFingerprint', 'proofId'
  ], [], 'proof');
  if (proof.schemaVersion !== VERSION || proof.kind !== PROOF_KIND) fail('proof version or kind is invalid');
  assertHash(proof.runId, 'proof.runId');
  assertSha(proof.previousSourceSha, 'proof.previousSourceSha');
  assertHash(proof.observationFingerprint, 'proof.observationFingerprint');
  assertHash(proof.proofId, 'proof.proofId');
  if (proof.edition !== EDITION) fail('proof edition is invalid');
  const observed = parseCanonicalInstant(proof.observedAt, 'proof.observedAt');
  const issued = parseCanonicalInstant(proof.issuedAt, 'proof.issuedAt');
  const expires = parseCanonicalInstant(proof.expiresAt, 'proof.expiresAt');
  if (issued < observed || issued >= expires || expires !== observed + MANUAL_CONSENT_WINDOW_MS) {
    fail('proof time window is invalid');
  }
  if (proof.runId !== context.journalRunId) fail('proof belongs to a different run');
  if (proof.previousSourceSha !== context.previousSourceSha) fail('proof previousSourceSha does not match');
  if (proof.edition !== context.edition) fail('proof edition does not match');
  if (sha256(canonicalJson(proofWithoutId(proof))) !== proof.proofId) fail('proofId does not match proof claims');
  if (context.requireUnexpired) {
    if (context.now < issued) fail('proof is not yet valid');
    if (context.now >= expires) fail('proof has expired');
  }
  return clone(proof);
}

const assertOutsideRepo = storePath => {
  const resolved = path.resolve(storePath);
  if (resolved === REPO_ROOT || resolved.startsWith(`${REPO_ROOT}${path.sep}`)) {
    fail('storePath must be outside the repository');
  }
  return resolved;
};

const assertNoSymlinkComponents = target => {
  const resolved = path.resolve(target);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  for (const component of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    if (!fs.existsSync(current)) break;
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) fail('private store path cannot contain symlinks');
  }
};

const ensurePrivateDirectory = storePath => {
  const directory = path.dirname(storePath);
  assertNoSymlinkComponents(path.dirname(directory));
  if (!fs.existsSync(directory)) {
    try { fs.mkdirSync(directory, { mode: 0o700 }); }
    catch (error) { fail(`private store directory cannot be created (${error?.code ?? 'IO_ERROR'})`); }
  }
  assertNoSymlinkComponents(directory);
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('private store parent must be a non-symlink directory');
  if ((stat.mode & 0o777) !== 0o700) fail('private store directory permissions must be 0700');
};

const storeInit = createdAt => ({ v: VERSION, seq: 0, type: 'store-init', createdAt });

const writeNewStore = (storePath, event) => {
  const line = Buffer.from(`${JSON.stringify(event)}\n`);
  let descriptor;
  try {
    descriptor = fs.openSync(storePath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    fs.fchmodSync(descriptor, 0o600);
    if (fs.writeSync(descriptor, line, 0, line.length, null) !== line.length) fail('store initialization was partial');
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (String(error?.message).startsWith('XUAN-IB manual consent:')) throw error;
    fail(`store initialization failed (${error?.code ?? 'IO_ERROR'})`);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
};

const reserveKeys = ['v', 'seq', 'type', 'observationFingerprint', 'observation', 'proof'];
const consumeKeys = [
  'v', 'seq', 'type', 'observationFingerprint', 'proofId', 'runId',
  'sourceEvidenceFingerprint', 'consumedAt'
];

const readStore = storePath => {
  const records = readCanonicalLines(storePath, 'private store');
  const reservations = new Map(), proofIds = new Set(), consumed = new Set();
  for (const [index, record] of records.entries()) {
    if (index === 0) {
      exactKeys(record, ['v', 'seq', 'type', 'createdAt'], [], 'private store init');
      if (record.v !== VERSION || record.seq !== 0 || record.type !== 'store-init') fail('private store init is invalid');
      parseCanonicalInstant(record.createdAt, 'private store createdAt');
      continue;
    }
    if (record?.type === 'reserve') {
      exactKeys(record, reserveKeys, [], `private store record ${index}`);
      if (record.v !== VERSION || record.seq !== index) fail(`private store record ${index} sequence is invalid`);
      const observation = validateObservation(record.observation);
      const observationFingerprint = fingerprint(observation);
      if (record.observationFingerprint !== observationFingerprint) fail('private store observation fingerprint is invalid');
      validateManualConsentProof(record.proof, {
        journalRunId: record.proof.runId,
        previousSourceSha: record.proof.previousSourceSha,
        edition: record.proof.edition,
        requireUnexpired: false
      });
      if (record.proof.observationFingerprint !== observationFingerprint) fail('private store proof is not bound to observation');
      if (reservations.has(observationFingerprint) || proofIds.has(record.proof.proofId)) fail('private store repeats a reservation');
      reservations.set(observationFingerprint, record);
      proofIds.add(record.proof.proofId);
    } else if (record?.type === 'consume') {
      exactKeys(record, consumeKeys, [], `private store record ${index}`);
      if (record.v !== VERSION || record.seq !== index) fail(`private store record ${index} sequence is invalid`);
      assertHash(record.observationFingerprint, 'private store observationFingerprint');
      assertHash(record.proofId, 'private store proofId');
      assertHash(record.runId, 'private store runId');
      assertHash(record.sourceEvidenceFingerprint, 'private store sourceEvidenceFingerprint');
      parseCanonicalInstant(record.consumedAt, 'private store consumedAt');
      const reservation = reservations.get(record.observationFingerprint);
      if (!reservation || reservation.proof.proofId !== record.proofId || reservation.proof.runId !== record.runId) {
        fail('private store consume has no matching reservation');
      }
      if (consumed.has(record.proofId)) fail('private store repeats a consume marker');
      consumed.add(record.proofId);
    } else {
      fail(`private store record ${index} has an unsupported type`);
    }
  }
  return { records, reservations, proofIds, consumed };
};

const appendStore = (storePath, record) => {
  const line = Buffer.from(`${JSON.stringify(record)}\n`);
  let descriptor;
  try {
    descriptor = fs.openSync(storePath, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) fail('private store changed before append');
    if (fs.writeSync(descriptor, line, 0, line.length, null) !== line.length) fail('private store append was partial');
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (String(error?.message).startsWith('XUAN-IB manual consent:')) throw error;
    fail(`private store append failed (${error?.code ?? 'IO_ERROR'})`);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
};

const withStoreLock = (rawStorePath, now, operation) => {
  if (typeof rawStorePath !== 'string' || !rawStorePath) fail('storePath is required');
  const storePath = assertOutsideRepo(rawStorePath);
  ensurePrivateDirectory(storePath);
  if (fs.existsSync(storePath)) secureFileStat(storePath, 'private store');
  const lockPath = `${storePath}.lock`;
  let descriptor;
  try {
    descriptor = fs.openSync(lockPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    fs.fchmodSync(descriptor, 0o600);
  } catch (error) {
    fail(`private store is locked (${error?.code ?? 'IO_ERROR'})`);
  }
  try {
    if (!fs.existsSync(storePath)) writeNewStore(storePath, storeInit(iso(now)));
    const state = readStore(storePath);
    return operation({ storePath, state });
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try { fs.unlinkSync(lockPath); } catch (error) { fail(`private store lock cleanup failed (${error?.code ?? 'IO_ERROR'})`); }
  }
};

const makeProof = ({ runId, previousSourceSha, observedAt, issuedAt, observationFingerprint }) => {
  const proof = {
    schemaVersion: VERSION,
    kind: PROOF_KIND,
    runId,
    edition: EDITION,
    previousSourceSha,
    observedAt,
    issuedAt,
    expiresAt: iso(parseCanonicalInstant(observedAt, 'observedAt') + MANUAL_CONSENT_WINDOW_MS),
    observationFingerprint
  };
  return { ...proof, proofId: sha256(canonicalJson(proof)) };
};

export function issueManualConsent(input) {
  exactKeys(input, ['observation', 'journalPath', 'previousSourceSha', 'storePath'], ['now'], 'issue input');
  const now = assertNow(input.now ?? Date.now());
  assertSha(input.previousSourceSha);
  const observation = validateObservation(input.observation);
  const observedAt = parseCanonicalInstant(observation.observedAt, 'observation.observedAt');
  const journal = readJournal(input.journalPath);
  const bootstrap = journal.completed.get('bootstrap');
  const nonBootstrapStarted = [...journal.started].filter(stage => stage !== 'bootstrap');
  if (!bootstrap || bootstrap.status !== 'ok' || journal.active.size
    || nonBootstrapStarted.length || journal.sourceBound) {
    fail('manual consent requires completed ok bootstrap before any other stage starts');
  }
  if (now < journal.latestWallMs) fail('manual consent issue time precedes journal evidence');
  if (observedAt < journal.initWallMs || now < journal.initWallMs) fail('manual consent observation is outside the run journal');
  if (observedAt > now) fail('manual consent observation is in the future');
  if (now >= observedAt + MANUAL_CONSENT_WINDOW_MS) fail('manual consent observation has expired');

  const observationFingerprint = fingerprint(observation);
  const proof = makeProof({
    runId: journal.runId,
    previousSourceSha: input.previousSourceSha,
    observedAt: observation.observedAt,
    issuedAt: iso(now),
    observationFingerprint
  });
  validateManualConsentProof(proof, {
    journalRunId: journal.runId,
    previousSourceSha: input.previousSourceSha,
    edition: EDITION,
    requireUnexpired: true,
    now
  });

  return withStoreLock(input.storePath, now, ({ storePath, state }) => {
    if (state.reservations.has(observationFingerprint) || state.proofIds.has(proof.proofId)) {
      fail('manual consent observation has already been issued');
    }
    appendStore(storePath, {
      v: VERSION,
      seq: state.records.length,
      type: 'reserve',
      observationFingerprint,
      observation,
      proof
    });
    return clone(proof);
  });
}

export function consumeManualConsent(input) {
  exactKeys(input, [
    'proof', 'journalPath', 'previousSourceSha', 'edition', 'storePath',
    'sourceEvidenceFingerprint'
  ], ['now'], 'consume input');
  const now = assertNow(input.now ?? Date.now());
  assertSha(input.previousSourceSha);
  assertHash(input.sourceEvidenceFingerprint, 'consume sourceEvidenceFingerprint');
  if (input.edition !== EDITION) fail('consume edition must be adhoc');
  const journal = readJournal(input.journalPath);
  if (now < journal.latestWallMs) fail('manual consent consume time precedes journal evidence');
  if (!journal.completed.has('ib-read')) fail('manual consent cannot be consumed before ib-read finishes');
  if (journal.started.has('render') || journal.started.has('guard')
    || journal.started.has('candidate-prep') || journal.sourceBound) {
    fail('manual consent must be consumed before render and candidate preparation');
  }
  const proof = validateManualConsentProof(input.proof, {
    journalRunId: journal.runId,
    previousSourceSha: input.previousSourceSha,
    edition: input.edition,
    requireUnexpired: true,
    now
  });
  if (parseCanonicalInstant(proof.observedAt, 'proof.observedAt') < journal.initWallMs
    || parseCanonicalInstant(proof.issuedAt, 'proof.issuedAt') < journal.initWallMs) {
    fail('manual consent proof is outside the run journal');
  }

  return withStoreLock(input.storePath, now, ({ storePath, state }) => {
    const reservation = state.reservations.get(proof.observationFingerprint);
    if (!reservation || canonicalJson(reservation.proof) !== canonicalJson(proof)) {
      fail('manual consent proof has no exact private reservation');
    }
    if (state.consumed.has(proof.proofId)) fail('manual consent proof has already been consumed');
    const consumedAt = iso(now);
    appendStore(storePath, {
      v: VERSION,
      seq: state.records.length,
      type: 'consume',
      observationFingerprint: proof.observationFingerprint,
      proofId: proof.proofId,
      runId: proof.runId,
      sourceEvidenceFingerprint: input.sourceEvidenceFingerprint,
      consumedAt
    });
    return { proof: clone(proof), consumedAt };
  });
}
