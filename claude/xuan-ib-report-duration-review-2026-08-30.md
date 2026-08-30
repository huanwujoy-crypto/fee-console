# XUAN-IB 简报耗时审计与提速建议（2026-08-30）

## 直接结论

- 已实测的两次临时报告，从用户启动到 GitHub Pages 发布完成分别为 **8 分 28 秒**和 **12 分 59 秒**；当前典型值可表述为约 **8–13 分钟**。
- 主要瓶颈不在 GitHub 发布链。Claude 取数、对账、计算、写入长 HTML 及生成候选提交占总时间约 **84%–89%**；Validate → Promote → Pages 约 **1 分 15 秒–1 分 25 秒**。
- 单纯把页面内容折叠只能让手机更易读，**不会明显减少生成时间**。真正提速必须减少串行取数、重复计算和每次重写不变长文。
- 不降低准确性的合理工程目标是 **5–8 分钟**；这是待加入逐工具时间戳后验证的目标，不是已经实现的 SLA。

## 事实（Facts）

| 样本 | 启动 HKT | 候选 commit HKT | Validate | Promote + Pages | 端到端 |
|---|---:|---:|---:|---:|---:|
| 08-29 第一次临时版 | 20:33 | 20:40:09 | 10 秒 | 约 1 分 09 秒 | 8 分 28 秒 |
| 08-29 第二次临时版 | 21:39 | 21:50:34 | 11 秒 | 约 1 分 14 秒 | 12 分 59 秒 |
| UI-only 对照（无金融取数） | — | 21:55:16 | 7 秒 | 约 1 分 10 秒 | candidate → Pages 1 分 17 秒 |

证据：

- 第一次：[candidate `06f47fe`](https://github.com/huanwujoy-crypto/fee-console/commit/06f47fe314db3ca3e9183e3613c2a4887b0527de) · [Validate](https://github.com/huanwujoy-crypto/fee-console/actions/runs/33253086785) · [Promote](https://github.com/huanwujoy-crypto/fee-console/actions/runs/33253095372) · [Pages](https://github.com/huanwujoy-crypto/fee-console/actions/runs/33253113309)
- 第二次：[candidate `6573957`](https://github.com/huanwujoy-crypto/fee-console/commit/657395731bc29a83a2fda693c71cbc4f493e8f23) · [Validate](https://github.com/huanwujoy-crypto/fee-console/actions/runs/33256048481) · [Promote](https://github.com/huanwujoy-crypto/fee-console/actions/runs/33256056012) · [Pages](https://github.com/huanwujoy-crypto/fee-console/actions/runs/33256068457)
- UI-only：[candidate `c3f949d`](https://github.com/huanwujoy-crypto/fee-console/commit/c3f949de2d51e59d0c223f941cc10eef925bc128) · [Validate](https://github.com/huanwujoy-crypto/fee-console/actions/runs/33256245353) · [Promote](https://github.com/huanwujoy-crypto/fee-console/actions/runs/33256250456) · [Pages](https://github.com/huanwujoy-crypto/fee-console/actions/runs/33256265315)

手机 loader 在「临时报告正在生成」状态每 15 秒检查一次，所以 Pages 发布后通常再等 **0–15 秒**即会自动显示。

## 假设与可观测性缺口（Assumptions / open questions）

- 第二次报告内明确记录取数约 5 分钟；其余约 6 分钟主要是跨源对账、重复计算、说明文字、约 55 KB HTML、guard、commit 与 push。因现有日志没有逐工具时间戳，这一拆分属于估计。
- 第一次 HTML 内的取数区间与 commit 时间存在约 1 分钟矛盾，因此只使用用户启动时间与 GitHub 官方时间作为端到端实测。
- 下一步需为 IB、Sharesight、mapping / Drive、计算、render、guard / push 各段写入 `startedAt / endedAt / durationMs / cacheHit`，才能准确验证节省来自哪一段。

## 主要耗时功能（Analysis）

1. **跨源只读取数**：IB account summary / balances / positions / orders / trades，加 7 个 Sharesight portfolio 当时值，以及 mapping / 存档读取。目前很多步骤可能串行。
2. **跨源对账与重算**：IB NAV / 现金 / 持仓与 Sharesight 交叉核对；AI 压力逐票 + ETF 穿透；四桶 / 流动性；挂单 / 成交；待决定项判断。
3. **长文与 HTML 重新生成**：即使数据零变动，Claude 仍可能重写运行说明、口径、已结案项与长页脚；这既耗时，也增加抄数和版式漂移风险。
4. **安全发布链**：guard、Validate、Promote、Pages 及线上 meta/blob 读回。这段是必要成本，且实测只占约 11%–16%，不是首要优化目标。

## 不降低准确性的提速方案

1. **并行取数**：IB 五项同源只读接口并发；Sharesight 7 个 portfolio 受限并发 3–4 个，遵守 rate limit。目标节省约 1–3 分钟。
2. **基于 hash 的变更检测**：mapping、ETF 权重、已结案、日历等静态层先验 hash；未变时复用上一版已验证计算，并在存档中记录证据。目标节省约 1–2 分钟。
3. **Deterministic renderer**：数表、编号、折叠结构、对账值由可测试脚本生成；Claude 只写三行摘要、真实异常与真正待决定项。目标节省约 2–4 分钟，并降低手工抄数风险。
4. **只写 delta**：不变的口径、免责、已结案和重复说明不再重写；手机只显示最新 5 项，完整机器证据留在 Git / 存档。
5. **手机优先交付**：核心 KPI、三行摘要、异常与真实待决项先渲染；存档性长说明由同一份结构化数据在后台补全，不再阻塞手机发布。

## 不得为提速删除的项目（Risks / guardrails）

- IB 核心五项只读读取；
- 7 个 Sharesight portfolio 当时值及关键对账；
- 关键指标重算，或有完整 hash / as-of 证据的受控复用；
- 数据源失败的 fail-closed 与降级披露；
- guard、Validate → Promote → Pages 及线上 meta/blob 读回。

若为了快而移除上述项目，手机可能更早看到页面，但无法证明该页的数据新鲜、计算正确或正是受信任的最新版。
