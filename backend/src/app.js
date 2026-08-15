/**
 * Express application assembly.
 *
 * The app is exported without calling listen() so that tests can mount it with
 * supertest without binding a real port. server.js does the listening.
 *
 * Middleware order matters and is deliberate:
 *   helmet   -> security headers first, so they apply to every response
 *   cors     -> reject disallowed origins before any work is done
 *   limiter  -> throttle abusive clients before touching the database
 *   parsers  -> make req.body available
 *   morgan   -> log the request
 *   routes   -> the actual endpoints
 *   notFound -> anything unmatched
 *   errors   -> must be last, Express only treats it as an error handler there
 */

const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");

const { corsOrigins, nodeEnv } = require("./config/env");
const { healthCheck } = require("./config/db");
const { notFound, errorHandler } = require("./middleware/errorHandler");

const authRoutes = require("./routes/auth");
const stockRoutes = require("./routes/stocks");
const watchlistRoutes = require("./routes/watchlist");
const pipelineRoutes = require("./routes/pipeline");

const app = express();

// Sets X-Frame-Options, X-Content-Type-Options, HSTS and friends.
app.use(helmet());

// Browsers may only call this API from the configured origins.
app.use(
  cors({
    origin(origin, callback) {
      // No origin header means a non-browser client (curl, Postman, tests).
      if (!origin || corsOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error(`Origin not allowed by CORS: ${origin}`));
    },
    credentials: true,
  })
);

// Blanket limit: 200 requests per IP per 15 minutes across the whole API.
// Login has its own stricter limiter in routes/auth.js.
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

// 10kb is plenty for these JSON payloads and caps oversized-body attacks.
app.use(express.json({ limit: "10kb" }));
app.use(express.urlencoded({ extended: true, limit: "10kb" }));

app.use(morgan(nodeEnv === "production" ? "combined" : "dev"));

/**
 * GET /api/health
 * Deliberately unauthenticated so it can be used as a container/uptime probe.
 * It returns only liveness information, no data from the warehouse.
 */
app.get("/api/health", async (req, res) => {
  try {
    const dbTime = await healthCheck();
    res.json({
      success: true,
      status: "ok",
      database: "connected",
      dbTime,
      uptimeSeconds: Math.round(process.uptime()),
    });
  } catch (err) {
    res.status(503).json({
      success: false,
      status: "degraded",
      database: "unreachable",
      message: err.message,
    });
  }
});

app.use("/api/auth", authRoutes);
app.use("/api/stocks", stockRoutes);
app.use("/api/watchlist", watchlistRoutes);
app.use("/api/pipeline", pipelineRoutes);

app.use(notFound);
app.use(errorHandler);

module.exports = app;
