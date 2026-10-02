import {extractNightActionModel} from '../../scripts/xuan-ib-night-action-view.mjs';
import {gitBlobSha} from '../../scripts/xuan-ib-publish-health.mjs';
export function provesFormalAction({html,meta,sourceSha,plan}){
 try{
 const model=extractNightActionModel(html),capture=model.asOfHkt.match(/\b(\d{2}:\d{2})\b/)?.[1],time=Date.parse(`${model.dataDate}T${capture}:00+08:00`)/1000;
 return model.status==='ready'&&model.schemaVersion>=4&&model.schemaVersion<6&&model.dataDate===plan.dataDate&&model.asOfHkt.endsWith(`数据至 ${plan.sourceDate}`)
 &&Number.isFinite(time)&&time>=plan.startEpoch&&time<plan.endEpoch&&meta?.dataDate===plan.dataDate&&meta.sourceSha===sourceSha&&meta.htmlBlob===gitBlobSha(html)
 &&Number.isInteger(meta.sourceCommitEpoch)&&meta.sourceCommitEpoch>=plan.startEpoch;
 }catch{return false;}
}
