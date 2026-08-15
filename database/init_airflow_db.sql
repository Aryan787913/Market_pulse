-- Creates a separate database for Airflow's own metadata (DAG runs, task
-- instances, XComs, users). Keeping it out of the marketpulse database means
-- Airflow's internal tables never mix with the analytical warehouse, so the
-- warehouse can be dropped and rebuilt without losing pipeline history.
--
-- Runs automatically on the first container start, after 01_schema.sql.

SELECT 'CREATE DATABASE airflow'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'airflow')\gexec
