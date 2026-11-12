"""Full source-set boundary tests. Every byte and identity here is invented."""
import copy
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from adapter import offline_adapter
from adapter import performance_boundary as boundary
from synthetic_fixtures import ACCOUNTS, NOW, SCOPE, batch, make_xlsx


class Clock(dt.datetime):
    @classmethod
    def now(cls, tz=None):
        return cls.fromtimestamp(NOW.timestamp(), tz=tz or dt.timezone.utc)


def fixture(root):
    root = Path(root)
    original, identities = batch(root)
    bindings = {'allocation': original['bindings']}
    count = 10
    def write(name, blob):
        nonlocal count
        count += 1
        path = root/name
        path.write_bytes(blob)
        path.chmod(0o600)
        ident = 'libfile_' + '%032x' % count
        identities[path.stat().st_ino] = (ident, '0')
        return dict(path=str(path), libraryFileId=ident, libraryVersion=0, sha256=hashlib.sha256(blob).hexdigest())
    at = NOW-dt.timedelta(hours=1)
    for role, group in boundary.GROUPS.items():
        label = 'Uncategorised' if role == 'strategy' else '股票市场' if role == 'stock' else '美国底仓'
        reports = {}
        bindings[role] = {}
        for period in ['all', 'oneYear']:
            blob = make_xlsx(perf=True, group=group, label=label)
            bindings[role][period] = write(role+'-'+period+'.xlsx', blob)
            reports[period] = dict(sha256=hashlib.sha256(blob).hexdigest(), rangeKind='since-inception' if period=='all' else 'trailing-twelve-months',
                startDate='2025-11-12', endDate='2026-11-12', includeClosed=True, combineByHolding=False, currency='USD', groupBy=group,
                cashPerformance='included', originalMtimeNs=str(int(at.timestamp())*1000000000), downloadStartedAt=None, downloadCompletedAt=None,
                observedCompleteAt=at.isoformat(timespec='milliseconds').replace('+00:00','Z'))
        bindings[role]['capture'] = write(role+'-capture.json', json.dumps(dict(schema='fee-console.performance-capture.v1', accounts=ACCOUNTS, reports=reports)).encode())
    archive = write('synthetic-observation.json', b'{"syntheticOnly":true,"notProviderEvidence":true}')
    captured = '2026-01-02T00:00:00.000Z'
    evidence = dict(schema='fee-console.ratio-inception-source.v2', capturedAt=captured, includeClosed=True,
        sources=[dict(libraryFileId=archive['libraryFileId'], version=0, sha256=archive['sha256'], locator='synthetic assertion')],
        sourceCaptures=[dict(libraryFileId=archive['libraryFileId'], capturedAt=captured, sourceKind='verified-historical-archive')],
        members=[dict(account=account, market='SYNTH', securityCode='SYN%02d'%n, startDate='2026-01-01', dateKind='holding-inception',
                      sourceFileId=archive['libraryFileId'], sourceLocator='synthetic members[%d]'%n) for n,account in enumerate(ACCOUNTS)])
    document = write('inception.json', json.dumps(evidence).encode())
    return dict(schema='ratio-offline-workbook-batch.v1', targetDate='2026-11-12', allStartDate='2025-11-12', bindings=bindings,
                inception=dict(document=document, sources=[archive])), identities


class PerformanceBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='synthetic-performance-')
        self.root = Path(self.tmp.name)
        self.request, self.identities = fixture(self.root)
        def attrs(fd, name):
            item = self.identities[os.fstat(fd).st_ino]
            return item[0 if name=='user.library-file-id' else 1].encode()
        self.patches = [patch('adapter.bound_files.os.getxattr', side_effect=attrs),
                        patch('adapter.bound_files.os.setxattr', side_effect=AssertionError('no identity writes')),
                        patch.object(offline_adapter,'ALL_TOGETHER_SCOPE_SHA256',SCOPE),
                        patch('adapter.performance_boundary.dt.datetime', Clock),
                        patch('socket.socket',side_effect=AssertionError('no network')),
                        patch('subprocess.run',side_effect=AssertionError('no external command'))]
        for mocked in self.patches:
            mocked.start()

    def tearDown(self):
        for mocked in reversed(self.patches):
            mocked.stop()
        self.tmp.cleanup()

    def invoke(self):
        return boundary.prepare_offline_workbook_batch(self.request, enabled=True)

    def rewrite(self, spec, transform):
        path = Path(spec['path'])
        value = json.loads(path.read_text())
        transform(value)
        blob = json.dumps(value).encode()
        path.write_bytes(blob)
        spec['sha256'] = hashlib.sha256(blob).hexdigest()

    def replace_workbook(self, role, period, blob):
        spec=self.request['bindings'][role][period]
        Path(spec['path']).write_bytes(blob)
        spec['sha256']=hashlib.sha256(blob).hexdigest()
        self.rewrite(self.request['bindings'][role]['capture'],lambda c:c['reports'][period].update(sha256=spec['sha256']))

    def add_browser_evidence(self, quantity=10):
        path=self.root/'synthetic-browser.json';blob=b'{"syntheticOnly":true,"notProviderEvidence":true}'
        path.write_bytes(blob);path.chmod(0o600)
        ident='libfile_'+'e'*32
        spec=dict(path=str(path),libraryFileId=ident,libraryVersion=0,sha256=hashlib.sha256(blob).hexdigest())
        self.identities[path.stat().st_ino]=(ident,'0')
        self.request['inception']['sources'].append(spec)
        def change(e):
            stamp='2026-11-12T11:00:00.000Z';e['capturedAt']=stamp
            e['sources'].append(dict(libraryFileId=ident,version=0,sha256=spec['sha256'],locator='synthetic browser assertion'))
            e['sourceCaptures'].append(dict(libraryFileId=ident,capturedAt=stamp,sourceKind='browser-first-recorded-buy'))
            e['members'][0].update(startDate='2026-11-11',dateKind='browser-first-recorded-buy',sourceFileId=ident,
                browserEvidence=dict(view='All trades & adjustments',complete=True,currentQuantity=quantity,
                    records=[dict(type='Buy',status='Confirmed',date='2026-11-11',quantity=quantity)]))
        self.rewrite(self.request['inception']['document'],change)

    def test_disabled_does_not_inspect_input(self):
        with patch('adapter.performance_boundary.read_bound_file',side_effect=AssertionError('no read')):
            self.assertEqual(boundary.prepare_offline_workbook_batch(None)['state'],'DISABLED')

    def test_synthetic_complete_source_set_stays_unpublished_unassembled(self):
        result = self.invoke()
        self.assertEqual(result['workbookCount'],10)
        self.assertEqual(result['captureCount'],5)
        self.assertTrue(result['nativeMemberSetsBound'])
        self.assertFalse(result['fullPerformanceReady'])
        self.assertFalse(result['sourceOriginVerified'])
        self.assertFalse(result['publicationReady'])
        self.assertIn('COMPLETE_NATIVE_REPORT_ASSEMBLY',result['blockedOn'])
        self.assertEqual(result['inceptionEvidence']['capturedAt'],'2026-01-02T00:00:00.000Z')
        self.assertEqual(result['performanceCapturedAt'],'2026-11-12T11:00:00.000Z')

    def test_missing_report_role_period_and_capture(self):
        original = copy.deepcopy(self.request)
        for role, child in [('stock',None),('top5','oneYear'),('strategy','capture')]:
            self.request=copy.deepcopy(original)
            if child is None:del self.request['bindings'][role]
            else:del self.request['bindings'][role][child]
            with self.assertRaises(ValueError):self.invoke()

    def test_wrong_identity_hash_or_duplicate_source_id(self):
        spec=self.request['bindings']['stock']['all']
        expected=spec['sha256'];spec['sha256']='f'*64
        with self.assertRaisesRegex(ValueError,'SOURCE_HASH'):self.invoke()
        spec['sha256']=expected
        self.request['inception']['sources'].append(copy.deepcopy(self.request['inception']['sources'][0]))
        with self.assertRaisesRegex(ValueError,'DUPLICATE_IDENTITY'):self.invoke()

    def test_capture_scope_controls_and_hash(self):
        capture=self.request['bindings']['assetclass']['capture']
        original=Path(capture['path']).read_bytes()
        for transform in [lambda c:c.update(accounts=['wrong']), lambda c:c['reports']['all'].update(includeClosed=False),
                          lambda c:c['reports']['all'].update(currency='HKD'),lambda c:c['reports']['all'].update(cashPerformance='excluded'),
                          lambda c:c['reports']['all'].update(sha256='a'*64)]:
            Path(capture['path']).write_bytes(original);capture['sha256']=hashlib.sha256(original).hexdigest()
            self.rewrite(capture,transform)
            with self.assertRaises(ValueError):self.invoke()

    def test_cross_report_native_value_conflict_refuses(self):
        self.replace_workbook('top5','all',make_xlsx(perf=True,group=boundary.GROUPS['top5'],rate='13% p.a.'))
        with self.assertRaisesRegex(ValueError,'CROSS_REPORT_VALUE_DIFFERENCE'):self.invoke()

    def test_stock_group_must_match_existing_stock_members(self):
        self.replace_workbook('stock','all',make_xlsx(perf=True,group=boundary.GROUPS['stock'],label='Uncategorised'))
        with self.assertRaisesRegex(ValueError,'STOCK_GROUP_MEMBERS'):self.invoke()

    def test_strategy_group_must_match_source_category(self):
        self.replace_workbook('strategy','all',make_xlsx(perf=True,group=boundary.GROUPS['strategy'],label='美国底仓'))
        with self.assertRaisesRegex(ValueError,'STRATEGY_GROUP_MEMBERS'):self.invoke()

    def test_grouping_member_omission_is_not_partial_success(self):
        self.replace_workbook('top5','all',make_xlsx(perf=True,group=boundary.GROUPS['top5'],missing_group=True))
        with self.assertRaises(ValueError):self.invoke()

    def test_browser_quantity_matches_actual_allocation_candidate(self):
        self.add_browser_evidence()
        result=self.invoke()
        self.assertEqual(result['inceptionChecks']['browserMemberCount'],1)
        self.assertFalse(result['sourceOriginVerified'])
        json.dumps(result,allow_nan=False)

    def test_browser_assertion_quantity_conflict_refuses(self):
        self.add_browser_evidence(quantity=11)
        with self.assertRaisesRegex(ValueError,'CURRENT_QUANTITY'):self.invoke()

    def test_stale_report_date_cannot_be_refreshed_by_new_capture(self):
        self.request['targetDate']='2026-10-01'
        self.request['allStartDate']='2025-10-01'
        with self.assertRaises(ValueError):self.invoke()

    def test_public_entry_rejects_nonboolean_enable(self):
        for flag in [1,'true',None]:
            with self.assertRaises(ValueError):boundary.prepare_offline_workbook_batch(self.request,enabled=flag)

    def test_combined_top5_flag_does_not_replace_actual_header(self):
        self.rewrite(self.request['bindings']['top5']['capture'],lambda c:c['reports']['all'].update(combineByHolding=True))
        with self.assertRaisesRegex(ValueError,'TOP5_HEADER'):self.invoke()

    def test_performance_stale_or_future_time(self):
        capture=self.request['bindings']['stock']['capture'];original=Path(capture['path']).read_bytes()
        for hours in [-37,1]:
            Path(capture['path']).write_bytes(original);capture['sha256']=hashlib.sha256(original).hexdigest()
            at=NOW+dt.timedelta(hours=hours)
            self.rewrite(capture,lambda c:c['reports']['all'].update(originalMtimeNs=str(int(at.timestamp())*1000000000),observedCompleteAt=at.isoformat(timespec='milliseconds').replace('+00:00','Z')))
            with self.assertRaisesRegex(ValueError,'PERFORMANCE_CAPTURE_AGE'):self.invoke()

    def test_original_performance_timestamp_type_is_not_coerced(self):
        self.rewrite(self.request['bindings']['stock']['capture'],lambda c:c['reports']['all'].update(originalMtimeNs=1794481200000000000))
        with self.assertRaisesRegex(ValueError,'PERFORMANCE_ORIGINAL_TIME'):self.invoke()

    def test_report_dates_match_capture(self):
        self.rewrite(self.request['bindings']['strategy']['capture'],lambda c:c['reports']['all'].update(startDate='2020-01-01'))
        with self.assertRaisesRegex(ValueError,'PERFORMANCE_RANGE'):self.invoke()

    def test_inception_missing_conflicting_or_extra_member(self):
        spec=self.request['inception']['document'];original=Path(spec['path']).read_bytes()
        for transform in [lambda e:e['members'].pop(),lambda e:e['members'].append(copy.deepcopy(e['members'][0])),
                          lambda e:e['members'][0].update(securityCode='OTHER')]:
            Path(spec['path']).write_bytes(original);spec['sha256']=hashlib.sha256(original).hexdigest()
            self.rewrite(spec,transform)
            with self.assertRaises(ValueError):self.invoke()

    def test_inception_actual_source_pin_must_match(self):
        self.rewrite(self.request['inception']['document'],lambda e:e['sources'][0].update(sha256='f'*64))
        with self.assertRaisesRegex(ValueError,'INCEPTION_SOURCE_PIN'):self.invoke()

    def test_inception_required_actual_source_missing(self):
        self.request['inception']['sources']=[]
        with self.assertRaisesRegex(ValueError,'INCEPTION_BINDINGS'):self.invoke()

    def test_unknown_inception_or_earlier_than_query_window_refuses(self):
        spec=self.request['inception']['document'];original=Path(spec['path']).read_bytes()
        self.rewrite(spec,lambda e:e.update(schema='fee-console.ratio-inception-source.v1'))
        with self.assertRaises(ValueError):self.invoke()
        Path(spec['path']).write_bytes(original);spec['sha256']=hashlib.sha256(original).hexdigest()
        self.rewrite(spec,lambda e:e['members'][0].update(startDate='2010-01-01'))
        with self.assertRaisesRegex(ValueError,'INCEPTION_BEFORE_ALL_WINDOW'):self.invoke()

    def test_request_cannot_supply_clock_scope_or_verifier(self):
        for key in ['now','scopeSha256','verifier','productionEnabled']:
            self.request[key]=True
            with self.assertRaisesRegex(ValueError,'PERFORMANCE_REQUEST'):self.invoke()
            del self.request[key]

    def test_recheck_source_change_refuses(self):
        real=boundary.read_bound_file;count=0
        def read(spec):
            nonlocal count
            count+=1
            if count==18:return b'changed'
            return real(spec)
        with patch('adapter.performance_boundary.read_bound_file',side_effect=read),self.assertRaisesRegex(ValueError,'SOURCE_CHANGED'):
            self.invoke()


if __name__=='__main__':unittest.main()
