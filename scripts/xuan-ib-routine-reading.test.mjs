import test from 'node:test';
import assert from 'node:assert/strict';
import {reportNoteLines,simplifyReportNotes} from './xuan-ib-routine-reading.mjs';

test('routine notes stay concise and exclude irrelevant history',()=>{
  for(let pane=1;pane<=5;pane++){
    const lines=reportNoteLines(pane,'历史四桶 08-24 快照 旧任务未核验 已结案');
    assert.ok(lines.length<=3);assert.ok(lines.every(x=>x.length<80));
    assert.doesNotMatch(lines.join(''),/四桶|08-24|已结案/);
  }
});
test('risk approximation, missing AAOI and leverage uncertainty are not disguised as verified',()=>{
  const lines=reportNoteLines(2,'低高近似 不含 AAOI 名义敞口待核验');
  assert.match(lines.join(' '),/低／高情景仍为近似/);
  assert.match(lines.join(' '),/AAOI 尚未计入/);
  assert.match(lines.join(' '),/名义敞口未核验/);assert.ok(lines.length<=3);
  const applied=reportNoteLines(2,'低高近似',{aaoiApplied:true});
  assert.match(applied.join(' '),/原快照.*未重新取数/);
  assert.doesNotMatch(applied.join(' '),/尚未计入/);
});
test('cash planning and daily-quote availability keep only applicable qualifications',()=>{
  const cash=reportNoteLines(3,'USSC 10%');
  assert.match(cash.join(' '),/仅供现金规划/);
  assert.match(cash.join(' '),/10% 是本次现金预算占比/);
  assert.doesNotMatch(cash.join(' '),/卖出回款/);
  assert.match(reportNoteLines(3,'补后比例含新增买入；不假设卖出回款').join(' '),/不假设卖出/);
  assert.match(reportNoteLines(1,'日涨跌未取得').join(' '),/不以零或未实现盈亏代替/);
});

test('ordinary configuration qualifiers do not claim a data limitation',()=>{
  const f=fixture(3),source=add(f.doc,f.body,'p','USSC 10% 补后比例含新增买入；不假设卖出回款。');
  simplifyReportNotes(f.doc);
  assert.doesNotMatch(f.fold.querySelector(':scope > summary').textContent,/含数据限制/);
  assert.ok(f.section.querySelector('.routine-source-records').contains(source));
});

// Small in-memory DOM contract model. Browser/mobile layout is a separate gate.
class Element {
  constructor(tag){this.tagName=tag.toUpperCase();this.children=[];this.parentElement=null;this.attributes=new Map();this._text='';this.open=false;}
  get className(){return this.getAttribute('class')||'';} set className(value){this.setAttribute('class',value);}
  get id(){return this.getAttribute('id')||'';} set id(value){this.setAttribute('id',value);}
  get textContent(){return this._text+this.children.map(n=>n.textContent).join('');}
  set textContent(value){this.replaceChildren();this._text=String(value);}
  setAttribute(key,value){this.attributes.set(key,String(value));}
  getAttribute(key){return this.attributes.get(key)??null;}
  removeAttribute(key){this.attributes.delete(key);}
  append(...nodes){for(const node of nodes){node.remove();node.parentElement=this;this.children.push(node);}}
  before(node){const parent=this.parentElement;node.remove();node.parentElement=parent;parent.children.splice(parent.children.indexOf(this),0,node);}
  remove(){if(this.parentElement){const parent=this.parentElement;parent.children.splice(parent.children.indexOf(this),1);this.parentElement=null;}}
  replaceChildren(...nodes){for(const n of this.children)n.parentElement=null;this.children=[];this._text='';this.append(...nodes);}
  contains(node){for(let n=node;n;n=n.parentElement)if(n===this)return true;return false;}
  matches(selector){return selector.split(',').some(part=>{
    const s=part.trim(),tag=s.match(/^[\w-]+/)?.[0],id=s.match(/#([\w-]+)/)?.[1];
    const classes=[...s.matchAll(/\.([\w-]+)/g)].map(m=>m[1]);
    const attrs=[...s.matchAll(/\[([\w-]+)\]/g)].map(m=>m[1]);
    return (!tag||this.tagName===tag.toUpperCase())&&(!id||this.id===id)&&classes.every(c=>this.className.split(/\s+/).includes(c))&&attrs.every(a=>this.attributes.has(a));
  });}
  closest(selector){for(let n=this;n;n=n.parentElement)if(n.matches(selector))return n;return null;}
  querySelectorAll(selector){
    if(selector.startsWith(':scope > '))return this.children.filter(n=>n.matches(selector.slice(9)));
    const all=[];const visit=n=>{for(const child of n.children){all.push(child);visit(child);}};visit(this);
    return all.filter(node=>selector.split(',').some(part=>{
      const chain=part.trim().split(/\s+/);if(!node.matches(chain.pop()))return false;
      let ancestor=node.parentElement;
      while(chain.length){const match=chain.pop();while(ancestor&&!ancestor.matches(match))ancestor=ancestor.parentElement;if(!ancestor)return false;ancestor=ancestor.parentElement;}
      return true;
    }));
  }
  querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
  cloneNode(deep){const copy=new Element(this.tagName);copy.attributes=new Map(this.attributes);copy._text=this._text;copy.open=this.open;if(deep)copy.append(...this.children.map(n=>n.cloneNode(true)));return copy;}
}
class Document extends Element {
  constructor(){super('document');}
  createElement(tag){return new Element(tag);}
  getElementById(id){return this.querySelectorAll('[id]').find(n=>n.id===id)||null;}
}
const add=(doc,parent,tag,text='',cls='')=>{const node=doc.createElement(tag);node.textContent=text;node.className=cls;parent.append(node);return node;};
function fixture(pane=2,{fallback=false}={}){
  const doc=new Document(),section=add(doc,doc,'section','','pane p'+pane);
  const fold=add(doc,section,'details');if(!fallback)fold.id='xuan-pane-notes-p'+pane;
  add(doc,fold,'summary','报告说明');const body=add(doc,fold,'div','','dbody');return {doc,section,fold,body};
}
const snapshot=node=>JSON.stringify({tag:node.tagName,attrs:[...node.attributes],text:node._text,open:node.open,children:node.children.map(snapshot)});

for(const shape of ['p','li','nested-list'])test(`material ${shape} limitation stays visible once while source is hidden`,()=>{
  const f=fixture(),context=add(f.doc,f.body,'section','','notes-section');context.id='source-risk';
  add(f.doc,context,'h3','2026-09-08 08:31 HKT；三账户、含现金、USD。');
  add(f.doc,context,'p','仅用于本次压力情景；分母为同一时点 $6,200,000。');
  const failure='来源缺失：NOAH 明细；其他已核实来源仍有效。';
  if(shape==='p')add(f.doc,context,'p',failure);
  else {const list=add(f.doc,context,'ol'),item=add(f.doc,list,'li',shape==='li'?failure:'限制仅适用于 NOAH，不含 IB：');if(shape==='nested-list')add(f.doc,add(f.doc,item,'ul'),'li',failure);}
  const original=snapshot(context);simplifyReportNotes(f.doc);
  const records=f.section.querySelector('.routine-source-records'),alert=f.section.querySelector('.routine-material-exceptions');
  assert.ok(records&&records.matches('[hidden]')&&records.contains(context));assert.equal(snapshot(context),original);
  assert.ok(alert&&!f.fold.contains(alert));assert.match(alert.textContent,/三账户、含现金、USD/);assert.match(alert.textContent,/来源缺失/);
  assert.equal(alert.querySelectorAll('[id]').length,0);assert.equal(f.fold.querySelector('.concise-report-notes').querySelector('details'),null);
});

test('mild limitations are signposted without restoring full source prose',()=>{
  const f=fixture(1),list=add(f.doc,f.body,'ul');
  add(f.doc,list,'li','数据降级：2026-09-07 只读替代源；报价 CAD、汇总 USD。');
  add(f.doc,list,'li','日涨跌未取得；不是 0%，也不是未实现盈亏。');
  simplifyReportNotes(f.doc);
  assert.match(f.fold.querySelector(':scope > summary').textContent,/含数据限制/);
  assert.match(f.fold.textContent,/不以零或未实现盈亏代替/);
  assert.doesNotMatch(f.fold.textContent,/报价 CAD、汇总 USD/);
  assert.ok(f.section.querySelector('.routine-source-records').contains(list));
  assert.match(f.section.querySelector('.routine-material-exceptions').textContent,/报价 CAD、汇总 USD/);
});

test('display reading adds no network, storage or HTML interpretation work',()=>{
  const source=new URL('./xuan-ib-routine-reading.mjs',import.meta.url);
  return import('node:fs').then(fs=>assert.doesNotMatch(fs.readFileSync(source,'utf8'),/fetch\(|localStorage|sessionStorage|innerHTML\s*=/));
});

test('account disclosure remains unique, visible and directly inside the one note layer',()=>{
  const f=fixture(1),disclosure=add(f.doc,f.body,'p','账户关联：所有者确认至 2026-10-10 21:30 HKT；接口未返回账户编号，非身份认证。');
  disclosure.id='xuan-ib-account-association-disclosure-v1';simplifyReportNotes(f.doc);
  assert.equal(f.doc.querySelectorAll('#xuan-ib-account-association-disclosure-v1').length,1);
  assert.ok(f.fold.querySelector('.concise-report-notes').contains(disclosure));
  assert.equal(f.fold.querySelector('.concise-report-notes').querySelector('details'),null);
});

test('source structures, decisions and inert records remain intact but not as visible nested notes',()=>{
  const f=fixture(4),image=add(f.doc,f.body,'img');image.id='source-chart';
  const qualified=add(f.doc,f.body,'p','发布仍须通过 Validate → Promote → Pages，并核对公开版本；生成候选不等于已发布。 本期数据截止 2026-09-08。');
  const decision=add(f.doc,f.body,'details','历史来源缺失；尚未计入 AAOI。','dcard');decision.setAttribute('data-decision-id','stable-original');
  const control=add(f.doc,decision,'button','回应待办'),record=add(f.doc,f.fold,'template');record.id='preserved-receipt-template';
  const originals=[image,qualified,decision,control,record].map(snapshot);simplifyReportNotes(f.doc);
  const records=f.section.querySelector('.routine-source-records');
  assert.ok([image,qualified,decision,record].every(node=>records.contains(node)));
  assert.deepEqual([image,qualified,decision,control,record].map(snapshot),originals);
  assert.equal(f.doc.getElementById('source-chart'),image);assert.equal(f.doc.getElementById('preserved-receipt-template'),record);
  assert.equal(f.fold.querySelector('.concise-report-notes').querySelector('details'),null);
});

test('ETF and empty panes use one short line and preserve original source outside the fold',()=>{
  const etf=fixture(5,{fallback:true}),source=add(etf.doc,etf.body,'p','估算截止 2026-09-03；基线 2026-09-01；同额 USD 出入金。');
  simplifyReportNotes(etf.doc);assert.match(etf.fold.textContent,/A 实际／B 协作／C 标普500/);
  assert.doesNotMatch(etf.fold.textContent,/估算截止/);assert.ok(etf.section.querySelector('.routine-source-records').contains(source));
  const empty=fixture(1);simplifyReportNotes(empty.doc);
  assert.equal(empty.fold.querySelector('.concise-report-notes').querySelector('ul').children.length,1);
  assert.equal(empty.section.querySelector('.routine-source-records'),null);
});

test('separate material contexts retain visible order and transformation is idempotent',()=>{
  const f=fixture(),first=add(f.doc,f.body,'section','','notes-section');add(f.doc,first,'p','读取失败：来源 A。');
  const second=add(f.doc,f.body,'section','','notes-section');add(f.doc,second,'p','数据冲突：来源 B。');
  simplifyReportNotes(f.doc);const alert=f.section.querySelector('.routine-material-exceptions');
  assert.ok(alert.textContent.indexOf('来源 A')<alert.textContent.indexOf('来源 B'));
  const rendered=snapshot(f.doc);simplifyReportNotes(f.doc);assert.equal(snapshot(f.doc),rendered);
});
