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

if __name__ == '__main__': unittest.main()
