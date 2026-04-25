import { Request } from "express";

// Result of a successful authentication. Providers may attach extra fields
// (e.g. email, scopes) — keep them on a typed shape rather than `any` so
// downstream handlers can read what's there without losing type safety.
export interface AuthContext {
  // Identifies which provider authenticated the request.
  provider: string;
  // Stable identifier for the authenticated party. For api-key auth this is a
  // constant; for hosted providers (Cognito) it's the user id / sub.
  subject: string;
  // Optional human-readable identity (email, username) — providers fill this
  // when they have it.
  email?: string;
  // Optional scopes / groups granted by the provider.
  scopes?: string[];
}

export interface AuthProvider {
  // Short identifier used in logs and on AuthContext.provider.
  name: string;
  // Returns an AuthContext when this provider successfully authenticates the
  // request, or null when this provider doesn't apply / can't authenticate it.
  // protectedRoute will try the next provider on null. Throwing should be
  // reserved for genuine server errors (misconfiguration, upstream failure).
  authenticate(req: Request): Promise<AuthContext | null>;
}
