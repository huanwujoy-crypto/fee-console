#!/usr/bin/env node
// Exact-target wrapper around the unchanged reviewed public price extractor.
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { refresh } from './refresh-benchmark-cache.mjs';
import { benchmarkTargetStatus, closeSessionPlan } from './benchmark-close-contract.mjs';

export function validateSessionInputs(env, now = new Date()) {
  const targetDate = env.CLOSE_TARGET_DATE || '', round = env.CLOSE_ROUND || '', key = env.CLOSE_SESSION_KEY || '';
  if (!targetDate && !round && !key) {
    if (env.CLOSE_UNIFIED_ENABLED === 'true') throw new Error('UNIFIED_BENCHMARK_INPUT');
    return null; // Existing standalone/manual path before coordinated cutover.
  }
  if (env.CLOSE_UNIFIED_ENABLED !== 'true' || !['1', '2'].includes(round)
      || key !== `unified-close:${targetDate}:benchmark:${round}`) throw new Error('UNIFIED_BENCHMARK_INPUT');
  const plan = closeSessionPlan(targetDate), time = new Date(now).getTime();
  const start = Date.parse(round === '1' ? plan.firstAt : plan.retryAt);
  const end = Date.parse(round === '1' ? plan.retryAt : plan.secondDeadlineAt);
  if (!plan.open || !Number.isFinite(time) || time < start || time >= end) throw new Error('UNIFIED_BENCHMARK_WINDOW');
  return { targetDate, round: Number(round), key, plan };
}

export async function refreshSessionBenchmark({ env = process.env, now = new Date(), path = 'benchmark-close.json',
  refreshImpl = refresh, read = file => fs.readFile(file, 'utf8') } = {}) {
  const session = validateSessionInputs(env, now);
  if (!session) return refreshImpl({ path, now });
  let existing;
  try { existing = JSON.parse(await read(path)); }
  catch (error) { if (error?.code !== 'ENOENT') throw new Error('UNIFIED_BENCHMARK_CACHE'); }
  if (benchmarkTargetStatus(existing, session.targetDate).ready) return { changed: false, cache: existing, completed: true };
  const result = await refreshImpl({ path, now });
  if (!benchmarkTargetStatus(result?.cache, session.targetDate).ready) throw new Error('UNIFIED_BENCHMARK_TARGET_INCOMPLETE');
  return { ...result, completed: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.slice(2).join() === '--validate-only') validateSessionInputs(process.env);
    else if (!process.argv.slice(2).length) await refreshSessionBenchmark();
    else throw new Error('UNIFIED_BENCHMARK_ARGS');
  } catch (error) {
    const safe = /^UNIFIED_BENCHMARK_[A-Z_]+$/.test(error?.message || '') ? error.message : 'UNIFIED_BENCHMARK_FAILED';
    console.error(safe); process.exitCode = 1;
  }
}
