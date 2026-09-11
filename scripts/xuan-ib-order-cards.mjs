// Presentation only: copy published cells; never infer prices or cancellation.
export const ORDER_CARDS_CSS = `
.order-groups{min-width:0;max-width:100%;margin:12px 0}
.order-group{margin:18px 0 24px;padding-top:12px;border-top:4px solid #2875b8;min-width:0}
.order-group.sell{border-color:#a45dc8}.order-group.unknown{border-color:#777}
.order-group h3{display:flex;align-items:center;gap:10px;margin:0 0 12px;font-size:18px}
.order-group h3 span{background:#e8f3ff;color:#164e80;border-radius:8px;padding:6px 12px}
.order-group.sell h3 span{background:#f4eaff;color:#71318f}.order-group.unknown h3 span{background:var(--bg);color:var(--fg)}
.order-group h3 small{font-size:14px;color:var(--mut);font-weight:400}
.order-cards{list-style:none!important;padding:0!important;margin:0!important;display:grid;gap:10px}
.order-card{padding:12px!important;border:1px solid var(--line);border-radius:12px;background:var(--bg);min-width:0;max-width:100%;overflow-wrap:anywhere}
.order-group.buy .order-card{border-left:3px solid #2875b8}.order-group.sell .order-card{border-left:3px solid #a45dc8}
.order-card header{display:flex;flex-wrap:wrap;justify-content:space-between;gap:6px;font-size:16px;font-weight:700;line-height:1.4}
.order-direction{font-size:14px;color:#164e80;background:#e8f3ff;padding:2px 6px;border-radius:5px;margin-right:5px}.sell .order-direction{color:#71318f;background:#f4eaff}
.order-card .order-quantity{font-weight:500;font-size:14px}
.order-card dl{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 12px;margin:12px 0 0}
.order-card dl>div{min-width:0}.order-card dt{font-size:14px;color:var(--mut)}
.order-card dd{margin:3px 0 0;font-size:16px;font-weight:650;line-height:1.4;overflow-wrap:anywhere}
.order-card .order-status dd{font-size:14px;font-weight:400}
.order-card .order-source-warning{color:var(--warn,#a16207);font-weight:650}
.order-sort-note{font-size:14px!important;color:var(--mut);line-height:1.5}
@media(min-width:720px){.order-cards{grid-template-columns:repeat(2,minmax(0,1fr))}}
`;

export function orderDisplayFields(identity, limit, distance, ageStatus, sideHint='unknown') {
  const match=identity.trim().match(/^(.*?)\s+(买|卖|BUY|SELL)\s+(.+)$/i);
  const age=ageStatus.trim().match(/^(\d+\s*(?:天|日|days?))\s*(?:[·|/]\s*)?(.*)$/i);
  const signed=distance.trim().match(/^[+\-−]?\d+(?:\.\d+)?\s*%$/);
  return {
    identity:match?match[1]:identity.trim(),quantity:match?match[3]:'',
    side:match?(/买|BUY/i.test(match[2])?'buy':'sell'):sideHint,
    limit:limit.trim(),distance:distance.trim(),age:age?age[1]:'未核实',
    status:age?age[2]:ageStatus.trim().replace(/年龄未核/g,'已挂天数未核实'),
    distanceRank:signed?Math.abs(Number(signed[0].replace('−','-').replace('%',''))):Infinity,
  };
}

export function groupOrderDisplayRows(rows) {
  return ['buy','sell','unknown'].map(side=>({side,rows:rows.filter(row=>row.side===side)
    .map((row,index)=>({row,index})).sort((a,b)=>a.row.distanceRank-b.row.distanceRank||a.index-b.index)
    .map(({row})=>row)})).filter(group=>group.rows.length);
}

function renderGroups(doc, rows) {
  const root=doc.createElement('div');root.className='order-groups';
  for(const {side,rows:items} of groupOrderDisplayRows(rows)) {
    const group=doc.createElement('section');group.className=`order-group ${side}`;
    const heading=doc.createElement('h3'),label=doc.createElement('span'),count=doc.createElement('small');
    label.textContent={buy:'买单',sell:'卖单',unknown:'方向待核'}[side];count.textContent=`${items.length} 张`;
    heading.append(label,count);group.append(heading);
    const list=doc.createElement('ol');list.className='order-cards';group.append(list);
    items.forEach((item,index)=>{
      const card=doc.createElement('li');card.className='order-card';
      const title=doc.createElement('header'),name=doc.createElement('span'),direction=doc.createElement('span');
      direction.className='order-direction';direction.textContent={buy:'买',sell:'卖',unknown:'待核'}[side];
      name.append(direction,doc.createTextNode(`${index+1}. ${item.identity}`));title.append(name);
      if(item.quantity){const qty=doc.createElement('span');qty.className='order-quantity';qty.textContent=`数量 ${item.quantity}`;title.append(qty);}
      card.append(title);const values=doc.createElement('dl');
      for(const [label,value] of [['限价',item.limit],['距市价',item.distance],['已挂天数',item.age],['状态',item.status]]){
        if(label==='状态'&&!value)continue;
        const pair=doc.createElement('div'),key=doc.createElement('dt'),val=doc.createElement('dd');
        if(label==='状态')pair.className='order-status';key.textContent=label;val.textContent=value||'未取得';
        if(label==='状态'&&/待撤|复核/.test(value))val.className='order-source-warning';
        pair.append(key,val);values.append(pair);
      }
      card.append(values);list.append(card);
    });root.append(group);
  }
  const note=doc.createElement('p');note.className='order-sort-note';
  note.textContent='各组按距市价由近到远；距市价不代表成交概率。';root.append(note);
  return root;
}

export function improveOrderCards(doc) {
  if(!doc?.createElement)return;
  for(const table of [...doc.querySelectorAll('.pane.p4 table')]) {
    if(table.closest('.pane-notes,[data-decision-id],.dcard'))continue;
    const heads=[...table.querySelectorAll('thead th')].map(n=>n.textContent.trim());
    if(!/^挂单$/.test(heads[0]||'')||heads[1]!=='限价'||heads[2]!=='距市价'||![3,4].includes(heads.length))continue;
    if(heads.length===4&&!/年龄|已挂|挂单时长/.test(heads[3]))continue;
    const wrap=table.parentElement.matches('.tblwrap')?table.parentElement:table;
    const heading=wrap.previousElementSibling;
    const hint=heading?.tagName==='H3'?(/^买入|^买单/.test(heading.textContent)?'buy':/^卖出|^卖单/.test(heading.textContent)?'sell':'unknown'):'unknown';
    const rows=[...table.querySelectorAll('tbody tr')];
    if(!rows.length||rows.some(row=>row.children.length!==heads.length))continue;
    const items=rows.map(row=>{
      const cells=[...row.children];
      if(heads.length===4)return orderDisplayFields(...cells.map(c=>c.textContent));
      // Structured report tables have the age/status inside the identity cell.
      const copy=cells[0].cloneNode(true),meta=copy.querySelector('.sub'),ageStatus=meta?.textContent||'';meta?.remove();
      const identity=copy.textContent.trim().replace(/^\d+\.\s*/,''),match=identity.match(/^(.*?)\s*×\s*(.+)$/);
      const limit=cells[1].cloneNode(true),currency=limit.querySelector('.sub')?.textContent.trim()||'';
      limit.querySelector('.sub')?.remove();
      const item=orderDisplayFields(match?match[1]:identity,`${limit.textContent.trim()}${currency?' '+currency:''}`,cells[2].textContent,ageStatus,hint);
      if(match)item.quantity=match[2];return item;
    });
    wrap.replaceWith(renderGroups(doc,items));
    if(hint!=='unknown')heading.remove();
  }
}
