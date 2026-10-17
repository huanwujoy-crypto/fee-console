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
import uuid as uuid_module
from urllib.parse import parse_qsl, quote, urlsplit

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
        if set(normalized) != {'content-type', 'accept'} or normalized['accept'] != 'application/json':
            reject('HEADERS_INVALID')
    elif method == 'HEAD':
        if normalized != {'accept-encoding': 'identity'}:
            reject('HEADERS_INVALID')
    elif normalized not in (
            {'accept': 'application/json', 'accept-encoding': 'identity'},
            {'accept': 'application/octet-stream', 'accept-encoding': 'identity'}):
        reject('HEADERS_INVALID')
    return normalized


def validate_multipart(body, content_type):
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
    if (not isinstance(custom, dict) or set(custom) != {'previewMetadata', 'displaySha256'}
            or custom['displaySha256'] != digest or boundary != ('xuan_owner_latest_' + digest).encode('ascii')
            or not isinstance(custom['previewMetadata'], str)):
        reject('MULTIPART_METADATA_INVALID')
    metadata = json_loads(custom['previewMetadata'])
    if not isinstance(metadata, dict) or metadata.get('schema') != 'xuan.owner-accepted-preview.v1':
        reject('MULTIPART_METADATA_INVALID')
    try:
        display.decode('utf-8', errors='strict')
    except UnicodeError:
        reject('DISPLAY_UTF8_INVALID')


def validate_storage_request(value):
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
        if parsed.path != '/upload/storage/v1/b/' + BUCKET + '/o' or query != {'uploadType': 'multipart', 'ifGenerationMatch': '0'}:
            reject('TARGET_INVALID')
        try:
            body = base64.b64decode(value['body'], validate=True)
        except (ValueError, TypeError):
            reject('BODY_INVALID')
        validate_multipart(body, headers['content-type'])
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
    html = ('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer">'
            '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; base-uri \'none\'; form-action \'none\'">'
            '<title>Private delivery check</title></head><body><!-- xuan.owner-phone-canary.v1 -->'
            '<h1>Private delivery check</h1><p>Reference: ' + uid + '</p><p>Created at UTC: ' + created
            + '</p><p>Candidate SHA-256: ' + candidate + '</p></body></html>').encode('utf-8')
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

    def identity(self):
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
        return session.request(method, url, headers=headers, data=body,
                               timeout=(5, 15), allow_redirects=False, stream=True,
                               verify=True)

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
        self.mutation_started = False

    def raw_request(self, url, method, headers, body):
        if self.closed:
            reject('CLOSED')
        try:
            response = self.provider.request(url, method, headers, body)
            try:
                if response.url != url or response.history:
                    reject('REDIRECT_OR_URL_CHANGED')
                selected = {k.lower(): v for k, v in response.headers.items() if k.lower() in RESPONSE_HEADERS}
                if method == 'HEAD' or response.status_code != 200:
                    raw = b''
                else:
                    raw = response.raw.read(MAX_RESPONSE + 1, decode_content=False)
                    if len(raw) > MAX_RESPONSE:
                        reject('RESPONSE_SIZE_LIMIT')
                return {'status': response.status_code, 'url': response.url,
                        'headers': selected, 'body': base64.b64encode(raw).decode('ascii')}
            finally:
                response.close()
        except BoundaryError:
            raise
        except Exception:
            # Status/error bodies and SDK exception text may contain secrets.
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

    def dispatch(self, value):
        if self.closed:
            reject('CLOSED')
        if not isinstance(value, dict):
            reject('REQUEST_INVALID')
        op = value.get('op')
        if op == 'request':
            url, method, headers, body = validate_storage_request(value)
            if method == 'POST':
                if self.write_started:
                    reject('WRITE_ALREADY_ATTEMPTED')
                self.write_started = True  # before network; failure never reopens it
                self.mutation_started = True
            return self.raw_request(url, method, headers, body)
        if op == 'identity' and set(value) == {'op'}:
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
                                    'POST', {'Content-Type': 'multipart/related; boundary=' + boundary, 'Accept': 'application/json'}, body)
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
        if op == 'boundary' and set(value) == {'op', 'includeRoleDefinitions'} and isinstance(value['includeRoleDefinitions'], bool):
            started = instant()
            actor = self.provider.check_original_identity()
            bucket_url = 'https://storage.googleapis.com/storage/v1/b/' + BUCKET
            bucket = self.read_json(bucket_url)
            bucket_iam = self.read_json(bucket_url + '/iam?optionsRequestedPolicyVersion=3')
            project = self.read_json('https://cloudresourcemanager.googleapis.com/v1/projects/' + PROJECT)
            project_iam = self.read_json('https://cloudresourcemanager.googleapis.com/v1/projects/' + PROJECT + ':getIamPolicy',
                                         'POST', b'{"options":{"requestedPolicyVersion":3}}')
            permissions = self.read_json(bucket_url + '/iam/testPermissions?permissions=storage.objects.create&permissions=storage.objects.get')
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
            try:
                if len(line) > MAX_LINE or not line.endswith(b'\n'):
                    reject('FRAME_INVALID')
                request = json_loads(line)
                if not isinstance(request, dict) or set(request) != {'id', 'value'} or not isinstance(request['id'], int):
                    reject('FRAME_INVALID')
                result = bridge.dispatch(request['value'])
                answer = {'id': request['id'], 'result': result}
            except BoundaryError as error:
                answer = {'id': request.get('id') if isinstance(locals().get('request'), dict) else None, 'error': error.code}
            except Exception:
                answer = {'id': request.get('id') if isinstance(locals().get('request'), dict) else None, 'error': 'SDK_FAILED'}
            encoded = json.dumps(answer, separators=(',', ':'), ensure_ascii=True).encode('ascii')
            if len(encoded) > MAX_LINE:
                encoded = b'{"id":null,"error":"FRAME_SIZE_LIMIT"}'
            sys.stdout.buffer.write(encoded + b'\n')
            sys.stdout.buffer.flush()
    finally:
        bridge.close()


if __name__ == '__main__':
    main()
