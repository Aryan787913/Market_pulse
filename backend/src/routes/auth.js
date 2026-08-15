/**
 * Authentication routes: register, login, Google sign-in, and "who am I".
 *
 * Security decisions:
 *   * Passwords are hashed with bcrypt (12 rounds) and only the hash is stored.
 *     The plain password never reaches the database or the logs.
 *   * Login always returns the same generic message for a wrong email and a
 *     wrong password, so the endpoint cannot be used to discover which emails
 *     are registered.
 *   * Login is rate limited to slow down credential-stuffing attempts.
 *   * All input is validated by express-validator before it is used.
 *   * Google sign-in trusts nothing the browser says about who the user is. The
 *     browser sends an ID token; the server verifies its signature against
 *     Google's public keys and checks that it was issued for this application
 *     before reading the email out of it. Sending a name and email directly
 *     would let anyone log in as anyone.
 */

const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const { body, validationResult } = require("express-validator");
const { OAuth2Client } = require("google-auth-library");

const { query } = require("../config/db");
const {
  jwtSecret,
  jwtExpiresIn,
  bcryptRounds,
  googleClientId,
} = require("../config/env");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

// Created once and reused. Verification fetches Google's signing keys over the
// network, and the client caches them, so a single instance avoids re-fetching
// on every sign-in. Null when the feature is not configured.
const googleClient = googleClientId ? new OAuth2Client(googleClientId) : null;

// Ten login attempts per IP per 15 minutes.

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many login attempts. Please try again in 15 minutes.",
  },
});

/** Returns 400 with the collected messages if validation failed. */
function checkValidation(req, res) {
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

function signToken(user) {
  return jwt.sign(
    { userId: user.user_id, email: user.email, role: user.role },
    jwtSecret,
    { expiresIn: jwtExpiresIn }
  );
}

/**
 * POST /api/auth/register
 * Creates a user account and returns a token so the client is logged in
 * immediately after signing up.
 */
router.post(
  "/register",
  [
    body("name").trim().isLength({ min: 2, max: 100 }).withMessage("Name must be 2-100 characters."),
    body("email").trim().isEmail().withMessage("A valid email is required.").normalizeEmail(),
    body("password")
      .isLength({ min: 8 })
      .withMessage("Password must be at least 8 characters.")
      .matches(/[0-9]/)
      .withMessage("Password must contain a number.")
      .matches(/[a-zA-Z]/)
      .withMessage("Password must contain a letter."),
  ],
  async (req, res, next) => {
    if (!checkValidation(req, res)) return;

    const { name, email, password } = req.body;

    try {
      const existing = await query(
        "SELECT user_id FROM warehouse.users WHERE email = $1",
        [email]
      );
      if (existing.rowCount > 0) {
        return res.status(409).json({
          success: false,
          message: "An account with that email already exists.",
        });
      }

      const passwordHash = await bcrypt.hash(password, bcryptRounds);

      const inserted = await query(
        `INSERT INTO warehouse.users (name, email, password_hash, role)
         VALUES ($1, $2, $3, 'user')
         RETURNING user_id, name, email, role, created_at`,
        [name, email, passwordHash]
      );

      const user = inserted.rows[0];
      return res.status(201).json({
        success: true,
        message: "Account created.",
        token: signToken(user),
        user: {
          userId: user.user_id,
          name: user.name,
          email: user.email,
          role: user.role,
        },
      });
    } catch (err) {
      return next(err);
    }
  }
);

/**
 * POST /api/auth/login
 * Verifies credentials and returns a signed JWT.
 */
router.post(
  "/login",
  loginLimiter,
  [
    body("email").trim().isEmail().withMessage("A valid email is required.").normalizeEmail(),
    body("password").notEmpty().withMessage("Password is required."),
  ],
  async (req, res, next) => {
    if (!checkValidation(req, res)) return;

    const { email, password } = req.body;
    const genericError = {
      success: false,
      message: "Invalid email or password.",
    };

    try {
      const result = await query(
        `SELECT user_id, name, email, password_hash, role
           FROM warehouse.users
          WHERE email = $1`,
        [email]
      );

      if (result.rowCount === 0) {
        // Same response as a bad password: no account enumeration.
        return res.status(401).json(genericError);
      }

      const user = result.rows[0];

      // A Google-only account has no password hash. bcrypt.compare would throw
      // on a null hash, so the case is handled explicitly - and answered with
      // the same generic error, which also avoids revealing how the account was
      // created.
      if (!user.password_hash) {
        return res.status(401).json(genericError);
      }

      const passwordMatches = await bcrypt.compare(password, user.password_hash);

      if (!passwordMatches) {
        return res.status(401).json(genericError);
      }


      return res.json({
        success: true,
        message: "Logged in.",
        token: signToken(user),
        user: {
          userId: user.user_id,
          name: user.name,
          email: user.email,
          role: user.role,
        },
      });
    } catch (err) {
      return next(err);
    }
  }
);

/**
 * POST /api/auth/google
 *
 * Signs a user in from a Google ID token issued to this application. The token
 * is the only thing the client sends: the identity inside it is established by
 * Google's signature, not by the request body.
 *
 * The endpoint deliberately serves both "sign up" and "sign in". Google has
 * already confirmed the email belongs to the person, so there is nothing extra
 * to ask on a first visit, and a separate registration step would only be an
 * obstacle. Three cases are handled:
 *
 *   1. No account with that email -> create one with auth_provider 'google' and
 *      no password hash. Such an account can only ever be entered through
 *      Google, which is why the password column had to become nullable.
 *   2. An existing Google account -> log in.
 *   3. An existing password account with the same email -> log in and record the
 *      google_sub, linking the two. The alternative, rejecting the sign-in, would
 *      lock a user out of their own account for choosing a different button. The
 *      link is safe because Google has verified the address and this system
 *      already treats a verified email as proof of ownership.
 *
 * Only emails Google reports as verified are accepted. An unverified address
 * proves nothing about ownership, so accepting one would allow an attacker to
 * claim someone else's account by signing up to Google with their address.
 */
router.post(
  "/google",
  loginLimiter,
  [body("credential").isString().notEmpty().withMessage("A Google credential is required.")],
  async (req, res, next) => {
    if (!checkValidation(req, res)) return;

    if (!googleClient) {
      return res.status(503).json({
        success: false,
        message:
          "Google sign-in is not configured on this server. Set GOOGLE_CLIENT_ID.",
      });
    }

    try {
      let payload;
      try {
        // Checks the signature, the expiry, the issuer, and that the audience is
        // this application's client ID. A token minted for a different site
        // therefore cannot be replayed here.
        const ticket = await googleClient.verifyIdToken({
          idToken: req.body.credential,
          audience: googleClientId,
        });
        payload = ticket.getPayload();
      } catch {
        // The reason is not echoed back: to a caller a bad token is simply
        // rejected, and the detail would only help someone probing the endpoint.
        return res.status(401).json({
          success: false,
          message: "That Google sign-in could not be verified. Please try again.",
        });
      }

      if (!payload?.email || !payload.email_verified) {
        return res.status(401).json({
          success: false,
          message: "Your Google account does not have a verified email address.",
        });
      }

      const email = payload.email.toLowerCase();
      const googleSub = payload.sub;
      // Google omits the name when the user has hidden it; the email's local
      // part is a reasonable stand-in and the column is NOT NULL.
      const name = payload.name?.trim() || email.split("@")[0];

      const existing = await query(
        `SELECT user_id, name, email, role, auth_provider, google_sub
           FROM warehouse.users
          WHERE email = $1`,
        [email]
      );

      if (existing.rowCount === 0) {
        const inserted = await query(
          `INSERT INTO warehouse.users (name, email, role, auth_provider, google_sub)
           VALUES ($1, $2, 'user', 'google', $3)
           RETURNING user_id, name, email, role`,
          [name, email, googleSub]
        );
        const created = inserted.rows[0];
        return res.status(201).json({
          success: true,
          message: "Account created with Google.",
          token: signToken(created),
          user: {
            userId: created.user_id,
            name: created.name,
            email: created.email,
            role: created.role,
          },
        });
      }

      const user = existing.rows[0];

      // First Google sign-in on an account that was registered with a password:
      // remember the subject so later sign-ins match on it directly.
      if (!user.google_sub) {
        await query(
          "UPDATE warehouse.users SET google_sub = $1 WHERE user_id = $2",
          [googleSub, user.user_id]
        );
      }

      return res.json({
        success: true,
        message: "Logged in with Google.",
        token: signToken(user),
        user: {
          userId: user.user_id,
          name: user.name,
          email: user.email,
          role: user.role,
        },
      });
    } catch (err) {
      return next(err);
    }
  }
);

/**
 * GET /api/auth/config
 *
 * Tells the frontend whether to show the Google button, and with which client
 * ID. A client ID is public by design - it appears in the sign-in URL - so
 * serving it is not a disclosure. Fetching it at runtime rather than baking it
 * into the bundle at build time means the deployed frontend does not have to be
 * rebuilt when the value is set or rotated.
 */
router.get("/config", (req, res) => {
  res.json({
    success: true,
    googleClientId,
    googleEnabled: Boolean(googleClientId),
  });
});

/**
 * GET /api/auth/me

 * Returns the current user. The frontend calls this on page load to decide
 * whether a stored token is still valid.
 */
router.get("/me", requireAuth, async (req, res, next) => {
  try {
    const result = await query(
      `SELECT user_id, name, email, role, created_at
         FROM warehouse.users
        WHERE user_id = $1`,
      [req.user.userId]
    );

    if (result.rowCount === 0) {
      // Token is valid but the account was deleted.
      return res.status(404).json({ success: false, message: "User no longer exists." });
    }

    const user = result.rows[0];
    return res.json({
      success: true,
      user: {
        userId: user.user_id,
        name: user.name,
        email: user.email,
        role: user.role,
        createdAt: user.created_at,
      },
    });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
