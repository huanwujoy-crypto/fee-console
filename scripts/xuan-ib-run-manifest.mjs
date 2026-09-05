#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

export const APPROVED_IB_ACCOUNT_ID = "U6859001";

export const RUN_STAGES = Object.freeze([
  "bootstrap",
  "ib-read",
  "sharesight-read",
  "validate",
  "derive",
  "narrative",
  "render",
  "guard",
  "candidate-prep"
]);

export const IB_ENDPOINTS = Object.freeze([
  "accountSummary",
  "balances",
  "positions",
  "orders",
  "trades"
]);

const EDITIONS = new Set(["am", "pm", "adhoc"]);
const STAGE_STATUSES = new Set(["ok", "degraded", "failed"]);
const SOURCE_STATUSES = new Set(["ok", "fallback", "unavailable", "failed"]);
const PORTFOLIO_ROLES = new Set(["family", "ai_only", "excluded"]);
const HASH_RE = /^[a-f0-9]{64}$/;
const COMMIT_RE = /^[a-f0-9]{40}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ERROR_CODE_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const MAX_RUN_MS = 6 * 60 * 60 * 1000;
const MAX_MANIFEST_BYTES = 64 * 1024;

const fail = message => {
  throw new Error(`XUAN-IB run manifest: ${message}`);
};

const isPlainObject = value => value !== null && typeof value === "object"
  && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

const assertObject = (value, label) => {
  if (!isPlainObject(value)) fail(`${label} must be a plain object`);
};

const assertExactKeys = (value, required, optional, label) => {
  assertObject(value, label);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${label} contains unknown field ${key}`);
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) fail(`${label} is missing ${key}`);
  }
};

const parseInstant = (value, label) => {
  if (typeof value !== "string" || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) {
    fail(`${label} must be an RFC 3339 instant with an explicit offset`);
  }
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch)) fail(`${label} is not a valid instant`);
  return epoch;
};

const isCalendarDate = value => {
  if (typeof value !== "string" || !DATE_RE.test(value)) return false;
  const epoch = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(epoch) && new Date(epoch).toISOString().slice(0, 10) === value;
};

const isSourceDate = value => isCalendarDate(value)
  || (typeof value === "string" && /(?:Z|[+-]\d{2}:\d{2})$/i.test(value)
    && Number.isFinite(Date.parse(value)));

const checkSafeStrings = (value, path = "manifest") => {
  if (Array.isArray(value)) {
    value.forEach((item, index) => checkSafeStrings(item, `${path}[${index}]`));
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (/(?:token|secret|password|passwd|cookie|authorization)/i.test(key)) {
        fail(`${path} contains forbidden sensitive field ${key}`);
      }
      checkSafeStrings(item, `${path}.${key}`);
    }
    return;
  }
  if (typeof value !== "string") return;
  const forbidden = [
    /\bhttps?:\/\//i,
    /\bBearer\s+/i,
    /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/,
    /\b(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]{12,}/,
    /\bsk-[A-Za-z0-9_-]{12,}/,
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i
  ];
  if (forbidden.some(pattern => pattern.test(value))) {
    fail(`${path} contains forbidden credential, URL, or contact material`);
  }
};

export function canonicalize(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("canonical input contains a non-finite number");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isPlainObject(value)) fail("canonical input contains a non-plain object");
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
}

export const canonicalJson = value => JSON.stringify(canonicalize(value));

export const sha256Hex = value => crypto.createHash("sha256")
  .update(Buffer.isBuffer(value) || value instanceof Uint8Array ? value : String(value))
  .digest("hex");

export const fingerprint = value => sha256Hex(canonicalJson(value));

export function validateRegistry(registry) {
  assertExactKeys(
    registry,
    ["schemaVersion", "effectiveDate", "approvedBy", "approvedScope", "portfolios", "aggregationRules"],
    [],
    "registry"
  );
  if (registry.schemaVersion !== 1) fail("registry schemaVersion must be 1");
  if (!isCalendarDate(registry.effectiveDate)) fail("registry effectiveDate is invalid");
  if (registry.approvedBy !== "Wu") fail("registry approvedBy must preserve the owner approval");
  if (typeof registry.approvedScope !== "string" || !registry.approvedScope.trim()) {
    fail("registry approvedScope is empty");
  }
  if (!Array.isArray(registry.portfolios)) fail("registry portfolios must be an array");

  const ids = new Set();
  const counts = { family: 0, ai_only: 0, excluded: 0 };
  for (const [index, portfolio] of registry.portfolios.entries()) {
    const label = `registry.portfolios[${index}]`;
    assertExactKeys(
      portfolio,
      ["portfolioId", "portfolioName", "role", "requiredEachReport"],
      [],
      label
    );
    if (!Number.isSafeInteger(portfolio.portfolioId) || portfolio.portfolioId <= 0) {
      fail(`${label}.portfolioId must be a positive integer`);
    }
    if (ids.has(portfolio.portfolioId)) fail(`registry repeats portfolioId ${portfolio.portfolioId}`);
    ids.add(portfolio.portfolioId);
    if (typeof portfolio.portfolioName !== "string" || !portfolio.portfolioName.trim()) {
      fail(`${label}.portfolioName is empty`);
    }
    if (!PORTFOLIO_ROLES.has(portfolio.role)) fail(`${label}.role is invalid`);
    if (typeof portfolio.requiredEachReport !== "boolean") {
      fail(`${label}.requiredEachReport must be boolean`);
    }
    if (portfolio.role === "excluded" && portfolio.requiredEachReport) {
      fail(`${label} cannot require an excluded portfolio`);
    }
    if (portfolio.role !== "excluded" && !portfolio.requiredEachReport) {
      fail(`${label} must require every family and AI-only portfolio`);
    }
    counts[portfolio.role] += 1;
  }
  if (counts.family !== 7 || counts.ai_only !== 2 || counts.excluded !== 1) {
    fail(`registry scope must contain 7 family, 2 AI-only, and 1 excluded portfolio`);
  }

  assertExactKeys(
    registry.aggregationRules,
    ["familyTotal", "aiPressureAuxiliary", "excluded"],
    [],
    "registry.aggregationRules"
  );
  for (const [key, value] of Object.entries(registry.aggregationRules)) {
    if (typeof value !== "string" || !value.trim()) fail(`registry.aggregationRules.${key} is empty`);
  }
  checkSafeStrings(registry, "registry");
  return registry;
}

const validateSourceRecord = (source, label, { allowLag = false, identityKeys = [] } = {}) => {
  assertExactKeys(
    source,
    [...identityKeys, "status", "asOf", "retries", "fingerprint"],
    ["errorCode", "completedUsTradingDayLag"],
    label
  );
  if (!SOURCE_STATUSES.has(source.status)) fail(`${label}.status is invalid`);
  if (!Number.isInteger(source.retries) || source.retries < 0 || source.retries > 5) {
    fail(`${label}.retries must be an integer from 0 to 5`);
  }
  if (source.asOf !== null && !isSourceDate(source.asOf)) fail(`${label}.asOf is invalid`);
  if (source.fingerprint !== null && (typeof source.fingerprint !== "string"
    || !HASH_RE.test(source.fingerprint))) {
    fail(`${label}.fingerprint must be null or lowercase SHA-256`);
  }
  if (source.status === "ok" || source.status === "fallback") {
    if (source.asOf === null || source.fingerprint === null) {
      fail(`${label} needs asOf and fingerprint when data is usable`);
    }
  } else {
    if (typeof source.errorCode !== "string" || !ERROR_CODE_RE.test(source.errorCode)) {
      fail(`${label} needs an allowlisted errorCode when data is not usable`);
    }
  }
  if (source.errorCode !== undefined && !ERROR_CODE_RE.test(source.errorCode)) {
    fail(`${label}.errorCode is invalid`);
  }
  if (source.completedUsTradingDayLag !== undefined) {
    if (!allowLag) fail(`${label} cannot contain completedUsTradingDayLag`);
    if (!Number.isInteger(source.completedUsTradingDayLag)
      || source.completedUsTradingDayLag < 0 || source.completedUsTradingDayLag > 30) {
      fail(`${label}.completedUsTradingDayLag must be an integer from 0 to 30`);
    }
  }
};

const validateMethods = methods => {
  const componentKeys = [
    "runtimeContractHash",
    "scheduleContractHash",
    "addendumHash",
    "registryHash",
    "mappingHash"
  ];
  assertExactKeys(methods, [...componentKeys, "methodBundleHash"], [], "manifest.methods");
  for (const key of [...componentKeys, "methodBundleHash"]) {
    if (typeof methods[key] !== "string" || !HASH_RE.test(methods[key])) {
      fail(`manifest.methods.${key} must be lowercase SHA-256`);
    }
  }
  const expected = fingerprint(Object.fromEntries(componentKeys.map(key => [key, methods[key]])));
  if (methods.methodBundleHash !== expected) fail("manifest.methods.methodBundleHash does not match its components");
};

export function validateManifest(manifest, registry) {
  validateRegistry(registry);
  assertExactKeys(
    manifest,
    [
      "schemaVersion", "runId", "edition", "dataDate", "startedAt", "preparedAt",
      "stages", "sources", "methods", "inputFingerprint"
    ],
    ["previousSourceSha"],
    "manifest"
  );
  if (manifest.schemaVersion !== 1) fail("schemaVersion must be 1");
  if (typeof manifest.runId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(manifest.runId)) {
    fail("runId is invalid");
  }
  if (!EDITIONS.has(manifest.edition)) fail("edition must be am, pm, or adhoc");
  if (!isCalendarDate(manifest.dataDate)) fail("dataDate is invalid");
  const runStart = parseInstant(manifest.startedAt, "manifest.startedAt");
  const prepared = parseInstant(manifest.preparedAt, "manifest.preparedAt");
  if (prepared < runStart || prepared - runStart > MAX_RUN_MS) fail("run duration is negative or exceeds six hours");
  if (typeof manifest.inputFingerprint !== "string" || !HASH_RE.test(manifest.inputFingerprint)) {
    fail("inputFingerprint must be lowercase SHA-256");
  }
  if (manifest.previousSourceSha !== undefined && manifest.previousSourceSha !== null
    && (typeof manifest.previousSourceSha !== "string" || !COMMIT_RE.test(manifest.previousSourceSha))) {
    fail("previousSourceSha must be null or a 40-character lowercase Git SHA");
  }

  if (!Array.isArray(manifest.stages)) fail("stages must be an array");
  if (manifest.stages.length !== RUN_STAGES.length) fail("stages must contain every required stage exactly once");
  const stages = new Map();
  for (const [index, stage] of manifest.stages.entries()) {
    const label = `manifest.stages[${index}]`;
    assertExactKeys(
      stage,
      ["name", "startedAt", "endedAt", "durationMs", "cacheHit", "status"],
      [],
      label
    );
    if (!RUN_STAGES.includes(stage.name) || stages.has(stage.name)) fail(`${label}.name is missing, repeated, or invalid`);
    if (!STAGE_STATUSES.has(stage.status)) fail(`${label}.status is invalid`);
    if (typeof stage.cacheHit !== "boolean") fail(`${label}.cacheHit must be boolean`);
    if ((stage.name === "ib-read" || stage.name === "sharesight-read") && stage.cacheHit) {
      fail(`${stage.name} cannot be a cache hit; live reads are mandatory`);
    }
    const start = parseInstant(stage.startedAt, `${label}.startedAt`);
    const end = parseInstant(stage.endedAt, `${label}.endedAt`);
    if (start < runStart || end < start || end > prepared) fail(`${label} is outside the run boundary`);
    if (!Number.isInteger(stage.durationMs) || stage.durationMs !== end - start) {
      fail(`${label}.durationMs must equal endedAt minus startedAt`);
    }
    stages.set(stage.name, stage);
  }
  for (const name of RUN_STAGES) if (!stages.has(name)) fail(`stage ${name} is missing`);
  for (const name of ["guard", "candidate-prep"]) {
    if (stages.get(name).status !== "ok") fail(`${name} must be ok before a candidate manifest is encoded`);
  }

  validateSourceEvidence(manifest.sources, registry);
  validateMethods(manifest.methods);
  checkSafeStrings(manifest);
  return manifest;
}

// Source-only validation can run BEFORE rendering/guard. It must not create
// fictional successful render/guard stage times merely to assess live reads.
export function validateSourceEvidence(sources, registry) {
  validateRegistry(registry);
  assertExactKeys(sources, ["ib", "sharesight"], [], "manifest.sources");
  assertExactKeys(
    sources.ib,
    ["accountId", "accountScopeConfirmed", ...IB_ENDPOINTS],
    [],
    "manifest.sources.ib"
  );
  if (sources.ib.accountId !== APPROVED_IB_ACCOUNT_ID) fail("IB accountId is outside the approved scope");
  if (typeof sources.ib.accountScopeConfirmed !== "boolean") {
    fail("IB accountScopeConfirmed must be boolean");
  }
  for (const endpoint of IB_ENDPOINTS) {
    validateSourceRecord(sources.ib[endpoint], `manifest.sources.ib.${endpoint}`);
  }

  if (!Array.isArray(sources.sharesight)) fail("manifest.sources.sharesight must be an array");
  const required = registry.portfolios.filter(portfolio => portfolio.requiredEachReport);
  if (sources.sharesight.length !== required.length) {
    fail(`Sharesight sources must contain all ${required.length} required portfolios`);
  }
  const byId = new Map(required.map(portfolio => [portfolio.portfolioId, portfolio]));
  const seen = new Set();
  for (const [index, source] of sources.sharesight.entries()) {
    const label = `manifest.sources.sharesight[${index}]`;
    assertExactKeys(
      source,
      ["portfolioId", "role", "status", "asOf", "retries", "fingerprint"],
      ["errorCode", "completedUsTradingDayLag"],
      label
    );
    if (!Number.isSafeInteger(source.portfolioId) || seen.has(source.portfolioId)) {
      fail(`${label}.portfolioId is invalid or repeated`);
    }
    const expected = byId.get(source.portfolioId);
    if (!expected) fail(`${label}.portfolioId is outside required registry scope`);
    if (source.role !== expected.role) fail(`${label}.role does not match the registry`);
    seen.add(source.portfolioId);
    validateSourceRecord(source, label, {
      allowLag: source.portfolioId === 936247,
      identityKeys: ["portfolioId", "role"]
    });
  }
  for (const portfolio of required) {
    if (!seen.has(portfolio.portfolioId)) fail(`Sharesight portfolio ${portfolio.portfolioId} is missing`);
  }

  checkSafeStrings(sources);
  return sources;
}

const directlyUsable = source => source.status === "ok";
const sharesightUsable = source => source.status === "ok" || source.status === "fallback";

export function assessReadiness(manifest, registry) {
  validateManifest(manifest, registry);
  return assessSourceReadiness(manifest.sources, registry);
}

export function assessSourceReadiness(sources, registry) {
  validateSourceEvidence(sources, registry);
  const issues = [];
  if (!sources.ib.accountScopeConfirmed) {
    return { blocked: true, degraded: true, positionSource: "unavailable", issues: ["ACCOUNT_SCOPE_UNCONFIRMED"] };
  }

  const critical = ["accountSummary", "balances", "orders", "trades"];
  const failedCritical = critical.filter(endpoint => !directlyUsable(sources.ib[endpoint]));
  for (const endpoint of failedCritical) {
    issues.push(`IB_${endpoint.replace(/[A-Z]/g, value => `_${value}`).toUpperCase()}_UNAVAILABLE`);
  }

  let positionSource = "ib";
  if (!directlyUsable(sources.ib.positions)) {
    const ibHk = sources.sharesight.find(source => source.portfolioId === 936247);
    if (ibHk && sharesightUsable(ibHk) && Number.isInteger(ibHk.completedUsTradingDayLag)
      && ibHk.completedUsTradingDayLag <= 1) {
      positionSource = "sharesight-ib-hk";
      issues.push("IB_POSITIONS_FALLBACK_SHARESIGHT_IB_HK");
    } else {
      positionSource = "unavailable";
      issues.push("IB_POSITIONS_UNAVAILABLE");
    }
  }

  const unavailableCriticalCount = failedCritical.length + (positionSource === "unavailable" ? 1 : 0);
  if (unavailableCriticalCount >= 2) {
    return { blocked: true, degraded: true, positionSource, issues };
  }

  for (const source of sources.sharesight) {
    if (!sharesightUsable(source)) issues.push(`SHARESIGHT_${source.portfolioId}_UNAVAILABLE`);
  }
  return { blocked: false, degraded: issues.length > 0, positionSource, issues };
}

export function buildManifestComment(manifest, registry) {
  validateManifest(manifest, registry);
  const json = canonicalJson(manifest);
  if (Buffer.byteLength(json) > MAX_MANIFEST_BYTES) fail("canonical manifest exceeds 64 KiB");
  return `<!-- xuan-ib-run-manifest:v1:${Buffer.from(json).toString("base64url")} -->`;
}

export function extractManifestComment(html, registry) {
  if (typeof html !== "string") fail("HTML must be a string");
  const matches = [...html.matchAll(/<!--\s*xuan-ib-run-manifest:v1:([A-Za-z0-9_-]+)\s*-->/g)];
  if (matches.length !== 1) fail("HTML must contain exactly one v1 manifest comment");
  let json;
  try {
    json = Buffer.from(matches[0][1], "base64url").toString("utf8");
  } catch {
    fail("manifest comment is not valid base64url");
  }
  if (Buffer.byteLength(json) > MAX_MANIFEST_BYTES) fail("decoded manifest exceeds 64 KiB");
  let manifest;
  try {
    manifest = JSON.parse(json);
  } catch {
    fail("manifest comment is not valid JSON");
  }
  if (canonicalJson(manifest) !== json) fail("manifest comment JSON is not canonical");
  validateManifest(manifest, registry);
  return manifest;
}

const loadJson = path => JSON.parse(fs.readFileSync(path, "utf8"));

function cli(argv) {
  const [command, inputPath, registryPath] = argv;
  if (!command || !inputPath || !registryPath) {
    console.error("usage: xuan-ib-run-manifest.mjs validate|comment|extract INPUT REGISTRY");
    return 2;
  }
  try {
    const registry = loadJson(registryPath);
    if (command === "extract") {
      const manifest = extractManifestComment(fs.readFileSync(inputPath, "utf8"), registry);
      process.stdout.write(`${canonicalJson(manifest)}\n`);
      return 0;
    }
    const manifest = loadJson(inputPath);
    validateManifest(manifest, registry);
    if (command === "validate") {
      const readiness = assessReadiness(manifest, registry);
      process.stdout.write(`${JSON.stringify(readiness)}\n`);
      return readiness.blocked ? 1 : 0;
    }
    if (command === "comment") {
      process.stdout.write(`${buildManifestComment(manifest, registry)}\n`);
      return 0;
    }
    console.error(`unknown command ${command}`);
    return 2;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = cli(process.argv.slice(2));
}
