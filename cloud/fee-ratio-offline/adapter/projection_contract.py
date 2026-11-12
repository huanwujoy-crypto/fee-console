"""Fixed local pure projection bridge. No configurable executable or module path."""
import datetime as dt
import json
from pathlib import Path
import subprocess

from .bound_files import require, strict_json

NODE = '/usr/local/bin/node'
BRIDGE = Path(__file__).resolve().with_name('projection_bridge.mjs')


def project_targets(allocation, *, now, performance=None, captured_at=None):
    require(isinstance(now, dt.datetime) and now.tzinfo is not None, 'PROJECTION_CLOCK')
    payload = dict(mode='targets' if performance is None else 'validate', allocation=allocation,
                   performance=performance, performanceCapturedAt=captured_at,
                   now=now.isoformat(timespec='milliseconds').replace('+00:00', 'Z'))
    blob=json.dumps(payload,ensure_ascii=False,separators=(',', ':'),allow_nan=False).encode()
    require(len(blob)<=8*1024*1024,'PROJECTION_INPUT_SIZE')
    # No shell, ambient NODE_OPTIONS/LD_PRELOAD/PATH, credentials, configurable
    # program, network module or production command is accepted.
    result=subprocess.run([NODE,str(BRIDGE)],input=blob,capture_output=True,timeout=20,env={},cwd=str(BRIDGE.parent))
    require(result.returncode==0 and len(result.stdout)<=2*1024*1024,'PINNED_PROJECTION_REFUSED')
    answer=strict_json(result.stdout)
    require(type(answer)is dict and answer.get('state')=='PINNED_PURE_PROJECTION_PASSED'
            and answer.get('sourceOriginVerified')is False and answer.get('publicationReady')is False
            and answer.get('currentCloudCompatibilityValidated')is False,'PROJECTION_RECEIPT')
    return answer
