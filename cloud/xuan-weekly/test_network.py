import io
import json
import socket
import ssl
import urllib.error
import urllib.request
import unittest
from unittest.mock import MagicMock, patch

from network import SourceError, read_get
from ib_source import fetch


class NetworkTests(unittest.TestCase):
    def setUp(self):
        self.opener = MagicMock()
        self.opener.open.return_value.__enter__.return_value.read.return_value = b'good'
        self.clock = 0
        self.monotonic = patch('network.time.monotonic', side_effect=lambda: self.clock)
        self.sleep = patch('network.time.sleep', side_effect=self.advance)
        self.monotonic.start(); self.sleep.start()
        self.addCleanup(self.monotonic.stop); self.addCleanup(self.sleep.stop)

    def advance(self, seconds):
        self.clock += seconds

    def read(self, **kwargs):
        return read_get(self.opener, 'https://example.invalid/?token=DO_NOT_LOG',
                        operation='ib_get_statement', code='ib_network_error',
                        deadline=kwargs.get('deadline', 150), max_bytes=100)

    def http(self, status):
        return urllib.error.HTTPError('https://example.invalid/?token=DO_NOT_LOG',
                                      status, 'DO_NOT_LOG', {}, io.BytesIO(b'DO_NOT_LOG'))

    def test_transient_then_success_same_get(self):
        response = self.opener.open.return_value
        self.opener.open.side_effect = [TimeoutError('DO_NOT_LOG'), response]
        self.assertEqual(self.read(), b'good')
        self.assertEqual(self.opener.open.call_count, 2)
        self.assertEqual(self.clock, 2)
        self.assertEqual(self.opener.open.call_args_list[0].args, self.opener.open.call_args_list[1].args)

    def test_transient_http_recovery(self):
        for status in (408, 429, 500, 502, 503, 504):
            with self.subTest(status=status):
                self.opener.open.reset_mock()
                self.opener.open.side_effect = [self.http(status), self.opener.open.return_value]
                self.assertEqual(self.read(), b'good')
                self.assertEqual(self.opener.open.call_count, 2)

    def test_exhaustion_has_safe_diagnostic(self):
        self.opener.open.side_effect = urllib.error.URLError(TimeoutError('DO_NOT_LOG'))
        with self.assertRaises(SourceError) as caught:self.read()
        self.assertEqual(self.opener.open.call_count, 3)
        self.assertEqual(caught.exception.network, {'operation':'ib_get_statement',
                          'category':'timeout','attempts':3,'retryable':True})
        self.assertNotIn('DO_NOT_LOG', json.dumps(caught.exception.network)+str(caught.exception))

    def test_auth_redirect_and_certificate_do_not_retry(self):
        for error in (self.http(401), self.http(403), self.http(302), self.http(404),
                      urllib.error.URLError(ssl.SSLCertVerificationError('DO_NOT_LOG')),
                      urllib.error.URLError('unclassified DO_NOT_LOG'),
                      socket.gaierror(socket.EAI_NONAME, 'DO_NOT_LOG')):
            with self.subTest(error=type(error).__name__):
                self.opener.open.reset_mock(); self.opener.open.side_effect = error
                with self.assertRaises(SourceError) as caught:self.read()
                self.assertEqual(self.opener.open.call_count, 1)
                self.assertFalse(caught.exception.network['retryable'])
                self.assertNotIn('DO_NOT_LOG',json.dumps(caught.exception.network))

    def test_deadline_bounds_sleep_and_request_timeout(self):
        self.opener.open.side_effect = TimeoutError()
        with self.assertRaises(SourceError):self.read(deadline=1)
        self.assertEqual(self.opener.open.call_count, 1)
        self.assertEqual(self.opener.open.call_args.kwargs['timeout'], 1)
        self.assertEqual(self.clock, 0)
        with self.assertRaises(SourceError):self.read(deadline=0)
        self.assertEqual(self.opener.open.call_count, 1)

    def test_non_get_cannot_enter_retry(self):
        with self.assertRaises(ValueError):
            read_get(self.opener,urllib.request.Request('https://example.invalid',data=b'x'),
                     operation='ib_get_statement',code='ib_network_error',deadline=10,max_bytes=100)
        self.opener.open.assert_not_called()

    def test_temporary_dns_and_interrupted_body_retry(self):
        response = self.opener.open.return_value
        self.opener.open.side_effect = [socket.gaierror(socket.EAI_AGAIN, 'DO_NOT_LOG'), response]
        self.assertEqual(self.read(),b'good')
        self.opener.open.side_effect = None
        self.opener.open.reset_mock()
        response.__enter__.return_value.read.side_effect = [ConnectionResetError('DO_NOT_LOG'),b'good']
        self.assertEqual(self.read(),b'good')
        self.assertEqual(self.opener.open.call_count,2)

    @patch('ib_source.urllib.request.build_opener')
    def test_ib_poll_retry_keeps_reference_and_rejects_bad_xml(self, build):
        build.return_value = self.opener
        def response(body):
            r=MagicMock();r.__enter__.return_value.read.return_value=body;return r
        self.opener.open.side_effect = [response(b'<FlexStatementResponse><Status>Success</Status>'
                         b'<ReferenceCode>123</ReferenceCode></FlexStatementResponse>'),
                         TimeoutError('DO_NOT_LOG'), response(b'<FlexQueryResponse/>')]
        self.assertEqual(fetch('SYNTHETIC_TOKEN'),b'<FlexQueryResponse/>')
        urls=[c.args[0] for c in self.opener.open.call_args_list]
        self.assertEqual(urls[1],urls[2]); self.assertIn('q=123',urls[1])
        self.assertEqual(sum('SendRequest' in u for u in urls),1)
        self.opener.open.reset_mock();self.opener.open.side_effect=[response(b'not XML')]
        with self.assertRaisesRegex(SourceError,'invalid_xml'):fetch('SYNTHETIC_TOKEN')
        self.assertEqual(self.opener.open.call_count,1)


if __name__ == '__main__':unittest.main()
