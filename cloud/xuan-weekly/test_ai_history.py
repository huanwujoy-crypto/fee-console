import unittest
from ai_history import select_comparison

class ComparisonTest(unittest.TestCase):
    def test_does_not_call_same_week_a_weekly_change(self):
        self.assertIsNone(select_comparison('2026-09-25',[{'cutoff':'2026-09-25'},{'cutoff':'2026-09-24'}]))
    def test_selects_closest_earlier_week(self):
        self.assertEqual(select_comparison('2026-09-25',[{'cutoff':'2026-09-11'},{'cutoff':'2026-09-18'},{'cutoff':'2026-09-25'}])['cutoff'],'2026-09-18')
    def test_missing_invalid_old(self):
        self.assertIsNone(select_comparison('2026-09-25',[None,{}, {'cutoff':'bad'},{'cutoff':'2026-08-01'}]))
