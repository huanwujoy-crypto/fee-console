#!/usr/bin/env node
// 每日数据写入脚本（由 Cowork 定时任务调用）。无第三方依赖。
// 用法：
//   node scripts/daily.mjs --key=<base64url 32字节> --date=2026-08-15 \
//        --schwab=617581.03 --webull=116529.69 [--flows='[{"date":"2026-08-10","acct":"schwab","amount":25000,"desc":"Wire in"}]']
// 行为：读取 data.json（若存在则用 key 解密），合并/更新当日记录与出入金候选，重新加密写回 data.json。
import fs from "node:fs"; import crypto from "node:crypto";
const args=Object.fromEntries(process.argv.slice(2).map(a=>{const m=a.match(/^--([^=]+)=(.*)$/s);return m?[m[1],m[2]]:[a,true];}));
const need=k=>{if(!args[k])throw new Error("missing --"+k);return args[k];};
const key=Buffer.from(need("key").replace(/-/g,"+").replace(/_/g,"/"),"base64"); if(key.length!==32) throw new Error("key must be 32 bytes");
const date=need("date"); if(!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("bad date");
const enc=txt=>{const iv=crypto.randomBytes(12);const c=crypto.createCipheriv("aes-256-gcm",key,iv);const ct=Buffer.concat([c.update(txt,"utf8"),c.final()]);return Buffer.concat([iv,ct,c.getAuthTag()]).toString("base64");};
const dec=b64=>{const b=Buffer.from(b64,"base64");const iv=b.subarray(0,12),tag=b.subarray(b.length-16),ct=b.subarray(12,b.length-16);const d=crypto.createDecipheriv("aes-256-gcm",key,iv);d.setAuthTag(tag);return Buffer.concat([d.update(ct),d.final()]).toString("utf8");};
const file=args.file||"data.json";
let data={updatedAt:"",daily:[],flowsAuto:[]};
if(fs.existsSync(file)){const o=JSON.parse(fs.readFileSync(file,"utf8"));data=o.enc?JSON.parse(dec(o.data)):o;}
data.daily=(data.daily||[]).filter(x=>x&&x.d!==date);
const pt={d:date};for(const k of Object.keys(args)){if(["key","date","flows","file"].includes(k))continue;const v=parseFloat(args[k]);if(isFinite(v))pt[k]=v;}
if(Object.keys(pt).length<2) throw new Error("no account values given");
data.daily.push(pt);data.daily.sort((a,b)=>a.d.localeCompare(b.d));
if(args.flows){const fl=JSON.parse(args.flows);const seen=new Set((data.flowsAuto||[]).map(f=>f.id));
  for(const f of fl){const id=f.id||crypto.createHash("sha1").update([f.date,f.acct,f.amount,f.desc||""].join("|")).digest("hex").slice(0,12);if(seen.has(id))continue;seen.add(id);data.flowsAuto.push({id,date:f.date,acct:f.acct,amount:+f.amount,desc:f.desc||""});}}
data.updatedAt=new Date().toISOString();
fs.writeFileSync(file,JSON.stringify({enc:true,v:3,data:enc(JSON.stringify(data))}));
console.log(`ok ${date} points=${data.daily.length} flows=${(data.flowsAuto||[]).length} last=${JSON.stringify(pt)}`);
