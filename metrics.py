"""Scoring. Pure functions over lists, so they can be tested without a model."""

import math


def percentile(values, p):
    """Nearest-rank percentile: the smallest value with at least p% of the data at or below it.

    Returns None for an empty list. With few samples the upper percentiles are
    simply the maximum; `min_samples_for` says how many you need before that stops.
    """
    if not values:
        return None
    ordered = sorted(values)
    rank = max(1, math.ceil(p / 100 * len(ordered)))
    return ordered[rank - 1]


def min_samples_for(p):
    """Samples needed before the p-th percentile is anything other than the maximum."""
    return math.ceil(1 / (1 - p / 100))


def accuracy(pairs):
    """pairs: (expected, predicted). A prediction of None counts as wrong."""
    return sum(e == p for e, p in pairs) / len(pairs) if pairs else None


def per_class(pairs, labels):
    """Precision, recall and support for each label."""
    out = {}
    for label in labels:
        tp = sum(e == label and p == label for e, p in pairs)
        predicted = sum(p == label for _, p in pairs)
        support = sum(e == label for e, _ in pairs)
        out[label] = {
            "support": support,
            "precision": tp / predicted if predicted else None,
            "recall": tp / support if support else None,
        }
    return out


def confusion(pairs, labels):
    """Rows are expected, columns are predicted. Unparseable predictions go under "(none)"."""
    columns = list(labels) + ["(none)"]
    table = {e: {c: 0 for c in columns} for e in labels}
    for expected, predicted in pairs:
        if expected in table:
            table[expected][predicted if predicted in labels else "(none)"] += 1
    return table


def cost_per_1k(gpu_price_per_min, requests, wall_seconds):
    """Cost of 1,000 requests at the throughput this run sustained.

    This is the marginal cost while a replica is warm and busy at this
    concurrency. It excludes cold starts and the idle time billed before
    scale-down, which dominate at low traffic; report those separately.
    """
    if not requests or wall_seconds <= 0:
        return None
    requests_per_min = requests / (wall_seconds / 60)
    return gpu_price_per_min / requests_per_min * 1000
