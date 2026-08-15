/**
 * Single axios instance used by the whole app.
 *
 * Two interceptors do the repetitive work:
 *   request  -> attaches the stored JWT as an Authorization header
 *   response -> on a 401, clears the token and sends the user back to /login
 *
 * Token storage note: the token is kept in localStorage. That is the simplest
 * option for a single-page app and is what this project uses, but it is
 * readable by any script on the page, so it would be vulnerable to XSS. A
 * production system would prefer an httpOnly cookie, which JavaScript cannot
 * read at all. This tradeoff is documented in the report.
 */

import axios from "axios";

const TOKEN_KEY = "marketpulse_token";
const USER_KEY = "marketpulse_user";

export const tokenStore = {
  get: () => localStorage.getItem(TOKEN_KEY),
  set: (token) => localStorage.setItem(TOKEN_KEY, token),
  clear: () => {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  },
  getUser: () => {
    try {
      return JSON.parse(localStorage.getItem(USER_KEY));
    } catch {
      return null;
    }
  },
  setUser: (user) => localStorage.setItem(USER_KEY, JSON.stringify(user)),
};

const api = axios.create({
  // In dev the Vite proxy forwards /api to :5000, so a relative URL is enough.
  baseURL: import.meta.env.VITE_API_BASE_URL || "/api",
  timeout: 15000,
  headers: { "Content-Type": "application/json" },
});

api.interceptors.request.use((config) => {
  const token = tokenStore.get();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

api.interceptors.response.use(
  (response) => response,
  (error) => {
    const status = error.response?.status;

    // An expired or tampered token: drop it and force a fresh login.
    if (status === 401 && !window.location.pathname.startsWith("/login")) {
      tokenStore.clear();
      window.location.href = "/login";
    }

    // Normalise the error so components can just read error.message.
    const message =
      error.response?.data?.message ||
      (error.code === "ECONNABORTED"
        ? "The request timed out. Is the API running?"
        : "Could not reach the server.");

    return Promise.reject(new Error(message));
  }
);

/** Thin wrappers so components never build URLs by hand. */
export const authApi = {
  register: (payload) => api.post("/auth/register", payload).then((r) => r.data),
  login: (payload) => api.post("/auth/login", payload).then((r) => r.data),
  me: () => api.get("/auth/me").then((r) => r.data),
};

export const stocksApi = {
  list: (params) => api.get("/stocks", { params }).then((r) => r.data),
  detail: (symbol) => api.get(`/stocks/${encodeURIComponent(symbol)}`).then((r) => r.data),
  history: (symbol, days = 90) =>
    api
      .get(`/stocks/${encodeURIComponent(symbol)}/history`, { params: { days } })
      .then((r) => r.data),
  movers: (limit = 5) => api.get("/stocks/movers/top", { params: { limit } }).then((r) => r.data),
  sectors: () => api.get("/stocks/sectors/summary").then((r) => r.data),
};

export const watchlistApi = {
  list: () => api.get("/watchlist").then((r) => r.data),
  add: (symbol) => api.post("/watchlist", { symbol }).then((r) => r.data),
  remove: (symbol) =>
    api.delete(`/watchlist/${encodeURIComponent(symbol)}`).then((r) => r.data),
};

export const pipelineApi = {
  runs: (limit = 10) => api.get("/pipeline/runs", { params: { limit } }).then((r) => r.data),
  quality: () => api.get("/pipeline/quality").then((r) => r.data),
  freshness: () => api.get("/pipeline/freshness").then((r) => r.data),
};

export default api;
