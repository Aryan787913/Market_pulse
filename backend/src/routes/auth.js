/**
 * Authentication routes: register, login, and "who am I".
 *
 * Security decisions:
 *   * Passwords are hashed with bcrypt (12 rounds) and only the hash is stored.
 *     The plain password never reaches the database or the logs.
 *   * Login always returns the same generic message for a wrong email and a
 *     wrong password, so the endpoint cannot be used to discover which emails
 *     are registered.
 *   * Login is rate limited to slow down credential-stuffing attempts.
 *   * All input is validated by express-validator before it is used.
 */

const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const { body, validationResult } = require("express-validator");

const { query } = require("../config/db");
const { jwtSecret, jwtExpiresIn, bcryptRounds } = require("../config/env");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

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
