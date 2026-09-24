import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { commitPrepared } from "./fee-cloud-commit.mjs";

const BASE = "a".repeat(40);

function files(t, outcome = "updated") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fee-cloud-commit-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dataFile = path.join(dir, "data.json"), healthFile = path.join(dir, "health.json");
  const data = Buffer.from(`${JSON.stringify({ enc: true, v: 3, data: "A".repeat(44) })}\n`);
  fs.writeFileSync(dataFile, data);
  fs.writeFileSync(healthFile, `${JSON.stringify({ targetDate: "2026-09-23", outcome,
    dataSha256: crypto.createHash("sha256").update(data).digest("hex") })}\n`);
  return { dataFile, healthFile };
}

test("publish uses one signed GraphQL commit and omits data on no-op", async t => {
  for (const outcome of ["updated", "no-op"]) {
    const input = files(t, outcome), seen = [];
    const fetchImpl = async (url, token, init) => {
      seen.push({ url, token, init });
      const payload = JSON.parse(init.body);
      if (payload.query.startsWith("query")) return { data: { viewer: { login: "huanwujoy-crypto" },
        repository: { id: "repo-id", ref: { target: { oid: BASE } } } } };
      if (payload.query.includes("CreateRefInput")) {
        const branch = payload.variables.input.name;
        return { data: { createRef: { ref: { name: branch, target: { oid: BASE } } } } };
      }
      const branch = payload.variables.input.branch.branchName;
      const additions = payload.variables.input.fileChanges.additions;
      assert.deepEqual(additions.map(x => x.path), outcome === "updated"
        ? ["data.json", "fee-data-health.json"] : ["fee-data-health.json"]);
      assert.equal(payload.variables.input.expectedHeadOid, BASE);
      return { data: { createCommitOnBranch: { commit: { oid: "b".repeat(40) }, ref: { name: branch } } } };
    };
    const result = await commitPrepared({ ...input, baseSha: BASE, token: "t".repeat(30), fetchImpl });
    assert.match(result.branch, /^codex\/fee-daily-20260923-[a-f0-9]{6}$/);
    assert.equal(result.oid, "b".repeat(40));
    assert.equal(seen.length, 3);
  }
});

test("wrong GitHub owner and mismatched health hash fail closed", async t => {
  const input = files(t);
  await assert.rejects(commitPrepared({ ...input, baseSha: BASE, token: "t".repeat(30),
    fetchImpl: async () => ({ data: { viewer: { login: "someone-else" } } }) }), /COMMIT_OWNER/);
  const receipt = JSON.parse(fs.readFileSync(input.healthFile));
  receipt.dataSha256 = "0".repeat(64);
  fs.writeFileSync(input.healthFile, JSON.stringify(receipt));
  await assert.rejects(commitPrepared({ ...input, baseSha: BASE, token: "t".repeat(30),
    fetchImpl: async () => ({ login: "huanwujoy-crypto" }) }), /COMMIT_FILES/);
});
