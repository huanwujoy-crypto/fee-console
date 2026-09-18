# §0-C 系数登记表 — 标的身份绑定与三条错分记录的修正（2026-09-18）

## 这份文件是什么

对 `claude/xuan-ib-ai-risk-tiers-v1.json`、其唯一读取器
`scripts/xuan-ib-ai-risk-registry.mjs`、覆盖模块
`scripts/xuan-ib-ai-tier-coverage.mjs`、自动分类器
`scripts/xuan-ib-auto-classification.mjs`、系数解析器与发布门禁的一次维护修正，
外加一项所有者分类决定（MSTR 归 T2，见
`claude/xuan-ib-mstr-t2-approval-2026-09-18.md`）。
修正本身是**测量与披露**层面的修复：不新增 tier，不修改任何已批准系数，不扩大
账户范围，不引入任何交易权限，也不构成任何 AM／PM 运行成功的证据。MSTR 的 T2
采用已有标准阶梯，同样不新增系数。

## 生效条件

**本文件与随附改动在仓库所有者就本 PR 的确切 head SHA 发表批准评论、且该 PR
合并之前不生效。** 在此之前它只是一份已复核的提案。合并后的下一期正常 PM 报告
自动按修正后的规则计算，并在页面上按记录逐条披露系数从何而来、改成什么。
2026-09-11 晚间版至 2026-09-17 的已发布页面属历史，**不改写**。

## 发现了什么（2026-09-18 所有者复核「风险」页签时提出）

已发布的 2026-09-17 PM 页面把 IB-HK 的 BRK/B 记为 T1（80%），贡献 $187,128，
而登记表记录的是 T3（0% / 5% / 10%）；2026-09-11 早间版发布的也是
「IB-HK BRK.B T3 · 5.00% · $11,408」。逐仓算术本身没有错（分子 176,799,440 美分
与页面一致），错的是分类输入。三条记录同源：

| 账户 · 标的 | 已发布（09-11 PM 至 09-17） | 已批准／已发布口径 | 成因 |
|---|---|---|---|
| IB-HK BRK/B | AUTO T1 80% · $187,128 | 登记表 T3 5% · $11,696 | 登记表按 09-11 早间版转录为 `BRK.B`（IB 拼写）；Sharesight IB-HK 账本对同一标的拼作 `BRK/B`。按 (custodian, symbol) 查找落空。 |
| IB-HK MSTR | AUTO T1 80% · $80,533 | 09-10 / 09-11 早间版：「不进分子（全部计入分母）：MSTR 判不适用」；所有者 2026-09-18 决定归 T2 | 登记表转录时只收录有系数的行，MSTR 无系数因而缺席。 |
| Webull ORCL | AUTO T1 80% · $80,170 | 同一标的（instrumentId 516542）在 IB-HK 为登记表 T2 55% | 登记表按账户记录，Webull 无 ORCL 条目；AUTO 政策只检查 WU／DELEG，不检查 REG。 |

三者都发生在 2026-09-11 晚间版——覆盖模块的首次运行。它的上一期页面（09-11 早间
版）没有 `xuan-ib-ai-tier-records-v1` 清单，`publishedRiskUniverse` 返回 `absent`，
于是**每一只持仓都被视为首次出现**（`firstSeen: true`）。查不到规则、资产类型为
STK 的持仓便满足 AUTO 政策全部条件，被赋予 T1；之后每期从上一页读回 AUTO 记录
续期，不再重新查注册表。门禁只重算「逐仓贡献 × 系数 = 合计」，41 行全部自洽，
故未拦截。

另一处只影响披露不影响数字：HODL、GLD、SGOV、SLV、TLT、VGIT、VGSH 被排除的原因
写成 `not-first-seen-position`；实际原因是非普通股。分类器先检查 firstSeen 再检查
资产类型，报出的是第一个失败项。

## 改了什么

1. **登记表绑定 instrumentId。** 每条股票、ETF 穿透与具名特例条目记录其 Sharesight
   `instrumentId`（取自 2026-09-17 PM 页面清单，与 09-11 PM 起每期发布的值一致）。
   读取器按 (custodian, instrumentId) 优先解析，其次 (custodian, symbol)，第三是
   其他账户对同一 instrumentId 记录的规则（原规则原样返回，并以 `matchedBy` /
   `via` 标明）。同一 instrumentId 在不同账户记录了不同阶梯时读取器整体拒绝
   （`INSTRUMENT_RULE_CONFLICT`），不按文件顺序取舍。按 symbol 命中但 instrumentId
   与条目不符的持仓按既有规则以 `owner-rule-identity-mismatch` 具名排除，不套用系数。
2. **MSTR 归 T2**：所有者 2026-09-18 决定，具名特例 `REG-SPECIAL-MSTR-T2`
   （kind `named-tier-exception`，标准 T2 阶梯 40% / 55% / 70%），批准记录
   `claude/xuan-ib-mstr-t2-approval-2026-09-18.md`。它取代此前发布的「不适用」与
   自动分类 T1。放在登记表而非覆盖文件或委托文件的理由见该记录。
3. **覆盖模块**在 AUTO 续期之前先查登记表（原有顺序不变），登记表命中即取代上一期
   的 AUTO 记录，并在页面披露「上一期页面的自动分类记录 … 自本期起由已批准规则 …
   取代」；跨账户按 instrumentId 命中时披露沿用了哪个账户的规则。不产生新的
   `awaiting_user`、不铸造 WU／DELEG 回执、不重复通知。
4. **自动分类器**先判资产类型再判 firstSeen，排除原因如实报为
   `asset-type-not-ordinary-stock`。
5. **系数解析器与门禁**按同样的 instrumentId 优先规则解析 REG 记录，并校验规则记录
   的身份字段；一条站在已登记标的上的 AUTO 记录（无论拼写、无论账户）被拒绝为
   `AUTO_SHADOWS_REGISTRY_RULE`。

## 对 2026-09-17 页面的回放（仅供核对，不是新报告）

用 09-17 PM 页面自身的 41 项持仓、市值与三账户分母回放修正后的规则：

| | 分子 | 中情景占比 |
|---|---|---|
| 已发布 | $1,767,994.40 | 27.32% |
| 修正后（BRK/B T3、MSTR T2、Webull ORCL T2） | $1,542,342.20 | 23.83% |

覆盖变为 32 / 41：9 项非普通股按 `asset-type-not-ordinary-stock` 排除；不再有
AUTO 分类记录。此回放不发布，不改写历史页面，不构成任何运行证据。

## 不变的部分

三档阶梯、每一条已转录的系数、ETF 穿透比例、METU／TSEM／IREN 特例、WU／DELEG 规则、
AUTO 政策的 T1 系数与「首次出现」定义、`(portfolioId, holdingId)` 键、分母口径、
所有阈值、决定与回执历史、金融只读边界。
