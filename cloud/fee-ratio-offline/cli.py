"""Process boundary for the offline complete-original assembler.

    /usr/bin/python3 -I -B cli.py            -> {"state":"DISABLED"}; no stdin read, no file IO
    /usr/bin/python3 -I -B cli.py --enabled  -> reads one ratio-offline-workbook-batch.v1 request
                                                from stdin and prints one JSON line

The request is the only caller input. No scope, clock, verifier, executable,
module path or authentication flag is accepted here or passed on. Success
carries the exact bytes of the assembled original and their SHA-256; it is an
unauthenticated candidate (every readiness flag stays false), never a
publication or a provider-observation proof. Failures print a fixed code only.
"""
import base64
import hashlib
import json
from pathlib import Path
import re
import sys

MAX_REQUEST = 1024 * 1024
MAX_ORIGINAL = 5 * 1024 * 1024  # the intake's own bound
SCHEMA = 'fee-console.ratio-offline-assembly.v1'
FALSE_FLAGS = ('sourceOriginVerified', 'fullPerformanceReady', 'publicationReady', 'productionEnabled',
               'currentCloudCompatibilityValidated')


def _refused(code):
    code = code if isinstance(code, str) and re.fullmatch(r'OFFLINE_[A-Z0-9_]{1,64}', code) else 'OFFLINE_REFUSED'
    return dict(schema=SCHEMA, state='REFUSED', code=code, publicationReady=False, productionEnabled=False)


def main(argv, read_stdin):
    """Return (exit_code, result dict). `read_stdin` is called only when enabled."""
    if argv == []:
        return 0, dict(schema=SCHEMA, state='DISABLED', publicationReady=False, productionEnabled=False)
    if argv != ['--enabled']:
        return 2, _refused('OFFLINE_ARGUMENT')
    try:
        blob = read_stdin(MAX_REQUEST + 1)
        if not isinstance(blob, bytes) or not 0 < len(blob) <= MAX_REQUEST:
            return 1, _refused('OFFLINE_REQUEST_SIZE')
        here = str(Path(__file__).resolve().parent)
        if here not in sys.path:
            sys.path.insert(0, here)  # fixed location of this file; never caller supplied
        from adapter.bound_files import strict_json
        from adapter.performance_assembly import prepare_offline_performance
        request = strict_json(blob)
        result = prepare_offline_performance(request, enabled=True)
        if (not isinstance(result, dict) or result.get('state') != 'OFFLINE_COMPLETE_ORIGINAL_CANDIDATE'
                or any(result.get(name) is not False for name in FALSE_FLAGS)
                or result.get('originalLibraryIdentityPending') is not True
                or result.get('uploads') != 0 or result.get('publications') != 0):
            return 1, _refused('OFFLINE_RESULT_CONTRACT')
        original = json.dumps(result['original'], ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode('utf-8')
        if not 0 < len(original) <= MAX_ORIGINAL:
            return 1, _refused('OFFLINE_ORIGINAL_SIZE')
        answer = dict(schema=SCHEMA, state='OFFLINE_COMPLETE_ORIGINAL_CANDIDATE',
                      originalBase64=base64.b64encode(original).decode('ascii'),
                      originalBytes=len(original), originalSha256=hashlib.sha256(original).hexdigest(),
                      targetDate=request.get('targetDate'), codeReferenceBase=result.get('codeReferenceBase'),
                      originalLibraryIdentityPending=True, blockedOn=list(result.get('blockedOn') or []),
                      uploads=0, publications=0)
        for name in FALSE_FLAGS:
            answer[name] = False
        return 0, answer
    except ValueError as error:
        return 1, _refused(str(error))
    except Exception:  # never expose paths, values or tracebacks
        return 1, _refused('OFFLINE_REFUSED')


if __name__ == '__main__':
    code, out = main(sys.argv[1:], sys.stdin.buffer.read)
    sys.stdout.write(json.dumps(out, ensure_ascii=True, separators=(',', ':')) + '\n')
    sys.exit(code)
