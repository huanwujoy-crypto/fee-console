"""Private source acceptance job. Not a published/complete weekly report."""
import datetime as dt
import json
import os
import sys
import time
import uuid
from ib_source import fetch, normalize, SourceError

def run():
    from google.cloud import storage
    from google.api_core.exceptions import PreconditionFailed
    start=time.monotonic()
    bucket_name=os.environ['WEEKLY_BUCKET']
    if bucket_name != 'family-portfolio-gateway-xuan-weekly-private':
        raise SourceError('wrong_archive_destination')
    bucket=storage.Client().bucket(bucket_name)
    # Enforced private bucket policy is verified separately at deployment.
    data=fetch(os.environ['IB_FLEX_TOKEN'])
    result=normalize(data,os.environ['IB_ACCOUNT_SHA256'])
    sha=result['coverage']['sha256']
    for suffix,body,ctype in [('xml',data,'application/xml'),
        ('json',json.dumps(result).encode(),'application/json')]:
        blob=bucket.blob(f'ib-source/{sha}.{suffix}')
        try:blob.upload_from_string(body,content_type=ctype,if_generation_match=0,timeout=60)
        except PreconditionFailed:pass # Content-addressed immutable object already exists.
    stamp=dt.datetime.now(dt.timezone.utc).isoformat()
    receipt={'schemaVersion':1,'stage':'ib-source-verified','completedAt':stamp,
        'dataThrough':result['coverage']['to'],'sourceSha256':sha,
        'elapsedSeconds':round(time.monotonic()-start,2),**result['diagnostics'],
        'weeklyReportComplete':False,'abcComplete':False}
    bucket.blob(f'receipts/{stamp}-{uuid.uuid4().hex}.json').upload_from_string(
        json.dumps(receipt),content_type='application/json',if_generation_match=0,timeout=60)
    print(json.dumps(receipt),flush=True)
    return 0

if __name__=='__main__':
    try:sys.exit(run())
    except SourceError as e:
        print(json.dumps({'stage':'failed','code':str(e)}),flush=True);sys.exit(1)
    except Exception as e:
        # Never print exception URLs, environment values or source payloads.
        print(json.dumps({'stage':'failed','code':type(e).__name__}),flush=True);sys.exit(1)
