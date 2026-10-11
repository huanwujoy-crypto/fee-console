"""Pure read-only projection; no cloud, source, credential or file access."""
import re
from ib_source import safe_polling, safe_statement, POLLING_CODE

# Exactly the prior observer's scalar keys; no new free-text output key.
SAFE_KEYS = {'code', 'complete', 'needsAttention', 'kind', 'completedAt', 'startedAt', 'stage', 'event', 'reportRun', 'requestedCutoff', 'cutoff', 'quotesLagDays', 'comparisonHistoryWarning', 'htmlSha256', 'publicHtmlSha256', 'privateReportObject', 'latestEntryStatus', 'privateEntryStatus', 'publicEntryStatus', 'recoveredPublication', 'week', 'weekId', 'prefix', 'expiresAt', 'category', 'httpStatus', 'retryable', 'operation', 'attempts', 'elapsedSeconds'}


def safe_outcome(value):
    if not isinstance(value, dict):
        return {}
    result = {k: v for k, v in value.items() if k in SAFE_KEYS and isinstance(v, (str, int, float, bool, type(None)))}
    if isinstance(value.get('network'), dict):
        result['network'] = safe_outcome(value['network'])
    if value.get('stage') == 'ib_fetch':
        polling = safe_polling(value.get('polling'))
        if value.get('code') == POLLING_CODE and 'network' not in value and polling:
            result['polling'] = polling
        statement = safe_statement(value.get('statement'))
        code = value.get('code')
        operation = {'ib_request_failed': 'ib_send_request', 'ib_statement_failed': 'ib_get_statement'}.get(code) if type(code) is str else None
        if statement and statement['operation'] == operation:
            result['statement'] = statement
    for k, v in list(result.items()):
        if isinstance(v, str):
            result[k] = re.sub(r'(?<![A-Za-z0-9])U[0-9]{6,12}(?![A-Za-z0-9])', '[ACCOUNT_REDACTED]', v)
    return result
