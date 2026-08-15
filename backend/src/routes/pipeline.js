/**
 * Pipeline observability routes.
 *
 * These expose what the Airflow DAG recorded in raw.ingestion_log and
 * raw.data_quality_log, which is what makes the "Data Quality" page of the
 * dashboard possible. Being able to show the last run's status and failed
 * checks in the UI is a large part of what separates this project from a
 * plain CRUD app.
 */

const express = require("express");
const { query: q, validationResult } = require("express-validator");

const { query } = require("../config/db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth);

/**
 * GET /api/pipeline/runs?limit=10
 * Recent ingestion runs, newest first.
 */
router.get(
  "/runs",
  [q("limit").optional().isInt({ min: 1, max: 100 }).toInt()],
  async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: "Invalid limit." });
    }

    try {
      const result = await query(
        `SELECT log_id, batch_id, run_started_at, run_ended_at,
                symbols_total, symbols_ok, symbols_failed,
                rows_inserted, status, message,
                -- Duration in seconds, useful for spotting a slowing pipeline.
                EXTRACT(EPOCH FROM (run_ended_at - run_started_at))::INT AS duration_seconds
           FROM raw.ingestion_log
          ORDER BY run_started_at DESC
          LIMIT $1`,
        [req.query.limit || 10]
      );

      return res.json({ success: true, count: result.rowCount, data: result.rows });
    } catch (err) {
      return next(err);
    }
  }
);

/**
 * GET /api/pipeline/quality?limit=50
 * Quality-check results from the most recent batch, plus a pass/fail tally.
 */
router.get(
  "/quality",
  [q("limit").optional().isInt({ min: 1, max: 200 }).toInt()],
  async (req, res, next) => {
    try {
      const result = await query(
        `WITH last_batch AS (
             SELECT batch_id
               FROM raw.data_quality_log
              WHERE batch_id IS NOT NULL
              ORDER BY checked_at DESC
              LIMIT 1
         )
         SELECT check_id, batch_id, check_name, check_target,
                failed_records, severity, passed, details, checked_at
           FROM raw.data_quality_log
          WHERE batch_id = (SELECT batch_id FROM last_batch)
          ORDER BY passed ASC, severity ASC, check_name ASC
          LIMIT $1`,
        [req.query.limit || 50]
      );

      const rows = result.rows;
      return res.json({
        success: true,
        summary: {
          total: rows.length,
          passed: rows.filter((r) => r.passed).length,
          failed: rows.filter((r) => !r.passed).length,
          batchId: rows.length > 0 ? rows[0].batch_id : null,
        },
        data: rows,
      });
    } catch (err) {
      return next(err);
    }
  }
);

/**
 * GET /api/pipeline/freshness
 * How current the warehouse is. The dashboard shows this as a banner so a stale
 * pipeline is obvious instead of silently serving old numbers.
 */
router.get("/freshness", async (req, res, next) => {
  try {
    const result = await query(
      `SELECT MAX(trade_date)                            AS latest_trade_date,
              CURRENT_DATE - MAX(trade_date)             AS days_behind,
              COUNT(DISTINCT stock_id)                   AS stocks_covered,
              COUNT(*)                                   AS total_price_rows
         FROM warehouse.daily_prices`
    );

    const row = result.rows[0];
    return res.json({
      success: true,
      data: {
        ...row,
        // Weekends make a 1-3 day gap normal, so only flag beyond that.
        isStale: row.days_behind === null || Number(row.days_behind) > 3,
      },
    });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
