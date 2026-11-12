"""Read native TOTAL cells only; individual holding returns are not projected.

Membership identities and asset values prove scope/completeness. They do not
calculate returns. A footer containing excluded benchmarks is withheld whole.
"""
from .strict_totals import reconcile, source_hash
import collections
import datetime as dt
import decimal
import re
from .official_workbooks import HEADERS, workbook, data
from .native_columns import CANON, TITLE_RE, cell_formats, iso, native_percentage, prior_year, require

D = decimal.Decimal
SCHEMA = 'fee-console.ratio-performance-source.v2'


def scope(name, parent=None):
    return dict(type='fund-strategy' if parent else 'portfolio' if name == 'All Together' else 'classification', name=name, parent=parent)


def strategy(row):
    # Same exact first-field rule as the allocation source; not the suffix used
    # for display-name merging. This only identifies a missing aggregate scope.
    for value in (row[1], row[2]):
        if not isinstance(value, str):
            continue
        match = re.search(r'^(.*?)((?:19|20)\d{2}[-/.](?:0?[1-9]|1[0-2])(?:[-–—_:：/\s]|$)|(?:19|20)\d{2}年(?:0?[1-9]|1[0-2])月)', value)
        if match:
            return re.split(r'[-–—_:：/]+', match[1].strip())[0].strip() or '未分类'
    # Legacy names without a date still retain their explicit first field.
    # No fund-brand-to-strategy inference is made.
    if isinstance(row[1], str):
        fields = re.split(r'[-–—_:：/]+', row[1].strip())
        if len(fields) > 1 and not re.fullmatch(r'(?:19|20)\d{2}', fields[0]):
            return fields[0].strip() or '未分类'
    return '未分类'


def parse_aggregates(file, *, period, start_date, end_date, accounts, cash_performance, source, excluded_members=(), group_by='资产类别'):
    # Pure immutable-byte decoder, not an identity/authentication boundary.
    require(isinstance(file, bytes), 'IMMUTABLE_SOURCE_BYTES')
    require(period in ('all', 'oneYear') and iso(start_date) <= iso(end_date), 'PERIOD')
    require(period != 'oneYear' or start_date == prior_year(end_date), 'YEAR_WINDOW')
    require(cash_performance in ('included', 'excluded', 'mixed', 'unknown'), 'CASH_SCOPE')
    require(isinstance(accounts, list) and accounts and len(set(accounts)) == len(accounts), 'ACCOUNT_SCOPE')
    require(group_by in ('资产类别', '小程序收益分类'), 'GROUP_BY')
    expected_header = list(HEADERS['classification'])
    expected_header[15] = group_by
    title_re = re.compile(r'Showing performance by ' + re.escape(group_by) + r' between dates (\d{1,2} [A-Z][a-z]{2} \d{4}) to (\d{1,2} [A-Z][a-z]{2} \d{4})')
    sheets, formulas, xml_rows = workbook(file, 17)
    require('Combined' in sheets and len(sheets) > 1, 'WORKSHEET_SET')
    formats = cell_formats(file)
    parsed, totals = {}, {}
    reconciliations=[];sha=source_hash(file)
    for name, rs in sheets.items():
        headers = [i for i, row in enumerate(rs) if row == expected_header]
        require(len(headers) == 1, 'HEADERS')
        preamble = [v for r in rs[:headers[0]] for v in r if isinstance(v, str)]
        require('Including sold shares' in preamble, 'CLOSED_EVIDENCE_MISSING')
        require(not any('Excluding sold shares' in v for v in preamble), 'CLOSED_EXCLUDED_IN_ORIGINAL')
        titles = [title_re.fullmatch(v) for v in preamble if title_re.fullmatch(v)]
        require(len(titles) == 1, 'TITLE')
        dates = [dt.datetime.strptime(x, '%d %b %Y').date().isoformat() for x in titles[0].groups()]
        require(dates == [start_date, end_date], 'SOURCE_DATES')
        for row in rs[headers[0] + 1:]:
            if row[1] not in (None, '') or row[2] not in (None, ''):
                require(row[3] not in (None, ''), 'MISSING_ACCOUNT')
        # Reuse the row validator after validating the actual custom header.
        # Only an in-memory header adapter changes; original bytes are retained.
        adapted = [list(r) for r in rs]
        adapted[headers[0]] = list(HEADERS['classification'])
        parsed[name] = data(adapted, 'classification')
        for n, row in parsed[name]:
            require(not any((n, col) in formulas[name] for col in (1, 2, 3, 4, 6, 7, 16)), 'MEMBERSHIP_FORMULA')
        footer = [(i + 1, r) for i, r in enumerate(rs) if r[0] == 'Total']
        require(len(footer) == 1, 'TOTAL_ROW')
        n, total = footer[0]
        # Sharesight encodes precomputed total values as numeric-literal formulas.
        # Expressions, cell references and a conflicting cached value are refused.
        for col in (7, 15):
            f = formulas[name].get((n, col))
            if f is not None:
                require(bool(re.fullmatch(r'=-?\d+(?:\.\d+)?', f)), 'TOTAL_FORMULA')
                require(total[col - 1] is not None and D(f[1:]) == D(str(total[col - 1])), 'TOTAL_CACHE')
        amount = sum((D(str(r[6])) for _, r in parsed[name]), D(0))
        require(type(total[6]) in (int, float), 'TOTAL_VALUE')
        reconciliation=reconcile(amount,total[6],sha256=sha,group=group_by,sheet=name,column='G',start_date=start_date,end_date=end_date)
        if reconciliation:reconciliations.append(reconciliation)
        totals[name] = n, total
    # Compare identity, value and classification, not per-holding return columns.
    fingerprint = lambda r: CANON([r[i] for i in (0, 1, 2, 3, 5, 6, 15)])
    require(collections.Counter(fingerprint(r) for _, r in parsed['Combined']) == collections.Counter(fingerprint(r) for s, rs in parsed.items() if s != 'Combined' for _, r in rs), 'GROUPING_DIFFER')
    excluded = set()
    for m in excluded_members:
        require(set(m) == {'account', 'market', 'securityCode'} and all(isinstance(v, str) and v for v in m.values()), 'EXCLUDED_MEMBER')
        excluded.add(CANON(m))
    def member(row):
        account = row[3].replace('&amp;', '&')
        require(account in accounts, 'ACCOUNT_SCOPE')
        if row[0] in (None, '') and row[1] in (None, ''):
            require(row[15] == 'Cash Accounts' and isinstance(row[2], str) and row[2], 'CASH_ROW')
            return dict(account=account, market='CASH', securityCode=row[2])
        require(all(isinstance(v, str) and v for v in row[:3]), 'MEMBER_IDENTITY')
        return dict(account=account, market=row[0], securityCode=row[1])
    all_members = [member(r) for _, r in parsed['Combined']]
    require(len({CANON(m) for m in all_members}) == len(all_members), 'DUPLICATE_MEMBER')
    require(set(m['account'] for m in all_members) == set(accounts), 'ACCOUNT_SCOPE')
    rows, missing, seen = [], [], set()
    for sheet, entries in parsed.items():
        if sheet == 'Combined':
            target = scope('All Together')
        else:
            labels = {r[15] for _, r in entries}
            require(len(labels) == 1, 'GROUP_CLASSIFICATION')
            label = next(iter(labels))
            require(isinstance(label, str) and label, 'GROUP_CLASSIFICATION')
            if group_by == '小程序收益分类' and label.startswith(('常青基金 · ', '对冲基金 · ')):
                parent, strategy_name = label.split(' · ', 1)
                require(bool(strategy_name), 'GROUP_CLASSIFICATION')
                target = scope(strategy_name, parent)
            else:
                target = scope('PE/VC' if label == 'VC/PE' else '二级市场' if group_by == '小程序收益分类' and label == 'Uncategorised' else label)
        key = CANON(target)
        require(key not in seen, 'DUPLICATE_SCOPE')
        seen.add(key)
        members = [member(r) for _, r in entries]
        if any(CANON(m) in excluded for m in members):
            missing.append(dict(scope=target, reason='benchmark-members-included'))
            continue
        if sheet == 'Combined' and cash_performance in ('unknown', 'mixed'):
            missing.append(dict(scope=target, reason='cash-scope-unverified'))
            continue
        n, total = totals[sheet]
        value, unit, _ = native_percentage(total[14], formats[sheet].get('O' + str(n), 'General'))
        rows.append(dict(scope=target, members=members, sourceSheet=sheet, sourceRow=n, returnPct=value, unit=unit, termEvidence=dict(type='unknown')))
    # These UI groups are unions; a sum/average of native percentages is invalid.
    wanted = [scope(n) for n in ('PE/VC', '对冲基金', '常青基金', '二级市场', '股票市场', '现金类', '主题投资')]
    if group_by == '资产类别':
        wanted += [scope(strategy(r), r[15]) for _, r in parsed['Combined'] if r[15] in ('常青基金', '对冲基金')]
    for target in wanted:
        key = CANON(target)
        if key not in seen:
            missing.append(dict(scope=target, reason='native-aggregate-not-provided'))
            seen.add(key)
    report = dict(period=period, startDate=start_date, endDate=end_date, includeClosed=True, calculationMethod='sharesight-native', currency='USD', cashPerformance=cash_performance, source=dict(**source, locator='Official native Total rows'), rows=rows, unavailable=missing)
    return report, dict(period=period, canonicalMembershipRows=len(all_members), nativeAggregateRows=len(rows), blockedOrMissingScopes=len(missing), individualReturnRows=0, groupingDuplicatesMatched=True, nativeTotalsMatched=not reconciliations, nativeMarketValueReconciliations=reconciliations, xmlRows=xml_rows)


def parse_native_aggregate_candidate(blob, **arguments):
    """Explicit untrusted boundary for the migrated native-value parser.

    Caller-provided account/source fields constrain parsing only. They cannot
    establish origin, complete inception evidence, or readiness for publication.
    """
    report, checks = parse_aggregates(blob, **arguments)
    return dict(state='PARSED_NATIVE_AGGREGATE_UNAUTHENTICATED', report=report, checks=checks,
                sourceOriginVerified=False, actualIdentityAndBytesChecked=False,
                fullPerformanceReady=False, publicationReady=False, productionEnabled=False)


