// Verified display only. Preserve original rows in notes; never recalculate.
export const ALLOCATION_CARDS_CSS = `
#xuan-four-bucket-retired-history{display:none!important}
.allocation-plan-card{margin:12px 0;padding:12px;border:1px solid var(--line);border-left:3px solid #2875b8;border-radius:12px;background:var(--bg);min-width:0}
.allocation-plan-card header{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:6px 12px;font-size:16px;font-weight:700}
.allocation-plan-card header .allocation-amount{font-size:20px;white-space:nowrap}
.allocation-plan-card .allocation-category{font-size:14px;color:var(--mut);margin-top:4px;line-height:1.5}
.allocation-ratios{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px;margin:12px 0 0}
.allocation-ratios div{min-width:0}.allocation-ratios dt{font-size:14px;color:var(--mut)}
.allocation-ratios dd{font-size:16px;font-weight:650;margin:4px 0 0;overflow-wrap:anywhere}
.allocation-budget{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin:14px 0}
.allocation-budget dt{font-size:14px;color:var(--mut)}.allocation-budget dd{margin:4px 0 0;font-weight:650;font-size:16px;overflow-wrap:anywhere}
.allocation-planning-label{font-size:14px!important;color:var(--mut);line-height:1.5;margin:8px 0}
.allocation-account-list{padding:0;margin:10px 0;display:grid;gap:8px}
.allocation-account-list>div{display:flex;align-items:baseline;justify-content:space-between;flex-wrap:wrap;gap:6px 12px;padding:12px;border:1px solid var(--line);border-radius:10px;background:var(--bg);min-width:0}
.allocation-account-list dt{font-size:15px;overflow-wrap:anywhere}.allocation-account-list dd{margin:0;font-size:17px;font-weight:650;font-variant-numeric:tabular-nums;overflow-wrap:anywhere;max-width:100%}
.allocation-category-list{display:none}
.allocation-original .kv{display:block!important;font-size:14px}.allocation-original .kv .k,.allocation-original .kv .v{display:block!important;text-align:left!important;font-weight:400!important;font-size:14px!important;white-space:normal!important;width:auto!important}
.allocation-original .kv .k{font-weight:650!important;margin-bottom:4px}
#xuan-ib-cash-plan-detail>h2{font-size:18px}#xuan-ib-cash-plan-detail>h2 small{display:block;margin-top:5px;font-size:14px;font-weight:400}
@media screen and (max-width:640px){
  .allocation-category-source{display:none!important}
  .allocation-category-list{display:grid;gap:7px;margin:10px 0}
  .allocation-category-list>div{display:grid;grid-template-columns:minmax(6em,1fr) minmax(5em,.72fr) minmax(4.5em,.62fr);gap:6px;align-items:center;padding:10px;border:1px solid var(--line);border-radius:10px;background:var(--bg);min-width:0}
  .allocation-category-list dt{font-size:14px;font-weight:700;min-width:0}
  .allocation-category-list dd{margin:0;text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
  .allocation-category-list strong{display:block;font-size:16px}
  .allocation-category-list small{display:block;font-size:11px;color:var(--mut);margin-top:2px}
  .allocation-category-target strong{color:#2875b8}
}
@media print{.allocation-category-list{display:none!important}.allocation-category-source{display:block!important}}
`;

export function compactAllocationCategory(values) {
  if(!Array.isArray(values)||values.length!==4)return null;
  const [rawName,marketValue,current,target]=values.map(value=>String(value??'').trim());
  const name=rawName.replace(/[（(][^()（）]*[）)]\s*$/,'').trim();
  if(!name||!/^\$?[\d,]+(?:\.\d+)?$/.test(marketValue)||!/^\d+(?:\.\d+)?%$/.test(current)||!/^\d+(?:\.\d+)?%$/.test(target))return null;
  return {name,marketValue,current,target};
}

export function allocationMetrics(text) {
  const current=text.match(/(?:当前\s*|占股票总额[：:]\s*|^)(\d+(?:\.\d+)?%)\s*→/);
  const after=text.match(/→\s*补后约\s*(\d+(?:\.\d+)?%)/);
  const target=text.match(/目标\s*(\d+(?:\.\d+)?%)/)||text.match(/(\d+(?:\.\d+)?%)\s*为参考目标/);
  const budget=text.match(/本次现金预算\s*(\d+(?:\.\d+)?%)/);
  return [current&&['当前',current[1]],after&&['补后约',after[1]],target&&['参考目标',target[1]],budget&&['预算占比',budget[1]]].filter(Boolean);
}

export function improveAllocationCards(doc) {
  if(!doc?.createElement)return;
  const pane=doc.querySelector('.pane.p3'),notes=doc.querySelector('#xuan-pane-notes-p3 > .dbody');
  if(!pane||!notes||pane.dataset.allocationCards==='1')return;
  const el=(tag,cls,text)=>{const n=doc.createElement(tag);if(cls)n.className=cls;if(text)n.textContent=text;return n;};
  const original=el('section','allocation-original');original.append(el('h3',null,'补仓口径与执行前核对'));
  const preserve=node=>original.append(node);
  const detail=doc.getElementById('xuan-ib-cash-plan-detail');
  for(const row of [...(detail?.querySelectorAll(':scope > .kv')||[])]){
    const key=row.querySelector('.k')?.textContent.trim()||'',value=row.querySelector('.v');
    if(!value)continue;
    // This is execution-readiness, not a request for a new owner decision.
    // Keep it in notes only while it is explicitly unverified. Other warnings
    // and genuinely unavailable planning amounts remain visible.
    if(/^券商可立即用于本次补仓$/.test(key)&&/待核实/.test(value.textContent)){
      preserve(row);continue;
    }
    const name=key.match(/^([①②③]\s*(?:EXUS|EIMI|USSC))[｜|](.*)$/);
    const base=/^美国底仓合计（含 USSC）$/.test(key);
    const amount=value.querySelector('b')?.textContent.trim()||'';
    const metrics=allocationMetrics(value.textContent.trim());
    if((name&&/^\$[\d,]+(?:\.\d+)?$/.test(amount)||base)&&metrics.length>=2){
      const card=el('section','allocation-plan-card'),head=el('header');
      head.append(el('span',null,name?name[1]:key));
      if(name)head.append(el('span','allocation-amount',amount));card.append(head);
      if(name)card.append(el('div','allocation-category',name[2]));
      const scope=value.textContent.match(/(?:EXUS＋VCN|EIMI＋INDA) 类别合计/);
      if(scope)card.append(el('div','allocation-category',scope[0]));
      const ratios=el('dl','allocation-ratios');
      for(const [label,number] of metrics){const pair=el('div');pair.append(el('dt',null,label),el('dd',null,number));ratios.append(pair);}card.append(ratios);
      if(base&&/非强制上限/.test(value.textContent))card.append(el('div','allocation-category','参考目标，非强制上限'));
      row.replaceWith(card);preserve(row);continue;
    }
    const budget=value.textContent.trim().match(/^(\$[\d,]+(?:\.\d+)?)\s*\/\s*(\$[\d,]+(?:\.\d+)?)$/);
    if(key==='现金规划上限 / 本次参考分配'&&budget){
      const grid=el('dl','allocation-budget');
      for(const [label,number] of [['规划上限',budget[1]],['本次分配',budget[2]]]){const pair=el('div');pair.append(el('dt',null,label),el('dd',null,number));grid.append(pair);}
      row.replaceWith(grid);preserve(row);
    }
  }
  if(original.children.length>1){
    original.insertBefore(el('p',null,'本页金额是配置规划，不是券商即时购买力。只查看无需操作；实际下单前，仍需核对可用余额、挂单占款及调拨到账情况。'),original.children[1]);notes.append(original);
    if(detail)detail.append(el('p','allocation-planning-label','仅作规划 · 非即时购买力'));
  }
  for(const table of [...pane.querySelectorAll('table')]){
    if(table.closest('.pane-notes,[data-decision-id]'))continue;
    const heads=[...table.querySelectorAll('thead th')].map(n=>n.textContent.trim());
    if(JSON.stringify(heads)===JSON.stringify(['类别','市值 $','本轮占比','参考目标'])){
      const rows=[...table.querySelectorAll('tbody tr')],parsed=rows.map(row=>compactAllocationCategory([...row.children].map(cell=>cell.textContent)));
      if(rows.length&&parsed.every(Boolean)){
        const list=el('dl','allocation-category-list');
        for(const item of parsed){
          const pair=el('div'),name=el('dt',null,item.name),current=el('dd','allocation-category-current'),target=el('dd','allocation-category-target');
          current.append(el('strong',null,item.current),el('small',null,item.marketValue));
          target.append(el('strong',null,item.target),el('small',null,'参考目标'));
          pair.append(name,current,target);list.append(pair);
        }
        const source=table.parentElement.matches('.tblwrap')?table.parentElement:table;
        source.classList.add('allocation-category-source');source.before(list);
      }
      continue;
    }
    if(heads.length!==3||heads[0]!=='组合'||!/^本次读取值\s*\$$/.test(heads[1])||heads[2]!=='备注')continue;
    const rows=[...table.querySelectorAll('tbody tr')];if(!rows.length||rows.some(row=>row.children.length!==3))continue;
    const card=table.closest('section.card'),heading=card?.querySelector(':scope > h2');
    const source=el('section','allocation-account-source');source.append(el('h3',null,heading?.textContent||'组合来源与差异'));
    const list=el('dl','allocation-account-list');
    for(const row of rows){const pair=el('div');pair.append(el('dt',null,row.children[0].textContent.trim()),el('dd',null,row.children[1].textContent.trim()));list.append(pair);
      const note=el('p');note.append(el('b',null,row.children[0].textContent.trim()+'：'),doc.createTextNode(row.children[2].textContent.trim()));source.append(note);}
    const wrap=table.parentElement.matches('.tblwrap')?table.parentElement:table;wrap.replaceWith(list);
    // Preserve the exact original table in a secondary notes fold for audit.
    const raw=el('details');raw.append(el('summary',null,'原始组合明细'),wrap);source.append(raw);notes.append(source);
    if(heading)heading.textContent='组合资产（USD）';
  }
  const archive=doc.getElementById('xuan-four-bucket-retired-history');
  if(archive){archive.hidden=true;archive.setAttribute('aria-hidden','true');}
  pane.dataset.allocationCards='1';
}
