"""Daily positions/cash comparison; no provider calls or ledger writers.

The existing job supplies a read-only adapter. It must prove account/portfolio
binding, complete pagination and shared instrument identities. Provider time
is kept separate from the observed read window; missing source time is allowed.
"""
from __future__ import annotations

from copy import deepcopy
from datetime import date, datetime, time, timezone
from decimal import Decimal, InvalidOperation
import hashlib
import json
import re
from zoneinfo import ZoneInfo


SCOPE = "positions_cash_snapshot"
NY = ZoneInfo("America/New_York")


class IBSnapshotError(RuntimeError):
    pass


def _instant(value):
    try:
        if not isinstance(value, str):
            raise ValueError()
        stamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if stamp.tzinfo is None:
            raise ValueError()
        return stamp.astimezone(timezone.utc)
    except (ValueError, TypeError, OverflowError):
        raise IBSnapshotError("IB_SNAPSHOT_ASOF_INVALID") from None


def _number(value):
    # Do not silently replace absent values with zero or round float inputs.
    if isinstance(value, bool) or not isinstance(value, (str, int, Decimal)):
        raise IBSnapshotError("IB_SNAPSHOT_NUMBER_INVALID")
    try:
        number = Decimal(value)
        if not number.is_finite():
            raise InvalidOperation()
        return number
    except (ValueError, InvalidOperation):
        raise IBSnapshotError("IB_SNAPSHOT_NUMBER_INVALID") from None


def _rows(rows, *, cash=False):
    if not isinstance(rows, list):
        raise IBSnapshotError("IB_SNAPSHOT_ROWS_INVALID")
    result = {}
    for row in rows:
        if not isinstance(row, dict):
            raise IBSnapshotError("IB_SNAPSHOT_ROWS_INVALID")
        key = row.get("currency" if cash else "instrument_key")
        if (not isinstance(key, str) or not key or key != key.strip()
                or (cash and re.fullmatch(r"[A-Z]{3}", key) is None)
                or key in result):
            raise IBSnapshotError("IB_SNAPSHOT_IDENTITY_INVALID")
        result[key] = _number(row.get("balance" if cash else "quantity"))
    return result


def _snapshot(value, source):
    if (not isinstance(value, dict) or value.get("source") != source
            or value.get("binding_verified") is not True
            or value.get("instrument_mapping_verified") is not True
            or value.get("positions_complete") is not True
            or value.get("cash_complete") is not True):
        raise IBSnapshotError("IB_SNAPSHOT_INCOMPLETE_OR_UNBOUND")
    as_of = value.get("as_of")
    if as_of is not None and value.get("as_of_basis") != "provider_effective_cutoff":
        raise IBSnapshotError("IB_SNAPSHOT_PROVIDER_TIME_MISLABELLED")
    # The adapter must normalize both books to total trade-date cash, not
    # available funds, buying power, settled cash or a converted base total.
    if value.get("cash_basis") != "total_trade_date":
        raise IBSnapshotError("IB_SNAPSHOT_CASH_BASIS_MISMATCH")
    return (_instant(as_of) if as_of is not None else None, _rows(value.get("positions")),
            _rows(value.get("cash"), cash=True))


def _observed(value, began, ended):
    if not isinstance(value, dict):
        raise IBSnapshotError("IB_SNAPSHOT_ROWS_INVALID")
    value = deepcopy(value)
    # These are observation timestamps, never fabricated provider asOf values.
    value.setdefault("read_started_at", began.isoformat())
    value.setdefault("read_completed_at", ended.isoformat())
    return value


def _fresh(value, target_date, began, ended):
    if value.get("read_kind") != "live":
        raise IBSnapshotError("IB_SNAPSHOT_LIVE_READ_REQUIRED")
    start, finish = _instant(value.get("read_started_at")), _instant(value.get("read_completed_at"))
    if not began <= start <= finish <= ended:
        raise IBSnapshotError("IB_SNAPSHOT_READ_WINDOW_INVALID")
    as_of = _instant(value["as_of"]) if value.get("as_of") is not None else None
    if as_of is not None and as_of > ended:
        raise IBSnapshotError("IB_SNAPSHOT_ASOF_INVALID")
    try:
        target_day = date.fromisoformat(target_date)
        dates = [date.fromisoformat(value["source_date"])] if value.get("source_date") is not None else []
    except (TypeError, ValueError):
        raise IBSnapshotError("IB_SNAPSHOT_TARGET_MISMATCH") from None
    if as_of is not None:
        dates.append(as_of.astimezone(NY).date())
    # A noon-HK recheck can be after New York midnight. A newly read current
    # book may be newer than the target trading day; it must not be older.
    observed_day = ended.astimezone(NY).date()
    if target_day > observed_day or any(day < target_day or day > observed_day for day in dates):
        raise IBSnapshotError("IB_SNAPSHOT_TARGET_MISMATCH")
    return as_of or start


def read_ib_with_fallback(*, cloud_mcp=None, flex=None, mac_mcp=None,
                          target_date, now=None):
    """Try existing read adapters once, in order; no login/refresh or writer.

    Each adapter returns the same complete normalized IB snapshot. A Flex
    report containing only trades/cash is incomplete and cannot win this scan.
    Mac MCP is an optional last reader, not a new cloud-to-Mac service.
    """
    clock = now or (lambda: datetime.now(timezone.utc))
    attempts = []
    for channel, reader in (("cloud_mcp", cloud_mcp), ("flex", flex), ("mac_mcp", mac_mcp)):
        if reader is None:
            attempts.append({"channel": channel, "reason": "READER_NOT_CONNECTED"})
            continue
        try:
            began = clock()
            value = reader()
            ended = clock()
            value = _observed(value, began, ended)
            _snapshot(value, "IB")
            _fresh(value, target_date, began, ended)
        except Exception as exc:
            code = str(exc) if isinstance(exc, IBSnapshotError) else "SOURCE_READ_FAILED"
            attempts.append({"channel": channel, "reason": code})
            continue
        return {**value, "source_channel": channel}, attempts
    error = IBSnapshotError("IB_SNAPSHOT_ALL_SOURCES_UNAVAILABLE")
    error.attempts = attempts
    raise error


def compare_snapshots(source, destination):
    left_at, left_positions, left_cash = _snapshot(source, "IB")
    right_at, right_positions, right_cash = _snapshot(destination, "SHARESIGHT")
    same_cutoff = left_at is not None and left_at == right_at
    def changed(left, right):
        # Absence means zero only after both complete books were validated.
        return sorted(key for key in left.keys() | right.keys()
                      if left.get(key, Decimal(0)) != right.get(key, Decimal(0)))
    positions = changed(left_positions, right_positions)
    currencies = changed(left_cash, right_cash)
    timestamps = {"source_as_of": left_at.isoformat() if left_at is not None else None,
                  "destination_as_of": right_at.isoformat() if right_at is not None else None,
                  "source_read_started_at": source.get("read_started_at"),
                  "source_read_completed_at": source.get("read_completed_at"),
                  "destination_read_started_at": destination.get("read_started_at"),
                  "destination_read_completed_at": destination.get("read_completed_at")}
    canonical = [timestamps, *[
        sorted((key, str(value)) for key, value in rows.items())
        for rows in (left_positions, right_positions, left_cash, right_cash)]]
    return {
        "status": "COMPLETE" if not positions and not currencies else
                  "DIFFERENCE" if same_cutoff else "DIFFERENCE_PENDING_TIMING",
        "completion_scope": SCOPE, "historical_ledger_verified": False,
        "as_of": left_at.isoformat() if same_cutoff else None, **timestamps,
        "timing_basis": "provider_cutoff" if same_cutoff else "observed_read_windows",
        "timing_limitation": None if same_cutoff else "INTERVENING_CHANGES_NOT_EXCLUDED",
        "different_instruments": positions,
        "different_currencies": currencies,
        "snapshot_sha256": hashlib.sha256(json.dumps(canonical).encode()).hexdigest(),
        "financial_mutations": 0, "sharesight_writes": 0,
    }


def _journal_fingerprint(monitor):
    return hashlib.sha256(json.dumps(
        {key: monitor[key] for key in ('events', 'processed_trades')},
        sort_keys=True, separators=(',', ':'), allow_nan=False).encode()).hexdigest()


def _final_success(monitor, target, checked):
    """A same-day final receipt can suppress a second provider read.

    Old trade COMPLETE and provisional observations are deliberately ineligible.
    Any changed economic-event journal invalidates the shortcut.
    """
    receipt = monitor.get('last_snapshot_final_success')
    if not isinstance(receipt, dict):
        return None
    if (receipt.get('target_date') != target or receipt.get('status') != 'COMPLETE'
            or receipt.get('completion_scope') != SCOPE or receipt.get('phase') != 'final'
            or receipt.get('historical_ledger_verified') is not False
            or receipt.get('unresolved_prior_submission') is not False
            or receipt.get('different_instruments') != [] or receipt.get('different_currencies') != []
            or not re.fullmatch(r'[a-f0-9]{64}', str(receipt.get('snapshot_sha256', '')))
            or receipt.get('journal_sha256') != _journal_fingerprint(monitor)):
        return None
    try:
        completed = _instant(receipt.get('checked_at'))
        if completed > checked or any(
            not _instant(receipt.get(prefix + '_read_started_at'))
                <= _instant(receipt.get(prefix + '_read_completed_at')) <= completed
            for prefix in ('source', 'destination')):
            return None
    except IBSnapshotError:
        return None
    if any(row['status'] not in {'VERIFIED', 'DUPLICATE', 'REPORT_ONLY'}
           for key in ('events', 'processed_trades') for row in monitor[key].values()):
        return None
    return receipt


def check_daily_snapshot(store, reader, *, target_date=None, now=None, phase='observation'):
    """Use the existing store/CAS and preserve every event/dedup journal.

    A difference produces a narrow investigation request only. It never falls
    through to the mail-first trade scanner or tries a balancing cash write.
    """
    if not callable(reader):
        raise IBSnapshotError("IB_SNAPSHOT_READER_NOT_CONFIGURED")
    if phase not in {'observation', 'final'}:
        raise IBSnapshotError('IB_SNAPSHOT_PHASE_INVALID')
    state, generation = store.read()
    if not isinstance(state, dict) or not isinstance(state.get("ib_gmail_canary"), dict):
        raise IBSnapshotError("IB_SNAPSHOT_STATE_MISSING")
    state = deepcopy(state)
    monitor = state["ib_gmail_canary"]
    for name in ("events", "processed_trades"):
        if (not isinstance(monitor.get(name), dict)
                or any(not isinstance(row, dict) or row.get("status") not in {
                           'VERIFIED', 'DUPLICATE', 'REPORT_ONLY', 'SUBMITTED', 'UNKNOWN', 'PARTIAL'}
                       for row in monitor[name].values())):
            raise IBSnapshotError("IB_SNAPSHOT_STATE_INVALID")
    clock = now or (lambda: datetime.now(timezone.utc))
    began = clock()
    if not isinstance(began, datetime) or began.tzinfo is None:
        raise IBSnapshotError('IB_SNAPSHOT_ASOF_INVALID')
    requested_day = target_date or began.astimezone(NY).date().isoformat()
    try:
        if date.fromisoformat(requested_day).isoformat() != requested_day:
            raise ValueError()
    except (ValueError, TypeError):
        raise IBSnapshotError('IB_SNAPSHOT_TARGET_MISMATCH') from None
    if phase == 'final':
        completed = _final_success(monitor, requested_day, began)
        if completed is not None:
            return {**completed, 'reason_code': 'IB_DAY_ALREADY_FINALIZED',
                    'skipped_source_reads': True, 'financial_reads': 0,
                    'financial_mutations': 0, 'sharesight_writes': 0,
                    'state_mutations': 0, 'state_generation': generation}
    source, destination = reader()
    checked = clock()
    source, destination = (_observed(value, began, checked) for value in (source, destination))
    result = compare_snapshots(source, destination)
    if not isinstance(checked, datetime) or checked.tzinfo is None:
        raise IBSnapshotError("IB_SNAPSHOT_ASOF_INVALID")
    boundaries = [_fresh(value, requested_day, began, checked) for value in (source, destination)]
    boundary = min(boundaries)
    result.update(target_date=requested_day, checked_at=checked.isoformat(), phase=phase)
    previous = monitor.get("last_snapshot_success_boundary") or monitor.get("last_snapshot_success_as_of")
    if previous is not None and _instant(previous) > boundary:
        raise IBSnapshotError("IB_SNAPSHOT_WATERMARK_REGRESSION")
    # Snapshot equality does not erase or resolve a prior uncertain write.
    result["unresolved_prior_submission"] = any(
        isinstance(row, dict) and row.get("status") in {"SUBMITTED", "UNKNOWN", "PARTIAL"}
        for name in ("events", "processed_trades") for row in monitor[name].values())
    if result['unresolved_prior_submission']:
        result.update(status='ATTENTION', reason_code='IB_UNRESOLVED_PRIOR_SUBMISSION',
                      next_action='REVIEW_UNRESOLVED_SUBMISSION')
    elif result["status"] != "COMPLETE":
        start = (_instant(previous) if previous is not None else
                 datetime.combine(datetime.fromisoformat(requested_day).date(), time.min, NY).astimezone(timezone.utc))
        result["event_window"] = {"from": start.isoformat(), "through": checked.isoformat(),
                                  "inclusive": True}
        result["next_action"] = ("READ_EVENTS_FOR_DIFFERENCES" if result["status"] == "DIFFERENCE"
                                 else "CHECK_INTERVENING_CHANGES_FOR_DIFFERENCES")
    else:
        result["next_action"] = "NONE"
        monitor["last_snapshot_success_boundary"] = boundary.isoformat()
        if result["as_of"] is not None:
            monitor["last_snapshot_success_as_of"] = result["as_of"]
    if phase == 'final' and result['status'] == 'COMPLETE':
        monitor['last_snapshot_final_success'] = {
            **result, 'journal_sha256': _journal_fingerprint(monitor)}
    elif (result['status'] != 'COMPLETE'
          and isinstance(monitor.get('last_snapshot_final_success'), dict)
          and monitor['last_snapshot_final_success'].get('target_date') == requested_day):
        monitor.pop('last_snapshot_final_success', None)
    # Store only comparison metadata; no amounts, account IDs or raw replies.
    record = {key: value for key, value in result.items() if key != "checked_at"}
    if monitor.get("last_snapshot_check") == record:
        return {**result, "state_generation": generation, "state_mutations": 0}
    monitor["last_snapshot_check"] = record
    if phase == 'final':
        monitor['last_trade_recheck_attempt'] = {
            'target_date': requested_day, 'checked_at': checked.isoformat(),
            'status': 'COMPLETE' if result['status'] == 'COMPLETE' else 'ATTENTION',
            'completion_scope': SCOPE, 'snapshot_status': result['status'],
            'reason_code': result.get('reason_code') or (
                None if result['status'] == 'COMPLETE' else 'IB_SNAPSHOT_DIFFERENCE'),
            'different_instrument_count': len(result['different_instruments']),
            'different_currency_count': len(result['different_currencies']),
            'sharesight_writes': 0}
    # One CAS; conflicts/unknown outcomes are surfaced, never blindly retried.
    generation = store.write(state, generation)
    return {**result, "state_generation": generation, "state_mutations": 1}
