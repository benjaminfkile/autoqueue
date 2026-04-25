import { ApiError } from "./client";

export interface CognitoFlowConfig {
  loginMode: "hosted" | "inapp";
  domain?: string;
  clientId?: string;
}

export interface AuthConfig {
  mode: "apikey" | "cognito";
  cognito?: CognitoFlowConfig;
}

export interface LoginResult {
  accessToken: string;
  idToken?: string;
  expiresIn?: number;
  tokenType?: string;
}

async function readJson<T>(res: Response): Promise<T> {
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    const message =
      (data && typeof data === "object" && "error" in data
        ? String((data as { error: unknown }).error)
        : null) ||
      (typeof data === "string" && data) ||
      res.statusText ||
      `Request failed with status ${res.status}`;
    throw new ApiError(res.status, message);
  }
  return data as T;
}

export const authApi = {
  // Reads /api/auth/config so the GUI knows whether to drive the apikey path
  // (legacy) or the Cognito path, and within Cognito whether to redirect to
  // the hosted UI or render an in-app form.
  config: async (): Promise<AuthConfig> => {
    const res = await fetch("/api/auth/config", {
      headers: { Accept: "application/json" },
    });
    return readJson<AuthConfig>(res);
  },
  // POSTs username/password to the in-app login endpoint. The backend forwards
  // the credentials to Cognito IdP via USER_PASSWORD_AUTH and returns the
  // access token on success.
  login: async (username: string, password: string): Promise<LoginResult> => {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ username, password }),
    });
    return readJson<LoginResult>(res);
  },
  // Exchanges a Cognito hosted-UI authorization code for tokens. Talks
  // directly to the Cognito-hosted /oauth2/token endpoint (the SPA app
  // client has no secret, so this is a public flow). Used by the OAuth
  // callback page after the hosted-UI redirect completes.
  exchangeHostedCode: async (
    cognito: CognitoFlowConfig,
    code: string,
    redirectUri: string,
    codeVerifier?: string
  ): Promise<LoginResult> => {
    if (!cognito.domain || !cognito.clientId) {
      throw new ApiError(500, "Cognito domain or client id is not configured");
    }
    const body = new URLSearchParams();
    body.set("grant_type", "authorization_code");
    body.set("client_id", cognito.clientId);
    body.set("code", code);
    body.set("redirect_uri", redirectUri);
    if (codeVerifier) body.set("code_verifier", codeVerifier);
    const res = await fetch(`https://${cognito.domain}/oauth2/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });
    const text = await res.text();
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    if (!res.ok) {
      let message = "";
      if (data && typeof data === "object") {
        if ("error_description" in data) {
          message = String((data as { error_description: unknown }).error_description);
        } else if ("error" in data) {
          message = String((data as { error: unknown }).error);
        }
      }
      if (!message) message = res.statusText || "Token exchange failed";
      throw new ApiError(res.status, message);
    }
    const result = (data ?? {}) as {
      access_token?: string;
      id_token?: string;
      expires_in?: number;
      token_type?: string;
    };
    if (!result.access_token) {
      throw new ApiError(502, "Cognito returned no access token");
    }
    return {
      accessToken: result.access_token,
      idToken: result.id_token,
      expiresIn: result.expires_in,
      tokenType: result.token_type ?? "Bearer",
    };
  },
};

export function buildHostedAuthorizeUrl(
  cognito: CognitoFlowConfig,
  redirectUri: string,
  state?: string
): string {
  if (!cognito.domain || !cognito.clientId) {
    throw new Error("Cognito domain or client id is not configured");
  }
  const params = new URLSearchParams();
  params.set("client_id", cognito.clientId);
  params.set("response_type", "code");
  params.set("scope", "openid email");
  params.set("redirect_uri", redirectUri);
  if (state) params.set("state", state);
  return `https://${cognito.domain}/oauth2/authorize?${params.toString()}`;
}

export function buildHostedLogoutUrl(
  cognito: CognitoFlowConfig,
  logoutUri: string
): string {
  if (!cognito.domain || !cognito.clientId) {
    throw new Error("Cognito domain or client id is not configured");
  }
  const params = new URLSearchParams();
  params.set("client_id", cognito.clientId);
  params.set("logout_uri", logoutUri);
  return `https://${cognito.domain}/logout?${params.toString()}`;
}
