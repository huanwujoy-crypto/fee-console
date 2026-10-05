"""Pinned optional evidence from the existing private archive; no new clients."""
import datetime as dt
import hashlib
import json
import re
from pathlib import Path

MAX_BYTES = 2097152
MANIFEST_BYTES = 65536
CONFIG_KEYS = ('WEEKLY_AI_MANIFEST_OBJECT', 'WEEKLY_AI_MANIFEST_GENERATION',
               'WEEKLY_AI_MANIFEST_SHA256')


def source_config(env):
    values = [env.get(key, '') for key in CONFIG_KEYS]
    if not any(values):
        return None
    name, generation, digest = values
    if (not name.startswith('weekly/') or '..' in name or
            not re.fullmatch(r'[A-Za-z0-9_./-]+\.json', name) or
            not re.fullmatch(r'[1-9][0-9]*', generation) or
            not re.fullmatch(r'[a-f0-9]{64}', digest)):
        raise ValueError('weekly_private_configuration_invalid')
    return name, int(generation), digest


def stage_private_ai_sources(bucket, directory, *, config, cutoff, deadline, clock):
    if config is None:
        return None
    name, generation, digest = config
    root = Path(directory)

    def read(object_name, limit, expected_hash, version=None):
        remaining = min(5, deadline - clock())
        if remaining <= 0:
            raise ValueError('weekly_private_deadline')
        blob = bucket.blob(object_name, generation=version) if version else bucket.blob(object_name)
        data = blob.download_as_bytes(start=0, end=limit, timeout=remaining, retry=None)
        if len(data) > limit or hashlib.sha256(data).hexdigest() != expected_hash:
            raise ValueError('weekly_private_integrity_invalid')
        return data

    raw = read(name, MANIFEST_BYTES, digest, generation)
    manifest = json.loads(raw)
    entries = manifest.get('entries')
    if (manifest.get('schema') != 'weekly-private-ai-snapshots.v1' or
            not isinstance(entries, list) or len(entries) > 6):
        raise ValueError('weekly_private_manifest_invalid')
    base = name.rsplit('/', 1)[0] + '/'
    refs = entries + ([manifest['policyPatch']] if manifest.get('policyPatch') else [])
    # Validate the complete list before any source read; the pinned manifest can
    # reference only immutable digest filenames beside itself in this archive.
    seen = set()
    for ref in refs:
        sha = ref.get('sha256', '')
        if (not re.fullmatch(r'[a-f0-9]{64}', sha) or
                ref.get('objectName') != base + sha + '.json' or
                ref.get('maxBytes') != MAX_BYTES or sha in seen):
            raise ValueError('weekly_private_manifest_invalid')
        seen.add(sha)
    for ref in refs:
        if ref in entries:
            age = (dt.date.fromisoformat(cutoff) - dt.date.fromisoformat(ref['asOf'])).days
            if not 0 <= age <= 100:
                continue
        try:
            data = read(ref['objectName'], MAX_BYTES, ref['sha256'])
            (root / (ref['sha256'] + '.json')).write_bytes(data)
        except Exception:
            # Optional source failure retains the original dated fallback.
            # Never retry, extend the enclosing deadline, or log object names.
            continue
    target = root / 'manifest.json'
    target.write_bytes(raw)
    return str(target)
