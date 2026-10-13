import pytest

from parse import parse_output


def test_plain_json_is_strict():
    p = parse_output('{"urgency": "Emergency ", "draft_reply": "On it.", "dispatch": "plumber"}')
    assert (p.urgency, p.dispatch, p.draft_reply, p.json_status) == ("emergency", "plumber", "On it.", "strict")


@pytest.mark.parametrize("text", [
    '```json\n{"urgency": "urgent", "dispatch": "hvac", "draft_reply": "x"}\n```',
    '```\n{"urgency": "urgent", "dispatch": "hvac", "draft_reply": "x"}\n```',
    '  ```JSON\n{"urgency": "urgent", "dispatch": "hvac", "draft_reply": "x"}```  ',
])
def test_fenced_json_is_accepted_but_counted_separately(text):
    p = parse_output(text)
    assert (p.urgency, p.json_status) == ("urgent", "fenced")


@pytest.mark.parametrize("text", [
    "This is an emergency, send a plumber.",
    'Sure! Here is the JSON: {"urgency": "routine"}',
    '{"urgency": "routine"',
    "[1, 2]",
    '"emergency"',
    "",
    None,
    42,
])
def test_anything_else_is_invalid_and_never_guessed_from_words(text):
    p = parse_output(text)
    assert (p.urgency, p.dispatch, p.json_status) == (None, None, "invalid")


def test_a_label_word_inside_the_reply_does_not_leak_into_the_prediction():
    p = parse_output('{"urgency": "routine", "draft_reply": "This is not an emergency.", "dispatch": "none"}')
    assert p.urgency == "routine"


@pytest.mark.parametrize("obj", [
    '{"urgency": "critical", "dispatch": "plumber"}',
    '{"urgency": ["emergency"], "dispatch": 3}',
    '{"dispatch": "wizard"}',
])
def test_unknown_or_malformed_labels_become_none_but_json_still_counts_as_valid(obj):
    p = parse_output(obj)
    assert p.json_status == "strict"
    assert p.urgency is None
    assert p.dispatch in (None, "plumber")
