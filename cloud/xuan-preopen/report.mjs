// A private report acceptance job: no GitHub mutation or schedule activation.
import crypto from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {captureCloudIbAction} from './ib_mcp.mjs';
import {boundedText, privateCloudIo} from './cloud_io.mjs';
import {buildNightActionModel} from '../../scripts/xuan-ib-night-action-model.mjs';
import {renderNightActionReport} from '../../scripts/xuan-ib-night-action-view.mjs';
import {validateNightActionHtml} from '../../scripts/xuan-ib-night-action-guard.mjs';
import {ASSOCIATION_POLICY_PATH, validateAssociationSnapshot,
  createAssociationReceipt, validateAssociationReceipt} from '../../scripts/xuan-ib-account-association.mjs';

const GATEWAY = 'https://family-portfolio-gateway-6ikas4b3ma-df.a.run.app';
const REPO = 'https://api.github.com/repos/huanwujoy-crypto/fee-console';
const RAW = 'https://raw.githubusercontent.com/huanwujoy-crypto/fee-console';
const SHA = /^[a-f0-9]{40}$/;
const hash = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const gitBlob = text => { const bytes = Buffer.from(text); return crypto.createHash('sha1').update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest('hex'); };
const dateHkt = now => new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Hong_Kong', year: 'numeric', month: '2-digit', day: '2-digit'}).format(new Date(now));
const timeHkt = now => new Date(now + 8 * 3_600_000).toISOString().slice(11, 16);
const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value || '') && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
  && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

async function read(url, {fetchImpl = fetch, headers = {}} = {}) {
  let response;
  try { response = await fetchImpl(url, {headers, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(30_000)}); }
  catch { throw new Error('REPORT_SOURCE_NETWORK_FAILED'); }
  if (!response.ok) throw new Error(`REPORT_SOURCE_HTTP_${response.status}`);
  return boundedText(response);
}
const json = text => { try { return JSON.parse(text); } catch { throw new Error('REPORT_SOURCE_JSON_INVALID'); } };

export async function loadTrustedContext({fetchImpl = fetch, now = Date.now} = {}) {
  const commit = json(await read(`${REPO}/commits/main`, {fetchImpl, headers: {'User-Agent': 'xuan-preopen-readonly'}})).sha;
  if (!SHA.test(commit || '')) throw new Error('TRUSTED_MAIN_INVALID');
  const files = [ASSOCIATION_POLICY_PATH, 'claude/xuan-ib-etf-pending-calls-v1.json', 'xuan-ib/latest.meta.json', 'xuan-ib/latest.html'];
  const [policyText, reserveText, metaText, previousHtml] = await Promise.all(files.map(file => read(`${RAW}/${commit}/${file}`, {fetchImpl})));
  const policy = json(policyText), meta = json(metaText);
  if (!SHA.test(meta.sourceSha || '') || !SHA.test(meta.htmlBlob || '')) throw new Error('PREVIOUS_PUBLIC_META_INVALID');
  if (gitBlob(previousHtml) !== meta.htmlBlob) throw new Error('PREVIOUS_PUBLIC_HTML_MISMATCH');
  const association = {policy, policyCommit: commit, policyBlob: gitBlob(policyText), checkedAt: new Date(now()).toISOString()};
  validateAssociationSnapshot(association, {now: now(), edition: 'am'});
  return {association, reserveLedger: json(reserveText), reserveHash: hash(reserveText), previousSourceSha: meta.sourceSha, previousHtml};
}

export function currentReserve(ledger, date) {
  if (ledger?.schemaVersion !== 1 || ledger.purpose !== 'xuan-etf-owner-declared-pending-calls' || !Array.isArray(ledger.entries)
    || ledger.entries.some(entry => !validDate(entry?.date) || !Number.isFinite(entry.usd) || entry.usd < 0)) throw new Error('PENDING_CALL_LEDGER_INVALID');
  const eligible = ledger.entries.filter(entry => entry.date <= date).sort((a, b) => a.date.localeCompare(b.date));
  if (!eligible.length) throw new Error('PENDING_CALL_RESERVE_UNAVAILABLE');
  return eligible.at(-1).usd;
}

export async function readSharesightAction(sourceDate, token, {fetchImpl = fetch, now = Date.now} = {}) {
  if (!validDate(sourceDate) || typeof token !== 'string' || !token || /[\r\n]/.test(token)) throw new Error('SHARESIGHT_READ_SCOPE_INVALID');
  // No arbitrary portfolio, route or grouping is accepted. This token only
  // accesses existing GET REST routes, never the gateway's MCP write surface.
  const reads = [['sharesight.ibGroupedPerformance', 'IB-HK', '83569'], ['sharesight.noahPerformance', 'NOAH-HK', 'investment_type']];
  return Promise.all(reads.map(async ([sourceKey, portfolio, grouping]) => {
    const startedAt = new Date(now()).toISOString(), url = new URL('/v1/performance', GATEWAY);
    url.search = new URLSearchParams({portfolio, start_date: sourceDate, end_date: sourceDate, grouping, include_sales: 'false'}).toString();
    const raw = json(await read(url, {fetchImpl, headers: {Authorization: `Bearer ${token}`}}));
    if (raw.mode !== 'read_only' || raw.source !== 'Sharesight User API') throw new Error('SHARESIGHT_GATEWAY_SCOPE_INVALID');
    return {sourceKey, raw, startedAt, completedAt: new Date(now()).toISOString(), rawFingerprint: hash(raw)};
  }));
}

export async function runPrivateReport({sourceDate, io, now = Date.now, loadContext = loadTrustedContext,
  captureIb = captureCloudIbAction, readSharesight = readSharesightAction} = {}) {
  const started = now(), date = dateHkt(started);
  if (!validDate(sourceDate) || sourceDate >= date) throw new Error('COMPLETED_SOURCE_DATE_REQUIRED');
  if (!io?.ibStore || !io.loadGatewayToken || !io.savePrivate) throw new Error('PRIVATE_CLOUD_IO_REQUIRED');
  // Load Sharesight access before IB refresh so a missing grant does not rotate
  // the IB credential or capture a partial source set unnecessarily.
  const token = await io.loadGatewayToken();
  const context = await loadContext({now});
  validateAssociationSnapshot(context.association, {now: now(), edition: 'am'});
  const runId = hash(crypto.randomUUID());
  const association = createAssociationReceipt(context.association, {now: now(), edition: 'am', previousSourceSha: context.previousSourceSha, runId});
  const reserve = currentReserve(context.reserveLedger, date);
  const [ib, sharesight] = await Promise.all([captureIb(io.ibStore), readSharesight(sourceDate, token, {now})]);
  const required = ['ib.accountSummary', 'ib.positions', 'ib.orders'];
  if (ib?.status !== 'captured' || ib.sources?.length !== 3 || required.some(key => ib.sources.filter(s => s.sourceKey === key).length !== 1)
    || sharesight?.length !== 2 || !sharesight.some(s => s.sourceKey === 'sharesight.ibGroupedPerformance')
    || !sharesight.some(s => s.sourceKey === 'sharesight.noahPerformance')) throw new Error('ACTION_SOURCES_INCOMPLETE');
  const sources = [...ib.sources, ...sharesight];
  const raw = key => sources.find(source => source.sourceKey === key).raw;
  const completed = now();
  if (dateHkt(completed) !== date) throw new Error('REPORT_CROSSED_HKT_DATE');
  const model = buildNightActionModel({dataDate: date, expectedSourceDate: sourceDate,
    asOfHkt: `${date} ${timeHkt(started)}–${timeHkt(completed)} HKT · 数据至 ${sourceDate}`,
    ordersAsOfHkt: `${date} ${timeHkt(completed)} HKT`, ibAccountSummary: raw('ib.accountSummary'), ibPositions: raw('ib.positions'),
    ibOrders: raw('ib.orders'), ibGroupedPerformance: raw('sharesight.ibGroupedPerformance'), noahPerformance: raw('sharesight.noahPerformance'),
    reserve, previousHtml: context.previousHtml});
  const html = renderNightActionReport(model);
  validateNightActionHtml(html, date);
  const current = await loadContext({now});
  validateAssociationReceipt(association, current.association, {now: now(), edition: 'am', previousSourceSha: context.previousSourceSha, runId});
  if (current.reserveHash !== context.reserveHash || current.previousSourceSha !== context.previousSourceSha) throw new Error('REPORT_BASE_CHANGED');
  const prefix = `report-check/${new Date(started).toISOString()}-${crypto.randomUUID()}/`, evidence = [];
  for (const source of sources) {
    const object = prefix + source.sourceKey + '.json';
    evidence.push({sourceKey: source.sourceKey, startedAt: source.startedAt, completedAt: source.completedAt,
      privateObject: object, ...await io.savePrivate(object, source)});
  }
  const artifact = {privateObject: prefix + 'report.html', ...await io.savePrivate(prefix + 'report.html', html)};
  const receipt = {schemaVersion: 1, status: model.status, mode: 'private_report_check', dataDate: date, sourceDate,
    startedAt: new Date(started).toISOString(), completedAt: new Date(now()).toISOString(), association, sourceCount: sources.length,
    sources: evidence, artifact, publication: 'none', scheduler: 'none'};
  await io.savePrivate(prefix + 'receipt.json', receipt);
  // Caller may only log this receipt, not the raw sources/model/HTML.
  return receipt;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, flag, sourceDate] = process.argv.slice(2);
  try {
    if (mode !== '--report-check' || flag !== '--source-date' || process.argv.length !== 5) throw new Error('PRIVATE_REPORT_CHECK_ONLY');
    const receipt = await runPrivateReport({sourceDate, io: privateCloudIo()});
    process.stdout.write(JSON.stringify(receipt) + '\n');
  } catch (error) {
    const code = /^[A-Z_0-9]+$/.test(error?.message || '') ? error.message : 'PRIVATE_REPORT_CHECK_FAILED';
    process.stdout.write(JSON.stringify({status: 'failed', code, publication: 'none', scheduler: 'none'}) + '\n');
    process.exitCode = 1;
  }
}
