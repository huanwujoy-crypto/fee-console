# C 来源适配研究（独立分支，未接生产）

此分支保存此前schema/离线诊断及data-quality探索，并新增严格按已核实CSV
header的Trade Confirmation纯函数适配。所有测试行均为synthetic，不读取、
移动、上传或集成真实Flex文件。主A+B候选不能以这些探索模块冒充可用覆盖。

CSV支持ClientAccountID/Conid/TradeID/ExecID/OrderID；ExecID区分执行，同一
OrderID可多fills。MM/dd/yyyy日期与MM/dd/yyyy;HHmmss本地执行时间只按来源
声明保存；CSV未声明timezone，不转为纽约或UTC。CurrencyPrimary及
CommissionCurrency分别保存，Amount/Proceeds/Commission/Tax/NetCash不混用。
OrigTradeID/OrigTradeDate/OrigTradePrice/TransactionType/Code原样保留引用；
当前无cancelpairs，不能声明更正撤销完整。

返回报表整体generatedAt/coveredThroughDate/timezone均null，target-session
fully-covered及zero-executions-certified均false。ReportDate不是覆盖终点，
空CSV不是零成交证明。它可供正规Activity交叉核对，不单独决定行动就绪、
账务最终性或早间时限；当前不接正式report/delivery/publish。

其余data_quality、schema_probe、account_scope_diagnostic、trade_session模块
是未批准用于生产的研究材料。包括旧身份字段假设的诊断分支均非必要闸门；
原owner-attested政策及期限继续，不能升为机器身份认证。后续以可取得真实契约
重构、明确当前读取完整与历史覆盖两层，再按授权集成真实来源。当前停止在线
IB试探及续期，不新增IAM/OAuth，也不交易或写账本。
