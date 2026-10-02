# 有限核实补读接入（未上线）

此独立开发分支不含 PR323 的未配置来源适配路径，不改常规定时窗口。
它将已有 source-check capture 与另行核实的目标日成交摘要准备成 schema7。
不重新取源、续期、不制造上游 as-of/原子快照，不给行动金额。现金仅说明恢复
审计吻合且独立报表口径证据不足；活动订单未提供币种时不核实资金预占。

公开模型只允许固定状态枚举、读取时刻、目标日、原业主关联回执、证据摘要
hash和上一份报告日期/来源指针；禁止账户标识、持仓、订单、成交和现金数值。
页面明确临时补读、常规开市前/后时点与独立核实程度，不计作盘前完成。

准备器验证原对象字节 SHA-256、canonical raw fingerprint、三来源唯一、
采集起止、唯一持仓/订单标识、目标执行去重与保存的 Sharesight 对账摘要。
保留六 executions 与五 orders 的独立语义，不把订单数当执行数。
摘要来源不能冒充实时原始证据，取消更正和全账务最终性仍未证明。

## 原受控渠道的发布步骤

1. 本分支代码通过全部检查、OWNER精确head审批后，按原流程合并；不能由代理
   代发 `/approve-xuan-ib-maintenance <40位head>`。
2. 仅复用已保存 capture 生成 report.html 与 receipt.json，独立读取最新main政策
   和上一版meta/HTML；本地候选不代表已发布。原30分钟采集时效仍适用。
3. 将两个已验证无金融值文件以 create-only 写入原私有bucket既有授权
   `delivery/当天/limited-readback-证据SHA256/`。不写 start.json，不占正式锁，
   不覆盖旧对象，不写原始金融资料或凭据。
4. 只 dispatch 原 `xuan-preopen-cloud-producer.yml`，提供这个固定prefix。
   同原main、environment、WIF provider/identity、secret引用；新分支跳过
   source job，只GET两个既有delivery对象。无需新OAuth/IAM/凭据复制。
5. publisher重新验证30分钟、原政策/前版、模型与receipt/hash，使用既有OWNER
   GraphQL签名单文件候选；Validate→Promote→Pages→公开meta/date/blob读回。
   独立guard再次核验政策和时效；同日完整报告不能被有限状态降级。
6. 若准备或审批完成时 capture 已超过30分钟，停止发布，不重标、重新取源或
   放宽门槛。只有后续明确授权的正常capture可以产生新的有效候选。

新workflow input仅选择原私有delivery前缀，不接受URL/账户/secret/job参数。
默认cron和无input dispatch行为保留原流程，不将本变更视为周一已解决。

## 周一正式目标的剩余事项

PR323已实现欧洲IANA窗口、旧验收隔离和正式发布证明，但真实来源适配与
生产镜像仍未接线，不能直接合并其 SOURCE_ADAPTER_NOT_CONFIGURED 路径。
本有限报告不能替代完整行动方案。应分别补足现金口径与活动订单币种证据，
或按已核实部分生成有限版并明确边界；不得要求官方未提供的字段永久存在。
10/2两个GitHub cron未创建run，独立调度入口需另行核实/批准权限，不能声称
仅增加GitHub cron就能保证10/5触发。周末只修复验证，10/5真实运行与公开
读回仍是正式验收，首次时效和发布日期须实证确认。
