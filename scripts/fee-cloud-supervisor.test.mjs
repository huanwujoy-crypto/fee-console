import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { consecutiveFailures, diagnosticBody } from "./fee-cloud-supervisor.mjs";

const run = (conclusion, id, event = "schedule") => ({
  id, status: "completed", conclusion, event,
  created_at: `2026-10-01T0${id}:00:00Z`, html_url: `https://github.test/runs/${id}`,
});

test("supervisor escalates only consecutive scheduled or manual producer failures", () => {
  assert.equal(consecutiveFailures([run("failure", 3), run("failure", 2), run("success", 1)]), 2);
  assert.equal(consecutiveFailures([run("failure", 3), run("success", 2), run("failure", 1)]), 1);
  assert.equal(consecutiveFailures([run("failure", 3, "push"), run("failure", 2), run("failure", 1)]), 2);
});

test("diagnostic issue is amount-free and forbids direct ledger repair", () => {
  const body = diagnosticBody([run("failure", 3), run("failure", 2)]);
  assert.match(body, /Codex repair candidate only/);
  assert.match(body, /Do not edit the formal encrypted ledger/);
  assert.match(body, /https:\/\/github\.test\/runs\/3/);
  assert.doesNotMatch(body, /\$[0-9]/);
});

test("supervisor workflow has no source or ledger secrets", () => {
  const workflow = fs.readFileSync(new URL("../.github/workflows/fee-cloud-supervisor.yml", import.meta.url), "utf8");
  assert.match(workflow, /workflow_run:/);
  assert.match(workflow, /Fee console cloud producer/);
  assert.match(workflow, /actions: read/);
  assert.match(workflow, /issues: write/);
  assert.doesNotMatch(workflow, /FEE_DATA_KEY|FEE_ECON_GIST_ID|SHARESIGHT|id-token: write/);
});
