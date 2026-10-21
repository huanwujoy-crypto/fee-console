# XUAN-IB Codex 接管

目标是记录，不是交易。只保留一份睡前版；先给出实时 IB 持仓和挂单，其他数据能核实后再补全。旧版只作历史记录，不能冒充当前挂单。

## 启用条件

1. Codex 中的 IBKR 官方 MCP 仅授予 `mcp.read`；实测账户身份、持仓、挂单及时间戳。2026-09-22 已确认 `mcp__ibkr__get_account_positions` 与 `mcp__ibkr__get_account_orders` 可读，但这不是一次完整报告的证据。若授权页要求 `mcp.write` 或账户不符，停止。不要读取或记录密码、验证码、完整账户编号。
2. Sharesight 使用本机固定 Native Direct 只读程序。2026-09-22 已读回组合清单及 IB-HK performance 的完整字段；每次仍需核对来源、日期和账户身份。`scripts/xuan-ib-sharesight-direct-capture.mjs` 在已有私密 journal 的 `sharesight-read` 阶段调用固定程序、保留原响应并生成现有采集回执。缺失项写“未取得”，不填旧值或零。
3. 2026-09-22 同日 5 项 IB、9 个 Sharesight 来源经原始回执及九个 journal 阶段校验；该次私有准备约 57 秒。受保护 PR #260 合并后，当晚的精简睡前版已通过公网 HTML/元数据和手机读回。它不是自动任务的成功证明：Codex 固定任务仍未启用。精简生成器缺少完整版的部分风险、配置与价格变化，本次样式修复须经独立 PR、受保护合并及公网回读；缺少本轮计算的数值不得复制旧版。

## 每晚流程

- 纽约常规交易日开盘时（09:30 America/New_York）启动独立速览：IB 持仓和挂单。以 20 分钟内公网可见为目标，记录实际起止时间；过时或取数失败则显示上份报告与显眼的日期，不显示“实时挂单”。
- 随后生成完整记录。Sharesight、ETF 和风险计算可晚到；仅使用本轮可验证来源，绝不阻塞速览或拿旧数补缺口。同日期完整版本可替换速览，旧候选不得回盖新候选。
- 行动版挂单同时读取 IB 持仓端点，以原始标识唯一匹配币种和本轮价格。期间变化只沿用上一份已验证页面保存的观察基准，不另查历史行情；缺少唯一匹配或旧基准时省略该项，不阻塞发布，也不显示技术占位语。
- Sharesight 日报使用 `America/New_York` 的市场日期，页面另列香港取数时间；香港清晨不得以香港日期请求尚未形成的美股日报。行动版现金池＝IB 现金＋NOAH-HK 现金；自本规则获保护合并后的新报告起，待 CALL 保留业主声明的原额，但规划只按原额的 50% 预留，再全额扣除未成交 BUY 挂单的剩余数量乘限价。可补仓现金不低于零，SELL 挂单不预计回款。页面须同时注明待 CALL 原额、50% 预留额和计算口径；历史报告不追溯改算。
- 类现金只认 Sharesight `防御资产` 中的 VGSH、VGIT、TLT，单列金额，不进入股票四类分母，也不默认卖出。页面的“全部弹药”＝可补仓现金＋类现金；补仓计划只使用可补仓现金。超过既定 EXUS／EIMI／USSC 规则需求的余额明确显示为“暂留”，不得为了花完现金而发明新标的或扩大比例。
- `scripts/xuan-ib-codex-mcp-capture.mjs` 从 Codex CLI JSON 事件保存五份私密 IB 回执，只接受五种已核对的只读调用，发现写入或缺失调用即停止。`scripts/xuan-ib-codex-read-trial.mjs --pm-prepare` 先查当前受信账户关联，再读取同轮来源和 AI 风险，生成正式版式的私有候选，不自动发布。金额不得手工重输。
- 只在受保护的 `codex/xuan-ib-*` 候选分支提交 `xuan-ib/index.html`，跑现有 guard、Validate、Promote、Pages，最后核对公网版本。受保护规则、账户关联与 OWNER 批准仍有效；不得直接改 `latest.html`、`latest.meta.json`。

## 权限和故障

- 不下单、不改挂单、不转账、不写 IB 或 Sharesight。新增仓位的报告分类可按已批准规则自动记录；证据不足时标为“待核实”，不凭空分类。
- IB 未连接、会话失效、Mac 关机或 Codex 桌面未运行时，本机定时任务无法保证准时发布。报告保持旧版，并显示明确日期；先修源连接，不能假报成功。
- 来源、候选、受保护合并和公网显示是不同验收点。报告只给用户：当前数据日期、持仓/挂单是否新、未取得项目、实际耗时。


## Sharesight 账面行动版（待本变更保护合并生效）

本版持仓、现金及已成交记录以 Sharesight 为源，优先复用父任务已授权的云端浏览器快照。券商同步完成是用户指定的计算前提，不是独立对账证明；不重复读取券商持仓、现金。集中度只用 IB-HK 全部持仓与现金，账面现金池用 IB-HK + NOAH-HK。原生币种、账面 USD 折算、逐项价格日期未知及旧分类来源均须保留。CALL 原额的 50% 规则不变。账面预挂单上限与已扣挂单的净估算分开，均不称券商实时可下单额。

挂单仍为独立 IB 来源：可用时先云端 MCP、失败才 Mac MCP；本线程两者均无工具路由时，保存 `IB_MCP_ROUTES_UNAVAILABLE`，显示未读取及预占未知，继续显示其余已取得计算。不得创建新客户端或扩大凭据范围，也不能将未知预占算成零。

无路由的一次本机执行使用 `createOwnerBrowserEvidenceAccess` 和 `composeBrowserActionEvidence`。新 request 与原先收据锚点在 `security/xuan-owner-source-recovery.json` 一并登记，代码合并不等于运行批准。先核对原身份、既有七名读者、canary、当前入口及新 start 对象未存在，再取得新快照；捕获开始时间必须是实际最早读取时间。所有归一化、金额与 HTML 校验先在内存完成，再由受限桥新建 start、四份来源、HTML、收据及 preview 收据（合计八份；硬上限十份、32 MiB）。固定原桶及原 `report-check/` 前缀，全部 `ifGenerationMatch=0`；错误或结果不确定停止并查明，不能换 request 重试。

此桥只新增固定证据写入能力，不改已安装 SDK、IAM、读者或服务。来源单份限 4 MiB、HTML 2 MiB、收据 128 KiB；五分钟采集与三十分钟鲜度不变。随后沿既有实际页面验收、独立准入、唯一 latest CAS 与逐字节回读；证据能力不能签发 CAS 准入。报告桥本身不构建或运行 Cloud Run；下面的正常云端挂单入口另需一次构建及原 job 配置更新，不能将完整执行称为零 Cloud Run 变更。调度保持原状态。费用及任何必要普通登录刷新必须在本次明确运行批准内，过期或身份不符不得绕过。


## 账面完整展示与周末集中度复用

行动版在原 IB-HK 范围内复用 `scripts/xuan-weekly-concentration.mjs` 的发行人合并、ETF 同名／前十穿透、1% 门槛与已核实每日杠杆等效算法及渲染。周末版三账户入口及分母规则保持独立，行动版不虚构其他账户。浏览器当前持仓金额与原读取时间不变，证券类型只沿用持仓 ID、证券 ID、市场、代码、币种均匹配的既存来源；ETF 成分仍按原资料日期和有效期校验，未知部分明确列出，直接持仓明细保留。

持仓、四类配置、账面现金、CALL 与分类资料齐备时，另行计算扣挂单前的 EXUS／EIMI／USSC 参考分配、暂留及含类现金总参考。页面显示“账面更新完成”，挂单及其依赖结果单独说明；挂单未知不再把已取得现金和当前配置重复列为缺项。净预算、挂单后配置及可执行预算仍受原约束，未知不能填零。私有发布元数据的金融完整性仍为 partial，不能将账面展示完整误称全部金融字段完整。

本候选同时提出新的单次 request 登记，保留旧 claim 和原不可变收据锚点。代码合并不是执行批准；本次修复仅复用已保存快照离线计算，不取数、刷新、上传或 CAS。后续一次发布须统一批准新执行：两组合云端浏览器新快照各一次；正常入口单独取得一次挂单，核对本次执行的收据、对象 generation／SHA256 后，把原始来源作为同一捕获窗口内的 `ordersCapture` 数据传入。报告接入口同时保留原解码器的 `wrapper`／`transportFingerprint`，只接受明确的原生对象或 JSON 字符串形状；私有对象的 generation／SHA256 仍由受保护读取控制器核验，不能把指纹本身当授权。既有保护检查继续核验身份、原始指纹、覆盖和时间，不复用旧 probe 授权或旧运行身份。五分钟采集和三十分钟新鲜度不变；已过期快照只可离线验证。候选、实际页面、唯一 CAS 与独立回读分别验收，不得沿用之前已消费的运行授权。

## 正常云端挂单入口与一次执行范围（待正式批准）

正常入口为 `node cloud/xuan-preopen/orders_read.mjs --orders-request <fresh JSON>`，只接受本次 requestId、香港 dataDate、未来十五分钟以内的 expiresAt 和固定 `credentialBinding {clientId, version}`；version 必须是原 Secret 的明确数字版本，不能退回 latest。拒绝旧 `--request`、旧 nonce 或混合参数。复用 `captureCloudIbOrders`、原身份、`mcp.read`、账户和时间校验，不新增 OAuth grant、客户端、权限或 Secret，也不调用旧 probe 运行器。最多一次 `get_account_orders {}`；必要时同一授权内普通 IB 刷新一次，向原 Secret 保存确认的新版本一次，保存未知或失败则停止，不能再发挂单调用或自动重试。

现有部署镜像没有此 CLI。运行前须将该两文件与报告改动一起正常受保护合并。固定构建白名单只从 105 项增至 107 项，明确加入正常入口及其测试，不放宽目录或任意文件。使用现有受保护 image maintenance 工作流的 build-only 模式（`image_kind=report`、`deploy_image=false`），按 `Maintenance.Dockerfile` 构建及推送一个可核验不可变镜像；只更新原 `xuan-preopen-orders-probe` job 的 image 和 command 为新镜像及 `node cloud/xuan-preopen/orders_read.mjs`，读回核对。保持原 source SA、1 CPU／512 MiB、单 task、parallelism 1、75 秒 timeout、maxRetries 0、其他配置和暂停的调度；不新建 job／service，不部署每日报告 job。镜像／命令更新是本次拟批准的部署，未包含另一次恢复配置写入。构建、配置更新均应在新鲜金融采集开始前完成；真实预检仍要核对其他消费者静止、原身份、准确数字版本、原七名读者、入口／canary、互斥及新 claim 未存在。

这一次完整执行需单独批准：一构建／一镜像推送、一原 job 配置更新、一 execution、IB 挂单一次、两组合浏览器快照各一次；必要 Google 普通刷新及原缓存保存各最多一次、IB 刷新及原 Secret 新版本各最多一次。正常挂单的 `report-check/orders-read-<new-requestId>/` 新建 start、orders、receipt 三份；报告桥新建八份，成功全链共十一份私有证据，故不能沿用旧的全链十份上限。拟申请全链十一份／32 MiB、一次新 latest CAS、原七名读者；构建源码上传及镜像推送另列，不能混入金融证据次数。报告桥本身原十份硬限制及固定路径检查不扩大，无新增 Sharesight API 读取、IAM／读者／账务改动。结果未知先核对，不能换 request 或重复执行。

旧 US$0.10 仅对应零构建的报告发布预算，不能作为新增构建、镜像存储与 Secret 版本费用的总费用保证。现有证据只确定 job 最大 75 vCPU 秒／37.5 GiB 秒；构建时长、镜像增量／扫描费用和 Secret 计费复制位置仍需在获准普通 Google 刷新后的只读预检中确认，不能假设免费额度或声称总额低于 US$1。统一执行批准须明确覆盖这些项目的总费用上限；不能合理保证上限时停止相应收费动作，不擅自超支。
