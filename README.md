# MarketPulse — Stock Market Data Pipeline & Analytics Dashboard

An end-to-end data engineering project. Daily stock prices are ingested from a
public market API into a raw landing zone, transformed into curated warehouse
tables with dbt, validated by a data quality gate, orchestrated by Airflow, and
served to a React dashboard through an Express REST API.

```
yfinance API
     │  fetch_data.py                (Python: extract + load, idempotent upsert)
     ▼
raw.daily_prices_raw
     │  dbt run                      (SQL transformations)
     ▼
analytics.stg_daily_prices  ──►  analytics.mart_daily_prices
                                          │        │ post_hook upsert
                                          │        ▼
                                          │  warehouse.daily_prices
                                          ▼
                                 analytics.mart_stock_metrics
                                          │ post_hook upsert
                                          ▼
                                 warehouse.stock_metrics
     │  quality_checks.py            (10 checks, logged to raw.data_quality_log)
     │
     │  Express REST API             (JWT auth, parameterised SQL)
     ▼
React + Recharts dashboard
```

Airflow's `marketpulse_daily` DAG runs the whole chain on a schedule:
`fetch_data → run_dbt_models → run_quality_checks → pipeline_summary`, with
`notify_on_failure` firing if any task fails.

## Tech stack

| Layer | Technology |
|---|---|
| Ingestion | Python 3.11, yfinance, pandas, psycopg2 |
| Warehouse | PostgreSQL 15 (`raw`, `warehouse`, `analytics` schemas) |
| Transformation | dbt-postgres |
| Orchestration | Apache Airflow 2 |
| API | Node.js, Express, jsonwebtoken, bcrypt, express-validator |
| Frontend | React 18, Vite, React Router, Recharts, Axios |
| Infrastructure | Docker Compose |

## Repository layout

```
marketpulse/
├── database/
│   ├── schema.sql              # schemas, tables, indexes, seed stock list
│   └── init_airflow_db.sql     # separate metadata DB for Airflow
├── data_pipeline/
│   ├── config.py               # env-driven settings, symbol universe
│   ├── db.py                   # connection helper, upserts, log writers
│   ├── fetch_data.py           # extract from yfinance, load into raw
│   ├── quality_checks.py       # 10 validation rules, results logged to the DB
│   └── dags/marketpulse_dag.py # Airflow DAG wiring the tasks together
├── dbt_marketpulse/            # staging + marts models, tests, sources
├── backend/                    # Express API
├── frontend/                   # React dashboard
├── docker-compose.yml          # Postgres + Airflow
├── requirements.txt
└── .env.example
```

## How the database is organised

Three schemas inside one database, each with a distinct job:

| Schema | Contents | Written by |
|---|---|---|
| `raw` | `daily_prices_raw`, `ingestion_log`, `data_quality_log` | `fetch_data.py`, `quality_checks.py` |
| `analytics` | `stg_daily_prices`, `mart_daily_prices`, `mart_stock_metrics` (views) | dbt |
| `warehouse` | `stocks`, `daily_prices`, `stock_metrics` | dbt post-hooks |

The dbt models are materialised as **views** in `analytics`. Each mart then has a
`post_hook` that upserts its rows into the constrained tables in `warehouse`.
That extra step exists so the primary keys, foreign keys, and CHECK constraints
declared in `database/schema.sql` stay in force — a plain `materialized: table`
would drop and recreate the table on every run, taking the constraints with it.
The API reads from `warehouse`.

## Prerequisites

- Docker Desktop (for PostgreSQL and Airflow)
- Python 3.11+
- Node.js 18+

## Setup

### 1. Environment variables

```bash
cd marketpulse
copy .env.example .env      # Windows
# cp .env.example .env      # macOS/Linux
```

Open `.env` and set real values. Two entries matter most:

- `DB_PASSWORD` — the PostgreSQL password
- `JWT_SECRET` — a long random string used to sign login tokens

Generate a secret with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

`.env` is listed in `.gitignore` and must never be committed.

### 2. Start PostgreSQL and Airflow

```bash
docker compose up -d
```

This starts Postgres on port 5432, the Airflow webserver on 8080, and the
scheduler.

### 3. Create the schema

```bash
psql -U postgres -d marketpulse -f database/schema.sql
```

This creates the three schemas, all tables and indexes, and seeds the stock
list in `warehouse.stocks`. It is safe to re-run — everything uses
`IF NOT EXISTS`.

### 4. Install Python dependencies

```bash
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
```

### 5. Load the data

```bash
python data_pipeline/fetch_data.py
```

The script decides its own lookback window: if `raw.daily_prices_raw` is empty
it pulls `BACKFILL_DAYS` (default 365) of history, otherwise just
`INCREMENTAL_DAYS` (default 7). The first run is therefore a full backfill
automatically, which is what gives the 30-day moving average enough history to
be meaningful.

To reprocess a specific past period, pass the range explicitly:

```bash
# one quarter, every symbol
python data_pipeline/fetch_data.py --start 2025-01-01 --end 2025-03-31

# repair a single symbol over a few days
python data_pipeline/fetch_data.py --start 2025-05-12 --end 2025-05-16 --symbols TCS.NS
```

`--end` is inclusive. Re-running a range is safe: the raw insert upserts on
`(symbol, trade_date)`, so a repeated backfill overwrites those days instead of
duplicating them. Bad input (a reversed range, a future start, a malformed date,
an unknown symbol) is rejected before any download begins.

### 6. Build the warehouse tables

```bash
cd dbt_marketpulse
dbt deps
dbt run
dbt test
cd ..
```

### 7. Run the quality gate

```bash
python data_pipeline/quality_checks.py
```

Note the order: the checks run **after** dbt, because they validate the
`warehouse` tables that dbt produces.

### 8. Start the API

```bash
cd backend
npm install
npm run dev          # http://localhost:5000
```

### 9. Start the dashboard

```bash
cd frontend
npm install
npm run dev          # http://localhost:5173
```

Open http://localhost:5173, register an account, and the dashboard loads.

## Running the pipeline on a schedule

Open Airflow at http://localhost:8080 and unpause `marketpulse_daily`. The
schedule is `0 19 * * 1-5` — weekday evenings IST, after the Indian market has
closed and Yahoo Finance has published the day's final bar. Trigger it manually
with the play button to watch a run end to end.

The `batch_id` generated by `fetch_data` is passed to the quality checks through
XCom, so every check result is traceable back to the exact ingestion run that
produced the data.

### Backfilling through Airflow

The DAG exposes the same range as run parameters, so a backfill is an operator
action rather than a code change. Use **Trigger DAG w/ config** in the UI and
fill in `start` / `end` / `symbols`, or from the CLI:

```bash
airflow dags trigger marketpulse_daily_pipeline \
    --conf '{"start": "2025-01-01", "end": "2025-03-31"}'
```

Leaving the fields blank runs the normal daily window. Because a backfill is a
full DAG run, dbt rebuilds the models and the quality gate re-validates the
reprocessed range in the same run.

Note this is deliberately not Airflow's own `catchup` mechanism. Catchup would
schedule one run per missed day; a range backfill is a single run that fetches
the whole period at once, which is both faster and closer to how the source API
works.

## Tests

```bash
python -m pytest
```

40 tests covering the two pieces of pipeline logic that can fail silently: the
window/symbol resolution that decides what a run fetches, and the `_normalise`
transform that reshapes vendor data into warehouse rows. Neither needs a
database or network access — `resolve_window` takes `today` and `raw_is_empty` as
arguments, and the transform tests build DataFrames in memory — so the suite runs
in about a second.

Results of every run are visible inside the app on the **Pipeline & Data
Quality** page, which reads from `raw.ingestion_log` and `raw.data_quality_log`.

## Deploying to the cloud (Neon + Vercel + GitHub Actions)

Everything above runs on one machine. The deployed version splits the same
system across three free-tier services, because the three parts have genuinely
different runtime needs:

| Part | Host | Why |
|---|---|---|
| PostgreSQL warehouse | Neon | The one component that must hold state permanently |
| Express API + React build | Vercel | Request-driven, idle most of the day |
| Daily pipeline | GitHub Actions | Needs a scheduler and a few minutes of CPU, not a web server |

No application code was rewritten for this. The pieces that made it possible
were already there: `app.js` exports the Express app without calling `listen()`,
and both `config.py` and `config/db.js` read connection settings from the
environment.

### 1. Create the database on Neon

Sign up at neon.tech, create a project, and copy the connection string it shows
(it looks like `postgresql://user:pass@ep-xxx.aws.neon.tech/dbname?sslmode=require`).

Apply the schema to it. `psql` accepts the URL directly:

```bash
psql "postgresql://user:pass@ep-xxx.aws.neon.tech/dbname?sslmode=require" -f database/schema.sql
```

Then point the local tooling at Neon by setting one variable in `.env`:

```
DATABASE_URL=postgresql://user:pass@ep-xxx.aws.neon.tech/dbname?sslmode=require
```

When `DATABASE_URL` is present it overrides every `DB_*` value and turns TLS on,
because hosted providers refuse plaintext connections. Leave it blank to go back
to local Postgres — nothing else has to change.

### 2. Deploy the API and dashboard on Vercel

Push the repository to GitHub, then import it in Vercel. `vercel.json` already
describes the build: the React app is built to `frontend/dist` and served as
static files, and every `/api/*` request is handled by `api/[...path].js`, which
re-exports the same Express app used locally.

The API function is a catch-all filesystem route (`[...path]`) rather than an
`index.js` reached through a rewrite. Vercel routes an internal rewrite using its
*destination* path, so a rule sending `/api/(.*)` to `/api/index` would hand
Express the literal path `/api/index`, which matches none of its routes and would
turn every API call into a 404. A catch-all route receives `/api/stocks` and
`/api/auth/login` unchanged, so Express does its own routing exactly as it does
locally.


Set these environment variables in the Vercel project (Settings → Environment
Variables):

| Variable | Value |
|---|---|
| `DATABASE_URL` | the Neon connection string |
| `JWT_SECRET` | a long random string, e.g. `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `NODE_ENV` | `production` |

`VITE_API_BASE_URL` is deliberately *not* set: the API and the dashboard are
served from one domain in this deployment, so the frontend falls back to the
relative `/api` path and no cross-origin request is ever made.

One thing to know about serverless and Postgres: each function instance opens
its own pool, so `max` is kept small in `config/db.js` to stay inside Neon's
connection limit. Neon also suspends an idle database, which is why the first
request after a quiet period is slower than the rest.

### 3. Schedule the pipeline with GitHub Actions

Airflow cannot be used here — its scheduler and metadata database have to run
continuously, which no free serverless host offers. `.github/workflows/daily-pipeline.yml`
takes its place and mirrors the DAG task for task:

| DAG task | Workflow step |
|---|---|
| `fetch_data` | Extract into the raw zone |
| `run_dbt_models` | `dbt build` |
| `run_quality_checks` | Run the SQL quality gate |
| `pipeline_summary` | Print the run summary |
| `notify_on_failure` | Report failure (`if: failure()`) |

The behaviour that mattered is preserved: the same weekday-evening IST schedule
(written as `30 13 * * 1-5`, since GitHub cron is UTC), one run at a time via
`concurrency`, and a stop at the first failing step.

Add the connection string as a repository secret named `DATABASE_URL` under
Settings → Secrets and variables → Actions. The workflow splits it into the
`PG*` variables dbt needs and masks the password so it cannot appear in logs.

Then run it once by hand from the Actions tab with **backfill** checked, which
widens the window to a year and loads history into the empty database. After
that it runs on its own each weekday.

The manual trigger also accepts `start`, `end`, and `symbols`, mirroring the
Airflow config described above — so a specific range can be reprocessed in the
cloud without touching the code. The values are passed to the script through
environment variables rather than interpolated into the shell command, since
`${{ }}` would substitute an operator's text directly into the run script.

## API reference


All routes are prefixed with `/api`. Everything except register and login
requires an `Authorization: Bearer <token>` header.

| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/auth/register` | Create an account, returns a JWT |
| POST | `/auth/login` | Log in, returns a JWT |
| GET | `/auth/me` | Current user from the token |
| GET | `/stocks` | All stocks with latest metrics (`sector`, `sortBy`, `order`) |
| GET | `/stocks/:symbol` | One stock's latest snapshot |
| GET | `/stocks/:symbol/history` | Price history (`days`) |
| GET | `/stocks/movers/top` | Top gainers and losers (`limit`) |
| GET | `/stocks/sectors/summary` | Average daily return per sector |
| GET | `/watchlist` | The signed-in user's watchlist |
| POST | `/watchlist` | Add a symbol |
| DELETE | `/watchlist/:symbol` | Remove a symbol |
| GET | `/pipeline/runs` | Recent ingestion runs (`limit`) |
| GET | `/pipeline/quality` | Latest batch's quality results plus a tally |
| GET | `/pipeline/freshness` | How current the warehouse is |

## Data quality checks

`quality_checks.py` runs ten rules and writes each result to
`raw.data_quality_log` with a severity. `ERROR` failures raise, which fails the
Airflow task and stops the DAG; `WARN` failures are recorded and logged only.

| Check | Severity | Catches |
|---|---|---|
| `warehouse_not_empty` | ERROR | A load that silently produced nothing |
| `metrics_not_empty` | ERROR | dbt building no metric rows |
| `no_duplicate_prices` | ERROR | Broken grain — two rows for one stock-day |
| `no_null_close` | ERROR | Missing close price, which every metric depends on |
| `prices_positive` | ERROR | Zero or negative prices from a bad response |
| `high_low_consistent` | ERROR | OHLC violating `low <= open/close <= high` |
| `no_future_dates` | ERROR | Timezone bugs creating tomorrow's data |
| `orphan_prices` | ERROR | Price rows with no matching stock |
| `extreme_daily_move` | WARN | Unadjusted splits (move > threshold) |
| `data_freshness` | WARN | Newest data older than 5 days |

## Notes on design decisions

- **Upsert, not insert.** Raw loads use `ON CONFLICT (symbol, trade_date)`, so
  re-running the pipeline for the same day is safe and repeatable. The
  `INCREMENTAL_DAYS` window deliberately overlaps previous runs to pick up late
  corrections from the source.
- **Metrics computed in SQL.** Moving averages, returns, and volatility come from
  window functions in dbt models rather than being calculated in the API or the
  browser, so every consumer sees the same numbers.
- **Constraints are preserved, not recreated.** Views plus post-hook upserts keep
  the hand-written schema authoritative (see "How the database is organised").
- **Every run is auditable.** `raw.ingestion_log` and `raw.data_quality_log` mean
  the pipeline's history is queryable, not just visible in Airflow's console.
- **Passwords are hashed with bcrypt**, and every SQL query uses parameterised
  placeholders instead of string concatenation.
- **The API is the only thing that touches the database.** The frontend has no
  credentials of its own.

## Troubleshooting

**`ECONNREFUSED` when starting the backend** — Postgres is not up yet. Check
`docker compose ps`.

**Dashboard tables are empty** — the `warehouse` tables have not been built. Run
`dbt run` inside `dbt_marketpulse`.

**Moving averages show `—`** — expected for a stock's first days, since a 7-day
window needs 7 days of history. Confirm the first run actually backfilled by
checking `MIN(trade_date)` in `raw.daily_prices_raw`.

**`no_duplicate_prices` fails** — a mart post-hook ran with a broken join key.
Inspect `analytics.mart_daily_prices` for repeated `(stock_id, trade_date)`.

**`401 Unauthorized` on every request** — the token expired
(`JWT_EXPIRES_IN`, default 24h). Log out and back in.
