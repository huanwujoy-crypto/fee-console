// Closed synthetic OS/process substitutes only. No real source files or xattrs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {readLinuxLibraryIdentity} from './fee-ratio-linux-library-identity.mjs';

const moduleText=fs.readFileSync(new URL('./fee-ratio-linux-library-identity.mjs',import.meta.url),'utf8');
const evaluate=new Function('fs','path','spawnSync','process',moduleText.replace(/^import .*;\n/gm,'').replace(/^export /gm,'')+'\nreturn {readLinuxLibraryIdentity,PYTHON};');
const FILE='/synthetic/private/source.json', PARENT=path.dirname(FILE), BIN='/usr/bin/python3.13';
const ID='libfile_'+'a'.repeat(32), OUTPUT=JSON.stringify({libraryFileId:ID,version:'3'})+'\n';
const error=code=>Object.assign(Error('synthetic raw failure must not escape'),{code});
function stat(type,owner=1001,extra={}) {
  const bits={file:0o100600n,dir:0o40700n,systemDir:0o40755n,binary:0o100755n,link:0o120777n}[type];
  return {dev:1n,ino:2n,mode:bits,uid:BigInt(owner),gid:BigInt(owner),nlink:1n,size:100n,mtimeNs:10n,ctimeNs:10n,
    isFile:()=>['file','binary'].includes(type),isDirectory:()=>['dir','systemDir'].includes(type),isSymbolicLink:()=>type==='link',...extra};
}
function fixture({change,reply,env={},execArgv=[],platform='linux',writable=false,missing=false,onSpawn}={}) {
  const calls={fs:[],spawn:[]};let sourceCalls=0,parentCalls=0;
  const files=new Map([[FILE,stat('file')],[PARENT,stat('dir')],['/usr',stat('systemDir',0)],
    ['/usr/bin',stat('systemDir',0)],['/usr/bin/python3',stat('link',0)],[BIN,stat('binary',0)]]);
  const os={constants:{W_OK:2},realpathSync:p=>{
    calls.fs.push(['realpath',p]);if(missing&&p==='/usr/bin/python3')throw error('ENOENT');return p==='/usr/bin/python3'?BIN:p;
  },lstatSync:(p,options)=>{
    calls.fs.push(['lstat',p]);if(p===FILE)sourceCalls++;if(p===PARENT)parentCalls++;
    const value=files.get(p);if(!value)throw error('ENOENT');return change?.(p,value,{sourceCalls,parentCalls,files})??value;
  },accessSync:p=>{calls.fs.push(['access',p]);if(!writable)throw error('EACCES');}};
  const process={platform,env,execArgv,getuid:()=>1001};
  const spawn=(binary,args,options)=>{calls.spawn.push({binary,args,options});onSpawn?.(files);
    return reply??{status:0,signal:null,stdout:OUTPUT,stderr:''};};
  const api=evaluate(os,path,spawn,process);
  return {calls,files,process,api,read:(...args)=>api.readLinuxLibraryIdentity(...args)};
}
const refuses=fn=>assert.throws(fn,e=>e.message==='RATIO_LINUX_LIBRARY_IDENTITY_REFUSED');

test('disabled defaults do zero filesystem access and zero process starts, including the real export',()=>{
  const t=fixture({platform:'not-linux',env:{NODE_OPTIONS:'synthetic injection',RATIO_LIBRARY_IDENTITY_ENABLED:'true'}});
  assert.equal(t.read(),null);assert.equal(t.read(FILE),null);assert.equal(t.read(FILE,{enabled:false}),null);
  assert.equal(t.calls.fs.length,0);assert.equal(t.calls.spawn.length,0);
  assert.equal(readLinuxLibraryIdentity('/this-path-must-not-be-opened'),null);
});
test('the only opt-in is a boolean and identity/verifier/interpreter/environment injection is not an API',()=>{
  for(const options of [{enabled:null},{enabled:1},{enabled:'true'},{enabled:true,verifier:()=>true},
    {enabled:true,identity:{libraryFileId:ID,version:'3'}},{enabled:true,interpreter:BIN},{enabled:true,command:'anything'},
    {get enabled(){return true;}},Object.defineProperty({enabled:true},'runtime',{value:{}})]){
    const t=fixture();refuses(()=>t.read(FILE,options));assert.equal(t.calls.fs.length+t.calls.spawn.length,0);
  }
});
test('enabled synthetic read uses one fixed isolated process, private output and an exact immutable identity',()=>{
  const t=fixture({env:{UNRELATED_VALUE:'synthetic-should-not-be-inherited',PYTHONHASHSEED:'synthetic'}});
  const r=t.read(FILE,{enabled:true});assert.deepEqual(r,{libraryFileId:ID,version:'3'});assert.equal(Object.isFrozen(r),true);
  assert.equal(t.calls.spawn.length,1);const s=t.calls.spawn[0];assert.equal(s.binary,BIN);
  assert.deepEqual(s.args.slice(0,4),['-I','-S','-B','-c']);assert.equal(s.args.at(-1),FILE);
  assert.deepEqual(s.options.env,{PATH:'/usr/bin:/bin',LANG:'C.UTF-8',LC_ALL:'C.UTF-8',PYTHONIOENCODING:'utf-8'});
  assert.deepEqual(s.options.stdio,['ignore','pipe','pipe']);assert.equal(s.options.timeout,2000);assert.equal(s.options.maxBuffer,4096);
  assert.equal('accepted' in r,false);assert.equal('sourceOriginVerified' in r,false);
});
test('environment or preload/debug hooks fail before any filesystem or child access',()=>{
  for(const env of [{NODE_OPTIONS:''},{NODE_PATH:'x'},{PYTHONPATH:'x'},{PYTHONHOME:'x'},{PYTHONSTARTUP:'x'},
    {PYTHONINSPECT:'x'},{PYTHONUSERBASE:'x'},{LD_PRELOAD:'x'},{DYLD_INSERT_LIBRARIES:'x'}]){
    const t=fixture({env});refuses(()=>t.read(FILE,{enabled:true}));assert.equal(t.calls.fs.length+t.calls.spawn.length,0);
  }
  for(const arg of ['--require=x','-rx','--import=x','--loader=x','--experimental-loader=x','--inspect=0']){
    const t=fixture({execArgv:[arg]});refuses(()=>t.read(FILE,{enabled:true}));assert.equal(t.calls.fs.length+t.calls.spawn.length,0);
  }
});
test('path, source type, owner, hardlinks and private mode refuse without spawning',()=>{
  for(const file of ['relative','/synthetic/private/../source.json',FILE+'\0']){
    const t=fixture();refuses(()=>t.read(file,{enabled:true}));assert.equal(t.calls.spawn.length,0);
  }
  for(const value of [stat('dir'),stat('link'),stat('file',2002),stat('file',1001,{nlink:2n}),stat('file',1001,{mode:0o100644n})]){
    const t=fixture();t.files.set(FILE,value);refuses(()=>t.read(FILE,{enabled:true}));assert.equal(t.calls.spawn.length,0);
  }
  const t=fixture();t.files.set(PARENT,stat('dir',1001,{mode:0o40755n}));refuses(()=>t.read(FILE,{enabled:true}));assert.equal(t.calls.spawn.length,0);
});
test('git ancestors, unresolved parent paths and unreadable ancestor checks remain fail closed',()=>{
  const t=fixture();t.files.set('/synthetic/.git',stat('file'));refuses(()=>t.read(FILE,{enabled:true}));assert.equal(t.calls.spawn.length,0);
  const denied=fixture({change:(p)=>{if(p===FILE)throw error('EACCES');}});refuses(()=>denied.read(FILE,{enabled:true}));assert.equal(denied.calls.spawn.length,0);
});
test('missing, writable or caller-owned interpreter dependencies never start a child',()=>{
  for(const options of [{missing:true},{writable:true},{change:(p,s)=>p.startsWith('/usr')?{...s,uid:1001n}:s},
    {change:(p,s)=>p===BIN?{...s,mode:0o100777n}:s}]){
    const t=fixture(options);refuses(()=>t.read(FILE,{enabled:true}));assert.equal(t.calls.spawn.length,0);
  }
});
test('source, parent, alias and interpreter metadata must remain stable after the process',()=>{
  for(const target of [FILE,PARENT,BIN,'/usr/bin/python3']){
    const t=fixture({onSpawn:files=>files.set(target,{...files.get(target),ctimeNs:11n})});
    refuses(()=>t.read(FILE,{enabled:true}));assert.equal(t.calls.spawn.length,1);
  }
});
test('process errors, signals, stderr, noncanonical JSON and malformed identity/version all refuse',()=>{
  const bad=[{error:error('ENOENT')},{status:2},{signal:'SIGTERM'}, {stderr:'synthetic private error'},
    {stdout:'{}\n'},{stdout:'x'.repeat(257)},{stdout:OUTPUT+'\n'},
    {stdout:JSON.stringify({libraryFileId:ID,version:3})+'\n'},
    ...['-1','01','9007199254740992',' 3','3\n'].map(version=>({stdout:JSON.stringify({libraryFileId:ID,version})+'\n'})),
    {stdout:JSON.stringify({libraryFileId:ID.toUpperCase(),version:'3'})+'\n'},
    {stdout:'{"libraryFileId":"'+ID+'","version":"2","version":"3"}\n'},
    {stdout:JSON.stringify({libraryFileId:ID,version:'3',verified:true})+'\n'}];
  for(const over of bad){const t=fixture({reply:{status:0,signal:null,stdout:OUTPUT,stderr:'',...over}});refuses(()=>t.read(FILE,{enabled:true}));}
});

// Execute the exact embedded Python helper against a closed synthetic os module.
// No real file is opened and no Library metadata is installed on a test file.
const pythonHarness=String.raw`import sys, json, io, types, stat, posixpath, contextlib, re, os as real_os
payload=json.load(sys.stdin)
results=[]
for case in payload["cases"]:
    calls={"open":0,"close":0,"attrs":0,"fstat":0,"pathstat":0}
    cfg=case.get("config",{})
    def item(kind="file", **extra):
        values=dict(st_dev=1,st_ino=2,st_mode=(stat.S_IFDIR|0o700) if kind=="dir" else (stat.S_IFLNK|0o777) if kind=="link" else (stat.S_IFREG|0o600),st_uid=1001,st_gid=1001,st_nlink=1,st_size=100,st_mtime_ns=10,st_ctime_ns=10)
        values.update(extra);return types.SimpleNamespace(**values)
    def lstat(p):
        if p.endswith("/.git"):
            if cfg.get("git") and p=="/synthetic/.git":return item()
            raise FileNotFoundError()
        if p=="/synthetic/private":return item("dir")
        calls["pathstat"]+=1
        return item(cfg.get("kind","file"),st_uid=cfg.get("owner",1001),st_nlink=cfg.get("links",1),st_ino=3 if cfg.get("pathChanged") and calls["pathstat"]>1 else 2)
    def fstat(fd):
        assert fd==47;calls["fstat"]+=1
        return item(st_ctime_ns=11 if cfg.get("unstable") and calls["fstat"]>1 else 10,
                    st_ino=3 if cfg.get("descriptorChanged") else 2,
                    st_nlink=2 if cfg.get("linksChanged") and calls["fstat"]>1 else 1,
                    st_uid=2002 if cfg.get("ownerChanged") and calls["fstat"]>1 else 1001)
    def opening(p,flags):
        assert p=="/synthetic/private/source.json" and flags & real_os.O_NOFOLLOW and flags & real_os.O_CLOEXEC
        calls["open"]+=1;return 47
    def close(fd):
        assert fd==47;calls["close"]+=1
    def attrs(fd,name):
        assert fd==47;calls["attrs"]+=1
        if cfg.get("missing")==name:raise OSError("synthetic missing xattr")
        if name=="user.library-file-id":
            return ("libfile_"+("b" if cfg.get("changedId") and calls["attrs"]>2 else "a")*32).encode() if "id" not in cfg else cfg["id"].encode()
        assert name=="user.library-file-version"
        return ("4" if cfg.get("changedVersion") and calls["attrs"]>2 else cfg.get("version","3")).encode()
    fake=types.ModuleType("os")
    fake.path=types.SimpleNamespace(isabs=posixpath.isabs,normpath=posixpath.normpath,dirname=posixpath.dirname,join=posixpath.join,realpath=lambda p:("/different"+p) if cfg.get("symlinkParent") else p)
    fake.lstat=lstat;fake.fstat=fstat;fake.getuid=lambda:1001;fake.open=opening;fake.close=close
    fake.O_RDONLY=real_os.O_RDONLY;fake.O_NOFOLLOW=real_os.O_NOFOLLOW;fake.O_CLOEXEC=real_os.O_CLOEXEC
    if not cfg.get("unsupported"):fake.getxattr=attrs
    saved_argv=sys.argv;sys.argv=["isolated-helper","/synthetic/private/source.json"];out=io.StringIO();status=0
    try:
        sys.modules["os"]=fake
        with contextlib.redirect_stdout(out):
            try:exec(payload["code"],{"__name__":"__main__"})
            except SystemExit as error:status=error.code
    finally:
        sys.modules["os"]=real_os;sys.argv=saved_argv
    results.append({"name":case["name"],"status":status,"output":out.getvalue(),"calls":calls})
print(json.dumps(results,separators=(",",":")))`;
test('exact Python helper reads descriptor xattrs twice, closes it and refuses synthetic OS/identity changes',()=>{
  const cases=[{name:'positive',config:{}},...[
    ['missing-id',{missing:'user.library-file-id'}],['missing-version',{missing:'user.library-file-version'}],
    ['bad-id',{id:'not-library'}],['id-upper',{id:ID.toUpperCase()}],['negative',{version:'-1'}],
    ['noncanonical',{version:'01'}],['overflow',{version:'9007199254740992'}],['space',{version:'3 '}],
    ['directory',{kind:'dir'}],['symlink',{kind:'link'}],['owner',{owner:2002}],['hardlink',{links:2}],
    ['metadata-change',{unstable:true}],['path-change',{pathChanged:true}],['identity-change',{changedId:true}],
    ['version-change',{changedVersion:true}],['descriptor-change',{descriptorChanged:true}],
    ['owner-change',{ownerChanged:true}],['links-change',{linksChanged:true}],
    ['git',{git:true}],['symlink-parent',{symlinkParent:true}],['unsupported',{unsupported:true}],
  ].map(([name,config])=>({name,config}))];
  const result=JSON.parse(execFileSync('/usr/bin/python3',['-I','-S','-B','-c',pythonHarness],{
    input:JSON.stringify({code:fixture().api.PYTHON,cases}),encoding:'utf8',timeout:5000,maxBuffer:65536,
    env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8',PYTHONIOENCODING:'utf-8'},
  }));
  assert.equal(result[0].status,0);assert.equal(result[0].output,OUTPUT);assert.equal(result[0].calls.attrs,4);
  for(const r of result){assert.equal(r.calls.close,r.calls.open);if(r.name!=='positive'){assert.equal(r.status,2,r.name);assert.equal(r.output,'',r.name);}}
});
