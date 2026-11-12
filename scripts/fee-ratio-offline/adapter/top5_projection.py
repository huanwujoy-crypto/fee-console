"""Pure target application, not authenticated selection or source authorization."""
import collections
from copy import deepcopy
import re
from .native_columns import CANON, native_percentage, require
from .combined_top5 import bind_members, original, group_coverage


def _same_members(asset, supplemental):
    group_coverage(supplemental)
    def keyed(doc):
        out = {}
        for n, r in doc['rows']['Combined']:
            key = (r[3].replace('&amp;', '&'), *r[:3])
            require(key not in out, 'TOP5_DUPLICATE_MEMBER')
            out[key] = tuple(original(doc, 'Combined', n, r, c) for c in range(4, 15)) + (r[16],)
        return out
    require(keyed(asset) == keyed(supplemental), 'TOP5_SUPPLEMENT_MEMBERSHIP')


def member(row):
    return dict(account=row[3].replace('&amp;', '&'), market=row[0], securityCode=row[1])


def category(row):
    return 'PE/VC' if row[15] == 'VC/PE' else row[15] if row[15] in ('常青基金', '对冲基金') else '二级市场'


def dated_name(row):
    for value in (row[1], row[2]):
        if not isinstance(value, str):
            continue
        marker = re.search(r'(?:^|[-–—_:：/\s])(?=(?:19|20)\d{2}(?:[-/.]|年))', value)
        if not marker:
            continue
        tail = value[marker.end():]
        hit = re.match(r'^(?:19|20)\d{2}[-/.](?:0[1-9]|1[0-2])(?:\s*[-–—_:：/]\s*|\s+)(\S[\s\S]*)$', tail) or re.match(r'^(?:19|20)\d{2}年(?:0?[1-9]|1[0-2])月\s*(?:[-–—_:：/]\s*)?(\S[\s\S]*)$', tail)
        if hit:
            return hit[1].strip()
    return None


def selected_members(rows, target):
    require(len({CANON(m) for m in target['members']}) == len(target['members']), 'TOP5_DUPLICATE_TARGET_MEMBER')
    instruments = {(m['market'], m['securityCode']) for m in target['members']}
    found = [(n, r) for n, r in rows if r[0] and r[1] and category(r) == target['category']
             and ((r[0], r[1]) in instruments or target['category'] == '常青基金' and dated_name(r) == target['name'])]
    identities = [CANON(member(r)) for _, r in found]
    require(len(identities) == len(set(identities)), 'TOP5_DUPLICATE_MEMBER')
    require({CANON(m) for m in target['members']} <= set(identities), 'TOP5_CURRENT_MEMBER_MISSING')
    return found


def project_top_report(asset, native_report, targets, supplemental=None, supplemental_source=None):
    """Apply caller targets without authenticating them or granting publication."""
    rows, missing, checks = [], [], []
    binding = None
    require((asset.get('startDate'), asset.get('endDate')) == (native_report.get('startDate'), native_report.get('endDate')), 'TOP5_DATES')
    if supplemental is not None:
        require((asset.get('startDate'), asset.get('endDate')) == (supplemental.get('startDate'), supplemental.get('endDate')), 'TOP5_DATES')
        if supplemental.get('combineByHolding') is True:
            binding = bind_members(asset, supplemental)
        else:
            _same_members(asset, supplemental)
        require(supplemental_source is not None, 'TOP5_SUPPLEMENT_IDENTITY')
    for t in targets:
        target = dict(category=t['category'], name=t['name'])
        entries = selected_members(asset['rows']['Combined'], t)
        keys = {CANON(member(r)) for _, r in entries}
        checks.append(dict(category=t['category'], currentMembers=len(t['members']), historyMembers=len(entries), needsNativeSubtotal=len(entries)>1))
        selected = None
        if len(entries) == 1:
            n, row = entries[0]; selected = (asset, 'Combined', n, row, None)
        elif supplemental and entries:
            matches = []
            if binding:
                for n, native in supplemental['rows']['Combined']:
                    native_members = binding['membersByRow']['Combined'][n]
                    if native[0] and native[1] and {CANON(member(r)) for _, r in native_members} == keys:
                        matches.append((supplemental, 'Combined', n, native, supplemental_source['libraryFileId']))
                require(len(matches) <= 1, 'TOP5_AMBIGUOUS_COMBINED_ROW')
            group_matches = []
            for sheet, members in (binding['expandedRows'] if binding else supplemental['rows']).items():
                if sheet != 'Combined' and sheet in supplemental.get('totals', {}) and all(r[0] and r[1] for _, r in members) and {CANON(member(r)) for _, r in members} == keys and len(members) == len(keys):
                    n, row = supplemental['totals'][sheet]; group_matches.append((supplemental, sheet, n, row, supplemental_source['libraryFileId']))
            require(len(group_matches) <= 1, 'TOP5_AMBIGUOUS_SUBTOTAL')
            if not matches:
                matches = group_matches
            if matches:
                selected = matches[0]
        if selected is None:
            missing.append(dict(target=target, reason='native-aggregate-not-provided' if entries else 'no-direct-holding'))
            continue
        doc, sheet, n, r, source_id = selected
        value, unit, _ = native_percentage(r[14], doc['formats'][sheet].get('O'+str(n), 'General'))
        evidence = [dict(**member(r), name=r[2], category=category(r), sourceRow=n) for n, r in entries]
        row = dict(target=target, memberEvidence=evidence, sourceSheet=sheet, sourceRow=n, returnPct=value, unit=unit, termEvidence=dict(type='unknown'))
        if source_id:
            row['sourceFileId'] = source_id
        rows.append(row)
    result = {k:v for k,v in native_report.items() if k not in ('rows','unavailable','additionalSources')}
    result.update(rows=rows, unavailable=missing, additionalSources=[supplemental_source] if supplemental else [])
    result.update(publicationReady=False, targetSelectionBasis='caller-supplied-untrusted', expandedRowsBasis='primary-membership-only')
    return deepcopy(result), checks
