"""Fixed IB snapshot job + pinned private receipt. No Secret payload access.

The separate IB job uses the original source identity and snapshot CLI. This
worker cannot update that job, change IAM, or invoke the action orders job.
"""
from datetime import datetime, timedelta, timezone
import hashlib
import json
import re
import time
from zoneinfo import ZoneInfo

from .ib_daily import SourceOutcomeUnknown
from .ib_snapshot import IBSnapshotError, _instant
from .ib_snapshot_adapter import normalize_mcp_capture

PROJECT = 'family-portfolio-gateway'
JOB = 'projects/' + PROJECT + '/locations/asia-east2/jobs/ib-daily-snapshot'
BUCKET = PROJECT + '-xuan-preopen-private'
SECRET = 'projects/' + PROJECT + '/secrets/xuan-preopen-ib-mcp'
CONTRACT = '475bef6cf463c7b11cb94a48c9a5aca66f8aa972d8221f0000c480a84444f22d'


def require(ok, code):
    if not ok:
        raise IBSnapshotError(code)


def unique_json(raw):
    def pairs(items):
        value = {}
        for k, v in items:
            require(k not in value, 'IB_DAILY_DUPLICATE_JSON_KEY')
            value[k] = v
        return value
    return json.loads(raw, object_pairs_hook=pairs)


class CloudSource:
    def __init__(self, config, *, session=None, storage=None, now=None, sleeper=time.sleep, monotonic=time.monotonic):
        self.config, self.session, self.storage = config, session, storage
        self.now = now or (lambda: datetime.now(timezone.utc))
        self.sleep = sleeper
        self.monotonic = monotonic
        self.dispatched = False

    def _clients(self):
        if self.session is None:
            import google.auth
            from google.auth.transport.requests import AuthorizedSession
            credentials, _ = google.auth.default(scopes=['https://www.googleapis.com/auth/cloud-platform'])
            # Never transparently re-send the run POST after an HTTP 401.
            self.session = AuthorizedSession(credentials, max_refresh_attempts=0)
        if self.storage is None:
            from google.cloud import storage
            self.storage = storage.Client(project=PROJECT)

    def _json(self, method, url, body=None, *, stage):
        try:
            response = self.session.request(method, url, json=body, timeout=10, allow_redirects=False)
        except Exception:
            raise IBSnapshotError('IB_DAILY_' + stage + '_TRANSPORT_UNAVAILABLE') from None
        # Keep the status, never the response body, URL, headers or exception text.
        require(response.status_code == 200, 'IB_DAILY_' + stage + '_HTTP_' + str(response.status_code))
        require(len(response.content) <= 512 * 1024, 'IB_DAILY_CONTROL_RESPONSE_TOO_LARGE')
        try:
            return unique_json(response.content)
        except (ValueError, TypeError):
            raise IBSnapshotError('IB_DAILY_' + stage + '_RESPONSE_INVALID') from None

    def _object(self, name, *, generation=None, maximum=9 * 1024 * 1024, stage='SNAPSHOT'):
        try:
            blob = self.storage.bucket(BUCKET).blob(name, generation=generation)
            blob.reload(retry=None, timeout=10)
            require(0 < int(blob.size) <= maximum, 'IB_DAILY_PRIVATE_OBJECT_SIZE_INVALID')
            pinned = int(blob.generation)
            if generation is not None:
                require(pinned == int(generation), 'IB_DAILY_OBJECT_GENERATION_CHANGED')
            return blob.download_as_bytes(if_generation_match=pinned, retry=None, timeout=10)
        except IBSnapshotError:
            raise
        except Exception as exc:
            status = getattr(exc, 'code', None)
            code = ('HTTP_' + str(int(status)) if isinstance(status, int) and 100 <= status <= 599
                    else 'TRANSPORT_UNAVAILABLE')
            raise IBSnapshotError('IB_DAILY_' + stage + '_' + code) from None

    def _receipt(self, name, deadline):
        # A RunJob response acknowledges dispatch, not completion. The source
        # writes this immutable terminal receipt after saving its snapshot.
        # Only a missing receipt is pending; denial/transport/invalid data stop.
        missing = False
        for attempt in range(31):
            if self.monotonic() >= deadline:
                break
            try:
                return unique_json(self._object(name, maximum=128 * 1024, stage='RECEIPT'))
            except IBSnapshotError as exc:
                if str(exc) != 'IB_DAILY_RECEIPT_HTTP_404':
                    raise
                missing = True
            if attempt < 30:
                self.sleep(min(3, max(0, deadline - self.monotonic())))
        raise SourceOutcomeUnknown('IB_DAILY_RECEIPT_TIMEOUT' + ('_HTTP_404' if missing else ''))

    def capture(self, target, slot, request_id):
        deadline = self.monotonic() + 120
        self._clients()
        job = self._json('GET', 'https://run.googleapis.com/v2/' + JOB, stage='JOB')
        template = job.get('template', {})
        task = template.get('template', {})
        containers = task.get('containers', [])
        require(job.get('name') == JOB and template.get('taskCount') == 1
                and template.get('parallelism') == 1 and len(containers) == 1
                and task.get('serviceAccount') == self.config['source_service_account']
                and task.get('timeout') == '75s' and task.get('maxRetries', 0) == 0,
                'IB_DAILY_SOURCE_JOB_DRIFT')
        container = containers[0]
        require(container.get('image') == self.config['source_image']
                and container.get('command') == ['node', 'cloud/xuan-preopen/ib_sync_snapshot.mjs']
                and container.get('args', []) == [], 'IB_DAILY_SOURCE_JOB_DRIFT')
        # Metadata only, never :access. The source job alone consumes the value.
        version = self._json('GET', 'https://secretmanager.googleapis.com/v1/' + SECRET + '/versions/latest', stage='VERSION')
        match = re.fullmatch(r'projects/(?:family-portfolio-gateway|860729177589)/secrets/xuan-preopen-ib-mcp/versions/([1-9]\d*)', version.get('name', ''))
        require(match is not None and version.get('state') == 'ENABLED', 'IB_DAILY_CREDENTIAL_VERSION_UNAVAILABLE')
        began = self.now()
        request = {'requestId': request_id, 'dataDate': began.astimezone(ZoneInfo('Asia/Hong_Kong')).date().isoformat(),
                   'expiresAt': (began + timedelta(minutes=10)).isoformat(timespec='milliseconds').replace('+00:00', 'Z'),
                   'credentialBinding': {'clientId': self.config['client_id'], 'version': match.group(1)}}
        require(not self.dispatched, 'IB_DAILY_SOURCE_ALREADY_DISPATCHED')
        self.dispatched = True  # before POST: uncertain outcome never re-dispatched
        try:
            operation = self._json('POST', 'https://run.googleapis.com/v2/' + JOB + ':run', {
                'etag': job['etag'], 'overrides': {'containerOverrides': [
                    {'args': ['--ib-sync-snapshot-request', json.dumps(request, separators=(',', ':'))]}]}}, stage='RUN')
            operation_name = operation.get('name', '')
            require(re.fullmatch(r'projects/(?:family-portfolio-gateway|860729177589)/locations/asia-east2/operations/[A-Za-z0-9_-]+', operation_name) is not None,
                    'IB_DAILY_OPERATION_INVALID')
            require('error' not in operation, 'IB_DAILY_SOURCE_EXECUTION_FAILED')
            # Bind to the execution returned by this POST. Do not depend on a
            # regional operation GET or infer success from HTTP 200/done alone.
            execution = operation.get('metadata', {}).get('name', '')
            require(re.fullmatch(r'projects/(?:family-portfolio-gateway|860729177589)/locations/asia-east2/jobs/ib-daily-snapshot/executions/ib-daily-snapshot-[a-z0-9-]+', execution) is not None,
                    'IB_DAILY_EXECUTION_BINDING_UNAVAILABLE')
            prefix = 'report-check/ib-sync-' + request_id + '/'
            receipt = self._receipt(prefix + 'receipt.json', deadline)
            require(receipt.get('execution') == execution.rsplit('/', 1)[-1]
                    and receipt.get('requestId') == request_id, 'IB_DAILY_RECEIPT_MISMATCH')
            if receipt.get('status') in {'failed', 'incomplete'}:
                # Confirmed terminal receipt permits only the other daily slot.
                raise IBSnapshotError('IB_DAILY_SOURCE_TERMINAL_FAILURE')
            require(receipt.get('status') == 'passed', 'IB_DAILY_RECEIPT_MISMATCH')
            artifact = receipt.get('artifact', {})
            require(artifact.get('privateObject') == prefix + 'snapshot.json'
                    and re.fullmatch(r'[1-9]\d*', str(artifact.get('generation', ''))) is not None,
                    'IB_DAILY_RECEIPT_MISMATCH')
            raw = self._object(artifact['privateObject'], generation=artifact['generation'])
            require(hashlib.sha256(raw).hexdigest() == artifact.get('sha256'), 'IB_DAILY_CAPTURE_HASH_MISMATCH')
        except SourceOutcomeUnknown:
            raise
        except IBSnapshotError as exc:
            if str(exc) == 'IB_DAILY_SOURCE_TERMINAL_FAILURE':
                raise
            # A malformed/missing receipt cannot prove the dispatched outcome.
            raise SourceOutcomeUnknown(str(exc)) from None
        except Exception:
            raise SourceOutcomeUnknown('IB_DAILY_SOURCE_RESULT_INVALID') from None
        snapshot = unique_json(raw)
        assessment = snapshot.get('assessment', {})
        require(snapshot.get('requestId') == request_id and snapshot.get('dataDate') == request['dataDate']
                and receipt.get('mode') == 'ib-sync-readonly-snapshot'
                and receipt.get('assessment') == assessment and assessment.get('comparisonReady') is True
                and assessment.get('contractSha256') == CONTRACT
                and snapshot.get('credentialVersionMatched') is True and snapshot.get('credentialClientMatched') is True
                and re.fullmatch(r'projects/(?:family-portfolio-gateway|860729177589)/secrets/xuan-preopen-ib-mcp/versions/' + match.group(1),
                                 str(receipt.get('consumedCredentialVersion', ''))) is not None
                and snapshot.get('association') == receipt.get('association')
                and snapshot.get('association', {}).get('policyBlob') == self.config['association_policy_blob']
                and receipt.get('positionsCalls') == receipt.get('balancesCalls') == 1
                and receipt.get('rpcMessages') == 4 and receipt.get('refreshCalls') in (0, 1),
                'IB_DAILY_SOURCE_PROOF_INVALID')
        capture = snapshot['capture']
        require(began <= _instant(capture['startedAt']) <= _instant(capture['completedAt']) <= self.now(),
                'IB_DAILY_SOURCE_TIME_INVALID')
        require(assessment.get('providerTimesValid') is True, 'IB_DAILY_SOURCE_TIME_INVALID')
        for row, key in zip(capture.get('sources', []), ('positions', 'balances'), strict=True):
            value = assessment.get('providerAsOfBySource', {}).get(key)
            if value is not None:
                stamp = _instant(value)
                require(stamp <= _instant(row['completedAt'])
                        and stamp.astimezone(ZoneInfo('America/New_York')).date().isoformat() >= target,
                        'IB_DAILY_SOURCE_TIME_INVALID')
        proof = {'binding_verified': True, 'positions_complete': assessment['positionsComplete'],
                 'cash_complete': assessment['cashComplete'], 'cash_basis': 'total_trade_date',
                 'provider_as_of': assessment.get('providerAsOf'), 'source_date': None}
        mapping = {r['contract_id'] + ':' + r['currency']: 'instrument:' + r['instrument_id']
                   for r in self.config['identities']}
        return normalize_mcp_capture(capture, validate_capture=lambda _: proof,
                                     resolve_instrument=lambda contract, currency: mapping.get(contract + ':' + currency))
