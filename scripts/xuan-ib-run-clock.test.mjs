import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_STAGE_BUDGETS_MS,
  RUN_STAGES,
  bindJournalSource,
  createRunClock,
  finishJournalStage,
  initRunJournal,
  showRunJournal,
  startJournalStage
} from './xuan-ib-run-clock.mjs';

const EPOCH = Date.parse('2026-09-05T00:00:00Z');
const fakeTime = () => {
  let wall = EPOCH, monotonic = 0;
  return {
    wallNow: () => wall,
    monotonicNowMs: () => monotonic,
    tick(ms) { wall += ms; monotonic += ms; },
    moveWall(ms) { wall += ms; },
    moveMonotonic(ms) { monotonic += ms; }
  };
};

const controller = (time = fakeTime(), overrides = {}) => ({
  time,
  clock: createRunClock({ wallNow: time.wallNow, monotonicNowMs: time.monotonicNowMs, ...overrides })
});

const finishRemaining = ({ time, clock }, already = new Set()) => {
  for (const name of RUN_STAGES) {
    if (already.has(name)) continue;
    clock.start(name); time.tick(10); clock.finish(name);
  }
};

const journalFile = t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xuan-ib-run-clock-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, 'run.jsonl');
};

const clockOptions = time => ({ wallNow: time.wallNow, monotonicNowMs: time.monotonicNowMs });

test('records all existing manifest stages from clocks, with no caller-supplied timestamps', () => {
  const run = controller(), { time, clock } = run;
  clock.start('bootstrap'); time.tick(10); clock.finish('bootstrap');
  time.tick(3);
  clock.start('ib-read'); time.tick(5); clock.start('sharesight-read');
  time.tick(15); clock.finish('ib-read'); time.tick(10); clock.finish('sharesight-read');
  finishRemaining(run, new Set(['bootstrap', 'ib-read', 'sharesight-read']));

  const stages = clock.manifestStages();
  assert.deepEqual(stages.map(stage => stage.name), RUN_STAGES);
  assert.deepEqual(Object.keys(stages[0]), ['name', 'startedAt', 'endedAt', 'durationMs', 'cacheHit', 'status']);
  assert.equal(stages.find(stage => stage.name === 'ib-read').durationMs, 20);
  assert.equal(stages.find(stage => stage.name === 'sharesight-read').durationMs, 25);
  assert.equal(clock.summary().allRequiredStagesFinished, true);
});

test('critical path unions overlaps instead of claiming the sum as total wall time', () => {
  const { time, clock } = controller();
  clock.start('ib-read'); time.tick(10); clock.start('sharesight-read');
  time.tick(20); clock.finish('ib-read'); time.tick(10); clock.finish('sharesight-read');
  const result = clock.summary();
  assert.equal(result.stageSumMs, 60);
  assert.equal(result.criticalPathMs, 40);
  assert.equal(result.overlapSavedMs, 20);
  assert.equal(result.totalElapsedMs, 40);
  assert.equal(result.wallSpanMs, 40);
  assert.deepEqual(result.runningStages, []);
  assert.equal(result.allRequiredStagesFinished, false);
});

test('monotonic elapsed remains distinct from an actual wall-clock jump', () => {
  const { time, clock } = controller();
  clock.start('bootstrap');
  time.moveMonotonic(5); time.moveWall(10_000);
  const record = clock.finish('bootstrap');
  assert.equal(record.elapsedMs, 5);
  assert.equal(record.durationMs, 10_000);
  assert.equal(clock.summary().totalElapsedMs, 5);
  assert.equal(clock.summary().wallSpanMs, 10_000);
});

test('rejects invalid stages, duplicate starts, unopened finishes and non-enumerated metadata', () => {
  const { clock } = controller();
  assert.throws(() => clock.start('other'), /unknown stage/);
  assert.throws(() => clock.finish('bootstrap'), /not running/);
  clock.start('bootstrap');
  assert.throws(() => clock.start('bootstrap'), /already started/);
  assert.throws(() => clock.finish('bootstrap', { note: 'free text' }), /unknown field note/);
  assert.throws(() => clock.finish('bootstrap', { status: 'maybe' }), /status is invalid/);
  assert.throws(() => clock.finish('bootstrap', { status: 'failed' }), /needs an allowlisted errorCode/);
  assert.throws(() => clock.finish('bootstrap', { status: 'failed', errorCode: 'not safe' }), /allowlisted errorCode/);
  assert.throws(() => clock.finish('bootstrap', { errorCode: 'SERVICE_DOWN' }), /cannot attach an error/);
});

test('read stages cannot claim cache hits and failure records contain only a bounded code', () => {
  const { time, clock } = controller();
  clock.start('ib-read'); time.tick(5);
  assert.throws(() => clock.finish('ib-read', { cacheHit: true }), /cannot be a cache hit/);
  const record = clock.finish('ib-read', { status: 'degraded', errorCode: 'ONE_ENDPOINT_UNAVAILABLE' });
  assert.deepEqual(record, {
    name: 'ib-read', startedAt: '2026-09-05T00:00:00.000Z', endedAt: '2026-09-05T00:00:00.005Z',
    durationMs: 5, elapsedMs: 5, cacheHit: false, status: 'degraded', errorCode: 'ONE_ENDPOINT_UNAVAILABLE'
  });
});

test('budget results are advisory and never skip, cancel or complete a stage', () => {
  const { time, clock } = controller();
  clock.start('narrative'); time.tick(DEFAULT_STAGE_BUDGETS_MS.narrative + 7); clock.finish('narrative');
  assert.deepEqual(clock.budgetHints(), [{
    name: 'narrative', elapsedMs: 60_007, budgetMs: 60_000, overByMs: 7, withinBudget: false
  }]);
  assert.deepEqual(clock.summary().pendingStages, RUN_STAGES.filter(name => name !== 'narrative'));
  assert.throws(() => clock.manifestStages(), /all required stages must finish/);
});

test('rejects backwards clocks and malformed injected budgets', () => {
  const run = controller();
  run.time.tick(10);
  run.clock.start('bootstrap'); run.time.moveMonotonic(-1);
  assert.throws(() => run.clock.finish('bootstrap'), /monotonic clock moved backwards/);

  const wallRun = controller();
  wallRun.clock.start('bootstrap'); wallRun.time.moveWall(-1);
  assert.throws(() => wallRun.clock.finish('bootstrap'), /wall clock moved backwards/);

  assert.throws(() => controller(fakeTime(), { budgetsMs: { ...DEFAULT_STAGE_BUDGETS_MS, secret: 1 } }),
    /unknown field secret/);
  assert.throws(() => controller(fakeTime(), { budgetsMs: { ...DEFAULT_STAGE_BUDGETS_MS, render: 0 } }),
    /budget for render/);
});

test('onEvent emits an immediate strict event stream and binding never claims publication', () => {
  const time = fakeTime(), events = [];
  const clock = createRunClock({
    ...clockOptions(time),
    onEvent: event => events.push(event)
  });
  for (const stage of RUN_STAGES) {
    clock.start(stage); time.tick(3); clock.finish(stage);
  }
  time.tick(1);
  const binding = clock.bindSource('a'.repeat(40));

  assert.deepEqual(events.map(event => event.seq), Array.from({ length: 20 }, (_, index) => index));
  assert.equal(events[0].type, 'init');
  assert.equal(events.at(-1).type, 'source-bind');
  assert.equal(Object.hasOwn(events.at(-1), 'published'), false);
  assert.deepEqual(binding, {
    sourceSha: 'a'.repeat(40),
    boundAt: '2026-09-05T00:00:00.028Z',
    publicationStatus: 'not-asserted'
  });
  assert.throws(() => clock.bindSource('b'.repeat(40)), /already bound/);
  assert.throws(() => createRunClock({ ...clockOptions(fakeTime()), onEvent: async () => {} }),
    /synchronous/);
});

test('append-only journal survives separate calls, preserves overlaps and binds once', t => {
  const file = journalFile(t), time = fakeTime();
  initRunJournal(file, clockOptions(time));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.throws(() => initRunJournal(file, clockOptions(time)), /initialization failed \(EEXIST\)/);

  startJournalStage(file, 'ib-read', clockOptions(time));
  time.tick(10);
  startJournalStage(file, 'sharesight-read', clockOptions(time));
  time.tick(20);
  finishJournalStage(file, 'ib-read', {}, clockOptions(time));
  time.tick(10);
  finishJournalStage(file, 'sharesight-read', {}, clockOptions(time));

  let snapshot = showRunJournal(file);
  assert.equal(snapshot.timing.stageSumMs, 60);
  assert.equal(snapshot.timing.criticalPathMs, 40);
  assert.equal(snapshot.timing.totalElapsedMs, 40);
  assert.equal(snapshot.manifestStages, null);
  assert.equal(snapshot.sourceBinding, null);

  for (const stage of RUN_STAGES.filter(name => !['ib-read', 'sharesight-read'].includes(name))) {
    startJournalStage(file, stage, clockOptions(time));
    time.tick(1);
    finishJournalStage(file, stage, {}, clockOptions(time));
  }
  assert.throws(() => bindJournalSource(file, 'BAD', clockOptions(time)), /40-character commit hash/);
  time.tick(1);
  bindJournalSource(file, 'c'.repeat(40), clockOptions(time));
  assert.throws(() => bindJournalSource(file, 'd'.repeat(40), clockOptions(time)), /already bound/);

  snapshot = showRunJournal(file);
  assert.deepEqual(snapshot.manifestStages.map(stage => stage.name), RUN_STAGES);
  assert.equal(snapshot.eventCount, 20);
  assert.deepEqual(snapshot.sourceBinding, {
    sourceSha: 'c'.repeat(40),
    boundAt: '2026-09-05T00:00:00.048Z',
    publicationStatus: 'not-asserted'
  });
});

test('journal rejects damaged, non-canonical, duplicate and over-permissive files', t => {
  const valid = journalFile(t), time = fakeTime();
  initRunJournal(valid, clockOptions(time));
  const initialLine = fs.readFileSync(valid, 'utf8');

  const partial = `${valid}.partial`;
  fs.writeFileSync(partial, initialLine.trimEnd(), { mode: 0o600 });
  assert.throws(() => showRunJournal(partial), /partial final event/);

  const nonCanonical = `${valid}.noncanonical`;
  fs.writeFileSync(nonCanonical, `${initialLine.trimEnd()} \n`, { mode: 0o600 });
  assert.throws(() => showRunJournal(nonCanonical), /not canonical/);

  const duplicate = `${valid}.duplicate`;
  fs.writeFileSync(duplicate, initialLine + initialLine, { mode: 0o600 });
  assert.throws(() => showRunJournal(duplicate), /broken sequence/);

  fs.chmodSync(valid, 0o644);
  assert.throws(() => showRunJournal(valid), /permissions must be 0600/);
});

test('CLI journal works across independent Node processes', t => {
  const file = journalFile(t);
  const script = fileURLToPath(new URL('./xuan-ib-run-clock.mjs', import.meta.url));
  const invoke = args => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });

  const initialized = invoke(['init', file]);
  assert.equal(initialized.status, 0, initialized.stderr);
  const started = invoke(['start', file, 'bootstrap']);
  assert.equal(started.status, 0, started.stderr);
  const finished = invoke(['finish', file, 'bootstrap']);
  assert.equal(finished.status, 0, finished.stderr);
  const shown = invoke(['show', file]);
  assert.equal(shown.status, 0, shown.stderr);

  const output = JSON.parse(shown.stdout);
  assert.deepEqual(output.timing.completedStages, ['bootstrap']);
  assert.equal(output.timing.pendingStages.length, RUN_STAGES.length - 1);
  assert.equal(output.manifestStages, null);
  assert.equal(output.eventCount, 3);
});
