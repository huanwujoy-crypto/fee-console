"""Fixed-query, read-only IB source. No trading or Sharesight mutation API."""
import datetime as dt
import hashlib
import os
import re
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from decimal import Decimal, InvalidOperation

QUERY = '1650083'
BASELINE = '2026-07-31'
MAX_BYTES = 10 * 1024 * 1024

class SourceError(Exception):
    pass

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

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None

def fetch(token, timeout=150):
    require(bool(token) and '\n' not in token, 'missing_token')
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    deadline = time.monotonic() + timeout
    def get(operation, query):
        remaining = deadline - time.monotonic()
        require(remaining > 0, 'deadline')
        url = 'https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/' + operation
        url += '?' + urllib.parse.urlencode({'t': token, 'q': query, 'v': '3'})
        try:
            with opener.open(url, timeout=min(30, remaining)) as response:
                data = response.read(MAX_BYTES + 1)
        except Exception:
            raise SourceError('ib_network_error') from None
        return data, xml(data)
    _, root = get('SendRequest', QUERY)
    ref = root.findtext('ReferenceCode')
    require(root.findtext('Status') == 'Success' and ref and re.fullmatch(r'\d+', ref), 'ib_request_failed')
    for _ in range(20):
        require(time.monotonic() + 6.2 < deadline, 'deadline')
        time.sleep(6.2)
        data, root = get('GetStatement', ref)
        if root.tag == 'FlexQueryResponse':
            return data
        require(root.findtext('ErrorCode') in ('1019', '1009'), 'ib_statement_failed')
    raise SourceError('deadline')

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
        # In-kind and unexplained adjustments require source review, not a guessed cash flow.
        if any(change[k] != 0 for k in ('assetTransfers','internalCashTransfers','paxosTransfers',
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
        'diagnostics':{'navDates':len(retained_nav),'externalFlows':len(events),'unresolvedDates':sorted(unresolved),
                       'unknownTypes':sorted(unknown_types)}}
