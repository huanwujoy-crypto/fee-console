// User-facing reading only. Never changes source reports, receipts or money.
const prepared = new WeakSet();
const views = new WeakMap();
const make=(doc,tag,text,cls)=>{const n=doc.createElement(tag);n.textContent=text;if(cls)n.className=cls;return n;};
const NOTE_RECORDS='template,script,style,[data-decision-id],.dcard,.xuan-work,.xuan-progress-fold,#xuan-aaoi-applied';
const MATERIAL_NOTE=/读取失败|来源缺失|数据降级|字段级回退|替代源|已过期|账户[^。；\n]*不匹配|数据[^。；\n]*冲突|计算失败|无法计算/;
const PUBLICATION_BOILERPLATE='发布仍须通过 Validate → Promote → Pages，并核对公开版本；生成候选不等于已发布。';

function sourceNoteText(node){
  if(node.matches(NOTE_RECORDS))return '';
  const copy=node.cloneNode(true);
  for(const child of copy.querySelectorAll(NOTE_RECORDS))child.remove();
  return copy.textContent;
}

function materialNoteContexts(roots) {
  const contexts=[];
  for(const root of roots){
    const candidates=[...(root.matches('p,li')?[root]:[]),...root.querySelectorAll('p,li')];
    for(const node of candidates){
      if(node.closest(NOTE_RECORDS)||!MATERIAL_NOTE.test(sourceNoteText(node)))continue;
      // Keep the whole contextual section, including parent list qualifiers,
      // neighbouring source dates and denominator/currency labels. A flat list
      // of matching sentences can reverse the meaning of a qualified failure.
      const section=node.closest('.notes-section,.allocation-account-source,.allocation-original');
      // Without an explicit section boundary a preceding sibling can qualify
      // (or negate) the entire list. Preserve the complete fold body in order,
      // not just the root that happened to contain the matching sentence.
      if(!section||!root.contains(section))return roots.filter(item=>!item.matches(NOTE_RECORDS));
      const context=section;
      if(contexts.some(prior=>prior.contains(context)))continue;
      for(let i=contexts.length-1;i>=0;i--)if(context.contains(contexts[i]))contexts.splice(i,1);
      contexts.push(context);
    }
  }
  return contexts;
}

export function reportNoteLines(pane,text,{aaoiApplied=false}={}) {
  const lines={
    1:['价格、市值按页面日期与来源；账户可能有同步时差。'],
    2:['压力情景不是收益预测；提醒不等于交易指令。'],
    3:['补仓金额仅供现金规划；下单前核对可用余额。'],
    4:['只处理明确要求你的事项；挂单仅提醒，不自动操作。'],
    5:['A 实际／B 协作／C 标普500；同额出入金后比较。'],
  }[pane]||[];
  if(pane===1&&/未查询|未取得|未调用逐票行情/.test(text))lines.push('本报告未取得日涨跌；不以零或未实现盈亏代替。');
  if(pane===2){
    if(/近似|未逐票重算|非完整逐票/.test(text))lines.push('低／高情景仍为近似，不用于精确判断是否越过警戒线。');
    const scope=[];
    if(aaoiApplied)scope.push('AAOI 已按 T1 计入原快照，未重新取数');
    else if(/不含 AAOI|尚未计入 AAOI/.test(text))scope.push('AAOI 尚未计入，由 Codex 接入');
    if(/名义敞口待核验/.test(text))scope.push('杠杆名义敞口未核验，不判断越线');
    if(scope.length)lines.push(`范围：${scope.join('；')}。`);
  }
  if(pane===3){
    if(/USSC/.test(text)&&/10%/.test(text))lines.push('USSC 的 10% 是本次现金预算占比；美国底仓 45% 为参考目标，不是强制上限。');
    if(/补后比例|卖出回款|跨平台/.test(text))lines.push('补后比例含新增买入；不假设卖出或跨平台款项已到账。');
  }
  return lines;
}

export function simplifyReportNotes(doc) {
  if(!doc?.createElement||prepared.has(doc))return;
  // Cancel only the exact obsolete observation entry; leave current decisions
  // and order reminders untouched. The original signed source remains intact.
  for(const fold of [...doc.querySelectorAll('.pane.p4 details')]){
    const title=fold.querySelector(':scope > summary')?.textContent.replace(/\s+/g,' ').trim()||'';
    if(/^已结案\s*\/\s*只读观察(?:\s|$)/.test(title))fold.remove();
  }
  const aaoiApplied=!!doc.getElementById('xuan-aaoi-applied');
  for(let pane=1;pane<=5;pane++){
    const fold=doc.getElementById(`xuan-pane-notes-p${pane}`) || (pane===5 ? [...doc.querySelectorAll('.pane.p5 details')].find(d=>/^报告说明/.test(d.querySelector(':scope > summary')?.textContent||'')) : null);
    if(!fold)continue;
    if(fold.querySelector(':scope > .concise-report-notes'))continue;
    const roots=[...fold.children].filter(child=>child.tagName!=='SUMMARY');
    const text=roots.map(sourceNoteText).join('\n');
    const body=make(doc,'div','','dbody concise-report-notes');
    const lines=reportNoteLines(pane,text,{aaoiApplied});
    const list=doc.createElement('ul');for(const line of lines)list.append(make(doc,'li',line));
    body.append(list);
    const contexts=materialNoteContexts(roots);
    // Cash-allocation qualifiers explain interpretation; they are not data
    // failures. Only actual retained exceptions or pane 1/2 limitations earn
    // the visible warning label.
    const hasVisibleLimits=contexts.length>0||((pane===1||pane===2)&&lines.length>1);
    if(hasVisibleLimits)fold.querySelector(':scope > summary')?.append(make(doc,'span',' · 含数据限制','routine-note-limit-label'));
    if(contexts.length){
      const alert=make(doc,'section','','routine-material-exceptions mobile-metric-caveat');
      alert.append(make(doc,'h3','数据提醒 · 保留来源口径'));
      for(const context of contexts){
        const copy=context.cloneNode(true);
        for(const node of copy.querySelectorAll(NOTE_RECORDS))node.remove();
        copy.removeAttribute('id');
        for(const node of copy.querySelectorAll('[id]'))node.removeAttribute('id');
        // Source details must not hide the exception behind a second disclosure.
        if(copy.tagName==='DETAILS')copy.open=true;
        for(const node of copy.querySelectorAll('details'))node.open=true;
        alert.append(copy);
      }
      fold.before(alert);
    }
    // Keep original verified source nodes for diagnostics without displaying
    // them as a second disclosure layer. The signed/cached report bytes are
    // unchanged; only the mobile reading DOM is simplified.
    const records=make(doc,'div','','routine-source-records');
    records.setAttribute('hidden','');records.setAttribute('aria-hidden','true');
    for(const root of roots){
      if(root.matches('p,li')&&!root.children.length&&root.textContent===PUBLICATION_BOILERPLATE){root.remove();continue;}
      for(const node of root.querySelectorAll('p,li')){
        if(!node.closest(NOTE_RECORDS)&&!node.children.length&&node.textContent===PUBLICATION_BOILERPLATE)node.remove();
      }
      const rootIsDisclosure=root.matches('#xuan-ib-account-association-disclosure-v1');
      const disclosures=[...(rootIsDisclosure?[root]:[]),...root.querySelectorAll('#xuan-ib-account-association-disclosure-v1')];
      for(const disclosure of disclosures)body.append(disclosure);
      if(!rootIsDisclosure&&!root.textContent.trim()&&!root.children.length&&root.matches('div,p,section,ul,ol')){root.remove();continue;}
      if(!rootIsDisclosure)records.append(root);
    }
    fold.append(body);
    if(records.children.length)fold.before(records);
  }
  prepared.add(doc);
}

export function organizeRoutineRecords(doc,{fold,title,attention,nav,navAttention,events=[],dataAvailable=false,record}={}) {
  if(!doc?.createElement||!fold||!doc.querySelector('.pane.p4'))return;
  const notes=doc.getElementById('xuan-pane-notes-p4');
  if(!notes)return;
  const body=notes.querySelector('.dbody')||notes;
  // Hide bulky implementation history from this reading surface, not from the
  // append-only ledger or signed source. Never relabel it as completed.
  fold.hidden=true;fold.setAttribute('aria-hidden','true');
  fold.style.display='none';
  if(!notes.contains(fold))body.append(fold);
  let view=views.get(doc);
  if(!view){
    const actions=make(doc,'section','','routine-owner-actions');
    const status=make(doc,'p','','routine-record-status');
    doc.querySelector('.pane.p4').insertBefore(actions,notes);body.prepend(status);
    view={actions,status,lastRequests:[]};views.set(doc,view);
  }
  // An unresolved explicit owner request does not expire just because market
  // data got a new fingerprint. Only a newer receipt-bound event resolves it.
  const needs=dataAvailable?events.filter(e=>['awaiting_approval','user_action_required'].includes(e.status)):view.lastRequests;
  if(dataAvailable)view.lastRequests=needs;
  view.actions.replaceChildren();view.actions.hidden=!needs.length;
  for(const e of needs){
    const item=make(doc,'div','','xuan-work');item.append(make(doc,'h3',e.title),make(doc,'p',e.nextAction));
    if(!dataAvailable)item.append(make(doc,'p','更新暂不可用，保留上次尚未解决的请求。'));
    else if(e.observedPair?.sourceSha!==record?.meta?.sourceSha||e.observedPair?.htmlBlob!==record?.blob)item.append(make(doc,'p','此请求来自较早记录，尚未记录处理结果；不是本期数值核验。'));
    view.actions.append(item);
  }
  if(navAttention){navAttention.hidden=!needs.length;navAttention.title=needs.length?`待你处理 ${needs.length} 项`:'';}
  if(nav&&needs.length){
    const initial=(record?.decisionState?.decisions||[]).filter(d=>d.status==='awaiting_user').length;
    nav.setAttribute('aria-label',`待办；待决定 ${initial} 项；后续待你处理 ${needs.length} 项`);
  }
  const aaoiApplied=!!doc.getElementById('xuan-aaoi-applied');
  view.status.textContent=!dataAvailable?'处理记录暂不可用；Codex 负责核对，原报告保留。':
    aaoiApplied?'日常规则由 Codex 负责：AAOI 已纳入 T1；已确定规则继续沿用，不重复审批。':
    '日常规则由 Codex 负责；旧核验记录不代表本期重新取数，也不作为你的待办。';
  if(title)title.textContent='历史处理记录';
  // The existing nav badge still reflects only the trusted current user action
  // count. Real unaccepted decisions remain in their separate original group.
}
