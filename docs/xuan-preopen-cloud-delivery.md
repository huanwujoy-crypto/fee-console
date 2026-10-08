# 开市前行动版：云端发布接线

本变更不改补仓算法、四张卡片排版、Sharesight 记录、IB 挂单或交易；周报和管理费任务保持不变。

## 固定流程

GitHub 固定任务 → 专用 Cloud Run `xuan-preopen-report` → 私有成品 → OWNER 签名候选 → 既有 Validate → Promote → Pages → 公网字节核验。

每个交易日计划 13:00 HKT；13:10 仅作幂等补查。GitHub 定时事件可能延迟，不能把 20 分钟目标写成无条件保证。每天 `start.json` 在取数前只创建一次；补查跟随已启动执行，或复用成品，绝不重新读 IB。失败保留旧正式报告，不伪造零数或新日期。

来源仍为 IB 三项实时只读，以及 Sharesight 的 IB-HK 四类配置和 NOAH-HK 现金。原始五项证据保留在私有 `report-check/`；交付身份只能读取 `delivery/` 内 HTML、完成回执和无金融数值的启动标记。

交易日已独立核对 [NYSE](https://www.nyse.com/trade/hours-calendars)、[Nasdaq](https://www.nasdaqtrader.com/trader.aspx?id=Calendar)、[Xetra](https://cashmarket.deutsche-boerse.com/cash-en/trading/trading-calendar-and-trading-hours)、[LSE](https://www.londonstockexchange.com/equities-trading/business-days) 及 [Euronext](https://www.euronext.com/en/trading/trading-hours-holidays) 官方表（2026-10-01 核对）。LSE 全年表同时以其明示采用的 [England/Wales bank holidays](https://www.gov.uk/bank-holidays) 补齐历史部分。Euronext 表示七个现金市场中至少一个开市，不把某一场所放假当成全部休市。任一开市才生成；半日市仍生成。源数据日取上一已结束美股交易日。完整五组覆盖为 2026 年；NYSE/Xetra 另有 2027–2028 表，但未独立补齐其它市场前，日程在新年拒绝运行，不按工作日猜测。特殊临时休市仍需更新官方日历。现有账户关联 2026-10-10 到期闸门保留，不自动延期。

## 单独批准的最小权限

只有 OWNER 批准这个精确 head 后才部署或启用。涉及 `.github/`、身份与日程，必须由 OWNER 本人在 PR 留下批准评论，不得代发。

- 新身份 `xuan-preopen-delivery@family-portfolio-gateway.iam.gserviceaccount.com`：仅指定报告 job 上的 `run.jobs.run` 与 `run.executions.get`，不允许执行 overrides、修改/删除 job 或操作其它任务。
- 同一身份：私有 bucket 上仅 `storage.objects.get`，并以 IAM 条件限定 `delivery/` 前缀。不允许列举、读取 `report-check/` 原始取数、写文件或访问任何密钥。
- 新 WIF provider `xuan-preopen-main`：仅本仓库、`main`、这个完整 workflow 路径和既有 `fee-cloud-producer` environment。OIDC subject 按仓库实际不可变编号匹配 `repo:huanwujoy-crypto@283054367/fee-console@1334738755:environment:fee-cloud-producer`；不修改已有管理费 provider，专用发布身份和权限不变。
- 经明确批准后，新工作流复用既有 `fee-cloud-producer` environment 内的 `FEE_CLOUD_GITHUB_TOKEN`，仅交给候选提交步骤。该密钥不是仓库级密钥，不能由新 environment 直接继承；不读取、复制或重新保存其值，不改变原环境的 main-only 限制。它不上传 GCP，不进镜像，不交给 IB/现金取数身份；管理费原任务不改。
- 候选仅一个文件 `xuan-ib/index.html`、一个 GitHub 签名提交，标题 `handover YYYY-MM-DD`。加载当前 main，复核账户关联、待 CALL 款、前一正式源 SHA、成品哈希和 30 分钟新鲜度；正式文件仍仅由既有受保护 Promote 写入。

## 验收及切换

`XUAN_PREOPEN_CLOUD_MODE` 默认未设置，自动发布关闭。合并不等于切换。

1. 经批准部署不可变镜像、专用 job 和最小 IAM/WIF；读回实际配置。
2. shadow 云端运行：核验单次执行成功及成品回执，不发布。
3. publish：复用这份成品，经原有受保护通道上线；核对 main、固定入口 meta/HTML 的 SHA 和资料日，并检查手机宽度排版。
4. 只有公网核验通过，再确认 13:00/13:10 云端日程及模式，暂停原本机 `xuan-ib-codex`。保留旧配置供回退。

2026-10-01 接线验收：专用 cloud job 已成功取五项来源（13.581 秒生成），但新 environment 读不到原环境内的发布密钥，发布以 `PREOPEN_PUBLISH_TOKEN_REQUIRED` 拒绝。此修正只更正环境引用；须 OWNER 批准精确新 head 后，才将专用 WIF 条件的 environment subject 等值改为上列实际格式，并继续验收。既有管理费工作流、环境、密钥和 provider 均不改。当天成品只创建一次；若批准时成品已超过 30 分钟，不降低新鲜度要求、不删除启动标记、不再读 IB，保留现有正式报告，改在下一个交易日验收新成品。

回退先将 mode 设为 `off`，停止新候选；原正式报告保留。由于 IB 已切换至云端只读连接，不能盲目重新开启旧本机任务，必须先确认其 IB 连接可用。

## 2026-10-08 失败诊断与待批准修复

GitHub run `37730194423` 在 05:00:12 UTC 以 `workflow_dispatch`
请求，79 项云测试与短期身份获取成功；交付步骤返回
`PREOPEN_DELIVERY_EXECUTION_FAILED`，候选提交与公网核验均未运行。
官方 Cloud Run 执行 `xuan-preopen-report-thzb4` 的唯一 task 从
13:00:29 至 13:00:42 HKT，退出码 1、重试 0；其 13:00:32.605 HKT 日志为
`{"code":"IB_REAUTHORIZE_REQUIRED","publication":"none","status":"failed"}`。
现有客户端在 refresh 非成功响应或 MCP 401/403 时给出此码；现有日志不能
区分这两条路径，也不能证明凭据具体失效原因。未读取 secret 或原始金融来源。

公网 `latest.meta.json` 与 `latest.html` 字节已核对：资料日 2026-10-07、
源 SHA `6691b874448a6271ab27e5af3c0a964cfef85703`、HTML blob
`c96f69d74823d34ab9d619265d7be06d5bedde3d`；标题是“XUAN · 开市前行动版”，
页头显示 13:00 HKT 读取、数据至 2026-10-06。

此修复仅补足失败原因的私有交付：成功抢到当天启动标记后，如果生成失败，
在既有 create-only `receipt.json` 写入无金融数值的 `status=failed` 回执。
仅允许 `IB_REAUTHORIZE_REQUIRED`，其它错误归为 `DAILY_REPORT_FAILED`，
不转发原始错误文字。交付端严格检查日期、执行名称、完整字段和固定错误码，
在执行失败时最多补读一次回执；旧镜像没有失败回执时仍返回原泛化失败码。
失败回执不是 ready 成品，不读取 HTML、不提交候选、不自动再次取数。
未抢到启动标记的执行不得写失败回执；诊断写入失败不得覆盖原失败原因。

待完成：精确 head 的 OWNER 审批、必需检查、受保护合并及单独批准的固定
Daily 镜像构建/部署。合并代码不会自动更新现有 Cloud Run 镜像。
授权恢复须由业主在 IBKR 官方 OAuth 页面完成原单账户 `mcp.read` 授权，
凭据只进入既有私有存储；代理不得记录授权码、token 或扩大 scope。
恢复可能替代当前 IBKR 客户端连接，须先说明该影响。不能删除或覆盖当天
`start.json`，不能重触发当天生成来测试；重新授权后默认在下一 eligible
交易日的既有流程验证，保留 30 分钟新鲜度、账户关联到期、Validate/Promote/
Pages 与公网核验全部闸门。若要求同日恢复，须另行给出具体执行和防重复
方案并获得人类批准；本补丁不提供绕过入口。
