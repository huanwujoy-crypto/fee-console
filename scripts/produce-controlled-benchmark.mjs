// Run the unchanged reviewed public parser; output only two exact target price rows.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { refreshSessionBenchmark } from './refresh-session-benchmark.mjs';
import { PARSER_SHA256, sealPriceCache, validatePriceEnvelope } from './controlled-benchmark-object.mjs';

export async function produceControlledBenchmark(input, { now = () => new Date(), refreshImpl } = {}) {
  const source = await fs.readFile(new URL('./refresh-benchmark-cache.mjs', import.meta.url));
  if (createHash('sha256').update(source).digest('hex') !== PARSER_SHA256) throw new Error('CONTROLLED_BENCHMARK_PARSER');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'controlled-prices-'));
  try {
    const cachePath = path.join(directory, 'prices.json');
    if (input.seedCache !== undefined) await fs.writeFile(cachePath, JSON.stringify(input.seedCache), { mode: 0o600 });
    const result = await refreshSessionBenchmark({ env: { CLOSE_TARGET_DATE: input.target,
      CLOSE_ROUND: String(input.round), CLOSE_SESSION_KEY: input.sessionKey, CLOSE_UNIFIED_ENABLED: 'true' },
      now: now(), path: cachePath, ...(refreshImpl ? { refreshImpl } : {}) });
    const value = sealPriceCache(result.cache, { ...input, producedAt: now().toISOString() });
    validatePriceEnvelope(value, input.target, now()); // do not publish if fetching crossed the round window
    return value;
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}

async function main() {
  let raw = ''; for await (const chunk of process.stdin) {
    raw += chunk; if (Buffer.byteLength(raw) > 3 * 1024 * 1024) throw new Error();
  }
  const input = JSON.parse(raw);
  if (!input || Object.keys(input).some(key => !['target', 'round', 'sessionKey', 'seedCache'].includes(key))) throw new Error();
  const log = console.log, warn = console.warn;
  let value;
  try {
    // The unchanged parser logs progress. Keep the subprocess protocol exactly
    // one bounded JSON value and do not forward provider errors or local paths.
    console.log = console.warn = () => {};
    value = await produceControlledBenchmark(input);
  } finally { console.log = log; console.warn = warn; }
  process.stdout.write(JSON.stringify(value) + '\n');
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(() => { console.error('CONTROLLED_BENCHMARK_INCOMPLETE'); process.exitCode = 1; });
}
