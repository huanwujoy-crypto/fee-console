"""Publish one private fixed entry, without allowing older runs to win."""
import hashlib

ENTRY = 'weekly/latest.html'


def publish_latest(bucket, html, *, started_at, risk_date, abc_date, source):
    from google.api_core.exceptions import NotFound, PreconditionFailed
    if not source.startswith('weekly/') or not source.endswith('/report.html'):
        raise ValueError('invalid_source')
    for _ in range(3):
        blob = bucket.blob(ENTRY)
        try:
            blob.reload(timeout=30)
            old = blob.metadata or {}
            # Refuse unknown existing objects and data-date regression.
            if not all(old.get(k) for k in ('started_at', 'risk_date', 'abc_date')):
                raise ValueError('unknown_latest_metadata')
            if (old['started_at'] >= started_at or old['risk_date'] > risk_date
                    or old['abc_date'] > abc_date):
                return 'kept_newer'
            generation = int(blob.generation)
        except NotFound:
            generation = 0
        blob.metadata = dict(started_at=started_at, risk_date=risk_date,
                             abc_date=abc_date, source=source,
                             sha256=hashlib.sha256(html.encode()).hexdigest())
        blob.cache_control = 'private, no-store, max-age=0'
        try:
            blob.upload_from_string(html, content_type='text/html; charset=utf-8',
                                    if_generation_match=generation, timeout=60)
            return 'updated'
        except PreconditionFailed:
            continue
    raise RuntimeError('latest_publish_contention')
