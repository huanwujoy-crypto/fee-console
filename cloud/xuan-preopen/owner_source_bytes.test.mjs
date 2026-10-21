// Synthetic fetch and byte streams only. No SDK, credentials or network.
import test from 'node:test';
import assert from 'node:assert/strict';
import {ownerSourceFetch,withOwnerSourceByteReuse,withOwnerPublicationReads} from './owner_source_bytes.mjs';

const A='a'.repeat(40),B='b'.repeat(40),C='c'.repeat(40);
const RAW='https://raw.githubusercontent.com/huanwujoy-crypto/fee-console/';
const API='https://api.github.com/repos/huanwujoy-crypto/fee-console/';
const PATHS=[
  'claude/xuan-ib-account-association-v1.json',
  'claude/xuan-ib-etf-pending-calls-v1.json',
  'xuan-ib/latest.meta.json','xuan-ib/latest.html',
  'security/xuan-owner-accepted-preview.json',
  'security/xuan-owner-preview-replacement.json',
  'security/xuan-owner-registered-canary.json',
];
const raw=(sha=A,file='xuan-ib/latest.html')=>RAW+sha+'/'+file;
const compare=(base=A,head=B)=>API+'compare/'+base+'...'+head;
const opts=extra=>({redirect:'error',...extra});
const utf8=value=>new TextEncoder().encode(value);
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const read=async(url,options=opts())=>new Uint8Array(await (await ownerSourceFetch(url,options)).arrayBuffer());
const text=async(url,options=opts())=>new TextDecoder().decode(await read(url,options));
async function stubFetch(impl,work){
  const original=globalThis.fetch;globalThis.fetch=impl;
  try{return await work();}finally{globalThis.fetch=original;}
}
function monitoredAbort(){
  const controller=new AbortController(),signal=controller.signal,active=new Set();
  const add=signal.addEventListener.bind(signal),remove=signal.removeEventListener.bind(signal);
  const counts={adds:0,removes:0,active};
  signal.addEventListener=(type,listener,options)=>{
    if(type==='abort'){counts.adds++;active.add(listener);}
    return add(type,listener,options);
  };
  signal.removeEventListener=(type,listener,options)=>{
    if(type==='abort'){counts.removes++;active.delete(listener);}
    return remove(type,listener,options);
  };
  return {controller,signal,counts};
}

test('only successful allowlisted fixed-commit bytes are reused within a scope',async()=>{
  const calls=[];
  await stubFetch(async(url,options)=>{calls.push([url,options]);return new Response('synthetic '+url);},async()=>{
    await withOwnerSourceByteReuse(async()=>{
      for(const url of [...PATHS.map(file=>raw(A,file)),compare()]){
        const expected='synthetic '+url;
        assert.equal(await text(url),expected);assert.equal(await text(url),expected);
      }
    });
  });
  assert.equal(calls.length,PATHS.length+1);
  assert.ok(calls.every(([,options])=>options.redirect==='error'));
});

test('cache hits have independent bodies and preserve exact bytes, status and headers',async()=>{
  let calls=0;
  // Includes a UTF-8 BOM, multibyte text, CRLF and whitespace that JSON/string
  // reconstruction must not remove or normalize.
  const bytes=Uint8Array.from([239,187,191,...utf8('{ "内容" : "元" }\r\n ')]);
  await stubFetch(async()=>{calls++;return new Response(bytes,{status:200,statusText:'Synthetic OK',headers:{'content-type':'application/json; charset=utf-8','x-synthetic':'original'}});},async()=>{
    await withOwnerSourceByteReuse(async()=>{
      assert.deepEqual(await read(raw()),bytes);
      const first=await ownerSourceFetch(raw(),opts()),second=await ownerSourceFetch(raw(),opts());
      assert.notEqual(first,second);assert.notEqual(first.body,second.body);
      for(const response of [first,second]){
        assert.equal(response.status,200);assert.equal(response.statusText,'Synthetic OK');
        assert.equal(response.headers.get('x-synthetic'),'original');
        assert.equal(response.headers.get('content-type'),'application/json; charset=utf-8');
      }
      first.headers.set('x-synthetic','caller change');
      assert.equal(second.headers.get('x-synthetic'),'original');
      const mutated=new Uint8Array(await first.arrayBuffer());mutated.fill(0);
      assert.deepEqual(new Uint8Array(await second.arrayBuffer()),bytes);
      assert.deepEqual(await read(raw()),bytes);
    });
  });
  assert.equal(calls,1);
});

test('no scope, a completed scope and separate scopes never share stored bytes',async()=>{
  let calls=0;
  await stubFetch(async()=>new Response('version '+(++calls)),async()=>{
    assert.equal(await text(raw()),'version 1');assert.equal(await text(raw()),'version 2');
    await withOwnerSourceByteReuse(async()=>{assert.equal(await text(raw()),'version 3');assert.equal(await text(raw()),'version 3');});
    assert.equal(await text(raw()),'version 4');
    await withOwnerSourceByteReuse(async()=>{assert.equal(await text(raw()),'version 5');assert.equal(await text(raw()),'version 5');});
  });
  assert.equal(calls,5);
});

test('main, mutable or wrong-origin routes and unsafe request options always fetch',async()=>{
  let calls=0;
  const passthrough=[
    [API+'commits/main',opts()],
    [RAW+'main/xuan-ib/latest.html',opts()],
    [raw(A.toUpperCase()),opts()],
    [raw(A.slice(0,39)),opts()],
    [raw(A,'security/xuan-owner-approved-audience.json'),opts()],
    [raw()+'?cache=seed',opts()],
    [raw()+'#fragment',opts()],
    [raw().replace('fee-console/','other-repository/'),opts()],
    [raw().replace('https://','http://'),opts()],
    [raw().replace('raw.githubusercontent.com','raw.githubusercontent.com.example.invalid'),opts()],
    [compare().replace('...','..'),opts()],
    [compare(A,'main'),opts()],
    [compare()+'?per_page=1',opts()],
    [raw(),opts({headers:{Authorization:'Bearer SYNTHETIC'}})],
    [raw(),opts({headers:{accept:'application/json'}})],
    [raw(),opts({method:'HEAD'})],
    [raw(),opts({method:'POST',body:'synthetic'})],
    [raw(),opts({body:''})],
    [raw(),opts({credentials:'include'})],
    [raw(),opts({redirect:'follow'})],
    [raw(),opts({redirect:'manual'})],
  ];
  await stubFetch(async()=>new Response('live '+(++calls)),async()=>{
    await withOwnerSourceByteReuse(async()=>{
      for(const [url,options] of passthrough){
        const before=calls;assert.equal(await text(url,options),'live '+(before+1));
        assert.equal(await text(url,options),'live '+(before+2));assert.equal(calls,before+2);
      }
    });
  });
  assert.equal(calls,2*passthrough.length);
});

test('head, file path and ordered compare pair are separate cache keys',async()=>{
  let calls=0;
  const urls=[raw(A),raw(B),raw(A,'xuan-ib/latest.meta.json'),compare(A,B),compare(B,A),compare(A,C)];
  await stubFetch(async()=>new Response('bytes '+(++calls)),async()=>{
    await withOwnerSourceByteReuse(async()=>{
      const originals=[];
      for(const url of urls)originals.push(await text(url));
      for(let index=0;index<urls.length;index++)assert.equal(await text(urls[index]),originals[index]);
    });
  });
  assert.equal(calls,urls.length);
});

test('immutable bytes stay original in a scope while live main changes or is revoked',async()=>{
  let mainReads=0,rawReads=0;
  await stubFetch(async url=>{
    if(url.endsWith('/commits/main')){
      mainReads++;return mainReads===3?new Response('revoked',{status:403}):new Response(JSON.stringify({sha:mainReads===1?A:B}));
    }
    rawReads++;return new Response('original bytes '+rawReads);
  },async()=>{
    await withOwnerSourceByteReuse(async()=>{
      assert.deepEqual(JSON.parse(await text(API+'commits/main')),{sha:A});
      assert.equal(await text(raw(A)),'original bytes 1');
      assert.deepEqual(JSON.parse(await text(API+'commits/main')),{sha:B});
      assert.equal(await text(raw(B)),'original bytes 2');
      assert.equal(await text(raw(A)),'original bytes 1');
      const revoked=await ownerSourceFetch(API+'commits/main',opts());
      assert.equal(revoked.status,403);assert.equal(await revoked.text(),'revoked');
    });
  });
  assert.equal(mainReads,3);assert.equal(rawReads,2);
});

test('fetch rejection, HTTP rejection, partial and redirected responses are not cached',async()=>{
  const failure=Object.assign(new TypeError('synthetic transport'),{cause:{code:'ETIMEDOUT'}});
  const cases=[
    async()=>{throw failure;},
    async()=>new Response('not found',{status:404}),
    async()=>new Response('unavailable',{status:503}),
    async()=>new Response('partial',{status:206,headers:{'content-range':'bytes 0-6/10'}}),
    async()=>new Response('unexpected partial',{headers:{'content-range':'bytes 0-17/18'}}),
    async()=>{const response=new Response('redirected');Object.defineProperty(response,'redirected',{value:true});return response;},
    async()=>{const response=new Response('wrong final URL');Object.defineProperty(response,'url',{value:raw(B)});return response;},
  ];
  for(const makeResponse of cases){
    let calls=0;
    await stubFetch(async()=>{calls++;if(calls===1)return makeResponse();return new Response('recovered');},async()=>{
      await withOwnerSourceByteReuse(async()=>{
        try{await text(raw());}catch(error){assert.equal(error,failure);}
        assert.equal(await text(raw()),'recovered');assert.equal(await text(raw()),'recovered');
      });
    });
    assert.equal(calls,2);
  }
});

test('body failure stays a body failure and an unfinished or cancelled body is not cached',async()=>{
  const bodyFailure=Object.assign(new TypeError('synthetic body failure'),{code:'UND_ERR_BODY_TIMEOUT'});
  for(const mode of ['body-error','unread','cancel-after-partial']){
    let calls=0,bodyErrorController;
    await stubFetch(async()=>{
      calls++;
      if(calls>1)return new Response('complete');
      return new Response(new ReadableStream({start(controller){bodyErrorController=controller;controller.enqueue(utf8('partial'));}}));
    },async()=>{
      await withOwnerSourceByteReuse(async()=>{
        // The wrapper must return before reading a body, preserving the caller's
        // fetch-vs-bounded-body error classification.
        const response=await ownerSourceFetch(raw(),opts());
        if(mode==='body-error'){
          bodyErrorController.error(bodyFailure);
          await assert.rejects(response.arrayBuffer(),error=>error===bodyFailure);
        }else if(mode==='unread')await response.body.cancel();
        else{const reader=response.body.getReader();assert.equal(new TextDecoder().decode((await reader.read()).value),'partial');await reader.cancel();}
        assert.equal(await text(raw()),'complete');assert.equal(await text(raw()),'complete');
      });
    });
    assert.equal(calls,2);
  }
});

test('invalid or truncated UTF-8 is passed through byte-for-byte but never stored',async()=>{
  for(const bytes of [Uint8Array.of(0xff),Uint8Array.of(0xe5,0x85),Uint8Array.of(0xc0,0xaf)]){
    let calls=0;
    await stubFetch(async()=>{calls++;return new Response(bytes);},async()=>{
      await withOwnerSourceByteReuse(async()=>{assert.deepEqual(await read(raw()),bytes);assert.deepEqual(await read(raw()),bytes);});
    });
    assert.equal(calls,2);
  }
});

test('UTF-8 split across chunks is reusable only after the whole body completes',async()=>{
  let calls=0;
  const bytes=utf8('A元B');
  await stubFetch(async()=>{
    calls++;return new Response(new ReadableStream({start(controller){controller.enqueue(bytes.subarray(0,2));controller.enqueue(bytes.subarray(2,3));controller.enqueue(bytes.subarray(3));controller.close();}}));
  },async()=>{
    await withOwnerSourceByteReuse(async()=>{assert.deepEqual(await read(raw()),bytes);assert.deepEqual(await read(raw()),bytes);});
  });
  assert.equal(calls,1);
});

test('an already aborted cache hit rejects without replacing or refetching bytes',async()=>{
  let calls=0;
  await stubFetch(async()=>{calls++;return new Response('original');},async()=>{
    await withOwnerSourceByteReuse(async()=>{
      assert.equal(await text(raw()),'original');
      const signal=AbortSignal.abort(new DOMException('synthetic abort','AbortError'));
      await assert.rejects(ownerSourceFetch(raw(),opts({signal})),error=>error===signal.reason);
      assert.equal(await text(raw()),'original');
    });
  });
  assert.equal(calls,1);
});

test('aborting a returned cache-hit response before consumption fails its body',async()=>{
  let calls=0;
  await stubFetch(async()=>{calls++;return new Response('original');},async()=>{
    await withOwnerSourceByteReuse(async()=>{
      assert.equal(await text(raw()),'original');
      const abort=new AbortController(),response=await ownerSourceFetch(raw(),opts({signal:abort.signal}));
      const reason=new DOMException('synthetic late abort','AbortError');abort.abort(reason);
      await assert.rejects(response.arrayBuffer(),error=>error===reason);
    });
  });
  assert.equal(calls,1);
});

test('a successful cache-hit EOF removes its abort listener',async()=>{
  let calls=0;
  await stubFetch(async()=>{calls++;return new Response('original');},async()=>{
    await withOwnerSourceByteReuse(async()=>{
      assert.equal(await text(raw()),'original');
      const {controller,signal,counts}=monitoredAbort();
      const response=await ownerSourceFetch(raw(),opts({signal}));
      assert.equal(counts.adds,1);assert.equal(counts.removes,0);assert.equal(counts.active.size,1);
      assert.equal(await response.text(),'original');
      assert.equal(counts.removes,1);assert.equal(counts.active.size,0);
      controller.abort(new DOMException('after completed EOF','AbortError'));
      assert.equal(counts.removes,1);
    });
  });
  assert.equal(calls,1);
});

test('cancelling a cache-hit reader removes its abort listener before or after its first chunk',async()=>{
  let calls=0;
  await stubFetch(async()=>{calls++;return new Response('original');},async()=>{
    await withOwnerSourceByteReuse(async()=>{
      assert.equal(await text(raw()),'original');
      for(const readFirst of [false,true]){
        const {controller,signal,counts}=monitoredAbort();
        const reader=(await ownerSourceFetch(raw(),opts({signal}))).body.getReader();
        assert.equal(counts.adds,1);assert.equal(counts.active.size,1);
        if(readFirst){
          const first=await reader.read();assert.equal(first.done,false);
          assert.equal(new TextDecoder().decode(first.value),'original');
          assert.equal(counts.removes,0);assert.equal(counts.active.size,1);
        }
        await reader.cancel('synthetic caller cancellation');
        assert.equal(counts.removes,1);assert.equal(counts.active.size,0);
        controller.abort(new DOMException('after cancellation','AbortError'));
        assert.equal(counts.removes,1);
      }
    });
  });
  assert.equal(calls,1);
});

test('aborting a cache hit removes its abort listener and preserves the abort reason',async()=>{
  let calls=0;
  await stubFetch(async()=>{calls++;return new Response('original');},async()=>{
    await withOwnerSourceByteReuse(async()=>{
      assert.equal(await text(raw()),'original');
      const {controller,signal,counts}=monitoredAbort();
      const response=await ownerSourceFetch(raw(),opts({signal}));
      assert.equal(counts.adds,1);assert.equal(counts.removes,0);assert.equal(counts.active.size,1);
      const reason=new DOMException('synthetic body abort','AbortError');controller.abort(reason);
      await assert.rejects(response.arrayBuffer(),error=>error===reason);
      assert.equal(counts.removes,1);assert.equal(counts.active.size,0);
    });
  });
  assert.equal(calls,1);
});

test('a cache hit aborted after its first chunk rejects before EOF and cleans its listener',async()=>{
  let calls=0;
  await stubFetch(async()=>{calls++;return new Response('original');},async()=>{
    await withOwnerSourceByteReuse(async()=>{
      assert.equal(await text(raw()),'original');
      const {controller,signal,counts}=monitoredAbort();
      const reader=(await ownerSourceFetch(raw(),opts({signal}))).body.getReader();
      const closed=reader.closed.then(()=>({closed:true}),error=>({error}));
      const first=await reader.read();assert.equal(first.done,false);
      assert.equal(new TextDecoder().decode(first.value),'original');
      assert.equal(counts.removes,0);assert.equal(counts.active.size,1);
      const reason=new DOMException('abort between chunk and EOF','AbortError');controller.abort(reason);
      await assert.rejects(reader.read(),error=>error===reason);
      assert.equal((await closed).error,reason);
      assert.equal(counts.adds,1);assert.equal(counts.removes,1);assert.equal(counts.active.size,0);
    });
  });
  assert.equal(calls,1);
});

test('a request aborted or timed out before body completion cannot seed later reads',async()=>{
  for(const timeout of [false,true]){
    let calls=0,finish,cancelled=false;
    await stubFetch(async()=>{
      calls++;
      if(calls>1)return new Response('fresh');
      return new Response(new ReadableStream({start(controller){controller.enqueue(utf8('before'));finish=()=>{if(!cancelled){controller.enqueue(utf8(' after'));controller.close();}};},cancel(){cancelled=true;}}));
    },async()=>{
      await withOwnerSourceByteReuse(async()=>{
        const abort=new AbortController(),signal=timeout?AbortSignal.timeout(1):abort.signal;
        const response=await ownerSourceFetch(raw(),opts({signal})),body=response.arrayBuffer().then(value=>({value}),error=>({error}));
        if(timeout)await new Promise(resolve=>setTimeout(resolve,10));
        else abort.abort(new DOMException('synthetic abort','AbortError'));
        assert.equal(signal.aborted,true);finish();
        // A stub does not implement native fetch's body abort. Whether the
        // wrapper aborts or passes those final bytes, it must never cache them.
        await body;
        assert.equal(await text(raw()),'fresh');assert.equal(await text(raw()),'fresh');
      });
    });
    assert.equal(calls,2);
  }
});

test('a body completing after scope closure cannot seed inherited late work',async()=>{
  let calls=0,response,finish,late;
  const release=deferred();
  await stubFetch(async()=>{
    calls++;
    if(calls>1)return new Response('late '+calls);
    return new Response(new ReadableStream({start(controller){controller.enqueue(utf8('before'));finish=()=>{controller.enqueue(utf8(' after'));controller.close();};}}));
  },async()=>{
    await withOwnerSourceByteReuse(async()=>{
      response=await ownerSourceFetch(raw(),opts());
      late=(async()=>{await release.promise;await assert.rejects(text(raw()),/OWNER_SOURCE_SCOPE_CLOSED/);await assert.rejects(text(raw()),/OWNER_SOURCE_SCOPE_CLOSED/);})();
    });
    const body=response.arrayBuffer();finish();assert.equal(new TextDecoder().decode(await body),'before after');
    release.resolve();await late;
  });
  assert.equal(calls,1);
});

test('throwing out of a scope closes it before inherited asynchronous work runs',async()=>{
  let calls=0,late;
  const release=deferred(),failure=new Error('synthetic callback failure');
  await stubFetch(async()=>new Response('fetch '+(++calls)),async()=>{
    await assert.rejects(withOwnerSourceByteReuse(async()=>{
      assert.equal(await text(raw()),'fetch 1');
      late=(async()=>{await release.promise;await assert.rejects(text(raw()),/OWNER_SOURCE_SCOPE_CLOSED/);await assert.rejects(text(raw()),/OWNER_SOURCE_SCOPE_CLOSED/);})();
      throw failure;
    }),error=>error===failure);
    release.resolve();await late;
  });
  assert.equal(calls,1);
});

test('concurrent scopes and nested scopes retain independent byte maps',async()=>{
  let calls=0;
  const firstReady=deferred(),secondReady=deferred();
  await stubFetch(async()=>new Response('scope '+(++calls)),async()=>{
    await Promise.all([
      withOwnerSourceByteReuse(async()=>{
        assert.equal(await text(raw()),'scope 1');firstReady.resolve();await secondReady.promise;
        assert.equal(await text(raw()),'scope 1');
      }),
      (async()=>{await firstReady.promise;await withOwnerSourceByteReuse(async()=>{
        assert.equal(await text(raw()),'scope 2');secondReady.resolve();assert.equal(await text(raw()),'scope 2');
      });})(),
    ]);
    await withOwnerSourceByteReuse(async()=>{
      assert.equal(await text(raw()),'scope 3');
      await withOwnerSourceByteReuse(async()=>{assert.equal(await text(raw()),'scope 4');assert.equal(await text(raw()),'scope 4');});
      assert.equal(await text(raw()),'scope 3');
    });
  });
  assert.equal(calls,4);
});

test('the scope accepts only a callback and rejects caller seed, clock or context overrides',async()=>{
  let calls=0;
  await stubFetch(async()=>{calls++;return new Response('network fixture');},async()=>{
    for(const args of [[],[{}],[async()=>{},{}],[async()=>{},{seed:new Map([[raw(),'forged']]),clock:()=>0,fetch:()=>new Response('forged'),context:{approved:true}}]]){
      await assert.rejects(withOwnerSourceByteReuse(...args));
    }
    await withOwnerSourceByteReuse(async()=>{assert.equal(await text(raw()),'network fixture');});
  });
  assert.equal(calls,1);
});

test('per-object limits pass oversized bytes through but never retain them',async()=>{
  for(const [url,limit] of [[raw(),8_000_000],[raw(A,'security/xuan-owner-accepted-preview.json'),500000],[compare(),2*1024*1024]]){
    let calls=0;
    const oversized=new Uint8Array(limit+1).fill(120);
    await stubFetch(async()=>{calls++;return new Response(oversized);},async()=>{
      await withOwnerSourceByteReuse(async()=>{assert.equal((await read(url)).length,limit+1);assert.equal((await read(url)).length,limit+1);});
    });
    assert.equal(calls,2);
  }
});

test('the entry cap does not evict earlier bytes or cache additional entries',async()=>{
  let calls=0;
  const urls=Array.from({length:17},(_,index)=>raw((index+1).toString(16).padStart(40,'0')));
  await stubFetch(async()=>new Response('object '+(++calls)),async()=>{
    await withOwnerSourceByteReuse(async()=>{
      for(const url of urls)await text(url);
      assert.equal(calls,17);assert.equal(await text(urls[0]),'object 1');
      assert.equal(await text(urls[16]),'object 18');
    });
  });
  assert.equal(calls,18);
});

test('the total byte cap fails open to fetch without evicting cached objects',async()=>{
  let calls=0;
  const bytes=new Uint8Array(6_000_000).fill(120);
  await stubFetch(async()=>{calls++;return new Response(bytes);},async()=>{
    await withOwnerSourceByteReuse(async()=>{
      for(const sha of [A,B,C])assert.equal((await read(raw(sha))).length,bytes.length);
      assert.equal(calls,3);
      assert.equal((await read(raw(A))).length,bytes.length);assert.equal(calls,3);
      assert.equal((await read(raw(C))).length,bytes.length);assert.equal(calls,4);
    });
  });
});


test('publication tolerates one immutable transport timeout without caching main or retrying private calls',async()=>{
  const signal=AbortSignal.timeout(10000);let attempts=0;
  await stubFetch(async(url,options)=>{assert.equal(options.signal,signal);if(++attempts===1)throw Object.assign(new TypeError('PRIVATE'),{cause:{code:'ETIMEDOUT'}});return new Response('verified bytes');},()=>withOwnerPublicationReads(async()=>{
    assert.equal(await text(raw(),opts({signal})),'verified bytes');assert.equal(await text(raw(),opts({signal})),'verified bytes');
  }));assert.equal(attempts,2);
  for(const url of [API+'commits/main','https://storage.googleapis.com/PRIVATE',raw()]){
    let calls=0;await stubFetch(async()=>{calls++;throw Object.assign(new TypeError('PRIVATE'),{cause:{code:'ETIMEDOUT'}});},()=>withOwnerPublicationReads(async()=>{await assert.rejects(text(url,opts({signal})));}));
    assert.equal(calls,url===raw()?2:1);
  }
});
test('publication retry budget is shared, never renews abort deadline and does not retry HTTP/TLS/body failures',async()=>{
  let calls=0;const ac=new AbortController();
  await stubFetch(async()=>{calls++;if(calls===1){ac.abort();throw Object.assign(Error('PRIVATE'),{cause:{code:'ETIMEDOUT'}});}assert.fail();},()=>withOwnerPublicationReads(()=>assert.rejects(text(raw(),opts({signal:ac.signal})))));assert.equal(calls,1);
  for(const error of [Object.assign(Error('PRIVATE'),{code:'CERT_HAS_EXPIRED'}),Error('PRIVATE')]){
    calls=0;await stubFetch(async()=>{calls++;throw error;},()=>withOwnerPublicationReads(()=>assert.rejects(text(raw()))));assert.equal(calls,1);
  }
  calls=0;await stubFetch(async()=>{calls++;return new Response('PRIVATE',{status:503});},()=>withOwnerPublicationReads(async()=>{assert.equal((await ownerSourceFetch(raw(),opts())).status,503);}));assert.equal(calls,1);
  calls=0;await stubFetch(async()=>{calls++;throw Object.assign(Error('PRIVATE'),{cause:{code:'ETIMEDOUT'}});},()=>withOwnerPublicationReads(async()=>{await assert.rejects(text(raw(A),opts({signal:AbortSignal.timeout(10000)})));await assert.rejects(text(raw(B),opts({signal:AbortSignal.timeout(10000)})));}));assert.equal(calls,3);
});

test('a transport failure without an original abort deadline never gets another request',async()=>{
  let calls=0;await stubFetch(async()=>{calls++;throw Object.assign(Error('PRIVATE'),{cause:{code:'ETIMEDOUT'}});},()=>withOwnerPublicationReads(()=>assert.rejects(text(raw()))));assert.equal(calls,1);
});
