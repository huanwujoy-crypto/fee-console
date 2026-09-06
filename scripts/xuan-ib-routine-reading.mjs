// User-facing reading only. Never changes source reports, receipts or money.
const prepared = new WeakSet();
const views = new WeakMap();
const make=(doc,tag,text,cls)=>{const n=doc.createElement(tag);n.textContent=text;if(cls)n.className=cls;return n;};

export function reportNoteLines(pane,text,{aaoiApplied=false}={}) {
  const lines={
    1:['价格和市值以报告注明的来源、日期为准；各账户可能有同步时差。'],
    2:['AI 系数表示压力情景损失比例，不是收益预测；提醒不等于交易指令。'],
    3:['补仓金额是现金规划，不是券商即时购买力；下单前核对余额、挂单占款和资金到账。'],
    4:['只处理需要你的事项；分类、计算及技术问题由 Codex 负责。','挂单仅供提醒，本页面不自动买卖、撤单或转账。'],
    5:['A＝实际投资，B＝协作方案，C＝标普500被动方案；以页面截止日期为准。','同额出入金匹配后比较走势；估算结果不等于实际成交收益。'],
  }[pane]||[];
  if(pane===1&&/未查询|未取得|未调用逐票行情/.test(text))lines.push('本报告未取得日涨跌；不以零或未实现盈亏代替。');
  if(pane===2){
    if(/近似|未逐票重算|非完整逐票/.test(text))lines.push('低／高情景仍为近似，不用于精确判断是否越过警戒线。');
    if(aaoiApplied)lines.push('AAOI 已按 T1 计入原快照：低／中／高 60%／80%／100%；未重新取数。');
    else if(/不含 AAOI|尚未计入 AAOI/.test(text))lines.push('AAOI 尚未计入该报告；由 Codex 完成计算接入，无需你重复确认分类。');
    if(/名义敞口待核验/.test(text))lines.push('杠杆产品的市值不等于名义敞口；名义敞口未核验时不判断是否越线。');
  }
  if(pane===3){
    if(/USSC/.test(text)&&/10%/.test(text))lines.push('USSC 的 10% 是本次现金预算占比；美国底仓 45% 为参考目标，不是强制上限。');
    lines.push('补后比例包含新增买入金额；不假设卖出回款或跨平台款项已经到账。');
  }
  return lines;
}

export function simplifyReportNotes(doc) {
  if(!doc?.createElement||prepared.has(doc))return;
  prepared.add(doc);
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
    const text=fold.textContent;
    const body=make(doc,'div','','dbody concise-report-notes');
    const lines=reportNoteLines(pane,text,{aaoiApplied});
    const list=doc.createElement('ul');for(const line of lines)list.append(make(doc,'li',line));
    body.append(list);
    // These are current material exceptions, not stale decision history. Keep
    // their full sentences rather than silently shortening away qualifiers.
    const exceptions=[...fold.querySelectorAll('p')].filter(n=>!n.closest('.dcard,.xuan-work,.xuan-progress-fold,.allocation-original'))
      .map(n=>n.textContent.trim()).filter(t=>/读取失败|来源缺失|账户.*不匹配|数据.*冲突|计算失败|无法计算|待核实|待核验|未知|尚无批准|数据降级|已过期/.test(t));
    if(exceptions.length){
      const extra=doc.createElement('details');extra.className='routine-data-limits';
      const unique=[...new Set(exceptions)];extra.append(make(doc,'summary',`数据限制 · ${unique.length} 项`));
      for(const text of unique)extra.append(make(doc,'p',text));
      body.append(extra);
      for(const text of unique.filter(t=>/读取失败|来源缺失|账户.*不匹配|数据.*冲突|计算失败|无法计算/.test(t)))body.append(make(doc,'p',text,'mobile-metric-caveat'));
    }
    for(const child of [...fold.children])if(child.tagName!=='SUMMARY')child.remove();
    fold.append(body);
    if(pane===2&&aaoiApplied){
      const proof=doc.getElementById('xuan-aaoi-applied');
      // Keep the source-bound calculation record available, but out of the
      // risk dashboard and collapsed underneath its concise explanation.
      if(proof){proof.open=false;body.append(proof);}
    }
  }
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
