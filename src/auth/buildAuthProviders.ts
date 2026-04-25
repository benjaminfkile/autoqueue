import { IAppSecrets } from "../interfaces";
import { AuthProvider } from "./AuthProvider";
import { ApiKeyProvider } from "./ApiKeyProvider";
import { CognitoProvider } from "./CognitoProvider";

/**
 * Resolves the AUTH_PROVIDER config string from app secrets into the ordered
 * list of AuthProvider instances that protectedRoute should try.
 *
 * Accepted values (case-insensitive, whitespace-tolerant):
 *   - "apikey"           → [ApiKeyProvider]
 *   - "cognito"          → [CognitoProvider]
 *   - "apikey,cognito"   → [ApiKeyProvider, CognitoProvider]
 *   - "cognito,apikey"   → [CognitoProvider, ApiKeyProvider]
 *
 * Backwards compatibility: if AUTH_PROVIDER is missing, empty, or contains
 * only whitespace/empty entries, the chain falls back to a single
 * ApiKeyProvider.
 *
 * Throws when an unknown provider name is configured so the misconfiguration
 * surfaces at startup instead of silently leaving routes unprotected.
 */
export function buildAuthProviders(secrets: IAppSecrets): AuthProvider[] {
  const raw = secrets.AUTH_PROVIDER;
  if (!raw || typeof raw !== "string" || raw.trim() === "") {
    return [new ApiKeyProvider()];
  }

  const names = raw
    .split(",")
    .map((n) => n.trim().toLowerCase())
    .filter((n) => n.length > 0);

  if (names.length === 0) {
    return [new ApiKeyProvider()];
  }

  const providers: AuthProvider[] = [];
  for (const name of names) {
    if (name === "apikey") {
      providers.push(new ApiKeyProvider());
    } else if (name === "cognito") {
      providers.push(new CognitoProvider());
    } else {
      throw new Error(
        `Unknown AUTH_PROVIDER entry: "${name}". ` +
          `Supported values: "apikey", "cognito".`
      );
    }
  }

  return providers;
}

export default buildAuthProviders;
