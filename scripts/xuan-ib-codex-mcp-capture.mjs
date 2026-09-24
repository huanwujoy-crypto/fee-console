#!/usr/bin/env node

// Machine-capture the native JSONL results of exactly five read-only IBKR MCP
// calls. The model is only a tool dispatcher; it never transcribes balances.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { beginSourceCapture, finishSourceCapture } from './xuan-ib-source-capture.mjs';
import { decodeHookResponse } from './xuan-ib-hook-response.mjs';
import { validateHookInput } from './xuan-ib-source-hook.mjs';

const CODEX = '/Applications/ChatGPT.app/Contents/Resources/codex';
const SERVER = 'ibkr';
const URL = 'https://api.ibkr.com/v1/api/mcp-public';
const TOOL_KEYS = Object.freeze({
  get_account_summary: 'ib.accountSummary',
  get_account_balances: 'ib.balances',
  get_account_positions: 'ib.positions',
  get_account_orders: 'ib.orders',
  get_account_trades: 'ib.trades',
});
const PROMPT = 'Use only the configured official ibkr MCP server. Call exactly once each of get_account_summary, get_account_balances, get_account_positions, get_account_orders, and get_account_trades (period TODAY). These are read-only. Do not call any write tool, issue an instruction, or print financial data. Final answer: completed.';
const ACTION_TOOLS = Object.freeze(['get_account_summary', 'get_account_positions', 'get_account_orders']);
const ACTION_PROMPT = 'Use only the configured official ibkr MCP server. Call exactly once each of get_account_summary, get_account_positions, and get_account_orders. These are read-only. Do not call any other tool, issue an instruction, or print financial data. Final answer: completed.';

export function parseCodexIbEvent(event) {
  if (['command_execution', 'file_change', 'web_search'].includes(event?.item?.type))
    throw new Error('UNEXPECTED_CODEX_ACTION');
  if (event?.item?.type !== 'mcp_tool_call') return null;
  const item = event.item;
  if (item.server !== SERVER || !Object.hasOwn(TOOL_KEYS, item.tool)) throw new Error('UNEXPECTED_MCP_TOOL');
  if (event.type === 'item.started' || event.type === 'item.updated') return null;
  if (event.type !== 'item.completed') throw new Error('UNEXPECTED_MCP_EVENT');
  if (item.status !== 'completed' || !item.result || item.error
    || item.result.isError === true || item.result.is_error === true) throw new Error('MCP_READ_FAILED');
  const sourceKey = TOOL_KEYS[item.tool];
  validateHookInput(sourceKey, item.arguments ?? {});
  const content = item.result.structured_content ?? (() => {
    const blocks = item.result.content;
    if (!Array.isArray(blocks) || blocks.length !== 1 || blocks[0]?.type !== 'text')
      throw new Error('UNSUPPORTED_MCP_RESULT');
    return blocks[0].text;
  })();
  const { raw } = decodeHookResponse(content, { sourceKey });
  return { sourceKey, raw };
}

async function captureCodexIbSet({ dir, journalPath, toolNames, prompt, spawnCodex }) {
  if (!Array.isArray(toolNames) || !toolNames.length || new Set(toolNames).size !== toolNames.length
    || toolNames.some(tool => !Object.hasOwn(TOOL_KEYS, tool)) || typeof prompt !== 'string')
    throw new Error('INVALID_IB_CAPTURE_SET');
  const expected = new Set(toolNames.map(tool => TOOL_KEYS[tool]));
  for (const sourceKey of expected) beginSourceCapture(dir, sourceKey, { journalPath });
  const child = spawnCodex(CODEX, ['exec', '--json', '--ephemeral', '--sandbox', 'read-only',
    '--skip-git-repo-check', '--ignore-user-config', '-c', `mcp_servers.ibkr={url="${URL}"}`,
    '-C', '/private/tmp', '-m', 'gpt-5.6-luna', '-c', 'model_reasoning_effort="low"', prompt],
  { stdio: ['ignore', 'pipe', 'pipe'] });
  const seen = new Set();
  let line = '', fatal = null;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    if (fatal) return;
    line += chunk;
    if (Buffer.byteLength(line) > 6 * 1024 * 1024) { fatal = new Error('MCP_EVENT_TOO_LARGE'); child.kill(); return; }
    while (line.includes('\n')) {
      const index = line.indexOf('\n'), fragment = line.slice(0, index); line = line.slice(index + 1);
      try {
        const result = parseCodexIbEvent(JSON.parse(fragment));
        if (!result) continue;
        if (!expected.has(result.sourceKey)) throw new Error('UNEXPECTED_MCP_TOOL');
        if (seen.has(result.sourceKey)) throw new Error('DUPLICATE_MCP_READ');
        const rawFile = path.join(dir, `${result.sourceKey}.native.json`);
        const fd = fs.openSync(rawFile, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        try { fs.fchmodSync(fd, 0o600); fs.writeFileSync(fd, `${JSON.stringify(result.raw)}\n`); fs.fsyncSync(fd); }
        finally { fs.closeSync(fd); }
        finishSourceCapture(dir, result.sourceKey, rawFile, { journalPath });
        seen.add(result.sourceKey);
      } catch (error) { fatal = error; child.kill(); return; }
    }
  });
  child.stderr.resume(); // Never forward CLI diagnostics or source values to a shared log.
  const exitCode = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  if (fatal) throw fatal;
  if (exitCode !== 0 || line.trim() || seen.size !== expected.size)
    throw new Error('INCOMPLETE_IB_MCP_CAPTURE');
  return { status: 'captured', sources: [...seen] };
}

export function captureCodexIb({ dir, journalPath, spawnCodex = spawn }) {
  return captureCodexIbSet({ dir, journalPath, toolNames: Object.keys(TOOL_KEYS), prompt: PROMPT, spawnCodex });
}

export function captureCodexIbAction({ dir, journalPath, spawnCodex = spawn }) {
  return captureCodexIbSet({ dir, journalPath, toolNames: ACTION_TOOLS, prompt: ACTION_PROMPT, spawnCodex });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [dir, journalPath] = process.argv.slice(2);
  if (!dir || !journalPath || process.argv.length !== 4) throw new Error('USAGE: capture DIR JOURNAL');
  const result = await captureCodexIb({ dir, journalPath });
  process.stdout.write(`${result.status} ${result.sources.length} IB sources\n`);
}
