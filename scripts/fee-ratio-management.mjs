import {createFeeCompanyExposureCore} from './fee-ratio-company-exposure.mjs';
import {createAggregateReturnsCore} from './fee-ratio-aggregate-returns.mjs';
export function createFeeRatioCore(exposureCore,cryptoImpl=globalThis.crypto){
  const companyCore=createFeeCompanyExposureCore(),returnsCore=createAggregateReturnsCore();
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
    const official=m?.schema==='fee-console.ratio-view.v2';
    if(!exact(m,['schema','source','report','exposure','book','limitations',...(Object.hasOwn(m||{},'companyExposure')?['companyExposure']:[]),...(official?['sourceDates','classificationSummary']:[]),...(Object.hasOwn(m||{},'performance')?['performance']:[])])||![SCHEMA,'fee-console.ratio-view.v2'].includes(m.schema)||m.source!=='Sharesight'||!Array.isArray(m.limitations)||m.limitations.length>50||!m.limitations.every(text))fail();
    const p=m.report;if(!exact(p,['kind','targetDate','feeAccountingThrough','generatedAt'])||!['weekly','monthly','weekly-monthly','snapshot'].includes(p.kind)||!date(p.targetDate)||!(p.feeAccountingThrough===null||date(p.feeAccountingThrough))||!instant(p.generatedAt))fail();
    if(new TextEncoder().encode(canonical(m)).length>MAX)fail();
    const exp=exposureCore.buildRankedExposureView(m.exposure);
    if(!exp.retrievedAt||Date.parse(exp.retrievedAt)>Date.parse(p.generatedAt)||exp.valuationDate>p.targetDate)fail();
    if(official){
      const d=m.sourceDates,c=m.classificationSummary,labels=['PE/VC','对冲基金','常青基金','二级市场'];
      if(!exact(d,['classification','exposure',...(Object.hasOwn(m,'performance')?['performance']:[])])||![d.classification,d.exposure].every(date)||d.classification>d.exposure||d.exposure!==exp.valuationDate||p.targetDate!==d.exposure||m.book?.asOf!==d.classification||m.exposure.schema!=='xuan.sharesight-exposure-ranked.v2')fail();
      if(!exact(c,['schema','asOf','currency','basis','totalValueUSD','classes','gold',...(Object.hasOwn(c,'fundDistributions')?['fundDistributions']:[]),...(Object.hasOwn(c,'assetAllocation')?['assetAllocation']:[])])||c.schema!=='fee-console.classification-overview.v1'||c.asOf!==d.classification||c.currency!=='USD'||!['complete-official-classification-row-sum','complete-official-classification-excluding-benchmark-only.v1'].includes(c.basis)||!Number.isFinite(c.totalValueUSD)||c.totalValueUSD<=0||!Array.isArray(c.classes)||c.classes.length!==4||c.classes.some((g,i)=>!exact(g,['name','totalValueUSD'])||g.name!==labels[i]||!Number.isFinite(g.totalValueUSD)||g.totalValueUSD<0)||Math.round(c.classes.reduce((s,g)=>s+g.totalValueUSD,0)*100)!==Math.round(c.totalValueUSD*100)||!exact(c.gold,['rule','valueUSD',...(Object.hasOwn(c.gold,'secondaryIncluded')?['secondaryIncluded']:[])])||c.gold.rule!=='physical-gold-etf.GLD.NYSE.v1'||!Number.isFinite(c.gold.valueUSD)||c.gold.valueUSD<0||c.gold.valueUSD>c.totalValueUSD||Object.hasOwn(c.gold,'secondaryIncluded')&&(typeof c.gold.secondaryIncluded!=='boolean'||c.gold.secondaryIncluded&&c.gold.valueUSD>c.classes[3].totalValueUSD))fail();
      if(Object.hasOwn(c,'assetAllocation')){
        const a=c.assetAllocation,labels=['PE/VC','对冲基金','常青基金','股票市场','现金类','主题投资'],targets=[0,15,35,40,8,2],accounts=new Set(m.exposure.summary.accounts);
        if(!exact(a,['totalCents','groups'])||!cents(a.totalCents)||a.totalCents!==Math.round(c.totalValueUSD*100)||!Array.isArray(a.groups)||a.groups.length!==6)fail();
        for(const [i,g]of a.groups.entries()){
          if(!exact(g,['name','valueCents','targetPct','accounts'])||g.name!==labels[i]||g.targetPct!==targets[i]||!cents(g.valueCents)||!Array.isArray(g.accounts)||g.accounts.length>accounts.size)fail();
          const seen=new Set();let total=0,prior=Infinity;
          for(const r of g.accounts){if(!exact(r,['name','valueCents'])||!accounts.has(r.name)||seen.has(r.name)||!cents(r.valueCents)||r.valueCents>prior)fail();seen.add(r.name);total+=r.valueCents;prior=r.valueCents;}
          if(!Number.isSafeInteger(total)||total!==g.valueCents||i<3&&g.valueCents!==Math.round(c.classes[i].totalValueUSD*100))fail();
        }
        if(a.groups.reduce((n,g)=>n+g.valueCents,0)!==a.totalCents||a.groups.slice(3).reduce((n,g)=>n+g.valueCents,0)!==Math.round(c.classes[3].totalValueUSD*100))fail();
      }
      if(Object.hasOwn(c,'fundDistributions')){
        if(!Array.isArray(c.fundDistributions)||c.fundDistributions.length!==2)fail();
        const detailed=c.fundDistributions.some(f=>f.groups?.some(g=>Object.hasOwn(g,'holdings'))),sourceRows=new Set(),accounts=new Set(m.exposure.summary.accounts);
        const sourceText=s=>typeof s==='string'&&s.length>0&&s.length<=1000&&!/[\u0000-\u001f\u007f]/.test(s);
        for(const [i,f]of c.fundDistributions.entries()){
          if(!exact(f,['name','totalCents','groups'])||f.name!==['常青基金','对冲基金'][i]||!cents(f.totalCents)||f.totalCents!==Math.round(c.classes.find(g=>g.name===f.name).totalValueUSD*100)||!Array.isArray(f.groups)||f.groups.length>5000)fail();
          const seen=new Set();let total=0,prior=Infinity;
          for(const g of f.groups){
            if(!exact(g,['name','valueCents',...(detailed?['holdings']:[])])||!text(g.name)||seen.has(g.name)||!cents(g.valueCents)||g.valueCents>prior)fail();seen.add(g.name);total+=g.valueCents;prior=g.valueCents;
            if(detailed){
              if(!Array.isArray(g.holdings)||g.holdings.length>5000)fail();let held=0,previous=Infinity;
              for(const h of g.holdings){
                if(!exact(h,['sourceRow','account','name','securityCode','market','valueCents'])||!Number.isSafeInteger(h.sourceRow)||h.sourceRow<1||sourceRows.has(h.sourceRow)||!accounts.has(h.account)||![h.name,h.securityCode,h.market].every(sourceText)||!cents(h.valueCents)||h.valueCents>previous)fail();
                sourceRows.add(h.sourceRow);held+=h.valueCents;previous=h.valueCents;
              }
              if(!Number.isSafeInteger(held)||held!==g.valueCents)fail();
            }
          }
          if(!Number.isSafeInteger(total)||total!==f.totalCents)fail();
        }
      }
    }else if(m.exposure.schema==='xuan.sharesight-exposure-ranked.v2'||m.book?.browserEvidence?.transport==='official-workbooks')fail();
    if(Object.hasOwn(m,'performance')){
      if(!official||m.performance.asOf!==m.sourceDates.performance||m.performance.asOf>m.report.targetDate)fail();
      returnsCore.build(m.performance,{expectedAccounts:m.exposure.summary.accounts.map(x=>x.replaceAll('&amp;','&')),expectedAsOf:m.sourceDates.performance,...(m.companyExposure?{topTargets:returnsCore.topTargets(m.exposure,companyCore.validate(m.companyExposure,m.exposure,m.book?.sourceSha256).top)}:{})});
    }
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
      if(browser&&official){
        const e=b.browserEvidence,verified=e.integrity==='verified-original-library-association';
        if(!exact(e,['transport','observedAtBasis','classificationCapturedAt','exposureCapturedAt','downloadCompletedAt','fullSourceBytes','fullSourceSha256','transferStatus','limitations','integrity',...(verified?['associationId','managerScopeId','sourceVersion','migrationPending','classificationDeltaCents','exposureDeltaCents']:[])])||e.transport!=='official-workbooks'||e.observedAtBasis!=='original-download-file-mtime'||e.downloadCompletedAt!==null||![e.classificationCapturedAt,e.exposureCapturedAt].every(instant)||e.classificationCapturedAt!==b.retrievedAt||e.exposureCapturedAt!==m.exposure.retrievedAt||[e.classificationCapturedAt,e.exposureCapturedAt].some(s=>Date.parse(s)>Date.parse(p.generatedAt))||!['declared-not-verified-on-this-device','verified-original-library-association'].includes(e.integrity)||e.fullSourceSha256!==b.sourceSha256||!Number.isSafeInteger(e.fullSourceBytes)||e.fullSourceBytes<1||e.fullSourceBytes>5*1024*1024||!text(e.transferStatus)||!Array.isArray(e.limitations)||!e.limitations.every(text)||verified&&(!/^[a-f0-9]{64}$/.test(e.associationId)||!/^[a-f0-9]{64}$/.test(e.managerScopeId)||!Number.isSafeInteger(e.sourceVersion)||e.sourceVersion<0||typeof e.migrationPending!=='boolean'||![e.classificationDeltaCents,e.exposureDeltaCents].every(Number.isSafeInteger)))fail();
      }else if(browser){const e=b.browserEvidence,verified=e.integrity==='verified-original-library-association',time=s=>typeof s==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(s)&&Number.isFinite(Date.parse(s));
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
  function preciseUsd(valueCents){
    if(!cents(valueCents))fail();
    const value=BigInt(valueCents),label=(value/100n).toLocaleString('en-US')+'.'+(value%100n).toString().padStart(2,'0');
    return '<span class="ratio-money-precise">'+label+'</span>';
  }

  function fundHoldingDisplayName(raw,securityCode=''){
    if(typeof raw!=='string')return '';
    const original=raw.trim();
    // Official ranked rows may append [securityCode · market] to distinguish
    // repeated Sharesight names. Only a dated source code is shortened here.
    const afterMonth=(value,allowPrefix=false)=>{
      // Sharesight custom codes may prepend a strategy/platform before the date.
      // Choose the first delimited date marker, then keep the full fund suffix,
      // including internal hyphens, share classes and any later date-like text.
      if(allowPrefix){const marker=value.match(/(?:^|[-–—_:：/\s])(?=(?:19|20)\d{2}(?:[-/.]|年))/);if(!marker)return;value=value.slice(marker.index+marker[0].length);}
      return (value.match(/^(?:19|20)\d{2}[-/.](?:0[1-9]|1[0-2])(?:\s*[-–—_:：/]\s*|\s+)(\S[\s\S]*)$/)?.[1]||value.match(/^(?:19|20)\d{2}年(?:0?[1-9]|1[0-2])月\s*(?:[-–—_:：/]\s*)?(\S[\s\S]*)$/)?.[1])?.trim();
    };
    const sourceProject=typeof securityCode==='string'?afterMonth(securityCode.trim(),true):null;
    if(sourceProject)return sourceProject;
    const knownSuffix=/\s+·\s+(?:OTHER|NASDAQ|NYSE|SWX)$/;
    for(const [open,close] of [['[',']'],['【','】'],['（','）'],['(',')']]){
      if(!original.endsWith(close))continue;
      const start=original.indexOf(open);
      if(start<0)continue;
      const content=original.slice(start+open.length,-close.length).trim();
      if(!afterMonth(content,true))continue;
      const marker=content.lastIndexOf(' · '),generated=open==='['&&start>0&&original[start-1]===' '&&marker>=0;
      const code=generated?content.slice(0,marker):content.replace(knownSuffix,'');
      return afterMonth(code,true)||original;
    }
    const project=afterMonth(original);
    // Without the app's wrapper, preserve unrecognized suffixes and project
    // punctuation. Never split project names on their own digits or hyphens.
    return project?.replace(knownSuffix,'').trim()||original;
  }

  function renderRatioModel(m){
    const view=exposureCore.buildRankedExposureView(m.exposure),classification=m.classificationSummary;
    const performance=m.performance?returnsCore.build(m.performance,{expectedAccounts:m.exposure.summary.accounts.map(x=>x.replaceAll('&amp;','&')),expectedAsOf:m.sourceDates.performance}):null;
    if(performance?.topHoldings)returnsCore.buildTop(m.performance.topHoldings,m.performance,returnsCore.topTargets(m.exposure,m.companyExposure?companyCore.validate(m.companyExposure,m.exposure,m.book?.sourceSha256).top:null));
    const topReturns=(category,name)=>returnsCore.renderTop(returnsCore.selectTop(performance,{category,name}));
    const returns=(name,parent=null)=>performance?returnsCore.renderInline(returnsCore.select(performance,{type:parent?'fund-strategy':name==='All Together'?'portfolio':'classification',name,parent})):'';
    const compactReturns=name=>performance?returnsCore.renderCompact(returnsCore.select(performance,{type:name==='All Together'?'portfolio':'classification',name,parent:null})):'';
    const benchmarkCount=performance?Math.max(0,...Object.values(returnsCore.select(performance,{type:'portfolio',name:'All Together',parent:null}).periods).map(p=>p.benchmarkMemberCount||0)):0;
    const overviewView=classification?{valuationDate:classification.asOf,portfolioTotalUsd:classification.totalValueUSD,groups:classification.classes.map(g=>({category:g.name,totalUsd:g.totalValueUSD}))}:view;
    const delta=overviewView.groups.reduce((n,g)=>n+g.totalUsd,0)-overviewView.portfolioTotalUsd;
    const b=m.book,a=b?.allocation,ib=b?.ibCashCents??null,noah=b?.noahCashCents??null,pool=ib===null||noah===null?null:ib+noah;
    const company=m.companyExposure?companyCore.validate(m.companyExposure,m.exposure,b?.sourceSha256):null;
    const detail=(label,body)=>'<details><summary>'+label+'</summary>'+body+'</details>';
    const gold=classification?'<p class="ratio-gold"><span>黄金（GLD）：'+money(Math.round(classification.gold.valueUSD*100))+'</span><span>占比 '+(classification.gold.valueUSD/classification.totalValueUSD*100).toFixed(2)+'% · '+(classification.gold.secondaryIncluded?'包含在二级市场中':'包含在四类资产合计中')+'</span></p>':'';
    const legacyOverview='<section class="card ratio-asset-overview"><h2>四类资产配置总览</h2><p>All Together · 10账户 · USD · 资产分类截至 '+esc(overviewView.valuationDate)+'</p>'+overviewView.groups.map(g=>'<div><strong>'+esc(g.category)+'</strong> · '+money(Math.round(g.totalUsd*100))+' · '+(g.totalUsd/overviewView.portfolioTotalUsd*100).toFixed(2)+'%<div role="meter" aria-label="'+esc(g.category)+'占总资产" aria-valuemin="0" aria-valuemax="100" aria-valuenow="'+(g.totalUsd/overviewView.portfolioTotalUsd*100).toFixed(4)+'" style="height:8px;background:#edf0f5;margin:6px 0 12px"><span style="display:block;height:100%;background:#4778b8;width:'+Math.max(0,Math.min(100,g.totalUsd/overviewView.portfolioTotalUsd*100))+'%"></span></div></div>').join('')+gold+'<p>类别合计与总资产舍入差 '+delta.toFixed(2)+' USD，保留原差异。</p></section>';
    const asset=classification?.assetAllocation,benchmarkExcluded=classification?.basis==='complete-official-classification-excluding-benchmark-only.v1';
    const assetRows=asset?.groups.map(g=>'<tr><td>'+esc(g.name)+'<small class="ratio-overview-weights">'+(g.valueCents/asset.totalCents*100).toFixed(2)+'%／'+g.targetPct+'%</small></td><td>'+preciseUsd(g.valueCents)+'</td><td>'+compactReturns(g.name)+'</td></tr>').join('');
    const assetAccounts=asset?.groups.map(g=>'<section><h3>'+esc(g.name)+'</h3><ul>'+g.accounts.map(r=>'<li><span>'+esc(r.name)+'</span><span>'+money(r.valueCents)+'</span></li>').join('')+'</ul>'+(g.accounts.length?'':'<p>本类暂无持仓。</p>')+'</section>').join('');
    const overview=asset?'<section class="card ratio-asset-overview ratio-six-allocation"><h2>资产配置总览</h2><p>All Together · 10账户 · USD · 资产分类截至 '+esc(classification.asOf)+'</p><p class="ratio-overview-units">分类下方为当前占比／参考目标。</p><table class="ratio-overview-table"><thead><tr><th>分类</th><th>市值（USD）</th><th>收益率</th></tr></thead><tbody>'+assetRows+'</tbody><tfoot><tr><th>总资产</th><td>'+preciseUsd(asset.totalCents)+'</td><td>'+compactReturns('All Together')+'</td></tr></tfoot></table><div class="ratio-overview-disclosures">'+(performance?'<details class="ratio-overview-return-notes"><summary>收益说明</summary><ol class="ratio-return-note-list"><li>全部及近一年均沿用 Sharesight 对应范围的原生收益，含已平仓；不按当前市值加权，也不重算年化。</li><li>仅有官方依据时标注年化、期间收益或未满一年。没有这些标记的数值，原报表未注明是否年化。</li><li>— 表示缺少匹配的官方小计、来源未提供收益或现金范围尚待核实，不代表0%。</li></ol></details>':'')+'<details class="ratio-asset-notes"><summary>分类、账户与参考目标</summary><p>六类互斥，按同日直接资产市值归类。股票市场仅含美国底仓、美国科技、非美发达、新兴市场；现金类为 Cash Accounts 加全部防御资产，主题投资单列。穿透和杠杆敞口不另加总。</p>'+(benchmarkExcluded?'<p>Citi-HK &amp; 地产四期中的 QQQ／SPY 仅作基准取值，已从投资资产、占比分母及穿透中排除；其他账户的真实持仓保留。</p>':'')+'<p>参考目标合计100%，仅作配置比较；PE/VC目标0%不改变实际持仓，不代表卖出指令。</p><p>黄金（GLD）：'+money(Math.round(classification.gold.valueUSD*100))+'；已计入所属分类，不另加总。</p>'+assetAccounts+(performance?'<section class="ratio-secondary-return-supplement"><h3>二级市场整体收益</h3><p>此范围含股票、防御和主题投资，不等于上方股票市场子集；现金收益沿用原报表设置。</p>'+returns('二级市场')+'</section><p class="ratio-return-date">收益截至 '+esc(performance.asOf)+'；全部及近一年含已平仓。未满一年和年化标识仅按官方证据；原报表口径表示未推算年化。总资产收益沿用官方合计。'+(benchmarkCount?'含 '+benchmarkCount+' 项用于程序取值的模拟基准，未剔除其影响；配置比例仍排除它们。':'')+'</p>':'')+'</details></div></section>':legacyOverview;
    const table=(rows,category)=>'<table><thead><tr><th>名称</th><th>USD金额</th><th>占总资产／占本类资产</th></tr></thead><tbody>'+rows.map((r,i)=>'<tr><td data-security-code="'+esc(r.securityCode||'')+'">'+(i+1)+'. '+esc(r.name)+(r.accounts?.length?'<span class="ratio-holding-accounts">'+esc(r.accounts.join(' · '))+'</span>':'')+(r.sourceHoldings?.length>1?'<details><summary>合并持仓 · '+r.sourceHoldings.length+'笔</summary><ul>'+r.sourceHoldings.map(h=>'<li>'+esc(h.securityCode)+' · '+money(Math.round(h.valueUSD*100))+'<span class="ratio-holding-accounts">'+esc(h.account)+'</span></li>').join('')+'</ul></details>':'')+topReturns(category,r.name)+'</td><td>'+money(Math.round(r.valueUsd*100))+'</td><td>'+r.portfolioWeightPct.toFixed(2)+'%／'+r.categoryWeightPct.toFixed(2)+'%</td></tr>').join('')+'</tbody></table>';
    const groups=view.groups.map((g,i)=>'<section><h3>'+esc(g.category)+(i===3?(company?.top?' · 公司经济敞口前五':' · 原证券口径前五'):' · 直接持仓前五')+'</h3><p>Exposure截至 '+esc(view.valuationDate)+' · 本类资产 '+money(Math.round(g.totalUsd*100))+'</p>'+(i===3&&company?.top?companyCore.render(m.companyExposure,m.exposure,b?.sourceSha256,r=>topReturns('二级市场',r.name)):table(g.top,g.category))+'</section>').join('');
    const companyStatus=company?.top?'<p class="ratio-key-status">公司经济敞口含显式杠杆，比例可能超过100%；不改变总资产、类别资产及管理费。</p>':company?companyCore.render(m.companyExposure,m.exposure,b?.sourceSha256):'<p class="ratio-key-status">旧快照仅有证券前五，未由同份完整原件重算公司排名；不猜测合并后的前五。</p>';
    const exposure='<section class="card sharesight-exposure"><h2>All Together · 四类前五</h2>'+companyStatus+groups+'</section>';
    const rows=a?a.categories.map(c=>'<tr><td>'+esc(c.label)+'</td><td>'+money(c.valueCents)+'</td><td>'+(c.valueCents/a.totalCents*100).toFixed(2)+'%／'+c.targetPct+'%</td></tr>').join(''):'';
    const alloc=rows?'<table><thead><tr><th>分类</th><th>当前市值</th><th>当前／参考目标</th></tr></thead><tbody>'+rows+'</tbody></table>':'<p>Sharesight 完整分类持仓未取得。</p>';
    const allocation='<section class="card ratio-stock-allocation"><h2>股票四类配置</h2><p>仅IB-HK 股票范围，与 All Together 分母不同。</p>'+alloc+'</section>';
    const distributions=(classification?.fundDistributions||[]).map(f=>{
      // Largest remainder in hundredths of a percent: displayed nonzero totals sum to 100%.
      const weights=f.groups.map((g,i)=>{const numerator=BigInt(g.valueCents)*10000n,denominator=BigInt(f.totalCents||1);return {i,bp:f.totalCents?Number(numerator/denominator):0,remainder:f.totalCents?numerator%denominator:0n};});
      let left=f.totalCents?10000-weights.reduce((n,w)=>n+w.bp,0):0;
      for(const w of [...weights].sort((a,b)=>a.remainder===b.remainder?a.i-b.i:a.remainder>b.remainder?-1:1)){if(left--<=0)break;w.bp++;}
      const bars=f.groups.map((g,i)=>{const pct=(weights[i].bp/100).toFixed(2);return '<div class="ratio-distribution-row"><div class="ratio-distribution-label"><span>'+esc(g.name)+'</span><strong>'+pct+'%</strong></div><div class="ratio-distribution-track" role="meter" aria-label="'+esc(g.name)+'" aria-valuemin="0" aria-valuemax="100" aria-valuenow="'+pct+'"><i style="width:'+pct+'%"></i></div>'+returns(g.name,f.name)+'</div>';}).join('');
      const target=asset?.groups.find(g=>g.name===f.name)?.targetPct;
      const holdings=f.groups.map((g,i)=>{
        if(!g.holdings)return '';
        const accounts=new Map();for(const h of g.holdings){
          const a=accounts.get(h.account)||{name:h.account,valueCents:0,holdings:new Map()};
          const name=fundHoldingDisplayName(h.name,h.securityCode)||h.name,prior=a.holdings.get(name);
          a.valueCents+=h.valueCents;
          if(prior){prior.valueCents+=h.valueCents;prior.sourceCount++;}
          else a.holdings.set(name,{...h,name,sourceCount:1});
          accounts.set(h.account,a);
        }
        return '<section class="ratio-distribution-category"><h3>'+esc(g.name)+' · '+(weights[i].bp/100).toFixed(2)+'%</h3>'+[...accounts.values()].sort((a,b)=>b.valueCents-a.valueCents||a.name.localeCompare(b.name)).map(a=>'<section class="ratio-distribution-account"><h4><span>'+esc(a.name)+'</span><span>'+money(a.valueCents)+'</span></h4><ul>'+[...a.holdings.values()].sort((a,b)=>b.valueCents-a.valueCents||a.name.localeCompare(b.name)).map(h=>'<li class="ratio-fund-holding" data-source-count="'+h.sourceCount+'"><span class="ratio-fund-holding-name" data-security-code="'+esc(h.securityCode)+'" title="'+esc(h.name)+'">'+esc(h.name)+'</span><span>'+money(h.valueCents)+'</span></li>').join('')+'</ul></section>').join('')+'</section>';
      }).join('');
      const missing=f.groups.length&&!f.groups.some(g=>g.holdings)?'<p>此历史快照未包含账户及持仓明细，更新快照后可查看。</p>':'';
      return '<section class="card ratio-fund-distribution"><h2>'+esc(f.name)+'分布</h2><p>截至 '+esc(classification.asOf)+' · 占本类市值</p>'+(bars||'<p>本类暂无持仓。</p>')+'<details class="ratio-distribution-details"><summary>分类、账户与参考目标</summary><p>按 Sharesight 原始持仓名称首字段分类。上方百分比分母仅为'+esc(f.name)+'市值，不叠加穿透。</p><p>组合参考目标：'+(target===undefined?'未设置':target+'%（占总资产）')+'；各策略的参考目标未设置。</p><p>本类合计 '+money(f.totalCents)+(f.totalCents?' · 占比合计100.00%':' · 市值为零，占比均为0.00%')+'。明细按账户及市值降序列出，同分类、同账户、年月后完整名称相同的持仓合并合计；不同账户和不同份额名称分别列出。</p>'+holdings+missing+'</details></section>';
    }).join('');
    const method='<p>黄金占比的分母为同日All Together分类来源总资产；已计入对应类别，不额外累加。常青按原始年月后的完整基金名聚合，份额类别和内部连字符保留，先合并全部持仓再选前五。</p>'+(benchmarkExcluded?'<p>指定Citi账户的QQQ／SPY仅作基准取值，不计入投资资产、占比分母和穿透；原始资料及基准用途保留。</p>':'<p>此历史快照仅排除了指定Citi基准的公司穿透，资产总额保留原口径。</p>')+'<p>'+(asset?'下方四类前五沿用原排名分组：二级市场为前三类以外全部资产，含现金，与上方六类中的股票市场范围不同。':'二级市场为前三类以外全部资产，含现金；')+'公司经济敞口只重算分子，不改变真实资产金额、NAV 或费用。仅明确证券及市场映射合并：VST（NYSE）与VSTL（NASDAQ）归Vistra，GOOG／GOOGL（NASDAQ）归Alphabet；未知证券保持独立。</p><p>VSTL按2倍、TQQQ按3倍经济敞口；来源已完整包含相同杠杆时不重复相乘。直接持仓按实际市值降序，穿透按经济敞口降序；各行保留账户。未穿透的残余不猜测归属到个股，ETF本体与底层不双计；真实资产、现金和费用不乘杠杆。</p><p>管理费仍为嘉信＋Webull；Jenny&#39;s IB 收益及回撤独立考核，比例管理不扩大计费范围。</p>';
    const official=b?.browserEvidence?.transport==='official-workbooks';
    const browserSource=b?.browserEvidence?'<p>来源：'+(official?'Sharesight 官方工作簿导出':'原浏览器快照（非 API）')+' · 资产分类截至 '+esc(b.asOf)+'。'+(b.browserEvidence.integrity==='verified-original-library-association'?(official?'官方工作簿逐行投影与固定Library版本关联已核验；原工作簿哈希保留于受控转换记录。':'原件字节、Library版本、账户范围及逐行关联已在构建时核验。'):'原始全量证据尚未接入本机核验，仅供私密预览，不能作为正式发布来源。')+'</p>'+(official?'<p>分类原件mtime '+esc(b.browserEvidence.classificationCapturedAt)+'；Exposure原件mtime '+esc(b.browserEvidence.exposureCapturedAt)+'；独立下载完成时间未知。未用复制或查看时间刷新来源。</p>':'<p>原下载 '+esc(b.retrievedAt)+'；导出写入 '+esc(b.browserEvidence.exportLastWrittenAt)+'；分类保存 '+esc(b.browserEvidence.classificationSavedAt)+'，未用于改写快照时间。</p>'):'';
    const source='<p>账户、持仓、现金、分类及 Exposure 均以 Sharesight 记录为准；不读取券商、Flex 或邮件。</p><p>Exposure 估值 '+esc(view.valuationDate)+'；读取 '+esc(view.retrievedAt??'未取得')+'；时间依据 '+esc(view.retrievedAtBasis??'未取得')+'。</p>'+browserSource;
    const coverage='<p>仅证明原时点开放持仓，不含闭仓／交易历史，不证明未来IB流量；Top500也不代表全ETF底层。</p><p>ETF Residual '+money(Math.round(view.residualUsd*100))+'（占总资产 '+view.residualPortfolioWeightPct.toFixed(2)+'%／占二级 '+view.residualCategoryWeightPct.toFixed(2)+'%）；残余不列作个股。</p><p>Exposure 快照日不是各私募基金的 NAV 日；未取得逐项 NAV 日期时保持未知。</p>'+[...view.limitations,...m.limitations,...(b?.browserEvidence?.limitations||[])].map(x=>'<p>'+esc(x)+'</p>').join('')+(!official&&b?.browserEvidence?.integrity==='verified-original-library-association'?'<p>分类与页面差 '+(b.browserEvidence.classificationDeltaCents/100).toFixed(2)+' USD；Exposure与页面差 '+(b.browserEvidence.exposureDeltaCents/100).toFixed(2)+' USD，保留原差异。</p>':'');
    const cash='<p>Sharesight IB-HK 账面现金：'+money(ib)+'</p><p>Sharesight NOAH-HK 账面现金：'+money(noah)+'</p><p>账面现金池：'+money(pool)+'</p><p>CALL 原额／50%预留／净规划预算：未取得；账面余额不等于实时购买力。</p><p>EXUS · EIMI · USSC：补仓金额未计算。USSC 的10%仅为原补仓预算参考，不是持仓目标。</p><p>现金类资产：'+(a?esc(a.cashLike.map(c=>c.symbol+' '+money(c.valueCents)).join(' · ')||'本次完整分类来源未见非零项'):'未取得')+'；不默认出售。</p><p>成交后投影未计算；没有完整订单证据时，内部风控保持未知。</p>';
    const status='<p class="ratio-key-status" role="status">预算／资本承诺未核实，未生成可执行补仓金额。'+(!b||b.browserEvidence&&b.browserEvidence.integrity!=='verified-original-library-association'?'完整来源尚未通过本机核验。':'')+(b?.browserEvidence?.migrationPending?'来源转仓尚未核销，保留原账面持仓。':'')+'</p><p class="ratio-key-status">'+esc(view.transferStatus)+'</p>';
    return '<div class="ratio-report"><p>比例管理 · '+esc({weekly:'周报',monthly:'月报','weekly-monthly':'周报／月报',snapshot:'来源快照'}[m.report.kind])+' · 报告目标 '+esc(m.report.targetDate)+' · 非实时</p><p>Exposure 来源截至 '+esc(view.valuationDate)+(view.valuationDate!==m.report.targetDate?' · 来源尚未覆盖本期':'')+'</p><p>生成 '+esc(m.report.generatedAt)+(m.report.feeAccountingThrough&&m.report.feeAccountingThrough!==m.report.targetDate?' · 管理费账务截至 '+esc(m.report.feeAccountingThrough)+'，两者日期不同':'')+'</p>'+(m.sourceDates?'<p class="ratio-key-status">资产分类截至 '+esc(m.sourceDates.classification)+' · 个股穿透截至 '+esc(m.sourceDates.exposure)+'；各自使用同日来源总额，管理费保持原日期。</p>':'')+overview+allocation+distributions+status+exposure+detail('计算口径与合并规则',method)+detail('来源日期与核验记录',source)+detail('覆盖范围、残余与缺项',coverage)+detail('现金与补仓参考说明',cash)+'</div>';
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
