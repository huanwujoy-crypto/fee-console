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
        self.assertEqual(normalize(sample(asset='40'),HASH)['diagnostics']['unresolvedDates'],['2026-08-03'])
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
if __name__=='__main__':unittest.main()
