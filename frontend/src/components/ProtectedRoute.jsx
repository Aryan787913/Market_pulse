/**
 * Route guard.
 *
 * Three states have to be handled separately:
 *   loading         -> the app is still verifying a stored token; show a spinner
 *   not authenticated -> redirect to /login, remembering where the user wanted
 *                        to go so they land there after logging in
 *   authenticated   -> render the page
 *
 * This is a convenience check, not a security boundary. The real enforcement is
 * requireAuth on the server: hiding a link in the UI does not stop anyone from
 * calling the API directly, so both layers exist.
 */

import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "../context/AuthContext";

export default function ProtectedRoute({ children }) {
  const { isAuthenticated, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="center-screen">
        <div className="spinner" role="status" aria-label="Checking your session" />
      </div>
    );
  }

  if (!isAuthenticated) {
    // "state" carries the attempted URL so Login can send the user back.
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  return children;
}
