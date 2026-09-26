"""Isolated private weekly report. Fixed read-only sources, immutable outputs."""
import datetime as dt
import hashlib
import json
import os
import subprocess
import time
import urllib.parse
import urllib.request
import uuid
from ib_source import fetch, normalize, SourceError, NoRedirect
from quotes import fetch_quotes,calendar

GATEWAY='https://family-portfolio-gateway-6ikas4b3ma-df.a.run.app'
ACCOUNTS={'IB-HK':936247,'Schwab-HK':936249,'Webull':1350094}
def get(path,params=None):
    if path not in ('/v1/portfolios','/v1/performance'):raise SourceError('forbidden_route')
    url=GATEWAY+path+('?' + urllib.parse.urlencode(params) if params else '')
    req=urllib.request.Request(url,headers={'Authorization':'Bearer '+os.environ['GATEWAY_READ_TOKEN']})
    try:
        opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())
        with opener.open(req,timeout=90) as response: raw=response.read(8_000_001)
        if len(raw)>8_000_000:raise SourceError('gateway_response_large')
        return json.loads(raw)
    except SourceError:raise
    except Exception:raise SourceError('gateway_read_failed') from None
def run():
    from google.cloud import storage
    start=time.monotonic(); now=lambda:dt.datetime.now(dt.timezone.utc).isoformat()
    if os.environ['WEEKLY_BUCKET']!='family-portfolio-gateway-xuan-weekly-private':raise SourceError('wrong_bucket')
    bucket=storage.Client().bucket(os.environ['WEEKLY_BUCKET'])
    stamp=now();prefix='weekly/'+stamp+'-'+uuid.uuid4().hex+'/'
    def save(name,body,kind='application/json'):
        if not isinstance(body,(str,bytes)):body=json.dumps(body)
        bucket.blob(prefix+name).upload_from_string(body,content_type=kind,if_generation_match=0,timeout=60)
    try:
        raw=fetch(os.environ['IB_FLEX_TOKEN']); ib=normalize(raw,os.environ['IB_ACCOUNT_SHA256'])
        save('ib.xml',raw,'application/xml');save('ib.json',ib)
        cutoff=ib['coverage']['to']
        today=dt.datetime.now(dt.timezone.utc).date()
        if not 0<=(today-dt.date.fromisoformat(cutoff)).days<=3:raise SourceError('ib_stale')
        if ib['coverage']['unresolvedDates']:raise SourceError('ib_unresolved_flows')
        q,evidence,abc_cutoff=fetch_quotes(cutoff);save('quotes.json',evidence)
        ib['coverage']['closedDates']=[d.isoformat() for d in calendar(abc_cutoff) if d.weekday()>=5]
        live=get('/v1/portfolios');save('portfolios.json',live)
        mapping={str(p['name']):int(p['id']) for p in live['portfolios']}
        if any(mapping.get(name)!=pid for name,pid in ACCOUNTS.items()):raise SourceError('portfolio_identity_changed')
        receipts=[]
        for name in ACCOUNTS:
            begin=now();raw=get('/v1/performance',{'portfolio':name,'start_date':cutoff,'end_date':cutoff,
                                                'grouping':'investment_type','include_sales':'false'})
            if raw.get('mode')!='read_only':raise SourceError('gateway_not_read_only')
            receipts.append({'status':'ok','startedAt':begin,'completedAt':now(),'raw':{'result':raw}})
        save('sharesight.json',receipts)
        previous=None
        # Only successful immutable bundles contain records.json. No shared
        # mutable latest pointer: retries cannot overwrite a newer report.
        blobs=[b for b in bucket.list_blobs(prefix='weekly/') if b.name.endswith('/bundle.json')]
        if blobs:
            prior=json.loads(max(blobs,key=lambda b:b.name).download_as_bytes())
            previous=prior['records']
        request={'abc':{**ib,'cutoff':abc_cutoff,'quotes':q},'sharesight':receipts,
                 'riskCutoff':cutoff,'previousRecords':previous}
        result=subprocess.run(['node','scripts/xuan-weekly-build.mjs'],input=json.dumps(request),
                              capture_output=True,text=True,timeout=60,check=False)
        if result.returncode:raise SourceError('weekly_calculation_failed:'+result.stderr[:200])
        bundle=json.loads(result.stdout);save('bundle.json',bundle)
        save('report.html',bundle['html'],'text/html; charset=utf-8')
        receipt={**bundle['receipt'],'completedAt':now(),'elapsedSeconds':round(time.monotonic()-start,2),
            'requestedCutoff':cutoff,'quotesLagDays':(dt.date.fromisoformat(cutoff)-dt.date.fromisoformat(abc_cutoff)).days,
            'privateReportObject':prefix+'report.html','htmlSha256':hashlib.sha256(bundle['html'].encode()).hexdigest()}
        save('receipt.json',receipt);print(json.dumps(receipt),flush=True)
        return 0
    except Exception as error:
        code=str(error) if isinstance(error,SourceError) else type(error).__name__
        receipt={'complete':False,'completedAt':now(),'code':code,'elapsedSeconds':round(time.monotonic()-start,2)}
        save('failure.json',receipt);print(json.dumps(receipt),flush=True);return 1
if __name__=='__main__':raise SystemExit(run())
