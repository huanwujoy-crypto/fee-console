# XUAN-IB 手机待办互动契约 v1

> **目的**：允许 Wu 在 iPhone 固定页进入已登录的 Claude App，对当期 `awaiting_user` 待办选择「采纳 Claude 意见 / 修改意见 / 稍后决定」，并在下一份经过验证的页面中看到可核对的回执。
>
> **本文件只定义互动与记录，不授权执行**：任何选择均不得触发下单、改单、撤单、换汇、转账、券商或 Sharesight 写入，也不得被解释为交易授权。

## 1. 实施顺序与当前能力边界

必须分阶段实施，不得先放出一个没有可靠回执的按钮：

1. 先落实本契约、专用 Claude Routine 与专用 iPhone Shortcut；
2. 用真实 iPhone 验证 Routine 能在 Claude App 中读取最新待办、接收选择并生成受控候选；
3. 再修改固定 loader，增加「回应待办」入口、pending 状态和 receipt 驱动的自动刷新；
4. 最后才考虑 Shortcut 内原生菜单或自动传参。除非 Anthropic 正式支持且已测试 Routine `fire` API 的动态 authenticated request body，否则不得猜测接口字段或依赖未公开行为。

当前已验证的 `XUAN-IB 临时报告` Shortcut 只有三步：向固定 Routine 的 `fire` endpoint 发出已认证请求、读取返回的 `claude_code_session_url`、用 Claude App 打开该会话。当前 Shortcuts 动作库未提供可验证的 Claude `Ask` / `Send Message` App Intent，因此 v1 的用户选择与自由文本必须发生在 Claude App 会话内，不在 Shortcut 内伪造自动提交。

## 2. 端到端数据流

### 2.1 固定页到 Shortcut

未来 loader 的「回应待办」链接只能调用固定名称：

```text
shortcuts://run-shortcut?name=XUAN-IB%20%E5%9B%9E%E5%BA%94%E5%BE%85%E5%8A%9E
```

链接中不得包含：

- token、cookie、API key、OAuth credential；
- 用户意见、输入文字或持仓数据；
- `decisionId`、`sourceSha`、`htmlBlob` 或其他可能被误当作可信上下文的参数；
- Claude prompt 或可执行 URL。

### 2.2 Shortcut 到 Claude App

专用 Shortcut `XUAN-IB 回应待办` 固定执行：

1. 使用 Shortcuts 自身受保护的认证配置 POST 专用 Routine `XUAN-IB 回应待办（只读记录）`；
2. 从响应中读取 `claude_code_session_url`；
3. 直接用 Claude App 打开该 session。

Shortcut 不使用 Clipboard、不保存用户意见、不写 GitHub、不调用 IB / Sharesight，也不把认证材料放入仓库、页面或 URL。

### 2.3 Claude Routine 取得可信上下文

Routine 不信任由手机 URL 传入的报告身份，而是自行读取并配对当前发布的：

- `xuan-ib/latest.meta.json`；
- `xuan-ib/latest.html`；
- `sourceSha`、`sourceCommitEpoch`、`dataDate` 与 `htmlBlob`；
- 报告内所有状态为 `awaiting_user` 的稳定 `decisionId`。

在开始提问前必须完成与固定 loader 相同的版本配对原则：HTML Git blob 必须等于 `latest.meta.json.htmlBlob`，来源 commit 与 data date 必须有效。配对失败、页面回退或来源不明时 fail-closed，只说明「当前报告无法验证，请稍后刷新」，不得展示或记录猜测的待办。

## 3. Claude App 内互动

Routine 按报告中的编号逐项显示：事项名、Claude 建议短句、当前状态及以下三个选择：

1. **采纳 Claude 意见**；
2. **修改意见**；
3. **稍后决定**。

规则：

- **采纳**：记录 `accepted`，只代表 Wu 接受该分析结论；不代表授权实施或交易。
- **修改**：允许 Wu 在 Claude App 中输入完整意见。Routine 必须先复述并要求 Wu 确认一条最多 120 字的公开短摘要；只有确认后的短摘要可进入公开固定页。原始自由文本不得原样放进 URL、Shortcut、公开 HTML、Git commit message 或 workflow log。
- **稍后**：写入 `deferred` receipt，但 decision 状态继续为 `awaiting_user`；导航徽标仍计数，页面显示「已选择稍后决定」。
- v1 不另设「否决」按钮；不采纳 Claude 意见时走「修改意见」，公开短摘要可写成「不采纳，沿用现行规则」。

用户最终确认前，Routine 必须再次读取 `latest.meta.json`。若 `sourceSha` 或 `htmlBlob` 已变化，则说明报告已更新，并要求基于最新待办重新选择；不得把旧页面的决定静默应用到新页面。

## 4. Decision 与 receipt schema

### 4.1 Decision 约束

沿用规范附录 v9.16：

- `decisionId` 跨版本稳定且唯一，格式 `^D-[0-9]{8}-[A-Z0-9-]{1,64}$`；
- 状态只能是 `awaiting_user / accepted / rejected / modified / superseded`；
- 同一问题只更新原 ID，不重复新建；
- 导航徽标只统计 `awaiting_user`。

后续报告须给每个待办卡增加不执行代码的机器属性：

```html
<details class="dcard"
         id="D-20260829-MRVL-CLASS"
         data-decision-id="D-20260829-MRVL-CLASS"
         data-decision-status="awaiting_user">
```

### 4.2 Receipt 对象

每次最终确认产生一个 receipt：

```json
{
  "schemaVersion": 1,
  "receiptId": "R-20260830-154500-A1B2C3D4",
  "decisionId": "D-20260829-MRVL-CLASS",
  "action": "accepted",
  "responseToSourceSha": "40-hex trusted source commit",
  "responseToHtmlBlob": "40-hex trusted HTML Git blob",
  "recordedAtHkt": "2026-08-30T15:45:00+08:00",
  "publicSummary": "采纳 Claude 意见；只记录，不执行"
}
```

字段约束：

- `receiptId` 唯一，格式 `^R-[0-9]{8}-[0-9]{6}-[A-Z0-9]{8}$`；
- `decisionId` 必须引用当前或本次转入已结案区的真实 decision；
- `action` 只能是 `accepted / modified / deferred`；
- 两个 hash 必须为 40 位十六进制，并精确指向用户开始回应时 loader 与 Routine 共同看到的已验证基线；
- `recordedAtHkt` 必须是带 `+08:00` offset 的有效 ISO 8601 时刻；
- `publicSummary` 最多 120 个 Unicode 字符，必须经用户确认，禁止 `<`、`>`、`&`、控制字符、URL、凭据、账户号码和原始自由文本；
- receipt 不得包含交易数量、价格、订单指令或任何可执行动作。

### 4.3 报告内机器清单

新报告可使用一个 inert、不可执行的模板承载最小机器清单：

```html
<template id="xuan-ib-decision-state-v1">
{"schemaVersion":1,"decisions":[{"decisionId":"D-20260829-MRVL-CLASS","status":"accepted"}],"receipts":[{"receiptId":"R-20260830-154500-A1B2C3D4","decisionId":"D-20260829-MRVL-CLASS","action":"accepted","responseToSourceSha":"…","responseToHtmlBlob":"…","recordedAtHkt":"2026-08-30T15:45:00+08:00","publicSummary":"采纳 Claude 意见；只记录，不执行"}]}
</template>
```

该模板不得含脚本、网络地址或自由 HTML。loader 只能读取其 `textContent` 后严格 JSON parse；不得把字段作为 HTML 执行或用 `innerHTML` 渲染。guard 必须验证模板恰好一个、schema 有效、ID 唯一、枚举合法、hash/时间格式正确，并拒绝不受控字段。

## 5. 记录与发布语义

最终确认后，Routine：

1. 在当前已验证 HTML 基础上更新对应 decision 状态与可见短摘要；
2. 加入 receipt；
3. `accepted` 或 `modified` 的项目可移入「已结案 / 只读观察」，但必须保留稳定 `decisionId`；
4. `deferred` 继续保留在「待决定事项」且状态仍为 `awaiting_user`；
5. 只创建一个改变 `xuan-ib/index.html` 的 Claude 候选 commit；
6. 通过既有 Candidate → Validate → Promote → Pages → 线上 hash 读回链路发布；
7. 发布失败时保留上一份已验证报告，不得在手机上声称回应已完成。

回应发布属于**记录更新**，不是新的金融取数。若没有必要重取数据，应保留原报告全部金额与 as-of，并清楚标注只更新了 decision receipt；不得为了回应而猜测或改写金融数字，也不得冒充 AM / PM / ad hoc 报告成功。

## 6. Future loader 的 pending / receipt 行为

loader 实施阶段另开受保护 PR。点击「回应待办」时：

1. 把当前已验证的 `sourceSha + htmlBlob + startedAt + deadline` 存入 `localStorage`，key 使用 `xuan-ib:decision-wait:v1`；
2. 显示「已进入 Claude，请在 App 内完成选择」；
3. 页面恢复、focus、visibility change 及每 15 秒轮询均读取最新已验证 pair；
4. 只有新报告 receipt 的 `responseToSourceSha` 与 `responseToHtmlBlob` 同时等于本机 baseline，才清除 pending 并显示「回应已记录，报告已自动刷新」；
5. 普通 AM / PM / ad hoc 发布、只有时间变新但没有匹配 receipt 的报告不得误报完成；
6. 20 分钟超时只显示「尚未收到回应回执，请稍后刷新」，不猜测用户选择，也不删除最后一份已验证报告。

loader 不读取或保存原始自由文本，只保存非敏感的版本指纹与本地等待状态。

## 7. 验收测试

### 7.1 Shortcut / Claude App

- Shortcut 链接只含固定名称，无 token、hash、decision 或意见参数；
- Shortcut 动作中没有 Clipboard、GitHub 写入、IB / Sharesight 写入或任意金融连接动作；
- Routine 能从配对成功的最新报告列出全部 `awaiting_user` decisions；
- meta/HTML 不配对、decision 不存在或基线已变化时 fail-closed；
- `accepted / modified / deferred` 各有一条真实 iPhone 测试；
- 修改意见必须完成公开短摘要二次确认，原始文本不出现在固定页、URL 或 workflow log。

### 7.2 Guard

- 接受唯一、合法 decision 和匹配的 receipt；
- 拒绝重复/畸形 decisionId、receiptId、未知状态或 action；
- 拒绝非 40-hex baseline、错误 HKT timestamp、超长或含危险字符的公开摘要；
- 拒绝 receipt 指向不存在的 decision；
- 拒绝模板内新增 URL、script、form、network call、credential 或额外未知字段。

### 7.3 Loader

- pending 在整页重载与从 Claude App 返回后仍保留；
- 相同基线、普通新报告和不匹配 receipt 都不能完成等待；
- 精确匹配 receipt 才自动刷新并显示完成；
- 畸形或伪造 receipt fail-closed，继续显示最后一份已验证报告；
- 超时不误报成功；
- dark mode、390px 手机宽度、VoiceOver 状态文案和最小 44px 点击高度通过。

### 7.4 金融安全

- 用工具审计证明整个回应流程未调用下单、改单、撤单、换汇、转账或券商/客户资产写入；
- `accepted` 不能被交易或再平衡模块当作执行许可；
- 若回应涉及未来规则修改，须另开明确、可审核的规则变更流程；不得在本互动流程中顺带实施。

## 8. 明确不做

v1 不做以下事项：

- 把 token、意见或可信上下文塞进 URL；
- 在公开静态页直接 POST 表单；
- 在 sandboxed report iframe 内运行互动脚本；
- 使用 Clipboard 传递用户意见；
- 猜测 Anthropic Routine API 的动态 payload；
- 以「采纳」代替交易确认或系统写入授权；
- 在没有匹配 receipt 时声称回应完成。
