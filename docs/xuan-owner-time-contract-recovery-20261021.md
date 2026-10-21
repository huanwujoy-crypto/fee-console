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
