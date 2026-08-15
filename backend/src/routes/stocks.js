/**
 * Stock and metrics routes. These serve the dashboard.
 *
 * Every route is behind requireAuth: the dashboard is a private application, so
 * there are no anonymous data endpoints.
 *
 * Two patterns used throughout:
 *   * Values always travel as $1/$2 parameters, never string-concatenated.
 *   * Where a value has to appear inside the SQL text itself (a sort column, a
 *     sort direction), it is resolved through a whitelist map first. A user
 *     cannot inject arbitrary SQL through a query string.
 */

const express = require("express");
const { param, query: q, validationResult } = require("express-validator");

const { query } = require("../config/db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

// Whitelists for anything that becomes part of the SQL text.
const SORT_COLUMNS = {
  symbol: "s.symbol",
  company: "s.company_name",
  sector: "s.sector",
  close: "m.close",
  return: "m.daily_return",
};
const SORT_DIRECTIONS = { asc: "ASC", desc: "DESC" };

function validate(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({
      success: false,
      message: "Validation failed",
      errors: errors.array().map((e) => ({ field: e.path, message: e.msg })),
    });
    return false;
  }
  return true;
}

/**
 * GET /api/stocks
 * Every tracked stock with its latest close and daily return.
 * Optional: ?sector=IT&sortBy=return&order=desc
 *
 * DISTINCT ON is a Postgres feature that returns the first row per group given
 * an ORDER BY, which is the cleanest way to get "latest row per stock".
 */
router.get(
  "/",
  requireAuth,
  [
    q("sector").optional().trim().isLength({ max: 100 }),
    q("sortBy").optional().isIn(Object.keys(SORT_COLUMNS)),
    q("order").optional().isIn(Object.keys(SORT_DIRECTIONS)),
  ],
  async (req, res, next) => {
    if (!validate(req, res)) return;

    const sortColumn = SORT_COLUMNS[req.query.sortBy] || "s.symbol";
    const sortDirection = SORT_DIRECTIONS[req.query.order] || "ASC";
    const { sector } = req.query;

    try {
      const result = await query(
        `WITH latest AS (
             SELECT DISTINCT ON (stock_id)
                    stock_id, trade_date, close, daily_return,
                    moving_avg_7d, moving_avg_30d, volatility_7d, volume_avg_7d
               FROM warehouse.stock_metrics
              ORDER BY stock_id, trade_date DESC
         )
         SELECT s.stock_id,
                s.symbol,
                s.company_name,
                s.sector,
                s.exchange,
                m.trade_date   AS latest_date,
                m.close,
                m.daily_return,
                m.moving_avg_7d,
                m.moving_avg_30d,
                m.volatility_7d,
                m.volume_avg_7d
           FROM warehouse.stocks s
           LEFT JOIN latest m ON m.stock_id = s.stock_id
          WHERE s.is_active = TRUE
            -- When no sector filter is supplied the condition is a no-op.
            AND ($1::text IS NULL OR s.sector = $1)
          ORDER BY ${sortColumn} ${sortDirection} NULLS LAST`,
        [sector || null]
      );

      return res.json({
        success: true,
        count: result.rowCount,
        data: result.rows,
      });
    } catch (err) {
      return next(err);
    }
  }
);

/**
 * GET /api/stocks/:symbol
 * Profile plus latest metrics for a single stock.
 */
router.get(
  "/:symbol",
  requireAuth,
  [param("symbol").trim().isLength({ min: 1, max: 20 })],
  async (req, res, next) => {
    if (!validate(req, res)) return;

    try {
      const result = await query(
        `SELECT s.stock_id, s.symbol, s.company_name, s.sector, s.exchange,
                m.trade_date AS latest_date, m.close, m.daily_return,
                m.moving_avg_7d, m.moving_avg_30d, m.volatility_7d, m.volume_avg_7d
           FROM warehouse.stocks s
           LEFT JOIN (
                SELECT DISTINCT ON (stock_id) *
                  FROM warehouse.stock_metrics
                 ORDER BY stock_id, trade_date DESC
           ) m ON m.stock_id = s.stock_id
          WHERE UPPER(s.symbol) = UPPER($1)`,
        [req.params.symbol]
      );

      if (result.rowCount === 0) {
        return res.status(404).json({ success: false, message: "Stock not found." });
      }

      return res.json({ success: true, data: result.rows[0] });
    } catch (err) {
      return next(err);
    }
  }
);

/**
 * GET /api/stocks/:symbol/history?days=90
 * Time series for the price chart: close, both moving averages and volatility.
 * The rows come back oldest-first so the chart can plot them directly.
 */
router.get(
  "/:symbol/history",
  requireAuth,
  [
    param("symbol").trim().isLength({ min: 1, max: 20 }),
    q("days").optional().isInt({ min: 1, max: 3650 }).toInt(),
  ],
  async (req, res, next) => {
    if (!validate(req, res)) return;

    const days = req.query.days || 90;

    try {
      const result = await query(
        `SELECT m.trade_date,
                m.close,
                m.daily_return,
                m.moving_avg_7d,
                m.moving_avg_30d,
                m.volatility_7d,
                m.volume_avg_7d
           FROM warehouse.stock_metrics m
           JOIN warehouse.stocks s ON s.stock_id = m.stock_id
          WHERE UPPER(s.symbol) = UPPER($1)
            AND m.trade_date >= CURRENT_DATE - ($2 || ' days')::INTERVAL
          ORDER BY m.trade_date ASC`,
        [req.params.symbol, days]
      );

      return res.json({
        success: true,
        symbol: req.params.symbol.toUpperCase(),
        days,
        count: result.rowCount,
        data: result.rows,
      });
    } catch (err) {
      return next(err);
    }
  }
);

/**
 * GET /api/stocks/movers/top?limit=5
 * Best and worst performers on the most recent trading day.
 */
router.get(
  "/movers/top",
  requireAuth,
  [q("limit").optional().isInt({ min: 1, max: 20 }).toInt()],
  async (req, res, next) => {
    if (!validate(req, res)) return;

    const limit = req.query.limit || 5;

    try {
      // The latest date is read from the data rather than assuming "today",
      // because markets are shut at weekends and on holidays.
      const latest = await query(
        "SELECT MAX(trade_date) AS latest_date FROM warehouse.stock_metrics"
      );
      const latestDate = latest.rows[0].latest_date;

      if (!latestDate) {
        return res.json({ success: true, latestDate: null, gainers: [], losers: [] });
      }

      const movers = await query(
        `SELECT s.symbol, s.company_name, s.sector, m.close, m.daily_return
           FROM warehouse.stock_metrics m
           JOIN warehouse.stocks s ON s.stock_id = m.stock_id
          WHERE m.trade_date = $1
            AND m.daily_return IS NOT NULL
          ORDER BY m.daily_return DESC`,
        [latestDate]
      );

      const rows = movers.rows;
      return res.json({
        success: true,
        latestDate,
        gainers: rows.slice(0, limit),
        losers: rows.slice(-limit).reverse(),
      });
    } catch (err) {
      return next(err);
    }
  }
);

/**
 * GET /api/stocks/sectors/summary
 * Average return and stock count per sector, for the dashboard bar chart.
 */
router.get("/sectors/summary", requireAuth, async (req, res, next) => {
  try {
    const result = await query(
      `WITH latest AS (
           SELECT DISTINCT ON (stock_id) stock_id, daily_return
             FROM warehouse.stock_metrics
            ORDER BY stock_id, trade_date DESC
       )
       SELECT COALESCE(s.sector, 'Unclassified') AS sector,
              COUNT(*)                            AS stock_count,
              ROUND(AVG(l.daily_return), 4)       AS avg_daily_return
         FROM warehouse.stocks s
         JOIN latest l ON l.stock_id = s.stock_id
        WHERE s.is_active = TRUE
        GROUP BY COALESCE(s.sector, 'Unclassified')
        ORDER BY avg_daily_return DESC NULLS LAST`
    );

    return res.json({ success: true, count: result.rowCount, data: result.rows });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
