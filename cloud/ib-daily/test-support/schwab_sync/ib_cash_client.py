from datetime import datetime, date, timedelta, time
from zoneinfo import ZoneInfo
NY = ZoneInfo("America/New_York")

def latest_completed_weekday(now: datetime) -> date:
    """Use a completed NY regular close, never tomorrow's date in Hong Kong."""
    if now.tzinfo is None:
        raise IBCashError("IB_CASH_CLOCK_INVALID")
    local = now.astimezone(NY)
    target = local.date()
    if local.time() < time(16):
        target -= timedelta(days=1)
    while target.weekday() > 4:
        target -= timedelta(days=1)
    return target
