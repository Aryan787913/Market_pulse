/**
 * React entry point.
 *
 * BrowserRouter wraps AuthProvider so that the auth context can use navigation
 * hooks, and both wrap App so every page has access to routing and the session.
 * StrictMode is on: in development it double-invokes effects on purpose to
 * surface missing cleanup, which is why the fetch effects use a "cancelled" flag.
 */

import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";

import App from "./App";
import { AuthProvider } from "./context/AuthContext";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>
);
