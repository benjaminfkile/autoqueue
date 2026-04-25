import express, { Express, Request } from "express";
import request from "supertest";
import bcrypt from "bcrypt";

import protectedRoute from "../src/middleware/protectedRoute";
import { ApiKeyProvider } from "../src/auth/ApiKeyProvider";
import { AuthContext, AuthProvider } from "../src/auth/AuthProvider";

jest.mock("bcrypt", () => ({
  compare: jest.fn(),
}));

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
  return { app, capturedAuth: captured };
}

beforeEach(() => {
  jest.clearAllMocks();
  (bcrypt.compare as jest.Mock).mockResolvedValue(true);
});

describe("AuthProvider interface", () => {
  it("can be implemented as a plain object with a name and authenticate()", async () => {
    const provider: AuthProvider = {
      name: "stub",
      async authenticate(): Promise<AuthContext | null> {
        return { provider: "stub", subject: "u-1" };
      },
    };
    const ctx = await provider.authenticate({} as Request);
    expect(ctx).toEqual({ provider: "stub", subject: "u-1" });
    expect(provider.name).toBe("stub");
  });
});

describe("ApiKeyProvider", () => {
  let provider: ApiKeyProvider;

  beforeEach(() => {
    provider = new ApiKeyProvider();
  });

  function makeReq(opts: {
    secrets?: Record<string, unknown>;
    apiKey?: string | string[] | undefined;
  }): Request {
    const headers: Record<string, string | string[] | undefined> = {};
    if (opts.apiKey !== undefined) headers["x-api-key"] = opts.apiKey;
    return {
      headers,
      app: { get: (k: string) => (k === "secrets" ? opts.secrets : undefined) },
    } as unknown as Request;
  }

  it("has the canonical provider name", () => {
    expect(provider.name).toBe("api-key");
  });

  it("returns an AuthContext when bcrypt.compare succeeds", async () => {
    (bcrypt.compare as jest.Mock).mockResolvedValueOnce(true);
    const ctx = await provider.authenticate(
      makeReq({
        secrets: { API_KEY_HASH: "$2b$10$hash" },
        apiKey: "raw-key",
      })
    );
    expect(ctx).toEqual({ provider: "api-key", subject: "api-key" });
    expect(bcrypt.compare).toHaveBeenCalledWith("raw-key", "$2b$10$hash");
  });

  it("returns null when bcrypt.compare reports a mismatch", async () => {
    (bcrypt.compare as jest.Mock).mockResolvedValueOnce(false);
    const ctx = await provider.authenticate(
      makeReq({
        secrets: { API_KEY_HASH: "$2b$10$hash" },
        apiKey: "wrong-key",
      })
    );
    expect(ctx).toBeNull();
  });

  it("returns null when the x-api-key header is missing", async () => {
    const ctx = await provider.authenticate(
      makeReq({ secrets: { API_KEY_HASH: "$2b$10$hash" } })
    );
    expect(ctx).toBeNull();
    expect(bcrypt.compare).not.toHaveBeenCalled();
  });

  it("returns null when the x-api-key header is an array (not a string)", async () => {
    const ctx = await provider.authenticate(
      makeReq({
        secrets: { API_KEY_HASH: "$2b$10$hash" },
        apiKey: ["a", "b"],
      })
    );
    expect(ctx).toBeNull();
    expect(bcrypt.compare).not.toHaveBeenCalled();
  });

  it("returns null when secrets are not loaded", async () => {
    const ctx = await provider.authenticate(makeReq({ apiKey: "k" }));
    expect(ctx).toBeNull();
    expect(bcrypt.compare).not.toHaveBeenCalled();
  });

  it("returns null when API_KEY_HASH is empty in secrets", async () => {
    const ctx = await provider.authenticate(
      makeReq({ secrets: { API_KEY_HASH: "" }, apiKey: "k" })
    );
    expect(ctx).toBeNull();
    expect(bcrypt.compare).not.toHaveBeenCalled();
  });
});

describe("protectedRoute(providers)", () => {
  it("returns 500 when secrets are not loaded", async () => {
    const provider: AuthProvider = {
      name: "stub",
      authenticate: jest.fn().mockResolvedValue({ provider: "stub", subject: "u" }),
    };
    const { app } = makeApp([provider]);
    // Note: `secrets` is intentionally not set on app.

    const res = await request(app).get("/api/secret");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Secrets not loaded" });
    expect(provider.authenticate).not.toHaveBeenCalled();
  });

  it("returns 401 when no provider authenticates the request", async () => {
    const a: AuthProvider = { name: "a", authenticate: jest.fn().mockResolvedValue(null) };
    const b: AuthProvider = { name: "b", authenticate: jest.fn().mockResolvedValue(null) };
    const { app } = makeApp([a, b]);
    app.set("secrets", { API_KEY_HASH: "h" });

    const res = await request(app).get("/api/secret");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
    expect(a.authenticate).toHaveBeenCalledTimes(1);
    expect(b.authenticate).toHaveBeenCalledTimes(1);
  });

  it("tries providers in order and stops at the first successful one", async () => {
    const callOrder: string[] = [];
    const a: AuthProvider = {
      name: "a",
      authenticate: jest.fn(async () => {
        callOrder.push("a");
        return null;
      }),
    };
    const b: AuthProvider = {
      name: "b",
      authenticate: jest.fn(async () => {
        callOrder.push("b");
        return { provider: "b", subject: "user-b" } as AuthContext;
      }),
    };
    const c: AuthProvider = {
      name: "c",
      authenticate: jest.fn(async () => {
        callOrder.push("c");
        return { provider: "c", subject: "user-c" } as AuthContext;
      }),
    };
    const { app, capturedAuth } = makeApp([a, b, c]);
    app.set("secrets", { API_KEY_HASH: "h" });

    const res = await request(app).get("/api/secret");
    expect(res.status).toBe(200);
    expect(callOrder).toEqual(["a", "b"]);
    expect(c.authenticate).not.toHaveBeenCalled();
    expect(capturedAuth.value).toEqual({ provider: "b", subject: "user-b" });
    expect(res.body.auth).toEqual({ provider: "b", subject: "user-b" });
  });

  it("attaches the resolved AuthContext to req.auth before invoking next()", async () => {
    const provider: AuthProvider = {
      name: "stub",
      authenticate: jest
        .fn()
        .mockResolvedValue({ provider: "stub", subject: "alice", email: "a@b.c" }),
    };
    const { app, capturedAuth } = makeApp([provider]);
    app.set("secrets", { API_KEY_HASH: "h" });

    const res = await request(app).get("/api/secret");
    expect(res.status).toBe(200);
    expect(capturedAuth.value).toEqual({
      provider: "stub",
      subject: "alice",
      email: "a@b.c",
    });
  });

  it("works end-to-end with ApiKeyProvider when bcrypt.compare succeeds", async () => {
    (bcrypt.compare as jest.Mock).mockResolvedValueOnce(true);
    const { app } = makeApp([new ApiKeyProvider()]);
    app.set("secrets", { API_KEY_HASH: "$2b$10$hash" });

    const res = await request(app).get("/api/secret").set("x-api-key", "raw-key");
    expect(res.status).toBe(200);
    expect(res.body.auth).toEqual({ provider: "api-key", subject: "api-key" });
    expect(bcrypt.compare).toHaveBeenCalledWith("raw-key", "$2b$10$hash");
  });

  it("returns 401 with ApiKeyProvider when the key is wrong", async () => {
    (bcrypt.compare as jest.Mock).mockResolvedValueOnce(false);
    const { app } = makeApp([new ApiKeyProvider()]);
    app.set("secrets", { API_KEY_HASH: "$2b$10$hash" });

    const res = await request(app).get("/api/secret").set("x-api-key", "wrong");
    expect(res.status).toBe(401);
  });

  it("falls through to a second provider when the first declines", async () => {
    const apiKey = new ApiKeyProvider();
    const fallback: AuthProvider = {
      name: "fallback",
      authenticate: jest
        .fn()
        .mockResolvedValue({ provider: "fallback", subject: "fb-user" }),
    };
    const { app, capturedAuth } = makeApp([apiKey, fallback]);
    app.set("secrets", { API_KEY_HASH: "$2b$10$hash" });
    // No x-api-key header → ApiKeyProvider returns null, fallback picks it up.

    const res = await request(app).get("/api/secret");
    expect(res.status).toBe(200);
    expect(capturedAuth.value).toEqual({ provider: "fallback", subject: "fb-user" });
    expect(fallback.authenticate).toHaveBeenCalledTimes(1);
  });

  it("uses ApiKeyProvider by default when no providers list is passed", async () => {
    (bcrypt.compare as jest.Mock).mockResolvedValueOnce(true);
    const app = express();
    app.use(express.json());
    app.use("/api/secret", protectedRoute(), (_req, res) => {
      res.status(200).json({ ok: true });
    });
    app.set("secrets", { API_KEY_HASH: "$2b$10$hash" });

    const res = await request(app).get("/api/secret").set("x-api-key", "raw-key");
    expect(res.status).toBe(200);
  });
});
