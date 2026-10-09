# 开市前基础版：阶段一代码准备（默认关闭）

本分支只准备代码与合成验收，不是生产启用或真实来源验收回执。它涉及账户身份、来源与发布契约，需要新的 specific OWNER 精确 final-head 批准；PR361 的批准不能继承。不得自动延期既有账户关联、删除或重置今日 start marker。

## 行为与接线

`cloud/xuan-preopen/basis_report.mjs` 是纯 injected preparation 入口。默认 `enabled=false`，没有 CLI、环境变量开关、cloud_io、密钥、真实端点、保存对象、日程或自动发布入口。显式启用仍必须提供 cash producer、Sharesight producer、独立 cash proof verifier 与当前 trusted context。任一失败即拒绝，不把任意 partial 放行。

基础 schema9 的 capabilities 固定为估值与现金报表可用、orders/action 不可用。页面只显示 Sharesight 当前四类估值、IB 报表期末现金与已结算期末现金、NOAH-HK 现金估值，分别列估值来源日、报表覆盖期与覆盖日、取得时间。上游 `generated_at` 无时区，保留原标记并说明时区未提供。各现金口径分列，不相加为现金池或购买力。不取得、继承或推断旧挂单；没有 projected allocation、buying power、买单预占后现金、可补仓现金、全部弹药或具体下单金额。现金 0 是有效值；缺失、null、字符串类型错误不能当 0。

MCP 是完整增强的必需证据，但不是基础准备入口的依赖。现有五来源正常路径保留原算法：三项本轮 IB MCP 原始来源与两个 Sharesight 同日期来源完整验证后才输出 ready。任何不完整增强或原规划失败的 partial 不可成为新完整候选。本阶段没有从 Flex 新造补仓金额算法，也不自动同步 ledger。

## 已知旧 Flex 字典的纯映射

`xuan-ib-flex-cash-adapter.mjs` 接受 `{report,capture,proof}`，其中 report 是 Sep-08 上游候选代码 `public_report` 的 scrubbed 字典，capture 是本轮取得区间，proof 是独立 trusted producer/verifier 的证据。候选代码仅证明历史源码契约，不能证明当前部署配置。

固定检查：`schema_version=1`、`source=IBKR Flex Web Service`、现金 query `1630084` / `IB_Cash_Reconciliation_ReadOnly` / `Last30CalendarDays`、USD base currency 与统一 FX target provenance、真实 from/to_date、私有 `reports/<report_sha256>.xml` archive 元数据、XML与原 canonical content SHA256、capture 区间，以及 source_integrity 的未决类别、cash identities 与 base closing translations。只投影唯一 BASE_SUMMARY 的 string-decimal `endingCash`、`endingSettledCash`；不自行合并各原币现金、不发明 FX。重复/缺失行、非 USD、未决现金映射或非零残差超 tolerance 均拒绝。

`transport_verified`、`archive.status`、hash 自声明不足以通过。独立 injected verifier 必须验证本轮 capture、原归档 XML hash、原含 private account 的 content hash、既定 expected account、当前 association policy blob 与这个精确 scrubbed payload。scrubbed 字典已去掉账户编号，绝不能把它重算成原 content hash。没有默认 verifier；合成 verifier 仅用于测试，不是生产身份保护。

已知上游 MCP 工具名 `ibkr_get_cash_report` 只在 `IB_FLEX_ENABLED=true` 注册，并要求 `ibkr:read`。旧 app REST 只有 Sharesight routes，没有现金 REST；现有日报 Sharesight REST bearer 不能证明现金授权。weekly query `1650083` 不可替代 cash query `1630084`。不能使用旧 callback、默认包含 write 的 issuer 或重授凭据来补接。

## HTML 与独立发布复核

正常云成品与基础合成成品均使用 schema10 封套：reportHash、每来源 rawHash/起止时间、aggregate sourceHash、sourceDate、pre-read association receipt、association expiry 与 previous source SHA 全部在 canonical HTML marker 内。来源 hash 是内容绑定，不能独立证明来源认证；原归档与账户认证由上述 verifier 保证，正常 MCP 身份仍受既有有期限 owner attestation 及显式矛盾 ID 拒绝保护。

正常 cloud receipt 同时携带相同证据。publisher 在 mutation 前复核 HTML与receipt相等、每source rawHash、当前 policy、reserve、anchor、main及新鲜度。Validate/Promote 的已有 trusted-main guard CLI 对新正常候选要求绑定封套，独立 fresh-fetch 当前账户 policy。30min 取数起点新鲜度、5min 取数区间沿用现有 publish 合同；排队后过期/撤销/policy blob变化、HTML或sourcehash损坏都拒绝。CLI 始终默认拒绝基础 schema9 封套，没有生产 enable flag。原 schema1–5 仅保留历史渲染与纯测试读取；不能作为新无证据候选发布。schema7/8 既有独立限定契约保留。

页面状态由真实 report status/date 决定，客户端不再按钟点猜测“更新中”或把 partial 覆盖成 ready；正常页仅轮询新 canonical marker。immutable daily start、Validate/Promote/Pages、公网 bytecheck 均未移除或扩权。

## 合成运行与真实验收的最小缺口

用 Node24 运行 `node --test cloud/xuan-preopen/*.test.mjs scripts/xuan-ib-night-action*.test.mjs scripts/xuan-ib-hook-response.test.mjs scripts/xuan-ib-source-adapter.test.mjs scripts/xuan-ib-association-sources.test.mjs`。所有新增测试均使用 synthetic dict、mock proof和context，不读取来源、Secret、Keychain、OAuth或email，不写marker。全量回归为 `node --test --test-concurrency=2 scripts/*.test.mjs cloud/xuan-preopen/*.test.mjs`，本轮额外通过 validation-only Node 网络 deny preload 阻断真实HTTP连接。

真实验收仍被以下具体缺口阻挡，不因合成通过而启用：

1. 由 owner 选择并批准一个固定 existing cash receipt/archive 输出通道及其当前生产合同；优先已授权产物读取，不在日报里调用原同步服务。当前没有已确认 cash REST endpoint、对象 bucket/prefix、receipt签发者或部署版本，故这里不假造配置。
2. 独立 trusted verifier 的部署身份、输入字段/签名与私有 expected-account 校验。需原 XML archive hash、原 content hash、scrubbed payload hash、query identity、报表覆盖日、取得receipt起止时间、archive对象generation与私有访问限制。私有账户编号不得进入公共HTML或日志；`generated_at` 的 timezone 未知仍不得伪写UTC。
3. 若选 archive 通道，最小权限是指定固定receipt/archive对象的只读 `storage.objects.get`；不能 list、write、跨prefix取对象或访问其他报表，不读取Flex secret。具体资源尚未知，必须确认后列精确 IAM 条件再批准。若必须新 live cash 通道，则单独批准固定只读 `ibkr:read` cash query与身份，不复用Sharesight bearer、不用weekly secret/query、不申请write/OAuth重授；本分支无此接线。
4. 上述明确合同、必要IAM与真实五来源/基础三来源验收获 specific OWNER finalhead批准后，再实现受审生产enable契约。当前基础模式无正式发布通道；真实 shadow、候选提交、公网 bytecheck、日程或生产部署需单独批准，不运行现有今日绑定失败的job，不重置marker。
5. 当前账户 association 到期闸门保留；只有2026交易日历完整覆盖，独立部署时钟情况仍未确认。Oct8失败与一次invalid_grant只证明该grant被拒，不证明根因或必须换grant。PR361仍为未合并独立诊断补丁，未取其批准作为本分支授权。

阶段二 attempt-state/OAuth单写者未纳入。本阶段没有发布、源权限、IAM、schedule、marker或fee生产输出变更。

上线顺序也属于新的批准边界：新增 schema10 成品必须先由已批准合并的 trusted-main guard 能识别，再部署不可变新正常 worker/publisher镜像。旧 worker 输出的 schema5 会被新正式guard拒绝；旧 publisher 也不能接收新封套。过渡期保留旧正式报告，不降低guard要求、不宣称“只合并就启用”。基础版获取通道与正式enable仍需后续受审契约，本分支合并本身不会开启它。

## Astra 阶段一复核修复

两项 P2 的五种接受异常已转为拒绝回归：来源日必须是实际存在的日期，schema10 的 visible sourceDate/现金覆盖日/NOAH估值日必须与 evidence.sourceDate 相同；现金、Sharesight分类与NOAH三个取得时间分别对应各自来源的 completedAt，不能借用另一来源或新鲜封套盖住旧可见时间；capture开始与完成的HKT日期均须等于报告日期。正常五来源schema10也执行真实日期、报告日期/来源日期caption与capture日期检查。

旧 `cloud/xuan-preopen/calendar.mjs` 的日历表和语义逐字节移动至唯一 `scripts/xuan-ib-preopen-calendar.mjs`，cloud模块 re-export 原四个API。prepare与独立final bound validator共用 `planPreopen`：eligible报告日必须仍有既定市场开市，sourceDate必须是该报告日的previous NYSE session。任意旧日、休市或未覆盖年份在prepare调用context/producer之前即拒绝；finalguard独立重复目标日检查，不能只信prepare回执。没有扩日历、推断新年份或新增schedule。trusted-main的既有全scripts archive即可加载新纯日历模块，不依赖cloud目录，也无需改保护workflow。

新增测试使用fixture建立时冻结的独立synthetic HMAC oracle；修改XMLhash、原contenthash、scrub payload、capture、policy、proof或私有账户，即使自行重声明“verified”，仍不能通过。HMAC仅是合成验收证明测试的独立性，未作为生产签发者/密钥实现。另验证cash0、报表覆盖日与未知时区生成标记不因fresh receipt刷新变更、各来源不同完成时间分列、正常五来源→schema10→mockpublisher、仅scripts依赖的finalvalidator可加载，以及共享日历原字节hash/API身份不变。
