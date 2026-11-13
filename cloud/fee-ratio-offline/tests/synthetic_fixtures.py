"""Fabricated XLSX and metadata only. Never claim these are Library originals."""
import datetime as dt
import hashlib
import io
import json
from pathlib import Path
import zipfile
from xml.sax.saxutils import escape

NOW = dt.datetime(2026, 11, 12, 12, tzinfo=dt.timezone.utc)
ACCOUNTS = ['Synthetic Account %02d' % n for n in range(10)]
SCOPE = hashlib.sha256(json.dumps(ACCOUNTS, separators=(',', ':')).encode()).hexdigest()
CLASS_HEADER = ['Market', 'Code', 'Name', 'Portfolio', 'Price', 'Quantity', 'Value (us$)', 'Capital Gains', 'Capital Gains Percentage', 'Dividends', 'Dividends Percentage', 'Currency', 'Currency Percentage', 'Return', 'Return Percentage', '资产类别', 'Labels']
EXPOSURE_HEADER = ['Market', 'Code', 'Name', 'Within Etf', 'Portfolio', 'Ownership', 'Percentage', 'Value']


def make_xlsx(role='classification', *, day='2026-11-12', duplicate=False, missing_group=False, delta=0, formula=None,
              perf=False, include_closed=True, group='资产类别', rate='12% p.a.', extra_xml='', sheet_duplicate=False, orphan=False, label='美国底仓'):
    width = 8 if role == 'exposure' else 17
    header = list(EXPOSURE_HEADER if role == 'exposure' else CLASS_HEADER)
    if perf:
        header[15] = group
        title = 'Showing performance by ' + group + ' between dates 12 Nov 2025 to 12 Nov 2026'
    else:
        title = 'Official synthetic report as at ' + dt.date.fromisoformat(day).strftime('%d %b %Y')
    rows = [[title] + [None] * (width-1)]
    if perf:
        rows.append([('Including' if include_closed else 'Excluding') + ' sold shares'] + [None] * (width-1))
    rows.append(header)
    data = []
    for n, account in enumerate(ACCOUNTS):
        if role == 'exposure':
            data.append(['SYNTH', 'SYN%02d' % n, 'Synthetic holding %02d' % n, None, account, 'Direct', 100, 100])
        else:
            data.append(['SYNTH', 'SYN%02d' % n, 'Synthetic holding %02d' % n, account, 10, 10, 100, 1, 1, 2, 2, 0, 0, 3, rate if perf else 3, label, None])
    if duplicate:
        data.append(list(data[0]))
    if orphan:
        data[0][4 if role == 'exposure' else 3] = None
    rows += data
    total = ['Total'] + [None] * (width-1)
    total[7 if role == 'exposure' else 6] = len(data) * 100 + delta
    if perf:
        total[14] = rate
    rows.append(total)
    other = [list(row) for row in rows]
    if missing_group:
        other.pop(-2)
        other[-1][7 if role == 'exposure' else 6] -= 100
    sheets = [('Combined', rows), ('Combined' if sheet_duplicate else 'Synthetic Group', other)]
    ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
    rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
    def col(n):
        return chr(65+n)
    def xml_rows(values):
        out = []
        for index, row in enumerate(values, 1):
            cells = []
            for column, value in enumerate(row):
                if value is None:
                    continue
                address = col(column) + str(index)
                if isinstance(value, str):
                    cells.append('<c r="%s" t="inlineStr"><is><t>%s</t></is></c>' % (address, escape(value)))
                else:
                    f = ''
                    if formula and index == len(values) and column == (7 if role == 'exposure' else 6):
                        f = '<f>%s</f>' % escape(formula)
                    cells.append('<c r="%s">%s<v>%s</v></c>' % (address, f, value))
            out.append('<row r="%d">%s</row>' % (index, ''.join(cells)))
        return '<?xml version="1.0"?>' + extra_xml + '<worksheet xmlns="%s"><sheetData>%s</sheetData></worksheet>' % (ns, ''.join(out))
    result = io.BytesIO()
    with zipfile.ZipFile(result, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('xl/workbook.xml', '<workbook xmlns="%s" xmlns:r="%s"><sheets>%s</sheets></workbook>' % (ns, rel, ''.join('<sheet name="%s" sheetId="%d" r:id="r%d"/>' % (name, i, i) for i, (name, _) in enumerate(sheets, 1))))
        z.writestr('xl/_rels/workbook.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + ''.join('<Relationship Id="r%d" Target="worksheets/sheet%d.xml" Type="%s/worksheet"/>' % (i, i, rel) for i in range(1, 3)) + '</Relationships>')
        for i, (_, values) in enumerate(sheets, 1):
            z.writestr('xl/worksheets/sheet%d.xml' % i, xml_rows(values))
    return result.getvalue()


def batch(root, *, classification=None, exposure=None, mutate_capture=None):
    root = Path(root)
    blobs = {'classification': make_xlsx() if classification is None else classification,
             'exposure': make_xlsx('exposure') if exposure is None else exposure}
    at = NOW - dt.timedelta(hours=1)
    capture = {role: dict(sha256=hashlib.sha256(blob).hexdigest(), originalMtimeNs=int(at.timestamp()) * 1000000000,
                         capturedAt=at.isoformat(timespec='milliseconds').replace('+00:00', 'Z'), downloadCompletedAt=None)
               for role, blob in blobs.items()}
    if mutate_capture:
        mutate_capture(capture)
    blobs['capture'] = json.dumps(capture, separators=(',', ':')).encode()
    bindings, identities = {}, {}
    for index, (role, blob) in enumerate(blobs.items(), 1):
        path = root / (role + ('.json' if role == 'capture' else '.xlsx'))
        path.write_bytes(blob)
        path.chmod(0o600)
        ident = 'libfile_' + ('%032x' % index)
        bindings[role] = dict(path=str(path), libraryFileId=ident, libraryVersion=0, sha256=hashlib.sha256(blob).hexdigest())
        identities[path.stat().st_ino] = (ident, '0')
    return dict(schema='ratio-offline-allocation-bindings.v1', targetDate='2026-11-12', bindings=bindings), identities
