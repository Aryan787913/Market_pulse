/**
 * Vercel serverless entry point for the MarketPulse API.
 *
 * Locally the API runs as a long-lived process: backend/src/server.js calls
 * app.listen() and keeps a connection pool open until the process is stopped.
 * That model does not exist on Vercel. There, each incoming request is handed
 * to a function instance that may be created on demand and frozen or discarded
 * immediately afterwards, so nothing may bind a port or assume it will still be
 * alive on the next request.
 *
 * The Express application in backend/src/app.js was already written without a
 * listen() call - it exports the configured app so tests can mount it - which
 * means it can serve as the request handler here: Vercel invokes this function
 * with the standard Node request and response objects, which is what Express
 * expects, so the same routes, middleware, validation and error handling serve
 * both deployments.
 *
 * Why the path is reconstructed from a query parameter:
 *
 * Express routes on req.url, so it must see the path the browser actually asked
 * for - /api/auth/login, not something Vercel rewrote. Two obvious approaches
 * both fail. A catch-all filesystem route (api/[...path].js) was deployed as a
 * single-segment dynamic route, so /api/stocks reached Express but the deeper
 * /api/auth/login matched no function and returned Vercel's own NOT_FOUND. A
 * plain rewrite of /api/(.*) to /api/index fails differently: Vercel routes
 * internal rewrites using the destination path, so Express would be handed
 * /api/index, match none of its routers, and 404 every call itself.
 *
 * So vercel.json rewrites /api/(.*) to /api/index?__path=$1, which pins routing
 * to one statically named function while preserving the original path as data.
 * This wrapper moves that value back into req.url and strips the parameter, so
 * Express - and every route, validator and rate limiter inside it - sees the
 * real request and never learns the rewrite happened. Any genuine query string
 * on the request is merged in by Vercel and carried through unchanged.
 */

const app = require("../backend/src/app");

// Only used to parse and re-serialise; the host is irrelevant and never sent.
const PARSE_BASE = "http://localhost";

module.exports = (req, res) => {
  const parsed = new URL(req.url, PARSE_BASE);
  const originalPath = parsed.searchParams.get("__path");

  if (originalPath !== null) {
    parsed.searchParams.delete("__path");
    const queryString = parsed.searchParams.toString();
    req.url = `/api/${originalPath}${queryString ? `?${queryString}` : ""}`;
  }

  return app(req, res);
};
