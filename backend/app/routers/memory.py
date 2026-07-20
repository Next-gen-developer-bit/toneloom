"""
Memory Router — Store memories with embeddings, semantic recall via pgvector.
"""

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from typing import List, Optional

from app.core.dependencies import (
    get_current_user, get_user_profile, get_supabase_client,
    check_plan_limit, reset_supabase_client, _is_transient_supabase_error,
)
from app.services.embeddings import generate_embedding

router = APIRouter()


class StoreMemoryRequest(BaseModel):
    content: str
    source_platform: str = "unknown"
    tags: Optional[List[str]] = []


class RecallMemoryRequest(BaseModel):
    query: str
    limit: int = 5


@router.post("/store")
async def store_memory(
    req: StoreMemoryRequest,
    user=Depends(get_current_user),
    profile=Depends(get_user_profile),
    supabase=Depends(get_supabase_client),
):
    """Stores a text snippet into ContextOS long-term memory with vector embedding."""
    check_plan_limit(profile, "memory")

    if not (req.content or "").strip():
        raise HTTPException(status_code=400, detail="Nothing to save — selection was empty.")

    # Generate embedding for semantic search (never blocks save — has local fallback).
    try:
        embedding = await generate_embedding(req.content)
    except Exception as exc:
        print("EchoWrite memory store embedding error:", type(exc).__name__, str(exc)[:200])
        embedding = None

    payload = {
        "user_id": str(user.id),
        "content": req.content.strip(),
        "source_platform": req.source_platform or "unknown",
        "tags": req.tags or [],
        "importance_score": 0.5,
    }
    if embedding is not None:
        payload["embedding"] = embedding

    try:
        result = supabase.table("memories").insert(payload).execute()
    except Exception as exc:
        reset_supabase_client()
        if _is_transient_supabase_error(exc):
            raise HTTPException(
                status_code=503,
                detail="Could not save memory to Supabase. Check backend network and retry.",
            ) from exc
        raise HTTPException(status_code=500, detail=f"Failed to store memory: {str(exc)[:200]}") from exc

    if not result.data:
        raise HTTPException(status_code=500, detail="Failed to store memory")

    # Keep plan counters roughly in sync for limit checks.
    try:
        supabase.table("profiles").update({
            "memories_count": (profile.get("memories_count") or 0) + 1,
        }).eq("id", str(user.id)).execute()
    except Exception:
        pass

    return {"id": result.data[0]["id"], "success": True}


@router.post("/recall")
async def recall_memory(
    req: RecallMemoryRequest,
    user=Depends(get_current_user),
    supabase=Depends(get_supabase_client),
):
    """Semantic search for memories related to the query using pgvector."""

    try:
        query_embedding = await generate_embedding(req.query)
        result = supabase.rpc("match_memories", {
            "query_embedding": query_embedding,
            "match_user_id": str(user.id),
            "match_count": req.limit,
            "match_threshold": 0.3,
        }).execute()
        memories = result.data or []
    except Exception as exc:
        print("EchoWrite memory recall fallback:", type(exc).__name__, str(exc)[:200])
        # Fall back to most recent memories so inject/recall still work offline.
        recent = (
            supabase.table("memories")
            .select("id, content, source_platform, tags, importance_score, access_count, created_at")
            .eq("user_id", str(user.id))
            .order("created_at", desc=True)
            .limit(req.limit)
            .execute()
        )
        memories = recent.data or []

    # Touch each returned memory to track access (for predictive retention)
    for mem in memories:
        try:
            supabase.rpc("touch_memory", {"memory_id": mem["id"]}).execute()
        except Exception:
            pass

    return {"memories": memories}


@router.get("/entries")
async def list_memories(
    page: int = Query(0, ge=0),
    size: int = Query(20, ge=1, le=100),
    user=Depends(get_current_user),
    supabase=Depends(get_supabase_client),
):
    """List all memories for the current user, paginated."""
    offset = page * size

    try:
        result = (
            supabase.table("memories")
            .select("id, content, source_platform, tags, importance_score, access_count, created_at")
            .eq("user_id", str(user.id))
            .order("created_at", desc=True)
            .range(offset, offset + size - 1)
            .execute()
        )

        count_result = (
            supabase.table("memories")
            .select("id", count="exact")
            .eq("user_id", str(user.id))
            .execute()
        )
    except Exception as exc:
        reset_supabase_client()
        if _is_transient_supabase_error(exc):
            print("EchoWrite memory list fallback:", type(exc).__name__)
            return {"memories": [], "total": 0, "page": page, "size": size}
        raise HTTPException(
            status_code=503,
            detail="Could not load memories from Supabase. Check backend network and retry.",
        ) from exc

    return {
        "memories": result.data or [],
        "total": count_result.count or 0,
        "page": page,
        "size": size,
    }


@router.delete("/entries/{memory_id}")
async def delete_memory(
    memory_id: str,
    user=Depends(get_current_user),
    supabase=Depends(get_supabase_client),
):
    """Delete a specific memory. Only the owner can delete."""
    result = (
        supabase.table("memories")
        .delete()
        .eq("id", memory_id)
        .eq("user_id", str(user.id))
        .execute()
    )

    if not result.data:
        raise HTTPException(status_code=404, detail="Memory not found")

    return {"success": True}
