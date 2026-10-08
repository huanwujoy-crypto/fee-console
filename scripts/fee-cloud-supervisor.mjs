#!/usr/bin/env node

// Amount-free supervisor for repeated fee cloud producer failures. It never
// receives portfolio/economic credentials and can only maintain one GitHub
// repair issue for Codex review.

import { boundedJson } from './fee-http-json.mjs';

const ISSUE_TITLE = "[fee-cloud] producer needs Codex diagnosis";
const ALLOWED_EVENTS = new Set(["schedule", "workflow_dispatch"]);
const FAILED_CONCLUSIONS = new Set(['failure', 'timed_out']);

export function consecutiveFailures(runs) {
  let count = 0;
  for (const run of runs) {
    if (!run || !ALLOWED_EVENTS.has(run.event) || run.status !== "completed") continue;
    if (run.conclusion === "success" && run.producerValidated === true) break;
    if (FAILED_CONCLUSIONS.has(run.conclusion)) count++;
  }
  return count;
}

export function diagnosticBody(runs) {
  const failures = runs.filter(run => run && FAILED_CONCLUSIONS.has(run.conclusion) && ALLOWED_EVENTS.has(run.event)).slice(0, 5);
  const lines = failures.map(run => `- ${run.created_at}: ${run.html_url}`);
  return [
    "The deterministic fee cloud producer failed at least twice consecutively.",
    "",
    "This is a Codex repair candidate only. Reproduce the failure, preserve fail-closed behavior, add a regression test, and open a reviewed pull request. Do not edit the formal encrypted ledger, data.json, the economic Gist, investor shares, or production secrets directly.",
    "",
    "Recent failed runs:",
    ...lines,
    "",
    "The workflow summaries and logs contain the amount-free diagnostic code. A skipped/already-published or shadow run is not recovery proof.",
  ].join("\n");
}

async function api(path, token, init = {}) {
  return boundedJson(fetch, `https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      ...init.headers,
    },
  }, { timeoutMs: 15_000, maxBytes: 8 * 1024 * 1024, statuses: [200, 201, 204] });
}

// This proves only the producer's own executed phases. It cannot attest that
// this run's candidate was promoted; automatic repair closure remains disabled.
export function isValidatedProducer(run, jobs) {
  if (run?.status !== 'completed' || run.conclusion !== 'success' || !ALLOWED_EVENTS.has(run.event)
      || run.head_branch !== 'main' || !Number.isSafeInteger(run.id) || run.id <= 0
      || !/^[a-f0-9]{40}$/.test(run.head_sha || '') || jobs?.total_count !== 1
      || !Array.isArray(jobs.jobs) || jobs.jobs.length !== 1) return false;
  const job = jobs.jobs[0];
  if (job?.run_id !== run.id || job.head_sha !== run.head_sha || job.status !== 'completed'
      || job.conclusion !== 'success' || !Array.isArray(job.steps)) return false;
  return ['Read, calculate and validate the encrypted candidate', 'Create a signed owner candidate']
    .every(name => job.steps.filter(step => step.name === name && step.status === 'completed'
      && step.conclusion === 'success').length === 1);
}

async function main() {
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  if (repo !== 'huanwujoy-crypto/fee-console' || !token) throw new Error("FEE_SUPERVISOR_CONFIG");
  const [owner, name] = repo.split("/");
  const result = await api(`/repos/${owner}/${name}/actions/workflows/fee-cloud-producer.yml/runs?branch=main&status=completed&per_page=20`, token);
  const runs = Array.isArray(result.workflow_runs) ? result.workflow_runs.map(run => ({ ...run, producerValidated: false })) : [];
  const issues = await api(`/repos/${owner}/${name}/issues?state=open&per_page=100`, token);
  const issue = issues.find(item => item && item.pull_request == null && item.title === ISSUE_TITLE);
  // Inspect historical successes too, so a new failure does not accumulate
  // failures that precede a genuinely validated producer execution.
  for (const run of runs) {
    if (!run || !ALLOWED_EVENTS.has(run.event) || run.status !== 'completed' || run.conclusion !== 'success') continue;
    if (!Number.isSafeInteger(run.id) || run.id <= 0) continue;
    try {
      const jobs = await api(`/repos/${repo}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`, token);
      run.producerValidated = isValidatedProducer(run, jobs);
      if (run.producerValidated) break;
    } catch { console.log('FEE_SUPERVISOR_EXECUTION_UNVERIFIED'); }
  }
  // A window-matching health timestamp cannot bind publication to this run.
  // Keep existing issues open until a separately reviewed run-bound receipt is
  // available. No unrelated local publication may automatically clear a fault.
  if (issue) console.log('FEE_SUPERVISOR_RECOVERY_UNVERIFIED');
  const count = consecutiveFailures(runs);
  if (count < 2) {
    console.log(`FEE_SUPERVISOR_WAITING failures=${count}`);
    return;
  }
  const body = diagnosticBody(runs);
  if (issue) {
    await api(`/repos/${owner}/${name}/issues/${issue.number}`, token, {
      method: "PATCH", body: JSON.stringify({ body }),
    });
  } else {
    await api(`/repos/${owner}/${name}/issues`, token, {
      method: "POST", body: JSON.stringify({ title: ISSUE_TITLE, body }),
    });
  }
  console.log(`FEE_SUPERVISOR_ESCALATED failures=${count}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error(/^FEE_SUPERVISOR_[A-Z0-9_]+$/.test(String(error?.message)) ? error.message : "FEE_SUPERVISOR_FAILED");
    process.exitCode = 1;
  });
}
