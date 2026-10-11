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

if __name__=='__main__':unittest.main()
