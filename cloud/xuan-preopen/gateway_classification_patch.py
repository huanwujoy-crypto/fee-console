"""Patch only the known performance function in the pinned gateway image.

Unrelated cash-sync/OAuth code is preserved byte-for-byte. The function hash
must match the source archive currently linked by Cloud Run, otherwise stop.
"""
from __future__ import annotations

import ast
import hashlib
from pathlib import Path

FUNCTION_SHA256 = "9ad579b445a36c16806c5c560694623505988579daedeed7b520bd7f2e811fc5"
TARGET = Path("/app/family_portfolio_gateway/app.py")


def patch_source(source: str) -> str:
    tree = ast.parse(source)
    matches = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "get_performance"]
    if len(matches) != 1:
        raise ValueError("GATEWAY_FUNCTION_NOT_UNIQUE")
    node = matches[0]
    original = ast.get_source_segment(source, node)
    if hashlib.sha256(original.encode()).hexdigest() != FUNCTION_SHA256:
        raise ValueError("GATEWAY_CURRENT_FUNCTION_CHANGED")
    changed = original.replace("sector_classification|ungrouped)$", "sector_classification|ungrouped|83569)$")
    before = '''    if grouping == "83569" and (
        portfolio not in {"IB-HK", "936247"}
        or start_date is None or end_date != start_date or include_sales
    ):
        raise HTTPException(status_code=422, detail="Classification read is limited to one IB-HK data day")
'''
    changed = changed.replace("    result = client.performance(\n", before + "    result = client.performance(\n", 1)
    after = '''    if grouping == "83569":
        report = result.get("data", {}).get("report", {})
        if (
            result.get("portfolio", {}).get("id") != 936247
            or report.get("portfolio_id") != 936247
            or report.get("currency", {}).get("code") != "USD"
            or report.get("grouping") != "custom_group_category"
            or report.get("custom_group", {}).get("id") != 83569
            or report.get("custom_group", {}).get("name") != "资产类别"
            or report.get("end_date") != end_date
        ):
            raise HTTPException(status_code=502, detail="Classification source did not match the requested scope")
'''
    changed = changed.replace("    return {\n", after + "    return {\n", 1)
    if changed == original:
        raise ValueError("GATEWAY_PATCH_NOT_APPLIED")
    lines = source.splitlines(keepends=True)
    patched = "".join(lines[:node.lineno - 1]) + changed + "\n" + "".join(lines[node.end_lineno:])
    ast.parse(patched)
    # Detect accidental changes to any other function, route, import or setting.
    before_tree, after_tree = ast.parse(source), ast.parse(patched)
    for current in (before_tree, after_tree):
        current.body = [n for n in current.body if not (isinstance(n, ast.FunctionDef) and n.name == "get_performance")]
    if ast.dump(before_tree) != ast.dump(after_tree):
        raise ValueError("GATEWAY_UNRELATED_CODE_CHANGED")
    return patched


if __name__ == "__main__":
    original = TARGET.read_text(encoding="utf-8")
    TARGET.write_text(patch_source(original), encoding="utf-8")
    print("classification_get_only_patch_applied")
