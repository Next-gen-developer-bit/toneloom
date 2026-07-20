"""
OpenRouter LLM router — single gateway for all chat models.

Maps EchoWrite preference IDs (Settings → Default AI Model) to OpenRouter
model slugs and calls https://openrouter.ai/api/v1/chat/completions.
"""

from __future__ import annotations

from typing import Optional

import httpx
from fastapi import HTTPException

from app.core.config import settings

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"

_http_client = httpx.AsyncClient(trust_env=False, timeout=90.0)

# EchoWrite preference id → OpenRouter model slug
# Verified against https://openrouter.ai/api/v1/models
MODEL_REGISTRY = {
    "gpt-4o": "openai/gpt-4o",
    "gpt-4o-mini": "openai/gpt-4o-mini",
    # Claude 3.5 retired on OpenRouter — map legacy id to current Sonnet
    "claude-3-5-sonnet": "anthropic/claude-sonnet-4",
    "claude-sonnet-4": "anthropic/claude-sonnet-4",
    "claude-sonnet-4.5": "anthropic/claude-sonnet-4.5",
    # Gemini family
    "gemini-3.1-flash-lite": "google/gemini-2.5-flash-lite",
    "gemini-2.5-flash-lite": "google/gemini-2.5-flash-lite",
    "gemini-2.5-flash": "google/gemini-2.5-flash",
    "gemini-flash-latest": "google/gemini-2.5-flash",
    # Legacy Gemini 2.0 ids → closest available Flash models
    "gemini-2.0-flash-lite": "google/gemini-2.5-flash-lite",
    "gemini-2.0-flash": "google/gemini-2.5-flash",
}

# Fallback order when the preferred model fails (rate limit / unavailable)
FALLBACK_ORDER = [
    "gpt-4o-mini",
    "gemini-2.5-flash-lite",
    "gemini-2.5-flash",
    "gpt-4o",
    "claude-sonnet-4",
]


class LLMProviderError(Exception):
    def __init__(self, message: str, status_code: int = 500):
        super().__init__(message)
        self.status_code = status_code


def _openrouter_configured() -> bool:
    return bool((settings.OPENROUTER_API_KEY or "").strip())


def resolve_openrouter_model(preference: Optional[str] = None) -> tuple[str, str]:
    """
    Returns (openrouter_slug, preference_id).
    Accepts EchoWrite ids or raw OpenRouter slugs (e.g. openai/gpt-4o).
    """
    pref = (preference or settings.DEFAULT_LLM or "gpt-4o-mini").strip()
    if "/" in pref:
        return pref, pref
    slug = MODEL_REGISTRY.get(pref)
    if slug:
        return slug, pref
    # Unknown preference — use default
    default = settings.DEFAULT_LLM or "gpt-4o-mini"
    if "/" in default:
        return default, default
    return MODEL_REGISTRY.get(default, "openai/gpt-4o-mini"), default


def resolve_model_candidates(preference: Optional[str] = None) -> list[tuple[str, str]]:
    """Return [(openrouter_slug, preference_id), ...] in try order."""
    ordered: list[str] = []
    if preference:
        ordered.append(preference.strip())
    if settings.DEFAULT_LLM:
        ordered.append(settings.DEFAULT_LLM.strip())
    ordered.extend(FALLBACK_ORDER)

    seen: set[str] = set()
    candidates: list[tuple[str, str]] = []
    for pref in ordered:
        if not pref or pref in seen:
            continue
        seen.add(pref)
        slug, pref_id = resolve_openrouter_model(pref)
        # Dedupe by slug too
        if any(c[0] == slug for c in candidates):
            continue
        candidates.append((slug, pref_id))
    return candidates


def resolve_model(preference: Optional[str] = None) -> tuple[str, str, str]:
    """
    Compatibility helper: returns (provider, api_model, preference_id).
    Provider is always "openrouter" when configured.
    """
    if not _openrouter_configured():
        raise LLMProviderError(
            "No LLM provider configured. Add OPENROUTER_API_KEY in backend/.env "
            "and restart the server.",
            status_code=500,
        )
    slug, pref_id = resolve_openrouter_model(preference)
    return "openrouter", slug, pref_id


async def chat_completion(
    system_prompt: str,
    user_prompt: str,
    *,
    model_preference: Optional[str] = None,
    temperature: float = 0.7,
    max_tokens: int = 2048,
) -> dict:
    if not _openrouter_configured():
        raise LLMProviderError(
            "No LLM provider configured. Add OPENROUTER_API_KEY in backend/.env "
            "and restart the server.",
            status_code=500,
        )

    candidates = resolve_model_candidates(model_preference)
    failures: list[str] = []

    for slug, preference_id in candidates:
        try:
            result = await _openrouter_chat(
                system_prompt, user_prompt, slug, temperature, max_tokens
            )
            result["provider"] = "openrouter"
            result["model"] = preference_id
            result["openrouter_model"] = slug
            return result
        except LLMProviderError as exc:
            if exc.status_code in (429, 503):
                failures.append(f"{slug}: {exc}")
                continue
            raise

    detail = " | ".join(failures) if failures else "All OpenRouter models failed."
    raise LLMProviderError(
        f"All OpenRouter models failed. {detail}",
        status_code=429
        if any("quota" in f.lower() or "rate" in f.lower() for f in failures)
        else 503,
    )


def raise_http_for_llm_error(exc: Exception):
    if isinstance(exc, LLMProviderError):
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
    if isinstance(exc, HTTPException):
        raise exc
    raise HTTPException(status_code=500, detail=f"AI request failed: {str(exc)[:200]}") from exc


async def _openrouter_chat(
    system_prompt: str,
    user_prompt: str,
    model: str,
    temperature: float,
    max_tokens: int,
) -> dict:
    headers = {
        "Authorization": f"Bearer {settings.OPENROUTER_API_KEY.strip()}",
        "Content-Type": "application/json",
        "HTTP-Referer": (settings.FRONTEND_URL or settings.OPENROUTER_SITE_URL or "https://echowrite.app").strip(),
        "X-Title": (settings.OPENROUTER_APP_NAME or "EchoWrite").strip(),
    }
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "temperature": temperature,
        "max_tokens": max_tokens,
    }

    try:
        response = await _http_client.post(OPENROUTER_URL, json=payload, headers=headers)
    except httpx.RequestError as exc:
        raise LLMProviderError(
            f"Could not reach OpenRouter ({type(exc).__name__}: {exc}). "
            "Check internet/VPN/proxy settings.",
            status_code=503,
        ) from exc

    if response.status_code in (401, 403):
        raise LLMProviderError(
            "OpenRouter API key is invalid. Update OPENROUTER_API_KEY in backend/.env.",
            status_code=500,
        )
    if response.status_code == 429:
        raise LLMProviderError(
            "OpenRouter rate limit / quota reached. Try again shortly or add credits.",
            status_code=429,
        )
    if response.status_code == 404:
        raise LLMProviderError(
            f"OpenRouter model not found: {model}. Pick another model in Settings.",
            status_code=503,
        )
    if not response.is_success:
        detail = response.text[:300]
        # Model temporarily unavailable → allow failover
        if response.status_code in (502, 503, 524):
            raise LLMProviderError(
                f"OpenRouter model unavailable ({response.status_code}): {detail}",
                status_code=503,
            )
        raise LLMProviderError(
            f"OpenRouter request failed ({response.status_code}): {detail}",
            status_code=500,
        )

    data = response.json()
    try:
        text = (data["choices"][0]["message"]["content"] or "").strip()
    except (KeyError, IndexError, TypeError, AttributeError) as exc:
        raise LLMProviderError(
            f"OpenRouter ({model}) returned an empty response.",
            status_code=503,
        ) from exc

    cleaned = text.strip().strip("*•-–—").strip()
    if len(cleaned) < 1:
        raise LLMProviderError(
            f"OpenRouter ({model}) returned an unusable response.",
            status_code=503,
        )

    usage = data.get("usage") or {}
    tokens_used = usage.get("total_tokens") or (
        (usage.get("prompt_tokens") or 0) + (usage.get("completion_tokens") or 0)
    )
    return {"text": text, "tokens_used": int(tokens_used or 0)}
