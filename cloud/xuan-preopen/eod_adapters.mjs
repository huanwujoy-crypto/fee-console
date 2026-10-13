// Inactive composition only: no default IO, network, credentials, CLI or live IB.
import {adaptFlexArchive, digest, SNAPSHOT_SCOPES, validDate} from './eod_sources.mjs';
const fail = code => { throw new Error('EOD_ADAPTER_' + code); };
const scalar = value => typeof value === 'string' && !!value && value.length <= 1024 && !/[\r\n\0]/.test(value);

/** Caller supplies independently trusted noncredential configuration and an
 * archive binding obtained from actual existing producer/object evidence.
 * Names, XML query names and self-authored expected fields are not that evidence.
 * This validates the supplied trust boundary; it does not authenticate its origin. */
export function createEodArchiveAdapters({trustedConfiguration, archiveBinding, readArchiveObject, now = Date.now} = {}) {
  const config = structuredClone(trustedConfiguration), binding = structuredClone(archiveBinding);
  if (!config || !scalar(config.account) || !scalar(config.configuredQueryId) || config.baseCurrency !== 'USD'
    || !binding || binding.account !== config.account || binding.configuredQueryId !== config.configuredQueryId
    || !validDate(binding.sourceDate) || !scalar(binding.privateObject) || !/^\d+$/.test(binding.generation || '')
    || !/^[a-f0-9]{64}$/.test(binding.rawSha256 || '') || typeof readArchiveObject !== 'function') fail('TRUSTED_BINDING_REQUIRED');
  const expectedAccount = config.account, expectedQueryId = config.configuredQueryId;
  function check(archive, sourceDate) {
    if (sourceDate !== binding.sourceDate || typeof archive?.bytes !== 'string'
      || archive.metadata?.privateObject !== binding.privateObject || archive.metadata?.generation !== binding.generation
      || digest(archive.bytes) !== binding.rawSha256 || archive.metadata.rawSha256 !== binding.rawSha256
      || archive.metadata.configuredQueryId !== expectedQueryId || archive.metadata.baseCurrency !== config.baseCurrency
      || (archive.metadata.providerTimezone ?? null) !== (config.providerTimezone ?? null)) fail('ARCHIVE_BINDING');
    // XML account and cutoff are checked against independent configuration;
    // financial finality remains unknown in this identity-only adapter.
    adaptFlexArchive(archive, {expectedAccount, expectedQueryId, sourceDate, readAt: new Date(now()).toISOString()});
  }
  return {
    expectedAccount, expectedQueryId,
    async readArchive({sourceDate} = {}) {
      if (sourceDate !== binding.sourceDate) fail('ARCHIVE_DATE');
      let archive;
      try { archive = await readArchiveObject({privateObject: binding.privateObject, generation: binding.generation}); }
      catch { fail('ARCHIVE_READ_FAILED'); }
      check(archive, sourceDate);
      return archive;
    },
    async verifyArchive({archive, sourceDate, expectedAccount: account, expectedQueryId: query} = {}) {
      if (account !== expectedAccount || query !== expectedQueryId) fail('ARCHIVE_SCOPE');
      check(archive, sourceDate);
      return {status: 'archive-verified', account: expectedAccount, configuredQueryId: expectedQueryId,
        sourceDate, privateObject: binding.privateObject, generation: binding.generation, rawSha256: binding.rawSha256};
    },
  };
}

/** One fixed batch per report adapter, shared by both concurrent scope reads.
 * Inject date => readSharesightAction(date, existingToken, {settle:true}) at
 * the already-authorized caller. Stored raw API wrappers are preserved as-is. */
export function createEodSnapshotReader({sourceDate, readSharesightBatch} = {}) {
  if (!validDate(sourceDate) || typeof readSharesightBatch !== 'function') fail('SNAPSHOT_BATCH_REQUIRED');
  let batch;
  return async request => {
    const scope = SNAPSHOT_SCOPES[request?.sourceKey];
    if (!scope || request.sourceDate !== sourceDate || request.portfolioId !== scope.portfolioId
      || request.portfolio !== scope.portfolio || request.grouping !== scope.grouping) fail('SNAPSHOT_SCOPE');
    batch ??= Promise.resolve().then(() => readSharesightBatch(sourceDate)).catch(() => fail('SNAPSHOT_READ_FAILED'));
    const sources = await batch;
    if (!Array.isArray(sources)) fail('SNAPSHOT_BATCH');
    const matching = sources.filter(s => s?.sourceKey === request.sourceKey);
    if (matching.length !== 1) return null;
    const source = matching[0];
    if (source.status === 'request-failure') fail('SNAPSHOT_READ_FAILED');
    const report = source.raw?.report ?? source.raw?.data?.report ?? source.raw?.result?.data?.report;
    // The codec separately validates mode, supplier, portfolio, currency and
    // cutoff. IB's classification parser also validates its group contents.
    if (report && (request.sourceKey === 'sharesight.ibGroupedPerformance'
      ? report.grouping !== 'custom_group_category' || report.custom_group?.id !== 83569
      : report.grouping !== 'investment_type')) return null;
    if (!report || report.start_date !== sourceDate || report.end_date !== sourceDate || report.include_sales !== false) return null;
    return source;
  };
}

/** Supplies the existing runner seams only. Caller explicitly injects existing
 * loadTrustedContext/privateCloudIo or offline equivalents; nothing selects
 * this factory from daily/default/CLI. No completion or financial proof minted. */
export function createPrivateEodAdapters({io, loadContext, trustedConfiguration, archiveBinding,
  readArchiveObject, readSharesightBatch, now = Date.now} = {}) {
  if (typeof io?.savePrivate !== 'function' || typeof loadContext !== 'function') fail('PRIVATE_CONTEXT_REQUIRED');
  const archive = createEodArchiveAdapters({trustedConfiguration, archiveBinding, readArchiveObject, now});
  return {io, loadContext, now, sourceDate: archiveBinding.sourceDate, ...archive,
    snapshotReader: createEodSnapshotReader({sourceDate: archiveBinding.sourceDate, readSharesightBatch})};
}
