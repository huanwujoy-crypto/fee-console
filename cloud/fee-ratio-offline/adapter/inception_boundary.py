"""Pure v2 declaration validation, not source authentication or publication approval.

No IO, clock reads, runtime verification hook, or freshness policy. Archived source
capture times are preserved. Callers must separately bind actual bytes/identities
and validate the complete performance artifact's freshness and scope.
"""
import datetime as dt
import math
import re

SCHEMA = 'fee-console.ratio-inception-source.v2'
MAX_ITEMS = 10000
IDENTITY = {'account', 'market', 'securityCode'}
KINDS = {'verified-historical-archive', 'browser-first-recorded-buy'}


def _require(ok, code):
    if not ok:
        raise ValueError('INCEPTION_' + code)


def _exact(obj, fields):
    return type(obj) is dict and set(obj) == set(fields)


def _text(value):
    return (type(value) is str and 0 < len(value) <= 500
            and not any(ord(c) < 32 or ord(c) == 127 for c in value))


def _array(value, *, empty=False):
    return type(value) is list and (0 if empty else 1) <= len(value) <= MAX_ITEMS


def _date(value):
    _require(type(value) is str and re.fullmatch(r'[0-9]{4}-[0-9]{2}-[0-9]{2}', value), 'DATE')
    try:
        parsed = dt.date.fromisoformat(value)
    except ValueError:
        raise ValueError('INCEPTION_DATE') from None
    _require(parsed.isoformat() == value, 'DATE')
    return parsed


def _instant(value):
    _require(type(value) is str and re.fullmatch(r'[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z', value), 'TIMESTAMP')
    try:
        return dt.datetime.fromisoformat(value[:-1] + '+00:00')
    except ValueError:
        raise ValueError('INCEPTION_TIMESTAMP') from None


def _key(row, accounts):
    _require(type(row) is dict and IDENTITY <= set(row), 'MEMBER')
    _require(all(_text(row[k]) for k in IDENTITY), 'MEMBER_TEXT')
    _require(row['account'] in accounts, 'ACCOUNT')
    return tuple(row[k] for k in ('account', 'market', 'securityCode'))


def _positive(value):
    if type(value) not in (int, float):
        return False
    try:
        return math.isfinite(value) and value > 0
    except OverflowError:
        return False


def validate_inception(evidence, *, accounts, as_of, classification_positions,
                       required_members, now):
    """Validate declarations, returning a deidentified, explicitly untrusted receipt.

    required_members is a nonempty list of exact three-field identity dictionaries.
    This candidate deliberately requires exact coverage, rejecting extra members.
    now is an aware datetime or canonical UTC millisecond timestamp. No current
    time is inferred and historical archives are not given an invented expiry.
    """
    as_day = _date(as_of)
    if type(now) is str:
        clock = _instant(now)
    else:
        _require(isinstance(now, dt.datetime) and now.tzinfo is not None and now.utcoffset() is not None, 'CLOCK')
        clock = now
    _require(_array(accounts) and all(_text(a) for a in accounts), 'ACCOUNTS')
    _require(len(set(accounts)) == len(accounts), 'DUPLICATE_ACCOUNT')
    account_set = set(accounts)
    _require(_array(required_members), 'REQUIRED_MEMBERS')
    required = set()
    for row in required_members:
        _require(_exact(row, IDENTITY), 'REQUIRED_MEMBER')
        key = _key(row, account_set)
        _require(key not in required, 'DUPLICATE_REQUIRED_MEMBER')
        required.add(key)
    _require(_array(classification_positions, empty=True), 'CLASSIFICATION')
    positions = {}
    for row in classification_positions:
        key = _key(row, account_set)
        _require(key not in positions, 'DUPLICATE_CLASSIFICATION_MEMBER')
        positions[key] = row
    _require(_exact(evidence, {'schema', 'capturedAt', 'includeClosed', 'sources', 'members', 'sourceCaptures'}), 'SCHEMA_FIELDS')
    _require(evidence['schema'] == SCHEMA and evidence['includeClosed'] is True, 'SCHEMA')
    root_capture = _instant(evidence['capturedAt'])
    _require(_array(evidence['sources']), 'SOURCES')
    sources = {}
    for ref in evidence['sources']:
        _require(_exact(ref, {'libraryFileId', 'version', 'sha256', 'locator'}), 'SOURCE_REF')
        _require(type(ref['libraryFileId']) is str and re.fullmatch(r'libfile_[a-f0-9]{32}', ref['libraryFileId']), 'SOURCE_ID')
        _require(type(ref['version']) is int and 0 <= ref['version'] <= 9007199254740991, 'SOURCE_VERSION')
        _require(type(ref['sha256']) is str and re.fullmatch(r'[a-f0-9]{64}', ref['sha256']), 'SOURCE_HASH')
        _require(_text(ref['locator']), 'SOURCE_LOCATOR')
        _require(ref['libraryFileId'] not in sources, 'DUPLICATE_SOURCE')
        sources[ref['libraryFileId']] = ref
    _require(_array(evidence['sourceCaptures']) and len(evidence['sourceCaptures']) == len(sources), 'CAPTURES')
    captures = {}
    for capture in evidence['sourceCaptures']:
        _require(_exact(capture, {'libraryFileId', 'capturedAt', 'sourceKind'}), 'CAPTURE_FIELDS')
        ident = capture['libraryFileId']
        _require(type(ident) is str and ident in sources and ident not in captures, 'CAPTURE_SOURCE')
        _require(type(capture['sourceKind']) is str and capture['sourceKind'] in KINDS, 'SOURCE_KIND')
        stamp = _instant(capture['capturedAt'])
        _require(stamp <= clock, 'FUTURE_CAPTURE')
        captures[ident] = (capture, stamp)
    _require(root_capture == max(stamp for _, stamp in captures.values()), 'ROOT_CAPTURE')
    _require(_array(evidence['members']), 'MEMBERS')
    seen, used = set(), set()
    browser_count = 0
    for member in evidence['members']:
        _require(type(member) is dict, 'MEMBER')
        browser = member.get('dateKind') == 'browser-first-recorded-buy'
        fields = IDENTITY | {'startDate', 'dateKind', 'sourceFileId', 'sourceLocator'}
        _require(_exact(member, fields | ({'browserEvidence'} if browser else set())), 'MEMBER_FIELDS')
        key = _key(member, account_set)
        _require(key not in seen, 'DUPLICATE_MEMBER')
        seen.add(key)
        ident = member['sourceFileId']
        _require(type(ident) is str and ident in sources and _text(member['sourceLocator']), 'MEMBER_SOURCE')
        capture, stamp = captures[ident]
        _require(capture['sourceKind'] == ('browser-first-recorded-buy' if browser else 'verified-historical-archive'), 'SOURCE_KIND_LINK')
        start = _date(member['startDate'])
        _require(start <= as_day, 'START_AFTER_AS_OF')
        cash = member['market'].strip().upper() == 'CASH'
        if browser:
            browser_count += 1
            # Avoid datetime overflow at the upper representable year boundary.
            try:
                capture_day = (stamp + dt.timedelta(hours=8)).date()
            except OverflowError:
                raise ValueError('INCEPTION_CAPTURE_DAY') from None
            proof = member['browserEvidence']
            _require(not cash and start <= capture_day, 'BROWSER_DATE')
            _require(_exact(proof, {'view', 'complete', 'records', 'currentQuantity'}), 'BROWSER_FIELDS')
            _require(proof['view'] == 'All trades & adjustments' and proof['complete'] is True, 'BROWSER_COMPLETE')
            _require(_positive(proof['currentQuantity']), 'BROWSER_QUANTITY')
            _require(type(proof['records']) is list and len(proof['records']) == 1, 'BROWSER_RECORDS')
            record = proof['records'][0]
            _require(_exact(record, {'type', 'status', 'date', 'quantity'}), 'RECORD_FIELDS')
            _require(record['type'] == 'Buy' and record['status'] == 'Confirmed' and record['date'] == member['startDate'], 'RECORD')
            _require(_positive(record['quantity']) and record['quantity'] == proof['currentQuantity'], 'RECORD_QUANTITY')
            row = positions.get(key)
            _require(row is not None and _positive(row.get('quantity')) and row['quantity'] == proof['currentQuantity'], 'CURRENT_QUANTITY')
        else:
            allowed = {'cash-opening-balance', 'cash-first-transaction'} if cash else {'holding-inception'}
            _require(type(member['dateKind']) is str and member['dateKind'] in allowed, 'DATE_KIND')
        used.add(ident)
    _require(seen == required, 'EXACT_REQUIRED_MEMBERS')
    _require(used == set(sources), 'UNUSED_SOURCE')
    return {
        'state': 'INCEPTION_DECLARATIONS_VALIDATED', 'schema': SCHEMA,
        'capturedAt': evidence['capturedAt'],
        'sourceCaptureTimes': sorted(c['capturedAt'] for c, _ in captures.values()),
        'memberCount': len(seen), 'sourceCount': len(sources),
        'browserMemberCount': browser_count, 'exactRequiredMembership': True,
        'sourceOriginVerified': False, 'actualIdentityAndBytesChecked': False,
        'publicationReady': False,
    }
