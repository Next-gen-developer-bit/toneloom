"""
EchoWrite Embeddings Service — generates vector embeddings for semantic memory.

Prefers OpenAI text-embedding-3-small (1536-d). Falls back to Gemini
gemini-embedding-001 at 1536-d, then a deterministic local vector so memory
store never hard-fails when cloud embedding providers are unavailable.
"""

from __future__ import annotations

import hashlib
import math
import struct

import httpx
from fastapi import HTTPException

from app.core.config import settings
from app.services.http_clients import get_openai_client

EMBEDDING_MODEL = "text-embedding-3-small"
EMBEDDING_DIMENSIONS = 1536
GEMINI_EMBEDDING_MODEL = "gemini-embedding-001"

_http_client = httpx.AsyncClient(trust_env=False, timeout=60.0)


def _l2_normalize(values: list[float]) -> list[float]:
    norm = math.sqrt(sum(v * v for v in values)) or 1.0
    return [v / norm for v in values]


def _local_embedding(text: str) -> list[float]:
    """Deterministic 1536-d bag-of-hashes embedding for offline/dev fallback."""
    values = [0.0] * EMBEDDING_DIMENSIONS
    tokens = [t for t in "".join(ch.lower() if ch.isalnum() else " " for ch in text).split() if t]
    if not tokens:
        tokens = ["_empty_"]

    for token in tokens:
        digest = hashlib.sha256(token.encode("utf-8")).digest()
        # Expand token into several buckets for denser coverage.
        for offset in range(0, 32, 4):
            idx = struct.unpack_from(">I", digest, offset)[0] % EMBEDDING_DIMENSIONS
            sign = 1.0 if digest[offset] % 2 == 0 else -1.0
            values[idx] += sign

    return _l2_normalize(values)


async def _openai_embedding(text: str) -> list[float]:
    response = await get_openai_client().embeddings.create(
        model=EMBEDDING_MODEL,
        input=text,
        dimensions=EMBEDDING_DIMENSIONS,
    )
    return list(response.data[0].embedding)


async def _gemini_embedding(text: str) -> list[float]:
    url = (
        f"https://generativelanguage.googleapis.com/v1beta/models/"
        f"{GEMINI_EMBEDDING_MODEL}:embedContent"
    )
    payload = {
        "model": f"models/{GEMINI_EMBEDDING_MODEL}",
        "content": {"parts": [{"text": text}]},
        "outputDimensionality": EMBEDDING_DIMENSIONS,
        "taskType": "RETRIEVAL_DOCUMENT",
    }
    headers = {
        "Content-Type": "application/json",
        "x-goog-api-key": settings.GEMINI_API_KEY,
    }
    response = await _http_client.post(url, json=payload, headers=headers)
    if response.status_code in (401, 403):
        raise HTTPException(
            status_code=500,
            detail="Google Gemini API key is invalid. Update GEMINI_API_KEY in backend/.env.",
        )
    if response.status_code == 429:
        raise HTTPException(
            status_code=429,
            detail="Google Gemini embedding quota exhausted. Try again later or set OPENAI_API_KEY.",
        )
    if not response.is_success:
        raise HTTPException(
            status_code=500,
            detail=f"Gemini embedding failed ({response.status_code}): {response.text[:200]}",
        )

    data = response.json()
    values = data.get("embedding", {}).get("values")
    if not values:
        raise HTTPException(status_code=500, detail="Gemini returned an empty embedding.")

    # gemini-embedding-001 requires manual normalization when truncated.
    return _l2_normalize([float(v) for v in values[:EMBEDDING_DIMENSIONS]])


async def generate_embedding(text: str) -> list[float]:
    """Generate a 1536-d vector embedding for a piece of text."""
    truncated = text[:32000]
    errors: list[str] = []

    if settings.OPENAI_API_KEY:
        try:
            return await _openai_embedding(truncated)
        except Exception as exc:
            errors.append(f"OpenAI: {type(exc).__name__}: {str(exc)[:120]}")

    if settings.GEMINI_API_KEY:
        try:
            return await _gemini_embedding(truncated)
        except Exception as exc:
            errors.append(f"Gemini: {type(exc).__name__}: {str(exc)[:120]}")

    # Always succeed so "Save to Memory" works even when cloud providers are down.
    if errors:
        print("EchoWrite embedding fallback to local hash:", " | ".join(errors))
    return _local_embedding(truncated)
