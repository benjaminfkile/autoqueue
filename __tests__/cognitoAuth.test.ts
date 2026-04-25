import express, { Express, Request } from "express";
import request from "supertest";

import protectedRoute from "../src/middleware/protectedRoute";
import { CognitoProvider } from "../src/auth/CognitoProvider";
import { AuthContext, AuthProvider } from "../src/auth/AuthProvider";

// Variables prefixed with "mock" are allowed inside jest.mock factories.
const mockVerify = jest.fn();
const mockCreate: jest.Mock = jest.fn(
  (_props: unknown) => ({ verify: mockVerify })
);

jest.mock("aws-jwt-verify", () => ({
  __esModule: true,
  CognitoJwtVerifier: {
    create: (props: unknown) => mockCreate(props),
  },
}));

beforeEach(() => {
  mockVerify.mockReset();
  mockCreate.mockClear();
});

function makeReq(opts: {
  secrets?: Record<string, unknown>;
  authorization?: string | string[] | undefined;
}): Request {
  const headers: Record<string, string | string[] | undefined> = {};
  if (opts.authorization !== undefined) {
    headers["authorization"] = opts.authorization;
  }
  return {
    headers,
    app: { get: (k: string) => (k === "secrets" ? opts.secrets : undefined) },
  } as unknown as Request;
}

const VALID_SECRETS = {
  COGNITO_USER_POOL_ID: "us-east-1_abc123",
  COGNITO_CLIENT_ID: "client-123",
};

describe("CognitoProvider", () => {
  it("has the canonical provider name", () => {
    expect(new CognitoProvider().name).toBe("cognito");
  });

  it("returns an AuthContext when the JWT verifies successfully", async () => {
    mockVerify.mockResolvedValueOnce({
      sub: "user-sub-1",
      email: "alice@example.com",
      scope: "read:tasks write:tasks",
      token_use: "access",
      client_id: "client-123",
    });

    const provider = new CognitoProvider();
    const ctx = await provider.authenticate(
      makeReq({ secrets: VALID_SECRETS, authorization: "Bearer good.jwt.here" })
    );

    expect(ctx).toEqual({
      provider: "cognito",
      subject: "user-sub-1",
      email: "alice@example.com",
      scopes: ["read:tasks", "write:tasks"],
    });
    expect(mockVerify).toHaveBeenCalledWith("good.jwt.here");
  });

  it("creates the verifier with the configured pool and client", async () => {
    mockVerify.mockResolvedValueOnce({ sub: "u" });

    const provider = new CognitoProvider();
    await provider.authenticate(
      makeReq({ secrets: VALID_SECRETS, authorization: "Bearer t" })
    );

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate).toHaveBeenCalledWith({
      userPoolId: "us-east-1_abc123",
      tokenUse: "access",
      clientId: "client-123",
    });
  });

  it("caches the verifier across requests so JWKS isn't refetched", async () => {
    mockVerify.mockResolvedValue({ sub: "u" });

    const provider = new CognitoProvider();
    for (let i = 0; i < 5; i++) {
      await provider.authenticate(
        makeReq({ secrets: VALID_SECRETS, authorization: "Bearer t" })
      );
    }

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockVerify).toHaveBeenCalledTimes(5);
  });

  it("rebuilds the verifier when the configured pool/client changes", async () => {
    mockVerify.mockResolvedValue({ sub: "u" });

    const provider = new CognitoProvider();
    await provider.authenticate(
      makeReq({ secrets: VALID_SECRETS, authorization: "Bearer t" })
    );
    await provider.authenticate(
      makeReq({
        secrets: {
          COGNITO_USER_POOL_ID: "us-east-1_xyz",
          COGNITO_CLIENT_ID: "client-xyz",
        },
        authorization: "Bearer t",
      })
    );

    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it("returns null when verify rejects (expired/invalid token)", async () => {
    mockVerify.mockRejectedValueOnce(new Error("Token expired"));

    const provider = new CognitoProvider();
    const ctx = await provider.authenticate(
      makeReq({ secrets: VALID_SECRETS, authorization: "Bearer expired.jwt" })
    );
    expect(ctx).toBeNull();
  });

  it("returns null when verify rejects with a signature error", async () => {
    mockVerify.mockRejectedValueOnce(new Error("Invalid signature"));

    const provider = new CognitoProvider();
    const ctx = await provider.authenticate(
      makeReq({ secrets: VALID_SECRETS, authorization: "Bearer bogus.jwt" })
    );
    expect(ctx).toBeNull();
  });

  it("returns null when the Authorization header is missing", async () => {
    const provider = new CognitoProvider();
    const ctx = await provider.authenticate(makeReq({ secrets: VALID_SECRETS }));
    expect(ctx).toBeNull();
    expect(mockVerify).not.toHaveBeenCalled();
  });

  it("returns null when the Authorization header is not a Bearer token", async () => {
    const provider = new CognitoProvider();
    const ctx = await provider.authenticate(
      makeReq({ secrets: VALID_SECRETS, authorization: "Basic dXNlcjpwYXNz" })
    );
    expect(ctx).toBeNull();
    expect(mockVerify).not.toHaveBeenCalled();
  });

  it("returns null when the Authorization header is an array (not a string)", async () => {
    const provider = new CognitoProvider();
    const ctx = await provider.authenticate(
      makeReq({ secrets: VALID_SECRETS, authorization: ["Bearer a", "Bearer b"] })
    );
    expect(ctx).toBeNull();
    expect(mockVerify).not.toHaveBeenCalled();
  });

  it("returns null when the Bearer token portion is empty", async () => {
    const provider = new CognitoProvider();
    const ctx = await provider.authenticate(
      makeReq({ secrets: VALID_SECRETS, authorization: "Bearer    " })
    );
    expect(ctx).toBeNull();
    expect(mockVerify).not.toHaveBeenCalled();
  });

  it("accepts case-insensitive Bearer scheme", async () => {
    mockVerify.mockResolvedValueOnce({ sub: "u" });

    const provider = new CognitoProvider();
    const ctx = await provider.authenticate(
      makeReq({ secrets: VALID_SECRETS, authorization: "bearer abc" })
    );
    expect(ctx).toEqual({ provider: "cognito", subject: "u" });
    expect(mockVerify).toHaveBeenCalledWith("abc");
  });

  it("returns null when secrets are not loaded", async () => {
    const provider = new CognitoProvider();
    const ctx = await provider.authenticate(
      makeReq({ authorization: "Bearer t" })
    );
    expect(ctx).toBeNull();
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockVerify).not.toHaveBeenCalled();
  });

  it("returns null when COGNITO_USER_POOL_ID is missing", async () => {
    const provider = new CognitoProvider();
    const ctx = await provider.authenticate(
      makeReq({
        secrets: { COGNITO_CLIENT_ID: "c" },
        authorization: "Bearer t",
      })
    );
    expect(ctx).toBeNull();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("returns null when COGNITO_CLIENT_ID is missing", async () => {
    const provider = new CognitoProvider();
    const ctx = await provider.authenticate(
      makeReq({
        secrets: { COGNITO_USER_POOL_ID: "p" },
        authorization: "Bearer t",
      })
    );
    expect(ctx).toBeNull();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("falls back to subject='unknown' when the payload has no sub", async () => {
    mockVerify.mockResolvedValueOnce({ token_use: "access" });

    const provider = new CognitoProvider();
    const ctx = await provider.authenticate(
      makeReq({ secrets: VALID_SECRETS, authorization: "Bearer t" })
    );
    expect(ctx).toEqual({ provider: "cognito", subject: "unknown" });
  });

  it("omits scopes when the scope claim is absent", async () => {
    mockVerify.mockResolvedValueOnce({ sub: "u", email: "u@e.co" });

    const provider = new CognitoProvider();
    const ctx = await provider.authenticate(
      makeReq({ secrets: VALID_SECRETS, authorization: "Bearer t" })
    );
    expect(ctx).toEqual({ provider: "cognito", subject: "u", email: "u@e.co" });
    expect(ctx).not.toHaveProperty("scopes");
  });
});

function makeApp(providers: AuthProvider[]): {
  app: Express;
  capturedAuth: { value: AuthContext | undefined };
} {
  const app = express();
  app.use(express.json());
  const captured = { value: undefined as AuthContext | undefined };
  app.use("/api/secret", protectedRoute(providers), (req, res) => {
    captured.value = (req as Request & { auth?: AuthContext }).auth;
    res.status(200).json({ ok: true, auth: captured.value });
  });
  app.set("secrets", VALID_SECRETS);
  return { app, capturedAuth: captured };
}

describe("CognitoProvider with protectedRoute", () => {
  it("authenticates a valid Cognito JWT via Authorization: Bearer", async () => {
    mockVerify.mockResolvedValueOnce({ sub: "u-1", email: "u@e.co" });

    const { app } = makeApp([new CognitoProvider()]);
    const res = await request(app)
      .get("/api/secret")
      .set("Authorization", "Bearer good.jwt");

    expect(res.status).toBe(200);
    expect(res.body.auth).toEqual({
      provider: "cognito",
      subject: "u-1",
      email: "u@e.co",
    });
  });

  it("returns 401 when the Cognito JWT is invalid/expired", async () => {
    mockVerify.mockRejectedValueOnce(new Error("Token expired"));

    const { app } = makeApp([new CognitoProvider()]);
    const res = await request(app)
      .get("/api/secret")
      .set("Authorization", "Bearer expired.jwt");

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
  });

  it("returns 401 when no Authorization header is presented", async () => {
    const { app } = makeApp([new CognitoProvider()]);
    const res = await request(app).get("/api/secret");

    expect(res.status).toBe(401);
    expect(mockVerify).not.toHaveBeenCalled();
  });
});
