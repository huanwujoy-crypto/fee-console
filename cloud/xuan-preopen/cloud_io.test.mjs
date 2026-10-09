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
    return Response.json({name: 'version'});
  };
  const io = privateCloudIo({fetchImpl});
  assert.equal(await io.loadGatewayToken(), 'test-read-token'); assert.deepEqual(await io.ibStore.load(), {test: true});
  await io.ibStore.save({test: true});
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

test('ledger readback exposes only create-only HTML/receipt under computed delivery evidence prefix, never raw sources or arbitrary subpaths',async()=>{
 const names=[],fetchImpl=async(url,options)=>{
  if(String(url).includes('metadata.google'))return Response.json({access_token:'synthetic-google'});
  const u=new URL(url),name=u.searchParams.get('name');names.push(name);assert.equal(u.searchParams.get('ifGenerationMatch'),'0');
  return Response.json({name,size:options.body.length,generation:'1'});
 };
 const io=privateCloudIo({fetchImpl}),prefix='delivery/2026-10-09/ledger-view-'+ 'a'.repeat(64)+'/';
 await io.savePrivate(prefix+'report.html','synthetic');await io.savePrivate(prefix+'receipt.json',{status:'partial'});
 for(const suffix of ['source.json','start.json','../receipt.json','nested/report.html'])await assert.rejects(io.savePrivate(prefix+suffix,'invalid'),/PATH_INVALID/);
 await assert.rejects(io.savePrivate(prefix.replace('a'.repeat(64),'short')+'report.html','invalid'),/PATH_INVALID/);assert.equal(names.length,2);
});
