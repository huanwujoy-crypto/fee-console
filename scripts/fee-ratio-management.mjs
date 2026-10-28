import {createFeeCompanyExposureCore} from './fee-ratio-company-exposure.mjs';
// Pure manager-only report and recipient codec. No reads, credentials, storage,
// publication or broker adapter. Browser uses this exact factory, not a shared
// fee-key decoder. Actual manager use/recipient registration needs approval.
export function createFeeRatioCore(exposureCore,cryptoImpl=globalThis.crypto){
  const companyCore=createFeeCompanyExposureCore();
  const SCHEMA='fee-console.ratio-view.v1',RECIPIENT='fee-console.ratio-recipient.v1',ENVELOPE='fee-console.ratio-manager-envelope.v1';
  const DOMAIN='fee-console/ratio-management/manager-recipient/v1',MAX=2*1024*1024;
  const fail=()=>{throw Error('RATIO_MANAGER_REFUSED');};
  const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
  const canonical=v=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
  const bytes=s=>new TextEncoder().encode(s),hex=b=>[...new Uint8Array(b)].map(n=>n.toString(16).padStart(2,'0')).join('');
  const digest=async v=>hex(await cryptoImpl.subtle.digest('SHA-256',bytes(typeof v==='string'?v:canonical(v))));
  const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  function encode(a){let out='',bits=0,v=0;for(const n of a){v=(v<<8)|n;bits+=8;while(bits>=6){bits-=6;out+=alphabet[(v>>>bits)&63];}}if(bits)out+=alphabet[(v<<(6-bits))&63];return out;}
  function decode(s){if(typeof s!=='string'||!s.length||s.length>MAX*2||!/^[A-Za-z0-9_-]+$/.test(s))fail();const out=[];let bits=0,v=0;for(const c of s){v=(v<<6)|alphabet.indexOf(c);bits+=6;if(bits>=8){bits-=8;out.push((v>>>bits)&255);}}const a=Uint8Array.from(out);if(encode(a)!==s)fail();return a;}
  const join=(...xs)=>{const out=new Uint8Array(xs.reduce((s,x)=>s+x.length,0));let at=0;for(const x of xs){out.set(x,at);at+=x.length;}return out;};
  const date=s=>typeof s==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(s)&&Number.isFinite(Date.parse(s+'T00:00:00Z'))&&new Date(s+'T00:00:00Z').toISOString().slice(0,10)===s;
  const instant=s=>typeof s==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(s)&&Number.isFinite(Date.parse(s));
  const cents=n=>Number.isSafeInteger(n)&&n>=0&&n<=1e14;
  const text=s=>typeof s==='string'&&s.length>0&&s.length<=500&&!/[\u0000-\u001f\u007f]/.test(s);
  async function validateRecipient(r,scopeId){
    if(!exact(r,['schema','algorithm','scopeId','publicKey','recipientId'])||r.schema!==RECIPIENT||r.algorithm!=='X25519-HKDF-SHA256-AES256GCM'||!/^[a-f0-9]{64}$/.test(r.scopeId)||scopeId&&r.scopeId!==scopeId||decode(r.publicKey).length!==32||!decode(r.publicKey).some(n=>n))fail();
    const {recipientId,...body}=r;if(await digest(body)!==recipientId)fail();return structuredClone(r);
  }
  async function recipientScope(gid){if(typeof gid!=='string'||!/^([a-f0-9]{20}|[a-f0-9]{32})$/.test(gid))fail();return digest([DOMAIN,'scope',gid]);}
  async function deriveManager(gid,feeKey,managerToken){
    if(typeof gid!=='string'||!/^[a-f0-9]{20,32}$/.test(gid)||typeof feeKey!=='string'||typeof managerToken!=='string'||managerToken.length<20||managerToken.length>8192||/[\s\u0000-\u001f]/.test(managerToken))fail();
    const keyBytes=decode(feeKey.replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''));if(keyBytes.length!==32)fail();
    const normalizedKey=encode(keyBytes);keyBytes.fill(0);
    const scopeId=await recipientScope(gid),seed=new Uint8Array(await cryptoImpl.subtle.digest('SHA-256',bytes(canonical([DOMAIN,gid,normalizedKey,managerToken]))));
    const der=join(Uint8Array.from([48,46,2,1,0,48,5,6,3,43,101,110,4,34,4,32]),seed);let privateKey;
    try{privateKey=await cryptoImpl.subtle.importKey('pkcs8',der,{name:'X25519'},false,['deriveBits']);}finally{seed.fill(0);der.fill(0);}
    // RFC7748 base point u=9 gives the public key without exporting private d.
    const base=new Uint8Array(32);base[0]=9;
    const baseKey=await cryptoImpl.subtle.importKey('raw',base,{name:'X25519'},false,[]),pub=new Uint8Array(await cryptoImpl.subtle.deriveBits({name:'X25519',public:baseKey},privateKey,256));
    const body={schema:RECIPIENT,algorithm:'X25519-HKDF-SHA256-AES256GCM',scopeId,publicKey:encode(pub)};
    return {privateKey,recipient:{...body,recipientId:await digest(body)}};
  }
  async function deriveSnapshotManager(gid,feeKey,managerToken){
    const manager=await deriveManager(gid,feeKey,managerToken);
    const raw=decode(feeKey.replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''));
    const normalized=encode(raw);raw.fill(0);
    const seed=new Uint8Array(await cryptoImpl.subtle.digest('SHA-256',bytes(canonical(['fee-console/ratio-snapshot/manager-authentication/v1',gid,normalized,managerToken]))));
    try{return {...manager,authenticationKey:await cryptoImpl.subtle.importKey('raw',seed,{name:'HMAC',hash:'SHA-256'},false,['sign','verify'])};}finally{seed.fill(0);}
  }
  async function contentKey(privateKey,publicKey,salt,context){
    const shared=new Uint8Array(await cryptoImpl.subtle.deriveBits({name:'X25519',public:publicKey},privateKey,256));
    try{if(!shared.some(n=>n))fail();const material=await cryptoImpl.subtle.importKey('raw',shared,'HKDF',false,['deriveKey']);return await cryptoImpl.subtle.deriveKey({name:'HKDF',hash:'SHA-256',salt,info:bytes(canonical([DOMAIN,context]))},material,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);}finally{shared.fill(0);}
  }
  async function validateModel(m){
    if(!exact(m,['schema','source','report','exposure','book','limitations',...(Object.hasOwn(m||{},'companyExposure')?['companyExposure']:[])])||m.schema!==SCHEMA||m.source!=='Sharesight'||!Array.isArray(m.limitations)||m.limitations.length>50||!m.limitations.every(text))fail();
    const p=m.report;if(!exact(p,['kind','targetDate','feeAccountingThrough','generatedAt'])||!['weekly','monthly','weekly-monthly','snapshot'].includes(p.kind)||!date(p.targetDate)||!(p.feeAccountingThrough===null||date(p.feeAccountingThrough))||!instant(p.generatedAt))fail();
    if(new TextEncoder().encode(canonical(m)).length>MAX)fail();
    const exp=exposureCore.buildRankedExposureView(m.exposure);
    if(!exp.retrievedAt||Date.parse(exp.retrievedAt)>Date.parse(p.generatedAt)||exp.valuationDate>p.targetDate)fail();
    const scope=await digest(m.exposure.summary.accounts.map(x=>x.replaceAll('&amp;','&')).sort());
    if(scope!==exposureCore.ALL_TOGETHER_SCOPE_SHA256)fail();
    if(m.book!==null){
      const b=m.book,browser=Object.hasOwn(b,'browserEvidence');if(!exact(b,['source','asOf','retrievedAt','sourceSha256','ibCashCents','noahCashCents','allocation','holdings',...(browser?['browserEvidence']:[])])||b.source!=='Sharesight'||!date(b.asOf)||!instant(b.retrievedAt)||b.asOf>p.targetDate||Date.parse(b.retrievedAt)>Date.parse(p.generatedAt)||!/^[a-f0-9]{64}$/.test(b.sourceSha256))fail();
      if(![b.ibCashCents,b.noahCashCents].every(v=>v===null||cents(v)))fail();
      if(b.allocation!==null){const a=b.allocation;if(!exact(a,['totalCents','categories','usscCents','cashLike'])||!cents(a.totalCents)||a.totalCents<=0||!cents(a.usscCents)||!Array.isArray(a.categories)||a.categories.length!==4||!Array.isArray(a.cashLike))fail();
        const labels=['美国底仓','美国科技','非美发达','新兴市场'],targets=[45,20,23,12];
        if(a.categories.some((c,i)=>!exact(c,['label','valueCents','targetPct'])||c.label!==labels[i]||c.targetPct!==targets[i]||!cents(c.valueCents))||a.categories.reduce((s,c)=>s+c.valueCents,0)!==a.totalCents||a.usscCents>a.categories[0].valueCents)fail();
        if(a.cashLike.some(c=>!exact(c,['symbol','valueCents'])||!['VGSH','VGIT','TLT'].includes(c.symbol)||!cents(c.valueCents))||new Set(a.cashLike.map(c=>c.symbol)).size!==a.cashLike.length)fail();
      }
      if(b.holdings!==null&&(!Array.isArray(b.holdings)||b.holdings.length>5000||b.holdings.some(h=>!exact(h,['name','symbol','valueCents','category',...(browser?['market','quantity','valueBasis','nameBasis']:[])])||!text(h.name)||!text(h.symbol)||!text(h.category)||!cents(h.valueCents)||browser&&(!text(h.market)||!(h.quantity===null||Number.isFinite(h.quantity)&&h.quantity>=0)||!['preserved-browser-source','same-export-underlying-plus-residual'].includes(h.valueBasis)||!['source-code-only','source-name'].includes(h.nameBasis)))))fail();
      if(browser){const e=b.browserEvidence,verified=e.integrity==='verified-original-library-association',time=s=>typeof s==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(s)&&Number.isFinite(Date.parse(s));
        if(!exact(e,['transport','observedAtBasis','exportCreatedAt','exportLastWrittenAt','classificationSavedAt','fullSourceBytes','fullSourceSha256','transferStatus','limitations','integrity',...(verified?['associationId','managerScopeId','sourceVersion','migrationPending','classificationDeltaCents','exposureDeltaCents']:[])])||e.transport!=='browser-export-and-ui'||e.observedAtBasis!=='original-export-download-time'||!['declared-not-verified-on-this-device','verified-original-library-association'].includes(e.integrity)||verified&&(!/^[a-f0-9]{64}$/.test(e.associationId)||!/^[a-f0-9]{64}$/.test(e.managerScopeId)||!Number.isSafeInteger(e.sourceVersion)||e.sourceVersion<0||typeof e.migrationPending!=='boolean'||![e.classificationDeltaCents,e.exposureDeltaCents].every(Number.isSafeInteger))||e.fullSourceSha256!==b.sourceSha256||!Number.isSafeInteger(e.fullSourceBytes)||e.fullSourceBytes<1||e.fullSourceBytes>5*1024*1024||![e.exportCreatedAt,e.exportLastWrittenAt,e.classificationSavedAt].every(time)||[e.exportCreatedAt,e.exportLastWrittenAt,e.classificationSavedAt].some(s=>Date.parse(s)>Date.parse(p.generatedAt))||!text(e.transferStatus)||!Array.isArray(e.limitations)||e.limitations.length>50||!e.limitations.every(text))fail();
      }
    }
    if(Object.hasOwn(m,'companyExposure')){
      if(m.book?.browserEvidence?.integrity!=='verified-original-library-association')fail();
      companyCore.validate(m.companyExposure,m.exposure,m.book.sourceSha256);
    }
    return structuredClone(m);
  }
  function validateBinding(b,model){
    if(!exact(b,['schema','revision','previousCipherSha256','feeReceiptId','feeAsOf','sourceDate'])||b.schema!=='fee-console.ratio-binding.v1'||!/^[-a-f0-9]{36}$/.test(b.revision)||!(b.previousCipherSha256===null||/^[a-f0-9]{64}$/.test(b.previousCipherSha256))||!(b.feeReceiptId===null||/^[a-f0-9]{64}$/.test(b.feeReceiptId))||!date(b.feeAsOf)||!date(b.sourceDate))fail();
    if(model&&(b.sourceDate!==model.report.targetDate||b.feeAsOf!==(model.report.feeAccountingThrough||model.report.targetDate)))fail();
    return b;
  }
  async function publication(envelope,model){
    validateBinding(envelope.binding,model);
    return {schema:'fee-console.ratio-publication.v1',binding:structuredClone(envelope.binding),scopeId:envelope.scopeId,recipientId:envelope.recipientId,cipherSha256:await digest(envelope),generatedAt:model.report.generatedAt};
  }
  async function validatePublication(envelope,p,fee,watermark=null){
    if(!exact(p,['schema','binding','scopeId','recipientId','cipherSha256','generatedAt'])||p.schema!=='fee-console.ratio-publication.v1'||!instant(p.generatedAt)||!fee||p.binding.feeReceiptId!==fee.receiptId||p.binding.feeAsOf!==fee.asOf||p.binding.sourceDate>fee.asOf)fail();
    validateBinding(p.binding);
    if(canonical(p.binding)!==canonical(envelope.binding)||p.scopeId!==envelope.scopeId||p.recipientId!==envelope.recipientId||await digest(envelope)!==p.cipherSha256)fail();
    if(watermark){
      if(!exact(watermark,['sourceDate','feeAsOf','generatedAt','revision','cipherSha256'])||!date(watermark.sourceDate)||!date(watermark.feeAsOf)||!instant(watermark.generatedAt)||!/^[a-f0-9]{64}$/.test(watermark.cipherSha256))fail();
      if(p.binding.sourceDate<watermark.sourceDate||p.binding.feeAsOf<watermark.feeAsOf||p.generatedAt<watermark.generatedAt||(p.generatedAt===watermark.generatedAt&&p.cipherSha256!==watermark.cipherSha256))fail();
    }
    return {sourceDate:p.binding.sourceDate,feeAsOf:p.binding.feeAsOf,generatedAt:p.generatedAt,revision:p.binding.revision,cipherSha256:p.cipherSha256};
  }
  async function seal(model,recipient,binding=null){
    const m=await validateModel(model),r=await validateRecipient(recipient),pair=await cryptoImpl.subtle.generateKey({name:'X25519'},false,['deriveBits']);
    if(m.book?.browserEvidence?.integrity==='verified-original-library-association'&&m.book.browserEvidence.managerScopeId!==r.scopeId)fail();
    binding=validateBinding(binding||{schema:'fee-console.ratio-binding.v1',revision:cryptoImpl.randomUUID(),previousCipherSha256:null,feeReceiptId:null,feeAsOf:m.report.feeAccountingThrough||m.report.targetDate,sourceDate:m.report.targetDate},m);
    const salt=cryptoImpl.getRandomValues(new Uint8Array(32)),iv=cryptoImpl.getRandomValues(new Uint8Array(12));
    const context={schema:ENVELOPE,binding:structuredClone(binding),algorithm:r.algorithm,scopeId:r.scopeId,recipientId:r.recipientId,ephemeralPublicKey:encode(new Uint8Array(await cryptoImpl.subtle.exportKey('raw',pair.publicKey))),salt:encode(salt)};
    const pub=await cryptoImpl.subtle.importKey('raw',decode(r.publicKey),{name:'X25519'},false,[]),key=await contentKey(pair.privateKey,pub,salt,context),aad=bytes(canonical(context)),plain=bytes(canonical(m));
    try{const ciphertext=new Uint8Array(await cryptoImpl.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad},key,plain));const check=new Uint8Array(await cryptoImpl.subtle.decrypt({name:'AES-GCM',iv,additionalData:aad},key,ciphertext));if(hex(check)!==hex(plain))fail();check.fill(0);return {...context,iv:encode(iv),ciphertext:encode(ciphertext)};}finally{plain.fill(0);}
  }
  async function open(envelope,manager){
    try{
      if(!exact(envelope,['schema','algorithm','scopeId','recipientId','ephemeralPublicKey','salt','iv','ciphertext','binding'])||envelope.schema!==ENVELOPE||envelope.algorithm!=='X25519-HKDF-SHA256-AES256GCM'||envelope.scopeId!==manager.recipient.scopeId||envelope.recipientId!==manager.recipient.recipientId)fail();
      validateBinding(envelope.binding);
      const {iv,ciphertext,...context}=envelope,salt=decode(context.salt),nonce=decode(iv),cipher=decode(ciphertext),pubBytes=decode(context.ephemeralPublicKey);
      if(salt.length!==32||nonce.length!==12||pubBytes.length!==32||cipher.length<16||cipher.length>MAX+16)fail();
      const pub=await cryptoImpl.subtle.importKey('raw',pubBytes,{name:'X25519'},false,[]),key=await contentKey(manager.privateKey,pub,salt,context),plain=new Uint8Array(await cryptoImpl.subtle.decrypt({name:'AES-GCM',iv:nonce,additionalData:bytes(canonical(context))},key,cipher));
      try{const m=await validateModel(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(plain)));validateBinding(envelope.binding,m);if(m.book?.browserEvidence?.integrity==='verified-original-library-association'&&m.book.browserEvidence.managerScopeId!==envelope.scopeId)fail();return m;}finally{plain.fill(0);}
    }catch{fail();}
  }
  const esc=v=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const money=n=>n===null?'未取得':'USD '+(n/100).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
  function renderRatioModel(m){
    const view=exposureCore.buildRankedExposureView(m.exposure),delta=view.groups.reduce((n,g)=>n+g.totalUsd,0)-view.portfolioTotalUsd;
    const b=m.book,a=b?.allocation,ib=b?.ibCashCents??null,noah=b?.noahCashCents??null,pool=ib===null||noah===null?null:ib+noah;
    const company=m.companyExposure?companyCore.validate(m.companyExposure,m.exposure,b?.sourceSha256):null;
    const detail=(label,body)=>'<details><summary>'+label+'</summary>'+body+'</details>';
    const overview='<section class="card ratio-asset-overview"><h2>四类资产配置总览</h2><p>All Together · 10账户 · USD · 来源截至 '+esc(view.valuationDate)+'</p>'+view.groups.map(g=>'<div><strong>'+esc(g.category)+'</strong> · '+money(Math.round(g.totalUsd*100))+' · '+(g.totalUsd/view.portfolioTotalUsd*100).toFixed(2)+'%<div role="meter" aria-label="'+esc(g.category)+'占总资产" aria-valuemin="0" aria-valuemax="100" aria-valuenow="'+(g.totalUsd/view.portfolioTotalUsd*100).toFixed(4)+'" style="height:8px;background:#edf0f5;margin:6px 0 12px"><span style="display:block;height:100%;background:#4778b8;width:'+Math.max(0,Math.min(100,g.totalUsd/view.portfolioTotalUsd*100))+'%"></span></div></div>').join('')+'<p>类别合计与总资产舍入差 '+delta.toFixed(2)+' USD，保留原差异。</p></section>';
    const table=rows=>'<table><thead><tr><th>名称</th><th>USD金额</th><th>占总资产／占本类资产</th></tr></thead><tbody>'+rows.map((r,i)=>'<tr><td>'+(i+1)+'. '+esc(r.name)+'</td><td>'+money(Math.round(r.valueUsd*100))+'</td><td>'+r.portfolioWeightPct.toFixed(2)+'%／'+r.categoryWeightPct.toFixed(2)+'%</td></tr>').join('')+'</tbody></table>';
    const groups=view.groups.map((g,i)=>'<section><h3>'+esc(g.category)+(i===3?(company?.top?' · 公司经济敞口前五':' · 原证券口径前五'):' · 直接持仓前五')+'</h3><p>本类资产 '+money(Math.round(g.totalUsd*100))+'</p>'+(i===3&&company?.top?companyCore.render(m.companyExposure,m.exposure,b?.sourceSha256):table(g.top))+'</section>').join('');
    const companyStatus=company?.top?'<p class="ratio-key-status">公司经济敞口含显式杠杆，比例可能超过100%；不改变总资产、类别资产及管理费。</p>':company?companyCore.render(m.companyExposure,m.exposure,b?.sourceSha256):'<p class="ratio-key-status">旧快照仅有证券前五，未由同份完整原件重算公司排名；不猜测合并后的前五。</p>';
    const exposure='<section class="card sharesight-exposure"><h2>All Together · 四类前五</h2>'+companyStatus+groups+'</section>';
    const rows=a?a.categories.map(c=>'<tr><td>'+esc(c.label)+'</td><td>'+money(c.valueCents)+'</td><td>'+(c.valueCents/a.totalCents*100).toFixed(2)+'%／'+c.targetPct+'%</td></tr>').join(''):'';
    const alloc=rows?'<table><thead><tr><th>分类</th><th>当前市值</th><th>当前／参考目标</th></tr></thead><tbody>'+rows+'</tbody></table>':'<p>Sharesight 完整分类持仓未取得。</p>';
    const method='<p>二级市场为前三类以外全部资产，含现金；公司经济敞口只重算分子，不改变四类资产金额、NAV 或费用。仅明确证券及市场映射合并：VST（NYSE）与VSTL（NASDAQ）归Vistra，GOOG／GOOGL（NASDAQ）归Alphabet；未知证券保持独立。</p><p>VSTL直接资产价值按2倍替换原贡献；已含杠杆的穿透贡献仅合并、不再乘二。未核实倍数则保留原证券榜并提示。ETF本体与已识别底层不能双计；本规则可版本化扩展，不按相似名称合并。</p><p>管理费仍为嘉信＋Webull；Jenny&#39;s IB 收益及回撤独立考核，比例管理不扩大计费范围。</p>';
    const source='<p>账户、持仓、现金、分类及 Exposure 均以 Sharesight 记录为准；不读取券商、Flex 或邮件。</p><p>Exposure 估值 '+esc(view.valuationDate)+'；读取 '+esc(view.retrievedAt??'未取得')+'；时间依据 '+esc(view.retrievedAtBasis??'未取得')+'。</p>'+(b?.browserEvidence?'<p>书目：原浏览器快照（非 API） · 截至 '+esc(b.asOf)+' · 原下载 '+esc(b.retrievedAt)+'。'+(b.browserEvidence.integrity==='verified-original-library-association'?'原始JSON、Library版本、范围及逐行关联已在构建时核验。':'原始全量证据尚未接入本机核验，仅供私密预览，不能作为正式发布来源。')+'</p><p>导出写入 '+esc(b.browserEvidence.exportLastWrittenAt)+'；分类保存 '+esc(b.browserEvidence.classificationSavedAt)+'，未用于改写快照时间。</p>':'');
    const coverage='<p>仅证明原时点开放持仓，不含闭仓／交易历史，不证明未来IB流量；Top500也不代表全ETF底层。</p><p>ETF Residual '+money(Math.round(view.residualUsd*100))+'（占总资产 '+view.residualPortfolioWeightPct.toFixed(2)+'%／占二级 '+view.residualCategoryWeightPct.toFixed(2)+'%）；残余不列作个股。</p><p>Exposure 快照日不是各私募基金的 NAV 日；未取得逐项 NAV 日期时保持未知。</p>'+[...view.limitations,...m.limitations,...(b?.browserEvidence?.limitations||[])].map(x=>'<p>'+esc(x)+'</p>').join('')+(b?.browserEvidence?.integrity==='verified-original-library-association'?'<p>分类与页面差 '+(b.browserEvidence.classificationDeltaCents/100).toFixed(2)+' USD；Exposure与页面差 '+(b.browserEvidence.exposureDeltaCents/100).toFixed(2)+' USD，保留原差异。</p>':'');
    const cash='<p>Sharesight IB-HK 账面现金：'+money(ib)+'</p><p>Sharesight NOAH-HK 账面现金：'+money(noah)+'</p><p>账面现金池：'+money(pool)+'</p><p>CALL 原额／50%预留／净规划预算：未取得；账面余额不等于实时购买力。</p><p>EXUS · EIMI · USSC：补仓金额未计算。USSC 的10%仅为原补仓预算参考，不是持仓目标。</p><p>现金类资产：'+(a?esc(a.cashLike.map(c=>c.symbol+' '+money(c.valueCents)).join(' · ')||'本次完整分类来源未见非零项'):'未取得')+'；不默认出售。</p><h3>股票四类配置</h3><p>仅IB-HK 股票范围，与 All Together 分母不同。</p>'+alloc+'<p>成交后投影未计算；没有完整订单证据时，内部风控保持未知。</p>';
    const status='<p class="ratio-key-status" role="status">预算／资本承诺未核实，未生成可执行补仓金额。'+(!b||b.browserEvidence&&b.browserEvidence.integrity!=='verified-original-library-association'?'完整来源尚未通过本机核验。':'')+(b?.browserEvidence?.migrationPending?'来源转仓尚未核销，保留原账面持仓。':'')+'</p><p class="ratio-key-status">'+esc(view.transferStatus)+'</p>';
    return '<div class="ratio-report"><p>比例管理 · '+esc({weekly:'周报',monthly:'月报','weekly-monthly':'周报／月报',snapshot:'来源快照'}[m.report.kind])+' · 报告目标 '+esc(m.report.targetDate)+' · 非实时</p><p>Exposure 来源截至 '+esc(view.valuationDate)+(view.valuationDate!==m.report.targetDate?' · 来源尚未覆盖本期':'')+'</p><p>生成 '+esc(m.report.generatedAt)+(m.report.feeAccountingThrough&&m.report.feeAccountingThrough!==m.report.targetDate?' · 管理费账务截至 '+esc(m.report.feeAccountingThrough)+'，两者日期不同':'')+'</p>'+overview+status+exposure+detail('计算口径与合并规则',method)+detail('来源日期与核验记录',source)+detail('覆盖范围、残余与缺项',coverage)+detail('现金与补仓参考说明',cash)+'</div>';
  }
  // Authorization is checked before and after crypto; a late async result can
  // never repopulate a locked or switched manager pane.
  function controller({authorized,identity,onRender,onClear,verify=async()=>{}}){
    let generation=0,model=null;
    const clear=()=>{generation++;model=null;onClear();};
    return {clear,async show(envelope,derive){clear();if(!authorized())return false;const ticket=generation,who=identity();try{const manager=await derive();if(ticket!==generation||!authorized()||identity()!==who)return false;const value=await open(envelope,manager);const proof=await verify(envelope,value);if(ticket!==generation||!authorized()||identity()!==who)return false;model=value;onRender(renderRatioModel(model),model,proof);return true;}catch{if(ticket===generation)clear();return false;}},hasPlaintext(){return model!==null;}};
  }
  return {SCHEMA,RECIPIENT,ENVELOPE,DOMAIN,canonical,digest,encode,decode,recipientScope,deriveManager,deriveSnapshotManager,validateRecipient,validateModel,validateBinding,publication,validatePublication,seal,open,render:renderRatioModel,controller};
}
