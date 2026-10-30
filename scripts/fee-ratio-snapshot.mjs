// Independent manager-authenticated snapshots. No IO, secrets, fee receipt or
// serialized proof can confer authority. Browser and offline adapter share this.
export function createRatioSnapshotCore(ratioCore,exposureCore,sourceFactory,parseJson,cryptoImpl=globalThis.crypto){
  const SCHEMA='fee-console.ratio-snapshot.v1',FILE='fee-console-ratio-snapshot.json',MAX=5*1024*1024,accepted=new WeakSet();
  const fail=()=>{throw Error('RATIO_SNAPSHOT_REFUSED');},canonical=ratioCore.canonical,hash=ratioCore.digest;
  const exact=(v,k)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...k].sort().join(',');
  const hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
  const iso=s=>typeof s==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(s)&&Number.isFinite(Date.parse(s))&&new Date(s).toISOString()===s;
  const encode=s=>new TextEncoder().encode(s),digestBytes=async b=>[...new Uint8Array(await cryptoImpl.subtle.digest('SHA-256',b))].map(n=>n.toString(16).padStart(2,'0')).join('');
  const read=b=>{if(!(b instanceof Uint8Array)||b.byteLength<1||b.byteLength>MAX)fail();return parseJson(b);};
  const normalizeBook=b=>{const out=structuredClone(b);if(out?.browserEvidence){out.browserEvidence.integrity='declared-not-verified-on-this-device';for(const k of ['associationId','managerScopeId','sourceVersion','migrationPending','classificationDeltaCents','exposureDeltaCents'])delete out.browserEvidence[k];}return out;};
  async function verifyOriginal({originalBytes,inputBytes,model,recipient,sourceSha256,inputSha256,libraryVersion,now=new Date()}){
    const r=await ratioCore.validateRecipient(recipient),m=await ratioCore.validateModel(model);
    if(m.report.kind!=='snapshot'||m.report.feeAccountingThrough!==null||!hex(sourceSha256)||!hex(inputSha256)||!Number.isSafeInteger(libraryVersion)||libraryVersion<0||await digestBytes(originalBytes)!==sourceSha256||await digestBytes(inputBytes)!==inputSha256)fail();
    const raw=read(originalBytes),input=read(inputBytes),scope=accounts=>JSON.stringify(accounts.map(s=>s.replaceAll('&amp;','&')).sort());
    const originalScope=scope(raw.accounts),inputScope=scope(input.exposure.summary.accounts),scopeHash=await hash(raw.accounts.map(s=>s.replaceAll('&amp;','&')).sort());
    if(originalScope!==inputScope||scopeHash!==exposureCore.ALL_TOGETHER_SCOPE_SHA256||input.book?.sourceSha256!==sourceSha256||input.book?.provenance.fullSourceSha256!==sourceSha256||input.book.provenance.fullSourceBytes!==originalBytes.byteLength)fail();
    const source=sourceFactory(accounts=>{if(scope(accounts)!==originalScope)fail();return scopeHash;});
    exposureCore.buildRankedExposureView(input.exposure);
    const facts=source.verifyBrowserSourceAssociations(raw,input,{scopeHash,now});
    if(Object.hasOwn(m,'companyExposure')&&canonical(m.companyExposure)!==canonical(facts.companyExposure))fail();
    const official=input.schema==='fee-console.ratio-sources.v2';
    if(official&&(canonical(m.sourceDates)!==canonical(facts.sourceDates)||canonical(m.classificationSummary)!==canonical(facts.classificationSummary)))fail();
    if(canonical(input.exposure)!==canonical(m.exposure)||canonical(source.buildBrowserRatioBook(input.book,official?input.book.asOf:m.report.targetDate))!==canonical(normalizeBook(m.book))||m.report.targetDate!==facts.asOf)fail();
    const association=m.book.browserEvidence;
    if(association.integrity!=='verified-original-library-association'||association.managerScopeId!==r.scopeId||association.sourceVersion!==libraryVersion||['migrationPending','classificationDeltaCents','exposureDeltaCents'].some(k=>association[k]!==facts[k]))fail();
    const capturedAt=facts.observedAt,expiresAt=new Date(Date.parse(capturedAt)+36*3600000).toISOString();
    if(Date.parse(m.report.generatedAt)<Date.parse(capturedAt)||Date.parse(m.report.generatedAt)>now.getTime()||Math.floor((Date.parse(now.toISOString().slice(0,10))-Date.parse(facts.asOf))/86400000)>4)fail();
    const evidence={provider:'Sharesight',kind:official?'complete-official-workbook-association':'complete-original-browser-association',asOf:facts.asOf,...(official?{sourceDates:structuredClone(facts.sourceDates)}:{}),capturedAt,expiresAt,sourceSha256,inputSha256,scopeHash,libraryVersion,modelSha256:await hash(m)};
    Object.freeze(evidence);const proof=Object.freeze({evidence,recipientId:r.recipientId,scopeId:r.scopeId,checkedAt:now.toISOString()});accepted.add(proof);return proof;
  }
  const sourceDates=s=>s.kind==='complete-official-workbook-association'?Object.values(s.sourceDates):[s.asOf];
  const recent=(s,at)=>sourceDates(s).every(d=>{const age=Math.floor((Date.parse(at.slice(0,10))-Date.parse(d))/86400000);return age>=0&&age<=4;});
  function fresh(source,now){const n=now.getTime();if(!Number.isFinite(n)||n<Date.parse(source.capturedAt)||n>Date.parse(source.expiresAt)||!recent(source,now.toISOString()))fail();}
  async function bodyCheck(body){
    if(!exact(body,['schema','version','previousSnapshotId','recipientId','scopeId','source','envelope'])||body.schema!==SCHEMA||!Number.isSafeInteger(body.version)||body.version<1||!(body.previousSnapshotId===null||hex(body.previousSnapshotId))||!hex(body.recipientId)||!hex(body.scopeId))fail();
    const s=body.source,official=s?.kind==='complete-official-workbook-association';
    const date=d=>typeof d==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(d)&&Number.isFinite(Date.parse(d))&&new Date(d).toISOString().slice(0,10)===d;
    if(!exact(s,['provider','kind','asOf','capturedAt','expiresAt','sourceSha256','inputSha256','scopeHash','libraryVersion','modelSha256',...(official?['sourceDates']:[])])||s.provider!=='Sharesight'||!['complete-original-browser-association','complete-official-workbook-association'].includes(s.kind)||!date(s.asOf)||!iso(s.capturedAt)||!iso(s.expiresAt)||Date.parse(s.expiresAt)-Date.parse(s.capturedAt)!==36*3600000||![s.sourceSha256,s.inputSha256,s.scopeHash,s.modelSha256].every(hex)||s.scopeHash!==exposureCore.ALL_TOGETHER_SCOPE_SHA256||!Number.isSafeInteger(s.libraryVersion)||s.libraryVersion<0)fail();
    if(official&&(!exact(s.sourceDates,['classification','exposure'])||!Object.values(s.sourceDates).every(date)||s.sourceDates.classification>s.sourceDates.exposure||s.sourceDates.exposure!==s.asOf))fail();
    const e=body.envelope;ratioCore.validateBinding(e?.binding);
    if(e.scopeId!==body.scopeId||e.recipientId!==body.recipientId||e.binding.feeReceiptId!==null||e.binding.sourceDate!==s.asOf||e.binding.feeAsOf!==s.asOf)fail();
    if(body.version===1?body.previousSnapshotId!==null:body.previousSnapshotId===null)fail();
    return body;
  }
  async function candidate({model,recipient,proof,previous=null,now=new Date()}){
    if(!accepted.has(proof))fail();fresh(proof.evidence,now);
    const r=await ratioCore.validateRecipient(recipient),m=await ratioCore.validateModel(model);
    if(r.recipientId!==proof.recipientId||r.scopeId!==proof.scopeId||await hash(m)!==proof.evidence.modelSha256)fail();
    if(previous)await bodyCheck(previous.body);
    const binding={schema:'fee-console.ratio-binding.v1',revision:cryptoImpl.randomUUID(),previousCipherSha256:previous?await hash(previous.body.envelope):null,feeReceiptId:null,feeAsOf:proof.evidence.asOf,sourceDate:proof.evidence.asOf};
    const envelope=await ratioCore.seal(m,r,binding),body={schema:SCHEMA,version:previous?previous.body.version+1:1,previousSnapshotId:previous?await hash(previous.body):null,recipientId:r.recipientId,scopeId:r.scopeId,source:structuredClone(proof.evidence),envelope};
    await bodyCheck(body);return {body,authentication:null};
  }
  async function authenticate(packet,proof,manager,{previous=null,profileSha256,now=new Date()}={}){
    if(!exact(packet,['body','authentication'])||packet.authentication!==null||!accepted.has(proof)||!hex(profileSha256)||!manager?.authenticationKey||manager.authenticationKey.extractable!==false)fail();
    const b=await bodyCheck(packet.body);fresh(b.source,now);
    if(canonical(b.source)!==canonical(proof.evidence)||proof.recipientId!==b.recipientId||proof.scopeId!==b.scopeId||manager.recipient.recipientId!==b.recipientId||manager.recipient.scopeId!==b.scopeId||await hash(await ratioCore.open(b.envelope,manager))!==b.source.modelSha256)fail();
    if(previous){await verify(previous,manager,{now});const prior=previous.body.source;if(b.version!==previous.body.version+1||b.previousSnapshotId!==await hash(previous.body)||b.envelope.binding.previousCipherSha256!==await hash(previous.body.envelope)||b.source.asOf<prior.asOf||b.source.capturedAt<prior.capturedAt||(b.source.sourceDates?.classification||b.source.asOf)<(prior.sourceDates?.classification||prior.asOf))fail();}
    else if(b.version!==1||b.previousSnapshotId!==null||b.envelope.binding.previousCipherSha256!==null)fail();
    const auth={schema:'fee-console.ratio-snapshot-manager-auth.v1',confirmedAt:now.toISOString(),profileSha256,bodySha256:await hash(b)};
    const mac=ratioCore.encode(new Uint8Array(await cryptoImpl.subtle.sign('HMAC',manager.authenticationKey,encode(canonical(auth)))));
    return {body:structuredClone(b),authentication:{...auth,mac}};
  }
  async function verify(packet,manager,{watermark=null,now=new Date()}={}){
    if(!exact(packet,['body','authentication']))fail();const b=await bodyCheck(packet.body),a=packet.authentication;
    if(!exact(a,['schema','confirmedAt','profileSha256','bodySha256','mac'])||a.schema!=='fee-console.ratio-snapshot-manager-auth.v1'||!iso(a.confirmedAt)||!hex(a.profileSha256)||a.bodySha256!==await hash(b)||Date.parse(a.confirmedAt)<Date.parse(b.source.capturedAt)||Date.parse(a.confirmedAt)>Date.parse(b.source.expiresAt)||Date.parse(a.confirmedAt)>now.getTime()||!recent(b.source,a.confirmedAt)||b.recipientId!==manager.recipient.recipientId||b.scopeId!==manager.recipient.scopeId||!manager.authenticationKey)fail();
    const {mac,...auth}=a;if(!await cryptoImpl.subtle.verify('HMAC',manager.authenticationKey,ratioCore.decode(mac),encode(canonical(auth))))fail();
    const model=await ratioCore.open(b.envelope,manager);if(model.report.kind!=='snapshot'||model.report.feeAccountingThrough!==null||await hash(model)!==b.source.modelSha256)fail();
    if(b.source.kind==='complete-official-workbook-association'?(model.schema!=='fee-console.ratio-view.v2'||canonical(model.sourceDates)!==canonical(b.source.sourceDates)):model.schema==='fee-console.ratio-view.v2')fail();
    const id=await hash(b),value={version:b.version,id,sourceDate:b.source.asOf,capturedAt:b.source.capturedAt,...(b.source.sourceDates?{sourceDates:structuredClone(b.source.sourceDates)}:{})};
    if(watermark&&(!exact(watermark,['version','id','sourceDate','capturedAt',...(Object.hasOwn(watermark,'sourceDates')?['sourceDates']:[])])||!Number.isSafeInteger(watermark.version)||watermark.version<1||!hex(watermark.id)||!iso(watermark.capturedAt)||typeof watermark.sourceDate!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(watermark.sourceDate)||watermark.sourceDates&&(!exact(watermark.sourceDates,['classification','exposure'])||Object.values(watermark.sourceDates).some(d=>typeof d!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(d))||watermark.sourceDates.classification>watermark.sourceDates.exposure||watermark.sourceDates.exposure!==watermark.sourceDate)||b.version<watermark.version||b.version===watermark.version&&id!==watermark.id||value.sourceDate<watermark.sourceDate||value.capturedAt<watermark.capturedAt||(value.sourceDates?.classification||value.sourceDate)<(watermark.sourceDates?.classification||watermark.sourceDate)))fail();
    return {model,watermark:value,stale:now.getTime()>Date.parse(b.source.expiresAt),source:structuredClone(b.source),confirmedAt:a.confirmedAt};
  }
  return {SCHEMA,FILE,verifyOriginal,candidate,authenticate,verify,bodyCheck,digestBytes};
}
