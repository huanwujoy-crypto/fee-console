"""Native Top5 rows only. Combined rows require separate exact expansion."""
import collections, datetime as dt, hashlib, re
from decimal import Decimal
from .official_workbooks import HEADERS, workbook, data
from .native_columns import cell_formats, require, CANON
from .native_cells import numeric_cells
from .strict_totals import reconcile, source_hash
from .combined_top5 import portfolios

def read_native(file, *, group_by, start_date, end_date, accounts, combine_by_holding=False):
    require(isinstance(file, bytes), 'IMMUTABLE_SOURCE_BYTES')
    require(group_by in ('资产类别', '小程序前五收益'), 'TOP5_GROUP')
    require(type(combine_by_holding) is bool and (not combine_by_holding or group_by == '小程序前五收益'), 'TOP5_COMBINED_SCOPE')
    source_bytes = file
    sheets, formulas, _ = workbook(file, 17)
    formats = cell_formats(file)
    numbers = numeric_cells(file)
    require('Combined' in sheets and len(sheets) > 1, 'TOP5_SHEETS')
    header = list(HEADERS['classification'])
    header[15] = group_by
    if combine_by_holding:
        header[3] = 'Portfolios'
    title = re.compile('Showing performance by ' + re.escape(group_by) + ' between dates (\\d{1,2} [A-Z][a-z]{2} \\d{4}) to (\\d{1,2} [A-Z][a-z]{2} \\d{4})')
    parsed, totals = ({}, {})
    for sheet, rs in sheets.items():
        headers = [i for i, r in enumerate(rs) if r == header]
        require(len(headers) == 1, 'TOP5_HEADER')
        preamble = [x for r in rs[:headers[0]] for x in r if isinstance(x, str)]
        require('Including sold shares' in preamble and 'Excluding sold shares' not in preamble, 'TOP5_CLOSED')
        titles = [title.fullmatch(v) for v in preamble if title.fullmatch(v)]
        require(len(titles) == 1, 'TOP5_TITLE')
        require([dt.datetime.strptime(v, '%d %b %Y').date().isoformat() for v in titles[0].groups()] == [start_date, end_date], 'TOP5_DATES')
        adapted = [list(r) for r in rs]
        adapted[headers[0]] = list(HEADERS['classification'])
        parsed[sheet] = data(adapted, 'classification')
        for n, r in parsed[sheet]:
            if combine_by_holding:
                portfolios(r[3].replace('&amp;', '&'), [a.replace('&amp;', '&') for a in accounts])
            else:
                require(r[3].replace('&amp;', '&') in accounts, 'TOP5_ACCOUNT')
            require(not any(((n, c) in formulas[sheet] for c in range(1, 18))), 'TOP5_ROW_FORMULA')
        footer = [(n + 1, r) for n, r in enumerate(rs) if r[0] == 'Total']
        require(len(footer) == 1, 'TOP5_TOTAL')
        n, total = footer[0]
        for col in (7, 15):
            f = formulas[sheet].get((n, col))
            if f is not None:
                require(bool(re.fullmatch('=-?\\d+(?:\\.\\d+)?', f)) and total[col - 1] is not None and (Decimal(f[1:]) == Decimal(str(total[col - 1]))), 'TOP5_TOTAL_FORMULA')
        reconcile(sum((Decimal(str(r[6])) for _, r in parsed[sheet]), Decimal(0)), total[6], sha256=source_hash(file), group=group_by, sheet=sheet, column='G', start_date=start_date, end_date=end_date)
        totals[sheet] = (n, total)
    fingerprint = lambda s, n, r: CANON([r, formats[s].get('O' + str(n), 'General')])
    require(collections.Counter((fingerprint('Combined', n, r) for n, r in parsed['Combined'])) == collections.Counter((fingerprint(s, n, r) for s, rs in parsed.items() if s != 'Combined' for n, r in rs)), 'TOP5_GROUP_COMPLETENESS')
    require(file == source_bytes, 'TOP5_SOURCE_CHANGED')
    return dict(rows=parsed, totals=totals, formats=formats, combineByHolding=combine_by_holding, sourceSha256=hashlib.sha256(source_bytes).hexdigest(), startDate=start_date, endDate=end_date, numbers=numbers)
