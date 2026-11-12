"""Entirely FABRICATED complete report set; never provider or Library evidence.

Only IB-HK and NOAH-HK are public contract labels. All amounts, instruments,
accounts, dates, archive assertions and identities are invented test inputs.
The inode map is for a test mock, not genuine Library identity or real xattrs.
"""
import datetime as dt
import hashlib
import io
import json
from pathlib import Path
import zipfile
from xml.sax.saxutils import escape, quoteattr

NOW = dt.datetime(2026, 11, 12, 12, tzinfo=dt.timezone.utc)
TARGET = '2026-11-12'
ALL_START = '2017-12-15'
CAPTURED = '2026-11-12T11:00:00.000Z'
CAPTURE_NS = 1794481200000000000
ACCOUNTS = sorted(['IB-HK', 'NOAH-HK'] + ['Fabricated Account %02d' % i for i in range(1, 9)])
SCOPE = hashlib.sha256(json.dumps(ACCOUNTS, separators=(',', ':')).encode()).hexdigest()
GROUPS = {'assetclass': '资产类别', 'strategy': '小程序收益分类', 'top5': '小程序前五收益', 'stock': '小程序股票市场收益'}
CLASS_HEADER = ['Market', 'Code', 'Name', 'Portfolio', 'Price', 'Quantity', 'Value (us$)', 'Capital Gains', 'Capital Gains Percentage', 'Dividends', 'Dividends Percentage', 'Currency', 'Currency Percentage', 'Return', 'Return Percentage', '资产类别', 'Labels']
EXPOSURE_HEADER = ['Market', 'Code', 'Name', 'Within Etf', 'Portfolio', 'Ownership', 'Percentage', 'Value']
STOCK_CATEGORIES = ('美国底仓', '美国科技', '非美发达', '新兴市场')
NATIVE_RATE = '12% p.a.'  # Declared source cell, NEVER computed from amounts.


def native_rows():
    """24 position members (23 instruments) and two separate cash members."""
    rows = []
    for category, prefix in [('VC/PE', 'Venture'), ('对冲基金', 'Hedge'), ('常青基金', 'Evergreen')]:
        for index in range(1, 6):
            strategy = 'Fabricated' + prefix + 'Strategy%02d' % index
            display = 'Fabricated ' + prefix + ' Fund %02d' % index
            code = strategy + '-2020-01-' + display
            n = len(rows)
            rows.append(['FAB', code, display, ACCOUNTS[n % 10], 10, 100 + n, (100 + n) * 10,
                         20 + n, 2, 3, 1, 1, 0, 24 + n, NATIVE_RATE, category, None])
    # Identical market/code/name/price, but another account and native amounts.
    shared = list(rows[0])
    shared[3], shared[5], shared[6] = ACCOUNTS[1], 50, 500
    shared[7], shared[9], shared[11], shared[13] = 7, 2, 1, 10
    rows.append(shared)
    for category_index, category in enumerate(STOCK_CATEGORIES):
        for index in range(2):
            n = len(rows)
            rows.append(['FAB', 'FABSTOCK%02d' % (category_index * 2 + index),
                         'Fabricated Stock %02d' % (category_index * 2 + index),
                         ACCOUNTS[n % 10], 20, 100 + n, (100 + n) * 20,
                         30 + n, 2, 4, 1, 2, 0, 36 + n, NATIVE_RATE, category, None])
    for account in ('IB-HK', 'NOAH-HK'):
        rows.append([None, None, 'Fabricated USD Cash ' + account, account, None, None, 700,
                     0, 0, 7, 1, 0, 0, 7, NATIVE_RATE, 'Cash Accounts', None])
    return rows


def _xlsx(sheets):
    """Small deterministic XLSX with identical General formats on all sheets."""
    ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
    rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
    def xml_rows(values):
        output = []
        for index, row in enumerate(values, 1):
            cells = []
            for column, value in enumerate(row):
                if value is None:
                    continue
                address = chr(65 + column) + str(index)
                if isinstance(value, str):
                    cells.append('<c r="%s" t="inlineStr"><is><t>%s</t></is></c>' % (address, escape(value)))
                else:
                    cells.append('<c r="%s"><v>%s</v></c>' % (address, value))
            output.append('<row r="%d">%s</row>' % (index, ''.join(cells)))
        return '<worksheet xmlns="%s"><sheetData>%s</sheetData></worksheet>' % (ns, ''.join(output))
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, 'w') as archive:
        def put(name, value):
            info = zipfile.ZipInfo(name, (2026, 11, 12, 11, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, value)
        put('xl/workbook.xml', '<workbook xmlns="%s" xmlns:r="%s"><sheets>%s</sheets></workbook>' %
            (ns, rel, ''.join('<sheet name=%s sheetId="%d" r:id="r%d"/>' % (quoteattr(name), i, i) for i, (name, _) in enumerate(sheets, 1))))
        put('xl/_rels/workbook.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
            ''.join('<Relationship Id="r%d" Target="worksheets/sheet%d.xml" Type="%s/worksheet"/>' % (i, i, rel) for i in range(1, len(sheets) + 1)) + '</Relationships>')
        for i, (_, rows) in enumerate(sheets, 1):
            put('xl/worksheets/sheet%d.xml' % i, xml_rows(rows))
    return stream.getvalue()


def _report(rows, *, group=None, start=None, exposure=False, combined=False):
    width = 8 if exposure else 17
    header = list(EXPOSURE_HEADER if exposure else CLASS_HEADER)
    if group:
        header[15] = group
        if combined:
            header[3] = 'Portfolios'
        title = 'Showing performance by %s between dates %s to 12 Nov 2026' % (group, dt.date.fromisoformat(start).strftime('%d %b %Y'))
    else:
        title = 'FABRICATED test report as at 12 Nov 2026'
    def sheet(members):
        result = [[title] + [None] * (width - 1)]
        if group:
            result.append(['Including sold shares'] + [None] * (width - 1))
        result.append(list(header))
        result.extend(list(row) for row in members)
        total = ['Total'] + [None] * (width - 1)
        total[7 if exposure else 6] = sum(r[7 if exposure else 6] for r in members)
        if not exposure:
            for column in (7, 9, 11, 13):
                total[column] = sum(r[column] for r in members)
            total[14] = NATIVE_RATE
        result.append(total)
        return result
    partitions = {}
    for row in rows:
        key = row[5] if exposure else row[15]
        partitions.setdefault(key, []).append(row)
    # Sheet titles need not equal labels; labels in P determine exact scopes.
    return _xlsx([('Combined', sheet(rows))] + [('Group %02d' % index, sheet(members))
                  for index, members in enumerate(partitions.values(), 1)])


def _performance_rows(role, *, combined):
    rows = native_rows()
    for row in rows:
        category = row[15]
        if role == 'strategy':
            row[15] = ('PE/VC' if category == 'VC/PE' else category + ' · ' + row[1].split('-', 1)[0]
                       if category in ('对冲基金', '常青基金') else 'Cash Accounts' if category == 'Cash Accounts' else 'Uncategorised')
        elif role == 'stock':
            row[15] = '股票市场' if category in STOCK_CATEGORIES else 'Cash Accounts' if category == 'Cash Accounts' else 'Uncategorised'
        elif role == 'top5':
            row[15] = 'Cash Accounts' if category == 'Cash Accounts' else 'FABRICATED target ' + row[1]
    if role != 'top5' or not combined:
        return rows
    instruments = {}
    for row in rows:
        instruments.setdefault(tuple(row[:3]), []).append(row)
    result = []
    for members in instruments.values():
        row = list(members[0])
        row[3] = ', '.join(sorted(r[3] for r in members))
        for column in (5, 6, 7, 9, 11, 13):
            row[column] = None if all(r[column] is None for r in members) else sum(r[column] for r in members)
        result.append(row)
    return result


def full_batch(root, *, combined=True):
    """Return (request, mock inode identity map, synthetic scope SHA-256).

    Does not modify runtime, install xattrs, invoke a provider, or authenticate
    any observation. Both combined and uncombined Top5 reports are available.
    """
    if type(combined) is not bool:
        raise ValueError('combined must be bool')
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    root.chmod(0o700)
    identities = {}
    def write(name, blob):
        path = root / name
        with path.open('xb') as handle:
            path.chmod(0o600)
            handle.write(blob)
        ident = 'libfile_' + ('%032x' % (0xFA0000 + len(identities)))
        identities[path.stat().st_ino] = (ident, '0')
        return dict(path=str(path), libraryFileId=ident, libraryVersion=0, sha256=hashlib.sha256(blob).hexdigest())
    def encoded(value):
        return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()
    rows = native_rows()
    exposure = [[r[0], r[1], r[2], None, r[3], 'Cash' if r[0] is None else 'Direct', None if r[0] is None else 100, r[6]] for r in rows]
    bindings = {'allocation': {}}
    allocation_capture = {}
    for role, blob in [('classification', _report(rows)), ('exposure', _report(exposure, exposure=True))]:
        spec = write(role + '.xlsx', blob)
        bindings['allocation'][role] = spec
        allocation_capture[role] = dict(sha256=spec['sha256'], originalMtimeNs=CAPTURE_NS, capturedAt=CAPTURED, downloadCompletedAt=None)
    bindings['allocation']['capture'] = write('allocation-capture.json', encoded(allocation_capture))
    for role, group in GROUPS.items():
        bindings[role], reports = {}, {}
        for period, start in [('all', ALL_START), ('oneYear', '2025-11-12')]:
            mode = combined and role == 'top5'
            blob = _report(_performance_rows(role, combined=combined), group=group, start=start, combined=mode)
            spec = write(role + '-' + period + '.xlsx', blob)
            bindings[role][period] = spec
            reports[period] = dict(sha256=spec['sha256'], rangeKind='since-inception' if period == 'all' else 'trailing-twelve-months',
                startDate=start, endDate=TARGET, includeClosed=True, combineByHolding=mode, currency='USD', groupBy=group,
                cashPerformance='included', originalMtimeNs=str(CAPTURE_NS), downloadStartedAt=None, downloadCompletedAt=None, observedCompleteAt=CAPTURED)
        bindings[role]['capture'] = write(role + '-capture.json', encoded(dict(schema='fee-console.performance-capture.v1', accounts=ACCOUNTS, reports=reports)))
    archive = write('fabricated-historical-archive.json', encoded(dict(syntheticOnly=True, notProviderEvidence=True, assertion='Fabricated holding inception dates only.')))
    captured = '2026-01-02T00:00:00.000Z'
    evidence = dict(schema='fee-console.ratio-inception-source.v2', capturedAt=captured, includeClosed=True,
        sources=[dict(libraryFileId=archive['libraryFileId'], version=0, sha256=archive['sha256'], locator='fabricated test archive')],
        sourceCaptures=[dict(libraryFileId=archive['libraryFileId'], capturedAt=captured, sourceKind='verified-historical-archive')],
        members=[dict(account=r[3], market=r[0] or 'CASH', securityCode=r[1] or r[2], startDate='2020-01-15', dateKind='holding-inception' if r[0] else 'cash-opening-balance',
                      sourceFileId=archive['libraryFileId'], sourceLocator='fabricated member %d' % i) for i, r in enumerate(rows)])
    document = write('inception.json', encoded(evidence))
    request = dict(schema='ratio-offline-workbook-batch.v1', targetDate=TARGET, allStartDate=ALL_START,
                   bindings=bindings, inception=dict(document=document, sources=[archive]))
    return request, identities, SCOPE
