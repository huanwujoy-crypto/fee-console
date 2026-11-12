"""Untrusted stock native rows; immutable bytes only, strict totals."""
import collections, datetime as dt, decimal, re, json
from .official_workbooks import HEADERS, workbook, data
from .native_columns import cell_formats
from .native_cells import numeric_cells
from .strict_totals import reconcile, source_hash
D=decimal.Decimal

def require(condition, code):
    if not condition:
        raise ValueError('STOCK_SUBTOTAL_' + code)

def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))

def identity(row):
    require(isinstance(row[3], str) and row[3], 'MEMBER_ACCOUNT')
    account = row[3].replace('&amp;', '&')
    if row[0] in (None, '') and row[1] in (None, ''):
        require(row[15] == 'Cash Accounts' and isinstance(row[2], str) and row[2], 'CASH_MEMBER')
        return (account, 'CASH', row[2])
    require(all((isinstance(v, str) and v for v in row[:3])), 'MEMBER_IDENTITY')
    return (account, row[0], row[1])

def read_report(path, group, start, end):
    require(isinstance(path,bytes), "IMMUTABLE_SOURCE_BYTES")
    sheets, formulas, _ = workbook(path, 17)
    require('Combined' in sheets and len(sheets) > 1, 'WORKSHEETS')
    formats, numbers = (cell_formats(path), numeric_cells(path))
    expected = list(HEADERS['classification'])
    expected[15] = group
    title = re.compile(re.escape('Showing performance by ' + group + ' between dates ') + '(\\d{1,2} [A-Z][a-z]{2} \\d{4}) to (\\d{1,2} [A-Z][a-z]{2} \\d{4})')
    entries, totals = ({}, {})
    for sheet, rows in sheets.items():
        headers = [i for i, row in enumerate(rows) if row == expected]
        require(len(headers) == 1, 'HEADER_CURRENCY_GROUP')
        preamble = [v for row in rows[:headers[0]] for v in row if isinstance(v, str)]
        require('Including sold shares' in preamble and (not any(('Excluding sold shares' in v for v in preamble))), 'CLOSED')
        matches = [title.fullmatch(v) for v in preamble if title.fullmatch(v)]
        require(len(matches) == 1, 'TITLE')
        dates = [dt.datetime.strptime(v, '%d %b %Y').date().isoformat() for v in matches[0].groups()]
        require(dates == [start, end], 'DATES')
        for row in rows[headers[0] + 1:]:
            if row[1] not in (None, '') or row[2] not in (None, ''):
                require(row[3] not in (None, ''), 'MISSING_ACCOUNT')
        adapted = [list(r) for r in rows]
        adapted[headers[0]] = list(HEADERS['classification'])
        entries[sheet] = data(adapted, 'classification')
        for n, row in entries[sheet]:
            identity(row)
            require(not any(((n, col) in formulas[sheet] for col in range(1, 18))), 'HOLDING_FORMULA')
        footer = [(i + 1, row) for i, row in enumerate(rows) if row[0] == 'Total']
        require(len(footer) == 1, 'TOTAL_ROW')
        n, total = footer[0]
        for col in (7, 14, 15):
            formula = formulas[sheet].get((n, col))
            if formula is not None:
                require(re.fullmatch('=-?\\d+(?:\\.\\d+)?', formula) is not None, 'TOTAL_FORMULA')
                address = chr(64 + col) + str(n)
                cached, literal = (numbers[sheet].get(address), D(formula[1:]))
                require(cached is None or literal == cached, 'TOTAL_CACHE')
                numbers[sheet][address] = literal
        summed = sum((numbers[sheet]['G' + str(i)] for i, _ in entries[sheet]), D(0))
        reconcile(summed, numbers[sheet]['G' + str(n)], sha256=source_hash(path), group=group, sheet=sheet, column='G', start_date=start, end_date=end)
        totals[sheet] = (n, total)

    def fingerprint(sheet, n, row):
        return (canonical(row), tuple((numbers[sheet].get(chr(65 + i) + str(n)) for i in range(4, 15))), formats[sheet].get('O' + str(n), 'General'))
    require(collections.Counter((fingerprint('Combined', n, r) for n, r in entries['Combined'])) == collections.Counter((fingerprint(s, n, r) for s, rs in entries.items() if s != 'Combined' for n, r in rs)), 'GROUPING_DUPLICATES')
    combined = {identity(row): (n, row) for n, row in entries['Combined']}
    require(len(combined) == len(entries['Combined']), 'DUPLICATE_MEMBER')
    return (entries, totals, combined, numbers, formats)
