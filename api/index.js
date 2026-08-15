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
 * vercel.json rewrites every /api/* path to this single function. Express then
 * does its own routing internally, so /api/stocks, /api/auth/login and the rest
 * keep the paths they already had and the frontend needs no changes.
 */

const app = require("../backend/src/app");

module.exports = app;
