import test from 'node:test';
import assert from 'node:assert/strict';
import {fetchFlexArchive} from './flex_reader.mjs';
const secret='SYNTHETIC_PRIVATE_FLEX_CANARY', query='12345';
globalThis.fetch=()=>assert.fail('No live network');
const success='<FlexStatementResponse><Status>Success</Status><ReferenceCode>6789</ReferenceCode><Url>https://untrusted.invalid/</Url></FlexStatementResponse>';
test('one approved query request polls only its fixed accepted reference and never follows supplier URL',async()=>{
  const calls=[];let clock=0;
  const result=await fetchFlexArchive({token:secret,configuredQueryId:query,now:()=>clock,wait:async ms=>{clock+=ms;},
    fetchImpl:async(url,options)=>{calls.push({url:new URL(url),options});return new Response(calls.length===1?success:calls.length===2?'<FlexStatementResponse><Status>Fail</Status><ErrorCode>1019</ErrorCode><ErrorMessage>'+secret+'</ErrorMessage></FlexStatementResponse>':'<FlexQueryResponse><FlexStatements/></FlexQueryResponse>');}});
  assert.equal(result.requestedQueryId,query);assert.match(result.bytes,/FlexQueryResponse/);assert.equal(calls.length,3);
  assert.equal(calls[0].url.searchParams.get('q'),query);assert.equal(calls[1].url.searchParams.get('q'),'6789');assert.equal(calls[2].url.searchParams.get('q'),'6789');
  assert(calls.every(c=>c.url.origin==='https://ndcdyn.interactivebrokers.com'&&c.options.method==='GET'&&c.options.redirect==='error'));
  assert(calls.every(c=>c.options.headers['User-Agent']===`Node/${process.versions.node}`));
  assert.equal(calls.filter(c=>c.url.pathname.endsWith('SendRequest')).length,1);
});
test('unknown SendRequest outcome, invalid references and auth rejection never retry or leak token/body',async()=>{
  for(const make of [()=>{throw Error(secret);},()=>new Response(secret,{status:400}),
    ()=>new Response(success.replace('6789',secret)),()=>new Response(success.replace('<Status>Success</Status>','<Status>Success</Status><Status>Success</Status>'))]){
    let calls=0;await assert.rejects(fetchFlexArchive({token:secret,configuredQueryId:query,fetchImpl:async()=>{calls++;return make();}}),error=>{
      assert.match(error.message,/^FLEX_SOURCE_[A-Z_]+$/);assert(!error.message.includes(secret));return true;
    });assert.equal(calls,1);
  }
});
test('official timestamp roots and lowercase url remain bounded and never redirect',async()=>{
  for(const tag of ['Url','url']){
    const send=success.replace('<FlexStatementResponse>','<FlexStatementResponse timestamp="14 September, 2020 09:15 AM EST">').replaceAll('Url',tag);
    let calls=0;await fetchFlexArchive({token:secret,configuredQueryId:query,wait:async()=>{},fetchImpl:async(url)=>{calls++;assert.equal(new URL(url).origin,'https://ndcdyn.interactivebrokers.com');return new Response(calls===1?send:'<FlexQueryResponse><FlexStatements/></FlexQueryResponse>');}});
    assert.equal(calls,2);
  }
  await assert.rejects(fetchFlexArchive({token:secret,configuredQueryId:query,fetchImpl:async()=>new Response(success.replace('</Url>','</Url><url>https://untrusted.invalid/</url>'))}),/RESPONSE_INVALID/);
});
test('pending responses have a bounded total budget; foreign codes cannot authorize more polls',async()=>{
  for(const code of ['1019','9999']){
    let calls=0,clock=0;await assert.rejects(fetchFlexArchive({token:secret,configuredQueryId:query,now:()=>clock,wait:async ms=>{clock+=ms;},
      fetchImpl:async()=>{calls++;return new Response(calls===1?success:`<FlexStatementResponse><Status>Fail</Status><ErrorCode>${code}</ErrorCode></FlexStatementResponse>`);}}),/FLEX_SOURCE_(TIMEOUT|STATEMENT_REJECTED)/);
    assert.equal(calls,code==='9999'?2:25);assert(clock<150000);
  }
});
test('malformed credential/query configuration cannot create an outbound request',async()=>{
  for(const overrides of [{token:''},{token:secret+'\n'},{configuredQueryId:'../arbitrary'},{configuredQueryId:null}])
    await assert.rejects(fetchFlexArchive({token:secret,configuredQueryId:query,...overrides,fetchImpl:()=>assert.fail('No IO')}),/CONFIGURATION_REQUIRED/);
});
