import pytest

from metrics import accuracy, confusion, cost_per_1k, min_samples_for, per_class, percentile

LABELS = ("emergency", "urgent", "routine")


@pytest.mark.parametrize("values,p,expected", [
    ([3, 1, 2], 50, 2),
    ([3, 1, 2], 95, 3),                 # the old formula returned the median here
    (list(range(1, 11)), 95, 10),       # ...and the 90th percentile here
    (list(range(1, 21)), 95, 19),
    (list(range(1, 101)), 95, 95),
    (list(range(1, 101)), 50, 50),
    ([7], 95, 7),
    ([5, 5, 5], 50, 5),
])
def test_percentile_is_nearest_rank(values, p, expected):
    assert percentile(values, p) == expected


def test_percentile_of_nothing_is_none_and_input_is_not_reordered():
    assert percentile([], 95) is None
    values = [3, 1, 2]
    percentile(values, 50)
    assert values == [3, 1, 2]


def test_min_samples_for_a_percentile_to_mean_something():
    assert min_samples_for(95) == 20
    assert min_samples_for(99) == 100
    assert min_samples_for(50) == 2


def test_accuracy_counts_an_unparseable_prediction_as_wrong():
    assert accuracy([("urgent", "urgent"), ("urgent", None), ("routine", "urgent"), ("routine", "routine")]) == 0.5
    assert accuracy([]) is None


def test_per_class_precision_recall_and_empty_classes():
    pairs = [("emergency", "emergency"), ("emergency", "urgent"), ("urgent", "urgent"), ("routine", None)]
    m = per_class(pairs, LABELS)
    assert m["emergency"] == {"support": 2, "precision": 1.0, "recall": 0.5}
    assert m["urgent"] == {"support": 1, "precision": 0.5, "recall": 1.0}
    assert m["routine"] == {"support": 1, "precision": None, "recall": 0.0}


def test_confusion_puts_unusable_predictions_in_their_own_column():
    table = confusion([("emergency", "urgent"), ("emergency", None), ("routine", "banana"), ("routine", "routine")], LABELS)
    assert table["emergency"] == {"emergency": 0, "urgent": 1, "routine": 0, "(none)": 1}
    assert table["routine"] == {"emergency": 0, "urgent": 0, "routine": 1, "(none)": 1}


def test_cost_per_1k_follows_from_throughput():
    # 60 requests in 60 s is 60 per minute; at $0.012/min that is $0.0002 each, $0.20 per thousand.
    assert cost_per_1k(0.012, 60, 60) == pytest.approx(0.20)
    # Four times the throughput on the same replica is a quarter of the cost.
    assert cost_per_1k(0.012, 240, 60) == pytest.approx(0.05)
    assert cost_per_1k(0.012, 0, 60) is None
    assert cost_per_1k(0.012, 10, 0) is None
