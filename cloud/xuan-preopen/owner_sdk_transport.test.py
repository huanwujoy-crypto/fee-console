"""Synthetic only: no live credential store, SDK calls or network."""
import base64
import datetime
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
            'headers': {'Content-Type': 'multipart/related; boundary=' + boundary, 'Accept': 'application/json'},
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


if __name__ == '__main__':
    unittest.main()
