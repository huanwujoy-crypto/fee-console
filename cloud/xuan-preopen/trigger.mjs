// Independent clock only. This job never reads financial sources or publishes.
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {planPreopen} from './calendar.mjs';
import {boundedText} from './cloud_io.mjs';

const REPO = 'huanwujoy-crypto/fee-console';
const WORKFLOW = 'xuan-preopen-cloud-producer.yml';
const API = `https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}`;
const SECRET = 'projects/family-portfolio-gateway/secrets/xuan-preopen-trigger-github';
const fail = code => {throw new Error(`PREOPEN_TRIGGER_${code}`);};
const modes = new Set(['launch', 'check-start']);
const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

function validRunsQuery(suffix) {
  const match = /^\/runs\?branch=main&created=([^&]+)&per_page=100$/.exec(suffix || '');
  if (!match) return false;
  let range;
  try { range = decodeURIComponent(match[1]).split('..'); } catch { return false; }
  if (range.length !== 2 || range.some(value => !iso.test(value) || !Number.isFinite(Date.parse(value)))) return false;
  return Date.parse(range[1])-Date.parse(range[0]) === 86_399_000
    && range[0].endsWith('T16:00:00Z') && range[1].endsWith('T15:59:59Z');
}

export function triggerTransport({fetchImpl = fetch} = {}) {
  let githubToken;
  async function response(url, init = {}) {
    let result;
    try { result = await fetchImpl(url, {...init, redirect: 'error', signal: AbortSignal.timeout(20_000)}); }
    catch { fail('NETWORK'); }
    if (!result.ok) fail(`HTTP_${result.status}`);
    return result;
  }
  async function json(result) {
    try { return JSON.parse(await boundedText(result, 2_000_000)); }
    catch { fail('RESPONSE'); }
  }
  async function token() {
    if (githubToken) return githubToken;
    const identity = await json(await response('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
      {headers: {'Metadata-Flavor': 'Google'}}));
    if (typeof identity.access_token !== 'string' || !identity.access_token || /[\r\n]/.test(identity.access_token)) fail('IDENTITY');
    const value = await json(await response(`https://secretmanager.googleapis.com/v1/${SECRET}/versions/latest:access`,
      {headers: {Authorization: `Bearer ${identity.access_token}`}}));
    githubToken = Buffer.from(value.payload?.data || '', 'base64').toString('utf8').trim();
    if (!githubToken || /[\r\n]/.test(githubToken)) fail('CREDENTIAL');
    return githubToken;
  }
  return async (suffix, {method = 'GET', body} = {}) => {
    // No caller-selectable repository, branch, job, financial endpoint or URL.
    if (!validRunsQuery(suffix) && suffix !== '/dispatches') fail('SCOPE');
    if (suffix === '/dispatches' ? method !== 'POST' || JSON.stringify(body) !== '{"ref":"main"}' : method !== 'GET' || body !== undefined) fail('SCOPE');
    const result = await response(API+suffix, {method, headers: {
      Accept: 'application/vnd.github+json', Authorization: `Bearer ${await token()}`,
      'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json',
    }, ...(body ? {body: JSON.stringify(body)} : {})});
    if (method === 'POST') {
      if (result.status === 200) {
        const dispatched = await json(result);
        const id = dispatched.workflow_run_id;
        if (!Number.isSafeInteger(id) || id <= 0
            || dispatched.run_url !== `https://api.github.com/repos/${REPO}/actions/runs/${id}`
            || dispatched.html_url !== `https://github.com/${REPO}/actions/runs/${id}`) fail('DISPATCH_RESPONSE');
      } else if (result.status !== 204) fail('DISPATCH_RESPONSE');
      return null;
    }
    return json(result);
  };
}

export function runsForDay(result, plan, instant) {
  if (!result || !Array.isArray(result.workflow_runs) || !Number.isInteger(result.total_count)
      || result.total_count !== result.workflow_runs.length || result.total_count > 100) fail('RUNS_INCOMPLETE');
  const midnight = Date.parse(`${plan.dataDate}T00:00:00+08:00`), end = midnight+86_400_000;
  const statuses = new Set(['queued', 'in_progress', 'completed', 'waiting', 'requested', 'pending']);
  for (const run of result.workflow_runs) {
    if (!run || !Number.isSafeInteger(run.id) || run.id <= 0 || typeof run.head_branch !== 'string'
        || typeof run.event !== 'string' || !statuses.has(run.status)
        || !iso.test(run.created_at || '') || !Number.isFinite(Date.parse(run.created_at))
        || Date.parse(run.created_at) > instant) fail('RUNS_INVALID');
    if (['in_progress', 'completed'].includes(run.status)
        && (!iso.test(run.run_started_at || '') || Date.parse(run.run_started_at) < Date.parse(run.created_at)
          || !Number.isFinite(Date.parse(run.run_started_at)) || Date.parse(run.run_started_at) > instant)) fail('RUNS_INVALID');
  }
  return result.workflow_runs.filter(run => {
    const created = Date.parse(run.created_at);
    return run?.head_branch === 'main' && ['schedule', 'workflow_dispatch'].includes(run.event)
      && created >= midnight && created < end;
  });
}

export async function runTrigger({mode, now = Date.now, request = triggerTransport()} = {}) {
  if (!modes.has(mode)) fail('MODE');
  const instant = now(), plan = planPreopen(instant);
  if (plan.status === 'no-action') return {event: 'PREOPEN_CLOCK', outcome: 'no-action', dataDate: plan.dataDate};
  const slot = Date.parse(`${plan.dataDate}T13:00:00+08:00`);
  if (instant < slot || instant >= slot+20*60_000) fail('OUTSIDE_WINDOW');
  if (mode === 'check-start' && instant < slot+5*60_000) fail('CHECK_TOO_EARLY');
  const midnight = slot-13*60*60_000;
  const stamp = value => new Date(value).toISOString().replace('.000Z', 'Z');
  const range = encodeURIComponent(`${stamp(midnight)}..${stamp(midnight+86_399_000)}`);
  const runs = runsForDay(await request(`/runs?branch=main&created=${range}&per_page=100`), plan, instant);
  if (mode === 'check-start') {
    // Queued/waiting/requested runs do not prove that the producer started.
    if (!runs.some(run => run.status === 'in_progress' || run.status === 'completed')) fail('NOT_STARTED');
    return {event: 'PREOPEN_CLOCK', outcome: 'started', dataDate: plan.dataDate};
  }
  if (runs.length) return {event: 'PREOPEN_CLOCK', outcome: 'already-requested', dataDate: plan.dataDate};
  // Exactly one POST per clock execution. Unknown POST results are not retried.
  // Rare concurrent dispatches remain harmless: existing GitHub concurrency
  // serialises them and the source job's immutable daily start prevents rereads.
  await request('/dispatches', {method: 'POST', body: {ref: 'main'}});
  return {event: 'PREOPEN_CLOCK', outcome: 'requested', dataDate: plan.dataDate};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  (args.length === 1 ? runTrigger({mode: args[0]}) : Promise.reject(new Error('PREOPEN_TRIGGER_MODE')))
    .then(result => process.stdout.write(JSON.stringify(result)+'\n'))
    .catch(error => {
      const code = /^PREOPEN_TRIGGER_[A-Z_0-9]+$/.test(error.message || '') ? error.message : 'PREOPEN_TRIGGER_FAILED';
      process.stdout.write(JSON.stringify({event: 'PREOPEN_CLOCK_ALERT', code})+'\n');
      process.exitCode = 1;
    });
}
