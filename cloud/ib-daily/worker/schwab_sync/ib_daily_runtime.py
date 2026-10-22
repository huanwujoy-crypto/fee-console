"""Lazy production wiring for the existing private IB route, disabled by default."""
from datetime import datetime, timezone
from decimal import Decimal
import json
import logging
import os
from pathlib import Path
import re

from .ib_daily import DailyIB, schedule_slot
from .ib_daily_source import CloudSource, require
from .ib_snapshot import IBSnapshotError


def rows(payload, key):
    # Existing API envelope; do not invent required positive completeness flags.
    require(isinstance(payload, dict) and isinstance(payload.get(key), list), 'IB_DAILY_SS_ROWS_INVALID')
    values = payload[key]
    require(all(isinstance(r, dict) for r in values), 'IB_DAILY_SS_ROWS_INVALID')
    for node in (payload, payload.get('meta', {}), payload.get('pagination', {}), payload.get('links', {})):
        require(isinstance(node, dict), 'IB_DAILY_SS_PAGING_INVALID')
        require(not any(node.get(k) for k in ('next', 'next_page', 'nextPage', 'next_cursor', 'has_more', 'nextPageToken')), 'IB_DAILY_SS_MORE_PAGES')
        for k in ('total', 'total_count'):
            require(k not in node or type(node[k]) is int and node[k] == len(values), 'IB_DAILY_SS_MORE_PAGES')
    return values


def number(value):
    require(not isinstance(value, bool) and isinstance(value, (str, int, float, Decimal)), 'IB_DAILY_SS_NUMBER_INVALID')
    number = Decimal(str(value))
    require(number.is_finite(), 'IB_DAILY_SS_NUMBER_INVALID')
    return number


def destination(client, config, now):
    began = now()
    from .clients import IB_PORTFOLIO_ID
    holdings = rows(client.holdings(), 'holdings')  # includes portfolio identity GET
    known = {r['instrument_id']: r for r in config['identities']}
    positions, holding_ids, instruments = [], set(), set()
    for row in holdings:
        instrument = row.get('instrument', {})
        key = str(instrument.get('id', ''))
        binding = known.get(key)
        require(binding is not None and str(row.get('id', '')).isdigit()
                and str(row['id']) not in holding_ids and key not in instruments
                and instrument.get('code') == binding['code']
                and instrument.get('market_code') == binding['venue']
                and instrument.get('currency_code') == binding['currency'], 'IB_DAILY_SECURITY_IDENTITY_PENDING')
        holding_ids.add(str(row['id'])); instruments.add(key)
        positions.append({'instrument_key': 'instrument:' + key, 'quantity': str(number(row.get('quantity')))})
    totals, seen = {}, set()
    for row in rows(client.cash_accounts(), 'cash_accounts'):
        currency, identifier = row.get('currency'), str(row.get('id', ''))
        require(identifier.isdigit() and identifier not in seen and str(row.get('portfolio_id')) == str(IB_PORTFOLIO_ID)
                and isinstance(currency, str) and re.fullmatch('[A-Z]{3}', currency) is not None, 'IB_DAILY_CASH_BINDING_INVALID')
        seen.add(identifier)
        totals[currency] = totals.get(currency, Decimal(0)) + number(row.get('balance'))
    require(bool(totals), 'IB_DAILY_SS_CASH_MISSING')
    return {'source': 'SHARESIGHT', 'read_kind': 'live', 'binding_verified': True,
            'instrument_mapping_verified': True, 'positions_complete': True, 'cash_complete': True,
            'cash_basis': 'total_trade_date', 'positions': positions,
            'cash': [{'currency': k, 'balance': str(v)} for k, v in sorted(totals.items())],
            'as_of': None, 'as_of_basis': None, 'read_started_at': began.isoformat(),
            'read_completed_at': now().isoformat()}


def daily_store(bucket):
    """Same existing object/schema/CAS, with no hidden SDK write retries."""
    from .storage import GCSStateStore, StateConflict
    class DailyStore(GCSStateStore):
        def read(self):
            blob = self.blob
            try:
                blob.reload(retry=None, timeout=10)
            except Exception as exc:
                if exc.__class__.__name__ == 'NotFound':
                    return None, 0
                raise
            generation = int(blob.generation)
            value = json.loads(blob.download_as_text(encoding='utf-8',
                if_generation_match=generation, retry=None, timeout=10))
            require(isinstance(value, dict), 'IB_DAILY_STATE_INVALID')
            return value, generation

        def write(self, value, generation):
            blob = self.blob
            try:
                blob.upload_from_string(json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False),
                    content_type='application/json', if_generation_match=generation, retry=None, timeout=10)
            except Exception as exc:
                if exc.__class__.__name__ == 'PreconditionFailed':
                    raise StateConflict('STATE_GENERATION_CONFLICT') from None
                raise
            # The mutation response owns this generation; no unpinned reload.
            require(str(blob.generation).isdigit(), 'IB_DAILY_STATE_WRITE_UNCONFIRMED')
            return int(blob.generation)
    return DailyStore(bucket)


def load_config(path=None):
    path = path or Path(__file__).with_name('ib_daily_bindings.json')
    value = json.loads(Path(path).read_text())
    value['source_image'] = os.environ.get('IB_DAILY_SOURCE_IMAGE', value.get('source_image'))
    require(value.get('schema') == 1 and value.get('identity_pending') == [], 'IB_DAILY_SECURITY_IDENTITY_PENDING')
    require(re.fullmatch(r'.+@family-portfolio-gateway\.iam\.gserviceaccount\.com', value.get('source_service_account', '')) is not None
            and re.fullmatch(r'asia-east2-docker\.pkg\.dev/family-portfolio-gateway/.+@sha256:[a-f0-9]{64}', value.get('source_image', '')) is not None
            and re.fullmatch(r'[a-f0-9]{40}', value.get('association_policy_blob', '')) is not None
            and isinstance(value.get('client_id'), str) and bool(value['client_id']), 'IB_DAILY_DEPLOYMENT_BINDINGS_MISSING')
    identities = value.get('identities')
    require(isinstance(identities, list) and bool(identities), 'IB_DAILY_IDENTITIES_INVALID')
    for field in ('contract_id', 'instrument_id'):
        require(all(isinstance(r, dict) and re.fullmatch('[1-9][0-9]*', r.get(field, '')) for r in identities)
                and len({r[field] for r in identities}) == len(identities), 'IB_DAILY_IDENTITIES_INVALID')
    for r in identities:
        require(re.fullmatch('[A-Z]{3}', r.get('currency', '')) is not None
                and all(isinstance(r.get(k), str) and bool(r[k]) for k in ('code', 'venue')), 'IB_DAILY_IDENTITIES_INVALID')
    return value


def configured_runner():
    config = load_config()  # Missing mapping/deploy data stops before SDK/client construction.
    from .clients import FixedIBSharesightClient
    clock = lambda: datetime.now(timezone.utc)
    store = daily_store(os.environ.get('SCHWAB_STATE_BUCKET', ''))
    def factory(target, slot, request_id):
        def read():
            source = CloudSource(config, now=clock).capture(target, slot, request_id)
            return source, destination(FixedIBSharesightClient(), config, clock)
        return read
    return DailyIB(store, factory, now=clock)


def install_daily(namespace):
    mode = os.environ.get('IB_DAILY_MODE', 'off')
    require(mode in {'off', 'readonly'}, 'IB_DAILY_MODE_INVALID')
    if mode == 'off':
        return
    def run():
        try:
            result = configured_runner().run()
        except Exception as exc:
            from .ib_daily import reason
            result = {'status': 'ATTENTION', 'reason_code': reason(exc), 'source_reads_skipped': True,
                      'financial_mutations': 0, 'sharesight_writes': 0,
                      'notification_required': (schedule_slot(datetime.now(timezone.utc)) or (None, None))[1] == '1230'}
        if result.get('notification_required') is True:
            logging.getLogger('schwab_sync').warning(json.dumps({'event_type': 'IB_TRADE_RECHECK_ATTENTION', **result}, sort_keys=True))
        # Business failure returns data/HTTP 200. Only the existing 12:30 slot
        # may retry; Scheduler HTTP delivery retries cannot add source attempts.
        return result
    namespace['_ib_daily_run'] = run
