// Shared with the trusted loader; keep its marked copy byte-for-byte in sync.
export function parseProgressJson(source) {
  if (typeof source !== "string" || source.length > 250000) throw new Error("进度文件过大");
  let i = 0;
  const ws = () => { while (/[ \t\r\n]/.test(source[i] || "")) i++; };
  const string = () => {
    const start = i++;
    let escaped = false;
    while (i < source.length) {
      const c = source[i++];
      if (!escaped && c === '"') return JSON.parse(source.slice(start, i));
      if (!escaped && c.charCodeAt(0) < 32) throw new Error("无效字符");
      escaped = !escaped && c === "\\";
    }
    throw new Error("字符串未结束");
  };
  const value = (depth = 0) => {
    if (depth > 20) throw new Error("进度层数过深");
    ws();
    if (source[i] === '"') return string();
    if (source[i] === "{") {
      i++; ws(); const out = Object.create(null);
      if (source[i] === "}") { i++; return out; }
      while (i < source.length) {
        ws(); if (source[i] !== '"') throw new Error("无效键");
        const key = string();
        if (Object.hasOwn(out, key)) throw new Error("重复键");
        ws(); if (source[i++] !== ":") throw new Error("缺少冒号");
        out[key] = value(depth + 1); ws();
        if (source[i] === "}") { i++; return out; }
        if (source[i++] !== ",") throw new Error("缺少逗号");
      }
    } else if (source[i] === "[") {
      i++; ws(); const out = [];
      if (source[i] === "]") { i++; return out; }
      while (i < source.length) {
        out.push(value(depth + 1)); ws();
        if (source[i] === "]") { i++; return out; }
        if (source[i++] !== ",") throw new Error("缺少逗号");
      }
    } else {
      const t = source.slice(i).match(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/)?.[0];
      if (t) { i += t.length; return JSON.parse(t); }
    }
    throw new Error("进度 JSON 无效");
  };
  const out = value(); ws();
  if (i !== source.length) throw new Error("多余内容");
  return out;
}

export function validateProgress(data, state, previous = null, now = Date.now()) {
  const fail = (s) => { throw new Error("落实进度：" + s); };
  const keys = (v, expected) => {
    if (!v || typeof v !== "object" || Array.isArray(v) ||
        Object.keys(v).length !== expected.length ||
        Object.keys(v).sort().some((key, index) => key !== expected.slice().sort()[index])) fail("未知或缺失字段");
  };
  const text = (v, max = 180, empty = false) => {
    if (typeof v !== "string" || v.trim() !== v || (!empty && !v) || [...v].length > max ||
        /[<>&\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069]/u.test(v) ||
        /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u.test(v) ||
        /(?:https?:|www\.|[a-z][a-z0-9+.-]*:\/\/|mailto:|github_pat_|gh[pousr]_|\bBearer\s|\bsk-[A-Za-z0-9_-]{12,}|(?:token|password|secret|api[_ -]?key)\s*[:=])/iu.test(v) ||
        /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}|\b[UF]\d{6,}\b|\b\d{8,}\b/iu.test(v)) fail("不安全的公开文字");
  };
  const stamp = (v) => {
    if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?\+08:00$/.test(v)) fail("时间格式");
    const n = Date.parse(v);
    if (!Number.isFinite(n) || new Date(n + 28800000).toISOString().slice(0, 19) !== v.slice(0, 19)) fail("无效时间");
    return n;
  };
  const pair = (v) => {
    keys(v, ["sourceSha", "htmlBlob"]);
    if (![v.sourceSha, v.htmlBlob].every(s => typeof s === "string" && /^[0-9a-f]{40}$/.test(s))) fail("证据指纹");
  };
  const canonical = (v) => Array.isArray(v) ? "[" + v.map(canonical).join(",") + "]" :
    v && typeof v === "object" ? "{" + Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}" : JSON.stringify(v);
  keys(data, ["schemaVersion", "revision", "events"]);
  if (data.schemaVersion !== 1 || !Number.isSafeInteger(data.revision) || data.revision < 1 ||
      !Array.isArray(data.events) || data.events.length < 1 || data.events.length > 300) fail("版本或清单无效");
  if (!state || !Array.isArray(state.receipts) || !Array.isArray(state.decisions)) fail("没有可信回执");
  const ids = new Set();
  let lastTime = 0;
  for (const e of data.events) {
    keys(e, ["eventId", "decisionId", "receiptId", "responseToSourceSha", "responseToHtmlBlob",
      "recordedAtHkt", "observedPair", "title", "status", "owner", "summary", "nextAction",
      "reviewAfterHkt", "blocker", "evidence"]);
    if (typeof e.eventId !== "string" || !/^P-[A-Z0-9-]{1,70}$/.test(e.eventId) || ids.has(e.eventId)) fail("事件编号");
    ids.add(e.eventId);
    const receipt = state.receipts.find(r => r.receiptId === e.receiptId);
    if (!receipt || !["accepted", "modified"].includes(receipt.action) ||
        receipt.decisionId !== e.decisionId || receipt.responseToSourceSha !== e.responseToSourceSha ||
        receipt.responseToHtmlBlob !== e.responseToHtmlBlob ||
        !state.decisions.some(d => d.decisionId === e.decisionId)) fail("决定回执不匹配");
    pair(e.observedPair);
    const time = stamp(e.recordedAtHkt);
    if (time < lastTime || time < stamp(receipt.recordedAtHkt) || time > now + 60000) fail("事件时间倒退或在未来");
    lastTime = time;
    if (stamp(e.reviewAfterHkt) < time) fail("复核日早于记录日");
    if (!["not_started", "in_progress", "blocked", "awaiting_approval", "user_action_required", "evidence_recorded"].includes(e.status)) fail("进度状态");
    for (const k of ["title", "owner"]) text(e[k], 70);
    for (const k of ["summary", "nextAction"]) text(e[k]);
    text(e.blocker, 180, true);
    if (["blocked", "awaiting_approval", "user_action_required"].includes(e.status) && !e.blocker) fail("缺少阻碍说明");
    if (!Array.isArray(e.evidence) || e.evidence.length > 5) fail("证据清单");
    for (const evidence of e.evidence) text(evidence);
    if (e.status === "evidence_recorded" && e.evidence.length === 0) fail("没有落实证据");
  }
  if (previous) {
    if (data.revision < previous.revision || data.events.length < previous.events.length ||
        previous.events.some((e, i) => canonical(e) !== canonical(data.events[i])) ||
        (data.revision === previous.revision && canonical(data) !== canonical(previous)) ||
        (data.revision > previous.revision && data.events.length === previous.events.length)) fail("历史事件不可重写或删除");
  }
  return data;
}
// NODE ONLY

import fs from 'node:fs';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { buildDecisionMenu } from './xuan-ib-decision-menu.mjs';

export function checkProgress({base = null} = {}) {
  const loader = fs.readFileSync(new URL('../xuan-ib/index.html', import.meta.url), 'utf8');
  const html = fs.readFileSync(new URL('../xuan-ib/latest.html', import.meta.url), 'utf8');
  const meta = JSON.parse(fs.readFileSync(new URL('../xuan-ib/latest.meta.json', import.meta.url), 'utf8'));
  buildDecisionMenu({html, meta});
  const state = parseProgressJson(html.match(/<template id="xuan-ib-decision-state-v1"[^>]*>([\s\S]*?)<\/template>/)[1]);
  const data = parseProgressJson(fs.readFileSync(new URL('../xuan-ib/implementation-progress.json', import.meta.url), 'utf8'));
  let previous = null;
  if (base) {
    if (!/^[0-9a-f]{40}$/.test(base)) throw new Error('base must be a full commit SHA');
    const exists = execFileSync('git', ['ls-tree', base, 'xuan-ib/implementation-progress.json'], {encoding:'utf8'}).trim();
    if (exists) previous = parseProgressJson(execFileSync('git', ['show', base + ':xuan-ib/implementation-progress.json'], {encoding:'utf8'}));
  }
  validateProgress(data, state, previous);
  const source = fs.readFileSync(new URL('./xuan-ib-progress.mjs', import.meta.url), 'utf8').split('// NODE ONLY')[0].trim();
  const embedded = loader.match(/\/\/ BEGIN PROGRESS VALIDATOR\n([\s\S]*?)\n\/\/ END PROGRESS VALIDATOR/)[1].trim();
  if (embedded !== source.replace(/^export /gm, '')) throw new Error('loader progress validator drift');
  new vm.Script(loader.match(/<script>([\s\S]*?)<\/script>/)[1]);
  return data;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  checkProgress({base: process.argv[2] || null});
  console.log('Progress schema, original receipts, append-only history and shared loader validation: PASS');
}
