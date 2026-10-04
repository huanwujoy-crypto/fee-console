"""Bounded fixed-GET retries; error text, URLs and payloads never enter diagnostics."""
import errno
import http.client
import socket
import ssl
import time
import urllib.error


class SourceError(Exception):
    def __init__(self, code, *, network=None):
        super().__init__(code)
        self.network = network


OPERATIONS = {'ib_send_request', 'ib_get_statement', 'gateway_portfolios',
              'gateway_performance', 'quotes_cspx', 'quotes_exus', 'quotes_eimi', 'quotes_ussc'}
TRANSIENT_HTTP = {408, 429, 500, 502, 503, 504}
TRANSIENT_ERRNO = {errno.ECONNRESET, errno.ECONNREFUSED, errno.ETIMEDOUT,
                   errno.ENETUNREACH, errno.EHOSTUNREACH, errno.EPIPE}


def classify(error):
    if isinstance(error, urllib.error.HTTPError):
        return 'http', error.code in TRANSIENT_HTTP, error.code
    reason = error.reason if isinstance(error, urllib.error.URLError) else error
    if isinstance(reason, ssl.SSLError):
        return 'tls', False, None
    if isinstance(reason, (TimeoutError, socket.timeout)):
        return 'timeout', True, None
    if isinstance(reason, socket.gaierror):
        return 'dns', reason.errno == socket.EAI_AGAIN, None
    if isinstance(reason, (ConnectionError, http.client.RemoteDisconnected, http.client.IncompleteRead)):
        return 'connection', True, None
    if isinstance(reason, OSError) and reason.errno in TRANSIENT_ERRNO:
        return 'connection', True, None
    return 'other', False, None


def read_get(opener, request, *, operation, code, deadline, max_bytes, request_timeout=30):
    """At most three attempts, within one caller-owned monotonic deadline.

    Callers supply only fixed GETs. Retry the same IB statement reference rather
    than restarting the report. XML/JSON parsing and validation happen outside.
    """
    if operation not in OPERATIONS:
        raise ValueError('invalid_network_operation')
    if getattr(request, 'get_method', lambda: 'GET')() != 'GET':
        raise ValueError('non_get_retry_forbidden')
    for attempt in range(1, 4):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise SourceError(code, network={'operation': operation, 'category': 'deadline',
                                            'attempts': attempt - 1, 'retryable': True})
        try:
            with opener.open(request, timeout=min(request_timeout, remaining)) as response:
                return response.read(max_bytes + 1)
        except Exception as error:
            category, retryable, status = classify(error)
            detail = {'operation': operation, 'category': category,
                      'attempts': attempt, 'retryable': retryable}
            if status is not None:
                detail['httpStatus'] = status
            # Never stringify error/reason, headers, URLs, tokens or response bodies.
            if isinstance(error, urllib.error.HTTPError):
                error.close()
            delay = attempt * 2
            if not retryable or attempt == 3 or time.monotonic() + delay >= deadline:
                raise SourceError(code, network=detail) from None
            time.sleep(delay)
