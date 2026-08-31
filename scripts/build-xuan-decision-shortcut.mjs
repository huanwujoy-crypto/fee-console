#!/usr/bin/env node
/**
 * Builds an unsigned, secret-free Apple Shortcut. It only reads two fixed public
 * files and returns a proposed decision request. Signing/import and the existing
 * authenticated transport remain separate, deliberate installation steps.
 *
 * Plist/action grounding: Apple's bundled Gallery .wflow files; current source
 * references in viticci/shortcuts-playground-plugin {VARIABLES,CONTROL_FLOW,
 * ACTIONS,DATE_TIME}.md; ScPL action catalog for classic list/count/text keys.
 * Real Shortcuts import/runtime QA is required in addition to these static tests.
 */
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const MENU_NAME = 'XUAN-IB 待办选择菜单';
export const MANIFEST_URL = 'https://huanwujoy-crypto.github.io/fee-console/xuan-ib/latest.decisions.json';
export const META_URL = 'https://huanwujoy-crypto.github.io/fee-console/xuan-ib/latest.meta.json';
export const ACCEPTED_SUMMARY = '采纳 Claude 意见；只记录，不执行';
export const DEFERRED_SUMMARY = '稍后决定；保留待办';

const named = name => ({ Type: 'Variable', VariableName: name });
const attachment = value => ({ Value: value, WFSerializationType: 'WFTextTokenAttachment' });
const input = value => attachment(value);
const ifInput = value => ({ Type: 'Variable', Variable: attachment(value) });

// Ranges are UTF-16 ranges, as used by NSString and Apple's native plist format.
export function tokenText(...parts) {
  let string = '';
  const attachmentsByRange = {};
  for (const part of parts) {
    if (typeof part === 'string') string += part;
    else { attachmentsByRange[`{${string.length}, 1}`] = part; string += '\uFFFC'; }
  }
  return { Value: { string, attachmentsByRange }, WFSerializationType: 'WFTextTokenString' };
}

function dictionaryFields(fields) {
  return {
    Value: { WFDictionaryFieldValueItems: Object.entries(fields).map(([key, value]) => ({
      WFItemType: 0, WFKey: tokenText(key), WFValue: tokenText(value),
    })) },
    WFSerializationType: 'WFDictionaryFieldValue',
  };
}

export function demoManifest({ unavailable = false, empty = false } = {}) {
  return {
    schemaVersion: 1, kind: 'xuan-ib-decision-menu', sourceSha: '1'.repeat(40), htmlBlob: '2'.repeat(40),
    dataDate: '2099-01-01', available: !unavailable, interaction: unavailable ? 'disabled' : 'enabled',
    pending: unavailable || empty ? [] : [
      { decisionId: 'D-20990101-DEMO-ONE', title: '演示一：核对报告说明', recommendation: '保留说明，稍后复核。' },
      { decisionId: 'D-20990101-DEMO-TWO', title: '演示二：意见记录', recommendation: '只记录管理意见，不执行交易。' },
      { decisionId: 'D-20990101-DEMO-THREE', title: '演示三：延后讨论', recommendation: '等待更多资料再决定。' },
    ],
  };
}

export function buildShortcut({ demo = false, empty = false, unavailable = false } = {}) {
  const actions = [];
  const action = (id, params = {}, outputName = 'Result') => {
    const UUID = randomUUID().toUpperCase();
    actions.push({ WFWorkflowActionIdentifier: `is.workflow.actions.${id}`, WFWorkflowActionParameters: { ...params, UUID } });
    return { Type: 'ActionOutput', OutputUUID: UUID, OutputName: outputName };
  };
  const text = (...parts) => action('gettext', { WFTextActionText: tokenText(...parts) }, 'Text');
  const set = (name, value) => action('setvariable', { WFVariableName: name, WFInput: input(value) });
  const append = (name, value) => action('appendvariable', { WFVariableName: name, WFInput: input(value) });
  const get = (key, value) => action('getvalueforkey', { WFGetDictionaryValueType: 'Value', WFDictionaryKey: typeof key === 'string' ? key : tokenText(key), WFInput: input(value) }, 'Dictionary Value');
  const alert = (title, message) => action('alert', { WFAlertActionTitle: title, WFAlertActionMessage: tokenText(message), WFAlertActionCancelButtonShown: false });
  const stop = () => { action('nothing'); action('exit'); };
  const condition = (value, code, literal, body) => {
    const GroupingIdentifier = randomUUID().toUpperCase();
    // A Dictionary Value output is polymorphic. If it is wired directly into a
    // string comparison, Shortcuts can choose a non-text editor parameter and
    // omit WFConditionalActionString's RHS at runtime. A Text action fixes the
    // input's content class before the If is created (not just its display name).
    const stringCondition = code >= 4 && ![100, 101, 1003].includes(code);
    const typedValue = stringCondition ? text(value) : value;
    const parameters = { GroupingIdentifier, WFControlFlowMode: 0, WFCondition: code, WFInput: ifInput(typedValue) };
    if (code < 4) parameters.WFNumberValue = String(literal);
    else if (![100, 101].includes(code)) parameters.WFConditionalActionString = typeof literal === 'string' ? literal : tokenText(literal);
    action('conditional', parameters); body(); action('conditional', { GroupingIdentifier, WFControlFlowMode: 2 });
  };
  const rejectIf = (value, code, literal, message) => condition(value, code, literal, () => { alert('尚未提交', message); stop(); });
  const count = (value, kind = 'Items') => action('count', { Input: input(value), WFCountType: kind }, 'Count');
  const hashKey = value => action('hash', { WFInput: input(value), WFHashType: 'SHA256' }, 'Hash');
  const repeat = (value, body, times) => {
    const GroupingIdentifier = randomUUID().toUpperCase();
    const id = times === undefined ? 'repeat.each' : 'repeat.count';
    action(id, { GroupingIdentifier, WFControlFlowMode: 0, ...(times === undefined ? { WFInput: input(value) } : { WFRepeatCount: times }) });
    body();
    return action(id, { GroupingIdentifier, WFControlFlowMode: 2 }, 'Repeat Results');
  };
  const menu = (prompt, branches) => {
    const GroupingIdentifier = randomUUID().toUpperCase();
    action('choosefrommenu', { GroupingIdentifier, WFControlFlowMode: 0, WFMenuPrompt: prompt, WFMenuItems: Object.keys(branches) });
    for (const [title, body] of Object.entries(branches)) {
      action('choosefrommenu', { GroupingIdentifier, WFControlFlowMode: 1, WFMenuItemTitle: title }); body();
    }
    action('choosefrommenu', { GroupingIdentifier, WFControlFlowMode: 2 });
  };
  const join = (value, separator) => action('text.combine', { text: input(value), WFTextSeparator: 'Custom', WFTextCustomSeparator: separator }, 'Combined Text');
  const replace = (value, find, replacement) => action('text.replace', {
    // Unlike Combine Text's `text`, Replace Text's WFInput is a text-token
    // string in native exports. A bare attachment can import but evaluate empty.
    WFInput: tokenText(value), WFReplaceTextFind: find, WFReplaceTextReplace: replacement,
    WFReplaceTextCaseSensitive: true, WFReplaceTextRegularExpression: true,
  }, 'Updated Text');
  const download = url => action('downloadurl', {
    WFURL: url, WFHTTPMethod: 'GET',
    WFHTTPHeaders: dictionaryFields({ 'Cache-Control': 'no-cache', Pragma: 'no-cache' }),
  }, 'Contents of URL');
  const parse = value => action('detect.dictionary', { WFInput: input(value) }, 'Dictionary');
  const fixture = demoManifest({ empty, unavailable });
  const fetchManifest = () => demo ? parse(text(JSON.stringify(fixture))) : download(MANIFEST_URL);
  const fetchMeta = () => demo ? parse(text(JSON.stringify({ sourceSha: fixture.sourceSha, htmlBlob: fixture.htmlBlob }))) : download(META_URL);
  const ensurePair = (manifest, metadata) => {
    rejectIf(get('sourceSha', manifest), 5, get('sourceSha', metadata), '报告版本已变化或尚未同步。请刷新报告后重新选择。');
    rejectIf(get('htmlBlob', manifest), 5, get('htmlBlob', metadata), '报告版本已变化或尚未同步。请刷新报告后重新选择。');
  };

  action('comment', { WFCommentActionText: demo ? '纯演示：只返回测试 JSON，无网络请求、无认证信息、无真实意见记录。' : '只读菜单：仅 GET 固定公开报告文件；只输出已确认的意见 JSON。无 token、无金融操作。必须配合现有受保护提交快捷指令，空输出不得提交。' });
  const manifest = fetchManifest(); set('报告菜单', manifest);
  const metadata = fetchMeta(); ensurePair(manifest, metadata);
  rejectIf(get('kind', manifest), 5, 'xuan-ib-decision-menu', '待办菜单格式不正确，请稍后刷新。');
  rejectIf(text(get('schemaVersion', manifest)), 5, '1', '待办菜单版本不支持，请稍后刷新。');
  rejectIf(get('interaction', manifest), 5, 'enabled', '待办菜单暂不可用，请稍后刷新。报告仍可阅读。');
  // Compare to a native parsed JSON boolean, not a guessed localized spelling
  // such as true/1/Yes. Missing/false cannot pass this positive availability gate.
  const trueReference = parse(text('{"available":true}'));
  rejectIf(get('available', manifest), 5, get('available', trueReference), '待办菜单暂不可用，请稍后刷新。报告仍可阅读。');
  // Fail closed for absent/malformed report hashes, even if both inputs are blank.
  for (const key of ['sourceSha', 'htmlBlob']) {
    const valid = action('text.match', { text: tokenText(get(key, manifest)), WFMatchTextPattern: '^[0-9a-f]{40}$', WFMatchTextCaseSensitive: true }, 'Matches');
    rejectIf(count(valid), 0, 1, '报告版本资料不完整，请稍后刷新。');
  }
  const pending = get('pending', manifest);
  condition(count(pending), 0, 1, () => { alert('没有待决定事项', '现有意见和回执已保留，无需再次提交。'); stop(); });

  const emptyMap = action('dictionary', { WFItems: dictionaryFields({}) }, 'Dictionary'); set('事项编号映射', emptyMap);
  repeat(pending, () => {
    const item = named('Repeat Item');
    const label = text(named('Repeat Index'), '. ', get('title', item), '\n建议：', get('recommendation', item));
    append('可选事项', label);
    const updatedMap = action('setvalueforkey', {
      WFDictionary: input(named('事项编号映射')), WFDictionaryKey: tokenText(hashKey(label)), WFDictionaryValue: tokenText(get('decisionId', item)),
    }, 'Dictionary'); set('事项编号映射', updatedMap);
  });
  const selected = action('choosefromlist', {
    WFInput: input(named('可选事项')), WFChooseFromListActionPrompt: demo ? '演示：选择事项（可多选，不会提交）' : '选择要回应的事项（可多选）',
    WFChooseFromListActionSelectMultiple: true, WFChooseFromListActionSelectAll: false,
  }, 'Chosen Item');
  condition(count(selected), 0, 1, stop);

  repeat(selected, () => {
    set('当前事项', named('Repeat Item'));
    set('当前编号', get(hashKey(named('当前事项')), named('事项编号映射')));
    set('当前选择', text(''));
    menu(tokenText(named('当前事项'), '\n\n只记录意见，不执行任何交易。'), {
      '采纳 Claude 意见': () => { set('当前选择', text('accepted')); set('当前公开摘要', text(ACCEPTED_SUMMARY)); set('当前选择名称', text('采纳 Claude 意见')); },
      '输入我的意见': () => {
        const provided = action('ask', {
          WFAskActionPrompt: tokenText('请输入可公开展示的简短意见（最多120字）。不要填账户、密码、交易指令、数量或价格。\n', named('当前事项')),
          WFInputType: 'Text', WFAllowsMultilineText: true,
        }, 'Provided Input');
        const trimmed = replace(provided, '^\\s+|\\s+$', '');
        const length = count(trimmed, 'Characters');
        rejectIf(length, 0, 1, '意见为空，本次没有提交。');
        rejectIf(length, 2, 120, '意见过长，请缩短后重新选择。不会自动截断。');
        set('当前选择', text('modified')); set('当前公开摘要', trimmed); set('当前选择名称', text('使用我的意见'));
      },
      '稍后决定': () => { set('当前选择', text('deferred')); set('当前公开摘要', text(DEFERRED_SUMMARY)); set('当前选择名称', text('稍后决定')); },
      '跳过这项': () => { action('nothing'); },
      '取消本次': stop,
    });
    condition(named('当前选择'), 100, undefined, () => {
      const selection = action('dictionary', { WFItems: dictionaryFields({
        decisionId: named('当前编号'), action: named('当前选择'), publicSummary: named('当前公开摘要'),
      }) }, 'Dictionary');
      append('已选意见JSON', text(selection));
      append('最终确认清单', text(named('当前事项'), '\n选择：', named('当前选择名称'), '\n公开摘要：', named('当前公开摘要')));
    });
  });
  condition(count(named('已选意见JSON')), 0, 1, () => { alert('尚未提交', '本次没有选择需要记录的意见。'); stop(); });
  const confirmation = join(named('最终确认清单'), '\n\n');
  menu(tokenText(demo ? '演示确认（不会提交）\n\n' : '确认以下意见\n\n', confirmation, '\n\n摘要将显示在公开报告中。仅记录意见，不下单、撤单、改单或转账。\n确认仅送交 Claude 验证；页面出现回执才表示记录成功。'), {
    '确认记录以上意见': () => { action('nothing'); },
    '取消，不提交': stop,
  });
  ensurePair(named('报告菜单'), fetchMeta());
  const currentDate = action('date', { WFDateActionMode: 'Current Date' }, 'Date');
  const submittedAt = action('format.date', {
    WFDate: tokenText(currentDate), WFDateFormatStyle: 'ISO 8601', WFISO8601IncludeTime: true,
  }, 'Formatted Date');
  // Native random choices provide a request nonce, not a security credential.
  const hex = action('list', { WFItems: '0123456789abcdef'.split('') }, 'List');
  const randomHex = repeat(null, () => { action('getitemfromlist', { WFInput: input(hex), WFItemSpecifier: 'Random Item' }, 'Item from List'); }, 32);
  const requestId = replace(join(randomHex, ''), '^(.{8})(.{4}).(.{3}).(.{3})(.{12})$', '$1-$2-4$3-8$4-$5');
  const selections = join(named('已选意见JSON'), ',');
  const result = text('{"schemaVersion":1,"kind":"xuan-ib-decision-response","requestId":"', requestId,
    '","sourceSha":"', get('sourceSha', named('报告菜单')), '","htmlBlob":"', get('htmlBlob', named('报告菜单')),
    '","submittedAt":"', submittedAt, '","selections":[', selections, ']}');
  action('output', { WFOutput: tokenText(result) });

  return {
    WFWorkflowActions: actions, WFWorkflowName: demo ? `${MENU_NAME}·演示` : MENU_NAME,
    WFWorkflowClientVersion: '2700.0.4', WFWorkflowMinimumClientVersion: 900, WFWorkflowMinimumClientVersionString: '900',
    WFWorkflowIcon: { WFWorkflowIconGlyphNumber: 59845, WFWorkflowIconStartColor: 4274264319 },
    WFWorkflowHasOutputFallback: false, WFWorkflowHasShortcutInputVariables: false,
    WFWorkflowImportQuestions: [], WFWorkflowInputContentItemClasses: [], WFWorkflowOutputContentItemClasses: ['WFStringContentItem'], WFWorkflowTypes: [],
  };
}

/** Minimal no-network/no-record diagnostic for the Ask -> trim -> Count chain. */
export function buildInputDebugShortcut() {
  const actions = [];
  const action = (id, params, outputName = 'Result') => {
    const UUID = randomUUID().toUpperCase();
    actions.push({ WFWorkflowActionIdentifier: `is.workflow.actions.${id}`, WFWorkflowActionParameters: { ...params, UUID } });
    return { Type: 'ActionOutput', OutputUUID: UUID, OutputName: outputName };
  };
  const ask = action('ask', { WFAskActionPrompt: '纯测试：输入一段无私密信息的文字，不会发送或保存。', WFInputType: 'Text', WFAllowsMultilineText: true }, 'Provided Input');
  const rawCount = action('count', { Input: input(ask), WFCountType: 'Characters' }, 'Count');
  const common = { WFReplaceTextFind: '^\\s+|\\s+$', WFReplaceTextReplace: '', WFReplaceTextCaseSensitive: true, WFReplaceTextRegularExpression: true };
  const old = action('text.replace', { ...common, WFInput: input(ask) }, 'Updated Text');
  const oldCount = action('count', { Input: input(old), WFCountType: 'Characters' }, 'Count');
  const fixed = action('text.replace', { ...common, WFInput: tokenText(ask) }, 'Updated Text');
  const fixedCount = action('count', { Input: input(fixed), WFCountType: 'Characters' }, 'Count');
  const result = action('gettext', { WFTextActionText: tokenText(
    '输入原文：[', ask, ']\n原文计数：', rawCount,
    '\n\n旧编码去空格：[', old, ']\n旧编码计数：', oldCount,
    '\n\n新编码去空格：[', fixed, ']\n新编码计数：', fixedCount,
    '\n\n本测试没有网络、没有真实意见记录。',
  ) }, 'Text');
  action('showresult', { Text: tokenText(result) });
  return {
    WFWorkflowActions: actions, WFWorkflowName: 'XUAN 菜单输入链诊断', WFWorkflowClientVersion: '2700.0.4',
    WFWorkflowMinimumClientVersion: 900, WFWorkflowMinimumClientVersionString: '900',
    WFWorkflowIcon: { WFWorkflowIconGlyphNumber: 59845, WFWorkflowIconStartColor: 4274264319 },
    WFWorkflowHasOutputFallback: false, WFWorkflowHasShortcutInputVariables: false,
    WFWorkflowImportQuestions: [], WFWorkflowInputContentItemClasses: [], WFWorkflowOutputContentItemClasses: [], WFWorkflowTypes: [],
  };
}

export function plistXml(value) {
  const escape = x => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const encode = item => {
    if (typeof item === 'string') return `<string>${escape(item)}</string>`;
    if (typeof item === 'number') return `<${Number.isInteger(item) ? 'integer' : 'real'}>${item}</${Number.isInteger(item) ? 'integer' : 'real'}>`;
    if (typeof item === 'boolean') return item ? '<true/>' : '<false/>';
    if (Array.isArray(item)) return `<array>${item.map(encode).join('')}</array>`;
    if (item && typeof item === 'object') return `<dict>${Object.entries(item).map(([key, val]) => `<key>${escape(key)}</key>${encode(val)}`).join('')}</dict>`;
    throw new Error('Unsupported plist value');
  };
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">${encode(value)}</plist>\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const output = args.find(arg => !arg.startsWith('--'));
  if (!output) throw new Error('Usage: node scripts/build-xuan-decision-shortcut.mjs OUTPUT.shortcut [--demo] [--empty] [--unavailable] [--debug-input]');
  const shortcut = args.includes('--debug-input') ? buildInputDebugShortcut() : buildShortcut({ demo: args.includes('--demo'), empty: args.includes('--empty'), unavailable: args.includes('--unavailable') });
  await writeFile(output, plistXml(shortcut), { flag: 'wx', mode: 0o600 });
  console.log(`Created unsigned, secret-free Shortcut: ${output}`);
}
