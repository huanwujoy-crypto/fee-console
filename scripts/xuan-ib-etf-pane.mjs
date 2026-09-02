#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderPolicySection, validatePolicy } from './xuan-ib-policy-page.mjs';

export const ETF_TAB_CSS_V1 = `#s5:checked~.tabbar label[for="s5"]{background:var(--ink);color:var(--bg);border-color:var(--ink)}
#s5:checked~.p5{display:block}
@media(max-width:640px){.tabbar{grid-template-columns:repeat(5,minmax(0,1fr))}}
@media(max-width:360px){.tabbar{gap:2px}.tabbar label{padding:4px 2px;font-size:11px;gap:2px}.tabbar label .dot{min-width:14px;padding:0 3px}}`;
export const ETF_TAB_RADIO_V1 = '<input type="radio" name="sec" id="s5">';
export const ETF_TAB_LABEL_V1 = '<label for="s5" aria-label="XUAN-ETF 计划">ETF</label>';

const classTokens = tag => {
  const match = tag.match(/\bclass\s*=\s*(?:(["'])(.*?)\1|([^\s>]+))/i);
  return match ? (match[2] ?? match[3]).split(/\s+/).filter(Boolean) : [];
};

const blankMatch = match => ' '.repeat(match.length);
const structuralMarkup = source => source
  .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, blankMatch)
  .replace(/<template\b[^>]*>[\s\S]*?<\/template\s*>/gi, blankMatch)
  .replace(/<!--[\s\S]*?-->/g, blankMatch);

const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const attributeValueCount = (source, name, value) => (source.match(new RegExp(
  `(?:^|[\\s<])${escapeRegex(name)}\\s*=\\s*(?:"${escapeRegex(value)}"|'${escapeRegex(value)}'|${escapeRegex(value)}(?=[\\s>/]))`,
  'gi'
)) || []).length;
const identityAttributeHasCharacterReference = source => /(?:^|[\s<])(?:id|for)\s*=\s*(?:"[^"]*&[^"]*"|'[^']*&[^']*'|[^\s>]*&[^\s>]*)/i.test(source);
const navigationOrder = Object.freeze(['s1', 's2', 's3', 's4', 's5']);
const legacyEtfFirstNavigationOrder = Object.freeze(['s1', 's2', 's3', 's5', 's4']);
const navigationText = Object.freeze({ s1: '概览', s2: '风险', s3: '配置', s4: '待办', s5: 'ETF' });

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
  .map(opening => elementRange(source, 'div', opening))
  .filter(Boolean);

const paneRanges = (source, paneClass) => divRangesWithClass(source, 'pane')
  .filter(range => classTokens(range.openingTag).includes(paneClass));

const quotedAttribute = (attributes, name) => {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = [...attributes.matchAll(new RegExp(`(?:^|\\s)${escapedName}\\s*=\\s*(["'])(.*?)\\1`, 'gi'))];
  return matches.length === 1 ? matches[0][2] : null;
};

function assertIntegratedEtfPane(source, canonicalSection, { etfBeforeTodo = false } = {}) {
  const structural = structuralMarkup(source);
  const config = paneRanges(source, 'p3');
  const etf = paneRanges(source, 'p5');
  const todo = paneRanges(source, 'p4');
  const expectedNavigationOrder = etfBeforeTodo ? legacyEtfFirstNavigationOrder : navigationOrder;
  const expectedNavigationText = etfBeforeTodo
    ? '概览 / 风险 / 配置 / ETF / 待办'
    : '概览 / 风险 / 配置 / 待办 / ETF';
  const expectedPaneOrder = etfBeforeTodo ? 'p3, p5 and p4' : 'p3, p4 and p5';
  if (config.length !== 1 || etf.length !== 1 || todo.length !== 1
      || !(etfBeforeTodo
        ? config[0].closeStart < etf[0].start && etf[0].closeStart < todo[0].start
        : config[0].closeStart < todo[0].start && todo[0].closeStart < etf[0].start)) {
    throw new Error(`integrated handover must have one ${expectedPaneOrder} in ${expectedNavigationText} DOM order`);
  }
  const policyStart = source.indexOf(canonicalSection);
  const policyEnd = policyStart + canonicalSection.length;
  if (policyStart < etf[0].openEnd || policyEnd > etf[0].closeStart
      || source.slice(etf[0].openEnd, policyStart).replace(/<!--[\s\S]*?-->/g, '').trim() !== '') {
    throw new Error('canonical policy must be the first visible module in p5');
  }
  if (source.split(ETF_TAB_CSS_V1).length - 1 !== 1
      || source.split(ETF_TAB_RADIO_V1).length - 1 !== 1
      || source.split(ETF_TAB_LABEL_V1).length - 1 !== 1) {
    throw new Error('integrated handover must contain the exact ETF tab CSS, radio and label once');
  }
  if (identityAttributeHasCharacterReference(structural)) {
    throw new Error('navigation identity attributes cannot contain character references');
  }
  const inputTags = [...structural.matchAll(/<input\b([^>]*)>/gi)];
  const labelTags = [...structural.matchAll(/<label\b([^>]*)>([\s\S]*?)<\/label\s*>/gi)];
  const exactInputs = inputTags
    .filter(match => match[0] === ETF_TAB_RADIO_V1);
  const exactLabels = labelTags
    .filter(match => match[0] === ETF_TAB_LABEL_V1);
  const tabbars = divRangesWithClass(structural, 'tabbar');
  const allPanes = divRangesWithClass(structural, 'pane');
  if (exactInputs.length !== 1 || exactLabels.length !== 1 || tabbars.length !== 1) {
    throw new Error('integrated handover must contain the exact ETF controls in one tabbar');
  }
  const orderedInputs = [];
  const orderedLabels = [];
  for (const id of expectedNavigationOrder) {
    if (attributeValueCount(structural, 'id', id) !== 1
        || attributeValueCount(structural, 'for', id) !== 1) {
      throw new Error(`navigation must reserve id=${id} and for=${id} exactly once`);
    }
    const inputs = inputTags.filter(match => quotedAttribute(match[1], 'id') === id);
    const labels = labelTags.filter(match => quotedAttribute(match[1], 'for') === id);
    if (inputs.length !== 1 || labels.length !== 1
        || quotedAttribute(inputs[0][1], 'type') !== 'radio'
        || quotedAttribute(inputs[0][1], 'name') !== 'sec'
        || /(?:^|\s)(?:disabled|hidden)(?:\s|=|$)/i.test(inputs[0][1])
        || /(?:^|\s)(?:hidden)(?:\s|=|$)/i.test(labels[0][1])) {
      throw new Error(`navigation control ${id} is not an enabled sec radio and label`);
    }
    const text = labels[0][2].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    if (id === 's4' ? !/^待办(?:\s+\d+)?$/.test(text) : text !== navigationText[id]) {
      throw new Error(`navigation label ${id} has the wrong visible text`);
    }
    orderedInputs.push(inputs[0]);
    orderedLabels.push(labels[0]);
  }
  if (orderedInputs.some((match, index) => index > 0 && orderedInputs[index - 1].index >= match.index)
      || orderedLabels.some((match, index) => index > 0 && orderedLabels[index - 1].index >= match.index)
      || orderedInputs.some(match => match.index >= tabbars[0].start)
      || orderedLabels.some(match => match.index < tabbars[0].openEnd
        || match.index + match[0].length > tabbars[0].closeStart)
      || allPanes.length === 0
      || allPanes.some(pane => tabbars[0].end > pane.start)) {
    throw new Error(`navigation must appear as ${expectedNavigationText} before all panes`);
  }
  const cssStart = structural.indexOf(ETF_TAB_CSS_V1);
  const cssEnd = cssStart + ETF_TAB_CSS_V1.length;
  const bodyOpenings = [...structural.matchAll(/<body\b[^>]*>/gi)];
  const containingStyles = [...structural.matchAll(/<style\b[^>]*>/gi)]
    .map(opening => elementRange(structural, 'style', opening))
    .filter(range => range && range.openEnd <= cssStart && cssEnd <= range.closeStart);
  if (bodyOpenings.length !== 1 || containingStyles.length !== 1
      || containingStyles[0].openingTag !== '<style>'
      || containingStyles[0].end > bodyOpenings[0].index) {
    throw new Error('ETF CSS must be inside one ordinary document-level style element');
  }
  const s4InputIndex = source.search(/<input\b[^>]*\bid\s*=\s*(["'])s4\1[^>]*>/i);
  const s4LabelIndex = source.search(/<label\b[^>]*\bfor\s*=\s*(["'])s4\1[^>]*>/i);
  if (s4InputIndex < 0 || s4LabelIndex < 0
      || (etfBeforeTodo
        ? source.indexOf(ETF_TAB_RADIO_V1) > s4InputIndex
          || source.indexOf(ETF_TAB_LABEL_V1) > s4LabelIndex
        : source.indexOf(ETF_TAB_RADIO_V1) < s4InputIndex
          || source.indexOf(ETF_TAB_LABEL_V1) < s4LabelIndex)) {
    throw new Error(`ETF navigation must appear ${etfBeforeTodo ? 'before' : 'after'} the existing todo navigation`);
  }
}

function reorderExistingEtfAfterTodo(source, canonicalSection) {
  assertIntegratedEtfPane(source, canonicalSection, { etfBeforeTodo: true });

  let reordered = source.replace(ETF_TAB_RADIO_V1, '');
  const s4Input = [...reordered.matchAll(/<input\b([^>]*)>/gi)]
    .find(match => quotedAttribute(match[1], 'id') === 's4');
  if (!s4Input) throw new Error('could not resolve the s4 radio reorder point');
  const inputEnd = s4Input.index + s4Input[0].length;
  reordered = reordered.slice(0, inputEnd) + ETF_TAB_RADIO_V1 + reordered.slice(inputEnd);

  reordered = reordered.replace(ETF_TAB_LABEL_V1, '');
  const s4Label = [...reordered.matchAll(/<label\b([^>]*)>[\s\S]*?<\/label\s*>/gi)]
    .find(match => quotedAttribute(match[1], 'for') === 's4');
  if (!s4Label) throw new Error('could not resolve the s4 label reorder point');
  const labelEnd = s4Label.index + s4Label[0].length;
  reordered = reordered.slice(0, labelEnd) + ETF_TAB_LABEL_V1 + reordered.slice(labelEnd);

  const etfPane = paneRanges(reordered, 'p5');
  if (etfPane.length !== 1) throw new Error('could not resolve the ETF pane reorder point');
  const etfMarkup = reordered.slice(etfPane[0].start, etfPane[0].end);
  reordered = reordered.slice(0, etfPane[0].start) + reordered.slice(etfPane[0].end);
  const todoPane = paneRanges(reordered, 'p4');
  if (todoPane.length !== 1) throw new Error('could not resolve the todo pane reorder point');
  reordered = reordered.slice(0, todoPane[0].end) + etfMarkup + reordered.slice(todoPane[0].end);

  assertIntegratedEtfPane(reordered, canonicalSection);
  return reordered;
}

// Migrate presentation only. The source must already contain the approved,
// byte-identical policy section at the top of legacy p3. Report facts,
// decision receipts and policy bytes are not generated or edited here.
export function migratePolicyToEtfPane(html, policy) {
  validatePolicy(policy);
  const source = String(html ?? '');
  if (/<!--\s*xuan-ib-records-update:v1\s*-->/i.test(source)) {
    throw new Error('records-update cannot migrate or bootstrap the ETF pane');
  }
  const canonicalSection = renderPolicySection(policy);
  if (source.split(canonicalSection).length - 1 !== 1) {
    throw new Error('handover must contain the canonical policy section exactly once');
  }

  const existingEtfPane = paneRanges(source, 'p5');
  if (existingEtfPane.length === 1) {
    const existingTodoPane = paneRanges(source, 'p4');
    if (existingTodoPane.length === 1 && existingEtfPane[0].start < existingTodoPane[0].start) {
      return reorderExistingEtfAfterTodo(source, canonicalSection);
    }
    assertIntegratedEtfPane(source, canonicalSection);
    return source;
  }
  const structural = structuralMarkup(source);
  if (identityAttributeHasCharacterReference(structural)) {
    throw new Error('navigation identity attributes cannot contain character references');
  }
  if (existingEtfPane.length !== 0 || attributeValueCount(structural, 'id', 's5') > 0
      || attributeValueCount(structural, 'for', 's5') > 0
      || source.includes(ETF_TAB_CSS_V1)) {
    throw new Error('partial or duplicate ETF navigation cannot be migrated');
  }

  const config = paneRanges(source, 'p3');
  const todo = paneRanges(source, 'p4');
  const policyStart = source.indexOf(canonicalSection);
  const policyEnd = policyStart + canonicalSection.length;
  if (config.length !== 1 || todo.length !== 1 || config[0].closeStart >= todo[0].start
      || policyStart < config[0].openEnd || policyEnd > config[0].closeStart
      || source.slice(config[0].openEnd, policyStart).replace(/<!--[\s\S]*?-->/g, '').trim() !== '') {
    throw new Error('legacy handover must have the canonical policy first in p3 before p4');
  }

  const s4Inputs = [...source.matchAll(/<input\b([^>]*)>/gi)]
    .filter(match => quotedAttribute(match[1], 'id') === 's4' && quotedAttribute(match[1], 'name') === 'sec');
  const s4Labels = [...source.matchAll(/<label\b([^>]*)>/gi)]
    .filter(match => quotedAttribute(match[1], 'for') === 's4');
  if (s4Inputs.length !== 1 || s4Labels.length !== 1) {
    throw new Error('legacy handover requires one existing s4 radio and label anchor');
  }
  const bodyOpenings = [...structural.matchAll(/<body\b[^>]*>/gi)];
  const documentStyles = [...structural.matchAll(/<style\b[^>]*>/gi)]
    .map(opening => elementRange(structural, 'style', opening))
    .filter(range => range && range.openingTag === '<style>'
      && bodyOpenings.length === 1 && range.end <= bodyOpenings[0].index);
  if (bodyOpenings.length !== 1 || documentStyles.length !== 1) {
    throw new Error('legacy handover requires a document-level style anchor');
  }
  const styleClose = documentStyles[0].closeStart;

  let migrated = source.slice(0, styleClose) + '\n' + ETF_TAB_CSS_V1 + '\n' + source.slice(styleClose);
  const s4Input = [...migrated.matchAll(/<input\b([^>]*)>/gi)]
    .find(match => quotedAttribute(match[1], 'id') === 's4'
      && quotedAttribute(match[1], 'name') === 'sec');
  if (!s4Input) throw new Error('could not resolve the s4 radio insertion point');
  const s4InputEnd = s4Input.index + s4Input[0].length;
  migrated = migrated.slice(0, s4InputEnd) + ETF_TAB_RADIO_V1 + migrated.slice(s4InputEnd);
  const s4Label = [...migrated.matchAll(/<label\b([^>]*)>[\s\S]*?<\/label\s*>/gi)]
    .find(match => quotedAttribute(match[1], 'for') === 's4');
  if (!s4Label) throw new Error('could not resolve the s4 label insertion point');
  const s4LabelEnd = s4Label.index + s4Label[0].length;
  migrated = migrated.slice(0, s4LabelEnd) + '\n' + ETF_TAB_LABEL_V1 + migrated.slice(s4LabelEnd);
  migrated = migrated.replace(canonicalSection, '');
  const migratedTodo = paneRanges(migrated, 'p4');
  if (migratedTodo.length !== 1) throw new Error('could not resolve the todo pane insertion point');
  migrated = migrated.slice(0, migratedTodo[0].end)
    + `\n<div class="pane p5">\n${canonicalSection}\n</div>\n`
    + migrated.slice(migratedTodo[0].end);
  assertIntegratedEtfPane(migrated, canonicalSection);
  return migrated;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4) {
      throw new Error('Usage: node scripts/xuan-ib-etf-pane.mjs HANDOVER.html POLICY.json');
    }
    process.stdout.write(migratePolicyToEtfPane(
      fs.readFileSync(process.argv[2], 'utf8'),
      JSON.parse(fs.readFileSync(process.argv[3], 'utf8'))
    ));
  } catch (error) {
    process.stderr.write(error.message + '\n');
    process.exitCode = 1;
  }
}
