"""
ToneLoom LLM Service — rewrite, summarize, expand via OpenAI / Gemini / Claude.
"""

from typing import Optional
import re

from app.services.llm_providers import chat_completion

DEFAULT_MODEL = "gpt-4o-mini"


def _format_blueprint_block(blueprint: dict, personal: bool = False) -> str:
    """Turn a style blueprint into prompt instructions, including lexical habits."""
    rules = blueprint.get("writing_rules") or []
    if not rules:
        for h in blueprint.get("lexical_habits") or []:
            prefer = h.get("prefer")
            instead = h.get("instead_of")
            if prefer and instead and float(h.get("strength", 0)) >= 0.4:
                rules.append(f'Prefer "{prefer}" over "{instead}"')

    lines = [
        "\nThe user has a learned Style Blueprint. Apply these characteristics:",
        f"- Overall tone: {blueprint.get('tone', 'neutral')}",
        f"- Formality: {blueprint.get('formality', 'medium')}",
        f"- Average sentence length: {blueprint.get('avg_sentence_length', 'moderate')}",
        f"- Vocabulary level: {blueprint.get('vocabulary_level', 'standard')}",
        f"- Voice: {blueprint.get('voice', 'active')}",
        f"- Key phrases they like: {', '.join(blueprint.get('key_phrases', []) or []) or 'none'}",
        f"- Emoji usage: {blueprint.get('emoji_usage', 'none')}",
    ]
    if blueprint.get("contraction_rate", 0) and float(blueprint.get("contraction_rate") or 0) >= 0.03:
        lines.append("- Prefer natural contractions (I'm, don't, it's) when they fit.")
    if rules:
        lines.append("- Lexical / spelling habits (follow these exactly when informal style fits):")
        for rule in rules[:8]:
            lines.append(f"  • {rule}")
    if personal:
        lines.append(
            "- Priority: sound like THIS user. Prefer their habits over generic grammar \"corrections\"."
        )
    return "\n".join(lines)


def _is_personal_tone(tone: Optional[str]) -> bool:
    return (tone or "").lower().strip() in {"personal", "my_style", "my style", "match_me"}


async def rewrite_text(
    text: str,
    tone: str,
    blueprint: Optional[dict] = None,
    model_preference: Optional[str] = None,
) -> dict:
    use_personal = _is_personal_tone(tone)
    # Only apply learned blueprint/habits for My style — never bleed into Professional etc.
    style_blueprint = blueprint if use_personal else None

    system_parts = [
        "You are ToneLoom, a world-class writing assistant.",
        "Your job is to rewrite the user's text while preserving the original meaning.",
    ]

    if use_personal and style_blueprint:
        system_parts.append(
            "Target: match the user's personal writing style as closely as possible "
            "(not a generic professional rewrite)."
        )
        system_parts.append(_format_blueprint_block(style_blueprint, personal=True))
    elif use_personal:
        system_parts.append(
            "Target: match the user's personal writing style as closely as possible. "
            "No style blueprint is available yet — keep a natural, conversational voice."
        )
    else:
        system_parts.append(f"Target tone: {tone}.")

    rules = [
        "\nRules:",
        "- Return ONLY the rewritten text, no commentary.",
        "- Preserve the original intent and factual content.",
        "- Do not copy the input verbatim; rephrase clearly unless matching style requires keeping their wording.",
    ]
    if use_personal and style_blueprint:
        rules.append(
            '- Apply the user\'s lexical habits when listed (e.g. write "u" if they prefer it over "you").'
        )
        rules.append(
            "- Prefer their spelling/abbreviation habits over generic grammar \"corrections\"."
        )
    system_parts.append("\n".join(rules))

    response = await chat_completion(
        "\n".join(system_parts),
        f"Rewrite this text:\n\n{text}",
        model_preference=model_preference,
        temperature=0.7,
        max_tokens=2048,
    )
    return {
        "result": response["text"],
        "tokens_used": response.get("tokens_used", 0),
        "model": response.get("model", model_preference or DEFAULT_MODEL),
        "provider": response.get("provider"),
    }


async def summarize_text(text: str, model_preference: Optional[str] = None) -> dict:
    response = await chat_completion(
        (
            "You are ToneLoom, a world-class writing assistant.\n"
            "Summarize the user's text into clear, concise bullet points.\n"
            "Rules:\n"
            "- Start each point with a bullet (•)\n"
            "- Keep each point to 1-2 sentences max\n"
            "- Capture the key facts and meaning\n"
            "- Do NOT copy the input verbatim — paraphrase and compress\n"
            "- Return ONLY the summary, no commentary"
        ),
        f"Summarize this:\n\n{text}",
        model_preference=model_preference,
        temperature=0.4,
        max_tokens=1024,
    )
    return {
        "result": response["text"],
        "tokens_used": response.get("tokens_used", 0),
        "model": response.get("model", model_preference or DEFAULT_MODEL),
        "provider": response.get("provider"),
    }


async def expand_text(
    text: str,
    context: Optional[str] = None,
    blueprint: Optional[dict] = None,
    model_preference: Optional[str] = None,
) -> dict:
    user_msg = f"Expand this text into a detailed, well-structured paragraph:\n\n{text}"
    if context:
        user_msg += f"\n\nAdditional context to incorporate:\n{context}"

    system = (
        "You are ToneLoom, a world-class writing assistant.\n"
        "Expand the user's short text into a detailed, well-structured paragraph.\n"
        "Rules:\n"
        "- Add relevant detail, examples, and transitions\n"
        "- Maintain the original tone and intent\n"
        "- Result should be 3-5x longer than the input\n"
        "- Return ONLY the expanded text, no commentary"
    )
    if blueprint:
        system += _format_blueprint_block(blueprint, personal=True)
        system += (
            "\n- Write in the user's voice and follow their lexical habits when listed "
            '(e.g. prefer "u" over "you" if that is their habit).'
        )

    response = await chat_completion(
        system,
        user_msg,
        model_preference=model_preference,
        temperature=0.7,
        max_tokens=2048,
    )
    return {
        "result": response["text"],
        "tokens_used": response.get("tokens_used", 0),
        "model": response.get("model", model_preference or DEFAULT_MODEL),
        "provider": response.get("provider"),
    }


async def summarize_for_migration(
    conversation_text: str,
    target_platform: str,
    model_preference: Optional[str] = None,
) -> dict:
    """
    Return the last chat exchange so the target LLM can continue —
    no meta preamble. Gemini gets a tighter char budget.
    """
    text = _normalize_conversation_text(conversation_text)
    if not text:
        return {
            "context_prompt": "",
            "tokens_used": 0,
            "model": model_preference or DEFAULT_MODEL,
            "provider": None,
        }

    platform = (target_platform or "").lower()
    max_chars = 1800 if "gemini" in platform else 2800

    # Keep only the latest exchange so the chosen LLM continues naturally.
    recent = text[-12000:] if len(text) > 12000 else text
    context_prompt = _build_continuation_prompt(recent_dialogue=recent, max_chars=max_chars)

    return {
        "context_prompt": context_prompt,
        "tokens_used": 0,
        "model": model_preference or DEFAULT_MODEL,
        "provider": None,
    }


def _normalize_conversation_text(conversation_text: str) -> str:
    text = (conversation_text or "").strip()
    if not text:
        return ""

    # Strip memory wrappers from /migration/session saves
    if text.startswith("[Active Thread"):
        parts = text.split("\n\n", 1)
        if len(parts) == 2:
            text = parts[1].strip()

    # Prefer the verbatim dialogue block if a previous handoff wrapper is present
    so_far = re.search(
        r"=== CONVERSATION SO FAR ===\s*([\s\S]*?)\s*=== END ===",
        text,
        flags=re.IGNORECASE,
    )
    if so_far:
        text = so_far.group(1).strip()

    # Drop meta continuation instructions if they were saved into history
    text = re.sub(
        r"^You are continuing an ongoing conversation[\s\S]*?(?=User:|Assistant:|$)",
        "",
        text,
        flags=re.IGNORECASE,
    ).strip()
    text = re.sub(
        r"^Pick up EXACTLY where we left off\.[\s\S]*?(?=User:|Assistant:|$)",
        "",
        text,
        flags=re.IGNORECASE,
    ).strip()
    text = re.sub(
        r"^Quick briefing \(for orientation only\):[\s\S]*?(?=User:|Assistant:|===|$)",
        "",
        text,
        flags=re.IGNORECASE,
    ).strip()

    # Strip old migration headers; keep whatever dialogue follows
    text = re.sub(
        r"^\[ToneLoom Context Migration\]\s*",
        "",
        text,
        flags=re.IGNORECASE,
    ).strip()
    text = re.sub(
        r"^\[ToneLoom Context[^\]]*\]\s*",
        "",
        text,
        flags=re.IGNORECASE,
    ).strip()

    # Strip ChatGPT "Edit" toolbar chrome baked into older saves
    text = re.sub(r"\bEdit(?=\s*(?:Assistant|User)\s*:)", "", text, flags=re.IGNORECASE)
    text = re.sub(
        r"(^|\n)\s*Assistant:\s*Edit(?:\s*Assistant:\s*Edit)*\s*",
        r"\1Assistant: ",
        text,
        flags=re.IGNORECASE,
    )
    text = re.sub(r"\n(?:Edit|Copy|Share|Regenerate)\s*(?=\n|$)", "\n", text, flags=re.IGNORECASE)

    # Remove trailing "Continue from here:" markers
    text = re.sub(r"\n*Continue from here:\s*$", "", text, flags=re.IGNORECASE).strip()
    text = re.sub(
        r"\n*Continue from the last turn above\.?\s*$",
        "",
        text,
        flags=re.IGNORECASE,
    ).strip()

    return text


def _extract_last_exchange(dialogue: str, max_chars: int = 2800) -> str:
    """Keep only the last User + Assistant turn for handoff (LLM input limits)."""
    text = (dialogue or "").strip()
    if not text:
        return ""

    chunks = [
        c.strip()
        for c in re.split(r"(?=^\s*(?:User|Assistant):)", text, flags=re.MULTILINE)
        if c and c.strip()
    ]
    if not chunks:
        return _clamp_handoff(text, max_chars)

    last_user = -1
    last_asst = -1
    for i, chunk in enumerate(chunks):
        if re.match(r"^\s*User:", chunk, flags=re.IGNORECASE):
            last_user = i
        if re.match(r"^\s*Assistant:", chunk, flags=re.IGNORECASE):
            last_asst = i

    parts: list[str] = []
    if last_user >= 0 and (last_asst < 0 or last_user <= last_asst):
        parts.append(chunks[last_user])
    if last_asst >= 0 and last_asst != last_user:
        parts.append(chunks[last_asst])
    if not parts:
        parts.append(chunks[-1])

    return _clamp_handoff("\n\n".join(parts), max_chars)


def _clamp_handoff(text: str, max_chars: int = 2800) -> str:
    t = (text or "").strip()
    if not t:
        return ""
    if len(t) <= max_chars:
        return t

    user_m = re.match(r"^\s*User:\s*[\s\S]*?(?=\n\s*Assistant:|$)", t, flags=re.IGNORECASE)
    asst_m = re.search(r"\n\s*Assistant:\s*([\s\S]*)$", t, flags=re.IGNORECASE)
    if user_m and asst_m:
        user_part = user_m.group(0).strip()
        asst_body = asst_m.group(1).strip()

        # Reserve ~45% for assistant so Gemini/short caps keep both turns.
        asst_budget = min(len(asst_body), max(500, int(max_chars * 0.45)))
        if len(asst_body) > asst_budget:
            asst_body = f"…{asst_body[-(asst_budget - 1):]}"

        user_budget = max(300, max_chars - len(asst_body) - 24)
        if len(user_part) > user_budget:
            body = re.sub(r"^\s*User:\s*", "", user_part, flags=re.IGNORECASE).strip()
            user_part = f"User: …{body[-(user_budget - 10):]}"

        return f"{user_part}\n\nAssistant: {asst_body}".strip()

    tail = t[-(max_chars - 1) :]
    return f"…{tail}"[:max_chars]


def _build_continuation_prompt(recent_dialogue: str, max_chars: int = 2800) -> str:
    """Only the last chat exchange + short continue cue (respect LLM input limits)."""
    exchange = _extract_last_exchange(recent_dialogue, max_chars=max_chars)
    if not exchange:
        return ""
    return f"{exchange}\n\nContinue from the last turn above."
