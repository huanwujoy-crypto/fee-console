#!/usr/bin/env node

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

import { RUN_STAGES } from './xuan-ib-run-manifest.mjs';

export { RUN_STAGES };

export const DEFAULT_STAGE_BUDGETS_MS = Object.freeze({
  bootstrap: 30_000,
  'ib-read': 180_000,
  'sharesight-read': 195_000,
  validate: 45_000,
  derive: 45_000,
  narrative: 60_000,
  render: 20_000,
  guard: 10_000,
  'candidate-prep': 30_000
});

const STATUSES = new Set(['ok', 'degraded', 'failed']);
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const SOURCE_SHA = /^[a-f0-9]{40}$/;
const FINANCIAL_READ_STAGES = new Set(['ib-read', 'sharesight-read']);
const JOURNAL_VERSION = 1;
const MAX_JOURNAL_BYTES = 128 * 1024;

const defaultWallNow = () => Date.now();
const defaultMonotonicNowMs = () => Number(process.hrtime.bigint() / 1_000_000n);

const fail = message => {
  throw new Error(`XUAN-IB run clock: ${message}`);
};

const exactKeys = (value, allowed, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${label} contains unknown field ${key}`);
  for (const key of allowed) if (!Object.hasOwn(value, key)) fail(`${label} is missing ${key}`);
};

const allowedKeys = (value, allowed, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${label} contains unknown field ${key}`);
};

const readWall = (wallNow, label) => {
  const value = wallNow();
  if (!Number.isSafeInteger(value) || value < 0) fail(`${label} wall clock must return epoch milliseconds`);
  return value;
};

const readMonotonic = (monotonicNowMs, label) => {
  const value = monotonicNowMs();
  if (!Number.isSafeInteger(value) || value < 0) fail(`${label} monotonic clock must return milliseconds`);
  return value;
};

const iso = value => new Date(value).toISOString();

const validateFinishOptions = (name, options = {}) => {
  allowedKeys(options, ['status', 'cacheHit', 'errorCode'], 'finish options');
  const status = options.status ?? 'ok';
  const cacheHit = options.cacheHit ?? false;
  const errorCode = options.errorCode ?? null;
  if (!STATUSES.has(status)) fail(`stage ${name} status is invalid`);
  if (typeof cacheHit !== 'boolean') fail(`stage ${name} cacheHit must be boolean`);
  if (FINANCIAL_READ_STAGES.has(name) && cacheHit) fail(`${name} cannot be a cache hit`);
  if (status === 'ok' && errorCode !== null) fail(`stage ${name} cannot attach an error to ok`);
  if (status !== 'ok' && (typeof errorCode !== 'string' || !ERROR_CODE.test(errorCode))) {
    fail(`stage ${name} needs an allowlisted errorCode when not ok`);
  }
  return { status, cacheHit, errorCode };
};

const assertSourceSha = sourceSha => {
  if (typeof sourceSha !== 'string' || !SOURCE_SHA.test(sourceSha)) {
    fail('sourceSha must be a lowercase 40-character commit hash');
  }
};

const eventInit = (seq, wallMs, monotonicMs) => ({
  v: JOURNAL_VERSION, seq, type: 'init', wallMs, monotonicMs
});

const eventStart = (seq, stage, wallMs, monotonicMs) => ({
  v: JOURNAL_VERSION, seq, type: 'stage-start', stage, wallMs, monotonicMs
});

const eventFinish = (seq, stage, wallMs, monotonicMs, { status, cacheHit, errorCode }) => ({
  v: JOURNAL_VERSION, seq, type: 'stage-finish', stage, wallMs, monotonicMs,
  status, cacheHit, errorCode
});

const eventSourceBind = (seq, sourceSha, wallMs, monotonicMs) => ({
  v: JOURNAL_VERSION, seq, type: 'source-bind', sourceSha, wallMs, monotonicMs
});

const unionDuration = intervals => {
  if (!intervals.length) return 0;
  const ordered = intervals.map(interval => [...interval]).sort((left, right) => left[0] - right[0]);
  let [start, end] = ordered[0], total = 0;
  for (const [nextStart, nextEnd] of ordered.slice(1)) {
    if (nextStart <= end) end = Math.max(end, nextEnd);
    else { total += end - start; start = nextStart; end = nextEnd; }
  }
  return total + end - start;
};

const recordsFor = completed => RUN_STAGES.filter(name => completed.has(name)).map(name => {
  const { startMonotonicMs, endMonotonicMs, ...record } = completed.get(name);
  return { ...record };
});

const summarize = (runWallStart, runMonotonicStart, active, completed) => {
  const records = [...completed.values()];
  const intervals = records.map(record => [record.startMonotonicMs, record.endMonotonicMs]);
  const stageSumMs = records.reduce((sum, record) => sum + record.elapsedMs, 0);
  const criticalPathMs = unionDuration(intervals);
  const lastMonotonicMs = records.length
    ? Math.max(...records.map(record => record.endMonotonicMs))
    : runMonotonicStart;
  const lastWallMs = records.length
    ? Math.max(...records.map(record => Date.parse(record.endedAt)))
    : runWallStart;
  return {
    startedAt: iso(runWallStart),
    observedThrough: iso(lastWallMs),
    totalElapsedMs: lastMonotonicMs - runMonotonicStart,
    wallSpanMs: lastWallMs - runWallStart,
    criticalPathMs,
    stageSumMs,
    overlapSavedMs: stageSumMs - criticalPathMs,
    completedStages: RUN_STAGES.filter(name => completed.has(name)),
    runningStages: RUN_STAGES.filter(name => active.has(name)),
    pendingStages: RUN_STAGES.filter(name => !active.has(name) && !completed.has(name)),
    allRequiredStagesFinished: completed.size === RUN_STAGES.length && active.size === 0
  };
};

const manifestFor = (active, completed) => {
  if (active.size || completed.size !== RUN_STAGES.length) fail('all required stages must finish before manifest output');
  return RUN_STAGES.map(name => {
    const record = completed.get(name);
    return {
      name,
      startedAt: record.startedAt,
      endedAt: record.endedAt,
      durationMs: record.durationMs,
      cacheHit: record.cacheHit,
      status: record.status
    };
  });
};

export function createRunClock({
  wallNow = defaultWallNow,
  monotonicNowMs = defaultMonotonicNowMs,
  budgetsMs = DEFAULT_STAGE_BUDGETS_MS,
  onEvent = null
} = {}) {
  if (typeof wallNow !== 'function' || typeof monotonicNowMs !== 'function') fail('clock functions are required');
  if (onEvent !== null && typeof onEvent !== 'function') fail('onEvent must be a synchronous function');
  exactKeys(budgetsMs, RUN_STAGES, 'budgetsMs');
  for (const name of RUN_STAGES) {
    if (!Number.isSafeInteger(budgetsMs[name]) || budgetsMs[name] <= 0) fail(`budget for ${name} must be positive milliseconds`);
  }
  const budgetSnapshot = Object.freeze(Object.fromEntries(RUN_STAGES.map(name => [name, budgetsMs[name]])));

  const runWallStart = readWall(wallNow, 'run start');
  const runMonotonicStart = readMonotonic(monotonicNowMs, 'run start');
  const active = new Map(), completed = new Map();
  let sourceBinding = null, nextSeq = 0;

  const emit = event => {
    if (onEvent === null) return;
    const result = onEvent(Object.freeze({ ...event }));
    if (result && typeof result.then === 'function') fail('onEvent must be synchronous');
  };

  emit(eventInit(nextSeq++, runWallStart, runMonotonicStart));

  const requireStage = name => {
    if (!RUN_STAGES.includes(name)) fail(`unknown stage ${String(name)}`);
  };

  const start = name => {
    requireStage(name);
    if (active.has(name) || completed.has(name)) fail(`stage ${name} has already started`);
    const wallMs = readWall(wallNow, `${name} start`);
    const monotonicMs = readMonotonic(monotonicNowMs, `${name} start`);
    if (wallMs < runWallStart || monotonicMs < runMonotonicStart) fail(`stage ${name} starts before the run`);
    emit(eventStart(nextSeq, name, wallMs, monotonicMs));
    nextSeq += 1;
    active.set(name, { wallMs, monotonicMs });
    return { name, startedAt: iso(wallMs) };
  };

  const finish = (name, options = {}) => {
    requireStage(name);
    if (!active.has(name)) fail(`stage ${name} is not running`);
    const { status, cacheHit, errorCode } = validateFinishOptions(name, options);
    const endWallMs = readWall(wallNow, `${name} finish`);
    const endMonotonicMs = readMonotonic(monotonicNowMs, `${name} finish`);
    const begun = active.get(name);
    if (endWallMs < begun.wallMs) fail(`stage ${name} wall clock moved backwards`);
    if (endMonotonicMs < begun.monotonicMs) fail(`stage ${name} monotonic clock moved backwards`);
    emit(eventFinish(nextSeq, name, endWallMs, endMonotonicMs, { status, cacheHit, errorCode }));
    nextSeq += 1;
    const record = Object.freeze({
      name,
      startedAt: iso(begun.wallMs),
      endedAt: iso(endWallMs),
      durationMs: endWallMs - begun.wallMs,
      elapsedMs: endMonotonicMs - begun.monotonicMs,
      cacheHit,
      status,
      errorCode
    });
    active.delete(name);
    completed.set(name, { ...record, startMonotonicMs: begun.monotonicMs, endMonotonicMs });
    return record;
  };

  const bindSource = sourceSha => {
    assertSourceSha(sourceSha);
    if (sourceBinding !== null) fail('sourceSha is already bound');
    if (active.size || completed.size !== RUN_STAGES.length) fail('all required stages must finish before source binding');
    const wallMs = readWall(wallNow, 'source bind');
    const monotonicMs = readMonotonic(monotonicNowMs, 'source bind');
    const latestStageEnd = Math.max(...[...completed.values()].map(record => record.endMonotonicMs));
    if (monotonicMs < latestStageEnd) fail('source binding precedes completed stages');
    emit(eventSourceBind(nextSeq, sourceSha, wallMs, monotonicMs));
    nextSeq += 1;
    sourceBinding = Object.freeze({ sourceSha, boundAt: iso(wallMs), publicationStatus: 'not-asserted' });
    return { ...sourceBinding };
  };

  const stageRecords = () => recordsFor(completed);

  const summary = () => summarize(runWallStart, runMonotonicStart, active, completed);

  const budgetHints = () => stageRecords().map(record => ({
    name: record.name,
    elapsedMs: record.elapsedMs,
    budgetMs: budgetSnapshot[record.name],
    overByMs: Math.max(0, record.elapsedMs - budgetSnapshot[record.name]),
    withinBudget: record.elapsedMs <= budgetSnapshot[record.name]
  }));

  const manifestStages = () => manifestFor(active, completed);

  return Object.freeze({
    startedAt: iso(runWallStart),
    start,
    finish,
    bindSource,
    stageRecords,
    summary,
    budgetHints,
    manifestStages,
    sourceBinding: () => sourceBinding === null ? null : { ...sourceBinding }
  });
}

const requireStageName = stage => {
  if (!RUN_STAGES.includes(stage)) fail(`unknown stage ${String(stage)}`);
};

const requireEventClock = (event, label) => {
  if (!Number.isSafeInteger(event.wallMs) || event.wallMs < 0) fail(`${label} wallMs is invalid`);
  if (!Number.isSafeInteger(event.monotonicMs) || event.monotonicMs < 0) fail(`${label} monotonicMs is invalid`);
};

const normalizeEvent = (event, expectedSeq) => {
  if (!event || typeof event !== 'object' || Array.isArray(event)) fail(`journal event ${expectedSeq} must be an object`);
  if (event.v !== JOURNAL_VERSION) fail(`journal event ${expectedSeq} has an unsupported version`);
  if (event.seq !== expectedSeq) fail(`journal event ${expectedSeq} has a broken sequence`);
  if (typeof event.type !== 'string') fail(`journal event ${expectedSeq} has no type`);

  const label = `journal event ${expectedSeq}`;
  if (event.type === 'init') {
    exactKeys(event, ['v', 'seq', 'type', 'wallMs', 'monotonicMs'], label);
    requireEventClock(event, label);
    return eventInit(event.seq, event.wallMs, event.monotonicMs);
  }
  if (event.type === 'stage-start') {
    exactKeys(event, ['v', 'seq', 'type', 'stage', 'wallMs', 'monotonicMs'], label);
    requireStageName(event.stage);
    requireEventClock(event, label);
    return eventStart(event.seq, event.stage, event.wallMs, event.monotonicMs);
  }
  if (event.type === 'stage-finish') {
    exactKeys(event, [
      'v', 'seq', 'type', 'stage', 'wallMs', 'monotonicMs', 'status', 'cacheHit', 'errorCode'
    ], label);
    requireStageName(event.stage);
    requireEventClock(event, label);
    const finishOptions = validateFinishOptions(event.stage, {
      status: event.status, cacheHit: event.cacheHit, errorCode: event.errorCode
    });
    return eventFinish(event.seq, event.stage, event.wallMs, event.monotonicMs, finishOptions);
  }
  if (event.type === 'source-bind') {
    exactKeys(event, ['v', 'seq', 'type', 'sourceSha', 'wallMs', 'monotonicMs'], label);
    assertSourceSha(event.sourceSha);
    requireEventClock(event, label);
    return eventSourceBind(event.seq, event.sourceSha, event.wallMs, event.monotonicMs);
  }
  fail(`journal event ${expectedSeq} has an unsupported type`);
};

const replayEvents = events => {
  if (!events.length || events[0].type !== 'init') fail('journal must begin with one init event');
  const runWallStart = events[0].wallMs;
  const runMonotonicStart = events[0].monotonicMs;
  const active = new Map(), completed = new Map();
  let sourceBinding = null, lastMonotonicMs = runMonotonicStart;

  for (const event of events.slice(1)) {
    if (event.type === 'init') fail('journal contains a duplicate init event');
    if (event.monotonicMs < lastMonotonicMs) fail(`journal event ${event.seq} moves monotonic time backwards`);
    if (event.wallMs < runWallStart || event.monotonicMs < runMonotonicStart) {
      fail(`journal event ${event.seq} precedes run initialization`);
    }

    if (event.type === 'stage-start') {
      if (active.has(event.stage) || completed.has(event.stage)) fail(`stage ${event.stage} has already started`);
      active.set(event.stage, { wallMs: event.wallMs, monotonicMs: event.monotonicMs });
    } else if (event.type === 'stage-finish') {
      if (!active.has(event.stage)) fail(`stage ${event.stage} is not running`);
      const begun = active.get(event.stage);
      if (event.wallMs < begun.wallMs) fail(`stage ${event.stage} wall clock moved backwards`);
      if (event.monotonicMs < begun.monotonicMs) fail(`stage ${event.stage} monotonic clock moved backwards`);
      completed.set(event.stage, {
        name: event.stage,
        startedAt: iso(begun.wallMs),
        endedAt: iso(event.wallMs),
        durationMs: event.wallMs - begun.wallMs,
        elapsedMs: event.monotonicMs - begun.monotonicMs,
        cacheHit: event.cacheHit,
        status: event.status,
        errorCode: event.errorCode,
        startMonotonicMs: begun.monotonicMs,
        endMonotonicMs: event.monotonicMs
      });
      active.delete(event.stage);
    } else if (event.type === 'source-bind') {
      if (sourceBinding !== null) fail('sourceSha is already bound');
      if (active.size || completed.size !== RUN_STAGES.length) {
        fail('all required stages must finish before source binding');
      }
      sourceBinding = {
        sourceSha: event.sourceSha,
        boundAt: iso(event.wallMs),
        publicationStatus: 'not-asserted'
      };
    }
    lastMonotonicMs = event.monotonicMs;
  }

  return { runWallStart, runMonotonicStart, active, completed, sourceBinding };
};

const journalStat = filePath => {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    fail(`journal cannot be opened (${error?.code ?? 'IO_ERROR'})`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) fail('journal must be a regular non-symlink file');
  if ((stat.mode & 0o777) !== 0o600) fail('journal permissions must be 0600');
  if (stat.size <= 0 || stat.size > MAX_JOURNAL_BYTES) fail('journal size is invalid');
  return stat;
};

const readJournal = filePath => {
  journalStat(filePath);
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    fail(`journal cannot be read (${error?.code ?? 'IO_ERROR'})`);
  }
  if (!content.endsWith('\n')) fail('journal has a partial final event');
  const lines = content.slice(0, -1).split('\n');
  if (lines.some(line => line.length === 0)) fail('journal contains an empty event');
  const events = lines.map((line, index) => {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      fail(`journal event ${index} is not valid JSON`);
    }
    const normalized = normalizeEvent(parsed, index);
    if (JSON.stringify(normalized) !== line) fail(`journal event ${index} is not canonical`);
    return normalized;
  });
  return { events, state: replayEvents(events) };
};

const clockValues = (clockOptions = {}, label) => {
  allowedKeys(clockOptions, ['wallNow', 'monotonicNowMs'], 'clock options');
  const wallNow = clockOptions.wallNow ?? defaultWallNow;
  const monotonicNowMs = clockOptions.monotonicNowMs ?? defaultMonotonicNowMs;
  if (typeof wallNow !== 'function' || typeof monotonicNowMs !== 'function') fail('clock functions are required');
  return {
    wallMs: readWall(wallNow, label),
    monotonicMs: readMonotonic(monotonicNowMs, label)
  };
};

const createJournal = (filePath, event) => {
  const line = Buffer.from(`${JSON.stringify(event)}\n`, 'utf8');
  let descriptor;
  try {
    descriptor = fs.openSync(filePath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    fs.fchmodSync(descriptor, 0o600);
    const written = fs.writeSync(descriptor, line, 0, line.length, null);
    if (written !== line.length) fail('journal initialization was a partial write');
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (error?.message?.startsWith('XUAN-IB run clock:')) throw error;
    fail(`journal initialization failed (${error?.code ?? 'IO_ERROR'})`);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
};

const appendJournal = (filePath, event) => {
  const current = readJournal(filePath);
  const normalized = normalizeEvent(event, current.events.length);
  replayEvents([...current.events, normalized]);
  const line = Buffer.from(`${JSON.stringify(normalized)}\n`, 'utf8');
  let descriptor;
  try {
    descriptor = fs.openSync(filePath, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW);
    const openStat = fs.fstatSync(descriptor);
    if (!openStat.isFile() || (openStat.mode & 0o777) !== 0o600) fail('journal changed before append');
    const written = fs.writeSync(descriptor, line, 0, line.length, null);
    if (written !== line.length) fail('journal append was a partial write');
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (error?.message?.startsWith('XUAN-IB run clock:')) throw error;
    fail(`journal append failed (${error?.code ?? 'IO_ERROR'})`);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  return normalized;
};

export function initRunJournal(filePath, clockOptions = {}) {
  if (typeof filePath !== 'string' || filePath.length === 0) fail('journal path is required');
  const { wallMs, monotonicMs } = clockValues(clockOptions, 'run init');
  const event = eventInit(0, wallMs, monotonicMs);
  createJournal(filePath, event);
  return event;
}

export function startJournalStage(filePath, stage, clockOptions = {}) {
  requireStageName(stage);
  const current = readJournal(filePath);
  if (current.state.active.has(stage) || current.state.completed.has(stage)) fail(`stage ${stage} has already started`);
  const { wallMs, monotonicMs } = clockValues(clockOptions, `${stage} start`);
  return appendJournal(filePath, eventStart(current.events.length, stage, wallMs, monotonicMs));
}

export function finishJournalStage(filePath, stage, finishOptions = {}, clockOptions = {}) {
  requireStageName(stage);
  const current = readJournal(filePath);
  if (!current.state.active.has(stage)) fail(`stage ${stage} is not running`);
  const safeOptions = validateFinishOptions(stage, finishOptions);
  const { wallMs, monotonicMs } = clockValues(clockOptions, `${stage} finish`);
  return appendJournal(filePath,
    eventFinish(current.events.length, stage, wallMs, monotonicMs, safeOptions));
}

export function bindJournalSource(filePath, sourceSha, clockOptions = {}) {
  assertSourceSha(sourceSha);
  const current = readJournal(filePath);
  if (current.state.sourceBinding !== null) fail('sourceSha is already bound');
  if (current.state.active.size || current.state.completed.size !== RUN_STAGES.length) {
    fail('all required stages must finish before source binding');
  }
  const { wallMs, monotonicMs } = clockValues(clockOptions, 'source bind');
  return appendJournal(filePath,
    eventSourceBind(current.events.length, sourceSha, wallMs, monotonicMs));
}

export function showRunJournal(filePath, { budgetsMs = DEFAULT_STAGE_BUDGETS_MS } = {}) {
  exactKeys(budgetsMs, RUN_STAGES, 'budgetsMs');
  for (const name of RUN_STAGES) {
    if (!Number.isSafeInteger(budgetsMs[name]) || budgetsMs[name] <= 0) fail(`budget for ${name} must be positive milliseconds`);
  }
  const { events, state } = readJournal(filePath);
  const records = recordsFor(state.completed);
  const timing = summarize(state.runWallStart, state.runMonotonicStart, state.active, state.completed);
  return {
    journalVersion: JOURNAL_VERSION,
    eventCount: events.length,
    timing,
    stages: records,
    budgetHints: records.map(record => ({
      name: record.name,
      elapsedMs: record.elapsedMs,
      budgetMs: budgetsMs[record.name],
      overByMs: Math.max(0, record.elapsedMs - budgetsMs[record.name]),
      withinBudget: record.elapsedMs <= budgetsMs[record.name]
    })),
    manifestStages: timing.allRequiredStagesFinished ? manifestFor(state.active, state.completed) : null,
    sourceBinding: state.sourceBinding === null ? null : { ...state.sourceBinding }
  };
}

const parseFinishFlags = args => {
  const result = {};
  for (const argument of args) {
    if (argument === '--cache-hit') {
      if (Object.hasOwn(result, 'cacheHit')) fail('duplicate --cache-hit flag');
      result.cacheHit = true;
    } else if (argument.startsWith('--status=')) {
      if (Object.hasOwn(result, 'status')) fail('duplicate --status flag');
      result.status = argument.slice('--status='.length);
    } else if (argument.startsWith('--error-code=')) {
      if (Object.hasOwn(result, 'errorCode')) fail('duplicate --error-code flag');
      result.errorCode = argument.slice('--error-code='.length);
    } else {
      fail(`unknown finish flag ${argument}`);
    }
  }
  return result;
};

export function runCli(args, write = value => process.stdout.write(`${JSON.stringify(value)}\n`)) {
  if (!Array.isArray(args) || typeof write !== 'function') fail('CLI arguments are invalid');
  const [command, filePath, subject, ...rest] = args;
  let output;
  if (command === 'init' && filePath && subject === undefined) {
    output = initRunJournal(filePath);
  } else if (command === 'start' && filePath && subject && rest.length === 0) {
    output = startJournalStage(filePath, subject);
  } else if (command === 'finish' && filePath && subject) {
    output = finishJournalStage(filePath, subject, parseFinishFlags(rest));
  } else if (command === 'bind-source' && filePath && subject && rest.length === 0) {
    output = bindJournalSource(filePath, subject);
  } else if (command === 'show' && filePath && subject === undefined) {
    output = showRunJournal(filePath);
  } else {
    fail('usage: init FILE | start FILE STAGE | finish FILE STAGE [--status=...] [--cache-hit] [--error-code=...] | bind-source FILE SHA | show FILE');
  }
  write(output);
  return output;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error?.message ?? 'XUAN-IB run clock: unknown failure'}\n`);
    process.exitCode = 1;
  }
}
