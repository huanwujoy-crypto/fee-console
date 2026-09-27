"""Only compare with a genuinely earlier week using the identical method."""
import datetime as dt

def select_comparison(current_date, candidates):
    date=dt.date.fromisoformat(current_date)
    valid=[]
    for item in candidates:
        if not isinstance(item,dict):continue
        try:age=(date-dt.date.fromisoformat(item['cutoff'])).days
        except (KeyError,ValueError,TypeError):continue
        if 7<=age<=14:valid.append(item)
    return max(valid,key=lambda x:x['cutoff']) if valid else None
