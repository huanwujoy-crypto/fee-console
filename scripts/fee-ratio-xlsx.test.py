"""Every workbook and financial row below is entirely fictitious."""
import base64
import copy
import datetime as dt
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import unittest
import warnings
import zipfile
from decimal import Decimal
from xml.sax.saxutils import escape

SCRIPT = Path(__file__).with_name("fee-ratio-xlsx.py")
SPEC = importlib.util.spec_from_file_location("ratio_xlsx_synthetic_test", SCRIPT)
CORE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CORE)
NOW = "2026-11-10T12:00:00.000Z"
VIEW = "Fictional Consolidated View"
ACCOUNTS = ["Fictional Account " + str(i) for i in range(10)]
HEADERS = {field: field for fields in CORE.FIELDS.values() for field in fields}


def fixture(kind="classification", *, as_of="2026-11-10", period="all"):
    if kind == "classification":
        rows = [dict(account=ACCOUNTS[0], securityCode="ZZ_SYN_A", market="TEST", name="Fictional ordinary",
                     sharesightCategory="美国底仓", quantity=Decimal("12.5"), valueUSD=Decimal("100.25")),
                dict(account=ACCOUNTS[0], securityCode=None, market=None, name="Fictional cash",
                     sharesightCategory="Cash Accounts", quantity=None, valueUSD=Decimal("5"))]
    elif kind == "exposure":
        rows = [dict(account=ACCOUNTS[0], securityCode="ZZ_SYN_A", market="TEST", name="Fictional direct", withinETF=None,
                     ownership="Direct", valueUSD=Decimal("10"), sourcePercentage=Decimal("5")),
                dict(account=ACCOUNTS[0], securityCode="ZZ_SYN_U", market="TEST", name="Fictional underlying", withinETF="ZZ_SYN_L.TEST",
                     ownership="Underlying", valueUSD=Decimal("60"), sourcePercentage=Decimal("30")),
                dict(account=ACCOUNTS[0], securityCode="ZZ_SYN_L", market="TEST", name="Fictional levered", withinETF=None,
                     ownership="Residual", valueUSD=Decimal("-30"), sourcePercentage=Decimal("-15")),
                dict(account=ACCOUNTS[0], securityCode=None, market=None, name="Fictional cash", withinETF=None,
                     ownership="Cash", valueUSD=Decimal("5"), sourcePercentage=Decimal("2.5"))]
    else:
        rows = [dict(scopeType="portfolio", scopeName=VIEW, scopeParent=None, returnPct=Decimal("8.25"),
                     unit="p.a.", returnAmountUSD=Decimal("123.45")),
                dict(scopeType="classification", scopeName="Fictional category", scopeParent=None,
                     returnPct=Decimal("-2.1"), unit="period", returnAmountUSD=Decimal("-2"))]
    metadata = {"asOf": as_of, "currency": "USD", "view": VIEW}
    if kind == "performance":
        metadata.update(period=period, startDate="2025-11-10" if period == "oneYear" else "2022-05-01",
                        endDate=as_of, includeClosed=True, cashPerformance="unknown")
    cells, mappings, labels = {}, {}, {}
    for i, (field, value) in enumerate(metadata.items(), 1):
        labels["A" + str(i)] = field
        cells["A" + str(i)], cells["B" + str(i)] = field, value
        mappings[field] = {"cell": "B" + str(i), "encoding": "iso-date" if field in ("asOf", "startDate", "endDate") else "boolean" if field == "includeClosed" else "text"}
    columns = {field: {"column": chr(65 + i), "header": HEADERS[field]} for i, field in enumerate(CORE.FIELDS[kind])}
    profile = dict(schema="fee-console.ratio-xlsx-layout.v1", kind=kind, sheet="Synthetic Report", headerRow=10,
                   firstRow=11, lastRow=10 + len(rows), columns=columns, metadata=mappings, labels=labels,
                   expectedView=VIEW, expectedAccounts=ACCOUNTS,
                   percentRepresentation=None if kind == "classification" else "percentage-points")
    return profile, cells, rows


def workbook(profile, metadata_cells, rows, *, shared=False, epoch1904=False, extra_sheet=False):
    cells = dict(metadata_cells)
    for field, column in profile["columns"].items():
        cells[column["column"] + str(profile["headerRow"])] = column["header"]
    for index, row in enumerate(rows, profile["firstRow"]):
        for field, value in row.items():
            if field in profile["columns"]:
                cells[profile["columns"][field]["column"] + str(index)] = value
    strings, body = [], []
    for row_id in sorted({int("".join(c for c in ref if c.isdigit())) for ref in cells}):
        rendered = []
        for ref, value in sorted(cells.items()):
            if int("".join(c for c in ref if c.isdigit())) != row_id or value is None:
                continue
            if isinstance(value, dict):
                formula = '<f>' + escape(value["formula"]) + '</f>'
                cached = '' if value.get("cache") is None else '<v>' + escape(str(value["cache"])) + '</v>'
                rendered.append(f'<c r="{ref}">' + formula + cached + '</c>')
            elif isinstance(value, bool):
                rendered.append(f'<c r="{ref}" t="b"><v>{int(value)}</v></c>')
            elif isinstance(value, (Decimal, int)):
                rendered.append(f'<c r="{ref}"><v>{value}</v></c>')
            elif shared:
                if value not in strings:
                    strings.append(value)
                rendered.append(f'<c r="{ref}" t="s"><v>{strings.index(value)}</v></c>')
            else:
                rendered.append(f'<c r="{ref}" t="inlineStr"><is><t>{escape(value)}</t></is></c>')
        body.append(f'<row r="{row_id}">' + "".join(rendered) + '</row>')
    ns = CORE.NS[1:-1]
    rel = CORE.DOC_REL[1:-1]
    package_rel = CORE.REL[1:-1]
    types = "http://schemas.openxmlformats.org/package/2006/content-types"
    files = {
        "[Content_Types].xml": f'<Types xmlns="{types}"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>',
        "_rels/.rels": f'<Relationships xmlns="{package_rel}"><Relationship Id="rId1" Type="{rel}/officeDocument" Target="xl/workbook.xml"/></Relationships>',
        "xl/workbook.xml": f'<workbook xmlns="{ns}" xmlns:r="{rel}"><workbookPr date1904="{int(epoch1904)}"/><sheets><sheet name="Synthetic Report" sheetId="1" r:id="rId1"/>' + (f'<sheet name="Synthetic Extra" sheetId="2" r:id="rId2"/>' if extra_sheet else '') + '</sheets></workbook>',
        "xl/_rels/workbook.xml.rels": f'<Relationships xmlns="{package_rel}"><Relationship Id="rId1" Type="{rel}/worksheet" Target="worksheets/sheet1.xml"/>' + (f'<Relationship Id="rId2" Type="{rel}/worksheet" Target="worksheets/sheet2.xml"/>' if extra_sheet else '') + '</Relationships>',
        "xl/worksheets/sheet1.xml": f'<worksheet xmlns="{ns}"><sheetData>' + "".join(body) + '</sheetData></worksheet>',
    }
    if shared:
        files["xl/sharedStrings.xml"] = f'<sst xmlns="{ns}">' + "".join('<si><t>' + escape(s) + '</t></si>' for s in strings) + '</sst>'
    if extra_sheet:
        files["xl/worksheets/sheet2.xml"] = f'<worksheet xmlns="{ns}"><sheetData/></worksheet>'
    return archive(files)


def archive(files):
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as target:
        for name, content in files.items():
            target.writestr(name, content)
    return out.getvalue()


def rewrite(data, name, change):
    with zipfile.ZipFile(io.BytesIO(data)) as source:
        files = {name: source.read(name) for name in source.namelist()}
    files[name] = change(files.get(name, b""))
    return archive(files)


def diversity_fixture(rows=None, cached=False, partition_indices=None, table_target=None):
    """Four fictional tables: canonical header 4, partitions header 5, date A2."""
    if rows is None:
        rows = [dict(market="SYN", code="ZZ_DIV_" + str(i), name="Fictional item " + str(i),
                     percentageRaw=Decimal("0.125") * i, valueRaw=Decimal("10.125") * i,
                     category="Fictional category " + str(i)) for i in range(1, 4)]
    assert len(rows) == 3
    if partition_indices is None:
        partition_indices = [[0], [1], [2]]
    assert len(partition_indices) == 3
    columns = {field: {"column": chr(65 + i), "header": header} for i, (field, header) in enumerate(CORE.DIVERSITY_FIELDS.items())}
    profile = dict(schema="fee-console.ratio-diversity-layout.v1", kind="diversity", canonicalSheet="Synthetic canonical",
                   date={"cell": "A2", "encoding": "iso-date"}, columns=columns, sheets=[])
    files, titles = {}, ["Synthetic canonical", "Synthetic slice 1", "Synthetic slice 2", "Synthetic slice 3"]
    for i, name in enumerate(titles):
        subset, header = rows if i == 0 else [rows[index] for index in partition_indices[i - 1]], 4 if i == 0 else 5
        first, last = header + 1, header + len(subset)
        footer = str(last + 1)
        spec = dict(name=name, headerRow=header, firstRow=first, lastRow=last,
                    labels={"A1": "Entirely fictitious Diversity", "A" + footer: "Fictional total"},
                    totalCells={"D" + footer: "percentageRaw", "E" + footer: "valueRaw"})
        profile["sheets"].append(spec)
        cells = {"A2": "2026-11-10", **spec["labels"]}
        for ref in spec["totalCells"]:
            cells[ref] = {"formula": "SUM(" + ref[0] + str(first) + ":" + ref[0] + str(last) + ")", "cache": 999 if cached else None} if subset else Decimal(0)
        with zipfile.ZipFile(io.BytesIO(workbook({**spec, "columns": columns}, cells, subset))) as single:
            files["xl/worksheets/sheet" + str(i + 1) + ".xml"] = single.read("xl/worksheets/sheet1.xml")
    ns, rel, pkg = CORE.NS[1:-1], CORE.DOC_REL[1:-1], CORE.REL[1:-1]
    files["[Content_Types].xml"] = '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>'
    files["_rels/.rels"] = f'<Relationships xmlns="{pkg}"><Relationship Id="rId1" Type="{rel}/officeDocument" Target="xl/workbook.xml"/></Relationships>'
    files["xl/workbook.xml"] = f'<workbook xmlns="{ns}" xmlns:r="{rel}"><sheets>' + ''.join(
        f'<sheet name="{name}" sheetId="{i}" r:id="rId{i}"/>' for i, name in enumerate(titles, 1)) + '</sheets></workbook>'
    files["xl/_rels/workbook.xml.rels"] = f'<Relationships xmlns="{pkg}">' + ''.join(
        f'<Relationship Id="rId{i}" Type="{rel}/worksheet" Target="worksheets/sheet{i}.xml"/>' for i in range(1, 5)) + '</Relationships>'
    data = archive(files)
    if table_target is not None:
        data = table_relationship_fixture(data, table_target)
    return profile, data


def table_relationship_fixture(data, target, *, target_mode="Internal", rid="rIdTable"):
    """Synthetic auxiliary table relationship; no source files or external IO."""
    data = rewrite(data, "xl/tables/table1.xml", lambda _: f'<table xmlns="{CORE.NS[1:-1]}"/>'.encode())
    relation = (f'<Relationships xmlns="{CORE.REL[1:-1]}"><Relationship Id="{escape(rid)}" '
                f'Type="{CORE.DOC_REL[1:-1]}/table" TargetMode="{escape(target_mode)}" '
                f'Target="{escape(target)}"/></Relationships>')
    return rewrite(data, "xl/worksheets/_rels/sheet1.xml.rels", lambda _: relation.encode())


class XlsxTests(unittest.TestCase):
    def parse(self, kind="classification", edit=None, **options):
        profile, cells, rows = fixture(kind)
        if edit:
            edit(profile, cells, rows)
        data = workbook(profile, cells, rows, **options)
        return CORE.parse_workbook(data, profile, NOW)

    def refused(self, fn, code=None):
        with self.assertRaises(CORE.Refused) as context:
            fn()
        self.assertRegex(str(context.exception), r"^RATIO_XLSX_[A-Z_]+$")
        if code:
            self.assertEqual(context.exception.code, code)

    def test_three_kinds_decode_without_authentication_or_completeness_claims(self):
        for kind in CORE.FIELDS:
            with self.subTest(kind=kind):
                result = self.parse(kind)
                self.assertEqual(result["kind"], kind)
                self.assertFalse(result["publicationReady"])
                self.assertFalse(result["sourceVerified"])
                self.assertFalse(result["completenessVerified"])
                self.assertNotIn("capturedAt", result)
                self.assertEqual(result["metadata"]["asOf"], "2026-11-10")

    def test_classification_keeps_raw_category_quantity_cash_and_cents(self):
        result = self.parse()
        self.assertEqual(result["rows"][0]["sharesightCategory"], "美国底仓")
        self.assertEqual(result["rows"][0]["quantity"], 12.5)
        self.assertEqual(result["rows"][0]["valueUSD"], 100.25)
        self.assertIsNone(result["rows"][1]["quantity"])
        self.assertIsNone(result["rows"][1]["securityCode"])
        result = self.parse(edit=lambda p, c, r: r[0].update(sharesightCategory="Fictional unknown category", quantity=None))
        self.assertEqual(result["rows"][0]["sharesightCategory"], "Fictional unknown category")
        self.assertIsNone(result["rows"][0]["quantity"])

    def test_shared_strings_rich_text_unicode_and_xml_entities(self):
        p, c, rows = fixture()
        rows[0]["name"] = "Fictional & unicode 测试"
        data = workbook(p, c, rows, shared=True)
        data = rewrite(data, "xl/sharedStrings.xml", lambda xml: xml.replace(b'<t>Fictional &amp; unicode ', b'<t>Fictional &amp; unicode '))
        result = CORE.parse_workbook(data, p, NOW)
        self.assertEqual(result["rows"][0]["name"], rows[0]["name"])
        data = rewrite(data, "xl/sharedStrings.xml", lambda xml: xml.replace(b'<si><t>account</t></si>', b'<si><r><t>acc</t></r><r><t>ount</t></r></si>'))
        self.assertEqual(CORE.parse_workbook(data, p, NOW)["rowCount"], 2)

    def test_dates_use_hong_kong_and_never_refresh_original_dates(self):
        p, c, rows = fixture(as_of="2026-11-11")
        data = workbook(p, c, rows)
        result = CORE.parse_workbook(data, p, "2026-11-10T16:00:00.000Z")
        self.assertEqual(result["metadata"]["asOf"], "2026-11-11")
        self.refused(lambda: CORE.parse_workbook(data, p, NOW), "DATE")
        for date, accepted in [("2026-11-06", True), ("2026-11-05", False), ("2026-02-30", False), ("10/11/2026", False)]:
            p, c, rows = fixture(as_of=date)
            with self.subTest(date=date):
                if accepted:
                    self.assertEqual(CORE.parse_workbook(workbook(p, c, rows), p, NOW)["metadata"]["asOf"], date)
                else:
                    self.refused(lambda: CORE.parse_workbook(workbook(p, c, rows), p, NOW), "DATE")

    def test_excel_date_epochs_and_fictitious_leap_day(self):
        for epoch1904 in (False, True):
            p, c, rows = fixture()
            epoch = dt.date(1904, 1, 1) if epoch1904 else dt.date(1899, 12, 30)
            c["B1"] = Decimal((dt.date(2026, 11, 10) - epoch).days)
            p["metadata"]["asOf"]["encoding"] = "excel-date"
            self.assertEqual(CORE.parse_workbook(workbook(p, c, rows, epoch1904=epoch1904), p, NOW)["metadata"]["asOf"], "2026-11-10")
        for value in (Decimal(60), Decimal("40000.5")):
            self.refused(lambda: CORE.date_value(value, "excel-date", False), "DATE")
        self.assertEqual(CORE.date_value(Decimal(59), "excel-date", False), "1900-02-28")
        self.assertEqual(CORE.date_value(Decimal(61), "excel-date", False), "1900-03-01")

    def test_independent_classification_and_exposure_dates_stay_distinct(self):
        p, c, rows = fixture(as_of="2026-11-09")
        classification = CORE.parse_workbook(workbook(p, c, rows), p, NOW)
        exposure = self.parse("exposure")
        self.assertNotEqual(classification["metadata"]["asOf"], exposure["metadata"]["asOf"])

    def test_non_usd_wrong_scope_and_unknown_accounts_stop(self):
        for edit, code in [(lambda p, c, r: c.update(B2="EUR"), "CURRENCY"),
                           (lambda p, c, r: c.update(B3="Fictional other view"), "SCOPE"),
                           (lambda p, c, r: r[0].update(account="Fictional outside scope"), "SCOPE")]:
            with self.subTest(code=code):
                self.refused(lambda: self.parse(edit=edit), code)

    def test_currency_and_negative_values_are_never_guessed_or_rounded(self):
        for value in (Decimal("-0.01"), Decimal("1.001"), "$10.00", "1,000.00", True, Decimal("1e-9999")):
            with self.subTest(value=str(value)):
                self.refused(lambda: self.parse(edit=lambda p, c, r: r[0].update(valueUSD=value)), "VALUE")
        self.assertEqual(self.parse(edit=lambda p, c, r: r[0].update(valueUSD=Decimal("1e2")))["rows"][0]["valueUSD"], 100)

    def test_signed_residual_remains_signed_without_leverage_or_clamping(self):
        rows = self.parse("exposure")["rows"]
        self.assertEqual(rows[1]["valueUSD"], 60)
        self.assertEqual(rows[2]["valueUSD"], -30)
        self.assertEqual(rows[2]["sourcePercentage"], -15)
        self.assertEqual(rows[1]["valueUSD"] + rows[2]["valueUSD"], 30)
        self.assertEqual(self.parse("exposure", edit=lambda p, c, r: r[2].update(valueUSD=Decimal(5)))["rows"][2]["valueUSD"], 5)

    def test_exposure_parent_residual_associations_must_be_complete(self):
        edits = [lambda p, c, r: (r.pop(2), p.update(lastRow=12)),
                 lambda p, c, r: r[1].update(withinETF="ZZ_SYN_WRONG.TEST"),
                 lambda p, c, r: r[2].update(valueUSD=Decimal(-61)),
                 lambda p, c, r: r[0].update(securityCode="ZZ_SYN_L")]
        for edit in edits:
            with self.subTest(edit=edits.index(edit)):
                self.refused(lambda: self.parse("exposure", edit=edit))
        for index in (0, 1, 3):
            self.refused(lambda: self.parse("exposure", edit=lambda p, c, r: r[index].update(valueUSD=Decimal(-1))), "VALUE")

    def test_exposure_same_product_in_different_accounts_stays_separate(self):
        def edit(p, c, rows):
            other = copy.deepcopy(rows[1:3])
            for row in other:
                row["account"] = ACCOUNTS[1]
            rows.extend(other)
            p["lastRow"] += 2
        result = self.parse("exposure", edit=edit)
        self.assertEqual(result["rowCount"], 6)
        self.assertEqual(result["rows"][-1]["account"], ACCOUNTS[1])

    def test_percent_representation_is_explicit_and_native_return_not_recalculated(self):
        result = self.parse("performance")
        self.assertEqual([r["returnPct"] for r in result["rows"]], [8.25, -2.1])
        self.assertEqual([r["unit"] for r in result["rows"]], ["p.a.", "period"])
        self.assertEqual(result["metadata"]["cashPerformance"], "unknown")
        def fraction(p, c, rows):
            p["percentRepresentation"] = "excel-fraction"
            rows[0]["returnPct"], rows[1]["returnPct"] = Decimal("0.0825"), Decimal("-0.021")
        self.assertEqual([r["returnPct"] for r in self.parse("performance", edit=fraction)["rows"]], [8.25, -2.1])
        self.refused(lambda: self.parse("performance", edit=lambda p, c, r: p.update(percentRepresentation=None)), "PROFILE")

    def test_unknown_and_unavailable_units_are_not_zero_or_annualized(self):
        def edit(p, c, rows):
            rows[0].update(unit="unknown", returnPct=Decimal(0))
            rows[1].update(unit="unavailable", returnPct=None, returnAmountUSD=None)
        result = self.parse("performance", edit=edit)
        self.assertEqual(result["rows"][0]["returnPct"], 0)
        self.assertEqual(result["rows"][0]["unit"], "unknown")
        self.assertIsNone(result["rows"][1]["returnPct"])
        self.refused(lambda: self.parse("performance", edit=lambda p, c, r: r[0].update(unit="unavailable")), "PERFORMANCE")

    def test_performance_closed_positions_and_periods_are_explicit(self):
        for edit in [lambda p, c, r: c.update(B7=False), lambda p, c, r: c.update(B6="2026-11-09"),
                     lambda p, c, r: c.update(B5="2027-01-01"), lambda p, c, r: r[0].update(unit="annualize-me")]:
            self.refused(lambda: self.parse("performance", edit=edit), "PERFORMANCE")
        p, c, rows = fixture("performance", period="oneYear")
        self.assertEqual(CORE.parse_workbook(workbook(p, c, rows), p, NOW)["metadata"]["startDate"], "2025-11-10")
        c["B5"] = "2025-11-09"
        self.refused(lambda: CORE.parse_workbook(workbook(p, c, rows), p, NOW), "PERFORMANCE")
        p, c, rows = fixture("performance", as_of="2024-02-29", period="oneYear")
        c["B5"] = "2023-02-28"
        self.assertEqual(CORE.parse_workbook(workbook(p, c, rows), p, "2024-03-01T00:00:00.000Z")["metadata"]["startDate"], "2023-02-28")

    def test_exact_headers_duplicate_identity_and_extra_rows_refuse(self):
        p, c, rows = fixture()
        data = workbook(p, c, rows)
        wrong = copy.deepcopy(p); wrong["columns"]["name"]["header"] = "Fictional different header"
        self.refused(lambda: CORE.parse_workbook(data, wrong, NOW), "HEADER")
        wrong = copy.deepcopy(p); wrong["lastRow"] -= 1
        self.refused(lambda: CORE.parse_workbook(data, wrong, NOW), "ROWS")
        extra = dict(c); extra["Z11"] = "Fictional hidden currency"
        self.refused(lambda: CORE.parse_workbook(workbook(p, extra, rows), p, NOW), "ROWS")
        rows[1] = copy.deepcopy(rows[0])
        self.refused(lambda: CORE.parse_workbook(workbook(p, c, rows), p, NOW), "ROWS")

    def test_incomplete_mapping_and_missing_data_rows_fail(self):
        p, c, rows = fixture()
        data = workbook(p, c, rows)
        for edit in [lambda p: p["columns"].pop("quantity"), lambda p: p["columns"]["name"].update(column="A"),
                     lambda p: p.update(firstRow=0), lambda p: p.update(extra=True)]:
            q = copy.deepcopy(p); edit(q)
            self.refused(lambda: CORE.parse_workbook(data, q, NOW), "PROFILE")
        q = copy.deepcopy(p); q["lastRow"] += 1
        self.refused(lambda: CORE.parse_workbook(data, q, NOW), "ROWS")

    def test_extra_sheet_is_disclosed_without_claiming_duplicate_groupings(self):
        result = self.parse(extra_sheet=True)
        self.assertEqual(result["additionalWorksheetCount"], 1)
        self.assertFalse(result["completenessVerified"])
        self.assertNotIn("groupingSheetsAreDuplicates", result)

    def test_formulas_errors_duplicate_cells_merges_and_hidden_sheet_refuse(self):
        p, c, rows = fixture()
        data = workbook(p, c, rows)
        mutations = [
            ("xl/worksheets/sheet1.xml", lambda s: s.replace(b'<c r="G11"><v>', b'<c r="G11"><f>SUM(A1)</f><v>'), "UNSUPPORTED"),
            ("xl/worksheets/sheet1.xml", lambda s: s.replace(b'<c r="G11">', b'<c r="G11" t="e">'), "UNSUPPORTED"),
            ("xl/worksheets/sheet1.xml", lambda s: s.replace(b'</sheetData>', b'</sheetData><mergeCells><mergeCell ref="A11:B11"/></mergeCells>'), "UNSUPPORTED"),
            ("xl/workbook.xml", lambda s: s.replace(b'name="Synthetic Report"', b'name="Synthetic Report" state="hidden"'), "UNSUPPORTED"),
            ("xl/worksheets/sheet1.xml", lambda s: s.replace(b'<row r="11">', b'<row r="11"><c r="A11" t="inlineStr"><is><t>Duplicate</t></is></c>'), "ROWS"),
        ]
        for name, change, code in mutations:
            with self.subTest(code=code):
                self.refused(lambda: CORE.parse_workbook(rewrite(data, name, change), p, NOW), code)

    def test_external_targets_macros_and_dtd_never_execute(self):
        p, c, rows = fixture()
        data = workbook(p, c, rows)
        changes = [
            ("xl/_rels/workbook.xml.rels", lambda s: s.replace(b'Target="worksheets/sheet1.xml"', b'TargetMode="External" Target="https://example.invalid/private"'), "UNSUPPORTED"),
            ("[Content_Types].xml", lambda s: s.replace(b'spreadsheetml.sheet.main+xml', b'ms-excel.sheet.macroEnabled.main+xml'), "UNSUPPORTED"),
            ("xl/worksheets/sheet1.xml", lambda s: b'<!DOCTYPE worksheet [<!ENTITY a "never expand">]>' + s, "XML"),
            ("xl/worksheets/sheet1.xml", lambda s: ("<!DOCTYPE worksheet [<!ENTITY a 'never expand'>]>" + s.decode()).encode("utf-16"), "XML"),
        ]
        for name, change, code in changes:
            self.refused(lambda: CORE.parse_workbook(rewrite(data, name, change), p, NOW), code)
        self.refused(lambda: CORE.parse_workbook(rewrite(data, "xl/vbaProject.bin", lambda _: b"not executable"), p, NOW), "UNSUPPORTED")

    def test_opc_internal_parent_table_relationship_preserves_diversity_rows_and_formula_cache_rules(self):
        for cached in (False, True):
            p, data = diversity_fixture(cached=cached, table_target="../tables/table1.xml")
            book = CORE.Workbook(data, lambda: None)
            self.assertEqual(book.relationships["xl/worksheets/_rels/sheet1.xml.rels"]["rIdTable"][0], "xl/tables/table1.xml")
            result = CORE.parse_workbook(data, p, NOW)
            self.assertEqual(result["rowCount"], 3)
            self.assertEqual(sum(row["valueRaw"] for row in result["rows"]), 60.75)
            self.assertTrue(all(item["cachedValuePresent"] == cached for item in result["metadata"]["ignoredSummaryFormulas"]))
            for key in ("publicationReady", "sourceVerified", "completenessVerified"):
                self.assertFalse(result[key])

    def test_opc_dot_segments_and_single_root_relative_paths_resolve_inside_package(self):
        p, c, rows = fixture()
        original = workbook(p, c, rows)
        for target in ("./../tables/./table1.xml", "../tables/../tables/table1.xml", "/xl/tables/table1.xml"):
            data = table_relationship_fixture(original, target)
            self.assertEqual(CORE.parse_workbook(data, p, NOW)["rowCount"], 2)
        data = table_relationship_fixture(original, "../../root-part.xml")
        data = rewrite(data, "root-part.xml", lambda _: b'<synthetic/>')
        book = CORE.Workbook(data, lambda: None)
        self.assertEqual(book.relationships["xl/worksheets/_rels/sheet1.xml.rels"]["rIdTable"][0], "root-part.xml")

    def test_opc_package_and_workbook_relationships_resolve_from_their_own_source_locations(self):
        for kind in CORE.FIELDS:
            p, c, rows = fixture(kind)
            data = workbook(p, c, rows)
            data = rewrite(data, "_rels/.rels", lambda s: s.replace(b'Target="xl/workbook.xml"', b'Target="./xl/./workbook.xml"'))
            data = rewrite(data, "xl/_rels/workbook.xml.rels", lambda s: s.replace(b'Target="worksheets/sheet1.xml"', b'Target="worksheets/../worksheets/./sheet1.xml"'))
            self.assertEqual(CORE.parse_workbook(data, p, NOW)["kind"], kind)

    def test_opc_parent_segments_cannot_escape_root_even_if_the_path_later_reenters(self):
        p, c, rows = fixture()
        original = workbook(p, c, rows)
        for target in ("../../../xl/tables/table1.xml", "../tables/../../../xl/tables/table1.xml", "/../xl/tables/table1.xml"):
            self.refused(lambda: CORE.parse_workbook(table_relationship_fixture(original, target), p, NOW), "XML")
        data = rewrite(original, "_rels/.rels", lambda s: s.replace(b'Target="xl/workbook.xml"', b'Target="../xl/workbook.xml"'))
        self.refused(lambda: CORE.parse_workbook(data, p, NOW), "XML")

    def test_opc_urls_authorities_encoded_paths_and_non_path_characters_stay_refused(self):
        p, c, rows = fixture()
        original = workbook(p, c, rows)
        targets = ["https://example.invalid/table.xml", "//example.invalid/table.xml", "file:///xl/tables/table1.xml",
                   "C:/xl/tables/table1.xml", "..\\tables\\table1.xml", "%2e%2e/tables/table1.xml",
                   "../tables%2ftable1.xml", "../tables/table1.xml?x=1", "../tables/table1.xml#part",
                   "../tables/table 1.xml", "../tables/表.xml", "../tables//table1.xml", ""]
        for target in targets:
            with self.subTest(target=target):
                self.refused(lambda: CORE.parse_workbook(table_relationship_fixture(original, target), p, NOW), "XML")

    def test_opc_normalized_target_must_exist_and_name_a_part_rather_than_a_directory(self):
        p, c, rows = fixture()
        original = workbook(p, c, rows)
        for target in ("../tables/missing.xml", "../tables/", "../tables/.", "../tables/..", "/"):
            self.refused(lambda: CORE.parse_workbook(table_relationship_fixture(original, target), p, NOW), "XML")

    def test_opc_normalization_does_not_allow_external_mode_duplicate_ids_or_zip_entry_traversal(self):
        p, c, rows = fixture()
        original = workbook(p, c, rows)
        data = table_relationship_fixture(original, "../tables/table1.xml", target_mode="External")
        self.refused(lambda: CORE.parse_workbook(data, p, NOW), "UNSUPPORTED")
        data = table_relationship_fixture(original, "../tables/table1.xml")
        duplicate = rewrite(data, "xl/worksheets/_rels/sheet1.xml.rels", lambda s: s.replace(b'</Relationships>', s[s.index(b'<Relationship '):s.index(b'/>') + 2] + b'</Relationships>'))
        self.refused(lambda: CORE.parse_workbook(duplicate, p, NOW), "XML")
        no_id = table_relationship_fixture(original, "../tables/table1.xml", rid="")
        self.refused(lambda: CORE.parse_workbook(no_id, p, NOW), "XML")
        traversing = rewrite(data, "xl/worksheets/../tables/extra.xml", lambda _: b'<synthetic/>')
        self.refused(lambda: CORE.parse_workbook(traversing, p, NOW), "ZIP")

    def test_archive_limits_traversal_duplicates_and_corruption_refuse(self):
        p, c, rows = fixture()
        data = workbook(p, c, rows)
        self.refused(lambda: CORE.parse_workbook(b"not a workbook", p, NOW), "ZIP")
        self.refused(lambda: CORE.parse_workbook(bytes(CORE.MAX_ARCHIVE + 1), p, NOW), "INPUT")
        self.refused(lambda: CORE.parse_workbook(rewrite(data, "../escape.xml", lambda _: b"no"), p, NOW), "ZIP")
        self.refused(lambda: CORE.parse_workbook(rewrite(data, "padding.xml", lambda _: b"x" * (2 * 1024 * 1024)), p, NOW), "ZIP")
        out = io.BytesIO(data)
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            with zipfile.ZipFile(out, "a") as target:
                target.writestr("xl/workbook.xml", b"duplicate")
        self.refused(lambda: CORE.parse_workbook(out.getvalue(), p, NOW), "ZIP")
        self.refused(lambda: CORE.parse_workbook(archive({str(i) + ".xml": "x" for i in range(129)}), p, NOW), "ZIP")

    def test_timeout_prevents_prepared_output_and_errors_have_no_private_text(self):
        p, c, rows = fixture()
        clock = iter([0, 1])
        self.refused(lambda: CORE.parse_workbook(workbook(p, c, rows), p, NOW, budget_ms=1, monotonic=lambda: next(clock)), "TIMEOUT")
        self.refused(lambda: CORE.parse_workbook(b"Fictional private value must never be logged", p, NOW), "ZIP")

    def test_corrupt_member_crc_and_wrong_xml_namespaces_refuse(self):
        p, c, rows = fixture()
        data = workbook(p, c, rows)
        with zipfile.ZipFile(io.BytesIO(data)) as source:
            files = {name: source.read(name) for name in source.namelist()}
        out = io.BytesIO()
        with zipfile.ZipFile(out, "w", zipfile.ZIP_STORED) as target:
            for name, content in files.items():
                target.writestr(name, content)
        corrupt = out.getvalue().replace(b'Fictional ordinary', b'Fictional altered!', 1)
        self.refused(lambda: CORE.parse_workbook(corrupt, p, NOW), "ZIP")
        wrong = rewrite(data, "[Content_Types].xml", lambda value: value.replace(b'<Types xmlns=', b'<Other xmlns=').replace(b'</Types>', b'</Other>'))
        self.refused(lambda: CORE.parse_workbook(wrong, p, NOW), "XML")

    def test_cli_reads_only_pipes_and_pins_both_input_and_profile(self):
        p, c, rows = fixture("performance")
        data = workbook(p, c, rows)
        profile_json = json.dumps(p, ensure_ascii=False, separators=(",", ":"))
        request = dict(schema="fee-console.ratio-xlsx-request.v1", workbookBase64=base64.b64encode(data).decode(),
                       workbookSha256=hashlib.sha256(data).hexdigest(), profileJson=profile_json, now=NOW, budgetMs=10000)
        result = subprocess.run(["/usr/bin/python3", "-I", str(SCRIPT)], input=json.dumps(request).encode(), capture_output=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, b"")
        output = json.loads(result.stdout)
        self.assertEqual(output["workbookSha256"], request["workbookSha256"])
        self.assertEqual(output["profileSha256"], hashlib.sha256(profile_json.encode()).hexdigest())
        self.assertFalse(output["publicationReady"])
        request["workbookSha256"] = "0" * 64
        result = subprocess.run(["/usr/bin/python3", "-I", str(SCRIPT)], input=json.dumps(request).encode(), capture_output=True, timeout=5)
        self.assertEqual(result.returncode, 2)
        self.assertEqual(json.loads(result.stdout), {"error": "RATIO_XLSX_HASH"})
        self.assertEqual(result.stderr, b"")

    def test_cli_duplicate_keys_and_unexpected_errors_are_fixed_codes(self):
        for raw in (b'{"schema":1,"schema":2}', b'{"private":"Fictional private account"}', b'\xff'):
            result = subprocess.run(["/usr/bin/python3", "-I", str(SCRIPT)], input=raw, capture_output=True, timeout=5)
            self.assertEqual(result.returncode, 2)
            self.assertEqual(json.loads(result.stdout), {"error": "RATIO_XLSX_INPUT"})
            self.assertEqual(result.stderr, b"")

    def test_diversity_four_tables_output_canonical_rows_once_without_scope_or_currency_claims(self):
        p, data = diversity_fixture()
        result = CORE.parse_workbook(data, p, NOW)
        self.assertEqual(result["kind"], "diversity")
        self.assertEqual(result["rowCount"], 3)
        self.assertEqual(sum(row["valueRaw"] for row in result["rows"]), 60.75)
        self.assertEqual(result["metadata"]["sheetRowCounts"], {"Synthetic canonical": 3, "Synthetic slice 1": 1,
                                                               "Synthetic slice 2": 1, "Synthetic slice 3": 1})
        self.assertTrue(result["metadata"]["partitionRowsMatchCanonical"])
        for key in ("currency", "view"):
            self.assertIsNone(result["metadata"][key])
        self.assertFalse(result["metadata"]["accountScopeVerified"])
        for key in ("sourceVerified", "completenessVerified", "publicationReady"):
            self.assertFalse(result[key])
        for row in result["rows"]:
            self.assertEqual(row["sourceSheet"], "Synthetic canonical")
            for key in ("account", "quantity", "valueUSD"):
                self.assertNotIn(key, row)

    def test_diversity_uncached_totals_and_wrong_cached_totals_are_never_evaluated_or_used(self):
        previews = []
        for cached in (False, True):
            p, data = diversity_fixture(cached=cached)
            r = CORE.parse_workbook(data, p, NOW)
            self.assertEqual(len(r["metadata"]["ignoredSummaryFormulas"]), 8)
            self.assertTrue(all(v["cachedValuePresent"] == cached for v in r["metadata"]["ignoredSummaryFormulas"]))
            previews.append(r["rows"])
        self.assertEqual(previews[0], previews[1])
        self.assertNotIn(999, [row["valueRaw"] for row in previews[1]])

    def test_diversity_union_is_a_full_row_multiset_not_a_code_deduplication(self):
        same = dict(market="SYN", code="ZZ_DUP", name="Fictional repeated row", percentageRaw=Decimal("0.1"),
                    valueRaw=Decimal("10"), category="Fictional")
        p, data = diversity_fixture([copy.deepcopy(same), copy.deepcopy(same), {**same, "code": "ZZ_OTHER"}])
        self.assertEqual(CORE.parse_workbook(data, p, NOW)["rowCount"], 3)
        changed = rewrite(data, "xl/worksheets/sheet2.xml", lambda s: s.replace(b'<c r="E6"><v>10</v>', b'<c r="E6"><v>11</v>'))
        self.refused(lambda: CORE.parse_workbook(changed, p, NOW), "ROWS")

    def test_diversity_dates_and_per_sheet_headers_are_explicit_and_consistent(self):
        p, data = diversity_fixture()
        self.assertEqual([s["headerRow"] for s in p["sheets"]], [4, 5, 5, 5])
        for replacement in (b"2026-11-09", b"10/11/2026"):
            changed = rewrite(data, "xl/worksheets/sheet3.xml", lambda s: s.replace(b"2026-11-10", replacement))
            self.refused(lambda: CORE.parse_workbook(changed, p, NOW), "DATE")
        wrong = copy.deepcopy(p); wrong["sheets"][1]["headerRow"] = 4
        self.refused(lambda: CORE.parse_workbook(data, wrong, NOW), "HEADER")
        self.refused(lambda: CORE.parse_workbook(data, p, "2026-11-15T00:00:00.000Z"), "DATE")

    def test_diversity_raw_numbers_keep_unknown_units_and_blank_cash_like_identity(self):
        row = dict(market=None, code=None, name="Fictional cash-like label", percentageRaw=Decimal("0.125"),
                   valueRaw=Decimal("-1.234"), category=None)
        p, data = diversity_fixture([row, {**row, "name": "Fictional second"}, {**row, "name": "Fictional third"}])
        r = CORE.parse_workbook(data, p, NOW)
        self.assertEqual(r["rows"][0]["percentageRaw"], 0.125)
        self.assertEqual(r["rows"][0]["valueRaw"], -1.234)
        self.assertIsNone(r["rows"][0]["code"])
        self.assertEqual(r["metadata"]["percentageRepresentation"], "unverified-number")
        for value in ("1.234", True, "$1.00"):
            p, data = diversity_fixture([{**row, "valueRaw": value}, row, row])
            self.refused(lambda: CORE.parse_workbook(data, p, NOW), "VALUE")

    def test_diversity_formula_exception_is_only_for_declared_local_sum_footer_cells(self):
        p, data = diversity_fixture()
        for original, replacement in [(b'<c r="E5"><v>', b'<c r="E5"><f>SUM(E5:E7)</f><v>'),
                                      (b'SUM(E5:E7)', b'SUM(E5:E8)'),
                                      (b'SUM(E5:E7)', b'WEBSERVICE("https://example.invalid")')]:
            changed = rewrite(data, "xl/worksheets/sheet1.xml", lambda s: s.replace(original, replacement))
            self.refused(lambda: CORE.parse_workbook(changed, p, NOW), "UNSUPPORTED")
        wrong = copy.deepcopy(p); wrong["sheets"][0]["totalCells"] = {"E5": "valueRaw"}
        self.refused(lambda: CORE.parse_workbook(data, wrong, NOW), "PROFILE")
        wrong = copy.deepcopy(p); wrong["sheets"][0]["totalCells"] = {}
        self.refused(lambda: CORE.parse_workbook(data, wrong, NOW), "UNSUPPORTED")

    def test_diversity_requires_every_sheet_and_refuses_unconsumed_cells_or_hidden_tables(self):
        p, data = diversity_fixture()
        wrong = copy.deepcopy(p); wrong["sheets"].pop()
        self.refused(lambda: CORE.parse_workbook(data, wrong, NOW), "PROFILE")
        changed = rewrite(data, "xl/worksheets/sheet4.xml", lambda s: s.replace(b'<row r="6">', b'<row r="6"><c r="Z6"><v>1</v></c>'))
        self.refused(lambda: CORE.parse_workbook(changed, p, NOW), "ROWS")
        changed = rewrite(data, "xl/workbook.xml", lambda s: s.replace(b'name="Synthetic slice 3"', b'name="Synthetic slice 3" state="hidden"'))
        self.refused(lambda: CORE.parse_workbook(changed, p, NOW), "UNSUPPORTED")

    def test_diversity_layout_cannot_supply_account_currency_or_legacy_formula_waivers(self):
        p, data = diversity_fixture()
        for key, value in [("expectedAccounts", ACCOUNTS), ("currency", "USD"), ("sourceVerified", True)]:
            wrong = copy.deepcopy(p); wrong[key] = value
            self.refused(lambda: CORE.parse_workbook(data, wrong, NOW), "PROFILE")
        p, c, rows = fixture()
        p["totalCells"] = {"G11": "valueUSD"}
        self.refused(lambda: CORE.parse_workbook(workbook(p, c, rows), p, NOW), "PROFILE")

    def test_diversity_explicit_empty_partition_does_not_invent_a_zero_holding(self):
        p, data = diversity_fixture(partition_indices=[[], [0, 1], [2]])
        r = CORE.parse_workbook(data, p, NOW)
        self.assertEqual(r["rowCount"], 3)
        self.assertEqual(r["metadata"]["sheetRowCounts"]["Synthetic slice 1"], 0)
        self.assertFalse(any(row["name"] == "Fictional total" for row in r["rows"]))


if __name__ == "__main__":
    unittest.main()
