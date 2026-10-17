"""Public benchmark orchestration. It never fetches quotes or writes prices."""
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, time, timedelta
import json
import math
from pathlib import Path
import re
from zoneinfo import ZoneInfo

from clock import ACTIVE, REPO, fail, stamp, timestamp, validate_runs

WORKFLOW = 'benchmark-cache.yml'
WORKFLOW_ID = 338411790
SCHEMA = 'fee-console.benchmark-intent.v1'
NY = ZoneInfo('America/New_York')
HK = ZoneInfo('Asia/Hong_Kong')
FAILURES = {'failure', 'timed_out', 'startup_failure'}
SOURCE = 'Yahoo Finance chart API; Nasdaq official quote and historical close cross-check; issuer/Nasdaq dividend evidence'


def calendar():
    try:
        value = json.loads(Path(__file__).with_name('benchmark-calendar.json').read_text())
        assert value['schema'] == 'fee-console.us-equity-sessions.v1'
        assert value['timeZone'] == 'America/New_York'
        assert set(value['markets']) == {'NYSEArca', 'NasdaqGS'}
        beginning, end = date.fromisoformat(value['validFrom']), date.fromisoformat(value['validThrough'])
        assert beginning.isoformat() == value['validFrom'] and end.isoformat() == value['validThrough']
        assert timedelta(0) <= end - beginning <= timedelta(days=366 * 3)
        for market in value['markets'].values():
            assert market['regularCloseMinutes'] == 960
            assert len(set(market['closedDates'])) == len(market['closedDates'])
            for day in [*market['closedDates'], *market['earlyCloses']]:
                assert date.fromisoformat(day).isoformat() == day
                assert value['validFrom'] <= day <= value['validThrough']
            assert all(close == 780 for close in market['earlyCloses'].values())
            assert not set(market['earlyCloses']) & set(market['closedDates'])
        return value
    except Exception:
        fail('BENCHMARK_CALENDAR_UNAVAILABLE')


def close_minutes(day, market, reviewed):
    if not reviewed['validFrom'] <= day.isoformat() <= reviewed['validThrough']:
        fail('BENCHMARK_CALENDAR_UNAVAILABLE')
    row = reviewed['markets'][market]
    if day.weekday() >= 5 or day.isoformat() in row['closedDates']:
        return None
    return row['earlyCloses'].get(day.isoformat(), row['regularCloseMinutes'])


def session(now, reviewed=None):
    if not isinstance(now, datetime) or now.tzinfo is None:
        fail('CLOCK')
    reviewed = reviewed or calendar()
    ny = now.astimezone(NY)
    day = ny.date()
    for _ in range(10):
        closes = [close_minutes(day, market, reviewed) for market in ('NYSEArca', 'NasdaqGS')]
        if (closes[0] is None) != (closes[1] is None):
            fail('BENCHMARK_CALENDAR_CONFLICT')
        if closes[0] is not None:
            completed = datetime.combine(day, time(), NY) + timedelta(minutes=max(closes) + 15)
            if completed <= now:
                # The approved acquisition target stays NY18:00 on early-close
                # dates too; eligibility uses the reviewed actual session close.
                return {'targetDate': day.isoformat(), 'eligibleAt': completed,
                        'primaryAt': datetime.combine(day, time(18), NY)}
        day -= timedelta(days=1)
    fail('BENCHMARK_SESSION_UNAVAILABLE')


def cache_state(payload, selected):
    if not isinstance(payload, dict) or not re.fullmatch(r'[a-f0-9]{64}', payload.get('sha256', '')):
        fail('BENCHMARK_CACHE_INVALID')
    cache = payload.get('cache', {})
    if type(cache.get('v')) is not int or cache['v'] != 1 or cache.get('source') != SOURCE:
        fail('BENCHMARK_CACHE_INVALID')
    reviewed = calendar()
    missing = []
    for key, symbol, market in [('spy', 'SPY', 'NYSEArca'), ('qqq', 'QQQ', 'NasdaqGS')]:
        row = cache.get('benchmarks', {}).get(key, {})
        if (row.get('symbol') != symbol or row.get('currency') != 'USD'
                or row.get('exchange') != market or not isinstance(row.get('series'), list)):
            fail('BENCHMARK_CACHE_INVALID')
        dates = []
        for point in row['series']:
            if (not isinstance(point, dict) or set(point) - {'d', 'p', 'div'}
                    or type(point.get('p')) not in (int, float) or not math.isfinite(point['p']) or point['p'] <= 0
                    or not isinstance(point.get('d'), str)):
                fail('BENCHMARK_CACHE_INVALID')
            try:
                assert date.fromisoformat(point['d']).isoformat() == point['d']
            except Exception:
                fail('BENCHMARK_CACHE_INVALID')
            if close_minutes(date.fromisoformat(point['d']), market, reviewed) is None:
                fail('BENCHMARK_CACHE_INVALID')
            if 'div' in point and (type(point['div']) not in (int, float)
                    or not math.isfinite(point['div']) or point['div'] <= 0):
                fail('BENCHMARK_CACHE_INVALID')
            dates.append(point['d'])
        if dates != sorted(set(dates)) or any(day > selected['targetDate'] for day in dates):
            fail('BENCHMARK_CACHE_INVALID')
        expected = []
        if dates:
            day, end = date.fromisoformat(dates[0]), date.fromisoformat(dates[-1])
            while day <= end:
                if close_minutes(day, market, reviewed) is not None:
                    expected.append(day.isoformat())
                day += timedelta(days=1)
        if not dates or dates[-1] != selected['targetDate'] or dates != expected:
            missing.append(symbol)
    return {'benchmarkReady': not missing, 'missingSymbols': missing, 'cacheSha256': payload['sha256']}


def inspect(github, selected, current_time):
    hk = current_time().astimezone(HK).replace(hour=0, minute=0, second=0, microsecond=0)
    created = stamp(hk) + '..' + stamp(hk + timedelta(days=1) - timedelta(seconds=1))
    payload = github.runs(created=created)
    day = validate_runs(payload, current_time(), workflow_id=WORKFLOW_ID)
    day = [row for row in day if timestamp(row['created_at']) >= selected['eligibleAt']]
    with ThreadPoolExecutor(max_workers=len(ACTIVE)) as pool:
        active = list(pool.map(lambda status: (status, github.runs(status=status)), ACTIVE))
    busy = []
    for status, payload in active:
        busy.extend(validate_runs(payload, current_time(), status, workflow_id=WORKFLOW_ID))
    return day, busy


def intent_valid(value, target, attempt):
    required = {'schema', 'repository', 'workflow', 'ref', 'targetDate', 'attempt', 'createdAt', 'mainSha'}
    if (not isinstance(value, dict) or set(value) != required or value['schema'] != SCHEMA
            or value['repository'] != REPO or value['workflow'] != WORKFLOW or value['ref'] != 'main'
            or value['targetDate'] != target or value['attempt'] != attempt
            or not re.fullmatch(r'[a-f0-9]{40}', value.get('mainSha', ''))):
        fail('BENCHMARK_INTENT_INVALID')
    timestamp(value['createdAt'])
    return value


def run_identity(row, now):
    validate_runs({'total_count': 1, 'workflow_runs': [row]}, now, workflow_id=WORKFLOW_ID)
    return row


def previous_run(github, store, intent, day, now):
    result = store.read_benchmark_result(intent['targetDate'], intent['attempt'])
    if result is not None:
        if (not isinstance(result, dict) or set(result) != set(intent) | {'outcome', 'runId'}
                or any(result.get(key) != value for key, value in intent.items())
                or result['outcome'] not in ('dispatch-accepted', 'verified-cache-race', 'natural-request-visible')
                or (result['runId'] is not None and (type(result['runId']) is not int or result['runId'] <= 0))
                or (result['outcome'] != 'dispatch-accepted' and result['runId'] is not None)):
            fail('BENCHMARK_RESULT_INVALID')
        if result['runId'] is not None:
            # The immutable dispatch response is stronger identity than the
            # main SHA sampled before POST; main may move between those reads.
            row = run_identity(github.run(result['runId']), now)
            if (row['id'] != result['runId'] or row['event'] != 'workflow_dispatch'
                    or timestamp(row['created_at']) < timestamp(intent['createdAt'])):
                fail('BENCHMARK_RESULT_INVALID')
            return row
    matches = [row for row in day if row.get('event') == 'workflow_dispatch'
               and row.get('head_sha') == intent['mainSha']
               and timestamp(row['created_at']) >= timestamp(intent['createdAt'])]
    return matches[0] if len(matches) == 1 else None


def monitor(github, selected, current_time, row):
    row = run_identity(row, current_time())
    if row['status'] == 'completed':
        if row.get('conclusion') == 'success':
            fail('BENCHMARK_SUCCESS_WITHOUT_TARGET')
        if row.get('conclusion') not in FAILURES:
            fail('BENCHMARK_RUN_NOT_COMPLETED')
        return row
    jobs = github.jobs(row['id'])
    now = current_time()
    if jobs.get('total_count') != len(jobs.get('jobs', [])) or jobs.get('total_count', 101) > 100:
        fail('LIST_INCOMPLETE')
    matches = [job for job in jobs['jobs'] if job.get('name') == 'refresh']
    if len(matches) > 1:
        fail('METADATA_INVALID')
    if matches and (type(matches[0].get('id')) is not int or matches[0]['id'] <= 0
            or matches[0].get('run_id') != row['id']
            or matches[0].get('status') not in ('queued', 'in_progress', 'completed')):
        fail('METADATA_INVALID')
    if matches and matches[0]['status'] == 'completed' and matches[0].get('conclusion') not in (
            'success', 'failure', 'neutral', 'cancelled', 'skipped', 'timed_out', 'action_required', 'startup_failure', 'stale'):
        fail('METADATA_INVALID')
    started = (matches and matches[0]['status'] != 'queued' and matches[0].get('started_at')
               and matches[0].get('conclusion') != 'skipped')
    if started:
        began = timestamp(matches[0]['started_at'])
        if not timestamp(row['created_at']) <= began <= now:
            fail('METADATA_INVALID')
    elif now - timestamp(row['created_at']) >= timedelta(minutes=5):
        fail('BENCHMARK_REQUESTED_NOT_STARTED')
    return row


def follow(github, selected, safe, state, run_id, created_at, main, failures,
           current_time, wait, *, second=False, pending='dispatch-accepted-pending'):
    deadline = current_time() + timedelta(seconds=360)
    while wait is not None and current_time() < deadline:
        if run_id is None:
            day, _ = inspect(github, selected, current_time)
            matches = [row for row in day if row.get('event') == 'workflow_dispatch'
                       and row.get('head_sha') == main and timestamp(row['created_at']) >= timestamp(created_at)]
            if len(matches) > 1:
                fail('BENCHMARK_DISPATCH_UNRESOLVED')
            row = matches[0] if matches else None
            run_id = row['id'] if row else None
        else:
            row = run_identity(github.run(run_id), current_time())
            if row['id'] != run_id:
                fail('METADATA_INVALID')
        if row:
            if row.get('status') == 'completed' and row.get('conclusion') == 'success':
                final = cache_state(github.cache(), selected)
                if not final['benchmarkReady']:
                    fail('BENCHMARK_SUCCESS_WITHOUT_TARGET')
                return {**safe, **final, 'outcome': 'verified-target-complete', 'runId': run_id}
            monitor(github, selected, current_time, row)
            if row['status'] == 'completed':
                if failures or second:
                    fail('BENCHMARK_SECOND_FAILURE')
                return {**safe, **state, 'outcome': 'first-attempt-failed', 'runId': run_id}
        elif current_time() - timestamp(created_at) >= timedelta(minutes=5):
            fail('BENCHMARK_DISPATCH_NOT_OBSERVED')
        wait(15)
    return {**safe, **state, 'outcome': pending, 'runId': run_id}


def run_benchmark(mode, now, github, store, *, enabled=False, current_time=None, wait=None):
    if enabled is not True:
        return {'event': 'FEE_BENCHMARK_CLOCK', 'outcome': 'disabled', 'benchmarkReady': False}
    if mode not in ('launch', 'check'):
        fail('MODE')
    current_time = current_time or (lambda: now)
    selected = session(now)
    safe = {'event': 'FEE_BENCHMARK_CLOCK', 'targetDate': selected['targetDate']}
    if now < selected['primaryAt']:
        return {**safe, 'outcome': 'before-primary', 'benchmarkReady': False}
    state = cache_state(github.cache(), selected)
    if state['benchmarkReady']:
        return {**safe, **state, 'outcome': 'verified-cache-reused'}
    metadata = github.workflow()
    if metadata.get('id') != WORKFLOW_ID or metadata.get('path') != '.github/workflows/' + WORKFLOW or metadata.get('state') != 'active':
        fail('BENCHMARK_WORKFLOW_NOT_ACTIVE')
    day, busy = inspect(github, selected, current_time)
    # A natural workflow may have published between the initial cache read and
    # the metadata read. Observe its current bytes before classifying a failure.
    state = cache_state(github.cache(), selected)
    if state['benchmarkReady']:
        return {**safe, **state, 'outcome': 'verified-cache-reused'}
    failures = [row for row in day if row['status'] == 'completed' and row.get('conclusion') in FAILURES]
    if len(failures) >= 2:
        fail('BENCHMARK_SECOND_FAILURE')
    if any(row['status'] == 'completed' and row.get('conclusion') == 'success' for row in day):
        fail('BENCHMARK_SUCCESS_WITHOUT_TARGET')
    if busy:
        for row in busy:
            monitor(github, selected, current_time, row)
        if mode == 'check':
            fail('BENCHMARK_TARGET_PENDING')
        row = min(busy, key=lambda value: value['created_at'])
        return follow(github, selected, safe, state, row['id'], row['created_at'], row['head_sha'],
                      failures, current_time, wait, pending='active-run-reused')
    target = selected['targetDate']
    previous = []
    for attempt in (1, 2):
        value = store.read_benchmark_intent(target, attempt)
        if value is None:
            break
        previous.append(intent_valid(value, target, attempt))
    if mode == 'check':
        if any(row.get('conclusion') == 'skipped' for row in day):
            fail('BENCHMARK_SKIPPED')
        if any(row.get('conclusion') == 'cancelled' for row in day):
            fail('BENCHMARK_CANCELLED')
        fail('BENCHMARK_TARGET_PENDING' if day or previous else 'BENCHMARK_NOT_REQUESTED')
    elapsed = current_time() - selected['primaryAt']
    if elapsed < timedelta(0) or elapsed >= timedelta(hours=1, minutes=5):
        # Summer08:00 is observe-only; winter08:00 is the second acquisition.
        return {**safe, **state, 'outcome': 'pending-before-deadline'}
    attempt = len(previous) + 1
    if attempt > 2:
        fail('BENCHMARK_ATTEMPT_LIMIT')
    if previous:
        first = previous[-1]
        row = previous_run(github, store, first, day, current_time())
        if row is None or row['status'] != 'completed' or row.get('conclusion') not in FAILURES:
            fail('BENCHMARK_DISPATCH_UNRESOLVED')
        if elapsed < timedelta(hours=1):
            return {**safe, **state, 'outcome': 'retry-not-due'}
    main = github.main().get('object', {}).get('sha', '')
    if not re.fullmatch(r'[a-f0-9]{40}', main):
        fail('METADATA_INVALID')
    value = {'schema': SCHEMA, 'repository': REPO, 'workflow': WORKFLOW, 'ref': 'main',
             'targetDate': target, 'attempt': attempt, 'createdAt': stamp(current_time()), 'mainSha': main}
    if not store.claim_benchmark(value):
        intent_valid(store.read_benchmark_intent(target, attempt), target, attempt)
        return {**safe, **state, 'outcome': 'intent-already-exists'}
    final = cache_state(github.cache(), selected)
    if final['benchmarkReady']:
        store.benchmark_result({**value, 'outcome': 'verified-cache-race', 'runId': None})
        return {**safe, **final, 'outcome': 'verified-cache-reused'}
    day, busy = inspect(github, selected, current_time)
    final = cache_state(github.cache(), selected)
    if final['benchmarkReady']:
        store.benchmark_result({**value, 'outcome': 'verified-cache-race', 'runId': None})
        return {**safe, **final, 'outcome': 'verified-cache-reused'}
    failures = [row for row in day if row['status'] == 'completed' and row.get('conclusion') in FAILURES]
    if len(failures) >= 2:
        fail('BENCHMARK_SECOND_FAILURE')
    if any(row['status'] == 'completed' and row.get('conclusion') == 'success' for row in day):
        fail('BENCHMARK_SUCCESS_WITHOUT_TARGET')
    if busy:
        store.benchmark_result({**value, 'outcome': 'natural-request-visible', 'runId': None})
        for row in busy:
            monitor(github, selected, current_time, row)
        row = min(busy, key=lambda value: value['created_at'])
        return follow(github, selected, safe, state, row['id'], row['created_at'], row['head_sha'],
                      failures, current_time, wait, pending='natural-request-visible')
    if current_time() - selected['primaryAt'] >= timedelta(hours=1, minutes=5):
        fail('BENCHMARK_OUTSIDE_WINDOW')
    run_id = github.dispatch()  # Fixed benchmark workflow/main, no inputs, no POST retry.
    store.benchmark_result({**value, 'outcome': 'dispatch-accepted', 'runId': run_id})
    return follow(github, selected, safe, state, run_id, value['createdAt'], main, failures,
                  current_time, wait, second=attempt == 2)
