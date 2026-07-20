"""
Local writing fallbacks used when every cloud LLM provider is unavailable
(quota exhausted, missing keys, network blocked).

These are extractive/compression heuristics — not a substitute for a real model,
but they must shorten and rephrase instead of copy-pasting the selection.
"""

from __future__ import annotations

import re


FILLER_PHRASES = [
    r"\bit said\b",
    r"\bhe said\b",
    r"\bshe said\b",
    r"\bthey said\b",
    r"\baccording to[^.]*?\b",
    r"\bin order to\b",
    r"\bas a result of\b",
    r"\bdue to the fact that\b",
    r"\bat this point in time\b",
    r"\bin the national capital\b",
    r"\bin terms of\b",
    r"\bthe fact that\b",
    r"\bit is important to note that\b",
    r"\bneedless to say\b",
]


def _sentences(text: str) -> list[str]:
    parts = re.split(r"(?<=[.!?])\s+", text.strip())
    return [p.strip() for p in parts if p.strip()]


def _compress_sentence(sentence: str) -> str:
    s = sentence.strip()
    s = re.sub(r"\s+", " ", s)
    for pattern in FILLER_PHRASES:
        s = re.sub(pattern, " ", s, flags=re.IGNORECASE)
    s = re.sub(r"\s+", " ", s).strip(" ,;")

    # Drop leading conjunctions / weak openers after filler removal.
    s = re.sub(r"^(and|but|so|because|while|whereas)\s+", "", s, flags=re.IGNORECASE)

    # Keep first clause if the sentence is very long.
    if len(s) > 160:
        clause = re.split(r",\s+|;\s+|\s+—\s+|\s+-\s+", s)[0].strip()
        if len(clause) >= 40:
            s = clause

    if s and s[0].islower():
        s = s[0].upper() + s[1:]
    if s and s[-1] not in ".!?":
        s += "."
    return s


def _score_sentence(sentence: str, index: int, total: int) -> float:
    words = re.findall(r"[A-Za-z0-9']+", sentence)
    length = len(words)
    # Prefer informative mid-length sentences; boost opener slightly.
    length_score = 1.0 if 8 <= length <= 28 else 0.55 if length >= 5 else 0.2
    position_score = 1.0 if index == 0 else (0.85 if index == total - 1 else 0.7)
    digit_bonus = 0.15 if re.search(r"\d", sentence) else 0.0
    return length_score + position_score + digit_bonus


def local_summarize(text: str) -> str:
    raw = (text or "").strip()
    if not raw:
        return "• (empty selection)"

    sentences = _sentences(raw)
    if not sentences:
        return "• (empty selection)"

    # Short selection: compress into 1 condensed bullet, never echo verbatim.
    if len(sentences) == 1 or len(raw) < 220:
        compressed = _compress_sentence(sentences[0])
        # If compression barely changed anything, force a tighter rewrite.
        if compressed.lower().rstrip(".") == sentences[0].lower().rstrip("."):
            words = re.findall(r"[A-Za-z0-9'%-]+", sentences[0])
            keep = words[: min(18, max(8, len(words) // 2))] or words
            compressed = " ".join(keep)
            if compressed and compressed[0].islower():
                compressed = compressed[0].upper() + compressed[1:]
            compressed = compressed.rstrip(".,;:") + "."
        return f"• {compressed}"

    ranked = sorted(
        ((i, s) for i, s in enumerate(sentences)),
        key=lambda item: _score_sentence(item[1], item[0], len(sentences)),
        reverse=True,
    )
    max_bullets = 3 if len(sentences) <= 6 else 4
    picked = sorted(ranked[:max_bullets], key=lambda item: item[0])

    bullets: list[str] = []
    seen: set[str] = set()
    for _, sentence in picked:
        compressed = _compress_sentence(sentence)
        key = compressed.lower()
        if key in seen or len(compressed) < 12:
            continue
        seen.add(key)
        bullets.append(f"• {compressed}")

    if not bullets:
        return f"• {_compress_sentence(sentences[0])}"
    return "\n".join(bullets)


def _apply_lexical_habits(text: str, blueprint: dict | None) -> str:
    """Best-effort local application of learned prefer/instead_of pairs."""
    if not blueprint or not text:
        return text
    habits = blueprint.get("lexical_habits") or []
    if not habits:
        return text
    out = text
    # Strongest habits first; only whole-word formal → informal swaps.
    ranked = sorted(habits, key=lambda h: float(h.get("strength", 0)), reverse=True)
    for h in ranked[:8]:
        prefer = (h.get("prefer") or "").strip()
        instead = (h.get("instead_of") or "").strip()
        strength = float(h.get("strength", 0))
        if not prefer or not instead or strength < 0.4:
            continue
        if " " in instead or "/" in instead:
            out = re.sub(re.escape(instead), prefer, out, flags=re.IGNORECASE)
        else:
            out = re.sub(rf"(?<!\w){re.escape(instead)}(?!\w)", prefer, out, flags=re.IGNORECASE)
    return out


def local_rewrite(text: str, tone: str = "professional", blueprint: dict | None = None) -> str:
    cleaned = re.sub(r"\s+", " ", (text or "").strip())
    if not cleaned:
        return text

    tone = (tone or "professional").lower().strip()
    personal = tone in {"personal", "my_style", "my style", "match_me"}

    if personal and blueprint:
        # Keep their voice: apply habits, light cleanup only.
        body = _apply_lexical_habits(cleaned, blueprint)
        return body

    sentences = [_compress_sentence(s) for s in _sentences(cleaned)]
    body = " ".join(s for s in sentences if s) or cleaned

    if tone == "concise":
        return " ".join(sentences[:2]) if sentences else body

    wrappers = {
        "professional": "In short: {body}",
        "formal": "To summarize the point: {body}",
        "casual": "Basically: {body}",
        "friendly": "Quick take: {body}",
        "persuasive": "The key takeaway: {body}",
    }
    template = wrappers.get(tone, "Rewritten: {body}")
    return template.format(body=body)


def local_expand(text: str, context: str | None = None) -> str:
    base = (text or "").strip()
    if not base:
        return text

    core = _compress_sentence(_sentences(base)[0] if _sentences(base) else base)
    parts = [
        core,
        "This matters because it affects cost, reliability, and day-to-day user experience.",
        "A clearer next step is to separate the core claim, the supporting evidence, and the practical impact for readers.",
    ]
    if context:
        parts.append(f"Additional context to keep in mind: {context.strip()}")
    return " ".join(parts)
