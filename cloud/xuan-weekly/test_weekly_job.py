import contextlib
import datetime as dt
import io
import json
import os
import sys
import types
import unittest
from unittest.mock import MagicMock, patch

import weekly_job as job
from network import SourceError


class WeeklyJobTests(unittest.TestCase):
    def setUp(self):
        self.events=[];self.fail_archive=None
        self.bucket=MagicMock();self.bucket.list_blobs.return_value=[]
        def blob(name):
            b=MagicMock()
            def upload(body,**kwargs):
                leaf=name.rsplit('/',1)[-1];self.events.append(leaf)
                if leaf==self.fail_archive:raise RuntimeError('DO_NOT_LOG')
            b.upload_from_string.side_effect=upload
            return b
        self.bucket.blob.side_effect=blob
        self.client=MagicMock();self.client.bucket.return_value=self.bucket
        cloud=types.ModuleType('google.cloud');cloud.storage=types.SimpleNamespace(Client=lambda:self.client)
        self.patches=[patch.dict(sys.modules,{'google.cloud':cloud}),
                      patch.dict(os.environ,{'WEEKLY_BUCKET':'family-portfolio-gateway-xuan-weekly-private',
                       'WEEKLY_PUBLIC_BUCKET':'family-portfolio-gateway-xuan-weekly-public',
                       'IB_FLEX_TOKEN':'SYNTHETIC_TOKEN','IB_ACCOUNT_SHA256':'SYNTHETIC_BINDING',
                       'GATEWAY_READ_TOKEN':'SYNTHETIC_GATEWAY'}),
                      patch('weekly_job.fetch',return_value=b'SYNTHETIC_XML'),
                      patch('weekly_job.normalize',return_value={'coverage':{'to':dt.date.today().isoformat(),
                            'unresolvedDates':[]}}),
                      patch('weekly_job.fetch_quotes',return_value=({}, {}, dt.date.today().isoformat())),
                      patch('weekly_job.calendar',return_value=[]),
                      patch('weekly_job.get',side_effect=[{'portfolios':[{'name':n,'id':i} for n,i in job.ACCOUNTS.items()]}]
                            +[{'mode':'read_only'}]*3),
                      patch('weekly_job.subprocess.run',return_value=types.SimpleNamespace(returncode=0,
                            stdout=json.dumps({'html':'<!doctype html><p>SYNTHETIC</p>','receipt':{'complete':True}}),
                            stderr='DO_NOT_LOG')),
                      patch('weekly_job.publish_latest',side_effect=lambda *a,**k:self.publish('private_latest')),
                      patch('weekly_job.publish_public',side_effect=lambda *a,**k:self.publish('public_latest'))]
        self.mocks=[p.start() for p in self.patches]
        for p in self.patches:self.addCleanup(p.stop)

    def publish(self,name):
        self.events.append(name);return 'updated'

    def execute(self):
        output=io.StringIO()
        with contextlib.redirect_stdout(output):status=job.run()
        text=output.getvalue();self.assertNotIn('DO_NOT_LOG',text)
        self.assertNotIn('SYNTHETIC_TOKEN',text);self.assertNotIn('SYNTHETIC_BINDING',text)
        return status,[json.loads(line) for line in text.splitlines()]

    def test_success_keeps_archive_before_publish_contract(self):
        status,lines=self.execute();self.assertEqual(status,0)
        self.assertTrue(lines[-1]['complete'])
        self.assertLess(self.events.index('report.html'),self.events.index('receipt.json'))
        self.assertLess(self.events.index('receipt.json'),self.events.index('private_latest'))
        self.assertLess(self.events.index('private_latest'),self.events.index('public_latest'))
        self.assertEqual(self.events[-1],'publication.json')
        for call in self.mocks[6].call_args_list:self.assertIn('deadline',call.kwargs)

    def test_source_failure_logs_safe_stage_and_exits_nonzero(self):
        self.mocks[2].side_effect=SourceError('ib_network_error',network={'operation':'ib_get_statement',
                 'category':'timeout','attempts':3,'retryable':True,'url':'DO_NOT_LOG'})
        status,lines=self.execute();self.assertEqual(status,1)
        self.assertEqual(lines[0]['stage'],'ib_fetch');self.assertEqual(lines[0]['severity'],'ERROR')
        self.assertEqual(lines[0]['event'],'xuan_weekly_failed')
        self.assertNotIn('url',lines[0]['network'])
        self.assertEqual(self.events,['failure.json'])

    def test_bad_identity_never_publishes(self):
        self.mocks[3].side_effect=SourceError('wrong_account')
        status,lines=self.execute();self.assertEqual(status,1)
        self.assertEqual(lines[0]['stage'],'ib_validate')
        self.assertEqual(self.events,['failure.json'])

    def test_receipt_archive_failure_prevents_both_publishers(self):
        self.fail_archive='receipt.json'
        status,lines=self.execute();self.assertEqual(status,1)
        self.assertEqual(lines[0]['stage'],'archive_receipt_json')
        self.mocks[8].assert_not_called();self.mocks[9].assert_not_called()

    def test_public_failure_is_distinct_from_generation_failure(self):
        self.mocks[9].side_effect=RuntimeError('DO_NOT_LOG')
        status,lines=self.execute();self.assertEqual(status,1)
        self.assertEqual(lines[0]['stage'],'public_latest')
        self.assertIn('private_latest',self.events);self.assertNotIn('publication.json',self.events)

    def test_failure_archive_error_cannot_hide_first_failure(self):
        self.mocks[2].side_effect=SourceError('ib_network_error');self.fail_archive='failure.json'
        status,lines=self.execute();self.assertEqual(status,1)
        self.assertEqual([l['code'] for l in lines],['ib_network_error','failure_archive_failed'])

    def test_calculator_stderr_is_never_logged(self):
        self.mocks[7].return_value.returncode=1
        status,lines=self.execute();self.assertEqual(status,1)
        self.assertEqual(lines[0]['code'],'weekly_calculation_failed')
        self.assertEqual(lines[0]['stage'],'calculation')

    def test_unrecognized_source_error_text_is_not_a_log_code(self):
        self.mocks[2].side_effect=SourceError('DO_NOT_LOG')
        status,lines=self.execute();self.assertEqual(status,1)
        self.assertEqual(lines[0]['code'],'unexpected_error')

    @patch('weekly_job.read_get',return_value=b'not JSON')
    def test_gateway_bad_structure_is_not_retried(self,read):
        # Call the real GET helper; run() mocks every source and never accesses the network.
        self.patches[6].stop()
        with self.assertRaisesRegex(SourceError,'gateway_invalid_json'):job.get('/v1/portfolios')
        self.assertEqual(read.call_count,1)


if __name__=='__main__':unittest.main()
