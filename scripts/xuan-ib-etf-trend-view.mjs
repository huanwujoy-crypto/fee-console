// Optional private panel. A failure never changes or blocks the trusted report.
import {decryptEtfTrend, MAX_ETF_ENVELOPE_BYTES} from './xuan-ib-etf-trend-envelope.mjs';
import {renderEtfTrend} from './xuan-ib-etf-trend.mjs';
export const ETF_DEVICE_KEY='xuan-etf:private-key:v2';
export const ETF_SEEN_DATE='xuan-etf:last-source-date:v2';
const panelId='xuan-etf-private-panel';
const mounts=new WeakMap();
// In-memory ciphertext identity only: never cache keys or financial payloads.
const displayed=new WeakMap();

export async function mountEtfTrend({doc,storage,baseUrl,fetchFn=globalThis.fetch,isCurrent=()=>true,now=new Date(),keyOverride=null}){
  const panes=doc.querySelectorAll('.pane.p5');
  if(panes.length!==1||!isCurrent())return;
  mounts.get(doc)?.controller.abort();
  const mount={controller:new AbortController()};mounts.set(doc,mount);
  const current=()=>mounts.get(doc)===mount&&isCurrent();
  const pane=panes[0];
  let panel=doc.getElementById(panelId);
  if(!panel){panel=doc.createElement('section');panel.id=panelId;panel.className='card';pane.prepend(panel);}
  const message=text=>{if(current()&&panel.isConnected){displayed.delete(doc);panel.replaceChildren();const p=doc.createElement('p');p.textContent=text;panel.append(p);}};
  let key=null,seen=null;
  try{key=keyOverride||storage?.getItem(ETF_DEVICE_KEY);seen=storage?.getItem(ETF_SEEN_DATE);}catch{}
  const unlock=()=>{
    if(!current()||!panel.isConnected)return;
    message('ABC 私密比较：此手机首次查看需输入专属访问码。不会修改账本或交易。');
    const input=doc.createElement('input');input.type='password';input.autocomplete='off';input.placeholder='专属访问码';input.setAttribute('aria-label','ETF 专属访问码');
    // The report's `.tabs input` rule hides its radios, but also matches this
    // nested password field. Override only this owned control, never the report.
    Object.assign(input.style,{position:'static',opacity:'1',pointerEvents:'auto',display:'block',
      boxSizing:'border-box',width:'100%',maxWidth:'100%',minHeight:'44px',fontFamily:'inherit',fontSize:'16px',
      padding:'10px 12px',margin:'8px 0',color:'var(--ink,#111)',background:'var(--card,#fff)',
      border:'1px solid var(--grid,#ccc)',borderRadius:'8px'});
    const button=doc.createElement('button');button.type='button';button.textContent='启用此手机';button.style.minHeight='44px';
    button.addEventListener('click',()=>{
      if(!current()||!panel.isConnected)return;
      const candidate=input.value.trim();input.value='';
      if(!/^[A-Za-z0-9_-]{43}$/.test(candidate)){input.placeholder='请检查专属访问码';return;}
      return mountEtfTrend({doc,storage,baseUrl,fetchFn,isCurrent,now:new Date(),keyOverride:candidate});
    });panel.append(input,button);
  };
  if(!key){unlock();return;}
  // A verified panel keeps its visible source date and disclosure state while
  // polling. Initial loads and real failures never present unverified content.
  if(displayed.get(doc)?.panel!==panel)message('正在读取 ABC 私密比较…');
  const controller=mount.controller,timeout=setTimeout(()=>controller.abort(),8000);
  try{
    const url=new URL('etf-trend.enc.json',baseUrl);
    if(url.origin!==new URL(baseUrl).origin)throw new Error('origin');
    url.searchParams.set('v',String(now.getTime()));
    const r=await fetchFn(url.href,{cache:'no-store',credentials:'omit',redirect:'error',signal:controller.signal});
    if(!r.ok)throw new Error('unavailable');
    const size=r.headers?.get('Content-Length');
    if(size!==null&&size!==undefined&&Number(size)>=MAX_ETF_ENVELOPE_BYTES)throw new Error('size');
    const bytes=new Uint8Array(await r.arrayBuffer());
    if(bytes.byteLength>=MAX_ETF_ENVELOPE_BYTES)throw new Error('size');
    const payload=await decryptEtfTrend(bytes,key,{now,maxSeenDate:seen||null});
    if(!current()||!panel.isConnected)return;
    const digest=await globalThis.crypto.subtle.digest('SHA-256',bytes);
    const fingerprint=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
    // Hashing is asynchronous too: another mount/tab may have cleared this
    // panel, changed its key, or accepted newer data while it was pending.
    if(!current()||!panel.isConnected)return;
    if(controller.signal.aborted)throw new Error('aborted');
    const currentSeen=storage?.getItem(ETF_SEEN_DATE);
    if(currentSeen&&payload.projection.rows.at(-1).date<currentSeen)throw new Error('older source');
    if(keyOverride){if(storage?.getItem(ETF_DEVICE_KEY)&&storage.getItem(ETF_DEVICE_KEY)!==key)throw new Error('key changed');storage?.setItem(ETF_DEVICE_KEY,key);}
    else if(storage?.getItem(ETF_DEVICE_KEY)!==key)throw new Error('key changed');
    const previous=displayed.get(doc);
    if(previous?.panel===panel&&previous.fingerprint===fingerprint){
      try{storage?.setItem(ETF_SEEN_DATE,payload.projection.rows.at(-1).date);}catch{}
      return;
    }
    const template=doc.createElement('template');
    template.innerHTML=renderEtfTrend(payload.projection,{privateResult:payload.result});
    panel.replaceChildren(template.content.cloneNode(true));
    displayed.set(doc,{panel,fingerprint});
    // Only a date high-water mark is persisted, never plaintext financial data.
    try{storage?.setItem(ETF_SEEN_DATE,payload.projection.rows.at(-1).date);}catch{}
    // Preserve the source policy/history rather than rewriting its guarded HTML.
    for(const node of [...pane.children]){
      if(node===panel||node.id==='xuan-etf-original-history')continue;
      let history=doc.getElementById('xuan-etf-original-history');
      if(!history){history=doc.createElement('details');history.id='xuan-etf-original-history';const s=doc.createElement('summary');s.textContent='原方案与历史基线记录';history.append(s);pane.append(history);}
      history.append(node);
    }
  }catch{message('ABC 私密数据暂不可用，请稍后刷新；未用旧值冒充更新，其它报告保留。');
    if(keyOverride&&current()&&panel.isConnected){const retry=doc.createElement('button');retry.textContent='重新输入';retry.addEventListener('click',unlock);panel.append(retry);}
  }
  finally{clearTimeout(timeout);key=null;}
}

export function clearEtfTrend(doc){
  if(doc){mounts.get(doc)?.controller.abort();mounts.delete(doc);displayed.delete(doc);}
  const panel=doc?.getElementById(panelId);
  if(panel){panel.replaceChildren();const p=doc.createElement('p');p.textContent='返回页面后重新读取私密比较。';panel.append(p);}
}
