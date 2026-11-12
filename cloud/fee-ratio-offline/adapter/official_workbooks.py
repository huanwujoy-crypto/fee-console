"""Local candidate: reusable official workbook parsing, with no network or writer.

Extracted from the verified manual parser. Daily capture is NOT implemented here.
Original report dates and every source value are returned without relabelling.
"""
import collections, datetime, decimal, hashlib, json, re, zipfile, io
import xml.etree.ElementTree as ET
D = decimal.Decimal
NS = {'s': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
HEADERS = {'classification': ['Market', 'Code', 'Name', 'Portfolio', 'Price', 'Quantity', 'Value (us$)', 'Capital Gains', 'Capital Gains Percentage', 'Dividends', 'Dividends Percentage', 'Currency', 'Currency Percentage', 'Return', 'Return Percentage', '资产类别', 'Labels'], 'exposure': ['Market', 'Code', 'Name', 'Within Etf', 'Portfolio', 'Ownership', 'Percentage', 'Value']}

def workbook(file, width):
    result = {}
    formulas = {}
    xmlrows = 0
    with zipfile.ZipFile(io.BytesIO(file) if isinstance(file, bytes) else file) as z:
        if not sum((x.file_size for x in z.infolist())) < 100000000:
            raise ValueError('OFFICIAL_WORKBOOK_REFUSED')
        if not len(z.namelist()) == len(set(z.namelist())):
            raise ValueError('OFFICIAL_WORKBOOK_REFUSED')
        for entry in z.infolist():
            if entry.flag_bits & 1 or entry.file_size > 20 * 1024 * 1024 or entry.filename.startswith('/') or '..' in entry.filename.split('/'):
                raise ValueError('UNSAFE_ZIP_ENTRY')
            if entry.filename.endswith(('.xml', '.rels')):
                xml = z.read(entry)
                if b'<!DOCTYPE' in xml.upper() or b'<!ENTITY' in xml.upper():
                    raise ValueError('UNSAFE_XML')
        ss = []
        if 'xl/sharedStrings.xml' in z.namelist():
            for si in ET.fromstring(z.read('xl/sharedStrings.xml')).findall('s:si', NS):
                ss.append(''.join((t.text or '' for t in si.findall('.//s:t', NS))))
        raw_rels = list(ET.fromstring(z.read('xl/_rels/workbook.xml.rels')))
        if any(r.attrib.get('TargetMode') == 'External' for r in raw_rels) or len({r.attrib['Id'] for r in raw_rels}) != len(raw_rels):
            raise ValueError('UNSAFE_RELATIONSHIP')
        rels = {r.attrib['Id']: r.attrib['Target'] for r in raw_rels}
        sheets = ET.fromstring(z.read('xl/workbook.xml')).findall('s:sheets/s:sheet', NS)
        if len({s.attrib['name'] for s in sheets}) != len(sheets):
            raise ValueError('DUPLICATE_WORKSHEET')
        for s in sheets:
            target = rels[s.attrib['{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id']]
            name = target.lstrip('/') if target.startswith('/') else 'xl/' + target
            if not ('..' not in name.split('/') and name.startswith('xl/worksheets/')):
                raise ValueError('OFFICIAL_WORKBOOK_REFUSED')
            rows = []
            ff = {}
            for row in ET.fromstring(z.read(name)).findall('s:sheetData/s:row', NS):
                n = int(row.attrib['r'])
                if not len(rows) < n <= 100000:
                    raise ValueError('OFFICIAL_WORKBOOK_REFUSED')
                while len(rows) < n:
                    rows.append([None] * width)
                seen_cells = set()
                for c in row.findall('s:c', NS):
                    ref = c.attrib['r']
                    if not ref not in seen_cells:
                        raise ValueError('DUPLICATE_CELL')
                    seen_cells.add(ref)
                    match = re.fullmatch('([A-Z]+)(\\d+)', ref)
                    if not (match and int(match[2]) == n):
                        raise ValueError('OFFICIAL_WORKBOOK_REFUSED')
                    col = 0
                    for ch in match[1]:
                        col = col * 26 + ord(ch) - 64
                    if not 1 <= col <= width:
                        raise ValueError('OFFICIAL_WORKBOOK_REFUSED')
                    typ = c.attrib.get('t', 'n')
                    v = c.find('s:v', NS)
                    v = v.text if v is not None else None
                    f = c.find('s:f', NS)
                    if f is not None:
                        ff[n, col] = '=' + (f.text or '')
                    if typ == 's':
                        value = ss[int(v)] if v is not None else None
                    elif typ == 'inlineStr':
                        value = ''.join((t.text or '' for t in c.findall('.//s:t', NS)))
                    elif typ == 'str':
                        value = v
                    elif typ == 'n':
                        value = None if v is None else int(v) if re.fullmatch('-?\\d+', v) else float(v)
                        if value is not None:
                            if not D(str(value)).is_finite():
                                raise ValueError('OFFICIAL_WORKBOOK_REFUSED')
                    elif typ == 'b':
                        value = v == '1'
                    else:
                        raise AssertionError('UNSUPPORTED_CELL_TYPE')
                    if f is not None and value is None and re.fullmatch('-?\\d+(?:\\.\\d+)?', f.text or ''):
                        value = float(f.text)
                    rows[n - 1][col - 1] = value
                xmlrows += 1
            result[s.attrib['name']] = rows
            formulas[s.attrib['name']] = ff
    return (result, formulas, xmlrows)

def data(rows, role):
    ix = [i for (i, r) in enumerate(rows) if r == HEADERS[role]]
    if not len(ix) == 1:
        raise ValueError('HEADER_MISMATCH')
    (ac, vl) = (3, 6) if role == 'classification' else (4, 7)
    out = []
    for (i, r) in enumerate(rows):
        if i <= ix[0] or r[ac] in (None, ''):
            continue
        if not (isinstance(r[ac], str) and type(r[vl]) in (int, float) and D(str(r[vl])).is_finite()):
            raise ValueError('INVALID_ACCOUNT_VALUE')
        out.append((i + 1, r))
    return out

def validate(file, role):
    (sheets, formulas, xmlrows) = workbook(file, len(HEADERS[role]))
    if 'Combined' not in sheets or len(sheets) < 2:
        raise ValueError('WORKSHEET_SET')
    rows = data(sheets['Combined'], role)
    for sheet, entries in sheets.items():
        headers = [i for i, row in enumerate(entries) if row == HEADERS[role]]
        if len(headers) != 1:
            raise ValueError('HEADER_MISMATCH')
        account_column = 3 if role == 'classification' else 4
        total_seen = False
        for row in entries[headers[0] + 1:]:
            if all(value in (None, '') for value in row):
                continue
            if row[0] == 'Total':
                total_seen = True
            elif row[account_column] in (None, '') or total_seen:
                raise ValueError('UNACCOUNTED_SOURCE_ROW')
        for (row, col), formula in formulas[sheet].items():
            total_col = 7 if role == 'classification' else 8
            if entries[row-1][0] != 'Total' or col != total_col or not re.fullmatch(r'=-?\d+(?:\.\d+)?', formula):
                raise ValueError('SOURCE_FORMULA')
            if D(formula[1:]) != D(str(entries[row-1][col-1])):
                raise ValueError('TOTAL_CACHE')
    canon = lambda r: json.dumps(r, ensure_ascii=False, separators=(',', ':'))
    others = [r for (name, rs) in sheets.items() if name != 'Combined' for (_, r) in data(rs, role)]
    if not collections.Counter((canon(r) for (_, r) in rows)) == collections.Counter((canon(r) for r in others)):
        raise ValueError('GROUPING_DUPLICATES_DIFFER')
    (ac, vl) = (3, 6) if role == 'classification' else (4, 7)
    total = sum((D(str(r[vl])) for (_, r) in rows), D(0))
    totals = [(i + 1, r[vl]) for (i, r) in enumerate(sheets['Combined']) if str(r[0]).strip() == 'Total']
    if not len(totals) == 1:
        raise ValueError('OFFICIAL_WORKBOOK_REFUSED')
    (n, v) = totals[0]
    v = formulas['Combined'].get((n, vl + 1), v)
    if isinstance(v, str):
        if not re.fullmatch('=-?\\d+(?:\\.\\d+)?', v):
            raise ValueError('UNSUPPORTED_TOTAL_FORMULA')
        v = v[1:]
    exported = D(str(v))
    if not exported.is_finite() or exported * 100 != (exported * 100).to_integral_value():
        raise ValueError('TOTAL_PRECISION')
    footer_delta = exported - total
    if footer_delta != 0:
        raise ValueError('STRICT_TOTAL_MISMATCH')
    group_totals = []
    for (name, rs) in sheets.items():
        if name == 'Combined':
            continue
        group_rows = data(rs, role)
        gs = sum((D(str(r[vl])) for (_, r) in group_rows), D(0))
        gt = [(i + 1, r[vl]) for (i, r) in enumerate(rs) if str(r[0]).strip() == 'Total']
        if not len(gt) == 1:
            raise ValueError('OFFICIAL_WORKBOOK_REFUSED')
        (gn, gv) = gt[0]
        gv = formulas[name].get((gn, vl + 1), gv)
        if isinstance(gv, str):
            if not re.fullmatch('=-?\\d+(?:\\.\\d+)?', gv):
                raise ValueError('OFFICIAL_WORKBOOK_REFUSED')
            gv = gv[1:]
        if not D(str(gv)) == gs:
            raise ValueError('GROUP_TOTAL_DIFFERS')
        group_totals.append(gs)
    if not sum(group_totals, D(0)) == total:
        raise ValueError('OFFICIAL_WORKBOOK_REFUSED')
    evidence = [v for row in sheets['Combined'][:5] for v in row if isinstance(v, str) and re.search('\\b\\d{1,2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \\d{4}\\b', v)]
    if not len(evidence) == 1:
        raise ValueError('OFFICIAL_WORKBOOK_REFUSED')
    dates = re.findall('\\b\\d{1,2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \\d{4}\\b', evidence[0])
    if not len(set(dates)) == 1:
        raise ValueError('OFFICIAL_WORKBOOK_REFUSED')
    asof = datetime.datetime.strptime(dates[0], '%d %b %Y').date().isoformat()
    accounts = sorted({r[ac].replace('&amp;', '&') for (_, r) in rows})
    if not len(accounts) == 10:
        raise ValueError('OFFICIAL_WORKBOOK_REFUSED')
    return (rows, accounts, {'role': role, 'as_of': asof, 'date_basis': evidence[0], 'canonical_data_rows': len(rows), 'raw_xml_rows_all_sheets': xmlrows, 'combined_total_matches': footer_delta == 0, 'combined_footer_minus_rows_cents': int(footer_delta * 100), 'group_totals_match_rows': True, 'group_sheets_duplicate_combined': True, 'account_count': 10, 'sheets': len(sheets)})

