// Owner-requested archived display. No network or fresh financial reads.
// Generated through maintenance; never a candidate and never a latest-pair replacement.
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {renderReport,reportHtmlBlob} from './xuan-ib-report-view.mjs';
import {validateOpenEtfTrend,renderEtfTrend} from './xuan-ib-etf-trend.mjs';
const repo=fileURLToPath(new URL('../',import.meta.url));
export function buildSaturdayArchive() {
const read=(file)=>execFileSync('git',['show',`65c846fb342a9fd14285979ab0fd37424a19e3ff:${file}`],{cwd:repo,encoding:'utf8'});
const source=read('xuan-ib/latest.html'),meta=JSON.parse(read('xuan-ib/latest.meta.json'));
assert.equal(reportHtmlBlob(source),meta.htmlBlob);
assert.equal(meta.htmlBlob,'eec28a0694dcebdb3ca7790b592ceee38a0e4fa2');
assert.match(source,/2026-09-05 周六 · 早间版/);
const plain=s=>s.replace(/<[^>]+>/g,'').replaceAll('&gt;','>').replaceAll('&lt;','<').replaceAll('&amp;','&').replaceAll('&nbsp;',' ').trim();
const num=s=>{const v=Number(plain(s).replace(/C\$|[$,%]/g,''));assert.ok(Number.isFinite(v),s);return v;};
const cells=tr=>[...tr.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map(m=>m[1]);
const part=(a,b)=>{const i=source.indexOf(a),j=source.indexOf(b,i+a.length);assert.ok(i>=0&&j>i);return source.slice(i,j);};
const stamp='2026-09-05 07:47–08:10 HKT';
const holdSection=part('<div class="pane p1">','<div class="pane p2">');
const rows=[...holdSection.matchAll(/<tr><td><span class="sym">([\s\S]*?)<\/tr>/g)].map(m=>{
  const c=cells('<tr><td><span class="sym">'+m[1]+'</tr>');assert.equal(c.length,5);
  const symbol=c[0].match(/class="sym">([^<]+)/)[1];
  const info=plain(c[0].match(/class="sub">([\s\S]*?)<\/span>/)[1]);
  const [market,qty]=info.split(' · ');
  const clock=plain(c[3]).match(/^(\d\d-\d\d) (\d\d:\d\d):\d\d$/);assert.ok(clock);
  return {symbol,market,quantity:Number(qty.match(/^[\d,]+/)[0].replaceAll(',','')),price:num(c[1]),priceCurrency:/C\$/.test(c[1])?'CAD':'USD',marketValueUsd:num(c[4]),changePct:num(c[2]),changeAsOfHkt:`2026-${clock[1]} ${clock[2]} HKT`,quoteStatus:/延迟/.test(info)?'delayed':'ok'};
});
assert.equal(rows.length,26);assert.equal(new Set(rows.map(r=>r.symbol)).size,26);
const orderPart=part('<thead><tr><th>挂单</th>','<details><summary>迁移池成本对照');
const orders=[...orderPart.matchAll(/<tr><td>([\s\S]*?)<\/tr>/g)].map(m=>{
 const c=cells('<tr><td>'+m[1]+'</tr>');assert.equal(c.length,4);
 const id=plain(c[0].match(/class="sym">([^<]+)/)[1]).match(/^(\S+) (买|卖) (\d+)$/);assert.ok(id);
 const holding=rows.find(r=>r.symbol===id[1]);assert.ok(holding);
 const detail=plain(c[3]);return {symbol:id[1],side:id[2]==='买'?'buy':'sell',quantity:Number(id[3]),limitPrice:num(c[1]),marketPrice:holding.price,currency:holding.priceCurrency,marketAsOfHkt:stamp,ageDays:Number(detail.match(/^\d+/)[0]),status:detail.replace(/^\d+ 天 · /,''),cancelReview:/待撤/.test(plain(c[0]+c[3]))};
});
assert.equal(orders.length,9);assert.equal(orders.filter(o=>o.cancelReview).length,4);
const cashPlan=JSON.parse(Buffer.from(source.match(/<!-- xuan-ib-cash-plan-v1:([A-Za-z0-9_-]+) /)[1],'base64url').toString());
const decisionState=JSON.parse(source.match(/<template id="xuan-ib-decision-state-v1" type="application\/json">([\s\S]*?)<\/template>/)[1]);
const card=(title,takeaway,state,action,columns,values,lines=[],asOfHkt=stamp)=>({title,asOfHkt,brief:{state,takeaway,action},columns,rows:values,lines});
// Summary figures are transcribed, not recomputed from an inconsistent legacy prose paragraph.
for(const figure of ['$5,057,944','$754,755','$4,420,972','21.76%','4.25%','17.75%','51.74%','263,254','6,198,032'])assert.ok(source.includes(figure),figure);
const view={schemaVersion:1,edition:'am',dataDate:meta.dataDate,asOfHkt:stamp,marketContext:'历史重排 · 对应 09-04 收盘及延长交易',
 alerts:[{level:'warning',text:'历史版 · 09-05 上午数据，非今日行情。待办及回执也是当时快照；后续回应请看最新版。这里只读，不提交回应。'},{level:'warning',text:'四桶仍是 08-24 快照；新布局不表示数据问题已解决。'}],
 summary:['持仓与挂单数量未变，原报告记录无新增成交。','现金补仓参考以 EXUS、EIMI 为主，USSC 占预算 10%。','待决定 1 项；4 张旧买单仅提醒人工复核，不自动撤单。'],
 kpis:[{label:'IB NAV',value:5057944,format:'usd',asOfHkt:stamp,note:'周六原报告数值；非今日估值'},
 {label:'可用现金',value:754755,format:'usd',asOfHkt:stamp,note:'已扣预留款 240,000 美元'},
 {label:'AI 中情景压力',value:21.76,format:'percent',asOfHkt:stamp,note:'提醒区间；情景测算不是预测'}],
 holdings:{status:'ok',asOfHkt:stamp,authoritativeValueUsd:4420972,note:'原报告权威持仓总值；逐仓展示合计存在约 259 美元差异，保留不凑平。延迟报价保留各自日期，旧日期不会冒充本日实时涨跌。',rows},
 risk:[card('① AI 压力','中情景 21.76%；留意未分类 AAOI','attention','owner-review',['项目','原报告读数'],[['中情景','21.76%'],['AAOI','尚无批准 tier，不进分子'],['低 / 高情景','旧基数近似，不作本期精确值']],['压力系数不是 AI 相关度；详细原始方法保留在原报告中。']),
 card('② 单票集中度','GOOG 三账户合并 4.25%','normal','observe',['范围','占比'],[['GOOG / GOOGL 三账户','4.25%'],['性质','观察口径，不触发交易']],['原报告分子 263,254 美元；分母（三账户含现金）6,198,032 美元。原显示行值有舍入，不用显示行重加合计。','IB 执行视图与三账户观察视图分开，原阈值不修改。'])],
 allocation:[card('③ 四桶快照','08-24 旧快照，仍待完整核验','unverified','verify',['类别','快照占比'],[['高流动性','17.75%'],['VC / PE','51.74%'],['对冲基金','14.58%'],['常青基金','15.93%']],['沿用旧日期，不能据此认定当前全量分类已完成。'],'2026-08-24')],
 rotation:{...card('换仓触发检查','原报告未触发；4 张买单待人工复核','attention','owner-review',[],[],['9 张挂单：买入在前、卖出在后，组内按绝对距市价由近到远。','本历史重排用原持仓表价格重新计算距离，舍入可能与旧表略有差异。','待撤标记仅沿用原报告，不根据距离新增撤单建议。']),orders},
 events:card('日程','只看历史数据；日程以正式页为准','unverified','observe',['版本','固定启动'],[['上午版','周二至周六 08:00 HKT'],['睡前版','周一至周五，纽约 09:30']],['本页仅重排历史数据，不代表新的定时任务或 20 分钟交付验收。']),
 decisions:decisionState.decisions.map(d=>({decisionId:d.decisionId,asOfHkt:stamp,fact:'沿用周六原报告的事实与意见；本次仅重排显示，没有新回应；历史状态不代表今日进度。',isNew:false})),
 observations:['原报告记载：IB、Schwab、Webull 无新增成交。'],
 notes:['来源：已发布的周六上午版，数据读取窗口 2026-09-05 07:47–08:10 HKT；本次未读取金融接口。','仅展示层重排。持仓、挂单数量、金额与意见回执取自该历史报告；本页为上线的历史重排，不替代最新报告或证明新运行成功。','折叠下方原报告全文可逐项对照。原文旧日程仅为历史证据。原发布 source SHA：521e0aa5570b00a8a0029535c3558dad8ec7e33c；HTML blob：eec28a0694dcebdb3ca7790b592ceee38a0e4fa2。'],cashPlan};
let html=renderReport(view,{previousHtml:source,previousMeta:meta,policy:JSON.parse(fs.readFileSync(repo+'claude/xuan-ib-policy-v2.json','utf8'))});
// Same promoted archive anchor contains the already approved public summary.
// Freeze it at build time; no network, new baseline, raw inputs or newer values.
const trend=validateOpenEtfTrend(JSON.parse(read('xuan-ib/etf-trend.json')));
assert.equal(trend.startDate,'2026-09-01');assert.equal(trend.latestCompleteDate,'2026-09-03');
html=html.replace(/<div class="pane p5">([\s\S]*?)<\/div><\/div>\n/,(_,body)=>`<div class="pane p5">${renderEtfTrend(trend)}<details><summary>原方案与历史基线记录</summary>${body}</details></div></div>\n`);
assert.ok(html.includes(source.match(/<template id="xuan-ib-decision-state-v1"[\s\S]*?<\/template>/)[0]));
const escape=s=>s.replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;').replaceAll('>','&gt;');
html=html.replace('<!-- xuan-ib-handover:v1 -->','<!-- xuan-ib-historical-layout:20260905 -->').replace('<title>XUAN-投资管理</title>','<title>周六上午版 · 历史重排</title>');
html=html.replace('<body>','<body><header class="history-header"><strong>XUAN-投资管理</strong><a href="../">返回最新版</a><small>周六上午版 · 2026-09-05 历史数据</small></header>');
html=html.replace('</style>', '.history-header{padding:16px;background:#eef5fc;color:#174773;display:flex;flex-wrap:wrap;gap:12px;justify-content:space-between;align-items:center}.history-header small{flex-basis:100%;font-size:13px}.history-header a{color:#174773;min-height:44px;display:flex;align-items:center}.num{font-variant-numeric:tabular-nums;white-space:nowrap}.big.num{font-size:clamp(22px,5.8vw,36px)}.tabs .tabbar{top:0}.history-original{margin:14px}.history-original iframe{width:100%;height:75vh;border:0}@media(prefers-color-scheme:dark){.history-header{background:#10253d;color:#a6c9ee}.history-header a{color:#a6c9ee}} </style>');
html=html.replace('</body>',()=>`<details class="history-original"><summary>原报告全文 · 未改动的历史对照</summary><iframe title="原周六上午版" sandbox="" srcdoc="${escape(source)}" style="width:100%;height:75vh;border:0"></iframe></details></body>`);
assert.doesNotMatch(html,/<!-- xuan-ib-handover:v1 -->/);
assert.doesNotMatch(html,/<script|shortcuts:\/\//i);
assert.ok(html.includes('class="history-header"'));
assert.doesNotMatch(html, /未发布至正式手机页|仅本地历史预览|不是正式发布版本/);
return {html,audit:{kind:'historical-layout-only',dataDate:meta.dataDate,sourceCommit:'65c846fb342a9fd14285979ab0fd37424a19e3ff',sourceSha:meta.sourceSha,sourceBlob:meta.htmlBlob,holdings:rows.length,orders:orders.length,receipts:decisionState.receipts.length,newFinancialReads:0}};
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
 const {html,audit}=buildSaturdayArchive();
 const out=repo+'xuan-ib/history/2026-09-05-am.html';
 if(process.argv.includes('--write')) {fs.mkdirSync(repo+'xuan-ib/history',{recursive:true});fs.writeFileSync(out,html);}
 else if(process.argv.includes('--check')) assert.equal(fs.readFileSync(out,'utf8'),html,'archive must match deterministic source-bound renderer');
 else throw Error('Use --write or --check');
 process.stdout.write(JSON.stringify(audit)+'\n');
}
