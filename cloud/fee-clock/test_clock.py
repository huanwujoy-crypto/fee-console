import copy
from datetime import datetime, timedelta, timezone
import io
import json
import threading
import unittest
import urllib.error
from clock import ClockError, REPO, WORKFLOW, WORKFLOW_ID, target_date, plan, run_clock
from runtime import Github, Http, Store


NOW = datetime(2026, 10, 14, 2, 0, tzinfo=timezone.utc)
CHECK = NOW + timedelta(minutes=5)


def run_row(run_id=11, status='queued', event='workflow_dispatch', created='2026-10-14T02:00:00Z'):
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
        self.post_error = None
        self.result = 41
        self.lock = threading.Lock()
        self.after_claim = None
        self.incomplete = False
        self.state = 'active'

    def workflow(self):
        self.read_count += 1
        return {'id': WORKFLOW_ID, 'path': '.github/workflows/' + WORKFLOW, 'state': self.state}

    def main(self):
        return {'object': {'sha': 'a' * 40}}

    def runs(self, created=None, status=None):
        with self.lock:
            if created is not None:
                self.query_count += 1
                if self.query_count == 2 and self.after_claim:
                    self.day = self.after_claim
            rows = copy.deepcopy(self.day if created else self.active.get(status, []))
        return {'total_count': len(rows) + int(self.incomplete), 'workflow_runs': rows}

    def jobs(self, run_id):
        rows = copy.deepcopy(self.job.get(run_id, []))
        return {'total_count': len(rows), 'jobs': rows}

    def dispatch(self):
        self.post_count += 1
        if self.post_error:
            raise ClockError(self.post_error)
        return self.result


class FakeStore:
    def __init__(self):
        self.intents = {}
        self.results = {}
        self.lock = threading.Lock()
        self.error = None
        self.after_claim = None

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

    def test_launch_once_and_duplicate_scheduler_delivery(self):
        self.assertEqual(self.go()['runId'], 41)
        self.assertEqual(self.go()['outcome'], 'intent-already-exists')
        self.assertEqual(self.github.post_count, 1)

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
        self.github.job[11] = [{'id': 21, 'run_id': 11, 'name': 'produce', 'status': 'queued', 'started_at': None}]
        self.error('REQUESTED_NOT_STARTED', mode='check-start', now=CHECK)

    def job_started(self, status='in_progress', conclusion=None):
        self.github.day = [run_row(status='in_progress')]
        self.github.job[11] = [{'id': 21, 'run_id': 11, 'name': 'produce', 'status': status,
                               'conclusion': conclusion, 'started_at': '2026-10-14T02:01:00Z'}]

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
            ('2026-10-14T02:00:00Z', '2026-10-13'),
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


class FakeHttp:
    def __init__(self, responses):
        self.responses, self.calls = list(responses), []

    def request(self, url, **kwargs):
        self.calls.append((url, kwargs))
        return self.responses.pop(0)


class AdapterTests(unittest.TestCase):
    def test_dispatch_exact_target_and_sole_false_input(self):
        http = FakeHttp([(204, None)])
        Github(http, lambda: 'synthetic-not-a-real-credential').dispatch()
        url, call = http.calls[0]
        self.assertEqual(url, 'https://api.github.com/repos/' + REPO + '/actions/workflows/fee-cloud-producer.yml/dispatches')
        self.assertEqual(call['body'], {'ref': 'main', 'inputs': {'apply_style_proposal': False}})
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
