# XUAN-IB 回应待办（只读记录）— Routine 提示词

这是手动／API 启动的意见记录任务，没有定时 schedule。每次先从 fee-console 项目读取并执行 claude/xuan-ib-decision-interaction-v1.md、CLAUDE.md 与 claude/nightly-handover-spec-ADDENDUM-v916.md。下面的互动要求也必须执行，不能被旧版文字输入菜单覆盖。

## 不变的安全边界

- 不连接、读取或写入 IB、Sharesight 或任何金融账户；不重新取金融数据，不改变金额、价格、数据日、as-of 或计算。
- 不下单、撤单、改单、换汇、转账。采纳意见不等于执行授权。
- 只允许按契约生成一个仅修改 xuan-ib/index.html 的 Claude 签名记录候选，走既有 Validate → Promote → Pages。不得变更 workflow、权限、规则或其它文件；失败保留上一版。

## 第一步：核对当前报告

1. 从 main 读取并配对 xuan-ib/latest.meta.json 与 latest.html，严格验证 sourceSha、htmlBlob、dataDate、sourceCommitEpoch。
2. 只解析 template#xuan-ib-decision-state-v1 JSON；校验 schema、字段、唯一 decisionId、data-decision-id/status、导航数量及 interaction。不得从可见文字或示例代码猜测机器状态。
3. 如果 interaction 未启用、配对失败或来源不明，停止，简短说明无法验证，不生成任何记录。
4. 如果 awaiting_user 为 0，直接显示「暂无待决定事项」，可用简表列出已决定／待落实；不提问，不重建已采纳回执，不生成候选或 commit。

## 第二步：表格与可点击选择

先只用一句话提醒：「这里只记录意见，不会下单、撤单、改单或转账。」然后显示三列中文表格：

| 序号／事项 | Claude 建议 | 当前状态 |
|---|---|---|
| 按当前待办逐行填写 | 忠实于原报告的一句话建议 | 待决定 |

上表是格式说明，不是真实事项。真实运行必须用已经核对的待办填表。stable decisionId 保留在上下文映射与回执，不在手机表格显示长 ID、hash 或技术日志。原报告 A/B/C 选项不要作为回应的编码，避免混淆；「采纳 Claude 意见」始终指表格这一行实际建议。

表格下优先由主会话实际调用 AskUserQuestion。每批最多4题，每题标题明确关联表格序号与事项，multiSelect=false，三个选项必须是：

1. 采纳 Claude 意见：只记录采纳本行建议，不执行。
2. 输入我的意见：进入自由文字输入，不会立即产生记录。
3. 稍后决定：保留为待决定。

不得把 Markdown 表格、列表或链接冒充按钮。只有原生工具确实不可用时才简短说明，并保留文字「事项序号+A/B/C」兼容，A=采纳建议、B=输入我的意见、C=稍后；支持点击时不要求用户输入编码。

API 初始运行可能被平台包装为 scheduled-task 上下文，不等于用户设置了定时任务。首次没有答案属于正常等待：显示表格，调用可用的原生选择工具；若工具不可用则等待后续消息，不用长篇诊断替代菜单。

禁止默认勾选或替用户回答。API 启动、测试文字、空答案、Skip、取消、未回答事项都不是决定，不得产生 receipt。只接受本会话中对明确事项的真实选择。

## 第三步：确认意见

- 采纳：action=accepted，decision.status=accepted。
- 输入我的意见或 Other：先收集实际文字，单击入口本身不算修改。复述一条最多120个 Unicode code point 的公开摘要，并用「确认记录／继续修改」原生选项（不可用时明确文字确认）等用户确认。只将确认后的摘要写到公开回执；原始自由文字不写到公开 HTML、URL、Shortcut、commit message 或 workflow log。action=modified，decision.status=modified。
- 稍后：action=deferred，decision.status 仍是 awaiting_user，待办继续计数。
- 不存在 closed 状态。accepted/modified 进入「已决定／待落实」，不表示事情已实施。
- 最终写入前重新读取并验证 main 的最新 meta/HTML。sourceSha 或 htmlBlob 改变则停止，说明报告更新，基于新基线重新展示并获取选择，不静默迁移答案。

## 第四步：受控记录与发布

1. 只有真实选择及所需确认完成后，才生成 receiptId、action、responseToSourceSha、responseToHtmlBlob、recordedAtHkt（+08:00，可 round-trip）及 publicSummary。拒绝未知字段。
2. 所有既有 decisions 和 receipts 原样继承；receipt 数组不可变且只追加，旧数组须按原顺序成为新数组前缀。不能将旧回执当成本次完成。
3. 新 receipt 只能回应可信上一页已经存在且当时为 awaiting_user 的事项。只记录明确回答的事项；没有回答的维持原样。
4. 候选必须是 records-update：<!-- xuan-ib-handover:v1 --> 后无空白紧接唯一 <!-- xuan-ib-records-update:v1 -->。
5. 只修改 inert template、对应受控状态/分组/计数和待办 badge/aria。accepted/modified 移到「已决定／待落实」；deferred 仍待决定。0项不显示导航徽标。卡片事实、建议、选项、全部金融数字、日期、edition、as-of、计算与无关内容保持原样；interaction 与 previous 完全一致。
6. commit subject 保持 handover <可信 previous dataDate>，即使日期较早；这是记录更新，不是新的金融报告，不冒充 AM/PM 或临时报告成功。
7. 跑 guard，提交单一候选，等待 Validate → Promote → Pages。正式 main meta/HTML 的回执必须与原始基线精确配对，并晚于本次 startedAt。
8. 完成后用「事项／你的选择／记录结果」中文简表回读。正式回验成功才说「意见已记录」；尚待发布则说「已提交，等待发布」。如果环境不能读取 Pages，说明线上手机可见性尚未从该环境验证，不把 GitHub main 成功等同手机已更新。
