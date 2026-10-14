"""Independent start clock. No financial reader, writer, or publisher."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import re
from zoneinfo import ZoneInfo

REPO = 'huanwujoy-crypto/fee-console'
WORKFLOW = 'fee-cloud-producer.yml'
WORKFLOW_ID = 365873934
JOB = 'produce'
SCHEMA = 'fee-console.clock-intent.v1'
ACTIVE = ('queued', 'in_progress', 'waiting', 'pending', 'requested')
STATUSES = set(ACTIVE) | {'completed'}


class ClockError(Exception):
    def __init__(self, code):
        self.code = 'FEE_CLOCK_' + code
        super().__init__(self.code)


def fail(code):
    raise ClockError(code)


def stamp(value):
    return value.astimezone(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')


def timestamp(value):
    if not isinstance(value, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z', value):
        fail('METADATA_INVALID')
    try:
        return datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError:
        fail('METADATA_INVALID')


def target_date(now):
    # Match the original fee-cloud-source.mjs contract. This is a weekday
    # boundary, NOT a new holiday calendar or evidence of a complete close.
    ny = now.astimezone(ZoneInfo('America/New_York'))
    day = ny.date()
    if ny.hour * 60 + ny.minute < 16 * 60 + 15:
        day -= timedelta(days=1)
    while day.weekday() >= 5:
        day -= timedelta(days=1)
    return day.isoformat()


def plan(mode, now):
    if mode not in ('launch', 'check-start'):
        fail('MODE')
    if not isinstance(now, datetime) or now.tzinfo is None:
        fail('CLOCK')
    hk = now.astimezone(ZoneInfo('Asia/Hong_Kong'))
    result = {'slotDate': hk.date().isoformat(), 'targetDate': target_date(now)}
    if hk.weekday() not in (1, 2, 3, 4, 5):
        return {**result, 'action': False}
    minute = hk.hour * 60 + hk.minute
    start = 600 if mode == 'launch' else 605
    if not start <= minute < start + 5:
        fail('OUTSIDE_WINDOW')
    midnight = hk.replace(hour=0, minute=0, second=0, microsecond=0)
    return {**result, 'action': True, 'from': stamp(midnight),
            'to': stamp(midnight + timedelta(days=1) - timedelta(seconds=1))}


def complete_list(payload, key):
    if (not isinstance(payload, dict) or type(payload.get('total_count')) is not int
            or not isinstance(payload.get(key), list)
            or payload['total_count'] != len(payload[key])
            or payload['total_count'] > 100):
        fail('LIST_INCOMPLETE')
    return payload[key]


def validate_runs(payload, now, expected_status=None):
    runs = complete_list(payload, 'workflow_runs')
    ids = set()
    for row in runs:
        if (not isinstance(row, dict) or type(row.get('id')) is not int or row['id'] <= 0
                or row['id'] in ids or row.get('workflow_id') != WORKFLOW_ID
                or row.get('repository', {}).get('full_name') != REPO
                or row.get('head_branch') != 'main'
                or row.get('status') not in STATUSES
                or not isinstance(row.get('event'), str)
                or (expected_status and row['status'] != expected_status)):
            fail('METADATA_INVALID')
        ids.add(row['id'])
        if timestamp(row.get('created_at')) > now:
            fail('METADATA_INVALID')
    return runs


def inspect_runs(github, selected, current_time):
    created = selected['from'] + '..' + selected['to']
    day = validate_runs(github.runs(created=created), current_time())
    low, high = timestamp(selected['from']), timestamp(selected['to'])
    if any(not low <= timestamp(row['created_at']) <= high for row in day):
        fail('METADATA_INVALID')
    # Full status-filtered lists include a previous-day run still occupying the
    # original concurrency group. Do not assume the newest 100 lifetime runs
    # constitute a complete list of unfinished runs.
    with ThreadPoolExecutor(max_workers=len(ACTIVE)) as pool:
        results = list(pool.map(lambda status: (status, github.runs(status=status)), ACTIVE))
    busy = []
    for status, payload in results:
        busy.extend(validate_runs(payload, current_time(), status))
    expected = [row for row in day if row['event'] in ('schedule', 'workflow_dispatch')]
    return expected, busy


def valid_intent(value, selected):
    keys = {'schema', 'repository', 'workflow', 'ref', 'slotDate', 'targetDate', 'createdAt', 'mainSha'}
    if (not isinstance(value, dict) or set(value) != keys or value['schema'] != SCHEMA
            or value['repository'] != REPO or value['workflow'] != WORKFLOW
            or value['ref'] != 'main' or value['slotDate'] != selected['slotDate']
            or value['targetDate'] != selected['targetDate']
            or not re.fullmatch(r'[0-9a-f]{40}', value.get('mainSha', ''))):
        fail('INTENT_INVALID')
    timestamp(value['createdAt'])
    return value


def started_job(payload, run, selected, now):
    rows = complete_list(payload, 'jobs')
    matches = [row for row in rows if row.get('name') == JOB]
    if len(matches) > 1:
        fail('METADATA_INVALID')
    if not matches:
        return None
    row = matches[0]
    if (row.get('run_id') != run['id'] or row.get('status') not in ('queued', 'in_progress', 'completed')
            or type(row.get('id')) is not int or row['id'] <= 0):
        fail('METADATA_INVALID')
    if row['status'] == 'completed' and row.get('conclusion') not in (
            'success', 'failure', 'neutral', 'cancelled', 'skipped', 'timed_out', 'action_required', 'startup_failure', 'stale'):
        fail('METADATA_INVALID')
    # run_started_at can be populated while a job is queued or waiting for an
    # environment. Require the actual produce job, not workflow status alone.
    if row['status'] == 'queued' or row.get('conclusion') == 'skipped' or not row.get('started_at'):
        return None
    started = timestamp(row['started_at'])
    if started < timestamp(run['created_at']) or started > now:
        fail('METADATA_INVALID')
    if target_date(started) != selected['targetDate']:
        return None
    return {'runId': run['id'], 'jobId': row['id'], 'startedAt': stamp(started),
            'conclusion': row.get('conclusion')}


def run_clock(mode, now, github, store, enabled=False, current_time=None):
    if enabled is not True:
        return {'event': 'FEE_CLOCK', 'outcome': 'disabled'}
    selected = plan(mode, now)
    current_time = current_time or (lambda: now)
    safe = {key: selected[key] for key in ('slotDate', 'targetDate')}
    if not selected['action']:
        return {'event': 'FEE_CLOCK', 'outcome': 'outside-schedule', **safe}
    metadata = github.workflow()
    if (metadata.get('id') != WORKFLOW_ID or metadata.get('path') != '.github/workflows/' + WORKFLOW
            or metadata.get('state') != 'active'):
        fail('WORKFLOW_NOT_ACTIVE')
    runs, busy = inspect_runs(github, selected, current_time)
    if mode == 'check-start':
        with ThreadPoolExecutor(max_workers=8) as pool:
            evidence = list(pool.map(lambda row: started_job(github.jobs(row['id']), row, selected, current_time()), runs))
        actual = [row for row in evidence if row is not None]
        if actual:
            if any(row['conclusion'] in ('failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure') for row in actual):
                fail('PRODUCER_FAILED_AFTER_START')
            return {'event': 'FEE_CLOCK', 'outcome': 'started', **safe, 'starts': actual,
                    'publicationVerified': False}
        if runs:
            fail('REQUESTED_NOT_STARTED')
        intent = store.read_intent(selected['targetDate'])
        if intent is not None:
            valid_intent(intent, selected)
            fail('DISPATCH_NOT_OBSERVED')
        fail('NOT_REQUESTED')
    if runs:
        return {'event': 'FEE_CLOCK', 'outcome': 'already-requested', **safe,
                'runIds': sorted(row['id'] for row in runs)}
    if busy:
        fail('PRODUCER_BUSY')
    main = github.main()
    if not re.fullmatch(r'[0-9a-f]{40}', main.get('object', {}).get('sha', '')):
        fail('METADATA_INVALID')
    def still_in_slot():
        latest = plan(mode, current_time())
        if not latest['action'] or any(latest[key] != selected[key] for key in ('slotDate', 'targetDate')):
            fail('OUTSIDE_WINDOW')
    still_in_slot()
    intent = {'schema': SCHEMA, 'repository': REPO, 'workflow': WORKFLOW, 'ref': 'main',
              **safe, 'createdAt': stamp(now), 'mainSha': main['object']['sha']}
    # One immutable claim per independently calculated target. A crash or an
    # uncertain POST leaves this claim intact; subsequent invocations never
    # resend. This is an at-most-one cloud-clock attempt, not exactly-once GH.
    if not store.claim(intent):
        valid_intent(store.read_intent(selected['targetDate']), selected)
        return {'event': 'FEE_CLOCK', 'outcome': 'intent-already-exists', **safe}
    # Narrow the natural-cron race after acquiring the cloud claim. GitHub may
    # still race after this GET; its original concurrency/preflight remain.
    runs, busy = inspect_runs(github, selected, current_time)
    if runs or busy:
        store.result({**intent, 'outcome': 'natural-request-visible'})
        return {'event': 'FEE_CLOCK', 'outcome': 'natural-request-visible', **safe}
    still_in_slot()
    dispatched = github.dispatch()  # Fixed main, sole input false; no retry.
    store.result({**intent, 'outcome': 'dispatch-accepted', 'runId': dispatched})
    return {'event': 'FEE_CLOCK', 'outcome': 'dispatch-accepted', **safe, 'runId': dispatched,
            'publicationVerified': False}
