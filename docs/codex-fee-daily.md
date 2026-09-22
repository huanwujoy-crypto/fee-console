# Codex 每日基金更新（不依赖 Claude）

本流程只负责「投资管理费」的每日 AUM、费用和投资人份额回执。
`xuan-ib/` 是另一条发布链，不能与此处的 `data.json` 候选合并。

## 数据与权限

- 纽约前一交易日为目标日。先以固定 Sharesight Native `direct` 只读客户端实时解析
  `Schwab-HK` 与 `Webull` 的 portfolio ID，再读取相同目标日的 performance、
  holdings、cash accounts、cash transactions 和最近交易；不能用截图或 Webull
  即时总资产替代目标日 Sharesight 值。连续两次读取同日快照并比较来源身份、日期、
  总额、持仓、现金和流水，只有稳定时继续。
- `docs/daily-data-contract.md`、`docs/fee-style-registry.md`、
  `docs/fee-economic-source.md` 和 `docs/fee-calculation-receipt.md` 是计算合同。
  `scripts/daily.mjs` 仍是唯一的 `data.json` writer；投资人份额、管理费和 Carry
  只由该 writer 与同一份 v4 私密经济账本生成，不能由调度提示词重算。
- `FEE_DATA_KEY`、`FEE_ECON_GIST_ID`、专用只读
  `FEE_ECON_GITHUB_TOKEN` 只在受控 Codex 运行环境中提供；不得放进仓库、
  GitHub Actions、参数、日志或聊天。原 Claude 环境中的凭据不会自动转移。
  凭据未完成独立配置及实际读回验收时，此流程**未激活**，不能发布候选。
- 若目标日尚无完整 SPY/QQQ 同日收盘资料，按合同只发布可独立验证的 AUM，
  留下 benchmark pending，随后同日 replacement。不能用较早价格假装当日价格。

## 每日顺序

1. 读取 `main`、现有健康回执及私密来源，确认目标日期、允许的回补窗口和无并发候选。
   先核对基金 Gist 的 owner、secret 可见性、文件名、两次相同 revision/ETag/密文；
   只能使用 `scripts/fee-economic-source.mjs` 的固定来源读取路径。
2. 在仓库外的私密临时目录准备来源快照和 `FEE_STYLE_INPUT_FILE`，用真实持仓身份
   运行 `scripts/daily.mjs --style-preflight`。新持仓按原登记规则取证并独立复核；
   证据不足则停在待复核，不猜风格。
3. 确认最近现金流水中的内部交易、外部本金和投资人归属。已确认的 Jenny Z
   新增本金只能沿用私密账本中的对应确认，不得再记为 XiXi Z 或重复发行份额。
4. 在同一稳定来源和私密账本下运行 `scripts/daily.mjs`。随后用
   `scripts/fee-receipt-report.mjs` 验证费用回执，并用
   `scripts/fee-data-health.mjs create-success` 生成不含金额的运行回执。
   立即重查私密来源仍为原 revision/ETag/密文；任一失败均不得提交。
5. 只从当时最新的 `main` 创建一个分支
   `codex/fee-daily-YYYYMMDD-xxxxxx`，其中日期无连字符且必须与
   `daily YYYY-MM-DD` 的提交标题及健康回执目标日一致。提交仅允许
   `data.json`（真正变化时）与 `fee-data-health.json`；无变化时只提交健康回执。
   GitHub 必须把提交标为 verified，author 为 `huanwujoy-crypto`；本地未签名
   commit 不能作为生产候选。
6. `validate-fee-data` 验证候选；受保护的 `promote-fee-data` 从默认分支
   再验证并推广，Codex 不持有推广用 deploy key。推广后回读 `main` 的
   `data.json` hash、健康回执、Pages 页面数据日期，以及 Jenny Z／XiXi Z
   份额和市值。仅提交、校验开始或 Pages 构建开始均不算完成。

## 失败处理

- 只读来源、私密账本、密钥、风格分类、资金流、费用回执或推广回读有缺口时，
  保留原数据，报告具体闸门和最后已验证日期；不造数、不直接改 `main`、不把
  管理人链接中的密钥提取到脚本，也不借用 Claude 的凭据或提交身份。
- 运行回执可区分 `updated`、验证后的 `no-op` 和未运行。GitHub watchdog
  继续在香港时间生产窗口之后检查主分支，当天没有合格回执就标红。
- 启用 Codex 调度前，先完成一次真实目标日的只读源稳定检查、私密来源和
  费用回执验收、候选验证、推广与 Pages 回读。Mac 关机或本地凭据不可用时，
  本地 Codex 调度不能承诺无人值守完成；这类情况必须明确报告为未更新。
