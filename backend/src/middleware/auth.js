/**
 * JWT authentication middleware.
 *
 * How the scheme works:
 *   1. /api/auth/login verifies the password and signs a token containing the
 *      user id, email and role.
 *   2. The client sends that token on later requests as
 *      "Authorization: Bearer <token>".
 *   3. This middleware verifies the signature and expiry, then attaches the
 *      decoded payload to req.user for the route handlers.
 *
 * The token is signed, not encrypted, so it is never used to carry secrets.
 * Any state that matters (such as the role) is re-checked against the database
 * when the action is sensitive.
 */

const jwt = require("jsonwebtoken");
const { jwtSecret } = require("../config/env");

/** Rejects the request unless it carries a valid, unexpired token. */
function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";

  if (!header.startsWith("Bearer ")) {
    return res.status(401).json({
      success: false,
      message: "Authentication required. Send an Authorization: Bearer header.",
    });
  }

  const token = header.slice(7).trim();

  try {
    const payload = jwt.verify(token, jwtSecret);
    req.user = {
      userId: payload.userId,
      email: payload.email,
      role: payload.role,
    };
    return next();
  } catch (err) {
    // Distinguish expiry from tampering so the client knows to re-login.
    const expired = err.name === "TokenExpiredError";
    return res.status(401).json({
      success: false,
      message: expired ? "Session expired. Please log in again." : "Invalid token.",
    });
  }
}

/**
 * Restricts a route to specific roles. Must run after requireAuth.
 * Usage: router.delete("/stocks/:id", requireAuth, requireRole("admin"), handler)
 */
function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ success: false, message: "Authentication required." });
    }
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: "You do not have permission to perform this action.",
      });
    }
    return next();
  };
}

module.exports = { requireAuth, requireRole };
