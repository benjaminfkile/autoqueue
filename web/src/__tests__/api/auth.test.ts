import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  authApi,
  buildHostedAuthorizeUrl,
  buildHostedLogoutUrl,
} from "../../api/auth";
import { ApiError } from "../../api/client";

interface FetchCall {
  url: string;
  init: RequestInit;
}

let fetchMock: ReturnType<typeof vi.fn>;
const calls: FetchCall[] = [];

function mockFetchOnce(response: Response) {
  fetchMock.mockImplementationOnce(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: typeof input === "string" ? input : input.toString(),
        init: init ?? {},
      });
      return response;
    }
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  calls.length = 0;
  fetchMock = vi.fn();
  (globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("authApi.config", () => {
  it("GETs /api/auth/config and returns the parsed body", async () => {
    mockFetchOnce(
      jsonResponse({
        mode: "cognito",
        cognito: { loginMode: "hosted", domain: "x", clientId: "c" },
      })
    );
    const cfg = await authApi.config();
    expect(calls[0].url).toBe("/api/auth/config");
    expect(cfg).toEqual({
      mode: "cognito",
      cognito: { loginMode: "hosted", domain: "x", clientId: "c" },
    });
  });

  it("throws ApiError when the config endpoint fails", async () => {
    mockFetchOnce(jsonResponse({ error: "Secrets not loaded" }, 500));
    await expect(authApi.config()).rejects.toMatchObject({
      name: "ApiError",
      status: 500,
      message: "Secrets not loaded",
    });
  });
});

describe("authApi.login", () => {
  it("POSTs JSON to /api/auth/login and returns the token result", async () => {
    mockFetchOnce(
      jsonResponse({
        accessToken: "atk",
        idToken: "itk",
        expiresIn: 3600,
        tokenType: "Bearer",
      })
    );
    const result = await authApi.login("alice", "hunter2");
    expect(calls[0].url).toBe("/api/auth/login");
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.body).toBe(
      JSON.stringify({ username: "alice", password: "hunter2" })
    );
    expect(result.accessToken).toBe("atk");
  });

  it("rethrows the server error message on 401", async () => {
    mockFetchOnce(
      jsonResponse({ error: "Incorrect username or password." }, 401)
    );
    await expect(authApi.login("alice", "wrong")).rejects.toMatchObject({
      name: "ApiError",
      status: 401,
      message: expect.stringMatching(/incorrect username/i),
    });
    expect(ApiError).toBeDefined();
  });
});

describe("authApi.exchangeHostedCode", () => {
  it("POSTs the authorization_code grant to the hosted /oauth2/token endpoint", async () => {
    mockFetchOnce(
      jsonResponse({
        access_token: "atk",
        id_token: "itk",
        expires_in: 3600,
        token_type: "Bearer",
      })
    );
    const result = await authApi.exchangeHostedCode(
      { loginMode: "hosted", domain: "d.example.com", clientId: "c" },
      "the-code",
      "https://app.example.com/auth/callback"
    );
    expect(calls[0].url).toBe("https://d.example.com/oauth2/token");
    expect(calls[0].init.method).toBe("POST");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    const body = String(calls[0].init.body);
    expect(body).toContain("grant_type=authorization_code");
    expect(body).toContain("client_id=c");
    expect(body).toContain("code=the-code");
    expect(body).toContain(
      "redirect_uri=https%3A%2F%2Fapp.example.com%2Fauth%2Fcallback"
    );
    expect(result).toEqual({
      accessToken: "atk",
      idToken: "itk",
      expiresIn: 3600,
      tokenType: "Bearer",
    });
  });

  it("uses the Cognito-supplied error_description when token exchange fails", async () => {
    mockFetchOnce(
      jsonResponse(
        {
          error: "invalid_grant",
          error_description: "Authorization code has expired",
        },
        400
      )
    );
    await expect(
      authApi.exchangeHostedCode(
        { loginMode: "hosted", domain: "d.example.com", clientId: "c" },
        "stale-code",
        "https://app.example.com/auth/callback"
      )
    ).rejects.toMatchObject({
      message: "Authorization code has expired",
      status: 400,
    });
  });

  it("throws when domain or clientId is missing", async () => {
    await expect(
      authApi.exchangeHostedCode(
        { loginMode: "hosted" },
        "code",
        "https://app.example.com/auth/callback"
      )
    ).rejects.toBeInstanceOf(ApiError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("buildHostedAuthorizeUrl", () => {
  it("builds an authorize URL with the configured client and a sane scope", () => {
    const url = buildHostedAuthorizeUrl(
      { loginMode: "hosted", domain: "d.example.com", clientId: "c" },
      "https://app.example.com/auth/callback",
      "state-1"
    );
    expect(url).toMatch(/^https:\/\/d\.example\.com\/oauth2\/authorize\?/);
    expect(url).toContain("client_id=c");
    expect(url).toContain("response_type=code");
    expect(url).toContain("scope=openid");
    expect(url).toContain("state=state-1");
  });

  it("throws when the cognito config is incomplete", () => {
    expect(() =>
      buildHostedAuthorizeUrl(
        { loginMode: "hosted" },
        "https://app.example.com/auth/callback"
      )
    ).toThrow();
  });
});

describe("buildHostedLogoutUrl", () => {
  it("builds a /logout URL with logout_uri and client_id", () => {
    const url = buildHostedLogoutUrl(
      { loginMode: "hosted", domain: "d.example.com", clientId: "c" },
      "https://app.example.com/"
    );
    expect(url).toContain("https://d.example.com/logout?");
    expect(url).toContain("client_id=c");
    expect(url).toContain(
      "logout_uri=https%3A%2F%2Fapp.example.com%2F"
    );
  });
});
