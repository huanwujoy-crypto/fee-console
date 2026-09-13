import assert from "node:assert/strict";
import { test } from "node:test";

import { buildHealth, HEALTH_SCHEMA, validateHealth } from "./fee-data-health.mjs";

const base = () => ({
  schema: HEALTH_SCHEMA,
  checkedAt: "2026-09-13T05:30:00.000Z",
  targetDate: "2026-09-11",
  sourceDates: { schwab: "2026-09-11", webull: "2026-09-11", benchmark: "2026-09-11" },
  outcome: "no-op",
  dataSha256: "a".repeat(64),
  errorCode: null,
});

test("accepts a current amount-free weekend no-op receipt", () => {
  assert.deepEqual(validateHealth(base(), { now: new Date("2026-09-13T06:00:00Z") }), []);
});

test("rejects extra fields and private-looking detail", () => {
  assert.deepEqual(validateHealth({ ...base(), amount: 1 }, { now: new Date("2026-09-13T06:00:00Z") }), ["health receipt shape"]);
});

test("rejects stale, future, or excessively lagged source dates", () => {
  assert.ok(validateHealth({ ...base(), checkedAt: "2026-09-10T05:30:00Z" }, { now: new Date("2026-09-13T06:00:00Z") }).includes("health receipt age"));
  assert.ok(validateHealth({ ...base(), sourceDates: { ...base().sourceDates, benchmark: "2026-09-12" } }, { now: new Date("2026-09-13T06:00:00Z") }).includes("health benchmark source lag"));
  assert.ok(validateHealth({ ...base(), sourceDates: { ...base().sourceDates, benchmark: "2026-09-01" } }, { now: new Date("2026-09-13T06:00:00Z") }).includes("health benchmark source lag"));
  assert.ok(validateHealth({ ...base(), targetDate: "2026-99-99" }, { now: new Date("2026-09-13T06:00:00Z") }).includes("health target date"));
});

test("failed receipts require an allowlisted fixed code", () => {
  assert.deepEqual(validateHealth({ ...base(), outcome: "failed", errorCode: "SHARESIGHT_UNSTABLE" }, { now: new Date("2026-09-13T06:00:00Z") }), []);
  assert.ok(validateHealth({ ...base(), outcome: "failed", errorCode: "token=secret" }, { now: new Date("2026-09-13T06:00:00Z") }).includes("health failure code"));
});

test("builder emits the exact public schema", () => {
  assert.deepEqual(buildHealth(base()), base());
});
