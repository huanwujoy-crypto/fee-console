# 基金更新（不依赖 Claude）

本候选改为周报／月报发布；内部仍逐日计算。日期、批量重建、月末锁定、
前台快照及一次历史预览的现行合同见 `docs/fee-report-periods.md`。
以下逐日来源、费用、加密和受保护推广规则继续适用；旧日报触发不恢复。

本流程只负责「投资管理费」的每日 AUM、费用和投资人份额回执。
`xuan-ib/` 是另一条发布链，不能与此处的 `data.json` 候选合并。

## 数据与权限

- 纽约前一交易日为目标日。先以固定 Sharesight Native `direct` 只读客户端实时解析
  `Schwab-HK` 与 `Webull` 的 portfolio ID，再读取相同目标日的 performance、
  holdings、cash accounts、cash transactions 和最近交易；不能用截图或 Webull
  即时总资产替代目标日 Sharesight 值。连续两次读取同日快照并比较来源身份、日期、
  总额、持仓、现金和流水，只有稳定时继续。
- `docs/daily-data-contract.md`、`docs/fee-style-registry.md`、
  `docs/fee-economic-source.md` 和 `docs/fee-calculation-receipt.md` 是计算合同。
  `scripts/daily.mjs` 仍是唯一的 `data.json` writer；投资人份额、管理费和 Carry
  只由该 writer 与同一份 v4 私密经济账本生成，不能由调度提示词重算。
- `FEE_DATA_KEY` 和 `FEE_ECON_GIST_ID` 只在受控本机 Keychain，或经
  `docs/fee-cloud-producer.md` 验收的专用 GitHub Environment secrets 中提供；
  不得放进仓库、普通 Actions、参数、日志或聊天。producer 按精确 Gist ID
  匿名读取加密密文，不需要第二个 GitHub PAT；管理人写入令牌不交给每日程序。
  原 Claude 环境中的凭据不会自动转移；云端 Sharesight 使用独立凭据，不能导出
  本机 Keychain 凭据代替。
  凭据未完成独立配置及实际读回验收时，此流程**未激活**，不能发布候选。
- 若目标日尚无完整 SPY/QQQ 同日收盘资料，按合同只发布可独立验证的 AUM，
  留下 benchmark pending，随后同日 replacement。不能用较早价格假装当日价格。

### 本机一次性接入

1. 先完成一次性换钥匙迁移，取得**新**管理人链接并核对新私密 Gist；
   已泄露的旧链接不能用于日常接入。
2. 若一次性迁移程序已把新链接保存在仅本人可读的本地文件，运行
   `./scripts/codex-fee-setup setup-file <该文件的绝对路径>`；程序拒绝链接、
   组或其他用户可读取的文件及符号链接。也可在 Mac 自己的 Terminal 运行
   `./scripts/codex-fee-setup setup` 并在隐藏提示中粘贴**新**管理人完整链接。
   它只提取新 Gist ID 与新 32-byte 加密 key，
   **不保存或使用管理人写入 token**；两个只读运行所需值写入本机登录
   Keychain，服务名前缀 `fee-console.codex.`。链接不进入聊天、命令参数、
   shell history 或仓库文件。若输入被取消或格式不符，程序拒绝写入。
3. 运行 `./scripts/codex-fee-setup check`；它从 Keychain
   读取两个值，用受限 GET 连续核对新 Gist 两次、解密核对 v4，再重读两次，
   成功只输出 `CODEX_FEE_SOURCE_READY_V4`。这只证明独立来源可用，
   不能代替 Sharesight、资金流、费用回执和手机发布验收。若当前原账本仍为
   v3，按既有迁移规则单独处理，不能在接入程序里静默改写原账本。
4. Codex 每次运行在受控进程里用 `/usr/bin/security find-generic-password`
   分别读取上述两个 Keychain 服务并捕获到内存环境变量，绝不打印值。
   只让固定的 `fee-economic-source.mjs` 和原 writer/reporter 看到这些变量。
   Keychain 弹出访问确认、Mac 锁定或首次读取失败时立即停止，
   不退回到 Claude、浏览器 token 或明文账本。

### 本机独立 IB 加密附件（仅候选，不发布）

完成准确版本代码批准后，可用现有入口
`./scripts/codex-fee-setup attach-ib <私密计划文件绝对路径>`。
它只附加已确认的 IB 收益／回撤回执，不读取券商或 Sharesight，不改原经济账本，
不将 IB 加入原管理费组合。必须另有本次具体输入及限定本机密钥用途的批准；
JSON 计划、自称 approved、测试回调或文件 hash 都不是授权凭证。

计划及所有输入应在同一仓库外 0700 目录，均为本人拥有、0600 的普通文件，拒绝符号链接。
计划使用 `fee-console.ib-local-attachment-plan.v1`，只允许 `schema`、`targetDate`、
`workspace`、`baseData`、`baseHealth`、`ibInput`、`legacySource`；四种输入均以
`{path,sha256}` 固定完整字节，`legacySource` 对无 legacy-v2 来源可为 null。
v3-copy.v2 仍须独立原始来源文件，不能从嵌入副本制造原始凭证。
计划文件在每次使用前后也重新核验。输出固定为该目录的全新 `candidate/`，不覆盖已有文件。

必须以干净本机环境运行，不继承密钥、Gist定位项、经济来源令牌、GH_TOKEN／GITHUB_TOKEN、
NODE_OPTIONS／NODE_PATH 或动态库注入。拒绝 GitHub Actions、非 Mac、调试／预加载／
内存转储启动参数。命令自身不会取得代码审批；使用前须独立核对已批准且已受保护合并的
准确源码，再运行。程序进一步匿名 GET 固定公开仓库的 main 元数据，核对 GitHub 验证签名、
本人不可变身份、本机 HEAD／干净树、所有 mjs 源文件字节，以及基底 data/health 的 Git blob。
公开元数据重定向、截断、变化、未合并源码或脏工作树均停止。

读取 Keychain 前，必须有原组合同日真实、未过36小时的成功健康回执，且目标仍在原四 UTC
日窗口内。仅按固定 account 与两个 service 读取，不回退到其他凭据，不重试系统拒绝，
不创建 Key／ACL／Secret。密钥不进参数、日志或文件；定位项只去原固定 Gist GET，
原来源工具双读并在完成后再双读。系统访问确认或拒绝应停下交由本人处理，不扩大权限。

在稳定 v4 经济来源下，顺序调用唯一 writer 的 `--ib-return-only` dry-run、execute，
再用原 reporter 的 `--format=validate` 核验；解密重建 IB 回执，比较原费用回执和全部
非 IB 字段完全相同。子进程只接收最小环境，输出必须为固定成功字串，多余输出或任何
错误均拒绝，CLI 不显示原始异常。临时经济来源仍为加密0600文件，结束清理；新密文和
本地验证记录为0600。失败只删除自己创建的已知候选，遇未知文件保留现场并报清理失败。

成功只输出 `IB_LOCAL_ATTACHMENT_STAGED_HEALTH_PENDING`。本地验证记录明确
`healthCreated:false`、`publicationReady:false`；不复制、改时钟或改 hash 来伪造健康回执，
不签名、上传、推广或启用日程。新的真实来源／style／精确候选关联与健康、受保护推广及
解锁页面验收仍是后续独立闸门。程序仅尽力清理内存引用，不承诺 JavaScript 字符串可被
可靠擦除；限定短生命周期进程，禁止调试与转储。

### 同一期 IB 附件的健康衔接（本机审核候选）

新增入口 `./scripts/codex-fee-setup finalize-ib <私密计划文件绝对路径>` 仍须
准确源码受保护合并、本人批准的限定本机用途及具体输入；不是新的自动生产器。
它读取已存在的 IB 加密附件，不调用 writer 重新加密，不取 Sharesight／券商数据，
不创建私有存储通道、Secret 或持久权限，也不自行签名、上传、推广或启用日程。

计划 schema 为 `fee-console.ib-local-finalize-plan.v1`；沿用上节的七个字段，
再加 `candidateData:{path,sha256}` 和
`producerEvidence:{runId,candidateSha}`。全部文件仍须在同一仓库外0700目录且为0600；
输出只能是不存在的 `finalized/`。计划不接受 approved、style 成功声明或任意 API 地址。
运行前须固定真实 producer run、该 run 实际输出的已签名候选，以及该候选的完整
base data／health 字节，不能只提供相近时间的成功运行。

在读取两个既有 Keychain 项之前，入口使用既有本机 gh 客户端，以固定仓库 GET 查询
Actions run、完整 jobs 和实际 produce job 日志。原始日志只在内存中，不输出或保存。
要求 main 上的原工作流首次运行确实成功，实际来源计算／style 步骤及签名步骤均成功，
不能是 skipped、shadow、失败或其它工作流。日志中的唯一候选 OID 必须匹配；
该候选须为原运行 head 的单亲 GitHub 已验证 owner 提交，只改原 data／health，
其 Git blob 须精确匹配计划基底。原 checkedAt 必须落在实际 produce job 时间内。
来源、writer、health、style 配置及 producer 工作流代码必须与原运行相同；
仅本机衔接入口及测试不参与这项继承比较。所有本机 mjs 字节仍须匹配当时受保护 main。
任何 API 身份／签名／日志／完整性缺项均在读金融密钥前停止，不回退到手工成功标记。

#### 日志格式及单请求批准边界

GitHub的job日志REST接口下载纯文本，gh run view的JSON字段不包含日志中的候选OID。
gh 2.98默认拒绝API输出中的终端转义；不得删除日志关联证明、换传输规避拒绝，
或把允许转义的原始输出送往终端。官方run view虽然会净化控制字符，但同时缓存原始
run日志ZIP，故不用于此处“原始日志仅内存”的合同。

本入口的格式适配只在固定actions/jobs/<id>/logs请求上添加
--allow-escape-sequences，属于必须在新准确源码及执行包中明示批准的单请求格式选择；
旧head批准不能替代。它不改变gh全局设置，不新增权限或日志端点。metadata请求不带
该选项。stdout/stderr始终为私密pipe，日志以最多2MiB的原始bytes捕获，UTF-8解码
严格失败关闭；不调用终端、pager或浏览器，不保存或输出原文。

仅规范CRLF行尾；其余C0/C1、CR、BOM、双向／零宽等控制字符转换为惰性转义文本，
不删除、拼接、重放或执行。因此控制字符不能修补出candidate或OID。仅接受一条完整
UTC时间戳加candidate加40位小写OID的原生stdout记录；命令回显、格式化标题、
错误日期、重复或多OID均不能作为证明。返回仅有时间与OID，不返回原文。
记录时间须在实际成功签名step的区间内。API若仅给出整秒结束时间，该秒的毫秒属于同一
已完成区间；带毫秒的结束时间按原精度严格比较。这不延长健康36小时、四日窗口或来源
checkedAt。签名、步骤、完整tree／blob、代码匹配及费用／非IB比较全部保留。

官方依据：
[日志REST接口](https://docs.github.com/en/rest/actions/workflow-jobs#download-job-logs-for-a-workflow-run)、
[gh run view字段](https://cli.github.com/manual/gh_run_view)、
[gh 2.98缓存及净化实现](https://github.com/cli/cli/blob/v2.98.0/pkg/cmd/run/view/view.go)。
该适配只经离线合成验收不能授权真实日志重试、金融Keychain读取或发布；均等新版本保护
及明确限定执行批准。失败的旧入口没有读取金融Keychain或发布IB密文。

通过来源证明后，仅用既有固定服务读取本机密钥与原经济 Gist 定位项，双读稳定原加密
账本；重建已确认 IB 输入的收益与日度回撤回执，要求与已有附件完全相同，且费用回执
和全部非 IB 字段不变。随后以原 reporter 核验，并由既有 `fee-data-health.mjs`
生成绑定新密文字节的健康文件。原 sourceDates 和 checkedAt 原样保留，36小时与
四 UTC 日窗口在执行前后均检查，不能延长健康期限、修改旧回执或伪造新取数。
新的健康文件表示同一期已验证来源加经重建的独立附件；不声称 IB 后续日期已自动接通。
公开健康 schema 不增加账户资料、金额、IB 收益值、私有路径或输入 hash。

成功只输出 `IB_LOCAL_BOUND_HEALTH_READY_FOR_REVIEW`。三个本机0600文件为既有
data 字节、新 fee-data-health.json 和私有 validation.json，后者记录原 producer／
候选关联及 `readyForSignedCandidate:true`、`publicationReady:false`。
正式签名候选、validate-fee-data、受保护推广、Pages 字节回读和解锁后的真实 IB
验收仍须完成。此入口本身不授权这些动作。失败清理仅限自己创建的文件；保留原候选、
原健康和原输入。过期、源变动或 main 变动均关闭，不能刷新旧时间来继续。

周／月开关 `FEE_REPORT_PERIODS_ENABLED` 与该历史附件衔接独立，仍按
`docs/fee-report-periods.md` 的受保护验收后配置。仅打开开关不能补足未来 IB 来源：
现行 `IB_SOURCE_COVERAGE_UNVERIFIED` 截止和 native checkpoint／baseline 闸门保留。

## 每日顺序

云端主路径与下列数据、计算和发布顺序相同。其固定 GET-only reader、双读、
shadow/publish 切换、秘密边界和停用方法见 `docs/fee-cloud-producer.md`。
本机流程在云端完成真实发布回读前继续作为备用，不能与云端 publish 同时运行。

1. 读取 `main`、现有健康回执及私密来源，确认目标日期、允许的回补窗口和无并发候选。
   先核对基金 Gist 的 owner、secret 可见性、文件名；两次 revision 原字符串及完整
   加密信封原文字节必须完全相同，ETag 按 `docs/fee-economic-source.md` 的唯一受限
   弱标记兼容规则核对（只允许 `W/` 标记不同，opaque tag 仍须完全相同）；
   只能使用 `scripts/fee-economic-source.mjs` 的固定来源读取路径。
2. 在仓库外的私密临时目录准备来源快照和 `FEE_STYLE_INPUT_FILE`，用真实持仓身份
   运行 `scripts/daily.mjs --style-preflight`。新 Sharesight 输入按
   `docs/fee-style-registry.md` 的明确源类型模式自动把普通股归“股票”，ETF、债券、
   现金、其它及待分类保留原值；不再逐票区分 growth/value 或等待 proposal。
   缺少类型只是报告待分类，不替代或放宽来源、金额、资金流及费用回执校验。
3. 确认最近现金流水中的内部交易、外部本金和投资人归属。已确认的 Jenny Z
   新增本金只能沿用私密账本中的对应确认，不得再记为 XiXi Z 或重复发行份额。
4. 在同一稳定来源和私密账本下运行 `scripts/daily.mjs`。随后用
   `scripts/fee-receipt-report.mjs` 验证费用回执，并用
   `scripts/fee-data-health.mjs create-success` 生成不含金额的运行回执。
   立即按同一规则双读重查来源并与冻结快照比较：revision 原字符串、完整信封原文
   字节和 ETag opaque tag 必须完全相同，仅允许合法 `W/` 标记不同；任一失败均不得提交。
5. 只从当时最新的 `main` 创建一个分支
   `codex/fee-daily-YYYYMMDD-xxxxxx`，其中日期无连字符且必须与
   `daily YYYY-MM-DD` 的提交标题及健康回执目标日一致。提交仅允许
   `data.json`（真正变化时）与 `fee-data-health.json`；无变化时只提交健康回执。
   用 GitHub GraphQL `createCommitOnBranch` 一次提交一至两个文件，
   并要求 `expectedHeadOid` 等于刚核实的 `main`；GitHub 会为支持的账户
   签署此提交。随后回读 REST commit，必须为 `verified:true`、author 为
   `huanwujoy-crypto`；本地未签名 commit、两次 Contents API 单文件提交
   都不能作为生产候选。
6. `validate-fee-data` 验证候选；受保护的 `promote-fee-data` 从默认分支
   再验证并推广，Codex 不持有推广用 deploy key。推广后回读 `main` 的
   `data.json` hash、健康回执、Pages 页面数据日期，以及 Jenny Z／XiXi Z
   份额和市值。仅提交、校验开始或 Pages 构建开始均不算完成。

## 失败处理

- 只读来源、私密账本、密钥、资金流、费用回执或推广回读有缺口时，
  保留原数据，报告具体闸门和最后已验证日期；不造数、不直接改 `main`、不把
  管理人链接中的密钥提取到脚本，也不借用 Claude 的凭据或提交身份。
- 运行回执可区分 `updated`、验证后的 `no-op` 和未运行。GitHub watchdog
  继续在香港时间生产窗口之后检查主分支，当天没有合格回执就标红。
- 云端 producer 只对短暂的网络或两次读取不一致重试一次；身份、金额、资金流、
  回执和权限错误立即失败关闭。连续两次 producer 失败后，无秘密 supervisor
  仅创建一个供 Codex 诊断的 repair issue；它没有账本密钥或发布权限，不能直接
  修改 `data.json`、私密经济 Gist、管理费付款或投资人份额。
- 启用 Codex 调度前，先完成一次真实目标日的只读源稳定检查、私密来源和
  费用回执验收、候选验证、推广与 Pages 回读。Mac 关机或本地凭据不可用时，
  本地 Codex 调度不能承诺无人值守完成；这类情况必须明确报告为未更新。
