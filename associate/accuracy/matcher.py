"""The quote matcher: is a cited quote really in the saved result?

A pure function of its inputs (issue #20, t5): no model call, no file access,
standard library only. ``.pi/extensions/associate/lib/matcher.ts`` is its twin
and both are tested against ``associate/contract/matcher_vectors.json``.

Verdicts: ``passed``, ``refused`` and ``unchecked`` (the source has no saved
text). The minimum quote length is an argument (``accuracy.json``
``min_quote_length``); this module restates no setting. A quote that is empty
after normalisation is refused as short whatever the minimum is, since the
empty string occurs in every text.

Normalisation: each line of the quote and of the saved text loses a leading
``<digits><tab>`` read line stamp, then every run of space, tab, newline,
carriage return, form feed and vertical tab becomes one space and the ends are
trimmed. Case and punctuation are never changed. Lengths and offsets count
Unicode code points.

Nearest span (only on a refusal for a quote absent from the saved text): with
``q`` the normalised quote and ``t`` the normalised saved text, ``matched`` is
the largest k such that the first k code points of ``q`` occur in ``t`` (0 when
none does), ``offset`` the lowest position in ``t`` where that k-prefix occurs
(0 when ``matched`` is 0), and ``text`` the window of ``t`` that starts at
``offset`` and is as long as ``q``, clipped at the end of ``t``. Prefix
presence is monotone in k, so a binary search over native substring search
finds it in O(n log m) even for a 2,000,000 character text.
"""

import re
from typing import Any, Optional

# re.ASCII: \d is 0-9 only, as in the TypeScript matcher (lib/matcher.ts).
_STAMP = re.compile(r"^\d+\t", re.ASCII)
_SPACE = re.compile(r"[ \t\n\r\f\v]+")


def normalise(text: str) -> str:
    """Strip read line stamps, collapse whitespace, trim. Case and punctuation stay."""
    stripped = "\n".join(_STAMP.sub("", line) for line in text.split("\n"))
    return _SPACE.sub(" ", stripped).strip(" ")


def _nearest(quote: str, text: str) -> dict[str, Any]:
    lo, hi = 0, len(quote)
    # Largest k in [0, len(quote)] with quote[:k] in text; k=0 always holds.
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if quote[:mid] in text:
            lo = mid
        else:
            hi = mid - 1
    offset = text.find(quote[:lo]) if lo else 0
    return {"offset": offset, "matched": lo, "text": text[offset : offset + len(quote)]}


def check_quote(
    quote: str,
    literal: Optional[str],
    saved_text: Optional[str],
    min_quote_length: int,
) -> dict[str, Any]:
    """Check ``quote`` (and optional ``literal``) against ``saved_text``.

    Returns ``{"verdict", "reason", "nearest"}``. ``reason`` is ``None`` on a
    pass, else ``no_saved_text`` (unchecked), ``quote_short``,
    ``quote_absent`` (with ``nearest``) or ``literal_not_in_quote``.
    """
    if saved_text is None:
        return {"verdict": "unchecked", "reason": "no_saved_text", "nearest": None}
    q = normalise(quote)
    # An empty quote is in every text: refused whatever the minimum (even 0).
    if q == "" or len(q) < min_quote_length:
        return {"verdict": "refused", "reason": "quote_short", "nearest": None}
    t = normalise(saved_text)
    if q not in t:
        return {"verdict": "refused", "reason": "quote_absent", "nearest": _nearest(q, t)}
    if literal is not None and normalise(literal) not in q:
        return {"verdict": "refused", "reason": "literal_not_in_quote", "nearest": None}
    return {"verdict": "passed", "reason": None, "nearest": None}
