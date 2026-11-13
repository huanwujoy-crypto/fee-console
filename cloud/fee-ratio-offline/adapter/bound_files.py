"""Read immutable, actual Library-bound bytes. Never create or repair identity."""
import hashlib
import json
import math
import os
from pathlib import Path
import re
import stat

MAX_BYTES = 20 * 1024 * 1024


def require(ok, code):
    if not ok:
        raise ValueError('OFFLINE_' + code)


def strict_json(blob):
    def pairs(items):
        out = {}
        for key, value in items:
            require(key not in out, 'DUPLICATE_JSON_KEY')
            out[key] = value
        return out
    def constant(_):
        raise ValueError('OFFLINE_NONFINITE_JSON')
    result = json.loads(blob, object_pairs_hook=pairs, parse_constant=constant)
    def finite(value):
        if isinstance(value, float):
            require(math.isfinite(value), 'NONFINITE_JSON')
        elif isinstance(value, dict):
            for item in value.values():
                finite(item)
        elif isinstance(value, list):
            for item in value:
                finite(item)
    finite(result)
    return result


def read_bound_file(spec):
    require(type(spec) is dict and set(spec) == {'path', 'libraryFileId', 'libraryVersion', 'sha256'}, 'BINDING_FIELDS')
    require(isinstance(spec['path'], str) and Path(spec['path']).is_absolute(), 'ABSOLUTE_PATH')
    require(isinstance(spec['libraryFileId'], str) and re.fullmatch(r'libfile_[a-f0-9]{32}', spec['libraryFileId']), 'LIBRARY_ID')
    require(type(spec['libraryVersion']) is int and spec['libraryVersion'] >= 0, 'LIBRARY_VERSION')
    require(isinstance(spec['sha256'], str) and re.fullmatch(r'[a-f0-9]{64}', spec['sha256']), 'SOURCE_HASH')
    require(hasattr(os, 'getxattr') and hasattr(os, 'O_NOFOLLOW'), 'IDENTITY_READER_UNAVAILABLE')
    parts = Path(spec['path']).parts
    require('..' not in parts and len(parts) > 1, 'PATH')
    directory, fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY), None
    try:
        for part in parts[1:-1]:
            nxt = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            os.close(directory)
            directory = nxt
        fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and before.st_uid == os.getuid() and before.st_nlink == 1
                and before.st_mode & 0o777 == 0o600 and 0 < before.st_size <= MAX_BYTES, 'PRIVATE_FILE')
        expected = (spec['libraryFileId'], str(spec['libraryVersion']))
        def attrs():
            return tuple(os.getxattr(fd, name).decode('utf-8') for name in ('user.library-file-id', 'user.library-file-version'))
        require(attrs() == expected, 'LIBRARY_IDENTITY')
        with os.fdopen(fd, 'rb', closefd=False) as stream:
            blob = stream.read(MAX_BYTES + 1)
        after = os.fstat(fd)
        fingerprint = lambda st: (st.st_dev, st.st_ino, st.st_uid, st.st_mode, st.st_nlink, st.st_size, st.st_mtime_ns, st.st_ctime_ns)
        require(fingerprint(before) == fingerprint(after) and len(blob) == before.st_size and attrs() == expected, 'SOURCE_CHANGED')
        require(hashlib.sha256(blob).hexdigest() == spec['sha256'], 'SOURCE_HASH')
        return blob
    finally:
        if fd is not None:
            os.close(fd)
        os.close(directory)
