# XUAN 来源适配可行性检查（2026-10-02，未上线）

此次检查有明确停止条件：只读查看已批准的本地证据、官方资料和源身份配置；
使用既有 source-check 执行一次 schema-only 诊断。凭据过期、身份不能核实或
需要新增权限时停止，不等待不存在的字段，不创建新的报表查询或云端服务。

## 已核实与未核实

| 项目 | 本轮证据 | 能证明什么 / 仍缺什么 |
| --- | --- | --- |
| 历史 XUAN ↔ Flex 账户 | 在本地内存比较固定 approved identifier 与历史 Trade Confirmation 预验收记录，结果相同，仅输出布尔值 | 证明历史映射；不证明当前独立 cloud OAuth 连接账户 |
| 当前 owner-attested policy | active，原有效期不变；没有账户 identifier/hash 字段 | 保留业主声明；尚无当前 cloud-client 与 Flex scope 的机器绑定 |
| 已存 cloud MCP raw | 摘要、持仓、挂单均无 account identifier；摘要/持仓无 upstream as-of/coverage，挂单只有订单自身时间 | 这些时间不能证明成交扫描或账务已最终齐全 |
| 当前 MCP tools schema | 获明确批准后，原 refresh 安全保存至原 secret；schema-only execution 成功取得34个工具 | 金融读取/写入均为零；schema 不证明当前账户身份或账务最终性 |
| 当前 Flex 内容 | 父线程只取得对象更新时间，未取得目标日内容 | 对象 update time 不能当 from/to-date coverage |
| 历史 Activity Trade / Trade Confirmation | Trades execution-level；交易日、结算日、ExecID/OrderID、币种、费用、净现金；Activity fromDate/toDate | 能校验已完成目标日成交；Trade Confirmation 空白/缺文件不能单独证明零成交 |
| 历史 Cash Activity | CashReport、CashTransactions、ConversionRates，fromDate/toDate/period/whenGenerated | 能证明声明交易日的现金账务范围；不能证明当前挂单或实时持仓 |
| OpenPositions / OpenOrders | 现有已验证 Flex sections 没有这两类证据 | 不假定不存在持仓或挂单，不把成交的 OrderID 当当前挂单 |

官方 [AI Integration 说明](https://www.interactivebrokers.com/en/trading/ai-integrations.php)
说明 MCP 可访问持仓、现金和历史交易。实际取得的工具 schema 已确认
`get_account_trades` 可用，但默认 `TODAY` 且日期边界使用 UTC。本 PR 已固定
`DAYS_7`，纽约目标交易日需按 `America/New_York` 过滤；空返回不能证明零成交。
`trade_id` 唯一不等于 ExecID 语义已核实，必须根据实际响应与账务内容验收。
实时 positions、orders、balances 的返回 schema 没有 account identifier 或
upstream as-of。`get_pa_performance_all_periods` 的 accounts/included_accounts
可尝试默认账户上下文机器绑定，只允许原 runtime 内比较后输出匹配/唯一布尔。

官方 [Open Positions Flex 字段](https://www.ibkrguides.com/reportingreference/reportguide/open%20positionsfq.htm)
包含 Account ID、Report Date、Conid、Quantity、Mark Price；它说明的是
报表日持仓和收盘价格。只有实际已启用并返回的完整该 section 才可使用，
不能把官方“可配置字段”当作当前 Query 已包含。
官方 [Cash Report 字段](https://www.ibkrguides.com/reportingreference/reportguide/cash%20reportfq.htm)
区分交易日 Ending Cash 与 Ending Settled Cash，不能混用两种口径。

## 一次真实 schema-only 诊断回证

- 既有 job：`xuan-preopen-source-check`，原身份/镜像/secret 引用不变。
- execution：`xuan-preopen-source-check-gs8b2`；实际运行
  `2026-10-02T01:38:53Z`–`01:38:59Z`，终态失败，固定码
  `DIAG_EXPIRED_NO_REFRESH`。原 runtime 读原 secret 后，过期检查即止，
  没有调用 MCP 金融工具，也没有刷新/新增凭据版本。
- job spec 规范化 SHA-256 前后均为
  `de789b98d4cdbd39bf3363a502636ae3575f18e993cdd1e6ac3339af35cbdc8d`。
  只用了 execution 临时 args override，不修改持久 job、服务、日程、IAM。
- 准备的 `schema_probe.mjs` 只允许初始化、协议通知与 tools/list；分页至多八页，
  重复 cursor、重复工具名或超预算失败。禁止任何 tools/call，过期不刷新。
  工具定义只作为元数据，不能自行证明账户正确、持仓全量或账务最终。
- 业务使用范围严格只读。`mcp.read` 是此客户端请求/校验的 scope 值；
  未通过服务端授权审计或写入尝试来证明 token 在所有接口上的权限。
  工具清单包含潜在变更工具，也不等于该 token 获准调用它们；本流程均不调用。

后续已获用户一次原机制续期批准：execution
`xuan-preopen-source-check-7fz5x` 于 `2026-10-02T01:57:49Z`–`01:57:57Z`
成功，原 secret 安全轮换一次（版本计数5→6），金融读取/写入0。
私有 schema 内容 SHA-256：
`959c48924337eca8af2c1331b4db6ee2f71e2b8e00a5960caafe0864823b4863`。
job spec 上述 SHA-256 前后相同，没有新 OAuth/IAM/secret 引用。

获准的默认上下文身份探针 execution `xuan-preopen-source-check-v7cdk`
于 `02:06:56Z` 启动时，短期访问 token 已不满足 freshness 余量，
以 `DIAG_EXPIRED_NO_REFRESH` 取数前停止。没有第二次轮换或 PA 金融调用。
当前身份尚未核实，不能部署。连续探针已准备：原 refresh→先安全保存→
身份唯一且匹配→同账户只读 sources；等待再次续期批准，不自动重试。
若生命周期或结构仍不支持，给出正式运行时生命周期适配方案，不反复拆分续期。

## 可实现的分级 data-quality 门槛

`source_readiness.mjs` 里的 raw.coverage/same-snapshot 合同是早期草案，
不能作为最终适配要求；不向真实 raw 补写不存在的字段，不永久盲跑。
实际适配应从真实 API contract / Flex 内容生成独立、可追溯的证据对象，
保留原 raw 和各自时间语义。各项状态分开报告，不使用一个 COMPLETE 替代。

| 层级 | 可实现的证据 | 用户报告 / 行动边界 |
| --- | --- | --- |
| 0：身份或关键内容未核实 | 当前 OAuth account 未绑定、目标日 Flex 内容缺失、页不完整或冲突 | “数据未齐”；不出补仓金额、买卖建议，不把旧报告改成今日 |
| 1：目标交易日覆盖 | 同一已核实账户的 Activity fromDate/toDate 覆盖目标已结束市场日；每笔执行唯一；现金逐币种和汇率口径明确，原内容/hash可读回 | 只能说“目标交易日成交/现金已覆盖”；不说当前挂单已核实、账务最终 |
| 2：本轮读取完整 | 经真实 schema/API contract 核实全量/分页结束、无截断；账户绑定；返回结构和唯一合约标识通过，起止时间/原响应哈希保留 | “本轮持仓/挂单读取完整”；来源不提供更新时间就明确“上游更新时间未提供”，不制造 as-of |
| 3：可用于行动规划 | 层级1+2，持仓/成交/现金交叉一致；当前买单剩余量与币种全量可用于预占，现金口径一致；Sharesight配置与实际IB变化无未解释差异；本轮来源与发布符合既有新鲜度 | 可给有明确资料日与限制的规划，仍非交易；不存在的原子 snapshot ID 不作为硬性永久要求 |
| 非关键缺项 | 历史涨跌、个别行情距离、观察基准未取得，且不会影响现金预占/资产分母或动作 | 省略对应项并说明，不阻塞已核实的独立部分 |

“读取完整”必须依实际源接口契约或全页回证，不依本地请求时间。
多个接口不是原子快照：记录各自时间，发现现金/持仓/成交冲突就禁行动。
Flex `whenGenerated` 是报表生成时间，`toDate` 是覆盖日期，读取时刻是交付
新鲜度；三者各用各的，既有30分钟交付门槛不降低。
缺少当前挂单是关键不足：不能假定 BUY 预占为零。缺少可用现金、币种/汇率
不清、持仓缺页或无法解释的 Sharesight 配置差异同样阻断相关行动金额。
全量账户账务最终性不由一次读取完整、现金匹配或文件新鲜度宣称。

## 两条最小实施路径

**A：保留 MCP 实时读取，Flex 补账务覆盖。**
schema 已取得；当前等待连续身份/来源探针的再次续期批准。确认账户绑定后，
验收真实只读取数、字段语义、全量/分页和上游更新时间限制。
交易/现金覆盖复用同账户已验证 Flex 内容，不复制 token，不把三账户状态当输入。
如果自动 source 身份需要新增档案 GET 权限，先列明固定 bucket/prefix/身份再批准；
本轮发现该身份没有 Flex secret 的直接 secretAccessor，也没有项目级直接 IAM
绑定，不默认它可以借用另一服务的认证。一次性 owner 只读访问不等于 scheduled
source 身份已有权限。

**B：复用既有 Flex 档案，先输出有限非行动报告。**
已有目标日真实内容与可验证账户/hash时，可展示已覆盖成交、现金及明确来源日；
持仓仅在实际取得 OpenPositions 后展示为“收盘持仓”，不是实时。
没有当前挂单就明确“当前挂单未取得，暂不提供补仓金额或行动建议”。
目前未取得目标日完整内容，因此不能凭对象更新时间宣布 B 已就绪。
如用户之后需要完整持仓，可评估独立只读 Activity Query 的 OpenPositions；
在批准前不新增 Query、不修改现用交易/现金 Query，也不生成/替换 Flex token。

两种凭据不通用：MCP OAuth 授权官方 MCP endpoint，Flex token 授权保存的
报表查询。[Flex 官方配置说明](https://www.ibkrguides.com/advisorportal/ug/flex3.htm)
使用独立 token 与 Query ID；重新生成 token 会使当前 token 失效，因此本次不做。
复用已经生成并验证的档案可以减少 OAuth 依赖，但自动任务若没有档案读取权限，
仍需单独批准最窄的来源读取通道。它不会自动解决实时挂单缺口。

用户已选择 A 并批准一次原机制续期；下一步须取得当前账户机器绑定。若选 B，
接受当前挂单与补仓金额不提供。真正需要新增 Query 或档案权限时再按准确动作
另批，不预先批量扩权。PR 保持 draft，现有生产与所有金融账本均不变。
