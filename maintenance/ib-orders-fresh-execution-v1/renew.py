"""Existing Google SDK session only; default offline, one refresh HTTP maximum."""
from pathlib import Path
from types import SimpleNamespace
import hashlib, json, os, re, sys, time

SOURCE=Path(__file__).with_name('xuan-ib-orders-live-operator.mjs')
PRIVATE_BINDING_SHA256='550fa1b2fa3caa13308e34da4c41381e2b610e7e8add65e28e57a281a2c29522'

EXECUTION_DEADLINE_MS=None
def admit():
    if EXECUTION_DEADLINE_MS is not None and time.time()*1000>=EXECUTION_DEADLINE_MS:raise RuntimeError()

class OnceRequest:
    def __init__(self,session,closed):
        self.session=session;self.closed=closed
        self.reservations=0;self.response_received=False;self.http_status=None;self.rejection=None
    def __call__(self,url,method='GET',body=None,headers=None,**kwargs):
        def reject(code):self.rejection=code;raise self.closed()
        if self.reservations:reject('REPEAT_SUBMISSION_DENIED')
        if url!='https://oauth2.googleapis.com/token':reject('ENDPOINT_DENIED')
        if method!='POST':reject('METHOD_DENIED')
        if kwargs:reject('OPTIONS_DENIED')
        valid_body=(type(body) is str and body.startswith('grant_type=refresh_token&')) or (isinstance(body,(bytes,bytearray)) and body.startswith(b'grant_type=refresh_token&'))
        if not valid_body:reject('GRANT_BODY_DENIED')
        admit()
        # Reserve before HTTP; timeout/unknown results never cause a second submission.
        self.reservations=1
        response=None
        try:
            response=self.session.request('POST',url,data=body,headers=headers,timeout=(2,6),allow_redirects=False,stream=True)
            self.response_received=True
            status=response.status_code
            self.http_status=status if type(status) is int and 100<=status<=599 else None
            if response.url!=url or self.http_status is None: raise self.closed()
            raw=bytearray()
            for chunk in response.iter_content(4096):
                raw.extend(chunk)
                if len(raw)>65536: raise self.closed()
            return SimpleNamespace(status=status,data=bytes(raw),headers={})
        finally:
            if response is not None: response.close()

def renew_existing(account,credential,request,closed,account_check,audit):
    admit()
    if credential.valid is True:
        return {'state':'not-needed','requestReservations':0,'responseReceived':False,'httpStatus':None,'sdkCacheUpdate':'not-needed','identityMatched':True}
    # Prevent a broker or interactive reauthentication. No new scopes are supplied.
    if getattr(credential,'refresh_handler',None) is not None: raise closed()
    credential._enable_reauth_refresh=False
    audit['sdkRefreshInvoked']=True
    admit()
    credential.refresh(request)  # Existing SDK wrapper persists only its normal cache.
    if credential.valid is not True or account_check()!=account: raise closed()
    return {'state':'confirmed','requestReservations':request.reservations,'responseReceived':request.response_received,'httpStatus':request.http_status,'sdkCacheUpdate':'returned','identityMatched':True}

def admitted_sdk_identity(library):
    # Same fixed SDK identity as the reviewed source, with checks between local
    # SDK steps so a delayed account/store lookup cannot begin the next step.
    admit()
    sys.path[:0]=[library['ROOT']+'/lib',library['ROOT']+'/lib/third_party']
    from googlecloudsdk.core import properties
    from googlecloudsdk.core.credentials import creds
    from google.oauth2.credentials import Credentials
    admit();account=properties.VALUES.core.account.Get();admit()
    if not isinstance(account,str) or hashlib.sha256(account.encode()).hexdigest()!=library['HASH']:raise library['Closed']()
    store=creds.GetCredentialStore();admit();credential=store.Load(account);admit()
    if not isinstance(credential,Credentials):raise library['Closed']()
    return account,credential

def live():
    global EXECUTION_DEADLINE_MS
    out=os.dup(1)
    with open(os.devnull,'wb') as sink:os.dup2(sink.fileno(),1);os.dup2(sink.fileno(),2)
    import logging,http.client
    logging.disable(logging.CRITICAL);http.client.HTTPConnection.debuglevel=0
    ns={'__name__':'isolated_google_session_library'};session=None;request=None;audit={'sdkRefreshInvoked':False}
    result={'spec':'IB-ORDERS-GOOGLE-SESSION-RENEW-ONCE-v1','project':'family-portfolio-gateway',
            'newLogin':False,'newGrant':False,'newScopesRequested':False,'ibOAuthCalls':0,
            'financialCalls':0,'cloudWrites':0,'claimModified':False,'automaticRetry':False}
    try:
        raw_deadline=os.environ.get('IB_ORDERS_APPROVED_UNTIL_MS','')
        if not re.fullmatch(r'[1-9][0-9]{0,15}',raw_deadline):raise RuntimeError()
        EXECUTION_DEADLINE_MS=int(raw_deadline)
        if EXECUTION_DEADLINE_MS>9007199254740991:raise RuntimeError()
        admit()
        binding_path=Path(sys.argv[3]);binding_stat=binding_path.lstat();binding_dir=binding_path.parent.lstat()
        if binding_path.is_symlink() or not binding_path.is_file() or binding_stat.st_uid!=os.getuid() or binding_stat.st_nlink!=1 or binding_stat.st_mode&0o777!=0o600 or binding_dir.st_uid!=os.getuid() or binding_dir.st_mode&0o777!=0o700 or binding_path.parent.is_symlink():raise RuntimeError()
        binding_raw=binding_path.read_bytes()
        if hashlib.sha256(binding_raw).hexdigest()!=PRIVATE_BINDING_SHA256:raise RuntimeError()
        binding=json.loads(binding_raw);runtime=Path(binding['fresh']['runtime'])
        if Path(__file__).resolve().parent!=Path(binding['candidate']):raise RuntimeError()
        def private_json(p):
            st=p.lstat();parent=p.parent.lstat()
            if p.is_symlink() or not p.is_file() or st.st_uid!=os.getuid() or st.st_nlink!=1 or st.st_mode&0o777!=0o600 or parent.st_uid!=os.getuid() or parent.st_mode&0o777!=0o700 or p.parent.is_symlink():raise RuntimeError()
            return json.loads(p.read_bytes())
        claim=private_json(runtime/'fresh.claim.safe.json');renew_claim=private_json(runtime/'google-renew-once.claim.safe.json')
        approval=private_json(Path(binding['approvalPath']))
        if claim['operationId']!=binding['fresh']['operationId'] or claim['authorizationId']!=binding['fresh']['authorizationId'] or claim['previousRecordsDigest']!=binding['previousDigest'] or claim['oldRemainingRegistrationMaximum']!=0 or claim['remainingRegistrationMaximum']!=(0 if binding.get('existingClient') else 1) or claim['cumulativePossibleRegistrationMaximum']!=3:raise RuntimeError()
        if renew_claim!={'spec':binding['fresh']['spec'],'operationId':binding['fresh']['operationId'],'approvalSha256':claim['approvalSha256'],'normalRenewalMaximum':1,'automaticRetry':False}:raise RuntimeError()
        if hashlib.sha256(Path(binding['approvalPath']).read_bytes()).hexdigest()!=claim['approvalSha256'] or approval['googleSession']['normalRenewalMaximum']!=1 or EXECUTION_DEADLINE_MS!=int(__import__('datetime').datetime.fromisoformat(approval['validUntilUtc'].replace('Z','+00:00')).timestamp()*1000):raise RuntimeError()
        if (runtime/'google-renew-once.result.safe.json').exists():raise RuntimeError()
        # A separate child launch reservation also forbids invoking this executable
        # again after a crash or unknown SDK/cache outcome. Never delete it.
        admit()
        fd=os.open(runtime/'google-renew-once.child.claim.safe.json',os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
        with os.fdopen(fd,'wb') as child_claim:
            child_claim.write((json.dumps({'spec':binding['fresh']['spec'],'operationId':binding['fresh']['operationId'],'approvalSha256':claim['approvalSha256'],'maximumRequests':1,'automaticRetry':False},separators=(',',':'))+'\n').encode())
            child_claim.flush();os.fsync(child_claim.fileno())
        directory=os.open(runtime,os.O_RDONLY)
        try:os.fsync(directory)
        finally:os.close(directory)
        admit()
        source=SOURCE.read_bytes()
        if hashlib.sha256(source).hexdigest()!=claim['code']['files']['xuan-ib-orders-live-operator.mjs']:raise RuntimeError()
        bridge=re.search(r'const CONTROL_BRIDGE=String.raw`(.*?)`;',source.decode(),re.S)[1]
        exec(compile(bridge,'reviewed-control-bridge','exec'),ns)
        admit()
        account,credential=admitted_sdk_identity(ns)
        from googlecloudsdk.core import properties
        from googlecloudsdk.core.console import console_io
        from requests import Session
        from requests.adapters import HTTPAdapter
        session=Session();session.trust_env=False;session.mount('https://',HTTPAdapter(max_retries=0))
        request=OnceRequest(session,ns['Closed'])
        # The SDK's user-credential subclass has its own reauth implementation.
        # In this isolated process it must never prompt or begin a new login.
        console_io.CanPrompt=lambda *args,**kwargs:False
        renewal=renew_existing(account,credential,request,ns['Closed'],lambda:properties.VALUES.core.account.Get(),audit)
        renewal['sdkRefreshInvoked']=audit['sdkRefreshInvoked']
        result.update(status='GOOGLE_SESSION_READY',observedAtUtc=ns['stamp'](),renewal=renewal)
    except BaseException as error:
        status=request.http_status if request else None
        reservations=request.reservations if request else 0
        received=request.response_received if request else False
        # A sent request without a known response or a successful token response with
        # failed SDK/cache completion is uncertain. Never retry either condition.
        unknown=bool(reservations and (not received or status==200))
        detail=ns['error_detail'](error) if 'error_detail' in ns else None
        result.update(status='GOOGLE_SESSION_RENEWAL_STOPPED',observedAtUtc=ns['stamp']() if 'stamp' in ns else None,
                      renewal={'state':'unknown' if unknown else 'stopped','sdkRefreshInvoked':audit['sdkRefreshInvoked'],
                               'requestReservations':reservations,'responseReceived':received,'httpStatus':status,
                               'sdkCacheUpdate':'unconfirmed','identityMatched':False,
                               'guardRejection':request.rejection if request else None},diagnostic=detail)
    finally:
        if session is not None:session.close()
    os.write(out,(json.dumps(result,separators=(',',':'))+'\n').encode());os.close(out)

if __name__=='__main__':
    if len(sys.argv)==4 and sys.argv[1:3]==['--approved-google-renew-once','--binding']:live()
    else:print('{"status":"OFFLINE_ONLY","realCalls":0}')
