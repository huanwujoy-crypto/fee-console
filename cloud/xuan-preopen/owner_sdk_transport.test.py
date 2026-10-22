"""Synthetic only: no live credential store, SDK calls or network."""
import base64
import datetime
import gzip
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('owner_transport', Path(__file__).with_name('owner_sdk_transport.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
BASE = 'https://storage.googleapis.com/storage/v1/b/' + m.BUCKET + '/o/'
LATEST = BASE + 'delivery%2Fowner-latest.html'
UPLOAD = 'https://storage.googleapis.com/upload/storage/v1/b/' + m.BUCKET + '/o?uploadType=multipart&ifGenerationMatch=0'


def read_value(url=LATEST, method='GET', headers=None):
    return {'op': 'request', 'url': url, 'method': method,
            'headers': headers or {'Accept': 'application/json', 'Accept-Encoding': 'identity'}, 'body': None}


def write_value():
    display = b'<html><body>synthetic preview only</body></html>'
    digest = hashlib.sha256(display).hexdigest()
    boundary = 'xuan_owner_latest_' + digest
    resource = {'name': m.OBJECT, 'contentType': 'text/html; charset=utf-8', 'contentDisposition': 'inline',
                'cacheControl': 'private, no-store, max-age=0',
                'metadata': {'previewMetadata': '{"schema":"xuan.owner-accepted-preview.v1"}', 'displaySha256': digest}}
    body = ('--' + boundary + '\r\nContent-Type: application/json; charset=utf-8\r\n\r\n' + json.dumps(resource)
            + '\r\n--' + boundary + '\r\nContent-Type: text/html; charset=utf-8\r\n\r\n').encode() + display + ('\r\n--' + boundary + '--\r\n').encode()
    return {'op': 'request', 'url': UPLOAD, 'method': 'POST',
            'headers': {'Content-Type': 'multipart/related; boundary=' + boundary, 'Accept': 'application/json', 'Accept-Encoding': 'identity'},
            'body': base64.b64encode(body).decode()}


class Response:
    def __init__(self, url, status=200, body=b'{}', headers=None, history=None):
        self.url, self.status_code, self.raw = url, status, io.BytesIO(body)
        self.headers = headers or {'Content-Type': 'application/json', 'Content-Length': str(len(body))}
        self.history, self.closed = history or [], False
        original = self.raw.read
        self.raw.read = lambda size, decode_content=False: original(size)

    def close(self):
        self.closed = True


class Provider:
    def __init__(self, statuses=()):
        self.calls, self.statuses, self.closed = [], list(statuses), False

    def check_original_identity(self):
        return {'actorIdentifier': 'synthetic-owner@example.invalid'}

    def request(self, url, method, headers, body):
        self.calls.append((url, method, headers, body))
        status = self.statuses.pop(0) if self.statuses else 200
        if isinstance(status, Exception):
            raise status
        return Response(url, status)

    def close(self):
        self.closed = True


class BoundaryTests(unittest.TestCase):
    def assertCode(self, code, callback):
        with self.assertRaises(m.BoundaryError) as context:
            callback()
        self.assertEqual(context.exception.code, code)

    def test_import_and_constructor_have_no_sdk_or_credential_effect(self):
        provider = Provider()
        bridge = m.OwnerBridge(provider)
        self.assertEqual(provider.calls, [])
        self.assertIsNone(m.LiveSdkProvider().session)
        bridge.close()
        self.assertTrue(provider.closed)

    def test_fixed_latest_reads_and_pins(self):
        for value in (read_value(), read_value(LATEST + '?generation=123'),
                      read_value(LATEST + '?generation=123&alt=media', headers={'Accept': 'application/octet-stream', 'Accept-Encoding': 'identity'}),
                      read_value(LATEST + '?alt=media', 'HEAD', {'Accept-Encoding': 'identity'})):
            self.assertEqual(m.validate_storage_request(value)[0], value['url'])

    def test_forbidden_target_method_and_unpinned_media_before_provider(self):
        provider = Provider()
        bridge = m.OwnerBridge(provider)
        for value in (read_value(LATEST.replace('https:', 'http:')), read_value(LATEST.replace('storage.googleapis.com', 'evil.invalid')),
                      read_value(LATEST.replace(m.BUCKET, 'other')), read_value(LATEST.replace('owner-latest', 'owner-phone-canary-v1')),
                      read_value(LATEST + '?alt=media'), read_value(LATEST + '?generation=1&generation=2'),
                      read_value(LATEST + '?generation=0'), read_value(LATEST + '?generation=1#x'), read_value(LATEST, 'DELETE')):
            with self.assertRaises(m.BoundaryError):
                bridge.dispatch(value)
        self.assertEqual(provider.calls, [])

    def test_auth_cookie_and_extra_headers_rejected(self):
        for key in ('Authorization', 'Cookie', 'Proxy-Authorization', 'X-Goog-User-Project', 'Host'):
            value = read_value()
            value['headers'][key] = 'synthetic'
            self.assertCode('HEADERS_INVALID', lambda: m.validate_storage_request(value))

    def test_cas0_multipart_exact_bytes_and_resource(self):
        value = write_value()
        self.assertEqual(m.validate_storage_request(value)[3], base64.b64decode(value['body']))
        for replacement in ('1', '000', ''):
            changed = dict(value, url=UPLOAD.replace('ifGenerationMatch=0', 'ifGenerationMatch=' + replacement))
            self.assertCode('TARGET_INVALID', lambda: m.validate_storage_request(changed))
        raw = base64.b64decode(value['body'])
        for before, after in ((b'owner-latest.html', b'other.html'), (b'private, no-store', b'public, max-age=9'),
                              (b'inline', b'attachment'), (b'preview only', b'changed only')):
            changed = dict(value, body=base64.b64encode(raw.replace(before, after)).decode())
            with self.assertRaises(m.BoundaryError):
                m.validate_storage_request(changed)

    def test_raw_post_frames_require_exact_identity_before_any_provider_call(self):
        provider = Provider()
        bridge = m.OwnerBridge(provider)
        for encoding in (None, 'gzip', 'identity, gzip', '*', 'IDENTITY'):
            value = write_value()
            if encoding is None:
                del value['headers']['Accept-Encoding']
            else:
                value['headers']['Accept-Encoding'] = encoding
            self.assertCode('HEADERS_INVALID', lambda: bridge.dispatch(value))
        self.assertEqual(provider.calls, [])

    def test_canary_and_financial_posts_both_send_fixed_identity(self):
        provider = Provider([404, 200, 200])
        bridge = m.OwnerBridge(provider)
        bridge.dispatch({'op': 'createCanary', 'uuid': '00000000-0000-4000-8000-000000000000',
                         'createdAt': m.instant(), 'candidateSha256': 'a' * 64})
        bridge.dispatch(write_value())
        posts = [call for call in provider.calls if call[1] == 'POST']
        self.assertEqual(len(posts), 2)
        for _, _, headers, _ in posts:
            normalized = {key.lower(): value for key, value in headers.items()}
            self.assertEqual(set(normalized), {'content-type', 'accept', 'accept-encoding'})
            self.assertEqual(normalized['accept-encoding'], 'identity')

    def test_raw_gzip_response_is_preserved_for_existing_downstream_rejection(self):
        encoded = gzip.compress(b'{"synthetic":"ack"}')
        provider = Provider()
        response = Response(LATEST, body=encoded, headers={'Content-Type': 'application/json',
                            'Content-Length': str(len(encoded)), 'Content-Encoding': 'gzip'})
        read = response.raw.read
        with patch.object(response.raw, 'read', side_effect=read) as raw_read:
            provider.request = lambda *_args: response
            value = m.OwnerBridge(provider).dispatch(read_value())
            self.assertEqual(base64.b64decode(value['body']), encoded)
            self.assertEqual(value['headers']['content-encoding'], 'gzip')
            self.assertIs(raw_read.call_args.kwargs['decode_content'], False)

    def test_json_duplicate_key_and_invalid_utf8(self):
        self.assertCode('DUPLICATE_JSON_KEY', lambda: m.json_loads('{"x":1,"x":2}'))
        self.assertCode('JSON_INVALID', lambda: m.json_loads(b'\xff'))

    def test_each_status_and_unknown_never_replays_post(self):
        for status in (200, 401, 403, 412, 503, IOError('synthetic failure')):
            provider = Provider([status])
            bridge = m.OwnerBridge(provider)
            try:
                bridge.dispatch(write_value())
            except m.BoundaryError as error:
                self.assertEqual(error.code, 'REQUEST_OUTCOME_UNKNOWN')
            self.assertCode('WRITE_ALREADY_ATTEMPTED', lambda: bridge.dispatch(write_value()))
            self.assertEqual(len(provider.calls), 1)

    def test_response_no_error_body_auth_headers_or_redirect(self):
        provider = Provider([403])
        result = m.OwnerBridge(provider).dispatch(read_value())
        self.assertEqual(result['body'], '')
        provider.request = lambda url, *_args: Response(url, headers={'Authorization': 'synthetic', 'Set-Cookie': 'synthetic', 'Content-Type': 'application/json'})
        result = m.OwnerBridge(provider).dispatch(read_value())
        self.assertEqual(result['headers'], {'content-type': 'application/json'})
        provider.request = lambda url, *_args: Response(url, history=[True])
        self.assertCode('REDIRECT_OR_URL_CHANGED', lambda: m.OwnerBridge(provider).dispatch(read_value()))

    def test_environment_rejects_all_identity_proxy_tls_overrides(self):
        for key in m.OVERRIDE_ENV + ('CLOUDSDK_API_ENDPOINT_OVERRIDES_STORAGE', 'CLOUDSDK_AUTH_UNRECOGNIZED'):
            self.assertCode('ENVIRONMENT_OVERRIDE', lambda: m.environment_guard({'CLOUDSDK_CONFIG': m.SDK_CONFIG, key: 'synthetic'}))
        m.environment_guard({'CLOUDSDK_CONFIG': m.SDK_CONFIG})
        self.assertCode('SDK_CONFIG_INVALID', lambda: m.environment_guard({'CLOUDSDK_CONFIG': '/tmp/other'}))

    def test_noncredential_sdk_locator_is_fixed_by_realpath_hash(self):
        self.assertCode('SDK_ROOT_REQUIRED', lambda: m.existing_sdk_root({}))
        self.assertCode('SDK_ROOT_INVALID', lambda: m.existing_sdk_root({'XUAN_OWNER_EXISTING_SDK_ROOT': '/tmp'}))
        self.assertCode('SDK_ROOT_INVALID', lambda: m.existing_sdk_root({'XUAN_OWNER_EXISTING_SDK_ROOT': '/tmp/nonexistent-owner-sdk-runtime'}))

    def test_original_account_and_property_overrides_before_credential_store(self):
        class Property:
            def __init__(self, value=None):
                self.value, self.default = value, value
            def Get(self):
                return str(self.value) if isinstance(self.value, bool) else self.value
            def GetBool(self):
                if self.value is None:
                    return None
                if isinstance(self.value, bool):
                    return self.value
                raise ValueError('synthetic invalid boolean')
        actor = 'synthetic-owner@example.invalid'
        def values():
            return types.SimpleNamespace(
                auth=types.SimpleNamespace(access_token_file=Property(), credential_file_override=Property(),
                    impersonate_service_account=Property(), token_host=Property('https://oauth2.googleapis.com/token'),
                    disable_credentials=Property(False), disable_ssl_validation=Property(False)),
                core=types.SimpleNamespace(account=Property(actor), universe_domain=Property('googleapis.com'), custom_ca_certs_file=Property()),
                proxy=types.SimpleNamespace(proxy_type=Property()))
        provider = m.LiveSdkProvider()
        expected = hashlib.sha256(actor.encode()).hexdigest()
        with patch.dict('os.environ', {'CLOUDSDK_CONFIG': m.SDK_CONFIG}, clear=True), patch.object(m, 'OWNER_SHA256', expected):
            provider.properties = types.SimpleNamespace(VALUES=values())
            self.assertEqual(provider.identity()['accountSha256'], expected)
            provider.properties.VALUES.core.account.value = 'other@example.invalid'
            self.assertCode('ORIGINAL_IDENTITY_REQUIRED', provider.identity)
            for section, name, value in (('auth', 'access_token_file', '/tmp/other'), ('auth', 'credential_file_override', '/tmp/other'),
                                         ('auth', 'impersonate_service_account', 'other'), ('auth', 'token_host', 'https://other.invalid'),
                                         ('auth', 'disable_ssl_validation', True), ('proxy', 'proxy_type', 'http'), ('core', 'universe_domain', 'other.invalid')):
                provider.properties = types.SimpleNamespace(VALUES=values())
                getattr(getattr(provider.properties.VALUES, section), name).value = value
                self.assertCode('SDK_OVERRIDE', provider.identity)

    def test_boundary_only_fixed_read_apis_and_exact_permission_pair(self):
        provider = Provider()
        result = m.OwnerBridge(provider).dispatch({'op': 'boundary', 'includeRoleDefinitions': True})
        self.assertEqual(len(provider.calls), 22)
        self.assertEqual(len(result['roleDefinitions']), 17)
        self.assertEqual([c for c in provider.calls if c[1] == 'POST'][0][0], 'https://cloudresourcemanager.googleapis.com/v1/projects/' + m.PROJECT + ':getIamPolicy')
        self.assertEqual(provider.calls[4][0], 'https://storage.googleapis.com/storage/v1/b/' + m.BUCKET + '/iam/testPermissions?permissions=storage.objects.create&permissions=storage.objects.get')
        self.assertEqual(set(result), {'schema', 'actorIdentifier', 'bucketMetadata', 'bucketIam', 'projectMetadata', 'projectIam', 'roleDefinitions', 'bucketTestPermissions', 'startedAt', 'completedAt'})
        provider.calls.clear()
        m.OwnerBridge(provider).dispatch({'op': 'boundary', 'includeRoleDefinitions': False})
        self.assertEqual(len(provider.calls), 5)

    def test_canary_strict_fields_template_and_pins(self):
        value = {'op': 'createCanary', 'uuid': '00000000-0000-4000-8000-000000000000', 'createdAt': m.instant(), 'candidateSha256': 'a' * 64}
        provider = Provider([404, 200])
        bridge = m.OwnerBridge(provider)
        bridge.dispatch(value)
        self.assertEqual([c[1] for c in provider.calls], ['HEAD', 'POST'])
        self.assertIn(b'<p>Candidate SHA-256: ' + b'a' * 64, provider.calls[1][3])
        self.assertIn('ifGenerationMatch=0', provider.calls[1][0])
        self.assertCode('CANARY_ALREADY_ATTEMPTED', lambda: bridge.dispatch(value))
        for changed in (dict(value, body='arbitrary'), dict(value, uuid='x'), dict(value, candidateSha256='<script>'), dict(value, createdAt='2099-01-01T00:00:00.000Z')):
            with self.assertRaises(m.BoundaryError):
                m.OwnerBridge(Provider()).dispatch(changed)
        for gen in (None, '0', '../1'):
            self.assertCode('PIN_REQUIRED', lambda: bridge.dispatch({'op': 'requestCanary', 'method': 'GET', 'generation': gen, 'media': True}))

    def test_canary_existing_denied_unknown_stop_before_post(self):
        value = {'op': 'createCanary', 'uuid': '00000000-0000-4000-8000-000000000000', 'createdAt': m.instant(), 'candidateSha256': 'a' * 64}
        for status in (200, 403, 503, IOError('synthetic')):
            provider = Provider([status])
            bridge = m.OwnerBridge(provider)
            with self.assertRaises(m.BoundaryError):
                bridge.dispatch(value)
            self.assertCode('CANARY_ALREADY_ATTEMPTED', lambda: bridge.dispatch(value))
            self.assertEqual(len(provider.calls), 1)

    def test_close_and_unsupported_operation(self):
        provider = Provider()
        bridge = m.OwnerBridge(provider)
        self.assertCode('OPERATION_INVALID', lambda: bridge.dispatch({'op': 'token'}))
        self.assertCode('OPERATION_INVALID', lambda: bridge.dispatch({'op': 'boundary', 'includeRoleDefinitions': True, 'url': 'other'}))
        bridge.close()
        self.assertCode('CLOSED', lambda: bridge.dispatch(read_value()))


class SdkSessionSyntheticTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Official installed libraries, but all credential-store/session calls
        # below are stubbed. No live SDK identity or credentials are loaded.
        if not os.environ.get('XUAN_OWNER_EXISTING_SDK_ROOT'):
            raise unittest.SkipTest('Existing Mac SDK locator absent; pure boundary tests still run')
        sdk_root = m.existing_sdk_root(os.environ)
        if not Path(sdk_root + '/lib/third_party/google/auth/transport/requests.py').is_file():
            raise unittest.SkipTest('Mac bundled SDK unavailable; pure boundary tests still run')
        sys.path[:0] = [sdk_root + '/lib', sdk_root + '/lib/third_party']
        from googlecloudsdk.core.credentials import creds, google_auth_credentials
        import requests
        cls.sdk_creds, cls.user_class, cls.requests = creds, google_auth_credentials.Credentials, requests

    def provider(self):
        credential = self.user_class('synthetic-token', refresh_token='synthetic-refresh', token_uri='https://oauth2.googleapis.com/token', client_id='synthetic-client', client_secret='synthetic-secret')
        credential.expiry = datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None) + datetime.timedelta(minutes=30)
        provider = m.LiveSdkProvider()
        provider.account = 'synthetic-owner@example.invalid'
        provider.identity = lambda: {'actorIdentifier': provider.account}
        return provider, credential

    def test_real_authorized_session_401_403_503_one_business_request(self):
        for status in (200, 401, 403, 503):
            provider, credential = self.provider()
            store = types.SimpleNamespace(Load=lambda account: credential)
            with patch.object(self.sdk_creds, 'GetCredentialStore', return_value=store), patch.object(self.requests.sessions.Session, 'request', return_value=Response(LATEST, status)) as send:
                response = provider.request(LATEST, 'POST', {'Accept': 'application/json'}, b'synthetic')
                self.assertEqual(response.status_code, status)
                self.assertEqual(send.call_count, 1)
                self.assertFalse(send.call_args.kwargs['allow_redirects'])
                self.assertTrue(send.call_args.kwargs['verify'])
                self.assertFalse(provider.session.trust_env)
                self.assertEqual(provider.session.adapters['https://'].max_retries.total, 0)
                self.assertEqual(provider.session._max_refresh_attempts, 0)
                self.assertEqual(provider.session._refresh_status_codes, ())
                provider.close()

    def test_real_requests_preparation_overrides_default_compression_on_both_posts(self):
        # Real installed requests preparation, but no credentials, send or HTTP.
        session = self.requests.Session()
        session.trust_env = False
        provider = Provider([404, 200, 200])
        bridge = m.OwnerBridge(provider)
        bridge.dispatch({'op': 'createCanary', 'uuid': '00000000-0000-4000-8000-000000000000',
                         'createdAt': m.instant(), 'candidateSha256': 'a' * 64})
        bridge.dispatch(write_value())
        try:
            for url, method, headers, body in [call for call in provider.calls if call[1] == 'POST']:
                without_identity = {key: value for key, value in headers.items() if key.lower() != 'accept-encoding'}
                original = session.prepare_request(self.requests.Request(method, url, headers=without_identity, data=body))
                self.assertIn('gzip', original.headers['Accept-Encoding'])  # original counterexample
                prepared = session.prepare_request(self.requests.Request(method, url, headers=headers, data=body))
                self.assertEqual(prepared.headers['Accept-Encoding'], 'identity')
                self.assertEqual(prepared.body, body)
                self.assertEqual(prepared.url, url)
                self.assertNotIn('Authorization', prepared.headers)
        finally:
            session.close()

    def test_real_authorized_session_final_send_has_identity_for_canary_financial_and_iam(self):
        # Capture final PreparedRequest after real credential/header merging;
        # Session.send is synthetic, so no transport/refresh HTTP can occur.
        provider, credential = self.provider()
        statuses = iter([404, 200, 200, 200, 200, 200, 200, 200])
        sends = []
        def send(prepared, **_kwargs):
            sends.append(prepared)
            return Response(prepared.url, next(statuses))
        with patch.object(self.sdk_creds, 'GetCredentialStore', return_value=types.SimpleNamespace(Load=lambda _: credential)), patch.object(self.requests.sessions.Session, 'send', side_effect=send):
            bridge = m.OwnerBridge(provider)
            bridge.dispatch({'op': 'createCanary', 'uuid': '00000000-0000-4000-8000-000000000000',
                             'createdAt': m.instant(), 'candidateSha256': 'a' * 64})
            bridge.dispatch(write_value())
            bridge.dispatch({'op': 'boundary', 'includeRoleDefinitions': False})
            posts = [request for request in sends if request.method == 'POST']
            self.assertEqual(len(posts), 3)
            self.assertEqual(sum(request.url == UPLOAD for request in posts), 2)
            for request in posts:
                self.assertEqual(request.headers['Accept-Encoding'], 'identity')
                self.assertEqual(sum(key.lower() == 'accept-encoding' for key in request.headers), 1)
            self.assertEqual(len(sends), 8)
            bridge.close()

    def test_no_cache_no_fallback_wrong_type_and_expiry_fail_closed(self):
        for value, code in ((None, 'EXISTING_USER_CREDENTIAL_REQUIRED'), (object(), 'EXISTING_USER_CREDENTIAL_REQUIRED')):
            provider, _ = self.provider()
            with patch.object(self.sdk_creds, 'GetCredentialStore', return_value=types.SimpleNamespace(Load=lambda _: value)):
                with self.assertRaises(m.BoundaryError) as error:
                    provider.get_session()
                self.assertEqual(error.exception.code, code)
        provider, credential = self.provider()
        credential.expiry = datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None) + datetime.timedelta(seconds=240)
        with self.assertRaises(m.BoundaryError) as error:
            provider.require_fresh(credential)
        self.assertEqual(error.exception.code, 'CACHED_CREDENTIAL_LIFETIME_INSUFFICIENT')
        credential.expiry = datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None) - datetime.timedelta(seconds=1)
        with self.assertRaises(m.BoundaryError) as error:
            provider.require_fresh(credential)
        self.assertEqual(error.exception.code, 'CACHED_CREDENTIAL_REFRESH_REQUIRED')

    def test_any_unexpected_refresh_is_denied_without_token_http(self):
        provider, credential = self.provider()
        with patch.object(self.sdk_creds, 'GetCredentialStore', return_value=types.SimpleNamespace(Load=lambda _: credential)), patch.object(self.requests.sessions.Session, 'request') as send:
            session = provider.get_session()
            for url in ('https://oauth2.googleapis.com/token', 'https://evil.invalid/token'):
                with self.assertRaises(m.BoundaryError) as error:
                    session._auth_request(url, method='POST', body=b'synthetic')
                self.assertEqual(error.exception.code, 'CACHED_CREDENTIAL_REFRESH_REQUIRED')
            self.assertEqual(send.call_count, 0)
            provider.close()

    def test_unexpected_before_request_refresh_stops_before_business_http(self):
        provider, credential = self.provider()
        def unexpected_refresh(request, _method, _url, _headers):
            request('https://oauth2.googleapis.com/token', method='POST', body=b'synthetic')
        credential.before_request = unexpected_refresh
        with patch.object(self.sdk_creds, 'GetCredentialStore', return_value=types.SimpleNamespace(Load=lambda _: credential)), patch.object(self.requests.sessions.Session, 'request') as send:
            with self.assertRaises(m.BoundaryError) as error:
                provider.request(LATEST, 'POST', {'Accept': 'application/json'}, b'synthetic')
            self.assertEqual(error.exception.code, 'CACHED_CREDENTIAL_REFRESH_REQUIRED')
            self.assertEqual(send.call_count, 0)
            provider.close()

    def test_official_sdk_boolean_getters_stringize_false_but_guard_uses_typed_values(self):
        # Exercise the real installed SDK getters using only in-memory metadata.
        # Neither named-config files, account properties nor credentials load.
        from googlecloudsdk.core import properties
        real = properties.VALUES
        for prop in (real.auth.disable_credentials, real.auth.disable_ssl_validation):
            for value, expected in ((False, False), ('false', False), (True, True), ('true', True), (None, None)):
                with patch.object(properties.named_configs.ActivePropertiesFile, 'Load', return_value=object()), patch.object(properties, '_GetProperty', return_value=properties.PropertyValue(value)):
                    self.assertEqual(prop.Get(), str(value))
                    self.assertIs(prop.GetBool(), expected)
                    if expected is False:
                        self.assertTrue(bool(prop.Get()))  # exact former counterexample
            with patch.object(properties.named_configs.ActivePropertiesFile, 'Load', return_value=object()), patch.object(properties, '_GetProperty', return_value=properties.PropertyValue('invalid')):
                with self.assertRaises(properties.InvalidValueError):
                    prop.GetBool()
        source = Path(m.__file__).read_text()
        self.assertIn('p.auth.disable_credentials.GetBool()', source)
        self.assertIn('p.auth.disable_ssl_validation.GetBool()', source)
        self.assertNotIn('p.auth.disable_credentials.Get()', source)
        self.assertNotIn('p.auth.disable_ssl_validation.Get()', source)


class ReplacementTests(unittest.TestCase):
    """Every byte/policy/version below is synthetic; no live SDK is loaded."""
    def fixture(self, wire='stored', change=None, after_read=None, post_status=200):
        old_bytes = b'<p>synthetic saved old reference</p>'
        new_bytes = b'<p>synthetic revised saved reference</p>'
        gen = '900719925474099312345'
        old = {'scope': 'synthetic-scope', 'ownerBinding': 'b' * 64, 'sourceIdentitySha256': 'c' * 64,
               'registrationId': 'synthetic-saturday', 'dataDate': '2026-10-17', 'sourceDate': '2026-10-16',
               'captureStartedAt': '2026-10-17T06:00:00.000Z', 'captureEndedAt': '2026-10-17T06:01:00.000Z',
               'completedAt': '2026-10-17T06:02:00.000Z', 'financialStatus': 'partial', 'unknownFields': ['cash', 'prices'],
               'displaySha256': hashlib.sha256(old_bytes).hexdigest()}
        new = dict(old, displaySha256=hashlib.sha256(new_bytes).hexdigest())
        old_hash = hashlib.sha256(m.canonical_registration(old)).hexdigest()
        revision = {'schema': 'xuan.owner-preview-replacement.v1', 'target': {'bucket': m.BUCKET, 'object': m.OBJECT},
                    'previousRegistrationSha256': old_hash, 'previousDisplaySha256': old['displaySha256'],
                    'canaryRegistrationSha256': 'd' * 64, 'registration': new}
        revision_hash = hashlib.sha256(m.canonical_registration(revision)).hexdigest()
        pins = {'revisionSha256': revision_hash, 'previousGeneration': gen, 'previousDisplaySha256': old['displaySha256'],
                'previousRegistrationSha256': old_hash}
        metadata = m.registered_preview_metadata(new, hashlib.sha256(m.canonical_registration(new)).hexdigest(), 'a' * 40)
        resource = {'name': m.OBJECT, 'contentType': 'text/html; charset=utf-8', 'contentDisposition': 'inline',
                    'cacheControl': 'private, no-store, max-age=0',
                    'metadata': {'previewMetadata': json.dumps(metadata), 'displaySha256': new['displaySha256']}}
        boundary = 'xuan_owner_latest_' + new['displaySha256']
        body = ('--' + boundary + '\r\nContent-Type: application/json; charset=utf-8\r\n\r\n' + json.dumps(resource)
                + '\r\n--' + boundary + '\r\nContent-Type: text/html; charset=utf-8\r\n\r\n').encode() + new_bytes + ('\r\n--' + boundary + '--\r\n').encode()
        value = {'op': 'replaceAcceptedPreview', 'url': UPLOAD.replace('ifGenerationMatch=0', 'ifGenerationMatch=' + gen), 'method': 'POST',
                 'headers': {'Content-Type': 'multipart/related; boundary=' + boundary, 'Accept': 'application/json', 'Accept-Encoding': 'identity'},
                 'body': base64.b64encode(body).decode(), 'replacement': pins, 'admissionExpiresAt': int(m.time.time() * 1000) + 4900}
        old_custom = {'displaySha256': old['displaySha256'], 'previewMetadata': json.dumps(m.registered_preview_metadata(old, old_hash, 'f' * 40))}
        stored = {'bucket': m.BUCKET, 'name': m.OBJECT, 'generation': gen, 'size': str(len(old_bytes)),
                  'contentType': 'text/html; charset=utf-8', 'contentDisposition': 'inline',
                  'cacheControl': 'private, no-store, max-age=0', 'metadata': old_custom}
        headers = {'content-type': 'text/html; charset=utf-8', 'content-length': str(len(old_bytes)), 'x-goog-generation': gen,
                   'content-disposition': 'inline', 'cache-control': 'private, no-store, max-age=0'}
        if wire == 'observed':
            headers.update({'content-disposition': 'attachment', 'cache-control': 'no-cache, no-store, max-age=0, must-revalidate'})
        if wire == 'mixed':
            headers['content-disposition'] = 'attachment'
        class SyntheticProvider(Provider):
            def request(self, url, method, outgoing, payload):
                self.calls.append((url, method, outgoing, payload))
                if method == 'POST':
                    return Response(url, post_status)
                if method == 'HEAD':
                    h = dict(headers)
                    if m.quote(m.CANARY_OBJECT, safe='') in url:
                        h.update({'x-goog-generation': '2', 'content-length': '23'})
                        if change == 'canary':
                            h['x-goog-generation'] = '3'
                        return Response(url, headers=h)
                    if change == 'generation':
                        h['x-goog-generation'] = '900719925474099312346'
                    return Response(url, headers=h)
                if 'alt=media' not in url:
                    current = json.loads(json.dumps(stored))
                    if change == 'metadata':
                        current['metadata']['displaySha256'] = 'f' * 64
                    return Response(url, body=json.dumps(current).encode())
                after_read and after_read()
                return Response(url, body=old_bytes if change != 'bytes' else b'SYNTHETIC WRONG', headers=headers)
        provider = SyntheticProvider()
        return value, revision, old, revision_hash, provider

    def run_with(self, f):
        value, revision, old, revision_hash, provider = f
        bridge = m.OwnerBridge(provider)
        with patch.object(m, 'replacement_registration', return_value=(revision, old, revision_hash)), patch.object(m, 'replacement_canary_pin', return_value={'generation': '2', 'size': '23'}):
            result = bridge.dispatch(value)
        return bridge, result

    def test_cas_n_uses_real_pinned_old_reads_and_single_post_for_both_exact_wire_profiles(self):
        for wire in ('stored', 'observed'):
            f = self.fixture(wire=wire)
            bridge, result = self.run_with(f)
            self.assertEqual(result['status'], 200)
            calls = f[-1].calls
            self.assertEqual([c[1] for c in calls], ['HEAD', 'GET', 'GET', 'HEAD', 'POST'])
            self.assertIn('generation=900719925474099312345', calls[1][0])
            self.assertIn('ifGenerationMatch=900719925474099312345', calls[4][0])
            with patch.object(m, 'replacement_registration', return_value=(f[1], f[2], f[3])):
                with self.assertRaises(m.BoundaryError):
                    bridge.dispatch(f[0])
            self.assertEqual(sum(c[1] == 'POST' for c in calls), 1)

    def test_old_version_header_hash_and_metadata_failures_make_zero_post_and_close_attempt(self):
        for options in ({'change': 'generation'}, {'change': 'metadata'}, {'change': 'bytes'}, {'wire': 'mixed'}):
            f = self.fixture(**options)
            bridge = m.OwnerBridge(f[-1])
            with patch.object(m, 'replacement_registration', return_value=(f[1], f[2], f[3])):
                for _ in range(2):
                    with self.assertRaises(m.BoundaryError):
                        bridge.dispatch(f[0])
            self.assertFalse(any(c[1] == 'POST' for c in f[-1].calls))

    def test_actual_last_post_rechecks_original_lease_without_extending_for_independent_reads(self):
        for shift in (6, -6):
            current = [m.time.time()]
            f = self.fixture(after_read=lambda: current.__setitem__(0, current[0] + shift))
            with patch.object(m.time, 'time', side_effect=lambda: current[0]):
                with self.assertRaises(m.BoundaryError) as error:
                    self.run_with(f)
            self.assertEqual(error.exception.code, 'REPLACEMENT_ADMISSION_EXPIRED')
            self.assertFalse(any(c[1] == 'POST' for c in f[-1].calls))

    def test_final_canary_changed_after_old_reads_causes_zero_post(self):
        f = self.fixture(change='canary')
        with self.assertRaises(m.BoundaryError) as error:
            self.run_with(f)
        self.assertEqual(error.exception.code, 'REPLACEMENT_CANARY_CURRENT')
        self.assertEqual([c[1] for c in f[-1].calls], ['HEAD', 'GET', 'GET', 'HEAD'])

    def test_near_expiry_uses_remaining_monotonic_budget_and_rejects_small_wall_rollback(self):
        for mode in ('remaining', 'rollback'):
            wall, monotonic = [m.time.time()], [100.0]
            def elapsed():
                wall[0] += -0.01 if mode == 'rollback' else 0.01
                monotonic[0] += 0.2
            f = self.fixture(after_read=elapsed)
            f[0]['admissionExpiresAt'] = int(wall[0] * 1000) + 100
            with patch.object(m.time, 'time', side_effect=lambda: wall[0]), patch.object(m.time, 'monotonic', side_effect=lambda: monotonic[0]):
                with self.assertRaises(m.BoundaryError) as error:
                    self.run_with(f)
            self.assertEqual(error.exception.code, 'REPLACEMENT_ADMISSION_EXPIRED')
            self.assertFalse(any(c[1] == 'POST' for c in f[-1].calls))

    def test_generic_post_still_cas0_only_and_replacement_cannot_choose_other_generation_or_candidate(self):
        for edit in (lambda v: v.update(url=UPLOAD), lambda v: v['replacement'].update(previousGeneration='1'),
                     lambda v: v.update(url=v['url'].replace(m.BUCKET, 'synthetic-other-bucket')),
                     lambda v: v.update(method='DELETE'),
                     lambda v: v['replacement'].update(revisionSha256='f' * 64),
                     lambda v: v.update(body=write_value()['body']), lambda v: v.update(admissionExpiresAt=0)):
            f = self.fixture(); edit(f[0])
            with patch.object(m, 'replacement_registration', return_value=(f[1], f[2], f[3])):
                with self.assertRaises(m.BoundaryError):
                    m.OwnerBridge(f[-1]).dispatch(f[0])
            self.assertEqual(f[-1].calls, [])

    def test_fixed_registry_keeps_old_bytes_and_source_fields_but_allows_explicit_review_marker_revision(self):
        f = self.fixture(); revision, old = f[1], f[2]
        revision['registration']['registrationId'] = 'synthetic-new-review-marker'
        canary = b'{"syntheticOldCanary":true}\n'
        revision['canaryRegistrationSha256'] = hashlib.sha256(canary).hexdigest()
        files = {'xuan-owner-accepted-preview.json': m.canonical_registration(old),
                 'xuan-owner-preview-replacement.json': m.canonical_registration(revision),
                 'xuan-owner-registered-canary.json': canary}
        with patch.object(m.Path, 'read_bytes', lambda path: files[path.name]):
            actual, _, _ = m.replacement_registration()
            self.assertEqual(actual['registration']['registrationId'], 'synthetic-new-review-marker')
            changed = json.loads(files['xuan-owner-preview-replacement.json'])
            changed['registration']['sourceDate'] = '2026-10-15'
            files['xuan-owner-preview-replacement.json'] = m.canonical_registration(changed)
            with self.assertRaises(m.BoundaryError):
                m.replacement_registration()

    def test_412_is_returned_once_and_never_retried(self):
        f = self.fixture(post_status=412)
        bridge, result = self.run_with(f)
        self.assertEqual(result['status'], 412)
        self.assertEqual(sum(c[1] == 'POST' for c in f[-1].calls), 1)
        with patch.object(m, 'replacement_registration', return_value=(f[1], f[2], f[3])):
            with self.assertRaises(m.BoundaryError):
                bridge.dispatch(f[0])


class DiagnosticSession:
    def __init__(self, outcomes):
        self.outcomes, self.calls = list(outcomes), []
        self.cookies = types.SimpleNamespace(clear=lambda: None)

    def request(self, method, url, **options):
        self.calls.append((method, url, options))
        item = self.outcomes.pop(0) if self.outcomes else (200, b'{}')
        if isinstance(item, Exception):
            raise item
        if callable(item):
            return item(url)
        return Response(url, item[0], item[1])


class DiagnosticLiveProvider(m.LiveSdkProvider):
    # Exercise the real LiveSdkProvider.request HTTP boundary while replacing
    # only its cached-session acquisition with an inert synthetic provider.
    def __init__(self, outcomes=(), cache_error=None):
        super().__init__()
        self.fake_session = DiagnosticSession(outcomes)
        self.cache_error = cache_error
        self.credential = types.SimpleNamespace(valid=True,
            token_state=types.SimpleNamespace(name='FRESH'),
            expiry=datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(hours=1))

    def get_session(self):
        if self._safe_diagnostics is not None:
            self._safe_diagnostics.mark('cache')
        if self.cache_error is not None:
            raise self.cache_error
        return self.fake_session


class SafeDiagnosticTests(unittest.TestCase):
    def run_error(self, bridge, value, code):
        with self.assertRaises(m.BoundaryError) as result:
            bridge.dispatch(value)
        self.assertEqual(result.exception.code, code)
        return bridge.safe_diagnostics.snapshot()

    def test_cached_identity_failure_does_not_count_http_entry(self):
        p = DiagnosticLiveProvider(cache_error=m.BoundaryError('CACHED_CREDENTIAL_REFRESH_REQUIRED'))
        b = m.OwnerBridge(p)
        d = self.run_error(b, write_value(), 'CACHED_CREDENTIAL_REFRESH_REQUIRED')
        self.assertEqual((d['stage'], d['casHttpAttempts'], d['casHttpAcks']), ('cache', 0, 0))
        self.assertEqual(d['errorCode'], 'CACHED_CREDENTIAL_REFRESH_REQUIRED')
        self.assertEqual(p.fake_session.calls, [])

    def test_transport_exception_counts_invocation_not_response_and_never_logs_text(self):
        import errno
        p = DiagnosticLiveProvider([ConnectionResetError(errno.ECONNRESET, 'SECRET_TOKEN_URL_BODY')])
        b = m.OwnerBridge(p)
        d = self.run_error(b, write_value(), 'REQUEST_OUTCOME_UNKNOWN')
        self.assertEqual((d['casHttpAttempts'], d['casHttpAcks']), (1, 0))
        self.assertEqual((d['errorType'], d['errorCode'], d['httpStatus']), ('ConnectionResetError', 'ECONNRESET', None))
        self.assertNotIn('SECRET', json.dumps(d))
        self.assertEqual(len(p.fake_session.calls), 1)
        options = p.fake_session.calls[0][2]
        self.assertEqual((options['timeout'], options['allow_redirects'], options['verify'], options['stream']), ((5, 15), False, True, True))

    def test_http_412_is_not_ack_or_retry(self):
        b = m.OwnerBridge(DiagnosticLiveProvider([(412, b'NO_PRIVATE_ERROR_BODY')]))
        self.assertEqual(b.dispatch(write_value())['status'], 412)
        d = b.safe_diagnostics.snapshot()
        self.assertEqual((d['casHttpAttempts'], d['casHttpAcks'], d['httpStatus'], d['errorType']), (1, 0, 412, None))
        self.run_error(b, write_value(), 'WRITE_ALREADY_ATTEMPTED')
        self.assertEqual(b.safe_diagnostics.snapshot()['casHttpAttempts'], 1)

    def test_new_generation_readbacks_are_separate_and_old_canary_reads_excluded(self):
        p = DiagnosticLiveProvider([(200, b'{"generation":"2"}'), (200, b'{}'), (200, b'{}'), (200, b'{}'), (200, b'SYNTHETIC_HTML')])
        b = m.OwnerBridge(p)
        b.dispatch(write_value())
        b.dispatch(read_value(LATEST+'?generation=1'))
        canary = {'op':'requestCanary','method':'GET','generation':'2','media':True}
        b.dispatch(canary)
        self.assertEqual(b.safe_diagnostics.snapshot()['readbackMetadataAttempts'], 0)
        b.dispatch(read_value(LATEST+'?generation=2'))
        b.dispatch(read_value(LATEST+'?alt=media&generation=2', headers={'Accept':'application/octet-stream','Accept-Encoding':'identity'}))
        d = b.safe_diagnostics.snapshot()
        self.assertEqual([d[k] for k in m.SAFE_COUNTERS], [1,1,1,1,1,1])
        self.assertEqual([call[0] for call in p.fake_session.calls], ['POST','GET','GET','GET','GET'])
        self.assertEqual((d['stage'], d['errorType']), ('readback-html', None))

    def test_ack_without_parseable_generation_does_not_invent_readback_pin(self):
        b = m.OwnerBridge(DiagnosticLiveProvider([(200, b'NOT_JSON'), (200, b'{}')]))
        result = b.dispatch(write_value())
        self.assertEqual(base64.b64decode(result['body']), b'NOT_JSON')
        b.dispatch(read_value(LATEST+'?generation=2'))
        d = b.safe_diagnostics.snapshot()
        self.assertEqual((d['casHttpAcks'], d['readbackMetadataAttempts']), (1,0))

    def test_same_rpc_old_and_canary_200_do_not_become_cas_timeout_status(self):
        value, revision, old, revision_hash, previous = ReplacementTests().fixture()
        p = DiagnosticLiveProvider()
        def send(method, url, **options):
            if method == 'POST':
                raise TimeoutError('SECRET_CAS_TIMEOUT')
            return previous.request(url, method, options['headers'], options['data'])
        p.fake_session.request = send
        b = m.OwnerBridge(p)
        with patch.object(m, 'replacement_registration', return_value=(revision,old,revision_hash)), patch.object(m,'replacement_canary_pin',return_value={'generation':'2','size':'23'}):
            d = self.run_error(b, value, 'REQUEST_OUTCOME_UNKNOWN')
        self.assertEqual([c[1] for c in previous.calls], ['HEAD','GET','GET','HEAD'])
        self.assertEqual((d['stage'],d['httpStatus'],d['casHttpAttempts'],d['casHttpAcks']), ('cas',None,1,0))

    def test_ack_survives_later_metadata_http_failure(self):
        p = DiagnosticLiveProvider([(200, b'{"generation":"2"}'), TimeoutError('SECRET')])
        b = m.OwnerBridge(p); b.dispatch(write_value())
        d = self.run_error(b, read_value(LATEST+'?generation=2'), 'REQUEST_OUTCOME_UNKNOWN')
        self.assertEqual([d[k] for k in m.SAFE_COUNTERS], [1,1,1,0,0,0])
        self.assertEqual((d['stage'], d['httpStatus']), ('readback-metadata', None))

    def test_html_2xx_is_only_http_success_not_body_or_hash_verification(self):
        def unreadable(url):
            response = Response(url)
            response.raw.read = lambda *_args, **_kwargs: (_ for _ in ()).throw(OSError('SECRET_BODY'))
            return response
        b = m.OwnerBridge(DiagnosticLiveProvider([(200,b'{"generation":"2"}'), unreadable]))
        b.dispatch(write_value())
        d = self.run_error(b, read_value(LATEST+'?generation=2&alt=media', headers={'Accept':'application/octet-stream','Accept-Encoding':'identity'}), 'REQUEST_OUTCOME_UNKNOWN')
        self.assertEqual((d['readbackHtmlAttempts'], d['readbackHtmlSuccesses'], d['httpStatus']), (1,1,200))
        self.assertNotIn('SECRET', json.dumps(d))

    def test_primary_and_response_close_failure_are_separate(self):
        import errno
        def wrong_url(url):
            response = Response(url+'?UNEXPECTED')
            response.close = lambda: (_ for _ in ()).throw(BrokenPipeError(errno.EPIPE, 'SECRET_CLOSE'))
            return response
        b = m.OwnerBridge(DiagnosticLiveProvider([wrong_url]))
        d = self.run_error(b, write_value(), 'REDIRECT_OR_URL_CHANGED')
        self.assertEqual(d['errorCode'], 'REDIRECT_OR_URL_CHANGED')
        cleanup = b.safe_diagnostics.cleanup
        self.assertEqual(len(cleanup), 1)
        self.assertEqual((cleanup[0]['stage'], cleanup[0]['errorCode']), ('close','EPIPE'))
        self.assertNotIn('SECRET', json.dumps([d,cleanup]))

    def test_no_primary_close_failure_retains_original_read_failure(self):
        def close_error(url):
            response = Response(url)
            response.close = lambda: (_ for _ in ()).throw(OSError('SECRET_CLOSE'))
            return response
        b = m.OwnerBridge(DiagnosticLiveProvider([close_error]))
        d = self.run_error(b, read_value(), 'READ_FAILED')
        self.assertEqual((d['stage'],d['errorType']), ('close','OSError'))

    def test_exception_codec_does_not_read_message_or_custom_properties(self):
        class Tainted(Exception):
            def __str__(self): raise AssertionError('MESSAGE_ACCESS')
            @property
            def code(self): raise AssertionError('CODE_ACCESS')
            @property
            def __cause__(self): raise AssertionError('CAUSE_ACCESS')
        d = m.SafeDiagnostics();d.error(Tainted('SECRET'))
        self.assertEqual((d.snapshot()['errorType'],d.snapshot()['errorCode'],d.snapshot()['causeCode']), (None,None,None))
        self.assertNotIn('SECRET',json.dumps(d.snapshot()))

    def test_rpc_success_and_error_frames_have_only_finite_diagnostics(self):
        class MainProvider(DiagnosticLiveProvider):
            pass
        inp = io.BytesIO((json.dumps({'id':1,'value':read_value()})+'\n'+json.dumps({'id':2,'value':{'op':'INVALID_SECRET'}})+'\n').encode())
        out = io.BytesIO()
        with patch.object(m,'LiveSdkProvider',MainProvider), patch.object(m.sys,'stdin',types.SimpleNamespace(buffer=inp)), patch.object(m.sys,'stdout',types.SimpleNamespace(buffer=out)):
            m.main()
        frames = [json.loads(x) for x in out.getvalue().splitlines()]
        self.assertEqual(set(frames[0]), {'id','result','safeDiagnostics','safeCleanupDiagnostics'})
        self.assertEqual(set(frames[1]), {'id','error','safeDiagnostics','safeCleanupDiagnostics'})
        self.assertEqual(frames[1]['error'],'OPERATION_INVALID')
        self.assertNotIn('SECRET', out.getvalue().decode())

    def test_python_and_node_share_exact_finite_enums(self):
        source = Path(__file__).with_name('owner_sdk_transport.mjs').read_text()
        for python_name, js_name in [('SAFE_DIAGNOSTIC_STAGES','OWNER_SAFE_DIAGNOSTIC_STAGES'),('SAFE_ERROR_TYPES','OWNER_SAFE_ERROR_TYPES'),('SAFE_ERROR_CODES','OWNER_SAFE_ERROR_CODES')]:
            import re
            text = re.search(r'export const '+js_name+r'=Object.freeze\((\[.*?\])\);',source).group(1)
            self.assertEqual(set(json.loads(text)), getattr(m,python_name))


class DailyBoundaryTests(unittest.TestCase):
    def fixture(self, book=False):
        date = m.daily_date()
        started = datetime.datetime.fromtimestamp(m.time.time()-60, datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
        completed = datetime.datetime.fromtimestamp(m.time.time()-10, datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
        report_name, receipt_name = 'delivery/'+date+'/report.html', 'delivery/'+date+'/receipt.json'
        report = b'<html>synthetic canonical report</html>'
        sources = []
        objects = {report_name: ('10', report), m.OBJECT: ('900', b'{}')}
        for i, key in enumerate(['ib.flexEod', 'sharesight.ibGroupedPerformance', 'sharesight.noahPerformance', 'ib.optionalLive']):
            name = 'report-check/'+started+'-00000000-0000-4000-8000-000000000000/'+key+'.json'
            raw = b'{"synthetic":true}'
            objects[name] = (str(i+1), raw)
            sources.append({'sourceKey': key, 'privateObject': name, 'generation': str(i+1), 'sha256': hashlib.sha256(raw).hexdigest()})
        receipt = {'mode': 'private_eod_action', 'status': 'partial', 'publication': 'none', 'dataDate': date,
                   'sourceDate': date, 'startedAt': started, 'completedAt': completed,
                   'artifact': {'privateObject': report_name, 'generation': '10', 'sha256': hashlib.sha256(report).hexdigest()},
                   'sourceCount': 4, 'sources': sources}
        if book:
            receipt.update(status='ready', calculationBasis='sharesight-book-user-synchronized.v1')
        receipt_raw = json.dumps(receipt).encode()
        objects[receipt_name] = ('11', receipt_raw)
        calls = []
        class DailyProvider(Provider):
            def request(self, url, method, headers, body):
                calls.append((url, method))
                if method == 'POST':
                    objects[m.OBJECT] = ('901', b'<html><body>synthetic preview only</body></html>')
                    return Response(url, body=b'{"generation":"901"}')
                if method == 'HEAD':
                    return Response(url, headers={'x-goog-generation': '900', 'content-length': '2'})
                parsed = m.urlsplit(url)
                name = m.unquote(parsed.path.rsplit('/', 1)[1])
                query = dict(m.parse_qsl(parsed.query))
                generation, raw = objects[name]
                if query.get('alt') == 'media':
                    return Response(url, body=raw, headers={'x-goog-generation': generation, 'content-length': str(len(raw))})
                metadata = {'bucket': m.BUCKET, 'name': name, 'generation': generation, 'metadata': {}}
                return Response(url, body=json.dumps(metadata).encode())
        bridge = m.OwnerBridge(DailyProvider())
        def read(name, generation=None, media=False):
            url = 'https://storage.googleapis.com/storage/v1/b/'+m.BUCKET+'/o/'+m.quote(name, safe='')
            if generation:
                url += '?generation='+generation+('&alt=media' if media else '')
            value = read_value(url, headers={'Accept': 'application/octet-stream' if media else 'application/json', 'Accept-Encoding': 'identity'})
            value['op'] = 'dailyRequest'
            return bridge.dispatch(value)
        def prime():
            for name, gen in [(report_name, '10'), (receipt_name, '11')]:
                read(name); read(name, gen, True)
            read(m.OBJECT)
        def write():
            value = write_value()
            raw = base64.b64decode(value['body'])
            boundary = value['headers']['Content-Type'].split('boundary=')[1]
            display = b'<html><body>synthetic preview only</body></html>'
            metadata = {'schema': 'xuan.owner-latest.v1', 'scope': 'ib-hk-classified-stocks__cash-ib-hk-noah-hk__orders-ib.v1',
                        'dataDate': date, 'sourceDate': date, 'financialStatus': 'complete' if book else 'partial',
                        'captureStartedAt': receipt['startedAt'], 'captureEndedAt': receipt['completedAt'], 'completedAt': receipt['completedAt'],
                        'artifactObject': report_name, 'artifactGeneration': '10', 'artifactSha256': hashlib.sha256(report).hexdigest(),
                        'receiptObject': receipt_name, 'receiptGeneration': '11', 'receiptSha256': hashlib.sha256(receipt_raw).hexdigest()}
            custom = {key: metadata[key] for key in ['artifactObject', 'artifactGeneration', 'artifactSha256', 'receiptObject', 'receiptGeneration', 'receiptSha256']}
            custom.update(bundleMetadata=json.dumps(metadata), displaySha256=hashlib.sha256(display).hexdigest())
            resource = {'name': m.OBJECT, 'contentType': 'text/html; charset=utf-8', 'contentDisposition': 'inline',
                        'cacheControl': 'private, no-store, max-age=0', 'metadata': custom}
            body = ('--'+boundary+'\r\nContent-Type: application/json; charset=utf-8\r\n\r\n'+json.dumps(resource)
                    +'\r\n--'+boundary+'\r\nContent-Type: text/html; charset=utf-8\r\n\r\n').encode()+display+('\r\n--'+boundary+'--\r\n').encode()
            value.update(op='dailyRequest', url=value['url'].replace('=0', '=900'), body=base64.b64encode(body).decode(),
                         admissionExpiresAt=int(m.time.time()*1000)+5000)
            return value
        return bridge, read, prime, write, objects, sources, calls

    def test_recovery_discovery_is_one_registered_metadata_path_without_unpinned_media(self):
        registration = m.recovery_registration()
        bridge, read, prime, write, objects, sources, calls = self.fixture()
        other = registration['receiptObject'].replace(registration['requestId'], '11111111-2222-4333-8444-555555555555')
        with patch.object(m, 'daily_date', lambda: registration['dataDate']):
            for name in [other, registration['receiptObject'].replace('preview-receipt.json', 'orders.json')]:
                with self.assertRaises(m.BoundaryError):
                    read(name)
            url = 'https://storage.googleapis.com/storage/v1/b/'+m.BUCKET+'/o/'+m.quote(registration['receiptObject'], safe='')+'?alt=media'
            value = read_value(url, headers={'Accept': 'application/octet-stream', 'Accept-Encoding': 'identity'})
            value['op'] = 'dailyRequest'
            with self.assertRaises(m.BoundaryError):
                bridge.dispatch(value)
        self.assertEqual(calls, [])

    def test_native_cas_freshness_is_checked_after_canary_and_never_retried(self):
        for change in ['expired', 'rollback']:
            bridge, read, prime, write, objects, sources, calls = self.fixture()
            prime()
            initial = m.time.time()
            clock = [initial]
            def canary(revision):
                clock[0] = initial + 1800 if change == 'expired' else initial - 0.1
            bridge.verify_replacement_canary_current = canary
            with patch.object(m.time, 'time', lambda: clock[0]):
                with self.assertRaises(m.BoundaryError):
                    bridge.dispatch(write())
                with self.assertRaises(m.BoundaryError):
                    bridge.dispatch(write())
            self.assertEqual(sum(method == 'POST' for _, method in calls), 0)

    def test_book_ready_cas_keeps_one_attempt_and_independent_generation_readback(self):
        bridge, read, prime, write, objects, sources, calls = self.fixture(book=True)
        prime()
        bridge.verify_replacement_canary_current = lambda revision: None
        self.assertEqual(bridge.dispatch(write())['status'], 200)
        read(m.OBJECT, '901')
        result = read(m.OBJECT, '901', True)
        self.assertEqual(base64.b64decode(result['body']), objects[m.OBJECT][1])
        with self.assertRaises(m.BoundaryError):
            bridge.dispatch(write())
        self.assertEqual(sum(method == 'POST' for _, method in calls), 1)

    def test_book_ready_receipt_keeps_original_source_pins_and_rejects_unrecognized_basis(self):
        bridge, read, prime, write, objects, sources, calls = self.fixture(book=True)
        prime()
        for source in sources:
            read(source['privateObject'], source['generation'], True)
        self.assertEqual(len(bridge.daily_receipts), 1)
        self.assertTrue(all(method == 'GET' for _, method in calls))
        for basis in [None, 'sync-verified']:
            bridge, read, prime, write, objects, sources, calls = self.fixture(book=True)
            name = 'delivery/'+m.daily_date()+'/receipt.json'
            gen, raw = objects[name]
            receipt = json.loads(raw)
            receipt['calculationBasis'] = basis
            objects[name] = (gen, json.dumps(receipt).encode())
            with self.assertRaises(m.BoundaryError):
                prime()
            self.assertEqual(sum(method == 'POST' for _, method in calls), 0)

    def test_store_discovery_sequence_uses_metadata_get_before_pinned_metadata_and_media(self):
        bridge, read, prime, write, objects, sources, calls = self.fixture()
        date = m.daily_date()
        for name, generation in [('delivery/'+date+'/report.html', '10'), ('delivery/'+date+'/receipt.json', '11')]:
            read(name)
            read(name, generation)
            read(name, generation, True)
        self.assertEqual(len(calls), 6)
        self.assertTrue(all(method == 'GET' for _, method in calls))
        self.assertEqual(set(bridge.daily_receipts), {'delivery/'+date+'/receipt.json'})
        self.assertTrue(all(bridge.daily_pins[s['privateObject']][0] == s['generation'] for s in sources))
        # Neither unpinned source media nor another date gains discovery rights.
        before = len(calls)
        for name in [sources[0]['privateObject'], 'delivery/1999-01-01/report.html']:
            with self.assertRaises(m.BoundaryError):
                read(name)
        self.assertEqual(len(calls), before)

    def test_receipt_controls_source_read_pins_and_invalid_reads_do_not_reach_provider(self):
        bridge, read, prime, write, objects, sources, calls = self.fixture()
        source = sources[0]
        with self.assertRaises(m.BoundaryError):
            read(source['privateObject'], source['generation'], True)
        self.assertEqual(calls, [])
        prime()
        read(source['privateObject'], source['generation'], True)
        before = len(calls)
        for name, gen in [('delivery/1999-01-01/receipt.json', None), (source['privateObject'], '999')]:
            with self.assertRaises(m.BoundaryError):
                read(name, gen, gen is not None)
        self.assertEqual(len(calls), before)
        gen, raw = objects[source['privateObject']]
        objects[source['privateObject']] = (gen, b'{"tampered":true}')
        with self.assertRaises(m.BoundaryError):
            read(source['privateObject'], gen, True)

    def test_daily_cas_requires_actual_receipt_then_consumes_one_attempt_and_checks_canary(self):
        bridge, read, prime, write, objects, sources, calls = self.fixture()
        with self.assertRaises(m.BoundaryError):
            bridge.dispatch(write())
        self.assertEqual(calls, [])
        with self.assertRaises(m.BoundaryError):
            bridge.dispatch(write())
        bridge, read, prime, write, objects, sources, calls = self.fixture()
        prime()
        checked = []
        bridge.verify_replacement_canary_current = lambda revision: checked.append(revision)
        result = bridge.dispatch(write())
        self.assertEqual(result['status'], 200)
        self.assertEqual(len(checked), 1)
        self.assertEqual(sum(method == 'POST' for _, method in calls), 1)
        # The accepted ACK must replace the old latest pin only for independent
        # reads of the actual new generation, preserving its observed byte hash.
        self.assertEqual(bridge.safe_diagnostics.new_generation, '901')
        read(m.OBJECT, '901')
        result = read(m.OBJECT, '901', True)
        self.assertEqual(base64.b64decode(result['body']), objects[m.OBJECT][1])
        self.assertEqual(bridge.daily_pins[m.OBJECT], ('901', hashlib.sha256(objects[m.OBJECT][1]).hexdigest()))
        with self.assertRaises(m.BoundaryError):
            bridge.dispatch(write())
        self.assertEqual(sum(method == 'POST' for _, method in calls), 1)



class EvidenceProvider(Provider):
    def __init__(self, existing=False, unknown=False):
        super().__init__(); self.existing=existing; self.unknown=unknown; self.objects={}
    def request(self,url,method,headers,body):
        self.calls.append((url,method,headers,body))
        if method == 'GET':
            name='report-check/orders-probe-'+m.recovery_registration()['requestId']+'/start.json'
            return Response(url,200 if self.existing else 404,json.dumps({'bucket':m.BUCKET,'name':name,'generation':'9'}).encode())
        assert url == UPLOAD and method == 'POST'
        if self.unknown: raise TimeoutError('synthetic uncertain write')
        boundary=headers['Content-Type'].split('boundary=')[1].encode()
        first,second=body.split(b'\r\n--'+boundary+b'\r\n')[0:2]
        resource=json.loads(first.split(b'\r\n\r\n',1)[1]);raw=second.split(b'\r\n\r\n',1)[1].split(b'\r\n--'+boundary+b'--')[0]
        assert resource['contentDisposition']=='attachment' and resource['cacheControl']=='private, no-store, max-age=0'
        assert resource['name'] not in self.objects
        self.objects[resource['name']]=raw
        result={'bucket':m.BUCKET,'name':resource['name'],'size':str(len(raw)),'generation':str(len(self.objects)),
                'md5Hash':base64.b64encode(hashlib.md5(raw).digest()).decode()}
        return Response(url,200,json.dumps(result).encode())

class BrowserEvidenceTests(unittest.TestCase):
    assertCode = BoundaryTests.assertCode
    def setUp(self):
        stamp=m.recovery_registration()['dataDate']+'T04:00:00.000Z'
        seconds=datetime.datetime.fromisoformat(stamp.replace('Z','+00:00')).timestamp()
        clock=patch.object(m.time,'time',return_value=seconds);clock.start();self.addCleanup(clock.stop)
        instant=patch.object(m,'instant',return_value=stamp);instant.start();self.addCleanup(instant.stop)
    def begin(self,provider=None):
        provider=provider or EvidenceProvider();b=m.OwnerBridge(provider)
        now=m.instant();reg=m.recovery_registration()
        with patch.object(m,'daily_date',return_value=reg['dataDate']):
            result=b.dispatch({'op':'beginEvidence','requestId':reg['requestId'],'captureStartedAt':now})
        return b,provider,result
    def write(self,b,name,value):
        raw=value.encode() if isinstance(value,str) else json.dumps(value).encode()
        return b.dispatch({'op':'writeEvidence','name':name,'body':base64.b64encode(raw).decode()})
    def test_evidence_exact_eight_creates_and_pins_close_after_completion(self):
        reg=m.recovery_registration()
        with patch.object(m,'daily_date',return_value=reg['dataDate']):
            b,p,a=self.begin();prefix=b.evidence['prefix'];sources=[]
            for key,value in [('ib.flexEod',{'status':'not-called','code':'FLEX_NOT_CALLED'}),
                ('sharesight.ibGroupedPerformance',{'sourceKey':'sharesight.ibGroupedPerformance','status':'date-verified','raw':{'source':'Sharesight authenticated cloud browser visible DOM'}}),
                ('sharesight.noahPerformance',{'sourceKey':'sharesight.noahPerformance','status':'date-verified','raw':{'source':'Sharesight authenticated cloud browser visible DOM'}}),
                ('ib.optionalLive',{'status':'not-called','code':'IB_MCP_ROUTES_UNAVAILABLE'})]:
                name=prefix+key+'.json';pin=self.write(b,name,value);sources.append(dict(sourceKey=key,privateObject=name,**pin))
            name=prefix+'report.html';pin=self.write(b,name,'<!doctype html><html>synthetic</html>')
            receipt={'mode':'private_eod_action','publication':'none','calculationBasis':'sharesight-book-user-synchronized.v1',
                'dataDate':reg['dataDate'],'startedAt':a['captureStartedAt'],'sourceCount':4,'sources':sources,'artifact':dict(privateObject=name,**pin)}
            self.write(b,prefix+'receipt.json',receipt);self.write(b,reg['receiptObject'],receipt)
            self.assertEqual(len(p.objects),8);self.assertLess(b.evidence['bytes'],32*1024*1024)
            self.assertEqual(b.safe_diagnostics.snapshot()['casHttpAttempts'],0)
            self.assertCode('REQUEST_INVALID',lambda:self.write(b,prefix+'report.html','again'))
    def test_three_account_sidecar_is_fixed_pinned_and_rejects_scope_drift(self):
        reg=m.recovery_registration(); stamp=m.instant()
        observed_day=(datetime.datetime.fromisoformat(stamp.replace('Z','+00:00'))+datetime.timedelta(hours=8)).date().isoformat()
        sources=[]
        for key,account,label in [('sharesight.ibGroupedPerformance',936247,'IB-HK'),('sharesight.schwabPerformance',936249,'Schwab-HK'),('sharesight.webullPerformance',1350094,'Webull')]:
            raw={'mode':'read_only','source':'Sharesight authenticated cloud browser visible DOM','observation':{'portfolio':label,'portfolioId':account,'valuationDate':observed_day,'retrievedAt':stamp}}
            text=json.dumps(raw)
            sources.append({'bytes':text,'receipt':{'sourceKey':key,'route':'authenticated-browser','status':'date-verified','sourceDate':observed_day,'startedAt':stamp,'completedAt':stamp,'bytes':len(text.encode()),'sha256':hashlib.sha256(text.encode()).hexdigest()}})
        payload={'cutoff':observed_day,'sources':sources}
        with patch.object(m,'daily_date',return_value=reg['dataDate']):
            b,p,a=self.begin(); b.evidence['registration']=dict(b.evidence['registration'],dataDate=observed_day)
            name=b.evidence['prefix']+'concentration.sources.json'
            pin=self.write(b,name,payload);self.assertEqual(pin['sha256'],hashlib.sha256(json.dumps(payload).encode()).hexdigest())
            self.assertEqual(len(p.objects),2)
            self.assertCode('WRITE_ALREADY_ATTEMPTED',lambda:self.write(b,name,payload))
            b,p,a=self.begin();b.evidence['registration']=dict(b.evidence['registration'],dataDate=observed_day)
            payload['sources'][2]['receipt']['sourceKey']='sharesight.noahPerformance';count=len(p.calls)
            self.assertCode('BODY_INVALID',lambda:self.write(b,b.evidence['prefix']+'concentration.sources.json',payload));self.assertEqual(len(p.calls),count)

    def test_evidence_claim_existing_and_uncertain_are_not_retried(self):
        for provider in [EvidenceProvider(existing=True),EvidenceProvider(unknown=True)]:
            reg=m.recovery_registration();b=m.OwnerBridge(provider);v={'op':'beginEvidence','requestId':reg['requestId'],'captureStartedAt':m.instant()}
            with patch.object(m,'daily_date',return_value=reg['dataDate']):
                with self.assertRaises(Exception): b.dispatch(v)
                calls=len(provider.calls)
                self.assertCode('REQUEST_INVALID',lambda:b.dispatch(v));self.assertEqual(len(provider.calls),calls)
    def test_evidence_forbidden_paths_body_duplicate_budget_clock_and_wrong_day_before_http(self):
        reg=m.recovery_registration()
        for change in ['path','body','duplicate','bytes','objects','rollback','expired','day']:
            with patch.object(m,'daily_date',return_value=reg['dataDate']):
                b,p,a=self.begin();name=b.evidence['prefix']+'ib.optionalLive.json';value={'status':'not-called','code':'IB_MCP_ROUTES_UNAVAILABLE'}
                if change=='path':name='delivery/owner-latest.html'
                if change=='body':value={'status':'captured','sources':[]}
                if change=='duplicate':self.write(b,name,value)
                if change=='bytes':b.evidence['bytes']=32*1024*1024
                if change=='objects':b.evidence['count']=10
                if change=='rollback':b.evidence['lastWall']=m.time.time()*1000+60000
                if change=='expired':b.evidence['monotonic']-=301
                calls=len(p.calls)
                with patch.object(m,'daily_date',return_value='1900-01-01' if change=='day' else reg['dataDate']):
                    with self.assertRaises(m.BoundaryError):self.write(b,name,value)
                self.assertEqual(len(p.calls),calls)

class SavedCaptureEvidenceTests(BrowserEvidenceTests):
    def test_saved_capture_delayed_processing_accepts_normal_orders_without_reread(self):
        reg=m.recovery_registration();now=m.time.time();stamp=lambda t: datetime.datetime.fromtimestamp(t,datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')
        start=stamp(now-900);end=stamp(now-720);p=EvidenceProvider();b=m.OwnerBridge(p)
        with patch.object(m,'daily_date',return_value=reg['dataDate']):
            a=b.dispatch({'op':'beginEvidence','requestId':reg['requestId'],'captureStartedAt':start,'captureCompletedAt':end})
            raw={'orders':[{'order_id':'synthetic-1'},{'order_id':'synthetic-2'}]}
            source={'sourceKey':'ib.orders','raw':raw,'rawFingerprint':'a'*64,'startedAt':start,'completedAt':end,
                'accountEvidence':{'associationBasis':'owner-attested','nativeIdentityEvidence':'not-provided','responseAccountEvidence':'not-provided'},
                'wrapper':'json-string','transportFingerprint':'b'*64}
            value={'status':'captured','sources':[source],'normalMcpEvidence':{'schema':'xuan.normal-mcp-orders.v1','requestId':reg['requestId'],'channel':'cloud-mcp'}}
            name=b.evidence['prefix']+'ib.optionalLive.json'
            for change in ['request','time','shape','transport']:
                bad=json.loads(json.dumps(value))
                if change=='request':bad['normalMcpEvidence']['requestId']='other'
                if change=='time':bad['sources'][0]['completedAt']=stamp(now)
                if change=='shape':bad['sources'].append(source)
                if change=='transport':bad['sources'][0]['wrapper']='unknown'
                count=len(p.calls);self.assertCode('BODY_INVALID',lambda:self.write(b,name,bad));self.assertEqual(len(p.calls),count)
            self.write(b,name,value);self.assertEqual(len(p.objects),2);self.assertEqual(a['captureCompletedAt'],end)
            b.evidence['monotonic']-=1801;count=len(p.calls)
            self.assertCode('REPLACEMENT_ADMISSION_EXPIRED',lambda:self.write(b,b.evidence['prefix']+'ib.flexEod.json',{'status':'not-called','code':'FLEX_NOT_CALLED'}));self.assertEqual(len(p.calls),count)
    def test_registered_reference_only_exact_times_extend_through_hkt_day(self):
        reg=m.recovery_registration();ref=reg['referenceCapture'];p=EvidenceProvider();b=m.OwnerBridge(p)
        expiry=datetime.datetime.fromisoformat(ref['expiresAt'].replace('Z','+00:00')).timestamp()
        value={'op':'beginEvidence','requestId':reg['requestId'],'captureStartedAt':ref['captureStartedAt'],'captureCompletedAt':ref['captureCompletedAt']}
        with patch.object(m,'daily_date',return_value=reg['dataDate']),patch.object(m.time,'time',return_value=expiry-60):
            b.dispatch(value);self.assertGreater(b.evidence['durationMs'],1800000)
            source={'sourceKey':'ib.orders','raw':{'orders':[]},'rawFingerprint':'0'*64,'startedAt':ref['captureStartedAt'],'completedAt':ref['captureCompletedAt'],
                'accountEvidence':{'associationBasis':'owner-attested','nativeIdentityEvidence':'not-provided','responseAccountEvidence':'not-provided'}}
            payload={'status':'captured','sources':[source],'normalMcpEvidence':{'schema':'xuan.normal-mcp-orders.v1','requestId':reg['requestId'],'channel':'cloud-mcp'}}
            count=len(p.calls);self.assertCode('BODY_INVALID',lambda:self.write(b,b.evidence['prefix']+'ib.optionalLive.json',payload));self.assertEqual(len(p.calls),count)
        p=EvidenceProvider();b=m.OwnerBridge(p)
        with patch.object(m,'daily_date',return_value=reg['dataDate']),patch.object(m.time,'time',return_value=expiry+0.001):
            self.assertCode('REQUEST_INVALID',lambda:b.dispatch(value));self.assertEqual(len(p.calls),0)

    def test_invalid_saved_capture_boundaries_before_http(self):
        reg=m.recovery_registration();now=m.time.time();stamp=lambda t: datetime.datetime.fromtimestamp(t,datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')
        for start,end in [(now-1801,now-1700),(now-900,now-599),(now-100,now+1),(now-100,now-101)]:
            p=EvidenceProvider();b=m.OwnerBridge(p)
            with patch.object(m,'daily_date',return_value=reg['dataDate']):
                self.assertCode('REQUEST_INVALID',lambda:b.dispatch({'op':'beginEvidence','requestId':reg['requestId'],'captureStartedAt':stamp(start),'captureCompletedAt':stamp(end)}))
                self.assertEqual(len(p.calls),0)


# Synthetic immutable storage: native continuation checks actual bytes, not ACK-only mocks.
class ContinuationProvider(EvidenceProvider):
    def __init__(self, records):
        super().__init__();self.records=records;self.extra_posts=[]
    def request(self,url,method,headers,body):
        if method=='GET':
            self.calls.append((url,method,headers,body));u=m.urlsplit(url);q=dict(m.parse_qsl(u.query));name=m.unquote(u.path.split('/o/',1)[1]);item=self.records.get(name)
            if item is None:return Response(url,404)
            raw,generation=item
            if q.get('generation',generation)!=generation:return Response(url,404)
            if q.get('alt')=='media':return Response(url,200,raw,{'Content-Type':'application/octet-stream','Content-Length':str(len(raw)),'X-Goog-Generation':generation})
            meta={'bucket':m.BUCKET,'name':name,'generation':generation,'size':str(len(raw)),'md5Hash':base64.b64encode(hashlib.md5(raw).digest()).decode(),'contentType':'text/html; charset=utf-8' if name.endswith('/report.html') else 'application/json; charset=utf-8','contentDisposition':'attachment','cacheControl':'private, no-store, max-age=0'}
            return Response(url,200,json.dumps(meta).encode())
        result=super().request(url,method,headers,body)
        name=list(self.objects)[-1]
        assert name not in self.records
        generation=json.loads(result.raw.getvalue())['generation'];self.records[name]=(self.objects[name],generation);self.extra_posts.append(name)
        return result

class ContinuationEvidenceTests(unittest.TestCase):
    assertCode=BoundaryTests.assertCode
    def setUp(self):
        end=m.recovery_registration()['referenceCapture']['captureCompletedAt']
        stamp=datetime.datetime.fromisoformat(end.replace('Z','+00:00'))+datetime.timedelta(seconds=60)
        clock=patch.object(m.time,'time',return_value=stamp.timestamp());clock.start();self.addCleanup(clock.stop)
        instant=patch.object(m,'instant',return_value=stamp.isoformat(timespec='milliseconds').replace('+00:00','Z'));instant.start();self.addCleanup(instant.stop)
    def fixture(self):
        reg=m.recovery_registration();ref=reg['referenceCapture'];c=dict(reg['continuation']);prefix='report-check/'+ref['captureStartedAt']+'-'+c['runId']+'/'
        claim={'schema':'xuan.browser-evidence-attempt.v1','requestId':reg['requestId'],'dataDate':reg['dataDate'],'captureStartedAt':ref['captureStartedAt'],'captureCompletedAt':ref['captureCompletedAt'],'runId':c['runId'],'createdAt':ref['captureCompletedAt'],'maximumObjects':10,'maximumBytes':33554432,'sourceMode':'sharesight-browser-with-optional-normal-orders'}
        records={'report-check/orders-probe-'+reg['requestId']+'/start.json':(json.dumps(claim).encode(),c['claimGeneration'])};pins=[]
        for i,old in enumerate(c['objects']):
            raw=b'<html>synthetic preserved artifact</html>' if old['name'].endswith('.html') else json.dumps({'synthetic':i}).encode();generation=str(i+20)
            records[old['name']]=(raw,generation);pins.append(dict(name=old['name'],generation=generation,sha256=hashlib.sha256(raw).hexdigest(),size=len(raw)))
        c['objects']=pins;reg=dict(reg,continuation=c)
        return reg,records,prefix
    def test_existing_six_pins_verified_then_only_three_creates_no_rewrite(self):
        reg,records,prefix=self.fixture();p=ContinuationProvider(records);b=m.OwnerBridge(p)
        with patch.object(m,'recovery_registration',return_value=reg),patch.object(m,'daily_date',return_value=reg['dataDate']):
            proof=b.dispatch({'op':'inspectEvidenceContinuation'});self.assertEqual(proof['existingObjects'],6);self.assertEqual(len(proof['pins']),6)
            self.assertEqual(p.extra_posts,[])
            resumed=b.dispatch({'op':'resumeEvidence','requestId':reg['requestId']});self.assertEqual(resumed['remainingObjects'],3);self.assertEqual(b.evidence['count'],6)
            self.assertCode('WRITE_ALREADY_ATTEMPTED',lambda:b.dispatch({'op':'writeEvidence','name':prefix+'report.html','body':base64.b64encode(b'overwrite').decode()}))
            self.assertCode('REQUEST_INVALID',lambda:b.dispatch({'op':'resumeEvidence','requestId':reg['requestId']}))
            sources=[];stamp=m.instant()
            for key,account,label in [('sharesight.ibGroupedPerformance',936247,'IB-HK'),('sharesight.schwabPerformance',936249,'Schwab-HK'),('sharesight.webullPerformance',1350094,'Webull')]:
                raw={'mode':'read_only','source':'Sharesight authenticated cloud browser visible DOM','observation':{'portfolio':label,'portfolioId':account,'valuationDate':reg['dataDate'],'retrievedAt':stamp}}
                text=json.dumps(raw);sources.append({'bytes':text,'receipt':{'sourceKey':key,'route':'authenticated-browser','status':'date-verified','sourceDate':reg['dataDate'],'startedAt':stamp,'completedAt':stamp,'bytes':len(text.encode()),'sha256':hashlib.sha256(text.encode()).hexdigest()}})
            sidecar={'cutoff':reg['dataDate'],'sources':sources}
            write=lambda name,payload:b.dispatch({'op':'writeEvidence','name':name,'body':base64.b64encode(json.dumps(payload).encode()).decode()})
            sidecar_pin=write(prefix+'concentration.sources.json',sidecar)
            receipt={'mode':'private_eod_action','publication':'none','calculationBasis':'sharesight-book-user-synchronized.v1','dataDate':reg['dataDate'],'startedAt':reg['referenceCapture']['captureStartedAt'],'completedAt':stamp,'captureCompletedAt':reg['referenceCapture']['captureCompletedAt'],'dateBasis':'sharesight-valuation-date.v1','referenceMode':'xuan.registered-reference-capture.v1','sourceCount':4,
                     'sources':[dict(sourceKey=x['name'].rsplit('/',1)[1][:-5],privateObject=x['name'],generation=x['generation'],sha256=x['sha256']) for x in reg['continuation']['objects'][:4]],
                     'artifact':dict(privateObject=prefix+'report.html',**b.evidence['written'][prefix+'report.html']),
                     'concentration':dict(privateObject=prefix+'concentration.sources.json',modelSha256='a'*64,**sidecar_pin)}
            write(prefix+'receipt.json',receipt);write(reg['receiptObject'],receipt)
            self.assertEqual(len(p.extra_posts),3);self.assertEqual(b.evidence['count'],9)
            self.assertCode('WRITE_ALREADY_ATTEMPTED',lambda:b.evidence_upload(prefix+'extra.json',b'{}','application/json; charset=utf-8'))
            self.assertEqual(b.safe_diagnostics.snapshot()['casHttpAttempts'],0)
    def test_changed_version_hash_claim_or_existing_remaining_object_stops_without_post(self):
        for kind in ['hash','generation','claim','already-written','missing']:
            reg,records,prefix=self.fixture();p=ContinuationProvider(records);b=m.OwnerBridge(p)
            name=reg['continuation']['objects'][0]['name'];raw,generation=records[name]
            if kind=='hash':records[name]=(b'changed',generation)
            if kind=='generation':records[name]=(raw,'999')
            if kind=='missing':del records[name]
            if kind=='claim':
                key='report-check/orders-probe-'+reg['requestId']+'/start.json';v,g=records[key];obj=json.loads(v);obj['runId']='11111111-2222-4333-8444-555555555555';records[key]=(json.dumps(obj).encode(),g)
            if kind=='already-written':records[prefix+'concentration.sources.json']=(b'{}','999')
            with patch.object(m,'recovery_registration',return_value=reg),patch.object(m,'daily_date',return_value=reg['dataDate']):
                with self.assertRaises(m.BoundaryError):
                    b.dispatch({'op':'inspectEvidenceContinuation'});b.dispatch({'op':'resumeEvidence','requestId':reg['requestId']})
            self.assertEqual(p.extra_posts,[])
    def test_inspection_expiry_clock_reverse_and_wrong_request_do_not_reset_claim(self):
        for kind in ['expired','backwards','wrong-request']:
            reg,records,prefix=self.fixture();p=ContinuationProvider(records);b=m.OwnerBridge(p)
            with patch.object(m,'recovery_registration',return_value=reg),patch.object(m,'daily_date',return_value=reg['dataDate']):
                b.dispatch({'op':'inspectEvidenceContinuation'})
                if kind=='expired':b.continuation_observation['wall']-=61000
                if kind=='backwards':b.continuation_observation['wall']+=1e6
                with self.assertRaises(m.BoundaryError):b.dispatch({'op':'resumeEvidence','requestId':'wrong' if kind=='wrong-request' else reg['requestId']})
            self.assertEqual(p.extra_posts,[])

if __name__ == '__main__':
    unittest.main()
