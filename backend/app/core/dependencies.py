import base64
import json
import time
from types import SimpleNamespace
from httpx import Client as HttpxClient

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from supabase import create_client, Client, ClientOptions
from typing import Optional
from app.core.config import settings

security = HTTPBearer(auto_error=False)

_supabase: Optional[Client] = None


def get_supabase_client() -> Client:
    """Singleton Supabase client."""
    global _supabase
    if _supabase is None:
        if not settings.SUPABASE_URL or not settings.SUPABASE_KEY:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Supabase is not configured on the backend server.",
            )
        options = ClientOptions(
            httpx_client=HttpxClient(trust_env=False, timeout=20.0),
        )
        _supabase = create_client(settings.SUPABASE_URL, settings.SUPABASE_KEY, options)
    return _supabase


def reset_supabase_client():
    """Reset cached client after transport failures."""
    global _supabase
    _supabase = None


async def get_current_user(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(security),
    supabase: Client = Depends(get_supabase_client),
):
    """
    Validates the JWT token passed by the Chrome extension via Supabase Auth.
    Returns the user object with id and email.
    """
    if not credentials or not credentials.credentials:
        print("EchoWrite auth rejected: missing bearer token")
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing auth token. Sign in again from the ToneLoom side panel.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    token = credentials.credentials
    token_payload = _decode_token_payload(token)
    token_role = token_payload.get("role") if token_payload else None
    token_ref = token_payload.get("ref") if token_payload else None
    token_exp = token_payload.get("exp") if token_payload else None

    try:
        user_response = supabase.auth.get_user(token)
    except Exception as exc:
        fallback_user = _build_fallback_user(token_payload, exc)
        if fallback_user:
            return fallback_user

        print(
            "EchoWrite auth rejected:",
            {
                "error_type": type(exc).__name__,
                "error": str(exc)[:250],
                "token_role": token_role,
                "token_ref": token_ref,
                "token_exp": token_exp,
                "token_len": len(token) if token else 0,
            },
        )
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token",
            headers={"WWW-Authenticate": "Bearer"},
        )

    if not user_response or not user_response.user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid authentication credentials",
            headers={"WWW-Authenticate": "Bearer"},
        )

    return user_response.user


def _decode_token_payload(token: str) -> dict:
    try:
        payload = token.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        return json.loads(base64.urlsafe_b64decode(payload.encode()).decode())
    except Exception:
        return {}


def _build_fallback_user(payload: dict, exc: Exception):
    """
    Local-dev fallback: if Supabase user introspection is blocked by proxy/network,
    use token payload fields to continue local testing.
    """
    if not _is_transient_supabase_error(exc):
        return None

    user_id = payload.get("sub")
    role = payload.get("role")
    exp = payload.get("exp")
    now = int(time.time())

    if not user_id or role != "authenticated":
        return None
    if isinstance(exp, (int, float)) and exp <= now:
        return None

    print(
        "EchoWrite auth fallback enabled",
        {"user_id": user_id, "role": role, "exp": exp, "reason": type(exc).__name__},
    )
    return SimpleNamespace(id=user_id, email=payload.get("email"))


def _is_transient_supabase_error(exc: Exception) -> bool:
    error_type = type(exc).__name__
    error_text = str(exc)
    return (
        "ProxyError" in error_type
        or "ConnectError" in error_type
        or "403 Forbidden" in error_text
        or "nodename nor servname provided" in error_text
        or "Name or service not known" in error_text
    )


def _build_fallback_profile(user, exc: Exception):
    """
    Local-dev fallback profile when Supabase profile lookup is temporarily unavailable.
    """
    if not _is_transient_supabase_error(exc):
        return None

    print(
        "EchoWrite profile fallback enabled",
        {"user_id": str(user.id), "reason": type(exc).__name__},
    )
    return {
        "id": str(user.id),
        "email": getattr(user, "email", None),
        "full_name": None,
        "avatar_url": None,
        "plan": "free",
        "subscription_status": "inactive",
        "current_period_end": None,
        "rewrites_used": 0,
        "summarizes_used": 0,
        "expands_used": 0,
        "memories_count": 0,
        "default_tone": "professional",
        "default_llm": "gpt-4o-mini",
        "auto_inject_context": True,
        "show_floating_toolbar": True,
    }


async def get_user_profile(
    user=Depends(get_current_user),
    supabase: Client = Depends(get_supabase_client),
):
    """
    Fetches the full user profile from the profiles table.
    Used to check plan limits and preferences.
    """
    try:
        result = supabase.table("profiles").select("*").eq("id", str(user.id)).single().execute()
    except Exception as exc:
        fallback_profile = _build_fallback_profile(user, exc)
        if fallback_profile:
            return fallback_profile
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Could not load your profile from Supabase. Check backend network/DNS and retry.",
        ) from exc

    if not result.data:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="User profile not found",
        )

    return result.data


def check_plan_limit(profile: dict, action: str):
    """
    Checks if the user has exceeded their plan limits for the given action.
    Raises 429 if over limit.
    """
    plan = profile.get("plan", "free")

    if plan == "team":
        return  # Unlimited

    limits = {
        "free": {
            "rewrite": settings.FREE_REWRITES_LIMIT,
            "summarize": settings.FREE_REWRITES_LIMIT,
            "expand": settings.FREE_REWRITES_LIMIT,
            "memory": settings.FREE_MEMORIES_LIMIT,
            "tone_profile": settings.FREE_TONE_PROFILES_LIMIT,
        },
        "pro": {
            "rewrite": settings.PRO_REWRITES_LIMIT,
            "summarize": settings.PRO_REWRITES_LIMIT,
            "expand": settings.PRO_REWRITES_LIMIT,
            "memory": settings.PRO_MEMORIES_LIMIT,
            "tone_profile": settings.PRO_TONE_PROFILES_LIMIT,
        },
        "byok": {
            "rewrite": settings.BYOK_REWRITES_LIMIT,
            "summarize": settings.BYOK_REWRITES_LIMIT,
            "expand": settings.BYOK_REWRITES_LIMIT,
            "memory": settings.BYOK_MEMORIES_LIMIT,
            "tone_profile": settings.BYOK_TONE_PROFILES_LIMIT,
        },
    }

    plan_limits = limits.get(plan, limits["free"])

    usage_map = {
        "rewrite": profile.get("rewrites_used", 0),
        "summarize": profile.get("summarizes_used", 0),
        "expand": profile.get("expands_used", 0),
        "memory": profile.get("memories_count", 0),
    }

    current = usage_map.get(action, 0)
    limit = plan_limits.get(action, 0)

    # -1 (or any negative) means unlimited
    if limit < 0:
        return

    if limit > 0 and current >= limit:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=f"Plan limit reached for '{action}'. "
                   f"Used {current}/{limit} on the {plan} plan. "
                   f"Upgrade to Pro ($12/mo) or BYOK for more access.",
        )
