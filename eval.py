#!/usr/bin/env python3
"""Eval harness for the Baseten-deployed triage model.

Runs labeled tenant messages against the model's OpenAI-compatible endpoint and
reports quality, latency and cost:

  quality   urgency accuracy, per-class precision and recall, a confusion
            matrix, emergency recall (the error that matters most), dispatch
            accuracy, and how often the output was valid JSON
  latency   p50 and p95 over warm requests, with the first (possibly cold)
            request timed separately
  cost      cost per 1,000 requests at the throughput this run sustained

Draft replies are not auto-scored. The first few are printed for a human to read.

Usage:
  export BASETEN_API_KEY=<baseten api key>
  export BASETEN_MODEL_URL="https://model-<model_id>.api.baseten.co/environments/production/sync/v1"
  python eval.py data/eval_examples.jsonl [--concurrency 4] [--no-warmup]

Each line of the data file:
  {"input": "<tenant message>", "urgency": "emergency|urgent|routine", "dispatch": "<optional>"}
"""

import argparse
import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor

from metrics import accuracy, confusion, cost_per_1k, min_samples_for, per_class, percentile
from parse import parse_output
from prompt import DISPATCHES, SYSTEM_PROMPT, URGENCIES

# Baseten's listed price for one L4 replica, per minute, on 2026-10-13. Check it before quoting a cost.
L4_PRICE_PER_MIN = 0.01414
SHOW_DRAFTS = 5
WARMUP_MESSAGE = "The kitchen light is flickering."


def load_examples(path):
    """Reads and validates the data file. Fails loudly: a bad label silently skews every number."""
    examples = []
    with open(path, encoding="utf-8") as f:
        for n, line in enumerate(f, 1):
            if not line.strip():
                continue
            try:
                ex = json.loads(line)
            except ValueError as err:
                raise ValueError(f"{path} line {n}: not valid JSON ({err})") from None
            if not isinstance(ex.get("input"), str) or not ex["input"].strip():
                raise ValueError(f"{path} line {n}: missing 'input'")
            if ex.get("urgency") not in URGENCIES:
                raise ValueError(f"{path} line {n}: urgency must be one of {URGENCIES}, got {ex.get('urgency')!r}")
            if "dispatch" in ex and ex["dispatch"] not in DISPATCHES:
                raise ValueError(f"{path} line {n}: dispatch must be one of {DISPATCHES}, got {ex['dispatch']!r}")
            examples.append(ex)
    if not examples:
        raise ValueError(f"{path}: no examples")
    return examples


def make_openai_complete(api_key, base_url, model, timeout_s):
    """Returns complete(message) -> (text, prompt_tokens, completion_tokens) backed by the endpoint."""
    from openai import OpenAI

    # The SDK retries connection errors, 408, 429 and 5xx itself.
    client = OpenAI(api_key=api_key, base_url=base_url, timeout=timeout_s, max_retries=2)

    def complete(message):
        resp = client.chat.completions.create(
            model=model,
            messages=[{"role": "system", "content": SYSTEM_PROMPT}, {"role": "user", "content": message}],
            max_tokens=400,
            temperature=0,
        )
        usage = resp.usage
        return (
            resp.choices[0].message.content or "",
            getattr(usage, "prompt_tokens", 0) or 0,
            getattr(usage, "completion_tokens", 0) or 0,
        )

    return complete


def run_one(complete, example, clock=time.perf_counter):
    """One request. A failed request is recorded as a failure, never raised: one error must not lose the run."""
    start = clock()
    try:
        text, prompt_tokens, completion_tokens = complete(example["input"])
        error = None
    except Exception as err:  # noqa: BLE001 - any provider failure is a result, not a crash
        text, prompt_tokens, completion_tokens = "", 0, 0
        error = f"{type(err).__name__}: {err}"
    latency = clock() - start
    parsed = parse_output(text)
    return {
        "input": example["input"],
        "expected_urgency": example["urgency"],
        "predicted_urgency": parsed.urgency,
        "expected_dispatch": example.get("dispatch"),
        "predicted_dispatch": parsed.dispatch,
        "json_status": "error" if error else parsed.json_status,
        "latency_s": round(latency, 4),
        "prompt_tokens": prompt_tokens,
        "completion_tokens": completion_tokens,
        "error": error,
        "raw": text,
    }


def run_eval(complete, examples, concurrency=1, warmup=True, clock=time.perf_counter):
    """Runs every example and returns (results, first_request_s, wall_s)."""
    first_request_s = None
    if warmup:
        # Timed on its own: after scale-to-zero this request waits for a replica to start.
        first_request_s = run_one(complete, {"input": WARMUP_MESSAGE, "urgency": "routine"}, clock)["latency_s"]
    start = clock()
    if concurrency <= 1:
        results = [run_one(complete, ex, clock) for ex in examples]
    else:
        with ThreadPoolExecutor(max_workers=concurrency) as pool:
            results = list(pool.map(lambda ex: run_one(complete, ex, clock), examples))
    return results, first_request_s, clock() - start


def summarize(results, first_request_s, wall_s, concurrency, gpu_price_per_min=L4_PRICE_PER_MIN):
    n = len(results)
    urgency_pairs = [(r["expected_urgency"], r["predicted_urgency"]) for r in results]
    dispatch_pairs = [(r["expected_dispatch"], r["predicted_dispatch"]) for r in results if r["expected_dispatch"]]
    ok = [r for r in results if not r["error"]]
    latencies = [r["latency_s"] for r in ok]
    statuses = [r["json_status"] for r in results]
    classes = per_class(urgency_pairs, URGENCIES)
    return {
        "examples": n,
        "errors": n - len(ok),
        "urgency_accuracy": accuracy(urgency_pairs),
        "emergency_recall": classes["emergency"]["recall"],
        "emergency_support": classes["emergency"]["support"],
        "urgency_per_class": classes,
        "urgency_confusion": confusion(urgency_pairs, URGENCIES),
        "dispatch_accuracy": accuracy(dispatch_pairs),
        "dispatch_scored": len(dispatch_pairs),
        "json_strict_rate": statuses.count("strict") / n,
        "json_fenced_rate": statuses.count("fenced") / n,
        "json_invalid_rate": (statuses.count("invalid") + statuses.count("error")) / n,
        "latency_p50_s": percentile(latencies, 50),
        "latency_p95_s": percentile(latencies, 95),
        "latency_max_s": max(latencies) if latencies else None,
        "p95_is_just_the_max": len(latencies) < min_samples_for(95),
        "first_request_s": first_request_s,
        "concurrency": concurrency,
        "wall_s": round(wall_s, 3),
        "requests_per_min": round(len(ok) / (wall_s / 60), 1) if wall_s > 0 else None,
        "prompt_tokens": sum(r["prompt_tokens"] for r in results),
        "completion_tokens": sum(r["completion_tokens"] for r in results),
        "gpu_price_per_min": gpu_price_per_min,
        "cost_per_1k_warm_usd": cost_per_1k(gpu_price_per_min, len(ok), wall_s),
    }


def fmt(value, spec=".1%"):
    return "n/a" if value is None else format(value, spec)


def print_report(summary, results):
    s = summary
    print("\n==== quality ====")
    print(f"examples:           {s['examples']}  (request errors: {s['errors']})")
    print(f"urgency accuracy:   {fmt(s['urgency_accuracy'])}")
    print(f"emergency recall:   {fmt(s['emergency_recall'])}  (of {s['emergency_support']} emergencies)")
    print(f"dispatch accuracy:  {fmt(s['dispatch_accuracy'])}  (of {s['dispatch_scored']} labeled)")
    print(f"valid JSON:         {fmt(s['json_strict_rate'])} strict, {fmt(s['json_fenced_rate'])} in a code fence, "
          f"{fmt(s['json_invalid_rate'])} unusable")
    print("\n  class        n   precision   recall")
    for label, m in s["urgency_per_class"].items():
        print(f"  {label:<10} {m['support']:>3}   {fmt(m['precision']):>9}   {fmt(m['recall']):>6}")
    print("\n  expected \\ predicted: " + "  ".join(list(URGENCIES) + ["(none)"]))
    for label, row in s["urgency_confusion"].items():
        print(f"  {label:<10} " + "  ".join(f"{v:>{len(c)}}" for c, v in row.items()))

    print("\n==== latency (warm requests, measured at the client) ====")
    print(f"p50:                {fmt(s['latency_p50_s'], '.2f')} s")
    p95_note = "  (too few samples: this is just the slowest request)" if s["p95_is_just_the_max"] else ""
    print(f"p95:                {fmt(s['latency_p95_s'], '.2f')} s{p95_note}")
    print(f"first request:      {fmt(s['first_request_s'], '.2f')} s  (includes a cold start if the model was scaled to zero)")

    print("\n==== cost ====")
    print(f"throughput:         {s['requests_per_min']} requests/min at concurrency {s['concurrency']}")
    print(f"tokens:             {s['prompt_tokens']} prompt, {s['completion_tokens']} completion")
    print(f"cost per 1,000:     ${fmt(s['cost_per_1k_warm_usd'], '.4f')}  at ${s['gpu_price_per_min']}/min, warm and at this throughput")
    print("                    Excludes cold starts and idle minutes billed before scale-down.")
    print("                    At low traffic those dominate: use the Baseten billing page for the real total.")

    misses = [r for r in results if r["predicted_urgency"] != r["expected_urgency"]]
    if misses:
        print(f"\nmisses ({len(misses)}):")
        for r in misses:
            why = r["error"] or f"predicted={r['predicted_urgency']} ({r['json_status']})"
            print(f"  expected={r['expected_urgency']}  {why}\n    {r['input'][:100]}")
    print(f"\ndraft replies to read (first {SHOW_DRAFTS}):")
    for r in results[:SHOW_DRAFTS]:
        print(f"  in:  {r['input'][:100]}\n  out: {r['raw'][:240]}\n")


def main(argv=None):
    ap = argparse.ArgumentParser(description="Evaluate the deployed triage model.")
    ap.add_argument("data")
    ap.add_argument("--concurrency", type=int, default=1)
    ap.add_argument("--no-warmup", action="store_true", help="do not send an untimed-in-the-stats first request")
    ap.add_argument("--timeout", type=float, default=120.0, help="seconds per request; cold starts can be slow")
    ap.add_argument("--gpu-price-per-min", type=float, default=L4_PRICE_PER_MIN)
    ap.add_argument("--out", default="eval_results.json")
    args = ap.parse_args(argv)

    api_key = os.environ.get("BASETEN_API_KEY")
    base_url = os.environ.get("BASETEN_MODEL_URL")
    model = os.environ.get("MODEL_NAME", "triage-3b")
    if not api_key or not base_url:
        sys.exit("Set BASETEN_API_KEY and BASETEN_MODEL_URL first (see README).")

    try:
        examples = load_examples(args.data)
    except (OSError, ValueError) as err:
        sys.exit(str(err))

    complete = make_openai_complete(api_key, base_url, model, args.timeout)
    results, first_request_s, wall_s = run_eval(complete, examples, args.concurrency, warmup=not args.no_warmup)
    summary = summarize(results, first_request_s, wall_s, args.concurrency, args.gpu_price_per_min)
    print_report(summary, results)

    # Contains every message and raw output. It is git-ignored: do not commit it once the data is real.
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump({"model": model, "summary": summary, "results": results}, f, indent=2, ensure_ascii=False)
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
