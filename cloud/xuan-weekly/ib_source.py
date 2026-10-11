"""Fixed-query, read-only IB source. No trading or Sharesight mutation API."""
import datetime as dt
import hashlib
import math
import os
import re
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from decimal import Decimal, InvalidOperation
from network import SourceError, read_get

QUERY = '1650083'
BASELINE = '2026-07-31'
MAX_BYTES = 10 * 1024 * 1024
POLL_LIMIT = 24
POLL_INTERVAL = 6.2
POLLING_CODE = 'ib_statement_not_ready'
# Numeric diagnostics are restricted to the published v3 error-code table.
# This list never grants response acceptance or retry eligibility.
STATEMENT_ERROR_CODES = frozenset([1001] + list(range(1003, 1022)))
FIELD_SHAPES = frozenset({'missing', 'ambiguous', 'nested', 'qualified',
                         'attribute', 'nonleaf', 'noncanonical', 'unrecognized',
                         'known', 'success', 'fail'})


def safe_statement(detail):
    fields = {'operation', 'reason', 'rootKind', 'namespacePresent',
              'statusShape', 'errorCodeShape', 'upstreamErrorCode', 'pollCount'}
    if not isinstance(detail, dict) or set(detail) != fields:
        return None
    if any(type(detail[k]) is not str for k in
           ('operation', 'reason', 'rootKind', 'statusShape', 'errorCodeShape')):
        return None
    operations = {'ib_send_request': {'unexpected_root', 'error_code_present',
                    'status_rejected', 'reference_rejected'},
                  'ib_get_statement': {'unexpected_root', 'reference_present',
                    'status_rejected', 'error_code_rejected'}}
    if detail['operation'] not in operations or detail['reason'] not in operations[detail['operation']]:
        return None
    if detail['rootKind'] not in ('statement_response', 'query_response', 'other'):
        return None
    if type(detail['namespacePresent']) is not bool or type(detail['pollCount']) is not int:
        return None
    if not (detail['pollCount'] == 0 if detail['operation'] == 'ib_send_request'
            else 1 <= detail['pollCount'] <= POLL_LIMIT):
        return None
    if detail['statusShape'] not in FIELD_SHAPES - {'known', 'unrecognized'}:
        return None
    if detail['errorCodeShape'] not in FIELD_SHAPES - {'success', 'fail'}:
        return None
    code = detail['upstreamErrorCode']
    if detail['errorCodeShape'] == 'known':
        if type(code) is not int or code not in STATEMENT_ERROR_CODES:
            return None
    elif code is not None:
        return None
    return dict(detail)


def statement_detail(root, operation, poll_count):
    """Only fixed enums and one canonical known numeric code; no XML text."""
    def local(tag):
        return tag.rsplit('}', 1)[-1] if isinstance(tag, str) else ''
    def field(name):
        nodes = [node for node in root.iter() if local(node.tag) == name]
        attributes = sum(local(key) == name for node in root.iter() for key in node.attrib)
        if len(nodes) + attributes > 1:
            return 'ambiguous', None
        if attributes:
            return 'attribute', None
        if not nodes:
            return 'missing', None
        node = nodes[0]
        if node not in list(root):
            return 'nested', None
        if node.tag != name:
            return 'qualified', None
        if len(node):
            return 'nonleaf', None
        text = node.text
        if name == 'Status':
            return {'Success': 'success', 'Fail': 'fail'}.get(text, 'noncanonical'), None
        if type(text) is not str or len(text) != 4 or re.fullmatch(r'[0-9]{4}', text) is None:
            return 'noncanonical', None
        number = int(text)
        return ('known', number) if number in STATEMENT_ERROR_CODES else ('unrecognized', None)
    status, _ = field('Status')
    code_shape, code = field('ErrorCode')
    if root.tag != 'FlexStatementResponse':
        reason = 'unexpected_root'
    elif operation == 'ib_send_request' and root.findall('ErrorCode'):
        reason = 'error_code_present'
    elif operation == 'ib_get_statement' and root.findall('ReferenceCode'):
        reason = 'reference_present'
    elif leaf_text(root, 'Status') != ('Success' if operation == 'ib_send_request' else 'Fail'):
        reason = 'status_rejected'
    else:
        reason = 'reference_rejected' if operation == 'ib_send_request' else 'error_code_rejected'
    detail = {'operation': operation, 'reason': reason,
              'rootKind': {'FlexStatementResponse': 'statement_response',
                           'FlexQueryResponse': 'query_response'}.get(local(root.tag), 'other'),
              'namespacePresent': isinstance(root.tag, str) and root.tag.startswith('{'),
              'statusShape': status, 'errorCodeShape': code_shape,
              'upstreamErrorCode': code, 'pollCount': poll_count}
    return safe_statement(detail)


class StatementRejected(SourceError):
    def __init__(self, code, statement):
        super().__init__(code)
        self.statement = statement


def require_statement(ok, code, root, operation, poll_count):
    if not ok:
        raise StatementRejected(code, statement_detail(root, operation, poll_count))


def safe_polling(detail):
    """Validate the complete, payload-free statement readiness contract."""
    fields = {'operation', 'state', 'termination', 'lastErrorCode',
              'pollCount', 'pollLimit', 'retryable'}
    if not isinstance(detail, dict) or set(detail) != fields:
        return None
    if any(type(detail[k]) is not str for k in ('operation', 'state', 'termination')):
        return None
    if detail['operation'] != 'ib_get_statement':
        return None
    if any(type(detail[k]) is not int for k in ('lastErrorCode', 'pollCount', 'pollLimit')):
        return None
    states = {1019: 'statement_pending', 1009: 'busy'}
    if detail['lastErrorCode'] not in states or detail['state'] != states[detail['lastErrorCode']]:
        return None
    if detail['pollLimit'] != POLL_LIMIT or not 1 <= detail['pollCount'] <= POLL_LIMIT:
        return None
    if detail['termination'] not in ('poll_limit', 'budget_exhausted'):
        return None
    if detail['termination'] == 'poll_limit' and detail['pollCount'] != POLL_LIMIT:
        return None
    if type(detail['retryable']) is not bool or detail['retryable'] is not True:
        return None
    return dict(detail)


class StatementNotReady(SourceError):
    def __init__(self, polling):
        super().__init__(POLLING_CODE)
        self.polling = polling

def require(ok, code):
    if not ok:
        raise SourceError(code)

def money(value):
    try:
        result = Decimal(value)
    except (InvalidOperation, TypeError, ValueError):
        raise SourceError('invalid_money') from None
    require(result.is_finite() and abs(result) < Decimal('1e12'), 'invalid_money')
    return result

def date(value):
    require(isinstance(value, str) and re.fullmatch(r'\d{4}-\d{2}-\d{2}', value), 'invalid_date')
    try:
        dt.date.fromisoformat(value)
    except ValueError:
        raise SourceError('invalid_date') from None
    return value

def xml(data):
    require(len(data) <= MAX_BYTES and b'<!DOCTYPE' not in data.upper()
            and b'<!ENTITY' not in data.upper(), 'unsafe_xml')
    try:
        root = ET.fromstring(data)
    except ET.ParseError:
        raise SourceError('invalid_xml') from None
    require(sum(1 for _ in root.iter()) < 50000, 'xml_too_large')
    return root

def leaf_text(root, name):
    elements = root.findall(name)
    return elements[0].text if len(elements) == 1 and len(elements[0]) == 0 else None

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None

def fetch(token, timeout=150, *, deadline=None):
    require(bool(token) and '\n' not in token, 'missing_token')
    require(type(timeout) in (int, float) and math.isfinite(timeout) and timeout > 0, 'deadline')
    require(deadline is None or (type(deadline) in (int, float) and math.isfinite(deadline)), 'deadline')
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    own_deadline = time.monotonic() + min(timeout, 150)
    deadline = own_deadline if deadline is None else min(own_deadline, deadline)
    poll_count = 0
    last_code = None
    def exhausted(termination):
        # Only a numeric SendRequest reference followed by an explicit accepted
        # pending response can produce readiness evidence. Generic deadlines stay blocked.
        if last_code is not None:
            raise StatementNotReady({'operation': 'ib_get_statement',
                'state': 'statement_pending' if last_code == 1019 else 'busy',
                'termination': termination, 'lastErrorCode': last_code,
                'pollCount': poll_count, 'pollLimit': POLL_LIMIT, 'retryable': True})
        raise SourceError('deadline')
    def get(operation, query):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            exhausted('budget_exhausted')
        url = 'https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/' + operation
        url += '?' + urllib.parse.urlencode({'t': token, 'q': query, 'v': '3'})
        data = read_get(opener, url, operation='ib_send_request' if operation == 'SendRequest'
                        else 'ib_get_statement', code='ib_network_error', deadline=deadline,
                        max_bytes=MAX_BYTES)
        return data, xml(data)
    _, root = get('SendRequest', QUERY)
    ref = leaf_text(root, 'ReferenceCode')
    require_statement(root.tag == 'FlexStatementResponse' and not root.findall('ErrorCode')
            and leaf_text(root, 'Status') == 'Success' and ref and re.fullmatch(r'\d+', ref),
            'ib_request_failed', root, 'ib_send_request', 0)
    for _ in range(POLL_LIMIT):
        if time.monotonic() + POLL_INTERVAL >= deadline:
            exhausted('budget_exhausted')
        time.sleep(POLL_INTERVAL)
        if time.monotonic() >= deadline:
            exhausted('budget_exhausted')
        data, root = get('GetStatement', ref)
        poll_count += 1
        if root.tag == 'FlexQueryResponse':
            require(time.monotonic() < deadline, 'deadline')
            return data
        code = leaf_text(root, 'ErrorCode')
        require_statement(root.tag == 'FlexStatementResponse' and not root.findall('ReferenceCode')
                and leaf_text(root, 'Status') == 'Fail'
                and code in ('1019', '1009'), 'ib_statement_failed', root, 'ib_get_statement', poll_count)
        last_code = int(code)
        if time.monotonic() >= deadline:
            exhausted('budget_exhausted')
    exhausted('poll_limit')

def normalize(data, account_hash):
    root = xml(data)
    require(root.tag == 'FlexQueryResponse' and root.get('queryName') == 'XUAN_Weekly_NAV_ReadOnly', 'wrong_query')
    statements = root.findall('./FlexStatements/FlexStatement')
    require(bool(statements), 'empty_statements')
    nav, events, changes = {}, {}, {}
    unknown_types, unresolved = set(), set()
    expected_hash = account_hash
    require(bool(re.fullmatch(r'[a-f0-9]{64}', expected_hash or '')), 'missing_account_binding')
    def identity(row, usd=False):
        require(hashlib.sha256(row.get('accountId', '').encode()).hexdigest() == expected_hash, 'wrong_account')
        if usd:
            require(row.get('currency') == 'USD', 'wrong_nav_currency')
    def unique(target, key, value, code):
        require(key not in target or target[key] == value, code)
        target[key] = value
    for statement in statements:
        identity(statement)
        for row in statement.findall('./EquitySummaryInBase/EquitySummaryByReportDateInBase'):
            identity(row, True)
            day, amount = date(row.get('reportDate')), money(row.get('total'))
            require(amount > 0, 'nonpositive_nav')
            unique(nav, day, amount, 'conflicting_nav')
        for row in statement.findall('./ChangeInNAV'):
            identity(row, True)
            day = date(row.get('toDate'))
            require(row.get('fromDate') == day, 'nav_change_not_daily')
            if day < BASELINE:
                continue
            parsed = {k: money(row.get(k)) for k in ('startingValue','endingValue','depositsWithdrawals',
                'assetTransfers','internalCashTransfers','paxosTransfers','excessFundSweep',
                'debitCardActivity','billPay','donations','grantActivity','linkingAdjustments','other')}
            unique(changes, day, parsed, 'conflicting_daily_change')
        for row in statement.findall('./CashTransactions/CashTransaction'):
            identity(row)
            day = date(row.get('reportDate'))
            if day <= BASELINE:
                continue
            kind = row.get('type')
            # Income and costs remain in NAV return; only explicit deposits/withdrawals cross the boundary.
            if kind != 'Deposits/Withdrawals':
                if kind not in ('Broker Interest Received','Broker Interest Paid','Dividends','Payment In Lieu Of Dividends',
                                'Other Fees','Withholding Tax','Advisor Fees','Broker Fees','Bond Interest Received',
                                'Bond Interest Paid','Other Income','Commission Adjustments','Price Adjustments'):
                    unknown_types.add(kind or 'missing'); unresolved.add(day)
                continue
            require(row.get('levelOfDetail') == 'DETAIL', 'cash_not_detail')
            key = row.get('transactionID')
            require(bool(key) and re.fullmatch(r'[A-Za-z0-9_-]+', key), 'missing_cash_id')
            rate = money(row.get('fxRateToBase'))
            require(rate > 0 and (row.get('currency') != 'USD' or rate == 1), 'invalid_fx')
            event = {'date':day, 'usd':money(row.get('amount')) * rate, 'kind':'external'}
            unique(events, key, event, 'conflicting_cash_id')
    require(BASELINE in nav and bool(changes), 'missing_baseline_or_daily_changes')
    dates = sorted(nav)
    cutoff = dates[-1]
    # Exact IB daily cash aggregate must match detailed transactions; allow $1 FX rounding.
    for day in dates:
        if day <= BASELINE:
            continue
        change = changes.get(day)
        if change is None:
            unresolved.add(day); continue
        if abs(change['endingValue'] - nav[day]) > Decimal('0.02'):
            unresolved.add(day)
        total = sum((v['usd'] for v in events.values() if v['date'] == day), Decimal(0))
        if abs(total - change['depositsWithdrawals']) > Decimal('1'):
            unresolved.add(day)
        # Owner-approved IB-only boundary: official daily net in-kind value is
        # external capital too. Do not add transfer-detail rows again.
        if change['assetTransfers'] != 0:
            unique(events, 'asset-transfer-'+day, {'date':day,
                'usd':change['assetTransfers'], 'kind':'external',
                'sourceKind':'asset-transfer-daily-net'}, 'conflicting_asset_transfer')
        # Other unexplained adjustments still require source review.
        if any(change[k] != 0 for k in ('internalCashTransfers','paxosTransfers',
              'excessFundSweep','debitCardActivity','billPay','donations','grantActivity','linkingAdjustments','other')):
            unresolved.add(day)
    for event in events.values():
        if event['date'] not in changes:
            unresolved.add(event['date'])
    retained_nav = [{'date':d, 'usd':float(nav[d])} for d in dates if d >= BASELINE]
    return {'nav':retained_nav, 'flows':[{'id':'ib-'+k, **v, 'usd':float(v['usd'])} for k,v in sorted(events.items())],
        'coverage':{'source':'ib-flex','currency':'USD','from':BASELINE,'to':cutoff,'verified':True,
                    'sha256':hashlib.sha256(data).hexdigest(),'unresolvedDates':sorted(unresolved),
                    'closedDates':[]},
        'diagnostics':{'navDates':len(retained_nav),'externalFlows':len(events),
                       'assetTransferDays':sum(v.get('sourceKind')=='asset-transfer-daily-net' for v in events.values()),
                       'unresolvedDates':sorted(unresolved),
                       'unknownTypes':sorted(unknown_types)}}
