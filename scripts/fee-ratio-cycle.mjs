#!/usr/bin/env node
// Due-cycle preparation through the existing private-file/manager-browser path.
// No credential, financial read, browser click, Gist write or formal attestation.
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import {fileURLToPath} from 'node:url';
import {createLegacyPolicy} from './fee-legacy-policy.mjs';
import {validateReportPlan,reportPlanReadiness} from './fee-report-period.mjs';
import {stageIndependentRatioSnapshot} from './fee-ratio-snapshot-packet.mjs';
const fail=()=>{throw Error('RATIO_CYCLE_PREPARATION_REFUSED');},hash=b=>crypto.createHash('sha256').update(b).digest('hex'),parse=b=>createLegacyPolicy().parseExactJson(b);
const exact=(v,k)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...k].sort().join(',');
function readPlan(file){
 if(typeof file!=='string'||!path.isAbsolute(file)||fs.realpathSync(file)!==file)fail();const d=path.dirname(file),dir=fs.lstatSync(d),s=fs.lstatSync(file);
 if(!dir.isDirectory()||dir.isSymbolicLink()||(dir.mode&0o777)!==0o700||dir.uid!==process.getuid()||!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.uid!==process.getuid()||(s.mode&0o777)!==0o600||s.size>16384)fail();
 const read=()=>{const at=fs.lstatSync(file),parent=fs.lstatSync(d);if(at.ino!==s.ino||at.dev!==s.dev||at.nlink!==1||(at.mode&0o777)!==0o600||at.uid!==process.getuid()||parent.ino!==dir.ino||parent.dev!==dir.dev||(parent.mode&0o777)!==0o700||parent.isSymbolicLink()||fs.realpathSync(file)!==file)fail();const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const a=fs.fstatSync(fd);if(a.ino!==at.ino||a.dev!==at.dev)fail();const b=fs.readFileSync(fd),z=fs.fstatSync(fd);if(a.size!==z.size||a.mtimeMs!==z.mtimeMs||a.ctimeMs!==z.ctimeMs)fail();return b;}finally{fs.closeSync(fd);}};
 const bytes=read();return {plan:parse(bytes),check(){if(!read().equals(bytes))fail();}};
}
export async function prepareRatioCycle({planPath,now=new Date(),environ=process.env,evidenceRuntime,exposureCore}={}){
 const pinned=readPlan(planPath),p=pinned.plan;
 if(!exact(p,['schema','period','packetPlan'])||p.schema!=='fee-console.ratio-cycle-plan.v1'||!validateReportPlan(p.period)||reportPlanReadiness(p.period,now).state!=='due'||!exact(p.packetPlan,['path','sha256'])||path.dirname(p.packetPlan.path)!==path.dirname(planPath)||!/^[a-f0-9]{64}$/.test(p.packetPlan.sha256))fail();
 const packet=readPlan(p.packetPlan.path);if(hash(fs.readFileSync(p.packetPlan.path))!==p.packetPlan.sha256)fail();
 const result=await stageIndependentRatioSnapshot({plan:packet.plan,now,environ,...(evidenceRuntime?{evidenceRuntime}:{}),...(exposureCore?{exposureCore}:{})});pinned.check();packet.check();
 if(result.publicationReady!==false||result.managerAuthentication!==false)fail();
 const handoff={schema:'fee-console.ratio-cycle-handoff.v1',periodKey:hash(JSON.stringify(p.period)),kind:p.period.kind,accountingThrough:p.period.accountingThrough,priceThrough:p.period.priceThrough,sourceAsOf:result.sourceDate,sourceCapturedAt:result.sourceCapturedAt,sourceExpiresAt:result.sourceExpiresAt,cipherSha256:result.cipherSha256,status:'CANDIDATE_NEEDS_EXISTING_MANAGER_CONFIRMATION',publicationReady:false,managerAuthentication:false,financialRead:false,keychainRead:false,feeOrHealthWrite:false,delivery:{filename:'fee-console-ratio-snapshot.json',destination:'existing registered same private Gist',runtime:'existing Mac manager browser',requiresOnlineUnlockedMac:true,requiresFreshOwnerCapability:true,requiresTrustedPreviewAndConsent:true,automaticPublish:false}};
 const out=path.join(packet.plan.workspace,'ratio-independent-candidate','ratio-cycle-handoff.json');fs.writeFileSync(out,JSON.stringify(handoff)+'\n',{flag:'wx',mode:0o600});return handoff;
}
async function main(){if(process.argv.length!==3)fail();const result=await prepareRatioCycle({planPath:process.argv[2]});console.log(result.status);}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(()=>{console.error('RATIO_CYCLE_PREPARATION_REFUSED');process.exitCode=1;});
