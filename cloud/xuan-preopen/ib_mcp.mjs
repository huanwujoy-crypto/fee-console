// Official IBKR MCP transport for the cloud action report. No model or trading
// dispatcher is involved. Credentials belong in a private cloud secret store.
import { decodeHookResponse } from '../../scripts/xuan-ib-hook-response.mjs';

export const RESOURCE = 'https://api.ibkr.com/v1/api/mcp-public';
const TOKEN_ENDPOINT = 'https://api.ibkr.com/oauth2/api/v1/token';
const MAX_BYTES = 8_000_000;
const SOURCES = Object.freeze({
  get_account_summary: 'ib.accountSummary',
  get_account_positions: 'ib.positions',
  get_account_orders: 'ib.orders',
  get_account_trades: 'ib.trades',
});
export const TRADE_READ_ARGUMENTS = Object.freeze({ period: 'DAYS_7' });
const allowedArguments = (tool, args) => tool === 'get_account_trades'
  ? args && Object.keys(args).length === 1 && args.period === 'DAYS_7'
  : args && Object.keys(args).length === 0;
const fail = code => { throw new Error(code); };
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

async function bodyText(response) {
  if (!response.body) fail('IB_EMPTY_RESPONSE');
  const reader = response.body.getReader();
  const chunks = []; let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BYTES) fail('IB_RESPONSE_TOO_LARGE');
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel().catch(() => {}); }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); }
  catch { fail('IB_INVALID_UTF8'); }
}

export async function loadReadCredential(store, { fetchImpl = fetch, now = Date.now } = {}) {
  const original = validateCredential(await store.load());
  if (original.expires_at > now() + 120_000) return original;
  let response;
  try {
    response = await fetchImpl(TOKEN_ENDPOINT, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: original.client_id,
        refresh_token: original.refresh_token, scope: 'mcp.read', resource: RESOURCE }),
    });
  } catch { fail('IB_REFRESH_NETWORK_FAILED'); }
  if (!response.ok) fail('IB_REAUTHORIZE_REQUIRED');
  let token;
  try { token = JSON.parse(await bodyText(response)); } catch { fail('IB_REFRESH_RESPONSE_INVALID'); }
  if (!token.access_token || token.token_type?.toLowerCase() !== 'bearer'
    || !Number.isFinite(token.expires_in) || token.expires_in <= 0
    || (token.scope !== undefined && !exactReadScope(token.scope))) fail('IB_REFRESH_SCOPE_INVALID');
  const next = validateCredential({ ...original, access_token: token.access_token,
    refresh_token: token.refresh_token || original.refresh_token, token_type: token.token_type,
    expires_at: now() + token.expires_in * 1000, scope: 'mcp.read', obtained_at: new Date(now()).toISOString() });
  // Persist rotation before any source read. Failure cannot fall back to the old
  // token or leave a report successful while its next run loses authorization.
  try { await store.save(next); } catch { fail('IB_TOKEN_ROTATION_NOT_SAVED'); }
  return next;
}

function rpcMessage(text, contentType, id) {
  let messages;
  try {
    messages = contentType.includes('text/event-stream')
      ? text.split(/\r?\n\r?\n/).filter(block => /^data:/m.test(block))
        .map(block => JSON.parse(block.split(/\r?\n/).filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).trimStart()).join('\n')))
      : [JSON.parse(text)];
  } catch { fail('IB_MCP_RESPONSE_INVALID'); }
  const matches = messages.filter(message => message?.id === id);
  if (matches.length !== 1 || matches[0].jsonrpc !== '2.0' || matches[0].error
    || !Object.hasOwn(matches[0], 'result')) fail('IB_MCP_RPC_FAILED');
  return matches[0].result;
}

export class IbReadSession {
  constructor(credential, { fetchImpl = fetch } = {}) {
    this.credential = validateCredential(credential); this.fetchImpl = fetchImpl;
    this.id = 0; this.sessionId = null; this.initialized = false;
  }
  async request(method, params, notification = false) {
    if (!['initialize', 'notifications/initialized', 'tools/call'].includes(method)) fail('IB_MCP_METHOD_FORBIDDEN');
    if (method === 'tools/call' && (!Object.hasOwn(SOURCES, params?.name)
      || !allowedArguments(params.name, params.arguments))) fail('IB_MCP_TOOL_FORBIDDEN');
    const id = ++this.id;
    const payload = { jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }), ...(notification ? {} : { id }) };
    const headers = { Authorization: `Bearer ${this.credential.access_token}`,
      'content-type': 'application/json', Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2025-03-26' };
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    let response;
    try { response = await this.fetchImpl(RESOURCE, { method: 'POST', redirect: 'error',
      signal: AbortSignal.timeout(30_000), headers, body: JSON.stringify(payload) }); }
    catch { fail('IB_MCP_NETWORK_FAILED'); }
    if (response.status === 401 || response.status === 403) fail('IB_REAUTHORIZE_REQUIRED');
    if (!response.ok) fail('IB_MCP_HTTP_FAILED');
    const session = response.headers.get('mcp-session-id');
    if (session) {
      if (session.length > 1024 || /[\r\n]/.test(session)) fail('IB_MCP_SESSION_INVALID');
      if (this.sessionId && this.sessionId !== session) fail('IB_MCP_SESSION_CHANGED');
      this.sessionId = session;
    }
    if (notification && (response.status === 202 || response.status === 204)) return;
    if (notification) { await bodyText(response); return; }
    return rpcMessage(await bodyText(response), response.headers.get('content-type') || '', id);
  }
  async initialize() {
    const result = await this.request('initialize', { protocolVersion: '2025-03-26', capabilities: {},
      clientInfo: { name: 'xuan-preopen-readonly', version: '1.0.0' } });
    if (!result?.capabilities?.tools || result.protocolVersion !== '2025-03-26') fail('IB_MCP_HANDSHAKE_INVALID');
    await this.request('notifications/initialized', undefined, true);
    this.initialized = true;
  }
  async read(tool) {
    if (!this.initialized) fail('IB_MCP_NOT_INITIALIZED');
    if (!Object.hasOwn(SOURCES, tool)) fail('IB_MCP_TOOL_FORBIDDEN');
    const result = await this.request('tools/call', { name: tool, arguments: tool === 'get_account_trades' ? TRADE_READ_ARGUMENTS : {} });
    if (!result || result.isError === true) fail('IB_MCP_SOURCE_FAILED');
    const sourceKey = SOURCES[tool];
    const transport = result.structuredContent ?? (() => {
      if (!Array.isArray(result.content) || result.content.length !== 1 || result.content[0].type !== 'text')
        fail('IB_MCP_SOURCE_WRAPPER_INVALID');
      return result.content[0].text;
    })();
    try { return { sourceKey, ...decodeHookResponse(transport, { sourceKey }) }; }
    catch { fail('IB_MCP_SOURCE_SHAPE_INVALID'); }
  }
}

// Raw results remain in memory for the existing report controller to place in
// its private evidence store and verify against account-association policy.
export async function captureCloudIbAction(store, options = {}) {
  const credential = await loadReadCredential(store, options);
  const session = new IbReadSession(credential, options);
  await session.initialize();
  const sources = [];
  for (const tool of Object.keys(SOURCES)) {
    const startedAt = new Date().toISOString();
    sources.push({ ...await session.read(tool), startedAt, completedAt: new Date().toISOString() });
  }
  return { status: 'captured', sources };
}
