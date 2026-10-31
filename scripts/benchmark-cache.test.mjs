import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

import {
  DEFINITIONS,
  appendCrossCheckedClose,
  appendIndependentNasdaqClose,
  extractNasdaqClose,
  extractNasdaqDividends,
  extractNasdaqHistoricalClose,
  extractPrices,
  expectedBenchmarkTargetDate,
  mergePrices,
  refresh,
  sharesightBenchmarkPoint,
  appendSharesightBenchmark,
  readSharesightBenchmark,
  sharesightBenchmarkDates,
  readSharesightBenchmarkRange,
  commitSharesightBenchmark,
  refreshSharesightCloud,
  sharesightBenchmarkFailureCode,
} from './refresh-benchmark-cache.mjs';

function ssFixture(key = 'spy') {
  const spy = key === 'spy', id = spy ? 101 : 102;
  return {
    key, holdingId: id, targetDate: '2026-10-30',
    holdingResponse: { holding: { id,
      instrument: { id: spy ? 44697 : 1886621, code: spy ? 'SPY' : 'QQQ', market_code: spy ? 'NYSE' : 'NASDAQ', currency_code: 'USD' },
      instrument_currency: { code: 'USD' }, quantity: 987.123,
      values_over_time: [{ timestamp: '2026-10-30', value: spy ? 101 : 202 }, { timestamp: '2026-10-29', value: 99 }],
    } },
    payoutsResponse: { payouts: [{ id: 999, personal_net: 321, company_event: {
      id: 1, ex_date: '2026-09-18', paid_on: '2026-10-30', amount_per_share: 0.8, currency_code: 'USD',
    } }] },
  };
}
function ssCache() {
  return { v: 1, generatedAt: '2026-10-30T00:00:00.000Z', source: 'prior verified source', benchmarks: {
    spy: { symbol: 'SPY', currency: 'USD', exchange: 'NYSEArca', series: [{ d: '2026-09-18', p: 90, div: 0.8 }, { d: '2026-10-29', p: 99, div: 0 }] },
    qqq: { symbol: 'QQQ', currency: 'USD', exchange: 'NasdaqGS', series: [{ d: '2026-09-18', p: 190 }, { d: '2026-10-29', p: 199 }] },
  } };
}
const ssPoints = () => Object.fromEntries(['spy', 'qqq'].map(key => [key, sharesightBenchmarkPoint(ssFixture(key))]));

test('Sharesight daily dates map directly; payment date does not cause a second dividend', () => {
  assert.deepEqual(sharesightBenchmarkPoint(ssFixture()), { d: '2026-10-30', p: 101 });
});
test('Sharesight gross per-share dividend ignores holding quantity, net payment and withholding', () => {
  const input = ssFixture();
  input.payoutsResponse.payouts[0].company_event.ex_date = input.targetDate;
  const point = sharesightBenchmarkPoint(input);
  assert.deepEqual(point, { d: '2026-10-30', p: 101, div: 0.8 });
  assert.equal((point.p + point.div * 0.7) / 99 - 1, (101 + 0.8 * 0.7) / 99 - 1);
});
test('Sharesight complete empty payout collection is an ordinary no-dividend day', () => {
  const input = ssFixture(); input.payoutsResponse.payouts = [];
  assert.deepEqual(sharesightBenchmarkPoint(input), { d: '2026-10-30', p: 101 });
  delete input.payoutsResponse.payouts;
  assert.throws(() => sharesightBenchmarkPoint(input), /SS_BENCHMARK_DIVIDENDS/);
});
test('Sharesight duplicate company event counts once and contradictory duplicate is rejected', () => {
  const input = ssFixture(), payout = input.payoutsResponse.payouts[0];
  payout.company_event.ex_date = input.targetDate;
  input.payoutsResponse.payouts.push(structuredClone(payout));
  assert.equal(sharesightBenchmarkPoint(input).div, 0.8);
  input.payoutsResponse.payouts[1].company_event.amount_per_share = 0.9;
  assert.throws(() => sharesightBenchmarkPoint(input), /SS_BENCHMARK_DIVIDEND_CONFLICT/);
});
test('Sharesight two distinct same-date events sum their gross per-share amounts', () => {
  const input = ssFixture(); input.payoutsResponse.payouts[0].company_event.ex_date = input.targetDate;
  input.payoutsResponse.payouts.push({ company_event: { id: 2, ex_date: input.targetDate, amount_per_share: 0.1, currency_code: 'USD' } });
  assert.equal(sharesightBenchmarkPoint(input).div, 0.9);
});
test('Sharesight identity and currency mismatches are rejected', () => {
  for (const change of [x => x.holdingResponse.holding.id++, x => x.holdingResponse.holding.instrument.code = 'OTHER',
    x => x.holdingResponse.holding.instrument.market_code = 'OTHER', x => x.holdingResponse.holding.instrument.currency_code = 'HKD',
    x => x.payoutsResponse.payouts[0].company_event.currency_code = 'HKD']) {
    const input = ssFixture(); change(input); assert.throws(() => sharesightBenchmarkPoint(input), /SS_BENCHMARK_/);
  }
});
test('Sharesight missing target date, malformed date and nonnumeric price are not zero or carry', () => {
  for (const change of [x => x.holdingResponse.holding.values_over_time.shift(),
    x => x.holdingResponse.holding.values_over_time[0].timestamp = '2026-02-30',
    x => x.holdingResponse.holding.values_over_time[0].value = '101',
    x => x.holdingResponse.holding.values_over_time[0].value = NaN]) {
    const input = ssFixture(); change(input); assert.throws(() => sharesightBenchmarkPoint(input), /SS_BENCHMARK_/);
  }
});
test('Sharesight conflicting same-day prices are rejected; repeated identical row is harmless', () => {
  const input = ssFixture(); input.holdingResponse.holding.values_over_time.push({ timestamp: input.targetDate, value: 101 });
  assert.equal(sharesightBenchmarkPoint(input).p, 101);
  input.holdingResponse.holding.values_over_time.at(-1).value = 102;
  assert.throws(() => sharesightBenchmarkPoint(input), /SS_BENCHMARK_PRICE_CONFLICT/);
});
test('Sharesight explicitly partial or restricted response is not a no-dividend day', () => {
  for (const flag of [{ meta: { pagination: { next_page: 2 } } }, { restricted: true }, { links: { next: '/next' } }]) {
    const input = ssFixture(); Object.assign(input.payoutsResponse, flag);
    assert.throws(() => sharesightBenchmarkPoint(input), /SS_BENCHMARK_INCOMPLETE/);
  }
});
test('Sharesight append preserves every historical byte value and excludes private response fields', () => {
  const existing = ssCache(), before = structuredClone(existing);
  const { changed, cache } = appendSharesightBenchmark({ existing, points: ssPoints(), targetDate: '2026-10-30', now: new Date('2026-10-31T02:00:00Z') });
  assert.equal(changed, true); assert.deepEqual(existing, before);
  for (const key of ['spy', 'qqq']) assert.deepEqual(cache.benchmarks[key].series.slice(0, -1), before.benchmarks[key].series);
  assert.match(cache.source, /Sharesight/); assert.match(cache.source, /earlier history/);
  for (const forbidden of ['quantity', 'personal_net', 'company_event', 'holdingId', 'payouts']) assert.equal(JSON.stringify(cache).includes(forbidden), false);
});
test('Sharesight same target exact data is no-op; different target data cannot rewrite history', () => {
  const first = appendSharesightBenchmark({ existing: ssCache(), points: ssPoints(), targetDate: '2026-10-30' });
  const second = appendSharesightBenchmark({ existing: first.cache, points: ssPoints(), targetDate: '2026-10-30' });
  assert.equal(second.changed, false); assert.equal(second.cache, first.cache);
  const points = ssPoints(); points.qqq.p++;
  assert.throws(() => appendSharesightBenchmark({ existing: first.cache, points, targetDate: '2026-10-30' }), /SS_BENCHMARK_TARGET_CONFLICT/);
});
test('Sharesight controlled reader issues exactly four bounded paths and has no write callback', async () => {
  const paths = [];
  const result = await readSharesightBenchmark({ existing: ssCache(), targetDate: '2026-10-30', holdingIds: { spy: 101, qqq: 102 },
    readJson: async path => { paths.push(path); const x = ssFixture(path.includes('/101') ? 'spy' : 'qqq'); return path.includes('/payouts?') ? x.payoutsResponse : x.holdingResponse; } });
  assert.equal(result.changed, true);
  assert.deepEqual(paths, ['/api/v3/holdings/101?values_over_time=2026-10-30', '/api/v3/holdings/101/payouts?use_date=ex_date', '/api/v3/holdings/102?values_over_time=2026-10-30', '/api/v3/holdings/102/payouts?use_date=ex_date']);
});
test('Sharesight controlled reader does not retry or return a partial pair after request failure', async () => {
  let calls = 0;
  await assert.rejects(readSharesightBenchmark({ existing: ssCache(), targetDate: '2026-10-30', holdingIds: { spy: 101, qqq: 102 },
    readJson: async () => { calls++; throw Error('synthetic unavailable'); } }), /synthetic unavailable/);
  assert.equal(calls, 1);
});
test('Sharesight controlled reader rejects duplicate holding bindings before any read', async () => {
  let calls = 0;
  await assert.rejects(readSharesightBenchmark({ existing: ssCache(), targetDate: '2026-10-30', holdingIds: { spy: 101, qqq: 101 }, readJson: async () => calls++ }), /SS_BENCHMARK_BINDING/);
  assert.equal(calls, 0);
});

const SS_MAIN = 'a'.repeat(40), SS_BASE = 'b'.repeat(40), SS_COMMIT = 'c'.repeat(40);
const ssGitBlob = bytes => createHash('sha1').update(`blob ${Buffer.byteLength(bytes)}\0`).update(bytes).digest('hex');
const ssCloudArgs = path => ({ path, targetDate: '2026-10-30', mode: 'publish', expectedMain: SS_MAIN,
  expectedCacheHead: SS_BASE, clientId: 'synthetic-client', clientSecret: 'synthetic-secret-canary',
  holdingIds: { spy: 101, qqq: 102 }, githubToken: 'synthetic-owner-token-only', now: new Date('2026-10-31T02:30:00Z') });
function ssHttp({ failAt = 0, change = () => {} } = {}) {
  const calls = [];
  return { calls, fetchImpl: async (url, init) => {
    calls.push({ url, method: init.method });
    assert.equal(new URL(url).origin, 'https://api.sharesight.com');
    assert.equal(init.redirect, 'error'); assert.ok(init.signal);
    if (calls.length === failAt) throw Error('private-url-token-canary');
    let value;
    if (url.endsWith('/oauth2/token')) {
      assert.equal(init.method, 'POST'); assert.match(init.body, /grant_type=client_credentials/);
      assert.equal(init.headers.Authorization, undefined);
      value = { access_token: 'synthetic-access-token-canary', token_type: 'bearer' };
    } else {
      assert.equal(init.method, 'GET'); assert.equal(init.headers.Authorization, 'Bearer synthetic-access-token-canary');
      assert.match(url, /^https:\/\/api.sharesight.com\/api\/v3\/holdings\/(101|102)(\?values_over_time=2026-10-30|\/payouts\?use_date=ex_date)$/);
      const fixture = ssFixture(url.includes('/101') ? 'spy' : 'qqq');
      value = url.includes('/payouts?') ? fixture.payoutsResponse : fixture.holdingResponse;
      change(value, url);
    }
    const response = new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
    Object.defineProperty(response, 'url', { value: url }); return response;
  } };
}
function ssGithub(beforeBytes, { mutate = () => {}, uncertain = false, refsChanged = false } = {}) {
  const calls = [], state = { afterBytes: null, mutations: 0 };
  const request = async (url, token, init = {}) => {
    assert.equal(token, 'synthetic-owner-token-only'); calls.push({ url, method: init.method || 'GET' });
    let value;
    if (url === 'https://api.github.com/graphql') {
      const body = JSON.parse(init.body);
      if (body.query.startsWith('mutation')) {
        state.mutations++;
        assert.equal(body.variables.input.expectedHeadOid, SS_BASE);
        assert.deepEqual(body.variables.input.branch, { repositoryNameWithOwner: 'huanwujoy-crypto/fee-console', branchName: 'market-data-cache' });
        assert.equal(body.variables.input.fileChanges.additions.length, 1);
        const file = body.variables.input.fileChanges.additions[0]; assert.equal(file.path, 'benchmark-close.json');
        state.afterBytes = Buffer.from(file.contents, 'base64');
        assert.doesNotMatch(state.afterBytes.toString(), /canary|quantity|personal_net|holdingId|paid_on/);
        if (uncertain) throw Error('secret-canary-uncertain');
        value = { data: { createCommitOnBranch: { commit: { oid: SS_COMMIT }, ref: { name: 'market-data-cache' } } } };
      } else value = { data: { viewer: { login: 'huanwujoy-crypto' }, repository: {
        main: { target: { oid: refsChanged ? 'd'.repeat(40) : SS_MAIN } },
        cache: { target: { oid: state.afterBytes ? SS_COMMIT : SS_BASE } },
        file: { oid: ssGitBlob(state.afterBytes || beforeBytes) },
      } } };
    } else {
      assert.equal(url, `https://api.github.com/repos/huanwujoy-crypto/fee-console/commits/${SS_COMMIT}`);
      value = { sha: SS_COMMIT, commit: { verification: { verified: true } }, author: { login: 'huanwujoy-crypto' },
        parents: [{ sha: SS_BASE }], files: [{ filename: 'benchmark-close.json', status: 'modified', sha: ssGitBlob(state.afterBytes) }] };
    }
    mutate(value, url, state); return value;
  };
  return { request, calls, state };
}

test('cloud SS range fills missed sessions, skips weekends, and makes only four GETs', async () => {
  const existing = ssCache(); for (const k of ['spy', 'qqq']) existing.benchmarks[k].series.at(-1).d = '2026-10-28';
  const calls = [];
  const result = await readSharesightBenchmarkRange({ existing, targetDate: '2026-11-02', holdingIds: { spy: 101, qqq: 102 },
    readJson: async route => {
      calls.push(route); const fixture = ssFixture(route.includes('/101') ? 'spy' : 'qqq');
      fixture.holdingResponse.holding.values_over_time.push({ timestamp: '2026-11-02', value: 105 });
      fixture.payoutsResponse.payouts[0].company_event.ex_date = '2026-10-30';
      return route.includes('/payouts?') ? fixture.payoutsResponse : fixture.holdingResponse;
    } });
  assert.deepEqual(result.dates, ['2026-10-29', '2026-10-30', '2026-11-02']); assert.equal(calls.length, 4);
  assert.equal(calls.filter(p => p.endsWith('values_over_time=2026-10-29')).length, 2);
  for (const k of ['spy', 'qqq']) {
    const series = result.cache.benchmarks[k].series;
    assert.equal(series.find(p => p.d === '2026-10-30').div, 0.8, 'gross dividend remains gross');
    assert.equal(series.some(p => ['2026-10-31', '2026-11-01'].includes(p.d)), false);
    assert.deepEqual(series.slice(0, existing.benchmarks[k].series.length), existing.benchmarks[k].series);
  }
});

test('cloud SS range retains official holiday and catch-up limits without source access', async () => {
  const cache = ssCache(); for (const k of ['spy', 'qqq']) cache.benchmarks[k].series.at(-1).d = '2026-11-25';
  assert.deepEqual(await sharesightBenchmarkDates(cache, '2026-11-27'), ['2026-11-27']);
  for (const target of ['2026-11-26', '2026-11-28', '2026-12-07', '2026-11-24']) {
    await assert.rejects(sharesightBenchmarkDates(cache, target), /SS_BENCHMARK_/);
  }
  cache.benchmarks.qqq.series.at(-1).d = '2026-11-24';
  await assert.rejects(sharesightBenchmarkDates(cache, '2026-11-27'), /HISTORY/);
});

test('cloud SS full path authenticates once, reads four routes, signs one exact cache and saves verified bytes', async t => {
  const { path, bytes } = await offlineCache(t, ssCache()), http = ssHttp(), git = ssGithub(bytes);
  const result = await refreshSharesightCloud({ ...ssCloudArgs(path), fetchImpl: http.fetchImpl, githubRequest: git.request });
  assert.deepEqual(result, { changed: true, targetDate: '2026-10-30', sourceGets: 4, cacheCommit: SS_COMMIT });
  assert.equal(http.calls.length, 5); assert.equal(git.state.mutations, 1);
  assert.deepEqual(await readFile(path), git.state.afterBytes);
  const persisted = await readFile(path, 'utf8');
  assert.doesNotMatch(persisted, /canary|quantity|personal_net|holdingId/);
  const noRead = () => assert.fail('already-complete cache must neither authenticate nor write');
  assert.deepEqual(await refreshSharesightCloud({ ...ssCloudArgs(path), fetchImpl: noRead, githubRequest: noRead }),
    { changed: false, targetDate: '2026-10-30', sourceGets: 0, cacheCommit: null });
  assert.equal(await readFile(path, 'utf8'), persisted);
});

test('cloud SS shadow has no repository write or publishing token requirement', async t => {
  const { path } = await offlineCache(t, ssCache()), http = ssHttp();
  const result = await refreshSharesightCloud({ ...ssCloudArgs(path), mode: 'shadow', githubToken: undefined,
    fetchImpl: http.fetchImpl, githubRequest: () => assert.fail('shadow must not use repository identity') });
  assert.equal(result.changed, true); assert.equal(result.cacheCommit, null); assert.equal(http.calls.length, 5);
});

test('every source failure stops without retry, partial cache, or repository call', async t => {
  for (let failAt = 1; failAt <= 5; failAt++) {
    const { path, bytes } = await offlineCache(t, ssCache()), http = ssHttp({ failAt });
    await assert.rejects(refreshSharesightCloud({ ...ssCloudArgs(path), fetchImpl: http.fetchImpl,
      githubRequest: () => assert.fail('source failure must not write') }), /SS_BENCHMARK_(AUTH|NETWORK)/);
    assert.equal(http.calls.length, failAt); assert.equal(await readFile(path, 'utf8'), bytes);
  }
});

test('missing second ETF day cannot create a partial cloud cache', async t => {
  const { path, bytes } = await offlineCache(t, ssCache());
  const http = ssHttp({ change: (value, url) => { if (url.includes('/102?')) value.holding.values_over_time = []; } });
  await assert.rejects(refreshSharesightCloud({ ...ssCloudArgs(path), fetchImpl: http.fetchImpl,
    githubRequest: () => assert.fail('incomplete pair must not write') }), /TARGET_PENDING/);
  assert.equal(await readFile(path, 'utf8'), bytes);
});

test('main/cache conflicts refuse the mutation; ambiguous mutation is never repeated', async t => {
  for (const options of [{ refsChanged: true }, { uncertain: true }, {
    mutate: value => { if (value?.data?.repository) value.data.repository.cache.target.oid = 'd'.repeat(40); },
  }, { mutate: value => { if (value?.data?.repository) value.data.repository.file.oid = 'd'.repeat(40); } }]) {
    const { path, bytes } = await offlineCache(t, ssCache()), http = ssHttp(), git = ssGithub(bytes, options);
    await assert.rejects(refreshSharesightCloud({ ...ssCloudArgs(path), fetchImpl: http.fetchImpl, githubRequest: git.request }),
      /SS_BENCHMARK_(BASE_CHANGED|COMMIT_UNCERTAIN)/);
    assert.equal(git.state.mutations, options.uncertain ? 1 : 0); assert.equal(await readFile(path, 'utf8'), bytes);
  }
});

test('unsigned, wrong-parent, wrong-owner, extra-file or mismatching cache result cannot reach writer', async t => {
  for (const edit of [c => c.commit.verification.verified = false, c => c.parents[0].sha = SS_MAIN,
    c => c.author.login = 'other', c => c.files.push({ filename: 'data.json' }),
    c => c.files[0].sha = 'd'.repeat(40), c => c.files[0].filename = 'data.json']) {
    const { path, bytes } = await offlineCache(t, ssCache()), http = ssHttp();
    const git = ssGithub(bytes, { mutate: (value, url) => { if (url.includes('/commits/')) edit(value); } });
    await assert.rejects(refreshSharesightCloud({ ...ssCloudArgs(path), fetchImpl: http.fetchImpl, githubRequest: git.request }), /COMMIT_VERIFICATION/);
    assert.equal(git.state.mutations, 1); assert.equal(await readFile(path, 'utf8'), bytes);
  }
});

test('invalid bindings/mode fail before auth and error display uses a closed vocabulary', async t => {
  const { path } = await offlineCache(t, ssCache());
  for (const options of [{ mode: 'other' }, { expectedMain: 'short' }, { holdingIds: { spy: 101, qqq: 101 } }, { githubToken: '' }]) {
    await assert.rejects(refreshSharesightCloud({ ...ssCloudArgs(path), ...options, fetchImpl: () => assert.fail('invalid options must not authenticate') }));
  }
  for (const message of ['SS_BENCHMARK_AUTH secret-canary', 'SS_BENCHMARK_URL', 'https://private/?key=secret-canary', 'SS_BENCHMARK_AUTH\nsecret']) {
    assert.equal(sharesightBenchmarkFailureCode(Error(message)), 'SS_BENCHMARK_RESPONSE');
  }
  assert.equal(sharesightBenchmarkFailureCode(Error('SS_BENCHMARK_TIMEOUT')), 'SS_BENCHMARK_TIMEOUT');
});

test('actual SS CLI rejects malformed plans and extra arguments without credential access', () => {
  for (const args of [['--sharesight-cloud'], ['--sharesight-cloud', '--extra']]) {
    const result = spawnSync(process.execPath, [new URL('./refresh-benchmark-cache.mjs', import.meta.url).pathname, ...args],
      { encoding: 'utf8', env: { PATH: process.env.PATH, REPORT_PLAN: '{"priceThrough":"2026-10-30","secret":"canary"}' } });
    assert.equal(result.status, 1); assert.equal(result.stderr.trim(), 'SS_BENCHMARK_ARGUMENT'); assert.equal(result.stdout, '');
  }
});

test('SS cloud step stays in the same budgeted 15-minute source job and keeps public preflight secret-free', async () => {
  const workflow = await readFile(new URL('../.github/workflows/fee-cloud-producer.yml', import.meta.url), 'utf8');
  const gate = workflow.slice(workflow.indexOf('\n  period:'), workflow.indexOf('\n  produce:'));
  assert.doesNotMatch(gate, /secrets\.|sharesight_credentials|FEE_BENCHMARK/);
  const produce = workflow.slice(workflow.indexOf('\n  produce:'), workflow.indexOf('\n  source-plan:') > 0 ? workflow.indexOf('\n  source-plan:') : undefined);
  assert.match(produce, /name: Produce \$\{\{ needs.period.outputs.kind \}\} \$\{\{ needs.period.outputs.target \}\}/);
  assert.match(produce, /timeout-minutes: 15/); assert.match(produce, /github.run_attempt == 1/);
  const start = produce.indexOf('- name: Complete the frozen price cutoff from Sharesight');
  assert.ok(start > produce.indexOf('id: sharesight_credentials'));
  assert.ok(start < produce.indexOf('- name: Read, calculate and validate'));
  const step = produce.slice(start, produce.indexOf('- name: Read, calculate and validate'));
  assert.match(step, /--sharesight-cloud/); assert.match(step, /vars.FEE_CLOUD_MODE == 'publish' && secrets.FEE_CLOUD_GITHUB_TOKEN/);
  assert.doesNotMatch(step, /FEE_DATA_KEY|FEE_ECON_GIST_ID|keychain|nasdaq|workflow_dispatch/);
  assert.match(produce, /if: always\(\)/);
});

function epoch(iso) {
  return Math.floor(new Date(iso).getTime() / 1000);
}

function payload(definition, { timestamps = [], closes = [], adjusted = closes, dividends, meta = {} } = {}) {
  return {
    chart: {
      error: null,
      result: [{
        meta: {
          symbol: definition.symbol,
          currency: definition.currency,
          exchangeName: definition.exchangeNames[0],
          exchangeTimezoneName: definition.exchangeTimezoneName,
          instrumentType: 'ETF',
          ...meta,
        },
        timestamp: timestamps,
        indicators: { quote: [{ close: closes }], adjclose: [{ adjclose: adjusted }] },
        ...(dividends ? { events: { dividends } } : {}),
      }],
    },
  };
}

function nasdaqInfo(definition, { date = 'Sep 22, 2026', price, marketStatus = 'Closed', data = {} } = {}) {
  return {
    data: {
      symbol: definition.symbol,
      companyName: definition.nasdaqCompanyNames[0],
      exchange: definition.nasdaqExchangeNames[0],
      assetClass: 'ETF',
      marketStatus,
      primaryData: { lastSalePrice: `$${price}`, lastTradeTimestamp: date },
      ...data,
    },
    status: { rCode: 200 },
  };
}

function nasdaqDividends(rows = []) {
  return { data: { dividends: { rows } }, status: { rCode: 200 } };
}

function nasdaqHistorical(definition, rows = []) {
  return {
    data: { symbol: definition.symbol, tradesTable: { rows } },
    status: { rCode: 200 },
  };
}

test('accepts a completed, identity-verified daily close', () => {
  const day = epoch('2026-08-24T13:30:00Z');
  const result = extractPrices(payload(DEFINITIONS.qqq, {
    timestamps: [day], closes: [706.32],
  }), DEFINITIONS.qqq, new Date('2026-08-25T02:00:00Z'));
  assert.deepEqual(result, [{ d: '2026-08-24', p: 706.32 }]);
});

test('rejects an intraday quote pretending to be a daily close', () => {
  assert.throws(() => extractPrices(payload(DEFINITIONS.spy, {
    timestamps: [epoch('2026-08-24T13:30:00Z')], closes: [763.47],
  }), DEFINITIONS.spy, new Date('2026-08-24T18:10:00Z')), /No completed closes/);
});

test('validates the exact ETF identity and USD currency', () => {
  const wrong = payload(DEFINITIONS.spy, {
    timestamps: [epoch('2026-08-24T13:30:00Z')], closes: [763.47],
  });
  wrong.chart.result[0].meta.symbol = 'SPXL';
  assert.throws(() => extractPrices(wrong, DEFINITIONS.spy, new Date('2026-08-25T02:00:00Z')), /Unexpected symbol/);
});

test('rejects wrong currency, type, exchange, and timezone', () => {
  const day = epoch('2026-08-24T13:30:00Z');
  for (const [field, value, message] of [
    ['currency', 'CAD', /Unexpected currency/],
    ['instrumentType', 'EQUITY', /Unexpected instrument type/],
    ['exchangeName', 'LSE', /Unexpected exchange/],
    ['exchangeTimezoneName', 'Europe/London', /Unexpected timezone/],
  ]) {
    const wrong = payload(DEFINITIONS.spy, { timestamps: [day], closes: [763.47] });
    wrong.chart.result[0].meta[field] = value;
    assert.throws(() => extractPrices(wrong, DEFINITIONS.spy, new Date('2026-08-25T02:00:00Z')), message);
  }
});

/* 含息链的原料。adjclose 会回溯改写历史，data.json 每天只写一次、永不重述，
   所以除息金额必须和当日的原始收盘价一起存下来。 */
test('carries the cash dividend that went ex on that trading day', () => {
  const exDate = epoch('2026-09-18T13:30:00Z');
  const result = extractPrices(payload(DEFINITIONS.spy, {
    timestamps: [epoch('2026-09-17T13:30:00Z'), exDate],
    closes: [770.1, 768.4],
    adjusted: [770.1, 770.303516],
    dividends: { [exDate]: { amount: 1.903516, date: exDate } },
  }), DEFINITIONS.spy, new Date('2026-09-19T02:00:00Z'));
  assert.deepEqual(result, [
    { d: '2026-09-17', p: 770.1 },
    { d: '2026-09-18', p: 768.4, div: 1.9035 },
  ]);
});

test('fails closed when Yahoo omits or malforms a dividend event', () => {
  const d1 = epoch('2026-09-17T13:30:00Z'), d2 = epoch('2026-09-18T13:30:00Z');
  assert.throws(() => extractPrices(payload(DEFINITIONS.spy, {
    timestamps: [d1, d2], closes: [770.1, 768.4], adjusted: [770.1, 770.303516], dividends: {},
  }), DEFINITIONS.spy, new Date('2026-09-19T02:00:00Z')), /Dividend\/adjusted-close mismatch/);
  assert.throws(() => extractPrices(payload(DEFINITIONS.spy, {
    timestamps: [d1], closes: [770.1], dividends: { [d1]: { amount: 'bad', date: d1 } },
  }), DEFINITIONS.spy, new Date('2026-09-19T02:00:00Z')), /Malformed dividend event/);
});

test('leaves div off the days with no distribution', () => {
  const day = epoch('2026-08-24T13:30:00Z');
  const result = extractPrices(payload(DEFINITIONS.spy, {
    timestamps: [day], closes: [763.47], dividends: {},
  }), DEFINITIONS.spy, new Date('2026-08-25T02:00:00Z'));
  assert.deepEqual(result, [{ d: '2026-08-24', p: 763.47 }]);
});

test('ignores a dividend event just outside the requested chart boundary', () => {
  const outside = epoch('2026-06-22T13:30:00Z');
  const first = epoch('2026-06-23T13:30:00Z');
  const result = extractPrices(payload(DEFINITIONS.qqq, {
    timestamps: [first], closes: [700],
    dividends: { [outside]: { amount: 0.8, date: outside } },
  }), DEFINITIONS.qqq, new Date('2026-06-24T02:00:00Z'));
  assert.deepEqual(result, [{ d: '2026-06-23', p: 700 }]);
});

test('merges by date, replaces corrections, and preserves the last good cache', () => {
  const existing = {v:1,
    benchmarks: {
      spy: {symbol:'SPY',currency:'USD',exchange:'NYSEArca',series: [{ d: '2026-01-02', p: 700 }, { d: '2026-08-21', p: 765.72 }, { d: '2026-08-24', p: 760 }] },
      qqq: {symbol:'QQQ',currency:'USD',exchange:'NasdaqGS',series: [{ d: '2026-08-24', p: 706.32 }] },
    },
  };
  const merged = mergePrices(existing, {
    spy: [{ d: '2026-08-24', p: 763.47 }],
  }, new Date('2026-08-25T02:00:00Z'));
  assert.deepEqual(merged.benchmarks.spy.series, [
    { d: '2026-08-21', p: 765.72 },
    { d: '2026-08-24', p: 763.47 },
  ]);
  assert.deepEqual(merged.benchmarks.qqq.series, [{ d: '2026-08-24', p: 706.32 }]);
  assert.deepEqual(Object.keys(merged.benchmarks), ['spy', 'qqq']);
});

test('a merged correction keeps the dividend attached to its ex-date', () => {
  const existing = {v:1, benchmarks: {
    spy: {symbol:'SPY',currency:'USD',exchange:'NYSEArca',series: [{ d: '2026-09-18', p: 768.0, div: 1.9035 }] },
    qqq: {symbol:'QQQ',currency:'USD',exchange:'NasdaqGS',series: [{ d: '2026-09-18', p: 720.0 }] },
  } };
  const merged = mergePrices(existing, {
    spy: [{ d: '2026-09-18', p: 768.4, div: 1.9035 }],
  }, new Date('2026-09-19T02:00:00Z'));
  assert.deepEqual(merged.benchmarks.spy.series, [{ d: '2026-09-18', p: 768.4, div: 1.9035 }]);
});

test('a later price correction cannot silently erase a verified dividend', () => {
  const existing = {v:1, benchmarks: {
    spy: {symbol:'SPY',currency:'USD',exchange:'NYSEArca',series: [{ d: '2026-09-18', p: 768.0, div: 1.9035 }] },
    qqq: {symbol:'QQQ',currency:'USD',exchange:'NasdaqGS',series: [{ d: '2026-09-18', p: 720.0 }] },
  } };
  const merged = mergePrices(existing, {
    spy: [{ d: '2026-09-18', p: 768.4 }],
  }, new Date('2026-09-19T02:00:00Z'));
  assert.deepEqual(merged.benchmarks.spy.series, [{ d: '2026-09-18', p: 768.4, div: 1.9035 }]);
});

test('uses a Nasdaq close only when Yahoo meta independently agrees on date and price', () => {
  const prior = epoch('2026-09-21T13:30:00Z');
  const current = epoch('2026-09-22T20:00:00Z');
  const yahoo = payload(DEFINITIONS.spy, {
    timestamps: [prior], closes: [773.5],
    meta: { regularMarketTime: current, regularMarketPrice: 773.38 },
  });
  const result = appendCrossCheckedClose({
    yahooPayload: yahoo,
    nasdaqInfo: nasdaqInfo(DEFINITIONS.spy, { price: 773.38 }),
    nasdaqHistorical: nasdaqHistorical(DEFINITIONS.spy, [{ date: '09/22/2026', close: '773.38' }]),
    definition: DEFINITIONS.spy,
    now: new Date('2026-09-23T02:00:00Z'),
  });
  assert.deepEqual(result, [
    { d: '2026-09-21', p: 773.5 },
    { d: '2026-09-22', p: 773.38 },
  ]);
});

test('rejects a mismatched fallback date or close', () => {
  const prior = epoch('2026-09-21T13:30:00Z');
  const current = epoch('2026-09-22T20:00:00Z');
  const yahoo = payload(DEFINITIONS.spy, {
    timestamps: [prior], closes: [773.5],
    meta: { regularMarketTime: current, regularMarketPrice: 773.38 },
  });
  const options = { yahooPayload: yahoo, definition: DEFINITIONS.spy, now: new Date('2026-09-23T02:00:00Z') };
  assert.throws(() => appendCrossCheckedClose({
    ...options,
    nasdaqInfo: nasdaqInfo(DEFINITIONS.spy, { date: 'Sep 21, 2026', price: 773.38 }),
    nasdaqHistorical: nasdaqHistorical(DEFINITIONS.spy, [{ date: '09/22/2026', close: '773.38' }]),
  }), /date mismatch/);
  assert.throws(() => appendCrossCheckedClose({
    ...options,
    nasdaqInfo: nasdaqInfo(DEFINITIONS.spy, { price: 773.40 }),
    nasdaqHistorical: nasdaqHistorical(DEFINITIONS.spy, [{ date: '09/22/2026', close: '773.38' }]),
  }), /price mismatch/);
});

test('Nasdaq identity and closed-session gates fail closed', () => {
  const good = nasdaqInfo(DEFINITIONS.qqq, { price: 747.46 });
  assert.deepEqual(extractNasdaqClose(good, DEFINITIONS.qqq, new Date('2026-09-23T02:00:00Z')),
    { d: '2026-09-22', p: 747.46 });
  assert.throws(() => extractNasdaqClose(nasdaqInfo(DEFINITIONS.qqq, {
    price: 747.46, data: { symbol: 'TQQQ' },
  }), DEFINITIONS.qqq, new Date('2026-09-23T02:00:00Z')), /Unexpected Nasdaq symbol/);
  assert.throws(() => extractNasdaqClose(nasdaqInfo(DEFINITIONS.qqq, {
    price: 747.46, marketStatus: 'Open',
  }), DEFINITIONS.qqq, new Date('2026-09-23T02:00:00Z')), /not closed/);
});

test('Nasdaq historical close accepts only completed, symbol-matched rows', () => {
  const good = nasdaqHistorical(DEFINITIONS.qqq, [
    { date: '09/21/2026', close: '741.47' },
    { date: '09/22/2026', close: '$747.46' },
  ]);
  assert.deepEqual(
    extractNasdaqHistoricalClose(good, DEFINITIONS.qqq, new Date('2026-09-23T02:00:00Z')),
    { d: '2026-09-22', p: 747.46 },
  );
  const wrong = nasdaqHistorical(DEFINITIONS.qqq, [{ date: '09/22/2026', close: '747.46' }]);
  wrong.data.symbol = 'TQQQ';
  assert.throws(() => extractNasdaqHistoricalClose(
    wrong, DEFINITIONS.qqq, new Date('2026-09-23T02:00:00Z'),
  ), /Unexpected Nasdaq historical symbol/);
});

test('uses dual Nasdaq completed-close evidence when Yahoo meta is one session behind', () => {
  const prior = epoch('2026-09-23T13:30:00Z');
  const yahoo = payload(DEFINITIONS.spy, {
    timestamps: [prior], closes: [767.81],
    meta: { regularMarketTime: prior, regularMarketPrice: 767.81 },
  });
  const result = appendCrossCheckedClose({
    yahooPayload: yahoo,
    nasdaqInfo: nasdaqInfo(DEFINITIONS.spy, { date: 'Sep 24, 2026', price: 767.18 }),
    nasdaqHistorical: nasdaqHistorical(DEFINITIONS.spy, [{ date: '09/24/2026', close: '767.18' }]),
    definition: DEFINITIONS.spy,
    now: new Date('2026-09-25T08:00:00Z'),
  });
  assert.deepEqual(result.at(-1), { d: '2026-09-24', p: 767.18 });
});

test('uses dual Nasdaq completed-close evidence when Yahoo meta is unavailable', () => {
  const prior = epoch('2026-09-23T13:30:00Z');
  const yahoo = payload(DEFINITIONS.qqq, {
    timestamps: [prior], closes: [741.21], meta: {},
  });
  const result = appendCrossCheckedClose({
    yahooPayload: yahoo,
    nasdaqInfo: nasdaqInfo(DEFINITIONS.qqq, { date: 'Sep 24, 2026', price: 741.10 }),
    nasdaqHistorical: nasdaqHistorical(DEFINITIONS.qqq, [{ date: '09/24/2026', close: '741.10' }]),
    nasdaqDividends: nasdaqDividends([]),
    definition: DEFINITIONS.qqq,
    now: new Date('2026-09-25T08:00:00Z'),
  });
  assert.deepEqual(result.at(-1), { d: '2026-09-24', p: 741.1 });
});

test('QQQ fallback uses Nasdaq dividend evidence and validates Yahoo if both report it', () => {
  const prior = epoch('2026-09-18T13:30:00Z');
  const current = epoch('2026-09-21T20:00:00Z');
  const yahoo = payload(DEFINITIONS.qqq, {
    timestamps: [prior], closes: [721.45],
    meta: { regularMarketTime: current, regularMarketPrice: 741.47 },
  });
  const dividends = nasdaqDividends([{
    exOrEffDate: '09/21/2026', type: 'Cash', amount: '$0.75143', currency: 'USD',
  }]);
  assert.equal(extractNasdaqDividends(dividends, DEFINITIONS.qqq).get('2026-09-21'), 0.7514);
  const result = appendCrossCheckedClose({
    yahooPayload: yahoo,
    nasdaqInfo: nasdaqInfo(DEFINITIONS.qqq, { date: 'Sep 21, 2026', price: 741.47 }),
    nasdaqHistorical: nasdaqHistorical(DEFINITIONS.qqq, [{ date: '09/21/2026', close: '741.47' }]),
    nasdaqDividends: dividends,
    definition: DEFINITIONS.qqq,
    now: new Date('2026-09-22T02:00:00Z'),
  });
  assert.deepEqual(result.at(-1), { d: '2026-09-21', p: 741.47, div: 0.7514 });
});

test('SPY fallback refuses an uncovered year or a scheduled ex-date without an amount', () => {
  const prior = epoch('2026-09-17T13:30:00Z');
  const exDate = epoch('2026-09-18T20:00:00Z');
  const yahoo = payload(DEFINITIONS.spy, {
    timestamps: [prior], closes: [762.6],
    meta: { regularMarketTime: exDate, regularMarketPrice: 761.69 },
  });
  assert.throws(() => appendCrossCheckedClose({
    yahooPayload: yahoo,
    nasdaqInfo: nasdaqInfo(DEFINITIONS.spy, { date: 'Sep 18, 2026', price: 761.69 }),
    nasdaqHistorical: nasdaqHistorical(DEFINITIONS.spy, [{ date: '09/18/2026', close: '761.69' }]),
    definition: DEFINITIONS.spy,
    now: new Date('2026-09-19T02:00:00Z'),
  }), /Dividend amount missing/);

  const future = payload(DEFINITIONS.spy, {
    timestamps: [epoch('2027-01-04T14:30:00Z')], closes: [800],
    meta: { regularMarketTime: epoch('2027-01-05T21:00:00Z'), regularMarketPrice: 801 },
  });
  assert.throws(() => appendCrossCheckedClose({
    yahooPayload: future,
    nasdaqInfo: nasdaqInfo(DEFINITIONS.spy, { date: 'Jan 5, 2027', price: 801 }),
    nasdaqHistorical: nasdaqHistorical(DEFINITIONS.spy, [{ date: '01/05/2027', close: '801' }]),
    definition: DEFINITIONS.spy,
    now: new Date('2027-01-06T02:00:00Z'),
  }), /calendar coverage missing/);
});

test('merge source truthfully describes Nasdaq updates and retained legacy history', () => {
  const existing = {v:1, benchmarks: {
    spy: {symbol:'SPY',currency:'USD',exchange:'NYSEArca',series: [{ d: '2026-09-21', p: 773.5 }] },
    qqq: {symbol:'QQQ',currency:'USD',exchange:'NasdaqGS',series: [{ d: '2026-09-21', p: 741.47, div: 0.751 }] },
  } };
  const merged = mergePrices(existing, {
    spy: [{ d: '2026-09-22', p: 773.38 }],
    qqq: [{ d: '2026-09-22', p: 747.46 }],
  }, new Date('2026-09-23T02:00:00Z'));
  assert.match(merged.source, /Nasdaq historical daily closes and cash dividends/);
  assert.match(merged.source, /retained legacy cache history/);
  assert.doesNotMatch(merged.source, /cross-check|official quote/);
  assert.equal(merged.benchmarks.spy.series.at(-1).d, merged.benchmarks.qqq.series.at(-1).d);
});

const RECOVERY_NOW = new Date('2026-10-15T00:21:31Z');
const RECOVERY_PRIOR = epoch('2026-10-13T13:30:00Z');
const RECOVERY_CLOSE = epoch('2026-10-14T20:00:00Z');

function recoveryOptions(definition = DEFINITIONS.spy, overrides = {}) {
  return {
    yahooPayload: payload(definition, {
      timestamps: [RECOVERY_PRIOR], closes: [100],
      meta: { regularMarketTime: RECOVERY_CLOSE, regularMarketPrice: 103 },
    }),
    nasdaqInfo: nasdaqInfo(definition, {
      date: 'Oct 14, 2026', price: 999, marketStatus: 'After-Hours',
    }),
    nasdaqHistorical: nasdaqHistorical(definition, [{ date: '10/14/2026', close: '103' }]),
    nasdaqDividends: nasdaqDividends(), definition, now: RECOVERY_NOW, ...overrides,
  };
}

test('historical fallback ignores extended-session prices and retains strict quote extraction', () => {
  const options = recoveryOptions();
  assert.throws(() => extractNasdaqClose(options.nasdaqInfo, DEFINITIONS.spy, RECOVERY_NOW), /not closed/);
  assert.deepEqual(appendCrossCheckedClose(options).at(-1), { d: '2026-10-14', p: 103 });
  assert.notEqual(appendCrossCheckedClose(options).at(-1).p, 999);
});

test('unknown current market status grants no price authority', () => {
  const info = nasdaqInfo(DEFINITIONS.spy, {
    marketStatus: 'unknown-provider-state', price: 999, date: 'Oct 14, 2026',
  });
  assert.deepEqual(appendCrossCheckedClose(recoveryOptions(DEFINITIONS.spy, { nasdaqInfo: info })).at(-1),
    { d: '2026-10-14', p: 103 });
  assert.throws(() => appendCrossCheckedClose(recoveryOptions(DEFINITIONS.spy, {
    nasdaqInfo: info,
    yahooPayload: payload(DEFINITIONS.spy, { timestamps: [RECOVERY_PRIOR], closes: [100] }),
  })), /needs same-date Yahoo regular-market evidence/);
});

test('non-Closed fallback rejects stale dates, mismatched values, and incomplete sessions', () => {
  const stale = payload(DEFINITIONS.spy, {
    timestamps: [RECOVERY_PRIOR], closes: [100],
    meta: { regularMarketTime: RECOVERY_PRIOR, regularMarketPrice: 100 },
  });
  assert.throws(() => appendCrossCheckedClose(recoveryOptions(DEFINITIONS.spy, { yahooPayload: stale })), /same-date/);
  const mismatch = payload(DEFINITIONS.spy, {
    timestamps: [RECOVERY_PRIOR], closes: [100],
    meta: { regularMarketTime: RECOVERY_CLOSE, regularMarketPrice: 104 },
  });
  assert.throws(() => appendCrossCheckedClose(recoveryOptions(DEFINITIONS.spy, { yahooPayload: mismatch })), /price mismatch/);
  assert.throws(() => appendCrossCheckedClose(recoveryOptions(DEFINITIONS.spy, {
    now: new Date('2026-10-14T20:14:59Z'),
  })), /No completed Nasdaq historical close/);
});

test('historical fallback preserves symbol, listing, issuer and dividend verification', () => {
  for (const data of [{ symbol: 'TQQQ' }, { assetClass: 'STOCK' }, { exchange: 'OTHER' }, { companyName: 'Other issuer' }]) {
    assert.throws(() => appendCrossCheckedClose(recoveryOptions(DEFINITIONS.spy, {
      nasdaqInfo: nasdaqInfo(DEFINITIONS.spy, { marketStatus: 'After-Hours', price: 999, data }),
    })), /Unexpected Nasdaq/);
  }
  const qqq = recoveryOptions(DEFINITIONS.qqq, {
    nasdaqDividends: nasdaqDividends([{ exOrEffDate: '10/14/2026', amount: '$0.75', currency: 'USD', type: 'Cash' }]),
  });
  assert.deepEqual(appendCrossCheckedClose(qqq).at(-1), { d: '2026-10-14', p: 103, div: 0.75 });
  const bad = nasdaqDividends([{ exOrEffDate: '10/14/2026', amount: '$0.75', currency: 'HKD', type: 'Cash' }]);
  assert.throws(() => appendCrossCheckedClose({ ...qqq, nasdaqDividends: bad }), /Unexpected Nasdaq dividend/);
});

test('expected target uses the fee NY boundary across DST and weekends without inferring holidays', () => {
  for (const [time, target] of [
    ['2026-10-14T20:14:59Z', '2026-10-13'], ['2026-10-14T20:15:00Z', '2026-10-14'],
    ['2026-11-05T21:14:59Z', '2026-11-04'], ['2026-11-05T21:15:00Z', '2026-11-05'],
    ['2026-10-18T14:00:00Z', '2026-10-16'], ['2026-10-19T18:00:00Z', '2026-10-16'],
    ['2026-11-27T02:00:00Z', '2026-11-26'],
  ]) assert.equal(expectedBenchmarkTargetDate(new Date(time)), target);
  assert.throws(() => expectedBenchmarkTargetDate(new Date('invalid')), /Invalid benchmark clock/);
});

function recoveryFetch({ staleHistorical = false, failedSymbol, failAll = false, missingDividends = false, marketStatus = 'After-Hours' } = {}) {
  const calls = [];
  const fetchImpl = async url => {
    calls.push(url);
    const parsed = new URL(url);
    const symbol = /(?:chart|quote)\/(SPY|QQQ)/.exec(parsed.pathname)?.[1];
    assert.ok(symbol, `Unexpected offline request ${url}`);
    if (failAll || symbol === failedSymbol) return { ok: false, status: 503 };
    const definition = DEFINITIONS[symbol.toLowerCase()];
    let body;
    assert.equal(parsed.hostname, 'api.nasdaq.com', 'refresh must use only Nasdaq');
    if (parsed.pathname.endsWith('/info')) {
      body = nasdaqInfo(definition, { date: 'invalid quote date', price: 999, marketStatus });
    } else if (parsed.pathname.endsWith('/historical')) {
      assert.equal(parsed.searchParams.get('todate'), '2026-10-14');
      body = nasdaqHistorical(definition, [
        ...(!staleHistorical ? [{ date: '10/14/2026', close: '103' }] : []),
        { date: '10/13/2026', close: '100' },
      ]);
    } else if (parsed.pathname.endsWith('/dividends')) body = missingDividends ? {} : nasdaqDividends();
    else assert.fail(`Unexpected offline request ${url}`);
    return { ok: true, status: 200, json: async () => body };
  };
  return { calls, fetchImpl };
}

async function offlineCache(t, cache) {
  const directory = await mkdtemp(join(tmpdir(), 'fee-benchmark-offline-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'benchmark-close.json');
  const bytes = `${JSON.stringify(cache)}\n  `;
  await writeFile(path, bytes);
  return { path, bytes };
}

function priorCache() {
  return mergePrices(null, { spy: [{ d: '2026-10-13', p: 100 }], qqq: [{ d: '2026-10-13', p: 100 }] }, RECOVERY_NOW);
}

test('full refresh recovers two target rows from historical data while ignoring after-hours quotes', async t => {
  const { path } = await offlineCache(t, priorCache());
  const source = recoveryFetch();
  const result = await refresh({ path, now: RECOVERY_NOW, fetchImpl: source.fetchImpl });
  assert.equal(result.changed, true);
  for (const key of ['spy', 'qqq']) assert.deepEqual(result.cache.benchmarks[key].series.at(-1), { d: '2026-10-14', p: 103 });
  assert.ok(source.calls.some(url => url.includes('/historical?')));
  assert.equal(source.calls.filter(url => url.includes('/dividends?')).length, 2);
  assert.equal(source.calls.length, 6);
  assert.ok(source.calls.every(url => new URL(url).hostname === 'api.nasdaq.com'));
  const persisted = JSON.parse(await readFile(path, 'utf8'));
  assert.deepEqual(persisted, result.cache);
});

test('refresh ignores every current Nasdaq status and never queries Yahoo', async t => {
  for (const marketStatus of ['Closed', 'After-Hours', 'Pre-Market', 'Open', 'unknown-provider-state', undefined]) {
    const { path } = await offlineCache(t, priorCache());
    const source = recoveryFetch({ marketStatus });
    const result = await refresh({ path, now: RECOVERY_NOW, fetchImpl: source.fetchImpl });
    assert.equal(result.cache.benchmarks.spy.series.at(-1).p, 103);
    assert.equal(source.calls.length, 6);
    assert.ok(source.calls.every(url => new URL(url).hostname === 'api.nasdaq.com'));
  }
});

test('stale historical rows stay pending without consulting Yahoo or live prices', async t => {
  const { path, bytes } = await offlineCache(t, priorCache());
  const source = recoveryFetch({ staleHistorical: true });
  await assert.rejects(refresh({ path, now: RECOVERY_NOW, fetchImpl: source.fetchImpl }), /target pending/);
  assert.equal(await readFile(path, 'utf8'), bytes);
  assert.equal(source.calls.length, 6);
});

test('regular-market metadata timestamp is a witness; only historical daily close supplies the appended price', () => {
  for (const stamp of ['2026-10-14T13:30:00Z', '2026-10-14T19:00:00Z', '2026-10-14T22:00:00Z']) {
    const yahooPayload = payload(DEFINITIONS.spy, {
      timestamps: [RECOVERY_PRIOR], closes: [100],
      meta: { regularMarketTime: epoch(stamp), regularMarketPrice: 103 },
    });
    const options = {
      yahooPayload, definition: DEFINITIONS.spy, now: RECOVERY_NOW,
      nasdaqInfo: nasdaqInfo(DEFINITIONS.spy, { date: 'Oct 14, 2026', price: 999, marketStatus: 'After-Hours' }),
      nasdaqHistorical: nasdaqHistorical(DEFINITIONS.spy, [{ date: '10/14/2026', close: '103' }]),
    };
    assert.deepEqual(appendCrossCheckedClose(options).at(-1), { d: '2026-10-14', p: 103 });
    yahooPayload.chart.result[0].meta.regularMarketPrice = 100;
    assert.throws(() => appendCrossCheckedClose(options), /historical close price mismatch/);
  }
});

test('all source failures cannot report success or rewrite old cache bytes', async t => {
  const { path, bytes } = await offlineCache(t, priorCache());
  const source = recoveryFetch({ failAll: true });
  await assert.rejects(refresh({ path, now: RECOVERY_NOW, fetchImpl: source.fetchImpl }), /target pending: expected=2026-10-14/);
  assert.equal(await readFile(path, 'utf8'), bytes);
  assert.equal(source.calls.length, 2);
});

test('one fresh ETF and one stale ETF cannot partially write the cache', async t => {
  const { path, bytes } = await offlineCache(t, priorCache());
  const source = recoveryFetch({ failedSymbol: 'QQQ' });
  await assert.rejects(refresh({ path, now: RECOVERY_NOW, fetchImpl: source.fetchImpl }), /latest-date mismatch/);
  assert.equal(await readFile(path, 'utf8'), bytes);
});

test('missing dividend evidence stays pending and cannot rewrite old cache bytes', async t => {
  const { path, bytes } = await offlineCache(t, priorCache());
  const source = recoveryFetch({ missingDividends: true });
  await assert.rejects(refresh({ path, now: RECOVERY_NOW, fetchImpl: source.fetchImpl }), /target pending/);
  assert.equal(await readFile(path, 'utf8'), bytes);
});

test('successful target reuse is a byte-identical no-op', async t => {
  const cache = mergePrices(null, { spy: [{ d: '2026-10-14', p: 103 }], qqq: [{ d: '2026-10-14', p: 103 }] }, RECOVERY_NOW);
  const { path, bytes } = await offlineCache(t, cache);
  const source = recoveryFetch();
  const result = await refresh({ path, now: RECOVERY_NOW, fetchImpl: source.fetchImpl });
  assert.equal(result.changed, false);
  assert.equal(await readFile(path, 'utf8'), bytes);
});

test('Nasdaq historical refresh uses only the six existing same-source endpoints',async t=>{
  const {path}=await offlineCache(t,priorCache()),calls=[];
  const fetchImpl=async url=>{calls.push(url);const u=new URL(url),symbol=/quote\/(SPY|QQQ)/.exec(u.pathname)?.[1];if(u.hostname.endsWith('yahoo.com'))return {ok:false,status:503};const def=DEFINITIONS[symbol.toLowerCase()];
    const body=u.pathname.endsWith('/info')?nasdaqInfo(def,{date:'Oct 14, 2026',price:103}):u.pathname.endsWith('/historical')?nasdaqHistorical(def,[{date:'10/14/2026',close:'103'},{date:'10/13/2026',close:'100'}]):nasdaqDividends();return {ok:true,json:async()=>body};};
  const r=await refresh({path,now:RECOVERY_NOW,fetchImpl});for(const key of ['spy','qqq'])assert.equal(r.cache.benchmarks[key].series.at(-1).p,103);
  assert.equal(calls.length,6);assert.equal(calls.filter(u=>u.startsWith('https://api.nasdaq.com/')).length,6);
});
test('Nasdaq historical path preserves identity, USD, continuity and dividend boundaries',()=>{
  const definition=DEFINITIONS.spy,base={prior:priorCache().benchmarks.spy,definition,nasdaqInfo:nasdaqInfo(definition,{date:'Oct 14, 2026',price:103}),nasdaqHistorical:nasdaqHistorical(definition,[{date:'10/14/2026',close:'103'},{date:'10/13/2026',close:'100'}]),nasdaqDividends:nasdaqDividends(),now:RECOVERY_NOW};
  for(const edit of [x=>x.prior.symbol='SP500',x=>x.prior.currency='EUR',x=>x.prior.series[0].p=99,x=>x.nasdaqInfo.data.symbol='QQQ',x=>x.nasdaqInfo.data.assetClass='STOCK',x=>x.nasdaqInfo.data.exchange='OTHER',x=>x.nasdaqInfo.data.companyName='OTHER',x=>x.nasdaqDividends={},x=>x.nasdaqHistorical.data.tradesTable.rows.pop(),x=>x.nasdaqHistorical.data.symbol='QQQ',x=>x.nasdaqHistorical.data.tradesTable.rows[0].close='0',x=>x.nasdaqHistorical.data.tradesTable.rows[0].close='€103',x=>x.nasdaqHistorical.data.tradesTable.rows[0].date='10/15/2026',x=>x.nasdaqHistorical.data.tradesTable.rows.push({...x.nasdaqHistorical.data.tradesTable.rows[0]})]){const x=structuredClone(base);edit(x);assert.throws(()=>appendIndependentNasdaqClose(x));}
  const ex={...base,now:new Date('2026-09-19T02:00:00Z'),prior:{...base.prior,series:[{d:'2026-09-17',p:100}]},nasdaqInfo:nasdaqInfo(definition,{date:'Sep 18, 2026',price:101}),nasdaqHistorical:nasdaqHistorical(definition,[{date:'09/18/2026',close:'101'},{date:'09/17/2026',close:'100'}])};
  assert.throws(()=>appendIndependentNasdaqClose(ex),/dividend/);
  ex.nasdaqDividends=nasdaqDividends([{exOrEffDate:'09/18/2026',currency:'USD',type:'Cash',amount:'1.25'}]);assert.deepEqual(appendIndependentNasdaqClose(ex).at(-1),{d:'2026-09-18',p:101,div:1.25});
});

test('refresh rejects unverified old-cache identity before any request or cache rewrite',async t=>{
  const cache=priorCache();cache.benchmarks.spy.symbol='SP500';const {path,bytes}=await offlineCache(t,cache);
  await assert.rejects(refresh({path,now:RECOVERY_NOW,fetchImpl:()=>assert.fail('invalid cache must not request a source')}),/cache identity/);assert.equal(await readFile(path,'utf8'),bytes);
});


test('historical-only authority never reads current quote state, time or prices', () => {
  const definition = DEFINITIONS.spy;
  const info = nasdaqInfo(definition);
  for (const key of ['marketStatus', 'primaryData', 'secondaryData']) {
    Object.defineProperty(info.data, key, { get() { assert.fail(`live quote field ${key} was read`); } });
  }
  const result = appendIndependentNasdaqClose({
    prior: priorCache().benchmarks.spy, definition, nasdaqInfo: info,
    nasdaqHistorical: nasdaqHistorical(definition, [{ date: '10/14/2026', close: '$103.25' }, { date: '10/13/2026', close: '$100' }]),
    nasdaqDividends: nasdaqDividends(), now: RECOVERY_NOW,
  });
  assert.deepEqual(result.at(-1), { d: '2026-10-14', p: 103.25 });
});

test('target 29 uses dated historical closes, keeps dividend total return and is repeatable', async t => {
  const now = new Date('2026-10-30T00:02:35Z');
  const cache = mergePrices(null, {
    spy: [{ d: '2026-10-28', p: 100 }], qqq: [{ d: '2026-10-28', p: 200 }],
  }, now);
  cache.source = 'legacy Yahoo verified history';
  const { path } = await offlineCache(t, cache);
  const calls = [];
  const fetchImpl = async url => {
    calls.push(url);
    const u = new URL(url);
    assert.equal(u.hostname, 'api.nasdaq.com');
    const symbol = /quote\/(SPY|QQQ)/.exec(u.pathname)?.[1];
    const definition = DEFINITIONS[symbol?.toLowerCase()];
    assert.ok(definition);
    let body;
    if (u.pathname.endsWith('/info')) body = nasdaqInfo(definition, { marketStatus: 'After-Hours', price: 999 });
    else if (u.pathname.endsWith('/historical')) {
      assert.equal(u.searchParams.get('todate'), '2026-10-29');
      body = nasdaqHistorical(definition, [{ date: '10/29/2026', close: symbol === 'SPY' ? '$101' : '$203' }, { date: '10/28/2026', close: symbol === 'SPY' ? '$100' : '$200' }]);
    } else if (u.pathname.endsWith('/dividends')) body = nasdaqDividends(symbol === 'QQQ' ? [{ exOrEffDate: '10/29/2026', amount: '$0.75', currency: 'USD', type: 'Cash' }] : []);
    else assert.fail(url);
    return { ok: true, json: async () => body };
  };
  const first = await refresh({ path, now, fetchImpl });
  assert.equal(first.changed, true);
  assert.deepEqual(first.cache.benchmarks.spy.series.at(-1), { d: '2026-10-29', p: 101 });
  assert.deepEqual(first.cache.benchmarks.qqq.series.at(-1), { d: '2026-10-29', p: 203, div: 0.75 });
  assert.match(first.cache.source, /retained legacy cache history/);
  const bytes = await readFile(path, 'utf8');
  const second = await refresh({ path, now: new Date('2026-10-30T00:30:00Z'), fetchImpl });
  assert.equal(second.changed, false);
  assert.equal(await readFile(path, 'utf8'), bytes);
  assert.equal(calls.length, 12);
});


test('failed refresh does not relabel an already-current legacy cache as a new source', async t => {
  const cache = mergePrices(null, { spy: [{ d: '2026-10-14', p: 103 }], qqq: [{ d: '2026-10-14', p: 103 }] }, RECOVERY_NOW);
  cache.source = 'legacy verified source';
  const { path, bytes } = await offlineCache(t, cache);
  const source = recoveryFetch({ failAll: true });
  await assert.rejects(refresh({ path, now: RECOVERY_NOW, fetchImpl: source.fetchImpl }), /source pending/);
  assert.equal(await readFile(path, 'utf8'), bytes);
});


test('same-target cache cannot hide one failed ETF while publishing the other correction', async t => {
  for (const failedSymbol of ['SPY', 'QQQ']) {
    const cache = mergePrices(null, { spy: [{ d: '2026-10-14', p: 100 }], qqq: [{ d: '2026-10-14', p: 100 }] }, RECOVERY_NOW);
    const { path, bytes } = await offlineCache(t, cache);
    const source = recoveryFetch({ failedSymbol });
    await assert.rejects(refresh({ path, now: RECOVERY_NOW, fetchImpl: source.fetchImpl }), /source pending/);
    assert.equal(await readFile(path, 'utf8'), bytes);
  }
});

test('same-target cache cannot mask missing dividend evidence during a correction', async t => {
  const cache = mergePrices(null, { spy: [{ d: '2026-10-14', p: 100 }], qqq: [{ d: '2026-10-14', p: 100 }] }, RECOVERY_NOW);
  const { path, bytes } = await offlineCache(t, cache);
  const source = recoveryFetch();
  const fetchImpl = url => url.includes('/QQQ/dividends?')
    ? Promise.resolve({ ok: true, json: async () => ({}) }) : source.fetchImpl(url);
  await assert.rejects(refresh({ path, now: RECOVERY_NOW, fetchImpl }), /source pending/);
  assert.equal(await readFile(path, 'utf8'), bytes);
});

test('explicit numeric zero dividends in retained and incoming rows normalize to absence', () => {
  const existing = priorCache();
  for (const key of ['spy', 'qqq']) existing.benchmarks[key].series[0].div = 0;
  const merged = mergePrices(existing, {
    spy: [{ d: '2026-10-14', p: 103, div: 0 }],
    qqq: [{ d: '2026-10-14', p: 103, div: -0 }],
  }, RECOVERY_NOW);
  for (const key of ['spy', 'qqq']) {
    assert.equal(merged.benchmarks[key].series.length, 2);
    for (const row of merged.benchmarks[key].series) assert.equal(Object.hasOwn(row, 'div'), false);
  }
});

test('invalid dividends cannot become zero in retained or incoming cache rows', () => {
  for (const div of [-0.01, NaN, Infinity, -Infinity, null, '', '0', false, {}]) {
    const existing = priorCache();
    existing.benchmarks.spy.series[0].div = div;
    assert.throws(() => mergePrices(existing, {}, RECOVERY_NOW), /Malformed benchmark dividend/);
    assert.throws(() => mergePrices(priorCache(), {
      spy: [{ d: '2026-10-14', p: 103, div }],
    }, RECOVERY_NOW), /Malformed benchmark dividend/);
  }
});

test('zero correction never erases a verified positive gross dividend', () => {
  const existing = priorCache();
  existing.benchmarks.spy.series[0].div = 0.75;
  const merged = mergePrices(existing, {
    spy: [{ d: '2026-10-13', p: 101, div: 0 }],
    qqq: [{ d: '2026-10-14', p: 103, div: 0.5 }],
  }, RECOVERY_NOW);
  assert.deepEqual(merged.benchmarks.spy.series[0], { d: '2026-10-13', p: 101, div: 0.75 });
  assert.deepEqual(merged.benchmarks.qqq.series.at(-1), { d: '2026-10-14', p: 103, div: 0.5 });
});

test('full refresh accepts explicit zero history and is byte-idempotent after normalization', async t => {
  const existing = priorCache();
  for (const key of ['spy', 'qqq']) existing.benchmarks[key].series[0].div = 0;
  const { path } = await offlineCache(t, existing);
  const source = recoveryFetch();
  const first = await refresh({ path, now: RECOVERY_NOW, fetchImpl: source.fetchImpl });
  assert.equal(first.changed, true);
  for (const key of ['spy', 'qqq']) for (const row of first.cache.benchmarks[key].series) {
    assert.equal(Object.hasOwn(row, 'div'), false);
  }
  const bytes = await readFile(path, 'utf8');
  const second = await refresh({ path, now: RECOVERY_NOW, fetchImpl: source.fetchImpl });
  assert.equal(second.changed, false);
  assert.equal(await readFile(path, 'utf8'), bytes);
});

test('zero history never hides a failed source or causes a partial cache rewrite', async t => {
  for (const failedSymbol of ['SPY', 'QQQ']) {
    const existing = priorCache();
    for (const key of ['spy', 'qqq']) existing.benchmarks[key].series[0].div = 0;
    const { path, bytes } = await offlineCache(t, existing);
    const source = recoveryFetch({ failedSymbol });
    await assert.rejects(refresh({ path, now: RECOVERY_NOW, fetchImpl: source.fetchImpl }), /Benchmark latest-date mismatch/);
    assert.equal(await readFile(path, 'utf8'), bytes);
  }
});
