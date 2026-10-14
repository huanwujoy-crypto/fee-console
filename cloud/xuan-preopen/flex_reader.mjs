// Fixed official HTTPS report transport. No realtime MCP, token rotation,
// trading endpoint or caller-selected URL. One SendRequest, bounded polling
// of its exact accepted reference; an unknown generation outcome is not retried.
import {boundedText} from './cloud_io.mjs';
const ENDPOINT = 'https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/';
const fail = code => {throw new Error('FLEX_SOURCE_'+code);};
function statement(text) {
  const xml = text.trim().replace(/^<\?xml[^>]*\?>\s*/, '');
  if (/<!|<\?|&/.test(xml)) fail('RESPONSE_INVALID');
  const body = /^<FlexStatementResponse(?: timestamp="[^"<>\r\n]{1,128}")?>\s*([\s\S]*?)\s*<\/FlexStatementResponse>$/.exec(xml)?.[1];
  if (body === undefined) fail('RESPONSE_INVALID');
  const fields = {}, pattern = /<(Status|ReferenceCode|ErrorCode|ErrorMessage|Url|url)>([^<>]*)<\/\1>/g;
  let rest = body, match;
  while ((match = pattern.exec(body))) {
    const field=match[1]==='url'?'Url':match[1];
    if (Object.hasOwn(fields, field)) fail('RESPONSE_INVALID');
    fields[field] = match[2]; rest = rest.replace(match[0], '');
  }
  if (rest.trim()) fail('RESPONSE_INVALID');
  return fields;
}
export async function fetchFlexArchive({token, configuredQueryId, fetchImpl = fetch,
  now = Date.now, wait = ms => new Promise(resolve => setTimeout(resolve, ms))} = {}) {
  if (typeof token !== 'string' || !token || /[\r\n\0]/.test(token)
    || !/^[1-9]\d{0,19}$/.test(configuredQueryId || '')) fail('CONFIGURATION_REQUIRED');
  const deadline = now()+150_000;
  async function get(operation, query) {
    const remaining = deadline-now(); if (remaining <= 0) fail('TIMEOUT');
    const url = new URL(ENDPOINT+operation);
    url.search = new URLSearchParams({t: token, q: query, v: '3'}).toString();
    let response;
    try { response = await fetchImpl(url, {method:'GET', redirect:'error',
      headers:{'User-Agent':`Node/${process.versions.node}`},signal:AbortSignal.timeout(Math.min(30_000, remaining))}); }
    catch { fail('NETWORK_FAILED'); }
    if (!response.ok) fail('HTTP_FAILED');
    try { return await boundedText(response, 8_000_000); } catch { fail('RESPONSE_INVALID'); }
  }
  const requested = statement(await get('SendRequest', configuredQueryId));
  if (requested.Status !== 'Success' || requested.ErrorCode !== undefined
    || !/^[1-9]\d{0,29}$/.test(requested.ReferenceCode || '')) fail('REQUEST_REJECTED');
  for (let count=0; count<24; count++) {
    if (now()+6200 >= deadline) fail('TIMEOUT');
    await wait(6200);
    const bytes = await get('GetStatement', requested.ReferenceCode);
    if (/^(?:\s*<\?xml[^>]*\?>)?\s*<FlexQueryResponse\b/.test(bytes)) {
      if (now() >= deadline) fail('TIMEOUT');
      return {bytes, requestedQueryId: configuredQueryId};
    }
    const pending = statement(bytes);
    if (pending.Status !== 'Fail' || pending.ReferenceCode !== undefined
      || !['1009','1019'].includes(pending.ErrorCode)) fail('STATEMENT_REJECTED');
  }
  fail('TIMEOUT');
}
