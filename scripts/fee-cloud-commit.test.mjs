import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { commitPrepared, request } from "./fee-cloud-commit.mjs";

const BASE = "a".repeat(40);

test('signing HTTP body deadline makes one request and never retries an uncertain mutation', async () => {
  let calls=0,signal;
  await assert.rejects(request('https://api.github.com/graphql','synthetic-token',{method:'POST',body:'{}'}, {
    timeoutMs:20,fetchImpl:async(url,init)=>{calls++;signal=init.signal;return {url,status:200,
      body:{getReader(){return {read:()=>new Promise(()=>{}),cancel(){},releaseLock(){}};}}};}
  }),/FEE_CLOUD_COMMIT_TIMEOUT/);
  assert.equal(calls,1);assert.equal(signal.aborted,true);
});

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

test("the outer envelope must be exactly {data, enc, v} before any network call", async t => {
  const good = { enc: true, v: 3, data: "A".repeat(44) };
  const cases = [
    { ...good, label: "plaintext" },
    { enc: true, v: 3 },
    { enc: true, data: good.data },
    { ...good, enc: "true" },
    { ...good, v: "3" },
    { ...good, data: 42 },
    { ...good, data: "not base64!".padEnd(44, "x") },
    { ...good, data: "A".repeat(43) },
    [good],
    null,
    "envelope"
  ];
  for (const envelope of cases) {
    const input = files(t);
    const bytes = Buffer.from(`${JSON.stringify(envelope)}\n`);
    fs.writeFileSync(input.dataFile, bytes);
    // A correct health hash over the rejected bytes is still refused.
    fs.writeFileSync(input.healthFile, `${JSON.stringify({ targetDate: "2026-09-23", outcome: "updated",
      dataSha256: crypto.createHash("sha256").update(bytes).digest("hex") })}\n`);
    let calls = 0;
    await assert.rejects(commitPrepared({ ...input, baseSha: BASE, token: "t".repeat(30),
      fetchImpl: async () => { calls++; return {}; } }), /FEE_CLOUD_COMMIT_FILES/, JSON.stringify(envelope));
    assert.equal(calls, 0, JSON.stringify(envelope));
  }
  const proto = files(t);
  const protoBytes = Buffer.from(`{"enc":true,"v":3,"data":"${good.data}","__proto__":{}}\n`);
  fs.writeFileSync(proto.dataFile, protoBytes);
  fs.writeFileSync(proto.healthFile, JSON.stringify({ targetDate: "2026-09-23", outcome: "no-op",
    dataSha256: crypto.createHash("sha256").update(protoBytes).digest("hex") }));
  let calls = 0;
  await assert.rejects(commitPrepared({ ...proto, baseSha: BASE, token: "t".repeat(30),
    fetchImpl: async () => { calls++; return {}; } }), /FEE_CLOUD_COMMIT_FILES/);
  assert.equal(calls, 0);
});

const RAW_DUPLICATE_ENVELOPES = ["{\"data\":\"SYNTHETIC_PLAINTEXT\",\"enc\":true,\"v\":3,\"data\":\"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\"}", "{\"data\":\"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\",\"enc\":true,\"v\":3,\"data\":\"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\"}", "{\"enc\":true,\"v\":3,\"d\\u0061ta\":\"SYNTHETIC_PLAINTEXT\",\"data\":\"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\"}", "{\"\\u0064\\u0061\\u0074\\u0061\":\"SYNTHETIC_PLAINTEXT\",\"enc\":true,\"v\":3,\"data\":\"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\"}", "{\"enc\":false,\"enc\":true,\"v\":3,\"data\":\"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\"}", "{\"enc\":true,\"v\":4,\"v\":3,\"data\":\"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\"}", "{\"enc\":true,\"v\":3,\"data\":\"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\", \"data\" : \"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\"}"];
const RAW_VALID_ENVELOPES = ["{\"enc\":true,\"v\":3,\"data\":\"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\"}", "{\"data\":\"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\",\"v\":3,\"enc\":true}", "{\n  \"v\" : 3 ,\n\t\"enc\": true,\r\n \"data\":\"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\"\n}\n", "{\"\\u0065nc\":true,\"v\":3,\"data\":\"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\"}"];

test("duplicate root members, including escaped equivalent keys, are refused before any network call", async t => {
  for (const raw of RAW_DUPLICATE_ENVELOPES) {
    const input = files(t);
    const bytes = Buffer.from(raw);
    fs.writeFileSync(input.dataFile, bytes);
    fs.writeFileSync(input.healthFile, JSON.stringify({ targetDate: "2026-09-23", outcome: "updated",
      dataSha256: crypto.createHash("sha256").update(bytes).digest("hex") }));
    let calls = 0;
    const error = await commitPrepared({ ...input, baseSha: BASE, token: "t".repeat(30),
      fetchImpl: async () => { calls++; return {}; } }).then(() => null, e => e);
    assert.match(String(error?.message), /^FEE_CLOUD_COMMIT_FILES$/, raw);
    assert.equal(calls, 0, raw);
  }
});

test("valid envelopes with any key order, spacing or escaped key spelling still reach the publication path", async t => {
  for (const raw of RAW_VALID_ENVELOPES) {
    const input = files(t);
    const bytes = Buffer.from(raw);
    fs.writeFileSync(input.dataFile, bytes);
    fs.writeFileSync(input.healthFile, JSON.stringify({ targetDate: "2026-09-23", outcome: "updated",
      dataSha256: crypto.createHash("sha256").update(bytes).digest("hex") }));
    let calls = 0;
    await assert.rejects(commitPrepared({ ...input, baseSha: BASE, token: "t".repeat(30),
      fetchImpl: async () => { calls++; return { data: { viewer: { login: "someone-else" } } }; } }), /COMMIT_OWNER/, raw);
    assert.equal(calls, 1, raw);
  }
});
