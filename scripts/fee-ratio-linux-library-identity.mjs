// Unwired Linux identity-reader candidate. No source contents, networking,
// xattr writes, accepted proofs, provider attestation or publication authority.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const fail = () => { throw Error('RATIO_LINUX_LIBRARY_IDENTITY_REFUSED'); };
const PYTHON_ALIAS = '/usr/bin/python3';
const META = ['dev','ino','mode','uid','gid','nlink','size','mtimeNs','ctimeNs'];
const sameStat = (a,b) => META.every(k => a[k] === b[k]);
const mode = s => s.mode & 0o777n;
const hooks = env => Object.keys(env).some(k => /^(?:LD_|DYLD_)/.test(k)
  || ['NODE_OPTIONS','NODE_PATH','PYTHONPATH','PYTHONHOME','PYTHONSTARTUP','PYTHONINSPECT','PYTHONUSERBASE'].includes(k));
const preload = args => args.some(a => /^(?:--(?:inspect(?:-brk|-wait)?|require|import|loader|experimental-loader)(?:=|$)|-r)/.test(a));

// This code reads only metadata/xattrs from an O_NOFOLLOW descriptor. Both
// xattrs and descriptor/path metadata are rechecked; source bytes are not read.
const PYTHON = String.raw`import os, sys, stat, json, re
def refuse():
    raise ValueError("identity refused")
def signature(s):
    return tuple(getattr(s, k) for k in ("st_dev", "st_ino", "st_mode", "st_uid", "st_gid", "st_nlink", "st_size", "st_mtime_ns", "st_ctime_ns"))
def private_path(file):
    if not os.path.isabs(file) or os.path.normpath(file) != file or os.path.realpath(file) != file:
        refuse()
    parent = os.path.dirname(file)
    d = os.lstat(parent)
    if not stat.S_ISDIR(d.st_mode) or d.st_uid != os.getuid() or stat.S_IMODE(d.st_mode) != 0o700:
        refuse()
    at = parent
    while True:
        try:
            os.lstat(os.path.join(at, ".git"))
        except FileNotFoundError:
            pass
        else:
            refuse()
        next_at = os.path.dirname(at)
        if next_at == at:
            break
        at = next_at
    return signature(d)
def source_stat(s):
    if not stat.S_ISREG(s.st_mode) or s.st_uid != os.getuid() or s.st_nlink != 1 or stat.S_IMODE(s.st_mode) != 0o600:
        refuse()
    return signature(s)
def attributes(fd):
    identity = os.getxattr(fd, "user.library-file-id")
    version = os.getxattr(fd, "user.library-file-version")
    if not isinstance(identity, bytes) or not re.fullmatch(rb"libfile_[a-f0-9]{32}", identity):
        refuse()
    if not isinstance(version, bytes) or not re.fullmatch(rb"0|[1-9][0-9]{0,15}", version) or int(version) > 9007199254740991:
        refuse()
    return identity.decode("ascii"), version.decode("ascii")
def read():
    if len(sys.argv) != 2 or not hasattr(os, "getxattr") or not hasattr(os, "O_NOFOLLOW") or not hasattr(os, "O_CLOEXEC"):
        refuse()
    file = sys.argv[1]
    parent = private_path(file)
    before = source_stat(os.lstat(file))
    fd = os.open(file, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        if source_stat(os.fstat(fd)) != before:
            refuse()
        first = attributes(fd)
        second = attributes(fd)
        if first != second or source_stat(os.fstat(fd)) != before or source_stat(os.lstat(file)) != before or private_path(file) != parent:
            refuse()
        return {"libraryFileId": first[0], "version": first[1]}
    finally:
        os.close(fd)
try:
    print(json.dumps(read(), separators=(",", ":")))
except Exception:
    sys.exit(2)
`;

function source(file, uid) {
  if (typeof file !== 'string' || file.length > 4096 || file.includes('\0')
    || !path.isAbsolute(file) || path.normalize(file) !== file || fs.realpathSync(file) !== file) fail();
  const s = fs.lstatSync(file, {bigint:true});
  if (!s.isFile() || s.isSymbolicLink() || s.uid !== uid || s.nlink !== 1n || mode(s) !== 0o600n) fail();
  const parent = path.dirname(file), d = fs.lstatSync(parent, {bigint:true});
  if (!d.isDirectory() || d.isSymbolicLink() || d.uid !== uid || mode(d) !== 0o700n) fail();
  for (let at = parent;; at = path.dirname(at)) {
    try { fs.lstatSync(path.join(at,'.git')); fail(); }
    catch (e) { if (e?.code !== 'ENOENT') fail(); }
    if (at === path.dirname(at)) break;
  }
  return {file:s, parent:d};
}
function notWritable(file) {
  try { fs.accessSync(file, fs.constants.W_OK); }
  catch (e) { if (['EACCES','EPERM','EROFS'].includes(e?.code)) return; fail(); }
  fail();
}
function dependency(uid) {
  const binary = fs.realpathSync(PYTHON_ALIAS);
  if (!/^\/usr\/bin\/python3(?:\.[0-9]{1,3})?$/.test(binary)) fail();
  const paths = ['/usr','/usr/bin',PYTHON_ALIAS,binary];
  const stats = paths.map(file => fs.lstatSync(file, {bigint:true}));
  const systemUid = stats[0].uid;
  if (systemUid === uid || stats.some(s => s.uid !== systemUid)) fail();
  for (let i = 0; i < paths.length; i++) {
    const s = stats[i];
    if (i < 2 ? !s.isDirectory() || s.isSymbolicLink() : i === 3 ? !s.isFile() || s.isSymbolicLink() : !(s.isFile() || s.isSymbolicLink())) fail();
    // Symlink write bits are not access rights; its system-owned directory and
    // resolved binary must be nonwritable. No special meaning is given to UID 65534.
    if (!s.isSymbolicLink() && ((s.mode & 0o022n) !== 0n)) fail();
    notWritable(paths[i]);
  }
  return {binary, stats};
}

// Explicit opt-in only. No argument can select a runtime, interpreter, identity
// value or verifier. null means disabled, never an identity or accepted proof.
export function readLinuxLibraryIdentity(file, options = {}) {
  try {
    if (!options || typeof options !== 'object' || Array.isArray(options)
      || Reflect.ownKeys(options).some(k => k !== 'enabled') || arguments.length > 2) fail();
    const descriptor = Object.getOwnPropertyDescriptor(options, 'enabled');
    if (descriptor && !Object.hasOwn(descriptor,'value')) fail();
    const enabled = descriptor ? descriptor.value : false;
    if (typeof enabled !== 'boolean') fail();
    if (!enabled) return null;
    if (process.platform !== 'linux' || typeof process.getuid !== 'function' || hooks(process.env) || preload(process.execArgv)) fail();
    const uid = BigInt(process.getuid()), before = source(file, uid), dep = dependency(uid);
    const reply = spawnSync(dep.binary, ['-I','-S','-B','-c',PYTHON,file], {
      env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8',LC_ALL:'C.UTF-8',PYTHONIOENCODING:'utf-8'},
      encoding:'utf8', timeout:2000, maxBuffer:4096, stdio:['ignore','pipe','pipe'], windowsHide:true,
    });
    if (reply.error || reply.status !== 0 || reply.signal || reply.stderr !== '' || typeof reply.stdout !== 'string' || reply.stdout.length > 256) fail();
    const after = source(file, uid), next = dependency(uid);
    if (!sameStat(before.file, after.file) || !sameStat(before.parent, after.parent)
      || dep.binary !== next.binary || dep.stats.some((s,i) => !sameStat(s,next.stats[i]))) fail();
    const identity = JSON.parse(reply.stdout);
    if (!identity || Object.keys(identity).sort().join(',') !== 'libraryFileId,version'
      || !/^libfile_[a-f0-9]{32}$/.test(identity.libraryFileId || '') || typeof identity.version !== 'string'
      || !/^(?:0|[1-9][0-9]{0,15})$/.test(identity.version) || !Number.isSafeInteger(Number(identity.version))
      || reply.stdout !== JSON.stringify({libraryFileId:identity.libraryFileId,version:identity.version})+'\n') fail();
    return Object.freeze({libraryFileId:identity.libraryFileId,version:identity.version});
  } catch { fail(); }
}
