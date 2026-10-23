// Convert a pinned, already-published static report. Never collect, recalculate,
// refresh, discover credentials, upload, commit, CAS or alter the private source.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {MAX_ACTION_HTML_BYTES, actionSha256, packagePublishedAction} from './xuan-ib-encrypted-action.mjs';

export {packagePublishedAction} from './xuan-ib-encrypted-action.mjs';

function readPrivate(file, max) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > max || (stat.mode & 0o077)
      || (process.getuid && stat.uid !== process.getuid())) throw new Error('ACTION_PRIVATE_INPUT');
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}
export async function runActionPackage(args, env = process.env) {
  const allowed = ['--input', '--receipt', '--output'];
  const opts = {};
  if (args.length !== 6) throw new Error('ACTION_ARGUMENTS');
  for (let i = 0; i < args.length; i += 2) {
    if (!allowed.includes(args[i]) || opts[args[i]] || !path.isAbsolute(args[i + 1] || '')) throw new Error('ACTION_ARGUMENTS');
    opts[args[i]] = args[i + 1];
  }
  if (new Set(Object.values(opts)).size !== 3 || !env.FEE_DATA_KEY) throw new Error('ACTION_INPUTS');
  const bytes = readPrivate(opts['--input'], MAX_ACTION_HTML_BYTES);
  const receipt = JSON.parse(readPrivate(opts['--receipt'], 128 * 1024));
  const envelope = await packagePublishedAction({htmlBytes: bytes, receipt, masterKey: env.FEE_DATA_KEY});
  // Never overwrite even an earlier uncertain output. Ciphertext only.
  fs.writeFileSync(opts['--output'], envelope, {flag: 'wx', mode: 0o600});
  return {status: 'encrypted-copy-prepared', bytes: Buffer.byteLength(envelope), sha256: await actionSha256(Buffer.from(envelope))};
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await runActionPackage(process.argv.slice(2)))); }
  catch { console.error('ACTION_PACKAGE_FAILED; source and publication unchanged'); process.exitCode = 1; }
}
