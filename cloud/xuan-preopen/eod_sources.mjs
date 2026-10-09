// Inactive, injected EOD codec: no network, credentials, CLI or new endpoint.
import crypto from 'node:crypto';
export const digest = value => crypto.createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const fail = code => { throw new Error('EOD_' + code); };
export const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value || '') && Number.isFinite(Date.parse(value+'T00:00:00Z')) && new Date(value+'T00:00:00Z').toISOString().slice(0,10) === value;
const date = value => { const d = /^\d{8}$/.test(value || '') ? value.slice(0,4)+'-'+value.slice(4,6)+'-'+value.slice(6) : value; if (!validDate(d)) fail('DATE'); return d; };
const number = value => { if (typeof value !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(value)) fail('NUMBER'); const n = Number(value); if (!Number.isFinite(n) || Math.abs(n)>1e12) fail('NUMBER'); return n; };
const attrs = text => {
  const result = {}, pattern = /([A-Za-z][A-Za-z0-9]*)="([^"<>]*)"/g; let match, rest = text;
  while ((match = pattern.exec(text))) { if (Object.hasOwn(result,match[1])) fail('XML_DUPLICATE_ATTRIBUTE'); result[match[1]] = match[2]; rest = rest.replace(match[0],''); }
  if (rest.trim() || Object.values(result).some(v=>v.includes('&'))) fail('XML_ATTRIBUTE'); return result;
};
// Bounded tokenized grammar; recognized rows must be direct children of one
// direct statement section. Searching tags anywhere cannot certify coverage.
function documentOf(bytes) {
  const xml=bytes.replace(/^<\?xml[^>]*\?>/,''), tokens=[...xml.matchAll(/<[^<>]*>/g)];
  let cursor=0,root=null;const stack=[];
  if(tokens.length>100_000)fail('XML_NODE_BUDGET');
  for(const token of tokens){
    if(xml.slice(cursor,token.index).trim())fail('XML_TEXT');cursor=token.index+token[0].length;
    const close=/^<\/([A-Za-z][A-Za-z0-9]*)\s*>$/.exec(token[0]);
    if(close){if(!stack.length||stack.pop().name!==close[1])fail('XML_TOPOLOGY');continue;}
    const open=/^<([A-Za-z][A-Za-z0-9]*)(\s[^<>]*?)?\s*(\/?)>$/.exec(token[0]);
    if(!open)fail('XML_TOKEN');
    const node={name:open[1],attributes:attrs((open[2]||'').replace(/\/\s*$/,'')),children:[]};
    if(stack.length)stack.at(-1).children.push(node);else{if(root)fail('XML_ROOT');root=node;}
    if(!open[3]){stack.push(node);if(stack.length>8)fail('XML_DEPTH');}
  }
  if(xml.slice(cursor).trim()||stack.length||!root)fail('XML_TOPOLOGY');
  if(!['AF','FlexQueryResponse'].includes(root.name)||root.children.length!==1||root.children[0].name!=='FlexStatements')fail('XML_ROOT');
  const group=root.children[0];if(group.children.length!==1||group.children[0].name!=='FlexStatement')fail('STATEMENT_SCOPE');
  const statement=group.children[0],rowNames={CashReport:'CashReportCurrency',OpenPositions:'OpenPosition',Trades:'Trade',CashTransactions:'CashTransaction',ConversionRates:'ConversionRate'};
  const seen=new Set();
  for(const section of statement.children){
    if(seen.has(section.name))fail('SECTION_DUPLICATE');seen.add(section.name);
    if(!Object.hasOwn(rowNames,section.name)||section.children.some(r=>r.name!==rowNames[section.name]||r.children.length))fail('SECTION_SHAPE');
  }
  return statement;
}
function rows(statement,section){const node=statement.children.find(n=>n.name===section);return node?node.children.map(n=>n.attributes):null;}
/** Query identity is immutable archive configuration, never an XML queryid.
 * Strict supported subset; actual expanded Activity coverage remains unbound. */
export function adaptFlexArchive({bytes, metadata}, {expectedAccount, expectedQueryId, sourceDate, readAt}={}) {
  if (typeof bytes !== 'string' || Buffer.byteLength(bytes)>8_000_000 || /<!|<\?|&/.test(bytes.replace(/^<\?xml[^>]*\?>/,''))) fail('XML_UNSUPPORTED');
  if (!expectedAccount || !expectedQueryId || !validDate(sourceDate) || !Number.isFinite(Date.parse(readAt))) fail('SCOPE');
  if (!metadata || metadata.configuredQueryId !== expectedQueryId || !/^\d+$/.test(metadata.generation || '')
    || typeof metadata.privateObject !== 'string' || !metadata.privateObject || metadata.rawSha256 !== digest(bytes)) fail('ARCHIVE_BINDING');
  const statement=documentOf(bytes),header=statement.attributes;
  if (header.accountId!==expectedAccount || date(header.toDate)!==sourceDate || date(header.fromDate)>sourceDate) fail('ACCOUNT_OR_CUTOFF');
  const generated = header.whenGenerated;
  if (!/^\d{8};\d{6}$/.test(generated || '') && !/^\d{4}-\d{2}-\d{2};\d{2}:\d{2}:\d{2}$/.test(generated || '')) fail('GENERATION_TIME');
  const timezone=metadata.providerTimezone ?? null;
  if (timezone!==null) { try { new Intl.DateTimeFormat('en',{timeZone:timezone}); } catch { fail('PROVIDER_TIMEZONE'); } }
  const cashRows=rows(statement,'CashReport'), positionRows=rows(statement,'OpenPositions'), tradeRows=rows(statement,'Trades');
  for(const section of statement.children)for(const row of section.children){if(row.attributes.accountId!==undefined&&row.attributes.accountId!==expectedAccount)fail('ROW_SCOPE');}
  const checkRow=r=>{if(r.accountId!==expectedAccount || r.reportDate && date(r.reportDate)!==sourceDate)fail('ROW_SCOPE');};
  [cashRows,positionRows,tradeRows].filter(Boolean).flat().forEach(checkRow);
  let cash=null;
  if(cashRows!==null){
    const base=cashRows.filter(r=>r.levelOfDetail==='BaseCurrency'), native=cashRows.filter(r=>r.levelOfDetail==='Currency');
    if(base.length!==1 || metadata.baseCurrency!=='USD' || base[0].currency!=='BASE_SUMMARY' || base.length+native.length!==cashRows.length || new Set(native.map(r=>r.currency)).size!==native.length || native.some(r=>! /^[A-Z]{3}$/.test(r.currency)))fail('CASH_CURRENCY_SCOPE');
    const details=cashRows.map(r=>({currency:r.currency,level:r.levelOfDetail,endingCash:number(r.endingCash),endingSettledCash:number(r.endingSettledCash),
      components:Object.fromEntries(['commissions','fxTranslationGainLoss','netTradesPurchases','netTradesSales'].filter(k=>r[k]!==undefined).map(k=>[k,number(r[k])]))}));
    cash={currency:'USD',tradeDate:details.find(r=>r.level==='BaseCurrency').endingCash,settled:details.find(r=>r.level==='BaseCurrency').endingSettledCash,native:details.filter(r=>r.level==='Currency')};
    if(cash.tradeDate<0||cash.settled<0)fail('NEGATIVE_CASH_UNSUPPORTED');
  }
  const positions=positionRows===null?null:positionRows.map(r=>{
    if(r.levelOfDetail!=='SUMMARY' || !r.conid || !r.symbol || !/^[A-Z]{3}$/.test(r.currency) || date(r.reportDate)!==sourceDate)fail('POSITION_SHAPE');
    const p={contractId:r.conid,symbol:r.symbol,currency:r.currency,quantity:number(r.position),multiplier:number(r.multiplier),price:number(r.markPrice),value:number(r.positionValue),fxRateToBase:number(r.fxRateToBase)};
    if(p.quantity<0||p.price<0||p.multiplier<=0||p.fxRateToBase<=0||Math.abs(p.quantity*p.multiplier*p.price-p.value)>Math.max(.02,Math.abs(p.value)*1e-6))fail('POSITION_RECONCILIATION');return p;
  });
  if(positions && new Set(positions.map(p=>p.contractId)).size!==positions.length)fail('POSITION_DUPLICATE');
  let trades=null,duplicateRows=0,cancellationPending=false;
  if(tradeRows!==null){const seen=new Map();trades=[];for(const r of tradeRows){
    if(r.levelOfDetail!=='EXECUTION' || !r.tradeID || !r.ibExecID || !r.conid || !['BUY','SELL'].includes(r.buySell) || !/^[A-Z]{3}$/.test(r.currency) || date(r.tradeDate)>sourceDate)fail('TRADE_SHAPE');
    const fingerprint=digest(r);if(seen.has(r.ibExecID)){if(seen.get(r.ibExecID)!==fingerprint)fail('TRADE_CONFLICT');duplicateRows++;continue;}seen.set(r.ibExecID,fingerprint);
    const corrected=!!r.origTradeID || /CANCEL|CORRECT/i.test((r.transactionType||'')+' '+(r.code||''));cancellationPending ||= corrected;
    trades.push({executionId:r.ibExecID,tradeId:r.tradeID,tradeDate:date(r.tradeDate),side:r.buySell,quantity:number(r.quantity),price:number(r.tradePrice),netCash:number(r.netCash),commission:number(r.ibCommission),currency:r.currency,correctionPending:corrected});
  }}
  // Supplier metadata proves neither reconciliation nor execution/cancel
  // coverage. The pure archive codec never grants financial finality.
  return {sourceKey:'ib.flexEod',rawFingerprint:digest(bytes),cash,positions,trades,duplicateRows,tradeCoverageProven:false,
    reconciliation:{status:'unknown',cashResidual:null,cancellationPending,verificationSha256:null},
    provenance:{sourceDate,coveredFrom:date(header.fromDate),coveredThrough:date(header.toDate),providerGeneratedText:generated,providerTimezone:timezone,readAt,archiveGeneration:metadata.generation,archiveSha256:metadata.rawSha256,configuredQueryId:expectedQueryId}};
}
/** Internal normalized result of an injected independent financial verifier.
 * Not a claimed production receipt format. No default verifier or new signer.
 * Identity/hash validation alone cannot activate these financial capabilities. */
export function applyFinancialVerification(flex,proof,{expectedAccount,expectedQueryId,sourceDate,generation}){
  const exact=(o,keys)=>o&&Object.getPrototypeOf(o)===Object.prototype&&Object.keys(o).sort().join('|')===keys.sort().join('|');
  if(!exact(proof,['status','scope','account','configuredQueryId','sourceDate','generation','rawSha256','evidence','facts'])||proof.status!=='independently-checked'||proof.scope!=='eod-cash-and-executions'||proof.account!==expectedAccount||proof.configuredQueryId!==expectedQueryId||proof.sourceDate!==sourceDate||proof.generation!==generation||proof.rawSha256!==flex.rawFingerprint)fail('FINANCIAL_PROOF_BINDING');
  const e=proof.evidence,f=proof.facts;
  if(!exact(e,['receiptSha256','receiptGeneration','snapshotSha256','snapshotGeneration'])||!['receiptSha256','snapshotSha256'].every(k=>/^[a-f0-9]{64}$/.test(e[k]||''))||!['receiptGeneration','snapshotGeneration'].every(k=>/^\d+$/.test(e[k]||'')))fail('FINANCIAL_EVIDENCE');
  if(!exact(f,['cashResidual','cashCoveredThrough','executionsCoveredThrough','cancellationsComplete','cashMovementsComplete'])||!(f.cashResidual===null||typeof f.cashResidual==='number'&&Number.isFinite(f.cashResidual)&&Math.abs(f.cashResidual)<=1e12)||!(f.cashCoveredThrough===null||validDate(f.cashCoveredThrough)&&f.cashCoveredThrough<=sourceDate)||!(f.executionsCoveredThrough===null||validDate(f.executionsCoveredThrough)&&f.executionsCoveredThrough<=sourceDate)||typeof f.cancellationsComplete!=='boolean'||typeof f.cashMovementsComplete!=='boolean')fail('FINANCIAL_FACTS');
  const tradeCoverageProven=flex.trades!==null&&f.executionsCoveredThrough===sourceDate&&f.cancellationsComplete&&!flex.reconciliation.cancellationPending;
  const reconciled=tradeCoverageProven&&flex.cash!==null&&f.cashCoveredThrough===sourceDate&&f.cashMovementsComplete&&f.cashResidual===0;
  return {...flex,tradeCoverageProven,reconciliation:{status:reconciled?'verified':f.cashResidual===null?'unknown':'pending',cashResidual:f.cashResidual,cancellationPending:flex.reconciliation.cancellationPending,verificationSha256:digest(proof)}};
}
export const SNAPSHOT_SCOPES=Object.freeze({
  'sharesight.ibGroupedPerformance':{portfolioId:936247,portfolio:'IB-HK',grouping:'83569'},
  'sharesight.noahPerformance':{portfolioId:936238,portfolio:'NOAH-HK',grouping:'investment_type'},
});
/** One-time private acceptance of the explicitly supplied official UI extract.
 * The pinned transfer hash binds local bytes only. Parent-reported original
 * XLSX/PDF hashes are not locally verified binaries, API or sync receipts.
 * This has no browser, reader, credentials or production entry point. */
export function adaptPrivateNoahUiExport({bytes,expectedTransferSha256}, {sourceDate,reportStart,now=Date.now}={}) {
  if(typeof bytes!=='string'||Buffer.byteLength(bytes)>3_000_000||! /^[a-f0-9]{64}$/.test(expectedTransferSha256||'')||digest(bytes)!==expectedTransferSha256)fail('UI_EXPORT_BYTES');
  let input;try{input=JSON.parse(bytes);}catch{fail('UI_EXPORT_JSON');}
  const scope=SNAPSHOT_SCOPES['sharesight.noahPerformance'],p=input.provenance;
  if(!validDate(sourceDate)||!validDate(reportStart)||reportStart>sourceDate||p?.portfolio_id!==scope.portfolioId||p.portfolio!==scope.portfolio||p.report_start!==reportStart||p.report_end!==sourceDate||p.report_timezone!=='America/New_York'||p.grouping!=='Investment type'||p.include_closed_positions!==false||p.original_start_date_preserved!==true)fail('UI_EXPORT_SCOPE');
  let url;try{url=new URL(p.source_url);}catch{fail('UI_EXPORT_SCOPE');}
  if(url.origin!=='https://portfolio.sharesight.com'||url.username||url.password||!Number.isSafeInteger(p.report_id)||p.report_id<=0||url.pathname!==`/portfolios/${scope.portfolioId}/tools/performance/${p.report_id}`||url.search!=='?consolidated=false'||url.hash)fail('UI_EXPORT_SCOPE');
  const captured=Date.parse(p.captured_utc),exported=Date.parse(p.export_xlsx_utc),readAt=now();
  if(!Number.isFinite(captured)||!Number.isFinite(exported)||captured>exported||exported>readAt)fail('UI_EXPORT_TIME');
  if(!input.file_hashes||!Object.entries(input.file_hashes).some(([k,v])=>k.endsWith('.xlsx')&&/^[a-f0-9]{64}$/.test(v))||!Object.entries(input.file_hashes).some(([k,v])=>k.endsWith('.pdf')&&/^[a-f0-9]{64}$/.test(v)))fail('UI_EXPORT_ORIGINAL_HASHES');
  const rows=input.original_export_cells;if(!Array.isArray(rows)||!rows.length||rows.length>25_000)fail('UI_EXPORT_ROWS');
  const sheets=[];
  for(const r of rows){
    if(!r||! /^[1-9]\d{0,3}$/.test(r.row)||!r.cells||Object.getPrototypeOf(r.cells)!==Object.prototype||!Object.keys(r.cells).length||Object.entries(r.cells).some(([k,v])=>!new RegExp('^[A-P]'+r.row+'$').test(k)||typeof v!=='string'||!v||v.length>512||/[\x00-\x1f]/.test(v)))fail('UI_EXPORT_ROWS');
    if(r.row==='1')sheets.push(new Map());
    const sheet=sheets.at(-1);if(!sheet||sheet.has(r.row))fail('UI_EXPORT_ROWS');sheet.set(r.row,r.cells);
  }
  const label=d=>new Intl.DateTimeFormat('en-GB',{timeZone:'UTC',day:'numeric',month:'short',year:'numeric'}).format(new Date(d+'T00:00:00Z'));
  const header=['Market','Code','Name','Price','Quantity','Value (us$)','Capital Gains','Capital Gains Percentage','Dividends','Dividends Percentage','Currency','Currency Percentage','Return','Return Percentage','Investment Type','Labels'];
  if(sheets.length<2||sheets.length>10)fail('UI_EXPORT_SHEETS');
  for(const s of sheets){
    if(s.get('1')?.A1!==`Performance Report for ${scope.portfolio}`||s.get('2')?.A2!==`Showing performance by Investment type between dates ${label(reportStart)} to ${label(sourceDate)}`||s.get('3')?.A3!=='Excluding sold shares')fail('UI_EXPORT_HEADERS');
    const headers=[...s].filter(([n,c])=>header.every((v,i)=>c[String.fromCharCode(65+i)+n]===v));if(headers.length!==1)fail('UI_EXPORT_HEADERS');
  }
  const cashRows=s=>[...s].filter(([n,c])=>c['O'+n]==='Cash Accounts');
  const grouped=sheets.slice(1).filter(s=>/^Grouping \d+ Cash Accounts$/.test(s.get('4')?.A4||''));
  const primary=cashRows(sheets[0]);if(primary.length!==1||grouped.length!==1)fail('UI_EXPORT_CASH');
  const detail=cashRows(grouped[0]);if(detail.length!==1)fail('UI_EXPORT_CASH');
  const amount=([n,c])=>{if(c['C'+n]!==scope.portfolio||c['D'+n]!==undefined||c['E'+n]!==undefined)fail('UI_EXPORT_CASH');return c['F'+n];};
  const text=amount(primary[0]);if(text!==amount(detail[0]))fail('UI_EXPORT_CASH');
  const total=number(text);if(total<0)fail('UI_EXPORT_CASH');
  return {sourceKey:'sharesight.noahPerformance',status:'ui-export-observed',rawFingerprint:expectedTransferSha256,completion:null,
    uiCash:{currency:'USD',dataDate:sourceDate,total},
    provenance:{sourceDate,readAt:new Date(readAt).toISOString(),syncCompletedAt:null,snapshotGeneration:null,receiptSha256:null,uiReportStart:reportStart,uiExportedAt:new Date(exported).toISOString()},
    privateSource:{kind:'Sharesight official UI export',oneTimePrivateAcceptance:true,automaticApiReaderTested:false,originalBinaryHashesLocallyVerified:false,periodReturnsNotDaily:true,originalFileHashes:input.file_hashes}};
}
/** The fixed as-of API scope is enough to display dated source facts. A
 * completed-sync proof is optional and distinct from that scope validation;
 * neither state grants independent broker cash/execution reconciliation. */
export async function readVerifiedSnapshot(sourceKey, {reader,verifyCompletion,sourceDate,now=Date.now}={}) {
  const scope=SNAPSHOT_SCOPES[sourceKey];if(!scope||!validDate(sourceDate))fail('SNAPSHOT_SCOPE');
  if(typeof reader!=='function')return {sourceKey,status:'not-called',code:'SNAPSHOT_ADAPTER_INACTIVE'};
  let envelope;try{envelope=await reader({sourceKey,sourceDate,...scope});}catch{return {sourceKey,status:'request-failure',code:'SNAPSHOT_READ_FAILED'};}
  if(!envelope?.raw)return {sourceKey,status:'missing-fields',code:'SNAPSHOT_RAW_MISSING'};
  const rawFingerprint=digest(envelope.raw),report=envelope.raw.report ?? envelope.raw.data?.report ?? envelope.raw.result?.data?.report;
  if(envelope.raw.mode!=='read_only'||envelope.raw.source!=='Sharesight User API'||!report||report.portfolio_id!==scope.portfolioId || report.currency?.code!=='USD')return {sourceKey,status:'malformed',code:'SNAPSHOT_SCOPE_INVALID'};
  if(report.end_date!==sourceDate)return {sourceKey,status:'date-mismatch',code:'SNAPSHOT_DATE_MISMATCH'};
  const asOf={sourceKey,status:'date-verified',raw:envelope.raw,rawFingerprint,completion:null,
    provenance:{sourceDate,readAt:new Date(now()).toISOString(),syncCompletedAt:null,snapshotGeneration:null,receiptSha256:null}};
  if(typeof verifyCompletion!=='function')return asOf;
  let proof;try{proof=await verifyCompletion({envelope,sourceKey,sourceDate,rawFingerprint,scope});}catch{return asOf;}
  if(proof?.status!=='sync-completed' || proof.sourceKey!==sourceKey || proof.sourceDate!==sourceDate || proof.rawSha256!==rawFingerprint
    || !/^[a-f0-9]{64}$/.test(proof.receiptSha256||'') || !/^\d+$/.test(proof.snapshotGeneration||'')
    || !Number.isFinite(Date.parse(proof.completedAt)) || Date.parse(proof.completedAt)>now())return asOf;
  return {sourceKey,status:'verified',raw:envelope.raw,rawFingerprint,completion:proof,
    provenance:{sourceDate,readAt:new Date(now()).toISOString(),syncCompletedAt:new Date(proof.completedAt).toISOString(),snapshotGeneration:proof.snapshotGeneration,receiptSha256:proof.receiptSha256}};
}
