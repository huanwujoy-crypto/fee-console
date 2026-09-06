// Owner retirement, 2026-09-06. Presentation only, after report verification.
// Signed reports, source values, decisions and receipts remain unchanged.
export const RETIREMENT_ID = 'xuan-four-bucket-retired-history';
export const RETIREMENT_NOTE = '四桶配置管理已取消；以下仅保留历史资料，不再作为当前配置或待办要求。';
const topic = /四桶|三层流动性|归桶|four[\s_-]*bucket|HL\s*(?:缺口|当前\s*\/\s*目标)/i;
const protectedSelector = 'template,script,style,[data-decision-id],#xuan-ib-cash-plan-detail,#xuan-ib-cash-plan-kpi,.pane.p5';

export function partitionFourBucketText(text) {
  const kept=[], retired=[];
  // Decimal points are not delimiters. Preserve unrelated warnings, quoted
  // amounts and four-equity-class cash planning rather than hiding a whole alert.
  for(const clause of text.split(/(?<=[。；;\n])/u)) {
    if(topic.test(clause) && !/非四桶|not (?:a )?four.bucket/i.test(clause)) retired.push(clause);
    else kept.push(clause);
  }
  return {kept:kept.join('').trim(),retired:retired.join('').trim()};
}

export function retireFourBucketDisplay(doc) {
  if(!doc?.createElement || doc.getElementById(RETIREMENT_ID)) return;
  const pane=doc.querySelector('.pane.p3');
  if(!pane) return;
  const archive=doc.createElement('details');archive.id=RETIREMENT_ID;
  archive.className='pane-notes';
  const summary=doc.createElement('summary');summary.textContent='已取消功能 · 历史资料';
  const body=doc.createElement('div');body.className='dbody';
  const note=doc.createElement('p');note.textContent=RETIREMENT_NOTE;
  archive.append(summary,body);body.append(note);pane.append(archive);
  const excluded=n=>n.closest(protectedSelector)||n.closest(`#${RETIREMENT_ID}`);
  const retain=n=>{n.removeAttribute('open');body.append(n);};
  // A canonical four-bucket-only card is separate from the cash-plan section.
  for(const n of [...doc.querySelectorAll('#xuan-ib-four-bucket-card-v1,#xuan-ib-classification-disclosure-v1')])
    if(!excluded(n)) retain(n);
  for(const kpi of [...doc.querySelectorAll('.kpis .kpi')]) {
    if(!excluded(kpi)&&topic.test(kpi.querySelector('.lab')?.textContent||'')) retain(kpi);
  }
  for(const h of [...doc.querySelectorAll('.pane.p3 h2')]) {
    if(excluded(h)||!topic.test(h.textContent)) continue;
    // The legacy allocation section combines four buckets AND equity classes.
    if(/四类/.test(h.textContent)) h.textContent='股票配置';
    else if(h.parentElement?.matches('section.card')) retain(h.parentElement);
  }
  // Mobile layout has already extracted numerical metrics into separate cells.
  for(const dt of [...doc.querySelectorAll('.mobile-metrics dt')]) {
    if(excluded(dt)) continue;
    if(/^(?:HL 当前 \/ 目标|VC-PE 当前 \/ 目标|HF|常青基金)$/.test(dt.textContent.trim())) {
      const dl=doc.createElement('dl');dl.append(dt.parentElement);body.append(dl);
    }
  }
  // Original explanations may have been copied into per-pane folded notes.
  // No decision subtree, ETF content or cash-plan calculation is processed.
  for(const n of [...doc.querySelectorAll('p,li,.alert,.mobile-metric-caveat')]) {
    if(!n.isConnected||excluded(n)||n.matches('.alert.bad,.alert.danger,.alert.error')||n.querySelector('table,template,[data-decision-id]')) continue;
    const parts=partitionFourBucketText(n.textContent);
    if(!parts.retired) continue;
    if(parts.kept){
      const original=n.cloneNode(true);
      original.removeAttribute('id');
      for(const child of original.querySelectorAll('[id]')) child.removeAttribute('id');
      body.append(original);n.textContent=parts.kept;
    }else retain(n);
  }
  for(const h of [...doc.querySelectorAll('.notes-section h3')])
    if(!excluded(h)&&topic.test(h.textContent)) h.textContent=/四类/.test(h.textContent)?'股票配置口径':'历史口径（已取消）';
  for(const grid of [...doc.querySelectorAll('.mobile-metrics')])
    if(!grid.children.length) grid.remove();
}
