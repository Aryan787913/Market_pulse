"""
Database helper layer for the pipeline.

Every query here uses parameterised SQL (psycopg2 placeholders). String
formatting is never used to build SQL, which keeps the pipeline safe from
SQL injection even though the inputs come from a config file.
"""

import logging
from contextlib import contextmanager
from typing import Any, Iterable, Optional

import psycopg2
from psycopg2.extras import RealDictCursor, execute_values

from config import DB_CONFIG, LOG_FORMAT, LOG_LEVEL

logging.basicConfig(level=LOG_LEVEL, format=LOG_FORMAT)
logger = logging.getLogger(__name__)


@contextmanager
def get_connection():
    """
    Yield a database connection, committing on success and rolling back on
    any exception so a failed task never leaves a half-written batch behind.
    """
    conn = psycopg2.connect(**DB_CONFIG)
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        logger.exception("Transaction rolled back due to an error")
        raise
    finally:
        conn.close()


def query_all(sql: str, params: Optional[tuple] = None) -> list[dict]:
    """Run a SELECT and return all rows as a list of dictionaries."""
    with get_connection() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(sql, params)
            return [dict(row) for row in cur.fetchall()]


def query_one(sql: str, params: Optional[tuple] = None) -> Optional[dict]:
    """Run a SELECT and return the first row, or None."""
    rows = query_all(sql, params)
    return rows[0] if rows else None


def execute(sql: str, params: Optional[tuple] = None) -> int:
    """Run an INSERT/UPDATE/DELETE and return the affected row count."""
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, params)
            return cur.rowcount


# ---------------------------------------------------------------------------
# Raw zone writes
# ---------------------------------------------------------------------------

RAW_INSERT_SQL = """
    INSERT INTO raw.daily_prices_raw
        (symbol, trade_date, open, high, low, close, volume, source, batch_id)
    VALUES %s
    ON CONFLICT (symbol, trade_date) DO UPDATE SET
        open        = EXCLUDED.open,
        high        = EXCLUDED.high,
        low         = EXCLUDED.low,
        close       = EXCLUDED.close,
        volume      = EXCLUDED.volume,
        ingested_at = NOW(),
        batch_id    = EXCLUDED.batch_id
"""


def insert_raw_prices(rows: Iterable[tuple[Any, ...]]) -> int:
    """
    Bulk-insert raw OHLCV rows.

    The ON CONFLICT clause makes the load idempotent: re-running the DAG for a
    date that already exists updates the row instead of failing or duplicating.
    Each tuple must be:
        (symbol, trade_date, open, high, low, close, volume, source, batch_id)
    """
    rows = list(rows)
    if not rows:
        logger.warning("insert_raw_prices called with no rows")
        return 0

    with get_connection() as conn:
        with conn.cursor() as cur:
            execute_values(cur, RAW_INSERT_SQL, rows, page_size=500)
            inserted = cur.rowcount

    logger.info("Upserted %s raw price rows", inserted)
    return inserted


# ---------------------------------------------------------------------------
# Run auditing
# ---------------------------------------------------------------------------

def start_ingestion_log(batch_id: str, symbols_total: int) -> int:
    """Open an ingestion_log row and return its primary key."""
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO raw.ingestion_log (batch_id, symbols_total, status)
                VALUES (%s, %s, 'RUNNING')
                RETURNING log_id
                """,
                (batch_id, symbols_total),
            )
            return cur.fetchone()[0]


def finish_ingestion_log(
    log_id: int,
    symbols_ok: int,
    symbols_failed: int,
    rows_inserted: int,
    status: str,
    message: str = "",
) -> None:
    """Close out an ingestion_log row with the final counts and status."""
    execute(
        """
        UPDATE raw.ingestion_log
           SET run_ended_at   = NOW(),
               symbols_ok     = %s,
               symbols_failed = %s,
               rows_inserted  = %s,
               status         = %s,
               message        = %s
         WHERE log_id = %s
        """,
        (symbols_ok, symbols_failed, rows_inserted, status, message[:2000], log_id),
    )


def log_quality_check(
    batch_id: Optional[str],
    check_name: str,
    check_target: str,
    failed_records: int,
    passed: bool,
    severity: str = "ERROR",
    details: str = "",
) -> None:
    """Record the outcome of a single data-quality check."""
    execute(
        """
        INSERT INTO raw.data_quality_log
            (batch_id, check_name, check_target, failed_records,
             severity, passed, details)
        VALUES (%s, %s, %s, %s, %s, %s, %s)
        """,
        (
            batch_id,
            check_name,
            check_target,
            failed_records,
            severity,
            passed,
            details[:2000],
        ),
    )


# ---------------------------------------------------------------------------
# Reference data
# ---------------------------------------------------------------------------

def get_symbol_to_stock_id() -> dict[str, int]:
    """Map every tracked symbol to its warehouse stock_id."""
    rows = query_all(
        "SELECT symbol, stock_id FROM warehouse.stocks WHERE is_active = TRUE"
    )
    return {row["symbol"]: row["stock_id"] for row in rows}


def get_latest_raw_date(symbol: str) -> Optional[str]:
    """Most recent trade_date already stored for a symbol, or None."""
    row = query_one(
        "SELECT MAX(trade_date) AS last_date FROM raw.daily_prices_raw WHERE symbol = %s",
        (symbol,),
    )
    return row["last_date"] if row else None


def raw_table_is_empty() -> bool:
    """True when the landing zone has no rows yet (first ever run)."""
    row = query_one("SELECT COUNT(*) AS c FROM raw.daily_prices_raw")
    return (row["c"] if row else 0) == 0
