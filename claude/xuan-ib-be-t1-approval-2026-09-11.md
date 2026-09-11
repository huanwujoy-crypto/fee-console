# BE 标准 T1：委托分类拟批准记录（2026-09-11）

## 生效条件（尚未生效）

本记录是**提案**，不是已完成的批准。只有仓库所有者在本维护 PR 上以
本人 GitHub 账号发出与当时 head SHA 完全一致的
`/approve-xuan-ib-maintenance <head sha>` 评论，并在 `.github/workflows/
xuan-ib-policy-lock.yml` 通过后合并，本规则才随 trusted main 生效。
在此之前 `claude/xuan-ib-classification-delegation-v1.json` 中的
`DELEG-20260911-BE-T1` 不得被引用为已生效分类，也不得据此发布任何报告
数字。任何新 commit 自动作废先前批准评论。本文件的写入、合并本身都不
等于批准，也不更新或验证实际 Claude Routine。

## 现行规则内容

2026-09-11 早间版运行中出现一只此前未见的持仓 BE（Bloom Energy Corp），
在既有 `WU` / `DELEG` 规则中没有任何对应记录。当期 AI 压力指标因此把它
排除在分子之外，同时仍保留在分母内，构成对已披露风险的系统性低估。这是
一次技术缺口，不是新的用户待决定事项，Codex 为唯一责任人。

按 `claude/xuan-ib-routine-closeout-20260906.md` 的既有委托，例行、有证据
支持的分类在既有系数下由 Codex 实施并核验。本次采用已在白名单内的标准
T1（低／中／高 60%／80%／100%），不新增任何系数、不新增 tier、不改动
其他证券。批准编号 `DELEG-20260911-BE-T1`。

身份取自 2026-09-11 早间版本轮的私有原始读数（Webull 组合的 Sharesight
原始响应与 IB 持仓原始响应），只抄录身份字段，未将任何金额、股数或市值
写入仓库：

- `symbol` `BE`
- `custodian` `Webull`
- `venue` `NYSE`
- `instrumentName` `Bloom Energy Corp - Ordinary Shares - Class A`
- `portfolioId` `1350094`
- `holdingId` `29037698`
- `instrumentId` `1893267`
- `currency` `USD`

机器规则写在 `claude/xuan-ib-classification-delegation-v1.json`，唯一受支持的
读取者仍是 `scripts/xuan-ib-delegated-tier.mjs` 的 `calculateDelegatedTier`。
身份必须逐字段完全一致：同名股票在其他券商、其他组合或其他 instrument ID
下不适用本规则，近似匹配一律拒绝并记入技术记录。`notifyId` 为每条规则一个
稳定身份 `classification:1350094:29037698:DELEG-20260911-BE-T1`，用于登记
送达对象，其本身既不是消息也不是送达证明，只通知一次。

## 边界

这是内部压力情景计量，不是跌幅预测、AI 收入占比或交易建议。本记录：

- 不修改 MRVL／AAOI／VST 既有规则、原始回执或历史排除依据；
- 不修改 TSEM／IREN 特例、ETF 穿透权重、三账户含现金分母、
  20%／25%／30% 阈值线、GOOG 账户口径、四桶或现金规划；
- 不新增 `awaiting_user` 事项，不铸造用户回执，不改变账户范围；
- 不授权任何账户写入、下单、改单、撤单或转账；
- 不构成任何一次 AM／PM 定时运行成功的证据，也不给予补日期、
  放宽发布门禁或替换较新报告的权限。

## 与自动分类（AUTO）的关系

本次 BE 是一次性的、已核验身份的委托分类，命名空间为 `DELEG`。它与
`claude/xuan-ib-auto-classification-v1.json` 描述的首见普通股自动分类
（命名空间 `AUTO`）是两套独立记录：AUTO 适用于尚无任何 `WU`／`DELEG`
规则的首见普通股，一旦存在本规则，BE 即由本规则覆盖，AUTO 不再适用，
也不得为同一身份另行生成 AUTO 记录。

## 落实

落实证据通过独立维护 PR 追加到进度账本；报告候选不得写入账本。只有线上
新配对已回读、并通过金额与原回执验证后，才可把本规则记为已核验；规则
已保存本身不是发布成功。
