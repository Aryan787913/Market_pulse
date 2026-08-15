/**
 * Centralised error handling.
 *
 * Two exports:
 *   notFound      catches requests that matched no route (404)
 *   errorHandler  Express's four-argument error middleware, registered last
 *
 * Internal details such as SQL text or stack traces are only returned in
 * development. In production the client gets a generic message, because a
 * leaked query or file path is useful information for an attacker.
 */

/** 404 handler. Registered after all routes. */
function notFound(req, res) {
  res.status(404).json({
    success: false,
    message: `Route not found: ${req.method} ${req.originalUrl}`,
  });
}

/** Final error handler. Express identifies it by the four-parameter signature. */
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const isProduction = process.env.NODE_ENV === "production";

  // Map known Postgres error codes onto sensible HTTP statuses.
  let status = err.status || 500;
  let message = err.message || "Internal server error";

  switch (err.code) {
    case "23505": // unique_violation (safety net; real code is 23505 in PG)
    case "23514": // check_violation
      status = 400;
      break;
    case "23503": // foreign_key_violation
      status = 400;
      message = "Referenced record does not exist.";
      break;
    case "23502": // not_null_violation
      status = 400;
      message = "A required field was missing.";
      break;
    case "ECONNREFUSED":
      status = 503;
      message = "Database unavailable. Please try again shortly.";
      break;
    default:
      break;
  }

  console.error(`[error] ${req.method} ${req.originalUrl} -> ${status}:`, err.message);

  res.status(status).json({
    success: false,
    message: isProduction && status === 500 ? "Internal server error" : message,
    ...(isProduction ? {} : { stack: err.stack }),
  });
}

module.exports = { notFound, errorHandler };
