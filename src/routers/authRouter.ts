import express, { Request, Response } from "express";
import { IAppSecrets } from "../interfaces";

const authRouter = express.Router();

interface ConfigResponse {
  // Auth mode the GUI should drive — derived from AUTH_PROVIDER. When the
  // chain has both apikey and cognito the GUI prefers the cognito flow because
  // a fresh user has no api key to fall back to.
  mode: "apikey" | "cognito";
  // Only present when mode === "cognito".
  cognito?: {
    // "hosted" → GUI redirects to the Cognito-hosted UI authorize endpoint.
    // "inapp"  → GUI renders an in-app form and POSTs to /api/auth/login.
    loginMode: "hosted" | "inapp";
    // Cognito-hosted UI domain, e.g. "mygrunt.auth.us-east-1.amazoncognito.com".
    // Only set in hosted mode.
    domain?: string;
    // Cognito app client id (public). Needed by the GUI to build the hosted
    // UI authorize URL and to exchange the code at the token endpoint.
    clientId?: string;
  };
}

function pickAuthMode(raw: string | undefined): "apikey" | "cognito" {
  // Mirrors buildAuthProviders parsing. The GUI only needs to know which
  // login flow to drive; if cognito is in the chain (in any order) we drive
  // the cognito flow because that's the user-facing path.
  if (!raw || typeof raw !== "string") return "apikey";
  const names = raw
    .split(",")
    .map((n) => n.trim().toLowerCase())
    .filter(Boolean);
  return names.includes("cognito") ? "cognito" : "apikey";
}

function pickLoginMode(secrets: IAppSecrets): "hosted" | "inapp" {
  const explicit = secrets.COGNITO_LOGIN_MODE;
  if (explicit === "hosted" || explicit === "inapp") return explicit;
  return secrets.COGNITO_DOMAIN ? "hosted" : "inapp";
}

function regionFromPoolId(poolId: string | undefined): string | undefined {
  if (!poolId) return undefined;
  const idx = poolId.indexOf("_");
  return idx > 0 ? poolId.slice(0, idx) : undefined;
}

/**
 * GET /api/auth/config
 *
 * Public endpoint (intentionally not behind protectedRoute) so the unauthenticated
 * GUI can ask the backend which auth flow to drive on first load. It returns:
 *   - mode: "apikey" | "cognito"
 *   - cognito: when mode === "cognito", the hosted-UI domain + client id and
 *     the configured loginMode ("hosted" or "inapp")
 *
 * The Cognito user pool id and any other secrets stay server-side; only the
 * client-id and the public hosted-UI domain are exposed.
 */
authRouter.get("/config", (req: Request, res: Response) => {
  const secrets = req.app.get("secrets") as IAppSecrets | undefined;
  if (!secrets) {
    return res.status(500).json({ error: "Secrets not loaded" });
  }

  const mode = pickAuthMode(secrets.AUTH_PROVIDER);
  const body: ConfigResponse = { mode };

  if (mode === "cognito") {
    const loginMode = pickLoginMode(secrets);
    body.cognito = {
      loginMode,
      domain: secrets.COGNITO_DOMAIN,
      clientId: secrets.COGNITO_CLIENT_ID,
    };
  }

  return res.status(200).json(body);
});

interface LoginBody {
  username?: unknown;
  password?: unknown;
}

interface CognitoInitiateAuthResult {
  AuthenticationResult?: {
    AccessToken?: string;
    IdToken?: string;
    RefreshToken?: string;
    ExpiresIn?: number;
    TokenType?: string;
  };
  ChallengeName?: string;
}

/**
 * POST /api/auth/login
 *
 * In-app login path: the GUI submits {username, password} when the configured
 * loginMode is "inapp". We forward the credentials to Cognito IdP via the
 * USER_PASSWORD_AUTH flow and return the access token to the GUI.
 *
 * Implemented over fetch (rather than @aws-sdk/client-cognito-identity-provider)
 * to avoid pulling in a heavy dependency. Cognito's IdP endpoint accepts an
 * unsigned POST when the AppClient has no client secret (typical for SPA
 * clients), which is the configuration this flow targets.
 *
 * Public endpoint (no protectedRoute) — credentials authenticate the call.
 * Returns 503 when the deployment isn't configured for in-app login.
 */
authRouter.post("/login", async (req: Request, res: Response) => {
  const secrets = req.app.get("secrets") as IAppSecrets | undefined;
  if (!secrets) {
    return res.status(500).json({ error: "Secrets not loaded" });
  }

  const mode = pickAuthMode(secrets.AUTH_PROVIDER);
  if (mode !== "cognito") {
    return res
      .status(503)
      .json({ error: "Cognito auth is not enabled on this deployment" });
  }
  const loginMode = pickLoginMode(secrets);
  if (loginMode !== "inapp") {
    return res
      .status(503)
      .json({ error: "In-app login is not enabled; use the hosted UI flow" });
  }
  if (!secrets.COGNITO_CLIENT_ID || !secrets.COGNITO_USER_POOL_ID) {
    return res
      .status(500)
      .json({ error: "Cognito client/user pool is not configured" });
  }

  const { username, password } = (req.body ?? {}) as LoginBody;
  if (typeof username !== "string" || !username) {
    return res.status(400).json({ error: "username is required" });
  }
  if (typeof password !== "string" || !password) {
    return res.status(400).json({ error: "password is required" });
  }

  const region =
    secrets.COGNITO_REGION || regionFromPoolId(secrets.COGNITO_USER_POOL_ID);
  if (!region) {
    return res
      .status(500)
      .json({ error: "Could not infer Cognito region" });
  }

  // The express types in scope here clobber the global DOM `Response` type, so
  // narrow what we use of the fetch response to a tiny structural type.
  interface FetchResponse {
    ok: boolean;
    status: number;
    statusText: string;
    text(): Promise<string>;
  }

  const url = `https://cognito-idp.${region}.amazonaws.com/`;
  let cognitoRes: FetchResponse;
  try {
    cognitoRes = (await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-amz-json-1.1",
        "X-Amz-Target": "AWSCognitoIdentityProviderService.InitiateAuth",
      },
      body: JSON.stringify({
        AuthFlow: "USER_PASSWORD_AUTH",
        ClientId: secrets.COGNITO_CLIENT_ID,
        AuthParameters: {
          USERNAME: username,
          PASSWORD: password,
        },
      }),
    })) as unknown as FetchResponse;
  } catch (err) {
    return res
      .status(502)
      .json({ error: `Cognito request failed: ${(err as Error).message}` });
  }

  const text = await cognitoRes.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }

  if (!cognitoRes.ok) {
    const message =
      (payload &&
        typeof payload === "object" &&
        "message" in payload &&
        typeof (payload as { message: unknown }).message === "string" &&
        (payload as { message: string }).message) ||
      cognitoRes.statusText ||
      "Login failed";
    const status = cognitoRes.status === 400 ? 401 : cognitoRes.status;
    return res.status(status).json({ error: message });
  }

  const result = (payload ?? {}) as CognitoInitiateAuthResult;
  if (result.ChallengeName) {
    return res.status(401).json({
      error: `Login challenge required: ${result.ChallengeName}`,
    });
  }
  const auth = result.AuthenticationResult;
  if (!auth || !auth.AccessToken) {
    return res.status(502).json({ error: "Cognito returned no access token" });
  }

  return res.status(200).json({
    accessToken: auth.AccessToken,
    idToken: auth.IdToken,
    expiresIn: auth.ExpiresIn,
    tokenType: auth.TokenType ?? "Bearer",
  });
});

export default authRouter;
