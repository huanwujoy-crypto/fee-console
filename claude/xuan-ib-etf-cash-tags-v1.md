# ABC 现金事件标签 v1（ABC1）— v2.3 草案，未激活

状态：**草案，纯模块，未接入生产路径。** 本文与 `scripts/xuan-ib-abc-cash-tags.mjs`
只定义语法与解析规则；睡前版生产器仍沿用 NOAH 现金输入、IB 流水账与待 CALL 账本。接入按下方
"接入计划"完成；发布仍按现有精确 PR + head SHA 批准程序。业主可在符合
`xuan-ib/session-approval-v1.md` 的 Claude 会话中批准，由代理代操作，不必手工贴评论。
本文不是批准，也不扩大任何金融或发布权限。

目的：让 Sharesight 现金账户流水自带机器可读标签，使 ABC 比较能不依赖业主逐笔申报
就分辨"池子边界上的资金事件"与"池内收益"，同时对任何不能确证的情况只把 ABC 置为
待补，不阻断持仓、挂单与整份报告。

## 1. 适用范围

- 目标账户范围：IB CASH（USD，IB-HK）、IB CAD CASH（CAD，IB-HK）、NOAH-HK
  （USD）。接入时必须从已核验的清单匹配 portfolio、cash account id 与币种；
  本草案不修改当前 instruments 文件，不表示两个 IB 现金账户已成为生产输入。
  其它账户的行不读；账户币种与原始行币种冲突时待补。
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
- 整组标签 ≤ 120 字符；description 总长及 UTF-8 字节数均 ≤ 255（保守本地
  校验；服务端边界未全测）。字符串标签必须恰好是一个合法 ABC 标签，不能夹带正文。
- 标签只是**说明元数据**：不改该行金额、日期、类型、`foreign_identifier`；不为加标签
  新建或冲销任何现金行。补标 = 按 transaction id 做 description-only 更新。
- 原说明完整保留在标签之后；超限报 `description-too-long`，计划不写入，
  由代理处理技术待补，绝不截断、挪用其它字段或制造额外现金行。
  这是同步端计划错误，不是已存在现金行的 `PENDING_REASONS`；未标行仍按
  `untagged-cash-event` 处理。两类错误必须分别保留，不能静默吞掉。
- `ev` 与写入去重键分开：`foreign_identifier` 仍是每行自己的（IB 为 account +
  transactionID 的稳定哈希；缺失者的去重回退比较完整 description，因此更不能 create）。
- 一行已有相同标签：幂等，不动；已有不同标签或残缺标签：拒绝，不覆盖。

## 3. 各 KIND 的语义（解析器的行为，非生产器）

| KIND | 含义 | 解析结果 |
|---|---|---|
| `EXT` | 与池子外部之间的钱：HSBC、UBS、房贷、基金赎回、**NOAH 私募分配与资本返还**（池外资产进入现金池，是边界流入，不是收益，不看说明里的 DIV / RETURN 字样） | 池子外部流量，金额与符号取自该行 |
| `XFER` | IB-HK 与 NOAH-HK 现金互转 | 必须两腿都有各自的源行、同 `ev`、一正一负、USD 金额相等、分属两个托管方、过账日相差 ≤ 7 天。满足时两腿记为 `internal-transfer`，**不进入 B/C 的模拟现金流**；两腿异日时，先出后进的差额记为池子的在途资产（`inTransitOn`），先进后出记为负在途，保证 A 不双算。只有一腿：待补，**不推断在途资产** |
| `CALL` | 从 NOAH-HK 现金缴私募 CALL 款 | 只做核验，不自动减待 CALL 水平：`commit:` 必须唯一命中承诺、承诺日 ≤ 缴款日、剩余额度 ≥ 金额、`fund:`（若写）与承诺一致，**且**待 CALL 账本同日有同额下调。承诺不命中为 `call-unmatched`；账本尚无下调为 `call-level-pending`。承诺日不晚于基线日时，本版因缺少已核验期初剩余额度而报 `call-opening-balance-pending`，不得重新使用原承诺全额。承诺引用和账本关联由代理依据凭据处理，仅无凭据的新承诺才问用户 |
| `ADJ` | 已证明的账务更正 | IB 侧忽略（IB 官方 NAV 从未包含记账行）；NOAH 侧待补 `adjustment-pending`，不按金额大小自动吸收；代理先追溯原始证据，只有无法从记录确定的事实才问用户 |
| `FX` | 同一托管方内部换汇（IB CAD ↔ USD） | 不是池子事件，忽略；出现在 NOAH-HK 上待补 |
| `INKIND` | 实物转仓按估值记的抵消行 | 视同 `EXT` |

待补原因枚举（`PENDING_REASONS`）：`malformed-tag` `untagged-cash-event`
`tag-on-return-row` `unknown-row-type` `usd-equivalent-pending` `transfer-unpaired`
`transfer-mismatch` `call-unmatched` `call-level-pending` `adjustment-pending`
`fx-on-pool-account` `duplicate-event-ref` `usd-on-usd-account` `currency-mismatch`
`call-opening-balance-pending`。同一个 `ev` 跨不同 KIND 使用也属重复事件。
每个待补落在该行过账日；生产器接入后
只把 ABC 的 `flowsComplete` 置 false、比较停在该日并具名，报告其它部分不受影响。

## 4. 与业主流水账的去重

`reconcileWithLedger(flows, ledger.flows)` 返回 `{ kept, superseded, pending }`。
仅相同且唯一的显式 `ev`，并且过账日、带符号 USD 金额与 kind 家族都一致，
才把 IB-HK 账本条目标为 `superseded`。仅同日同额不能证明相同事件：无 `ev`
的候选保留并报 `manual-event-ref-pending`；同 `ev` 的数量或经济字段冲突报
`manual-event-ref-conflict`；两个不同显式 `ev` 保持为两笔事件。
生产接入必须把这些 `pending`（含源行及账本日期）传播到 ABC 暂停比较，不能
只取 `kept` 后把可疑重复算两遍。NOAH 侧行不碰 IB 账本。

## 5. 同步端接口（供 Codex）

```js
import { formatAbcTag, tagDescription, planDescriptionUpdate, parseAbcTag }
  from './scripts/xuan-ib-abc-cash-tags.mjs';

formatAbcTag({ kind: 'EXT', ev: 'SYNTHETIC-0001' });
// → '[ABC1 EXT ev:SYNTHETIC-0001]'
formatAbcTag({ kind: 'CALL', ev: 'CALL-DEMO-001', commit: 'COMMIT-DEMO-1', fund: 'DEMOFUND' });
formatAbcTag({ kind: 'EXT', ev: 'IB-CAD-DEMO-001', usd: 100.00 }); // 合成的非 USD 示例

planDescriptionUpdate(row, { kind: 'XFER', ev: 'X-20260921-IB-NHK' });
// → { transactionId: row.id, description: '[ABC1 XFER ev:…] <完整原说明>',
//     changed: true, mode: 'description-only' }
```

`row` 是 Sharesight `cash_account_transactions` 的原始元素。`planDescriptionUpdate`
只产出更新计划（id + 新 description），不写任何东西；同步端 dry-run 先跑一遍，再按
transaction id 做 description-only 更新。`parseAbcTag(description)` 可用于同步端
自检：返回 null（无标签）、标签对象，或抛错（残缺）。

建议 `ev` 命名（同步端决定，解析器不解释其内容）：
`<账户前缀>-<YYYYMMDD>-<来源交易号或序号>`；XFER 两腿用同一个，例如
`X-20260921-IB-NHK-001`。事件引用不包含金额、账户号码或个人名称。

## 6. 接入计划（代理操作，按现有规则集中提交版本批准）

| 步骤 | 内容 | 状态 |
|---|---|---|
| A | 本文 + `scripts/xuan-ib-abc-cash-tags.mjs` + 测试。纯模块，无接入，无金融计算激活 | 本 PR |
| B | 同步端（Codex）：仅在正常已授权同步范围内生成 dry-run 标签计划，按 portfolio/account/id 精确定位；执行前快照复核、description-only 更新、执行后回读，保持行数、金额、日期、类型、去重键不变。历史补标不批量默认执行；技术异常由代理处理 | 本地离线计划与回读校验工具已准备，尚无真实写入 |
| C | 交叉测试：公开仓库只用完全合成的值、标识和说明，字段结构与真实接口一致；真实原始响应只留本地受控核验，不上传仓库 | 双方 |
| D | 生产器接入 `xuan-ib-etf-daily.mjs`：新增 `--ib-cash FILE`（IB CASH 与 IB CAD CASH 的清单与交易原始响应）；NOAH 与 IB 现金行统一经本模块分类；`resolveCashEvents` 的 `flows` 替代 NOAH 自动认定与 IB 申报（流水账经 §4 去重后作兜底）；`inTransitOn` 计入池子；`simulationFlows` 供 B/C；待补原因写入 `flowsComplete=false` 的具名停算。待 CALL 账本增加 `commitments`（id 唯一、fund、usd、date）；`levelChanges` 由账本相邻水平差导出 | 待 C 通过后另开 PR |
| E | 模拟器 `xuan-ib-etf-trend.mjs`：`internal-transfer` 不计入 B/C 现金流（当前实现把所有 kind 求和，是 v2.2 申报模式的语义）；连同 D 的端到端 A/B/C 数值防双算测试 | 与 D 同 PR 或紧随 |
| F | 睡前版运行说明（`claude/xuan-ib-current-runbook.md`、`claude/xuan-ib-etf-trend-v2.md` v2.3 节）：多读 IB CASH / IB CAD CASH 两个账户的清单与交易；代理更新 Routine 并回读，保持日程、模型、通知及原有任务不变，不要求业主手工编辑 | D 合并后 |

在 D/E 合并并完成真实数据回读验收之前：生产输入仍沿用当前 NOAH 自动现金流、
IB 手工流水账及待 CALL 账本，不能宣称已经完全免申报。日常说明标记、对账、
技术待补与 Routine 配置由代理负责；只对记录中没有的新承诺或必要版本批准询问用户。

## 7. 不做的事

- 不凭单腿推断在途资产；不凭基金名挑承诺；不按阈值吞掉 ADJ；不用 NAV/TWR 反推
  流量替代标签；不改发布锁；不写任何金融系统；不新建或冲销现金行来配合标签。
