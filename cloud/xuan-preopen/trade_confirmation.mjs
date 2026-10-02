// Pure synthetic-tested adapter. No file reads, network, credentials, financial
// mutations or CLI. Private real-row integration is separately authorized.
import crypto from 'node:crypto';
export const TRADE_CONFIRMATION_HEADERS=Object.freeze(['ClientAccountID','Conid','TradeID','ExecID','OrderID','TradeDate','ReportDate','SettleDate','Date/Time','OrderTime','CurrencyPrimary','CommissionCurrency','Buy/Sell','Quantity','Price','Amount','Proceeds','Commission','Tax','NetCash','AssetClass','Symbol','ListingExchange','Exchange','LevelOfDetail','OrigTradeID','OrigTradeDate','OrigTradePrice','TransactionType','Code']);
const fail=code=>{throw new Error('TC_'+code);};
function parseCsv(text){
 if(typeof text!=='string'||Buffer.byteLength(text)>8_000_000)fail('SIZE');
 text=text.replace(/^\uFEFF/,'');const rows=[];let row=[],field='',quoted=false,closed=false;
 for(let i=0;i<=text.length;i++){
  const c=text[i];
  if(quoted){if(c===undefined)fail('CSV_QUOTE');if(c==='"'){if(text[i+1]==='"'){field+='"';i++;}else{quoted=false;closed=true;}}else field+=c;continue;}
  if(c==='"'){if(field||closed)fail('CSV_QUOTE');quoted=true;continue;}
  if(c===','||c==='\n'||c==='\r'||c===undefined){row.push(field);field='';closed=false;if(c!==','){if(row.some(v=>v!==''))rows.push(row);row=[];if(c==='\r'&&text[i+1]==='\n')i++;if(rows.length>10001)fail('ROW_BUDGET');}continue;}
  if(closed)fail('CSV_QUOTE');field+=c;
 }
 return rows;
}
function date(value,optional=false){
 if(value===''&&optional)return null;
 const m=/^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value||'');if(!m)fail('DATE_FORMAT');
 const iso=`${m[3]}-${m[1]}-${m[2]}`;if(!Number.isFinite(Date.parse(iso+'T00:00:00Z'))||new Date(iso+'T00:00:00Z').toISOString().slice(0,10)!==iso)fail('DATE_INVALID');return iso;
}
const number=value=>{if(typeof value!=='string'||!/^[-+]?\d+(?:\.\d+)?$/.test(value))fail('NUMBER_INVALID');const n=Number(value);if(!Number.isFinite(n)||Math.abs(n)>1e12)fail('NUMBER_RANGE');return n;};
const id=value=>{if(typeof value!=='string'||!value||value.length>128||/[\u0000-\u001f]/.test(value))fail('IDENTIFIER_INVALID');return value;};
export function adaptTradeConfirmationCsv(csv,{expectedAccount,targetTradeDate}={}){
 id(expectedAccount);if(!/^\d{4}-\d{2}-\d{2}$/.test(targetTradeDate||'')||!Number.isFinite(Date.parse(targetTradeDate+'T00:00:00Z'))||new Date(targetTradeDate+'T00:00:00Z').toISOString().slice(0,10)!==targetTradeDate)fail('TARGET_DATE_INVALID');
 const table=parseCsv(csv);if(!table.length)fail('HEADER_MISSING');const header=table.shift();
 if(new Set(header).size!==header.length||TRADE_CONFIRMATION_HEADERS.some(k=>!header.includes(k)))fail('HEADER_UNVERIFIED');
 const rows=table.map(values=>{if(values.length!==header.length)fail('ROW_SHAPE');return Object.fromEntries(header.map((k,i)=>[k,values[i]]));});
 const identities=new Set(rows.map(r=>r.ClientAccountID));if(identities.size>1||rows.some(r=>r.ClientAccountID!==expectedAccount))fail('ACCOUNT_SCOPE_CONFLICT');
 const seen=new Map(),executions=[];let duplicateRows=0;
 for(const row of rows){
  const executionId=id(row.ExecID),fingerprint=crypto.createHash('sha256').update(JSON.stringify(row)).digest('hex');
  if(seen.has(executionId)){if(seen.get(executionId)!==fingerprint)fail('EXECUTION_CONFLICT');duplicateRows++;continue;}seen.set(executionId,fingerprint);
  const reportedTradeDate=date(row.TradeDate),reportDate=date(row.ReportDate),settleDate=date(row.SettleDate,true);
  const time=/^(\d{2}\/\d{2}\/\d{4});(\d{2})(\d{2})(\d{2})$/.exec(row['Date/Time']||'');
  if(!time||+time[2]>23||+time[3]>59||+time[4]>59)fail('EXECUTION_TIME_FORMAT');
  const executedLocalDate=date(time[1]);
  if(!/^[A-Z]{3}$/.test(row.CurrencyPrimary)||row.CommissionCurrency&&!/^[A-Z]{3}$/.test(row.CommissionCurrency))fail('CURRENCY_INVALID');
  const side=row['Buy/Sell'].toUpperCase();if(!['BUY','SELL'].includes(side))fail('SIDE_INVALID');
  const economics=Object.fromEntries(['Quantity','Price','Amount','Proceeds','Commission','Tax','NetCash'].map(k=>[k,number(row[k])]));
  if(economics.Quantity===0||economics.Price<0)fail('EXECUTION_ECONOMICS_INVALID');
  executions.push({executionId,tradeId:id(row.TradeID),orderId:id(row.OrderID),contractId:id(row.Conid),reportedTradeDate,reportDate,settleDate,
    executedLocalDate,executedLocalTime:`${time[2]}:${time[3]}:${time[4]}`,timezone:null,executedAtUtc:null,
    currency:row.CurrencyPrimary,commissionCurrency:row.CommissionCurrency||null,side,economics,
    economicText:Object.fromEntries(['Quantity','Price','Amount','Proceeds','Commission','Tax','NetCash'].map(k=>[k,row[k]])),
    assetClass:row.AssetClass,symbol:row.Symbol,listingExchange:row.ListingExchange,exchange:row.Exchange,levelOfDetail:row.LevelOfDetail,orderTimeText:row.OrderTime||null,
    correction:{originalTradeId:row.OrigTradeID||null,originalTradeDate:date(row.OrigTradeDate,true),originalTradePrice:row.OrigTradePrice?number(row.OrigTradePrice):null,transactionType:row.TransactionType||null,code:row.Code||null},rawRowSha256:fingerprint});
 }
 return {source:'trade-confirmation-csv',rawSha256:crypto.createHash('sha256').update(csv).digest('hex'),executionCount:executions.length,duplicateRows,
   accountScope:{rowsMatchApprovedAccount:rows.length>0,uniqueAccount:identities.size===1},executions,
   targetTradeDate,reportedTargetDateExecutionCount:executions.filter(r=>r.reportedTradeDate===targetTradeDate).length,
   completeness:{generatedAt:null,coveredThroughDate:null,timezone:null,cancelPairsIncluded:false,cancellationsVerified:false,targetSessionFullyCovered:false,zeroExecutionsCertified:false,ledgerFinality:'not-certified'},
   warnings:['CSV_TIMEZONE_NOT_DECLARED','REPORT_DATE_NOT_OVERALL_COVERAGE_END','CANCEL_PAIRS_NOT_INCLUDED',...(executions.some(r=>r.commissionCurrency===null)?['COMMISSION_CURRENCY_NOT_PROVIDED']:[])]};
}
