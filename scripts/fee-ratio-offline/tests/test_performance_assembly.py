"""Synthetic complete assembly and fixed pure-JS reference checks only."""
import copy
import datetime as dt
import hashlib
import inspect
import io
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch
import xml.etree.ElementTree as ET
import zipfile

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from adapter import offline_adapter as oa, performance_assembly as assembly, projection_contract
from adapter.combined_top5 import portfolios
from full_performance_fixture import full_batch, NOW


class Clock(dt.datetime):
    @classmethod
    def now(cls,tz=None):return cls.fromtimestamp(NOW.timestamp(),tz=tz or dt.timezone.utc)


class AssemblyTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix='synthetic-complete-')
        self.root=Path(self.tmp.name)
        self.request,self.identities,self.scope=full_batch(self.root,combined=True)
        def attrs(fd,name):return self.identities[os.fstat(fd).st_ino][0 if name=='user.library-file-id' else 1].encode()
        self.patches=[patch('adapter.bound_files.os.getxattr',side_effect=attrs),
                      patch('adapter.bound_files.os.setxattr',side_effect=AssertionError('never create identity')),
                      patch.object(oa,'ALL_TOGETHER_SCOPE_SHA256',self.scope),
                      patch('adapter.performance_assembly.dt.datetime',Clock),
                      patch('socket.socket',side_effect=AssertionError('no Python network'))]
        for p in self.patches:p.start()
    def tearDown(self):
        for p in reversed(self.patches):p.stop()
        self.tmp.cleanup()
    def invoke(self):return assembly.prepare_offline_performance(self.request,enabled=True)
    def edit_total(self,role,period,column,operation):
        spec=self.request['bindings'][role][period];path=Path(spec['path']);old=path.read_bytes();out=io.BytesIO()
        ns={'s':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
        with zipfile.ZipFile(io.BytesIO(old)) as source,zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED) as target:
            for name in source.namelist():
                blob=source.read(name)
                if name.startswith('xl/worksheets/'):
                    tree=ET.fromstring(blob);rows=tree.findall('s:sheetData/s:row',ns);row=rows[-1]
                    matches=[c for c in row.findall('s:c',ns) if c.attrib['r'].startswith(column) and c.attrib['r'][len(column):].isdigit()]
                    for cell in matches:operation(row,cell,ns)
                    blob=ET.tostring(tree)
                target.writestr(name,blob)
        path.write_bytes(out.getvalue());spec['sha256']=hashlib.sha256(out.getvalue()).hexdigest()
        capture=self.request['bindings'][role]['capture'];cp=Path(capture['path']);data=json.loads(cp.read_text())
        data['reports'][period]['sha256']=spec['sha256'];blob=json.dumps(data).encode();cp.write_bytes(blob);capture['sha256']=hashlib.sha256(blob).hexdigest()

    def test_default_disabled_has_no_file_or_process_action(self):
        with patch('adapter.performance_assembly._assemble',side_effect=AssertionError('disabled')):
            self.assertEqual(assembly.prepare_offline_performance(None)['state'],'DISABLED')

    def test_full_combined_original_validates_pinned_reference_only(self):
        result=self.invoke();raw=result['original'];perf=raw['performance']
        self.assertEqual(raw['schemaVersion'],'sharesight-private-performance-v1')
        self.assertEqual(len(perf['reports']),2);self.assertEqual(len(perf['topHoldings']['targets']),20)
        self.assertTrue(result['performanceAssembled']);self.assertTrue(result['referenceContractValidated'])
        for flag in ['sourceOriginVerified','fullPerformanceReady','publicationReady','productionEnabled','currentCloudCompatibilityValidated']:
            self.assertFalse(result[flag])
        self.assertTrue(result['originalLibraryIdentityPending'])
        self.assertEqual(perf['inceptionEvidence']['capturedAt'],'2026-01-02T00:00:00.000Z')
        json.dumps(result,allow_nan=False)

    def test_uncombined_full_original_uses_exact_native_subtotals(self):
        directory=self.root/'uncombined';directory.mkdir()
        self.request,self.identities,_=full_batch(directory,combined=False)
        result=self.invoke()
        self.assertTrue(result['performanceAssembled'])
        self.assertEqual(len(result['original']['performance']['topHoldings']['reports']),2)

    def test_combined_rate_not_added_and_members_complete(self):
        perf=self.invoke()['original']['performance']
        for report in perf['topHoldings']['reports']:
            combined=[r for r in report['rows'] if len(r['memberEvidence'])==2]
            self.assertTrue(combined)
            self.assertTrue(all(r['returnPct']==12 and r['unit']=='p.a.' for r in combined))
            expected=self.request['bindings']['top5'][report['period']]['libraryFileId']
            self.assertTrue(all(r.get('sourceFileId')==expected for r in combined))

    def test_portfolio_amount_is_same_native_source_not_rate_math(self):
        raw=self.invoke()['original']
        for report in raw['performance']['reports']:
            root=next(r for r in report['rows'] if r['scope']['type']=='portfolio')
            self.assertIn('returnAmountUSD',root)
            self.assertEqual(root['sourceFileId'],report['additionalSources'][0]['libraryFileId'])
            self.assertNotEqual(root['returnAmountUSD'],sum(p['valueUSD'] for p in raw['allocation']['classification']['positions'])*.12)
            self.assertEqual(len(report['additionalSources']),2)

    def test_stock_source_is_reserved_for_exact_stock_row(self):
        perf=self.invoke()['original']['performance']
        for report in perf['reports']:
            stock_id=report['additionalSources'][1]['libraryFileId']
            rows=[r for r in report['rows'] if r.get('sourceFileId')==stock_id]
            self.assertEqual(len(rows),1);self.assertEqual(rows[0]['scope']['name'],'股票市场')
            self.assertNotIn('returnAmountUSD',rows[0])
            self.assertFalse(any(r['scope']['name']=='股票市场' for r in report['unavailable']))

    def test_missing_native_amount_refuses(self):
        self.edit_total('strategy','all','N',lambda row,cell,ns:row.remove(cell))
        with self.assertRaisesRegex(ValueError,'AMOUNT_INCOMPLETE'):self.invoke()

    def test_native_amount_component_conflict_refuses(self):
        def change(row,cell,ns):
            value=cell.find('s:v',ns);value.text=str(int(value.text)+1)
        self.edit_total('strategy','all','N',change)
        with self.assertRaisesRegex(ValueError,'AMOUNT_COMPONENTS'):self.invoke()

    def test_native_amount_formula_expression_refuses(self):
        def formula(row,cell,ns):
            ET.SubElement(cell,'{'+ns['s']+'}f').text='SUM(N5:N30)'
        self.edit_total('strategy','all','N',formula)
        with self.assertRaises(ValueError):self.invoke()

    def test_caller_cannot_select_targets_or_enable_authentication(self):
        for field in ['targets','targetProjection','nodeExecutable','sourceOriginVerified','scopeSha256','now']:
            self.request[field]=True
            with self.assertRaisesRegex(ValueError,'PERFORMANCE_REQUEST'):self.invoke()
            del self.request[field]
        self.assertEqual(list(inspect.signature(assembly.prepare_offline_performance).parameters),['request','enabled'])

    def test_pinned_projection_absent_or_failed_closes(self):
        with patch('adapter.performance_assembly.project_targets',side_effect=ValueError('PINNED_PROJECTION_REFUSED')):
            with self.assertRaisesRegex(ValueError,'PINNED_PROJECTION_REFUSED'):self.invoke()

    def test_pinned_module_tamper_refuses_before_projection(self):
        probe=self.root/'projection-probe';probe.mkdir()
        shutil.copy2(projection_contract.BRIDGE,probe/'projection_bridge.mjs')
        shutil.copytree(projection_contract.BRIDGE.parent/'projection_reference',probe/'projection_reference')
        file=probe/'projection_reference/fee-ratio-official-source.mjs'
        file.write_bytes(file.read_bytes()+b'\n// synthetic tamper\n')
        with patch.object(projection_contract,'BRIDGE',probe/'projection_bridge.mjs'):
            with self.assertRaisesRegex(ValueError,'PINNED_PROJECTION_REFUSED'):self.invoke()

    def test_ambient_node_hooks_not_inherited(self):
        with patch.dict(os.environ,{'NODE_OPTIONS':'--require /not-allowed.js','LD_PRELOAD':'/not-allowed.so','PATH':'/not-allowed'}):
            self.assertTrue(self.invoke()['referenceContractValidated'])

    def test_public_scope_still_cannot_be_overridden(self):
        with patch.object(oa,'ALL_TOGETHER_SCOPE_SHA256','f'*64):
            with self.assertRaisesRegex(ValueError,'ACCOUNT_SCOPE'):self.invoke()

    def test_originals_and_request_unchanged(self):
        previous=copy.deepcopy(self.request)
        paths=[spec['path'] for group in self.request['bindings'].values() for spec in group.values()]
        paths += [self.request['inception']['document']['path'],*[s['path'] for s in self.request['inception']['sources']]]
        before={p:hashlib.sha256(Path(p).read_bytes()).hexdigest() for p in paths}
        self.invoke()
        self.assertEqual(previous,self.request)
        self.assertEqual(before,{p:hashlib.sha256(Path(p).read_bytes()).hexdigest() for p in paths})

    def test_account_entity_normalization_does_not_allow_duplicates(self):
        self.assertEqual(portfolios('Synthetic A &amp; B, Synthetic C',['Synthetic A & B','Synthetic C']),('Synthetic A & B','Synthetic C'))
        with self.assertRaises(ValueError):portfolios('Synthetic A &amp; B, Synthetic A & B',['Synthetic A & B'])


if __name__=='__main__':unittest.main()
