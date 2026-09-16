import { buildMinimalReport } from './xuan-ib-minimal-report.mjs';
import { isWeeklyMode } from './xuan-ib-weekly-snapshot.mjs';
import { createSleepPriorityDelivery } from './xuan-ib-sleep-priority.mjs';
import { validateReportView } from './xuan-ib-report-view.mjs';
import { unwrapSource } from './xuan-ib-source-adapter.mjs';

const fail = code => { throw new Error(`Sleep priority report: ${code}`); };

export function buildSleepPriorityReport(input, options = {}) {
  if (!isWeeklyMode(input)) fail('WEEKLY_MODE_REQUIRED');
  const prepared = buildMinimalReport(input, options);
  const priorityReadyAt = new Date(options.now ?? Date.now()).toISOString();
  const orderCount = unwrapSource('orders', input.ib.orders.raw).orders.length;
  const delivery = createSleepPriorityDelivery({
    dataDate: input.dataDate, runId: options.runId, runStartedAt: options.runStartedAt,
    priorityReadyAt, previousSourceSha: input.previousSourceSha,
  });
  const view = {
    ...prepared.view,
    delivery,
    marketContext: '完整报告更新中',
    alerts: [{ level: 'warning', text: '睡前速览：持仓与挂单已更新；完整睡前版仍在生成。' }],
    summary: [
      `持仓 ${prepared.view.holdings.rows.length} 行已更新。`,
      `挂单 ${orderCount} 张已更新。`,
      '风险、配置与 ETF 随完整睡前版更新；本页不算睡前版完成。',
    ],
    kpis: [
      { label: '持仓数量', value: prepared.view.holdings.rows.length, format: 'number',
        asOfHkt: prepared.view.holdings.asOfHkt, note: 'IB 持仓直读。' },
      { label: '持仓市值', value: prepared.view.holdings.authoritativeValueUsd, format: 'usd',
        asOfHkt: prepared.view.holdings.asOfHkt, note: 'IB 余额表 BASE 汇总。' },
      { label: '挂单数量', value: orderCount, format: 'number',
        asOfHkt: prepared.view.rotation.asOfHkt, note: 'IB 挂单端点直读。' },
    ],
    risk: [{ ...prepared.view.risk[0], title: '风险 · 完整版更新中',
      lines: ['风险指标尚未完成；不沿用旧数值。'], brief: { state: 'unavailable', takeaway: '随完整睡前版更新', action: 'verify' } }],
    allocation: [{ ...prepared.view.allocation[0], title: '配置 · 完整版更新中',
      lines: ['配置与补仓金额尚未完成；不沿用旧数值。'], brief: { state: 'unavailable', takeaway: '随完整睡前版更新', action: 'verify' } }],
    notes: [
      `睡前速览：${prepared.view.asOfHkt}，仅优先显示持仓与挂单。`,
      '完整睡前版仍会继续生成；速览不满足睡前任务完成条件。',
      '只读：不下单、撤单、改单或转账。',
    ],
  };
  validateReportView(view);
  return { ...prepared, view };
}
