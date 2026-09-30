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
