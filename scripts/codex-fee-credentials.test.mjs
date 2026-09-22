import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseManagerLink, readPrivateManagerLink } from "./codex-fee-credentials.mjs";

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

test("private-file setup only reads an owned, restricted regular file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fee-link-test-"));
  try {
    const link = `https://huanwujoy-crypto.github.io/fee-console/#tok=WRITE_SECRET&gid=${gist}&k=${key}`;
    const file = path.join(dir, "manager.txt");
    fs.writeFileSync(file, `${link}\n`, { mode: 0o600 });
    assert.equal(readPrivateManagerLink(file), `${link}\n`);
    fs.chmodSync(file, 0o644);
    assert.throws(() => readPrivateManagerLink(file), /MANAGER_LINK_FILE_UNSAFE/);
    fs.chmodSync(file, 0o600);
    const alias = path.join(dir, "alias.txt");
    fs.symlinkSync(file, alias);
    assert.throws(() => readPrivateManagerLink(alias), /MANAGER_LINK_FILE_UNSAFE/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
