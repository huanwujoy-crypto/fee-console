import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  classifyEdition,
  evaluateFreshness,
  expectedEditionAt,
  gitBlobSha,
  probePublication,
  runWatcher,
  slotStartEpoch
} from "./xuan-ib-publish-health.mjs";

const sha = character => character.repeat(40);
const html = (date, label) => `<!doctype html><title>XUAN-投资管理</title><!-- xuan-ib-handover:v1 --><span class="date">${date} 周四 · ${label}</span>`;

test("computes a Git blob SHA over the exact published bytes", () => {
  assert.equal(gitBlobSha("test\n"), "9daeafb9864cf43055ae93beb0afd6c7d144bfa4");
});

test("classifies AM, PM, and ad-hoc pages with ad-hoc precedence", () => {
  assert.equal(classifyEdition("2026-08-27 · 早间清算版"), "am");
  assert.equal(classifyEdition("2026-08-27 · 睡前版"), "pm");
  assert.equal(classifyEdition("2026-08-27 · 21:00 HKT 定时正式版"), "pm");
  assert.equal(classifyEdition("2026-08-27 · 计划外加跑（常规 21:00）"), "adhoc");
  assert.equal(classifyEdition("2026-08-27 · 市场简报"), "unknown");
});

test("selects weekday HKT SLA slots and skips weekends", () => {
  assert.equal(expectedEditionAt(new Date("2026-08-27T00:29:00Z")).expectedEdition, null);
  assert.equal(expectedEditionAt(new Date("2026-08-27T00:30:00Z")).expectedEdition, "am");
  assert.equal(expectedEditionAt(new Date("2026-08-27T14:15:00Z")).expectedEdition, "pm");
  assert.equal(expectedEditionAt(new Date("2026-08-29T14:15:00Z")).reason, "weekend");
});

test("accepts only a matching scheduled page from main and Pages", () => {
  const bytes = Buffer.from(html("2026-08-27", "早间清算版"));
  const blob = gitBlobSha(bytes);
  const meta = {
    schemaVersion: 1,
    sourceSha: sha("a"),
    sourceCommitEpoch: slotStartEpoch("2026-08-27", "am") + 60,
    dataDate: "2026-08-27",
    htmlBlob: blob
  };
  const result = evaluateFreshness({
    indexHtml: "fetch('latest.html')",
    onlineHtml: bytes,
    onlineMeta: meta,
    mainHtml: bytes,
    mainMeta: meta,
    expectedEdition: "am",
    expectedDate: "2026-08-27",
    publicationHistory: [{
      commit: sha("c"), valid: true, dataDate: "2026-08-27", edition: "am",
      sourceSha: sha("a"), sourceCommitEpoch: meta.sourceCommitEpoch
    }],
    now: new Date("2026-08-27T01:00:00Z")
  });
  assert.equal(result.ok, true);
});

test("fails closed for stale bytes, the wrong slot, and ad-hoc pages", () => {
  const mainBytes = Buffer.from(html("2026-08-27", "早间清算版"));
  const onlineBytes = Buffer.from(html("2026-08-27", "计划外加跑（常规 21:00）"));
  const mainBlob = gitBlobSha(mainBytes);
  const onlineBlob = gitBlobSha(onlineBytes);
  const mainMeta = {schemaVersion: 1, sourceSha: sha("a"), sourceCommitEpoch: slotStartEpoch("2026-08-27", "am") + 60, dataDate: "2026-08-27", htmlBlob: mainBlob};
  const onlineMeta = {...mainMeta, htmlBlob: onlineBlob};
  const result = evaluateFreshness({
    indexHtml: "latest.html",
    onlineHtml: onlineBytes,
    onlineMeta,
    mainHtml: mainBytes,
    mainMeta,
    expectedEdition: "pm",
    expectedDate: "2026-08-27",
    now: new Date("2026-08-27T14:20:00Z")
  });
  assert.equal(result.ok, false);
  assert.match(result.issues.join("\n"), /differs from main/);
  assert.match(result.issues.join("\n"), /history does not prove the scheduled PM/);
});

test("a later ad-hoc page does not hide or impersonate a scheduled publication", () => {
  const bytes = Buffer.from(html("2026-08-27", "计划外加跑（常规 21:00）"));
  const blob = gitBlobSha(bytes);
  const meta = {schemaVersion: 1, sourceSha: sha("a"), sourceCommitEpoch: slotStartEpoch("2026-08-27", "pm") + 600, dataDate: "2026-08-27", htmlBlob: blob};
  const base = {
    indexHtml: "latest.html", onlineHtml: bytes, onlineMeta: meta, mainHtml: bytes, mainMeta: meta,
    expectedEdition: "pm", expectedDate: "2026-08-27", now: new Date("2026-08-27T15:00:00Z")
  };
  const withoutPm = evaluateFreshness({...base, publicationHistory: [{...meta, commit: sha("b"), valid: true, edition: "adhoc"}]});
  assert.equal(withoutPm.ok, false);
  const withPm = evaluateFreshness({...base, publicationHistory: [
    {...meta, commit: sha("b"), valid: true, edition: "adhoc"},
    {...meta, commit: sha("c"), valid: true, edition: "pm", sourceCommitEpoch: slotStartEpoch("2026-08-27", "pm") + 60}
  ]});
  assert.equal(withPm.ok, true);
  assert.equal(withPm.actualEdition, "adhoc");
  assert.equal(withPm.scheduledEvidence.length, 1);
});

const response = body => ({
  ok: true,
  status: 200,
  arrayBuffer: async () => Buffer.from(body)
});

test("the online watcher compares all three fixed-page resources", async () => {
  const bytes = Buffer.from(html("2026-08-27", "睡前版"));
  const blob = gitBlobSha(bytes);
  const meta = {schemaVersion: 1, sourceSha: sha("b"), sourceCommitEpoch: slotStartEpoch("2026-08-27", "pm") + 60, dataDate: "2026-08-27", htmlBlob: blob};
  const fetchFn = async url => {
    if (url.pathname.endsWith("index.html")) return response("latest.html");
    if (url.pathname.endsWith("latest.html")) return response(bytes);
    return response(JSON.stringify(meta));
  };
  const result = await runWatcher({
    baseUrl: "https://example.invalid/xuan-ib/",
    mainHtml: bytes,
    mainMeta: meta,
    publicationHistory: [{...meta, commit: sha("d"), valid: true, edition: "pm"}],
    expectedEdition: "pm",
    now: new Date("2026-08-27T14:20:00Z"),
    fetchFn
  });
  assert.equal(result.ok, true);
});

test("the non-gating Pages probe retries stale data and reports timeout as data", async () => {
  const bytes = Buffer.from(html("2026-08-27", "睡前版"));
  const blob = gitBlobSha(bytes);
  let reads = 0;
  const fetchFn = async url => {
    if (url.pathname.endsWith("latest.html")) return response(bytes);
    reads += 1;
    return response(JSON.stringify({sourceSha: reads < 2 ? sha("a") : sha("c"), htmlBlob: blob, dataDate: "2026-08-27"}));
  };
  const recovered = await probePublication({
    baseUrl: "https://example.invalid/xuan-ib/",
    expectedSha: sha("c"), expectedBlob: blob, expectedDate: "2026-08-27",
    attempts: 3, intervalMs: 0, fetchFn, waitFn: async () => {}
  });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.attempts, 2);

  const timedOut = await probePublication({
    baseUrl: "https://example.invalid/xuan-ib/",
    expectedSha: sha("d"), expectedBlob: blob, expectedDate: "2026-08-27",
    attempts: 2, intervalMs: 0, fetchFn, waitFn: async () => {}
  });
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.attempts, 2);
});

test("workflows keep the HKT SLA, read-only watcher, and post-push non-gating probe", () => {
  const watcher = fs.readFileSync(".github/workflows/watch-xuan-ib-freshness.yml", "utf8");
  assert.match(watcher, /cron: '\*\/30 \* \* \* 1-5'/);
  assert.match(watcher, /fetch-depth: 0/);
  assert.match(watcher, /permissions:\n  contents: read/);
  assert.doesNotMatch(watcher, /contents: write|secrets\./);

  const promotion = fs.readFileSync(".github/workflows/promote-xuan-ib-handover.yml", "utf8");
  assert.ok(promotion.indexOf("git push origin HEAD:refs/heads/main") < promotion.indexOf("Observe the Pages rollout"));
  assert.match(promotion, /--attempts 20/);
  assert.match(promotion, /--interval-ms 15000/);
  assert.match(promotion, /Pages rollout delay does not change the promotion result/);
});
