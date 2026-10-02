// Schema-only shadow diagnostic. Credentials stay in the original cloud runtime.
// Never refresh/rotate them, call a financial tool, load Sharesight, or publish.
import crypto from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {IbReadSession,validateCredential} from './ib_mcp.mjs';
import {privateCloudIo} from './cloud_io.mjs';
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = code => {throw new Error(code);};
export async function inspectIbSchema({io,now=Date.now,fetchImpl=fetch}={}) {
  if (!io?.ibStore?.load || !io.savePrivate) fail('SCHEMA_ORIGINAL_RUNTIME_REQUIRED');
  const credential=validateCredential(await io.ibStore.load());
  if (credential.expires_at <= now()+120000) fail('SCHEMA_CREDENTIAL_EXPIRED_NO_REFRESH');
  const session=new IbReadSession(credential,{fetchImpl,schemaOnly:true});
  await session.initialize();
  const pages=[],tools=[],cursors=new Set();let cursor;
  for(let page=0;page<8;page++) {
    const result=await session.request('tools/list',cursor?{cursor}:undefined);
    if(!Array.isArray(result?.tools)||result.tools.length>500) fail('SCHEMA_TOOLS_INVALID');
    if(result.tools.some(t=>!t||typeof t.name!=='string'||!/^[A-Za-z0-9_.-]{1,160}$/.test(t.name))) fail('SCHEMA_TOOL_NAME_INVALID');
    pages.push(result);tools.push(...result.tools);
    if(!result.nextCursor)break;
    if(typeof result.nextCursor!=='string'||result.nextCursor.length>4096||cursors.has(result.nextCursor)) fail('SCHEMA_PAGINATION_INCOMPLETE');
    cursors.add(result.nextCursor);cursor=result.nextCursor;
    if(page===7) fail('SCHEMA_PAGINATION_BUDGET');
  }
  if(new Set(tools.map(t=>t.name)).size!==tools.length)fail('SCHEMA_DUPLICATE_TOOL');
  const relevant=tools.filter(t=>/^(get_account_(summary|positions|balances|orders|trades)|get_(orders|trades|accounts))$/.test(t.name));
  const summarize=t=>({name:t.name,inputProperties:Object.keys(t.inputSchema?.properties||{}),
    required:t.inputSchema?.required||[],outputProperties:Object.keys(t.outputSchema?.properties||{}),
    schemaSha256:hash(t),declaresAllPositions:/\ball\s+(?:open\s+)?positions\b/i.test(t.description||''),
    descriptionMentionsPagination:/pagin|cursor|offset|limit|truncat/i.test(t.description||''),
    descriptionMentionsAsOf:/as.of|snapshot|timestamp/i.test(t.description||'')});
  const prefix=`report-check/${new Date(now()).toISOString()}-schema-${crypto.randomUUID()}/`;
  const artifact={privateObject:prefix+'schema.json',...await io.savePrivate(prefix+'schema.json',{pages})};
  const receipt={status:'schema-captured',mode:'schema-only',pageCount:pages.length,totalToolCount:tools.length,
    relevantTools:relevant.map(summarize),artifact,financialReads:0,financialMutations:0,
    credentialMutations:0,publication:'none',scheduler:'none',checkedAt:new Date(now()).toISOString()};
  await io.savePrivate(prefix+'receipt.json',receipt);
  return receipt;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    if(process.argv.slice(2).join(' ')!=='--schema-check')fail('SCHEMA_CHECK_ONLY');
    const receipt=await inspectIbSchema({io:privateCloudIo()});
    process.stdout.write(JSON.stringify(receipt)+'\n');
  }catch(error){
    const code=/^[A-Z_0-9]+$/.test(error.message||'')?error.message:'SCHEMA_CHECK_FAILED';
    process.stdout.write(JSON.stringify({status:'failed',code,financialReads:0,publication:'none'})+'\n');process.exitCode=1;
  }
}
