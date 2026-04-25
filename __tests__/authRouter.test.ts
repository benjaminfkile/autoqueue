import express, { Express } from "express";
import request from "supertest";

import authRouter from "../src/routers/authRouter";
import { IAppSecrets } from "../src/interfaces";

// Mock global fetch so the in-app login path never reaches the real Cognito
// IdP endpoint. Each test stubs the response shape it cares about.
const mockFetch = jest.fn();
const originalFetch = (globalThis as { fetch?: typeof fetch }).fetch;

beforeEach(() => {
  mockFetch.mockReset();
  (globalThis as { fetch: typeof fetch }).fetch =
    mockFetch as unknown as typeof fetch;
});

afterAll(() => {
  if (originalFetch) {
    (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
  } else {
    delete (globalThis as { fetch?: typeof fetch }).fetch;
  }
});

function makeApp(secrets: Partial<IAppSecrets> | undefined): Express {
  const app = express();
  app.use(express.json());
  app.use("/api/auth", authRouter);
  if (secrets) app.set("secrets", secrets as unknown as IAppSecrets);
  return app;
}

describe("GET /api/auth/config", () => {
  it("returns 500 when secrets are not loaded", async () => {
    const app = makeApp(undefined);
    const res = await request(app).get("/api/auth/config");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Secrets not loaded" });
  });

  it("returns mode=apikey when AUTH_PROVIDER is missing", async () => {
    const app = makeApp({ API_KEY_HASH: "h" });
    const res = await request(app).get("/api/auth/config");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ mode: "apikey" });
  });

  it("returns mode=apikey when AUTH_PROVIDER is 'apikey'", async () => {
    const app = makeApp({ AUTH_PROVIDER: "apikey", API_KEY_HASH: "h" });
    const res = await request(app).get("/api/auth/config");
    expect(res.body).toEqual({ mode: "apikey" });
  });

  it("returns mode=cognito with hosted loginMode and public client config when domain is set", async () => {
    const app = makeApp({
      AUTH_PROVIDER: "cognito",
      COGNITO_USER_POOL_ID: "us-east-1_xyz",
      COGNITO_CLIENT_ID: "client-1",
      COGNITO_DOMAIN: "mygrunt.auth.us-east-1.amazoncognito.com",
    });
    const res = await request(app).get("/api/auth/config");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      mode: "cognito",
      cognito: {
        loginMode: "hosted",
        domain: "mygrunt.auth.us-east-1.amazoncognito.com",
        clientId: "client-1",
      },
    });
  });

  it("defaults to inapp when COGNITO_DOMAIN is not set", async () => {
    const app = makeApp({
      AUTH_PROVIDER: "cognito",
      COGNITO_USER_POOL_ID: "us-east-1_xyz",
      COGNITO_CLIENT_ID: "client-1",
    });
    const res = await request(app).get("/api/auth/config");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      mode: "cognito",
      cognito: {
        loginMode: "inapp",
        domain: undefined,
        clientId: "client-1",
      },
    });
  });

  it("respects an explicit COGNITO_LOGIN_MODE override", async () => {
    const app = makeApp({
      AUTH_PROVIDER: "cognito",
      COGNITO_USER_POOL_ID: "us-east-1_xyz",
      COGNITO_CLIENT_ID: "client-1",
      COGNITO_DOMAIN: "x.auth.us-east-1.amazoncognito.com",
      COGNITO_LOGIN_MODE: "inapp",
    });
    const res = await request(app).get("/api/auth/config");
    expect(res.body.cognito.loginMode).toBe("inapp");
  });

  it("treats 'apikey,cognito' as cognito so the GUI prefers the cognito flow", async () => {
    const app = makeApp({
      AUTH_PROVIDER: "apikey,cognito",
      COGNITO_USER_POOL_ID: "us-east-1_xyz",
      COGNITO_CLIENT_ID: "client-1",
    });
    const res = await request(app).get("/api/auth/config");
    expect(res.body.mode).toBe("cognito");
  });

  it("does not leak the user pool id", async () => {
    const app = makeApp({
      AUTH_PROVIDER: "cognito",
      COGNITO_USER_POOL_ID: "us-east-1_secret_pool",
      COGNITO_CLIENT_ID: "client-1",
      COGNITO_DOMAIN: "x.auth.us-east-1.amazoncognito.com",
    });
    const res = await request(app).get("/api/auth/config");
    expect(JSON.stringify(res.body)).not.toContain("us-east-1_secret_pool");
  });
});

describe("POST /api/auth/login", () => {
  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  it("returns 503 when AUTH_PROVIDER is not cognito", async () => {
    const app = makeApp({ AUTH_PROVIDER: "apikey", API_KEY_HASH: "h" });
    const res = await request(app)
      .post("/api/auth/login")
      .send({ username: "u", password: "p" });
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/cognito/i);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns 503 when login mode is hosted (not inapp)", async () => {
    const app = makeApp({
      AUTH_PROVIDER: "cognito",
      COGNITO_USER_POOL_ID: "us-east-1_xyz",
      COGNITO_CLIENT_ID: "client-1",
      COGNITO_DOMAIN: "x.auth.us-east-1.amazoncognito.com",
    });
    const res = await request(app)
      .post("/api/auth/login")
      .send({ username: "u", password: "p" });
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/in-app login/i);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns 400 when username is missing", async () => {
    const app = makeApp({
      AUTH_PROVIDER: "cognito",
      COGNITO_USER_POOL_ID: "us-east-1_xyz",
      COGNITO_CLIENT_ID: "client-1",
    });
    const res = await request(app)
      .post("/api/auth/login")
      .send({ password: "p" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/username/);
  });

  it("returns 400 when password is missing", async () => {
    const app = makeApp({
      AUTH_PROVIDER: "cognito",
      COGNITO_USER_POOL_ID: "us-east-1_xyz",
      COGNITO_CLIENT_ID: "client-1",
    });
    const res = await request(app)
      .post("/api/auth/login")
      .send({ username: "u" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/password/);
  });

  it("returns 200 with the access token on a successful USER_PASSWORD_AUTH", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        AuthenticationResult: {
          AccessToken: "access.jwt",
          IdToken: "id.jwt",
          RefreshToken: "refresh.jwt",
          ExpiresIn: 3600,
          TokenType: "Bearer",
        },
      })
    );
    const app = makeApp({
      AUTH_PROVIDER: "cognito",
      COGNITO_USER_POOL_ID: "us-east-1_xyz",
      COGNITO_CLIENT_ID: "client-1",
    });
    const res = await request(app)
      .post("/api/auth/login")
      .send({ username: "alice", password: "hunter2" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      accessToken: "access.jwt",
      idToken: "id.jwt",
      expiresIn: 3600,
      tokenType: "Bearer",
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("https://cognito-idp.us-east-1.amazonaws.com/");
    const initHeaders = init.headers as Record<string, string>;
    expect(initHeaders["X-Amz-Target"]).toBe(
      "AWSCognitoIdentityProviderService.InitiateAuth"
    );
    const sentBody = JSON.parse(init.body as string);
    expect(sentBody).toEqual({
      AuthFlow: "USER_PASSWORD_AUTH",
      ClientId: "client-1",
      AuthParameters: { USERNAME: "alice", PASSWORD: "hunter2" },
    });
  });

  it("uses COGNITO_REGION when set instead of inferring from the pool id", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ AuthenticationResult: { AccessToken: "tok" } })
    );
    const app = makeApp({
      AUTH_PROVIDER: "cognito",
      COGNITO_USER_POOL_ID: "us-east-1_xyz",
      COGNITO_CLIENT_ID: "client-1",
      COGNITO_REGION: "eu-central-1",
    });
    await request(app)
      .post("/api/auth/login")
      .send({ username: "u", password: "p" });
    expect(mockFetch.mock.calls[0][0]).toBe(
      "https://cognito-idp.eu-central-1.amazonaws.com/"
    );
  });

  it("maps a 400 from Cognito to 401 with the Cognito-supplied message", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(
        {
          __type: "NotAuthorizedException",
          message: "Incorrect username or password.",
        },
        400
      )
    );
    const app = makeApp({
      AUTH_PROVIDER: "cognito",
      COGNITO_USER_POOL_ID: "us-east-1_xyz",
      COGNITO_CLIENT_ID: "client-1",
    });
    const res = await request(app)
      .post("/api/auth/login")
      .send({ username: "u", password: "wrong" });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Incorrect username or password." });
  });

  it("returns 401 when Cognito responds with a challenge instead of tokens", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ ChallengeName: "NEW_PASSWORD_REQUIRED" })
    );
    const app = makeApp({
      AUTH_PROVIDER: "cognito",
      COGNITO_USER_POOL_ID: "us-east-1_xyz",
      COGNITO_CLIENT_ID: "client-1",
    });
    const res = await request(app)
      .post("/api/auth/login")
      .send({ username: "u", password: "p" });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/NEW_PASSWORD_REQUIRED/);
  });

  it("returns 502 when Cognito succeeds but omits the access token", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ AuthenticationResult: {} })
    );
    const app = makeApp({
      AUTH_PROVIDER: "cognito",
      COGNITO_USER_POOL_ID: "us-east-1_xyz",
      COGNITO_CLIENT_ID: "client-1",
    });
    const res = await request(app)
      .post("/api/auth/login")
      .send({ username: "u", password: "p" });
    expect(res.status).toBe(502);
  });

  it("returns 502 when fetch itself rejects (network error)", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ECONNRESET"));
    const app = makeApp({
      AUTH_PROVIDER: "cognito",
      COGNITO_USER_POOL_ID: "us-east-1_xyz",
      COGNITO_CLIENT_ID: "client-1",
    });
    const res = await request(app)
      .post("/api/auth/login")
      .send({ username: "u", password: "p" });
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/ECONNRESET/);
  });

  it("returns 500 when no region can be inferred and none is configured", async () => {
    const app = makeApp({
      AUTH_PROVIDER: "cognito",
      // Intentionally malformed pool id (no underscore) so region inference fails.
      COGNITO_USER_POOL_ID: "no-region-here",
      COGNITO_CLIENT_ID: "client-1",
    });
    const res = await request(app)
      .post("/api/auth/login")
      .send({ username: "u", password: "p" });
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/region/i);
  });
});
