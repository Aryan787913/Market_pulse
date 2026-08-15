"""
Tests for the OHLCV normalisation step in fetch_data.

`_normalise` is where vendor-shaped data becomes warehouse-shaped rows, so it is
the one place a source quirk can corrupt every downstream metric. Each test here
encodes a quirk yfinance has actually produced: MultiIndex columns, a differently
named date column, NaN prices, and rows with no close at all.

Row tuples are ordered to match the raw insert:
    (symbol, trade_date, open, high, low, close, volume, source, batch_id)
"""

from datetime import date

import pandas as pd

import fetch_data

SYMBOL = "TCS.NS"

# Column positions in the emitted tuple, named so assertions stay readable.
SYMBOL_I, DATE_I, OPEN_I, HIGH_I, LOW_I, CLOSE_I, VOLUME_I, SOURCE_I, BATCH_I = range(9)


def _frame(rows: list[dict]) -> pd.DataFrame:
    """Build a yfinance-shaped frame: capitalised columns, dates on the index."""
    frame = pd.DataFrame(rows)
    frame = frame.set_index("Date")
    frame.index = pd.to_datetime(frame.index)
    return frame


def _bar(day: str, close: float = 100.0, **overrides) -> dict:
    """One day's OHLCV bar, with sane defaults that individual tests override."""
    bar = {
        "Date": day,
        "Open": close - 1,
        "High": close + 2,
        "Low": close - 3,
        "Close": close,
        "Volume": 1_000_000,
    }
    bar.update(overrides)
    return bar


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------

def test_single_bar_maps_to_the_raw_row_shape(batch_id):
    rows = fetch_data._normalise(_frame([_bar("2025-01-02")]), SYMBOL, batch_id)

    assert len(rows) == 1
    row = rows[0]
    assert row[SYMBOL_I] == SYMBOL
    assert row[DATE_I] == date(2025, 1, 2)
    assert row[OPEN_I] == 99.0
    assert row[HIGH_I] == 102.0
    assert row[LOW_I] == 97.0
    assert row[CLOSE_I] == 100.0
    assert row[VOLUME_I] == 1_000_000
    assert row[SOURCE_I] == "yfinance"
    assert row[BATCH_I] == batch_id


def test_every_row_carries_the_same_batch_id(batch_id):
    """
    Lineage depends on this: the batch_id is how a bad load is traced back to the
    run that wrote it, and how quality results are tied to the data they checked.
    """
    frame = _frame([_bar(f"2025-01-{d:02d}") for d in range(2, 10)])
    rows = fetch_data._normalise(frame, SYMBOL, batch_id)

    assert len(rows) == 8
    assert {row[BATCH_I] for row in rows} == {batch_id}


def test_row_order_follows_the_source_frame(batch_id):
    frame = _frame([_bar("2025-01-02"), _bar("2025-01-03"), _bar("2025-01-06")])
    rows = fetch_data._normalise(frame, SYMBOL, batch_id)

    assert [row[DATE_I] for row in rows] == [
        date(2025, 1, 2),
        date(2025, 1, 3),
        date(2025, 1, 6),
    ]


def test_prices_are_rounded_to_four_decimals(batch_id):
    """
    The warehouse columns are NUMERIC(14,4). Rounding here rather than letting
    Postgres do it keeps the raw and warehouse values identical.
    """
    frame = _frame([_bar("2025-01-02", close=123.456789)])
    rows = fetch_data._normalise(frame, SYMBOL, batch_id)

    assert rows[0][CLOSE_I] == 123.4568


# ---------------------------------------------------------------------------
# Vendor quirks
# ---------------------------------------------------------------------------

def test_multiindex_columns_are_flattened(batch_id):
    """
    yfinance returns ('Close', 'TCS.NS') style columns whenever it thinks more
    than one ticker is involved. Unflattened, the required-column check fails and
    the symbol is skipped entirely.
    """
    frame = _frame([_bar("2025-01-02")])
    frame.columns = pd.MultiIndex.from_product([frame.columns, [SYMBOL]])

    rows = fetch_data._normalise(frame, SYMBOL, batch_id)

    assert len(rows) == 1
    assert rows[0][CLOSE_I] == 100.0


def test_datetime_index_name_is_handled(batch_id):
    """Index arrives as 'Datetime' on some responses instead of 'Date'."""
    frame = _frame([_bar("2025-01-02")])
    frame.index.name = "Datetime"

    rows = fetch_data._normalise(frame, SYMBOL, batch_id)

    assert rows[0][DATE_I] == date(2025, 1, 2)


def test_timestamps_are_truncated_to_a_trade_date(batch_id):
    """
    The warehouse grain is one row per symbol per day, so an intraday timestamp
    must collapse to a date or the (symbol, trade_date) upsert key breaks.
    """
    frame = _frame([_bar("2025-01-02 15:30:00")])
    rows = fetch_data._normalise(frame, SYMBOL, batch_id)

    assert rows[0][DATE_I] == date(2025, 1, 2)


# ---------------------------------------------------------------------------
# Bad data
# ---------------------------------------------------------------------------

def test_empty_frame_yields_no_rows(batch_id):
    """A failed download returns an empty frame; it must not raise."""
    assert fetch_data._normalise(pd.DataFrame(), SYMBOL, batch_id) == []


def test_rows_without_a_close_are_dropped(batch_id):
    """
    Close drives every metric, so a bar without one is useless. Dropping it here
    keeps the no_null_close quality check green for a reason, not by luck.
    """
    frame = _frame(
        [
            _bar("2025-01-02"),
            _bar("2025-01-03", close=float("nan")),
            _bar("2025-01-06"),
        ]
    )
    rows = fetch_data._normalise(frame, SYMBOL, batch_id)

    assert [row[DATE_I] for row in rows] == [date(2025, 1, 2), date(2025, 1, 6)]


def test_missing_required_column_skips_the_symbol(batch_id):
    """
    Better to emit nothing and have the run graded PARTIAL than to write rows
    with silently absent prices.
    """
    frame = _frame([_bar("2025-01-02")]).drop(columns=["Volume"])
    assert fetch_data._normalise(frame, SYMBOL, batch_id) == []


def test_nan_volume_becomes_null_not_zero(batch_id):
    """
    Zero volume means 'nobody traded', which is a real and different fact from
    'the vendor did not report volume'. Conflating them would corrupt any
    volume-based analysis.
    """
    frame = _frame([_bar("2025-01-02", Volume=float("nan"))])
    rows = fetch_data._normalise(frame, SYMBOL, batch_id)

    assert rows[0][VOLUME_I] is None


def test_non_numeric_price_becomes_null(batch_id):
    """A stray string must not crash the load or be coerced into a fake number."""
    frame = _frame([_bar("2025-01-02", Open="n/a")])
    rows = fetch_data._normalise(frame, SYMBOL, batch_id)

    assert rows[0][OPEN_I] is None
    # The rest of the bar still survives.
    assert rows[0][CLOSE_I] == 100.0


def test_fractional_volume_is_truncated_to_an_integer(batch_id):
    """The warehouse column is BIGINT, so a float volume has to be cast."""
    frame = _frame([_bar("2025-01-02", Volume=1234.9)])
    rows = fetch_data._normalise(frame, SYMBOL, batch_id)

    assert rows[0][VOLUME_I] == 1234
    assert isinstance(rows[0][VOLUME_I], int)


def test_source_frame_is_not_mutated(batch_id):
    """
    _normalise copies before reshaping. Without that, a retry or a second caller
    would see already-lowercased columns and behave differently the second time.
    """
    frame = _frame([_bar("2025-01-02")])
    original_columns = list(frame.columns)

    fetch_data._normalise(frame, SYMBOL, batch_id)

    assert list(frame.columns) == original_columns
