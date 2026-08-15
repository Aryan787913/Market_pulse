/**
 * Top navigation bar, shown only when a user is logged in.
 *
 * NavLink is used instead of Link because it applies an "active" class
 * automatically for the current route, which is how the highlighted tab works
 * without any extra state.
 */

import { NavLink, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";

const LINKS = [
  { to: "/", label: "Dashboard" },
  { to: "/watchlist", label: "Watchlist" },
  { to: "/data-quality", label: "Data Quality" },
];

export default function Navbar() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  function handleLogout() {
    logout();
    navigate("/login", { replace: true });
  }

  return (
    <header className="navbar">
      <div className="navbar-brand">
        <span className="brand-mark" aria-hidden="true">
          ▲
        </span>
        MarketPulse
      </div>

      <nav className="navbar-links" aria-label="Main navigation">
        {LINKS.map((link) => (
          <NavLink
            key={link.to}
            to={link.to}
            // "end" stops "/" from matching every nested route.
            end={link.to === "/"}
            className={({ isActive }) => (isActive ? "nav-link active" : "nav-link")}
          >
            {link.label}
          </NavLink>
        ))}
      </nav>

      <div className="navbar-user">
        <span className="user-name">{user?.name}</span>
        <button type="button" className="btn btn-ghost" onClick={handleLogout}>
          Log out
        </button>
      </div>
    </header>
  );
}
