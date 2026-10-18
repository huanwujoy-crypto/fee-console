# Weekly IB failure diagnostics — local candidate only

This candidate is based on protected merge `d9122a0cc040ce2d182eba9ce2955e957d109ac7`.
It adds observation only. The exact SendRequest/GetStatement acceptance predicates,
query/hosts, 24 polls, 6.2-second interval, deadlines, network retries, recovery
eligibility, leases and publication are unchanged. No remote commit, upload,
build, deployment, source call or manual run is authorized by this document.
The existing six-file candidate and risk-v5 work remain separate.

## Diagnostic contract

Rejected SendRequest/GetStatement shapes attach `statement` to the existing
symbolic error. `weekly_job` validates it and emits it only during `ib_fetch`
with the corresponding `ib_request_failed` / `ib_statement_failed` operation.
Each record has exactly eight keys:

- `operation`: `ib_send_request` / `ib_get_statement`.
- `reason`: fixed guard category, never upstream text.
- `rootKind`: `statement_response` / `query_response` / `other`.
- `namespacePresent`: root-namespace boolean only, never a namespace URI.
- `statusShape`, `errorCodeShape`: fixed field-shape enums.
- `upstreamErrorCode`: a known official four-ASCII-digit v3 code as an integer,
  or null. Exactly one unqualified direct leaf is required, with no competing
  ErrorCode elements or attributes anywhere. Unknown numeric codes remain null
  with `unrecognized`; no trimming, coercion or arbitrary text is emitted.
- `pollCount`: integer 0 for SendRequest, 1–24 for GetStatement.

No ErrorMessage, XML, URL, token, reference value, account, holdings or amount
is copied into diagnostics. Known code membership grants no retry permission.
The prior `polling` validator remains unchanged. Old receipts are never enriched.

Synthetic terminal example, not the prior real response:

```json
{"code":"ib_statement_failed","stage":"ib_fetch","statement":{"operation":"ib_get_statement","reason":"error_code_rejected","rootKind":"statement_response","namespacePresent":false,"statusShape":"fail","errorCodeShape":"known","upstreamErrorCode":1003,"pollCount":1}}
```

When the existing guard rejects a response, a qualified ErrorCode yields
`errorCodeShape=qualified` and null numeric code. The separate namespace boolean
describes only the root; qualification of a child is represented by its field
shape. Duplicate/conflicting diagnostic fields yield `ambiguous` and null.
An arbitrarily long/private ErrorCode yields `noncanonical` and null. These are
diagnostic classifications, not new response-rejection rules. Extra nested or
qualified fields that the prior acceptance predicate ignores remain ignored.

## Read-only observer integration

The historical `observe_natural.py` lives outside this repository. Preserve it
and its evidence; do not run its cloud clients as a local test. The registered
`cloud/xuan-weekly/safe_observation.py` is the corrected pure projection. Its
legacy scalar whitelist, network projection and account redaction are exactly
the old behavior. It additionally preserves only fully validated, context-bound
`polling` and `statement`. It adds no free-text scalar output keys.

For a separately activated observer copy, make the verified checkout's
`cloud/xuan-weekly` available on its Python import path and replace only the
old projection function with this drop-in adapter:

```python
def safe_outcome(value):
    from safe_observation import safe_outcome as project
    return project(value)
```

The local candidate supplies and tests this integration; it does not modify or
activate the historical external collector. Its cloud read/execution routines
are not copied into this candidate. Approval registry entries for new paths are
sensitive only; ordinary authorization and the policy verifier are unchanged.

## Official contract review, 2026-10-11

Primary sources:

- [IBKR Flex Web Service v3](https://www.ibkrguides.com/complianceportal/complianceportal/flexweb3.htm)
- [IBKR v3 error codes](https://www.ibkrguides.com/advisorportal/ug/flex3error.htm)

| Topic | Official description / example | Current client and this candidate |
|---|---|---|
| Send success | Unqualified `FlexStatementResponse`, `Status=Success`, numeric ReferenceCode, response Url; timestamp attribute shown | Example is accepted. Attributes/extra Url are tolerated; reference remains numeric. Fixed trusted endpoint is retained. |
| Send/Get failure | Unqualified response with `Status=Fail`, numeric ErrorCode and ErrorMessage; official Get example uses 1015 | Structure is recognized; terminal numeric code can now be diagnosed safely. ErrorMessage remains excluded. |
| Code coverage | Published codes include terminal and temporary conditions beyond 1009/1019 | Diagnostics recognize the listed numbers. Only the existing 1009/1019 shapes may continue polling. No new automatic retry. |
| Namespace / duplicates / nesting | The examples show none; the page supplies no promise to support these variations | Existing exact root/direct-leaf checks remain; additional nested/qualified fields previously ignored are still ignored. An actual safe shape observation is needed before proposing compatibility changes. |
| Successful report | Successful retrieval returns Flex data; this page does not define a complete report XML schema | Current query-name, identity, dates and cash/NAV validation remain unchanged. A query root with embedded failure fields still follows the prior fetch path; tightening that is a separate proposal. |
| Endpoint | Success example Url names gdcdyn; the same page's retrieval instruction uses ndcdyn | Existing fixed ndcdyn call follows the explicit retrieval instruction. No dynamic Url following or host change. |
| User-Agent / pacing | Programmatic access needs a technology/version User-Agent; error 1018 describes rate limits | urllib's existing technology/version default and 6.2-second poll interval are retained. Shared-token traffic is not proved by this local review. |

These examples support compatibility with the illustrated structure, not proof
of the actual response that failed at 13:51 HKT. Any namespace normalization,
whitespace tolerance, different host, additional transient codes or success-root
hardening would change response acceptance/retry behavior and requires a separate
concrete proposal. None is implemented here.

## Existing failure evidence

The disclosed seven safe fields reproduce the original 198-byte failure JSON
exactly: SHA256 `bccf0f4937fd066fe1b9cd909f2ca06d431ab64829c67d9affecddd797070628`.
It contains no `network`, `polling` or upstream ErrorCode. The new observer must
preserve that fact and must not manufacture a diagnosis for this old receipt.
The original GetStatement response was not retained by the failure path;
this candidate cannot recover it or establish token/account expiry.

## Local acceptance and later boundaries

Stage every candidate path and register additions before the full suite. Check
official/synthetic roots, namespace, duplicate/nested/attribute/nonleaf fields,
Unicode/overlong/malicious text, strict numeric/type validation, unchanged retry
and source-call behavior, stdout/archive/projection privacy, and the old safe
receipt hash. Run existing Python and Node suites and privacy/progress guards.
Obtain independent Astra review of the complete staged tree. These local checks
do not grant push, Library upload, cloud build/deploy or another manual run.

## 2026-10-18 offline follow-up: status classification only

This separate local candidate is based on `5c3292b7950c85abc17cd56f5cbcdef8b6301457`.
It is not a compatibility fix and does not establish recovery. The safe October 18
receipt proves known numeric 1019 with `status_rejected/noncanonical` at poll 1;
it does not preserve the actual Status text. It supplies no OAuth invalid_grant
evidence. Earlier receipts must remain unchanged.

The eight-field contract remains intact. Only `statusShape` gains these fixed
values after the existing uniqueness/direct/unqualified/leaf checks:

| Enum | Exact classifier condition |
|---|---|
| `empty` | ElementTree leaf text is None or empty |
| `xml_whitespace` | Nonempty text consists only of space, tab, CR, LF |
| `padded_success` | Removing only surrounding XML whitespace yields Success |
| `padded_fail` | Removing only surrounding XML whitespace yields Fail |
| `literal_warn` | Exact text Warn; a diagnostic hypothesis, not an official accepted status |

Exact Success/Fail retain their old classifications. Every other string remains
`noncanonical`, including Warning, lowercase variants, padded Warn and Unicode
whitespace. No upstream string, length, hash or ErrorMessage is emitted. Structural
classifications take priority. These new enums are invalid for `errorCodeShape`.
`literal_warn` can distinguish a plausible future observation without collecting
arbitrary text; its existence does not claim today's missing Status was Warn.

Official public documentation reviewed on October 18:

- [Legacy v3 contract](https://www.ibkrguides.com/complianceportal/complianceportal/flexweb3.htm): unsuccessful request examples use Fail, including GetStatement.
- [Current report generation](https://www.interactivebrokers.com/docs/web-api/flex-web-service/using-flex-web-service/generate-the-report): SendRequest states Success/Fail.
- [Current retrieval](https://www.interactivebrokers.com/docs/web-api/flex-web-service/using-flex-web-service/retrieve-the-report): describes waiting for generation, without an alternate Status definition.
- [Current retrieval reference](https://www.interactivebrokers.com/docs/web-api/api-reference/get-statement): failures return XML; no alternate Status definition.
- [Current error codes](https://www.interactivebrokers.com/docs/web-api/flex-web-service/error-codes): 1019 means generation is in progress. The newly documented 1025 is outside this change.

These reviewed sources provide no support for a new accepted noncanonical Status
branch. No response-acceptance, retry, 150-second budget, 24-poll/6.2-second pacing,
query, account, source, recovery or publication rule changes. Existing acceptance
ignores some extra nested/qualified fields and same-name attributes that stricter
diagnostics classify as ambiguous; tests preserve and disclose that baseline
behavior. Tightening it is a separate source-policy proposal, not this diagnostic
change. Existing source-evidence recovery gates still reject the old failure.

Deployment and any future controlled read-only observation require separate human
approval. No real invocation or schedule is added here. Unknown noncanonical
values would still require new official contract evidence or a separately reviewed
minimal fixed-enum observation proposal; arbitrary raw Status logging is not a
fallback. A future compatibility proposal needs both supported strict shapes and
explicit rejection/deadline/privacy tests before protected review.
