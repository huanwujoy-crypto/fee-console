import {preopenActionSlot} from './xuan-ib-report-schedule.mjs';
import {validateAssociationReceiptShape} from './xuan-ib-account-association.mjs';
export const STATUS_REASONS=Object.freeze(['SOURCE_ADAPTER_NOT_CONFIGURED','TARGET_SESSION_NOT_COVERED','SOURCE_CONFLICT','SOURCE_READ_FAILED']);
const keys=['schemaVersion','status','dataDate','asOfHkt','sourceDate','slotId','attempt','reasonCodes','association','expiresAt','previousDataDate','previousReportSha','previousSourceSha'];
const fail=()=>{throw new Error('PREOPEN_STATUS_INVALID');};
const day=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v+'T00:00:00Z'))&&new Date(v+'T00:00:00Z').toISOString().slice(0,10)===v;
export function validatePreopenStatus(model){
 if(!model||Object.getPrototypeOf(model)!==Object.prototype||Object.keys(model).sort().join('|')!==keys.slice().sort().join('|')||model.schemaVersion!==6||model.status!=='data-not-ready'
 ||!day(model.dataDate)||!day(model.sourceDate)||model.sourceDate>=model.dataDate||!day(model.previousDataDate)||model.previousDataDate>model.dataDate
 ||model.slotId!==preopenActionSlot(model.dataDate).slotId||!Number.isInteger(model.attempt)||model.attempt<0||model.attempt>2
 ||!Array.isArray(model.reasonCodes)||!model.reasonCodes.length||model.reasonCodes.length>4||new Set(model.reasonCodes).size!==model.reasonCodes.length||model.reasonCodes.some(r=>!STATUS_REASONS.includes(r))
 ||!(typeof model.asOfHkt==='string'&&model.asOfHkt.startsWith(model.dataDate+' ')&&/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} HKT$/.test(model.asOfHkt))||!Number.isFinite(Date.parse(model.expiresAt))||!/^[a-f0-9]{40}$/.test(model.previousReportSha||'')||!/^[a-f0-9]{40}$/.test(model.previousSourceSha||''))fail();
 const time=Date.parse(model.asOfHkt.replace(' HKT','')+'+08:00'),slot=preopenActionSlot(model.dataDate);
 if(!Number.isFinite(time)||time<slot.startEpoch*1000||time>=slot.endEpoch*1000||Math.min(2,Math.floor((time-slot.startEpoch*1000)/600000))!==model.attempt)fail();
 validateAssociationReceiptShape(model.association,{edition:'am',previousSourceSha:model.previousSourceSha});return model;
}
export function renderPreopenStatus(model){
 validatePreopenStatus(model);const marker=Buffer.from(JSON.stringify(model)).toString('base64url');
 const reasons={SOURCE_ADAPTER_NOT_CONFIGURED:'来源覆盖适配尚未完成',TARGET_SESSION_NOT_COVERED:'目标交易日覆盖尚未核实',SOURCE_CONFLICT:'来源存在冲突',SOURCE_READ_FAILED:'来源读取未完成'};
 const expiry=new Date(Date.parse(model.expiresAt)+28800000).toISOString().slice(0,16).replace('T',' ');
 return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>XUAN · 本轮状态</title><!-- xuan-ib-night-action-v1:${marker} --><style>body{font:16px/1.6 -apple-system,BlinkMacSystemFont,sans-serif;margin:0;background:#f6f7f8;color:#17191c}main{max-width:640px;margin:auto;padding:28px 18px}section{padding:24px;background:white;border:1px solid #e4e6e8;border-radius:18px}h1{font-size:25px}p{margin:14px 0}.muted{color:#6c727a}a{color:#1769aa}</style></head><body><main><header><h1>XUAN · 本轮状态</h1><p>${model.dataDate} · ${model.asOfHkt}</p></header><section><h1>数据未齐 · 暂无行动建议</h1><p>本轮状态：${model.asOfHkt}</p><p>${model.reasonCodes.map(r=>reasons[r]).join('；')}。不提供补仓金额或买卖建议。</p><p class="muted">核对目标交易日：${model.sourceDate}；状态更新时间不代表上游资料已完整。此次未发布新的行动报告，也不把旧报告改为今日。</p><p>上一份报告原日期：${model.previousDataDate} · <a href="https://github.com/huanwujoy-crypto/fee-console/blob/${model.previousReportSha}/xuan-ib/index.html">查看原报告</a></p><details><summary>报告说明</summary><p>账户关联：所有者确认至 ${expiry} HKT；接口未返回账户编号，非身份认证。</p><p>此页只发布来源核验状态，未宣称账户同步或账务最终性。未齐原因通过受保护的候选校验、签名与发布流程确认；未通过公开读回前仍视为未完成。来源齐备前不沿用旧金额。</p></details></section></main></body></html>`;
}
