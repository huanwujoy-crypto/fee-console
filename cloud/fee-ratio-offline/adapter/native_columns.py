"""Pure native percentage parsing. No source identity or publication authority."""
import io
import calendar
import collections
import datetime as dt
import decimal
import hashlib
import json
import re
import zipfile
import xml.etree.ElementTree as ET
from .official_workbooks import HEADERS, NS, workbook, data
D = decimal.Decimal
SCHEMA = 'fee-console.ratio-performance-source.v1'
DATE_RE = '\\d{1,2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \\d{4}'
TITLE_RE = re.compile('Showing performance by 资产类别 between dates (' + DATE_RE + ') to (' + DATE_RE + ')')
CANON = lambda v: json.dumps(v, ensure_ascii=False, sort_keys=True, separators=(',', ':'))

def require(condition, code):
    if not condition:
        raise ValueError('PERFORMANCE_' + code)

def digest(value):
    return hashlib.sha256(value).hexdigest()

def iso(value):
    require(isinstance(value, str), 'DATE')
    try:
        day = dt.date.fromisoformat(value)
    except ValueError:
        raise ValueError('PERFORMANCE_DATE') from None
    require(day.isoformat() == value, 'DATE')
    return day

def prior_year(value):
    day = iso(value)
    return day.replace(year=day.year - 1, day=min(day.day, calendar.monthrange(day.year - 1, day.month)[1])).isoformat()

def cell_formats(file):
    """Only interpret explicitly supported percentage formats; never execute XML."""
    result = {}
    with zipfile.ZipFile(io.BytesIO(file) if isinstance(file, bytes) else file) as z:
        formats = {0: 'General', 9: '0%', 10: '0.00%'}
        styles = [0]
        if 'xl/styles.xml' in z.namelist():
            root = ET.fromstring(z.read('xl/styles.xml'))
            for n in root.findall('s:numFmts/s:numFmt', NS):
                ident = int(n.attrib['numFmtId'])
                require(ident not in formats, 'STYLE_DUPLICATE')
                formats[ident] = n.attrib['formatCode']
            styles = [int(n.attrib.get('numFmtId', '0')) for n in root.findall('s:cellXfs/s:xf', NS)]
        rels = {r.attrib['Id']: r.attrib['Target'] for r in ET.fromstring(z.read('xl/_rels/workbook.xml.rels'))}
        for sheet in ET.fromstring(z.read('xl/workbook.xml')).findall('s:sheets/s:sheet', NS):
            require(sheet.attrib['name'] not in result, 'DUPLICATE_SHEET')
            target = rels[sheet.attrib['{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id']]
            path = target.lstrip('/') if target.startswith('/') else 'xl/' + target
            require('..' not in path.split('/') and path.startswith('xl/worksheets/'), 'SHEET_PATH')
            cells = {}
            for c in ET.fromstring(z.read(path)).findall('s:sheetData/s:row/s:c', NS):
                index = int(c.attrib.get('s', '0'))
                require(0 <= index < len(styles), 'STYLE_INDEX')
                cells[c.attrib['r']] = formats.get(styles[index], 'unsupported')
            result[sheet.attrib['name']] = cells
    return result

def native_percentage(value, number_format):
    """Return the source unit and numeric magnitude, not a calculated return."""
    if value is None or value in ('', '-', '—', 'N/A'):
        return (None, 'unavailable', 'Official Return Percentage cell has no value')
    if isinstance(value, str):
        match = re.fullmatch('([+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+))\\s*%\\s*(p\\.a\\.)?', value.strip())
        require(match is not None, 'PERCENTAGE_TEXT')
        return (float(D(match[1])), 'p.a.' if match[2] else 'unknown', 'Official Return Percentage text cell' + (' explicitly says % p.a.' if match[2] else ' has no annualisation unit'))
    require(type(value) in (int, float) and D(str(value)).is_finite(), 'PERCENTAGE_VALUE')
    if number_format == 'General':
        return (value, 'unknown', 'Official Return Percentage numeric cell has no annualisation unit')
    match = re.fullmatch('(?:#,##)?0(?:\\.0+)?%(?:\\s*"(p\\.a\\.)")?', number_format)
    require(match is not None, 'PERCENTAGE_FORMAT')
    return (float(D(str(value)) * 100), 'p.a.' if match[1] else 'unknown', 'Official cell format ' + number_format)
