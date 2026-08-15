/**
 * Entry point. Starts the HTTP listener and handles shutdown cleanly.
 *
 * Graceful shutdown matters here because the process holds a pool of open
 * PostgreSQL connections. Closing the server first (stop accepting requests),
 * then draining the pool, avoids killing queries mid-flight and leaving idle
 * connections on the database.
 */

const app = require("./app");
const { port, nodeEnv } = require("./config/env");
const { pool } = require("./config/db");

const server = app.listen(port, () => {
  console.log(`MarketPulse API listening on http://localhost:${port} [${nodeEnv}]`);
  console.log(`Health check: http://localhost:${port}/api/health`);
});

/** Close the HTTP server, then the database pool, then exit. */
function shutdown(signal) {
  console.log(`\n${signal} received. Shutting down.`);

  server.close(async () => {
    try {
      await pool.end();
      console.log("Database pool closed. Bye.");
      process.exit(0);
    } catch (err) {
      console.error("Error while closing the pool:", err.message);
      process.exit(1);
    }
  });

  // Do not hang forever if a request refuses to finish.
  setTimeout(() => {
    console.error("Shutdown timed out. Forcing exit.");
    process.exit(1);
  }, 10000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM")); // docker stop
process.on("SIGINT", () => shutdown("SIGINT")); // Ctrl+C

// A rejected promise nobody handled means the process is in an unknown state.
// Log it and restart rather than continuing on corrupt assumptions.
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection:", reason);
  shutdown("unhandledRejection");
});
