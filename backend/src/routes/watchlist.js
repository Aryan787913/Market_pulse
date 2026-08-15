/**
 * Watchlist routes. Each user keeps a personal list of stocks to follow.
 *
 * Ownership rule: the user id always comes from the verified JWT
 * (req.user.userId), never from the request body or URL. This is what stops one
 * logged-in user from reading or editing another user's watchlist by changing an
 * id in the request.
 */

const express = require("express");
const { body, param, validationResult } = require("express-validator");

const { query } = require("../config/db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

// Every route below needs a logged-in user.
router.use(requireAuth);

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
 * GET /api/watchlist
 * The current user's stocks, each with its latest metrics so the page can be
 * rendered from a single request.
 */
router.get("/", async (req, res, next) => {
  try {
    const result = await query(
      `WITH latest AS (
           SELECT DISTINCT ON (stock_id)
                  stock_id, trade_date, close, daily_return,
                  moving_avg_7d, moving_avg_30d, volatility_7d
             FROM warehouse.stock_metrics
            ORDER BY stock_id, trade_date DESC
       )
       SELECT w.watchlist_id,
              w.added_on,
              s.stock_id,
              s.symbol,
              s.company_name,
              s.sector,
              m.trade_date AS latest_date,
              m.close,
              m.daily_return,
              m.moving_avg_7d,
              m.moving_avg_30d,
              m.volatility_7d
         FROM warehouse.watchlist w
         JOIN warehouse.stocks s ON s.stock_id = w.stock_id
         LEFT JOIN latest m      ON m.stock_id = s.stock_id
        WHERE w.user_id = $1
        ORDER BY w.added_on DESC`,
      [req.user.userId]
    );

    return res.json({ success: true, count: result.rowCount, data: result.rows });
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /api/watchlist   body: { symbol: "TCS.NS" }
 * Adds a stock. Adding the same stock twice is treated as success rather than
 * an error, which keeps the UI simple (the end state is what the user wanted).
 */
router.post(
  "/",
  [body("symbol").trim().notEmpty().withMessage("symbol is required.").isLength({ max: 20 })],
  async (req, res, next) => {
    if (!validate(req, res)) return;

    try {
      const stock = await query(
        "SELECT stock_id, symbol FROM warehouse.stocks WHERE UPPER(symbol) = UPPER($1)",
        [req.body.symbol]
      );

      if (stock.rowCount === 0) {
        return res.status(404).json({
          success: false,
          message: `Unknown symbol: ${req.body.symbol}`,
        });
      }

      // ON CONFLICT relies on the uq_watchlist_user_stock constraint.
      const inserted = await query(
        `INSERT INTO warehouse.watchlist (user_id, stock_id)
         VALUES ($1, $2)
         ON CONFLICT (user_id, stock_id) DO NOTHING
         RETURNING watchlist_id, added_on`,
        [req.user.userId, stock.rows[0].stock_id]
      );

      const alreadyPresent = inserted.rowCount === 0;
      return res.status(alreadyPresent ? 200 : 201).json({
        success: true,
        message: alreadyPresent
          ? "Stock is already on your watchlist."
          : "Stock added to your watchlist.",
        data: {
          symbol: stock.rows[0].symbol,
          ...(inserted.rows[0] || {}),
        },
      });
    } catch (err) {
      return next(err);
    }
  }
);

/**
 * DELETE /api/watchlist/:symbol
 * Removes a stock. The user_id in the WHERE clause is the ownership check: a
 * request for someone else's row simply deletes nothing and returns 404.
 */
router.delete(
  "/:symbol",
  [param("symbol").trim().isLength({ min: 1, max: 20 })],
  async (req, res, next) => {
    if (!validate(req, res)) return;

    try {
      const result = await query(
        `DELETE FROM warehouse.watchlist w
          USING warehouse.stocks s
          WHERE w.stock_id = s.stock_id
            AND w.user_id = $1
            AND UPPER(s.symbol) = UPPER($2)
        RETURNING w.watchlist_id`,
        [req.user.userId, req.params.symbol]
      );

      if (result.rowCount === 0) {
        return res.status(404).json({
          success: false,
          message: "That stock is not on your watchlist.",
        });
      }

      return res.json({ success: true, message: "Removed from your watchlist." });
    } catch (err) {
      return next(err);
    }
  }
);

module.exports = router;
