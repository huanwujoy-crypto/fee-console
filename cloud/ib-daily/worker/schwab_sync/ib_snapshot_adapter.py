"""Normalize the existing IbReadSession capture for the IB-only recheck entry.

Credential admission/account association and complete-response validation are
provided by the existing protected controller; this module grants none of them.
"""
from decimal import Decimal, InvalidOperation
import re

from .ib_snapshot import IBSnapshotError, _instant, read_ib_with_fallback


def _decimal_text(value):
    if isinstance(value, bool) or not isinstance(value, (int, float, str, Decimal)):
        raise IBSnapshotError('IB_SNAPSHOT_NUMBER_INVALID')
    try:
        number = Decimal(str(value))
        if not number.is_finite():
            raise InvalidOperation()
        return str(number)
    except (ValueError, InvalidOperation):
        raise IBSnapshotError('IB_SNAPSHOT_NUMBER_INVALID') from None


def normalize_mcp_capture(capture, *, validate_capture, resolve_instrument):
    if not isinstance(capture, dict) or capture.get('source') != 'IB_MCP':
        raise IBSnapshotError('IB_SNAPSHOT_SOURCE_SHAPE_INVALID')
    # Validation must examine original responses using the existing approved
    # association and tool contract. No new approved=True request flag exists.
    proof = validate_capture(capture)
    if (not isinstance(proof, dict) or proof.get('binding_verified') is not True
            or proof.get('positions_complete') is not True or proof.get('cash_complete') is not True
            or proof.get('cash_basis') != 'total_trade_date'):
        raise IBSnapshotError('IB_SNAPSHOT_INCOMPLETE_OR_UNBOUND')
    records = capture.get('sources')
    if (not isinstance(records, list) or len(records) != 2
            or [r.get('sourceKey') for r in records if isinstance(r, dict)]
            != ['ib.positions', 'ib.balances']):
        raise IBSnapshotError('IB_SNAPSHOT_SOURCE_SHAPE_INVALID')
    began, ended = _instant(capture.get('startedAt')), _instant(capture.get('completedAt'))
    raw = {}
    for record in records:
        body = record.get('raw')
        if not isinstance(body, dict):
            raise IBSnapshotError('IB_SNAPSHOT_SOURCE_SHAPE_INVALID')
        if any(body.get(key) for key in ('nextPageToken', 'next_page_token', 'next_cursor', 'has_more', 'truncated')):
            raise IBSnapshotError('IB_SNAPSHOT_PAGINATION_INCOMPLETE')
        if not began <= _instant(record.get('startedAt')) <= _instant(record.get('completedAt')) <= ended:
            raise IBSnapshotError('IB_SNAPSHOT_READ_WINDOW_INVALID')
        raw[record['sourceKey']] = body
    positions, balances = raw['ib.positions'].get('positions'), raw['ib.balances'].get('balances')
    if not isinstance(positions, list) or not isinstance(balances, list):
        raise IBSnapshotError('IB_SNAPSHOT_ROWS_INVALID')
    holdings, seen = [], set()
    for row in positions:
        if not isinstance(row, dict):
            raise IBSnapshotError('IB_SNAPSHOT_ROWS_INVALID')
        contract = row.get('contract_id')
        currency = row.get('currency')
        if (isinstance(contract, bool) or not isinstance(contract, (int, str))
                or re.fullmatch(r'[1-9][0-9]{0,17}', str(contract)) is None
                or not isinstance(currency, str) or re.fullmatch(r'[A-Z]{3}', currency) is None):
            raise IBSnapshotError('IB_SNAPSHOT_IDENTITY_INVALID')
        # This resolver uses existing verified contract/venue identities; never
        # guess a Sharesight instrument from contract_description or ticker.
        key = resolve_instrument(str(contract), currency)
        if not isinstance(key, str) or not key or key in seen:
            raise IBSnapshotError('IB_SNAPSHOT_IDENTITY_INVALID')
        seen.add(key)
        holdings.append({'instrument_key': key, 'quantity': _decimal_text(row.get('position'))})
    cash, seen = [], set()
    for row in balances:
        if not isinstance(row, dict):
            raise IBSnapshotError('IB_SNAPSHOT_ROWS_INVALID')
        currency = row.get('currency')
        if not isinstance(currency, str) or currency in seen:
            raise IBSnapshotError('IB_SNAPSHOT_IDENTITY_INVALID')
        seen.add(currency)
        if currency == 'BASE':
            continue  # Aggregate is not another currency account.
        if re.fullmatch(r'[A-Z]{3}', currency) is None:
            raise IBSnapshotError('IB_SNAPSHOT_IDENTITY_INVALID')
        # Existing intraday_report.mjs uses these exact provider field names.
        # settled_cash and buying power cannot replace cash_balance.
        cash.append({'currency': currency, 'balance': _decimal_text(row.get('cash_balance'))})
    return {'source': 'IB', 'read_kind': 'live', 'binding_verified': True,
            'instrument_mapping_verified': True, 'positions_complete': True, 'cash_complete': True,
            'positions': holdings, 'cash': cash, 'cash_basis': 'total_trade_date',
            'as_of': proof.get('provider_as_of'),
            'as_of_basis': 'provider_effective_cutoff' if proof.get('provider_as_of') is not None else None,
            'source_date': proof.get('source_date'),
            'read_started_at': began.isoformat(), 'read_completed_at': ended.isoformat()}


def make_snapshot_reader(*, cloud_capture, sharesight_snapshot, validate_capture,
                         resolve_instrument, target_date, flex=None, mac_capture=None, now=None):
    """Return the callable consumed by the existing IB recheck reader hook.

    The protected runner supplies actual connected callbacks. No subprocess,
    endpoint, Secret, persisted input or credentials are inferred here.
    """
    def adapted(capture):
        return None if capture is None else lambda: normalize_mcp_capture(
            capture(), validate_capture=validate_capture, resolve_instrument=resolve_instrument)
    def read():
        source, attempts = read_ib_with_fallback(cloud_mcp=adapted(cloud_capture), flex=flex,
                                        mac_mcp=adapted(mac_capture), target_date=target_date, now=now)
        source['fallback_attempts'] = attempts
        return source, sharesight_snapshot()
    return read
