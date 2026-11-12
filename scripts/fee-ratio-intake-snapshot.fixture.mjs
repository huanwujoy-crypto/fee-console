// Shared synthetic harness for intake -> snapshot composition tests. Test
// support only: a closed in-memory filesystem; no real files, xattrs,
// private directories, network or credentials. Moved unchanged out of
// fee-ratio-intake-snapshot.integration.test.mjs so the offline-assembler
// connection test can drive the same real consumers.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {prepareCollectedRatioInput} from './fee-ratio-source-collector.mjs';
import {stageIndependentRatioSnapshot} from './fee-ratio-snapshot-packet.mjs';
import {createRankedExposureCore} from './xuan-ib-sharesight-exposure.mjs';
import {createFeeRatioCore} from './fee-ratio-management.mjs';

export const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
export const NOW=new Date('2026-10-30T06:00:00.000Z');
export const WORKSPACE='/synthetic-ratio-integration/private'; // Never created on disk.
export const OUTPUT=path.join(WORKSPACE,'ratio-independent-candidate');

// Only the filesystem boundary is substituted. Production privateDir, pinned,
// frozen, process-local evidence WeakSet and all source/crypto checks still run.
export class SyntheticFs{
  constructor(){this.nodes=new Map();this.fds=new Map();this.next=10;this.writes=[];this.onWrite=null;this.mkdir('/');this.mkdir(path.dirname(WORKSPACE));this.mkdir(WORKSPACE);}
  get(p){const n=this.nodes.get(p);assert.ok(n,'unexpected synthetic path: '+p);return n;}
  mkdir(p,mode=0o700){assert.ok(!this.nodes.has(p));this.nodes.set(p,{kind:'dir',mode,uid:process.getuid(),nlink:1,ino:this.next++,dev:1,mtimeMs:1,ctimeMs:1});}
  put(p,value){const bytes=Buffer.isBuffer(value)||value instanceof Uint8Array?Buffer.from(value):Buffer.from(JSON.stringify(value));const n=this.nodes.get(p);this.nodes.set(p,{kind:'file',mode:0o600,uid:process.getuid(),nlink:1,ino:n?.ino??this.next++,dev:1,mtimeMs:(n?.mtimeMs??0)+1,ctimeMs:(n?.ctimeMs??0)+1,bytes});return {path:p,sha256:hash(bytes)};}
  stat(p){const n=this.get(p);return {...n,size:n.bytes?.length??0,isFile:()=>n.kind==='file',isDirectory:()=>n.kind==='dir',isSymbolicLink:()=>n.kind==='symlink'};}
  install(t){
    const methods={
      existsSync:p=>this.nodes.has(p),realpathSync:p=>{this.get(p);return p;},lstatSync:p=>this.stat(p),
      openSync:(p,flags)=>{assert.equal(flags,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);this.get(p);const fd=this.next++;this.fds.set(fd,p);return fd;},
      fstatSync:fd=>this.stat(this.fds.get(fd)),closeSync:fd=>{assert.ok(this.fds.delete(fd));},
      readFileSync:(p,encoding)=>{const bytes=Buffer.from(this.get(typeof p==='number'?this.fds.get(p):p).bytes);return encoding?bytes.toString(encoding):bytes;},
      mkdirSync:(p,options)=>this.mkdir(p,options.mode),
      writeFileSync:(p,bytes,options)=>{assert.equal(options.flag,'wx');assert.equal(options.mode,0o600);assert.ok(!this.nodes.has(p));this.get(path.dirname(p));this.put(p,Buffer.from(bytes));this.writes.push(p);this.onWrite?.(p);},
      unlinkSync:p=>{assert.equal(this.get(p).kind,'file');this.nodes.delete(p);},
      readdirSync:p=>[...this.nodes.keys()].filter(k=>k!==p&&path.dirname(k)===p).map(k=>path.basename(k)),
      rmdirSync:p=>{assert.equal(this.get(p).kind,'dir');assert.ok(![...this.nodes.keys()].some(k=>k!==p&&path.dirname(k)===p));this.nodes.delete(p);},
    };
    for(const [name,fn]of Object.entries(methods))t.mock.method(fs,name,fn);
    const forbidden=()=>assert.fail('network/subprocess forbidden in synthetic composition');
    t.mock.method(globalThis,'fetch',forbidden);
    for(const name of ['execFileSync','execSync','spawnSync','execFile','exec','spawn','fork'])t.mock.method(childProcess,name,forbidden);
    syncBuiltinESMExports();
    // Always restore the real modules first, so one failing test cannot leave
    // the substitutes installed for the next one.
    t.after(()=>{try{t.mock.restoreAll();syncBuiltinESMExports();}finally{assert.equal(this.fds.size,0,'all pinned descriptors closed');}});
  }
}

// `raw`/`originalBytes` are the original under test (hand-built or the offline
// assembler's actual output); `now` is the consumer clock for that original.
export async function makeFixture(t,{raw,originalBytes,now=NOW}){
  // Existing synthetic-only scope substitution. The default production scope
  // is tested separately below and never accepts these invented accounts.
  const exposureCore={...createRankedExposureCore(),ALL_TOGETHER_SCOPE_SHA256:hash(JSON.stringify([...raw.accounts].sort()))};
  const prepared=prepareCollectedRatioInput({originalBytes,expectedSha256:hash(originalBytes),now,exposureCore});
  const ratio=createFeeRatioCore(exposureCore,crypto.webcrypto);
  const manager=await ratio.deriveManager('0'.repeat(32),Buffer.alloc(32,7).toString('base64url'),'synthetic-owner-token-not-a-credential');
  assert.equal(manager.authenticationKey,undefined);
  const mem=new SyntheticFs(),source=mem.put(path.join(WORKSPACE,'original.json'),prepared.originalBytes),input=mem.put(path.join(WORKSPACE,'input.json'),prepared.inputBytes);
  assert.equal(source.sha256,prepared.sourceSha256);assert.equal(input.sha256,prepared.inputSha256);
  const identity={libraryFileId:'libfile_'+'b'.repeat(32),version:0};
  const evidence={schema:'fee-console.ratio-browser-evidence-plan.v1',workspace:WORKSPACE,source,input,library:{...identity},managerScopeId:manager.recipient.scopeId,localOwnerUid:process.getuid()};
  const plan={schema:'fee-console.ratio-snapshot-plan.v1',workspace:WORKSPACE,evidence:mem.put(path.join(WORKSPACE,'evidence.json'),evidence),recipient:mem.put(path.join(WORKSPACE,'recipient.json'),manager.recipient),previous:null};
  let identityReads=0;
  const runtime={uid:process.getuid(),readIdentity(file){assert.equal(file,source.path);identityReads++;return {...identity};}};
  mem.install(t);
  return {raw,prepared,mem,plan,evidence,identity,ratio,manager,exposureCore,
    identityReads:()=>identityReads,
    saveEvidence(){plan.evidence=mem.put(plan.evidence.path,evidence);},
    stage(extra={}){return stageIndependentRatioSnapshot({plan,now,environ:{},evidenceRuntime:runtime,exposureCore,...extra});},
    readOutput(name){return JSON.parse(mem.get(path.join(OUTPUT,name)).bytes);},
  };
}

