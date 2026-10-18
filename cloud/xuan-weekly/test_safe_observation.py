import hashlib
import json
import unittest
from ib_source import statement_detail, xml
from safe_observation import safe_outcome, SAFE_KEYS


class ObservationTests(unittest.TestCase):
    def test_previous_scalar_whitelist_is_exactly_unchanged(self):
        expected = {'code', 'complete', 'needsAttention', 'kind', 'completedAt', 'startedAt', 'stage', 'event', 'reportRun', 'requestedCutoff', 'cutoff', 'quotesLagDays', 'comparisonHistoryWarning', 'htmlSha256', 'publicHtmlSha256', 'privateReportObject', 'latestEntryStatus', 'privateEntryStatus', 'publicEntryStatus', 'recoveredPublication', 'week', 'weekId', 'prefix', 'expiresAt', 'category', 'httpStatus', 'retryable', 'operation', 'attempts', 'elapsedSeconds'}
        self.assertEqual(SAFE_KEYS, expected)

    def test_valid_pending_visibility_uses_full_validator_not_generic_recursion(self):
        polling = {'operation': 'ib_get_statement', 'state': 'statement_pending', 'termination': 'poll_limit',
                   'lastErrorCode': 1019, 'pollCount': 24, 'pollLimit': 24, 'retryable': True}
        value = {'complete': False, 'stage': 'ib_fetch', 'code': 'ib_statement_not_ready', 'polling': polling}
        self.assertEqual(safe_outcome(value)['polling'], polling)
        for mutation in [{'polling': {**polling, 'token': 'PRIVATE_TOKEN'}}, {'polling': {**polling, 'pollCount': True}},
                         {'code': 'ib_statement_failed'}, {'code': []}, {'stage': 'archive_failure_json'}, {'network': {}}]:
            self.assertNotIn('polling', safe_outcome({**value, **mutation}))

    def test_terminal_statement_visibility_is_typed_and_context_bound(self):
        detail = statement_detail(xml(b'<FlexStatementResponse><Status>Fail</Status><ErrorCode>1003</ErrorCode></FlexStatementResponse>'), 'ib_get_statement', 1)
        value = {'code': 'ib_statement_failed', 'stage': 'ib_fetch', 'statement': detail, 'ErrorMessage': 'PRIVATE_MESSAGE', 'xml': 'PRIVATE_XML'}
        self.assertEqual(safe_outcome(value)['statement'], detail)
        for mutation in [{'statement': {**detail, 'url': 'PRIVATE_URL'}}, {'statement': {**detail, 'upstreamErrorCode': 'PRIVATE_TOKEN'}},
                         {'code': 'ib_request_failed'}, {'code': []}, {'stage': 'private_latest'}]:
            result = safe_outcome({**value, **mutation})
            self.assertNotIn('statement', result); self.assertNotIn('PRIVATE_', json.dumps(result))

    def test_fixed_status_subclasses_survive_only_valid_context(self):
        from ib_source import safe_statement
        for status, expected in [('', 'empty'), (' \t', 'xml_whitespace'),
                                 (' Fail ', 'padded_fail'), (' Success ', 'padded_success'), ('Warn', 'literal_warn'),
                                 ('PRIVATE_TOKEN_URL_ACCOUNT_AMOUNT', 'noncanonical')]:
            body = ('<FlexStatementResponse><Status>' + status +
                    '</Status><ErrorCode>1019</ErrorCode><ErrorMessage>PRIVATE_MESSAGE</ErrorMessage></FlexStatementResponse>').encode()
            detail = statement_detail(xml(body), 'ib_get_statement', 1)
            value = {'code': 'ib_statement_failed', 'stage': 'ib_fetch', 'statement': detail}
            result = safe_outcome(value)
            self.assertEqual(result['statement']['statusShape'], expected)
            self.assertNotIn('PRIVATE_', json.dumps(result))
            self.assertNotIn('statement', safe_outcome({**value, 'stage': 'private_latest'}))
            self.assertNotIn('statement', safe_outcome({**value, 'code': 'ib_statement_not_ready'}))
            if expected != 'noncanonical':
                self.assertIsNone(safe_statement({**detail, 'errorCodeShape': expected, 'upstreamErrorCode': None}))
        # The old known-1019/noncanonical receipt remains exactly as observed.
        old = {**detail, 'statusShape': 'noncanonical'}
        self.assertEqual(safe_statement(old), old)

    def test_existing_real_safe_failure_receipt_is_not_retroactively_enriched(self):
        # Only previously disclosed safe fields; no broker payload or credentials.
        receipt = {'complete': False, 'severity': 'ERROR', 'event': 'xuan_weekly_failed', 'stage': 'ib_fetch',
                   'completedAt': '2026-10-11T05:51:37.772569+00:00', 'code': 'ib_statement_failed', 'elapsedSeconds': 7.77}
        raw = json.dumps(receipt).encode()
        self.assertEqual(len(raw), 198)
        self.assertEqual(hashlib.sha256(raw).hexdigest(), 'bccf0f4937fd066fe1b9cd909f2ca06d431ab64829c67d9affecddd797070628')
        self.assertEqual(safe_outcome(receipt), {k: v for k, v in receipt.items() if k != 'severity'})
        self.assertNotIn('statement', safe_outcome(receipt)); self.assertNotIn('polling', safe_outcome(receipt))

    def test_legacy_network_projection_and_account_redaction_remain_unchanged(self):
        value = {'code': 'ib_network_error', 'network': {'operation': 'ib_get_statement', 'category': 'timeout', 'attempts': 3,
                                                     'retryable': True, 'url': 'PRIVATE_URL', 'token': 'PRIVATE_TOKEN'},
                 'kind': 'U123456789', 'ErrorMessage': 'PRIVATE_MESSAGE'}
        result = safe_outcome(value)
        self.assertEqual(result['network'], {k: v for k, v in value['network'].items() if k in SAFE_KEYS})
        self.assertEqual(result['kind'], '[ACCOUNT_REDACTED]'); self.assertNotIn('PRIVATE_', json.dumps(result))
        for value in [None, [], 'PRIVATE_XML']:
            self.assertEqual(safe_outcome(value), {})

if __name__ == '__main__':
    unittest.main()
