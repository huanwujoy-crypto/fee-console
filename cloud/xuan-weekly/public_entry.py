"""Owner-authorized final report only; raw bucket remains private."""
from latest import publish_latest

PUBLIC_BUCKET = 'family-portfolio-gateway-xuan-weekly-public'

def publish_public(client, bucket_name, html, *, started_at, risk_date, abc_date):
    if bucket_name != PUBLIC_BUCKET:
        raise ValueError('wrong_public_bucket')
    # Only the finished rendered HTML, never the bundle or source receipts.
    if not isinstance(html, str) or not html.startswith('<!doctype html>'):
        raise ValueError('invalid_report_html')
    if '<script' in html.lower() or '<iframe' in html.lower():
        raise ValueError('active_report_html')
    html = html.replace('私密记录 · 不下单、不转账','记录与分析 · 不下单、不转账')
    return publish_latest(client.bucket(bucket_name),html,started_at=started_at,
        risk_date=risk_date,abc_date=abc_date,source='weekly/public/report.html')
