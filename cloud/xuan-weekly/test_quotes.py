import datetime as dt
import unittest
from quotes import parse,calendar,SourceError
def fixture():
    stamps=[int(dt.datetime(2026,7,31,15,tzinfo=dt.timezone.utc).timestamp()),
            int(dt.datetime(2026,8,3,15,tzinfo=dt.timezone.utc).timestamp())]
    return {'chart':{'result':[{'meta':{'symbol':'CSPX.L','currency':'USD','exchangeName':'LSE','instrumentType':'ETF'},
        'timestamp':stamps,'indicators':{'quote':[{'close':[100,101]}]}}]}}
class Tests(unittest.TestCase):
    def test_weekend(self):
        r=parse(fixture(),'CSPX','2026-08-03');self.assertEqual(r['2026-08-01']['status'],'closed')
    def test_wrong_currency(self):
        f=fixture();f['chart']['result'][0]['meta']['currency']='GBP'
        with self.assertRaises(SourceError):parse(f,'CSPX','2026-08-03')
    def test_missing_is_not_closed(self):
        f=fixture();f['chart']['result'][0]['indicators']['quote'][0]['close'][1]=None
        with self.assertRaisesRegex(SourceError,'missing_close'):parse(f,'CSPX','2026-08-03')
    def test_calendar_expiry(self):
        with self.assertRaises(SourceError):calendar('2027-01-01')
    def test_split(self):
        f=fixture();f['chart']['result'][0]['events']={'splits':{'a':{}}}
        with self.assertRaisesRegex(SourceError,'split_review'):parse(f,'CSPX','2026-08-03')
if __name__=='__main__':unittest.main()
