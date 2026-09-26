import unittest
from unittest.mock import MagicMock, patch
from public_entry import PUBLIC_BUCKET, publish_public

class PublicEntryTests(unittest.TestCase):
    def setUp(self):
        self.client=MagicMock()
        self.args=dict(started_at='2026-09-26',risk_date='2026-09-25',abc_date='2026-09-24')
    @patch('public_entry.publish_latest',return_value='updated')
    def test_only_final_html_and_neutral_source(self,publish):
        self.assertEqual(publish_public(self.client,PUBLIC_BUCKET,'<!doctype html><p>私密记录 · 不下单、不转账</p>',**self.args),'updated')
        self.client.bucket.assert_called_once_with(PUBLIC_BUCKET)
        self.assertNotIn('私密记录',publish.call_args.args[1])
        self.assertEqual(publish.call_args.kwargs['source'],'weekly/public/report.html')
    def test_refuse_private_bucket(self):
        with self.assertRaises(ValueError):publish_public(self.client,'family-portfolio-gateway-xuan-weekly-private','<!doctype html>',**self.args)
        self.client.bucket.assert_not_called()
    def test_refuse_raw_or_active_content(self):
        for html in ('{"account":"secret"}','<!doctype html><script>alert(1)</script>','<!doctype html><iframe></iframe>'):
            with self.assertRaises(ValueError):publish_public(self.client,PUBLIC_BUCKET,html,**self.args)
        self.client.bucket.assert_not_called()
