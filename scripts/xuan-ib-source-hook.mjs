#!/usr/bin/env node

// Disabled-by-default PostToolUse bridge. This module never installs a hook,
// invokes a connector, changes permissions, appends a journal or publishes.
// Arm BEFORE dispatch in the same owning runtime; never claim an in-flight
// call from before the arm. These are local interval/integrity records, not an
// independent source/account attestation or exact API-latency measurement.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CAPTURE_SOURCE_KEYS, validateCaptureDirectory, validateCaptureFile, readCaptureJson,
  beginSourceCapture, inspectSourceCaptureBegin, finishSourceCapture, assembleSourceCaptures } from './xuan-ib-source-capture.mjs';
import { parseDecisionJson } from './xuan-ib-decision-menu.mjs';
import { fingerprint } from './xuan-ib-run-manifest.mjs';
import { decodeHookResponse } from './xuan-ib-hook-response.mjs';

export const MAX_HOOK_EVENT_BYTES = 6 * 1024 * 1024;
export const HOOK_ARM_TTL_MS = 5 * 60 * 1000;
const PREFIX = 'XUAN-IB source hook: ';
const fail = code => { throw new Error(`${PREFIX}${code}`); };
const plain = v => v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;
const exact = (v, keys) => {
  if (!plain(v) || Object.keys(v).length !== keys.length || keys.some(k => !Object.hasOwn(v, k))) fail('INVALID_FIELDS');
};
const metadata = v => typeof v === 'string' && v.length > 0 && v.length <= 256 && !/[\u0000-\u001f\u007f]/.test(v);
const date = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
  && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;
const instant = ms => {
  if (!Number.isSafeInteger(ms) || ms < 0 || ms > 8.64e15) fail('INVALID_CLOCK');
  return new Date(ms).toISOString();
};
const time = value => {
  const ms = typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(ms) || instant(ms) !== value) fail('INVALID_ARM_TIME');
  return ms;
};
const keyCheck = key => { if (!CAPTURE_SOURCE_KEYS.includes(key)) fail('INVALID_SOURCE_KEY'); };
export const SOURCE_HOOK_TOOLS = Object.freeze({
  'ib.accountSummary': 'mcp__Interactive_Brokers__get_account_summary',
  'ib.balances': 'mcp__Interactive_Brokers__get_account_balances',
  'ib.positions': 'mcp__Interactive_Brokers__get_account_positions',
  'ib.orders': 'mcp__Interactive_Brokers__get_account_orders',
  'ib.trades': 'mcp__Interactive_Brokers__get_account_trades',
  sharesight: 'mcp__Family_Portfolio_Sharesight__sharesight_get_performance',
});
const expectedTool = key => SOURCE_HOOK_TOOLS[key.startsWith('sharesight.') ? 'sharesight' : key];

// Exact tool names/input keys were loaded from the actual Claude runtime on
// 2026-09-05. This first path deliberately uses only the minimal read variants.
// A schema definition confirms input syntax, not response completeness.
export function validateHookInput(key, input) {
  keyCheck(key);
  if (!plain(input)) fail('INVALID_TOOL_INPUT');
  if (key.startsWith('sharesight.')) {
    if (Object.keys(input).some(k => !['portfolio', 'start_date', 'end_date', 'grouping', 'include_sales'].includes(k))
      || input.portfolio !== key.slice('sharesight.'.length)) fail('INVALID_TOOL_INPUT');
    for (const k of ['start_date', 'end_date']) if (Object.hasOwn(input, k) && input[k] !== null && !date(input[k])) fail('INVALID_TOOL_INPUT');
    if (input.start_date && input.end_date && input.start_date > input.end_date) fail('INVALID_TOOL_INPUT');
    if (Object.hasOwn(input, 'grouping') && input.grouping !== 'investment_type') fail('INVALID_TOOL_INPUT');
    if (Object.hasOwn(input, 'include_sales') && input.include_sales !== false) fail('INVALID_TOOL_INPUT');
  } else if (key === 'ib.trades') {
    if (Object.keys(input).some(k => k !== 'period') || (Object.hasOwn(input, 'period') && input.period !== 'TODAY')) fail('INVALID_TOOL_INPUT');
  } else if (Object.keys(input).length) fail('INVALID_TOOL_INPUT');
  return fingerprint(input);
}

function owner(file) {
  const stat = fs.lstatSync(file);
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) fail('OWNER_MISMATCH');
}
function directory(dir) {
  const resolved = validateCaptureDirectory(dir); owner(resolved); return resolved;
}
function readPrivate(file, max = MAX_HOOK_EVENT_BYTES) {
  validateCaptureFile(file); owner(file); return readCaptureJson(file, max);
}
function writeFresh(dir, key, suffix, value) {
  directory(dir); keyCheck(key);
  if (!['arm', 'claim', 'transport', 'raw', 'rejected'].includes(suffix)) fail('INVALID_ARTIFACT');
  const file = path.join(dir, `${key}.hook-${suffix}.json`), bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  if (bytes.length > MAX_HOOK_EVENT_BYTES) fail('ARTIFACT_TOO_LARGE');
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    fs.fchmodSync(fd, 0o600); fs.writeFileSync(fd, bytes); fs.fsyncSync(fd);
  } catch (e) { fail(e?.code === 'EEXIST' ? 'ARTIFACT_ALREADY_EXISTS' : 'PRIVATE_WRITE_FAILED'); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
  return file;
}
const armFields = ['schemaVersion', 'kind', 'sourceKey', 'runId', 'journalPath', 'beginFingerprint',
  'toolName', 'runtimeSessionId', 'inputFingerprint', 'nonce', 'createdAt', 'expiresAt'];
const identityFields = ['schemaVersion', 'sourceKey', 'runId', 'nonce', 'capturedAt', 'toolName',
  'runtimeSessionId', 'toolUseId', 'inputFingerprint', 'armFingerprint'];

export function armHookSource(dir, key, binding, { journalPath, wallNow = () => Date.now() } = {}) {
  keyCheck(key); dir = directory(dir);
  exact(binding, ['toolName', 'runtimeSessionId', 'toolInput']);
  if (binding.toolName !== expectedTool(key) || !metadata(binding.runtimeSessionId)) fail('INVALID_BINDING');
  const inputFingerprint = validateHookInput(key, binding.toolInput);
  // Failure/partial output is never automatically repaired or re-armed.
  for (const suffix of ['arm', 'claim', 'transport', 'raw', 'rejected']) {
    try { fs.lstatSync(path.join(dir, `${key}.hook-${suffix}.json`)); fail('EXISTING_HOOK_ARTIFACT'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  beginSourceCapture(dir, key, { journalPath, wallNow, hookCapture: true });
  const { begin, beginFingerprint } = inspectSourceCaptureBegin(dir, key, { journalPath, wallNow });
  const created = time(begin.startedAt), nonce = crypto.randomBytes(24).toString('hex');
  const arm = { schemaVersion: 1, kind: 'source-hook-arm-v1', sourceKey: key, runId: begin.runId,
    journalPath: begin.journalPath, beginFingerprint, toolName: binding.toolName,
    runtimeSessionId: binding.runtimeSessionId, inputFingerprint, nonce,
    createdAt: begin.startedAt, expiresAt: instant(created + HOOK_ARM_TTL_MS) };
  const file = writeFresh(dir, key, 'arm', arm);
  return { status: 'armed-not-authorized', sourceKey: key, path: file, nonce, expiresAt: arm.expiresAt };
}

function parseEvent(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > MAX_HOOK_EVENT_BYTES) fail('INVALID_EVENT_SIZE');
  let event;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    parseDecisionJson(text, MAX_HOOK_EVENT_BYTES); event = JSON.parse(text);
    fingerprint(event); // Finite JSON only; no unbounded arbitrary serialization.
  } catch { fail('INVALID_EVENT_JSON'); }
  if (!plain(event)) fail('INVALID_EVENT');
  return event;
}

export function captureHookSource(dir, key, nonce, bytes, { wallNow = () => Date.now() } = {}) {
  keyCheck(key); dir = directory(dir);
  if (typeof nonce !== 'string' || !/^[a-f0-9]{48}$/.test(nonce)) fail('INVALID_NONCE');
  const arm = readPrivate(path.join(dir, `${key}.hook-arm.json`), 16_384); exact(arm, armFields);
  if (arm.schemaVersion !== 1 || arm.kind !== 'source-hook-arm-v1' || arm.sourceKey !== key
    || arm.toolName !== expectedTool(key) || arm.nonce !== nonce || !metadata(arm.runtimeSessionId)
    || !/^[a-f0-9]{64}$/.test(arm.inputFingerprint)) fail('ARM_BINDING_MISMATCH');
  const event = parseEvent(bytes);
  // Several portfolio-specific handlers may share one performance matcher.
  // Unrelated calls never consume this source's arm or emit warnings/data.
  if (event.tool_name !== arm.toolName || !plain(event.tool_input)
    || fingerprint(event.tool_input) !== arm.inputFingerprint) return { status: 'ignored' };
  if (!['PostToolUse', 'PostToolUseFailure'].includes(event.hook_event_name)
    || event.session_id !== arm.runtimeSessionId || !metadata(event.tool_use_id)) fail('EVENT_BINDING_MISMATCH');
  validateHookInput(key, event.tool_input);
  const now = wallNow(), capturedAt = instant(now), created = time(arm.createdAt), expires = time(arm.expiresAt);
  if (expires - created !== HOOK_ARM_TTL_MS || now < created || now >= expires) fail('ARM_NOT_CURRENT');
  const { begin, beginFingerprint } = inspectSourceCaptureBegin(dir, key, { journalPath: arm.journalPath, wallNow: () => now });
  if (begin.kind !== 'source-hook-begin-v1' || arm.runId !== begin.runId || arm.beginFingerprint !== beginFingerprint || arm.createdAt !== begin.startedAt) fail('ARM_RUN_CHANGED');
  const identity = { schemaVersion: 1, sourceKey: key, runId: arm.runId, nonce, capturedAt,
    toolName: arm.toolName, runtimeSessionId: event.session_id, toolUseId: event.tool_use_id,
    inputFingerprint: arm.inputFingerprint, armFingerprint: fingerprint(arm) };
  writeFresh(dir, key, 'claim', identity); // Atomic one-shot; failure consumes it.
  try {
    if (event.hook_event_name === 'PostToolUseFailure' || Object.hasOwn(event, 'error') || event.isError === true) fail('UPSTREAM_TOOL_FAILED');
    if (!Object.hasOwn(event, 'tool_response')) fail('MISSING_TOOL_RESPONSE');
    // Preserve only bounded response+binding, not tool_input/transcript/cwd,
    // credentials, environment, or raw upstream failure diagnostics.
    const transport = { ...identity, kind: 'source-hook-transport-v1',
      transportFingerprint: fingerprint(event.tool_response), toolResponse: event.tool_response };
    const transportFile = writeFresh(dir, key, 'transport', transport);
    const decoded = decodeHookResponse(event.tool_response, { sourceKey: key });
    const rawFile = writeFresh(dir, key, 'raw', decoded.raw);
    // Receipt clock is taken AFTER durable raw output, not supplied by event.
    const result = finishSourceCapture(dir, key, rawFile, { journalPath: arm.journalPath, wallNow: () => {
      const completed = wallNow(); instant(completed);
      if (completed < now || completed >= expires) fail('FINISH_OUTSIDE_ARM_WINDOW');
      return completed;
    } });
    return { status: 'captured', sourceKey: key, receiptPath: result.path, transportPath: transportFile,
      transportFingerprint: decoded.transportFingerprint, rawFingerprint: decoded.rawFingerprint, wrapper: decoded.wrapper };
  } catch (error) {
    // Never make a failed capture look successful or retry it in this run.
    // Partial private evidence stays; a fresh run is required after review.
    const code = error?.message?.startsWith('XUAN-IB hook response: ')
      ? error.message.slice('XUAN-IB hook response: '.length)
      : error?.message?.startsWith(PREFIX) ? error.message.slice(PREFIX.length) : 'CAPTURE_FINALIZATION_FAILED';
    writeFresh(dir, key, 'rejected', { ...identity, kind: 'source-hook-rejected-v1', errorCode: /^[A-Z0-9_]+$/.test(code) ? code : 'CAPTURE_FAILED' });
    fail('CAPTURE_REJECTED');
  }
}

export function verifyHookSourceArtifacts(dir, options = {}) {
  dir = directory(dir);
  const seenIds = new Set(), runtimeIds = new Set();
  const names = new Set(CAPTURE_SOURCE_KEYS.flatMap(key => ['arm', 'claim', 'transport', 'raw'].map(suffix => `${key}.hook-${suffix}.json`)));
  if (fs.readdirSync(dir).some(name => name.includes('.hook-') && !names.has(name))) fail('REJECTED_OR_UNKNOWN_HOOK_ARTIFACT');
  for (const key of CAPTURE_SOURCE_KEYS) {
    const arm = readPrivate(path.join(dir, `${key}.hook-arm.json`), 16_384); exact(arm, armFields);
    const claim = readPrivate(path.join(dir, `${key}.hook-claim.json`), 16_384); exact(claim, identityFields);
    const transport = readPrivate(path.join(dir, `${key}.hook-transport.json`));
    exact(transport, [...identityFields, 'kind', 'transportFingerprint', 'toolResponse']);
    const beginFile = path.join(dir, `${key}.begin.json`), begin = readPrivate(beginFile, 16_384);
    const envelope = readPrivate(path.join(dir, `${key}.receipt.json`));
    const raw = readPrivate(path.join(dir, `${key}.hook-raw.json`));
    if (arm.schemaVersion !== 1 || arm.kind !== 'source-hook-arm-v1' || arm.sourceKey !== key
      || arm.toolName !== expectedTool(key) || arm.journalPath !== path.resolve(options.journalPath ?? '')
      || !/^[a-f0-9]{48}$/.test(arm.nonce) || !metadata(arm.runtimeSessionId)
      || begin.kind !== 'source-hook-begin-v1' || arm.runId !== begin.runId || arm.createdAt !== begin.startedAt
      || arm.beginFingerprint !== envelope.beginFingerprint
      || time(arm.expiresAt) - time(arm.createdAt) !== HOOK_ARM_TTL_MS) fail('HOOK_ASSEMBLY_BINDING_MISMATCH');
    if (claim.schemaVersion !== 1 || claim.sourceKey !== key || claim.runId !== arm.runId
      || claim.nonce !== arm.nonce || claim.toolName !== arm.toolName || claim.runtimeSessionId !== arm.runtimeSessionId
      || claim.inputFingerprint !== arm.inputFingerprint || claim.armFingerprint !== fingerprint(arm)
      || !metadata(claim.toolUseId) || time(claim.capturedAt) < time(arm.createdAt)
      || time(claim.capturedAt) >= time(arm.expiresAt)) fail('HOOK_CLAIM_CHANGED');
    if (transport.kind !== 'source-hook-transport-v1'
      || identityFields.some(field => transport[field] !== claim[field])) fail('HOOK_TRANSPORT_CHANGED');
    const decoded = decodeHookResponse(transport.toolResponse, { sourceKey: key });
    if (transport.transportFingerprint !== decoded.transportFingerprint
      || decoded.rawFingerprint !== fingerprint(raw) || decoded.rawFingerprint !== envelope.receipt?.rawFingerprint
      || decoded.rawFingerprint !== fingerprint(envelope.receipt?.raw)
      || time(envelope.receipt.completedAt) < time(claim.capturedAt)
      || time(envelope.receipt.completedAt) >= time(arm.expiresAt)) fail('HOOK_RAW_CHANGED');
    const id = JSON.stringify([claim.runtimeSessionId, claim.toolUseId]);
    if (seenIds.has(id)) fail('DUPLICATE_HOOK_TOOL_USE');
    seenIds.add(id); runtimeIds.add(claim.runtimeSessionId);
  }
  if (runtimeIds.size !== 1) fail('MIXED_HOOK_RUNTIMES');
  return { status: 'hook-artifacts-verified', sourceCount: CAPTURE_SOURCE_KEYS.length };
}

export function assembleHookSources(dir, options = {}) {
  dir = directory(dir);
  if (!fs.readdirSync(dir).some(name => name.includes('.hook-'))) fail('MISSING_HOOK_ARTIFACTS');
  // The generic assembler invokes the same mandatory hook verifier whenever
  // hook begin records or artifacts are present, so removing artifacts cannot
  // bypass transport reconciliation.
  // It then independently verifies all run/journal/time/raw hashes.
  return assembleSourceCaptures(dir, options);
}

export async function runSourceHookCli(argv, stdin = process.stdin) {
  if (argv[0] === 'assemble' && argv.length === 8 && argv[2] === '--journal'
    && argv[4] === '--previous-source-sha' && argv[6] === '--data-date') {
    return assembleHookSources(argv[1], { journalPath: argv[3], previousSourceSha: argv[5], dataDate: argv[7] });
  }
  const [command, dir, key, ...args] = argv;
  if (command === 'arm' && args.length === 3 && args[1] === '--journal') {
    return armHookSource(dir, key, readPrivate(args[0], 16_384), { journalPath: args[2] });
  }
  if (command === 'capture' && args.length === 1) {
    const chunks = []; let total = 0;
    for await (const chunk of stdin) {
      const bytes = Buffer.from(chunk); total += bytes.length;
      if (total > MAX_HOOK_EVENT_BYTES) fail('INVALID_EVENT_SIZE');
      chunks.push(bytes);
    }
    return captureHookSource(dir, key, args[0], Buffer.concat(chunks));
  }
  fail('INVALID_COMMAND_OR_FLAGS');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await runSourceHookCli(process.argv.slice(2));
    // Post hooks MUST NOT print JSON that could change decisions/results.
    if (process.argv[2] !== 'capture') process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch {
    process.stderr.write(`${PREFIX}HOOK_OPERATION_FAILED\n`); process.exitCode = 1;
  }
}
