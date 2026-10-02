// Loaded only from trusted main. GitHub authenticates the executor and bytes;
// the executor, not GitHub, is responsible for obtaining human chat consent.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const OWNER = { login: 'huanwujoy-crypto', id: 283054367 };
const REPO = 'huanwujoy-crypto/fee-console';
const PATH = 'xuan-ib/index.html';
const sameOwner = user => user?.login === OWNER.login && user?.id === OWNER.id && user?.type === 'User';

export function verifyExecutor({ base, head, pr, commit }) {
  if (!/^[a-f0-9]{40}$/.test(base ?? '') || !/^[a-f0-9]{40}$/.test(head ?? '')) return false;
  return pr?.state === 'open' && pr.draft === false && sameOwner(pr.user)
    && pr.base?.repo?.full_name === REPO && pr.base.ref === 'main' && pr.base.sha === base
    && pr.head?.repo?.full_name === REPO && pr.head.sha === head
    && commit?.sha === head && commit.parents?.length === 1 && commit.parents[0].sha === base
    && sameOwner(commit.author)
    && (sameOwner(commit.committer) || (commit.committer?.login === 'web-flow' && commit.committer.id === 19864447))
    && commit.commit?.verification?.verified === true && commit.commit.verification.reason === 'valid';
}

// Only literal integer font sizes in the loader's original head stylesheet.
// No selectors, rules, whitespace, markup, scripts or other bytes may change.
export function ordinaryTypography(before, after) {
  if (typeof before !== 'string' || typeof after !== 'string' || before === after
      || before.length > 2_000_000 || after.length > 2_000_000 || /\0/.test(before + after)) return false;
  const normalize = html => {
    const start = html.indexOf('  <style>');
    const end = html.indexOf('  </style>', start);
    if (start < 0 || end < 0 || start > html.indexOf('</head>') || end > html.indexOf('</head>')) return null;
    const css = html.slice(start, end);
    // Mark strings/comments without rewriting them; matching inside either
    // cannot become a typography exception. Reject ambiguous CSS escapes.
    const protectedBytes = new Set();
    for (let i = 0; i < css.length; i++) {
      if (css[i] === '\\') return null;
      let end;
      if (css.slice(i, i + 2) === '/*') {
        end = css.indexOf('*/', i + 2);
        if (end < 0) return null;
        end += 1;
      } else if (css[i] === '"' || css[i] === "'") {
        end = css.indexOf(css[i], i + 1);
        if (end < 0 || css.slice(i, end).includes('\\')) return null;
      } else continue;
      for (let j = i; j <= end; j++) protectedBytes.add(j);
      i = end;
    }
    let count = 0;
    const normalized = css.replace(/([;{]\s*font-size:\s*)(\d+)(px\s*;)/g, (all, prefix, number, suffix, offset) => {
      for (let i = offset; i < offset + all.length; i++) if (protectedBytes.has(i)) return all;
      if (+number < 12 || +number > 24) return all;
      count++;
      return `${prefix}<ordinary-font-size>${suffix}`;
    });
    return { text: html.slice(0, start) + normalized + html.slice(end), count };
  };
  const a = normalize(before), b = normalize(after);
  return a !== null && b !== null && a.count > 0 && a.count === b.count && a.text === b.text;
}

export function verifyOrdinaryChange({ entries, before, after, ...identity }) {
  return verifyExecutor(identity) && Array.isArray(entries) && entries.length === 1
    && entries[0].path === PATH && entries[0].status === 'M'
    && entries[0].baseMode === '100644' && entries[0].headMode === '100644'
    && ordinaryTypography(before, after);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [base, head, prPath, commitPath] = process.argv.slice(2);
    if (!/^[a-f0-9]{40}$/.test(base ?? '') || !/^[a-f0-9]{40}$/.test(head ?? '')) throw Error();
    const git = args => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 3_000_000 });
    const names = git(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-status', '-z', base, head]).split('\0');
    if (names.length !== 3 || names[0] !== 'M' || names[1] !== PATH || names[2] !== '') throw Error();
    const mode = ref => git(['ls-tree', ref, '--', PATH]).split(' ')[0];
    const valid = verifyOrdinaryChange({ base, head,
      pr: JSON.parse(fs.readFileSync(prPath, 'utf8')), commit: JSON.parse(fs.readFileSync(commitPath, 'utf8')),
      entries: [{ path: PATH, status: 'M', baseMode: mode(base), headMode: mode(head) }],
      before: git(['show', `${base}:${PATH}`]), after: git(['show', `${head}:${PATH}`]),
    });
    if (!valid) throw Error();
    console.log(`Ordinary typography change by verified trusted executor at exact head ${head}; chat consent is enforced by executor, not independently verified by GitHub. Required checks still apply.`);
  } catch {
    console.error('Not eligible for ordinary executor authorization; specific exact-head OWNER approval is required.');
    process.exitCode = 1;
  }
}
