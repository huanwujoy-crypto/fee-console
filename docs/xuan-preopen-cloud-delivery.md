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

## 欧洲开市前窗口候选（2026-10-02，尚未上线）

本次候选以 LSE 08:00 Europe/London 与 Xetra **核心常规时段** 09:00
Europe/Berlin 的同一开市时刻倒推：T−60 分钟开始，T−30 分钟为公网完成目标。
夏令时为香港 14:00/14:30，冬令时 15:00/15:30。使用 IANA，独立解析两个
欧洲时区并核对结果；美国 DST 的错位周不移动此窗口。不采用零售延长时段。
共享 schedule 的历史合同截至 2026-10-02 保留；新切换日为 2026-10-03。
跨市场官方休市表和未覆盖年份拒收仍有效，全部休市不取金融来源。

两个季节的 UTC 候选 `0,10 6,7 * * 1-5` 在获取 WIF 身份之前检查真实窗口；
delivery 和 cloud job 也分别检查，开市后延迟运行不取数、不占锁。
正式对象前缀为 `delivery/日期/europe-regular-v1-日期-startEpoch/`，其中 start
仍为 create-only；旧日期根对象完整保留，手动 report-check 不进入正式前缀。
正式 receipt 绑定 slot/source-date/start，禁止早跑回执或根目录旧锁充当正式版。
生成与发布仍保留 30 分钟新鲜度、五分钟生成预算、账户关联、哈希、签名和
Validate → Promote → Pages；同 HTML 只有本轮正式 receipt、新鲜时间和
meta/date/edition/sourceSha/blob 均一致时才能返回 already-published。

### 真实来源门槛尚缺的证据

2026-10-02 只读检查 2026-10-01 cloud receipt 与三份原始 IB 证据，未输出
账户号或金额。该回执五个来源为 IB 摘要/持仓/挂单和两项 Sharesight；没有
成交来源或 readiness。IB 摘要与 positions 没有 upstream as-of/coverage 字段；
orders 的 order_time 是订单时间，不能证明成交扫描已完整。
本候选加入既有 mcp.read 范围的 get_account_trades，但尚未做真实云端接口验收。

`source_readiness.mjs` 是**待上游适配验收的证据合同**，不是官方 IB 返回字段
声明。要求摘要（现金）、持仓、挂单、成交各自有目标交易日、覆盖终点、全量/
分页完成、上游 as-of 和一致 snapshot；transport 不生成这些字段。
仅有 HTTP 请求时间、空 trades、Sharesight 三账户同步结果均拒收。无法通过时
只写无金额的 data-not-ready 私有 receipt，绝不出行动 HTML、复制旧金额或重标
旧报告日期；workflow 明确“数据未齐，未生成行动建议”。
现有 raw 不满足此合同，因此**此候选不能直接启用生产**，更不能把它称为已完成
来源完整性验收。下一步需在既有只读范围验证真实 upstream mapping，独立证明
XUAN MCP 与拟用 Flex 来源账户 scope 相同，再检查真实持仓全量与现金/成交覆盖。
Flex toDate 和现金核对证据不能单独证明 positions 全量，也不能仅凭 IB-HK 名称
把三账户任务接进报告。若需新凭据或权限，必须另行批准。

当前无行动 receipt 只在私有区，未接入签名的公开状态发布通道；因此用户页面
可显示更新延迟和未完成覆盖核验，但不能区分某轮具体失败原因。可验证、无金融
值的公开状态通道及晚到数据的受控新尝试（仍不删 immutable 锁）尚待设计验收。
这些是上线阻塞，不由私有 receipt 或单元测试代替。

### 调度与上线边界

GitHub [官方说明](https://docs.github.com/en/actions/how-tos/troubleshoot-workflows#scheduled-workflows-running-at-unexpected-times)
指出 schedule 可能延迟或丢弃，整点尤甚。因此 cron 改动只提供尽力触发和
异常检测，无法保证 T−30 准时。端到端还经过 source job、签名候选、Promote、
Pages 和公网读回。需要在已有授权配置内核对可靠调度入口；新增 Scheduler/IAM/
凭据不在本次授权内，不能悄悄增加。首次独立运行须记录真实起止/目标偏差。

待完成：真实来源 mapping、只读 trades 验收、公开失败状态、晚到来源尝试方案、
可靠调度验证、OWNER 对精确 PR head 亲自审批、不可变镜像部署/配置读回、shadow
与公网回证。未改生产 job、模式、IAM、OAuth、密钥、其他三账户流程或金融账本。

2026-10-02 后续有界能力核验：首次 schema-only 过期即止；用户明确批准一次
原机制续期后已安全轮换至原存储并取得实际 schema，金融读取/写入0，配置哈希
前后相同。之后身份探针遇到短期 token freshness 不足，在账户查询前停止，
未擅自第二次轮换。之后用户再次批准，连续探针安全保存轮换后在
默认账户身份联合条件未通过处停止，未读其余金融来源或写账本。身份仍未核实。
历史 XUAN↔Flex 固定账户在内存比对相同，但当前 OAuth 未独立绑定。已知 Flex
sections 仅成交/现金，未证明 OpenPositions 或当前挂单。原 raw.coverage/
same-snapshotId 是早期草案，不作为最终现实接口要求；替代的分级读取/账务门槛、
A/B 最小决策和真实停止回证见 `docs/xuan-preopen-source-feasibility.md`。
