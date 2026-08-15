"""
Shared pytest setup.

The pipeline modules import each other by bare name (``import db``,
``import config``) because Airflow puts the dags folder and its siblings on
sys.path at runtime. Tests run outside Airflow, so the same directory is added
here; otherwise ``import fetch_data`` would fail before a single test ran.

No test in this suite touches a database or the network. Anything that needs
either is passed in as an argument or replaced with a fake, which keeps the
suite fast and runnable on a machine with no Postgres.
"""

import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent
PIPELINE_DIR = PROJECT_ROOT / "data_pipeline"

if str(PIPELINE_DIR) not in sys.path:
    sys.path.insert(0, str(PIPELINE_DIR))


@pytest.fixture
def batch_id() -> str:
    """A fixed batch id so assertions can compare exact row tuples."""
    return "test-batch-0001"
