import assert from "node:assert/strict";
import { test } from "node:test";

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildHealth, HEALTH_SCHEMA, publishedEnvelopeErrors, validateHealth } from "./fee-data-health.mjs";

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

test("a New York day cannot be published as a close before the close or from prior-day accounts", () => {
  const candidate = {
    ...base(), checkedAt: "2026-09-17T04:54:54Z", targetDate: "2026-09-17",
    sourceDates: { schwab: "2026-09-16", webull: "2026-09-16", benchmark: null },
    outcome: "updated"
  };
  const now = new Date("2026-09-17T05:00:00Z");
  const reason = "health target precedes New York close or lacks same-day account sources";
  assert.ok(validateHealth(candidate, { now }).includes(reason));
  const afterClose = { ...candidate, checkedAt: "2026-09-17T20:30:00Z" };
  assert.ok(validateHealth(afterClose, { now: new Date("2026-09-17T20:31:00Z") }).includes(reason));
  const currentSources = { ...afterClose, sourceDates: {
    schwab: "2026-09-17", webull: "2026-09-17", benchmark: null
  } };
  assert.deepEqual(validateHealth(currentSources, { now: new Date("2026-09-17T20:31:00Z") }), []);
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
  const current = { ...base(), checkedAt: new Date().toISOString() };
  assert.deepEqual(buildHealth(current), current);
});

test("the published envelope must be exactly {data, enc, v} with canonical v3 ciphertext", () => {
  const good = { enc: true, v: 3, data: "A".repeat(44) };
  assert.deepEqual(publishedEnvelopeErrors(Buffer.from(JSON.stringify(good))), []);
  assert.deepEqual(publishedEnvelopeErrors(JSON.stringify({ v: 3, data: good.data, enc: true })), []);
  for (const value of [{ ...good, extra: 1 }, { enc: true, v: 3 }, { enc: true, data: good.data }, [good], null, "x", 3]) {
    assert.deepEqual(publishedEnvelopeErrors(JSON.stringify(value)), ["data envelope shape"], JSON.stringify(value));
  }
  assert.deepEqual(publishedEnvelopeErrors(`{"enc":true,"v":3,"data":"${good.data}","__proto__":{}}`), ["data envelope shape"]);
  assert.deepEqual(publishedEnvelopeErrors("{not json"), ["data envelope invalid"]);
  assert.deepEqual(publishedEnvelopeErrors(JSON.stringify({ ...good, enc: "true" })), ["data envelope version"]);
  assert.deepEqual(publishedEnvelopeErrors(JSON.stringify({ ...good, v: 4 })), ["data envelope version"]);
  for (const data of [42, "A".repeat(40 - 4), "A".repeat(43), "A".repeat(43) + "!", "AAB=".padStart(44, "A")]) {
    assert.deepEqual(publishedEnvelopeErrors(JSON.stringify({ ...good, data })), ["data envelope ciphertext"], String(data));
  }
});

test("validate refuses an extra outer member even when the health hash matches it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fee-health-envelope-"));
  try {
    const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "fee-data-health.mjs");
    const now = new Date();
    const ny = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" })
      .format(new Date(now.getTime() - 86_400_000));
    const check = envelope => {
      const bytes = Buffer.from(`${JSON.stringify(envelope)}\n`);
      fs.writeFileSync(path.join(dir, "data.json"), bytes);
      fs.writeFileSync(path.join(dir, "health.json"), JSON.stringify({ schema: HEALTH_SCHEMA, checkedAt: now.toISOString(), targetDate: ny,
        sourceDates: { schwab: ny, webull: ny, benchmark: ny }, outcome: "no-op",
        dataSha256: crypto.createHash("sha256").update(bytes).digest("hex"), errorCode: null }));
      return spawnSync(process.execPath, [cli, "validate", `--health=${path.join(dir, "health.json")}`, `--data=${path.join(dir, "data.json")}`], { encoding: "utf8" });
    };
    const good = { enc: true, v: 3, data: "A".repeat(44) };
    const ok = check(good);
    assert.equal(ok.status, 0, ok.stderr);
    const extra = check({ ...good, note: "plaintext" });
    assert.notEqual(extra.status, 0);
    assert.equal(extra.stderr.includes("plaintext"), false);
    for (const raw of RAW_DUPLICATE_ENVELOPES) {
      const bytes = Buffer.from(raw);
      fs.writeFileSync(path.join(dir, "data.json"), bytes);
      const health = JSON.parse(fs.readFileSync(path.join(dir, "health.json"), "utf8"));
      health.dataSha256 = crypto.createHash("sha256").update(bytes).digest("hex");
      fs.writeFileSync(path.join(dir, "health.json"), JSON.stringify(health));
      const r = spawnSync(process.execPath, [cli, "validate", `--health=${path.join(dir, "health.json")}`, `--data=${path.join(dir, "data.json")}`], { encoding: "utf8" });
      assert.notEqual(r.status, 0, raw);
      assert.equal(r.stderr.includes("SYNTHETIC_PLAINTEXT"), false);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("validate-fee-data and promote-fee-data inline checks refuse the same extra outer members", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const extract = (name, opener) => {
    const text = fs.readFileSync(path.join(root, ".github", "workflows", name), "utf8");
    const lines = text.split("\n"), start = lines.findIndex(line => line.includes(opener));
    assert.ok(start >= 0, name);
    const end = lines.findIndex((line, index) => index > start && line.trim() === "NODE");
    const body = lines.slice(start + 1, end);
    const indent = Math.min(...body.filter(line => line.trim()).map(line => line.match(/^ */)[0].length));
    return body.map(line => line.slice(indent)).join("\n");
  };
  const scripts = {
    validate: extract("validate-fee-data.yml", "node - <<'NODE'"),
    promote: extract("promote-fee-data.yml", "candidate-data.json\" <<'NODE'")
  };
  assert.match(scripts.validate, /exactly data, enc and v/);
  assert.match(scripts.promote, /exactly data, enc and v/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fee-workflow-envelope-"));
  try {
    fs.mkdirSync(path.join(dir, "scripts"));
    fs.copyFileSync(path.join(root, "scripts", "fee-legacy-policy.mjs"), path.join(dir, "scripts", "fee-legacy-policy.mjs"));
    const good = { enc: true, v: 3, data: "A".repeat(44) };
    for (const [envelope, ok] of [[good, true], [{ ...good, note: "x" }, false], [{ enc: true, v: 3 }, false],
      [{ ...good, v: 4 }, false], [[good], false],
      ...RAW_VALID_ENVELOPES.map(raw => [raw, true]), ...RAW_DUPLICATE_ENVELOPES.map(raw => [raw, false])]) {
      const file = path.join(dir, "data.json");
      fs.writeFileSync(file, typeof envelope === "string" ? envelope : JSON.stringify(envelope));
      for (const [name, script] of Object.entries(scripts)) {
        fs.writeFileSync(path.join(dir, `${name}.cjs`), script);
        const r = spawnSync(process.execPath, [path.join(dir, `${name}.cjs`), file], { cwd: dir, encoding: "utf8" });
        assert.equal(r.status === 0, ok, `${name} ${JSON.stringify(envelope)}`);
        assert.equal(r.stderr.includes("SYNTHETIC_PLAINTEXT"), false);
      }
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

const RAW_DUPLICATE_ENVELOPES = ["{\"data\":\"SYNTHETIC_PLAINTEXT\",\"enc\":true,\"v\":3,\"data\":\"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\"}", "{\"data\":\"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\",\"enc\":true,\"v\":3,\"data\":\"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\"}", "{\"enc\":true,\"v\":3,\"d\\u0061ta\":\"SYNTHETIC_PLAINTEXT\",\"data\":\"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\"}", "{\"\\u0064\\u0061\\u0074\\u0061\":\"SYNTHETIC_PLAINTEXT\",\"enc\":true,\"v\":3,\"data\":\"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\"}", "{\"enc\":false,\"enc\":true,\"v\":3,\"data\":\"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\"}", "{\"enc\":true,\"v\":4,\"v\":3,\"data\":\"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\"}", "{\"enc\":true,\"v\":3,\"data\":\"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\", \"data\" : \"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\"}"];
const RAW_VALID_ENVELOPES = ["{\"enc\":true,\"v\":3,\"data\":\"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\"}", "{\"data\":\"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\",\"v\":3,\"enc\":true}", "{\n  \"v\" : 3 ,\n\t\"enc\": true,\r\n \"data\":\"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\"\n}\n", "{\"\\u0065nc\":true,\"v\":3,\"data\":\"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\"}"];

test("duplicate root members are refused on the raw bytes, including escaped equivalent keys", () => {
  for (const raw of RAW_DUPLICATE_ENVELOPES) {
    assert.deepEqual(publishedEnvelopeErrors(Buffer.from(raw)), ["data envelope duplicate member"], raw);
    assert.equal(JSON.stringify(publishedEnvelopeErrors(Buffer.from(raw))).includes("SYNTHETIC_PLAINTEXT"), false);
  }
  for (const raw of RAW_VALID_ENVELOPES) assert.deepEqual(publishedEnvelopeErrors(Buffer.from(raw)), [], raw);
  // A string value that merely contains key-like text is not a member.
  assert.deepEqual(publishedEnvelopeErrors(Buffer.from('{"enc":true,"v":3,"data":"' + "A".repeat(44) + '","x":"\\"data\\":1"}')), ["data envelope shape"]);
  assert.deepEqual(publishedEnvelopeErrors(Buffer.from([0x7b, 0xff, 0x7d])), ["data envelope invalid"]);
});
