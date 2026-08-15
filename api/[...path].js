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
 * means it can be used unchanged as a request handler here. Vercel invokes the
 * exported function with the standard Node request and response objects, which
 * is exactly what Express expects, so the same routes, middleware, validation
 * and error handling serve both deployments.
 *
 * Why the file is named [...path].js rather than index.js:
 *
 * Express does its own internal routing, so it needs to see the real request
 * path - /api/stocks, /api/auth/login - not a rewritten one. The earlier version
 * of this deployment used a vercel.json rewrite from /api/(.*) to /api/index,
 * which worked only because the function still received the original path.
 * Vercel now routes internal rewrites using the *destination* path, so Express
 * would be handed /api/index, match none of its routes, and answer 404 to every
 * API call.
 *
 * A catch-all filesystem route avoids the problem instead of working around it.
 * The [...path] segment makes Vercel send every /api/<anything> request straight
 * to this function with the URL untouched, so no rewrite is involved and Express
 * routes on the path the browser actually asked for.
 */

const app = require("../backend/src/app");

module.exports = app;
