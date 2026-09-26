"""Public USD LSE daily closes; no financial-account data sent to provider."""
import datetime as dt
import hashlib
import json
import math
import time
import urllib.request
from zoneinfo import ZoneInfo
from ib_source import SourceError, NoRedirect

SYMBOLS = ('CSPX','EXUS','EIMI','USSC')
# Reviewed 2026 London market full closures. Half days still require a close.
# https://www.londonstockexchange.com/securities-trading/trading-access/business-days
HOLIDAYS = {'2026-01-01','2026-04-03','2026-04-06','2026-05-04',
            '2026-05-25','2026-08-31','2026-12-25','2026-12-28'}
BASE = dt.date(2026,7,31)
def calendar(cutoff):
    end=dt.date.fromisoformat(cutoff)
    if end < BASE or end.year != 2026: raise SourceError('calendar_review_required')
    return [BASE+dt.timedelta(days=n) for n in range((end-BASE).days+1)]
def parse(payload, symbol, cutoff):
    try:
        result=payload['chart']['result'][0]; meta=result['meta']
        if (meta['symbol']!=symbol+'.L' or meta['currency']!='USD'
            or meta['exchangeName']!='LSE' or meta['instrumentType']!='ETF'):
            raise ValueError()
        if result.get('events',{}).get('splits'): raise SourceError('split_review_required')
        times=result['timestamp']; closes=result['indicators']['quote'][0]['close']
        if len(times)!=len(closes): raise ValueError()
        values={}
        for stamp,value in zip(times,closes):
            if value is None: continue
            day=dt.datetime.fromtimestamp(stamp,ZoneInfo('Europe/London')).date().isoformat()
            if not isinstance(value,(int,float)) or not math.isfinite(value) or value<=0: raise ValueError()
            if day in values and values[day]!=value: raise ValueError()
            values[day]=value
        out={}
        for day in calendar(cutoff):
            key=day.isoformat()
            if day.weekday()>=5 or key in HOLIDAYS:
                out[key]={'status':'closed'}
            elif key in values:
                out[key]={'status':'close','date':key,'usd':values[key],
                          'source':'Yahoo Finance '+symbol+'.L USD unadjusted close'}
            else: raise SourceError('missing_close_'+symbol+'_'+key)
        return out
    except SourceError: raise
    except (KeyError,IndexError,TypeError,ValueError): raise SourceError('invalid_quote_'+symbol) from None
def fetch_quotes(cutoff):
    days=calendar(cutoff); quotes={d.isoformat():{} for d in days}; evidence={}
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())
    end=int(dt.datetime.combine(days[-1]+dt.timedelta(days=1),dt.time(),dt.timezone.utc).timestamp())
    start=int(dt.datetime(2026,7,30,tzinfo=dt.timezone.utc).timestamp())
    for symbol in SYMBOLS:
        url=f'https://query1.finance.yahoo.com/v8/finance/chart/{symbol}.L?period1={start}&period2={end}&interval=1d&events=splits'
        request=urllib.request.Request(url,headers={'User-Agent':'XUAN-Weekly-ReadOnly/1.0'})
        raw=None
        for attempt in range(2):
            try:
                with opener.open(request,timeout=25) as response: raw=response.read(2_000_001)
                if len(raw)>2_000_000: raise SourceError('quote_too_large')
                break
            except SourceError: raise
            except Exception:
                if attempt: raise SourceError('quote_network_'+symbol) from None
                time.sleep(3)
        parsed=parse(json.loads(raw),symbol,cutoff)
        for day,item in parsed.items(): quotes[day][symbol]=item
        evidence[symbol]={'sha256':hashlib.sha256(raw).hexdigest(),'payload':json.loads(raw)}
    return quotes,evidence
