"""Isolated private weekly report. Fixed read-only sources, immutable outputs."""
import datetime as dt
import hashlib
import json
import os
import re
import subprocess
import time
import urllib.parse
import urllib.request
import uuid
from ib_source import fetch, normalize, SourceError, NoRedirect
from quotes import fetch_quotes,calendar
from latest import publish_latest
from public_entry import publish_public
from ai_history import select_comparison
from network import read_get, OPERATIONS

GATEWAY='https://family-portfolio-gateway-6ikas4b3ma-df.a.run.app'
ACCOUNTS={'IB-HK':936247,'Schwab-HK':936249,'Webull':1350094}
FAILURE_CODES=set('''forbidden_route gateway_response_large gateway_invalid_json gateway_read_failed
wrong_bucket ib_network_error ib_stale ib_unresolved_flows portfolio_identity_changed gateway_not_read_only
weekly_calculation_failed calendar_review_required split_review_required distribution_review_required
quote_too_large quotes_stale_over_three_days invalid_money invalid_date unsafe_xml invalid_xml xml_too_large
missing_token deadline ib_request_failed ib_statement_failed wrong_query empty_statements missing_account_binding
wrong_account wrong_nav_currency nonpositive_nav conflicting_nav nav_change_not_daily conflicting_daily_change
cash_not_detail missing_cash_id invalid_fx conflicting_cash_id conflicting_asset_transfer
missing_baseline_or_daily_changes'''.split())
def get(path,params=None,*,deadline=None):
    if path not in ('/v1/portfolios','/v1/performance'):raise SourceError('forbidden_route')
    url=GATEWAY+path+('?' + urllib.parse.urlencode(params) if params else '')
    req=urllib.request.Request(url,headers={'Authorization':'Bearer '+os.environ['GATEWAY_READ_TOKEN']})
    try:
        opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())
        limit=time.monotonic()+90
        if deadline is not None:limit=min(limit,deadline)
        raw=read_get(opener,req,operation='gateway_portfolios' if path=='/v1/portfolios'
                     else 'gateway_performance',code='gateway_read_failed',deadline=limit,
                     max_bytes=8_000_000)
        if len(raw)>8_000_000:raise SourceError('gateway_response_large')
        return json.loads(raw)
    except SourceError:raise
    except json.JSONDecodeError:raise SourceError('gateway_invalid_json') from None
    except Exception:raise SourceError('gateway_read_failed') from None

def failure_code(error):
    # Source errors are application-owned symbolic codes, never stderr or URL text.
    if isinstance(error,SourceError):
        code=str(error)
        if code in FAILURE_CODES or re.fullmatch(
                r'(?:(?:quote_network|invalid_quote)_(?:CSPX|EXUS|EIMI|USSC)|'
                r'missing_close_(?:CSPX|EXUS|EIMI|USSC)_\d{4}-\d{2}-\d{2})',code):
            return code
    if isinstance(error,subprocess.TimeoutExpired):return 'weekly_calculation_timeout'
    if isinstance(error,json.JSONDecodeError):return 'invalid_json'
    if isinstance(error,KeyError):return 'missing_configuration_or_field'
    if isinstance(error,ValueError) and str(error) in ('unknown_latest_metadata','latest_run_conflict',
            'invalid_source','wrong_public_bucket','invalid_report_html','active_report_html'):
        return str(error)
    return 'unexpected_error'

def safe_network(error):
    detail=getattr(error,'network',None)
    if not isinstance(detail,dict) or type(detail.get('operation')) is not str:return None
    if detail['operation'] not in OPERATIONS:return None
    if detail.get('category') not in ('http','tls','timeout','dns','connection','other','deadline'):return None
    if type(detail.get('attempts')) is not int or not 0<=detail['attempts']<=3:return None
    if type(detail.get('retryable')) is not bool:return None
    safe={k:detail[k] for k in ('operation','category','attempts','retryable')}
    status=detail.get('httpStatus')
    if type(status) is int and 100<=status<=599:safe['httpStatus']=status
    return safe

def run(*, stamp=None, prefix=None, outer_deadline=None):
    start=time.monotonic(); now=lambda:dt.datetime.now(dt.timezone.utc).isoformat()
    # Reserve time in the existing 600-second job for calculation and publication.
    network_deadline=start+360
    if outer_deadline is not None:
        network_deadline=min(network_deadline,outer_deadline-180)
    stage='configuration';bucket=None
    stamp=stamp or now();prefix=prefix or 'weekly/'+stamp+'-'+uuid.uuid4().hex+'/'
    def save(name,body,kind='application/json'):
        nonlocal stage
        stage='archive_'+name.replace('.','_')
        if not isinstance(body,(str,bytes)):body=json.dumps(body)
        bucket.blob(prefix+name).upload_from_string(body,content_type=kind,if_generation_match=0,timeout=60)
    try:
        from google.cloud import storage
        if os.environ['WEEKLY_BUCKET']!='family-portfolio-gateway-xuan-weekly-private':raise SourceError('wrong_bucket')
        client=storage.Client()
        bucket=client.bucket(os.environ['WEEKLY_BUCKET'])
        stage='ib_fetch'
        raw=fetch(os.environ['IB_FLEX_TOKEN'])
        stage='ib_validate'
        ib=normalize(raw,os.environ['IB_ACCOUNT_SHA256'])
        save('ib.xml',raw,'application/xml');save('ib.json',ib)
        stage='ib_validate'
        cutoff=ib['coverage']['to']
        today=dt.datetime.now(dt.timezone.utc).date()
        if not 0<=(today-dt.date.fromisoformat(cutoff)).days<=3:raise SourceError('ib_stale')
        if ib['coverage']['unresolvedDates']:raise SourceError('ib_unresolved_flows')
        stage='quotes_fetch'
        q,evidence,abc_cutoff=fetch_quotes(cutoff,deadline=network_deadline);save('quotes.json',evidence)
        ib['coverage']['closedDates']=[d.isoformat() for d in calendar(abc_cutoff) if d.weekday()>=5]
        stage='gateway_portfolios'
        live=get('/v1/portfolios',deadline=network_deadline);save('portfolios.json',live)
        stage='gateway_identity'
        mapping={str(p['name']):int(p['id']) for p in live['portfolios']}
        if any(mapping.get(name)!=pid for name,pid in ACCOUNTS.items()):raise SourceError('portfolio_identity_changed')
        receipts=[]
        for name in ACCOUNTS:
            stage='gateway_performance'
            begin=now();raw=get('/v1/performance',{'portfolio':name,'start_date':cutoff,'end_date':cutoff,
                                                'grouping':'investment_type','include_sales':'false'},deadline=network_deadline)
            if raw.get('mode')!='read_only':raise SourceError('gateway_not_read_only')
            receipts.append({'status':'ok','startedAt':begin,'completedAt':now(),'raw':{'result':raw}})
        save('sharesight.json',receipts)
        previous=None;exposure_history=[];dual_history=[];history_warning=False
        # Archive comparison is optional; it must not block current source data.
        try:blobs=[b for b in bucket.list_blobs(prefix='weekly/') if b.name.endswith('/bundle.json')]
        except Exception:blobs=[];history_warning=True
        for index,blob in enumerate(sorted(blobs,key=lambda b:b.name,reverse=True)):
            # Bound archive reads; missing comparison never blocks this report.
            if index>=30:break
            try:prior=json.loads(blob.download_as_bytes())
            except Exception:history_warning=True;continue
            if previous is None:previous=prior.get('records')
            if prior.get('aiExposure'):exposure_history.append(prior['aiExposure'])
            if prior.get('aiDualExposure'):dual_history.append(prior['aiDualExposure'])
            if select_comparison(cutoff,exposure_history):break
        request={'abc':{**ib,'cutoff':abc_cutoff,'quotes':q},'sharesight':receipts,
                 'riskCutoff':cutoff,'previousRecords':previous,
                 'previousExposure':select_comparison(cutoff,exposure_history),
                 'previousAiDualExposure':select_comparison(cutoff,dual_history)}
        stage='calculation'
        result=subprocess.run(['node','scripts/xuan-weekly-build.mjs'],input=json.dumps(request),
                              capture_output=True,text=True,timeout=60,check=False)
        if result.returncode:raise SourceError('weekly_calculation_failed')
        bundle=json.loads(result.stdout);save('bundle.json',bundle)
        save('report.html',bundle['html'],'text/html; charset=utf-8')
        receipt={**bundle['receipt'],'comparisonHistoryWarning':history_warning,'completedAt':now(),'elapsedSeconds':round(time.monotonic()-start,2),
            'requestedCutoff':cutoff,'quotesLagDays':(dt.date.fromisoformat(cutoff)-dt.date.fromisoformat(abc_cutoff)).days,
            'privateReportObject':prefix+'report.html','htmlSha256':hashlib.sha256(bundle['html'].encode()).hexdigest()}
        save('receipt.json',receipt)
        # Only publish after the immutable successful report and receipt exist.
        # IAM permits replacement of this exact object, not the archive.
        stage='private_latest'
        latest_status=publish_latest(bucket,bundle['html'],started_at=stamp,
            risk_date=cutoff,abc_date=abc_cutoff,source=prefix+'report.html')
        receipt['latestEntryStatus']=latest_status
        if os.environ.get('WEEKLY_PUBLIC_BUCKET'):
            stage='public_latest'
            receipt['publicEntryStatus']=publish_public(client,os.environ['WEEKLY_PUBLIC_BUCKET'],
                bundle['html'],started_at=stamp,risk_date=cutoff,abc_date=abc_cutoff)
        save('publication.json',receipt);print(json.dumps(receipt),flush=True)
        return 0
    except Exception as error:
        receipt={'complete':False,'severity':'ERROR','event':'xuan_weekly_failed',
                 'stage':stage,'completedAt':now(),'code':failure_code(error),
                 'elapsedSeconds':round(time.monotonic()-start,2)}
        network=safe_network(error)
        if network:receipt['network']=network
        # Emit first: archive trouble must not hide failure from existing logging.
        print(json.dumps(receipt),flush=True)
        if bucket is not None:
            try:save('failure.json',receipt)
            except Exception:
                print(json.dumps({'complete':False,'severity':'ERROR','event':'xuan_weekly_failed',
                                  'stage':'archive_failure_json','code':'failure_archive_failed',
                                  'completedAt':now()}),flush=True)
        return 1
if __name__=='__main__':raise SystemExit(run())
