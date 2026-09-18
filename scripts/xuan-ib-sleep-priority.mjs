#!/usr/bin/env node

import fs from 'node:fs';
import { publicationEdition } from './xuan-ib-account-association-publication.mjs';

export const SLEEP_PRIORITY_KIND = 'sleep-priority';
export const SLEEP_PRIORITY_BODY_ATTRIBUTE = 'data-xuan-delivery="sleep-priority-v1"';
export const SLEEP_PRIORITY_TEMPLATE_ID = 'xuan-ib-sleep-priority-v1';
// V1 was an adaptive ten-minute checkpoint inside the full PM run. V2 is an
// independent fast lane: publish as soon as its own verified IB capture is
// ready. Keep V1 readable so an older published priority page remains valid.
export const SLEEP_PRIORITY_DELAY_MS = 0;
const LEGACY_PRIORITY_DELAY_MS = 10 * 60 * 1000;

const fail = message => { throw new Error(`sleep priority: ${message}`); };
const exact = (value, keys, label) => {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
      || Object.keys(value).sort().join('|') !== [...keys].sort().join('|')) fail(`${label} has missing or unknown fields`);
};
const date = (value, label = 'dataDate') => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)
      || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) fail(`${label} must be a real YYYY-MM-DD date`);
  return value;
};
const instant = (value, label) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
      || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail(`${label} must be a canonical UTC instant`);
  return Date.parse(value);
};
const runId = value => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(value)) fail('runId is invalid');
  return value;
};
const sha = (value, label = 'previousSourceSha') => {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/i.test(value)) fail(`${label} must be a Git SHA`);
  return value.toLowerCase();
};

export function validateSleepPriorityDelivery(delivery) {
  exact(delivery, ['schemaVersion', 'kind', 'slotEdition', 'dataDate', 'runId', 'runStartedAt',
    'priorityReadyAt', 'publishEligibleAt', 'previousSourceSha'], 'delivery');
  if (![1, 2].includes(delivery.schemaVersion) || delivery.kind !== SLEEP_PRIORITY_KIND || delivery.slotEdition !== 'pm') {
    fail('unsupported delivery contract');
  }
  date(delivery.dataDate); runId(delivery.runId); sha(delivery.previousSourceSha);
  const started = instant(delivery.runStartedAt, 'runStartedAt');
  const ready = instant(delivery.priorityReadyAt, 'priorityReadyAt');
  const eligible = instant(delivery.publishEligibleAt, 'publishEligibleAt');
  if (ready < started) fail('priorityReadyAt precedes runStartedAt');
  const delay = delivery.schemaVersion === 1 ? LEGACY_PRIORITY_DELAY_MS : SLEEP_PRIORITY_DELAY_MS;
  if (eligible !== started + delay) fail('publishEligibleAt does not match the delivery version');
  return delivery;
}

export function createSleepPriorityDelivery({ dataDate, runId: id, runStartedAt, priorityReadyAt, previousSourceSha }) {
  const started = instant(runStartedAt, 'runStartedAt');
  const delivery = {
    schemaVersion: 2, kind: SLEEP_PRIORITY_KIND, slotEdition: 'pm', dataDate: date(dataDate),
    runId: runId(id), runStartedAt: new Date(started).toISOString(),
    priorityReadyAt: new Date(instant(priorityReadyAt, 'priorityReadyAt')).toISOString(),
    publishEligibleAt: new Date(started + SLEEP_PRIORITY_DELAY_MS).toISOString(),
    previousSourceSha: sha(previousSourceSha),
  };
  return validateSleepPriorityDelivery(delivery);
}

export function renderSleepPriorityTransport(delivery) {
  validateSleepPriorityDelivery(delivery);
  return `<template id="${SLEEP_PRIORITY_TEMPLATE_ID}" type="application/json">${JSON.stringify(delivery)}</template>`;
}

export function extractSleepPriorityDelivery(html) {
  if (typeof html !== 'string') fail('html must be text');
  const matches = [...html.matchAll(new RegExp(`<template id="${SLEEP_PRIORITY_TEMPLATE_ID}" type="application/json">([\\s\\S]*?)</template>`, 'g'))];
  if (matches.length > 1) fail('delivery marker must occur at most once');
  if (!matches.length) return null;
  let parsed;
  try { parsed = JSON.parse(matches[0][1]); } catch { fail('delivery marker is not valid JSON'); }
  return validateSleepPriorityDelivery(parsed);
}

function bodyMarkerCount(html) {
  return (html.match(/\bdata-xuan-delivery\s*=\s*["']sleep-priority-v1["']/gi) || []).length;
}

export function checkSleepPriorityPublication(html, { edition = publicationEdition(html), expectedDate = null } = {}) {
  const delivery = extractSleepPriorityDelivery(html);
  const markerCount = bodyMarkerCount(html);
  const lookalike = /sleep-priority|睡前速览|完整报告更新中/i.test(html);
  if (!delivery) {
    if (markerCount || lookalike) fail('priority wording or body marker requires the canonical delivery marker');
    return null;
  }
  if (markerCount !== 1) fail('canonical body marker must occur exactly once');
  if (edition !== 'adhoc') fail('priority publication must remain adhoc and cannot satisfy pm completion');
  if (expectedDate !== null && delivery.dataDate !== expectedDate) fail('delivery data date does not match the candidate date');
  const visible = html.replace(/<(?:script|style|template|textarea|title|noscript)\b[^>]*>[\s\S]*?<\/(?:script|style|template|textarea|title|noscript)\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
  if (!visible.includes('临时版 · 睡前速览') || !visible.includes('完整报告更新中')) fail('priority page must disclose its incomplete status visibly');
  return delivery;
}

export function classifySleepPublication(html) {
  const edition = publicationEdition(html);
  const delivery = checkSleepPriorityPublication(html, { edition });
  if (delivery) return {
    kind: 'priority', dataDate: delivery.dataDate, priorityKey: `pm:${delivery.dataDate}`,
    eligibleAtEpoch: Math.floor(Date.parse(delivery.publishEligibleAt) / 1000),
  };
  const primary = html.match(/<span\b[^>]*\bclass\s*=\s*(["'])[^"']*\bdate\b[^"']*\1[^>]*>([\s\S]*?)<\/span\s*>/i);
  const primaryText = primary?.[2].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ') ?? '';
  const match = primaryText.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (!match) fail('primary report date is unavailable');
  date(match[1]);
  return { kind: edition === 'pm' ? 'complete-pm' : 'other', dataDate: match[1], priorityKey: null, eligibleAtEpoch: null };
}

// A full PM run may start against the last complete report while a separate
// priority run publishes in the meantime. The PM receipt was necessarily
// minted before its financial reads, so its anchor can be the priority page's
// verified prior source, but only for the same date and only for a full PM.
// All other continuity checks still use the actual current published page.
export function associationAnchorAfterPriority({ candidateEdition, candidatePreviousSourceSha,
  publishedHtml, publishedSourceSha, dataDate }) {
  const current = sha(publishedSourceSha, 'publishedSourceSha');
  if (candidateEdition !== 'pm' || candidatePreviousSourceSha === current) return current;
  if (!extractSleepPriorityDelivery(publishedHtml)) return current;
  const published = checkSleepPriorityPublication(publishedHtml);
  if (!published || published.dataDate !== date(dataDate)) return current;
  const prior = sha(published.previousSourceSha);
  return candidatePreviousSourceSha === prior ? prior : current;
}

export function nextSleepPriorityAction(state) {
  exact(state, ['runId', 'dataDate', 'startedAt', 'now', 'priorityReadyAt', 'priorityPublishedAt',
    'fullReadyAt', 'fullPublishedAt'], 'state');
  runId(state.runId); date(state.dataDate);
  const started = instant(state.startedAt, 'startedAt');
  const now = instant(state.now, 'now');
  const optional = label => state[label] === null ? null : instant(state[label], label);
  const priorityReady = optional('priorityReadyAt'), priorityPublished = optional('priorityPublishedAt');
  const fullReady = optional('fullReadyAt'), fullPublished = optional('fullPublishedAt');
  for (const [label, value] of [['now', now], ['priorityReadyAt', priorityReady], ['priorityPublishedAt', priorityPublished],
    ['fullReadyAt', fullReady], ['fullPublishedAt', fullPublished]]) {
    if (value !== null && value < started) fail(`${label} precedes startedAt`);
  }
  if (priorityPublished !== null && priorityReady === null) fail('priority publication requires priority readiness');
  if (fullPublished !== null && fullReady === null) fail('full publication requires full readiness');
  if (fullPublished !== null) return 'complete';
  if (fullReady !== null) return 'publish-full';
  if (priorityPublished !== null) return 'continue-full';
  if (now < started + SLEEP_PRIORITY_DELAY_MS) return 'wait-for-full';
  return priorityReady !== null ? 'publish-priority' : 'wait-for-priority';
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  try {
    if (process.argv[2] !== 'classify' || process.argv.length !== 4) throw new Error('usage');
    process.stdout.write(`${JSON.stringify(classifySleepPublication(fs.readFileSync(process.argv[3], 'utf8')))}\n`);
  } catch (error) {
    process.stderr.write(`sleep priority failed: ${error.message}\n`); process.exitCode = 1;
  }
}
