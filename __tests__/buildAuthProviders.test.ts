import express, { Express, Request } from "express";
import request from "supertest";
import bcrypt from "bcrypt";

import { buildAuthProviders } from "../src/auth/buildAuthProviders";
import { ApiKeyProvider } from "../src/auth/ApiKeyProvider";
import { CognitoProvider } from "../src/auth/CognitoProvider";
import { AuthContext, AuthProvider } from "../src/auth/AuthProvider";
import protectedRoute from "../src/middleware/protectedRoute";
import { IAppSecrets } from "../src/interfaces";

jest.mock("bcrypt", () => ({
  compare: jest.fn(),
}));

const mockVerify = jest.fn();
jest.mock("aws-jwt-verify", () => ({
  __esModule: true,
  CognitoJwtVerifier: {
    create: () => ({ verify: (jwt: string) => mockVerify(jwt) }),
  },
}));

beforeEach(() => {
  jest.clearAllMocks();
  (bcrypt.compare as jest.Mock).mockResolvedValue(true);
  mockVerify.mockReset();
});

// Build a partial IAppSecrets for tests — only the fields the providers care
// about are required; cast through unknown to satisfy the strict interface.
function secrets(extra: Partial<IAppSecrets> = {}): IAppSecrets {
  return {
    API_KEY_HASH: "$2b$10$hash",
    COGNITO_USER_POOL_ID: "us-east-1_pool",
    COGNITO_CLIENT_ID: "client-1",
    ...extra,
  } as unknown as IAppSecrets;
}

describe("buildAuthProviders()", () => {
  describe("backwards compatibility — defaults to apikey only", () => {
    it("returns [ApiKeyProvider] when AUTH_PROVIDER is undefined", () => {
      const chain = buildAuthProviders(secrets());
      expect(chain).toHaveLength(1);
      expect(chain[0]).toBeInstanceOf(ApiKeyProvider);
      expect(chain[0].name).toBe("api-key");
    });

    it("returns [ApiKeyProvider] when AUTH_PROVIDER is an empty string", () => {
      const chain = buildAuthProviders(
        secrets({ AUTH_PROVIDER: "" as unknown as IAppSecrets["AUTH_PROVIDER"] })
      );
      expect(chain).toHaveLength(1);
      expect(chain[0]).toBeInstanceOf(ApiKeyProvider);
    });

    it("returns [ApiKeyProvider] when AUTH_PROVIDER is whitespace only", () => {
      const chain = buildAuthProviders(
        secrets({
          AUTH_PROVIDER:
            "   " as unknown as IAppSecrets["AUTH_PROVIDER"],
        })
      );
      expect(chain).toHaveLength(1);
      expect(chain[0]).toBeInstanceOf(ApiKeyProvider);
    });

    it("returns [ApiKeyProvider] when AUTH_PROVIDER is only commas/whitespace", () => {
      const chain = buildAuthProviders(
        secrets({
          AUTH_PROVIDER:
            " , , " as unknown as IAppSecrets["AUTH_PROVIDER"],
        })
      );
      expect(chain).toHaveLength(1);
      expect(chain[0]).toBeInstanceOf(ApiKeyProvider);
    });
  });

  describe("config-driven chain", () => {
    it("returns [ApiKeyProvider] for 'apikey'", () => {
      const chain = buildAuthProviders(secrets({ AUTH_PROVIDER: "apikey" }));
      expect(chain).toHaveLength(1);
      expect(chain[0]).toBeInstanceOf(ApiKeyProvider);
    });

    it("returns [CognitoProvider] for 'cognito'", () => {
      const chain = buildAuthProviders(secrets({ AUTH_PROVIDER: "cognito" }));
      expect(chain).toHaveLength(1);
      expect(chain[0]).toBeInstanceOf(CognitoProvider);
      expect(chain[0].name).toBe("cognito");
    });

    it("returns [ApiKeyProvider, CognitoProvider] for 'apikey,cognito'", () => {
      const chain = buildAuthProviders(
        secrets({ AUTH_PROVIDER: "apikey,cognito" })
      );
      expect(chain).toHaveLength(2);
      expect(chain[0]).toBeInstanceOf(ApiKeyProvider);
      expect(chain[1]).toBeInstanceOf(CognitoProvider);
    });

    it("preserves the order in 'cognito,apikey'", () => {
      const chain = buildAuthProviders(
        secrets({ AUTH_PROVIDER: "cognito,apikey" })
      );
      expect(chain).toHaveLength(2);
      expect(chain[0]).toBeInstanceOf(CognitoProvider);
      expect(chain[1]).toBeInstanceOf(ApiKeyProvider);
    });

    it("is case-insensitive and tolerates whitespace around entries", () => {
      const chain = buildAuthProviders(
        secrets({
          AUTH_PROVIDER:
            "  APIKey , Cognito  " as unknown as IAppSecrets["AUTH_PROVIDER"],
        })
      );
      expect(chain.map((p) => p.name)).toEqual(["api-key", "cognito"]);
    });

    it("throws when an unknown provider name is configured", () => {
      expect(() =>
        buildAuthProviders(
          secrets({
            AUTH_PROVIDER:
              "apikey,oauth" as unknown as IAppSecrets["AUTH_PROVIDER"],
          })
        )
      ).toThrow(/Unknown AUTH_PROVIDER entry: "oauth"/);
    });
  });
});

// End-to-end sanity: the chain produced by buildAuthProviders, when stored on
// the app under "authProviders", is what protectedRoute uses to authenticate.
function makeAppWithChain(chain: AuthProvider[]): {
  app: Express;
  capturedAuth: { value: AuthContext | undefined };
} {
  const app = express();
  app.use(express.json());
  const captured = { value: undefined as AuthContext | undefined };
  app.use("/api/secret", protectedRoute(), (req, res) => {
    captured.value = (req as Request & { auth?: AuthContext }).auth;
    res.status(200).json({ ok: true, auth: captured.value });
  });
  app.set("secrets", secrets({ AUTH_PROVIDER: "apikey,cognito" }));
  app.set("authProviders", chain);
  return { app, capturedAuth: captured };
}

describe("buildAuthProviders integrated with protectedRoute via app config", () => {
  it("apikey-only chain authenticates via x-api-key", async () => {
    (bcrypt.compare as jest.Mock).mockResolvedValueOnce(true);
    const chain = buildAuthProviders(secrets({ AUTH_PROVIDER: "apikey" }));
    const { app } = makeAppWithChain(chain);

    const res = await request(app)
      .get("/api/secret")
      .set("x-api-key", "raw-key");
    expect(res.status).toBe(200);
    expect(res.body.auth).toEqual({ provider: "api-key", subject: "api-key" });
  });

  it("cognito-only chain rejects requests presenting only an api key", async () => {
    const chain = buildAuthProviders(secrets({ AUTH_PROVIDER: "cognito" }));
    const { app } = makeAppWithChain(chain);

    const res = await request(app)
      .get("/api/secret")
      .set("x-api-key", "raw-key");
    expect(res.status).toBe(401);
    expect(bcrypt.compare).not.toHaveBeenCalled();
  });

  it("'apikey,cognito' chain authenticates via x-api-key (first provider succeeds)", async () => {
    (bcrypt.compare as jest.Mock).mockResolvedValueOnce(true);
    const chain = buildAuthProviders(
      secrets({ AUTH_PROVIDER: "apikey,cognito" })
    );
    const { app } = makeAppWithChain(chain);

    const res = await request(app)
      .get("/api/secret")
      .set("x-api-key", "raw-key");
    expect(res.status).toBe(200);
    expect(res.body.auth.provider).toBe("api-key");
    expect(mockVerify).not.toHaveBeenCalled();
  });

  it("'apikey,cognito' chain falls through to cognito when no api key is supplied", async () => {
    mockVerify.mockResolvedValueOnce({ sub: "u-1", email: "u@e.co" });
    const chain = buildAuthProviders(
      secrets({ AUTH_PROVIDER: "apikey,cognito" })
    );
    const { app } = makeAppWithChain(chain);

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

  it("default (missing AUTH_PROVIDER) keeps existing api-key behavior end-to-end", async () => {
    (bcrypt.compare as jest.Mock).mockResolvedValueOnce(true);
    const chain = buildAuthProviders(secrets());
    const { app } = makeAppWithChain(chain);

    const res = await request(app)
      .get("/api/secret")
      .set("x-api-key", "raw-key");
    expect(res.status).toBe(200);
    expect(res.body.auth).toEqual({ provider: "api-key", subject: "api-key" });
  });
});

describe("protectedRoute provider-chain resolution precedence", () => {
  it("uses the chain stored on the app under 'authProviders' when no override is passed", async () => {
    const stub: AuthProvider = {
      name: "stub-app-config",
      authenticate: jest
        .fn()
        .mockResolvedValue({ provider: "stub-app-config", subject: "u" }),
    };
    const app = express();
    app.use(express.json());
    app.use("/api/secret", protectedRoute(), (_req, res) => {
      res.status(200).json({ ok: true });
    });
    app.set("secrets", { API_KEY_HASH: "h" });
    app.set("authProviders", [stub]);

    const res = await request(app).get("/api/secret");
    expect(res.status).toBe(200);
    expect(stub.authenticate).toHaveBeenCalledTimes(1);
  });

  it("explicit providers override beats the app-stored chain", async () => {
    const appStored: AuthProvider = {
      name: "app-stored",
      authenticate: jest.fn().mockResolvedValue(null),
    };
    const explicit: AuthProvider = {
      name: "explicit",
      authenticate: jest
        .fn()
        .mockResolvedValue({ provider: "explicit", subject: "u" }),
    };
    const app = express();
    app.use(express.json());
    app.use("/api/secret", protectedRoute([explicit]), (_req, res) => {
      res.status(200).json({ ok: true });
    });
    app.set("secrets", { API_KEY_HASH: "h" });
    app.set("authProviders", [appStored]);

    const res = await request(app).get("/api/secret");
    expect(res.status).toBe(200);
    expect(explicit.authenticate).toHaveBeenCalledTimes(1);
    expect(appStored.authenticate).not.toHaveBeenCalled();
  });

  it("falls back to ApiKeyProvider when neither override nor app-stored chain is present", async () => {
    (bcrypt.compare as jest.Mock).mockResolvedValueOnce(true);
    const app = express();
    app.use(express.json());
    app.use("/api/secret", protectedRoute(), (_req, res) => {
      res.status(200).json({ ok: true });
    });
    app.set("secrets", { API_KEY_HASH: "$2b$10$hash" });

    const res = await request(app)
      .get("/api/secret")
      .set("x-api-key", "raw-key");
    expect(res.status).toBe(200);
    expect(bcrypt.compare).toHaveBeenCalledWith("raw-key", "$2b$10$hash");
  });
});
