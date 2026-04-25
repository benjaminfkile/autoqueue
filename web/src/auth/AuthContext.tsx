import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  authApi,
  buildHostedAuthorizeUrl,
  buildHostedLogoutUrl,
  type AuthConfig,
} from "../api/auth";
import {
  clearBearerToken,
  getBearerToken,
  setBearerToken,
} from "./tokenStore";

type Status = "loading" | "logged-out" | "logged-in" | "error";

export interface AuthState {
  status: Status;
  config: AuthConfig | null;
  error: string | null;
  // Email/username from the id token, when available. Used for the small
  // "Signed in as <name>" line beside the logout button.
  identity: string | null;
}

export interface AuthContextValue extends AuthState {
  // Drives the hosted-UI redirect; throws synchronously if the deployment
  // isn't actually configured for hosted login.
  loginWithHostedUi: () => void;
  // Submits credentials to the in-app login endpoint and stores the resulting
  // token on success. Throws on failure so the caller can render the error.
  loginWithCredentials: (username: string, password: string) => Promise<void>;
  // Clears state. For Cognito hosted-UI deployments, additionally redirects
  // through Cognito's /logout endpoint so the hosted session is cleared too.
  logout: () => void;
  // Used by the OAuth callback page once it has exchanged a code for a token.
  finalizeLogin: (token: string, identity?: string | null) => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

interface JwtPayload {
  email?: string;
  username?: string;
  "cognito:username"?: string;
  sub?: string;
}

// Best-effort decode of a JWT payload purely so the GUI can show "Signed in
// as <email>". The backend still does the cryptographic verification on every
// request, so a tampered payload here cannot grant any access — at worst the
// label is wrong.
function decodeJwt(token: string): JwtPayload | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = payload.padEnd(
      payload.length + ((4 - (payload.length % 4)) % 4),
      "="
    );
    const decoded =
      typeof atob === "function"
        ? atob(padded)
        : Buffer.from(padded, "base64").toString("utf-8");
    return JSON.parse(decoded) as JwtPayload;
  } catch {
    return null;
  }
}

function identityFromToken(token: string): string | null {
  const payload = decodeJwt(token);
  if (!payload) return null;
  return (
    payload.email ||
    payload["cognito:username"] ||
    payload.username ||
    payload.sub ||
    null
  );
}

function hostedRedirectUri(): string {
  return `${window.location.origin}/auth/callback`;
}

function hostedLogoutUri(): string {
  return window.location.origin + "/";
}

interface AuthProviderProps {
  children: ReactNode;
  // Test seam: lets unit tests inject a mock config loader.
  loadConfig?: () => Promise<AuthConfig>;
}

/**
 * Provides authentication state to the rest of the app.
 *
 * Boot sequence:
 *   1. Fetch /api/auth/config to learn the deployment's auth mode.
 *   2. If the user already has a bearer token in tokenStore (e.g. they
 *      finished an OAuth callback before this provider mounted), surface it.
 *   3. Otherwise, leave status === "logged-out" and let the LoginPage drive
 *      the configured flow.
 *
 * Tokens never persist across reloads — they live in tokenStore (module
 * memory) and are cleared on logout.
 */
export function AuthProvider({ children, loadConfig }: AuthProviderProps) {
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState<string | null>(null);
  const [identity, setIdentity] = useState<string | null>(null);
  const loaderRef = useRef(loadConfig ?? authApi.config);

  useEffect(() => {
    let cancelled = false;
    const existing = getBearerToken();
    if (existing) {
      setIdentity(identityFromToken(existing));
    }
    loaderRef
      .current()
      .then((cfg) => {
        if (cancelled) return;
        setConfig(cfg);
        if (cfg.mode === "apikey") {
          // Legacy api-key deployments don't have a "logged out" UI; if a key
          // is present in localStorage we treat the user as authenticated.
          // Otherwise the LoginPage prompts for one.
          const hasKey =
            typeof window !== "undefined" &&
            !!window.localStorage.getItem("grunt_api_key");
          setStatus(hasKey ? "logged-in" : "logged-out");
        } else if (getBearerToken()) {
          setStatus("logged-in");
        } else {
          setStatus("logged-out");
        }
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setStatus("error");
        setError(err.message || "Could not load auth config");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const finalizeLogin = useCallback(
    (token: string, name?: string | null) => {
      setBearerToken(token);
      setIdentity(name ?? identityFromToken(token));
      setStatus("logged-in");
      setError(null);
    },
    []
  );

  const loginWithHostedUi = useCallback(() => {
    if (!config?.cognito || config.cognito.loginMode !== "hosted") {
      throw new Error("Hosted UI login is not configured");
    }
    const url = buildHostedAuthorizeUrl(config.cognito, hostedRedirectUri());
    window.location.assign(url);
  }, [config]);

  const loginWithCredentials = useCallback(
    async (username: string, password: string) => {
      const result = await authApi.login(username, password);
      finalizeLogin(
        result.accessToken,
        result.idToken ? identityFromToken(result.idToken) : null
      );
    },
    [finalizeLogin]
  );

  const logout = useCallback(() => {
    clearBearerToken();
    setIdentity(null);
    setStatus("logged-out");
    setError(null);
    if (config?.cognito && config.cognito.loginMode === "hosted") {
      try {
        const url = buildHostedLogoutUrl(config.cognito, hostedLogoutUri());
        window.location.assign(url);
      } catch {
        // Misconfigured logout endpoint — already cleared local state, so
        // just stay on the login screen.
      }
    }
  }, [config]);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      config,
      error,
      identity,
      loginWithHostedUi,
      loginWithCredentials,
      logout,
      finalizeLogin,
    }),
    [
      status,
      config,
      error,
      identity,
      loginWithHostedUi,
      loginWithCredentials,
      logout,
      finalizeLogin,
    ]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return ctx;
}

export { identityFromToken };
