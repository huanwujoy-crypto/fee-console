// Structural paths only. These helpers grant no read, write or source authority.
const uuid='[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const instant='\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d\\.\\d{3}Z';
export function recoveryRequestId(name){
  return typeof name==='string'?name.match(new RegExp('^report-check/orders-probe-('+uuid+')/preview-receipt\\.json$'))?.[1]??null:null;
}
export function originalReportStart(name){
  const value=typeof name==='string'?name.match(new RegExp('^report-check/('+instant+')-'+uuid+'/report\\.html$'))?.[1]:null;
  return value&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value?value:null;
}
export function ownerBundlePathsMatch(m){
  if(!m||typeof m.dataDate!=='string'||!/^\d{4}-\d\d-\d\d$/.test(m.dataDate)
    ||!Number.isFinite(Date.parse(m.dataDate+'T00:00:00Z'))||new Date(m.dataDate+'T00:00:00Z').toISOString().slice(0,10)!==m.dataDate)return false;
  return m.artifactObject===`delivery/${m.dataDate}/report.html`&&m.receiptObject===`delivery/${m.dataDate}/receipt.json`
    ||!!recoveryRequestId(m.receiptObject)&&!!originalReportStart(m.artifactObject)
      &&originalReportStart(m.artifactObject)===m.captureStartedAt;
}
