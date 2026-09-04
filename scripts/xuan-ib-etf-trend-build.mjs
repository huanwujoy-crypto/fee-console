#!/usr/bin/env node
// Private source -> private preview and optionally authenticated ciphertext.
// Never prints amounts, source text or keys. Existing outputs are never replaced.
// Production encryption must always reuse the same explicitly supplied private
// --key-usage-root. Each key gets at most 10,000 reserved attempts, including
// failed encryptions. Attempts are never refunded, and damaged/incomplete usage
// history is never recreated. Deliberate key rotation is the only fresh quota.
// This local audit cannot defend against an operator removing the entire root
// or deliberately pointing at an unrelated new root: callers must pin its path.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {simulateEtfTrend, projectEtfTrend, renderEtfTrend} from './xuan-ib-etf-trend.mjs';
import {encryptEtfTrend} from './xuan-ib-etf-trend-envelope.mjs';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const within=(p,r)=>p===r||p.startsWith(r+path.sep);
const fail=m=>{throw new Error(m);};
export const ETF_KEY_ENCRYPTION_LIMIT=10000;
const usagePurpose='xuan-etf-aes-gcm-key-usage-v1';
const hash=text=>createHash('sha256').update(text).digest('hex');
const exists=p=>{try{fs.lstatSync(p);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}};
function privateRoot(p){
  if(!path.isAbsolute(p))fail('Private root must be absolute');
  const st=fs.lstatSync(p);
  if(!st.isDirectory()||st.isSymbolicLink()||st.uid!==process.getuid()||(st.mode&0o777)!==0o700||fs.realpathSync(p)!==p||within(p,repo))fail('Require private owned 0700 root outside repository');
  return p;
}
function readInput(p){
  if(!path.isAbsolute(p))fail('Private input must be absolute');
  privateRoot(path.dirname(p));
  const fd=fs.openSync(p,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try{const s=fs.fstatSync(fd);if(!s.isFile()||s.uid!==process.getuid()||s.nlink!==1||(s.mode&0o777)!==0o600||s.size>2000000)fail('Invalid private input file');
    return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(fs.readFileSync(fd)));
  }finally{fs.closeSync(fd);}
}
const create=(p,text)=>{const fd=fs.openSync(p,'wx',0o600);try{fs.writeFileSync(fd,text);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}};
function usageFile(p,maxBytes=2048){
  const fd=fs.openSync(p,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try{const s=fs.fstatSync(fd);if(!s.isFile()||s.uid!==process.getuid()||s.nlink!==1||(s.mode&0o777)!==0o600||s.size>maxBytes)fail('Invalid private key usage file');
    const bytes=fs.readFileSync(fd);if(bytes.byteLength>maxBytes)fail('Invalid private key usage size');
    return new TextDecoder('utf-8',{fatal:true}).decode(bytes);
  }finally{fs.closeSync(fd);}
}
function usageJson(text,keys){
  const value=JSON.parse(text);
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!==keys.sort().join(',')||JSON.stringify(value)!==text)fail('Invalid key usage record');
  return value;
}
const validTime=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
async function usageLock(root,fingerprint){
  const lock=path.join(root,`.allocate-${fingerprint}.lock`);
  for(let i=0;i<500;i++){
    try{fs.mkdirSync(lock,{mode:0o700});return lock;}catch(error){if(error.code!=='EEXIST')throw error;}
    // Never break/reclaim another process's lock automatically. A crash leaves
    // a fail-closed lock; inspect it or deliberately rotate the key.
    if(exists(lock))privateRoot(lock);
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  fail('Key usage allocation is busy; no encryption attempted');
}
async function reserveKeyAttempt(root,keyBytes,now){
  privateRoot(root);
  const fingerprint=createHash('sha256').update(`${usagePurpose}:fingerprint\0`).update(keyBytes).digest('hex');
  const lock=await usageLock(root,fingerprint);
  try{
    privateRoot(root);
    const dir=path.join(root,`key-${fingerprint}`),registration=path.join(root,`registered-${fingerprint}.json`),journal=path.join(root,`usage-${fingerprint}.log`);
    const present=[dir,registration,journal].map(exists);
    const fresh=present.every(v=>!v);
    const allocatedAt=new Date(now).toISOString();
    if(fresh){
      fs.mkdirSync(dir,{mode:0o700});
      create(registration,JSON.stringify({schemaVersion:1,purpose:usagePurpose,keyFingerprint:fingerprint,limit:ETF_KEY_ENCRYPTION_LIMIT,createdAt:allocatedAt}));
      create(journal,'');
    }else if(!present.every(Boolean))fail('Key usage ledger incomplete; never reset it automatically');
    privateRoot(dir);
    const registrationText=usageFile(registration);
    const identity=usageJson(registrationText,['schemaVersion','purpose','keyFingerprint','limit','createdAt']);
    if(identity.schemaVersion!==1||identity.purpose!==usagePurpose||identity.keyFingerprint!==fingerprint||identity.limit!==ETF_KEY_ENCRYPTION_LIMIT||!validTime(identity.createdAt))fail('Key usage identity differs');
    const files=fs.readdirSync(dir).sort();
    if(files.length>ETF_KEY_ENCRYPTION_LIMIT||files.some((file,i)=>file!==`attempt-${String(i+1).padStart(5,'0')}.json`))fail('Key usage sequence is incomplete or altered');
    if(!fresh&&files.length===0)fail('Registered key usage is empty; never silently reset it');
    const journalText=usageFile(journal,2_000_000);
    const lines=journalText===''?[]:journalText.split('\n');
    if(lines.length){if(lines.pop()!=='')fail('Key usage journal incomplete');}
    if(lines.length!==files.length)fail('Key usage journal and attempt records differ');
    let previousHash=hash(registrationText);
    for(const [i,file] of files.entries()){
      const text=usageFile(path.join(dir,file));
      const record=usageJson(text,['schemaVersion','purpose','keyFingerprint','sequence','previousHash','allocatedAt']);
      if(record.schemaVersion!==1||record.purpose!==usagePurpose||record.keyFingerprint!==fingerprint||record.sequence!==i+1||record.previousHash!==previousHash||!validTime(record.allocatedAt))fail('Key usage hash chain differs');
      previousHash=hash(text);
      if(lines[i]!==`${String(i+1).padStart(5,'0')} ${previousHash}`)fail('Key usage journal commitment differs');
    }
    if(files.length>=ETF_KEY_ENCRYPTION_LIMIT)fail('Key encryption limit reached; explicitly rotate to a new key');
    const sequence=files.length+1;
    const record=JSON.stringify({schemaVersion:1,purpose:usagePurpose,keyFingerprint:fingerprint,sequence,previousHash,allocatedAt});
    // Reserve the immutable filename before encryption. A crypto/write failure
    // burns the slot: never refund, delete, renumber or overwrite attempt files.
    create(path.join(dir,`attempt-${String(sequence).padStart(5,'0')}.json`),record);
    const fd=fs.openSync(journal,fs.constants.O_WRONLY|fs.constants.O_APPEND|fs.constants.O_NOFOLLOW);
    try{const s=fs.fstatSync(fd);if(!s.isFile()||s.uid!==process.getuid()||s.nlink!==1||(s.mode&0o777)!==0o600)fail('Invalid key usage journal');
      const line=`${String(sequence).padStart(5,'0')} ${hash(record)}\n`;
      if(fs.writeSync(fd,line)!==Buffer.byteLength(line))fail('Key usage journal append incomplete');
      fs.fsyncSync(fd);
    }finally{fs.closeSync(fd);}
    // A separate append-only journal detects a removed trailing attempt, not
    // just holes. Corruption/crash-between-files stays closed; no auto repair.
    return sequence;
  }finally{fs.rmdirSync(lock);}
}
export async function buildTrend({inputPath,previewRoot,envelopePath=null,keyEncoded=null,keyUsageRoot=null,now=new Date()}){
  const input=readInput(inputPath),result=simulateEtfTrend(input),projection=projectEtfTrend(result);
  const payload={projection,result};
  // Encryption validates all view fields/date semantics even for a local preview.
  const {validateEtfTrendPayload}=await import('./xuan-ib-etf-trend-envelope.mjs');
  validateEtfTrendPayload(payload,{now});
  const html=renderEtfTrend(projection,{privateResult:result});
  let envelope=null,keyBytes=null;
  try{
  if(envelopePath){
    if(!path.isAbsolute(envelopePath)||fs.realpathSync(path.dirname(envelopePath))!==path.dirname(envelopePath))fail('Envelope destination must be an absolute existing real directory');
    if(!keyEncoded)fail('XUAN_ETF_DATA_KEY missing; no output created');
    if(!/^[A-Za-z0-9_+/-]{43}={0,2}$/.test(keyEncoded))fail('Invalid data key encoding');
    keyBytes=Buffer.from(keyEncoded,'base64');
    if(keyBytes.length!==32)fail('Invalid data key length');
    if(!keyUsageRoot)fail('A stable private key usage root is required for encryption');
    privateRoot(keyUsageRoot);
  }
  const outputs=[];
  if(previewRoot){privateRoot(previewRoot);const d=projection.rows.at(-1).date;
    outputs.push([path.join(previewRoot,`result-${d}.json`),JSON.stringify(payload,null,2)+'\n']);
    outputs.push([path.join(previewRoot,`preview-${d}.html`),'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ETF ABC 私密预览</title><body style="margin:0;background:#f6f7f8;color:#17212b;font-family:-apple-system,system-ui,sans-serif"><main style="max-width:760px;margin:20px auto;padding:16px;background:white;border-radius:16px"><p style="font-size:13px;color:#835200">私密预览 · 尚未代表手机已发布或自动更新已启用</p>'+html+'</main></body></html>']);
  }
  const outputPaths=[...outputs.map(([p])=>p),...(envelopePath?[envelopePath]:[])];
    if(!outputPaths.length)fail('Choose private preview or encrypted output');
    if(new Set(outputPaths).size!==outputPaths.length)fail('Output destinations must be distinct');
    if(outputPaths.some(exists))fail('Output exists; preserve existing version and choose a new path');
    if(envelopePath){
      // All ordinary input/path/key/output preflight precedes quota consumption.
      await reserveKeyAttempt(keyUsageRoot,keyBytes,now);
      envelope=await encryptEtfTrend(payload,keyBytes.toString('base64url'),{now});
      outputs.push([envelopePath,JSON.stringify(envelope)]);
    }
    for(const [p,contents] of outputs)create(p,contents);
  }finally{keyBytes?.fill(0);}
  return {asOf:projection.rows.at(-1).date,completeThrough:projection.latestCompleteDate,rows:projection.rows.length,encrypted:!!envelope,preview:!!previewRoot};
}
async function main(){
  const allowed=new Set(['--input','--preview-root','--envelope-out','--key-usage-root']),args={};
  for(let i=2;i<process.argv.length;i+=2){const n=process.argv[i],v=process.argv[i+1];if(!allowed.has(n)||!v||args[n])fail('Use --input, --preview-root, --envelope-out and stable --key-usage-root; keys only via XUAN_ETF_DATA_KEY');args[n]=v;}
  if(!args['--input'])fail('--input is required');
  const result=await buildTrend({inputPath:args['--input'],previewRoot:args['--preview-root'],envelopePath:args['--envelope-out'],keyUsageRoot:args['--key-usage-root'],keyEncoded:process.env.XUAN_ETF_DATA_KEY});
  console.log(JSON.stringify({ok:true,...result}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(()=>{console.error('Trend build failed; check private input, permissions, dates, key or encryption quota. Existing files retained.');process.exitCode=1;});
