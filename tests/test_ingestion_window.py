"""
Tests for the run-planning logic in fetch_data.

These cover the decisions the pipeline makes *before* it touches the network:
which dates to fetch, which symbols, and how to grade the outcome. That is the
logic most likely to break silently - a wrong window fetches nothing and the run
still reports success - so it is the part worth pinning down with tests.

`resolve_window` takes `today` and `raw_is_empty` as arguments precisely so these
tests need neither a clock nor a database.
"""

from datetime import date, timedelta

import pytest

import fetch_data
from config import BACKFILL_DAYS, INCREMENTAL_DAYS, MAX_FAILURE_RATIO

TODAY = date(2026, 3, 10)


# ---------------------------------------------------------------------------
# Automatic windows
# ---------------------------------------------------------------------------

def test_first_ever_run_backfills_long_history():
    """An empty landing zone must pull enough history for the 200-day averages."""
    window = fetch_data.resolve_window(today=TODAY, raw_is_empty=True)

    assert window.mode == "BACKFILL"
    assert window.start == TODAY - timedelta(days=BACKFILL_DAYS)
    assert window.last_date == TODAY


def test_daily_run_uses_short_overlapping_window():
    """Once data exists, only a few days are refetched to keep the job cheap."""
    window = fetch_data.resolve_window(today=TODAY, raw_is_empty=False)

    assert window.mode == "INCREMENTAL"
    assert window.start == TODAY - timedelta(days=INCREMENTAL_DAYS)
    assert window.last_date == TODAY


def test_incremental_window_overlaps_a_weekend():
    """
    The overlap has to span more than two days, otherwise a Monday run would
    have no chance of picking up a correction issued over the weekend.
    """
    window = fetch_data.resolve_window(today=TODAY, raw_is_empty=False)
    assert (window.last_date - window.start).days > 2


def test_end_is_exclusive_for_yfinance():
    """
    yfinance treats `end` as exclusive, so it must sit one day past the last
    date wanted. Getting this wrong silently drops the most recent bar.
    """
    window = fetch_data.resolve_window(today=TODAY, raw_is_empty=False)
    assert window.end == window.last_date + timedelta(days=1)


# ---------------------------------------------------------------------------
# Explicit backfill ranges
# ---------------------------------------------------------------------------

def test_explicit_range_is_honoured_exactly():
    window = fetch_data.resolve_window(
        start="2025-01-01", end="2025-03-31", today=TODAY, raw_is_empty=False
    )

    assert window.mode == "BACKFILL_RANGE"
    assert window.start == date(2025, 1, 1)
    assert window.last_date == date(2025, 3, 31)


def test_explicit_range_wins_over_the_empty_table_default():
    """
    A requested range must not be widened just because the table happens to be
    empty; reprocessing means reprocessing exactly what was asked for.
    """
    window = fetch_data.resolve_window(
        start="2025-06-01", end="2025-06-30", today=TODAY, raw_is_empty=True
    )

    assert window.mode == "BACKFILL_RANGE"
    assert window.start == date(2025, 6, 1)
    assert window.last_date == date(2025, 6, 30)


def test_start_only_backfills_through_today():
    window = fetch_data.resolve_window(
        start="2026-03-01", today=TODAY, raw_is_empty=False
    )
    assert window.last_date == TODAY


def test_end_only_walks_back_the_default_history():
    window = fetch_data.resolve_window(
        end="2025-12-31", today=TODAY, raw_is_empty=False
    )

    assert window.last_date == date(2025, 12, 31)
    assert window.start == date(2025, 12, 31) - timedelta(days=BACKFILL_DAYS)


def test_accepts_date_objects_as_well_as_strings():
    """Airflow params arrive as strings; a direct caller may pass real dates."""
    from_string = fetch_data.resolve_window(
        start="2025-02-01", end="2025-02-10", today=TODAY, raw_is_empty=False
    )
    from_dates = fetch_data.resolve_window(
        start=date(2025, 2, 1), end=date(2025, 2, 10), today=TODAY, raw_is_empty=False
    )
    assert from_string == from_dates


def test_future_end_is_clamped_to_today():
    """Asking past today would return nothing, so the range is trimmed instead."""
    window = fetch_data.resolve_window(
        start="2026-03-01", end="2026-12-31", today=TODAY, raw_is_empty=False
    )
    assert window.last_date == TODAY


def test_reversed_range_is_rejected():
    with pytest.raises(ValueError, match="after end"):
        fetch_data.resolve_window(
            start="2025-06-30", end="2025-06-01", today=TODAY, raw_is_empty=False
        )


def test_future_start_is_rejected():
    with pytest.raises(ValueError, match="future"):
        fetch_data.resolve_window(
            start="2026-04-01", today=TODAY, raw_is_empty=False
        )


def test_malformed_date_is_rejected_with_a_useful_message():
    """
    A typo in the Airflow trigger form should fail immediately, not after a few
    minutes of downloading the wrong period.
    """
    with pytest.raises(ValueError, match="ISO date"):
        fetch_data.resolve_window(start="31-01-2025", today=TODAY)


def test_blank_range_falls_back_to_the_automatic_window():
    """Empty strings come from untouched form fields and must mean 'no range'."""
    window = fetch_data.resolve_window(
        start=None, end=None, today=TODAY, raw_is_empty=False
    )
    assert window.mode == "INCREMENTAL"


def test_single_day_range_is_allowed():
    """Repairing one bad trading day is the narrowest useful backfill."""
    window = fetch_data.resolve_window(
        start="2025-05-15", end="2025-05-15", today=TODAY, raw_is_empty=False
    )

    assert window.start == date(2025, 5, 15)
    assert window.last_date == date(2025, 5, 15)
    assert window.end == date(2025, 5, 16)


def test_describe_reports_the_inclusive_range():
    """The summary string is written to ingestion_log, so it must read clearly."""
    window = fetch_data.resolve_window(
        start="2025-01-01", end="2025-01-31", today=TODAY, raw_is_empty=False
    )
    assert window.describe() == "BACKFILL_RANGE 2025-01-01 -> 2025-01-31"


# ---------------------------------------------------------------------------
# Symbol selection
# ---------------------------------------------------------------------------

def test_no_symbols_means_the_whole_universe():
    from config import STOCK_SYMBOLS

    assert fetch_data.resolve_symbols() == list(STOCK_SYMBOLS)
    assert fetch_data.resolve_symbols("") == list(STOCK_SYMBOLS)


def test_comma_separated_subset_is_parsed():
    assert fetch_data.resolve_symbols("TCS.NS,INFY.NS") == ["TCS.NS", "INFY.NS"]


def test_subset_tolerates_whitespace_and_case():
    assert fetch_data.resolve_symbols(" tcs.ns , INFY.NS ") == ["TCS.NS", "INFY.NS"]


def test_duplicate_symbols_are_collapsed():
    """Fetching the same ticker twice would double the work for no benefit."""
    assert fetch_data.resolve_symbols("TCS.NS,TCS.NS,INFY.NS") == [
        "TCS.NS",
        "INFY.NS",
    ]


def test_unknown_symbol_is_rejected():
    """
    A typo must fail loudly. Without this the run would report zero rows for a
    symbol that was never in the universe and look like a source outage.
    """
    with pytest.raises(ValueError, match="unknown symbols"):
        fetch_data.resolve_symbols("TCS.NS,NOTREAL.NS")


# ---------------------------------------------------------------------------
# Run grading
# ---------------------------------------------------------------------------

def test_clean_run_is_success():
    assert fetch_data.classify_status(0, 12) == "SUCCESS"


def test_a_few_missing_symbols_is_partial_not_fatal():
    """One dead ticker must not throw away the other eleven symbols' data."""
    assert fetch_data.classify_status(1, 12) == "PARTIAL"


def test_too_many_failures_is_a_hard_failure():
    """Past the threshold it is an upstream outage, not a per-symbol problem."""
    assert fetch_data.classify_status(11, 12) == "FAILED"


def test_threshold_boundary_is_still_partial():
    """
    Exactly at the ratio is tolerated; only strictly beyond it fails. Pinning
    this stops a later refactor from silently flipping the comparison.
    """
    total = 10
    at_threshold = int(MAX_FAILURE_RATIO * total)
    assert fetch_data.classify_status(at_threshold, total) == "PARTIAL"
    assert fetch_data.classify_status(at_threshold + 1, total) == "FAILED"


def test_empty_symbol_list_cannot_be_a_success():
    """A run that fetched nothing must never be graded green."""
    assert fetch_data.classify_status(0, 0) == "FAILED"
