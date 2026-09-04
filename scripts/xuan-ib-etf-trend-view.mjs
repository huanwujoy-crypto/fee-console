// Optional owner-approved open comparison. Never reads a key or the original ledger.
import {validateOpenEtfTrend,renderEtfTrend} from './xuan-ib-etf-trend.mjs';
import {ETF_SUMMARY_ID,parseEtfSummary} from './xuan-ib-etf-summary-transport.mjs';
export const ETF_SEEN_DATE='xuan-etf:last-source-date:open-v3';
export const MAX_ETF_DISPLAY_BYTES=512000;
const panelId='xuan-etf-private-panel'; // Retain the existing owned DOM identity.
const mounts=new WeakMap(),displayed=new WeakMap();

export async function mountEtfTrend({doc,storage,baseUrl,fetchFn=globalThis.fetch,isCurrent=()=>true,now=new Date()}){
  const panes=doc.querySelectorAll('.pane.p5');
  if(panes.length!==1||!isCurrent())return;
  mounts.get(doc)?.controller.abort();
  const mount={controller:new AbortController()};mounts.set(doc,mount);
  const current=()=>mounts.get(doc)===mount&&isCurrent();
  const readSeen=()=>{try{return storage?.getItem(ETF_SEEN_DATE)||null;}catch{return null;}};
  const pane=panes[0];
  let panel=doc.getElementById(panelId);
  if(!panel){panel=doc.createElement('section');panel.id=panelId;panel.className='card';pane.prepend(panel);}
  const message=text=>{if(current()&&panel.isConnected){displayed.delete(doc);panel.replaceChildren();const p=doc.createElement('p');p.textContent=text;panel.append(p);}};
  if(displayed.get(doc)?.panel!==panel)message('正在读取 ABC 比较…');
  const controller=mount.controller,timeout=setTimeout(()=>controller.abort(),8000);
  try{
    const summaries=doc.querySelectorAll(`[id="${ETF_SUMMARY_ID}"]`);
    let bytes;
    if(summaries.length){
      if(summaries.length!==1)throw new Error('duplicate embedded summary');
      const summary=summaries[0];
      if(summary.tagName!=='TEMPLATE'||summary.getAttribute('type')!=='application/json'
          ||summary.attributes.length!==2||!pane.contains(summary))throw new Error('embedded summary identity');
      // doc belongs to an already verified sourceSha/htmlBlob pair. Invalid
      // embedded content must fail locally, not silently fetch an older file.
      const text=summary.content.textContent;
      parseEtfSummary(text,{now,maxSeenDate:readSeen()});
      bytes=new TextEncoder().encode(text);
    }else{
    // Migration fallback for reports predating the embedded daily summary.
    const url=new URL('etf-trend.json',baseUrl);
    if(url.origin!==new URL(baseUrl).origin||url.protocol!=='https:')throw new Error('origin');
    url.searchParams.set('v',String(now.getTime()));
    const r=await fetchFn(url.href,{cache:'no-store',credentials:'omit',redirect:'error',signal:controller.signal});
    if(!r.ok)throw new Error('unavailable');
    const size=r.headers?.get('Content-Length');
    if(size!==null&&size!==undefined&&Number(size)>=MAX_ETF_DISPLAY_BYTES)throw new Error('size');
    bytes=new Uint8Array(await r.arrayBuffer());
    }
    if(bytes.byteLength>=MAX_ETF_DISPLAY_BYTES)throw new Error('size');
    const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes).trim(),parsed=JSON.parse(text);
    if(JSON.stringify(parsed)!==text)throw new Error('noncanonical or duplicate JSON');
    const data=validateOpenEtfTrend(parsed,{now,maxSeenDate:readSeen()});
    if(!current()||!panel.isConnected)return;
    // Cache identity only. A hash does not independently prove financial sources.
    const digest=await globalThis.crypto.subtle.digest('SHA-256',bytes);
    const fingerprint=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
    if(!current()||!panel.isConnected)return;
    if(controller.signal.aborted)throw new Error('aborted');
    validateOpenEtfTrend(data,{now,maxSeenDate:readSeen()});
    const saveSeen=()=>{try{storage?.setItem(ETF_SEEN_DATE,data.rows.at(-1).date);}catch{}};
    const previous=displayed.get(doc);
    if(previous?.panel===panel&&previous.fingerprint===fingerprint){saveSeen();return;}
    const template=doc.createElement('template');template.innerHTML=renderEtfTrend(data);
    panel.replaceChildren(template.content.cloneNode(true));displayed.set(doc,{panel,fingerprint});saveSeen();
    for(const node of [...pane.children]){
      if(node===panel||node.id==='xuan-etf-original-history')continue;
      let history=doc.getElementById('xuan-etf-original-history');
      if(!history){history=doc.createElement('details');history.id='xuan-etf-original-history';const s=doc.createElement('summary');s.textContent='原方案与历史基线记录';history.append(s);pane.append(history);}
      history.append(node);
    }
  }catch{message('ABC 比较暂不可用，请稍后刷新；其它报告保留。');}
  finally{clearTimeout(timeout);}
}

export function clearEtfTrend(doc){
  if(doc){mounts.get(doc)?.controller.abort();mounts.delete(doc);displayed.delete(doc);}
  const panel=doc?.getElementById(panelId);
  if(panel){panel.replaceChildren();const p=doc.createElement('p');p.textContent='返回页面后重新读取 ABC 比较。';panel.append(p);}
}
