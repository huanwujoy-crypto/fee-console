# 周报单票集中度：两组候选合并（2026-09-28）

本功能只修改周末记录的“单票集中度”，不改变睡前行动版、AI 分类、ABC、账户取数和调度。它是观察用的**已核实下限**，不是全持仓经济敞口或交易指令。

## 计算

1. 使用同一轮、同一数据日的三个 Sharesight 组合，分母为三个账户总资产（含现金）。第一组候选是全部直接持有的普通股，并加上各 ETF 中**已核实**的同名成分金额；即使该股票不在 ETF 前十也计入。第二组候选是每只持有的股票 ETF 的前十成分股。ETF 本身不作为单票再相加。
2. 两组按发行人取并集；同一发行人跨账户、跨 ETF 以及不同股类合并，例如 GOOG/GOOGL。间接金额逐项为 `ETF 本轮美元市值 × 该股票在 ETF 中的权重`。INDA 的前十股不含其货币市场基金；MXUS 是合成 ETF，取经济敞口，不取抵押品篮子。
3. 发行人合计＝直接个股市值＋已核实的各 ETF 间接金额。**先合并再筛选**；仅合计达到三账户总资产 **1% 或以上**才显示，判断在四舍五入前完成。CSPX 官方 2026-09-24 完整持仓中，BRK.B、ORCL、KKR、APO、VST 是已核实的直接持股同名、但不在 CSPX 前十的匹配；只在这些股票被直接持有时计入，不会变成第二组候选。
4. 发行方权重逐行向下截到 0.01 个百分点，金额在内部按百万分之一美元相乘，只在界面显示时四舍五入。每个显示的发行人都有直接金额、ETF 合计和逐基金的金额、权重、成分日期、发行方链接，可在“计算过程与资料日期”中查看。
5. 除已核实的同名匹配外，部分 ETF 第十一名及以后仍可能含直接持有的股票；未取得或超过 45 天的快照不补零、不沿用，界面注明未计入基金及其市值。故结果只能解释为**可见下限**，并不保证找齐所有实际超过 1% 的发行人。

快照保存在 `claude/xuan-weekly-concentration-top10-v1.json`，每只基金绑定 Sharesight instrument ID、代码、ISIN（若有）、物理/经济敞口口径、成分日期和来源。与 AI 业务分类的数据表分开，不能把“与 AI 有关”的子集冒充“基金前十大”。

| 基金 | 前十股票日期 | 发行方证据 |
|---|---|---|
| MXUS | 2026-08-31 | [Invesco factsheet](https://www.invesco.com/content/dam/invesco/emea/en/product-documents/etf/share-class/factsheet/IE00B60SX170_factsheet_en.pdf)；经济敞口 |
| EQAC | 2026-08-31 | [Invesco factsheet](https://www.invesco.com/content/dam/invesco/emea/en/product-documents/etf/share-class/factsheet/IE00BFZXGZ54_factsheet_en.pdf) |
| IVAI | 2026-08-31 | [Invesco factsheet](https://www.invesco.com/content/dam/invesco/emea/en/product-documents/etf/share-class/factsheet/IE000LGWDNE5_factsheet_en.pdf) |
| EXUS | 2026-08-31 | [DWS factsheet](https://etf.dws.com/download/asset/7abc744c-aaf2-48f8-8e28-6384d2233cc8) |
| CSPX、EIMI | 2026-09-24 | [iShares CSPX](https://www.ishares.com/uk/professionals/en/products/253743/?siteEntryPassthrough=true)、[iShares EIMI](https://www.ishares.com/de/privatanleger/de/produkte/264659/ishares-msci-emerging-markets-imi-ucits-etf?locale=de_DE&siteEntryPassthrough=true&userType=individual) 的当日完整持仓 |
| SMH | 2026-09-23 | [VanEck 美国 SMH](https://www.vaneck.com/us/en/investments/semiconductor-etf-smh/)；不是欧洲 UCITS 同名基金 |
| INDA | 2026-09-24 | [iShares INDA](https://www.ishares.com/us/products/239659/ishares-msci-india-etf) 当日完整持仓；货币市场基金不作个股 |
| USSC | 2026-09-25 | [State Street USSC](https://www.ssga.com/uk/en_gb/institutional/etfs/state-street-spdr-msci-usa-small-cap-value-weighted-ucits-etf-zprv-gy) |
| VCN | 2026-08-31 | [Vanguard Canada VCN](https://www.vanguard.ca/en/product/etf/equity/9561/vanguard-ftse-canada-all-cap-index-etf) |

这些是带日期的静态发行方快照，不会随交易日自动更新。超过有效期会显式列为未覆盖，**需要刷新发行方数据后才能恢复完整前十覆盖**；周报本身不因外部 ETF 页面变化而失败。
