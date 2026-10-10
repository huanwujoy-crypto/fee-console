"""Silent, reason-gated weekly recovery. No new credentials or notifications."""
import argparse
import datetime as dt
import hashlib
import json
import re
import time
import uuid

PRIVATE = 'family-portfolio-gateway-xuan-weekly-private'
PUBLIC = 'family-portfolio-gateway-xuan-weekly-public'
TRANSIENT = {408, 429, 500, 502, 503, 504}
LEASE_MINUTES = 20
APPROVAL_REFERENCE = r'https://github\.com/huanwujoy-crypto/fee-console/pull/[1-9][0-9]*#issuecomment-[1-9][0-9]*'


def utc(value):
    parsed = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
    if parsed.tzinfo is None or parsed.utcoffset() != dt.timedelta():
        raise ValueError('invalid_timestamp')
    return parsed


def window(now):
    local = now + dt.timedelta(hours=8)
    sunday = local.date() - dt.timedelta(days=(local.weekday()+1) % 7)
    due = dt.datetime.combine(sunday, dt.time(2), dt.timezone.utc)
    return due, (now-due).total_seconds()


def transient(receipt):
    n = receipt.get('network', {})
    # Do not trust retryable=true alone or arbitrary exception text.
    if receipt.get('complete') is not False or n.get('retryable') is not True:
        return False
    if receipt.get('stage') not in ('ib_fetch', 'quotes_fetch', 'gateway_portfolios', 'gateway_performance'):
        return False
    return n.get('category') in ('timeout', 'connection', 'dns', 'deadline') or (
        n.get('category') == 'http' and n.get('httpStatus') in TRANSIENT)


def current(metadata, body, now):
    due, _ = window(now)
    try:
        started = utc(metadata['started_at'])
        risk = dt.date.fromisoformat(metadata['risk_date'])
        abc = dt.date.fromisoformat(metadata['abc_date'])
        digest = metadata['sha256']
        return (due <= started <= now+dt.timedelta(minutes=1)
                and 0 <= (started.date()-risk).days <= 3
                and 0 <= (risk-abc).days <= 3
                and re.fullmatch('[a-f0-9]{64}', digest) is not None
                and hashlib.sha256(body).hexdigest() == digest)
    except (KeyError, ValueError, TypeError):
        return False


def reserve(store, now, claim):
    """Create-only shared minute reservations, acquired in ascending order.

    Any overlapping 20-minute attempts share at least one object. Each object
    is generation-zero CAS; a loser stops before sources/publication. Partial
    reservations are harmless and expire by time, never by deleting archives.
    The Cloud Run 600-second task bound is shorter than the reserved interval.
    """
    minute = int(now.timestamp()) // 60
    for slot in range(minute, minute + LEASE_MINUTES + 1):
        if not store.claim('weekly/control/leases/'+str(slot)+'.json', claim):
            return False
    return True


def manual_control(store, now, run_report, *, request_id, expected_public_sha256,
                   approval_reference, clock=None):
    """Explicit single approved repair request, independent of automatic windows.

    IAM runWithOverrides controls who can select this mode. Approval reference
    is an audit reference, not proof of OWNER consent; the operator must verify
    exact-head approval before invocation. No arbitrary source/cutoff arguments.
    """
    try:
        if str(uuid.UUID(request_id)) != request_id:
            raise ValueError('request_id_invalid')
        if not re.fullmatch(APPROVAL_REFERENCE, approval_reference):
            raise ValueError('approval_reference_invalid')
        if expected_public_sha256 != 'absent' and not re.fullmatch('[a-f0-9]{64}', expected_public_sha256):
            raise ValueError('expected_public_sha256_invalid')
    except (ValueError, TypeError, AttributeError):
        return {'code': 'manual_request_invalid', 'needsAttention': True}
    root = 'weekly/control/manual/'+request_id+'/'
    if store.read(root+'request.json'):
        return {'code': 'manual_request_already_used', 'needsAttention': True}
    metadata, body = store.public()
    if expected_public_sha256 == 'absent':
        matches = not metadata and not body
    else:
        matches = (metadata.get('sha256') == expected_public_sha256
                   and hashlib.sha256(body).hexdigest() == expected_public_sha256
                   and store.consistent(metadata, body))
    if not matches:
        return {'code': 'manual_expected_public_conflict', 'needsAttention': True}
    stamp = now.isoformat()
    prefix = 'weekly/'+stamp+'-'+uuid.uuid4().hex+'/'
    claim = {'startedAt': stamp, 'prefix': prefix, 'kind': 'manual',
             'expiresAt': (now+dt.timedelta(minutes=LEASE_MINUTES)).isoformat(),
             'requestId': request_id, 'approvalReference': approval_reference,
             'expectedPublicSha256': expected_public_sha256}
    if not reserve(store, now, claim):
        return {'code': 'active_lease', 'needsAttention': True}
    if not store.claim(root+'request.json', claim):
        return {'code': 'manual_claim_lost', 'needsAttention': True}
    # Check again after claiming, before source calls, against concurrent changes.
    latest_metadata, latest_body = store.public()
    if latest_metadata != metadata or latest_body != body:
        return {'code': 'manual_expected_public_conflict', 'needsAttention': True}
    run_report(stamp, prefix)
    finished = clock() if clock else now
    metadata, body = store.public()
    try:
        started = utc(metadata.get('started_at', ''))
        digest_ok = (hashlib.sha256(body).hexdigest() == metadata.get('sha256'))
        risk = dt.date.fromisoformat(metadata['risk_date'])
        abc = dt.date.fromisoformat(metadata['abc_date'])
        ok = (now <= started <= finished+dt.timedelta(minutes=1) and digest_ok
              and 0 <= (started.date()-risk).days <= 3
              and 0 <= (risk-abc).days <= 3 and store.consistent(metadata, body))
    except (KeyError, ValueError, TypeError):
        ok = False
    result = {'code': 'manual_verified' if ok else 'manual_not_verified',
              'needsAttention': not ok, 'kind': 'manual',
              'requestId': request_id, 'completedAt': finished.isoformat()}
    store.claim(prefix+'health.json', result)
    return result


def control(store, now, run_report, republish, *, clock=None):
    """Injected store allows complete offline tests without any cloud/source call."""
    due, age = window(now)
    week = due.date().isoformat()
    root = 'weekly/control/'+week+'/'
    # Only the same HKT Sunday may check a late final outcome. Source and
    # publication recovery still stop at 10:45; later checks are read-only.
    if age < 0 or (now+dt.timedelta(hours=8)).date() != due.date():
        return {'code': 'outside_recovery_window', 'needsAttention': False,
                'reportRun': False, 'manualModeRequiredForApprovedRepair': True}
    metadata, body = store.public()
    if current(metadata, body, now):
        if not store.consistent(metadata, body):
            if age >= 45*60:
                return {'code': 'private_public_receipt_conflict', 'needsAttention': True}
            if store.active_lease(now):
                return {'code': 'active_lease', 'needsAttention': False}
            if not store.repair_publication(metadata, body, now, clock=clock):
                return {'code': 'private_public_receipt_conflict', 'needsAttention': True}
            latest_metadata, latest_body = store.public()
            if (latest_metadata != metadata or latest_body != body
                    or not store.consistent(latest_metadata, latest_body)):
                return {'code': 'private_public_receipt_conflict', 'needsAttention': True}
            return {'code': 'publication_receipt_repaired', 'needsAttention': False,
                    'reportRun': False}
        return {'code': 'public_current', 'needsAttention': False}
    if age >= 45*60:
        return {'code': 'final_publication_missing', 'needsAttention': True}
    # An advertised current-week publication which fails its own validation
    # is a conflict, not permission to refetch sources or overwrite HTML.
    if metadata or body:
        try:
            advertised_current = utc(metadata['started_at']) >= due
        except (KeyError, ValueError, TypeError):
            advertised_current = True
        if advertised_current:
            return {'code': 'private_public_receipt_conflict', 'needsAttention': True}
    normal = store.read(root+'normal.json')
    recovery = store.read(root+'recovery.json')
    if recovery:
        return {'code': 'recovery_already_used', 'needsAttention': age >= 45*60}
    kind = 'normal' if age < 10*60 and normal is None else 'recovery'
    if kind == 'recovery':
        if age < 15*60:
            return {'code': 'await_publication_window', 'needsAttention': False}
        failure = store.read(normal['prefix']+'failure.json') if normal else None
        receipt = store.read(normal['prefix']+'receipt.json') if normal else None
        # A successful immutable archive is a publication-only recovery.
        archived = receipt if receipt and receipt.get('complete') is True else None
        if normal and not archived and not failure:
            return {'code': 'active_or_unclassified_attempt', 'needsAttention': age >= 45*60}
        if failure and not archived and not transient(failure):
            return {'code': 'permanent_or_unclassified_failure', 'needsAttention': True}
    else:
        archived = None
    stamp = now.isoformat()
    prefix = 'weekly/'+stamp+'-'+uuid.uuid4().hex+'/'
    claim = {'startedAt': stamp, 'prefix': prefix, 'kind': kind,
             'expiresAt': (now+dt.timedelta(minutes=LEASE_MINUTES)).isoformat()}
    # Shared finite reservations serialize manual/normal/recovery publication.
    if not reserve(store, now, claim):
        return {'code': 'active_lease', 'needsAttention': False}
    # Immutable weekly counter is never reset when the lease expires.
    if not store.claim(root+kind+'.json', claim):
        return {'code': 'claim_lost', 'needsAttention': False}
    if archived:
        source = normal['prefix']+'report.html'
        if archived.get('privateReportObject') != source:
            return {'code': 'archive_source_conflict', 'needsAttention': True}
        html = store.report(source)
        if hashlib.sha256(html.encode()).hexdigest() != archived.get('htmlSha256'):
            return {'code': 'archive_hash_conflict', 'needsAttention': True}
        # Dates must satisfy the same weekly contract before any write.
        m = {'started_at': normal['startedAt'], 'risk_date': archived.get('requestedCutoff'),
             'abc_date': archived.get('cutoff'), 'sha256': archived.get('htmlSha256')}
        if not current(m, html.encode(), now):
            return {'code': 'archive_dates_invalid', 'needsAttention': True}
        statuses = republish(html, m, source)
        if not isinstance(statuses, dict):
            return {'code': 'publication_result_invalid', 'needsAttention': True}
        # Only complete a missing receipt; never overwrite immutable archive files.
        store.claim(normal['prefix']+'publication.json', {**archived, **statuses,
                    'completedAt': now.isoformat(), 'recoveredPublication': True})
    else:
        run_report(stamp, prefix)
    finished = clock() if clock else now
    metadata, body = store.public()
    ok = current(metadata, body, finished) and store.consistent(metadata, body)
    retry_later = kind == 'normal' and transient(store.read(prefix+'failure.json') or {})
    outcome = {'code': 'recovered' if ok else 'await_bounded_recovery' if retry_later else 'recovery_not_verified',
               'needsAttention': not ok and not retry_later,
               'kind': kind, 'completedAt': finished.isoformat()}
    store.claim(prefix+'health.json', outcome)
    return outcome


class StorageStore:
    def __init__(self, client):
        self.client = client
        self.bucket = client.bucket(PRIVATE)

    def read(self, name):
        from google.api_core.exceptions import NotFound
        try:
            raw = self.bucket.blob(name).download_as_bytes(timeout=10)
        except NotFound:
            return None
        if len(raw) > 65536:
            raise ValueError('receipt_too_large')
        return json.loads(raw)

    def claim(self, name, value):
        from google.api_core.exceptions import PreconditionFailed
        try:
            self.bucket.blob(name).upload_from_string(json.dumps(value), content_type='application/json',
                                                     if_generation_match=0, timeout=10)
            return True
        except PreconditionFailed:
            return False

    def report(self, name):
        raw = self.bucket.blob(name).download_as_bytes(timeout=10)
        if len(raw) > 8_000_000:
            raise ValueError('report_too_large')
        return raw.decode('utf-8')

    def public(self):
        from google.api_core.exceptions import NotFound
        blob = self.client.bucket(PUBLIC).blob('weekly/latest.html')
        try:
            blob.reload(timeout=10)
            raw = blob.download_as_bytes(if_generation_match=int(blob.generation), timeout=10)
        except NotFound:
            return {}, b''
        if len(raw) > 8_000_000:
            raise ValueError('report_too_large')
        return blob.metadata or {}, raw

    def consistent(self, public_metadata, public_body):
        blob = self.bucket.blob('weekly/latest.html')
        blob.reload(timeout=10)
        m = blob.metadata or {}
        source = m.get('source', '')
        if not source.startswith('weekly/') or not source.endswith('/report.html'):
            return False
        if any(m.get(k) != public_metadata.get(k) for k in ('started_at', 'risk_date', 'abc_date')):
            return False
        raw = blob.download_as_bytes(if_generation_match=int(blob.generation), timeout=10)
        if len(raw)>8_000_000 or hashlib.sha256(raw).hexdigest()!=m.get('sha256'):
            return False
        public = raw.decode('utf-8').replace('私密记录 · 不下单、不转账', '记录与分析 · 不下单、不转账').encode()
        if public != public_body:
            return False
        prefix = source[:-len('report.html')]
        receipt = self.read(prefix+'receipt.json') or {}
        publication = self.read(prefix+'publication.json') or {}
        return (receipt.get('complete') is True and publication.get('complete') is True
                and receipt.get('privateReportObject')==source
                and receipt.get('requestedCutoff')==m.get('risk_date')
                and receipt.get('cutoff')==m.get('abc_date')
                and receipt.get('htmlSha256')==m.get('sha256')
                and publication.get('htmlSha256')==m.get('sha256')
                and publication.get('publicEntryStatus') in ('updated','already_current'))

    def active_lease(self, now):
        minute = int(now.timestamp()) // 60
        lease = self.read('weekly/control/leases/'+str(minute)+'.json')
        return lease is not None and utc(lease['expiresAt']) > now

    def _repair_evidence(self, public_metadata, public_body, now):
        """Bind both fixed latest generations to one completed immutable HTML.

        Read generated HTML and safe receipts only, never financial raw sources.
        A public hash differs from the private hash after the approved footer
        transformation; each must validate against its own bytes.
        """
        from google.api_core.exceptions import NotFound
        if (not current(public_metadata, public_body, now)
                or public_metadata.get('source') != 'weekly/public/report.html'):
            return None
        snapshots = []
        for bucket in (self.bucket, self.client.bucket(PUBLIC)):
            blob = bucket.blob('weekly/latest.html')
            try:
                blob.reload(timeout=10)
                generation = int(blob.generation)
                metadata = dict(blob.metadata or {})
                raw = blob.download_as_bytes(if_generation_match=generation, timeout=10)
            except NotFound:
                return None
            if len(raw) > 8_000_000:
                return None
            snapshots.append((generation, metadata, raw))
        private_generation, m, raw = snapshots[0]
        public_generation, p, published = snapshots[1]
        if (p != public_metadata or published != public_body or not current(m, raw, now)
                or any(m.get(k) != p.get(k) for k in ('started_at', 'risk_date', 'abc_date'))):
            return None
        source = m.get('source', '')
        match = re.fullmatch(r'weekly/([^/]+)-[a-f0-9]{32}/report\.html', source)
        if not match or utc(match[1]) != utc(m['started_at']):
            return None
        html = raw.decode('utf-8')
        if (not html.startswith('<!doctype html>') or '<script' in html.lower()
                or '<iframe' in html.lower()
                or html.replace('私密记录 · 不下单、不转账',
                                '记录与分析 · 不下单、不转账').encode() != published):
            return None
        archive = self.bucket.blob(source)
        try:
            archive.reload(timeout=10)
            archive_generation = int(archive.generation)
            archived = archive.download_as_bytes(if_generation_match=archive_generation, timeout=10)
        except NotFound:
            return None
        if archived != raw:
            return None
        prefix = source[:-len('report.html')]
        receipt = self.read(prefix+'receipt.json')
        if (not isinstance(receipt, dict) or receipt.get('complete') is not True
                or receipt.get('privateReportObject') != source
                or receipt.get('requestedCutoff') != m['risk_date']
                or receipt.get('cutoff') != m['abc_date']
                or receipt.get('htmlSha256') != m['sha256']):
            return None
        return (private_generation, public_generation, archive_generation, m, p, receipt)

    def _publication_matches(self, publication, receipt):
        # A concurrent original publisher may use "updated" rather than
        # "already_current". Its immutable receipt fields must still match in
        # full; the weaker legacy consistent() predicate cannot grant repair.
        return (isinstance(publication, dict)
                and all(publication.get(k) == v for k, v in receipt.items())
                and set(publication) <= set(receipt) | {
                    'latestEntryStatus', 'publicEntryStatus', 'recoveredPublication'}
                and publication.get('latestEntryStatus') in ('updated', 'already_current')
                and publication.get('publicEntryStatus') in ('updated', 'already_current')
                and ('recoveredPublication' not in publication
                     or publication['recoveredPublication'] is True))

    def repair_publication(self, public_metadata, public_body, now, *, clock=None):
        """Complete only a missing receipt; CAS serializes duplicate repairers.

        No source-run counter/lease is consumed or reset: no source or HTML
        publication occurs. Repeated generation-bound checks stop concurrent
        latest changes; an existing conflicting receipt is never overwritten.
        """
        due, age = window(now)
        if not 0 <= age < 45*60:
            return False
        evidence = self._repair_evidence(public_metadata, public_body, now)
        if evidence is None:
            return False
        receipt = evidence[-1]
        name = receipt['privateReportObject'][:-len('report.html')]+'publication.json'
        candidate = {**receipt, 'latestEntryStatus': 'already_current',
                     'publicEntryStatus': 'already_current', 'recoveredPublication': True}
        existing = self.read(name)
        if existing is not None:
            return (self._publication_matches(existing, receipt)
                    and self._repair_evidence(public_metadata, public_body, now) == evidence
                    and self.consistent(public_metadata, public_body))
        if self._repair_evidence(public_metadata, public_body, now) != evidence:
            return False
        lease_time = clock() if clock else now
        if self.active_lease(lease_time):
            return False
        # The remote lease read may cross the final deadline. Read the clock
        # again afterwards; no further remote read precedes this CAS write.
        finished = clock() if clock else now
        final_due, final_age = window(finished)
        if final_due != due or not 0 <= final_age < 45*60:
            return False
        self.claim(name, candidate)  # generation zero; a loser verifies the winner.
        return (self._publication_matches(self.read(name), receipt)
                and self._repair_evidence(public_metadata, public_body, now) == evidence
                and self.consistent(public_metadata, public_body))


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description='XUAN scheduled checks or explicit approved repair')
    parser.add_argument('--mode', choices=('scheduled', 'manual'), default='scheduled')
    parser.add_argument('--request-id')
    parser.add_argument('--expected-public-sha256')
    parser.add_argument('--approval-reference')
    args = parser.parse_args(argv)
    manual = (args.request_id, args.expected_public_sha256, args.approval_reference)
    if args.mode == 'manual' and not all(manual):
        parser.error('manual mode requires request-id, expected-public-sha256 and approval-reference')
    if args.mode == 'scheduled' and any(manual):
        parser.error('manual repair arguments cannot select scheduled mode')
    return args


def main(argv=None):
    args = parse_args(argv)
    try:
        from google.cloud import storage
        from weekly_job import run, publish_latest, publish_public
        client = storage.Client()
        store = StorageStore(client)
        now = dt.datetime.now(dt.timezone.utc)
        deadline = time.monotonic()+570
        def report(stamp, prefix):
            return run(stamp=stamp, prefix=prefix, outer_deadline=deadline)
        def publish(html, metadata, source):
            private_status=publish_latest(store.bucket, html, started_at=metadata['started_at'],
                           risk_date=metadata['risk_date'], abc_date=metadata['abc_date'], source=source)
            public_status=publish_public(client, PUBLIC, html, started_at=metadata['started_at'],
                           risk_date=metadata['risk_date'], abc_date=metadata['abc_date'])
            return {'latestEntryStatus':private_status,'publicEntryStatus':public_status}
        clock = lambda:dt.datetime.now(dt.timezone.utc)
        if args.mode == 'manual':
            result = manual_control(store, now, report, request_id=args.request_id,
                       expected_public_sha256=args.expected_public_sha256,
                       approval_reference=args.approval_reference, clock=clock)
        else:
            result = control(store, now, report, publish, clock=clock)
    except Exception as error:
        # Never emit exception messages, URLs, tokens or financial payloads.
        result = {'code': 'permission_denied' if getattr(error,'code',None) in (401,403)
                  else 'health_control_failed', 'needsAttention': True}
    print(json.dumps(result), flush=True)
    return 1 if result['needsAttention'] else 0


if __name__ == '__main__':
    raise SystemExit(main())
