# 新增持仓分类：一次决定，持续复用

## 业务范围

Wu 已授权 Codex / Claude 对新增仓位的 growth / value 报告分类作决定、复核和计算，
实际发布完成后通知一次，不再逐只要求用户选择。不涉及买卖、资金划转、Sharesight
写入或 XUAN 的 T1/T2 风险分类。这里的分类不会改变账户总额或费用计算口径。

## 固定任务执行顺序

1. 读取最新 `main` 的代码和加密 `data.json`，记录原有分类事件 ID。按日更合同取得
   两个账户相同估值口径、完整分页、连续两次稳定的只读持仓和股票小计。现金账户、
   SGOV、其它资产不进入股票输入；保留其原本 cash / other 口径。金额统一为 USD。
2. 在仓库外私密临时目录（目录 0700、文件 0600）生成下述输入，设置
   `FEE_STYLE_INPUT_FILE`。这是路径环境变量，不能把内容、标识、哈希或密钥放入
   命令行、Git、通知或公开日志。原始完整源不得复制入发布数据。
3. 使用原日更参数加 `--style-preflight`，不传 `--growth` / `--value`。
   该步骤只读，读取原加密 registry 并返回状态/缺失行号；不更新数据、不检查或签发
   费用回执。`STYLE_MISSING_ROWS_...` 是按 portfolios 顺序展开的 **零起算行号**。
4. 有缺口时，由 Claude 根据发行人业务/产品资料及已核对的持仓身份分类，再由独立
   复核上下文审查（例如 Claude 的只读 review 子会话，或可用时由 Codex 复核）。
   定时任务不得因等待本地 Codex 或用户上线而悬置；在原授权运行环境内完成两次
   分离的判断并记录实际上下文标识，不能把同一次判断换个名称当复核。
   证据必须支持投资风格，不可只看 ticker/name；基金/衍生品需
   核对实际策略。不确定时由 Codex 负责解决技术异常，不向用户反复索取分类决定。
   给 `proposals` 加入记录后重跑预检。身份冲突、缺证据不能靠默认 growth 通过。
5. 预检成功后按原经济源获取、回执和原子 writer 路径实际运行（不带预检旗标）。
   registry 与当日 growth/value 同一次加密写入。原经济源失败仍必须停止；预检通过
   不替代正式验收。日更提交仍 **仅 data.json**，不提交静态映射和明文分类文件。
6. 按原 native 签名、Validate、Promote、Pages 流程发布并回读。并发发布时基于最新
   main 重新运行 writer，不能把旧密文强制覆盖。新分类不再需要逐只代码 PR。
7. 对比发布前后 registry 的新 `id`，在原私密任务渠道通知新增分类一次。发布审计
   记录实际消息引用和对应 ID；重试先检查审计，确认已送达的不再发。缺少投递证据
   就不能称“已通知”。`id` 只供去重，不是投递回执，不向公开通知暴露该 ID。
   若发布后通知失败，由同一任务补发，不以重新分类或重新发布解决。
8. `finally` 清理本次私密输入，按原流程清理经济源副本；不改原账本。

## 输入格式 v1（示意，不是真实持仓）

```json
{
  "schemaVersion": 1,
  "date": "2026-09-06",
  "portfolios": [
    {
      "account": "schwab", "portfolioId": 936249, "sourceDate": "2026-09-04",
      "stockTotalUsd": 100,
      "holdings": [{"holdingId": 901, "ticker": "SYNTHA", "valueUsd": 100}]
    },
    {
      "account": "webull", "portfolioId": 1350094, "sourceDate": "2026-09-04",
      "stockTotalUsd": 0, "holdings": []
    }
  ],
  "proposals": [{
    "portfolioId": 936249, "holdingId": 901, "ticker": "SYNTHA", "style": "growth",
    "firstHeldOn": "2026-09-03", "effectiveFrom": "2026-09-03",
    "classifiedAt": "2026-09-06T12:00:00Z", "classifier": "Claude", "reviewer": "Codex",
    "evidenceRef": "https://example.test/issuer",
    "rationale": "示意：核实后的业务依据", "reviewNote": "示意：独立复核结论"
  }]
}
```

两个账户必须显式出现（零股票也要空数组）。来源日须与 `--src-*` 一致，不晚于
目标日。每账户持仓合计与独立源股票小计、总持仓与 `--stock` 分别相差不超过 $1。
这些检查不能证明 API 分页完整或源真实性，仍需步骤 1 的读取证据。
`firstHeldOn` 来自该 holding 的首笔交易日期；`effectiveFrom` 不能早于它，亦不能
晚于本次对应账户估值日。回看旧日期不会套用未来分类。历史来源不明时不能伪造日期。
`classifiedAt` 是真实复核时间，不得在未来。两个复核人员/上下文标识不同是最低格式检查，
**并非独立复核真的发生的密码学证明**；任务审计必须保留实际复核记录。

## 冲突与兼容

- 静态已审映射优先，同账户/holding 的 ticker 冲突一律阻断；相同 ticker 的新
  holding 不自动继承。已学分类与后来静态表冲突也阻断，不静默覆盖历史。
- registry 存于 AES-GCM payload 的 `classificationRegistry`，每个 identity 一条。
  普通日更只追加，不能修改 style、日期、证据或复核说明；完全一致重复输入为 no-op。
  更正既有分类属于单独的受审修订，不用删 registry 或改静态表绕过。
- 无 registry 的旧调用保持兼容。第一次成功输入即启用 registry，此后每次 writer
  必须提供输入，禁止退回手填总数或静默复用旧拆分。输入有缺口时原数据字节不变；
  可单独报告已核实 AUM，但不得把它称为本次已发布数据。异常归 Codex 跟进。
- 分类记录不进入费用回执的经济输入投影；同一 AUM 的分类变化不应改费用结果。
  没有变动的重复运行必须保持加密文件字节不变。

## 上线验收（不能以代码提交代替）

本次维护需精确 SHA 审批、正式合并后才启用。原 fee-console 固定 Routine 必须读取
本文件，并实际采用 `FEE_STYLE_INPUT_FILE` 的预检/写入顺序；仅改 repo 文档不算
Routine 已切换。第一轮真实验收须确认稳定源、密文 registry、完整分类、经济回执、
原账本未改、同参 no-op、正式发布与线上回读。手机验收按用户当前选择由用户完成。
本地合成测试证明通用路径，不证明下一次真实新仓的业务分类绝对正确。
