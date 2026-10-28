#!/usr/bin/env node
// Trusted-main verifier for the single stable entry. No source, key or network.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';

export const RETIRED_ENTRY_SHA256='03f6b4440c2bfa7a0740ee2116e4a9835b0e47f88e1ceaeaa4a7d6454e3146e0';
const refuse=()=>{throw Error('XUAN_ENTRY_POLICY_REFUSED');};
export function verifyXuanEntry(bytes,entryPath='xuan-ib/index.html'){
  if(entryPath!=='xuan-ib/index.html'||!Buffer.isBuffer(bytes)||bytes.length<1||bytes.length>512*1024)refuse();
  let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{refuse();}
  if(!Buffer.from(text).equals(bytes)||/<!--[\s]*xuan-ib-(?:handover:v1|night-action-v1:)/.test(text))refuse();
  if(crypto.createHash('sha256').update(bytes).digest('hex')===RETIRED_ENTRY_SHA256){
    // Exact reviewed bytes are mandatory: this is not a general static-HTML
    // exception. Structural checks document and enforce its inert boundary.
    if(!text.includes('<meta name="xuan-action-status" content="retired">')
        ||!text.includes('<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; base-uri \'none\'; form-action \'none\'">')
        ||!text.includes('<meta name="referrer" content="no-referrer">')
        ||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(text)
        ||/\bon[a-z0-9_-]+\s*=|\b(?:src|srcset|srcdoc|action|formaction|ping|target|poster|background)\s*=/i.test(text)
        ||/https?:|\/\/|javascript\s*:|data\s*:|url\s*\(|@import|http-equiv\s*=\s*["']?refresh/i.test(text))refuse();
    const allowed=new Set(['html','head','meta','title','style','body','main','h1','p','a']);
    for(const tag of text.matchAll(/<\/?\s*([a-z][a-z0-9:-]*)\b/gi))if(!allowed.has(tag[1].toLowerCase()))refuse();
    const links=[...text.matchAll(/<a\b[^>]*>/gi)];
    if(links.length!==1||links[0][0]!=='<a href="../" rel="noreferrer">')refuse();
    return 'static-retirement';
  }
  // Preserve the exact original loader gate. Neither a generic retired marker
  // nor copied comments can grant the new retirement exception.
  if(/<meta\b[^>]*\bname\s*=\s*["']xuan-action-status["']/i.test(text))refuse();
  for(const value of ['const loaderBuild = "','new URL("latest.meta.json", location.href)','new URL("latest.html", location.href)'])if(!text.includes(value))refuse();
  return 'legacy-loader';
}
function main(){
  if(process.argv.length!==3)refuse();const file=process.argv[2],s=fs.lstatSync(file);
  if(!s.isFile()||s.isSymbolicLink()||s.size<1||s.size>512*1024)refuse();
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try{const a=fs.fstatSync(fd);if(a.ino!==s.ino||a.dev!==s.dev)refuse();const b=fs.readFileSync(fd),z=fs.fstatSync(fd);if(a.size!==z.size||a.mtimeMs!==z.mtimeMs||a.ctimeMs!==z.ctimeMs)refuse();console.log('XUAN_ENTRY_POLICY_OK '+verifyXuanEntry(b));}finally{fs.closeSync(fd);}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))try{main();}catch{console.error('XUAN_ENTRY_POLICY_REFUSED');process.exitCode=1;}
