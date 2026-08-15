/**
 * Renders Google's official "Sign in with Google" button and hands the resulting
 * ID token to the auth context.
 *
 * Why Google's own button rather than a styled <button> of our own: Google
 * Identity Services renders it inside its own element and requires it, and using
 * the official widget keeps the branding requirements satisfied without any
 * guesswork about logo spacing or wording.
 *
 * The script is loaded on demand instead of being a <script> tag in index.html,
 * so that a page which never shows the button never pays for the request, and
 * the app still works offline from Google's CDN (the button simply does not
 * appear and the password form remains usable).
 *
 * The client ID comes from the API at runtime via /auth/config. If the server
 * has no GOOGLE_CLIENT_ID configured, this component renders nothing at all,
 * which is what keeps the deployment working before the ID has been created.
 */

import { useEffect, useRef, useState } from "react";

import { authApi } from "../api/client";
import { useAuth } from "../context/AuthContext";

const GSI_SRC = "https://accounts.google.com/gsi/client";

/** Loads the Google Identity Services script once, reusing it across mounts. */
function loadGoogleScript() {
  if (window.google?.accounts?.id) {
    return Promise.resolve();
  }

  // A second mount while the first load is still in flight must not add another
  // tag, so the pending promise is cached on the existing element.
  const existing = document.querySelector(`script[src="${GSI_SRC}"]`);
  if (existing?._loadPromise) {
    return existing._loadPromise;
  }

  const script = document.createElement("script");
  script.src = GSI_SRC;
  script.async = true;
  script.defer = true;

  const promise = new Promise((resolve, reject) => {
    script.onload = resolve;
    script.onerror = () => reject(new Error("Could not load Google sign-in."));
  });

  script._loadPromise = promise;
  document.head.appendChild(script);
  return promise;
}

export default function GoogleSignInButton({ onSuccess, onError, text = "signin_with" }) {
  const { loginWithGoogle } = useAuth();
  const containerRef = useRef(null);
  const [available, setAvailable] = useState(false);

  // A ref, not state: the Google callback is registered once and would otherwise
  // capture the first render's props forever.
  const handlersRef = useRef({ onSuccess, onError });
  handlersRef.current = { onSuccess, onError };

  useEffect(() => {
    let cancelled = false;

    async function setup() {
      try {
        const config = await authApi.config();
        if (cancelled || !config.googleEnabled) return;

        await loadGoogleScript();
        if (cancelled || !containerRef.current) return;

        window.google.accounts.id.initialize({
          client_id: config.googleClientId,
          callback: async (response) => {
            try {
              const user = await loginWithGoogle(response.credential);
              handlersRef.current.onSuccess?.(user);
            } catch (err) {
              handlersRef.current.onError?.(err.message);
            }
          },
        });

        window.google.accounts.id.renderButton(containerRef.current, {
          theme: "outline",
          size: "large",
          text,
          width: 320,
        });

        setAvailable(true);
      } catch {
        // Either the config call failed or the script did not load. Sign-in by
        // password still works, so this stays silent rather than showing an
        // error for a feature the user may not have tried to use.
        if (!cancelled) setAvailable(false);
      }
    }

    setup();
    return () => {
      cancelled = true;
    };
    // loginWithGoogle is stable for the provider's lifetime; re-running this
    // effect would render a second button.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className={available ? "google-signin" : "google-signin is-hidden"}>
      {available && <div className="google-signin-divider">or</div>}
      <div ref={containerRef} className="google-signin-button" />
    </div>
  );
}
