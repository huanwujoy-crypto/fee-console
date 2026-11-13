"""Bounded XLSX decoding for explicitly mapped, unauthenticated ratio previews.

There is no official Sharesight layout profile yet. Tests construct fictitious
workbooks. A caller's profile/pin proves neither origin nor complete scope.
No network, filesystem input, formula evaluation, credentials or publication.
"""
import base64
import datetime as dt
import hashlib
import io
import json
import posixpath
import re
import sys
import time
import zipfile
import xml.etree.ElementTree as ET
from collections import Counter
from decimal import Decimal, InvalidOperation

MAX_ARCHIVE = 5 * 1024 * 1024
MAX_XML = 16 * 1024 * 1024
MAX_EXPANDED = 32 * 1024 * 1024
MAX_CELLS = 250000
NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
REL = "{http://schemas.openxmlformats.org/package/2006/relationships}"
DOC_REL = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
FIELDS = {
    "classification": ["account", "securityCode", "market", "name", "sharesightCategory", "quantity", "valueUSD"],
    "exposure": ["account", "securityCode", "market", "name", "withinETF", "ownership", "valueUSD", "sourcePercentage"],
    "performance": ["scopeType", "scopeName", "scopeParent", "returnPct", "unit", "returnAmountUSD"],
}
CODES = frozenset("INPUT HASH PROFILE ZIP XML UNSUPPORTED DATE CURRENCY SCOPE HEADER ROWS VALUE RESIDUAL PERFORMANCE TIMEOUT".split())
DIVERSITY_FIELDS = {"market": "Market", "code": "Code", "name": "Name", "percentageRaw": "Percentage",
                    "valueRaw": "Value", "category": "资产类别"}


class SummaryFormula:
    """An explicitly mapped local SUM; never evaluated or replaced by its cache."""
    def __init__(self, cached):
        self.cached = cached


class Refused(Exception):
    def __init__(self, code):
        self.code = code if code in CODES else "INPUT"
        super().__init__("RATIO_XLSX_" + self.code)


def require(ok, code):
    if not ok:
        raise Refused(code)


def exact(value, keys, code):
    require(type(value) is dict and set(value) == set(keys), code)


def text(value, code="VALUE"):
    require(isinstance(value, str) and 0 < len(value) <= 2000 and value == value.strip()
            and not re.search(r"[\x00-\x1f\x7f]", value), code)
    return value


def strict_json(value):
    def pairs(items):
        out = {}
        for key, item in items:
            require(key not in out, "INPUT")
            out[key] = item
        return out
    try:
        return json.loads(value, object_pairs_hook=pairs,
                          parse_constant=lambda _: (_ for _ in ()).throw(Refused("INPUT")))
    except (ValueError, UnicodeError, RecursionError):
        raise Refused("INPUT") from None


def decimal(value, money=False, signed=False):
    require(isinstance(value, Decimal) and value.is_finite(), "VALUE")
    require(abs(value) <= Decimal("1000000000000") and (signed or value >= 0), "VALUE")
    require(value.as_tuple().exponent >= -18, "VALUE")
    if money:
        require(value == value.quantize(Decimal("0.01")), "VALUE")
    return value


def numeric(value):
    require(isinstance(value, str) and len(value) <= 100
            and re.fullmatch(r"[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d{1,4})?", value), "VALUE")
    try:
        result = Decimal(value)
    except InvalidOperation:
        raise Refused("VALUE") from None
    require(result.is_finite(), "VALUE")
    return result


def date_value(value, encoding, epoch1904):
    try:
        if encoding == "iso-date":
            require(isinstance(value, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", value), "DATE")
            day = dt.date.fromisoformat(value)
        elif encoding == "excel-date":
            require(isinstance(value, Decimal) and value.is_finite() and value == value.to_integral()
                    and 0 <= value <= 2958465, "DATE")
            serial = int(value)
            require(epoch1904 or serial != 60, "DATE")  # Excel's fictitious 1900-02-29.
            epoch = dt.date(1904, 1, 1) if epoch1904 else dt.date(1899, 12, 31) if serial < 60 else dt.date(1899, 12, 30)
            day = epoch + dt.timedelta(days=serial)
        else:
            raise Refused("PROFILE")
        return day.isoformat()
    except (ValueError, OverflowError):
        raise Refused("DATE") from None


def json_numbers(value):
    if isinstance(value, Decimal):
        require(value.is_finite(), "VALUE")
        return int(value) if value == value.to_integral() else float(value)
    if isinstance(value, dict):
        return {key: json_numbers(item) for key, item in value.items()}
    if isinstance(value, list):
        return [json_numbers(item) for item in value]
    return value


def internal_relationship_target(base, target):
    # Resolve only the existing restricted internal path syntax. Reject a
    # root escape as it happens, even if later segments would re-enter the ZIP.
    require(isinstance(target, str) and re.fullmatch(r"[A-Za-z0-9_./-]+", target)
            and not target.startswith("//") and not target.endswith("/"), "XML")
    rooted = target.startswith("/")
    segments = (target[1:] if rooted else target).split("/")
    require(all(segments) and segments[-1] not in (".", ".."), "XML")
    resolved = [] if rooted or not base else base.split("/")
    for segment in segments:
        if segment == ".":
            continue
        if segment == "..":
            require(len(resolved) > 0, "XML")
            resolved.pop()
        else:
            resolved.append(segment)
    require(len(resolved) > 0, "XML")
    return "/".join(resolved)


class Workbook:
    def __init__(self, data, check):
        require(isinstance(data, bytes) and 0 < len(data) <= MAX_ARCHIVE, "INPUT")
        self.check = check
        try:
            self.archive = zipfile.ZipFile(io.BytesIO(data))
            entries = self.archive.infolist()
            require(0 < len(entries) <= 128 and len({e.filename for e in entries}) == len(entries), "ZIP")
            require(sum(e.file_size for e in entries) <= MAX_EXPANDED, "ZIP")
            for entry in entries:
                check()
                name = entry.filename
                require(re.fullmatch(r"[A-Za-z0-9_\[\]./-]+", name) and not name.startswith("/")
                        and not any(p in ("", ".", "..") for p in name.rstrip("/").split("/")), "ZIP")
                require(not entry.flag_bits & 1 and entry.compress_type in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED)
                        and entry.file_size <= MAX_XML and (entry.external_attr >> 16) & 0o170000 != 0o120000, "ZIP")
                require(entry.file_size <= max(1024 * 1024, entry.compress_size * 200), "ZIP")
                require("externalLinks/" not in name and not name.lower().endswith((".bin", ".vba")), "UNSUPPORTED")
            self.names = {e.filename for e in entries}
            types = self.xml("[Content_Types].xml")
            require(types.tag == "{http://schemas.openxmlformats.org/package/2006/content-types}Types", "XML")
            overrides = [entry.get("PartName") for entry in types if entry.tag.endswith("}Override")]
            require(len(overrides) == len(set(overrides)), "XML")
            require(all(not any(part in entry.get("ContentType", "").lower() for part in ("macroenabled", "vbaproject", "oleobject")) for entry in types), "UNSUPPORTED")
            require(any(e.get("PartName") == "/xl/workbook.xml" and e.get("ContentType") ==
                        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml" for e in types), "UNSUPPORTED")
            self.relationships = {}
            for name in sorted(self.names):
                if name.endswith(".rels"):
                    root = self.xml(name)
                    require(root.tag == REL + "Relationships", "XML")
                    targets = {}
                    base = "" if name == "_rels/.rels" else posixpath.dirname(posixpath.dirname(name))
                    for relation in root:
                        require(relation.tag == REL + "Relationship" and relation.get("TargetMode", "Internal") == "Internal", "UNSUPPORTED")
                        target, rid = relation.get("Target", ""), relation.get("Id", "")
                        require(rid and rid not in targets, "XML")
                        full = internal_relationship_target(base, target)
                        require(full in self.names, "XML")
                        targets[rid] = (full, relation.get("Type"))
                    self.relationships[name] = targets
            book = self.xml("xl/workbook.xml")
            require(book.tag == NS + "workbook", "XML")
            props = book.find(NS + "workbookPr")
            epoch = props.get("date1904", "false") if props is not None else "false"
            require(epoch in ("0", "1", "false", "true"), "XML")
            self.epoch1904 = epoch in ("1", "true")
            self.sheets = {}
            for sheet in book.findall(NS + "sheets/" + NS + "sheet"):
                title, rid = sheet.get("name"), sheet.get(DOC_REL + "id")
                require(title and title not in self.sheets, "XML")
                target, kind = self.relationships.get("xl/_rels/workbook.xml.rels", {}).get(rid, (None, None))
                require(target and kind == DOC_REL[1:-1] + "/worksheet", "XML")
                self.sheets[title] = (target, sheet.get("state", "visible"))
            require(0 < len(self.sheets) <= 32, "XML")
            self.strings = []
            if "xl/sharedStrings.xml" in self.names:
                strings = self.xml("xl/sharedStrings.xml")
                require(strings.tag == NS + "sst", "XML")
                for item in strings:
                    check()
                    require(item.tag == NS + "si", "XML")
                    self.strings.append(self.string(item))
                    require(len(self.strings) <= MAX_CELLS, "XML")
        except (zipfile.BadZipFile, RuntimeError, KeyError, OSError, NotImplementedError):
            raise Refused("ZIP") from None

    def xml(self, name):
        self.check()
        try:
            with self.archive.open(name) as stream:
                data = stream.read(MAX_XML + 1)
            data.decode("utf-8", "strict")
            require(len(data) <= MAX_XML and b"\x00" not in data
                    and not re.search(br"<!\s*(DOCTYPE|ENTITY)", data, re.I), "XML")
            result = ET.fromstring(data)
            require(sum(1 for _ in result.iter()) <= 1000000, "XML")
            self.check()
            return result
        except (ET.ParseError, UnicodeError):
            raise Refused("XML") from None
        except (zipfile.BadZipFile, RuntimeError, KeyError, OSError, NotImplementedError):
            raise Refused("ZIP") from None

    @staticmethod
    def string(element):
        direct, runs = element.findall(NS + "t"), element.findall(NS + "r/" + NS + "t")
        require(not (direct and runs), "XML")
        value = "".join(t.text or "" for t in direct + runs)
        require(len(value) <= 2000, "XML")
        return value

    def cells(self, title, summary_formulas=None):
        require(title in self.sheets, "PROFILE")
        target, state = self.sheets[title]
        require(state == "visible", "UNSUPPORTED")
        root = self.xml(target)
        require(root.tag == NS + "worksheet", "XML")
        require(not root.findall(NS + "mergeCells/" + NS + "mergeCell"), "UNSUPPORTED")
        out, row_ids = {}, set()
        for row in root.findall(NS + "sheetData/" + NS + "row"):
            self.check()
            row_id = row.get("r", "")
            require(re.fullmatch(r"[1-9]\d{0,5}", row_id) and int(row_id) <= 100000 and row_id not in row_ids, "ROWS")
            row_ids.add(row_id)
            for cell in row:
                self.check()
                ref = cell.get("r", "")
                match = re.fullmatch(r"([A-Z]{1,3})([1-9]\d{0,5})", ref)
                require(cell.tag == NS + "c" and match and match[2] == row_id and ref not in out and len(out) < MAX_CELLS, "ROWS")
                kind = cell.get("t", "n")
                values = cell.findall(NS + "v")
                require(len(values) <= 1, "XML")
                formulas = cell.findall(NS + "f")
                if formulas:
                    require(summary_formulas is not None and ref in summary_formulas and len(formulas) == 1
                            and not formulas[0].attrib and formulas[0].text == summary_formulas[ref]
                            and kind == "n" and cell.find(NS + "is") is None, "UNSUPPORTED")
                    out[ref] = SummaryFormula(bool(values and values[0].text is not None))
                    continue
                value = values[0].text if values else None
                if kind == "inlineStr":
                    inline = cell.find(NS + "is")
                    require(inline is not None and not values, "XML")
                    value = self.string(inline)
                elif kind == "s":
                    require(value is not None and re.fullmatch(r"\d+", value) and int(value) < len(self.strings), "XML")
                    value = self.strings[int(value)]
                elif kind == "b":
                    require(value in ("0", "1"), "VALUE")
                    value = value == "1"
                elif kind in ("n", "str", "d"):
                    value = numeric(value) if kind == "n" and value is not None else value
                else:
                    raise Refused("UNSUPPORTED")
                out[ref] = value if value != "" else None
        return out


def parse_diversity(data, profile, now, check):
    exact(profile, ["schema", "kind", "canonicalSheet", "date", "columns", "sheets"], "PROFILE")
    require(profile["schema"] == "fee-console.ratio-diversity-layout.v1" and profile["kind"] == "diversity", "PROFILE")
    text(profile["canonicalSheet"], "PROFILE")
    exact(profile["date"], ["cell", "encoding"], "PROFILE")
    require(profile["date"]["encoding"] in ("iso-date", "excel-date"), "PROFILE")
    exact(profile["columns"], DIVERSITY_FIELDS, "PROFILE")
    columns = {}
    for field, spec in profile["columns"].items():
        exact(spec, ["column", "header"], "PROFILE")
        require(type(spec["column"]) is str and re.fullmatch(r"[A-Z]{1,3}", spec["column"])
                and spec["header"] == DIVERSITY_FIELDS[field], "PROFILE")
        columns[field] = spec["column"]
    require(len(set(columns.values())) == len(columns), "PROFILE")
    require(type(profile["sheets"]) is list and 2 <= len(profile["sheets"]) <= 32, "PROFILE")
    book = Workbook(data, check)
    names, parsed, dates, summaries = set(), {}, set(), []
    total_cells = 0
    for sheet in profile["sheets"]:
        check()
        exact(sheet, ["name", "headerRow", "firstRow", "lastRow", "labels", "totalCells"], "PROFILE")
        name = text(sheet["name"], "PROFILE")
        require(name not in names and all(type(sheet[k]) is int for k in ("headerRow", "firstRow", "lastRow"))
                and 1 <= sheet["headerRow"] < sheet["firstRow"] <= 100000
                and sheet["firstRow"] - 1 <= sheet["lastRow"] <= 100000, "PROFILE")
        names.add(name)
        require(type(sheet["labels"]) is dict and len(sheet["labels"]) <= 64
                and type(sheet["totalCells"]) is dict and len(sheet["totalCells"]) <= 2, "PROFILE")
        formulas, fields = {}, set()
        for ref, field in sheet["totalCells"].items():
            match = re.fullmatch(r"([A-Z]{1,3})([1-9]\d{0,5})", ref)
            require(field in ("percentageRaw", "valueRaw") and field not in fields and match
                    and match[1] == columns[field] and sheet["lastRow"] < int(match[2]) <= 100000, "PROFILE")
            fields.add(field)
            if sheet["firstRow"] <= sheet["lastRow"]:
                formulas[ref] = "SUM(" + columns[field] + str(sheet["firstRow"]) + ":" + columns[field] + str(sheet["lastRow"]) + ")"
        cells = book.cells(name, formulas)
        total_cells += len(cells)
        require(total_cells <= MAX_CELLS, "ROWS")
        consumed = set()
        def claim(ref):
            require(type(ref) is str and re.fullmatch(r"[A-Z]{1,3}[1-9]\d{0,5}", ref) and ref not in consumed, "PROFILE")
            consumed.add(ref)
            return cells.get(ref)
        day = date_value(claim(profile["date"]["cell"]), profile["date"]["encoding"], book.epoch1904)
        dates.add(day)
        for field, col in columns.items():
            require(claim(col + str(sheet["headerRow"])) == DIVERSITY_FIELDS[field], "HEADER")
        for ref, expected in sheet["labels"].items():
            require(claim(ref) == text(expected, "PROFILE"), "HEADER")
        rows = []
        for index in range(sheet["firstRow"], sheet["lastRow"] + 1):
            check()
            row = {field: claim(col + str(index)) for field, col in columns.items()}
            text(row["name"])
            for field in ("market", "code", "category"):
                if row[field] is not None:
                    text(row[field])
            for field in ("percentageRaw", "valueRaw"):
                row[field] = decimal(row[field], signed=True)
            rows.append({"sourceSheet": name, "sourceRow": index, **row})
        for ref in sheet["totalCells"]:
            value = claim(ref)
            if isinstance(value, SummaryFormula):
                summaries.append({"sheet": name, "cell": ref, "cachedValuePresent": value.cached})
            else:
                decimal(value, signed=True)
        require(all(value is None or ref in consumed for ref, value in cells.items()), "ROWS")
        parsed[name] = rows
    require(names == set(book.sheets) and profile["canonicalSheet"] in names, "PROFILE")
    require(len(dates) == 1, "DATE")
    as_of = next(iter(dates))
    try:
        require(type(now) is str and re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z", now), "DATE")
        today = dt.datetime.fromisoformat(now.replace("Z", "+00:00")).astimezone(dt.timezone(dt.timedelta(hours=8))).date()
        require(0 <= (today - dt.date.fromisoformat(as_of)).days <= 4, "DATE")
    except (ValueError, OverflowError):
        raise Refused("DATE") from None
    # Compare multisets of full raw rows. Preserve multiplicity; never add the
    # repeated canonical sheet to its partition sheets or deduplicate by Code.
    signature = lambda row: tuple(row[field] for field in DIVERSITY_FIELDS)
    canonical = parsed[profile["canonicalSheet"]]
    require(len(canonical) > 0, "ROWS")
    partitions = Counter(signature(row) for name, rows in parsed.items() if name != profile["canonicalSheet"] for row in rows)
    require(Counter(signature(row) for row in canonical) == partitions, "ROWS")
    check()
    return json_numbers({"schema": "fee-console.ratio-xlsx-preview.v1", "status": "PARSED_UNAUTHENTICATED", "kind": "diversity",
                         "publicationReady": False, "sourceVerified": False, "completenessVerified": False,
                         "metadata": {"asOf": as_of, "currency": None, "view": None, "accountScopeVerified": False,
                                      "canonicalSheet": profile["canonicalSheet"], "partitionRowsMatchCanonical": True,
                                      "sheetRowCounts": {name: len(rows) for name, rows in parsed.items()},
                                      "ignoredSummaryFormulas": summaries, "percentageRepresentation": "unverified-number"},
                         "rows": canonical, "rowCount": len(canonical), "additionalWorksheetCount": 0,
                         "workbookSha256": hashlib.sha256(data).hexdigest()})


def _parse_workbook(data, profile, now, budget_ms=15000, monotonic=time.monotonic):
    require(type(budget_ms) is int and 1 <= budget_ms <= 30000, "INPUT")
    start = monotonic()
    def check():
        require(monotonic() - start < budget_ms / 1000, "TIMEOUT")
    check()
    if type(profile) is dict and profile.get("schema") == "fee-console.ratio-diversity-layout.v1":
        return parse_diversity(data, profile, now, check)
    exact(profile, ["schema", "kind", "sheet", "headerRow", "firstRow", "lastRow", "columns", "metadata",
                    "labels", "expectedView", "expectedAccounts", "percentRepresentation"], "PROFILE")
    require(profile["schema"] == "fee-console.ratio-xlsx-layout.v1" and profile["kind"] in FIELDS, "PROFILE")
    kind = profile["kind"]
    require(all(type(profile[k]) is int for k in ("headerRow", "firstRow", "lastRow"))
            and 1 <= profile["headerRow"] < profile["firstRow"] <= profile["lastRow"] <= 100000, "PROFILE")
    require(profile["percentRepresentation"] in (None, "percentage-points", "excel-fraction")
            and (kind == "classification" or profile["percentRepresentation"] is not None), "PROFILE")
    accounts = profile["expectedAccounts"]
    require(type(accounts) is list and 0 < len(accounts) <= 20 and len(set(accounts)) == len(accounts), "PROFILE")
    for account in accounts:
        text(account, "PROFILE")
    text(profile["sheet"], "PROFILE")
    text(profile["expectedView"], "PROFILE")
    exact(profile["columns"], FIELDS[kind], "PROFILE")
    meta_keys = ["asOf", "currency", "view"] + (["period", "startDate", "endDate", "includeClosed", "cashPerformance"] if kind == "performance" else [])
    exact(profile["metadata"], meta_keys, "PROFILE")
    require(type(profile["labels"]) is dict and len(profile["labels"]) <= 64, "PROFILE")
    book = Workbook(data, check)
    cells = book.cells(profile["sheet"])
    consumed, columns, metadata = set(), {}, {}
    def claim(ref):
        require(isinstance(ref, str) and re.fullmatch(r"[A-Z]{1,3}[1-9]\d{0,5}", ref) and ref not in consumed, "PROFILE")
        consumed.add(ref)
        return cells.get(ref)
    for field, spec in profile["columns"].items():
        exact(spec, ["column", "header"], "PROFILE")
        require(isinstance(spec["column"], str) and re.fullmatch(r"[A-Z]{1,3}", spec["column"]), "PROFILE")
        expected = text(spec["header"], "PROFILE")
        require(claim(spec["column"] + str(profile["headerRow"])) == expected, "HEADER")
        columns[field] = spec["column"]
    for ref, expected in profile["labels"].items():
        require(claim(ref) == text(expected, "PROFILE"), "HEADER")
    for field, spec in profile["metadata"].items():
        exact(spec, ["cell", "encoding"], "PROFILE")
        value = claim(spec["cell"])
        if field in ("asOf", "startDate", "endDate"):
            value = date_value(value, spec["encoding"], book.epoch1904)
        elif field == "includeClosed":
            require(spec["encoding"] == "boolean" and type(value) is bool, "PERFORMANCE")
        else:
            require(spec["encoding"] == "text", "PROFILE")
            value = text(value)
        metadata[field] = value
    require(metadata["currency"] == "USD", "CURRENCY")
    require(metadata["view"] == profile["expectedView"], "SCOPE")
    try:
        require(isinstance(now, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z", now), "DATE")
        today = dt.datetime.fromisoformat(now.replace("Z", "+00:00")).astimezone(dt.timezone(dt.timedelta(hours=8))).date()
        require(0 <= (today - dt.date.fromisoformat(metadata["asOf"])).days <= 4, "DATE")
    except (ValueError, OverflowError):
        raise Refused("DATE") from None
    if kind == "performance":
        require(metadata["period"] in ("all", "oneYear") and metadata["includeClosed"] is True
                and metadata["startDate"] <= metadata["endDate"] == metadata["asOf"]
                and metadata["cashPerformance"] in ("included", "excluded", "mixed", "unknown"), "PERFORMANCE")
        if metadata["period"] == "oneYear":
            end = dt.date.fromisoformat(metadata["endDate"])
            try:
                prior = end.replace(year=end.year - 1)
            except ValueError:
                prior = end.replace(year=end.year - 1, day=28)
            require(metadata["startDate"] == prior.isoformat(), "PERFORMANCE")
    rows, identities = [], set()
    for index in range(profile["firstRow"], profile["lastRow"] + 1):
        check()
        row = {field: claim(column + str(index)) for field, column in columns.items()}
        require(any(value is not None for value in row.values()), "ROWS")
        for field in (["account", "name"] if kind != "performance" else ["scopeType", "scopeName", "unit"]):
            text(row[field])
        if kind != "performance":
            require(row["account"] in accounts, "SCOPE")
            row["valueUSD"] = decimal(row["valueUSD"], money=True, signed=kind == "exposure" and row["ownership"] == "Residual")
        if kind == "classification":
            text(row["sharesightCategory"])
            if row["sharesightCategory"] == "Cash Accounts":
                require(row["securityCode"] is None and row["market"] is None and row["quantity"] is None, "VALUE")
                identity = (row["account"], "cash", row["name"])
            else:
                text(row["securityCode"]); text(row["market"])
                if row["quantity"] is not None:
                    row["quantity"] = decimal(row["quantity"])
                identity = (row["account"], row["securityCode"], row["market"])
        elif kind == "exposure":
            require(row["ownership"] in ("Direct", "Underlying", "Residual", "Cash"), "VALUE")
            if row["ownership"] == "Cash":
                require(row["securityCode"] is None and row["market"] is None and row["withinETF"] is None, "VALUE")
            else:
                text(row["securityCode"]); text(row["market"])
                if row["ownership"] == "Underlying":
                    text(row["withinETF"])
                else:
                    require(row["withinETF"] is None, "VALUE")
            if row["sourcePercentage"] is not None:
                row["sourcePercentage"] = decimal(row["sourcePercentage"], signed=row["ownership"] == "Residual") * (100 if profile["percentRepresentation"] == "excel-fraction" else 1)
            identity = tuple(row[k] for k in ("account", "securityCode", "market", "ownership", "withinETF")) + ((row["name"],) if row["ownership"] == "Cash" else ())
        else:
            require(row["scopeType"] in ("portfolio", "classification", "fund-strategy")
                    and row["unit"] in ("p.a.", "period", "unknown", "unavailable"), "PERFORMANCE")
            if row["scopeType"] == "portfolio":
                require(row["scopeName"] == profile["expectedView"] and row["scopeParent"] is None, "PERFORMANCE")
            elif row["scopeType"] == "classification":
                require(row["scopeParent"] is None, "PERFORMANCE")
            else:
                text(row["scopeParent"])
            if row["unit"] == "unavailable":
                require(row["returnPct"] is None and row["returnAmountUSD"] is None, "PERFORMANCE")
            else:
                row["returnPct"] = decimal(row["returnPct"], signed=True) * (100 if profile["percentRepresentation"] == "excel-fraction" else 1)
                require(abs(row["returnPct"]) <= 1000000000, "PERFORMANCE")
                if row["returnAmountUSD"] is not None:
                    row["returnAmountUSD"] = decimal(row["returnAmountUSD"], money=True, signed=True)
            identity = tuple(row[k] for k in ("scopeType", "scopeName", "scopeParent"))
        require(identity not in identities, "ROWS")
        identities.add(identity)
        rows.append({"sourceRow": index, **row})
    require(all(value is None or ref in consumed for ref, value in cells.items()), "ROWS")
    if kind == "exposure":
        parents, residuals, direct = {}, {}, set()
        for row in rows:
            key = (row["account"], str(row["securityCode"]) + "." + str(row["market"]))
            if row["ownership"] == "Underlying":
                owner = (row["account"], row["withinETF"])
                parents[owner] = parents.get(owner, Decimal(0)) + row["valueUSD"]
            elif row["ownership"] == "Residual":
                require(key not in residuals, "RESIDUAL")
                residuals[key] = row["valueUSD"]
            elif row["ownership"] == "Direct":
                direct.add(key)
        require(set(parents) == set(residuals) and not set(parents) & direct
                and all(value + residuals[key] >= 0 for key, value in parents.items()), "RESIDUAL")
    check()
    return json_numbers({"schema": "fee-console.ratio-xlsx-preview.v1", "status": "PARSED_UNAUTHENTICATED",
                         "kind": kind, "publicationReady": False, "sourceVerified": False,
                         "completenessVerified": False, "metadata": metadata, "rows": rows,
                         "rowCount": len(rows), "additionalWorksheetCount": len(book.sheets) - 1,
                         "workbookSha256": hashlib.sha256(data).hexdigest()})


def parse_workbook(data, profile, now, budget_ms=15000, monotonic=time.monotonic):
    try:
        return _parse_workbook(data, profile, now, budget_ms, monotonic)
    except Refused:
        raise
    except Exception:
        raise Refused("INPUT") from None


def main():
    try:
        raw = sys.stdin.buffer.read(8 * 1024 * 1024 + 1)
        require(0 < len(raw) <= 8 * 1024 * 1024, "INPUT")
        request = strict_json(raw)
        exact(request, ["schema", "workbookBase64", "workbookSha256", "profileJson", "now", "budgetMs"], "INPUT")
        require(request["schema"] == "fee-console.ratio-xlsx-request.v1" and isinstance(request["workbookBase64"], str)
                and isinstance(request["profileJson"], str) and len(request["profileJson"].encode()) <= 65536, "INPUT")
        try:
            data = base64.b64decode(request["workbookBase64"], validate=True)
        except (ValueError, TypeError):
            raise Refused("INPUT") from None
        require(hashlib.sha256(data).hexdigest() == request["workbookSha256"], "HASH")
        result = parse_workbook(data, strict_json(request["profileJson"]), request["now"], request["budgetMs"])
        result["profileSha256"] = hashlib.sha256(request["profileJson"].encode()).hexdigest()
        output = json.dumps(result, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode()
        require(len(output) <= MAX_ARCHIVE, "INPUT")
        sys.stdout.buffer.write(output)
        return 0
    except Refused as error:
        sys.stdout.write(json.dumps({"error": str(error)}))
    except Exception:
        sys.stdout.write('{"error":"RATIO_XLSX_INPUT"}')
    return 2


if __name__ == "__main__":
    sys.exit(main())
