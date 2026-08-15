"""
Extract step: pull daily OHLCV data from Yahoo Finance and land it in the
raw zone.

Design decisions worth remembering for the viva:
  * The first run backfills a year of history; later runs only fetch a small
    overlapping window. This keeps the daily job fast.
  * A failure on one symbol never kills the whole run. Failures are counted and
    the run is marked PARTIAL, or FAILED if too many symbols break.
  * Every row carries a batch_id so any bad load can be traced or reverted.

Run standalone:  python data_pipeline/fetch_data.py
"""

import logging
import sys
import time
import uuid
from datetime import date, timedelta

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


def run() -> dict:
    """
    Execute the full extract-and-land step.
    Returns a summary dict, which Airflow pushes to XCom for later tasks.
    """
    batch_id = str(uuid.uuid4())
    end_date = date.today() + timedelta(days=1)  # yfinance 'end' is exclusive

    first_run = db.raw_table_is_empty()
    lookback = BACKFILL_DAYS if first_run else INCREMENTAL_DAYS
    start_date = date.today() - timedelta(days=lookback)

    logger.info(
        "Batch %s | mode=%s | window %s -> %s | %s symbols",
        batch_id,
        "BACKFILL" if first_run else "INCREMENTAL",
        start_date,
        end_date,
        len(STOCK_SYMBOLS),
    )

    log_id = db.start_ingestion_log(batch_id, len(STOCK_SYMBOLS))

    all_rows: list[tuple] = []
    ok, failed, failures = 0, 0, []

    for symbol in STOCK_SYMBOLS:
        frame = _download_with_retry(symbol, start_date, end_date)
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

    failure_ratio = failed / len(STOCK_SYMBOLS) if STOCK_SYMBOLS else 1.0
    if failed == 0:
        status = "SUCCESS"
    elif failure_ratio > MAX_FAILURE_RATIO:
        status = "FAILED"
    else:
        status = "PARTIAL"

    message = f"failed symbols: {', '.join(failures)}" if failures else "all symbols ok"
    db.finish_ingestion_log(log_id, ok, failed, inserted, status, message)

    summary = {
        "batch_id": batch_id,
        "status": status,
        "symbols_ok": ok,
        "symbols_failed": failed,
        "rows_inserted": inserted,
    }
    logger.info("Ingestion finished: %s", summary)

    # Raising here makes the Airflow task go red, which triggers the alert task.
    if status == "FAILED":
        raise RuntimeError(
            f"Ingestion failed: {failed}/{len(STOCK_SYMBOLS)} symbols "
            f"could not be fetched ({message})"
        )

    return summary


if __name__ == "__main__":
    try:
        run()
    except Exception:
        logger.exception("fetch_data terminated with an error")
        sys.exit(1)
