// Loaded only from trusted main. GitHub authenticates the executor and bytes;
// the executor, not GitHub, is responsible for obtaining human chat consent.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
const OWNER = { login: 'huanwujoy-crypto', id: 283054367 };
const REPO = 'huanwujoy-crypto/fee-console';
const registry = JSON.parse(fs.readFileSync(new URL('../security/approval-tiers.json', import.meta.url), 'utf8'));
export const approvalRegistry = registry;
const sameOwner = user => user?.login === OWNER.login && user?.id === OWNER.id && user?.type === 'User';

export function verifyExecutor({ base, head, pr, commit }) {
  if (!/^[a-f0-9]{40}$/.test(base ?? '') || !/^[a-f0-9]{40}$/.test(head ?? '')) return false;
  return pr?.state === 'open' && pr.draft === false && sameOwner(pr.user)
    && !String(pr.body ?? '').includes('/require-specific-owner-approval')
    && pr.base?.repo?.full_name === REPO && pr.base.ref === 'main' && pr.base.sha === base
    && pr.head?.repo?.full_name === REPO && pr.head.sha === head
    && commit?.sha === head && commit.parents?.length === 1 && commit.parents[0].sha === base
    && sameOwner(commit.author)
    && (sameOwner(commit.committer) || (commit.committer?.login === 'web-flow' && commit.committer.id === 19864447))
    && commit.commit?.verification?.verified === true && commit.commit.verification.reason === 'valid';
}

// A path tier delegates semantic review to the trusted executor. It does not
// prove that arbitrary JS preserves financial, account or security semantics.
export function classifyChanges(entries, policy = registry) {
  const validPath = p => typeof p === 'string' && p && !p.startsWith('/')
    && !p.split('/').some(part => !part || part === '.' || part === '..')
    && !/[\\\r\n\0]/.test(p);
  if (policy?.schema !== 'fee-console.approval-tiers.v1'
    || !['ordinaryFiles', 'sensitiveFiles', 'sensitivePrefixes'].every(k => Array.isArray(policy[k]) && policy[k].every(validPathForRegistry))) return 'specific';
  function validPathForRegistry(p) { return typeof p === 'string' && validPath(p.endsWith('/') ? p.slice(0, -1) : p); }
  const ordinary = new Set(policy.ordinaryFiles);
  const sensitive = new Set(policy.sensitiveFiles);
  if (ordinary.size !== policy.ordinaryFiles.length || sensitive.size !== policy.sensitiveFiles.length
    || [...ordinary].some(p => sensitive.has(p) || policy.sensitivePrefixes.some(prefix => p.startsWith(prefix)))) return 'specific';
  if (!Array.isArray(entries) || !entries.length || entries.length > 1000) return 'specific';
  for (const entry of entries) {
    if (!entry || !validPath(entry.path) || entry.previousPath !== undefined
      || entry.status !== 'M' || entry.baseMode !== '100644' || entry.headMode !== '100644'
      || !ordinary.has(entry.path) || sensitive.has(entry.path)
      || policy.sensitivePrefixes.some(prefix => entry.path.startsWith(prefix))) return 'specific';
  }
  if (new Set(entries.map(entry => entry.path)).size !== entries.length) return 'specific';
  return 'ordinary';
}

export function verifyOrdinaryChange({ entries, ...identity }) {
  return verifyExecutor(identity) === true && classifyChanges(entries) === 'ordinary';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [base, head, prPath, commitPath] = process.argv.slice(2);
    if (!/^[a-f0-9]{40}$/.test(base ?? '') || !/^[a-f0-9]{40}$/.test(head ?? '')) throw Error();
    const git = args => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 3_000_000 });
    const names = git(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-status', '-z', base, head]).split('\0');
    if (names.pop() !== '' || !names.length || names.length % 2) throw Error();
    const mode = (ref, file) => git(['ls-tree', ref, '--', file]).split(' ')[0];
    const entries = [];
    for (let i = 0; i < names.length; i += 2) {
      const file = names[i + 1];
      if (names[i] !== 'M' || !registry.ordinaryFiles.includes(file)) throw Error();
      entries.push({ path: file, status: names[i], baseMode: mode(base, file), headMode: mode(head, file) });
      // Read full blobs, never execute them or expose their contents in logs.
      for (const ref of [base, head]) {
        const blob = execFileSync('git', ['show', `${ref}:${file}`], { maxBuffer: 2_000_000 });
        if (blob.includes(0)) throw Error();
        new TextDecoder('utf-8', { fatal: true }).decode(blob);
      }
    }
    const completeDiff = git(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--binary', base, head]);
    const diffHash = createHash('sha256').update(completeDiff).digest('hex');
    const valid = verifyOrdinaryChange({ base, head, entries,
      pr: JSON.parse(fs.readFileSync(prPath, 'utf8')), commit: JSON.parse(fs.readFileSync(commitPath, 'utf8')),
    });
    if (!valid) throw Error();
    console.log(`Ordinary code repair by verified trusted executor at exact head ${head}, complete diff SHA256 ${diffHash}; chat consent is enforced by executor, not independently verified by GitHub. Required checks still apply.`);
  } catch {
    console.error('Not eligible for ordinary executor authorization; specific exact-head OWNER approval is required.');
    process.exitCode = 1;
  }
}
