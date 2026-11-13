"""Assemble native performance only after the bound source stage passes.

Targets come exclusively from the pinned pure allocation/company projection.
This produces an untrusted complete-original candidate, never source authority.
"""
import copy
import datetime as dt
from decimal import Decimal
import json
import re

from .bound_files import read_bound_file, require, strict_json
from .native_aggregates import scope, strategy
from .native_columns import CANON, native_percentage
from .native_top5 import read_native
from .official_workbooks import workbook
from .performance_boundary import _run, _members, GROUPS, STOCK_CATEGORIES
from .projection_contract import project_targets
from .top5_projection import project_top_report


def _keys(members):
    return {(m['account'], m['market'], m['securityCode']) for m in members}


def _merge(primary, auxiliary):
    for key in ('period','startDate','endDate','includeClosed','calculationMethod','currency','cashPerformance'):
        require(primary[key] == auxiliary[key], 'AUXILIARY_PERIOD')
    require(primary['cashPerformance'] == 'included', 'AUXILIARY_CASH')
    p={CANON(r['scope']):r for r in primary['rows']}
    a={CANON(r['scope']):r for r in auxiliary['rows']}
    root=CANON(scope('All Together'))
    require(root in p and root in a and _keys(p[root]['members']) == _keys(a[root]['members']), 'AUXILIARY_MEMBERSHIP')
    funds={}
    for parent in ('PE/VC','对冲基金','常青基金'):
        key=CANON(scope(parent));require(key in p,'AUXILIARY_PARENT')
        funds[parent]=p[key]['members']
    expected={CANON(scope('PE/VC')):funds['PE/VC']}
    for parent in ('对冲基金','常青基金'):
        for member in funds[parent]:
            key=CANON(scope(strategy([member['market'],member['securityCode'],'']),parent))
            expected.setdefault(key,[]).append(member)
    fund_keys={key for members in funds.values() for key in _keys(members)}
    expected[CANON(scope('二级市场'))]=[m for m in p[root]['members'] if (m['account'],m['market'],m['securityCode']) not in fund_keys and m['market']!='CASH']
    expected[CANON(scope('Cash Accounts'))]=[m for m in p[root]['members'] if m['market']=='CASH']
    for key,members in expected.items():
        require(key in a and _keys(a[key]['members']) == _keys(members), 'AUXILIARY_CATEGORY_MEMBERS')
    require(set(a) <= set(expected)|{root}, 'AUXILIARY_UNEXPECTED_SCOPE')
    selected=[r for key,r in a.items() if key==root or r['scope']['type']=='fund-strategy' or key==CANON(scope('二级市场'))]
    selected_keys={CANON(r['scope']) for r in selected}
    result=copy.deepcopy(primary)
    result['additionalSources']=[copy.deepcopy(auxiliary['source'])]
    result['rows']=[r for r in result['rows'] if CANON(r['scope']) not in selected_keys]+[
        dict(copy.deepcopy(r),sourceFileId=auxiliary['source']['libraryFileId']) for r in selected]
    result['unavailable']=[r for r in result['unavailable'] if CANON(r['scope']) not in selected_keys]
    return result


def _native_amount(doc, blob, *, sheet, row_number, members, expected_pct, expected_unit):
    require(sheet in doc['rows'] and sheet in doc['totals'], 'AMOUNT_SHEET')
    number,total=doc['totals'][sheet]
    require(number==row_number and _keys(members)==set(_members(doc['rows'][sheet])), 'AMOUNT_MEMBER_BINDING')
    value,unit,_=native_percentage(total[14],doc['formats'][sheet].get('O'+str(number),'General'))
    require(unit==expected_unit and value==expected_pct, 'AMOUNT_RATE_PAIR')
    _,formulas,_=workbook(blob,17)
    cells=doc['numbers'][sheet]
    def numeric(column,row):
        address=chr(64+column)+str(row)
        value=cells.get(address)
        formula=formulas[sheet].get((row,column))
        if formula is not None:
            require(re.fullmatch(r'=-?\d+(?:\.\d+)?',formula) is not None,'AMOUNT_FORMULA')
            literal=Decimal(formula[1:])
            require(value is None or value==literal,'AMOUNT_CACHE')
            value=literal
        require(isinstance(value,Decimal) and value.is_finite(),'AMOUNT_INCOMPLETE')
        return value
    amount=numeric(14,number)
    require(abs(amount)<=Decimal('1e12') and amount*100==(amount*100).to_integral_value(),'AMOUNT_PRECISION')
    require(sum((numeric(col,number) for col in (8,10,12)),Decimal(0))==amount,'AMOUNT_COMPONENTS')
    require(sum((numeric(14,n) for n,_ in doc['rows'][sheet]),Decimal(0))==amount,'AMOUNT_MEMBER_SUM')
    value=float(amount)
    require(Decimal(str(value))==amount,'AMOUNT_REPRESENTATION')
    return value


def _assemble(request,now):
    staged=_run(request,now)
    projection=project_targets(staged['allocation'],now=now)
    targets=projection['targets']
    require(isinstance(targets,list) and len(targets) in (15,20),'PROJECTED_TARGETS')
    bindings=request['bindings'];reports=[];top_reports=[];top_checks=[]
    for period in ('all','oneYear'):
        primary=staged['nativeReports']['assetclass'][period]['report']
        auxiliary=staged['nativeReports']['strategy'][period]['report']
        report=_merge(primary,auxiliary)
        docs,blobs={},{ }
        for role in ('assetclass','strategy','top5','stock'):
            blob=read_bound_file(bindings[role][period]);blobs[role]=blob
            # The native reader permits only assetclass or Top5 group labels.
            # Generic report parsing has already validated strategy/stock. An
            # in-memory document construction preserves their native fields.
            if role in ('assetclass','top5'):
                combined=role=='top5' and staged['nativeReports']['top5'][period]['combineByHolding']
                docs[role]=read_native(blob,group_by=GROUPS[role],start_date=report['startDate'],end_date=report['endDate'],
                                      accounts=staged['allocation']['accounts'],combine_by_holding=combined)
            else:
                from .native_stock import read_report
                rows,totals,_,numbers,formats=read_report(blob,GROUPS[role],report['startDate'],report['endDate'])
                docs[role]=dict(rows=rows,totals=totals,numbers=numbers,formats=formats)
        stock_scope=scope('股票市场')
        require(not any(r['scope']==stock_scope for r in report['rows'])
                and [r for r in report['unavailable'] if r['scope']==stock_scope]==[dict(scope=stock_scope,reason='native-aggregate-not-provided')], 'STOCK_PRIOR_STATE')
        primary_members=_members(docs['assetclass']['rows']['Combined'])
        stock_keys={key for key,(_,row) in primary_members.items() if row[15] in STOCK_CATEGORIES}
        sheets=[name for name,rows in docs['stock']['rows'].items() if name!='Combined' and set(_members(rows))==stock_keys]
        require(len(sheets)==1,'STOCK_SUBTOTAL_AMBIGUOUS')
        sheet=sheets[0];n,total=docs['stock']['totals'][sheet]
        pct,unit,_=native_percentage(total[14],docs['stock']['formats'][sheet].get('O'+str(n),'General'))
        members=[dict(account=k[0],market=k[1],securityCode=k[2]) for k in sorted(stock_keys)]
        stock_ref=dict(libraryFileId=bindings['stock'][period]['libraryFileId'],version=bindings['stock'][period]['libraryVersion'],
                       sha256=bindings['stock'][period]['sha256'],locator='Official native stock Total row')
        report['additionalSources'].append(stock_ref)
        report['rows'].append(dict(scope=stock_scope,members=members,sourceSheet=sheet,sourceRow=n,returnPct=pct,unit=unit,
                                   termEvidence=dict(type='unknown'),sourceFileId=stock_ref['libraryFileId']))
        report['unavailable']=[r for r in report['unavailable'] if r['scope']!=stock_scope]
        _native_amount(docs['stock'],blobs['stock'],sheet=sheet,row_number=n,members=members,expected_pct=pct,expected_unit=unit)
        portfolio=[r for r in report['rows'] if r['scope']==scope('All Together')]
        require(len(portfolio)==1 and portfolio[0].get('sourceFileId')==auxiliary['source']['libraryFileId'], 'PORTFOLIO_SOURCE')
        root=portfolio[0]
        root['returnAmountUSD']=_native_amount(docs['strategy'],blobs['strategy'],sheet=root['sourceSheet'],row_number=root['sourceRow'],
                                               members=root['members'],expected_pct=root['returnPct'],expected_unit=root['unit'])
        top_ref=dict(libraryFileId=bindings['top5'][period]['libraryFileId'],version=bindings['top5'][period]['libraryVersion'],
                     sha256=bindings['top5'][period]['sha256'],locator='Official native Top5 rows or totals')
        projected,checks=project_top_report(docs['assetclass'],report,targets,docs['top5'],top_ref)
        # Trust flags stay on the outer candidate. The canonical source report
        # schema cannot contain helper metadata, and removing it grants no trust.
        for name in ('publicationReady','targetSelectionBasis','expandedRowsBasis'):
            projected.pop(name,None)
        top_reports.append(projected);top_checks.extend(checks);reports.append(report)
    performance=dict(schema='fee-console.ratio-performance-source.v2',provider='Sharesight',currency='USD',asOf=request['targetDate'],
                     accounts=copy.deepcopy(staged['allocation']['accounts']),reports=reports,
                     topHoldings=dict(schema='fee-console.ratio-top5-source.v1',targets=targets,reports=top_reports),
                     inceptionEvidence=copy.deepcopy(staged['inceptionEvidence']))
    validation=project_targets(staged['allocation'],now=now,performance=performance,captured_at=staged['performanceCapturedAt'])
    require(validation['targets']==targets,'PROJECTION_TARGETS_CHANGED')
    original=dict(schemaVersion='sharesight-private-performance-v1',accounts=copy.deepcopy(staged['allocation']['accounts']),
                  allocation=staged['allocation'],performance=performance,performanceCapturedAt=staged['performanceCapturedAt'])
    # Final actual-file checks after local projection. Original bytes remain
    # independently hash pinned; this does not authenticate provider assertions.
    for group in bindings.values():
        for spec in group.values():read_bound_file(spec)
    for spec in [request['inception']['document'],*request['inception']['sources']]:read_bound_file(spec)
    return dict(state='OFFLINE_COMPLETE_ORIGINAL_CANDIDATE',original=original,performanceAssembled=True,
                referenceContractValidated=True,codeReferenceBase=validation['codeReferenceBase'],
                actualIdentityAndBytesChecked=True,originalLibraryIdentityPending=True,sourceOriginVerified=False,fullPerformanceReady=False,publicationReady=False,
                productionEnabled=False,currentCloudCompatibilityValidated=False,
                blockedOn=['PROVIDER_OBSERVATION_AUTHENTICATION','CURRENT_CLOUD_INTEGRATION_AND_REVIEW','REFRESH_DATE_POLICY'],
                nativeTop5Checks=top_checks,uploads=0,publications=0)


def prepare_offline_performance(request, *, enabled=False):
    if enabled is False:return dict(state='DISABLED',publicationReady=False,productionEnabled=False)
    require(enabled is True and type(request)is dict,'ENABLE_BOOLEAN')
    frozen=strict_json(json.dumps(request,ensure_ascii=False,allow_nan=False))
    return _assemble(frozen,dt.datetime.now(dt.timezone.utc))
