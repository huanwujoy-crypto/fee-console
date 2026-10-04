# XUAN ETF complete-source draft — 2026-10-04

Local draft only, based on 3a5399827357fa9629a03a2fcd4869fc7e29f17a. No publication or deployment. A fresh protected-main base and exact signed OWNER-approved head are required before release.

CSPX and EIMI retain 2026-09-24. Newly captured official complete sources contain 510 and 3,001 rows respectively. New SHA256 values are b109145088c7a17de94d6adcba37fdffd056464c13dbf3f0d9ad433c761ba4fb and c95f1ee685a5980635b19ff1ce3cafcadd21c8d03afb249a248ff35e468f14cf. Old hashes, selected allocations and evidence remain in sourceHistory; the new capture does not claim byte identity with the old capture.

Source rows distinguish equity, cash, derivatives, collateral, money-market funds and nested ETFs. Four EIMI equity rows lacking ISIN remain explicitly unverified. Nested ETFs remain unknown without underlying evidence. Cash does not become an equity issuer. Unreviewed businesses remain unknown, never default to other.

Exact issuer micro-percent weights replace per-row basis-point flooring. This avoids approximately 2.6 and 12.9 percentage points of artificial rounding remainder across the complete CSPX/EIMI files. Allocation retains source precision and explicit display-cent residual; no renormalization. This changes the financial method ID and requires OWNER review.

Classified fund coverage: CSPX 58.87099%, unknown business 41.11223%; EIMI 38.02509%, unknown business 61.87276%. Non-equity unallocated balances remain separate. Full source composition does not mean full business classification.

Five proposed classifications: Siemens, Reliance and Bharti Airtel → platform; TD SYNNEX (SNX) → infrastructure based on Hyve external accelerated-compute manufacturing; Brookfield Corporation (BN, not BAM) → other. Six further CSPX issuers → other: Costco, Coca-Cola, Procter & Gamble, US Merck & Co, Bank of America and Home Depot. Exact legal-issuer/source-row bindings and primary-source business evidence are in claude/xuan-weekly-etf-source-evidence/five-candidate-business-v1.json, new-business-reviewed-v1.json and identity-bindings-v1.json. L&T, M&M and PBF remain unknown; the denied PBF products endpoint was not retried.

EXUS/EQAC older complete reports were found for research but not adopted; their existing 2026-08-31 allocations remain. MXUS economic-index coverage remains unresolved; no swap collateral substitution or residence/role-gate bypass.

Offline estimate using previously derived portfolio values: gap falls from 33.34% by approximately 0.6567 percentage points to 32.68%. This is not a new live financial read or published result.

Validation: Targeted Node tests passed (AI exposure, official-source import, build and mobile), including hash/date/identity conflicts, source precision, nested ETF, cash separation, explicit unknowns and cent conservation.

## Full regression and sensitive review

Run the complete repository suite, not only weekly tests: `node --test --test-concurrency=2 scripts/*.test.mjs cloud/xuan-preopen/*.test.mjs`. The final run log accompanies the frozen PR. The 16 existing skips are retired legacy page/operational prepare tests; they are unchanged by this PR and are not live financial integration checks. Cloud weekly Python source/publication tests are included through xuan-weekly-cloud-reliability.test.mjs. Trusted append-only progress and private ETF-ledger leak guards also run against the base. No real financial capture is used by tests.

Every changed path is sensitive and this PR uses `/require-specific-owner-approval`:

| Paths | Sensitive effect |
| --- | --- |
| claude/xuan-weekly-ai-exposure-v1.json | New complete dated ETF capture, legal-issuer bindings, 11 business classifications, exact-weight financial method, old source history |
| claude/xuan-weekly-etf-source-evidence/* | Public issuer identity/percentage-weight audits and manifest and explicit legal identity/business evidence; no private ledger or account data |
| scripts/xuan-weekly-ishares-import.mjs and .test.mjs | Offline SHA/product/fund/date/name validation; nested ETF and unknown guards; reproducibility |
| scripts/xuan-weekly-ai-exposure.mjs and .test.mjs | Financial allocation precision, explicit residual and complete-source disclosure |
| scripts/xuan-weekly-content.test.mjs | Updated independently known classification coverage expectations for INDA/USSC/VCN; no production identity mappings added |
| docs/xuan-weekly-etf-complete-draft-20261004.md | Review/approval instructions and limitations |

The original public issuer captures remain in the local audit, not the public repository: their unnecessary price/share-count fields triggered the unchanged private-ledger shape guard. The committed projection keeps only constituent identities, percentage weights and asset types. Its separate SHA and the original capture SHA are explicitly distinguished in public-composition-manifest-v1.json. Local verification checked original bytes/SHA against the projection and policy; CI uses a column-only fixture reconstructed from the hashed public audit. There is no encoding, rename or guard exemption to publish the rejected full response. These files contain no account holdings, Sharesight responses, IB raw files or credentials. Existing risk/source identity checks, equity/cash denominator, protected publication, leverage calculation and source-date gates remain applicable. A method change resets weekly comparison rather than comparing unlike methods.

CSPX/EIMI complete *directory* import adds explicit unknown entries instead of pretending they were obtained and classified. Recorded allocation is 99.98322% / 99.89785%; business unknown is 41.11223% / 61.87276%. The remaining 0.01678% / 0.10215% is non-equity/negative-cash and source rounding balance, not missing equity rows. Other funds retain partial dated snapshots; MXUS/EXUS/EQAC full current economic composition remains unacquired by this implementation. Unknown legal identity and unknown business stay in the uncovered total.

No classification is inferred from issuer sector, index membership or a broad default. Siemens/Reliance/Bharti are diversified issuer related-business classifications consistent with existing platform rules, not assertions of pure AI revenue. TD SYNNEX classification uses the identified Hyve manufacturing operation. Brookfield is the identified BN finance parent, not BAM or an infrastructure subsidiary. The six additional other classifications use exact ISIN plus official customer-business descriptions.

This independent PR changes no Cloud Run image, IAM, Scheduler, credential, production report or notification. Approval of its code alone is not approval to publish a report.

Sensitive registry maintenance: security/approval-tiers.json adds only this PR’s new paths to sensitiveFiles, because the complete tracked-file registry test requires explicit coverage. The 22 ordinary paths, classifier, protected prefixes and approval requirements are unchanged. This registry edit itself requires exact-head OWNER review; it grants no new ordinary authorization.

Rebased after the protected merge of PR342. The recovery implementation and its sensitive registrations are inherited unchanged from main, not reapplied or removed. This PR still changes only ETF source/classification/calculation evidence and its new sensitive-path registrations. The former head 5ff0fcc4ca2e9a0fd739eb4b1122815505a74ec0 is superseded and must not receive approval.
