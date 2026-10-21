"""Offline pipe fixture: real OwnerBridge, fake provider. No SDK import or auth.

Every provider operation goes back to the test's in-memory GCS implementation.
The existing canary proof is a test dependency; its native tests cover IAM/UI.
"""
import base64
import importlib.util
import io
import json
from pathlib import Path
import socket
import sys

socket.create_connection = lambda *a, **k: (_ for _ in ()).throw(AssertionError('NO_NETWORK'))
spec = importlib.util.spec_from_file_location('transport', Path(__file__).with_name('owner_sdk_transport.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


def send(value):
    print(json.dumps(value), flush=True)


setup = json.loads(sys.stdin.readline())
m.time.time = lambda: setup['now']/1000
m.daily_date = lambda: setup['dataDate']
# Only this synthetic fixture replaces the prior receipt hash. Production uses
# the protected immutable registration, never a caller-provided registration.
registration = m.recovery_registration()
registration.update(setup['priorPin'])
m.recovery_registration = lambda: registration


class Provider:
    def request(self, url, method, headers, body):
        send({'kind': 'fetch', 'url': url, 'method': method, 'headers': headers,
              'body': base64.b64encode(body).decode() if body is not None else None})
        value = json.loads(sys.stdin.readline())
        response = type('Response', (), {})()
        response.url, response.status_code, response.headers = url, value['status'], value['headers']
        response.history = []
        response.raw = io.BytesIO(base64.b64decode(value['body']))
        read = response.raw.read
        response.raw.read = lambda size, decode_content=False: read(size)
        response.close = lambda: None
        return response

    def close(self):
        pass


bridge = m.OwnerBridge(Provider())
canary_checks = []
bridge.verify_replacement_canary_current = lambda revision: canary_checks.append(revision)
for line in sys.stdin:
    request = json.loads(line)
    if request.get('close'):
        send({'kind': 'closed', 'canaryChecks': len(canary_checks)})
        break
    try:
        result = bridge.dispatch(request)
        send({'kind': 'result', 'result': result})
    except Exception as error:
        send({'kind': 'error', 'code': getattr(error, 'code', type(error).__name__)})
