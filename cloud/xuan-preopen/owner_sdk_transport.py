"""Private anonymous-pipe bridge to the installed SDK's existing owner identity.

Importing this module does not import the SDK, load credentials or make requests.
Only the worker main instantiates the live provider, lazily after input validation.
Neither credentials nor authentication headers are part of the pipe protocol.
"""
import base64
import datetime
import hashlib
import json
import logging
import os
from pathlib import Path
import re
import sys
import time
import uuid as uuid_module
from urllib.parse import parse_qsl, quote, unquote, urlsplit

SDK_ROOT_SHA256 = '01686f458b748b5277840da752f9c73b4f29de6ae520151c61a45d784b8bc8fa'
SDK_CONFIG = '/Users/huanwu/.config/gcloud'
PROJECT = 'family-portfolio-gateway'
BUCKET = PROJECT + '-xuan-preopen-private'
OBJECT = 'delivery/owner-latest.html'
CANARY_OBJECT = 'delivery/owner-phone-canary-v1.html'
OWNER_SHA256 = '1f95a16df4e38086493c3447a048fdf375e8402fa4ba709ece794e3b830d49ee'
MAX_DISPLAY = 2 * 1024 * 1024
MAX_BODY = MAX_DISPLAY + 32768
MAX_RESPONSE = 4 * 1024 * 1024
MAX_LINE = 24 * 1024 * 1024
GEN = re.compile(r'[1-9][0-9]{0,29}\Z')
ROLE_NAMES = (
    'projects/' + PROJECT + '/roles/xuanPreopenDeliveryRead',
    'roles/artifactregistry.serviceAgent', 'roles/cloudbuild.builds.builder',
    'roles/cloudbuild.serviceAgent', 'roles/cloudscheduler.serviceAgent',
    'roles/cloudtasks.serviceAgent', 'roles/containerregistry.ServiceAgent',
    'roles/editor', 'roles/logging.viewer', 'roles/owner',
    'roles/pubsub.serviceAgent', 'roles/run.serviceAgent',
    'roles/storage.legacyBucketOwner', 'roles/storage.legacyBucketReader',
    'roles/storage.legacyObjectOwner', 'roles/storage.legacyObjectReader',
    'roles/storage.objectCreator',
)
OVERRIDE_ENV = (
    'CLOUDSDK_AUTH_ACCESS_TOKEN', 'CLOUDSDK_AUTH_ACCESS_TOKEN_FILE',
    'CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE', 'CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT',
    'CLOUDSDK_AUTH_TOKEN_HOST', 'CLOUDSDK_CORE_ACCOUNT',
    'CLOUDSDK_ACTIVE_CONFIG_NAME', 'CLOUDSDK_CORE_UNIVERSE_DOMAIN',
    'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_AUTH_ACCESS_TOKEN',
    'GOOGLE_API_USE_CLIENT_CERTIFICATE', 'GOOGLE_API_USE_MTLS_ENDPOINT',
    'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy',
)
RESPONSE_HEADERS = frozenset((
    'content-type', 'content-length', 'content-disposition', 'cache-control',
    'content-encoding', 'x-goog-generation',
))


class BoundaryError(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__('OWNER_SDK_' + code)


def reject(code):
    raise BoundaryError(code)


# Finite observations only. HTTP invocation/2xx does not prove socket bytes,
# business ACK validation, metadata binding or a verified HTML hash.
SAFE_DIAGNOSTIC_SCHEMA = 'xuan.owner-sdk.safe-diagnostics.v1'
SAFE_DIAGNOSTIC_STAGES = frozenset(['frame', 'request-validation', 'identity', 'cache', 'metadata-get', 'html-get', 'head', 'boundary', 'canary', 'cas', 'readback-metadata', 'readback-html', 'close'])
SAFE_ERROR_TYPES = frozenset(['BoundaryError', 'OSError', 'TimeoutError', 'ConnectionError', 'SSLError', 'SSLCertVerificationError', 'CertificateError', 'BrokenPipeError', 'ConnectionResetError', 'ConnectionRefusedError', 'FileNotFoundError', 'PermissionError', 'ImportError', 'ModuleNotFoundError', 'ValueError', 'TypeError', 'RuntimeError', 'RequestException', 'ReadTimeout', 'ConnectTimeout', 'ConnectTimeoutError', 'ReadTimeoutError', 'ProxyError', 'NewConnectionError', 'MaxRetryError', 'TransportError', 'RefreshError', 'gaierror'])
SAFE_ERROR_CODES = frozenset(['BODY_INVALID', 'BOUNDARY_ACCESS_DENIED', 'BOUNDARY_CONTENT_TYPE', 'BOUNDARY_READ_FAILED', 'CACHED_CREDENTIAL_LIFETIME_INSUFFICIENT', 'CACHED_CREDENTIAL_REFRESH_REQUIRED', 'CANARY_ALREADY_ATTEMPTED', 'CANARY_ALREADY_EXISTS', 'CANARY_INVALID', 'CANARY_PRESENCE_UNPROVEN', 'CANARY_REQUEST_INVALID', 'CANARY_TIME_INVALID', 'CLOSED', 'DISPLAY_UTF8_INVALID', 'DUPLICATE_JSON_KEY', 'EACCES', 'EAI_AGAIN', 'EAI_NONAME', 'ECONNABORTED', 'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENCODING_INVALID', 'ENETUNREACH', 'ENOENT', 'ENVIRONMENT_OVERRIDE', 'EPERM', 'EPIPE', 'ETIMEDOUT', 'EXISTING_USER_CREDENTIAL_REQUIRED', 'FRAME_INVALID', 'FRAME_SIZE_LIMIT', 'HEADERS_INVALID', 'JSON_INVALID', 'MULTIPART_INVALID', 'MULTIPART_METADATA_INVALID', 'MULTIPART_RESOURCE_INVALID', 'OPERATION_INVALID', 'ORIGINAL_IDENTITY_CHANGED', 'ORIGINAL_IDENTITY_REQUIRED', 'PIN_REQUIRED', 'QUERY_INVALID', 'READ_FAILED', 'REDIRECT_OR_URL_CHANGED', 'REPLACEMENT_ADMISSION_EXPIRED', 'REPLACEMENT_CANARY_CURRENT', 'REPLACEMENT_CANARY_REGISTRATION', 'REPLACEMENT_CANDIDATE', 'REPLACEMENT_INVALID', 'REPLACEMENT_METADATA', 'REPLACEMENT_OLD_CHANGED', 'REPLACEMENT_OLD_HASH', 'REPLACEMENT_OLD_MEDIA', 'REPLACEMENT_OLD_METADATA', 'REPLACEMENT_REGISTRATION', 'REQUEST_INVALID', 'REQUEST_OUTCOME_UNKNOWN', 'RESPONSE_SIZE_LIMIT', 'SDK_CONFIG_INVALID', 'SDK_FAILED', 'SDK_OVERRIDE', 'SDK_ROOT_INVALID', 'SDK_ROOT_REQUIRED', 'TARGET_INVALID', 'TLS_CERTIFICATE_ERROR', 'TLS_ERROR', 'WRITE_ALREADY_ATTEMPTED'])
SAFE_COUNTERS = ('casHttpAttempts', 'casHttpAcks', 'readbackMetadataAttempts',
                 'readbackMetadataSuccesses', 'readbackHtmlAttempts', 'readbackHtmlSuccesses')


def safe_exception_fields(error):
    name = type(error).__name__
    kind = name if name in SAFE_ERROR_TYPES else None
    code = None
    if type(error) is BoundaryError:
        code = error.code if error.code in SAFE_ERROR_CODES else None
    elif name in ('SSLCertVerificationError', 'CertificateError'):
        code = 'TLS_CERTIFICATE_ERROR'
    elif name == 'SSLError':
        code = 'TLS_ERROR'
    elif isinstance(error, OSError):
        import errno
        number = OSError.__dict__['errno'].__get__(error, type(error))
        candidate = errno.errorcode.get(number) if type(number) is int else None
        if name == 'gaierror':
            import socket
            candidate = 'EAI_AGAIN' if number == socket.EAI_AGAIN else 'EAI_NONAME' if number == socket.EAI_NONAME else None
        code = candidate if candidate in SAFE_ERROR_CODES else None
    return kind, code


class SafeDiagnostics:
    def __init__(self):
        self.counts = dict.fromkeys(SAFE_COUNTERS, 0)
        self.new_generation = None
        self.http_kind = None
        self.begin('frame')

    def begin(self, stage):
        self.stage = stage
        self.error_type = self.error_code = self.cause_code = self.http_status = None
        self.primary_recorded = False
        self.cleanup = []

    def mark(self, stage):
        if not self.primary_recorded:
            self.stage = stage

    def error(self, error, stage=None):
        if self.primary_recorded:
            return
        self.primary_recorded = True
        if stage is not None:
            self.stage = stage
        self.error_type, self.error_code = safe_exception_fields(error)
        cause = BaseException.__dict__['__cause__'].__get__(error, type(error))
        if cause is None:
            cause = BaseException.__dict__['__context__'].__get__(error, type(error))
        if isinstance(cause, BaseException):
            self.cause_code = safe_exception_fields(cause)[1]

    def snapshot(self):
        return {'schema': SAFE_DIAGNOSTIC_SCHEMA, 'stage': self.stage,
                'errorType': self.error_type, 'errorCode': self.error_code,
                'causeCode': self.cause_code, 'httpStatus': self.http_status, **self.counts}

    def cleanup_error(self, error):
        if self.cleanup:
            return
        entry = self.snapshot()
        entry.update(stage='close', errorType=safe_exception_fields(error)[0],
                     errorCode=safe_exception_fields(error)[1], causeCode=None)
        self.cleanup.append(entry)

    def attempted(self, kind):
        self.mark(kind)
        key = {'cas': 'casHttpAttempts', 'readback-metadata': 'readbackMetadataAttempts',
               'readback-html': 'readbackHtmlAttempts'}.get(kind)
        if key:
            self.counts[key] += 1

    def responded(self, kind, status):
        self.http_status = status if type(status) is int and 100 <= status <= 599 else None
        if type(status) is int and 200 <= status < 300:
            key = {'cas': 'casHttpAcks', 'readback-metadata': 'readbackMetadataSuccesses',
                   'readback-html': 'readbackHtmlSuccesses'}.get(kind)
            if key:
                self.counts[key] += 1



def instant():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def unique_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            reject('DUPLICATE_JSON_KEY')
        value[key] = item
    return value


def json_loads(value):
    try:
        return json.loads(value, object_pairs_hook=unique_object,
                          parse_constant=lambda _: reject('JSON_INVALID'))
    except (ValueError, UnicodeError):
        reject('JSON_INVALID')


def environment_guard(env):
    if (any(env.get(key) for key in OVERRIDE_ENV)
            or any(v and (k.startswith('CLOUDSDK_AUTH_') or k.startswith('CLOUDSDK_API_ENDPOINT_OVERRIDES_')) for k, v in env.items())):
        reject('ENVIRONMENT_OVERRIDE')
    if env.get('CLOUDSDK_CONFIG') != SDK_CONFIG:
        reject('SDK_CONFIG_INVALID')


def existing_sdk_root(env):
    # This noncredential locator may only name the same pre-existing runtime.
    # Its private historical directory name is never published or returned.
    value = env.get('XUAN_OWNER_EXISTING_SDK_ROOT')
    if not isinstance(value, str) or not value:
        reject('SDK_ROOT_REQUIRED')
    try:
        root = Path(value).resolve(strict=True)
    except (OSError, ValueError):
        reject('SDK_ROOT_INVALID')
    if not root.is_dir() or hashlib.sha256(str(root).encode()).hexdigest() != SDK_ROOT_SHA256:
        reject('SDK_ROOT_INVALID')
    return str(root)


def validate_headers(headers, method):
    if not isinstance(headers, dict) or any(not isinstance(k, str) or not isinstance(v, str) for k, v in headers.items()):
        reject('HEADERS_INVALID')
    normalized = {k.lower(): v for k, v in headers.items()}
    if len(normalized) != len(headers):
        reject('HEADERS_INVALID')
    if method == 'POST':
        if (set(normalized) != {'content-type', 'accept', 'accept-encoding'}
                or normalized['accept'] != 'application/json' or normalized['accept-encoding'] != 'identity'):
            reject('HEADERS_INVALID')
    elif method == 'HEAD':
        if normalized != {'accept-encoding': 'identity'}:
            reject('HEADERS_INVALID')
    elif normalized not in (
            {'accept': 'application/json', 'accept-encoding': 'identity'},
            {'accept': 'application/octet-stream', 'accept-encoding': 'identity'}):
        reject('HEADERS_INVALID')
    return normalized


def validate_multipart(body, content_type, daily=False):
    match = re.fullmatch(r'multipart/related; boundary=(xuan_owner_latest_[a-f0-9]{64})', content_type)
    if not match or not isinstance(body, bytes) or not 0 < len(body) <= MAX_BODY:
        reject('MULTIPART_INVALID')
    boundary = match[1].encode('ascii')
    prefix = b'--' + boundary + b'\r\nContent-Type: application/json; charset=utf-8\r\n\r\n'
    separator = b'\r\n--' + boundary + b'\r\nContent-Type: text/html; charset=utf-8\r\n\r\n'
    suffix = b'\r\n--' + boundary + b'--\r\n'
    if not body.startswith(prefix) or not body.endswith(suffix) or body.count(separator) != 1:
        reject('MULTIPART_INVALID')
    raw_resource, display = body[len(prefix):-len(suffix)].split(separator)
    if len(raw_resource) > 16384 or not 0 < len(display) <= MAX_DISPLAY or b'\r\n--' + boundary in display:
        reject('MULTIPART_INVALID')
    resource = json_loads(raw_resource)
    if not isinstance(resource, dict) or set(resource) != {'name', 'contentType', 'contentDisposition', 'cacheControl', 'metadata'}:
        reject('MULTIPART_RESOURCE_INVALID')
    if (resource['name'] != OBJECT or resource['contentType'] != 'text/html; charset=utf-8'
            or resource['contentDisposition'] != 'inline' or resource['cacheControl'] != 'private, no-store, max-age=0'):
        reject('MULTIPART_RESOURCE_INVALID')
    custom = resource['metadata']
    digest = hashlib.sha256(display).hexdigest()
    if (not isinstance(custom, dict) or custom.get('displaySha256') != digest
            or boundary != ('xuan_owner_latest_' + digest).encode('ascii')):
        reject('MULTIPART_METADATA_INVALID')
    if daily:
        keys = {'bundleMetadata', 'displaySha256', 'artifactObject', 'artifactGeneration', 'artifactSha256',
                'receiptObject', 'receiptGeneration', 'receiptSha256'}
        if set(custom) != keys or not isinstance(custom['bundleMetadata'], str):
            reject('MULTIPART_METADATA_INVALID')
        metadata = json_loads(custom['bundleMetadata'])
        if (not isinstance(metadata, dict) or metadata.get('schema') != 'xuan.owner-latest.v1'
                or metadata.get('scope') != 'ib-hk-classified-stocks__cash-ib-hk-noah-hk__orders-ib.v1'
                or metadata.get('dataDate') != daily_date() or metadata.get('financialStatus') not in ('partial', 'complete')):
            reject('MULTIPART_METADATA_INVALID')
        for key in keys - {'bundleMetadata', 'displaySha256'}:
            if metadata.get(key) != custom[key]:
                reject('MULTIPART_METADATA_INVALID')
    else:
        if set(custom) != {'previewMetadata', 'displaySha256'} or not isinstance(custom['previewMetadata'], str):
            reject('MULTIPART_METADATA_INVALID')
        metadata = json_loads(custom['previewMetadata'])
        if not isinstance(metadata, dict) or metadata.get('schema') != 'xuan.owner-accepted-preview.v1':
            reject('MULTIPART_METADATA_INVALID')
    try:
        display.decode('utf-8', errors='strict')
    except UnicodeError:
        reject('DISPLAY_UTF8_INVALID')
    return resource, display


def validate_storage_request(value, expected_generation='0', daily=False):
    if not isinstance(value, dict) or set(value) != {'op', 'url', 'method', 'headers', 'body'} or value['op'] != 'request':
        reject('REQUEST_INVALID')
    url, method = value['url'], value['method']
    if not isinstance(url, str) or any(ord(c) < 33 or ord(c) > 126 for c in url) or method not in ('HEAD', 'GET', 'POST'):
        reject('REQUEST_INVALID')
    parsed = urlsplit(url)
    if parsed.scheme != 'https' or parsed.netloc != 'storage.googleapis.com' or parsed.fragment:
        reject('TARGET_INVALID')
    try:
        pairs = parse_qsl(parsed.query, strict_parsing=True, keep_blank_values=True)
    except ValueError:
        reject('QUERY_INVALID')
    query = dict(pairs)
    if len(pairs) != len(query):
        reject('QUERY_INVALID')
    headers = validate_headers(value['headers'], method)
    if method == 'POST':
        if parsed.path != '/upload/storage/v1/b/' + BUCKET + '/o' or query != {'uploadType': 'multipart', 'ifGenerationMatch': expected_generation}:
            reject('TARGET_INVALID')
        try:
            body = base64.b64decode(value['body'], validate=True)
        except (ValueError, TypeError):
            reject('BODY_INVALID')
        validate_multipart(body, headers['content-type'], daily=daily)
    else:
        if value['body'] is not None or parsed.path != '/storage/v1/b/' + BUCKET + '/o/' + quote(OBJECT, safe=''):
            reject('TARGET_INVALID')
        if method == 'HEAD':
            if query != {'alt': 'media'}:
                reject('QUERY_INVALID')
        elif query.get('alt') == 'media':
            if set(query) != {'alt', 'generation'} or not GEN.fullmatch(query['generation']):
                reject('PIN_REQUIRED')
            if headers.get('accept') != 'application/octet-stream':
                reject('HEADERS_INVALID')
        elif set(query) not in (set(), {'generation'}) or ('generation' in query and not GEN.fullmatch(query['generation'])):
            reject('QUERY_INVALID')
        elif headers.get('accept') != 'application/json':
            reject('HEADERS_INVALID')
        body = None
    return url, method, headers, body


def recovery_registration():
    value = json_loads((Path(__file__).resolve().parents[2]/'security'/'xuan-owner-source-recovery.json').read_bytes())
    if (set(value)-{'supersedes'} not in ({'schema', 'requestId', 'dataDate', 'priorReceiptObject', 'priorReceiptGeneration', 'priorReceiptSha256'}, {'schema', 'requestId', 'dataDate', 'priorReceiptObject', 'priorReceiptGeneration', 'priorReceiptSha256', 'referenceCapture'})
            or value['schema'] != 'xuan.owner-source-recovery.v1'
            or not re.fullmatch(r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}', str(value['requestId']))
            or not re.fullmatch(r'\d{4}-\d\d-\d\d', str(value['dataDate']))
            or datetime.date.fromisoformat(value['dataDate']).isoformat() != value['dataDate']
            or value['priorReceiptObject'] != 'delivery/'+value['dataDate']+'/receipt.json'
            or not GEN.fullmatch(str(value['priorReceiptGeneration']))
            or not re.fullmatch('[a-f0-9]{64}', str(value['priorReceiptSha256']))):
        reject('PIN_REQUIRED')
    if 'referenceCapture' in value:
        ref = value['referenceCapture']
        if (not isinstance(ref, dict) or set(ref) != {'schema', 'captureStartedAt', 'captureCompletedAt', 'expiresAt', 'sourceHashes'}
                or ref['schema'] != 'xuan.registered-reference-capture.v1'
                or not isinstance(ref['sourceHashes'], dict) or set(ref['sourceHashes']) != {'ib.orders', 'sharesight.ibGroupedPerformance', 'sharesight.noahPerformance'}
                or any(not re.fullmatch('[a-f0-9]{64}', str(h)) for h in ref['sourceHashes'].values())):
            reject('PIN_REQUIRED')
        try:
            times = [datetime.datetime.fromisoformat(ref[k].replace('Z', '+00:00')) for k in ('captureStartedAt', 'captureCompletedAt', 'expiresAt')]
            if any(d.isoformat(timespec='milliseconds').replace('+00:00', 'Z') != ref[k] for d,k in zip(times,('captureStartedAt','captureCompletedAt','expiresAt'))):
                reject('PIN_REQUIRED')
            if (not 0 <= (times[1]-times[0]).total_seconds() <= 300 or times[2] <= times[1]
                    or times[0].astimezone(datetime.timezone(datetime.timedelta(hours=8))).date().isoformat() != value['dataDate']
                    or ref['expiresAt'] != value['dataDate']+'T15:59:59.999Z'):
                reject('PIN_REQUIRED')
        except Exception:
            reject('PIN_REQUIRED')
    if 'supersedes' in value:
        s = value['supersedes']
        if (not value.get('referenceCapture') or not isinstance(s, dict)
                or set(s) != {'requestId', 'artifactSha256', 'receiptSha256', 'latestGeneration'}
                or s.get('requestId') == value['requestId']
                or not re.fullmatch(r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}', str(s.get('requestId')))
                or not GEN.fullmatch(str(s.get('latestGeneration')))
                or any(not re.fullmatch('[a-f0-9]{64}', str(s.get(k))) for k in ('artifactSha256','receiptSha256'))):
            reject('PIN_REQUIRED')
    return dict(value, receiptObject='report-check/orders-probe-'+value['requestId']+'/preview-receipt.json')


def reference_capture(registration, start, end):
    ref = registration.get('referenceCapture')
    return ref if ref and ref['captureStartedAt'] == start and ref['captureCompletedAt'] == end else None


def recovery_receipt(name):
    return isinstance(name, str) and re.fullmatch(r'report-check/orders-probe-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/preview-receipt\.json', name)


def bundle_paths(metadata):
    date, artifact, receipt = metadata.get('dataDate'), metadata.get('artifactObject'), metadata.get('receiptObject')
    if not isinstance(date, str) or not re.fullmatch(r'\d{4}-\d\d-\d\d', date):
        return False
    try:
        if datetime.date.fromisoformat(date).isoformat() != date:
            return False
    except ValueError:
        return False
    if artifact == 'delivery/'+date+'/report.html' and receipt == 'delivery/'+date+'/receipt.json':
        return True
    return bool(recovery_receipt(receipt) and isinstance(artifact, str) and re.fullmatch(
        re.escape('report-check/'+str(metadata.get('captureStartedAt'))+'-') +
        r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/report\.html', artifact))


def daily_date():
    return datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).date().isoformat()


def canonical_registration(value):
    return (json.dumps(value, sort_keys=True, indent=2, ensure_ascii=False) + '\n').encode('utf-8')


def replacement_registration():
    # Fixed protected files only; no supplied path, credential or SDK lookup.
    root = Path(__file__).resolve().parents[2] / 'security'
    raw = (root / 'xuan-owner-preview-replacement.json').read_bytes()
    old_raw = (root / 'xuan-owner-accepted-preview.json').read_bytes()
    canary_raw = (root / 'xuan-owner-registered-canary.json').read_bytes()
    revision, old = json_loads(raw), json_loads(old_raw)
    keys = {'schema', 'target', 'previousRegistrationSha256', 'previousDisplaySha256', 'canaryRegistrationSha256', 'registration'}
    if (not isinstance(revision, dict) or set(revision) != keys
            or revision['schema'] != 'xuan.owner-preview-replacement.v1'
            or revision['target'] != {'bucket': BUCKET, 'object': OBJECT}
            or canonical_registration(revision) != raw
            or revision['previousRegistrationSha256'] != hashlib.sha256(old_raw).hexdigest()
            or revision['previousDisplaySha256'] != old['displaySha256']
            or revision['canaryRegistrationSha256'] != hashlib.sha256(canary_raw).hexdigest()):
        reject('REPLACEMENT_REGISTRATION')
    new = revision['registration']
    if (not isinstance(new, dict) or set(new) != set(old)
            or new['displaySha256'] == old['displaySha256']
            or any(new[k] != old[k] for k in old if k not in ('registrationId', 'artifactSha256', 'modelSha256', 'displaySha256'))):
        reject('REPLACEMENT_REGISTRATION')
    return revision, old, hashlib.sha256(raw).hexdigest()


def registered_preview_metadata(registration, registration_hash, policy_commit):
    if not isinstance(policy_commit, str) or not re.fullmatch(r'[a-f0-9]{40}', policy_commit):
        reject('REPLACEMENT_METADATA')
    keys = ('scope', 'ownerBinding', 'sourceIdentitySha256', 'registrationId', 'dataDate', 'sourceDate',
            'captureStartedAt', 'captureEndedAt', 'completedAt', 'financialStatus', 'unknownFields')
    result = {key: registration[key] for key in keys}
    result.update(schema='xuan.owner-accepted-preview.v1', registrationSha256=registration_hash,
                  registrationPolicyCommit=policy_commit)
    return result


def validate_replacement_request(value):
    if not isinstance(value, dict) or set(value) != {'op', 'url', 'method', 'headers', 'body', 'replacement', 'admissionExpiresAt'}:
        reject('REPLACEMENT_INVALID')
    pins = value['replacement']
    if (value['op'] != 'replaceAcceptedPreview' or not isinstance(pins, dict)
            or set(pins) != {'revisionSha256', 'previousGeneration', 'previousDisplaySha256', 'previousRegistrationSha256'}
            or not isinstance(pins['previousGeneration'], str) or not GEN.fullmatch(pins['previousGeneration'])):
        reject('REPLACEMENT_INVALID')
    revision, old, revision_hash = replacement_registration()
    if (pins['revisionSha256'] != revision_hash or pins['previousDisplaySha256'] != revision['previousDisplaySha256']
            or pins['previousRegistrationSha256'] != revision['previousRegistrationSha256']):
        reject('REPLACEMENT_INVALID')
    deadline = value['admissionExpiresAt']
    current = time.time() * 1000
    if type(deadline) is not int or not deadline - 5000 <= current <= deadline:
        reject('REPLACEMENT_ADMISSION_EXPIRED')
    request = {key: item for key, item in value.items() if key not in ('replacement', 'admissionExpiresAt')}
    request['op'] = 'request'
    validated = validate_storage_request(request, pins['previousGeneration'])
    if request['method'] != 'POST':
        reject('REPLACEMENT_INVALID')
    body = validated[3]
    boundary = 'xuan_owner_latest_' + revision['registration']['displaySha256']
    prefix = ('--' + boundary + '\r\nContent-Type: application/json; charset=utf-8\r\n\r\n').encode()
    separator = ('\r\n--' + boundary + '\r\nContent-Type: text/html; charset=utf-8\r\n\r\n').encode()
    suffix = ('\r\n--' + boundary + '--\r\n').encode()
    if not body.startswith(prefix) or not body.endswith(suffix):
        reject('REPLACEMENT_CANDIDATE')
    resource = json_loads(body[len(prefix):-len(suffix)].split(separator)[0])
    custom = resource['metadata']
    metadata = json_loads(custom['previewMetadata'])
    new_hash = hashlib.sha256(canonical_registration(revision['registration'])).hexdigest()
    if (custom['displaySha256'] != revision['registration']['displaySha256']
            or metadata != registered_preview_metadata(revision['registration'], new_hash, metadata.get('registrationPolicyCommit'))):
        reject('REPLACEMENT_CANDIDATE')
    return validated, revision, old


def owner_canary_html(uid, created, candidate):
    return ('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer">'
            '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; base-uri \'none\'; form-action \'none\'">'
            '<title>Private delivery check</title></head><body><!-- xuan.owner-phone-canary.v1 -->'
            '<h1>Private delivery check</h1><p>Reference: ' + uid + '</p><p>Created at UTC: ' + created
            + '</p><p>Candidate SHA-256: ' + candidate + '</p></body></html>').encode('utf-8')


def replacement_canary_pin(revision):
    raw = (Path(__file__).resolve().parents[2] / 'security' / 'xuan-owner-registered-canary.json').read_bytes()
    registration = json_loads(raw)
    if (hashlib.sha256(raw).hexdigest() != revision['canaryRegistrationSha256'] or not isinstance(registration, dict)
            or set(registration) != {'schema', 'target', 'pin'} or registration['schema'] != 'xuan.owner-registered-canary.v1'
            or registration['target'] != {'bucket': BUCKET, 'object': CANARY_OBJECT}):
        reject('REPLACEMENT_CANARY_REGISTRATION')
    pin = registration['pin']
    if (not isinstance(pin, dict) or set(pin) != {'uuid', 'createdAt', 'candidateSha256', 'generation', 'sha256'}
            or not isinstance(pin['generation'], str) or not GEN.fullmatch(pin['generation'])
            or not isinstance(pin['uuid'], str) or not re.fullmatch(r'[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}', pin['uuid'])
            or not isinstance(pin['createdAt'], str) or not re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z', pin['createdAt'])
            or pin['candidateSha256'] != revision['previousDisplaySha256']):
        reject('REPLACEMENT_CANARY_REGISTRATION')
    raw_html = owner_canary_html(pin['uuid'], pin['createdAt'], pin['candidateSha256'])
    if hashlib.sha256(raw_html).hexdigest() != pin['sha256']:
        reject('REPLACEMENT_CANARY_REGISTRATION')
    return {'generation': pin['generation'], 'size': str(len(raw_html))}


def canary_content(value):
    if not isinstance(value, dict) or set(value) != {'op', 'uuid', 'createdAt', 'candidateSha256'}:
        reject('CANARY_INVALID')
    uid, created, candidate = value['uuid'], value['createdAt'], value['candidateSha256']
    if (not isinstance(uid, str) or not re.fullmatch(r'[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}', uid)
            or str(uuid_module.UUID(uid)) != uid or not isinstance(candidate, str) or not re.fullmatch(r'[a-f0-9]{64}', candidate)
            or not isinstance(created, str) or not re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z', created)):
        reject('CANARY_INVALID')
    try:
        parsed = datetime.datetime.fromisoformat(created.replace('Z', '+00:00'))
    except ValueError:
        reject('CANARY_INVALID')
    age = (datetime.datetime.now(datetime.timezone.utc) - parsed).total_seconds()
    if age < 0 or age > 60:
        reject('CANARY_TIME_INVALID')
    html = owner_canary_html(uid, created, candidate)
    metadata = {'schema': 'xuan.owner-phone-canary.v1', 'uuid': uid, 'createdAt': created,
                'candidateSha256': candidate, 'canarySha256': hashlib.sha256(html).hexdigest()}
    resource = {'name': CANARY_OBJECT, 'contentType': 'text/html; charset=utf-8',
                'contentDisposition': 'inline', 'cacheControl': 'private, no-store, max-age=0', 'metadata': metadata}
    boundary = 'xuan_owner_canary_' + metadata['canarySha256']
    body = ('--' + boundary + '\r\nContent-Type: application/json; charset=utf-8\r\n\r\n').encode('ascii')
    body += json.dumps(resource, separators=(',', ':')).encode('ascii')
    body += ('\r\n--' + boundary + '\r\nContent-Type: text/html; charset=utf-8\r\n\r\n').encode('ascii') + html
    body += ('\r\n--' + boundary + '--\r\n').encode('ascii')
    return body, boundary


class LiveSdkProvider:
    """Only the SDK credential-store API; no ADC/static provider fallback."""
    def __init__(self):
        self.session = None
        self.credential = None
        self.account = None
        self.properties = None
        self._safe_diagnostics = None

    def identity(self):
        if self._safe_diagnostics is not None:
            self._safe_diagnostics.mark('identity')
        environment_guard(os.environ)
        # Suppress SDK/request debug logging before any imports or credential use.
        logging.disable(logging.CRITICAL)
        if self.properties is None:
            root = existing_sdk_root(os.environ)
            sys.path[:0] = [root + '/lib', root + '/lib/third_party']
            from googlecloudsdk.core import properties
            self.properties = properties
        p = self.properties.VALUES
        if (p.auth.access_token_file.Get() or p.auth.credential_file_override.Get()
                or p.auth.impersonate_service_account.Get() or p.auth.token_host.Get() != p.auth.token_host.default
                # SDK Get() stringizes even boolean defaults: 'False' is truthy.
                # GetBool() validates and preserves the actual boolean meaning.
                or p.auth.disable_credentials.GetBool() or p.core.universe_domain.Get() != 'googleapis.com'
                or p.proxy.proxy_type.Get() or p.core.custom_ca_certs_file.Get()
                or p.auth.disable_ssl_validation.GetBool()):
            reject('SDK_OVERRIDE')
        account = p.core.account.Get()
        if not isinstance(account, str) or hashlib.sha256(account.encode()).hexdigest() != OWNER_SHA256:
            reject('ORIGINAL_IDENTITY_REQUIRED')
        if self.account is not None and self.account != account:
            reject('ORIGINAL_IDENTITY_CHANGED')
        self.account = account
        return {'schema': 'xuan.owner-sdk-identity.v1', 'actorIdentifier': account,
                'accountSha256': OWNER_SHA256, 'credentialKind': 'existing-sdk-user'}

    def get_session(self):
        self.identity()
        if self._safe_diagnostics is not None:
            self._safe_diagnostics.mark('cache')
        if self.session is not None:
            return self.session
        from googlecloudsdk.core.credentials import creds as sdk_creds
        from googlecloudsdk.core.credentials import google_auth_credentials
        from google.auth.transport.requests import AuthorizedSession
        import requests
        credential = sdk_creds.GetCredentialStore().Load(self.account)
        # Direct SDK store load cannot fall back to ADC/GCE/external providers.
        if not isinstance(credential, google_auth_credentials.Credentials):
            reject('EXISTING_USER_CREDENTIAL_REQUIRED')
        if getattr(credential, 'universe_domain', None) != 'googleapis.com':
            reject('SDK_OVERRIDE')
        self.require_fresh(credential)
        def reject_auth_request(*_args, **_kwargs):
            # Even an unexpected before_request refresh cannot make token HTTP.
            reject('CACHED_CREDENTIAL_REFRESH_REQUIRED')
        session = AuthorizedSession(credential, refresh_status_codes=(),
                                    max_refresh_attempts=0, auth_request=reject_auth_request)
        session.trust_env = False
        session.mount('https://', requests.adapters.HTTPAdapter(max_retries=0))
        self.session, self.credential = session, credential
        return session

    @staticmethod
    def require_fresh(credential):
        # FRESH is stricter than valid: google-auth otherwise refreshes STALE
        # credentials in before_request. No credential/token value is returned.
        expiry = getattr(credential, 'expiry', None)
        state = getattr(getattr(credential, 'token_state', None), 'name', None)
        if (not credential.valid or state != 'FRESH' or not isinstance(expiry, datetime.datetime)
                or getattr(credential, '_use_non_blocking_refresh', False)):
            reject('CACHED_CREDENTIAL_REFRESH_REQUIRED')
        aware = expiry.replace(tzinfo=datetime.timezone.utc) if expiry.tzinfo is None else expiry
        if (aware - datetime.datetime.now(datetime.timezone.utc)).total_seconds() < 300:
            reject('CACHED_CREDENTIAL_LIFETIME_INSUFFICIENT')

    def request(self, url, method, headers, body):
        session = self.get_session()
        self.require_fresh(self.credential)
        session.cookies.clear()
        diagnostics = self._safe_diagnostics
        kind = diagnostics.http_kind if diagnostics is not None else None
        if diagnostics is not None:
            diagnostics.attempted(kind)
        try:
            response = session.request(method, url, headers=headers, data=body,
                                       timeout=(5, 15), allow_redirects=False, stream=True,
                                       verify=True)
        except Exception as error:
            if diagnostics is not None:
                diagnostics.error(error)
            raise
        if diagnostics is not None:
            diagnostics.responded(kind, response.status_code)
        return response

    def check_original_identity(self):
        self.get_session()  # proves stored user credential type/freshness, no HTTP
        return self.identity()

    def close(self):
        if self.session is not None:
            self.session.close()


class OwnerBridge:
    """Testable boundary; live main supplies only LiveSdkProvider."""
    def __init__(self, provider):
        self.provider = provider
        self.closed = False
        self.write_started = False
        self.canary_attempted = False
        self.evidence_attempted = False
        self.evidence = None
        self.mutation_started = False
        # Only populated by authenticated responses, never a caller pin list.
        self.daily_pins = {}
        self.daily_receipts = {}
        self.daily_latest_generation = None
        self._operation = None
        self.safe_diagnostics = SafeDiagnostics()
        if isinstance(provider, LiveSdkProvider):
            provider._safe_diagnostics = self.safe_diagnostics

    def raw_request(self, url, method, headers, body):
        if self.closed:
            reject('CLOSED')
        diagnostics = self.safe_diagnostics
        latest = 'https://storage.googleapis.com/storage/v1/b/' + BUCKET + '/o/' + quote(OBJECT, safe='')
        parsed = urlsplit(url)
        query = dict(parse_qsl(parsed.query))
        is_latest = parsed.scheme + '://' + parsed.netloc + parsed.path == latest
        is_cas = method == 'POST' and self.mutation_started and self._operation in ('request', 'replaceAcceptedPreview', 'dailyRequest')
        if is_cas:
            kind = 'cas'
        elif is_latest and method == 'GET' and diagnostics.new_generation is not None and query.get('generation') == diagnostics.new_generation:
            kind = 'readback-html' if query.get('alt') == 'media' else 'readback-metadata'
        elif self._operation == 'boundary':
            kind = 'boundary'
        elif not is_latest and (self._operation != 'dailyRequest' or parsed.path.endswith('/' + quote(CANARY_OBJECT, safe=''))):
            kind = 'canary'
        else:
            kind = 'head' if method == 'HEAD' else 'html-get' if query.get('alt') == 'media' else 'metadata-get'
        diagnostics.http_kind = kind
        diagnostics.mark(kind)
        diagnostics.http_status = None  # each HTTP boundary, not the prior read in this RPC
        try:
            response = self.provider.request(url, method, headers, body)
            primary = None
            try:
                status = response.status_code
                diagnostics.http_status = status if type(status) is int and 100 <= status <= 599 else None
                if response.url != url or response.history:
                    reject('REDIRECT_OR_URL_CHANGED')
                selected = {k.lower(): v for k, v in response.headers.items() if k.lower() in RESPONSE_HEADERS}
                if method == 'HEAD' or response.status_code != 200:
                    raw = b''
                else:
                    raw = response.raw.read(MAX_RESPONSE + 1, decode_content=False)
                    if len(raw) > MAX_RESPONSE:
                        reject('RESPONSE_SIZE_LIMIT')
                if is_cas and 200 <= response.status_code < 300:
                    # Observe only the existing bounded ACK body. No new read or
                    # business validation; the publisher still owns those gates.
                    try:
                        observed = json_loads(raw)
                        gen = observed.get('generation') if type(observed) is dict else None
                        previous = query.get('ifGenerationMatch')
                        if (isinstance(gen, str) and GEN.fullmatch(gen) and isinstance(previous, str)
                                and (previous == '0' or GEN.fullmatch(previous)) and int(gen) > int(previous)):
                            diagnostics.new_generation = gen
                    except Exception:
                        pass
                return {'status': response.status_code, 'url': response.url,
                        'headers': selected, 'body': base64.b64encode(raw).decode('ascii')}
            except Exception as error:
                primary = error
                diagnostics.error(error)
                raise
            finally:
                try:
                    response.close()
                except Exception as error:
                    if primary is not None:
                        diagnostics.cleanup_error(error)
                    else:
                        diagnostics.error(error, 'close')
                        raise
        except BoundaryError as error:
            diagnostics.error(error)
            raise
        except Exception as error:
            # Preserve only finite exception observations, never SDK/log text.
            diagnostics.error(error)
            reject('REQUEST_OUTCOME_UNKNOWN' if self.mutation_started else 'READ_FAILED')

    def read_json(self, url, method='GET', body=None):
        headers = {'Accept': 'application/json', 'Accept-Encoding': 'identity'}
        if body is not None:
            headers['Content-Type'] = 'application/json'
        response = self.raw_request(url, method, headers, body)
        if response['status'] != 200:
            reject('BOUNDARY_ACCESS_DENIED' if response['status'] in (401, 403) else 'BOUNDARY_READ_FAILED')
        if not re.fullmatch(r'application/json(?:;\s*charset=utf-8)?', response['headers'].get('content-type', ''), flags=re.IGNORECASE):
            reject('BOUNDARY_CONTENT_TYPE')
        encoding = response['headers'].get('content-encoding')
        if encoding is not None and encoding.lower() != 'identity':
            reject('ENCODING_INVALID')
        return json_loads(base64.b64decode(response['body']))

    def verify_replacement_previous(self, pins, revision, old):
        # Discover the current object independently of the caller and then read
        # metadata/media pinned to that real generation. No ACK/history pin can
        # substitute for this HEAD. A later race is stopped by the same CAS.
        url = 'https://storage.googleapis.com/storage/v1/b/' + BUCKET + '/o/' + quote(OBJECT, safe='')
        head = self.raw_request(url + '?alt=media', 'HEAD', {'Accept-Encoding': 'identity'}, None)
        if head['status'] != 200 or head['headers'].get('x-goog-generation') != pins['previousGeneration']:
            reject('REPLACEMENT_OLD_CHANGED')
        metadata = self.read_json(url + '?generation=' + pins['previousGeneration'])
        expected_headers = {'content-type': 'text/html; charset=utf-8', 'content-disposition': 'inline',
                            'cache-control': 'private, no-store, max-age=0'}
        if (not isinstance(metadata, dict) or metadata.get('bucket') != BUCKET or metadata.get('name') != OBJECT
                or metadata.get('generation') != pins['previousGeneration']
                or metadata.get('contentType') != expected_headers['content-type']
                or metadata.get('contentDisposition') != 'inline' or metadata.get('cacheControl') != expected_headers['cache-control']
                or not isinstance(metadata.get('size'), str) or not re.fullmatch(r'[1-9][0-9]{0,8}', metadata['size'])
                or int(metadata['size']) > MAX_DISPLAY):
            reject('REPLACEMENT_OLD_METADATA')
        custom = metadata.get('metadata')
        if not isinstance(custom, dict) or set(custom) != {'previewMetadata', 'displaySha256'} or custom['displaySha256'] != revision['previousDisplaySha256']:
            reject('REPLACEMENT_OLD_METADATA')
        preview = json_loads(custom['previewMetadata'])
        if not isinstance(preview, dict) or preview != registered_preview_metadata(old, revision['previousRegistrationSha256'], preview.get('registrationPolicyCommit')):
            reject('REPLACEMENT_OLD_METADATA')
        media = self.raw_request(url + '?generation=' + pins['previousGeneration'] + '&alt=media', 'GET',
                                 {'Accept': 'application/octet-stream', 'Accept-Encoding': 'identity'}, None)
        raw = base64.b64decode(media['body'])
        for response in (head, media):
            wire = response['headers']
            header_pair = (wire.get('content-disposition'), wire.get('cache-control'))
            if (response['status'] != 200 or response['headers'].get('x-goog-generation') != pins['previousGeneration']
                    or response['headers'].get('content-length') != metadata['size']
                    or response['headers'].get('content-encoding', 'identity').lower() != 'identity'
                    or wire.get('content-type') != expected_headers['content-type']
                    or header_pair not in (('inline', 'private, no-store, max-age=0'),
                                           ('attachment', 'no-cache, no-store, max-age=0, must-revalidate'))):
                reject('REPLACEMENT_OLD_MEDIA')
        if len(raw) != int(metadata['size']) or hashlib.sha256(raw).hexdigest() != revision['previousDisplaySha256']:
            reject('REPLACEMENT_OLD_HASH')

    def verify_replacement_canary_current(self, revision):
        pin = replacement_canary_pin(revision)
        url = 'https://storage.googleapis.com/storage/v1/b/' + BUCKET + '/o/' + quote(CANARY_OBJECT, safe='') + '?alt=media'
        result = self.raw_request(url, 'HEAD', {'Accept-Encoding': 'identity'}, None)
        headers = result['headers']
        pair = (headers.get('content-disposition'), headers.get('cache-control'))
        if (result['status'] != 200 or headers.get('x-goog-generation') != pin['generation']
                or headers.get('content-length') != pin['size'] or headers.get('content-type') != 'text/html; charset=utf-8'
                or headers.get('content-encoding', 'identity').lower() != 'identity'
                or pair not in (('inline', 'private, no-store, max-age=0'),
                                ('attachment', 'no-cache, no-store, max-age=0, must-revalidate'))):
            reject('REPLACEMENT_CANARY_CURRENT')

    def inspect_evidence_attempt(self):
        registration = recovery_registration()
        name = 'report-check/orders-probe-'+registration['requestId']+'/start.json'
        result = self.raw_request('https://storage.googleapis.com/storage/v1/b/'+BUCKET+'/o/'+quote(name, safe=''),
                                  'GET', {'Accept': 'application/json', 'Accept-Encoding': 'identity'}, None)
        if result['status'] == 404:
            return {'exists': False}
        if result['status'] != 200:
            reject('READ_FAILED')
        metadata = json_loads(base64.b64decode(result['body'], validate=True))
        if metadata.get('bucket') != BUCKET or metadata.get('name') != name or not GEN.fullmatch(str(metadata.get('generation'))):
            reject('PIN_REQUIRED')
        return {'exists': True, 'generation': metadata['generation']}

    def evidence_upload(self, name, raw, content_type):
        evidence = self.evidence
        if (not evidence or evidence['blocked'] or evidence['count'] >= 10
                or not isinstance(raw, bytes) or not 0 < len(raw) <= 4*1024*1024
                or evidence['bytes']+len(raw) > 32*1024*1024 or name in evidence['attempted']):
            reject('WRITE_ALREADY_ATTEMPTED')
        now = time.time()*1000
        start = evidence['startMs']
        if (not start <= now <= start+evidence['durationMs'] or now < evidence['lastWall']
                or time.monotonic()-evidence['monotonic'] > (start+evidence['durationMs']-evidence['initialWall'])/1000
                or daily_date() != evidence['registration']['dataDate']):
            reject('REPLACEMENT_ADMISSION_EXPIRED')
        evidence['lastWall'] = now
        digest = hashlib.sha256(raw).hexdigest()
        boundary = 'xuan_evidence_'+digest
        resource = {'name': name, 'contentType': content_type, 'contentDisposition': 'attachment',
                    'cacheControl': 'private, no-store, max-age=0'}
        body = ('--'+boundary+'\r\nContent-Type: application/json; charset=utf-8\r\n\r\n'+json.dumps(resource)
                +'\r\n--'+boundary+'\r\nContent-Type: '+content_type+'\r\n\r\n').encode()+raw+('\r\n--'+boundary+'--\r\n').encode()
        # Reserve before HTTP. An uncertain/failed write closes evidence writes;
        # the immutable claim prevents a new process from resetting this budget.
        evidence['attempted'].add(name); evidence['count'] += 1; evidence['bytes'] += len(raw)
        self.mutation_started = True
        try:
            result = self.raw_request('https://storage.googleapis.com/upload/storage/v1/b/'+BUCKET+'/o?uploadType=multipart&ifGenerationMatch=0',
                                      'POST', {'Content-Type': 'multipart/related; boundary='+boundary, 'Accept': 'application/json', 'Accept-Encoding': 'identity'}, body)
            if result['status'] != 200:
                reject('WRITE_ALREADY_ATTEMPTED' if result['status'] == 412 else 'REQUEST_OUTCOME_UNKNOWN')
            value = json_loads(base64.b64decode(result['body'], validate=True))
            if (value.get('bucket') != BUCKET or value.get('name') != name or value.get('size') != str(len(raw))
                    or not GEN.fullmatch(str(value.get('generation')))
                    or value.get('md5Hash') != base64.b64encode(hashlib.md5(raw).digest()).decode()):
                reject('REQUEST_OUTCOME_UNKNOWN')
            pin = {'generation': value['generation'], 'sha256': digest}
            evidence['written'][name] = pin
            return pin
        except Exception:
            evidence['blocked'] = True
            raise

    def begin_evidence(self, value):
        registration = recovery_registration()
        if (set(value) not in ({'op', 'requestId', 'captureStartedAt'}, {'op', 'requestId', 'captureStartedAt', 'captureCompletedAt'}) or value['requestId'] != registration['requestId']
                or registration['dataDate'] != daily_date() or self.evidence_attempted):
            reject('REQUEST_INVALID')
        start = value['captureStartedAt']
        saved_capture = 'captureCompletedAt' in value
        ref = reference_capture(registration, start, value.get('captureCompletedAt'))
        duration_ms = 1800000 if saved_capture else 300000
        try:
            dt = datetime.datetime.fromisoformat(start.replace('Z', '+00:00'))
            start_ms = dt.timestamp()*1000
            if ref:
                duration_ms = datetime.datetime.fromisoformat(ref['expiresAt'].replace('Z', '+00:00')).timestamp()*1000-start_ms
        except Exception:
            reject('REQUEST_INVALID')
        if (not re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z', str(start))
                or dt.isoformat(timespec='milliseconds').replace('+00:00', 'Z') != start
                or not 0 <= time.time()*1000-start_ms <= duration_ms):
            reject('REQUEST_INVALID')
        if saved_capture:
            end = value['captureCompletedAt']
            try:
                end_dt = datetime.datetime.fromisoformat(end.replace('Z', '+00:00'))
                end_ms = end_dt.timestamp()*1000
            except Exception:
                reject('REQUEST_INVALID')
            if (end_dt.isoformat(timespec='milliseconds').replace('+00:00', 'Z') != end
                    or not 0 <= end_ms-start_ms <= 300000 or end_ms > time.time()*1000):
                reject('REQUEST_INVALID')
        self.evidence_attempted = True
        if self.inspect_evidence_attempt()['exists']:
            reject('WRITE_ALREADY_ATTEMPTED')
        run_id = str(uuid_module.uuid4())
        prefix = 'report-check/'+start+'-'+run_id+'/'
        self.evidence = {'registration': registration, 'start': start, 'startMs': start_ms, 'prefix': prefix, 'durationMs': duration_ms,
                         'reference': ref, 'captureCompletedAt': value.get('captureCompletedAt'), 'captureEndMs': end_ms if saved_capture else None,
                         'attempted': set(), 'written': {}, 'count': 0, 'bytes': 0, 'blocked': False,
                         'lastWall': time.time()*1000, 'initialWall': time.time()*1000, 'monotonic': time.monotonic()}
        claim = {'schema': 'xuan.browser-evidence-attempt.v1', 'requestId': registration['requestId'],
                 'dataDate': registration['dataDate'], 'captureStartedAt': start, 'runId': run_id,
                 'createdAt': instant(), 'maximumObjects': 10, 'maximumBytes': 32*1024*1024,
                 'sourceMode': 'sharesight-browser-with-optional-normal-orders' if saved_capture else 'sharesight-browser-no-ib-route'}
        if saved_capture:
            claim['captureCompletedAt'] = value['captureCompletedAt']
        pin = self.evidence_upload('report-check/orders-probe-'+registration['requestId']+'/start.json',
                                   json.dumps(claim, sort_keys=True).encode(), 'application/json; charset=utf-8')
        return {'requestId': registration['requestId'], 'dataDate': registration['dataDate'],
                'captureStartedAt': start, **({'captureCompletedAt': value['captureCompletedAt']} if saved_capture else {}), 'runId': run_id, 'claim': pin}

    def evidence_source_time(self, value, processing=False):
        try:
            dt = datetime.datetime.fromisoformat(value.replace('Z', '+00:00'))
            stamp = dt.timestamp()*1000
        except Exception:
            reject('BODY_INVALID')
        evidence = self.evidence
        end = min(time.time()*1000, evidence['startMs']+evidence['durationMs']) if processing else evidence['captureEndMs']
        lower = evidence['captureEndMs'] if processing else evidence['startMs']
        if (dt.isoformat(timespec='milliseconds').replace('+00:00', 'Z') != value
                or end is None or not lower <= stamp <= end):
            reject('BODY_INVALID')
        return stamp

    def validate_normal_orders_evidence(self, payload):
        # Data-only bridge for the already captured normal-MCP source. The JS
        # protected verifier independently rechecks fingerprints/account binding.
        evidence = self.evidence
        if (evidence['captureCompletedAt'] is None or set(payload) != {'status', 'sources', 'normalMcpEvidence'}
                or payload.get('status') != 'captured' or not isinstance(payload.get('sources'), list) or len(payload['sources']) != 1):
            reject('BODY_INVALID')
        normal = payload.get('normalMcpEvidence'); source = payload['sources'][0]
        if (not isinstance(normal, dict) or set(normal) != {'schema', 'requestId', 'channel'}
                or normal.get('schema') != 'xuan.normal-mcp-orders.v1'
                or normal.get('requestId') != evidence['registration']['requestId'] or normal.get('channel') not in ('cloud-mcp', 'mac-mcp')):
            reject('BODY_INVALID')
        keys = {'sourceKey', 'raw', 'rawFingerprint', 'startedAt', 'completedAt', 'accountEvidence'}
        if (not isinstance(source, dict) or set(source) not in (keys, keys | {'wrapper', 'transportFingerprint'})
                or source.get('sourceKey') != 'ib.orders' or not isinstance(source.get('raw'), dict)
                or not re.fullmatch('[a-f0-9]{64}', str(source.get('rawFingerprint', '')))):
            reject('BODY_INVALID')
        start = self.evidence_source_time(source.get('startedAt')); end = self.evidence_source_time(source.get('completedAt'))
        account = source.get('accountEvidence')
        if (start > end or not isinstance(account, dict) or set(account) != {'associationBasis', 'nativeIdentityEvidence', 'responseAccountEvidence'}
                or account.get('associationBasis') != 'owner-attested' or account.get('responseAccountEvidence') not in ('matched', 'not-provided')
                or account.get('nativeIdentityEvidence') != ('response-account-id' if account.get('responseAccountEvidence') == 'matched' else 'not-provided')):
            reject('BODY_INVALID')
        if evidence['reference'] and source['rawFingerprint'] != evidence['reference']['sourceHashes']['ib.orders']:
            reject('BODY_INVALID')
        if 'wrapper' in source and (source['wrapper'] not in ('native-object', 'json-string')
                or not re.fullmatch('[a-f0-9]{64}', str(source.get('transportFingerprint', '')))
                or source['wrapper'] == 'native-object' and source['transportFingerprint'] != source['rawFingerprint']):
            reject('BODY_INVALID')

    def write_evidence(self, value):
        if set(value) != {'op', 'name', 'body'} or not self.evidence or self.evidence['blocked']:
            reject('REQUEST_INVALID')
        evidence = self.evidence; prefix = evidence['prefix']; registration = evidence['registration']; name = value['name']
        keys = ('ib.flexEod', 'sharesight.ibGroupedPerformance', 'sharesight.noahPerformance', 'ib.optionalLive')
        paths = {prefix+k+'.json': k for k in keys}
        receipt_name = prefix+'receipt.json'; preview_name = registration['receiptObject']; html_name = prefix+'report.html'
        concentration_name = prefix+'concentration.sources.json'
        if name not in {*paths, receipt_name, preview_name, html_name, concentration_name}:
            reject('TARGET_INVALID')
        try:
            raw = base64.b64decode(value['body'], validate=True)
            text = raw.decode('utf-8')
        except Exception:
            reject('BODY_INVALID')
        if name != html_name:
            payload = json_loads(raw)
            if not isinstance(payload, dict):
                reject('BODY_INVALID')
            if name == concentration_name:
                if (set(payload) - {'sources', 'cutoff', 'captureStartedAt', 'captureCompletedAt'}
                        or not re.fullmatch(r'\d{4}-\d\d-\d\d', str(payload.get('cutoff', '')))
                        or not isinstance(payload.get('sources'), list) or len(payload['sources']) != 3):
                    reject('BODY_INVALID')
                expected = {'sharesight.ibGroupedPerformance': (936247, 'IB-HK'), 'sharesight.schwabPerformance': (936249, 'Schwab-HK'), 'sharesight.webullPerformance': (1350094, 'Webull')}
                if {v.get('receipt', {}).get('sourceKey') for v in payload['sources']} != set(expected):
                    reject('BODY_INVALID')
                for item in payload['sources']:
                    if set(item) != {'bytes', 'receipt'} or not isinstance(item['bytes'], str):
                        reject('BODY_INVALID')
                    b = item['bytes'].encode('utf-8'); r = item['receipt']; source = json_loads(b)
                    account, label = expected[r['sourceKey']]; observation = source.get('observation', {})
                    if (r.get('route') != 'authenticated-browser' or r.get('status') != 'date-verified'
                            or r.get('sha256') != hashlib.sha256(b).hexdigest() or r.get('bytes') != len(b)
                            or r.get('sourceDate') != payload['cutoff'] or source.get('mode') != 'read_only'
                            or source.get('source') != 'Sharesight authenticated cloud browser visible DOM'
                            or observation.get('portfolio') != label or observation.get('valuationDate') != payload['cutoff']
                            or account != 936247 and observation.get('portfolioId') != account):
                        reject('BODY_INVALID')
                    for key in ('startedAt', 'completedAt'):
                        stamp = r.get(key, '')
                        if not isinstance(stamp, str) or not re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z', stamp):
                            reject('BODY_INVALID')
                        try:
                            t = datetime.datetime.fromisoformat(stamp.replace('Z', '+00:00'))
                        except (ValueError, AttributeError):
                            reject('BODY_INVALID')
                        if (t.tzinfo is None or t.timestamp() > time.time()
                                or (t + datetime.timedelta(hours=8)).date().isoformat() != registration['dataDate']):
                            reject('BODY_INVALID')
                    if r['startedAt'] > r['completedAt'] or observation.get('retrievedAt') != r['completedAt']:
                        reject('BODY_INVALID')
            elif name in paths:
                key = paths[name]
                if key == 'ib.flexEod' and payload != {'status': 'not-called', 'code': 'FLEX_NOT_CALLED'}:
                    reject('BODY_INVALID')
                if key == 'ib.optionalLive' and payload != {'status': 'not-called', 'code': 'IB_MCP_ROUTES_UNAVAILABLE'}:
                    self.validate_normal_orders_evidence(payload)
                if key.startswith('sharesight.') and evidence['captureCompletedAt'] is not None:
                    self.evidence_source_time(payload.get('provenance', {}).get('readAt'))
                    if evidence['reference'] and payload.get('rawFingerprint') != evidence['reference']['sourceHashes'][key]:
                        reject('BODY_INVALID')
                if key.startswith('sharesight.') and (payload.get('sourceKey') != key or payload.get('status') != 'date-verified'
                        or payload.get('raw', {}).get('source') != 'Sharesight authenticated cloud browser visible DOM'):
                    reject('BODY_INVALID')
            else:
                if len(raw) > 128*1024:
                    reject('BODY_INVALID')
                if (payload.get('mode') != 'private_eod_action' or payload.get('publication') != 'none'
                        or payload.get('calculationBasis') != 'sharesight-book-user-synchronized.v1'
                        or payload.get('dataDate') != registration['dataDate'] or payload.get('startedAt') != evidence['start']
                        or payload.get('sourceCount') != 4 or len(payload.get('sources', [])) != 4
                        or {s.get('sourceKey') for s in payload['sources']} != set(keys)):
                    reject('BODY_INVALID')
                if evidence['captureCompletedAt'] is not None:
                    if (payload.get('dateBasis') != 'sharesight-valuation-date.v1'
                            or payload.get('captureCompletedAt') != evidence['captureCompletedAt']):
                        reject('BODY_INVALID')
                    if payload.get('referenceMode') != (evidence['reference']['schema'] if evidence['reference'] else None):
                        reject('BODY_INVALID')
                    self.evidence_source_time(payload.get('completedAt'), processing=True)
                concentration = payload.get('concentration')
                if concentration is not None and (not isinstance(concentration, dict)
                        or set(concentration) != {'privateObject', 'generation', 'sha256', 'modelSha256'}
                        or concentration.get('privateObject') != concentration_name):
                    reject('PIN_REQUIRED')
                for source in payload['sources']+[payload.get('artifact', {})]+([concentration] if concentration else []):
                    n = source.get('privateObject'); pin = evidence['written'].get(n)
                    if not pin or source.get('generation') != pin['generation'] or source.get('sha256') != pin['sha256']:
                        reject('PIN_REQUIRED')
                if payload['artifact']['privateObject'] != html_name or any(s['privateObject'] != prefix+s['sourceKey']+'.json' for s in payload['sources']):
                    reject('PIN_REQUIRED')
                if name == preview_name and evidence['written'].get(receipt_name, {}).get('sha256') != hashlib.sha256(raw).hexdigest():
                    reject('PIN_REQUIRED')
        elif not text.startswith('<!doctype html>') or len(raw) > 2*1024*1024:
            reject('BODY_INVALID')
        result = self.evidence_upload(name, raw, 'text/html; charset=utf-8' if name == html_name else 'application/json; charset=utf-8')
        if name == preview_name:
            evidence['blocked'] = True  # completed: no further evidence writes
        return result

    def daily_pin(self, name, generation, digest=None):
        if (not isinstance(name, str) or not isinstance(generation, str) or not GEN.fullmatch(generation)
                or digest is not None and (not isinstance(digest, str) or not re.fullmatch('[a-f0-9]{64}', digest))):
            reject('PIN_REQUIRED')
        previous = self.daily_pins.get(name)
        if previous and (previous[0] != generation or previous[1] and digest and previous[1] != digest):
            reject('PIN_REQUIRED')
        self.daily_pins[name] = (generation, digest or (previous[1] if previous else None))

    def observe_daily_read(self, name, query, response):
        if response['status'] != 200:
            return  # Original publisher owns HTTP/absence handling.
        raw = base64.b64decode(response['body'], validate=True)
        if query.get('alt') != 'media':
            value = json_loads(raw)
            if value.get('bucket') != BUCKET or value.get('name') != name or not GEN.fullmatch(str(value.get('generation', ''))):
                reject('PIN_REQUIRED')
            if (name == OBJECT and value['generation'] == self.safe_diagnostics.new_generation
                    and self.daily_pins.get(name, (None,))[0] != value['generation']):
                self.daily_pins.pop(name, None)
            self.daily_pin(name, value['generation'])
            if name == OBJECT:
                self.daily_latest_generation = value['generation']
                custom = value.get('metadata', {})
                if 'bundleMetadata' in custom:
                    old = json_loads(custom['bundleMetadata'])
                    if not bundle_paths(old):
                        reject('PIN_REQUIRED')
                    for kind in ['artifact', 'receipt']:
                        self.daily_pin(old[kind+'Object'], old.get(kind+'Generation'), old.get(kind+'Sha256'))
            return
        pin = self.daily_pins.get(name)
        if (not pin or pin[0] != query.get('generation')
                or response['headers'].get('x-goog-generation') != pin[0]
                or pin[1] and hashlib.sha256(raw).hexdigest() != pin[1]):
            reject('PIN_REQUIRED')
        self.daily_pin(name, pin[0], hashlib.sha256(raw).hexdigest())
        if not name.endswith('/receipt.json') and not recovery_receipt(name):
            return
        receipt = json_loads(raw)
        date = receipt.get('dataDate') if recovery_receipt(name) else name.split('/')[1]
        if (receipt.get('mode') != 'private_eod_action' or receipt.get('dataDate') != date
                or not (receipt.get('status') == 'partial' or receipt.get('status') == 'ready'
                        and receipt.get('calculationBasis') == 'sharesight-book-user-synchronized.v1')
                or receipt.get('publication') != 'none'
                or receipt.get('sourceCount') != 4 or not isinstance(receipt.get('sources'), list)
                or len(receipt['sources']) != 4
                or not re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z', str(receipt.get('startedAt')))):
            reject('PIN_REQUIRED')
        artifact = receipt.get('artifact', {})
        if not bundle_paths({'dataDate': date, 'artifactObject': artifact.get('privateObject'), 'receiptObject': name, 'captureStartedAt': receipt.get('startedAt')}):
            reject('PIN_REQUIRED')
        self.daily_pin(artifact['privateObject'], artifact.get('generation'), artifact.get('sha256'))
        keys = {'ib.flexEod', 'sharesight.ibGroupedPerformance', 'sharesight.noahPerformance', 'ib.optionalLive'}
        if {s.get('sourceKey') for s in receipt['sources']} != keys:
            reject('PIN_REQUIRED')
        for source in receipt['sources']:
            source_name = source.get('privateObject', '')
            pattern = re.escape('report-check/' + str(receipt.get('startedAt')) + '-') + r'[a-f0-9-]{36}/' + re.escape(source['sourceKey']) + r'\.json'
            if not re.fullmatch(pattern, source_name):
                reject('PIN_REQUIRED')
            self.daily_pin(source_name, source.get('generation'), source.get('sha256'))
        concentration = receipt.get('concentration')
        if concentration is not None:
            expected = artifact['privateObject'].rsplit('/', 1)[0]+'/concentration.sources.json'
            if (not isinstance(concentration, dict) or set(concentration) != {'privateObject', 'generation', 'sha256', 'modelSha256'}
                    or concentration.get('privateObject') != expected or not re.fullmatch('[a-f0-9]{64}', str(concentration.get('modelSha256', '')))):
                reject('PIN_REQUIRED')
            self.daily_pin(expected, concentration.get('generation'), concentration.get('sha256'))
        self.daily_receipts[name] = receipt

    def daily_request(self, value):
        posting = value.get('method') == 'POST'
        keys = {'op', 'url', 'method', 'headers', 'body'} | ({'admissionExpiresAt'} if posting else set())
        if set(value) != keys:
            reject('REQUEST_INVALID')
        request = {k: v for k, v in value.items() if k != 'admissionExpiresAt'}
        request['op'] = 'request'
        parsed = urlsplit(str(value.get('url', '')))
        prefix = '/storage/v1/b/' + BUCKET + '/o/'
        name = unquote(parsed.path[len(prefix):]) if parsed.path.startswith(prefix) else None
        if posting:
            if self.write_started:
                reject('WRITE_ALREADY_ATTEMPTED')
            self.write_started = True
            initial_wall, admitted = time.time() * 1000, time.monotonic()
            deadline = value['admissionExpiresAt']
            if type(deadline) is not int or not 0 <= deadline-initial_wall <= 5000:
                reject('REPLACEMENT_ADMISSION_EXPIRED')
            generation = self.daily_latest_generation
            if not generation:
                reject('PIN_REQUIRED')
            validated = validate_storage_request(request, generation, daily=True)
            resource, _ = validate_multipart(validated[3], validated[2]['content-type'], daily=True)
            metadata = json_loads(resource['metadata']['bundleMetadata'])
            date = daily_date()
            receipt = self.daily_receipts.get(metadata.get('receiptObject'))
            if not receipt or not bundle_paths(metadata) or receipt.get('dataDate') != date:
                reject('PIN_REQUIRED')
            if recovery_receipt(metadata.get('receiptObject')):
                registration = recovery_registration()
                if (registration.get('supersedes') and receipt.get('startedAt') == registration['referenceCapture']['captureStartedAt']
                        and receipt.get('captureCompletedAt') == registration['referenceCapture']['captureCompletedAt']
                        and generation != registration['supersedes']['latestGeneration']):
                    reject('REPLACEMENT_OLD_CHANGED')
                if (registration['dataDate'] != date or metadata['receiptObject'] != registration['receiptObject']
                        or registration['priorReceiptObject'] not in self.daily_receipts
                        or self.daily_pins.get(registration['priorReceiptObject']) !=
                            (registration['priorReceiptGeneration'], registration['priorReceiptSha256'])):
                    reject('PIN_REQUIRED')
            for kind in ['artifact', 'receipt']:
                object_name = metadata.get(kind+'Object')
                if (self.daily_pins.get(object_name)
                        != (metadata.get(kind+'Generation'), metadata.get(kind+'Sha256'))):
                    reject('PIN_REQUIRED')
            if (metadata.get('captureStartedAt') != receipt.get('startedAt')
                    or metadata.get('captureEndedAt') != receipt.get('captureCompletedAt', receipt.get('completedAt'))
                    or metadata.get('completedAt') != receipt.get('completedAt')
                    or metadata.get('sourceDate') != receipt.get('sourceDate')
                    or metadata.get('financialStatus') != ('complete' if receipt.get('status') == 'ready' else 'partial')):
                reject('PIN_REQUIRED')
            # Repeat the current pointer and registered canary check at the
            # native boundary; neither a caller pin nor upload ACK supplies it.
            current = self.raw_request('https://storage.googleapis.com'+prefix+quote(OBJECT, safe='')+'?alt=media',
                                       'HEAD', {'Accept-Encoding': 'identity'}, None)
            if current['status'] != 200 or current['headers'].get('x-goog-generation') != generation:
                reject('REPLACEMENT_OLD_CHANGED')
            registry = (Path(__file__).resolve().parents[2]/'security'/'xuan-owner-registered-canary.json').read_bytes()
            self.verify_replacement_canary_current({'canaryRegistrationSha256': hashlib.sha256(registry).hexdigest(),
                                                    'previousDisplaySha256': json_loads(registry)['pin']['candidateSha256']})
            current_time = time.time()*1000
            if not initial_wall <= current_time <= deadline or (time.monotonic()-admitted)*1000 > deadline-initial_wall:
                reject('REPLACEMENT_ADMISSION_EXPIRED')
            capture_ms = datetime.datetime.fromisoformat(receipt['startedAt'].replace('Z', '+00:00')).timestamp()*1000
            registration = recovery_registration()
            ref = reference_capture(registration, receipt.get('startedAt'), receipt.get('captureCompletedAt')) if metadata.get('receiptObject') == registration['receiptObject'] else None
            freshness_deadline = datetime.datetime.fromisoformat(ref['expiresAt'].replace('Z', '+00:00')).timestamp()*1000 if ref else capture_ms+1800000
            if receipt.get('referenceMode') != (ref['schema'] if ref else None) or not capture_ms <= current_time <= freshness_deadline or receipt['dataDate'] != daily_date():
                reject('REPLACEMENT_ADMISSION_EXPIRED')
            self.mutation_started = True
            return self.raw_request(*validated)
        if name == OBJECT:
            validated = validate_storage_request(request)
        else:
            if not name or parsed.path != prefix+quote(name, safe='') or value.get('method') != 'GET':
                reject('TARGET_INVALID')
            # Run the unchanged strict URL/query/header checks against its
            # fixed-path surrogate; the original URL is sent only after pins.
            surrogate = dict(request, url=request['url'].replace(parsed.path, prefix+quote(OBJECT, safe=''), 1))
            _, method, headers, body = validate_storage_request(surrogate)
            query = dict(parse_qsl(parsed.query, strict_parsing=True))
            discover = name in ('delivery/'+daily_date()+'/report.html', 'delivery/'+daily_date()+'/receipt.json')
            registration = recovery_registration()
            if registration['dataDate'] == daily_date():
                discover = discover or name == registration['receiptObject']
                if name == registration['priorReceiptObject'] and query.get('generation') == registration['priorReceiptGeneration']:
                    self.daily_pin(name, registration['priorReceiptGeneration'], registration['priorReceiptSha256'])
            pin = self.daily_pins.get(name)
            if ('generation' not in query and (not discover or query.get('alt') == 'media')
                    or 'generation' in query and (not pin or pin[0] != query['generation'])):
                reject('PIN_REQUIRED')
            validated = request['url'], method, headers, body
        response = self.raw_request(*validated)
        query = dict(parse_qsl(parsed.query, strict_parsing=True))
        if value['method'] == 'GET':
            self.observe_daily_read(name, query, response)
        return response

    def dispatch(self, value):
        self.safe_diagnostics.begin('request-validation')
        self._operation = value.get('op') if isinstance(value, dict) else None
        try:
            return self._dispatch(value)
        except Exception as error:
            self.safe_diagnostics.error(error)
            raise

    def _dispatch(self, value):
        if self.closed:
            reject('CLOSED')
        if not isinstance(value, dict):
            reject('REQUEST_INVALID')
        op = value.get('op')
        if op == 'inspectEvidence' and set(value) == {'op'}:
            return self.inspect_evidence_attempt()
        if op == 'beginEvidence':
            return self.begin_evidence(value)
        if op == 'writeEvidence':
            return self.write_evidence(value)
        if op == 'dailyRequest':
            return self.daily_request(value)
        if op == 'replaceAcceptedPreview':
            validated, revision, old = validate_replacement_request(value)
            if self.write_started:
                reject('WRITE_ALREADY_ATTEMPTED')
            self.write_started = True  # one attempt, including pre-write failures
            initial_wall, admitted = time.time() * 1000, time.monotonic()
            remaining_ms = value['admissionExpiresAt'] - initial_wall
            if not 0 <= remaining_ms <= 5000:
                reject('REPLACEMENT_ADMISSION_EXPIRED')
            self.verify_replacement_previous(value['replacement'], revision, old)
            self.verify_replacement_canary_current(revision)
            current = time.time() * 1000
            if not initial_wall <= current <= value['admissionExpiresAt'] or (time.monotonic() - admitted) * 1000 > remaining_ms:
                reject('REPLACEMENT_ADMISSION_EXPIRED')
            self.mutation_started = True
            return self.raw_request(*validated)
        if op == 'request':
            url, method, headers, body = validate_storage_request(value)
            if method == 'POST':
                if self.write_started:
                    reject('WRITE_ALREADY_ATTEMPTED')
                self.write_started = True  # before network; failure never reopens it
                self.mutation_started = True
            return self.raw_request(url, method, headers, body)
        if op == 'identity' and set(value) == {'op'}:
            self.safe_diagnostics.mark('identity')
            return self.provider.check_original_identity()
        if op == 'createCanary':
            body, boundary = canary_content(value)
            if self.canary_attempted:
                reject('CANARY_ALREADY_ATTEMPTED')
            self.canary_attempted = True
            probe = self.raw_request('https://storage.googleapis.com/storage/v1/b/' + BUCKET + '/o/' + quote(CANARY_OBJECT, safe='') + '?alt=media',
                                     'HEAD', {'Accept-Encoding': 'identity'}, None)
            if probe['status'] == 200:
                reject('CANARY_ALREADY_EXISTS')
            if probe['status'] != 404:
                reject('CANARY_PRESENCE_UNPROVEN')
            self.mutation_started = True
            return self.raw_request('https://storage.googleapis.com/upload/storage/v1/b/' + BUCKET + '/o?uploadType=multipart&ifGenerationMatch=0',
                                    'POST', {'Content-Type': 'multipart/related; boundary=' + boundary, 'Accept': 'application/json', 'Accept-Encoding': 'identity'}, body)
        if op == 'requestCanary' and set(value) == {'op', 'method', 'generation', 'media'}:
            method, gen, media = value['method'], value['generation'], value['media']
            if not isinstance(media, bool) or method not in ('GET', 'HEAD'):
                reject('CANARY_REQUEST_INVALID')
            url = 'https://storage.googleapis.com/storage/v1/b/' + BUCKET + '/o/' + quote(CANARY_OBJECT, safe='')
            if method == 'HEAD':
                if gen is not None or media is not True:
                    reject('CANARY_REQUEST_INVALID')
                return self.raw_request(url + '?alt=media', 'HEAD', {'Accept-Encoding': 'identity'}, None)
            if not isinstance(gen, str) or not GEN.fullmatch(gen):
                reject('PIN_REQUIRED')
            url += '?generation=' + gen + ('&alt=media' if media else '')
            return self.raw_request(url, 'GET', {'Accept': 'application/octet-stream' if media else 'application/json', 'Accept-Encoding': 'identity'}, None)
        if (op == 'boundary' and set(value) in ({'op', 'includeRoleDefinitions'}, {'op', 'includeRoleDefinitions', 'requireDeletePermission'})
                and isinstance(value['includeRoleDefinitions'], bool) and isinstance(value.get('requireDeletePermission', False), bool)):
            started = instant()
            self.safe_diagnostics.mark('identity')
            actor = self.provider.check_original_identity()
            bucket_url = 'https://storage.googleapis.com/storage/v1/b/' + BUCKET
            bucket = self.read_json(bucket_url)
            bucket_iam = self.read_json(bucket_url + '/iam?optionsRequestedPolicyVersion=3')
            project = self.read_json('https://cloudresourcemanager.googleapis.com/v1/projects/' + PROJECT)
            project_iam = self.read_json('https://cloudresourcemanager.googleapis.com/v1/projects/' + PROJECT + ':getIamPolicy',
                                         'POST', b'{"options":{"requestedPolicyVersion":3}}')
            permissions = self.read_json(bucket_url + '/iam/testPermissions?permissions=storage.objects.create&permissions=storage.objects.get'
                                         + ('&permissions=storage.objects.delete' if value.get('requireDeletePermission') else ''))
            roles = []
            if value['includeRoleDefinitions']:
                for role in ROLE_NAMES:
                    roles.append(self.read_json('https://iam.googleapis.com/v1/' + role))
            return {'schema': 'xuan.owner-sdk-live-boundary.v1',
                    'actorIdentifier': actor['actorIdentifier'], 'bucketMetadata': bucket,
                    'bucketIam': bucket_iam, 'projectMetadata': project,
                    'projectIam': project_iam, 'roleDefinitions': roles,
                    'bucketTestPermissions': permissions,
                    'startedAt': started, 'completedAt': instant()}
        reject('OPERATION_INVALID')

    def close(self):
        self.closed = True
        self.provider.close()


def main():
    # stdout is the private framed pipe. stderr never receives SDK/raw errors.
    logging.disable(logging.CRITICAL)
    bridge = OwnerBridge(LiveSdkProvider())
    try:
        while True:
            line = sys.stdin.buffer.readline(MAX_LINE + 1)
            if not line:
                break
            bridge.safe_diagnostics.begin('frame')
            request = None
            try:
                if len(line) > MAX_LINE or not line.endswith(b'\n'):
                    reject('FRAME_INVALID')
                request = json_loads(line)
                if not isinstance(request, dict) or set(request) != {'id', 'value'} or not isinstance(request['id'], int):
                    reject('FRAME_INVALID')
                result = bridge.dispatch(request['value'])
                answer = {'id': request['id'], 'result': result}
            except BoundaryError as error:
                bridge.safe_diagnostics.error(error)
                answer = {'id': request.get('id') if isinstance(locals().get('request'), dict) else None, 'error': error.code}
            except Exception as error:
                bridge.safe_diagnostics.error(error)
                answer = {'id': request.get('id') if isinstance(locals().get('request'), dict) else None, 'error': 'SDK_FAILED'}
            answer['safeDiagnostics'] = bridge.safe_diagnostics.snapshot()
            answer['safeCleanupDiagnostics'] = list(bridge.safe_diagnostics.cleanup)
            encoded = json.dumps(answer, separators=(',', ':'), ensure_ascii=True).encode('ascii')
            if len(encoded) > MAX_LINE:
                bridge.safe_diagnostics.error(BoundaryError('FRAME_SIZE_LIMIT'))
                encoded = json.dumps({'id': None, 'error': 'FRAME_SIZE_LIMIT', 'safeDiagnostics': bridge.safe_diagnostics.snapshot(), 'safeCleanupDiagnostics': list(bridge.safe_diagnostics.cleanup)}, separators=(',', ':')).encode('ascii')
            sys.stdout.buffer.write(encoded + b'\n')
            sys.stdout.buffer.flush()
    finally:
        try:
            bridge.close()
        except Exception:
            # No pending RPC after EOF; preserve nonzero exit without traceback.
            raise SystemExit(1) from None


if __name__ == '__main__':
    main()
