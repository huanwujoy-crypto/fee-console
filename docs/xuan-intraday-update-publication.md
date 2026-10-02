# 实际盘中数据更新（未上线）

PR329 的当前目标是用原渠道更新真实持仓、活动订单、分币种现金/已结算现金、近7日成交和目标交易日 Flex executions。明确标为“盘中数据更新”，显示各来源实际读取时间，不计作欧洲盘前完成，不把读取时间伪称上游 as-of。不涉及交易、账本或其他账户同步。

## 真实依赖与核实边界

- 使用原 IB MCP 身份/原凭据，固定只读5项：summary、positions、orders、balances、trades；trades 固定 DAYS_7，正常凭据刷新最多一次。原默认3项 capture 不变，新增显式 `--full-source-check`。
- 目标日来自原交易日历；原始 Flex CSV 必须提供预先核实的 SHA256、按既有业主账户关联匹配，并保留6 executions/5 orders 的区别。仅有手工摘要不能生成实际成交表。
- 订单币种优先来源字段或同一 order_id 的实际成交；不得按股票代码猜测。补充只读订单详情必须保留原账户绑定、读取时间、订单/合约关系并与持仓合约币种交叉验证。未能确认的币种明确未齐，不算预占金额。
- 实时现金、settled cash、来源 FX 单独列出，并对同次 summary 总现金交叉核对；这不证明历史 CashReport 最终完整、取消更正覆盖或全账务最终性。成交匹配比较每个目标订单的数量与金额；未知时区保持未知，不强行归入交易日期。
- 冲突/覆盖不足显示具体缺口；当前方案不生成尚无证据支持的行动金额。实际金融数值只进入原选择字段的静态报告；账户、order/exec/contract 标识、原文件和凭据不得公开，也不新增公共金融 API。

## 一次最终审批后执行

1. 全部检查通过后，OWNER 对最终40位head以独立行评论 `/approve-xuan-ib-maintenance <head>`，再按原流程转ready、检查、合并。任何改动使旧审批失效。
2. 同一次授权覆盖原安全镜像部署：仅更新原 source-check 代码，身份、secret、原bucket/WIF/environment 不变；不得加 IAM/OAuth/凭据权限。部署后才进行一次新的5来源 capture 与一次原正常 refresh。过期的10/2旧capture不能重用。
3. 获授权读取原目标日 Flex CSV；如仍需币种补充，仅使用现有 IB 只读订单详情或已有 Flex OpenOrders，保存私有原始证据。缺少来源/权限立即报告，不猜测或新增权限。
4. `prepareIntradayUpdate` 校验原字节 SHA256、canonical fingerprint、5项来源时间/唯一性、Flex hash/账户绑定、最新main关联政策与上一版来源指针；生成 report.html/receipt.json。捕获开始至发布仍不得超过原30分钟。
5. 两文件以 create-only 写原私有 delivery 前缀 `delivery/当天/intraday-update-证据SHA256/`；不写正式 start.json、不覆盖对象。仅 dispatch 原 producer，传该prefix；此支路只 GET 两对象，不二次取源/refresh。
6. 原签名单文件 candidate → Validate → Promote → Pages。校验器再次检查当前政策、前版CAS和时效。公开读回必须证明实际新内容、日期/meta/source/blob一致、手机入口可读取；候选或空Promote成功不是上线。更新可替换同日旧内容，但不能冒充当天正式盘前成果。

PR323 的欧洲IANA窗口、旧日锁隔离和有限重试仍独立；未配置真实来源适配路径不可部署。独立云调度及全链路只读监管尚未部署。本次实际更新不能证明10/5首个定时运行已经解决。

实际接口补充：余额含 BASE 汇总行时保留私有原始字节，不作为独立币种重复加总；其现金与同轮 summary 独立核对。MCP order_id 与 Flex OrderID 可能是不同标识范围；必须以唯一 execution 标识加目标纽约日期、资产/方向/币种/数量/价格/费用逐项一致交叉证明，不能凭标识相等或股票代码自行认定。
