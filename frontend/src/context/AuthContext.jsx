/**
 * Authentication state for the whole app, held in one React context.
 *
 * Why a context: the header needs the user's name, the router needs to know
 * whether anyone is logged in, and the login page needs to set that state.
 * Passing those through props would mean threading them through every component
 * in between. A context lets any component read the same state directly.
 *
 * On first load the app calls /auth/me with whatever token is in localStorage.
 * That is what verifies a stored token is still valid instead of trusting it.
 */

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { authApi, tokenStore } from "../api/client";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(tokenStore.getUser());
  // "loading" prevents a flash of the login page while /auth/me is in flight.
  const [loading, setLoading] = useState(Boolean(tokenStore.get()));

  useEffect(() => {
    const token = tokenStore.get();
    if (!token) {
      setLoading(false);
      return;
    }

    let cancelled = false;

    authApi
      .me()
      .then((data) => {
        if (cancelled) return;
        setUser(data.user);
        tokenStore.setUser(data.user);
      })
      .catch(() => {
        // Token rejected: treat the session as over.
        if (cancelled) return;
        tokenStore.clear();
        setUser(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    // Guards against setting state after the component unmounts.
    return () => {
      cancelled = true;
    };
  }, []);

  async function login(email, password) {
    const data = await authApi.login({ email, password });
    tokenStore.set(data.token);
    tokenStore.setUser(data.user);
    setUser(data.user);
    return data.user;
  }

  async function register(name, email, password) {
    const data = await authApi.register({ name, email, password });
    tokenStore.set(data.token);
    tokenStore.setUser(data.user);
    setUser(data.user);
    return data.user;
  }

  function logout() {
    // JWTs are stateless, so "logging out" means discarding the token client
    // side. The token stays technically valid until it expires, which is why
    // the expiry is kept short (24h).
    tokenStore.clear();
    setUser(null);
  }

  // useMemo keeps the context value stable so consumers do not re-render on
  // every provider render.
  const value = useMemo(
    () => ({ user, loading, login, register, logout, isAuthenticated: Boolean(user) }),
    [user, loading]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/** Convenience hook. Throws if used outside the provider, which catches wiring bugs early. */
export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used inside an <AuthProvider>.");
  }
  return context;
}
