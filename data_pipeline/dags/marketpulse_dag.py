"""
MarketPulse daily orchestration DAG.

Task flow:

    fetch_data >> run_dbt_models >> run_quality_checks >> pipeline_summary
         |               |                  |
         +---------------+------------------+--> notify_on_failure

Scheduling notes:
  * schedule 0 19 * * 1-5 (IST) runs on weekday evenings, after the Indian
    market has closed and Yahoo Finance has published the day's final bar.
  * catchup=False because the ingestion script always fetches a trailing window
    based on today's date. Replaying old logical dates would add no data;
    reprocessing history is done through the backfill params below instead,
    which is a single run over a range rather than one run per past day.
  * max_active_runs=1 prevents two runs writing the same rows concurrently.
  * notify_on_failure uses trigger_rule=ONE_FAILED so it fires if any upstream
    task fails, but is skipped when everything succeeds.

Backfilling a past period ("Trigger DAG w/ config" in the UI, or the CLI):

    airflow dags trigger marketpulse_daily_pipeline \
        --conf '{"start": "2025-01-01", "end": "2025-03-31"}'

Leave the params empty for the normal daily window. A backfill re-runs the whole
DAG, so dbt rebuilds and the quality gate re-validates the reprocessed range.
"""

from datetime import datetime, timedelta


import pendulum
from airflow import DAG
from airflow.models.param import Param
from airflow.operators.bash import BashOperator
from airflow.operators.python import PythonOperator
from airflow.utils.trigger_rule import TriggerRule


import fetch_data
import quality_checks

LOCAL_TZ = pendulum.timezone("Asia/Kolkata")

default_args = {
    "owner": "aaryan",
    "depends_on_past": False,
    "email_on_failure": False,
    "retries": 2,
    "retry_delay": timedelta(minutes=5),
}

# dbt needs to run from its own project directory.
DBT_DIR = "/opt/airflow/dbt_marketpulse"


def _param(context, name):
    """
    Read a run param, treating a blank string as absent.

    The UI sends "" for a text field the operator left alone, and passing that
    through would look like an explicit request rather than a default, so it is
    normalised to None here.
    """
    value = (context.get("params") or {}).get(name)
    if value is None:
        return None
    value = str(value).strip()
    return value or None


def task_fetch_data(**context):
    """
    Extract from yfinance into the raw zone, then share the batch_id.

    With no params this fetches the normal daily window. With start/end it
    reprocesses that range instead, which is the backfill path.
    """
    start = _param(context, "start")
    end = _param(context, "end")
    symbols = _param(context, "symbols")

    if start or end:
        print(f"Backfill requested: start={start} end={end} symbols={symbols or 'all'}")

    summary = fetch_data.run(start=start, end=end, symbols=symbols)
    # XCom lets the quality-check task tag its results with the same batch_id.
    context["ti"].xcom_push(key="batch_id", value=summary["batch_id"])
    return summary


def task_quality_checks(**context):
    """Run the quality gate against the freshly built warehouse tables."""
    batch_id = context["ti"].xcom_pull(task_ids="fetch_data", key="batch_id")
    return quality_checks.run(batch_id=batch_id)


def task_pipeline_summary(**context):
    """Print a short run report. Shows up in the Airflow task log."""
    ti = context["ti"]
    ingest = ti.xcom_pull(task_ids="fetch_data") or {}
    checks = ti.xcom_pull(task_ids="run_quality_checks") or {}

    print("===== MarketPulse run summary =====")
    print(f"batch_id       : {ingest.get('batch_id')}")
    print(f"ingest status  : {ingest.get('status')}")
    print(f"symbols ok     : {ingest.get('symbols_ok')}")
    print(f"symbols failed : {ingest.get('symbols_failed')}")
    print(f"mode           : {ingest.get('mode')}")
    print(
        f"window         : {ingest.get('window_start')} -> {ingest.get('window_end')}"
    )
    print(f"rows upserted  : {ingest.get('rows_inserted')}")
    print(f"checks passed  : {checks.get('passed')}/{checks.get('total')}")
    print(f"check warnings : {checks.get('warnings')}")
    print("===================================")


def task_notify_on_failure(**context):
    """
    Failure handler. Logs which task broke so the problem is visible in one
    place. In production this is where an email or Slack webhook would go; it is
    kept as a log write here so the project needs no external credentials.
    """
    dag_run = context.get("dag_run")
    failed = []
    if dag_run:
        failed = [
            ti.task_id
            for ti in dag_run.get_task_instances()
            if ti.state == "failed"
        ]

    message = (
        f"MarketPulse pipeline FAILED\n"
        f"  dag        : {context['dag'].dag_id}\n"
        f"  run        : {context['run_id']}\n"
        f"  failed at  : {', '.join(failed) if failed else 'unknown'}\n"
        f"  logical_dt : {context['logical_date']}"
    )
    print(message)
    raise RuntimeError(message)


with DAG(
    dag_id="marketpulse_daily_pipeline",
    description="Fetch daily stock data, transform with dbt, validate quality",
    default_args=default_args,
    start_date=datetime(2026, 1, 1, tzinfo=LOCAL_TZ),
    schedule="0 19 * * 1-5",
    catchup=False,
    max_active_runs=1,
    tags=["marketpulse", "stocks", "etl"],
    # Exposed as form fields under "Trigger DAG w/ config", so a backfill is a
    # normal operator action rather than an edit to the pipeline code.
    params={
        "start": Param(
            default="",
            type="string",
            title="Backfill start date",
            description="YYYY-MM-DD. Leave blank for the normal daily window.",
        ),
        "end": Param(
            default="",
            type="string",
            title="Backfill end date (inclusive)",
            description="YYYY-MM-DD. Defaults to today when a start is given.",
        ),
        "symbols": Param(
            default="",
            type="string",
            title="Symbols",
            description=(
                "Comma-separated subset, e.g. TCS.NS,INFY.NS. "
                "Blank means every configured symbol."
            ),
        ),
    },
) as dag:

    fetch = PythonOperator(
        task_id="fetch_data",
        python_callable=task_fetch_data,
        doc_md="Download OHLCV from yfinance and upsert into raw.daily_prices_raw.",
    )

    # dbt build = run models + execute their tests in dependency order.
    dbt_models = BashOperator(
        task_id="run_dbt_models",
        bash_command=(
            f"cd {DBT_DIR} && "
            "dbt build --profiles-dir . --target dev --no-use-colors"
        ),
        doc_md="Build staging + mart models and run dbt's own schema tests.",
    )

    checks = PythonOperator(
        task_id="run_quality_checks",
        python_callable=task_quality_checks,
        doc_md="Independent SQL quality gate, results stored in raw.data_quality_log.",
    )

    summary = PythonOperator(
        task_id="pipeline_summary",
        python_callable=task_pipeline_summary,
    )

    notify = PythonOperator(
        task_id="notify_on_failure",
        python_callable=task_notify_on_failure,
        # Fires only when something upstream has failed.
        trigger_rule=TriggerRule.ONE_FAILED,
    )

    fetch >> dbt_models >> checks >> summary
    [fetch, dbt_models, checks] >> notify
