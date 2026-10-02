# 10/5正式恢复：准确授权设计（未部署）

**更新：主方案为真正云端独立触发，不依赖Mac开机。** 详见
`xuan-cloud-independent-trigger-design.md`；下面Mac方案仅可选临时兜底。

PR329只接入有限补读，不能当正式行动报告完成。PR323已有窗口/正式slot/CAS/
already-published证明修复；不合并其未配置来源适配路径作为永久日程。
本研究分支新增纯action evidence adapter与独立Mac触发计划测试，不取金融源。

## 最小完整来源

- 复用正常MCP只读capture：实际all-open-positions/live-orders契约、原raw字节/
  hash、唯一标识、真实采集起止/30分钟时效。无官方更新时间仍可使用已核实的
  独立读取部分，明示上游as-of未知；不要求原子snapshotId或新机器身份接口。
- 目标已结束交易日成交：真实Activity声明期间/更正覆盖或现有已核实执行。
  Trade Confirmation仅六executions/五orders不能证明无其它取消更正，不把
  文件mtime/ReportDate当全账务最终。原文件hash和读回保留。
- 现金：独立CashReport原内容/hash、真实报表日期/期间、trade-date/settled
  口径、逐币种与FX基准；恢复审计匹配不是当前source-reverified。当前余额
  必须经实际per-currency接口或同口径权威证明，本次没有再读取balances。
- 活动买单币种与剩余量：原orders未给currency，不能凭符号/描述猜币种。
  需真实订单合约关联或原只读补充接口；本次不调用新接口。
- 持仓/成交/现金、挂单预占与Sharesight配置逐项交叉一致，未知/冲突只禁相关
  动作与金额，不抹掉已核实部分。不借用另外三个账户同步作XUAN输入。

`action_evidence_adapter.mjs`接收上述真实来源解析后的语义证明，固定枚举输出
partial或eligible-for-private-planning，不含金融值。后者仍须私有计算、原政策、
签名guard与公开回证，不是完整账务最终声明。缺口不靠不存在字段永久阻断。
source身份若不能读取原Flex档案，需单独批准固定bucket/prefix的storage.objects.get；
不能借用Flex服务secret，不能重新生成Flex token/Query。只有父线程核实具体
档案路径/身份后才给精确最小授权，当前不增加IAM或secretAccessor。

## 独立触发：优先Mac原gh认证，无新增云凭据

待准确批准后可在现有Mac安装可卸载launchd agent，每60秒运行固定watchdog。
脚本只用现有gh认证列举/dispatch本仓库原workflow main，不访问/复制GitHub或
IB凭据，不授予新OAuth/IAM，不把原发布secret搬到云端或本地。

需要用户批准的具体动作是：新增并load一个用户launchd任务（不是系统daemon），
允许它后台调用现有gh的只读run list和固定workflow dispatch；指定可持续源码
路径与本地create-only attempt状态目录。候选plist安装位置是
`~/Library/LaunchAgents/com.huanwu.xuan-preopen-watchdog.plist`。当前未写/加载。
不得未经批准配置Mac自动唤醒、网络权限、常驻密钥、KeepAlive无限重试或睡眠设置。

固定dispatch目标：`huanwujoy-crypto/fee-console` /
`xuan-preopen-cloud-producer.yml` / `main`；不接受repo/ref/job/secret参数。
IANA+交易日历按欧洲常规开市T−60至开市；同正式slot有限T0/T+10/T+20 buckets。
原GitHub run pending则跟随，不重复；成功只进入公开日期/hash核验，绝不以run
success作正式完成；local CAS与云端正式slot CAS共同防重。重启后读取本地状态
与真实runs，不能删除锁。原workflow WIF和environment限制不变。

此触发独立于GitHub schedule事件派发，可补救10/2两个cron根本没有run的问题；
仍依赖Mac开机/醒着、已有gh认证和网络/GitHub可用，不宣称无条件保证。
周一须确保Mac当时可执行，并从T−60跟进到T−30目标及正式公开读回。
`mac_trigger_plan.mjs`仅离线纯计划，当前未安装、dispatch或授权后台任务。

## 若需要云端常驻独立触发

Cloud Scheduler可复用原delivery身份调用既有report job的run API，已有该job
限定run.jobs.run；但Scheduler需启用/创建job、被允许代表该身份发OAuth token，
这些是独立权限动作，当前未做。只跑report job不能保证签名发布：原OWNER发布
secret仅在GitHub environment，不能借给云Scheduler/source。要独立触发整条
GitHub发布链还需经批准的认证桥及明确新权限，不能隐瞒或称无需授权。

因此先核实是否已有Mac后台入口；没有则请求上列最小launchd授权。不能用
更多同类GitHub cron代替独立触发，也不能把只生成私有artifact当完整上线。

## 周末验收与周一正式验收

周末只做无金融写入的合成契约/窗口DST/交易日历/CAS/签名/隐私/故障恢复测试，
不改变周六休市安排。周一10/5预期夏令时HKT14:00开始、14:30完成目标；
实际主流程来源完整度、采集时效、精确签名候选、Promote/Pages与公开date/blob/
sourceSHA逐段证据才构成验收，未实证之前不能保证或宣称完成。
