import {ACTION_DISPLAY_CSP, MAX_ACTION_HTML_BYTES, MAX_ACTION_ENVELOPE_BYTES, decryptPublishedAction,
  packagePublishedAction, actionSha256} from './xuan-ib-encrypted-action.mjs';
export const FEE_UNLOCK_STORAGE_KEY = 'feeConsole.key';
export const ACTION_AUTO_UNLOCK_KEY = 'xuan-ib:fee-unlock-enabled:v1';
const timeoutMs = 15_000;

export async function readActionEnvelope(fetchImpl, baseUrl) {
  const url = new URL('action.enc.json', baseUrl);
  url.searchParams.set('v', String(Date.now()));
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
  let reader;
  try {
    const r = await fetchImpl(url, {cache: 'no-store', credentials: 'omit', redirect: 'error', signal: controller.signal});
    if (!r.ok || Number(r.headers.get('content-length') || 0) > MAX_ACTION_ENVELOPE_BYTES) throw new Error('ACTION_FETCH');
    reader = r.body.getReader();
    const parts = []; let total = 0;
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_ACTION_ENVELOPE_BYTES) throw new Error('ACTION_FETCH_SIZE');
      parts.push(value);
    }
    const bytes = new Uint8Array(total); let offset = 0;
    for (const p of parts) { bytes.set(p, offset); offset += p.length; }
    return new TextDecoder('utf-8', {fatal: true}).decode(bytes);
  } finally { controller.abort(); await reader?.cancel().catch(() => {}); clearTimeout(timer); }
}

// Prefix the deny-all network policy before any report-provided CSS/resource.
// The enclosing iframe additionally has an empty sandbox (no scripts/origin).
export function actionFrameDocument(html) {
  return html.replace(/<head>/i, `<head><meta http-equiv="Content-Security-Policy" content="${ACTION_DISPLAY_CSP}"><meta name="referrer" content="no-referrer">`);
}
export function mountActionConverter(root, {document = globalThis.document, window = globalThis.window,
  storage, urlApi = globalThis.URL} = {}) {
  // This page never fetches reports or discovers credentials. Even local file
  // reads and the single existing-key lookup wait for the user's trusted click.
  root.replaceChildren();
  const el = (tag, text, parent = root) => { const n = document.createElement(tag); if (text) n.textContent = text; parent.append(n); return n; };
  const panel = el('section'); panel.className = 'encrypted-action-panel';
  el('h1', '在本机制作加密副本', panel);
  el('p', '选择已经发布的报告及对应回执。点击转换后，本页只在此浏览器使用已有管理费密钥；不上传文件或密钥，不更新账本。', panel);
  const reportLabel = el('label', '已发布报告 HTML', panel), report = el('input', '', reportLabel);
  report.type = 'file'; report.accept = '.html,text/html'; report.setAttribute('aria-label', '已发布报告 HTML');
  const receiptLabel = el('label', '固定版本发布回执 JSON', panel), receiptInput = el('input', '', receiptLabel);
  receiptInput.type = 'file'; receiptInput.accept = '.json,application/json'; receiptInput.setAttribute('aria-label', '固定版本发布回执 JSON');
  const convert = el('button', '使用本机已有密钥转换', panel); convert.type = 'button';
  const status = el('p', '尚未读取文件或密钥。', panel); status.setAttribute('role', 'status');
  const download = el('a', '下载加密文件', panel); download.download = 'action.enc.json'; download.hidden = true;
  const fee = el('a', '打开管理费页面解锁', panel); fee.href = '../';
  const back = el('a', '返回行动版', panel); back.href = './';
  let sequence = 0, disposed = false, objectUrl = null;
  function clearDownload() {
    download.hidden = true; download.removeAttribute('href');
    if (objectUrl) { urlApi.revokeObjectURL(objectUrl); objectUrl = null; }
  }
  async function onConvert(event) {
    if (event?.isTrusted !== true || disposed || convert.disabled) return;
    const request = ++sequence; clearDownload(); convert.disabled = true;
    let master = null, bytes = null;
    try {
      if (report.files?.length !== 1 || receiptInput.files?.length !== 1) throw new Error('ACTION_SELECT_FILES');
      const sourceFile = report.files[0], receiptFile = receiptInput.files[0];
      if (sourceFile.size <= 0 || sourceFile.size > MAX_ACTION_HTML_BYTES
        || receiptFile.size <= 0 || receiptFile.size > 128 * 1024) throw new Error('ACTION_FILE_SIZE');
      status.textContent = '正在本机核对固定版本并加密…';
      bytes = new Uint8Array(await sourceFile.arrayBuffer());
      const receiptBytes = new Uint8Array(await receiptFile.arrayBuffer());
      if (receiptBytes.length > 128 * 1024) throw new Error('ACTION_FILE_SIZE');
      const receipt = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(receiptBytes)); receiptBytes.fill(0);
      if (disposed || request !== sequence) return;
      let local = storage;
      if (local === undefined) { try { local = window.localStorage; } catch { local = null; } }
      master = local?.getItem(FEE_UNLOCK_STORAGE_KEY) || null;
      if (!master) { status.textContent = '本机没有管理费解锁密钥。请先在同一浏览器的管理费页面解锁，再返回转换。'; return; }
      const envelope = await packagePublishedAction({htmlBytes: bytes, receipt, masterKey: master});
      // Check our own local output before offering it, without persisting a key.
      const decoded = await decryptPublishedAction(envelope, master);
      if (decoded.displaySha256 !== receipt.fixedReadback.sha256) throw new Error('ACTION_LOCAL_READBACK');
      const cipherHash = await actionSha256(new TextEncoder().encode(envelope));
      if (disposed || request !== sequence) return;
      objectUrl = urlApi.createObjectURL(new Blob([envelope], {type: 'application/json'}));
      download.href = objectUrl; download.hidden = false;
      status.textContent = `已在本机完成加密及解密核验。原报告日 ${decoded.reportDate}；原发布时间 ${decoded.publishedAt}。请下载加密文件；尚未发布。密文 SHA256：${cipherHash}`;
    } catch {
      if (!disposed && request === sequence) { clearDownload(); status.textContent = '未生成副本：请检查文件大小、固定版本回执、报告哈希及本机解锁状态。没有上传任何内容。'; }
    } finally {
      master = null; bytes?.fill(0);
      if (request === sequence) { convert.disabled = false; report.value = ''; receiptInput.value = ''; }
    }
  }
  function onHide() { ++sequence; clearDownload(); report.value = ''; receiptInput.value = ''; convert.disabled = false; }
  convert.addEventListener('click', onConvert); window.addEventListener('pagehide', onHide);
  return {dispose() { disposed = true; onHide(); window.removeEventListener('pagehide', onHide); root.replaceChildren(); }};
}
export function mountEncryptedAction(root, {document = globalThis.document, window = globalThis.window,
  fetchImpl = globalThis.fetch, baseUrl = globalThis.location.href, storage} = {}) {
  if (new URL(baseUrl).searchParams.get('prepare') === 'local') return mountActionConverter(root, {document, window, storage});
  if (storage === undefined) { try { storage = window.localStorage; } catch { storage = null; } }
  root.replaceChildren();
  const el = (tag, text, parent = root) => { const n = document.createElement(tag); if (text) n.textContent = text; parent.append(n); return n; };
  const panel = el('section'); panel.className = 'encrypted-action-panel';
  el('h1', 'XUAN · 行动版', panel);
  const status = el('p', '使用管理费密钥在本机解锁，密钥不会发送到服务器。', panel); status.setAttribute('role', 'status');
  const form = el('form', '', panel), label = el('label', '管理费解锁密钥', form);
  const input = el('input', '', label); input.type = 'password'; input.autocomplete = 'off'; input.spellcheck = false;
  input.setAttribute('aria-label', '管理费解锁密钥');
  const rememberLabel = el('label', '', form), remember = el('input', '', rememberLabel); remember.type = 'checkbox';
  el('span', ' 在此设备记住（与管理费共用解锁项）', rememberLabel);
  const unlock = el('button', '解锁', form); unlock.type = 'submit';
  const saved = el('button', '使用本机已保存的管理费密钥', panel); saved.type = 'button';
  const refresh = el('button', '读取最新发布', panel); refresh.type = 'button'; refresh.hidden = true;
  const lock = el('button', '锁定行动版', panel); lock.type = 'button'; lock.hidden = true;
  const history = el('a', '查看旧公开记录', panel); history.href = '?view=public';
  const prepare = el('a', '本机转换已发布报告', panel); prepare.href = '?prepare=local';
  const frame = el('iframe'); frame.title = '已解锁的行动版参考报告'; frame.setAttribute('sandbox', '');
  frame.setAttribute('referrerpolicy', 'no-referrer'); frame.hidden = true;
  let key = null, sequence = 0, latest = null, disposed = false;
  const stored = k => { try { return storage?.getItem(k) || ''; } catch { return ''; } };
  const set = (k, v) => { try { storage?.setItem(k, v); return !!storage; } catch { return false; } };
  function clearDisplay() { frame.srcdoc = ''; frame.hidden = true; refresh.hidden = true; lock.hidden = true; }
  async function load(candidate, persist = false) {
    const request = ++sequence; clearDisplay(); input.value = ''; key = null;
    unlock.disabled = true; saved.disabled = true; refresh.disabled = true;
    status.textContent = '正在读取并解锁已发布报告…';
    try {
      const payload = await decryptPublishedAction(await readActionEnvelope(fetchImpl, baseUrl), candidate);
      if (disposed || request !== sequence) return;
      if (latest && (Date.parse(payload.publishedAt) < Date.parse(latest.publishedAt)
        || BigInt(payload.sourceGeneration) < BigInt(latest.sourceGeneration)
        || (payload.sourceGeneration === latest.sourceGeneration && payload.displaySha256 !== latest.displaySha256))) throw new Error('ACTION_ROLLBACK');
      latest = {publishedAt: payload.publishedAt, sourceGeneration: payload.sourceGeneration, displaySha256: payload.displaySha256};
      key = candidate;
      let remembered = true;
      if (persist) remembered = set(FEE_UNLOCK_STORAGE_KEY, candidate);
      if (persist || stored(FEE_UNLOCK_STORAGE_KEY) === candidate) set(ACTION_AUTO_UNLOCK_KEY, 'yes');
      frame.srcdoc = actionFrameDocument(payload.html); frame.hidden = false; refresh.hidden = false; lock.hidden = false;
      status.textContent = `报告日 ${payload.reportDate} · 原发布时间 ${new Date(payload.publishedAt).toLocaleString('zh-HK', {timeZone: 'Asia/Hong_Kong', hour12: false})} HKT · 参考快照，非实时${remembered ? '' : ' · 本机无法保存密钥'}`;
      form.hidden = true; saved.hidden = true;
    } catch {
      if (!disposed && request === sequence) { clearDisplay(); status.textContent = '尚无可用加密报告，或密钥不匹配／读取失败。没有显示旧公开页作为最新报告。'; form.hidden = false; saved.hidden = false; }
    } finally {
      if (request === sequence) { unlock.disabled = false; saved.disabled = false; refresh.disabled = false; }
      candidate = null;
    }
  }
  function onSubmit(e) { e.preventDefault(); void load(input.value.trim(), remember.checked); }
  function onSaved() { const value = stored(FEE_UNLOCK_STORAGE_KEY); if (value) void load(value); else status.textContent = '此浏览器未保存管理费密钥，请在上方输入；不要粘贴管理人完整链接。'; }
  function onLock() {
    ++sequence; key = null; input.value = ''; clearDisplay(); form.hidden = false; saved.hidden = false;
    unlock.disabled = false; saved.disabled = false; refresh.disabled = false;
    set(ACTION_AUTO_UNLOCK_KEY, 'no');
    status.textContent = '行动版已锁定，管理费已有解锁设置未删除。';
  }
  function onHide() {
    ++sequence; key = null; input.value = ''; clearDisplay(); form.hidden = false; saved.hidden = false;
    unlock.disabled = false; saved.disabled = false; refresh.disabled = false;
  }
  function onShow() { if (!disposed && stored(ACTION_AUTO_UNLOCK_KEY) !== 'no') onSaved(); }
  form.addEventListener('submit', onSubmit); saved.addEventListener('click', onSaved);
  refresh.addEventListener('click', () => { if (key) void load(key); }); lock.addEventListener('click', onLock);
  window.addEventListener('pagehide', onHide); window.addEventListener('pageshow', onShow);
  if (stored(ACTION_AUTO_UNLOCK_KEY) !== 'no' && stored(FEE_UNLOCK_STORAGE_KEY)) onSaved();
  return {dispose() { disposed = true; onHide(); window.removeEventListener('pagehide', onHide); window.removeEventListener('pageshow', onShow); root.replaceChildren(); }};
}
