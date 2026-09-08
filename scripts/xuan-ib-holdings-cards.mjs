// Verified DOM presentation only. No source reads, classification, sorting or arithmetic.
// Keep each source table intact for desktop/print, and each existing change group in place.
export const HOLDINGS_CARDS_CSS = `
.holdings-mobile-cards,.holdings-source-context{display:none}
.holdings-responsive{min-width:0;max-width:100%}
@media screen and (max-width:640px){
  .holdings-responsive>table{display:none!important}
  .holdings-mobile-cards{display:grid;list-style:none!important;margin:0!important;padding:0!important;gap:10px;min-width:0;max-width:100%}
  .holdings-mobile-card{border:1px solid var(--line);border-radius:12px;padding:12px;background:var(--bg);min-width:0;max-width:100%;line-height:1.5}
  .holdings-mobile-card .holdings-main{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.25fr);gap:8px 12px;align-items:start}
  .holdings-mobile-card .holdings-identity{font-size:16px;font-weight:700;min-width:0}
  .holdings-mobile-card .holdings-identity .sub{font-size:12px;font-weight:400}
  .holdings-mobile-card dl{margin:0;min-width:0}
  .holdings-mobile-card dt{font-size:12px;color:var(--mut);font-weight:400}
  .holdings-mobile-card dd{margin:2px 0 8px;font-size:16px;font-weight:650;font-variant-numeric:tabular-nums}
  .holdings-mobile-card .holdings-primary-values{text-align:right}
  .holdings-mobile-card .holdings-time{margin-top:4px;font-size:12px}
  .holdings-mobile-card .holdings-time dd{font-size:12px;font-weight:400}
  .holdings-mobile-card .holdings-quote{margin-top:8px;font-size:13px}
  .holdings-mobile-card .holdings-quote>summary{font-size:13px;min-height:44px;padding:10px}
  .holdings-mobile-card .holdings-quote>dl{padding:0 10px 6px}
  .holdings-mobile-card .holdings-quote dd{font-size:14px}
  .holdings-mobile-card :is(.holdings-identity,dd,.sub,.holdings-flags){white-space:normal!important;overflow-wrap:anywhere!important;word-break:normal!important;min-width:0;max-width:100%}
  .holdings-mobile-card .holdings-flags{font-size:12px;font-weight:650;color:var(--warn,#a16207);margin:6px 0}
  .holdings-mobile-card.holdings-total{border-top:3px solid var(--ink);background:var(--card)}
  .holdings-source-context{display:block;font-size:12px;line-height:1.5;margin:8px 0;min-width:0;overflow-wrap:anywhere}
  .holdings-source-context p,.holdings-source-context li{font-size:12px!important;line-height:1.5;margin:4px 0}
  .holdings-source-context .holdings-context-detail>summary{font-size:12px;min-height:44px;padding:10px}
}
@media print{.holdings-mobile-cards,.holdings-source-context{display:none!important}.holdings-responsive>table{display:table!important}}
`;

const enhanced = new WeakMap(), contexts = new WeakMap();
const normalize = text => String(text ?? '').trim().replace(/\s+/g, ' ');
const CAUTION = /未取得|待核|沿用|延迟|旧值|估算|估计|近似|替代|覆盖|fallback|stale|override|unavailable|delayed|unverified|missing|estimated/i;
const CONTEXT = /\d{4}-\d{2}-\d{2}|\d{1,2}:\d{2}|HKT|权威|合计|总计|\d+\s*只|直读|来源|数据时点/;
const TOTAL = /^(?:合计|总计|小计|总市值|持仓合计|total|subtotal)(?:\s|$|[：:（(])/i;

// Explicit known contracts only. Header guessing could mislabel a price as a change.
export function holdingsHeaderContract(headers) {
  const keys = headers.map(normalize);
  const full = [
    ['标的','市值 $','日涨跌','估值价','行情时点'],
    ['标的','市值 $','估值价','日涨跌','行情时点'],
    ['标的','估值价','日涨跌','行情时点','市值 $'],
  ];
  const legacy = ['收盘报价（ib 直读）','收盘报价（ib直读）','收盘报价 (ib 直读)',
    '收盘报价（IB 直读）','收盘报价（IB直读）','收盘报价 (IB 直读)'];
  if (full.some(shape => JSON.stringify(shape) === JSON.stringify(keys))) {
    return { identity:0, value:keys.indexOf('市值 $'), change:keys.indexOf('日涨跌'),
      quote:keys.indexOf('估值价'), time:keys.indexOf('行情时点'), headers:keys };
  }
  if (keys.length === 3 && keys[0] === '标的' && legacy.includes(keys[1]) && keys[2] === '市值 $') {
    return {identity:0,value:2,change:null,quote:1,time:null,headers:keys};
  }
  if (keys.length === 3 && keys[0] === '标的' && keys[1] === '市值 $' && legacy.includes(keys[2])) {
    return {identity:0,value:1,change:null,quote:2,time:null,headers:keys};
  }
  return null;
}

const el = (doc, tag, className='', text=null) => {
  const node=doc.createElement(tag);if(className)node.className=className;
  if(text!==null)node.textContent=text;return node;
};
function copyContents(cell, target, missing='未取得') {
  if (!cell || !normalize(cell.textContent)) { target.textContent=missing; return; }
  // Source has passed the report guard. Keep its exact text, inline labels and sign.
  for (const child of [...cell.childNodes]) target.append(child.cloneNode(true));
  for (const node of target.querySelectorAll('[id]')) node.removeAttribute('id');
  for (const cls of ['up','dn','gv','wv','or']) if(cell.classList.contains(cls))target.classList.add(cls);
}
function field(doc, label, cell, className='', missing='未取得') {
  const box=el(doc,'div',className),key=el(doc,'dt','',label),value=el(doc,'dd');
  copyContents(cell,value,missing);box.append(key,value);return box;
}
function sourceContext(doc, table) {
  const scope=table.closest('section.card') || table.closest('details');
  if(!scope || contexts.get(scope)?.parentElement===scope)return;
  const candidates=[...scope.querySelectorAll(':scope > p,:scope > .dbody > p,:scope > ol.brief-lines,:scope > .dbody > ol.brief-lines')];
  const context=el(doc,'aside','holdings-source-context');
  const appendWhole=whole=>{
    for(const node of whole.querySelectorAll('[id]'))node.removeAttribute('id');
    if([...normalize(whole.textContent)].length>180){
      const fold=el(doc,'details','holdings-context-detail');
      fold.append(el(doc,'summary','','来源限定条件（完整原说明）'),whole);context.append(fold);
    }else context.append(whole);
  };
  // Only the generator's standalone data/time and authoritative-total labels
  // may be separated from surrounding prose. All other direct paragraphs form
  // one original context unit, so a preceding denial/condition is not lost.
  const standalone=text=>/^(?:数据时点[：:]\s*)?\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?:–\d{2}:\d{2})? HKT(?: · \d+ 只)?$/.test(text)
    || /^权威市值 (?:\$[\d,.]+|未取得) · (?:直读|替代源|未取得)$/.test(text);
  const prose=el(doc,'div','holdings-context-note');
  for(const source of candidates){
    if(standalone(normalize(source.textContent))){const line=el(doc,'div');copyContents(source,line);context.append(line);}
    else prose.append(source.cloneNode(true));
  }
  if(CONTEXT.test(prose.textContent)||CAUTION.test(prose.textContent))appendWhole(prose);
  // Never extract a keyword-matching child without its parent introduction: a
  // list headed "以下情况均未发生" must not become a positive failure claim.
  // Copy the complete known note unit instead, leaving ordinary method notes
  // in their original fold. Long qualifications stay accessible as one neutral
  // whole-context disclosure, not a new inferred warning or a wall of prose.
  for(const detail of scope.querySelectorAll('details')){
    if(normalize(detail.querySelector('summary')?.textContent)!=='持仓说明')continue;
    const body=detail.querySelector(':scope > .dbody') || detail;
    const whole=el(doc,'div','holdings-context-note');
    for(const node of [...body.childNodes]){
      if(node.nodeType===1&&node.tagName==='SUMMARY')continue;
      whole.append(node.cloneNode(true));
    }
    if(!CAUTION.test(whole.textContent))continue;
    appendWhole(whole);
  }
  if(!context.children.length)return;
  const heading=scope.querySelector(':scope > h2,:scope > summary');
  if(heading)heading.after(context);else scope.prepend(context);
  contexts.set(scope,context);
}

export function improveHoldingsCards(doc) {
  // Existing minimal-DOM tests and unsupported documents remain unchanged.
  if(!doc?.createElement || !doc.querySelectorAll)return;
  for(const table of [...doc.querySelectorAll('.pane.p1 table')]){
    if(!table.closest || !table.cloneNode || !table.parentElement
      || table.closest('.pane-notes,[data-decision-id],.dcard,.holdings-responsive'))continue;
    if(enhanced.get(table)?.parentElement)continue;
    const heads=[...table.querySelectorAll('thead th')],contract=holdingsHeaderContract(heads.map(n=>n.textContent));
    if(!contract || table.querySelectorAll('thead tr').length!==1 || table.querySelectorAll('tbody').length!==1
      || table.querySelector('tfoot,caption,table,[colspan],[rowspan]'))continue;
    const rows=[...table.querySelectorAll('tbody tr')];
    if(!rows.length || rows.some(row=>row.parentElement.tagName!=='TBODY' || row.children.length!==heads.length
      || [...row.children].some(cell=>cell.tagName!=='TD') || !normalize(row.children[0].textContent)))continue;
    const list=el(doc,'ol','holdings-mobile-cards');
    for(const row of rows){
      const cells=[...row.children],identity=cells[contract.identity];
      const isTotal=TOTAL.test(normalize(identity.textContent));
      const card=el(doc,'li','holdings-mobile-card'+(isTotal?' holdings-total':''));
      const main=el(doc,'div','holdings-main'),name=el(doc,'div','holdings-identity');copyContents(identity,name);
      const values=el(doc,'dl','holdings-primary-values');
      values.append(field(doc,contract.headers[contract.value],cells[contract.value]));
      values.append(field(doc,'日涨跌',contract.change===null?null:cells[contract.change],'',isTotal?'不适用':contract.change===null?'未取得（原表未提供）':'未取得'));
      main.append(name,values);card.append(main);
      const time=el(doc,'dl','holdings-time');
      time.append(field(doc,'行情时点',contract.time===null?null:cells[contract.time],'',isTotal?'不适用':contract.time===null?'原表未提供':'未取得'));card.append(time);
      const quote=cells[contract.quote],quoteText=normalize(quote.textContent);
      // Only an ordinary numeric quote goes into the optional fold. Any extra
      // qualification, missing price or warning stays visible with its label.
      const warningQuote=quote.classList.contains('wv')||quote.classList.contains('or')||!!quote.querySelector('.wv,.or');
      const simpleQuote=!warningQuote&&/^(?:[A-Z]{3} )?[+−-]?\d[\d,]*(?:\.\d+)?$/.test(quoteText);
      const quoteFields=el(doc,'dl');quoteFields.append(field(doc,contract.headers[contract.quote],quote,'',isTotal?'不适用':'未取得'));
      if(simpleQuote){const fold=el(doc,'details','holdings-quote');fold.append(el(doc,'summary','','报价详情'),quoteFields);card.append(fold);}
      else{quoteFields.className='holdings-quote'+(isTotal&&!quoteText?'':' holdings-flags');card.append(quoteFields);}
      // Attributes are not financial evidence. Preserve explicit source title/
      // aria qualifications, including a quote warning that must not be folded.
      const flags=new Set();
      const annotated=[{root:row,label:null},...cells.map((root,i)=>({root,label:contract.headers[i]})),
        ...heads.map((root,i)=>({root,label:contract.headers[i]}))];
      for(const {root,label} of annotated){
        // The row itself is handled separately; cell descendants can otherwise
        // hide a qualification in a tooltip under a closed quote-details fold.
        const nodes=label!==null?[root,...root.querySelectorAll('[title],[aria-label]')]:[root];
        for(const node of nodes)for(const attr of ['title','aria-label']){
          const flag=node.getAttribute(attr);
          if(flag && CAUTION.test(flag)){
            const labelled=label!==null?`${label}：${flag}`:flag;
            if(!flags.has(labelled)){flags.add(labelled);card.append(el(doc,'p','holdings-flags',labelled));}
          }
        }
      }
      list.append(card);
    }
    sourceContext(doc,table);
    const wrapper=el(doc,'div','holdings-responsive');
    table.before(wrapper);wrapper.append(list,table);enhanced.set(table,wrapper);
  }
}
