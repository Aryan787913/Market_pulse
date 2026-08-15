/**
 * Route table.
 *
 * /login and /register are public. Everything else sits inside
 * <ProtectedRoute>, which redirects to /login when there is no valid session.
 * Doing the check in one place means no page has to remember to guard itself.
 */

import { Navigate, Route, Routes } from "react-router-dom";

import Navbar from "./components/Navbar";
import ProtectedRoute from "./components/ProtectedRoute";
import DataQuality from "./pages/DataQuality";
import Dashboard from "./pages/Dashboard";
import Login from "./pages/Login";
import Register from "./pages/Register";
import StockDetail from "./pages/StockDetail";
import Watchlist from "./pages/Watchlist";
import { useAuth } from "./context/AuthContext";

export default function App() {
  const { isAuthenticated } = useAuth();

  return (
    <>
      {/* The navbar is only useful once logged in. */}
      {isAuthenticated && <Navbar />}

      <main className="app-main">
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />

          <Route
            path="/"
            element={
              <ProtectedRoute>
                <Dashboard />
              </ProtectedRoute>
            }
          />
          <Route
            path="/stocks/:symbol"
            element={
              <ProtectedRoute>
                <StockDetail />
              </ProtectedRoute>
            }
          />
          <Route
            path="/watchlist"
            element={
              <ProtectedRoute>
                <Watchlist />
              </ProtectedRoute>
            }
          />
          <Route
            path="/data-quality"
            element={
              <ProtectedRoute>
                <DataQuality />
              </ProtectedRoute>
            }
          />

          {/* Unknown URLs go home rather than showing a blank screen. */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </>
  );
}
