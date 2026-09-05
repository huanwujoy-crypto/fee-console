// Pure publication contract. The operational handover guard obtains its policy
// from a fresh trusted-main read; a caller-provided snapshot is not publication
// permission and cannot replace the independent Validate / Promote reads.
import {
  extractAssociationReceipt,
  renderAssociationDisclosure,
  validateAssociationSnapshot,
  validatePublicationAssociation,
} from './xuan-ib-account-association.mjs';

export const ASSOCIATION_BODY_ATTRIBUTE = 'data-account-scope-basis="owner-attested-recurring-v1"';
export const ASSOCIATION_TEMPLATE_ID = 'xuan-ib-account-association-v1';
const fail = message => { throw new Error(`account association publication: ${message}`); };
const stripInert = html => html
  .replace(/<(script|style|template|textarea|title|noscript|iframe|noembed|noframes|xmp)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, match => ' '.repeat(match.length))
  .replace(/<!--[\s\S]*?-->/g, match => ' '.repeat(match.length));
const textContent = html => html.replace(/<[^>]*>/g, ' ').replace(/&#(?:x([\da-f]+)|(\d+));?/gi, (_, hex, decimal) => {
  const value = Number.parseInt(hex ?? decimal, hex ? 16 : 10);
  return value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : '\ufffd';
}).replace(/\s+/g, ' ').trim();

export function publicationEdition(html) {
  const visible = stripInert(html);
  const dates = [...visible.matchAll(/<span\b[^>]*\bclass\s*=\s*(["'])([^"']*)\1[^>]*>([\s\S]*?)<\/span\s*>/gi)]
    .filter(match => match[2].split(/\s+/).includes('date'));
  if (dates.length !== 1) fail('one primary data-date header is required');
  const editions = { '临时版': 'adhoc', '睡前版': 'pm', '早间版': 'am' };
  const primary = textContent(dates[0][3]);
  const primaryMatches = [...primary.matchAll(/(?:^|[·・|\s])(临时版|睡前版|早间版)(?=$|[·・|\s])/g)];
  if (primaryMatches.length === 1) return editions[primaryMatches[0][1]];
  if (primaryMatches.length > 1) fail('primary header has ambiguous report editions');
  // Preserve the pre-compact canonical p.edition header form.
  const explicit = [...visible.matchAll(/<p\b[^>]*\bclass\s*=\s*(["'])([^"']*)\1[^>]*>([\s\S]*?)<\/p\s*>/gi)]
    .filter(match => match[2].split(/\s+/).includes('edition'));
  if (explicit.length === 1 && editions[textContent(explicit[0][3])]) return editions[textContent(explicit[0][3])];
  // Legacy publication contracts did not require an edition header. These are
  // not evidence of a new pilot run; a recurring receipt may never use this.
  return null;
}

export function hasAssociationMarker(html) {
  return /xuan-ib-account-association|data-account-scope-basis|owner-attested-recurring-v1/i.test(html);
}

function validateBodyMarker(html, receipt) {
  const bodies = [...stripInert(html).matchAll(/<body\b[^>]*>/gi)];
  const all = (html.match(/\bdata-account-scope-basis\b/gi) || []).length;
  const marked = bodies.filter(match => match[0].includes(ASSOCIATION_BODY_ATTRIBUTE));
  if (receipt ? all !== 1 || bodies.length !== 1 || marked.length !== 1 : all !== 0) {
    fail('the recurring receipt and canonical body basis must appear together exactly once');
  }
}

function requireFoldedDisclosure(html, disclosure) {
  const visible = stripInert(html);
  const start = html.indexOf(disclosure);
  if (start < 0 || html.indexOf(disclosure, start + disclosure.length) !== -1) fail('canonical disclosure must occur once');
  if (visible.slice(start, start + disclosure.length) !== disclosure) fail('canonical disclosure cannot be in an inert container');
  const ancestors = [];
  const voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
  for (const tag of visible.slice(0, start).matchAll(/<(\/?)([a-z][a-z0-9-]*)\b[^>]*>/gi)) {
    const name = tag[2].toLowerCase();
    if (tag[1]) {
      const index = ancestors.findLastIndex(item => item.name === name);
      if (index >= 0) ancestors.splice(index);
    } else if (!voidTags.has(name) && !/\/\s*>$/.test(tag[0])) ancestors.push({ name, tag: tag[0] });
  }
  if (ancestors.some(({ tag }) => /\s(?:hidden(?:\s|=|>)|aria-hidden\s*=\s*["']?true\b)/i.test(tag)
      || /\bstyle\s*=\s*(["'])[^"']*(?:display\s*:\s*none|visibility\s*:\s*hidden)[^"']*\1/i.test(tag))) {
    fail('canonical disclosure cannot be inside explicitly hidden markup');
  }
  const stack = [];
  const containing = [];
  for (const tag of visible.matchAll(/<\/?details\b[^>]*>/gi)) {
    if (!/^<\//.test(tag[0])) stack.push(tag);
    else {
      const opening = stack.pop();
      if (!opening) fail('disclosure details markup is malformed');
      if (opening.index < start && start + disclosure.length <= tag.index) containing.push({ opening, end: tag.index });
    }
  }
  if (stack.length) fail('disclosure details markup is malformed');
  const explanation = containing.filter(({ opening, end }) => {
    if (/\bopen(?:\s|=|>)/i.test(opening[0])) return false;
    const summary = visible.slice(opening.index + opening[0].length, end).match(/^\s*<summary\b[^>]*>([\s\S]*?)<\/summary\s*>/i);
    return summary && textContent(summary[1]).startsWith('报告说明');
  });
  if (explanation.length !== 1) fail('disclosure must be inside the folded report explanation');
}

export function checkAssociationPublication(html, snapshot, {
  now = Date.now(), edition = publicationEdition(html), previousHtml = null,
  previousSourceSha, verifiedRecordsUpdate = false,
} = {}) {
  const receipt = extractAssociationReceipt(html);
  validateBodyMarker(html, receipt);
  if (verifiedRecordsUpdate) {
    const prior = extractAssociationReceipt(previousHtml ?? '');
    validateBodyMarker(previousHtml ?? '', prior);
    if (JSON.stringify(receipt) !== JSON.stringify(prior)) fail('records-only updates must preserve the historical association receipt');
    // The outer handover guard already proves immutable HTML outside decision
    // fields. No renewed authority, live read, or fresh financial report follows.
    return { mode: receipt ? 'historical-recurring' : 'legacy', freshRead: false };
  }
  if (snapshot) validateAssociationSnapshot(snapshot, { now, requireActive: false });
  const selected = edition === 'adhoc' && snapshot?.policy?.status !== 'inactive';
  if (edition === 'adhoc' && !snapshot) fail('ordinary ad hoc publication requires a fresh trusted policy snapshot');
  if ((selected || receipt) && !receipt) fail('the current pilot policy requires its recurring receipt; stripping it does not select a legacy route');
  if (!receipt) {
    if (hasAssociationMarker(html)) fail('association markup without its canonical receipt is not allowed');
    return { mode: 'legacy', freshRead: false };
  }
  if (!snapshot) fail('recurring publication requires a fresh trusted policy snapshot');
  if (edition !== 'adhoc') fail('the initial recurring pilot is ad hoc only');
  if (!previousSourceSha) fail('recurring publication requires the trusted previous source');
  validatePublicationAssociation(html, snapshot, { now, edition, previousSourceSha, runId: receipt.runId });
  requireFoldedDisclosure(html, renderAssociationDisclosure(receipt, snapshot));
  return { mode: 'owner-attested-recurring-v1', freshRead: true };
}
