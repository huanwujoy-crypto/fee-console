# 开市前行动版云端接入

使用 IBKR 官方 MCP `https://api.ibkr.com/v1/api/mcp-public`，独立注册客户端并通过 IBKR 官方 OAuth 页面授予单账户 `mcp.read`。这条接口与传统 `/iserver` Web API 不同，不以机构 First-Party OAuth 的申请作为前置条件。

`cloud/xuan-preopen/ib_mcp.mjs` 无需 Codex CLI 或 Mac：固定读取账户摘要、持仓、挂单，接收原始 JSON 并沿用现有来源解码器。没有任意工具调用入口；`mcp.write` 和 `mcp.orders.submit` 不被接受。客户端必须保存 refresh token 轮换后才继续取数；授权失效返回 `IB_REAUTHORIZE_REQUIRED`，不能使用旧凭据或来源冒充新一轮。

OAuth 初始登录仅在业主自己的 IBKR 页面完成。PKCE、state、授权码与 token 不进入 Git 或任务日志；凭据保存到私有 Secret Manager。云端只保存必要的 private evidence，现有模型、补仓规则和受保护发布流程继续使用。

此文件与读取模块是接入准备，不是上线回执。启用 Cloud Scheduler 前仍需实际验证：只读授权、账户关联、三项 IB 原始来源、两项 Sharesight 同日来源、当前四卡样式、受保护发布、公网读回，以及下一次独立云端运行。通过后才停用本机固定任务，避免双跑。

IBKR 实际授权页会提示新客户端取代已连接的 Codex 客户端。切换必须先明确告知业主；不能承诺两条连接并行。若切换后的独立云端验收失败，则要重新授权 Codex 才能恢复本机 IB 取数。初始授权页的“未经验证的客户端”指本项目自行注册、未经 IBKR 市场认证的客户端；它使用 IBKR 官方 OAuth 和 MCP，并非新的交易 API。

`probe.mjs --source-check` 只执行一次独立读取验证。凭据固定来自 `projects/family-portfolio-gateway/secrets/xuan-preopen-ib-mcp`；原始结果和回执保存到私有 bucket `family-portfolio-gateway-xuan-preopen-private`，日志只有时间、数量、证据哈希和私有对象路径。无公网、GitHub 或日程写入入口。它的服务账户只需对该 secret 的读取和版本新增权限，以及对该 bucket 的对象创建权限；不需要项目级管理员权限。

官方说明：

- https://www.interactivebrokers.com/en/general/about/mediaRelations/7-28-26.php
- https://www.interactivebrokers.com.hk/en/trading/ai-integrations.php

## 完整私有验收（未切换日程）

`report.mjs --report-check --source-date YYYY-MM-DD` 固定读取三项 IB 来源和两项 Sharesight 来源，沿用原四卡模型与确定性 HTML 校验，只向既有私有 bucket 新建证据、页面及回执。CLI 不接受公网、GitHub 或日程写入参数。来源日必须显式指定且早于当日；此手动验收模式不是自动交易日选择器，不可直接挂日程。

取数前与生成后分别从最新 trusted main 核对既有账户关联。过期、撤销、CALL 流水变化、已发布基线变化、资料日不一致或上传不完整均拒绝通过，不复制旧金额。挂单期间趋势只沿用 trusted main 中与 `latest.meta.json` blob 匹配的已发布页面。日志只含时间、状态、哈希和私有对象路径，不含 token、账户号、持仓或订单原始值。

Sharesight 读取拟使用既有 `family-portfolio-gateway-key`，而非 Sharesight OAuth 主凭据。须另获业主批准后，才对 `xuan-preopen-source` 身份增加这一项 secret 的 `secretAccessor`；不授予其修改权限。该现有 REST key 可以查询其它 Sharesight 组合，因此它并非服务端仅限两组合的独立凭据；本生成器严格固定 IB-HK 与 NOAH-HK 两条 GET performance 请求，不访问网关的 MCP 写入面。

当前网关不接受资产类别编号 83569。`Gateway.Dockerfile` 以 2026-09-30 查验的现行镜像 `sha256:88d71cfeb76415c9830829f2e9003f031cfd0e336dd2d248b59888b8d0a0cad9` 为底，仅机械修补已知 `get_performance` 函数。函数 SHA 不符立即构建失败；其它源码、OAuth、现金写入约束和容器启动配置不替换。新编号仅用于 IB-HK 单日只读报告，返回组合、USD、分类与日期还需再次核验。既有其它 grouping 逻辑不变。

部署时先核对 live revision/image 仍与此基线一致，保留 `family-portfolio-gateway-ibcash-6d1038e86516` 回滚基线，以无流量 tagged revision 检查既有接口与新分类接口后才切流。不得直接重新部署历史源码归档以覆盖当前现金同步实现。此处列出的是待批准步骤，不是部署回执。

本次准备不授权新的发布凭据、不延长账户关联有效期，不启用 Scheduler、不暂停本机任务。仍需完整真实五来源验收、受保护发布、公网读回，再单独完成日程交接。

## 自动接线候选（2026-10-01，默认关闭）

`Daily.Dockerfile` 的固定入口 `daily.mjs` 按已核对的 NYSE 与 Xetra 2026–2028 日历选择上一已完成美股来源日。日历来源见 `calendar.mjs`；未覆盖年份拒绝运行。当前日历门仅覆盖 NYSE/Xetra，不能称为全部交易场所日历验收，LSE/Nasdaq/Euronext 的独立核对仍是启用前待办。

每日私有输出只新增 `delivery/YYYY-MM-DD/report.html` 与最后写入的 `receipt.json`；原始五来源仍在 `report-check/`。专用 `xuan-preopen-delivery` 身份拟仅获固定 `xuan-preopen-report` job 的运行及执行状态读取，以及上述 delivery 前缀的对象 GET；不授予对象 list、写入、原始证据读取、Secret Manager 或交易权限。GitHub OIDC provider 必须同时限制本仓库、main、固定 workflow 与独立 environment，避免其它 workflow 借用身份。这些 IAM/环境变更尚未执行。

GitHub 固定 workflow 仅在 `XUAN_PREOPEN_CLOUD_MODE=shadow|publish` 时运行，变量不存在则关闭。拟定时点为周一至五 13:00/13:10 HKT。重复触发复用完整回执，只发一次 run 请求；失败不自动重跑。`shadow` 不提交报告，`publish` 拟使用既有 repository secret `FEE_CLOUD_GITHUB_TOKEN`，token 不进入云端容器。专用身份、既有 token 的新用途与日程切换需业主批准。

`publish.mjs` 仅提交签名单文件 `xuan-ib/index.html` 候选：重新核验账户关联、trusted main、CALL 流水、五来源与 HTML 哈希，并拒绝超过 30 分钟的报告。正式页面仍由 Validate → Promote → Pages 更新，workflow 随后独立探测公网 SHA/blob/date。维护 PR 修改 `.github/`，依 `xuan-ib/session-approval-v1.md` 第 6 节须业主本人评论精确 head，不可由代理代发。

启用顺序：受保护维护 PR 批准合并 → 批准并配置限定 IAM/OIDC/environment 与固定 job → shadow 实测 → 新鲜报告候选的 Validate/Promote/Pages 与公网读回 → 用户批准日程切换 → 下一次独立云端运行回执 → 停用旧本机开市前任务。私有报告成功或单元测试通过均不代表发布完成。
