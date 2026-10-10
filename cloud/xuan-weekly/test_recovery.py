import datetime as dt
import hashlib
import unittest
from recovery import control, current, transient

NOW = dt.datetime(2026, 10, 4, 2, tzinfo=dt.timezone.utc)
ROOT = 'weekly/control/2026-10-04/'
HTML = '<!doctype html>synthetic'
META = {'started_at': NOW.isoformat(), 'risk_date': '2026-10-02', 'abc_date': '2026-10-02',
        'sha256': hashlib.sha256(HTML.encode()).hexdigest()}
FAIL = {'complete': False, 'stage': 'ib_fetch', 'network': {'retryable': True, 'category': 'timeout'}}

class Store:
    def __init__(self): self.objects = {}; self.good = False; self.claims = []
    def public(self): return (META, HTML.encode()) if self.good else ({}, b'')
    def read(self, name): return self.objects.get(name)
    def claim(self, name, value):
        if name in self.objects: return False
        self.objects[name] = value; self.claims.append(name); return True
    def report(self, name): return HTML
    def consistent(self, metadata, body): return True
    def active_lease(self, now): return False
    def repair_publication(self, metadata, body, now, **kwargs): return False

class RecoveryTests(unittest.TestCase):
    def setUp(self): self.s = Store(); self.calls = []
    def run(self, *args, **kwargs):
        # unittest owns run(); keep the source callback separate.
        return super().run(*args, **kwargs)
    def report(self, stamp, prefix): self.calls.append(('source', prefix)); self.s.good = True
    def publish(self, html, metadata, source):
        self.calls.append(('publish', source)); self.s.good = True
        return {'latestEntryStatus':'already_current','publicEntryStatus':'updated'}
    def check(self, minute=0): return control(self.s, NOW+dt.timedelta(minutes=minute), self.report, self.publish)
    def normal(self, failure=None):
        self.s.objects[ROOT+'normal.json'] = {'prefix': 'weekly/synthetic/', 'startedAt': NOW.isoformat()}
        if failure: self.s.objects['weekly/synthetic/failure.json'] = failure
    def test_fresh_no_source(self):
        self.s.good = True; self.assertEqual(self.check(15)['code'], 'public_current'); self.assertFalse(self.calls)
    def test_normal_one_run_followups_are_health(self):
        self.check(); self.check(15); self.check(30); self.check(45); self.assertEqual(len(self.calls), 1)
    def test_missing_trigger_one_recovery_only(self):
        self.check(15); self.assertIn(ROOT+'recovery.json', self.s.objects)
        self.s.good = False; self.check(30); self.check(45); self.assertEqual(len(self.calls), 1)
    def test_active_or_unknown_attempt_no_source(self):
        self.normal(); self.assertEqual(self.check(15)['code'], 'active_or_unclassified_attempt'); self.assertFalse(self.calls)
        self.assertTrue(self.check(45)['needsAttention'])
    def test_proven_transient_can_recover(self):
        self.normal(FAIL); self.assertEqual(self.check(15)['code'], 'recovered'); self.assertEqual(len(self.calls), 1)
    def test_permanent_and_schema_failures_never_recover(self):
        for failure in [{'complete': False, 'stage': 'calculation'},
                        {'complete': False, 'stage': 'ib_fetch', 'network': {'retryable': True, 'category': 'tls'}},
                        {'complete': False, 'stage': 'ib_fetch', 'network': {'retryable': True, 'category': 'http', 'httpStatus': 403}}]:
            self.s = Store(); self.normal(failure); self.assertTrue(self.check(15)['needsAttention']); self.assertFalse(self.calls)
    def test_claim_race_does_not_run_source(self):
        self.normal(FAIL); self.s.claim = lambda *args: False
        self.assertEqual(self.check(15)['code'], 'active_lease'); self.assertFalse(self.calls)
    def archive(self):
        self.normal(); self.s.objects['weekly/synthetic/receipt.json'] = {'complete': True,
            'privateReportObject': 'weekly/synthetic/report.html', 'htmlSha256': META['sha256'],
            'requestedCutoff': '2026-10-02', 'cutoff': '2026-10-02'}
    def test_valid_archive_republishes_without_source(self):
        self.archive(); self.check(15); self.assertEqual(self.calls, [('publish', 'weekly/synthetic/report.html')])
        self.assertTrue(self.s.objects['weekly/synthetic/publication.json']['recoveredPublication'])
    def test_archive_conflict_stops(self):
        self.archive(); self.s.objects['weekly/synthetic/receipt.json']['htmlSha256'] = '0'*64
        self.assertEqual(self.check(15)['code'], 'archive_hash_conflict'); self.assertFalse(self.calls)
    def test_final_check_never_starts_recovery(self):
        self.assertTrue(self.check(45)['needsAttention']); self.assertFalse(self.calls)
    def test_outside_window_no_objects_or_sources(self):
        self.check(-1); self.check(46); self.assertFalse(self.calls); self.assertFalse(self.s.claims)
    def test_digest_and_dates_are_verified(self):
        self.assertTrue(current(META, HTML.encode(), NOW))
        self.assertFalse(current(META, b'changed', NOW))
        self.assertFalse(current({**META, 'risk_date': '2026-09-28'}, HTML.encode(), NOW))
    def test_auth_flag_cannot_make_failure_retryable(self):
        self.assertFalse(transient({'complete': False, 'stage': 'ib_fetch',
            'network': {'category': 'http', 'httpStatus': 401, 'retryable': True}}))
    def test_fresh_public_with_conflicting_private_receipt_stops(self):
        self.s.good=True; self.s.consistent=lambda *args: False
        self.assertTrue(self.check(15)['needsAttention']); self.assertFalse(self.calls)

class ManualAndLeaseTests(unittest.TestCase):
    def setUp(self):
        self.s = Store(); self.s.good = True; self.calls = []
        self.now = NOW+dt.timedelta(minutes=46)
        self.request = {'request_id':'12345678-1234-4234-8234-123456789abc',
                        'expected_public_sha256':META['sha256'],
                        'approval_reference':'https://github.com/huanwujoy-crypto/fee-console/pull/340#issuecomment-5977909656'}
    def report(self, stamp, prefix):
        self.calls.append(prefix)
        self.s.public=lambda:({**META,'started_at':stamp},HTML.encode())
    def check(self, **changes):
        from recovery import manual_control
        return manual_control(self.s,self.now,self.report,**{**self.request,**changes})
    def test_explicit_manual_outside_window_runs_once_and_replay_stops(self):
        self.assertEqual(self.check()['code'],'manual_verified')
        self.assertEqual(self.check()['code'],'manual_request_already_used')
        self.assertEqual(len(self.calls),1)
    def test_manual_requires_exact_expected_public_and_approval_reference(self):
        for changes in [{'request_id':'bad'}, {'approval_reference':'approved=true'},
                        {'approval_reference':'https://github.com/other/repo/pull/1#issuecomment-2'},
                        {'expected_public_sha256':'0'*64}]:
            self.s=Store(); self.s.good=True
            self.assertTrue(self.check(**changes)['needsAttention'])
        self.assertFalse(self.calls)
    def test_manual_never_ignores_private_public_conflict(self):
        self.s.consistent=lambda *a:False
        self.assertEqual(self.check()['code'],'manual_expected_public_conflict');self.assertFalse(self.calls)
    def test_manual_missing_public_requires_explicit_absent(self):
        self.s.good=False
        self.assertEqual(self.check()['code'],'manual_expected_public_conflict')
        self.assertEqual(self.check(expected_public_sha256='absent')['code'],'manual_verified')
    def test_manual_failed_report_not_verified_no_automatic_retry(self):
        self.report=lambda *a:None
        self.assertEqual(self.check()['code'],'manual_not_verified')
        self.assertEqual(self.check()['code'],'manual_request_already_used')
    def test_parse_args_requires_explicit_complete_mode(self):
        from recovery import parse_args
        import contextlib,io
        with contextlib.redirect_stderr(io.StringIO()):
            for argv in [['--mode=manual'],['--request-id=abc'],['--mode=force']]:
                with self.assertRaises(SystemExit):parse_args(argv)
        self.assertEqual(parse_args([]).mode,'scheduled')
        self.assertEqual(parse_args(['--mode=manual','--request-id='+self.request['request_id'],
                         '--expected-public-sha256='+META['sha256'],
                         '--approval-reference='+self.request['approval_reference']]).mode,'manual')
    def test_manual_and_automatic_share_reservations(self):
        from recovery import reserve
        self.assertTrue(reserve(self.s,self.now-dt.timedelta(minutes=5),{'kind':'normal'}))
        self.assertEqual(self.check()['code'],'active_lease');self.assertFalse(self.calls)
    def test_later_attempt_cannot_run_when_lease_overlaps(self):
        from recovery import reserve
        self.assertTrue(reserve(self.s,NOW,{'kind':'normal'}))
        self.assertFalse(reserve(self.s,NOW+dt.timedelta(minutes=19),{'kind':'manual'}))
        self.assertTrue(reserve(self.s,NOW+dt.timedelta(minutes=21),{'kind':'manual'}))
    def test_expired_lease_never_resets_weekly_recovery_counter(self):
        self.s.good=False
        self.s.objects[ROOT+'recovery.json']={'prefix':'weekly/used/','expiresAt':NOW.isoformat()}
        self.assertEqual(control(self.s,NOW+dt.timedelta(minutes=30),self.report,lambda *a:None)['code'],'recovery_already_used')
        self.assertFalse(self.calls)
    def test_terminal_timeout_waits_for_lease_then_one_recovery(self):
        from recovery import reserve
        self.s.good=False
        self.s.objects[ROOT+'normal.json']={'prefix':'weekly/failed/','startedAt':NOW.isoformat()}
        self.s.objects['weekly/failed/failure.json']=FAIL
        reserve(self.s,NOW,{'kind':'normal'})
        self.assertEqual(control(self.s,NOW+dt.timedelta(minutes=15),self.report,lambda *a:None)['code'],'active_lease')
        self.assertEqual(control(self.s,NOW+dt.timedelta(minutes=30),self.report,lambda *a:None)['code'],'recovered')
        self.assertEqual(len(self.calls),1)
    def test_two_concurrent_controllers_cannot_both_fetch(self):
        import threading,concurrent.futures,time
        self.s.good=False;lock=threading.Lock();original=self.s.claim
        def atomic(name,value):
            with lock:return original(name,value)
        self.s.claim=atomic
        def run(stamp,prefix):
            with lock:self.calls.append(prefix)
            time.sleep(.01)
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results=list(pool.map(lambda _:control(self.s,NOW,run,lambda *a:None),range(2)))
        self.assertEqual(len(self.calls),1)
        self.assertTrue(any(r['code'] in ('active_lease','claim_lost','await_publication_window','active_or_unclassified_attempt') for r in results))
    def test_two_concurrent_manual_requests_cannot_both_fetch(self):
        import threading,concurrent.futures,time
        from recovery import manual_control
        lock=threading.Lock();original=self.s.claim
        def atomic(name,value):
            with lock:return original(name,value)
        self.s.claim=atomic
        def run(stamp,prefix):
            with lock:self.calls.append(prefix)
            time.sleep(.01)
        requests=['12345678-1234-4234-8234-123456789abc','22345678-1234-4234-8234-123456789abc']
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results=list(pool.map(lambda rid:manual_control(self.s,self.now,run,**{**self.request,'request_id':rid}),requests))
        self.assertEqual(len(self.calls),1)
        self.assertTrue(any(r['code']=='active_lease' for r in results))
    def test_storage_claim_is_generation_zero_and_conflict_is_not_retried(self):
        from recovery import StorageStore
        from google.api_core.exceptions import PreconditionFailed
        from unittest.mock import MagicMock
        client=MagicMock();store=StorageStore(client)
        self.assertTrue(store.claim('weekly/control/test.json',{'kind':'normal'}))
        blob=client.bucket.return_value.blob.return_value
        self.assertEqual(blob.upload_from_string.call_args.kwargs['if_generation_match'],0)
        self.assertEqual(blob.upload_from_string.call_args.kwargs['timeout'],10)
        blob.upload_from_string.side_effect=PreconditionFailed('conflict')
        self.assertFalse(store.claim('weekly/control/test.json',{}))
        self.assertEqual(blob.upload_from_string.call_count,2)
    def test_permission_failure_stops_before_sources(self):
        self.s.good=False
        self.s.claim=lambda *a:(_ for _ in ()).throw(PermissionError('synthetic denied'))
        with self.assertRaises(PermissionError):control(self.s,NOW,self.report,lambda *a:None)
        self.assertFalse(self.calls)
    def test_public_changes_after_manual_claim_stop_before_sources(self):
        old=self.s.public;calls=0
        def changed():
            nonlocal calls
            calls+=1
            return old() if calls==1 else ({**META,'sha256':'0'*64},b'changed')
        self.s.public=changed
        self.assertEqual(self.check()['code'],'manual_expected_public_conflict');self.assertFalse(self.calls)
    def test_client_permission_failure_emits_only_safe_code(self):
        import contextlib,io,types,json
        from unittest.mock import MagicMock,patch
        from recovery import main
        class Forbidden(Exception):code=403
        cloud=types.ModuleType('google.cloud');cloud.storage=MagicMock()
        cloud.storage.Client.side_effect=Forbidden('private synthetic detail must not appear')
        output=io.StringIO()
        with patch.dict('sys.modules',{'google.cloud':cloud}),contextlib.redirect_stdout(output):
            self.assertEqual(main([]),1)
        self.assertEqual(json.loads(output.getvalue()),{'code':'permission_denied','needsAttention':True})

class LateFinalCheckTests(unittest.TestCase):
    def check(self, now, store=None):
        self.store = store or Store()
        self.calls = []
        result = control(self.store, now,
                         lambda *a: self.calls.append('source'),
                         lambda *a: self.calls.append('publish'))
        self.assertEqual(self.calls, [])
        self.assertEqual(self.store.claims, [])
        return result

    def test_missing_public_after_final_deadline_is_failure_until_hkt_day_end(self):
        for seconds in (2700, 2701, 2710, 3000, 50399):
            with self.subTest(seconds=seconds):
                result = self.check(NOW + dt.timedelta(seconds=seconds))
                self.assertEqual(result['code'], 'final_publication_missing')
                self.assertTrue(result['needsAttention'])

    def test_healthy_public_after_final_deadline_remains_success_without_writes(self):
        for seconds in (2700, 2701, 3000, 50399):
            with self.subTest(seconds=seconds):
                store = Store(); store.good = True
                self.assertEqual(self.check(NOW + dt.timedelta(seconds=seconds), store),
                                 {'code': 'public_current', 'needsAttention': False})

    def test_final_conflict_never_attempts_receipt_repair(self):
        store = Store(); store.good = True
        store.consistent = lambda *a: False
        store.repair_publication = lambda *a, **k: self.fail('final check must be read-only')
        result = self.check(NOW + dt.timedelta(seconds=2701), store)
        self.assertEqual(result['code'], 'private_public_receipt_conflict')
        self.assertTrue(result['needsAttention'])

    def test_saturday_prestart_and_next_hkt_midnight_stay_outside(self):
        for delta in (-86400, -1, 50400, 86400):
            with self.subTest(seconds=delta):
                result = self.check(NOW + dt.timedelta(seconds=delta))
                self.assertEqual(result['code'], 'outside_recovery_window')
                self.assertFalse(result['needsAttention'])

    def test_next_week_does_not_accept_previous_week_success(self):
        store = Store(); store.good = True
        result = self.check(NOW + dt.timedelta(days=7, seconds=2701), store)
        self.assertEqual(result['code'], 'final_publication_missing')
        self.assertTrue(result['needsAttention'])

    def test_bad_hash_and_future_metadata_at_final_check_are_not_success(self):
        for meta, body in ((META, b'changed'),
                           ({**META, 'started_at': (NOW+dt.timedelta(days=1)).isoformat()}, HTML.encode())):
            store = Store(); store.public = lambda: (meta, body)
            self.assertTrue(self.check(NOW + dt.timedelta(seconds=2701), store)['needsAttention'])

    def test_cli_late_missing_report_exits_nonzero(self):
        import contextlib, io, json, types
        from unittest.mock import MagicMock, patch
        from recovery import main
        real_datetime = dt.datetime
        class FixedDateTime(real_datetime):
            @classmethod
            def now(cls, tz=None):
                return NOW + dt.timedelta(seconds=2701)
        cloud = types.ModuleType('google.cloud'); cloud.storage = MagicMock()
        store = Store(); output = io.StringIO()
        with patch.dict('sys.modules', {'google.cloud': cloud}), \
             patch('recovery.StorageStore', return_value=store), \
             patch('recovery.dt.datetime', FixedDateTime), contextlib.redirect_stdout(output):
            self.assertEqual(main([]), 1)
        self.assertEqual(json.loads(output.getvalue())['code'], 'final_publication_missing')
        self.assertEqual(store.claims, [])


class ReceiptRepairTests(unittest.TestCase):
    def setUp(self):
        import copy, json, threading
        from recovery import PRIVATE, PUBLIC, StorageStore
        from test_latest import NotFound, PreconditionFailed
        self.lock = threading.Lock(); self.objects = {}; self.writes = []; self.attempts = []
        self.before_write = None; self.calls = []; self.generation = 100
        owner = self
        class Blob:
            def __init__(self, bucket, name):
                self.key = (bucket, name); self.metadata = None; self.generation = None
            def reload(self, **kwargs):
                with owner.lock:
                    if self.key not in owner.objects: raise NotFound()
                    _, metadata, generation = owner.objects[self.key]
                    self.metadata = copy.deepcopy(metadata); self.generation = generation
            def download_as_bytes(self, *, if_generation_match=None, **kwargs):
                with owner.lock:
                    if self.key not in owner.objects: raise NotFound()
                    body, _, generation = owner.objects[self.key]
                    if if_generation_match is not None and if_generation_match != generation:
                        raise PreconditionFailed()
                    return body
            def upload_from_string(self, body, *, if_generation_match, **kwargs):
                owner.assertEqual(if_generation_match, 0)
                if owner.before_write: owner.before_write(self.key)
                with owner.lock:
                    owner.attempts.append(self.key)
                    if self.key in owner.objects: raise PreconditionFailed()
                    owner.generation += 1
                    raw = body.encode() if isinstance(body, str) else body
                    owner.objects[self.key] = (raw, copy.deepcopy(self.metadata or {}), owner.generation)
                    owner.writes.append(self.key)
        class Bucket:
            def __init__(self, name): self.name = name
            def blob(self, name): return Blob(self.name, name)
        class Client:
            def bucket(self, name):
                owner.assertIn(name, (PRIVATE, PUBLIC))
                return Bucket(name)
        self.private = PRIVATE; self.public = PUBLIC
        self.prefix = 'weekly/' + NOW.isoformat() + '-' + 'a'*32 + '/'
        self.source = self.prefix + 'report.html'
        self.html = '<!doctype html><p>私密记录 · 不下单、不转账</p>'
        self.raw = self.html.encode()
        self.public_raw = self.html.replace('私密记录 · 不下单、不转账',
                                           '记录与分析 · 不下单、不转账').encode()
        self.metadata = {**META, 'sha256': hashlib.sha256(self.raw).hexdigest(), 'source': self.source}
        self.public_metadata = {**META, 'sha256': hashlib.sha256(self.public_raw).hexdigest(),
                                'source': 'weekly/public/report.html'}
        self.receipt = {'complete': True, 'privateReportObject': self.source,
                        'requestedCutoff': META['risk_date'], 'cutoff': META['abc_date'],
                        'htmlSha256': self.metadata['sha256'], 'completedAt': NOW.isoformat()}
        self.put(PRIVATE, 'weekly/latest.html', self.raw, self.metadata)
        self.put(PUBLIC, 'weekly/latest.html', self.public_raw, self.public_metadata)
        self.put(PRIVATE, self.source, self.raw)
        self.put(PRIVATE, self.prefix+'receipt.json', self.receipt)
        self.store = StorageStore(Client())
        self.now = NOW + dt.timedelta(minutes=30)

    def put(self, bucket, name, body, metadata=None):
        import copy, json
        raw = json.dumps(body).encode() if isinstance(body, dict) else body
        self.generation += 1
        self.objects[(bucket, name)] = (raw, copy.deepcopy(metadata or {}), self.generation)

    def check(self, now=None, clock=None):
        return control(self.store, now or self.now,
                       lambda *a: self.calls.append('source'),
                       lambda *a: self.calls.append('publish'), clock=clock)

    def assert_no_side_effects(self):
        self.assertEqual(self.calls, [])
        self.assertEqual(self.writes, [])

    def test_verified_missing_receipt_is_repaired_once_without_source_or_html_write(self):
        import copy
        original = copy.deepcopy(self.objects)
        self.assertFalse(self.store.consistent(self.public_metadata, self.public_raw))
        result = self.check()
        self.assertEqual(result['code'], 'publication_receipt_repaired')
        self.assertFalse(result['needsAttention'])
        self.assertEqual(self.calls, [])
        self.assertEqual(self.writes, [(self.private, self.prefix+'publication.json')])
        for key, value in original.items(): self.assertEqual(self.objects[key], value)
        self.assertTrue(self.store.consistent(self.public_metadata, self.public_raw))
        self.assertEqual(self.check()['code'], 'public_current')
        self.assertEqual(len(self.writes), 1)

    def test_receipt_repair_does_not_reset_or_consume_source_counters_or_leases(self):
        self.put(self.private, ROOT+'recovery.json', {'prefix': 'weekly/used/'})
        self.put(self.private, 'weekly/control/leases/used.json', {'kind': 'normal'})
        self.assertEqual(self.check()['code'], 'publication_receipt_repaired')
        self.assertEqual(self.writes, [(self.private, self.prefix+'publication.json')])
        self.assertEqual(self.calls, [])

    def test_missing_or_conflicting_evidence_never_writes_or_runs(self):
        import copy
        baseline = copy.deepcopy(self.objects)
        cases = ('missing_receipt', 'incomplete_receipt', 'receipt_hash', 'receipt_source',
                 'receipt_dates', 'missing_archive', 'archive_bytes', 'private_bytes',
                 'private_hash', 'private_dates', 'public_transform', 'public_source',
                 'source_traversal', 'source_stamp', 'active_html')
        for case in cases:
            with self.subTest(case=case):
                self.objects = copy.deepcopy(baseline); self.writes = []; self.attempts = []; self.calls = []
                receipt = dict(self.receipt); private = dict(self.metadata); public = dict(self.public_metadata)
                if case == 'missing_receipt': del self.objects[(self.private, self.prefix+'receipt.json')]
                elif case.startswith('receipt') or case == 'incomplete_receipt':
                    field, value = {'incomplete_receipt': ('complete', False),
                                    'receipt_hash': ('htmlSha256', '0'*64),
                                    'receipt_source': ('privateReportObject', 'weekly/other/report.html'),
                                    'receipt_dates': ('cutoff', '2026-09-01')}[case]
                    receipt[field] = value; self.put(self.private, self.prefix+'receipt.json', receipt)
                elif case == 'missing_archive': del self.objects[(self.private, self.source)]
                elif case == 'archive_bytes': self.put(self.private, self.source, b'changed')
                elif case == 'private_bytes': self.put(self.private, 'weekly/latest.html', b'changed', private)
                elif case == 'private_hash':
                    private['sha256'] = '0'*64; self.put(self.private, 'weekly/latest.html', self.raw, private)
                elif case == 'private_dates':
                    private['abc_date'] = '2026-09-30'; self.put(self.private, 'weekly/latest.html', self.raw, private)
                elif case == 'public_transform':
                    public['sha256'] = hashlib.sha256(b'changed').hexdigest()
                    self.put(self.public, 'weekly/latest.html', b'changed', public)
                elif case == 'public_source':
                    public['source'] = 'weekly/raw/report.html'; self.put(self.public, 'weekly/latest.html', self.public_raw, public)
                elif case in ('source_traversal', 'source_stamp'):
                    private['source'] = 'weekly/../report.html' if case == 'source_traversal' else \
                        'weekly/'+(NOW-dt.timedelta(days=7)).isoformat()+'-'+'a'*32+'/report.html'
                    self.put(self.private, 'weekly/latest.html', self.raw, private)
                else:
                    raw = b'<!doctype html><script>synthetic</script>'
                    digest = hashlib.sha256(raw).hexdigest()
                    self.put(self.private, 'weekly/latest.html', raw, {**private, 'sha256': digest})
                    self.put(self.public, 'weekly/latest.html', raw, {**public, 'sha256': digest})
                    self.put(self.private, self.source, raw)
                    self.put(self.private, self.prefix+'receipt.json', {**receipt, 'htmlSha256': digest})
                result = self.check()
                self.assertTrue(result['needsAttention'])
                self.assert_no_side_effects()

    def test_invalid_current_week_public_metadata_stops_without_refetch_or_republish(self):
        cases = ({**self.public_metadata, 'sha256': '0'*64},
                 {**self.public_metadata, 'started_at': (NOW+dt.timedelta(days=1)).isoformat()},
                 {**self.public_metadata, 'risk_date': '2026-09-01'},
                 {**self.public_metadata, 'started_at': 'malformed'})
        for public in cases:
            with self.subTest(metadata=public):
                self.put(self.public, 'weekly/latest.html', self.public_raw, public)
                self.assertTrue(self.check()['needsAttention'])
                self.assert_no_side_effects()

    def test_existing_conflicting_or_malformed_publication_is_never_overwritten(self):
        for body in ({**self.receipt, 'htmlSha256': '0'*64}, b'null', b'not-json'):
            with self.subTest(body=body):
                self.put(self.private, self.prefix+'publication.json', body)
                try:
                    result = self.check()
                    self.assertTrue(result['needsAttention'])
                except ValueError:
                    pass  # main translates malformed control data to a safe failure.
                self.assert_no_side_effects()

    def test_final_and_delayed_checks_never_repair_receipt(self):
        for seconds in (2700, 2701, 3000):
            self.assertTrue(self.check(NOW+dt.timedelta(seconds=seconds))['needsAttention'])
            self.assert_no_side_effects()

    def test_repair_cannot_write_when_clock_crosses_final_deadline(self):
        self.assertTrue(self.check(clock=lambda: NOW+dt.timedelta(seconds=2701))['needsAttention'])
        self.assert_no_side_effects()

    def test_latest_generation_change_before_claim_stops_repair(self):
        original = self.store.read; reads = 0
        def racing(name):
            nonlocal reads
            result = original(name)
            if name == self.prefix+'receipt.json':
                reads += 1
                if reads == 2:  # after the initial consistency read and first evidence snapshot
                    self.put(self.public, 'weekly/latest.html', self.public_raw, self.public_metadata)
            return result
        self.store.read = racing
        self.assertTrue(self.check()['needsAttention'])
        self.assert_no_side_effects()

    def test_latest_change_after_claim_is_detected_without_overwriting_html(self):
        original = self.store.claim
        def racing(name, value):
            created = original(name, value)
            changed = {**self.public_metadata, 'started_at': (NOW+dt.timedelta(minutes=5)).isoformat()}
            self.put(self.public, 'weekly/latest.html', self.public_raw, changed)
            return created
        self.store.claim = racing
        self.assertTrue(self.check()['needsAttention'])
        self.assertEqual(self.calls, [])
        self.assertEqual(self.writes, [(self.private, self.prefix+'publication.json')])

    def test_two_concurrent_repairs_create_one_identical_receipt(self):
        import concurrent.futures, threading
        barrier = threading.Barrier(2)
        self.before_write = lambda key: barrier.wait(timeout=2)
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: self.check(), range(2)))
        self.assertEqual(len(self.attempts), 2)
        self.assertEqual(len(self.writes), 1)
        self.assertTrue(all(not result['needsAttention'] for result in results))
        self.assertEqual(self.calls, [])

    def test_concurrent_conflicting_receipt_wins_but_is_not_overwritten(self):
        original = self.store.claim
        def racing(name, value):
            self.put(self.private, name, {**value, 'htmlSha256': '0'*64})
            return original(name, value)
        self.store.claim = racing
        self.assertTrue(self.check()['needsAttention'])
        self.assert_no_side_effects()

    def test_identical_receipt_appears_between_initial_check_and_missing_read(self):
        original_read = self.store.read; reads = 0
        name = self.prefix+'publication.json'
        def racing(path):
            nonlocal reads
            if path == name:
                reads += 1
                if reads == 2:
                    self.store.claim(name, {**self.receipt, 'latestEntryStatus': 'already_current',
                        'publicEntryStatus': 'already_current', 'recoveredPublication': True})
            return original_read(path)
        self.store.read = racing
        self.assertFalse(self.check()['needsAttention'])
        self.assertEqual(self.writes, [(self.private, name)])
        self.assertEqual(self.calls, [])

    def test_original_publisher_finishing_during_repair_is_recognized_as_current(self):
        original_read = self.store.read; reads = 0
        name = self.prefix+'publication.json'
        def racing(path):
            nonlocal reads
            if path == name:
                reads += 1
                if reads == 2:
                    self.store.claim(name, {**self.receipt, 'latestEntryStatus': 'updated',
                                           'publicEntryStatus': 'updated'})
            return original_read(path)
        self.store.read = racing
        self.assertFalse(self.check()['needsAttention'])
        self.assertEqual(self.writes, [(self.private, name)])
        self.assertEqual(self.calls, [])

    def test_concurrent_receipt_source_date_or_immutable_field_conflict_stops(self):
        import copy
        baseline = copy.deepcopy(self.objects)
        for field, value in (('privateReportObject', 'weekly/wrong/report.html'),
                             ('cutoff', '2026-09-01'), ('completedAt', 'tampered')):
            with self.subTest(field=field):
                self.objects = copy.deepcopy(baseline); self.writes = []; self.calls = []
                original_read = self.store.read; reads = 0
                name = self.prefix+'publication.json'
                def racing(path):
                    nonlocal reads
                    if path == name:
                        reads += 1
                        if reads == 2:
                            self.store.claim(name, {**self.receipt, 'latestEntryStatus': 'updated',
                                'publicEntryStatus': 'updated', field: value})
                    return original_read(path)
                self.store.read = racing
                self.assertTrue(self.check()['needsAttention'])
                self.assertEqual(self.writes, [(self.private, name)])
                self.assertEqual(self.calls, [])
                self.store.read = original_read

    def test_slow_lease_read_crossing_deadline_cannot_create_receipt(self):
        instant = NOW+dt.timedelta(seconds=2699)
        original = self.store.active_lease; checks = 0
        def delayed(now):
            nonlocal instant, checks
            checks += 1
            result = original(now)
            if checks == 2: instant = NOW+dt.timedelta(seconds=2701)
            return result
        self.store.active_lease = delayed
        self.assertTrue(self.check(now=instant, clock=lambda: instant)['needsAttention'])
        self.assert_no_side_effects()

    def test_active_source_or_publisher_lease_defers_repair_until_expiry(self):
        minute = int(self.now.timestamp()) // 60
        for slot in range(minute, minute+21):
            self.put(self.private, 'weekly/control/leases/'+str(slot)+'.json',
                     {'prefix': self.prefix, 'expiresAt': (self.now+dt.timedelta(minutes=20)).isoformat()})
        result = self.check()
        self.assertEqual(result, {'code': 'active_lease', 'needsAttention': False})
        self.assert_no_side_effects()

    def test_expired_lease_is_preserved_and_does_not_block_receipt_only_repair(self):
        minute = int(self.now.timestamp()) // 60
        name = 'weekly/control/leases/'+str(minute)+'.json'
        lease = {'prefix': self.prefix, 'expiresAt': (self.now-dt.timedelta(seconds=1)).isoformat()}
        self.put(self.private, name, lease)
        self.assertEqual(self.check()['code'], 'publication_receipt_repaired')
        self.assertEqual(self.store.read(name), lease)
        self.assertEqual(self.writes, [(self.private, self.prefix+'publication.json')])

    def test_new_active_lease_before_claim_stops_repair_without_writes(self):
        original = self.store.active_lease; checks = 0
        def racing(now):
            nonlocal checks
            checks += 1
            if checks == 2:
                minute = int(now.timestamp()) // 60
                self.put(self.private, 'weekly/control/leases/'+str(minute)+'.json',
                         {'prefix': self.prefix, 'expiresAt': (now+dt.timedelta(minutes=20)).isoformat()})
            return original(now)
        self.store.active_lease = racing
        self.assertTrue(self.check()['needsAttention'])
        self.assert_no_side_effects()

    def test_permission_failure_does_not_retry_or_run_sources(self):
        self.store.claim = lambda *a: (_ for _ in ()).throw(PermissionError('synthetic'))
        with self.assertRaises(PermissionError): self.check()
        self.assert_no_side_effects()

if __name__ == '__main__': unittest.main()
