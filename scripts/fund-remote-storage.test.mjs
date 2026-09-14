import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import { fileURLToPath } from "node:url";

const root = process.env.FUND_UI_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const region = name => html.split(`/* ${name}:start */`)[1]?.split(`/* ${name}:end */`)[0];
const remoteCode = region("fund-remote-storage");
const remoteTest = (name, fn) => test(name, { skip: !remoteCode }, fn);

const profile = {
  schema: "fee-console.fund-profile.v1", manager: "SYNTHETIC MANAGER", fundName: "SYNTHETIC FUND",
  inceptionDate: "2026-08-20", inceptionNoticeDate: "2026-08-21", currency: "USD", initialShares: 1000,
  investors: [{ id: "X", name: "Jenny Z", shares: 100 }, { id: "Z", name: "XiXi Z", shares: 900 }]
};
const library = {
  schema: "fee-console.fund-documents.v2", libraryId: "synthetic-library",
  governance: { managerController: "L.W.", guardians: [] }, documents: []
};

function context({ remoteFile = "" } = {}) {
  assert(remoteCode, "active UI is missing fund-remote-storage");
  const ctx = vm.createContext({
    crypto: webcrypto, TextEncoder, TextDecoder,
    atob: value => Buffer.from(value, "base64").toString("binary"),
    btoa: value => Buffer.from(value, "binary").toString("base64"),
    URLSearchParams
  });
  vm.runInContext(`
    const values=new Map([['gid','syntheticGist1'],['key','${Buffer.alloc(32, 9).toString("base64url")}'],['tok','manager-token']]);
    const K={gid:'gid',key:'key',tok:'tok'};const cfg=k=>values.get(k)||'';
    const GH_FUND_FILE='fee-console-fund.json',FUND_REMOTE_SCHEMA='fee-console.fund-remote.v1',FUND_DOC_MAX_ENVELOPE_BYTES=480000;
    const fundDocsBytes=value=>new TextEncoder().encode(String(value)).byteLength;
    const fundDocsObject=value=>!!value&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
    const fundDocsExact=(value,keys)=>fundDocsObject(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
    const fundDocsInstant=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
    const validateFundDocuments=value=>value&&value.schema==='fee-console.fund-documents.v2'?{ok:true,library:value}:{ok:false,reason:'bad library'};
    const fundInvestorCore={validateProfile:value=>value&&value.schema==='fee-console.fund-profile.v1'?{ok:true,profile:value}:{ok:false,reason:'bad profile'}};
    const b64u2buf=s=>Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
    const buf2b64=b=>btoa(String.fromCharCode(...new Uint8Array(b)));
    async function keyOf(value){return crypto.subtle.importKey('raw',b64u2buf(value),'AES-GCM',false,['encrypt','decrypt']);}
    async function encTxt(key,value){const iv=crypto.getRandomValues(new Uint8Array(12)),ct=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv},key,new TextEncoder().encode(value))),out=new Uint8Array(12+ct.length);out.set(iv);out.set(ct,12);return buf2b64(out);}
    async function decTxt(key,value){const bytes=Uint8Array.from(atob(value),c=>c.charCodeAt(0));return new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes.slice(0,12)},key,bytes.slice(12)));}
    let _remoteFund={state:'unloaded',gid:'',keyValue:'',revision:'',raw:'',bundle:null,reason:''},_fundRemoteWrite=null;
    const currentRemoteFund=()=>_remoteFund.gid===cfg(K.gid)&&_remoteFund.keyValue===cfg(K.key)?_remoteFund:null;
    const managerDocumentsAuthorized=()=>true,_receiptSource={state:'verified'},sourceMatches=()=>true;
    let remoteFile=${JSON.stringify(remoteFile)},patchCalls=0;
    async function ghApi(_path,opt={}){if(opt.method==='PATCH'){assertFundWrite(opt.reviewedFund===_fundRemoteWrite);remoteFile=JSON.parse(opt.body).files[GH_FUND_FILE].content;patchCalls++;}return {files:remoteFile?{[GH_FUND_FILE]:{content:remoteFile,truncated:false}}:{},history:[{version:'revision-'+patchCalls}]};}
    const assertFundWrite=value=>{if(!value)throw new Error('unreviewed fund write')};
    const fetch=async()=>{throw new Error('unexpected truncated fetch')};
    let _fundProfileMessage='',_fundDocsMessage='';const document={getElementById:()=>null};const toast=()=>{};const render=async()=>{};
  `, ctx);
  vm.runInContext(remoteCode, ctx);
  return ctx;
}

const run = (ctx, code) => vm.runInContext(code, ctx);

remoteTest("a remote fund snapshot decrypts to the latest profile and document library", async () => {
  const ctx = context();
  const raw = await run(ctx, `(async()=>{const bundle={schema:FUND_REMOTE_SCHEMA,gid:cfg(K.gid),updatedAt:new Date().toISOString(),profile:${JSON.stringify(profile)},library:${JSON.stringify(library)}};return JSON.stringify({enc:true,v:1,data:await encTxt(await keyOf(cfg(K.key)),JSON.stringify(bundle))})})()`);
  assert.equal(JSON.parse(raw).enc, true);
  assert.equal(run(ctx, `fundDocsExact(JSON.parse(${JSON.stringify(raw)}),['enc','v','data'])`), true);
  await run(ctx, `acceptRemoteFundSnapshot({gid:cfg(K.gid),keyValue:cfg(K.key),revision:'r1',fundContent:${JSON.stringify(raw)}})`);
  assert.equal(run(ctx, "_remoteFund.state"), "verified");
  assert.equal(run(ctx, "_remoteFund.bundle.profile.investors[1].shares"), 900);
  assert.equal(run(ctx, "_remoteFund.bundle.library.governance.managerController"), "L.W.");
});

remoteTest("publishing creates the fixed remote file and verifies its encrypted read-back", async () => {
  const ctx = context();
  await run(ctx, `writeRemoteFundBundle(${JSON.stringify(profile)},${JSON.stringify(library)},'')`);
  assert.equal(run(ctx, "patchCalls"), 1);
  assert.equal(run(ctx, "_remoteFund.state"), "verified");
  assert.equal(run(ctx, "_remoteFund.bundle.profile.fundName"), "SYNTHETIC FUND");
  assert.equal(run(ctx, "JSON.parse(remoteFile).enc"), true);
  assert(!run(ctx, "remoteFile.includes('Jenny Z')"));
});

remoteTest("a stale manager page cannot replace a newer remote fund record", async () => {
  const ctx = context({ remoteFile: "newer-remote-content" });
  await assert.rejects(run(ctx, `writeRemoteFundBundle(${JSON.stringify(profile)},${JSON.stringify(library)},'')`), /另一页面已更新/);
  assert.equal(run(ctx, "patchCalls"), 0);
  assert.equal(run(ctx, "remoteFile"), "newer-remote-content");
});
