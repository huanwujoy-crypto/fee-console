import copy
from datetime import datetime, timedelta, timezone
import io
import json
import threading
import unittest
import urllib.error
from clock import ClockError, REPO, WORKFLOW, WORKFLOW_ID, target_date, plan, run_clock
from runtime import Github, Http, Store, parse_args


NOW = datetime(2026, 10, 14, 1, 0, tzinfo=timezone.utc)
CHECK = NOW + timedelta(minutes=5)
EARLY = datetime(2026, 10, 13, 23, 30, tzinfo=timezone.utc)


def confirmation(target='2026-10-13', at='2026-10-13T23:29:00Z', request_id='synthetic-confirmation-1'):
    return {'targetDate': target, 'confirmedAt': at, 'requestId': request_id, 'expectedMain': 'a' * 40}


def run_row(run_id=11, status='queued', event='workflow_dispatch', created='2026-10-14T01:00:00Z'):
    return {'id': run_id, 'workflow_id': WORKFLOW_ID, 'repository': {'full_name': REPO},
            'head_branch': 'main', 'status': status, 'event': event, 'created_at': created}


class FakeGithub:
    def __init__(self):
        self.day = []
        self.active = {}
        self.job = {}
        self.post_count = 0
        self.read_count = 0
        self.query_count = 0
        self.run_queries = []
        self.job_queries = []
        self.post_error = None
        self.result = 41
        self.lock = threading.Lock()
        self.after_claim = None
        self.incomplete = False
        self.state = 'active'
        self.main_sha = 'a' * 40
        self.confirmed = []

    def workflow(self):
        self.read_count += 1
        return {'id': WORKFLOW_ID, 'path': '.github/workflows/' + WORKFLOW, 'state': self.state}

    def main(self):
        return {'object': {'sha': self.main_sha}}

    def runs(self, created=None, status=None):
        with self.lock:
            self.run_queries.append({'created': created, 'status': status})
            if created is not None:
                self.query_count += 1
                if self.query_count == 2 and self.after_claim:
                    self.day = self.after_claim
            rows = copy.deepcopy(self.day if created else self.active.get(status, []))
        return {'total_count': len(rows) + int(self.incomplete), 'workflow_runs': rows}

    def jobs(self, run_id):
        self.job_queries.append(run_id)
        rows = copy.deepcopy(self.job.get(run_id, []))
        return {'total_count': len(rows), 'jobs': rows}

    def dispatch(self):
        self.post_count += 1
        if self.post_error:
            raise ClockError(self.post_error)
        return self.result

    def dispatch_confirmed(self, request):
        self.confirmed.append(copy.deepcopy(request))
        return self.dispatch()


class FakeStore:
    def __init__(self):
        self.intents = {}
        self.results = {}
        self.lock = threading.Lock()
        self.error = None
        self.after_claim = None
        self.result_error = False

    def claim(self, value):
        with self.lock:
            if self.error:
                raise ClockError(self.error)
            if value['targetDate'] in self.intents:
                return False
            self.intents[value['targetDate']] = copy.deepcopy(value)
        if self.after_claim:
            self.after_claim()
        return True

    def read_intent(self, target):
        return copy.deepcopy(self.intents.get(target))

    def result(self, value):
        if self.result_error:
            raise ClockError('NETWORK_OR_RESPONSE')
        self.results[value['targetDate']] = copy.deepcopy(value)


class ClockTests(unittest.TestCase):
    def setUp(self):
        self.github, self.store = FakeGithub(), FakeStore()

    def go(self, mode='launch', now=NOW, **kwargs):
        return run_clock(mode, now, self.github, self.store, enabled=True, **kwargs)

    def error(self, code, **kwargs):
        with self.assertRaisesRegex(ClockError, '^FEE_CLOCK_' + code + '$'):
            self.go(**kwargs)

    def test_default_off_reads_nothing(self):
        self.assertEqual(run_clock('launch', NOW, self.github, self.store)['outcome'], 'disabled')
        self.assertEqual(self.github.read_count, 0)

    def nonfee_completed(self, name='ratio'):
        row=run_row(status='completed'); row['display_title']='Manual ratio snapshot'
        self.github.day=[row]
        self.github.job[11]=[
            {'id':21,'run_id':11,'name':'period','status':'completed','conclusion':'skipped'},
            {'id':22,'run_id':11,'name':'Produce  ','status':'completed','conclusion':'skipped'},
            {'id':23,'run_id':11,'name':name,'status':'completed','conclusion':'success'}]

    def test_completed_ratio_only_run_is_not_a_fee_launch(self):
        self.nonfee_completed()
        self.assertEqual(self.go()['outcome'],'dispatch-accepted')
        self.assertEqual(self.github.post_count,1)
        self.assertEqual(self.go()['outcome'],'intent-already-exists')
        self.assertEqual(self.github.post_count,1)

    def test_completed_public_plan_check_is_not_a_fee_launch(self):
        self.nonfee_completed('Public source plan check 2026-10-13')
        self.assertEqual(self.go()['outcome'],'dispatch-accepted')

    def test_completed_source_probe_with_all_production_skipped_is_not_a_fee_launch(self):
        self.nonfee_completed('Fee source probe')
        self.github.day[0]['display_title']='Fee source probe'
        self.assertEqual(self.go()['outcome'],'dispatch-accepted')
        self.assertEqual(self.github.post_count,1)

    def test_source_probe_name_cannot_hide_a_period_or_produce_attempt(self):
        for index in (0, 1):
            self.setUp()
            self.nonfee_completed('Fee source probe')
            self.github.job[11][index]['conclusion']='success'
            self.assertEqual(self.go()['outcome'],'already-requested')
            self.assertEqual(self.github.post_count,0)

    def test_active_source_probe_still_blocks_shared_producer_concurrency(self):
        row=run_row(status='in_progress'); row['display_title']='Fee source probe'
        self.github.active['in_progress']=[row]
        self.error('PRODUCER_BUSY')
        self.assertEqual(self.github.post_count,0)

    def test_nonfee_title_does_not_hide_a_real_fee_attempt(self):
        self.nonfee_completed()
        self.github.job[11][0]['conclusion']='success'
        self.assertEqual(self.go()['outcome'],'already-requested')
        self.assertEqual(self.github.post_count,0)

    def test_incomplete_nonfee_jobs_fail_closed_without_dispatch(self):
        self.nonfee_completed()
        self.github.job[11][1]['run_id']=99
        self.error('METADATA_INVALID')
        self.assertEqual(self.github.post_count,0)

    def test_active_ratio_still_blocks_shared_producer_concurrency(self):
        self.github.active['in_progress']=[run_row(status='in_progress')]
        self.error('PRODUCER_BUSY')
        self.assertEqual(self.github.post_count,0)

    def test_old_ten_am_window_cannot_create_a_late_clock_attempt(self):
        self.error('OUTSIDE_WINDOW',now=NOW+timedelta(hours=1))

    def test_launch_once_and_duplicate_scheduler_delivery(self):
        self.assertEqual(self.go()['runId'], 41)
        self.assertEqual(self.go()['outcome'], 'intent-already-exists')
        self.assertEqual(self.github.post_count, 1)

    def test_scheduled_launch_keeps_both_complete_run_checks(self):
        self.assertEqual(self.go()['outcome'], 'dispatch-accepted')
        self.assertEqual(self.github.query_count, 2)
        self.assertEqual(len(self.github.run_queries), 12)
        for status in ('queued', 'in_progress', 'waiting', 'pending', 'requested'):
            self.assertEqual(sum(row['status'] == status for row in self.github.run_queries), 2)

    def test_concurrent_cloud_executions_share_one_claim(self):
        results = []
        def task():
            results.append(self.go()['outcome'])
        threads = [threading.Thread(target=task) for _ in range(4)]
        for thread in threads: thread.start()
        for thread in threads: thread.join()
        self.assertEqual(self.github.post_count, 1)
        self.assertEqual(results.count('dispatch-accepted'), 1)

    def test_uncertain_dispatch_persists_intent_and_never_resends(self):
        self.github.post_error = 'DISPATCH_UNCERTAIN'
        self.error('DISPATCH_UNCERTAIN')
        self.assertEqual(self.go()['outcome'], 'intent-already-exists')
        self.assertEqual(self.github.post_count, 1)

    def test_claim_failure_never_dispatches(self):
        self.store.error = 'NETWORK_OR_RESPONSE'
        self.error('NETWORK_OR_RESPONSE')
        self.assertEqual(self.github.post_count, 0)

    def test_existing_natural_run_is_reused(self):
        self.github.day = [run_row(event='schedule')]
        self.assertEqual(self.go()['outcome'], 'already-requested')
        self.assertFalse(self.store.intents)
        self.assertEqual(self.github.post_count, 0)

    def test_early_reviewed_daily_prevents_nine_am_fallback_dispatch(self):
        for status in ('queued', 'in_progress', 'completed'):
            with self.subTest(status=status):
                self.setUp()
                self.github.day = [run_row(status=status, event='workflow_dispatch',
                                          created='2026-10-13T23:30:00Z')]
                self.github.job[11] = [
                    {'id': 21, 'run_id': 11, 'name': 'period',
                     'status': 'completed', 'conclusion': 'success'},
                    {'id': 22, 'run_id': 11, 'name': 'Produce',
                     'status': status, 'conclusion': 'success' if status == 'completed' else None}]
                self.assertEqual(self.go()['outcome'], 'already-requested')
                self.assertFalse(self.store.intents)
                self.assertEqual(self.github.post_count, 0)

    def test_natural_run_appearing_after_claim_prevents_post(self):
        self.github.after_claim = [run_row(event='schedule')]
        self.assertEqual(self.go()['outcome'], 'natural-request-visible')
        self.assertEqual(self.github.post_count, 0)

    def test_previous_day_unfinished_run_blocks_launch(self):
        self.github.active['in_progress'] = [run_row(status='in_progress', created='2026-10-13T15:00:00Z')]
        self.error('PRODUCER_BUSY')
        self.assertEqual(self.github.post_count, 0)

    def test_incomplete_run_list_cannot_mean_no_run(self):
        self.github.incomplete = True
        self.error('LIST_INCOMPLETE')
        self.assertEqual(self.github.post_count, 0)

    def test_wrong_workflow_or_repo_response_cannot_dispatch(self):
        for field, value in (('workflow_id', 123), ('head_branch', 'candidate')):
            with self.subTest(field=field):
                row = run_row(); row[field] = value; self.github.day = [row]
                self.error('METADATA_INVALID')
        self.assertEqual(self.github.post_count, 0)

    def test_workflow_disabled_is_alert_and_is_never_enabled(self):
        self.github.state = 'disabled_inactivity'
        self.error('WORKFLOW_NOT_ACTIVE')
        self.assertEqual(self.github.post_count, 0)

    def test_expired_launch_window_after_reads_never_dispatches(self):
        self.error('OUTSIDE_WINDOW', current_time=lambda: NOW + timedelta(minutes=5))
        self.assertEqual(self.github.post_count, 0)

    def test_expired_window_after_claim_keeps_intent_without_dispatch(self):
        current = [NOW]
        self.store.after_claim = lambda: current.__setitem__(0, NOW + timedelta(minutes=5))
        self.error('OUTSIDE_WINDOW', current_time=lambda: current[0])
        self.assertTrue(self.store.intents)
        self.assertEqual(self.github.post_count, 0)

    def test_missing_start_reports_no_request(self):
        self.error('NOT_REQUESTED', mode='check-start', now=CHECK)

    def test_uncertain_post_not_observed_has_specific_alert(self):
        self.go()
        self.error('DISPATCH_NOT_OBSERVED', mode='check-start', now=CHECK)

    def test_queued_workflow_does_not_prove_started(self):
        self.github.day = [run_row()]
        self.error('REQUESTED_NOT_STARTED', mode='check-start', now=CHECK)

    def test_workflow_in_progress_but_actual_job_queued_is_not_started(self):
        self.github.day = [run_row(status='in_progress')]
        self.github.job[11] = [{'id': 21, 'run_id': 11, 'name': 'Produce daily 2026-10-13', 'status': 'queued', 'started_at': None}]
        self.error('REQUESTED_NOT_STARTED', mode='check-start', now=CHECK)

    def job_started(self, status='in_progress', conclusion=None):
        self.github.day = [run_row(status='in_progress')]
        self.github.job[11] = [{'id': 21, 'run_id': 11, 'name': 'Produce daily 2026-10-13', 'status': status,
                               'conclusion': conclusion, 'started_at': '2026-10-14T01:01:00Z'}]

    def test_actual_produce_job_start_is_evidence_not_publication(self):
        self.job_started()
        result = self.go(mode='check-start', now=CHECK)
        self.assertEqual(result['starts'][0]['jobId'], 21)
        self.assertFalse(result['publicationVerified'])
        self.assertEqual(self.github.post_count, 0)

    def test_skipped_actual_job_is_not_start(self):
        self.job_started('completed', 'skipped')
        self.error('REQUESTED_NOT_STARTED', mode='check-start', now=CHECK)

    def test_started_but_failed_has_distinct_alert(self):
        self.job_started('completed', 'failure')
        self.error('PRODUCER_FAILED_AFTER_START', mode='check-start', now=CHECK)

    def test_check_start_never_dispatches(self):
        self.job_started()
        self.go(mode='check-start', now=CHECK)
        self.assertEqual(self.github.post_count, 0)

    def test_dst_and_weekend_match_original_target_contract(self):
        for value, expected in (
            ('2026-10-14T01:00:00Z', '2026-10-13'),
            ('2026-11-04T02:00:00Z', '2026-11-03'),
            ('2026-10-13T02:00:00Z', '2026-10-12'),
            ('2026-10-16T20:14:00Z', '2026-10-15'),
            ('2026-10-16T20:15:00Z', '2026-10-16')):
            with self.subTest(value=value): self.assertEqual(target_date(datetime.fromisoformat(value.replace('Z', '+00:00'))), expected)
        self.assertFalse(plan('launch', NOW + timedelta(days=4))['action'])

    def test_holiday_stays_original_weekday_not_invented_calendar(self):
        self.assertEqual(target_date(datetime(2026, 12, 26, 2, tzinfo=timezone.utc)), '2026-12-25')

    def test_wrong_and_early_slots_fail_closed(self):
        for mode, now in (('launch', NOW - timedelta(seconds=1)), ('check-start', NOW),
                          ('launch', CHECK), ('check-start', CHECK + timedelta(minutes=5))):
            with self.subTest(mode=mode, now=now): self.error('OUTSIDE_WINDOW', mode=mode, now=now)


class ConfirmedClockTests(unittest.TestCase):
    def setUp(self):
        self.github, self.store = FakeGithub(), FakeStore()
        self.request = confirmation()

    def go(self, now=EARLY, **kwargs):
        return run_clock('launch-confirmed', now, self.github, self.store,
                         enabled=True, confirmation=self.request, **kwargs)

    def error(self, code, **kwargs):
        with self.assertRaisesRegex(ClockError, '^FEE_CLOCK_' + code + '$'):
            self.go(**kwargs)

    def assert_no_history_reads(self):
        self.assertEqual(self.github.run_queries, [])
        self.assertEqual(self.github.job_queries, [])

    def test_first_confirmed_request_does_not_read_runs_or_jobs(self):
        self.github.incomplete = True
        self.assertEqual(self.go()['outcome'], 'dispatch-accepted')
        self.assertEqual(self.github.post_count, 1)
        self.assert_no_history_reads()
        original_intent = copy.deepcopy(self.store.intents)
        self.request['requestId'] = 'synthetic-next-round'
        self.assertEqual(self.go()['outcome'], 'intent-already-exists')
        self.assertEqual(self.github.post_count, 1)
        self.assertEqual(self.store.intents, original_intent)
        self.assert_no_history_reads()

    def test_confirmed_entry_still_requires_active_workflow_and_valid_main(self):
        self.github.state = 'disabled_manually'
        self.error('WORKFLOW_NOT_ACTIVE')
        self.github.state = 'active'
        self.github.main_sha = 'not-a-sha'
        self.error('METADATA_INVALID')
        self.assertFalse(self.store.intents)
        self.assertEqual(self.github.post_count, 0)
        self.assert_no_history_reads()

    def test_confirmed_arguments_claim_receipt_and_nine_am_share_one_intent(self):
        args = ['launch-confirmed', self.request['targetDate'], self.request['confirmedAt'],
                self.request['requestId'], self.request['expectedMain']]
        mode, request = parse_args(args)
        result = run_clock(mode, EARLY, self.github, self.store, enabled=True, confirmation=request)
        self.assertEqual(result['outcome'], 'dispatch-accepted')
        self.assertEqual(result['requestId'], self.request['requestId'])
        self.assertEqual(result['confirmedAt'], self.request['confirmedAt'])
        self.assertFalse(result['publicationVerified'])
        intent = self.store.intents[self.request['targetDate']]
        self.assertEqual(set(intent), {'schema', 'repository', 'workflow', 'ref', 'slotDate', 'targetDate', 'createdAt', 'mainSha'})
        self.assertEqual(intent['schema'], 'fee-console.clock-intent.v1')
        self.assertEqual(intent['mainSha'], self.request['expectedMain'])
        self.assertEqual(self.store.results[self.request['targetDate']]['runId'], 41)
        self.assertEqual(self.github.confirmed, [self.request])
        # Even if the accepted GitHub request is not yet visible, the normal
        # clock reads the identical durable target claim and cannot resend.
        self.assertEqual(run_clock('launch', NOW, self.github, self.store, enabled=True)['outcome'], 'intent-already-exists')
        self.request['requestId'] = 'synthetic-duplicate-message'
        self.assertEqual(self.go()['outcome'], 'intent-already-exists')
        self.assertEqual(self.github.post_count, 1)

    def test_confirmation_is_not_approval_and_cannot_add_extra_scope(self):
        for change in ({'approved': True}, {'recoveryMain': 'b' * 40}, {'ref': 'candidate'},
                       {'expectedMain': 'BAD'}, {'requestId': ''}, {'requestId': 'secret\nvalue'},
                       {'targetDate': '2026-02-30'}, {'confirmedAt': 'not-a-date'}):
            with self.subTest(change=change):
                self.request = {**confirmation(), **change}
                self.error('CONFIRMATION_INVALID')
        self.assertEqual(self.github.read_count, 0)
        self.assertFalse(self.store.intents)

    def test_future_old_day_or_wrong_target_confirmation_reads_nothing(self):
        for change, code in (({'confirmedAt': '2026-10-13T23:31:00Z'}, 'CONFIRMATION_STALE'),
                             ({'confirmedAt': '2026-10-13T15:59:59Z'}, 'CONFIRMATION_STALE'),
                             ({'targetDate': '2026-10-12'}, 'CONFIRMATION_TARGET'),
                             ({'targetDate': '2026-10-14'}, 'CONFIRMATION_TARGET')):
            with self.subTest(change=change):
                self.request = {**confirmation(), **change}
                self.error(code)
        self.assertEqual(self.github.read_count, 0)

    def test_market_close_and_confirmation_use_actual_dst_boundary(self):
        for day, target, close in (('2026-10-14', '2026-10-13', '04:15:00'),
                                   ('2026-11-06', '2026-11-05', '05:15:00')):
            at = datetime.fromisoformat(day + 'T' + close + '+08:00')
            before = at - timedelta(seconds=1)
            self.request = confirmation(target, before.astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'))
            self.error('SOURCE_DAY_NOT_CLOSED', now=at)
            self.request = confirmation(target, at.astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'))
            self.assertTrue(plan('launch-confirmed', at, self.request)['action'])
            with self.assertRaisesRegex(ClockError, 'CONFIRMATION_STALE'):
                plan('launch-confirmed', before, self.request)
        self.assertEqual(self.github.read_count, 0)

    def test_month_end_waits_actual_new_york_midnight_in_summer_and_winter(self):
        for day, target, market, midnight in (('2026-10-01', '2026-09-30', '04:15:00', '12:00:00'),
                                             ('2026-12-01', '2026-11-30', '05:15:00', '13:00:00')):
            close = datetime.fromisoformat(day + 'T' + market + '+08:00')
            done = datetime.fromisoformat(day + 'T' + midnight + '+08:00')
            self.request = confirmation(target, close.astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'))
            self.error('ACCOUNTING_DAY_NOT_COMPLETE', now=done - timedelta(seconds=1))
            self.assertTrue(plan('launch-confirmed', done, self.request)['action'])
        self.assertEqual(self.github.read_count, 0)

    def test_weekend_does_not_replay_friday_and_prior_month_does_not_delay_daily_target(self):
        self.request = confirmation('2026-10-16', '2026-10-17T23:29:00Z')
        self.error('CONFIRMATION_TARGET', now=datetime.fromisoformat('2026-10-18T07:30:00+08:00'))
        request = confirmation('2026-11-02', '2026-11-02T23:29:00Z')
        self.assertTrue(plan('launch-confirmed', datetime.fromisoformat('2026-11-03T07:30:00+08:00'), request)['action'])

    def test_main_is_checked_before_claim_and_again_before_post(self):
        self.github.main_sha = 'b' * 40
        self.error('CONFIRMATION_MAIN_CHANGED')
        self.assertFalse(self.store.intents)
        self.github.main_sha = 'a' * 40
        self.store.after_claim = lambda: setattr(self.github, 'main_sha', 'b' * 40)
        self.error('CONFIRMATION_MAIN_CHANGED')
        self.assertTrue(self.store.intents)
        self.assertEqual(self.github.post_count, 0)
        self.request['expectedMain'] = 'b' * 40
        self.assertEqual(self.go()['outcome'], 'intent-already-exists')
        self.assert_no_history_reads()

    def test_request_cannot_mutate_during_adapter_calls(self):
        original = copy.deepcopy(self.request)
        self.store.after_claim = lambda: self.request.update(requestId='changed-message', expectedMain='b' * 40)
        result = self.go()
        self.assertEqual(self.github.confirmed, [original])
        self.assertEqual(result['requestId'], original['requestId'])
        self.assertEqual(self.store.intents[original['targetDate']]['mainSha'], original['expectedMain'])

    def test_confirmation_cannot_cross_hong_kong_day_during_io(self):
        next_day = datetime.fromisoformat('2026-10-15T00:00:00+08:00')
        current = [EARLY]
        self.store.after_claim = lambda: current.__setitem__(0, next_day)
        self.error('CONFIRMATION_STALE', current_time=lambda: current[0])
        self.assertTrue(self.store.intents)
        self.assertEqual(self.github.post_count, 0)

    def test_concurrent_confirmations_share_atomic_claim(self):
        results, errors = [], []
        def call():
            try:
                results.append(self.go()['outcome'])
            except Exception as error:
                errors.append(str(error))
        threads = [threading.Thread(target=call) for _ in range(5)]
        for thread in threads: thread.start()
        for thread in threads: thread.join()
        self.assertEqual(errors, [])
        self.assertEqual(results.count('dispatch-accepted'), 1)
        self.assertEqual(self.github.post_count, 1)
        self.assert_no_history_reads()

    def test_existing_normal_intent_is_not_replaced_by_confirmation(self):
        run_clock('launch', NOW, self.github, self.store, enabled=True)
        self.request['confirmedAt'] = '2026-10-14T01:01:00Z'
        self.assertEqual(self.go(now=NOW + timedelta(minutes=2))['outcome'], 'intent-already-exists')
        self.assertEqual(self.github.post_count, 1)
        self.assertFalse(self.github.confirmed)

    def test_confirmed_and_scheduled_calls_race_for_the_same_target(self):
        results, errors = [], []
        def call(mode):
            try:
                result = run_clock(mode, NOW, self.github, self.store, enabled=True,
                                   confirmation=self.request if mode == 'launch-confirmed' else None)
                results.append(result['outcome'])
            except Exception as error:
                errors.append(str(error))
        threads = [threading.Thread(target=call, args=(mode,)) for mode in ('launch-confirmed', 'launch')]
        for thread in threads: thread.start()
        for thread in threads: thread.join()
        self.assertEqual(errors, [])
        self.assertCountEqual(results, ['dispatch-accepted', 'intent-already-exists'])
        self.assertEqual(len(self.store.intents), 1)
        self.assertEqual(self.github.post_count, 1)

    def test_malformed_existing_intent_is_not_deleted_or_replaced(self):
        self.go()
        self.store.intents[self.request['targetDate']]['approved'] = True
        self.error('INTENT_INVALID')
        self.assertTrue(self.store.intents[self.request['targetDate']]['approved'])
        self.assertEqual(self.github.post_count, 1)

    def test_normal_start_check_observes_early_job_but_does_not_claim_publication(self):
        self.go()
        self.github.day = [run_row(status='completed', created='2026-10-13T23:30:00Z')]
        self.github.job[11] = [{'id': 21, 'run_id': 11, 'name': 'Produce daily 2026-10-13',
                               'status': 'completed', 'conclusion': 'success',
                               'started_at': '2026-10-13T23:31:00Z'}]
        result = run_clock('check-start', CHECK, self.github, self.store, enabled=True)
        self.assertEqual(result['outcome'], 'started')
        self.assertFalse(result['publicationVerified'])
        self.assertEqual(self.github.post_count, 1)

    def test_unknown_post_and_failed_receipt_keep_claim_and_never_resend(self):
        for post_error, result_error in (('DISPATCH_UNCERTAIN', False), ('DISPATCH_HTTP_403', False), (None, True)):
            with self.subTest(post_error=post_error, result_error=result_error):
                self.setUp()
                self.github.post_error, self.store.result_error = post_error, result_error
                self.error(post_error or 'NETWORK_OR_RESPONSE')
                original_intent = copy.deepcopy(self.store.intents)
                self.assertEqual(self.go()['outcome'], 'intent-already-exists')
                self.assertEqual(self.store.intents, original_intent)
                self.assert_no_history_reads()
                self.assertEqual(run_clock('launch', NOW, self.github, self.store, enabled=True)['outcome'], 'intent-already-exists')
                self.assertEqual(self.github.post_count, 1)

    def test_confirmed_request_does_not_infer_outcomes_from_history(self):
        for status in ('queued', 'in_progress', 'completed'):
            with self.subTest(status=status):
                self.setUp()
                self.github.day = [run_row(status=status, created='2026-10-13T23:00:00Z')]
                self.github.job[11] = [
                    {'id': 21, 'run_id': 11, 'name': 'period', 'status': 'completed', 'conclusion': 'success'},
                    {'id': 22, 'run_id': 11, 'name': 'Produce daily 2026-10-13',
                     'status': status, 'conclusion': 'failure' if status == 'completed' else None}]
                result = self.go()
                self.assertEqual(result['outcome'], 'dispatch-accepted')
                self.assertFalse(result['publicationVerified'])
                self.assertEqual(self.github.post_count, 1)
                self.assertTrue(self.store.intents)
                self.assert_no_history_reads()

    def test_natural_race_after_confirmed_claim_defers_to_producer_gates(self):
        self.store.after_claim = lambda: setattr(self.github, 'day', [
            run_row(event='schedule', created='2026-10-13T23:30:00Z')])
        result = self.go()
        self.assertEqual(result['outcome'], 'dispatch-accepted')
        self.assertFalse(result['publicationVerified'])
        self.assertTrue(self.store.intents)
        self.assertEqual(self.github.post_count, 1)
        self.assert_no_history_reads()

    def test_unknown_claim_result_never_dispatches(self):
        self.store.error = 'NETWORK_OR_RESPONSE'
        self.error('NETWORK_OR_RESPONSE')
        self.assertEqual(self.github.post_count, 0)
        self.assert_no_history_reads()

    def test_confirmed_payload_is_forbidden_on_normal_slots(self):
        for mode in ('launch', 'check-start'):
            with self.assertRaisesRegex(ClockError, 'CONFIRMATION_INVALID'):
                run_clock(mode, NOW, self.github, self.store, enabled=True, confirmation=self.request)
        self.assertEqual(self.github.read_count, 0)


class FakeHttp:
    def __init__(self, responses):
        self.responses, self.calls = list(responses), []

    def request(self, url, **kwargs):
        self.calls.append((url, kwargs))
        return self.responses.pop(0)


class AdapterTests(unittest.TestCase):
    def test_confirmed_dispatch_uses_only_existing_reviewed_daily_inputs(self):
        http = FakeHttp([(204, None)])
        Github(http, lambda: 'synthetic-not-a-real-credential').dispatch_confirmed(confirmation())
        url, call = http.calls[0]
        self.assertEqual(url, 'https://api.github.com/repos/' + REPO + '/actions/workflows/fee-cloud-producer.yml/dispatches')
        self.assertEqual(call['body'], {'ref': 'main', 'inputs': {'run_reviewed_once': 'true',
                         'report_kind': 'daily', 'report_target': '2026-10-13',
                         'manual_sync_completed_for': '2026-10-13', 'confirmed_main': 'a' * 40}})
        self.assertTrue(call['uncertain'])
        self.assertEqual(len(http.calls), 1)

    def test_invalid_confirmed_adapter_input_does_not_read_secret_or_post(self):
        http = FakeHttp([])
        for edit in ({'approved': True}, {'targetDate': '2026-02-30'}, {'requestId': '../secret'}, {'expectedMain': ''}):
            with self.assertRaisesRegex(ClockError, 'CONFIRMATION_INVALID'):
                Github(http, lambda: self.fail('secret read')).dispatch_confirmed({**confirmation(), **edit})
        self.assertEqual(http.calls, [])

    def test_cli_has_only_fixed_modes_and_complete_confirmation_arguments(self):
        for mode in ('launch', 'check-start'):
            self.assertEqual(parse_args([mode]), (mode, None))
        for args in ([], ['launch-confirmed'], ['launch', 'unexpected'], ['dispatch'],
                     ['launch-confirmed', '2026-10-13', '2026-10-13T23:29:00Z', 'message'],
                     ['launch-confirmed', '2026-10-13', '2026-10-13T23:29:00Z', 'message', 'a' * 40, 'extra']):
            with self.assertRaisesRegex(ClockError, 'FEE_CLOCK_MODE'):
                parse_args(args)

    def test_dispatch_exact_target_and_automatic_mode_without_human_confirmation(self):
        http = FakeHttp([(204, None)])
        Github(http, lambda: 'synthetic-not-a-real-credential').dispatch()
        url, call = http.calls[0]
        self.assertEqual(url, 'https://api.github.com/repos/' + REPO + '/actions/workflows/fee-cloud-producer.yml/dispatches')
        self.assertEqual(call['body'], {'ref': 'main', 'inputs': {'report_kind': 'automatic-daily'}})
        self.assertTrue(call['uncertain'])
        self.assertEqual(len(http.calls), 1)

    def test_dispatch_200_validates_run_identity(self):
        http = FakeHttp([(200, {'workflow_run_id': 41, 'run_url': 'https://api.github.com/repos/' + REPO + '/actions/runs/41',
                               'html_url': 'https://github.com/' + REPO + '/actions/runs/41'})])
        self.assertEqual(Github(http, lambda: 'synthetic').dispatch(), 41)

    def test_unknown_or_failure_response_never_retries(self):
        for status, expected in ((499, 'DISPATCH_UNCERTAIN'), (500, 'DISPATCH_UNCERTAIN'), (403, 'DISPATCH_HTTP_403'), (200, 'DISPATCH_UNCERTAIN')):
            with self.subTest(status=status):
                http = FakeHttp([(status, None)])
                with self.assertRaisesRegex(ClockError, expected): Github(http, lambda: 'synthetic').dispatch()
                self.assertEqual(len(http.calls), 1)

    def test_get_metadata_does_not_read_github_secret(self):
        http = FakeHttp([(200, {})])
        Github(http, lambda: self.fail('secret read')).workflow()
        self.assertNotIn('Authorization', http.calls[0][1]['headers'])

    def test_gcs_claim_has_create_only_precondition_and_no_finance(self):
        http = FakeHttp([(200, {'access_token': 'synthetic-runtime-identity'}), (200, {})])
        Store(http).claim({'targetDate': '2026-10-13'})
        url, call = http.calls[-1]
        self.assertIn('family-portfolio-gateway-fee-clock', url)
        self.assertIn('ifGenerationMatch=0', url)
        self.assertIn('v1%2Fintent%2F2026-10-13.json', url)
        self.assertEqual(call['method'], 'POST')

    def test_claim_conflict_is_not_a_write_retry(self):
        http = FakeHttp([(200, {'access_token': 'synthetic-runtime-identity'}), (412, None)])
        self.assertFalse(Store(http).claim({'targetDate': '2026-10-13'}))
        self.assertEqual(len(http.calls), 2)

    def test_http_timeout_on_post_is_uncertain_and_sanitized(self):
        class TimeoutOpener:
            calls = 0
            def open(self, request, timeout):
                self.calls += 1
                raise TimeoutError('secret-ish body must not leak')
        opener = TimeoutOpener()
        with self.assertRaisesRegex(ClockError, '^FEE_CLOCK_DISPATCH_UNCERTAIN$'):
            Http(opener).request('https://api.github.com', method='POST', body={}, uncertain=True)
        self.assertEqual(opener.calls, 1)

    def test_post_response_protocol_failure_is_uncertain(self):
        class BadResponse:
            status = 200
            headers = {'Link': '<next>; rel="next"'}
            def __enter__(self): return self
            def __exit__(self, *args): pass
        class Opener:
            def open(self, request, timeout): return BadResponse()
        with self.assertRaisesRegex(ClockError, '^FEE_CLOCK_DISPATCH_UNCERTAIN$'):
            Http(Opener()).request('https://api.github.com', method='POST', body={}, uncertain=True)


if __name__ == '__main__':
    unittest.main()
