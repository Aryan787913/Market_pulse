/*
    mart_daily_prices
    -----------------
    Publishes the cleaned price rows into warehouse.daily_prices.

    The model itself is only a view over staging. The actual load happens in the
    post_hook, which performs an idempotent UPSERT into the real, constrained
    table. Doing it this way keeps the primary keys, foreign keys and CHECK
    constraints declared in database/schema.sql, which a plain dbt
    "materialized: table" would drop and recreate on every run.

    Note on syntax: the hook is written as a single-quoted Jinja string. dbt
    renders hook strings a second time at run time, which is why {{ this }}
    still resolves to this model's view name.
*/

{{
    config(
        materialized = 'view',
        post_hook = "
            INSERT INTO warehouse.daily_prices
                (stock_id, trade_date, open, high, low, close, volume)
            SELECT stock_id, trade_date, open, high, low, close, volume
            FROM {{ this }}
            ON CONFLICT (stock_id, trade_date) DO UPDATE SET
                open      = EXCLUDED.open,
                high      = EXCLUDED.high,
                low       = EXCLUDED.low,
                close     = EXCLUDED.close,
                volume    = EXCLUDED.volume,
                loaded_at = NOW()
        "
    )
}}

SELECT
    stock_id,
    symbol,
    trade_date,
    open,
    high,
    low,
    close,
    volume
FROM {{ ref('stg_daily_prices') }}
