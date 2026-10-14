// Production B composition. Explicitly no IB realtime/OAuth fallback.
import crypto from 'node:crypto';
import {APPROVED_IB_ACCOUNT_ID} from '../../scripts/xuan-ib-run-manifest.mjs';
import {validateAssociationSnapshot} from '../../scripts/xuan-ib-account-association.mjs';
import {EOD_SOURCE_CONFIG, validateEodSourceConfiguration} from './eod_source_config.mjs';
import {fetchFlexArchive} from './flex_reader.mjs';
import {createEodArchiveAdapters, createEodSnapshotReader} from './eod_adapters.mjs';
import {adaptFlexArchive, digest} from './eod_sources.mjs';
import {runPrivateEodReport,validateCompletedEodSession} from './eod_report.mjs';
import {loadTrustedContext, readSharesightAction} from './report.mjs';
export async function runEodDailyReport({sourceDate, io, now=Date.now,
  configuration=EOD_SOURCE_CONFIG, expectedAccount=APPROVED_IB_ACCOUNT_ID,
  loadContext=loadTrustedContext, fetchArchive=fetchFlexArchive, readSharesight=readSharesightAction}={}) {
  validateCompletedEodSession(sourceDate,now());
  const config=validateEodSourceConfiguration(configuration);
  if (typeof io?.loadFlexToken!=='function' || typeof io?.loadGatewayToken!=='function'
    || typeof io?.savePrivate!=='function') throw new Error('EOD_DAILY_IO_REQUIRED');
  const context=await loadContext({now});
  validateAssociationSnapshot(context.association,{now:now(),edition:'am'});
  const [token,gatewayToken]=await Promise.all([io.loadFlexToken(),io.loadGatewayToken()]);
  let archiveAdapters;
  const readArchive=async ({sourceDate: requestedDate}) => {
    if (requestedDate!==sourceDate) throw new Error('EOD_DAILY_ARCHIVE_BINDING');
    const result=await fetchArchive({token, configuredQueryId:config.configuredQueryId});
    if (typeof result?.bytes!=='string' || result.requestedQueryId!==config.configuredQueryId)
      throw new Error('EOD_DAILY_ARCHIVE_BINDING');
    const rawSha256=digest(result.bytes), privateObject=`report-check/${new Date(now()).toISOString()}-${crypto.randomUUID()}/ib.flexEod.xml`;
    const provisional={bytes:result.bytes,metadata:{privateObject,generation:'1',rawSha256,
      configuredQueryId:config.configuredQueryId,baseCurrency:config.baseCurrency,providerTimezone:config.providerTimezone}};
    // Validate the real raw layout, approved account and exact completed cutoff
    // before saving. XML names and a supplier finality flag prove no identity.
    adaptFlexArchive(provisional,{expectedAccount,expectedQueryId:config.configuredQueryId,sourceDate,readAt:new Date(now()).toISOString()});
    const saved=await io.savePrivate(privateObject,result.bytes);
    if (saved?.sha256!==rawSha256 || !/^\d+$/.test(saved.generation||'')) throw new Error('EOD_DAILY_ARCHIVE_BINDING');
    const archive={...provisional,metadata:{...provisional.metadata,generation:saved.generation}};
    archiveAdapters=createEodArchiveAdapters({trustedConfiguration:{...config,account:expectedAccount},
      archiveBinding:{...config,account:expectedAccount,sourceDate,privateObject,generation:saved.generation,rawSha256},
      readArchiveObject:async pin=>{
        if (pin.privateObject!==privateObject || pin.generation!==saved.generation) throw new Error('EOD_DAILY_ARCHIVE_BINDING');
        return archive;
      },now});
    return archiveAdapters.readArchive({sourceDate});
  };
  const snapshotReader=createEodSnapshotReader({sourceDate,
    readSharesightBatch:date=>readSharesight(date,gatewayToken,{now,settle:true})});
  return runPrivateEodReport({sourceDate,io,now,loadContext,readArchive,
    verifyArchive:options=>archiveAdapters.verifyArchive(options),expectedAccount,expectedQueryId:config.configuredQueryId,
    snapshotReader,captureOptionalLive:null});
}
