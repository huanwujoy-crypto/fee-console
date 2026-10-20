// No import-time filesystem, credential, network or SDK access.
import crypto from 'node:crypto';
export const PRIVATE_BINDING_SHA256='c3521c8cb31e3c0fd72bcf11663c5021f3312a578b188e2bd8e4e0d8bac26f34';
const admitted=new WeakSet();
const deepFreeze=x=>{if(x&&typeof x==='object'){for(const v of Object.values(x))deepFreeze(v);Object.freeze(x);}return x;};
export function validatePrivateBinding(bytes){
  if(!Buffer.isBuffer(bytes)||bytes.length>200000||crypto.createHash('sha256').update(bytes).digest('hex')!==PRIVATE_BINDING_SHA256)throw Error('PRIVATE_BINDING_INVALID');
  const binding=JSON.parse(bytes.toString('utf8'));
  if(binding.spec!=='IB-ORDERS-FRESH-PRIVATE-BINDING-v1')throw Error('PRIVATE_BINDING_INVALID');
  deepFreeze(binding);admitted.add(binding);return binding;
}
export function assertPrivateBinding(binding){if(!admitted.has(binding))throw Error('PRIVATE_BINDING_INVALID');}
