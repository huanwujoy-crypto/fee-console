import base64
import copy
from datetime import datetime, timedelta, timezone
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import threading
import unittest
from unittest.mock import patch

import benchmark
from benchmark import WORKFLOW, WORKFLOW_ID, cache_state, run_benchmark, session
from clock import ClockError, REPO, runtime_route
import runtime
from runtime import BenchmarkGithub, BenchmarkStore
from test_clock import FakeHttp

NOW = datetime(2026, 10, 14, 22, tzinfo=timezone.utc)  # NY18:00 / HKT06:00.


def cache(day='2026-10-13'):
    return {'sha256': 'c' * 64, 'cache': {'v': 1, 'source': benchmark.SOURCE, 'benchmarks': {
        key: {'symbol': symbol, 'currency': 'USD', 'exchange': market, 'series': [{'d': day, 'p': 103}]}
        for key, symbol, market in [('spy', 'SPY', 'NYSEArca'), ('qqq', 'QQQ', 'NasdaqGS')]}}}


def run(run_id=41, status='queued', conclusion=None, created=NOW):
    return {'id': run_id, 'workflow_id': WORKFLOW_ID, 'repository': {'full_name': REPO},
            'head_branch': 'main', 'head_sha': 'a' * 40, 'event': 'workflow_dispatch',
            'status': status, 'conclusion': conclusion, 'created_at': created.isoformat().replace('+00:00', 'Z')}


class Github:
    def __init__(self):
        self.value = cache()
        self.rows = []
        self.posts = 0
        self.reads = 0
        self.post_error = None
        self.complete_on_poll = False
        self.incomplete = False
        self.no_started_job = False

    def cache(self):
        self.reads += 1
        return copy.deepcopy(self.value)

    def workflow(self):
        self.reads += 1
        return {'id': WORKFLOW_ID, 'path': '.github/workflows/' + WORKFLOW, 'state': 'active'}

    def main(self):
        return {'object': {'sha': 'a' * 40}}

    def runs(self, created=None, status=None):
        rows = self.rows if created else [row for row in self.rows if row['status'] == status]
        return {'total_count': len(rows) + int(self.incomplete), 'workflow_runs': copy.deepcopy(rows)}

    def jobs(self, run_id):
        return {'total_count': 1, 'jobs': [{'id': 77, 'run_id': run_id, 'name': 'refresh',
            'status': 'queued' if self.no_started_job else 'in_progress',
            'started_at': None if self.no_started_job else '2026-10-14T22:00:00Z'}]}

    def dispatch(self):
        self.posts += 1
        if self.post_error:
            raise ClockError(self.post_error)
        rid = 40 + self.posts
        self.rows.append(run(rid, created=NOW + timedelta(hours=self.posts - 1)))
        return rid

    def run(self, rid):
        row = next(row for row in self.rows if row['id'] == rid)
        if self.complete_on_poll:
            row.update(status='completed', conclusion='success')
            self.value = cache('2026-10-14')
        return copy.deepcopy(row)


class Store:
    def __init__(self):
        self.intents = {}
        self.results = {}
        self.lock = threading.Lock()

    def read_benchmark_intent(self, target, attempt):
        return copy.deepcopy(self.intents.get((target, attempt)))

    def read_benchmark_result(self, target, attempt):
        return copy.deepcopy(self.results.get((target, attempt)))

    def claim_benchmark(self, value):
        key = (value['targetDate'], value['attempt'])
        with self.lock:
            if key in self.intents:
                return False
            self.intents[key] = copy.deepcopy(value)
            return True

    def benchmark_result(self, value):
        self.results[(value['targetDate'], value['attempt'])] = copy.deepcopy(value)


class BenchmarkTests(unittest.TestCase):
    def setUp(self):
        self.github, self.store = Github(), Store()

    def go(self, mode='launch', now=NOW, **kwargs):
        return run_benchmark(mode, now, self.github, self.store, enabled=True, **kwargs)

    def test_disabled_reads_neither_calendar_nor_network(self):
        with patch('benchmark.calendar', side_effect=AssertionError('unexpected calendar')):
            self.assertEqual(run_benchmark('launch', NOW, self.github, self.store)['outcome'], 'disabled')
        self.assertEqual(self.github.reads, 0)

    def test_dst_selects_ny1800_not_a_fixed_hkt_hour(self):
        summer = session(NOW)
        winter = session(datetime(2026, 11, 4, 23, tzinfo=timezone.utc))
        self.assertEqual(summer['primaryAt'].astimezone(benchmark.HK).hour, 6)
        self.assertEqual(winter['primaryAt'].astimezone(benchmark.HK).hour, 7)
        self.assertEqual(summer['targetDate'], '2026-10-14')
        self.assertEqual(winter['targetDate'], '2026-11-04')

    def test_reviewed_holiday_early_close_and_expiry(self):
        holiday = session(datetime(2026, 11, 26, 23, tzinfo=timezone.utc))
        self.assertEqual(holiday['targetDate'], '2026-11-25')
        early = session(datetime(2026, 11, 27, 18, 15, tzinfo=timezone.utc))
        self.assertEqual(early['eligibleAt'].hour, 13)
        self.assertEqual(early['primaryAt'].hour, 18)
        with self.assertRaisesRegex(ClockError, 'CALENDAR_UNAVAILABLE'):
            session(datetime(2027, 1, 6, 23, tzinfo=timezone.utc))

    def test_winter0600_does_not_fetch_or_claim(self):
        value = self.go(now=datetime(2026, 11, 4, 22, tzinfo=timezone.utc))
        self.assertEqual(value['outcome'], 'before-primary')
        self.assertEqual(self.github.reads, 0)
        self.assertFalse(self.store.intents)

    def test_verified_cache_is_reused_without_dispatch_or_claim(self):
        self.github.value = cache('2026-10-14')
        self.assertTrue(self.go()['benchmarkReady'])
        self.assertEqual(self.github.posts, 0)
        self.assertFalse(self.store.intents)

    def test_cache_requires_both_target_rows_and_exact_identity(self):
        value = cache('2026-10-14');value['cache']['benchmarks']['qqq']['series'][0]['d'] = '2026-10-13'
        self.assertEqual(cache_state(value, session(NOW))['missingSymbols'], ['QQQ'])
        for field, wrong in [('symbol', 'TQQQ'), ('currency', 'HKD'), ('exchange', 'LSE')]:
            with self.subTest(field=field):
                value = cache('2026-10-14');value['cache']['benchmarks']['qqq'][field] = wrong
                with self.assertRaisesRegex(ClockError, 'CACHE_INVALID'):
                    cache_state(value, session(NOW))

    def test_future_duplicate_and_nonfinite_rows_are_not_ready(self):
        for points in ([{'d':'2026-10-15','p':103}], [{'d':'2026-10-14','p':float('inf')}],
                       [{'d':'2026-10-14','p':103},{'d':'2026-10-14','p':103}]):
            value=cache();value['cache']['benchmarks']['spy']['series']=points
            with self.assertRaisesRegex(ClockError, 'CACHE_INVALID'):
                cache_state(value, session(NOW))

    def test_boolean_schema_version_cannot_pass_the_js_v1_gate(self):
        value = cache('2026-10-14');value['cache']['v'] = True
        with self.assertRaisesRegex(ClockError, 'CACHE_INVALID'):
            cache_state(value, session(NOW))

    def test_missing_intermediate_session_is_pending_even_with_target_tail(self):
        value = cache('2026-10-14')
        value['cache']['benchmarks']['spy']['series'].insert(0, {'d': '2026-10-09', 'p': 100})
        self.assertEqual(cache_state(value, session(NOW))['missingSymbols'], ['SPY'])

    def test_one_claim_and_known_live_run_prevent_duplicate_post(self):
        self.go();self.go()
        self.assertEqual(self.github.posts, 1)
        self.assertEqual(len(self.store.intents), 1)

    def test_existing_natural_run_is_reused(self):
        self.github.rows=[run()];self.github.rows[0]['event']='schedule'
        self.assertEqual(self.go()['outcome'], 'active-run-reused')
        self.assertEqual(self.github.posts, 0)
        self.assertFalse(self.store.intents)

    def test_uncertain_post_leaves_claim_and_never_resends(self):
        self.github.post_error='BENCHMARK_DISPATCH_UNCERTAIN'
        with self.assertRaisesRegex(ClockError, 'DISPATCH_UNCERTAIN'):self.go()
        self.github.post_error=None
        with self.assertRaisesRegex(ClockError, 'DISPATCH_UNRESOLVED'):self.go()
        self.assertEqual(self.github.posts, 1)

    def test_second_attempt_requires_definite_first_failure_and_due_time(self):
        self.go();self.github.rows[0].update(status='completed',conclusion='failure')
        self.assertEqual(self.go(now=NOW+timedelta(minutes=1))['outcome'], 'retry-not-due')
        self.go(now=NOW+timedelta(hours=1))
        self.assertEqual(self.github.posts, 2)
        self.github.rows[1].update(status='completed',conclusion='failure')
        with self.assertRaisesRegex(ClockError, 'SECOND_FAILURE'):
            self.go(now=NOW+timedelta(hours=2))
        self.assertEqual(self.github.posts, 2)

    def test_two_natural_failures_also_alert_without_more_posts(self):
        self.github.rows=[run(11,'completed','failure'),run(12,'completed','failure')]
        with self.assertRaisesRegex(ClockError, 'SECOND_FAILURE'):self.go()
        self.assertEqual(self.github.posts, 0)

    def test_two_failures_appearing_after_claim_prevent_dispatch(self):
        original = self.store.claim_benchmark
        def claim(value):
            won = original(value)
            self.github.rows = [run(11, 'completed', 'failure'), run(12, 'completed', 'failure')]
            return won
        with patch.object(self.store, 'claim_benchmark', side_effect=claim):
            with self.assertRaisesRegex(ClockError, 'SECOND_FAILURE'):
                self.go()
        self.assertEqual(self.github.posts, 0)

    def test_success_without_exact_target_is_an_error(self):
        self.github.rows=[run(11,'completed','success')]
        with self.assertRaisesRegex(ClockError, 'SUCCESS_WITHOUT_TARGET'):self.go()
        self.assertEqual(self.github.posts, 0)

    def test_natural_completion_during_metadata_read_reuses_new_cache(self):
        original = self.github.workflow
        def completed():
            self.github.value = cache('2026-10-14')
            self.github.rows = [run(11, 'completed', 'success')]
            return original()
        with patch.object(self.github, 'workflow', side_effect=completed):
            self.assertTrue(self.go()['benchmarkReady'])
        self.assertEqual(self.github.posts, 0)
        self.assertFalse(self.store.intents)

    def test_known_dispatch_id_survives_main_moving_before_post(self):
        self.go()
        self.github.rows[0].update(head_sha='b' * 40, status='completed', conclusion='failure')
        with patch.object(self.github, 'main', return_value={'object': {'sha': 'b' * 40}}):
            self.go(now=NOW + timedelta(hours=1))
        self.assertEqual(self.github.posts, 2)
        self.assertEqual(self.store.results[('2026-10-14', 1)]['runId'], 41)

    def test_result_identity_mismatch_cannot_authorize_retry(self):
        for change in ({'mainSha': 'b' * 40}, {'runId': True}, {'outcome': 'other'}):
            with self.subTest(change=change):
                self.github, self.store = Github(), Store()
                self.go();self.github.rows[0].update(status='completed', conclusion='failure')
                self.store.results[('2026-10-14', 1)].update(change)
                with self.assertRaisesRegex(ClockError, 'RESULT_INVALID'):
                    self.go(now=NOW + timedelta(hours=1))
                self.assertEqual(self.github.posts, 1)

    def test_queued_job_after_five_minutes_is_not_a_started_job(self):
        self.github.rows=[run()];self.github.no_started_job=True
        with self.assertRaisesRegex(ClockError, 'REQUESTED_NOT_STARTED'):
            self.go(now=NOW+timedelta(minutes=5))

    def test_queued_job_with_started_timestamp_still_has_not_started(self):
        self.github.rows = [run()]
        original = self.github.jobs
        def jobs(rid):
            result = original(rid);result['jobs'][0]['status'] = 'queued'
            return result
        with patch.object(self.github, 'jobs', side_effect=jobs):
            with self.assertRaisesRegex(ClockError, 'REQUESTED_NOT_STARTED'):
                self.go(now=NOW + timedelta(minutes=5))
        self.assertEqual(self.github.posts, 0)

    def test_completed_job_requires_real_conclusion(self):
        self.github.rows = [run()]
        original = self.github.jobs
        def jobs(rid):
            result = original(rid);result['jobs'][0].update(status='completed', conclusion=None)
            return result
        with patch.object(self.github, 'jobs', side_effect=jobs):
            with self.assertRaisesRegex(ClockError, 'METADATA_INVALID'):
                self.go()

    def test_reused_active_run_is_followed_until_not_started_threshold(self):
        self.github.rows = [run()];self.github.no_started_job = True
        clock = [NOW]
        def wait(seconds):clock[0] += timedelta(seconds=seconds)
        with self.assertRaisesRegex(ClockError, 'REQUESTED_NOT_STARTED'):
            self.go(current_time=lambda: clock[0], wait=wait)
        self.assertEqual(clock[0] - NOW, timedelta(minutes=5))
        self.assertEqual(self.github.posts, 0)
        self.assertFalse(self.store.intents)

    def test_job_start_during_metadata_request_is_not_a_future_timestamp(self):
        self.github.rows = [run()];clock = [NOW]
        def jobs(rid):
            clock[0] += timedelta(seconds=9)
            return {'total_count': 1, 'jobs': [{'id': 77, 'run_id': rid, 'name': 'refresh',
                    'status': 'in_progress', 'started_at': benchmark.stamp(clock[0])}]}
        with patch.object(self.github, 'jobs', side_effect=jobs):
            self.assertEqual(self.go(current_time=lambda: clock[0])['outcome'], 'active-run-reused')

    def test_nine_second_http_model_fits_task_budget_and_detects_unstarted(self):
        clock = [NOW];lock = threading.Lock();dispatch_times = []
        def advance(seconds):
            with lock:clock[0] += timedelta(seconds=seconds)
        def wrap(owner, name, charge):
            original = getattr(owner, name)
            def wrapped(*args, **kwargs):
                advance(charge(*args, **kwargs));return original(*args, **kwargs)
            setattr(owner, name, wrapped)
        # All fake HTTPs take9s; charge one9s batch for the five parallel lists.
        for name, seconds in [('cache', 18), ('workflow', 9), ('main', 9), ('run', 9), ('jobs', 9)]:
            wrap(self.github, name, lambda *args, seconds=seconds, **kwargs: seconds)
        wrap(self.github, 'runs', lambda created=None, status=None: 9 if created or status == 'queued' else 0)
        token_ready = [False]
        def store_charge(*args, **kwargs):
            charge = 9 if token_ready[0] else 18;token_ready[0] = True;return charge
        for name in ('read_benchmark_intent', 'read_benchmark_result', 'claim_benchmark', 'benchmark_result'):
            wrap(self.store, name, store_charge)
        def dispatch():
            advance(9);self.github.posts += 1;dispatch_times.append(clock[0])
            self.github.rows.append(run(41, created=clock[0]));return 41
        self.github.dispatch = dispatch;self.github.no_started_job = True
        with self.assertRaisesRegex(ClockError, 'REQUESTED_NOT_STARTED'):
            self.go(current_time=lambda: clock[0], wait=advance)
        elapsed = (clock[0] - NOW).total_seconds()
        self.assertGreaterEqual((clock[0] - dispatch_times[0]).total_seconds(), 300)
        proposal = json.loads(Path(__file__).with_name('benchmark-plan.json').read_text())
        self.assertLess(elapsed, proposal['persistentChangesRequiringSeparateExplicitActivationApproval']['fee-clock-launch']['timeoutAfterSeconds'])
        self.assertEqual(self.github.posts, 1)

    def test_deadline_is_readonly_and_missing_data_fails(self):
        with self.assertRaisesRegex(ClockError, 'NOT_REQUESTED'):
            self.go('check', now=NOW+timedelta(hours=3))
        self.assertEqual(self.github.posts, 0)

    def test_completed_workflow_is_followed_to_verified_cache(self):
        self.github.complete_on_poll=True
        value=self.go(wait=lambda seconds: self.fail('unneeded sleep'))
        self.assertTrue(value['benchmarkReady'])
        self.assertEqual(value['outcome'], 'verified-target-complete')
        self.assertEqual(self.github.posts,1)

    def test_polling_not_started_alerts_after_five_minutes_without_resend(self):
        clock=[NOW];self.github.no_started_job=True
        def wait(seconds):clock[0]+=timedelta(seconds=seconds)
        with self.assertRaisesRegex(ClockError,'REQUESTED_NOT_STARTED'):
            self.go(current_time=lambda:clock[0],wait=wait)
        self.assertEqual(clock[0]-NOW,timedelta(minutes=5))
        self.assertEqual(self.github.posts,1)

    def test_wrong_actual_job_identity_cannot_prove_started(self):
        self.github.rows=[run()]
        with patch.object(self.github,'jobs',return_value={'total_count':1,'jobs':[
            {'id':77,'run_id':999,'name':'refresh','status':'in_progress','started_at':'2026-10-14T22:00:00Z'}]}):
            with self.assertRaisesRegex(ClockError,'METADATA_INVALID'):self.go()

    def test_skipped_or_cancelled_deadline_is_reported_without_retry(self):
        for conclusion,code in [('skipped','SKIPPED'),('cancelled','CANCELLED')]:
            self.github.rows=[run(11,'completed',conclusion)]
            with self.assertRaisesRegex(ClockError,code):self.go('check',now=NOW+timedelta(hours=3))
        self.assertEqual(self.github.posts,0)

    def test_incomplete_metadata_list_is_not_evidence_of_no_run(self):
        self.github.incomplete=True
        with self.assertRaisesRegex(ClockError, 'LIST_INCOMPLETE'):self.go()
        self.assertEqual(self.github.posts,0)

    def test_only_first_two_acquisition_hours_can_dispatch(self):
        value=self.go(now=NOW+timedelta(hours=2))
        self.assertEqual(value['outcome'],'pending-before-deadline')
        self.assertEqual(self.github.posts,0)

    def test_actual_fee_slots_ignore_calendar_module_even_when_enabled(self):
        for at,mode in [('2026-10-15T02:00:00+00:00','launch'),('2026-10-15T02:05:00+00:00','check-start')]:
            with patch.dict(os.environ,{'FEE_CLOCK_ENABLED':'true','FEE_BENCHMARK_CLOCK_ENABLED':'true'},clear=True), \
                 patch.object(runtime.sys,'argv',['runtime.py',mode]),patch.object(runtime,'datetime') as clock, \
                 patch.object(runtime,'run_clock',return_value={'outcome':'original-fee'}) as old, \
                 patch.dict('sys.modules',{'benchmark':None}),patch('sys.stdout',new=io.StringIO()):
                clock.now.return_value=datetime.fromisoformat(at)
                self.assertEqual(runtime.main(),0);old.assert_called_once()

    def test_exact_clock_routes_and_explicit_cartesian_noops(self):
        for hour,minute,mode,expected in [(6,0,'launch','benchmark-launch'),(7,0,'launch','benchmark-launch'),
            (8,0,'launch','benchmark-launch'),(9,0,'check-start','benchmark-check'),
            (9,5,'check-start','benchmark-check'),(10,0,'check-start','no-op'),(10,0,'launch','fee'),(10,5,'check-start','fee')]:
            # Use one fixed HKT calendar day for the complete cron matrix.
            at=datetime(2026,10,15,hour,minute,tzinfo=benchmark.HK)
            self.assertEqual(runtime_route(mode,at,True),expected)
        self.assertEqual(runtime_route('launch',NOW,False),'fee')
        delayed=datetime(2026,10,15,9,8,tzinfo=benchmark.HK)
        self.assertEqual(runtime_route('check-start',delayed,True),'benchmark-check')

    @unittest.skipUnless(shutil.which('node'), 'Node is required by the complete validation workflow')
    def test_python_controller_and_actual_js_writer_agree_on_session_boundaries(self):
        values=['2026-03-06T23:00:00Z','2026-03-09T22:00:00Z','2026-04-03T22:00:00Z',
                '2026-07-03T22:00:00Z','2026-10-14T20:14:59Z','2026-10-14T20:15:00Z',
                '2026-10-18T14:00:00Z','2026-11-04T23:00:00Z','2026-11-26T23:00:00Z',
                '2026-11-27T18:14:59Z','2026-11-27T18:15:00Z','2026-12-26T02:00:00Z']
        code="import fs from 'node:fs';import {expectedBenchmarkTargetDate as target} from './scripts/refresh-benchmark-cache.mjs';const dates=JSON.parse(fs.readFileSync(0,'utf8'));process.stdout.write(JSON.stringify(dates.map(x=>target(new Date(x)))));"
        result=subprocess.run(['node','--input-type=module','-e',code],input=json.dumps(values),
            cwd=Path(__file__).resolve().parents[2],capture_output=True,text=True,timeout=15,check=True)
        expected=[session(datetime.fromisoformat(value.replace('Z','+00:00')))['targetDate'] for value in values]
        self.assertEqual(json.loads(result.stdout),expected)

    def test_proposed_activation_adds_no_resources_or_authority_and_preserves_fee_dates(self):
        proposal=json.loads(Path(__file__).with_name('benchmark-plan.json').read_text())
        scope=proposal['existingResourcesOnly']
        for name in ('newJobs','newSchedulers','newServiceAccounts','newSecretsOrTokenScopes','newBuckets','newIamGrants','newAlertPoliciesOrRecipients'):
            self.assertEqual(scope[name],0)
        self.assertFalse(scope['checkerHasSecretOrDispatchAuthority'])
        self.assertFalse(proposal['feeBoundary']['feeSourceDatesFeesAmountsOrWriterChanged'])
        self.assertFalse(proposal['persistentChangesRequiringSeparateExplicitActivationApproval']['githubCronChanged'])
        price=proposal['costEstimateUsd'];unit=price['cpuPerSecond']+price['memoryGiB']*price['memoryPerGiBSecond']
        self.assertAlmostEqual(23*(4*600+4*120)*unit+.2+.06+.000276,price['baseAtAllConfiguredTimeouts'],places=6)


class AdapterTests(unittest.TestCase):
    def test_only_fixed_benchmark_main_dispatch_and_no_readonly_post(self):
        http=FakeHttp([(204,None)])
        client=BenchmarkGithub(http,lambda:'synthetic',authenticated=True)
        self.assertIsNone(client.dispatch())
        url,request=http.calls[0]
        self.assertTrue(url.endswith('/actions/workflows/benchmark-cache.yml/dispatches'))
        self.assertEqual(request['body'],{'ref':'main'});self.assertTrue(request['uncertain'])
        with self.assertRaisesRegex(ClockError,'SCOPE'):
            BenchmarkGithub(FakeHttp([]),lambda:self.fail('credential read')).dispatch()

    def test_cache_pins_blob_identity_and_never_sends_actions_token(self):
        raw=json.dumps(cache()['cache']).encode()
        blob=hashlib.sha1(b'blob '+str(len(raw)).encode()+b'\0'+raw).hexdigest()
        contents={'type':'file','path':'benchmark-close.json','encoding':'base64','size':len(raw),
                  'sha':blob,'content':base64.b64encode(raw).decode()}
        http=FakeHttp([(200,{'object':{'sha':'a'*40}}),(200,contents)])
        value=BenchmarkGithub(http,lambda:self.fail('unneeded token'),authenticated=True).cache()
        self.assertEqual(value['sha256'],hashlib.sha256(raw).hexdigest())
        self.assertIn('ref='+'a'*40,http.calls[1][0])
        self.assertTrue(all('Authorization' not in call[1]['headers'] for call in http.calls))

    def test_invalid_blob_or_redirect_cannot_be_ready(self):
        http=FakeHttp([(302,{})])
        with self.assertRaisesRegex(ClockError,'CACHE_READ_HTTP_302'):
            BenchmarkGithub(http).cache()

    def test_benchmark_claims_are_append_only_and_separate_from_fee_intents(self):
        http=FakeHttp([(201,{})]);store=BenchmarkStore(http);store._bearer='synthetic'
        value={'targetDate':'2026-10-14','attempt':1}
        self.assertTrue(store.claim_benchmark(value))
        url,request=http.calls[0]
        self.assertIn('ifGenerationMatch=0',url)
        self.assertIn('v1%2Fbenchmark-intent%2F2026-10-14%2F1.json',url)
        with self.assertRaisesRegex(ClockError,'SCOPE'):
            store.read_benchmark_intent('2026-10-14',3)

    def test_known_result_read_uses_only_the_fixed_append_only_target_path(self):
        http = FakeHttp([(200, {'runId': 41})]);store = BenchmarkStore(http);store._bearer = 'synthetic'
        self.assertEqual(store.read_benchmark_result('2026-10-14', 1), {'runId': 41})
        url, request = http.calls[0]
        self.assertIn('v1%2Fbenchmark-result%2F2026-10-14%2F1.json?alt=media', url)
        self.assertNotIn('method', request)


if __name__=='__main__':unittest.main()
