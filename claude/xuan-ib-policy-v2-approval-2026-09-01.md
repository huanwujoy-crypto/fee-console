# XUAN-IB index ETF policy v2 — approval record

Status: **approved-not-implemented**  
Approved: **2026-09-01 HKT**  
Mode: **read-only planning**

## Approved allocation

1. United States: **65%**.
2. Developed ex-US: **23%**.
3. Emerging markets: **12%**.

The US 65% sleeve is divided into:

- US small value (USSC): **5%** of the full policy portfolio.
- AI / large-growth tilt (EQAC): **0–8%** of the full policy portfolio; the initial 8% is permitted only after mapping and AI-exposure validation.
- US large-cap core (CSPX): **60% minus the AI / large-growth tilt**, therefore **52–60%**.

## Funding and reserve controls

- Funding is cash-first. Existing-holding sales are secondary and may be counted only after settlement.
- The CALL reserve is the greater of USD 240,000 or the verified 90-day calls plus approved buffer and FX / operations buffer.
- The CALL ledger is currently incomplete. This is a **fail-closed** gate: do not show a deployable amount, do not infer missing values as zero, and do not implement the allocation until the ledger is verified.

## Scope and products

- Scope: all IB-HK assets plus NOAH-HK cash, excluding theme investments GLD, SLV, MSTR and HODL.
- Eligible investments: equity index ETFs only; IB01 is a reserve candidate, not an equity allocation.
- Approved product identities are recorded in `claude/xuan-ib-policy-v2.json`. Product identity does not by itself authorize a trade.

## Evaluation

- A: actual portfolio.
- B: cash-first policy shadow portfolio.
- C: CSPX accumulating benchmark.
- Score no more than five items: after-tax return, maximum drawdown, AI participation, US-situs share and CALL coverage.
- The baseline is pending. Do not publish a ranking until at least four complete quarters of comparable observations exist.

## Authority boundary

This approval authorizes the policy record and its read-only display. It does **not** authorize an order, order change, cancellation, transfer, currency conversion or other financial write. Every future transaction requires separate explicit approval.
