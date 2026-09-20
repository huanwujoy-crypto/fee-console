# ABC 现金事件标签 v1（ABC1）— v2.3 草案，未激活

状态：**草案，纯模块，未接入生产路径。** 本文与 `scripts/xuan-ib-abc-cash-tags.mjs`
只定义语法与解析规则；睡前版生产器仍只读业主流水账与待 CALL 账本。接入按下方
"接入计划"逐 PR 审批，每一步都需业主在 PR 上贴精确 head SHA 审批行；本文不是批准。

目的：让 Sharesight 现金账户流水自带机器可读标签，使 ABC 比较能不依赖业主逐笔申报
就分辨"池子边界上的资金事件"与"池内收益"，同时对任何不能确证的情况只把 ABC 置为
待补，不阻断持仓、挂单与整份报告。

## 1. 适用范围

- 账户：`claude/xuan-ib-etf-instruments-v1.json` 声明的池子现金账户：IB CASH
  （USD，IB-HK）、IB CAD CASH（CAD，IB-HK）、NOAH-HK（USD）。其它账户的行不读。
- 行类型：只有 `DEPOSIT` / `WITHDRAWAL` / `OPENING_BALANCE` 是"现金事件"，需要标签。
  `Buy Trade` / `Sell Trade` / `Payout` / `INTEREST_PAYMENT` / `FEE` /
  `FEE_REIMBURSEMENT` 是池内收益或成本，不加标签；加了就是错（待补）。
  不认识的类型待补。
- 时间窗：起点日（`claude/xuan-ib-etf-baseline-v2.json`，当前 2026-09-17）当天及
  之前的行不读；只处理起点之后、截止日之前的行。

## 2. 语法（最终）

description 中任意位置恰好一组方括号：

```
[ABC1 KIND ev:REF (usd:N.NN) (commit:REF) (fund:REF)]
```

| 字段 | 必填 | 取值 | 说明 |
|---|---|---|---|
| `ABC1` | 是 | 固定 | 规则版本；改语义时升版 |
| `KIND` | 是 | `EXT` `XFER` `CALL` `ADJ` `FX` `INKIND` | 见 §3 |
| `ev:` | 是 | `[A-Za-z0-9._-]{4,64}` | 事件引用。一个事件一个 `ev`；XFER 的两腿共用同一个 `ev`；其它 KIND 的 `ev` 在整个窗口内唯一，重复即两行都待补 |
| `usd:` | 条件 | `\d{1,13}\.\d{2}`，> 0 | 非 USD 账户上影响池子的事件（EXT / XFER / CALL / INKIND）必填；USD 账户不写；ADJ / FX 不得写 |
| `commit:` | CALL 必填 | 同 `ev` 字符集 | 所动用的待 CALL 承诺 id，须与账本中唯一一条承诺完全相等 |
| `fund:` | 可选，仅 CALL | 同 `ev` 字符集 | 基金标识，只作核对 |

规则：
- 方向永远取该行 `amount` 的正负，标签不写方向。
- 整组标签 ≤ 120 字符；description 总长 ≤ 255（Sharesight 本地校验上限，服务端边界
  未全测，同步端按 255 处理）。
- 标签只是**说明元数据**：不改该行金额、日期、类型、`foreign_identifier`；不为加标签
  新建或冲销任何现金行。补标 = 按 transaction id 做 description-only 更新。
- 原说明保留在标签之后；超长时截断原说明的尾部，永不截断标签。
- `ev` 与写入去重键分开：`foreign_identifier` 仍是每行自己的（IB 为 account +
  transactionID 的稳定哈希；缺失者的去重回退比较完整 description，因此更不能 create）。
- 一行已有相同标签：幂等，不动；已有不同标签或残缺标签：拒绝，不覆盖。

## 3. 各 KIND 的语义（解析器的行为，非生产器）

| KIND | 含义 | 解析结果 |
|---|---|---|
| `EXT` | 与池子外部之间的钱：HSBC、UBS、房贷、基金赎回、**NOAH 私募分配与资本返还**（池外资产进入现金池，是边界流入，不是收益，不看说明里的 DIV / RETURN 字样） | 池子外部流量，金额与符号取自该行 |
| `XFER` | IB-HK 与 NOAH-HK 现金互转 | 必须两腿都有各自的源行、同 `ev`、一正一负、USD 金额相等、分属两个托管方、过账日相差 ≤ 7 天。满足时两腿记为 `internal-transfer`，**不进入 B/C 的模拟现金流**；两腿异日时，先出后进的差额记为池子的在途资产（`inTransitOn`），先进后出记为负在途，保证 A 不双算。只有一腿：待补，**不推断在途资产** |
| `CALL` | 从 NOAH-HK 现金缴私募 CALL 款 | 只做核验，不自动减待 CALL 水平：`commit:` 必须唯一命中一条承诺、承诺日 ≤ 缴款日、剩余额度 ≥ 金额、`fund:`（若写）与承诺一致，**且**业主待 CALL 账本在同一天有同额下调；四者齐备才把该行记为池子流出（scope-in 由账本承担）。承诺不命中：待补 `call-unmatched`；账本尚无下调：待补 `call-level-pending` |
| `ADJ` | 已证明的账务更正 | IB 侧忽略（IB 官方 NAV 从未包含记账行）；NOAH 侧一律待补 `adjustment-pending`，不按金额大小自动吸收，语义由业主说明 |
| `FX` | 同一托管方内部换汇（IB CAD ↔ USD） | 不是池子事件，忽略；出现在 NOAH-HK 上待补 |
| `INKIND` | 实物转仓按估值记的抵消行 | 视同 `EXT` |

待补原因枚举（`PENDING_REASONS`）：`malformed-tag` `untagged-cash-event`
`tag-on-return-row` `unknown-row-type` `usd-equivalent-pending` `transfer-unpaired`
`transfer-mismatch` `call-unmatched` `call-level-pending` `adjustment-pending`
`fx-on-pool-account` `duplicate-event-ref`。每个待补落在该行过账日；生产器接入后
只把 ABC 的 `flowsComplete` 置 false、比较停在该日并具名，报告其它部分不受影响。

## 4. 与业主流水账的去重

`reconcileWithLedger(flows, ledger.flows)`：带标签的 IB-HK 行与流水账条目按
（过账日、带符号 USD 金额、kind 家族 external / transfer）一对一匹配，命中的账本条目
记为 `superseded`，其余保留为兜底。同日同额的两笔真实交易各自消耗一条账本条目；
NOAH 侧行不碰 IB 账本。

## 5. 同步端接口（供 Codex）

```js
import { formatAbcTag, tagDescription, planDescriptionUpdate, parseAbcTag }
  from './scripts/xuan-ib-abc-cash-tags.mjs';

formatAbcTag({ kind: 'EXT', ev: 'NHK-PN004779-20260916-124603-300000' });
// → '[ABC1 EXT ev:NHK-PN004779-20260916-124603-300000]'
formatAbcTag({ kind: 'CALL', ev: 'CALL-HL3-20261001', commit: 'COMMIT-HL3-1', fund: 'HIGHLAND3' });
formatAbcTag({ kind: 'EXT', ev: 'IB-CAD-20260919', usd: 241.78 }); // 非 USD 账户

planDescriptionUpdate(row, { kind: 'XFER', ev: 'X-20260921-IB-NHK' });
// → { transactionId: row.id, description: '[ABC1 XFER ev:…] <原说明截断至 255>',
//     changed: true, mode: 'description-only' }
```

`row` 是 Sharesight `cash_account_transactions` 的原始元素。`planDescriptionUpdate`
只产出更新计划（id + 新 description），不写任何东西；同步端 dry-run 先跑一遍，再按
transaction id 做 description-only 更新。`parseAbcTag(description)` 可用于同步端
自检：返回 null（无标签）、标签对象，或抛错（残缺）。

建议 `ev` 命名（同步端决定，解析器不解释其内容）：
`<账户前缀>-<YYYYMMDD>-<来源交易号或序号>`；XFER 两腿用同一个，例如
`X-20260921-IB-NHK-300000`。

## 6. 接入计划（逐 PR，均需业主精确 SHA 审批）

| 步骤 | 内容 | 状态 |
|---|---|---|
| A | 本文 + `scripts/xuan-ib-abc-cash-tags.mjs` + 测试。纯模块，无接入，无金融计算激活 | 本 PR |
| B | 同步端（Codex）：按 §5 对起点之后 IB CASH / IB CAD CASH / NOAH-HK 的现金事件行做 dry-run 标签计划，业主抽查后执行 description-only 更新；新行同步时直接带标签 | Codex，仓库外 |
| C | 交叉测试：用真实（脱敏）Sharesight 响应固定样本跑 `classifyCashRow` + `resolveCashEvents`，核对每一行的分类与待补原因；样本进仓库测试 | 双方，B 后 |
| D | 生产器接入 `xuan-ib-etf-daily.mjs`：新增 `--ib-cash FILE`（IB CASH 与 IB CAD CASH 的清单与交易原始响应）；NOAH 与 IB 现金行统一经本模块分类；`resolveCashEvents` 的 `flows` 替代 NOAH 自动认定与 IB 申报（流水账经 §4 去重后作兜底）；`inTransitOn` 计入池子；`simulationFlows` 供 B/C；待补原因写入 `flowsComplete=false` 的具名停算。待 CALL 账本增加 `commitments`（id 唯一、fund、usd、date）；`levelChanges` 由账本相邻水平差导出 | 待 C 通过后另开 PR |
| E | 模拟器 `xuan-ib-etf-trend.mjs`：`internal-transfer` 不计入 B/C 现金流（当前实现把所有 kind 求和，是 v2.2 申报模式的语义）；连同 D 的端到端 A/B/C 数值防双算测试 | 与 D 同 PR 或紧随 |
| F | 睡前版运行说明（`claude/xuan-ib-current-runbook.md`、`claude/xuan-ib-etf-trend-v2.md` v2.3 节）：多读 IB CASH / IB CAD CASH 两个账户的清单与交易；Routine 提示词由业主更新 | D 合并后 |

在 D 合并并由业主验证之前：业主流水账与待 CALL 账本仍是唯一生产输入，申报方式不变。

## 7. 不做的事

- 不凭单腿推断在途资产；不凭基金名挑承诺；不按阈值吞掉 ADJ；不用 NAV/TWR 反推
  流量替代标签；不改发布锁；不写任何金融系统；不新建或冲销现金行来配合标签。
