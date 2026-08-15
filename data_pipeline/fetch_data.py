"""
Extract step: pull daily OHLCV data from Yahoo Finance and land it in the
raw zone.

Design decisions worth remembering for the viva:
  * The first run backfills a year of history; later runs only fetch a small
    overlapping window. This keeps the daily job fast.
  * An explicit --start/--end window overrides that automatic choice, which is
    what makes targeted reprocessing of a past period possible.
  * A failure on one symbol never kills the whole run. Failures are counted and
    the run is marked PARTIAL, or FAILED if too many symbols break.
  * Every row carries a batch_id so any bad load can be traced or reverted.

Run standalone:
    python data_pipeline/fetch_data.py
    python data_pipeline/fetch_data.py --start 2025-01-01 --end 2025-03-31
    python data_pipeline/fetch_data.py --start 2025-01-01 --symbols TCS.NS,INFY.NS
"""

import argparse
import logging
import sys
import time
import uuid
from dataclasses import dataclass
from datetime import date, datetime, timedelta


import pandas as pd
import yfinance as yf

import db
from config import (
    BACKFILL_DAYS,
    INCREMENTAL_DAYS,
    LOG_FORMAT,
    LOG_LEVEL,
    MAX_FAILURE_RATIO,
    MAX_RETRIES,
    RETRY_DELAY_SECONDS,
    STOCK_SYMBOLS,
)

logging.basicConfig(level=LOG_LEVEL, format=LOG_FORMAT)
logger = logging.getLogger("fetch_data")


def _download_with_retry(symbol: str, start: date, end: date) -> pd.DataFrame:
    """
    Download one symbol, retrying on transient errors with a linear backoff.
    Returns an empty DataFrame if every attempt fails.
    """
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            frame = yf.download(
                tickers=symbol,
                start=start.isoformat(),
                end=end.isoformat(),
                interval="1d",
                auto_adjust=False,
                progress=False,
                threads=False,
            )
            if frame is not None and not frame.empty:
                return frame

            logger.warning(
                "%s returned no rows (attempt %s/%s)", symbol, attempt, MAX_RETRIES
            )
        except Exception as exc:  # network errors, rate limits, bad symbols
            logger.warning(
                "%s download failed (attempt %s/%s): %s",
                symbol,
                attempt,
                MAX_RETRIES,
                exc,
            )

        if attempt < MAX_RETRIES:
            time.sleep(RETRY_DELAY_SECONDS * attempt)

    return pd.DataFrame()


def _as_float(value) -> float | None:
    """Cast to float, converting NaN/None to SQL NULL."""
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return None if pd.isna(result) else round(result, 4)


def _as_int(value) -> int | None:
    """Cast to int, converting NaN/None to SQL NULL."""
    try:
        if pd.isna(value):
            return None
        return int(value)
    except (TypeError, ValueError):
        return None


def _normalise(frame: pd.DataFrame, symbol: str, batch_id: str) -> list[tuple]:
    """
    Turn a yfinance DataFrame into row tuples ready for the raw table.

    yfinance sometimes returns a MultiIndex on the columns (when more than one
    ticker is involved) so that case is flattened first. Rows with a missing
    close price are dropped here because they are useless downstream.
    """
    if frame.empty:
        return []

    frame = frame.copy()

    # Flatten ('Close', 'TCS.NS') -> 'Close'
    if isinstance(frame.columns, pd.MultiIndex):
        frame.columns = [str(col[0]) for col in frame.columns]

    frame = frame.reset_index()
    frame.columns = [str(c).strip().lower().replace(" ", "_") for c in frame.columns]

    date_col = "date" if "date" in frame.columns else frame.columns[0]

    required = ["open", "high", "low", "close", "volume"]
    missing = [c for c in required if c not in frame.columns]
    if missing:
        logger.error("%s is missing columns %s - skipping", symbol, missing)
        return []

    frame = frame.dropna(subset=["close"])

    rows: list[tuple] = []
    for record in frame.itertuples(index=False):
        values = dict(zip(frame.columns, record))
        trade_date = pd.to_datetime(values[date_col]).date()

        rows.append(
            (
                symbol,
                trade_date,
                _as_float(values["open"]),
                _as_float(values["high"]),
                _as_float(values["low"]),
                _as_float(values["close"]),
                _as_int(values["volume"]),
                "yfinance",
                batch_id,
            )
        )

    return rows


# ---------------------------------------------------------------------------
# Window resolution
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class IngestionWindow:
    """
    The date range a run will fetch, plus how that range was decided.

    `end` is the exclusive bound that yfinance expects, so it always sits one day
    past the last date actually wanted. Keeping the exclusivity inside this
    object means the callers and the tests reason about one convention only.
    """

    start: date
    end: date
    mode: str

    @property
    def last_date(self) -> date:
        """The newest trade date this window can return (inclusive)."""
        return self.end - timedelta(days=1)

    def describe(self) -> str:
        return f"{self.mode} {self.start} -> {self.last_date}"


def _parse_day(value: str | date | None, label: str) -> date | None:
    """Accept a date, an ISO string, or None. Reject anything else loudly."""
    if value is None or isinstance(value, date):
        return value
    try:
        return datetime.strptime(str(value).strip(), "%Y-%m-%d").date()
    except ValueError as exc:
        raise ValueError(
            f"{label} must be an ISO date such as 2025-01-31, got {value!r}"
        ) from exc


def resolve_window(
    start=None,
    end=None,
    today: date | None = None,
    raw_is_empty: bool | None = None,
) -> IngestionWindow:
    """
    Decide which dates to fetch.

    Three modes, in order of precedence:

      BACKFILL_RANGE  an explicit start and/or end was supplied, so the caller
                      is reprocessing a specific historical period. A missing
                      end defaults to today, and a missing start defaults to
                      BACKFILL_DAYS before the end.
      BACKFILL        the landing zone is empty, so a first load pulls a long
                      history to give the moving-average windows enough data.
      INCREMENTAL     the normal daily case: a short overlapping window, which
                      is cheap and still catches late source corrections.

    `today` and `raw_is_empty` are injectable so the decision can be tested
    without a clock or a database.
    """
    today = today or date.today()
    start_day = _parse_day(start, "start")
    end_day = _parse_day(end, "end")

    if start_day is not None or end_day is not None:
        # Explicit range. Guard the ordering before any network calls happen.
        effective_end = end_day or today
        effective_start = start_day or effective_end - timedelta(days=BACKFILL_DAYS)

        # The future check comes first on purpose. When only a start is given,
        # end defaults to today, so a future start also looks like a reversed
        # range - and "your start is in the future" is the more useful message.
        if effective_start > today:
            raise ValueError(
                f"start {effective_start} is in the future; no data can exist yet"
            )
        if effective_start > effective_end:
            raise ValueError(
                f"start {effective_start} is after end {effective_end}"
            )
        # Asking beyond today would silently return nothing, so it is clamped.
        effective_end = min(effective_end, today)

        return IngestionWindow(
            start=effective_start,
            end=effective_end + timedelta(days=1),
            mode="BACKFILL_RANGE",
        )

    if raw_is_empty is None:
        raw_is_empty = db.raw_table_is_empty()

    lookback = BACKFILL_DAYS if raw_is_empty else INCREMENTAL_DAYS
    return IngestionWindow(
        start=today - timedelta(days=lookback),
        end=today + timedelta(days=1),
        mode="BACKFILL" if raw_is_empty else "INCREMENTAL",
    )


def resolve_symbols(symbols=None) -> list[str]:
    """
    Validate a symbol subset against the configured universe.

    Restricting a backfill to a few tickers is the common case when one symbol
    was mis-loaded, and rejecting unknown symbols here prevents a typo from
    quietly fetching nothing.
    """
    if not symbols:
        return list(STOCK_SYMBOLS)

    if isinstance(symbols, str):
        symbols = [part for part in symbols.split(",") if part.strip()]

    requested = [str(s).strip().upper() for s in symbols]
    known = {s.upper(): s for s in STOCK_SYMBOLS}

    unknown = [s for s in requested if s not in known]
    if unknown:
        raise ValueError(
            f"unknown symbols {unknown}; configured universe is {STOCK_SYMBOLS}"
        )

    # De-duplicate while preserving the caller's order.
    seen, resolved = set(), []
    for symbol in requested:
        if symbol not in seen:
            seen.add(symbol)
            resolved.append(known[symbol])
    return resolved


def classify_status(symbols_failed: int, symbols_total: int) -> str:
    """
    Grade a run: all symbols fine, a tolerable few missing, or too many broken.

    Split out from run() so the threshold is testable without any I/O.
    """
    if symbols_total == 0:
        return "FAILED"
    if symbols_failed == 0:
        return "SUCCESS"
    if symbols_failed / symbols_total > MAX_FAILURE_RATIO:
        return "FAILED"
    return "PARTIAL"


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

def run(start=None, end=None, symbols=None) -> dict:
    """
    Execute the full extract-and-land step.
    Returns a summary dict, which Airflow pushes to XCom for later tasks.

    Passing start/end reprocesses a historical range instead of the automatic
    daily window. This is safe to repeat: the raw upsert is keyed on
    (symbol, trade_date), so a backfill overwrites the days it covers rather
    than duplicating them.
    """
    batch_id = str(uuid.uuid4())
    window = resolve_window(start=start, end=end)
    target_symbols = resolve_symbols(symbols)

    logger.info(
        "Batch %s | mode=%s | window %s -> %s | %s symbols",
        batch_id,
        window.mode,
        window.start,
        window.last_date,
        len(target_symbols),
    )

    log_id = db.start_ingestion_log(batch_id, len(target_symbols))

    all_rows: list[tuple] = []
    ok, failed, failures = 0, 0, []

    for symbol in target_symbols:
        frame = _download_with_retry(symbol, window.start, window.end)
        rows = _normalise(frame, symbol, batch_id)

        if rows:
            all_rows.extend(rows)
            ok += 1
            logger.info("%-14s %s rows", symbol, len(rows))
        else:
            failed += 1
            failures.append(symbol)
            logger.error("%-14s no usable data", symbol)

    inserted = db.insert_raw_prices(all_rows) if all_rows else 0

    status = classify_status(failed, len(target_symbols))

    # The window is recorded alongside the failures so the run history shows
    # which period each batch covered, not just when it happened.
    detail = f"window {window.describe()}"
    message = (
        f"{detail}; failed symbols: {', '.join(failures)}"
        if failures
        else f"{detail}; all symbols ok"
    )
    db.finish_ingestion_log(log_id, ok, failed, inserted, status, message)

    summary = {
        "batch_id": batch_id,
        "status": status,
        "mode": window.mode,
        "window_start": window.start.isoformat(),
        "window_end": window.last_date.isoformat(),
        "symbols_ok": ok,
        "symbols_failed": failed,
        "rows_inserted": inserted,
    }
    logger.info("Ingestion finished: %s", summary)

    # Raising here makes the Airflow task go red, which triggers the alert task.
    if status == "FAILED":
        raise RuntimeError(
            f"Ingestion failed: {failed}/{len(target_symbols)} symbols "
            f"could not be fetched ({message})"
        )

    return summary


def _parse_args(argv=None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Fetch daily OHLCV data into the raw zone.",
        epilog=(
            "Omit --start and --end for the normal daily window. "
            "Re-running a range is safe; rows are upserted, never duplicated."
        ),
    )
    parser.add_argument("--start", help="first trade date to fetch (YYYY-MM-DD)")
    parser.add_argument(
        "--end", help="last trade date to fetch, inclusive (YYYY-MM-DD)"
    )
    parser.add_argument(
        "--symbols",
        help="comma-separated subset of the configured universe, e.g. TCS.NS,INFY.NS",
    )
    return parser.parse_args(argv)


if __name__ == "__main__":
    args = _parse_args()
    try:
        run(start=args.start, end=args.end, symbols=args.symbols)
    except Exception:
        logger.exception("fetch_data terminated with an error")
        sys.exit(1)
