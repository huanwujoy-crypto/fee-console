import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { parseManagerLink } from "./codex-fee-credentials.mjs";

const key = crypto.randomBytes(32).toString("base64url");
const gist = "a".repeat(32);

test("manager link returns only the read locator and encryption key", () => {
  const input = `https://huanwujoy-crypto.github.io/fee-console/#tok=WRITE_SECRET&gid=${gist}&k=${key}&who=Example`;
  assert.deepEqual(parseManagerLink(input), { gist, key });
  assert.equal(Object.values(parseManagerLink(input)).includes("WRITE_SECRET"), false);
});

test("untrusted destinations and duplicate or malformed link fields fail closed", () => {
  for (const input of [
    `https://example.com/fee-console/#tok=x&gid=${gist}&k=${key}`,
    `http://huanwujoy-crypto.github.io/fee-console/#tok=x&gid=${gist}&k=${key}`,
    `https://huanwujoy-crypto.github.io/fee-console/#gid=${gist}&k=${key}`,
    `https://huanwujoy-crypto.github.io/fee-console/#tok=x&gid=${gist}&gid=${gist}&k=${key}`,
    `https://huanwujoy-crypto.github.io/fee-console/#tok=x&gid=${gist}&k=bad`,
  ]) assert.throws(() => parseManagerLink(input), /MANAGER_LINK_INVALID/);
});
