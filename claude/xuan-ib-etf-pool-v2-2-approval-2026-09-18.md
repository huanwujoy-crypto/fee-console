# ABC 比较合并现金池 v2.2 — 业主决定与批准记录（2026-09-18）

## 生效条件（尚未生效）

本记录是**提案**，不是已完成的批准。只有仓库所有者在本维护 PR 上以本人 GitHub
账号发出与当时 head SHA 完全一致的 `/approve-xuan-ib-maintenance <head sha>`
评论，并在 `.github/workflows/xuan-ib-policy-lock.yml` 通过后合并，本方法才随
trusted main 生效。任何新 commit 自动作废先前批准评论。合并本身不更新或验证
实际 Claude Routine：睡前版 Routine 的提示词需由业主另行加入两项新读取。

## 业主决定（2026-09-18，会话记录）

1. ABC 比较的财富范围改为 IB-HK 全部资产加 NOAH-HK 全部现金，再减去待 CALL 款，
   因为 NOAH-HK 现金扣除待 CALL 款后原则上用于二级市场补仓。
2. 待 CALL 款目前为 240,000 美元；如有变化业主通知。
3. NOAH-HK 现金以 Sharesight 现金账户余额为准。
4. 重新起算是合适的。
5. NOAH-HK 现金账户的进出按方案甲认定：以 Sharesight 交易记录为准自动认定，
   业主只申报 NOAH-HK 与 IB-HK 之间的划转和待 CALL 款变化。

## 落实方式

方法文本见 `claude/xuan-ib-etf-trend-v2.md` 的 2026-09-18 补充段。要点：

- 池子 = IB-HK 官方日终 NAV + NOAH-HK Sharesight 现金余额（账户 id 142903，
  组合 936238，美元）− 待 CALL 款水平。起点 2026-09-17 收盘不变，
  `poolVersion: 2`，`reserveUsd: 0`。
- B 全额投入同一池子，不再单独留存 24 万美元；C 全部 CSPX。
- 待 CALL 款账本 `claude/xuan-ib-etf-pending-calls-v1.json`：首条为 2026-09-17
  起 240,000 美元。水平变化按池子边界调整计入，不进收益曲线。
- 业主流水账 `claude/xuan-ib-etf-flows-v1.json` 只申报 IB-HK 一侧（外部出入金、
  与 NOAH-HK 的划转），NOAH-HK 现金进出由 Sharesight 记录自动认定。
- 生产脚本 `scripts/xuan-ib-etf-daily.mjs` 新增 `--noah-cash`、`--pending-calls`；
  计算器 `scripts/xuan-ib-etf-trend.mjs` 接受 `reserveUsd` 为 0 与
  `internal-transfer` 流量项，并按起点日期使用 v2.2 说明文字。
- 睡前版新增两项只读读取（现金账户清单、NOAH-HK 账户交易记录）；原始响应私有
  保存，指纹进 `sourceRef`。

## 边界

- 只读监控卡；不下单、不改单、不撤单、不转账，不写 IB、Sharesight 或任何金融账户。
- 不改 AI 压力口径、现金规划、四类配置、决定与回执、阈值、账户范围、日程、模型、
  连接器或通知设置。
- 不构成任何一次 AM／PM 定时运行成功的证据；曲线永远"数据至前一交易日"。
- 本记录中的 240,000 美元是业主申报的待 CALL 款水平，与现金规划已公开的"预留
  240,000"同一数字；本文件不含任何账户余额或持仓金额。

## 已知取舍

- 待 CALL 款是业主估计值；其变化以申报日计入池子边界，不回溯。
- Sharesight 现金记录与 IB 净值跳动落在不同日期时，两侧各按自己的日期计入，
  曲线仍剔除流量，余额短暂错位一天属于正常现象。
- 本模块不认识的现金交易类型会让比较停在该日并具名；扩展类型表属方法修改。
