import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

test('weekly cloud source, network, publication and failure tests use synthetic inputs', () => {
  const cwd = fileURLToPath(new URL('../cloud/xuan-weekly/', import.meta.url));
  const result = spawnSync('python3', ['-m', 'unittest', 'discover', '-s', '.', '-p', 'test_*.py'],
    { cwd, encoding: 'utf8', timeout: 30000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
