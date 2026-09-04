import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {execFileSync} from "node:child_process";
import {
  classifyEdition,
  evaluateFreshness,
  expectedEditionAt,
  gitBlobSha,
  probePublication,
  runWatcher,
  runWatcherWithRetries,
  slotDueEpoch,
  slotStartEpoch
} from "./xuan-ib-publish-health.mjs";
import {AM_WATCH_CRON, PM_RUN_TARGET_MS, PM_SCHEDULE_CUTOVER_HKT_DATE, PM_WATCH_CRONS, hktContext, scheduledWatchEdition, scheduledWatchEnabled} from "./xuan-ib-report-schedule.mjs";

const sha = character => character.repeat(40);
const html = (date, label) => `<!doctype html><title>XUAN-投资管理</title><!-- xuan-ib-handover:v1 --><span class="date">${date} 周四 · ${label}</span>`;
const loaderBytes = Buffer.from("<!doctype html><script>fetch('latest.html')</script>");

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

test("selects AM and PM across the week without retroactively changing historical deadlines", () => {
  const cases = [
    ["2026-08-27T00:34:00Z", "2026-08-26", "pm"], // Thu 08:34 HKT
    ["2026-08-27T00:35:00Z", "2026-08-27", "am"], // Thu 08:35 HKT
    ["2026-08-27T13:24:59Z", "2026-08-27", "am"],
    ["2026-08-27T13:25:00Z", "2026-08-27", "pm"], // Historical Thu 21:25 HKT
    ["2026-08-29T00:34:00Z", "2026-08-28", "pm"], // Sat 08:34 HKT
    ["2026-08-29T00:35:00Z", "2026-08-29", "am"], // Sat 08:35 HKT
    ["2026-08-30T12:00:00Z", "2026-08-29", "am"], // Sun 20:00 HKT
    ["2026-08-28T16:00:00Z", "2026-08-28", "pm"], // Sat midnight HKT retains Friday PM.
    ["2026-08-31T13:24:59Z", "2026-08-29", "am"],
    ["2026-08-31T13:25:00Z", "2026-08-31", "pm"],
    ["2026-09-04T00:34:59Z", "2026-09-03", "pm"],
    ["2026-09-04T00:35:00Z", "2026-09-04", "am"],
    ["2026-09-04T13:25:00Z", "2026-09-04", "am"], // Old deadline must not require new PM.
    ["2026-09-04T13:44:59Z", "2026-09-04", "am"],
    ["2026-09-04T13:45:00Z", "2026-09-04", "pm"],
    ["2026-09-04T16:00:00Z", "2026-09-04", "pm"],
    ["2026-09-05T00:35:00Z", "2026-09-05", "am"],
    ["2026-09-07T13:44:59Z", "2026-09-05", "am"],
    ["2026-09-07T13:45:00Z", "2026-09-07", "pm"]
  ];
  for (const [now, expectedDate, expectedEdition] of cases) {
    const result = expectedEditionAt(new Date(now));
    assert.equal(result.expectedDate, expectedDate, now);
    assert.equal(result.expectedEdition, expectedEdition, now);
    assert.equal(result.reason, "latest-due-slot", now);
  }
  assert.equal(PM_SCHEDULE_CUTOVER_HKT_DATE, "2026-09-04");
  assert.equal(slotStartEpoch("2026-09-03", "pm"), Date.parse("2026-09-03T12:55:00Z") / 1000);
  assert.equal(slotDueEpoch("2026-09-03", "pm"), Date.parse("2026-09-03T13:25:00Z") / 1000);
  assert.equal(slotStartEpoch("2026-09-04", "pm"), Date.parse("2026-09-04T13:35:00Z") / 1000);
  assert.equal(slotDueEpoch("2026-09-04", "pm"), Date.parse("2026-09-04T13:45:00Z") / 1000);
});

test("named New York timezone resolves both DST transitions while AM remains Hong Kong time", () => {
  for (const [date, utcHour] of [
    ["2026-10-30", 13], ["2026-11-02", 14],
    ["2027-03-12", 14], ["2027-03-15", 13],
    ["2027-11-05", 13], ["2027-11-08", 14],
    ["2028-03-10", 14], ["2028-03-13", 13]
  ]) {
    const start = slotStartEpoch(date, "pm");
    assert.equal(start, Date.parse(`${date}T${utcHour}:35:00Z`) / 1000, date);
    assert.equal(hktContext(new Date(start * 1000)).minuteOfDay, (utcHour + 8) * 60 + 35);
    assert.equal(slotDueEpoch(date, "pm") - start, PM_RUN_TARGET_MS / 1000);
    assert.equal(slotStartEpoch(date, "am"), Date.parse(`${date}T00:00:00Z`) / 1000);
    assert.equal(slotDueEpoch(date, "am"), Date.parse(`${date}T00:35:00Z`) / 1000);
  }
  assert.equal(expectedEditionAt(new Date("2026-11-02T13:45:00Z")).expectedDate, "2026-10-31");
  assert.equal(expectedEditionAt(new Date("2026-11-02T14:44:59Z")).expectedEdition, "am");
  assert.equal(expectedEditionAt(new Date("2026-11-02T14:45:00Z")).expectedEdition, "pm");
});

test("holidays retain the required short PM report and early closes do not move the opening slot", () => {
  for (const [date, utcHour] of [["2026-09-07", 13], ["2026-11-27", 14], ["2026-12-24", 14], ["2026-12-25", 14]]) {
    assert.equal(slotStartEpoch(date, "pm"), Date.parse(`${date}T${utcHour}:35:00Z`) / 1000);
    const due = expectedEditionAt(new Date(`${date}T${utcHour}:45:00Z`));
    assert.equal(due.expectedDate, date);
    assert.equal(due.expectedEdition, "pm");
  }
});

test("UTC watcher candidates select exactly one New York seasonal slot, including delayed jobs", () => {
  for (const [iso, active] of [["2026-03-06T15:02:00Z", 1], ["2026-03-09T14:12:00Z", 0], ["2026-10-30T14:05:00Z", 0], ["2026-11-02T15:03:00Z", 1]]) {
    assert.deepEqual(PM_WATCH_CRONS.map(c => scheduledWatchEnabled(c, new Date(iso))), [active === 0, active === 1]);
    assert.equal(scheduledWatchEnabled(AM_WATCH_CRON, new Date(iso)), true);
    assert.equal(scheduledWatchEnabled("", new Date(iso)), true);
  }
  assert.throws(() => scheduledWatchEnabled("25 13 * * 1-5"), /unrecognized/);
  assert.equal(scheduledWatchEdition(AM_WATCH_CRON), "am");
  for (const cron of PM_WATCH_CRONS) assert.equal(scheduledWatchEdition(cron), "pm");
  assert.equal(scheduledWatchEdition(""), null);
  assert.throws(() => scheduledWatchEdition("old-cron"), /unrecognized/);
});

test("shared browser schedule rejects invalid inputs instead of silently guessing a slot", () => {
  for (const date of ["2026-02-30", "2026-9-1", "garbage", null]) assert.throws(() => slotStartEpoch(date, "pm"), /invalid report date/);
  assert.throws(() => slotStartEpoch("2026-09-04", "adhoc"), /unsupported edition/);
  assert.throws(() => expectedEditionAt(new Date("invalid")), /invalid schedule instant/);
  assert.throws(() => expectedEditionAt(new Date(), "adhoc"), /unsupported edition/);
  const source = fs.readFileSync("scripts/xuan-ib-report-schedule.mjs", "utf8");
  assert.doesNotMatch(source, /(?:^|\n)\s*import\s|node:|\b(?:process|document|window|fetch|Buffer)\s*[.(]/);
});

test("inactive seasonal CLI watcher exits before file or website reads", () => {
  const inactive = PM_WATCH_CRONS.find(expression => !scheduledWatchEnabled(expression));
  const result = JSON.parse(execFileSync(process.execPath, [
    "scripts/xuan-ib-publish-health.mjs", "watch", "--base-url", "https://example.invalid/",
    "--main-index", "/synthetic-nonexistent-index", "--main-html", "/synthetic-nonexistent-html",
    "--main-meta", "/synthetic-nonexistent-meta", "--schedule", inactive
  ], {encoding: "utf8"}));
  assert.deepEqual(result, {ok: true, skipped: true, reason: "inactive-seasonal-watch-slot"});
});

test("a pre-opening old-time PM commit cannot prove the new PM run even with matching bytes", () => {
  const bytes = Buffer.from(html("2026-09-04", "睡前版"));
  const meta = {schemaVersion: 1, sourceSha: sha("a"), sourceCommitEpoch: Date.parse("2026-09-04T12:56:00Z") / 1000, dataDate: "2026-09-04", htmlBlob: gitBlobSha(bytes)};
  const base = {indexHtml: loaderBytes, mainIndexHtml: loaderBytes, onlineHtml: bytes, mainHtml: bytes,
    onlineMeta: meta, mainMeta: meta, expectedDate: meta.dataDate, expectedEdition: "pm", now: new Date("2026-09-04T13:50:00Z")};
  assert.equal(evaluateFreshness({...base, publicationHistory: [{...meta, commit: sha("b"), valid: true, edition: "pm"}]}).ok, false);
  const current = {...meta, sourceCommitEpoch: slotStartEpoch(meta.dataDate, "pm") + 60};
  assert.equal(evaluateFreshness({...base, onlineMeta: current, mainMeta: current, publicationHistory: [{...current, commit: sha("b"), valid: true, edition: "pm"}]}).ok, true);
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
    indexHtml: loaderBytes,
    mainIndexHtml: loaderBytes,
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
    indexHtml: loaderBytes,
    mainIndexHtml: loaderBytes,
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
    indexHtml: loaderBytes, mainIndexHtml: loaderBytes,
    onlineHtml: bytes, onlineMeta: meta, mainHtml: bytes, mainMeta: meta,
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

test("rejects an unlabeled or ambiguous fixed page even when scheduled history exists", () => {
  for (const label of ["市场简报", "早间与晚间摘要"]) {
    const bytes = Buffer.from(html("2026-08-27", label));
    const meta = {
      schemaVersion: 1,
      sourceSha: sha("a"),
      sourceCommitEpoch: slotStartEpoch("2026-08-27", "pm") + 600,
      dataDate: "2026-08-27",
      htmlBlob: gitBlobSha(bytes)
    };
    const result = evaluateFreshness({
      indexHtml: loaderBytes,
      mainIndexHtml: loaderBytes,
      onlineHtml: bytes,
      onlineMeta: meta,
      mainHtml: bytes,
      mainMeta: meta,
      expectedEdition: "pm",
      expectedDate: "2026-08-27",
      publicationHistory: [{
        ...meta,
        commit: sha("c"),
        valid: true,
        edition: "pm",
        sourceCommitEpoch: slotStartEpoch("2026-08-27", "pm") + 60
      }],
      now: new Date("2026-08-27T15:00:00Z")
    });
    assert.equal(result.ok, false, label);
    assert.match(result.issues.join("\n"), /explicit AM, PM, or ad-hoc label/, label);
  }
});

const response = body => ({
  ok: true,
  status: 200,
  arrayBuffer: async () => Buffer.from(body)
});

test("a delayed scheduled watcher cannot use the next edition to hide its own missing report", async () => {
  for (const [scheduleExpression, date, label, edition, now, expectedDate, expectedEdition] of [
    [PM_WATCH_CRONS[0], "2026-09-05", "早间版", "am", "2026-09-05T00:40:00Z", "2026-09-04", "pm"],
    [AM_WATCH_CRON, "2026-09-04", "睡前版", "pm", "2026-09-04T13:50:00Z", "2026-09-04", "am"]
  ]) {
    const bytes = Buffer.from(html(date, label));
    const meta = {schemaVersion: 1, sourceSha: sha("b"), sourceCommitEpoch: slotStartEpoch(date, edition) + 60, dataDate: date, htmlBlob: gitBlobSha(bytes)};
    const fetchFn = async url => response(url.pathname.endsWith("index.html") ? loaderBytes : url.pathname.endsWith("latest.html") ? bytes : JSON.stringify(meta));
    const result = await runWatcher({baseUrl: "https://example.invalid/xuan-ib/", mainIndexHtml: loaderBytes,
      mainHtml: bytes, mainMeta: meta, publicationHistory: [{...meta, commit: sha("d"), valid: true, edition}],
      scheduleExpression, now: new Date(now), fetchFn});
    assert.equal(result.ok, false);
    assert.equal(result.expectedDate, expectedDate);
    assert.equal(result.expectedEdition, expectedEdition);
  }
});

test("inactive seasonal watcher makes zero HTTP requests", async () => {
  const result = await runWatcher({scheduleExpression: PM_WATCH_CRONS[1], now: new Date("2026-09-04T14:50:00Z"),
    fetchFn: async () => { throw new Error("inactive watcher must not fetch"); }});
  assert.deepEqual(result, {ok: true, skipped: true, reason: "inactive-seasonal-watch-slot"});
});

test("the online watcher compares all three fixed-page resources", async () => {
  const bytes = Buffer.from(html("2026-08-27", "睡前版"));
  const blob = gitBlobSha(bytes);
  const meta = {schemaVersion: 1, sourceSha: sha("b"), sourceCommitEpoch: slotStartEpoch("2026-08-27", "pm") + 60, dataDate: "2026-08-27", htmlBlob: blob};
  const fetchFn = async url => {
    if (url.pathname.endsWith("index.html")) return response(loaderBytes);
    if (url.pathname.endsWith("latest.html")) return response(bytes);
    return response(JSON.stringify(meta));
  };
  const result = await runWatcher({
    baseUrl: "https://example.invalid/xuan-ib/",
    mainIndexHtml: loaderBytes,
    mainHtml: bytes,
    mainMeta: meta,
    publicationHistory: [{...meta, commit: sha("d"), valid: true, edition: "pm"}],
    expectedEdition: "pm",
    now: new Date("2026-08-27T14:20:00Z"),
    fetchFn
  });
  assert.equal(result.ok, true);
});

test("Saturday before the AM deadline still audits the prior Friday PM publication", async () => {
  const bytes = Buffer.from(html("2026-08-28", "睡前版"));
  const blob = gitBlobSha(bytes);
  const meta = {schemaVersion: 1, sourceSha: sha("b"), sourceCommitEpoch: slotStartEpoch("2026-08-28", "pm") + 60, dataDate: "2026-08-28", htmlBlob: blob};
  const fetchFn = async url => {
    if (url.pathname.endsWith("index.html")) return response(loaderBytes);
    if (url.pathname.endsWith("latest.html")) return response(bytes);
    return response(JSON.stringify(meta));
  };
  const result = await runWatcher({
    baseUrl: "https://example.invalid/xuan-ib/",
    mainIndexHtml: loaderBytes,
    mainHtml: bytes,
    mainMeta: meta,
    publicationHistory: [{...meta, commit: sha("d"), valid: true, edition: "pm"}],
    expectedEdition: "auto",
    now: new Date("2026-08-28T23:35:00Z"),
    fetchFn
  });
  assert.equal(result.ok, true);
  assert.equal(result.expectedDate, "2026-08-28");
  assert.equal(result.expectedEdition, "pm");
});

test("Saturday explicit PM mode also audits Friday instead of requiring a Saturday edition", async () => {
  const bytes = Buffer.from(html("2026-08-28", "睡前版"));
  const blob = gitBlobSha(bytes);
  const meta = {schemaVersion: 1, sourceSha: sha("b"), sourceCommitEpoch: slotStartEpoch("2026-08-28", "pm") + 60, dataDate: "2026-08-28", htmlBlob: blob};
  const fetchFn = async url => {
    if (url.pathname.endsWith("index.html")) return response(loaderBytes);
    if (url.pathname.endsWith("latest.html")) return response(bytes);
    return response(JSON.stringify(meta));
  };
  const result = await runWatcher({
    baseUrl: "https://example.invalid/xuan-ib/",
    mainIndexHtml: loaderBytes,
    mainHtml: bytes,
    mainMeta: meta,
    publicationHistory: [{...meta, commit: sha("d"), valid: true, edition: "pm"}],
    expectedEdition: "pm",
    now: new Date("2026-08-28T23:35:00Z"),
    fetchFn
  });
  assert.equal(result.ok, true);
  assert.equal(result.expectedDate, "2026-08-28");
  assert.equal(result.expectedEdition, "pm");
});

test("Saturday at the AM deadline requires the new Saturday morning report", async () => {
  const bytes = Buffer.from(html("2026-08-29", "早间版"));
  const blob = gitBlobSha(bytes);
  const meta = {schemaVersion: 1, sourceSha: sha("b"), sourceCommitEpoch: slotStartEpoch("2026-08-29", "am") + 60, dataDate: "2026-08-29", htmlBlob: blob};
  const fetchFn = async url => {
    if (url.pathname.endsWith("index.html")) return response(loaderBytes);
    if (url.pathname.endsWith("latest.html")) return response(bytes);
    return response(JSON.stringify(meta));
  };
  const result = await runWatcher({
    baseUrl: "https://example.invalid/xuan-ib/",
    mainIndexHtml: loaderBytes,
    mainHtml: bytes,
    mainMeta: meta,
    publicationHistory: [{...meta, commit: sha("d"), valid: true, edition: "am"}],
    expectedEdition: "auto",
    now: new Date("2026-08-29T00:35:00Z"),
    fetchFn
  });
  assert.equal(result.ok, true);
  assert.equal(result.expectedDate, "2026-08-29");
  assert.equal(result.expectedEdition, "am");
});

test("Saturday auto mode fails when Friday PM was missed instead of hiding it behind a weekend skip", async () => {
  const bytes = Buffer.from(html("2026-08-27", "睡前版"));
  const blob = gitBlobSha(bytes);
  const meta = {schemaVersion: 1, sourceSha: sha("b"), sourceCommitEpoch: slotStartEpoch("2026-08-27", "pm") + 60, dataDate: "2026-08-27", htmlBlob: blob};
  const fetchFn = async url => {
    if (url.pathname.endsWith("index.html")) return response(loaderBytes);
    if (url.pathname.endsWith("latest.html")) return response(bytes);
    return response(JSON.stringify(meta));
  };
  const result = await runWatcher({
    baseUrl: "https://example.invalid/xuan-ib/",
    mainIndexHtml: loaderBytes,
    mainHtml: bytes,
    mainMeta: meta,
    publicationHistory: [{...meta, commit: sha("d"), valid: true, edition: "pm"}],
    expectedEdition: "auto",
    now: new Date("2026-08-28T23:35:00Z"),
    fetchFn
  });
  assert.equal(result.ok, false);
  assert.equal(result.skipped, undefined);
  assert.equal(result.expectedDate, "2026-08-28");
  assert.match(result.issues.join("\n"), /expected HKT report date at least 2026-08-28/);
  assert.match(result.issues.join("\n"), /history does not prove the scheduled PM/);
});

test("a newer ad-hoc fixed page is healthy only when history still proves the scheduled slot", () => {
  const scheduledBytes = Buffer.from(html("2026-08-28", "睡前版"));
  const adhocBytes = Buffer.from(html("2026-08-29", "临时版"));
  const adhocMeta = {
    schemaVersion: 1,
    sourceSha: sha("a"),
    sourceCommitEpoch: slotStartEpoch("2026-08-29", "am") + 600,
    dataDate: "2026-08-29",
    htmlBlob: gitBlobSha(adhocBytes)
  };
  const scheduledEntry = {
    commit: sha("c"), valid: true, dataDate: "2026-08-28", edition: "pm",
    sourceSha: sha("b"), sourceCommitEpoch: slotStartEpoch("2026-08-28", "pm") + 60
  };
  const base = {
    indexHtml: loaderBytes,
    mainIndexHtml: loaderBytes,
    onlineHtml: adhocBytes,
    onlineMeta: adhocMeta,
    mainHtml: adhocBytes,
    mainMeta: adhocMeta,
    expectedEdition: "pm",
    expectedDate: "2026-08-28",
    now: new Date("2026-08-29T00:34:00Z")
  };
  assert.equal(evaluateFreshness({...base, publicationHistory: []}).ok, false);
  assert.equal(evaluateFreshness({...base, publicationHistory: [scheduledEntry]}).ok, true);
  assert.notEqual(gitBlobSha(scheduledBytes), adhocMeta.htmlBlob);
});

test("an old deployed loader fails even when latest HTML and metadata are current", async () => {
  const bytes = Buffer.from(html("2026-08-27", "睡前版"));
  const blob = gitBlobSha(bytes);
  const meta = {schemaVersion: 1, sourceSha: sha("b"), sourceCommitEpoch: slotStartEpoch("2026-08-27", "pm") + 60, dataDate: "2026-08-27", htmlBlob: blob};
  const oldLoader = Buffer.from("<!doctype html><script>fetch('latest.html')</script><!-- old loader -->");
  const fetchFn = async url => {
    if (url.pathname.endsWith("index.html")) return response(oldLoader);
    if (url.pathname.endsWith("latest.html")) return response(bytes);
    return response(JSON.stringify(meta));
  };
  const result = await runWatcher({
    baseUrl: "https://example.invalid/xuan-ib/",
    mainIndexHtml: loaderBytes,
    mainHtml: bytes,
    mainMeta: meta,
    publicationHistory: [{...meta, commit: sha("d"), valid: true, edition: "pm"}],
    expectedEdition: "pm",
    now: new Date("2026-08-27T14:20:00Z"),
    fetchFn
  });
  assert.equal(result.ok, false);
  assert.match(result.issues.join("\n"), /online index\.html differs from main loader/);
  assert.notEqual(result.onlineIndexBlob, result.mainIndexBlob);
});

test("the watcher retries a transient stale loader within a bounded window", async () => {
  const bytes = Buffer.from(html("2026-08-27", "睡前版"));
  const blob = gitBlobSha(bytes);
  const meta = {schemaVersion: 1, sourceSha: sha("b"), sourceCommitEpoch: slotStartEpoch("2026-08-27", "pm") + 60, dataDate: "2026-08-27", htmlBlob: blob};
  const oldLoader = Buffer.from("<!doctype html><script>fetch('latest.html')</script><!-- stale -->");
  let indexReads = 0;
  const waits = [];
  const fetchFn = async url => {
    if (url.pathname.endsWith("index.html")) {
      indexReads += 1;
      return response(indexReads === 1 ? oldLoader : loaderBytes);
    }
    if (url.pathname.endsWith("latest.html")) return response(bytes);
    return response(JSON.stringify(meta));
  };
  const result = await runWatcherWithRetries({
    baseUrl: "https://example.invalid/xuan-ib/",
    mainIndexHtml: loaderBytes,
    mainHtml: bytes,
    mainMeta: meta,
    publicationHistory: [{...meta, commit: sha("d"), valid: true, edition: "pm"}],
    expectedEdition: "pm",
    now: new Date("2026-08-27T14:20:00Z"),
    attempts: 3,
    intervalMs: 17,
    fetchFn,
    waitFn: async milliseconds => waits.push(milliseconds)
  });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 2);
  assert.deepEqual(waits, [17]);
});

test("the watcher stops after the configured number of failed attempts", async () => {
  const bytes = Buffer.from(html("2026-08-27", "睡前版"));
  const blob = gitBlobSha(bytes);
  const meta = {schemaVersion: 1, sourceSha: sha("b"), sourceCommitEpoch: slotStartEpoch("2026-08-27", "pm") + 60, dataDate: "2026-08-27", htmlBlob: blob};
  const staleLoader = Buffer.from("<!doctype html><script>fetch('latest.html')</script><!-- stale forever -->");
  let indexReads = 0;
  const waits = [];
  const fetchFn = async url => {
    if (url.pathname.endsWith("index.html")) {
      indexReads += 1;
      return response(staleLoader);
    }
    if (url.pathname.endsWith("latest.html")) return response(bytes);
    return response(JSON.stringify(meta));
  };
  const result = await runWatcherWithRetries({
    baseUrl: "https://example.invalid/xuan-ib/",
    mainIndexHtml: loaderBytes,
    mainHtml: bytes,
    mainMeta: meta,
    publicationHistory: [{...meta, commit: sha("d"), valid: true, edition: "pm"}],
    expectedEdition: "pm",
    now: new Date("2026-08-27T14:20:00Z"),
    attempts: 3,
    intervalMs: 11,
    fetchFn,
    waitFn: async milliseconds => waits.push(milliseconds)
  });
  assert.equal(result.ok, false);
  assert.equal(result.attempts, 3);
  assert.equal(indexReads, 3);
  assert.deepEqual(waits, [11, 11]);
  assert.match(result.issues.join("\n"), /online index\.html differs from main loader/);
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

test("workflows keep the shared DST schedule, read-only watcher, and post-push non-gating probe", () => {
  const watcher = fs.readFileSync(".github/workflows/watch-xuan-ib-freshness.yml", "utf8");
  assert.match(watcher, /cron: '35 0 \* \* 2-6'/);
  assert.match(watcher, /cron: '50 13 \* \* 1-5'/);
  assert.match(watcher, /cron: '50 14 \* \* 1-5'/);
  assert.doesNotMatch(watcher, /cron: '25 13/);
  assert.match(watcher, /AM is due Tuesday-Saturday/);
  assert.match(watcher, /PM targets 09:35 New York/);
  assert.match(watcher, /--schedule "\$\{SCHEDULE_EXPRESSION:-\}"/);
  assert.match(watcher, /--main-index xuan-ib\/index\.html/);
  assert.match(watcher, /--attempts 4/);
  assert.match(watcher, /--interval-ms 20000/);
  assert.match(watcher, /timeout-minutes: 5/);
  assert.match(watcher, /fetch-depth: 0/);
  assert.match(watcher, /permissions:\n  contents: read/);
  assert.doesNotMatch(watcher, /contents: write|secrets\./);

  const promotion = fs.readFileSync(".github/workflows/promote-xuan-ib-handover.yml", "utf8");
  assert.ok(promotion.indexOf("git push origin HEAD:refs/heads/main") < promotion.indexOf("Observe the Pages rollout"));
  assert.match(promotion, /timeout --signal=TERM 285s/);
  assert.match(promotion, /--attempts 20/);
  assert.match(promotion, /--interval-ms 15000/);
  assert.match(promotion, /Pages rollout delay does not change the promotion result/);
});
