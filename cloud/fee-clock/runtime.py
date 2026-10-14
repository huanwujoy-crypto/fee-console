"""Fixed-scope HTTP adapters, used only in an explicitly enabled approved job."""
from datetime import datetime, timezone
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from clock import ClockError, REPO, WORKFLOW, fail, run_clock

API = 'https://api.github.com/repos/' + REPO
BUCKET = 'family-portfolio-gateway-fee-clock'
TOKEN_PATH = '/secrets/github/token'
LIMIT = 2_000_000


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Http:
    def __init__(self, opener=None):
        self.opener = opener or urllib.request.build_opener(NoRedirect())

    def request(self, url, method='GET', body=None, headers=None, uncertain=False):
        request = urllib.request.Request(url, data=None if body is None else json.dumps(body, separators=(',', ':')).encode(),
                                         headers=headers or {}, method=method)
        try:
            with self.opener.open(request, timeout=10) as response:
                if 'rel="next"' in response.headers.get('Link', ''):
                    fail('LIST_INCOMPLETE')
                raw = response.read(LIMIT + 1)
                if len(raw) > LIMIT:
                    fail('RESPONSE_TOO_LARGE')
                value = None if not raw else json.loads(raw)
                return response.status, value
        except urllib.error.HTTPError as error:
            status = error.code
            error.close()
            return status, None  # Never log error bodies or auth headers.
        except ClockError:
            if uncertain:
                fail('DISPATCH_UNCERTAIN')
            raise
        except Exception:
            fail('DISPATCH_UNCERTAIN' if uncertain else 'NETWORK_OR_RESPONSE')


class Github:
    def __init__(self, http=None, read_token=None):
        self.http = http or Http()
        self.read_token = read_token or self._read_token

    @staticmethod
    def _read_token():
        # Future Cloud Run secret mount. No CLI token, local Keychain, or old
        # contents-write credential is accepted by this adapter.
        try:
            with open(TOKEN_PATH, encoding='utf8') as source:
                value = source.read(16_385).strip()
        except Exception:
            fail('CREDENTIAL_UNAVAILABLE')
        if not re.fullmatch(r'[A-Za-z0-9_~.+=/-]{20,16384}', value):
            fail('CREDENTIAL_INVALID')
        return value

    def _get(self, suffix):
        status, value = self.http.request(API + suffix, headers={
            'Accept': 'application/vnd.github+json', 'User-Agent': 'fee-console-independent-clock',
            'X-GitHub-Api-Version': '2026-03-10'})
        if status != 200:
            fail('READ_HTTP_' + str(status))
        if not isinstance(value, dict):
            fail('METADATA_INVALID')
        return value

    def workflow(self):
        return self._get('/actions/workflows/' + WORKFLOW)

    def main(self):
        return self._get('/git/ref/heads/main')

    def runs(self, created=None, status=None):
        query = {'branch': 'main', 'per_page': '100'}
        if created is not None and status is None and re.fullmatch(r'\d{4}-\d{2}-\d{2}T16:00:00Z\.\.\d{4}-\d{2}-\d{2}T15:59:59Z', created):
            query['created'] = created
        elif status in ('queued', 'in_progress', 'waiting', 'pending', 'requested') and created is None:
            query['status'] = status
        else:
            fail('SCOPE')
        return self._get('/actions/workflows/' + WORKFLOW + '/runs?' + urllib.parse.urlencode(query))

    def jobs(self, run_id):
        if type(run_id) is not int or run_id <= 0:
            fail('SCOPE')
        return self._get(f'/actions/runs/{run_id}/jobs?filter=latest&per_page=100')

    def dispatch(self):
        status, value = self.http.request(API + '/actions/workflows/' + WORKFLOW + '/dispatches', method='POST',
            body={'ref': 'main', 'inputs': {'apply_style_proposal': False}}, uncertain=True,
            headers={'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json',
                     'User-Agent': 'fee-console-independent-clock', 'X-GitHub-Api-Version': '2026-03-10',
                     'Authorization': 'Bearer ' + self.read_token()})
        if status == 204:  # Legacy API accepted; check-start still proves start.
            return None
        if status == 200 and isinstance(value, dict):
            run_id = value.get('workflow_run_id')
            if (type(run_id) is int and run_id > 0
                    and value.get('run_url') == f'{API}/actions/runs/{run_id}'
                    and value.get('html_url') == f'https://github.com/{REPO}/actions/runs/{run_id}'):
                return run_id
        if status in (408, 429, 499) or status >= 500 or status in (200, 201, 202):
            fail('DISPATCH_UNCERTAIN')
        fail('DISPATCH_HTTP_' + str(status))


class Store:
    def __init__(self, http=None):
        self.http = http or Http()
        self._bearer = None

    def _headers(self):
        if self._bearer is None:
            status, value = self.http.request(
                'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
                headers={'Metadata-Flavor': 'Google'})
            if status != 200 or not isinstance(value, dict) or not re.fullmatch(r'[^\s]{20,16384}', value.get('access_token', '')):
                fail('RUNTIME_IDENTITY')
            self._bearer = value['access_token']
        return {'Authorization': 'Bearer ' + self._bearer, 'Content-Type': 'application/json'}

    @staticmethod
    def _object(target, kind):
        if not re.fullmatch(r'\d{4}-\d{2}-\d{2}', target or '') or kind not in ('intent', 'result'):
            fail('SCOPE')
        return 'v1/' + kind + '/' + target + '.json'

    def read_intent(self, target):
        name = urllib.parse.quote(self._object(target, 'intent'), safe='')
        status, value = self.http.request(f'https://storage.googleapis.com/storage/v1/b/{BUCKET}/o/{name}?alt=media', headers=self._headers())
        if status == 404:
            return None
        if status != 200:
            fail('INTENT_READ_HTTP_' + str(status))
        return value

    def _create(self, value, kind):
        query = urllib.parse.urlencode({'uploadType': 'media', 'name': self._object(value.get('targetDate'), kind), 'ifGenerationMatch': 0})
        status, _ = self.http.request(f'https://storage.googleapis.com/upload/storage/v1/b/{BUCKET}/o?{query}',
                                      method='POST', body=value, headers=self._headers())
        if status == 412:
            return False
        if status not in (200, 201):
            fail('INTENT_WRITE_HTTP_' + str(status))
        return True

    def claim(self, value):
        return self._create(value, 'intent')

    def result(self, value):
        if not self._create(value, 'result'):
            fail('RESULT_ALREADY_EXISTS')


def main():
    try:
        if len(sys.argv) != 2:
            fail('MODE')
        value = run_clock(sys.argv[1], datetime.now(timezone.utc), Github(), Store(),
                          enabled=os.environ.get('FEE_CLOCK_ENABLED') == 'true',
                          current_time=lambda: datetime.now(timezone.utc))
        print(json.dumps(value, separators=(',', ':')))
        return 0
    except Exception as error:
        code = error.code if isinstance(error, ClockError) else 'FEE_CLOCK_FAILED'
        print(json.dumps({'event': 'FEE_CLOCK_ALERT', 'code': code, 'severity': 'ERROR'}, separators=(',', ':')))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
