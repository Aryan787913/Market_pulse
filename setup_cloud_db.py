"""
One-command setup of the hosted (Neon) warehouse.

Locally the deployment is prepared in several steps - apply the schema, fetch
prices, build the dbt models, run the quality gate - each with its own command
and its own environment expectations. Against a hosted database that is easy to
get wrong in ways that are hard to see: a schema applied to the wrong database,
or dbt quietly writing to localhost because DBT_TARGET was not set.

This script does the whole sequence against whatever DATABASE_URL points at, in
the one correct order, and stops at the first failure.

    python setup_cloud_db.py

Prerequisite: DATABASE_URL must be set in marketpulse/.env. Nothing here prompts
for or prints a credential; the connection is only ever described through
config.describe_target(), which omits the password.

Order matters and is not arbitrary:

  1. schema  - creates the raw/warehouse/analytics schemas, the constrained
               tables, and seeds warehouse.stocks. Everything else depends on it.
  2. fetch   - loads raw.daily_prices_raw. On an empty database fetch_data.py
               chooses its own backfill window, so this is a full year of
               history without being told.
  3. dbt     - builds the analytics views whose post-hooks upsert into the
               warehouse tables the API reads.
  4. quality - validates what dbt produced, which is why it runs last.

dbt is invoked with --target prod because profiles.yml reads the hosted
connection from PG* variables rather than DATABASE_URL (dbt-postgres has no
connect-by-URL option). Those variables are derived here from the already-parsed
DB_CONFIG so there is a single source of truth for where the data goes.
"""

import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

from data_pipeline import config  # noqa: E402  (needs the path set up first)


def fail(message: str) -> "NoReturn":  # type: ignore[valid-type]
    print(f"\n[FAILED] {message}")
    sys.exit(1)


def banner(step: str, detail: str) -> None:
    print(f"\n{'=' * 70}\n{step}\n  {detail}\n{'=' * 70}", flush=True)


def run(cmd: list[str], cwd: Path, env: dict | None = None) -> None:
    """Run a child process, streaming its output, and abort if it fails."""
    print(f"$ {' '.join(cmd)}  (in {cwd.name}/)", flush=True)
    result = subprocess.run(cmd, cwd=cwd, env=env)
    if result.returncode != 0:
        fail(f"command exited with code {result.returncode}: {' '.join(cmd)}")


def apply_schema() -> None:
    """Execute database/schema.sql.

    psycopg2 is used rather than shelling out to psql because psql is not
    installed with Python and may be absent on a machine that only ever talked
    to Postgres through Docker. schema.sql is written to be idempotent
    (IF NOT EXISTS / ON CONFLICT DO NOTHING), so re-running this is safe.
    """
    import psycopg2

    sql = (ROOT / "database" / "schema.sql").read_text(encoding="utf-8")

    with psycopg2.connect(**config.DB_CONFIG) as conn:
        conn.autocommit = True
        with conn.cursor() as cur:
            cur.execute(sql)

    print("Schema applied.")


def report_counts() -> None:
    """Print the row counts that prove the warehouse is actually populated."""
    import psycopg2

    queries = [
        ("warehouse.stocks", "SELECT COUNT(*) FROM warehouse.stocks"),
        ("raw.daily_prices_raw", "SELECT COUNT(*) FROM raw.daily_prices_raw"),
        ("warehouse.daily_prices", "SELECT COUNT(*) FROM warehouse.daily_prices"),
        ("warehouse.stock_metrics", "SELECT COUNT(*) FROM warehouse.stock_metrics"),
        (
            "date range",
            "SELECT MIN(trade_date)::text || ' to ' || MAX(trade_date)::text "
            "FROM warehouse.daily_prices",
        ),
    ]

    with psycopg2.connect(**config.DB_CONFIG) as conn:
        with conn.cursor() as cur:
            print()
            for label, sql in queries:
                cur.execute(sql)
                print(f"  {label:<26} {cur.fetchone()[0]}")


def main() -> None:
    if not config.DATABASE_URL:
        fail(
            "DATABASE_URL is not set in marketpulse/.env, so this would run "
            "against local Postgres instead of the hosted database.\n"
            "         Add a line of the form:\n"
            "           DATABASE_URL=postgresql://user:pass@ep-xxx.neon.tech/dbname?sslmode=require"
        )

    print("MarketPulse - hosted warehouse setup")
    print(f"Target: {config.describe_target()}")

    banner("STEP 1/4  Apply the schema", "database/schema.sql")
    apply_schema()

    banner("STEP 2/4  Load prices", "data_pipeline/fetch_data.py")
    run([sys.executable, "data_pipeline/fetch_data.py"], cwd=ROOT)

    # dbt reads the hosted connection from PG* variables via profiles.yml, so
    # they are derived from the same parsed config the Python steps used.
    dbt_env = os.environ.copy()
    dbt_env.update(
        {
            "DBT_TARGET": "prod",
            "PGHOST": config.DB_CONFIG["host"],
            "PGPORT": str(config.DB_CONFIG["port"]),
            "PGUSER": config.DB_CONFIG["user"],
            "PGPASSWORD": config.DB_CONFIG["password"],
            "PGDATABASE": config.DB_CONFIG["dbname"],
        }
    )
    dbt_dir = ROOT / "dbt_marketpulse"

    banner("STEP 3/4  Build the models", "dbt deps && dbt build --target prod")
    run(["dbt", "deps", "--profiles-dir", "."], cwd=dbt_dir, env=dbt_env)
    run(
        ["dbt", "build", "--profiles-dir", ".", "--target", "prod"],
        cwd=dbt_dir,
        env=dbt_env,
    )

    banner("STEP 4/4  Run the quality gate", "data_pipeline/quality_checks.py")
    run([sys.executable, "data_pipeline/quality_checks.py"], cwd=ROOT)

    banner("DONE", "row counts in the hosted warehouse")
    report_counts()
    print("\nThe hosted database is ready. Next: import the repo in Vercel.")


if __name__ == "__main__":
    main()
