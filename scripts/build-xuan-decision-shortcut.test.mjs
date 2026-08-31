import test from 'node:test';
import assert from 'node:assert/strict';
import { buildShortcut, buildInputDebugShortcut, plistXml, tokenText, MENU_NAME, MANIFEST_URL, META_URL } from './build-xuan-decision-shortcut.mjs';

test('native menu is secret-free and has only fixed public GET requests', () => {
  const shortcut = buildShortcut();
  const text = JSON.stringify(shortcut);
  assert.equal(shortcut.WFWorkflowName, MENU_NAME);
  assert.doesNotMatch(text, /Bearer |sk-ant-|api\.anthropic\.com|setclipboard|openurl|runworkflow|runssh|runshell|scriptforautomation/);
  const network = shortcut.WFWorkflowActions.filter(x => x.WFWorkflowActionIdentifier.endsWith('.downloadurl'));
  assert.equal(network.length, 3);
  assert.deepEqual(network.map(x => x.WFWorkflowActionParameters.WFURL), [MANIFEST_URL, META_URL, META_URL]);
  assert.ok(network.every(x => x.WFWorkflowActionParameters.WFHTTPMethod === 'GET'));
  for (const action of network) {
    const headers = action.WFWorkflowActionParameters.WFHTTPHeaders.Value.WFDictionaryFieldValueItems;
    assert.deepEqual(headers.map(x => [x.WFKey.Value.string, x.WFValue.Value.string]), [['Cache-Control', 'no-cache'], ['Pragma', 'no-cache']]);
  }
});

test('demo and zero-pending fixtures have no network or transport actions', () => {
  for (const options of [{ demo: true }, { demo: true, empty: true }, { demo: true, unavailable: true }]) {
    const built = buildShortcut(options);
    assert.doesNotMatch(JSON.stringify(built), /is\.workflow\.actions\.(downloadurl|runworkflow|openurl)/);
    assert.ok(built.WFWorkflowName.endsWith('·演示'));
  }
});

test('all groupings are well nested, menu titles match and every reference exists', () => {
  const shortcut = buildShortcut();
  const actions = shortcut.WFWorkflowActions;
  const uuids = new Set(actions.map(x => x.WFWorkflowActionParameters.UUID));
  const stack = [];
  for (const action of actions) {
    const p = action.WFWorkflowActionParameters;
    const mode = p.WFControlFlowMode;
    if (mode === 0) stack.push({ id: p.GroupingIdentifier, menu: p.WFMenuItems, cases: [] });
    if (mode === 1) { assert.equal(stack.at(-1).id, p.GroupingIdentifier); stack.at(-1).cases.push(p.WFMenuItemTitle); }
    if (mode === 2) { const group = stack.pop(); assert.equal(group.id, p.GroupingIdentifier); if (group.menu) assert.deepEqual(group.cases, group.menu); }
    const walk = value => {
      if (!value || typeof value !== 'object') return;
      if (value.OutputUUID) assert.ok(uuids.has(value.OutputUUID));
      Object.values(value).forEach(walk);
    };
    walk(p);
  }
  assert.equal(stack.length, 0);
});

test('selection is multi-select with no preselection; final confirmation precedes JSON output', () => {
  const actions = buildShortcut().WFWorkflowActions;
  const chooser = actions.find(x => x.WFWorkflowActionIdentifier.endsWith('.choosefromlist')).WFWorkflowActionParameters;
  assert.equal(chooser.WFChooseFromListActionSelectMultiple, true);
  assert.equal(chooser.WFChooseFromListActionSelectAll, false);
  const finalMenu = actions.findIndex(x => x.WFWorkflowActionParameters.WFMenuItems?.includes('确认记录以上意见'));
  const output = actions.findIndex(x => x.WFWorkflowActionIdentifier.endsWith('.output'));
  const lastMeta = actions.findLastIndex(x => x.WFWorkflowActionParameters.WFURL === META_URL);
  assert.ok(finalMenu > 0 && lastMeta > finalMenu && output > lastMeta);
  assert.equal(actions.filter(x => x.WFWorkflowActionIdentifier.endsWith('.output')).length, 1);
});

test('token text uses correct UTF-16 positions and XML escapes content', () => {
  const token = { Type: 'Variable', VariableName: '变量' };
  const result = tokenText('😀x', token);
  assert.deepEqual(result.Value.attachmentsByRange, { '{3, 1}': token });
  assert.equal(result.Value.string, '😀x\uFFFC');
  assert.match(plistXml({ text: 'a&b<c' }), /a&amp;b&lt;c/);
});

test('native action parameter keys match inspected Apple-derived ToolKit metadata', () => {
  // Inspected source: viticci/shortcuts-playground-plugin, static ToolKit v78
  // first-party parameter keys. Control-flow/list headers are exported plist
  // structures rather than ordinary ToolKit tool rows.
  const parameters = {
    comment: ['WFCommentActionText'], downloadurl: ['WFURL', 'WFHTTPMethod', 'WFHTTPHeaders'],
    setvariable: ['WFInput', 'WFVariableName'], getvalueforkey: ['WFGetDictionaryValueType', 'WFDictionaryKey', 'WFInput'],
    alert: ['WFAlertActionTitle', 'WFAlertActionMessage', 'WFAlertActionCancelButtonShown'], nothing: [], exit: [],
    gettext: ['WFTextActionText'], 'text.match': ['text', 'WFMatchTextPattern', 'WFMatchTextCaseSensitive'],
    count: ['Input', 'WFCountType'], dictionary: ['WFItems'], appendvariable: ['WFVariableName', 'WFInput'],
    hash: ['WFHashType', 'WFInput'], setvalueforkey: ['WFDictionaryKey', 'WFDictionaryValue', 'WFDictionary'],
    choosefromlist: ['WFInput', 'WFChooseFromListActionPrompt', 'WFChooseFromListActionSelectMultiple', 'WFChooseFromListActionSelectAll'],
    ask: ['WFAskActionPrompt', 'WFInputType', 'WFAllowsMultilineText'],
    'text.replace': ['WFReplaceTextFind', 'WFReplaceTextReplace', 'WFReplaceTextCaseSensitive', 'WFReplaceTextRegularExpression', 'WFInput'],
    'text.combine': ['text', 'WFTextSeparator', 'WFTextCustomSeparator'], date: ['WFDateActionMode'],
    'format.date': ['WFDate', 'WFDateFormatStyle', 'WFISO8601IncludeTime'], list: ['WFItems'],
    getitemfromlist: ['WFInput', 'WFItemSpecifier'], output: ['WFOutput'], 'detect.dictionary': ['WFInput'],
    conditional: ['GroupingIdentifier', 'WFControlFlowMode', 'WFCondition', 'WFInput', 'WFNumberValue', 'WFConditionalActionString'],
    'repeat.each': ['GroupingIdentifier', 'WFControlFlowMode', 'WFInput'], 'repeat.count': ['GroupingIdentifier', 'WFControlFlowMode', 'WFRepeatCount'],
    choosefrommenu: ['GroupingIdentifier', 'WFControlFlowMode', 'WFMenuPrompt', 'WFMenuItems', 'WFMenuItemTitle'],
  };
  for (const mode of [{}, { demo: true }]) for (const action of buildShortcut(mode).WFWorkflowActions) {
    const id = action.WFWorkflowActionIdentifier.replace('is.workflow.actions.', '');
    assert.ok(parameters[id], `unknown action ${id}`);
    for (const key of Object.keys(action.WFWorkflowActionParameters)) assert.ok(key === 'UUID' || parameters[id].includes(key), `${id}.${key}`);
  }
});

test('native nonce transform produces UUIDv4 strings with valid variant', () => {
  const actions = buildShortcut().WFWorkflowActions;
  const nonceTransform = actions.findLast(x => x.WFWorkflowActionIdentifier.endsWith('.text.replace')).WFWorkflowActionParameters;
  for (const hex of ['0'.repeat(32), 'f'.repeat(32), '0123456789abcdef0123456789abcdef']) {
    const uuid = hex.replace(new RegExp(nonceTransform.WFReplaceTextFind), nonceTransform.WFReplaceTextReplace);
    assert.match(uuid, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  }
});

test('all exits deliberately produce no output; unavailable state is distinct from no pending', () => {
  const actions = buildShortcut().WFWorkflowActions;
  actions.forEach((action, i) => {
    if (action.WFWorkflowActionIdentifier.endsWith('.exit')) assert.ok(actions[i - 1].WFWorkflowActionIdentifier.endsWith('.nothing'));
  });
  const messages = actions.filter(x => x.WFWorkflowActionIdentifier.endsWith('.alert')).map(x => x.WFWorkflowActionParameters.WFAlertActionMessage.Value.string);
  assert.ok(messages.some(s => s.includes('待办菜单暂不可用')));
  assert.ok(messages.some(s => s.includes('现有意见和回执已保留')));
});

test('string conditions are explicitly typed Text, never polymorphic Dictionary Value', () => {
  const actions = buildShortcut().WFWorkflowActions;
  const byId = new Map(actions.map(action => [action.WFWorkflowActionParameters.UUID, action]));
  for (const action of actions.filter(a => a.WFWorkflowActionIdentifier.endsWith('.conditional'))) {
    const p = action.WFWorkflowActionParameters;
    if (p.WFControlFlowMode !== 0 || p.WFCondition < 4 || [100, 101, 1003].includes(p.WFCondition)) continue;
    const source = byId.get(p.WFInput.Variable.Value.OutputUUID);
    assert.equal(source.WFWorkflowActionIdentifier, 'is.workflow.actions.gettext');
    assert.ok(p.WFConditionalActionString);
  }
});

test('Replace Text uses native-export text-token input; diagnostic isolates old/new forms without writes', () => {
  const replacements = buildShortcut().WFWorkflowActions.filter(x => x.WFWorkflowActionIdentifier.endsWith('.text.replace'));
  assert.ok(replacements.length >= 2);
  for (const action of replacements) assert.equal(action.WFWorkflowActionParameters.WFInput.WFSerializationType, 'WFTextTokenString');
  const debug = buildInputDebugShortcut();
  assert.doesNotMatch(JSON.stringify(debug), /downloadurl|runworkflow|openurl|output|Bearer |sk-ant-/);
  const comparisons = debug.WFWorkflowActions.filter(x => x.WFWorkflowActionIdentifier.endsWith('.text.replace'));
  assert.deepEqual(comparisons.map(x => x.WFWorkflowActionParameters.WFInput.WFSerializationType), ['WFTextTokenAttachment', 'WFTextTokenString']);
  assert.equal(debug.WFWorkflowActions.filter(x => x.WFWorkflowActionIdentifier.endsWith('.showresult')).length, 1);
});

test('positive availability gate precedes pending display, and final confirmation discloses publication', () => {
  const actions = buildShortcut().WFWorkflowActions;
  const available = actions.findIndex(x => x.WFWorkflowActionParameters.WFDictionaryKey === 'available');
  const pending = actions.findIndex(x => x.WFWorkflowActionParameters.WFDictionaryKey === 'pending');
  assert.ok(available > 0 && pending > available);
  assert.ok(actions.some(x => x.WFWorkflowActionParameters.WFTextActionText?.Value.string === '{"available":true}'));
  const final = actions.find(x => x.WFWorkflowActionParameters.WFMenuItems?.includes('确认记录以上意见'));
  assert.match(final.WFWorkflowActionParameters.WFMenuPrompt.Value.string, /公开报告/);
  assert.match(final.WFWorkflowActionParameters.WFMenuPrompt.Value.string, /页面出现回执才表示记录成功/);
  const time = actions.find(x => x.WFWorkflowActionIdentifier.endsWith('.format.date')).WFWorkflowActionParameters;
  assert.equal(time.WFDateFormatStyle, 'ISO 8601');
  assert.equal(time.WFISO8601IncludeTime, true);
});
