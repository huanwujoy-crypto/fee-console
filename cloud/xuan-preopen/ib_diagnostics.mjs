// Closed diagnostic vocabulary. Never serialize an upstream Error or response.
const details = new WeakMap();
const phases = new Set(['unknown', 'credential_load', 'oauth_refresh', 'credential_save',
  'mcp_initialize', 'mcp_initialized', 'mcp_tools_list', 'mcp_summary_read',
  'mcp_positions_read', 'mcp_orders_read', 'mcp_balances_read', 'mcp_trades_read',
  'orders_decode', 'orders_validate', 'association_validate', 'attempt_claim', 'diagnostic_request']);
const categories = new Set(['unknown', 'invalid_grant', 'invalid_client', 'invalid_scope',
  'invalid_request', 'unauthorized_client', 'unsupported_grant_type', 'invalid_token',
  'insufficient_scope', 'authentication_rejected', 'permission_denied', 'rate_limited',
  'service_error', 'http_error', 'network', 'timeout', 'response_invalid', 'scope_invalid',
  'save_failed', 'save_outcome_unknown', 'rpc_error', 'tool_error', 'contract_invalid',
  'forbidden', 'attempt_consumed', 'attempt_outcome_unknown', 'counter_limit', 'policy_invalid']);
const codes = new Set([
  'IB_READ_ONLY_CREDENTIAL_REQUIRED', 'IB_CREDENTIAL_LOAD_FAILED', 'IB_EMPTY_RESPONSE',
  'IB_RESPONSE_TOO_LARGE', 'IB_INVALID_UTF8', 'IB_REFRESH_NETWORK_FAILED',
  'IB_REFRESH_HTTP_FAILED', 'IB_REFRESH_RESPONSE_INVALID', 'IB_REFRESH_SCOPE_INVALID',
  'IB_REFRESH_NOT_AUTHORIZED', 'IB_TOKEN_ROTATION_NOT_SAVED', 'IB_TOKEN_ROTATION_OUTCOME_UNKNOWN',
  'IB_MCP_RESPONSE_INVALID', 'IB_MCP_RPC_FAILED', 'IB_MCP_METHOD_FORBIDDEN',
  'IB_MCP_TOOL_FORBIDDEN', 'IB_MCP_NETWORK_FAILED', 'IB_MCP_AUTHENTICATION_REJECTED',
  'IB_MCP_PERMISSION_DENIED', 'IB_MCP_HTTP_FAILED', 'IB_MCP_SESSION_INVALID',
  'IB_MCP_SESSION_CHANGED', 'IB_MCP_HANDSHAKE_INVALID', 'IB_MCP_NOT_INITIALIZED',
  'IB_MCP_SOURCE_FAILED', 'IB_MCP_SOURCE_WRAPPER_INVALID', 'IB_MCP_SOURCE_SHAPE_INVALID',
  'IB_DIAGNOSTIC_REQUEST_INVALID', 'IB_DIAGNOSTIC_RUNTIME_REQUIRED',
  'IB_DIAGNOSTIC_CAPABILITY_REQUIRED', 'IB_DIAGNOSTIC_ATTEMPT_CONSUMED',
  'IB_DIAGNOSTIC_ATTEMPT_FAILED', 'IB_DIAGNOSTIC_ATTEMPT_OUTCOME_UNKNOWN',
  'IB_DIAGNOSTIC_LIMIT_EXCEEDED', 'IB_DIAGNOSTIC_TIMEOUT',
  'IB_DIAGNOSTIC_CATALOG_INVALID', 'IB_DIAGNOSTIC_CATALOG_INCOMPLETE',
  'IB_DIAGNOSTIC_ORDERS_TOOL_MISSING', 'IB_DIAGNOSTIC_ORDERS_SCHEMA_UNSUPPORTED',
  'IB_DIAGNOSTIC_ASSOCIATION_INVALID', 'IB_DIAGNOSTIC_ASSOCIATION_CHANGED',
  'IB_DIAGNOSTIC_ACCOUNT_MISMATCH', 'IB_DIAGNOSTIC_ORDERS_INVALID',
  'IB_DIAGNOSTIC_FAILED', 'DAILY_REPORT_FAILED', 'PRIVATE_REPORT_CHECK_FAILED',
  'DAILY_EXECUTION_REQUIRED', 'DAILY_REPORT_INCOMPLETE', 'OFFICIAL_CALENDAR_UNAVAILABLE',
  'COMPLETED_SESSION_UNAVAILABLE', 'CLOUD_EMPTY_RESPONSE', 'CLOUD_RESPONSE_TOO_LARGE',
  'CLOUD_INVALID_UTF8', 'CLOUD_NETWORK_FAILED', 'CLOUD_RESPONSE_INVALID',
  'CLOUD_IDENTITY_UNAVAILABLE', 'CLOUD_CREDENTIAL_UNAVAILABLE', 'CLOUD_IB_CREDENTIAL_UNAVAILABLE',
  'CLOUD_GATEWAY_CREDENTIAL_INVALID', 'PRIVATE_OBJECT_PATH_INVALID', 'PRIVATE_UPLOAD_NOT_CONFIRMED',
  'REPORT_SOURCE_NETWORK_FAILED', 'REPORT_SOURCE_JSON_INVALID', 'TRUSTED_MAIN_INVALID',
  'PREVIOUS_PUBLIC_META_INVALID', 'PREVIOUS_PUBLIC_HTML_MISMATCH', 'PENDING_CALL_LEDGER_INVALID',
  'PENDING_CALL_RESERVE_UNAVAILABLE', 'SHARESIGHT_READ_SCOPE_INVALID',
  'SHARESIGHT_GATEWAY_SCOPE_INVALID', 'COMPLETED_SOURCE_DATE_REQUIRED', 'PRIVATE_CLOUD_IO_REQUIRED',
  'ACTION_SOURCES_INCOMPLETE', 'REPORT_CROSSED_HKT_DATE', 'REPORT_BASE_CHANGED', 'PRIVATE_REPORT_CHECK_ONLY',
]);
const status = value => Number.isInteger(value) && value >= 100 && value <= 599 ? value : null;
const safeCode = value => codes.has(value) || (typeof value === 'string'
  && /^(?:CLOUD_HTTP|REPORT_SOURCE_HTTP)_[1-5]\d\d$/.test(value));

export function ibError(code, {phase = 'unknown', category = 'unknown', httpStatus = null} = {}) {
  const error = new Error(safeCode(code) ? code : 'IB_DIAGNOSTIC_FAILED');
  details.set(error, Object.freeze({phase: phases.has(phase) ? phase : 'unknown',
    category: categories.has(category) ? category : 'unknown', httpStatus: status(httpStatus)}));
  return error;
}

export function inIbPhase(error, phase, fallback, httpStatus = null, category = 'response_invalid') {
  const prior = details.get(error);
  return ibError(safeCode(error?.message) ? error.message : fallback,
    {phase, httpStatus: prior?.httpStatus ?? httpStatus, category: prior?.category !== 'unknown'
      && prior?.category ? prior.category : category});
}

export const networkCategory = error => ['TimeoutError', 'AbortError'].includes(error?.name) ? 'timeout' : 'network';
export function httpCategory(httpStatus, oauthError = null) {
  if (httpStatus === 429) return 'rate_limited';
  if (httpStatus >= 500 && httpStatus <= 599) return 'service_error';
  if (['invalid_grant', 'invalid_client', 'invalid_scope', 'invalid_request',
    'unauthorized_client', 'unsupported_grant_type', 'invalid_token', 'insufficient_scope'].includes(oauthError)) return oauthError;
  if (httpStatus === 401) return 'authentication_rejected';
  if (httpStatus === 403) return 'permission_denied';
  return 'http_error';
}

export function bearerError(headers) {
  const challenge = headers?.get('www-authenticate');
  if (typeof challenge !== 'string' || challenge.length > 4096 || !/^Bearer\s/i.test(challenge)) return null;
  const matches = [...challenge.matchAll(/(?:^|[,\s])error="([a-z_]+)"/g)];
  if (matches.length !== 1) return null;
  return ['invalid_token', 'insufficient_scope', 'invalid_request'].includes(matches[0][1]) ? matches[0][1] : null;
}

const safeDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value + 'T00:00:00Z'))
  && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
export function safeIbFailure(error, {fallback = 'IB_DIAGNOSTIC_FAILED', execution, dataDate, sourceDate} = {}) {
  const d = details.get(error);
  const result = {status: 'failed', code: safeCode(error?.message) ? error.message
    : safeCode(fallback) ? fallback : 'IB_DIAGNOSTIC_FAILED', phase: d?.phase ?? 'unknown',
    category: d?.category ?? 'unknown', httpStatus: d?.httpStatus ?? null, publication: 'none'};
  if (typeof execution === 'string' && /^xuan-preopen-(?:report|auth-orders-check)-[a-z0-9-]{1,100}$/.test(execution)) result.execution = execution;
  if (safeDate(dataDate)) result.dataDate = dataDate;
  if (safeDate(sourceDate)) result.sourceDate = sourceDate;
  return result;
}
