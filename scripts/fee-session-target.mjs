// Reuse reviewed repository NYSE annual tables; no IB source or account dependency.
import fs from 'node:fs';import crypto from 'node:crypto';
import {hktDate,marketOpen} from '../cloud/xuan-preopen/calendar.mjs';
const calendarSha256=crypto.createHash('sha256').update(fs.readFileSync(new URL('../cloud/xuan-preopen/calendar.mjs',import.meta.url))).digest('hex');
export async function resolveFeeSessionTarget(now=new Date()){
 if(!Number.isFinite(new Date(now).getTime()))throw Error('FEE_SESSION_CLOCK');
 const parts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Hong_Kong',hour:'2-digit',hourCycle:'h23'}).formatToParts(new Date(now)).map(p=>[p.type,p.value]));
 // Conservative fixed window: previous NY day is certainly closed by 06 HKT.
 if(Number(parts.hour)<6)throw Error('FEE_SESSION_NOT_CLOSED');
 let day=Date.parse(hktDate(new Date(now))+'T00:00:00Z')-86400000;
 for(let i=0;i<10;i++,day-=86400000){const d=new Date(day).toISOString().slice(0,10);if(marketOpen(d,'NYSE'))return {targetDate:d,lastCompletedSession:d,targetTimezone:'America/New_York',calendarSha256};}
 throw Error('FEE_SESSION_UNAVAILABLE');
}
