// Official IBKR MCP transport for the cloud action report. No model or trading
// dispatcher is involved. Credentials belong in a private cloud secret store.
import { decodeHookResponse } from '../../scripts/xuan-ib-hook-response.mjs';
import {parseDecisionJson} from '../../scripts/xuan-ib-decision-menu.mjs';
import { ibError, inIbPhase, networkCategory, httpCategory, bearerError } from './ib_diagnostics.mjs';

export const RESOURCE = 'https://api.ibkr.com/v1/api/mcp-public';
export const TOKEN_ENDPOINT = 'https://api.ibkr.com/oauth2/api/v1/token';
const MAX_BYTES = 8_000_000;
const SOURCES = Object.freeze({
  get_account_summary: 'ib.accountSummary',
  get_account_positions: 'ib.positions',
  get_account_orders: 'ib.orders',
  get_account_balances: 'ib.balances',
  get_account_trades: 'ib.trades',
});
const argumentsFor=tool=>tool==='get_account_trades'?{period:'DAYS_7'}:{};
const argumentsAllowed=(tool,args)=>args&&Object.keys(args).length===(tool==='get_account_trades'?1:0)&&(tool!=='get_account_trades'||args.period==='DAYS_7');
const fail = (code, diagnostic) => { throw ibError(code, diagnostic); };
const exactReadScope = scope => typeof scope === 'string' && scope.trim() === 'mcp.read';

export function validateCredential(value) {
  if (!value || !exactReadScope(value.scope) || value.resource !== RESOURCE
    || typeof value.client_id !== 'string' || !value.client_id
    || typeof value.access_token !== 'string' || !value.access_token
    || typeof value.refresh_token !== 'string' || !value.refresh_token
    || value.token_type?.toLowerCase() !== 'bearer'
    || !Number.isFinite(value.expires_at) || value.expires_at <= 0) fail('IB_READ_ONLY_CREDENTIAL_REQUIRED');
  return value;
}

async function bodyText(response, limit = MAX_BYTES) {
  if (!response.body) fail('IB_EMPTY_RESPONSE');
  const reader = response.body.getReader();
  const chunks = []; let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) fail('IB_RESPONSE_TOO_LARGE');
      chunks.push(Buffer.from(value));
    }
  } finally { void reader.cancel().catch(() => {}); }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); }
  catch { fail('IB_INVALID_UTF8'); }
}

export async function loadReadCredential(store, { fetchImpl = fetch, now = Date.now, allowRefresh = true, signal, refreshSignal = signal } = {}) {
  signal?.throwIfAborted();
  let original;
  try { original = validateCredential(await store.load()); }
  catch (error) {
    const match = /^CLOUD_HTTP_([1-5]\d\d)$/.exec(error?.message || '');
    throw inIbPhase(error, 'credential_load', 'IB_CREDENTIAL_LOAD_FAILED', match ? Number(match[1]) : null,
      match ? httpCategory(Number(match[1])) : error?.message === 'IB_READ_ONLY_CREDENTIAL_REQUIRED' ? 'scope_invalid'
        : error?.message === 'CLOUD_NETWORK_FAILED' ? networkCategory(error)
        : ['TimeoutError', 'AbortError'].includes(error?.name) ? 'timeout' : 'unknown');
  }
  if (original.expires_at > now() + 120_000) return original;
  signal?.throwIfAborted();
  if (allowRefresh !== true) fail('IB_REFRESH_NOT_AUTHORIZED', {phase: 'oauth_refresh', category: 'forbidden'});
  // A refresh may revoke the old refresh token. Require a persistence capability
  // before submitting it; never refresh as a purported no-write probe.
  if (typeof store.save !== 'function') fail('IB_TOKEN_ROTATION_NOT_SAVED', {phase: 'credential_save', category: 'save_failed'});
  let response;
  try {
    response = await fetchImpl(TOKEN_ENDPOINT, {
      // Admission still uses the source signal above. An already admitted
      // refresh can finish and persist its rotation in a bounded finalization
      // window; it must not start another MCP request after source cutoff.
      method: 'POST', redirect: 'error', signal: refreshSignal?AbortSignal.any([refreshSignal,AbortSignal.timeout(30_000)]):AbortSignal.timeout(30_000),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: original.client_id,
        refresh_token: original.refresh_token, scope: 'mcp.read', resource: RESOURCE }),
    });
  } catch (error) { fail('IB_REFRESH_NETWORK_FAILED', {phase: 'oauth_refresh', category: networkCategory(error)}); }
  if (!response.ok) {
    let oauthError = null;
    try { oauthError = JSON.parse(await bodyText(response, 16_384))?.error; } catch { /* Unknown stays unknown; raw body is never logged. */ }
    fail('IB_REFRESH_HTTP_FAILED', {phase: 'oauth_refresh', httpStatus: response.status,
      category: httpCategory(response.status, oauthError)});
  }
  let token;
  try { token = JSON.parse(await bodyText(response, 16_384)); }
  catch { fail('IB_REFRESH_RESPONSE_INVALID', {phase: 'oauth_refresh', httpStatus: response.status, category: 'response_invalid'}); }
  if (!token || typeof token.access_token !== 'string' || !token.access_token
    || typeof token.token_type !== 'string' || token.token_type.toLowerCase() !== 'bearer'
    || !Number.isFinite(token.expires_in) || token.expires_in <= 0
    || (token.refresh_token !== undefined && (typeof token.refresh_token !== 'string' || !token.refresh_token))
    || (token.scope !== undefined && !exactReadScope(token.scope))) fail('IB_REFRESH_SCOPE_INVALID',
      {phase: 'oauth_refresh', httpStatus: response.status, category: 'scope_invalid'});
  let next;
  try { next = validateCredential({ ...original, access_token: token.access_token,
    refresh_token: token.refresh_token || original.refresh_token, token_type: token.token_type,
    expires_at: now() + token.expires_in * 1000, scope: 'mcp.read', obtained_at: new Date(now()).toISOString() }); }
  catch { fail('IB_REFRESH_SCOPE_INVALID', {phase: 'oauth_refresh', httpStatus: response.status, category: 'scope_invalid'}); }
  // Persist rotation before any source read. Failure cannot fall back to the old
  // token or leave a report successful while its next run loses authorization.
  try { await store.save(next); } catch (error) {
    const match = /^CLOUD_HTTP_([1-5]\d\d)$/.exec(error?.message || '');
    const rejected = match && Number(match[1]) >= 400 && Number(match[1]) < 500;
    throw inIbPhase(ibError(rejected ? 'IB_TOKEN_ROTATION_NOT_SAVED' : 'IB_TOKEN_ROTATION_OUTCOME_UNKNOWN',
      {httpStatus: match ? Number(match[1]) : null, category: rejected ? 'save_failed' : 'save_outcome_unknown'}),
      'credential_save', 'IB_TOKEN_ROTATION_NOT_SAVED');
  }
  return next;
}

function strictMcpJson(text){
  // Reject duplicate keys, including escaped equivalents, before JSON.parse
  // can overwrite an earlier assertion. Restore ordinary JSON prototypes only
  // after the bounded existing parser has validated the complete input.
  parseDecisionJson(text,MAX_BYTES);return JSON.parse(text);
}
function inspectMcpEnvelope(value,inspectEnvelope){
  let nodes=0,blocks=0,textBytes=0;
  const walk=(node,depth)=>{
    if(++nodes>50000||depth>20)fail('IB_MCP_RESPONSE_INVALID');
    if(node===null||typeof node!=='object')return;
    if(node.type==='text'&&Object.hasOwn(node,'text')){
      if(typeof node.text!=='string'||++blocks>64||(textBytes+=Buffer.byteLength(node.text))>MAX_BYTES)fail('IB_MCP_RESPONSE_INVALID');
      let decoded;try{decoded=strictMcpJson(node.text);}catch{fail('IB_MCP_RESPONSE_INVALID');}
      inspectEnvelope?.(decoded);walk(decoded,depth+1);
    }
    for(const child of Object.values(node))if(child&&typeof child==='object')walk(child,depth+1);
  };
  // Inspect the entire RPC envelope before selecting result/structuredContent,
  // including metadata, unmatched SSE messages and every parallel text block.
  inspectEnvelope?.(value);walk(value,0);
}
function rpcMessage(text, contentType, id,inspectEnvelope) {
  let messages;
  try {
    messages = contentType.includes('text/event-stream')
      ? text.split(/\r?\n\r?\n/).filter(block => /^data:/m.test(block))
        .map(block => strictMcpJson(block.split(/\r?\n/).filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).trimStart()).join('\n')))
      : [strictMcpJson(text)];
  } catch { fail('IB_MCP_RESPONSE_INVALID'); }
  for(const message of messages)inspectMcpEnvelope(message,inspectEnvelope);
  const matches = messages.filter(message => message?.id === id);
  if (matches.length !== 1 || matches[0].jsonrpc !== '2.0' || matches[0].error
    || !Object.hasOwn(matches[0], 'result')) fail('IB_MCP_RPC_FAILED');
  return matches[0].result;
}

export class IbReadSession {
  constructor(credential, { fetchImpl = fetch, signal, inspectEnvelope } = {}) {
    this.credential = validateCredential(credential); this.fetchImpl = fetchImpl;
    this.signal=signal;
    this.inspectEnvelope=inspectEnvelope;
    this.id = 0; this.sessionId = null; this.initialized = false;
  }
  async request(method, params, notification = false) {
    if (!['initialize', 'notifications/initialized', 'tools/call'].includes(method)) fail('IB_MCP_METHOD_FORBIDDEN');
    if (method === 'tools/call' && (!Object.hasOwn(SOURCES, params?.name)
      || !argumentsAllowed(params.name,params.arguments))) fail('IB_MCP_TOOL_FORBIDDEN');
    return sendRequest(this, method, params, notification);
  }
  async initialize() {
    const result = await this.request('initialize', { protocolVersion: '2025-03-26', capabilities: {},
      clientInfo: { name: 'xuan-preopen-readonly', version: '1.0.0' } });
    if (!result?.capabilities?.tools || result.protocolVersion !== '2025-03-26') fail('IB_MCP_HANDSHAKE_INVALID',
      {phase: 'mcp_initialize', category: 'response_invalid'});
    await this.request('notifications/initialized', undefined, true);
    this.initialized = true;
  }
  async read(tool) {
    if (!this.initialized) fail('IB_MCP_NOT_INITIALIZED');
    if (!Object.hasOwn(SOURCES, tool)) fail('IB_MCP_TOOL_FORBIDDEN');
    const result = await this.request('tools/call', { name: tool, arguments: argumentsFor(tool) });
    const phase = readPhase(tool);
    if (!result || result.isError === true) fail('IB_MCP_SOURCE_FAILED', {phase, category: 'tool_error'});
    const sourceKey = SOURCES[tool];
    const transport = result.structuredContent ?? (() => {
      if (!Array.isArray(result.content) || result.content.length !== 1 || result.content[0].type !== 'text')
        fail('IB_MCP_SOURCE_WRAPPER_INVALID', {phase, category: 'response_invalid'});
      return result.content[0].text;
    })();
    try { return { sourceKey, ...decodeHookResponse(transport, { sourceKey }) }; }
    catch { fail('IB_MCP_SOURCE_SHAPE_INVALID', {phase, category: 'contract_invalid'}); }
  }
}

const readPhase = tool => ({get_account_summary: 'mcp_summary_read', get_account_positions: 'mcp_positions_read',
  get_account_orders: 'mcp_orders_read', get_account_balances: 'mcp_balances_read', get_account_trades: 'mcp_trades_read'})[tool] || 'unknown';
async function sendRequest(session, method, params, notification) {
    session.signal?.throwIfAborted();
    const phase = method === 'initialize' ? 'mcp_initialize' : method === 'notifications/initialized'
      ? 'mcp_initialized' : method === 'tools/list' ? 'mcp_tools_list' : readPhase(params?.name);
    const id = ++session.id;
    const payload = { jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }), ...(notification ? {} : { id }) };
    const headers = { Authorization: `Bearer ${session.credential.access_token}`,
      'content-type': 'application/json', Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2025-03-26' };
    if (session.sessionId) headers['Mcp-Session-Id'] = session.sessionId;
    let response;
    try { response = await session.fetchImpl(RESOURCE, { method: 'POST', redirect: 'error',
      signal: session.signal?AbortSignal.any([session.signal,AbortSignal.timeout(30_000)]):AbortSignal.timeout(30_000), headers, body: JSON.stringify(payload) }); }
    catch (error) { fail('IB_MCP_NETWORK_FAILED', {phase, category: networkCategory(error)}); }
    if (!response.ok) {
      const code = response.status === 401 ? 'IB_MCP_AUTHENTICATION_REJECTED'
        : response.status === 403 ? 'IB_MCP_PERMISSION_DENIED' : 'IB_MCP_HTTP_FAILED';
      const category = httpCategory(response.status, bearerError(response.headers));
      void response.body?.cancel().catch(() => {});
      fail(code, {phase, httpStatus: response.status, category});
    }
    const sessionId = response.headers.get('mcp-session-id');
    if (sessionId) {
      if (sessionId.length > 1024 || /[\r\n]/.test(sessionId)) fail('IB_MCP_SESSION_INVALID', {phase, category: 'response_invalid'});
      if (session.sessionId && session.sessionId !== sessionId) fail('IB_MCP_SESSION_CHANGED', {phase, category: 'response_invalid'});
      session.sessionId = sessionId;
    }
    try {
      if (notification) {
        const text=response.body?await bodyText(response):'';
        if(text.trim()){let value;try{value=strictMcpJson(text);}catch{fail('IB_MCP_RESPONSE_INVALID');}inspectMcpEnvelope(value,session.inspectEnvelope);}
        return;
      }
      return rpcMessage(await bodyText(response), response.headers.get('content-type') || '', id,session.inspectEnvelope);
    } catch (error) { throw inIbPhase(error, phase, 'IB_MCP_RESPONSE_INVALID', response.status,
      error?.message === 'IB_MCP_RPC_FAILED' ? 'rpc_error' : 'response_invalid'); }
}

// Catalog access is confined to this diagnostic session. Production retains
// its three-method whitelist; this session can call only the orders tool.
export class IbOrdersDiagnosticSession extends IbReadSession {
  async request(method, params, notification = false) {
    if (!['initialize', 'notifications/initialized', 'tools/list', 'tools/call'].includes(method)) fail('IB_MCP_METHOD_FORBIDDEN');
    if (method === 'tools/call' && (params?.name !== 'get_account_orders' || !argumentsAllowed(params.name, params.arguments))) fail('IB_MCP_TOOL_FORBIDDEN');
    if (method === 'tools/list' && (!this.initialized || !params || Object.keys(params).some(key => key !== 'cursor')
      || (Object.hasOwn(params, 'cursor') && (typeof params.cursor !== 'string' || !params.cursor || params.cursor.length > 1024)))) fail('IB_MCP_METHOD_FORBIDDEN');
    return sendRequest(this, method, params, notification);
  }
}

// Raw results remain in memory for the existing report controller to place in
// its private evidence store and verify against account-association policy.
async function captureSelected(store, options = {}, tools) {
  const credential = await loadReadCredential(store, options);
  const session = new IbReadSession(credential, options);
  await session.initialize();
  const sources = [];
  for (const tool of tools) {
    options.signal?.throwIfAborted();const clock=options.now??Date.now,startedAt = new Date(clock()).toISOString();
    sources.push({ ...await session.read(tool), startedAt, completedAt: new Date(clock()).toISOString() });
  }
  return { status: 'captured', sources };
}

export const captureCloudIbAction=(store,options)=>captureSelected(store,options,['get_account_summary','get_account_positions','get_account_orders']);
export const captureCloudIbFull=(store,options)=>captureSelected(store,options,Object.keys(SOURCES));
// Same original credential/client and fixed source whitelist, one orders read.
export const captureCloudIbOrders=(store,options)=>captureSelected(store,options,['get_account_orders']);
