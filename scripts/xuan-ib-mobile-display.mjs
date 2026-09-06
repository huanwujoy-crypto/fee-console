// Display only, after paired-report verification. No network, trading or ledger writes.
export const GUIDE_BODY = `<ol><li><b>概览</b>：先看数据日期，再看持仓变化；市值大的排前面。</li><li><b>风险 / 配置</b>：看提醒与现金参考，箭头展开详情。</li><li><b>待办</b>：只处理需要你的事项；挂单仅提醒，不自动撤单。</li><li><b>ETF</b>：A 实际、B 协作方案、C 标普500；看趋势与截止日期。</li><li><b>刷新</b>：读取已发布结果，不生成新报告。上午版周二至周六 08:00；睡前版美股开市时启动。</li></ol><p>颜色是提醒，不是交易指令；所有页面均不自动买卖或转账。</p>`;

export function improveMobileDisplay(doc) {
  if (!doc?.querySelectorAll) return;
  // Reorder existing cells intact; never calculate or change their amounts.
  for (const table of doc.querySelectorAll('.pane.p1 table')) {
    const heads = [...table.querySelectorAll('thead th')];
    const valueIndex = heads.findIndex(h => /^市值\s*\$?$/.test(h.textContent.trim()));
    if (valueIndex < 1 || !/标的/.test(heads[0]?.textContent || '')) continue;
    for (const row of table.querySelectorAll('tr')) {
      const cells = [...row.children];
      if (cells.length !== heads.length) continue;
      row.insertBefore(cells[valueIndex], cells[1]);
    }
    const body = table.querySelector('tbody');
    if (!body) continue;
    const value = row => {
      const raw = row.children[1]?.textContent.trim().replace(/[$,\s]/g, '');
      return raw && /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : -Infinity;
    };
    [...body.children].sort((a,b) => value(b)-value(a)).forEach(row => body.append(row));
    table.classList.add('mobile-holdings');
  }
  // Label-only alias. Do not mutate templates, receipts or attribute values.
  const allocation = doc.querySelector('.pane.p3');
  if (allocation && doc.createTreeWalker) {
    const walk = doc.createTreeWalker(allocation, 4);
    const nodes=[]; for(let n=walk.nextNode();n;n=walk.nextNode()) nodes.push(n);
    for(const n of nodes) if(!n.parentElement?.closest('template,script,style'))
      n.textContent=n.textContent.replace(/常青(?!基金)/g,'常青基金');
  }
  const pane=doc.querySelector('.pane.p4');
  const old=pane&&[...pane.children].find(n=>n.tagName==='DETAILS'&&n.querySelector('summary')?.textContent.includes('换仓触发检查'));
  if(old){
    const reminders=doc.createElement('details');reminders.open=true;
    const heading=doc.createElement('summary');heading.textContent='⑥ 挂单提醒';reminders.append(heading);
    const body=doc.createElement('div');body.className='dbody';
    const note=doc.createElement('p');note.textContent='仅供查看已有挂单；是否处理由你决定，不作换仓触发判定。';body.append(note);
    for(const table of old.querySelectorAll('table')) {
      const copy=table.cloneNode(true),rows=[...copy.querySelectorAll('tbody tr')];
      const side=r=>/买/.test(r.children[0]?.textContent||'')?0:/卖/.test(r.children[0]?.textContent||'')?1:2;
      const distance=r=>{const m=r.children[2]?.textContent.match(/[+-]?\d+(?:\.\d+)?/);return m?Math.abs(Number(m[0])):Infinity;};
      rows.sort((a,b)=>side(a)-side(b)||distance(a)-distance(b)).forEach(r=>copy.querySelector('tbody').append(r));
      const wrap=doc.createElement('div');wrap.className='tblwrap';wrap.append(copy);body.append(wrap);
    }
    reminders.append(body);old.replaceWith(reminders);
  }
  if(!doc.getElementById('xuan-mobile-display-style')){
    const style=doc.createElement('style');style.id='xuan-mobile-display-style';
    style.textContent='.mobile-holdings{min-width:640px!important;table-layout:fixed}.mobile-holdings th:first-child,.mobile-holdings td:first-child{width:100px}.mobile-holdings th:nth-child(2),.mobile-holdings td:nth-child(2){width:110px;white-space:nowrap;font-weight:650}.mobile-holdings td{overflow-wrap:normal}';
    doc.head.append(style);
  }
}
