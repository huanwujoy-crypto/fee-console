// Compose an IB-live report readiness with the weekly Sharesight snapshot
// resolution. Pure. IB drives publication; the weekly Sharesight data is
// non-blocking supporting evidence. The weekly snapshot — including IB-HK
// (936247) — is NEVER a live-positions fallback: positionSource is carried
// through from IB readiness only and is never derived from weekly SS here.
// This composition helper is not authority to use financial values. The active
// first-stage pipeline uses metadata-only evidence and leaves amounts disabled;
// ssUsable here means eligible dated metadata, not verified raw-value readiness.
const fail = code => { throw Object.assign(new Error(code), { readinessCode: code }); };
const IB_POSITION_SOURCES = new Set(['ib', 'sharesight-ib-hk', 'unavailable']);

// `ib` is the existing IB source-readiness shape:
//   { blocked, degraded, positionSource, issues }
// `weekly` is the output of resolveWeeklySnapshot():
//   { status: 'current'|'stale'|'unavailable', ... }
export function composeWeeklyReportReadiness(ib, weekly) {
  if (!ib || typeof ib.blocked !== 'boolean' || typeof ib.degraded !== 'boolean'
    || !IB_POSITION_SOURCES.has(ib.positionSource) || !Array.isArray(ib.issues)) fail('INVALID_IB_READINESS');
  if (!weekly || typeof weekly.status !== 'string') fail('INVALID_WEEKLY_RESOLUTION');

  const issues = [...ib.issues];
  let ssProvenance;
  let ssValuation = null;
  let ssUsable;
  switch (weekly.status) {
    case 'current':
      ssProvenance = 'weekly-current'; ssUsable = true;
      ssValuation = { captureWeekOfMondayHkt: weekly.captureWeekOfMondayHkt, portfolios: weekly.portfolios };
      break;
    case 'stale':
      ssProvenance = 'weekly-stale'; ssUsable = true;
      ssValuation = { captureWeekOfMondayHkt: weekly.captureWeekOfMondayHkt, portfolios: weekly.portfolios };
      issues.push(`SS_WEEKLY_STALE:${weekly.captureWeekOfMondayHkt}`);
      break;
    case 'unavailable':
      ssProvenance = 'unavailable'; ssUsable = false;
      issues.push(`SS_WEEKLY_UNAVAILABLE:${weekly.reason || 'UNKNOWN'}`);
      break;
    default:
      fail('INVALID_WEEKLY_STATUS');
  }

  return {
    // Publication is governed solely by IB (live, every-report critical path).
    blocked: ib.blocked,
    degraded: ib.degraded || ssProvenance !== 'weekly-current',
    positionSource: ib.positionSource, // never sharesight-weekly; carried from IB
    ssProvenance,                       // 'weekly-current' | 'weekly-stale' | 'unavailable'
    ssUsable,                           // stale is usable but must be shown dated as historical
    ssValuation,                        // null when unavailable; per-portfolio native dates otherwise
    issues
  };
}
