"""
Central configuration for the MarketPulse data pipeline.

All secrets are read from environment variables so that nothing sensitive is
ever committed to Git. Copy .env.example to .env and fill in real values.
"""

import os
from pathlib import Path
from urllib.parse import quote_plus, unquote, urlparse

from dotenv import load_dotenv


# Load .env from the project root (one level above data_pipeline/)
PROJECT_ROOT = Path(__file__).resolve().parent.parent
load_dotenv(PROJECT_ROOT / ".env")


# ---------------------------------------------------------------------------
# Database connection
# ---------------------------------------------------------------------------
# The warehouse can live in either of two places and the pipeline must reach
# both without code changes:
#
#   * A local PostgreSQL instance during development, described by the separate
#     DB_HOST / DB_PORT / DB_NAME / DB_USER / DB_PASSWORD variables.
#
#   * A hosted PostgreSQL instance (Neon) when the pipeline runs in CI, which
#     issues a single connection URL instead of separate parts.
#
# DATABASE_URL therefore takes precedence when it is set, and the individual
# DB_* variables are the fallback. Parsing the URL into components rather than
# passing it straight through keeps one shape of configuration (DB_CONFIG) for
# the rest of the pipeline, so psycopg2 connections and logging behave the same
# either way.
DATABASE_URL = os.getenv("DATABASE_URL", "").strip()

# Hosted providers reject unencrypted connections, so TLS is required whenever a
# connection URL is in use. Locally, Postgres usually has no certificate at all
# and "prefer" lets the connection fall back to plaintext instead of failing.
DB_SSLMODE = os.getenv("DB_SSLMODE", "require" if DATABASE_URL else "prefer")


def _config_from_url(url: str) -> dict:
    """Split a postgresql:// URL into the parts psycopg2 expects."""
    parsed = urlparse(url)

    return {
        "host": parsed.hostname or "localhost",
        "port": parsed.port or 5432,
        # The path starts with "/", which is not part of the database name.
        "dbname": (parsed.path or "/marketpulse").lstrip("/") or "marketpulse",
        # Credentials may be percent-encoded in a URL, so they are decoded here.
        "user": unquote(parsed.username or "postgres"),
        "password": unquote(parsed.password or ""),
    }


if DATABASE_URL:
    DB_CONFIG = _config_from_url(DATABASE_URL)
else:
    DB_CONFIG = {
        "host": os.getenv("DB_HOST", "localhost"),
        "port": int(os.getenv("DB_PORT", "5432")),
        "dbname": os.getenv("DB_NAME", "marketpulse"),
        "user": os.getenv("DB_USER", "postgres"),
        "password": os.getenv("DB_PASSWORD", ""),
    }

# psycopg2 accepts sslmode as a normal connection keyword.
DB_CONFIG["sslmode"] = DB_SSLMODE


def get_db_uri() -> str:
    """SQLAlchemy-style URI, used by pandas.to_sql.

    Rebuilt from DB_CONFIG rather than returning DATABASE_URL verbatim, because a
    hosted URL often carries extra query parameters (channel_binding, connection
    pooling hints) that SQLAlchemy passes through to psycopg2 and that psycopg2
    then rejects as unknown keywords.
    """
    password = quote_plus(DB_CONFIG["password"])
    user = quote_plus(DB_CONFIG["user"])

    return (
        f"postgresql://{user}:{password}"
        f"@{DB_CONFIG['host']}:{DB_CONFIG['port']}/{DB_CONFIG['dbname']}"
        f"?sslmode={DB_SSLMODE}"
    )


def describe_target() -> str:
    """Human-readable connection summary for logs. Never includes the password."""
    source = "DATABASE_URL" if DATABASE_URL else "DB_* variables"
    return (
        f"{DB_CONFIG['user']}@{DB_CONFIG['host']}:{DB_CONFIG['port']}"
        f"/{DB_CONFIG['dbname']} (sslmode={DB_SSLMODE}, from {source})"
    )



# ---------------------------------------------------------------------------
# Stock universe
# ---------------------------------------------------------------------------
# Kept in code (not the DB) so the pipeline can bootstrap an empty database.
# Must stay in sync with the seed data in database/schema.sql.
STOCK_SYMBOLS = [
    "RELIANCE.NS",
    "TCS.NS",
    "INFY.NS",
    "HDFCBANK.NS",
    "ICICIBANK.NS",
    "SBIN.NS",
    "ITC.NS",
    "LT.NS",
    "WIPRO.NS",
    "TATAMOTORS.NS",
    "^NSEI",
    "^BSESN",
]


# ---------------------------------------------------------------------------
# Ingestion behaviour
# ---------------------------------------------------------------------------
# On the very first run we backfill this many days of history so the moving
# averages and volatility windows have enough data to be meaningful.
BACKFILL_DAYS = int(os.getenv("BACKFILL_DAYS", "365"))

# Normal daily runs only need a small lookback window. A few days of overlap
# covers weekends, market holidays and any late corrections from the source.
INCREMENTAL_DAYS = int(os.getenv("INCREMENTAL_DAYS", "7"))

# Retry settings for transient network / API failures.
MAX_RETRIES = 3
RETRY_DELAY_SECONDS = 5


# ---------------------------------------------------------------------------
# Data quality thresholds
# ---------------------------------------------------------------------------
# If more than this fraction of symbols fail in a single run, treat the whole
# run as FAILED instead of PARTIAL.
MAX_FAILURE_RATIO = 0.4

# Reject a price row if the close moves more than this percent in one day.
# Real single-day moves beyond this are almost always bad source data
# (e.g. an unadjusted stock split).
MAX_DAILY_MOVE_PERCENT = 40.0


# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO")
LOG_FORMAT = "%(asctime)s | %(levelname)-8s | %(name)s | %(message)s"
