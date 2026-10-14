import test from 'node:test';
import assert from 'node:assert/strict';
import {fetchFlexArchive} from './flex_reader.mjs';
import {safeIbFailure} from './ib_diagnostics.mjs';
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

// Public IB version-3 envelope structures, with synthetic dates/reference,
// query/token and messages. No captured response or private payload fixture.
const archive='<FlexQueryResponse><FlexStatements/></FlexQueryResponse>';
const envelope=(fields,attribute='')=>`<FlexStatementResponse${attribute}>${fields}</FlexStatementResponse>`;
const acceptedFields='<Status>Success</Status><ReferenceCode>6789</ReferenceCode>';
const pendingFields='<Status>Fail</Status><ErrorCode>1019</ErrorCode>';
async function fixture(send,get=archive){
  const calls=[];let clock=0;
  try{
    const result=await fetchFlexArchive({token:secret,configuredQueryId:query,now:()=>clock,wait:async ms=>{clock+=ms;},fetchImpl:async(url,options)=>{
      calls.push({url:new URL(url),options});return typeof (calls.length===1?send:get)==='function'?(calls.length===1?send:get)():new Response(calls.length===1?send:get,{headers:{'content-type':'application/xml; charset=utf-8'}});
    }});
    return {result,calls,clock};
  }catch(error){return {failure:safeIbFailure(error),calls,clock};}
}
function safeOutput(value){
  const text=JSON.stringify(value);
  for(const forbidden of [secret,query,'6789','PRIVATE_MESSAGE_CANARY','untrusted.invalid','PRIVATE_HEADER_CANARY'])assert.equal(text.includes(forbidden),false);
}
const compatible=[
  ['single-quoted timestamp',envelope(acceptedFields," timestamp='synthetic timestamp'")],
  ['whitespace around timestamp equals',envelope(acceptedFields,' timestamp = "synthetic timestamp"')],
  ['empty optional Url',envelope(acceptedFields+'<Url />')],
  ['standard entities in ignored optional fields',envelope(acceptedFields+'<Url>https://untrusted.invalid/?a=1&amp;b=2</Url><ErrorMessage>&lt;&gt;&quot;&apos;&amp;&#65;&#x41;</ErrorMessage>')],
  ['BOM and XML declaration', '\ufeff<?xml version="1.0" encoding="UTF-8"?>\n'+envelope(acceptedFields)],
];
for(const [name,send] of compatible)test(`valid XML serialization: ${name}`,async()=>{
  const out=await fixture(send);assert.equal(out.failure,undefined);assert.equal(out.result.bytes,archive);assert.equal(out.calls.length,2);
  assert.equal(out.calls[1].url.searchParams.get('q'),'6789');assert(out.calls.every(c=>c.url.origin==='https://ndcdyn.interactivebrokers.com'&&c.options.redirect==='error'));
});
test('empty/escaped optional pending message does not change accepted reference or polling bounds',async()=>{
  for(const message of ['<ErrorMessage/>','<ErrorMessage>PRIVATE_MESSAGE_CANARY &amp; &#65;</ErrorMessage>']){
    let calls=0,clock=0;const out=await fetchFlexArchive({token:secret,configuredQueryId:query,now:()=>clock,wait:async ms=>{clock+=ms;},fetchImpl:async url=>{
      calls++;assert.equal(new URL(url).searchParams.get('q'),calls===1?query:'6789');return new Response(calls===1?success:calls===2?envelope(pendingFields+message):archive);
    }});assert.equal(out.bytes,archive);assert.equal(calls,3);assert.equal(clock,12400);
  }
});
test('public error-envelope structures retain exact phase and published numeric code without claiming expiry',async()=>{
  for(const [stage,code] of [['send',1012],['get',1015]]){
    const body=envelope(`<Status>Fail</Status><ErrorCode>${code}</ErrorCode><ErrorMessage>PRIVATE_MESSAGE_CANARY</ErrorMessage>`,' timestamp="synthetic timestamp"');
    const out=await fixture(stage==='send'?body:success,body);const d=out.failure;
    assert.equal(d.code,stage==='send'?'FLEX_SOURCE_REQUEST_REJECTED':'FLEX_SOURCE_STATEMENT_REJECTED');assert.equal(d.phase,stage==='send'?'flex_send_request':'flex_get_statement');
    assert.equal(d.category,'response_invalid');assert.equal(d.httpStatus,200);assert.equal(d.flex.sendCount,1);assert.equal(d.flex.getCount,stage==='send'?0:1);
    assert.equal(d.flex.statusShape,'fail');assert.equal(d.flex.errorCodeShape,'known');assert.equal(d.flex.upstreamErrorCode,code);safeOutput(d);
  }
});
test('unknown fields, aliases, attributes, namespaces, nesting, DTD and nonstandard entities fail closed without another Send',async()=>{
  const malformed=[
    envelope(acceptedFields+'<Unknown>PRIVATE_MESSAGE_CANARY</Unknown>'),
    envelope(acceptedFields+'<Url/><url/>'),
    envelope(acceptedFields+'<Status>Success</Status>'),
    envelope(acceptedFields,' extra="PRIVATE_MESSAGE_CANARY"'),
    envelope(acceptedFields,' xmlns="urn:PRIVATE_MESSAGE_CANARY"'),
    envelope('<Status a="PRIVATE_MESSAGE_CANARY">Success</Status><ReferenceCode>6789</ReferenceCode>'),
    envelope('<Nested>'+acceptedFields+'</Nested>'),
    '<!DOCTYPE FlexStatementResponse [<!ENTITY x SYSTEM "https://untrusted.invalid/">]>'+envelope(acceptedFields),
    envelope(acceptedFields+'<ErrorMessage><![CDATA[PRIVATE_MESSAGE_CANARY]]></ErrorMessage>'),
    envelope(acceptedFields+'<?foreign PRIVATE_MESSAGE_CANARY?>'),
    ...['&unknown;','&raw','&#0;','&#xD800;','&#x110000;'].map(entity=>envelope(acceptedFields+'<ErrorMessage>'+entity+'</ErrorMessage>')),
  ];
  for(const body of malformed){const out=await fixture(body);assert.equal(out.calls.length,1);assert.equal(out.failure.code,'FLEX_SOURCE_RESPONSE_INVALID');assert.equal(out.failure.flex.reason,'envelope_invalid');safeOutput(out.failure);}
});
test('2xx HTML/JSON and namespaced XML identify stage and closed shape without body/header values',async()=>{
  for(const [body,type,kind] of [['<html>PRIVATE_MESSAGE_CANARY</html>','text/html; PRIVATE_HEADER_CANARY','html'],['{"PRIVATE_MESSAGE_CANARY":true}','application/json; PRIVATE_HEADER_CANARY','json']]){
    for(const stage of ['send','get']){
      const out=await fixture(stage==='send'?()=>new Response(body,{status:202,headers:{'content-type':type}}):success,()=>new Response(body,{status:202,headers:{'content-type':type}}));
      assert.equal(out.failure.httpStatus,202);assert.equal(out.failure.flex.contentType,kind);assert.equal(out.failure.flex.rootKind,'other');assert.equal(out.failure.flex.getCount,stage==='send'?0:1);safeOutput(out.failure);
    }
  }
  const xml='<x:FlexStatementResponse xmlns:x="urn:PRIVATE_MESSAGE_CANARY"><x:Status>Fail</x:Status><x:ErrorCode>1015</x:ErrorCode></x:FlexStatementResponse>';
  const out=await fixture(success,xml);assert.equal(out.failure.flex.rootNamespacePresent,true);assert.equal(out.failure.flex.rootKind,'statement_response');assert.equal(out.failure.flex.statusShape,'qualified');assert.equal(out.failure.flex.errorCodeShape,'qualified');assert.equal(out.failure.flex.upstreamErrorCode,null);safeOutput(out.failure);
});
test('unreadable bodies expose only exact closed failure reason and successful HTTP class',async()=>{
  for(const [make,reason] of [
    [()=>new Response(null,{status:204}),'empty_body'],
    [()=>new Response(' \n\t '),'empty_body'],
    [()=>new Response(''),'empty_body'],
    [()=>new Response('x'.repeat(8_000_001)),'body_too_large'],
    [()=>new Response(Uint8Array.from([255,254])),'invalid_utf8'],
    [()=>new Response(new ReadableStream({start(c){c.error(Error('PRIVATE_MESSAGE_CANARY'));}})),'body_read_failed'],
  ]){for(const stage of ['send','get']){
    const out=await fixture(stage==='send'?make:success,make);assert.equal(out.failure.code,'FLEX_SOURCE_RESPONSE_INVALID');assert.equal(out.failure.flex.reason,reason);assert.equal(out.failure.flex.rootKind,'unavailable');assert.equal(out.failure.flex.getCount,stage==='send'?0:1);safeOutput(out.failure);
  }}
});
test('unknown network outcomes and HTTP rejection do not retry and diagnostics never serialize upstream',async()=>{
  for(const [make,code,category,status] of [
    [()=>{throw Error('PRIVATE_MESSAGE_CANARY');},'NETWORK_FAILED','network',null],
    [()=>{const e=Error('PRIVATE_MESSAGE_CANARY');e.name='TimeoutError';throw e;},'NETWORK_FAILED','timeout',null],
    [()=>new Response('PRIVATE_MESSAGE_CANARY',{status:403}),'HTTP_FAILED','permission_denied',403],
  ]){const out=await fixture(make);assert.equal(out.calls.length,1);assert.equal(out.failure.code,'FLEX_SOURCE_'+code);assert.equal(out.failure.category,category);assert.equal(out.failure.httpStatus,status);safeOutput(out.failure);}
});
test('diagnostic shape distinguishes duplicate/nested fields and unknown upstream codes',async()=>{
  for(const [body,field,expected] of [
    [envelope('<Status>Fail</Status><Status>Success</Status>'),'statusShape','ambiguous'],
    [envelope('<Nested><Status>Fail</Status></Nested>'),'statusShape','nested'],
    [envelope('<Status a="PRIVATE_MESSAGE_CANARY">Fail</Status>'),'statusShape','attribute'],
    [envelope('<Status>Fail</Status><ErrorCode>9999</ErrorCode>'),'errorCodeShape','unrecognized'],
  ]){const out=await fixture(body);assert.equal(out.failure.flex[field],expected);assert.equal(out.failure.flex.upstreamErrorCode,null);safeOutput(out.failure);}
  for(const value of ['constructor','toString','__proto__']){
    const out=await fixture(envelope(`<Status>${value}</Status><ReferenceCode>6789</ReferenceCode>`));
    assert.equal(out.failure.code,'FLEX_SOURCE_REQUEST_REJECTED');assert.equal(out.failure.flex.statusShape,'noncanonical');assert.equal(out.failure.flex.sendCount,1);assert.equal(out.failure.flex.getCount,0);safeOutput(out.failure);
  }
});
test('timeout diagnostics preserve one Send and at most 24 same-reference Get invocations',async()=>{
  const out=await fixture(success,envelope(pendingFields));assert.equal(out.failure.code,'FLEX_SOURCE_TIMEOUT');assert.equal(out.failure.flex.sendCount,1);assert.equal(out.failure.flex.getCount,24);assert.equal(out.calls.length,25);assert(out.clock<150_000);assert(out.calls.slice(1).every(c=>c.url.searchParams.get('q')==='6789'));safeOutput(out.failure);
});
