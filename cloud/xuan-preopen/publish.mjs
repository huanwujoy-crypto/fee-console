import {canReplaceActionModel} from '../../scripts/xuan-ib-sleep-priority.mjs';
import {validateEodReceipt,validateCompletedEodSession} from './eod_report.mjs';
import {buildPublicEodSummary} from '../../scripts/xuan-ib-public-eod-summary.mjs';
// Only submit a signed one-file candidate. Validate -> Promote -> Pages still
// exclusively owns latest.html and publication metadata. No main write exists.
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadTrustedContext, currentReserve} from './report.mjs';
import {validateAssociationReceipt} from '../../scripts/xuan-ib-account-association.mjs';
import {extractNightActionModel,renderNightActionReport} from '../../scripts/xuan-ib-night-action-view.mjs';
import {validateNightActionHtml} from '../../scripts/xuan-ib-night-action-guard.mjs';
import {gitBlobSha} from '../../scripts/xuan-ib-publish-health.mjs';
import {hktDate} from './calendar.mjs';
const OWNER = 'huanwujoy-crypto', REPO = `${OWNER}/fee-console`, GRAPH = 'https://api.github.com/graphql';
const SHA = /^[a-f0-9]{40}$/, HASH = /^[a-f0-9]{64}$/;
const fail = code => { throw new Error(`PREOPEN_PUBLISH_${code}`); };
export async function githubRequest(payload, token = process.env.XUAN_PREOPEN_GITHUB_TOKEN) {
  if (!token || /[\r\n\0]/.test(token)) fail('TOKEN_REQUIRED');
  let response;
  try { response = await fetch(GRAPH, {method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
    headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'}, body: JSON.stringify(payload)}); }
  catch { fail('NETWORK'); }
  if (response.status !== 200) fail('HTTP');
  const result = await response.json();
  if (result.errors?.length) fail('GRAPHQL');
  return result;
}
// The ordinary entry cannot accept a caller-provided freshness override.
export const publishPrepared = options => publishArtifact({...options,storedSummary:false});
// A distinct same-day archived EOD contract; original capture times are kept.
export const publishStoredEodSummary = options => publishArtifact({...options,storedSummary:true});
async function publishArtifact({html, receipt, receiptText, savedReceiptSha256, request = githubRequest, loadContext = loadTrustedContext, now = Date.now, storedSummary} = {}) {
  const time = now(), dataDate = hktDate(time);
  const eod=receipt?.mode==='private_eod_action';
  if(storedSummary&&!eod)fail('STORED_SUMMARY_SCOPE');
  // The reviewed immutable saved receipt is pinned independently of editable
  // timestamps. CLI approval must name this SHA, never derive it at execution.
  if(storedSummary&&(typeof receiptText!=='string'||!HASH.test(savedReceiptSha256||'')||crypto.createHash('sha256').update(receiptText).digest('hex')!==savedReceiptSha256||JSON.stringify(JSON.parse(receiptText))!==JSON.stringify(receipt)))fail('SAVED_RECEIPT_BINDING');
  const intraday=receipt?.mode==='private_intraday_update',limited=intraday||receipt?.mode==='private_limited_readback';
  if (receipt?.schemaVersion !== 1 || receipt.dataDate!==dataDate || receipt.sourceDate>=dataDate || receipt.publication!=='none' || !Array.isArray(receipt.sources)
    || (eod?(receipt.status!=='partial'||receipt.sourceCount!==4||receipt.sources.length!==4):limited?(receipt.status!=='partial'||receipt.sourceCount!==(intraday?5:3)||receipt.sources.length!==(intraday?5:3)):(receipt.mode!=='private_report_check'||receipt.status!=='ready'||receipt.sourceCount!==5||receipt.sources.length!==5)))fail('RECEIPT');
  const started = Date.parse(receipt.startedAt), completed = Date.parse(receipt.completedAt);
  if (!Number.isFinite(started) || !Number.isFinite(completed) || completed < started || completed > time
      || completed-started > 300_000 || (!storedSummary&&time-started > 30*60_000)) fail('STALE');
  const required = eod?['ib.flexEod','sharesight.ibGroupedPerformance','sharesight.noahPerformance','ib.optionalLive']:intraday?['ib.accountSummary','ib.positions','ib.orders','ib.balances','ib.trades']:limited?['ib.accountSummary','ib.positions','ib.orders']:['ib.accountSummary','ib.positions','ib.orders','sharesight.ibGroupedPerformance','sharesight.noahPerformance'];
  if (required.some(key => receipt.sources.filter(s => s.sourceKey === key && HASH.test(s.sha256 || '')).length !== 1)) fail('SOURCES');
  if (typeof html !== 'string' || crypto.createHash('sha256').update(html).digest('hex') !== receipt.artifact?.sha256) fail('HASH');
  if(!limited)validateNightActionHtml(html, dataDate);
  const model = extractNightActionModel(html);
  if(eod)validateEodReceipt(receipt,html,dataDate,receipt.sourceDate);
  else if(limited){if(model.schemaVersion!==(intraday?8:7)||model.status!=='partial'||model.sourceDate!==receipt.sourceDate||model.captureStartedAt!==receipt.startedAt||model.captureCompletedAt!==receipt.completedAt||model.evidenceSha256!==receipt.evidenceSha256||JSON.stringify(model.association)!==JSON.stringify(receipt.association))fail('MODEL');}
  else if (model.schemaVersion !== 5 || model.status !== 'ready' || !model.asOfHkt.endsWith(`数据至 ${receipt.sourceDate}`)) fail('MODEL');
  if(storedSummary)validateCompletedEodSession(receipt.sourceDate,started);
  // Original receipt/model stays private and still authorizes association,
  // reserve, source and replacement checks. Public EOD bytes are projected.
  const publicModel=eod?buildPublicEodSummary(model,receipt):model;
  const publicHtml=eod?renderNightActionReport(publicModel):html;
  if(eod)validateNightActionHtml(publicHtml,dataDate,{now:time,publication:true});
  const verifyContext = async () => {
    const context = await loadContext({now});
    validateAssociationReceipt(receipt.association, context.association, {now: now(), edition: 'am',
      previousSourceSha: context.previousSourceSha, runId: receipt.association?.runId});
    if(limited)validateNightActionHtml(html,dataDate,{snapshot:context.association,previousSourceSha:context.previousSourceSha,now:now()});
    else if (model.cash.reserve !== currentReserve(context.reserveLedger, dataDate)) fail('RESERVE_CHANGED');
    return context;
  };
  const context = await verifyContext(), baseSha = context.association.policyCommit;
  const verifyReplacement = context => {if(eod){try{const old=extractNightActionModel(context.previousHtml);if(old.dataDate===dataDate&&!canReplaceActionModel(publicModel,old))fail('COMPLETE_REPORT_EXISTS');}catch(e){if(e.message==='PREOPEN_PUBLISH_COMPLETE_REPORT_EXISTS')throw e;}}};
  verifyReplacement(context);
  if(limited){try{const old=extractNightActionModel(context.previousHtml);if([7,8].includes(old.schemaVersion)&&old.evidenceSha256===model.evidenceSha256)return {publication:'already-published-status',dataDate};if(!intraday&&old.status==='ready'&&old.dataDate===dataDate)fail('COMPLETE_REPORT_EXISTS');}catch(e){if(e.message==='PREOPEN_PUBLISH_COMPLETE_REPORT_EXISTS')throw e;}}
  const query = {query: 'query { viewer { login } repository(owner: "huanwujoy-crypto", name: "fee-console") { id ref(qualifiedName: "refs/heads/main") { target { oid } } } }'};
  const repo = (await request(query))?.data;
  if (repo?.viewer?.login !== OWNER) fail('OWNER');
  if (!repo.repository?.id || repo.repository.ref?.target?.oid !== baseSha) fail('BASE_CHANGED');
  const branch = `codex/xuan-ib-preopen-${dataDate.replaceAll('-','')}-${crypto.randomBytes(3).toString('hex')}`;
  const ref = (await request({query: 'mutation($input: CreateRefInput!) { createRef(input: $input) { ref { name target { oid } } } }',
    variables: {input: {repositoryId: repo.repository.id, name: `refs/heads/${branch}`, oid: baseSha}}}))?.data?.createRef?.ref;
  if (![branch,`refs/heads/${branch}`].includes(ref?.name) || ref?.target?.oid !== baseSha) fail('CREATE_REF');
  // An empty candidate branch is harmless if fresh policy/base verification
  // fails here. Never delete a branch or silently retry with a different base.
  const latest = await verifyContext();
  verifyReplacement(latest);
  if (latest.association.policyCommit !== baseSha) fail('BASE_CHANGED');
  const result = (await request({query: 'mutation($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { oid } ref { name } } }',
    variables: {input: {branch: {repositoryNameWithOwner: REPO, branchName: branch}, expectedHeadOid: baseSha,
      message: {headline: `handover ${dataDate}`}, fileChanges: {additions: [{path: 'xuan-ib/index.html', contents: Buffer.from(publicHtml).toString('base64')}]}}}}))?.data?.createCommitOnBranch;
  if (!SHA.test(result?.commit?.oid || '') || ![branch,`refs/heads/${branch}`].includes(result?.ref?.name)) fail('COMMIT');
  return {branch, sha: result.commit.oid, dataDate, htmlBlob: gitBlobSha(publicHtml), publication: 'candidate-only'};
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args=process.argv.slice(2),stored=args[0]==='stored-eod-summary';
    const [htmlFile,receiptFile,savedReceiptSha256]=stored?args.slice(1):args;
    if (!htmlFile || !receiptFile || args.length!==(stored?4:2)) fail('ARGUMENTS');
    const receiptText=fs.readFileSync(receiptFile,'utf8');
    const result = await (stored?publishStoredEodSummary:publishPrepared)({html: fs.readFileSync(htmlFile, 'utf8'), receipt: JSON.parse(receiptText),receiptText,savedReceiptSha256});
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `sha=${result.sha||''}\nhtml_blob=${result.htmlBlob||''}\ndata_date=${result.dataDate}\n`);
    process.stdout.write(JSON.stringify(result)+'\n');
  } catch(error) {
    process.stderr.write((/^PREOPEN_PUBLISH_[A-Z_]+$/.test(error.message) ? error.message : 'PREOPEN_PUBLISH_VALIDATION_FAILED')+'\n');
    process.exitCode = 1;
  }
}
