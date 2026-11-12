import copy
import datetime as dt
import hashlib
import inspect
import io
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from adapter import bound_files
from adapter import offline_adapter as adapter
from adapter.native_aggregates import parse_aggregates, parse_native_aggregate_candidate
from adapter.native_columns import native_percentage
from adapter.strict_totals import reconcile
from synthetic_fixtures import NOW, ACCOUNTS, SCOPE, batch, make_xlsx


class Clock(dt.datetime):
    @classmethod
    def now(cls, tz=None):
        return NOW


class OfflineTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='synthetic-ratio-')
        self.root = Path(self.temp.name)
        self.request, self.identities = batch(self.root)
        self.stack = []
        # Test-process-only simulated metadata. No actual xattrs are created.
        def attr(fd, name):
            item = self.identities[os.fstat(fd).st_ino]
            return item[0 if name == 'user.library-file-id' else 1].encode()
        for mocked in [patch('adapter.bound_files.os.getxattr', side_effect=attr), patch('adapter.bound_files.os.setxattr', side_effect=AssertionError('identity mutation forbidden')),
                       patch.object(adapter, 'ALL_TOGETHER_SCOPE_SHA256', SCOPE), patch('adapter.offline_adapter.dt.datetime', Clock),
                       patch('socket.socket', side_effect=AssertionError('network forbidden')), patch('subprocess.run', side_effect=AssertionError('external command forbidden'))]:
            mocked.start()
            self.stack.append(mocked)

    def tearDown(self):
        for mocked in reversed(self.stack):
            mocked.stop()
        self.temp.cleanup()

    def invoke(self, request=None):
        return adapter.prepare_offline_allocation(self.request if request is None else request, enabled=True)

    def rebuild(self, **kw):
        self.request, self.identities = batch(self.root, **kw)

    def test_default_disabled_does_not_read(self):
        with patch('adapter.offline_adapter.read_bound_file', side_effect=AssertionError('read forbidden')):
            self.assertEqual(adapter.prepare_offline_allocation(None)['state'], 'DISABLED')

    def test_explicit_enable_boolean_only(self):
        for enabled in [1, 'true', None, {}]:
            with self.subTest(enabled=enabled), self.assertRaises(ValueError):
                adapter.prepare_offline_allocation(self.request, enabled=enabled)

    def test_synthetic_allocation_success_is_never_publishable(self):
        result = self.invoke()
        self.assertEqual(result['state'], 'OFFLINE_ALLOCATION_CANDIDATE')
        self.assertFalse(result['publicationReady'])
        self.assertFalse(result['sourceOriginVerified'])
        self.assertFalse(result['fullPerformanceReady'])
        self.assertEqual(result['uploads'], 0)
        self.assertEqual(len(result['original']['classification']['positions']), 10)
        self.assertEqual(len(result['original']['exposure']['rows']), 10)
        self.assertEqual(result['original']['classification']['positions'][0]['valueUSD'], 100)
        self.assertEqual(result['original']['classification']['positions'][0]['sourceRow'], 3)

    def test_missing_actual_identity_refuses(self):
        with patch('adapter.bound_files.os.getxattr', side_effect=OSError('not available')), self.assertRaises(OSError):
            self.invoke()

    def test_identity_or_version_mismatch_refuses(self):
        for value in [('libfile_' + 'f'*32, '0'), (self.request['bindings']['classification']['libraryFileId'], '1')]:
            inode = Path(self.request['bindings']['classification']['path']).stat().st_ino
            old = self.identities[inode]
            self.identities[inode] = value
            with self.assertRaisesRegex(ValueError, 'LIBRARY_IDENTITY'):
                self.invoke()
            self.identities[inode] = old

    def test_hash_mismatch_refuses(self):
        self.request['bindings']['classification']['sha256'] = 'a'*64
        with self.assertRaisesRegex(ValueError, 'SOURCE_HASH'):
            self.invoke()

    def test_fixed_runtime_scope_not_caller_supplied(self):
        with patch.object(adapter, 'ALL_TOGETHER_SCOPE_SHA256', 'f'*64), self.assertRaisesRegex(ValueError, 'ACCOUNT_SCOPE'):
            self.invoke()
        self.request['scopeSha256'] = SCOPE
        with self.assertRaisesRegex(ValueError, 'REQUEST_SCHEMA'):
            self.invoke()

    def test_stale_capture_refuses_even_if_file_mtime_is_new(self):
        def stale(c):
            at = NOW-dt.timedelta(hours=36, seconds=1)
            for value in c.values():
                value.update(capturedAt=at.isoformat(timespec='milliseconds').replace('+00:00','Z'), originalMtimeNs=int(at.timestamp())*1000000000)
        self.rebuild(mutate_capture=stale)
        with self.assertRaisesRegex(ValueError, 'CAPTURE_AGE'):
            self.invoke()

    def test_future_capture_refuses(self):
        def future(c):
            at = NOW+dt.timedelta(seconds=1)
            for value in c.values():
                value.update(capturedAt=at.isoformat(timespec='milliseconds').replace('+00:00','Z'), originalMtimeNs=int(at.timestamp())*1000000000)
        self.rebuild(mutate_capture=future)
        with self.assertRaisesRegex(ValueError, 'CAPTURE_AGE'):
            self.invoke()

    def test_capture_hash_and_original_time_are_bound(self):
        for field, value in [('sha256', 'a'*64), ('originalMtimeNs', 1)]:
            self.rebuild(mutate_capture=lambda c: c['classification'].update({field: value}))
            with self.assertRaises(ValueError):
                self.invoke()

    def test_download_completed_is_not_fabricated(self):
        self.assertIsNone(self.invoke()['original']['classification']['downloadCompletedAt'])

    def test_exposure_date_preserved_and_policy_stays_blocked(self):
        self.rebuild(exposure=make_xlsx('exposure', day='2026-11-11'))
        with self.assertRaisesRegex(ValueError, 'SOURCE_DATE'):
            self.invoke()
        self.rebuild(classification=make_xlsx(day='2026-11-11'))
        self.request['targetDate'] = '2026-11-11'
        result = self.invoke()
        self.assertEqual(result['original']['exposure']['asOf'], '2026-11-12')
        self.assertIn('REFRESH_DATE_POLICY', result['blockedOn'])

    def test_group_member_omission_refuses(self):
        self.rebuild(classification=make_xlsx(missing_group=True))
        with self.assertRaisesRegex(ValueError, 'GROUPING_DUPLICATES_DIFFER'):
            self.invoke()

    def test_duplicate_member_refuses(self):
        self.rebuild(classification=make_xlsx(duplicate=True))
        with self.assertRaisesRegex(ValueError, 'DUPLICATE_MEMBER'):
            self.invoke()

    def test_old_one_cent_tolerance_is_not_generalized(self):
        self.rebuild(classification=make_xlsx(delta=.01))
        with self.assertRaisesRegex(ValueError, 'STRICT_TOTAL_MISMATCH'):
            self.invoke()

    def test_fractional_cent_footer_is_not_rounded_away(self):
        self.rebuild(classification=make_xlsx(delta=.001))
        with self.assertRaisesRegex(ValueError, 'TOTAL_PRECISION'):
            self.invoke()

    def test_orphan_source_row_is_not_silently_dropped(self):
        self.rebuild(classification=make_xlsx(orphan=True))
        with self.assertRaisesRegex(ValueError, 'UNACCOUNTED_SOURCE_ROW'):
            self.invoke()

    def test_formulas_and_conflicting_cache_refuse(self):
        for formula in ['SUM(G3:G12)', '999']:
            self.rebuild(classification=make_xlsx(formula=formula))
            with self.assertRaises(ValueError):
                self.invoke()

    def test_xml_entity_and_duplicate_sheet_refuse(self):
        for options in [dict(extra_xml='<!DOCTYPE worksheet [<!ENTITY x "unsafe">]>'), dict(sheet_duplicate=True)]:
            self.rebuild(classification=make_xlsx(**options))
            with self.assertRaises(ValueError):
                self.invoke()

    def test_leaf_and_parent_symlink_refuse(self):
        original = self.request['bindings']['classification']['path']
        leaf = self.root/'linked.xlsx'
        leaf.symlink_to(original)
        self.request['bindings']['classification']['path'] = str(leaf)
        with self.assertRaises(OSError):
            self.invoke()
        parent = self.root/'linked-dir'
        parent.symlink_to(self.root, target_is_directory=True)
        self.request['bindings']['classification']['path'] = str(parent/'classification.xlsx')
        with self.assertRaises(OSError):
            self.invoke()

    def test_public_mode_and_hardlink_refuse(self):
        path = Path(self.request['bindings']['classification']['path'])
        path.chmod(0o644)
        with self.assertRaisesRegex(ValueError, 'PRIVATE_FILE'):
            self.invoke()
        path.chmod(0o600)
        os.link(path, self.root/'hardlink.xlsx')
        with self.assertRaisesRegex(ValueError, 'PRIVATE_FILE'):
            self.invoke()

    def test_caller_cannot_inject_verifier_or_clock(self):
        for key in ['now', 'readIdentity', 'expectedAccounts', 'allowHistoricalTolerance', 'inception']:
            request = copy.deepcopy(self.request)
            request[key] = True
            with self.assertRaisesRegex(ValueError, 'REQUEST_SCHEMA'):
                self.invoke(request)
        self.assertEqual(list(inspect.signature(adapter.prepare_offline_allocation).parameters), ['request', 'enabled'])

    def test_json_duplicates_and_nonfinite_refuse(self):
        for blob in [b'{"a":1,"a":2}', b'{"a":NaN}', b'{"a":1e999}']:
            with self.assertRaises(ValueError):
                bound_files.strict_json(blob)

    def test_source_change_between_reads_refuses(self):
        real = adapter.read_bound_file
        calls = 0
        def changed(spec):
            nonlocal calls
            calls += 1
            if calls == 4:
                return b'changed'
            return real(spec)
        with patch('adapter.offline_adapter.read_bound_file', side_effect=changed), self.assertRaisesRegex(ValueError, 'SOURCE_CHANGED'):
            self.invoke()


class NativeAggregateTests(unittest.TestCase):
    def parse(self, **opts):
        blob = make_xlsx(perf=True, **opts)
        source = dict(libraryFileId='libfile_'+'a'*32, version=0, sha256=hashlib.sha256(blob).hexdigest())
        return parse_aggregates(blob, period='oneYear', start_date='2025-11-12', end_date='2026-11-12', accounts=ACCOUNTS, cash_performance='included', source=source)

    def test_native_total_members_source_coordinates_and_unit(self):
        report, check = self.parse()
        root = next(r for r in report['rows'] if r['scope']['type']=='portfolio')
        self.assertEqual(len(root['members']), 10)
        self.assertEqual(root['sourceSheet'], 'Combined')
        self.assertEqual(root['sourceRow'], 14)
        self.assertEqual(root['returnPct'], 12)
        self.assertEqual(root['unit'], 'p.a.')
        self.assertEqual(root['termEvidence'], {'type': 'unknown'})
        self.assertNotIn('inceptionEvidence', report)
        self.assertEqual(check['individualReturnRows'], 0)

    def test_native_total_no_tolerance(self):
        with self.assertRaisesRegex(ValueError, 'STRICT_NATIVE_TOTAL_MISMATCH'):
            self.parse(delta=.01)

    def test_native_boundary_never_claims_identity_or_complete_evidence(self):
        blob = make_xlsx(perf=True)
        result = parse_native_aggregate_candidate(blob, period='oneYear', start_date='2025-11-12', end_date='2026-11-12',
            accounts=ACCOUNTS, cash_performance='included', source=dict(libraryFileId='libfile_'+'a'*32, version=0, sha256=hashlib.sha256(blob).hexdigest()))
        self.assertEqual(result['state'], 'PARSED_NATIVE_AGGREGATE_UNAUTHENTICATED')
        self.assertFalse(result['actualIdentityAndBytesChecked'])
        self.assertFalse(result['fullPerformanceReady'])
        self.assertFalse(result['publicationReady'])

    def test_native_parser_refuses_path_input(self):
        with self.assertRaisesRegex(ValueError, 'IMMUTABLE_SOURCE_BYTES'):
            parse_aggregates('/not/read.xlsx', period='oneYear', start_date='2025-11-12', end_date='2026-11-12',
                accounts=ACCOUNTS, cash_performance='included', source={})

    def test_closed_and_membership_evidence_refuse(self):
        for options in [dict(include_closed=False), dict(missing_group=True)]:
            with self.assertRaises(ValueError):
                self.parse(**options)

    def test_unit_not_invented(self):
        self.assertEqual(native_percentage(12, 'General')[1], 'unknown')
        self.assertEqual(native_percentage(.12, '0.00%')[0:2], (12, 'unknown'))


if __name__ == '__main__':
    unittest.main()
