"""Synthetic data and fake transports only; socket/DNS use fails the suite."""
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import ast
import json
from pathlib import Path
import socket
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / 'test-support'))
from schwab_sync.ib_daily import DailyIB, SourceOutcomeUnknown, request_id, schedule_slot
from schwab_sync.ib_daily_source import CloudSource, JOB, CONTRACT
from schwab_sync.ib_daily_runtime import destination, load_config, install_daily, daily_store
from schwab_sync.ib_snapshot import IBSnapshotError
from schwab_sync.storage import MemoryStateStore, GCSStateStore

NOW = datetime.fromisoformat('2026-10-22T04:15:00+00:00')
IDENTITY = {'contract_id': '101', 'instrument_id': '202', 'currency': 'USD', 'code': 'SYNTH', 'venue': 'NASDAQ'}
CONFIG = {'schema': 1, 'source_service_account': 'synthetic@family-portfolio-gateway.iam.gserviceaccount.com',
          'source_image': 'asia-east2-docker.pkg.dev/family-portfolio-gateway/synthetic/image@sha256:' + 'a'*64,
          'client_id': 'synthetic-client', 'association_policy_blob': 'b'*40,
          'identity_pending': [], 'identities': [IDENTITY]}


def initial():
    return {'schema_version': 1, 'schwab_keep': {'unchanged': True},
            'ib_gmail_canary': {'events': {}, 'processed_trades': {}, 'processed_messages': {'old': 'keep'}}}


def book(source, stamp=NOW, quantity='3', cash='50.25'):
    return {'source': source, 'read_kind': 'live', 'binding_verified': True,
            'instrument_mapping_verified': True, 'positions_complete': True, 'cash_complete': True,
            'cash_basis': 'total_trade_date', 'positions': [{'instrument_key': 'instrument:202', 'quantity': quantity}],
            'cash': [{'currency': 'USD', 'balance': cash}, {'currency': 'CAD', 'balance': '2'}],
            'as_of': None, 'read_started_at': stamp.isoformat(), 'read_completed_at': stamp.isoformat()}


class DailyTests(unittest.TestCase):
    def setUp(self):
        self.clock, self.calls, self.events = NOW, 0, 0
        self.store = MemoryStateStore(initial())
        self.failure, self.different, self.cash_difference = None, False, False

    def factory(self, target, slot, request):
        def read():
            self.calls += 1
            if self.failure:
                raise self.failure
            return book('IB', self.clock), book('SHARESIGHT', self.clock,
                quantity='2' if self.different else '3', cash='49' if self.cash_difference else '50.25')
        return read

    def runner(self, **kw):
        return DailyIB(self.store, self.factory, now=lambda: self.clock, **kw)

    def fallback(self):
        self.clock = self.clock.replace(minute=30)

    def test_equal_completes_and_preserves_other_brokers_and_manual_journals(self):
        self.store.value['ib_gmail_canary']['events']['manual'] = {'status': 'DUPLICATE'}
        before = deepcopy(self.store.value['ib_gmail_canary'])
        result = self.runner().run()
        self.assertEqual((result['status'], self.calls, result['sharesight_writes']), ('COMPLETE', 1, 0))
        self.assertEqual(self.store.value['ib_gmail_canary'], before)
        self.assertEqual(self.store.value['schwab_keep'], {'unchanged': True})

    def test_successful_1230_does_not_construct_provider_or_read_events(self):
        self.runner().run(); self.fallback()
        def forbidden(*a): raise AssertionError('provider constructed after final success')
        result = DailyIB(self.store, forbidden, now=lambda:self.clock).run()
        self.assertEqual(result['reason_code'], 'IB_DAY_ALREADY_FINALIZED')
        self.assertEqual(self.calls, 1)

    def test_failed_primary_then_only_one_fallback(self):
        self.failure = IBSnapshotError('IB_READ_UNAVAILABLE')
        self.assertEqual(self.runner().run()['status'], 'ATTENTION')
        self.runner().run(); self.assertEqual(self.calls, 1)
        self.fallback(); self.failure = None
        self.assertEqual(self.runner().run()['status'], 'COMPLETE')
        self.runner().run(); self.assertEqual(self.calls, 2)

    def test_difference_only_records_private_list_and_skips_completed_comparison(self):
        self.different = True
        result = self.runner().run()
        self.assertEqual((result['status'], result['reason_code'], self.calls),
                         ('DIFFERENCE_PENDING_TIMING', 'IB_DIFFERENCE_REQUIRES_REVIEW', 1))
        self.assertTrue(result['comparison_complete']); self.assertTrue(result['notification_required'])
        self.assertFalse(result['retry_at_1230']); self.assertEqual(result['sharesight_writes'], 0)
        self.assertNotIn('success', self.store.value['ib_daily']['days']['2026-10-21'])
        self.assertNotIn('private_differences', result); self.assertNotIn('instrument:202', json.dumps(result))
        private = self.store.value['ib_daily']['days']['2026-10-21']['comparison']['private_differences']
        self.assertEqual(private['positions'], [{'instrument_key':'instrument:202', 'ib':'3', 'sharesight':'2', 'ib_minus_sharesight':'1'}])
        self.fallback(); again = self.runner().run()
        self.assertEqual(again['reason_code'], 'IB_DAY_ALREADY_CHECKED'); self.assertFalse(again['notification_required'])
        self.assertEqual(self.calls, 1)

    def test_cash_difference_never_balanced(self):
        self.cash_difference = True
        result = self.runner().run()
        self.assertEqual((result['status'], result['different_currency_count'], result['financial_mutations']), ('DIFFERENCE_PENDING_TIMING', 1, 0))

    def test_unknown_source_outcome_blocks_fallback_dispatch(self):
        self.failure = SourceOutcomeUnknown()
        self.assertEqual(self.runner().run()['status'], 'SOURCE_OUTCOME_UNKNOWN')
        self.fallback(); self.failure = None
        self.assertEqual(self.runner().run()['reason_code'], 'IB_DAILY_PREVIOUS_OUTCOME_UNKNOWN')
        self.assertEqual(self.calls, 1)

    def test_crash_after_claim_blocks_other_slot(self):
        class Crash(BaseException): pass
        self.failure = Crash()
        with self.assertRaises(Crash): self.runner().run()
        self.fallback(); self.failure = None
        self.assertEqual(self.runner().run()['reason_code'], 'IB_DAILY_PREVIOUS_OUTCOME_UNKNOWN')
        self.assertEqual(self.calls, 1)

    def test_uncertain_claim_never_reads(self):
        original = self.store.write
        def uncertain(*a): original(*a); raise OSError('unknown result')
        self.store.write = uncertain
        self.assertEqual(self.runner().run()['status'], 'ATTENTION')
        self.assertEqual(self.calls, 0)

    def test_uncertain_result_write_cannot_be_replayed(self):
        original = self.store.write; writes = []
        def uncertain(*a):
            writes.append(1)
            if len(writes) == 2: raise OSError('no confirmation')
            return original(*a)
        self.store.write = uncertain
        self.assertEqual(self.runner().run()['reason_code'], 'IB_DAILY_RESULT_SAVE_UNCONFIRMED')
        self.fallback(); self.runner().run(); self.assertEqual(self.calls, 1)

    def test_prior_unknown_ledger_submission_blocks_sources(self):
        self.store.value['ib_gmail_canary']['events']['old'] = {'status': 'UNKNOWN'}
        self.assertEqual(self.runner().run()['reason_code'], 'IB_UNRESOLVED_PRIOR_SUBMISSION')
        self.assertEqual(self.calls, 0)

    def test_journal_change_does_not_reuse_stale_success(self):
        self.runner().run()
        self.store.value['ib_gmail_canary']['events']['new'] = {'status': 'VERIFIED'}
        self.assertEqual(self.runner().run()['status'], 'ATTENTION')
        self.fallback(); self.assertEqual(self.runner().run()['status'], 'COMPLETE')
        self.assertEqual(self.calls, 2)

    def test_windows_dst_and_stable_claim(self):
        self.assertEqual(schedule_slot(NOW), ('2026-10-21', '1215'))
        self.assertEqual(schedule_slot(datetime.fromisoformat('2026-11-03T04:15:00+00:00')), ('2026-11-02', '1215'))
        self.assertIsNone(schedule_slot(NOW.replace(minute=25)))
        self.assertIsNone(schedule_slot(datetime.fromisoformat('2026-10-25T04:15:00+00:00')))
        self.assertEqual(request_id('2026-10-21','1215'),request_id('2026-10-21','1215'))
        self.assertNotEqual(request_id('2026-10-21','1215'),request_id('2026-10-21','1230'))

    def test_missing_primary_allows_one_fallback(self):
        self.fallback(); self.assertEqual(self.runner().run()['status'], 'COMPLETE')
        self.assertEqual(self.calls, 1)

    def test_difference_preparation_failure_cannot_finalize_the_day(self):
        self.different = True
        with patch('schwab_sync.ib_daily.private_differences', side_effect=IBSnapshotError('IB_DIFFERENCE_INVALID')):
            result = self.runner().run()
        self.assertEqual(result['status'], 'ATTENTION'); self.assertFalse(result['comparison_complete'])
        self.assertNotIn('comparison', self.store.value['ib_daily']['days']['2026-10-21'])
        self.fallback(); self.different = False
        self.assertEqual(self.runner().run()['status'], 'COMPLETE'); self.assertEqual(self.calls, 2)

    def test_native_cash_difference_retained_privately_without_balance_adjustment(self):
        self.cash_difference = True
        result = self.runner().run()
        private = self.store.value['ib_daily']['days']['2026-10-21']['comparison']['private_differences']
        self.assertEqual(private['cash'], [{'currency':'USD','ib':'50.25','sharesight':'49','ib_minus_sharesight':'1.25'}])
        self.assertEqual(private['positions'], []); self.assertEqual(result['financial_mutations'], 0)
        self.assertNotIn('50.25', json.dumps(result)); self.assertNotIn('1.25', json.dumps(result))

    def test_existing_alert_event_contains_only_public_counts_and_no_second_notification(self):
        self.different = True
        ns = {}
        with patch.dict('os.environ', {'IB_DAILY_MODE':'readonly'}): install_daily(ns)
        with patch('schwab_sync.ib_daily_runtime.configured_runner', return_value=self.runner()):
            with self.assertLogs('schwab_sync', level='WARNING') as logs: result = ns['_ib_daily_run']()
            text = ''.join(logs.output)
            self.assertIn('IB_TRADE_RECHECK_ATTENTION', text); self.assertNotIn('instrument:202', text)
            self.assertNotIn('private_differences', text); self.assertEqual(result['different_instrument_count'], 1)
        self.fallback()
        with patch('schwab_sync.ib_daily_runtime.configured_runner', return_value=self.runner()):
            with self.assertNoLogs('schwab_sync', level='WARNING'): ns['_ib_daily_run']()
        self.assertEqual(self.calls, 1)


class DestinationTests(unittest.TestCase):
    def client(self, *, next_page=None, duplicate=False):
        h = {'id': 303, 'quantity': '3', 'instrument': {'id':202,'code':'SYNTH','market_code':'NASDAQ','currency_code':'USD'}}
        from schwab_sync.clients import IB_PORTFOLIO_ID
        return SimpleNamespace(holdings=lambda:{'holdings':[h,h] if duplicate else [h], 'next':next_page},
            cash_accounts=lambda:{'cash_accounts':[{'id':404,'portfolio_id':IB_PORTFOLIO_ID,'currency':'USD','balance':'50.25'},
                                                   {'id':405,'portfolio_id':IB_PORTFOLIO_ID,'currency':'CAD','balance':'2'}]})

    def test_complete_native_currency_snapshot(self):
        result = destination(self.client(), CONFIG, lambda:NOW)
        self.assertEqual(result['positions'], [{'instrument_key':'instrument:202','quantity':'3'}])
        self.assertEqual({r['currency'] for r in result['cash']}, {'USD','CAD'})
        self.assertIsNone(result['as_of'])

    def test_pagination_duplicate_or_unknown_identity_stops(self):
        for client,cfg in [(self.client(next_page='next'),CONFIG),(self.client(duplicate=True),CONFIG),
                           (self.client(),{**CONFIG,'identities':[]})]:
            with self.subTest(cfg=bool(cfg['identities'])):
                with self.assertRaises(IBSnapshotError):destination(client,cfg,lambda:NOW)

    def test_unconfirmed_real_mapping_blocks_before_any_sdk(self):
        with self.assertRaisesRegex(IBSnapshotError, 'IB_DAILY_SECURITY_IDENTITY_PENDING'):
            load_config(ROOT/'worker/schwab_sync/ib_daily_bindings.json')

    def test_only_exact_mode_installs_new_ib_hook(self):
        ns = {}
        with patch.dict('os.environ', {'IB_DAILY_MODE':'off'}):install_daily(ns)
        self.assertEqual(ns,{})
        with patch.dict('os.environ', {'IB_DAILY_MODE':'readonly'}):install_daily(ns)
        self.assertEqual(set(ns),{'_ib_daily_run'})
        self.assertEqual(ns['_ib_daily_run']()['status'], 'ATTENTION')

    def test_first_phase_has_no_event_reader_or_flex_import(self):
        for name in ('ib_daily.py', 'ib_daily_runtime.py'):
            tree = ast.parse((ROOT/'worker/schwab_sync'/name).read_text())
            names = {node.id for node in ast.walk(tree) if isinstance(node, ast.Name)}
            self.assertNotIn('event_reader', names); self.assertNotIn('DatedIBTradeFlexClient', names)
            imports = [node.module for node in ast.walk(tree) if isinstance(node, ast.ImportFrom)]
            self.assertNotIn('ib_trade_recheck', imports)

    def test_existing_route_returns_daily_result_without_constructing_other_brokers(self):
        tree=ast.parse((ROOT/'route.fixture.py').read_text())
        function=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='install_ib_trade_recheck')
        ns={'Any':object,'DatedIBTradeFlexClient':object,'IBTradeSyncService':type('Fake',(),{}),
            '_verified_legacy_matches':lambda *a:[]}
        exec(compile(ast.fix_missing_locations(ast.Module(body=[function],type_ignores=[])),'local-route','exec'),ns)
        routes={}
        app=SimpleNamespace(state=SimpleNamespace(),add_api_route=lambda path,fn,methods:routes.update({path:fn}))
        expected={'status':'DIFFERENCE_PENDING_TIMING','reason_code':'IB_DIFFERENCE_REQUIRES_REVIEW'}
        def forbidden():raise AssertionError('legacy runtime was constructed')
        ns['install_ib_trade_recheck'](app,{'_ib_daily_run':lambda:expected,'_unified_runtime':forbidden})
        self.assertEqual(routes['/maintenance/ib-trade-recheck'](),expected)

    def test_failure_notification_waits_for_fallback(self):
        store = MemoryStateStore(initial())
        def factory(*args):
            def read(): raise IBSnapshotError('IB_READ_UNAVAILABLE')
            return read
        first = DailyIB(store, factory, now=lambda:NOW).run()
        self.assertTrue(first['retry_at_1230']); self.assertFalse(first['notification_required'])
        last = DailyIB(store, factory, now=lambda:NOW.replace(minute=30)).run()
        self.assertFalse(last['retry_at_1230']); self.assertTrue(last['notification_required'])
        duplicate = DailyIB(store, factory, now=lambda:NOW.replace(minute=30)).run()
        self.assertFalse(duplicate['notification_required'])



class StateTransportTests(unittest.TestCase):
    def prepare(self, uncertain=False):
        operations=[]
        class Blob:
            generation=9
            def reload(self,**kw):operations.append(('reload',kw))
            def download_as_text(self,**kw):operations.append(('read',kw));return json.dumps(initial())
            def upload_from_string(self,body,**kw):
                operations.append(('write',kw));self.generation=10
                if uncertain:raise TimeoutError('unknown write')
        blob=Blob()
        def init(store,bucket):
            store.bucket_name=bucket;store.key='schwab-sync-state.json'
            store.client=SimpleNamespace(bucket=lambda _:SimpleNamespace(blob=lambda _:blob))
        with patch.object(GCSStateStore,'__init__',init):store=daily_store('synthetic-state-bucket')
        return store,operations

    def test_state_reads_are_generation_pinned_and_writes_do_not_retry_or_reload(self):
        store,operations=self.prepare();state,generation=store.read()
        self.assertEqual(store.write(state,generation),10)
        self.assertEqual([k for k,_ in operations],['reload','read','write'])
        self.assertEqual(operations[1][1]['if_generation_match'],9)
        self.assertTrue(all(v['retry'] is None and v['timeout']==10 for _,v in operations))

    def test_uncertain_state_write_is_not_repeated(self):
        store,operations=self.prepare(uncertain=True)
        with self.assertRaises(TimeoutError):store.write(initial(),9)
        self.assertEqual([k for k,_ in operations],['write'])


class SourceTests(unittest.TestCase):
    def setup_source(self, *, drift=False, post_failure=False, corrupt=False, terminal_failure=False):
        rid=request_id('2026-10-21','1215'); stamp=NOW.isoformat()
        assessment={'comparisonReady':True,'contractSha256':CONTRACT,'positionsComplete':True,'cashComplete':True,
                    'providerTimesValid':True,'providerAsOfBySource':{'positions':None,'balances':None},'providerAsOf':None}
        capture={'source':'IB_MCP','startedAt':stamp,'completedAt':stamp,'sources':[
            {'sourceKey':'ib.positions','startedAt':stamp,'completedAt':stamp,'raw':{'positions':[{'contract_id':101,'currency':'USD','position':3}]}},
            {'sourceKey':'ib.balances','startedAt':stamp,'completedAt':stamp,'raw':{'balances':[{'currency':'BASE','cash_balance':999}, {'currency':'USD','cash_balance':50.25}, {'currency':'CAD','cash_balance':2}]}}]}
        snapshot={'requestId':rid,'dataDate':'2026-10-22','assessment':assessment,'capture':capture,
                  'credentialVersionMatched':True,'credentialClientMatched':True,'association':{'policyBlob':'b'*40}}
        raw=json.dumps(snapshot).encode(); prefix='report-check/ib-sync-'+rid+'/'
        receipt={'requestId':rid,'mode':'ib-sync-readonly-snapshot','status':'failed' if terminal_failure else 'passed',
                 'assessment':assessment,'consumedCredentialVersion':'projects/family-portfolio-gateway/secrets/xuan-preopen-ib-mcp/versions/7',
                 'execution':'ib-daily-snapshot-synthetic','association':snapshot['association'],
                 'positionsCalls':1,'balancesCalls':1,'rpcMessages':4,'refreshCalls':0,
                 'artifact':{'privateObject':prefix+'snapshot.json','generation':'9','sha256':hashlib.sha256(raw).hexdigest()}}
        objects={prefix+'receipt.json':json.dumps(receipt).encode(),prefix+'snapshot.json':raw+b' ' if corrupt else raw}
        class Blob:
            def __init__(self,name,generation):self.name=name;self.generation=generation or 10;self.size=len(objects[name])
            def reload(self,**kw):pass
            def download_as_bytes(self,**kw):return objects[self.name]
        storage=SimpleNamespace(bucket=lambda name:SimpleNamespace(blob=lambda name,generation=None:Blob(name,generation)))
        requests=[]
        class Session:
            def request(self,method,url,**kw):
                requests.append((method,url,kw))
                if url.endswith('/versions/latest'):payload={'name':'projects/family-portfolio-gateway/secrets/xuan-preopen-ib-mcp/versions/7','state':'ENABLED'}
                elif method=='POST':
                    if post_failure:raise TimeoutError('unknown POST')
                    payload={'name':'projects/family-portfolio-gateway/locations/asia-east2/operations/synthetic','done':True,
                             'metadata':{'name':JOB+'/executions/ib-daily-snapshot-synthetic'}}
                else:payload={'name':JOB,'etag':'etag','template':{'taskCount':1,'parallelism':1,'template':{
                    'serviceAccount':CONFIG['source_service_account'],'timeout':'75s','maxRetries':0,
                    'containers':[{'image':'wrong' if drift else CONFIG['source_image'],'command':['node','cloud/xuan-preopen/ib_sync_snapshot.mjs']}]}}}
                return SimpleNamespace(status_code=200,content=json.dumps(payload).encode())
        return CloudSource(CONFIG,session=Session(),storage=storage,now=lambda:NOW,sleeper=lambda _:None),requests,rid

    def test_real_wiring_fake_transport_pins_object_and_excludes_base(self):
        source,requests,rid=self.setup_source()
        result=source.capture('2026-10-21','1215',rid)
        self.assertEqual(result['cash'],[{'currency':'USD','balance':'50.25'}, {'currency':'CAD','balance':'2'}])
        self.assertEqual(sum(m=='POST' for m,_,_ in requests),1)
        self.assertFalse(any(':access' in u for _,u,_ in requests))
        req=json.loads(requests[-1][2]['json']['overrides']['containerOverrides'][0]['args'][1])
        self.assertEqual(req['expiresAt'],'2026-10-22T04:25:00.000Z')

    def test_offline_end_to_end_control_transport_destination_compare_and_fallback_skip(self):
        source,requests,rid=self.setup_source()
        def factory(target,slot,request):
            return lambda:(source.capture(target,slot,request),destination(DestinationTests().client(),CONFIG,lambda:NOW))
        store=MemoryStateStore(initial())
        self.assertEqual(DailyIB(store,factory,now=lambda:NOW).run()['status'],'COMPLETE')
        later=NOW.replace(minute=30)
        self.assertTrue(DailyIB(store,factory,now=lambda:later).run()['source_reads_skipped'])
        self.assertEqual(sum(m=='POST' for m,_,_ in requests),1)

    def test_job_drift_prevents_dispatch(self):
        source,requests,rid=self.setup_source(drift=True)
        with self.assertRaisesRegex(IBSnapshotError,'IB_DAILY_SOURCE_JOB_DRIFT'):source.capture('2026-10-21','1215',rid)
        self.assertFalse(any(m=='POST' for m,_,_ in requests))

    def test_unknown_post_is_not_repeated(self):
        source,requests,rid=self.setup_source(post_failure=True)
        with self.assertRaises(SourceOutcomeUnknown):source.capture('2026-10-21','1215',rid)
        with self.assertRaisesRegex(IBSnapshotError,'IB_DAILY_SOURCE_ALREADY_DISPATCHED'):source.capture('2026-10-21','1215',rid)
        self.assertEqual(sum(m=='POST' for m,_,_ in requests),1)

    def test_corrupt_pinned_bytes_never_become_success(self):
        source,_,rid=self.setup_source(corrupt=True)
        with self.assertRaises(SourceOutcomeUnknown):source.capture('2026-10-21','1215',rid)

    def test_terminal_failure_is_distinct_from_unknown_dispatch(self):
        source,_,rid=self.setup_source(terminal_failure=True)
        with self.assertRaisesRegex(IBSnapshotError,'IB_DAILY_SOURCE_TERMINAL_FAILURE'):source.capture('2026-10-21','1215',rid)


if __name__ == '__main__':
    with patch.object(socket, 'socket', side_effect=AssertionError('network forbidden in offline tests')), \
         patch.object(socket, 'getaddrinfo', side_effect=AssertionError('DNS forbidden in offline tests')):
        unittest.main()
