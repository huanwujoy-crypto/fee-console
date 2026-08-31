import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Trusted, read-only interim classification disclosure.
 * This is the scope of the independently checked 2026-08-31 audit, not a
 * current holdings feed. Updating it requires reviewed source evidence and a
 * trusted maintenance change. It never derives or changes portfolio amounts.
 */
export const CLASSIFICATION_DISCLOSURE_ID = 'xuan-ib-classification-disclosure-v1';

const DISCLOSURE = `<section id="xuan-ib-classification-disclosure-v1">
<h3>四桶分类核验与沿用口径</h3>
<ol>
<li>历史核验范围：2026-08-31 15:31–15:34 HKT，仅 NOAH-HK、ANTARCTICA、UBS 三个组合，不是本次七组合全量核验。</li>
<li>该次 38 项 Semi Liquid 持仓全部覆盖：7 次逐仓例外（holdingOverrides）＋31 次整组合规则（portfolioRules），该三组合的半流动持仓未覆盖为 0。规则顺序为：来源明确的现金 → 逐仓 ID 与名称交叉校验 → 整组合规则 → 精确通用资产标签 → 未知。不能用持仓总数减逐仓例外数量推算分类缺口。</li>
<li>该次共核查 57 行，56 行已分类，1 行 UBS 现金身份尚待来源核实；其余四个家庭组合不在该次核验范围。不能把三组合覆盖结果当成七组合全量完成，也不能按名称猜现金或分类。</li>
<li>本页四桶、三层流动性及依赖归桶的指标继续沿用已批准的 2026-08-24 快照。只有七组合范围、现金身份、完整持仓及金额对账经来源核验，并通过受控维护更新本说明后，才可改称实时重算。其他指标按各自已披露的数据时点与来源处理，不因本项回退停止报告。</li>
</ol>
</section>`;

export function renderClassificationDisclosure() {
  return DISCLOSURE;
}

// Ignore inert source containers, but never accept a canonical block hidden
// inside one as the report disclosure. Decision receipts remain immutable JSON.
function displayedMarkup(html) {
  return String(html ?? '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
}

function decodeText(text) {
  return text.replace(/&(?:#(x[0-9a-f]+|[0-9]+)|([a-z]+));/gi, (whole, number, named) => {
    if (number) {
      const value = number[0].toLowerCase() === 'x' ? parseInt(number.slice(1), 16) : Number(number);
      return value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff) ? String.fromCodePoint(value) : whole;
    }
    return ({ nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", ensp: ' ', emsp: ' ', thinsp: ' ' })[named.toLowerCase()] ?? whole;
  }).normalize('NFKC').replace(/[\u200B-\u200F\u2060\uFEFF]/g, '');
}

function displayedText(markup) {
  return decodeText(markup.replace(/<[^>]*>/g, ' '))
    .replace(/\bD-\d{8}-[A-Z][A-Z0-9-]*\b/g, '[decision ID]')
    .replace(/\s+/g, ' ');
}

const ruleReasoning = /semi[\s_-]*liquid|半流动|holding[\s_-]*overrides?|portfolio[\s_-]*rules?|unknown[\s_-]*semi[\s_-]*liquid/i;
const fourBucketTopic = /四桶|三层流动性|归桶|four[\s_-]*bucket/i;
// These are classification-coverage claims, not currency/percentages or IDs.
// Ordinary security classification (e.g. MRVL §0-A) has a separate policy.
const numericCoverageGap = /(?:\d+\s*(?:个|项|条|行|只)\s*(?:尚|仍|还)?\s*(?:未覆盖|未映射|未归桶)|(?:未覆盖|未映射|未归桶)\s*(?:为|共|有|约|:)?\s*\d+\s*(?:个|项|条|行|只)?)/i;
const numericClassificationGap = /(?:\d+\s*(?:个|项|条|行|只)\s*(?:尚|仍|还)?\s*(?:未分类|待分类|未归类)|(?:未分类|待分类|未归类)\s*(?:为|共|有|约|:)?\s*\d+\s*(?:个|项|条|行|只)?)/i;
const unsupportedCurrentClassification = /(?:实时(?:重算|分类|归桶)|(?:已|全部|全量)(?:经|完成|实现|为|是|按)?\s*实时|(?:七|7)\s*(?:个)?\s*(?:组合|portfolio)[^。；;]{0,30}(?:分类|归桶)[^。；;]{0,20}(?:全量|全部|完整|完成)|(?:七|7)\s*(?:个)?\s*(?:组合|portfolio)[^。；;]{0,15}(?:全量|全部|完整)[^。；;]{0,15}(?:核验|覆盖|完成)|(?:全量|全部|完整)[^。；;]{0,15}(?:分类|归桶)(?:已)?完成)/i;

function disclosureTags(markup) {
  const blocks = [];
  for (const match of markup.matchAll(/<([a-z][\w:-]*)\b([^<>]*)>/gi)) {
    const ids = [...match[2].matchAll(/(?:^|\s)id\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)];
    if (ids.some(id => decodeText(id[1] ?? id[2] ?? id[3]) === CLASSIFICATION_DISCLOSURE_ID)) blocks.push(match);
  }
  return blocks;
}

/** Validate canonical explanatory text, not the financial calculations.
 * The trusted guard must call this for ordinary candidates. Legacy
 * records-update compatibility belongs to its complete continuity checks,
 * and cannot be enabled by an option or marker supplied to this function.
 */
export function validateClassificationDisclosure(html, { previousHtml = null } = {}) {
  const markup = displayedMarkup(html);
  const text = displayedText(markup);
  const previousText = displayedText(displayedMarkup(previousHtml));
  const blocks = disclosureTags(markup);
  const allBlocks = disclosureTags(String(html ?? ''));
  const required = fourBucketTopic.test(text) || ruleReasoning.test(text)
    || fourBucketTopic.test(previousText) || ruleReasoning.test(previousText) || allBlocks.length > 0;
  if (!required) return [];
  if (blocks.length !== 1 || allBlocks.length !== 1) return ['classification disclosure must have exactly one visible canonical block'];
  const start = blocks[0].index;
  const rawStart = allBlocks[0].index;
  if (markup.slice(start, start + DISCLOSURE.length) !== DISCLOSURE
      || String(html).slice(rawStart, rawStart + DISCLOSURE.length) !== DISCLOSURE) {
    return ['classification disclosure differs from the trusted historical audit and fallback policy'];
  }
  const outside = markup.slice(0, start) + markup.slice(start + DISCLOSURE.length);
  const outsideText = displayedText(outside);
  if (ruleReasoning.test(outsideText)) {
    return ['classification rule/count reasoning must appear only in the canonical disclosure'];
  }
  if (numericCoverageGap.test(outsideText)) {
    return ['classification coverage-gap counts outside the canonical disclosure are not allowed'];
  }
  // Limit generic 未分类 matching to its own block/clause so a separate
  // single-security policy issue is not mistaken for a four-bucket claim.
  for (const clause of outside.split(/<\/(?:p|li|div|h[1-6]|section|summary)\s*>|[。；;！？\n]/i)) {
    const clauseText = displayedText(clause);
    if (fourBucketTopic.test(clauseText) && numericClassificationGap.test(clauseText)) {
      return ['four-bucket unclassified counts outside the canonical disclosure are not allowed'];
    }
    if ((fourBucketTopic.test(clauseText) || /(?:七|7)\s*(?:个)?\s*(?:组合|portfolio).{0,30}(?:分类|归桶)/i.test(clauseText)) && unsupportedCurrentClassification.test(clauseText)) {
      return ['four-bucket current/full-scope classification is not supported by the trusted historical audit'];
    }
  }
  return [];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) {
    process.stderr.write('Usage: node scripts/xuan-ib-classification-disclosure.mjs\n');
    process.exitCode = 2;
  } else process.stdout.write(`${renderClassificationDisclosure()}\n`);
}
