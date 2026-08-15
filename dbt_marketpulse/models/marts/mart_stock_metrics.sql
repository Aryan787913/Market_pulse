/*
    mart_stock_metrics
    ------------------
    The analytical core of the project. Turns a plain price series into the
    metrics the dashboard displays, using SQL window functions:

      daily_return   percentage change of close vs the previous trading day
      moving_avg_7d  7-day simple moving average of close
      moving_avg_30d 30-day simple moving average of close
      volatility_7d  standard deviation of daily returns over 7 days
      volume_avg_7d  7-day average traded volume

    Why window functions and not a self-join: PARTITION BY stock_id keeps each
    stock's series independent, so one stock's history can never leak into
    another's average. ROWS BETWEEN n PRECEDING AND CURRENT ROW gives a true
    trailing window.

    Depends on mart_daily_prices (not staging directly) so that dbt orders the
    warehouse.daily_prices load before this model runs.
*/

{{
    config(
        materialized = 'view',
        post_hook = "
            INSERT INTO warehouse.stock_metrics
                (stock_id, trade_date, close, daily_return, moving_avg_7d,
                 moving_avg_30d, volatility_7d, volume_avg_7d)
            SELECT stock_id, trade_date, close, daily_return, moving_avg_7d,
                   moving_avg_30d, volatility_7d, volume_avg_7d
            FROM {{ this }}
            ON CONFLICT (stock_id, trade_date) DO UPDATE SET
                close          = EXCLUDED.close,
                daily_return   = EXCLUDED.daily_return,
                moving_avg_7d  = EXCLUDED.moving_avg_7d,
                moving_avg_30d = EXCLUDED.moving_avg_30d,
                volatility_7d  = EXCLUDED.volatility_7d,
                volume_avg_7d  = EXCLUDED.volume_avg_7d,
                computed_at    = NOW()
        "
    )
}}

WITH prices AS (

    SELECT
        stock_id,
        symbol,
        trade_date,
        close,
        volume,
        -- Previous trading day's close for this stock only.
        LAG(close) OVER (
            PARTITION BY stock_id
            ORDER BY trade_date
        ) AS prev_close
    FROM {{ ref('mart_daily_prices') }}

),

returns AS (

    SELECT
        stock_id,
        symbol,
        trade_date,
        close,
        volume,
        prev_close,
        -- NULLIF guards against a divide-by-zero if a bad zero close slips in.
        CASE
            WHEN prev_close IS NULL THEN NULL
            ELSE ROUND(
                ((close - prev_close) / NULLIF(prev_close, 0)) * 100, 4
            )
        END AS daily_return
    FROM prices

),

windowed AS (

    SELECT
        stock_id,
        symbol,
        trade_date,
        close,
        daily_return,

        ROUND(AVG(close) OVER (
            PARTITION BY stock_id
            ORDER BY trade_date
            ROWS BETWEEN 6 PRECEDING AND CURRENT ROW
        ), 4) AS moving_avg_7d,

        ROUND(AVG(close) OVER (
            PARTITION BY stock_id
            ORDER BY trade_date
            ROWS BETWEEN 29 PRECEDING AND CURRENT ROW
        ), 4) AS moving_avg_30d,

        -- Sample stddev of returns. STDDEV_SAMP needs at least two rows, so the
        -- first day of every series is NULL here by definition.
        ROUND(STDDEV_SAMP(daily_return) OVER (
            PARTITION BY stock_id
            ORDER BY trade_date
            ROWS BETWEEN 6 PRECEDING AND CURRENT ROW
        ), 4) AS volatility_7d,

        ROUND(AVG(volume) OVER (
            PARTITION BY stock_id
            ORDER BY trade_date
            ROWS BETWEEN 6 PRECEDING AND CURRENT ROW
        ), 0) AS volume_avg_7d

    FROM returns

)

SELECT
    stock_id,
    symbol,
    trade_date,
    close,
    daily_return,
    moving_avg_7d,
    moving_avg_30d,
    volatility_7d,
    CAST(volume_avg_7d AS BIGINT) AS volume_avg_7d
FROM windowed
