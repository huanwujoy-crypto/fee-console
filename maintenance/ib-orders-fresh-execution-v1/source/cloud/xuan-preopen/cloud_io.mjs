// Fixed private destinations. No filesystem credential, bucket or secret flags.
import {ibError} from './ib_diagnostics.mjs';
import {parseDecisionJson} from '../../scripts/xuan-ib-decision-menu.mjs';
export function uniqueCloudJson(text,limit=8_000_000) {
  try { parseDecisionJson(text,limit); return JSON.parse(text); }
  catch { throw ibError('CLOUD_RESPONSE_INVALID',{category:'response_invalid'}); }
}
export function validateIbCredentialBinding(value) {
  if(!value||Object.getPrototypeOf(value)!==Object.prototype||Object.keys(value).sort().join('|')!=='clientId|version'
    ||Object.values(Object.getOwnPropertyDescriptors(value)).some(d=>!Object.hasOwn(d,'value'))
    ||typeof value.version!=='string'||! /^[1-9]\d{0,29}$/.test(value.version)
    ||typeof value.clientId!=='string'||! /^[A-Za-z0-9._:-]{1,200}$/.test(value.clientId))
    throw ibError('IB_READ_ONLY_CREDENTIAL_REQUIRED',{phase:'credential_load',category:'scope_invalid'});
  return Object.freeze({clientId:value.clientId,version:value.version});
}
export function validateBoundIbVersionName(name,version) {
  validateIbCredentialBinding({clientId:'version-check',version});
  if(typeof name!=='string'||!new RegExp('^projects/(?:family-portfolio-gateway|860729177589)/secrets/xuan-preopen-ib-mcp/versions/'+version+'$').test(name))
    throw ibError('IB_READ_ONLY_CREDENTIAL_REQUIRED',{phase:'credential_load',category:'scope_invalid'});
  return name;
}

// Secret Manager can use the fixed project ID or its fixed numeric identifier
// in a version name. Return metadata only; never read the new payload back.
export function validateIbRotationReceipt(value) {
  if (value?.state !== 'ENABLED' || typeof value?.name !== 'string'
    || !/^projects\/(?:family-portfolio-gateway|860729177589)\/secrets\/xuan-preopen-ib-mcp\/versions\/[1-9]\d{0,29}$/.test(value.name))
    throw ibError('IB_TOKEN_ROTATION_OUTCOME_UNKNOWN', {phase: 'credential_save', category: 'save_outcome_unknown'});
  return Object.freeze({name: value.name, state: 'ENABLED'});
}
