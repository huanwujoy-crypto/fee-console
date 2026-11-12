"""Pure bounded XML numeric cells; caller first runs workbook validation."""
import io, re, zipfile
from decimal import Decimal
import xml.etree.ElementTree as ET
from .official_workbooks import NS

def require(ok,code):
    if not ok: raise ValueError("NATIVE_"+code)

def number(value):
    result=Decimal(str(value))
    require(result.is_finite(), "NONFINITE")
    return result

def numeric_cells(path):
    """Preserve exact XML decimals, including differences rounded away by float."""
    out = {}
    with zipfile.ZipFile(io.BytesIO(path)) as z:
        rels = {r.attrib['Id']: r.attrib['Target'] for r in ET.fromstring(z.read('xl/_rels/workbook.xml.rels'))}
        for sheet in ET.fromstring(z.read('xl/workbook.xml')).findall('s:sheets/s:sheet', NS):
            target = rels[sheet.attrib['{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id']]
            location = target.lstrip('/') if target.startswith('/') else 'xl/' + target
            require('..' not in location.split('/') and location.startswith('xl/worksheets/'), 'SHEET_PATH')
            cells = {}
            for cell in ET.fromstring(z.read(location)).findall('s:sheetData/s:row/s:c', NS):
                value = cell.find('s:v', NS)
                if cell.attrib.get('t', 'n') == 'n' and value is not None and (value.text is not None):
                    number = Decimal(value.text)
                    require(number.is_finite(), 'NUMBER')
                    cells[cell.attrib['r']] = number
            out[sheet.attrib['name']] = cells
    return out
