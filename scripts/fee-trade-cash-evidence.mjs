// Shared source-only paid-trade/cash association. No IO, fees, flows or authority.
// Legacy matchers below preserve the existing reviewed grammar.
const CLOUD_ACCOUNTS={webull:{portfolioId:1350094}};
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const id=value=>{const n=typeof value==='string'&&/^[1-9]\d{0,14}$/.test(value)?Number(value):value;if(!Number.isSafeInteger(n)||n<=0)throw Error('FEE_CLOUD_IDENTITY');return n;};
const exactTicker=value=>{if(typeof value!=='string'||!/^[A-Z0-9][A-Z0-9./^-]{0,31}$/.test(value))throw Error('FEE_CLOUD_HOLDING');return value;};
const CONTROLLED_WEBULL_PRINCIPAL_RE = /^Webull ([A-Z0-9][A-Z0-9./^-]{0,31}) (BUY|SELL) securities principal; NOT external funding; order ([A-Z0-9]{16,40}); (?:holding ([1-9]\d{0,14})|Sharesight trade ([1-9]\d{0,14})); (\d{4}-\d{2}-\d{2}) \d{2}:\d{2}:\d{2} EDT; source fee USD (\d+\.\d{2})\.$/;

export function isControlledWebullPrincipal({ account, row, movement, targetDate, trades }) {
  if (account !== "webull" || !/^(?:DEPOSIT|WITHDRAWAL)$/i.test(String(row.cash_account_transaction_type?.name || ""))) {
    return false;
  }
  const description = typeof row.description === "string" ? row.description : "";
  const match = CONTROLLED_WEBULL_PRINCIPAL_RE.exec(description);
  if (!match || match[6] !== targetDate) return false;
  const [, ticker, side, orderId, holdingIdText, tradeIdText] = match;
  const expectedMovement = side === "BUY" ? -Math.abs(movement) : Math.abs(movement);
  if (Math.abs(expectedMovement - movement) > 0.01) return false;
  const matches = trades.filter(trade => {
    const value = Number(trade.value);
    const comments = typeof trade.comments === "string" ? trade.comments : "";
    return id(trade.portfolio_id) === CLOUD_ACCOUNTS.webull.portfolioId
      && trade.transaction_date === targetDate
      && trade.state === "confirmed"
      && trade.description_code === side
      && exactTicker(trade.instrument?.code) === ticker
      && finite(value) && Math.abs(Math.abs(value) - Math.abs(movement)) <= 0.01
      && comments.startsWith("Webull account 10205226;")
      && comments.includes(`; order ${orderId};`)
      && (holdingIdText ? id(trade.holding_id) === Number(holdingIdText) : id(trade.id) === Number(tradeIdText));
  });
  return matches.length === 1;
}

// Strict support for the reviewed net-proceeds format. Text alone is never proof.
const NET_PROCEEDS_RE = /^Webull ([A-Z0-9][A-Z0-9./^-]{0,31}) SELL net proceeds; NOT external funding\. Order ([A-Z0-9]{16,40}); Sharesight trade ([1-9]\d{0,14}); (\d{4}-\d{2}-\d{2}); gross USD(\d+\.\d{2}) less fee USD(\d+\.\d{2}) = net USD(\d+\.\d{2})\. Fee included, no separate fee debit\.$/;
const NET_TRADE_RE = /^Webull ([A-Z0-9][A-Z0-9./^-]{0,31}) SELL (\d+(?:\.\d+)?) shares on (\d{4}-\d{2}-\d{2}) at USD(\d+(?:\.\d+)?); order ([A-Z0-9]{16,40})\. Commission USD(\d+(?:\.\d{1,2})?); actual fee USD(\d+\.\d{2}) recorded in trade fees\. Gross USD(\d+\.\d{2}); net USD(\d+\.\d{2})\.$/;
const exactCents = value => {
  if (!finite(value) || value < 0 || value > 1e12) return null;
  const cents = Math.round(value * 100);
  return Number.isSafeInteger(cents) && Math.abs(value * 100 - cents) < 1e-4 ? cents : null;
};
export function isControlledWebullNetProceeds({ account, row, movement, targetDate, trades }) {
  if (account !== 'webull' || row.cash_account_transaction_type?.name !== 'DEPOSIT'
      || row.payout_id != null || String(row.date_time || '').slice(0, 10) !== targetDate
      || !Number.isSafeInteger(row.id) || row.id <= 0
      || !Number.isSafeInteger(row.cash_account_id) || row.cash_account_id <= 0 || !finite(movement) || movement <= 0 || !Array.isArray(trades)) return false;
  const cash = NET_PROCEEDS_RE.exec(typeof row.description === 'string' ? row.description : '');
  if (!cash || cash[4] !== targetDate) return false;
  const [, ticker, order, tradeId, , grossText, feeText, netText] = cash;
  const byId = trades.filter(t => String(t.id) === tradeId);
  const byOrder = trades.filter(t => typeof t.comments === 'string' && t.comments.includes(`; order ${order}.`));
  if (byId.length !== 1 || byOrder.length !== 1 || byId[0] !== byOrder[0]) return false;
  const trade = byId[0], proof = NET_TRADE_RE.exec(trade.comments);
  if (!proof || trade.portfolio_id !== CLOUD_ACCOUNTS.webull.portfolioId
      || trade.transaction_date !== targetDate || trade.state !== 'confirmed'
      || trade.description_code !== 'SELL' || trade.instrument?.code !== ticker
      || !Number.isSafeInteger(trade.holding_id) || trade.holding_id <= 0
      || !(trade.price_currency_code === 'USD' || (trade.price_currency_code == null && trade.instrument?.currency_code === 'USD'))
      || trade.brokerage_currency_code !== 'USD'
      || !finite(trade.price) || trade.price <= 0 || !finite(trade.quantity) || trade.quantity <= 0
      || !finite(trade.value) || trade.value >= 0
      || (row.trade_id != null && String(row.trade_id) !== tradeId)
      || (row.holding_id != null && row.holding_id !== trade.holding_id)) return false;
  const gross = exactCents(Number(grossText)), fee = exactCents(Number(feeText)), net = exactCents(Number(netText));
  return gross !== null && fee !== null && net !== null && gross > 0 && net > 0
    && gross - fee === net && exactCents(movement) === net && exactCents(Math.abs(trade.value)) === net
    && exactCents(trade.brokerage) === fee && Math.abs(trade.price * trade.quantity * 100 - gross) < 0.5
    && proof[1] === ticker && proof[3] === targetDate && proof[5] === order
    && Number(proof[2]) === trade.quantity && Number(proof[4]) === trade.price
    && exactCents(Number(proof[6])) !== null && Number(proof[6]) <= Number(feeText)
    && exactCents(Number(proof[7])) === fee && exactCents(Number(proof[8])) === gross
    && exactCents(Number(proof[9])) === net;
}

const sameId=(a,b)=>{try{return id(a)===id(b);}catch{return false;}};
const canonicalPattern=/\b(webull\.manual\|(\d{8})\|([a-f0-9]{16})\|(BUY|SELL)\|([A-Z0-9][A-Z0-9./^-]{0,31})\|(\d+(?:\.\d+)?)\|(\d+(?:\.\d+)?))(?=[ .]|$)/g;
const shortCash=/^Webull ([A-Z0-9][A-Z0-9./^-]{0,31}) (BUY|SELL) (\d+(?:\.\d+)?)\s*@(\d+(?:\.\d+)?); NOT external funding\. Trade([1-9]\d{0,14}); Gmail([a-f0-9]{16}); gross(\d+(?:\.\d+)?), fee(\d+(?:\.\d+)?), cash(-?\d+(?:\.\d+)?)\. key=([^\r\n]+)$/;
const longCash=/^Webull ([A-Z0-9][A-Z0-9./^-]{0,31}) (BUY|SELL) securities principal; NOT external funding\. Trade([1-9]\d{0,14}); Gmail([a-f0-9]{16}); filled (\d{4})\/(\d{2})\/(\d{2}) (\d{2}:\d{2}:\d{2}) EDT; (\d+(?:\.\d+)?)@USD(\d+(?:\.\d+)?), actual transaction fee(\d+(?:\.\d+)?)\. Source phone cash matched by exact six-trade bridge\. key=(webull\.manual\|\d{8}\|\.\.\.)$/;
// Decimal cross products; no epsilon, rounding or formatting of raw money.
function rational(text){
 const m=/^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(text);
 if(!m||text.length>100)return null;
 const exp=Number(m[4]||0)-(m[3]?.length||0);
 if(!Number.isSafeInteger(exp)||Math.abs(exp)>40)return null;
 const n=BigInt(m[2]+(m[3]||''))*(m[1]?-1n:1n);
 return exp<0?{n,d:10n**BigInt(-exp)}:{n:n*10n**BigInt(exp),d:1n};
}
const eq=(a,b)=>!!a&&!!b&&a.n*b.d===b.n*a.d;
const textEquals=(text,row,key)=>!!rational(text)&&finite(row[key])&&Number(text)===row[key];
// Same paid-cash Number-to-cent boundary as the existing strict net-proceeds
// matcher; original-token cash precision remains enforced by the normalizer's
// independent full ledger. This matcher does not replace that source proof.
function cents(row,key){const n=row[key];if(!finite(n))return null;const c=exactCents(Math.abs(n));return c===null?null:BigInt(c)*(n<0?-1n:1n);}
const abs=n=>n<0n?-n:n;

function canonicalTrade(t){
 const keys=[...String(t.comments||'').matchAll(canonicalPattern)];
 if(keys.length!==1)return null;
 const [key,,sourceAccount,gmail,side,ticker,q,p]=keys[0];
 // This component is the existing source account label, NOT a report date.
 if(sourceAccount!=='10205226'||side!==t.description_code||ticker!==t.instrument?.code
   ||!textEquals(q,t,'quantity')||!textEquals(p,t,'price'))return null;
 return {key:keys[0][1],gmail};
}
function manualPair({account,row,trade,targetDate,canonical,uniqueCanonical}){
 if(account!=='webull'||trade.portfolio_id!==CLOUD_ACCOUNTS.webull.portfolioId)return false;
 if(!canonical||!uniqueCanonical)return false;
 const text=typeof row.description==='string'?row.description:'';
 if(text.length>2000||row.payout_id!=null||row.trade_id!=null&&!sameId(row.trade_id,trade.id)
   ||row.holding_id!=null&&!sameId(row.holding_id,trade.holding_id)
   ||row.foreign_identifier!=null&&row.foreign_identifier!==canonical.key+'|cash')return false;
 const short=shortCash.exec(text),long=longCash.exec(text);
 let ticker,side,pointer,gmail,q,p,fee,grossText,movementText;
 if(short){
  [,ticker,side,q,p,pointer,gmail,grossText,fee,movementText]=short;
  if(short[10]!==canonical.key+'|cash')return false;
 }else if(long){
  [,ticker,side,pointer,gmail]=long;q=long[9];p=long[10];fee=long[11];
  if(`${long[5]}-${long[6]}-${long[7]}`!==targetDate
    ||long[12]!=='webull.manual|10205226|...')return false;
 }else return false;
 if(!sameId(pointer,trade.id)||gmail!==canonical.gmail||ticker!==trade.instrument?.code
   ||side!==trade.description_code||!textEquals(q,trade,'quantity')
   ||!textEquals(p,trade,'price')||!textEquals(fee,trade,'brokerage'))return false;
 if(!(trade.price_currency_code==='USD'||trade.price_currency_code==null&&trade.instrument?.currency_code==='USD')
   ||trade.brokerage_currency_code!=='USD'||trade.instrument?.currency_code!=='USD')return false;
 const quantity=rational(q),price=rational(p);
 const feeCents=cents(trade,'brokerage'),valueCents=cents(trade,'value'),cashCents=cents(row,'amount');
 if(!quantity||!price||quantity.n<=0n||price.n<=0n||feeCents===null||feeCents<0n||valueCents===null||cashCents===null)return false;
 const numerator=quantity.n*price.n*100n,denominator=quantity.d*price.d;
 if(numerator%denominator!==0n)return false;
 const gross=numerator/denominator,expected=side==='BUY'?-(gross+feeCents):gross-feeCents;
 if(expected===0n||cashCents!==expected||abs(valueCents)!==abs(expected)
   ||row.cash_account_transaction_type?.name!==(side==='BUY'?'WITHDRAWAL':'DEPOSIT'))return false;
 return (!grossText||eq(rational(grossText),{n:gross,d:100n}))
   &&(!movementText||eq(rational(movementText),{n:cashCents,d:100n}));
}

// Resolve the existing principal format's identity independently of money.
// A wrong amount does not erase its exact holding/trade + order relationship.
// Generic same-holding dividends or fees do not satisfy this grammar.
function principalRelations({account,row,trades}){
 if(account!=='webull')return [];
 const m=CONTROLLED_WEBULL_PRINCIPAL_RE.exec(typeof row.description==='string'?row.description:'');
 if(!m)return [];
 const [,ticker,side,order,holding,tradeId]=m;
 return trades.filter(t=>t.portfolio_id===CLOUD_ACCOUNTS.webull.portfolioId
  &&t.description_code===side&&t.instrument?.code===ticker
  &&String(t.comments||'').startsWith('Webull account 10205226;')
  &&String(t.comments||'').includes(`; order ${order};`)
  &&(holding?sameId(t.holding_id,holding):sameId(t.id,tradeId))).map(t=>id(t.id));
}

// Sharesight record authority: these already supported cash descriptions
// explicitly identify securities principal. They do not need a second,
// same-day trade record to be treated as internal cash. Generic notes and bare
// DEPOSIT/WITHDRAWAL records deliberately do not acquire that meaning here.
const DECLARED_QUOTED_BUY_RE = /^Webull ([A-Z0-9][A-Z0-9./^-]{0,31}) BUY ?(\d+(?:\.\d+)?)\s*@(\d+(?:\.\d+)?) securities principal; NOT external funding\. Trade([1-9]\d{0,14}); Gmail([a-f0-9]{16}); actual fee\s*(\d+(?:\.\d+)?)\. key=(webull\.manual\|10205226\|[a-f0-9]{16}\|BUY\|[A-Z0-9][A-Z0-9./^-]{0,31}\|\d+(?:\.\d+)?\|\d+(?:\.\d+)?\|cash)$/;
// Relationship recognition must also cover the compact BUY<quantity> prefix,
// even when the remainder cannot grant a principal role. A real cash pointer
// must not become a claim of zero cash after a malformed key or fee.
const DECLARED_QUOTED_BUY_POINTER_RE = /^Webull [A-Z0-9][A-Z0-9./^-]{0,31} BUY\d+(?:\.\d+)?\s*@\d+(?:\.\d+)? securities principal; NOT external funding\. Trade/;
export function isSharesightDeclaredTradeCash({account,portfolioId,row,targetDate}){
 if(account!=='webull'||portfolioId!==CLOUD_ACCOUNTS.webull.portfolioId||row.payout_id!=null
   ||String(row.date_time||'').slice(0,10)!==targetDate
   ||!['DEPOSIT','WITHDRAWAL'].includes(row.cash_account_transaction_type?.name))return false;
 const text=typeof row.description==='string'?row.description:'';
 // The dated Sharesight cash record is authoritative. This newer memo keeps
 // the same explicit principal declaration, with quantity/price before it.
 // Verify its complete identity syntax without requiring a second trade read.
 const quoted=DECLARED_QUOTED_BUY_RE.exec(text);
 if(quoted){
  const [,ticker,quantity,price,tradeId,gmail,fee,key]=quoted;
  return row.cash_account_transaction_type.name==='WITHDRAWAL'
   &&finite(row.amount)&&row.amount<0
   &&Number(quantity)>0&&finite(Number(quantity))&&Number(price)>0&&finite(Number(price))
   &&finite(Number(fee))&&Number(fee)>=0
   &&(row.trade_id==null||sameId(row.trade_id,tradeId))
   &&key===`webull.manual|10205226|${gmail}|BUY|${ticker}|${quantity}|${price}|cash`
   &&(row.foreign_identifier==null||row.foreign_identifier===''||row.foreign_identifier===key);
 }
 const short=shortCash.exec(text),long=longCash.exec(text),principal=CONTROLLED_WEBULL_PRINCIPAL_RE.exec(text),net=NET_PROCEEDS_RE.exec(text);
 if(short)return /^webull\.manual\|10205226\|[a-f0-9]{16}\|(BUY|SELL)\|[A-Z0-9][A-Z0-9./^-]{0,31}\|\d+(?:\.\d+)?\|\d+(?:\.\d+)?\|cash$/.test(short[10]);
 if(long)return `${long[5]}-${long[6]}-${long[7]}`===targetDate&&long[12]==='webull.manual|10205226|...';
 if(principal)return principal[6]===targetDate;
 return !!net&&net[4]===targetDate;
}

// Relationship-only index for the selected noncash transfer's no-cash guard.
// A wrong amount or a pointer to a different/absent trade does not erase a
// relationship. This grants no paid-trade authority and creates no flow.
export function sharesightCashRelations({account,portfolioId,targetDate,trades,cashRows}){
 if(!Array.isArray(trades)||!Array.isArray(cashRows)
   ||new Set(trades.map(t=>id(t.id))).size!==trades.length
   ||new Set(cashRows.map(r=>id(r.id))).size!==cashRows.length)throw Error('FEE_NONCASH_INCOMPLETE');
 const relatedCash=new Map();
 for(const row of cashRows){
  const pointers=new Set();
  if(row.trade_id!=null)pointers.add(id(row.trade_id));
  if(account==='webull'){
   // A recognisable identity remains related even if the rest of the record
   // cannot grant the principal role. Invalid money/key text must never turn
   // a selected transfer's real cash leg into an assertion of zero cash.
   const text=typeof row.description==='string'?row.description:'';
   if(/^Webull [A-Z0-9][A-Z0-9./^-]{0,31} (BUY|SELL) /.test(text)||DECLARED_QUOTED_BUY_POINTER_RE.test(text))
    for(const m of text.matchAll(/(?:\bTrade|\bSharesight trade )([1-9]\d{0,14});/g))pointers.add(id(m[1]));
   for(const pointer of principalRelations({account,row,trades}))pointers.add(pointer);
  }
  for(const pointer of pointers){if(!relatedCash.has(pointer))relatedCash.set(pointer,[]);relatedCash.get(pointer).push(id(row.id));}
 }
 return {relatedCash};
}

/** One shared resolution for activity, cash classification and zero-cash
 * rejection. Association is deliberately distinct from verified payment:
 * a pointed-to wrong-amount cash row must still invalidate a noncash claim.
 * Inputs are complete, authenticated source collections, never caller claims.
 */
export function resolveTradeCashEvidence({account,portfolioId,targetDate,trades,cashRows,cashAccounts}){
 const byTrade=new Map(),byCash=new Map(),relations=new Map();
 if(!Array.isArray(trades)||!Array.isArray(cashRows)||!Array.isArray(cashAccounts)
   ||new Set(trades.map(t=>id(t.id))).size!==trades.length
   ||new Set(cashRows.map(r=>id(r.id))).size!==cashRows.length)throw Error('FEE_NONCASH_TRADE_CASH_UNVERIFIED');
 const canonicalById=new Map(),keyCounts=new Map();
 for(const t of trades){const key=canonicalTrade(t);canonicalById.set(id(t.id),key);if(key)keyCounts.set(key.key,(keyCounts.get(key.key)||0)+1);}
 for(const row of cashRows){
  const cashAccount=cashAccounts.filter(a=>sameId(a.id,row.cash_account_id));
  const validCashScope=cashAccount.length===1
   &&(cashAccount[0].currency?.code||cashAccount[0].currency)==='USD'
   &&(cashAccount[0].portfolio_id==null||sameId(cashAccount[0].portfolio_id,portfolioId))
   &&(cashAccount[0].portfolio?.id==null||sameId(cashAccount[0].portfolio.id,portfolioId))
   &&String(row.date_time||'').slice(0,10)===targetDate&&finite(row.amount)&&row.amount!==0;
  const principalIds=new Set(principalRelations({account,row,trades}));
  const legacyIds=new Set(),args={account,row,movement:row.amount,targetDate,trades};
  const principal=validCashScope&&isControlledWebullPrincipal(args),net=validCashScope&&isControlledWebullNetProceeds(args);
  if(principal||net)for(const t of trades)if(principal&&isControlledWebullPrincipal({...args,trades:[t]})
    ||net&&isControlledWebullNetProceeds({...args,trades:[t]}))legacyIds.add(id(t.id));
  const pointerIds=new Set();
  for(const n of principalIds)pointerIds.add(n);
  for(const n of legacyIds)pointerIds.add(n);
  if(row.trade_id!=null){try{pointerIds.add(id(row.trade_id));}catch{pointerIds.add(-1);}}
  if(account==='webull'){
   const description=typeof row.description==='string'?row.description:'';
   if(/^Webull [A-Z0-9][A-Z0-9./^-]{0,31} (BUY|SELL) /.test(description)||DECLARED_QUOTED_BUY_POINTER_RE.test(description))
    for(const match of description.matchAll(/(?:\bTrade|\bSharesight trade )([^;\s]+);/g)){
     try{pointerIds.add(id(match[1]));}catch{pointerIds.add(-1);}
    }
  }
  // Parse every explicit pointer before looking up trades. Enumerating only
  // listed IDs would hide an unknown/conflicting text ID behind a valid native
  // pointer. Stop both activity and normalisation; never fall back to native.
  if(pointerIds.size>1||[...pointerIds].some(n=>!trades.some(t=>id(t.id)===n)))
   throw Error('FEE_NONCASH_TRADE_CASH_UNVERIFIED');
  for(const t of trades){
   const desc=typeof row.description==='string'?row.description:'';
   const explicit=account==='webull'&&/^Webull [A-Z0-9][A-Z0-9./^-]{0,31} (BUY|SELL) /.test(desc)
      &&new RegExp('(?:Trade|Sharesight trade )'+id(t.id)+';').test(desc);
   const old=legacyIds.has(id(t.id));
   const related=sameId(row.trade_id,t.id)||explicit||principalIds.has(id(t.id))||old;
   if(!related)continue;
   if(!relations.has(id(t.id)))relations.set(id(t.id),[]);relations.get(id(t.id)).push(id(row.id));
   if(pointerIds.size>1||!validCashScope||row.payout_id!=null
     ||row.holding_id!=null&&!sameId(row.holding_id,t.holding_id)
     ||t.portfolio_id!==portfolioId||t.transaction_date!==targetDate
     ||t.state!=='confirmed'||!['BUY','SELL'].includes(t.description_code))continue;
   const value=cents(t,'value'),cash=cents(row,'amount');
   // A zero-economic Buy is never paid-trade authority, even if the legacy
   // classifier's unchanged one-cent comparison would call a tiny leg a match.
   // Gift policy is separate and always requires absence of related cash.
   if(t.value===0||t.description_code==='BUY'&&t.price===0)
    throw Error('FEE_NONCASH_TRADE_CASH_UNVERIFIED');
   if(value===null||cash===null)continue;
   const native=sameId(row.trade_id,t.id)&&row.payout_id==null
     &&(row.holding_id==null||sameId(row.holding_id,t.holding_id))
     &&value!==null&&cash!==null&&abs(value)===abs(cash)
     &&(t.description_code==='BUY'?cash<0n:cash>0n);
   const canonical=canonicalById.get(id(t.id));
   const manual=manualPair({account,row,trade:t,targetDate,canonical,uniqueCanonical:canonical&&keyCounts.get(canonical.key)===1});
   if(native||old||manual){
    if(!byTrade.has(id(t.id)))byTrade.set(id(t.id),[]);byTrade.get(id(t.id)).push(id(row.id));
    if(!byCash.has(id(row.id)))byCash.set(id(row.id),[]);byCash.get(id(row.id)).push(id(t.id));
   }
  }
 }
 // Ambiguity is not resolved by ordering, same amount or a preferred format.
 const verified=new Map();
 for(const [tradeId,ids]of byTrade)if(ids.length===1&&byCash.get(ids[0])?.length===1
   &&relations.get(tradeId)?.length===1)verified.set(tradeId,ids[0]);
 return {cashForTrade:verified,tradeForCash:new Map([...verified].map(([t,c])=>[c,t])),relatedCash:relations};
}

