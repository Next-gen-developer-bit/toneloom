"""
Writing Router — Rewrite, Summarize, Expand with multi-provider LLM calls.
"""

import time
from fastapi import APIRouter, Depends
from pydantic import BaseModel
from typing import Optional

from app.core.dependencies import (
    get_current_user, get_user_profile, get_supabase_client,
    check_plan_limit,
)
from app.services import llm
from app.services.llm_providers import LLMProviderError, raise_http_for_llm_error
from app.services.local_writing import local_expand, local_rewrite, local_summarize

router = APIRouter()


class RewriteRequest(BaseModel):
    text: str
    tone: str = "professional"
    tone_profile_id: Optional[str] = None


class SummarizeRequest(BaseModel):
    text: str


class ExpandRequest(BaseModel):
    text: str
    context: Optional[str] = None
    tone_profile_id: Optional[str] = None


def _load_blueprint(supabase, user_id: str, tone_profile_id: Optional[str]):
    if not tone_profile_id:
        return None
    try:
        tp_result = (
            supabase.table("tone_profiles")
            .select("blueprint")
            .eq("id", tone_profile_id)
            .eq("user_id", user_id)
            .single()
            .execute()
        )
        if tp_result.data:
            return tp_result.data.get("blueprint")
    except Exception:
        return None
    return None


def _preferred_model(profile: dict) -> Optional[str]:
    """User's Settings → Default AI Model (OpenRouter-backed preference id)."""
    preferred = (profile.get("default_llm") or "").strip() or None
    return preferred


def _record_usage(supabase, user_id: str, profile: dict, action: str, result: dict, latency: int, input_text: str):
    usage_field = {
        "rewrite": "rewrites_used",
        "summarize": "summarizes_used",
        "expand": "expands_used",
    }.get(action)

    try:
        if usage_field:
            supabase.table("profiles").update({
                usage_field: profile.get(usage_field, 0) + 1,
            }).eq("id", user_id).execute()

        supabase.table("usage_logs").insert({
            "user_id": user_id,
            "action": action,
            "tokens_used": result.get("tokens_used", 0),
            "model_used": result.get("model", "unknown"),
            "input_length": len(input_text),
            "output_length": len(result.get("result", "")),
            "latency_ms": latency,
        }).execute()
    except Exception as exc:
        print("EchoWrite usage logging skipped:", type(exc).__name__, str(exc)[:120])


def _with_local_fallback(action: str, exc: Exception, local_result: str) -> dict:
    """When cloud LLMs are quota/network blocked, still return a usable result."""
    if isinstance(exc, LLMProviderError) and exc.status_code in (429, 503):
        print(f"EchoWrite {action} using local fallback:", str(exc)[:180])
        return {
            "result": local_result,
            "tokens_used": 0,
            "model": "local-fallback",
            "provider": "local",
        }
    raise_http_for_llm_error(exc)


@router.post("/rewrite")
async def rewrite_text(
    req: RewriteRequest,
    user=Depends(get_current_user),
    profile=Depends(get_user_profile),
    supabase=Depends(get_supabase_client),
):
    """Rewrites text according to the specified tone or user's style blueprint."""
    check_plan_limit(profile, "rewrite")

    # Blueprint only matters for My style; skip the DB hit for preset tones.
    use_personal = (req.tone or "").lower().strip() in {
        "personal", "my_style", "my style", "match_me",
    }
    blueprint = (
        _load_blueprint(supabase, str(user.id), req.tone_profile_id)
        if use_personal
        else None
    )

    start = time.time()
    try:
        result = await llm.rewrite_text(
            req.text,
            req.tone,
            blueprint=blueprint,
            model_preference=_preferred_model(profile),
        )
    except Exception as exc:
        result = _with_local_fallback(
            "rewrite",
            exc,
            local_rewrite(req.text, req.tone, blueprint=blueprint),
        )
    latency = int((time.time() - start) * 1000)

    _record_usage(supabase, str(user.id), profile, "rewrite", result, latency, req.text)
    return {"result": result["result"], "model": result.get("model"), "provider": result.get("provider")}


@router.post("/summarize")
async def summarize_text(
    req: SummarizeRequest,
    user=Depends(get_current_user),
    profile=Depends(get_user_profile),
    supabase=Depends(get_supabase_client),
):
    """Summarizes text into key points."""
    check_plan_limit(profile, "summarize")

    start = time.time()
    try:
        result = await llm.summarize_text(req.text, model_preference=_preferred_model(profile))
    except Exception as exc:
        result = _with_local_fallback("summarize", exc, local_summarize(req.text))
    latency = int((time.time() - start) * 1000)

    _record_usage(supabase, str(user.id), profile, "summarize", result, latency, req.text)
    return {"result": result["result"], "model": result.get("model"), "provider": result.get("provider")}


@router.post("/expand")
async def expand_text(
    req: ExpandRequest,
    user=Depends(get_current_user),
    profile=Depends(get_user_profile),
    supabase=Depends(get_supabase_client),
):
    """Expands a short text into a detailed paragraph."""
    check_plan_limit(profile, "expand")

    blueprint = _load_blueprint(supabase, str(user.id), req.tone_profile_id)

    start = time.time()
    try:
        result = await llm.expand_text(
            req.text,
            context=req.context,
            blueprint=blueprint,
            model_preference=_preferred_model(profile),
        )
    except Exception as exc:
        result = _with_local_fallback(
            "expand",
            exc,
            local_expand(req.text, req.context),
        )
    latency = int((time.time() - start) * 1000)

    _record_usage(supabase, str(user.id), profile, "expand", result, latency, req.text)
    return {"result": result["result"], "model": result.get("model"), "provider": result.get("provider")}
