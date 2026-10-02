# XUAN云端独立触发：待准确授权，未部署

本方案替代Mac常驻作为主路径；Mac launchd仅可选临时兜底，非周一主方案。
参考PR326的隔离relay结构，但不借管理费身份、state、凭据或权限。
10/2只读确认本project已启用Cloud Scheduler、Cloud Run、Secret Manager与
Storage API。没有新建任何服务、secret、身份、job或IAM绑定。

## 路径与固定范围

Cloud Scheduler → IAM保护的Cloud Run `xuan-preopen-trigger-relay` → GitHub
原workflow dispatch → 原WIF/source job/OWNER签名候选/Validate/Promote/Pages。
relay只负责触发与无金融值证明，不取IB/SS/Flex、不计算、不发布任何财务资料。

Scheduler以Europe/London时区 `0,10,20,30,40,50 7 * * 1-5` 调relay：常规08:00
开市前60分钟开始，7:30为完成目标，后续只按真实状态跟进。IANA自动处理夏冬；
relay再用现有五市场日历/前一完整NYSE交易日/有限三个正式attempts验窗。
30/40/50分触发不增加attempt总数，pending/accepted/unknown不再dispatch。
开市后不新取源。GitHub cron保留第二入口，但不承担唯一触发责任。

固定POST endpoint：
`https://api.github.com/repos/huanwujoy-crypto/fee-console/actions/workflows/xuan-preopen-cloud-producer.yml/dispatches`
payload只有 `{"ref":"main"}`。不接受请求中的repo/ref/workflow/URL/账户/
secret/日期/金融payload；HTTP body只能为空对象，日期来自服务可信时钟和日历。
Cloud Run无allUsers绑定、只接受Scheduler身份的OIDC，audience固定服务URL。

## 需要用户另批的精确权限和凭据

| 新资源或身份 | 唯一授权范围 |
| --- | --- |
| `xuan-preopen-timer@family-portfolio-gateway.iam.gserviceaccount.com` | `roles/run.invoker`只绑定新relay服务；不授予job.run、IB/Flex/SS或secret读取 |
| `xuan-preopen-relay@family-portfolio-gateway.iam.gserviceaccount.com` | 仅新dispatch-key secret的`roles/secretmanager.secretAccessor`；仅新state bucket的自定义storage.objects.get/create；无list/delete/update、无原金融或管理费secret、无report job执行/override |
| 新secret `xuan-preopen-relay-dispatch-key` | 用户单独创建的GitHub App私钥（优先），仅供relay访问；不读取/复制GitHub environment的FEE_CLOUD_GITHUB_TOKEN或任何原secret |
| GitHub App/installation | 仅仓库`huanwujoy-crypto/fee-console`，Actions write（包含read）及必需Metadata read；无Contents write、Administration、Gist或金融系统权限；installation/repository ID固定配置，由用户安装/提交新私钥 |
| state bucket `family-portfolio-gateway-xuan-trigger-state` | 只保存slot/date、attempt、固定结果码、GitHub run ID和hash；与金融bucket完全隔离 |
| relay服务及Scheduler job | `asia-east2`、固定镜像digest、上述固定身份/URL/OIDC audience；Scheduler代表timer身份，需要创建者对该身份的actAs；确认原Google Scheduler service agent已有官方serviceAgent角色，缺失时另批，不能拿它作timer身份 |

Actions write是GitHub dispatch API支持的最小权限，平台本身不是单workflow
scope；固定endpoint限制由已审查的relay代码执行。不能把新credential当OWNER
发布token。App installation token按需mint、短期仅内存，不保存token新版本；
key轮换由原owner安全提交新secret version，relay没有addVersion权限。
可替代为用户单独生成、此单仓库Actions write的短期fine-grained PAT，但
不得复制原environment token，也不能宣称已获授权；同样需要新secret与批准。

本scope需同时批准创建/部署relay、两个服务身份/上述精确绑定、新state bucket、
新secret及GitHub App安装、固定Scheduler job。没有此批准则只保留代码设计。
所有配置/镜像/工作流变更仍遵守原OWNER精确head审批，不以云trigger绕过。

## 幂等、未知POST与真实发布证明

`cloud_relay_decision.mjs`已实现纯策略与CAS编排，尚无生产HTTP/storage/collector。

1. collector独立确认main已部署真实来源adapter及原publish mode，不允许未配置
   来源路径成为“成功”；核验当前formal slot、sourceDate、GitHub runs及签名候选。
2. 只有public/main meta/date/sourceSHA/blob与已核实capture window/来源日一致、
   签名source commit真实时才formal done。schema7 partial或workflow绿灯都不能done。
3. pending producer跟随；successful producer待候选/Promote/Pages时跟进不二读。
4. `state/{slotId}/attempt-N.json`使用GCS `ifGenerationMatch=0` create-only；
   并发胜者再读GitHub/current facts后POST一次。原workflow concurrency与云端
   slot CAS为第二/三层防重。claim写在POST前，永不删除或覆盖。
5. 204只表示accepted，不含runID。网络超时/不明回复保留unknown，查询实际runs
   而非按“暂时没看到run”自动重POST。只有真实关联run已结束失败才可后续有限
   attempt；max三次源运行，不无限重试或延迟假扮准时成功。
6. result对象单独create-only，固定accepted/uncertain/suppressed；不保存HTTP
   诊断、token、原始报告值。state GET失败/未知时停止，Scheduler重试也先读claim。
7. 公开迟到/partial/来源缺口给固定失败状态并留真实时间，T−30不是绝对保证。
   alert通过用户已批准渠道；不因恢复需求自动新增消息发送权限。

需要在授权后完成：无账户数据的真实collector、固定App token adapter、GCS
create/get adapter和认证HTTP handler；先stub验并发/未知POST/服务重启与日历，
再一次获准真实dispatch，逐段验WIF/source/签名/Validate/Promote/Pages/public。
合成策略测试不是上线验收。暂停专用Scheduler为回滚，不动历史锁或金融数据。

## 周一完整来源：原runtime正常读，而非借credential

原source身份已核实是`xuan-preopen-source@family-portfolio-gateway.iam.gserviceaccount.com`。
原私有bucket对它的直接绑定仅objectCreator，不能假定有档案GET。原OAuth
summary/positions/orders可按正常read_only capture运行；现有schema另提供
balances逐币种及trades DAYS_7（UTC边界），新image适配必须先验证真实raw语义，
本次没有调用这两项或再次refresh。

为了目标日已完成成交/现金，父线程或现有获准档案渠道仍需提供：

- 目标日真实Flex原文件的固定私有引用/hash；交易时间/ExecID/OrderID/币种/
  费用及更正覆盖声明（若源无则unknown），不能只有订单保存结果。
- 现金原CashReport原文件/hash、真实date/period、trade-date/settled/FX口径。
  现有恢复审计匹配和旧区间现金XML不满足目标日source-reverified。
- 若复用现有档案，用户需批准原source身份仅固定目标档案prefix的
  `storage.objects.get`（不list、不secretAccessor），或批准现有档案渠道将
  验证过的文件交付到原XUAN私有bucket固定`source-evidence/flex/`prefix并对
  此prefix给get；未给具体真实路径之前不创建泛化授权/复制金融行。
- 活动订单币种需原只读合约/订单权威关联，不能猜description；当前cash balance
  的可用/已结算口径与FX也须真实接口说明及回证。持仓/成交/现金/预占/SS配置
  逐项交叉一致；未知仅禁相关金额，不抹掉独立已核实部分。

不要求不存在upstream asof或snapshotId；明示读取时间、源声明时间/期间与未知
项。原owner-attested政策继续有效，不升级身份认证、不续政策。账户、现金或
来源不齐时输出准确有限状态，不能让调度成功掩盖来源失败。

## 官方依据

- [Scheduler HTTP目标认证](https://docs.cloud.google.com/scheduler/docs/http-target-auth)
- [Cloud Run定时服务与invoker](https://docs.cloud.google.com/run/docs/triggering/using-scheduler)
- [GitHub workflow dispatch及Actions write](https://docs.github.com/rest/actions/workflows)
- [GCS create-only对象前置条件](https://docs.cloud.google.com/storage/docs/json_api/v1/objects/insert)
