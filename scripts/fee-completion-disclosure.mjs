export const SCHWAB_CASH_DISCLOSURE='嘉信现金未独立核对';
export function buildCashDisclosure(bindings,targetDate){
 const schwab=bindings.find(x=>x.broker==='schwab');
 if(!schwab||schwab.independentCashVerified!==false)return undefined;
 return {targetDate,schwabIndependentCashVerified:false,valuationFinality:'ESTIMATED',message:SCHWAB_CASH_DISCLOSURE};
}
export function validCashDisclosure(value,targetDate){
 return value&&Object.keys(value).sort().join()==='message,schwabIndependentCashVerified,targetDate,valuationFinality'&&value.targetDate===targetDate&&value.schwabIndependentCashVerified===false&&value.valuationFinality==='ESTIMATED'&&value.message===SCHWAB_CASH_DISCLOSURE;
}
export function assertCashDisclosure(health,bindings){
 const expected=buildCashDisclosure(bindings,health.targetDate);
 if(expected?!validCashDisclosure(health.brokerCashDisclosure,health.targetDate):Object.hasOwn(health,'brokerCashDisclosure'))throw Error('FEE_COMPLETION_CASH_DISCLOSURE');
}
