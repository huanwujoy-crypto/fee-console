# 每日数据契约（data.json 写入规则）

`scripts/daily.mjs` 是唯一写 `data.json` 的代码。本文件是它的行为契约；
`scripts/daily.test.mjs` 对下面每一条都有对应的自动测试。

## 0. 这个台账是干什么的

**长期观察管理人的投资能力。** 不是记账软件，也没有结算流程。

- **每日看趋势** —— 工作日允许一家券商比另一家晚一天同步。这是常态，不是错误：
  照常写入当天的点，标记为 `prov`（暂估），趋势线照常走。
- **周末自动校准** —— 两家都落定后，例行任务用**同一个估值日**回看重写最近几天，
  加 `--calibrated` 清掉暂估标记。长期业绩以及与 SPY / QQQ 的对比
  **优先采用这些校准过的快照**，保证组合与基准取自同一天。
- **历史月份自动归档** —— 月份结束后自然成为历史月份。**没有结算按钮，
  没有确认步骤，不需要任何用户操作。**

## 1. 目标日与估值日

- `--date` 是目标日，按 `America/New_York` 日历判定（香港时间 8/20 上午
  对应纽约 8/19，目标日应为 `2026-08-19`）。
- `--src-schwab` / `--src-webull` 是每个账户实际取数的估值日。
  - 与 `--date` 一致 → 干净的点。
  - 落后 1–3 天 → **照常写入并标 `prov`**，在 `status.notes` 里说明落后几天。
  - 落后超过 3 天或早于目标日 → 明显不对，阻断。
- `--src-bench` 是基准价的日期；与 `--date` 不一致同样只标暂估。
- `--spy` / `--qqq` 是当日**原始收盘价**（美股收盘，口径 §9.2），`--spyd` / `--qqqd`
  是当日**除息金额**，绝大多数日子为 `0`（为 0 时不落字段）。
  **不要传 Yahoo 的 `adjclose`**：它每逢除息回溯改写全部历史值，而这里每天只写一次
  且永不重述，两者不兼容，混用会静默丢掉每一次股息。含息由页面按
  `r = (P + D) / P_prev − 1` 自己链式得出。
  `--spyd` 必须与同日的 `--spy` 一同给出，否则阻断。
  `--spy` 与 `--qqq` 必须成对出现，并同时给出 `--src-bench`。重跑同一日期时，
  如果一次响应没有股息事件，脚本会保留先前已核实的 `spyd` / `qqqd`，不会静默擦除。
  迁移窗口内旧 Routine 仍可成对传入 `--cspx` / `--eqac`，避免部署瞬间中断；
  不得在同一次运行混用新旧两套字段。新 Routine 验证后即只传 SPY / QQQ。
- 目标日晚于纽约当日 → 阻断；早于纽约当日超过 `MAX_LOOKBACK_DAYS`（10 天）→ 阻断。
  这 10 天就是周末回看校准的活动范围。

### 来源快照与同日修订

- Routine 在完成 Sharesight 只读取数后，应传 `--source-fetched-at=<RFC 3339 时间>`。
  脚本会把该时间和一枚 SHA-256 `sourceFingerprint` 存进当天数据点。指纹涵盖账户总额、
  拆分、估值日、现金复核输入、基准与本次资金流水，便于辨认手机上显示的是哪一次来源快照。
- 如上游提供稳定的 revision/checksum，可同时传
  `--source-fingerprint=<64 位 SHA-256 hex>`；该参数必须与 `--source-fetched-at` 一起使用。
- 同一业务日重跑时，只要来源值或来源 revision 改变，脚本就按日期替换旧点；相同指纹的
  重读保持 byte-for-byte `no-op`，不会仅因抓取时间变晚而制造新密文或提交。
- 旧 Routine 可以省略这两个参数，历史加密格式仍为 v3。无来源参数的旧调用只有在数据点
  完全不变时才保留已有来源凭证；若它改写数值，旧凭证会被移除，避免把过期来源冒充为新数据。
- 来源凭证只能证明“哪次快照被写入”，不能自行触发重读。自动链路仍须按
  `Sharesight 同步 → 连续读回稳定 → daily.mjs 同日重跑 → 发布` 的顺序执行。
- 回看或修订历史日 D 时，整体 `status.asOf` 及费用回执仍绑定账本最新日 L；不能把
  D 日的校准、暂估原因或拆分误差覆盖到 L。writer 校验并保留 L 已有的有效状态，
  更新全账本未分类流水数量。L 状态缺失或不自洽时停止且不写，不从缺省 `prov`
  推断“已校准”，不降低回执的最新日期校验。同参重跑仍须字节级 no-op。

### v4.6 一次性回补

- 回补输入必须从同一次通过身份、交易时区、股息和 adjusted-close 交叉校验的
  `market-data-cache` 生成，不接受手抄、估算或混用 IBKR/Yahoo 的静态价表。
- `--dry-run` 必须先通过；实际写入必须指定一个尚不存在的 `--backup` 文件。
- 起算日前基准点以及范围内每个已有 daily 日期都必须同时具备 SPY 与 QQQ；任何缺失
  都以非零状态退出，不跳过、不猜测、不覆盖已有不同值。

## 2. 账户总额是权威值，拆分只用于复核

- `--schwab` / `--webull` = Sharesight 该估值日的 **portfolio total**，必填且 > 0。
  费用与收益率只用这两个值。
- `--cash` / `--stock` / `--other` = 复核拆分，**三项都必填**，允许为 `0`。
- `--growth` / `--value` = 可选的股票风格穿透拆分，必须成对传入；两者之和必须与
  `--stock` 相差不超过 $1。缺乏可靠持仓级映射时不要猜测，省略这两个字段，页面显示
  “股票（未拆分）”。例外：重跑已有日期且 stock 差额不超过 $1 时，writer 为防止
  误删已验证信息，会保留该日既有 growth/value；省略输入不代表本次重新核验了旧拆分。
  调用方若不能证明该保留值仍有效，应在修订前停止并报告，不手动删字段强行通过。
  新日期的可选风格缺口本身不否定已独立核实的 AUM。正式映射表为
  `claude/fee-style-mapping.json`；每次自动运行必须先
  读取它，以 portfolio + holding ID 为主键，ticker 只用于交叉核对。出现未知或重复映射时
  fail closed，不得靠名称猜测或沿用过期提示词。
- 页面把 `cash + other` 合并显示为“现金及其它”；这只改变展示，不改变账户总额、
  收益率或费用计算。
- 拆分与两账户之和的差额：
  - ≤ $1 → 正常。
  - > $1 但 ≤ 总额的 2% → **暂估**（写入，标 `prov`）。
  - > 总额的 2% → **金额不可能，阻断**。

## 3. 只阻断明显错账

| 类别 | 判定 | 结果 |
|---|---|---|
| **重复/陈旧现金** | 当日已结算的现金变动没有反映在账户余额里 | 阻断 |
| **内部交易误判外部资金流** | 记录带交易证据却被断言为 `external_transfer` | 阻断 |
| **账户缺失** | 少 `--schwab` 或 `--webull` | 阻断 |
| **金额不可能** | 总额 ≤ 0、非有限数、拆分差 > 2%、无外部资金却单日跳动 > 50% | 阻断 |

其余一切（券商延迟、拆分小差、基准日不同、暂时无法判定的资金变动）
**都不阻断**，只标暂估。

### 重复/陈旧现金的检查

2026-08-18 的真实故障：Webull 当天卖出 AAOI/GGLL、买入 SGOV 共三笔已结算，
但账户总额用的是交易前的现金余额，导致总资产虚高 11,502.10。

传入 `--acct-cash-<acct>` 与 `--prev-acct-cash-<acct>` 后，脚本校验
`本日余额 == 前日余额 + 当日已结算变动之和`（容差 $0.01），不符即阻断。
当天该账户有现金变动却没传这两个值时，同样阻断。

## 4. 出入金按证据分类，不看 Sharesight 的 type

Webull 走邮件导入的买卖会被 Sharesight 记成 `DEPOSIT` / `WITHDRAWAL`，
且 `trade_id` / `holding_id` 为 null。只看 type 会把内部买卖误判为外部出入金，
虚增当月收益并多提 Carry。

| 判定 | 结果 |
|---|---|
| `evidence: "internal_trade"` | 内部交易 |
| `evidence: "external_asset_transfer"`，且来源/目标 trade、目标 holding、数量变化与外部编号齐全 | **实物转仓 → 自动生效** |
| `evidence: "external_asset_transfer"` 但配对证据不全 | unresolved |
| `evidence: "external_transfer"` 但带交易证据 | **misfiled → 阻断** |
| `evidence: "external_transfer"` 且带 `externalRef` | 外部资金 |
| `evidence: "external_transfer"` 但无 `externalRef` | unresolved |
| 有 `tradeId` / `holdingId` | 内部交易 |
| `foreignIdentifier` 含 `-BUY-` / `-SELL-` | 内部交易 |
| type 是 `Buy Trade` / `Sell Trade` | 内部交易 |
| 描述含成交形态（`… 300 @ USD 140.99`） | 内部交易 |
| 同账户同日 `holdingDelta ≠ 0` | 内部交易 |
| 描述含 wire / ACH / external transfer | 外部资金 |
| 裸 `DEPOSIT` / `WITHDRAWAL`，无任何证据 | unresolved |

- 普通现金"外部资金"进入 `flowsAuto` 后仍然只是**候选**，需管理人在设置里确认。
- 唯一自动生效的例外是证据完整的**跨管理边界实物转仓**：组合外来源 trade 与组合内
  目标 trade 必须在证券、数量和市场日期上逐项相等，并同时提供两端 trade id、目标 holding id、
  非零持仓变化。它按目标账户的 `transaction_date` 和当日市场价值计入，
  不要求管理员手机或私密 Gist 再勾选。香港通知日只写入备注，不替代纽约市场日。
- unresolved 进入 `flowsUnresolved`，把当天标为暂估，**不阻断**。
- 证据后补时，同一条记录从 unresolved **提升**为候选，`id` 保持不变。

### 稳定 id 与幂等

普通现金记录继续使用
`id = sha256(date | acct | amount(2dp) | foreignIdentifier | desc)[0:16]`。

实物转仓不采信 Routine 传入的自由文本 `id`、`desc` 或 `externalRef`，而使用 Sharesight
不可变对象编号组成业务身份：

`businessKey = sharesight:<sourceTradeId>-><tradeId>;holding:<holdingId>`

`id = sha256("external_asset_transfer " + businessKey)[0:16]`。

同一 `businessKey` 重跑、改写备注或外部说明仍只保留一条；完整且不同的业务身份即使同日、
同账户、同金额也保留为两笔。若历史有效记录只有相同日/账户/金额而没有这些不可变编号，
脚本会阻断并保持文件字节不变，要求先人工核实并修复旧记录，不会静默合并或继续追加。
数据点、flow、status 全部无变化时脚本打印 `no-op <date>` 并以 0 退出，
**不改动文件字节**（IV 与 `updatedAt` 不变）。

### 2026-08-20 BRK/B 事故修复

`scripts/repair-brkb-20260820.mjs` 是事件专用、默认只读的历史修复工具。它只接受加密 v3
数据，并且必须精确看到四条同日、同账户、同金额、已生效但缺少 `businessKey` 的旧记录，
同时不能存在 canonical 或 unresolved 副本。只有显式 `--apply` 才把四条旧记录替换为一条
带完整 Sharesight source trade、target trade 与 holding 身份的记录；数量、身份、密钥或结构
任一不符都会拒绝写入并保持原文件字节不变。成功后再次执行为 byte-for-byte `no-op`。

## 5. status 块

```jsonc
"status": {
  "asOf": "2026-08-19",
  "calibrated": false,       // 周末同估值日重写过
  "provisional": true,       // 当天是暂估
  "splitDelta": 0,
  "unresolvedCount": 0,
  "notes": ["schwab: valued on 2026-08-18, 1 day(s) behind 2026-08-19"]
}
```

UI 读这个块决定是否给数字加"暂估"标签。`prov: 1` 也写在当天的数据点上，
校准重写后自动消失。

## 6. 安全约定（未改动）

- 密钥只从 `FEE_DATA_KEY` 环境变量读取；`--key` 参数一律拒绝。
- 只接受白名单参数与 `--calibrated` 一个标志，未知参数直接报错。
- 原子写回（临时文件 + fsync + rename）。
- stdout / stderr 只输出状态与计数，**不打印任何金额或密钥**。

## 7. 单一费用计算回执（calculation receipt）

管理费、Carry 和毛收益只允许由 `scripts/fee-receipt-core.mjs` 的确定性引擎计算一次。
手机页面、Claude Scheduled task 和任何只读简报都必须消费同一份
`feeCalculationReceipt`；不得各自重新套公式。

### 7.1 权威公式

- 每日管理费基数 = 当日两账户收盘总值 − 当日 EOD 外部出入金。
- 当月管理费 = `Σ(每日管理费基数) × 年费率 ÷ 365`。
- `feeBasisDayCount` 必须与该期间 `calendarDayCount` 完全相等；有一天缺失、重复，
  或任一天基数为负，均不得生成回执。
- Modified Dietz 只用于出资方收益率，**绝不是管理费分母**。
- Carry 使用同一引擎维护的累计毛 P&L 与 High-water mark；任何实物转仓必须先经过
  §4 的业务身份去重，恰好计入一次。

### 7.2 私密经济输入

`daily.mjs` 只从环境变量 `FEE_ECON_FILE` 指向的文件读取经济输入。该文件必须：

- 使用绝对路径，并位于 Git 仓库之外；
- 是手机私密 Gist `fee-console-db.json` 的原始 AES-256-GCM encrypted v4 envelope；
- 唯一旧版例外：原源为 v3 且通过 `docs/fee-econ-v3-copy.md` 的显式
  `fee-console.legacy-empty-expense.v1` 策略时，可使用保留全部原始字节的独立加密
  v4 计算副本。原 Gist 不升级、不回写，不使用页面宽松 `migrate()`。
- 在一次运行中连续读取两次且字节不变；
- 使用现有 `FEE_DATA_KEY` 在内存解密，绝不把明文、Gist id 或密钥写入仓库或日志。

Routine 必须先在远端连续读取同一个 Gist revision/ETag，并确认两次 encrypted content
逐字节相同，再把它交给脚本。本地文件的连续双读只防止使用过程中被替换，不能单独证明
远端 Gist 稳定。

旧版例外每次运行还须以 `FEE_ECON_V3_FILE` 提供本次远端已验证的原密文快照。
writer/reporter 会认证 provenance 内原封套、比对原 payload 准确字节、重跑严格策略
和完整投影/ID分区，并连续双读该原密文文件，输出前再次复核。缺源或不符拒绝输出。
来源身份、历史完整性与发布前远端 revision/ETag 回验仍须单独完成；人工附件不可长期
代替每次重读原源。空白 exp 不计入付款，也不等于现实中费用为零或从未付款。

原生 v4 维持回执 v1；窄兼容副本必须使用回执 v2，额外严格绑定 `legacySource`
的策略 ID、原 envelope/payload 各自准确字节 SHA-256，禁止 canonical 再序列化替代。
原字节与原记录仅在加密副本中，绑定仅在加密回执中，不进普通显示、日志或通知。
手机必须在迁移/赋值之前核验原 v3；无原源、源已变、策略不符时隐藏旧费用。

回执只保存输入 commitment（SHA-256 hash）和派生结果，不复制账户 opening、确认 flow、
备注、付款 id、姓名或原始 FX 表。付款日期、金额、币种及实际采用的 USD FX 会进入私密
输入 commitment，因为它们会改变 paid / due；早于费用起算日或晚于 `asOf` 的付款不属于
本期 statement，也不会抵扣应付费用；对外只输出合计 paid / due。Hash 不是独立
数字签名；可信边界仍是现有 AES-GCM envelope、受控 writer 与发布流程。完整 hash 不得进入
通知、普通简报、Pages metadata 或 release tag，只可显示缩短的 receipt id。

### 7.3 写入与失效规则

- 回执是 encrypted v3 payload 的可选顶层字段；外层格式仍为 v3，旧页面可继续读取。
- `daily.mjs` 先完成来源校验、flow reconciliation 和候选 daily point，再基于候选 payload
  生成回执，最后才原子写回。
- 每日数据未变、但费率、opening 或确认 flow 改变时，回执变化必须打破 `no-op` 并更新。
- 未提供私密经济输入时，只有原生 v1 且仍与 public input hash 匹配的旧回执可以保留；
  legacy v2 无本次来源必须移除，即使 AUM 未变。一旦 public input 不匹配，
  必须删除 stale receipt，不能显示旧数字。
- `flowsUnresolved` 非空时，已验证的原始 AUM 点仍可写入，但 stale receipt 必须删除且本次
  不生成新回执；费用、Carry、已付／应付和费用后收益一律不可显示。
- 已有 public ledger 的 `daily`、`flowsAuto`、`flowsUnresolved`，以及 private ledger 的
  `months`、`month.flows`、`fees` 如存在但不是数组，必须原样保留文件并拒绝运行；不得把坏
  shape 或数组内的空／非对象记录静默删除。已有 `status` 必须完整包含合法的 `asOf`、`provisional`、
  `calibrated`、`splitDelta`、`unresolvedCount` 和字符串 `notes` 数组；不得以新状态静默覆盖
  不完整或类型错误的旧状态。
- 同一 public/private 输入必须保持 byte-for-byte `no-op`。

### 7.4 只读消费规则

`scripts/fee-receipt-report.mjs` 是 Scheduled task 的只读出口。它只解密并验证回执，
绝不重新计算。它必须读取同一份仍然有效的 private snapshot，完成 public + private 双重
校验；在 `GITHUB_ACTIONS=true` 时于读取任何文件或 secret 前直接拒绝。回执缺失、hash
不匹配、版本未知或数据不完整时以非零状态退出，且不输出任何费用数字。此时任务可报告
原始 AUM/来源状态，但管理费、Carry、已付／应付及费用后收益必须显示“计算回执待更新”，
不得用 endpoint average、旧截图、memory 或人工 override 补数。

v1 回执覆盖费用、Carry、已付／应付以及组合自身的毛／净收益率；SPY、QQQ 等 benchmark
仍来自公开 daily ledger，暂不属于回执的单一计算源，不得把 v1 描述成覆盖页面全部数字。

v2 保留相同数学引擎与覆盖范围，仅增加旧版来源验证；未知版本或额外字段必须拒绝。
脚本和 index-only 两侧均完成审批部署后才允许真实 v2 验收，旧 consumer 拒绝 v2 与
新 consumer 严格取源匹配均须有实际合成执行测试。原 v3 的编辑保存禁令不变。
