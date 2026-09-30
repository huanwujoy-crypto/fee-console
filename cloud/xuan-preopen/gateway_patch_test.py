"""Run against the downloaded current source archive, without broker secrets.

python gateway_patch_test.py ABSOLUTE_CURRENT_SOURCE_ARCHIVE
"""
import ast
import copy
import sys
import unittest
import zipfile
from typing import Any, Dict, Optional
from gateway_classification_patch import patch_source

ARCHIVE = sys.argv.pop() if len(sys.argv) == 2 else None


class HttpError(Exception):
    def __init__(self, status_code, detail):
        self.status_code, self.detail = status_code, detail


class Client:
    def __init__(self):
        self.calls = []
        self.result = {"portfolio": {"id": 936247}, "data": {"report": {
            "portfolio_id": 936247, "currency": {"code": "USD"}, "grouping": "custom_group_category",
            "custom_group": {"id": 83569, "name": "资产类别"}, "end_date": "2026-09-29"}}}

    def performance(self, portfolio, **kwargs):
        self.calls.append((portfolio, kwargs))
        return self.result


class Tests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not ARCHIVE:
            raise ValueError("CURRENT_SOURCE_ARCHIVE_REQUIRED")
        with zipfile.ZipFile(ARCHIVE) as archive:
            cls.original = archive.read("app.py").decode()
        cls.patched = patch_source(cls.original)
        function = next(n for n in ast.parse(cls.patched).body if isinstance(n, ast.FunctionDef) and n.name == "get_performance")
        function.decorator_list = []
        namespace = {"Any": Any, "Dict": Dict, "Optional": Optional, "HTTPException": HttpError,
            "Query": lambda **kwargs: kwargs, "Depends": lambda value: None,
            "get_client": lambda: None, "SharesightCloudClient": Client, "public_result": lambda value: value}
        exec(compile(ast.Module(body=[function], type_ignores=[]), "patched_function", "exec"), namespace)
        cls.read = staticmethod(namespace["get_performance"])

    def call(self, client, **overrides):
        args = {"portfolio": "IB-HK", "start_date": "2026-09-29", "end_date": "2026-09-29", "grouping": "83569", "include_sales": False, "client": client}
        args.update(overrides)
        return self.read(**args)

    def test_exact_classification_read(self):
        client = Client()
        self.assertEqual(self.call(client)["mode"], "read_only")
        self.assertEqual(len(client.calls), 1)

    def test_other_portfolio_or_multi_day_is_rejected_before_upstream(self):
        for changes in [{"portfolio": "NOAH-HK"}, {"portfolio": "Webull"}, {"start_date": None}, {"end_date": "2026-09-28"}, {"include_sales": True}]:
            client = Client()
            with self.assertRaises(HttpError) as caught:
                self.call(client, **changes)
            self.assertEqual(caught.exception.status_code, 422)
            self.assertEqual(client.calls, [])

    def test_wrong_portfolio_classification_currency_or_date_is_rejected(self):
        for field, value in [("portfolio_id", 936238), ("custom_group", {"id": 1, "name": "other"}), ("currency", {"code": "HKD"}), ("end_date", "2026-09-28")]:
            client = Client()
            client.result = copy.deepcopy(client.result)
            client.result["data"]["report"][field] = value
            with self.assertRaises(HttpError) as caught:
                self.call(client)
            self.assertEqual(caught.exception.status_code, 502)

    def test_all_previous_grouping_routes_keep_previous_behavior(self):
        for grouping in ["investment_type", "country", "currency", "custom_group", "industry_classification", "market", "portfolio", "sector_classification", "ungrouped"]:
            client = Client()
            client.result = {"portfolio": {"id": 936238}, "data": {"existing": True}}
            self.assertTrue(self.call(client, portfolio="NOAH-HK", grouping=grouping)["data"]["existing"])

    def test_patch_fails_if_current_function_has_changed(self):
        with self.assertRaisesRegex(ValueError, "CURRENT_FUNCTION_CHANGED"):
            patch_source(self.original.replace('default="investment_type"', 'default="country"', 1))

    def test_no_other_source_or_write_route_was_changed(self):
        self.assertIn("ungrouped|83569)$", self.patched)
        self.assertEqual(self.original.split("def get_performance(")[0], self.patched.split("def get_performance(")[0])
        self.assertEqual(self.original.split('"/v1/trades"')[1], self.patched.split('"/v1/trades"')[1])


if __name__ == "__main__":
    unittest.main()
