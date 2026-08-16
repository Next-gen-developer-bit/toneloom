"""
Tone Router — Train tone from text samples, manage style blueprints.
"""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional

from app.core.dependencies import (
    get_current_user, get_user_profile, get_supabase_client,
    reset_supabase_client, _is_transient_supabase_error,
)
from app.services.tone_analyzer import extract_features, aggregate_blueprint, add_custom_habit

router = APIRouter()


class TrainRequest(BaseModel):
    text: str
    profile_id: Optional[str] = None
    source_platform: str = "unknown"


class CreateProfileRequest(BaseModel):
    name: str = "Default"


class CustomHabitRequest(BaseModel):
    prefer: str
    instead_of: str
    profile_id: Optional[str] = None


@router.post("/train")
async def train_tone(
    req: TrainRequest,
    user=Depends(get_current_user),
    profile=Depends(get_user_profile),
    supabase=Depends(get_supabase_client),
):
    """
    Analyzes a text sample, extracts stylistic features,
    and updates the user's style blueprint.
    """
    if not (req.text or "").strip() or len(req.text.strip()) < 20:
        raise HTTPException(
            status_code=400,
            detail="Tone training needs at least ~20 characters of writing.",
        )

    user_id = str(user.id)

    # Get or create the tone profile
    if req.profile_id:
        tp_result = (
            supabase.table("tone_profiles")
            .select("*")
            .eq("id", req.profile_id)
            .eq("user_id", user_id)
            .single()
            .execute()
        )
        if not tp_result.data:
            raise HTTPException(status_code=404, detail="Tone profile not found")
        tone_profile = tp_result.data
    else:
        # Find or create the default active profile
        tp_result = (
            supabase.table("tone_profiles")
            .select("*")
            .eq("user_id", user_id)
            .eq("is_active", True)
            .limit(1)
            .execute()
        )

        if tp_result.data:
            tone_profile = tp_result.data[0]
        else:
            # Prefer any existing profile (reactivate) over creating extras.
            any_result = (
                supabase.table("tone_profiles")
                .select("*")
                .eq("user_id", user_id)
                .order("created_at", desc=False)
                .limit(1)
                .execute()
            )
            if any_result.data:
                tone_profile = any_result.data[0]
                if not tone_profile.get("is_active"):
                    supabase.table("tone_profiles").update({
                        "is_active": False,
                    }).eq("user_id", user_id).execute()
                    supabase.table("tone_profiles").update({
                        "is_active": True,
                    }).eq("id", tone_profile["id"]).eq("user_id", user_id).execute()
                    tone_profile["is_active"] = True
            else:
                # Enforce profile count (check_plan_limit has no tone_profile usage field).
                count_result = (
                    supabase.table("tone_profiles")
                    .select("id", count="exact")
                    .eq("user_id", user_id)
                    .execute()
                )
                current_count = count_result.count or 0
                from app.core.config import settings
                plan = profile.get("plan", "free")
                limit = (
                    settings.FREE_TONE_PROFILES_LIMIT if plan == "free"
                    else settings.PRO_TONE_PROFILES_LIMIT if plan == "pro"
                    else -1
                )
                if limit >= 0 and current_count >= limit:
                    raise HTTPException(
                        status_code=429,
                        detail=f"Tone profile limit reached ({current_count}/{limit}). Upgrade to Pro ($12/mo) for up to 3 tone profiles.",
                    )
                create_result = (
                    supabase.table("tone_profiles")
                    .insert({
                        "user_id": user_id,
                        "name": "Default",
                        "is_active": True,
                        "blueprint": {},
                    })
                    .execute()
                )
                tone_profile = create_result.data[0]

    # Extract features from the text sample
    features = extract_features(req.text)

    # Store the sample (DB trigger also bumps samples_count)
    sample_result = supabase.table("tone_samples").insert({
        "profile_id": tone_profile["id"],
        "user_id": user_id,
        "text": req.text[:5000],  # Cap stored text at 5k chars
        "source_platform": req.source_platform,
        "features": features,
    }).execute()

    if not sample_result.data:
        raise HTTPException(status_code=500, detail="Failed to store tone sample")

    # Re-read count after trigger so UI stays accurate even if local math drifts.
    refreshed = (
        supabase.table("tone_profiles")
        .select("samples_count, blueprint")
        .eq("id", tone_profile["id"])
        .single()
        .execute()
    )
    new_sample_count = (refreshed.data or {}).get("samples_count") or (
        (tone_profile.get("samples_count") or 0) + 1
    )
    updated_blueprint = aggregate_blueprint(
        existing_blueprint=(refreshed.data or {}).get("blueprint")
        or tone_profile.get("blueprint")
        or {},
        new_features=features,
        sample_count=new_sample_count,
    )

    # Save updated blueprint + samples_count (explicit write for reliability)
    supabase.table("tone_profiles").update({
        "blueprint": updated_blueprint,
        "samples_count": new_sample_count,
    }).eq("id", tone_profile["id"]).eq("user_id", user_id).execute()

    return {
        "success": True,
        "profile_id": tone_profile["id"],
        "profile_name": tone_profile.get("name"),
        "samples_count": new_sample_count,
        "blueprint": updated_blueprint,
        "features": features,
        "learned_habits": (updated_blueprint.get("writing_rules") or [])[:8],
    }


@router.post("/habits")
async def add_habit(
    req: CustomHabitRequest,
    user=Depends(get_current_user),
    supabase=Depends(get_supabase_client),
):
    """
    Teach a custom writing habit on the active (or specified) tone profile.
    Example: prefer="tst", instead_of="taste"
    """
    prefer = (req.prefer or "").strip()
    instead = (req.instead_of or "").strip()
    if len(prefer) < 1 or len(instead) < 1:
        raise HTTPException(
            status_code=400,
            detail='Provide both forms, e.g. prefer "tst" instead of "taste".',
        )

    user_id = str(user.id)
    tone_profile = None

    if req.profile_id:
        tp_result = (
            supabase.table("tone_profiles")
            .select("*")
            .eq("id", req.profile_id)
            .eq("user_id", user_id)
            .single()
            .execute()
        )
        tone_profile = tp_result.data
    else:
        tp_result = (
            supabase.table("tone_profiles")
            .select("*")
            .eq("user_id", user_id)
            .eq("is_active", True)
            .limit(1)
            .execute()
        )
        if tp_result.data:
            tone_profile = tp_result.data[0]

    if not tone_profile:
        create_result = (
            supabase.table("tone_profiles")
            .insert({
                "user_id": user_id,
                "name": "Default",
                "is_active": True,
                "blueprint": {},
            })
            .execute()
        )
        if not create_result.data:
            raise HTTPException(status_code=500, detail="Could not create tone profile")
        tone_profile = create_result.data[0]

    updated_blueprint = add_custom_habit(
        tone_profile.get("blueprint") or {},
        prefer,
        instead,
    )
    supabase.table("tone_profiles").update({
        "blueprint": updated_blueprint,
    }).eq("id", tone_profile["id"]).eq("user_id", user_id).execute()

    return {
        "success": True,
        "profile_id": tone_profile["id"],
        "profile_name": tone_profile.get("name"),
        "blueprint": updated_blueprint,
        "learned_habits": (updated_blueprint.get("writing_rules") or [])[:8],
    }


@router.post("/analyze")
async def analyze_text(
    req: TrainRequest,
    user=Depends(get_current_user),
):
    """
    Analyzes text and returns stylistic features WITHOUT saving.
    Useful for preview before training.
    """
    features = extract_features(req.text)

    return {
        "features": features,
        "blueprint_preview": aggregate_blueprint({}, features, 1),
    }


@router.get("/profiles")
async def list_profiles(
    user=Depends(get_current_user),
    supabase=Depends(get_supabase_client),
):
    """List all tone profiles for the current user."""
    try:
        result = (
            supabase.table("tone_profiles")
            .select("id, name, is_active, samples_count, blueprint, created_at, updated_at")
            .eq("user_id", str(user.id))
            .order("created_at", desc=False)
            .execute()
        )
        return {"profiles": result.data or []}
    except Exception as exc:
        reset_supabase_client()
        if _is_transient_supabase_error(exc):
            print("EchoWrite tone list fallback:", type(exc).__name__)
            return {"profiles": []}
        raise HTTPException(status_code=503, detail="Could not load tone profiles from Supabase.") from exc


@router.post("/profiles")
async def create_profile(
    req: CreateProfileRequest,
    user=Depends(get_current_user),
    profile=Depends(get_user_profile),
    supabase=Depends(get_supabase_client),
):
    """Create a new tone profile."""
    user_id = str(user.id)

    # Check how many profiles the user has
    count_result = (
        supabase.table("tone_profiles")
        .select("id", count="exact")
        .eq("user_id", user_id)
        .execute()
    )

    current_count = count_result.count or 0
    plan = profile.get("plan", "free")

    from app.core.config import settings
    limit = (
        settings.FREE_TONE_PROFILES_LIMIT if plan == "free"
        else settings.PRO_TONE_PROFILES_LIMIT if plan == "pro"
        else -1
    )

    if limit >= 0 and current_count >= limit:
        raise HTTPException(
            status_code=429,
            detail=f"Tone profile limit reached ({current_count}/{limit}). Upgrade to Pro ($12/mo) for up to 3 tone profiles.",
        )

    result = supabase.table("tone_profiles").insert({
        "user_id": user_id,
        "name": req.name,
        "is_active": current_count == 0,  # First profile becomes active automatically
        "blueprint": {},
    }).execute()

    return {"profile": result.data[0]}


@router.put("/profiles/{profile_id}/activate")
async def activate_profile(
    profile_id: str,
    user=Depends(get_current_user),
    supabase=Depends(get_supabase_client),
):
    """Set a tone profile as the active one (deactivates others)."""
    user_id = str(user.id)

    existing = (
        supabase.table("tone_profiles")
        .select("id")
        .eq("id", profile_id)
        .eq("user_id", user_id)
        .single()
        .execute()
    )
    if not existing.data:
        raise HTTPException(status_code=404, detail="Tone profile not found")

    # Deactivate all
    supabase.table("tone_profiles").update({
        "is_active": False,
    }).eq("user_id", user_id).execute()

    # Activate the selected one
    result = (
        supabase.table("tone_profiles")
        .update({"is_active": True})
        .eq("id", profile_id)
        .eq("user_id", user_id)
        .execute()
    )

    return {"success": True, "active_profile_id": profile_id}


@router.delete("/profiles/{profile_id}")
async def delete_profile(
    profile_id: str,
    user=Depends(get_current_user),
    supabase=Depends(get_supabase_client),
):
    """Delete a tone profile and all its samples (cascade). Activate another if needed."""
    user_id = str(user.id)

    existing = (
        supabase.table("tone_profiles")
        .select("id, is_active")
        .eq("id", profile_id)
        .eq("user_id", user_id)
        .single()
        .execute()
    )
    if not existing.data:
        raise HTTPException(status_code=404, detail="Tone profile not found")

    was_active = bool(existing.data.get("is_active"))

    result = (
        supabase.table("tone_profiles")
        .delete()
        .eq("id", profile_id)
        .eq("user_id", user_id)
        .execute()
    )

    if not result.data:
        raise HTTPException(status_code=404, detail="Tone profile not found")

    if was_active:
        remaining = (
            supabase.table("tone_profiles")
            .select("id")
            .eq("user_id", user_id)
            .order("created_at", desc=False)
            .limit(1)
            .execute()
        )
        if remaining.data:
            supabase.table("tone_profiles").update({
                "is_active": True,
            }).eq("id", remaining.data[0]["id"]).eq("user_id", user_id).execute()

    return {"success": True}
