#!/usr/bin/env node
// Deterministic intent only. No connector calls, hooks, permissions, run files,
// receipts, retries or publication. A plan never proves that a read happened.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IB_ENDPOINTS, fingerprint, validateRegistry } from './xuan-ib-run-manifest.mjs';
import { SOURCE_HOOK_TOOLS, validateHookInput } from './xuan-ib-source-hook.mjs';

const fail = code => { throw new Error(`XUAN-IB source plan: ${code}`); };
const plain = value => value !== null && typeof value === 'object'
  && Object.getPrototypeOf(value) === Object.prototype;
const exact = (value, keys, code) => {
  if (!plain(value) || Reflect.ownKeys(value).length !== keys.length
    || keys.some(key => !Object.hasOwn(value, key))) fail(code);
};
const clone = value => JSON.parse(JSON.stringify(value));
const bundledRegistry = JSON.parse(fs.readFileSync(
  new URL('../claude/xuan-ib-portfolio-registry.json', import.meta.url), 'utf8'));
validateRegistry(bundledRegistry);
const bundledRegistryFingerprint = fingerprint(bundledRegistry);
const EVIDENCE_SEQUENCE = Object.freeze({
  begin: 'before-dispatch',
  bind: 'same-call-native-result-by-tool-use-id',
  finish: 'before-stage-close',
  onMissing: 'fail-closed-no-replay',
});

// Injection permits offline callers to supply the same versioned registry,
// never to enlarge its scope. The checkout itself is not current-main proof.
function checkedRegistry(registry) {
  try {
    validateRegistry(registry);
    if (fingerprint(registry) !== bundledRegistryFingerprint) fail('REGISTRY_NOT_BUNDLED_VERSION');
  } catch { fail('INVALID_OR_CHANGED_REGISTRY'); }
  return registry;
}

function checkedContext(context) {
  exact(context, ['protocol', 'edition'], 'INVALID_PLAN_CONTEXT');
  if (context.protocol !== 'full-live') fail('FULL_LIVE_PROTOCOL_REQUIRED');
  if (!['am', 'pm'].includes(context.edition)) fail('FIXED_EDITION_REQUIRED');
}

const toolFor = key => SOURCE_HOOK_TOOLS[key.startsWith('sharesight.') ? 'sharesight' : key];
const inputFor = key => key.startsWith('sharesight.') ? { portfolio: key.slice('sharesight.'.length) }
  : key === 'ib.trades' ? { period: 'TODAY' } : {};
const callFor = sourceKey => ({ sourceKey, toolName: toolFor(sourceKey), toolInput: inputFor(sourceKey) });
const keysFor = registry => new Set([
  ...IB_ENDPOINTS.map(endpoint => `ib.${endpoint}`),
  ...registry.portfolios.filter(item => item.requiredEachReport).map(item => `sharesight.${item.portfolioId}`),
]);

/** Validate intent before a caller dispatches it. This cannot intercept an API. */
export function validatePlannedCall(call, registry = bundledRegistry) {
  checkedRegistry(registry);
  exact(call, ['sourceKey', 'toolName', 'toolInput'], 'INVALID_PLANNED_CALL_FIELDS');
  if (!keysFor(registry).has(call.sourceKey)) fail('SOURCE_OUTSIDE_APPROVED_PLAN');
  const expectedTool = toolFor(call.sourceKey);
  if (typeof call.toolName !== 'string' || !call.toolName.trim()
    || typeof expectedTool !== 'string' || !expectedTool.trim()
    || call.toolName !== expectedTool) fail('UNEXPECTED_SOURCE_TOOL');
  const expectedInput = inputFor(call.sourceKey);
  exact(call.toolInput, Object.keys(expectedInput), 'INVALID_PLANNED_INPUT_FIELDS');
  try { validateHookInput(call.sourceKey, call.toolInput); }
  catch { fail('INVALID_PLANNED_INPUT'); }
  if (fingerprint(call.toolInput) !== fingerprint(expectedInput)) fail('INVALID_PLANNED_INPUT');
  return clone(call);
}

/** Pure plan construction after the versioned registry is loaded. */
export function buildSourcePlan(context, registry = bundledRegistry) {
  checkedContext(context);
  checkedRegistry(registry);
  const sourceKeys = role => registry.portfolios
    .filter(item => item.requiredEachReport && item.role === role)
    .map(item => `sharesight.${item.portfolioId}`);
  const family = sourceKeys('family'), auxiliary = sourceKeys('ai_only');
  if (family.length !== 7 || auxiliary.length !== 2 || IB_ENDPOINTS.length !== 5) fail('INVALID_BATCH_SCOPE');
  const required = keysFor(registry);
  const planned = new Set([...IB_ENDPOINTS.map(endpoint => `ib.${endpoint}`), ...family, ...auxiliary]);
  if (required.size !== 14 || planned.size !== required.size
    || [...required].some(key => !planned.has(key))) fail('INVALID_BATCH_SCOPE');
  const calls = keys => keys.map(key => validatePlannedCall(callFor(key), registry));
  const ready = 'bootstrap-and-fresh-edition-run-bound-association-verified';
  return {
    schemaVersion: 1,
    kind: 'xuan-ib-source-plan-v1',
    status: 'planned-not-authorized',
    protocol: context.protocol,
    edition: context.edition,
    registryFingerprint: bundledRegistryFingerprint,
    runtimeEvidence: 'not-checked',
    evidenceSequence: clone(EVIDENCE_SEQUENCE),
    batches: [
      { id: 'ib-1', stage: 'ib-read', after: [ready],
        calls: calls(['ib.accountSummary', 'ib.balances']) },
      { id: 'ib-2', stage: 'ib-read', after: ['ib-1', 'account-scope-confirmed'],
        calls: calls(['ib.positions', 'ib.orders', 'ib.trades']) },
      { id: 'sharesight-family-1', stage: 'sharesight-read', after: [ready],
        calls: calls(family.slice(0, 3)) },
      { id: 'sharesight-family-2', stage: 'sharesight-read', after: ['sharesight-family-1'],
        calls: calls(family.slice(3, 6)) },
      { id: 'sharesight-family-3', stage: 'sharesight-read', after: ['sharesight-family-2'],
        calls: calls(family.slice(6, 7)) },
      { id: 'sharesight-auxiliary', stage: 'sharesight-read', after: ['sharesight-family-3'],
        calls: calls(auxiliary) },
    ],
  };
}

/** Reject partial/reordered/expanded plans as well as changed individual calls. */
export function validateSourcePlan(plan, registry = bundledRegistry) {
  checkedRegistry(registry);
  exact(plan, ['schemaVersion', 'kind', 'status', 'protocol', 'edition', 'registryFingerprint',
    'runtimeEvidence', 'evidenceSequence', 'batches'], 'INVALID_SOURCE_PLAN_FIELDS');
  checkedContext({ protocol: plan.protocol, edition: plan.edition });
  exact(plan.evidenceSequence, ['begin', 'bind', 'finish', 'onMissing'], 'INVALID_EVIDENCE_SEQUENCE_FIELDS');
  if (fingerprint(plan.evidenceSequence) !== fingerprint(EVIDENCE_SEQUENCE)) fail('INVALID_EVIDENCE_SEQUENCE');
  if (!Array.isArray(plan.batches) || plan.batches.length !== 6) fail('INVALID_PLAN_BATCHES');
  const seen = new Set();
  for (const batch of plan.batches) {
    exact(batch, ['id', 'stage', 'after', 'calls'], 'INVALID_BATCH_FIELDS');
    if (!Array.isArray(batch.after) || !Array.isArray(batch.calls)) fail('INVALID_BATCH_FIELDS');
    for (const call of batch.calls) {
      validatePlannedCall(call, registry);
      if (seen.has(call.sourceKey)) fail('DUPLICATE_PLANNED_SOURCE');
      seen.add(call.sourceKey);
    }
  }
  if (seen.size !== 14) fail('INCOMPLETE_PLANNED_SOURCES');
  const expected = buildSourcePlan({ protocol: plan.protocol, edition: plan.edition }, registry);
  if (fingerprint(plan) !== fingerprint(expected)) fail('PLAN_DOES_NOT_MATCH_REQUIRED_INTENT');
  return clone(plan);
}

export function runSourcePlanCli(args) {
  if (!Array.isArray(args) || args.length !== 4 || args[0] !== '--protocol' || args[2] !== '--edition') {
    fail('USAGE_PROTOCOL_FULL_LIVE_EDITION_AM_OR_PM');
  }
  return buildSourcePlan({ protocol: args[1], edition: args[3] });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(`${JSON.stringify(runSourcePlanCli(process.argv.slice(2)))}\n`); }
  catch (error) {
    const code = /^XUAN-IB source plan: ([A-Z0-9_]+)$/.exec(error?.message)?.[1] ?? 'SOURCE_PLAN_FAILED';
    process.stderr.write(`${JSON.stringify({ status: 'failed', code })}\n`);
    process.exitCode = 1;
  }
}
