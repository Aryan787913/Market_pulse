/*
    stg_daily_prices
    ----------------
    First cleaning pass over the raw landing zone.

    Responsibilities:
      1. Resolve the source symbol to the warehouse stock_id (inner join, so
         any symbol that is not in the tracked universe is dropped).
      2. Drop rows that cannot be trusted: null prices, non-positive prices,
         impossible OHLC relationships, or future dates.
      3. Deduplicate. The raw table has a unique constraint, but keeping the
         window function here means the model still behaves correctly if the
         constraint is ever relaxed or the table is loaded from elsewhere.

    Materialised as a view: it is cheap and always reflects the latest raw data.
*/

WITH source AS (

    SELECT
        r.symbol,
        r.trade_date,
        r.open,
        r.high,
        r.low,
        r.close,
        r.volume,
        r.ingested_at,
        -- Keep only the most recently ingested version of each symbol/date pair.
        ROW_NUMBER() OVER (
            PARTITION BY r.symbol, r.trade_date
            ORDER BY r.ingested_at DESC, r.id DESC
        ) AS row_rank
    FROM {{ source('raw', 'daily_prices_raw') }} r

),

deduplicated AS (

    SELECT * FROM source WHERE row_rank = 1

),

validated AS (

    SELECT
        s.stock_id,
        d.symbol,
        d.trade_date,
        ROUND(d.open,  4) AS open,
        ROUND(d.high,  4) AS high,
        ROUND(d.low,   4) AS low,
        ROUND(d.close, 4) AS close,
        COALESCE(d.volume, 0) AS volume,
        d.ingested_at
    FROM deduplicated d
    -- Inner join enforces referential integrity before the warehouse load.
    INNER JOIN {{ source('warehouse', 'stocks') }} s
            ON s.symbol = d.symbol
           AND s.is_active = TRUE
    WHERE d.close IS NOT NULL
      AND d.open  IS NOT NULL
      AND d.high  IS NOT NULL
      AND d.low   IS NOT NULL
      -- A traded price is always strictly positive.
      AND d.open  > 0
      AND d.high  > 0
      AND d.low   > 0
      AND d.close > 0
      -- Basic OHLC sanity: the day's range must contain open and close.
      AND d.high >= d.low
      AND d.close BETWEEN d.low AND d.high
      AND d.open  BETWEEN d.low AND d.high
      -- Guard against timezone bugs producing tomorrow's bar.
      AND d.trade_date <= CURRENT_DATE

)

SELECT * FROM validated
