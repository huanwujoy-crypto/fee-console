"""Invented declarations only. No source files, real identities, or xattrs."""
import copy
import datetime as dt
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from adapter.inception_boundary import validate_inception, SCHEMA, MAX_ITEMS


def fixture():
    archive, browser = 'libfile_' + 'a' * 32, 'libfile_' + 'b' * 32
    identities = [dict(account='SYNTHETIC-INCEPTION-ONLY', market=market, securityCode=code)
                  for market, code in [('CASH', 'FAKE-CASH'), ('FAKE-MARKET', 'FAKE-OLD'), ('FAKE-MARKET', 'FAKE-BUY')]]
    members = []
    for i, identity in enumerate(identities):
        members.append(dict(identity, startDate=['2010-01-01', '2011-02-03', '2026-11-12'][i],
                            dateKind=['cash-opening-balance', 'holding-inception', 'browser-first-recorded-buy'][i],
                            sourceFileId=browser if i == 2 else archive, sourceLocator='invented-row-' + str(i)))
    members[2]['browserEvidence'] = dict(view='All trades & adjustments', complete=True, currentQuantity=7,
                                       records=[dict(type='Buy', status='Confirmed', date='2026-11-12', quantity=7)])
    evidence = dict(schema=SCHEMA, capturedAt='2026-11-11T17:00:00.000Z', includeClosed=True,
                    sources=[dict(libraryFileId=x, version=0, sha256='c'*64, locator='synthetic-declaration') for x in [archive, browser]],
                    sourceCaptures=[dict(libraryFileId=archive, capturedAt='2012-01-01T00:00:00.000Z', sourceKind='verified-historical-archive'),
                                    dict(libraryFileId=browser, capturedAt='2026-11-11T17:00:00.000Z', sourceKind='browser-first-recorded-buy')], members=members)
    return evidence, dict(accounts=['SYNTHETIC-INCEPTION-ONLY'], as_of='2026-11-12',
                          classification_positions=[dict(identities[2], quantity=7, extraExistingField='allowed')],
                          required_members=identities, now=dt.datetime(2026, 11, 12, tzinfo=dt.timezone.utc))


class InceptionTests(unittest.TestCase):
    def setUp(self):
        self.e, self.kw = fixture()

    def run_boundary(self):
        return validate_inception(self.e, **self.kw)

    def refused(self):
        with self.assertRaisesRegex(ValueError, '^INCEPTION_'):
            self.run_boundary()

    def test_valid_mixed_archive_browser_and_hk_day(self):
        result = self.run_boundary()
        self.assertEqual(result['memberCount'], 3)
        self.assertEqual(result['browserMemberCount'], 1)

    def test_historical_capture_preserved_no_freshness_invention(self):
        result = self.run_boundary()
        self.assertEqual(result['sourceCaptureTimes'][0], '2012-01-01T00:00:00.000Z')
        self.assertEqual(result['capturedAt'], self.e['capturedAt'])

    def test_no_authentication_claim_or_identifiers(self):
        result = self.run_boundary()
        for key in ['sourceOriginVerified', 'actualIdentityAndBytesChecked', 'publicationReady']:
            self.assertIs(result[key], False)
        text = json.dumps(result)
        for value in ['SYNTHETIC-INCEPTION-ONLY', 'FAKE-OLD', 'libfile_', 'synthetic-declaration']:
            self.assertNotIn(value, text)

    def test_no_io_or_mutation(self):
        before = copy.deepcopy((self.e, self.kw))
        with patch('builtins.open', side_effect=AssertionError('IO forbidden')), patch('socket.socket', side_effect=AssertionError('network forbidden')):
            self.run_boundary()
        self.assertEqual(before, (self.e, self.kw))

    def test_canonical_string_clock(self):
        self.kw['now'] = '2026-11-12T00:00:00.000Z'
        self.run_boundary()

    def test_naive_clock_refused(self):
        self.kw['now'] = dt.datetime(2026, 11, 12)
        self.refused()

    def test_browser_current_quantity_mismatch(self):
        self.kw['classification_positions'][0]['quantity'] = 8
        self.refused()

    def test_browser_missing_current_row(self):
        self.kw['classification_positions'] = []
        self.refused()

    def test_duplicate_classification_row(self):
        self.kw['classification_positions'] *= 2
        self.refused()

    def test_duplicate_member(self):
        self.e['members'].append(copy.deepcopy(self.e['members'][0]))
        self.refused()

    def test_missing_required_member(self):
        self.e['members'].pop(0)
        self.refused()

    def test_extra_member_refused(self):
        self.kw['required_members'].pop(0)
        self.refused()

    def test_duplicate_required_member(self):
        self.kw['required_members'].append(copy.deepcopy(self.kw['required_members'][0]))
        self.refused()

    def test_unknown_date_refused(self):
        self.e['members'][0].update(dateKind='unknown', startDate=None)
        self.refused()

    def test_unknown_account(self):
        self.e['members'][0]['account'] = 'OTHER-FAKE'
        self.refused()

    def test_unsupported_and_mismatched_source_kind(self):
        for kind in ['unverified', 'browser-first-recorded-buy', [], None]:
            with self.subTest(kind=kind):
                self.e, self.kw = fixture()
                self.e['sourceCaptures'][0]['sourceKind'] = kind
                self.refused()

    def test_duplicate_and_conflicting_source_refs(self):
        for version in [0, 1]:
            with self.subTest(version=version):
                self.e, self.kw = fixture()
                ref = dict(self.e['sources'][0], version=version)
                self.e['sources'].append(ref)
                self.refused()

    def test_unused_source(self):
        extra = 'libfile_' + 'd'*32
        self.e['sources'].append(dict(self.e['sources'][0], libraryFileId=extra))
        self.e['sourceCaptures'].append(dict(self.e['sourceCaptures'][0], libraryFileId=extra))
        self.refused()

    def test_missing_and_duplicate_capture(self):
        for captures in [[], [self.e['sourceCaptures'][0]]*2]:
            self.e['sourceCaptures'] = captures
            self.refused()

    def test_root_capture_mismatch(self):
        self.e['capturedAt'] = '2026-11-11T18:00:00.000Z'
        self.refused()

    def test_future_capture(self):
        self.kw['now'] = '2026-11-11T16:59:59.999Z'
        self.refused()

    def test_browser_start_after_capture_hk_day(self):
        self.e['sourceCaptures'][1]['capturedAt'] = self.e['capturedAt'] = '2026-11-11T15:59:59.999Z'
        self.refused()

    def test_start_after_as_of(self):
        self.kw['as_of'] = '2026-11-11'
        self.refused()

    def test_invalid_dates_and_timestamp(self):
        for value in ['2026-02-30', '2026-1-01', True, 'unknown', '２０２６-01-01']:
            with self.subTest(value=value):
                self.e, self.kw = fixture()
                self.e['members'][0]['startDate'] = value
                self.refused()
        for value in ['2026-11-11T17:00:00Z', '2026-11-11T17:00:00.000+00:00', '2026-02-30T17:00:00.000Z']:
            self.e, self.kw = fixture()
            self.e['capturedAt'] = value
            self.refused()

    def test_boolean_and_nonfinite_quantities(self):
        for value in [True, False, float('nan'), float('inf'), 0, -1, '7', 10**1000]:
            with self.subTest(value=str(value)[:20]):
                self.e, self.kw = fixture()
                self.e['members'][2]['browserEvidence']['currentQuantity'] = value
                self.refused()

    def test_record_requires_sole_confirmed_positive_buy(self):
        for field, value in [('type', 'Sell'), ('status', 'Pending'), ('date', '2026-11-11'), ('quantity', 8), ('quantity', True)]:
            self.e, self.kw = fixture()
            self.e['members'][2]['browserEvidence']['records'][0][field] = value
            self.refused()
        for count in [0, 2]:
            self.e, self.kw = fixture()
            self.e['members'][2]['browserEvidence']['records'] *= count
            self.refused()

    def test_complete_and_exact_view(self):
        for field, value in [('complete', 1), ('complete', False), ('view', 'All trades')]:
            self.e, self.kw = fixture()
            self.e['members'][2]['browserEvidence'][field] = value
            self.refused()

    def test_cash_historical_date_kinds(self):
        self.e['members'][0]['dateKind'] = 'cash-first-transaction'
        self.run_boundary()
        self.e['members'][0]['dateKind'] = 'holding-inception'
        self.refused()

    def test_exact_schema_and_no_override(self):
        self.e['verifySource'] = True
        self.refused()
        self.e, self.kw = fixture()
        self.e['schema'] = 'fee-console.ratio-inception-source.v1'
        self.refused()
        with self.assertRaises(TypeError):
            validate_inception(self.e, **self.kw, verifier=lambda _: True)

    def test_source_primitives_and_controls(self):
        for field, value in [('version', True), ('version', -1), ('version', 2**53), ('sha256', 'x'*64), ('libraryFileId', []), ('locator', 'bad\ntext')]:
            self.e, self.kw = fixture()
            self.e['sources'][0][field] = value
            self.refused()
        self.e, self.kw = fixture()
        self.e['members'][0]['sourceLocator'] = 'bad\x7ftext'
        self.refused()

    def test_bounded_arrays(self):
        self.kw['classification_positions'] = [{}] * (MAX_ITEMS + 1)
        self.refused()

    def test_include_closed_requires_true_boolean(self):
        self.e['includeClosed'] = 1
        self.refused()


if __name__ == '__main__':
    unittest.main()
