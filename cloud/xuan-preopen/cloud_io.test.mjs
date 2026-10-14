import test from 'node:test';
import assert from 'node:assert/strict';
import {boundedText, privateCloudIo} from './cloud_io.mjs';

test('bounded responses reject oversized or invalid UTF-8 source bodies', async () => {
  await assert.rejects(boundedText(new Response('12345'), 4), /TOO_LARGE/);
  await assert.rejects(boundedText(new Response(new Uint8Array([0xff]))), /INVALID_UTF8/);
});
test('cloud IO only reads the two fixed credentials and saves the one IB credential', async () => {
  const urls = [];
  const fetchImpl = async (url, options) => {
    urls.push({url: String(url), options});
    if (String(url).startsWith('http://metadata.')) return Response.json({access_token: 'test-google-identity'});
    if (String(url).includes('family-portfolio-gateway-key')) return Response.json({payload: {data: Buffer.from('test-read-token').toString('base64')}});
    if (String(url).endsWith(':access')) return Response.json({payload: {data: Buffer.from('{"test":true}').toString('base64')}});
    return Response.json({name: 'projects/family-portfolio-gateway/secrets/xuan-preopen-ib-mcp/versions/15', state: 'ENABLED'});
  };
  const io = privateCloudIo({fetchImpl});
  assert.equal(await io.loadGatewayToken(), 'test-read-token'); assert.deepEqual(await io.ibStore.load(), {test: true});
  assert.deepEqual(await io.ibStore.save({test: true}),
    {name: 'projects/family-portfolio-gateway/secrets/xuan-preopen-ib-mcp/versions/15', state: 'ENABLED'});
  assert.equal(urls.filter(r => r.url.includes('metadata')).length, 1);
  assert.ok(urls.find(r => r.url.endsWith('xuan-preopen-ib-mcp:addVersion')).options.method === 'POST');
  assert.equal(urls.filter(r => r.url.endsWith(':addVersion')).length, 1);
});
test('private evidence uses immutable create-only upload and verifies object metadata', async () => {
  const requests = [], name = 'report-check/2026-09-30T05:00:00.000Z-id/report.html';
  const fetchImpl = async (url, options) => {
    if (String(url).includes('metadata.google')) return Response.json({access_token: 'test-google-identity'});
    requests.push({url: new URL(url), options});
    return Response.json({name, size: options.body.length, generation: '123'});
  };
  const io = privateCloudIo({fetchImpl}), result = await io.savePrivate(name, '<html>private</html>');
  assert.equal(result.generation, '123'); assert.match(result.sha256, /^[a-f0-9]{64}$/);
  assert.equal(requests[0].url.searchParams.get('ifGenerationMatch'), '0');
  assert.equal(requests[0].url.searchParams.get('name'), name);
  await assert.rejects(io.savePrivate('../report.html', 'invalid'), /PATH_INVALID/);
});
test('misrouted or incomplete upload metadata is not accepted', async () => {
  const fetchImpl = async url => String(url).includes('metadata.google') ? Response.json({access_token: 'test-google-identity'}) : Response.json({name: 'wrong-object', size: '1', generation: '1'});
  await assert.rejects(privateCloudIo({fetchImpl}).savePrivate('report-check/id/report.html', 'private'), /UPLOAD_NOT_CONFIRMED/);
});
test('B reads only its fixed Flex credential reference without token rotation or IB MCP access', async () => {
  const urls=[];
  const io=privateCloudIo({fetchImpl:async(url,options={})=>{
    urls.push({url:String(url),options});
    if(String(url).includes('metadata.google'))return Response.json({access_token:'SYNTHETIC_GOOGLE_TOKEN'});
    assert.equal(String(url),'https://secretmanager.googleapis.com/v1/projects/family-portfolio-gateway/secrets/ib-flex-cash-token/versions/1:access');
    return Response.json({payload:{data:Buffer.from('SYNTHETIC_FLEX_TOKEN').toString('base64')}});
  }});
  assert.equal(await io.loadFlexToken(),'SYNTHETIC_FLEX_TOKEN');assert.equal(urls.length,2);
  assert(urls.every(r=>!r.url.includes('xuan-preopen-ib-mcp')&&!r.url.includes(':addVersion')&&r.options.method!=='POST'));
});
test('parallel B credential reads share one metadata identity request and never rotate secrets',async()=>{
  const calls=[];const io=privateCloudIo({fetchImpl:async url=>{
    calls.push(String(url));
    if(String(url).includes('metadata.google')){await new Promise(resolve=>setImmediate(resolve));return Response.json({access_token:'SYNTHETIC_GOOGLE_TOKEN'});}
    return Response.json({payload:{data:Buffer.from('SYNTHETIC_READ_TOKEN').toString('base64')}});
  }});
  await Promise.all([io.loadFlexToken(),io.loadGatewayToken()]);
  assert.equal(calls.filter(url=>url.includes('metadata.google')).length,1);assert.equal(calls.length,3);
  assert(calls.some(url=>url.includes('ib-flex-cash-token/versions/1:access')));
  assert(calls.some(url=>url.includes('family-portfolio-gateway-key/versions/latest:access')));
  assert(calls.every(url=>!url.includes(':addVersion')));
});
