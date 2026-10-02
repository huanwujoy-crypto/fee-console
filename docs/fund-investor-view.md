# Investor share value view

The investor tab adds a separate inception-close view over the existing managed
Schwab + Webull composite. It neither changes the fee start date nor rewrites the
economic ledger. Company, fund, investor names and initial ownership are supplied
by a local profile file, never embedded as real personal data in public source.

## Valuation

`createFundInvestorCore` is the pure source factory; the browser includes an exact
copy enforced by the tests. Its input must be the existing verified fee receipt
projection and the same daily data. The exact inception day's closing account
total includes the founding asset transfer and cash. Do not add either again.

- Initial per-share asset value = inception closing composite / issued shares.
- Personal asset value = composite × investor shares / issued shares.
- The first investor is rounded to cents; the final allocation is the remainder,
  so the two investors always sum to the composite's exact cents.
- Performance starts after inception close. The inception day's own return and
  the founding transfer are not counted again.
- Shares remain fixed only while there is no later external event. An optional
  `subscriptions` array records independently reviewed contributions without
  rewriting founding shares. Each event names the investor, gross amount,
  investor-borne fee, net amount, source reference, prior valuation date and
  total, and whole shares issued at the prior closing unit price. The engine
  requires a matching effective receipt flow and, if present, one matching
  Webull source candidate. Only then does it increase that investor's shares;
  the contribution is excluded from gain/loss. Return percentage remains
  unavailable after a contribution until a flow-adjusted return method is
  separately reviewed.
- Any unmatched effective flow, unconfirmed automatic candidate or unresolved
  candidate still stops the series before the earliest event, including
  net-zero pairs. No source candidate alone authorizes a share issue.
- Missing exact inception values, account fields, dates, complete receipt or
  flow evidence give a pending state. It never takes a nearby date or treats
  missing accounts as zero. Current values are hidden after a flow boundary;
  earlier history remains explicitly dated.

The display is **before separately accrued management fees and Carry**, not a
formal NAV after all liabilities. Existing broker-recorded expenses remain in
the account totals. The monthly fee receipt has no daily fee-liability balance
at fund inception; subtracting all historical fees would mix periods or double
count payments. A future net NAV must extend the same trusted receipt, not add a
second fee calculator. Provisional source data is labelled; unmarked historical
points are not promoted to independent calibration evidence.

## Profile and access

The `fee-console.fund-profile.v1` file supplies `manager`, `fundName`,
`inceptionDate`, `inceptionNoticeDate`, `currency: USD`, `initialShares`, and
exactly two investors with `id`, `name`, `shares`. Unknown fields and incorrect
share totals are rejected. The file contains display configuration, not a
financial instruction or an independently authenticated share register.
The optional `subscriptions` list is bounded, date ordered and source-unique;
the remote publish path prevents deletion or rewriting of previously published
events or founding share counts. It is an internal monitoring record, not a
substitute for executed legal fund or ownership documents. Identity mismatches
between a person's name and investor ID must be resolved before publishing.

Import requires the existing source to be verified. It changes only local
display configuration, so a read-only user can import without a manager token.
The profile is AES-GCM encrypted using the existing data key, bound internally
to the current Gist identity, and read back before saving. A previous encrypted
profile is retained. Concurrent imports use a generation check; account/key
changes abort the import. Import removes any old profile from the URL fragment
so a refresh cannot silently restore an older version.

From shell version 4.9.8, the read-only URL contains only the Gist identity and
the existing data decryption key. It does not carry `fund`, `docs`, or `archive`
snapshots. The manager publishes one encrypted `fee-console-fund.json` file in
the same Gist after the manager identity and source ledger have been verified.
The application reads that file together with the ledger on every refresh, so
an old iOS Home Screen URL cannot override the latest fund profile or document
library. A compare-before-PATCH check and exact read-back prevent a stale
manager page from silently replacing a newer remote fund record.

Legacy links containing encrypted profile or archive snapshots remain readable
only as a migration fallback while the remote fund file is absent. New share
and manager links never include those snapshots. The remote fund file remains
AES-GCM encrypted with the existing data key; the manager token is required only
for publishing and is never included in a read-only link. X/Z-style view
selection is display only: anyone with the read-only link can see both investors
and the full underlying report. Separate private investor accounts would
require separately reviewed access control and are not claimed by this tab.

## Verification and release

The existing `returns.test.mjs` suite imports the fund arithmetic and browser
storage/render tests. Support code can merge before the index-only UI PR: browser
tests skip only when the feature is wholly absent; a partially introduced feature
fails. Active UI must embed the exact source factory. Fixtures use synthetic
names, keys, dates and amounts. `data.json`, economic settings and financial
accounts are unchanged by this release.

No SPY/QQQ fund-inception benchmark is introduced. The current fee-period
benchmark is a separate view and must not be relabelled as inception performance.

## 基金外管理费与模拟份额补偿

管理人可以把已经保存的 USD 管理费付款登记为基金外付款。该事件必须同时记录付款人、付款日、付款金额，以及付款前最后一个已完成估值日。系统按另一位投资人在付款前的已登记份额比例计算其应承担金额，再按该估值日的每股份额市值四舍五入为整数份额，由另一位投资人转给付款人。

这种登记不减少基金资产，也不增减基金总份额；它只改变两位投资人的模拟份额归属。付款记录与份额转让通过唯一 `paymentId` 绑定。已发布的付款和份额转让均采用 append-only 记录，不能删除或改写。若付款、估值日、金额或份额计算不能完全匹配，投资人当前市值停止在最后一个可核验日期。页面同时显示“基金档案已登记份额”和“最新可核验份额”，避免在付款日的基金估值尚未发布时误称已经完成当日估值验证。

### 追加补偿定价更正

同日估值替换后，已发布补偿事件不能直接覆盖。`shareTransferPriceCorrections`
追加一条绑定原 `transferId`、原定价日／金额／份额的更正；保留原转让和付款。
仅支持同一定价日的价格及其整数份额重算，不更改付款、补偿金额、双方身份或总份额。
每条记录带更正时间、原因、源密文 SHA256 和明确批准引用；同一转让只允许一条更正。

纯分配模型先验证原事件与新记录的算式，再要求修正后的定价金额与已验证回执覆盖的
真实日值完全匹配，且仍匹配原付款。没有匹配则继续停在闸门前。页面同时展示原转让
与追加更正。管理人发布路径对已发布更正数组执行前缀一致检查，不能删除、覆盖或
重复追加；普通档案表单会保留这些记录。此前日期的股份和市值不变。此机制处理模拟
记录，不能执行券商交易、实际资产转让或现金支付。
