import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  RUN_STAGES,
  assessReadiness,
  buildManifestComment,
  canonicalJson,
  extractManifestComment,
  fingerprint,
  sha256Hex,
  validateManifest,
  validateRegistry
} from "./xuan-ib-run-manifest.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const registry = JSON.parse(fs.readFileSync(
  path.join(here, "..", "claude", "xuan-ib-portfolio-registry.json"),
  "utf8"
));

const clone = value => JSON.parse(JSON.stringify(value));
const hash = label => sha256Hex(`fixture:${label}`);
const source = (label, overrides = {}) => ({
  status: "ok",
  asOf: "2026-08-30T15:00:00+08:00",
  retries: 0,
  fingerprint: hash(label),
  ...overrides
});

const stages = () => {
  const boundaries = {
    bootstrap: [0, 1000],
    "ib-read": [1000, 4000],
    "sharesight-read": [1500, 4500],
    validate: [4500, 5000],
    derive: [5000, 5600],
    narrative: [5600, 6500],
    render: [6500, 7000],
    guard: [7000, 7300],
    "candidate-prep": [7300, 8000]
  };
  const epoch = Date.parse("2026-08-30T15:00:00+08:00");
  return RUN_STAGES.map(name => {
    const [start, end] = boundaries[name];
    return {
      name,
      startedAt: new Date(epoch + start).toISOString(),
      endedAt: new Date(epoch + end).toISOString(),
      durationMs: end - start,
      cacheHit: false,
      status: "ok"
    };
  });
};

const methods = () => {
  const components = {
    runtimeContractHash: hash("runtime-contract"),
    scheduleContractHash: hash("schedule-contract"),
    addendumHash: hash("addendum"),
    registryHash: hash("registry"),
    mappingHash: hash("mapping")
  };
  return { ...components, methodBundleHash: fingerprint(components) };
};

const validManifest = () => ({
  schemaVersion: 1,
  runId: "adhoc-20260830-150000",
  edition: "adhoc",
  dataDate: "2026-08-30",
  startedAt: "2026-08-30T15:00:00+08:00",
  preparedAt: "2026-08-30T15:00:08+08:00",
  stages: stages(),
  sources: {
    ib: {
      accountId: "U6859001",
      accountScopeConfirmed: true,
      accountSummary: source("ib-account-summary"),
      balances: source("ib-balances"),
      positions: source("ib-positions"),
      orders: source("ib-orders"),
      trades: source("ib-trades")
    },
    sharesight: registry.portfolios
      .filter(portfolio => portfolio.requiredEachReport)
      .map(portfolio => ({
        portfolioId: portfolio.portfolioId,
        role: portfolio.role,
        ...source(`sharesight-${portfolio.portfolioId}`),
        ...(portfolio.portfolioId === 936247 ? { completedUsTradingDayLag: 0 } : {})
      }))
  },
  methods: methods(),
  inputFingerprint: hash("complete-normalized-live-inputs"),
  previousSourceSha: "a".repeat(40)
});

const failSource = errorCode => ({
  status: "failed",
  asOf: null,
  retries: 2,
  fingerprint: null,
  errorCode
});

test("the registry pins seven family, two AI-only, and one excluded portfolio", () => {
  assert.equal(validateRegistry(registry), registry);
  const byRole = role => registry.portfolios.filter(portfolio => portfolio.role === role);
  assert.deepEqual(
    byRole("family").map(portfolio => portfolio.portfolioId),
    [936238, 936240, 1021748, 1031350, 936247, 936243, 1350095]
  );
  assert.deepEqual(byRole("ai_only").map(portfolio => portfolio.portfolioId), [936249, 1350094]);
  assert.deepEqual(byRole("excluded").map(portfolio => portfolio.portfolioId), [1021747]);
  assert.equal(registry.portfolios.filter(portfolio => portfolio.requiredEachReport).length, 9);
  assert.equal(registry.approvedBy, "Wu");
  assert.equal(registry.portfolios.find(portfolio => portfolio.portfolioId === 936243).portfolioName,
    "Citi-HK & 地产四期");
});

test("a complete manifest validates and reports a healthy direct IB position source", () => {
  const manifest = validManifest();
  assert.equal(validateManifest(manifest, registry), manifest);
  assert.deepEqual(assessReadiness(manifest, registry), {
    blocked: false,
    degraded: false,
    positionSource: "ib",
    issues: []
  });
});

test("parallel stage intervals are allowed but durations are recomputed exactly", () => {
  const manifest = validManifest();
  const ib = manifest.stages.find(stage => stage.name === "ib-read");
  const sharesight = manifest.stages.find(stage => stage.name === "sharesight-read");
  assert.ok(Date.parse(sharesight.startedAt) < Date.parse(ib.endedAt));
  validateManifest(manifest, registry);

  ib.durationMs += 1;
  assert.throws(() => validateManifest(manifest, registry), /durationMs must equal/);
});

test("live IB and Sharesight reads can never be represented as cache hits", () => {
  for (const name of ["ib-read", "sharesight-read"]) {
    const manifest = validManifest();
    manifest.stages.find(stage => stage.name === name).cacheHit = true;
    assert.throws(() => validateManifest(manifest, registry), /live reads are mandatory/);
  }
});

test("the manifest requires every registry portfolio but never the excluded one", () => {
  const manifest = validManifest();
  manifest.sources.sharesight.pop();
  assert.throws(() => validateManifest(manifest, registry), /all 9 required portfolios/);

  const withExcluded = validManifest();
  withExcluded.sources.sharesight.push({
    portfolioId: 1021747,
    role: "excluded",
    ...source("excluded")
  });
  assert.throws(() => validateManifest(withExcluded, registry), /all 9 required portfolios/);
});

test("an IB positions failure uses a fresh Sharesight IB-HK fallback", () => {
  const manifest = validManifest();
  manifest.sources.ib.positions = failSource("SERVICE_UNAVAILABLE");
  const ibHk = manifest.sources.sharesight.find(item => item.portfolioId === 936247);
  ibHk.completedUsTradingDayLag = 1;

  assert.deepEqual(assessReadiness(manifest, registry), {
    blocked: false,
    degraded: true,
    positionSource: "sharesight-ib-hk",
    issues: ["IB_POSITIONS_FALLBACK_SHARESIGHT_IB_HK"]
  });
});

test("a stale positions fallback leaves position-dependent fields unavailable without guessing", () => {
  const manifest = validManifest();
  manifest.sources.ib.positions = failSource("SERVICE_UNAVAILABLE");
  manifest.sources.sharesight.find(item => item.portfolioId === 936247)
    .completedUsTradingDayLag = 2;

  const result = assessReadiness(manifest, registry);
  assert.equal(result.blocked, false);
  assert.equal(result.degraded, true);
  assert.equal(result.positionSource, "unavailable");
  assert.deepEqual(result.issues, ["IB_POSITIONS_UNAVAILABLE"]);
});

test("one critical IB failure degrades while two failures or unknown scope block", () => {
  const one = validManifest();
  one.sources.ib.orders = failSource("SERVICE_UNAVAILABLE");
  assert.equal(assessReadiness(one, registry).blocked, false);
  assert.equal(assessReadiness(one, registry).degraded, true);

  const two = validManifest();
  two.sources.ib.orders = failSource("SERVICE_UNAVAILABLE");
  two.sources.ib.trades = failSource("SERVICE_UNAVAILABLE");
  assert.equal(assessReadiness(two, registry).blocked, true);

  const unknownScope = validManifest();
  unknownScope.sources.ib.accountScopeConfirmed = false;
  assert.deepEqual(assessReadiness(unknownScope, registry).issues, ["ACCOUNT_SCOPE_UNCONFIRMED"]);
  assert.equal(assessReadiness(unknownScope, registry).blocked, true);
});

test("positions unavailable plus one other critical IB failure blocks, unless the fallback is valid", () => {
  const blocked = validManifest();
  blocked.sources.ib.positions = failSource("SERVICE_UNAVAILABLE");
  blocked.sources.ib.orders = failSource("SERVICE_UNAVAILABLE");
  blocked.sources.sharesight.find(item => item.portfolioId === 936247)
    .completedUsTradingDayLag = 2;
  const blockedResult = assessReadiness(blocked, registry);
  assert.equal(blockedResult.blocked, true);
  assert.equal(blockedResult.positionSource, "unavailable");
  assert.deepEqual(blockedResult.issues, ["IB_ORDERS_UNAVAILABLE", "IB_POSITIONS_UNAVAILABLE"]);

  const allowed = validManifest();
  allowed.sources.ib.positions = failSource("SERVICE_UNAVAILABLE");
  allowed.sources.ib.orders = failSource("SERVICE_UNAVAILABLE");
  allowed.sources.sharesight.find(item => item.portfolioId === 936247)
    .completedUsTradingDayLag = 1;
  const allowedResult = assessReadiness(allowed, registry);
  assert.equal(allowedResult.blocked, false);
  assert.equal(allowedResult.positionSource, "sharesight-ib-hk");
  assert.deepEqual(allowedResult.issues, [
    "IB_ORDERS_UNAVAILABLE",
    "IB_POSITIONS_FALLBACK_SHARESIGHT_IB_HK"
  ]);
});

test("Sharesight cannot masquerade as a fallback for an IB-authoritative endpoint", () => {
  const manifest = validManifest();
  manifest.sources.ib.balances.status = "fallback";
  const result = assessReadiness(manifest, registry);
  assert.equal(result.blocked, false);
  assert.equal(result.degraded, true);
  assert.deepEqual(result.issues, ["IB_BALANCES_UNAVAILABLE"]);
});

test("canonical fingerprints are independent of object key order and sensitive to inputs", () => {
  assert.equal(fingerprint({ b: 2, a: { y: 1, x: 0 } }), fingerprint({ a: { x: 0, y: 1 }, b: 2 }));
  assert.notEqual(fingerprint({ source: 1, asOf: "2026-08-29" }), fingerprint({ source: 1, asOf: "2026-08-30" }));
  assert.equal(canonicalJson({ b: 2, a: 1 }), '{"a":1,"b":2}');
});

test("changing a method component without rebuilding its bundle hash is rejected", () => {
  const manifest = validManifest();
  manifest.methods.mappingHash = hash("changed-mapping");
  assert.throws(() => validateManifest(manifest, registry), /methodBundleHash does not match/);
});

test("manifest comments round-trip canonical JSON and reject duplicates", () => {
  const manifest = validManifest();
  const comment = buildManifestComment(manifest, registry);
  assert.deepEqual(extractManifestComment(`<!doctype html>${comment}<p>report</p>`, registry), manifest);
  assert.throws(() => extractManifestComment(`${comment}${comment}`, registry), /exactly one/);
});

test("raw errors, financial fields, URLs, and credentials cannot enter the manifest", () => {
  const rawError = validManifest();
  rawError.sources.ib.positions.rawError = "service said no";
  assert.throws(() => validateManifest(rawError, registry), /unknown field rawError/);

  const amount = validManifest();
  amount.sources.sharesight[0].amount = 100;
  assert.throws(() => validateManifest(amount, registry), /unknown field amount/);

  const url = validManifest();
  url.runId = "https://example.invalid/run";
  assert.throws(() => validateManifest(url, registry), /runId is invalid/);

  const credential = validManifest();
  credential.sources.ib.positions.errorCode = "Bearer abcdefghijklmnopqrstuvwxyz";
  assert.throws(() => validateManifest(credential, registry), /errorCode is invalid/);
});

test("a usable source requires provenance and an unusable source requires an error code", () => {
  const missingFingerprint = validManifest();
  missingFingerprint.sources.ib.balances.fingerprint = null;
  assert.throws(() => validateManifest(missingFingerprint, registry), /needs asOf and fingerprint/);

  const missingError = validManifest();
  missingError.sources.ib.balances = {
    status: "failed",
    asOf: null,
    retries: 1,
    fingerprint: null
  };
  assert.throws(() => validateManifest(missingError, registry), /needs an allowlisted errorCode/);
});
