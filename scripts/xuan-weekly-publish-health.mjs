// Amount-free freshness check. No broker, gateway, credential or raw-data access.
import { pathToFileURL } from 'node:url';

export const REPORT_URL = 'https://storage.googleapis.com/family-portfolio-gateway-xuan-weekly-public/weekly/latest.html';
const HKT = 8 * 60 * 60 * 1000;

export function weeklyHealth({ status, headers, now = new Date() }) {
  const current = new Date(now);
  if (!Number.isFinite(current.getTime())) throw new Error('invalid_clock');
  const local = new Date(current.getTime() + HKT);
  const sunday = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - local.getUTCDay(), 2);
  const due = current.getTime() >= sunday ? sunday : sunday - 7 * 86400000;
  // Existing job has a 600-second limit; allow five extra minutes for startup.
  if (current.getTime() < due + 15 * 60000) return { complete: true, code: 'within_publication_window' };
  const base = { expectedStart: new Date(due).toISOString() };
  if (status !== 200) return { ...base, complete: false, code: 'weekly_public_unavailable' };
  const get = name => headers.get(name);
  const started = get('x-goog-meta-started_at');
  const startedTime = Date.parse(started);
  const riskDate = get('x-goog-meta-risk_date');
  const abcDate = get('x-goog-meta-abc_date');
  const sha = get('x-goog-meta-sha256');
  // Never reflect unvalidated header text or response bodies into notifications.
  const day = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
  if (!Number.isFinite(startedTime) || typeof started !== 'string'
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|\+00:00)$/.test(started)
      || !day(riskDate) || !day(abcDate) || !/^[a-f0-9]{64}$/.test(sha ?? '')) {
    return { ...base, complete: false, code: 'weekly_public_metadata_invalid' };
  }
  const evidence = { ...base, startedAt: started, riskDate, abcDate, sha256: sha };
  if (startedTime < due) return { ...evidence, complete: false, code: 'weekly_public_stale' };
  if (startedTime > current.getTime() + 60000) return { ...base, complete: false, code: 'weekly_public_future_run' };
  // The established source contract allows at most three days behind the run.
  const runDay = Math.floor(startedTime / 86400000) * 86400000;
  const riskLag = (runDay - Date.parse(riskDate)) / 86400000;
  const quoteLag = (Date.parse(riskDate) - Date.parse(abcDate)) / 86400000;
  if (riskLag < 0 || riskLag > 3 || quoteLag < 0 || quoteLag > 3) {
    return { ...evidence, complete: false, code: 'weekly_public_source_dates_invalid' };
  }
  return { ...evidence, complete: true, code: 'weekly_public_current' };
}

export async function checkWeekly(fetcher = fetch) {
  try {
    const response = await fetcher(REPORT_URL, { method: 'HEAD', redirect: 'error',
      signal: AbortSignal.timeout(30000), cache: 'no-store' });
    return weeklyHealth({ status: response.status, headers: response.headers });
  } catch {
    return { complete: false, code: 'weekly_public_check_failed' };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await checkWeekly();
  console.log(JSON.stringify(result));
  process.exitCode = result.complete ? 0 : 1;
}
