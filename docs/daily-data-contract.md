# 每日数据契约（data.json 写入规则）

`scripts/daily.mjs` 是唯一写 `data.json` 的代码。本文件是它的行为契约；
`scripts/daily.test.mjs` 对下面每一条都有对应的自动测试。

## 0. 这个台账是干什么的

**长期观察管理人的投资能力。** 不是记账软件，也没有结算流程。

- **每日看趋势** —— 工作日允许一家券商比另一家晚一天同步。这是常态，不是错误：
  照常写入当天的点，标记为 `prov`（暂估），趋势线照常走。
- **周末自动校准** —— 两家都落定后，例行任务用**同一个估值日**回看重写最近几天，
  加 `--calibrated` 清掉暂估标记。长期业绩以及与 CSPX / EQAC 的对比
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
- 目标日晚于纽约当日 → 阻断；早于纽约当日超过 `MAX_LOOKBACK_DAYS`（10 天）→ 阻断。
  这 10 天就是周末回看校准的活动范围。

## 2. 账户总额是权威值，拆分只用于复核

- `--schwab` / `--webull` = Sharesight 该估值日的 **portfolio total**，必填且 > 0。
  费用与收益率只用这两个值。
- `--cash` / `--stock` / `--other` = 复核拆分，**三项都必填**，允许为 `0`。
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
  非零持仓变化及稳定外部编号。它按目标账户的 `transaction_date` 和当日市场价值计入，
  不要求管理员手机或私密 Gist 再勾选。香港通知日只写入备注，不替代纽约市场日。
- unresolved 进入 `flowsUnresolved`，把当天标为暂估，**不阻断**。
- 证据后补时，同一条记录从 unresolved **提升**为候选，`id` 保持不变。

### 稳定 id 与幂等

`id = sha256(date | acct | amount(2dp) | foreignIdentifier | desc)[0:16]`。
数据点、flow、status 全部无变化时脚本打印 `no-op <date>` 并以 0 退出，
**不改动文件字节**（IV 与 `updatedAt` 不变）。

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
