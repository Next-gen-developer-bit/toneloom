"""
Shared HTTP clients that bypass system proxy settings.
Local proxies often block OpenAI/Supabase with 403 or DNS errors.
"""

import httpx
from openai import AsyncOpenAI

from app.core.config import settings

_openai_http_client = httpx.AsyncClient(trust_env=False, timeout=60.0)


def get_openai_client() -> AsyncOpenAI:
    return AsyncOpenAI(
        api_key=settings.OPENAI_API_KEY,
        http_client=_openai_http_client,
    )
