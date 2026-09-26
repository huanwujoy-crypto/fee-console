import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { latestCommonBenchmarkDate, normalizeRead, selectBenchmark, SharesightCloudReader } from "./fee-cloud-source.mjs";
import { verifyWriterOutcome } from "./fee-cloud-producer.mjs";

const D = "2026-09-23";
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
    webull: portfolio("Webull", 1350094, 150591, [
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
  fixture.webull.cashTransactions[150591].cash_account_transactions.push({
    amount: -125, balance: 400, cash_account_id: 150591, date_time: `${D}T00:00:00.000Z`,
    description: `Webull AAOI BUY securities principal; NOT external funding; ${foreignIdentifier}`,
    cash_account_transaction_type: { name: "WITHDRAWAL" }, trade_id: null, holding_id: null,
    foreign_identifier: foreignIdentifier,
  });
  const result = normalizeRead(fixture, D, selectBenchmark(benchmarkCache, D));
  const flow = result.flows.find(row => row.foreignIdentifier === foreignIdentifier);
  assert.equal(flow.evidence, "internal_trade");
});

test("a generic Webull withdrawal is not promoted to internal without the controlled evidence", () => {
  const fixture = raw();
  fixture.webull.cashTransactions[150591].cash_account_transactions.push({
    amount: -125, balance: 400, cash_account_id: 150591, date_time: `${D}T00:00:00.000Z`,
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
  assert.equal(calls, 24);
});

test("cloud producer accepts the real updated and no-op writer contracts", () => {
  assert.equal(verifyWriterOutcome("a".repeat(64), "b".repeat(64),
    "ok 2026-09-24 points=56 status-as-of=2026-09-24 provisional", "2026-09-24"), "updated");
  assert.equal(verifyWriterOutcome("a".repeat(64), "a".repeat(64), "no-op 2026-09-24", "2026-09-24"), "no-op");
  assert.throws(() => verifyWriterOutcome("a".repeat(64), "b".repeat(64),
    "no-op 2026-09-24", "2026-09-24"), /FEE_CLOUD_WRITER_OUTCOME/);
});

test("cloud workflow uses main-bound Google OIDC instead of stored Sharesight secrets", () => {
  const workflow = fs.readFileSync(new URL("../.github/workflows/fee-cloud-producer.yml", import.meta.url), "utf8");
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
