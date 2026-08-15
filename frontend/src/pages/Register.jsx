/**
 * Registration page.
 *
 * The password rule (8+ characters, at least one letter and one digit) is
 * checked here for instant feedback, and again on the server in routes/auth.js.
 * The client check is only a convenience; the server check is the one that
 * actually protects the database, since anyone can bypass the browser.
 */

import { useState } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";

import { useAuth } from "../context/AuthContext";

/** Mirrors the server-side rule so the two never disagree. */
function passwordProblem(password) {
  if (password.length < 8) return "Password must be at least 8 characters.";
  if (!/[A-Za-z]/.test(password)) return "Password must contain a letter.";
  if (!/\d/.test(password)) return "Password must contain a number.";
  return null;
}

export default function Register() {
  const { register, isAuthenticated } = useAuth();
  const navigate = useNavigate();

  const [form, setForm] = useState({ name: "", email: "", password: "", confirm: "" });
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  if (isAuthenticated) {
    return <Navigate to="/" replace />;
  }

  function handleChange(event) {
    const { name, value } = event.target;
    setForm((previous) => ({ ...previous, [name]: value }));
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setError("");

    const problem = passwordProblem(form.password);
    if (problem) {
      setError(problem);
      return;
    }
    if (form.password !== form.confirm) {
      setError("The two passwords do not match.");
      return;
    }

    setSubmitting(true);
    try {
      await register(form.name.trim(), form.email.trim(), form.password);
      navigate("/", { replace: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="auth-screen">
      <form className="auth-card" onSubmit={handleSubmit}>
        <h1 className="auth-title">Create your account</h1>
        <p className="auth-subtitle">Track stocks and build a watchlist</p>

        {error && (
          <div className="alert alert-error" role="alert">
            {error}
          </div>
        )}

        <label className="field">
          <span className="field-label">Name</span>
          <input
            className="field-input"
            name="name"
            value={form.name}
            onChange={handleChange}
            autoComplete="name"
            required
          />
        </label>

        <label className="field">
          <span className="field-label">Email</span>
          <input
            className="field-input"
            type="email"
            name="email"
            value={form.email}
            onChange={handleChange}
            autoComplete="email"
            required
          />
        </label>

        <label className="field">
          <span className="field-label">Password</span>
          <input
            className="field-input"
            type="password"
            name="password"
            value={form.password}
            onChange={handleChange}
            autoComplete="new-password"
            required
          />
          <span className="field-hint">At least 8 characters, with a letter and a number.</span>
        </label>

        <label className="field">
          <span className="field-label">Confirm password</span>
          <input
            className="field-input"
            type="password"
            name="confirm"
            value={form.confirm}
            onChange={handleChange}
            autoComplete="new-password"
            required
          />
        </label>

        <button type="submit" className="btn btn-primary btn-block" disabled={submitting}>
          {submitting ? "Creating account…" : "Create account"}
        </button>

        <p className="auth-footer">
          Already registered? <Link to="/login">Sign in</Link>
        </p>
      </form>
    </div>
  );
}
