"""Fabricated-only tests of exact combined membership and pure projection."""
import copy
from decimal import Decimal as D
import unittest

from adapter.combined_top5 import bind_members, portfolios
from adapter.top5_projection import project_top_report


def row(account, quantity=1):
    return ['NYSE', 'XYZ', 'Example', account, 10, quantity, quantity * 10,
            2 * quantity, None, quantity, None, 3 * quantity, None,
            4 * quantity, '7.25% p.a.', '二级市场', 'USD']


def doc(rows, combined=False):
    records = [(i + 5, r) for i, r in enumerate(rows)]
    return dict(rows={'Combined': records, 'Group': copy.deepcopy(records)},
                totals={}, formats={'Combined': {}, 'Group': {}},
                numbers={'Combined': {}, 'Group': {}},
                combineByHolding=combined, startDate='2025-11-01',
                endDate='2026-11-01', sourceSha256='0' * 64)


def fixture():
    return doc([row('A'), row('B', 2)]), doc([row('A, B', 3)], True)


def change(doc, col, value):
    for records in doc['rows'].values():
        records[0][1][col] = value


def target():
    return dict(category='二级市场', name='Example', members=[
        dict(account=a, market='NYSE', securityCode='XYZ') for a in ('A', 'B')])


def report():
    return dict(period='oneYear', startDate='2025-11-01', endDate='2026-11-01', rows=[])


class CombinedTests(unittest.TestCase):
    def test_two_accounts_and_immutability(self):
        a, c = fixture(); before = copy.deepcopy((a, c))
        got = bind_members(a, c)
        self.assertEqual([5, 6], [n for n, _ in got['expandedRows']['Combined']])
        self.assertFalse(got['publicationReady'])
        self.assertEqual('primary-membership-only', got['expandedRowsBasis'])
        got['expandedRows']['Combined'][0][1][3] = 'changed'
        self.assertEqual(before, (a, c))

    def test_portfolios_exact_unambiguous(self):
        self.assertEqual(('A, Inc', 'B'), portfolios('A, Inc, B', ['A, Inc', 'B']))
        for value, accounts in [('A, B', ['A', 'B', 'A, B']), ('A, A', ['A']),
                                ('A,B', ['A', 'B']), ('A & B', ['A &amp; B', 'A & B'])]:
            with self.assertRaises(ValueError): portfolios(value, accounts)
        self.assertEqual(('A & B',), portfolios('A & B', ['A &amp; B']))

    def test_partial_instrument_omission(self):
        a, _ = fixture(); c = doc([row('A')], True)
        with self.assertRaisesRegex(ValueError, 'PARTIAL_INSTRUMENT'): bind_members(a, c)

    def test_duplicate_members(self):
        a, c = fixture(); c = doc([row('A, B', 3), row('A, B', 3)], True)
        with self.assertRaisesRegex(ValueError, 'DUPLICATE_MEMBER'): bind_members(a, c)

    def test_group_coverage_and_native_duplicates(self):
        a, c = fixture(); c['rows']['Group'] = []
        with self.assertRaisesRegex(ValueError, 'GROUP_COVERAGE'): bind_members(a, c)
        a, c = fixture(); c['rows']['Group'][0][1][14] = '8%'
        with self.assertRaisesRegex(ValueError, 'GROUP_COVERAGE'): bind_members(a, c)

    def test_amounts_price_and_labels(self):
        for col in (4, 5, 6, 7, 9, 11, 13, 16):
            a, c = fixture(); change(c, col, 'EUR' if col == 16 else 999)
            with self.subTest(col=col), self.assertRaises(ValueError): bind_members(a, c)

    def test_missing_patterns(self):
        for col in (5, 6, 7, 9, 11, 13):
            a, c = fixture()
            for rs in a['rows'].values():
                for _, r in rs: r[col] = None
            change(c, col, None)
            bind_members(a, c)
            a['rows']['Combined'][0][1][col] = 0
            with self.assertRaises(ValueError): bind_members(a, c)

    def test_original_xml_precision(self):
        a, c = fixture()
        for sheet in a['rows']:
            a['numbers'][sheet]['F5'] = D('1.000000000000000000000000000001')
        with self.assertRaisesRegex(ValueError, 'QUANTITY'): bind_members(a, c)
        for sheet in c['rows']:
            c['numbers'][sheet]['F5'] = D('3.000000000000000000000000000001')
        bind_members(a, c)

    def test_native_rate_not_sum_and_units(self):
        a, c = fixture()
        out, checks = project_top_report(a, report(), [target()], c, {'libraryFileId': 'fabricated'})
        self.assertEqual(7.25, out['rows'][0]['returnPct'])
        self.assertEqual('p.a.', out['rows'][0]['unit'])
        self.assertEqual({'type': 'unknown'}, out['rows'][0]['termEvidence'])
        self.assertEqual('Combined', out['rows'][0]['sourceSheet'])
        self.assertEqual(2, len(out['rows'][0]['memberEvidence']))
        self.assertFalse(out['publicationReady'])
        self.assertEqual('caller-supplied-untrusted', out['targetSelectionBasis'])

    def test_missing_current_member_and_duplicate_target(self):
        a, c = fixture(); t = target(); t['members'][1]['account'] = 'C'
        with self.assertRaisesRegex(ValueError, 'CURRENT_MEMBER_MISSING'):
            project_top_report(a, report(), [t])
        t = target(); t['members'].append(t['members'][0])
        with self.assertRaisesRegex(ValueError, 'DUPLICATE_TARGET_MEMBER'):
            project_top_report(a, report(), [t])

    def test_unavailable_subtotal_not_derived(self):
        a, c = fixture()
        out, _ = project_top_report(a, report(), [target()])
        self.assertEqual([], out['rows'])
        self.assertEqual('native-aggregate-not-provided', out['unavailable'][0]['reason'])
        out, _ = project_top_report(a, report(), [target()], copy.deepcopy(a), {'libraryFileId': 'fabricated'})
        self.assertEqual('native-aggregate-not-provided', out['unavailable'][0]['reason'])

    def test_uncombined_exact_same_source_and_native_subtotal(self):
        a, _ = fixture(); s = copy.deepcopy(a)
        subtotal = row('Total'); subtotal[14] = '9.5%'
        s['totals']['Group'] = (10, subtotal)
        out, _ = project_top_report(a, report(), [target()], s, {'libraryFileId': 'fabricated'})
        self.assertEqual(9.5, out['rows'][0]['returnPct'])
        self.assertEqual('unknown', out['rows'][0]['unit'])
        for sheet in s['rows']: s['numbers'][sheet]['J5'] = D('1.000000000000000000000000000001')
        with self.assertRaisesRegex(ValueError, 'SUPPLEMENT_MEMBERSHIP'):
            project_top_report(a, report(), [target()], s, {'libraryFileId': 'fabricated'})

    def test_comparison_override_absent(self):
        a, c = fixture()
        with self.assertRaises(TypeError): bind_members(a, c, comparison=object())
        with self.assertRaises(TypeError): project_top_report(a, report(), [], comparison=object())


if __name__ == '__main__':
    unittest.main()
