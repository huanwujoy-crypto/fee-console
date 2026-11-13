"""Test support only: run the real cli.main under the fabricated fixture.

    connection_helper.py prepare <dir> [combined|uncombined][+assembler-fixture]
        builds the fabricated ten-workbook / five-capture / inception batch
        under <dir> and prints the request plus the synthetic clock and scope.
        By default the IB-HK label holds only stock-class positions so the
        batch is acceptable to the existing snapshot book model;
        `+assembler-fixture` keeps the assembler's own unmodified fixture
    connection_helper.py run <dir>
        reads the request from stdin and runs cli.main(['--enabled'], ...)
        in-process with the same test-only substitutions the assembler's own
        unit tests use: an inode -> identity map instead of real xattrs, the
        fabricated account scope digest, and the fixture clock

Nothing here creates identity attributes, reads a real source, or is imported
by production code. It exists so a Node test can consume the assembler's
actual output bytes across the real process boundary.
"""
import datetime as dt
import json
import os
from pathlib import Path
import sys
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

from adapter import offline_adapter as oa  # noqa: E402
import full_performance_fixture as full_fixture  # noqa: E402
from full_performance_fixture import full_batch, NOW  # noqa: E402
import cli  # noqa: E402


class Clock(dt.datetime):
    @classmethod
    def now(cls, tz=None):
        return cls.fromtimestamp(NOW.timestamp(), tz=tz or dt.timezone.utc)


FUND_CATEGORIES = ('VC/PE', '对冲基金', '常青基金')


def _downstream_rows(original):
    """Same fabricated rows, but IB-HK holds only stock-class positions.

    The assembler's own fixture deals accounts round-robin, which gives the
    IB-HK label a hedge-fund position. The existing snapshot book model
    accepts only stock classes (or 主题投资 / 防御资产) for IB-HK, so that
    fixture is refused downstream. Swapping two account labels keeps every
    amount, instrument and member count identical.
    """
    def rows():
        out = original()
        for row in out:
            if row[3] == 'IB-HK' and row[15] in FUND_CATEGORIES:
                other = next(r for r in out if r[15] in full_fixture.STOCK_CATEGORIES and r[3] not in ('IB-HK', 'NOAH-HK'))
                row[3], other[3] = other[3], row[3]
        return out
    return rows


def prepare(root, combined, downstream=True):
    if downstream:
        with patch.object(full_fixture, 'native_rows', _downstream_rows(full_fixture.native_rows)):
            request, identities, scope = full_batch(Path(root), combined=combined)
    else:
        request, identities, scope = full_batch(Path(root), combined=combined)
    state = dict(identities={str(k): list(v) for k, v in identities.items()}, scope=scope)
    Path(root, 'helper-state.json').write_text(json.dumps(state))
    return dict(request=request, scope=scope,
                now=NOW.astimezone(dt.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z'))


def run(root):
    state = json.loads(Path(root, 'helper-state.json').read_text())
    identities = {int(k): v for k, v in state['identities'].items()}

    def attrs(fd, name):
        return identities[os.fstat(fd).st_ino][0 if name == 'user.library-file-id' else 1].encode()

    patches = [patch('adapter.bound_files.os.getxattr', side_effect=attrs),
               patch('adapter.bound_files.os.setxattr', side_effect=AssertionError('never create identity')),
               patch.object(oa, 'ALL_TOGETHER_SCOPE_SHA256', state['scope']),
               patch('adapter.performance_assembly.dt.datetime', Clock),
               patch('socket.socket', side_effect=AssertionError('no Python network'))]
    for p in patches:
        p.start()
    try:
        return cli.main(['--enabled'], sys.stdin.buffer.read)
    finally:
        for p in reversed(patches):
            p.stop()


if __name__ == '__main__':
    if len(sys.argv) >= 3 and sys.argv[1] == 'prepare':
        layout = sys.argv[3] if len(sys.argv) > 3 else 'combined'
        print(json.dumps(prepare(sys.argv[2], not layout.startswith('uncombined'), downstream=not layout.endswith('+assembler-fixture'))))
    elif len(sys.argv) == 3 and sys.argv[1] == 'run':
        code, out = run(sys.argv[2])
        sys.stdout.write(json.dumps(out, ensure_ascii=True, separators=(',', ':')) + '\n')
        sys.exit(code)
    else:
        sys.exit(2)
