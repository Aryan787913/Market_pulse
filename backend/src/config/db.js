/**
 * PostgreSQL connection access.
 *
 * This module has to work in two very different runtimes:
 *
 *   1. Locally / on a normal server, where one long-lived Node process handles
 *      many concurrent requests. A pool of connections is ideal: each request
 *      borrows a connection and returns it, avoiding a TCP handshake per query.
 *
 *   2. On Vercel, where each request may run in a separate short-lived
 *      serverless function instance. A large pool is actively harmful there:
 *      dozens of concurrent instances each opening ten connections would
 *      exhaust the database's connection limit. Two things prevent that:
 *        - the pool is capped at a single connection when running serverless;
 *        - the pool is cached on globalThis so that a warm instance reuses it
 *          instead of building a new one on every invocation.
 *
 * Connection details come from DATABASE_URL when present (this is how Neon and
 * most hosted providers hand out credentials) and fall back to the individual
 * DB_* variables for local development.
 *
 * Every query in this project goes through query() below with parameter
 * placeholders ($1, $2 ...). Values are never concatenated into SQL strings,
 * which is what prevents SQL injection.
 */

const { Pool } = require("pg");

// Vercel sets this on every deployment; it is the signal that we are serverless.
const isServerless = Boolean(process.env.VERCEL);

/** Build the pg configuration from whichever style of credentials is present. */
function buildPoolConfig() {
  const shared = {
    // One connection per instance when serverless, a real pool otherwise.
    max: isServerless ? 1 : 10,
    // Serverless instances are frozen between requests, so a long idle timeout
    // just holds a connection open on the database for nothing.
    idleTimeoutMillis: isServerless ? 10000 : 30000,
    connectionTimeoutMillis: 10000,
  };

  if (process.env.DATABASE_URL) {
    return {
      ...shared,
      connectionString: process.env.DATABASE_URL,
      // Hosted Postgres requires TLS. rejectUnauthorized is false because
      // providers such as Neon terminate TLS with a certificate chain that is
      // not in Node's default trust store; the connection is still encrypted.
      ssl: { rejectUnauthorized: false },
    };
  }

  return {
    ...shared,
    host: process.env.DB_HOST || "localhost",
    port: parseInt(process.env.DB_PORT || "5432", 10),
    database: process.env.DB_NAME || "marketpulse",
    user: process.env.DB_USER || "postgres",
    password: process.env.DB_PASSWORD,
  };
}

/**
 * Return the shared pool, creating it on first use.
 *
 * The instance is stashed on globalThis rather than in a module-level constant
 * because a serverless bundle may be re-evaluated while the underlying instance
 * stays warm; globalThis survives that and the module scope does not always.
 */
function getPool() {
  if (!globalThis.__marketpulsePool) {
    const pool = new Pool(buildPoolConfig());

    // A pool-level error means an idle client dropped. Log it rather than
    // letting the unhandled event crash the process.
    pool.on("error", (err) => {
      console.error("Unexpected PostgreSQL pool error:", err.message);
    });

    globalThis.__marketpulsePool = pool;
  }

  return globalThis.__marketpulsePool;
}

/**
 * Run a parameterised query.
 * @param {string} text SQL with $1-style placeholders
 * @param {Array} params values bound to the placeholders
 */
async function query(text, params = []) {
  const start = Date.now();
  const result = await getPool().query(text, params);

  if (process.env.NODE_ENV !== "production") {
    console.log(
      `[db] ${Date.now() - start}ms, ${result.rowCount} rows :: ${text
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 90)}`
    );
  }

  return result;
}

/** Simple connectivity probe used by the /api/health endpoint. */
async function healthCheck() {
  const result = await query("SELECT NOW() AS server_time");
  return result.rows[0].server_time;
}

module.exports = {
  // Exposed as a getter so nothing creates a pool merely by importing this file,
  // which keeps serverless cold starts cheap for requests that never hit the DB.
  get pool() {
    return getPool();
  },
  query,
  healthCheck,
  isServerless,
};
