"""Pure, exact membership checks. These checks grant no source authority."""
from collections import Counter
from copy import deepcopy
from decimal import Decimal, localcontext


def require(value, code):
    if not value:
        raise ValueError('TOP5_COMBINED_' + code)


def portfolios(value, accounts):
    """Parse a unique comma-space segmentation against an exact vocabulary."""
    require(isinstance(value, str) and 0 < len(value) <= 10000, 'PORTFOLIOS')
    names = tuple(accounts)
    require(names and all(isinstance(n, str) and n for n in names), 'ACCOUNTS')
    normalized = {name.replace('&amp;', '&') for name in names}
    require(len(normalized) == len(names), 'DUPLICATE_ACCOUNT_VOCABULARY')
    names = tuple(sorted(normalized))
    value = value.replace('&amp;', '&')
    # Iterative search avoids recursion limits on delimiter-containing names.
    pending, matches = [(value, ())], []
    while pending and len(matches) < 2:
        rest, used = pending.pop()
        for name in names:
            if name in used:
                continue
            if rest == name:
                matches.append(used + (name,))
            elif rest.startswith(name + ', '):
                pending.append((rest[len(name) + 2:], used + (name,)))
    require(len(matches) == 1, 'PORTFOLIOS')
    return matches[0]


def original(doc, sheet, n, row, col):
    """Use XML decimals, never a float rounded by the row parser."""
    value = doc.get('numbers', {}).get(sheet, {}).get(chr(65 + col) + str(n), row[col])
    if value is None or isinstance(value, str):
        return value
    require(type(value) in (int, Decimal), 'XML_NUMBER_REQUIRED')
    value = Decimal(value)
    require(value.is_finite(), 'NUMBER')
    return value


def exact_sum(values):
    require(all(type(v) in (int, Decimal) for v in values), 'NUMBER')
    values = [Decimal(v) for v in values]
    require(all(v.is_finite() for v in values), 'NUMBER')
    if not values:
        return Decimal(0)
    with localcontext() as context:
        context.prec = max(28, max(v.adjusted() for v in values) - min(v.as_tuple().exponent for v in values) + len(str(len(values))) + 2)
        return sum(values, Decimal(0))


def fingerprint(doc, sheet, n, row):
    return (tuple(original(doc, sheet, n, row, c) for c in range(17)),
            doc.get('formats', {}).get(sheet, {}).get('O' + str(n), 'General'))


def group_coverage(doc):
    require('Combined' in doc['rows'], 'COMBINED_SHEET')
    for records in doc['rows'].values():
        require(len({n for n, _ in records}) == len(records), 'DUPLICATE_ROW')
    require(Counter(fingerprint(doc, 'Combined', n, r) for n, r in doc['rows']['Combined']) ==
            Counter(fingerprint(doc, s, n, r) for s, rs in doc['rows'].items() if s != 'Combined' for n, r in rs), 'GROUP_COVERAGE')


def bind_members(asset, combined):
    """Expand primary membership only; never sum or derive native percentages."""
    require(combined.get('combineByHolding') is True, 'MODE')
    require((asset.get('startDate'), asset.get('endDate')) ==
            (combined.get('startDate'), combined.get('endDate')), 'DATES')
    primary = asset['rows']['Combined']
    require(primary and len({n for n, _ in primary}) == len(primary), 'PRIMARY_ROWS')
    require(all(len(r) == 17 for _, r in primary), 'ROW_SHAPE')
    accounts = {r[3].replace('&amp;', '&') for _, r in primary}
    identities = [(r[3].replace('&amp;', '&'), *r[:3]) for _, r in primary]
    require(len(set(identities)) == len(identities), 'PRIMARY_DUPLICATE')
    group_coverage(combined)
    mappings, expanded = {}, {}
    for sheet, records in combined['rows'].items():
        seen, mapping, flat = set(), {}, []
        for n, row in records:
            require(len(row) == 17, 'ROW_SHAPE')
            names = portfolios(row[3], accounts)
            entries = [(pn, p) for pn, p in primary if p[3].replace('&amp;', '&') in names and p[:3] == row[:3]]
            require(entries and {p[3].replace('&amp;', '&') for _, p in entries} == set(names), 'MEMBERS')
            if row[0] and row[1]:
                require({pn for pn, p in primary if p[:2] == row[:2]} == {pn for pn, _ in entries}, 'PARTIAL_INSTRUMENT')
            require(not seen.intersection(pn for pn, _ in entries), 'DUPLICATE_MEMBER')
            for pn, p in entries:
                require(original(asset, 'Combined', pn, p, 4) == original(combined, sheet, n, row, 4), 'PRICE')
                require(p[16] == row[16], 'LABELS')
            for col, label in ((5, 'QUANTITY'), (6, 'VALUE'), (7, 'H'), (9, 'INCOME'), (11, 'L'), (13, 'N')):
                values = [original(asset, 'Combined', pn, p, col) for pn, p in entries]
                native = original(combined, sheet, n, row, col)
                if all(v is None for v in values):
                    require(native is None, label + '_MISSING')
                else:
                    require(native is not None and all(v is not None for v in values), label + '_MISSING')
                    require(exact_sum(values) == native, label)
            seen.update(pn for pn, _ in entries)
            mapping[n] = deepcopy(entries)
            flat.extend(deepcopy(entries))
        if sheet == 'Combined':
            require(seen == {n for n, _ in primary}, 'COVERAGE')
        mappings[sheet], expanded[sheet] = mapping, flat
    require(Counter(n for n, _ in expanded['Combined']) == Counter(n for s, rs in expanded.items() if s != 'Combined' for n, _ in rs), 'GROUP_COVERAGE')
    return dict(membersByRow=mappings, expandedRows=expanded,
                expandedRowsBasis='primary-membership-only', publicationReady=False)
