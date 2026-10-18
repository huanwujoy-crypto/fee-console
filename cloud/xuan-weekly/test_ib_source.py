import hashlib
import unittest
from ib_source import normalize, SourceError
ACCOUNT = 'TEST_ACCOUNT'
HASH = hashlib.sha256(ACCOUNT.encode()).hexdigest()
def sample(deposit='100', amount='100', asset='0'):
    change = dict(accountId=ACCOUNT,currency='USD',fromDate='2026-08-03',toDate='2026-08-03',
        startingValue='1000',endingValue='1100',depositsWithdrawals=deposit,assetTransfers=asset,
        internalCashTransfers='0',paxosTransfers='0',excessFundSweep='0',debitCardActivity='0',
        billPay='0',donations='0',grantActivity='0',linkingAdjustments='0',other='0')
    attrs = ' '.join(f'{k}="{v}"' for k,v in change.items())
    return f'''<FlexQueryResponse queryName="XUAN_Weekly_NAV_ReadOnly"><FlexStatements>
    <FlexStatement accountId="{ACCOUNT}"><EquitySummaryInBase>
    <EquitySummaryByReportDateInBase accountId="{ACCOUNT}" currency="USD" reportDate="2026-07-31" total="1000"/>
    <EquitySummaryByReportDateInBase accountId="{ACCOUNT}" currency="USD" reportDate="2026-08-03" total="1100"/>
    </EquitySummaryInBase><ChangeInNAV {attrs}/><CashTransactions>
    <CashTransaction accountId="{ACCOUNT}" currency="USD" reportDate="2026-08-03" type="Deposits/Withdrawals"
      levelOfDetail="DETAIL" transactionID="123" amount="{amount}" fxRateToBase="1"/>
    </CashTransactions></FlexStatement></FlexStatements></FlexQueryResponse>'''.encode()
class Tests(unittest.TestCase):
    def test_good(self):
        r=normalize(sample(),HASH)
        self.assertEqual(r['diagnostics']['unresolvedDates'],[])
        self.assertEqual(r['flows'][0]['usd'],100)
    def test_mismatch(self):
        self.assertEqual(normalize(sample(amount='99'),HASH)['diagnostics']['unresolvedDates'],[])
        self.assertEqual(normalize(sample(amount='90'),HASH)['diagnostics']['unresolvedDates'],['2026-08-03'])
    def test_asset_transfer(self):
        for value in ('40','-40'):
            r=normalize(sample(asset=value),HASH)
            self.assertEqual(r['diagnostics']['unresolvedDates'],[])
            self.assertEqual(r['diagnostics']['assetTransferDays'],1)
            self.assertEqual(sum(f['usd'] for f in r['flows']),100+float(value))
    def test_asset_transfer_duplicate_statements(self):
        data=sample(asset='-40')
        statement=data.split(b'<FlexStatement accountId=')[1].split(b'</FlexStatement>')[0]
        data=data.replace(b'</FlexStatements>',b'<FlexStatement accountId='+statement+b'</FlexStatement></FlexStatements>')
        r=normalize(data,HASH)
        self.assertEqual(r['diagnostics']['assetTransferDays'],1)
        self.assertEqual(sum(f['usd'] for f in r['flows']),60)
    def test_other_adjustment_still_unresolved(self):
        data=sample().replace(b'internalCashTransfers="0"',b'internalCashTransfers="40"')
        self.assertEqual(normalize(data,HASH)['diagnostics']['unresolvedDates'],['2026-08-03'])
    def test_account(self):
        with self.assertRaisesRegex(SourceError,'wrong_account'):normalize(sample(),'a'*64)
    def test_nonfinite(self):
        with self.assertRaisesRegex(SourceError,'invalid_money'):normalize(sample(amount='NaN'),HASH)
    def test_xxe(self):
        with self.assertRaisesRegex(SourceError,'unsafe_xml'):normalize(b'<!DOCTYPE x>'+sample(),HASH)
    def test_duplicates(self):
        data=sample();event=data.split(b'<CashTransaction ')[1].split(b'/>')[0]
        data=data.replace(b'</CashTransactions>',b'<CashTransaction '+event+b'/></CashTransactions>')
        self.assertEqual(len(normalize(data,HASH)['flows']),1)
    def test_conflict(self):
        data=sample();event=data.split(b'<CashTransaction ')[1].split(b'/>')[0].replace(b'amount="100"',b'amount="101"')
        data=data.replace(b'</CashTransactions>',b'<CashTransaction '+event+b'/></CashTransactions>')
        with self.assertRaisesRegex(SourceError,'conflicting_cash_id'):normalize(data,HASH)
    def test_income_not_flow(self):
        r=normalize(sample(deposit='0').replace(b'type="Deposits/Withdrawals"',b'type="Dividends"'),HASH)
        self.assertEqual(r['flows'],[])
        self.assertEqual(r['diagnostics']['unresolvedDates'],[])


# All fetch responses, tokens, clocks and openers below are synthetic and offline.
from unittest.mock import MagicMock, patch
from ib_source import fetch, safe_polling, POLL_LIMIT

SEND = b'<FlexStatementResponse><Status>Success</Status><ReferenceCode>123</ReferenceCode></FlexStatementResponse>'
READY = b'<FlexQueryResponse/>'
def pending(code='1019'):
    return ('<FlexStatementResponse><Status>Fail</Status><ErrorCode>'+code+
            '</ErrorCode></FlexStatementResponse>').encode()

class SyntheticIB:
    def __init__(self, bodies, cost=0):
        self.clock=0; self.bodies=iter(bodies); self.cost=cost; self.calls=[]; self.sleeps=[]
        self.opener=MagicMock(); self.opener.open.side_effect=self.open
    def open(self, request, **kwargs):
        self.calls.append((request, kwargs)); self.clock+=self.cost
        body=next(self.bodies)
        if isinstance(body, Exception):raise body
        response=MagicMock();response.__enter__.return_value.read.return_value=body
        return response
    def sleep(self, seconds):self.sleeps.append(seconds);self.clock+=seconds
    def patches(self):
        return (patch('ib_source.urllib.request.build_opener',return_value=self.opener),
                patch('ib_source.time.monotonic',side_effect=lambda:self.clock),
                patch('ib_source.time.sleep',side_effect=self.sleep))
    def fetch(self, **kwargs):
        with self.patches()[0], self.patches()[1], self.patches()[2]:
            return fetch('SYNTHETIC_TOKEN', **kwargs)

class FetchTests(unittest.TestCase):
    def test_ready_on_twenty_first_after_twenty_pending(self):
        source=SyntheticIB([SEND]+[pending()]*20+[READY],cost=(135.24-20*6.2)/21)
        self.assertEqual(source.fetch(),READY)
        self.assertEqual(len(source.calls),22)
        self.assertLess(source.clock,150)
        self.assertEqual(sum('SendRequest' in c[0] for c in source.calls),1)
        self.assertEqual(len(set(c[0] for c in source.calls[1:])),1)
        self.assertTrue(all(s==6.2 for s in source.sleeps))

    def test_pending_limit_has_independent_safe_evidence(self):
        for code,state in [('1019','statement_pending'),('1009','busy')]:
            source=SyntheticIB([SEND]+[pending(code)]*POLL_LIMIT)
            with self.assertRaises(SourceError) as caught:source.fetch()
            detail=caught.exception.polling
            self.assertEqual(detail['termination'],'poll_limit')
            self.assertEqual(detail['pollCount'],24);self.assertEqual(detail['state'],state)
            self.assertEqual(safe_polling(detail),detail)
            self.assertIsNone(caught.exception.network)
            self.assertEqual(len(source.calls),25)
            self.assertLess(source.clock,150)

    def test_twenty_pending_then_budget_exhaustion(self):
        source=SyntheticIB([SEND]+[pending()]*20,cost=1)
        with self.assertRaises(SourceError) as caught:source.fetch()
        self.assertEqual(caught.exception.polling['pollCount'],20)
        self.assertEqual(caught.exception.polling['termination'],'budget_exhausted')
        self.assertEqual(len(source.calls),21)
        self.assertLess(source.clock,150)

    def test_outer_deadline_and_own_budget_never_expand(self):
        for kwargs,expected in [({'deadline':10},1),({'timeout':600,'deadline':600},24)]:
            source=SyntheticIB([SEND]+[pending()]*24)
            with self.assertRaises(SourceError) as caught:source.fetch(**kwargs)
            self.assertEqual(caught.exception.polling['pollCount'],expected)
            self.assertLess(source.clock,min(kwargs.get('deadline',150),150))
            for _,request in source.calls:self.assertLessEqual(request['timeout'],30)
        source=SyntheticIB([SEND])
        with self.assertRaisesRegex(SourceError,'deadline') as caught:source.fetch(deadline=6.2)
        self.assertFalse(hasattr(caught.exception,'polling'));self.assertEqual(len(source.calls),1)

    def test_request_timeout_uses_exact_remaining_budget(self):
        source=SyntheticIB([SEND,pending()])
        with self.assertRaises(SourceError):source.fetch(deadline=10)
        self.assertAlmostEqual(source.calls[1][1]['timeout'],3.8)

    def test_pending_is_not_sticky_across_terminal_errors(self):
        for body in [pending('1003'), pending('1012'), pending('9999'), b'bad XML',
                     b'<!DOCTYPE x><FlexStatementResponse/>',
                     pending().replace(b'FlexStatementResponse',b'Unknown'),
                     pending().replace(b'<Status>Fail</Status>',b'<Status>Success</Status>'),
                     pending().replace(b'</Status>',b'<Injected>INVALID</Injected></Status>'),
                     pending().replace(b'</ErrorCode>',b'<Injected>INVALID</Injected></ErrorCode>'),
                     pending().replace(b'</ErrorCode>',b'</ErrorCode><ErrorCode>1019</ErrorCode>')]:
            with self.subTest(body=body):
                source=SyntheticIB([SEND,pending(),body])
                with self.assertRaises(SourceError) as caught:source.fetch()
                self.assertFalse(hasattr(caught.exception,'polling'))
                self.assertEqual(len(source.calls),3)
        source=SyntheticIB([SEND,pending()]+[TimeoutError('SYNTHETIC_PRIVATE')]*3)
        with self.assertRaises(SourceError) as caught:source.fetch()
        self.assertFalse(hasattr(caught.exception,'polling'))
        self.assertEqual(caught.exception.network['category'],'timeout')
        self.assertEqual(caught.exception.network['attempts'],3)

    def test_bad_send_response_never_creates_pending_evidence(self):
        for body in [SEND.replace(b'123',b'bad'),SEND.replace(b'FlexStatementResponse',b'Unknown'),
                     SEND.replace(b'</Status>',b'</Status><Status>Success</Status>'),
                     SEND.replace(b'</Status>',b'<Injected>INVALID</Injected></Status>'),
                     SEND.replace(b'</ReferenceCode>',b'<Injected>INVALID</Injected></ReferenceCode>'),
                     SEND.replace(b'</ReferenceCode>',b'</ReferenceCode><ReferenceCode>456</ReferenceCode>'),
                     pending('1019')]:
            source=SyntheticIB([body])
            with self.assertRaisesRegex(SourceError,'ib_request_failed') as caught:source.fetch()
            self.assertFalse(hasattr(caught.exception,'polling'));self.assertEqual(len(source.calls),1)

    def test_invalid_budget_never_calls_network(self):
        for kwargs in [{'timeout':True},{'timeout':float('nan')},{'timeout':0},
                       {'deadline':True},{'deadline':float('inf')},{'deadline':0}]:
            source=SyntheticIB([])
            with self.assertRaises(SourceError):source.fetch(**kwargs)
            self.assertFalse(source.calls)

class StatementDiagnosticTests(unittest.TestCase):
    def rejected(self, body, send=False):
        from ib_source import safe_statement
        source = SyntheticIB([body] if send else [SEND, body])
        with self.assertRaises(SourceError) as caught:
            source.fetch()
        error = caught.exception
        self.assertEqual(str(error), 'ib_request_failed' if send else 'ib_statement_failed')
        self.assertIsNone(error.network)
        self.assertFalse(hasattr(error, 'polling'))
        self.assertEqual(safe_statement(error.statement), error.statement)
        self.assertEqual(len(source.calls), 1 if send else 2)
        return error.statement

    def test_official_v3_error_shapes_have_known_numeric_code_without_message(self):
        for code in ['1001', '1003', '1012', '1015', '1018', '1021']:
            body = pending(code).replace(b'</FlexStatementResponse>', b'<ErrorMessage>PRIVATE_NEVER_LOG</ErrorMessage></FlexStatementResponse>')
            for send in (False, True):
                detail = self.rejected(body, send)
                self.assertEqual(detail['upstreamErrorCode'], int(code))
                self.assertEqual(detail['errorCodeShape'], 'known')
                self.assertEqual(detail['pollCount'], 0 if send else 1)
                self.assertNotIn('PRIVATE_NEVER_LOG', repr(detail))

    def test_root_namespace_and_field_shapes_are_fixed_enums(self):
        cases = [
            (pending('1003').replace(b'FlexStatementResponse', b'PRIVATE_ROOT'), 'unexpected_root', 'known'),
            (pending('1003').replace(b'<FlexStatementResponse>', b'<FlexStatementResponse xmlns="urn:PRIVATE_NAMESPACE">'), 'unexpected_root', 'qualified'),
            (b'<FlexQueryResponse xmlns="urn:PRIVATE_NAMESPACE"/>', 'unexpected_root', 'missing'),
            (b'<FlexStatementResponse><Status>Fail</Status></FlexStatementResponse>', 'error_code_rejected', 'missing'),
            (pending('1003').replace(b'<ErrorCode>1003</ErrorCode>', b'<Errors><ErrorCode>1003</ErrorCode></Errors>'), 'error_code_rejected', 'nested'),
            (pending('1003').replace(b'</ErrorCode>', b'</ErrorCode><ErrorCode>1012</ErrorCode>'), 'error_code_rejected', 'ambiguous'),
            (pending('1003').replace(b'</FlexStatementResponse>', b'<Errors><ErrorCode>1012</ErrorCode></Errors></FlexStatementResponse>'), 'error_code_rejected', 'ambiguous'),
            (b'<FlexStatementResponse ErrorCode="PRIVATE_ATTRIBUTE"><Status>Fail</Status></FlexStatementResponse>', 'error_code_rejected', 'attribute'),
            (pending('1003').replace(b'<FlexStatementResponse>', b'<FlexStatementResponse ErrorCode="PRIVATE_ATTRIBUTE">'), 'error_code_rejected', 'ambiguous'),
            (pending('1003').replace(b'</ErrorCode>', b'<Child>PRIVATE_CHILD</Child></ErrorCode>'), 'error_code_rejected', 'nonleaf'),
            (pending('1003').replace(b'>Fail<', b'>Success<'), 'status_rejected', 'known'),
            (pending('1003').replace(b'</Status>', b'</Status><ReferenceCode>PRIVATE_REFERENCE</ReferenceCode>'), 'reference_present', 'known'),
        ]
        for body, reason, shape in cases:
            with self.subTest(reason=reason, shape=shape):
                detail = self.rejected(body)
                self.assertEqual(detail['reason'], reason)
                self.assertEqual(detail['errorCodeShape'], shape)
                self.assertNotIn('PRIVATE_', repr(detail))
                if shape != 'known':
                    self.assertIsNone(detail['upstreamErrorCode'])

    def test_numeric_code_never_normalizes_or_logs_arbitrary_text(self):
        for code in ['1002', '9999', '01003', ' 1003 ', '+1003', '1e03', '\u0661\u0660\u0660\u0663',
                     '1003\nPRIVATE_TOKEN', 'U123456789', 'https://private.invalid/?t=PRIVATE_TOKEN', '1' * 20000]:
            detail = self.rejected(pending(code))
            self.assertIsNone(detail['upstreamErrorCode'])
            self.assertNotIn('PRIVATE_', repr(detail))
            self.assertLess(len(repr(detail)), 400)

    def test_status_shape_does_not_copy_private_values(self):
        for tag, shape in [(b'<Status>PRIVATE_STATUS</Status>', 'noncanonical'),
                           (b'<Status>Fail</Status><Status>Success</Status>', 'ambiguous'),
                           (b'<Status>Fail<Child>PRIVATE_CHILD</Child></Status>', 'nonleaf'),
                           (b'<Nested><Status>Fail</Status></Nested>', 'nested'),
                           (b'<s:Status xmlns:s="urn:PRIVATE_NAMESPACE">Fail</s:Status>', 'qualified')]:
            detail = self.rejected(pending('1003').replace(b'<Status>Fail</Status>', tag))
            self.assertEqual(detail['statusShape'], shape)
            self.assertNotIn('PRIVATE_', repr(detail))

    def test_noncanonical_status_subclasses_remain_terminal_and_nonsticky(self):
        cases = [('', 'empty'), (' \t\n', 'xml_whitespace'),
                 (' Fail ', 'padded_fail'), ('\nSuccess\t', 'padded_success'),
                 ('Warn', 'literal_warn'), ('Warning', 'noncanonical'),
                 (' Warn ', 'noncanonical'), ('warn', 'noncanonical'),
                 ('fail', 'noncanonical'), ('\u00a0Fail\u00a0', 'noncanonical'),
                 ('PRIVATE_TOKEN_URL_ACCOUNT_AMOUNT', 'noncanonical'),
                 ('X' * 20000, 'noncanonical')]
        for status, shape in cases:
            for code in ('1019', '1009', '1003', '1012'):
                for prior in ([], [pending()]):
                    with self.subTest(shape=shape, code=code, prior=bool(prior)):
                        body = pending(code).replace(b'>Fail<', ('>' + status + '<').encode())
                        source = SyntheticIB([SEND] + prior + [body])
                        with self.assertRaisesRegex(SourceError, 'ib_statement_failed') as caught:
                            source.fetch()
                        error = caught.exception
                        self.assertFalse(hasattr(error, 'polling'))
                        self.assertEqual(error.statement['statusShape'], shape)
                        self.assertEqual(error.statement['reason'], 'status_rejected')
                        self.assertEqual(error.statement['upstreamErrorCode'], int(code))
                        self.assertEqual(len(source.calls), 2 + len(prior))
                        self.assertNotIn('PRIVATE_', repr(error.statement))
                        self.assertLess(len(repr(error.statement)), 400)

    def test_new_status_classes_do_not_override_structural_shapes(self):
        for status, shape in [
                ('<Status> Fail </Status><Status/>', 'ambiguous'),
                ('<Nested><Status> Fail </Status></Nested>', 'nested'),
                ('<s:Status xmlns:s="urn:PRIVATE_NS"> Fail </s:Status>', 'qualified'),
                ('<Status> Fail <Child/></Status>', 'nonleaf')]:
            body = pending().replace(b'<Status>Fail</Status>', status.encode())
            self.assertEqual(self.rejected(body)['statusShape'], shape)
        body = b'<FlexStatementResponse Status="PRIVATE_ATTRIBUTE"><ErrorCode>1019</ErrorCode></FlexStatementResponse>'
        self.assertEqual(self.rejected(body)['statusShape'], 'attribute')

    def test_baseline_ignored_extra_fields_are_not_silently_hardened(self):
        # Document existing acceptance separately from stricter diagnostic shape checks.
        extras = [b'<Nested><Status>PRIVATE_STATUS</Status></Nested>',
                  b'<s:ErrorCode xmlns:s="urn:PRIVATE_NS">1003</s:ErrorCode>',
                  b'<Nested><ReferenceCode>PRIVATE_REF</ReferenceCode></Nested>']
        for extra in extras:
            body = pending().replace(b'</FlexStatementResponse>', extra + b'</FlexStatementResponse>')
            source = SyntheticIB([SEND, body, READY])
            self.assertEqual(source.fetch(), READY)
            self.assertEqual(len(source.calls), 3)
        body = pending().replace(b'<FlexStatementResponse>', b'<FlexStatementResponse Status="PRIVATE_ATTRIBUTE">')
        self.assertEqual(SyntheticIB([SEND, body, READY]).fetch(), READY)

    def test_validator_rejects_extra_fields_types_and_inconsistent_codes(self):
        from ib_source import safe_statement
        valid = self.rejected(pending('1003'))
        bad = [{**valid, key: value} for key, value in [
            ('operation', 'PRIVATE_OPERATION'), ('reason', 'PRIVATE_REASON'), ('rootKind', 'PRIVATE_ROOT'),
            ('namespacePresent', 1), ('pollCount', True), ('pollCount', 0), ('pollCount', 25),
            ('pollCount', 1.0), ('upstreamErrorCode', True), ('upstreamErrorCode', '1003'),
            ('upstreamErrorCode', 9999), ('errorCodeShape', 'PRIVATE_SHAPE'), ('statusShape', 'known'),
            ('errorCodeShape', 'missing'), ('ErrorMessage', 'PRIVATE_MESSAGE'), ('xml', 'PRIVATE_XML')]]
        for value in bad + [None, [], {}, {k: v for k, v in valid.items() if k != 'reason'}]:
            self.assertIsNone(safe_statement(value))

    def test_success_pending_and_invalid_xml_behavior_are_unchanged(self):
        source = SyntheticIB([SEND, pending(), READY])
        self.assertEqual(source.fetch(), READY)
        self.assertEqual(len(source.calls), 3)
        source = SyntheticIB([SEND, b'<FlexQueryResponse><Status>Fail</Status><ErrorCode>1015</ErrorCode></FlexQueryResponse>'])
        self.assertEqual(source.fetch(), b'<FlexQueryResponse><Status>Fail</Status><ErrorCode>1015</ErrorCode></FlexQueryResponse>')
        source = SyntheticIB([SEND, b'bad XML'])
        with self.assertRaisesRegex(SourceError, 'invalid_xml') as caught:
            source.fetch()
        self.assertFalse(hasattr(caught.exception, 'statement'))

if __name__=='__main__':unittest.main()
