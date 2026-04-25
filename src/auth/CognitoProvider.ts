import { Request } from "express";
import { CognitoJwtVerifier } from "aws-jwt-verify";
import { AuthContext, AuthProvider } from "./AuthProvider";
import { IAppSecrets } from "../interfaces";

type Verifier = { verify: (jwt: string) => Promise<unknown> };

/**
 * Authenticates requests by verifying an `Authorization: Bearer <jwt>` token
 * against the Cognito user pool configured in app secrets.
 *
 * Returns null (so the next provider is tried) when:
 *   - app secrets aren't loaded yet,
 *   - COGNITO_USER_POOL_ID / COGNITO_CLIENT_ID are not configured,
 *   - the Authorization header is missing or not a Bearer token,
 *   - aws-jwt-verify rejects the token (invalid signature, expired, wrong
 *     issuer/audience, etc).
 *
 * The underlying CognitoJwtVerifier holds its own JWKS cache, so we memoize
 * one verifier per (userPoolId, clientId) pair to avoid refetching JWKS on
 * every request. If the configured pool/client changes (e.g. secrets reload),
 * we transparently rebuild the verifier.
 */
export class CognitoProvider implements AuthProvider {
  readonly name = "cognito";

  private cachedVerifier: Verifier | null = null;
  private cacheKey: string | null = null;

  private getVerifier(userPoolId: string, clientId: string): Verifier {
    const key = `${userPoolId}|${clientId}`;
    if (this.cachedVerifier && this.cacheKey === key) {
      return this.cachedVerifier;
    }
    this.cachedVerifier = CognitoJwtVerifier.create({
      userPoolId,
      tokenUse: "access",
      clientId,
    }) as unknown as Verifier;
    this.cacheKey = key;
    return this.cachedVerifier;
  }

  async authenticate(req: Request): Promise<AuthContext | null> {
    const secrets = req.app.get("secrets") as IAppSecrets | undefined;
    if (
      !secrets ||
      !secrets.COGNITO_USER_POOL_ID ||
      !secrets.COGNITO_CLIENT_ID
    ) {
      return null;
    }

    const header = req.headers["authorization"];
    if (!header || typeof header !== "string") return null;
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match) return null;
    const token = match[1].trim();
    if (!token) return null;

    const verifier = this.getVerifier(
      secrets.COGNITO_USER_POOL_ID,
      secrets.COGNITO_CLIENT_ID
    );

    let payload: Record<string, unknown>;
    try {
      payload = (await verifier.verify(token)) as Record<string, unknown>;
    } catch {
      return null;
    }

    const sub = payload.sub;
    const email = payload.email;
    const scopeRaw = payload.scope;
    const scopes =
      typeof scopeRaw === "string"
        ? scopeRaw.split(/\s+/).filter(Boolean)
        : undefined;

    const ctx: AuthContext = {
      provider: this.name,
      subject: typeof sub === "string" ? sub : "unknown",
    };
    if (typeof email === "string") ctx.email = email;
    if (scopes && scopes.length > 0) ctx.scopes = scopes;
    return ctx;
  }
}

export default CognitoProvider;
