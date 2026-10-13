import json

import pytest

import eval as ev


def fake(outputs, fail_on=()):
    """A stand-in for the endpoint: canned outputs by message, and a clock that ticks 0.5 s per request."""
    def complete(message):
        if message in fail_on:
            raise TimeoutError("request timed out")
        return outputs.get(message, '{"urgency": "routine", "dispatch": "none", "draft_reply": "ok"}'), 100, 20
    return complete


class Clock:
    def __init__(self, step):
        self.t, self.step = 0.0, step

    def __call__(self):
        self.t += self.step
        return self.t


EXAMPLES = [
    {"input": "gas smell", "urgency": "emergency", "dispatch": "plumber"},
    {"input": "no heat", "urgency": "urgent", "dispatch": "hvac"},
    {"input": "scuff", "urgency": "routine"},
    {"input": "flood", "urgency": "emergency", "dispatch": "plumber"},
]
OUTPUTS = {
    "gas smell": '{"urgency": "emergency", "dispatch": "plumber", "draft_reply": "Leave now."}',
    "no heat": '```json\n{"urgency": "emergency", "dispatch": "hvac", "draft_reply": "On it."}\n```',
    "flood": "It is an emergency! Send a plumber.",
}


def test_a_run_scores_quality_format_latency_and_cost():
    results, first, wall = ev.run_eval(fake(OUTPUTS), EXAMPLES, clock=Clock(0.25))
    s = ev.summarize(results, first, wall, concurrency=1, gpu_price_per_min=0.012)

    assert s["examples"] == 4 and s["errors"] == 0
    assert s["urgency_accuracy"] == 0.5                       # gas and scuff right; no-heat wrong; flood unparseable
    assert s["emergency_recall"] == 0.5 and s["emergency_support"] == 2
    assert s["dispatch_accuracy"] == pytest.approx(2 / 3) and s["dispatch_scored"] == 3
    assert (s["json_strict_rate"], s["json_fenced_rate"], s["json_invalid_rate"]) == (0.5, 0.25, 0.25)
    assert s["urgency_confusion"]["emergency"] == {"emergency": 1, "urgent": 0, "routine": 0, "(none)": 1}
    assert s["first_request_s"] == 0.25                      # the warm-up is timed but kept out of the stats
    assert s["latency_p50_s"] == 0.25 and s["p95_is_just_the_max"] is True
    assert s["prompt_tokens"] == 400 and s["completion_tokens"] == 80
    assert s["cost_per_1k_warm_usd"] > 0


def test_the_flood_message_is_not_rescued_by_spotting_the_word_emergency():
    results, _, _ = ev.run_eval(fake(OUTPUTS), EXAMPLES, warmup=False)
    flood = results[3]
    assert flood["predicted_urgency"] is None and flood["json_status"] == "invalid"


def test_one_failed_request_is_recorded_and_the_run_continues():
    results, _, wall = ev.run_eval(fake(OUTPUTS, fail_on={"no heat"}), EXAMPLES, warmup=False)
    s = ev.summarize(results, None, wall, 1)
    assert [bool(r["error"]) for r in results] == [False, True, False, False]
    assert results[1]["error"] == "TimeoutError: request timed out"
    assert s["errors"] == 1 and s["json_invalid_rate"] == 0.5
    assert s["first_request_s"] is None


def test_concurrent_runs_keep_results_in_input_order():
    results, _, _ = ev.run_eval(fake(OUTPUTS), EXAMPLES * 5, concurrency=4, warmup=False)
    assert [r["input"] for r in results] == [e["input"] for e in EXAMPLES * 5]


def test_report_prints_without_error_and_flags_small_samples(capsys):
    results, first, wall = ev.run_eval(fake(OUTPUTS), EXAMPLES, clock=Clock(0.25))
    ev.print_report(ev.summarize(results, first, wall, 1), results)
    out = capsys.readouterr().out
    assert "emergency recall:   50.0%  (of 2 emergencies)" in out
    assert "too few samples" in out
    assert "misses (2):" in out


@pytest.mark.parametrize("line,message", [
    ('{"input": "x", "urgency": "critical"}', "urgency must be one of"),
    ('{"input": "x", "urgency": "urgent", "dispatch": "wizard"}', "dispatch must be one of"),
    ('{"urgency": "urgent"}', "missing 'input'"),
    ('{"input": "  ", "urgency": "urgent"}', "missing 'input'"),
    ("not json", "not valid JSON"),
])
def test_bad_data_is_rejected_with_the_line_number(tmp_path, line, message):
    path = tmp_path / "d.jsonl"
    path.write_text('{"input": "ok", "urgency": "routine"}\n' + line + "\n")
    with pytest.raises(ValueError, match=f"line 2: {message}"):
        ev.load_examples(str(path))


def test_empty_data_is_rejected_and_blank_lines_are_skipped(tmp_path):
    empty = tmp_path / "e.jsonl"
    empty.write_text("\n\n")
    with pytest.raises(ValueError, match="no examples"):
        ev.load_examples(str(empty))
    ok = tmp_path / "ok.jsonl"
    ok.write_text('\n{"input": "a", "urgency": "routine"}\n\n')
    assert len(ev.load_examples(str(ok))) == 1


def test_the_shipped_examples_load():
    examples = ev.load_examples("data/eval_examples.jsonl")
    assert len(examples) >= 3
    assert all(json.dumps(e) for e in examples)
