import test from "node:test";
import assert from "node:assert/strict";
import {
  createPublishedMeta,
  selectNewestCandidate,
  validatePublishedMeta
} from "./xuan-ib-promotion.mjs";

const sha = character => character.repeat(40);
const published = {
  schemaVersion: 1,
  sourceSha: sha("a"),
  sourceCommitEpoch: 100,
  dataDate: "2026-08-26",
  htmlBlob: sha("b")
};
const publication = dataDate => ({kind: 'other', dataDate, priorityKey: null, eligibleAtEpoch: null});
const publishedState = publication(published.dataDate);
const candidate = (overrides = {}) => ({
  ref: "origin/claude/handover-20260826-abc123",
  sha: sha("c"),
  commitEpoch: 101,
  dataDate: "2026-08-26",
  htmlBlob: sha("d"),
  publication: publication(overrides.dataDate ?? "2026-08-26"),
  ...overrides
});

test("validates published metadata against the current latest.html blob", () => {
  assert.equal(validatePublishedMeta(published, sha("b")), published);
  assert.throws(() => validatePublishedMeta({...published, schemaVersion: 2}, sha("b")), /schemaVersion/);
  assert.throws(() => validatePublishedMeta({...published, sourceSha: "bad"}, sha("b")), /sourceSha/);
  assert.throws(() => validatePublishedMeta({...published, sourceCommitEpoch: 0}, sha("b")), /sourceCommitEpoch/);
  assert.throws(() => validatePublishedMeta({...published, dataDate: "2026-02-30"}, sha("b")), /calendar date/);
  assert.throws(() => validatePublishedMeta(published, sha("e")), /does not match/);
});

test("cross-checks published metadata against the trusted source commit", () => {
  const sourceTruth = {
    sourceSha: sha("a"),
    sourceCommitEpoch: 100,
    sourceHtmlBlob: sha("b"),
    sourceDataDate: "2026-08-26"
  };
  assert.equal(validatePublishedMeta(published, sha("b"), sourceTruth), published);
  assert.throws(() => validatePublishedMeta(published, sha("b"), {...sourceTruth, sourceSha: sha("c")}), /source SHA/);
  assert.throws(() => validatePublishedMeta(published, sha("b"), {...sourceTruth, sourceCommitEpoch: 101}), /timestamp/);
  assert.throws(() => validatePublishedMeta(published, sha("b"), {...sourceTruth, sourceHtmlBlob: sha("d")}), /HTML blob/);
  assert.throws(() => validatePublishedMeta(published, sha("b"), {...sourceTruth, sourceDataDate: "2026-08-25"}), /data date/);
});

test("returns null when no unpublished candidate is eligible", () => {
  assert.equal(selectNewestCandidate([], published, publishedState), null);
  assert.equal(selectNewestCandidate([candidate({htmlBlob: sha("b")})], published, publishedState), null);
  assert.equal(selectNewestCandidate([candidate({commitEpoch: 100})], published, publishedState), null);
  assert.equal(selectNewestCandidate([candidate({dataDate: "2026-08-25"})], published, publishedState), null);
});

test("chooses the newest of several valid candidates", () => {
  const selected = selectNewestCandidate([
    candidate({ref: "origin/claude/handover-20260826-old111", commitEpoch: 101, htmlBlob: sha("d")}),
    candidate({ref: "origin/claude/handover-20260826-new222", commitEpoch: 103, htmlBlob: sha("e")}),
    candidate({ref: "origin/claude/handover-20260826-mid333", commitEpoch: 102, htmlBlob: sha("f")})
  ], published, publishedState);
  assert.equal(selected.commitEpoch, 103);
  assert.equal(selected.ref, "origin/claude/handover-20260826-new222");
});

test("a newer data date wins over a later correction to the older date", () => {
  const selected = selectNewestCandidate([
    candidate({ref: "origin/claude/handover-20260827-new111", dataDate: "2026-08-27", commitEpoch: 200, htmlBlob: sha("e")}),
    candidate({ref: "origin/claude/handover-20260826-late22", dataDate: "2026-08-26", commitEpoch: 300, htmlBlob: sha("f")})
  ], published, publishedState);
  assert.equal(selected.dataDate, "2026-08-27");
  assert.equal(selected.ref, "origin/claude/handover-20260827-new111");
});

test("allows a next-day candidate and deterministically collapses identical ties", () => {
  const tied = [
    candidate({ref: "origin/claude/handover-20260827-bbb222", commitEpoch: 200, dataDate: "2026-08-27"}),
    candidate({ref: "origin/claude/handover-20260827-aaa111", commitEpoch: 200, dataDate: "2026-08-27"})
  ];
  assert.equal(selectNewestCandidate(tied, published, publishedState).ref, "origin/claude/handover-20260827-aaa111");
});

test("fails closed when different pages share the newest source timestamp", () => {
  assert.throws(() => selectNewestCandidate([
    candidate({commitEpoch: 200, htmlBlob: sha("d")}),
    candidate({ref: "origin/claude/handover-20260826-def456", commitEpoch: 200, htmlBlob: sha("e")})
  ], published, publishedState), /share the newest source timestamp/);
});

test("creates canonical metadata from the selected candidate", () => {
  const selected = candidate({commitEpoch: 222, dataDate: "2026-08-27"});
  assert.deepEqual(createPublishedMeta(selected), {
    schemaVersion: 1,
    sourceSha: selected.sha,
    sourceCommitEpoch: 222,
    dataDate: "2026-08-27",
    htmlBlob: selected.htmlBlob
  });
});

test('priority cannot publish before its versioned eligibility instant or replace same-day full pm', () => {
  const priority = candidate({ commitEpoch: 200, publication: {
    kind: 'priority', dataDate: '2026-08-26', priorityKey: 'pm:2026-08-26', eligibleAtEpoch: 201,
  }});
  assert.equal(selectNewestCandidate([priority], published, publishedState), null);
  const eligible = { ...priority, commitEpoch: 201 };
  assert.equal(selectNewestCandidate([eligible], published, publishedState), eligible);
  assert.equal(selectNewestCandidate([eligible], published, {
    kind: 'priority', dataDate: published.dataDate, priorityKey: `pm:${published.dataDate}`, eligibleAtEpoch: 150,
  }), null);
  assert.equal(selectNewestCandidate([eligible], published, {
    kind: 'complete-pm', dataDate: published.dataDate, priorityKey: null, eligibleAtEpoch: null,
  }), null);
});

test('complete pm beats same-date priority and replaces a published priority', () => {
  const priority = candidate({ commitEpoch: 300, htmlBlob: sha('e'), publication: {
    kind: 'priority', dataDate: '2026-08-26', priorityKey: 'pm:2026-08-26', eligibleAtEpoch: 150,
  }});
  const full = candidate({ ref: 'origin/claude/handover-20260826-full11', commitEpoch: 250,
    htmlBlob: sha('f'), publication: { kind: 'complete-pm', dataDate: '2026-08-26', priorityKey: null, eligibleAtEpoch: null } });
  assert.equal(selectNewestCandidate([priority, full], published, publishedState), full);
  assert.equal(selectNewestCandidate([full], published, {
    kind: 'priority', dataDate: published.dataDate, priorityKey: `pm:${published.dataDate}`, eligibleAtEpoch: 150,
  }), full);
  const priorityMeta={...published,sourceCommitEpoch:300,htmlBlob:priority.htmlBlob};
  const priorityState={kind:'priority',dataDate:published.dataDate,
    priorityKey:`pm:${published.dataDate}`,eligibleAtEpoch:150};
  assert.equal(selectNewestCandidate([full],priorityMeta,priorityState),full);
  assert.equal(selectNewestCandidate([candidate({commitEpoch:250,htmlBlob:sha('d')})],
    priorityMeta,priorityState),null);
});
