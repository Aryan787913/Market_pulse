"""
Data quality gate.

Runs after dbt has built the warehouse tables. Each check is a SQL query that
counts offending rows; zero means the check passed. Results are written to
raw.data_quality_log so there is a permanent, auditable record.

Severity decides what happens on failure:
  ERROR -> the task fails, which stops the DAG and fires the alert task.
  WARN  -> logged only. Used for things that are suspicious but not fatal.

Run standalone:  python data_pipeline/quality_checks.py
"""

import logging
import sys
from dataclasses import dataclass

import db
from config import LOG_FORMAT, LOG_LEVEL, MAX_DAILY_MOVE_PERCENT

logging.basicConfig(level=LOG_LEVEL, format=LOG_FORMAT)
logger = logging.getLogger("quality_checks")


@dataclass
class Check:
    """A single data-quality rule."""

    name: str
    target: str
    sql: str
    severity: str = "ERROR"
    description: str = ""


# ---------------------------------------------------------------------------
# Check definitions
# ---------------------------------------------------------------------------
# Each query must return exactly one column named failed_records.
CHECKS: list[Check] = [
    Check(
        name="warehouse_not_empty",
        target="warehouse.daily_prices",
        # Returns 1 (a failure) when the table has no rows at all.
        sql="""
            SELECT CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END AS failed_records
            FROM warehouse.daily_prices
        """,
        description="The warehouse price table must never be empty after a load.",
    ),
    Check(
        name="metrics_not_empty",
        target="warehouse.stock_metrics",
        sql="""
            SELECT CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END AS failed_records
            FROM warehouse.stock_metrics
        """,
        description="dbt must produce at least one metric row.",
    ),
    Check(
        name="no_duplicate_prices",
        target="warehouse.daily_prices",
        sql="""
            SELECT COUNT(*) AS failed_records FROM (
                SELECT stock_id, trade_date
                FROM warehouse.daily_prices
                GROUP BY stock_id, trade_date
                HAVING COUNT(*) > 1
            ) dupes
        """,
        description="One price row per stock per day. Guards the grain of the table.",
    ),
    Check(
        name="no_null_close",
        target="warehouse.daily_prices",
        sql="""
            SELECT COUNT(*) AS failed_records
            FROM warehouse.daily_prices
            WHERE close IS NULL
        """,
        description="Close price drives every downstream metric, so it cannot be null.",
    ),
    Check(
        name="prices_positive",
        target="warehouse.daily_prices",
        sql="""
            SELECT COUNT(*) AS failed_records
            FROM warehouse.daily_prices
            WHERE open <= 0 OR high <= 0 OR low <= 0 OR close <= 0
        """,
        description="A traded price can never be zero or negative.",
    ),
    Check(
        name="high_low_consistent",
        target="warehouse.daily_prices",
        sql="""
            SELECT COUNT(*) AS failed_records
            FROM warehouse.daily_prices
            WHERE high < low
               OR close > high
               OR close < low
               OR open  > high
               OR open  < low
        """,
        description="OHLC must obey low <= open/close <= high.",
    ),
    Check(
        name="no_future_dates",
        target="warehouse.daily_prices",
        sql="""
            SELECT COUNT(*) AS failed_records
            FROM warehouse.daily_prices
            WHERE trade_date > CURRENT_DATE
        """,
        description="Catches timezone bugs that would create tomorrow's data.",
    ),
    Check(
        name="orphan_prices",
        target="warehouse.daily_prices",
        sql="""
            SELECT COUNT(*) AS failed_records
            FROM warehouse.daily_prices p
            LEFT JOIN warehouse.stocks s ON s.stock_id = p.stock_id
            WHERE s.stock_id IS NULL
        """,
        description="Referential integrity between the fact and dimension tables.",
    ),
    Check(
        name="extreme_daily_move",
        target="warehouse.stock_metrics",
        sql=f"""
            SELECT COUNT(*) AS failed_records
            FROM warehouse.stock_metrics
            WHERE ABS(daily_return) > {MAX_DAILY_MOVE_PERCENT}
        """,
        severity="WARN",
        description=(
            "A one-day move beyond the threshold usually means an unadjusted "
            "split rather than a real market move. Flagged, not fatal."
        ),
    ),
    Check(
        name="data_freshness",
        target="warehouse.daily_prices",
        # Markets close on weekends and holidays, so a 5-day gap is tolerated.
        sql="""
            SELECT CASE
                       WHEN MAX(trade_date) < CURRENT_DATE - INTERVAL '5 days'
                       THEN 1 ELSE 0
                   END AS failed_records
            FROM warehouse.daily_prices
        """,
        severity="WARN",
        description="Warns when the newest data is stale, allowing for holidays.",
    ),
]


def run(batch_id: str | None = None) -> dict:
    """
    Execute every check, log the results, and fail loudly if any ERROR-level
    check found offending rows.
    """
    logger.info("Running %s data quality checks", len(CHECKS))

    errors: list[str] = []
    warnings: list[str] = []
    results: list[dict] = []

    for check in CHECKS:
        row = db.query_one(check.sql)
        failed = int(row["failed_records"]) if row else 0
        passed = failed == 0

        db.log_quality_check(
            batch_id=batch_id,
            check_name=check.name,
            check_target=check.target,
            failed_records=failed,
            passed=passed,
            severity=check.severity,
            details=check.description,
        )

        results.append(
            {
                "check": check.name,
                "severity": check.severity,
                "failed_records": failed,
                "passed": passed,
            }
        )

        if passed:
            logger.info("PASS  %-22s %s", check.name, check.target)
        elif check.severity == "ERROR":
            errors.append(f"{check.name} ({failed} rows)")
            logger.error("FAIL  %-22s %s offending rows", check.name, failed)
        else:
            warnings.append(f"{check.name} ({failed} rows)")
            logger.warning("WARN  %-22s %s offending rows", check.name, failed)

    summary = {
        "total": len(CHECKS),
        "passed": sum(1 for r in results if r["passed"]),
        "errors": len(errors),
        "warnings": len(warnings),
        "results": results,
    }
    logger.info(
        "Quality gate: %s/%s passed, %s errors, %s warnings",
        summary["passed"],
        summary["total"],
        summary["errors"],
        summary["warnings"],
    )

    if errors:
        raise ValueError("Data quality gate failed: " + "; ".join(errors))

    return summary


if __name__ == "__main__":
    try:
        run()
    except Exception:
        logger.exception("quality_checks terminated with an error")
        sys.exit(1)
