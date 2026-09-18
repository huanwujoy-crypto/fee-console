# MSTR 标准 T2：所有者分类批准记录（2026-09-18）

## 生效条件（尚未生效）

本记录是**提案**，不是已完成的批准。只有仓库所有者在本维护 PR 上以本人
GitHub 账号发出与当时 head SHA 完全一致的 `/approve-xuan-ib-maintenance <head sha>`
评论，并在 `.github/workflows/xuan-ib-policy-lock.yml` 通过后合并，本规则才随
trusted main 生效。在此之前 `claude/xuan-ib-ai-risk-tiers-v1.json` 中的
`REG-SPECIAL-MSTR-T2` 不得被引用为已生效分类，也不得据此发布任何报告数字。
任何新 commit 自动作废先前批准评论。本文件的写入、合并本身都不等于批准，也不
更新或验证实际 Claude Routine。

## 决定内容

所有者于 2026-09-18 在复核「风险」页签的 AI 压力敞口计算时明确指示：
**MSTR 归 T2**。这是所有者本人的分类选择，不是 Codex 的委托分类，也不是
自动分类。

采用的是已在 §0-C 登记表中记录、所有者已复核的标准 T2 阶梯
（低／中／高 40%／55%／70%），不新增任何系数、不新增 tier、不改动其他证券。

身份取自 2026-09-17 PM 已发布页面清单 `xuan-ib-ai-tier-records-v1` 自 2026-09-11
PM 起每期一致发布的身份字段，只抄录身份，未将任何金额、股数或市值写入仓库：

- `symbol` `MSTR`
- `custodian` `IB-HK`
- `portfolioId` `936247`
- `holdingId` `26863964`
- `instrumentId` `34421`（Sharesight）
- `currency` `USD`

机器规则以具名特例 `REG-SPECIAL-MSTR-T2`（kind `named-tier-exception`，
tier `T2`）写在 `claude/xuan-ib-ai-risk-tiers-v1.json`，唯一受支持的读取者仍是
`scripts/xuan-ib-ai-risk-registry.mjs`，按 (custodian, instrumentId) 优先解析。
之所以放在登记表而不是 `claude/xuan-ib-ai-tier-overrides-v1.json` 或
`claude/xuan-ib-classification-delegation-v1.json`：前者按现行合同只承载 MRVL
一条规则；后者的读取器 `calculateDelegatedTier` 只允许 T1 白名单，为 MSTR 扩展
白名单会顺带扩大未来委托分类的权限，超出本次决定范围。

## 历史与取代关系

- 2026-09-11 早间版及之前：MSTR 发布为「不进分子（全部计入分母）：判不适用」，
  与 GLD／SLV／HODL 并列为主题投资。
- 2026-09-11 晚间版至 2026-09-17：覆盖模块首次运行时上一期页面无清单，
  MSTR 被视为首次出现的普通股，自动分类为 T1（80%）并逐期续期。
- 自本规则生效后的下一期正常 PM 报告起：按 T2（中情景 55%）计入分子，页面披露
  「上一期页面的自动分类记录 … 自本期起由已批准规则 REG-SPECIAL-MSTR-T2 取代，
  按 T2 计算」。历史页面不改写。

## 边界

这是内部压力情景计量，不是跌幅预测、AI 收入占比或交易建议。本记录：

- 不修改 MRVL／AAOI／VST／BE 既有规则、原始回执或历史排除依据；
- 不修改 TSEM／IREN／METU 特例、ETF 穿透权重、三账户含现金分母、
  20%／25%／30% 阈值线、GOOG 账户口径、四桶或现金规划；
- 不新增 `awaiting_user` 事项，不铸造用户回执，不改变账户范围；
- 不授权任何账户写入、下单、改单、撤单或转账；
- 不构成任何一次 AM／PM 定时运行成功的证据，也不给予补日期、放宽发布门禁或
  替换较新报告的权限。

## 落实

落实证据通过独立维护 PR 追加到进度账本；报告候选不得写入账本。只有线上新配对
已回读、并通过金额与原回执验证后，才可把本规则记为已核验；规则已保存本身不是
发布成功。
