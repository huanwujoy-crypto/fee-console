# 周报最简公开入口

2026-09-26 用户明确接受最终报告无需 Google 登录或密钥，知道网址即可查看。
此授权仅覆盖最终风险与 ABC 报告，不包括原始文件、完整账户号码或凭据。

实现：现有每周任务在私密存档成功后，将最终 HTML 额外发布至独立 bucket
`family-portfolio-gateway-xuan-weekly-public` 的 `weekly/latest.html`。
继续复用 generation 条件写入及运行时间/数据日防倒退校验。
现有私密 bucket 保持 public access prevention enforced，不改其读取权限。
公开 bucket 仅存最终报告；周报运行身份的写权限限于这个对象。

GitHub Pages 原固定入口使用无脚本 sandbox iframe 直接显示公开报告；
没有登录、密钥、轮询、离线缓存、数据库或新增定时任务。
页面保留“重新载入”和失败时直接打开报告的备用链接。
仍需要访问 Google Storage 网络；公开不等于绕过网络限制。

部署门槛：建立独立公开 bucket，核验现有生成器未输出账号或凭据，
部署新镜像并设置 WEEKLY_PUBLIC_BUCKET 后实跑，验证公开 HTML 和私密原件
仅差公开说明文字，验证 private bucket 匿名仍返回 403，再验收固定入口。
未完成这些步骤不宣称上线。原周日时间和取数、计算规则不改。

安装：Safari 打开固定入口 → 分享 → 添加到主屏幕；以后打开图标直接显示报告。
已装相同入口的设备无需重装。以报告数据日期判断新旧。

撤销：停用 WEEKLY_PUBLIC_BUCKET 并撤销公开 bucket 的匿名读取权限；
第三方已经保存的副本无法收回。noindex 仅是搜索提示，不是访问保护。
