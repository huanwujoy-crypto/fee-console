// Called only by daily.mjs's explicit offline attachment mode. No Keychain or network.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { buildIbManagerReturnReceipt } from './ib-manager-return.mjs';
import { validateFeeCalculationReceipt } from './fee-receipt-core.mjs';

export async function prepareIbManagerReturn({file,inputFile,outputFile,execute=false,keyText,environ=process.env}) {
  const fail=()=>{throw new Error('IB_RETURN_ATTACHMENT_REFUSED');};
  if(/^(true|1)$/i.test(String(environ.GITHUB_ACTIONS||'')))fail();
  const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
  const outside=p=>{const rel=path.relative(repo,p);return rel==='..'||rel.startsWith('..'+path.sep);};
  const read=(p,privateInput=false)=>{
    if(!path.isAbsolute(p)||fs.lstatSync(p).isSymbolicLink())fail();
    const real=fs.realpathSync(p),st=fs.statSync(real);
    if(!st.isFile()||st.size<1||st.size>5*1024*1024||(privateInput&&(!outside(real)||(st.mode&0o077)!==0)))fail();
    const raw=fs.readFileSync(real);if(!raw.equals(fs.readFileSync(real)))fail();return {real,raw};
  };
  if(typeof keyText!=='string'||!/^[A-Za-z0-9_+/-]{43}={0,2}$/.test(keyText))fail();
  const key=Buffer.from(keyText.replace(/-/g,'+').replace(/_/g,'/'),'base64');if(key.length!==32)fail();
  const original=read(file),input=read(inputFile,true),outer=JSON.parse(original.raw);
  if(!outer||Object.keys(outer).sort().join(',')!=='data,enc,v'||outer.enc!==true||outer.v!==3||typeof outer.data!=='string')fail();
  const decode=text=>{const b=Buffer.from(text,'base64');if(b.length<29)fail();const d=crypto.createDecipheriv('aes-256-gcm',key,b.subarray(0,12));d.setAuthTag(b.subarray(-16));return Buffer.concat([d.update(b.subarray(12,-16)),d.final()]);};
  const data=JSON.parse(decode(outer.data)),fee=data.feeCalculationReceipt;
  if(!validateFeeCalculationReceipt(fee,data).ok)fail();
  const receipt=await buildIbManagerReturnReceipt(JSON.parse(input.raw));
  if(receipt.start!==fee.start||receipt.asOf!==fee.asOf)fail();
  const candidate={...data,ibManagerReturnReceipt:receipt};
  if(!validateFeeCalculationReceipt(fee,candidate).ok)fail();
  const {ibManagerReturnReceipt:oldReceipt,...oldData}=data,{ibManagerReturnReceipt:newReceipt,...newData}=candidate;
  if(JSON.stringify(oldData)!==JSON.stringify(newData))fail();
  if(!execute)return {status:'IB_RETURN_ATTACHMENT_DRY_RUN_OK'};
  if(!outputFile||!path.isAbsolute(outputFile)||!outside(path.join(fs.realpathSync(path.dirname(outputFile)),path.basename(outputFile)))||fs.existsSync(outputFile))fail();
  if(!original.raw.equals(fs.readFileSync(original.real))||!input.raw.equals(fs.readFileSync(input.real)))fail();
  const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key,iv),encrypted=Buffer.concat([iv,cipher.update(JSON.stringify(candidate)),cipher.final(),cipher.getAuthTag()]);
  if(JSON.stringify(JSON.parse(decode(encrypted.toString('base64'))))!==JSON.stringify(candidate))fail();
  const encoded=JSON.stringify({enc:true,v:3,data:encrypted.toString('base64')})+'\n';
  const fd=fs.openSync(outputFile,'wx',0o600);try{fs.writeFileSync(fd,encoded);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  if(fs.readFileSync(outputFile,'utf8')!==encoded)fail();
  return {status:'IB_RETURN_ENCRYPTED_CANDIDATE_PREPARED'};
}
