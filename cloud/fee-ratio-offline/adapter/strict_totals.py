"""No historical tolerance, file allowlist, or reconciliation override."""
from decimal import Decimal
import hashlib


def source_hash(blob):
    if not isinstance(blob, bytes):
        raise ValueError('IMMUTABLE_SOURCE_BYTES_REQUIRED')
    return hashlib.sha256(blob).hexdigest()


def reconcile(row_sum, footer, **_source_coordinates):
    a, b = Decimal(str(row_sum)), Decimal(str(footer))
    if not a.is_finite() or not b.is_finite() or a != b:
        raise ValueError('STRICT_NATIVE_TOTAL_MISMATCH')
    return None
