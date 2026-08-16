"""
Profile Router — authenticated account, usage, limits, and preferences.
"""

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.core.config import settings
from app.core.dependencies import get_current_user, get_user_profile, get_supabase_client

router = APIRouter()


class PreferencesUpdate(BaseModel):
    default_tone: Optional[str] = None
    default_llm: Optional[str] = None
    auto_inject_context: Optional[bool] = None
    show_floating_toolbar: Optional[bool] = None


def plan_limits(plan: str) -> dict:
    if plan == "team":
        return {"rewrites": -1, "memories": -1, "tone_profiles": -1}
    if plan == "pro":
        return {
            "rewrites": settings.PRO_REWRITES_LIMIT,
            "memories": settings.PRO_MEMORIES_LIMIT,
            "tone_profiles": settings.PRO_TONE_PROFILES_LIMIT,
        }
    if plan == "byok":
        return {
            "rewrites": settings.BYOK_REWRITES_LIMIT,
            "memories": settings.BYOK_MEMORIES_LIMIT,
            "tone_profiles": settings.BYOK_TONE_PROFILES_LIMIT,
        }
    return {
        "rewrites": settings.FREE_REWRITES_LIMIT,
        "memories": settings.FREE_MEMORIES_LIMIT,
        "tone_profiles": settings.FREE_TONE_PROFILES_LIMIT,
    }


def serialize_profile(profile: dict) -> dict:
    plan = profile.get("plan", "free")
    return {
        "id": profile["id"],
        "email": profile.get("email"),
        "full_name": profile.get("full_name"),
        "avatar_url": profile.get("avatar_url"),
        "plan": plan,
        "subscription_status": profile.get("subscription_status", "inactive"),
        "current_period_end": profile.get("current_period_end"),
        "rewrites_used": profile.get("rewrites_used", 0),
        "summarizes_used": profile.get("summarizes_used", 0),
        "expands_used": profile.get("expands_used", 0),
        "memories_count": profile.get("memories_count", 0),
        "preferences": {
            "default_tone": profile.get("default_tone", "professional"),
            "default_llm": profile.get("default_llm", "gpt-4o-mini"),
            "auto_inject_context": profile.get("auto_inject_context", True),
            "show_floating_toolbar": profile.get("show_floating_toolbar", True),
        },
        "limits": plan_limits(plan),
    }


@router.get("/me")
async def get_profile(profile=Depends(get_user_profile)):
    """Return the current user's profile, preferences, usage, and limits."""
    return serialize_profile(profile)


@router.patch("/preferences")
async def update_preferences(
    req: PreferencesUpdate,
    user=Depends(get_current_user),
    supabase=Depends(get_supabase_client),
):
    """Update user preferences used by the extension runtime."""
    update_data = req.model_dump(exclude_unset=True)
    if not update_data:
        raise HTTPException(status_code=400, detail="No preferences provided")

    result = (
        supabase.table("profiles")
        .update(update_data)
        .eq("id", str(user.id))
        .execute()
    )

    if not result.data:
        raise HTTPException(status_code=404, detail="User profile not found")

    return serialize_profile(result.data[0])
