// Persistent owner-provided declaration. No external IO, age/freshness gate or
// additional confirmation requirement. A changed level is a new dated entry.
import crypto from 'node:crypto';
const date=s=>/^\d{4}-\d{2}-\d{2}$/.test(s||'')&&Number.isFinite(Date.parse(s+'T00:00:00Z'))&&new Date(s+'T00:00:00Z').toISOString().slice(0,10)===s;
export const callDeclarationSha256=e=>crypto.createHash('sha256').update(JSON.stringify({date:e.date,usd:e.usd})).digest('hex');
export function currentReserve(ledger,day){
  if(ledger?.schemaVersion!==1||ledger.purpose!=='xuan-etf-owner-declared-pending-calls'||!Array.isArray(ledger.entries)
    ||ledger.entries.some(e=>!date(e?.date)||!Number.isFinite(e.usd)||e.usd<0))throw Error('PENDING_CALL_LEDGER_INVALID');
  const entry=ledger.entries.filter(e=>e.date<=day).sort((a,b)=>a.date.localeCompare(b.date)).at(-1);
  if(!entry)throw Error('PENDING_CALL_RESERVE_UNAVAILABLE');return entry.usd;
}
export function resolveCurrentCall(ledger,day){
  const absent=status=>({status,declarationDate:null,declarationSha256:null,amountUsd:null});
  if(!date(day))return absent('invalid');
  try{currentReserve(ledger,day);}catch{return absent(ledger==null?'unavailable':'invalid');}
  if(new Set(ledger.entries.map(e=>e.date)).size!==ledger.entries.length)return absent('invalid');
  const entry=ledger.entries.filter(e=>e.date<=day).sort((a,b)=>a.date.localeCompare(b.date)).at(-1),sha=callDeclarationSha256(entry);
  if(entry.usd>1e12)return absent('invalid');
  return {status:'owner-declared',declarationDate:entry.date,declarationSha256:sha,amountUsd:entry.usd};
}
