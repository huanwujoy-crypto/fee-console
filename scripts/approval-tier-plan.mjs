// Advisory only: this module has no authority to approve, merge or publish.
// An ordinary classification still needs semantic review of the complete diff.
export function planApproval(files) {
  if (!Array.isArray(files) || files.length === 0 || files.length > 1000) {
    throw new Error('Complete nonempty GitHub file list required');
  }
  const paths = files.flatMap(file => {
    if (!file || typeof file.filename !== 'string') throw new Error('Invalid file entry');
    return [file.filename, ...(file.previous_filename === undefined ? [] : [file.previous_filename])];
  });
  if (paths.some(p => typeof p !== 'string' || !p || p.startsWith('/') || p.includes('..') || /[\\\r\n\0]/.test(p))) {
    throw new Error('Invalid repository path');
  }
  const ordinary = /^scripts\/xuan-ib-(order-view|report-view|holdings-reliability)\.(mjs|test\.mjs)$/;
  const tier = paths.every(p => ordinary.test(p)) ? 'ordinary-code-review' : 'specific-confirmation';
  return Object.freeze({
    tier,
    advisoryOnly: true,
    humanAuthentication: 'unavailable',
    enforcement: 'existing-owner-comment-and-exact-head',
    semanticReviewRequired: true,
  });
}
