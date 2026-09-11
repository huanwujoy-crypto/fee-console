// Instrument-scoped venue identity. Measurement plumbing only.
//
// Two books spell the same instrument differently. On 2026-09-11 the IB
// positions payload described one holding as `HODLUSD @EBS` while the portfolio
// source reported the same instrument as `HODL` on `EURONEXT`. A venue-scoped
// identity key is correct — the same ticker on two exchanges really is two
// instruments — so the two spellings did not pair, and a counterfactual replay
// showed that as soon as that row carried a publishable number the column merge
// would have failed the whole report closed.
//
// The fix is deliberately NOT a venue alias. `EBS` and `EURONEXT` are different
// exchanges; declaring them synonyms would silently merge every future
// instrument that happens to appear on both. This module reads a reviewed
// registry of equivalences scoped to ONE instrument each, bound to the strong
// identity evidence both raw payloads already carry — the IB contract id and
// the portfolio source's `instrument.id` — and canonicalizes only those exact
// keys. Everything else keeps its own identity, and a cross-venue pairing that
// nobody reviewed stays unresolved and is named, never joined.
//
// It reads one versioned repository file and nothing else: no network, no
// financial account, no clock, no classification, and it never places, modifies
// or cancels anything. The run-local, cross-custodian venue inference that a
// throwaway assembly script used — taking a venue from whatever other
// custodian's portfolio happened to list the same ticker — is not reproduced
// here and must not be reintroduced: another custodian's book is not evidence
// about this account's instrument.
import fs from 'node:fs';
import { canonicalCode, identityKey } from './xuan-ib-daily-change.mjs';

const POLICY_PATH = new URL('../claude/xuan-ib-venue-identity-v1.json', import.meta.url);

// `dual-source-identity` — both books named the instrument in the same run and
// the registry records each one's own strong identifier.
// `reviewed-single-source` — only one book carried the instrument in the
// reviewed run, so its canonical venue was settled once under the publication
// lock instead of being inferred per run from an unrelated portfolio.
export const VENUE_IDENTITY_BASES = Object.freeze(['dual-source-identity', 'reviewed-single-source']);
const SOURCES = Object.freeze(['ib', 'sharesight']);
const IDENTITY_FIELDS = Object.freeze({ ib: 'contract_id', sharesight: 'instrument.id' });

const INSTRUMENT_REF = /^VENUE-(\d{4})(\d{2})(\d{2})-[A-Z0-9.]{1,16}$/;
const VENUE = /^[A-Z][A-Z0-9.]{0,15}$/;
const ID_STRING = /^\d{1,18}$/;
const EVIDENCE_REF = /^[a-z0-9][a-z0-9-]{0,63}$/;

const plain = value => value !== null && typeof value === 'object'
  && Object.getPrototypeOf(value) === Object.prototype;
const realDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

export class VenueIdentityException extends Error {
  constructor(code, detail = null) {
    super(`Venue identity: ${code}${detail === null ? '' : ` (${detail})`}`);
    this.name = 'VenueIdentityException';
    this.code = code;
    // A registry problem is an engineering exception, never an owner decision
    // and never a licence to pair two venues anyway.
    this.owner = 'Codex';
    this.requiresOwnerDecision = false;
  }
}
const fail = (code, detail = null) => { throw new VenueIdentityException(code, detail); };

const POLICY_KEYS = Object.freeze(['schemaVersion', 'policyId', 'effectiveDate', 'purpose',
  'authority', 'blanketVenueAliases', 'crossCustodianVenueInference', 'financialWrites', 'instruments']);
const ENTRY_KEYS = Object.freeze(['instrumentRef', 'basis', 'reviewedOn', 'evidenceRef', 'canonical', 'endpoints']);
const ENDPOINT_KEYS = Object.freeze(['source', 'identityField', 'identityValue', 'venue', 'code', 'portfolioId']);

// The envelope is checked wherever a policy object enters this module, not only
// where it is read from disk: a caller handing over an object must not be able
// to skip the claims the file itself is required to deny.
export function validateVenueIdentityPolicyShape(policy) {
  if (!plain(policy)) fail('POLICY_MISMATCH');
  // A file that claims a blanket alias, a cross-custodian inference or any
  // financial write is not this registry and must not be executed. An
  // unrecognized top-level key could carry exactly such a claim, so the shape
  // is exact rather than merely sufficient.
  for (const key of Object.keys(policy)) if (!POLICY_KEYS.includes(key)) fail('POLICY_UNKNOWN_FIELD', key);
  if (policy.schemaVersion !== 1
    || policy.policyId !== 'xuan-ib-venue-identity-v1'
    || policy.purpose !== 'instrument-scoped-venue-identity-only'
    || policy.authority !== 'reviewed-maintenance-under-publication-lock'
    || policy.blanketVenueAliases !== false
    || policy.crossCustodianVenueInference !== false
    || policy.financialWrites !== false
    || !realDate(policy.effectiveDate)
    || !Array.isArray(policy.instruments) || !policy.instruments.length
    || policy.instruments.length > 5_000) fail('POLICY_MISMATCH');
  return policy;
}

export function readVenueIdentityPolicy({ path = POLICY_PATH } = {}) {
  let policy = null;
  try { policy = JSON.parse(fs.readFileSync(path, 'utf8')); }
  catch { fail('POLICY_UNREADABLE'); }
  return validateVenueIdentityPolicyShape(policy);
}

function validateEndpoint(endpoint, entryRef) {
  if (!plain(endpoint)) fail('ENDPOINT_MALFORMED', entryRef);
  for (const key of Object.keys(endpoint)) if (!ENDPOINT_KEYS.includes(key)) fail('ENDPOINT_UNKNOWN_FIELD', key);
  if (!SOURCES.includes(endpoint.source)) fail('ENDPOINT_SOURCE_UNSUPPORTED', String(endpoint.source));
  // Each source is bound by the identifier that source actually publishes. A
  // registry entry that names the wrong field is refused rather than matched on
  // whatever happens to be there.
  if (endpoint.identityField !== IDENTITY_FIELDS[endpoint.source]) fail('ENDPOINT_IDENTITY_FIELD_INVALID', entryRef);
  if (typeof endpoint.identityValue !== 'string' || !ID_STRING.test(endpoint.identityValue)) {
    fail('ENDPOINT_IDENTITY_VALUE_INVALID', entryRef);
  }
  // A code is mandatory on every endpoint. This is what keeps the registry
  // instrument-scoped: without it an entry would describe a venue, not an
  // instrument, and would become the blanket alias this module refuses to be.
  if (typeof endpoint.code !== 'string' || !canonicalCode(endpoint.code)) fail('ENDPOINT_CODE_REQUIRED', entryRef);
  // `null` states plainly that the source publishes no venue label for this
  // contract. It is not a wildcard: such an endpoint contributes no key and can
  // never be matched by venue.
  if (endpoint.venue !== null && (typeof endpoint.venue !== 'string' || !VENUE.test(endpoint.venue))) {
    fail('ENDPOINT_VENUE_INVALID', entryRef);
  }
  if (endpoint.source === 'sharesight') {
    if (typeof endpoint.portfolioId !== 'string' || !ID_STRING.test(endpoint.portfolioId)) {
      fail('ENDPOINT_PORTFOLIO_REQUIRED', entryRef);
    }
  } else if (Object.hasOwn(endpoint, 'portfolioId')) fail('ENDPOINT_UNKNOWN_FIELD', 'portfolioId');
  return {
    ...endpoint,
    canonicalCode: canonicalCode(endpoint.code),
    key: endpoint.venue === null ? null : identityKey({ venue: endpoint.venue, code: endpoint.code }),
    sourceKey: `${endpoint.source}:${endpoint.identityValue}`,
  };
}

function validateEntry(entry) {
  if (!plain(entry)) fail('ENTRY_MALFORMED');
  for (const key of Object.keys(entry)) if (!ENTRY_KEYS.includes(key)) fail('ENTRY_UNKNOWN_FIELD', key);
  const parts = INSTRUMENT_REF.exec(String(entry.instrumentRef ?? ''));
  if (!parts || !realDate(`${parts[1]}-${parts[2]}-${parts[3]}`)) fail('ENTRY_REF_INVALID', entry.instrumentRef);
  if (!realDate(entry.reviewedOn) || entry.reviewedOn !== `${parts[1]}-${parts[2]}-${parts[3]}`) {
    fail('ENTRY_REVIEW_DATE_MISMATCH', entry.instrumentRef);
  }
  if (typeof entry.evidenceRef !== 'string' || !EVIDENCE_REF.test(entry.evidenceRef)) {
    fail('ENTRY_EVIDENCE_REQUIRED', entry.instrumentRef);
  }
  if (!VENUE_IDENTITY_BASES.includes(entry.basis)) fail('ENTRY_BASIS_UNSUPPORTED', entry.instrumentRef);
  if (!plain(entry.canonical) || typeof entry.canonical.venue !== 'string' || !VENUE.test(entry.canonical.venue)
    || typeof entry.canonical.code !== 'string' || !canonicalCode(entry.canonical.code)
    || Object.keys(entry.canonical).length !== 2) fail('ENTRY_CANONICAL_INVALID', entry.instrumentRef);
  const canonicalKey = identityKey(entry.canonical);
  if (canonicalKey === null) fail('ENTRY_CANONICAL_INVALID', entry.instrumentRef);
  if (!Array.isArray(entry.endpoints)) fail('ENTRY_ENDPOINTS_INVALID', entry.instrumentRef);
  const endpoints = entry.endpoints.map(endpoint => validateEndpoint(endpoint, entry.instrumentRef));
  const wanted = entry.basis === 'dual-source-identity' ? 2 : 1;
  if (endpoints.length !== wanted) fail('ENTRY_ENDPOINT_COUNT', entry.instrumentRef);
  if (new Set(endpoints.map(endpoint => endpoint.source)).size !== endpoints.length) {
    fail('ENTRY_DUPLICATE_SOURCE', entry.instrumentRef);
  }
  // The canonical identity is one the sources actually published, never a third
  // spelling this registry invented. A single-source entry is the one exception
  // and says so: its source published no venue at all, so the reviewed venue is
  // recorded explicitly instead of being inferred from another custodian.
  if (entry.basis === 'dual-source-identity') {
    if (!endpoints.some(endpoint => endpoint.key === canonicalKey)) fail('ENTRY_CANONICAL_UNSOURCED', entry.instrumentRef);
  } else if (endpoints[0].key !== null && endpoints[0].key !== canonicalKey) {
    fail('ENTRY_CANONICAL_UNSOURCED', entry.instrumentRef);
  }
  // Every endpoint describes the same instrument, so their codes must agree
  // after alias normalization. `HODLUSD` versus `HODL` is the currency suffix
  // one book appends, which normalization does not strip, so the entry records
  // both spellings and this check tolerates exactly that containment.
  const codes = [...new Set([...endpoints.map(endpoint => endpoint.canonicalCode), canonicalCode(entry.canonical.code)])];
  for (const code of codes) {
    const agrees = codes.every(other => other.startsWith(code) || code.startsWith(other));
    if (!agrees) fail('ENTRY_CODES_DISAGREE', entry.instrumentRef);
  }
  return { entry, endpoints, canonicalKey, canonicalCode: canonicalCode(entry.canonical.code) };
}

export function listVenueEquivalences(policy = readVenueIdentityPolicy()) {
  // Every entry is validated, not only the one about to be used: a registry
  // carrying one unreviewable claim is not a registry this module may execute,
  // and skipping it silently would hide the problem until it mattered.
  const validated = validateVenueIdentityPolicyShape(policy).instruments.map(validateEntry);
  const unique = (values, code) => {
    const seen = new Set();
    for (const value of values) {
      if (value === null) continue;
      if (seen.has(value)) fail(code, value);
      seen.add(value);
    }
  };
  unique(validated.map(item => item.entry.instrumentRef), 'POLICY_DUPLICATE_REF');
  unique(validated.map(item => item.canonicalKey), 'POLICY_DUPLICATE_CANONICAL');
  // One venue-scoped key, and one source identifier, may belong to at most one
  // instrument. Otherwise which equivalence applied would depend on file order.
  // Inside a single entry the two books may of course spell the key the same
  // way — that is agreement, not a collision — so each entry contributes each
  // of its keys once.
  unique(validated.flatMap(item => [...new Set(item.endpoints.map(endpoint => endpoint.key))]),
    'POLICY_DUPLICATE_ENDPOINT');
  unique(validated.flatMap(item => item.endpoints.map(endpoint => endpoint.sourceKey)), 'POLICY_DUPLICATE_SOURCE_IDENTITY');
  return validated;
}

export function createVenueIdentityResolver(policy = readVenueIdentityPolicy()) {
  const validated = listVenueEquivalences(policy);
  const byKey = new Map(), bySource = new Map(), refByKey = new Map();
  for (const item of validated) {
    for (const endpoint of item.endpoints) {
      if (endpoint.key !== null) {
        byKey.set(endpoint.key, item.canonicalKey);
        refByKey.set(endpoint.key, item.entry.instrumentRef);
      }
      bySource.set(endpoint.sourceKey, item);
    }
    byKey.set(item.canonicalKey, item.canonicalKey);
    refByKey.set(item.canonicalKey, item.entry.instrumentRef);
  }
  return {
    size: validated.length,
    refs: Object.freeze(validated.map(item => item.entry.instrumentRef)),
    // A key nobody reviewed is returned unchanged. Silence here is deliberate:
    // an unknown key must keep its own identity so the caller can name the
    // unresolved pair, not quietly acquire someone else's move.
    canonicalKey(key) {
      if (typeof key !== 'string' || !key) return key ?? null;
      return byKey.get(key) ?? key;
    },
    instrumentRefFor(key) {
      return typeof key === 'string' ? refByKey.get(key) ?? null : null;
    },
    // Resolve straight from the identifier the raw payload carries. This is the
    // path that removes venue inference entirely: a contract id is looked up,
    // never combined with another book's venue to guess one.
    canonicalKeyForSource(source, identityValue) {
      if (!SOURCES.includes(source)) fail('ENDPOINT_SOURCE_UNSUPPORTED', String(source));
      const item = bySource.get(`${source}:${String(identityValue)}`);
      return item ? item.canonicalKey : null;
    },
    // Two keys are equivalent only when one reviewed instrument entry records
    // both. A shared ticker is never enough.
    isReviewedPair(left, right) {
      if (typeof left !== 'string' || typeof right !== 'string') return false;
      if (left === right) return true;
      const a = byKey.get(left), b = byKey.get(right);
      return a !== undefined && a === b;
    },
  };
}

// A resolver that knows nothing. Passing this is the explicit way to say "this
// run has no reviewed equivalences", which keeps every key exactly as its
// source spelled it.
export function emptyVenueIdentityResolver() {
  return {
    size: 0, refs: Object.freeze([]),
    canonicalKey: key => (typeof key === 'string' && key ? key : key ?? null),
    instrumentRefFor: () => null,
    canonicalKeyForSource: () => null,
    isReviewedPair: (left, right) => typeof left === 'string' && left === right,
  };
}

// The name an unreviewed cross-venue pairing is disclosed under. It is a label
// for a refusal, never a step towards performing the join.
export const describeVenuePair = (left, right) => [left, right].sort().join('~');
