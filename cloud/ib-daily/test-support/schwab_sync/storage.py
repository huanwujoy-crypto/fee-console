from __future__ import annotations

import json
from typing import Any

class StateConflict(RuntimeError):
    pass


class GCSStateStore:
    def __init__(self, bucket_name: str, key: str = "schwab-sync-state.json",
                 client: Any = None):
        if not bucket_name or "/" in bucket_name or not key:
            raise ValueError("STATE_BUCKET_INVALID")
        self.bucket_name = bucket_name
        self.key = key
        if client is None:
            from google.cloud import storage
            client = storage.Client()
        self.client = client

    @property
    def blob(self):
        return self.client.bucket(self.bucket_name).blob(self.key)

    def read(self) -> tuple[dict[str, Any] | None, int]:
        blob = self.blob
        if not blob.exists():
            return None, 0
        blob.reload()
        generation = int(blob.generation)
        try:
            value = json.loads(blob.download_as_text(encoding="utf-8"))
        except Exception:
            raise RuntimeError("STATE_INVALID") from None
        if not isinstance(value, dict):
            raise RuntimeError("STATE_INVALID")
        return value, generation

    def write(self, value: dict[str, Any], generation: int) -> int:
        body = json.dumps(value, ensure_ascii=False, sort_keys=True,
                          separators=(",", ":"), allow_nan=False)
        blob = self.blob
        try:
            blob.upload_from_string(
                body, content_type="application/json", if_generation_match=generation,
            )
        except Exception as exc:
            if exc.__class__.__name__ == "PreconditionFailed":
                raise StateConflict("STATE_GENERATION_CONFLICT") from None
            raise
        blob.reload()
        return int(blob.generation)


class MemoryStateStore:
    """Test store with the same generation-CAS behavior."""

    def __init__(self, value: dict[str, Any] | None = None):
        self.value = value
        self.generation = 0 if value is None else 1

    def read(self) -> tuple[dict[str, Any] | None, int]:
        return json.loads(json.dumps(self.value)) if self.value is not None else None, self.generation

    def write(self, value: dict[str, Any], generation: int) -> int:
        if generation != self.generation:
            raise StateConflict("STATE_GENERATION_CONFLICT")
        self.generation += 1
        self.value = json.loads(json.dumps(value))
        return self.generation
