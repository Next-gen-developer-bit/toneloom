"""
Migration Router — Cross-AI context migration with LLM-powered summarization.
"""

from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.core.dependencies import (
    check_plan_limit,
    get_current_user,
    get_supabase_client,
    get_user_profile,
)
from app.services import llm
from app.services.embeddings import generate_embedding

router = APIRouter()


class SyncContextRequest(BaseModel):
    platform: str
    conversation_text: str
    source_platform: Optional[str] = "imported"


class SaveSessionRequest(BaseModel):
    platform: str
    conversation_text: str
    title: Optional[str] = None


@router.post("/sync")
async def sync_context(
    req: SyncContextRequest,
    user=Depends(get_current_user),
    profile=Depends(get_user_profile),
    supabase=Depends(get_supabase_client),
):
    """
    Takes an exported conversation, uses LLM to extract key context,
    formats it as an injection prompt for the target AI platform,
    and logs the migration.
    """
    check_plan_limit(profile, "memory")

    if not (req.conversation_text or "").strip():
        raise HTTPException(status_code=400, detail="conversation_text is required")

    # Use LLM to intelligently summarize the conversation for migration
    result = await llm.summarize_for_migration(
        conversation_text=req.conversation_text,
        target_platform=req.platform,
        model_preference=profile.get("default_llm"),
    )

    # Log the migration
    supabase.table("context_migrations").insert({
        "user_id": str(user.id),
        "source_platform": req.source_platform or "imported",
        "target_platform": req.platform,
        "original_text": req.conversation_text[:8000],
        "processed_summary": result["context_prompt"][:3000],
        "context_prompt": result["context_prompt"],
    }).execute()

    # Also store the key context as a memory for future use
    embedding = await generate_embedding(result["context_prompt"])
    supabase.table("memories").insert({
        "user_id": str(user.id),
        "content": result["context_prompt"][:3000],
        "source_platform": "migration",
        "tags": ["cross-ai", "active-thread", f"from-{req.source_platform or 'imported'}", f"to-{req.platform}"],
        "embedding": embedding,
        "importance_score": 0.9,
    }).execute()

    return {"context_prompt": result["context_prompt"]}


@router.post("/session")
async def save_session(
    req: SaveSessionRequest,
    user=Depends(get_current_user),
    profile=Depends(get_user_profile),
    supabase=Depends(get_supabase_client),
):
    """
    Persist the user's current LLM conversation so it can be continued
    on another provider after a free-tier limit / platform switch.
    """
    check_plan_limit(profile, "memory")

    text = (req.conversation_text or "").strip()
    if len(text) < 20:
        raise HTTPException(status_code=400, detail="Conversation is too short to save")

    platform = (req.platform or "unknown").lower()
    title = (req.title or f"Active thread on {platform}").strip()[:120]
    content = f"[Active Thread — {title}]\nPlatform: {platform}\n\n{text[:8000]}"

    embedding = await generate_embedding(content)

    # Keep a single "active-thread" memory: remove older ones for this user.
    try:
        existing = (
            supabase.table("memories")
            .select("id, tags")
            .eq("user_id", str(user.id))
            .contains("tags", ["active-thread"])
            .execute()
        )
        for row in existing.data or []:
            supabase.table("memories").delete().eq("id", row["id"]).eq("user_id", str(user.id)).execute()
    except Exception:
        # Tag filtering may fail on older schemas — still store the new session.
        pass

    result = supabase.table("memories").insert({
        "user_id": str(user.id),
        "content": content,
        "source_platform": platform,
        "tags": ["active-thread", "conversation", "cross-ai", f"platform:{platform}"],
        "embedding": embedding,
        "importance_score": 0.95,
    }).execute()

    if not result.data:
        raise HTTPException(status_code=500, detail="Failed to save conversation session")

    return {
        "id": result.data[0]["id"],
        "success": True,
        "platform": platform,
        "chars": len(text),
    }


@router.get("/session")
async def get_session(
    user=Depends(get_current_user),
    supabase=Depends(get_supabase_client),
):
    """Return the most recently saved active cross-LLM conversation thread."""
    try:
        tagged = (
            supabase.table("memories")
            .select("id, content, source_platform, tags, created_at, importance_score")
            .eq("user_id", str(user.id))
            .contains("tags", ["active-thread"])
            .order("created_at", desc=True)
            .limit(1)
            .execute()
        )
        if tagged.data:
            return {"session": tagged.data[0]}
    except Exception:
        pass

    # Fallback: latest cross-ai / conversation memory
    fallback = (
        supabase.table("memories")
        .select("id, content, source_platform, tags, created_at, importance_score")
        .eq("user_id", str(user.id))
        .order("created_at", desc=True)
        .limit(20)
        .execute()
    )
    for row in fallback.data or []:
        tags = row.get("tags") or []
        if "active-thread" in tags or "cross-ai" in tags or "conversation" in tags:
            return {"session": row}

    return {"session": None}


@router.get("/history")
async def migration_history(
    user=Depends(get_current_user),
    supabase=Depends(get_supabase_client),
):
    """Recent cross-AI handoffs for the side panel (full text for expand/re-open)."""
    result = (
        supabase.table("context_migrations")
        .select(
            "id, source_platform, target_platform, original_text, "
            "processed_summary, context_prompt, created_at"
        )
        .eq("user_id", str(user.id))
        .order("created_at", desc=True)
        .limit(25)
        .execute()
    )
    return {"migrations": result.data or []}


@router.post("/export")
async def export_context(
    user=Depends(get_current_user),
    supabase=Depends(get_supabase_client),
):
    """
    Exports the user's full context bundle (memories + tone blueprints)
    as a portable package that can be imported elsewhere.
    """
    # Get all memories
    memories_result = (
        supabase.table("memories")
        .select("content, source_platform, tags, created_at")
        .eq("user_id", str(user.id))
        .order("importance_score", desc=True)
        .limit(50)
        .execute()
    )

    # Get active tone blueprint
    tone_result = (
        supabase.table("tone_profiles")
        .select("name, blueprint, samples_count")
        .eq("user_id", str(user.id))
        .eq("is_active", True)
        .limit(1)
        .execute()
    )

    # Get user profile preferences
    profile_result = (
        supabase.table("profiles")
        .select("default_tone, default_llm")
        .eq("id", str(user.id))
        .single()
        .execute()
    )

    bundle = {
        "echowrite_version": "1.0.0",
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "memories": memories_result.data or [],
        "tone_profile": tone_result.data[0] if tone_result.data else None,
        "preferences": profile_result.data if profile_result.data else {},
        "total_memories": len(memories_result.data or []),
    }

    return {"bundle": bundle}
