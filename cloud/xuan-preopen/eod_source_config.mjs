// The query ID remains in the separately approved private deployment config.
// No CLI query selector or real account/query value belongs in public source.
// Missing deployment configuration fails before any credentials/source IO.
export function readEodSourceConfiguration(environment = process.env) {
  return Object.freeze({configuredQueryId: environment.XUAN_PREOPEN_EOD_QUERY_ID ?? null,
    baseCurrency: 'USD', providerTimezone: null});
}
export const EOD_SOURCE_CONFIG = readEodSourceConfiguration();
export function validateEodSourceConfiguration(value = EOD_SOURCE_CONFIG) {
  if (!value || Object.keys(value).sort().join('|') !== 'baseCurrency|configuredQueryId|providerTimezone'
    || typeof value.configuredQueryId !== 'string' || !/^[1-9]\d{0,19}$/.test(value.configuredQueryId)
    || /[\r\n]/.test(value.configuredQueryId) || value.baseCurrency !== 'USD'
    || value.providerTimezone !== null) throw new Error('EOD_DAILY_CONFIGURATION_REQUIRED');
  return Object.freeze({...value});
}
