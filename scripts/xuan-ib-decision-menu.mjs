#!/usr/bin/env node

// Read-only adapters for the native Shortcut menu. Neither function fetches
// financial data, writes a receipt, starts a Routine, or changes the report.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

export const RESPONSE_KIND = 'xuan-ib-decision-response';
export const ACCEPTED_SUMMARY = '采纳 Claude 意见；只记录，不执行';
export const DEFERRED_SUMMARY = '稍后决定；保留待办';
export const RESPONSE_TTL_MS = 20 * 60_000;
const MAX_FUTURE_MS = 60_000;
const HASH = /^[0-9a-f]{40}$/i;
const DECISION_ID = /^D-[0-9]{8}-[A-Z0-9-]{1,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STATUSES = new Set(['awaiting_user', 'accepted', 'modified', 'rejected', 'superseded']);
const ACTIONS = new Set(['accepted', 'modified', 'deferred']);
const fail = message => { throw new Error(`XUAN-IB decision menu: ${message}`); };

const exactKeys = (value, fields, label) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(`${label} must be an object`);
  const keys = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    fail(`${label} has missing or unknown fields`);
  }
};

// Same duplicate-key-rejecting recursive descent as handover-guard.mjs; do not
// replace this with JSON.parse, which silently accepts the last duplicate key.
export function parseDecisionJson(source, maxLength = 65_536) {
  if (typeof source !== 'string' || source.length > maxLength) fail(`JSON input must be at most ${maxLength} characters`);
  let index = 0;
  const ws = () => { while (/[ \t\r\n]/.test(source[index] || '')) index++; };
  const string = () => {
    const start = index++;
    let escaped = false;
    while (index < source.length) {
      const char = source[index++];
      if (!escaped && char === '"') {
        try { return JSON.parse(source.slice(start, index)); }
        catch { throw new Error('invalid escaped JSON string'); }
      }
      if (!escaped && char.charCodeAt(0) < 32) throw new Error('control character');
      escaped = !escaped && char === '\\';
    }
    throw new Error('unterminated string');
  };
  const value = (depth = 0) => {
    if (depth > 32) throw new Error('JSON nesting exceeds limit');
    ws();
    if (source[index] === '"') return string();
    if (source[index] === '{') {
      index++; ws();
      const result = Object.create(null);
      if (source[index] === '}') { index++; return result; }
      while (index < source.length) {
        ws();
        if (source[index] !== '"') throw new Error('object key must be quoted');
        const key = string();
        if (Object.hasOwn(result, key)) throw new Error('duplicate key');
        ws();
        if (source[index++] !== ':') throw new Error('missing colon');
        result[key] = value(depth + 1); ws();
        if (source[index] === '}') { index++; return result; }
        if (source[index++] !== ',') throw new Error('missing comma');
      }
      throw new Error('unterminated object');
    }
    if (source[index] === '[') {
      index++; ws();
      const result = [];
      if (source[index] === ']') { index++; return result; }
      while (index < source.length) {
        result.push(value(depth + 1)); ws();
        if (source[index] === ']') { index++; return result; }
        if (source[index++] !== ',') throw new Error('missing comma');
      }
      throw new Error('unterminated array');
    }
    const token = source.slice(index).match(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/)?.[0];
    if (!token) throw new Error('invalid value');
    index += token.length;
    return JSON.parse(token);
  };
  try {
    const result = value(); ws();
    if (index !== source.length) throw new Error('trailing JSON content');
    return result;
  } catch (error) { fail(`invalid strict JSON: ${error.message}`); }
}

const calendarDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
  && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

const instant = (value, label) => {
  if (typeof value !== 'string') fail(`${label} must be an ISO timestamp`);
  const m = value.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/);
  if (!m || !calendarDate(m[1]) || +m[2] > 23 || +m[3] > 59 || +m[4] > 59
      || (m[6] !== 'Z' && (+m[8] > 14 || +m[9] > 59 || (+m[8] === 14 && +m[9] !== 0)))) {
    fail(`${label} must be a real ISO timestamp with an explicit offset`);
  }
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch)) fail(`${label} is invalid`);
  return epoch;
};

export function validateDecisionPublicSummary(summary) {
  if (typeof summary !== 'string' || summary.trim() !== summary || !summary.length || [...summary].length > 120) {
    fail('publicSummary must be trimmed text of 1 to 120 Unicode code points');
  }
  // At least as strict as the public-receipt guard, including invisible
  // controls; additionally reject contact details and unseparated CJK amounts.
  if (/[<>&\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069]/u.test(summary)
      || /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u.test(summary)) fail('publicSummary contains unsafe characters');
  if (/(?:https?:\/\/|www\.|\b[a-z][a-z0-9+.-]*:\/\/|\bmailto:)/iu.test(summary)) fail('publicSummary contains a URL');
  if (/(?:github_pat_|gh[pousr]_|\bsk-[A-Za-z0-9_-]{12,}|\bBearer\s+|(?:token|password|secret|api[_ -]?key)\s*[:=])/iu.test(summary)) fail('publicSummary contains a credential');
  if (/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/iu.test(summary)) fail('publicSummary contains private contact information');
  if (/\b\d{8,}\b/u.test(summary) || /\b[UF]\d{6,}\b/iu.test(summary)
      || /(?:账户|账号|帐号|account|portfolio)\s*(?:为|是)?\s*[:#：-]?\s*[A-Z0-9-]{5,}/iu.test(summary)) fail('publicSummary contains an account number');
  if (/(?:买入|卖出|下单|撤单|改单|换汇|转账|\bbuy\b|\bsell\b|\border\b|\btransfer\b)/iu.test(summary)
      || /(?:[$€£¥]\s*\d|\d+(?:\.\d+)?\s*股|\b\d+(?:\.\d+)?\s*shares?\b|@\s*\d|\b(?:USD|HKD|CAD|EUR|GBP|CNY|RMB)\s*\d|(?:价格|成交价|限价|单价)\s*[:：=]?\s*\d)/iu.test(summary)) fail('publicSummary contains a financial instruction');
  return summary;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ', ndash: '–', mdash: '—', hellip: '…', le: '≤', ge: '≥', times: '×', middot: '·' };
const decode = text => text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]+);/gi, (_, entity) => {
  if (entity[0] !== '#') {
    if (!Object.hasOwn(ENTITIES, entity)) fail(`unsupported HTML entity &${entity}; in menu text; add explicit structure`);
    return ENTITIES[entity];
  }
  const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
  if (code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) fail('invalid HTML character reference');
  return String.fromCodePoint(code);
});
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

// A deliberately strict tree parser for the already-paired, self-contained
// report. It tracks nesting (including nested details) like the guard's card
// parser, never extracts a recommendation using a regex spanning HTML tags,
// and rejects browser error-recovery constructs instead of guessing their DOM.
function parseReportTree(html) {
  const root = { tag: '#document', attrs: {}, children: [] };
  const stack = [root];
  let index = 0;
  const append = node => { node.parent = stack.at(-1); stack.at(-1).children.push(node); };
  while (index < html.length) {
    if (html.startsWith('<!--', index)) {
      const end = html.indexOf('-->', index + 4);
      if (end < 0) fail('unclosed HTML comment');
      index = end + 3; continue;
    }
    if (/^<!doctype\s+html\s*>/i.test(html.slice(index))) {
      index += html.slice(index).match(/^<!doctype\s+html\s*>/i)[0].length; continue;
    }
    if (html[index] !== '<' || !/^<\/?[a-z]/i.test(html.slice(index))) {
      const end = html.indexOf('<', index + 1);
      append({ tag: '#text', text: html.slice(index, end < 0 ? html.length : end) });
      index = end < 0 ? html.length : end; continue;
    }
    const start = index;
    let quote = '';
    while (++index < html.length) {
      const char = html[index];
      if (quote) { if (char === quote) quote = ''; }
      else if (char === '"' || char === "'") quote = char;
      else if (char === '>') break;
    }
    if (index === html.length) fail('unclosed HTML tag');
    const token = html.slice(start, ++index);
    const closing = token.match(/^<\/([a-z][a-z0-9-]*)\s*>$/i);
    if (closing) {
      if (stack.length < 2 || stack.at(-1).tag !== closing[1].toLowerCase()) fail('unbalanced HTML tags; add explicit menu structure');
      stack.at(-1).closeStart = start;
      stack.at(-1).end = index;
      stack.pop(); continue;
    }
    const match = token.match(/^<([a-z][a-z0-9-]*)([\s\S]*?)\/?\s*>$/i);
    if (!match) fail('unsupported HTML tag');
    const node = { tag: match[1].toLowerCase(), attrs: Object.create(null), children: [], start, openEnd: index };
    let rest = match[2];
    while (rest.trim()) {
      const attribute = rest.match(/^\s+([^\s="'<>`/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/);
      if (!attribute) fail('malformed HTML attribute');
      const name = attribute[1].toLowerCase();
      if (Object.hasOwn(node.attrs, name)) fail(`duplicate HTML attribute ${name}`);
      node.attrs[name] = decode(attribute[2] ?? attribute[3] ?? attribute[4] ?? '');
      rest = rest.slice(attribute[0].length);
    }
    append(node);
    if (['script', 'style'].includes(node.tag)) {
      const close = new RegExp(`</${node.tag}\\s*>`, 'ig'); close.lastIndex = index;
      const end = close.exec(html);
      if (!end) fail(`unclosed ${node.tag}`);
      node.children.push({ tag: '#text', text: html.slice(index, end.index), parent: node });
      node.closeStart = end.index;
      node.end = close.lastIndex;
      index = close.lastIndex; continue;
    }
    if (!VOID_TAGS.has(node.tag)) {
      if (/\/\s*>$/.test(token)) fail('self-closing non-void HTML tag');
      stack.push(node);
      if (stack.length > 100) fail('HTML nesting exceeds limit');
    }
  }
  if (stack.length !== 1) fail('unclosed HTML element');
  return root;
}

const descendants = node => (node.children || []).flatMap(child => [child, ...descendants(child)]);
const hasClass = (node, name) => (node.attrs?.class || '').split(/\s+/).includes(name);
const textContent = (node, excluded = () => false) => excluded(node) ? '' : node.tag === '#text'
  ? decode(node.text) : (node.children || []).map(child => textContent(child, excluded)).join('');
const plainText = (node, excluded) => textContent(node, excluded).replace(/\s+/gu, ' ').trim();
const single = (nodes, label) => { if (nodes.length !== 1) fail(`${label} must be unique; add explicit menu structure`); return nodes[0]; };

function pairedPublication({ html, meta }) {
  if (typeof html !== 'string' || Buffer.byteLength(html) >= 2_000_000) fail('report must be UTF-8 HTML below 2MB');
  if (typeof meta === 'string') meta = parseDecisionJson(meta);
  exactKeys(meta, ['schemaVersion', 'sourceSha', 'sourceCommitEpoch', 'dataDate', 'htmlBlob'], 'publication metadata');
  if (meta.schemaVersion !== 1 || !HASH.test(meta.sourceSha) || !HASH.test(meta.htmlBlob)
      || !calendarDate(meta.dataDate) || !Number.isInteger(meta.sourceCommitEpoch) || meta.sourceCommitEpoch <= 0) fail('invalid publication metadata');
  const blob = crypto.createHash('sha1').update(`blob ${Buffer.byteLength(html)}\0`).update(html).digest('hex');
  if (blob !== meta.htmlBlob.toLowerCase()) fail('metadata and HTML are not the same publication');
  if ((html.match(/<!--\s*xuan-ib-handover:v1\s*-->/g) || []).length !== 1) fail('publication marker must be unique');
  return { html, meta };
}

function verifiedReport(input) {
  const { html, meta } = pairedPublication(input);
  const tree = parseReportTree(html);
  const elements = descendants(tree).filter(node => node.tag !== '#text');
  single(elements.filter(node => node.tag === 'html'), 'html document');
  const body = single(elements.filter(node => node.tag === 'body'), 'report body');
  const bodyElements = descendants(body).filter(node => node.tag !== '#text');
  const dates = bodyElements.filter(node => node.tag === 'span' && hasClass(node, 'date'));
  if (!plainText(single(dates, 'data-date header')).startsWith(meta.dataDate + ' ')) fail('report data date does not match metadata');
  const template = single(elements.filter(node => node.attrs.id === 'xuan-ib-decision-state-v1'), 'decision template');
  if (template.tag !== 'template' || !bodyElements.includes(template)) fail('decision template must be inside the report body');
  if (template.children.some(node => node.tag !== '#text')) fail('decision template must contain inert JSON only');
  // A template's raw text must not be entity-decoded before strict JSON parsing.
  const state = parseDecisionJson(template.children.map(node => node.text).join(''), 2_000_000);
  exactKeys(state, ['schemaVersion', 'interaction', 'decisions', 'receipts'], 'decision state');
  if (state.schemaVersion !== 1 || !['enabled', 'disabled'].includes(state.interaction)
      || !Array.isArray(state.decisions) || !Array.isArray(state.receipts)
      || state.decisions.length > 1000) fail('invalid decision state');
  const ids = new Set();
  for (const item of state.decisions) {
    exactKeys(item, ['decisionId', 'status'], 'decision');
    if (!DECISION_ID.test(item.decisionId) || !STATUSES.has(item.status) || ids.has(item.decisionId)) fail('invalid or duplicate decision');
    ids.add(item.decisionId);
  }
  const receiptIds = new Set();
  for (const receipt of state.receipts) {
    exactKeys(receipt, ['receiptId', 'decisionId', 'action', 'responseToSourceSha', 'responseToHtmlBlob', 'recordedAtHkt', 'publicSummary'], 'receipt');
    if (!/^R-\d{8}-\d{6}-[A-Z0-9]{8}$/.test(receipt.receiptId) || receiptIds.has(receipt.receiptId)
        || !ids.has(receipt.decisionId) || !ACTIONS.has(receipt.action)
        || !HASH.test(receipt.responseToSourceSha) || !HASH.test(receipt.responseToHtmlBlob)
        || !receipt.recordedAtHkt.endsWith('+08:00')) fail('invalid or duplicate receipt');
    instant(receipt.recordedAtHkt, 'receipt timestamp');
    validateDecisionPublicSummary(receipt.publicSummary);
    receiptIds.add(receipt.receiptId);
  }
  const latestReceipts = new Map();
  for (const receipt of state.receipts) {
    const previous = latestReceipts.get(receipt.decisionId);
    if (!previous || Date.parse(receipt.recordedAtHkt) > Date.parse(previous.recordedAtHkt)
        || (receipt.recordedAtHkt === previous.recordedAtHkt && receipt.receiptId > previous.receiptId)) latestReceipts.set(receipt.decisionId, receipt);
  }
  for (const item of state.decisions) {
    const receipt = latestReceipts.get(item.decisionId);
    if (['accepted', 'modified'].includes(item.status) && !receipt) fail('resolved decision is missing its receipt');
    if (receipt && ((receipt.action === 'deferred' && item.status !== 'awaiting_user')
        || (receipt.action === 'accepted' && !['accepted', 'superseded'].includes(item.status))
        || (receipt.action === 'modified' && !['modified', 'superseded'].includes(item.status)))) fail('receipt and decision status disagree');
  }
  const marked = bodyElements.filter(node => Object.hasOwn(node.attrs, 'data-decision-id') || Object.hasOwn(node.attrs, 'data-decision-status'));
  if (marked.length !== state.decisions.length) fail('decision markup does not match machine state');
  const cards = new Map();
  for (const item of state.decisions) {
    const card = single(marked.filter(node => node.attrs['data-decision-id'] === item.decisionId), `card ${item.decisionId}`);
    if (card.tag !== 'details' || card.attrs.id !== item.decisionId || card.attrs['data-decision-status'] !== item.status
        || bodyElements.filter(node => node.attrs.id === item.decisionId).length !== 1) fail('decision card identity/status mismatch');
    cards.set(item.decisionId, card);
  }
  return { meta, state, cards };
}

/** Exact visible card fragments from the SAME validated tree as the menu.
 * Comments/script strings cannot impersonate cards. No opinion is rewritten.
 */
export function extractPairedDecisionCardFragments(input) {
  const { cards } = verifiedReport(input);
  return new Map([...cards].map(([decisionId, card]) => {
    const summary = single(card.children.filter(node => node.tag === 'summary'), `summary ${decisionId}`);
    if (!Number.isInteger(summary.end) || !Number.isInteger(card.closeStart)
        || summary.end > card.closeStart) fail('invalid decision card bounds');
    return [decisionId, {
      prefix: input.html.slice(card.start, summary.end),
      body: input.html.slice(summary.end, card.closeStart)
    }];
  }));
}

/** Build a read-only manifest from the canonical paired publication. */
export function buildDecisionMenu(input) {
  const { meta, state, cards } = verifiedReport(input);
  const pending = state.decisions.filter(item => item.status === 'awaiting_user').map(item => {
    const card = cards.get(item.decisionId);
    const summary = single(card.children.filter(node => node.tag === 'summary'), `summary ${item.decisionId}`);
    const title = plainText(summary, node => hasClass(node, 'rt')).replace(/^\d+\s*[·.、]\s*/u, '');
    const labels = descendants(card).filter(node => node.tag === 'b' && hasClass(node, 'lab')
      && /^Claude\s*意见[：:]$/u.test(plainText(node)));
    const label = single(labels, `Claude recommendation ${item.decisionId}`);
    const leading = label.parent.children.slice(0, label.parent.children.indexOf(label));
    if (label.parent.tag !== 'p' || leading.some(node => node.tag !== '#text' || plainText(node) !== '')) {
      fail('Claude recommendation must have an explicit leading label in its own paragraph');
    }
    const recommendation = plainText(label.parent, node => node === label);
    if (!title || !recommendation || [...title].length > 240 || [...recommendation].length > 2000) fail('menu title/recommendation is missing or too long; add explicit menu structure');
    return { decisionId: item.decisionId, title, recommendation };
  });
  return {
    schemaVersion: 1, kind: 'xuan-ib-decision-menu', sourceSha: meta.sourceSha.toLowerCase(),
    htmlBlob: meta.htmlBlob.toLowerCase(), dataDate: meta.dataDate, interaction: state.interaction, pending
  };
}

/** Display-only extraction must not prevent a verified financial report from
 * publishing. A failed extraction disables this auxiliary menu explicitly;
 * metadata/HTML mismatches still throw, never publishing a mislabeled fallback.
 */
export function buildPublishedDecisionMenu(input) {
  const { meta } = pairedPublication(input);
  try { return { ...buildDecisionMenu(input), available: true }; }
  catch {
    return {
      schemaVersion: 1, kind: 'xuan-ib-decision-menu', sourceSha: meta.sourceSha.toLowerCase(),
      htmlBlob: meta.htmlBlob.toLowerCase(), dataDate: meta.dataDate,
      interaction: 'disabled', pending: [], available: false,
      unavailableReason: '待办菜单暂不可用，请在 Claude 查看；报告仍可阅读。'
    };
  }
}

/** Validate explicit choices; transport authentication remains the caller's job.
 * A valid payload records an opinion only. It is never financial authority.
 * submittedAt must be set after the native menu's final, exact-text confirmation.
 */
function requestEnvelope(request) {
  if (typeof request === 'string') request = parseDecisionJson(request);
  exactKeys(request, ['schemaVersion', 'kind', 'requestId', 'sourceSha', 'htmlBlob', 'submittedAt', 'selections'], 'request');
  if (request.schemaVersion !== 1 || request.kind !== RESPONSE_KIND || !UUID.test(request.requestId)
      || !HASH.test(request.sourceSha) || !HASH.test(request.htmlBlob)) fail('invalid request identity');
  instant(request.submittedAt, 'submittedAt');
  if (!Array.isArray(request.selections) || request.selections.length < 1 || request.selections.length > 50) fail('request must contain 1 to 50 explicit selections; cancellation must not POST');
  const selected = new Set();
  const selections = request.selections.map(item => {
    exactKeys(item, ['decisionId', 'action', 'publicSummary'], 'selection');
    if (!DECISION_ID.test(item.decisionId)) fail('selection has an invalid decisionId');
    if (selected.has(item.decisionId)) fail('duplicate selection for a decision');
    if (!ACTIONS.has(item.action)) fail('selection action must be accepted, modified or deferred');
    validateDecisionPublicSummary(item.publicSummary);
    if (item.action === 'accepted' && item.publicSummary !== ACCEPTED_SUMMARY) fail('accepted selection requires the fixed publicSummary');
    if (item.action === 'deferred' && item.publicSummary !== DEFERRED_SUMMARY) fail('deferred selection requires the fixed publicSummary');
    selected.add(item.decisionId);
    return { decisionId: item.decisionId, action: item.action, publicSummary: item.publicSummary };
  });
  return {
    schemaVersion: 1, kind: RESPONSE_KIND, requestId: request.requestId.toLowerCase(), sourceSha: request.sourceSha.toLowerCase(),
    htmlBlob: request.htmlBlob.toLowerCase(), submittedAt: request.submittedAt, selections
  };
}

export function validateDecisionRequest(request, { html, meta, now = Date.now() }) {
  const normalized = requestEnvelope(request);
  const submittedAt = Date.parse(normalized.submittedAt);
  const nowEpoch = now instanceof Date ? now.valueOf() : Number(now);
  if (!Number.isFinite(nowEpoch)) fail('invalid validation clock');
  if (submittedAt > nowEpoch + MAX_FUTURE_MS) fail('submittedAt is in the future');
  if (nowEpoch - submittedAt > RESPONSE_TTL_MS) fail('request expired; choose again using the current report');
  const menu = buildDecisionMenu({ html, meta });
  if (menu.interaction !== 'enabled') fail('decision interaction is disabled');
  if (normalized.sourceSha !== menu.sourceSha || normalized.htmlBlob !== menu.htmlBlob) fail('stale baseline; reload and reconfirm, do not rebase choices');
  const pendingIds = new Set(menu.pending.map(item => item.decisionId));
  if (normalized.selections.some(item => !pendingIds.has(item.decisionId))) fail('selection is not a current awaiting_user decision');
  return normalized;
}

/** Stable receipt identity: retrying the same request cannot mint a new ID. */
export function deriveReceiptId(request, decisionId) {
  if (!UUID.test(request?.requestId) || !DECISION_ID.test(decisionId)) fail('invalid receipt derivation identity');
  const submittedAt = instant(request.submittedAt, 'submittedAt');
  const hkt = new Date(submittedAt + 8 * 60 * 60_000).toISOString().slice(0, 19);
  const date = hkt.slice(0, 10).replaceAll('-', '');
  const time = hkt.slice(11, 19).replaceAll(':', '');
  const suffix = crypto.createHash('sha256').update(request.requestId.toLowerCase()).update('\0').update(decisionId).digest('hex').slice(0, 8).toUpperCase();
  return `R-${date}-${time}-${suffix}`;
}

/** Run BEFORE new-request freshness/baseline validation. Exact historical replay
 * is an acknowledgement only, even if the publication or TTL has since changed.
 * This never grants permission to append to the current report. Partial batches
 * and ID collisions stop for reconciliation instead of creating another receipt.
 */
export function checkDecisionRequestReplay(request, { html, meta }) {
  const normalized = requestEnvelope(request);
  const { state } = verifiedReport({ html, meta });
  const byId = new Map(state.receipts.map(receipt => [receipt.receiptId, receipt]));
  const receiptIds = normalized.selections.map(item => deriveReceiptId(normalized, item.decisionId));
  const sameContent = (receipt, item) => receipt.decisionId === item.decisionId && receipt.action === item.action
    && receipt.responseToSourceSha.toLowerCase() === normalized.sourceSha
    && receipt.responseToHtmlBlob.toLowerCase() === normalized.htmlBlob
    && receipt.publicSummary === item.publicSummary;
  let matched = 0;
  normalized.selections.forEach((item, index) => {
    const receipt = byId.get(receiptIds[index]);
    if (receipt && !sameContent(receipt, item)) fail('receipt identity conflict; never overwrite or retry with a new ID');
    // A new Shortcut run generates a new UUID. The immutable content key must
    // also de-duplicate this semantic replay against the same report baseline.
    const contentMatch = receipt || state.receipts.find(candidate => sameContent(candidate, item));
    if (contentMatch) { receiptIds[index] = contentMatch.receiptId; matched++; }
  });
  if (matched > 0 && matched !== normalized.selections.length) fail('partial request already recorded; reconcile without appending duplicates');
  return { status: matched ? 'already_recorded' : 'not_recorded', receiptIds };
}

/** Useful for deduplicating retries without publishing a new receipt field.
 * The caller must keep the same requestId and payload on uncertain API retries.
 */
export function decisionRequestDigest(validatedRequest) {
  return crypto.createHash('sha256').update(JSON.stringify(validatedRequest)).digest('hex');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [command, metaFile, htmlFile, requestFile] = process.argv.slice(2);
    if (!['manifest', 'publish-manifest', 'validate', 'replay'].includes(command) || !metaFile || !htmlFile || (!['manifest', 'publish-manifest'].includes(command) && !requestFile)) {
      fail('usage: xuan-ib-decision-menu.mjs manifest|publish-manifest META HTML | validate|replay META HTML REQUEST');
    }
    const input = { meta: fs.readFileSync(metaFile, 'utf8'), html: fs.readFileSync(htmlFile, 'utf8') };
    const result = command === 'manifest' ? buildDecisionMenu(input)
      : command === 'publish-manifest' ? buildPublishedDecisionMenu(input)
      : command === 'replay' ? checkDecisionRequestReplay(fs.readFileSync(requestFile, 'utf8'), input)
        : (() => {
          const validated = validateDecisionRequest(fs.readFileSync(requestFile, 'utf8'), input);
          return { status: 'valid', selectionCount: validated.selections.length,
            receiptIds: validated.selections.map(item => deriveReceiptId(validated, item.decisionId)) };
        })();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
