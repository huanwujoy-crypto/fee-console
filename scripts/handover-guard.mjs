#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateClassificationDisclosure } from './xuan-ib-classification-disclosure.mjs';
import { validateCashPlan } from './xuan-ib-cash-plan.mjs';
import { POLICY_ID, renderPolicySection } from './xuan-ib-policy-page.mjs';
import {ETF_SUMMARY_ID,ETF_SUMMARY_OPEN,parseEtfSummary} from './xuan-ib-etf-summary-transport.mjs';
import { loadTrustedAssociationPolicy, validateAssociationSnapshot } from './xuan-ib-account-association.mjs';
import {
  ASSOCIATION_TEMPLATE_ID, checkAssociationPublication, hasAssociationMarker, publicationEdition,
} from './xuan-ib-account-association-publication.mjs';
import {
  ETF_TAB_CSS_V1,
  ETF_TAB_LABEL_V1,
  ETF_TAB_RADIO_V1,
} from './xuan-ib-etf-pane.mjs';
import {
  ETF_ABC_RUNTIME_END,
  ETF_ABC_RUNTIME_START,
  countVisibleEtfAbcRuntimeClassElements,
  parseEtfAbcPublicRuntimeStateJson,
  renderEtfAbcPublicRuntimeCard,
  validateEtfAbcInitialPublicRuntimeState,
} from './xuan-ib-etf-abc.mjs';

const [file, expectedDate, previousFile] = process.argv.slice(2);

const fail = (message) => {
  console.error(`handover guard failed: ${message}`);
  process.exit(1);
};

if (!file || !expectedDate) {
  console.error('usage: handover-guard.mjs FILE EXPECTED_DATE [PREVIOUS_HTML]');
  process.exit(2);
}

if (!/^\d{4}-\d{2}-\d{2}$/.test(expectedDate)) {
  fail('expected date must use YYYY-MM-DD');
}

let html;
try {
  html = fs.readFileSync(file, 'utf8');
} catch {
  fail('could not read the handover file');
}

const bytes = Buffer.byteLength(html);
if (bytes < 1_000 || bytes >= 2_000_000) {
  fail('file size is outside the approved range');
}

const count = (regex) => (html.match(regex) || []).length;
const recordsUpdateMarker = /<!--\s*xuan-ib-records-update:v1\s*-->/gi;
const recordsUpdateMarkerCount = count(recordsUpdateMarker);
if (recordsUpdateMarkerCount > 1) fail('records-update marker must be unique');
const isRecordsUpdate = recordsUpdateMarkerCount === 1;

const policyJsonFile = process.env.XUAN_IB_POLICY_V2_JSON
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../claude/xuan-ib-policy-v2.json');
const policyIdAttributeCount = (html.match(/\bid\s*=\s*(["'])xuan-ib-policy-v2\1/gi) || []).length
  + (html.match(/\bid\s*=\s*xuan-ib-policy-v2(?=[\s>])/gi) || []).length;
const policyMarkerCount = (html.match(new RegExp(`<!--\\s*${POLICY_ID}:[0-9a-f]{64}\\s*-->`, 'gi')) || []).length;

const blankMatch = (match) => ' '.repeat(match.length);
const structuralMarkup = (source) => source
  .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, blankMatch)
  .replace(/<template\b[^>]*>[\s\S]*?<\/template\s*>/gi, blankMatch)
  .replace(/<!--[\s\S]*?-->/g, blankMatch);
const visibleElementMarkup = (source) => source
  .replace(/<(script|style|template|textarea|title|noscript|iframe|noembed|noframes|xmp)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, blankMatch)
  .replace(/<!--[\s\S]*?-->/g, blankMatch);
const structuralHtml = structuralMarkup(html);
const policySectionOpeningCount = (structuralHtml.match(/<section\b[^>]*\bid\s*=\s*(["'])xuan-ib-policy-v2\1[^>]*>/gi) || []).length;

const quotedAttribute = (attributes, name, label) => {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = [...attributes.matchAll(new RegExp(`(?:^|\\s)${escapedName}\\s*=\\s*(["'])(.*?)\\1`, 'gi'))];
  if (matches.length > 1) fail(`${label} repeats ${name}`);
  return matches.length === 1 ? matches[0][2] : null;
};

const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const attributeValueCount = (source, name, value) => (source.match(new RegExp(
  `(?:^|[\\s<])${escapeRegex(name)}\\s*=\\s*(?:"${escapeRegex(value)}"|'${escapeRegex(value)}'|${escapeRegex(value)}(?=[\\s>/]))`,
  'gi'
)) || []).length;
const identityAttributeHasCharacterReference = source => /(?:^|[\s<])(?:id|for)\s*=\s*(?:"[^"]*&[^"]*"|'[^']*&[^']*'|[^\s>]*&[^\s>]*)/i.test(source);
const navigationOrder = Object.freeze(['s1', 's2', 's3', 's4', 's5']);
const navigationText = Object.freeze({ s1: '概览', s2: '风险', s3: '配置', s4: '待办', s5: 'ETF' });
const DECISION_STATE_TEMPLATE_ID = 'xuan-ib-decision-state-v1';
const ETF_ABC_STATE_TEMPLATE_ID = 'xuan-ib-etf-abc-state-v1';
const ETF_ABC_STATE_TEMPLATE_OPENING = `<template id="${ETF_ABC_STATE_TEMPLATE_ID}" type="application/json">`;

const classTokens = (tag) => {
  const match = tag.match(/\bclass\s*=\s*(?:(["'])(.*?)\1|([^\s>]+))/i);
  return match ? (match[2] ?? match[3]).split(/\s+/).filter(Boolean) : [];
};

const decodedClassTokens = (tag) => {
  const match = tag.match(/\bclass\s*=\s*(?:(["'])(.*?)\1|([^\s>]+))/i);
  if (!match) return [];
  const decoded = (match[2] ?? match[3])
    .replace(/&#(?:x([0-9a-f]+)|([0-9]+));?/gi, (whole, hex, decimal) => {
      const codePoint = Number.parseInt(hex ?? decimal, hex ? 16 : 10);
      return Number.isInteger(codePoint) && codePoint > 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint) : '\ufffd';
    })
    .replace(/&Tab;/gi, '\t')
    .replace(/&NewLine;/gi, '\n');
  return decoded.split(/[\t\n\f\r ]+/).filter(Boolean);
};

const elementRange = (source, tagName, opening) => {
  const tags = new RegExp(`<\\/?${tagName}\\b[^>]*>`, 'gi');
  tags.lastIndex = opening.index;
  let depth = 0;
  let tag;
  while ((tag = tags.exec(source)) !== null) {
    if (tag.index === opening.index && /^<\//.test(tag[0])) return null;
    depth += /^<\//.test(tag[0]) ? -1 : 1;
    if (depth === 0) {
      return {
        start: opening.index,
        openEnd: opening.index + opening[0].length,
        closeStart: tag.index,
        end: tags.lastIndex,
        openingTag: opening[0],
      };
    }
  }
  return null;
};

const divRangesWithClass = (source, className) => [...source.matchAll(/<div\b[^>]*>/gi)]
  .filter(opening => classTokens(opening[0]).includes(className))
  .map((opening) => elementRange(source, 'div', opening))
  .filter(Boolean);

const paneRanges = (source, paneClass) => divRangesWithClass(source, 'pane')
  .filter(range => classTokens(range.openingTag).includes(paneClass));

const policyPaneClass = (source, start, end) => {
  const containing = ['p3', 'p5'].flatMap((paneClass) => paneRanges(source, paneClass)
    .filter((pane) => pane.openEnd <= start && end <= pane.closeStart)
    .map(() => paneClass));
  return containing.length === 1 ? containing[0] : null;
};

const validateEtfNavigation = (source) => {
  if (identityAttributeHasCharacterReference(source)) {
    fail('navigation identity attributes cannot contain character references');
  }
  const inputTags = [...source.matchAll(/<input\b([^>]*)>/gi)];
  const labelTags = [...source.matchAll(/<label\b([^>]*)>([\s\S]*?)<\/label\s*>/gi)];
  const exactInputs = inputTags
    .filter(match => match[0] === ETF_TAB_RADIO_V1);
  const exactLabels = labelTags
    .filter(match => match[0] === ETF_TAB_LABEL_V1);
  if (exactInputs.length !== 1 || exactLabels.length !== 1) {
    fail('ETF pane requires the exact enabled s5 radio and compact accessible label once');
  }
  const tabbars = divRangesWithClass(source, 'tabbar');
  const panes = divRangesWithClass(source, 'pane');
  if (tabbars.length !== 1) fail('ETF navigation requires exactly one tabbar');
  const orderedInputs = [];
  const orderedLabels = [];
  for (const id of navigationOrder) {
    if (attributeValueCount(source, 'id', id) !== 1
        || attributeValueCount(source, 'for', id) !== 1) {
      fail(`navigation must reserve id=${id} and for=${id} exactly once`);
    }
    const inputs = inputTags.filter(match => quotedAttribute(match[1], 'id', `navigation input ${id}`) === id);
    const labels = labelTags.filter(match => quotedAttribute(match[1], 'for', `navigation label ${id}`) === id);
    if (inputs.length !== 1 || labels.length !== 1
        || quotedAttribute(inputs[0][1], 'type', `navigation input ${id}`) !== 'radio'
        || quotedAttribute(inputs[0][1], 'name', `navigation input ${id}`) !== 'sec'
        || /(?:^|\s)(?:disabled|hidden)(?:\s|=|$)/i.test(inputs[0][1])
        || /(?:^|\s)hidden(?:\s|=|$)/i.test(labels[0][1])) {
      fail(`navigation control ${id} must be an enabled sec radio and label`);
    }
    const text = labels[0][2].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    if (id === 's4' ? !/^待办(?:\s+\d+)?$/.test(text) : text !== navigationText[id]) {
      fail(`navigation label ${id} has the wrong visible text`);
    }
    orderedInputs.push(inputs[0]);
    orderedLabels.push(labels[0]);
  }
  if (orderedInputs.some((match, index) => index > 0 && orderedInputs[index - 1].index >= match.index)
      || orderedLabels.some((match, index) => index > 0 && orderedLabels[index - 1].index >= match.index)
      || orderedInputs.some(match => match.index >= tabbars[0].start)
      || orderedLabels.some(match => match.index < tabbars[0].openEnd
        || match.index + match[0].length > tabbars[0].closeStart)
      || panes.length === 0
      || panes.some(pane => tabbars[0].end > pane.start)) {
    fail('navigation must appear as 概览 / 风险 / 配置 / 待办 / ETF before all panes');
  }
};

const validateEtfLayoutCss = (source) => {
  if (source.split(ETF_TAB_CSS_V1).length - 1 !== 1) {
    fail('ETF navigation must include the exact five-column and narrow-screen CSS contract once');
  }
  const cssStart = source.indexOf(ETF_TAB_CSS_V1);
  const cssEnd = cssStart + ETF_TAB_CSS_V1.length;
  const bodyOpenings = [...source.matchAll(/<body\b[^>]*>/gi)];
  const containingStyles = [...source.matchAll(/<style\b[^>]*>/gi)]
    .map((opening) => elementRange(source, 'style', opening))
    .filter((range) => range && range.openEnd <= cssStart && cssEnd <= range.closeStart);
  if (bodyOpenings.length !== 1 || containingStyles.length !== 1
      || containingStyles[0].openingTag !== '<style>'
      || containingStyles[0].end > bodyOpenings[0].index) {
    fail('ETF five-column CSS must be inside one ordinary document-level style element');
  }
};

const publicationTemplates = (source) => {
  const inertElement = /<(script|style|textarea|title|noscript|iframe|noembed|noframes|xmp)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
  const comment = /<!--[\s\S]*?-->/g;
  for (const match of source.matchAll(inertElement)) {
    if (/<\/?template\b/i.test(match[0])) {
      fail('publication templates cannot be hidden or forged inside inert markup');
    }
  }
  for (const match of source.matchAll(comment)) {
    if (/<\/?template\b/i.test(match[0])) {
      fail('publication templates cannot be hidden or forged inside comments');
    }
  }
  const markup = source.replace(inertElement, blankMatch).replace(comment, blankMatch);
  const tags = /<(\/?)template\b([^>]*)>/gi;
  const templates = [];
  let opening = null;
  let tag;
  while ((tag = tags.exec(markup)) !== null) {
    if (tag[1] === '/') {
      if (tag[2].trim() !== '' || !opening) fail('publication template markup is malformed');
      templates.push({
        ...opening,
        body: source.slice(opening.openEnd, tag.index),
        closeStart: tag.index,
        end: tags.lastIndex,
      });
      opening = null;
      continue;
    }
    if (opening) fail('publication templates cannot be nested');
    if (identityAttributeHasCharacterReference(tag[0])) {
      fail('publication template identity cannot contain character references');
    }
    opening = {
      start: tag.index,
      openEnd: tags.lastIndex,
      openingTag: tag[0],
      attributes: tag[2],
    };
  }
  if (opening) fail('publication template markup is malformed');
  return templates;
};

const validatePublicationTemplates = (source, policyContext) => {
  const templates = publicationTemplates(source);
  const byId = new Map();
  for (const template of templates) {
    const id = quotedAttribute(template.attributes, 'id', 'publication template');
    if (![DECISION_STATE_TEMPLATE_ID, ETF_ABC_STATE_TEMPLATE_ID, ETF_SUMMARY_ID, ASSOCIATION_TEMPLATE_ID].includes(id)) {
      fail('only the approved decision, ETF and account-association templates are allowed');
    }
    if (byId.has(id)) fail(`${id} template must be unique`);
    byId.set(id, template);
  }
  if (attributeValueCount(structuralMarkup(source), 'id', ASSOCIATION_TEMPLATE_ID) !== 0) {
    fail('account-association receipt ID is reserved exclusively for its validated template');
  }

  const openSummary = byId.get(ETF_SUMMARY_ID);
  if(attributeValueCount(structuralMarkup(source),'id',ETF_SUMMARY_ID)!==0)
    fail('ETF open summary ID is reserved exclusively for its validated template');
  let openData;
  if (openSummary) {
    if (openSummary.openingTag !== ETF_SUMMARY_OPEN || !policyContext
        || policyContext.paneClass !== 'p5' || openSummary.start < policyContext.end
        || openSummary.end > policyContext.pane.closeStart
        || source.slice(openSummary.end,policyContext.pane.closeStart).trim() !== '') {
      fail('ETF open summary must be the exact final template in the independent ETF pane');
    }
    try {
      openData = parseEtfSummary(openSummary.body);
      if(openData.rows.at(-1).date > expectedDate || openData.frozenDate > expectedDate)
        throw new Error('summary dates exceed report date');
    } catch(error) { fail(`ETF open summary invalid: ${error.message}`); }
  }
  if(previousFile){
    let prior;
    try { prior=publicationTemplates(fs.readFileSync(previousFile,'utf8'))
      .find(t=>quotedAttribute(t.attributes,'id','previous template')===ETF_SUMMARY_ID); }
    catch(error){fail(`cannot read prior ETF summary: ${error.message}`);}
    if(prior){
      try{
        const old=parseEtfSummary(prior.body);
        if(!openData || openData.startDate!==old.startDate || openData.frozenDate!==old.frozenDate
            ||openData.latestCompleteDate<old.latestCompleteDate ||openData.rows.at(-1).date<old.rows.at(-1).date)
          throw new Error('cannot remove, restart or roll back the published comparison');
      }catch(error){fail(`ETF open summary continuity: ${error.message}`);}
    }
  }

  const decisionTemplate = byId.get(DECISION_STATE_TEMPLATE_ID);
  if (decisionTemplate) {
    const templateType = quotedAttribute(decisionTemplate.attributes, 'type', 'decision template');
    if (templateType !== null && templateType.toLowerCase() !== 'application/json') {
      fail('decision state template type must be application/json');
    }
    const remaining = decisionTemplate.attributes
      .replace(/\bid\s*=\s*(["'])xuan-ib-decision-state-v1\1/i, '')
      .replace(/\btype\s*=\s*(["'])application\/json\1/i, '')
      .trim();
    if (remaining !== '') fail('decision state template has unknown HTML attributes');
  }

  const runtimeTemplate = byId.get(ETF_ABC_STATE_TEMPLATE_ID);
  const runtimeStartCount = source.split(ETF_ABC_RUNTIME_START).length - 1;
  const runtimeEndCount = source.split(ETF_ABC_RUNTIME_END).length - 1;
  let reservedRuntimeElementCount;
  try {
    reservedRuntimeElementCount = countVisibleEtfAbcRuntimeClassElements(source);
  } catch (error) {
    fail(`ETF A/B/C reserved runtime class scan failed: ${error.message}`);
  }
  if (!runtimeTemplate) {
    if (runtimeStartCount !== 0 || runtimeEndCount !== 0 || reservedRuntimeElementCount !== 0) {
      fail('ETF A/B/C runtime markers and reserved runtime class require one validated public state template');
    }
    return;
  }
  if (runtimeTemplate.openingTag !== ETF_ABC_STATE_TEMPLATE_OPENING) {
    fail('ETF A/B/C public state template must use the exact trusted opening tag');
  }
  let runtimeState;
  try {
    runtimeState = parseEtfAbcPublicRuntimeStateJson(runtimeTemplate.body);
    validateEtfAbcInitialPublicRuntimeState(runtimeState);
  } catch (error) {
    fail(`ETF A/B/C public runtime state is invalid: ${error.message}`);
  }
  if (runtimeState.economicDateHkt !== expectedDate) {
    fail('ETF A/B/C public runtime economic date must match the report data date');
  }
  if (runtimeStartCount !== 1 || runtimeEndCount !== 1) {
    fail('ETF A/B/C runtime markers must be one complete unique pair');
  }
  if (!policyContext || policyContext.paneClass !== 'p5') {
    fail('ETF A/B/C runtime state requires the independent ETF pane');
  }
  const runtimeStart = source.indexOf(ETF_ABC_RUNTIME_START);
  const runtimeEnd = source.indexOf(ETF_ABC_RUNTIME_END);
  const runtimeStartEnd = runtimeStart + ETF_ABC_RUNTIME_START.length;
  const pane = policyContext.pane;
  const expectedCard = renderEtfAbcPublicRuntimeCard(runtimeState);
  const expectedBlock = `${ETF_ABC_RUNTIME_START}\n${ETF_ABC_STATE_TEMPLATE_OPENING}${runtimeTemplate.body}</template>\n${expectedCard}\n${ETF_ABC_RUNTIME_END}`;
  const runtimeStructural = visibleElementMarkup(source);
  const reservedRuntimeElements = [...runtimeStructural.matchAll(/<([a-z][a-z0-9:-]*)\b[^>]*>/gi)]
    .filter(opening => decodedClassTokens(opening[0]).includes('xuan-etf-abc-runtime'));
  const runtimeCard = reservedRuntimeElements.length === 1
    && reservedRuntimeElements[0][1].toLowerCase() === 'section'
    ? elementRange(runtimeStructural, 'section', reservedRuntimeElements[0]) : null;
  if (runtimeStart < policyContext.end || runtimeEnd <= runtimeStart
      || runtimeEnd + ETF_ABC_RUNTIME_END.length > pane.closeStart
      || runtimeTemplate.start <= runtimeStartEnd || runtimeTemplate.end >= runtimeEnd
      || source.slice(policyContext.end, runtimeStart).trim() !== ''
      || source.slice(runtimeStartEnd, runtimeTemplate.start).trim() !== ''
      || source.slice(runtimeStart, runtimeEnd + ETF_ABC_RUNTIME_END.length) !== expectedBlock
      || reservedRuntimeElementCount !== 1 || reservedRuntimeElements.length !== 1 || !runtimeCard
      || source.slice(runtimeCard.start, runtimeCard.end) !== expectedCard
      || runtimeCard.start <= runtimeTemplate.end || runtimeCard.end >= runtimeEnd) {
    fail('ETF A/B/C runtime block and visible card must be byte-exact after canonical policy inside the ETF pane');
  }
};

const candidateHasPolicyReservation = policyIdAttributeCount > 0 || policyMarkerCount > 0;
let candidatePolicyContext = null;

// The first production rollout is complete, so every ordinary fresh report now
// requires the trusted deterministic policy module. A records-update is not a
// fresh report: it may only preserve the previous page's policy state. This
// deliberately leaves legacy pages without a module instead of using a receipt
// update to bootstrap unrelated presentation content.
if (!isRecordsUpdate && !candidateHasPolicyReservation) {
  fail('ordinary reports must include the canonical policy-v2 section');
}

let recordsUpdatePreviousPolicyHtml = null;
let recordsUpdatePreviousPolicyStructuralHtml = null;
if (isRecordsUpdate) {
  if (!previousFile) fail('records-update requires a trusted previous handover and pair');
  let previousPolicyHtml;
  try {
    previousPolicyHtml = fs.readFileSync(previousFile, 'utf8');
  } catch {
    fail('could not read the previous handover file');
  }
  recordsUpdatePreviousPolicyHtml = previousPolicyHtml;
  recordsUpdatePreviousPolicyStructuralHtml = structuralMarkup(previousPolicyHtml);
  const previousPolicyIdCount = (previousPolicyHtml.match(/\bid\s*=\s*(["'])xuan-ib-policy-v2\1/gi) || []).length
    + (previousPolicyHtml.match(/\bid\s*=\s*xuan-ib-policy-v2(?=[\s>])/gi) || []).length;
  const previousPolicyMarkerCount = (previousPolicyHtml.match(
    new RegExp(`<!--\\s*${POLICY_ID}:[0-9a-f]{64}\\s*-->`, 'gi')
  ) || []).length;
  const previousHasPolicyReservation = previousPolicyIdCount > 0 || previousPolicyMarkerCount > 0;
  if ((previousPolicyIdCount === 0) !== (previousPolicyMarkerCount === 0)
      || previousPolicyIdCount > 1 || previousPolicyMarkerCount > 1) {
    fail('trusted previous policy-v2 section is incomplete or duplicated');
  }
  if (previousHasPolicyReservation && !candidateHasPolicyReservation) {
    fail('records-update must preserve the trusted previous policy-v2 section');
  }
  if (!previousHasPolicyReservation && candidateHasPolicyReservation) {
    fail('records-update cannot bootstrap policy-v2 onto a legacy page');
  }
}

// Any included module must equal the policy rendered from trusted main. This
// excludes copied live values, stale amounts, scripts and partial edits.
if (candidateHasPolicyReservation) {
  let canonicalPolicySection;
  try {
    canonicalPolicySection = renderPolicySection(JSON.parse(fs.readFileSync(policyJsonFile, 'utf8')));
  } catch (error) {
    fail(`could not load the trusted policy-v2 contract: ${error.message}`);
  }
  const canonicalCount = html.split(canonicalPolicySection).length - 1;
  if (policyIdAttributeCount !== 1 || policySectionOpeningCount !== 1 || policyMarkerCount !== 1) {
    fail('policy-v2 section ID and marker must each be unique');
  }
  if (canonicalCount !== 1) {
    fail('policy-v2 section bytes must equal the trusted deterministic rendering');
  }
  const canonicalStart = html.indexOf(canonicalPolicySection);
  const canonicalEnd = canonicalStart + canonicalPolicySection.length;
  if (!structuralHtml.startsWith('<section id="xuan-ib-policy-v2"', canonicalStart)) {
    fail('policy-v2 section must be visible report markup');
  }
  const configPanes = paneRanges(structuralHtml, 'p3');
  const etfPanes = paneRanges(structuralHtml, 'p5');
  const todoPanes = paneRanges(structuralHtml, 'p4');
  if (configPanes.length !== 1 || todoPanes.length !== 1 || etfPanes.length > 1) {
    fail('policy-v2 requires unique configuration, ETF and todo panes');
  }
  const configPane = configPanes[0];
  const etfPane = etfPanes[0] || null;
  const todoPane = todoPanes[0];
  const candidatePaneClass = policyPaneClass(structuralHtml, canonicalStart, canonicalEnd);
  let policyPane;
  if (!isRecordsUpdate) {
    if (!etfPane || candidatePaneClass !== 'p5'
        || !(configPane.closeStart < todoPane.start && todoPane.closeStart < etfPane.start)) {
      fail('fresh reports must place policy-v2 in the independent ETF pane after todo');
    }
    validateEtfNavigation(structuralHtml);
    validateEtfLayoutCss(structuralHtml);
    policyPane = etfPane;
  } else {
    const previousCanonicalCount = recordsUpdatePreviousPolicyHtml.split(canonicalPolicySection).length - 1;
    const previousCanonicalStart = recordsUpdatePreviousPolicyHtml.indexOf(canonicalPolicySection);
    const previousCanonicalEnd = previousCanonicalStart + canonicalPolicySection.length;
    const previousPaneClass = previousCanonicalCount === 1
      ? policyPaneClass(recordsUpdatePreviousPolicyStructuralHtml, previousCanonicalStart, previousCanonicalEnd)
      : null;
    if (!candidatePaneClass || !previousPaneClass || candidatePaneClass !== previousPaneClass) {
      fail('records-update must preserve the inherited policy pane and cannot move or bootstrap it');
    }
    if (candidatePaneClass === 'p5') {
      if (!etfPane) fail('records-update inherited an invalid ETF pane');
      validateEtfNavigation(structuralHtml);
      validateEtfLayoutCss(structuralHtml);
      policyPane = etfPane;
    } else {
      policyPane = configPane;
    }
  }
  const beforePolicy = html.slice(policyPane.openEnd, canonicalStart)
    .replace(/<!--[\s\S]*?-->/g, '');
  if (beforePolicy.trim() !== '') {
    fail('policy-v2 section must be the first visible module in its inherited pane');
  }
  candidatePolicyContext = {
    start: canonicalStart,
    end: canonicalEnd,
    pane: policyPane,
    paneClass: candidatePaneClass,
  };
}

validatePublicationTemplates(html, candidatePolicyContext);

if (count(/<!doctype\s+html\b/gi) !== 1) fail('exactly one doctype is required');
if (count(/<html\b/gi) !== 1 || count(/<\/html\s*>/gi) !== 1) {
  fail('exactly one html document is required');
}
if (count(/<body\b/gi) !== 1 || count(/<\/body\s*>/gi) !== 1) {
  fail('exactly one body is required');
}
if (count(/<!--\s*xuan-ib-handover:v1\s*-->/gi) !== 1) {
  fail('the publication marker is missing');
}
if (isRecordsUpdate && count(/<!--\s*xuan-ib-handover:v1\s*--><!--\s*xuan-ib-records-update:v1\s*-->/gi) !== 1) {
  fail('records-update marker must immediately follow the publication marker');
}
if (!/<title>\s*XUAN-投资管理\s*<\/title>/i.test(html)) {
  fail('the approved title is missing');
}
if (!/<meta\b[^>]*name=["']apple-mobile-web-app-capable["'][^>]*content=["']yes["']/i.test(html)) {
  fail('the iPhone web-app capability is missing');
}
if (!/<meta\b[^>]*name=["']apple-mobile-web-app-title["'][^>]*content=["']XUAN-投资管理["']/i.test(html)) {
  fail('the iPhone home-screen title is missing');
}
const visibleMarkup = html
  .replace(/<!--([\s\S]*?)-->/g, '')
  .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '');

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const strictKeys = (value, expected, label) => {
  if (!isRecord(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`${label} has missing or unknown fields`);
  }
};

// JSON.parse accepts duplicate object keys, which can create parser differentials
// between the guard and a browser. This small standards-compliant parser rejects
// duplicates before returning the same JSON value shape.
const parseStrictJson = (source, label) => {
  let index = 0;
  const whitespace = () => {
    while (/[ \t\r\n]/.test(source[index] || '')) index += 1;
  };
  const parseString = () => {
    const start = index;
    index += 1;
    let escaped = false;
    while (index < source.length) {
      const char = source[index];
      if (!escaped && char === '"') {
        index += 1;
        try {
          return JSON.parse(source.slice(start, index));
        } catch {
          throw new Error('invalid string');
        }
      }
      if (!escaped && char.charCodeAt(0) < 0x20) throw new Error('control character in string');
      if (!escaped && char === '\\') {
        escaped = true;
      } else {
        escaped = false;
      }
      index += 1;
    }
    throw new Error('unterminated string');
  };
  const parseValue = () => {
    whitespace();
    const char = source[index];
    if (char === '"') return parseString();
    if (char === '{') {
      index += 1;
      whitespace();
      const object = Object.create(null);
      const keys = new Set();
      if (source[index] === '}') {
        index += 1;
        return object;
      }
      while (index < source.length) {
        whitespace();
        if (source[index] !== '"') throw new Error('object key must be a string');
        const key = parseString();
        if (keys.has(key)) throw new Error(`duplicate key ${key}`);
        keys.add(key);
        whitespace();
        if (source[index] !== ':') throw new Error('missing colon');
        index += 1;
        object[key] = parseValue();
        whitespace();
        if (source[index] === '}') {
          index += 1;
          return object;
        }
        if (source[index] !== ',') throw new Error('missing comma');
        index += 1;
      }
      throw new Error('unterminated object');
    }
    if (char === '[') {
      index += 1;
      whitespace();
      const array = [];
      if (source[index] === ']') {
        index += 1;
        return array;
      }
      while (index < source.length) {
        array.push(parseValue());
        whitespace();
        if (source[index] === ']') {
          index += 1;
          return array;
        }
        if (source[index] !== ',') throw new Error('missing comma');
        index += 1;
      }
      throw new Error('unterminated array');
    }
    const rest = source.slice(index);
    const token = rest.match(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/)?.[0];
    if (!token) throw new Error('invalid value');
    index += token.length;
    return JSON.parse(token);
  };

  try {
    const value = parseValue();
    whitespace();
    if (index !== source.length) throw new Error('trailing content');
    return value;
  } catch (error) {
    fail(`${label} is not strict JSON: ${error.message}`);
  }
};

const validHktTimestamp = (value) => {
  if (typeof value !== 'string') return false;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?\+08:00$/);
  if (!match) return false;
  const [, year, month, day, hour, minute, second, fraction = ''] = match;
  const milliseconds = Number(fraction.padEnd(3, '0'));
  const instant = new Date(Date.UTC(
    Number(year), Number(month) - 1, Number(day), Number(hour) - 8,
    Number(minute), Number(second), milliseconds
  ));
  if (Number.isNaN(instant.valueOf())) return false;
  const hkt = new Date(instant.valueOf() + 8 * 60 * 60 * 1000);
  return hkt.getUTCFullYear() === Number(year)
    && hkt.getUTCMonth() + 1 === Number(month)
    && hkt.getUTCDate() === Number(day)
    && hkt.getUTCHours() === Number(hour)
    && hkt.getUTCMinutes() === Number(minute)
    && hkt.getUTCSeconds() === Number(second)
    && hkt.getUTCMilliseconds() === milliseconds;
};

const validatePublicSummary = (summary) => {
  if (typeof summary !== 'string' || summary.trim().length === 0 || [...summary].length > 120) {
    fail('decision receipt publicSummary must contain 1 to 120 Unicode code points');
  }
  if (/[<>&\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069]/u.test(summary)) {
    fail('decision receipt publicSummary contains dangerous characters');
  }
  if (/(?:https?:\/\/|www\.|\b[a-z][a-z0-9+.-]*:\/\/|\bmailto:)/iu.test(summary)) {
    fail('decision receipt publicSummary must not contain a URL');
  }
  if (/(?:github_pat_|gh[pousr]_|\bsk-[A-Za-z0-9_-]{12,}|\bBearer\s+|(?:token|password|secret|api[_ -]?key)\s*[:=])/iu.test(summary)) {
    fail('decision receipt publicSummary must not contain a credential');
  }
  if (/\b\d{8,}\b/u.test(summary)
      || /(?:账户|账号|帐号|account|portfolio)\s*[:#：-]?\s*[A-Z0-9-]{5,}/iu.test(summary)) {
    fail('decision receipt publicSummary must not contain an account number');
  }
  if (/(?:买入|卖出|下单|撤单|改单|换汇|转账|\bbuy\b|\bsell\b|\border\b|\btransfer\b)/iu.test(summary)
      || /(?:[$€£¥]\s*\d|\b\d+(?:\.\d+)?\s*(?:股|shares?)\b|@\s*\d)/iu.test(summary)) {
    fail('decision receipt publicSummary must not contain an executable financial instruction');
  }
};

const decisionIdPattern = /^D-[0-9]{8}-[A-Z0-9-]{1,64}$/;
const receiptIdPattern = /^R-[0-9]{8}-[0-9]{6}-[A-Z0-9]{8}$/;
const hashPattern = /^[0-9a-f]{40}$/i;
const decisionStatuses = new Set(['awaiting_user', 'accepted', 'rejected', 'modified', 'superseded']);
const receiptActions = new Set(['accepted', 'modified', 'deferred']);

const extractDecisionMarkup = (markup) => {
  const elements = [];
  for (const tag of markup.match(/<[A-Za-z][^>]*>/g) || []) {
    if (!/\bdata-decision-(?:id|status)\b/i.test(tag)) continue;
    const decisionId = quotedAttribute(tag, 'data-decision-id', 'decision element');
    const status = quotedAttribute(tag, 'data-decision-status', 'decision element');
    const id = quotedAttribute(tag, 'id', 'decision element');
    if (!decisionId || !status || !id) fail('decision element must have quoted id and decision attributes');
    if (id !== decisionId) fail('decision element id must equal data-decision-id');
    elements.push({ decisionId, status });
  }
  return elements;
};

const extractAwaitingBadge = (markup) => {
  const matchingLabels = [];
  for (const match of markup.matchAll(/<label\b([^>]*)>([\s\S]*?)<\/label\s*>/gi)) {
    const text = match[2].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    const aria = quotedAttribute(match[1], 'aria-label', 'tab label') || '';
    if (/待办/.test(text) || /待办/.test(aria)) matchingLabels.push({ body: match[2], aria });
  }
  if (matchingLabels.length !== 1) fail('exactly one pending-decision navigation label is required');
  const badges = [];
  for (const match of matchingLabels[0].body.matchAll(/<span\b([^>]*)>([\s\S]*?)<\/span\s*>/gi)) {
    const classes = (quotedAttribute(match[1], 'class', 'pending-decision badge') || '').split(/\s+/);
    if (!classes.includes('dot')) continue;
    const value = match[2].replace(/<[^>]*>/g, '').trim();
    if (!/^\d+$/.test(value)) fail('pending-decision badge must be an integer');
    badges.push(Number(value));
  }
  if (badges.length > 1) fail('pending-decision navigation badge must be unique');
  const badge = badges.length === 1 ? badges[0] : 0;
  const ariaCount = matchingLabels[0].aria.match(/待办[^0-9]*(\d+)/)?.[1];
  if (ariaCount !== undefined && Number(ariaCount) !== badge) {
    fail('pending-decision aria label must match its badge');
  }
  return badge;
};

const decisionGroupMarker = (status, edge) => `<!-- xuan-ib-decision-group:v1:${status}:${edge} -->`;

const extractDecisionCards = (documentHtml) => {
  const cards = [];
  const opening = /<details\b[^>]*\bdata-decision-id\s*=\s*(["'])([^"']+)\1[^>]*>/gi;
  for (const match of documentHtml.matchAll(opening)) {
    let depth = 1;
    const tags = /<\/?details\b[^>]*>/gi;
    tags.lastIndex = match.index + match[0].length;
    let tag;
    let end = -1;
    while ((tag = tags.exec(documentHtml)) !== null) {
      depth += /^<\/details/i.test(tag[0]) ? -1 : 1;
      if (depth === 0) {
        end = tags.lastIndex;
        break;
      }
    }
    if (end < 0) fail(`decision card ${match[2]} is not closed`);
    cards.push({ decisionId: match[2], start: match.index, end, html: documentHtml.slice(match.index, end) });
  }
  return cards;
};

const normalizedDecisionCard = (cardHtml) => cardHtml
  .replace(/\bdata-decision-status\s*=\s*(["'])[^"']*\1/i, 'data-decision-status="__STATUS__"')
  .replace(
    /(<span\b[^>]*\bclass\s*=\s*(["'])[^"']*\brt\b[^"']*\2[^>]*>[\s\S]*?·\s*)(?:待 Wu 审核(?:\s*\/\s*待仓库侧补全 mapping)?|已决定\s*\/\s*待落实|已拒绝\s*\/\s*已结案|已取代\s*\/\s*已结案)(\s*<\/span>)/i,
    '$1__VISIBLE_STATUS__$3'
  )
  .replace(
    /(<b\b[^>]*\bclass\s*=\s*(["'])[^"']*\blab\b[^"']*\2[^>]*>\s*状态[：:]\s*<\/b>\s*<b>)(?:待 Wu 审核(?:\s*\/\s*待仓库侧补全 mapping)?|已决定\s*\/\s*待落实|已拒绝\s*\/\s*已结案|已取代\s*\/\s*已结案)(<\/b>\s*（\s*<code>)(?:awaiting_user|accepted|modified|rejected|superseded)(<\/code>)/i,
    '$1__VISIBLE_STATUS__$3__STATUS__$4'
  );

const validateDecisionGroups = (documentHtml, decisionState) => {
  const ranges = new Map();
  let markerTotal = 0;
  for (const status of ['awaiting_user', 'resolved']) {
    const startMarker = decisionGroupMarker(status, 'start');
    const endMarker = decisionGroupMarker(status, 'end');
    const start = documentHtml.indexOf(startMarker);
    const end = documentHtml.indexOf(endMarker);
    const duplicate = start >= 0 && (documentHtml.indexOf(startMarker, start + 1) >= 0
      || documentHtml.indexOf(endMarker, end + 1) >= 0);
    markerTotal += Number(start >= 0) + Number(end >= 0);
    if (duplicate || (start >= 0) !== (end >= 0)) fail('decision group markers must be unique pairs');
    if (start >= 0) {
      if (start >= end) fail('decision group markers are out of order');
      ranges.set(status, { start, end: end + endMarker.length });
    }
  }
  if (markerTotal === 0) return false;
  if (markerTotal !== 4 || ranges.size !== 2) fail('both decision group marker pairs are required');

  const counts = {
    awaiting_user: decisionState.decisions.filter((item) => item.status === 'awaiting_user').length,
    resolved: decisionState.decisions.filter((item) => item.status !== 'awaiting_user').length,
  };
  const heading = {
    awaiting_user: `<h2 data-decision-group-title="awaiting_user">⑤ 待决定事项 <small>${counts.awaiting_user} 项待 Wu 裁决</small></h2>`,
    resolved: `<h2 data-decision-group-title="resolved">已决定 / 待落实 <small>${counts.resolved} 项 · 只记录意见，不执行交易</small></h2>`,
  };
  for (const status of ['awaiting_user', 'resolved']) {
    const range = ranges.get(status);
    const body = documentHtml.slice(range.start, range.end);
    if ((body.match(/<h2\b/gi) || []).length !== 1 || !body.includes(heading[status])) {
      fail(`${status} decision group heading or count is invalid`);
    }
  }

  const decisionById = new Map(decisionState.decisions.map((item) => [item.decisionId, item]));
  for (const card of extractDecisionCards(documentHtml)) {
    const status = decisionById.get(card.decisionId)?.status;
    const expected = status === 'awaiting_user' ? 'awaiting_user'
      : decisionStatuses.has(status) ? 'resolved' : null;
    if (!expected) fail(`decision ${card.decisionId} cannot appear in a records-update display group`);
    const range = ranges.get(expected);
    if (card.start <= range.start || card.end >= range.end) {
      fail(`decision ${card.decisionId} is outside its required display group`);
    }
    const expectedResolvedLabel = status === 'rejected' ? '已拒绝 / 已结案'
      : status === 'superseded' ? '已取代 / 已结案' : '已决定 / 待落实';
    const resolvedLabelCount = (card.html.match(new RegExp(expectedResolvedLabel.replace(/ \/ /g, '\\s*\\/\\s*'), 'g')) || []).length;
    const anyResolvedLabelCount = (card.html.match(/(?:已决定\s*\/\s*待落实|已拒绝\s*\/\s*已结案|已取代\s*\/\s*已结案)/g) || []).length;
    const pendingLabelCount = (card.html.match(/待 Wu 审核/g) || []).length;
    const visibleCodeCount = (card.html.match(new RegExp(`<code>\\s*${status}\\s*<\\/code>`, 'g')) || []).length;
    if (expected === 'resolved' && (resolvedLabelCount !== 2 || anyResolvedLabelCount !== 2
        || pendingLabelCount !== 0 || visibleCodeCount !== 1)) {
      fail(`decision ${card.decisionId} resolved display status is invalid`);
    }
    if (expected === 'awaiting_user' && (pendingLabelCount !== 2 || anyResolvedLabelCount !== 0
        || visibleCodeCount !== 1)) {
      fail(`decision ${card.decisionId} pending display status is invalid`);
    }
  }
  return true;
};

const normalizeRecordsUpdateHtml = (documentHtml, decisionState) => {
  const cards = extractDecisionCards(documentHtml);
  const cardsById = new Map(cards.map((card) => [card.decisionId, normalizedDecisionCard(card.html)]));
  let normalized = documentHtml;
  for (const card of [...cards].sort((a, b) => b.start - a.start)) {
    normalized = normalized.slice(0, card.start) + normalized.slice(card.end);
  }
  normalized = normalized
  .replace(/<!--\s*xuan-ib-records-update:v1\s*-->/gi, '')
  .replace(/<!--\s*xuan-ib-decision-group:v1:(?:awaiting_user|resolved):(?:start|end)\s*-->/gi, '')
  .replace(/<h2\b[^>]*\bdata-decision-group-title\s*=\s*(["'])(?:awaiting_user|resolved)\1[^>]*>[\s\S]*?<\/h2\s*>/gi, '')
  .replace(/<h2>⑤ 待决定事项 <small>[\s\S]*?<\/small><\/h2>/gi, '')
  .replace(
    /<template\b[^>]*\bid\s*=\s*(["'])xuan-ib-decision-state-v1\1[^>]*>[\s\S]*?<\/template\s*>/gi,
    '<template id="xuan-ib-decision-state-v1">__DECISION_STATE__</template>'
  )
  .replace(/\bdata-decision-status\s*=\s*(["'])[^"']*\1/gi, 'data-decision-status="__STATUS__"')
  .replace(/<label\b([^>]*)>([\s\S]*?)<\/label\s*>/gi, (whole, rawAttributes, rawBody) => {
    const aria = quotedAttribute(rawAttributes, 'aria-label', 'tab label') || '';
    const text = rawBody.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    if (!/待办/.test(aria) && !/待办/.test(text)) return whole;
    const attributes = rawAttributes.replace(
      /(\baria-label\s*=\s*)(["'])(.*?)\2/i,
      (attribute, prefix, quote, value) => `${prefix}${quote}${value.replace(/(待办[^0-9]*)\d+/, '$1__COUNT__')}${quote}`
    );
    // A zero pending count has no visible badge. Normalize the standard,
    // non-interactive badge away so a 3 -> 0 records-update can remove it.
    // Keep unexpected attributes/markup intact: removing or changing them
    // must still fail the immutable-content comparison below.
    const body = rawBody.replace(
      /<span\b([^>]*)>\s*\d+\s*<\/span\s*>/gi,
      (badge, badgeAttributes) => {
        const classes = quotedAttribute(badgeAttributes, 'class', 'pending-decision badge') || '';
        if (!classes.split(/\s+/).includes('dot')) return badge;
        const remainingAttributes = badgeAttributes
          .replace(/\bclass\s*=\s*(["'])dot\1/i, '')
          .replace(/\baria-hidden\s*=\s*(["'])true\1/i, '')
          .trim();
        if (classes === 'dot' && remainingAttributes === '') return '';
        return badge.replace(/(>)\s*\d+\s*(<\/span\s*>)/i, '$1__COUNT__$2');
      }
    ).trimEnd();
    return `<label${attributes}>${body}</label>`;
  });
  const canonicalCards = decisionState.decisions
    .map((decision) => `${decision.decisionId}:${cardsById.get(decision.decisionId) || '__MISSING__'}`)
    .join('\n');
  return `${normalized}\n<!-- __DECISION_CARDS__\n${canonicalCards}\n-->`;
};

const parseDecisionState = (documentHtml, options = {}) => {
  const templateTags = [...documentHtml.matchAll(/<template\b([^>]*)>([\s\S]*?)<\/template\s*>/gi)];
  const matching = templateTags.filter((match) => quotedAttribute(match[1], 'id', 'decision template') === DECISION_STATE_TEMPLATE_ID);
  const markerCount = (documentHtml.match(new RegExp(DECISION_STATE_TEMPLATE_ID, 'gi')) || []).length;
  if (matching.length === 0) {
    if (markerCount !== 0) fail('decision state template is malformed');
    return null;
  }
  if (markerCount !== 1) fail('decision state template must be unique');
  if (matching.length !== 1) fail('decision state template must be unique');
  const templateType = quotedAttribute(matching[0][1], 'type', 'decision template');
  if (templateType !== null && templateType.toLowerCase() !== 'application/json') {
    fail('decision state template type must be application/json');
  }
  const templateAttributesWithoutId = matching[0][1]
    .replace(/\bid\s*=\s*(["'])xuan-ib-decision-state-v1\1/i, '')
    .replace(/\btype\s*=\s*(["'])application\/json\1/i, '')
    .trim();
  if (templateAttributesWithoutId !== '') fail('decision state template has unknown HTML attributes');
  const state = parseStrictJson(matching[0][2].trim(), 'decision state template');
  strictKeys(state, ['schemaVersion', 'interaction', 'decisions', 'receipts'], 'decision state template');
  if (state.schemaVersion !== 1) fail('decision state schemaVersion must be 1');
  if (!['disabled', 'enabled'].includes(state.interaction)) {
    fail('decision state interaction must be disabled or enabled');
  }
  if (!Array.isArray(state.decisions) || !Array.isArray(state.receipts)) {
    fail('decision state decisions and receipts must be arrays');
  }

  const decisionIds = new Set();
  const decisions = state.decisions.map((decision, index) => {
    strictKeys(decision, ['decisionId', 'status'], `decision ${index + 1}`);
    if (typeof decision.decisionId !== 'string' || !decisionIdPattern.test(decision.decisionId)) {
      fail(`decision ${index + 1} has an invalid decisionId`);
    }
    if (decisionIds.has(decision.decisionId)) fail('decisionId values must be unique');
    decisionIds.add(decision.decisionId);
    if (!decisionStatuses.has(decision.status)) fail(`decision ${decision.decisionId} has an invalid status`);
    return { decisionId: decision.decisionId, status: decision.status };
  });

  const receiptIds = new Set();
  const receipts = state.receipts.map((receipt, index) => {
    strictKeys(receipt, [
      'receiptId', 'decisionId', 'action', 'responseToSourceSha', 'responseToHtmlBlob',
      'recordedAtHkt', 'publicSummary',
    ], `decision receipt ${index + 1}`);
    if (typeof receipt.receiptId !== 'string' || !receiptIdPattern.test(receipt.receiptId)) {
      fail(`decision receipt ${index + 1} has an invalid receiptId`);
    }
    if (receiptIds.has(receipt.receiptId)) fail('receiptId values must be unique');
    receiptIds.add(receipt.receiptId);
    if (typeof receipt.decisionId !== 'string' || !decisionIds.has(receipt.decisionId)) {
      fail(`decision receipt ${receipt.receiptId} is orphaned`);
    }
    if (!receiptActions.has(receipt.action)) fail(`decision receipt ${receipt.receiptId} has an invalid action`);
    if (typeof receipt.responseToSourceSha !== 'string' || !hashPattern.test(receipt.responseToSourceSha)
        || typeof receipt.responseToHtmlBlob !== 'string' || !hashPattern.test(receipt.responseToHtmlBlob)) {
      fail(`decision receipt ${receipt.receiptId} has an invalid trusted pair`);
    }
    if (!validHktTimestamp(receipt.recordedAtHkt)) {
      fail(`decision receipt ${receipt.receiptId} has an invalid HKT timestamp`);
    }
    validatePublicSummary(receipt.publicSummary);
    return {
      receiptId: receipt.receiptId,
      decisionId: receipt.decisionId,
      action: receipt.action,
      responseToSourceSha: receipt.responseToSourceSha.toLowerCase(),
      responseToHtmlBlob: receipt.responseToHtmlBlob.toLowerCase(),
      recordedAtHkt: receipt.recordedAtHkt,
      publicSummary: receipt.publicSummary,
    };
  });

  const latestReceipt = new Map();
  for (const receipt of receipts) {
    const previous = latestReceipt.get(receipt.decisionId);
    if (!previous || Date.parse(receipt.recordedAtHkt) > Date.parse(previous.recordedAtHkt)
        || (receipt.recordedAtHkt === previous.recordedAtHkt && receipt.receiptId > previous.receiptId)) {
      latestReceipt.set(receipt.decisionId, receipt);
    }
  }
  const decisionById = new Map(decisions.map((decision) => [decision.decisionId, decision]));
  for (const decision of decisions) {
    if (['accepted', 'modified'].includes(decision.status) && !latestReceipt.has(decision.decisionId)) {
      fail(`${decision.status} decision ${decision.decisionId} must have a receipt`);
    }
  }
  for (const [decisionId, receipt] of latestReceipt) {
    const status = decisionById.get(decisionId).status;
    if (receipt.action === 'deferred' && status !== 'awaiting_user') {
      fail(`deferred decision ${decisionId} must remain awaiting_user`);
    }
    if (receipt.action === 'accepted' && !['accepted', 'superseded'].includes(status)) {
      fail(`accepted receipt does not match decision ${decisionId} status`);
    }
    if (receipt.action === 'modified' && !['modified', 'superseded'].includes(status)) {
      fail(`modified receipt does not match decision ${decisionId} status`);
    }
  }

  if (options.validateMarkup !== false) {
    const markupWithoutTemplate = documentHtml.replace(/<template\b[^>]*>[\s\S]*?<\/template\s*>/gi, '');
    const markup = extractDecisionMarkup(markupWithoutTemplate);
    if (markup.length !== decisions.length) fail('decision data attributes must match the decision template');
    const markupIds = new Set();
    for (const item of markup) {
      if (markupIds.has(item.decisionId)) fail('decision data-decision-id values must be unique');
      markupIds.add(item.decisionId);
      const decision = decisionById.get(item.decisionId);
      if (!decision || decision.status !== item.status) {
        fail('decision data attributes must match the decision template');
      }
    }
    const awaiting = decisions.filter((decision) => decision.status === 'awaiting_user').length;
    if (extractAwaitingBadge(markupWithoutTemplate) !== awaiting) {
      fail('pending-decision navigation badge must equal awaiting_user decisions');
    }
  }

  return { schemaVersion: 1, interaction: state.interaction, decisions, receipts };
};
const primaryDates = [];
for (const match of visibleMarkup.matchAll(/<span\b([^>]*)>([\s\S]*?)<\/span\s*>/gi)) {
  const classAttribute = match[1].match(/\bclass\s*=\s*(["'])(.*?)\1/i);
  if (!classAttribute || !classAttribute[2].split(/\s+/).includes('date')) continue;
  const text = match[2].replace(/<[^>]*>/g, ' ').trim();
  const date = text.match(/^(\d{4}-\d{2}-\d{2})\b/);
  primaryDates.push(date ? date[1] : 'invalid');
}
if (primaryDates.length !== 1 || primaryDates[0] !== expectedDate) {
  fail('exactly one primary data-date header must match the expected date');
}

const forbidden = [
  ['external script', /<script\b[^>]*\bsrc\s*=/i],
  ['embedded frame or object', /<(?:iframe|frame|embed|object)\b/i],
  ['protocol-relative URL', /[="'(\s]\/\/[A-Za-z0-9]/i],
  ['remote resource', /<(?:img|audio|video|source|track|link|image)\b|\bsrcset\s*=|\burl\s*\(|@import\b|<meta\b[^>]*http-equiv\s*=\s*["']?refresh/i],
  ['form submission', /<form\b[^>]*\baction\s*=/i],
  ['network call', /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(/i],
  ['browser storage or cookie access', /\b(?:localStorage|sessionStorage|document\.cookie)\b/i],
  ['dynamic code execution', /\b(?:eval|Function)\s*\(/i],
  ['external URL', /\bhttps?:\/\//i],
  ['executable URL', /\b(?:javascript|data\s*:\s*text\/html)\s*:/i],
  ['private key', /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/],
  ['GitHub credential', /\b(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]{20,}/],
  ['API key', /\bsk-[A-Za-z0-9_-]{20,}/],
];

for (const [label, pattern] of forbidden) {
  if (pattern.test(html)) fail(`${label} is not allowed`);
}

for (const [, attrs, body] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
  if (/\bsrc\s*=/i.test(attrs)) fail('external script is not allowed');
  try {
    new Function(body);
  } catch {
    fail('inline script has invalid syntax');
  }
}

const currentDecisionState = parseDecisionState(visibleMarkup);

const previousSourceSha = process.env.XUAN_IB_PREVIOUS_SOURCE_SHA;
const previousHtmlBlob = process.env.XUAN_IB_PREVIOUS_HTML_BLOB;
const continuityInputs = [previousFile, previousSourceSha, previousHtmlBlob];
let trustedPreviousHtml = null;
let verifiedRecordsUpdate = false;
if (continuityInputs.some(Boolean) && !continuityInputs.every(Boolean)) {
  fail('decision continuity requires PREVIOUS_HTML and both trusted previous hashes');
}
if (isRecordsUpdate && !continuityInputs.every(Boolean)) {
  fail('records-update requires a trusted previous handover and pair');
}
if (continuityInputs.every(Boolean)) {
  if (!hashPattern.test(previousSourceSha) || !hashPattern.test(previousHtmlBlob)) {
    fail('decision continuity trusted previous hashes must be 40-hex');
  }
  let previousHtml;
  try {
    previousHtml = fs.readFileSync(previousFile, 'utf8');
  } catch {
    fail('could not read the previous handover file');
  }
  trustedPreviousHtml = previousHtml;
  const previousVisibleMarkup = previousHtml
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '');
  const previousDecisionState = parseDecisionState(previousVisibleMarkup);
  if (isRecordsUpdate && (!previousDecisionState || !currentDecisionState)) {
    fail('records-update requires decision state in both trusted previous and candidate pages');
  }
  if (previousDecisionState && !currentDecisionState) {
    fail('decision state template cannot be removed after bootstrap');
  }
  if (!previousDecisionState && currentDecisionState
      && (currentDecisionState.interaction !== 'disabled' || currentDecisionState.receipts.length !== 0)) {
    fail('decision state bootstrap must disable interaction and contain no receipts');
  }
  if (previousDecisionState && currentDecisionState) {
    if (isRecordsUpdate && currentDecisionState.interaction !== previousDecisionState.interaction) {
      fail('records-update must preserve the trusted previous interaction mode');
    }
    const currentDecisions = new Map(currentDecisionState.decisions.map((decision) => [decision.decisionId, decision]));
    if (isRecordsUpdate
        && (currentDecisionState.decisions.length !== previousDecisionState.decisions.length
          || currentDecisionState.decisions.some(
            (decision, index) => decision.decisionId !== previousDecisionState.decisions[index].decisionId
          ))) {
      fail('records-update must preserve the trusted previous decision ID order');
    }
    const allowedTransitions = {
      awaiting_user: new Set(['awaiting_user', 'accepted', 'modified', 'superseded']),
      accepted: new Set(['accepted', 'superseded']),
      rejected: new Set(['rejected', 'superseded']),
      modified: new Set(['modified', 'superseded']),
      superseded: new Set(['superseded']),
    };
    for (const previousDecision of previousDecisionState.decisions) {
      const currentDecision = currentDecisions.get(previousDecision.decisionId);
      if (!currentDecision) fail(`decision ${previousDecision.decisionId} cannot be removed`);
      if (!allowedTransitions[previousDecision.status].has(currentDecision.status)) {
        fail(`decision ${previousDecision.decisionId} has an invalid status transition`);
      }
    }

    if (currentDecisionState.receipts.length < previousDecisionState.receipts.length) {
      fail('decision receipts are append-only and cannot be removed');
    }
    for (let index = 0; index < previousDecisionState.receipts.length; index += 1) {
      const previousReceipt = previousDecisionState.receipts[index];
      const currentReceipt = currentDecisionState.receipts[index];
      if (JSON.stringify(currentReceipt) !== JSON.stringify(previousReceipt)) {
        fail(`decision receipt ${previousReceipt.receiptId} must remain in the immutable array prefix`);
      }
    }
    const previousDecisions = new Map(
      previousDecisionState.decisions.map((decision) => [decision.decisionId, decision])
    );
    const newReceiptsByDecision = new Map();
    const newReceipts = currentDecisionState.receipts.slice(previousDecisionState.receipts.length);
    if (newReceipts.length > 0 && !isRecordsUpdate) {
      fail('new decision receipts require the records-update marker');
    }
    for (const receipt of newReceipts) {
      const trustedDecision = previousDecisions.get(receipt.decisionId);
      if (!trustedDecision || trustedDecision.status !== 'awaiting_user') {
        fail(`new decision receipt ${receipt.receiptId} must reference a trusted previous awaiting_user decision`);
      }
      if (receipt.responseToSourceSha !== previousSourceSha.toLowerCase()
          || receipt.responseToHtmlBlob !== previousHtmlBlob.toLowerCase()) {
        fail(`new decision receipt ${receipt.receiptId} must bind to the trusted previous pair`);
      }
      const receipts = newReceiptsByDecision.get(receipt.decisionId) || [];
      receipts.push(receipt);
      newReceiptsByDecision.set(receipt.decisionId, receipts);
    }
    if (isRecordsUpdate && newReceipts.length === 0) {
      fail('records-update must append at least one decision receipt');
    }
    for (const previousDecision of previousDecisionState.decisions) {
      const currentDecision = currentDecisions.get(previousDecision.decisionId);
      if (previousDecision.status !== 'awaiting_user'
          || !['accepted', 'modified'].includes(currentDecision.status)) continue;
      const matchingReceipt = (newReceiptsByDecision.get(previousDecision.decisionId) || [])
        .some((receipt) => receipt.action === currentDecision.status);
      if (!matchingReceipt) {
        fail(`decision ${previousDecision.decisionId} status change requires a matching new receipt`);
      }
    }
    if (isRecordsUpdate) {
      for (const previousDecision of previousDecisionState.decisions) {
        const currentDecision = currentDecisions.get(previousDecision.decisionId);
        if (currentDecision.status === previousDecision.status) continue;
        const matchingReceipt = (newReceiptsByDecision.get(previousDecision.decisionId) || [])
          .some((receipt) => receipt.action === currentDecision.status);
        if (!matchingReceipt || !['accepted', 'modified'].includes(currentDecision.status)) {
          fail(`records-update decision ${previousDecision.decisionId} status change requires its matching receipt`);
        }
      }
    }
    if (isRecordsUpdate) {
      const requiresVisibleMigration = previousDecisionState.decisions.some((previousDecision) => {
        const status = currentDecisions.get(previousDecision.decisionId)?.status;
        return previousDecision.status === 'awaiting_user' && ['accepted', 'modified'].includes(status);
      });
      const hasDisplayGroups = validateDecisionGroups(html, currentDecisionState);
      if (requiresVisibleMigration && !hasDisplayGroups) {
        fail('accepted or modified records-update requires guarded decision display groups');
      }
    }
    if (isRecordsUpdate
        && normalizeRecordsUpdateHtml(html, currentDecisionState)
          !== normalizeRecordsUpdateHtml(previousHtml, previousDecisionState)) {
      fail('records-update changed content outside the allowed decision state, status, and pending badge fields');
    }
    // Only a fully checked, byte-semantically immutable legacy response may
    // retain the previous report's classification prose. The marker alone
    // never grants this compatibility exception.
    if (isRecordsUpdate) verifiedRecordsUpdate = true;
  }
}

if (!verifiedRecordsUpdate) {
  const classificationErrors = validateClassificationDisclosure(html, { previousHtml: trustedPreviousHtml });
  if (classificationErrors.length) fail(classificationErrors[0]);
  const cashPlanErrors = validateCashPlan(html, { previousHtml: trustedPreviousHtml });
  if (cashPlanErrors.length) fail(cashPlanErrors[0]);
}

try {
  const edition = publicationEdition(html);
  if (!verifiedRecordsUpdate && !edition) fail('ordinary report requires one recognized edition in its primary header');
  const needsCurrentPolicy = !verifiedRecordsUpdate && (edition === 'adhoc' || hasAssociationMarker(html));
  let snapshot = null;
  if (needsCurrentPolicy) {
    // The injected path is only for trusted local caller/test processes, like
    // POLICY_V2_JSON above. Both production workflows explicitly remove it on
    // every guard invocation, so candidate files cannot choose this snapshot.
    const injected = process.env.XUAN_IB_ASSOCIATION_SNAPSHOT_JSON;
    snapshot = injected
      ? JSON.parse(fs.readFileSync(injected, 'utf8'))
      : loadTrustedAssociationPolicy({ cwd: process.cwd(), requireActive: false });
    validateAssociationSnapshot(snapshot, { now: Date.now(), requireActive: false });
  }
  checkAssociationPublication(html, snapshot, {
    edition, previousHtml: trustedPreviousHtml, previousSourceSha, verifiedRecordsUpdate,
  });
} catch (error) { fail(error.message); }

console.log(`handover guard passed: ${expectedDate}, ${bytes} bytes`);
