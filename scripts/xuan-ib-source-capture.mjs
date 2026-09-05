#!/usr/bin/env node

// Private capture for an actual producer's read-only connector calls. This
// records local times and immutable raw-response hashes; it is NOT a signature,
// independent proof of a connector call, account authorization or publication.
// The producer must begin BEFORE the real call and finish AFTER its return.
// No network, credentials, normalization, journal writes or financial actions.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IB_ENDPOINTS, fingerprint, sha256Hex, validateRegistry } from './xuan-ib-run-manifest.mjs';
import { parseDecisionJson } from './xuan-ib-decision-menu.mjs';
import { showRunJournal } from './xuan-ib-run-clock.mjs';
import { unwrapSource } from './xuan-ib-source-adapter.mjs';
// The hook module calls begin/finish only at runtime (no initialization work).
// This shared verifier is mandatory even through the generic assembly entry.
import { verifyHookSourceArtifacts } from './xuan-ib-source-hook.mjs';

const MAX_RAW_BYTES = 4 * 1024 * 1024;
const MAX_CAPTURE_BYTES = 6 * 1024 * 1024;
const MAX_JOURNAL_BYTES = 128 * 1024;
const PREFIX = 'XUAN-IB source capture: ';
const fail = code => { throw new Error(`${PREFIX}${code}`); };
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype;
const exact = (value, keys) => {
  if (!plain(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) fail('INVALID_CAPTURE_FIELDS');
};
const text = value => `${JSON.stringify(value)}\n`;
const strict = (bytes, maxLength = MAX_CAPTURE_BYTES) => {
  try {
    const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    // The strict parser rejects duplicate keys/depth excess. Reparse solely to
    // restore ordinary object prototypes expected by the existing adapter.
    parseDecisionJson(source, maxLength);
    const value = JSON.parse(source);
    fingerprint(value); // Reject non-finite numbers before storing anything.
    return value;
  } catch { fail('INVALID_STRICT_JSON'); }
};
const registry = JSON.parse(fs.readFileSync(new URL('../claude/xuan-ib-portfolio-registry.json', import.meta.url), 'utf8'));
validateRegistry(registry);
const requiredIds = registry.portfolios.filter(item => item.requiredEachReport).map(item => item.portfolioId);
if (requiredIds.length !== 9) fail('UNEXPECTED_REGISTRY_SCOPE');
export const CAPTURE_SOURCE_KEYS = Object.freeze([
  ...IB_ENDPOINTS.map(endpoint => `ib.${endpoint}`), ...requiredIds.map(id => `sharesight.${id}`),
]);
const sourceStage = key => {
  if (!CAPTURE_SOURCE_KEYS.includes(key)) fail('INVALID_SOURCE_KEY');
  return key.startsWith('ib.') ? 'ib-read' : 'sharesight-read';
};
const utc = value => {
  if (!Number.isSafeInteger(value) || value < 0 || value > 8.64e15) fail('INVALID_CLOCK');
  return new Date(value).toISOString();
};
const instant = value => {
  const ms = typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(ms) || utc(ms) !== value) fail('INVALID_CAPTURE_TIME');
  return ms;
};
const hktDate = value => new Date(instant(value) + 8 * 3_600_000).toISOString().slice(0, 10);

// Existing private directories only. Reject symlink components and any Git
// ancestor (normal checkout, worktree .git file, or bare repository).
function privatePath(value, { directory = false } = {}) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) fail('ABSOLUTE_PRIVATE_PATH_REQUIRED');
  const resolved = path.resolve(value);
  let current = path.parse(resolved).root;
  for (const component of resolved.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    let stat;
    try { stat = fs.lstatSync(current); } catch { fail('PRIVATE_PATH_UNAVAILABLE'); }
    if (stat.isSymbolicLink()) fail('SYMLINK_PATH_REJECTED');
    if (stat.isDirectory() && (fs.existsSync(path.join(current, '.git'))
      || (fs.existsSync(path.join(current, 'HEAD')) && fs.existsSync(path.join(current, 'objects'))
        && fs.existsSync(path.join(current, 'refs'))))) fail('GIT_PRIVATE_PATH_REJECTED');
  }
  const stat = fs.lstatSync(resolved);
  if (directory) {
    if (!stat.isDirectory() || (stat.mode & 0o777) !== 0o700) fail('DIRECTORY_MUST_BE_0700');
  } else if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600) fail('FILE_MUST_BE_PRIVATE_REGULAR_0600');
  return resolved;
}
function readPrivate(file, maxBytes) {
  privatePath(file);
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || (before.mode & 0o777) !== 0o600
      || before.size < 1 || before.size > maxBytes) fail('PRIVATE_FILE_SIZE_OR_MODE');
    const bytes = fs.readFileSync(fd), after = fs.fstatSync(fd);
    if (bytes.length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs) fail('PRIVATE_FILE_CHANGED');
    return bytes;
  } catch (error) {
    if (error?.message?.startsWith(PREFIX)) throw error;
    fail('PRIVATE_READ_FAILED');
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function writeFresh(dir, name, value) {
  privatePath(dir, { directory: true });
  const target = path.join(dir, name), bytes = Buffer.from(text(value));
  if (bytes.length > MAX_CAPTURE_BYTES * 14) fail('CAPTURE_SIZE_LIMIT');
  let fd;
  try {
    fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    fs.fchmodSync(fd, 0o600);
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
  } catch (error) {
    if (error?.message?.startsWith(PREFIX)) throw error;
    fail(error?.code === 'EEXIST' ? 'OUTPUT_ALREADY_EXISTS' : 'PRIVATE_WRITE_FAILED');
  } finally { if (fd !== undefined) fs.closeSync(fd); }
  return target;
}
// Narrow private JSON IO for the adjacent prepare wrapper. These are not a
// generic filesystem writer: output names are fixed non-path JSON leaves.
export const validateCaptureDirectory = dir => privatePath(dir, { directory: true });
export const validateCaptureFile = file => privatePath(file);
export function readCaptureJson(file, maxBytes = MAX_CAPTURE_BYTES * 14) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_CAPTURE_BYTES * 14) fail('INVALID_PRIVATE_READ_LIMIT');
  return strict(readPrivate(file, maxBytes), maxBytes);
}
export function writeCaptureJson(dir, name, value) {
  if (!['input.json', 'association.json', 'view.json', 'sources.json'].includes(name)) fail('INVALID_PRIVATE_JSON_OUTPUT_NAME');
  return writeFresh(dir, name, value);
}
function journalState(journalPath) {
  const bytes = readPrivate(journalPath, MAX_JOURNAL_BYTES);
  let journal;
  try { journal = showRunJournal(journalPath); } catch { fail('INVALID_RUN_JOURNAL'); }
  if (!readPrivate(journalPath, MAX_JOURNAL_BYTES).equals(bytes)) fail('JOURNAL_CHANGED_DURING_CAPTURE');
  const events = bytes.toString('utf8').trimEnd().split('\n').map(line => strict(Buffer.from(line)));
  return { bytes, events, journal, runId: sha256Hex(JSON.stringify(events[0])) };
}
const prefixFields = bytes => ({ journalPrefixBytes: bytes.length, journalPrefixFingerprint: sha256Hex(bytes) });
function verifyPrefix(record, bytes) {
  if (!Number.isSafeInteger(record.journalPrefixBytes) || record.journalPrefixBytes < 1
    || record.journalPrefixBytes > bytes.length || !/^[a-f0-9]{64}$/.test(record.journalPrefixFingerprint)
    || sha256Hex(bytes.subarray(0, record.journalPrefixBytes)) !== record.journalPrefixFingerprint) fail('JOURNAL_PREFIX_CHANGED');
  if (bytes[record.journalPrefixBytes - 1] !== 10) fail('PARTIAL_JOURNAL_PREFIX');
}
function verifyActivePrefix(record, bytes, stage, stageStartFingerprint) {
  verifyPrefix(record, bytes);
  const events = bytes.subarray(0, record.journalPrefixBytes).toString('utf8').trimEnd().split('\n').map(line => strict(Buffer.from(line)));
  const start = events.find(event => event.type === 'stage-start' && event.stage === stage);
  if (!start || fingerprint(start) !== stageStartFingerprint
    || events.some(event => event.type === 'stage-finish' && event.stage === stage)) fail('PREFIX_READ_STAGE_NOT_ACTIVE');
}
function activeStage(state, stage, now) {
  if (!state.journal.timing.runningStages.includes(stage)) fail('READ_STAGE_NOT_ACTIVE');
  const bootstrap = state.journal.stages.find(item => item.name === 'bootstrap');
  if (bootstrap?.status !== 'ok') fail('BOOTSTRAP_NOT_COMPLETE');
  const event = state.events.find(item => item.type === 'stage-start' && item.stage === stage);
  if (!event || now < event.wallMs || state.events.some(item => item.wallMs > now)) fail('CAPTURE_OUTSIDE_RUN_TIME');
  return event;
}
const beginKeys = ['schemaVersion', 'kind', 'sourceKey', 'runId', 'journalPath', 'stage', 'stageStartFingerprint', 'startedAt', 'journalPrefixBytes', 'journalPrefixFingerprint'];
function readBegin(dir, key, journalPath, state) {
  const bytes = readPrivate(path.join(dir, `${key}.begin.json`), MAX_JOURNAL_BYTES), begin = strict(bytes);
  exact(begin, beginKeys);
  const event = state.events.find(item => item.type === 'stage-start' && item.stage === sourceStage(key));
  if (begin.schemaVersion !== 1 || !['source-capture-begin-v1', 'source-hook-begin-v1'].includes(begin.kind) || begin.sourceKey !== key
    || begin.runId !== state.runId || begin.journalPath !== journalPath || begin.stage !== sourceStage(key)
    || !event || begin.stageStartFingerprint !== fingerprint(event) || instant(begin.startedAt) < event.wallMs) fail('BEGIN_RUN_BINDING_MISMATCH');
  verifyActivePrefix(begin, state.bytes, begin.stage, begin.stageStartFingerprint);
  return { begin, bytes };
}
function validateRaw(key, raw) {
  if (!plain(raw)) fail('RAW_OBJECT_REQUIRED');
  const failed = raw.isError === true || Boolean(raw.error);
  if (!failed) {
    try { unwrapSource(key.startsWith('ib.') ? key.slice(3) : 'sharesight', raw); }
    catch { fail('UNSUPPORTED_NATIVE_SOURCE_SHAPE'); }
    if (key.startsWith('sharesight.') && raw.result.portfolio.id !== Number(key.slice('sharesight.'.length))) fail('PORTFOLIO_SOURCE_KEY_MISMATCH');
  }
  return failed;
}

// Read-only preflight for the adjacent hook bridge. It cannot create or repair
// a begin record, alter the run journal, or authorize a financial read.
export function inspectSourceCaptureBegin(dir, key, { journalPath, wallNow = () => Date.now() } = {}) {
  sourceStage(key); dir = privatePath(dir, { directory: true }); journalPath = privatePath(journalPath);
  const state = journalState(journalPath), { begin, bytes } = readBegin(dir, key, journalPath, state);
  const now = wallNow(); utc(now); activeStage(state, sourceStage(key), now);
  if (now < instant(begin.startedAt)) fail('CAPTURE_CLOCK_MOVED_BACKWARDS');
  return { begin, beginFingerprint: sha256Hex(bytes) };
}

export function beginSourceCapture(dir, key, { journalPath, wallNow = () => Date.now(), hookCapture = false } = {}) {
  if (typeof hookCapture !== 'boolean') fail('INVALID_CAPTURE_MODE');
  sourceStage(key); dir = privatePath(dir, { directory: true }); journalPath = privatePath(journalPath);
  const state = journalState(journalPath), now = wallNow(), startedAt = utc(now);
  const event = activeStage(state, sourceStage(key), now);
  const begin = { schemaVersion: 1, kind: hookCapture ? 'source-hook-begin-v1' : 'source-capture-begin-v1', sourceKey: key, runId: state.runId,
    journalPath, stage: sourceStage(key), stageStartFingerprint: fingerprint(event), startedAt,
    ...prefixFields(state.bytes) };
  return { status: 'begun', sourceKey: key, path: writeFresh(dir, `${key}.begin.json`, begin), runId: state.runId };
}

export function finishSourceCapture(dir, key, rawFile, { journalPath, wallNow = () => Date.now() } = {}) {
  sourceStage(key); dir = privatePath(dir, { directory: true }); journalPath = privatePath(journalPath);
  const state = journalState(journalPath), { begin, bytes } = readBegin(dir, key, journalPath, state);
  const raw = strict(readPrivate(rawFile, MAX_RAW_BYTES)), failed = validateRaw(key, raw);
  const now = wallNow(), completedAt = utc(now);
  activeStage(state, sourceStage(key), now);
  if (now < instant(begin.startedAt)) fail('CAPTURE_CLOCK_MOVED_BACKWARDS');
  const receipt = { raw, status: failed ? 'failed' : 'ok', startedAt: begin.startedAt, completedAt,
    retries: 0, rawFingerprint: fingerprint(raw), ...(failed ? { errorCode: 'UPSTREAM_SOURCE_ERROR' } : {}) };
  const envelope = { schemaVersion: 1, kind: 'source-capture-finish-v1', sourceKey: key, runId: state.runId,
    journalPath, beginFingerprint: sha256Hex(bytes), ...prefixFields(state.bytes), receipt };
  return { status: failed ? 'failed' : 'captured', sourceKey: key,
    path: writeFresh(dir, `${key}.receipt.json`, envelope), runId: state.runId };
}

export function assembleSourceCaptures(dir, { journalPath, previousSourceSha, dataDate, wallNow = () => Date.now() } = {}) {
  dir = privatePath(dir, { directory: true }); journalPath = privatePath(journalPath);
  const hasHookBegin = CAPTURE_SOURCE_KEYS.some(key => {
    const file = path.join(dir, `${key}.begin.json`);
    return fs.existsSync(file) && strict(readPrivate(file, MAX_JOURNAL_BYTES)).kind === 'source-hook-begin-v1';
  });
  if (hasHookBegin || fs.readdirSync(dir).some(name => name.includes('.hook-'))) verifyHookSourceArtifacts(dir, { journalPath });
  if (typeof previousSourceSha !== 'string' || !/^[a-f0-9]{40}$/.test(previousSourceSha)) fail('INVALID_PREVIOUS_SOURCE_SHA');
  if (typeof dataDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dataDate)
    || !Number.isFinite(Date.parse(dataDate)) || new Date(dataDate).toISOString().slice(0, 10) !== dataDate) fail('INVALID_DATA_DATE');
  const expectedNames = new Set(CAPTURE_SOURCE_KEYS.flatMap(key => [`${key}.begin.json`, `${key}.receipt.json`]));
  if (fs.readdirSync(dir).some(name => /\.(begin|receipt)\.json$/.test(name) && !expectedNames.has(name))) fail('UNEXPECTED_CAPTURE_SOURCE');
  const state = journalState(journalPath), now = wallNow(); utc(now);
  if (state.journal.timing.runningStages.some(name => ['ib-read', 'sharesight-read'].includes(name))) fail('READ_STAGES_STILL_ACTIVE');
  const collected = new Map();
  for (const key of CAPTURE_SOURCE_KEYS) {
    const stage = state.journal.stages.find(item => item.name === sourceStage(key));
    if (stage?.status !== 'ok') fail('READ_STAGE_NOT_SUCCESSFUL');
    const { begin, bytes } = readBegin(dir, key, journalPath, state);
    const envelope = strict(readPrivate(path.join(dir, `${key}.receipt.json`), MAX_CAPTURE_BYTES));
    exact(envelope, ['schemaVersion', 'kind', 'sourceKey', 'runId', 'journalPath', 'beginFingerprint', 'journalPrefixBytes', 'journalPrefixFingerprint', 'receipt']);
    if (envelope.schemaVersion !== 1 || envelope.kind !== 'source-capture-finish-v1' || envelope.sourceKey !== key
      || envelope.runId !== state.runId || envelope.journalPath !== journalPath || envelope.beginFingerprint !== sha256Hex(bytes)) fail('FINISH_RUN_BINDING_MISMATCH');
    verifyActivePrefix(envelope, state.bytes, begin.stage, begin.stageStartFingerprint);
    if (envelope.journalPrefixBytes < begin.journalPrefixBytes) fail('FINISH_PREFIX_PRECEDES_BEGIN');
    const receipt = envelope.receipt;
    if (!plain(receipt) || !plain(receipt.raw)) fail('INVALID_CAPTURE_RECEIPT');
    if (validateRaw(key, receipt.raw) || receipt.status !== 'ok') fail('FAILED_SOURCE_REQUIRES_STOP');
    exact(receipt, ['raw', 'status', 'startedAt', 'completedAt', 'retries', 'rawFingerprint']);
    if (receipt.startedAt !== begin.startedAt || receipt.retries !== 0 || receipt.rawFingerprint !== fingerprint(receipt.raw)) fail('CAPTURE_HASH_OR_RECEIPT_CHANGED');
    const start = instant(receipt.startedAt), end = instant(receipt.completedAt);
    if (end < start || end > now || end > instant(stage.endedAt) || start < instant(stage.startedAt)) fail('CAPTURE_OUTSIDE_COMPLETED_STAGE');
    if (hktDate(receipt.startedAt) !== dataDate || hktDate(receipt.completedAt) !== dataDate) fail('CAPTURE_DATE_MISMATCH');
    collected.set(key, receipt);
  }
  const input = { edition: 'adhoc', dataDate, previousSourceSha,
    ib: Object.fromEntries(IB_ENDPOINTS.map(endpoint => [endpoint, collected.get(`ib.${endpoint}`)])),
    sharesight: requiredIds.map(id => collected.get(`sharesight.${id}`)) };
  return { status: 'assembled', path: writeFresh(dir, 'input.json', input), runId: state.runId };
}

export function sourceCaptureCli(argv) {
  const [command, dir, ...args] = argv;
  if (command === 'begin' && args.length === 3 && args[1] === '--journal') {
    return beginSourceCapture(dir, args[0], { journalPath: args[2] });
  }
  if (command === 'finish' && args.length === 4 && args[2] === '--journal') {
    return finishSourceCapture(dir, args[0], args[1], { journalPath: args[3] });
  }
  if (command === 'assemble' && args.length === 6 && args[0] === '--journal'
    && args[2] === '--previous-source-sha' && args[4] === '--data-date') {
    return assembleSourceCaptures(dir, { journalPath: args[1], previousSourceSha: args[3], dataDate: args[5] });
  }
  fail('INVALID_COMMAND_OR_FLAGS');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = sourceCaptureCli(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.status === 'failed') process.exitCode = 1;
  } catch (error) {
    // Paths, raw tool errors, data and credentials never enter diagnostics.
    process.stderr.write(`${error?.message?.startsWith(PREFIX) ? error.message : `${PREFIX}CAPTURE_FAILED`}\n`);
    process.exitCode = 1;
  }
}
