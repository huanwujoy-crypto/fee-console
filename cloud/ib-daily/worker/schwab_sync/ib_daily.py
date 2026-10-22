"""IB-only daily comparison. No ledger writer or implicit legacy fallback."""
from copy import deepcopy
from datetime import datetime, timezone
from decimal import Decimal
import hashlib
import json
import re
import uuid
from zoneinfo import ZoneInfo

from .ib_snapshot import (IBSnapshotError, _fresh, _journal_fingerprint, _snapshot,
                          compare_snapshots)
from .ib_cash_client import latest_completed_weekday

HK = ZoneInfo('Asia/Hong_Kong')


class SourceOutcomeUnknown(RuntimeError):
    """A dispatched source execution has no verified terminal receipt yet."""


def schedule_slot(now):
    if now.tzinfo is None:
        raise IBSnapshotError('IB_DAILY_CLOCK_INVALID')
    hk = now.astimezone(HK)
    if hk.weekday() not in range(1, 6) or hk.hour != 12:
        return None
    slot = '1215' if 15 <= hk.minute < 20 else '1230' if 30 <= hk.minute < 35 else None
    if slot is None:
        return None
    return latest_completed_weekday(now).isoformat(), slot


def request_id(target, slot):
    # Stable v4-shaped ID per day/slot; a duplicate cannot obtain a new claim.
    raw = hashlib.sha256(('ib-daily-v1:' + target + ':' + slot).encode()).digest()[:16]
    return str(uuid.UUID(bytes=raw, version=4))


def reason(exc):
    code = str(exc)
    return code if re.fullmatch(r'(IB|SHARESIGHT|STATE)_[A-Z0-9_]{1,100}', code) else 'IB_DAILY_READ_FAILED'


def journal(state):
    monitor = state.get('ib_gmail_canary', {})
    for name in ('events', 'processed_trades'):
        if not isinstance(monitor.get(name), dict):
            raise IBSnapshotError('IB_DAILY_JOURNAL_MISSING')
        if any(not isinstance(r, dict) or r.get('status') not in
               {'VERIFIED', 'DUPLICATE', 'REPORT_ONLY', 'SUBMITTED', 'UNKNOWN', 'PARTIAL'}
               for r in monitor[name].values()):
            raise IBSnapshotError('IB_DAILY_JOURNAL_INVALID')
        if any(r['status'] in {'SUBMITTED', 'UNKNOWN', 'PARTIAL'} for r in monitor[name].values()):
            raise IBSnapshotError('IB_UNRESOLVED_PRIOR_SUBMISSION')
    return _journal_fingerprint(monitor)


def public(result):
    keys = ('status', 'reason_code', 'target_date', 'slot', 'request_id', 'checked_at',
            'completion_scope', 'timing_basis', 'timing_limitation', 'source_read_started_at',
            'source_read_completed_at', 'destination_read_started_at', 'destination_read_completed_at',
            'source_as_of', 'destination_as_of', 'different_instrument_count',
            'different_currency_count', 'comparison_complete', 'notification_required',
            'source_reads_skipped', 'retry_at_1230', 'financial_mutations', 'sharesight_writes')
    return {k: result[k] for k in keys if k in result}


def private_differences(source, destination, compared):
    """Native values in existing private state only; public/logs expose counts."""
    _, lp, lc = _snapshot(source, 'IB')
    _, rp, rc = _snapshot(destination, 'SHARESIGHT')
    def rows(keys, left, right, key_name):
        return [{key_name: key, 'ib': str(left.get(key, Decimal(0))),
                 'sharesight': str(right.get(key, Decimal(0))),
                 'ib_minus_sharesight': str(left.get(key, Decimal(0)) - right.get(key, Decimal(0)))}
                for key in keys]
    return {'positions': rows(compared['different_instruments'], lp, rp, 'instrument_key'),
            'cash': rows(compared['different_currencies'], lc, rc, 'currency'),
            'cash_basis': 'total_trade_date', 'timing_basis': compared['timing_basis'],
            'timing_limitation': compared['timing_limitation']}


class DailyIB:
    def __init__(self, store, reader_factory, *, now=None):
        self.store, self.reader_factory = store, reader_factory
        self.now = now or (lambda: datetime.now(timezone.utc))

    def run(self):
        began = self.now()
        selected = schedule_slot(began)
        if selected is None:
            return {'status': 'SKIPPED', 'reason_code': 'IB_OUTSIDE_DAILY_WINDOW',
                    'source_reads_skipped': True, 'financial_mutations': 0}
        target, slot = selected
        base = {'target_date': target, 'slot': slot, 'request_id': request_id(target, slot),
                'financial_mutations': 0, 'sharesight_writes': 0, 'notification_required': False}
        try:
            state, generation = self.store.read()
            if not isinstance(state, dict):
                raise IBSnapshotError('IB_DAILY_STATE_MISSING')
            fingerprint = journal(state)
            state = deepcopy(state)
            daily = state.setdefault('ib_daily', {'days': {}})
            day = daily['days'].setdefault(target, {'attempts': {}})
            success = day.get('success')
            if success and success.get('journal_sha256') == fingerprint:
                return public({**base, **success, 'status': 'COMPLETE',
                               'reason_code': 'IB_DAY_ALREADY_FINALIZED', 'source_reads_skipped': True, 'notification_required': False})
            completed = day.get('comparison')
            if completed and completed.get('journal_sha256') == fingerprint:
                return public({**base, **completed, 'reason_code': 'IB_DAY_ALREADY_CHECKED',
                               'source_reads_skipped': True, 'notification_required': False})
            attempts = day['attempts']
            if slot in attempts:
                if attempts[slot].get('comparison_complete') is True:
                    return public({**base, 'status': 'ATTENTION', 'source_reads_skipped': True,
                                   'reason_code': 'IB_DAILY_JOURNAL_CHANGED_AFTER_SUCCESS', 'notification_required': slot == '1230'})
                return public({**base, **attempts[slot], 'source_reads_skipped': True,
                               'reason_code': 'IB_DAILY_ATTEMPT_ALREADY_CLAIMED', 'notification_required': False})
            if any(a.get('status') in {'RUNNING', 'SOURCE_OUTCOME_UNKNOWN'} for a in attempts.values()):
                return public({**base, 'status': 'ATTENTION', 'source_reads_skipped': True,
                               'reason_code': 'IB_DAILY_PREVIOUS_OUTCOME_UNKNOWN', 'notification_required': slot == '1230'})
            # Save before constructing any credential-backed provider client.
            attempts[slot] = {**base, 'status': 'RUNNING', 'started_at': began.isoformat()}
            self.store.write(state, generation)
        except Exception as exc:
            # A failed/uncertain CAS never falls through into a source request.
            return public({**base, 'status': 'ATTENTION', 'reason_code': reason(exc),
                           'source_reads_skipped': True, 'notification_required': slot == '1230'})

        result = {**base, 'status': 'ATTENTION', 'source_reads_skipped': False}
        try:
            source, destination = self.reader_factory(target, slot, base['request_id'])()
            checked = self.now()
            boundaries = [_fresh(v, target, began, checked) for v in (source, destination)]
            compared = compare_snapshots(source, destination)
            result.update({k: v for k, v in compared.items()
                           if k not in {'different_instruments', 'different_currencies'}})
            result.update(checked_at=checked.isoformat(),
                          different_instrument_count=len(compared['different_instruments']),
                          different_currency_count=len(compared['different_currencies']),
                          comparison_complete=True, journal_sha256=fingerprint, retry_at_1230=False)
            if compared['status'] == 'COMPLETE':
                result.update(reason_code='IB_POSITIONS_CASH_MATCHED', retry_at_1230=False,
                              journal_sha256=fingerprint, boundary=min(boundaries).isoformat())
            else:
                # First release reports observed differences only. No Flex,
                # event lookup, adjustment or ledger writer is reachable here.
                result.update(reason_code='IB_DIFFERENCE_REQUIRES_REVIEW',
                              notification_required=True,
                              private_differences=private_differences(source, destination, compared))
        except SourceOutcomeUnknown:
            result.update(status='SOURCE_OUTCOME_UNKNOWN', reason_code='IB_SOURCE_EXECUTION_OUTCOME_UNKNOWN', retry_at_1230=False, comparison_complete=False)
        except Exception as exc:
            result.update(status='ATTENTION', reason_code=reason(exc), retry_at_1230=slot == '1215', comparison_complete=False)
        if result['status'] in {'ATTENTION', 'SOURCE_OUTCOME_UNKNOWN'}:
            result['notification_required'] = slot == '1230'
        result.setdefault('checked_at', self.now().isoformat())
        try:
            latest, generation = self.store.read()
            latest = deepcopy(latest)
            day = latest['ib_daily']['days'][target]
            if day['attempts'][slot]['request_id'] != base['request_id'] or day['attempts'][slot]['status'] != 'RUNNING':
                raise IBSnapshotError('IB_DAILY_CLAIM_CHANGED')
            if journal(latest) != fingerprint:
                result.update(status='ATTENTION', reason_code='IB_DAILY_JOURNAL_CHANGED', retry_at_1230=slot == '1215',
                              comparison_complete=False, notification_required=slot == '1230')
            day['attempts'][slot] = result
            if result.get('comparison_complete') is True:
                day['comparison'] = result
            if result['status'] == 'COMPLETE':
                day['success'] = result
                latest['ib_daily']['last_success_boundary'] = result['boundary']
            self.store.write(latest, generation)
        except Exception:
            # No retry of an uncertain state write and no second source call.
            return public({**base, 'status': 'ATTENTION', 'reason_code': 'IB_DAILY_RESULT_SAVE_UNCONFIRMED',
                           'retry_at_1230': False, 'notification_required': slot == '1230'})
        return public(result)
