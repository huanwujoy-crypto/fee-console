// Pure policy for an external scheduler relay. This module has no credentials,
// network calls, financial calculation, or publication authority.
import { validateHealth } from "./fee-data-health.mjs";

const isoDate = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
  && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const hktDate = now => new Date(now.getTime() + 8 * 3600000).toISOString().slice(0, 10);
const activeStatuses = new Set(["queued", "in_progress", "waiting", "pending", "requested"]);

export function feeTriggerDecision({ now, expectedTargetDate, mainHealth, publicHealth,
  mainHash, publicHash, runs, leaseUntil = null, lastAttemptAt = null }) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime()) || !isoDate(expectedTargetDate)
      || !Array.isArray(runs)) throw new Error("FEE_TRIGGER_INPUT");
  const local = new Date(now.getTime() + 8 * 3600000);
  const minutes = local.getUTCHours() * 60 + local.getUTCMinutes();
  if (local.getUTCDay() < 2 || local.getUTCDay() > 6 || minutes < 11 * 60 + 45 || minutes > 18 * 60 + 15) {
    return "outside_window";
  }
  if (expectedTargetDate >= hktDate(now)
      || now.getTime() - Date.parse(`${expectedTargetDate}T00:00:00Z`) > 4 * 86400000) {
    return "target_unverified";
  }
  const good = receipt => receipt && validateHealth(receipt, { now }).length === 0
    && ["updated", "no-op"].includes(receipt.outcome)
    && hktDate(new Date(receipt.checkedAt)) === hktDate(now)
    && receipt.targetDate === expectedTargetDate
    && ["schwab", "webull", "benchmark"].every(key => receipt.sourceDates[key] === expectedTargetDate);
  if (good(mainHealth) && good(publicHealth) && JSON.stringify(mainHealth) === JSON.stringify(publicHealth)
      && /^[a-f0-9]{64}$/.test(mainHash || "") && mainHash === publicHash
      && mainHealth.dataSha256 === mainHash) return "published";
  const latestProducer = runs.filter(run => run?.head_branch === "main"
    && ["schedule", "workflow_dispatch"].includes(run.event));
  if (latestProducer.some(run => activeStatuses.has(run.status))) return "producer_active";
  // A successful producer with an unverified public release needs investigation,
  // rather than another producer that could create competing candidates.
  if (latestProducer.some(run => run.status === "completed" && run.conclusion === "success"
      && Number.isFinite(Date.parse(run.updated_at))
      && hktDate(new Date(run.updated_at)) === hktDate(now))) return "publication_pending";
  if (leaseUntil !== null && (!Number.isFinite(Date.parse(leaseUntil))
      || Date.parse(leaseUntil) > now.getTime())) return "lease_held";
  // A transport failure after POST is uncertain. Retain the attempt even when
  // there is no run ID yet; never immediately resend a possibly accepted POST.
  const attempts = [lastAttemptAt, ...latestProducer.map(run => run.updated_at || run.created_at)]
    .filter(value => value !== null && value !== undefined).map(value => Date.parse(value));
  if (attempts.some(value => !Number.isFinite(value) || value > now.getTime() - 45 * 60000)) return "cooldown";
  return "dispatch_once";
}
