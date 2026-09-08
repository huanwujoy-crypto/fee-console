import test from 'node:test';
import assert from 'node:assert/strict';
import {reportNoteLines,simplifyReportNotes} from './xuan-ib-routine-reading.mjs';
test('routine notes stay concise and exclude irrelevant history',()=>{
  for(let pane=1;pane<=5;pane++){
    const lines=reportNoteLines(pane,'历史四桶 08-24 快照 旧任务未核验 已结案');
    assert.ok(lines.length<=4);assert.ok(lines.every(x=>x.length<100));
    assert.doesNotMatch(lines.join(''),/四桶|08-24|已结案/);
  }
});
test('risk approximation, missing AAOI and leverage uncertainty are not disguised as verified',()=>{
  const lines=reportNoteLines(2,'低高近似 不含 AAOI 名义敞口待核验');
  assert.match(lines.join(' '),/低／高情景仍为近似/);
  assert.match(lines.join(' '),/AAOI 尚未计入/);
  assert.match(lines.join(' '),/名义敞口未核验/);
  const applied=reportNoteLines(2,'低高近似',{aaoiApplied:true});
  assert.match(applied.join(' '),/原快照.*未重新取数/);
  assert.doesNotMatch(applied.join(' '),/尚未计入/);
});
test('cash planning and daily-quote availability keep their qualifications',()=>{
  const cash=reportNoteLines(3,'USSC 10%');
  assert.match(cash.join(' '),/不是券商即时购买力/);
  assert.match(cash.join(' '),/10% 是本次现金预算占比/);
  assert.match(cash.join(' '),/不假设卖出回款/);
  assert.match(reportNoteLines(1,'日涨跌未取得').join(' '),/不以零或未实现盈亏代替/);
});

// Small in-memory DOM contract model. Browser/mobile layout remains a separate
// acceptance gate; these tests exercise subtree preservation and note routing.
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

for(const shape of ['p','li','nested-list'])test(`material ${shape} limitations retain complete ordered source context and remain visible`,()=>{
  const f=fixture(),{doc,body}=f;
  const context=add(doc,body,'section','','notes-section');context.id='source-risk';
  add(doc,context,'h3','风险来源：2026-09-08 08:31 HKT；三账户、含现金、USD。');
  add(doc,context,'p','仅用于本次压力情景；分母为同一时点 $6,200,000，不代表即时购买力。');
  const failure='来源缺失：NOAH 明细；仅这一来源无法计算，其他已核实来源仍有效。';
  if(shape==='p')add(doc,context,'p',failure);
  else {
    const list=add(doc,context,'ol'),item=add(doc,list,'li',shape==='li'?failure:'2026-09-07 替代快照；下列限制仅适用于 NOAH，不含 IB：');
    if(shape==='nested-list')add(doc,add(doc,item,'ul'),'li',failure);
  }
  add(doc,context,'p','后续：只重试缺失来源，不更改原始数据或账户范围。');
  const before=snapshot(context);
  simplifyReportNotes(doc);
  const full=f.fold.querySelector('.routine-data-limits'),alert=f.section.querySelector('.routine-material-exceptions');
  assert.ok(full.contains(context));assert.equal(snapshot(context),before,'original subtree is moved intact, not flattened');
  assert.equal(full.open,false);assert.ok(alert&&!f.fold.contains(alert),'material exception remains outside the closed notes');
  assert.ok(alert.textContent.includes(failure));assert.match(alert.textContent,/2026-09-08 08:31 HKT；三账户、含现金、USD/);
  assert.match(alert.textContent,/同一时点 \$6,200,000/);
  assert.ok(alert.textContent.indexOf('分母')<alert.textContent.indexOf(failure));
  assert.ok(alert.textContent.indexOf(failure)<alert.textContent.indexOf('后续：'));
  if(shape==='nested-list')assert.match(alert.textContent,/仅适用于 NOAH，不含 IB/);
  assert.equal(alert.querySelectorAll('[id]').length,0,'context copy introduces no duplicate ids');
  assert.equal(doc.getElementById('source-risk'),context);
  const rendered=snapshot(doc);simplifyReportNotes(doc);assert.equal(snapshot(doc),rendered,'second invocation is idempotent');
});

test('unrecognized and mild limitations keep their full notes instead of disappearing into generic summaries',()=>{
  const {doc,fold,body,section}=fixture(1);
  const list=add(doc,body,'ul');add(doc,list,'li','数据降级：2026-09-07 只读替代源；报价 CAD、汇总 USD；按三账户含现金范围。');
  add(doc,list,'li','日涨跌未取得；不是 0%，也不是未实现盈亏。');
  const raw=snapshot(body);simplifyReportNotes(doc);
  assert.equal(snapshot(body),raw);assert.ok(fold.querySelector('.routine-data-limits').contains(body));
  assert.equal(section.querySelector('.routine-material-exceptions'),null);
  assert.match(fold.textContent,/报价 CAD、汇总 USD/);
  assert.match(fold.querySelector(':scope > summary').textContent,/含数据限制/);
  assert.match(fold.querySelector('.routine-data-limits').querySelector(':scope > summary').textContent,/含数据限制/);
});

for(const container of ['bare-siblings','generic-body'])test(`unwrapped ${container} material notes retain preceding negation and the complete fold context`,()=>{
  const {doc,fold,body,section}=fixture();body.remove();
  const parent=container==='generic-body'?add(doc,fold,'div','','dbody'):fold;
  const before=add(doc,parent,'p','2026-09-08 08:31 HKT；USD、三账户含现金。以下情况均未发生：');
  const list=add(doc,parent,'ul');add(doc,list,'li','来源缺失或账户不匹配；没有发生，不应解释为本期失败。');
  const after=add(doc,parent,'p','以上检查范围不含 NOAH；其报价 CAD，非本期美元分母。');
  const record=add(doc,fold,'details','','xuan-work');add(doc,record,'p','历史读取失败：不得提升为本期提醒。');
  const script=add(doc,fold,'script','historical failure record');
  const originals=[before,list,after,record,script].map(snapshot);
  simplifyReportNotes(doc);
  const alert=section.querySelector('.routine-material-exceptions');
  assert.ok(alert&&!fold.contains(alert));
  assert.match(alert.textContent,/以下情况均未发生：/);
  assert.ok(alert.textContent.indexOf('以下情况均未发生：')<alert.textContent.indexOf('来源缺失'));
  assert.ok(alert.textContent.indexOf('来源缺失')<alert.textContent.indexOf('以上检查范围不含 NOAH'));
  assert.match(alert.textContent,/2026-09-08 08:31 HKT；USD、三账户含现金/);
  assert.match(alert.textContent,/其报价 CAD，非本期美元分母/);
  assert.doesNotMatch(alert.textContent,/历史读取失败|historical failure record/);
  assert.equal(alert.querySelector('script,.xuan-work'),null);
  assert.deepEqual([before,list,after,record,script].map(snapshot),originals);
  assert.ok([before,list,after,record,script].every(node=>fold.contains(node)));
  const rendered=snapshot(doc);simplifyReportNotes(doc);assert.equal(snapshot(doc),rendered);
});

for(const limitation of ['名义敞口待核验','数据降级：采用注明日期的替代源','报价已过期，保留最后已核实来源'])test(`${limitation} is signposted on the closed notes without creating a severe alert`,()=>{
  const {doc,fold,body,section}=fixture(1);add(doc,body,'p',limitation+'；2026-09-07，USD，限 IB。');
  const original=snapshot(body);simplifyReportNotes(doc);
  assert.equal(fold.open,false);assert.match(fold.querySelector(':scope > summary').textContent,/含数据限制/);
  assert.equal(section.querySelector('.routine-material-exceptions'),null);
  assert.equal(snapshot(body),original);assert.ok(fold.querySelector('.routine-data-limits').contains(body));
  const rendered=snapshot(doc);simplifyReportNotes(doc);assert.equal(snapshot(doc),rendered);
});

test('textless source roots and nested image structures are preserved intact and in order',()=>{
  const {doc,fold,body}=fixture(1);body.remove();
  const image=add(doc,fold,'img');image.setAttribute('src','source-risk-chart.svg');image.id='source-chart';
  const separator=add(doc,fold,'hr');
  const figure=add(doc,fold,'figure'),nested=add(doc,figure,'img');nested.setAttribute('src','source-scope.svg');
  const original=[image,separator,figure].map(snapshot);simplifyReportNotes(doc);
  const full=fold.querySelector('.routine-data-limits');
  assert.ok(full);assert.deepEqual(full.children.slice(1),[image,separator,figure]);
  assert.deepEqual([image,separator,figure].map(snapshot),original);
  assert.equal(doc.getElementById('source-chart'),image);
  assert.doesNotMatch(fold.querySelector(':scope > summary').textContent,/含数据限制/);
  assert.doesNotMatch(fold.textContent,/暂无额外来源说明/);
});

test('only exact known boilerplate is removed; decisions and technical records are not reinterpreted or modified',()=>{
  const {doc,fold,body,section}=fixture(4);
  const sentence='发布仍须通过 Validate → Promote → Pages，并核对公开版本；生成候选不等于已发布。';
  const removed=add(doc,body,'p',sentence);
  const qualified=add(doc,body,'p',sentence+' 本期数据截止 2026-09-08。');
  const decision=add(doc,body,'details','历史来源缺失；尚未计入 AAOI。','dcard');decision.setAttribute('data-decision-id','stable-original');
  const button=add(doc,decision,'button','仍待用户确认');
  const technical=add(doc,body,'section','','xuan-work');add(doc,technical,'p','历史读取失败，不能作为本期数据限制。');
  const originals=[decision,button,technical].map(snapshot);simplifyReportNotes(doc);
  assert.equal(removed.parentElement,null);assert.ok(fold.contains(qualified));
  assert.deepEqual([decision,button,technical].map(snapshot),originals);
  assert.ok(fold.contains(decision));assert.equal(section.querySelector('.routine-material-exceptions'),null);
  assert.doesNotMatch(fold.querySelector(':scope > summary').textContent,/含数据限制/);
  assert.equal(doc.querySelectorAll('[data-decision-id]').length,1);
});

test('ETF fallback notes preserve nested context and genuinely empty notes have an honest fallback',()=>{
  const f=fixture(5,{fallback:true});add(f.doc,f.body,'p','估算截止 2026-09-03；基线 2026-09-01；同额 USD 出入金，不含交易执行。');
  simplifyReportNotes(f.doc);assert.match(f.fold.textContent,/估算截止 2026-09-03；基线 2026-09-01/);
  const empty=fixture(1);simplifyReportNotes(empty.doc);
  assert.equal(empty.fold.querySelector('.routine-data-limits'),null);
  assert.match(empty.fold.textContent,/暂无额外来源说明；不代表缺失数据已经核实/);
  assert.equal(empty.fold.querySelector('.concise-report-notes').querySelector('ul').children.length,2);
});

test('separate exception contexts retain document order; nested details open only in the visible copy',()=>{
  const f=fixture(),first=add(f.doc,f.body,'section','','notes-section');
  add(f.doc,first,'h3','2026-09-08 08:30 HKT；USD，IB 账户范围。');
  const original=add(f.doc,first,'details');add(f.doc,original,'summary','原始限制');
  add(f.doc,original,'p','读取失败：来源 A；不可假设同名来源 B 也失败。');
  const second=add(f.doc,f.body,'section','','notes-section');
  add(f.doc,second,'h3','2026-09-08 08:31 HKT；CAD，三账户范围。');
  add(f.doc,second,'ul').append(add(f.doc,f.doc,'li','数据冲突：来源 B，不含已核实来源 A。'));
  simplifyReportNotes(f.doc);
  const alert=f.section.querySelector('.routine-material-exceptions');
  assert.ok(alert.textContent.indexOf('读取失败：来源 A')<alert.textContent.indexOf('数据冲突：来源 B'));
  assert.equal(alert.querySelector('details').open,true);assert.equal(original.open,false);
  assert.ok(f.fold.querySelector('.routine-data-limits').contains(first));
});

test('empty inert source records and ordinary decision controls remain original nodes',()=>{
  const f=fixture(4),record=add(f.doc,f.fold,'template');record.id='preserved-receipt-template';
  const decision=add(f.doc,f.section,'details','','dcard');decision.setAttribute('data-decision-id','outside-notes');
  const control=add(f.doc,decision,'button','回应待办'),original=snapshot(decision);
  simplifyReportNotes(f.doc);
  assert.equal(f.doc.getElementById('preserved-receipt-template'),record);
  assert.ok(f.fold.contains(record));assert.equal(snapshot(decision),original);assert.equal(control.parentElement,decision);
});
