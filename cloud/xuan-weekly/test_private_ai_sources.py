"""Synthetic pinned private-input delivery checks; no network or account access."""
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock
from private_ai_sources import MAX_BYTES, source_config, stage_private_ai_sources


class PrivateSourcesTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.bucket = Mock()
        self.cutoff = '2026-10-02'
        self.clock = Mock(return_value=10)
        self.source = b'{"synthetic":true}'
        self.sha = hashlib.sha256(self.source).hexdigest()
        self.base = 'weekly/synthetic-input/'
        self.entry = {'instrumentId': '12', 'symbol': 'TEST', 'asOf': '2026-06-30',
                      'sha256': self.sha, 'maxBytes': MAX_BYTES,
                      'objectName': self.base + self.sha + '.json'}

    def setup_manifest(self, entries=None, patch=None):
        m = {'schema': 'weekly-private-ai-snapshots.v1',
             'entries': entries if entries is not None else [self.entry]}
        if patch is not None:
            m['policyPatch'] = patch
        self.raw = json.dumps(m).encode()
        self.config = (self.base + 'manifest.json', 123, hashlib.sha256(self.raw).hexdigest())
        self.bucket.blob.return_value.download_as_bytes.side_effect = [self.raw, self.source]

    def stage(self, deadline=100):
        return stage_private_ai_sources(self.bucket, self.root, config=self.config,
            cutoff=self.cutoff, deadline=deadline, clock=self.clock)

    def test_absent_config_is_inert_and_partial_config_rejected(self):
        self.assertIsNone(source_config({}))
        self.assertIsNone(stage_private_ai_sources(self.bucket, self.root, config=None,
            cutoff=self.cutoff, deadline=100, clock=self.clock))
        self.bucket.blob.assert_not_called()
        for env in ({'WEEKLY_AI_MANIFEST_OBJECT': self.base+'manifest.json'},
                    {'WEEKLY_AI_MANIFEST_OBJECT': '../elsewhere.json',
                     'WEEKLY_AI_MANIFEST_GENERATION': '123', 'WEEKLY_AI_MANIFEST_SHA256': self.sha}):
            with self.assertRaises(ValueError):
                source_config(env)

    def test_pinned_manifest_existing_bucket_and_digest_file(self):
        self.setup_manifest()
        path = self.stage()
        self.assertEqual(Path(path).read_bytes(), self.raw)
        self.assertEqual((self.root/(self.sha+'.json')).read_bytes(), self.source)
        self.bucket.blob.assert_any_call(self.base+'manifest.json', generation=123)
        self.bucket.blob.assert_any_call(self.entry['objectName'])
        for call in self.bucket.blob.return_value.download_as_bytes.call_args_list:
            self.assertIsNone(call.kwargs['retry'])
            self.assertLessEqual(call.kwargs['timeout'], 5)
            self.assertEqual(call.kwargs['start'], 0)
            self.assertLessEqual(call.kwargs['end'], MAX_BYTES)

    def test_manifest_integrity_and_size_fail_before_sources(self):
        for raw in (b'wrong', b'x'*65537):
            self.setup_manifest()
            self.bucket.blob.return_value.download_as_bytes.side_effect = [raw]
            with self.assertRaises(ValueError):
                self.stage()
            self.assertEqual(self.bucket.blob.call_args.args[0], self.config[0])
            self.bucket.reset_mock()

    def test_all_references_validated_before_read_and_no_cross_prefix(self):
        for changes in ({'objectName':'weekly/other/'+self.sha+'.json'},
                        {'objectName':'https://example.org/source'}, {'maxBytes':MAX_BYTES+1}):
            self.setup_manifest([dict(self.entry, **changes)])
            with self.assertRaises(ValueError):
                self.stage()
            self.assertEqual(self.bucket.blob.call_count, 1)
            self.bucket.reset_mock()

    def test_source_missing_tampered_oversize_falls_back_without_retry(self):
        for response in (FileNotFoundError('synthetic'), b'wrong', b'x'*(MAX_BYTES+1)):
            self.setup_manifest()
            self.bucket.blob.return_value.download_as_bytes.side_effect = [self.raw, response]
            self.stage()
            self.assertFalse((self.root/(self.sha+'.json')).exists())
            self.assertEqual(self.bucket.blob.return_value.download_as_bytes.call_count, 2)
            self.bucket.reset_mock()

    def test_original_100_day_boundary_and_shared_deadline(self):
        for cutoff, expected in (('2026-10-08', 2), ('2026-10-09', 1), ('2026-06-29', 1)):
            self.cutoff = cutoff
            self.setup_manifest()
            self.stage()
            self.assertEqual(self.bucket.blob.call_count, expected)
            self.bucket.reset_mock()
        self.setup_manifest()
        self.clock.side_effect = [10, 12]
        self.stage(deadline=11)
        self.assertEqual(self.bucket.blob.call_count, 1)

    def test_reviewed_patch_uses_same_integrity_and_prefix_gates(self):
        self.setup_manifest([], patch={k:v for k,v in self.entry.items() if k in ('sha256','maxBytes','objectName')})
        self.stage()
        self.assertEqual((self.root/(self.sha+'.json')).read_bytes(), self.source)

    def test_expired_deadline_never_downloads(self):
        self.setup_manifest()
        with self.assertRaises(ValueError):
            self.stage(deadline=10)
        self.bucket.blob.assert_not_called()


if __name__ == '__main__':
    unittest.main()
