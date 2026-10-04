# 本地完整审核候选（未提交、未发布）

使用 2026-10-02 已验证派生金额；没有金融账户重读。源权重仅 MXUS 整份换为 MSCI 官方 2026-09-30 前十版本，未与旧日期拼接；仍为部分成分。其余来源日期、权重、100 日上限、直接持仓身份均不变。

业务重点 26 组已解决 25 组，27 个精确基金来源键。剩余巴西嵌套 ETF 是下一层资料缺口，不按 BlackRock 公司业务归类。其 $1,880.96 继续为未知，不从投资金额中扣掉或重复计入。

|重点组|原待核实 USD|本轮业务结论|
|---|---:|---|
|BE|598.82|infrastructure|
|CATERPILLAR INC|2,825.63|infrastructure|
|UNITEDHEALTH GROUP|2,569.23|other|
|GE AEROSPACE|2,532.54|other|
|PALO ALTO NETWORKS|2,425.78|platform|
|SK SQUARE|2,287.29|other|
|NETFLIX|2,279.34|other|
|PHILIP MORRIS INTERNATIONAL|2,278.33|other|
|ASE TECHNOLOGY HOLDING|2,118.99|infrastructure|
|GOLDMAN SACHS GROUP|2,051.75|other|
|CROWDSTRIKE HOLDINGS CLASS A|2,018.47|platform|
|SANDISK|1,954.45|infrastructure|
|RTX|1,941.69|other|
|GE VERNOVA|1,941.39|infrastructure|
|THERMO FISHER SCIENTIFIC INC|1,914.61|other|
|WELLS FARGO|1,896.72|other|
|ISHARES MSCI BRAZIL UCITS ET USDHA|1,880.96|嵌套 ETF 待下一层|
|MAHINDRA AND MAHINDRA LTD|1,801.39|other|
|MORGAN STANLEY|1,788.70|other|
|SAMSUNG ELECTRO MECHANICS LTD|1,755.62|infrastructure|
|LARSEN AND TOUBRO LTD|1,720.59|platform|
|CITIGROUP|1,691.19|other|
|AMGEN INC|1,674.88|other|
|XIAOMI|1,654.05|platform|
|LINDE PLC|1,647.24|infrastructure|
|ARISTA NETWORKS|1,643.78|infrastructure|

业务分类候选减少未知 $49,012.48；MXUS 日期整份更新减少 $14,270.05；合计 $63,282.53。原未知 $2,141,341.34 → 离线候选 $2,078,058.81。这是本地投影，生产本轮没有变化。

## 关键边界

SK Square 属投资公司；2026-10-01 官方 NAV 高度集中于 SK hynix。按经营业务分类为其他，并不代表无 AI / 半导体投资风险，不能把 SK hynix 的生产业务直接归于 SK Square。
M&M 2025-26 年报印刷第486页将 Tech Mahindra 列为28.06%联营投资；内部 AI 不是外售平台证据。
L&T 合并经营科技服务及自身 Cloudfiniti / Vyoma 外售云与 AI 平台；类别覆盖混合上市公司，不按纯 AI 收入占比。
Linde 2026-07-31 合约涉及自建、自持、自营先进晶圆与封装供气；基础设施敏感度是对此供应链角色的推断，来源没有把所有客户产出称为 AI。

## 完整基金来源实际检查

|基金|已核实文件 / 日期|可否整份换日|剩余具体缺口|
|---|---|---|---|
|MXUS|Invesco 2026-08-31 top exposures；MSCI Index 984000 2026-09-30 前十 / 513成分|本地已整份更新9/30前十，覆盖38.19%，未拼接旧日|公开指数页只有前十；完整513权重未获合法文件。抵押品、同指数的其他ETF持仓不能替代经济指数|
|EXUS|DWS 2026-08-31 factsheet前十；完整2026-06-30半年报投资明细（PDF页1068–1084）|完整6/30版本可单独建候选，10/2时94日，但不冒充8/31或10/1的完整组合；10/8达到100日，10/9失效|目前已取得的最近完整文件为6/30；没有可直接使用的当前完整下载。公开索引显示10/1 fund portfolio，实际浏览器入口须确认国家、角色并接受绑定条款；未接受|
|EQAC|Invesco 2026-08-31 top exposures；BX Swiss 完整2026-03-31半年报PDF页11–14|3/31到10/2为185日，不能在100日上限内启用或续期；未证明有可合法读取的更近完整版本|发行人入口曾要求 UK 居住/投资者声明，未接受。不能用QQQ替代Acc股类原组合|
|EIMI 内嵌巴西 ETF DE000A0Q4R85|母基金9/24持有0.4637%；公开产品页显示物理复制，46成分，完整最新下载未取得|需独立子基金同日完整文件，额外乘母份额；不能按发行人other|iShares实际浏览器入口弹出绑定条款与居住限制；停在Accept之前，未改地区/身份、未通过后台绕过|

完整来源文件留在本地研究，不将整份PDF上传或抄进公开仓库。EXUS PDF SHA256 a40e2676cf2a6a592b48594d34578775c8a26a4386614d2218f6aeda4ca09621；EQAC PDF SHA256 15ecbc158acc882d41cb780fe435d6e51d5a1a9753e1682feba383c8d8ee35d8。

若业务要求更近完整文件，最小用户动作是由有权访问者在真实适用地区/角色下自行完成发行方门户声明，并取得这些基金带日期、完整权重与身份列的 CSV/XLSX；MXUS 必须是经济指数成分，不能是替代抵押篮子。无需重新连接金融账户或改权限。此处列出真实文件缺口，没有请求本轮新审批。

## 官方业务证据（短事实与精确来源键）

- BLOOM ENERGY CLASS A / unreviewed-isin-US0937121079：infrastructure。Existing reviewed Bloom Energy business evidence; only CSPX unknown subpart is newly classified. 来源：https://www.bloomenergy.com/news/bloom-energy-and-oracle-expand-strategic-partnership-to-deploy-up-to-2-8-gw-to-accelerate-ai-infrastructure-build-out/
- CATERPILLAR INC / unreviewed-isin-US1491231015：infrastructure。Issuer identifies AI power demand and gigawatts of generator sets delivered to data centers; construction and mining remain. 来源：https://www.caterpillar.com/en/news/caterpillarNews/2026/world-needs-more-energy.html
- UNITEDHEALTH GROUP / unreviewed-isin-US91324P1021：other。Health benefits and healthcare delivery through UnitedHealthcare and Optum; healthcare workflow AI is not an external general AI platform. 来源：https://www.unitedhealthgroup.com/uhg/people-and-culture.html
- GE AEROSPACE / unreviewed-isin-US3696043013：other。Aircraft engines and aerospace services; not GE Vernova power-generation equity. 来源：https://www.geaerospace.com/company/about-us/leadership
- PALO ALTO NETWORKS / unreviewed-isin-US6974351057：platform。External Precision AI security platforms and security operations products, not only internal AI use. 来源：https://www.paloaltonetworks.com/
- NETFLIX / unreviewed-isin-US64110L1061：other。Entertainment streaming, films and games; recommendations support the entertainment product rather than an external AI platform. 来源：https://about.netflix.com/en
- PHILIP MORRIS INTERNATIONAL / unreviewed-isin-US7181721090：other。Tobacco, nicotine and smoke-free consumer goods; not an AI supplier. 来源：https://www.pmi.com/who-we-are/who-we-are-overview
- ASE TECHNOLOGY HOLDING / unreviewed-isin-TW0003711008：infrastructure。ASE, SPIL and USI advanced packaging and system integration explicitly support AI semiconductor technology. 来源：https://www.aseglobal.com/
- GOLDMAN SACHS GROUP / unreviewed-isin-US38141G1040：other。Banking, advisory and asset/wealth management; AI financing or internal productivity does not alone classify an AI supplier. 来源：https://www.goldmansachs.com/what-we-do/our-businesses
- CROWDSTRIKE HOLDINGS CLASS A / unreviewed-isin-US22788C1053：platform。External Falcon AI-native security and agent security platform. 来源：https://www.crowdstrike.com/en-us/platform/
- SANDISK / unreviewed-isin-US80004C2008：infrastructure。Flash and data-center storage serving AI capabilities, alongside consumer and other markets; separate Sandisk issuer identity. 来源：https://www.sandisk.com/company/about-us
- RTX / unreviewed-isin-US75513E1010：other。Collins, Pratt & Whitney and Raytheon aerospace/defense products; technology use is not a general AI supply classification. 来源：https://www.rtx.com/who-we-are
- GE VERNOVA / unreviewed-isin-US36828A1016：infrastructure。Explicit AI data-center onsite power, hybrid backup and gas-turbine supply; not GE Aerospace equity. 来源：https://www.gevernova.com/gas-power/industries/data-centers
- THERMO FISHER SCIENTIFIC INC / unreviewed-isin-US8835561023：other。Scientific instruments, diagnostics, laboratory and biopharma services; consistent with reviewed medicine/laboratory business classification. 来源：https://corporate.thermofisher.com/us/en/index/about.html
- WELLS FARGO / unreviewed-isin-US9497461015：other。Banking and financial services; digital banking is not by itself an external AI platform. 来源：https://www.wellsfargo.com/about/
- MORGAN STANLEY / unreviewed-isin-US6174464486：other。Wealth management, investment banking, capital markets and investment management; consistent financial-service policy. 来源：https://www.morganstanley.com/about-us
- SAMSUNG ELECTRO MECHANICS LTD / unreviewed-isin-KR7009150004：infrastructure。Issuer supplies MLCC, package substrates and capacitors for CPU/GPU, memory and AI-server networking; not Samsung Electronics equity. 来源：https://www.samsungsem.com/global/product/application/ai-server.do
- CITIGROUP / unreviewed-isin-US1729674242：other。Banking and financial services; internal AI and transaction technology do not alone make an AI supplier. 来源：https://www.citigroup.com/global
- AMGEN INC / unreviewed-isin-US0311621009：other。External medicines and biotechnology; issuer says AI is used to discover medicines, consistent with reviewed Merck policy. 来源：https://www.amgen.com/about
- XIAOMI / unreviewed-isin-KYG9830T1067：platform。Issuer identifies customer product foundation AI × OS × Chips alongside smartphone, connected-device and automotive businesses; whole-company related-business classification, not pure AI revenue. 来源：https://www.mi.com/global/about/
- ARISTA NETWORKS / unreviewed-isin-US0404132054：infrastructure。External Ethernet AI/ML fabrics, switches and network software for accelerator/storage systems. 来源：https://www.arista.com/en/solutions/ai-networking
- SK SQUARE / unreviewed-isin-KR7402340004：other。Investment-company equity, not the separately listed semiconductor operating company SK hynix. Official 2026-10-01 NAV is dominated by its SK hynix investment; other under this existing operating-business classification does not mean low semiconductor or AI investment risk. 来源：https://www.sksquare.com/eng/ir/nav.do
- MAHINDRA AND MAHINDRA LTD / unreviewed-isin-INE101A01026：other。Listed Mahindra & Mahindra auto/farm operating issuer. FY2026 annual report page 486 identifies Tech Mahindra as a 28.06% associate investment, not an operating subsidiary. Internal mGenAI and repair tools do not by themselves qualify as an external AI platform; no classification inherited from Tech Mahindra. 来源：https://www.mahindra.com/annual-report-FY2026/489/
- LARSEN AND TOUBRO LTD / unreviewed-isin-INE018A01030：platform。Larsen & Toubro operates external cloud and AI services through its own Cloudfiniti / Vyoma business and consolidated technology-service segment. Mixed engineering and semiconductor businesses remain; whole-issuer related-business category, not pure AI revenue or subsidiary weight allocation. 来源：https://www.larsentoubro.com/pressreleases/2025-11-26-lt-rebrands-data-centre-business-as-larsen-toubro-vyoma
- LINDE PLC / unreviewed-isin-IE000S9YS762：infrastructure。Linde builds, owns and operates ultra-pure gas supply assets for advanced semiconductor fabs and advanced packaging, per its 2026-07-31 contract announcement. Infrastructure relevance is an inference from this operating advanced-chip supply role; the source does not identify all output as AI. Its other industrial-gas end markets remain. 来源：https://www.linde.com/news-and-media/2026/linde-to-invest-$1-billion-to-support-major-u,-d-,s,-d-,-semiconductor-facility-expansion
- LARSEN AND TOUBRO LTD / unreviewed-lt：platform。Larsen & Toubro operates external cloud and AI services through its own Cloudfiniti / Vyoma business and consolidated technology-service segment. Mixed engineering and semiconductor businesses remain; whole-issuer related-business category, not pure AI revenue or subsidiary weight allocation. 来源：https://www.larsentoubro.com/pressreleases/2025-11-26-lt-rebrands-data-centre-business-as-larsen-toubro-vyoma
- MAHINDRA AND MAHINDRA LTD / unreviewed-m_and_m：other。Listed Mahindra & Mahindra auto/farm operating issuer. FY2026 annual report page 486 identifies Tech Mahindra as a 28.06% associate investment, not an operating subsidiary. Internal mGenAI and repair tools do not by themselves qualify as an external AI platform; no classification inherited from Tech Mahindra. 来源：https://www.mahindra.com/annual-report-FY2026/489/


## 最小门户 handoff（用户本人，若需进一步完整文件）

- DWS：正式总入口 https://etf.dws.com/ 。本次搜索命中的 EXUS 英国入口 https://etf.dws.com/en-gb/IE0006WW1TQ4-msci-world-ex-usa-ucits-etf-1c/ 实际显示 United Kingdom / Retail Clients；要求国家与角色声明、接受绑定条款，并明确国别页只可由该国永久居民访问。未接受。不能据此假称英国居民；由用户从总入口选择真实适用地区与合法投资者类别，自行判断并接受适用条款，再提供 IE0006WW1TQ4 同日完整成分。
- Invesco：正式总入口 https://www.invesco.com/ 。此前 MXUS / EQAC 的英国门户出现投资者角色、UK 居住与条款确认，未确认；不能代选英国或其它不真实地区。用户应本人使用真实法律居住地与符合资格的个人/专业类别，取得 IE00B60SX170 经济指数全量权重、IE00BFZXGZ54 Acc 对应基金全量持仓。公开 factsheet 是前十，不足以完成穿透。此调查没有证明在用户真实地区必须登录、付费或有当前完整下载，不能把未知说成已有服务。
- MSCI：正式公开指数入口 https://www.msci.com/indexes/index/984000/msci-usa-index 。已验证公开 9/30 前十，页面总513成分；没有验证可公开下载全部513权重的文件。若用户已有合法授权文件，提供同日指数身份与权重即可，不使用银行账户、同指数另一个ETF或swap抵押品来替代。
- 巴西子基金：已查正式入口 https://www.ishares.com/uk/individual/en/products/304304 ，实际弹出 Terms and condition / Accept，包含角色及地域限制，未接受，未改地区或绕过弹窗读后台。必要时由有权用户从 https://www.ishares.com/ 进入真实适用地区，自行接受条款并取得 DE000A0Q4R85 完整同日文件。仅约$1,881保持未知，本轮不为此扩大研究或账户范围。

仅需文件的合法读取/提供，不需要交易授权、修改账户关联或凭据。预览验收发现并同步了独立单票配置中的 MXUS 整份9/30版本；风险和单票使用同一来源、日期、权重，保留各自原有有效期上限。所有新文件仅登记到 sensitiveFiles；ordinaryFiles、权限、批准规则、调度及发布流程不变。


交付文件的明确日期要求（本轮风险截止 2026-10-02）：

|标的|请求文件|日期要求|本次实际见到的入口选项/边界|
|---|---|---|---|
|MXUS IE00B60SX170|MSCI USA Index 984000 全部513成分，名称/唯一证券身份及经济权重；非抵押品|优先2026-09-30，与本轮已换的前十同日；其它日必须整体替换且不晚于10/2|MSCI公开页为前十，并有Client Log In入口；未验证全量公开下载。Invesco英国入口见角色与UK居住/条款声明，未代选|
|EXUS IE0006WW1TQ4|发行人完整物理持仓 CSV/XLSX，所有身份和权重，包括现金/衍生品标签|优先2026-10-01（公开目录显示该日portfolio）或9/30；整份单日、不晚于10/2，不能把6/30完整报告拼进8/31前十|DWS实际显示国家United Kingdom，角色Retail Clients或Professional Clients，Accept & continue绑定条款；用户应从总入口用真实国家/资格|
|EQAC IE00BFZXGZ54 Acc|此Acc对应基金的完整物理持仓，非QQQ代理、非单个sector概览|优先2026-09-30或10/1；整份单日、不晚于10/2；3/31旧文件不能续期|Invesco此前英国入口见角色、UK居住及条款声明；本轮没有验证可下载当前完整文件或进入后是否需登录|
|EIMI内嵌巴西 DE000A0Q4R85|子基金全部成分身份及权重，需可独立核对的发行人文件|本轮母基金固定9/24，因此优先子基金2026-09-24；使用另日需另外审核母/子整份日期方案，不能悄悄混用|iShares实际是Individual Investor英国入口，Accept/Decline条款弹窗；未接受、未通过后台绕过|

本次见到的DWS、iShares和此前Invesco门槛是地区/投资者声明与条款确认，不是已要求输入账户密码的登录页；未进行登录。进入之后全量下载是否另需登录/许可尚未验证。用户本人若合法完成声明，只需导出上述文件，不需要提供密码、账户回执或重新读取私人金融账户。
