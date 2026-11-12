"""Default-disabled ten-workbook and inception binding boundary.

This stages bound native sources, not a complete formal performance projection.
Provider observations and Top5/strategy/stock output associations still require
the current authenticated consumer. No source generation or publication exists.
"""
import datetime as dt
import hashlib
import json
from decimal import Decimal

from .bound_files import read_bound_file, require, strict_json
from .offline_adapter import _convert, _date, _instant
from .official_workbooks import HEADERS, workbook, data
from .native_columns import prior_year
from .native_aggregates import parse_aggregates, strategy
from .native_cells import numeric_cells
from .native_stock import read_report
from .native_top5 import read_native
from .inception_boundary import validate_inception
from .combined_top5 import bind_members

GROUPS = {'assetclass': '资产类别', 'strategy': '小程序收益分类', 'top5': '小程序前五收益', 'stock': '小程序股票市场收益'}
STOCK_CATEGORIES = frozenset({'美国底仓', '美国科技', '非美发达', '新兴市场'})
CAPTURE_FIELDS = {'sha256', 'rangeKind', 'startDate', 'endDate', 'includeClosed', 'combineByHolding', 'currency', 'groupBy',
                  'cashPerformance', 'originalMtimeNs', 'downloadStartedAt', 'downloadCompletedAt', 'observedCompleteAt'}


def _members(rows):
    result = {}
    for number, row in rows:
        account = row[3].replace('&amp;', '&')
        if row[0] in (None, '') and row[1] in (None, ''):
            require(row[15] == 'Cash Accounts', 'CASH_MEMBER')
            key = (account, 'CASH', row[2])
        else:
            require(all(isinstance(value, str) and value for value in row[:3]), 'MEMBER_FIELDS')
            key = (account, row[0], row[1])
        require(key not in result, 'DUPLICATE_MEMBER')
        result[key] = (number, row)
    return result


def _raw_rows(blob, group):
    sheets, _, _ = workbook(blob, 17)
    rows = [list(row) for row in sheets['Combined']]
    header = list(HEADERS['classification'])
    header[15] = group
    indices = [i for i, row in enumerate(rows) if row == header]
    require(len(indices) == 1, 'REPORT_HEADER')
    rows[indices[0]] = list(HEADERS['classification'])
    return data(rows, 'classification')


def _capture(record, blob, *, period, start, target, group, now):
    require(type(record) is dict and set(record) == CAPTURE_FIELDS, 'PERFORMANCE_CAPTURE_FIELDS')
    require(record['sha256'] == hashlib.sha256(blob).hexdigest(), 'PERFORMANCE_CAPTURE_HASH')
    require(record['rangeKind'] == ('since-inception' if period == 'all' else 'trailing-twelve-months')
            and record['startDate'] == start and record['endDate'] == target, 'PERFORMANCE_RANGE')
    require(record['includeClosed'] is True and record['currency'] == 'USD' and record['groupBy'] == group
            and record['cashPerformance'] == 'included', 'PERFORMANCE_CONTROLS')
    # Combined Top5 requires a separate exact expansion proof. Never assume the
    # comma-separated row represents complete members based on this flag alone.
    require(type(record['combineByHolding']) is bool and (record['combineByHolding'] is False or group == GROUPS['top5']), 'COMBINED_HOLDINGS_SCOPE')
    ns = record['originalMtimeNs']
    require(isinstance(ns, str) and len(ns) == 19 and ns.isascii() and ns.isdigit(), 'PERFORMANCE_ORIGINAL_TIME')
    at = dt.datetime(1970, 1, 1, tzinfo=dt.timezone.utc) + dt.timedelta(milliseconds=int(ns) // 1000000)
    started = None if record['downloadStartedAt'] is None else _instant(record['downloadStartedAt'])
    completed = None if record['downloadCompletedAt'] is None else _instant(record['downloadCompletedAt'])
    observed = _instant(record['observedCompleteAt'])
    require((started is None or started <= at) and (completed is None or at <= completed <= observed)
            and at <= observed <= now and dt.timedelta(0) <= now - at <= dt.timedelta(hours=36), 'PERFORMANCE_CAPTURE_AGE')
    require(_date(target) <= (at + dt.timedelta(hours=8)).date()
            and 0 <= ((now + dt.timedelta(hours=8)).date() - _date(target)).days <= 4, 'PERFORMANCE_DATE_AGE')
    return at


def _compare(primary, other, primary_numbers, other_numbers):
    require(set(primary) == set(other), 'CROSS_REPORT_MEMBERS')
    for key, (pn, row) in primary.items():
        on, compared = other[key]
        for col in range(17):
            if col == 15:
                continue
            left = primary_numbers.get(chr(65 + col) + str(pn), row[col]) if 4 <= col <= 14 else row[col]
            right = other_numbers.get(chr(65 + col) + str(on), compared[col]) if 4 <= col <= 14 else compared[col]
            require(left == right, 'CROSS_REPORT_VALUE_DIFFERENCE')


def _run(request, now):
    require(type(request) is dict and set(request) == {'schema', 'targetDate', 'allStartDate', 'bindings', 'inception'}
            and request['schema'] == 'ratio-offline-workbook-batch.v1', 'PERFORMANCE_REQUEST')
    target, start = request['targetDate'], request['allStartDate']
    require(_date(start) <= _date(prior_year(target)), 'PERFORMANCE_ALL_WINDOW')
    bindings = request['bindings']
    require(type(bindings) is dict and set(bindings) == {'allocation', *GROUPS}, 'PERFORMANCE_ROLE_SET')
    require(type(bindings['allocation']) is dict and set(bindings['allocation']) == {'classification', 'exposure', 'capture'}, 'ALLOCATION_ROLE_SET')
    for role in GROUPS:
        require(type(bindings[role]) is dict and set(bindings[role]) == {'all', 'oneYear', 'capture'}, 'PERFORMANCE_PERIOD_SET')
    inception = request['inception']
    require(type(inception) is dict and set(inception) == {'document', 'sources'}
            and isinstance(inception['sources'], list) and 0 < len(inception['sources']) <= 100, 'INCEPTION_BINDINGS')
    specs = [spec for group in bindings.values() for spec in group.values()] + [inception['document'], *inception['sources']]
    require(all(type(spec) is dict for spec in specs), 'BINDING_FIELDS')
    blobs, total_bytes = [], 0
    for spec in specs:
        blob = read_bound_file(spec)
        total_bytes += len(blob)
        require(total_bytes <= 128 * 1024 * 1024, 'BATCH_SIZE')
        blobs.append(blob)
    ids = [spec['libraryFileId'] for spec in specs]
    require(len(ids) == len(set(ids)), 'DUPLICATE_IDENTITY')
    by_id = dict(zip(ids, blobs))
    allocation = _convert(dict(schema='ratio-offline-allocation-bindings.v1', targetDate=target, bindings=bindings['allocation']), now)
    accounts = allocation['original']['accounts']
    captures, reports, raw, numbers, capture_times, top_documents = {}, {}, {}, {}, [], {}
    for role, group_name in GROUPS.items():
        group = bindings[role]
        capture = strict_json(by_id[group['capture']['libraryFileId']])
        require(type(capture) is dict and set(capture) == {'schema', 'accounts', 'reports'}
                and capture['schema'] == 'fee-console.performance-capture.v1' and capture['accounts'] == sorted(accounts)
                and type(capture['reports']) is dict and set(capture['reports']) == {'all', 'oneYear'}, 'PERFORMANCE_CAPTURE_SCOPE')
        captures[role], reports[role], raw[role], numbers[role] = capture, {}, {}, {}
        for period in ('all', 'oneYear'):
            period_start = start if period == 'all' else prior_year(target)
            spec = group[period]
            blob = by_id[spec['libraryFileId']]
            capture_times.append(_capture(capture['reports'][period], blob, period=period, start=period_start, target=target, group=group_name, now=now))
            source = dict(libraryFileId=spec['libraryFileId'], version=spec['libraryVersion'], sha256=spec['sha256'])
            if role in ('assetclass', 'strategy'):
                report, checks = parse_aggregates(blob, period=period, start_date=period_start, end_date=target, accounts=accounts,
                                                 cash_performance='included', source=source, group_by=group_name)
                reports[role][period] = dict(report=report, checks=checks)
            elif role == 'stock':
                entries, totals, _, _, _ = read_report(blob, group_name, period_start, target)
                reports[role][period] = dict(source=source, rows=entries, totals=totals)
            else:
                native = read_native(blob, group_by=group_name, start_date=period_start, end_date=target, accounts=accounts, combine_by_holding=capture['reports'][period]['combineByHolding'])
                top_documents[period] = native
                reports[role][period] = dict(source=source, rows=native['rows'], totals=native['totals'], combineByHolding=native['combineByHolding'])
            if role == 'top5' and capture['reports'][period]['combineByHolding']:
                asset_blob = by_id[bindings['assetclass'][period]['libraryFileId']]
                asset = read_native(asset_blob, group_by=GROUPS['assetclass'], start_date=period_start, end_date=target, accounts=accounts)
                expanded = bind_members(asset, top_documents[period])
                raw[role][period] = _members(expanded['expandedRows']['Combined'])
            else:
                raw[role][period] = _members(_raw_rows(blob, group_name))
            numbers[role][period] = numeric_cells(blob)['Combined']
    for period in ('all', 'oneYear'):
        primary = raw['assetclass'][period]
        for role in ('strategy', 'top5', 'stock'):
            if role == 'top5' and top_documents[period]['combineByHolding']:
                require(set(primary) == set(raw[role][period]), 'CROSS_REPORT_MEMBERS')
                continue
            _compare(primary, raw[role][period], numbers['assetclass'][period], numbers[role][period])
        stock_keys = {key for key, (_, row) in primary.items() if row[15] in STOCK_CATEGORIES}
        require(stock_keys, 'STOCK_MEMBERS_EMPTY')
        require(not {(key[1], key[2]) for key in stock_keys}.intersection({(key[1], key[2]) for key in primary if key not in stock_keys}), 'STOCK_CATEGORY_CONFLICT')
        for key, (_, row) in primary.items():
            stock_label = '股票市场' if key in stock_keys else 'Cash Accounts' if row[15] == 'Cash Accounts' else 'Uncategorised'
            require(raw['stock'][period][key][1][15] == stock_label, 'STOCK_GROUP_MEMBERS')
            strategy_label = ('PE/VC' if row[15] in ('VC/PE', 'PE/VC') else row[15] + ' · ' + strategy(row)
                              if row[15] in ('常青基金', '对冲基金') else 'Cash Accounts' if row[15] == 'Cash Accounts' else 'Uncategorised')
            require(raw['strategy'][period][key][1][15] == strategy_label, 'STRATEGY_GROUP_MEMBERS')
        stock_groups = reports['stock'][period]['rows']
        require(sum(set(_members(rows)) == stock_keys for name, rows in stock_groups.items() if name != 'Combined') == 1, 'STOCK_SUBTOTAL_MISSING')
    required = set(raw['assetclass']['all'])
    require(set(raw['assetclass']['oneYear']) <= required, 'ALL_PERIOD_MEMBER_COVERAGE')
    positions = allocation['original']['classification']['positions']
    current = {(p['account'], p['market'], p['securityCode']) for p in positions}
    current |= {(p['account'], 'CASH', p['name']) for p in allocation['original']['classification']['cashAccounts']}
    require(current <= required, 'CURRENT_MEMBER_COVERAGE')
    evidence = strict_json(by_id[inception['document']['libraryFileId']])
    require(type(evidence) is dict and isinstance(evidence.get('sources'), list), 'INCEPTION_DOCUMENT')
    source_specs = {spec['libraryFileId']: spec for spec in inception['sources']}
    evidence_ids = [ref.get('libraryFileId') for ref in evidence['sources'] if type(ref) is dict]
    require(len(evidence_ids) == len(evidence['sources']) and len(evidence_ids) == len(set(evidence_ids))
            and set(evidence_ids) == set(source_specs), 'INCEPTION_SOURCE_SET')
    for reference in evidence['sources']:
        spec = source_specs[reference['libraryFileId']]
        require(reference.get('version') == spec['libraryVersion'] and type(reference.get('version')) is int
                and reference.get('sha256') == spec['sha256'], 'INCEPTION_SOURCE_PIN')
    members = [dict(account=key[0], market=key[1], securityCode=key[2]) for key in sorted(required)]
    checked = validate_inception(evidence, accounts=accounts, as_of=target, classification_positions=positions, required_members=members, now=now)
    require(all(_date(member['startDate']) >= _date(start) for member in evidence['members']), 'INCEPTION_BEFORE_ALL_WINDOW')
    for spec, before in zip(specs, blobs):
        require(read_bound_file(spec) == before, 'SOURCE_CHANGED')
    return dict(state='OFFLINE_WORKBOOK_BATCH_BOUND_CANDIDATE', allocation=allocation['original'], nativeReports=reports,
                inceptionEvidence=evidence, inceptionChecks=checked, performanceCapturedAt=min(capture_times).isoformat(timespec='milliseconds').replace('+00:00', 'Z'),
                workbookCount=10, captureCount=5, actualIdentityAndBytesChecked=True, nativeMemberSetsBound=True,
                sourceOriginVerified=False, fullPerformanceReady=False, publicationReady=False, productionEnabled=False,
                blockedOn=['PROVIDER_OBSERVATION_AUTHENTICATION', 'COMPLETE_NATIVE_REPORT_ASSEMBLY', 'CURRENT_FORMAL_PROJECTION', 'REFRESH_DATE_POLICY'],
                uploads=0, publications=0)


def prepare_offline_workbook_batch(request, *, enabled=False):
    if enabled is False:
        return dict(state='DISABLED', publicationReady=False, productionEnabled=False)
    require(enabled is True and type(request) is dict, 'ENABLE_BOOLEAN')
    frozen = strict_json(json.dumps(request, ensure_ascii=False, allow_nan=False))
    return _run(frozen, dt.datetime.now(dt.timezone.utc))
