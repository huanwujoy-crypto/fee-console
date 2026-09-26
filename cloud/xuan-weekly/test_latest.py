import sys
import types
import unittest
from unittest.mock import MagicMock

# Tests do not require cloud credentials or the storage SDK.
class NotFound(Exception): pass
class PreconditionFailed(Exception): pass
exceptions = types.ModuleType('google.api_core.exceptions')
exceptions.NotFound = NotFound
exceptions.PreconditionFailed = PreconditionFailed
sys.modules.setdefault('google.api_core.exceptions', exceptions)
from latest import publish_latest, ENTRY

class LatestTests(unittest.TestCase):
    def setUp(self):
        self.bucket=MagicMock(); self.blob=self.bucket.blob.return_value
        self.blob.metadata={'started_at':'2026-09-25T10:00:00+00:00',
                            'risk_date':'2026-09-24','abc_date':'2026-09-23'}
        self.blob.generation=9
        self.args=dict(started_at='2026-09-26T10:00:00+00:00',
                       risk_date='2026-09-25',abc_date='2026-09-24',
                       source='weekly/run/report.html')
    def test_create(self):
        self.blob.reload.side_effect=NotFound()
        self.assertEqual(publish_latest(self.bucket,'html',**self.args),'updated')
        self.assertEqual(self.blob.upload_from_string.call_args.kwargs['if_generation_match'],0)
    def test_replace_conditional_private(self):
        publish_latest(self.bucket,'html',**self.args)
        self.bucket.blob.assert_called_with(ENTRY)
        self.assertEqual(self.blob.upload_from_string.call_args.kwargs['if_generation_match'],9)
        self.assertIn('no-store',self.blob.cache_control)
    def test_older_run_preserved(self):
        self.args['started_at']='2026-09-24T10:00:00+00:00'
        self.assertEqual(publish_latest(self.bucket,'html',**self.args),'kept_newer')
        self.blob.upload_from_string.assert_not_called()
    def test_date_regression_preserved(self):
        self.args['abc_date']='2026-09-22'
        self.assertEqual(publish_latest(self.bucket,'html',**self.args),'kept_newer')
        self.blob.upload_from_string.assert_not_called()
    def test_unknown_metadata_fails_closed(self):
        self.blob.metadata={}
        with self.assertRaises(ValueError):publish_latest(self.bucket,'html',**self.args)
    def test_contention_bounded(self):
        self.blob.reload.side_effect=NotFound()
        self.blob.upload_from_string.side_effect=PreconditionFailed()
        with self.assertRaises(RuntimeError):publish_latest(self.bucket,'html',**self.args)
        self.assertEqual(self.blob.upload_from_string.call_count,3)

if __name__=='__main__':unittest.main()
