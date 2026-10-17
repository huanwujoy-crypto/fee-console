// Real Git regression for the actual private codeIdentity method. Only public
// source bytes are read; all Git repositories and mutations are temporary.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import vm from 'node:vm';

const PREFIX='maintenance/ib-orders-fresh-execution-v1/';
const PUBLIC_BUNDLE=fileURLToPath(new URL('../../'+PREFIX,import.meta.url));
const ENTRY='xuan-ib-orders-fresh.mjs';
const SOURCE=await fs.readFile(path.join(PUBLIC_BUNDLE,ENTRY),'utf8');
const START='async codeIdentity(){',END='},async read(n)';
assert.equal(SOURCE.split(START).length-1,1,'EXACTLY_ONE_ACTUAL_CODE_IDENTITY_METHOD');
assert.equal(SOURCE.split(END).length-1,1,'EXACTLY_ONE_ACTUAL_CODE_IDENTITY_END');
const begin=SOURCE.indexOf(START)+START.length,end=SOURCE.indexOf(END,begin);
assert.ok(end>begin,'BOUNDED_METHOD_EXTRACTION');
const ACTUAL_BODY=SOURCE.slice(begin,end);
const listMatch=SOURCE.match(/export const CODE_FILES=Object\.freeze\((\[[\s\S]*?\])\);/);
assert.ok(listMatch,'ACTUAL_RUNTIME_MEMBER_LIST');
const CODE_FILES=[];
const remainder=listMatch[1].replace(/'([^'\n]+)'/g,(_all,name)=>{CODE_FILES.push(name);return '';}).replace(/[\s,\[\]]/g,'');
assert.equal(remainder,'','RUNTIME_LIST_IS_ONLY_STRING_DATA');
assert.equal(CODE_FILES.length,9);assert.equal(new Set(CODE_FILES).size,9);
for(const name of CODE_FILES)assert.ok(!path.isAbsolute(name)&&!name.split('/').includes('..'),'PUBLIC_RELATIVE_RUNTIME_MEMBER');
Object.freeze(CODE_FILES);
const PUBLIC_BYTES=new Map(await Promise.all(CODE_FILES.map(async name=>[name,await fs.readFile(path.join(PUBLIC_BUNDLE,name))])));
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const same=(left,right)=>JSON.stringify(left)===JSON.stringify(right);

function lowerImport(body){
  let count=0;const lowered=body.replace(/await import\('node:child_process'\)/g,()=>{count++;return 'await loadReadOnlyGit()';});
  assert.equal(count,1,'ONE_CONTROLLED_CHILD_PROCESS_IMPORT');assert.equal(/\bimport\s*\(/.test(lowered),false,'NO_OTHER_DYNAMIC_IMPORT');
  return lowered;
}

async function setupGit(cwd,args){
  // No inherited HOME, global signing, credential helper, template hook or
  // remote is used by this local-only fixture setup.
  return new Promise((resolve,reject)=>execFile('/usr/bin/git',args,{cwd,encoding:'utf8',maxBuffer:2000000,
    env:{PATH:'/usr/bin:/bin',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',
      GIT_AUTHOR_DATE:'2001-01-01T00:00:00Z',GIT_COMMITTER_DATE:'2001-01-01T00:00:00Z'}},
  (error,stdout,stderr)=>error?reject(Object.assign(Error('SYNTHETIC_GIT_SETUP_FAILED'),{cause:error,stderr})):resolve(stdout.trim())));
}

async function fixture(action){
  const temporary=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'fresh git identity ')));
  const repository=path.join(temporary,'synthetic repository with spaces'),here=path.resolve(repository,PREFIX);
  const template=path.join(temporary,'empty git templates'),unrelated=path.join(temporary,'unrelated working directory');
  await fs.mkdir(template);await fs.mkdir(unrelated);await fs.mkdir(here,{recursive:true});
  try{
    await setupGit(temporary,['init','--quiet','--initial-branch=main','--template='+template,repository]);
    for(const [key,value]of [['user.name','Synthetic Git Identity Test'],['user.email','synthetic-git-identity@example.invalid'],
      ['commit.gpgsign','false'],['core.hooksPath','/dev/null'],['core.fsmonitor','false'],['core.fileMode','true'],['core.autocrlf','false']]){
      await setupGit(repository,['config','--local',key,value]);
    }
    assert.equal((await fs.readFile(path.join(repository,'.git/config'),'utf8')).includes('[remote '),false,'NO_REMOTE_CONFIGURED');
    for(const [name,bytes]of PUBLIC_BYTES){const filename=path.join(here,name);await fs.mkdir(path.dirname(filename),{recursive:true});await fs.writeFile(filename,bytes,{mode:0o644});}
    await fs.writeFile(path.join(repository,'synthetic-root-control.txt'),'synthetic tracked root file\n');
    const deep=path.join(here,'untracked empty deep directory','more spaces');await fs.mkdir(deep,{recursive:true});
    await setupGit(repository,['add','--all']);await setupGit(repository,['commit','--quiet','--no-gpg-sign','-m','Synthetic runtime fixture']);
    const head=await setupGit(repository,['rev-parse','--verify','HEAD']),tree=await setupGit(repository,['rev-parse','--verify','HEAD^{tree}']);
    assert.equal(await setupGit(repository,['status','--porcelain','--untracked-files=all']),'');
    return await action({temporary,repository,here,deep,unrelated,identity:{head,tree},git:args=>setupGit(repository,args)});
  }finally{await fs.rm(temporary,{recursive:true,force:true});}
}

function harness(f,{legacy=false,here=f.here}={}){
  const calls={imports:0,git:[],lsTree:[],show:[],read:[]},relativePaths=new Set(CODE_FILES.map(name=>PREFIX+name));
  const allowedReads=new Set(CODE_FILES.map(name=>path.join(here,name)));
  const readOnlyExecFile=(executable,args,options,callback)=>{
    assert.equal(executable,'/usr/bin/git','ONLY_REAL_READ_ONLY_GIT');assert.equal(options.cwd,here,'EVERY_GIT_COMMAND_USES_NAMESPACE_CWD');
    assert.deepEqual(Array.from(args.slice(0,2)),['-c','core.fsmonitor=false'],'NO_EXTERNAL_FSMONITOR_HELPER');
    const actualArgs=args;args=args.slice(2);
    assert.deepEqual(Object.keys(options.env),['PATH','GIT_OPTIONAL_LOCKS']);assert.equal(options.env.PATH,'/usr/bin:/bin');assert.equal(options.env.GIT_OPTIONAL_LOCKS,'0');
    assert.equal(options.maxBuffer,2000000);assert.equal(options.shell,undefined,'NO_SHELL');
    const simple=[['rev-parse','--show-toplevel'],['status','--porcelain','--untracked-files=all'],['rev-parse','--verify','HEAD'],['rev-parse','--verify','HEAD^{tree}']];
    const isTree=(args.length===5&&same(args.slice(0,4),['ls-tree','--full-tree','HEAD','--'])&&relativePaths.has(args[4]))
      ||(args.length===4&&same(args.slice(0,3),['ls-tree','HEAD','--'])&&relativePaths.has(args[3]));
    const isShow=args.length===2&&args[0]==='show'&&args[1].startsWith('HEAD:')&&relativePaths.has(args[1].slice(5));
    assert.ok(simple.some(command=>same(args,command))||isTree||isShow,'ONLY_SIX_NATIVE_GIT_READ_SIGNATURES');
    assert.equal(options.encoding,isShow?'buffer':'utf8');
    const record={args:[...args],cwd:options.cwd,encoding:options.encoding};calls.git.push(record);
    if(isTree)calls.lsTree.push(record);if(isShow)calls.show.push(record);
    return execFile(executable,actualArgs,options,(error,stdout,stderr)=>{
      record.exitCode=error?.code??0;record.stderr=String(stderr);record.stdoutBytes=Buffer.byteLength(stdout);
      if(isTree)record.stdout=String(stdout);if(isShow)record.buffer=Buffer.isBuffer(stdout);
      callback(error,stdout,stderr);
    });
  };
  let body=ACTUAL_BODY;
  if(legacy){let count=0;body=body.replace(/\['ls-tree','--full-tree','HEAD','--',relative\]/g,()=>{count++;return "['ls-tree','HEAD','--',relative]";});
    assert.equal(count,1,'ONE_REMOVAL_RECONSTRUCTS_ACTUAL_PRE_FIX_METHOD');}
  // The method body is used verbatim except its single dynamic-import seam.
  // No product module/factory/entry is imported, exported or called.
  const context=vm.createContext(Object.create(null));
  const AsyncFunction=vm.runInContext('Object.getPrototypeOf(async function(){}).constructor',context);
  const method=new AsyncFunction('loadReadOnlyGit','HERE','CODE_FILES','path','fs','sha','fail',lowerImport(body));
  const filesystem={async readFile(filename){assert.ok(allowedReads.has(filename),'ONLY_NINE_TEMP_RUNTIME_FILES_CAN_BE_READ');calls.read.push(filename);return fs.readFile(filename);}};
  const run=()=>method(async()=>{calls.imports++;return {execFile:readOnlyExecFile};},here,CODE_FILES,path,filesystem,sha,code=>{throw Error(code);});
  return {run,calls};
}

function expectAllNine(f,h){
  assert.equal(h.calls.imports,1);assert.equal(h.calls.git.length,22);assert.equal(h.calls.lsTree.length,9);assert.equal(h.calls.show.length,9);assert.equal(h.calls.read.length,9);
  assert.deepEqual(h.calls.lsTree.map(row=>row.args.at(-1)),CODE_FILES.map(name=>PREFIX+name));
  assert.deepEqual(h.calls.show.map(row=>row.args[1]),CODE_FILES.map(name=>'HEAD:'+PREFIX+name));
  assert.deepEqual(h.calls.read,CODE_FILES.map(name=>path.join(f.here,name)));
  for(const row of h.calls.lsTree){assert.equal(row.exitCode,0);assert.match(row.stdout,/^100644 blob [a-f0-9]{40}\t/);assert.equal(row.stdout.trim().split('\t')[1],row.args.at(-1));}
  for(const row of h.calls.show){assert.equal(row.exitCode,0);assert.equal(row.buffer,true);assert.ok(row.stdoutBytes>0);}
}

test('extraction uses one actual private method and nine public data members without importing the entry',()=>{
  assert.ok(ACTUAL_BODY.includes("const root=await run(['rev-parse','--show-toplevel'])"));
  assert.ok(ACTUAL_BODY.includes("return {head,tree}"));assert.equal(CODE_FILES.length,PUBLIC_BYTES.size);
  const context=vm.createContext(Object.create(null));assert.equal(vm.runInContext('typeof process+":"+typeof fetch+":"+typeof require',context),'undefined:undefined:undefined');
});

test('actual Git identity is independent of process cwd and catches all nine hidden disk drifts',async t=>fixture(async f=>{
  for(const [name,directory]of [['repository root',f.repository],['bundle namespace',f.here],['deep namespace',f.deep],['unrelated directory',f.unrelated]]){
    await t.test('normal from '+name,async()=>{
      const original=process.cwd();try{process.chdir(directory);const h=harness(f),identity=await h.run();
        assert.deepEqual({...identity},f.identity);assert.equal(process.cwd(),directory);expectAllNine(f,h);
      }finally{process.chdir(original);}
    });
  }
  await t.test('actual pre-fix method fails on the first empty cwd-relative ls-tree result',async()=>{
    const h=harness(f,{legacy:true});await assert.rejects(h.run(),/CODE_MISMATCH/);
    assert.equal(h.calls.lsTree.length,1);assert.equal(h.calls.lsTree[0].exitCode,0);assert.equal(h.calls.lsTree[0].stdout,'');
    assert.equal(h.calls.lsTree[0].args.at(-1),PREFIX+CODE_FILES[0]);assert.equal(h.calls.show.length,0);assert.equal(h.calls.read.length,0);
  });
  for(const [index,name]of CODE_FILES.entries())await t.test('clean-status assume-unchanged disk drift: '+name,async()=>{
    const relative=PREFIX+name,filename=path.join(f.here,name),before=PUBLIC_BYTES.get(name);
    try{
      await f.git(['update-index','--assume-unchanged','--',relative]);await fs.writeFile(filename,Buffer.concat([before,Buffer.from('\nSYNTHETIC_DISK_DRIFT\n')]));
      assert.equal(await f.git(['status','--porcelain','--untracked-files=all']),'','INDEX_HINT_MUST_HIDE_DRIFT_FROM_STATUS');
      const h=harness(f);await assert.rejects(h.run(),/CODE_MISMATCH/);
      assert.equal(h.calls.lsTree.length,index+1);assert.equal(h.calls.show.length,index+1);assert.equal(h.calls.read.length,index+1);
      assert.equal(h.calls.show.at(-1).args[1],'HEAD:'+relative);assert.equal(h.calls.read.at(-1),filename);
    }finally{await fs.writeFile(filename,before);await f.git(['update-index','--no-assume-unchanged','--',relative]);}
    assert.equal(await f.git(['status','--porcelain','--untracked-files=all']),'');
  });
}));

test('actual Git identity fails closed for dirty paths, file modes and namespace drift',async t=>{
  const dirtyCases={
    'tracked runtime changed':async f=>fs.appendFile(path.join(f.here,CODE_FILES[0]),'\nSYNTHETIC_DIRTY\n'),
    'tracked root file outside namespace changed':async f=>fs.appendFile(path.join(f.repository,'synthetic-root-control.txt'),'SYNTHETIC_DIRTY\n'),
    'untracked file inside namespace':async f=>fs.writeFile(path.join(f.here,'synthetic untracked.txt'),'synthetic\n'),
    'untracked file at repository root':async f=>fs.writeFile(path.join(f.repository,'synthetic root untracked.txt'),'synthetic\n'),
    'runtime deleted':async f=>fs.unlink(path.join(f.here,CODE_FILES[0])),
    'runtime executable bit changed':async f=>fs.chmod(path.join(f.here,CODE_FILES[0]),0o755),
  };
  for(const [name,mutate]of Object.entries(dirtyCases))await t.test(name,async()=>fixture(async f=>{
    await mutate(f);assert.notEqual(await f.git(['status','--porcelain','--untracked-files=all']),'');
    const h=harness(f);await assert.rejects(h.run(),/CODE_MISMATCH/);assert.equal(h.calls.git.length,2);
    assert.equal(h.calls.lsTree.length,0);assert.equal(h.calls.show.length,0);assert.equal(h.calls.read.length,0);
  }));
  await t.test('wrong bundle location rejects before tree or blob access',async()=>fixture(async f=>{
    const wrong=path.join(f.repository,'wrong bundle namespace');await fs.mkdir(wrong);
    const h=harness(f,{here:wrong});await assert.rejects(h.run(),/CODE_MISMATCH/);
    assert.equal(h.calls.git.length,1);assert.equal(h.calls.lsTree.length,0);assert.equal(h.calls.read.length,0);
  }));
  for(const kind of ['executable-mode','missing-member'])await t.test('clean committed '+kind+' rejects the tracked row',async()=>fixture(async f=>{
    const name=CODE_FILES[0],relative=PREFIX+name;
    if(kind==='executable-mode')await fs.chmod(path.join(f.here,name),0o755);else await fs.unlink(path.join(f.here,name));
    await f.git(['add','--all']);await f.git(['commit','--quiet','--no-gpg-sign','-m','Synthetic invalid tracked row']);
    assert.equal(await f.git(['status','--porcelain','--untracked-files=all']),'');
    const h=harness(f);await assert.rejects(h.run(),/CODE_MISMATCH/);assert.equal(h.calls.lsTree.length,1);
    if(kind==='executable-mode')assert.match(h.calls.lsTree[0].stdout,/^100755 blob /);else assert.equal(h.calls.lsTree[0].stdout,'');
    assert.equal(h.calls.show.length,0);assert.equal(h.calls.read.length,0);
  }));
});
