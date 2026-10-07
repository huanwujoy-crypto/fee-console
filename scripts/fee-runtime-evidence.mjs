// Private destination association evidence. This does not attest broker scan completion.
import crypto from 'node:crypto';
const fail=()=>{throw Error('FEE_CLOUD_ASSOCIATION_RECEIPT');};
export function canonicalTradeId(value){return typeof value==='string'&&/^[1-9]\d{0,31}$/.test(value)?value:typeof value==='number'&&Number.isSafeInteger(value)&&value>0?String(value):null;}
const PADDED_BYTES=16384;
const SEALED_BYTES=PADDED_BYTES+28;
const hash=x=>crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
export function destinationTradeLink({targetDate,cashRecord,trade}) {
 return {schema:'fee.destination-trade-link.v1',targetDate,broker:'webull',state:'STRICT_SOURCE_MATCHED',cashRecordId:canonicalTradeId(cashRecord.id),tradeId:canonicalTradeId(trade.id),actualFeeStatus:'DESTINATION_MATCHED_ONLY',cashHash:hash(cashRecord),tradeHash:hash(trade),wholeDayComplete:false};
}
const aad=c=>Buffer.from(`fee.trade-links-sealed.v1\n${c.targetDate}\n${c.dataSha256}`);
export function validTradeLinksEnvelope(e){return e&&Object.keys(e).sort().join()==='ciphertext,schema'&&e.schema==='fee.trade-links-sealed.v1'&&typeof e.ciphertext==='string'&&e.ciphertext.length===4*Math.ceil(SEALED_BYTES/3)&&/^[A-Za-z0-9+/]+={0,2}$/.test(e.ciphertext)&&Buffer.from(e.ciphertext,'base64').toString('base64')===e.ciphertext&&Buffer.from(e.ciphertext,'base64').length===SEALED_BYTES;}
function validLinks(links,c){if(!Array.isArray(links)||links.length>32)fail();const ids=new Set();for(const l of links){if(Object.keys(l).sort().join()!=='actualFeeStatus,broker,cashHash,cashRecordId,schema,state,targetDate,tradeHash,tradeId,wholeDayComplete'||l.schema!=='fee.destination-trade-link.v1'||l.broker!=='webull'||l.targetDate!==c.targetDate||l.state!=='STRICT_SOURCE_MATCHED'||l.actualFeeStatus!=='DESTINATION_MATCHED_ONLY'||l.wholeDayComplete!==false||![l.cashRecordId,l.tradeId].every(n=>typeof n==='string'&&canonicalTradeId(n)===n)||![l.cashHash,l.tradeHash].every(h=>/^[a-f0-9]{64}$/.test(h)))fail();if(ids.has(l.cashRecordId))fail();ids.add(l.cashRecordId);}}
export function sealTradeLinks(links,c,key){validLinks(links,c);if(!Buffer.isBuffer(key)||key.length!==32)fail();const body=Buffer.from(JSON.stringify(links));if(body.length>PADDED_BYTES-4)fail();const padded=crypto.randomBytes(PADDED_BYTES);padded.writeUInt32BE(body.length,0);body.copy(padded,4);const nonce=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key,nonce);cipher.setAAD(aad(c));const b=Buffer.concat([nonce,cipher.update(padded),cipher.final(),cipher.getAuthTag()]);return {schema:'fee.trade-links-sealed.v1',ciphertext:b.toString('base64')};}
export function openTradeLinks(e,c,key){if(!validTradeLinksEnvelope(e)||!Buffer.isBuffer(key)||key.length!==32)fail();try{const b=Buffer.from(e.ciphertext,'base64'),d=crypto.createDecipheriv('aes-256-gcm',key,b.subarray(0,12));d.setAAD(aad(c));d.setAuthTag(b.subarray(-16));const padded=Buffer.concat([d.update(b.subarray(12,-16)),d.final()]);const size=padded.readUInt32BE(0);if(size<2||size>PADDED_BYTES-4)fail();const links=JSON.parse(padded.subarray(4,4+size));validLinks(links,c);return links;}catch{fail();}}

// Reuse only after authenticated open and exact evidence comparison. Rejected cache is freshly sealed.
export function reuseOrSealTradeLinks(links,c,key,previous){validLinks(links,c);if(validTradeLinksEnvelope(previous)){try{if(JSON.stringify(openTradeLinks(previous,c,key))===JSON.stringify(links))return previous;}catch{/* never trust an unauthenticated or differently bound prior envelope */}}return sealTradeLinks(links,c,key);}
