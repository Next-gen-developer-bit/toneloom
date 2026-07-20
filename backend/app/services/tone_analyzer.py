"""
EchoWrite Tone Analyzer — extracts stylistic features from text samples and
builds/updates a Style Blueprint for personalized writing.

Learns both macro tone (casual/professional) and micro habits
(e.g. "u" instead of "you", "tho" instead of "though").
"""

import re
import math
from collections import Counter


# Informal abbreviation → formal spelling. Count both sides in samples.
# Avoid single-letter tokens (r/are, n/and) — too many false positives.
LEXICAL_PAIRS = [
    ("u", "you"),
    ("ur", "your"),
    ("ure", "you're"),
    ("tho", "though"),
    ("thru", "through"),
    ("bc", "because"),
    ("cuz", "because"),
    ("gonna", "going to"),
    ("wanna", "want to"),
    ("gotta", "got to"),
    ("kinda", "kind of"),
    ("sorta", "sort of"),
    ("idk", "i don't know"),
    ("imo", "in my opinion"),
    ("tbh", "to be honest"),
    ("btw", "by the way"),
    ("rn", "right now"),
    ("np", "no problem"),
    ("pls", "please"),
    ("plz", "please"),
    ("thx", "thanks"),
    ("ty", "thank you"),
    ("msg", "message"),
    ("tmrw", "tomorrow"),
    ("tmr", "tomorrow"),
    ("w/", "with"),
    ("w/o", "without"),
]


def extract_features(text: str) -> dict:
    """
    Extract quantitative stylistic features from a text sample.
    Pure Python NLP — no external NLP libraries needed.
    """
    sentences = re.split(r'[.!?]+', text)
    sentences = [s.strip() for s in sentences if s.strip()]
    words = text.split()
    word_count = len(words)
    sentence_count = max(len(sentences), 1)

    # Unique words / total words
    unique_words = set(w.lower().strip(".,!?;:\"'()[]{}") for w in words)
    vocabulary_richness = round(len(unique_words) / max(word_count, 1), 3)

    # Average word length (proxy for vocabulary complexity)
    avg_word_length = round(
        sum(len(w.strip(".,!?;:\"'()[]{}")) for w in words) / max(word_count, 1), 2
    )

    # Formality markers
    formal_markers = [
        "therefore", "furthermore", "consequently", "moreover", "nevertheless",
        "accordingly", "hence", "thus", "regarding", "pursuant", "hereby",
        "kindly", "please note", "as per", "as discussed", "i would like",
        "respectfully", "sincerely", "dear", "attached herewith",
    ]
    informal_markers = [
        "hey", "hi", "gonna", "wanna", "gotta", "lol", "haha", "btw",
        "tbh", "imo", "np", "cool", "awesome", "yeah", "nah", "stuff",
        "thing", "like", "super", "totally", "kinda", "sorta",
        "u", "ur", "tho", "pls", "plz", "thx", "idk", "rn",
    ]

    text_lower = text.lower()
    formal_count = sum(1 for m in formal_markers if _count_token(text_lower, m) > 0)
    informal_count = sum(1 for m in informal_markers if _count_token(text_lower, m) > 0)

    formality_score = round(
        min(1.0, max(0.0, 0.5 + (formal_count - informal_count) * 0.1)), 2
    )

    # Detect passive voice (rough heuristic: "was/were/been/being + past participle")
    passive_patterns = len(re.findall(
        r'\b(was|were|been|being|is|are)\s+\w+ed\b', text_lower
    ))
    active_ratio = round(1.0 - min(passive_patterns / max(sentence_count, 1), 1.0), 2)

    # Emoji detection
    emoji_pattern = re.compile(
        "[\U0001F600-\U0001F64F\U0001F300-\U0001F5FF\U0001F680-\U0001F6FF"
        "\U0001F1E0-\U0001F1FF\U00002702-\U000027B0\U0001F900-\U0001F9FF"
        "\U0001FA00-\U0001FA6F\U0001FA70-\U0001FAFF\U00002600-\U000026FF]+",
        flags=re.UNICODE,
    )
    emoji_count = len(emoji_pattern.findall(text))

    # Extract repeated phrases (2-3 word ngrams appearing 2+ times)
    key_phrases = _extract_key_phrases(text_lower, words)

    # Lexical habits: prefer "u" over "you", contractions, etc.
    lexical_habits = _extract_lexical_habits(text)

    # Contraction rate (I'm, don't, it's…)
    contraction_count = len(re.findall(r"\b\w+'\w+\b", text))
    contraction_rate = round(contraction_count / max(word_count, 1), 3)

    # Classify tone
    tone_labels = []
    if formality_score >= 0.7:
        tone_labels.append("professional")
    elif formality_score >= 0.5:
        tone_labels.append("neutral")
    else:
        tone_labels.append("casual")

    avg_sent_len = round(word_count / sentence_count, 1)
    if avg_sent_len < 12:
        tone_labels.append("concise")
    elif avg_sent_len > 22:
        tone_labels.append("elaborate")

    if active_ratio > 0.8:
        tone_labels.append("direct")

    if lexical_habits:
        tone_labels.append("abbreviated")

    return {
        "word_count": word_count,
        "sentence_count": sentence_count,
        "avg_sentence_length": avg_sent_len,
        "avg_word_length": avg_word_length,
        "vocabulary_richness": vocabulary_richness,
        "formality_score": formality_score,
        "active_voice_ratio": active_ratio,
        "emoji_count": emoji_count,
        "tone_labels": tone_labels,
        "key_phrases": key_phrases[:10],
        "lexical_habits": lexical_habits,
        "contraction_rate": contraction_rate,
    }


def _count_token(text_lower: str, token: str) -> int:
    """Count whole-token occurrences (handles multi-word and slash forms)."""
    token = token.lower().strip()
    if not token:
        return 0
    if " " in token or "/" in token:
        return len(re.findall(re.escape(token), text_lower))
    return len(re.findall(rf"(?<!\w){re.escape(token)}(?!\w)", text_lower))


def _extract_lexical_habits(text: str) -> list[dict]:
    """
    Detect spelling/abbreviation preferences from a sample.
    Returns habits like {prefer: "u", instead_of: "you", strength: 0.8}.
    """
    text_lower = text.lower()
    habits: list[dict] = []

    for informal, formal in LEXICAL_PAIRS:
        informal_count = _count_token(text_lower, informal)
        formal_count = _count_token(text_lower, formal)
        total = informal_count + formal_count
        if informal_count <= 0 or total < 1:
            continue
        strength = round(informal_count / total, 2)
        if strength < 0.4 and informal_count < 2:
            continue
        habits.append({
            "prefer": informal,
            "instead_of": formal,
            "informal_count": informal_count,
            "formal_count": formal_count,
            "strength": strength,
        })

    habits.sort(key=lambda h: (h["strength"], h["informal_count"]), reverse=True)
    return habits[:12]


def _extract_key_phrases(text_lower: str, words: list) -> list[str]:
    """Extract frequently used 2-3 word phrases."""
    clean_words = [w.strip(".,!?;:\"'()[]{}") for w in words]
    bigrams = [f"{clean_words[i]} {clean_words[i+1]}" for i in range(len(clean_words) - 1)]
    trigrams = [
        f"{clean_words[i]} {clean_words[i+1]} {clean_words[i+2]}"
        for i in range(len(clean_words) - 2)
    ]

    phrase_counts = Counter(bigrams + trigrams)
    stop_phrases = {"the the", "a the", "in the", "of the", "to the", "and the", "is a", "it is"}
    key = [
        phrase for phrase, count in phrase_counts.most_common(20)
        if count >= 2 and phrase not in stop_phrases and len(phrase) > 5
    ]
    return key


def aggregate_blueprint(existing_blueprint: dict, new_features: dict, sample_count: int) -> dict:
    """
    Merge new sample features into an existing style blueprint using
    exponential moving average so recent samples have more weight.
    """
    if sample_count <= 1:
        return {
            "tone": new_features["tone_labels"][0] if new_features["tone_labels"] else "neutral",
            "formality": _formality_label(new_features["formality_score"]),
            "avg_sentence_length": new_features["avg_sentence_length"],
            "avg_word_length": new_features["avg_word_length"],
            "vocabulary_level": _vocab_label(new_features["avg_word_length"]),
            "vocabulary_richness": new_features["vocabulary_richness"],
            "voice": "active" if new_features["active_voice_ratio"] > 0.6 else "mixed",
            "key_phrases": new_features["key_phrases"][:8],
            "emoji_usage": "frequent" if new_features["emoji_count"] > 2 else (
                "occasional" if new_features["emoji_count"] > 0 else "none"
            ),
            "emoji_rate": round(new_features["emoji_count"] / max(new_features["sentence_count"], 1), 3),
            "formality_score": new_features["formality_score"],
            "active_voice_ratio": new_features["active_voice_ratio"],
            "confidence_score": 0.3,
            "lexical_habits": new_features.get("lexical_habits", [])[:8],
            "contraction_rate": new_features.get("contraction_rate", 0),
            "writing_rules": _habits_to_rules(new_features.get("lexical_habits", [])),
        }

    alpha = max(0.15, 1.0 / sample_count)
    ema = lambda old, new: round(old * (1 - alpha) + new * alpha, 3)

    bp = existing_blueprint.copy()
    bp["avg_sentence_length"] = ema(
        bp.get("avg_sentence_length", 15), new_features["avg_sentence_length"]
    )
    bp["avg_word_length"] = ema(
        bp.get("avg_word_length", 4.5), new_features.get("avg_word_length", 4.5)
    )
    bp["formality_score"] = ema(
        bp.get("formality_score", 0.5), new_features["formality_score"]
    )
    bp["active_voice_ratio"] = ema(
        bp.get("active_voice_ratio", 0.7), new_features["active_voice_ratio"]
    )
    bp["vocabulary_richness"] = ema(
        bp.get("vocabulary_richness", 0.5), new_features["vocabulary_richness"]
    )
    bp["contraction_rate"] = ema(
        bp.get("contraction_rate", 0), new_features.get("contraction_rate", 0)
    )
    sample_emoji_rate = round(
        new_features["emoji_count"] / max(new_features["sentence_count"], 1), 3
    )
    bp["emoji_rate"] = ema(bp.get("emoji_rate", 0), sample_emoji_rate)
    bp["emoji_usage"] = (
        "frequent" if bp["emoji_rate"] >= 0.4
        else "occasional" if bp["emoji_rate"] > 0
        else "none"
    )

    bp["formality"] = _formality_label(bp["formality_score"])
    # Derive tone from EMA formality so one casual sample doesn't flip a pro profile.
    if bp["formality_score"] >= 0.7:
        bp["tone"] = "professional"
    elif bp["formality_score"] >= 0.5:
        bp["tone"] = "neutral"
    else:
        bp["tone"] = "casual"
    bp["voice"] = "active" if bp["active_voice_ratio"] > 0.6 else "mixed"
    bp["vocabulary_level"] = _vocab_label(bp["avg_word_length"])

    existing_phrases = bp.get("key_phrases", [])
    merged = list(dict.fromkeys(new_features["key_phrases"] + existing_phrases))[:8]
    bp["key_phrases"] = merged

    bp["lexical_habits"] = _merge_habits(
        bp.get("lexical_habits", []),
        new_features.get("lexical_habits", []),
        alpha,
    )
    bp["writing_rules"] = _habits_to_rules(bp["lexical_habits"])

    bp["confidence_score"] = round(1.0 - math.exp(-sample_count / 5), 2)

    return bp


def _merge_habits(existing: list, new_habits: list, alpha: float) -> list[dict]:
    """EMA-merge habit strengths; keep top habits the user consistently uses."""
    by_key: dict[tuple, dict] = {}
    for h in existing or []:
        key = (str(h.get("prefer", "")).lower(), str(h.get("instead_of", "")).lower())
        if key[0]:
            by_key[key] = dict(h)

    for h in new_habits or []:
        key = (str(h.get("prefer", "")).lower(), str(h.get("instead_of", "")).lower())
        if not key[0]:
            continue
        if key in by_key:
            old = by_key[key]
            old_strength = float(old.get("strength", 0.5))
            new_strength = float(h.get("strength", 0.5))
            old["strength"] = round(old_strength * (1 - alpha) + new_strength * alpha, 2)
            old["informal_count"] = int(old.get("informal_count", 0)) + int(h.get("informal_count", 0))
            old["formal_count"] = int(old.get("formal_count", 0)) + int(h.get("formal_count", 0))
            by_key[key] = old
        else:
            by_key[key] = dict(h)

    merged = list(by_key.values())
    merged.sort(
        key=lambda h: (float(h.get("strength", 0)), int(h.get("informal_count", 0))),
        reverse=True,
    )
    return [h for h in merged if float(h.get("strength", 0)) >= 0.35][:10]


def _habits_to_rules(habits: list) -> list[str]:
    """Human-readable rules for the rewrite prompt / UI."""
    rules = []
    for h in (habits or [])[:8]:
        prefer = h.get("prefer")
        instead = h.get("instead_of")
        strength = float(h.get("strength", 0))
        if not prefer or not instead or strength < 0.4:
            continue
        rules.append(f'Prefer "{prefer}" over "{instead}"')
    return rules


def _formality_label(score: float) -> str:
    if score >= 0.75:
        return "high"
    elif score >= 0.45:
        return "medium"
    return "low"


def _vocab_label(avg_word_length: float) -> str:
    if avg_word_length >= 6.0:
        return "advanced"
    elif avg_word_length >= 4.5:
        return "standard"
    return "simple"
