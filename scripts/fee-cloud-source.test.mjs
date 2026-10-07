import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { HEALTH_SCHEMA, validateHealth } from "./fee-data-health.mjs";
import test from "node:test";
import { isControlledWebullNetProceeds, latestCommonBenchmarkDate, normalizeRead, selectBenchmark, SharesightCloudReader } from "./fee-cloud-source.mjs";
import { assertCandidateReceiptable, fetchEconomicWithRetry, readStableWithRetry, verifyWriterOutcome, weekendGapDates, writerFailureCode, producerFailureCode, produce } from "./fee-cloud-producer.mjs";
import { SourceFetchError } from "./fee-economic-source.mjs";

const D = "2026-09-23";

test("writer diagnostics expose fixed categories and stage without private child stderr", () => {
  assert.equal(writerFailureCode("error: STYLE_EVIDENCE_REQUIRED — nothing written\n", true),
    "FEE_CLOUD_WRITER_PREFLIGHT_STYLE_EVIDENCE_REQUIRED");
  assert.equal(writerFailureCode("error: duplicate/stale cash in webull on 2026-10-01: balance 123456.78 ignores private movement"),
    "FEE_CLOUD_WRITER_CASH_RECONCILIATION");
  assert.equal(writerFailureCode("error: fee calculation receipt failed: private amount 98765"),
    "FEE_CLOUD_WRITER_FEE_RECEIPT");
  for (const stderr of ["private account U123456 secret=abc 123456.78", "error: STYLE_secret=abc", "", null]) {
    assert.equal(writerFailureCode(stderr), "FEE_CLOUD_WRITER_UNKNOWN");
  }
});
const benchmarkCache = { v: 1, benchmarks: {
  spy: { series: [{ d: "2026-09-22", p: 700 }, { d: D, p: 701, div: 1.5 }] },
  qqq: { series: [{ d: "2026-09-22", p: 600 }, { d: D, p: 602 }] },
} };

const portfolio = (account, id, cashId, holdings, transactions = []) => ({
  performance: { report: { portfolio_id: id, end_date: D, currency: { code: "USD" }, value: 1000,
    cash_accounts: [{ id: cashId, value: 400, currency: { code: "USD" }, portfolio: { id, name: account } }],
    holdings: holdings.map(h => ({ id: h.id, value: h.value, valid_position: true,
      instrument: { code: h.ticker }, instrument_currency: { code: "USD" }, portfolio: { id, name: account } })) } },
  holdings: { holdings: holdings.map(h => ({ id: h.id, valid_position: true, portfolio: { id, name: account } })) },
  cashAccounts: { cash_accounts: [{ id: cashId, portfolio_id: id, currency: "USD", portfolio_currency: "USD", balance: 400 }] },
  cashTransactions: { [cashId]: { cash_account_transactions: transactions } },
  trades: { trades: transactions.filter(t => t.trade_id).map(t => ({ id: t.trade_id })) },
});

function raw() {
  return {
    schwab: portfolio("Schwab-HK", 936249, 142251, [
      { id: 1, ticker: "SGOV", value: 100 }, { id: 2, ticker: "BRK/B", value: 500 },
    ], [{ amount: 50, balance: 400, cash_account_id: 142251, date_time: `${D}T00:00:00.000Z`, description: "Sell trade",
      cash_account_transaction_type: { name: "Sell Trade" }, trade_id: 9, holding_id: 2, foreign_identifier: null }]),
    webull: portfolio("Webull", 1350094, 90250, [
      { id: 3, ticker: "SGOV", value: 50 }, { id: 4, ticker: "GOOG", value: 550 },
    ]),
  };
}

test("benchmark requires a complete same-date pair", () => {
  assert.equal(latestCommonBenchmarkDate(benchmarkCache), D);
  assert.deepEqual(selectBenchmark(benchmarkCache, D), { spy: 701, spyd: 1.5, qqq: 602, qqqd: 0 });
  const broken = structuredClone(benchmarkCache); broken.benchmarks.qqq.series.pop();
  assert.throws(() => selectBenchmark(broken, D), /BENCHMARK_PENDING/);
});

test("normalization reconciles cash, SGOV, stock, flow evidence and style input", () => {
  const result = normalizeRead(raw(), D, selectBenchmark(benchmarkCache, D));
  assert.deepEqual(result.accounts, { schwab: 1000, webull: 1000 });
  assert.deepEqual(result.splits, { cash: 800, stock: 1050, other: 150 });
  assert.equal(result.styleInput.portfolios[0].holdings.some(row => row.ticker === "SGOV"), false);
  assert.equal(result.flows[0].tradeId, 9);
  assert.deepEqual(result.acctCash, { schwab: 400 });
  assert.deepEqual(result.prevAcctCash, { schwab: 350 });
  assert.match(result.sourceFingerprint, /^[a-f0-9]{64}$/);
});

test("controlled Webull principal cash legs remain internal trades", () => {
  const fixture = raw();
  const foreignIdentifier = "webullhk-10205226-email-946332324153d3d2466a2cf7a2ccfcda-cash";
  fixture.webull.cashTransactions[90250].cash_account_transactions.push({
    amount: -125, balance: 400, cash_account_id: 90250, date_time: `${D}T00:00:00.000Z`,
    description: `Webull AAOI BUY securities principal; NOT external funding; ${foreignIdentifier}`,
    cash_account_transaction_type: { name: "WITHDRAWAL" }, trade_id: null, holding_id: null,
    foreign_identifier: foreignIdentifier,
  });
  const result = normalizeRead(fixture, D, selectBenchmark(benchmarkCache, D));
  const flow = result.flows.find(row => row.foreignIdentifier === foreignIdentifier);
  assert.equal(flow.evidence, "internal_trade");
});

test("account-bound Webull principal cash legs match the unique live Sharesight trade", () => {
  const fixture = raw();
  const orderId = "0387IJ3B2S80O0K7Q9BC000000";
  fixture.webull.cashTransactions[90250].cash_account_transactions.push({
    amount: -9650, balance: 400, cash_account_id: 90250, date_time: `${D}T04:00:00.000Z`,
    description: `Webull VSTL BUY securities principal; NOT external funding; order ${orderId}; holding 29274212; ${D} 09:55:50 EDT; source fee USD 0.00.`,
    cash_account_transaction_type: { name: "WITHDRAWAL" }, trade_id: null, holding_id: null,
    foreign_identifier: null,
  });
  fixture.webull.trades.trades.push({
    id: 138761041, portfolio_id: 1350094, transaction_date: D, state: "confirmed",
    description_code: "BUY", holding_id: 29274212, value: 9650,
    instrument: { code: "VSTL" },
    comments: `Webull account 10205226; ${D} 09:55:50 EDT fill; order ${orderId}; 500 VSTL @ USD 19.30; source commission/fees USD 0.00.`,
  });
  const result = normalizeRead(fixture, D, selectBenchmark(benchmarkCache, D));
  const flow = result.flows.find(row => row.desc.includes(orderId));
  assert.equal(flow.evidence, "internal_trade");
});

test("Webull principal text alone stays unresolved when its trade evidence does not match", () => {
  const fixture = raw();
  const orderId = "0387IJ3B2S80O0K7Q9BC000000";
  fixture.webull.cashTransactions[90250].cash_account_transactions.push({
    amount: -9650, balance: 400, cash_account_id: 90250, date_time: `${D}T04:00:00.000Z`,
    description: `Webull VSTL BUY securities principal; NOT external funding; order ${orderId}; holding 29274212; ${D} 09:55:50 EDT; source fee USD 0.00.`,
    cash_account_transaction_type: { name: "WITHDRAWAL" }, trade_id: null, holding_id: null,
    foreign_identifier: null,
  });
  fixture.webull.trades.trades.push({
    id: 138761041, portfolio_id: 1350094, transaction_date: D, state: "confirmed",
    description_code: "BUY", holding_id: 29274212, value: 9651,
    instrument: { code: "VSTL" },
    comments: `Webull account 10205226; ${D} 09:55:50 EDT fill; order ${orderId}; 500 VSTL @ USD 19.30; source commission/fees USD 0.00.`,
  });
  const result = normalizeRead(fixture, D, selectBenchmark(benchmarkCache, D));
  const flow = result.flows.find(row => row.desc.includes(orderId));
  assert.equal(Object.hasOwn(flow, "evidence"), false);
});

test("a generic Webull withdrawal is not promoted to internal without the controlled evidence", () => {
  const fixture = raw();
  fixture.webull.cashTransactions[90250].cash_account_transactions.push({
    amount: -125, balance: 400, cash_account_id: 90250, date_time: `${D}T00:00:00.000Z`,
    description: "manual withdrawal", cash_account_transaction_type: { name: "WITHDRAWAL" },
    trade_id: null, holding_id: null, foreign_identifier: "manual-1",
  });
  const result = normalizeRead(fixture, D, selectBenchmark(benchmarkCache, D));
  const flow = result.flows.find(row => row.foreignIdentifier === "manual-1");
  assert.equal(Object.hasOwn(flow, "evidence"), false);
});

test("unlisted performance holding and non-USD movement fail closed", () => {
  const missing = raw(); missing.schwab.holdings.holdings.pop();
  assert.throws(() => normalizeRead(missing, D, selectBenchmark(benchmarkCache, D)), /HOLDING_IDENTITY/);
  const fx = raw(); fx.schwab.cashAccounts.cash_accounts[0].currency = "HKD";
  assert.throws(() => normalizeRead(fx, D, selectBenchmark(benchmarkCache, D)), /NON_USD_MOVEMENT/);
});

test("reader allows only fixed GET routes and proves two identical reads", async () => {
  const fixtures = raw();
  const response = (url, value) => ({ status: 200, url, headers: { get: () => "application/json" },
    text: async () => JSON.stringify(value) });
  let calls = 0;
  const fetchImpl = async (url, init) => {
    calls++;
    if (url.endsWith("/oauth2/token")) return response(url, { access_token: "x".repeat(30), token_type: "bearer" });
    if (url.endsWith("/portfolios.json")) return response(url, { portfolios: [
      { id: 936249, name: "Schwab-HK", currency_code: "USD" }, { id: 1350094, name: "Webull", currency_code: "USD" },
    ] });
    const account = url.includes("936249") || url.includes("142251") ? "schwab" : "webull";
    if (url.includes("/performance?")) return response(url, fixtures[account].performance);
    if (url.includes("/holdings?")) return response(url, fixtures[account].holdings);
    if (url.includes("/cash_accounts.json") && !url.includes("cash_account_transactions")) return response(url, fixtures[account].cashAccounts);
    if (url.includes("cash_account_transactions")) return response(url, Object.values(fixtures[account].cashTransactions)[0]);
    if (url.includes("trades.json")) return response(url, fixtures[account].trades);
    throw new Error(`unexpected ${init.method} ${url}`);
  };
  const reader = new SharesightCloudReader({ clientId: "id", clientSecret: "secret", fetchImpl });
  const result = await reader.readStable(D, selectBenchmark(benchmarkCache, D));
  assert.equal(result.targetDate, D);
  assert.equal(calls, 26);
  assert.equal(result.managementInput.historyComplete, true);
});

test("cloud producer accepts the real updated and no-op writer contracts", () => {
  assert.equal(verifyWriterOutcome("a".repeat(64), "b".repeat(64),
    "ok 2026-09-24 points=56 status-as-of=2026-09-24 provisional", "2026-09-24"), "updated");
  assert.equal(verifyWriterOutcome("a".repeat(64), "a".repeat(64), "no-op 2026-09-24", "2026-09-24"), "no-op");
  assert.throws(() => verifyWriterOutcome("a".repeat(64), "b".repeat(64),
    "no-op 2026-09-24", "2026-09-24"), /FEE_CLOUD_WRITER_OUTCOME/);
  assert.equal(verifyWriterOutcome("a".repeat(64), "b".repeat(64),
    "no-op 2026-09-28", "2026-09-28", true), "updated");
});

test("cloud producer reports unresolved cash before the generic receipt gate", () => {
  assert.doesNotThrow(() => assertCandidateReceiptable({ flowsUnresolved: [] }));
  assert.throws(() => assertCandidateReceiptable({ flowsUnresolved: [{ id: "review" }] }),
    /FEE_CLOUD_UNRESOLVED_FLOW/);
});

test("cloud producer retries one transient stable-read failure only", async () => {
  let calls = 0, sleeps = 0;
  const reader = { readStable: async () => {
    calls++;
    if (calls === 1) throw new Error("FEE_CLOUD_SOURCE_UNSTABLE");
    return { targetDate: D };
  } };
  const result = await readStableWithRetry(reader, D, {}, { delayMs: 0, sleep: async () => { sleeps++; } });
  assert.deepEqual(result, { input: { targetDate: D }, retryCount: 1 });
  assert.equal(sleeps, 1);
  const permanent = { readStable: async () => { throw new Error("FEE_CLOUD_IDENTITY"); } };
  await assert.rejects(readStableWithRetry(permanent, D, {}, { delayMs: 0 }), /FEE_CLOUD_IDENTITY/);
});

test("cloud producer retries one transient economic-source stability failure only", async () => {
  let calls = 0, sleeps = 0;
  const result = await fetchEconomicWithRetry(async () => {
    calls++;
    if (calls === 1) throw new SourceFetchError("SOURCE_CHANGED");
    return { envelopeVersion: 4 };
  }, { delayMs: 0, sleep: async () => { sleeps++; } });
  assert.deepEqual(result, { economic: { envelopeVersion: 4 }, retryCount: 1 });
  assert.equal(sleeps, 1);
  await assert.rejects(fetchEconomicWithRetry(async () => {
    throw new SourceFetchError("SOURCE_IDENTITY");
  }, { delayMs: 0 }), /SOURCE_IDENTITY/);
});

test("cloud producer bridges only a contiguous weekend before the next market session", () => {
  assert.deepEqual(weekendGapDates([{ d: "2026-09-25" }], "2026-09-28"),
    ["2026-09-26", "2026-09-27"]);
  assert.deepEqual(weekendGapDates([{ d: "2026-09-27" }], "2026-09-28"), []);
  assert.throws(() => weekendGapDates([{ d: "2026-09-25" }], "2026-09-29"), /WEEKEND_GAP/);
});

test("cloud workflow uses main-bound Google OIDC instead of stored Sharesight secrets", () => {
  const workflow = fs.readFileSync(new URL("../.github/workflows/fee-cloud-producer.yml", import.meta.url), "utf8");
  assert.match(workflow, /cron: '30,40,55 3 \* \* 2-6'/,
    "the first cloud attempt must be 11:30 HKT with independent early retries");
  assert.match(workflow, /cron: '20,50 4 \* \* 2-6'/,
    "the early recovery window must continue through 12:50 HKT");
  assert.match(workflow, /permissions:\n  contents: read\n  id-token: write/);
  assert.match(workflow, /google-github-actions\/auth@7c6bc770dae815cd3e89ee6cdf493a5fab2cc093/);
  assert.match(workflow, /workloadIdentityPools\/fee-console-github\/providers\/fee-console-main/);
  assert.match(workflow, /service_account: fee-cloud-producer@family-portfolio-gateway\.iam\.gserviceaccount\.com/);
  assert.match(workflow, /google-github-actions\/get-secretmanager-secrets@bc9c54b29fdffb8a47776820a7d26e77b379d262/);
  assert.match(workflow, /sharesight-broker-sync-client-id\/1/);
  assert.match(workflow, /sharesight-broker-sync-client-secret\/1/);
  assert.match(workflow, /steps\.sharesight_credentials\.outputs\.client_id/);
  assert.match(workflow, /steps\.sharesight_credentials\.outputs\.client_secret/);
  assert.doesNotMatch(workflow, /secrets\.FEE_CLOUD_SHARESIGHT_CLIENT_/);
});


test('normalized dividend legs use confirmed payout economics and retain the posting-date gate', () => {
  const fixture=raw(),key='webull.dividend:12345678:GOOG:2026-09-22:900';
  fixture.webull.cashTransactions[90250].cash_account_transactions=[
    {id:901,cash_account_id:90250,date_time:D+'T04:00:00Z',amount:70,balance:400,cash_account_transaction_type:{name:'DEPOSIT'},description:`GOOG dividend: gross100.00 WHT30.00 net70.00; fee0.40 separately. INTERNAL_DIVIDEND_CASH, not external funding. Notice; ledger date unverified. key=${key}:net`},
    {id:902,cash_account_id:90250,date_time:D+'T04:00:00Z',amount:-0.4,balance:400,cash_account_transaction_type:{name:'FEE'},description:`GOOG dividend collection fee: gross100.00 x0.4%, min0.30, rounded0.40. NOT WHT. Official Webull schedule + exact net69.60 cash match; rule-authorized. key=${key}:fee`},
  ];
  fixture.webull.incomePayouts={900:{id:900,portfolio_id:1350094,holding_id:4,symbol:'GOOG',paid_on:'2026-09-22',currency:'USD',confirmed:true,state:'confirmed',non_taxable:false,tax_credit:0,gross_amount:100,resident_withholding_tax:30,amount:70}};
  let result=normalizeRead(fixture,D,selectBenchmark(benchmarkCache,D));
  assert.equal(result.flows.filter(f=>f.evidence==='internal_income_pending_date').length,2);
  fixture.webull.incomeDateEvidence={[key]:{cashDate:D,verified:true,authority:'broker-cash-ledger',sourceRef:'synthetic ledger'}};
  result=normalizeRead(fixture,D,selectBenchmark(benchmarkCache,D));
  assert.equal(result.flows.filter(f=>f.evidence==='internal_income').length,2);
  fixture.webull.incomePayouts[900].portfolio_id=936249;
  result=normalizeRead(fixture,D,selectBenchmark(benchmarkCache,D));
  assert.equal(result.flows.some(f=>f.evidence==='internal_income'),false);
});

// Execute the actual trusted-workflow shell branch and actual validator CLI.
// Only the clock and git-candidate enumeration are fixed; no financial sources.
function scheduledReceiptDecision(iso, event = "schedule", receipt = null, {recentCandidate = false, candidateCount = 0} = {}) {
  const workflow = fs.readFileSync(new URL("../.github/workflows/promote-fee-data.yml", import.meta.url), "utf8");
  const start = workflow.indexOf("          if (( ${#candidates[@]} == 0 )); then");
  const end = workflow.indexOf("          if (( ${#candidates[@]} != 1 )); then", start);
  assert.ok(start >= 0 && end > start);
  const day = value => new Intl.DateTimeFormat("en-CA", {timeZone: "Asia/Hong_Kong", year: "numeric", month: "2-digit", day: "2-digit"}).format(new Date(value));
  const shiftDay = (value, days) => {const date = new Date(value + "T00:00:00Z");date.setUTCDate(date.getUTCDate() + days);return date.toISOString().slice(0,10);};
  const hkt = day(iso), weekday = new Intl.DateTimeFormat("en-US", {timeZone: "Asia/Hong_Kong", weekday: "short"}).format(new Date(iso));
  const weekdayNumber = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(weekday) + 1;
  const cycleStart = shiftDay(hkt, -((weekdayNumber + 1) % 7));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fee-watchdog-test-"));
  try {
    const data = Buffer.from('{"synthetic":true}'), hash = createHash("sha256").update(data).digest("hex");
    fs.writeFileSync(path.join(directory, "data.json"), data);
    let checkedDay = "";
    if (receipt) {
      const checkedAt = receipt.checkedAt || `${receipt.date}T06:00:00+08:00`;
      try { checkedDay = day(checkedAt); } catch {}
      const targetDate = receipt.targetDate || shiftDay(checkedDay || hkt, -1);
      const value = {schema: receipt.valid === false ? "invalid" : HEALTH_SCHEMA, checkedAt, targetDate,
        sourceDates: receipt.sourceDates || {schwab: targetDate, webull: targetDate, benchmark: targetDate},
        outcome: receipt.outcome || "no-op", dataSha256: receipt.badHash ? "a".repeat(64) : hash,
        errorCode: receipt.outcome === "failed" ? "SHARESIGHT_UNSTABLE" : null};
      fs.writeFileSync(path.join(directory, "fee-data-health.json"), JSON.stringify(value));
    }
    const clock = path.join(directory, "clock.mjs");
    fs.writeFileSync(clock, `const OriginalDate=Date, now=OriginalDate.parse(process.env.TEST_NOW);globalThis.Date=class extends OriginalDate{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}};`);
    const script = `set -euo pipefail
candidates=(${candidateCount ? "verified-candidate" : ""})
recent_unpromoted_candidate=${recentCandidate}
date() {
  [[ "$TZ" == Asia/Hong_Kong ]] || return 1
  if [[ "$*" == '+%u' ]]; then echo "$TEST_WEEKDAY";
  elif [[ "$*" == *'last Saturday'* ]]; then echo "$TEST_CYCLE_START";
  elif [[ "$*" == *'-d '* ]]; then [[ -n "$TEST_RECEIPT_DATE" ]] && echo "$TEST_RECEIPT_DATE";
  else echo "$TEST_TODAY"; fi
}
jq() { "$TEST_NODE" -e 'const fs=require("fs"),value=JSON.parse(fs.readFileSync(process.argv[2],"utf8"));console.log(value[process.argv[1].includes("checkedAt")?"checkedAt":"outcome"]||"");' "$2" "$3"; }
node() { echo "receipt-validation $*" >&2; "$TEST_NODE" --import "$TEST_CLOCK" "$TEST_VALIDATOR" "\${@:2}"; }
${workflow.slice(start, end)}
echo candidate-path`;
    const result = spawnSync("bash", ["-c", script], {cwd: directory, encoding: "utf8", env: {...process.env,
      TZ: "America/Los_Angeles", GITHUB_EVENT_NAME: event, GITHUB_OUTPUT: path.join(directory, "output"), TEST_NOW: iso,
      TEST_TODAY: hkt, TEST_WEEKDAY: String(weekdayNumber), TEST_CYCLE_START: cycleStart, TEST_RECEIPT_DATE: checkedDay,
      TEST_NODE: process.execPath, TEST_CLOCK: clock, TEST_VALIDATOR: fileURLToPath(new URL("./fee-data-health.mjs", import.meta.url))}});
    return {...result, output: fs.existsSync(path.join(directory, "output")) ? fs.readFileSync(path.join(directory, "output"), "utf8") : ""};
  } finally { fs.rmSync(directory, {recursive: true, force: true}); }
}

test("scheduled watchdog skips only Hong Kong non-production Sun/Mon with no candidate", () => {
  for (const iso of ["2026-10-04T11:06:24Z", "2026-10-04T16:00:00Z", "2026-10-05T07:45:00Z"]) {
    const result = scheduledReceiptDecision(iso, "schedule", {date: "2026-10-03", valid: true});
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /No producer is scheduled today/);
    assert.equal(result.output, "sha=\n");
    assert.match(result.stderr, /receipt-validation/);
  }
});

test("all Hong Kong Tue-Sat production days still fail without a verified same-day receipt", () => {
  for (const iso of ["2026-10-05T16:00:00Z", "2026-10-06T05:15:00Z", "2026-10-07T05:15:00Z", "2026-10-08T05:15:00Z", "2026-10-09T05:15:00Z", "2026-10-10T07:45:00Z"]) {
    const result = scheduledReceiptDecision(iso);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /No verified Codex fee-data producer receipt exists for today/);
    assert.equal(result.output, "");
  }
});

test("same-day validation and manual/event receipt protections remain enforced", () => {
  for (const event of ["workflow_dispatch", "workflow_run"]) {
    const missing = scheduledReceiptDecision("2026-10-04T11:06:24Z", event);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /No verified Codex fee-data producer receipt/);
  }
  const valid = scheduledReceiptDecision("2026-10-06T05:15:00Z", "schedule", {date: "2026-10-06", valid: true});
  assert.equal(valid.status, 0);
  assert.match(valid.stderr, /receipt-validation/);
  assert.match(valid.stdout, /verified producer receipt/);
  for (const receipt of [{date: "2026-10-05", valid: true}, {date: "2026-10-06", valid: false}]) {
    assert.equal(scheduledReceiptDecision("2026-10-06T05:15:00Z", "schedule", receipt).status, 1);
  }
});


test("non-production no-op cannot hide recent rejected candidates or an invalid published receipt", () => {
  for (const [receipt, options] of [[null, {}], [{date: "2026-10-03", valid: false}, {}], [{date: "2026-10-03", valid: true}, {recentCandidate: true}]]) {
    const result = scheduledReceiptDecision("2026-10-04T11:06:24Z", "schedule", receipt, options);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Non-production-day no-op refused/);
    assert.equal(result.output, "");
  }
  const candidate = scheduledReceiptDecision("2026-10-04T11:06:24Z", "schedule", null, {candidateCount: 1});
  assert.equal(candidate.status, 0);
  assert.equal(candidate.stdout, "candidate-path\n");
  assert.doesNotMatch(candidate.stderr, /receipt-validation/);
  assert.equal(candidate.output, "");
});

test("recent outstanding branch detection separates rejected attempts from promoted and old branches", () => {
  const workflow = fs.readFileSync(new URL("../.github/workflows/promote-fee-data.yml", import.meta.url), "utf8");
  const start = workflow.indexOf("            # A rejected recent outstanding candidate");
  const end = workflow.indexOf('            if [[ ! "$branch_name"', start);
  assert.ok(start > 0 && end > start);
  for (const [promoted, timestamp, expected] of [[false, 100, "true"], [false, 99, "false"], [true, 101, "false"]]) {
    const result = spawnSync("bash", ["-c", `set -euo pipefail
recent_unpromoted_candidate=false
candidate_ref=origin/codex/fee-daily-20261002-abcdef
cutoff_epoch=100
git() { if [[ "$1" == merge-base ]]; then return ${promoted ? 0 : 1}; else echo ${timestamp}; fi; }
${workflow.slice(start, end)}
echo "$recent_unpromoted_candidate"`], {encoding: "utf8"});
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), expected);
  }
});


test("real validator accepts the observed Monday 49-hour receipt only in the scheduled off-day branch", () => {
  const receipt = {checkedAt: "2026-10-03T10:38:26.828Z", targetDate: "2026-10-02"};
  const iso = "2026-10-05T12:16:40.904Z", result = scheduledReceiptDecision(iso, "schedule", receipt);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /health ok 2026-10-02 no-op/);
  assert.match(result.stderr, /--max-age-hours=72/);
  assert.equal(result.output, "sha=\n");
  const health = {schema: HEALTH_SCHEMA, checkedAt: receipt.checkedAt, targetDate: receipt.targetDate, sourceDates: {schwab: receipt.targetDate, webull: receipt.targetDate, benchmark: receipt.targetDate}, outcome: "no-op", dataSha256: "a".repeat(64), errorCode: null};
  assert.deepEqual(validateHealth(health, {now: new Date(iso)}), ["health receipt age"]);
  for (const event of ["workflow_dispatch", "workflow_run"]) {
    const strict = scheduledReceiptDecision(iso, event, receipt);
    assert.equal(strict.status, 1);
    assert.doesNotMatch(strict.stderr, /--max-age-hours=72/);
  }
});

test("latest Saturday cycle is mandatory even when a Friday or older receipt is within 72 hours", () => {
  for (const checkedAt of ["2026-10-02T15:59:59.999Z", "2026-09-26T10:38:26.828Z"]) {
    const result = scheduledReceiptDecision("2026-10-05T07:45:00Z", "schedule", {checkedAt});
    assert.equal(result.status, 1);
    assert.match(result.stderr, /latest production cycle/);
  }
  const failed = scheduledReceiptDecision("2026-10-05T07:45:00Z", "schedule", {date: "2026-10-03", outcome: "failed"});
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /latest production cycle/);
  // A real later successful receipt may resolve the cycle; do not invent one.
  assert.equal(scheduledReceiptDecision("2026-10-05T07:45:00Z", "schedule", {date: "2026-10-05", outcome: "updated"}).status, 0);
});

test("earliest Saturday receipt survives late Monday but Tuesday HKT restores strict production freshness", () => {
  const receipt = {checkedAt: "2026-10-02T16:00:00.000Z", targetDate: "2026-10-01"};
  const monday = scheduledReceiptDecision("2026-10-05T15:59:59.999Z", "schedule", receipt);
  assert.equal(monday.status, 0, monday.stderr);
  assert.match(monday.stderr, /--max-age-hours=72/);
  const tuesday = scheduledReceiptDecision("2026-10-05T16:00:00.000Z", "schedule", receipt);
  assert.equal(tuesday.status, 1);
  assert.doesNotMatch(tuesday.stderr, /--max-age-hours=72/);
  // UTC Sunday 16:00 is already HKT Monday; UTC Monday 16:00 is HKT Tuesday.
  assert.equal(scheduledReceiptDecision("2026-10-04T16:00:00Z", "schedule", receipt).status, 0);
});

test("off-day real CLI still blocks corrupt structure, failed hash, future time and source-date mismatch", () => {
  const iso = "2026-10-05T12:16:40.904Z";
  for (const receipt of [{date: "2026-10-03", valid: false}, {date: "2026-10-03", badHash: true},
    {checkedAt: "2026-10-05T12:22:40.904Z"}, {date: "2026-10-03", sourceDates: {schwab: "2026-10-03", webull: "2026-10-02", benchmark: "2026-10-02"}}]) {
    const result = scheduledReceiptDecision(iso, "schedule", receipt);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /latest production cycle/);
  }
});

test("real validator has an inclusive 72-hour cap; default 36-hour validation stays unchanged", () => {
  const health = {schema: HEALTH_SCHEMA, checkedAt: "2026-10-02T16:00:00.000Z", targetDate: "2026-10-01", sourceDates: {schwab: "2026-10-01", webull: "2026-10-01", benchmark: "2026-10-01"}, outcome: "no-op", dataSha256: "a".repeat(64), errorCode: null};
  assert.deepEqual(validateHealth(health, {now: new Date("2026-10-05T16:00:00.000Z"), maxAgeHours: 72}), []);
  assert.deepEqual(validateHealth(health, {now: new Date("2026-10-05T16:00:00.001Z"), maxAgeHours: 72}), ["health receipt age"]);
  assert.deepEqual(validateHealth(health, {now: new Date("2026-10-05T16:00:00.000Z")}), ["health receipt age"]);
});


test('producer diagnostics expose fixed stages and exception categories only', () => {
  const hidden = 'account PRIVATE_ACCOUNT amount 987654.32 /private/path https://secret.example/token';
  for (const [error, category] of [[new TypeError(hidden), 'TYPE'], [new RangeError(hidden), 'RANGE'],
    [new SyntaxError(hidden), 'SYNTAX'], [new ReferenceError(hidden), 'REFERENCE'], [new Error(hidden), 'UNKNOWN']]) {
    assert.equal(producerFailureCode(error, 'SOURCE_READ'), `FEE_CLOUD_STAGE_SOURCE_READ_${category}`);
    assert.equal(producerFailureCode(error, hidden), `FEE_CLOUD_STAGE_UNKNOWN_${category}`);
  }
  assert.equal(producerFailureCode(Object.assign(new Error(hidden), {code:'ENOENT'}), 'PREPARE'), 'FEE_CLOUD_STAGE_PREPARE_SYSTEM_ENOENT');
  assert.equal(producerFailureCode(Object.assign(new Error(hidden), {code:hidden}), 'PREPARE'), 'FEE_CLOUD_STAGE_PREPARE_UNKNOWN');
  assert.equal(producerFailureCode(new Error('FEE_CLOUD_CASH_BALANCE_STALE'), 'SOURCE_READ'), 'FEE_CLOUD_CASH_BALANCE_STALE');
  assert.equal(producerFailureCode(new Error('FEE_CLOUD_' + 'A'.repeat(81)), 'SOURCE_READ'), 'FEE_CLOUD_STAGE_SOURCE_READ_UNKNOWN');
});

test('real producer source exception reports its stage and cleans up without any network', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fee-diagnostic-')); fs.chmodSync(dir,0o700);
  const cache=path.join(dir,'benchmark.json');fs.writeFileSync(cache,JSON.stringify(benchmarkCache));
  let cleaned=false, reads=0;
  try {
    await assert.rejects(produce({cli:{'benchmark-file':cache,'out-dir':dir},
      fetchEconomic:async()=>({envelopeVersion:4,cleanup(){cleaned=true;}}),
      reader:{async readStable(){reads++;throw new TypeError('private account amount URL /path');}}}),
      {message:'FEE_CLOUD_STAGE_SOURCE_READ_TYPE'});
    assert.equal(reads,1);assert.equal(cleaned,true);
    assert.equal(fs.existsSync(path.join(dir,'data.json')),false);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});


function netProceedsFixture() {
  const order='ABCDEF0123456789ABCD';
  const row={id:77,amount:99.75,balance:400,cash_account_id:90250,date_time:`${D}T00:00:00.000Z`,
    cash_account_transaction_type:{name:'DEPOSIT'},trade_id:null,holding_id:null,payout_id:null,foreign_identifier:null,
    description:`Webull GOOG SELL net proceeds; NOT external funding. Order ${order}; Sharesight trade 222; ${D}; gross USD100.00 less fee USD0.25 = net USD99.75. Fee included, no separate fee debit.`};
  const trade={id:222,portfolio_id:1350094,holding_id:4,transaction_date:D,state:'confirmed',description_code:'SELL',
    instrument:{code:'GOOG',currency_code:'USD'},quantity:10,price:10,price_currency_code:null,brokerage:0.25,brokerage_currency_code:'USD',value:-99.75,
    comments:`Webull GOOG SELL 10 shares on ${D} at USD10.00; order ${order}. Commission USD0; actual fee USD0.25 recorded in trade fees. Gross USD100.00; net USD99.75.`};
  return {account:'webull',row,movement:row.amount,targetDate:D,trades:[trade]};
}

test('strict net-proceeds evidence maps a unique confirmed fee-inclusive sell to internal trade', () => {
  const f=netProceedsFixture();assert.equal(isControlledWebullNetProceeds(f),true);
  const source=raw();source.webull.cashTransactions[90250].cash_account_transactions=[f.row];source.webull.trades.trades=f.trades;
  const result=normalizeRead(source,D,selectBenchmark(benchmarkCache,D));
  assert.equal(result.flows.find(r=>r.acct==='webull').evidence,'internal_trade');
  f.trades[0].price_currency_code='USD';assert.equal(isControlledWebullNetProceeds(f),true);
});

test('net-proceeds mapping rejects mismatched identity, money, currency, links and duplicates', () => {
  const changes=[f=>f.account='schwab',f=>f.row.cash_account_transaction_type.name='WITHDRAWAL',
    f=>f.row.payout_id=7,f=>f.movement=-99.75,f=>f.movement=99.76,f=>f.targetDate='2026-09-22',
    f=>f.row.description=f.row.description.replace('GOOG','OTHER'),f=>f.row.description=f.row.description.replace('trade 222','trade 223'),
    f=>f.row.description=f.row.description.replace('100.00','100.01'),f=>f.row.description=f.row.description.replace('fee USD0.25','fee USD0.26'),
    f=>f.row.description='bare deposit',f=>f.trades[0].portfolio_id=936249,f=>f.trades[0].state='pending',
    f=>f.trades[0].description_code='BUY',f=>f.trades[0].transaction_date='2026-09-22',
    f=>f.trades[0].instrument.code='OTHER',f=>f.trades[0].instrument.currency_code='HKD',
    f=>f.trades[0].price_currency_code='HKD',f=>f.trades[0].brokerage_currency_code='HKD',
    f=>f.trades[0].quantity=11,f=>f.trades[0].price=11,f=>f.trades[0].brokerage=0.24,
    f=>f.trades[0].value=-100,f=>f.trades[0].value=99.75,f=>f.row.trade_id=223,f=>f.row.holding_id=5,
    f=>f.trades[0].comments=f.trades[0].comments.replace('ABCDEF0123456789ABCD','ABCDEF0123456789ABCE'),
    f=>f.trades[0].comments=f.trades[0].comments.replace('Commission USD0','Commission USD1'),
    f=>f.trades.push({...f.trades[0]}),f=>f.trades.push({...f.trades[0],id:223})];
  for(const change of changes){const f=netProceedsFixture();change(f);assert.equal(isControlledWebullNetProceeds(f),false,change.toString());}
});
