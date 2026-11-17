#!/usr/bin/env node

// Amount-free supervisor for repeated fee cloud producer failures. It never
// receives portfolio/economic credentials and can only maintain one GitHub
// repair issue for Codex review.

import { boundedJson } from './fee-http-json.mjs';

const ISSUE_TITLE = "[fee-cloud] producer needs Codex diagnosis";
const ALLOWED_EVENTS = new Set(["schedule", "workflow_dispatch"]);
const FAILED_CONCLUSIONS = new Set(['failure', 'timed_out']);
// The mention is what makes GitHub notify the owner by e-mail and in the app. Amount-free by construction.
const OWNER_NOTICE = "@huanwujoy-crypto 自动发布连续失败，页面可能没有更新。请在 Claude 的 fee-console 会话里说“今天没有更新”，由助手排查。";
const RECOVERED_COMMENT = "自动发布已恢复：最近一次运行完成了计算并生成了待上线数据，此后没有新的失败。本工单自动关闭。";

// These fixed reviewed jobs have no writer. Their outcomes are neither production
// failure nor recovery evidence. Titles alone cannot suppress production alerts.
export function isIbReadOnlyDiagnostic(run) {
  return (run?.display_title === 'IB diagnostic 2026-11-04' || run?.display_title === 'IB diagnostic 2026-11-06'
      || run?.display_title === 'Fee source probe')
    && run.event === 'workflow_dispatch' && run.head_branch === 'main'
    && run.path === '.github/workflows/fee-cloud-producer.yml'
    && run.actor?.id === 283054367 && run.run_attempt === 1
    && /^[a-f0-9]{40}$/.test(run.head_sha || '');
}

export function consecutiveFailures(runs) {
  let count = 0;
  for (const run of runs) {
    if (!run || isIbReadOnlyDiagnostic(run) || !ALLOWED_EVENTS.has(run.event) || run.status !== "completed") continue;
    if (run.conclusion === "success" && run.producerValidated === true) break;
    if (FAILED_CONCLUSIONS.has(run.conclusion)) count++;
  }
  return count;
}

export function diagnosticBody(runs) {
  const failures = runs.filter(run => run && !isIbReadOnlyDiagnostic(run) && FAILED_CONCLUSIONS.has(run.conclusion) && ALLOWED_EVENTS.has(run.event)).slice(0, 5);
  const lines = failures.map(run => `- ${run.created_at}: ${run.html_url}`);
  return [
    OWNER_NOTICE,
    "",
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

// This proves only the producer's own executed phases, not that the candidate was promoted. Since the
// workflow gained its gates and diagnostics a normal run has a dozen jobs, most of them skipped, and the
// producing job is named for its report ("Produce daily 2026-11-16"). Accept that shape: every job of
// the run finished as success or skipped, the public period gate succeeded when there is more than one
// job, and exactly one producing job ran both the calculation and the signing step.
const PRODUCE_JOB = /^Produce (?:daily|weekly|monthly) \d{4}-\d{2}-\d{2}$/;
export function isValidatedProducer(run, jobs) {
  if (run?.status !== 'completed' || run.conclusion !== 'success' || !ALLOWED_EVENTS.has(run.event)
      || run.head_branch !== 'main' || !Number.isSafeInteger(run.id) || run.id <= 0
      || !/^[a-f0-9]{40}$/.test(run.head_sha || '') || !Number.isSafeInteger(jobs?.total_count)
      || jobs.total_count < 1 || jobs.total_count > 100
      || !Array.isArray(jobs.jobs) || jobs.jobs.length !== jobs.total_count) return false;
  const own=job=>job?.run_id===run.id&&job.head_sha===run.head_sha&&job.status==='completed'&&['success','skipped'].includes(job.conclusion);
  if(!jobs.jobs.every(own))return false;
  const ran=job=>job.conclusion==='success'&&Array.isArray(job.steps);
  if(jobs.total_count>1&&jobs.jobs.filter(job=>job.name==='period'&&ran(job)).length!==1)return false;
  const produced=jobs.jobs.filter(job=>ran(job)&&(jobs.total_count===1||job.name==='produce'||PRODUCE_JOB.test(job.name||'')));
  if(produced.length!==1)return false;
  return ['Read, calculate and validate the encrypted candidate', 'Create a signed owner candidate']
    .every(name => produced[0].steps.filter(step => step.name === name && step.status === 'completed'
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
    if (!run || isIbReadOnlyDiagnostic(run) || !ALLOWED_EVENTS.has(run.event) || run.status !== 'completed' || run.conclusion !== 'success') continue;
    if (!Number.isSafeInteger(run.id) || run.id <= 0) continue;
    try {
      const jobs = await api(`/repos/${repo}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`, token);
      run.producerValidated = isValidatedProducer(run, jobs);
      if (run.producerValidated) break;
    } catch { console.log('FEE_SUPERVISOR_EXECUTION_UNVERIFIED'); }
  }
  const count = consecutiveFailures(runs);
  // Owner decision 2026-11-17: an open issue must not outlive the fault, because a stale one silently
  // absorbs the next alert. When the newest production run is a validated producer execution and nothing
  // has failed since, say so and close. A run that merely skipped (not due, already published) proves
  // nothing and leaves the issue open.
  if (issue && count === 0 && runs.some(run => run?.producerValidated === true)) {
    await api(`/repos/${owner}/${name}/issues/${issue.number}/comments`, token, {
      method: "POST", body: JSON.stringify({ body: RECOVERED_COMMENT }),
    });
    await api(`/repos/${owner}/${name}/issues/${issue.number}`, token, {
      method: "PATCH", body: JSON.stringify({ state: "closed", state_reason: "completed" }),
    });
    console.log('FEE_SUPERVISOR_RECOVERED');
    return;
  }
  if (issue) console.log('FEE_SUPERVISOR_RECOVERY_UNVERIFIED');
  if (count < 2) {
    console.log(`FEE_SUPERVISOR_WAITING failures=${count}`);
    return;
  }
  const body = diagnosticBody(runs);
  if (issue) {
    await api(`/repos/${owner}/${name}/issues/${issue.number}`, token, {
      method: "PATCH", body: JSON.stringify({ body }),
    });
    // Editing a body notifies nobody; a comment does.
    await api(`/repos/${owner}/${name}/issues/${issue.number}/comments`, token, {
      method: "POST", body: JSON.stringify({ body: `${OWNER_NOTICE}\n\nFailures in a row: ${count}.` }),
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
