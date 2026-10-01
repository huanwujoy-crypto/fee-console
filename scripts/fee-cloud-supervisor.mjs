#!/usr/bin/env node

// Amount-free supervisor for repeated fee cloud producer failures. It never
// receives portfolio/economic credentials and can only maintain one GitHub
// repair issue for Codex review.

const ISSUE_TITLE = "[fee-cloud] producer needs Codex diagnosis";
const ALLOWED_EVENTS = new Set(["schedule", "workflow_dispatch"]);

export function consecutiveFailures(runs) {
  let count = 0;
  for (const run of runs) {
    if (!run || !ALLOWED_EVENTS.has(run.event) || run.status !== "completed") continue;
    if (run.conclusion === "success") break;
    if (run.conclusion === "failure") count++;
  }
  return count;
}

export function diagnosticBody(runs) {
  const failures = runs.filter(run => run && run.conclusion === "failure" && ALLOWED_EVENTS.has(run.event)).slice(0, 5);
  const lines = failures.map(run => `- ${run.created_at}: ${run.html_url}`);
  return [
    "The deterministic fee cloud producer failed at least twice consecutively.",
    "",
    "This is a Codex repair candidate only. Reproduce the failure, preserve fail-closed behavior, add a regression test, and open a reviewed pull request. Do not edit the formal encrypted ledger, data.json, the economic Gist, investor shares, or production secrets directly.",
    "",
    "Recent failed runs:",
    ...lines,
    "",
    "The workflow summaries contain the amount-free diagnostic code.",
  ].join("\n");
}

async function api(path, token, init = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
  if (!response.ok) throw new Error(`FEE_SUPERVISOR_HTTP_${response.status}`);
  return response.status === 204 ? null : response.json();
}

async function main() {
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo || "") || !token) throw new Error("FEE_SUPERVISOR_CONFIG");
  const [owner, name] = repo.split("/");
  const result = await api(`/repos/${owner}/${name}/actions/workflows/fee-cloud-producer.yml/runs?branch=main&status=completed&per_page=20`, token);
  const runs = Array.isArray(result.workflow_runs) ? result.workflow_runs : [];
  const issues = await api(`/repos/${owner}/${name}/issues?state=open&per_page=100`, token);
  const issue = issues.find(item => item && item.pull_request == null && item.title === ISSUE_TITLE);
  const latest = runs.find(run => run && ALLOWED_EVENTS.has(run.event));
  if (latest?.conclusion === "success") {
    if (issue) await api(`/repos/${owner}/${name}/issues/${issue.number}`, token, {
      method: "PATCH", body: JSON.stringify({ state: "closed", state_reason: "completed" }),
    });
    console.log("FEE_SUPERVISOR_HEALTHY");
    return;
  }
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
