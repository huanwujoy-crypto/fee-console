import assert from "node:assert/strict";
import test from "node:test";
import { feeTriggerDecision } from "./fee-trigger-decision.mjs";

const now = new Date("2026-10-02T04:30:00Z"), hash = "a".repeat(64);
const health = { schema: "fee-console.daily-health.v1", checkedAt: "2026-10-02T04:10:00Z",
  targetDate: "2026-10-01", sourceDates: { schwab: "2026-10-01", webull: "2026-10-01", benchmark: "2026-10-01" },
  outcome: "updated", dataSha256: hash, errorCode: null };
const input = overrides => ({ now, expectedTargetDate: "2026-10-01", mainHealth: health, publicHealth: health,
  mainHash: hash, publicHash: hash, runs: [], ...overrides });

test("only verified same-target public/main receipts and hashes prove publication", () => {
  assert.equal(feeTriggerDecision(input()), "published");
  assert.equal(feeTriggerDecision(input({ publicHash: "b".repeat(64) })), "dispatch_once");
  assert.equal(feeTriggerDecision(input({ mainHealth: { ...health, targetDate: "2026-09-30" } })), "dispatch_once");
  assert.equal(feeTriggerDecision(input({ publicHealth: { ...health, sourceDates: { ...health.sourceDates, webull: "2026-09-30" } } })), "dispatch_once");
  assert.equal(feeTriggerDecision(input({ mainHealth: { ...health, checkedAt: "2026-10-01T04:10:00Z" } })), "dispatch_once");
});
test("active runs, promotion delays, durable leases and uncertain POSTs prevent duplicate dispatch", () => {
  const run = { head_branch: "main", event: "workflow_dispatch" };
  for (const status of ["queued", "in_progress", "waiting", "pending", "requested"]) {
    assert.equal(feeTriggerDecision(input({ publicHash: null, runs: [{ ...run, status }] })), "producer_active");
  }
  assert.equal(feeTriggerDecision(input({ publicHash: null, runs: [{ ...run, status: "completed", conclusion: "success", updated_at: "2026-10-02T04:05:00Z" }] })), "publication_pending");
  assert.equal(feeTriggerDecision(input({ publicHash: null, leaseUntil: "2026-10-02T04:35:00Z" })), "lease_held");
  assert.equal(feeTriggerDecision(input({ publicHash: null, lastAttemptAt: "2026-10-02T04:29:00Z" })), "cooldown");
  assert.equal(feeTriggerDecision(input({ publicHash: null, lastAttemptAt: "invalid" })), "cooldown");
  assert.equal(feeTriggerDecision(input({ publicHash: null, runs: [{ ...run, status: "completed", conclusion: "failure", updated_at: "2026-10-02T03:00:00Z" }] })), "dispatch_once");
});
test("Hong Kong weekday/window and unverified target dates fail closed", () => {
  assert.equal(feeTriggerDecision(input({ now: new Date("2026-10-02T03:44:00Z") })), "outside_window");
  assert.equal(feeTriggerDecision(input({ now: new Date("2026-10-04T04:30:00Z") })), "outside_window");
  assert.equal(feeTriggerDecision(input({ expectedTargetDate: "2026-10-02" })), "target_unverified");
  assert.throws(() => feeTriggerDecision(input({ expectedTargetDate: "2026-02-30" })), /FEE_TRIGGER_INPUT/);
});
