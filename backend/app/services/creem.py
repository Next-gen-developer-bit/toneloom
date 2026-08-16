"""
Creem payment gateway client.
Docs: https://docs.creem.io
"""

from __future__ import annotations

import hashlib
import hmac
from typing import Any, Optional

import httpx

from app.core.config import settings


class CreemError(Exception):
    def __init__(self, message: str, status_code: int = 500):
        super().__init__(message)
        self.status_code = status_code


def _base_url() -> str:
    if settings.CREEM_TEST_MODE:
        return "https://test-api.creem.io/v1"
    return "https://api.creem.io/v1"


def _headers() -> dict[str, str]:
    key = (settings.CREEM_API_KEY or "").strip()
    if not key:
        raise CreemError(
            "Creem is not configured. Set CREEM_API_KEY in backend/.env.",
            status_code=503,
        )
    return {
        "x-api-key": key,
        "Content-Type": "application/json",
    }


def product_id_for_plan(plan: str) -> str:
    plan = (plan or "").lower().strip()
    mapping = {
        "pro": (settings.CREEM_PRODUCT_PRO or "").strip(),
        "pro_yearly": (settings.CREEM_PRODUCT_PRO_YEARLY or "").strip(),
        "byok": (settings.CREEM_PRODUCT_BYOK or "").strip(),
        "byok_yearly": (settings.CREEM_PRODUCT_BYOK_YEARLY or "").strip(),
        "team": (settings.CREEM_PRODUCT_TEAM or "").strip(),
    }
    product_id = mapping.get(plan, "")
    if not product_id:
        raise CreemError(
            f"Creem product id missing for plan '{plan}'. "
            f"Set the matching CREEM_PRODUCT_* env var from the Creem dashboard.",
            status_code=503,
        )
    return product_id


def plan_for_product_id(product_id: Optional[str]) -> str:
    pid = (product_id or "").strip()
    if pid and pid == (settings.CREEM_PRODUCT_PRO or "").strip():
        return "pro"
    if pid and pid == (settings.CREEM_PRODUCT_PRO_YEARLY or "").strip():
        return "pro"
    if pid and pid == (settings.CREEM_PRODUCT_BYOK or "").strip():
        return "byok"
    if pid and pid == (settings.CREEM_PRODUCT_BYOK_YEARLY or "").strip():
        return "byok"
    if pid and pid == (settings.CREEM_PRODUCT_TEAM or "").strip():
        return "team"
    return "pro"


async def create_checkout(
    *,
    product_id: str,
    customer_email: str,
    success_url: str,
    request_id: str,
    metadata: Optional[dict[str, Any]] = None,
) -> dict:
    payload: dict[str, Any] = {
        "product_id": product_id,
        "request_id": request_id,
        "success_url": success_url,
        "customer": {"email": customer_email},
        "metadata": metadata or {},
    }
    return await _request("POST", "/checkouts", json=payload)


async def create_customer_portal(customer_id: str) -> dict:
    return await _request(
        "POST",
        "/customers/billing",
        json={"customer_id": customer_id},
    )


async def _request(method: str, path: str, json: Optional[dict] = None) -> dict:
    url = f"{_base_url()}{path}"
    try:
        async with httpx.AsyncClient(timeout=45.0, trust_env=False) as client:
            response = await client.request(method, url, headers=_headers(), json=json)
    except httpx.RequestError as exc:
        raise CreemError(
            f"Could not reach Creem ({type(exc).__name__}: {exc}).",
            status_code=503,
        ) from exc

    if response.status_code in (401, 403):
        raise CreemError(
            "Creem API key is invalid. Update CREEM_API_KEY in backend/.env.",
            status_code=500,
        )
    if response.status_code == 404:
        raise CreemError(
            f"Creem resource not found ({path}). Check product/customer IDs.",
            status_code=404,
        )
    if not response.is_success:
        detail = response.text[:300]
        raise CreemError(
            f"Creem request failed ({response.status_code}): {detail}",
            status_code=502,
        )

    data = response.json()
    if not isinstance(data, dict):
        raise CreemError("Unexpected Creem response shape.", status_code=502)
    return data


def verify_webhook_signature(raw_body: bytes, signature: Optional[str]) -> bool:
    """Verify Creem HMAC-SHA256 webhook signature (creem-signature header)."""
    secret = (settings.CREEM_WEBHOOK_SECRET or "").strip()
    if not secret or not signature:
        return False
    computed = hmac.new(
        secret.encode("utf-8"),
        raw_body,
        hashlib.sha256,
    ).hexdigest()
    return hmac.compare_digest(computed, signature.strip())
