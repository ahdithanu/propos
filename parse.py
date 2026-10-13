"""Turning model output into a prediction, strictly.

The product needs parseable JSON. So this never guesses a label out of free
text: output that is not JSON is a failed prediction, and how often that
happens is reported as its own number.
"""

import json
import re
from dataclasses import dataclass

from prompt import DISPATCHES, URGENCIES

_FENCE = re.compile(r"^\s*```(?:json)?\s*\n?(.*?)\n?\s*```\s*$", re.DOTALL | re.IGNORECASE)


@dataclass(frozen=True)
class Parsed:
    urgency: str | None
    dispatch: str | None
    draft_reply: str | None
    # "strict": the whole output was a JSON object. "fenced": it was one wrapped
    # in a markdown code fence. "invalid": neither.
    json_status: str


def _label(value, allowed):
    if not isinstance(value, str):
        return None
    value = value.strip().lower()
    return value if value in allowed else None


def parse_output(text):
    """Parse one model response. Never raises."""
    if not isinstance(text, str):
        return Parsed(None, None, None, "invalid")
    status = "strict"
    try:
        obj = json.loads(text.strip())
    except (ValueError, TypeError):
        fenced = _FENCE.match(text)
        if not fenced:
            return Parsed(None, None, None, "invalid")
        try:
            obj = json.loads(fenced.group(1).strip())
        except (ValueError, TypeError):
            return Parsed(None, None, None, "invalid")
        status = "fenced"
    if not isinstance(obj, dict):
        return Parsed(None, None, None, "invalid")
    reply = obj.get("draft_reply")
    return Parsed(
        urgency=_label(obj.get("urgency"), URGENCIES),
        dispatch=_label(obj.get("dispatch"), DISPATCHES),
        draft_reply=reply if isinstance(reply, str) else None,
        json_status=status,
    )
