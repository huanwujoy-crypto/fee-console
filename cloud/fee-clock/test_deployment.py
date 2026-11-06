import json
from pathlib import Path
import unittest


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        self.plan = json.loads(Path(__file__).with_name('deployment-plan.json').read_text())

    def test_only_two_requested_slots_and_oauth_job_invocation(self):
        rows = self.plan['schedulerJobs']
        self.assertEqual([x['schedule'] for x in rows], ['0 9 * * 2-6', '5 9 * * 2-6'])
        for row in rows:
            self.assertEqual(row['timeZone'], 'Asia/Hong_Kong')
            self.assertEqual(row['retryConfig'], {'retryCount': 0, 'maxRetryDuration': '0s'})
            self.assertTrue(row['httpTarget']['uri'].startswith('https://run.googleapis.com/v2/projects/family-portfolio-gateway/locations/asia-east2/jobs/fee-clock-'))
            self.assertIn('oauthToken', row['httpTarget'])
            self.assertNotIn('oidcToken', row['httpTarget'])
            self.assertEqual(row['httpTarget']['body'], 'e30=')

    def test_disabled_single_task_no_retry_and_secret_only_for_launch(self):
        for row in self.plan['runJobs']:
            outer = row['body']['template']; task = outer['template']; container = task['containers'][0]
            self.assertEqual(outer['taskCount'], 1); self.assertEqual(outer['parallelism'], 1)
            self.assertEqual(task['maxRetries'], 0); self.assertEqual(task['timeout'], '120s')
            self.assertEqual(container['env'], [{'name': 'FEE_CLOCK_ENABLED', 'value': 'false'}])
            if row['jobId'] == 'fee-clock-launch': self.assertEqual(task['volumes'][0]['secret']['secret'], 'fee-clock-github-actions')
            else: self.assertNotIn('volumes', task)

    def test_no_financial_or_contents_permissions_and_check_cannot_dispatch(self):
        self.assertEqual(self.plan['secret']['githubScope']['Contents'], 'none')
        check = [x for x in self.plan['runtimeIam'] if x['member'].startswith('fee-clock-check@')]
        self.assertEqual([x['role'] for x in check], ['roles/storage.objectViewer'])
        self.assertEqual(self.plan['workflowDispatchInputs'], {'report_kind': 'automatic-daily'})
        self.assertFalse(any(x['role'] in ('roles/owner', 'roles/editor', 'roles/iam.serviceAccountTokenCreator') for x in self.plan['runtimeIam']))

    def test_scheduler_failures_and_job_failures_both_have_disabled_proposals(self):
        policies = self.plan['alertPolicies']
        self.assertEqual(len(policies), 2)
        filters = [p['conditions'][0]['conditionMatchedLog']['filter'] for p in policies]
        self.assertTrue(any('cloud_scheduler_job' in s for s in filters))
        self.assertTrue(any('FEE_CLOCK_ALERT' in s for s in filters))
        self.assertTrue(all(p['enabled'] is False and p['notificationChannels'] == [] for p in policies))

    def test_hong_kong_estimate_does_not_apply_free_allowances(self):
        value = self.plan['costEstimateUsd']
        seconds = value['runsPerMonth'] * 60
        jobs = seconds * (value['cpuPerSecond'] + value['memoryGiB'] * value['memoryPerGiBSecond'])
        self.assertAlmostEqual(jobs, value['jobAt60Seconds'])
        self.assertFalse(value['freeAllowancesApplied'])
        self.assertEqual(value['region'], 'asia-east2')

    def test_docker_context_contains_only_clock_sources(self):
        text = Path(__file__).with_name('Dockerfile').read_text()
        copies = [row for row in text.splitlines() if row.startswith('COPY ')]
        self.assertEqual(copies, ['COPY clock.py runtime.py /app/'])
        self.assertIn('FEE_CLOCK_ENABLED=false', text)

    def test_confirmed_entry_is_a_local_existing_job_proposal_without_iam_or_schedule_changes(self):
        value = self.plan['confirmedStartProposal']
        self.assertEqual(value['status'], 'local-code-only-not-deployed-or-executed')
        self.assertEqual(value['job'], 'projects/family-portfolio-gateway/locations/asia-east2/jobs/fee-clock-launch')
        self.assertEqual(value['containerArgs'], ['launch-confirmed', 'TARGET_DATE', 'CONFIRMED_AT_UTC', 'REQUEST_ID', 'EXPECTED_MAIN_SHA'])
        self.assertTrue(value['normalJobArgsUnchanged']); self.assertTrue(value['schedulerJobsUnchanged'])
        self.assertFalse(value['newIdentityOrCredential']); self.assertEqual(value['newIamBindings'], [])
        self.assertFalse(self.plan['newResourcesAllowed']); self.assertFalse(self.plan['permissionChangesAllowed'])
        self.assertEqual([r['body']['template']['template']['containers'][0]['args'] for r in self.plan['runJobs']], [['launch'], ['check-start']])
        self.assertEqual(value['existingCallerPermissionVerificationRequired'], ['run.jobs.run', 'run.jobs.runWithOverrides'])

    def test_confirmed_proposal_pins_original_workflow_and_does_not_claim_authority(self):
        value = self.plan['confirmedStartProposal']
        self.assertEqual(value['dispatchInputs'], {'run_reviewed_once': 'true', 'report_kind': 'daily',
                         'report_target': 'TARGET_DATE', 'manual_sync_completed_for': 'TARGET_DATE',
                         'confirmed_main': 'EXPECTED_MAIN_SHA'})
        self.assertIn('not owner approval', value['authorizationBoundary'])
        self.assertIn('not an automatic chat listener', value['authorizationBoundary'])
        self.assertIn('no-immediate-run restriction', value['executionRequirement'])
        self.assertIn('workflow remains the final', value['preflight'])
        self.assertIn('never publication acceptance', value['supervision'])


if __name__ == '__main__':
    unittest.main()
