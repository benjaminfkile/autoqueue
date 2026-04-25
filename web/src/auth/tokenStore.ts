// In-memory bearer token store shared between the React AuthContext and the
// API client. Tokens are intentionally kept in module memory only — never in
// localStorage — so a tab close (or hard reload) ends the session, matching
// the security posture spelled out in task #214.
//
// The store is a tiny pub/sub so the API client can read the current token
// synchronously on every request without taking a React dependency, and so
// the AuthContext can react to token changes (e.g. token refresh from a
// callback handler) without prop-drilling.

type Listener = (token: string | null) => void;

let currentToken: string | null = null;
const listeners = new Set<Listener>();

export function getBearerToken(): string | null {
  return currentToken;
}

export function setBearerToken(token: string | null): void {
  if (currentToken === token) return;
  currentToken = token;
  for (const fn of listeners) fn(currentToken);
}

export function clearBearerToken(): void {
  setBearerToken(null);
}

export function subscribeToken(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

// Test-only — resets module state so suites don't leak tokens between cases.
export function __resetTokenStoreForTests(): void {
  currentToken = null;
  listeners.clear();
}
