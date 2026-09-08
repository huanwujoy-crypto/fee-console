import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {improveHoldingsCards,holdingsHeaderContract,HOLDINGS_CARDS_CSS} from './xuan-ib-holdings-cards.mjs';

// Synthetic DOM for deterministic CI. Actual width/zoom acceptance is a separate
// browser check; this model does not pretend to measure CSS layout.
class Node {
  constructor(tag='',text='') {this.tagName=tag.toUpperCase();this.nodeType=tag?1:3;this._text=text;this.attrs={};this.childNodes=[];this.parentElement=null;}
  get children(){return this.childNodes.filter(n=>n.nodeType===1);}
  get textContent(){return this.nodeType===3?this._text:this.childNodes.map(n=>n.textContent).join('');}
  set textContent(text){this.childNodes.forEach(n=>n.parentElement=null);this.childNodes=[];if(this.nodeType===3)this._text=String(text);else this.append(new Node('',String(text)));}
  get className(){return this.attrs.class||'';}set className(value){this.attrs.class=value;}
  get classList(){return {contains:c=>this.className.split(/\s+/).includes(c),add:(...cs)=>{this.className=[...new Set([...this.className.split(/\s+/).filter(Boolean),...cs])].join(' ');}};}
  setAttribute(k,v){this.attrs[k]=String(v);}getAttribute(k){return Object.hasOwn(this.attrs,k)?this.attrs[k]:null;}removeAttribute(k){delete this.attrs[k];}
  remove(){if(this.parentElement){const p=this.parentElement;p.childNodes.splice(p.childNodes.indexOf(this),1);this.parentElement=null;}}
  append(...nodes){for(const n of nodes){n.remove();n.parentElement=this;this.childNodes.push(n);}}
  prepend(n){n.remove();n.parentElement=this;this.childNodes.unshift(n);}
  before(n){const p=this.parentElement;n.remove();n.parentElement=p;p.childNodes.splice(p.childNodes.indexOf(this),0,n);}
  after(n){const p=this.parentElement;n.remove();n.parentElement=p;p.childNodes.splice(p.childNodes.indexOf(this)+1,0,n);}
  cloneNode(deep=false){const copy=new Node(this.tagName,this._text);copy.attrs={...this.attrs};if(deep)for(const n of this.childNodes)copy.append(n.cloneNode(true));return copy;}
  matches(selector){return selector.split(',').some(s=>simple(this,s.trim()));}
  closest(selector){for(let node=this;node;node=node.parentElement)if(node.matches(selector))return node;return null;}
  querySelectorAll(selector){
    const descendants=[];const walk=n=>{for(const c of n.children){descendants.push(c);walk(c);}};walk(this);
    const match=(node,s)=>{
      if(s.startsWith(':scope > ')){
        const parts=s.slice(9).split(' > ');let current=node;
        for(let i=parts.length-1;i>=0;i--){if(!current||!simple(current,parts[i]))return false;current=current.parentElement;}
        return current===this;
      }
      const parts=s.split(/\s+/);if(!simple(node,parts.pop()))return false;
      let ancestor=node.parentElement;
      while(parts.length){const wanted=parts.pop();while(ancestor&&!simple(ancestor,wanted))ancestor=ancestor.parentElement;if(!ancestor)return false;ancestor=ancestor.parentElement;}
      return true;
    };
    return descendants.filter(node=>selector.split(',').some(s=>match(node,s.trim())));
  }
  querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
}
function simple(node,selector){
  if(node.nodeType!==1)return false;
  const tag=selector.match(/^[a-z]+/i)?.[0];if(tag&&node.tagName!==tag.toUpperCase())return false;
  for(const c of selector.matchAll(/\.([\w-]+)/g))if(!node.classList.contains(c[1]))return false;
  for(const a of selector.matchAll(/\[([\w-]+)\]/g))if(node.getAttribute(a[1])===null)return false;
  return true;
}
const element=(tag,text=null,cls='')=>{const n=new Node(tag);if(text!==null)n.textContent=text;if(cls)n.className=cls;return n;};
const signature=n=>JSON.stringify([n.tagName,n.attrs,n.nodeType===3?n.textContent:n.childNodes.map(signature)]);
const generated=['标的','市值 $','日涨跌','估值价','行情时点'];
function fixture({headers=generated,rows=[['SYNTH','1,200','−1.50%（旧值）','CAD 12.2500','2026-09-07 16:00 HKT · 延迟']],pane='p1'}={}){
  const doc=new Node('document');doc.createElement=tag=>new Node(tag);doc.createTextNode=text=>new Node('',text);
  const p=element('div',null,`pane ${pane}`),card=element('section',null,'card'),heading=element('h2','① 持仓一览');
  const source=element('p','2026-09-08 08:29–08:31 HKT · 3 只','sub');
  const total=element('p','权威市值 $9,876 · 替代源');
  const group=element('details'),summary=element('summary','涨跌数据待核验（3）'),body=element('div',null,'dbody'),wrap=element('div',null,'tblwrap');
  const table=element('table',null,'mobile-holdings'),thead=element('thead'),tr=element('tr'),tbody=element('tbody');
  headers.forEach(h=>tr.append(element('th',h)));thead.append(tr);
  rows.forEach(values=>{const row=element('tr');values.forEach(text=>row.append(element('td',text)));tbody.append(row);});
  table.append(thead,tbody);wrap.append(table);body.append(wrap);group.append(summary,body);card.append(heading,source,total,group);p.append(card);doc.append(p);
  return {doc,pane:p,card,source,total,group,table,tbody};
}

test('known generated and legacy contracts retain label roles; unknown headers do not guess',()=>{
  assert.deepEqual(holdingsHeaderContract(generated),{identity:0,value:1,change:2,quote:3,time:4,headers:generated});
  assert.equal(holdingsHeaderContract(['标的','估值价','日涨跌','行情时点','市值 $']).value,4);
  assert.equal(holdingsHeaderContract(['标的','市值 $','收盘报价（ib 直读）']).change,null);
  assert.equal(holdingsHeaderContract(['标的','市值 EUR','日涨跌','估值价','行情时点']),null);
  assert.equal(holdingsHeaderContract(['标的','市值 $','盈亏','估值价','行情时点']),null);
});
test('current compact report authoring header contract remains recognized without financial fixtures',()=>{
  const renderer=fs.readFileSync(new URL('./xuan-ib-report-view.mjs',import.meta.url),'utf8');
  const start=renderer.indexOf('const rows = items =>');
  const header=renderer.slice(start).match(/<thead><tr>(.*?)<\/tr><\/thead>/)[1];
  const labels=[...header.matchAll(/<th>(.*?)<\/th>/g)].map(m=>m[1]);
  assert.ok(holdingsHeaderContract(labels),'new renderer headers need explicit card support or unmodified fallback');
});
test('cards preserve source table bytes, signs, currencies, dates, warnings and group nesting',()=>{
  const f=fixture();const identity=f.tbody.children[0].children[0];identity.textContent='';
  identity.append(element('span','SYNTH','sym'),element('span','TSX · −10.5000','sub'));
  f.tbody.children[0].children[2].className='dn';
  const before=signature(f.table),groupParent=f.group.parentElement;
  improveHoldingsCards(f.doc);
  assert.equal(signature(f.table),before);assert.equal(f.group.parentElement,groupParent);
  const card=f.doc.querySelector('.holdings-mobile-card');
  for(const text of ['SYNTH','TSX · −10.5000','市值 $','1,200','日涨跌','−1.50%（旧值）','CAD 12.2500','2026-09-07 16:00 HKT · 延迟'])assert.ok(card.textContent.includes(text),text);
  assert.ok(card.querySelector('dd.dn'));
  assert.ok(card.querySelector('.holdings-time').textContent.includes('延迟'));
  assert.equal(card.querySelector('.holdings-time').closest('details'),f.group);
  const quote=card.querySelector('details.holdings-quote');assert.ok(quote.textContent.includes('CAD 12.2500'));
  assert.equal(f.doc.querySelectorAll('.holdings-source-context').length,1);
  assert.ok(f.doc.querySelector('.holdings-source-context').textContent.includes('权威市值 $9,876 · 替代源'));
  assert.equal(f.doc.querySelector('.holdings-source-context').closest('details'),null);
});
test('unknown table schemas, spanning cells and unsupported structures stay byte-identical',()=>{
  for(const mutate of [f=>{f.table.querySelectorAll('thead th')[2].textContent='盈亏';},f=>{f.tbody.children[0].children[0].setAttribute('colspan','2');},f=>{f.table.append(element('caption','总额'));},f=>{f.tbody.children[0].children[0].textContent='';}]){
    const f=fixture();mutate(f);const before=signature(f.doc);improveHoldingsCards(f.doc);assert.equal(signature(f.doc),before);
  }
  const other=fixture({pane:'p2'}),before=signature(other.doc);improveHoldingsCards(other.doc);assert.equal(signature(other.doc),before);
});
test('legacy missing daily change is explicit; unknown/qualified quotes stay outside details',()=>{
  const f=fixture({headers:['标的','市值 $','收盘报价（ib 直读）'],rows:[['OLD','未取得','未取得（替代源待核）']]});
  improveHoldingsCards(f.doc);const card=f.doc.querySelector('.holdings-mobile-card');
  assert.ok(card.textContent.includes('日涨跌未取得（原表未提供）'));
  assert.ok(card.textContent.includes('行情时点原表未提供'));
  assert.equal(card.querySelector('details'),null);
  assert.ok(card.querySelector('.holdings-flags').textContent.includes('收盘报价（ib 直读）未取得（替代源待核）'));
});
test('blank change never becomes blank or zero, and totals stay distinct from holdings',()=>{
  const f=fixture({rows:[['FIRST','20','','USD 1',''],['SECOND','20','+0.00%','USD 2','2026-09-08 08:30 HKT'],['合计','40','','','']]});
  improveHoldingsCards(f.doc);const cards=f.doc.querySelectorAll('.holdings-mobile-card');
  assert.deepEqual(cards.map(c=>c.querySelector('.holdings-identity').textContent),['FIRST','SECOND','合计']);
  assert.ok(cards[0].querySelector('.holdings-primary-values').textContent.includes('日涨跌未取得'));
  assert.ok(cards[1].textContent.includes('+0.00%'));
  assert.ok(cards[2].classList.contains('holdings-total'));
});
test('retry is idempotent, source qualifications survive later note moves and cloned IDs do not repeat',()=>{
  const f=fixture();const symbol=element('span','SYNTH');symbol.setAttribute('id','source-symbol');f.tbody.children[0].children[0].append(symbol);
  f.tbody.children[0].setAttribute('title','override：原来源近似值');
  f.tbody.children[0].children[3].setAttribute('aria-label','报价延迟 15 分钟');
  improveHoldingsCards(f.doc);const first=signature(f.doc);improveHoldingsCards(f.doc);assert.equal(signature(f.doc),first);
  f.source.remove();f.total.remove();
  assert.ok(f.doc.querySelector('.holdings-source-context').textContent.includes('2026-09-08 08:29–08:31 HKT'));
  assert.ok(f.doc.querySelector('.holdings-flags').textContent.includes('override：原来源近似值'));
  assert.ok(f.doc.querySelectorAll('.holdings-flags').some(node=>node.textContent==='估值价：报价延迟 15 分钟'&&node.closest('details')===f.group));
  assert.equal(f.doc.querySelectorAll('[id]').length,1);
  assert.equal(f.doc.querySelectorAll('.holdings-mobile-cards').length,1);
});
test('nested quote and identity tooltip qualifications remain visible outside closed details',()=>{
  const f=fixture(),cells=f.tbody.children[0].children;
  const quote=element('span','CAD 12.2500'),nested=element('span');quote.setAttribute('title','报价延迟15分钟');
  nested.setAttribute('aria-label','本行估值为替代源');nested.append(quote);cells[3].textContent='';cells[3].append(nested);
  const identity=element('span','SYNTH');identity.setAttribute('title','旧值，身份待核实');cells[0].textContent='';cells[0].append(identity);
  const before=signature(f.table);improveHoldingsCards(f.doc);const card=f.doc.querySelector('.holdings-mobile-card');
  assert.equal(signature(f.table),before);
  const flags=card.querySelectorAll('p.holdings-flags');
  for(const expected of ['估值价：报价延迟15分钟','估值价：本行估值为替代源','标的：旧值，身份待核实']){
    assert.ok(flags.some(n=>n.textContent===expected&&n.closest('details')===f.group),expected);
  }
  assert.ok(card.querySelector('details.holdings-quote'));
});
test('source note preserves the whole parent negation and conditional list, never isolated alarming children',()=>{
  for(const intro of ['以下情况均未发生：','如果今后发现以下情况，才改用替代源：']){
    const f=fixture(),note=element('details'),body=element('div',null,'dbody'),list=element('ul');
    list.append(element('li','行情延迟使用替代源'),element('li','价格未取得'));
    body.append(element('p',intro),list);note.append(element('summary','持仓说明'),body);f.card.append(note);
    const before=signature(note);improveHoldingsCards(f.doc);
    const copy=f.doc.querySelector('.holdings-context-note');
    assert.equal(copy.textContent,body.textContent);
    assert.equal(copy.children[0].textContent,intro);
    assert.equal(copy.children[1].tagName,'UL');
    assert.equal(copy.closest('details'),null);
    assert.equal(signature(note),before);
  }
});
test('long contextual qualification stays whole in a neutral fold, with source time and row exceptions still visible',()=>{
  const f=fixture(),note=element('details'),body=element('div',null,'dbody');
  body.append(element('p','以下情况均未发生：'),element('p','行情延迟使用替代源。'),element('p','本段说明估值与账户来源的对应方法。'.repeat(20)));
  note.append(element('summary','持仓说明'),body);f.card.append(note);improveHoldingsCards(f.doc);
  const context=f.doc.querySelector('.holdings-source-context'),fold=context.querySelector('.holdings-context-detail');
  assert.equal(fold.querySelector('summary').textContent,'来源限定条件（完整原说明）');
  assert.equal(fold.querySelector('.holdings-context-note').textContent,body.textContent);
  assert.ok(context.children.some(n=>n.textContent==='2026-09-08 08:29–08:31 HKT · 3 只'));
  assert.ok(context.children.some(n=>n.textContent==='权威市值 $9,876 · 替代源'));
  assert.ok(f.doc.querySelector('.holdings-time').textContent.includes('延迟'));
  const once=signature(f.doc);improveHoldingsCards(f.doc);assert.equal(signature(f.doc),once);
});
test('ordinary method-only holdings notes are not copied into the mobile main context',()=>{
  const f=fixture(),note=element('details'),body=element('div',null,'dbody');
  body.append(element('p','估值以原报告币种和价格列展示，具体方法按原始说明。'));
  note.append(element('summary','持仓说明'),body);f.card.append(note);
  const before=signature(note);improveHoldingsCards(f.doc);
  assert.equal(f.doc.querySelector('.holdings-context-note'),null);
  assert.equal(signature(note),before);
});
test('mobile CSS uses narrow-screen-only switch and preserves the full table for desktop and print',()=>{
  assert.match(HOLDINGS_CARDS_CSS,/@media screen and \(max-width:640px\)/);
  assert.match(HOLDINGS_CARDS_CSS,/@media print\{.*display:table!important/s);
  assert.match(HOLDINGS_CARDS_CSS,/grid-template-columns:minmax\(0,1fr\) minmax\(0,1\.25fr\)/);
  assert.match(HOLDINGS_CARDS_CSS,/overflow-wrap:anywhere!important/);
  assert.doesNotMatch(HOLDINGS_CARDS_CSS,/overflow(?:-x)?:hidden|min-width:\d+px/);
});
