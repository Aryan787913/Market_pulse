/**
 * Loads and validates environment configuration once, at start-up.
 *
 * Validation is strict because a missing JWT_SECRET would otherwise let the
 * server sign tokens with the string "undefined", which is a silent auth bypass.
 *
 * How a failure is reported depends on the runtime:
 *
 *   - Locally, calling process.exit(1) is the right move: the developer sees the
 *     message immediately and fixes their .env before anything else happens.
 *
 *   - On Vercel, process.exit(1) inside a serverless function kills the
 *     invocation with an opaque platform error and no useful log, so a
 *     misconfigured environment variable looks like a broken deployment. There
 *     we throw instead, which surfaces the real message in the function log and
 *     as a 500 response.
 *
 * Either way the server never runs with an invalid secret.
 */

const path = require("path");
const dotenv = require("dotenv");

// Locally the .env lives at the project root, one level above backend/.
// On Vercel there is no .env file at all - variables are injected into the
// environment directly - and dotenv simply finds nothing, which is fine.
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

const isServerless = Boolean(process.env.VERCEL);

/** Report a fatal configuration problem in whichever way suits the runtime. */
function fail(message) {
  if (isServerless) {
    throw new Error(`MarketPulse configuration error: ${message}`);
  }
  console.error(message);
  process.exit(1);
}

// A hosted database hands out one DATABASE_URL instead of separate parts, so
// either form of database credential is acceptable.
if (!process.env.DATABASE_URL && !process.env.DB_PASSWORD) {
  fail(
    "No database credentials found. Set DATABASE_URL (hosted Postgres such as " +
      "Neon) or DB_PASSWORD (local Postgres). Copy .env.example to .env and " +
      "fill in the values."
  );
}

if (!process.env.JWT_SECRET) {
  fail(
    "Missing required environment variable: JWT_SECRET\n" +
      "Generate one with: node -e \"console.log(require('crypto').randomBytes(48).toString('hex'))\""
  );
}

if (process.env.JWT_SECRET && process.env.JWT_SECRET.length < 32) {
  fail(
    "JWT_SECRET is too short. Use at least 32 characters so the signature " +
      "cannot be brute-forced."
  );
}

module.exports = {
  port: parseInt(process.env.PORT || "5000", 10),
  nodeEnv: process.env.NODE_ENV || "development",
  isServerless,
  jwtSecret: process.env.JWT_SECRET,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || "24h",
  // Only these origins may call the API from a browser.
  //
  // On Vercel the frontend and the API are served from the same domain, so
  // browser requests are same-origin and carry no Origin header that CORS needs
  // to approve. The deployment URL is still listed here so that preview
  // deployments and a separately hosted frontend keep working.
  corsOrigins: (process.env.CORS_ORIGIN || "http://localhost:5173")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
    .concat(
      process.env.VERCEL_URL ? [`https://${process.env.VERCEL_URL}`] : []
    ),
  bcryptRounds: 12,
};
