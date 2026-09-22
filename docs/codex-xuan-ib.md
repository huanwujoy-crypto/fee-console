# XUAN-IB Codex 接管

目标是记录，不是交易。只保留一份睡前版；先给出实时 IB 持仓和挂单，其他数据能核实后再补全。旧版只作历史记录，不能冒充当前挂单。

## 启用条件

1. Codex 中的 IBKR 官方 MCP 仅授予 `mcp.read`；实测账户身份、持仓、挂单及时间戳。2026-09-22 已确认 `mcp__ibkr__get_account_positions` 与 `mcp__ibkr__get_account_orders` 可读，但这不是一次完整报告的证据。若授权页要求 `mcp.write` 或账户不符，停止。不要读取或记录密码、验证码、完整账户编号。
2. Sharesight 使用本机固定 Native Direct 只读程序。2026-09-22 已读回组合清单及 IB-HK performance 的完整字段；每次仍需核对来源、日期和账户身份。`scripts/xuan-ib-sharesight-direct-capture.mjs` 在已有私密 journal 的 `sharesight-read` 阶段调用固定程序、保留原响应并生成现有采集回执。缺失项写“未取得”，不填旧值或零。
3. 2026-09-22 同日 5 项 IB、9 个 Sharesight 来源经原始回执及九个 journal 阶段校验；该次私有准备约 57 秒。受保护 PR #260 合并后，当晚的精简睡前版已通过公网 HTML/元数据和手机读回。它不是自动任务的成功证明：Codex 固定任务仍未启用。精简生成器缺少完整版的部分风险、配置与价格变化，本次样式修复须经独立 PR、受保护合并及公网回读；缺少本轮计算的数值不得复制旧版。

## 每晚流程

- 纽约常规交易日开盘时（09:30 America/New_York）启动独立速览：IB 持仓和挂单。以 20 分钟内公网可见为目标，记录实际起止时间；过时或取数失败则显示上份报告与显眼的日期，不显示“实时挂单”。
- 随后生成完整记录。Sharesight、ETF 和风险计算可晚到；仅使用本轮可验证来源，绝不阻塞速览或拿旧数补缺口。同日期完整版本可替换速览，旧候选不得回盖新候选。
- `scripts/xuan-ib-codex-mcp-capture.mjs` 从 Codex CLI JSON 事件保存五份私密 IB 回执，只接受五种已核对的只读调用，发现写入或缺失调用即停止。`scripts/xuan-ib-codex-read-trial.mjs --pm-prepare` 先查当前受信账户关联，再读取同轮来源和 AI 风险，生成正式版式的私有候选，不自动发布。金额不得手工重输。
- 只在受保护的 `codex/xuan-ib-*` 候选分支提交 `xuan-ib/index.html`，跑现有 guard、Validate、Promote、Pages，最后核对公网版本。受保护规则、账户关联与 OWNER 批准仍有效；不得直接改 `latest.html`、`latest.meta.json`。

## 权限和故障

- 不下单、不改挂单、不转账、不写 IB 或 Sharesight。新增仓位的报告分类可按已批准规则自动记录；证据不足时标为“待核实”，不凭空分类。
- IB 未连接、会话失效、Mac 关机或 Codex 桌面未运行时，本机定时任务无法保证准时发布。报告保持旧版，并显示明确日期；先修源连接，不能假报成功。
- 来源、候选、受保护合并和公网显示是不同验收点。报告只给用户：当前数据日期、持仓/挂单是否新、未取得项目、实际耗时。
