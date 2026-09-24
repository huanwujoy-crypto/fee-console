#!/usr/bin/env node

// Publish one prepared encrypted candidate through GitHub's signed
// createCommitOnBranch mutation. The credential is separately scoped to this
// repository; no Git, Gist, or manager token fallback exists.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OWNER = "huanwujoy-crypto";
const REPO = `${OWNER}/fee-console`;
const fail = code => { throw new Error(`FEE_CLOUD_COMMIT_${code}`); };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SHA_RE = /^[a-f0-9]{40}$/;
const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

function parse(argv) {
  const result = {};
  for (const raw of argv) {
    const match = /^--(data|health|base-sha)=([\s\S]+)$/.exec(raw);
    if (!match || Object.hasOwn(result, match[1])) fail("ARGUMENT");
    result[match[1]] = match[2];
  }
  if (!result.data || !result.health || !SHA_RE.test(result["base-sha"] || "")) fail("ARGUMENT");
  return result;
}

async function request(url, token, init = {}) {
  let response;
  try { response = await fetch(url, { ...init, redirect: "error", headers: { Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-GitHub-Api-Version": "2022-11-28",
    ...(init.headers || {}) } }); } catch { fail("NETWORK"); }
  if (!response || response.status !== 200 || response.url !== url) fail("HTTP");
  try { return await response.json(); } catch { fail("RESPONSE"); }
}

export async function commitPrepared({ dataFile, healthFile, baseSha, token = process.env.FEE_CLOUD_GITHUB_TOKEN,
  fetchImpl = request } = {}) {
  if (typeof token !== "string" || token.length < 20 || /[\r\n\0]/.test(token)) fail("TOKEN");
  if (!SHA_RE.test(baseSha || "")) fail("BASE");
  const data = fs.readFileSync(dataFile), health = fs.readFileSync(healthFile);
  let receipt, envelope;
  try { receipt = JSON.parse(health); envelope = JSON.parse(data); } catch { fail("FILES"); }
  if (!DATE_RE.test(receipt.targetDate || "") || !["updated", "no-op"].includes(receipt.outcome)
      || receipt.dataSha256 !== sha256(data) || envelope.enc !== true || envelope.v !== 3) fail("FILES");
  const graph = "https://api.github.com/graphql";
  const repository = await fetchImpl(graph, token, { method: "POST", body: JSON.stringify({
    query: "query { viewer { login } repository(owner: \"huanwujoy-crypto\", name: \"fee-console\") { id ref(qualifiedName: \"refs/heads/main\") { target { oid } } } }",
  }) });
  if (repository?.data?.viewer?.login !== OWNER) fail("OWNER");
  const repositoryId = repository?.data?.repository?.id;
  const remoteMain = repository?.data?.repository?.ref?.target?.oid;
  if (typeof repositoryId !== "string" || !repositoryId || remoteMain !== baseSha) fail("BASE_CHANGED");
  const branch = `codex/fee-daily-${receipt.targetDate.replaceAll("-", "")}-${crypto.randomBytes(3).toString("hex")}`;
  const created = await fetchImpl(graph, token, { method: "POST", body: JSON.stringify({
    query: "mutation($input: CreateRefInput!) { createRef(input: $input) { ref { name target { oid } } } }",
    variables: { input: { repositoryId, name: `refs/heads/${branch}`, oid: baseSha } },
  }) });
  const createdRef = created?.data?.createRef?.ref;
  if (createdRef?.name !== branch && createdRef?.name !== `refs/heads/${branch}`) fail("CREATE_REF");
  if (createdRef?.target?.oid !== baseSha) fail("CREATE_REF");
  const additions = [{ path: "fee-data-health.json", contents: health.toString("base64") }];
  if (receipt.outcome === "updated") additions.unshift({ path: "data.json", contents: data.toString("base64") });
  const payload = { query: "mutation($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { oid url } ref { name } } }",
    variables: { input: { branch: { repositoryNameWithOwner: REPO, branchName: branch }, expectedHeadOid: baseSha,
      message: { headline: `daily ${receipt.targetDate}` }, fileChanges: { additions } } } };
  const result = await fetchImpl(graph, token,
    { method: "POST", body: JSON.stringify(payload) });
  const oid = result?.data?.createCommitOnBranch?.commit?.oid;
  const ref = result?.data?.createCommitOnBranch?.ref?.name;
  if (!SHA_RE.test(oid || "") || ![branch, `refs/heads/${branch}`].includes(ref)) fail("GRAPHQL");
  return { branch, oid };
}

async function main() {
  const input = parse(process.argv.slice(2));
  const result = await commitPrepared({ dataFile: path.resolve(input.data), healthFile: path.resolve(input.health),
    baseSha: input["base-sha"] });
  const output = String(process.env.GITHUB_OUTPUT || "");
  if (output) fs.appendFileSync(output, `branch=${result.branch}\nsha=${result.oid}\n`, { encoding: "utf8" });
  console.log(`candidate ${result.oid}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch(error => {
    console.error(/^FEE_CLOUD_COMMIT_[A-Z0-9_]+$/.test(String(error?.message)) ? error.message : "FEE_CLOUD_COMMIT_FAILED");
    process.exitCode = 1;
  });
}
