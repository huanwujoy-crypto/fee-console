# 香港日期修复与一次新来源恢复方案（待正式批准）

本 PR 修复香港 00:00–08:00 被错误当成 UTC 次日的 `TIME_ORDER`，并提供一个明确注册、独立 claim 的恢复入口。代码合并不授权取数、配置写入或发布；本次准备没有执行这些动作。

## 已发生的事实与保留项

10 月 21 日原尝试已经取数并生成私有候选。报告日是香港 2026-10-21，纽约市场来源日是 2026-10-20；receipt.startedAt 为 `2026-10-20T23:19:52.742Z`，因此 30 分钟期限精确结束于 `2026-10-20T23:49:52.742Z`（香港 07:49:52.742）。原候选已经过期，不能再晋级或改时间。

原 `delivery/2026-10-21/start.json`、报告、receipt、4 份来源、订单 probe 和本地验收证据全部保留。旧 receipt 的 generation/SHA256 固定在 `security/xuan-owner-source-recovery.json`，恢复读取必须先认证它。旧 latest 未被本次发布修改，原 CAS 额度尚未使用。原任务配置已经恢复；执行前仍须重新只读核实配置与未知结果。

## 接口契约与验证

| 阶段 | 固定契约 |
| --- | --- |
| 生成 | 已批准镜像的 `action_preview_once.mjs --request`；新 requestId、新现场 expiresAt；create-only `orders-probe-<requestId>/start.json`。原 daily claim 不重置。 |
| 读取 | 只发现注册的 `preview-receipt.json`：metadata GET → pinned metadata GET → pinned media GET；从实际 receipt 学到原报告和 4 份来源的 generation/SHA256。没有新增 HEAD 权限。 |
| 时间 | dataDate 是香港日；sourceDate 是已结束的纽约交易日；startedAt/completedAt 保持 UTC 原值。香港凌晨纽约尚未收市时，在金融调用之前拒绝，不请求尚未完成的日报。 |
| 验证 | 原始 receipt、源字节、账号关联、CALL、模型与 HTML 全部重建校验；5 分钟采集上限、30 分钟新鲜度、当天规则均保留。恢复挂单的 probe 路径须属于注册 requestId。 |
| CAS | 同一固定私有 latest、原 7 名读者、原 canary/IAM/可信 main；10 秒 publisher、60 秒全预检和 5 秒原生 admission 不扩大。CAS 前再次检查新鲜度、跨日和时钟倒序。 |
| 回读 | 上传 ACK 不算验收；独立读取新 generation 的 metadata 和原始字节，逐字节/hash 核对。412 不重试，未知写入结果先核对，不另发 CAS。 |

同日的新旧 receipt 按对象路径隔离缓存，历史 latest 不会覆盖新候选的 receipt。合成链采用真实 producer、store、verifier、publisher、Python OwnerBridge 和内存 GCS；网络/身份/canary 为测试依赖，未宣称真实 IAM、SDK 登录或 GUI 验收。另测真实 Node SDK 参数边界和原生 Python SDK 合成库。香港 00:00、夏令时 04:00、冬令时 05:00、07:19、07:59、08:00、香港跨日、纽约周末与跨年日期、过期、时钟倒序、412、损坏回读均有用例。

## 唯一的新尝试

新 requestId：`78006513-4741-450d-bb86-4af26403600d`。它尚未执行或占用。仅注册香港 2026-10-21；不会自动滚动到下一日。原 requestId、nonce、请求窗口和 claim 不复用。

复用既有镜像：
`asia-east2-docker.pkg.dev/family-portfolio-gateway/xuan-preopen-maintenance/xuan-preopen-action-preview@sha256:098d0add4bc3cfa01fbc9d622f704e4e6d13cd99c52bc85419eadf54021586cc`。

本 PR 仅修改 Mac 发布端及测试/注册；源调用入口的生产依赖字节不变，因此方案不需要新构建或推送。生产器使用非 daily 模式，成功路径只创建 10 个对象，包括原报告/receipt 和已知镜像 receipt；不会写原日目录。

## 一次合并批准所需的运行预算

以下是**新增申请，尚未执行**；不把原已用额度重置成可用：

| 项目 | 新尝试上限 |
| --- | --- |
| 构建 / 镜像推送 | 0 / 0，复用上述 digest；如果不可用则停止，不擅自构建 |
| Cloud Run 配置写入 | 2 次，临时配置一次、条件恢复一次；包括清空 command 与恢复 |
| Cloud Run 执行 | 1 次，1 task、parallelism 1、retry 0、1 vCPU、512 MiB、timeout 180 秒 |
| IB 挂单 | `get_account_orders` 1 次；不交易、不增加其它金融端点 |
| Sharesight | IB-HK 与 NOAH-HK performance GET 各 1 次 |
| IB 普通刷新 / 原 Secret 新版本 | 各最多 1 次；原 client、resource、mcp.read，不 DCR/重授权/换身份 |
| Google 普通刷新 / 原缓存保存 | 各最多 1 次，仅必要时；不导出 token、不读 Keychain、不新增身份 |
| 私有证据创建 | 最多 10 次，每对象 ≤9,000,000 字节，总计 ≤32 MiB |
| latest CAS | 沿用原未使用的 1 次；同一固定对象、7 名既有读者；不增加第二次机会 |
| 审核与回读 | 原路径的只读状态、固定对象 metadata/bytes、canary/IAM、候选与发布页面验收；无源数据重取 |

授权日期窗口建议覆盖批准后香港 10 月 21 日余下时间，截止 `2026-10-21T16:00:00Z`（香港 10 月 22 日 00:00），不能跨日执行。执行请求在最后预检后现场生成 `expiresAt = T + 55 秒`，credential 独占检查覆盖 T 至 T+75 秒；沿用 IB 45 秒调用与最多 20 秒收尾。业务日期授权窗口与单次协议时限不是同一个时限。不得复用已签发的旧请求，也不得自行缩短业务窗口来制造重复审批。

费用用量：新增构建/推送费用为 0；单任务工作量最多 180 vCPU-second、90 GiB-second，实例启动/终止时间按账单另计。计算公式为实际实例秒数 ×（香港 jobs vCPU 单价 + 0.5 × 香港内存单价），另加存储、读取、Secret、日志及网络费用。官方页面默认显示 Iowa，不能把其单价当作香港精确报价；未读取私人账单或免费额度。建议本次新增执行及首月新增证据费用审批上限 **USD 0.10**，属事前预算而非实测账单或云端硬性账单开关；执行前核实香港费率/预算可覆盖，否则停止。32 MiB 证据的后续保留沿既有策略，不额外删除旧审计证据。参考：[Cloud Run 计费](https://cloud.google.com/run/pricing)、[Storage 计费](https://cloud.google.com/storage/pricing)。

## 恢复与验收顺序

1. 对 PR 最终签名 head 取得本人 exact-head OWNER 评论，三个正式保护检查成功，重新核实 main 仍是唯一 parent，才可正常合并；不 auto-merge、不绕过。代码批准与上述新运行预算须一并明确，避免取数后再等代码审批。
2. 仅只读验证新 claim/镜像 receipt 不存在、无运行中的重复执行、原 latest generation、原任务完整配置/etag 和原 7 人边界。出错或不确定不当作不存在。记录新的本地一次执行标记；不重置旧标记。
3. 必要时一次原 Google 状态刷新，预检 publisher 公开 Git 网络、原 SDK 缓存有效期、固定私有路径、 canary 和 Chrome 显示条件。尚未金融取数时完成所有可预检项。
4. 固定原 job、service account、网络与空 env；临时应用上述镜像/180 秒/空 command。现场生成单次 `--request`，不传 `--daily-request`，发出一次执行。未知响应先按 operation/execution/requestId 核对，不重发。
5. 到终态且 job generation/etag/临时配置指纹仍匹配时，执行唯一恢复写入，恢复原镜像、75 秒、`node cloud/xuan-preopen/orders_probe.mjs`、原 args/env/resources/SA；独立 GET 比较全部字段和指纹。若状态未知或他人改动则保留证据并停止恢复写入，报告准确差异。
6. 独立读新注册 receipt 与源字节；核实实际纽约来源日、香港报告日、挂单取值时间及现金同步覆盖。无同步完成证据仍标 recorded；未知币种/完整挂单范围/预留/可执行预算不能变成零或免预留。CALL 原声明与 50% 规则不变；不新增 Webull 范围或改管理费数据。
7. 在 30 分钟期限内完成真实候选页面五区块、桌面/窄屏、日期、原格式及明确缺项验收，保留截图。调用合并后无参数 `deliverRegisteredOwnerRecovery()`，以原剩余 CAS 一次晋级。分别完成固定私有入口的新 generation 字节回读和实际页面验收；公开 GitHub Pages 仅是代码/壳更新，不能冒称私有财务报告已发布。
8. 任一数据期限失效、权限/身份/范围不符、CAS 冲突或未知结果即停止相应步骤；不重取、不重置 claim、不删除原证据。后续只读核实和已授权条件恢复可继续。

本 PR 审批本身不授予任何持续权限，也不自动执行本方案。

## 10 月 21 日恢复执行后的发布接口修复（另一个精确 head 审批）

上文是 PR420 执行前的方案快照。该注册恢复请求现在已经使用，原 claim 和不可变证据保留，不能再次调用或重置。实际候选的香港报告日为 2026-10-21，纽约来源日为 2026-10-20；采集始于 `2026-10-21T00:40:10.028Z`，30 分钟期限为 `2026-10-21T01:10:10.028Z`（香港 09:10:10.028）。该候选尚未晋级，CAS 为零；原任务配置已经恢复。本补丁不发出金融调用、刷新、构建、任务运行、证据上传或发布。

三个确定问题及修复：

- 原 publisher 的 10 秒计时在读取 latest 之前开始，包含四份串行 SDK 来源读取、公开 Git 上下文和 IAM/canary 检查。真实只读诊断中，latest 加准入计划已耗时 15.497 秒，尚未发 CAS。现在使用独立、可中止的 60 秒准备阶段；准备结束后才开始原 10 秒 CAS 与独立回读计时。原 IAM 时效、5 秒原生准入和 30 分钟数据新鲜度均保留；在准备结束后重新检查过期、香港跨日和时钟倒序。超时或身份/边界变化仍失败关闭。
- 原准入包装把公共 Git 读取故障隐藏为 `OWNER_ADMISSION_REJECTED`。真实复测的有限底层原因是 `REPORT_SOURCE_NETWORK_FAILED` / `ETIMEDOUT`，阶段为 `github-association` 的 fetch，未收到 HTTP 状态；没有凭据/IAM 拒绝证据。现在保留有限错误码、读取阶段和耗时，避免输出 URL、正文、凭据或原错误消息。单次发布范围内仅缓存已验证的固定提交公共字节；最多为一次匿名不可变 GET 的瞬时连接失败追加一个请求，共用原中止信号与总时限。实时 main、私有/金融请求、HTTP/TLS/正文失败和写入不重试。缓存不保存审批、上下文或时间。
- 原生 daily CAS 调用 canary 校验时只传注册摘要，缺少校验器必需的 `previousDisplaySha256`，会出现 `KeyError`。现在从同一受保护 canary 注册取该字段，仍执行原生当前 generation、内容属性、注册摘要和 5 秒时限检查。没有新 HEAD 路由或权限。整链测试已移除 canary 校验替身；原生产代码在新增测试中失败，修复后通过，canary generation 漂移时原生边界不会发上传 POST。

验证覆盖真实 producer → 注册 receipt → pinned 源字节 → 准入 → Python OwnerBridge 当前 pointer/canary 检查 → 唯一 CAS → 独立 generation 字节回读。使用脱敏内存存储和模拟时钟，覆盖 45 秒准备、一次公共 GET 超时、60 秒准备上限、临近 30 分钟过期、香港跨日、倒序时钟、准入拒绝、canary 漂移、412 和损坏回读；不以合成成功宣称真实发布。Mac 真实 SDK 已完成只读身份/边界、候选与当前 latest 的读取；公共上下文单独连续读取两次通过，但完整只读准入复测仍复现间歇公共 Git 超时，因此真实完整准备路径尚未验收成功。

本次只修发布端及测试，原生产器依赖字节不变。没有权限、账户范围、费用数据或 7 名读者边界变化。此补丁仍须独立的最终签名 head OWNER 评论与三个正式检查；不自动合并、部署或发布。候选过期后不得靠代码合并、重新发 claim 或改日期恢复可用性；若要再生成报告，须另有明确的新尝试注册和运行预算，不能复用已消耗的恢复请求。现有不可变证据继续保留。

## PR421 合并后的一次新恢复登记（尚未执行）

PR421 已在本人精确 head 审批及正式保护检查通过后合并。用户另已批准一次新恢复执行；此前两轮候选均不得作为新的金融来源，原 claim 和不可变对象继续保留。旧登记请求 `78006513-4741-450d-bb86-4af26403600d` 已使用，不能重发。

本次唯一运行登记变更是将 requestId 换为 `8e8d5ce4-aef4-47ea-b6fd-a1e50d4a2383`。报告日仍为香港 2026-10-21；原日 receipt 的对象、generation 和 SHA256 锚点逐字保留。新请求尚未生成 expiresAt、创建 claim、配置任务或取数；执行时才现场生成新窗口，仍须先核实新路径不存在、旧对象不变和没有重复执行。此处不重置旧 claim，也不引入可任意滚动请求的入口。

沿用本次已经批准的完整上限：零构建/推送；Cloud Run 一执行；IB 挂单一次；IB-HK、NOAH-HK performance GET 各一次；Google 与 IB 必要的原身份普通刷新及原缓存/Secret 保存各最多一次；临时配置及条件恢复共两次；最多十份私有证据、合计 32 MiB；原剩余 latest CAS 一次；USD 0.10；原七名读者、不改账。未消耗即仍保留，不因本登记新增额度或持久权限。香港 10 月 21 日业务授权与最后预检后现场生成的 55 秒请求窗口分别检查，不复用旧窗口。

源调用生产依赖与既有批准镜像保持一致；只更新受保护恢复登记及本说明。新登记仍须自己的最终签名 head OWNER 评论和三个正式检查，再正常保护合并，才能进入已获授权的运行流程。取数前完成最新 main/配置/互斥/身份/入口/来源绑定预检；取数后完成真实 GUI、30 分钟新鲜度、唯一 CAS、独立回读和配置恢复。无法合理满足费用上限、范围或期限时停止相应操作。
