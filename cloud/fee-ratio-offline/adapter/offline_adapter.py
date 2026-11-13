"""Default-disabled, allocation-only offline conversion. No publication path.

This module is a local candidate, not a production collector. Complete native
performance/inception-v2 binding and formal source authentication remain absent.
Those cannot be replaced by a successful allocation conversion.
"""
import datetime as dt
from decimal import Decimal
import hashlib
import json
import re

from .bound_files import read_bound_file, require, strict_json
from .official_workbooks import validate

# Existing repository scope constant, not request/profile supplied. No account
# names or real source values are bundled. Confirm against final integration HEAD.
ALL_TOGETHER_SCOPE_SHA256 = '25d1c346d1be590d75d906435e2fec752f851dbfc231c07dd279b5e12adc11c6'
SCHEMA = 'ratio-offline-allocation-bindings.v1'
MAX_AGE = dt.timedelta(hours=36)


def _instant(value):
    require(isinstance(value, str) and re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z', value), 'CAPTURE_TIME')
    return dt.datetime.fromisoformat(value.replace('Z', '+00:00'))


def _date(value):
    require(isinstance(value, str) and re.fullmatch(r'\d{4}-\d{2}-\d{2}', value), 'DATE')
    result = dt.date.fromisoformat(value)
    require(result.isoformat() == value, 'DATE')
    return result


def _scope(accounts):
    return hashlib.sha256(json.dumps(accounts, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()


def _money(value):
    require(type(value) in (int, float), 'MONEY')
    number = Decimal(str(value))
    require(number.is_finite() and abs(number) <= Decimal('1e12') and number * 100 == (number * 100).to_integral_value(), 'MONEY')
    return value


def _convert(request, now):
    require(type(request) is dict and set(request) == {'schema', 'targetDate', 'bindings'} and request['schema'] == SCHEMA, 'REQUEST_SCHEMA')
    target = _date(request['targetDate'])
    bindings = request['bindings']
    require(type(bindings) is dict and set(bindings) == {'classification', 'exposure', 'capture'}, 'SOURCE_SET')
    blobs = {role: read_bound_file(spec) for role, spec in bindings.items()}
    require(len({s['libraryFileId'] for s in bindings.values()}) == 3, 'DUPLICATE_IDENTITY')
    capture = strict_json(blobs['capture'])
    require(type(capture) is dict and set(capture) == {'classification', 'exposure'}, 'CAPTURE_FIELDS')
    parsed, metadata, accounts = {}, {}, None
    for role in ('classification', 'exposure'):
        rows, actual_accounts, checked = validate(blobs[role], role)
        require(_scope(actual_accounts) == ALL_TOGETHER_SCOPE_SHA256, 'ACCOUNT_SCOPE')
        require(accounts is None or accounts == actual_accounts, 'ACCOUNT_SCOPE')
        accounts = actual_accounts
        record = capture[role]
        require(type(record) is dict and set(record) == {'sha256', 'originalMtimeNs', 'capturedAt', 'downloadCompletedAt'}, 'CAPTURE_FIELDS')
        require(record['sha256'] == bindings[role]['sha256'], 'CAPTURE_HASH')
        at = _instant(record['capturedAt'])
        completed = None if record['downloadCompletedAt'] is None else _instant(record['downloadCompletedAt'])
        require(type(record['originalMtimeNs']) is int and record['originalMtimeNs'] > 0, 'ORIGINAL_MTIME')
        epoch = dt.datetime(1970, 1, 1, tzinfo=dt.timezone.utc)
        delta = at - epoch
        milliseconds = (delta.days * 86400 + delta.seconds) * 1000 + delta.microseconds // 1000
        require(record['originalMtimeNs'] // 1000000 == milliseconds, 'ORIGINAL_MTIME')
        require(dt.timedelta(0) <= now - at <= MAX_AGE and (completed is None or at <= completed <= now), 'CAPTURE_AGE')
        as_of = _date(checked['as_of'])
        require(as_of <= (at + dt.timedelta(hours=8)).date(), 'SOURCE_FUTURE_DATE')
        require(0 <= ((now + dt.timedelta(hours=8)).date() - as_of).days <= 4, 'SOURCE_DATE_AGE')
        require(as_of == target if role == 'classification' else as_of >= target, 'SOURCE_DATE')
        parsed[role] = rows
        metadata[role] = dict(asOf=checked['as_of'], capturedAt=record['capturedAt'], captureTimeBasis='original-download-file-mtime',
                              downloadCompletedAt=record['downloadCompletedAt'], serverSuggestedOriginalFilename=None,
                              dateEvidence=checked['date_basis'], canonicalDataRows=checked['canonical_data_rows'], allWorksheetXmlRows=checked['raw_xml_rows_all_sheets'])
    positions, cash, exposure, members = [], [], [], set()
    for number, row in parsed['classification']:
        base = dict(sourceRow=number, account=row[3].replace('&amp;', '&'), name=row[2], valueUSD=_money(row[6]), sharesightCategory=row[15])
        require(isinstance(base['name'], str) and bool(base['name']) and isinstance(base['sharesightCategory'], str) and bool(base['sharesightCategory']), 'CLASSIFICATION_ROW')
        if row[1] in (None, ''):
            require(row[0] in (None, '') and row[15] == 'Cash Accounts', 'CASH_SHAPE')
            key = (base['account'], 'CASH', base['name'])
            cash.append(base)
        else:
            require(all(isinstance(x, str) and x for x in row[:3]) and type(row[5]) in (int, float) and Decimal(str(row[5])).is_finite(), 'POSITION_SHAPE')
            key = (base['account'], row[0], row[1])
            base.update(securityCode=row[1], market=row[0], quantity=row[5])
            positions.append(base)
        require(key not in members, 'DUPLICATE_MEMBER')
        members.add(key)
    for number, row in parsed['exposure']:
        require(isinstance(row[2], str) and row[2], 'EXPOSURE_ROW')
        ownership = row[5] or 'Cash'
        require(ownership in ('Direct', 'Underlying', 'Residual', 'Cash'), 'EXPOSURE_OWNERSHIP')
        require(row[6] is None or type(row[6]) in (int, float) and Decimal(str(row[6])).is_finite(), 'EXPOSURE_PERCENTAGE')
        exposure.append(dict(sourceRow=number, account=row[4].replace('&amp;', '&'), securityCode=row[1] or None, market=row[0] or None,
                             name=row[2], withinETF=row[3] or None, ownership=ownership, valueUSD=_money(row[7]), sourcePercentage=row[6]))
    original = dict(schemaVersion='sharesight-private-full-v2', source=dict(provider='Sharesight', view='All Together', transport='official-workbook-exports'),
                    accounts=accounts, sources=[dict(file=name, **{k: bindings[role][k] for k in ('sha256', 'libraryFileId', 'libraryVersion')})
                    for role, name in [('classification', 'classification.xlsx'), ('exposure', 'exposure.xlsx'), ('capture', 'capture-metadata.json')]],
                    classification=dict(**metadata['classification'], positions=positions, cashAccounts=cash), exposure=dict(**metadata['exposure'], rows=exposure),
                    coverage=dict(classificationCombinedComplete=True, exposureCombinedComplete=True, groupingSheetsAreDuplicates=True,
                                  closedPositionsIncluded=False, transactionHistoryIncluded=False, completeETFUniverseClaimed=False),
                    limitations=['Offline allocation candidate only; no complete performance or inception evidence.',
                                 'Report dates and native values are preserved. Source origin is not authenticated by this adapter.',
                                 'Grouping sheets duplicate Combined and are checked, not double counted.'])
    # Re-read the genuine bindings; parsers used frozen immutable bytes, not
    # mutable file paths. Any before/after byte or identity change refuses output.
    for role, spec in bindings.items():
        require(read_bound_file(spec) == blobs[role], 'SOURCE_CHANGED')
    return dict(state='OFFLINE_ALLOCATION_CANDIDATE', original=original, sourceOriginVerified=False, actualIdentityAndBytesChecked=True,
                fullPerformanceReady=False, publicationReady=False, productionEnabled=False,
                blockedOn=['COMPLETE_PERFORMANCE_AND_INCEPTION_BINDING', 'CURRENT_FORMAL_SOURCE_AUTHENTICATION', 'REFRESH_DATE_POLICY'],
                uploads=0, publications=0)


def prepare_offline_allocation(request, *, enabled=False):
    """The only candidate IO entry. No injected clock, scope, or verifier.

    Synthetic tests patch private dependencies within their own test process.
    There is no production test mode, identity override or environment switch.
    """
    if enabled is False:
        return dict(state='DISABLED', publicationReady=False, productionEnabled=False)
    require(enabled is True, 'ENABLE_BOOLEAN')
    require(type(request) is dict, 'REQUEST_SCHEMA')
    frozen = strict_json(json.dumps(request, ensure_ascii=False, allow_nan=False))
    return _convert(frozen, dt.datetime.now(dt.timezone.utc))
