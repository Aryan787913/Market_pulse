"""
Applies a .sql migration file to the database named by DATABASE_URL.

A tiny runner rather than a dependency on psql: psql is not installed with the
Python toolchain this project already uses, and every migration here is written
to be safely re-runnable, so a plain "execute the whole file" is enough. Each
file is sent as a single statement batch so that a failure part-way through
leaves nothing half-applied.

Usage:
    python database/migrations/apply_migration.py 002_google_auth.sql
"""

import os
import sys
from pathlib import Path

import psycopg2
from dotenv import load_dotenv

# The .env sits at the project root, two levels above this file.
PROJECT_ROOT = Path(__file__).resolve().parents[2]
load_dotenv(PROJECT_ROOT / ".env")


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: apply_migration.py <file.sql>", file=sys.stderr)
        return 2

    sql_path = Path(__file__).resolve().parent / sys.argv[1]
    if not sql_path.exists():
        print(f"migration not found: {sql_path}", file=sys.stderr)
        return 1

    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        print("DATABASE_URL is not set. Copy .env.example to .env.", file=sys.stderr)
        return 1

    sql = sql_path.read_text(encoding="utf-8")

    # Not autocommit: the whole file succeeds or none of it is kept.
    connection = psycopg2.connect(database_url)
    try:
        with connection, connection.cursor() as cursor:
            cursor.execute(sql)
        print(f"applied {sql_path.name}")

        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT column_name, is_nullable
                  FROM information_schema.columns
                 WHERE table_schema = 'warehouse'
                   AND table_name = 'users'
                 ORDER BY ordinal_position
                """
            )
            print("warehouse.users columns:")
            for name, nullable in cursor.fetchall():
                print(f"  {name} (nullable: {nullable})")
    finally:
        connection.close()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
